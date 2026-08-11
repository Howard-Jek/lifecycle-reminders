import { createClient } from "@supabase/supabase-js"
import { supabaseAdminConfig } from "@/lib/env"

/**
 * The service-role client. Bypasses RLS entirely.
 *
 * Required for the two secret tables (contact_ingest_tokens,
 * team_member_calendar_tokens) and for every write, because the add-on's
 * policies are SELECT-only by design. Never hand this to a browser.
 *
 * Reads its config through src/lib/env.ts rather than `process.env.X!` so a
 * missing key names itself instead of surfacing as "Invalid URL".
 */
export function createAdminClient() {
  const { url, serviceRoleKey } = supabaseAdminConfig()
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
