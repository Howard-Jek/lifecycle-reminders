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

/**
 * A bag of environment variables. Deliberately looser than NodeJS.ProcessEnv,
 * which Next narrows so that NODE_ENV is required — these functions only ever
 * read strings, and tests need to construct partial environments to prove the
 * fail-closed behaviour below.
 */
export type EnvLike = Record<string, string | undefined>

/** Anything that is not explicitly development or test is production.
 *
 * Fails CLOSED, deliberately. The equivalent helper on the host's
 * `fix/prod-boot-guard` branch returns false when neither VERCEL_ENV nor
 * NODE_ENV is set — which is exactly the situation on a bare worker process,
 * and it is the process that owns every outbound send. Treating "I don't know"
 * as production costs a developer one env var; the other way round costs real
 * customers real messages.
 */
export function isProductionRuntime(env: EnvLike = process.env): boolean {
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
export function isDryRun(env: EnvLike = process.env): boolean {
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

/** Which required variables are absent. Names only — never values. */
export function missingEnv(env: EnvLike = process.env): string[] {
  return REQUIRED.filter((name) => !env[name]?.trim())
}

/**
 * Check the environment at boot.
 *
 * Two different severities, deliberately, because they are two different
 * problems:
 *
 * MISSING CONFIG is logged, loudly, but does NOT kill the process. Killing it
 * was the original behaviour and it made a misconfigured deploy strictly
 * harder to diagnose: the platform serves a blank 500, the reason sits in a
 * function log nobody has opened yet, and `/api/health` — the one endpoint
 * that could have named the missing variable — never gets to run either.
 * Nothing unsafe happens from booting without a Supabase URL; requests simply
 * fail, and now they fail with somewhere to look.
 *
 * A DANGEROUS CONFIG still throws. Those are conditions where running is worse
 * than being down, because the app would appear to work while doing the wrong
 * thing silently.
 */
export function assertEnv(env: EnvLike = process.env): void {
  const missing = missingEnv(env)
  if (missing.length > 0) {
    console.error(
      `[env] MISSING REQUIRED VARIABLE${missing.length > 1 ? "S" : ""}: ${missing.join(", ")}. ` +
        `The app will boot but requests that need them will fail. ` +
        `Set them and redeploy — GET /api/health lists exactly what is absent.`,
    )
    // Nothing below can be checked without the values, so stop here rather
    // than throwing on a variable that is simply not there yet.
    return
  }

  // APP_PUBLIC_URL ends up inside a WhatsApp template parameter as the deep
  // link. A relative or malformed value produces a message that looks fine and
  // links nowhere — a genuine silent failure, so this one still refuses to
  // start rather than shipping dead links to real agents.
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
export function appPublicUrl(env: EnvLike = process.env): string {
  return (env.APP_PUBLIC_URL ?? "").trim().replace(/\/+$/, "")
}

/** Supabase connection details for the service-role client. */
export function supabaseAdminConfig(env: EnvLike = process.env) {
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
