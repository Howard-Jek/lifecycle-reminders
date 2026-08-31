import { describe, it, expect } from "vitest"
import {
  describeNumberName,
  describeRegistration,
} from "@/lib/notify/number-diagnostics"

/**
 * The thing under test is precedence and wording, because both mislead in the
 * same direction: towards telling an operator that a submission they made
 * never happened.
 */

const declinedName = { verifiedName: "LifeCycle", nameStatus: "DECLINED" }

describe("describeNumberName", () => {
  it("reports a pending replacement as in review, NOT as the old rejection", () => {
    // THE case this module exists for. Meta keeps the old name in
    // verified_name and leaves name_status at DECLINED while the replacement
    // is reviewed, so reading name_status first reports a submission that
    // landed as a fresh rejection — and sends someone to submit again, which
    // is the one action that can make it worse.
    const verdict = describeNumberName({ ...declinedName, newNameStatus: "PENDING_REVIEW" })

    expect(verdict.tone).toBe("waiting")
    expect(verdict.headline).toBe("New name in review")
    expect(verdict.detail).toMatch(/does not mean the submission failed/i)
  })

  it("still names the old name while the replacement is pending", () => {
    // The operator is looking at a page that shows the rejected name. Saying
    // so explicitly is what stops "it still says LifeCycle" being read as
    // "the new name did not save".
    const verdict = describeNumberName({ ...declinedName, newNameStatus: "PENDING_REVIEW" })
    expect(verdict.detail).toContain("LifeCycle")
  })

  it("reports a rejected replacement distinctly from a rejected original", () => {
    const replacement = describeNumberName({ ...declinedName, newNameStatus: "DECLINED" })
    const original = describeNumberName({ ...declinedName, newNameStatus: null })

    expect(replacement.headline).toBe("New name declined too")
    expect(original.headline).toBe("Name declined")
    expect(replacement.headline).not.toBe(original.headline)
  })

  it("tells an operator with nothing submitted to submit, and where", () => {
    const verdict = describeNumberName({ ...declinedName, newNameStatus: null })
    expect(verdict.tone).toBe("bad")
    expect(verdict.detail).toMatch(/WhatsApp Manager/)
  })

  it.each(["APPROVED", "AVAILABLE_WITHOUT_REVIEW"])("treats %s as good", (nameStatus) => {
    const verdict = describeNumberName({ verifiedName: "Goma", nameStatus, newNameStatus: null })
    expect(verdict.tone).toBe("good")
  })

  it.each([
    ["PENDING_REVIEW", "waiting"],
    ["DECLINED", "bad"],
    ["EXPIRED", "bad"],
    ["NONE", "waiting"],
  ])("maps %s to %s", (nameStatus, tone) => {
    const verdict = describeNumberName({ verifiedName: "Goma", nameStatus, newNameStatus: null })
    expect(verdict.tone).toBe(tone)
  })

  it("surfaces an unrecognised state verbatim instead of guessing a tone", () => {
    // Meta adds states without warning. Mapping an unknown one onto "good"
    // would claim more than we know; onto "bad" would invent an outage.
    const verdict = describeNumberName({
      verifiedName: "Goma",
      nameStatus: "SOMETHING_NEW",
      newNameStatus: null,
    })
    expect(verdict.headline).toContain("SOMETHING_NEW")
    expect(verdict.tone).toBe("waiting")
  })

  it("copes with a number that has no name at all", () => {
    const verdict = describeNumberName({
      verifiedName: null,
      nameStatus: null,
      newNameStatus: null,
    })
    expect(verdict.tone).toBe("waiting")
    expect(verdict.detail).not.toContain("null")
  })

  it("never claims registering would fix a name — for any state", () => {
    // The invariant behind the whole feature. Name review and registration are
    // different queues at Meta; a UI that offers re-registration as a remedy
    // for a declined name spends rate-limited PIN attempts on a no-op.
    const states = [
      "APPROVED",
      "AVAILABLE_WITHOUT_REVIEW",
      "PENDING_REVIEW",
      "DECLINED",
      "EXPIRED",
      "NONE",
      "SOMETHING_NEW",
      null,
    ]
    for (const nameStatus of states) {
      for (const newNameStatus of ["PENDING_REVIEW", "DECLINED", "NONE", null]) {
        expect(
          describeNumberName({ verifiedName: "Goma", nameStatus, newNameStatus }).registrationHelps,
          `${nameStatus} / ${newNameStatus}`,
        ).toBe(false)
      }
    }
  })
})

describe("describeRegistration", () => {
  it("is good only when CONNECTED on the Cloud API", () => {
    const verdict = describeRegistration({ status: "CONNECTED", platformType: "CLOUD_API" })
    expect(verdict.tone).toBe("good")
    expect(verdict.registrationHelps).toBe(false)
  })

  it("does not call a CONNECTED number on another platform good", () => {
    // CONNECTED alone is not enough: an on-premise number reads CONNECTED and
    // fails every Cloud API send.
    const verdict = describeRegistration({ status: "CONNECTED", platformType: "ON_PREMISE" })
    expect(verdict.tone).toBe("bad")
    expect(verdict.registrationHelps).toBe(true)
  })

  it("points at #133010 when the number is not registered", () => {
    const verdict = describeRegistration({ status: null, platformType: "NOT_APPLICABLE" })
    expect(verdict.tone).toBe("bad")
    expect(verdict.detail).toContain("#133010")
    expect(verdict.registrationHelps).toBe(true)
  })

  it("keeps a reported status visible in the headline", () => {
    const verdict = describeRegistration({ status: "PENDING", platformType: null })
    expect(verdict.headline).toContain("PENDING")
  })
})
