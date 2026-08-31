/**
 * The reminder cycle: materialise → claim → deliver.
 *
 * Two jobs in one tick because they share the tenant fetch:
 *
 *   1. Materialise — expand (events × rules × recipients) into `reminders`
 *      rows inside a rolling horizon. Idempotent: the unique key
 *      (event, rule, occurrence, member) plus ON CONFLICT DO NOTHING means
 *      re-running is always safe.
 *   2. Deliver — claim each due row atomically, draft a suggestion, WhatsApp
 *      the agent, record the outcome.
 *
 * The claim is the at-most-once discipline: a conditional UPDATE wins the row
 * before any send happens, so two overlapping ticks can never double-message
 * an agent.
 *
 * Every send targets an AGENT's number. Nothing here messages a client — a
 * human always stands between the suggestion and the lead.
 *
 * Deliberately a plain async function with no scheduler import. The standalone
 * drives it from an authenticated route on a Vercel cron; the host drives it
 * from a Trigger.dev `schedules.task`. Neither transport is allowed to leak
 * into the logic, which is also what makes the cycle testable and runnable
 * from the CLI.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { planReminders } from "./plan-reminders"
import {
  claimReminder,
  releaseReminder,
  markReminderSent,
  requeueStuckClaims,
  stampDelivered,
} from "./claim-reminder"
import { todayInTimezone, daysBetween } from "./occurrence"
import { humaniseEventType } from "./labels"
import { draftSuggestion, fallbackSuggestion } from "./suggest-message"
import {
  sendClientEventReminder,
  reminderDeepLink,
  describeLeadTime,
  buildReminderComponents,
} from "@/lib/notify/client-event-reminder"
import { recordSandboxMessage, renderReminderBody } from "@/lib/sandbox/record"
import { NO_GUARDRAILS } from "@/lib/guardrails"
import { appPublicUrl } from "@/lib/env"
import { getGomaSender } from "@/lib/notify/goma-sender"
import type { ContactEvent, ReminderRule, TeamMember, PlannedReminder } from "./types"

/**
 * How far ahead to materialise.
 *
 * MUST exceed the schema's `offset_days` cap of 365. An occurrence is only
 * enumerated when it falls inside the horizon, and the reminder fires
 * `offset_days` BEFORE it — so with a 90-day horizon any rule with
 * offset_days >= 92 could never fire at all: no error, no log, just silence.
 */
const HORIZON_DAYS = 400

/**
 * Per-tick delivery cap.
 *
 * A GLOBAL cap ordered by due_at, so it bounds total work and model spend per
 * tick — it does NOT stop one busy tenant's backlog dominating a tick.
 * Round-robin per tenant is a later refinement, called out rather than hidden.
 */
const MAX_DELIVERIES_PER_RUN = 40

/**
 * Wall-clock budget for the delivery loop.
 *
 * Delivery is sequential and each row costs a model call plus a Graph POST
 * plus a few round-trips — call it ~3s. Sized to sit well inside the route's
 * `maxDuration = 300`: without it the run is killed mid-loop, stranding the
 * in-flight row as `claimed` (recovered 30 minutes later, one attempt burnt
 * for nothing).
 */
const DELIVERY_BUDGET_MS = 4 * 60 * 1000

/** Give up after this many attempts, so a permanently bad number does not
 * retry forever. */
const MAX_ATTEMPTS = 3

const DEFAULT_TIMEZONE = "Asia/Singapore"

export type CycleResult = {
  requeued: number
  planned: number
  inserted: number
  sent: number
  failed: number
  skipped: number
}

export type CycleOptions = {
  /**
   * Exercise the whole delivery path but never reach WhatsApp.
   *
   * Exists because the Sandbox's "Run a tick now" button calls this same
   * function — deliberately, so that a working button proves a working cron —
   * and that button sat on a page promising the two handsets were "stand-ins
   * for messages that would otherwise leave the building". That promise held
   * only while REMINDER_DRY_RUN was set. With credentials configured and dry
   * run off, one click put 21 real template messages on real handsets and
   * billed for every one.
   *
   * A demonstration must not be able to send. This makes that structural
   * rather than a property of whichever env var happens to be set.
   */
  simulateDelivery?: boolean
  /**
   * Stop after this many deliveries.
   *
   * The full run has a four-minute budget, which is correct for a cron and
   * wrong for a button: a server action holding the page for minutes reads as
   * a hung deployment, which is exactly how it was reported.
   */
  maxDeliveries?: number
  /**
   * Deliver exactly these reminders, and ignore the auto-send flag.
   *
   * THE MANUAL PATH. `auto_send_enabled` gates the machine, not the person: an
   * operator who has deliberately switched the scheduler off must still be able
   * to send one reminder, or a tab's worth, by hand. That is the whole point of
   * the buttons on the inbox — automatic sending being off is a policy about
   * unattended sending, not a lock on the account.
   *
   * Also skips the `due_at <= now` filter. These rows were chosen by a human
   * looking at them, which is a better authority on whether they should go out
   * than a timestamp.
   */
  reminderIds?: string[]
}

