"use server"

import { revalidatePath } from "next/cache"
import { requireTenant } from "@/lib/tenant"
import { isDryRun, appPublicUrl } from "@/lib/env"
import {
  readWhatsappCredentials,
  fetchTemplateStatus,
  submitTemplate,
  fetchPhoneNumberStatus,
  registerPhoneNumber,
  type TemplateStatus,
} from "@/lib/notify/template-admin"
import { CLIENT_EVENT_REMINDER_TEMPLATE } from "@/lib/notify/client-event-reminder"
import {
  callbackUrlFor,
  fingerprintVerifyToken,
  probeCallbackUrl,
  probeStoredSubscription,
  registerSubscription,
  readMetaAppCredentials,
  type Probe,
} from "@/lib/notify/webhook-diagnostics"
import {
  describeNumberName,
  describeRegistration,
  type NameVerdict,
} from "@/lib/notify/number-diagnostics"
import { forgetTemplateState } from "./onboarding"
import type { ActionResult } from "./team-members"

/**
 * Everything about the WhatsApp identity that costs nothing to know.
 *
 * SPLIT FROM THE TEMPLATE STATUS DELIBERATELY. These are process.env reads;
 * the template state is a round trip to graph.facebook.com. Fetched together —
 * which they were — the whole Settings page waited on Meta before it could
 * render a single card, including the three that only ever touch Postgres.
 * Separated, the page renders and the one genuinely remote fact streams in.
 */
export type WhatsappConfig = {
  /** Which of the three GOMA_NOTIFY_* variables are present. */
  phoneNumberId: boolean
  wabaId: boolean
  accessToken: boolean
  /** All three present — the only state in which there is anything to ask Meta. */
  configured: boolean
  dryRun: boolean
  templateName: string
  /**
   * The webhook Meta calls back on. Booleans, never values: this object is
   * serialised into the page, and a verify token in the HTML source would be a
   * secret published to every browser that loads Settings.
   *
   * Lives on the cheap config rather than beside the probes because these are
   * process.env reads — the split this type exists for. The probes themselves
   * are a round trip and stay behind a button.
   */
  webhook: {
    /** Derived from APP_PUBLIC_URL, so a wrong value shows up here first. */
    callbackUrl: string
    verifyToken: boolean
    appSecret: boolean
    /** The Meta *app* id — a different identity from the WABA id above. */
    appId: boolean
  }
}

/** The three variables, read as one fact — both exports below need the same
 * predicate, and two spellings of "configured" would eventually disagree. */
function whatsappEnv() {
  const phoneNumberId = Boolean(process.env.GOMA_NOTIFY_PHONE_NUMBER_ID?.trim())
  const wabaId = Boolean(process.env.GOMA_NOTIFY_WABA_ID?.trim())
  const accessToken = Boolean(process.env.GOMA_NOTIFY_ACCESS_TOKEN?.trim())
  return { phoneNumberId, wabaId, accessToken, configured: phoneNumberId && wabaId && accessToken }
}

export async function getWhatsappConfig(): Promise<WhatsappConfig> {
  await requireTenant()
  return {
    ...whatsappEnv(),
    dryRun: isDryRun(),
    templateName: CLIENT_EVENT_REMINDER_TEMPLATE,
    webhook: {
      callbackUrl: callbackUrlFor(appPublicUrl()),
      verifyToken: Boolean(process.env.GOMA_NOTIFY_VERIFY_TOKEN?.trim()),
      appSecret: Boolean(process.env.GOMA_NOTIFY_APP_SECRET?.trim()),
      appId: Boolean(process.env.GOMA_NOTIFY_APP_ID?.trim()),
    },
  }
}

/**
 * Ask Meta where the review has got to. Null when credentials are missing —
 * there is nobody to ask.
 *
 * No deadline, on purpose, and that is why it must be streamed rather than
 * awaited with the rest of the page. The reminder inbox caps the same call at
 * three seconds and caches it for five minutes because it renders a checklist
 * that is usually hidden; Settings is the page an operator opens *in order to*
 * read this number, so a stale or timed-out answer here would be the wrong
 * answer. Correct and late beats fast and wrong — as long as being late costs
 * only this one card.
 */
export async function getTemplateStatus(): Promise<TemplateStatus | null> {
  await requireTenant()
  // Gated on all THREE variables rather than the two the fetch itself needs.
  // Without a phone number id nothing can be sent, so the template's review
  // state is not a fact worth a round trip — and the block that would show it
  // does not render. This also lets the page start the call before it knows
  // whether it will use the answer, without ever spending a request it wastes.
  if (!whatsappEnv().configured) return null
  const creds = readWhatsappCredentials()
  return creds ? fetchTemplateStatus(creds) : null
}

