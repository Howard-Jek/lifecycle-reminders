import { describe, it, expect } from "vitest"
import {
  planRetry,
  attemptsRemaining,
  describeGiveUp,
  RETRY_BACKOFF_DAYS,
  MAX_ATTEMPTS,
} from "@/lib/lifecycle/retry-policy"
import { addDays, todayInTimezone } from "@/lib/lifecycle/occurrence"

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

/**
 * The local calendar date the returned instant actually resolves to.
 *
 * Asserting `inDays` alone is what let the millisecond bug through: the plan
 * SAID one day and the instant it handed back landed on another. What the
 * delivery query gates on is the instant, so the instant is what has to be
 * checked.
 */
const landsOn = (p: ReturnType<typeof planRetry>, timezone: string): string => {
  if (!p.retry) throw new Error(`expected a retry, got ${p.reason}`)
  return todayInTimezone(new Date(p.nextAttemptAt), timezone)
}

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

  it("returns an instant on the target DATE, not a duration from now", () => {
    const p = plan({ attemptsBurnt: 1 })
    if (!p.retry) throw new Error("expected a retry")
    // The schedule is day-granular: "in 1 day" names tomorrow's date in the
    // business's calendar, and the instant has to fall on it. Which hour is
    // deliberately unspecified — the tick runs every fifteen minutes, and
    // pinning a clock time without a timezone library would be a fiction.
    expect(landsOn(p, SGT)).toBe(addDays(todayInTimezone(NOW, SGT), 1))
    expect(landsOn(p, SGT)).toBe("2026-09-02")
    // Still a valid instant the delivery query can compare with .lte.
    expect(new Date(p.nextAttemptAt).toISOString()).toBe(p.nextAttemptAt)
    expect(new Date(p.nextAttemptAt).getTime()).toBeGreaterThan(NOW.getTime())
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

describe("daylight saving", () => {
  /**
   * These are the cases that made the millisecond version wrong. A day is a
   * calendar step, not 86,400,000 milliseconds, and twice a year those differ.
   */

  it("does not lose a day to a spring-forward", () => {
    // 2026-03-07 23:30 in New York. Twenty-four hours later is 2026-03-09
    // 00:30 local — two dates on — because the spring-forward hour is skipped.
    // The retry is due on the 8th, which is exactly when the policy expires,
    // so it must be allowed.
    const p = plan({
      now: new Date("2026-03-08T04:30:00Z"),
      occurrenceDate: "2026-03-08",
      timezone: "America/New_York",
    })
    expect(p).toMatchObject({ retry: true, inDays: 1 })
    // And it must LAND on the 8th. now + 24h resolves to the 9th locally —
    // approving one date and scheduling the next is the bug this pins.
    expect(landsOn(p, "America/New_York")).toBe("2026-03-08")
  })

  it("does not lose a day in the southern hemisphere either", () => {
    // Auckland springs forward on 2026-09-27; same trap, opposite season.
    const p = plan({
      now: new Date("2026-09-26T11:30:00Z"),
      occurrenceDate: "2026-09-27",
      timezone: "Pacific/Auckland",
    })
    expect(p).toMatchObject({ retry: true, inDays: 1 })
    expect(landsOn(p, "Pacific/Auckland")).toBe("2026-09-27")
  })

  it("still advances a full day across a fall-back", () => {
    // 2026-11-01 00:30 EDT + 24h is 23:30 the SAME local date, because an hour
    // repeats. A one-day retry must still mean the 2nd, not the 1st.
    expect(
      plan({
        now: new Date("2026-11-01T04:30:00Z"),
        occurrenceDate: "2026-11-01",
        timezone: "America/New_York",
      }),
    ).toEqual({ retry: false, reason: "past-occurrence" })
    const p = plan({
      now: new Date("2026-11-01T04:30:00Z"),
      occurrenceDate: "2026-11-02",
      timezone: "America/New_York",
    })
    expect(p).toMatchObject({ retry: true, inDays: 1 })
    // now + 24h is 23:30 on the 1st — the very date the line above refuses.
    expect(landsOn(p, "America/New_York")).toBe("2026-11-02")
  })

  it("carries a 7-day backoff over a month boundary", () => {
    expect(
      plan({ attemptsBurnt: 3, now: new Date("2026-10-29T04:30:00Z"), occurrenceDate: "2026-11-05" }),
    ).toMatchObject({ retry: true, inDays: 7 })
  })
})

describe("the instant always matches the date that was approved", () => {
  /**
   * One invariant, swept across both DST directions, both hemispheres and every
   * backoff step: whatever planRetry approves on the calendar is where the
   * stored instant lands. Any future change to how the instant is computed has
   * to keep this true, whether or not anyone remembers the spring-forward case.
   */
  const ZONES = ["America/New_York", "Pacific/Auckland", "Asia/Singapore", "Europe/London", "UTC"]
  const INSTANTS = [
    "2026-03-08T04:30:00Z", // US spring-forward
    "2026-11-01T04:30:00Z", // US fall-back
    "2026-09-26T11:30:00Z", // NZ spring-forward
    "2026-04-04T15:30:00Z", // NZ fall-back
    "2026-03-29T00:30:00Z", // EU spring-forward
    "2026-06-15T12:00:00Z", // an ordinary day
    "2026-12-31T16:00:00Z", // year boundary
  ]

  it("lands on addDays(today, inDays) in the business timezone, never past the occurrence", () => {
    let checked = 0
    for (const timezone of ZONES) {
      for (const iso of INSTANTS) {
        for (const attemptsBurnt of [1, 2, 3]) {
          const now = new Date(iso)
          const p = planRetry({
            eventType: POLICY,
            attemptsBurnt,
            // Far past every instant in the sweep, including the 7-day step
            // from the year-boundary case. FAR is not enough for that one.
            occurrenceDate: "2030-01-01",
            now,
            timezone,
          })
          if (!p.retry) throw new Error(`unexpected refusal: ${p.reason}`)
          const expected = addDays(todayInTimezone(now, timezone), p.inDays)
          expect(landsOn(p, timezone)).toBe(expected)
          expect(landsOn(p, timezone) <= "2030-01-01").toBe(true)
          checked++
        }
      }
    }
    // Guard the guard: a typo in the loops that checked nothing would pass.
    expect(checked).toBe(ZONES.length * INSTANTS.length * 3)
  })
})

describe("attemptsRemaining", () => {
  const remaining = (over: Partial<Parameters<typeof attemptsRemaining>[0]> = {}) =>
    attemptsRemaining({
      eventType: POLICY,
      attemptsBurnt: 1,
      occurrenceDate: FAR,
      now: NOW,
      timezone: SGT,
      ...over,
    })

  it("counts every backoff step when the deadline is far away", () => {
    expect(remaining()).toBe(RETRY_BACKOFF_DAYS.length)
    expect(remaining({ attemptsBurnt: 2 })).toBe(2)
    expect(remaining({ attemptsBurnt: 3 })).toBe(1)
    expect(remaining({ attemptsBurnt: 4 })).toBe(0)
  })

  it("is zero for a personal date, whatever the lead time", () => {
    expect(remaining({ eventType: "birthday" })).toBe(0)
    expect(remaining({ eventType: "anniversary", occurrenceDate: FAR })).toBe(0)
  })

  it("is cut short by a near deadline", () => {
    // NOW is 2026-09-01 in SGT. A policy expiring tomorrow leaves room for the
    // 1-day step and nothing after it.
    expect(remaining({ occurrenceDate: "2026-09-02" })).toBe(1)
    expect(remaining({ occurrenceDate: "2026-09-01" })).toBe(0)
  })

  it("advances the clock with each step instead of measuring from now", () => {
    // Occurrence 8 days out. Cumulative: +1 -> 09-02, +3 -> 09-05, +7 -> 09-12,
    // which overshoots, so TWO remain. Measuring every step from today instead
    // would fit 1, 3 and 7 all inside the window and claim three — overstating
    // the runway, which is the same lie the "of 4" denominator told.
    expect(remaining({ occurrenceDate: "2026-09-09" })).toBe(2)
  })

  it("never exceeds the backoff ceiling", () => {
    for (const attemptsBurnt of [0, 1, 2, 3, 4, 10]) {
      expect(remaining({ attemptsBurnt })).toBeLessThanOrEqual(RETRY_BACKOFF_DAYS.length)
    }
  })
})

describe("describeGiveUp", () => {
  it("gives each refusal a reason an operator can act on", () => {
    expect(describeGiveUp("not-retryable")).toMatch(/personal date/i)
    expect(describeGiveUp("past-occurrence")).toMatch(/after the date/i)
    expect(describeGiveUp("attempts-exhausted")).toContain(String(MAX_ATTEMPTS))
  })
})
