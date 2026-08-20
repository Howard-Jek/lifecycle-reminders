import { describe, it, expect } from "vitest"
import { listKnownEventTypes, isPolicyLike, PERSONAL_EVENT_TYPES } from "@/lib/lifecycle/event-types"
import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * These two functions carry more product weight than their size suggests.
 *
 * listKnownEventTypes feeds the date-type dropdown, which exists to stop the
 * typo that produces a reminder nobody ever gets: events and rules join on
 * EXACT string equality, so "policy expiry" against a "policy_expiry" rule
 * fails silently forever. Ordering is the feature — a type with a rule behind
 * it is one that will actually fire, so it has to be offered first.
 *
 * isPolicyLike decides both the contacts "Policies" count and the renewals/
 * birthdays split on the inbox.
 */

/** Minimal stand-in for the two `.select()` chains the function issues. */
function stubAdmin(
  rules: { event_type: string }[],
  events: { event_type: string }[],
): SupabaseClient {
  const chain = (rows: { event_type: string }[]) => {
    const self = {
      select: () => self,
      eq: () => self,
      limit: () => Promise.resolve({ data: rows, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
    }
    return self
  }
  return {
    from: (table: string) => chain(table === "reminder_rules" ? rules : events),
  } as unknown as SupabaseClient
}

describe("listKnownEventTypes", () => {
  it("offers types that have a rule before types that only have dates", async () => {
    // The whole point of the ordering: `birthday` has 500 dates and no rule, so
    // picking it schedules nothing. `policy_expiry` has one date and a rule, so
    // picking it works. The one that works goes first.
    const types = await listKnownEventTypes(
      stubAdmin(
        [{ event_type: "policy_expiry" }],
        [
          ...Array.from({ length: 500 }, () => ({ event_type: "birthday" })),
          { event_type: "policy_expiry" },
        ],
      ),
      "biz",
    )
    expect(types.map((t) => t.value)).toEqual(["policy_expiry", "birthday"])
    expect(types[0].hasRule).toBe(true)
    expect(types[1].hasRule).toBe(false)
  })

  it("includes a rule that no contact uses yet", async () => {
    // Otherwise a freshly-added rule is missing from the dropdown until someone
    // types its name by hand — which is the exact typo the dropdown prevents.
    const types = await listKnownEventTypes(stubAdmin([{ event_type: "visa_expiry" }], []), "biz")
    expect(types).toEqual([{ value: "visa_expiry", hasRule: true, usedBy: 0 }])
  })

  it("includes a type in use with no rule, because that is the gap to surface", async () => {
    const types = await listKnownEventTypes(stubAdmin([], [{ event_type: "warranty" }]), "biz")
    expect(types).toEqual([{ value: "warranty", hasRule: false, usedBy: 1 }])
  })

  it("counts usage and breaks ties alphabetically", async () => {
    const types = await listKnownEventTypes(
      stubAdmin(
        [],
        [
          { event_type: "b" },
          { event_type: "b" },
          { event_type: "c" },
          { event_type: "a" },
        ],
      ),
      "biz",
    )
    expect(types).toEqual([
      { value: "b", hasRule: false, usedBy: 2 },
      { value: "a", hasRule: false, usedBy: 1 },
      { value: "c", hasRule: false, usedBy: 1 },
    ])
  })

  it("does not collapse near-misses into one option", async () => {
    // "policy expiry" and "policy_expiry" are different types to the engine, and
    // the dropdown must show that rather than hide it — the coverage banner is
    // what asks the operator to reconcile them.
    const types = await listKnownEventTypes(
      stubAdmin([{ event_type: "policy_expiry" }], [{ event_type: "policy expiry" }]),
      "biz",
    )
    expect(types.map((t) => t.value)).toEqual(["policy_expiry", "policy expiry"])
  })

  it("returns nothing for a business with no rules and no dates", async () => {
    expect(await listKnownEventTypes(stubAdmin([], []), "biz")).toEqual([])
  })
})

describe("isPolicyLike", () => {
  it("treats an unknown type as a policy", () => {
    // Deliberately open: the engine is a generic temporal trigger, so a warranty
    // or a visa renewal is a product the client holds and belongs in the
    // renewals bucket. Only the named personal dates are the exception.
    expect(isPolicyLike("warranty_expiry")).toBe(true)
    expect(isPolicyLike("policy_expiry")).toBe(true)
  })

  it("excludes the personal dates", () => {
    for (const type of PERSONAL_EVENT_TYPES) expect(isPolicyLike(type)).toBe(false)
  })

  it("is exact, so a differently-spelled birthday counts as a policy", () => {
    // Documenting the sharp edge rather than pretending it away: the split is
    // string equality like everything else here, so "Birthday" lands in the
    // renewals bucket. The coverage banner is what surfaces the mismatch.
    expect(isPolicyLike("Birthday")).toBe(true)
  })
})
