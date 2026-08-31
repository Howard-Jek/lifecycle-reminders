"use server"

import { revalidatePath } from "next/cache"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { SEND_WINDOWS, type SendWindow } from "@/lib/types"
import type { ReminderRule } from "@/lib/lifecycle/types"
import { packForVertical } from "@/lib/lifecycle/vertical-packs"
import type { ActionResult } from "./team-members"

export async function listReminderRules(): Promise<ReminderRule[]> {
  const tenant = await requireTenant()
  const { data, error } = await createAdminClient()
    .from("reminder_rules")
    .select("*")
    .eq("business_id", tenant.businessId)
    .order("event_type")
    .order("offset_days", { ascending: false })
  if (error) {
    console.error("[reminder-rules] list failed:", error.message)
    return []
  }
  return (data ?? []) as ReminderRule[]
}

export type RuleInput = {
  event_type: string
  offset_days: number
  audience: "assigned" | "all_members"
  suggest_message: boolean
  send_window: SendWindow
  active: boolean
}

/**
 * `event_type` is free text by design — the engine is vertical-agnostic — so
 * the only normalisation is to snake_case, which keeps "Policy Expiry" and
 * "policy_expiry" from becoming two rules that both fire.
 */
function normalizeEventType(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

type RuleCheck = { ok: false; error: string } | { ok: true; eventType: string }

function validate(input: RuleInput): RuleCheck {
  const eventType = normalizeEventType(input.event_type)
  if (!eventType) return { ok: false, error: "An event type is required." }

  if (!Number.isInteger(input.offset_days)) {
    return { ok: false, error: "Lead time must be a whole number of days." }
  }
  // Mirrors reminder_rules_offset_range. Checked here too so the operator gets
  // a sentence rather than a constraint-violation string.
  if (input.offset_days < 0 || input.offset_days > 365) {
    return { ok: false, error: "Lead time must be between 0 and 365 days." }
  }
  if (input.audience !== "assigned" && input.audience !== "all_members") {
    return { ok: false, error: "Audience must be the assigned agent or the whole team." }
  }
  if (!SEND_WINDOWS.includes(input.send_window)) {
    return { ok: false, error: "Pick a valid send window." }
  }
  return { ok: true, eventType }
}

export async function createReminderRule(input: RuleInput): Promise<ActionResult> {
  const tenant = await requireTenant()
  const checked = validate(input)
  if (!checked.ok) return checked

  const { error } = await createAdminClient().from("reminder_rules").insert({
    business_id: tenant.businessId,
    event_type: checked.eventType,
    offset_days: input.offset_days,
    audience: input.audience,
    suggest_message: input.suggest_message,
    send_window: input.send_window,
    active: input.active,
  })

  if (error) {
    if (error.code === "23505") {
      return {
        ok: false,
        error: `There is already a rule for "${checked.eventType}" at ${input.offset_days} days.`,
      }
    }
    return { ok: false, error: error.message }
  }

  revalidatePath("/settings")
  return { ok: true }
}

export async function updateReminderRule(id: string, input: RuleInput): Promise<ActionResult> {
  const tenant = await requireTenant()
  const checked = validate(input)
  if (!checked.ok) return checked

  const { data, error } = await createAdminClient()
    .from("reminder_rules")
    .update({
      event_type: checked.eventType,
      offset_days: input.offset_days,
      audience: input.audience,
      suggest_message: input.suggest_message,
      send_window: input.send_window,
      active: input.active,
    })
    .eq("id", id)
    .eq("business_id", tenant.businessId)
    .select("id")
    .maybeSingle()

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "Another rule already covers that event type and lead time." }
    }
    return { ok: false, error: error.message }
  }
  if (!data) return { ok: false, error: "That rule no longer exists." }

  revalidatePath("/settings")
  return { ok: true }
}

/**
 * Deleting a rule cascades to its queued reminders, by design: a rule the
 * operator has removed should not keep firing. Reminders already SENT are
 * removed too — they are the record that the agent was told — so the UI warns,
 * and deactivating is offered as the non-destructive option.
 */
export async function deleteReminderRule(id: string): Promise<ActionResult> {
  const tenant = await requireTenant()
  const { error } = await createAdminClient()
    .from("reminder_rules")
    .delete()
    .eq("id", id)
    .eq("business_id", tenant.businessId)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/settings")
  return { ok: true }
}

/**
 * Seed this business's industry playbook.
 *
 * Data, not code: these land in reminder_rules as ordinary rows the operator
 * can edit or delete. Which rows depends on `businesses.vertical` — insurance
 * was only ever the first configuration of the engine, not its shape, and a
 * warranty expiry or a course certification is the same handful of rows with
 * different words and different offsets.
 *
 * A business with no industry chosen gets the generic pack, which is a complete
 * product rather than a placeholder.
 */
export async function seedStarterRules(): Promise<ActionResult<number>> {
  const tenant = await requireTenant()

  const admin = createAdminClient()
  const { data: business } = await admin
    .from("businesses")
    .select("vertical")
    .eq("id", tenant.businessId)
    .maybeSingle<{ vertical: string | null }>()

  const pack = packForVertical(business?.vertical)

  const rows = pack.rules.map((rule) => ({
    business_id: tenant.businessId,
    event_type: rule.event_type,
    offset_days: rule.offset_days,
    send_window: rule.send_window,
    audience: "assigned" as const,
    suggest_message: true,
    active: true,
  }))

  // ignoreDuplicates: seeding twice must not error, and must never overwrite a
  // rule the operator has since tuned.
  const { data, error } = await admin
    .from("reminder_rules")
    .upsert(rows, { onConflict: "business_id,event_type,offset_days", ignoreDuplicates: true })
    .select("id")

  if (error) {
    console.error("[reminder-rules] seed failed:", error.message)
    return { ok: false, error: error.message }
  }

  revalidatePath("/settings")
  return { ok: true, data: data?.length ?? 0 }
}
