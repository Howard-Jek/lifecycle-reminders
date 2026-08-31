"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { PauseCircle, Clock, AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { describeAge, type SendingStatus } from "@/lib/lifecycle/sending-status"
import { formatDateTime } from "@/lib/format-time"
import { setAutoSend } from "@/app/actions/send-reminders"

/**
 * Whether anything is actually going to be sent — and the switch that decides.
 *
 * The inbox showed reminders at "Due" with no way to say whether a scheduler
 * would ever collect them. While one was always running that was merely a
 * missing detail; with both switched off it becomes a screen that reads exactly
 * like a healthy one — a queue of due work, and silence.
 *
 * THE SWITCH LIVES HERE rather than in Settings because this is where the
 * consequence is visible. Turning sending off is a decision about the queue
 * sitting directly below it, and a control three clicks away from the thing it
 * governs is one whose effect nobody checks.
 *
 * TONE IS PROPORTIONATE, deliberately. Sending is often off on purpose, and a
 * red alarm on a state the operator chose is noise that teaches them to ignore
 * the banner. The loud version is reserved for the two genuinely misleading
 * cases: off with work sitting at Due, and — louder — switched ON while nothing
 * is running, where the operator believes messages are going out and they are
 * not. Off with an empty queue is a quiet statement of fact.
 */
export function SendingStatusBanner({
  status,
  dueCount,
  nextDueAt,
  timezone,
}: {
  status: SendingStatus
  /** Reminders past their send time. -1 when the count itself failed. */
  dueCount: number
  /** Earliest queued send time, or null when the queue is empty. */
  nextDueAt: string | null
  timezone: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const toggle = (next: boolean) => {
    setError(null)
    startTransition(async () => {
      const result = await setAutoSend(next)
      if (result.ok) router.refresh()
      else setError(result.error)
    })
  }

  const countUnknown = dueCount < 0

  // ── On and working. One quiet line: "it is working" does not need a banner,
  //    it needs to be checkable — and reachable, hence the switch. ──────────
  if (status.state === "live") {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Clock className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
        <span>
          Sending is on — last run{" "}
          <span className="tabular-nums">{describeAge(status.minutesSince ?? 0)}</span>
        </span>
        {nextDueAt && (
          <>
            <span aria-hidden>·</span>
            <span>
              next due <span className="tabular-nums">{formatDateTime(nextDueAt, timezone)}</span>
            </span>
          </>
        )}
        <AutoSendToggle enabled pending={pending} onToggle={toggle} />
        {error && <span className="text-destructive">{error}</span>}
      </div>
    )
  }

  // ── Switched on, nothing running. The one state worth alarming about. ────
  if (status.state === "stalled") {
    return (
      <Banner
        tone="loud"
        icon={<AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />}
        title="Sending is on, but nothing is running"
        body={
          status.neverRun ? (
            <>
              The engine has no record of ever running. Automatic sending is switched on, so
              nothing here is waiting on you — the scheduler itself is not reaching the app.
            </>
          ) : (
            <>
              The last cycle was{" "}
              <span className="tabular-nums">{describeAge(status.minutesSince ?? 0)}</span>, which
              is long enough to mean the scheduler has stopped. GitHub disables scheduled workflows
              in dormant repositories without any notice, which is the usual cause.
            </>
          )
        }
        footer={
          status.neverRun ? undefined : `Last run ${describeAge(status.minutesSince ?? 0)}.`
        }
        action={<AutoSendToggle enabled pending={pending} onToggle={toggle} />}
        error={error}
      />
    )
  }

  // ── Off. Loud only when the screen would otherwise imply something is
  //    about to happen. ────────────────────────────────────────────────────
  const misleading = dueCount > 0 || countUnknown
  return (
    <Banner
      tone={misleading ? "loud" : "quiet"}
      icon={
        <PauseCircle
          className={cn(
            "mt-0.5 size-4 shrink-0",
            misleading ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
          )}
          strokeWidth={2}
        />
      }
      title="Automatic sending is off"
      body={
        countUnknown ? (
          <>Nothing is being delivered. The number waiting could not be counted.</>
        ) : misleading ? (
          <>
            <span className="tabular-nums">{dueCount}</span>{" "}
            {dueCount === 1 ? "reminder is" : "reminders are"} past their send time and will stay
            here until it is switched back on. You can still send them yourself.
          </>
        ) : (
          <>Nothing is queued, and nothing would be sent if it were.</>
        )
      }
      footer={
        // "Off" invites "since when?", and the answer is the difference between
        // a deliberate pause and a scheduler that died unnoticed.
        status.neverRun
          ? "The engine has no record of ever running."
          : `Last run ${describeAge(status.minutesSince ?? 0)}.`
      }
      action={<AutoSendToggle enabled={false} pending={pending} onToggle={toggle} />}
      error={error}
    />
  )
}

