import { describe, it, expect } from "vitest"
import { planReminders, type PlanInput } from "@/lib/lifecycle/plan-reminders"
import type { ContactEvent, ReminderRule, TeamMember } from "@/lib/lifecycle/types"

const BUSINESS = "user-1"
const TZ = "Asia/Singapore"
// 2026-07-25 09:00 SGT.
const NOW = new Date("2026-07-25T01:00:00.000Z")

function event(over: Partial<ContactEvent> = {}): ContactEvent {
  return {
    id: "evt-1",
    business_id: BUSINESS,
    lead_id: "lead-1",
    event_type: "policy_expiry",
    label: null,
    event_date: "2026-08-24",
    recurrence: "none",
    source: "import",
    payload: {},
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...over,
  }
}

function rule(over: Partial<ReminderRule> = {}): ReminderRule {
  return {
    id: "rule-1",
    business_id: BUSINESS,
    event_type: "policy_expiry",
    offset_days: 30,
    action: "notify_agent",
    audience: "assigned",
    suggest_message: true,
    send_window: "morning",
    active: true,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...over,
  }
}

function member(id: string, active = true): TeamMember {
  return {
    id,
    business_id: BUSINESS,
    display_name: id,
    email: null,
    whatsapp_number: `+6590000${id.slice(-3)}`,
    role: "agent",
    auth_user_id: null,
    active,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  }
}

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    events: [event()],
    rules: [rule()],
    members: [],
    assignmentByLead: new Map(),
    timezone: TZ,
    today: "2026-07-25",
    horizonDays: 60,
    now: NOW,
    ...over,
  }
}

describe("planReminders", () => {
  it("plans one reminder per (event, rule, occurrence, recipient)", () => {
    const out = planReminders(input({ assignmentByLead: new Map([["lead-1", "mem-1"]]) }))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      business_id: BUSINESS,
      event_id: "evt-1",
      rule_id: "rule-1",
      occurrence_date: "2026-08-24",
      member_id: "mem-1",
    })
    // 30 days before 2026-08-24 is 2026-07-25, 09:00 SGT = 01:00 UTC.
    expect(out[0].due_at).toBe("2026-07-25T01:00:00.000Z")
  })

  it("keeps an unassigned lead as a null recipient rather than dropping it", () => {
    // An unassigned client's policy expiry is precisely the one nobody watches.
    const out = planReminders(input())
    expect(out).toHaveLength(1)
    expect(out[0].member_id).toBeNull()
  })

  it("ignores inactive rules", () => {
    expect(planReminders(input({ rules: [rule({ active: false })] }))).toEqual([])
  })

  it("ignores events with no matching rule", () => {
    expect(planReminders(input({ events: [event({ event_type: "birthday" })] }))).toEqual([])
  })

  it("applies every matching rule to the same event", () => {
    const out = planReminders(
      input({ rules: [rule({ id: "r30", offset_days: 30 }), rule({ id: "r7", offset_days: 7 })] }),
    )
    expect(out.map((p) => p.rule_id).sort()).toEqual(["r30", "r7"])
    expect(new Set(out.map((p) => p.occurrence_date))).toEqual(new Set(["2026-08-24"]))
  })

  it("fans out to every active member for an all_members rule", () => {
    const out = planReminders(
      input({
        rules: [rule({ audience: "all_members" })],
        members: [member("mem-1"), member("mem-2"), member("mem-3", false)],
      }),
    )
    expect(out.map((p) => p.member_id).sort()).toEqual(["mem-1", "mem-2"])
  })

  it("falls back to the owner when an all_members rule has no active members", () => {
    const out = planReminders(
      input({ rules: [rule({ audience: "all_members" })], members: [member("m", false)] }),
    )
    expect(out).toHaveLength(1)
    expect(out[0].member_id).toBeNull()
  })

  it("skips occurrences beyond the horizon", () => {
    expect(planReminders(input({ horizonDays: 5 }))).toEqual([])
  })

  it("does NOT blast historical reminders on a first import", () => {
    // A policy expiring in 3 days with a 30-day rule came due 27 days ago.
    // Materialising it would fire immediately — multiplied across a whole
    // imported book, that is a flood of instantly-overdue reminders.
    const out = planReminders(input({ events: [event({ event_date: "2026-07-28" })] }))
    expect(out).toEqual([])
  })

  it("still creates a reminder that came due while the worker was down", () => {
    // Due yesterday, inside the one-day grace window.
    const out = planReminders(input({ events: [event({ event_date: "2026-08-23" })] }))
    expect(out).toHaveLength(1)
    expect(out[0].due_at).toBe("2026-07-24T01:00:00.000Z")
  })

  it("plans both years when a yearly event recurs inside a long horizon", () => {
    const out = planReminders(
      input({
        events: [event({ recurrence: "yearly", event_date: "1990-08-24" })],
        rules: [rule({ offset_days: 0 })],
        horizonDays: 400,
      }),
    )
    expect(out.map((p) => p.occurrence_date)).toEqual(["2026-08-24", "2027-08-24"])
  })

  it("produces distinct unique-keys so ON CONFLICT DO NOTHING is idempotent", () => {
    const out = planReminders(
      input({
        events: [event({ id: "e1" }), event({ id: "e2", lead_id: "lead-2" })],
        rules: [rule({ id: "r1", offset_days: 30 }), rule({ id: "r2", offset_days: 14 })],
        members: [member("mem-1"), member("mem-2")],
        assignmentByLead: new Map([["lead-1", "mem-1"], ["lead-2", "mem-2"]]),
      }),
    )
    const keys = out.map((p) => `${p.event_id}|${p.rule_id}|${p.occurrence_date}|${p.member_id}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("returns nothing for an operator with no events or no rules", () => {
    expect(planReminders(input({ events: [] }))).toEqual([])
    expect(planReminders(input({ rules: [] }))).toEqual([])
  })

})

describe("planReminders — timezone", () => {
  it("shifts due_at by the operator's zone", () => {
    const sg = planReminders(input())
    const ny = planReminders(input({ timezone: "America/New_York" }))
    expect(sg[0].due_at).toBe("2026-07-25T01:00:00.000Z")
    // 09:00 EDT on the same calendar day.
    expect(ny[0].due_at).toBe("2026-07-25T13:00:00.000Z")
  })
})
