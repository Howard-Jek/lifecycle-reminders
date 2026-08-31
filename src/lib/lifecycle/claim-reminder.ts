/**
 * Atomic claim/resolve for reminder rows.
 *
 * Same discipline as src/lib/reply-claim.ts, applied to a queue table instead
 * of a message: win the row with a conditional UPDATE *before* doing anything
 * observable, so two overlapping cron runs can never send the same agent the
 * same reminder twice.
 *
 * `.eq("status", "queued")` is what makes it atomic — Postgres serialises the
 * two updates, so exactly one run sees a row affected and the loser gets none.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { ReminderStatus } from "./types"
import { MAX_ATTEMPTS } from "./retry-policy"
import { PERSONAL_EVENT_TYPES } from "./event-types"

/**
 * Try to take ownership of a reminder. True = this run owns it and must resolve
 * it; false = another run got there first, skip silently.
 *
 * `attempts` is incremented on claim rather than on failure so a run that dies
 * mid-delivery still burns an attempt — otherwise a row that reliably crashes
 * the worker would be retried forever.
 */
export async function claimReminder(
  admin: SupabaseClient,
  reminderId: string,
  currentAttempts: number,
): Promise<boolean> {
  // attempts is set in the SAME update as the claim. No read-modify-write race
  // is possible because the `status = 'queued'` predicate means only one run
  // ever reaches this row, and that run already knows the value it read.
  const { data, error } = await admin
    .from("reminders")
    .update({
      status: "claimed",
      claimed_at: new Date().toISOString(),
      attempts: currentAttempts + 1,
    })
    .eq("id", reminderId)
    .eq("status", "queued")
    .select("id")
    .maybeSingle()

  if (error) {
    console.error(`[lifecycle] claim failed for reminder ${reminderId}: ${error.message}`)
    return false
  }
  return !!data
}

/**
 * Hand a claimed reminder back.
 *
 * Defaults to 'queued' so the next run retries (bounded by MAX_ATTEMPTS in the
 * task). Pass 'skipped' for permanently unresolvable rows — a deleted lead, no
 * recipient number, notifications not configured — so they stop consuming
 * attempts and stop appearing as failures.
 */
export async function releaseReminder(
  admin: SupabaseClient,
  reminderId: string,
  error: string,
  status: Extract<ReminderStatus, "queued" | "failed" | "skipped"> = "queued",
  suggestion?: string,
  /**
   * When this row may be tried again. Written on EVERY release, including as
   * null — a row requeued without a wait must clear whatever an earlier failure
   * scheduled, or it inherits a delay nobody asked for and looks stuck.
   */
  nextAttemptAt: string | null = null,
): Promise<void> {
  const { error: updateErr } = await admin
    .from("reminders")
    .update({
      status,
      claimed_at: null,
      error: error.slice(0, 500),
      next_attempt_at: nextAttemptAt,
      ...(suggestion ? { suggestion } : {}),
    })
    .eq("id", reminderId)

  if (updateErr) {
    // Leaves the row 'claimed', which the stuck-claim sweep below reclaims.
    console.error(`[lifecycle] release failed for reminder ${reminderId}: ${updateErr.message}`)
  }
}

/**
 * Stamp the WhatsApp message id the instant the send succeeds, BEFORE any other
 * bookkeeping.
 *
 * This exists so `requeueStuckClaims`' "already delivered" guard is real. If the
 * wamid were only written as part of the status flip (as it was), then the one
 * scenario the guard is for — that write failing — leaves wamid NULL, the guard
 * matches, and the sweep re-delivers. The guard was inert.
 */
export async function stampDelivered(
  admin: SupabaseClient,
  reminderId: string,
  whatsappMessageId: string,
): Promise<void> {
  const { error } = await admin
    .from("reminders")
    .update({ whatsapp_message_id: whatsappMessageId })
    .eq("id", reminderId)
  if (error) {
    // Worst case we are back to the old behaviour for this row: a duplicate is
    // possible. Loud, because the message HAS gone out.
    console.error(
      `[lifecycle] could not stamp wamid on ${reminderId} — a retry may duplicate: ${error.message}`,
    )
  }
}

