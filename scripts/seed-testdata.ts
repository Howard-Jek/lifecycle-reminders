/**
 * Fill a business with a believable book of clients, for testing at volume.
 *
 * `seed-demo.ts` builds the roster and the rules; the twelve-row fixture then
 * proves the import path works. Neither tells you what the product feels like
 * with two hundred clients in it — which is the only volume at which the
 * reminder queue, the coverage banner and the page timings mean anything.
 *
 *   npx tsx scripts/seed-testdata.ts --email you@example.com
 *   npx tsx scripts/seed-testdata.ts --email you@example.com --count 250
 *   npx tsx scripts/seed-testdata.ts --email you@example.com --imminent 60
 *   npx tsx scripts/seed-testdata.ts --email you@example.com --clean
 *   npx tsx scripts/seed-testdata.ts --email you@example.com --dry
 *
 * `--imminent N` exists because of a subtlety that makes a freshly seeded
 * database look broken. Dates spread across a year produce a queue that is
 * almost entirely UPCOMING, and the inbox opens on DUE — so the first thing you
 * see after seeding is "Nothing due right now", which is indistinguishable from
 * having no data at all. These N contacts carry dates already inside their lead
 * time, so the next tick has real work. Ask for more than MAX_DELIVERIES_PER_RUN
 * (40) and the cap leaves the remainder sitting in Due, which is what that tab
 * looks like on a working morning.
 *
 * Every row it writes is tagged `context.seed = 'testdata'`, so `--clean`
 * removes exactly what this wrote and cannot touch a real import. Nothing here
 * is random: the generator is seeded, so the same --count always produces the
 * same book, and a bug found on one run can be reproduced on the next.
 */

import { readFileSync } from "node:fs"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"

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
  console.warn(`[seed-testdata] could not read ${envFile} — relying on the ambient environment`)
}

const USAGE =
  "Usage: npx tsx scripts/seed-testdata.ts --email <operator email> " +
  "[--count 250] [--imminent 0] [--clean] [--dry]"

/** The marker that makes `--clean` safe. */
const SEED_TAG = "testdata"

// ── name parts ────────────────────────────────────────────────────────────
// Singapore-shaped, and deliberately including the cases the matcher and the
// drafter get wrong: surname-first Chinese names, Malay bin/binte patronymics,
// Indian s/o names, and Western given names.
const CHINESE_SURNAMES = ["Tan","Lim","Lee","Ng","Wong","Goh","Chua","Koh","Teo","Ong","Sim","Yeo","Chan","Low","Toh"]
const CHINESE_GIVEN = ["Wei Ming","Hui Ling","Jia Hui","Meng Huat","Boon Keng","Kai Xiang","Su Ling","Mei Fen","Wen Jie","Yi Xuan","Zhi Hao","Xin Yi","Jun Hao","Li Ying","Cheng Kiat"]
const MALAY_GIVEN = ["Nurul Aisyah","Muhammad Faizal","Siti Nadiah","Ahmad Zulkifli","Farhana","Iskandar","Nur Hidayah","Syafiq"]
const MALAY_FAMILY = ["Binte Rahman","Bin Osman","Binte Ismail","Bin Abdullah","Binte Hassan","Bin Yusof"]
const INDIAN_NAMES = ["Priya Devi Ramasamy","Ravi Chandran","Kavitha Menon","Suresh Kumar","Anitha Selvam","Rajesh Pillai","Deepa Nair"]
const WESTERN_NAMES = ["Rachel Foo","Daniel Ho","Melissa Chong","Jonathan Seah","Clara Tay","Marcus Yeo"]

const INSURERS = ["AIA","Great Eastern","Prudential","Manulife","Income","Etiqa","Singlife","HSBC Life"]

