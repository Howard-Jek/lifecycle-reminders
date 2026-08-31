/**
 * Platform notifications sender.
 *
 * A single owned WhatsApp number that sends AGENT-facing reminders. Because it
 * is one platform number rather than one per tenant, its credentials live in
 * env, and it sends approved *templates* so delivery is not bound by the 24-hour
 * freeform window.
 *
 * Deliberately keeps the host's module path, export names and signatures
 * (`getGomaSender` / `sendGomaTemplate`, and the `GOMA_NOTIFY_*` env pair), so
 * `client-event-reminder.ts` is byte-identical in both repos and integration
 * needs no credential change at all.
 */

import { GRAPH_API_VERSION } from "@/lib/whatsapp-graph-version"
import { isDryRun } from "@/lib/env"
import type { SendResult } from "@/lib/whatsapp"

export interface GomaSender {
  phoneNumberId: string
  accessToken: string
}

/**
 * Runtime credentials for the notifications number, or null when unconfigured.
 * Callers treat a null sender as "cannot deliver" and mark the reminder
 * `skipped` rather than burning its retry budget.
 */
export function getGomaSender(): GomaSender | null {
  const phoneNumberId = process.env.GOMA_NOTIFY_PHONE_NUMBER_ID?.trim()
  const accessToken = process.env.GOMA_NOTIFY_ACCESS_TOKEN?.trim()

  // Dry run stands in for the credentials it does not have, so every stage
  // upstream of the Graph call is exercisable before Meta approves the
  // template. src/lib/env.ts refuses this flag in production.
  if (isDryRun()) {
    return {
      phoneNumberId: phoneNumberId || "dry-run",
      accessToken: accessToken || "dry-run",
    }
  }

  if (!phoneNumberId || !accessToken) return null
  return { phoneNumberId, accessToken }
}

/**
 * Send a template from the platform number. `components` is Meta's template
 * component array. Never throws — a transport failure is a `SendResult`, so
 * the caller's claim/release bookkeeping always runs.
 */
export async function sendGomaTemplate(
  sender: GomaSender,
  to: string,
  templateName: string,
  language: string,
  components: Record<string, unknown>[],
): Promise<SendResult> {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: language },
      ...(components.length > 0 ? { components } : {}),
    },
  }

  if (isDryRun()) {
    // Log the exact payload rather than a summary: the whole point is to be
    // able to check the five body params render correctly before a real send.
    console.log(
      `[reminder-notify] DRY RUN — would send "${templateName}" to ${to}:`,
      JSON.stringify(payload, null, 2),
    )
    return { ok: true, whatsappMessageId: `dry-run:${crypto.randomUUID()}` }
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${sender.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sender.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    )

    const data = (await res.json().catch(() => null)) as
      | { error?: { message?: string; code?: number | string }; messages?: { id?: string }[] }
      | null

    if (!res.ok) {
      console.error(
        `[reminder-notify] template send failed (HTTP ${res.status}):`,
        JSON.stringify(data),
      )
      return {
        ok: false,
        error: data?.error?.message ?? "Unknown WhatsApp API error",
        statusCode: res.status,
        // Meta sends the code in the same object as the message and we used to
        // throw it away, which left the retry decision to a regex over prose.
        code: data?.error?.code === undefined ? null : String(data.error.code),
      }
    }

    const id = data?.messages?.[0]?.id
    if (!id) {
      return {
        ok: false,
        error: "No message ID in WhatsApp response",
        statusCode: null,
        code: null,
      }
    }
    return { ok: true, whatsappMessageId: id }
  } catch (e) {
    // A transport failure has no Meta code — nothing reached Meta.
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      statusCode: null,
      code: null,
    }
  }
}