/** Record a delivered reminder. */
export async function markReminderSent(
  admin: SupabaseClient,
  reminderId: string,
  whatsappMessageId: string,
  suggestion: string,
): Promise<boolean> {
  const { error } = await admin
    .from("reminders")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      whatsapp_message_id: whatsappMessageId,
      suggestion,
      error: null,
      // Cleared with the error it belonged to. A delivered row carrying a
      // scheduled retry is a contradiction, and the webhook can still move it
      // back to 'failed' later — from where it is re-scheduled afresh.
      next_attempt_at: null,
    })
    .eq("id", reminderId)

  if (error) {
    console.error(`[lifecycle] mark-sent failed for reminder ${reminderId}: ${error.message}`)
    return false
  }
  return true
}

/**
 * Requeue reminders stuck in 'claimed'.
 *
 * The claim→send window is one HTTP call, so a row sitting claimed for this
 * long means the worker died inside it. Without this the row is invisible
 * forever: it is no longer 'queued', so the delivery query skips it. Mirrors
 * sweep-stuck-reply-claims, and the same caveat applies — we cannot tell
 * "died before the send" from "died after", so the attempts cap is what
 * ultimately stops a repeatedly-crashing row.
 */
export async function requeueStuckClaims(
  admin: SupabaseClient,
  olderThanMinutes = 30,
  // Derived, not a second copy. This default was 3 while the delivery query
  // capped at 4: only the fact that runReminderCycle passes the value
  // explicitly kept the two from disagreeing, which is not a guarantee.
  maxAttempts = MAX_ATTEMPTS,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString()

  // Rows that died on their LAST attempt must not be requeued: the delivery
  // query filters `attempts < maxAttempts`, so requeueing them just moves the
  // zombie from 'claimed' to 'queued' where it is equally invisible. Give them
  // the terminal state instead.
  /**
   * Personal dates do not come back from a crash either.
   *
   * planRetry refuses to reschedule a birthday, but that only governs the
   * FAILURE path — this sweep requeued any stuck row on the attempts cap alone,
   * whatever the date was about. So a birthday whose worker died was quietly
   * redelivered on the next tick, and after a longer outage the greeting went
   * out days late: the exact "late is worse than never" outcome the policy
   * exists to prevent, reached by the one path that never consulted it.
   *
   * Resolved to 'failed' first, so the requeue pass below no longer matches
   * them. The embed is `!inner` here on purpose — unlike the delivery query,
   * this one WANTS to consider only rows whose event still exists.
   */
  const { data: personal, error: personalErr } = await admin
    .from("reminders")
    .select("id, contact_events!inner(event_type)")
    .eq("status", "claimed")
    .lt("claimed_at", cutoff)
    .is("whatsapp_message_id", null)
    .in("contact_events.event_type", [...PERSONAL_EVENT_TYPES])
  if (personalErr) {
    console.error(`[lifecycle] personal stuck-claim sweep failed: ${personalErr.message}`)
  } else if (personal && personal.length > 0) {
    const { error } = await admin
      .from("reminders")
      .update({
        status: "failed",
        claimed_at: null,
        error: "Delivery was interrupted, and a personal date is not sent late.",
      })
      .in(
        "id",
        personal.map((r) => r.id as string),
      )
    if (error) {
      console.error(`[lifecycle] personal stuck-claim resolve failed: ${error.message}`)
    } else {
      console.warn(`[lifecycle] ${personal.length} interrupted personal reminders not retried`)
    }
  }

  const { error: exhaustErr } = await admin
    .from("reminders")
    .update({
      status: "failed",
      claimed_at: null,
      error: "Worker stopped mid-delivery and no attempts remain.",
    })
    .eq("status", "claimed")
    .lt("claimed_at", cutoff)
    .is("whatsapp_message_id", null)
    .gte("attempts", maxAttempts)
  if (exhaustErr) {
    console.error(`[lifecycle] exhausted-claim sweep failed: ${exhaustErr.message}`)
  }
  const { data, error } = await admin
    .from("reminders")
    .update({ status: "queued", claimed_at: null })
    .eq("status", "claimed")
    .lt("claimed_at", cutoff)
    // A wamid means the WhatsApp send SUCCEEDED and only the bookkeeping write
    // failed. Requeueing such a row would deliver the same reminder to the
    // agent a second time — the likelier duplicate path than any concurrency
    // race, since the claim already rules that out. Only meaningful because
    // stampDelivered writes the wamid separately, before the status flip.
    .is("whatsapp_message_id", null)
    .lt("attempts", maxAttempts)
    .select("id")

  if (error) {
    console.error(`[lifecycle] stuck-claim sweep failed: ${error.message}`)
    return 0
  }
  return data?.length ?? 0
}
