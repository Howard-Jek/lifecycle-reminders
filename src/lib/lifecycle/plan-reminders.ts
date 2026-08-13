/**
 * The materialiser: (events × rules × recipients) → rows to insert into
 * `reminders`.
 *
 * Pure and I/O-free so the scheduling decisions can be tested exhaustively
 * without a database. The caller fetches, then inserts the result with
 * ON CONFLICT DO NOTHING — the unique key
 * (event_id, rule_id, occurrence_date, member_id) makes that idempotent, so
 * re-running the cron is always safe.
 */

import type { SendWindow } from "@/lib/types"
import { occurrencesInHorizon, reminderDueAt } from "./occurrence"
import type { ContactEvent, PlannedReminder, ReminderRule, TeamMember } from "./types"

/**
 * How far past its due time a reminder may be and still be created.
 *
 * The original rationale for this constant was wrong, and it made the value far
 * too tight. It claimed to stop "a year of historical birthdays" firing on a
 * first import — but occurrencesInHorizon only ever returns occurrences on or
 * after today, so a birthday from last month resolves to NEXT year's date and
 * its reminder is a year in the future. Historical dates never produced an
 * overdue reminder in the first place.
 *
 * What this actually governs is the mid-window case: an occurrence that is
 * genuinely upcoming, whose lead-time moment has already passed. A policy
 * expiring in six days, with a −7 day rule, is due "yesterday". At one day of
 * grace that client silently got nothing — and on a first import those are the
 * MOST urgent clients in the book, not the least.
 *
 * Seven days is chosen against the seeded rule spacing (−30/−14/−7/−0) so that
 * a mid-window contact fires its NEAREST rule and not its earlier ones: an
 * expiry three days out fires −7 (four days late) while −30 (twenty-seven days
 * late) stays suppressed. One reminder per event, not a pile.
 *
 * Firing late is safe because the wording is not baked in at materialise time:
 * describeLeadTime() is computed at SEND time from the real occurrence, so a
 * reminder created late still reads "in 3 days" rather than a stale "in a week".
 *
 * The import flags how many contacts land already inside their lead time, so a
 * burst is something the operator is told about rather than ambushed by.
 */
export const MAX_OVERDUE_DAYS = 7

export type PlanInput = {
  /** Events for ONE tenant. */
  events: ContactEvent[]
  /** That tenant's rules; inactive ones are ignored here, not by the caller. */
  rules: ReminderRule[]
  /** Active members, used for `all_members` fan-out. */
  members: TeamMember[]
  /** lead_id → assigned member id (absent/null = unassigned → owner fallback). */
  assignmentByLead: Map<string, string | null>
  /** IANA zone from operator_profile.timezone. */
  timezone: string
  /** Today, YYYY-MM-DD, in the operator's timezone. */
  today: string
  /** How far ahead to materialise. */
  horizonDays: number
  /** Injected so planning is deterministic and testable. */
  now: Date
}

export function planReminders(input: PlanInput): PlannedReminder[] {
  const { events, rules, members, assignmentByLead, timezone, today, horizonDays, now } = input

  const activeRules = rules.filter((r) => r.active)
  if (activeRules.length === 0 || events.length === 0) return []

  // event_type → rules, so a tenant with many rules doesn't rescan per event.
  const rulesByType = new Map<string, ReminderRule[]>()
  for (const rule of activeRules) {
    const list = rulesByType.get(rule.event_type)
    if (list) list.push(rule)
    else rulesByType.set(rule.event_type, [rule])
  }

  const activeMemberIds = members.filter((m) => m.active).map((m) => m.id)
  const earliestAllowed = now.getTime() - MAX_OVERDUE_DAYS * 24 * 60 * 60 * 1000

  const planned: PlannedReminder[] = []

  for (const event of events) {
    const matching = rulesByType.get(event.event_type)
    if (!matching) continue

    const occurrences = occurrencesInHorizon(
      event.event_date,
      event.recurrence,
      today,
      horizonDays,
    )
    if (occurrences.length === 0) continue

    for (const rule of matching) {
      for (const occurrence of occurrences) {
        const dueAt = reminderDueAt(
          occurrence,
          rule.offset_days,
          rule.send_window as SendWindow,
          timezone,
        )
        if (dueAt.getTime() < earliestAllowed) continue

        for (const memberId of recipientsFor(rule, event, assignmentByLead, activeMemberIds)) {
          planned.push({
            business_id: event.business_id,
            event_id: event.id,
            rule_id: rule.id,
            occurrence_date: occurrence,
            due_at: dueAt.toISOString(),
            member_id: memberId,
          })
        }
      }
    }
  }

  return planned
}

/**
 * Who this reminder is for.
 *
 * `assigned` yields exactly one recipient — the lead's member, or `null`
 * meaning "nobody is assigned, fall back to the org owner's notify number".
 * Null is deliberately a recipient rather than a skip: an unassigned client's
 * policy expiry is exactly the one nobody is watching.
 *
 * `all_members` fans out one row per active member. With no active members it
 * yields the owner fallback too, so an org-wide reminder is never silently
 * dropped just because the team list is empty.
 */
function recipientsFor(
  rule: ReminderRule,
  event: ContactEvent,
  assignmentByLead: Map<string, string | null>,
  activeMemberIds: string[],
): Array<string | null> {
  if (rule.audience === "all_members") {
    return activeMemberIds.length > 0 ? activeMemberIds : [null]
  }
  return [assignmentByLead.get(event.lead_id) ?? null]
}
