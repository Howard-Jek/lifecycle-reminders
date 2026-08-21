"use server"

import { revalidatePath } from "next/cache"
import { requireTenant } from "@/lib/tenant"
import { isDryRun, appPublicUrl } from "@/lib/env"
import {
  readWhatsappCredentials,
  fetchTemplateStatus,
  submitTemplate,
  type TemplateStatus,
} from "@/lib/notify/template-admin"
import { CLIENT_EVENT_REMINDER_TEMPLATE } from "@/lib/notify/client-event-reminder"
import {
  callbackUrlFor,
  probeCallbackUrl,
  probeStoredSubscription,
  registerSubscription,
  readMetaAppCredentials,
  type Probe,
} from "@/lib/notify/webhook-diagnostics"
import { forgetTemplateState } from "./onboarding"
import type { ActionResult } from "./team-members"

export type WhatsappSetup = {
  /** Which of the three GOMA_NOTIFY_* variables are present. */
  phoneNumberId: boolean
  wabaId: boolean
  accessToken: boolean
  dryRun: boolean
  templateName: string
  /** Null when credentials are missing — there is nobody to ask. */
  template: TemplateStatus | null
  /**
   * The webhook Meta calls back on. Booleans, never values: this object is
   * serialised into the page, and a verify token in the HTML source would be a
   * secret published to every browser that loads Settings.
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

/**
 * The state of the one WhatsApp identity this deployment sends from.
 *
 * Reads env rather than the database on purpose: this add-on has a single
 * platform number, not a number per business, because every message it sends
 * goes to your own staff.
 */
export async function getWhatsappSetup(): Promise<WhatsappSetup> {
  await requireTenant()
  const creds = readWhatsappCredentials()

  return {
    phoneNumberId: Boolean(process.env.GOMA_NOTIFY_PHONE_NUMBER_ID?.trim()),
    wabaId: Boolean(process.env.GOMA_NOTIFY_WABA_ID?.trim()),
    accessToken: Boolean(process.env.GOMA_NOTIFY_ACCESS_TOKEN?.trim()),
    dryRun: isDryRun(),
    templateName: CLIENT_EVENT_REMINDER_TEMPLATE,
    template: creds ? await fetchTemplateStatus(creds) : null,
    webhook: {
      callbackUrl: callbackUrlFor(appPublicUrl()),
      verifyToken: Boolean(process.env.GOMA_NOTIFY_VERIFY_TOKEN?.trim()),
      appSecret: Boolean(process.env.GOMA_NOTIFY_APP_SECRET?.trim()),
      appId: Boolean(process.env.GOMA_NOTIFY_APP_ID?.trim()),
    },
  }
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

  const status = await fetchTemplateStatus(creds)
  await forgetTemplateState()
  revalidatePath("/settings")
  revalidatePath("/reminders")
  return { ok: true, data: status }
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
