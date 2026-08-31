/**
 * What a delivery receipt does to the reminder it belongs to.
 *
 * Extracted from the webhook route so it can be lifted whole. The route around
 * it is Meta's plumbing — one path, two verbs, a signature — and none of that
 * survives a move into a host application. This does.
 *
 * WHY THAT MATTERS, for whoever ports this into GomaAI:
 *
 * The monorepo has this gap open right now. Its `processStatusUpdate`
 * (src/lib/webhook/whatsapp.ts) handles sent/delivered/read/failed against the
 * `messages` table only, and src/lib/webhook/reminders.ts handles inbound
 * replies only. Nothing there updates `reminders`, so a reminder whose delivery
 * Meta refuses stays `sent` forever and never reaches Needs attention —
 * `whatsapp_status_events` exists in that schema with no writer at all.
 *
 * Wire this in as a sibling of the reminders reply fork, from the `failed` case
 * of processStatusUpdate. Two adjustments it will need there, and no more:
 *
 *   - the host's webhook is PER TENANT, so the business id is already known at
 *     the call site and the ownership lookup can be scoped to it;
 *   - it must not touch `messages`. These are different tables for different
 *     products, and a wamid belongs to exactly one of them.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { StatusEvent } from "@/lib/notify/webhook-events"
import {
  resolveFailedReceipt,
  RESOLVABLE_FROM_RECEIPT,
  type ReceiptOwner,
} from "@/lib/lifecycle/failed-receipt"

type Admin = SupabaseClient

/** Matches run-cycle's fallback, so the two paths date things the same way. */
const DEFAULT_TIMEZONE = "Asia/Singapore"

export type ReceiptOwners = Map<string, ReceiptOwner & { businessId: string }>

/**
 * Who owns each wamid in this payload, read once for the whole handler.
 *
 * Throws rather than returning an empty map on a read error: with no owners
 * nothing can be attributed, so every failure in the payload would be silently
 * dropped and Meta would never mention them again. The caller turns this into
 * a 500, which asks Meta to redeliver — the right trade, since the reason is
 * the only explanation of the failure that will ever exist.
 */
export async function loadReceiptOwners(admin: Admin, statuses: StatusEvent[]): Promise<ReceiptOwners> {
  if (statuses.length === 0) return new Map()

  // The embeds carry everything the retry decision needs, so deciding costs no
  // extra round trip inside Meta's ~20s budget. `businesses` is the tenant's
  // timezone because an occurrence date is a calendar date in THEIR zone;
  // `contact_events` is the event type, because a birthday is never retried.
  const { data, error } = await admin
    .from("reminders")
    .select(
      "id, business_id, status, attempts, occurrence_date, whatsapp_message_id, " +
        "contact_events(event_type), businesses(timezone)",
    )
    .in(
      "whatsapp_message_id",
      statuses.map((s) => s.wamid),
    )

  if (error) throw new Error(`resolving receipt owners: ${error.message}`)

  type OwnerRow = {
    id: string
    business_id: string
    status: string
    attempts: number
    occurrence_date: string
    whatsapp_message_id: string
    contact_events: { event_type: string } | null
    businesses: { timezone: string } | null
  }

  return new Map(
    ((data ?? []) as unknown as OwnerRow[]).map((r) => [
      r.whatsapp_message_id,
      {
        id: r.id,
        status: r.status,
        businessId: r.business_id,
        attempts: r.attempts,
        occurrenceDate: r.occurrence_date,
        eventType: r.contact_events?.event_type ?? null,
        // A missing tenant row cannot happen — business_id is NOT NULL with a
        // foreign key — but the embed is typed nullable, and guessing UTC here
        // would shift the "past the occurrence date" test by a day at +08:00.
        timezone: r.businesses?.timezone ?? DEFAULT_TIMEZONE,
      },
    ]),
  )
}

/**
 * Close the loop on sends Meta later rejected.
 *
 * This is the gap the webhook actually fills. The Graph call that queues a
 * message returns 200 with a message id long before Meta knows whether it can
 * be delivered — an invalid number, a blocked recipient or an expired template
 * all fail AFTERWARDS. Without this, `reminders` says `sent` forever and
 * "Needs attention" stays empty while nobody receives anything.
 *
 * Only `failed` is acted on. `delivered` and `read` are real signals but there
 * is nowhere to put them, and adding columns to record a state no screen shows
 * would be storage for its own sake.
 *
 * The decision itself is resolveFailedReceipt, in src/lib/lifecycle — pure, so
 * every race it arbitrates is tested without a stub. This is the plumbing.
 */
