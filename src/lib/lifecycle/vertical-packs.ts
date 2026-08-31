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
 * The rest, in the host's declaration order.
 *
 * Each was written by asking one question: what dates does this business
 * already keep about a person, and how far ahead is it useful to be told? The
 * offsets are domain answers, not a template — a mortgage rate needs three
 * months' notice because repricing takes that long, and a dental recall needs
 * three weeks because that is how far out a diary fills.
 */

const FINANCIAL_ADVISORY_PACK: VerticalPack = {
  key: "financial_advisory",
  name: "financial advisory starter",
  holding: {
    column: "Plan dates",
    bucket: "Plans",
    narrow: { label: "Maturities", pattern: /matur/ },
    inline: "plan dates",
  },
  eventTypes: [
    ...PERSONAL_DATES,
    { slug: "review_due", label: "Review due", recurrence: "none", synonyms: [/review/i] },
    {
      slug: "plan_maturity",
      label: "Plan maturity",
      recurrence: "none",
      synonyms: [/matur|expir/i],
    },
    {
      slug: "contribution_due",
      label: "Contribution due",
      recurrence: "yearly",
      synonyms: [/contribution|top\s*-?\s*up|instal?ment/i],
    },
  ],
  rules: [
    ...BIRTHDAY_RULES,
    { event_type: "plan_maturity", offset_days: 30, send_window: "morning", label: "Plan maturity — a month ahead" },
    { event_type: "plan_maturity", offset_days: 7, send_window: "morning", label: "Plan maturity — a week ahead" },
    { event_type: "review_due", offset_days: 14, send_window: "afternoon", label: "Review — two weeks ahead" },
  ],
  framing:
    "The business is a financial advisory practice and the client holds plans or portfolios. Useful details are the plan name, provider or contribution amount. Do not give investment advice or predict returns — the point is that a conversation is due, not what its answer should be.",
  importHint: "Dates like a plan maturity, a review date, or a date of birth.",
  fixture: null,
}

const MORTGAGE_PACK: VerticalPack = {
  key: "mortgage",
  name: "mortgage starter",
  holding: {
    column: "Loan dates",
    bucket: "Loans",
    narrow: { label: "Rate expiries", pattern: /(rate|lock)/ },
    inline: "loan dates",
  },
  eventTypes: [
    ...PERSONAL_DATES,
    {
      slug: "rate_expiry",
      label: "Rate expiry",
      recurrence: "none",
      synonyms: [/rate|lock|fixed/i],
    },
    {
      slug: "refinance_review",
      label: "Refinance review",
      recurrence: "none",
      synonyms: [/refinanc|repric|review/i],
    },
    { slug: "loan_maturity", label: "Loan maturity", recurrence: "none", synonyms: [/matur/i] },
  ],
  rules: [
    ...BIRTHDAY_RULES,
    // Ninety days is the domain answer, not a round number: repricing a home
    // loan takes about three months from first conversation to drawdown, so a
    // month's notice is already too late to act on.
    { event_type: "rate_expiry", offset_days: 90, send_window: "morning", label: "Rate expiry — three months ahead" },
    { event_type: "rate_expiry", offset_days: 30, send_window: "morning", label: "Rate expiry — a month ahead" },
    { event_type: "refinance_review", offset_days: 14, send_window: "afternoon", label: "Refinance review — two weeks ahead" },
  ],
  framing:
    "The business arranges mortgages and the client holds a loan. Useful details are the lender, the loan amount or the current rate. Never quote a rate or promise a saving — the point is that it is worth a conversation now.",
  importHint: "Dates like a rate expiry, a refinance review, or a date of birth.",
  fixture: null,
}

