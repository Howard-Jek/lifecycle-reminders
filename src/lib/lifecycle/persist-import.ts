/**
 * Persist the lifecycle side of a lead import: resolve event drafts to lead
 * ids, upsert `contact_events`, and apply agent attribution.
 *
 * Runs AFTER the lead upsert, because both halves key off `leads.id` which only
 * exists once the leads are in. Everything here is idempotent so a re-import of
 * the same sheet is a no-op rather than a pile of duplicates.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { ContactEventDraft } from "./extract-events"

const CHUNK = 500

export type PersistResult = {
  eventsUpserted: number
  leadsAssigned: number
}

export async function persistImportedLifecycle(
  admin: SupabaseClient,
  input: {
    businessId: string
    events: ContactEventDraft[]
    /** phone → member id, or null for unassigned. */
    assignmentByPhone: Map<string, string | null>
  },
): Promise<PersistResult> {
  const { businessId, events, assignmentByPhone } = input

  // Every phone we need an id for, from either half.
  const phones = Array.from(
    new Set([...events.map((e) => e.phone), ...assignmentByPhone.keys()]),
  )
  if (phones.length === 0) return { eventsUpserted: 0, leadsAssigned: 0 }

  const leadIdByPhone = await resolveLeadIds(admin, businessId, phones)

  const eventsUpserted = await upsertEvents(admin, businessId, events, leadIdByPhone)
  const leadsAssigned = await applyAssignments(admin, businessId, assignmentByPhone, leadIdByPhone)

  return { eventsUpserted, leadsAssigned }
}

/** phone → lead id, scoped to the tenant. Leads are unique on (business_id, phone). */
async function resolveLeadIds(
  admin: SupabaseClient,
  businessId: string,
  phones: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < phones.length; i += CHUNK) {
    const { data } = await admin
      .from("leads")
      .select("id, phone")
      .eq("business_id", businessId)
      .in("phone", phones.slice(i, i + CHUNK))
    for (const row of data ?? []) {
      out.set(row.phone as string, row.id as string)
    }
  }
  return out
}

async function upsertEvents(
  admin: SupabaseClient,
  businessId: string,
  events: ContactEventDraft[],
  leadIdByPhone: Map<string, string>,
): Promise<number> {
  const rows = events
    .map((e) => {
      const leadId = leadIdByPhone.get(e.phone)
      if (!leadId) return null
      return {
        business_id: businessId,
        lead_id: leadId,
        event_type: e.event_type,
        label: e.label,
        event_date: e.event_date,
        recurrence: e.recurrence,
        source: e.source,
        payload: e.payload,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  if (rows.length === 0) return 0

  let upserted = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    // ignoreDuplicates against the (lead_id, event_type, event_date, label)
    // key — a re-import of the same sheet changes nothing. The key is
    // NULLS NOT DISTINCT so unlabelled events dedupe too.
    const { data, error } = await admin
      .from("contact_events")
      .upsert(rows.slice(i, i + CHUNK), {
        onConflict: "lead_id,event_type,event_date,label",
        ignoreDuplicates: true,
      })
      .select("id")
    if (error) {
      console.error(`[lifecycle] contact_events upsert failed: ${error.message}`)
      continue
    }
    upserted += data?.length ?? 0
  }
  return upserted
}

/**
 * Apply agent attribution.
 *
 * Only writes a NON-null assignment. An unmatched or blank agent cell must not
 * clear an assignment the operator made by hand in the dashboard — a re-import
 * of a sheet whose agent column is stale would otherwise silently unassign a
 * whole book. Clearing stays an explicit dashboard action.
 */
async function applyAssignments(
  admin: SupabaseClient,
  businessId: string,
  assignmentByPhone: Map<string, string | null>,
  leadIdByPhone: Map<string, string>,
): Promise<number> {
  // Group by member so this is one UPDATE per agent, not per lead.
  const leadsByMember = new Map<string, string[]>()
  for (const [phone, memberId] of assignmentByPhone) {
    if (!memberId) continue
    const leadId = leadIdByPhone.get(phone)
    if (!leadId) continue
    const list = leadsByMember.get(memberId)
    if (list) list.push(leadId)
    else leadsByMember.set(memberId, [leadId])
  }

  let assigned = 0
  for (const [memberId, leadIds] of leadsByMember) {
    for (let i = 0; i < leadIds.length; i += CHUNK) {
      const { data, error } = await admin
        .from("leads")
        .update({ assigned_member_id: memberId })
        .eq("business_id", businessId)
        .in("id", leadIds.slice(i, i + CHUNK))
        .select("id")
      if (error) {
        console.error(`[lifecycle] assignment failed for member ${memberId}: ${error.message}`)
        continue
      }
      assigned += data?.length ?? 0
    }
  }
  return assigned
}
