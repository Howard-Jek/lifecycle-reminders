import { z } from "zod"
import { withApiToken } from "@/lib/api/handler"
import { ok, badRequest, notFound, readJson } from "@/lib/api/respond"
import { toPublicEvent } from "@/lib/api/serialize"
import { parseCalendarDate } from "@/lib/sanitize"

/**
 * POST /api/v1/contacts/{id}/events — add a date to an existing client.
 *
 * The bulk ingest endpoint is for importing a book. This is for the single
 * write a host app makes when something changes: a policy is renewed, a review
 * is booked, a birthday is corrected.
 *
 * Upserted on the same identity the importer uses — `(lead_id, event_type,
 * event_date, label)` with NULLS NOT DISTINCT — so a host app that retries a
 * failed call, or replays a webhook, adds nothing the second time. That is the
 * property that makes this endpoint safe to call from an at-least-once queue,
 * which is what every host app eventually has.
 */

export const dynamic = "force-dynamic"

const EventSchema = z.object({
  type: z.string().trim().min(1).max(100),
  date: z.string().trim().min(1).max(40),
  label: z.string().trim().max(200).nullish(),
  recurrence: z.enum(["none", "yearly"]).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
})

const BodySchema = z.object({
  events: z.array(EventSchema).min(1).max(50),
  /** e.g. "DD/MM/YYYY". Omit when the dates are already ISO. Guessing here is
   * how 03/04 becomes the wrong month for half a book. */
  date_format: z.string().trim().max(40).nullish(),
})

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  return withApiToken(request, "contacts.events.create", async ({ admin, caller }) => {
    const json = await readJson(request)
    if (!json.ok) return badRequest("body must be JSON")

    const parsed = BodySchema.safeParse(json.body)
    if (!parsed.success) return badRequest("invalid body", parsed.error.issues)

    // Confirms the lead exists AND belongs to this tenant before writing
    // anything keyed to it.
    const { data: lead } = await admin
      .from("leads")
      .select("id")
      .eq("business_id", caller.businessId)
      .eq("id", id)
      .maybeSingle<{ id: string }>()

    if (!lead) return notFound("contact not found")

    const rows: Record<string, unknown>[] = []
    const rejected: { type: string; date: string; reason: string }[] = []

    for (const event of parsed.data.events) {
      const date = parseCalendarDate(event.date, parsed.data.date_format ?? null)
      if (!date) {
        // Reported rather than dropped, and rather than failing the whole
        // call: one unreadable cell should not reject four good ones.
        rejected.push({ type: event.type, date: event.date, reason: "unparseable_date" })
        continue
      }
      rows.push({
        business_id: caller.businessId,
        lead_id: id,
        event_type: event.type,
        label: event.label ?? null,
        event_date: date,
        recurrence: event.recurrence ?? "none",
        source: "api",
        payload: event.payload ?? {},
      })
    }

    if (rows.length === 0) {
      return badRequest("no readable dates in the request")
    }

    const { data, error } = await admin
      .from("contact_events")
      .upsert(rows, { onConflict: "lead_id,event_type,event_date,label", ignoreDuplicates: false })
      .select("id, lead_id, event_type, label, event_date, recurrence, source, payload")

    if (error) throw new Error(error.message)

    return ok({
      events: (data ?? []).map((e) => toPublicEvent(e as Record<string, unknown>)),
      rejected,
      // The queue is materialised by the cycle, not by this write — so a date
      // added now produces a reminder on the next run, not immediately.
      note: "Reminders for these dates are materialised on the next processing cycle.",
    })
  })
}
