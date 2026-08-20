import { withApiToken } from "@/lib/api/handler"
import { ok, badRequest } from "@/lib/api/respond"
import { isDryRun } from "@/lib/env"
import {
  readWhatsappCredentials,
  fetchTemplateStatus,
  submitTemplate,
  describeState,
} from "@/lib/notify/template-admin"
import {
  CLIENT_EVENT_REMINDER_TEMPLATE,
  CLIENT_EVENT_REMINDER_LANGUAGE,
} from "@/lib/notify/client-event-reminder"

/**
 * GET  /api/v1/template — where Meta's review has got to.
 * POST /api/v1/template — submit it for review.
 *
 * The Graph calls themselves already existed, driven by the Settings page.
 * This exposes the same two functions over HTTP so the whole path — submit,
 * poll until APPROVED, send a test — can be driven by a script or a CI job
 * without a browser and without anyone clicking through WhatsApp Manager.
 *
 * DEPLOYMENT-WIDE, NOT PER-TENANT. There is one platform WhatsApp number and
 * therefore one template, shared by every business on the deployment — see
 * template-admin.ts for why this add-on works that way. So `caller.businessId`
 * does not scope anything here; it is recorded on the submit path because a
 * write that affects every tenant should say who asked for it.
 */

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  return withApiToken(request, "template.status", async ({ caller }) => {
    void caller.businessId // read-only, and the template is shared; see above.

    const creds = readWhatsappCredentials()
    if (!creds) {
      // 200 with a state, not an error. "Not configured" is a legitimate
      // answer to "what state is the template in", and a poller should be able
      // to read it without special-casing a failure envelope.
      return ok({
        template: {
          name: CLIENT_EVENT_REMINDER_TEMPLATE,
          language: CLIENT_EVENT_REMINDER_LANGUAGE,
          state: "NOT_CONFIGURED",
          approved: false,
          detail:
            "GOMA_NOTIFY_WABA_ID and GOMA_NOTIFY_ACCESS_TOKEN are not set, so Meta cannot be asked.",
        },
        dry_run: isDryRun(),
      })
    }

    const status = await fetchTemplateStatus(creds)
    if (!status.ok) return ok({ template: { state: "UNKNOWN", approved: false, detail: status.error } })

    const described = describeState(status)
    return ok({
      template: {
        name: CLIENT_EVENT_REMINDER_TEMPLATE,
        language: CLIENT_EVENT_REMINDER_LANGUAGE,
        state: status.state,
        // The one field a polling script should branch on, so nobody has to
        // hardcode the set of Meta states that count as ready.
        approved: status.state === "APPROVED",
        category: status.category,
        rejected_reason: status.rejectedReason,
        language_mismatch: status.languageMismatch,
        headline: described.headline,
        detail: described.detail,
      },
      // Approved but dry-run still means nothing reaches a handset, which is
      // otherwise a genuinely baffling ten minutes.
      dry_run: isDryRun(),
    })
  })
}

export async function POST(request: Request) {
  return withApiToken(request, "template.submit", async ({ caller }) => {
    const creds = readWhatsappCredentials()
    if (!creds) {
      return badRequest(
        "WhatsApp is not configured — set GOMA_NOTIFY_WABA_ID and GOMA_NOTIFY_ACCESS_TOKEN",
      )
    }

    // Asked BEFORE submitting. Meta rejects a duplicate name with "Invalid
    // parameter" and explains itself only in error_user_msg, which reads like
    // the payload is malformed when in fact the work is already done.
    const before = await fetchTemplateStatus(creds)
    if (before.ok && before.state !== "NOT_SUBMITTED") {
      return ok({
        submitted: false,
        already: true,
        state: before.state,
        approved: before.state === "APPROVED",
        detail: describeState(before).detail,
      })
    }

    const result = await submitTemplate(creds)
    if (!result.ok) return badRequest(result.error)

    console.info(
      `[api/v1] template ${CLIENT_EVENT_REMINDER_TEMPLATE} submitted for review by business ${caller.businessId}`,
    )
    return ok({
      submitted: true,
      already: false,
      id: result.id,
      state: "PENDING",
      approved: false,
      detail:
        "In review with Meta — usually under an hour. Poll GET /api/v1/template until approved is true.",
    })
  })
}
