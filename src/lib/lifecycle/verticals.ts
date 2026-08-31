/**
 * ╔════════════════════════════════════════════════════════════════════════╗
 * ║  PLATFORM STAND-IN — REPLACED, NOT PORTED, WHEN INTEGRATING INTO       ║
 * ║  GomaAI.                                                               ║
 * ║                                                                        ║
 * ║  At integration the entire body of this file becomes one line:         ║
 * ║                                                                        ║
 * ║    export { VERTICALS, VERTICAL_LABELS, type Vertical } from "@/lib/types"  ║
 * ║                                                                        ║
 * ╚════════════════════════════════════════════════════════════════════════╝
 *
 * The TypeScript sibling of 20260901010000_vertical_standin.sql, and it exists
 * for the same reason: the standalone has to run alone, and the host is the
 * source of truth.
 *
 * WHY THIS FILE RATHER THAN src/lib/types.ts, which is where the host keeps it:
 * the standalone's `src/lib/types.ts` becomes `src/lib/reminders/types.ts` at
 * integration (see docs — the host owns that path). Defining the verticals
 * there would leave TWO copies of the enum in the merged app, the second one
 * free to drift away from `businesses_vertical_check` with nothing to notice.
 * `src/lib/lifecycle/` keeps its path, so putting it here makes the merge a
 * one-line edit to one file.
 *
 * Copied verbatim from the host's src/lib/types.ts. If you add a vertical,
 * add it THERE first, then here, then in the CHECK constraint.
 */

/**
 * The business verticals, in the host's declaration order — which is also the
 * order of the CHECK constraint. This is NOT display order: the industry picker
 * sorts by label and pins `other` last, which is a UI decision and lives there.
 *
 * `other` is a real stored value rather than free text, because it is what the
 * host's guardrail policies and template library match on. "None of these fit"
 * is an answer; NULL means the question has not been asked.
 */
export const VERTICALS = [
  "mortgage",
  "insurance",
  "financial_advisory",
  "real_estate",
  "dental",
  "beauty",
  "construction",
  "fitness",
  "home_services",
  "saas",
  "training",
  "other",
] as const

export type Vertical = (typeof VERTICALS)[number]

/** Human-readable vertical names. */
export const VERTICAL_LABELS: Record<Vertical, string> = {
  mortgage: "Mortgage / loans",
  insurance: "Insurance",
  financial_advisory: "Financial advisory",
  real_estate: "Real estate",
  dental: "Dental / healthcare",
  beauty: "Beauty & aesthetics",
  construction: "Construction & renovation",
  fitness: "Fitness & wellness",
  home_services: "Home & local services",
  saas: "SaaS / Software",
  training: "Education & Training",
  other: "Something else",
}

/**
 * Narrow an untrusted string — a form field, a cookie, a database column that
 * predates the constraint — to a Vertical.
 *
 * Everything that can write this value goes through here, so a value the DB
 * would refuse never reaches the update and comes back as a Postgres error the
 * operator cannot read.
 */
export function isVertical(value: unknown): value is Vertical {
  return typeof value === "string" && (VERTICALS as readonly string[]).includes(value)
}

/**
 * The picker's options: alphabetical by label, with the catch-all pinned last
 * so it reads as the fallback rather than as one more industry.
 *
 * Mirrors the host's INDUSTRY_OPTIONS (src/lib/onboarding-verticals.ts) so the
 * two screens present the same list in the same order.
 */
export const INDUSTRY_OPTIONS: ReadonlyArray<{ value: Vertical; label: string }> = [
  ...VERTICALS.filter((v) => v !== "other")
    .map((value) => ({ value, label: VERTICAL_LABELS[value] }))
    .sort((a, b) => a.label.localeCompare(b.label)),
  { value: "other" as const, label: VERTICAL_LABELS.other },
]
