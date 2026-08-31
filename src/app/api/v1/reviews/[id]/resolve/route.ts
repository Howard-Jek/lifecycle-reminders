import { z } from "zod"
import { reassignContactReminders } from "@/lib/lifecycle/reassign-reminders"
import { withApiToken } from "@/lib/api/handler"
import { ok, badRequest, notFound, readJson } from "@/lib/api/respond"

/**
 * POST /api/v1/reviews/{id}/resolve — attribute a parked row, or let it go.
 *
 * Mirrors `resolveReview` in app/actions/imports.ts exactly, because the two
 * must not drift: this writes the same three columns in the same order and
 * assigns the lead first, so a failure leaves the review pending rather than
 * marking it resolved against a lead that was never assigned.
 *
 * `member_id: null` dismisses. That is a real outcome, not a failure — some
 * rows genuinely have no owner, and a queue whose items can only be resolved
 * one way stops being worked.
 *
 * `resolved_by` is left null on purpose. The column references auth.users and a
 * token-authed caller is not one; writing the token's creator there would
 * record that a person made a judgement they never made.
 */

export const dynamic = "force-dynamic"

const BodySchema = z.object({
  /** A team_members.id, or null to dismiss. */
  member_id: z.string().uuid().nullable(),
})

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  return withApiToken(request, "reviews.resolve", async ({ admin, caller }) => {
    const json = await readJson(request)
    if (!json.ok) return badRequest("body must be JSON")

    const parsed = BodySchema.safeParse(json.body)
    if (!parsed.success) return badRequest("invalid body", parsed.error.issues)
    const memberId = parsed.data.member_id

    const { data: review } = await admin
      .from("contact_import_reviews")
      .select("id, status, parsed")
      .eq("business_id", caller.businessId)
      .eq("id", id)
      .maybeSingle<{ id: string; status: string; parsed: Record<string, unknown> }>()

    if (!review) return notFound("review not found")

    const leadId = (review.parsed?.lead_id as string | undefined) ?? null

    // A row whose contact never landed — a missing phone, say — has no lead to
    // attribute, so dismissal is the only coherent outcome.
    if (!memberId || !leadId) {
      const { error } = await admin
        .from("contact_import_reviews")
        .update({ status: "dismissed" })
        .eq("business_id", caller.businessId)
        .eq("id", id)
      if (error) throw new Error(error.message)
      return ok({ id, status: "dismissed", assigned_lead_id: null })
    }

    // The member has to be real, active, and this tenant's — otherwise the
    // reminder would be attributed to a row that can never receive it.
    const { data: member } = await admin
      .from("team_members")
      .select("id, active")
      .eq("business_id", caller.businessId)
      .eq("id", memberId)
      .maybeSingle<{ id: string; active: boolean }>()

    if (!member) return notFound("member not found")
    if (!member.active) return badRequest("member is inactive and cannot receive reminders")

    // Assignment first. If this fails the review stays pending, which is
    // recoverable; the reverse would mark it resolved against nothing.
    const { error: assignError } = await admin
      .from("leads")
      .update({ assigned_member_id: memberId })
      .eq("business_id", caller.businessId)
      .eq("id", leadId)
    if (assignError) throw new Error(assignError.message)

    // The lead already existed, so it may already have reminders queued to a
    // different agent. Same rule as the contact page.
    await reassignContactReminders(admin, caller.businessId, leadId, memberId)

    // resolution_coherent requires status, resolved_lead_id and resolved_at
    // to move together.
    const { error } = await admin
      .from("contact_import_reviews")
      .update({
        status: "resolved",
        resolved_lead_id: leadId,
        resolved_at: new Date().toISOString(),
      })
      .eq("business_id", caller.businessId)
      .eq("id", id)

    if (error) throw new Error(error.message)

    return ok({ id, status: "resolved", assigned_lead_id: leadId, member_id: memberId })
  })
}
