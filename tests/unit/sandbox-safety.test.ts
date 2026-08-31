import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The sandbox must not be able to send.
 *
 * Source-level, and deliberately so: the failure it guards was not a logic bug
 * anyone could have caught in a unit test of a pure function. runTickNow called
 * the production cycle with no options, on a page that promised the handsets
 * were stand-ins — a promise that held only while REMINDER_DRY_RUN happened to
 * be set. When credentials arrived and dry run went off, one click put 21 real
 * template messages on real numbers and billed for each.
 *
 * What went wrong was a MISSING ARGUMENT at one call site, so that call site is
 * what gets pinned.
 */

const root = process.cwd()
const sandboxAction = readFileSync(join(root, "src/app/actions/sandbox.ts"), "utf8")
const runCycle = readFileSync(join(root, "src/lib/lifecycle/run-cycle.ts"), "utf8")

describe("the sandbox tick cannot reach WhatsApp", () => {
  it("asks for simulated delivery", () => {
    expect(sandboxAction).toMatch(/simulateDelivery:\s*true/)
  })

  it("bounds how much one click can do", () => {
    // A cron may take four minutes; a button held the page that long and was
    // reported as a hung deployment.
    expect(sandboxAction).toMatch(/maxDeliveries:\s*\d+/)
  })

  it("never calls the cycle without options", () => {
    // The exact shape of the original defect: runReminderCycle(createAdminClient())
    // with nothing after it.
    expect(sandboxAction).not.toMatch(/runReminderCycle\(\s*createAdminClient\(\)\s*\)/)
  })

  it("gates the real send on the flag rather than around it", () => {
    // The simulation must sit AT the Graph call, so everything above it —
    // claiming, drafting, clamping the template params — still runs. A sandbox
    // that skips the work it exists to demonstrate demonstrates nothing.
    expect(runCycle).toMatch(/options\.simulateDelivery[\s\S]{0,220}sendClientEventReminder/)
  })

  it("marks a simulated id so it can never pass as a Meta wamid", () => {
    expect(runCycle).toMatch(/`sandbox:\$\{/)
    // dry-run has its own prefix; neither may collide with Meta's "wamid." form.
    expect(runCycle).not.toMatch(/whatsappMessageId: `wamid/)
  })
})
