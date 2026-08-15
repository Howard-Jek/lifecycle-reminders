import Link from "next/link"
import { Mail } from "lucide-react"
import { Wordmark } from "@/components/wordmark"

export const metadata = {
  title: "Access by invitation",
  // Nothing here is worth indexing, and a "sign up" page that cannot sign
  // anybody up is actively misleading in a search result.
  robots: { index: false, follow: false },
}

/**
 * Self-serve signup is closed.
 *
 * The route is kept rather than deleted so an old link, a bookmark or a stale
 * search result lands somewhere that explains itself, instead of on a 404 that
 * reads as a broken product.
 *
 * IMPORTANT, AND THE WHOLE REASON THIS PAGE IS NOT THE CONTROL: removing the
 * form does not close signup. The anon key is public by design and GoTrue's
 * `POST /auth/v1/signup` is reachable with it from anywhere, so anyone could
 * still create an account by calling Supabase directly. The actual control is
 * `disable_signup: true` on the Supabase project — this page only stops honest
 * people bouncing off a form that no longer works. See docs/ENROLMENT.md.
 */
export default function SignUpPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-muted/30 px-5 py-12">
      <Link href="/" aria-label="Lifecycle home">
        <Wordmark />
      </Link>

      <div className="w-full max-w-md rounded-xl border bg-card p-6 text-center shadow-sm ring-1 ring-foreground/5">
        <span className="mx-auto flex size-10 items-center justify-center rounded-lg bg-brand/10">
          <Mail className="size-5 text-brand-ink" strokeWidth={1.75} aria-hidden />
        </span>

        <h1 className="mt-4 text-xl font-bold tracking-tight text-balance">
          Accounts are set up for you.
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Lifecycle sends messages on your agency&apos;s behalf about real clients, so access is
          arranged directly rather than opened to anyone with the link. Get in touch and we will
          send you a sign-in link.
        </p>

        <Link
          href="/signin"
          className="mt-6 inline-flex h-10 items-center rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          I already have an account
        </Link>
      </div>
    </div>
  )
}