function Banner({
  tone,
  icon,
  title,
  body,
  footer,
  action,
  error,
}: {
  tone: "loud" | "quiet"
  icon: React.ReactNode
  title: string
  body: React.ReactNode
  footer?: string
  action: React.ReactNode
  error: string | null
}) {
  const loud = tone === "loud"
  return (
    <div
      role="status"
      className={cn(
        /**
         * COLUMN on a phone, row from `sm`.
         *
         * It was `flex flex-wrap` with a `shrink-0` action, which at 375px let
         * the action keep its full width and squeeze the `min-w-0` prose beside
         * it to about five characters — the title broke to one word per line
         * and the confirm text landed on top of it. flex-wrap did not save it:
         * a min-w-0 child is always "fitting", so the row never wrapped.
         */
        "flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-start",
        loud ? "border-amber-500/20 bg-amber-500/10" : "border-foreground/10 bg-muted/50",
      )}
    >
      <span className="hidden sm:inline" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-sm font-medium",
            loud ? "text-amber-800 dark:text-amber-300" : "text-foreground",
          )}
        >
          {title}
        </p>
        <p
          className={cn(
            "mt-0.5 text-sm",
            loud ? "text-amber-800/90 dark:text-amber-300/90" : "text-muted-foreground",
          )}
        >
          {body}
        </p>
        {footer && <p className="mt-1 text-xs text-muted-foreground">{footer}</p>}
        {error && (
          <p className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      {/* Its own full-width line on a phone; beside the prose from `sm`. */}
      <div className="shrink-0">{action}</div>
    </div>
  )
}

/**
 * The switch itself.
 *
 * Turning OFF is a plain button: it costs nothing and stopping should never be
 * the harder direction.
 *
 * Turning ON opens a DIALOG, matching Clear and Send all — the three controls
 * on this page with a consequence worth stating. It is also the only one whose
 * consequence is unattended: every other button spends money once, when
 * pressed, while this one hands that decision to a timer. The first version
 * confirmed inline in the banner and it was the wrong shape twice over — it
 * crushed the layout at 375px, and it made the highest-consequence control the
 * lightest-weight one on the screen.
 */
function AutoSendToggle({
  enabled,
  pending,
  onToggle,
}: {
  enabled: boolean
  pending: boolean
  onToggle: (next: boolean) => void
}) {
  const [open, setOpen] = useState(false)

  if (enabled) {
    return (
      <Button variant="outline" size="xs" disabled={pending} onClick={() => onToggle(false)}>
        {pending ? "Turning off…" : "Turn off"}
      </Button>
    )
  }

  return (
    <>
      <Button variant="outline" size="xs" disabled={pending} onClick={() => setOpen(true)}>
        {pending ? "Turning on…" : "Turn on"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent role="alertdialog" className="w-[calc(100%-2rem)] max-w-md">
          <DialogTitle className="text-lg font-bold tracking-tight">
            Turn on automatic sending?
          </DialogTitle>
          <DialogDescription className="mt-2 leading-relaxed">
            Reminders will then go out on their own, without anyone pressing anything — the engine
            checks every 15 minutes and delivers whatever has reached its send time.{" "}
            <strong>Each one is a billed WhatsApp message.</strong> Nothing is sent to a
            deactivated agent, and you can switch this off again at any time.
          </DialogDescription>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            {/* autoFocus on Cancel: the focused control at open must not be the
                one that starts unattended spending. */}
            <Button variant="outline" autoFocus onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                setOpen(false)
                onToggle(true)
              }}
            >
              Turn on sending
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
