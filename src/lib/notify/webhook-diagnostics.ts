/**
 * "Why won't Meta verify my callback URL?", answerable by pressing a button.
 *
 * Meta reports at least six different faults as one string — "The callback URL
 * or verify token couldn't be validated" — and never says which URL it called,
 * what came back, or which of the two halves was wrong. That sentence is the
 * whole diagnostic Meta offers, and it is worth nothing.
 *
 * These probes run SERVER-SIDE, from the deployment itself, because that is the
 * only vantage point that sees what Meta sees. A laptop behind a corporate
 * proxy, or an agent sandbox on an egress allowlist, can reach neither end and
 * so cannot tell "your webhook is broken" from "I am not allowed to look".
 *
 * NOTHING HERE RETURNS A SECRET. Statuses, Meta's own error text, and the
 * lengths of things — never a token, never an app secret. Same rule
 * /api/health follows, for the same reason: whoever presses this button is
 * usually reading the result out loud to somebody else.
 */

import { GRAPH_API_VERSION } from "@/lib/whatsapp-graph-version"

/**
 * The one path Meta is registered against.
 *
 * Kept as a constant so the probe and the route cannot drift apart. If this
 * ever disagrees with the directory that holds route.ts, the probe becomes a
 * test of a URL nobody serves — passing or failing for reasons unrelated to
 * the webhook Meta actually calls.
 */
export const WEBHOOK_PATH = "/api/webhooks/whatsapp"

/**
 * `messages` carries BOTH inbound replies and delivery receipts. They look like
 * two concerns and are one field; subscribing to a second name is how you end
 * up with a subscription that verifies and then delivers nothing.
 */
export const WEBHOOK_FIELDS = "messages"

/** Comfortably inside Meta's own patience, and short enough that a hung
 * callback URL reports a timeout rather than the button appearing to freeze. */
const TIMEOUT_MS = 10_000

export type ProbeTone = "good" | "bad" | "waiting"

export type Probe = {
  label: string
  tone: ProbeTone
  /** The HTTP status, or null when the request never completed at all. */
  status: number | null
  /** One sentence, safe to read aloud. */
  detail: string
  /** A monospace line under the detail: a URL, or Meta's raw error. */
  evidence?: string
}

export type MetaAppCredentials = { appId: string; appSecret: string }

/** The Meta *app* identity, which is not the WABA identity. Null when unset. */
export function readMetaAppCredentials(): MetaAppCredentials | null {
  const appId = process.env.GOMA_NOTIFY_APP_ID?.trim()
  const appSecret = process.env.GOMA_NOTIFY_APP_SECRET?.trim()
  if (!appId || !appSecret) return null
  return { appId, appSecret }
}

/**
 * An app access token is literally `{app-id}|{app-secret}`.
 *
 * It goes in the Authorization header rather than the query string, like every
 * other Graph call in this codebase: Graph and every proxy in front of it log
 * full URLs, and this particular credential never expires.
 */
function appAccessToken(creds: MetaAppCredentials): string {
  return `${creds.appId}|${creds.appSecret}`
}

type GraphError = {
  message?: string
  code?: number
  error_subcode?: number
  error_user_title?: string
  error_user_msg?: string
}

/** Meta hides the useful sentence in error_user_msg; `message` is often just
 * "Invalid parameter". Reading only `message` sends you to debug a fine payload. */
