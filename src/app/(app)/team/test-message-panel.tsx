"use client"

import { useEffect, useRef } from "react"
import { Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The one place a message leaves this app on purpose.
 *
 * DELIBERATELY A CONFIRMATION, not a one-click send. Every other button on the
 * Team page changes a database row; this one puts a real WhatsApp message on a
 * colleague's handset and is billed by Meta for doing so. The operator has said
 * plainly that per-message cost is the reason automatic sending is switched
 * off, so a control that can spend money from a stray click on a dropdown item
 * would be the wrong shape regardless of how convenient it reads.
 *
 * Both routes in — "member added" and the row menu — land here, so there is one
 * surface to get right and one place the cost is stated.
 */

export type TestTarget = {
  id: string
  name: string
  number: string
  /** Came straight from Add member, which changes the headline: the offer is
   * the natural next step rather than something the operator went looking for. */
  justAdded: boolean
}

export function TestMessagePanel({
  target,
  dryRun,
  pending,
  sending,
  onSend,
  onDismiss,
}: {
  target: TestTarget
  dryRun: boolean
  /** Any action on the page is in flight — what the controls are disabled on. */
  pending: boolean
  /** THIS send is in flight — what the label describes. Kept apart because a
   * button that says "Sending…" during somebody else's action is lying. */
  sending: boolean
  onSend: () => void
  onDismiss: () => void
}) {
  const panel = useRef<HTMLDivElement>(null)

  /**
   * Move focus here, because both entry points leave it somewhere useless: Save
   * unmounts with the form, and the row menu restores focus to its own ⋯
   * trigger — which sits BELOW this panel, so Tab walks away from the thing
   * that just appeared rather than into it.
   *
   * Retried rather than done once. The menu restores focus asynchronously on
   * close and beat two animation frames when this was measured, leaving the
   * panel unfocused and its Escape handler unreachable.
   *
   * The parked check is what makes retrying safe: focus is only taken from
   * nothing, from the document body, or from the menu trigger that opened this.
   * If the operator has deliberately focused something in the meantime, a timer
   * firing 300ms later must not yank it back.
   */
  useEffect(() => {
    const attempt = () => {
      const el = panel.current
      if (!el) return
      const active = document.activeElement
      if (active && el.contains(active)) return
      const parked =
        !active || active === document.body || active.getAttribute("aria-haspopup") === "menu"
      if (parked) el.focus()
    }
    const timers = [0, 60, 160, 320].map((ms) => window.setTimeout(attempt, ms))
    return () => timers.forEach(clearTimeout)
  }, [target.id])

  /**
   * Escape dismisses from anywhere, not only from inside the panel.
   *
   * The panel-scoped alternative would depend on focus being in here, which is
   * not guaranteed — see above — and an offer the operator cannot wave away is
   * worse than one that is slightly eager to close.
   *
   * Two things it must not swallow: a menu's own Escape, and Escape pressed
   * while typing in the Add-member form, which sits directly below this panel.
   * Without the field check, correcting a name and hitting Escape silently
   * dismissed an offer that may have scrolled out of view.
   */
  useEffect(() => {
    if (pending) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      if (document.querySelector('[role="menu"]')) return
      const active = document.activeElement
      if (active instanceof HTMLElement && active.closest("input, textarea, select")) return
      onDismiss()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [pending, onDismiss])

  return (
    <div
      ref={panel}
      tabIndex={-1}
      role="group"
      aria-label={`Send a test message to ${target.name}`}
      className="rounded-xl border bg-card p-4 shadow-sm ring-1 ring-brand/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {/* max-w-2xl on BOTH paragraphs. Without it here the headline ran the
          full width of the card while the body stopped less than halfway, so
          the two never shared a right edge — most visible with a long name. */}
      <p className="max-w-2xl text-sm font-medium">
        {target.justAdded
          ? `${target.name} added. Send them a test message?`
          : `Send a test message to ${target.name}?`}
      </p>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Saving a number only proves it is shaped like one — this is what proves it receives.
      </p>

      {/**
       * THE COST LINE IS ALWAYS PRESENT, and it is the LIVE state that wears
       * the caution colour.
       *
       * It used to be the other way round: an amber wash appeared only in dry
       * run, where nothing is billed, and vanished in the state where every
       * click spends money — leaving the panel at its quietest exactly when it
       * had the most to warn about. The only cost statement there was a clause
       * in muted grey.
       *
       * This is also what distinguishes this panel from the calendar-link panel
       * above it, which is otherwise the same card and carries no consequence.
       */}
      <p
        className={cn(
          "mt-3 max-w-2xl rounded-lg px-3 py-2 text-xs",
          dryRun
            ? "bg-muted text-muted-foreground"
            : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        )}
      >
        {dryRun ? (
          <>
            <code className="font-mono">REMINDER_DRY_RUN</code> is on, so nothing will be sent and
            nothing will be billed. The message is built and written to the server log instead —
            everything except the call to Meta still runs.
          </>
        ) : (
          <>
            This sends <span className="font-medium">one real message</span> to{" "}
            <span className="font-mono tabular-nums">{target.number}</span>, and Meta bills for it
            like any other.
          </>
        )}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={onSend} disabled={pending}>
          <Send data-icon="inline-start" />
          {sending ? "Sending…" : dryRun ? "Run the send (dry run)" : "Send test message"}
        </Button>
        {/* outline, not ghost: a borderless control beside a filled black one
            reads as plain text until hover, and the way out of a spend should
            not be the least visible thing in the panel. */}
        <Button variant="outline" onClick={onDismiss} disabled={pending}>
          Not now
        </Button>
      </div>
    </div>
  )
}
