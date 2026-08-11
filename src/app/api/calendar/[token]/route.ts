import { createHash } from "node:crypto"
import { createAdminClient } from "@/lib/supabase/admin"
import { buildIcsFeed, type IcsEvent } from "@/lib/lifecycle/ics"
import { todayInTimezone, addDays, nextOccurrence } from "@/lib/lifecycle/occurrence"
import { humaniseEventType } from "@/lib/lifecycle/labels"

/**
 * A member's client dates as a subscribable ICS feed.
 *
 * Read-only, and authenticated solely by the unguessable token in the path —
 * calendar clients cannot do OAuth and send no auth headers, so the URL is the
 * credential. That is why only its SHA-256 is stored, why revoking is a delete,
 * and why the response is `private, no-store`.
 *
 * A subscribed feed rather than a Google Calendar OAuth integration: Google,
 * Apple and Outlook all subscribe to ICS natively, it needs no token refresh,
 * and Postgres stays the single source of truth with the calendar as a pure
 * projection.
 */

export const dynamic = "force-dynamic"

const FEED_HORIZON_DAYS = 180

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  // Cheap shape check before touching the database, so a scan costs nothing.
  if (!token || !/^[0-9a-f]{64}$/.test(token)) {
    return notFound()
  }

  const admin = createAdminClient()
  const tokenHash = createHash("sha256").update(token).digest("hex")

  const { data: feed } = await admin
    .from("team_member_calendar_tokens")
    .select("member_id, business_id, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle<{ member_id: string; business_id: string; revoked_at: string | null }>()

  if (!feed || feed.revoked_at) return notFound()

  const { data: member } = await admin
    .from("team_members")
    .select("id, display_name, active")
    .eq("id", feed.member_id)
    .eq("business_id", feed.business_id)
    .maybeSingle<{ id: string; display_name: string; active: boolean }>()

  // 404 rather than 401 for unknown, revoked AND deactivated alike: a distinct
  // status would let someone probe which tokens exist.
  if (!member || !member.active) return notFound()

  const { data: business } = await admin
    .from("businesses")
    .select("timezone")
    .eq("id", feed.business_id)
    .maybeSingle<{ timezone: string | null }>()

  const timezone = business?.timezone || "Asia/Singapore"
  const today = todayInTimezone(new Date(), timezone)
  const horizonEnd = addDays(today, FEED_HORIZON_DAYS)

  // The member's own clients. Scoped by business_id AND assigned_member_id —
  // the token identifies one member, so it must not expose the whole tenant.
  const { data: leads } = await admin
    .from("leads")
    .select("id, name")
    .eq("business_id", feed.business_id)
    .eq("assigned_member_id", member.id)

  const leadIds = (leads ?? []).map((l) => l.id as string)
  const nameById = new Map(
    (leads ?? []).map((l) => [l.id as string, (l.name as string) ?? "Client"]),
  )

  let events: IcsEvent[] = []
  if (leadIds.length > 0) {
    const { data: rows } = await admin
      .from("contact_events")
      .select("id, lead_id, event_type, label, event_date, recurrence")
      .eq("business_id", feed.business_id)
      .in("lead_id", leadIds.slice(0, 1000))

    events = (rows ?? [])
      .map((row) => {
        const eventDate = row.event_date as string
        const recurrence = row.recurrence as "none" | "yearly"
        // Yearly events are emitted at their NEXT occurrence with an RRULE, so
        // a 1990 birthday shows up this year rather than 36 years ago.
        const date =
          recurrence === "yearly" ? nextOccurrence(eventDate, "yearly", today) : eventDate
        return { row, date, recurrence }
      })
      .filter(({ date }) => date >= today && date <= horizonEnd)
      .map(({ row, date, recurrence }): IcsEvent => {
        const client = nameById.get(row.lead_id as string) ?? "Client"
        const label = (row.label as string | null) || humaniseEventType(row.event_type as string)
        return {
          uid: `${row.id}@lifecycle`,
          date,
          summary: `${client} — ${label}`,
          // Deliberately minimal: no phone, no email, no drafted message. The
          // feed travels to third-party calendar servers.
          description: `${label} for ${client}. Open Lifecycle for details.`,
          yearly: recurrence === "yearly",
        }
      })
  }

  // Best-effort: a failed touch must not cost the subscriber their feed.
  await admin
    .from("team_member_calendar_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("member_id", member.id)

  const body = buildIcsFeed({
    calendarName: `${member.display_name} — client dates`,
    events,
    now: new Date(),
  })

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="client-dates.ics"',
      // The URL is the credential, so no shared cache should ever hold this.
      "Cache-Control": "private, no-store, max-age=0",
      "X-Robots-Tag": "noindex, nofollow",
    },
  })
}

function notFound() {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  })
}
