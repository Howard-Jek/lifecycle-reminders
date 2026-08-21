import { withApiToken } from "@/lib/api/handler"
import { ok } from "@/lib/api/respond"
import { isDryRun } from "@/lib/env"
import { fetchPhoneNumberStatus } from "@/lib/notify/template-admin"

/**
 * GET /api/v1/whatsapp — the state of the number this deployment sends FROM.
 *
 * Diagnostic, and it earns its place: "#133010 Account not registered" is the
 * error that stops every send, and on its own it does not say WHICH account or
 * what to do. This answers both — which number is configured, and whether Meta
 * considers it registered for the Cloud API.
 *
 * Deployment-wide like the template: one platform number serves every tenant,
 * so caller.businessId scopes nothing here. It gates access, nothing more.
 */

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  return withApiToken(request, "whatsapp.status", async ({ caller }) => {
    void caller.businessId // read-only; the number is shared — see above.

    const accessToken = process.env.GOMA_NOTIFY_ACCESS_TOKEN?.trim()
    const phoneNumberId = process.env.GOMA_NOTIFY_PHONE_NUMBER_ID?.trim()

    if (!accessToken || !phoneNumberId) {
      return ok({
        configured: false,
        detail: "GOMA_NOTIFY_ACCESS_TOKEN or GOMA_NOTIFY_PHONE_NUMBER_ID is not set.",
      })
    }

    const status = await fetchPhoneNumberStatus(accessToken, phoneNumberId)
    if (!status.ok) return ok({ configured: true, ok: false, detail: status.error })

    return ok({
      configured: true,
      // The id is an identifier, not a credential — and seeing it is the point:
      // pointing at the wrong number is a real way to land on #133010 while the
      // dashboard shows a perfectly healthy number somewhere else.
      phone_number_id: phoneNumberId,
      display_phone_number: status.displayPhoneNumber,
      verified_name: status.verifiedName,
      status: status.status,
      platform_type: status.platformType,
      quality_rating: status.qualityRating,
      registered: status.registered,
      dry_run: isDryRun(),
      detail: status.registered
        ? "Registered for the Cloud API — sends should reach a handset."
        : "NOT registered for the Cloud API. Every send fails #133010 until this is done: " +
          "Meta -> WhatsApp -> API Setup -> register this number with your 6-digit PIN.",
    })
  })
}
