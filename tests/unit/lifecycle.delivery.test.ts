import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { claimReminder } from "@/lib/lifecycle/claim-reminder"
import { buildIcsFeed, escapeIcsText, foldIcsLine } from "@/lib/lifecycle/ics"
import { todayInTimezone, daysBetween } from "@/lib/lifecycle/occurrence"
import { describeLeadTime, buildReminderComponents } from "@/lib/notify/client-event-reminder"
import { buildSuggestionPrompt, fallbackSuggestion } from "@/lib/lifecycle/suggest-message"
import { humaniseEventType } from "@/lib/lifecycle/labels"
import type { Guardrails } from "@/lib/guardrails/types"

// ── claim ───────────────────────────────────────────────────────────────────
// The at-most-once guarantee: two overlapping cron runs must never send the
// same agent the same reminder twice.

function stubClaim(row: { id: string } | null) {
  const calls: Record<string, unknown>[] = []
  const eqs: Array<[string, unknown]> = []
  const chain = {
    update(patch: Record<string, unknown>) {
      calls.push(patch)
      return this
    },
    eq(col: string, val: unknown) {
      eqs.push([col, val])
      return this
    },
    select() {
      return this
    },
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  }
  const admin = { from: () => chain } as unknown as SupabaseClient
  return { admin, calls, eqs }
}

describe("claimReminder", () => {
  it("claims only a row still queued, and burns an attempt in the same update", () => {
    const { admin, calls, eqs } = stubClaim({ id: "r1" })
    return claimReminder(admin, "r1", 0).then((won) => {
      expect(won).toBe(true)
      expect(calls[0]).toMatchObject({ status: "claimed", attempts: 1 })
      // The status predicate IS the atomicity — without it both runs would win.
      expect(eqs).toContainEqual(["status", "queued"])
    })
  })

  it("loses cleanly when another run already claimed it", async () => {
    const { admin } = stubClaim(null)
    expect(await claimReminder(admin, "r1", 0)).toBe(false)
  })

  it("increments from the attempts it was given", async () => {
    const { admin, calls } = stubClaim({ id: "r1" })
    await claimReminder(admin, "r1", 2)
    expect(calls[0]).toMatchObject({ attempts: 3 })
  })
})

// ── timezone helpers ────────────────────────────────────────────────────────

describe("todayInTimezone", () => {
  it("gives the operator's date, not the server's", () => {
    // 23:30 UTC is already the next day in Singapore (UTC+8).
    const instant = new Date("2026-07-25T23:30:00.000Z")
    expect(todayInTimezone(instant, "Asia/Singapore")).toBe("2026-07-26")
    expect(todayInTimezone(instant, "UTC")).toBe("2026-07-25")
    // ...and still the previous day in New York.
    expect(todayInTimezone(instant, "America/New_York")).toBe("2026-07-25")
  })

  it("falls back to UTC for an unknown zone", () => {
    expect(todayInTimezone(new Date("2026-07-25T10:00:00Z"), "Not/AZone")).toBe("2026-07-25")
  })
})

describe("daysBetween", () => {
  it("counts whole calendar days in both directions", () => {
    expect(daysBetween("2026-07-25", "2026-08-24")).toBe(30)
    expect(daysBetween("2026-07-25", "2026-07-25")).toBe(0)
    expect(daysBetween("2026-07-25", "2026-07-24")).toBe(-1)
  })

  it("is exact across a DST boundary", () => {
    // A naive (ms / 86400000) on local times yields 30.96 here and rounds wrong.
    expect(daysBetween("2026-03-01", "2026-03-31")).toBe(30)
  })
})

// ── phrasing ────────────────────────────────────────────────────────────────

describe("describeLeadTime", () => {
  it("reads naturally rather than counting days", () => {
    expect(describeLeadTime(0)).toBe("today")
    expect(describeLeadTime(1)).toBe("tomorrow")
    expect(describeLeadTime(7)).toBe("in a week")
    expect(describeLeadTime(14)).toBe("in 2 weeks")
    expect(describeLeadTime(30)).toBe("in a month")
    expect(describeLeadTime(45)).toBe("in 45 days")
  })

  it("never says a negative number of days", () => {
    expect(describeLeadTime(-3)).toBe("today")
  })
})

describe("humaniseEventType", () => {
  it("turns a snake_case type into a label", () => {
    expect(humaniseEventType("policy_expiry")).toBe("Policy expiry")
    expect(humaniseEventType("birthday")).toBe("Birthday")
  })
})

// ── template params ─────────────────────────────────────────────────────────

