import { anthropic } from "@ai-sdk/anthropic"
import { openai } from "@ai-sdk/openai"

/**
 * The models behind the one model call in this product.
 *
 * Kept in a single module on purpose: at integration this is the one line that
 * has to agree with the host app, which currently pins claude-sonnet-4-6.
 * Keys are read implicitly by the provider packages from ANTHROPIC_API_KEY and
 * OPENAI_API_KEY — the same idiom as the host, which plumbs neither by hand.
 */
export const REMINDER_MODEL = anthropic("claude-sonnet-5")

/** Used only when Anthropic is out of capacity, never as a preference. */
export const REMINDER_FALLBACK_MODEL = openai("gpt-4o")

/**
 * Is this an "Anthropic is busy" error rather than a real failure?
 *
 * Only capacity errors are worth a second provider: a malformed prompt or a
 * schema mismatch would fail identically on OpenAI and just cost twice.
 */
export function isCapacityError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  return (
    msg.includes("overloaded") ||
    msg.includes("rate_limit") ||
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("529")
  )
}
