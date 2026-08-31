import type { SupabaseClient } from "@supabase/supabase-js"
import { buildKnownTypes } from "./event-facts"

/**
 * The event types this business actually uses.
 *
 * Why this is derived rather than an enum, when a dropdown obviously wants an
 * enum: `event_type` is free text in the schema on purpose. The engine is a
 * generic temporal-trigger — insurance is its first configuration, not its
 * shape — and a course start date, a visa renewal or a warranty expiry has to
 * be a row rather than a migration.
 *
 * But free text has a real cost, and it is the quietest failure the product
 * has: events and rules are joined by EXACT string equality, so "policy_expiry"
 * typed as "policy expiry" produces no error, no warning and no reminder. The
 * CoverageBanner exists to catch it after the fact.
 *
 * A dropdown fed from this function is the fix at the point of entry — the
 * operator picks from what already works, and the schema stays open. New types
 * are still creatable; they just have to be typed deliberately once rather than
 * accidentally every time.
 *
 * Rules come FIRST because a type with a rule behind it is one that will
 * actually fire. A type that only appears on events is offered too, but it is
 * exactly the case the coverage banner is complaining about.
 */

export type KnownEventType = {
  value: string
  /** True when an active rule matches it, so choosing it schedules something. */
  hasRule: boolean
  /** How many of this business's dates already use it. */
  usedBy: number
}

export async function listKnownEventTypes(
  admin: SupabaseClient,
  businessId: string,
): Promise<KnownEventType[]> {
  const [rules, counts] = await Promise.all([
    admin
      .from("reminder_rules")
      .select("event_type")
      .eq("business_id", businessId)
      .eq("active", true),
    // Aggregated in Postgres. This used to select up to 10,000 rows of a single
    // column and count them here — 672 rows moved to produce three strings on
    // live data — and the cap was a silent correctness bug besides: a business
    // past it simply stopped seeing some of its own event types, with no error
    // and no warning. GROUP BY has no ceiling.
    admin.rpc("event_type_counts", { p_business_id: businessId }),
  ])

  if (counts.error) console.error(`[event-types] counts failed: ${counts.error.message}`)

  return buildKnownTypes(
    ((counts.data ?? []) as Array<{ event_type: string; count: number }>).map((r) => ({
      event_type: r.event_type,
      count: Number(r.count),
    })),
    Array.from(new Set((rules.data ?? []).map((r) => r.event_type as string))),
  )
}

/**
 * Dates that are about the PERSON rather than about anything they hold.
 *
 * The split is universal and stays here rather than in a vertical pack. A
 * birthday is a birthday in an insurance agency, a dental practice and a gym,
 * and two things depend on that being true everywhere:
 *
 *   - the personal stuck-claim sweep in claim-reminder.ts runs UNSCOPED across
 *     every business, so it has no pack to consult;
 *   - "personal dates are never retried late" is a promise the retry policy
 *     makes without knowing whose row it is holding.
 *
 * A per-vertical override would break both quietly — a date could be personal
 * on one screen and retryable on another — so if one is ever wanted, the pack
 * has to be threaded into planRetry and that sweep first.
 *
 * What IS per-vertical is the wording. An insurance agency counts policies and
 * a gym counts memberships; both mean "things this person holds". Those words
 * live in vertical-packs.ts, and this function answers only the question they
 * disagree about the name of.
 */
export const PERSONAL_EVENT_TYPES = new Set(["birthday", "anniversary"])

/**
 * Does this event type count as something the contact HOLDS?
 *
 * A negation on purpose — everything is a holding unless it is personal — so a
 * business that invents `visa_expiry` or `defects_liability_end` gets it
 * counted without anyone adding it to a list. That is the same reason
 * `event_type` is free text in the schema.
 */
export function isHoldingType(eventType: string): boolean {
  return !PERSONAL_EVENT_TYPES.has(eventType)
}
