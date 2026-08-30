import { z } from "zod"
import { withApiToken } from "@/lib/api/handler"
import { ok, badRequest, notFound } from "@/lib/api/respond"
import { readJson } from "@/lib/api/respond"
import { isSamePhoneNumber } from "@/lib/phone-match"
import { sendRosterTestMessage } from "@/lib/notify/test-message"

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

    // Same resolution, same template, same sender as the Team page button —
    // one code path, so a green test here means the button works too.
    const result = await sendRosterTestMessage(target)
    if (!result.ok) return badRequest(result.error)

    return ok({
      sent: true,
      to: { member_id: target.id, display_name: target.display_name },
      whatsapp_message_id: result.whatsappMessageId,
      dry_run: result.dryRun,
      note: result.dryRun
        ? "REMINDER_DRY_RUN is on: nothing was sent to WhatsApp and this id is synthetic."
        : "Delivery is asynchronous. A failure arrives at /api/webhooks/whatsapp and lands the reminder in Needs attention.",
    })
  })
}
