import type { SupabaseClient } from "@supabase/supabase-js"

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
  const [rules, events] = await Promise.all([
    admin
      .from("reminder_rules")
      .select("event_type")
      .eq("business_id", businessId)
      .eq("active", true),
    // Capped: this only needs the DISTINCT set, and PostgREST has no distinct.
    // 10k rows is far past the point where a new type would still be unseen,
    // and it is the same cap getCoverage() uses.
    admin.from("contact_events").select("event_type").eq("business_id", businessId).limit(10000),
  ])

  const usage = new Map<string, number>()
  for (const row of events.data ?? []) {
    const type = row.event_type as string
    usage.set(type, (usage.get(type) ?? 0) + 1)
  }

  const ruled = new Set((rules.data ?? []).map((r) => r.event_type as string))
  const all = new Set<string>([...ruled, ...usage.keys()])

  return Array.from(all)
    .map((value) => ({ value, hasRule: ruled.has(value), usedBy: usage.get(value) ?? 0 }))
    .sort((a, b) => {
      // Types that will actually fire, then the most-used, then alphabetical.
      if (a.hasRule !== b.hasRule) return a.hasRule ? -1 : 1
      if (a.usedBy !== b.usedBy) return b.usedBy - a.usedBy
      return a.value.localeCompare(b.value)
    })
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