const REAL_ESTATE_PACK: VerticalPack = {
  key: "real_estate",
  name: "real estate starter",
  holding: {
    column: "Lease dates",
    bucket: "Leases",
    narrow: { label: "Renewals", pattern: /(expiry|renewal)/ },
    inline: "lease dates",
  },
  eventTypes: [
    ...PERSONAL_DATES,
    { slug: "lease_expiry", label: "Lease expiry", recurrence: "none", synonyms: [/lease|tenanc|expir/i] },
    { slug: "tenancy_renewal", label: "Tenancy renewal", recurrence: "none", synonyms: [/renew/i] },
    {
      slug: "handover_anniversary",
      label: "Handover anniversary",
      recurrence: "yearly",
      synonyms: [/handover|completion|key\s*collection/i],
    },
  ],
  rules: [
    ...BIRTHDAY_RULES,
    // Two months, because a tenant deciding whether to renew usually has to
    // give notice before the landlord asks.
    { event_type: "lease_expiry", offset_days: 60, send_window: "morning", label: "Lease expiry — two months ahead" },
    { event_type: "lease_expiry", offset_days: 14, send_window: "morning", label: "Lease expiry — two weeks ahead" },
    { event_type: "tenancy_renewal", offset_days: 30, send_window: "morning", label: "Tenancy renewal — a month ahead" },
  ],
  framing:
    "The business is a property agency and the client holds a lease or a property. Useful details are the address, unit or landlord.",
  importHint: "Dates like a lease expiry, a handover date, or a date of birth.",
  fixture: null,
}

const DENTAL_PACK: VerticalPack = {
  key: "dental",
  name: "dental starter",
  holding: {
    column: "Recall dates",
    bucket: "Treatments",
    narrow: { label: "Recalls", pattern: /recall/ },
    inline: "treatment dates",
  },
  eventTypes: [
    ...PERSONAL_DATES,
    { slug: "recall_due", label: "Recall due", recurrence: "yearly", synonyms: [/recall|check\s*-?\s*up|hygien/i] },
    { slug: "treatment_review", label: "Treatment review", recurrence: "none", synonyms: [/review|follow\s*-?\s*up/i] },
    { slug: "xray_due", label: "X-ray due", recurrence: "yearly", synonyms: [/x\s*-?\s*ray|radiograph/i] },
  ],
  rules: [
    ...BIRTHDAY_RULES,
    // Three weeks, because that is roughly how far ahead a clinic diary fills.
    { event_type: "recall_due", offset_days: 21, send_window: "morning", label: "Recall — three weeks ahead" },
    { event_type: "recall_due", offset_days: 7, send_window: "morning", label: "Recall — a week ahead" },
    { event_type: "treatment_review", offset_days: 14, send_window: "afternoon", label: "Treatment review — two weeks ahead" },
  ],
  /**
   * The only pack whose framing carries a PROHIBITION, and it needs one.
   *
   * The drafting call is given event.payload and lead.context verbatim, and a
   * dental spreadsheet may well have a procedure in a column. A WhatsApp naming
   * a patient's treatment is a health disclosure sent to a phone that may be
   * read by somebody else, and the message goes to the practice's own staff —
   * so nothing downstream would flag it as odd.
   */
  framing:
    "The business is a dental or healthcare practice and the person is a patient. NEVER name a procedure, a diagnosis, a medication or any clinical detail, even if one appears in the data — say only that a visit or a review is due.",
  importHint: "Dates like a recall, a review, or a date of birth.",
  fixture: null,
}

const BEAUTY_PACK: VerticalPack = {
  key: "beauty",
  name: "beauty starter",
  holding: {
    column: "Package dates",
    bucket: "Packages",
    narrow: { label: "Expiries", pattern: /expir/ },
    inline: "package dates",
  },
  eventTypes: [
    ...PERSONAL_DATES,
    { slug: "treatment_due", label: "Treatment due", recurrence: "none", synonyms: [/treatment|session|appointment/i] },
    { slug: "package_expiry", label: "Package expiry", recurrence: "none", synonyms: [/package|credit|expir/i] },
    { slug: "course_end", label: "Course end", recurrence: "none", synonyms: [/course|programme|program/i] },
  ],
  rules: [
    ...BIRTHDAY_RULES,
    { event_type: "package_expiry", offset_days: 30, send_window: "morning", label: "Package expiry — a month ahead" },
    { event_type: "package_expiry", offset_days: 7, send_window: "morning", label: "Package expiry — a week ahead" },
    { event_type: "treatment_due", offset_days: 14, send_window: "afternoon", label: "Treatment due — two weeks ahead" },
  ],
  framing:
    "The business is a beauty or aesthetics salon and the client holds packages or treatment credits. Useful details are the package name or how many sessions remain. Keep it warm and never comment on the client's appearance.",
  importHint: "Dates like a package expiry, a treatment date, or a date of birth.",
  fixture: null,
}

