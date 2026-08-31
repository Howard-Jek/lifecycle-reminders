"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

/**
 * A header nav link.
 *
 * Client-side only because it needs the current path. The class string is
 * inline rather than buttonVariants(): base-nova's Button has no `asChild`,
 * and buttonVariants lives in a "use client" module the server layout cannot
 * call — the same reason the host hand-rolls NAV_LINK_CLASS.
 */
export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname()
  const active = pathname === href || pathname.startsWith(`${href}/`)

  return (
    <Link
      href={href}
      /**
       * No viewport prefetch. Every nav link is visible on every screen, so the
       * default prefetched ALL SIX of them — and each one is a full server
       * render that runs that page's database queries.
       *
       * Measured in production: loading /reminders fired eleven speculative
       * renders totalling 3,755ms of server work, several routes twice, to
       * display one page that costs ~500ms on its own. On serverless that work
       * competes with the render the operator is actually waiting for, which is
       * why switching tabs felt slow while TTFB measured 16ms.
       *
       * Next still prefetches on hover and on touchstart, so the pointer moving
       * toward a link buys most of the latency back — the difference is that
       * the work now follows an intention instead of preceding all six.
       */
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex h-7 shrink-0 items-center justify-center whitespace-nowrap rounded-lg px-2.5 text-[0.8rem] font-medium transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
    </Link>
  )
}
