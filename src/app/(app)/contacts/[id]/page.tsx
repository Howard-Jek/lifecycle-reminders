import Link from "next/link"
import { notFound } from "next/navigation"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { humaniseEventType } from "@/lib/lifecycle/labels"
import { nextOccurrence, todayInTimezone, daysBetween } from "@/lib/lifecycle/occurrence"
import { describeLeadTime } from "@/lib/notify/client-event-reminder"
import { REMINDER_STATUS_PILL } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { EventsClient } from "./events-client"

export const dynamic = "force-dynamic"

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const tenant = await requireTenant()
  const admin = createAdminClient()

  const { data: contact } = await admin
    .from("leads")
    .select("id, name, phone, email, assigned_member_id, context")
    .eq("id", id)
    .eq("business_id", tenant.businessId)
    .maybeSingle<{
      id: string
      name: string
      phone: string
      email: string | null
      assigned_member_id: string | null
      context: Record<string, unknown> | null
    }>()

  if (!contact) notFound()

  const [{ data: business }, { data: eventRows }, { data: memberRows }, { data: reminderRows }] =
    await Promise.all([
      admin
        .from("businesses")
        .select("timezone")
        .eq("id", tenant.businessId)
        .maybeSingle<{ timezone: string | null }>(),
      admin
        .from("contact_events")
        .select("id, event_type, label, event_date, recurrence, source, payload")
        .eq("business_id", tenant.businessId)
        .eq("lead_id", contact.id)
        .order("event_date"),
      admin
        .from("team_members")
        .select("id, display_name, active")
        .eq("business_id", tenant.businessId)
        .order("display_name"),
      admin
        .from("reminders")
        .select("id, event_id, occurrence_date, due_at, status, member_id")
        .eq("business_id", tenant.businessId)
        .order("due_at", { ascending: true })
        .limit(200),
    ])

  const timezone = business?.timezone || "Asia/Singapore"
  const today = todayInTimezone(new Date(), timezone)
  const events = eventRows ?? []
  const members = (memberRows ?? []) as Array<{
    id: string
    display_name: string
    active: boolean
  }>
  const memberName = new Map(members.map((m) => [m.id, m.display_name]))

  // Only this contact's reminders. Filtered here rather than in SQL because
  // reminders key off event_id, and the event set is already loaded.
  const eventIds = new Set(events.map((e) => e.id as string))
  const reminders = (reminderRows ?? []).filter((r) => eventIds.has(r.event_id as string))

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <Link href="/contacts" className="text-sm text-muted-foreground hover:underline">
          ← Contacts
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">{contact.name}</h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="font-mono tabular-nums">{contact.phone}</span>
          {contact.email && (
            <>
              <span>·</span>
              <span>{contact.email}</span>
            </>
          )}
          <span>·</span>
          {contact.assigned_member_id ? (
            <span>{memberName.get(contact.assigned_member_id) ?? "Removed member"}</span>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              unassigned
            </Badge>
          )}
        </p>
      </div>

      <EventsClient
        contactId={contact.id}
        assignedMemberId={contact.assigned_member_id}
        members={members}
        events={events.map((e) => ({
          id: e.id as string,
          event_type: e.event_type as string,
          label: e.label as string | null,
          event_date: e.event_date as string,
          recurrence: e.recurrence as "none" | "yearly",
          source: e.source as string,
          nextOn:
            (e.recurrence as string) === "yearly"
              ? nextOccurrence(e.event_date as string, "yearly", today)
              : (e.event_date as string),
        }))}
        today={today}
      />

      <section className="rounded-xl border bg-card p-6 shadow-sm ring-1 ring-foreground/5">
        <h2 className="text-base font-semibold">Reminders for this contact</h2>
        {reminders.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            None scheduled. Reminders appear once a rule in Settings matches one of these dates.
          </p>
        ) : (
          <ul className="mt-4 divide-y">
            {reminders.map((r) => (
              <li key={r.id as string} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <span
                  className={cn(
                    "inline-flex h-5 items-center rounded-full px-2 text-xs font-medium",
                    REMINDER_STATUS_PILL[r.status as string] ?? "bg-foreground/5",
                  )}
                >
                  {r.status as string}
                </span>
                <span className="tabular-nums">
                  {describeLeadTime(daysBetween(today, r.occurrence_date as string))}
                </span>
                <span className="text-muted-foreground">
                  to{" "}
                  {r.member_id
                    ? memberName.get(r.member_id as string) ?? "Removed member"
                    : "Owner (unassigned)"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {contact.context && Object.keys(contact.context).length > 0 && (
        <section className="rounded-xl border bg-card p-6 shadow-sm ring-1 ring-foreground/5">
          <h2 className="text-base font-semibold">From the import</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Columns kept verbatim. These are handed to the model when it drafts an opener.
          </p>
          <dl className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {Object.entries(contact.context).map(([key, value]) => (
              <div key={key} className="flex gap-2 text-sm">
                <dt className="shrink-0 text-muted-foreground">{humaniseEventType(key)}:</dt>
                <dd className="min-w-0 wrap-anywhere">{String(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  )
}