describe("buildReminderComponents", () => {
  const base = {
    clientLabel: "Jane Tan",
    eventLabel: "Policy expiry",
    whenText: "in a month",
    suggestion: "Hi Jane, your policy is up for renewal soon.",
    deepLink: "https://app.example.com/contacts/abc",
  }

  it("emits five body params in order", () => {
    const [body] = buildReminderComponents(base) as [{ parameters: { text: string }[] }]
    expect(body.parameters.map((p) => p.text)).toEqual([
      "Jane Tan",
      "Policy expiry",
      "in a month",
      "Hi Jane, your policy is up for renewal soon.",
      "https://app.example.com/contacts/abc",
    ])
  })

  it("strips newlines and runs of spaces, which Meta rejects", () => {
    const [body] = buildReminderComponents({
      ...base,
      suggestion: "Hi Jane,\n\nYour policy     expires soon.\n— Jas",
    }) as [{ parameters: { text: string }[] }]
    const suggestion = body.parameters[3].text
    expect(suggestion).not.toMatch(/[\n\t]/)
    expect(suggestion).not.toMatch(/ {5}/)
  })

  it("truncates an overlong suggestion instead of failing the send", () => {
    const [body] = buildReminderComponents({ ...base, suggestion: "x".repeat(2000) }) as [
      { parameters: { text: string }[] },
    ]
    expect(body.parameters[3].text.length).toBeLessThanOrEqual(601)
  })
})

// ── suggestion prompt ───────────────────────────────────────────────────────

const NO_GUARDRAILS: Guardrails = { enabled: false, rules: [], bannedWords: [] }

describe("buildSuggestionPrompt", () => {
  it("includes the event, the client and the agent", () => {
    const p = buildSuggestionPrompt({
      clientName: "Goh Jia Hui",
      eventType: "policy_expiry",
      eventLabel: "AIA HealthShield",
      whenText: "in a month",
      eventPayload: { policy_no: "AIA-123" },
      leadContext: { plan: "Enhanced" },
      agentName: "Jasmine",
      guardrails: NO_GUARDRAILS,
    })
    expect(p).toContain("Goh Jia Hui")
    expect(p).toContain("policy_expiry")
    expect(p).toContain("AIA-123")
    expect(p).toContain("Jasmine")
  })

  it("escapes values so a stray angle bracket can't break the XML blocks", () => {
    const p = buildSuggestionPrompt({
      clientName: "Goh Jia Hui",
      eventType: "birthday",
      eventLabel: null,
      whenText: "today",
      eventPayload: { note: "<script>alert(1)</script>" },
      leadContext: {},
      agentName: null,
      guardrails: NO_GUARDRAILS,
    })
    expect(p).not.toContain("<script>")
    expect(p).toContain("&lt;script&gt;")
  })

  it("skips nested objects rather than dumping [object Object]", () => {
    const p = buildSuggestionPrompt({
      clientName: "Goh Jia Hui",
      eventType: "birthday",
      eventLabel: null,
      whenText: "today",
      eventPayload: { nested: { a: 1 }, flat: "keep" },
      leadContext: {},
      agentName: null,
      guardrails: NO_GUARDRAILS,
    })
    expect(p).not.toContain("[object Object]")
    expect(p).toContain("keep")
  })
})

describe("fallbackSuggestion", () => {
  it("is safe to send unedited — states no facts the agent must verify", () => {
    const birthday = fallbackSuggestion("birthday")
    const other = fallbackSuggestion("policy_expiry")
    for (const msg of [birthday, other]) {
      // Deliberately NAMELESS. Choosing a form of address from a full name is
      // judgement, and this line is what runs when the model was unavailable.
      // Guessing put "Hi Goh" in front of a client whose given name is Jia Hui.
      expect(msg).not.toMatch(/\bHi [A-Z]/)
      expect(msg).not.toMatch(/\$|\d{2,}|%/) // no amounts, dates or percentages
    }
    expect(birthday).toMatch(/birthday/i)
  })
})

// ── ICS ─────────────────────────────────────────────────────────────────────

describe("escapeIcsText", () => {
  it("escapes the four structural characters", () => {
    expect(escapeIcsText("Tan, Jane; note\\here\nline2")).toBe(
      "Tan\\, Jane\\; note\\\\here\\nline2",
    )
  })
})

describe("foldIcsLine", () => {
  it("leaves a short line alone", () => {
    expect(foldIcsLine("SUMMARY:Hi")).toBe("SUMMARY:Hi")
  })

  it("folds a long line with a leading space on continuations", () => {
    const folded = foldIcsLine(`SUMMARY:${"a".repeat(200)}`)
    const parts = folded.split("\r\n")
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.slice(1).every((p) => p.startsWith(" "))).toBe(true)
  })

  it("counts bytes, not characters, and never splits one in half", () => {
    // Emoji are 4 bytes each: 30 of them is 120 bytes but only 30 "characters".
    const folded = foldIcsLine(`SUMMARY:${"😀".repeat(30)}`)
    for (const seg of folded.split("\r\n")) {
      expect(new TextEncoder().encode(seg).length).toBeLessThanOrEqual(75)
    }
    // Round-trips with no replacement characters — nothing was cut mid-codepoint.
    expect(folded.replace(/\r\n /g, "")).not.toContain("�")
  })
})

