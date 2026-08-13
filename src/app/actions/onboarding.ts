"use server"

import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { isDryRun } from "@/lib/env"
import { readWhatsappCredentials, fetchTemplateStatus } from "@/lib/notify/template-admin"
import { buildSetupSteps, type SetupState, type SetupStep } from "@/lib/onboarding/steps"

/** How long the checklist will wait on Meta before giving up on the answer. */
const TEMPLATE_STATUS_TIMEOUT_MS = 3000

/**
 * How long a template state is reused before asking Meta again.
 *
 * A review takes hours; this page is opened every morning and then left. Even
 * on a warm answer the checklist is HIDDEN once setup is complete, so without
 * this the common case is a Graph round-trip on every load of the app's landing
 * page in order to render nothing.
 *
 * Deliberately in memory, not in the database: it is a cache, so losing it on
 * deploy or holding a separate copy per serverless instance costs nothing worse
 * than an extra fetch. Settings fetches fresh with no deadline, so the page an
 * operator opens to check the status is never the stale one.
 *
 * NOT keyed by business, which in a multi-tenant app deserves saying out loud.
 * This add-on sends every message from ONE platform WhatsApp identity held in
 * env — because it only ever messages your own staff, never a business's
 * customers — so there is exactly one template and its review state is the same
 * fact for every tenant. See the header of `lib/notify/template-admin.ts`. If
 * that ever becomes a number per business, this cache must be keyed or dropped.
 */
const TEMPLATE_STATUS_TTL_MS = 5 * 60_000

let templateStateCache: { at: number; state: string | null } | null = null

/**
 * Drop the cached state — called after submitting, so the checklist reflects
 * the submission immediately rather than up to five minutes later.
 *
 * Every export of a `"use server"` module is a public POST endpoint, so this
 * requires a session even though the worst an anonymous caller could achieve is
 * one extra Graph fetch.
 */
export async function forgetTemplateState(): Promise<void> {
  await requireTenant()
  templateStateCache = null
}

/**
 * What is left to set up.
 *
 * Every count is `head: true` — the checklist needs to know whether a table
 * has anything in it, never what is in it, and this page already loads the
 * reminder queue.
 */
export async function getSetupSteps(): Promise<SetupStep[]> {
  const tenant = await requireTenant()
  const admin = createAdminClient()
  const business = tenant.businessId

  const rowsIn = (table: string) =>
    admin.from(table).select("id", { count: "exact", head: true }).eq("business_id", business)

  const [members, owners, contacts, dates, rules, templateState] = await Promise.all([
    rowsIn("team_members").eq("active", true),
    rowsIn("team_members").eq("active", true).eq("role", "owner"),
    rowsIn("leads"),
    rowsIn("contact_events"),
    rowsIn("reminder_rules").eq("active", true),
    readTemplateState(),
  ])

  const state: SetupState = {
    // A null count means the query failed, not that the table is empty — the
    // same trap `scripts/preflight.ts` fell into. Treat it as "not yet done"
    // rather than silently ticking a step off on an error.
    activeMembers: members.count ?? 0,
    hasOwner: (owners.count ?? 0) > 0,
    contacts: contacts.count ?? 0,
    dates: dates.count ?? 0,
    activeRules: rules.count ?? 0,
    whatsapp: {
      configured: Boolean(
        process.env.GOMA_NOTIFY_PHONE_NUMBER_ID?.trim() &&
          process.env.GOMA_NOTIFY_WABA_ID?.trim() &&
          process.env.GOMA_NOTIFY_ACCESS_TOKEN?.trim(),
      ),
      templateState,
    },
    dryRun: isDryRun(),
  }

  return buildSetupSteps(state)
}

/**
 * Meta's review state, or null if we could not find out in time.
 *
 * Capped because this runs on the reminder inbox — the page an operator opens
 * every morning. Graph being slow must not make the queue slow, and "we do not
 * know yet" degrades to the same rendering as "not submitted", which is the
 * safe direction to be wrong in: it prompts a visit to Settings, where the
 * real status is fetched without a deadline.
 */
async function readTemplateState(): Promise<string | null> {
  const creds = readWhatsappCredentials()
  if (!creds) return null

  const now = Date.now()
  if (templateStateCache && now - templateStateCache.at < TEMPLATE_STATUS_TTL_MS) {
    return templateStateCache.state
  }

  // The signal is the point: racing a timer against the fetch stops us WAITING
  // after three seconds but leaves the request itself in flight, and the timer
  // running, for as long as Graph feels like taking. Aborting ends both.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEMPLATE_STATUS_TIMEOUT_MS)

  try {
    const status = await fetchTemplateStatus(creds, undefined, undefined, controller.signal)
    const state = status.ok ? status.state : null
    // A failed or aborted call is cached too, briefly. Otherwise an outage at
    // Meta's end turns into a three-second stall on every single page load.
    templateStateCache = { at: now, state }
    return state
  } finally {
    clearTimeout(timer)
  }
}
