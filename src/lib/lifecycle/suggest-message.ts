/**
 * Draft the message an agent could send a client about an upcoming lifecycle
 * event.
 *
 * A single generateObject call — no tool loop. There is nothing to look up and
 * no multi-step decision to make: the profile, the event and the operator's
 * rules are all known up front, so an agent loop here would be cost and latency
 * for no benefit.
 *
 * The suggestion is ALWAYS a draft for a human. It is delivered to the agent,
 * never to the client, and the reminder is sent with or without it — a drafting
 * failure must never swallow the reminder itself, which is the part that
 * actually matters.
 */

import { generateObject } from "ai"
import { REMINDER_MODEL, REMINDER_FALLBACK_MODEL, isCapacityError } from "@/lib/ai/model"
import { z } from "zod"
import { escapeXml } from "@/lib/xml"
import { buildGuardrailsBlock } from "@/lib/guardrails"
import type { Guardrails } from "@/lib/guardrails/types"

// No .int() and no min/max: Anthropic's structured output rejects numeric
// bounds on integers, which is why the other Anthropic paths avoid them too
// (see CLAUDE.md). A single string field sidesteps the issue entirely.
const suggestionSchema = z.object({
  message: z
    .string()
    .describe(
      "The WhatsApp message the agent could send, ready to copy. Under 60 words, warm, specific to this client and event.",
    ),
})

const SYSTEM_PROMPT = `
<role>
You draft a short WhatsApp message for a human agent to send to their own client
about an upcoming date. The agent reads your draft, edits it if they want, and
sends it themselves. You are never talking to the client directly.
</role>

<rules>
  <rule>Write as the AGENT, in first person, to the client.</rule>
  <rule>You are given the client's FULL NAME as their agent recorded it. Choose how to
  address them, and choose carefully: name order is not universal. In most Chinese,
  Korean and Vietnamese names the FAMILY name comes first — "Goh Jia Hui" is Ms Goh,
  and greeting her "Hi Goh" is wrong in the same way "Hi Smith" would be. When the
  given name is not obvious, greet them warmly without a name rather than guess.</rule>
  <rule>Under 60 words. WhatsApp style — warm, plain, human. Not an email, no "Dear".</rule>
  <rule>One message. No subject line, no sign-off block, no placeholders like [name].</rule>
  <rule>Reference the specific event naturally. A birthday is a greeting, NOT a sales pitch — do not attach an offer to it.</rule>
  <rule>NEVER invent a figure, date, reference number, product name or entitlement that is not given to you. If a detail would help but you do not have it, write around it.</rule>
  <rule>Do not promise outcomes, returns, approval, or pricing.</rule>
  <rule>When the date is about something the client HOLDS — an expiry, a renewal, a review — the goal is to open a conversation. Offer to talk it through; do not try to close.</rule>
  <rule>Output the message text only.</rule>
</rules>
`.trim()

export type SuggestionInput = {
  /** The client's full name, exactly as their agent recorded it. */
  clientName: string
  /** 'birthday' | 'policy_expiry' | … — free text, straight from the event. */
  eventType: string
  /** Operator's own label for the event, when they set one. */
  eventLabel: string | null
  /** Humanised lead time, e.g. "in a month". */
  whenText: string
  /** The event's own payload (policy number, insurer …), already tenant-scoped. */
  eventPayload: Record<string, unknown>
  /** Extra CSV columns carried on the lead, same convention as the reply prompt. */
  leadContext: Record<string, unknown>
  /**
   * One clause describing this operator's industry, from their reminder pack.
   *
   * Spliced in rather than baked into SYSTEM_PROMPT because the prompt has to
   * be true for a dentist and a mortgage broker at once, and "a policy expiry"
   * is not. It is also where a vertical states a PROHIBITION — dental forbids
   * naming a procedure, because event payloads come from the operator's own
   * spreadsheet and may well contain one.
   */
  industryFraming: string
  /** The agent's display name, so the draft can sound like them. */
  agentName: string | null
  guardrails: Guardrails
}

/** Render a small, escaped fact block. Values are operator/CSV data, so they
 * are escaped for the same reason the reply prompt escapes lead input. */
function renderFacts(label: string, obj: Record<string, unknown>): string {
  const entries = Object.entries(obj).filter(
    ([, v]) => v != null && v !== "" && typeof v !== "object",
  )
  if (entries.length === 0) return ""
  const rows = entries
    .slice(0, 20)
    .map(([k, v]) => `  <fact key="${escapeXml(k)}">${escapeXml(String(v))}</fact>`)
    .join("\n")
  return `<${label}>\n${rows}\n</${label}>`
}

/**
 * The operator's industry, as its own block.
 *
 * A block rather than an interpolation into <rules>, so a pack that carries a
 * prohibition cannot be read as one item in a list of stylistic preferences.
 */
export function buildIndustryBlock(framing: string): string {
  const text = framing.trim()
  return text ? `<industry>\n${text}\n</industry>` : ""
}

export function buildSuggestionPrompt(input: SuggestionInput): string {
  return [
    `<client><full_name>${escapeXml(input.clientName)}</full_name></client>`,
    `<event>`,
    `  <type>${escapeXml(input.eventType)}</type>`,
    input.eventLabel ? `  <label>${escapeXml(input.eventLabel)}</label>` : "",
    `  <when>${escapeXml(input.whenText)}</when>`,
    `</event>`,
    renderFacts("event_details", input.eventPayload),
    renderFacts("client_details", input.leadContext),
    input.agentName ? `<agent><name>${escapeXml(input.agentName)}</name></agent>` : "",
    ``,
    `Draft the message.`,
  ]
    .filter(Boolean)
    .join("\n")
}

/** A safe, generic line used when drafting is off or fails. Deliberately says
 * nothing specific — an agent can send it as-is without checking any facts. */
export function fallbackSuggestion(eventType: string): string {
  // Deliberately nameless. Picking a form of address from a full name is a
  // judgement call — which is why the model does it — and this line exists for
  // exactly the moments the model was unavailable. Guessing here would put
  // "Hi Goh" in front of a client whose given name is Jia Hui.
  if (eventType === "birthday") {
    return "Happy birthday! Hope you have a lovely day."
  }
  return "Hi! Just reaching out about something coming up on your account — do you have a few minutes this week for a quick chat?"
}

/**
 * Draft a suggestion. Returns null on any failure — the caller then sends the
 * reminder with the fallback line. Never throws.
 */
export async function draftSuggestion(input: SuggestionInput): Promise<string | null> {
  const system = [SYSTEM_PROMPT, buildIndustryBlock(input.industryFraming), buildGuardrailsBlock(input.guardrails)]
    .filter(Boolean)
    .join("\n\n")
  const args = { schema: suggestionSchema, system, prompt: buildSuggestionPrompt(input) }

  try {
    let object
    try {
      ;({ object } = await generateObject({ model: REMINDER_MODEL, ...args }))
    } catch (err) {
      if (!isCapacityError(err)) throw err
      ;({ object } = await generateObject({ model: REMINDER_FALLBACK_MODEL, ...args }))
    }
    const message = object.message?.trim()
    return message ? message : null
  } catch (err) {
    console.error(
      `[lifecycle] suggestion drafting failed for ${input.eventType}:`,
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}
