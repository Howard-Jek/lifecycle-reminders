/**
 * Concatenate the migrations into one file you can paste into the Supabase SQL
 * editor.
 *
 * This exists because the CLI path has three ways to fail before it does
 * anything useful — `supabase login` needs a TTY and a browser, `link` needs
 * the database password, and `db push` needs a percent-encoded connection
 * string. None of that is necessary to create eleven tables. Pasting SQL into
 * the dashboard cannot fail for any of those reasons.
 *
 * Generated rather than committed, so it can never drift from the migrations
 * it is built from.
 *
 *   npm run db:bundle          → writes supabase/bundle.sql
 *   npm run db:bundle -- --addon-only   → just the piece that merges into GomaAI
 *   npm run db:schema          → refreshes the COMMITTED copies in supabase/schema/
 *
 * The pasteable bundle stays generated-and-ignored. The committed copies in
 * supabase/schema/ are a different thing with a different job: they are the
 * answer to "how do we build this database" for somebody reading the repo on
 * GitHub — at merge time, most likely, without this checkout in front of them.
 * schema-bundle.test.ts regenerates them and fails if they have drifted, so
 * committing them cannot produce the stale copy that generating-only avoids.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"

const MIGRATIONS_DIR = "supabase/migrations"
const DEFAULT_OUT = "supabase/bundle.sql"

/**
 * Which migrations are meant for GomaAI's database, and which exist only so the
 * standalone can run on a Supabase project of its own.
 *
 * An EXPLICIT list, not a substring match. It used to be `name.includes(
 * "lifecycle_events")`, which was true when there was one add-on migration and
 * quietly wrong from the second one onward: the add-on bundle silently omitted
 * the inbound-messages table, the receipts table, the scheduler heartbeat, the
 * event-type RPC and the auto-send flag. Anyone building the host database from
 * it would have got a schema the app immediately fails against, with nothing to
 * say which piece was missing.
 *
 * Checked against what jottiteam/lead-reactivation-agent ACTUALLY ported on
 * `staging` (2026-08-31), rather than against intent:
 *
 *   20260830120000_lifecycle_reminders.sql      ← lifecycle_events
 *   20260830120100_reminders_whatsapp_inbound   ← whatsapp_inbound
 *   20260830120200_reminders_status_events      ← status_events
 *   20260831120000_reminders_send_safety.sql    ← scheduler_runs + event_type_counts
 *                                                 + auto_send_flag, bundled
 *
 * A new migration must be classified here deliberately. schema-bundle.test.ts
 * fails on any file this list does not mention, so forgetting is not an option
 * that stays quiet.
 */
const STANDALONE_ONLY = [
  // Reproduces tables GomaAI already has — applying it would collide with
  // every object it defines.
  "20260811000000_platform_standins.sql",
  // The sandbox transcript. Deliberately not ported; see the merge notes.
  "20260811020000_sandbox.sql",
  // Revokes anon on tenant tables AND changes DEFAULT PRIVILEGES for every
  // future table in the database. That is a database-wide decision that
  // deserves its own change, not a ride-along on a feature merge.
  "20260815120000_revoke_anon.sql",
  // businesses.vertical already exists in the host.
  "20260901010000_vertical_standin.sql",
] as const

/** Build one bundle. Exported so the drift test can compare without a subprocess. */
export function buildBundle(addonOnly: boolean): string {
  const chosen = bundledMigrations(addonOnly)

  const header = addonOnly
    ? [
        "-- LIFECYCLE — the migrations that merge into GomaAI.",
        "--",
        "-- This is the piece that goes into an EXISTING GomaAI database. It",
        "-- expects businesses, business_members, leads, member_business_ids()",
        "-- and update_updated_at() to already exist, and it expects",
        "-- businesses.vertical — the host already has that column.",
        "--",
        "-- Excluded, deliberately: the platform stand-ins, the sandbox, the",
        "-- anon revocation and the vertical stand-in. See STANDALONE_ONLY in",
        "-- scripts/sql-bundle.ts for why each one is left out.",
      ]
    : [
        "-- LIFECYCLE — full schema for a FRESH, STANDALONE Supabase project.",
        "--",
        "-- Paste the whole thing into the SQL editor and run it once.",
        "--",
        "-- Do NOT run this against GomaAI's database: it contains the platform",
        "-- stand-ins (businesses, business_members, leads) that GomaAI already",
        "-- has, and it would collide with every one of them. For that, use:",
        "--   npm run db:bundle -- --addon-only",
      ]

  const body = chosen
    .map((name) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8")
      return [
        "",
        "-- " + "═".repeat(74),
        `-- ${name}`,
        "-- " + "═".repeat(74),
        "",
        sql.trimEnd(),
        "",
      ].join("\n")
    })
    .join("\n")

  return [...header, "", body].join("\n") + "\n"
}

/** The migrations that go into each bundle, for reporting. */
export function allMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    // Filename order IS apply order — the timestamps exist for exactly this.
    .sort()
}

export function isStandaloneOnly(name: string): boolean {
  return (STANDALONE_ONLY as readonly string[]).includes(name)
}

export function bundledMigrations(addonOnly: boolean): string[] {
  return allMigrations().filter((name) => (addonOnly ? !isStandaloneOnly(name) : true))
}

function main() {
  const argv = process.argv.slice(2)
  const addonOnly = argv.includes("--addon-only")

  const outIndex = argv.indexOf("--out")
  const out = outIndex !== -1 ? argv[outIndex + 1] : DEFAULT_OUT
  if (!out) {
    console.error("--out needs a path.")
    process.exit(1)
  }

  const chosen = bundledMigrations(addonOnly)
  if (chosen.length === 0) {
    console.error(`No migrations found in ${MIGRATIONS_DIR}.`)
    process.exit(1)
  }

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, buildBundle(addonOnly), "utf8")

  console.log(`\nWrote ${out} — ${chosen.length} migration(s), in this order:\n`)
  for (const name of chosen) console.log(`  ${name}`)
  if (out === DEFAULT_OUT) {
    console.log(`
Next:
  1. Supabase dashboard → SQL Editor → New query
  2. Paste the contents of ${out} and Run
  3. Put the project URL and the two API keys in .env.local
  4. npm run preflight

No CLI login, no database password, no connection string.
`)
  }
}

// Only when run directly, so the drift test can import buildBundle without
// this writing files as a side effect of the import.
if (process.argv[1]?.endsWith("sql-bundle.ts")) main()
