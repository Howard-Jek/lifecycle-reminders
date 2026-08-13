"use client"

import { useCallback, useRef, useState } from "react"
import { CalendarClock, MessageSquare, ScanSearch, ListChecks } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useLocalFlag } from "@/lib/use-local-flag"

const SEEN_KEY = "lifecycle.tour.seen.v1"

/**
 * Four panels shown once, on the first visit to a signed-in page.
 *
 * The tour teaches the *model*, not the interface — where each button lives is
 * discoverable, but two of the product's rules are not, and an operator who
 * has not been told them will misread everything else:
 *
 *   1. the reminder goes to the AGENT, never to the client;
 *   2. nothing is guessed — an unmatched agent stops and asks.
 *
 * Both are refusals rather than features, so no amount of clicking around
 * reveals them. Hence a tour. The fourth panel says where to start, which is
 * about the order the work has to happen in, not about the interface — nothing
 * here explains a button, because buttons explain themselves.
 */

type Panel = {
  icon: LucideIcon
  eyebrow: string
  title: string
  body: string
}

const PANELS: Panel[] = [
  {
    icon: CalendarClock,
    eyebrow: "What it does",
    title: "The dates are already in your spreadsheet.",
    body:
      "Import the book you already keep. Lifecycle reads the birthdays, policy expiries and " +
      "review dates out of it and works out which ones are close enough to be worth a " +
      "conversation — this week, and every week after.",
  },
  {
    icon: MessageSquare,
    eyebrow: "Who gets the message",
    title: "Your agent is told. Your client is not.",
    body:
      "This is the part most people assume works the other way round. Nothing is ever sent to " +
      "a client automatically. The reminder goes by WhatsApp to the agent who owns that " +
      "relationship, with a suggested opener they can edit, ignore, or send as-is themselves.",
  },
  {
    icon: ScanSearch,
    eyebrow: "What it refuses to do",
    title: "It stops rather than guesses.",
    body:
      "An agent name that matches nobody — or matches two people — goes to a review queue with " +
      "the original row attached, rather than being filed somewhere plausible. A date that could " +
      "be read two ways is brought to you before the import, not after. A client filed to the " +
      "wrong agent means the wrong person is reminded and the right one never is.",
  },
  {
    icon: ListChecks,
    eyebrow: "Where to start",
    title: "Four things, in this order.",
    body:
      "Your team first, because a reminder has to belong to somebody. Then your contacts and " +
      "their dates. Then the rules that say how far ahead you want telling. WhatsApp last — " +
      "it is the only step with a queue in front of it, so start it before you need it.",
  },
]

