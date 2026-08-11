import { cn } from "@/lib/utils"

/**
 * A text wordmark rather than an image.
 *
 * Deliberate: the standalone should read as part of the same product family
 * without copying the host's asset. Dropping in goma-ai-wordmark-1024x339.png
 * at integration replaces this component and nothing else.
 *
 * The dot is `brand`, not `primary` — orange marks what a thing IS, black is
 * for what you act on.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn("font-heading text-[0.95rem] font-semibold tracking-tight", className)}
    >
      Lifecycle<span className="text-brand">.</span>
    </span>
  )
}
