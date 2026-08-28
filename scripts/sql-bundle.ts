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
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const MIGRATIONS_DIR = "supabase/migrations"
const OUT = "supabase/bundle.sql"

/**
 * The migrations meant to be applied to the host app: the add-on's own tables,
 * plus everything that later ALTERS them.
 *
 * A list rather than one substring because the original assumed the add-on
 * would never gain a second migration. It has: `next_attempt_at` is a column on
 * `reminders`, a table this bundle creates, so a host that applied the bundle
 * without it would run app code selecting a column its database lacks — which
 * fails as an unreadable queue rather than as a missing feature.
 *
 * Deliberately NOT widened to every migration. sandbox, revoke_anon and
 * whatsapp_inbound are excluded today and stay excluded; whether they belong in
 * the host bundle is a separate question from keeping this one consistent.
 */
const ADDON = ["lifecycle_events", "reminder_retry_schedule"]

function main() {
  const addonOnly = process.argv.includes("--addon-only")

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    // Filename order IS apply order — the timestamps exist for exactly this.
    .sort()

  const chosen = addonOnly ? files.filter((f) => ADDON.some((name) => f.includes(name))) : files
  if (chosen.length === 0) {
    console.error(`No migrations found in ${MIGRATIONS_DIR}.`)
    process.exit(1)
  }

  const header = addonOnly
    ? [
        "-- LIFECYCLE — the add-on migration only.",
        "--",
        "-- This is the piece that merges into an existing GomaAI database. It",
        "-- expects businesses, business_members, leads, member_business_ids()",
        "-- and update_updated_at() to already exist.",
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

  writeFileSync(OUT, [...header, "", body].join("\n") + "\n", "utf8")

  console.log(`\nWrote ${OUT} — ${chosen.length} migration(s), in this order:\n`)
  for (const name of chosen) console.log(`  ${name}`)
  console.log(`
Next:
  1. Supabase dashboard → SQL Editor → New query
  2. Paste the contents of ${OUT} and Run
  3. Put the project URL and the two API keys in .env.local
  4. npm run preflight

No CLI login, no database password, no connection string.
`)
}

main()
