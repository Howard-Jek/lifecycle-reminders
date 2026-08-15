import Link from "next/link"
import { Wordmark } from "@/components/wordmark"

export const metadata = { title: "Page not found" }

/**
 * The 404.
 *
 * Without this Next serves its own unstyled page, which on a product whose
 * whole pitch is "quiet and well-kept" reads as a broken deployment rather than
 * a wrong URL. It is also the page an unauthenticated visitor hits most, since
 * every app route redirects them to sign-in and only genuinely-absent paths
 * land here.
 *
 * Both exits are offered because there is no way to know which one applies:
 * a signed-in operator wants the inbox, a stranger wants the front page.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-muted/30 px-5 text-center">
      <Link href="/" aria-label="Lifecycle home">
        <Wordmark />
      </Link>

      <div className="max-w-md">
        <p className="text-[0.7rem] font-medium tracking-[0.14em] text-brand-ink uppercase">
          404
        </p>
        <h1 className="mt-3 text-2xl font-bold tracking-tight text-balance sm:text-3xl">
          There is nothing at this address.
        </h1>
        <p className="mt-3 leading-relaxed text-muted-foreground">
          The link may be out of date, or the page may have moved. Nothing has gone wrong with your
          reminders.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/reminders"
          className="inline-flex h-10 items-center rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Go to your reminders
        </Link>
        <Link
          href="/"
          className="inline-flex h-10 items-center rounded-lg px-5 text-sm font-medium ring-1 ring-border transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Back to the front page
        </Link>
      </div>
    </div>
  )
}