const CONSTRUCTION_PACK: VerticalPack = {
  key: "construction",
  name: "construction starter",
  holding: {
    column: "Project dates",
    bucket: "Projects",
    // A defects liability period and a warranty are not the same word, and no
    // narrower term covers both honestly.
    narrow: null,
    inline: "project dates",
  },
  eventTypes: [
    ...PERSONAL_DATES,
    {
      slug: "defects_liability_end",
      label: "Defects liability ends",
      recurrence: "none",
      synonyms: [/defect|dlp|liability/i],
    },
    { slug: "warranty_expiry", label: "Warranty expiry", recurrence: "none", synonyms: [/warrant|guarantee|expir/i] },
  ],
  /**
   * Thin on purpose. A renovation is a one-off project, so the recurring-date
   * surface is genuinely small — the defects liability period ending is the one
   * date that is worth a message, because it is the client's last chance to
   * raise something at the builder's cost.
   */
  rules: [
    ...BIRTHDAY_RULES,
    { event_type: "defects_liability_end", offset_days: 30, send_window: "morning", label: "Defects liability — a month ahead" },
    { event_type: "warranty_expiry", offset_days: 30, send_window: "morning", label: "Warranty expiry — a month ahead" },
  ],
  framing:
    "The business is a construction or renovation firm and the client had work done. Useful details are the project or the property.",
  importHint: "Dates like the end of a defects liability period, or a warranty expiry.",
  fixture: null,
}

const FITNESS_PACK: VerticalPack = {
  key: "fitness",
  name: "fitness starter",
  holding: {
    column: "Membership dates",
    bucket: "Memberships",
    narrow: { label: "Renewals", pattern: /(expiry|renewal)/ },
    inline: "membership dates",
  },
  eventTypes: [
    ...PERSONAL_DATES,
    { slug: "membership_expiry", label: "Membership expiry", recurrence: "none", synonyms: [/member|expir|renew/i] },
    { slug: "package_expiry", label: "Package expiry", recurrence: "none", synonyms: [/package|credit/i] },
    { slug: "sessions_end", label: "Sessions running out", recurrence: "none", synonyms: [/session|pt\b|personal\s*training/i] },
  ],
  rules: [
    ...BIRTHDAY_RULES,
    { event_type: "membership_expiry", offset_days: 30, send_window: "morning", label: "Membership expiry — a month ahead" },
    { event_type: "membership_expiry", offset_days: 7, send_window: "morning", label: "Membership expiry — a week ahead" },
    // Evening, because that is when this audience reads a phone.
    { event_type: "package_expiry", offset_days: 14, send_window: "evening", label: "Package expiry — two weeks ahead" },
  ],
  framing:
    "The business is a gym or wellness studio and the client holds a membership or session package. Useful details are the plan or how many sessions remain. Encourage without commenting on their body or their progress.",
  importHint: "Dates like a membership expiry, a package expiry, or a date of birth.",
  fixture: null,
}

const HOME_SERVICES_PACK: VerticalPack = {
  key: "home_services",
  name: "home services starter",
  holding: {
    column: "Service dates",
    bucket: "Services",
    narrow: { label: "Servicing", pattern: /service/ },
    inline: "service dates",
  },
  eventTypes: [
    ...PERSONAL_DATES,
    // Yearly by default: servicing is the recurring case, unlike most holdings.
    { slug: "service_due", label: "Service due", recurrence: "yearly", synonyms: [/service|maintenance|servicing/i] },
    { slug: "warranty_expiry", label: "Warranty expiry", recurrence: "none", synonyms: [/warrant|guarantee/i] },
    { slug: "contract_expiry", label: "Contract expiry", recurrence: "none", synonyms: [/contract|agreement|expir/i] },
  ],
  rules: [
    ...BIRTHDAY_RULES,
    { event_type: "service_due", offset_days: 14, send_window: "morning", label: "Service due — two weeks ahead" },
    { event_type: "warranty_expiry", offset_days: 30, send_window: "morning", label: "Warranty expiry — a month ahead" },
    { event_type: "contract_expiry", offset_days: 30, send_window: "morning", label: "Contract expiry — a month ahead" },
  ],
  framing:
    "The business provides a home or local service and the client has equipment or a contract with them. Useful details are the equipment, the address or when it was last serviced.",
  importHint: "Dates like a service due date, a warranty expiry, or a contract end.",
  fixture: null,
}

