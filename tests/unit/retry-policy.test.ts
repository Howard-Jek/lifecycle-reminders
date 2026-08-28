import { describe, it, expect } from "vitest"
import {
  planRetry,
  describeGiveUp,
  RETRY_BACKOFF_DAYS,
  MAX_ATTEMPTS,
} from "@/lib/lifecycle/retry-policy"

/**
 * The two rules this module exists to enforce are both REFUSALS — a birthday
 * that must not be retried, and a retry that must not outlive the date it is
 * about. So most of these assert that nothing is scheduled, which is the half
 * a "does the backoff work?" test would miss entirely.
 */

const SGT = "Asia/Singapore"
const POLICY = "policy_expiry"

/** Far enough out that the occurrence deadline never interferes. */
const FAR = "2027-01-01"
const NOW = new Date("2026-09-01T02:00:00Z")

const plan = (over: Partial<Parameters<typeof planRetry>[0]> = {}) =>
  planRetry({
    eventType: POLICY,
    attemptsBurnt: 1,
    occurrenceDate: FAR,
    now: NOW,
    timezone: SGT,
    ...over,
  })

describe("the schedule", () => {
  it("widens 1 -> 3 -> 7 days across successive failures", () => {
    expect(plan({ attemptsBurnt: 1 })).toMatchObject({ retry: true, inDays: 1 })
    expect(plan({ attemptsBurnt: 2 })).toMatchObject({ retry: true, inDays: 3 })
    expect(plan({ attemptsBurnt: 3 })).toMatchObject({ retry: true, inDays: 7 })
  })

  it("gives up once the backoff steps run out", () => {
    expect(plan({ attemptsBurnt: 4 })).toEqual({ retry: false, reason: "attempts-exhausted" })
    expect(plan({ attemptsBurnt: 99 })).toEqual({ retry: false, reason: "attempts-exhausted" })
  })

  it("returns an instant the delivery query can compare against", () => {
    const p = plan({ attemptsBurnt: 1 })
    if (!p.retry) throw new Error("expected a retry")
    // One day after NOW, to the millisecond — not "tomorrow at midnight".
    expect(p.nextAttemptAt).toBe(new Date("2026-09-02T02:00:00Z").toISOString())
  })

  it("keeps MAX_ATTEMPTS derived from the backoff, never typed twice", () => {
    // The delivery query filters `attempts < MAX_ATTEMPTS`. If these two ever
    // disagreed, a row could be scheduled for a retry the query had already
    // stopped selecting — queued forever with a date on it.
    expect(MAX_ATTEMPTS).toBe(RETRY_BACKOFF_DAYS.length + 1)
    expect(MAX_ATTEMPTS).toBe(4)
  })
})

describe("personal dates are never retried", () => {
  it("refuses a birthday", () => {
    expect(plan({ eventType: "birthday" })).toEqual({ retry: false, reason: "not-retryable" })
  })

  it("refuses an anniversary", () => {
    // A late anniversary is the same mistake as a late birthday, and the bucket
    // the UI calls "Birthdays" quietly contains both.
    expect(plan({ eventType: "anniversary" })).toEqual({ retry: false, reason: "not-retryable" })
  })

  it("retries anything else, including a type this engine has never seen", () => {
    // isPolicyLike is a NEGATION, so a warranty or a visa renewal is retryable
    // without anyone adding it to a list.
    expect(plan({ eventType: "visa_renewal" })).toMatchObject({ retry: true })
    expect(plan({ eventType: "policy_review" })).toMatchObject({ retry: true })
  })

  it("treats a deleted event as retryable rather than throwing", () => {
    // deliverOne resolves a missing event to 'skipped' before this matters —
    // this only has to survive the null.
    expect(plan({ eventType: null })).toMatchObject({ retry: true })
    expect(plan({ eventType: undefined })).toMatchObject({ retry: true })
  })
})

describe("nothing retries past the date it is about", () => {
  it("allows a retry that lands ON the occurrence date", () => {
    // 2026-09-05 08:00 SGT, +1 day -> 2026-09-06 08:00 SGT. Same day as the
    // occurrence, so it is still worth sending.
    expect(
      plan({ now: new Date("2026-09-05T00:00:00Z"), occurrenceDate: "2026-09-06" }),
    ).toMatchObject({ retry: true, inDays: 1 })
  })

  it("refuses a retry that lands the day after", () => {
    expect(
      plan({ now: new Date("2026-09-06T00:00:00Z"), occurrenceDate: "2026-09-06" }),
    ).toEqual({ retry: false, reason: "past-occurrence" })
  })

  it("judges that boundary in the BUSINESS's timezone, not UTC", () => {
    // 2026-09-05T17:00Z is already 2026-09-06 01:00 in Singapore, so +1 day
    // lands on the 7th locally while still reading as the 6th in UTC. Comparing
    // instants would let this through a day late.
    const now = new Date("2026-09-05T17:00:00Z")
    expect(plan({ now, occurrenceDate: "2026-09-06" })).toEqual({
      retry: false,
      reason: "past-occurrence",
    })
    // Same instant, a timezone behind UTC: there it genuinely is still the 5th,
    // so the retry is on time and must be allowed.
    expect(plan({ now, occurrenceDate: "2026-09-06", timezone: "America/New_York" })).toMatchObject(
      { retry: true },
    )
  })

  it("refuses every retry once the date has already passed", () => {
    // The common case for this product: a backlog that sat while credentials
    // were broken. None of it should go out now.
    for (const attemptsBurnt of [1, 2, 3]) {
      expect(plan({ attemptsBurnt, occurrenceDate: "2026-08-01" })).toEqual({
        retry: false,
        reason: "past-occurrence",
      })
    }
  })

  it("puts the deadline ahead of the backoff, not after it", () => {
    // A 7-day wait cannot be scheduled onto a date 2 days out, even though
    // attempts remain. Ordering the checks the other way round would have
    // scheduled it and then delivered it late.
    expect(plan({ attemptsBurnt: 3, occurrenceDate: "2026-09-03" })).toEqual({
      retry: false,
      reason: "past-occurrence",
    })
  })
})

describe("describeGiveUp", () => {
  it("gives each refusal a reason an operator can act on", () => {
    expect(describeGiveUp("not-retryable")).toMatch(/personal date/i)
    expect(describeGiveUp("past-occurrence")).toMatch(/after the date/i)
    expect(describeGiveUp("attempts-exhausted")).toContain(String(MAX_ATTEMPTS))
  })
})
