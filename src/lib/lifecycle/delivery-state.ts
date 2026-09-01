/**
 * What Meta reported about a message, for a screen to show.
 *
 * `reminders.status` answers "did we send it", which is our side of the story
 * and the smaller half. Whether it ARRIVED, whether anyone opened it, and why
 * it failed are Meta's side, and they have been landing in
 * whatsapp_status_events since that table was added — every receipt, with its
 * error and its timestamp — read by nothing.
 *
 * The original reasoning for not acting on `delivered` and `read` was that
 * there was "nowhere to put them, and adding columns to record a state no
 * screen shows would be storage for its own sake". That was right, and it
 * stopped being right the moment a screen wanted them. Note what it does NOT
 * justify: the receipts were being stored either way, so this needs no
 * migration and no backfill — it can answer for messages sent weeks ago.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

/** The positive states, in the order Meta reports them. */
export const DELIVERY_STAGES = ["sent", "delivered", "read"] as const
export type DeliveryStage = (typeof DELIVERY_STAGES)[number]

export type DeliveryState = {
  /** The furthest state Meta confirmed, or null if it has said nothing yet. */
  stage: DeliveryStage | null
  /** When that state was reported. */
  at: string | null
  /** Set when Meta refused it. Can coexist with a stage — a message can be
   * `sent` and then fail. */
  failure: { code: string | null; detail: string; at: string | null } | null
}

/**
 * Read the receipts for a page of reminders.
 *
 * Chunked at 200, like loadReceiptOwners and for the same reason: an `in` list
 * of ~70-character message ids blows past PostgREST's URL length, and that
 * failure is a property of the page being viewed rather than of anything
 * intermittent.
 *
 * Best-effort. A screen that cannot reach the receipts should show the
 * reminder rows it already has rather than an error page — the delivery trail
 * is additional detail, not the record itself.
 */
export async function loadDeliveryStates(
  admin: SupabaseClient,
  wamids: string[],
): Promise<Map<string, DeliveryState>> {
  const unique = [...new Set(wamids.filter(Boolean))]
  const states = new Map<string, DeliveryState>()
  if (unique.length === 0) return states

  const CHUNK = 200
  type Receipt = {
    wamid: string
    status: string
    error: string | null
    error_code: string | null
    occurred_at: string | null
    received_at: string
  }
  const rows: Receipt[] = []

  for (let i = 0; i < unique.length; i += CHUNK) {
    const { data, error } = await admin
      .from("whatsapp_status_events")
      .select("wamid, status, error, error_code, occurred_at, received_at")
      .in("wamid", unique.slice(i, i + CHUNK))
    if (error) {
      console.error(`[delivery-state] could not read receipts: ${error.message}`)
      return states
    }
    rows.push(...((data ?? []) as Receipt[]))
  }

  for (const r of rows) {
    const current = states.get(r.wamid) ?? { stage: null, at: null, failure: null }

    if (r.status === "failed") {
      // Keep the LATEST failure. A message retried after a failure can fail
      // again for a different reason, and the newest one is the live problem.
      const at = r.occurred_at ?? r.received_at
      if (!current.failure || (current.failure.at ?? "") <= at) {
        current.failure = {
          code: r.error_code,
          detail: r.error ?? "WhatsApp reported the message as failed",
          at,
        }
      }
    } else if ((DELIVERY_STAGES as readonly string[]).includes(r.status)) {
      const stage = r.status as DeliveryStage
      // Furthest, not latest. Meta does not guarantee receipt order, and a
      // `sent` arriving after a `read` must not walk the trail backwards.
      const rank = (s: DeliveryStage | null) => (s ? DELIVERY_STAGES.indexOf(s) : -1)
      if (rank(stage) > rank(current.stage)) {
        current.stage = stage
        current.at = r.occurred_at ?? r.received_at
      }
    }

    states.set(r.wamid, current)
  }

  return states
}
