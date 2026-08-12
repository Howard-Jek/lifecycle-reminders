/**
 * Seed a business with the demo team roster and the starting reminder rules.
 *
 * tests/fixtures/sample-clients.csv names three servicing FAs. Attribution is
 * deterministic — an agent name that matches nothing becomes a review row
 * rather than a guess — so importing that file against an empty roster puts
 * every client in the review queue and demonstrates nothing. This script is the
 * roster those names resolve against, and the rules that turn the imported
 * dates into a queue.
 *
 *   npx tsx scripts/seed-demo.ts --email you@example.com
 *   npx tsx scripts/seed-demo.ts --email you@example.com --dry
 */

import { readFileSync } from "node:fs"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import type { TeamMember, TeamMemberRole } from "../src/lib/lifecycle/types"

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
  console.warn(`[seed-demo] could not read ${envFile} — relying on the ambient environment`)
}

const USAGE = "Usage: npx tsx scripts/seed-demo.ts --email <operator email> [--dry]"

const FIXTURE = "tests/fixtures/sample-clients.csv"

/**
 * The roster the fixture's "Servicing FA" column attributes against.
 *
 * These display names must stay byte-identical to the ones in the CSV: the
 * match is exact (after case folding and honorific stripping), so a typo here
 * is silently a review row rather than an assignment.
 *
 * Exactly one owner, because the owner's number is where a reminder for an
 * UNASSIGNED client lands — the fixture has one deliberately blank FA cell to
 * exercise that path.
 *
 * The numbers are placeholders in the SG mobile range. They are real enough to
 * store and match, and reach nobody: delivery only leaves the process once
 * REMINDER_DRY_RUN is cleared, which is the point at which the operator must
 * replace them on /team.
 */
const DEMO_TEAM: ReadonlyArray<{
  display_name: string
  email: string
  whatsapp_number: string
  role: TeamMemberRole
}> = [
  {
    display_name: "Priscilla Ng",
    email: "priscilla.ng@demo-agency.example",
    whatsapp_number: "+6591110022",
    role: "owner",
  },
  {
    display_name: "Jasmine Tan",
    email: "jasmine.tan@demo-agency.example",
    whatsapp_number: "+6592220033",
    role: "agent",
  },
  {
    display_name: "Marcus Lee",
    email: "marcus.lee@demo-agency.example",
    whatsapp_number: "+6593330044",
    role: "agent",
  },
]

type Args = { email: string | null; dry: boolean; unknown: string[] }

function parseArgs(argv: string[]): Args {
  const args: Args = { email: null, dry: false, unknown: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dry") args.dry = true
    else if (arg === "--email") args.email = argv[++i] ?? null
    else if (arg.startsWith("--email=")) args.email = arg.slice("--email=".length)
    else args.unknown.push(arg)
  }
  return args
}

type Resolved =
  | { ok: true; userId: string; businessId: string }
  | { ok: false; error: string }

/** One roster line, column-aligned so a name that does not match the CSV is
 * obvious at a glance rather than buried in prose. */
function rosterLine(member: { display_name: string; role: string; whatsapp_number: string }) {
  return `${member.display_name.padEnd(14)} ${member.role.padEnd(6)} ${member.whatsapp_number}`
}

type RosterRow = Pick<TeamMember, "id" | "display_name" | "whatsapp_number" | "role" | "active">

/**
 * Which business this operator's seat belongs to.
 *
 * Returns the failure rather than throwing, because every one of them is
 * something the operator fixes and retries — a typo'd address, or an account
 * that has never signed in.
 */
