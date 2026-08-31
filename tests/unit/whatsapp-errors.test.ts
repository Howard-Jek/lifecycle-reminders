import { describe, it, expect } from "vitest"
import {
  describeWhatsappError,
  isRetryableFailure,
  WHATSAPP_FAILURE_CAUSES,
} from "@/lib/whatsapp-errors"

/**
 * Ported from the host's fork/feature/resend-failed-message-and-error-mapping,
 * with the two changes this repo needs: a leading-code parser that understands
 * OUR error format, and a retryable flag the retry policy can read.
 */

describe("describeWhatsappError", () => {
  it("prefers the code column when it has one", () => {
    expect(describeWhatsappError("131026", null).title).toMatch(/couldn't deliver/i)
  })

  it("recovers the code from THIS repo's bracket format", () => {
    // describeErrors writes "[131047] 24h window". The upstream parser only
    // understood "131026: …", so ported verbatim it would have returned the
    // generic message for every row ever written here — a feature that looks
    // shipped and never fires.
    const info = describeWhatsappError(null, "[131047] 24h window")
    expect(info.title).toMatch(/24-hour/i)
  })

  it("recovers the code from Meta's own Graph format", () => {
    // "(#131047) …" is what error.message actually contains on a failed send,
    // and it is the MOST common spelling in production — every synchronous
    // failure writes it. An earlier parser accepted one optional bracket
    // character, so "(" was consumed and "#" met a digit slot: the whole send
    // path silently got the generic message.
    expect(describeWhatsappError(null, "(#131047) Re-engagement message").title).toMatch(/24-hour/i)
    expect(describeWhatsappError(null, "(#131026) Message Undeliverable").title).toMatch(
      /couldn't deliver/i,
    )
    expect(isRetryableFailure(null, "(#131026) Message Undeliverable")).toBe(false)
  })

  it("reads a bare code with no detail", () => {
    // describeErrors emits "[131026]" when Meta sends a code and nothing else.
    expect(describeWhatsappError(null, "[131026]").title).toMatch(/couldn't deliver/i)
  })

  it("still recovers the code from the host's colon format", () => {
    // Rows written by the monorepo read "131026: Receiver incapable".
    expect(describeWhatsappError(null, "131026: Receiver incapable").title).toMatch(
      /couldn't deliver/i,
    )
  })

  it("falls back to generic guidance for a code it does not know", () => {
    const info = describeWhatsappError("999999", null)
    expect(info.title).toMatch(/couldn't be sent/i)
    expect(info.action.length).toBeGreaterThan(0)
  })

  it("falls back to generic guidance when there is nothing to go on", () => {
    expect(describeWhatsappError(null, null).title).toMatch(/couldn't be sent/i)
    expect(describeWhatsappError(undefined, undefined).title).toMatch(/couldn't be sent/i)
  })

  it("does not mistake a number inside the prose for a code", () => {
    // Only a LEADING code counts. "Waited 131026 ms" is not an error code.
    expect(describeWhatsappError(null, "waited 131026 ms for Meta").title).toMatch(
      /couldn't be sent/i,
    )
  })

  it("always offers an action, never a bare headline", () => {
    for (const code of ["131026", "131047", "130429", "131042", "132001", "999999"]) {
      expect(describeWhatsappError(code, null).action.trim().length).toBeGreaterThan(0)
    }
  })
})

describe("isRetryableFailure", () => {
  it("refuses to retry a number that will never receive", () => {
    // This is the flag's whole reason for existing: three billed sends against
    // a handset that is not on WhatsApp is money spent to learn nothing.
    expect(isRetryableFailure("131026")).toBe(false)
  })

  it("refuses to retry anything a human has to fix first", () => {
    for (const code of ["131030", "131051", "100", "132000", "132001", "368"]) {
      expect(isRetryableFailure(code)).toBe(false)
    }
  })

  it("retries the failures that pass on their own", () => {
    for (const code of ["130429", "131049", "130472"]) {
      expect(isRetryableFailure(code)).toBe(true)
    }
  })

  it("retries an unknown code, because the attempt cap already bounds it", () => {
    // Guessing "permanent" on a code Meta added last week would silently stop
    // retrying a class of transient failures, and nothing would report it.
    expect(isRetryableFailure("999999")).toBe(true)
    expect(isRetryableFailure(null)).toBe(true)
  })
})

describe("WHATSAPP_FAILURE_CAUSES", () => {
  it("reads as plain sentences an operator could act on", () => {
    expect(WHATSAPP_FAILURE_CAUSES.length).toBeGreaterThan(3)
    for (const cause of WHATSAPP_FAILURE_CAUSES) {
      expect(cause).toMatch(/\.$/)
      expect(cause).not.toMatch(/\b(wamid|WABA|HTTP|API)\b/)
    }
  })
})
