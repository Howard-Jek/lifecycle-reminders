/**
 * Meta template administration: what state is the template in, and submit it.
 *
 * Lives in the app rather than only in scripts/ so the settings page and the
 * CLI ask Meta the same questions in the same way. Two implementations of
 * "is the template approved?" would eventually disagree, and the moment they
 * disagreed is the moment somebody turned dry-run off.
 *
 * ONE number for the whole deployment, deliberately. The host app onboards a
 * WhatsApp number per business through Embedded Signup, because it messages
 * customers as that business. This add-on messages YOUR OWN AGENTS, so it is
 * one platform identity configured in env — no per-business signup, no
 * encrypted token table, and one template to get approved rather than one per
 * tenant.
 */

import { GRAPH_API_VERSION } from "@/lib/whatsapp-graph-version"
import {
  CLIENT_EVENT_REMINDER_TEMPLATE,
  CLIENT_EVENT_REMINDER_LANGUAGE,
  clientEventReminderTemplateDefinition,
} from "./client-event-reminder"

export type TemplateReviewState =
  | "APPROVED"
  | "PENDING"
  | "REJECTED"
  | "PAUSED"
  | "DISABLED"
  | "NOT_SUBMITTED"
  | "UNKNOWN"

export type WhatsappCredentials = { wabaId: string; accessToken: string }

export type TemplateStatus =
  | {
      ok: true
      state: TemplateReviewState
      /** Meta's reason, when it rejected. */
      rejectedReason: string | null
      category: string | null
      language: string | null
      /** Set when a template of this name exists in a DIFFERENT language. */
      languageMismatch: string | null
    }
  | { ok: false; error: string }

/** Credentials for the platform number, or null when unconfigured. */
export function readWhatsappCredentials(): WhatsappCredentials | null {
  const wabaId = process.env.GOMA_NOTIFY_WABA_ID?.trim()
  const accessToken = process.env.GOMA_NOTIFY_ACCESS_TOKEN?.trim()
  if (!wabaId || !accessToken) return null
  return { wabaId, accessToken }
}

/**
 * Meta puts the useful text in `error_user_title` / `error_user_msg`, not
 * `message` — a duplicate-name submission reports `message: "Invalid
 * parameter"` and explains itself only in `error_user_msg`. Reading only
 * `message` sends the operator to debug a payload that is fine.
 */
type GraphError = {
  message?: string
  code?: number
  error_subcode?: number
  error_user_title?: string
  error_user_msg?: string
}

function describeGraphError(error: GraphError | undefined, status: number): string {
  if (!error) return `HTTP ${status}, no message returned`
  const detailed = [error.error_user_title, error.error_user_msg].filter(Boolean).join(" — ")
  const base = detailed || error.message || `HTTP ${status}`
  return error.code ? `${base} (#${error.code})` : base
}

type RemoteTemplate = {
  name?: string
  status?: string
  category?: string
  language?: string
  rejected_reason?: string
  components?: Array<{ type?: string; text?: string }>
}

/**
 * Ask Meta where the review has got to.
 *
 * `rejected_reason` is explicitly requested: it is NOT in the edge's default
 * field set, so without it the REJECTED branch can only ever say "none" — in
 * the one situation where Meta's answer is the entire point.
 */
export async function fetchTemplateStatus(
  creds: WhatsappCredentials,
  name = CLIENT_EVENT_REMINDER_TEMPLATE,
  language = CLIENT_EVENT_REMINDER_LANGUAGE,
  /** Lets a caller with a deadline actually cancel the request rather than
   * merely stop waiting for it. */
  signal?: AbortSignal,
): Promise<TemplateStatus> {
  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${creds.wabaId}/message_templates` +
    `?name=${encodeURIComponent(name)}&limit=50` +
    `&fields=name,language,status,category,rejected_reason,components`

  let res: Response
  try {
    // The token travels in the header, never the query string: Graph and every
    // proxy between here and it log full URLs.
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      signal,
    })
  } catch (e) {
    return { ok: false, error: `could not reach graph.facebook.com — ${(e as Error).message}` }
  }

  const data = (await res.json().catch(() => null)) as
    | { data?: RemoteTemplate[]; error?: GraphError }
    | null

  if (!res.ok) return { ok: false, error: describeGraphError(data?.error, res.status) }

  // Meta's ?name= filter has behaved as a prefix match, so re-filter locally
  // rather than reporting a neighbouring template's status as this one's.
  const named = (data?.data ?? []).filter((t) => t.name === name)
  const exact = named.find((t) => t.language === language)

  if (!exact) {
    // A same-named template in another language is NOT "registered". WhatsApp
    // Manager creates templates as en_US by default, and the sender asks for
    // "en" — reporting that as approved guarantees #132001 on every send.
    const otherLanguages = Array.from(new Set(named.map((t) => t.language ?? "unknown")))
    return {
      ok: true,
      state: "NOT_SUBMITTED",
      rejectedReason: null,
      category: null,
      language: null,
      languageMismatch: otherLanguages.length > 0 ? otherLanguages.join(", ") : null,
    }
  }

  const state = (exact.status ?? "").toUpperCase()
  const known: TemplateReviewState[] = ["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED"]

  return {
    ok: true,
    state: (known as string[]).includes(state) ? (state as TemplateReviewState) : "UNKNOWN",
    rejectedReason: exact.rejected_reason ?? null,
    category: exact.category ?? null,
    language: exact.language ?? null,
    languageMismatch: null,
  }
}

export type SubmitResult = { ok: true; id: string | null } | { ok: false; error: string }

/** Submit the template for review. The definition comes from
 * client-event-reminder.ts — the same string the sender and sandbox use. */
export async function submitTemplate(creds: WhatsappCredentials): Promise<SubmitResult> {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${creds.wabaId}/message_templates`

  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(clientEventReminderTemplateDefinition()),
    })
  } catch (e) {
    return { ok: false, error: `could not reach graph.facebook.com — ${(e as Error).message}` }
  }

  const data = (await res.json().catch(() => null)) as
    | { id?: string; error?: GraphError }
    | null

  if (!res.ok) return { ok: false, error: describeGraphError(data?.error, res.status) }
  return { ok: true, id: data?.id ?? null }
}

