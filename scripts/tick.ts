/**
 * Run one reminder cycle from the command line.
 *
 * The point of this script is that "does the engine work?" never depends on a
 * scheduler being wired up. Run it twice in a row: the second run must
 * materialise 0 and deliver 0, which is the idempotency guarantee made
 * observable.
 *
 *   npm run reminders:tick
 */

import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"

// Load .env.local by hand: this runs outside Next, which is what does it in
// the app. ENV_FILE overrides, matching the host's script convention.
const envFile = process.env.ENV_FILE ?? ".env.local"
try {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const value = match[2].trim().replace(/^["']|["']$/g, "")
    if (!(match[1] in process.env)) process.env[match[1]] = value
  }
} catch {
  console.warn(`[tick] could not read ${envFile} — relying on the ambient environment`)
}

async function main() {
  const { assertEnv, isDryRun } = await import("../src/lib/env")
  assertEnv()
  if (isDryRun()) console.log("[tick] DRY RUN — nothing will reach WhatsApp\n")

  const { runReminderCycle } = await import("../src/lib/lifecycle/run-cycle")
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const result = await runReminderCycle(admin)
  console.log("\n" + JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
