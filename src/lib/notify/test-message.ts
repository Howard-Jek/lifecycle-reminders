/**
 * "Does this agent's number actually receive anything?" — asked once, answered
 * on a real handset.
 *
 * A number is validated at save time (normalizePhone), but that only proves it
 * is *shaped* like a phone number. Every remaining way it can be wrong is
 * silent: the digits are a real number belonging to somebody else, or the
 * number has no WhatsApp account at all — which the Graph API accepts, returns
 * a message id for, and bills. The reminder then resolves to `sent` and lands
 * nowhere. That failure is invisible until a policy lapses.
 *
 * So the test send exists to make it visible, and it is deliberately the SAME
 * template through the SAME sender as a production reminder. A test that takes
 * a different path proves only that the different path works.
 *
 * ONE definition, two callers — the Team page button and
 * POST /api/v1/template/test-send. Two copies would drift, and the drift would
 * be exactly the thing under test.
 */

import { appPublicUrl, isDryRun } from "@/lib/env"
import { readWhatsappCredentials, fetchTemplateStatus } from "./template-admin"
import {
  sendClientEventReminder,
  type ReminderAlertParams,
} from "./client-event-reminder"

/** The roster row a test may be sent to. Nothing off the roster is sendable —
 * see the header of the API route for why that is a safety property. */
export type TestSendTarget = {
  id: string
  display_name: string
  whatsapp_number: string | null
}

export type TestSendOutcome =
  /** `to` is echoed back rather than re-read by the caller: what the UI should
   * report is the number the message was actually addressed to. */
  | { ok: true; to: string; whatsappMessageId: string; dryRun: boolean }
  | { ok: false; reason: "no_number" | "not_configured" | "send_failed"; error: string }

/**
 * What the handset shows.
 *
 * Unmistakably a test. A realistic-looking sample — "Jane Tan, policy expiry" —
 * is indistinguishable from a real reminder about a real client, and an agent
 * who acts on one will phone a customer about a policy that is not expiring.
 */
export function testMessageParams(): ReminderAlertParams {
  return {
    clientLabel: "Test Contact",
    eventLabel: "Test reminder",
    whenText: "today",
    suggestion:
      "This is a test message from Lifecycle. If you can read this, the template is approved and delivery works.",
    deepLink: `${appPublicUrl() || "https://lifecycle-app-tau.vercel.app"}/reminders`,
  }
}

/**
 * Send one test to one roster member.
 *
 * Never throws: every caller renders the outcome rather than a stack trace.
 */
export async function sendRosterTestMessage(target: TestSendTarget): Promise<TestSendOutcome> {
  if (!target.whatsapp_number) {
    return {
      ok: false,
      reason: "no_number",
      error: `${target.display_name} has no WhatsApp number on file.`,
    }
  }

  const to = target.whatsapp_number
  const result = await sendClientEventReminder(to, testMessageParams())

  if (result.ok) {
    // Dry run stamps a synthetic id and returns ok, so without carrying the
    // flag out the success is indistinguishable from a real delivery — and the
    // obvious conclusion ("it says sent, my phone says nothing") is wrong.
    return { ok: true, to, whatsappMessageId: result.whatsappMessageId, dryRun: isDryRun() }
  }

  if (result.reason === "not_configured") {
    return {
      ok: false,
      reason: "not_configured",
      error:
        "WhatsApp is not configured — set GOMA_NOTIFY_PHONE_NUMBER_ID and GOMA_NOTIFY_ACCESS_TOKEN.",
    }
  }

  return { ok: false, reason: "send_failed", error: await explainSendFailure(result.error) }
}

/**
 * Turn a Meta send error into an answer rather than a search.
 *
 * Their codes are famously unhelpful in isolation: #132001 says "template does
 * not exist" whether it was never submitted, is still in review, or exists in a
 * different LANGUAGE. One extra Graph call names which.
 *
 * Only ever runs on the failure path, so the cost is paid by the request that
 * already went wrong.
 */
async function explainSendFailure(error: string | undefined): Promise<string> {
  const base = `WhatsApp rejected the send: ${error ?? "unknown error"}`
  const creds = readWhatsappCredentials()
  if (!creds) return base

  const status = await fetchTemplateStatus(creds)
  return status.ok ? `${base} (template state: ${status.state})` : base
}
