import { assertEnv } from "@/lib/env"

/**
 * Next runs this once per server process, before the first request.
 *
 * Throwing here fails the deployment loudly, which is the entire point: a
 * missing SUPABASE_SERVICE_ROLE_KEY or a relative APP_PUBLIC_URL otherwise
 * surfaces as an unrelated 500 much later, on somebody else's screen.
 */
export function register(): void {
  assertEnv()
}
