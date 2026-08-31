"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { KeyRound, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { StatusPill } from "./status-pill"
import { checkNumberStatus, registerNumberWithMeta } from "@/app/actions/whatsapp"
import type { WhatsappConfig, NumberDiagnosis } from "@/app/actions/whatsapp"

/**
 * Step 1: the sending number, and whether Meta will actually let it send.
 *
 * The whole card is a client component rather than just its buttons, because
 * the pill in the header reports what the buttons found. Three environment
 * variables being present is not the same fact as "this number can send", and
 * a header that keeps claiming the first while the body reports the second is
 * the disagreement worth avoiding.
 *
 * Nothing is fetched on mount. Asking Meta is a round trip on a page that
 * already streams one, so it happens when someone asks for it.
 */
export function NumberPanel({ setup }: { setup: WhatsappConfig }) {
  const router = useRouter()
  const [number, setNumber] = useState<NumberDiagnosis | null>(null)
  const [checking, startChecking] = useTransition()
  const [pin, setPin] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const missing = [
    !setup.phoneNumberId && "GOMA_NOTIFY_PHONE_NUMBER_ID",
    !setup.wabaId && "GOMA_NOTIFY_WABA_ID",
    !setup.accessToken && "GOMA_NOTIFY_ACCESS_TOKEN",
  ].filter(Boolean) as string[]

  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">1 · The number</h3>
        <StatusPill
          tone={
            !setup.configured ? "waiting" : number?.ok ? (number.readyToSend ? "good" : "bad") : "waiting"
          }
          /* Not "Connected" until Meta says so. Three environment variables
             being present says nothing about whether the number can send, and
             a green "Connected" sitting above a declined display name is
             exactly the reassurance that sends people to debug the wrong
             thing. */
          label={
            !setup.configured
              ? "Not configured"
              : number?.ok
                ? number.readyToSend
                  ? "Ready to send"
                  : "Cannot send"
                : "Credentials set"
          }
        />
      </div>

      {error && (
        <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      )}

      {setup.configured ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-muted-foreground">
            All three credentials are present — which is not the same as being able to send. Meta
            reviews the display name and the Cloud API registration separately, and either one
            blocks delivery on its own without any error at send time. Ask Meta which.
          </p>

          {number && !number.ok && (
            <p className="text-sm text-destructive">Could not reach Meta: {number.error}</p>
          )}

          {number?.ok && (
            <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-mono text-brand-ink">
                  {number.displayPhoneNumber ?? "number not reported"}
                </span>
                {number.verifiedName && (
                  <span className="text-muted-foreground">— {number.verifiedName}</span>
                )}
              </div>

              <NumberFacet
                label="Display name"
                verdict={number.name}
                raw={[
                  ["name_status", number.nameStatus],
                  ["new_name_status", number.newNameStatus],
                ]}
              />
              <NumberFacet
                label="Registration"
                verdict={number.registration}
                raw={[
                  ["status", number.status],
                  ["platform_type", number.platformType],
                ]}
              />
            </div>
          )}

          <Button
            variant="outline"
            disabled={checking}
            onClick={() => {
              setError(null)
              setNotice(null)
              startChecking(async () => {
                setNumber(await checkNumberStatus())
              })
            }}
          >
            <RefreshCw data-icon="inline-start" />
            {checking ? "Asking Meta…" : number ? "Check again" : "Check number"}
          </Button>

          <div className="rounded-lg border border-dashed p-3">
            <p className="text-xs text-muted-foreground">
              Re-registering clears{" "}
              <code className="font-mono">#133010 Account not registered</code>. It does{" "}
              <strong>not</strong> affect a declined display name — that is a separate review at
              Meta, and nothing here can hurry it or change its mind. Needs the number&rsquo;s
              six-digit two-step PIN; Meta rate-limits wrong attempts and will lock registration
              for a period, so do not guess it.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label htmlFor="wa-pin" className="sr-only">
                Six-digit two-step PIN
              </label>
              <input
                id="wa-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                placeholder="6-digit PIN"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                className="h-9 w-36 rounded-md border bg-background px-3 font-mono text-sm tracking-widest"
              />
              <Button
                variant="outline"
                disabled={checking || pin.length !== 6}
                onClick={() => {
                  setError(null)
                  setNotice(null)
                  startChecking(async () => {
                    const result = await registerNumberWithMeta(pin)
                    // Cleared either way. The PIN has done its job, and there is
                    // no reason for a secret to sit in component state through
                    // the rest of the session.
                    setPin("")
                    if (!result.ok) {
                      setError(result.error)
                      return
                    }
                    setNumber(result.data)
                    setNotice(
                      "Meta accepted the registration. It says nothing about the display name — " +
                        "check the display-name line above for that.",
                    )
                    router.refresh()
                  })
                }}
              >
                <KeyRound data-icon="inline-start" />
                {checking ? "Registering…" : "Re-register number"}
              </Button>
            </div>
          </div>
        </div>
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
            Locally that is <code className="font-mono">.env.local</code>; on Vercel it is Project
            Settings → Environment Variables.
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * One facet of the number's health: a verdict in prose, plus the raw Meta
 * fields it was read from.
 *
 * The raw values are shown deliberately. Prose is what an operator acts on,
 * but `new_name_status: PENDING_REVIEW` is what they paste into a search or
 * quote back to Meta support, and paraphrasing it away costs them that.
 */
function NumberFacet({
  label,
  verdict,
  raw,
}: {
  label: string
  verdict: { tone: "good" | "waiting" | "bad"; headline: string; detail: string }
  raw: Array<[string, string | null]>
}) {
  return (
    <div className="border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <StatusPill tone={verdict.tone} label={verdict.headline} />
      </div>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{verdict.detail}</p>
      <p className="mt-1 font-mono text-xs text-muted-foreground/80">
        {raw.map(([key, value]) => `${key}: ${value ?? "—"}`).join("  ·  ")}
      </p>
    </div>
  )
}
