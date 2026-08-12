"use server"

import { revalidatePath } from "next/cache"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { runReminderCycle, type CycleResult } from "@/lib/lifecycle/run-cycle"
import { recordSandboxMessage } from "@/lib/sandbox/record"
import type { ActionResult } from "./team-members"

/**
 * The sandbox: a place to watch the engine work before a phone number exists.
 *
 * The reminder half is not simulated — `runTickNow` calls the same
 * `runReminderCycle` the cron calls, and the transcript is written by the real
 * delivery path. The only fiction is the two handsets, which stand in for
 * messages that would otherwise leave the building.
 */

export type SandboxRow = {
  id: string
  from_role: "system" | "agent" | "client"
  to_role: "agent" | "client"
  to_number: string | null
  body: string
  template_name: string | null
  template_params: string[] | null
  reminder_id: string | null
  lead_id: string | null
  created_at: string
}

export async function listSandboxMessages(): Promise<SandboxRow[]> {
  const tenant = await requireTenant()
  const { data, error } = await createAdminClient()
    .from("sandbox_messages")
    .select("*")
    .eq("business_id", tenant.businessId)
    .order("created_at", { ascending: true })
    .limit(200)

  if (error) {
    // Almost always "relation does not exist" — the sandbox migration was not
    // applied. The page handles an empty list gracefully and says so.
    console.debug(`[sandbox] list failed: ${error.message}`)
    return []
  }
  return (data ?? []) as SandboxRow[]
}

/**
 * Run one reminder cycle on demand.
 *
 * Deliberately the *same* function the cron drives, not a demo variant. If this
 * button works, the cron works — there is no second code path that could be
 * green while the real one is broken.
 */
export async function runTickNow(): Promise<ActionResult<CycleResult>> {
  await requireTenant()
  try {
    const result = await runReminderCycle(createAdminClient())
    revalidatePath("/sandbox")
    revalidatePath("/reminders")
    return { ok: true, data: result }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[sandbox] tick failed:", message)
    return { ok: false, error: message }
  }
}

/**
 * The agent forwards something to the client.
 *
 * This is the human step the whole product exists to preserve: the engine
 * drafts, a person decides. The body is whatever they actually typed, so an
 * edited suggestion is what gets recorded.
 */
export async function sendAsAgent(input: {
  leadId: string | null
  body: string
}): Promise<ActionResult> {
  const tenant = await requireTenant()
  const body = input.body.trim()
  if (!body) return { ok: false, error: "Nothing to send." }
  if (body.length > 4000) return { ok: false, error: "That is longer than WhatsApp allows." }

  const admin = createAdminClient()

  let toNumber: string | null = null
  if (input.leadId) {
    // Scoped by business as well as id — a lead id from another tenant must not
    // resolve, even in a sandbox.
    const { data: lead } = await admin
      .from("leads")
      .select("phone")
      .eq("id", input.leadId)
      .eq("business_id", tenant.businessId)
      .maybeSingle<{ phone: string }>()
    if (!lead) return { ok: false, error: "That contact no longer exists." }
    toNumber = lead.phone
  }

  await recordSandboxMessage(admin, {
    businessId: tenant.businessId,
    fromRole: "agent",
    toRole: "client",
    toNumber,
    body,
    leadId: input.leadId,
  })

  revalidatePath("/sandbox")
  return { ok: true }
}

/** The client replies. Only meaningful in the sandbox — nothing in the real
 * product reads inbound messages yet. */
export async function replyAsClient(input: {
  leadId: string | null
  body: string
}): Promise<ActionResult> {
  const tenant = await requireTenant()
  const body = input.body.trim()
  if (!body) return { ok: false, error: "Nothing to send." }
  if (body.length > 4000) return { ok: false, error: "That is longer than WhatsApp allows." }

  await recordSandboxMessage(createAdminClient(), {
    businessId: tenant.businessId,
    fromRole: "client",
    toRole: "agent",
    body,
    leadId: input.leadId,
  })

  revalidatePath("/sandbox")
  return { ok: true }
}

/** Clear the transcript. The reminders themselves are untouched — this wipes
 * the demo, not the queue. */
export async function clearSandbox(): Promise<ActionResult> {
  const tenant = await requireTenant()
  const { error } = await createAdminClient()
    .from("sandbox_messages")
    .delete()
    .eq("business_id", tenant.businessId)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/sandbox")
  return { ok: true }
}

/**
 * Put every delivered reminder back in the queue so a demo can be replayed.
 *
 * Resets status, claim, attempts and the message id together. Clearing
 * `whatsapp_message_id` matters: the stuck-claim sweep treats a row that has
 * one as already delivered, so leaving it set would make a replayed row
 * un-redeliverable.
 */
export async function requeueAllReminders(): Promise<ActionResult<number>> {
  const tenant = await requireTenant()
  const { data, error } = await createAdminClient()
    .from("reminders")
    .update({
      status: "queued",
      claimed_at: null,
      sent_at: null,
      attempts: 0,
      whatsapp_message_id: null,
      error: null,
    })
    .eq("business_id", tenant.businessId)
    .in("status", ["sent", "failed", "skipped", "claimed"])
    .select("id")

  if (error) return { ok: false, error: error.message }
  revalidatePath("/sandbox")
  revalidatePath("/reminders")
  return { ok: true, data: data?.length ?? 0 }
}
