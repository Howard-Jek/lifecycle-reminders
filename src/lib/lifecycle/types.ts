/**
 * Lifecycle events & reminders — row and domain types.
 *
 * Mirrors supabase/migrations/20260726000000_lifecycle_events.sql. `eventType`
 * is a plain string on purpose: the engine is vertical-agnostic, so the set of
 * event types lives in operator data, never in a TypeScript union.
 */

import type { SendWindow } from "@/lib/types"

export type Recurrence = "none" | "yearly"
export type EventSource = "import" | "manual" | "ai"
export type ReminderAudience = "assigned" | "all_members"
export type ReminderStatus = "queued" | "claimed" | "sent" | "failed" | "skipped"
export type TeamMemberRole = "owner" | "agent"

/** Event types the seeded rules use. Convenience constants only — an operator
 * can define any string, and nothing in the engine switches on these. */
export const COMMON_EVENT_TYPES = {
  birthday: "birthday",
  policyExpiry: "policy_expiry",
  policyReview: "policy_review",
} as const

export type TeamMember = {
  id: string
  business_id: string
  display_name: string
  email: string | null
  /** E.164. Where this member RECEIVES reminders; never sent from. */
  whatsapp_number: string
  role: TeamMemberRole
  auth_user_id: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export type ContactEvent = {
  id: string
  business_id: string
  lead_id: string
  event_type: string
  label: string | null
  /** YYYY-MM-DD. For a yearly event the year is the original, not the next. */
  event_date: string
  recurrence: Recurrence
  source: EventSource
  payload: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type ReminderRule = {
  id: string
  business_id: string
  event_type: string
  /** Days before the occurrence; 0 = on the day. */
  offset_days: number
  action: "notify_agent"
  audience: ReminderAudience
  suggest_message: boolean
  send_window: SendWindow
  active: boolean
  created_at: string
  updated_at: string
}

export type Reminder = {
  id: string
  business_id: string
  event_id: string
  rule_id: string
  occurrence_date: string
  due_at: string
  /** Recipient. Null = unassigned, falls back to the org owner's number. */
  member_id: string | null
  status: ReminderStatus
  claimed_at: string | null
  sent_at: string | null
  attempts: number
  suggestion: string | null
  whatsapp_message_id: string | null
  error: string | null
  created_at: string
}

/** A reminder the materialiser wants to create. Maps 1:1 onto the unique key
 * (event_id, rule_id, occurrence_date, member_id), so inserting a batch with
 * ON CONFLICT DO NOTHING is idempotent. */
export type PlannedReminder = {
  business_id: string
  event_id: string
  rule_id: string
  occurrence_date: string
  due_at: string
  member_id: string | null
}

