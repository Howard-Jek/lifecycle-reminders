import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { testMessageParams, sendRosterTestMessage } from "@/lib/notify/test-message"

/**
 * The test send is the only message this app puts on a handset on demand, and
 * it is the only one an operator can trigger by hand. Two things have to hold:
 * it must be recognisable as a test, and it must never fire on its own.
 */

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("the message says it is a test", () => {
  it("labels the contact and the event as tests rather than inventing a client", () => {
    // A realistic-looking sample — "Jane Tan, policy expiry in a month" — is
    // indistinguishable from a real reminder on the handset, and an agent who
    // believes it will phone a customer about a policy that is not expiring.
    const p = testMessageParams()
    expect(p.clientLabel).toMatch(/test/i)
    expect(p.eventLabel).toMatch(/test/i)
    expect(p.suggestion).toMatch(/test message from Lifecycle/i)
  })

  it("says what a delivered message proves", () => {
    // The point of the send is the inference the reader is meant to draw, so
    // the message states it rather than leaving it implied.
    expect(testMessageParams().suggestion).toMatch(/template is approved and delivery works/i)
  })

  it("carries an absolute deep link", () => {
    // Body variable {{5}} is rendered as a link by WhatsApp only if it is
    // absolute; a relative path arrives as plain text and goes nowhere.
    process.env.APP_PUBLIC_URL = "https://example.test"
    expect(testMessageParams().deepLink).toBe("https://example.test/reminders")
  })

  it("never renders an empty link, even with no APP_PUBLIC_URL", () => {
    delete process.env.APP_PUBLIC_URL
    expect(testMessageParams().deepLink).toMatch(/^https:\/\/\S+\/reminders$/)
  })
})

describe("sendRosterTestMessage", () => {
  beforeEach(() => {
    delete process.env.REMINDER_DRY_RUN
    delete process.env.GOMA_NOTIFY_PHONE_NUMBER_ID
    delete process.env.GOMA_NOTIFY_ACCESS_TOKEN
  })

  it("refuses a member with no number, and names them", async () => {
    const result = await sendRosterTestMessage({
      id: "m1",
      display_name: "Marcus Lee",
      whatsapp_number: null,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    // `no_number`, NOT `not_configured`: with credentials absent both paths end
    // in a refusal, and reporting the wrong one sends the operator to the
    // environment variables to fix a missing phone number on a roster row.
    expect(result.reason).toBe("no_number")
    expect(result.error).toContain("Marcus Lee")
  })

  it("says the credentials are missing when they are", async () => {
    const result = await sendRosterTestMessage({
      id: "m1",
      display_name: "Howard",
      whatsapp_number: "+6581115611",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("not_configured")
    expect(result.error).toMatch(/GOMA_NOTIFY_PHONE_NUMBER_ID/)
  })

  it("reports a dry run as a dry run, not as a delivery", async () => {
    // The trap this closes: dry run stamps a synthetic id and returns ok, so
    // without the flag travelling out with the result the UI would say "sent"
    // about a message that never left — and the operator's obvious conclusion
    // ("it says sent, my phone says nothing") would be wrong.
    process.env.REMINDER_DRY_RUN = "1"
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      const result = await sendRosterTestMessage({
        id: "m1",
        display_name: "Howard",
        whatsapp_number: "+6581115611",
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.dryRun).toBe(true)
      expect(result.whatsappMessageId).toMatch(/^dry-run:/)
      // Echoed back rather than re-read by the caller: what gets shown is the
      // number the message was actually addressed to.
      expect(result.to).toBe("+6581115611")
    } finally {
      log.mockRestore()
    }
  })
})

/**
 * Source-level, because what matters is a call that must NOT exist.
 *
 * Every send costs money — which is the stated reason automatic sending is
 * switched off on this deployment — so adding a member must offer the test
 * rather than perform it. That is a property of where the call sites are, not
 * of any value a function returns.
 */
const root = process.cwd()
const teamClient = readFileSync(join(root, "src/app/(app)/team/team-client.tsx"), "utf8")
const teamActions = readFileSync(join(root, "src/app/actions/team-members.ts"), "utf8")
const panel = readFileSync(join(root, "src/app/(app)/team/test-message-panel.tsx"), "utf8")

describe("nothing sends without a click", () => {
  it("has exactly one place that calls the action", () => {
    const calls = teamClient.match(/await sendTestMessage\(/g) ?? []
    expect(calls).toHaveLength(1)
  })

  it("does not send from the save path", () => {
    const save = teamClient.slice(
      teamClient.indexOf("function saveMember"),
      teamClient.indexOf("function runTestSend"),
    )
    expect(save.length).toBeGreaterThan(0)
    expect(save).not.toMatch(/sendTestMessage/)
    // What it does instead: stage a target for the operator to confirm.
    expect(save).toMatch(/stageOffer\(/)
  })

  it("scopes the send to the caller's own roster", () => {
    // The business filter is the access control, not a convenience: every
    // export of a "use server" module is a public POST endpoint, so without it
    // this is an authenticated relay to any member uuid a caller can guess.
    const action = teamActions.slice(teamActions.indexOf("export async function sendTestMessage"))
    expect(action).toMatch(/requireTenant\(\)/)
    expect(action).toMatch(/\.eq\("business_id", tenant\.businessId\)/)
  })
})

describe("the panel states the cost before it is incurred", () => {
  it("never makes the cost line conditional on dry run", () => {
    // The bug this pins: the caution wash was rendered as `{dryRun && ...}`, so
    // it showed in the mode where nothing is billed and vanished in the mode
    // where every click spends money — the panel at its quietest exactly when
    // it had the most to say. The line is now unconditional and only its TONE
    // depends on the mode.
    expect(panel).not.toMatch(/\{dryRun &&/)
  })

  it("names the destination in the live copy, not just in dry run", () => {
    const live = panel.slice(panel.indexOf("This sends"))
    expect(live).toMatch(/target\.number/)
    expect(live).toMatch(/bills for it/)
  })

  it("labels the button from the send's own flag, not the shared one", () => {
    // `pending` is true for every action on the page, so using it here made the
    // button read "Sending…" while an unrelated calendar feed was being issued
    // — a false statement about a billed action, on the control that makes it.
    expect(panel).toMatch(/\{sending \? "Sending…"/)
    expect(panel).not.toMatch(/\{pending \? "Sending…"/)
  })
})