/** Why a reminder was passed over without being touched. */
export type DeliverySkip = { reminderId: string; reason: "agent_inactive" }

export async function runReminderCycle(
  admin: SupabaseClient,
  /** Which driver invoked this: cron, github, or a local tick. */
  source = "cron",
  options: CycleOptions = {},
): Promise<CycleResult> {
  // Reclaim rows a dead worker left 'claimed' — otherwise they are invisible
  // forever, because the delivery query only looks at 'queued'.
  const requeued = await requeueStuckClaims(admin, 30, MAX_ATTEMPTS)
  if (requeued > 0) console.warn(`[lifecycle] requeued ${requeued} stuck reminder claims`)

  const materialised = await materialiseAll(admin)
  const delivered = await deliverDue(admin, options)

  const result = { requeued, ...materialised, ...delivered }
  console.log("[lifecycle] cycle done", result)

  /**
   * Leave evidence that the cycle ran.
   *
   * The inbox cannot otherwise tell a quiet queue from a stopped engine — both
   * render as reminders sitting at "Due" with nothing happening. Written after
   * the work, so a row means the cycle actually completed rather than merely
   * started.
   *
   * Best-effort: a failed heartbeat must never fail a cycle that has already
   * delivered messages.
   */
  try {
    const { error } = await admin.from("scheduler_runs").insert({
      materialised: result.inserted,
      sent: result.sent ?? 0,
      failed: result.failed ?? 0,
      skipped: result.skipped ?? 0,
      source,
    })
    if (error) console.warn(`[lifecycle] could not record scheduler run: ${error.message}`)
  } catch (err) {
    console.warn(`[lifecycle] could not record scheduler run: ${String(err)}`)
  }

  return result
}

// ── 1. Materialise ──────────────────────────────────────────────────────────

async function materialiseAll(admin: SupabaseClient) {
  // Only businesses with at least one active rule can produce reminders.
  //
  // Paginated because this is a CROSS-TENANT fetch, so it hits PostgREST's
  // silent 1000-row cap. Past that, whichever tenants sort late simply stop
  // having reminders materialised — with no error, forever.
  const rules: ReminderRule[] = []
  {
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from("reminder_rules")
        .select("*")
        .eq("active", true)
        .order("id")
        .range(from, from + PAGE - 1)
      if (error) {
        console.error(`[lifecycle] reminder_rules fetch failed: ${error.message}`)
        return { planned: 0, inserted: 0 }
      }
      const page = (data ?? []) as ReminderRule[]
      rules.push(...page)
      if (page.length < PAGE) break
    }
  }
  if (rules.length === 0) return { planned: 0, inserted: 0 }

  const byTenant = new Map<string, ReminderRule[]>()
  for (const r of rules) {
    const list = byTenant.get(r.business_id)
    if (list) list.push(r)
    else byTenant.set(r.business_id, [r])
  }

  let planned = 0
  let inserted = 0

  for (const [businessId, tenantRules] of byTenant) {
    const timezone = await loadTimezone(admin, businessId)
    const today = todayInTimezone(new Date(), timezone)

    const eventTypes = Array.from(new Set(tenantRules.map((r) => r.event_type)))

    const [events, { data: memberRows }] = await Promise.all([
      fetchAllEvents(admin, businessId, eventTypes),
      admin.from("team_members").select("*").eq("business_id", businessId).eq("active", true),
    ])

    if (events.length === 0) continue
    const members = (memberRows ?? []) as TeamMember[]

    // lead_id → assigned member, for only the leads these events belong to.
    const leadIds = Array.from(new Set(events.map((e) => e.lead_id)))
    const assignmentByLead = await loadAssignments(admin, businessId, leadIds)

    const rows = planReminders({
      events,
      rules: tenantRules,
      members,
      assignmentByLead,
      timezone,
      today,
      horizonDays: HORIZON_DAYS,
      now: new Date(),
    })
    planned += rows.length
    inserted += await insertPlanned(admin, rows)
  }

  return { planned, inserted }
}

