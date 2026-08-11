"use server"

import { revalidatePath } from "next/cache"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { parseCalendarDate } from "@/lib/sanitize"
import type { ActionResult } from "./team-members"

export type EventInput = {
  event_type: string
  event_date: string
  label?: string | null
  recurrence: "none" | "yearly"
}

function normalizeEventType(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

/**
 * Add a date by hand.
 *
 * `source: 'manual'` rather than 'import' so a re-import can never silently
 * overwrite something a person entered deliberately.
 */
export async function addContactEvent(
  contactId: string,
  input: EventInput,
): Promise<ActionResult> {
  const tenant = await requireTenant()
  const admin = createAdminClient()

  const eventType = normalizeEventType(input.event_type)
  if (!eventType) return { ok: false, error: "An event type is required." }

  // ISO here: the form uses <input type="date">, which always produces it.
  const date = parseCalendarDate(input.event_date, "YYYY-MM-DD")
  if (!date) return { ok: false, error: "That date could not be read." }

  // Confirm the contact belongs to this business before writing. The composite
  // FK would catch a mismatch too, but a sentence beats a 23503.
  const { data: contact } = await admin
    .from("leads")
    .select("id")
    .eq("id", contactId)
    .eq("business_id", tenant.businessId)
    .maybeSingle()
  if (!contact) return { ok: false, error: "That contact no longer exists." }

  const { error } = await admin.from("contact_events").insert({
    business_id: tenant.businessId,
    lead_id: contactId,
    event_type: eventType,
    label: input.label?.trim() || null,
    event_date: date,
    recurrence: input.recurrence,
    source: "manual",
  })

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "That contact already has this date recorded." }
    }
    return { ok: false, error: error.message }
  }

  revalidatePath(`/contacts/${contactId}`)
  return { ok: true }
}

export async function deleteContactEvent(
  contactId: string,
  eventId: string,
): Promise<ActionResult> {
  const tenant = await requireTenant()
  const { error } = await createAdminClient()
    .from("contact_events")
    .delete()
    .eq("id", eventId)
    .eq("business_id", tenant.businessId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(`/contacts/${contactId}`)
  return { ok: true }
}

/**
 * Assign (or unassign) a contact's agent.
 *
 * The manual counterpart to import attribution, and the way a review-queue row
 * gets resolved. Scoped by business_id on both sides; the composite FK on
 * leads.assigned_member_id makes a cross-tenant pairing impossible anyway.
 */
export async function assignContact(
  contactId: string,
  memberId: string | null,
): Promise<ActionResult> {
  const tenant = await requireTenant()
  const admin = createAdminClient()

  if (memberId) {
    const { data: member } = await admin
      .from("team_members")
      .select("id")
      .eq("id", memberId)
      .eq("business_id", tenant.businessId)
      .maybeSingle()
    if (!member) return { ok: false, error: "That team member no longer exists." }
  }

  const { data, error } = await admin
    .from("leads")
    .update({ assigned_member_id: memberId })
    .eq("id", contactId)
    .eq("business_id", tenant.businessId)
    .select("id")
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: "That contact no longer exists." }

  revalidatePath(`/contacts/${contactId}`)
  revalidatePath("/contacts")
  return { ok: true }
}