async function resolveBusiness(admin: SupabaseClient, email: string): Promise<Resolved> {
  const wanted = email.trim().toLowerCase()

  // listUsers has no email filter, so the page walk IS the lookup. 200 a page
  // keeps a demo project to one round-trip without risking GoTrue's cap.
  const PER_PAGE = 200
  let userId: string | null = null
  for (let page = 1; !userId; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE })
    if (error) {
      return {
        ok: false,
        error:
          `Could not list this project's users: ${error.message}. Check that ` +
          `NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in ${envFile} point at a ` +
          `live project — the placeholders in .env.example fail exactly like this.`,
      }
    }
    const found = data.users.find((user) => user.email?.toLowerCase() === wanted)
    if (found) userId = found.id
    else if (data.users.length < PER_PAGE) break
  }

  if (!userId) {
    return {
      ok: false,
      error:
        `No account with the email ${email} exists in this Supabase project. Sign up in the ` +
        `app first, then run this again with the address you signed up with.`,
    }
  }

  const { data: membership, error: membershipError } = await admin
    .from("business_members")
    .select("business_id")
    .eq("user_id", userId)
    .maybeSingle<{ business_id: string }>()

  if (membershipError) {
    return {
      ok: false,
      error: `Could not read that account's membership: ${membershipError.message}`,
    }
  }

  // Deliberately NOT minted here. getTenant() creates the business and its
  // owner membership on the first authenticated request, and it is the only
  // place that happens — a second implementation in a seed script is how two
  // businesses end up owned by one person, each holding half the demo.
  if (!membership) {
    return {
      ok: false,
      error:
        `${email} has an account but no business yet. Sign in to the app once — the first ` +
        `authenticated request creates the business — then run this again.`,
    }
  }

  return { ok: true, userId, businessId: membership.business_id }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.unknown.length > 0) {
    console.error(`[seed-demo] I do not understand ${args.unknown.join(", ")}.\n${USAGE}`)
    process.exit(1)
  }
  if (!args.email) {
    console.error(`[seed-demo] Tell me whose business to seed.\n${USAGE}`)
    process.exit(1)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  // Not assertEnv(): seeding needs neither CRON_SECRET nor APP_PUBLIC_URL, and
  // failing on those would send the operator off to fix the wrong variable.
  if (!url || !serviceRoleKey) {
    console.error(
      "[seed-demo] Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in " +
        `${envFile} before seeding — see .env.example. This script writes as the ` +
        "service role, so the anon key is not enough.",
    )
    process.exit(1)
  }

  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const resolved = await resolveBusiness(admin, args.email)
  if (!resolved.ok) {
    console.error(`[seed-demo] ${resolved.error}`)
    process.exit(1)
  }
  const { businessId } = resolved

  const { data: existingRows, error: rosterError } = await admin
    .from("team_members")
    .select("id, display_name, whatsapp_number, role, active")
    .eq("business_id", businessId)
  if (rosterError) {
    console.error(`[seed-demo] Could not read the existing team roster: ${rosterError.message}`)
    process.exit(1)
  }
  const existing = (existingRows ?? []) as RosterRow[]

  // Imported after the env loader has run, exactly as scripts/tick.ts does:
  // anything under src/ is free to read process.env at module scope.
  const { DEFAULT_INSURANCE_RULES } = await import("../src/lib/lifecycle/types")
  const { normalizeName } = await import("../src/lib/lifecycle/match-member")

  const numbers = new Set(existing.map((member) => member.whatsapp_number))
  const names = new Map<string, RosterRow>()
  for (const member of existing) names.set(normalizeName(member.display_name), member)

  const toSeed: Array<(typeof DEMO_TEAM)[number]> = []
  const conflicts: string[] = []
  for (const member of DEMO_TEAM) {
    const clash = names.get(normalizeName(member.display_name))
    // A second "Jasmine Tan" on a different number makes every CSV row naming
    // her AMBIGUOUS, which sends the whole book to review. Leave the roster as
    // the operator has it and say so.
    if (clash && clash.whatsapp_number !== member.whatsapp_number) {
      conflicts.push(
        `${member.display_name} is already on the roster on ${clash.whatsapp_number}, so ` +
          `${member.whatsapp_number} was not added — a second row with the same name would ` +
          `make every "${member.display_name}" in the CSV ambiguous.`,
      )
      continue
    }
    toSeed.push(member)
  }

  const memberRows = toSeed.map((member) => ({ business_id: businessId, ...member }))
  // `label` is operator-facing copy on the constant, not a column.
  const ruleRows = DEFAULT_INSURANCE_RULES.map((rule) => ({
    business_id: businessId,
    event_type: rule.event_type,
    offset_days: rule.offset_days,
    send_window: rule.send_window,
  }))

  if (args.dry) {
    console.log(`[seed-demo] DRY RUN — nothing will be written to business ${businessId}.\n`)
    console.log("Team members:")
    for (const member of memberRows) {
      const verb = numbers.has(member.whatsapp_number) ? "update" : "add"
      console.log(`  ${verb.padEnd(6)} ${rosterLine(member)}`)
    }
    for (const conflict of conflicts) console.log(`  skip   ${conflict}`)
    console.log(`\nReminder rules: ${ruleRows.length} would be offered, and any that already exist`)
    console.log("would be left exactly as they are.")
    for (const rule of DEFAULT_INSURANCE_RULES) {
      console.log(`  ${rule.label} (${rule.event_type}, ${rule.offset_days}d, ${rule.send_window})`)
    }
    console.log("\nRun the same command without --dry to write it.")
    return
  }

  // Guarded rather than upserting an empty array, which every conflicting name
  // would produce and PostgREST would answer with a pointless round-trip.
  let membersAdded = 0
  if (memberRows.length > 0) {
    // Upserted on the roster's own unique key, so re-running corrects a name or
    // role instead of failing on the second attempt.
    const { data: writtenMembers, error: memberError } = await admin
      .from("team_members")
      .upsert(memberRows, { onConflict: "business_id,whatsapp_number" })
      .select("id, whatsapp_number")
    if (memberError) {
      console.error(`[seed-demo] Could not write the team roster: ${memberError.message}`)
      process.exit(1)
    }
    membersAdded = (writtenMembers ?? []).filter(
      (member) => !numbers.has(member.whatsapp_number as string),
    ).length
  }

  // ignoreDuplicates, so a rule the operator has since tuned — a different send
  // window, or switched off — survives every re-run untouched.
  const { data: writtenRules, error: ruleError } = await admin
    .from("reminder_rules")
    .upsert(ruleRows, {
      onConflict: "business_id,event_type,offset_days",
      ignoreDuplicates: true,
    })
    .select("id")
  if (ruleError) {
    console.error(`[seed-demo] Could not write the reminder rules: ${ruleError.message}`)
    process.exit(1)
  }
  const rulesAdded = writtenRules?.length ?? 0

  console.log(`[seed-demo] Business ${businessId} is seeded.`)
  console.log(
    `  Team roster: ${membersAdded} added, ${memberRows.length - membersAdded} already there.`,
  )
  for (const member of memberRows) console.log(`    ${rosterLine(member)}`)
  for (const conflict of conflicts) console.log(`  Skipped: ${conflict}`)
  console.log(
    `  Reminder rules: ${rulesAdded} added, ${ruleRows.length - rulesAdded} already there. ` +
      "Existing rules are never overwritten.",
  )
  console.log(
    "\n  Those roster numbers are placeholders and reach nobody. Replace them on /team " +
      "before you clear REMINDER_DRY_RUN.",
  )
  console.log("\n  Next:")
  console.log(`    1. npm run dev, then upload ${FIXTURE} at /import.`)
  console.log("       The wizard reads Servicing FA as the agent column and detects DD/MM/YYYY")
  console.log("       from the data. One row names an FA who is not on the roster and one leaves")
  console.log("       it blank — the first goes to review, the second is simply unassigned.")
  console.log("    2. npm run reminders:tick")
  console.log("       Run it twice: the second run materialises 0 and delivers 0.")
}

main().catch((err) => {
  console.error(
    `[seed-demo] Seeding stopped: ${err instanceof Error ? err.message : String(err)}. ` +
      "Nothing was left half-written — every write here is a single upsert — so fixing the " +
      "cause and running the command again is safe.",
  )
  process.exit(1)
})
