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

import { isPolicyLike } from "./event-types"
import { todayInTimezone } from "./occurrence"

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
  | { retry: false; reason: "not-retryable" | "attempts-exhausted" | "past-occurrence" }

/** Why a row was given up on, in words an operator can act on. */
export function describeGiveUp(reason: Exclude<RetryPlan, { retry: true }>["reason"]): string {
  switch (reason) {
    case "not-retryable":
      return "Not retried — a personal date is only worth sending on the day."
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
  if (!isPolicyLike(eventType ?? "")) return { retry: false, reason: "not-retryable" }

  const inDays = RETRY_BACKOFF_DAYS[attemptsBurnt - 1]
  if (inDays === undefined) return { retry: false, reason: "attempts-exhausted" }

  const next = new Date(now.getTime() + inDays * 86_400_000)

  /**
   * Compared as CALENDAR DATES in the business's own timezone.
   *
   * `occurrence_date` is a bare date carrying no zone, and it means a date in
   * the agency's calendar — so the retry instant has to be resolved into that
   * calendar before the comparison. Comparing UTC instants instead would, at
   * +08:00, wave through a retry that is already the following day in
   * Singapore: late by the only clock the client reads.
   */
  if (todayInTimezone(next, timezone) > occurrenceDate) {
    return { retry: false, reason: "past-occurrence" }
  }

  return { retry: true, nextAttemptAt: next.toISOString(), inDays }
}
