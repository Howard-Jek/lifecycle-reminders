import { StatusPill } from "./status-pill"
import type { WhatsappConfig } from "@/app/actions/whatsapp"

/**
 * The WhatsApp number and its template.
 *
 * ONE number for the whole deployment. The host app onboards a number per
 * business through Meta's Embedded Signup because it messages customers as
 * that business; this add-on only ever messages your own agents, so it is a
 * single platform identity and a single template.
 *
 * NO LONGER A CLIENT COMPONENT. Steps 1 and 3 are pure renders of environment
 * variables with nothing to click, and step 2 — the only interactive part, and
 * the only part that has to wait on Meta — is passed in as `templateBlock` so
 * the page can wrap it in Suspense. That is the whole point of the split: the
 * card frame, the credential check and the dry-run notice arrive with the rest
 * of Settings instead of behind a graph.facebook.com round trip.
 */
export function WhatsappClient({
  setup,
  templateBlock,
}: {
  setup: WhatsappConfig
  /** Step 2, streamed. See settings/page.tsx. */
  templateBlock: React.ReactNode
}) {
  const missing = [
    !setup.phoneNumberId && "GOMA_NOTIFY_PHONE_NUMBER_ID",
    !setup.wabaId && "GOMA_NOTIFY_WABA_ID",
    !setup.accessToken && "GOMA_NOTIFY_ACCESS_TOKEN",
  ].filter(Boolean) as string[]

  return (
    <section className="rounded-xl border bg-card p-6 shadow-sm ring-1 ring-foreground/5">
      <div className="mb-6">
        <h2 className="text-base font-semibold">WhatsApp</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Reminders go to your agents from one number you own. Meta requires an approved template
          for any message that starts a conversation, so nothing can be delivered until the one
          below says <span className="font-medium text-foreground">Approved</span>.
        </p>
      </div>

      {/* ── Step 1: the number ───────────────────────────────────────────── */}
      <div className="rounded-lg border bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium">1 · The number</h3>
          <StatusPill
            tone={setup.configured ? "good" : "waiting"}
            label={setup.configured ? "Connected" : "Not configured"}
          />
        </div>

        {setup.configured ? (
          <p className="mt-2 text-sm text-muted-foreground">
            All three credentials are present. Reminders will be sent from this number.
          </p>
        ) : (
          <div className="mt-3 space-y-2 text-sm text-muted-foreground">
            <p>
              Add a number in Meta Business Manager, then set{" "}
              {missing.length === 3 ? "these" : "the missing"} variables and restart:
            </p>
            <ul className="space-y-1">
              {missing.map((name) => (
                <li key={name} className="font-mono text-xs text-brand-ink">
                  {name}
                </li>
              ))}
            </ul>
            <p className="text-xs">
              Locally that is <code className="font-mono">.env.local</code>; on Vercel it is
              Project Settings → Environment Variables.
            </p>
          </div>
        )}
      </div>

      {/* ── Step 2: the template ─────────────────────────────────────────── */}
      {templateBlock}

      {/* ── Step 3: going live ───────────────────────────────────────────── */}
      <div className="mt-4 rounded-lg border bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium">3 · Sending for real</h3>
          <StatusPill
            tone={setup.dryRun ? "waiting" : "good"}
            label={setup.dryRun ? "Dry run" : "Live"}
          />
        </div>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          {setup.dryRun ? (
            <>
              Every stage runs and the exact payload is recorded — see{" "}
              <span className="font-medium text-foreground">Sandbox</span> — but nothing reaches
              Meta. Remove <code className="font-mono text-xs">REMINDER_DRY_RUN</code> once the
              template is approved. The app refuses to start with it set in production, so it
              cannot be left on by accident.
            </>
          ) : (
            <>
              Reminders are being delivered. Check that every team member&apos;s number is a real
              WhatsApp account — a send to a number that is not on WhatsApp succeeds at the API
              level and arrives nowhere. The Team page can put one on a handset to prove it.
            </>
          )}
        </p>
      </div>
    </section>
  )
}
