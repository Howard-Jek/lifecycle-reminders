/**
 * Which stored dates can actually produce a reminder.
 *
 * This exists because of the quietest failure the engine has. `event_type` is
 * free text on both sides — a `contact_events` row and a `reminder_rules` row —
 * and they are joined by exact string equality. Import a column as
 * `policy_renewal`, write a rule for `policy_expiry`, and the result is a
 * calendar full of dates, a queue that stays empty, and no error anywhere.
 *
 * Nothing in the schema can prevent that: making event_type an enum or a
 * foreign key is precisely the vertical assumption the engine is built not to
 * make. So it is caught here and surfaced in the UI instead.
 *
 * Pure and I/O-free so the rule can be tested directly rather than through a
 * page.
 */

export type EventTypeCount = { event_type: string; count: number }

export type CoverageGap = {
  event_type: string
  /** How many stored dates are affected — this is the size of the silence. */
  count: number
  /** An active rule exists for a type that differs only by punctuation or case. */
  nearMiss: string | null
}

export type Coverage = {
  covered: string[]
  gaps: CoverageGap[]
  /** Rules pointing at a type no contact has. Harmless, but usually a typo. */
  unusedRuleTypes: string[]
  /** Dates that can never fire, in total. */
  strandedEvents: number
}

/** Strip case and punctuation so `Policy Expiry`, `policy-expiry` and
 * `policy_expiry` are recognised as the same intent. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

export function computeCoverage(
  eventTypes: EventTypeCount[],
  activeRuleTypes: string[],
): Coverage {
  const ruleSet = new Set(activeRuleTypes)
  const ruleByFold = new Map<string, string>()
  for (const type of activeRuleTypes) {
    // First writer wins: with two rules folding the same, either is an equally
    // good suggestion and picking deterministically keeps the UI stable.
    if (!ruleByFold.has(fold(type))) ruleByFold.set(fold(type), type)
  }

  const covered: string[] = []
  const gaps: CoverageGap[] = []

  for (const { event_type, count } of eventTypes) {
    if (ruleSet.has(event_type)) {
      covered.push(event_type)
      continue
    }
    // A near miss is worth naming: "you wrote policy-expiry, the rule says
    // policy_expiry" is an instantly actionable message, where "no rule" is a
    // puzzle.
    gaps.push({ event_type, count, nearMiss: ruleByFold.get(fold(event_type)) ?? null })
  }

  const presentTypes = new Set(eventTypes.map((e) => e.event_type))
  const unusedRuleTypes = activeRuleTypes.filter((t) => !presentTypes.has(t))

  return {
    covered,
    // Biggest silence first — that is the one worth fixing.
    gaps: gaps.sort((a, b) => b.count - a.count),
    unusedRuleTypes,
    strandedEvents: gaps.reduce((sum, gap) => sum + gap.count, 0),
  }
}

/** One sentence for the banner. Null when there is nothing to say. */
export function describeCoverage(coverage: Coverage): string | null {
  if (coverage.gaps.length === 0) return null

  const dates = coverage.strandedEvents
  const noun = dates === 1 ? "date" : "dates"
  const types = coverage.gaps.map((g) => g.event_type)
  const list =
    types.length <= 3
      ? types.join(", ")
      : `${types.slice(0, 3).join(", ")} and ${types.length - 3} more`

  const nearMiss = coverage.gaps.find((g) => g.nearMiss)
  const hint = nearMiss
    ? ` Did you mean "${nearMiss.nearMiss}"? A rule matches an event type exactly.`
    : " Add a rule for it in Settings, or nothing will ever be sent for those dates."

  return `${dates} stored ${noun} can never produce a reminder — no active rule matches ${list}.${hint}`
}
