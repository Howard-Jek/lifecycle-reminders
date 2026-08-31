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
}

/** The reminder that owns the wamid, as it stands right now. */
export type ReceiptOwner = {
  id: string
  status: string
}

export type FailedReceiptVerdict =
  | { action: "record"; reminderId: string; error: string }
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
   * by waiting: recordStatusEvents keeps every receipt, wamid and all, so the
   * reason survives in whatsapp_status_events and can be attributed later
   * once the wamid exists. Answering Meta with a 500 to force a redelivery
   * would be a guess, and a wrong guess on a genuinely foreign wamid earns
   * retries on every payload and eventually a disabled webhook.
   */
  if (!owner) return { action: "skip", reason: "unowned" }

  if (!(RESOLVABLE_FROM_RECEIPT as readonly string[]).includes(owner.status)) {
    return { action: "skip", reason: "already-resolved" }
  }

  return {
    action: "record",
    reminderId: owner.id,
    error: receipt.error ?? NO_REASON_GIVEN,
  }
}
