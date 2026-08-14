import { withApiToken } from "@/lib/api/handler"
import { ok, notFound } from "@/lib/api/respond"
import { toPublicContact, toPublicEvent, toPublicReminder } from "@/lib/api/serialize"

/**
 * GET /api/v1/contacts/{id} — one client, their dates, and what is scheduled.
 *
 * The counterpart to the bulk POST on this collection. A host app that has just
 * pushed a book of contacts needs to be able to ask what the engine made of any
 * one of them, without reading the add-on's database.
 *
 * `{id}` is the ADD-ON's lead id. At integration, when both apps share one
 * `leads` table, it becomes the host's lead id and this endpoint collapses into
 * a join — which is the point of keying on it now rather than on phone.
 */

export const dynamic = "force-dynamic"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  return withApiToken(request, "contacts.get", async ({ admin, caller }) => {
    // The business filter is what makes another tenant's id a 404 rather than
    // a read. It is not decoration.
    const { data: lead } = await admin
      .from("leads")
      .select("id, name, phone, email, assigned_member_id")
      .eq("business_id", caller.businessId)
      .eq("id", id)
      .maybeSingle<Record<string, unknown>>()

    if (!lead) return notFound("contact not found")

    const [events, reminders] = await Promise.all([
      admin
        .from("contact_events")
        .select("id, lead_id, event_type, label, event_date, recurrence, source, payload")
        .eq("business_id", caller.businessId)
        .eq("lead_id", id)
        .order("event_date", { ascending: true }),
      // Only what is still ahead — a client with five years of history would
      // otherwise return a wall of sent rows nobody asked for.
      admin
        .from("reminders")
        .select(
          "id, status, occurrence_date, due_at, sent_at, attempts, suggestion, error, member_id, event_id, rule_id",
        )
        .eq("business_id", caller.businessId)
        .eq("status", "queued")
        .order("due_at", { ascending: true })
        .limit(50),
    ])

    const eventIds = new Set((events.data ?? []).map((e) => e.id as string))

    return ok({
      contact: toPublicContact(lead),
      events: (events.data ?? []).map((e) => toPublicEvent(e as Record<string, unknown>)),
      upcoming_reminders: (reminders.data ?? [])
        .filter((r) => eventIds.has(r.event_id as string))
        .map((r) => toPublicReminder(r as Record<string, unknown>)),
    })
  })
}
