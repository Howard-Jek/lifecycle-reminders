import { describe, it, expect } from "vitest"
import {
  packForVertical,
  holdingLabel,
  GENERIC_PACK,
  type VerticalPack,
} from "@/lib/lifecycle/vertical-packs"
import { isHoldingType } from "@/lib/lifecycle/event-types"
import { VERTICALS } from "@/lib/lifecycle/verticals"
import { MAX_OVERDUE_DAYS } from "@/lib/lifecycle/plan-reminders"

/**
 * Pure throughout — a pack is data, and none of it touches the database.
 *
 * The invariants here are the ones a hand-authored pack can quietly violate,
 * each of which fails SILENTLY in production: a rule whose type nothing offers
 * schedules nothing, two rules on one key are silently dropped by the seed's
 * upsert, and offsets too close together fire a pile instead of one reminder.
 */

const allPacks = (): VerticalPack[] => [
  ...new Set([...VERTICALS.map((v) => packForVertical(v)), GENERIC_PACK]),
]

describe("packForVertical", () => {
  it("resolves every vertical the database will accept", () => {
    for (const v of VERTICALS) {
      expect(packForVertical(v), v).toBeTruthy()
      expect(packForVertical(v).rules.length, v).toBeGreaterThan(0)
    }
  })

  it("falls back to generic for anything it does not recognise", () => {
    // The column is nullable, a dev cookie can carry anything, and rows can
    // predate the CHECK. A mislabelled inbox beats a page that will not render.
    for (const bad of [null, undefined, "", "not_a_vertical", "INSURANCE"]) {
      expect(packForVertical(bad)).toBe(GENERIC_PACK)
    }
  })

  it("gives `other` the generic pack deliberately, not by accident", () => {
    expect(packForVertical("other")).toBe(GENERIC_PACK)
  })
})

describe("the insurance pack is exactly what was seeded before packs existed", () => {
  /**
   * Written out as a literal rather than compared against the old constant.
   *
   * DEFAULT_INSURANCE_RULES is gone — keeping it alive purely so a test could
   * compare the pack to it would be the pack testing itself. These five rows
   * are what the live tenant has been getting, transcribed once, so a change to
   * the pack has to argue with a fixed record instead of moving in step with it.
   */
  const HISTORIC = [
    "birthday:7:morning",
    "birthday:0:morning",
    "policy_expiry:30:morning",
    "policy_expiry:7:morning",
    "policy_review:14:afternoon",
  ]

  it("still seeds exactly those five rules", () => {
    const norm = (r: { event_type: string; offset_days: number; send_window: string }) =>
      `${r.event_type}:${r.offset_days}:${r.send_window}`
    expect(packForVertical("insurance").rules.map(norm).sort()).toEqual([...HISTORIC].sort())
  })
})

describe("pack invariants", () => {
  it("offers an event type for every rule it seeds", () => {
    // A rule whose type the import wizard never suggests schedules nothing and
    // reports nothing — the silent no-reminder the coverage banner exists for.
    for (const pack of allPacks()) {
      const offered = new Set(pack.eventTypes.map((t) => t.slug))
      for (const rule of pack.rules) {
        expect(offered.has(rule.event_type), `${pack.key}: ${rule.event_type}`).toBe(true)
      }
    }
  })

  it("never repeats an (event_type, offset_days) pair", () => {
    // reminder_rules is UNIQUE on (business_id, event_type, offset_days) and
    // the seed upserts on that key, so a duplicate is silently dropped rather
    // than reported — the operator gets fewer rules than the pack promises.
    for (const pack of allPacks()) {
      const keys = pack.rules.map((r) => `${r.event_type}:${r.offset_days}`)
      expect(new Set(keys).size, pack.key).toBe(keys.length)
    }
  })

  it("spaces successive offsets on one type by at least the overdue window", () => {
    // Closer than MAX_OVERDUE_DAYS and a contact imported mid-window fires
    // BOTH rules: one date, two WhatsApps to the same agent. The reference
    // spacing the constant was chosen against is -30/-14/-7/-0.
    for (const pack of allPacks()) {
      const byType = new Map<string, number[]>()
      for (const r of pack.rules) {
        byType.set(r.event_type, [...(byType.get(r.event_type) ?? []), r.offset_days])
      }
      for (const [type, offsets] of byType) {
        const sorted = [...offsets].sort((a, b) => a - b)
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i] - sorted[i - 1], `${pack.key}: ${type}`).toBeGreaterThanOrEqual(
            MAX_OVERDUE_DAYS,
          )
        }
      }
    }
  })

  it("keeps offsets inside the range the database allows", () => {
    // reminder_rules_offset_range is CHECK (offset_days BETWEEN 0 AND 365).
    for (const pack of allPacks()) {
      for (const r of pack.rules) {
        expect(r.offset_days, `${pack.key}: ${r.event_type}`).toBeGreaterThanOrEqual(0)
        expect(r.offset_days, `${pack.key}: ${r.event_type}`).toBeLessThanOrEqual(365)
      }
    }
  })

  it("gives every rule and event type a label somebody can read", () => {
    for (const pack of allPacks()) {
      for (const r of pack.rules) expect(r.label.trim().length, pack.key).toBeGreaterThan(0)
      for (const t of pack.eventTypes) {
        expect(t.label.trim().length, pack.key).toBeGreaterThan(0)
        expect(t.slug, pack.key).toMatch(/^[a-z0-9_]+$/)
      }
    }
  })
})

