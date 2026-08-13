import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { Wordmark } from "@/components/wordmark"
import { DateLedger } from "@/components/date-ledger"
import { renderReminderBody } from "@/lib/sandbox/record"

export const dynamic = "force-dynamic"

/**
 * The landing page.
 *
 * Its one job: convince an agency principal that dates their team is already
 * missing can be caught, and get them into an import.
 *
 * The palette and typeface are the app's, not a marketing variant — an
 * operator who signs up should land somewhere that looks like the page that
 * sold them. That leaves layout, structure and copy as the places to be
 * distinctive, so that is where the effort went.
 */

/** The real template body, rendered with real values. Not a mock-up of the
 * product's output — the actual function the sandbox and Meta both use. */
const SAMPLE_PARAMS = [
  "Ong Kai Xiang",
  "Income Enhanced Incomeshield",
  "in 5 days",
  "Hi Mr Ong, just a heads-up that your Income plan is due to expire in 5 days. Wanted to check in before that happens so your coverage stays on track — let me know a good time to chat this week.",
  "lifecycle.app/contacts/8f21",
]

const REFUSALS = [
  {
    title: "It won't message your client",
    body: "The reminder goes to the agent who owns the relationship, with something to send. They read it, change what they want, and send it themselves. That step is the product, not a limitation of it.",
  },
  {
    title: "It won't guess whose client it is",
    body: "An agent name that matches nobody — or matches two people — goes to a review queue with the row attached. A client filed to the wrong agent means the wrong person is reminded and the right one never is.",
  },
  {
    title: "It won't invent a number",
    body: "The suggested message references only what is in your own file. No premium it wasn't given, no date it didn't read, no promise about a payout.",
  },
]

