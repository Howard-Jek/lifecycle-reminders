"use client"

import { useState } from "react"
import Link from "next/link"
import { Check, ChevronDown, Clock } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  describeSetup,
  isSetupComplete,
  CHECKLIST_COLLAPSED_COOKIE,
  type SetupStep,
} from "@/lib/onboarding/steps"

/**
 * What is left to set up, on the page the operator lands on.
 *
 * Not dismissible, and it does not need to be: it disappears on its own the
 * moment no step is asking anything of the operator. A checklist you can
 * dismiss while the work is unfinished is one that hides the reason nothing is
 * sending — which is the exact failure this is here to prevent.
 *
 * It can be COLLAPSED, which is a different promise: the work is still there,
 * it is just not taking up the top of the screen while you read the queue.
 *
 * That collapsed state rides in a cookie rather than localStorage, and the
 * difference is visible. localStorage cannot be read while rendering on the
 * server, so the first paint is always the expanded list and it snaps shut
 * after hydration — an ~800px jump on the page an operator opens every morning,
 * which is the opposite of the calm this product is trying to project. A cookie
 * is on the request, so the server renders the state the operator actually left
 * it in.
 */
export function SetupChecklist({
  steps,
  defaultCollapsed,
}: {
  steps: SetupStep[]
  defaultCollapsed: boolean
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  if (isSetupComplete(steps)) return null

  function toggle() {
    const next = !collapsed
    setCollapsed(next)
    // Session cookie, SameSite=Lax: it is a display preference, so it should
    // not outlive the browser and has no business travelling cross-site.
    document.cookie = `${CHECKLIST_COLLAPSED_COOKIE}=${next ? "1" : "0"}; path=/; SameSite=Lax`
  }

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm ring-1 ring-foreground/5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Finish setting up</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {collapsed
              ? describeSetup(steps)
              : "Four things, in this order. Each one is what the next depends on."}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {/* Only when expanded: collapsed, `describeSetup` already gives the
              number, and the two count in opposite directions — "1 of 4 steps
              left" beside "3/4" is the same fact told twice, backwards. */}
          {!collapsed && (
            <span className="text-sm tabular-nums text-muted-foreground">
              {steps.filter((s) => s.status === "done").length}/{steps.length}
            </span>
          )}
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors select-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {collapsed ? "Show" : "Hide"}
            <ChevronDown
              className={cn("size-4 transition-transform", !collapsed && "rotate-180")}
              aria-hidden
            />
          </button>
        </div>
      </div>

      {!collapsed && (
        <ol className="border-t">
          {steps.map((step, i) => (
            <li
              key={step.id}
              className={cn(
                "flex items-start gap-3 border-b px-5 py-4 last:border-b-0",
                step.status === "done" && "bg-muted/30",
              )}
            >
              {/* The marker stays beside the text at every width — it is the
                  step's number, and a number that has wrapped onto its own line
                  above the thing it numbers is just a stray digit. Only the
                  call to action drops below. */}
              <StepMarker status={step.status} index={i} />

              <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{step.title}</p>
                  <StepDetail step={step} />
                </div>

                {step.href && step.cta && step.status !== "done" && (
                  <Link
                    href={step.href}
                    className={cn(
                      "inline-flex h-8 shrink-0 items-center self-start rounded-lg px-3 text-sm font-medium transition-colors select-none active:translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      step.status === "todo"
                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                        : "ring-1 ring-border hover:bg-muted",
                    )}
                  >
                    {step.cta}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/**
 * The line under a step's title.
 *
 * Once a step is done its rationale stops being useful and its outcome starts
 * being useful, so they swap. `waiting` swaps too, and then goes further: a
 * waiting step's detail is the only place the app says why nothing is sending,
 * and in one case — template approved, dry run still on — it is the single
 * easiest state in the product to miss. Rendering that as a second paragraph of
 * the same muted grey as the general blurb is how it gets missed.
 */
function StepDetail({ step }: { step: SetupStep }) {
  if (step.status === "done") {
    return <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{step.detail}</p>
  }

  if (step.status === "waiting" && step.detail) {
    return (
      <p className="mt-0.5 text-sm leading-relaxed text-amber-700 dark:text-amber-400">
        {step.detail}
      </p>
    )
  }

  return <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
}

/**
 * The dot beside each step.
 *
 * A done step gets a tick, a waiting step gets a clock, and a step still to do
 * gets its number — which is the only one of the three that has to say *where
 * in the order* it comes, because that is the question you ask about work you
 * have not started.
 */
function StepMarker({ status, index }: { status: SetupStep["status"]; index: number }) {
  // The status is written out for screen readers rather than set as an
  // aria-label. A <span> with no role maps to ARIA `generic`, which cannot take
  // an accessible name — so an aria-label here is silently dropped, and with
  // the icon aria-hidden the marker would announce nothing at all.
  if (status === "done") {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
        <Check className="size-3.5" strokeWidth={2.5} aria-hidden />
        <span className="sr-only">Done:</span>
      </span>
    )
  }

  if (status === "waiting") {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400">
        <Clock className="size-3.5" strokeWidth={2.25} aria-hidden />
        <span className="sr-only">Waiting:</span>
      </span>
    )
  }

  return (
    <span
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums text-muted-foreground"
      aria-hidden
    >
      {index + 1}
    </span>
  )
}
