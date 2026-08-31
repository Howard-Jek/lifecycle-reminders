/**
 * When a failed reminder is allowed to try again.
 *
 * Retry already existed before this file: a failed send went straight back to
 * 'queued' and the next tick picked it up. What it never had was a WAIT. The
 * interval was whatever the scheduler's period happened to be — 15 minutes
 * under GitHub Actions, 24 hours under the Vercel cron — so "how long before we
 * try again?" was answered by a file nobody edits when they change the retry
 * behaviour, and silently re-answered every time the driver changed.
 *
 * Two rules separate a retry from a nuisance:
 *
 *   BIRTHDAYS DO NOT RETRY. A birthday greeting that arrives on the wrong day
 *   is worse than one that never arrives, and the same goes for an anniversary.
 *   Only product dates — policies, renewals, reviews — earn a second attempt.
 *
 *   NOTHING RETRIES PAST THE DATE IT IS ABOUT. "Your policy expires today",
 *   delivered three days after expiry, is not a reminder; it is a complaint.
 *   The occurrence date is the deadline, and a retry that would land beyond it
 *   is dropped rather than delivered late.
 */

import { isHoldingType } from "./event-types"
import { addDays, daysBetween, todayInTimezone } from "./occurrence"

/**
 * Days to wait before each successive retry, indexed by attempts already burnt:
 * [0] is the wait after the FIRST failure.
 *
 * Widening on purpose. One day clears a transient Graph or network fault; three
 * clears a credential someone fixes the same week; seven is a last look before
 * the row is called failed. Past that an operator is better served by the row
 * surfacing in Needs attention than by a fourth silent attempt.
 */
export const RETRY_BACKOFF_DAYS = [1, 3, 7]

/**
 * One initial send, plus one retry per backoff step.
 *
 * DERIVED, not typed twice. The delivery query filters on this and the sweep
 * compares against it; a hand-maintained constant that disagreed with the
 * backoff array would strand rows at 'queued' with a scheduled retry that the
 * query had already stopped selecting.
 */
export const MAX_ATTEMPTS = RETRY_BACKOFF_DAYS.length + 1

export type RetryPlan =
  | { retry: true; nextAttemptAt: string; inDays: number }
  | {
      retry: false
      reason: "not-retryable" | "attempts-exhausted" | "past-occurrence" | "permanent-failure"
    }

/**
 * The verdict for a failure that cannot succeed however often it is repeated.
 *
 * Produced by the CALLER, not by planRetry: whether a failure is permanent is a
 * fact about Meta's error code (see isRetryableFailure), and this module
 * deliberately knows nothing about WhatsApp. Named here so both call sites
 * spell it the same way and describeGiveUp can explain it.
 */
export const PERMANENT_FAILURE: RetryPlan = { retry: false, reason: "permanent-failure" }

/** Why a row was given up on, in words an operator can act on. */
export function describeGiveUp(reason: Exclude<RetryPlan, { retry: true }>["reason"]): string {
  switch (reason) {
    case "not-retryable":
      return "Not retried — a personal date is only worth sending on the day."
    case "permanent-failure":
      return "Not retried — sending this again would fail the same way."
    case "past-occurrence":
      return "Not retried — the next attempt would land after the date itself."
    case "attempts-exhausted":
      return `Gave up after ${MAX_ATTEMPTS} attempts.`
  }
}

/**
 * Decide whether this failure earns another attempt, and when.
 *
 * `attemptsBurnt` counts the attempt that just failed — the claim increments
 * `attempts` before the send, so it is `row.attempts + 1` at the call site.
 */
