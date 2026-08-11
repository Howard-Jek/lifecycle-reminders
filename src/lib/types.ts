/**
 * Shared row and config types.
 *
 * `SendWindow` and `EventColumn` keep the names and shapes they have in
 * jottiteam/lead-reactivation-agent, so the lifecycle modules move between the
 * two repos without an import rewrite.
 */

/** Mirrors the `public.send_window` enum. */
export type SendWindow = "morning" | "afternoon" | "evening"

export const SEND_WINDOWS: readonly SendWindow[] = ["morning", "afternoon", "evening"]

/** Local hour each window opens. The single source for `reminderDueAt`. */
export const SEND_WINDOW_START_HOUR: Record<SendWindow, number> = {
  morning: 9,
  afternoon: 13,
  evening: 19,
}

export const SEND_WINDOW_LABEL: Record<SendWindow, string> = {
  morning: "Morning (9am)",
  afternoon: "Afternoon (1pm)",
  evening: "Evening (7pm)",
}

/**
 * A spreadsheet column holding a lifecycle date (birthday, policy expiry,
 * review date). Feeds `contact_events`.
 *
 * Additive: an event column's raw value still lands in `leads.context` too, so
 * mapping one changes nothing about the rest of the import.
 */
export type EventColumn = {
  /** EXACT original header, used to locate the column in each row. */
  header: string
  /**
   * snake_case type, e.g. 'birthday' | 'policy_expiry'. Free text by design —
   * the reminders engine is vertical-agnostic.
   */
  event_type: string
  /** 'yearly' for dates that repeat (birthdays); 'none' for one-offs. */
  recurrence: "none" | "yearly"
  /**
   * Operator-facing label when one column needs distinguishing from another of
   * the same type ("AIA HealthShield expiry").
   */
  label: string | null
}

/**
 * What the import wizard resolved, and what the ingest API accepts as its
 * equivalent. Every field is chosen by the operator or by a deterministic
 * heuristic they confirmed — nothing here is inferred at run time.
 */
export type ColumnMapping = {
  name: string | null
  phone: string | null
  email: string | null
  /** Column naming the owning agent ("Servicing FA", "RM", "Agent"). */
  assigned_agent_column: string | null
  /** Confirmed in the wizard. Null means "let the fallback cascade decide". */
  date_format: string | null
  /** ISO-3166 alpha-2 or a dial code; used to complete local phone numbers. */
  default_country_code: string | null
  /** Columns kept verbatim into `leads.context`. */
  extra_columns: string[]
  event_columns: EventColumn[]
}

/** The columns of `leads` this app reads. Never `select('*')` — see the
 * platform stand-in migration for why. */
export const LEAD_COLUMNS =
  "id, business_id, name, phone, email, context, assigned_member_id, created_at, updated_at" as const

export type Contact = {
  id: string
  business_id: string
  name: string
  phone: string
  email: string | null
  context: Record<string, unknown> | null
  assigned_member_id: string | null
  created_at: string
  updated_at: string
}

export type ReviewReason =
  | "missing_name"
  | "missing_phone"
  | "invalid_phone"
  | "unknown_member"
  | "ambiguous_member"
  | "unparseable_date"
  | "duplicate_in_batch"

export const REVIEW_REASON_LABEL: Record<ReviewReason, string> = {
  missing_name: "No name",
  missing_phone: "No phone number",
  invalid_phone: "Phone number could not be read",
  unknown_member: "Agent not on the team",
  ambiguous_member: "Agent name matches more than one person",
  unparseable_date: "Date could not be read",
  duplicate_in_batch: "Same phone appears twice in this file",
}

/**
 * Status chips. A tinted wash with dark text, never a saturated fill — the
 * house idiom, mirroring STATUS_PILL in the host app.
 */
export const REMINDER_STATUS_PILL: Record<string, string> = {
  queued: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  claimed: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  sent: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  failed: "bg-red-500/10 text-red-700 dark:text-red-400",
  skipped: "bg-foreground/5 text-foreground/40",
}
