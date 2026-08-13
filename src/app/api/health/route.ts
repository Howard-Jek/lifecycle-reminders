import { NextResponse } from "next/server"
import { missingEnv, isDryRun, isProductionRuntime } from "@/lib/env"

/**
 * "Why is my deployment broken?", answerable without shell access.
 *
 * This exists because the honest answer to a misconfigured deploy used to be
 * a blank 500 with the reason in a function log. Names of absent variables
 * only — never a value, never a host, never a key. Knowing that
 * SUPABASE_SERVICE_ROLE_KEY is unset tells an attacker nothing they could not
 * infer from the app failing anyway, and tells the operator exactly what to do.
 *
 * Unauthenticated on purpose: the credential most likely to be missing is the
 * one you would authenticate with.
 */

export const dynamic = "force-dynamic"

export async function GET() {
  const missing = missingEnv()
  const dryRun = isDryRun()
  const production = isProductionRuntime()

  return NextResponse.json(
    {
      ok: missing.length === 0,
      missing,
      // Reported because "it deployed but sends nothing" is the other way a
      // configured-looking deployment does nothing at all.
      dryRun,
      production,
      whatsapp: {
        phoneNumberId: Boolean(process.env.GOMA_NOTIFY_PHONE_NUMBER_ID?.trim()),
        wabaId: Boolean(process.env.GOMA_NOTIFY_WABA_ID?.trim()),
        accessToken: Boolean(process.env.GOMA_NOTIFY_ACCESS_TOKEN?.trim()),
      },
      ai: { anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()) },
      hint:
        missing.length > 0
          ? `Set ${missing.join(", ")} in Project Settings → Environment Variables, then redeploy.`
          : "Configuration looks complete.",
    },
    // 503 when it cannot serve properly, so an uptime check catches it too.
    { status: missing.length === 0 ? 200 : 503 },
  )
}
