"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { deleteReminder, clearReminders } from "@/app/actions/reminders"
import type { ReminderScope } from "@/lib/lifecycle/reminder-filters"

/**
 * Removing reminders from the inbox.
 *
 * Two shapes for two weights of decision, and the difference is deliberate.
 *
 * ONE row confirms in place, the same swap the contact dates list uses: the
 * decision is small, the target is right there under the cursor, and a modal
 * for it would be ceremony. Consistency matters more than novelty here — an
 * operator who has removed a date already knows what this does.
 *
 * A WHOLE TAB gets a real dialog. It removes rows that are scrolled out of
 * view, so the count has to be stated rather than seen, and a mis-click on a
 * bare button would be unrecoverable.
 */

export function DeleteReminderButton({ id }: { id: string }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // The error lives OUTSIDE the confirming branch. It used to be rendered
  // inside it, while the failure path also closed that branch — so a failed
  // delete unmounted its own error message and the row simply stayed put with
  // no explanation. events-client.tsx keeps its error at section level for the
  // same reason.
  const errorNote = error ? (
    <span className="text-xs text-destructive">{error}</span>
  ) : null

  if (!confirming) {
    return (
      <span className="inline-flex items-center gap-2">
        {errorNote}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Remove this reminder"
          disabled={pending}
          onClick={() => {
            setError(null)
            setConfirming(true)
          }}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 />
        </Button>
      </span>
    )
  }

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1">
      <span className="text-xs text-muted-foreground">Remove?</span>
      {/* Keep first: on a phone the rightmost control is the easy thumb
          position, and the easy position should not be the destructive one. */}
      <Button
        variant="ghost"
        size="xs"
        disabled={pending}
        autoFocus
        onClick={() => setConfirming(false)}
      >
        Keep
      </Button>
      <Button
        variant="destructive"
        size="xs"
        disabled={pending}
        onClick={() =>
          start(async () => {
            // Never let a transport failure take the page down with it: an
            // unhandled rejection in a transition replaces the whole inbox
            // with an error screen.
            try {
              const result = await deleteReminder(id)
              if (!result.ok) {
                setError(result.error)
                setConfirming(false)
                return
              }
              router.refresh()
            } catch {
              setError("Could not reach the server. Nothing was removed.")
              setConfirming(false)
            }
          })
        }
      >
        {pending ? "Removing…" : "Remove"}
      </Button>
    </span>
  )
}

export function ClearTabButton({
  scope,
  count,
  label,
  paused,
  maxOverdueDays,
}: {
  scope: ReminderScope
  /** What the tab is showing. The dialog states it because the rows are not all on screen. */
  count: number
  /** "Due · Renewals · yours" — every active narrowing, not just the tab. */
  label: string
  /** True when no scheduler is running, so "the next run" is not a real promise. */
  paused: boolean
  /** plan-reminders' MAX_OVERDUE_DAYS — past this, nothing is ever rebuilt. */
  maxOverdueDays: number
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [removed, setRemoved] = useState<number | null>(null)

  if (count <= 0) {
    // The outcome outlives the dialog: the button disappears once the tab is
    // empty, so without this the operator sees rows vanish and is told nothing.
    return removed === null ? null : (
      <span className="text-xs text-muted-foreground">
        Cleared <span className="tabular-nums">{removed}</span>
      </span>
    )
  }

  // Sent rows are the record of what went out and are never rebuilt.
  const losesHistory = scope.tab === "sent"

  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setOpen(true)}
        className="text-muted-foreground hover:text-destructive"
      >
        <Trash2 data-icon="inline-start" />
        Clear
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        {/* w-[calc(100%-2rem)] because DialogContent is `w-full max-w-lg` with
            no margin — at 375px it otherwise sits edge to edge. */}
        <DialogContent role="alertdialog" className="w-[calc(100%-2rem)] max-w-md">
          <DialogTitle className="text-lg font-bold tracking-tight">
            Clear {count} {count === 1 ? "reminder" : "reminders"}?
          </DialogTitle>
          <DialogDescription className="mt-2 leading-relaxed">
            {losesHistory ? (
              <>
                This removes the record that {count === 1 ? "this message" : "these messages"} went
                out. Sent reminders are history and are <strong>not</strong> rebuilt — once
                cleared, there is nothing to show they were delivered.
              </>
            ) : (
              <>
                {/* The honest version of what used to say "a reset, not a
                    loss". The engine only rematerialises a reminder while it is
                    within MAX_OVERDUE_DAYS of its send time — so on a backlog,
                    which is the whole reason this button exists, most of what
                    is cleared never comes back. Promising recovery there was a
                    claim about the engine that the engine does not honour. */}
                This clears everything in <strong>{label}</strong>. Reminders less than{" "}
                {maxOverdueDays} days past their send time are rebuilt from your contacts and
                rules{paused ? " once sending is switched back on" : " on the next run"}. Anything
                older than that is <strong>gone for good</strong>.
              </>
            )}
          </DialogDescription>

          {error && (
            <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-2">
            {/* Cancel first AND focused. The destructive button used to hold
                default focus, so a stray Space or Enter on an opened dialog
                deleted every row in the tab. */}
            <Button variant="ghost" disabled={pending} autoFocus onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  try {
                    const result = await clearReminders(scope)
                    if (!result.ok) {
                      setError(result.error)
                      return
                    }
                    // Meta's own number, not the one on the button: the button
                    // counts what the tab shows, and the action skips rows a
                    // worker has claimed since. Reporting the button's figure
                    // would overstate what happened.
                    setRemoved(result.data.removed)
                    setOpen(false)
                    router.refresh()
                  } catch {
                    setError("Could not reach the server. Nothing was removed.")
                  }
                })
              }
            >
              {pending ? "Clearing…" : `Clear ${count}`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
