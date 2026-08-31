import { describe, it, expect } from "vitest"
import {
  resolveFailedReceipt,
  RESOLVABLE_FROM_RECEIPT,
  type ReceiptOwner,
} from "@/lib/lifecycle/failed-receipt"

/**
 * The decision a delivery receipt forces, pulled out of the route so it can be
 * tested without a Supabase stub or an HTTP request.
 *
 * The interesting cases are all races: Meta can report a failure before, during
 * or after our own bookkeeping finishes, and each of those wants a different
 * answer. Getting them wrong is silent in both directions — clobber a fresh
 * attempt, or throw away the only explanation of a failure that exists.
 */

const receipt = (over: Partial<Parameters<typeof resolveFailedReceipt>[0]> = {}) => ({
  wamid: "wamid.1",
  status: "failed" as const,
  error: "[131047] Re-engagement message",
  errorCode: "131047",
  ...over,
})

const owner = (over: Partial<ReceiptOwner> = {}): ReceiptOwner => ({
  id: "r1",
  status: "sent",
  ...over,
})

describe("resolveFailedReceipt", () => {
  it("records a failure against a row we believe was delivered", () => {
    expect(resolveFailedReceipt(receipt(), owner({ status: "sent" }))).toEqual({
      action: "record",
      reminderId: "r1",
      error: "[131047] Re-engagement message",
      errorCode: "131047",
    })
  })

  it("records a failure against a row still claimed", () => {
    // The race this function exists for: Meta answered before markReminderSent
    // committed. The row is ours, the message went out, and the receipt is the
    // truth about it — dropping it here loses Meta's reason for good.
    expect(resolveFailedReceipt(receipt(), owner({ status: "claimed" }))).toMatchObject({
      action: "record",
      reminderId: "r1",
    })
  })

  it("supplies a reason when Meta sends none, so the row is never blank", () => {
    const v = resolveFailedReceipt(receipt({ error: null }), owner())
    expect(v).toMatchObject({ action: "record" })
    if (v.action === "record") expect(v.error.length).toBeGreaterThan(0)
  })

  it("carries the code through untouched, including its absence", () => {
    // The code is what the retry decision reads. Recovering it by parsing the
    // sentence would break the day Meta rewords a failure, so it travels beside
    // the prose rather than inside it.
    const v = resolveFailedReceipt(receipt({ error: null, errorCode: null }), owner())
    expect(v).toMatchObject({ action: "record", errorCode: null })
  })

  it("ignores the happy states", () => {
    for (const status of ["sent", "delivered", "read"] as const) {
      expect(resolveFailedReceipt(receipt({ status }), owner())).toEqual({
        action: "skip",
        reason: "not-a-failure",
      })
    }
  })

  it("skips a wamid no reminder owns", () => {
    // A test send, a coach message, or — the case that matters — a reminder
    // whose wamid has not been stamped yet. The receipt is still kept in
    // whatsapp_status_events; it is only the row write that waits.
    expect(resolveFailedReceipt(receipt(), null)).toEqual({
      action: "skip",
      reason: "unowned",
    })
  })

  it("does not touch a row that has already moved on", () => {
    // A late receipt for an attempt that has since been requeued or resolved.
    // Writing `failed` here would drag a fresh attempt backwards and it would
    // never be retried again.
    for (const status of ["queued", "failed", "skipped"]) {
      expect(resolveFailedReceipt(receipt(), owner({ status }))).toEqual({
        action: "skip",
        reason: "already-resolved",
      })
    }
  })

  it("names exactly the statuses a receipt may overwrite", () => {
    // Pinned so widening this set is a deliberate edit with a test to argue
    // with, not a quiet change of who wins a race.
    expect([...RESOLVABLE_FROM_RECEIPT]).toEqual(["sent", "claimed"])
  })
})