export default async function LandingPage() {
  // Signed-in visitors get "Open the app" instead of a sign-up pitch. Reading
  // the landing page with a session is perfectly reasonable; being sold to
  // twice is not.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const primaryHref = user ? "/reminders" : "/signup"
  const primaryLabel = user ? "Open the app" : "Start an import"

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Link href="/" aria-label="Lifecycle home">
            <Wordmark />
          </Link>
          <nav className="flex items-center gap-1.5">
            {!user && (
              <Link
                href="/signin"
                className="inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                Sign in
              </Link>
            )}
            <Link
              href={primaryHref}
              className="inline-flex h-8 items-center rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {primaryLabel}
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* ── Hero ─────────────────────────────────────────────────────────
            Asymmetric on purpose: the argument is short, the evidence is long.
            The ledger gets the wider column because it IS the argument. */}
        <section className="mx-auto grid max-w-6xl gap-12 px-5 pt-16 pb-20 sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-16 lg:pt-24">
          {/* Starts at the top rather than centring against the ledger: the
              ledger is deliberately tall, and centring the argument against it
              pushed the headline half a screen down. */}
          <div className="flex flex-col lg:pt-2">
            <p className="text-[0.7rem] font-medium tracking-[0.14em] text-brand-ink uppercase">
              For insurance agencies
            </p>
            <h1 className="mt-4 text-4xl leading-[1.05] font-bold tracking-tight text-balance sm:text-5xl lg:text-[3.4rem]">
              Nobody can watch 200 clients&apos; dates.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              Lifecycle reads the dates already sitting in your spreadsheet, works out which ones
              are worth a conversation this week, and WhatsApps the agent who owns that client —
              with something to say.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href={primaryHref}
                className="group inline-flex h-11 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {primaryLabel}
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <span className="text-sm text-muted-foreground">
                Upload a CSV. Nothing sends until you say so.
              </span>
            </div>
          </div>

          <DateLedger />
        </section>

        {/* ── The artifact ─────────────────────────────────────────────────
            The product's actual output, rendered by the product's actual
            function. Showing the real thing beats describing it. */}
        <section className="border-y bg-muted/30">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-16 sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center lg:py-20">
            <div>
              <p className="text-[0.7rem] font-medium tracking-[0.14em] text-brand-ink uppercase">
                What your agent gets
              </p>
              <h2 className="mt-3 text-2xl font-bold tracking-tight text-balance sm:text-3xl">
                A message they can send in one tap — or rewrite in ten seconds.
              </h2>
              <p className="mt-4 max-w-lg leading-relaxed text-muted-foreground">
                It arrives on WhatsApp, where they already are. It names the client, the plan and
                how long they have, then drafts an opener from what your own file says about that
                person. No dashboard to remember to open.
              </p>
            </div>

            {/* A handset, not a floating card: the medium is the point. */}
            <div className="mx-auto w-full max-w-sm rounded-2xl border bg-card p-2 shadow-sm ring-1 ring-foreground/5">
              <div className="rounded-xl bg-muted/50 p-3">
                <div className="max-w-[92%] rounded-2xl rounded-bl-sm bg-background px-3 py-2.5 shadow-sm ring-1 ring-foreground/10">
                  <p className="mb-1.5 inline-flex rounded-full bg-foreground/5 px-1.5 py-0.5 text-[0.6rem] font-medium tracking-wide text-muted-foreground uppercase">
                    Lifecycle
                  </p>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">
                    {renderReminderBody(SAMPLE_PARAMS)}
                  </p>
                  <p className="mt-1.5 text-right text-[0.65rem] tabular-nums text-muted-foreground">
                    09:00
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── How it works ─────────────────────────────────────────────────
            Numbered because it genuinely is a sequence — each step depends on
            the one before it. Numbering anything else would be decoration. */}
        <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 lg:py-20">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Three steps, once.</h2>
          <ol className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-3">
            {[
              {
                head: "Upload the spreadsheet you already have",
                body: "It finds the name, phone and agent columns, and reads DD/MM or MM/DD from the data rather than assuming. If a column is genuinely ambiguous, it asks.",
              },
              {
                head: "Say when you want to know",
                body: "A month before a policy expires. A week before a birthday. Rules are rows, not code — so a warranty, a visa renewal or a review cadence works the same way.",
              },
              {
                head: "Your agents get told",
                body: "Every fifteen minutes it checks what has come due and messages the right person. Re-running it never sends anything twice.",
              },
            ].map((step, i) => (
              <li key={step.head} className="relative border-t pt-5">
                <span className="absolute -top-px left-0 h-px w-10 bg-brand" aria-hidden />
                <span className="font-mono text-xs tabular-nums text-brand-ink">
                  0{i + 1}
                </span>
                <h3 className="mt-2.5 leading-snug font-semibold">{step.head}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ── Restraint ────────────────────────────────────────────────────
            The most interesting thing about this product is what it declines
            to do, so it gets a section rather than a footnote. */}
        <section className="border-t bg-muted/30">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 lg:py-20">
            <h2 className="max-w-2xl text-2xl font-bold tracking-tight text-balance sm:text-3xl">
              Three things it will not do, on purpose.
            </h2>
            <div className="mt-10 grid gap-8 sm:grid-cols-3">
              {REFUSALS.map((item) => (
                <div key={item.title} className="relative border-t pt-5">
                  <span className="absolute -top-px left-0 h-px w-10 bg-brand" aria-hidden />
                  <h3 className="leading-snug font-semibold">{item.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Close ────────────────────────────────────────────────────── */}
        <section className="mx-auto max-w-6xl px-5 py-20 text-center sm:px-8">
          <h2 className="mx-auto max-w-2xl text-2xl font-bold tracking-tight text-balance sm:text-3xl">
            The dates are already in your spreadsheet.
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-muted-foreground">
            Ten minutes to import a book of clients and see what the next month actually looks
            like.
          </p>
          <Link
            href={primaryHref}
            className="group mt-7 inline-flex h-11 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {primaryLabel}
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-7 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <Wordmark className="text-sm" />
          <p>Reminders for the people who own the relationship.</p>
        </div>
      </footer>
    </div>
  )
}
