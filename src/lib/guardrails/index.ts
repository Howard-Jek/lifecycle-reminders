/**
 * Operator guardrails. Copied from the host so a rule written in GomaAI means
 * the same thing here, and so the suggestion prompt is byte-identical.
 *
 * Only the prompt half is ported: the banned-word enforcement scan belongs to
 * the reply loop, which this add-on does not have — a reminder suggestion is
 * drafted for a human to read and edit, never auto-sent.
 */
export type { Guardrails } from './types'
export { buildGuardrailsBlock } from './prompt'

/** No guardrails configured. Callers may use this unconditionally. */
export const NO_GUARDRAILS = {
  enabled: false,
  rules: [] as string[],
  bannedWords: [] as string[],
}
