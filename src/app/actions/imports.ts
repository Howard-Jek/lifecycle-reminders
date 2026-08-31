"use server"

import { revalidatePath } from "next/cache"
import { reassignContactReminders } from "@/lib/lifecycle/reassign-reminders"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { normalizePhone, parseCalendarDate, titleCaseName } from "@/lib/sanitize"
import { ingestContacts, type IngestContact, type IngestRejection } from "@/lib/import/ingest"
import { readSheet, guessHeaders, eventTypeFromHeader, detectFormatForColumn, ImportFileError } from "@/lib/import/read-file"
import type { ActionResult } from "./team-members"

export type EventColumnChoice = {
  header: string
  event_type: string
  recurrence: "none" | "yearly"
  label: string | null
  /** null means "use the fallback cascade". */
  date_format: string | null
  /** True when the column could be DD/MM or MM/DD and the data cannot say. */
  ambiguous: boolean
}

export type SheetPreview = {
  headers: string[]
  sample: Array<Record<string, string>>
  rowCount: number
  truncated: boolean
  guess: {
    name: string | null
    phone: string | null
    email: string | null
    agent: string | null
  }
  eventColumns: EventColumnChoice[]
  /** Cached server-side for the commit step, keyed by this token. */
  stashKey: string
}

/**
 * Parsed sheets, held between the preview and the commit.
 *
 * In-process and short-lived on purpose: the raw file is never written to
 * storage, so there is no bucket to provision and nothing to clean up. The
 * trade is that a redeploy between steps loses the stash — the wizard says so
 * and asks for the file again, which is cheaper than a storage dependency.
 */
type Stash = {
  businessId: string
  fileName: string
  headers: string[]
  rows: Array<Record<string, string>>
  expiresAt: number
}
const STASH = new Map<string, Stash>()
const STASH_TTL_MS = 30 * 60 * 1000

function sweepStash() {
  const now = Date.now()
  for (const [key, value] of STASH) if (value.expiresAt < now) STASH.delete(key)
}

export async function previewSheet(formData: FormData): Promise<ActionResult<SheetPreview>> {
  const tenant = await requireTenant()
  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose a .csv or .xlsx file." }
  }

  let sheet
  try {
    sheet = await readSheet(file)
  } catch (err) {
    if (err instanceof ImportFileError) return { ok: false, error: err.message }
    console.error("[import] parse failed:", err)
    return { ok: false, error: "That file could not be read." }
  }

  if (sheet.rows.length === 0) return { ok: false, error: "That file has no data rows." }

  const guess = guessHeaders(sheet.headers)
  const eventColumns: EventColumnChoice[] = guess.dateColumns.map((header) => {
    const detected = detectFormatForColumn(sheet.rows, header)
    return {
      header,
      event_type: eventTypeFromHeader(header),
      recurrence: /birth|dob|anniversar/i.test(header) ? "yearly" : "none",
      label: null,
      date_format: detected.format,
      ambiguous: detected.ambiguous,
    }
  })

  sweepStash()
  const stashKey = crypto.randomUUID()
  STASH.set(stashKey, {
    businessId: tenant.businessId,
    fileName: file.name,
    headers: sheet.headers,
    rows: sheet.rows,
    expiresAt: Date.now() + STASH_TTL_MS,
  })

  return {
    ok: true,
    data: {
      headers: sheet.headers,
      sample: sheet.rows.slice(0, 5),
      rowCount: sheet.rows.length,
      truncated: sheet.truncated,
      guess: { name: guess.name, phone: guess.phone, email: guess.email, agent: guess.agent },
      eventColumns,
      stashKey,
    },
  }
}

export type CommitInput = {
  stashKey: string
  nameColumn: string
  phoneColumn: string
  emailColumn: string | null
  agentColumn: string | null
  countryCode: string
  eventColumns: EventColumnChoice[]
}

export async function commitImport(
  input: CommitInput,
): Promise<
  ActionResult<{
    importId: string
    created: number
    updated: number
    events: number
    review: number
    dueContacts: number
  }>
