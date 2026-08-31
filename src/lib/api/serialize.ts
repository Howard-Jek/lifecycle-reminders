/**
 * Row → public shape.
 *
 * Every v1 endpoint goes through here rather than returning database rows
 * directly, for two reasons.
 *
 * `business_id` never leaves the building. It is on every row and it is
 * meaningless to a caller that cannot address another tenant anyway, so
 * emitting it only teaches an attacker what a valid one looks like.
 *
 * And a hand-written shape is a contract. `select("*")` would silently add a
 * field to the API the day somebody adds a column, and silently remove one the
 * day somebody renames it — the host app would find out from a production
 * failure rather than from a migration review.
 */

export type PublicReminder = {
  id: string
  status: string
  /** The date the reminder is ABOUT. */
  occurrence_date: string
  /** When it becomes due to send, in UTC. */
  due_at: string
  sent_at: string | null
  attempts: number
  /**
   * When a failed reminder will be tried again. Null means eligible now, which
   * is every first attempt and every row that will not be retried at all —
   * `attempts` and `status` together say which.
   */
  next_attempt_at: string | null
  /** Null when the rule has drafting switched off, or before delivery. */
  suggestion: string | null
  error: string | null
  /** The roster member who receives it. Null means it falls back to the owner. */
  member_id: string | null
  event_id: string
  rule_id: string
  contact?: { id: string; name: string | null } | null
  event?: { event_type: string; label: string | null } | null
}

export function toPublicReminder(row: Record<string, unknown>): PublicReminder {
  return {
    id: row.id as string,
    status: row.status as string,
    occurrence_date: row.occurrence_date as string,
    due_at: row.due_at as string,
    sent_at: (row.sent_at as string | null) ?? null,
    attempts: (row.attempts as number | null) ?? 0,
    next_attempt_at: (row.next_attempt_at as string | null) ?? null,
    suggestion: (row.suggestion as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    member_id: (row.member_id as string | null) ?? null,
    event_id: row.event_id as string,
    rule_id: row.rule_id as string,
  }
}

export type PublicContact = {
  id: string
  name: string | null
  phone: string
  email: string | null
  assigned_member_id: string | null
}

export function toPublicContact(row: Record<string, unknown>): PublicContact {
  return {
    id: row.id as string,
    name: (row.name as string | null) ?? null,
    phone: row.phone as string,
    email: (row.email as string | null) ?? null,
    assigned_member_id: (row.assigned_member_id as string | null) ?? null,
  }
}

export type PublicEvent = {
  id: string
  lead_id: string
  /** Free text. The engine never switches on this — see lifecycle/types.ts. */
  event_type: string
  label: string | null
  /** YYYY-MM-DD. For a yearly event this is the ORIGINAL year, not the next. */
  event_date: string
  recurrence: string
  source: string
  payload: Record<string, unknown>
}

export function toPublicEvent(row: Record<string, unknown>): PublicEvent {
  return {
    id: row.id as string,
    lead_id: row.lead_id as string,
    event_type: row.event_type as string,
    label: (row.label as string | null) ?? null,
    event_date: row.event_date as string,
    recurrence: (row.recurrence as string | null) ?? "none",
    source: (row.source as string | null) ?? "api",
    payload: (row.payload as Record<string, unknown> | null) ?? {},
  }
}

export type PublicMember = {
  id: string
  display_name: string
  email: string | null
  /** E.164. Where this member RECEIVES reminders; never sent from. */
  whatsapp_number: string
  role: string
  active: boolean
}

export function toPublicMember(row: Record<string, unknown>): PublicMember {
  return {
    id: row.id as string,
    display_name: row.display_name as string,
    email: (row.email as string | null) ?? null,
    whatsapp_number: row.whatsapp_number as string,
    role: row.role as string,
    active: Boolean(row.active),
  }
}

export type PublicRule = {
  id: string
  event_type: string
  /** Days before the occurrence; 0 fires on the day itself. */
  offset_days: number
  audience: string
  suggest_message: boolean
  send_window: string
  active: boolean
}

export function toPublicRule(row: Record<string, unknown>): PublicRule {
  return {
    id: row.id as string,
    event_type: row.event_type as string,
    offset_days: row.offset_days as number,
    audience: row.audience as string,
    suggest_message: Boolean(row.suggest_message),
    send_window: row.send_window as string,
    active: Boolean(row.active),
  }
}

export type PublicReview = {
  id: string
  import_id: string
  row_number: number
  /** A closed set — see the migration. `unknown_member` and `ambiguous_member`
   * are the two an integrator can resolve by choosing a member. */
  reason: string
  detail: string | null
  status: string
  /** The row exactly as it arrived, so the caller can show it to a human. */
  raw: Record<string, unknown>
  parsed: Record<string, unknown>
  resolved_lead_id: string | null
}

export function toPublicReview(row: Record<string, unknown>): PublicReview {
  return {
    id: row.id as string,
    import_id: row.import_id as string,
    row_number: row.row_number as number,
    reason: row.reason as string,
    detail: (row.detail as string | null) ?? null,
    status: row.status as string,
    raw: (row.raw as Record<string, unknown> | null) ?? {},
    parsed: (row.parsed as Record<string, unknown> | null) ?? {},
    resolved_lead_id: (row.resolved_lead_id as string | null) ?? null,
  }
}
