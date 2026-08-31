import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { packForVertical } from "@/lib/lifecycle/vertical-packs"

/**
 * The industry switcher must not exist in production.
 *
 * Source-level, in the style of sandbox-safety.test.ts, because what is under
 * test is WHERE the checks sit. The failure mode is not a wrong return value —
 * it is a gate in one layer and not the others, which looks completely fine
 * from inside any single function.
 *
 * The specific trap: every export of a `"use server"` module is a public POST
 * endpoint, reachable whether or not anything renders a form for it. So a
 * render-time check alone is not a gate, and a cookie — being client-owned —
 * must do nothing on its own even when the write is unreachable.
 */

const root = process.cwd()
const switchModule = readFileSync(join(root, "src/lib/dev/vertical-switch.ts"), "utf8")
const layout = readFileSync(join(root, "src/app/(app)/layout.tsx"), "utf8")
const currentPack = readFileSync(join(root, "src/lib/lifecycle/current-pack.ts"), "utf8")

const fn = (source: string, name: string) => {
  const start = source.indexOf(`export async function ${name}(`)
  const next = source.indexOf("export async function ", start + 1)
  return source.slice(start, next === -1 ? undefined : next)
}

describe("the dev industry switcher is gated in all three layers", () => {
  it("gates the READ, so a hand-planted cookie does nothing", () => {
    expect(fn(switchModule, "devVerticalOverride")).toMatch(/isProductionRuntime\(\)/)
  })

  it("gates the WRITE, because a server action is a public endpoint", () => {
    expect(fn(switchModule, "setDevVertical")).toMatch(/isProductionRuntime\(\)/)
  })

  it("gates the RENDER", () => {
    expect(layout).toMatch(/!isProductionRuntime\(\) && <VerticalSwitcher/)
  })

  it("validates the value against the real list before writing it", () => {
    // So a crafted POST can only ever name a pack that exists, and the write
    // can never produce a value the database CHECK would refuse.
    expect(fn(switchModule, "setDevVertical")).toMatch(/isVertical\(/)
  })
})

describe('the "use server" module exports only server actions', () => {
  it("declares no non-async exports", () => {
    /**
     * Next treats every export of a "use server" module as a callable server
     * action, so a single non-async export makes the WHOLE module resolve to
     * nothing — "the module has no exports at all". It took the switcher, the
     * layout and every page importing currentPack down with it.
     *
     * Neither tsc nor vitest can see this: both resolve the file normally. It
     * appears only at `next build`, which is a slow way to find out. The cookie
     * name lives in vertical-cookie.ts for exactly this reason.
     */
    expect(switchModule).toMatch(/^"use server"/)
    const exports = [...switchModule.matchAll(/^export\s+(?!type\b)(\w+)/gm)].map((m) => m[1])
    expect(exports.length).toBeGreaterThan(0)
    expect(exports.every((kw) => kw === "async")).toBe(true)
  })
})

describe("switching takes effect immediately", () => {
  it("revalidates, because a cookie write re-renders nothing on its own", () => {
    /**
     * The defect this pins had no error and no symptom beyond "the button does
     * nothing": the cookie was stored correctly and every LATER request saw it,
     * but the page already on screen kept the labels it was built with. It only
     * appeared to work if you happened to navigate afterwards.
     *
     * "layout" scope because the pack reaches the shell as well as the page —
     * revalidating the page alone leaves the dropdown showing one industry
     * while the table underneath shows another.
     */
    expect(fn(switchModule, "setDevVertical")).toMatch(/revalidatePath\("\/", "layout"\)/)
  })

  it("revalidates when clearing the override too", () => {
    // The reset path is the one you reach for when something looks wrong, so
    // it appearing not to work is worse than the set path doing the same.
    const setter = fn(switchModule, "setDevVertical")
    const clearBranch = setter.slice(0, setter.indexOf("if (!isVertical("))
    expect(clearBranch).toMatch(/revalidatePath/)
  })
})

describe("the control agrees with what it controls", () => {
  it("keys the select on the server value so it remounts when the pack changes", () => {
    // defaultValue is uncontrolled — React sets it once and never touches the
    // DOM value again. Without a key, the dropdown kept the last thing picked
    // in it while the labels underneath had already moved on.
    const component = readFileSync(
      join(root, "src/components/dev/vertical-switcher.tsx"),
      "utf8",
    )
    expect(component).toMatch(/key=\{current \?\? "none"\}/)
  })
})

describe("the override has exactly one consumer", () => {
  it("is read only by currentPack, so deleting it at integration is one line", () => {
    expect(currentPack).toMatch(/devVerticalOverride\(\)/)
  })

  it("is not read anywhere else in src, apart from the shell that renders it", () => {
    // The shell reads it to show the current selection. Any OTHER consumer
    // would be a second place to remember at integration.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) return walk(full)
        return /\.tsx?$/.test(entry.name) ? [full] : []
      })

    const hits = walk(join(root, "src"))
      .filter((file) => readFileSync(file, "utf8").includes("devVerticalOverride"))
      .map((file) => file.replace(root + "/", ""))
      .sort()

    expect(hits).toEqual([
      "src/app/(app)/layout.tsx",
      "src/lib/dev/vertical-switch.ts",
      "src/lib/lifecycle/current-pack.ts",
    ])
  })
})

describe("an override can never widen what the app will accept", () => {
  it("resolves a bogus value to the generic pack rather than throwing", () => {
    // The cookie is client-owned. packForVertical is total over strings, so
    // even if every gate above were removed the worst outcome is generic
    // labels — not a crash on every page of the app.
    for (const bad of ["", "INSURANCE", "'; drop table reminders;--", "other_"]) {
      expect(packForVertical(bad)).toBe(packForVertical(null))
    }
  })
})
