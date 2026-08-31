/**
 * What a `failed` delivery receipt should do to the reminder that owns it.
 *
 * Pulled out of the webhook route because it is the one genuinely subtle piece
 * of that handler and it is pure: given the receipt and the row's current
 * state, the answer is a value. The route is then only plumbing — read the
 * signature, look the wamid up, apply the verdict — and this can be tested for
 * the races exhaustively without a Supabase stub or an HTTP request.
 *
 * Every case here is a race with our own delivery loop, which writes the row
 * three times on the way out (claim → stamp wamid → mark sent). Meta can
 * answer between any two of them.
 */

import { isRetryableFailure } from "@/lib/whatsapp-errors"
import { planRetry } from "./retry-policy"

/**
 * The states a delivery receipt is allowed to overwrite.
 *
 * `sent` is the ordinary case. `claimed` is the race: Meta reported the failure
 * before markReminderSent() committed, so the row still looks in-flight even
 * though the message has gone and been rejected. It is ours either way — the
 * wamid matched — and the receipt knows something the delivery loop does not.
 *
 * Nothing else may be overwritten. A row that has moved to `queued`, `failed`
 * or `skipped` has been resolved by something with a more recent view, and a
 * late receipt landing on a fresh attempt would drag it backwards into a
 * terminal state it would never be retried out of.
 */
export const RESOLVABLE_FROM_RECEIPT = ["sent", "claimed"] as const

/** What Meta told us, already flattened by parseWebhookBatch. */
export type FailureReceipt = {
  wamid: string
  status: "sent" | "delivered" | "read" | "failed"
  /** Meta's reason, pre-truncated. Null when Meta sends a bare failure. */
  error: string | null
  /** Meta's code for that reason, kept apart from the prose. */
  errorCode: string | null
}

/**
 * The reminder that owns the wamid, as it stands right now.
 *
 * Everything planRetry needs travels with it, so the retry decision costs no
 * extra round trip: the webhook is already reading this row to find out whose
 * receipt this is, and event type and timezone come along as embeds on that
 * same query.
 */
export type ReceiptOwner = {
  id: string
  status: string
  /**
   * Attempts already burnt. NOT +1 here, unlike the delivery loop: the claim
   * incremented this before the send, and the send has already happened. Adding
   * one again would skip a backoff step every time.
   */
  attempts: number
  /** The date the reminder is about, YYYY-MM-DD. */
  occurrenceDate: string
  /** Null when the event row has been deleted. */
  eventType: string | null
  /** The business's zone — occurrence dates are calendar dates in it. */
  timezone: string
}

export type FailedReceiptVerdict =
  | {
      action: "record"
      reminderId: string
      error: string
      errorCode: string | null
      /**
       * When to try again, or null to leave the row failed for a human.
       *
       * Non-null means the row goes back to `queued` rather than staying
       * `failed`. That symmetry is the point: a send that fails inside the
       * Graph call is retried, and until now the SAME failure arriving 200ms
       * later as a receipt was terminal. One outcome decided by whether Meta
       * answered before or after our HTTP call returned.
       */
      retryAt: string | null
    }
  | { action: "skip"; reason: "not-a-failure" | "unowned" | "already-resolved" }

/**
 * Said out loud rather than left as an empty string, because this text is the
 * entire explanation an operator gets on the Needs-attention tab. A blank cell
 * there reads as "no reason", which is a different and much worse claim than
 * "Meta did not give one".
 */
const NO_REASON_GIVEN = "WhatsApp reported the message as failed"

export function resolveFailedReceipt(
  receipt: FailureReceipt,
  owner: ReceiptOwner | null,
  now: Date = new Date(),
): FailedReceiptVerdict {
  if (receipt.status !== "failed") return { action: "skip", reason: "not-a-failure" }

  /**
   * No reminder owns this wamid. Three quite different things look like this:
   * a test send, a message sent outside the queue, and — the one that matters —
   * a reminder whose wamid has not been stamped yet, because Meta answered
   * inside the gap between the Graph call returning and stampDelivered()
   * committing.
   *
   * They are indistinguishable here, so this does not guess. Nothing is lost
   * by waiting: recordStatusEvents keeps every receipt, wamid and all, and
   * attributeOrphanReceipts (src/lib/notify/reminder-receipts.ts) looks again
   * at the top of every cycle, once the wamid exists. That sweep is what makes
   * this skip a deferral rather than a drop — if it is ever removed, this
   * comment becomes a lie and a whole class of failures goes back to sitting
   * on `sent` forever.
   *
   * Answering Meta with a 500 to force a redelivery would be a guess instead,
   * and a wrong guess on a genuinely foreign wamid earns retries on every
   * payload and eventually a disabled webhook.
   */
  if (!owner) return { action: "skip", reason: "unowned" }

  if (!(RESOLVABLE_FROM_RECEIPT as readonly string[]).includes(owner.status)) {
    return { action: "skip", reason: "already-resolved" }
  }

  /**
   * Two gates, and both have to open.
   *
   * isRetryableFailure asks whether repeating this exact send could ever work —
   * a rate limit yes, a handset that is not on WhatsApp no. planRetry then asks
   * whether it is worth doing: not for a birthday, not past the date it is
   * about, not past the attempt cap.
   *
   * The first gate is what makes the second safe to reach. Without it a number
   * Meta has already refused would burn every remaining attempt, billed, to
   * learn what the first attempt already said.
   */
  let retryAt: string | null = null
  if (isRetryableFailure(receipt.errorCode, receipt.error)) {
    const plan = planRetry({
      eventType: owner.eventType,
      attemptsBurnt: owner.attempts,
      occurrenceDate: owner.occurrenceDate,
      now,
      timezone: owner.timezone,
    })
    if (plan.retry) retryAt = plan.nextAttemptAt
  }

  return {
    action: "record",
    reminderId: owner.id,
    error: receipt.error ?? NO_REASON_GIVEN,
    errorCode: receipt.errorCode,
    retryAt,
  }
}