/** Plain-English guidance per state, for the settings page. */
export function describeState(status: Extract<TemplateStatus, { ok: true }>): {
  tone: "good" | "waiting" | "bad"
  headline: string
  detail: string
} {
  switch (status.state) {
    case "APPROVED":
      return {
        tone: "good",
        headline: "Approved",
        detail:
          "Reminders can be delivered for real. Clear REMINDER_DRY_RUN when you are ready — until then everything still runs, it just does not reach WhatsApp.",
      }
    case "PENDING":
      return {
        tone: "waiting",
        headline: "In review with Meta",
        detail:
          "Usually under an hour, sometimes several. Leave dry run on: a reminder sent against a pending template burns all three retries in about 45 minutes and lands terminally failed.",
      }
    case "REJECTED":
      return {
        tone: "bad",
        headline: "Rejected",
        detail:
          status.rejectedReason ??
          "Meta gave no reason. The usual causes are a missing example value or a category mismatch.",
      }
    case "PAUSED":
    case "DISABLED":
      return {
        tone: "bad",
        headline: status.state === "PAUSED" ? "Paused by Meta" : "Disabled by Meta",
        detail:
          "This happens after recipients report the messages. Check the template's quality rating in WhatsApp Manager.",
      }
    case "NOT_SUBMITTED":
      return {
        tone: "waiting",
        headline: status.languageMismatch
          ? `Exists, but in ${status.languageMismatch} — not ${CLIENT_EVENT_REMINDER_LANGUAGE}`
          : "Not submitted yet",
        detail: status.languageMismatch
          ? `The sender asks for "${CLIENT_EVENT_REMINDER_LANGUAGE}". Submit that language too, or every send fails with #132001.`
          : "Submit it now — this is the only step with a queue in front of it, so start it before anything else.",
      }
    default:
      return {
        tone: "waiting",
        headline: "Unknown state",
        detail: "Meta returned a status this app does not recognise. Check WhatsApp Manager.",
      }
  }
}


/**
 * The state of the number we send FROM.
 *
 * Exists because "#133010 Account not registered" names a condition without
 * naming its subject, and the natural reading is the wrong one: it sounds like
 * the RECIPIENT is not registered. Recipients register nothing — anyone with
 * WhatsApp can receive a business template. It is the SENDING number that must
 * complete Cloud API registration, and that is a step separate from adding the
 * number to a WABA, which is why a number can look perfectly healthy in the
 * dashboard and still refuse every send.
 */
export type PhoneNumberStatus =
  | {
      ok: true
      /** The dialable number, so you can see WHICH number this deployment uses. */
      displayPhoneNumber: string | null
      verifiedName: string | null
      /**
       * The DISPLAY NAME's review state, which is not the number's state and
       * fails independently of it. APPROVED / AVAILABLE_WITHOUT_REVIEW are fine;
       * DECLINED means Meta rejected the name and the number's ability to send
       * is restricted while it stands — with no error at send time, because the
       * Graph call still returns a message id.
       */
      nameStatus: string | null
      /**
       * The review state of a NEWLY SUBMITTED display name.
       *
       * Meta keeps the old name in verified_name until a replacement is
       * approved, so after submitting a new one the number still reports the
       * rejected name and DECLINED — which reads exactly like the submission
       * never happened. This is the only field that shows it did.
       */
      newNameStatus: string | null
      /** CONNECTED once registration is complete. */
      status: string | null
      /** CLOUD_API when registered for the Cloud API; NOT_APPLICABLE when not. */
      platformType: string | null
      qualityRating: string | null
      /** True when Meta reports it as usable for Cloud API sends. */
      registered: boolean
    }
  | { ok: false; error: string }

