/**
 * A starting configuration of this engine for one industry.
 *
 * The engine itself is vertical-agnostic and stays that way: `event_type` is
 * free text, and the types a business actually uses are derived from its own
 * rows (see event-types.ts). Nothing here is consulted at schedule time. A pack
 * is a STARTING POINT and a set of LABELS — what to seed into `reminder_rules`
 * on day one, what to call the things a contact holds, how to word the prompt.
 * The operator can edit or delete any of it the moment they arrive.
 *
 * That distinction is the whole design. Insurance was never special in the
 * engine; it was special in the seed data and the copy. This makes the seed
 * data and the copy a parameter instead.
 *
 * PURE DATA — no I/O, no Supabase import, no `use server`. Mirrors the host's
 * src/lib/outreach-templates/library.ts, which solves the identical problem
 * (industry-specific starting content, generic fallback) the identical way.
 *
 * COVERAGE IS DELIBERATELY PARTIAL. A vertical with no entry gets GENERIC_PACK
 * and works completely — the host does the same: its playbook seeds cover ten
 * of twelve verticals and its guardrail policies eight. An industry without a
 * hand-authored pack is a normal starting point, not a dead end.
 */

import type { Recurrence, ReminderRule } from "./types"
import { PERSONAL_EVENT_TYPES } from "./event-types"
import type { Vertical } from "./verticals"

/** An event type this industry expects to see, offered before any exist. */
export type PackEventType = {
  /** Stored on contact_events.event_type. Lower snake case. */
  slug: string
  /** Operator-facing. humaniseEventType() is the fallback for unknown slugs. */
  label: string
  /** What the import wizard should default this column to. */
  recurrence: Recurrence
  /**
   * Header patterns that mark a spreadsheet column as a DATE column.
   *
   * Detection only. These never decide what an event_type is called — see
   * eventTypeFromHeader, and the "Visa Expiry" bug in its header. Widening
   * detection is safe; renaming a type from a guess is not.
   */
  synonyms: readonly RegExp[]
}

/** What this industry calls the things a contact holds. */
export type HoldingLabels = {
  /** Column head on Contacts. "Policy dates". */
  column: string
  /** The inbox bucket, always true of every holding type. "Policies". */
  bucket: string
  /**
   * A narrower word, claimed ONLY when every type in the bucket earns it.
   *
   * A review is not a renewal. The existing code was already careful about
   * this for insurance; the pack carries the rule rather than replacing it.
   * Null means this industry has no narrower word worth claiming.
   */
  narrow: { label: string; pattern: RegExp } | null
  /** Mid-sentence, lower case. "counted by the {inline} on file". */
  inline: string
}

export type PackRule = Pick<ReminderRule, "event_type" | "offset_days" | "send_window"> & {
  label: string
}

export type VerticalPack = {
  key: Vertical | "generic"
  /** Names the rule set in button and checklist copy: "the {name} rules". */
  name: string
  holding: HoldingLabels
  /**
   * Slugs this industry treats as personal, ADDED to PERSONAL_EVENT_TYPES.
   *
   * Additive only, and that is load-bearing. The base set is used in a
   * cross-tenant, business-unscoped query (the personal stuck-claim sweep in
   * claim-reminder.ts), which cannot consult a per-business pack. Keeping the
   * base universal keeps that sweep correct. A pack that could REMOVE
   * `birthday` would let a birthday be counted and retried as a product date,
   * which is the one thing the personal/holding split exists to prevent.
   */
  personalExtra: readonly string[]
  eventTypes: readonly PackEventType[]
  rules: readonly PackRule[]
  /** One clause spliced into the drafting prompt. See suggest-message.ts. */
  framing: string
  /** Empty-state copy in the import wizard's date-column section. */
  importHint: string
  /** tests/fixtures filename, or null for the generic sheet. */
  fixture: string | null
}

// ── shared pieces ───────────────────────────────────────────────────────────

/**
 * Every industry has people in it, and people have birthdays.
 *
 * Split out because it is the only content every pack shares, and because a
 * pack that wants the dates without the rules (see saas) needs to say so
 * explicitly rather than by omission.
 */
const PERSONAL_DATES: readonly PackEventType[] = [
  {
    slug: "birthday",
    label: "Birthday",
    recurrence: "yearly",
    synonyms: [/birth\s*day|birthdate|\bdob\b/i],
  },
  { slug: "anniversary", label: "Anniversary", recurrence: "yearly", synonyms: [/anniversar/i] },
]

const BIRTHDAY_RULES: readonly PackRule[] = [
  { event_type: "birthday", offset_days: 7, send_window: "morning", label: "Birthday — a week ahead" },
  { event_type: "birthday", offset_days: 0, send_window: "morning", label: "Birthday — on the day" },
]

// ── the packs ───────────────────────────────────────────────────────────────

