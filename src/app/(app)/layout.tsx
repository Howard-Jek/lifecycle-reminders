import { redirect } from "next/navigation"
import Link from "next/link"
import { getTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { Wordmark } from "@/components/wordmark"
import { ThemeToggle } from "@/components/theme-toggle"
import { NavLink } from "@/components/shell/nav-link"
import { MobileNav } from "@/components/shell/mobile-nav"
import { SignOutMenuItem } from "@/components/shell/sign-out-item"
import { ReplayTourItem } from "@/components/shell/replay-tour-item"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const NAV = [
  { href: "/reminders", label: "Reminders" },
  { href: "/contacts", label: "Contacts" },
  { href: "/import", label: "Import" },
  { href: "/team", label: "Team" },
  { href: "/sandbox", label: "Sandbox" },
  { href: "/settings", label: "Settings" },
] as const

/**
 * The app shell: a sticky top bar, matching the host's dashboard chrome.
 *
 * No sidebar at this level — five destinations do not need one, and the
 * settings page grows its own left rail where the section count justifies it.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const tenant = await getTenant()
  // The middleware already redirected an unauthenticated request; this covers
  // the narrow case where membership resolution itself failed.
  if (!tenant) redirect("/signin")

  // The review count rides in the shell because an unattributed contact is
  // work that is invisible everywhere else — its reminders quietly fall back
  // to the owner until somebody assigns it.
  const admin = createAdminClient()
  const { count: pendingReviews } = await admin
    .from("contact_import_reviews")
    .select("id", { count: "exact", head: true })
    .eq("business_id", tenant.businessId)
    .eq("status", "pending")

  const initials = (tenant.email ?? "?").slice(0, 2).toUpperCase()

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:px-6">
          <Link
            href="/reminders"
            className="mr-1 flex h-9 shrink-0 items-center rounded-lg px-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:mr-6"
            aria-label="Lifecycle home"
          >
            <Wordmark />
          </Link>

          {/* Two navs, one per size class, rather than one that scrolls. The
              scrolling strip put Settings and Sandbox off-screen at 375px with
              nothing to indicate they were there. */}
          <div className="flex min-w-0 flex-1 items-center sm:hidden">
            <MobileNav items={NAV} pendingReviews={pendingReviews ?? 0} />
          </div>

          <nav className="hidden min-w-0 flex-1 items-center gap-1 sm:flex">
            {NAV.map((item) => (
              <NavLink key={item.href} href={item.href} label={item.label} />
            ))}
            {pendingReviews ? (
              <Link
                href="/import/review"
                className="ml-1 inline-flex h-6 shrink-0 items-center rounded-full bg-amber-500/10 px-2.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:text-amber-400"
              >
                {pendingReviews}&nbsp;to review
              </Link>
            ) : null}
          </nav>

          <div className="flex shrink-0 items-center gap-1 sm:gap-3">
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger className="relative flex h-8 w-8 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                </Avatar>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <div className="px-2 py-1.5">
                  <p className="text-xs text-muted-foreground">Signed in as</p>
                  <p className="wrap-anywhere text-sm font-medium">{tenant.email}</p>
                </div>
                <DropdownMenuSeparator />
                <ReplayTourItem />
                <SignOutMenuItem />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
    </div>
  )
}
