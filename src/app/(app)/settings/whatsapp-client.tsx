"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { RefreshCw, Send, ShieldCheck, Webhook } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { describeState } from "@/lib/notify/template-admin"
import {
  submitReminderTemplate,
  refreshTemplateStatus,
  diagnoseWebhook,
  registerWebhookWithMeta,
} from "@/app/actions/whatsapp"
import type { WhatsappSetup, WebhookDiagnosis } from "@/app/actions/whatsapp"

/**
 * The WhatsApp number and its template.
 *
 * ONE number for the whole deployment. The host app onboards a number per
 * business through Meta's Embedded Signup because it messages customers as
 * that business; this add-on only ever messages your own agents, so it is a
 * single platform identity and a single template.
 */
export function WhatsappClient({ setup }: { setup: WhatsappSetup }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // The webhook probes live in their own transition. They call out to the
  // public internet and to Meta, so they are slower than everything else on
  // this page and must not make the template buttons look stuck.
  const [diagnosis, setDiagnosis] = useState<WebhookDiagnosis | null>(null)
  const [probing, startProbing] = useTransition()

  const configured = setup.wabaId && setup.accessToken && setup.phoneNumberId
  const status = setup.template

  const missing = [
    !setup.phoneNumberId && "GOMA_NOTIFY_PHONE_NUMBER_ID",
    !setup.wabaId && "GOMA_NOTIFY_WABA_ID",
    !setup.accessToken && "GOMA_NOTIFY_ACCESS_TOKEN",
  ].filter(Boolean) as string[]

  const described = status?.ok ? describeState(status) : null
  const canSubmit =
    configured && status?.ok && (status.state === "NOT_SUBMITTED" || status.state === "REJECTED")

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

      {error && (
        <p className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p className="mb-4 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      )}

      {/* ── Step 1: the number ───────────────────────────────────────────── */}
      <div className="rounded-lg border bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium">1 · The number</h3>
          <StatusPill
            tone={configured ? "good" : "waiting"}
            label={configured ? "Connected" : "Not configured"}
          />
        </div>

        {configured ? (
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
      <div className="mt-4 rounded-lg border bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium">
            2 · The template{" "}
            <code className="ml-1 font-mono text-xs text-muted-foreground">
              {setup.templateName}
            </code>
          </h3>
          {described && <StatusPill tone={described.tone} label={described.headline} />}
        </div>

        {!configured ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Connect the number first — there is nobody to ask about the template until then.
          </p>
        ) : status && !status.ok ? (
          <p className="mt-2 text-sm text-destructive">
            Could not reach Meta: {status.error}
          </p>
        ) : described ? (
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{described.detail}</p>
        ) : null}

        {configured && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {canSubmit && (
              <Button
                disabled={pending}
                onClick={() => {
                  setError(null)
                  setNotice(null)
                  startTransition(async () => {
                    const result = await submitReminderTemplate()
                    if (result.ok) {
                      setNotice(
                        "Submitted. Meta usually answers within the hour — check back with Refresh.",
                      )
                      router.refresh()
                    } else setError(result.error)
                  })
                }}
              >
                <Send data-icon="inline-start" />
                {status?.ok && status.state === "REJECTED"
                  ? "Submit again"
                  : "Submit for review"}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                setError(null)
                setNotice(null)
                startTransition(async () => {
                  const result = await refreshTemplateStatus()
                  if (result.ok) router.refresh()
                  else setError(result.error)
                })
              }}
            >
              <RefreshCw data-icon="inline-start" />
              {pending ? "Checking…" : "Refresh status"}
            </Button>
          </div>
        )}
      </div>

      {/* ── Step 3: the webhook ──────────────────────────────────────────── */}
      <div className="mt-4 rounded-lg border bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium">3 · The webhook</h3>
          <StatusPill
            tone={setup.webhook.verifyToken && setup.webhook.appSecret ? "good" : "waiting"}
            label={
              !setup.webhook.verifyToken
                ? "No verify token"
                : !setup.webhook.appSecret
                  ? "No app secret"
                  : "Configured"
            }
          />
        </div>

        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Meta reports every possible fault here as one sentence —{" "}
          <span className="italic">
            &ldquo;The callback URL or verify token couldn&apos;t be validated&rdquo;
          </span>{" "}
          — without saying which URL it called or what came back. These checks run from this
          deployment, which is the only place that can see both ends.
        </p>

        <div className="mt-3 rounded-md border bg-muted/40 px-3 py-2">
          <p className="text-xs text-muted-foreground">
            Callback URL (from <code className="font-mono">APP_PUBLIC_URL</code>) — this must
            match Meta&apos;s dashboard character for character
          </p>
          <p className="mt-0.5 font-mono text-xs break-all">{setup.webhook.callbackUrl}</p>
        </div>

        {(!setup.webhook.appId || !setup.webhook.appSecret) && (
          <div className="mt-3 space-y-1 text-sm text-muted-foreground">
            <p>
              Set these to let this page run Meta&apos;s verification itself, instead of
              pressing the dashboard button and reading a sentence that names no cause:
            </p>
            <ul className="space-y-1">
              {!setup.webhook.appId && (
                <li className="font-mono text-xs text-brand-ink">GOMA_NOTIFY_APP_ID</li>
              )}
              {!setup.webhook.appSecret && (
                <li className="font-mono text-xs text-brand-ink">GOMA_NOTIFY_APP_SECRET</li>
              )}
            </ul>
            <p className="text-xs">Both are on App Settings → Basic in the Meta dashboard.</p>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            disabled={probing}
            onClick={() => {
              setError(null)
              setNotice(null)
              startProbing(async () => {
                setDiagnosis(await diagnoseWebhook())
              })
            }}
          >
            <ShieldCheck data-icon="inline-start" />
            {probing ? "Checking…" : "Verify webhook"}
          </Button>

          {setup.webhook.appId && setup.webhook.appSecret && (
            <Button
              variant="outline"
              disabled={probing}
              onClick={() => {
                setError(null)
                setNotice(null)
                startProbing(async () => {
                  const result = await registerWebhookWithMeta()
                  if (!result.ok) {
                    setError(result.error)
                    return
                  }
                  // Re-read afterwards so the panel shows the state Meta is in
                  // NOW, not the state it was in before the attempt.
                  const fresh = await diagnoseWebhook()
                  setDiagnosis({ ...fresh, probes: [result.data, ...fresh.probes] })
                  if (result.data.tone === "good") {
                    setNotice("Verified. Meta has registered the callback URL.")
                    router.refresh()
                  }
                })
              }}
            >
              <Webhook data-icon="inline-start" />
              Ask Meta to verify
            </Button>
          )}
        </div>

        {diagnosis && (
          <div className="mt-4 space-y-2">
            {diagnosis.probes.map((probe, i) => (
              <div key={`${probe.label}-${i}`} className="rounded-md border bg-card p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <p className="text-sm font-medium">{probe.label}</p>
                  {/* The number, big and monospace: it is the thing an operator
                      reads out to whoever is helping them. */}
                  <span
                    className={cn(
                      "shrink-0 rounded px-2 py-0.5 font-mono text-sm font-semibold tabular-nums",
                      probe.tone === "good" &&
                        "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                      probe.tone === "waiting" &&
                        "bg-amber-500/10 text-amber-700 dark:text-amber-400",
                      probe.tone === "bad" && "bg-destructive/10 text-destructive",
                    )}
                  >
                    {probe.status ?? "no reply"}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{probe.detail}</p>
                {probe.evidence && (
                  <pre className="mt-2 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs whitespace-pre-wrap break-all">
                    {probe.evidence}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Step 4: going live ───────────────────────────────────────────── */}
      <div className="mt-4 rounded-lg border bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium">4 · Sending for real</h3>
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
              level and arrives nowhere.
            </>
          )}
        </p>
      </div>
    </section>
  )
}

function StatusPill({ tone, label }: { tone: "good" | "waiting" | "bad"; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-medium",
        tone === "good" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        tone === "waiting" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        tone === "bad" && "bg-destructive/10 text-destructive",
      )}
    >
      {label}
    </span>
  )
}
