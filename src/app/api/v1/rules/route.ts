import { withApiToken } from "@/lib/api/handler"
import { ok } from "@/lib/api/respond"
import { toPublicRule } from "@/lib/api/serialize"

/**
 * GET /api/v1/rules — the policy the engine runs on.
 *
 * Exposed read-only, deliberately. A rule change is retroactive in effect: it
 * silently alters what the next cycle materialises for every contact at once,
 * and there is no undo beyond noticing. That is an operator decision made in a
 * UI that can warn about it, not a call a host app should be able to make on a
 * schedule.
 *
 * It is worth reading, though, because it explains the queue. A host app asking
 * "why is there no reminder for this policy expiry" almost always finds the
 * answer here: no active rule matches that `event_type`. Rules and events are
 * joined by exact string equality on free text, so a typo on either side
 * produces silence rather than an error.
 */

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  return withApiToken(request, "rules.list", async ({ admin, caller }) => {
    const url = new URL(request.url)
    const includeInactive = url.searchParams.get("include_inactive") === "true"

    let query = admin
      .from("reminder_rules")
      .select("id, event_type, offset_days, audience, suggest_message, send_window, active")
      .eq("business_id", caller.businessId)
      .order("event_type")
      .order("offset_days", { ascending: false })

    if (!includeInactive) query = query.eq("active", true)

    const { data, error } = await query
    if (error) throw new Error(error.message)

    return ok({ rules: (data ?? []).map((r) => toPublicRule(r as Record<string, unknown>)) })
  })
}
