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

/**
 * What "Needs attention" means.
 *
 * Three states, not one:
 *   failed   — tried and gave up.
 *   skipped  — never tried and never will: a deleted contact, no number on file.
 *   queued with an attempt behind it — mid-retry. It went wrong, it is coming
 *              back, and it belongs in front of somebody in the meantime.
 *
 * That third clause is why "due" filters on `attempts = 0`. Without the pair, a
 * retrying row sits in Due looking like untried work, carrying an error nobody
 * had a reason to open — and, since this module also scopes the "Clear these
 * 49" button, would be bulk-deleted mid-retry by an operator tidying up Due.
 *
 * A string rather than .in()/.or() calls because PostgREST needs the whole
 * disjunction in one `or=`; a malformed one does not throw, it silently
 * changes which rows come back.
 */
export const ATTENTION_FILTER =
  "status.in.(failed,skipped),and(status.eq.queued,attempts.gt.0)"

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
    // Untried work only. A row that has already failed once is queued too, and
    // leaving it here made Due a mix of "nobody has looked at this" and "this
    // went wrong and is waiting" — the two things an operator most needs to
    // tell apart. It shows under Needs attention instead.
    q = q.eq("status", "queued").lte("due_at", scope.nowIso).eq("attempts", 0) as Q
  } else if (scope.tab === "upcoming") {
    q = q.eq("status", "queued").gt("due_at", scope.nowIso) as Q
  } else if (scope.tab === "sent") {
    q = q.eq("status", "sent") as Q
  } else {
    q = q.or(ATTENTION_FILTER) as Q
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