/** Deterministic PRNG (mulberry32), so a run is reproducible. */
function makeRandom(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function main() {
  const argv = process.argv.slice(2)
  const emailIdx = argv.indexOf("--email")
  const email = emailIdx >= 0 ? argv[emailIdx + 1] : undefined
  const countIdx = argv.indexOf("--count")
  const count = countIdx >= 0 ? Number(argv[countIdx + 1]) : 250
  const imminentIdx = argv.indexOf("--imminent")
  const imminent = imminentIdx >= 0 ? Number(argv[imminentIdx + 1]) : 0
  const clean = argv.includes("--clean")
  const dry = argv.includes("--dry")

  if (!email) {
    console.error(USAGE)
    process.exit(1)
  }
  // 0 is allowed so `--count 0 --imminent 60` can top up an existing book with
  // work that is due now, without generating another spread of contacts.
  if (!Number.isFinite(count) || count < 0 || count > 5000) {
    console.error("--count must be between 0 and 5000.")
    process.exit(1)
  }
  if (!Number.isFinite(imminent) || imminent < 0 || imminent > 1000) {
    console.error("--imminent must be between 0 and 1000.")
    process.exit(1)
  }
  if (count === 0 && imminent === 0 && !clean) {
    console.error("Nothing to do — pass --count and/or --imminent.")
    process.exit(1)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.")
    process.exit(1)
  }

  const admin = createClient(url, key, { auth: { persistSession: false } })
  run(admin, { email, count, imminent, clean, dry }).catch((error) => {
    console.error(`[seed-testdata] ${(error as Error).message}`)
    process.exit(1)
  })
}

async function run(
  admin: SupabaseClient,
  opts: { email: string; count: number; imminent: number; clean: boolean; dry: boolean },
) {
  const businessId = await resolveBusiness(admin, opts.email)
  console.log(`\nBusiness ${businessId}  (${opts.email})`)

  if (opts.clean) return removeSeed(admin, businessId, opts.dry)

  const { data: members } = await admin
    .from("team_members")
    .select("id, display_name")
    .eq("business_id", businessId)
    .eq("active", true)

  if (!members || members.length === 0) {
    throw new Error(
      "No active team members. Run scripts/seed-demo.ts first — without a roster every " +
        "generated client would land in the review queue, which tests the wrong thing.",
    )
  }
  console.log(`Roster: ${members.map((m) => m.display_name).join(", ")}`)

  const book = generateBook(
    opts.count,
    opts.imminent,
    members as { id: string; display_name: string }[],
  )

  console.log(
    `\nGenerating ${book.leads.length} contacts and ${book.events.length} dates` +
      `${opts.dry ? " (dry run — nothing will be written)" : ""}.`,
  )
  summarise(book)

  if (opts.dry) {
    console.log("\nSample:")
    for (const lead of book.leads.slice(0, 5)) {
      const dates = book.events.filter((e) => e.phone === lead.phone)
      console.log(
        `  ${lead.name.padEnd(26)} ${lead.phone}  ${dates
          .map((d) => `${d.event_type}=${d.event_date}`)
          .join("  ")}`,
      )
    }
    return
  }

  // Leads first: contact_events keys off leads.id, which only exists once the
  // leads are in. Same ordering the real import uses.
  const leadIdByPhone = await upsertLeads(admin, businessId, book.leads)
  const events = await upsertEvents(admin, businessId, book.events, leadIdByPhone)
  const assigned = await applyAssignments(admin, businessId, book.leads, leadIdByPhone)

  console.log(`\nWrote ${leadIdByPhone.size} contacts, ${events} dates, ${assigned} assignments.`)
  console.log(`\nNext:  npm run reminders:tick    # materialise the queue`)
  console.log(`Undo:  npx tsx scripts/seed-testdata.ts --email ${opts.email} --clean\n`)
}

// ── generation ────────────────────────────────────────────────────────────

type SeedLead = {
  name: string
  phone: string
  email: string | null
  memberId: string | null
}
type SeedEvent = {
  phone: string
  event_type: string
  event_date: string
  label: string | null
  recurrence: "none" | "yearly"
}

function generateBook(
  count: number,
  imminent: number,
  members: { id: string; display_name: string }[],
) {
  const rand = makeRandom(20260813)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]
  const today = new Date()

  const leads: SeedLead[] = []
  const events: SeedEvent[] = []
  const usedPhones = new Set<string>()

  for (let i = 0; i < count; i++) {
    const name = generateName(rand, pick)

    // 8xxx/9xxx is the SG mobile range. Sequential rather than random so a
    // collision is impossible and the numbers stay stable across runs.
    let phone = `+65${rand() < 0.5 ? 8 : 9}${String(100000 + i).padStart(7, "0").slice(-7)}`
    while (usedPhones.has(phone)) phone = `+65${9}${String(200000 + i).padStart(7, "0").slice(-7)}`
    usedPhones.add(phone)

    // One in twelve is unassigned, which is a legitimate state and the one
    // whose reminders fall back to the owner.
    const memberId = rand() < 1 / 12 ? null : pick(members).id

    leads.push({
      name,
      phone,
      email: rand() < 0.75 ? `${slug(name)}@example.com` : null,
      memberId,
    })

    // Everyone has a birthday. Ages 24–68.
    const dob = new Date(today)
    dob.setFullYear(today.getFullYear() - (24 + Math.floor(rand() * 45)))
    dob.setMonth(Math.floor(rand() * 12))
    dob.setDate(1 + Math.floor(rand() * 28))
    events.push({
      phone,
      event_type: "birthday",
      event_date: iso(dob),
      label: null,
      recurrence: "yearly",
    })

    // Most carry a policy expiry, spread across the next 18 months so the
    // queue has something due now, something this month, and a long tail.
    if (rand() < 0.85) {
      const expiry = new Date(today)
      expiry.setDate(today.getDate() + Math.floor(rand() * 540) - 20)
      events.push({
        phone,
        event_type: "policy_expiry",
        event_date: iso(expiry),
        label: `${pick(INSURERS)} policy`,
        recurrence: "none",
      })
    }

    // A third have a scheduled review.
    if (rand() < 0.33) {
      const review = new Date(today)
      review.setDate(today.getDate() + Math.floor(rand() * 300))
      events.push({
        phone,
        event_type: "policy_review",
        event_date: iso(review),
        label: null,
        recurrence: "none",
      })
    }
  }

  // Contacts whose dates are ALREADY inside their lead time, so the next tick
  // has something to do. The offsets are chosen against the seeded rules —
  // birthday at -7 and -0, policy_expiry at -30 and -7 — so every one of these
  // is genuinely due rather than being forced due by fiddling with due_at.
  for (let i = 0; i < imminent; i++) {
    const name = generateName(rand, pick)
    const phone = `+6588${String(500000 + i).padStart(6, "0").slice(-6)}`
    usedPhones.add(phone)
    leads.push({
      name,
      phone,
      email: `${slug(name)}@example.com`,
      memberId: rand() < 1 / 12 ? null : pick(members).id,
    })

    if (i % 2 === 0) {
      // A birthday within the week: inside the -7 rule.
      const bday = new Date(today)
      bday.setFullYear(today.getFullYear() - (25 + Math.floor(rand() * 40)))
      bday.setMonth(today.getMonth())
      bday.setDate(today.getDate() + Math.floor(rand() * 6))
      events.push({ phone, event_type: "birthday", event_date: iso(bday), label: null, recurrence: "yearly" })
    } else {
      // An expiry inside the -30 rule, some of them inside -7 as well.
      const expiry = new Date(today)
      expiry.setDate(today.getDate() + 1 + Math.floor(rand() * 26))
      events.push({
        phone,
        event_type: "policy_expiry",
        event_date: iso(expiry),
        label: `${pick(INSURERS)} policy`,
        recurrence: "none",
      })
    }
  }

  return { leads, events }
}