function describeGraphError(error: GraphError | undefined, status: number): string {
  if (!error) return `HTTP ${status}, no message returned`
  const detailed = [error.error_user_title, error.error_user_msg].filter(Boolean).join(" — ")
  const base = detailed || error.message || `HTTP ${status}`
  return error.code ? `${base} (#${error.code})` : base
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Strip the verify token out of anything about to be shown.
 *
 * NOT paranoia. A 308's Location header echoes the entire query string back,
 * token included, and this panel is exactly the thing an operator screenshots
 * into a support thread. The token reaches the wire and stops there.
 *
 * Case-insensitive because percent-encoding's hex digits vary by producer —
 * one layer answers %3F where the next sends %3f — and over-redacting a display
 * string costs nothing.
 */
function redactSecret(text: string, secret: string): string {
  if (!secret) return text
  let out = text
  for (const form of [secret, encodeURIComponent(secret)]) {
    out = out.replace(new RegExp(escapeRegExp(form), "gi"), "…")
  }
  return out
}

/**
 * The single choke point.
 *
 * Every branch below builds its evidence from server-controlled text, so
 * redacting at each return is a rule someone eventually forgets. Redacting
 * once, here, is a rule that cannot be forgotten.
 */
function redactProbe(probe: Probe, secret: string): Probe {
  return {
    ...probe,
    detail: redactSecret(probe.detail, secret),
    evidence: probe.evidence === undefined ? undefined : redactSecret(probe.evidence, secret),
  }
}

/**
 * WHICH of the three rows did this deployment actually get?
 *
 * Vercel scopes variables per environment, so GOMA_NOTIFY_VERIFY_TOKEN
 * legitimately exists three times — Production, Preview, Development — and
 * /api/health only ever said `true`. A boolean cannot tell you that the
 * preview you are testing holds a different token from the one Meta calls,
 * which is a fault that looks exactly like a wrong token and is not one.
 *
 * Length and surrounding whitespace are enough to line the three rows up
 * against each other and against Meta's box. Neither discloses the value: a
 * length is not a secret, and the whitespace flag is the one property that
 * routinely breaks this and is invisible in every UI that shows it.
 */
export function fingerprintVerifyToken(raw: string | undefined): Probe {
  const label = "The verify token this deployment holds"
  // "local" rather than a guess: absent VERCEL_ENV means this is not running on
  // Vercel at all, and saying "development" would name a row that is not in play.
  const environment = process.env.VERCEL_ENV?.trim() || "local"

  if (!raw || !raw.trim()) {
    return {
      label,
      tone: "bad",
      status: null,
      detail:
        "GOMA_NOTIFY_VERIFY_TOKEN is not set on this deployment. If it is set in Vercel, it is " +
        "set for a DIFFERENT environment than this one — or was added without redeploying.",
      evidence: `environment: ${environment} · not configured`,
    }
  }

  const trimmed = raw.trim()
  const padded = trimmed.length !== raw.length

  if (padded) {
    return {
      label,
      tone: "bad",
      status: null,
      detail:
        "The stored value has whitespace around it. This end trims it, so the handshake still " +
        "works — but it means the value was pasted with padding, and the SAME paste into Meta's " +
        "box is not trimmed and does fail. Re-copy both from one source.",
      evidence: `environment: ${environment} · ${trimmed.length} characters + surrounding whitespace`,
    }
  }

  return {
    label,
    tone: "good",
    status: null,
    detail:
      `${trimmed.length} characters, no surrounding whitespace. Compare that count against the ` +
      `other environments' rows and against the token in Meta's dashboard — a different length ` +
      `is a different token, and is the whole fault.`,
    evidence: `environment: ${environment} · ${trimmed.length} characters`,
  }
}

/** The callback URL this deployment believes it serves. */
export function callbackUrlFor(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}${WEBHOOK_PATH}`
}

/**
 * PROBE 1 — call our own callback URL exactly the way Meta does.
 *
 * The single most informative check available, because it exercises everything
 * between the public internet and the route handler: DNS, TLS, Vercel's
 * deployment protection, the auth middleware, trailing-slash redirects, and
 * only then the token comparison.
 */
export async function probeCallbackUrl(
  callbackUrl: string,
  verifyToken: string | undefined,
): Promise<Probe> {
  const token = verifyToken?.trim()
  if (!token) {
    return {
      label: CALLBACK_PROBE_LABEL,
      tone: "bad",
      status: null,
      detail:
        "GOMA_NOTIFY_VERIFY_TOKEN is not set on this deployment, so the handshake cannot " +
        "succeed whatever Meta sends. Set it, then redeploy — Vercel does not apply new " +
        "variables to an already-built deployment.",
    }
  }
  return redactProbe(await runCallbackProbe(callbackUrl, token), token)
}

const CALLBACK_PROBE_LABEL = "Callback URL answers Meta's handshake"

async function runCallbackProbe(callbackUrl: string, token: string): Promise<Probe> {
  const label = CALLBACK_PROBE_LABEL

  // A fresh challenge every press. Meta sends a random one; echoing a constant
  // would let a cached or replayed response pass as a live success.
  const challenge = String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000)
  const query =
    `hub.mode=subscribe&hub.challenge=${challenge}` +
    `&hub.verify_token=${encodeURIComponent(token)}`
  // The real URL carries the token; the one we are willing to SHOW does not.
  const shown = `${callbackUrl}?hub.mode=subscribe&hub.challenge=${challenge}&hub.verify_token=…`

  let res: Response
  try {
    res = await fetch(`${callbackUrl}?${query}`, {
      // MANUAL, deliberately. Meta does not follow redirects on this handshake,
      // so a 307 or 308 IS the failure. Following it here would silently turn
      // the most common cause of this bug into a green tick.
      redirect: "manual",
      headers: { "user-agent": "facebookplatform/1.0 (+http://developers.facebook.com)" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    })
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return {
      label,
      tone: "bad",
      status: null,
      detail: `Could not reach the callback URL at all — ${reason}. Check APP_PUBLIC_URL points at this deployment's real public hostname.`,
      evidence: shown,
    }
  }

  const status = res.status
  const contentType = res.headers.get("content-type") ?? ""
  const body = await res.text().catch(() => "")

  if (status >= 300 && status < 400) {
    const location = res.headers.get("location")
    return {
      label,
      tone: "bad",
      status,
      detail:
        `The URL redirected, and Meta does not follow redirects here — it needs a direct 200. ` +
        `This is what a trailing slash, a wrong path, or the auth middleware looks like.`,
      evidence: `${status} → ${location ?? "(no location header)"}`,
    }
  }

  // Vercel's deployment protection answers before our code ever runs, and it
  // answers with HTML. Our own refusal is text/plain "Forbidden". Telling these
  // apart is the difference between "fix the token" and "the token is fine and
  // Meta was never let through the front door".
  const looksLikeVercelGate =
    contentType.includes("text/html") || /authentication required|vercel/i.test(body.slice(0, 400))

  if ((status === 401 || status === 403) && looksLikeVercelGate) {
    return {
      label,
      tone: "bad",
      status,
      detail:
        "Something in front of the app rejected the request before the route ran — almost " +
        "certainly Vercel Deployment Protection. Turn it off for Production, or add a " +
        "protection bypass, otherwise Meta can never reach the webhook.",
      evidence: `${status} ${contentType || "(no content-type)"}`,
    }
  }

  if (status === 403) {
    return {
      label,
      tone: "bad",
      status,
      detail:
        "The route ran and refused the token. The value in GOMA_NOTIFY_VERIFY_TOKEN is not " +
        "byte-identical to the one sent — check for a trailing space or a missing character, " +
        "and check the deployment was rebuilt after the variable last changed.",
      evidence: `403 ${body.slice(0, 120)}`,
    }
  }

  if (status === 503) {
    return {
      label,
      tone: "bad",
      status,
      detail:
        "The route ran but reports no verify token configured. The variable is set in this " +
        "process yet absent from the deployment serving the URL — the usual cause is two " +
        "different deployments, or a variable added without redeploying.",
      evidence: `503 ${body.slice(0, 120)}`,
    }
  }

  if (status === 404) {
    return {
      label,
      tone: "bad",
      status,
      detail:
        "Nothing is served at that path. The callback URL is wrong, or APP_PUBLIC_URL points " +
        "at a deployment that does not have this route.",
      evidence: shown,
    }
  }

  if (status !== 200) {
    return {
      label,
      tone: "bad",
      status,
      detail: `Unexpected status. Meta needs exactly 200 with the challenge as the body.`,
      evidence: `${status} ${body.slice(0, 200)}`,
    }
  }

  // 200 is necessary and not sufficient: Meta compares the body byte-for-byte.
  // A JSON-wrapped or whitespace-padded challenge is a 200 that still fails.
  if (body !== challenge) {
    return {
      label,
      tone: "bad",
      status,
      detail:
        "Answered 200, but the body was not the challenge verbatim. Meta compares it " +
        "byte-for-byte, so a quoted or JSON-wrapped value fails here.",
      evidence: `expected ${challenge} · got ${JSON.stringify(body.slice(0, 80))}`,
    }
  }

  return {
    label,
    tone: "good",
    status,
    detail: "200, and the challenge came back verbatim. Meta's handshake would succeed.",
    evidence: shown,
  }
}

