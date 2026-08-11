/**
 * Cell cleaning for imported contact rows.
 *
 * A narrowed port of `src/lib/sanitize.ts` in jottiteam/lead-reactivation-agent
 * — the phone and calendar-date halves only, because those are the two the
 * reminders engine depends on and both have edge cases that took a while to
 * get right upstream. Kept byte-compatible in behaviour so a row that imports
 * one way here imports the same way there.
 */

import dayjs from "dayjs"
import customParseFormat from "dayjs/plugin/customParseFormat"

dayjs.extend(customParseFormat)

/**
 * Values that mean "this cell is empty" despite containing characters.
 * Spreadsheets exported from CRMs are full of them.
 */
const PLACEHOLDERS = new Set([
  "n/a",
  "na",
  "none",
  "null",
  "nil",
  "-",
  "--",
  "---",
  "tbc",
  "tbd",
  "unknown",
  "unspecified",
  "not available",
  "not applicable",
  "no",
  ".",
  "x",
  "xx",
  "xxx",
])

/**
 * Characters with no business in spreadsheet text: C0 controls, DEL,
 * zero-width and directional formatting marks, line/paragraph separators,
 * word joiner, BOM, and interlinear annotation anchors.
 */
export const CONTROL_CHARS_RE =
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B-\u200F\u2028-\u2029\u202A-\u202E\u2060\uFEFF\uFFF9-\uFFFB]/g

/**
 * Ordered by global prevalence. The format the operator confirmed in the
 * wizard is tried first; these catch the columns they did not map.
 */
const DATE_FALLBACK_FORMATS = [
  "YYYY-MM-DD",
  "YYYY-MM-DDTHH:mm:ss",
  "YYYY-MM-DDTHH:mm:ssZ",
  "DD/MM/YYYY",
  "D/M/YYYY",
  "MM/DD/YYYY",
  "M/D/YYYY",
  "DD-MM-YYYY",
  "MM-DD-YYYY",
  "DD.MM.YYYY",
  "D.M.YYYY",
  "YYYY/MM/DD",
  "DD MMM YYYY",
  "MMM DD, YYYY",
]

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDERS.has(value.trim().toLowerCase())
}

export function trimOrNull(value: string | undefined | null): string | null {
  if (!value) return null
  const trimmed = value.replace(CONTROL_CHARS_RE, "").trim()
  return trimmed && !isPlaceholder(trimmed) ? trimmed : null
}

