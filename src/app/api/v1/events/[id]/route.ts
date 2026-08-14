import { withApiToken } from "@/lib/api/handler"
import { ok, notFound } from "@/lib/api/respond"

/**
 * DELETE /api/v1/events/{id} — remove a date.
 *
 * The other half of keeping a host app's dates in sync: a policy cancelled,
 * a review moved, a birthday entered twice.
 *
 * Deleting an event CASCADES to its reminders, including ones already sent.
 * That is the schema's choice, not this endpoint's, but a caller deserves to
 * know the number — so the count of reminders that went with it is returned
 * rather than left for them to discover from a shrinking inbox.
 */

export const dynamic = "force-dynamic"

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  return withApiToken(request, "events.delete", async ({ admin, caller }) => {
    const { data: event } = await admin
      .from("contact_events")
      .select("id")
      .eq("business_id", caller.businessId)
      .eq("id", id)
      .maybeSingle<{ id: string }>()

    if (!event) return notFound("event not found")

    // Counted BEFORE the delete: afterwards the rows are gone and the number
    // is unrecoverable.
    const { count } = await admin
      .from("reminders")
      .select("id", { count: "exact", head: true })
      .eq("business_id", caller.businessId)
      .eq("event_id", id)

    const { error } = await admin
      .from("contact_events")
      .delete()
      .eq("business_id", caller.businessId)
      .eq("id", id)

    if (error) throw new Error(error.message)

    return ok({ deleted: id, reminders_removed: count ?? 0 })
  })
}
