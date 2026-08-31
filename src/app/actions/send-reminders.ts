"use server"

import { revalidatePath } from "next/cache"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { runReminderCycle } from "@/lib/lifecycle/run-cycle"
import {
  applyReminderScope,
  scopeNeedsEventJoin,
  type ReminderScope,
} from "@/lib/lifecycle/reminder-filters"
import { MAX_PER_CLICK } from "@/lib/lifecycle/send-limits"
import type { ActionResult } from "./team-members"

/**
 * Sending on purpose, rather than on a timer.
 *
 * Two separate needs, and they are not the same button:
 *
 *   - Send ONE. An operator looking at a single reminder decides it should go
 *     now — the agent asked for it, or a failure has been fixed.
 *   - Send a TAB. The backlog in "Needs attention" or "Due" should go out in
 *     one shot rather than one click at a time.
 *
 * Both bypass `businesses.auto_send_enabled`, because that flag governs the
 * SCHEDULER. "Automatic sending is off" is a policy about unattended sending,
 * not a lock on the account, and an operator who cannot send the thing they are
 * looking at would rightly read the switch as broken.
 *
 * Both go through `runReminderCycle` — the same function the cron drives — so a
 * message sent from a button is byte-identical to one sent on a schedule. A
 * second delivery path would be a second thing to keep correct.
 */



export type SendOutcome = {
  sent: number
  failed: number
  /** Passed over untouched — their agent is deactivated. */
  heldInactive: number
  /** Still queued after this click, because of MAX_PER_CLICK. */
  remaining: number
}

/**
 * Put a reminder back in the queue so it can be delivered again.
 *
 * A `failed` row has burnt its attempts and carries a stale error and, if Meta
 * ever accepted it, a message id. Clearing all three together matters: the
 * stuck-claim sweep treats a row that still has a `whatsapp_message_id` as
 * already delivered, so leaving it set makes the row permanently un-sendable.
 */
async function requeue(
  admin: ReturnType<typeof createAdminClient>,
  businessId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0
  const { data, error } = await admin
    .from("reminders")
    .update({
      status: "queued",
      claimed_at: null,
      sent_at: null,
      attempts: 0,
      whatsapp_message_id: null,
      error: null,
    })
    .in("id", ids)
    .eq("business_id", businessId)
    // Never a row a worker is mid-send on: requeueing it would send a second
    // copy of a message that may already be on a handset.
    .neq("status", "claimed")
    .select("id")

  if (error) throw new Error(error.message)
  return data?.length ?? 0
}

/** Which of these reminders are addressed to a deactivated agent. */
async function heldForInactiveAgent(
  admin: ReturnType<typeof createAdminClient>,
  businessId: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const { data } = await admin
    .from("reminders")
    .select("id, team_members!inner(active)")
    .in("id", ids)
    .eq("business_id", businessId)
    .eq("team_members.active", false)
  return new Set((data ?? []).map((r) => r.id as string))
}

/** Deliver exactly these ids and report what happened. */
async function deliver(
  admin: ReturnType<typeof createAdminClient>,
  businessId: string,
  ids: string[],
): Promise<SendOutcome> {
  const held = await heldForInactiveAgent(admin, businessId, ids)
  const sendable = ids.filter((id) => !held.has(id))

  if (sendable.length === 0) {
    return { sent: 0, failed: 0, heldInactive: held.size, remaining: 0 }
  }

  const batch = sendable.slice(0, MAX_PER_CLICK)
  await requeue(admin, businessId, batch)

  const result = await runReminderCycle(admin, "manual", {
    reminderIds: batch,
    maxDeliveries: MAX_PER_CLICK,
  })

  revalidatePath("/reminders")
  return {
    sent: result.sent,
    failed: result.failed,
    heldInactive: held.size,
    remaining: sendable.length - batch.length,
  }
}

/** Send one reminder now. */
export async function sendReminderNow(id: string): Promise<ActionResult<SendOutcome>> {
  const tenant = await requireTenant()
  const admin = createAdminClient()

  // Scoped by business in the predicate, not merely checked: this is the
  // service-role client, so the filter IS the tenant boundary.
  const { data: row } = await admin
    .from("reminders")
    .select("id, status")
    .eq("id", id)
    .eq("business_id", tenant.businessId)
    .maybeSingle<{ id: string; status: string }>()

  if (!row) return { ok: false, error: "That reminder is no longer there." }
  if (row.status === "claimed") {
    return { ok: false, error: "That reminder is being sent right now." }
  }

  try {
    return { ok: true, data: await deliver(admin, tenant.businessId, [row.id]) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[send-reminders] single send ${id} failed: ${message}`)
    return { ok: false, error: "Could not send that reminder. Nothing was charged for it." }
  }
}

/**
 * Send everything the current tab is showing.
 *
 * Built from `applyReminderScope`, the same predicates the list and the count
 * use, so the number on the button is the number that goes out. Two copies of
 * this logic would be a bulk SPEND whose scope drifts from the count beside it.
 */
export async function sendScopeNow(scope: ReminderScope): Promise<ActionResult<SendOutcome>> {
  const tenant = await requireTenant()

  // Only the two tabs that hold sendable work. "Sent" would re-send messages
  // that already arrived; "Upcoming" is not due yet, and sending it early is a
  // different decision from sending a backlog.
  if (scope.tab !== "due" && scope.tab !== "attention") {
    return { ok: false, error: "Only Due and Needs attention can be sent in bulk." }
  }

  const admin = createAdminClient()

  const columns = scopeNeedsEventJoin(scope) ? "id, contact_events!inner(event_type)" : "id"

  const { data, error } = await applyReminderScope(
    admin.from("reminders").select(columns).eq("business_id", tenant.businessId),
    scope,
  ).limit(5000)

  if (error) {
    console.error(`[send-reminders] scope fetch failed: ${error.message}`)
    return { ok: false, error: "Could not work out what to send." }
  }

  // Through `unknown`: the select-string branch above widens the row type past
  // what the overload can infer. Same shape as clearReminders.
  const ids = ((data ?? []) as unknown as Array<{ id: string }>).map((r) => r.id)
  if (ids.length === 0) return { ok: false, error: "There is nothing here to send." }

  try {
    return { ok: true, data: await deliver(admin, tenant.businessId, ids) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[send-reminders] bulk send failed: ${message}`)
    return { ok: false, error: "Could not send these. Some may have gone out before it stopped." }
  }
}

/**
 * Turn the scheduler on or off for this business.
 *
 * The flag the cycle reads before it does anything — see the migration and
 * deliverDue. Off is the default and the safe direction: with it off, a tick
 * costs one query and sends nothing.
 */
export async function setAutoSend(enabled: boolean): Promise<ActionResult> {
  const tenant = await requireTenant()

  const { data, error } = await createAdminClient()
    .from("businesses")
    .update({ auto_send_enabled: enabled })
    .eq("id", tenant.businessId)
    .select("id")
    .maybeSingle()

  if (error) {
    console.error(`[send-reminders] auto-send toggle failed: ${error.message}`)
    return { ok: false, error: "Could not change that setting." }
  }
  if (!data) return { ok: false, error: "Business not found." }

  revalidatePath("/reminders")
  revalidatePath("/settings")
  return { ok: true }
}
