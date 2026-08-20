import { z } from "zod"
import { withApiToken } from "@/lib/api/handler"
import { ok, badRequest, notFound } from "@/lib/api/respond"
import { readJson } from "@/lib/api/respond"
import { isDryRun, appPublicUrl } from "@/lib/env"
import { readWhatsappCredentials, fetchTemplateStatus } from "@/lib/notify/template-admin"
import { isSamePhoneNumber } from "@/lib/phone-match"
import { sendClientEventReminder } from "@/lib/notify/client-event-reminder"

/**
 * POST /api/v1/template/test-send — put one real message on a real handset.
 *
 * The last link in the chain the other endpoints set up: submit the template,
 * poll until approved, then prove end-to-end that a message actually arrives.
 * It sends the SAME template through the SAME sender as a production reminder,
 * because a test that takes a different path proves only that the different
 * path works.
 *
 * WHY THIS WILL NOT SEND TO AN ARBITRARY NUMBER
 *
 * The recipient must already be on the caller's own team roster. That is not
 * friction for its own sake — it is this product's central safety property.
 * Every message it sends goes to an AGENT; nothing here ever messages a client,
 * and client-event-reminder.ts says so at the top.
 *
 * An authenticated endpoint that accepts a free-form destination would quietly
 * demote that from an invariant to a convention, and hand anyone who obtains an
 * API token a WhatsApp relay that sends from a verified business number — which
 * is a spam asset worth stealing a token for. Scoping to the roster means the
 * worst a leaked token can do is message people it could already message.
 *
 * To message yourself: add your number on the Team page (or POST it to the
 * members roster), then call this.
 */

export const dynamic = "force-dynamic"

const BodySchema = z
  .object({
    /** Roster member id — unambiguous, and carries no phone number in the request. */
    member_id: z.string().uuid().optional(),
    /** Or the number itself, which must still match a roster row. */
    to: z.string().min(5).max(20).optional(),
  })
  .refine((b) => Boolean(b.member_id || b.to), {
    message: "provide member_id or to",
  })

export async function POST(request: Request) {
  return withApiToken(request, "template.test-send", async ({ admin, caller }) => {
    const json = await readJson(request)
    if (!json.ok) return badRequest("body must be JSON")
    const parsed = BodySchema.safeParse(json.body)
    if (!parsed.success) return badRequest("invalid body", parsed.error.issues)

    // Scoped to the caller's own business before anything is matched, so a
    // number that exists on ANOTHER tenant's roster is simply not found here.
    const { data: roster, error } = await admin
      .from("team_members")
      .select("id, display_name, whatsapp_number, active")
      .eq("business_id", caller.businessId)
    if (error) throw new Error(error.message)

    const members = (roster ?? []) as Array<{
      id: string
      display_name: string
      whatsapp_number: string | null
      active: boolean
    }>

    const wanted = parsed.data.member_id
    let target: (typeof members)[number] | undefined

    if (wanted) {
      target = members.find((m) => m.id === wanted)
    } else {
      const matches = members.filter((m) => isSamePhoneNumber(m.whatsapp_number, parsed.data.to))
      if (matches.length > 1) {
        // Same discipline as the webhook's sender attribution: when a number
        // does not identify ONE person, refuse rather than pick. Here the cost
        // of guessing is only a message to the wrong colleague, but "it texted
        // somebody else" is not a defensible answer either.
        return badRequest(
          `that number matches ${matches.length} team members — pass member_id to say which`,
        )
      }
      target = matches[0]
    }

    if (!target) {
      // Same message for "no such member" and "that number is on nobody's
      // roster here", matching respond.ts's reasoning: a different answer for
      // a number that exists under another tenant would confirm it exists.
      return notFound(
        "no team member here matches that — add the number on the Team page first, " +
          "then retry. This endpoint only messages your own roster.",
      )
    }
    if (!target.whatsapp_number) {
      return badRequest(`${target.display_name} has no WhatsApp number on file`)
    }

    const result = await sendClientEventReminder(target.whatsapp_number, {
      // Unmistakably a test on the handset. A realistic-looking sample would
      // be indistinguishable from a real reminder about a real client.
      clientLabel: "Test Contact",
      eventLabel: "Test reminder",
      whenText: "today",
      suggestion:
        "This is a test message from Lifecycle. If you can read this, the template is approved and delivery works.",
      deepLink: `${appPublicUrl() || "https://lifecycle-app-tau.vercel.app"}/reminders`,
    })

    if (result.ok) {
      return ok({
        sent: true,
        to: { member_id: target.id, display_name: target.display_name },
        whatsapp_message_id: result.whatsappMessageId,
        // Dry run stamps a synthetic id and returns ok, so without this the
        // response is indistinguishable from a real delivery and the obvious
        // conclusion — "it says sent, my phone says nothing" — is a wrong one.
        dry_run: isDryRun(),
        note: isDryRun()
          ? "REMINDER_DRY_RUN is on: nothing was sent to WhatsApp and this id is synthetic."
          : "Delivery is asynchronous. A failure arrives at /api/webhooks/whatsapp and lands the reminder in Needs attention.",
      })
    }

    if (result.reason === "not_configured") {
      return badRequest(
        "WhatsApp is not configured — set GOMA_NOTIFY_PHONE_NUMBER_ID and GOMA_NOTIFY_ACCESS_TOKEN",
      )
    }

    // Meta's send errors are famously unhelpful in isolation: #132001 says
    // "template does not exist" whether it was never submitted, is still
    // pending, or exists in a different LANGUAGE. One extra Graph call turns
    // that into an answer instead of a search.
    const creds = readWhatsappCredentials()
    const status = creds ? await fetchTemplateStatus(creds) : null
    return badRequest(
      `WhatsApp rejected the send: ${result.error ?? "unknown error"}` +
        (status?.ok ? ` (template state: ${status.state})` : ""),
    )
  })
}
