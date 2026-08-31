import type { SupabaseClient } from "@supabase/supabase-js"
import { withApiToken, readLimit, readOffset } from "@/lib/api/handler"
import { ok, badRequest } from "@/lib/api/respond"
import { toPublicReminder, type PublicReminder } from "@/lib/api/serialize"
import { ATTENTION_FILTER } from "@/lib/lifecycle/reminder-filters"

/**
 * GET /api/v1/reminders — what the engine has decided is worth a conversation.
 *
 * This is the endpoint the whole integration exists for. Everything else in
 * this API manages inputs; this one reads the output.
 *
 * `view=due` is not a stored value — it is `queued AND due_at <= now AND
 * attempts = 0`, the same predicate the inbox uses. The attempts clause is what
 * keeps "due" meaning UNTRIED: a reminder that failed once returns to `queued`,
 * and without it the API would call that fresh work while the inbox called it a
 * retry. It is deliberately NOT the delivery loop's predicate, which also gates
 * on the attempts cap and the retry schedule — those decide what to send next,
 * not what a human still has to look at.
 *
 * Exposing both as named filters keeps the definitions in one place: a host app
 * that reimplemented `due` as "queued" would show reminders that are not due
 * yet, and one that guessed at the timezone would show them on the wrong day.
 */

export const dynamic = "force-dynamic"

const STATUSES = ["queued", "claimed", "sent", "failed", "skipped"] as const
/** Named windows over (status, due_at) rather than raw column filters. */
const VIEWS = ["due", "upcoming", "attention"] as const

export async function GET(request: Request) {
  return withApiToken(request, "reminders.list", async ({ admin, caller }) => {
    const url = new URL(request.url)
    const view = url.searchParams.get("view")
    const status = url.searchParams.get("status")
    const memberId = url.searchParams.get("member_id")
    const since = url.searchParams.get("occurring_since")
    const until = url.searchParams.get("occurring_until")
    const expand = (url.searchParams.get("expand") ?? "").split(",").map((s) => s.trim())
    const limit = readLimit(url)
    const offset = readOffset(url)

    if (view && !(VIEWS as readonly string[]).includes(view)) {
      return badRequest(`view must be one of: ${VIEWS.join(", ")}`)
    }
    if (status && !(STATUSES as readonly string[]).includes(status)) {
      return badRequest(`status must be one of: ${STATUSES.join(", ")}`)
    }

    const nowIso = new Date().toISOString()
    let query = admin
      .from("reminders")
      .select(
        "id, status, occurrence_date, due_at, sent_at, attempts, next_attempt_at, suggestion, error, member_id, event_id, rule_id",
        { count: "exact" },
      )
      .eq("business_id", caller.businessId)
      .range(offset, offset + limit - 1)

    if (view === "due") {
      query = query
        .eq("status", "queued")
        .lte("due_at", nowIso)
        // Untried work only, matching the inbox. A row that failed once is
        // queued too, and leaving it here told an integrator it was fresh work
        // while the UI was calling it a retry — the same row, two answers.
        .eq("attempts", 0)
        .order("due_at", { ascending: true })
    } else if (view === "upcoming") {
      query = query.eq("status", "queued").gt("due_at", nowIso).order("due_at", { ascending: true })
    } else if (view === "attention") {
      // Delivered nowhere, loudly or quietly, or waiting on a retry. `skipped`
      // is the quiet one and is the reason this view exists at all. Shared with
      // the inbox so the two cannot drift into disagreeing.
      query = query.or(ATTENTION_FILTER).order("due_at", { ascending: false })
    } else if (status) {
      query = query.eq("status", status).order("due_at", { ascending: false })
    } else {
      query = query.order("due_at", { ascending: false })
    }

    if (memberId) query = query.eq("member_id", memberId)
    if (since) query = query.gte("occurrence_date", since)
    if (until) query = query.lte("occurrence_date", until)

    const { data, count, error } = await query
    if (error) throw new Error(error.message)

    const rows = (data ?? []) as Record<string, unknown>[]
    const reminders: PublicReminder[] = rows.map(toPublicReminder)

    // Opt-in, because it costs two more round trips and a caller polling for
    // "is there anything due" does not need the client's name to decide.
    if (expand.includes("contact") && reminders.length > 0) {
      await attachContacts(admin, caller.businessId, reminders)
    }

    return ok({
      reminders,
      // The list is capped; the count is not. A caller that sees total > its
      // page knows to page rather than assuming it has everything.
      total: count ?? reminders.length,
      limit,
      offset,
    })
  })
}

/**
 * Fill in the client and event each reminder is about.
 *
 * Two queries for the whole page rather than two per row — the same shape the
 * inbox uses. The events query embeds the lead so the lead ids do not have to
 * come back before the names can be asked for.
 */
async function attachContacts(
  admin: SupabaseClient,
  businessId: string,
  reminders: PublicReminder[],
): Promise<void> {
  const eventIds = Array.from(new Set(reminders.map((r) => r.event_id)))
  if (eventIds.length === 0) return

  type Row = {
    id: string
    event_type: string
    label: string | null
    lead_id: string
    leads: { id: string; name: string | null } | { id: string; name: string | null }[] | null
  }

  const { data } = await admin
    .from("contact_events")
    .select("id, event_type, label, lead_id, leads(id, name)")
    .eq("business_id", businessId)
    .in("id", eventIds)
    .returns<Row[]>()

  const byEvent = new Map<string, Row>()
  for (const row of data ?? []) byEvent.set(row.id, row)

  for (const reminder of reminders) {
    const row = byEvent.get(reminder.event_id)
    if (!row) continue
    const lead = Array.isArray(row.leads) ? row.leads[0] : row.leads
    reminder.event = { event_type: row.event_type, label: row.label }
    reminder.contact = lead ? { id: lead.id, name: lead.name } : null
  }
}
