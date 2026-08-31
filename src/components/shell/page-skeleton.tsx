import { Skeleton } from "@/components/ui/skeleton"

/**
 * What a route shows while its data is still on the wire.
 *
 * WHY THIS EXISTS AT ALL. Every page here awaits its queries at the top level
 * with no Suspense boundary, so React had nothing to show until the whole
 * server render finished. Measured in production, click-to-first-visual-change
 * and click-to-settled were the SAME NUMBER — 577ms to 1013ms — meaning the
 * operator sat looking at the previous page, unchanged, with no acknowledgement
 * that the click registered, and then the new one appeared complete. The data
 * was never the problem; the silence was.
 *
 * A loading.tsx is a Suspense boundary Next renders the instant navigation
 * starts, so the shell swaps immediately and the content fills in.
 *
 * SHAPED, NOT GENERIC. A spinner would swap instantly and still shift
 * everything when the real content arrived. An earlier attempt at streaming on
 * this page used `fallback={null}`, reserved no space, and moved the inbox
 * 415px after first paint. These skeletons approximate the real layout so the
 * transition is a fill, not a jump.
 */

/** The h1 + subtitle every route opens with. */
export function HeaderSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <div className="space-y-2">
      <Skeleton className="h-8 w-48" />
      <Skeleton className={wide ? "h-4 w-96 max-w-full" : "h-4 w-64 max-w-full"} />
    </div>
  )
}

/** A card with a tab strip and a few list rows — the reminders inbox shape. */
export function ListCardSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="rounded-xl border bg-background shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        {[68, 92, 64, 128].map((w) => (
          <Skeleton key={w} className="h-7" style={{ width: w }} />
        ))}
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="space-y-3 px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="h-3 w-48" />
            {/* The suggestion block, which is the tallest part of a real row —
                omitting it is what would make the content jump on arrival. */}
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  )
}

/** A card wrapping a table — contacts and team. */
export function TableCardSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="rounded-xl border bg-background shadow-sm">
      <div className="border-b px-5 py-4">
        <Skeleton className="h-9 w-full max-w-xs rounded-lg" />
      </div>
      <div className="px-5">
        <div className="flex items-center gap-4 border-b py-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="hidden h-4 w-24 sm:block" />
          <Skeleton className="hidden h-4 w-24 sm:block" />
          <Skeleton className="ml-auto h-4 w-20" />
        </div>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b py-3 last:border-0">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="hidden h-4 w-28 sm:block" />
            <Skeleton className="hidden h-4 w-24 sm:block" />
            <Skeleton className="ml-auto h-4 w-8" />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Stacked setting cards. */
export function CardsSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <div className="space-y-6">
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="space-y-4 rounded-xl border bg-card p-6 shadow-sm ring-1 ring-foreground/5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full max-w-lg" />
          <Skeleton className="h-9 w-full max-w-sm rounded-lg" />
        </div>
      ))}
    </div>
  )
}
