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
  attempts: 1,
  // Far enough ahead that the backoff never overshoots it, so these cases test
  // the receipt logic rather than the deadline rule (which retry-policy owns).
  occurrenceDate: "2099-01-01",
  eventType: "policy_expiry",
  timezone: "Asia/Singapore",
  ...over,
})

describe("resolveFailedReceipt", () => {
  it("records a failure against a row we believe was delivered", () => {
    expect(resolveFailedReceipt(receipt(), owner({ status: "sent" }))).toEqual({
      action: "record",
      reminderId: "r1",
      error: "[131047] Re-engagement message",
      errorCode: "131047",
      // 131047 wants an approved template, which a reminder already sends —
      // so repeating it identically fails identically. Not retryable.
      retryAt: null,
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

describe("a receipt failure is retried on the same terms as a send failure", () => {
  /**
   * The asymmetry this closes: a send that failed inside the Graph call was
   * retried with a backoff, and the SAME failure arriving 200ms later as a
   * delivery receipt was terminal. Which one you got depended on whether Meta
   * answered before or after our HTTP call returned.
   */
  const now = new Date("2026-09-01T02:00:00Z")

  it("schedules another attempt for a failure that can pass on its own", () => {
    const v = resolveFailedReceipt(
      receipt({ error: "[130429] rate limited", errorCode: "130429" }),
      owner({ attempts: 1 }),
      now,
    )
    expect(v).toMatchObject({ action: "record" })
    if (v.action === "record") expect(v.retryAt).not.toBeNull()
  })

  it("refuses to retry a number Meta says cannot receive", () => {
    // Three billed sends to learn what the first attempt already said.
    const v = resolveFailedReceipt(
      receipt({ error: "[131026] not on WhatsApp", errorCode: "131026" }),
      owner({ attempts: 1 }),
      now,
    )
    if (v.action === "record") expect(v.retryAt).toBeNull()
  })

  it("never retries a personal date, whatever the code says", () => {
    // A birthday greeting on the wrong day is worse than none at all, so the
    // schedule refuses even when the failure itself is transient.
    const v = resolveFailedReceipt(
      receipt({ errorCode: "130429" }),
      owner({ eventType: "birthday", attempts: 1 }),
      now,
    )
    if (v.action === "record") expect(v.retryAt).toBeNull()
  })

  it("stops when the attempts are gone", () => {
    const v = resolveFailedReceipt(
      receipt({ errorCode: "130429" }),
      owner({ attempts: 99 }),
      now,
    )
    if (v.action === "record") expect(v.retryAt).toBeNull()
  })

  it("does not retry past the date the reminder is about", () => {
    // "Your policy expired" delivered after it expired is a complaint.
    const v = resolveFailedReceipt(
      receipt({ errorCode: "130429" }),
      owner({ attempts: 1, occurrenceDate: "2026-09-01" }),
      now,
    )
    if (v.action === "record") expect(v.retryAt).toBeNull()
  })

  it("counts the attempt that just failed without double-counting it", () => {
    // The claim incremented `attempts` before the send and the send has already
    // happened, so this path passes attempts straight through. Adding one — as
    // the delivery loop correctly does — would skip a backoff step every time.
    const first = resolveFailedReceipt(receipt({ errorCode: "130429" }), owner({ attempts: 1 }), now)
    const second = resolveFailedReceipt(receipt({ errorCode: "130429" }), owner({ attempts: 2 }), now)
    if (first.action === "record" && second.action === "record") {
      expect(first.retryAt).not.toBeNull()
      expect(second.retryAt).not.toBeNull()
      // Backoff widens: 1 day, then 3.
      expect(new Date(second.retryAt!).getTime()).toBeGreaterThan(new Date(first.retryAt!).getTime())
    }
  })
})
