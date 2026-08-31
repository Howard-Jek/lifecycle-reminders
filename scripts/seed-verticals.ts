/**
 * Seed ten demo contacts for EVERY vertical, isolated from each other.
 *
 * What this is for: there are twelve reminder packs, and reading a pack's
 * labels against somebody else's data tells you very little. A dental practice
 * whose contacts all hold "Singlife policy" is a pack you cannot actually
 * judge. This gives each vertical its own small book of clients, its own dates
 * and its own rules, so switching industries shows a coherent product rather
 * than new words over old rows.
 *
 * ISOLATION is by `leads.context.demo_vertical`. That is a demo tag in the
 * free-form bag the importer already uses for unmapped columns — no schema
 * change, and nothing in the product reads it except the dev-only scope in
 * src/lib/dev/vertical-scope.ts. Real contacts carry no such key, so they are
 * untouched and visible exactly as before whenever no override is active.
 *
 * NOTHING SEEDED HERE CAN EVER SEND. Every contact is assigned to a
 * DEACTIVATED team member, and deliverDue filters those out before the claim —
 * their reminders are held, not spent. The script refuses to run against a
 * business that has an active agent, so this stays true if it is pointed
 * somewhere else by mistake.
 *
 *   npx tsx scripts/seed-verticals.ts --business <uuid>
 *   npx tsx scripts/seed-verticals.ts --business <uuid> --dry
 *   npx tsx scripts/seed-verticals.ts --business <uuid> --clean
 */

import { readFileSync } from "node:fs"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"

