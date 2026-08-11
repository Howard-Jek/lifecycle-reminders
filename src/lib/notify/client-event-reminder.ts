/**
 * Lifecycle reminder alert: WhatsApp an AGENT that one of their clients has a
 * date coming up, with a suggested message they can send.
 *
 * Same shape and reasoning as operator-alert.ts — a template from the Goma
 * platform number, so it delivers regardless of the 24h window, with the deep
 * link as a BODY variable rather than a URL button (Meta bakes a button's
 * domain in at approval time, a body variable is assembled at send time, so one
 * approved template works across ngrok / staging / prod).
 *
 * Recipient is the AGENT, never the client. Nothing here messages a lead.
 */

import { GRAPH_API_VERSION } from "@/lib/whatsapp-graph-version"
import { getGomaSender, sendGomaTemplate } from "./goma-sender"
import type { SendResult } from "@/lib/whatsapp"

export const CLIENT_EVENT_REMINDER_TEMPLATE = "client_event_reminder"
export const CLIENT_EVENT_REMINDER_LANGUAGE = "en"

const SUGGESTION_MAX = 600

/** Meta rejects body params containing newlines, tabs, or >4 consecutive
 * spaces — and an AI-drafted suggestion will contain all three. */
function sanitizeParam(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function clamp(value: string, max: number): string {
  const cleaned = sanitizeParam(value)
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned
}

/** Absolute deep link to the lead, built at send time from the runtime origin. */
export function reminderDeepLink(baseUrl: string, leadId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/dashboard?lead=${leadId}`
}

/** Human phrasing for the lead time — "today" reads far better than "in 0 days". */
export function describeLeadTime(daysUntil: number): string {
  if (daysUntil <= 0) return "today"
  if (daysUntil === 1) return "tomorrow"
  if (daysUntil === 7) return "in a week"
  if (daysUntil % 7 === 0 && daysUntil <= 28) return `in ${daysUntil / 7} weeks`
  if (daysUntil === 30 || daysUntil === 31) return "in a month"
  return `in ${daysUntil} days`
}

export type ReminderAlertParams = {
  /** "Jane Tan" — the client this is about. */
  clientLabel: string
  /** "Policy expiry" / "Birthday" — already humanised by the caller. */
  eventLabel: string
  /** Rendered by describeLeadTime. */
  whenText: string
  /** AI-drafted message, or a fallback line when drafting was skipped/failed. */
  suggestion: string
  deepLink: string
}

export function buildReminderComponents(p: ReminderAlertParams): Record<string, unknown>[] {
  return [
    {
      type: "body",
      parameters: [
        { type: "text", text: clamp(p.clientLabel, 80) },
        { type: "text", text: clamp(p.eventLabel, 60) },
        { type: "text", text: clamp(p.whenText, 40) },
        { type: "text", text: clamp(p.suggestion, SUGGESTION_MAX) },
        { type: "text", text: p.deepLink },
      ],
    },
  ]
}

export type ReminderAlertResult =
  | { ok: true; whatsappMessageId: string }
  | { ok: false; reason: "not_configured" | "send_failed"; error?: string }

/**
 * Send one reminder to one agent's number. Never throws — the caller records
 * the outcome on the reminder row, and a missing Goma config is a skip rather
 * than a crash (matching sendOperatorAlert).
 */
export async function sendClientEventReminder(
  to: string,
  params: ReminderAlertParams,
): Promise<ReminderAlertResult> {
  const sender = getGomaSender()
  if (!sender) return { ok: false, reason: "not_configured" }

  let res: SendResult
  try {
    res = await sendGomaTemplate(
      sender,
      to,
      CLIENT_EVENT_REMINDER_TEMPLATE,
      CLIENT_EVENT_REMINDER_LANGUAGE,
      buildReminderComponents(params),
    )
  } catch (e) {
    return { ok: false, reason: "send_failed", error: e instanceof Error ? e.message : String(e) }
  }

  if (!res.ok) return { ok: false, reason: "send_failed", error: res.error }
  return { ok: true, whatsappMessageId: res.whatsappMessageId }
}

/**
 * Canonical Meta create-template payload — the source of truth for this
 * template's shape. Registered once on the Goma WABA, like the operator alert.
 * No URL is baked in: the link is body variable {{5}}, filled per send.
 */
export function clientEventReminderTemplateDefinition(): Record<string, unknown> {
  return {
    name: CLIENT_EVENT_REMINDER_TEMPLATE,
    language: CLIENT_EVENT_REMINDER_LANGUAGE,
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text:
          "📅 {{1}} — {{2}} {{3}}.\n\nSuggested message:\n{{4}}\n\nOpen the client: {{5}}\n\nSend it from the dashboard, or copy and send it yourself.",
        example: {
          body_text: [
            [
              "Jane Tan",
              "Policy expiry",
              "in a month",
              "Hi Jane, just a heads up that your policy is up for renewal next month — happy to walk you through the options if useful.",
              "https://app.example.com/dashboard?lead=00000000-0000-0000-0000-000000000000",
            ],
          ],
        },
      },
    ],
  }
}

/** Submit the template to the Goma WABA for approval. One-time setup, mirrors
 * registerOperatorAlertTemplate. */
export async function registerClientEventReminderTemplate(config: {
  wabaId: string
  accessToken: string
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.wabaId}/message_templates`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(clientEventReminderTemplateDefinition()),
    },
  )
  const data = (await res.json().catch(() => null)) as
    | { id?: string; error?: { message?: string } }
    | null
  if (!res.ok) return { ok: false, error: data?.error?.message ?? "Unknown error" }
  return { ok: true, id: data?.id ?? "" }
}