describe("isHoldingType", () => {
  it("never counts a birthday as something the contact holds, in any pack", () => {
    // The one thing the split exists to prevent. A birthday counted as a
    // product date is also a birthday that gets RETRIED days late.
    for (const pack of allPacks()) {
      expect(isHoldingType("birthday"), pack.key).toBe(false)
      expect(isHoldingType("anniversary"), pack.key).toBe(false)
    }
  })

  it("counts a type nobody predicted", () => {
    // Free text is the point: a business that invents `visa_expiry` gets it
    // counted without anyone adding it to a list.
    expect(isHoldingType("visa_expiry")).toBe(true)
  })
})

describe("holdingLabel", () => {
  it("claims the narrow word only when every type earns it", () => {
    const insurance = packForVertical("insurance")
    expect(holdingLabel(insurance, ["policy_expiry"])).toBe("Renewals")
    // A review is not a renewal.
    expect(holdingLabel(insurance, ["policy_expiry", "policy_review"])).toBe("Policies")
  })

  it("falls back to the bucket when the pack claims no narrow word", () => {
    expect(holdingLabel(GENERIC_PACK, ["renewal_date"])).toBe(GENERIC_PACK.holding.bucket)
  })

  it("does not claim the narrow word for an empty bucket", () => {
    expect(holdingLabel(packForVertical("insurance"), [])).toBe("Policies")
  })
})

describe("the deliberate exceptions, pinned so they read as decisions", () => {
  it("gives saas no birthday rules while still treating a birthday as personal", () => {
    // Classification and seeding are separate axes, and this is the case that
    // proves it. A birthday greeting from a software vendor is off-key, so no
    // rule — but `birthday` must still never be counted as a subscription or
    // retried days late.
    const saas = packForVertical("saas")
    expect(saas.rules.some((r) => r.event_type === "birthday")).toBe(false)
    expect(saas.eventTypes.some((t) => t.slug === "birthday")).toBe(true)
    expect(isHoldingType("birthday")).toBe(false)
  })

  it("forbids clinical detail in the dental framing", () => {
    // The drafting call is handed event.payload and lead.context verbatim, and
    // a dental sheet may carry a procedure. A WhatsApp naming a patient's
    // treatment is a health disclosure, and nothing downstream would flag it.
    const framing = packForVertical("dental").framing
    expect(framing).toMatch(/never/i)
    expect(framing).toMatch(/procedure|diagnosis|clinical/i)
  })

  it("gives every vertical a distinct set of words to describe a holding", () => {
    // If two industries share a column head, one of them is wearing the
    // other's vocabulary and the pack is not earning its place.
    const named = VERTICALS.filter((v) => v !== "other").map((v) => packForVertical(v))
    const columns = named.map((p) => p.holding.column)
    expect(new Set(columns).size).toBe(new Set(named).size)
  })

  it("keeps every pack's framing free of the word `policy` unless it sells policies", () => {
    // The regression this guards is the obvious one: copying the insurance
    // pack as a starting point and forgetting to change the prose.
    for (const v of VERTICALS) {
      const pack = packForVertical(v)
      if (pack.key === "insurance") continue
      expect(pack.framing.toLowerCase(), String(v)).not.toMatch(/\bpolicy\b|\bpolicies\b/)
    }
  })
})
