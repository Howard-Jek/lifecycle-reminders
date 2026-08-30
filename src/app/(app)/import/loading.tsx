import { HeaderSkeleton, CardsSkeleton } from "@/components/shell/page-skeleton"

/**
 * Rendered the instant navigation to this route begins, before any query runs.
 * See page-skeleton.tsx for why: without it, click-to-first-paint and
 * click-to-settled were the same number and the click looked ignored.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <HeaderSkeleton />
      <CardsSkeleton cards={2} />
    </div>
  )
}