export function WelcomeTour() {
  // `seen` defaults to true on the server, so the dialog is closed in the
  // server HTML and never flashes for a returning operator.
  const [seen, setSeen] = useLocalFlag(SEEN_KEY, true)
  // The second condition is not redundant. Deriving `open` from storage alone
  // means a storage write that fails — quota exceeded, site data blocked —
  // leaves `seen` false after every dismissal, and because this dialog is modal
  // and traps focus, the app becomes unusable with no way out. This flag closes
  // it for the session regardless; losing the persistence is a nuisance, being
  // unable to close it is not.
  const [dismissed, setDismissed] = useState(false)
  const [index, setIndex] = useState(0)
  /** The forward button — where focus should start. See `initialFocus` below. */
  const advanceRef = useRef<HTMLButtonElement>(null)

  const close = useCallback(() => {
    setDismissed(true)
    setSeen(true)
  }, [setSeen])

  const panel = PANELS[index]
  const last = index === PANELS.length - 1
  const Icon = panel.icon

  return (
    <Dialog
      open={!seen && !dismissed}
      onOpenChange={(next) => {
        // Escape and backdrop count as "seen". Making the tour reappear after
        // somebody has deliberately closed it is the single most irritating
        // thing an onboarding flow can do.
        if (!next) close()
      }}
    >
      {/* `data-allow-overlap` is set here rather than on the shared
          DialogContent: that file is copied byte-for-byte from the host app,
          and editing it to satisfy a tool would fork the design system. A modal
          sitting over the page it covers is the most intentional overlap there
          is.

          `initialFocus` because the default — first tabbable element — lands on
          Skip, which sits left of Next in the visual order. Opening a welcome
          tour with the keyboard already resting on "dismiss this" is a nudge in
          precisely the wrong direction.

          The sizing classes are all here for the same reason: the shared
          DialogContent is `w-full max-w-lg` with no margin and no max height,
          and this is the app's only dialog, so it is the only place that shows.
          Without the width calc the panel is flush to both bezels at 375px and
          its rounded corners read as a rendering fault; without the max height
          a taller panel would push its own footer off both ends of the screen
          with no way to scroll to it.

          `min-h` because the panels differ in height: without it the forward
          button moves down the screen on every click, so a four-click flow
          needs four re-aims. Wrapped in `min()` rather than guarded with `sm:`
          so it also holds on a phone — but never wins against `max-h`, which
          would push the footer off a short viewport. 28rem rather than 26rem
          because the tallest panel plus the stacked mobile controls comes to
          just over 26rem, and a floor the tallest panel clears is the whole
          point of having one. */}
      <DialogContent
        data-allow-overlap
        initialFocus={advanceRef}
        className="flex max-h-[calc(100dvh-2rem)] min-h-[min(28rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-xl flex-col overflow-y-auto"
      >
        <div className="flex size-9 items-center justify-center rounded-lg bg-brand/10">
          <Icon className="size-4.5 text-brand-ink" strokeWidth={1.75} aria-hidden />
        </div>

        <p className="mt-4 text-[0.7rem] font-medium tracking-[0.14em] text-brand-ink uppercase">
          {panel.eyebrow}
        </p>
        <DialogTitle className="mt-2 text-xl leading-snug font-bold tracking-tight text-balance">
          {panel.title}
        </DialogTitle>
        <DialogDescription className="mt-3 leading-relaxed">{panel.body}</DialogDescription>

        {/* `mt-auto` pins the controls to the bottom of the fixed-height panel
            rather than letting them float up under short copy.

            Below `sm` the dots take their own line rather than sharing one with
            the buttons. On a phone the dots plus Back, Skip and Next are wider
            than the dialog, and this row sits inside an `overflow-y-auto` box —
            which makes `overflow-x` compute to `auto` too, so the excess is
            clipped rather than merely tight, and the primary button was being
            sliced in half. Letting the row `flex-wrap` fixed the clipping but
            made the buttons jump 70px sideways between panels as the row wrapped
            and unwrapped; giving them a line of their own is stable at every
            width. */}
        <div className="mt-auto flex flex-col gap-3 pt-7 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          {/* Progress as dots, not "3 of 4": at four panels the dots are read
              at a glance and the numerals are read as a chore. */}
          <div className="flex items-center gap-1.5" role="presentation">
            {PANELS.map((p, i) => (
              <span
                key={p.title}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  i === index ? "w-5 bg-brand" : "w-1.5 bg-foreground/15",
                )}
              />
            ))}
            <span className="sr-only">
              Step {index + 1} of {PANELS.length}
            </span>
          </div>

          <div className="flex items-center justify-end gap-2">
            {index > 0 && (
              <Button variant="ghost" onClick={() => setIndex((i) => i - 1)}>
                Back
              </Button>
            )}
            {/* Unmounted on the last panel, not merely hidden. Keeping it in
                the layout to stop the forward button shifting was solving a
                problem that did not exist — this row is right-aligned, so the
                forward button's right edge is pinned regardless — while
                creating a real one: the reserved 70px pushed the row wider than
                the dialog's content box at 375px, and "Get started", the last
                thing the wizard asks anybody to press, was clipped by the
                dialog's own overflow with its rightmost pixels not even
                hit-testable. */}
            {!last && (
              <Button variant="ghost" onClick={close}>
                Skip
              </Button>
            )}
            <Button ref={advanceRef} onClick={() => (last ? close() : setIndex((i) => i + 1))}>
              {last ? "Get started" : "Next"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Re-open the tour on demand, from the account menu.
 *
 * Navigates rather than just clearing the flag: this is called from the account
 * menu, which is in the shell and therefore on every page, but the tour is only
 * mounted on `/reminders`. Clearing the flag while sitting on `/contacts` would
 * appear to do nothing at all.
 */
export function useReplayTour() {
  return useCallback(() => {
    try {
      window.localStorage.removeItem(SEEN_KEY)
    } catch {
      // Storage unavailable — the navigation below still shows the tour, since
      // an unreadable flag reads as "not seen".
    }
    window.location.assign("/reminders")
  }, [])
}