/** Collapse to a single-spaced, title-cased name. Null for empty/placeholder. */
export function titleCaseName(raw: string | undefined | null): string | null {
  if (!raw || isPlaceholder(raw)) return null
  const collapsed = raw.replace(CONTROL_CHARS_RE, "").trim().replace(/\s+/g, " ")
  if (!collapsed) return null
  return collapsed
    .split(" ")
    .map((word) => {
      if (!word) return word
      const lower = word.toLowerCase()
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(" ")
}

export type PhoneResult = { phone: string | null; reason: string }

/**
 * Normalise a phone number toward E.164 (`+<cc><subscriber>`).
 *
 * Returns a reason rather than throwing, because a bad phone is a row-level
 * problem the operator has to see in the review queue, not a failed import.
 */
export function normalizePhone(
  raw: string | undefined | null,
  countryCode: string | null,
): PhoneResult {
  if (!raw || isPlaceholder(raw)) {
    return { phone: null, reason: "Empty or placeholder value" }
  }

  let digits = raw.replace(/[^\d+]/g, "")

  // A '+' anywhere but position 0 is noise, not structure.
  const hasLeadingPlus = digits.startsWith("+")
  digits = (hasLeadingPlus ? "+" : "") + digits.replace(/\+/g, "")

  if (!digits || digits === "+") {
    return { phone: null, reason: "No digits found" }
  }

  // International dialling prefix: 0044… → +44…
  if (!hasLeadingPlus && digits.startsWith("00")) {
    digits = "+" + digits.slice(2)
  }

  if (digits.startsWith("+")) {
    const numeric = digits.slice(1)
    if (!/^\d+$/.test(numeric)) {
      return { phone: null, reason: "Invalid characters after +" }
    }
    if (numeric.length < 7) {
      return { phone: null, reason: `Too short (${numeric.length} digits)` }
    }
    if (numeric.length > 15) {
      return { phone: null, reason: `Too long (${numeric.length} digits)` }
    }
    return { phone: digits, reason: "" }
  }

  // Local trunk prefix: 07911… → 7911…
  const stripped = digits.startsWith("0") ? digits.slice(1) : digits
  if (!stripped) {
    return { phone: null, reason: "No digits after removing trunk prefix" }
  }

  if (!countryCode) {
    if (stripped.length < 7 || stripped.length > 15) {
      return {
        phone: null,
        reason: `Invalid length (${stripped.length} digits) and no country code to prepend`,
      }
    }
    return { phone: stripped, reason: "" }
  }

  const codeDigits = countryCode.replace(/\D/g, "")

  // The number may already embed the country code: cc=+65, cell=6591234567.
  if (codeDigits && stripped.startsWith(codeDigits)) {
    const subscriber = stripped.slice(codeDigits.length)
    if (subscriber.length >= 6 && subscriber.length <= 12) {
      return { phone: `+${stripped}`, reason: "" }
    }
  }

  const totalDigits = codeDigits.length + stripped.length
  if (totalDigits < 7) {
    return { phone: null, reason: `Too short with country code (${totalDigits} digits)` }
  }
  if (totalDigits > 15) {
    return { phone: null, reason: `Too long with country code (${totalDigits} digits)` }
  }

  return { phone: `+${codeDigits}${stripped}`, reason: "" }
}

/** Lowercase, trim, and structurally validate. Null is not a row rejection. */
export function normalizeEmail(raw: string | undefined | null): string | null {
  const trimmed = trimOrNull(raw)
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower) ? lower : null
}

/**
 * The parse cascade: the caller's confirmed format (strict, then lax) → a list
 * of unambiguous formats (strict, to avoid false positives) → dayjs auto.
 */
function parseDateCascade(trimmed: string, format: string | null) {
  if (format) {
    const strict = dayjs(trimmed, format, true)
    if (strict.isValid()) return strict
    const lax = dayjs(trimmed, format)
    if (lax.isValid()) return lax
  }
  for (const fmt of DATE_FALLBACK_FORMATS) {
    const parsed = dayjs(trimmed, fmt, true)
    if (parsed.isValid()) return parsed
  }
  const fallback = dayjs(trimmed)
  return fallback.isValid() ? fallback : null
}

/**
 * Parse a cell into a CALENDAR date (YYYY-MM-DD).
 *
 * Deliberately not derived from an ISO timestamp: `toISOString()` converts to
 * UTC and can shift the calendar day — a date read as local midnight in
 * Asia/Singapore comes back as the previous day. For a birthday or a policy
 * expiry that off-by-one is the entire value of the field, so this formats the
 * parsed value in its own terms instead.
 */
export function parseCalendarDate(
  value: string | undefined,
  format: string | null,
): string | null {
  const trimmed = value?.trim()
  if (!trimmed || isPlaceholder(trimmed)) return null
  const parsed = parseDateCascade(trimmed, format)
  return parsed ? parsed.format("YYYY-MM-DD") : null
}

/**
 * Which of DD/MM or MM/DD a column of slash/dash/dot dates must be.
 *
 * Deterministic, and deliberately so: silently guessing is a whole-import
 * correctness failure, not a row-level one. Returns `null` when every value in
 * the column parses either way — that is exactly when the operator has to
 * decide, and the wizard asks.
 */
export function detectDayMonthOrder(
  values: Array<string | undefined | null>,
): "DD/MM/YYYY" | "MM/DD/YYYY" | null {
  let sawDayOverTwelve = false
  let sawMonthOverTwelve = false

  for (const value of values) {
    const trimmed = value?.trim()
    if (!trimmed || isPlaceholder(trimmed)) continue
    const m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(trimmed)
    if (!m) continue
    const first = Number(m[1])
    const second = Number(m[2])
    if (first > 12 && second <= 12) sawDayOverTwelve = true
    if (second > 12 && first <= 12) sawMonthOverTwelve = true
  }

  // Both would mean the column mixes conventions — no single format is right,
  // so hand it back to the operator rather than picking the more common one.
  if (sawDayOverTwelve && sawMonthOverTwelve) return null
  if (sawDayOverTwelve) return "DD/MM/YYYY"
  if (sawMonthOverTwelve) return "MM/DD/YYYY"
  return null
}
