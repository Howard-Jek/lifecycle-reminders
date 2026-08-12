/**
 * The sandbox transcript.
 *
 * Records what the delivery path actually asked WhatsApp to send, so the
 * product can be demonstrated before a phone number and an approved template
 * exist. The rows are written from `run-cycle.ts` at the moment of a successful
 * send — same materialiser, same claim, same five params — so the sandbox shows
 * the real thing rather than a mock of it.
 *
 * Everything here is BEST-EFFORT and swallows its own errors, including a
 * missing table. That is the property that makes the feature deletable: at
 * integration you remove this directory, `supabase/migrations/*_sandbox.sql`
 * and the two call sites, and the delivery path is untouched.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { CLIENT_EVENT_REMINDER_BODY_TEXT } from "@/lib/notify/client-event-reminder"

export type SandboxRole = "system" | "agent" | "client"

export type SandboxMessage = {
  businessId: string
  fromRole: SandboxRole
  toRole: "agent" | "client"
  toNumber?: string | null
  body: string
  templateName?: string | null
  /** The positional body params, already clamped and sanitised as Meta gets them. */
  templateParams?: string[] | null
  reminderId?: string | null
  leadId?: string | null
}

export async function recordSandboxMessage(
  admin: SupabaseClient,
  message: SandboxMessage,
): Promise<void> {
  try {
    const { error } = await admin.from("sandbox_messages").insert({
      business_id: message.businessId,
      from_role: message.fromRole,
      to_role: message.toRole,
      to_number: message.toNumber ?? null,
      body: message.body,
      template_name: message.templateName ?? null,
      template_params: message.templateParams ?? null,
      reminder_id: message.reminderId ?? null,
      lead_id: message.leadId ?? null,
    })
    // Logged at debug, not error: on a deployment without the sandbox migration
    // this fires on every single delivery, and an unmissable log line for an
    // absent optional feature is just noise that trains people to ignore logs.
    if (error) console.debug(`[sandbox] not recorded: ${error.message}`)
  } catch (err) {
    console.debug(`[sandbox] not recorded: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Render the reminder template the way WhatsApp renders it on the handset.
 *
 * The copy is imported, never restated. It is the same string the registration
 * script submits to Meta, so what the sandbox shows is what Meta would render —
 * which is the only reason the sandbox counts as evidence.
 */
export function renderReminderBody(params: string[]): string {
  return CLIENT_EVENT_REMINDER_BODY_TEXT.replace(/\{\{(\d)\}\}/g, (_match, index) => {
    // 1-based in Meta's syntax. An out-of-range index leaves the placeholder
    // visible rather than substituting an empty string — a visibly broken
    // message is far easier to diagnose than a silently truncated one.
    const value = params[Number(index) - 1]
    return value === undefined ? `{{${index}}}` : value
  })
}
