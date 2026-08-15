/**
 * Enrol a new customer, now that self-serve signup is closed.
 *
 *   npx tsx scripts/invite-operator.ts --email new@agency.example
 *   npx tsx scripts/invite-operator.ts --email new@agency.example --seed-rules
 *   npx tsx scripts/invite-operator.ts --list
 *   npx tsx scripts/invite-operator.ts --revoke old@agency.example
 *
 * WHY A LINK RATHER THAN AN EMAIL
 *
 * `inviteUserByEmail()` asks Supabase to send the mail, and the free tier's
 * built-in SMTP allows roughly two an hour — we hit that limit during setup and
 * spent an afternoon believing signup was broken. `generateLink()` mints the
 * same one-time link and returns it instead of sending it, so enrolment does
 * not depend on a mail server at all. Send it however you already talk to the
 * customer.
 *
 * WHY NOT A PASSWORD
 *
 * The link lets them choose their own, so no password for a real person is ever
 * typed by an operator, pasted into a chat, or written to a terminal history.
 * The only secret this script prints is single-use and expires.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not create the business. `getTenant()` mints one on the invited
 * user's first authenticated request, so an invited operator, a seeded demo and
 * any pre-membership straggler all funnel through one code path — there is no
 * second way for a tenant to come into existence.
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
  console.warn(`[invite] could not read ${envFile} — relying on the ambient environment`)
}

const USAGE = `Usage:
  npx tsx scripts/invite-operator.ts --email <address> [--seed-rules]
  npx tsx scripts/invite-operator.ts --list
  npx tsx scripts/invite-operator.ts --revoke <address>`

function main() {
  const argv = process.argv.slice(2)
  const emailIdx = argv.indexOf("--email")
  const email = emailIdx >= 0 ? argv[emailIdx + 1] : undefined
  const revokeIdx = argv.indexOf("--revoke")
  const revoke = revokeIdx >= 0 ? argv[revokeIdx + 1] : undefined
  const list = argv.includes("--list")
  const seedRules = argv.includes("--seed-rules")

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.")
    process.exit(1)
  }

  const appUrl = process.env.APP_PUBLIC_URL?.trim()
  if (!appUrl && !list && !revoke) {
    console.error("APP_PUBLIC_URL must be set — it is where the invite link lands.")
    process.exit(1)
  }

  const admin = createClient(url, key, { auth: { persistSession: false } })

  const run = list
    ? listOperators(admin)
    : revoke
      ? revokeOperator(admin, revoke)
      : email
        ? invite(admin, email, appUrl!, seedRules)
        : Promise.reject(new Error(USAGE))

  run.catch((error) => {
    console.error(`\n[invite] ${(error as Error).message}\n`)
    process.exit(1)
  })
}

async function invite(
  admin: SupabaseClient,
  email: string,
  appUrl: string,
  seedRules: boolean,
): Promise<void> {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`"${email}" does not look like an email address.`)
  }

  const existing = await findUser(admin, email)
  if (existing) {
    // Not an error: re-inviting is the normal way to help somebody who lost the
    // first link or never got round to using it.
    console.log(`\n${email} already has an account — minting a fresh link instead.`)
  }

  const { data, error } = await admin.auth.admin.generateLink({
    // `invite` for a new account, `magiclink` for one that already exists —
    // `invite` fails on an existing user, which would otherwise make the
    // "lost my link" case impossible to serve.
    type: existing ? "magiclink" : "invite",
    email,
    options: { redirectTo: `${appUrl.replace(/\/$/, "")}/reminders` },
  })

  if (error) throw new Error(`could not mint a link: ${error.message}`)

  const link = data?.properties?.action_link
  if (!link) throw new Error("Supabase returned no action link.")

  if (seedRules) {
    console.log(
      "\nNote: --seed-rules does nothing until they sign in once — the business does not\n" +
        "exist until then. Run scripts/seed-demo.ts --email " +
        email +
        " afterwards.",
    )
  }

  console.log(`
────────────────────────────────────────────────────────────────────────
  Send this to ${email}. It is single-use and expires.
────────────────────────────────────────────────────────────────────────

${link}

  They set their own password on that page, and land on the reminder inbox
  with an empty business of their own.

  Then, to get them started:
    npx tsx scripts/seed-demo.ts --email ${email}      # roster + starter rules
────────────────────────────────────────────────────────────────────────
`)
}

async function listOperators(admin: SupabaseClient): Promise<void> {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) throw new Error(`could not list users: ${error.message}`)

  const { data: members } = await admin.from("business_members").select("user_id, business_id, role")
  const byUser = new Map((members ?? []).map((m) => [m.user_id as string, m]))

  console.log(`\n${data.users.length} account(s):\n`)
  for (const u of data.users) {
    const m = byUser.get(u.id)
    const confirmed = u.email_confirmed_at ? "active " : "PENDING"
    const business = m ? String(m.business_id).slice(0, 8) : "— no business yet"
    console.log(`  ${confirmed}  ${(u.email ?? "?").padEnd(34)} ${business}`)
  }
  console.log(
    "\n  PENDING means the invite link has not been used yet — they have no business.\n",
  )
}

/**
 * Remove an operator's access.
 *
 * Deleting the auth user is enough: `business_members.user_id` cascades from
 * auth.users, so the membership goes with it. The BUSINESS and all its data
 * survive on purpose — losing a customer's book because their login was removed
 * would be a far worse failure than an orphaned tenant, and the tenant can be
 * re-attached by inviting somebody else and re-pointing the membership.
 */
async function revokeOperator(admin: SupabaseClient, email: string): Promise<void> {
  const user = await findUser(admin, email)
  if (!user) throw new Error(`no account for ${email}`)

  const { data: membership } = await admin
    .from("business_members")
    .select("business_id")
    .eq("user_id", user.id)
    .maybeSingle<{ business_id: string }>()

  const { error } = await admin.auth.admin.deleteUser(user.id)
  if (error) throw new Error(`could not delete the account: ${error.message}`)

  console.log(`\n  Deleted the login for ${email}.`)
  if (membership) {
    console.log(
      `  Business ${membership.business_id} and all of its contacts, dates and reminders\n` +
        `  are UNTOUCHED and now have no member. Invite a replacement and attach them\n` +
        `  before anybody needs it.\n`,
    )
  } else {
    console.log("  They had no business.\n")
  }
}

async function findUser(admin: SupabaseClient, email: string) {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) throw new Error(`could not list users: ${error.message}`)
  return data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null
}

main()
