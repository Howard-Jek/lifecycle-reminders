import { describe, it, expect } from "vitest"
import {
  parseYmd,
  formatYmd,
  addDays,
  nextOccurrence,
  occurrencesInHorizon,
  reminderDueAt,
} from "@/lib/lifecycle/occurrence"

// This is the correctness core of the reminders engine: get a date wrong and an
// agent is reminded on the wrong day, or never. Tested directly rather than
// only through the cron.

describe("parseYmd / formatYmd", () => {
  it("round-trips a date", () => {
    expect(formatYmd(parseYmd("2026-07-25"))).toBe("2026-07-25")
  })

  it("rejects anything that isn't YYYY-MM-DD rather than guessing", () => {
    for (const bad of ["25/07/2026", "2026-7-5", "", "not a date", "2026-13-01", "2026-01-32"]) {
      expect(() => parseYmd(bad), bad).toThrow()
    }
  })
})

describe("addDays", () => {
  it("crosses month and year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01")
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28")
  })

  it("handles leap years", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29")
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29")
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01")
  })
})

describe("nextOccurrence", () => {
  it("returns a one-off's own date, past or future", () => {
    expect(nextOccurrence("2026-12-01", "none", "2026-07-25")).toBe("2026-12-01")
    expect(nextOccurrence("2020-01-01", "none", "2026-07-25")).toBe("2020-01-01")
  })

  it("rolls a yearly event to this year when still ahead", () => {
    expect(nextOccurrence("1990-12-01", "yearly", "2026-07-25")).toBe("2026-12-01")
  })

  it("rolls to next year once this year's has passed", () => {
    expect(nextOccurrence("1990-03-01", "yearly", "2026-07-25")).toBe("2027-03-01")
  })

  it("treats an occurrence landing exactly today as still upcoming", () => {
    // Off-by-one here would silently skip every same-day reminder.
    expect(nextOccurrence("1990-07-25", "yearly", "2026-07-25")).toBe("2026-07-25")
  })

  it("clamps a 29 Feb birthday to 28 Feb in a common year", () => {
    expect(nextOccurrence("2000-02-29", "yearly", "2026-01-01")).toBe("2026-02-28")
  })

  it("keeps 29 Feb in a leap year", () => {
    expect(nextOccurrence("2000-02-29", "yearly", "2028-01-01")).toBe("2028-02-29")
  })
})

describe("occurrencesInHorizon", () => {
  it("finds a yearly occurrence inside the window", () => {
    expect(occurrencesInHorizon("1990-08-10", "yearly", "2026-07-25", 60)).toEqual(["2026-08-10"])
  })

  it("returns nothing when the occurrence is beyond the horizon", () => {
    expect(occurrencesInHorizon("1990-12-01", "yearly", "2026-07-25", 30)).toEqual([])
  })

  it("includes both years when the horizon spans a full cycle", () => {
    const out = occurrencesInHorizon("1990-08-10", "yearly", "2026-07-25", 400)
    expect(out).toEqual(["2026-08-10", "2027-08-10"])
  })

  it("includes an occurrence on the first and last day of the window", () => {
    expect(occurrencesInHorizon("1990-07-25", "yearly", "2026-07-25", 30)).toContain("2026-07-25")
    expect(occurrencesInHorizon("1990-08-24", "yearly", "2026-07-25", 30)).toContain("2026-08-24")
  })

  it("never returns a past one-off", () => {
    expect(occurrencesInHorizon("2020-01-01", "none", "2026-07-25", 60)).toEqual([])
  })

  it("is bounded for a nonsensical horizon", () => {
    expect(occurrencesInHorizon("1990-08-10", "yearly", "2026-07-25", -5)).toEqual([])
    expect(occurrencesInHorizon("1990-08-10", "yearly", "2026-07-25", 100_000).length).toBeLessThanOrEqual(3)
  })
})

describe("reminderDueAt", () => {
  it("fires offsetDays before the occurrence at the window's local hour", () => {
    // 30 days before 2026-08-10 is 2026-07-11; 09:00 in Singapore is 01:00 UTC.
    const due = reminderDueAt("2026-08-10", 30, "morning", "Asia/Singapore")
    expect(due.toISOString()).toBe("2026-07-11T01:00:00.000Z")
  })

  it("offset 0 means the day itself", () => {
    const due = reminderDueAt("2026-08-10", 0, "morning", "Asia/Singapore")
    expect(due.toISOString()).toBe("2026-08-10T01:00:00.000Z")
  })

  it("honours the send window", () => {
    const afternoon = reminderDueAt("2026-08-10", 0, "afternoon", "Asia/Singapore")
    const evening = reminderDueAt("2026-08-10", 0, "evening", "Asia/Singapore")
    expect(afternoon.toISOString()).toBe("2026-08-10T05:00:00.000Z")
    expect(evening.toISOString()).toBe("2026-08-10T11:00:00.000Z")
  })

  it("resolves the operator's timezone, not the server's", () => {
    const sg = reminderDueAt("2026-08-10", 0, "morning", "Asia/Singapore")
    const ny = reminderDueAt("2026-08-10", 0, "morning", "America/New_York")
    expect(sg.toISOString()).not.toBe(ny.toISOString())
    // 09:00 EDT (UTC-4) on the same calendar day.
    expect(ny.toISOString()).toBe("2026-08-10T13:00:00.000Z")
  })

  it("keeps 9am local across a DST transition", () => {
    // New York is UTC-5 in January and UTC-4 in July. Both must still be 09:00
    // local — a fixed offset would drift one of them by an hour.
    const winter = reminderDueAt("2026-01-15", 0, "morning", "America/New_York")
    const summer = reminderDueAt("2026-07-15", 0, "morning", "America/New_York")
    expect(winter.toISOString()).toBe("2026-01-15T14:00:00.000Z")
    expect(summer.toISOString()).toBe("2026-07-15T13:00:00.000Z")
  })

  it("falls back to UTC for an unknown timezone instead of throwing", () => {
    // A bad operator_profile.timezone must not take the whole scheduler down.
    const due = reminderDueAt("2026-08-10", 0, "morning", "Not/AZone")
    expect(due.toISOString()).toBe("2026-08-10T09:00:00.000Z")
  })
})
