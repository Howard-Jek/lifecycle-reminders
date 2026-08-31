/**
 * Meta's send and delivery error codes, turned into something an operator can
 * act on — and into the one fact the retry policy needs: may this be tried
 * again at all.
 *
 * PORTED from jottiteam/lead-reactivation-agent, branch
 * `feature/resend-failed-message-and-error-mapping`, file `src/lib/whatsapp-errors.ts`.
 * The host owns this path. At integration, DELETE THIS FILE and import theirs —
 * do not three-way merge two copies that have drifted apart.
 *
 * Two deliberate departures from the copy, both of which have to survive that
 * deletion or this product regresses:
 *
 *   1. `leadingCode` accepts "[131047] …" as well as "131026: …". This repo
 *      flattens failures with a bracket prefix (see describeErrors in
 *      webhook-events.ts); the upstream parser matched only the colon form, so
 *      ported verbatim it would have returned the generic message for every
 *      row this product has ever written, silently.
 *   2. `retryable`, read by the delivery loop. Upstream only ever shows this
 *      to a human who then decides; here a cron does, and retrying a handset
 *      that is not on WhatsApp costs three billed sends to learn nothing.
 *
 * Code reference:
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */

export type WhatsappErrorInfo = {
  /** Short headline, e.g. "Meta couldn't deliver this message". */
  title: string
  /** One actionable sentence telling the operator what to check or do. */
  action: string
  /**
   * Whether trying the identical send again could plausibly succeed.
   *
   * The question is narrow on purpose: not "is this the operator's fault" but
   * "does repeating this exact request, later, have a path to working". A rate
   * limit does. A number that is not on WhatsApp does not, and neither does a
   * template that does not exist — those need a person, and burning the
   * attempt cap in the meantime just hides the failure behind a queue.
   */
  retryable: boolean
}

/** Per-code guidance. Keep messages operator-friendly — no Meta jargon. */
const ERROR_GUIDANCE: Record<string, WhatsappErrorInfo> = {
  "131026": {
    title: "Meta couldn't deliver this message",
    action:
      "The number may not be on WhatsApp, may have an outdated app, or hasn't accepted WhatsApp's terms. Check the number on the Team page, then send it again by hand.",
    retryable: false,
  },
  "131047": {
    title: "Outside the 24-hour reply window",
    action:
      "Meta wants an approved template to re-open this conversation. Reminders already send one, so this usually means the template was changed or is no longer approved — check Settings.",
    // A repeat of the identical send fails identically. Something has to change
    // first, and only a person can change it.
    retryable: false,
  },
  "131048": {
    title: "Held back as spam",
    action:
      "Meta flagged this number for too many unanswered messages. Slow down sending to this person and wait before trying again.",
    retryable: false,
  },
  "131049": {
    title: "Held back by Meta",
    action:
      "Meta limited delivery to protect engagement quality. This usually clears on its own; it will be tried again.",
    retryable: true,
  },
  "131030": {
    title: "Recipient not on your allowed list",
    action:
      "Your WhatsApp number is still in test mode. Add this recipient in Meta, or finish business verification to message anyone.",
    retryable: false,
  },
  "131051": {
    title: "Unsupported message type",
    action: "This message type can't be delivered to this recipient.",
    retryable: false,
  },
  "131042": {
    title: "Billing isn't set up",
    action:
      "Meta won't send until the WhatsApp account has a valid payment method. Add one in Meta Business Settings — queued reminders will go out once it is accepted.",
    // Nothing about the send is wrong; it starts working the moment they pay,
    // and the backoff is measured in days, which is about the right patience.
    retryable: true,
  },
  "132000": {
    title: "The template didn't match what was sent",
    action:
      "The reminder template expects a different number of values than it was given. Re-register it from Settings.",
    retryable: false,
  },
  "132001": {
    title: "The reminder template is missing",
    action:
      "This WhatsApp account has no approved `client_event_reminder` template. Register it from Settings — reminders cannot send until Meta approves it.",
    retryable: false,
  },
  "130429": {
    title: "Sending too fast",
    action: "You've hit WhatsApp's rate limit. It will be tried again shortly.",
    retryable: true,
  },
  "130472": {
    title: "Held back by a Meta experiment",
    action:
      "Meta excluded this recipient from delivery as part of an experiment. It will be tried again.",
    retryable: true,
  },
  "368": {
    title: "Temporarily blocked for policy reasons",
    action:
      "Meta restricted your number for a policy violation. Review WhatsApp's messaging policies before sending again.",
    retryable: false,
  },
  "100": {
    title: "Meta rejected the request",
    action:
      "Something in the request was invalid — most often the phone number format. Make sure it's the full international number (e.g. +65…), then send it again by hand.",
    retryable: false,
  },
}

/**
 * Unknown codes are RETRYABLE.
 *
 * The alternative — assume permanent — would silently stop retrying a whole
 * class of transient failures the first time Meta ships a code we have not
 * mapped, and nothing would report that it had happened. Retrying is already
 * bounded by the attempt cap and the backoff, so the cost of guessing wrong
 * this way is a few sends; the cost of guessing wrong the other way is
 * reminders that quietly stop being delivered.
 */
const GENERIC: WhatsappErrorInfo = {
  title: "Message couldn't be sent",
  action:
    "WhatsApp rejected this message. Check the recipient's number and try again — if it keeps failing, see the possible causes below.",
  retryable: true,
}

/**
 * Reference list shown in the "Why did this fail?" help. Deliberately
 * code-agnostic so it stays useful for errors we don't map individually.
 */
export const WHATSAPP_FAILURE_CAUSES: string[] = [
  "The phone number is wrong, or isn't a full international number (e.g. +65…).",
  "The number isn't registered on WhatsApp.",
  "The recipient is using an outdated version of WhatsApp.",
  "The recipient hasn't accepted WhatsApp's latest terms.",
  "The recipient blocked your business number.",
  "Your WhatsApp number is in test mode and the recipient isn't on the allowed list.",
  "The reminder template isn't approved on this WhatsApp account.",
  "The WhatsApp account has no valid payment method.",
  "Meta rate-limited or temporarily restricted your number for policy or quality reasons.",
]

/**
 * Resolve guidance for a failed message.
 *
 * `errorCode` is preferred. `errorMessage` is the fallback for rows written
 * before the error_code column existed, where the code survives only as the
 * leading token of the flattened reason.
 */
export function describeWhatsappError(
  errorCode: string | null | undefined,
  errorMessage: string | null | undefined,
): WhatsappErrorInfo {
  const code = errorCode ?? leadingCode(errorMessage)
  return (code && ERROR_GUIDANCE[code]) || GENERIC
}

/** May this failure be tried again unchanged? See WhatsappErrorInfo.retryable. */
export function isRetryableFailure(
  errorCode: string | null | undefined,
  errorMessage?: string | null,
): boolean {
  return describeWhatsappError(errorCode, errorMessage).retryable
}

/**
 * The code at the START of a flattened reason, in either spelling this codebase
 * produces: "[131047] detail" here, "131026: title" in the host.
 *
 * Anchored deliberately. An unanchored search would read "waited 131026 ms" as
 * a delivery failure and hand the operator confident, wrong advice.
 */
function leadingCode(errorMessage: string | null | undefined): string | null {
  if (!errorMessage) return null
  const match = errorMessage.match(/^\s*[[(#]?(\d{2,6})[\])]?\s*[:)\]\s]/)
  return match ? match[1] : null
}
