import { describe, it, expect } from "vitest"
import { isPolicyLike, PERSONAL_EVENT_TYPES, listKnownEventTypes } from "@/lib/lifecycle/event-types"
import { buildKnownTypes } from "@/lib/lifecycle/event-facts"
import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * The ordering contract is the feature.
 *
 * listKnownEventTypes feeds the date-type dropdown, which exists to stop the
 * typo that produces a reminder nobody ever gets: events and rules join on
 * EXACT string equality, so "policy expiry" against a "policy_expiry" rule
 * fails silently for ever. A type with a RULE behind it is one that will
 * actually fire, so it has to be offered first.
 *
 * Tested through buildKnownTypes, which is the pure half. The counting moved
 * into Postgres — it used to select 10,000 rows of a column and reduce them
 * here — so what is left in TypeScript is exactly this ordering decision.
 */

describe("buildKnownTypes", () => {
  it("offers types that have a rule before types that only have dates", () => {
    // `birthday` has 500 dates and no rule, so picking it schedules nothing.
    // `policy_expiry` has one date and a rule, so picking it works. The one
    // that works goes first.
    const types = buildKnownTypes(
      [
        { event_type: "birthday", count: 500 },
        { event_type: "policy_expiry", count: 1 },
      ],
      ["policy_expiry"],
    )
    expect(types.map((t) => t.value)).toEqual(["policy_expiry", "birthday"])
    expect(types[0].hasRule).toBe(true)
    expect(types[1].hasRule).toBe(false)
  })

  it("includes a rule that no contact uses yet", () => {
    // Otherwise a freshly-added rule is missing from the dropdown until someone
    // types its name by hand — the exact typo the dropdown prevents.
    expect(buildKnownTypes([], ["visa_expiry"])).toEqual([
      { value: "visa_expiry", hasRule: true, usedBy: 0 },
    ])
  })

  it("includes a type in use with no rule, because that is the gap to surface", () => {
    expect(buildKnownTypes([{ event_type: "warranty", count: 1 }], [])).toEqual([
      { value: "warranty", hasRule: false, usedBy: 1 },
    ])
  })

  it("orders by usage, then alphabetically", () => {
    const types = buildKnownTypes(
      [
        { event_type: "b", count: 2 },
        { event_type: "c", count: 1 },
        { event_type: "a", count: 1 },
      ],
      [],
    )
    expect(types).toEqual([
      { value: "b", hasRule: false, usedBy: 2 },
      { value: "a", hasRule: false, usedBy: 1 },
      { value: "c", hasRule: false, usedBy: 1 },
    ])
  })

  it("does not collapse near-misses into one option", () => {
    // "policy expiry" and "policy_expiry" are different types to the engine and
    // the dropdown must show that rather than hide it — the coverage banner is
    // what asks the operator to reconcile them.
    const types = buildKnownTypes([{ event_type: "policy expiry", count: 3 }], ["policy_expiry"])
    expect(types.map((t) => t.value)).toEqual(["policy_expiry", "policy expiry"])
  })

  it("returns nothing for a business with no rules and no dates", () => {
    expect(buildKnownTypes([], [])).toEqual([])
  })

  it("survives a bigint count arriving as a string", () => {
    // Postgres COUNT(*) is bigint, and postgrest-js has been known to hand
    // those back as strings. Sorting on a string would order 9 above 100.
    const types = buildKnownTypes(
      [
        { event_type: "few", count: Number("9") },
        { event_type: "many", count: Number("100") },
      ],
      [],
    )
    expect(types.map((t) => t.value)).toEqual(["many", "few"])
  })
})

describe("listKnownEventTypes", () => {
  /** Minimal stand-in: one .from() chain for rules, one .rpc() for the counts. */
  function stubAdmin(
    rules: { event_type: string }[],
    counts: { event_type: string; count: number }[],
  ): SupabaseClient {
    const chain = {
      select: () => chain,
      eq: () => chain,
      then: (resolve: (v: unknown) => unknown) => resolve({ data: rules, error: null }),
    } as Record<string, unknown>
    return {
      from: () => chain,
      rpc: async () => ({ data: counts, error: null }),
    } as unknown as SupabaseClient
  }

  it("aggregates in the database rather than scanning rows", async () => {
    const types = await listKnownEventTypes(
      stubAdmin([{ event_type: "policy_expiry" }], [
        { event_type: "birthday", count: 315 },
        { event_type: "policy_expiry", count: 280 },
      ]),
      "biz",
    )
    expect(types).toEqual([
      { value: "policy_expiry", hasRule: true, usedBy: 280 },
      { value: "birthday", hasRule: false, usedBy: 315 },
    ])
  })

  it("returns an empty list rather than throwing when the RPC fails", async () => {
    const admin = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: async () => ({ data: [], error: null }) }) }),
      }),
      rpc: async () => ({ data: null, error: { message: "boom" } }),
    } as unknown as SupabaseClient
    await expect(listKnownEventTypes(admin, "biz")).resolves.toEqual([])
  })
})

describe("isPolicyLike", () => {
  it("treats an unknown type as a policy", () => {
    // Deliberately open: the engine is a generic temporal trigger, so a
    // warranty or visa renewal is a product the client holds.
    expect(isPolicyLike("warranty_expiry")).toBe(true)
    expect(isPolicyLike("policy_expiry")).toBe(true)
  })

  it("excludes the personal dates", () => {
    for (const type of PERSONAL_EVENT_TYPES) expect(isPolicyLike(type)).toBe(false)
  })

  it("is exact, so a differently-spelled birthday counts as a policy", () => {
    expect(isPolicyLike("Birthday")).toBe(true)
  })
})
