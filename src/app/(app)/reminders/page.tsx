import { cookies } from "next/headers"
import Link from "next/link"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { todayInTimezone, daysBetween } from "@/lib/lifecycle/occurrence"
import { humaniseEventType } from "@/lib/lifecycle/labels"
import { describeLeadTime } from "@/lib/notify/client-event-reminder"
import { REMINDER_STATUS_PILL } from "@/lib/types"
import { cn } from "@/lib/utils"
import { describeWhatsappError } from "@/lib/whatsapp-errors"
import { CopyButton } from "@/components/copy-button"
import { CoverageBanner } from "@/components/coverage-banner"
import { SetupChecklistSection } from "@/components/onboarding/setup-checklist-section"
import { CHECKLIST_COLLAPSED_COOKIE } from "@/lib/onboarding/steps"
import { WelcomeTour } from "@/components/onboarding/welcome-tour"
import { CalendarClock, Inbox } from "lucide-react"
import { isPolicyLike } from "@/lib/lifecycle/event-types"
import { loadEventFacts } from "@/lib/lifecycle/event-facts"
import { applyReminderScope, type ReminderScope } from "@/lib/lifecycle/reminder-filters"
import { deriveSendingStatus } from "@/lib/lifecycle/sending-status"
import { MAX_OVERDUE_DAYS } from "@/lib/lifecycle/plan-reminders"
import { SendingStatusBanner } from "@/components/sending-status-banner"
import { DeleteReminderButton, ClearTabButton } from "@/components/reminder-actions"
import { SendReminderButton, SendTabButton } from "@/components/send-actions"
import { MAX_PER_CLICK } from "@/lib/lifecycle/send-limits"

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

const VIEWS = [
  { id: "all", label: "All" },
  { id: "policies", label: "Renewals" },
  { id: "personal", label: "Birthdays" },
] as const

type ViewId = (typeof VIEWS)[number]["id"]

