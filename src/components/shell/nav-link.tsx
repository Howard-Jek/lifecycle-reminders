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
