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
 * The one event type the UI treats specially.
 *
 * Contacts counts POLICIES rather than dates, and a birthday is not a policy —
 * it is about the person, not a product they hold. Naming it here rather than
 * inlining the string keeps that exception in one place and visible: it is the
 * single point where this vertical-agnostic engine admits to knowing what an
 * insurance agency means by "how many do they have".
 */
export const PERSONAL_EVENT_TYPES = new Set(["birthday", "anniversary"])

export function isPolicyLike(eventType: string): boolean {
  return !PERSONAL_EVENT_TYPES.has(eventType)
}
