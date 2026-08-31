/**
 * Meta's webhook payload, flattened into the two things this app acts on.
 *
 * Written defensively rather than with a schema validator, and that is a
 * deliberate inversion of how the v1 API parses its input. There, a malformed
 * body is the caller's bug and 400 is the correct, useful answer. Here, a
 * shape we do not recognise is nearly always Meta having added a field, and
 * rejecting the whole batch over it would drop the STATUSES SITTING NEXT TO IT
 * in the same payload. Meta also retries a non-2xx and disables a webhook that
 * keeps failing, so a strict parser turns "new message type" into "delivery
 * receipts stop arriving".
 *
 * So: pull out what is understood, ignore the rest, never throw.
 */

/** A delivery receipt for a message we sent. */
export type StatusEvent = {
  /** Meta's message id — matches `reminders.whatsapp_message_id`. */
  wamid: string
  status: "sent" | "delivered" | "read" | "failed"
  /** Present on `failed`. Already flattened to one human-readable line. */
  error: string | null
  /** Who Meta says it was for, E.164 without the "+". */
  recipient: string | null
  /** When Meta says the transition happened, as ISO. */
  occurredAt: string | null
}

/** A message somebody sent TO the platform number. */
export type InboundMessage = {
  wamid: string
  /** E.164 without the leading "+", which is how Meta sends it. */
  from: string
  type: string
  /** Text body where there is one; null for media, reactions, and the rest. */
  body: string | null
  /** Meta's unix seconds, as an ISO string. Null when absent or unparseable. */
  sentAt: string | null
}

