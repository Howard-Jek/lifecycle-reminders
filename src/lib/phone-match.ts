/**
 * Comparing a phone number a HUMAN typed against one the database stores.
 *
 * Deliberately separate from normalizePhone() in sanitize.ts, which converts a
 * value toward E.164 for STORAGE and needs a country code to do it. This is the
 * other direction: two numbers already exist, no country code is available, and
 * the only question is whether they are the same line.
 *
 * Also deliberately separate from the webhook's sender attribution, which
 * compares digits EXACTLY. Meta always sends a full country code, so exactness
 * costs nothing there and the consequence of a loose match is cross-tenant.
 * Here the input is typed by a person who may well omit their own country code.
 */

export function phoneDigits(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D/g, "")
}

/** Below this, a suffix match is coincidence rather than evidence. */
const MIN_SUFFIX_DIGITS = 7

/**
 * Same line?
 *
 * Exact digits, or one a suffix of the other — so "(951) 456-4663" matches a
 * stored "+19514564663". The suffix arm is what makes a roster lookup work for
 * somebody typing their number the way they dial it rather than the way E.164
 * spells it.
 *
 * This is intentionally loose, and is only safe because of where it is used:
 * against a single tenant's own roster, which is a handful of rows, and only to
 * decide which of the caller's OWN colleagues to message. Callers must still
 * treat multiple matches as ambiguous and refuse — looseness plus a silent
 * tie-break is how you message the wrong person.
 */
export function isSamePhoneNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = phoneDigits(a)
  const right = phoneDigits(b)
  if (!left || !right) return false
  if (left === right) return true
  const [longer, shorter] = left.length >= right.length ? [left, right] : [right, left]
  return shorter.length >= MIN_SUFFIX_DIGITS && longer.endsWith(shorter)
}
