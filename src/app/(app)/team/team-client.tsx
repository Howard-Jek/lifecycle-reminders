"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CalendarPlus, Plus, RotateCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { CopyButton } from "@/components/copy-button"
import {
  TEST_STAGES,
  TEST_STAGE_LABELS,
  type TestStage,
  type TestProgress,
} from "@/lib/notify/test-message"
import { RowActions } from "@/components/row-actions"
import {
  createTeamMember,
  updateTeamMember,
  setTeamMemberActive,
  issueCalendarFeed,
  revokeCalendarFeed,
  sendTestMessage,
  checkTestMessage,
  type MemberInput,
} from "@/app/actions/team-members"
import { TestMessagePanel, type TestTarget } from "./test-message-panel"
import type { TeamMember } from "@/lib/lifecycle/types"

const BLANK: MemberInput = {
  display_name: "",
  email: "",
  whatsapp_number: "",
  role: "agent",
}

export function TeamClient({
  members,
  feeds,
  dryRun,
}: {
  members: TeamMember[]
  feeds: Record<string, string>
  /** Read on the server: the panel must say so before asking to spend money. */
  dryRun: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<MemberInput | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  /** Shown once, then gone: only the hash is stored. */
  const [freshUrl, setFreshUrl] = useState<{ memberId: string; url: string } | null>(null)
  /** A test send waiting to be confirmed. Never sends on its own. */
  const [testTarget, setTestTarget] = useState<TestTarget | null>(null)
  const [testNotice, setTestNotice] = useState<{ tone: "sent" | "dry"; text: string } | null>(null)
  /**
   * Whether THIS action is in flight, as distinct from useTransition's
   * `pending`, which is true for every action on the page. Sharing the one flag
   * made the panel's button read "Sending…" while an unrelated calendar feed
   * was being issued — a message about spending money, describing something
   * else entirely.
   */
  const [sending, setSending] = useState(false)

  /**
   * A test send being watched to its actual outcome.
   *
   * Held here rather than derived, because the interesting states arrive after
   * the action has returned: Meta answers the Graph call immediately and
   * reports real delivery seconds later over the webhook.
   */
  const [watch, setWatch] = useState<{
    memberId: string
    displayName: string
    number: string
    inactive: boolean
    wamid: string
    sentAt: string
    stage: TestStage
    failure: TestProgress["failure"]
    replied: boolean
    waiting: boolean
  } | null>(null)

  useEffect(() => {
    if (!watch?.waiting) return
    let cancelled = false

    /**
     * Stops on its own after two minutes.
     *
     * A reply needs a human to pick up a phone, so this cannot poll until it
     * gets one — it would run forever on a test nobody answers. Giving up says
     * exactly how far the message got, which is a real answer rather than a
     * timeout: "delivered, not replied to" is a working pipeline and an
     * unattended handset, and those must not read the same.
     */
    const deadline = Date.now() + 120_000
    const timer = setInterval(async () => {
      const result = await checkTestMessage(watch.memberId, watch.wamid, watch.sentAt)
      if (cancelled) return
      if (result.ok) {
        const done = result.data.replied || result.data.failure !== null
        setWatch((w) =>
          w && w.wamid === watch.wamid
            ? { ...w, ...result.data, waiting: !done && Date.now() < deadline }
            : w,
        )
        if (done) return
      }
      if (Date.now() >= deadline) {
        setWatch((w) => (w && w.wamid === watch.wamid ? { ...w, waiting: false } : w))
      }
    }, 3000)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [watch?.waiting, watch?.wamid, watch?.memberId, watch?.sentAt])
  /**
   * Where focus was when the offer was staged, so it can go back.
   *
   * Without this, dismissing sent focus to <body> and the viewport to the top
   * of the document — measured ~950px away from the row the operator was
   * working on, with a keyboard user's next Tab restarting at the page header.
   */
  const returnFocus = useRef<{ el: HTMLElement | null; rowOf: string | null }>({
    el: null,
    rowOf: null,
  })

  function stageOffer(next: TestTarget) {
    returnFocus.current = {
      el: document.activeElement as HTMLElement | null,
      // The element captured above is usually GONE by the time we restore: from
      // the row menu it is the menu item, which unmounts with the menu, and
      // from Add member it is the Save button, which unmounts with the form.
      // Measured: focus landed on <body> every time. So the member's own ⋯
      // trigger is recorded as the thing to come back to — it is on the row the
      // operator was working on, and it outlives both.
      rowOf: next.name,
    }
    setTestTarget(next)
  }

  function restoreFocus() {
    const { el, rowOf } = returnFocus.current
    returnFocus.current = { el: null, rowOf: null }
    if (el?.isConnected) {
      el.focus()
      return
    }
    if (!rowOf) return
    // Matched on the exact label rather than built into a selector, so a name
    // containing a quote cannot break the query.
    const label = `Actions for ${rowOf}`
    const trigger = Array.from(document.querySelectorAll<HTMLElement>("button[aria-label]")).find(
      (b) => b.getAttribute("aria-label") === label,
    )
    trigger?.focus()
  }

  function dismissOffer() {
    setTestTarget(null)
    restoreFocus()
  }

  function clearNotices() {
    setError(null)
    setTestNotice(null)
  }

  /**
   * Drop a staged offer, because the row it describes may no longer say what
   * the panel says.
   *
   * The panel shows the number the message will go to — that is its whole job,
   * since this is where the cost is stated. Edit the member behind it and that
   * snapshot is stale: the send re-reads the row and goes to the NEW number,
   * having asked about the old one.
   */
  /**
   * Invalidate a staged offer WITHOUT moving focus.
   *
   * Called when some other action starts, not when the operator dismisses —
   * they have just clicked something else, and pulling focus back to the row
   * that opened the offer would take it off the control they are using.
   */
  function dropOffer() {
    setTestTarget(null)
    returnFocus.current = { el: null, rowOf: null }
  }

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    clearNotices()
    dropOffer()
    startTransition(async () => {
      const result = await fn()
      if (!result.ok) {
        setError(result.error)
        return
      }
      setDraft(null)
      setEditingId(null)
      router.refresh()
    })
  }

  /** Save, and — for a NEW member only — offer to prove the number works. */
  function saveMember(input: MemberInput) {
    clearNotices()
    dropOffer()
    startTransition(async () => {
      // The two branches stay apart rather than sharing one awaited result:
      // only the create returns a row, and collapsing them costs the narrowing
      // that makes reading it safe.
      if (editingId) {
        const result = await updateTeamMember(editingId, input)
        if (!result.ok) {
          setError(result.error)
          return
        }
      } else {
        const result = await createTeamMember(input)
        if (!result.ok) {
          setError(result.error)
          return
        }
        stageOffer({
          id: result.data.id,
          name: result.data.display_name,
          number: result.data.whatsapp_number,
          justAdded: true,
        })
      }
      setDraft(null)
      setEditingId(null)
      router.refresh()
    })
  }

  function runTestSend(target: TestTarget) {
    clearNotices()
    setSending(true)
    startTransition(async () => {
      const result = await sendTestMessage(target.id)
      setSending(false)
      if (!result.ok) {
        // The panel STAYS. A rejected send is usually transient — Meta being
        // slow, the template not approved yet — and closing it would make the
        // retry a hunt back through the row menu, having already lost which
        // member it was about.
        setError(result.error)
        return
      }
      setTestTarget(null)
      restoreFocus()
      const { displayName, number, inactive, dryRun, whatsappMessageId, sentAt } = result.data

      if (dryRun) {
        setTestNotice({
          tone: "dry",
          // Says "server log", NOT "Sandbox": the sandbox transcript is written
          // by the reminder cycle, and a direct test send never touches it. The
          // first draft of this sentence sent the operator looking in a place
          // the message was never going to appear.
          text: `Nothing was sent — REMINDER_DRY_RUN is on. The message for ${displayName} (${number}) was built and logged on the server, but never reached WhatsApp.`,
        })
        return
      }

      /**
       * Watch it, rather than assert it.
       *
       * The old copy said the message "should arrive within a few seconds; if
       * it does not, that number has no WhatsApp account" — asserted at the one
       * moment when nothing had been proven. The Graph API returns 200 and a
       * message id for a number with no WhatsApp account, for a number Meta is
       * throttling, and for a template it will then refuse to deliver. On this
       * deployment the real answer was 131049, and the operator was sent to
       * check a phone number that was perfectly fine.
       */
      setWatch({
        memberId: target.id,
        displayName,
        number,
        inactive,
        wamid: whatsappMessageId,
        sentAt,
        stage: "accepted",
        failure: null,
        replied: false,
        waiting: true,
      })
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Team</h1>
          <p className="text-sm text-muted-foreground">
            Who a client belongs to, and the number their reminders go to.
          </p>
        </div>
        {!draft && (
          <Button onClick={() => setDraft({ ...BLANK })}>
            <Plus data-icon="inline-start" />
            Add member
          </Button>
        )}
      </div>

      {error && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      {freshUrl && (
        <div className="rounded-xl border bg-card p-4 shadow-sm ring-1 ring-brand/20">
          <p className="text-sm font-medium">Calendar link — copy it now</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Only a hash of this link is stored, so this is the one time it can be shown. Subscribe
            to it in Google or Apple Calendar. Re-issue to get a new one.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-muted px-3 py-2 font-mono text-xs">
              {freshUrl.url}
            </code>
            <CopyButton value={freshUrl.url} />
            <Button variant="ghost" size="icon-sm" onClick={() => setFreshUrl(null)}>
              <X />
            </Button>
          </div>
        </div>
      )}

      {/* Mounted from the start, and never conditionally. A live region that
          appears in the DOM at the same moment as its text is announced
          unreliably — and "your message was not sent" is the sentence that has
          to reach somebody who cannot see the wash colour. Absolutely
          positioned by sr-only, so it adds no gap to the stack above. */}
      <p className="sr-only" role="status" aria-live="polite">
        {error ?? testNotice?.text ?? ""}
      </p>

      {/**
        * ON A CARD, not straight onto the page background — and that is a
        * contrast fix, not decoration.
        *
        * `text-emerald-700` over `bg-emerald-500/10` measures 4.37:1 against
        * this page's warm --background, and the amber 4.16:1: both under the
        * 4.5 that AA requires, on the only feedback a billed action gets. The
        * identical wash passes at 4.62-4.86:1 over --card, which is why every
        * other notice in the app — including the calendar panel directly above
        * — already sits on one. The token stays; the surface under it changes.
        */}
      {watch && (
        <div className="rounded-xl border bg-card p-4 shadow-sm ring-1 ring-foreground/5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                Test to {watch.displayName} ({watch.number})
              </p>

              {/* The ladder. Each rung is a fact somebody else told us — a
                  delivery receipt from Meta, or a reply from the handset — so
                  a rung that is not lit is genuinely unknown rather than
                  assumed. */}
              <ol className="mt-3 space-y-1.5">
                {TEST_STAGES.map((step) => {
                  const reachedIndex = TEST_STAGES.indexOf(watch.stage)
                  const stepIndex = TEST_STAGES.indexOf(step)
                  const reached = stepIndex <= reachedIndex
                  const stalledHere = !!watch.failure && stepIndex === reachedIndex + 1
                  return (
                    <li key={step} className="flex items-start gap-2 text-sm">
                      <span
                        aria-hidden
                        className={
                          stalledHere
                            ? "text-destructive"
                            : reached
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-muted-foreground/50"
                        }
                      >
                        {stalledHere ? "✗" : reached ? "✓" : watch.waiting ? "…" : "·"}
                      </span>
                      <span className={reached ? "" : "text-muted-foreground"}>
                        {TEST_STAGE_LABELS[step]}
                      </span>
                    </li>
                  )
                })}
              </ol>

              {watch.failure ? (
                <div className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-destructive">
                  <p className="text-sm font-medium">{watch.failure.title}</p>
                  <p className="mt-1 text-sm leading-relaxed">{watch.failure.action}</p>
                  <p className="mt-2 text-[11px] break-words opacity-70">{watch.failure.detail}</p>
                </div>
              ) : watch.waiting ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  Waiting — reply to the message on that handset to confirm the connection.
                </p>
              ) : watch.replied ? (
                <p className="mt-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
                  Confirmed end to end: the message went out and their reply came back.
                </p>
              ) : (
                /* Not a failure and not a success. Saying which is the whole
                   point — "delivered but nobody replied" is a working pipeline
                   and an unattended handset, and it must not read the same as
                   a message that never arrived. */
                <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                  Stopped watching after two minutes. It got as far as
                  {" "}&ldquo;{TEST_STAGE_LABELS[watch.stage]}&rdquo; and no reply arrived — send
                  another once someone is at that handset.
                </p>
              )}

              {watch.inactive && (
                /* A delivered test to a deactivated member proves the number
                   and proves nothing about their reminders — the materialiser
                   skips them entirely. */
                <p className="mt-2 text-xs text-muted-foreground">
                  {watch.displayName} is inactive, so real reminders will not be sent to them.
                </p>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={() => setWatch(null)} aria-label="Dismiss">
              <X />
            </Button>
          </div>
        </div>
      )}

      {testNotice && (
        <div className="rounded-xl border bg-card p-4 shadow-sm ring-1 ring-foreground/5">
          <div className="flex items-start gap-3">
            <p
              className={
                testNotice.tone === "sent"
                  ? "min-w-0 flex-1 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
                  : "min-w-0 flex-1 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
              }
            >
              {testNotice.text}
            </p>
            {/* Dismissible, like the calendar panel. It otherwise cleared only
                when some other action started, so a stale "Test sent to…" was
                still there on a later visit to the page. */}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss this message"
              onClick={() => setTestNotice(null)}
            >
              <X />
            </Button>
          </div>
        </div>
      )}

      {testTarget && (
        <TestMessagePanel
          target={testTarget}
          dryRun={dryRun}
          pending={pending}
          sending={sending}
          onSend={() => runTestSend(testTarget)}
          onDismiss={dismissOffer}
        />
      )}

      {draft && (
        <MemberForm
          value={draft}
          pending={pending}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() => saveMember(draft)}
        />
      )}

      <div className="rounded-xl border bg-background shadow-sm">
        {members.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-muted-foreground">
            No team members yet. Add one so imported clients have somebody to belong to.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {/* Email and Role fold away below `sm` rather than pushing the
                    table wider than a phone. Neither is lost: the role moves
                    under the name, and the email is one tap away in Edit. */}
                <TableHead className="w-[40%] pl-5 sm:w-[24%]">Name</TableHead>
                <TableHead className="w-[30%] sm:w-[20%]">WhatsApp</TableHead>
                <TableHead className="hidden sm:table-cell sm:w-[24%]">Email</TableHead>
                <TableHead className="hidden sm:table-cell sm:w-[10%]">Role</TableHead>
                <TableHead className="w-[20%] sm:w-[14%]">Calendar</TableHead>
                <TableHead className="w-[10%] pr-5 sm:w-[8%]">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <TableRow key={member.id} className={member.active ? undefined : "opacity-50"}>
                  <TableCell className="pl-5 font-medium">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {member.display_name}
                      {!member.active && (
                        <Badge variant="outline" className="text-muted-foreground">
                          inactive
                        </Badge>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground sm:hidden">
                      {member.role}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {member.whatsapp_number}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {member.email ?? "—"}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Badge variant={member.role === "owner" ? "secondary" : "ghost"}>
                      {member.role}
                    </Badge>
                  </TableCell>
                  {/* The calendar feed keeps its own column: it is the only
                      action here with a visible state — issued or not — and
                      burying that state in a menu means the answer to "does
                      this agent have a feed?" costs a click per row. */}
                  <TableCell>
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          const result = await issueCalendarFeed(member.id)
                          if (result.ok) {
                            setFreshUrl({ memberId: member.id, url: result.data })
                            router.refresh()
                          } else setError(result.error)
                        })
                      }
                    >
                      {feeds[member.id] ? (
                        <RotateCw data-icon="inline-start" />
                      ) : (
                        <CalendarPlus data-icon="inline-start" />
                      )}
                      {feeds[member.id] ? "Re-issue" : "Issue"}
                    </Button>
                  </TableCell>
                  <TableCell className="pr-5 text-right">
                    <RowActions
                      label={`Actions for ${member.display_name}`}
                      actions={[
                        {
                          label: "Edit details",
                          disabled: pending,
                          onSelect: () => {
                            setEditingId(member.id)
                            setDraft({
                              display_name: member.display_name,
                              email: member.email ?? "",
                              whatsapp_number: member.whatsapp_number,
                              role: member.role as "owner" | "agent",
                            })
                          },
                        },
                        {
                          // In the menu rather than a seventh column: unlike
                          // the calendar feed, a test send leaves no state to
                          // display, and the table already folds two columns
                          // away to fit a phone.
                          label: "Send test message",
                          disabled: pending,
                          onSelect: () => {
                            clearNotices()
                            setSending(false)
                            stageOffer({
                              id: member.id,
                              name: member.display_name,
                              number: member.whatsapp_number,
                              justAdded: false,
                            })
                          },
                        },
                        ...(feeds[member.id]
                          ? [
                              {
                                label: "Revoke calendar feed",
                                disabled: pending,
                                destructive: true,
                                onSelect: () => run(() => revokeCalendarFeed(member.id)),
                              },
                            ]
                          : []),
                        {
                          // Not destructive: deactivating is reversible, and
                          // marking it so made this one item change colour AND
                          // jump across the separator between an active and an
                          // inactive member — the same action moving around
                          // under the cursor row by row.
                          label: member.active ? "Deactivate" : "Reactivate",
                          disabled: pending,
                          onSelect: () => run(() => setTeamMemberActive(member.id, !member.active)),
                        },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

function MemberForm({
  value,
  pending,
  onChange,
  onSave,
  onCancel,
}: {
  value: MemberInput
  pending: boolean
  onChange: (next: MemberInput) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm ring-1 ring-foreground/5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name">
          <Input
            value={value.display_name}
            onChange={(e) => onChange({ ...value, display_name: e.target.value })}
            placeholder="Jasmine Tan"
          />
        </Field>
        <Field label="WhatsApp number" hint="Where their reminders arrive">
          <Input
            value={value.whatsapp_number}
            onChange={(e) => onChange({ ...value, whatsapp_number: e.target.value })}
            placeholder="+65 9123 4567"
          />
        </Field>
        <Field label="Email" hint="Optional — helps match imports">
          <Input
            value={value.email ?? ""}
            onChange={(e) => onChange({ ...value, email: e.target.value })}
            placeholder="jasmine@example.com"
          />
        </Field>
        <Field label="Role" hint="The owner receives unassigned reminders">
          <select
            value={value.role}
            onChange={(e) => onChange({ ...value, role: e.target.value as "owner" | "agent" })}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring"
          >
            <option value="agent">Agent</option>
            <option value="owner">Owner</option>
          </select>
        </Field>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Button onClick={onSave} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
