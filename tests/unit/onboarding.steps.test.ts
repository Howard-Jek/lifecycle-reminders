import { describe, it, expect } from "vitest"
import {
  buildSetupSteps,
  isSetupComplete,
  describeSetup,
  type SetupState,
} from "@/lib/onboarding/steps"

/** A business that has done nothing yet. */
function blank(overrides: Partial<SetupState> = {}): SetupState {
  return {
    activeMembers: 0,
    hasOwner: false,
    contacts: 0,
    dates: 0,
    activeRules: 0,
    whatsapp: { configured: false, templateState: null },
    dryRun: false,
    ...overrides,
  }
}

/** Everything the operator can do themselves, done. */
function ready(overrides: Partial<SetupState> = {}): SetupState {
  return blank({
    activeMembers: 3,
    hasOwner: true,
    contacts: 12,
    dates: 24,
    activeRules: 5,
    whatsapp: { configured: true, templateState: "APPROVED" },
    ...overrides,
  })
}

const byId = (state: SetupState, id: string) => {
  const step = buildSetupSteps(state).find((s) => s.id === id)
  if (!step) throw new Error(`no step ${id}`)
  return step
}

describe("buildSetupSteps", () => {
  it("puts every step in todo for a brand-new business", () => {
    const steps = buildSetupSteps(blank())
    expect(steps.map((s) => s.id)).toEqual(["team", "contacts", "rules", "whatsapp"])
    expect(steps.every((s) => s.status === "todo")).toBe(true)
    expect(isSetupComplete(steps)).toBe(false)
  })

  it("keeps the team step open when members exist but none is the owner", () => {
    // Unassigned reminders fall back to the owner. Without one they have no
    // recipient at all, so a roster alone is not enough to tick this off.
    const step = byId(blank({ activeMembers: 4, hasOwner: false }), "team")
    expect(step.status).toBe("todo")
    expect(step.title).toMatch(/owner/i)
  })

  it("keeps the contacts step open when contacts were imported without dates", () => {
    // The failure this exists to catch: the Contacts page looks fully
    // populated, and the engine has nothing to schedule from.
    const step = byId(blank({ contacts: 40, dates: 0 }), "contacts")
    expect(step.status).toBe("todo")
    expect(step.body).toContain("40")
  })

  it("completes the contacts step once dates came in with them", () => {
    const step = byId(blank({ contacts: 12, dates: 24 }), "contacts")
    expect(step.status).toBe("done")
    expect(step.detail).toBe("12 contacts · 24 dates")
  })

  it("counts in singular when there is exactly one of something", () => {
    const step = byId(blank({ contacts: 1, dates: 1 }), "contacts")
    expect(step.detail).toBe("1 contact · 1 date")
  })

  it("reverts a step to todo when its last row is removed", () => {
    // A stored onboarding cursor could not do this, which is the reason the
    // steps are derived from live counts instead.
    expect(byId(ready(), "rules").status).toBe("done")
    expect(byId(ready({ activeRules: 0 }), "rules").status).toBe("todo")
  })
})

describe("the WhatsApp step", () => {
  it("waits, rather than nags, while Meta is reviewing", () => {
    const step = byId(ready({ whatsapp: { configured: true, templateState: "PENDING" } }), "whatsapp")
    expect(step.status).toBe("waiting")
    // Nothing to press: there is no action that speeds Meta up.
    expect(step.cta).toBeUndefined()
  })

  it("treats an unknown template state as not yet submitted", () => {
    // getSetupSteps returns null when Graph did not answer inside its timeout.
    // Being wrong in this direction sends the operator to Settings, where the
    // real status is fetched without a deadline.
    const step = byId(ready({ whatsapp: { configured: true, templateState: null } }), "whatsapp")
    expect(step.status).toBe("todo")
    expect(step.href).toBe("/settings")
  })

  it("flags an approved template that is still dry-running", () => {
    // The easiest state in the product to miss: every stage runs and the
    // reminder is marked sent, but nothing leaves the building.
    const step = byId(ready({ dryRun: true }), "whatsapp")
    expect(step.status).toBe("waiting")
    expect(step.cta).toBe("Turn dry run off")
  })

  it("is done only when approved and actually delivering", () => {
    expect(byId(ready(), "whatsapp").status).toBe("done")
  })

  it("sends the operator to the reason when Meta rejected it", () => {
    const step = byId(ready({ whatsapp: { configured: true, templateState: "REJECTED" } }), "whatsapp")
    expect(step.status).toBe("todo")
    expect(step.href).toBe("/settings")
  })
})

describe("isSetupComplete", () => {
  it("is true once nothing is left for the operator, even if Meta is still deciding", () => {
    // The checklist hides itself here. A list that cannot be finished is one
    // people stop reading, and the pending template is reported on Settings.
    const steps = buildSetupSteps(ready({ whatsapp: { configured: true, templateState: "PENDING" } }))
    expect(steps.some((s) => s.status === "waiting")).toBe(true)
    expect(isSetupComplete(steps)).toBe(true)
  })

  it("is false while any single step is still todo", () => {
    expect(isSetupComplete(buildSetupSteps(ready({ activeRules: 0 })))).toBe(false)
  })

  it("stays false for a waiting step that still has something to press", () => {
    // Regression. Completion used to be `every(status !== "todo")`, which made
    // the approved-but-dry-running state complete — so the checklist hid itself
    // in precisely the state the operator most needs telling about, and the
    // "Turn dry run off" button it builds could never be reached.
    const steps = buildSetupSteps(ready({ dryRun: true }))
    const whatsapp = steps.find((s) => s.id === "whatsapp")!
    expect(whatsapp.status).toBe("waiting")
    expect(whatsapp.cta).toBe("Turn dry run off")
    expect(isSetupComplete(steps)).toBe(false)
  })
})

describe("describeSetup", () => {
  it("counts what is left when work remains", () => {
    expect(describeSetup(buildSetupSteps(blank()))).toBe("4 of 4 steps left")
    expect(describeSetup(buildSetupSteps(ready({ activeRules: 0 })))).toBe("1 of 4 steps left")
  })

  it("counts a waiting step the operator can act on", () => {
    // Approved but still dry-running. Meta has already answered, so this is the
    // operator's own switch — it has to be counted, and it must not be blamed
    // on the one party that is not the hold-up.
    const summary = describeSetup(buildSetupSteps(ready({ dryRun: true })))
    expect(summary).toBe("1 of 4 steps left")
    expect(summary).not.toMatch(/Meta/i)
  })

  it("does not count a step that is only waiting on Meta", () => {
    const steps = buildSetupSteps(ready({ whatsapp: { configured: true, templateState: "PENDING" } }))
    expect(describeSetup(steps)).toBe("0 of 4 steps left")
    // ...and in that state the checklist is not rendered at all.
    expect(isSetupComplete(steps)).toBe(true)
  })
})
