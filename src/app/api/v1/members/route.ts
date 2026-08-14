import { withApiToken } from "@/lib/api/handler"
import { ok } from "@/lib/api/respond"
import { toPublicMember } from "@/lib/api/serialize"

/**
 * GET /api/v1/members — the attribution roster.
 *
 * A host app pushing contacts needs this before it pushes anything, because
 * the `agent` field on an ingested contact is matched against these names by
 * EXACT comparison. A name that matches nobody does not get filed somewhere
 * plausible; it goes to the review queue. So a caller that wants clean
 * attribution reads this first and sends values it knows will match.
 *
 * These are not login seats. A member is somewhere a reminder is DELIVERED, and
 * `auth_user_id` is an optional link for the day one of them signs in.
 */

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  return withApiToken(request, "members.list", async ({ admin, caller }) => {
    const url = new URL(request.url)
    // Inactive members are excluded by default because they cannot receive
    // anything, and a caller matching against them would be attributing work
    // to somebody who has left.
    const includeInactive = url.searchParams.get("include_inactive") === "true"

    let query = admin
      .from("team_members")
      .select("id, display_name, email, whatsapp_number, role, active")
      .eq("business_id", caller.businessId)
      .order("display_name")

    if (!includeInactive) query = query.eq("active", true)

    const { data, error } = await query
    if (error) throw new Error(error.message)

    return ok({ members: (data ?? []).map((m) => toPublicMember(m as Record<string, unknown>)) })
  })
}
