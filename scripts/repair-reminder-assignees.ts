/**
 * Re-point queued reminders that are addressed to the wrong agent.
 *
 * A one-off for data that drifted BEFORE reassign_contact_reminders existed.
 * Until then, changing a contact's agent updated `leads.assigned_member_id`
 * and stopped there — `reminders.member_id` was stamped when the row was
 * materialised and nothing re-read it, so every already-queued reminder went
 * on being delivered to the PREVIOUS agent while every screen showed the new
 * one. The fix stops new drift; this repairs what already happened.
 *
 * It does not reimplement the move. It calls the same RPC the app now calls,
 * passing the contact's CURRENT assigned_member_id — so this is exactly
 * "pretend the reassignment happened again", and running it twice is a no-op.
 *
 * Note the RPC SETS member_id to what it is given; it does not read the
 * contact's assignment itself. The scan therefore has to carry that value
 * through, and an earlier draft of this script passed null, which would have
 * unassigned every reminder it touched instead of repairing it.
 *
 * PAGINATED, because the scan is cross-tenant and PostgREST silently caps a
 * response at 1000 rows. An unpaginated version of this check reported zero
 * drift on a database that had plenty — it had simply never seen it.
 *
 *   npx tsx scripts/repair-reminder-assignees.ts --dry
 *   npx tsx scripts/repair-reminder-assignees.ts
 */

import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"

const envFile = process.env.ENV_FILE ?? ".env.local"
try {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const value = match[2].trim().replace(/^["']|["']$/g, "")
    if (!(match[1] in process.env)) process.env[match[1]] = value
  }
} catch {
  console.warn(`[repair] could not read ${envFile}`)
}

type Row = {
  id: string
  business_id: string
  member_id: string | null
  status: string
  contact_events: {
    lead_id: string
    leads: { name: string; assigned_member_id: string | null } | null
  } | null
}

async function main() {
  const dry = process.argv.includes("--dry")
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error("[repair] NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")
    process.exit(1)
  }
  const admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const PAGE = 1000
  const drifted = new Map<
    string,
    { businessId: string; name: string; assignedTo: string; count: number }
  >()
  let scanned = 0

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("reminders")
      .select(
        "id, business_id, member_id, status, contact_events!inner(lead_id, leads!inner(name, assigned_member_id))",
      )
      .in("status", ["queued", "claimed"])
      .order("id")
      .range(from, from + PAGE - 1)

    if (error) {
      console.error(`[repair] scan failed at offset ${from}: ${error.message}`)
      process.exit(1)
    }
    const rows = (data ?? []) as unknown as Row[]
    scanned += rows.length

    for (const r of rows) {
      const lead = r.contact_events?.leads
      const leadId = r.contact_events?.lead_id
      if (!lead || !leadId) continue
      // Only a contact that HAS an agent. An unassigned contact falls back to
      // the owner at send time by design, and its member_id is meant to differ.
      if (!lead.assigned_member_id) continue
      if (r.member_id === lead.assigned_member_id) continue

      const seen = drifted.get(leadId)
      if (seen) seen.count++
      else
        drifted.set(leadId, {
          businessId: r.business_id,
          name: lead.name,
          assignedTo: lead.assigned_member_id,
          count: 1,
        })
    }

    if (rows.length < PAGE) break
  }

  console.log(
    `[repair] scanned ${scanned} queued/claimed reminders; ${drifted.size} contact(s) addressed to the wrong agent.\n`,
  )
  if (drifted.size === 0) return

  for (const [leadId, info] of drifted) {
    if (dry) {
      console.log(`  would repair  ${info.name.padEnd(28)} ${info.count} reminder(s)`)
      continue
    }
    const { data, error } = await admin
      .rpc("reassign_contact_reminders", {
        p_business_id: info.businessId,
        p_lead_id: leadId,
        // The function SETS member_id to this — it does not read the contact's
        // assignment itself. Passing null here would silently unassign every
        // reminder it touched rather than repairing it.
        p_member_id: info.assignedTo,
      })
      .maybeSingle<{ moved: number; superseded: number }>()

    if (error) {
      console.error(`  FAILED        ${info.name}: ${error.message}`)
      continue
    }
    console.log(
      `  repaired      ${info.name.padEnd(28)} ${data?.moved ?? 0} moved, ${data?.superseded ?? 0} superseded`,
    )
  }
}

main().catch((err) => {
  console.error("[repair]", err)
  process.exit(1)
})
