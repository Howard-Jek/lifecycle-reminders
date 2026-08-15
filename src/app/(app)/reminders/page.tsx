import { cookies } from "next/headers"
import Link from "next/link"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { todayInTimezone, daysBetween } from "@/lib/lifecycle/occurrence"
import { humaniseEventType } from "@/lib/lifecycle/labels"
import { describeLeadTime } from "@/lib/notify/client-event-reminder"
import { REMINDER_STATUS_PILL } from "@/lib/types"
import { cn } from "@/lib/utils"
import { CopyButton } from "@/components/copy-button"
import { CoverageBanner } from "@/components/coverage-banner"
import { SetupChecklist } from "@/components/onboarding/setup-checklist"
import { CHECKLIST_COLLAPSED_COOKIE } from "@/lib/onboarding/steps"
import { getSetupSteps } from "@/app/actions/onboarding"
import { WelcomeTour } from "@/components/onboarding/welcome-tour"
import { getCoverage } from "@/app/actions/coverage"
import { CalendarClock, Inbox } from "lucide-react"

export const metadata = { title: "Reminders" }

export const dynamic = "force-dynamic"

/**
 * The reminder inbox.
 *
 * Four tabs rather than one filtered list, because they answer four different
 * questions: what needs me now, what is coming, what went out, and what
 * silently did not. That last one is the whole reason `skipped` and `failed`
 * are separate states in the schema — a reminder nobody received is worse than
 * one that errored loudly.
 */

const TABS = [
  { id: "due", label: "Due" },
  { id: "upcoming", label: "Upcoming" },
  { id: "sent", label: "Sent" },
  { id: "attention", label: "Needs attention" },
] as const

type TabId = (typeof TABS)[number]["id"]

type ReminderRow = {
  id: string
  occurrence_date: string
  due_at: string
  status: string
  suggestion: string | null
  error: string | null
  sent_at: string | null
  member_id: string | null
  event_id: string
}

const PAGE_SIZE = 50