export function planRetry(input: {
  /** From the joined contact_events row. Null when the event has been deleted. */
  eventType: string | null | undefined
  attemptsBurnt: number
  /** The date this reminder is about, YYYY-MM-DD. */
  occurrenceDate: string
  now: Date
  timezone: string
}): RetryPlan {
  const { eventType, attemptsBurnt, occurrenceDate, now, timezone } = input

  // A null event_type means the event row is gone. deliverOne resolves that to
  // 'skipped' on its own, so this only has to not throw.
  if (!isHoldingType(eventType ?? "")) return { retry: false, reason: "not-retryable" }

  const inDays = RETRY_BACKOFF_DAYS[attemptsBurnt - 1]
  if (inDays === undefined) return { retry: false, reason: "attempts-exhausted" }

  /**
   * The deadline is a CALENDAR question, so it is answered with calendar
   * arithmetic — `addDays` on the local date, not milliseconds on the clock.
   *
   * Adding `inDays * 86_400_000` and reading the date back off the result is
   * wrong twice a year. At 23:30 on the night before a spring-forward, 24 hours
   * later is 00:30 TWO local dates on, because the skipped hour pushes it past
   * midnight: a policy expiring tomorrow would be refused as "past-occurrence"
   * when its retry was in fact due the same day. A fall-back does the reverse
   * and lands back on the date it started from.
   *
   * The comparison happens in the business's own timezone because
   * `occurrence_date` is a bare date carrying no zone — it means a date in the
   * agency's calendar. Comparing UTC would, at +08:00, wave through a retry
   * already a day late in Singapore.
   */
  const targetDate = addDays(todayInTimezone(now, timezone), inDays)
  if (targetDate > occurrenceDate) {
    return { retry: false, reason: "past-occurrence" }
  }

  return {
    retry: true,
    nextAttemptAt: instantOnLocalDate(targetDate, timezone).toISOString(),
    inDays,
  }
}

/**
 * An instant that falls on `targetDate` in the business's timezone.
 *
 * The schedule is DAY-GRANULAR — "next attempt in 3 days" names a date, not a
 * time — so this guarantees the calendar date and lets the time of day fall
 * where it may. The tick runs every fifteen minutes; which hour of the target
 * date the row becomes eligible does not matter, and pretending to control it
 * without a timezone library would be a lie with arithmetic on top.
 *
 * Preserving the ORIGINAL time of day is what cannot be done here, and the
 * attempt to is what broke: from 23:30 local, every whole-day step in
 * milliseconds lands on either the day before or the day after a
 * spring-forward, oscillating and never touching the date in between.
 *
 * So the anchor is 12:00 UTC on the target date, corrected onto the intended
 * local date. Noon is chosen because every real UTC offset (-12 to +14) leaves
 * it within one day of the target, so a single whole-day correction always
 * converges — and because it is nowhere near the 02:00-03:00 window where DST
 * transitions delete or repeat an hour.
 */
function instantOnLocalDate(targetDate: string, timezone: string): Date {
  let candidate = new Date(`${targetDate}T12:00:00Z`)
  for (let correction = 0; correction < 3; correction++) {
    const drift = daysBetween(todayInTimezone(candidate, timezone), targetDate)
    if (drift === 0) break
    candidate = new Date(candidate.getTime() + drift * 86_400_000)
  }
  return candidate
}

/**
 * How many further attempts this row can still get.
 *
 * NOT USED BY ANY SCREEN IN THIS REPO YET. It came across with the retry policy
 * from claude/whatsapp-webhook-validation-tswrys, where the inbox renders an
 * attempts badge; that badge was deliberately left on that branch. Kept because
 * it is the correct arithmetic for the badge when it lands, and because getting
 * it wrong is the kind of thing that reads as fine:
 *
 * MAX_ATTEMPTS is the ceiling from the backoff array alone, and a badge reading
 * "attempt 2 of 4" is only true for a reminder with a long lead time. The
 * deadline bites first whenever the remaining steps would overshoot the
 * occurrence date, so a row due the day before its policy expires has ONE
 * attempt left while a naive badge promises three.
 *
 * The clock advances with each granted step rather than being measured from
 * now: attempt three does not happen one day from today, it happens one day
 * after attempt two. Measuring every step from the present would overstate how
 * much runway is left, which is the same lie in a smaller font.
 */
export function attemptsRemaining(input: {
  eventType: string | null | undefined
  attemptsBurnt: number
  occurrenceDate: string
  now: Date
  timezone: string
}): number {
  let clock = input.now
  let remaining = 0
  for (let burnt = input.attemptsBurnt; burnt <= MAX_ATTEMPTS; burnt++) {
    const step = planRetry({ ...input, attemptsBurnt: burnt, now: clock })
    if (!step.retry) break
    remaining++
    clock = new Date(step.nextAttemptAt)
  }
  return remaining
}
