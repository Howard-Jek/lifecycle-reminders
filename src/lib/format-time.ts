/**
 * Wall-clock formatting that survives hydration.
 *
 * `toLocaleTimeString()` with no arguments asks the RUNTIME for both the locale
 * and the timezone, and the runtime is not the same in the two places this text
 * gets produced: the server function renders in UTC, the browser renders
 * wherever the operator happens to be. React then tries to hydrate "15:49" over
 * "03:49 PM", the text does not match, and it throws #418.
 *
 * This never appears in development, which is what makes it worth a module.
 * `next dev` and the browser are the same machine in the same timezone, so the
 * two renders agree locally and disagree only once deployed — the class of bug
 * that looks like it appeared during the deploy.
 *
 * Pinning BOTH arguments is the fix. A locale alone still leaves the timezone
 * to the runtime, and a timezone alone still leaves 12h/24h and the separators
 * to it. The timezone passed in should be the BUSINESS's, not the viewer's:
 * this app already treats `businesses.timezone` as the operator's wall clock —
 * a "morning" reminder means 9am there — so a timestamp shown beside it has to
 * mean the same thing.
 */

/** The locale is pinned, not chosen. Any fixed value works; this one keeps the
 * existing 12-hour look the sandbox already had. */
const LOCALE = "en-US"

const FALLBACK_TIMEZONE = "Asia/Singapore"

function safeFormat(iso: string, options: Intl.DateTimeFormatOptions, timezone: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  try {
    return new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: timezone }).format(date)
  } catch {
    // An unknown IANA name throws rather than falling back, and a timestamp is
    // never worth taking a page down for.
    return new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: FALLBACK_TIMEZONE }).format(date)
  }
}

/** "03:49 PM" */
export function formatTimeOfDay(iso: string, timezone: string): string {
  return safeFormat(iso, { hour: "2-digit", minute: "2-digit" }, timezone)
}

/** "13 Aug 2026" */
export function formatDate(iso: string, timezone: string): string {
  return safeFormat(iso, { day: "2-digit", month: "short", year: "numeric" }, timezone)
}

/** "13 Aug 2026, 03:49 PM" */
export function formatDateTime(iso: string, timezone: string): string {
  return safeFormat(
    iso,
    { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" },
    timezone,
  )
}