> {
  const tenant = await requireTenant()
  sweepStash()

  const stash = STASH.get(input.stashKey)
  // Scoped by business as well as key: a stash token from another tenant must
  // not be usable even if one leaked.
  if (!stash || stash.businessId !== tenant.businessId) {
    return { ok: false, error: "That upload expired. Choose the file again." }
  }
  if (!input.nameColumn || !input.phoneColumn) {
    return { ok: false, error: "Name and phone columns are both required." }
  }

  const mapped = new Set(
    [input.nameColumn, input.phoneColumn, input.emailColumn, input.agentColumn].filter(
      Boolean,
    ) as string[],
  )

  const contacts: IngestContact[] = []
  const rejections: IngestRejection[] = []

  stash.rows.forEach((row, index) => {
    // 1-based, and past the header, so it matches what the operator sees in
    // their spreadsheet when they go to fix a review item.
    const rowNumber = index + 2

    const name = titleCaseName(row[input.nameColumn])
    if (!name) {
      rejections.push({ rowNumber, reason: "missing_name", raw: row })
      return
    }

    const phone = normalizePhone(row[input.phoneColumn], input.countryCode)
    if (!phone.phone) {
      rejections.push({
        rowNumber,
        reason: row[input.phoneColumn]?.trim() ? "invalid_phone" : "missing_phone",
        detail: phone.reason,
        raw: row,
        parsed: { name },
      })
      return
    }

    const events = []
    for (const column of input.eventColumns) {
      const cell = row[column.header]
      if (!cell?.trim()) continue
      const date = parseCalendarDate(cell, column.date_format)
      if (!date) {
        // Reported, not dropped: one unreadable cell is one operator problem,
        // and the contact still lands.
        rejections.push({
          rowNumber,
          reason: "unparseable_date",
          detail: `"${cell}" in ${column.header}`,
          raw: row,
          parsed: { name, phone: phone.phone },
        })
        continue
      }
      events.push({
        event_type: column.event_type,
        event_date: date,
        label: column.label,
        recurrence: column.recurrence,
        payload: { source_header: column.header, source_value: cell },
      })
    }

    // Unmapped columns are kept verbatim. An event column stays here too — the
    // extraction is additive, so nothing an operator can see disappears.
    const extra: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
      if (mapped.has(key) || !value?.trim()) continue
      extra[key] = value.slice(0, 500)
    }

    contacts.push({
      rowNumber,
      name,
      phone: phone.phone,
      email: input.emailColumn ? row[input.emailColumn]?.trim() || null : null,
      agentValue: input.agentColumn ? row[input.agentColumn] : null,
      events,
      extra,
      raw: row,
    })
  })

  try {
    const result = await ingestContacts(createAdminClient(), {
      businessId: tenant.businessId,
      source: "upload",
      fileName: stash.fileName,
      createdBy: tenant.userId,
      contacts,
      rejections,
    })

    STASH.delete(input.stashKey)
    revalidatePath("/import")
    revalidatePath("/contacts")

    return {
      ok: true,
      data: {
        importId: result.importId,
        created: result.createdRows,
        updated: result.updatedRows,
        events: result.eventsCreated,
        review: result.reviewRows,
        dueContacts: result.due.contacts,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[import] commit failed:", message)
    return { ok: false, error: message }
  }
}

/** Resolve a review row by assigning its contact, or dismiss it. */
export async function resolveReview(
  reviewId: string,
  memberId: string | null,
): Promise<ActionResult> {
  const tenant = await requireTenant()
  const admin = createAdminClient()

  const { data: review } = await admin
    .from("contact_import_reviews")
    .select("id, parsed")
    .eq("id", reviewId)
    .eq("business_id", tenant.businessId)
    .maybeSingle<{ id: string; parsed: Record<string, unknown> }>()
  if (!review) return { ok: false, error: "That review item no longer exists." }

  const leadId = (review.parsed?.lead_id as string | undefined) ?? null

  // Dismissing is a real outcome, not a failure: some rows genuinely have no
  // owner, and leaving them pending forever makes the queue useless.
  if (!memberId || !leadId) {
    const { error } = await admin
      .from("contact_import_reviews")
      .update({ status: "dismissed", resolved_by: tenant.userId })
      .eq("id", reviewId)
      .eq("business_id", tenant.businessId)
    if (error) return { ok: false, error: error.message }
    revalidatePath("/import/review")
    return { ok: true }
  }

  const { error: assignError } = await admin
    .from("leads")
    .update({ assigned_member_id: memberId })
    .eq("id", leadId)
    .eq("business_id", tenant.businessId)
  if (assignError) return { ok: false, error: assignError.message }

  // Resolving a review assigns an EXISTING contact, which may already have
  // reminders queued to someone else. Same rule as the contact page.
  await reassignContactReminders(admin, tenant.businessId, leadId, memberId)

  // contact_import_reviews_resolution_coherent requires all three together.
  const { error } = await admin
    .from("contact_import_reviews")
    .update({
      status: "resolved",
      resolved_lead_id: leadId,
      resolved_by: tenant.userId,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", reviewId)
    .eq("business_id", tenant.businessId)

  if (error) return { ok: false, error: error.message }

  revalidatePath("/import/review")
  revalidatePath("/contacts")
  return { ok: true }
}