/**
 * All of a tenant's events of the given types, paginated.
 *
 * PostgREST caps a response at 1000 rows, silently. A 500-client operator with
 * three date columns each has 1500 events, so an unpaginated fetch would drop
 * a third of them — with no error, forever.
 */
async function fetchAllEvents(
  admin: SupabaseClient,
  businessId: string,
  eventTypes: string[],
): Promise<ContactEvent[]> {
  const PAGE = 1000
  const out: ContactEvent[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("contact_events")
      .select("*")
      .eq("business_id", businessId)
      .in("event_type", eventTypes)
      .order("id")
      .range(from, from + PAGE - 1)
    if (error) {
      console.error(`[lifecycle] contact_events fetch failed for ${businessId}: ${error.message}`)
      break
    }
    const page = (data ?? []) as ContactEvent[]
    out.push(...page)
    if (page.length < PAGE) break
  }
  return out
}

/**
 * The business's timezone.
 *
 * Never throws and never returns empty: `Intl` handed an empty zone throws a
 * RangeError, which would take down the whole tick over one missing column.
 */
async function loadTimezone(admin: SupabaseClient, businessId: string): Promise<string> {
  const { data, error } = await admin
    .from("businesses")
    .select("timezone")
    .eq("id", businessId)
    .maybeSingle<{ timezone: string | null }>()
  if (error) {
    console.error(`[lifecycle] timezone lookup failed for ${businessId}: ${error.message}`)
    return DEFAULT_TIMEZONE
  }
  return data?.timezone || DEFAULT_TIMEZONE
}

async function loadAssignments(
  admin: SupabaseClient,
  businessId: string,
  leadIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  // Chunked: `in` with thousands of ids blows past PostgREST's URL length.
  const CHUNK = 500
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const { data } = await admin
      .from("leads")
      .select("id, assigned_member_id")
      .eq("business_id", businessId)
      .in("id", leadIds.slice(i, i + CHUNK))
    for (const row of data ?? []) {
      out.set(row.id as string, (row.assigned_member_id as string | null) ?? null)
    }
  }
  return out
}

/** Insert planned rows, ignoring ones that already exist. */
async function insertPlanned(admin: SupabaseClient, rows: PlannedReminder[]): Promise<number> {
  if (rows.length === 0) return 0
  let inserted = 0
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK)
    // ignoreDuplicates → ON CONFLICT DO NOTHING against the unique key, which
    // is what makes re-running the cycle free of side effects.
    const { data, error } = await admin
      .from("reminders")
      .upsert(batch, {
        onConflict: "event_id,rule_id,occurrence_date,member_id",
        ignoreDuplicates: true,
      })
      .select("id")
    if (error) {
      console.error(`[lifecycle] reminder insert failed (${batch.length} rows): ${error.message}`)
      continue
    }
    inserted += data?.length ?? 0
  }
  return inserted
}

// ── 2. Deliver ──────────────────────────────────────────────────────────────

type DueRow = {
  id: string
  business_id: string
  event_id: string
  rule_id: string
  occurrence_date: string
  member_id: string | null
  attempts: number
}

