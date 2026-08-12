import Link from "next/link"
import { AlertTriangle } from "lucide-react"
import { describeCoverage, type Coverage } from "@/lib/lifecycle/coverage"

/**
 * The quietest failure the engine has, made loud.
 *
 * Dates whose event_type no active rule matches produce nothing — no reminder,
 * no error, no row. Without this banner the only symptom is an empty queue,
 * which is indistinguishable from "no dates are due yet".
 */
export function CoverageBanner({ coverage }: { coverage: Coverage }) {
  const message = describeCoverage(coverage)
  if (!message) return null

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
      <AlertTriangle
        className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
        strokeWidth={2}
      />
      <p className="min-w-0 flex-1 text-sm text-amber-800 dark:text-amber-300">{message}</p>
      <Link
        href="/settings"
        className="shrink-0 text-sm font-medium text-amber-800 underline-offset-4 hover:underline dark:text-amber-300"
      >
        Fix in Settings
      </Link>
    </div>
  )
}