function generateName(rand: () => number, pick: <T>(xs: readonly T[]) => T): string {
  const roll = rand()
  // Surname first, which is the case the drafter used to get wrong — "Hi Goh"
  // instead of "Hi Mr Goh".
  if (roll < 0.55) return `${pick(CHINESE_SURNAMES)} ${pick(CHINESE_GIVEN)}`
  if (roll < 0.75) return `${pick(MALAY_GIVEN)} ${pick(MALAY_FAMILY)}`
  if (roll < 0.9) return pick(INDIAN_NAMES)
  return pick(WESTERN_NAMES)
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "")
const iso = (d: Date) => d.toISOString().slice(0, 10)

function summarise(book: { leads: SeedLead[]; events: SeedEvent[] }) {
  const byType = new Map<string, number>()
  for (const e of book.events) byType.set(e.event_type, (byType.get(e.event_type) ?? 0) + 1)
  const unassigned = book.leads.filter((l) => l.memberId === null).length
  console.log(
    `  ${[...byType].map(([t, n]) => `${t}: ${n}`).join("   ")}   unassigned contacts: ${unassigned}`,
  )
}

// ── writes ────────────────────────────────────────────────────────────────

const CHUNK = 500

async function upsertLeads(admin: SupabaseClient, businessId: string, leads: SeedLead[]) {
  for (let i = 0; i < leads.length; i += CHUNK) {
    const rows = leads.slice(i, i + CHUNK).map((l) => ({
      business_id: businessId,
      name: l.name,
      phone: l.phone,
      email: l.email,
      // The tag that makes --clean exact. Nothing else writes it.
      context: { seed: SEED_TAG },
    }))
    const { error } = await admin
      .from("leads")
      .upsert(rows, { onConflict: "business_id,phone", ignoreDuplicates: false })
    if (error) throw new Error(`lead upsert failed: ${error.message}`)
    process.stdout.write(`  leads ${Math.min(i + CHUNK, leads.length)}/${leads.length}\r`)
  }

  const byPhone = new Map<string, string>()
  const phones = leads.map((l) => l.phone)
  for (let i = 0; i < phones.length; i += CHUNK) {
    const { data, error } = await admin
      .from("leads")
      .select("id, phone")
      .eq("business_id", businessId)
      .in("phone", phones.slice(i, i + CHUNK))
    if (error) throw new Error(`lead lookup failed: ${error.message}`)
    for (const row of data ?? []) byPhone.set(row.phone as string, row.id as string)
  }
  console.log()
  return byPhone
}