async function deliverDue(admin: SupabaseClient, options: CycleOptions = {}) {
  // Nothing can be delivered without a sender, so do not TOUCH the queue.
  //
  // The old behaviour resolved each due reminder to a terminal `skipped` on the
  // reasoning that "not configured" is permanent for this deployment. That is
  // true of a single run and false of the thing that actually happens: the
  // credentials are missing because nobody has set them YET — it is step 4 of
  // the setup checklist — and marking the queue terminal destroys real work to
  // record a fact the deployment already knows about itself.
  //
  // It got worse the moment the cycle ran more often than daily. At one run a
  // day this cost one day's reminders; at four runs an hour it burns the entire
  // backlog in an afternoon and leaves nothing to deliver once the credentials
  // finally arrive.
  //
  // Leaving them queued means the backlog simply flows when the sender appears.
  // Dry run is deliberately NOT excluded here: getGomaSender() stands in for
  // the credentials, so a dry run still exercises the whole delivery path.
  if (!getGomaSender()) {
    console.warn(
      "[lifecycle] no WhatsApp sender configured — leaving the queue untouched. " +
        "Set GOMA_NOTIFY_PHONE_NUMBER_ID and GOMA_NOTIFY_ACCESS_TOKEN, or REMINDER_DRY_RUN outside production.",
    )
    return { sent: 0, failed: 0, skipped: 0, senderUnconfigured: true }
  }

  const manual = options.reminderIds !== undefined
  const nowIso = new Date().toISOString()

  let query = admin
    .from("reminders")
    .select("id, business_id, event_id, rule_id, occurrence_date, member_id, attempts")
    .eq("status", "queued")
    .lt("attempts", MAX_ATTEMPTS)
    .order("due_at", { ascending: true })
    .limit(Math.min(options.maxDeliveries ?? MAX_DELIVERIES_PER_RUN, MAX_DELIVERIES_PER_RUN))

  if (manual) {
    // A person picked these. No due_at filter and no auto-send gate — see
    // CycleOptions.reminderIds.
    const ids = options.reminderIds ?? []
    if (ids.length === 0) return { sent: 0, failed: 0, skipped: 0 }
    query = query.in("id", ids)
  } else {
    /**
     * THE GATE. Businesses that have not switched automatic sending on are not
     * queried at all.
     *
     * Checked here rather than in the route so that every driver — Vercel Cron,
     * the GitHub workflow, scripts/tick.ts — is gated by the same line. The
     * previous arrangement put the switch in deployment config, where turning
     * off ONE of two schedulers looked like turning sending off and was not.
     *
     * An off tick costs exactly this query and returns. Nothing is claimed,
     * nothing is drafted, nothing is billed.
     */
    const { data: enabled, error: gateError } = await admin
      .from("businesses")
      .select("id")
      .eq("auto_send_enabled", true)

    if (gateError) {
      // Fail CLOSED. Not knowing whether sending is permitted must never
      // resolve to sending.
      console.error(`[lifecycle] auto-send gate unreadable, sending nothing: ${gateError.message}`)
      return { sent: 0, failed: 0, skipped: 0 }
    }

    const ids = (enabled ?? []).map((b) => b.id as string)
    if (ids.length === 0) {
      console.log("[lifecycle] automatic sending is off everywhere — nothing to deliver")
      return { sent: 0, failed: 0, skipped: 0 }
    }
    query = query.in("business_id", ids).lte("due_at", nowIso)
  }

  const { data, error } = await query

  if (error) {
    console.error(`[lifecycle] due reminders fetch failed: ${error.message}`)
    return { sent: 0, failed: 0, skipped: 0 }
  }

  const candidates = (data ?? []) as DueRow[]
  if (candidates.length === 0) return { sent: 0, failed: 0, skipped: 0 }

  /**
   * Drop reminders addressed to a DEACTIVATED agent, before claiming them.
   *
   * A deactivated member reaches nobody by definition, so sending is a
   * guaranteed waste of a billed message — and on this deployment that was not
   * hypothetical: every one of the 69 rows sitting in "Needs attention" was
   * addressed to one of three deactivated demo members.
   *
   * Filtered BEFORE the claim and left `queued`, deliberately. Marking them
   * terminal would destroy real work over a reversible condition: reactivate
   * the agent and their reminders simply flow again.
   */
  const contexts = new Map<string, Awaited<ReturnType<typeof loadDeliveryContext>>>()
  for (const businessId of new Set(candidates.map((r) => r.business_id))) {
    contexts.set(businessId, await loadDeliveryContext(admin, businessId))
  }

  const due: DueRow[] = []
  let inactiveSkips = 0
  for (const row of candidates) {
    const member = row.member_id ? contexts.get(row.business_id)?.members.get(row.member_id) : null
    if (member && !member.active) {
      inactiveSkips++
      continue
    }
    due.push(row)
  }
  if (inactiveSkips > 0) {
    console.log(`[lifecycle] ${inactiveSkips} reminders held: their agent is deactivated`)
  }

  if (due.length === 0) return { sent: 0, failed: 0, skipped: inactiveSkips }

  // Contexts were loaded above to resolve each row's member; reused here rather
  // than fetched a second time.
  const tenantCache = contexts

  let sent = 0
  let failed = 0
  let skipped = inactiveSkips
  const startedAt = Date.now()

  for (const row of due) {
    if (Date.now() - startedAt > DELIVERY_BUDGET_MS) {
      console.warn(
        `[lifecycle] delivery budget reached — ${
          due.length - (sent + failed + skipped)
        } reminders roll to the next tick`,
      )
      break
    }

    // Claim BEFORE any work: this wins the row atomically, so an overlapping
    // tick skips it instead of sending a second copy.
    if (!(await claimReminder(admin, row.id, row.attempts))) {
      skipped++
      continue
    }

    try {
      let ctx = tenantCache.get(row.business_id)
      if (!ctx) {
        ctx = await loadDeliveryContext(admin, row.business_id)
        tenantCache.set(row.business_id, ctx)
      }

      const outcome = await deliverOne(admin, row, ctx, options)
      if (outcome === "sent") sent++
      else if (outcome === "skipped") skipped++
      else failed++
    } catch (err) {
      // Release so the next tick retries rather than stranding the row
      // claimed — but respect the attempts cap here too. Without that, a
      // repeatedly THROWING row (Graph fetch rejection, draft failure, DB
      // blip) returns to 'queued' at attempts = MAX, where the delivery filter
      // excludes it forever: the same zombie the terminal 'failed' state was
      // added to prevent, reached by a different path.
      await releaseReminder(
        admin,
        row.id,
        err instanceof Error ? err.message : String(err),
        row.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "queued",
      )
      failed++
    }
  }

  return { sent, failed, skipped }
}

