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

import type { SupabaseClient } from "@supabase/supabase-js"
import { appPublicUrl, isDryRun } from "@/lib/env"
import { describeWhatsappError } from "@/lib/whatsapp-errors"
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
    // Asks for a reply, because a delivery receipt proves the message reached a
    // handset and nothing more. A reply proves a person saw it AND that the
    // inbound half of the pipeline — webhook, signature, roster attribution —
    // works, which is the half no receipt can tell you about.
    suggestion:
      "This is a test from Lifecycle. Please REPLY to this message (anything at all) to confirm the connection — the app is waiting for it.",
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

// ── proving it arrived ──────────────────────────────────────────────────────

/**
 * How far a test message actually got.
 *
 * The send action can only report that META ACCEPTED the message, which is the
 * cheapest and least interesting fact about it: the Graph API returns 200 and a
 * message id for a number with no WhatsApp account, for a number Meta is
 * throttling, and for a template it will refuse to deliver. Everything that
 * makes a test worth running happens AFTERWARDS, as delivery receipts.
 *
 * So "Test sent — it should arrive in a few seconds; if it does not, that
 * number has no WhatsApp account" was wrong twice: it asserted success at the
 * one moment nothing had been proven, and it named the single least likely
 * cause. On this deployment the real answer was 131049 — Meta throttling for
 * engagement quality — and the operator was told to go and check a phone
 * number that was perfectly fine.
 */
export const TEST_STAGES = ["accepted", "sent", "delivered", "read", "replied"] as const
export type TestStage = (typeof TEST_STAGES)[number]

export const TEST_STAGE_LABELS: Record<TestStage, string> = {
  accepted: "Meta accepted the message",
  sent: "Meta sent it",
  delivered: "It reached the handset",
  read: "It was opened",
  replied: "They replied — the connection works both ways",
}

export type TestProgress = {
  /** The furthest stage reached, in TEST_STAGES order. */
  stage: TestStage
  /** Set when Meta refused it. The stage reached is where it stopped. */
  failure: { code: string | null; detail: string; title: string; action: string } | null
  /** True once a reply from that number has landed since the test was sent. */
  replied: boolean
}

/** Digits only, so "+65 8111 5611" and Meta's "6581115611" compare equal. */
function digits(value: string): string {
  return value.replace(/\D/g, "")
}

/**
 * Read what actually happened to a test send.
 *
 * Everything here is already recorded — recordStatusEvents keeps every receipt
 * and storeInboundMessages keeps every reply. This only asks the question, and
 * it asks it of the same tables the reminders inbox uses, so a test that
 * reports "delivered" is saying the same thing a real reminder would.
 */
export async function checkTestDelivery(
  admin: SupabaseClient,
  input: { wamid: string; number: string; sinceIso: string },
): Promise<TestProgress> {
  const { data: receipts } = await admin
    .from("whatsapp_status_events")
    .select("status, error, error_code")
    .eq("wamid", input.wamid)

  const rows = (receipts ?? []) as Array<{
    status: string
    error: string | null
    error_code: string | null
  }>
  const seen = new Set(rows.map((r) => r.status))
  const failed = rows.find((r) => r.status === "failed")

  // Replies are matched on the NUMBER rather than on the wamid: a WhatsApp
  // reply is a new message, not a threaded response, so it carries no reference
  // to what it is answering. Anything from that handset after the test went out
  // is the confirmation we asked for.
  const { data: inbound } = await admin
    .from("whatsapp_inbound_messages")
    .select("from_number, received_at")
    .eq("from_number", digits(input.number))
    .gt("received_at", input.sinceIso)

  const replied = (inbound ?? []).length > 0

  let stage: TestStage = "accepted"
  if (seen.has("sent")) stage = "sent"
  if (seen.has("delivered")) stage = "delivered"
  if (seen.has("read")) stage = "read"
  if (replied) stage = "replied"

  if (failed) {
    const info = describeWhatsappError(failed.error_code, failed.error)
    return {
      stage,
      replied,
      failure: {
        code: failed.error_code,
        detail: failed.error ?? "WhatsApp reported the message as failed",
        title: info.title,
        action: info.action,
      },
    }
  }

  return { stage, replied, failure: null }
}
