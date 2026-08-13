/**
 * Preflight — the operator's doctor.
 *
 * Answers one question in one command: what is configured, what is missing,
 * and what do I do about it?
 *
 * Bring-up spans a Supabase project, a Meta template awaiting review, two AI
 * keys and a dry-run flag — and every one of them fails QUIETLY. Zero rules
 * stores dates and never sends. No owner resolves every reminder 'skipped'. A
 * dry run reports success while nothing reaches WhatsApp. None of that raises
 * an error anywhere, so without this script "am I ready to send?" is answered
 * by waiting to see whether a phone buzzes.
 *
 * Read-only: nothing here writes a row, registers a template or sends a
 * message. Safe to run against production.
 *
 *   npx tsx scripts/preflight.ts
 */

import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import type { SupabaseClient } from "@supabase/supabase-js"

// Load .env.local by hand: this runs outside Next, which is what does it in
// the app. ENV_FILE overrides, matching the host's script convention.
const envFile = process.env.ENV_FILE ?? ".env.local"
let envFileRead = true
try {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const value = match[2].trim().replace(/^["']|["']$/g, "")
    if (!(match[1] in process.env)) process.env[match[1]] = value
  }
} catch {
  // Recorded rather than warned about here: a missing env file is a FINDING,
  // and findings belong in the checklist below, not above its header.
  envFileRead = false
}

// ── Reporting ───────────────────────────────────────────────────────────────

type Level = "PASS" | "WARN" | "FAIL"

type Check = { level: Level; title: string; remedy: string | null }

const results: Check[] = []

const TITLE_WIDTH = 20
const BADGE_WIDTH = 4 // PASS / WARN / FAIL are all four characters wide
const REMEDY_INDENT = " ".repeat(2 + BADGE_WIDTH + 2 + TITLE_WIDTH + 2)

// Colour only when attached to a terminal: piping this report into a file or a
// CI log should not fill it with escape codes.
const COLOUR: Record<Level, string> = { PASS: "32", WARN: "33", FAIL: "31" }
function badge(level: Level): string {
  return process.stdout.isTTY ? `\u001b[${COLOUR[level]}m${level}\u001b[0m` : level
}

/**
 * Print a check the moment it resolves. The Supabase and Meta probes take
 * seconds each, and an operator watching a blank screen assumes a hang.
 */
function report(level: Level, title: string, detail: string, remedy?: string): void {
  results.push({ level, title, remedy: remedy ?? null })
  console.log(`  ${badge(level)}  ${title.padEnd(TITLE_WIDTH)}  ${detail}`)
  if (remedy) console.log(`${REMEDY_INDENT}→ ${remedy}`)
}

/** Every database-backed check says the same thing when there is no client. */
function reportNoDatabase(title: string): void {
  report("WARN", title, "not checked — Supabase is unreachable", "Fix Supabase above, then re-run.")
}

// ── Probes ──────────────────────────────────────────────────────────────────

/**
 * A doctor that hangs is worse than one that reports a failure: an unreachable
 * Supabase or Graph host otherwise sits in TCP retry for minutes.
 */
const PROBE_TIMEOUT_MS = 10000

function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

/**
 * What a `head: true` count query resolves to. Declared structurally so a
 * query builder can be handed straight over without importing PostgREST's
 * generic builder types, which change shape between minor versions.
 */
type CountQuery = PromiseLike<{ count: number | null; error: { message: string } | null }>

type CountResult = { ok: true; count: number } | { ok: false; error: string }

/**
 * Counting never throws here — a dead connection is a finding, not a crash.
 *
 * `count === null` is treated as FAILURE, and that is the whole point. A HEAD
 * request against a table that does not exist comes back 204 with no body, so
 * PostgREST has nowhere to put the error and supabase-js reports
 * `{ count: null, error: null }` — success, with no number. An earlier version
 * read that as `count ?? 0` and cheerfully printed "businesses 0" for a
 * completely empty project, which is precisely the situation this script
 * exists to catch.
 *
 * A genuine exact count is always a number. Null means the question was never
 * answered, whatever `error` says.
 */
async function runCount(query: CountQuery): Promise<CountResult> {
  try {
    const { count, error } = await query
    if (error) return { ok: false, error: error.message }
    if (count === null) return { ok: false, error: NO_COUNT }
    return { ok: true, count }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Sentinel meaning "the HEAD probe told us nothing" — replaced with the real
 * message by countTable() below. */
const NO_COUNT = "__no_count__"

function countRows(admin: SupabaseClient, table: string): CountQuery {
  return admin.from(table).select("*", { count: "exact", head: true })
}

/**
 * Count a table, falling back to a bodied request for the real error.
 *
 * HEAD is used first because it is the cheap path and it is what succeeds
 * almost always. When it comes back without a count, one GET is issued purely
 * to obtain PostgREST's actual message — "Could not find the table
 * 'public.leads' in the schema cache" tells an operator exactly what is wrong;
 * a bare "no count returned" does not.
 */
async function countTable(admin: SupabaseClient, table: string): Promise<CountResult> {
  const head = await runCount(countRows(admin, table))
  if (head.ok || head.error !== NO_COUNT) return head

  const { error } = await admin.from(table).select("*").limit(1)
  return {
    ok: false,
    error: error?.message ?? `no rows and no count returned for "${table}"`,
  }
}

/** The tables this add-on owns, plus the host table they all hang off. */
const TABLES = ["businesses", "team_members", "contact_events", "reminder_rules", "reminders"]

const REMINDER_STATUSES = ["queued", "claimed", "sent", "failed", "skipped"]

/**
 * Required variables, restated rather than imported from src/lib/env.ts.
 *
 * assertEnv() THROWS, so it can only ever report the first class of problem it
 * meets; the doctor's job is to list every one in a single run. assertEnv() is
 * still called at the end as the tie-breaker, so the two can never disagree.
 */
const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "APP_PUBLIC_URL",
  "CRON_SECRET",
]

/** Values shipped in .env.example / .env.local that are not real credentials. */
function looksLikePlaceholder(value: string): boolean {
  const v = value.toLowerCase()
  return v.includes("<project-ref>") || v.includes("placeholder") || v.includes("your-")
}

/** Which signal decided production, so a surprising verdict is explainable. */
function runtimeLabel(): string {
  if (process.env.VERCEL_ENV) return `VERCEL_ENV=${process.env.VERCEL_ENV}`
  if (process.env.APP_ENV) return `APP_ENV=${process.env.APP_ENV}`
  if (process.env.NODE_ENV) return `NODE_ENV=${process.env.NODE_ENV}`
  // env.ts fails closed, and this is exactly the case that surprises people.
  return "no VERCEL_ENV/APP_ENV/NODE_ENV set, which env.ts treats as production"
}

type TemplateProbe =
  | { ok: true; status: string | null }
  | { ok: false; error: string }

/** Ask Meta for one template's review status. Never throws. */
async function probeTemplate(
  graphVersion: string,
  wabaId: string,
  accessToken: string,
  templateName: string,
): Promise<TemplateProbe> {
  // Token goes in the Authorization header, never the query string: this URL
  // ends up in shell history and in any log the operator pastes into a ticket.
  const url =
    `https://graph.facebook.com/${graphVersion}/${wabaId}/message_templates` +
    `?fields=name,status,language&limit=100`
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      PROBE_TIMEOUT_MS,
    )
    const data = (await res.json().catch(() => null)) as
      | { data?: { name?: string; status?: string }[]; error?: { message?: string } }
      | null
    if (!res.ok) {
      return { ok: false, error: data?.error?.message ?? `HTTP ${res.status} from Meta` }
    }
    // Matched here rather than with Meta's `name` filter, which matches by
    // prefix — "client_event_reminder_v2" must not answer for this one.
    const match = (data?.data ?? []).find((t) => t.name === templateName)
    return { ok: true, status: match?.status ?? null }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── The checklist ───────────────────────────────────────────────────────────

async function main() {
  const { assertEnv, isDryRun, isProductionRuntime, appPublicUrl } = await import("../src/lib/env")
  const { GRAPH_API_VERSION } = await import("../src/lib/whatsapp-graph-version")
  const { CLIENT_EVENT_REMINDER_TEMPLATE } = await import("../src/lib/notify/client-event-reminder")

  console.log("\nLifecycle reminders — preflight\n")
  console.log(
    envFileRead
      ? `  Environment from ${envFile} (ambient variables win).\n`
      : `  Could not read ${envFile} — checking the ambient environment only.\n`,
  )

  const dryRun = isDryRun()
  const production = isProductionRuntime()

  /**
   * Under dry run the sender substitutes stand-ins for missing WhatsApp
   * credentials (see getGomaSender), so a gap that would stop every send in a
   * live run genuinely does not block a dry one. Mirroring that here keeps the
   * doctor honest in both directions.
   */
  const whenLive = (): Level => (dryRun ? "WARN" : "FAIL")

  // 1. Required environment ─────────────────────────────────────────────────
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim())
  if (missing.length > 0) {
    report(
      "FAIL",
      "Required env",
      `missing ${missing.join(", ")}`,
      `Copy .env.example to ${envFile} and fill in ${missing.join(", ")}. ` +
        "The app refuses to boot without them.",
    )
  } else {
    report("PASS", "Required env", `all ${REQUIRED_ENV.length} present`)
  }

  const rawAppUrl = process.env.APP_PUBLIC_URL?.trim() ?? ""
  if (!rawAppUrl) {
    report(
      "FAIL",
      "APP_PUBLIC_URL",
      "not set",
      `Set APP_PUBLIC_URL in ${envFile} — it becomes the deep link inside every reminder.`,
    )
  } else {
    let parsed: URL | null = null
    try {
      parsed = new URL(rawAppUrl)
    } catch {
      parsed = null
    }
    if (!parsed) {
      report(
        "FAIL",
        "APP_PUBLIC_URL",
        `"${rawAppUrl}" is not an absolute URL`,
        "Use a full origin such as https://reminders.example.com — a relative value " +
          "produces a reminder that looks fine and links nowhere.",
      )
    } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      report(
        "FAIL",
        "APP_PUBLIC_URL",
        `protocol is "${parsed.protocol}", must be http or https`,
        `Change APP_PUBLIC_URL in ${envFile} to an http(s) origin.`,
      )
    } else if (production && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) {
      report(
        "WARN",
        "APP_PUBLIC_URL",
        `${appPublicUrl()} — localhost, but the runtime looks like production`,
        "Every agent would receive a link that only opens on the server's own machine — set " +
          "APP_PUBLIC_URL to the public origin. If this IS a laptop, set APP_ENV=development: " +
          "env.ts fails closed, so an unset runtime counts as production.",
      )
    } else {
      report("PASS", "APP_PUBLIC_URL", appPublicUrl())
    }
  }

  // 2. Supabase ─────────────────────────────────────────────────────────────
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? ""
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ""
  let admin: SupabaseClient | null = null
  const counts: Record<string, number> = {}

  if (!supabaseUrl || !serviceRoleKey) {
    report(
      "FAIL",
      "Supabase",
      "no service-role client — URL or key missing",
      "Fill NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from " +
        "Supabase → Project Settings → API.",
    )
  } else if (looksLikePlaceholder(supabaseUrl)) {
    report(
      "FAIL",
      "Supabase",
      `NEXT_PUBLIC_SUPABASE_URL is still the placeholder (${supabaseUrl})`,
      `Create a Supabase project, then put its real URL and keys in ${envFile}.`,
    )
  } else {
    admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) => fetchWithTimeout(input, init, PROBE_TIMEOUT_MS),
      },
    })

    // One table first, as the connectivity probe. If the host or the key is
    // wrong every other probe fails identically and each costs seconds of DNS
    // or TLS retry — a doctor that takes half a minute to say "unreachable"
    // gets killed before it prints anything.
    const probeTable = TABLES[0]
    const probe = await countTable(admin, probeTable)

    if (!probe.ok) {
      admin = null // downstream checks have nothing to read
      report(
        "FAIL",
        "Supabase",
        `cannot read "${probeTable}": ${probe.error}`,
        "Almost always means the schema was never applied. Run `npm run db:bundle`, then " +
          "paste supabase/bundle.sql into the Supabase SQL editor and Run. " +
          "If the message names the API key or the host, the credentials or project URL are wrong.",
      )
    } else {
      counts[probeTable] = probe.count
      // The connection works, so anything failing now is that table alone —
      // the signature of a half-applied migration set.
      const unreadable: string[] = []
      let detail = ""
      for (const table of TABLES.slice(1)) {
        const res = await countTable(admin, table)
        if (res.ok) counts[table] = res.count
        else {
          unreadable.push(table)
          if (!detail) detail = res.error
        }
      }

      if (unreadable.length > 0) {
        report(
          "FAIL",
          "Supabase",
          `connected, but cannot read ${unreadable.join(", ")}: ${detail}`,
          "The schema is only half applied. Run `npm run db:bundle` and paste " +
            "supabase/bundle.sql into the Supabase SQL editor — it is safe to re-run, " +
            "but check the editor output for the error that stopped it the first time.",
        )
      } else {
        report("PASS", "Supabase", TABLES.map((t) => `${t} ${counts[t]}`).join(", "))
      }
    }
  }

  // 3. Reminder rules ───────────────────────────────────────────────────────
  if (!admin) {
    reportNoDatabase("Reminder rules")
  } else {
    const active = await runCount(
      admin.from("reminder_rules").select("*", { count: "exact", head: true }).eq("active", true),
    )
    const total = counts["reminder_rules"] ?? 0
    if (!active.ok) {
      report(
        "WARN",
        "Reminder rules",
        `could not count active rules: ${active.error}`,
        "Fix Supabase above, then re-run.",
      )
    } else if (total === 0) {
      report(
        "WARN",
        "Reminder rules",
        "none defined — every stored date is inert",
        "Add at least one rule (event_type + offset_days) in Settings, or insert one into " +
          "reminder_rules. With zero rules the tick materialises nothing and nothing ever sends.",
      )
    } else if (active.count === 0) {
      report(
        "WARN",
        "Reminder rules",
        `${total} defined, none active`,
        "Set active = true on the rules you want firing — the materialiser skips inactive ones.",
      )
    } else {
      report("PASS", "Reminder rules", `${active.count} active of ${total}`)
    }
  }

  // 4. Team roster ──────────────────────────────────────────────────────────
  if (!admin) {
    reportNoDatabase("Team roster")
  } else {
    // whatsapp_number is NOT NULL, but nothing forbids an empty string, and an
    // empty destination is exactly as undeliverable as a missing one.
    const reachable = await runCount(
      admin
        .from("team_members")
        .select("*", { count: "exact", head: true })
        .eq("active", true)
        .not("whatsapp_number", "is", null)
        .neq("whatsapp_number", ""),
    )
    const owners = await runCount(
      admin
        .from("team_members")
        .select("*", { count: "exact", head: true })
        .eq("active", true)
        .eq("role", "owner")
        .neq("whatsapp_number", ""),
    )
    if (!reachable.ok || !owners.ok) {
      const err = reachable.ok ? (owners.ok ? "" : owners.error) : reachable.error
      report(
        "WARN",
        "Team roster",
        `could not count members: ${err}`,
        "Fix Supabase above, then re-run.",
      )
    } else if (reachable.count === 0) {
      report(
        "WARN",
        "Team roster",
        "no active member has a WhatsApp number",
        "Every reminder falls back to the owner's number, and with no owner they all resolve " +
          "'skipped'. Add members in Settings → Team, each with an E.164 number.",
      )
    } else if (owners.count === 0) {
      report(
        "WARN",
        "Team roster",
        `${reachable.count} reachable member(s), but no active owner`,
        "Unassigned leads and 'all_members' rules fall back to the owner's number — with none, " +
          "those reminders resolve 'skipped'. Give one member role = 'owner'.",
      )
    } else {
      report(
        "PASS",
        "Team roster",
        `${reachable.count} reachable member(s), ${owners.count} owner(s)`,
      )
    }
  }

  // 5. WhatsApp sender and template ─────────────────────────────────────────
  const phoneNumberId = process.env.GOMA_NOTIFY_PHONE_NUMBER_ID?.trim() ?? ""
  const accessToken = process.env.GOMA_NOTIFY_ACCESS_TOKEN?.trim() ?? ""
  const wabaId = process.env.GOMA_NOTIFY_WABA_ID?.trim() ?? ""

  if (!phoneNumberId || !accessToken) {
    const absent = [
      phoneNumberId ? null : "GOMA_NOTIFY_PHONE_NUMBER_ID",
      accessToken ? null : "GOMA_NOTIFY_ACCESS_TOKEN",
    ]
      .filter((n): n is string => n !== null)
      .join(", ")
    report(
      whenLive(),
      "WhatsApp sender",
      dryRun
        ? `${absent} not set — dry run stands in for them`
        : `${absent} not set — getGomaSender() returns null, so every reminder resolves 'skipped'`,
      `Set ${absent} in ${envFile}, from the platform notifications number in Meta ` +
        "Business Manager.",
    )
  } else {
    report("PASS", "WhatsApp sender", `phone number id ${phoneNumberId} configured`)
  }

  if (!wabaId) {
    report(
      "WARN",
      "WhatsApp template",
      "GOMA_NOTIFY_WABA_ID not set — cannot check the template's review status",
      `Set GOMA_NOTIFY_WABA_ID in ${envFile} so preflight can confirm ` +
        `${CLIENT_EVENT_REMINDER_TEMPLATE} is APPROVED before you rely on it.`,
    )
  } else if (!accessToken) {
    report(
      "WARN",
      "WhatsApp template",
      "no access token to query Meta with",
      "Set GOMA_NOTIFY_ACCESS_TOKEN, then re-run to check the template's review status.",
    )
  } else {
    const probe = await probeTemplate(
      GRAPH_API_VERSION,
      wabaId,
      accessToken,
      CLIENT_EVENT_REMINDER_TEMPLATE,
    )
    if (!probe.ok) {
      report(
        "WARN",
        "WhatsApp template",
        `could not ask Meta: ${probe.error}`,
        "Check GOMA_NOTIFY_WABA_ID and that the access token has whatsapp_business_management. " +
          "This does not by itself stop a send.",
      )
    } else if (probe.status === null) {
      report(
        whenLive(),
        "WhatsApp template",
        `${CLIENT_EVENT_REMINDER_TEMPLATE} is not on this WABA`,
        "Register it with `npm run template:register`, then wait for Meta's review. " +
          "Delivery is template-only, so nothing sends until it exists and is APPROVED.",
      )
    } else if (probe.status === "APPROVED") {
      report("PASS", "WhatsApp template", `${CLIENT_EVENT_REMINDER_TEMPLATE} is APPROVED`)
    } else {
      report(
        whenLive(),
        "WhatsApp template",
        `${CLIENT_EVENT_REMINDER_TEMPLATE} is ${probe.status}`,
        probe.status === "REJECTED"
          ? "Meta rejected it. Read the reason in WhatsApp Manager → Message templates, " +
              "amend clientEventReminderTemplateDefinition() and resubmit."
          : "Meta is still reviewing it — usually minutes to a few hours. Live sends fail until " +
              "it is APPROVED; keep REMINDER_DRY_RUN=1 until then.",
      )
    }
  }

  // 6. Dry run ──────────────────────────────────────────────────────────────
  if (dryRun && production) {
    report(
      "FAIL",
      "Dry run",
      `REMINDER_DRY_RUN is ON and the runtime looks like production (${runtimeLabel()})`,
      `On a real deployment, remove REMINDER_DRY_RUN from ${envFile} and from the deployment's ` +
        "env: every reminder would be recorded as delivered with nothing reaching an agent, and " +
        `the app refuses to boot like this. If this is a laptop, set APP_ENV=development in ` +
        `${envFile} — env.ts fails closed, so an unset runtime counts as production.`,
    )
  } else if (dryRun) {
    report(
      "WARN",
      "Dry run",
      `ON — payloads are logged and stamped with a synthetic id (${runtimeLabel()})`,
      "Nothing reaches WhatsApp. Unset REMINDER_DRY_RUN when you want real sends.",
    )
  } else {
    report("PASS", "Dry run", `off — sends are live (${runtimeLabel()})`)
  }

  // 7. AI keys ──────────────────────────────────────────────────────────────
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    report("PASS", "AI drafting", "ANTHROPIC_API_KEY set")
  } else {
    report(
      "WARN",
      "AI drafting",
      "ANTHROPIC_API_KEY not set — reminders send with a generic line instead of a drafted message",
      `Set ANTHROPIC_API_KEY in ${envFile}. Drafting is deliberately non-fatal: the reminder ` +
        "matters more than the suggestion.",
    )
  }
  if (process.env.OPENAI_API_KEY?.trim()) {
    report("PASS", "AI fallback", "OPENAI_API_KEY set")
  } else {
    report(
      "WARN",
      "AI fallback",
      "OPENAI_API_KEY not set — an Anthropic 429/529 drops to the generic line",
      "Optional. Set OPENAI_API_KEY if you want drafting to survive a capacity error.",
    )
  }

  // 8. Queue snapshot ───────────────────────────────────────────────────────
  if (!admin) {
    reportNoDatabase("Reminder queue")
  } else {
    const tally: Record<string, number> = {}
    let queueError: string | null = null
    for (const status of REMINDER_STATUSES) {
      const res = await runCount(
        admin.from("reminders").select("*", { count: "exact", head: true }).eq("status", status),
      )
      if (res.ok) tally[status] = res.count
      else if (!queueError) queueError = res.error
    }
    const summary = REMINDER_STATUSES.map((s) => `${s} ${tally[s] ?? "?"}`).join(", ")
    const needsAttention = (tally["failed"] ?? 0) + (tally["skipped"] ?? 0)
    if (queueError) {
      report(
        "WARN",
        "Reminder queue",
        `partial count: ${summary} (${queueError})`,
        "Fix Supabase above, then re-run.",
      )
    } else if (needsAttention > 0) {
      report(
        "WARN",
        "Reminder queue",
        summary,
        "Read reminders.error for the failed rows. 'skipped' means no recipient number could be " +
          "resolved — see the team roster and WhatsApp sender checks above.",
      )
    } else {
      report("PASS", "Reminder queue", summary)
    }
  }

  // The tie-breaker. If boot would refuse an environment the checklist called
  // clean, the checklist is wrong — say so rather than reporting READY.
  if (!results.some((r) => r.level === "FAIL")) {
    try {
      assertEnv()
    } catch (e) {
      report(
        "FAIL",
        "Boot check",
        e instanceof Error ? e.message : String(e),
        "src/lib/env.ts refuses this environment at startup. Fix the condition it names.",
      )
    }
  }

  // ── Verdict ─────────────────────────────────────────────────────────────
  const blocking = results.filter((r) => r.level === "FAIL")
  const warnings = results.filter((r) => r.level === "WARN")
  console.log("")

  if (blocking.length === 0 && dryRun) {
    console.log(
      "  Ready to send?  YES — but REMINDER_DRY_RUN is on, so nothing will reach WhatsApp.\n" +
        `                  Unset REMINDER_DRY_RUN in ${envFile} for a real send.`,
    )
  } else if (blocking.length === 0) {
    console.log("  Ready to send?  YES")
  } else {
    console.log(`  Ready to send?  NO — ${blocking.length} blocking item(s):`)
    for (const item of blocking) {
      console.log(`                  • ${item.title}: ${item.remedy ?? "see the detail above"}`)
    }
  }

  if (warnings.length > 0) {
    console.log(
      `\n  ${warnings.length} warning(s) above will not stop a send, but each one is a way ` +
        "for a reminder to go nowhere quietly.",
    )
  }
  console.log("\n  Next: `npm run reminders:tick` runs one cycle and prints what it did.\n")

  process.exitCode = blocking.length > 0 ? 1 : 0
}

main().catch((err) => {
  console.error(
    "\n[preflight] The checks themselves failed to run, so nothing above is a verdict. " +
      "This is usually a missing dependency or an unreadable env file rather than a " +
      "configuration problem. The underlying error was:\n",
  )
  console.error(err)
  process.exit(1)
})
