/**
 * Occurrence maths for the lifecycle reminders engine.
 *
 * Pure functions, no I/O — this is the correctness-critical core the scheduler
 * is built on, so it is unit-tested directly rather than only through the cron.
 *
 * Everything here works in the OPERATOR'S timezone, not the server's. A
 * reminder that fires at "9am the day before a policy expires" must mean 9am
 * where the agent is; the existing send-window helper is server-local and
 * explicitly notes that as a known gap (src/lib/send-window.ts). Getting it
 * right from the start here is much cheaper than retrofitting.
 */

import { SEND_WINDOW_START_HOUR as WINDOW_START_HOUR, type SendWindow } from "@/lib/types"


/** A date as calendar parts, deliberately free of any timezone. */
type Ymd = { year: number; month: number; day: number }

/** Parse a Postgres `date` ("2026-07-25"). Throws on anything else — a silently
 * wrong date here would schedule a reminder on the wrong day. */
export function parseYmd(date: string): Ymd {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (!m) throw new Error(`parseYmd: expected YYYY-MM-DD, got "${date}"`)
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`parseYmd: out-of-range date "${date}"`)
  }
  return { year, month, day }
}

export function formatYmd({ year, month, day }: Ymd): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

/** Days in a month, Gregorian. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function compareYmd(a: Ymd, b: Ymd): number {
  return a.year - b.year || a.month - b.month || a.day - b.day
}

/**
 * The next occurrence of a yearly event on/after `from`.
 *
 * Leap-day handling is the interesting case: a 29 Feb birthday has no date in
 * a common year. We clamp to 28 Feb rather than rolling to 1 March, because the
 * reminder is about the person, and 28 Feb is the last day that still belongs
 * to the same month they were born in.
 *
 * Non-recurring events return their own date, whether or not it has passed —
 * the caller decides whether a past one-off is still worth reminding about.
 */
export function nextOccurrence(
  eventDate: string,
  recurrence: "none" | "yearly",
  from: string,
): string {
  const event = parseYmd(eventDate)
  if (recurrence === "none") return formatYmd(event)

  const today = parseYmd(from)

  const candidateFor = (year: number): Ymd => ({
    year,
    month: event.month,
    day: Math.min(event.day, daysInMonth(year, event.month)),
  })

  const thisYear = candidateFor(today.year)
  return formatYmd(compareYmd(thisYear, today) >= 0 ? thisYear : candidateFor(today.year + 1))
}

/**
 * Every occurrence of an event within `[from, from + horizonDays]`.
 *
 * Returns at most two dates for a yearly event (this year's and next year's can
 * both land inside a long horizon), and at most one for a one-off. Bounded by
 * construction — there is no unbounded loop to run away.
 */
export function occurrencesInHorizon(
  eventDate: string,
  recurrence: "none" | "yearly",
  from: string,
  horizonDays: number,
): string[] {
  if (horizonDays < 0) return []
  const start = parseYmd(from)
  const end = addDays(from, horizonDays)

  const out: string[] = []
  let cursor = from
  // Two iterations max for 'yearly' within any sane horizon; the guard is
  // belt-and-braces against a caller passing a multi-year horizon.
  for (let i = 0; i < 3; i++) {
    const occ = nextOccurrence(eventDate, recurrence, cursor)
    if (compareYmd(parseYmd(occ), parseYmd(end)) > 0) break
    if (compareYmd(parseYmd(occ), start) >= 0) out.push(occ)
    if (recurrence === "none") break
    cursor = addDays(occ, 1)
  }
  return out
}

/** Calendar-day arithmetic on a YYYY-MM-DD string. Uses UTC internally so it is
 * pure calendar maths — no DST shift can move the result to another day. */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseYmd(date)
  const d = new Date(Date.UTC(year, month - 1, day))
  d.setUTCDate(d.getUTCDate() + days)
  return formatYmd({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  })
}

/**
 * The instant a reminder should fire: `offsetDays` before `occurrenceDate`, at
 * the start of `window`, in `timezone`.
 *
 * Resolves the zone offset via Intl rather than assuming a fixed one, so a
 * DST-observing operator's 9am stays 9am across the transition. Falls back to
 * treating the timezone as UTC if it is unrecognised — a reminder at the wrong
 * hour is far better than a crashed scheduler that sends none.
 */
export function reminderDueAt(
  occurrenceDate: string,
  offsetDays: number,
  window: SendWindow,
  timezone: string,
): Date {
  const fireDate = addDays(occurrenceDate, -offsetDays)
  const { year, month, day } = parseYmd(fireDate)
  const hour = WINDOW_START_HOUR[window] ?? WINDOW_START_HOUR.morning

  // Start from the wall-clock time interpreted as UTC, then subtract the zone's
  // offset at that moment. Two passes because the offset itself depends on the
  // instant (DST), and the first guess can land on the wrong side of a change.
  let utcGuess = Date.UTC(year, month - 1, day, hour, 0, 0)
  for (let i = 0; i < 2; i++) {
    const offsetMinutes = zoneOffsetMinutes(new Date(utcGuess), timezone)
    utcGuess = Date.UTC(year, month - 1, day, hour, 0, 0) - offsetMinutes * 60_000
  }
  return new Date(utcGuess)
}

/** Minutes `timezone` is ahead of UTC at `instant`. 0 for an unknown zone. */
function zoneOffsetMinutes(instant: Date, timezone: string): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    const parts = Object.fromEntries(
      dtf.formatToParts(instant).map((p) => [p.type, p.value]),
    ) as Record<string, string>
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    )
    return Math.round((asUtc - instant.getTime()) / 60_000)
  } catch {
    return 0
  }
}

/**
 * Today's calendar date in `timezone`, as YYYY-MM-DD.
 *
 * The scheduler must ask "what is today for THIS operator", not for the server:
 * a worker running in UTC would roll over to tomorrow while a Singapore
 * operator is still mid-afternoon, and every same-day reminder would be
 * computed against the wrong day.
 */
export function todayInTimezone(instant: Date, timezone: string): string {
  try {
    // en-CA formats as YYYY-MM-DD, which is exactly the shape we want.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant)
  } catch {
    return instant.toISOString().slice(0, 10)
  }
}

/** Whole days from `from` to `to` (negative when `to` is in the past). Pure
 * calendar arithmetic in UTC, so a DST transition can't produce 0.96 of a day
 * and round the wrong way. */
export function daysBetween(from: string, to: string): number {
  const a = parseYmd(from)
  const b = parseYmd(to)
  const ms =
    Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)
  return Math.round(ms / 86_400_000)
}