describe("buildIcsFeed", () => {
  const now = new Date("2026-07-25T10:00:00.000Z")

  it("produces a well-formed calendar", () => {
    const ics = buildIcsFeed({
      calendarName: "Reminders",
      events: [{ uid: "e1@goma", date: "2026-08-10", summary: "Jane Tan — Policy expiry" }],
      now,
    })
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true)
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true)
    expect(ics).toContain("UID:e1@goma")
    expect(ics).toContain("DTSTART;VALUE=DATE:20260810")
    // Non-inclusive end: the day AFTER, or clients render nothing.
    expect(ics).toContain("DTEND;VALUE=DATE:20260811")
  })

  it("uses CRLF line endings throughout", () => {
    const ics = buildIcsFeed({
      calendarName: "R",
      events: [{ uid: "e1", date: "2026-08-10", summary: "x" }],
      now,
    })
    expect(ics.split("\n").every((l) => l === "" || l.endsWith("\r"))).toBe(true)
  })

  it("adds a yearly rule only for recurring events", () => {
    const yearly = buildIcsFeed({
      calendarName: "R",
      events: [{ uid: "b1", date: "2026-03-14", summary: "Birthday", yearly: true }],
      now,
    })
    const oneOff = buildIcsFeed({
      calendarName: "R",
      events: [{ uid: "p1", date: "2027-01-31", summary: "Expiry" }],
      now,
    })
    expect(yearly).toContain("RRULE:FREQ=YEARLY")
    expect(oneOff).not.toContain("RRULE")
  })

  it("escapes a client name containing a comma", () => {
    const ics = buildIcsFeed({
      calendarName: "R",
      events: [{ uid: "e1", date: "2026-08-10", summary: "Tan, Jane — Expiry" }],
      now,
    })
    expect(ics).toContain("SUMMARY:Tan\\, Jane")
  })

  it("emits a valid empty calendar when there is nothing scheduled", () => {
    const ics = buildIcsFeed({ calendarName: "R", events: [], now })
    expect(ics).toContain("BEGIN:VCALENDAR")
    expect(ics).toContain("END:VCALENDAR")
    expect(ics).not.toContain("BEGIN:VEVENT")
  })
})

// Regression guards for three fixes that were CLAIMED but inert. Each of these
// would have passed a code read and failed in production.

function stubUpdateCapture(rows: Array<{ id: string }> | null = []) {
  const updates: Array<{ patch: Record<string, unknown>; filters: Array<[string, unknown]> }> = []
  const from = () => {
    const filters: Array<[string, unknown]> = []
    let patch: Record<string, unknown> = {}
    const chain: Record<string, unknown> = {
      update(p: Record<string, unknown>) {
        patch = p
        updates.push({ patch, filters })
        return chain
      },
      eq: (c: string, v: unknown) => (filters.push(["eq:" + c, v]), chain),
      lt: (c: string, v: unknown) => (filters.push(["lt:" + c, v]), chain),
      gte: (c: string, v: unknown) => (filters.push(["gte:" + c, v]), chain),
      is: (c: string, v: unknown) => (filters.push(["is:" + c, v]), chain),
      select: () => Promise.resolve({ data: rows, error: null }),
      then: (r: (v: { data: unknown; error: null }) => unknown) =>
        r({ data: rows, error: null }),
    }
    return chain
  }
  return { admin: { from } as unknown as SupabaseClient, updates }
}

describe("stampDelivered (F1 regression)", () => {
  it("writes the wamid on its OWN update, not bundled with the status flip", async () => {
    // The sweep's "already delivered" guard keys off whatsapp_message_id. If the
    // wamid were only ever written together with status='sent', then the one
    // failure it guards against leaves it NULL and the guard never matches.
    const { admin, updates } = stubUpdateCapture()
    const { stampDelivered } = await import("@/lib/lifecycle/claim-reminder")
    await stampDelivered(admin, "r1", "wamid.ABC")

    expect(updates).toHaveLength(1)
    expect(updates[0].patch).toEqual({ whatsapp_message_id: "wamid.ABC" })
    // Crucially it must NOT also set status — that is the whole point.
    expect(updates[0].patch).not.toHaveProperty("status")
  })
})

describe("requeueStuckClaims (F3 regression)", () => {
  it("never requeues a row that has exhausted its attempts", async () => {
    const { admin, updates } = stubUpdateCapture([])
    const { requeueStuckClaims } = await import("@/lib/lifecycle/claim-reminder")
    await requeueStuckClaims(admin, 30, 3)

    const requeue = updates.find((u) => u.patch.status === "queued")
    expect(requeue, "a requeue update should be issued").toBeTruthy()
    // Without this filter the sweep moves an exhausted row from 'claimed' to
    // 'queued', where the delivery query's attempts filter ignores it forever —
    // the same zombie, reached by a different door.
    expect(requeue!.filters).toContainEqual(["lt:attempts", 3])
    expect(requeue!.filters).toContainEqual(["is:whatsapp_message_id", null])
  })

  it("gives exhausted stuck rows a terminal failed state instead", async () => {
    const { admin, updates } = stubUpdateCapture([])
    const { requeueStuckClaims } = await import("@/lib/lifecycle/claim-reminder")
    await requeueStuckClaims(admin, 30, 3)

    const exhaust = updates.find((u) => u.patch.status === "failed")
    expect(exhaust, "exhausted claims should be failed out").toBeTruthy()
    expect(exhaust!.filters).toContainEqual(["gte:attempts", 3])
  })
})
