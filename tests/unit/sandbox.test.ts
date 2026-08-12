import { describe, it, expect } from "vitest"
import { renderReminderBody } from "@/lib/sandbox/record"
import {
  buildReminderComponents,
  reminderDeepLink,
  CLIENT_EVENT_REMINDER_TEMPLATE,
  CLIENT_EVENT_REMINDER_BODY_TEXT,
  clientEventReminderTemplateDefinition,
} from "@/lib/notify/client-event-reminder"

/**
 * The sandbox is only worth anything if it shows what Meta would really get.
 * These tests pin the two places that could silently drift: the placeholder
 * count, and the params the renderer is fed.
 */

const PARAMS = ["Jane Tan", "Policy expiry", "in a week", "Hi Jane, …", "https://x.test/contacts/1"]

describe("renderReminderBody", () => {
  it("substitutes all five positional params", () => {
    const rendered = renderReminderBody(PARAMS)
    for (const param of PARAMS) expect(rendered).toContain(param)
    expect(rendered).not.toMatch(/\{\{\d\}\}/)
  })

  it("leaves a placeholder visible when a param is missing", () => {
    // A visibly broken message is far easier to diagnose than a silently
    // truncated one — this is the whole reason it does not substitute "".
    const rendered = renderReminderBody(["only", "three", "given"])
    expect(rendered).toContain("{{4}}")
    expect(rendered).toContain("{{5}}")
  })

  it("is rendered from the SAME string the registration script submits", () => {
    // The defect this pins: the sandbox once carried its own copy of the body,
    // and it had already drifted from the one going to Meta for review. A
    // sandbox showing a message Meta never sends is evidence of nothing.
    const definition = clientEventReminderTemplateDefinition()
    const components = definition.components as Array<{ type: string; text: string }>
    const body = components.find((c) => c.type === "BODY")
    expect(body?.text).toBe(CLIENT_EVENT_REMINDER_BODY_TEXT)
  })

  it("does not promise a send button the product does not have", () => {
    // The agent copies the suggestion and sends it themselves — that human step
    // IS the product. Promising otherwise in a message that goes to Meta for
    // review, and to real agents, would be a lie in the most visible place.
    expect(CLIENT_EVENT_REMINDER_BODY_TEXT).not.toMatch(/dashboard/i)
  })

  it("obeys Meta's body rules — the ones that cost a review cycle to learn", () => {
    // All three of these are silent rejections at Meta's end, hours after you
    // submit. The body once broke two of them at the same time.
    const text = CLIENT_EVENT_REMINDER_BODY_TEXT
    expect(text, "two variables may not be adjacent, even separated by a space").not.toMatch(
      /\}\}\s*\{\{/,
    )
    expect(text, "body may not begin with a variable").not.toMatch(/^\s*\{\{\d+\}\}/)
    expect(text, "body may not end with a variable").not.toMatch(/\{\{\d+\}\}\s*$/)
    expect(text.length, "Meta's body limit is 1024 characters").toBeLessThanOrEqual(1024)
  })

  it("ships an example for every variable — Meta rejects a submission without them", () => {
    const definition = clientEventReminderTemplateDefinition()
    const components = definition.components as Array<{
      type: string
      text: string
      example?: { body_text?: string[][] }
    }>
    const body = components.find((c) => c.type === "BODY")!
    const examples = body.example?.body_text?.[0] ?? []
    const varCount = new Set(body.text.match(/\{\{\d+\}\}/g) ?? []).size
    expect(examples).toHaveLength(varCount)
    expect(examples.every((e) => e.trim().length > 0)).toBe(true)
  })

  it("declares exactly the five placeholders the template has", () => {
    // If the body copy ever gains a sixth variable, the sender still only sends
    // five params and Meta rejects the message. Pin the count here so that
    // drift is a failing test rather than a rejected send.
    const placeholders = CLIENT_EVENT_REMINDER_BODY_TEXT.match(/\{\{\d\}\}/g) ?? []
    expect(new Set(placeholders).size).toBe(5)
  })
})

describe("what the sandbox displays vs what is sent", () => {
  it("renders from the SAME clamped params the sender builds", () => {
    // The suggestion here is deliberately hostile: newlines and runs of spaces
    // are exactly what an AI draft contains, and exactly what Meta rejects.
    const components = buildReminderComponents({
      clientLabel: "Jane   Tan",
      eventLabel: "Policy expiry",
      whenText: "in a week",
      suggestion: "Hi Jane,\n\n   just checking in    about your policy.",
      deepLink: "https://x.test/contacts/1",
    })
    const params = (components[0].parameters as Array<{ text: string }>).map((p) => p.text)

    expect(params).toHaveLength(5)
    // Whitespace collapsed, so the transcript shows the sanitised value.
    expect(params[3]).toBe("Hi Jane, just checking in about your policy.")
    expect(params[0]).toBe("Jane Tan")

    const rendered = renderReminderBody(params)
    expect(rendered).toContain("Hi Jane, just checking in about your policy.")
    expect(rendered).not.toContain("   ")
  })

  it("truncates an overlong suggestion rather than failing the send", () => {
    const components = buildReminderComponents({
      clientLabel: "Jane Tan",
      eventLabel: "Policy expiry",
      whenText: "today",
      suggestion: "x".repeat(2000),
      deepLink: "https://x.test/contacts/1",
    })
    const params = (components[0].parameters as Array<{ text: string }>).map((p) => p.text)
    expect(params[3].length).toBeLessThanOrEqual(601)
    expect(params[3].endsWith("…")).toBe(true)
  })
})

describe("reminderDeepLink", () => {
  it("points at this app's own contact route", () => {
    // The prior art pointed at the host's /dashboard?lead=<id>, which 404s
    // here — and a dead deep link still looks like a perfectly good message.
    expect(reminderDeepLink("https://x.test", "abc")).toBe("https://x.test/contacts/abc")
  })

  it("does not double the slash when the base URL has a trailing one", () => {
    expect(reminderDeepLink("https://x.test/", "abc")).toBe("https://x.test/contacts/abc")
  })
})

describe("template identity", () => {
  it("is the name the registration script must submit", () => {
    // Registration, sending and the sandbox all have to agree on this string.
    expect(CLIENT_EVENT_REMINDER_TEMPLATE).toBe("client_event_reminder")
  })
})
