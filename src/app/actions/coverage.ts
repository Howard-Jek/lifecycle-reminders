"use server"

import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { computeCoverage, type Coverage } from "@/lib/lifecycle/coverage"

/**
 * Which of this business's stored dates can actually fire.
 *
 * Read through the service role because it aggregates across every contact,
 * and the answer is a count rather than rows — there is nothing here RLS would
 * protect that the caller cannot already see.
 */
export async function getCoverage(): Promise<Coverage> {
  const tenant = await requireTenant()
  const admin = createAdminClient()

  const [{ data: events }, { data: rules }] = await Promise.all([
    // Paginated at the same 1000-row cap the materialiser respects; a tenant
    // with more events than that would otherwise get a coverage report drawn
    // from an arbitrary subset, which is worse than none.
    admin
      .from("contact_events")
      .select("event_type")
      .eq("business_id", tenant.businessId)
      .limit(10000),
    admin
      .from("reminder_rules")
      .select("event_type")
      .eq("business_id", tenant.businessId)
      .eq("active", true),
  ])

  const counts = new Map<string, number>()
  for (const row of events ?? []) {
    const type = row.event_type as string
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }

  return computeCoverage(
    Array.from(counts, ([event_type, count]) => ({ event_type, count })),
    Array.from(new Set((rules ?? []).map((r) => r.event_type as string))),
  )
}