export type WebhookBatch = {
  statuses: StatusEvent[]
  messages: InboundMessage[]
  /**
   * Entries dropped because they were about another number or account.
   *
   * Reported rather than merely discarded, because the scope check has a
   * failure mode that is otherwise indistinguishable from success: if
   * GOMA_NOTIFY_WABA_ID does not hold exactly what Meta puts in `entry.id`,
   * EVERY real payload is dropped and the symptom is silence — which reads as
   * "Meta never sends anything" rather than "we are refusing all of it".
   */
  skipped: { wabaMismatch: number; phoneMismatch: number }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

const KNOWN_STATUSES = new Set(["sent", "delivered", "read", "failed"])

/**
 * Meta's failure detail, flattened to one line.
 *
 * `errors[]` carries code, title, message and error_data.details, and which of
 * them is populated varies by failure. Joining what exists beats picking one
 * field and finding it empty on the failure you actually need to debug.
 */
function describeErrors(value: unknown): string | null {
  const parts: string[] = []
  for (const raw of asArray(value).slice(0, 3)) {
    const err = asRecord(raw)
    const code = err.code === undefined ? null : String(err.code)
    const detail =
      asString(asRecord(err.error_data).details) ?? asString(err.message) ?? asString(err.title)
    const line = [code ? `[${code}]` : null, detail].filter(Boolean).join(" ")
    if (line) parts.push(line)
  }
  // Bounded: this lands in `reminders.error`, which the inbox renders.
  const joined = parts.join("; ")
  return joined ? joined.slice(0, 500) : null
}

function toIso(timestamp: unknown): string | null {
  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * The text of a message, where the type has one.
 *
 * Only types whose text the agent actually typed. A document's `caption` is
 * text, but an image caption and a button payload mean different things, and
 * flattening them all into one `body` column would make the column mean
 * "some string Meta sent" rather than "what they said".
 */
function extractBody(message: Record<string, unknown>, type: string): string | null {
  if (type === "text") return asString(asRecord(message.text).body)
  if (type === "button") return asString(asRecord(message.button).text)
  if (type === "reaction") return asString(asRecord(message.reaction).emoji)
  if (type === "interactive") {
    const interactive = asRecord(message.interactive)
    return (
      asString(asRecord(interactive.button_reply).title) ??
      asString(asRecord(interactive.list_reply).title)
    )
  }
  return null
}

/**
 * Which number this deployment is allowed to act on.
 *
 * Both optional: an unset id cannot be checked against, and refusing every
 * payload because a variable is absent would be a worse failure than the one
 * this prevents.
 */
export type WebhookScope = {
  /** GOMA_NOTIFY_PHONE_NUMBER_ID — the number reminders are sent FROM. */
  phoneNumberId?: string
  /** GOMA_NOTIFY_WABA_ID — the account that number belongs to. */
  wabaId?: string
}

export function parseWebhookBatch(payload: unknown, scope: WebhookScope = {}): WebhookBatch {
  const statuses: StatusEvent[] = []
  const messages: InboundMessage[] = []
  const skipped = { wabaMismatch: 0, phoneMismatch: 0 }

  const root = asRecord(payload)
  // Meta sends `object: "whatsapp_business_account"`. Other Meta products post
  // to the same webhook shape, and acting on a Page or Instagram payload here
  // would be acting on something this app knows nothing about.
  if (asString(root.object) !== "whatsapp_business_account") return { statuses, messages, skipped }

  const expectedPhone = scope.phoneNumberId?.trim()
  const expectedWaba = scope.wabaId?.trim()

  for (const entryRaw of asArray(root.entry)) {
    const entry = asRecord(entryRaw)
    /**
     * Is this payload even ABOUT our number?
     *
     * The signature does not answer that. X-Hub-Signature-256 is keyed on the
     * Meta APP secret, and an App can carry many WhatsApp Business Accounts —
     * every one of them signs with the SAME key and posts to the SAME callback
     * URL. So a valid signature proves "this came from our Meta App", not
     * "this concerns our platform notifications number".
     *
     * With one WABA that distinction is invisible. It stops being invisible at
     * integration: README and .env.example both say this add-on is meant to
     * reuse GomaAI's GOMA_NOTIFY_* credentials, and GomaAI onboards a WhatsApp
     * number PER BUSINESS. Without this check, the first shared-App deployment
     * would quietly ingest every tenant's customer conversations — message
     * bodies and phone numbers — into whatsapp_inbound_messages, a table whose
     * entire purpose is agent replies to one number.
     */
    if (expectedWaba && asString(entry.id) && asString(entry.id) !== expectedWaba) {
      skipped.wabaMismatch += 1
      continue
    }

    for (const changeRaw of asArray(entry.changes)) {
      const change = asRecord(changeRaw)
      if (asString(change.field) !== "messages") continue
      const value = asRecord(change.value)

      if (expectedPhone) {
        const from = asString(asRecord(value.metadata).phone_number_id)
        // A payload with no metadata at all is let through: Meta omits it on
        // some event shapes, and dropping those would lose real receipts to
        // guard against a case the WABA check above already covers.
        if (from && from !== expectedPhone) {
          skipped.phoneMismatch += 1
          continue
        }
      }

      for (const raw of asArray(value.statuses)) {
        const status = asRecord(raw)
        const wamid = asString(status.id)
        const state = asString(status.status)
        if (!wamid || !state || !KNOWN_STATUSES.has(state)) continue
        statuses.push({
          wamid,
          status: state as StatusEvent["status"],
          error: describeErrors(status.errors),
          recipient: asString(status.recipient_id),
          occurredAt: toIso(status.timestamp),
        })
      }

      for (const raw of asArray(value.messages)) {
        const message = asRecord(raw)
        const wamid = asString(message.id)
        const from = asString(message.from)
        if (!wamid || !from) continue
        const type = asString(message.type) ?? "unknown"
        messages.push({
          wamid,
          from,
          type,
          body: extractBody(message, type),
          sentAt: toIso(message.timestamp),
        })
      }
    }
  }

  return { statuses, messages, skipped }
}

/** A roster row, reduced to what sender attribution needs. */
export type RosterEntry = { id: string; business_id: string; whatsapp_number: string | null }

export type SenderMatch = { id: string; business_id: string }

/**
 * Which team member, if any, a WhatsApp number identifies.
 *
 * Returns null for BOTH "nobody" and "more than one", and the second case is
 * the reason this is a function rather than a Map lookup.
 *
 * team_members.whatsapp_number carries no unique constraint and cannot usefully
 * carry one: this deployment has a single platform number shared by every
 * tenant, so the same digits legitimately appear on two rosters under two
 * different business_ids — one person contracting to two agencies, or a reused
 * number. Observed live: +6591110022 sits on two businesses.
 *
 * business_id is what the RLS policy on whatsapp_inbound_messages reads. Pick
 * the wrong one and an agency can read another agency's message; return null
 * and somebody has to go and look at an unattributed row. Only one of those is
 * recoverable.
 */
export function buildSenderIndex(members: RosterEntry[]): Map<string, SenderMatch | null> {
  const index = new Map<string, SenderMatch | null>()
  for (const member of members) {
    // Digits only, so "+65 9111 0022" and "6591110022" are the same sender —
    // Meta omits the "+", the roster stores it.
    const digits = String(member.whatsapp_number ?? "").replace(/\D/g, "")
    if (!digits) continue
    // A second sighting poisons the entry rather than overwriting it, so the
    // result cannot depend on row order.
    index.set(digits, index.has(digits) ? null : { id: member.id, business_id: member.business_id })
  }
  return index
}

export function matchSender(
  index: Map<string, SenderMatch | null>,
  from: string,
): { match: SenderMatch | null; ambiguous: boolean } {
  const digits = from.replace(/\D/g, "")
  const entry = index.get(digits)
  return { match: entry ?? null, ambiguous: index.has(digits) && entry === null }
}
