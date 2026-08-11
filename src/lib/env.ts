/**
 * Environment, parsed and validated once.
 *
 * The host app reads `process.env.X!` at every call site and ships no
 * `.env.example`, which is how `APP_PUBLIC_URL` came to fail *silently* — a
 * wrong value yields broken deep links and never an error. Forty lines of
 * parsing removes that whole class of "the UI works but nothing happens".
 *
 * Nothing here is read at module scope in a way that can crash a build: the
 * required-variable check runs from `assertEnv()`, called by
 * `src/instrumentation.ts` at server boot and by the CLI entry points.
 */

/** Anything that is not explicitly development or test is production.
 *
 * Fails CLOSED, deliberately. The equivalent helper on the host's
 * `fix/prod-boot-guard` branch returns false when neither VERCEL_ENV nor
 * NODE_ENV is set — which is exactly the situation on a bare worker process,
 * and it is the process that owns every outbound send. Treating "I don't know"
 * as production costs a developer one env var; the other way round costs real
 * customers real messages.
 */
export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === "production"
  const raw = (env.APP_ENV ?? env.NODE_ENV ?? "").trim().toLowerCase()
  return raw !== "development" && raw !== "test"
}

/**
 * Is the sender in dry-run mode — logging the payload and stamping a synthetic
 * message id instead of calling Meta?
 *
 * This exists because delivery is WhatsApp-only: until `client_event_reminder`
 * is APPROVED on the WABA (hours of Meta review), nothing downstream of the
 * materialiser could otherwise be exercised at all.
 */
export function isDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.REMINDER_DRY_RUN?.trim()
  return flag === "1" || flag?.toLowerCase() === "true"
}

/** Variables without which the app cannot serve a single request. */
const REQUIRED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "APP_PUBLIC_URL",
  "CRON_SECRET",
] as const

/**
 * Throw on a misconfigured environment, at boot, with the variable named.
 *
 * Called from `instrumentation.ts`, so a bad deploy fails visibly instead of
 * serving 500s whose cause is three layers down a stack trace.
 */
export function assertEnv(env: NodeJS.ProcessEnv = process.env): void {
  const missing = REQUIRED.filter((name) => !env[name]?.trim())
  if (missing.length > 0) {
    throw new Error(
      `Refusing to start: missing required environment variable${missing.length > 1 ? "s" : ""} ` +
        `${missing.join(", ")}. See .env.example.`,
    )
  }

  // APP_PUBLIC_URL ends up inside a WhatsApp template parameter as the deep
  // link. A relative or malformed value produces a message that looks fine and
  // links nowhere, so it is checked here rather than discovered by an agent.
  const appUrl = env.APP_PUBLIC_URL!.trim()
  let parsed: URL
  try {
    parsed = new URL(appUrl)
  } catch {
    throw new Error(
      `Refusing to start: APP_PUBLIC_URL ("${appUrl}") is not an absolute URL. ` +
        `It becomes the deep link inside every reminder, so a wrong value fails silently.`,
    )
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Refusing to start: APP_PUBLIC_URL must be http or https, got "${parsed.protocol}".`,
    )
  }

  if (isDryRun(env) && isProductionRuntime(env)) {
    throw new Error(
      "Refusing to start in production: REMINDER_DRY_RUN is set. Every reminder would be " +
        "recorded as delivered without a message ever reaching an agent. Remove it and redeploy.",
    )
  }
}

/** The public origin, with any trailing slash removed. */
export function appPublicUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.APP_PUBLIC_URL ?? "").trim().replace(/\/+$/, "")
}

/** Supabase connection details for the service-role client. */
export function supabaseAdminConfig(env: NodeJS.ProcessEnv = process.env) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — the service-role " +
        "client cannot be built.",
    )
  }
  return { url, serviceRoleKey }
}