export async function recordFailedSends(
  admin: Admin,
  statuses: StatusEvent[],
  owners: ReceiptOwners,
): Promise<number> {
  let updated = 0

  for (const receipt of statuses) {
    const verdict = resolveFailedReceipt(receipt, owners.get(receipt.wamid) ?? null)

    if (verdict.action === "skip") {
      if (verdict.reason === "unowned") {
        // Kept as a warning, not an error. The receipt itself is safe in
        // whatsapp_status_events either way; this only says that no row could
        // be marked right now. See resolveFailedReceipt for why we do not
        // force a redelivery to chase it.
        console.warn(
          `[whatsapp-webhook] failure receipt for ${receipt.wamid} matched no reminder ` +
            `(sent outside the queue, or its wamid is not stamped yet): ` +
            `${receipt.error ?? "no reason given"}`,
        )
      } else if (verdict.reason === "already-resolved") {
        console.info(
          `[whatsapp-webhook] failure receipt for ${receipt.wamid} arrived after the row was ` +
            `resolved — leaving it alone`,
        )
      }
      continue
    }

    const { data, error } = await admin
      .from("reminders")
      .update({
        error: verdict.error,
        error_code: verdict.errorCode,
        ...(verdict.retryAt
          ? {
              status: "queued",
              next_attempt_at: verdict.retryAt,
              claimed_at: null,
              // Cleared, and load-bearing. requeueStuckClaims only rescues a
              // stuck row whose wamid is NULL — it reads a wamid as "the send
              // succeeded and only the bookkeeping failed". Leaving the old id
              // on a requeued row makes it unrescuable if the next attempt dies
              // mid-flight. The receipt keeps its own copy of the wamid in
              // whatsapp_status_events, so nothing is lost by dropping it here.
              whatsapp_message_id: null,
            }
          : { status: "failed" }),
      })
      .eq("id", verdict.reminderId)
      // Re-asserted at the write, not merely checked in the verdict above: the
      // row can move between the read and this update, and the whole point of
      // the predicate is that the later writer wins.
      .in("status", RESOLVABLE_FROM_RECEIPT)
      .select("id")

    if (error) throw new Error(`marking ${receipt.wamid} failed: ${error.message}`)

    updated += data?.length ?? 0
  }

  return updated
}


/**
 * Keep every receipt, not only the ones we act on.
 *
 * `sent`, `delivered` and `read` were previously parsed and dropped, on the
 * reasoning that no column and no screen wanted them. The cost of that showed
 * up the first time a message was accepted with a real id and never arrived:
 * nothing anywhere could say whether Meta had reported a thing. "No receipt
 * arrived" and "delivered, and we threw it away" looked identical, and the
 * difference was the whole diagnosis.
 *
 * Best-effort, and deliberately last: this is a record, and failing to write
 * one must never cost the caller the status update that ran beside it.
 */
export async function recordStatusEvents(
  admin: Admin,
  statuses: StatusEvent[],
  owners: ReceiptOwners,
): Promise<number> {
  if (statuses.length === 0) return 0

  // Attribution comes from the shared lookup. A test send matches nothing and
  // is still worth keeping — that is precisely the case that was impossible to
  // see before. So is a failure whose wamid is not stamped yet: the row write
  // has to wait, the record does not.
  const { data, error } = await admin.from("whatsapp_status_events").insert(
    statuses.map((s) => {
      const owner = owners.get(s.wamid)
      return {
        wamid: s.wamid,
        status: s.status,
        error: s.error,
        error_code: s.errorCode,
        recipient: s.recipient,
        reminder_id: owner?.id ?? null,
        business_id: owner?.businessId ?? null,
        occurred_at: s.occurredAt,
      }
    }),
  ).select("id")

  if (error) {
    console.error(`[whatsapp-webhook] could not record status events: ${error.message}`)
    return 0
  }
  return data?.length ?? 0
}