/**
 * Send the template to Meta for review.
 *
 * Deliberately has no confirmation step: submitting is free, reversible (you
 * can delete and resubmit), and the thing that costs time is NOT doing it.
 */
export async function submitReminderTemplate(): Promise<ActionResult<string>> {
  await requireTenant()

  const creds = readWhatsappCredentials()
  if (!creds) {
    return {
      ok: false,
      error:
        "GOMA_NOTIFY_WABA_ID and GOMA_NOTIFY_ACCESS_TOKEN are not set. Add them to .env.local (or your deployment's environment) and restart.",
    }
  }

  const result = await submitTemplate(creds)
  if (!result.ok) return { ok: false, error: result.error }

  // The reminder inbox memoises this state; without dropping it the checklist
  // would go on saying "submit the template" for up to five minutes after it
  // had been submitted.
  await forgetTemplateState()
  revalidatePath("/settings")
  revalidatePath("/reminders")
  return { ok: true, data: result.id ?? "submitted" }
}

/**
 * Re-ask Meta where the review has got to.
 *
 * Return type is spelled out rather than using ActionResult<TemplateStatus>:
 * ActionResult is a conditional type, so it distributes over TemplateStatus's
 * own ok/error union and produces a shape nothing can satisfy.
 */
export async function refreshTemplateStatus(): Promise<
  { ok: true; data: TemplateStatus } | { ok: false; error: string }
> {
  await requireTenant()
  const creds = readWhatsappCredentials()
  if (!creds) return { ok: false, error: "WhatsApp credentials are not configured." }

  // The in-memory memo the reminder inbox reads is dropped, so its checklist
  // picks the new state up on its next render.
  await forgetTemplateState()

  /**
   * NO revalidatePath, and the caller does NO router.refresh().
   *
   * Measured: this button used to cost THREE Graph round trips for one click —
   * this fetch, the re-render that revalidatePath("/settings") forces, and the
   * router.refresh() on top of it — with the operator waiting behind all three
   * while the button said "Checking…". Both routes are `force-dynamic`, so the
   * revalidation was buying nothing: they are rendered per request anyway.
   *
   * The answer is returned instead, and the caller renders it directly. One
   * click, one round trip.
   */
  return { ok: true, data: await fetchTemplateStatus(creds) }
}

export type WebhookDiagnosis = {
  /** Echoed back so the operator can compare it to Meta's dashboard by eye. */
  callbackUrl: string
  probes: Probe[]
}

/**
 * Read-only: what is actually true about the webhook right now.
 *
 * Runs from the deployment, which is the only place that can reach both the
 * public callback URL and graph.facebook.com. Changes nothing, so it is safe to
 * press repeatedly while chasing a fault.
 */
export async function diagnoseWebhook(): Promise<WebhookDiagnosis> {
  await requireTenant()
  const callbackUrl = callbackUrlFor(appPublicUrl())

  const probes: Probe[] = [
    // Config before behaviour. "Which token does this deployment even hold?"
    // has to be answerable before "why was it refused?" means anything.
    fingerprintVerifyToken(process.env.GOMA_NOTIFY_VERIFY_TOKEN),
    await probeCallbackUrl(callbackUrl, process.env.GOMA_NOTIFY_VERIFY_TOKEN),
  ]

  const creds = readMetaAppCredentials()
  probes.push(
    creds
      ? await probeStoredSubscription(creds, callbackUrl)
      : {
          label: "The callback URL Meta has on file",
          tone: "waiting" as const,
          status: null,
          detail:
            "Set GOMA_NOTIFY_APP_ID and GOMA_NOTIFY_APP_SECRET to ask Meta what it has " +
            "registered, and to run the verification from here instead of the dashboard.",
        },
  )

  return { callbackUrl, probes }
}

/**
 * The write: ask Meta to call the URL and register the subscription.
 *
 * This is the dashboard's "Verify and save" button, except Graph answers with a
 * numbered error and a sentence rather than the single unhelpful string the
 * dashboard shows for every possible cause.
 *
 * `ok: false` means we could not even ask. A refusal BY Meta comes back as
 * `ok: true` carrying a failed probe — the call succeeded, the answer was no,
 * and the reason is the whole point of pressing the button.
 */
export async function registerWebhookWithMeta(): Promise<
  { ok: true; data: Probe } | { ok: false; error: string }