async function loadDeliveryContext(admin: SupabaseClient, businessId: string) {
  const [timezone, { data: memberRows }, { data: ruleRows }] = await Promise.all([
    loadTimezone(admin, businessId),
    admin.from("team_members").select("*").eq("business_id", businessId),
    admin.from("reminder_rules").select("*").eq("business_id", businessId),
  ])

  const allMembers = (memberRows ?? []) as TeamMember[]
  const members = new Map<string, TeamMember>()
  for (const m of allMembers) members.set(m.id, m)

  const rules = new Map<string, ReminderRule>()
  for (const r of (ruleRows ?? []) as ReminderRule[]) rules.set(r.id, r)

  // The fallback recipient for an unassigned client.
  //
  // PR #16 read operator_profile.notify_whatsapp_number, which on the current
  // schema lives in business_settings — a secret table whose other columns are
  // guardrails and PII. The owner's own roster row carries the same number and
  // is already loaded here, so the add-on depends on one table fewer.
  const ownerNumber =
    allMembers.find((m) => m.role === "owner" && m.active)?.whatsapp_number?.trim() || null

  return { timezone, members, rules, ownerNumber, guardrails: NO_GUARDRAILS }
}

async function deliverOne(
  admin: SupabaseClient,
  row: DueRow,
  ctx: Awaited<ReturnType<typeof loadDeliveryContext>>,
  options: CycleOptions = {},
): Promise<"sent" | "failed" | "skipped"> {
  const { data: event } = await admin
    .from("contact_events")
    .select("id, event_type, label, payload, lead_id")
    .eq("id", row.event_id)
    .maybeSingle<Pick<ContactEvent, "id" | "event_type" | "label" | "payload" | "lead_id">>()

  if (!event) {
    await releaseReminder(admin, row.id, "contact event no longer exists", "skipped")
    return "skipped"
  }

  const { data: lead } = await admin
    .from("leads")
    .select("id, name, context")
    .eq("id", event.lead_id)
    .maybeSingle<{ id: string; name: string; context: Record<string, unknown> | null }>()

  if (!lead) {
    await releaseReminder(admin, row.id, "contact no longer exists", "skipped")
    return "skipped"
  }

  // Recipient: the assigned member, else the owner's number. An unassigned
  // client's policy expiry is exactly the one nobody is watching, so it must
  // still reach someone.
  const member = row.member_id ? ctx.members.get(row.member_id) : undefined
  const to = member?.whatsapp_number?.trim() || ctx.ownerNumber
  if (!to) {
    await releaseReminder(admin, row.id, "no recipient number configured", "skipped")
    return "skipped"
  }

  // The full name goes to the model, which decides how to address them. Taking
  // the first whitespace token as a "first name" is wrong for most Chinese,
  // Korean and Vietnamese names, where the family name comes first — it
  // produced "Hi Goh" for Goh Jia Hui.
  const clientName = (lead.name ?? "").trim()
  const daysUntil = daysBetween(todayInTimezone(new Date(), ctx.timezone), row.occurrence_date)
  const whenText = describeLeadTime(daysUntil)

  // Honour the rule's suggest_message flag — an operator who turned drafting
  // off should not still be billed for the model call.
  const wantsDraft = ctx.rules.get(row.rule_id)?.suggest_message ?? true

  // Drafting is best-effort by design: the reminder is the valuable part, so a
  // model failure downgrades to a safe generic line rather than blocking it.
  const drafted = wantsDraft
    ? await draftSuggestion({
        clientName,
        eventType: event.event_type,
        eventLabel: event.label,
        whenText,
        eventPayload: (event.payload ?? {}) as Record<string, unknown>,
        leadContext: (lead.context ?? {}) as Record<string, unknown>,
        agentName: member?.display_name ?? null,
        guardrails: ctx.guardrails,
      })
    : null

  // When drafting is off, do NOT substitute the canned line: an operator who
  // disabled suggestions (often for compliance) should not still receive
  // scripted text. Meta requires all five body params, so send an explicit
  // marker rather than a message.
  const suggestion = wantsDraft
    ? drafted ?? fallbackSuggestion(event.event_type)
    : "(suggestions are turned off for this reminder)"

  // Built once and shared with the transcript below, so the sandbox can never
  // show something different from what was actually sent.
  const alertParams = {
    clientLabel: clientName || "your client",
    eventLabel: event.label || humaniseEventType(event.event_type),
    whenText,
    suggestion,
    deepLink: reminderDeepLink(appPublicUrl(), lead.id),
  }

  /**
   * The one place a simulated run stops.
   *
   * Placed HERE, at the Graph call, rather than earlier: everything above —
   * materialising, claiming, resolving the member, drafting the opener,
   * clamping the five template params — still runs exactly as production does,
   * which is the entire value of a sandbox that shares the real code path. The
   * only thing withheld is the network call that costs money and reaches a
   * handset.
   *
   * The synthetic id is prefixed so it can never be mistaken for a Meta wamid
   * by the webhook, the stuck-claim sweep, or anyone reading the table.
   */
  const res = options.simulateDelivery
    ? ({ ok: true, whatsappMessageId: `sandbox:${crypto.randomUUID()}` } as const)
    : await sendClientEventReminder(to, alertParams)

  if (!res.ok) {
    // "Not configured" is permanent for this deployment — do not burn retries
    // on it. Otherwise: `attempts` was already incremented by the claim, so
    // once it reaches the cap this row would never be selected again and would
    // sit at 'queued' forever — invisible, un-retried, and counted as pending.
    // Give it a terminal 'failed' state instead, so it surfaces in the UI.
    const terminal = res.reason === "not_configured"
    const exhausted = row.attempts + 1 >= MAX_ATTEMPTS
    await releaseReminder(
      admin,
      row.id,
      res.error ?? res.reason,
      terminal ? "skipped" : exhausted ? "failed" : "queued",
      suggestion,
    )
    return terminal ? "skipped" : "failed"
  }

  // Stamp the wamid FIRST, in its own write. The stuck-claim sweep's "already
  // delivered" guard keys off this column, so it has to be set before the
  // bookkeeping write that might fail — otherwise the guard never matches the
  // one case it exists for, and the sweep re-delivers.
  await stampDelivered(admin, row.id, res.whatsappMessageId)

  const recorded = await markReminderSent(admin, row.id, res.whatsappMessageId, suggestion)
  if (recorded === "error") {
    console.error(
      `[lifecycle] reminder ${row.id} delivered (${res.whatsappMessageId}) but could not be recorded`,
    )
  } else if (recorded === "superseded") {
    // A delivery receipt resolved this row while the send was still in flight
    // — Meta answered faster than our own bookkeeping. Its verdict and its
    // reason are already on the row and must stay there, so this is a note,
    // not an error. Reporting it as "could not be recorded" would send someone
    // hunting a bug in the write path that is not there.
    console.warn(
      `[lifecycle] reminder ${row.id} (${res.whatsappMessageId}) was resolved by a delivery ` +
        `receipt mid-send — keeping that verdict`,
    )
  }

  // The sandbox transcript. Reads the params back out of the components that
  // were actually sent, so it shows the CLAMPED, whitespace-collapsed values
  // Meta received — not the originals. Best-effort; see src/lib/sandbox.
  const params = (
    (buildReminderComponents(alertParams)[0]?.parameters ?? []) as Array<{ text: string }>
  ).map((p) => p.text)
  await recordSandboxMessage(admin, {
    businessId: row.business_id,
    fromRole: "system",
    toRole: "agent",
    toNumber: to,
    body: renderReminderBody(params),
    templateName: "client_event_reminder",
    templateParams: params,
    reminderId: row.id,
    leadId: lead.id,
  })

  return "sent"
}
