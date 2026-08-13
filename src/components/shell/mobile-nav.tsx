"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Menu } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

/**
 * The navigation, below `sm`.
 *
 * Replaces a horizontally scrolling strip. That strip was not merely tight: at
 * 375px the last two destinations sat entirely outside the viewport with no
 * scrollbar or gradient to say so, and the links that were on screen slid
 * underneath the theme toggle and avatar, which are painted over the same row.
 * Settings and Sandbox were, in practice, unreachable on a phone.
 *
 * A menu also puts the current page's name in the trigger, which the strip
 * could not do once the active link had scrolled out of sight.
 */
export function MobileNav({
  items,
  pendingReviews,
}: {
  items: readonly { href: string; label: string }[]
  pendingReviews: number
}) {
  const pathname = usePathname()
  const current = items.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Open navigation"
        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium transition-colors select-none hover:bg-muted aria-expanded:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Menu className="size-4" aria-hidden />
        {current?.label ?? "Menu"}
        {pendingReviews > 0 && (
          // A dot, not the count: the trigger already carries a page name, and
          // the number is on the menu item that can act on it.
          // Amber, not brand: a backlog is a STATUS, and the desktop header
          // shows the same fact as an amber pill. Two hues for one signal
          // depending on screen width is the app disagreeing with itself. The
          // shade is the text amber rather than the fill amber — at 6px a
          // tinted wash is invisible, so this reads as ink, not as a fill.
          //
          // The text is a real sr-only node rather than an aria-label on the
          // dot. An unroled <span> is ARIA `generic` and cannot carry an
          // accessible name, so the label would be dropped and this — the only
          // signal on a phone that the review queue has anything in it — would
          // be silent.
          <>
            <span className="size-1.5 rounded-full bg-amber-600 dark:bg-amber-400" aria-hidden />
            <span className="sr-only">
              , {pendingReviews} {pendingReviews === 1 ? "row" : "rows"} to review
            </span>
          </>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-52">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
          return (
            <DropdownMenuItem key={item.href} asChild>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(active ? "font-medium text-foreground" : "text-muted-foreground")}
              >
                {item.label}
              </Link>
            </DropdownMenuItem>
          )
        })}

        {pendingReviews > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/import/review">
                <span className="inline-flex h-6 items-center rounded-full bg-amber-500/10 px-2.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                  <span className="tabular-nums">{pendingReviews}</span>&nbsp;to review
                </span>
              </Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
