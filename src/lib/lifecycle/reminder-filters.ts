import type { PostgrestFilterBuilder } from "@supabase/postgrest-js"

/**
 * The inbox's filters, in one place.
 *
 * Extracted because the "Clear these 49" button has to remove EXACTLY the rows
 * the tab is showing. Two copies of this logic — one building the list, one
 * building the delete — is a bulk destructive action whose scope silently drifts
 * from the count next to it. The count and the deletion now come from the same
 * predicates by construction.
 */

export type ReminderScope = {
  tab: "due" | "upcoming" | "sent" | "attention"
  /** Restrict to one member's reminders. Ignored when memberId is absent. */
  mine: boolean
  memberId: string | undefined
  /** Event types to keep, or [] for all. */
  viewTypes: string[]
  /** The instant "due" is measured against; passed in so list and delete agree. */
  nowIso: string
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyQuery = PostgrestFilterBuilder<any, any, any, any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Does this scope need the contact_events join? */
export function scopeNeedsEventJoin(scope: ReminderScope): boolean {
  return scope.viewTypes.length > 0
}

export function applyReminderScope<Q extends AnyQuery>(query: Q, scope: ReminderScope): Q {
  let q = query

  if (scope.viewTypes.length > 0) {
    q = q.in("contact_events.event_type", scope.viewTypes) as Q
  }

  if (scope.tab === "due") {
    q = q.eq("status", "queued").lte("due_at", scope.nowIso) as Q
  } else if (scope.tab === "upcoming") {
    q = q.eq("status", "queued").gt("due_at", scope.nowIso) as Q
  } else if (scope.tab === "sent") {
    q = q.eq("status", "sent") as Q
  } else {
    q = q.in("status", ["failed", "skipped"]) as Q
  }

  if (scope.mine && scope.memberId) q = q.eq("member_id", scope.memberId) as Q

  return q
}

/**
 * Is this scope safe to bulk-delete?
 *
 * `claimed` is deliberately absent from every tab, and must stay absent: a
 * claimed row is one a worker is mid-send on, and deleting it loses the record
 * of a message that may already have reached a handset.
 */
export function scopeIsDeletable(scope: ReminderScope): boolean {
  return ["due", "upcoming", "sent", "attention"].includes(scope.tab)
}