type ReminderRow = {
  id: string
  occurrence_date: string
  due_at: string
  status: string
  suggestion: string | null
  error: string | null
  error_code: string | null
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
  // Which kind of date. Validated below against the buckets this business
  // actually has, so it can never select a view that is empty by construction.
  const viewParam = typeof params.view === "string" ? params.view : "all"

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
  const [
    eventFacts,
    businessRes,
    memberRes,
    cookieStore,
    lastRunRes,
    nextDueRes,
  ] =
    await Promise.all([
      // ONE fetch for both the coverage banner and the type filter. They asked
      // the same question separately, which cost four round trips and moved 672
      // rows twice to derive three strings.
      loadEventFacts(admin, tenant.businessId),
      admin
        .from("businesses")
        .select("timezone, auto_send_enabled")
        .eq("id", tenant.businessId)
        .maybeSingle<{ timezone: string | null; auto_send_enabled: boolean | null }>(),
      admin
        .from("team_members")
        .select("id, display_name, auth_user_id")
        .eq("business_id", tenant.businessId),
      cookies(),
      // Did the engine run? Deployment-wide, so no business filter — there is
      // one engine, and "is it running" is not a per-tenant fact.
      admin
        .from("scheduler_runs")
        .select("ran_at")
        .order("ran_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ ran_at: string }>(),
      // The earliest thing still waiting, for "next due".
      admin
        .from("reminders")
        .select("due_at")
        .eq("business_id", tenant.businessId)
        .eq("status", "queued")
        .order("due_at", { ascending: true })
        .limit(1)
        .maybeSingle<{ due_at: string }>(),
    ])

  const { coverage, knownTypes } = eventFacts

  /**
   * Renewals and birthdays are the same row in the same table, and a manager
   * doing a renewals pass has to read past the birthdays to find them.
   *
   * Split by BUCKET rather than by exact event_type: an agency runs several
   * policy types, so a filter that picked one of them would still make
   * "everything expiring" a five-click job. The buckets come from this tenant's
   * own types via isPolicyLike, so the engine keeps knowing nothing about
   * insurance beyond the single exception that file already documents.
   */
  const buckets = {
    policies: knownTypes.filter((t) => isPolicyLike(t.value)).map((t) => t.value),
    personal: knownTypes.filter((t) => !isPolicyLike(t.value)).map((t) => t.value),
  }
  // An empty bucket is never offered and therefore can never be selected. That
  // is what keeps the .in() below from being handed an empty list, and stops a
  // hand-edited URL rendering a blank inbox that reads as "nothing is due".
  const view: ViewId =
    (viewParam === "policies" || viewParam === "personal") && buckets[viewParam].length > 0
      ? viewParam
      : "all"
  const viewTypes = view === "all" ? [] : buckets[view]
  // Named for what is actually in it. PERSONAL_EVENT_TYPES covers anniversaries
  // too, and a bucket labelled "Birthdays" while quietly also hiding
  // anniversaries is the kind of small lie a filter should not tell.
  const personalLabel = buckets.personal.every((t) => t === "birthday") ? "Birthdays" : "Personal"
  // The same courtesy on the policy side, which was not being extended.
  // isPolicyLike is a NEGATION — "not a birthday or anniversary" — so this
  // bucket holds every product date, and a business tracking policy_review
  // alongside policy_expiry was being told those reviews were "Renewals". A
  // review is not a renewal. Only claim the narrower word when it is true.
  const RENEWAL_WORDS = /(expiry|expiration|renewal|renew)/
  const policiesLabel = buckets.policies.every((t) => RENEWAL_WORDS.test(t))
    ? "Renewals"
    : "Policies"
  const viewLabel =
    view === "personal"
      ? personalLabel
      : view === "policies"
        ? policiesLabel
        : (VIEWS.find((v) => v.id === view)?.label ?? "All")

  /**
   * Fails CLOSED on a read error: `?? false` means an unreadable flag reports
   * "off". Claiming sending is on when we do not know would tell the operator
   * their queue is being handled by something we cannot see.
   */
  const sendingStatus = deriveSendingStatus(
    lastRunRes.data?.ran_at ?? null,
    businessRes.data?.auto_send_enabled ?? false,
  )
  const nextDueAt = nextDueRes.data?.due_at ?? null

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
  /**
   * `mine` only means anything when the signed-in user IS a team member.
   *
   * The toggle is hidden without one, but the query param survived in every
   * generated link regardless — so a URL shared from an account that has a
   * member seat carried `mine=1` into one that does not, where it narrowed
   * nothing while the URL claimed it did. Resolved once, here, rather than
   * re-deriving `mine && myMemberId` at each of the four use sites.
   */
  const mineActive = mine && Boolean(myMemberId)

  /**
   * `reminders` has no event_type — it lives on contact_events, one FK away.
   *
   * `!inner` turns the embed into a JOIN rather than a left-join, so a filter
   * on the embedded column filters the PARENT rows. The alternative was
   * resolving matching event ids in a first query and passing those to .in(),
   * which costs a round trip AND breaks silently past PostgREST's 1000-row cap:
   * a book with more than a thousand policy expiries would quietly show a
   * subset and look like the filter was simply finding less. Filtering on the
   * type STRINGS has no such ceiling — there are a handful of them, not one
   * per date.
   *
   * The embed is only added when filtering, so the unfiltered inbox pays
   * nothing for a feature it is not using.
   */
  const LIST_COLUMNS =
    "id, occurrence_date, due_at, status, suggestion, error, error_code, sent_at, member_id, event_id"
  const withType = (columns: string) =>
    viewTypes.length > 0 ? `${columns}, contact_events!inner(event_type)` : columns

  let query = admin
    .from("reminders")
    .select(withType(LIST_COLUMNS))
    .eq("business_id", tenant.businessId)
    .limit(PAGE_SIZE)
  if (viewTypes.length > 0) query = query.in("contact_events.event_type", viewTypes)

  /**
   * Every link on this page keeps the scope you are already in.
   *
   * There are three independent dimensions now — status tab, whose reminders,
   * which kind of date — and each link was concatenating them by hand. That is
   * how a filter silently resets: switching tabs already dropped nothing only
   * because `mine` was spelled out at every call site, and a third dimension
   * would have had to be spelled out at all of them again.
   */
  const hrefFor = (next: { tab?: TabId; mine?: boolean; view?: ViewId }) => {
    const q = new URLSearchParams({ tab: next.tab ?? tab })
    if (next.mine ?? mineActive) q.set("mine", "1")
    const v = next.view ?? view
    if (v !== "all") q.set("view", v)
    return `/reminders?${q}`
  }

  const nowIso = new Date().toISOString()

  /**
   * One description of "what this tab is showing", shared with the Clear
   * button's server action. Two copies would let the count beside the button
   * drift from the rows the button deletes.
   */
  const scopeFor = (id: TabId): ReminderScope => ({
    tab: id,
    mine: mineActive,
    memberId: myMemberId,
    viewTypes,
    nowIso,
  })

  query = applyReminderScope(query, scopeFor(tab))
  if (tab === "sent") query = query.order("sent_at", { ascending: false })
  else if (tab === "attention") query = query.order("due_at", { ascending: false })
  else query = query.order("due_at", { ascending: true })

  // How many are behind each tab, so "Needs attention" can say so without
  // being opened. `head: true` — these are counts, no rows cross the wire.
  const countFor = (id: TabId) => {
    const q = admin
      .from("reminders")
      .select(withType("id"), { count: "exact", head: true })
      .eq("business_id", tenant.businessId)
    return applyReminderScope(q, scopeFor(id))
  }

  const [{ data, error }, ...tabCountResults] = await Promise.all([
    query,
    ...TABS.map((t) => countFor(t.id)),
  ])
  // Through `unknown` because the column list is built at runtime now, so
  // supabase-js can no longer parse it into a row type and falls back to its
  // error shape. The columns are still fixed — LIST_COLUMNS above — the
  // compiler just cannot see through the template string to check it.
  const rows = (data ?? []) as unknown as ReminderRow[]
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
        <div className="flex flex-wrap items-center gap-2">
          {myMemberId && (
            <Link
              href={hrefFor({ mine: !mineActive })}
              className={cn(
                "inline-flex h-8 shrink-0 items-center rounded-lg px-3 text-sm font-medium ring-1 transition-colors",
                mineActive
                  ? "bg-foreground text-background ring-transparent"
                  : "bg-background text-foreground ring-foreground/10 hover:bg-muted",
              )}
            >
              {mineActive ? "Showing mine" : "Only mine"}
            </Link>
          )}
        </div>
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
      {/* Streamed: it asks Meta about the template, and that question must not
          hold the inbox. The placeholder is sized from the same cookie. */}
      <SetupChecklistSection
        collapsed={cookieStore.get(CHECKLIST_COLLAPSED_COOKIE)?.value === "1"}
      />
      <CoverageBanner coverage={coverage} />
      {/* Above the card, not inside it: this is a fact about the whole engine,
          not about whichever tab happens to be open. */}
      <SendingStatusBanner
        status={sendingStatus}
        // Raw, including the -1 failure sentinel. Clamping it to 0 turned "we
        // could not count" into "nothing is queued", which is the one thing
        // this banner must never say when it does not know.
        dueCount={tabCounts.get("due") ?? -1}
        nextDueAt={nextDueAt}
        timezone={timezone}
      />

      <div className="rounded-xl border bg-background shadow-sm">
        {/* Wraps rather than scrolls. Four tabs plus their counts are wider
            than a phone, and a horizontal scroll strip hid "Needs attention"
            past its right edge with nothing to say it was there — which is
            precisely the tab nobody would think to go looking for. */}
        <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2">
          {TABS.map((t) => {
            const count = tabCounts.get(t.id) ?? -1
            return (
              <Link
                key={t.id}
                href={hrefFor({ tab: t.id })}
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

          {/* Clearing acts on the OPEN tab, so it sits with the tabs rather
              than in the page header — and it carries that tab's own count, so
              the number on the button is the number that disappears. */}
          {/* Every active narrowing, not just the tab. With a view filter on,
              "everything in Due" named 6 rows while the button cleared the 3
              the filter had left — the count was right and the sentence was
              wrong, which is the worse half to get wrong on a delete. */}
          {/* Only Due and Needs attention. "Sent" would re-send messages that
              already arrived, and "Upcoming" is not due yet — sending that
              early is a different decision from clearing a backlog. */}
          {(tab === "due" || tab === "attention") && (
            <SendTabButton
              scope={scopeFor(tab)}
              count={Math.max(0, tabCounts.get(tab) ?? 0)}
              label={[
                TABS.find((t) => t.id === tab)?.label ?? "this tab",
                view === "all" ? null : viewLabel,
                mineActive ? "yours" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              maxPerClick={MAX_PER_CLICK}
            />
          )}

          <ClearTabButton
            scope={scopeFor(tab)}
            count={Math.max(0, tabCounts.get(tab) ?? 0)}
            label={[
              TABS.find((t) => t.id === tab)?.label ?? "this tab",
              view === "all" ? null : viewLabel,
              mineActive ? "yours" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            paused={sendingStatus.state !== "live"}
            maxOverdueDays={MAX_OVERDUE_DAYS}
          />

          {/* Same row as the tabs, and the same selected treatment.
              It used to sit in the page header: two rows of pills 458px apart
              in opposite corners, with INVERTED polarity — the segmented
              control marked "on" as white-on-grey while the tabs marked it
              grey-on-white. Nothing said which row filtered the list. One row,
              one grammar, and a visible word for the dimension.

              Only rendered when there is something to separate: an agency with
              no birthdays on file would get three options returning identical
              rows, which reads as a filter that does not work. */}
          {buckets.policies.length > 0 && buckets.personal.length > 0 && (
            <div className="ml-auto flex flex-wrap items-center gap-1" role="group">
              <span className="px-1 text-xs text-muted-foreground" id="view-filter-label">
                Dates
              </span>
              {VIEWS.map((v) => (
                <Link
                  key={v.id}
                  href={hrefFor({ view: v.id })}
                  aria-current={v.id === view ? "true" : undefined}
                  className={cn(
                    "inline-flex h-7 shrink-0 items-center rounded-lg px-3 text-sm font-medium transition-colors",
                    v.id === view
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {v.id === "personal" ? personalLabel : v.id === "policies" ? policiesLabel : v.label}
                </Link>
              ))}
            </div>
          )}
        </div>

        {error ? (
          <p className="m-5 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Could not load reminders: {error.message}
          </p>
        ) : rows.length === 0 ? (
          <EmptyState
            tab={tab}
            // Built from EVERY dimension that is narrowing the list, not just
            // the newest one. Derived from `view` alone, this told an operator
            // with "Only mine" on and an empty result that nothing was due —
            // the same falsehood the view handling was written to prevent,
            // reintroduced one filter over.
            narrowing={[
              view === "all" ? null : viewLabel.toLowerCase(),
              mineActive ? "yours" : null,
            ].filter((v): v is string => v !== null)}
            clearHref={hrefFor({ view: "all", mine: false })}
          />
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
                <li key={row.id} className="group/row px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
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
                    {/* Always rendered, never hover-only: a control that
                        appears on hover does not exist on a touch screen, and
                        the operator opens this on a phone. */}
                    <div className="flex shrink-0 items-center gap-1">
                      {/* Sending a row that already went out would deliver a
                          second copy of a message the agent has read. */}
                      {row.status !== "sent" && <SendReminderButton id={row.id} />}
                      <DeleteReminderButton id={row.id} />
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
                    /* Ours first, Meta's second.
                       The raw line is kept because it is the only thing worth
                       pasting into a support ticket, but on its own it asks the
                       operator to know what "[131047]" means. The sentence above
                       it says what to actually do; the code below it is the
                       evidence. */
                    <div className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-destructive">
                      {(() => {
                        const info = describeWhatsappError(row.error_code, row.error)
                        return (
                          <>
                            <p className="text-xs font-medium">{info.title}</p>
                            <p className="mt-1 text-xs leading-relaxed">{info.action}</p>
                          </>
                        )
                      })()}
                      {/* break-words because this is Meta's text, not ours, and
                          Meta puts URLs in it. #131042 arrives carrying a
                          190-char billing link with no spaces, which has no
                          break opportunity and dragged the whole page to 791px
                          wide inside a 375px viewport — every row on the tab
                          scrolling sideways because of one error string. */}
                      <p className="mt-2 text-[11px] break-words opacity-70">{row.error}</p>
                    </div>
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

function EmptyState({
  tab,
  narrowing,
  clearHref,
}: {
  tab: TabId
  /** Every active filter, named. Empty when the list is unfiltered. */
  narrowing: string[]
  clearHref: string
}) {
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
      {/* With a filter on, the unfiltered copy is simply false — there may be
          twenty reminders due and every one of them a birthday. Saying
          "nothing due" there sends an operator looking for a bug in the engine
          instead of at the control they set two clicks ago. */}
      <p className="text-sm font-medium">
        {narrowing.length > 0 ? "Nothing here under these filters" : title}
      </p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {narrowing.length > 0 ? `Nothing ${narrowing.join(" and ")} in this tab.` : body}
      </p>
      {narrowing.length > 0 && (
        <Link
          href={clearHref}
          className="mt-2 inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium text-brand-ink transition-colors hover:bg-muted hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Clear filters
        </Link>
      )}
    </div>
  )
}