const SAAS_PACK: VerticalPack = {
  key: "saas",
  name: "SaaS starter",
  holding: {
    column: "Subscription dates",
    bucket: "Subscriptions",
    narrow: { label: "Renewals", pattern: /renew/ },
    inline: "subscription dates",
  },
  eventTypes: [
    // The dates are still offered — a B2B contact has a birthday, and an
    // account manager may well want it on file.
    ...PERSONAL_DATES,
    { slug: "renewal_date", label: "Renewal", recurrence: "yearly", synonyms: [/renew|subscription/i] },
    { slug: "trial_end", label: "Trial ends", recurrence: "none", synonyms: [/trial|pilot|poc/i] },
    { slug: "contract_expiry", label: "Contract expiry", recurrence: "none", synonyms: [/contract|term|expir/i] },
  ],
  /**
   * The one pack with no birthday rules, and the case that shows why
   * classification and seeding are separate axes.
   *
   * A birthday greeting from a software vendor is off-key, so it is not seeded.
   * `birthday` is still PERSONAL here — it is never counted as a subscription
   * and never retried late — it just does not come with a rule attached. An
   * operator who wants one adds it in a click.
   */
  rules: [
    { event_type: "renewal_date", offset_days: 30, send_window: "morning", label: "Renewal — a month ahead" },
    { event_type: "renewal_date", offset_days: 7, send_window: "morning", label: "Renewal — a week ahead" },
    // Three days, because a trial is short and a month's notice would fire
    // before the trial had started.
    { event_type: "trial_end", offset_days: 3, send_window: "morning", label: "Trial ends — three days ahead" },
  ],
  framing:
    "The business sells software and the contact is an account. Useful details are the plan, the seat count or the renewal value. Write as a colleague would to a business contact, not as marketing.",
  importHint: "Dates like a renewal, a trial end, or a contract expiry.",
  fixture: null,
}

const TRAINING_PACK: VerticalPack = {
  key: "training",
  name: "education starter",
  holding: {
    column: "Course dates",
    bucket: "Courses",
    narrow: { label: "Expiries", pattern: /expir/ },
    inline: "course dates",
  },
  eventTypes: [
    ...PERSONAL_DATES,
    { slug: "course_end", label: "Course ends", recurrence: "none", synonyms: [/course|intake|cohort|programme|program/i] },
    {
      slug: "certification_expiry",
      label: "Certification expiry",
      recurrence: "none",
      synonyms: [/cert|licence|license|accredit|expir/i],
    },
    {
      slug: "enrolment_anniversary",
      label: "Enrolment anniversary",
      recurrence: "yearly",
      synonyms: [/enrol|enroll|joined/i],
    },
  ],
  rules: [
    ...BIRTHDAY_RULES,
    // Two months, because recertification usually means booking onto a course
    // that runs on a fixed calendar.
    { event_type: "certification_expiry", offset_days: 60, send_window: "morning", label: "Certification expiry — two months ahead" },
    { event_type: "certification_expiry", offset_days: 14, send_window: "morning", label: "Certification expiry — two weeks ahead" },
    { event_type: "course_end", offset_days: 7, send_window: "afternoon", label: "Course ends — a week ahead" },
  ],
  framing:
    "The business is a training provider and the person is a learner. Useful details are the course, the cohort or the certification. Do not imply a pass, a grade or an outcome.",
  importHint: "Dates like a course end, a certification expiry, or a date of birth.",
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
  mortgage: MORTGAGE_PACK,
  insurance: INSURANCE_PACK,
  financial_advisory: FINANCIAL_ADVISORY_PACK,
  real_estate: REAL_ESTATE_PACK,
  dental: DENTAL_PACK,
  beauty: BEAUTY_PACK,
  construction: CONSTRUCTION_PACK,
  fitness: FITNESS_PACK,
  home_services: HOME_SERVICES_PACK,
  saas: SAAS_PACK,
  training: TRAINING_PACK,
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