const INSURANCE_PACK: VerticalPack = {
  key: "insurance",
  name: "insurance starter",
  holding: {
    column: "Policy dates",
    bucket: "Policies",
    // A business tracking policy_review alongside policy_expiry must not be
    // told those reviews are "Renewals".
    narrow: { label: "Renewals", pattern: /(expiry|expiration|renewal|renew)/ },
    inline: "policy dates",
  },
  personalExtra: [],
  eventTypes: [
    ...PERSONAL_DATES,
    {
      slug: "policy_expiry",
      label: "Policy expiry",
      recurrence: "none",
      synonyms: [/expir|renew|maturity/i],
    },
    { slug: "policy_review", label: "Policy review", recurrence: "none", synonyms: [/review/i] },
    {
      slug: "premium_due",
      label: "Premium due",
      recurrence: "yearly",
      synonyms: [/premium|instal?ment/i],
    },
  ],
  /**
   * Byte-for-byte what DEFAULT_INSURANCE_RULES seeded before packs existed.
   * Pinned by a test: an existing tenant must get exactly what they got
   * yesterday, or this refactor is a behaviour change wearing a refactor's
   * clothes.
   */
  rules: [
    ...BIRTHDAY_RULES,
    { event_type: "policy_expiry", offset_days: 30, send_window: "morning", label: "Policy expiry — a month ahead" },
    { event_type: "policy_expiry", offset_days: 7, send_window: "morning", label: "Policy expiry — a week ahead" },
    { event_type: "policy_review", offset_days: 14, send_window: "afternoon", label: "Policy review — two weeks ahead" },
  ],
  framing:
    "The business is an insurance agency and the client holds policies. Useful details are the policy number, insurer, product name or premium.",
  importHint: "Dates like a policy expiry, a review date, or a date of birth.",
  fixture: "sample-clients.csv",
}

/**
 * The fallback, and a complete product on its own.
 *
 * Used for `other`, for a business that has not chosen an industry yet, and for
 * any vertical without a hand-authored pack. Its words are the ones that are
 * true everywhere: a date, a renewal, a review.
 */
const GENERIC_PACK: VerticalPack = {
  key: "generic",
  name: "starter",
  holding: {
    column: "Dates on file",
    bucket: "Dates",
    // No narrower word is true of every business, so none is claimed.
    narrow: null,
    inline: "dates on file",
  },
  personalExtra: [],
  eventTypes: [
    ...PERSONAL_DATES,
    {
      slug: "renewal_date",
      label: "Renewal",
      recurrence: "none",
      synonyms: [/renew|expir|maturity/i],
    },
    { slug: "review_due", label: "Review due", recurrence: "none", synonyms: [/review/i] },
  ],
  rules: [
    ...BIRTHDAY_RULES,
    { event_type: "renewal_date", offset_days: 30, send_window: "morning", label: "Renewal — a month ahead" },
    { event_type: "renewal_date", offset_days: 7, send_window: "morning", label: "Renewal — a week ahead" },
    { event_type: "review_due", offset_days: 14, send_window: "afternoon", label: "Review — two weeks ahead" },
  ],
  framing:
    "Say what is coming up and when, without assuming what kind of business this is or what the client bought.",
  importHint: "Any date worth a reminder — a renewal, a review, or a date of birth.",
  fixture: null,
}

/**
 * Industry packs, keyed by the host's `businesses.vertical`.
 *
 * Partial by design — see the file header. A key absent here is not an
 * oversight to be filled in later out of tidiness; it is a statement that the
 * generic words serve that industry as well as anything hand-written would.
 */
const PACKS: Partial<Record<Vertical, VerticalPack>> = {
  insurance: INSURANCE_PACK,
  // `other` is mapped explicitly rather than left to fall through, so the
  // intent reads: it is a positive answer meaning "none of these fit", and the
  // generic pack is the right response to it rather than an accident.
  other: GENERIC_PACK,
}

/**
 * The pack for a business, from whatever its `vertical` column holds.
 *
 * Deliberately takes `string | null | undefined` rather than `Vertical`: the
 * column is nullable, a dev cookie can carry anything, and a row can predate
 * the CHECK constraint. Every one of those resolves to the generic pack rather
 * than throwing, because a mislabelled inbox is a far smaller problem than a
 * page that will not render.
 */
export function packForVertical(vertical: string | null | undefined): VerticalPack {
  if (!vertical) return GENERIC_PACK
  return PACKS[vertical as Vertical] ?? GENERIC_PACK
}

/**
 * Does this event type count as something the contact HOLDS?
 *
 * The replacement for isPolicyLike, and the same shape of answer: a negation.
 * Everything is a holding unless it is personal, so a business that invents
 * `visa_expiry` gets it counted without anybody adding it to a list.
 */
export function isHoldingType(pack: VerticalPack, eventType: string): boolean {
  return !PERSONAL_EVENT_TYPES.has(eventType) && !pack.personalExtra.includes(eventType)
}

/**
 * The bucket label to show for a set of holding types.
 *
 * Claims the narrower word only when EVERY type earns it, preserving the rule
 * the insurance inbox already followed: a review is not a renewal.
 */
export function holdingLabel(pack: VerticalPack, eventTypes: readonly string[]): string {
  const narrow = pack.holding.narrow
  if (!narrow || eventTypes.length === 0) return pack.holding.bucket
  return eventTypes.every((t) => narrow.pattern.test(t)) ? narrow.label : pack.holding.bucket
}

export { GENERIC_PACK }
