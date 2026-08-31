"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { sendReminderNow, sendScopeNow, type SendOutcome } from "@/app/actions/send-reminders"
import type { ReminderScope } from "@/lib/lifecycle/reminder-filters"

/**
 * Sending by hand, from the inbox.
 *
 * Mirrors the two shapes reminder-actions.tsx already uses, because these are
 * the same two weights of decision wearing a different verb: ONE row confirms
 * in place, a WHOLE TAB gets a dialog that states the count, because the rows
 * it will send are scrolled out of view.
 *
 * Every one of these costs a billed message, so the confirming step is not
 * ceremony — it is the only thing between a stray click and a charge. It is
 * also why nothing here is a filled primary button at rest: the loudest control
 * on the screen should not be the one that spends money.
 */

/** Shared phrasing, so a single send and a bulk send never describe the same
 * outcome two different ways. */
function describeOutcome(o: SendOutcome): { text: string; tone: "good" | "warn" } {
  const parts: string[] = []
  if (o.sent > 0) parts.push(`Sent ${o.sent}`)
  if (o.failed > 0) parts.push(`${o.failed} failed`)
  if (o.heldInactive > 0) {
    parts.push(
      `${o.heldInactive} held — ${o.heldInactive === 1 ? "that agent is" : "those agents are"} deactivated`,
    )
  }
  if (o.remaining > 0) parts.push(`${o.remaining} still queued, press again`)

  if (parts.length === 0) return { text: "Nothing was sent.", tone: "warn" }
  return {
    text: parts.join(" · "),
    tone: o.sent > 0 && o.failed === 0 ? "good" : "warn",
  }
}

export function SendReminderButton({ id, disabled }: { id: string; disabled?: boolean }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [pending, start] = useTransition()
  const [note, setNote] = useState<{ text: string; tone: "good" | "warn" } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Outside the confirming branch, for the reason DeleteReminderButton
  // documents: the failure path closes that branch, so an error rendered inside
  // it would unmount itself and the row would sit there unexplained.
  const feedback = error ? (
    <span className="text-xs text-destructive">{error}</span>
  ) : note ? (
    <span
      className={
        note.tone === "good"
          ? "text-xs text-emerald-700 dark:text-emerald-400"
          : "text-xs text-amber-700 dark:text-amber-400"
      }
    >
      {note.text}
    </span>
  ) : null

  if (!confirming) {
    return (
      <span className="inline-flex items-center gap-2">
        {feedback}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Send this reminder now"
          disabled={pending || disabled}
          onClick={() => {
            setError(null)
            setNote(null)
            setConfirming(true)
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          <Send />
        </Button>
      </span>
    )
  }

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1">
      <span className="text-xs text-muted-foreground">Send now?</span>
      {/* Cancel first: on a phone the rightmost control is the easy thumb
          position, and the easy position should not be the one that spends. */}
      <Button variant="ghost" size="xs" disabled={pending} onClick={() => setConfirming(false)}>
        Cancel
      </Button>
      <Button
        size="xs"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await sendReminderNow(id)
            setConfirming(false)
            if (result.ok) {
              setNote(describeOutcome(result.data))
              router.refresh()
            } else setError(result.error)
          })
        }
      >
        {pending ? "Sending…" : "Send"}
      </Button>
    </span>
  )
}

export function SendTabButton({
  scope,
  count,
  label,
  maxPerClick,
}: {
  scope: ReminderScope
  /** What the tab is showing. Stated in the dialog because the rows are not all on screen. */
  count: number
  /** "Needs attention · Renewals · yours" — every active narrowing, not just the tab. */
  label: string
  /** The server's per-click ceiling, so the dialog can promise what it delivers. */
  maxPerClick: number
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; tone: "good" | "warn" } | null>(null)

  if (count <= 0) {
    // The outcome outlives the dialog: the button disappears once the tab is
    // empty, so without this the operator sees rows move and is told nothing.
    return note === null ? null : (
      <span
        className={
          note.tone === "good"
            ? "text-xs text-emerald-700 dark:text-emerald-400"
            : "text-xs text-amber-700 dark:text-amber-400"
        }
      >
        {note.text}
      </span>
    )
  }

  const batch = Math.min(count, maxPerClick)

  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setOpen(true)}
        className="text-muted-foreground hover:text-foreground"
      >
        <Send data-icon="inline-start" />
        Send all
      </Button>
      {note && (
        <span
          className={
            note.tone === "good"
              ? "text-xs text-emerald-700 dark:text-emerald-400"
              : "text-xs text-amber-700 dark:text-amber-400"
          }
        >
          {note.text}
        </span>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        {/* w-[calc(100%-2rem)] because DialogContent is `w-full max-w-lg` with
            no margin — at 375px it otherwise sits edge to edge. */}
        <DialogContent role="alertdialog" className="w-[calc(100%-2rem)] max-w-md">
          <DialogTitle className="text-lg font-bold tracking-tight">
            Send {batch} {batch === 1 ? "reminder" : "reminders"} now?
          </DialogTitle>
          <DialogDescription className="mt-2 leading-relaxed">
            This sends everything in <strong>{label}</strong> to the agents it is addressed to.{" "}
            <strong>
              {batch} real WhatsApp {batch === 1 ? "message" : "messages"}
            </strong>
            , each billed by Meta, and each drafted by the model first.
            {count > maxPerClick && (
              <>
                {" "}
                Only {maxPerClick} go per press so the page does not hang — the remaining{" "}
                {count - maxPerClick} stay queued and you can press again.
              </>
            )}{" "}
            Reminders addressed to a deactivated agent are held back rather than sent, because they
            would reach nobody.
          </DialogDescription>

          {error && (
            <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm break-words text-destructive">
              {error}
            </p>
          )}

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            {/* autoFocus on Cancel: the focused control at open must not be the
                one that spends money. */}
            <Button variant="outline" autoFocus disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const result = await sendScopeNow(scope)
                  if (result.ok) {
                    setNote(describeOutcome(result.data))
                    setOpen(false)
                    router.refresh()
                  } else setError(result.error)
                })
              }
            >
              <Send data-icon="inline-start" />
              {pending ? "Sending…" : `Send ${batch}`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
