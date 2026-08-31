"use server"

import { revalidatePath } from "next/cache"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  applyReminderScope,
  scopeIsDeletable,
  scopeNeedsEventJoin,
  type ReminderScope,
} from "@/lib/lifecycle/reminder-filters"
import type { ActionResult } from "./team-members"

/**
 * Removing reminders by hand.
 *
 * Wanted because a queue is not self-cleaning: a backlog of historical dates
 * materialises into thousands of rows nobody will ever act on, and until now
 * the only way to remove them was a service-role script. An operator who cannot
 * clear their own inbox stops trusting it, and an inbox nobody trusts is
 * indistinguishable from one that does not work.
 *
 * These DELETE rather than mark. A reminder is derived data — the engine
 * rebuilds it from contact_events plus reminder_rules on the next cycle — so a
 * deleted queued row is a reset, not a loss. Sent rows are the exception worth
 * understanding: deleting one discards the record that a message went out, and
 * the confirmation copy says so.
 */

/** Never deletable, at any scope: a worker may be mid-send on it. */
const PROTECTED_STATUS = "claimed"

export async function deleteReminder(id: string): Promise<ActionResult> {
  const tenant = await requireTenant()
  const admin = createAdminClient()

  // business_id in the predicate, not merely checked first: this runs on the
  // service-role client, so the filter IS the tenant boundary.
  const { data, error } = await admin
    .from("reminders")
    .delete()
    .eq("id", id)
    .eq("business_id", tenant.businessId)
    .neq("status", PROTECTED_STATUS)
    .select("id")

  if (error) {
    console.error(`[reminders] delete ${id} failed: ${error.message}`)
    return { ok: false, error: "Could not remove that reminder." }
  }
  if (!data?.length) {
    // Absent, another tenant's, or claimed — one answer for all three. The
    // first two must be indistinguishable, and the third is genuinely "not
    // yours to delete right now".
    return { ok: false, error: "That reminder is no longer there, or is being sent right now." }
  }

  revalidatePath("/reminders")
  return { ok: true }
}

/**
 * Clear everything currently visible in a tab.
 *
 * Takes the same scope the page rendered, and applies it through the same
 * predicates, so the number on the button is the number that disappears. A
 * second implementation of "what is in this tab" would drift, and the drift
 * would show up as a bulk delete removing rows the operator never saw.
 */
export async function clearReminders(scope: ReminderScope): Promise<ActionResult<{ removed: number }>> {
  const tenant = await requireTenant()
  if (!scopeIsDeletable(scope)) return { ok: false, error: "That view cannot be cleared." }

  const admin = createAdminClient()

  /**
   * Resolved to ids first, then deleted by id.
   *
   * PostgREST cannot DELETE through an embedded filter, so a type-filtered
   * scope has no single-statement form. Selecting the ids under the exact same
   * predicates and deleting those keeps one definition of the scope, and keeps
   * the delete incapable of reaching a row the select would not have returned.
   */
  const columns = scopeNeedsEventJoin(scope)
    ? "id, contact_events!inner(event_type)"
    : "id"

  const { data: targets, error: selectError } = await applyReminderScope(
    admin.from("reminders").select(columns).eq("business_id", tenant.businessId),
    scope,
  ).limit(5000)

  if (selectError) {
    console.error(`[reminders] clear select failed: ${selectError.message}`)
    return { ok: false, error: "Could not work out what to remove." }
  }

  const ids = ((targets ?? []) as unknown as Array<{ id: string }>).map((r) => r.id)
  if (ids.length === 0) return { ok: true, data: { removed: 0 } }

  const { data, error } = await admin
    .from("reminders")
    .delete()
    .in("id", ids)
    .eq("business_id", tenant.businessId)
    .neq("status", PROTECTED_STATUS)
    .select("id")

  if (error) {
    console.error(`[reminders] clear failed: ${error.message}`)
    return { ok: false, error: "Could not remove those reminders." }
  }

  revalidatePath("/reminders")
  return { ok: true, data: { removed: data?.length ?? 0 } }
}
