"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ShieldCheck, Webhook } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { StatusPill } from "./status-pill"
import { diagnoseWebhook, registerWebhookWithMeta } from "@/app/actions/whatsapp"
import type { WhatsappConfig, WebhookDiagnosis } from "@/app/actions/whatsapp"

/**
 * Step 3: is Meta actually calling us, and if not, why not.
 *
 * Its own client component because the card around it is a server component
 * now — steps 1 and 3 are the two interactive parts, and each keeps its own
 * transition so a Graph round trip in one cannot make the other look stuck.
 */
export function WebhookPanel({ webhook }: { webhook: WhatsappConfig["webhook"] }) {
  const router = useRouter()
  const [diagnosis, setDiagnosis] = useState<WebhookDiagnosis | null>(null)
  const [probing, startProbing] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <>
      {error && (
        <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-4 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      )}
    <div className="mt-4 rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">3 · The webhook</h3>
        <StatusPill
          tone={webhook.verifyToken && webhook.appSecret ? "good" : "waiting"}
          label={
            !webhook.verifyToken
              ? "No verify token"
              : !webhook.appSecret
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
        <p className="mt-0.5 font-mono text-xs break-all">{webhook.callbackUrl}</p>
      </div>

      {(!webhook.appId || !webhook.appSecret) && (
        <div className="mt-3 space-y-1 text-sm text-muted-foreground">
          <p>
            Set these to let this page run Meta&apos;s verification itself, instead of
            pressing the dashboard button and reading a sentence that names no cause:
          </p>
          <ul className="space-y-1">
            {!webhook.appId && (
              <li className="font-mono text-xs text-brand-ink">GOMA_NOTIFY_APP_ID</li>
            )}
            {!webhook.appSecret && (
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

        {webhook.appId && webhook.appSecret && (
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
    </>
  )
}
