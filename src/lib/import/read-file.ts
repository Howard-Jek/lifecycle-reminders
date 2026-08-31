/**
 * Spreadsheet → headers + rows.
 *
 * CSV via papaparse (what the host uses) and XLSX via exceljs. Deliberately
 * NOT SheetJS `xlsx`: that package carries the advisories flagged as P2-6 in
 * the host's own security audit, and the finding also noted there was no size
 * cap. Both are addressed here.
 *
 * Everything is bounded before it is parsed. A spreadsheet is attacker-shaped
 * input even when the attacker is a well-meaning operator with a 200 MB export.
 */

import Papa from "papaparse"
import ExcelJS from "exceljs"
import { detectDayMonthOrder } from "@/lib/sanitize"

/** 10 MB. Comfortably past a 20k-row contact export, well short of a problem. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024
/** Rows past the header. */
export const MAX_ROWS = 20_000

export type SheetData = {
  headers: string[]
  /** Header → cell, one entry per row. Values are strings, always. */
  rows: Array<Record<string, string>>
  truncated: boolean
}

export class ImportFileError extends Error {}

function assertSize(bytes: number) {
  if (bytes > MAX_FILE_BYTES) {
    throw new ImportFileError(
      `That file is ${(bytes / 1024 / 1024).toFixed(1)} MB. The limit is ${
        MAX_FILE_BYTES / 1024 / 1024
      } MB — export a narrower date range, or split it.`,
    )
  }
}

/** Trim, collapse whitespace, and drop the BOM Excel leaves on column A. */
function cleanHeader(raw: unknown, index: number): string {
  const value = String(raw ?? "")
    .replace(/^﻿/, "")
    .trim()
    .replace(/\s+/g, " ")
  // A blank header still needs a stable key, or two blank columns collide.
  return value || `Column ${index + 1}`
}

export async function readSheet(file: File): Promise<SheetData> {
  assertSize(file.size)

  const name = file.name.toLowerCase()
  if (name.endsWith(".csv") || name.endsWith(".txt")) return readCsv(await file.text())
  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
    return readXlsx(await file.arrayBuffer())
  }
  throw new ImportFileError("Upload a .csv or .xlsx file.")
}

function readCsv(text: string): SheetData {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    // Everything stays a string: papaparse's type inference turns "0912" into
    // 912, which silently destroys phone numbers and leading-zero postcodes.
    dynamicTyping: false,
    transformHeader: cleanHeader,
  })

  const headers = (parsed.meta.fields ?? []).filter(Boolean)
  const all = parsed.data.filter((row) => Object.values(row).some((v) => String(v ?? "").trim()))

  return {
    headers,
    rows: all.slice(0, MAX_ROWS).map((row) => normaliseRow(row, headers)),
    truncated: all.length > MAX_ROWS,
  }
}

async function readXlsx(buffer: ArrayBuffer): Promise<SheetData> {
  assertSize(buffer.byteLength)

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)

  const sheet = workbook.worksheets[0]
  if (!sheet) throw new ImportFileError("That workbook has no sheets.")

  const headerRow = sheet.getRow(1)
  const headers: string[] = []
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = cleanHeader(cellText(cell), col - 1)
  })
  const cleanHeaders = headers.filter(Boolean)
  if (cleanHeaders.length === 0) throw new ImportFileError("The first row has no column names.")

  const rows: Array<Record<string, string>> = []
  let seen = 0
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return
    seen++
    if (rows.length >= MAX_ROWS) return

    const record: Record<string, string> = {}
    headers.forEach((header, index) => {
      if (!header) return
      record[header] = cellText(row.getCell(index + 1))
    })
    if (Object.values(record).some((v) => v.trim())) rows.push(record)
  })

  return { headers: cleanHeaders, rows, truncated: seen > MAX_ROWS }
}

/**
 * A cell as the operator sees it.
 *
 * Dates are the reason this is not just String(cell.value): exceljs hands back
 * a JS Date for a real date cell, and toString() on that is a locale-shaped
 * string the date parser then has to guess at. Formatting it as ISO here
 * removes the guess entirely.
 */
function cellText(cell: ExcelJS.Cell | undefined): string {
  const value = cell?.value
  if (value === null || value === undefined) return ""

  if (value instanceof Date) {
    // UTC parts: exceljs reads a date-only cell as UTC midnight, and going
    // through local time can roll it to the previous day.
    const y = value.getUTCFullYear()
    const m = String(value.getUTCMonth() + 1).padStart(2, "0")
    const d = String(value.getUTCDate()).padStart(2, "0")
    return `${y}-${m}-${d}`
  }

  if (typeof value === "object") {
    const obj = value as unknown as Record<string, unknown>
    // Formula cells carry their computed result; hyperlinks and rich text
    // carry the display string.
    if ("result" in obj) return String(obj.result ?? "").trim()
    if ("text" in obj) return String(obj.text ?? "").trim()
    if ("richText" in obj && Array.isArray(obj.richText)) {
      return obj.richText.map((part) => String((part as { text?: string }).text ?? "")).join("")
    }
    if ("hyperlink" in obj) return String(obj.hyperlink ?? "").trim()
  }

  return String(value).trim()
}

