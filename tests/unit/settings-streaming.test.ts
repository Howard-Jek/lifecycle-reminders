import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Settings must not wait on Meta before it renders.
 *
 * Source-level for the same reason as sandbox-safety.ts: the defect was not a
 * wrong value from a function, it was WHICH WAVE a call sat in. getWhatsappSetup
 * fetched the template's review state from graph.facebook.com inside the page's
 * top-level `Promise.all`, with no deadline, so a slow minute at Meta held back
 * three cards that only ever read Postgres. It measured as the slowest route in
 * the app.
 *
 * The deadline-free fetch is correct and must stay — this is the page an
 * operator opens in order to read that status, so capping or caching it here
 * would answer the question wrongly. What is pinned is that being late costs
 * one block rather than the whole page.
 */

const root = process.cwd()
const page = readFileSync(join(root, "src/app/(app)/settings/page.tsx"), "utf8")
const action = readFileSync(join(root, "src/app/actions/whatsapp.ts"), "utf8")

/** The page's one blocking wave. */
const blockingWave = page.slice(page.indexOf("await Promise.all(["), page.indexOf("return ("))

describe("the Settings page renders on Postgres speed", () => {
  it("does not await the template status in the blocking wave", () => {
    expect(blockingWave).not.toMatch(/getTemplateStatus/)
  })

  it("still awaits the cheap env-only config there", () => {
    // The credential check and the dry-run notice cost nothing to know, so
    // streaming them too would be a placeholder in front of a ready answer.
    expect(blockingWave).toMatch(/getWhatsappConfig\(\)/)
  })

  it("puts the remote call behind a Suspense boundary", () => {
    expect(page).toMatch(/<Suspense/)
    expect(page).toMatch(/getTemplateStatus\(\)/)
  })

  it("reserves space rather than collapsing to nothing", () => {
    // A `fallback={null}` here would shove the two cards below it up and then
    // back down on arrival — the regression this pattern already caused once on
    // the reminder inbox.
    expect(page).not.toMatch(/fallback=\{null\}/)
    expect(page).toMatch(/fallback=\{[\s\S]{0,200}TemplateBlock/)
  })

  it("keeps the status fetch free of a deadline", () => {
    const fn = action.slice(action.indexOf("export async function getTemplateStatus"))
    expect(fn).not.toMatch(/AbortController|setTimeout|signal/)
  })

  it("keeps the config fetch free of any network call", () => {
    const fn = action.slice(
      action.indexOf("export async function getWhatsappConfig"),
      action.indexOf("export async function getTemplateStatus"),
    )
    expect(fn.length).toBeGreaterThan(0)
    expect(fn).not.toMatch(/fetchTemplateStatus|fetch\(/)
  })
})
