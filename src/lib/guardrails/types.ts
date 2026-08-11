/**
 * Operator-level guardrails resolved at reply time. `enabled === false`
 * short-circuits the whole layer — no prompt block, no banned-word scan.
 */
export type Guardrails = {
  enabled: boolean
  /** Free-text behavioural rules, one per line, already trimmed of blanks. */
  rules: string[]
  /** Literal terms the AI reply must never contain. */
  bannedWords: string[]
}

/** A single banned-word enforcement event, handed to the audit logger. */
export type GuardrailHit = {
  attempt: 1 | 2
  outcome: 'regenerated' | 'deferred'
  matchedWords: string[]
  blockedText: string
}
