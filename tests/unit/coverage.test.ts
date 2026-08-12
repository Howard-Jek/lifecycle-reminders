import { describe, it, expect } from "vitest"
import { computeCoverage, describeCoverage } from "@/lib/lifecycle/coverage"

/**
 * The failure this guards is silence: dates stored, no matching rule, nothing
 * sent, nothing logged. So the tests are mostly about making sure the silence
 * gets NAMED — with the right count and the right suggestion.
 */

describe("computeCoverage", () => {
  it("splits stored types into covered and stranded", () => {
    const coverage = computeCoverage(
      [
        { event_type: "birthday", count: 12 },
        { event_type: "policy_renewal", count: 30 },
      ],
      ["birthday", "policy_expiry"],
    )
    expect(coverage.covered).toEqual(["birthday"])
    expect(coverage.gaps.map((g) => g.event_type)).toEqual(["policy_renewal"])
    expect(coverage.strandedEvents).toBe(30)
  })

  it("names a near miss, because that is the actionable message", () => {
    // "You wrote policy-expiry, the rule says policy_expiry" is instantly
    // fixable; "no rule matches" is a puzzle.
    const coverage = computeCoverage(
      [{ event_type: "policy-expiry", count: 5 }],
      ["policy_expiry"],
    )
    expect(coverage.gaps[0].nearMiss).toBe("policy_expiry")
  })

  it("treats case and punctuation differences as the same intent", () => {
    const coverage = computeCoverage([{ event_type: "Policy Expiry", count: 1 }], ["policy_expiry"])
    expect(coverage.gaps[0].nearMiss).toBe("policy_expiry")
  })

  it("leaves nearMiss null when nothing is close", () => {
    const coverage = computeCoverage([{ event_type: "visa_expiry", count: 3 }], ["birthday"])
    expect(coverage.gaps[0].nearMiss).toBeNull()
  })

  it("sorts the biggest silence first", () => {
    const coverage = computeCoverage(
      [
        { event_type: "a", count: 2 },
        { event_type: "b", count: 40 },
        { event_type: "c", count: 9 },
      ],
      [],
    )
    expect(coverage.gaps.map((g) => g.event_type)).toEqual(["b", "c", "a"])
  })

  it("flags a rule no contact can ever match — usually a typo", () => {
    const coverage = computeCoverage(
      [{ event_type: "birthday", count: 4 }],
      ["birthday", "policy_expiryy"],
    )
    expect(coverage.unusedRuleTypes).toEqual(["policy_expiryy"])
  })

  it("reports no gaps when every type is covered", () => {
    const coverage = computeCoverage([{ event_type: "birthday", count: 4 }], ["birthday"])
    expect(coverage.gaps).toEqual([])
    expect(coverage.strandedEvents).toBe(0)
  })

  it("reports every type as stranded when there are no active rules at all", () => {
    // The commonest first-run state: dates imported, rules never configured.
    const coverage = computeCoverage(
      [
        { event_type: "birthday", count: 4 },
        { event_type: "policy_expiry", count: 6 },
      ],
      [],
    )
    expect(coverage.gaps).toHaveLength(2)
    expect(coverage.strandedEvents).toBe(10)
  })
})

describe("describeCoverage", () => {
  it("says nothing when there is nothing wrong", () => {
    expect(describeCoverage(computeCoverage([{ event_type: "b", count: 1 }], ["b"]))).toBeNull()
  })

  it("leads with the number of dates, not the number of types", () => {
    // 30 stranded dates across one type is a bigger deal than the "1 type"
    // framing suggests, and the count is what makes someone act.
    const message = describeCoverage(
      computeCoverage([{ event_type: "policy_renewal", count: 30 }], ["birthday"]),
    )
    expect(message).toContain("30 stored dates")
    expect(message).toContain("policy_renewal")
  })

  it("uses the singular for one date", () => {
    const message = describeCoverage(computeCoverage([{ event_type: "x", count: 1 }], []))
    expect(message).toContain("1 stored date can never")
  })

  it("offers the near miss instead of the generic advice", () => {
    const message = describeCoverage(
      computeCoverage([{ event_type: "policy-expiry", count: 2 }], ["policy_expiry"]),
    )
    expect(message).toContain('Did you mean "policy_expiry"?')
  })

  it("summarises rather than listing every type", () => {
    const message = describeCoverage(
      computeCoverage(
        ["a", "b", "c", "d", "e"].map((event_type) => ({ event_type, count: 1 })),
        [],
      ),
    )
    expect(message).toContain("and 2 more")
  })
})
