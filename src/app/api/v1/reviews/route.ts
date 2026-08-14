import { withApiToken, readLimit, readOffset } from "@/lib/api/handler"
import { ok } from "@/lib/api/respond"
import { toPublicReview } from "@/lib/api/serialize"

/**
 * GET /api/v1/reviews — rows the importer refused to guess at.
 *
 * This is the endpoint that makes the engine's central promise visible to a
 * host app. When an ingested contact names an agent who matches nobody on the
 * roster — or matches two people — the row is not filed somewhere plausible and
 * it is not dropped. It is parked here with the original payload attached.
 *
 * A host app that ignores this endpoint will slowly accumulate contacts whose
 * reminders all fall back to the owner, with nothing anywhere saying why. The
 * count is the thing to alert on.
 */

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  return withApiToken(request, "reviews.list", async ({ admin, caller }) => {
    const url = new URL(request.url)
    // Pending by default: resolved rows are an audit trail, not a work queue.
    const status = url.searchParams.get("status") ?? "pending"
    const limit = readLimit(url)
    const offset = readOffset(url)

    let query = admin
      .from("contact_import_reviews")
      .select(
        "id, import_id, row_number, reason, detail, status, raw, parsed, resolved_lead_id",
        { count: "exact" },
      )
      .eq("business_id", caller.businessId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)

    if (status !== "all") query = query.eq("status", status)

    const { data, count, error } = await query
    if (error) throw new Error(error.message)

    return ok({
      reviews: (data ?? []).map((r) => toPublicReview(r as Record<string, unknown>)),
      total: count ?? 0,
      limit,
      offset,
    })
  })
}