/**
 * How far back to look for a receipt that arrived before its reminder existed.
 *
 * Generous relative to the race it covers — that window is milliseconds — but
 * the sweep is cheap, and a bound is what stops it rescanning years of
 * permanently-unattributable receipts every fifteen minutes. Test sends and
 * messages from outside the queue never match a reminder, so without a horizon
 * they accumulate forever as work that can never complete.
 */
const ORPHAN_HORIZON_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Apply failure receipts that had no reminder to land on when they arrived.
 *
 * The gap this closes: `sendClientEventReminder` returns a wamid, and
 * `stampDelivered` writes it in the very next statement — but Meta can deliver
 * a failure callback in between. The webhook then finds no row owning that
 * wamid, and recordFailedSends correctly declines to guess, because a receipt
 * for an unknown wamid is indistinguishable from a test send or a message
 * from outside the queue.
 *
 * Declining to guess is only defensible if something looks again once the wamid
 * DOES exist. That was the argument in resolveFailedReceipt and, until this
 * function, it was a forward reference to nothing: `whatsapp_status_events` had
 * a writer and no reader anywhere, so the reason was kept in a row nobody read
 * while the reminder itself completed its send path and sat on `sent` forever —
 * the exact bug the webhook exists to prevent, surviving in the one race
 * everything else was written to handle.
 *
 * Idempotent by construction: it only considers receipts with a null
 * `reminder_id`, and stamps that column on everything it resolves, so a row is
 * examined once. Rows that never find an owner age out of the horizon instead.
 *
 * Best-effort. It runs at the top of the cycle and must never stop a delivery
 * run — a receipt that waits one more tick costs nothing, and this is a
 * recovery path, not the primary one.
 */
export async function attributeOrphanReceipts(admin: Admin, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - ORPHAN_HORIZON_MS).toISOString()

  const { data: orphans, error: readErr } = await admin
    .from("whatsapp_status_events")
    .select("id, wamid, status, error, error_code")
    .eq("status", "failed")
    .is("reminder_id", null)
    .gte("received_at", since)
    .limit(200)

  if (readErr) {
    console.error(`[reminder-receipts] orphan receipt sweep failed: ${readErr.message}`)
    return 0
  }
  if (!orphans || orphans.length === 0) return 0

  const statuses: StatusEvent[] = orphans.map((row) => ({
    wamid: row.wamid as string,
    status: "failed",
    error: (row.error as string | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    recipient: null,
    occurredAt: null,
  }))

  // Deliberately the SAME two functions the live path uses, so a receipt
  // recovered here is treated identically to one that arrived in time —
  // including the retry decision. A second implementation would drift.
  const owners = await loadReceiptOwners(admin, statuses)
  if (owners.size === 0) return 0

  const applied = await recordFailedSends(admin, statuses, owners)

  /**
   * Stamp the ones that found an owner, whether or not the reminder row was
   * still in a state worth updating.
   *
   * Attribution is a fact about the wamid and does not expire. If the reminder
   * has since moved on, the right outcome is still "we know whose this was, and
   * we are not going to look again" — otherwise every sweep re-reads it until
   * the horizon, and the sweep stops being idempotent in the way its own
   * `reminder_id IS NULL` filter promises.
   *
   * One statement per wamid rather than one per row: a message produces several
   * receipts and they all belong to the same reminder, so this is bounded by
   * distinct messages, not by events.
   */
  let stamped = 0
  for (const [wamid, owner] of owners) {
    const { error: stampErr } = await admin
      .from("whatsapp_status_events")
      .update({ reminder_id: owner.id, business_id: owner.businessId })
      .eq("wamid", wamid)
      .is("reminder_id", null)
    if (stampErr) {
      // Loud, because an unstamped receipt is re-swept every tick until the
      // horizon. Not fatal: recordFailedSends already did the work that
      // mattered, and its write is guarded against being applied twice.
      console.error(`[reminder-receipts] could not attribute ${wamid}: ${stampErr.message}`)
    } else {
      stamped++
    }
  }

  if (applied > 0 || stamped > 0) {
    console.warn(
      `[reminder-receipts] recovered ${applied} reminder(s) from ${stamped} late-attributed ` +
        `receipt(s) — these failures beat their own wamid being stamped`,
    )
  }

  return applied
}
