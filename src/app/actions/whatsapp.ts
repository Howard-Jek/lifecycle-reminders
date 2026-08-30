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
