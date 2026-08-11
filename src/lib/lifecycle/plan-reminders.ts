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
 * This exists to stop a first import blasting the team. An operator onboarding
 * 500 clients has a year of birthdays and policy dates behind them; without a
 * cutoff, every rule whose lead time has already elapsed would materialise as
 * due-in-the-past and the scheduler would fire them all at once. One day of
 * grace still catches anything that came due while the worker was down.
 */
const MAX_OVERDUE_DAYS = 1

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
