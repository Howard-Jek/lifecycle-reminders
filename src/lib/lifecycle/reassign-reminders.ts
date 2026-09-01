import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Point a contact's unsent reminders at whoever it is now assigned to.
 *
 * Must be called by EVERY path that changes `leads.assigned_member_id`, and
 * there are three: the contact page's dropdown, the import review queue, and
 * the v1 resolve endpoint. deliverOne resolves the recipient from
 * `reminders.member_id` — stamped when the row was materialised — and nothing
 * in the send path re-reads the assignment, so a path that skips this goes on
 * delivering to the PREVIOUS agent while every screen shows the new one.
 *
 * The rules about which rows move are in the migration, not here, because they
 * have to hold together atomically against a scheduler that claims rows every
 * fifteen minutes.
 *
 * NEVER THROWS, and never reports failure to the caller. By the time this runs
 * the assignment is already committed, so a failure here is not "the
 * assignment failed" — saying so would invite a retry that changes nothing and
 * would report an error for something that worked. It is loud in the log
 * instead, because the consequence is specific and invisible from the UI. The
 * function is idempotent and keyed on the current assignment, so the next
 * reassignment of the same contact repairs it.
 */
export async function reassignContactReminders(
  admin: SupabaseClient,
  businessId: string,
  leadId: string,
  memberId: string | null,
): Promise<{ moved: number; superseded: number }> {
  const { data, error } = await admin
    .rpc("reassign_contact_reminders", {
      p_business_id: businessId,
      p_lead_id: leadId,
      p_member_id: memberId,
    })
    .maybeSingle<{ moved: number; superseded: number }>()

  if (error) {
    console.error(
      `[reassign] agent changed on ${leadId} but its queued reminders did not move: ` +
        `${error.message}`,
    )
    return { moved: 0, superseded: 0 }
  }

  const result = { moved: data?.moved ?? 0, superseded: data?.superseded ?? 0 }
  if (result.moved > 0 || result.superseded > 0) {
    console.info(
      `[reassign] ${leadId}: ${result.moved} reminders moved, ${result.superseded} superseded`,
    )
  }
  return result
}