const envFile = process.env.ENV_FILE ?? ".env.local"
try {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const value = match[2].trim().replace(/^["']|["']$/g, "")
    if (!(match[1] in process.env)) process.env[match[1]] = value
  }
} catch {
  console.warn(`[seed-verticals] could not read ${envFile}`)
}

const USAGE =
  "Usage: npx tsx scripts/seed-verticals.ts --business <uuid> [--dry] [--clean]"

/** The tag that makes a demo contact belong to one vertical. */
export const DEMO_VERTICAL_KEY = "demo_vertical"

const PER_VERTICAL = 10

/**
 * Names per vertical, so a switch lands on a plausible book rather than the
 * same ten people wearing different hats. Singapore-shaped, matching the
 * existing fixture.
 */
const NAMES: Record<string, string[]> = {
  insurance: ["Tan Wei Ming","Nurul Aisyah","Lim Hui Ling","Rajesh Kumar","Chloe Sim","Daniel Ong","Farah Iskandar","Goh Jia Hui","Marcus Teo","Priya Nair"],
  financial_advisory: ["Adrian Foo","Michelle Kwek","Suresh Pillai","Jasmine Low","Benjamin Chua","Nadiah Rahman","Kelvin Toh","Serene Yap","Arjun Mehta","Grace Lim"],
  mortgage: ["Wilson Ang","Siti Nurhaliza","Terence Goh","Rachel Neo","Hafiz Osman","Melvin Koh","Denise Tay","Ravi Shankar","Joanne Wee","Samuel Lau"],
  real_estate: ["Clarence Yeo","Aisha Latif","Jonathan Seah","Pearlyn Chan","Iqbal Hassan","Vanessa Lim","Desmond Poh","Anita Raj","Nicholas Tan","Fiona Ng"],
  dental: ["Evelyn Chong","Amirul Zaki","Bryan Loh","Sharon Ho","Devi Krishnan","Jeremy Wong","Natasha Ibrahim","Alvin Chew","Rebecca Soh","Kumar Selvam"],
  beauty: ["Cheryl Tan","Nabila Yusof","Germaine Lee","Sarah Menon","Valerie Quek","Zulaikha Aziz","Estelle Chin","Divya Rao","Amanda Goh","Rina Halim"],
  construction: ["Steven Lim","Ganesh Murthy","Roslan Bakar","Andy Chua","Peter Toh","Muthu Samy","Jeffrey Ng","Hakim Salleh","Ronald Sim","Bala Krishnan"],
  fitness: ["Ryan Tan","Farhan Ismail","Cassandra Lim","Dinesh Raj","Joel Ong","Syafiqah Nor","Marcus Yeo","Tanya Pereira","Ivan Koh","Michelle Ang"],
  home_services: ["Henry Sim","Aziz Rahman","Doreen Lau","Prakash Nair","Alex Tan","Norliza Hamid","Gerald Wee","Sunita Devi","Kenneth Phua","Mabel Chia"],
  saas: ["Nikhil Sharma","Jocelyn Tay","Wei Jie Lim","Amara Okafor","Dominic Ho","Hui Shan Chua","Rahul Verma","Elaine Png","Tobias Lim","Shanti Kumar"],
  training: ["Aaron Neo","Zubaidah Latif","Clement Kwok","Meera Pillai","Jayden Lim","Fatimah Zahra","Russell Tan","Anjali Sharma","Wesley Chong","Lydia Foo"],
  other: ["Ethan Chua","Salmah Kadir","Bernard Tay","Lakshmi Iyer","Owen Lim","Hidayah Rashid","Colin Seah","Radha Menon","Trevor Ng","Yasmin Ali"],
}

type Args = { business: string | null; dry: boolean; clean: boolean; unknown: string[] }

function parseArgs(argv: string[]): Args {
  const args: Args = { business: null, dry: false, clean: false, unknown: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dry") args.dry = true
    else if (arg === "--clean") args.clean = true
    else if (arg === "--business") args.business = argv[++i] ?? null
    else if (arg.startsWith("--business=")) args.business = arg.slice("--business=".length)
    else args.unknown.push(arg)
  }
  return args
}

/** A date `days` from today, as YYYY-MM-DD. */
function inDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

/** A birthday: a real past year, so age is plausible, on a spread of days. */
function birthday(index: number): string {
  const year = 1968 + ((index * 7) % 38)
  const d = new Date()
  d.setDate(d.getDate() + ((index * 13) % 300))
  return `${year}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.unknown.length > 0) {
    console.error(`[seed-verticals] I do not understand ${args.unknown.join(", ")}.\n${USAGE}`)
    process.exit(1)
  }
  if (!args.business) {
    console.error(`[seed-verticals] --business is required.\n${USAGE}`)
    process.exit(1)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error("[seed-verticals] NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")
    process.exit(1)
  }
  const admin: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const businessId = args.business
  const { VERTICALS } = await import("../src/lib/lifecycle/verticals")
  const { packForVertical } = await import("../src/lib/lifecycle/vertical-packs")

  // ── the safety gate ──────────────────────────────────────────────────────
  //
  // Demo contacts must never be able to receive a real WhatsApp. deliverDue
  // holds reminders for deactivated agents, so assigning every contact to one
  // makes that structural rather than a promise. Refusing to run where an
  // ACTIVE agent exists keeps it true if this is pointed somewhere else.
  const { data: members, error: memberErr } = await admin
    .from("team_members")
    .select("id, display_name, role, active")
    .eq("business_id", businessId)
  if (memberErr) {
    console.error(`[seed-verticals] could not read the roster: ${memberErr.message}`)
    process.exit(1)
  }
  const roster = members ?? []
  const active = roster.filter((m) => m.active)
  if (active.length > 0) {
    console.error(
      `[seed-verticals] REFUSING: business ${businessId} has ${active.length} ACTIVE team member(s) ` +
        `(${active.map((m) => m.display_name).join(", ")}).\n` +
        `  Demo contacts are only safe on a business whose agents are all deactivated, because that\n` +
        `  is what holds their reminders instead of sending them. Deactivate them, or pick another business.`,
    )
    process.exit(1)
  }
  const holder = roster[0]
  if (!holder) {
    console.error(`[seed-verticals] business ${businessId} has no team members to attribute to.`)
    process.exit(1)
  }

  if (args.clean) {
    const { data: gone, error } = await admin
      .from("leads")
      .delete()
      .eq("business_id", businessId)
      .not(`context->>${DEMO_VERTICAL_KEY}`, "is", null)
      .select("id")
    if (error) {
      console.error(`[seed-verticals] clean failed: ${error.message}`)
      process.exit(1)
    }
    console.log(`[seed-verticals] removed ${gone?.length ?? 0} previously seeded demo contacts.`)
    if (!args.dry) return
  }

  console.log(
    `[seed-verticals] ${args.dry ? "DRY RUN — " : ""}${VERTICALS.length} verticals x ${PER_VERTICAL} contacts, ` +
      `all attributed to ${holder.display_name} (deactivated), so nothing can send.\n`,
  )

  let contactCount = 0
  let eventCount = 0
  let ruleCount = 0

  for (const [vIndex, vertical] of VERTICALS.entries()) {
    const pack = packForVertical(vertical)
    const names = NAMES[vertical] ?? NAMES.other
    // Every pack's non-personal types — what this industry's contacts HOLD.
    const holdings = pack.eventTypes.filter((t) => t.slug !== "birthday" && t.slug !== "anniversary")

    const leadRows = names.slice(0, PER_VERTICAL).map((name, i) => ({
      business_id: businessId,
      name,
      // A block of its own, so demo numbers can never collide with a real
      // contact and are obvious at a glance in the table.
      phone: `+6598${String(vIndex).padStart(2, "0")}${String(1000 + i)}`,
      email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@demo-${vertical.replace(/_/g, "-")}.example`,
      assigned_member_id: holder.id,
      context: { [DEMO_VERTICAL_KEY]: vertical, demo: true },
    }))

    if (args.dry) {
      console.log(`  ${vertical.padEnd(20)} ${leadRows.length} contacts, ${holdings.length} date type(s): ${holdings.map((h) => h.slug).join(", ")}`)
      contactCount += leadRows.length
      continue
    }

    const { data: leads, error: leadErr } = await admin
      .from("leads")
      .upsert(leadRows, { onConflict: "business_id,phone" })
      .select("id, phone")
    if (leadErr) {
      console.error(`[seed-verticals] ${vertical}: contacts failed — ${leadErr.message}`)
      process.exit(1)
    }
    contactCount += leads?.length ?? 0

    // Events: one birthday each, plus this industry's own dates spread across
    // the next three months so the inbox has something in every tab.
    const eventRows: Record<string, unknown>[] = []
    for (const [i, lead] of (leads ?? []).entries()) {
      eventRows.push({
        business_id: businessId,
        lead_id: lead.id,
        event_type: "birthday",
        event_date: birthday(vIndex * PER_VERTICAL + i),
        recurrence: "yearly",
        source: "manual",
        payload: {},
      })
      for (const [h, holding] of holdings.entries()) {
        if (h >= 2) break // two holdings each is enough to read
        eventRows.push({
          business_id: businessId,
          lead_id: lead.id,
          event_type: holding.slug,
          label: holding.label,
          event_date: inDays(3 + ((i * 9 + h * 31) % 88)),
          recurrence: holding.recurrence,
          source: "manual",
          payload: { demo: true },
        })
      }
    }

    const { data: events, error: eventErr } = await admin
      .from("contact_events")
      .upsert(eventRows, { onConflict: "lead_id,event_type,event_date,label", ignoreDuplicates: true })
      .select("id")
    if (eventErr) {
      console.error(`[seed-verticals] ${vertical}: dates failed — ${eventErr.message}`)
      process.exit(1)
    }
    eventCount += events?.length ?? 0

    // The pack's own rules, so this vertical's dates actually produce
    // reminders. Without them the inbox is empty and the pack looks broken.
    const ruleRows = pack.rules.map((rule) => ({
      business_id: businessId,
      event_type: rule.event_type,
      offset_days: rule.offset_days,
      send_window: rule.send_window,
      audience: "assigned" as const,
      suggest_message: true,
      active: true,
    }))
    const { data: rules, error: ruleErr } = await admin
      .from("reminder_rules")
      .upsert(ruleRows, { onConflict: "business_id,event_type,offset_days", ignoreDuplicates: true })
      .select("id")
    if (ruleErr) {
      console.error(`[seed-verticals] ${vertical}: rules failed — ${ruleErr.message}`)
      process.exit(1)
    }
    ruleCount += rules?.length ?? 0

    console.log(
      `  ${vertical.padEnd(20)} ${leads?.length ?? 0} contacts, ${events?.length ?? 0} dates, ${rules?.length ?? 0} new rules`,
    )
  }

  console.log(
    `\n[seed-verticals] ${args.dry ? "would seed" : "seeded"} ${contactCount} contacts, ${eventCount} dates, ${ruleCount} rules.`,
  )
  if (!args.dry) {
    console.log("Run a tick (npm run reminders:tick) to materialise their reminders.")
  }
}

main().catch((err) => {
  console.error("[seed-verticals]", err)
  process.exit(1)
})
