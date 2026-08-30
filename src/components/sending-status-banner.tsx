import { PauseCircle, Clock } from "lucide-react"
import { cn } from "@/lib/utils"
import { describeAge, type SendingStatus } from "@/lib/lifecycle/sending-status"
import { formatDateTime } from "@/lib/format-time"

/**
 * Whether anything is actually going to be sent.
 *
 * The inbox showed reminders at "Due" with no way to say whether a scheduler
 * would ever collect them. While one was always running that was merely a
 * missing detail; with both switched off it becomes a screen that reads exactly
 * like a healthy one — a queue of due work, and silence.
 *
 * TONE IS PROPORTIONATE, deliberately. Sending is often off on purpose, and a
 * red alarm on a state the operator chose is noise that teaches them to ignore
 * the banner. The loud version is reserved for the genuinely misleading case:
 * sending is off AND there is work sitting at Due, so the screen is implying
 * something is about to happen. Off with an empty queue is a quiet statement of
 * fact.
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
  const paused = status.state === "paused" || status.state === "never"

  if (!paused) {
    // Running. One quiet line, because "it is working" does not need a banner —
    // it needs to be checkable.
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
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
      </div>
    )
  }

  const countUnknown = dueCount < 0
  const misleading = dueCount > 0 || countUnknown

  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-xl border px-4 py-3",
        misleading
          ? "border-amber-500/20 bg-amber-500/10"
          : "border-foreground/10 bg-muted/50",
      )}
    >
      <PauseCircle
        className={cn(
          "mt-0.5 size-4 shrink-0",
          misleading ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
        )}
        strokeWidth={2}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-sm font-medium",
            misleading ? "text-amber-800 dark:text-amber-300" : "text-foreground",
          )}
        >
          {/* "Off" implies it was once on. A deployment that has never run has
              not been switched off; it has never been switched on, and those
              are different things to go and check. */}
          {status.state === "never" ? "Sending has never run" : "Automatic sending is off"}
        </p>
        <p
          className={cn(
            "mt-0.5 text-sm",
            misleading ? "text-amber-800/90 dark:text-amber-300/90" : "text-muted-foreground",
          )}
        >
          {countUnknown ? (
            <>Nothing is being delivered. The number waiting could not be counted.</>
          ) : misleading ? (
            <>
              <span className="tabular-nums">{dueCount}</span>{" "}
              {dueCount === 1 ? "reminder is" : "reminders are"} past their send time and will
              stay here until it is switched back on. Nothing is being delivered.
            </>
          ) : (
            <>Nothing is queued, and nothing would be sent if it were.</>
          )}
        </p>
        {/* The last-run fact, because "off" invites "since when?" and the
            answer is the difference between a deliberate pause and a scheduler
            that died unnoticed. */}
        <p className="mt-1 text-xs text-muted-foreground">
          {status.state === "never"
            ? "The engine has no record of ever running."
            : `Last run ${describeAge(status.minutesSince ?? 0)}.`}
        </p>
      </div>
    </div>
  )
}