function normaliseRow(row: Record<string, string>, headers: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const header of headers) out[header] = String(row[header] ?? "").trim()
  return out
}

/**
 * Guess which columns are which, so the operator confirms rather than maps
 * from scratch.
 *
 * Deterministic on purpose. The host used a model call for this; a lookup
 * table plus a confirmation screen is cheaper, reproducible, and — because the
 * operator sees the result before anything is written — more correct.
 */
export type HeaderGuess = {
  name: string | null
  phone: string | null
  email: string | null
  agent: string | null
  dateColumns: string[]
}

const PATTERNS = {
  name: [/^(full\s*)?name$/i, /client\s*name/i, /customer\s*name/i, /^contact$/i],
  phone: [/phone/i, /mobile/i, /whatsapp/i, /^tel/i, /contact\s*(no|number)/i, /hp/i],
  email: [/e-?mail/i],
  agent: [/agent/i, /servicing/i, /\bfa\b/i, /\brm\b/i, /adviser|advisor/i, /consultant/i, /owner/i],
  date: [
    /birth\s*day|birthdate|\bdob\b/i,
    /expir|renew|maturity/i,
    /review/i,
    /anniversar/i,
    /\bdate\b/i,
  ],
} as const

/**
 * @param extraDatePatterns Header shapes this operator's industry uses, from
 * their reminder pack.
 *
 * ADDITIVE ONLY, and the direction matters. These can make a column be NOTICED
 * as a date — a dental sheet's "Recall" column is invisible to the generic
 * patterns — and they can never rename one. eventTypeFromHeader still derives
 * the type from the operator's own words, because the moment a pack could
 * decide what a column MEANS, a training provider's "Visa Expiry" becomes a
 * course certification. See the note on eventTypeFromHeader for the version of
 * that bug this codebase already shipped once.
 */
export function guessHeaders(
  headers: string[],
  extraDatePatterns: readonly RegExp[] = [],
): HeaderGuess {
  const pick = (patterns: readonly RegExp[]) =>
    headers.find((h) => patterns.some((re) => re.test(h))) ?? null

  const name = pick(PATTERNS.name)
  const phone = pick(PATTERNS.phone)
  const email = pick(PATTERNS.email)
  const agent = pick(PATTERNS.agent)

  const datePatterns = [...PATTERNS.date, ...extraDatePatterns]
  const claimed = new Set([name, phone, email, agent].filter(Boolean) as string[])
  const dateColumns = headers.filter((h) => !claimed.has(h) && datePatterns.some((re) => re.test(h)))

  return { name, phone, email, agent, dateColumns }
}

/**
 * An event_type from a column header.
 *
 * Derived from the operator's own words, not coerced into an insurance
 * vocabulary. An earlier version mapped anything matching /expir/ to
 * "policy_expiry", which turned a "Visa Expiry" column into a policy — exactly
 * the vertical assumption this engine is built not to make.
 *
 * The only aliases left are ones that are true in every vertical: a date of
 * birth is a birthday whatever business you are in. A trailing "date" is
 * dropped because "Policy Expiry Date" and "Policy Expiry" are the same thing,
 * and an operator should not end up with two event types for one idea.
 */
export function eventTypeFromHeader(header: string): string {
  const lower = header.toLowerCase()
  if (/\bdob\b|birth\s*day|birthdate|date\s*of\s*birth/.test(lower)) return "birthday"
  if (/anniversar/.test(lower)) return "anniversary"

  const slug = lower
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_(date|dt|dte|day)$/, "")

  return slug || "event"
}

/**
 * Which date format a column needs, or null when the column is genuinely
 * ambiguous and the operator has to say.
 *
 * Silently choosing between DD/MM and MM/DD is a whole-import correctness
 * failure — every date between the 1st and the 12th lands on the wrong day,
 * and nothing about the result looks wrong.
 */
export function detectFormatForColumn(
  rows: Array<Record<string, string>>,
  header: string,
): { format: string | null; ambiguous: boolean } {
  const values = rows.map((row) => row[header]).filter(Boolean)
  if (values.length === 0) return { format: null, ambiguous: false }

  // An ISO column needs no decision at all.
  if (values.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v))) {
    return { format: "YYYY-MM-DD", ambiguous: false }
  }

  const detected = detectDayMonthOrder(values)
  if (detected) return { format: detected, ambiguous: false }

  // Slash/dot/dash dates with no day > 12 anywhere: unresolvable from the data.
  const looksNumeric = values.some((v) => /^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}$/.test(v))
  return { format: null, ambiguous: looksNumeric }
}