> {
  await requireTenant()

  const creds = readMetaAppCredentials()
  if (!creds) {
    return {
      ok: false,
      error:
        "GOMA_NOTIFY_APP_ID and GOMA_NOTIFY_APP_SECRET must both be set before this deployment " +
        "can ask Meta to verify. Both are on App Settings → Basic in the Meta dashboard.",
    }
  }

  const token = process.env.GOMA_NOTIFY_VERIFY_TOKEN?.trim()
  if (!token) {
    return { ok: false, error: "GOMA_NOTIFY_VERIFY_TOKEN is not set, so there is no token to register." }
  }

  const result = await registerSubscription(creds, callbackUrlFor(appPublicUrl()), token)
  revalidatePath("/settings")
  return { ok: true, data: result }
}

/**
 * What Meta currently thinks of the sending number — its name and its
 * registration, reported separately because they fail separately.
 */
export type NumberDiagnosis =
  | {
      ok: true
      /** So the operator can confirm WHICH number this deployment talks about. */
      displayPhoneNumber: string | null
      verifiedName: string | null
      /** Raw Meta values, shown alongside the prose so they can be searched for. */
      nameStatus: string | null
      newNameStatus: string | null
      status: string | null
      platformType: string | null
      name: NameVerdict
      registration: NameVerdict
      /** Meta's own composite: usable for Cloud API sends right now. */
      readyToSend: boolean
    }
  | { ok: false; error: string }

/**
 * Read-only: ask Meta about the number. Safe to press repeatedly.
 *
 * Runs from the deployment because that is the only place that can reach
 * graph.facebook.com — a laptop behind a corporate proxy, or an agent sandbox
 * on an egress allowlist, cannot tell "the number is broken" apart from "I am
 * not allowed to look".
 */
export async function checkNumberStatus(): Promise<NumberDiagnosis> {
  await requireTenant()

  const accessToken = process.env.GOMA_NOTIFY_ACCESS_TOKEN?.trim()
  const phoneNumberId = process.env.GOMA_NOTIFY_PHONE_NUMBER_ID?.trim()
  if (!accessToken || !phoneNumberId) {
    return {
      ok: false,
      error:
        "GOMA_NOTIFY_ACCESS_TOKEN and GOMA_NOTIFY_PHONE_NUMBER_ID must both be set before this " +
        "deployment can ask Meta about the number.",
    }
  }

  const status = await fetchPhoneNumberStatus(accessToken, phoneNumberId)
  if (!status.ok) return { ok: false, error: status.error }

  return {
    ok: true,
    displayPhoneNumber: status.displayPhoneNumber,
    verifiedName: status.verifiedName,
    nameStatus: status.nameStatus,
    newNameStatus: status.newNameStatus,
    status: status.status,
    platformType: status.platformType,
    name: describeNumberName(status),
    registration: describeRegistration(status),
    readyToSend: status.registered,
  }
}

/**
 * Re-register the sending number for the Cloud API.
 *
 * Clears "#133010 Account not registered". It does NOT touch the display name
 * — name review is a separate queue at Meta, and a number can register
 * perfectly while its name stays declined. The caller is told so rather than
 * left to infer it from a green tick that means something narrower than it
 * looks.
 *
 * The PIN is the number's six-digit two-step verification PIN. It is read from
 * the argument and passed straight to Graph: never logged, never revalidated
 * into a URL, never returned. Meta rate-limits wrong attempts and will lock
 * registration for a period, so this is not something to guess at.
 */
export async function registerNumberWithMeta(
  pin: string,
): Promise<{ ok: true; data: NumberDiagnosis } | { ok: false; error: string }> {
  await requireTenant()

  const accessToken = process.env.GOMA_NOTIFY_ACCESS_TOKEN?.trim()
  const phoneNumberId = process.env.GOMA_NOTIFY_PHONE_NUMBER_ID?.trim()
  if (!accessToken || !phoneNumberId) {
    return {
      ok: false,
      error: "GOMA_NOTIFY_ACCESS_TOKEN and GOMA_NOTIFY_PHONE_NUMBER_ID must both be set.",
    }
  }

  // Checked here as well as in the input's own attributes: a six-digit rule
  // enforced only by the browser is not enforced at all, and a malformed PIN
  // spends one of Meta's rate-limited attempts to be told so.
  if (!/^\d{6}$/.test(pin)) {
    return { ok: false, error: "The PIN must be exactly six digits." }
  }

  const result = await registerPhoneNumber(accessToken, phoneNumberId, pin)
  if (!result.ok) {
    // Meta's message verbatim: a wrong PIN, a locked-out number and an expired
    // token all fail here and say so differently, and paraphrasing loses the
    // one detail that tells them apart.
    return { ok: false, error: `Meta refused the registration: ${result.error}` }
  }

  revalidatePath("/settings")

  // Asked again rather than assumed. A 200 from /register means the request was
  // accepted, not that the number has finished becoming CONNECTED — and it says
  // nothing at all about the display name.
  return { ok: true, data: await checkNumberStatus() }
}
