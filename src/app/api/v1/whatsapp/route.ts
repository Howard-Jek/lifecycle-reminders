import { withApiToken } from "@/lib/api/handler"
import { ok } from "@/lib/api/respond"
import { isDryRun } from "@/lib/env"
import { fetchPhoneNumberStatus, fetchSubscribedApps } from "@/lib/notify/template-admin"

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

    const wabaId = process.env.GOMA_NOTIFY_WABA_ID?.trim()
    // Both in one wave: a number that can send and a webhook that reports back
    // are separate prerequisites, and each fails in a way that looks like the
    // other's problem.
    const [status, subs] = await Promise.all([
      fetchPhoneNumberStatus(accessToken, phoneNumberId),
      wabaId ? fetchSubscribedApps(accessToken, wabaId) : Promise.resolve(null),
    ])
    if (!status.ok) return ok({ configured: true, ok: false, detail: status.error })

    return ok({
      configured: true,
      // The id is an identifier, not a credential — and seeing it is the point:
      // pointing at the wrong number is a real way to land on #133010 while the
      // dashboard shows a perfectly healthy number somewhere else.
      phone_number_id: phoneNumberId,
      display_phone_number: status.displayPhoneNumber,
      verified_name: status.verifiedName,
      name_status: status.nameStatus,
      new_name_status: status.newNameStatus,
      status: status.status,
      platform_type: status.platformType,
      quality_rating: status.qualityRating,
      registered: status.registered,
      // Empty means Meta will never tell us how a send went: no delivery
      // receipts, no failure reasons, nothing in Needs attention. The handshake
      // passing says nothing about this.
      webhook_subscribed_apps: subs && subs.ok ? subs.subscribedApps : null,
      webhook_receiving: subs && subs.ok ? subs.subscribedApps.length > 0 : null,
      webhook_error: subs && !subs.ok ? subs.error : null,
      dry_run: isDryRun(),
      // Named separately because the remedies are unrelated: one is a PIN, the
      // other is a name Meta will accept.
      detail: status.registered
        ? "Ready — registered, on the Cloud API, and the display name is accepted."
        : status.newNameStatus && status.newNameStatus !== "NONE" && status.newNameStatus !== "APPROVED"
          ? `A new display name is with Meta (${status.newNameStatus}). Until it is approved the ` +
            `number still reports the old name "${status.verifiedName}" and sending stays ` +
            "restricted — that is expected, not a failed submission."
          : status.nameStatus === "DECLINED"
          ? `Display name "${status.verifiedName}" was DECLINED by Meta. Sending is restricted ` +
            "until a name is approved, and the Graph API still returns a message id for every " +
            "send — so messages are accepted and never delivered. Fix it in WhatsApp Manager -> " +
            "Phone numbers -> Profile -> Display name, using a name that matches the business."
          : status.nameStatus === "PENDING_REVIEW"
            ? `Display name "${status.verifiedName}" is awaiting Meta's review. Sending may be ` +
              "restricted until it is approved."
            : status.status !== "CONNECTED" || status.platformType !== "CLOUD_API"
              ? "NOT registered for the Cloud API. Every send fails #133010 until this is done: " +
                "Meta -> WhatsApp -> API Setup -> register this number with your 6-digit PIN."
              : "Not ready to send; see status, platform_type and name_status above.",
    })
  })
}