export default async function RemindersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const raw = typeof params.tab === "string" ? params.tab : "due"
  const tab: TabId = (TABS.find((t) => t.id === raw)?.id ?? "due") as TabId
  const mine = params.mine === "1"

  const tenant = await requireTenant()
  const admin = createAdminClient()

  // ONE wave, not four.
  //
  // These are independent of each other, and a Supabase round-trip costs the
  // same whether it returns one number or five hundred rows — measured at
  // ~130ms from a laptop, and it is the count of sequential waits, not the
  // weight of any query, that this page's latency is made of. Awaiting them in
  // series cost four times what awaiting them together does, for nothing.
  //
  // Coverage is loaded here rather than in the shell: an empty queue and a
  // queue that can never fill look identical, and this is the page where that
  // matters.
  const [coverage, businessRes, memberRes, setupSteps, cookieStore] = await Promise.all([
    getCoverage(),
    admin
      .from("businesses")
      .select("timezone")
      .eq("id", tenant.businessId)
      .maybeSingle<{ timezone: string | null }>(),
    admin
      .from("team_members")
      .select("id, display_name, auth_user_id")
      .eq("business_id", tenant.businessId),
    getSetupSteps(),
    cookies(),
  ])

  const timezone = businessRes.data?.timezone || "Asia/Singapore"
  const today = todayInTimezone(new Date(), timezone)

  const memberRows = memberRes.data
  const members = new Map(
    (memberRows ?? []).map((m) => [m.id as string, m.display_name as string]),
  )
  // "Mine" works because a member row can carry a seat link. A member with no
  // auth_user_id simply never matches, which is correct — they do not log in.
  const myMemberId =
    (memberRows ?? []).find((m) => m.auth_user_id === tenant.userId)?.id as string | undefined

  let query = admin
    .from("reminders")
    .select("id, occurrence_date, due_at, status, suggestion, error, sent_at, member_id, event_id")
    .eq("business_id", tenant.businessId)
    .limit(PAGE_SIZE)

  const nowIso = new Date().toISOString()
  if (tab === "due") {
    query = query.eq("status", "queued").lte("due_at", nowIso).order("due_at", { ascending: true })
  } else if (tab === "upcoming") {
    query = query.eq("status", "queued").gt("due_at", nowIso).order("due_at", { ascending: true })
  } else if (tab === "sent") {
    query = query.eq("status", "sent").order("sent_at", { ascending: false })
  } else {
    query = query.in("status", ["failed", "skipped"]).order("due_at", { ascending: false })
  }

  if (mine && myMemberId) query = query.eq("member_id", myMemberId)

  // How many are behind each tab, so "Needs attention" can say so without
  // being opened. `head: true` — these are counts, no rows cross the wire.
  const countFor = (id: TabId) => {
    let q = admin
      .from("reminders")
      .select("id", { count: "exact", head: true })
      .eq("business_id", tenant.businessId)
    if (id === "due") q = q.eq("status", "queued").lte("due_at", nowIso)
    else if (id === "upcoming") q = q.eq("status", "queued").gt("due_at", nowIso)
    else if (id === "sent") q = q.eq("status", "sent")
    else q = q.in("status", ["failed", "skipped"])
    if (mine && myMemberId) q = q.eq("member_id", myMemberId)
    return q
  }

  const [{ data, error }, ...tabCountResults] = await Promise.all([
    query,
    ...TABS.map((t) => countFor(t.id)),
  ])
  const rows = (data ?? []) as ReminderRow[]
  const tabCounts = new Map<TabId, number>(
    // A failed count is `null`, which must not render as a confident "0".
    TABS.map((t, i) => [t.id, tabCountResults[i]?.count ?? -1]),
  )

  // Event + contact detail for just the rows on screen, in ONE round trip.
  //
  // This was two: fetch the events, collect their lead ids, then fetch the
  // leads. The second could not start until the first came back, so it was a
  // full round-trip of pure waiting to resolve a foreign key the database can
  // follow itself. PostgREST embeds it.
  const eventIds = Array.from(new Set(rows.map((r) => r.event_id)))
  const eventById = new Map<
    string,
    { event_type: string; label: string | null; lead_id: string; lead_name: string | null }
  >()

  if (eventIds.length > 0) {
    type EventRow = {
      id: string
      event_type: string
      label: string | null
      lead_id: string
      // One-to-one through the FK, but supabase-js types an embed as possibly
      // an array, so it is narrowed on read rather than asserted here.
      leads: { name: string } | { name: string }[] | null
    }
    const { data: events } = await admin
      .from("contact_events")
      .select("id, event_type, label, lead_id, leads(name)")
      .eq("business_id", tenant.businessId)
      .in("id", eventIds)
      .returns<EventRow[]>()

    for (const e of events ?? []) {
      const lead = Array.isArray(e.leads) ? e.leads[0] : e.leads
      eventById.set(e.id, {
        event_type: e.event_type,
        label: e.label,
        lead_id: e.lead_id,
        lead_name: lead?.name ?? null,
      })
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reminders</h1>
          <p className="text-sm text-muted-foreground">
            Client dates worth a conversation, and who they are going to.
          </p>
        </div>
        {myMemberId && (
          <Link
            href={`/reminders?tab=${tab}${mine ? "" : "&mine=1"}`}
            className={cn(
              "inline-flex h-8 shrink-0 items-center rounded-lg px-3 text-sm font-medium ring-1 transition-colors",
              mine
                ? "bg-foreground text-background ring-transparent"
                : "bg-background text-foreground ring-foreground/10 hover:bg-muted",
            )}
          >
            {mine ? "Showing mine" : "Only mine"}
          </Link>
        )}
      </div>

      <WelcomeTour />
      {/* Rendered inline, NOT behind Suspense. A `fallback={null}` boundary
          reserves no space, so the checklist streamed in after first paint and
          shoved the whole inbox down — 415px of movement on the page an
          operator opens every morning, worst for the new operator the wizard
          exists for. The cost it was avoiding is now bounded elsewhere: the
          template state is memoised for five minutes and its fetch is aborted
          at three seconds, when WhatsApp is unconfigured there is no network
          call at all, and its counts ride in the batch above rather than
          costing a wave of their own. */}
      <SetupChecklist
        steps={setupSteps}
        defaultCollapsed={cookieStore.get(CHECKLIST_COLLAPSED_COOKIE)?.value === "1"}
      />
      <CoverageBanner coverage={coverage} />

      <div className="rounded-xl border bg-background shadow-sm">
        {/* Wraps rather than scrolls. Four tabs plus their counts are wider
            than a phone, and a horizontal scroll strip hid "Needs attention"
            past its right edge with nothing to say it was there — which is
            precisely the tab nobody would think to go looking for. */}
        <div className="flex flex-wrap gap-1 border-b px-3 py-2">
          {TABS.map((t) => {
            const count = tabCounts.get(t.id) ?? -1
            return (
              <Link
                key={t.id}
                href={`/reminders?tab=${t.id}${mine ? "&mine=1" : ""}`}
                aria-current={t.id === tab ? "page" : undefined}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors",
                  t.id === tab
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {t.label}
                {count > 0 && (
                  // "Needs attention" is the tab nobody thinks to open, so the
                  // count is the whole point: it is the only way that tab can
                  // ask to be looked at. Amber only there — everywhere else a
                  // number is information, not a problem.
                  <span
                    className={cn(
                      "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.65rem] tabular-nums",
                      t.id === "attention"
                        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        : "bg-foreground/5 text-muted-foreground",
                    )}
                  >
                    {count}
                  </span>
                )}
              </Link>
            )
          })}
        </div>

        {error ? (
          <p className="m-5 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Could not load reminders: {error.message}
          </p>
        ) : rows.length === 0 ? (
          <EmptyState tab={tab} />
        ) : (
          <ul className="divide-y">
            {rows.map((row) => {
              const event = eventById.get(row.event_id)
              const clientName = event?.lead_name ?? undefined
              const label = event
                ? event.label || humaniseEventType(event.event_type)
                : "Event removed"
              const whenText = describeLeadTime(daysBetween(today, row.occurrence_date))
              const recipient = row.member_id
                ? members.get(row.member_id) ?? "Removed member"
                : "Owner (unassigned)"

              return (
                <li key={row.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {event ? (
                          <Link
                            href={`/contacts/${event.lead_id}`}
                            className="text-brand-ink hover:underline"
                          >
                            {clientName ?? "Contact removed"}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">Contact removed</span>
                        )}
                        <span className="text-muted-foreground">·</span>
                        <span>{label}</span>
                        <span
                          className={cn(
                            "inline-flex h-5 items-center rounded-full px-2 text-xs font-medium",
                            REMINDER_STATUS_PILL[row.status] ?? "bg-foreground/5",
                          )}
                        >
                          {row.status}
                        </span>
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <CalendarClock className="size-3.5" strokeWidth={1.75} />
                        <span className="tabular-nums">{whenText}</span>
                        <span>·</span>
                        <span>to {recipient}</span>
                      </p>
                    </div>
                  </div>

                  {row.suggestion && (
                    <div className="mt-3 rounded-lg bg-muted/60 p-3">
                      <p className="text-sm leading-relaxed">{row.suggestion}</p>
                      {/* Copy, not "send": the whole design keeps a human
                          between the draft and the client. */}
                      <CopyButton value={row.suggestion} className="mt-2" />
                    </div>
                  )}

                  {row.error && (
                    <p className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {row.error}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {/* The list is capped at PAGE_SIZE and there is no pager yet. The tab
            badge counts every row, so without this line a tab reading 137
            would show 50 and simply stop — the badge making a truncation
            visible that used to be merely silent. Say it plainly instead. */}
        {rows.length >= PAGE_SIZE && (tabCounts.get(tab) ?? 0) > rows.length && (
          <p className="border-t px-5 py-3 text-sm text-muted-foreground">
            Showing the first <span className="tabular-nums">{rows.length}</span> of{" "}
            <span className="tabular-nums">{tabCounts.get(tab)}</span>.{" "}
            {tab === "sent"
              ? "Older ones are further down the record."
              : "Work through these and the rest follow."}
          </p>
        )}
      </div>
    </div>
  )
}

function EmptyState({ tab }: { tab: TabId }) {
  const copy: Record<TabId, { title: string; body: string }> = {
    due: {
      title: "Nothing due right now",
      body: "Reminders appear here when a client date comes within its lead time.",
    },
    upcoming: {
      title: "Nothing scheduled yet",
      body: "Import some contacts with dates, then add a rule in Settings.",
    },
    sent: { title: "Nothing sent yet", body: "Delivered reminders are kept here as a record." },
    attention: {
      title: "Nothing needs attention",
      body: "Reminders that failed to send, or had nobody to send to, land here.",
    },
  }
  const { title, body } = copy[tab]

  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      <div className="rounded-full bg-muted p-3">
        <Inbox className="size-5 text-muted-foreground" strokeWidth={1.75} />
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
    </div>
  )
}