async function upsertEvents(
  admin: SupabaseClient,
  businessId: string,
  events: SeedEvent[],
  leadIdByPhone: Map<string, string>,
) {
  const rows = events
    .map((e) => {
      const leadId = leadIdByPhone.get(e.phone)
      if (!leadId) return null
      return {
        business_id: businessId,
        lead_id: leadId,
        event_type: e.event_type,
        label: e.label,
        event_date: e.event_date,
        recurrence: e.recurrence,
        source: "import",
        payload: { seed: SEED_TAG },
      }
    })
    .filter(Boolean) as Record<string, unknown>[]

  let written = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await admin
      .from("contact_events")
      .upsert(rows.slice(i, i + CHUNK), {
        // The same identity the importer relies on, so re-running is a no-op
        // rather than a pile of duplicates.
        onConflict: "lead_id,event_type,event_date,label",
        ignoreDuplicates: true,
      })
    if (error) throw new Error(`event upsert failed: ${error.message}`)
    written += Math.min(CHUNK, rows.length - i)
    process.stdout.write(`  dates ${written}/${rows.length}\r`)
  }
  console.log()
  return written
}

async function applyAssignments(
  admin: SupabaseClient,
  businessId: string,
  leads: SeedLead[],
  leadIdByPhone: Map<string, string>,
) {
  // Grouped by member — one UPDATE per agent rather than one per lead, which
  // is what the importer does and the reason a 250-row book is three calls.
  const byMember = new Map<string, string[]>()
  for (const lead of leads) {
    if (!lead.memberId) continue
    const id = leadIdByPhone.get(lead.phone)
    if (!id) continue
    const list = byMember.get(lead.memberId) ?? []
    list.push(id)
    byMember.set(lead.memberId, list)
  }

  let assigned = 0
  for (const [memberId, leadIds] of byMember) {
    for (let i = 0; i < leadIds.length; i += CHUNK) {
      const slice = leadIds.slice(i, i + CHUNK)
      const { error } = await admin
        .from("leads")
        .update({ assigned_member_id: memberId })
        .eq("business_id", businessId)
        .in("id", slice)
      if (error) throw new Error(`assignment failed: ${error.message}`)
      assigned += slice.length
    }
  }
  return assigned
}

// ── removal ───────────────────────────────────────────────────────────────

async function removeSeed(admin: SupabaseClient, businessId: string, dry: boolean) {
  const { data: seeded, error } = await admin
    .from("leads")
    .select("id")
    .eq("business_id", businessId)
    .contains("context", { seed: SEED_TAG })
  if (error) throw new Error(`could not list seeded contacts: ${error.message}`)

  const ids = (seeded ?? []).map((r) => r.id as string)
  console.log(`\n${ids.length} seeded contacts found.`)
  if (ids.length === 0) return

  if (dry) {
    console.log("Dry run — nothing deleted.")
    return
  }

  // contact_events and reminders cascade from leads, so this is one delete.
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { error: delError } = await admin
      .from("leads")
      .delete()
      .eq("business_id", businessId)
      .in("id", ids.slice(i, i + CHUNK))
    if (delError) throw new Error(`delete failed: ${delError.message}`)
    process.stdout.write(`  removed ${Math.min(i + CHUNK, ids.length)}/${ids.length}\r`)
  }
  console.log(`\nRemoved ${ids.length} seeded contacts and everything that hung off them.\n`)
}

// ── plumbing ──────────────────────────────────────────────────────────────

async function resolveBusiness(admin: SupabaseClient, email: string): Promise<string> {
  const { data: users, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) throw new Error(`could not list users: ${error.message}`)

  const user = users.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
  if (!user) throw new Error(`No account for ${email}. Sign up first, then re-run.`)

  const { data: membership } = await admin
    .from("business_members")
    .select("business_id")
    .eq("user_id", user.id)
    .maybeSingle<{ business_id: string }>()

  if (!membership) {
    throw new Error(`${email} has no business yet. Sign in once so one is minted, then re-run.`)
  }
  return membership.business_id
}

main()
