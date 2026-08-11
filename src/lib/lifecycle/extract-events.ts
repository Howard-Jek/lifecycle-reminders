/**
 * Turn spreadsheet rows into contact-event drafts.
 *
 * Pure and I/O-free: the import task supplies rows and the AI's column mapping,
 * and gets back rows ready to upsert into `contact_events`.
 *
 * Event columns are ADDITIVE — a column identified as an event is still left in
 * `extra_columns`, so its raw value continues to land in `leads.context` exactly
 * as it does today. Nothing an existing import produces is removed or moved;
 * events are new data alongside it. That keeps the live TechFin importer
 * byte-for-byte unchanged.
 */

import { parseCalendarDate } from "@/lib/sanitize"
import type { EventColumn } from "@/lib/types"
import type { Recurrence } from "./types"

/** A contact_events row, before it has a lead_id (leads are upserted first). */
export type ContactEventDraft = {
  /** Row's phone, used to resolve lead_id after the lead upsert. */
  phone: string
  event_type: string
  label: string | null
  event_date: string
  recurrence: Recurrence
  source: "import"
  payload: Record<string, unknown>
}

export type ExtractEventsInput = {
  headers: string[]
  rows: string[][]
  eventColumns: EventColumn[]
  /** dayjs format detected by the mapper; the cascade falls back without it. */
  dateFormat: string | null
  /** Row index → the lead phone that row produced. Rows that failed phone
   * sanitisation are absent, and are skipped: an event with no contact is
   * unreachable. */
  phoneByRowIndex: Map<number, string>
}

export type ExtractEventsResult = {
  events: ContactEventDraft[]
  /** Cells that looked like an event but could not be parsed as a date.
   * Surfaced to the operator rather than silently dropped. */
  unparsed: Array<{ rowNumber: number; header: string; value: string }>
}

export function extractContactEvents(input: ExtractEventsInput): ExtractEventsResult {
  const { headers, rows, eventColumns, dateFormat, phoneByRowIndex } = input

  const events: ContactEventDraft[] = []
  const unparsed: ExtractEventsResult["unparsed"] = []
  if (eventColumns.length === 0) return { events, unparsed }

  // Resolve header → index once. A configured column missing from the sheet is
  // skipped rather than throwing: the mapping may outlive a column rename.
  const resolved = eventColumns
    .map((col) => ({ col, index: headers.indexOf(col.header) }))
    .filter((r) => r.index >= 0)

  rows.forEach((row, rowIndex) => {
    const phone = phoneByRowIndex.get(rowIndex)
    if (!phone) return

    for (const { col, index } of resolved) {
      const raw = row[index]?.trim()
      if (!raw) continue

      const eventDate = parseCalendarDate(raw, dateFormat)
      if (!eventDate) {
        unparsed.push({ rowNumber: rowIndex + 2, header: col.header, value: raw })
        continue
      }

      events.push({
        phone,
        event_type: col.event_type,
        label: col.label?.trim() || null,
        event_date: eventDate,
        recurrence: col.recurrence,
        source: "import",
        // The original cell is kept so a suggestion can quote the operator's own
        // wording ("Policy AIA-123 expires…") without re-reading the sheet.
        payload: { source_header: col.header, source_value: raw },
      })
    }
  })

  return { events, unparsed: dedupeUnparsed(unparsed) }
}

/** One report per (header, value) — a bad format repeated down 500 rows is one
 * problem for the operator to fix, not 500. */
function dedupeUnparsed(
  rows: ExtractEventsResult["unparsed"],
): ExtractEventsResult["unparsed"] {
  const seen = new Set<string>()
  const out: ExtractEventsResult["unparsed"] = []
  for (const r of rows) {
    const key = `${r.header}|${r.value}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}
