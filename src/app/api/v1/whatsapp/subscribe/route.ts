import { withApiToken } from "@/lib/api/handler"
import { ok, badRequest } from "@/lib/api/respond"
import { subscribeApp, fetchSubscribedApps } from "@/lib/notify/template-admin"

/**
 * POST /api/v1/whatsapp/subscribe — start receiving webhooks.
 *
 * Verifying the callback URL and subscribing to the WABA's events are separate
 * steps, and only the first is visible in the dashboard as a green tick. Skip
 * the second and Meta accepts every send, hands back a real message id, and
 * never says another word about it — no delivered, no failed, no reason.
 *
 * For this product that is the worst available state: the whole premise is that
 * a reminder nobody received should show up in Needs attention, and an
 * unsubscribed webhook means nothing ever does.
 */

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  return withApiToken(request, "whatsapp.subscribe", async ({ caller }) => {
    const accessToken = process.env.GOMA_NOTIFY_ACCESS_TOKEN?.trim()
    const wabaId = process.env.GOMA_NOTIFY_WABA_ID?.trim()
    if (!accessToken || !wabaId) {
      return badRequest("GOMA_NOTIFY_ACCESS_TOKEN or GOMA_NOTIFY_WABA_ID is not set")
    }

    const result = await subscribeApp(accessToken, wabaId)
    if (!result.ok) return badRequest(`Meta refused the subscription: ${result.error}`)

    console.info(`[api/v1] subscribed to WABA webhooks, requested by ${caller.businessId}`)

    // Read it back rather than trusting the 200. Meta returning success and the
    // subscription list still being empty is precisely the confusion this
    // endpoint exists to end.
    const subs = await fetchSubscribedApps(accessToken, wabaId)
    return ok({
      subscribed: true,
      apps: subs.ok ? subs.subscribedApps : null,
      receiving: subs.ok ? subs.subscribedApps.length > 0 : null,
      detail: subs.ok && subs.subscribedApps.length > 0
        ? "Subscribed. Delivery receipts and replies will now reach /api/webhooks/whatsapp."
        : "Meta accepted the subscription but reports no subscribed apps yet — re-check " +
          "GET /api/v1/whatsapp, and confirm the 'messages' field is ticked in the dashboard.",
    })
  })
}
