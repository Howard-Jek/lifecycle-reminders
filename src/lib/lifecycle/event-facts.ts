import type { SupabaseClient } from "@supabase/supabase-js"
import { computeCoverage, type Coverage } from "@/lib/lifecycle/coverage"
import type { KnownEventType } from "@/lib/lifecycle/event-types"

/**
 * The two facts about a tenant's event types, fetched once.
 *
 * getCoverage() and listKnownEventTypes() wanted the same thing — which types
 * exist, how many dates carry each, and which have an active rule — and each
 * went and got it separately. That was four round trips per page render, two of
 * them transferring up to 10,000 rows of a single column so it could be counted
 * in JavaScript. Measured live: 672 rows moved twice to produce three strings.
 *
 * Both also capped at 10,000 and reduced client-side, so a business past that
 * ceiling silently lost event types from its coverage report AND its dropdown —
 * no error, just a gap nobody was told about. The aggregate has no cap.
 *
 * Two queries now serve both callers, and the derivations are pure.
 */

export type EventFacts = {
  coverage: Coverage
  knownTypes: KnownEventType[]
}

type CountRow = { event_type: string; count: number }

export async function loadEventFacts(
  admin: SupabaseClient,
  businessId: string,
): Promise<EventFacts> {
  const [countsRes, rulesRes] = await Promise.all([
    admin.rpc("event_type_counts", { p_business_id: businessId }),
    admin
      .from("reminder_rules")
      .select("event_type")
      .eq("business_id", businessId)
      .eq("active", true),
  ])

  if (countsRes.error) {
    // Loud, because the two things built from this both fail QUIETLY: an empty
    // coverage report reads as "nothing is wrong" and an empty type list reads
    // as "this business has no dates".
    console.error(`[event-facts] event_type_counts failed: ${countsRes.error.message}`)
  }
  if (rulesRes.error) {
    console.error(`[event-facts] rules query failed: ${rulesRes.error.message}`)
  }

  const counts: CountRow[] = ((countsRes.data ?? []) as Array<{ event_type: string; count: number }>)
    .map((r) => ({ event_type: r.event_type, count: Number(r.count) }))
    .filter((r) => r.event_type)

  const ruleTypes = Array.from(
    new Set(((rulesRes.data ?? []) as Array<{ event_type: string }>).map((r) => r.event_type)),
  )

  return {
    coverage: computeCoverage(counts, ruleTypes),
    knownTypes: buildKnownTypes(counts, ruleTypes),
  }
}

/**
 * Same ordering contract listKnownEventTypes had, kept deliberately: a type
 * with a rule behind it is one that will actually fire, so it is offered first;
 * then the most-used; then alphabetical.
 */
export function buildKnownTypes(counts: CountRow[], ruleTypes: string[]): KnownEventType[] {
  const usage = new Map(counts.map((c) => [c.event_type, c.count]))
  const ruled = new Set(ruleTypes)

  return Array.from(new Set<string>([...ruled, ...usage.keys()]))
    .map((value) => ({ value, hasRule: ruled.has(value), usedBy: usage.get(value) ?? 0 }))
    .sort((a, b) => {
      if (a.hasRule !== b.hasRule) return a.hasRule ? -1 : 1
      if (a.usedBy !== b.usedBy) return b.usedBy - a.usedBy
      return a.value.localeCompare(b.value)
    })
}
