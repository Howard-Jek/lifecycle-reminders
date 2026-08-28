import { z } from "zod"
import { withApiToken } from "@/lib/api/handler"
import { ok, badRequest, readJson } from "@/lib/api/respond"
import {
  registerPhoneNumber,
  fetchPhoneNumberStatus,
} from "@/lib/notify/template-admin"

/**
 * POST /api/v1/whatsapp/register — clear the sending number to send.
 *
 * The last manual step in the chain, done over HTTP like the rest of it. It
 * calls Meta's /register on GOMA_NOTIFY_PHONE_NUMBER_ID, which is what turns
 * "#133010 Account not registered" into a number that can actually deliver.
 *
 * The PIN never lands in a URL or a log — it is read from the body and passed
 * straight to Graph, and the response says nothing about it either way.
 */

export const dynamic = "force-dynamic"

const BodySchema = z.object({
  /** Six digits. Meta rejects anything else outright. */
  pin: z.string().regex(/^\d{6}$/, "pin must be exactly 6 digits"),
})

export async function POST(request: Request) {
  return withApiToken(request, "whatsapp.register", async ({ caller }) => {
    const json = await readJson(request)
    if (!json.ok) return badRequest("body must be JSON")
    const parsed = BodySchema.safeParse(json.body)
    if (!parsed.success) return badRequest("invalid body", parsed.error.issues)

    const accessToken = process.env.GOMA_NOTIFY_ACCESS_TOKEN?.trim()
    const phoneNumberId = process.env.GOMA_NOTIFY_PHONE_NUMBER_ID?.trim()
    if (!accessToken || !phoneNumberId) {
      return badRequest("GOMA_NOTIFY_ACCESS_TOKEN or GOMA_NOTIFY_PHONE_NUMBER_ID is not set")
    }

    const result = await registerPhoneNumber(accessToken, phoneNumberId, parsed.data.pin)
    if (!result.ok) {
      // Meta's own message, verbatim. A wrong PIN, a locked-out number and an
      // expired token all fail here and say so differently, and paraphrasing
      // would lose the one detail that tells them apart.
      return badRequest(`Meta refused the registration: ${result.error}`)
    }

    console.info(`[api/v1] ${phoneNumberId} registered for the Cloud API by ${caller.businessId}`)

    // Asked again rather than assumed. A 200 from /register means the request
    // was accepted, not that the number has finished becoming CONNECTED.
    const status = await fetchPhoneNumberStatus(accessToken, phoneNumberId)
    return ok({
      registered: true,
      status: status.ok ? status.status : null,
      platform_type: status.ok ? status.platformType : null,
      ready_to_send: status.ok ? status.registered : false,
      detail: status.ok && status.registered
        ? "Registered and CONNECTED — sends should reach a handset."
        : "Registration accepted. Meta may take a moment to report CONNECTED; " +
          "poll GET /api/v1/whatsapp until ready_to_send is true.",
    })
  })
}
