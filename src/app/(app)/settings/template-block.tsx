"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { RefreshCw, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusPill } from "./status-pill"
import { describeCategory } from "@/lib/notify/template-admin"
import { describeState, type TemplateStatus } from "@/lib/notify/template-admin"
import { submitReminderTemplate, refreshTemplateStatus } from "@/app/actions/whatsapp"

/**
 * Step 2 of the WhatsApp card: what Meta thinks of our template.
 *
 * ITS OWN COMPONENT BECAUSE IT IS THE SLOW ONE. Steps 1 and 3 are env reads
 * that resolve instantly; this needs graph.facebook.com, with no deadline (see
 * getTemplateStatus). Splitting it lets the page stream — the rest of Settings
 * renders while this block waits.
 *
 * ONE COMPONENT FOR BOTH STATES, rather than a separate skeleton file, so the
 * loading geometry cannot drift from the loaded geometry: same padding, same
 * header row, same three regions, same button height. The block is in the
 * MIDDLE of the page, so anything it gets wrong pushes Profile and API keys
 * up or down after first paint — the exact regression a `fallback={null}`
 * caused on the reminder inbox.
 */
export function TemplateBlock({
  templateName,
  configured,
  status,
  loading = false,
}: {
  templateName: string
  configured: boolean
  /** Null when credentials are missing — nobody to ask. */
  status: TemplateStatus | null
  loading?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /**
   * The answer Refresh brought back, which supersedes the one the page was
   * rendered with. Held here so refreshing costs a single Graph call: the
   * alternative — re-rendering the route to pick up a fresh prop — spends
   * another round trip to learn what the action already knows.
   *
   * Cleared on submit, where a full re-render IS wanted because the server
   * state actually changed.
   */
  const [refreshed, setRefreshed] = useState<TemplateStatus | null>(null)
  const current = refreshed ?? status

  const described = current?.ok ? describeState(current) : null

  const categoryNote = current?.ok ? describeCategory(current.category) : null
  const canSubmit =
    configured &&
    current?.ok &&
    (current.state === "NOT_SUBMITTED" || current.state === "REJECTED")

  return (
    <div className="mt-4 rounded-lg border bg-background p-4" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* The heading is known without asking anyone, so it renders in both
            states rather than becoming another grey bar. */}
        <h3 className="text-sm font-medium">
          2 · The template{" "}
          <code className="ml-1 font-mono text-xs text-muted-foreground">{templateName}</code>
        </h3>
        {loading ? (
          <Skeleton className="h-6 w-28 rounded-full" aria-hidden />
        ) : described ? (
          <StatusPill tone={described.tone} label={described.headline} />
        ) : (
          // A failed fetch used to render NO pill at all, so the header looked
          // settled and unremarkable at the one moment we did not know the
          // answer. "Not approved" and "could not ask" are different facts and
          // the header has to distinguish them.
          current && !current.ok && <StatusPill tone="bad" label="Could not check" />
        )}
      </div>

      {/**
        * A FLOOR, not a guess.
        *
        * The detail's height depends on Meta's answer — the thing being waited
        * for — so no reservation can match it, and an earlier attempt to pick
        * the middle was wrong in BOTH directions at four of seven widths. A
        * minimum cannot be undershot: set it to the tallest real state at each
        * width and the block's height stops depending on the answer entirely,
        * so the two cards below it never move.
        *
        * The stops are measured, not chosen — the tallest of describeState's
        * seven strings at max-w-2xl, sampled from 320px to 1600px. Re-measure
        * them if that copy changes; the cost of being wrong is only whitespace.
        */}
      <div className="mt-2 min-h-[140px] min-[360px]:min-h-[100px] min-[414px]:min-h-[80px] min-[540px]:min-h-[60px] min-[700px]:min-h-[40px]">
        {loading ? (
          <>
            {/* Two lines fits under every floor above, so the skeleton can be
                fixed rather than tracking the same curve twice. */}
            <div className="max-w-2xl space-y-1.5 py-0.5" aria-hidden>
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-4/5" />
            </div>
            {/* Every skeleton is aria-hidden, so without this a screen reader
                hears the heading and then silence, and the answer arrives
                without a word. */}
            <span className="sr-only">Checking the template status with Meta…</span>
          </>
        ) : !configured ? (
          <p className="max-w-2xl text-sm text-muted-foreground">
            Connect the number first — there is nobody to ask about the template until then.
          </p>
        ) : current && !current.ok ? (
          // The same tinted wash the action errors below use. Rendering one of
          // them as bare red text and the other as a wash gave one component
          // two grammars for the same severity.
          <p className="max-w-2xl rounded-lg bg-destructive/10 px-3 py-2 text-sm break-words text-destructive">
            Could not check with Meta — the credentials may have expired, or Meta may be down.
            Reported as: {current.error}
          </p>
        ) : described ? (
          <p className="max-w-2xl text-sm text-muted-foreground">{described.detail}</p>
        ) : null}

        {/* The category, which decides whether #131049 can happen at all. Shown
            beside the approval state because "Approved" and "Approved as
            Marketing" are very different facts and only one of them was ever
            on screen. */}
        {categoryNote && (
          <div
            className={
              categoryNote.tone === "good"
                ? "mt-3 max-w-2xl rounded-lg bg-emerald-500/10 px-3 py-2 text-emerald-700 dark:text-emerald-400"
                : categoryNote.tone === "warn"
                  ? "mt-3 max-w-2xl rounded-lg bg-destructive/10 px-3 py-2 text-destructive"
                  : "mt-3 max-w-2xl rounded-lg bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-400"
            }
          >
            <p className="text-sm font-medium">Category: {categoryNote.headline}</p>
            <p className="mt-1 text-sm leading-relaxed">{categoryNote.detail}</p>
          </div>
        )}
      </div>

      {error && (
        <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm break-words text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      )}

      {configured && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {loading ? (
            // One button, at the real height. A second may appear when the
            // status resolves, but it sits beside this one — so the row's
            // height, which is what moves the page, is already correct.
            <Skeleton className="h-9 w-36 rounded-lg" aria-hidden />
          ) : (
            <>
              {canSubmit && (
                <Button
                  disabled={pending}
                  onClick={() => {
                    setError(null)
                    setNotice(null)
                    startTransition(async () => {
                      const result = await submitReminderTemplate()
                      if (result.ok) {
                        setNotice(
                          "Submitted. Meta usually answers within the hour — check back with Refresh.",
                        )
                        // Server state changed, so the page re-reads it — and
                        // the locally-held answer must stop overriding the
                        // fresh prop that render brings.
                        setRefreshed(null)
                        router.refresh()
                      } else setError(result.error)
                    })
                  }}
                >
                  <Send data-icon="inline-start" />
                  {current?.ok && current.state === "REJECTED"
                    ? "Submit again"
                    : "Submit for review"}
                </Button>
              )}
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setError(null)
                  setNotice(null)
                  startTransition(async () => {
                    const result = await refreshTemplateStatus()
                    // Rendered from the returned value, NOT by re-rendering the
                    // route — see refreshTemplateStatus for the round trips
                    // that used to buy.
                    if (result.ok) setRefreshed(result.data)
                    else setError(result.error)
                  })
                }}
              >
                <RefreshCw data-icon="inline-start" />
                {pending ? "Checking…" : "Refresh status"}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