type SubscriptionEntry = {
  object?: string
  callback_url?: string
  active?: boolean
  fields?: Array<{ name?: string } | string>
}

/**
 * PROBE 2 — what URL does Meta actually have on file?
 *
 * The check that ends the argument. If probe 1 is green and Meta still refuses,
 * it is because the URL in Meta's dashboard is not the URL you tested — and
 * this prints Meta's copy next to ours so the difference is visible rather
 * than argued about.
 */
export async function probeStoredSubscription(
  creds: MetaAppCredentials,
  expectedCallbackUrl: string,
): Promise<Probe> {
  const label = "The callback URL Meta has on file"

  let res: Response
  try {
    res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${creds.appId}/subscriptions`,
      {
        headers: { Authorization: `Bearer ${appAccessToken(creds)}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      },
    )
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { label, tone: "bad", status: null, detail: `Could not reach graph.facebook.com — ${reason}` }
  }

  const json = (await res.json().catch(() => null)) as
    | { data?: SubscriptionEntry[]; error?: GraphError }
    | null

  if (!res.ok || json?.error) {
    return {
      label,
      tone: "bad",
      status: res.status,
      detail: "Meta refused the question. Usually GOMA_NOTIFY_APP_ID and GOMA_NOTIFY_APP_SECRET are not from the same app.",
      evidence: describeGraphError(json?.error, res.status),
    }
  }

  const entry = (json?.data ?? []).find((d) => d.object === "whatsapp_business_account")
  if (!entry) {
    return {
      label,
      tone: "waiting",
      status: res.status,
      detail:
        "No whatsapp_business_account subscription exists on this app yet. That is the normal " +
        "state before the first successful verification — use Register below.",
    }
  }

  const registered = entry.callback_url ?? "(none)"
  if (registered.replace(/\/+$/, "") !== expectedCallbackUrl.replace(/\/+$/, "")) {
    return {
      label,
      tone: "bad",
      status: res.status,
      detail:
        "Meta has a DIFFERENT callback URL registered from the one this deployment serves. " +
        "This is the fault, and no amount of retrying the token will fix it.",
      evidence: `Meta: ${registered}\nHere: ${expectedCallbackUrl}`,
    }
  }

  const fields = (entry.fields ?? [])
    .map((f) => (typeof f === "string" ? f : f?.name))
    .filter(Boolean)
    .join(", ")
  const hasMessages = fields.includes(WEBHOOK_FIELDS)

  return {
    label,
    tone: entry.active !== false && hasMessages ? "good" : "waiting",
    status: res.status,
    detail:
      entry.active === false
        ? "The subscription exists but Meta has marked it inactive — it usually deactivates one that returned non-2xx repeatedly."
        : hasMessages
          ? "Registered, active, and subscribed to messages."
          : `Registered and active, but not subscribed to "${WEBHOOK_FIELDS}" — nothing will be delivered.`,
    evidence: `${registered}\nfields: ${fields || "(none)"}`,
  }
}

