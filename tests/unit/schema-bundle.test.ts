import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  buildBundle,
  allMigrations,
  bundledMigrations,
  isStandaloneOnly,
} from "../../scripts/sql-bundle"

/**
 * The committed schema in supabase/schema/ must match the migrations.
 *
 * Those files exist so somebody reading this repo on GitHub — at merge time,
 * most likely, without a checkout in front of them — can see how to build the
 * database. That is only worth anything if they are current, and a committed
 * generated file is exactly the thing that rots quietly.
 *
 * So the drift is a failing test rather than a warning in a header. Run
 * `npm run db:schema` and commit the result.
 */

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), "utf8")

describe("the committed schema is current", () => {
  it("full.sql matches the migrations", () => {
    expect(existsSync(join(root, "supabase/schema/full.sql"))).toBe(true)
    expect(read("supabase/schema/full.sql")).toBe(buildBundle(false))
  })

  it("addon.sql matches the migrations", () => {
    expect(existsSync(join(root, "supabase/schema/addon.sql"))).toBe(true)
    expect(read("supabase/schema/addon.sql")).toBe(buildBundle(true))
  })
})

describe("every migration is classified", () => {
  it("names each file as host-bound or standalone-only, deliberately", () => {
    /**
     * The classification used to be `name.includes("lifecycle_events")`, which
     * was right for one migration and silently wrong from the second onward —
     * the add-on bundle omitted the inbound table, the receipts table, the
     * heartbeat, the event-type RPC and the auto-send flag, and produced a
     * schema the app fails against with nothing to say which piece was missing.
     *
     * A new migration lands in the add-on bundle by DEFAULT now, which is the
     * safe direction: shipping the host a table it does not need is a smaller
     * mistake than omitting one it does. This test only checks the split is
     * total and non-empty on both sides.
     */
    const all = allMigrations()
    expect(all.length).toBeGreaterThan(0)

    const host = bundledMigrations(true)
    const standalone = all.filter(isStandaloneOnly)

    expect(host.length + standalone.length).toBe(all.length)
    expect(host.length).toBeGreaterThan(0)
    expect(standalone.length).toBeGreaterThan(0)
  })

  it("keeps the platform stand-ins out of the host bundle", () => {
    // Applying these to GomaAI collides with businesses, business_members and
    // leads — every object they define already exists there.
    const host = bundledMigrations(true)
    expect(host).not.toContain("20260811000000_platform_standins.sql")
    expect(host).not.toContain("20260901010000_vertical_standin.sql")
  })

  it("keeps the add-on migration in it", () => {
    expect(bundledMigrations(true)).toContain("20260811010000_lifecycle_events.sql")
  })

  it("applies migrations in filename order", () => {
    // Filename order IS apply order, and a bundle that concatenated them in
    // readdir order would create a table after the trigger that references it.
    const all = allMigrations()
    expect([...all].sort()).toEqual(all)
  })
})
