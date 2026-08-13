import { describe, it, expect } from "vitest"
import { summariseDue } from "@/lib/lifecycle/due-preview"
import { planReminders, MAX_OVERDUE_DAYS } from "@/lib/lifecycle/plan-reminders"
import type { ContactEvent, ReminderRule } from "@/lib/lifecycle/types"

const BUSINESS = "biz-1"

function event(over: Partial<ContactEvent> & { id: string; event_date: string }): ContactEvent {
  return {
    id: over.id,
    business_id: BUSINESS,
    lead_id: over.lead_id ?? `lead-${over.id}`,
    event_type: over.event_type ?? "policy_expiry",
    label: null,
    event_date: over.event_date,
    recurrence: over.recurrence ?? "none",
    source: "import",
    payload: {},
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  } as ContactEvent
}

function rule(offsetDays: number, eventType = "policy_expiry"): ReminderRule {
  return {
    id: `rule-${eventType}-${offsetDays}`,
    business_id: BUSINESS,
    event_type: eventType,
    offset_days: offsetDays,
    action: "notify_agent",
    audience: "assigned",
    suggest_message: true,
    send_window: "morning",
    active: true,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  } as ReminderRule
}

/** 2026-08-13, 09:29 Asia/Singapore — after the 9am morning window has opened. */
const NOW = new Date("2026-08-13T01:29:00.000Z")
const TODAY = "2026-08-13"
const TZ = "Asia/Singapore"

function plan(events: ContactEvent[], rules: ReminderRule[]) {
  return planReminders({
    events,
    rules,
    members: [],
    assignmentByLead: new Map(),
    timezone: TZ,
    today: TODAY,
    horizonDays: 400,
    now: NOW,
  })
}

describe("MAX_OVERDUE_DAYS", () => {
  it("is wide enough to catch a contact imported mid-window", () => {
    // The regression this pins. At the old value of 1 an expiry six days out
    // produced NOTHING: its −7 day moment was yesterday morning, and those are
    // the most urgent clients in a freshly imported book, not the least.
    const planned = plan([event({ id: "e1", event_date: "2026-08-19" })], [rule(7)])
    expect(planned).toHaveLength(1)
    expect(new Date(planned[0].due_at).getTime()).toBeLessThan(NOW.getTime())
  })

  it("still fires only the NEAREST rule, not every earlier one", () => {
    // An expiry three days out is inside both the −7 and −30 windows. Only −7
    // should fire; −30 came due 27 days ago and would be a second message about
    // the same policy in the same minute.
    const planned = plan([event({ id: "e2", event_date: "2026-08-16" })], [rule(7), rule(30)])
    expect(planned).toHaveLength(1)
    expect(planned[0].rule_id).toBe("rule-policy_expiry-7")
  })

  it("queues a future reminder normally rather than counting it as overdue", () => {
    const planned = plan([event({ id: "e3", event_date: "2026-08-25" })], [rule(7)])
    expect(planned).toHaveLength(1)
    expect(new Date(planned[0].due_at).getTime()).toBeGreaterThan(NOW.getTime())
  })

  it("still refuses a reminder older than the grace period", () => {
    // Expiry 2026-09-02 is 20 days out, so the −30 rule came due 2026-08-03 —
    // ten days ago, past the seven-day grace. The window was widened, not
    // removed.
    const planned = plan([event({ id: "e4", event_date: "2026-09-02" })], [rule(30)])
    expect(planned).toHaveLength(0)
  })

  it("accepts a reminder just inside the grace period", () => {
    // Expiry 2026-09-08 → −30 rule due 2026-08-09, four days ago. Paired with
    // the test above so the boundary is pinned from both sides.
    const planned = plan([event({ id: "e4b", event_date: "2026-09-08" })], [rule(30)])
    expect(planned).toHaveLength(1)
  })

  it("never resurrects a date that has already passed", () => {
    // A one-off in the past has no occurrence on or after today, so it cannot
    // produce a reminder no matter how wide the grace is. This is why the old
    // "stops a year of historical birthdays" rationale was wrong.
    const planned = plan([event({ id: "e5", event_date: "2026-07-01" })], [rule(7), rule(30)])
    expect(planned).toHaveLength(0)
  })

  it("sends a past birthday to next year, not into the overdue window", () => {
    const planned = plan(
      [event({ id: "e6", event_date: "1991-08-12", event_type: "birthday", recurrence: "yearly" })],
      [rule(0, "birthday")],
    )
    expect(planned).toHaveLength(1)
    expect(planned[0].occurrence_date).toBe("2027-08-12")
    expect(new Date(planned[0].due_at).getTime()).toBeGreaterThan(NOW.getTime())
  })

  it("is documented as a whole number of days", () => {
    expect(Number.isInteger(MAX_OVERDUE_DAYS)).toBe(true)
    expect(MAX_OVERDUE_DAYS).toBeGreaterThan(1)
  })
})

describe("summariseDue", () => {
  const leadIdByEvent = new Map([
    ["e1", "lead-a"],
    ["e2", "lead-a"],
    ["e3", "lead-b"],
  ])

  it("counts CONTACTS, not reminders — that is what an operator recognises", () => {
    // Two reminders for one client is one phone call's worth of surprise, not
    // two, and "3 contacts" maps to rows they can find in the file.
    const summary = summariseDue(
      [
        { event_id: "e1", due_at: "2026-08-12T01:00:00.000Z" },
        { event_id: "e2", due_at: "2026-08-12T05:00:00.000Z" },
        { event_id: "e3", due_at: "2026-08-13T01:00:00.000Z" },
      ],
      leadIdByEvent,
      NOW,
    )
    expect(summary).toEqual({ contacts: 2, reminders: 3 })
  })

  it("ignores reminders that are not due yet", () => {
    const summary = summariseDue(
      [{ event_id: "e1", due_at: "2026-08-20T01:00:00.000Z" }],
      leadIdByEvent,
      NOW,
    )
    expect(summary).toEqual({ contacts: 0, reminders: 0 })
  })

  it("treats due-exactly-now as due", () => {
    const summary = summariseDue(
      [{ event_id: "e1", due_at: NOW.toISOString() }],
      leadIdByEvent,
      NOW,
    )
    expect(summary.reminders).toBe(1)
  })

  it("does not count a reminder whose event it cannot resolve to a contact", () => {
    const summary = summariseDue(
      [{ event_id: "unknown", due_at: "2026-08-12T01:00:00.000Z" }],
      leadIdByEvent,
      NOW,
    )
    expect(summary).toEqual({ contacts: 0, reminders: 1 })
  })
})