/**
 * THE ACTUAL VERIFY — ask Meta to call the callback URL and register it.
 *
 * This is what the dashboard's button does, except that Graph answers with a
 * real error code and sentence instead of the one useless string. Re-running it
 * for a URL already registered is harmless: Meta re-verifies and overwrites.
 */
export async function registerSubscription(
  creds: MetaAppCredentials,
  callbackUrl: string,
  verifyToken: string,
): Promise<Probe> {
  const label = "Meta's verification of the callback URL"

  const form = new URLSearchParams({
    object: "whatsapp_business_account",
    callback_url: callbackUrl,
    verify_token: verifyToken,
    fields: WEBHOOK_FIELDS,
  })

  let res: Response
  try {
    res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${creds.appId}/subscriptions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${appAccessToken(creds)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    )
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { label, tone: "bad", status: null, detail: `Could not reach graph.facebook.com — ${reason}` }
  }

  const json = (await res.json().catch(() => null)) as
    | { success?: boolean; error?: GraphError }
    | null

  if (res.ok && json?.success) {
    return {
      label,
      tone: "good",
      status: res.status,
      detail: "Meta called the URL, got its challenge back, and registered the subscription. The webhook is verified.",
      evidence: callbackUrl,
    }
  }

  return {
    label,
    tone: "bad",
    status: res.status,
    detail: "Meta refused to register it. Its own reason is below — unlike the dashboard, this one names the fault.",
    evidence: describeGraphError(json?.error, res.status),
  }
}