export async function fetchPhoneNumberStatus(
  accessToken: string,
  phoneNumberId: string,
): Promise<PhoneNumberStatus> {
  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}` +
    `?fields=display_phone_number,verified_name,name_status,new_name_status,status,platform_type,quality_rating`

  let res: Response
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  } catch (e) {
    return { ok: false, error: `could not reach graph.facebook.com — ${(e as Error).message}` }
  }

  const data = (await res.json().catch(() => null)) as
    | {
        display_phone_number?: string
        verified_name?: string
        name_status?: string
        new_name_status?: string
        status?: string
        platform_type?: string
        quality_rating?: string
        error?: GraphError
      }
    | null

  if (!res.ok) return { ok: false, error: describeGraphError(data?.error, res.status) }

  const status = data?.status ?? null
  const platformType = data?.platform_type ?? null
  const nameStatus = data?.name_status ?? null
  const newNameStatus = data?.new_name_status ?? null
  return {
    ok: true,
    displayPhoneNumber: data?.display_phone_number ?? null,
    verifiedName: data?.verified_name ?? null,
    nameStatus,
    newNameStatus,
    status,
    platformType,
    qualityRating: data?.quality_rating ?? null,
    // THREE signals, because each fails independently and none of them is
    // visible at send time. A number can read CONNECTED (registered) with
    // platform_type CLOUD_API (on the right platform) and still deliver
    // nothing, because its DISPLAY NAME was declined — Meta restricts sending
    // on a rejected name while the Graph call goes on returning message ids.
    // Leaving name_status out of this is what turned a one-field answer into an
    // afternoon of guessing.
    registered:
      status === "CONNECTED" &&
      platformType === "CLOUD_API" &&
      nameStatus !== "DECLINED" &&
      nameStatus !== "PENDING_REVIEW",
  }
}

export type RegisterResult = { ok: true } | { ok: false; error: string }

/**
 * Register the sending number for the Cloud API.
 *
 * The step that clears "#133010 Account not registered", and it is separate
 * from adding the number to a WABA — which is why a number can sit in the
 * dashboard looking healthy and still refuse every send.
 *
 * The PIN is the number's six-digit two-step verification PIN. If two-step was
 * never enabled, this call SETS it to whatever is passed; if it was, the value
 * must match. Meta rate-limits wrong attempts and will lock registration for a
 * period, so this is not something to brute force — get the PIN from whoever
 * set it up rather than guessing.
 */
export async function registerPhoneNumber(
  accessToken: string,
  phoneNumberId: string,
  pin: string,
): Promise<RegisterResult> {
  let res: Response
  try {
    res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/register`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messaging_product: "whatsapp", pin }),
      },
    )
  } catch (e) {
    return { ok: false, error: `could not reach graph.facebook.com — ${(e as Error).message}` }
  }

  const data = (await res.json().catch(() => null)) as
    | { success?: boolean; error?: GraphError }
    | null

  if (!res.ok) return { ok: false, error: describeGraphError(data?.error, res.status) }
  return { ok: true }
}


/**
 * Which apps are subscribed to this WABA's webhooks.
 *
 * Verifying the callback URL and SUBSCRIBING to webhook fields are two
 * different actions in Meta's dashboard, and the first is the one that gives
 * you a satisfying green tick. An app can therefore pass the handshake, show a
 * verified URL, and receive nothing at all — for ever, silently, because a
 * webhook that is not subscribed produces no error and no traffic.
 *
 * Worth checking whenever the symptom is "we never hear anything back".
 */
export type SubscriptionStatus =
  | { ok: true; subscribedApps: Array<{ id: string | null; name: string | null }> }
  | { ok: false; error: string }

export async function fetchSubscribedApps(
  accessToken: string,
  wabaId: string,
): Promise<SubscriptionStatus> {
  let res: Response
  try {
    res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/subscribed_apps`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
  } catch (e) {
    return { ok: false, error: `could not reach graph.facebook.com — ${(e as Error).message}` }
  }
  const data = (await res.json().catch(() => null)) as
    | { data?: Array<{ whatsapp_business_api_data?: { id?: string; name?: string } }>; error?: GraphError }
    | null
  if (!res.ok) return { ok: false, error: describeGraphError(data?.error, res.status) }
  return {
    ok: true,
    subscribedApps: (data?.data ?? []).map((row) => ({
      id: row.whatsapp_business_api_data?.id ?? null,
      name: row.whatsapp_business_api_data?.name ?? null,
    })),
  }
}


/**
 * Subscribe this app to the WABA's webhooks.
 *
 * The counterpart to fetchSubscribedApps: verifying the callback URL proves we
 * own it, this is what actually turns the tap on. Without it Meta accepts every
 * send, returns a real message id, and never reports what became of it — the
 * message simply disappears, and so does every failure reason.
 *
 * Idempotent: subscribing an already-subscribed app succeeds and changes
 * nothing, so it is safe to call whenever the diagnostic says the list is
 * empty.
 */
export async function subscribeApp(
  accessToken: string,
  wabaId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let res: Response
  try {
    res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/subscribed_apps`,
      { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } },
    )
  } catch (e) {
    return { ok: false, error: `could not reach graph.facebook.com — ${(e as Error).message}` }
  }
  const data = (await res.json().catch(() => null)) as
    | { success?: boolean; error?: GraphError }
    | null
  if (!res.ok) return { ok: false, error: describeGraphError(data?.error, res.status) }
  return { ok: true }
}
