"use server"

import { revalidatePath } from "next/cache"
import { requireTenant } from "@/lib/tenant"
import { isDryRun } from "@/lib/env"
import {
  readWhatsappCredentials,
  fetchTemplateStatus,
  submitTemplate,
  type TemplateStatus,
} from "@/lib/notify/template-admin"
import { CLIENT_EVENT_REMINDER_TEMPLATE } from "@/lib/notify/client-event-reminder"
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
