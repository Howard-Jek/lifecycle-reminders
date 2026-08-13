/**
 * "How many of these will go out immediately?"
 *
 * An import can land contacts whose date is already inside its lead time — a
 * policy expiring in six days against a −7 day rule. Those reminders are
 * correct and wanted (they are the most urgent clients in the book), but an
 * operator who uploads 500 rows and triggers thirty WhatsApps to their team
 * within fifteen minutes should have been told first.
 *
 * Deliberately computed by running the REAL materialiser over the freshly
 * imported events rather than by re-deriving the rule. A second implementation
 * of "is this due?" would eventually disagree with planReminders, and it would
 * disagree in the direction of promising a quiet import that isn't.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { planReminders } from "./plan-reminders"
import { todayInTimezone } from "./occurrence"
import type { ContactEvent, ReminderRule, TeamMember } from "./types"

export type DuePreview = {
  /** Contacts with at least one reminder already past its due time. */
  contacts: number
  /** Individual reminders that will fire on the next tick. */
  reminders: number
}

/** Count distinct contacts among the planned rows that are already due. */
export function summariseDue(
  planned: Array<{ event_id: string; due_at: string }>,
  leadIdByEvent: Map<string, string>,
  now: Date,
): DuePreview {
  const overdue = planned.filter((row) => new Date(row.due_at).getTime() <= now.getTime())
  const leads = new Set<string>()
  for (const row of overdue) {
    const leadId = leadIdByEvent.get(row.event_id)
    if (leadId) leads.add(leadId)
  }
  // Contacts, not reminders, is the number an operator can act on: it maps to
  // rows they recognise in the file they just uploaded.
  return { contacts: leads.size, reminders: overdue.length }
}

/**
 * How much of this import is already due.
 *
 * Scoped to the leads that were just touched — an import must not report the
 * whole standing backlog as though it caused it.
 */
export async function previewDueForLeads(
  admin: SupabaseClient,
  businessId: string,
  leadIds: string[],
  now = new Date(),
): Promise<DuePreview> {
  if (leadIds.length === 0) return { contacts: 0, reminders: 0 }

  const [{ data: business }, { data: ruleRows }, { data: memberRows }] = await Promise.all([
    admin
      .from("businesses")
      .select("timezone")
      .eq("id", businessId)
      .maybeSingle<{ timezone: string | null }>(),
    admin.from("reminder_rules").select("*").eq("business_id", businessId).eq("active", true),
    admin.from("team_members").select("*").eq("business_id", businessId).eq("active", true),
  ])

  const rules = (ruleRows ?? []) as ReminderRule[]
  if (rules.length === 0) return { contacts: 0, reminders: 0 }

  const events: ContactEvent[] = []
  const CHUNK = 500
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const { data } = await admin
      .from("contact_events")
      .select("*")
      .eq("business_id", businessId)
      .in("lead_id", leadIds.slice(i, i + CHUNK))
    events.push(...((data ?? []) as ContactEvent[]))
  }
  if (events.length === 0) return { contacts: 0, reminders: 0 }

  const assignmentByLead = new Map<string, string | null>()
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const { data } = await admin
      .from("leads")
      .select("id, assigned_member_id")
      .eq("business_id", businessId)
      .in("id", leadIds.slice(i, i + CHUNK))
    for (const row of data ?? []) {
      assignmentByLead.set(row.id as string, (row.assigned_member_id as string | null) ?? null)
    }
  }

  const timezone = business?.timezone || "Asia/Singapore"
  const planned = planReminders({
    events,
    rules,
    members: (memberRows ?? []) as TeamMember[],
    assignmentByLead,
    timezone,
    today: todayInTimezone(now, timezone),
    // The horizon only has to reach far enough to include anything ALREADY due;
    // a year is comfortably past the schema's 365-day offset cap.
    horizonDays: 400,
    now,
  })

  const leadIdByEvent = new Map(events.map((e) => [e.id, e.lead_id]))
  return summariseDue(planned, leadIdByEvent, now)
}
