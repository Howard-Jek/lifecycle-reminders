import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MAX_PER_CLICK } from "@/lib/lifecycle/send-limits"

/**
 * The switch that stands between a timer and a bill.
 *
 * Source-level, like sandbox-safety.ts, and for the same reason: what matters
 * is not a value a function returns but WHERE a check sits. Sending used to be
 * switched off by deleting the schedulers, and disabling one of the two looked
 * like switching sending off while the other went on firing for days. The gate
 * now lives in the cycle, so every driver — Vercel Cron, GitHub Actions,
 * scripts/tick.ts — passes through it whether or not anyone remembered to.
 */

const root = process.cwd()
const runCycle = readFileSync(join(root, "src/lib/lifecycle/run-cycle.ts"), "utf8")
const sendActions = readFileSync(join(root, "src/app/actions/send-reminders.ts"), "utf8")

/** deliverDue, where the gate lives. */
const deliverDue = runCycle.slice(
  runCycle.indexOf("async function deliverDue"),
  runCycle.indexOf("async function loadDeliveryContext"),
)

describe("the automatic-send gate", () => {
  it("is checked inside the cycle, not in a route", () => {
    // In the route it would guard one driver. There are three.
    expect(deliverDue).toMatch(/auto_send_enabled/)
    expect(deliverDue.indexOf("auto_send_enabled")).toBeGreaterThan(0)
  })

  it("fails closed when the flag cannot be read", () => {
    // "I do not know whether sending is allowed" must never resolve to sending.
    const gate = deliverDue.slice(deliverDue.indexOf("auto_send_enabled"))
    const onError = gate.slice(gate.indexOf("gateError"), gate.indexOf("const ids"))
    expect(onError).toMatch(/return \{ sent: 0, failed: 0, skipped: 0 \}/)
  })

  it("queries nothing at all when no business has it switched on", () => {
    // The off path must not claim, draft, or send — it costs one SELECT.
    expect(deliverDue).toMatch(/ids\.length === 0[\s\S]{0,200}return \{ sent: 0/)
  })

  it("lets a manual send bypass the gate", () => {
    // The flag governs the SCHEDULER. An operator who switched automatic
    // sending off must still be able to send the reminder they are looking at,
    // or the switch reads as a lock on their own account.
    const manual = deliverDue.slice(deliverDue.indexOf("if (manual)"), deliverDue.indexOf("} else"))
    expect(manual).not.toMatch(/auto_send_enabled/)
    expect(manual).toMatch(/\.in\("id", ids\)/)
  })

  it("applies due_at only to the automatic path", () => {
    // A human looking at a row is a better authority on whether it should go
    // out than its timestamp; a timer is not.
    const manual = deliverDue.slice(deliverDue.indexOf("if (manual)"), deliverDue.indexOf("} else"))
    // The FILTER call, not the substring — the branch's comment says "due_at"
    // while explaining that it deliberately does not apply one.
    expect(manual).not.toMatch(/\.lte\("due_at"/)
    const auto = deliverDue.slice(deliverDue.indexOf("} else"), deliverDue.indexOf("const { data, error } = await query"))
    expect(auto).toMatch(/lte\("due_at"/)
  })
})

describe("reminders for a deactivated agent", () => {
  it("are filtered out before they are claimed", () => {
    // Claiming burns an attempt. These rows are held, not spent: reactivate the
    // agent and they flow again.
    const filter = deliverDue.slice(deliverDue.indexOf("inactiveSkips"))
    expect(filter).toMatch(/!member\.active/)
    expect(deliverDue.indexOf("inactiveSkips")).toBeLessThan(deliverDue.indexOf("claimReminder"))
  })

  it("are never marked terminal", () => {
    // A deactivated agent is a reversible condition. Resolving their reminders
    // to `skipped` would destroy real work to record something temporary.
    const filter = deliverDue.slice(
      deliverDue.indexOf("const due: DueRow[] = []"),
      deliverDue.indexOf("const tenantCache"),
    )
    expect(filter).not.toMatch(/releaseReminder|status:/)
  })

  it("are held by the manual path too", () => {
    // Otherwise "Send all" spends a billed message per deactivated agent —
    // which on this deployment was every single row in Needs attention.
    expect(sendActions).toMatch(/heldForInactiveAgent/)
    expect(sendActions).toMatch(/\.eq\("team_members\.active", false\)/)
  })
})

describe("the per-click ceiling", () => {
  it("is defined once, so the dialog cannot promise what the server will not do", () => {
    const dialog = readFileSync(join(root, "src/components/send-actions.tsx"), "utf8")
    // Neither side may hard-code a number: the dialog states "only N go per
    // press", and the server enforces N. Two literals would drift.
    expect(dialog).toMatch(/maxPerClick/)
    expect(dialog).not.toMatch(/MAX_PER_CLICK = \d/)
    expect(sendActions).toMatch(/from "@\/lib\/lifecycle\/send-limits"/)
  })

  it("is small enough that a press cannot hang the page", () => {
    // Each delivery is a model call plus a Graph call.
    expect(MAX_PER_CLICK).toBeGreaterThan(0)
    expect(MAX_PER_CLICK).toBeLessThanOrEqual(25)
  })
})

describe("bulk sending is scoped to what the tab shows", () => {
  it("builds its target list from the shared scope predicates", () => {
    // Same discipline as the Clear button: the number on the control and the
    // rows it acts on come from one definition, so a bulk SPEND cannot drift
    // from the count beside it.
    expect(sendActions).toMatch(/applyReminderScope/)
  })

  it("refuses tabs where sending would be wrong", () => {
    // "Sent" would deliver a second copy of a message already read.
    expect(sendActions).toMatch(/scope\.tab !== "due" && scope\.tab !== "attention"/)
  })

  it("never requeues a row a worker is mid-send on", () => {
    expect(sendActions).toMatch(/\.neq\("status", "claimed"\)/)
  })

  it("clears the message id when requeueing", () => {
    // The stuck-claim sweep treats a row that still has a wamid as already
    // delivered, so leaving it set makes the row permanently un-sendable.
    const fn = sendActions.slice(sendActions.indexOf("async function requeue"))
    expect(fn).toMatch(/whatsapp_message_id: null/)
    expect(fn).toMatch(/attempts: 0/)
  })
})
