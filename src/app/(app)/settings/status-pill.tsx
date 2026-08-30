import { cn } from "@/lib/utils"

/**
 * A state, not an action — so it is a tinted wash, never a filled control.
 *
 * Shared between the WhatsApp card's three steps now that the template step
 * renders separately: two copies would be two chances for the tones to drift.
 */
export function StatusPill({ tone, label }: { tone: "good" | "waiting" | "bad"; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-medium",
        tone === "good" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        tone === "waiting" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        tone === "bad" && "bg-destructive/10 text-destructive",
      )}
    >
      {label}
    </span>
  )
}
