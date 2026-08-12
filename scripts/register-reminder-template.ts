/**
 * Register the WhatsApp template `client_event_reminder` on the platform WABA,
 * and report where Meta's review has got to.
 *
 * This is the long pole for the whole product. Delivery is WhatsApp-only and
 * Meta's review runs to hours, so registering is a day-one command a human runs
 * and then polls — never something the app can do for itself at send time.
 *
 *   npm run template:register -- --dry      print the exact payload, submit nothing
 *   npm run template:register               submit the template for review
 *   npm run template:register -- --status   ask Meta where the review has got to
 *
 * Exit codes, so a deploy step can gate on this:
 *   0  submitted, still in review, or APPROVED
 *   1  anything needing a human: missing credentials, a Meta error, REJECTED,
 *      a payload Meta would reject, or --status finding no such template
 */

import { readFileSync } from "node:fs"
import type { ReminderAlertParams } from "../src/lib/notify/client-event-reminder"

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
  console.warn(`[template] could not read ${envFile} — relying on the ambient environment`)
}

const RULE = "─".repeat(78)

const USAGE = [
  "Register the client_event_reminder WhatsApp template, or check its review status.",
  "",
  "  npm run template:register -- --dry      print the exact payload, submit nothing",
  "  npm run template:register               submit the template to Meta for review",
  "  npm run template:register -- --status   ask Meta where the review has got to",
  "",
  "Credentials come from GOMA_NOTIFY_WABA_ID and GOMA_NOTIFY_ACCESS_TOKEN in",
  `${envFile} (set ENV_FILE=<path> to read a different file).`,
].join("\n")

type Mode = "submit" | "dry" | "status" | "help"

/** Meta's create-template payload. Deliberately structural: the shape is owned
 * by clientEventReminderTemplateDefinition(), not by this script. */
type TemplateDefinition = Record<string, unknown>

type BodyComponent = {
  type?: string
  text?: string
  example?: { body_text?: string[][] }
}

type RemoteTemplate = {
  id?: string
  name?: string
  status?: string
  category?: string
  language?: string
  rejected_reason?: string
}

type GraphList = { data?: RemoteTemplate[]; error?: { message?: string } }

type Credentials = { wabaId: string; accessToken: string }

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Returned, not thrown: an unknown flag is an operator typo with an obvious
 * fix, and a stack trace would bury the usage text. */
function parseMode(argv: string[]): { mode: Mode } | { error: string } {
  const flags = argv.filter((arg) => arg.length > 0)
  if (flags.length === 0) return { mode: "submit" }
  if (flags.length > 1) return { error: `Expected one flag at most, got: ${flags.join(" ")}` }

  switch (flags[0]) {
    case "--status":
      return { mode: "status" }
    case "--dry":
      return { mode: "dry" }
    case "--help":
    case "-h":
      return { mode: "help" }
    default:
      return { error: `Unknown flag "${flags[0]}".` }
  }
}

/**
 * The two credentials this script needs, or a sentence saying which is missing
 * and where to put it. Returned rather than thrown — a blank env var is the
 * single most likely way this command fails, and it deserves an answer.
 */
function readCredentials(): { ok: true; value: Credentials } | { ok: false; message: string } {
  const wabaId = process.env.GOMA_NOTIFY_WABA_ID?.trim()
  const accessToken = process.env.GOMA_NOTIFY_ACCESS_TOKEN?.trim()
  if (wabaId && accessToken) return { ok: true, value: { wabaId, accessToken } }

  const missing = [
    !wabaId ? "GOMA_NOTIFY_WABA_ID" : null,
    !accessToken ? "GOMA_NOTIFY_ACCESS_TOKEN" : null,
  ].filter((name): name is string => name !== null)

  return {
    ok: false,
    message: [
      `Cannot talk to Meta: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set.`,
      "",
      `Add ${missing.length > 1 ? "them" : "it"} to ${envFile}. Both names are already listed`,
      "in .env.example, and ENV_FILE=<path> points this script at a different file.",
      "",
      "  GOMA_NOTIFY_WABA_ID=        Business Manager → WhatsApp Accounts → the ID shown",
      "                              under the account name. NOT the phone number ID.",
      "  GOMA_NOTIFY_ACCESS_TOKEN=   a system-user token for that business.",
      "",
      "Managing templates needs the whatsapp_business_management permission. A token",
      "scoped only to whatsapp_business_messaging can send messages but will be refused",
      "here with a #200 permissions error.",
    ].join("\n"),
  }
}

function bodyOf(def: TemplateDefinition): BodyComponent | null {
  const components = (def.components as BodyComponent[] | undefined) ?? []
  return components.find((c) => c.type === "BODY") ?? null
}

/**
 * How many body params the send path actually fills.
 *
 * Derived by calling buildReminderComponents() rather than hardcoded, so this
 * check keeps telling the truth if the reminder ever gains or loses a param.
 * A template whose variable count disagrees with the sender is approved
 * happily by Meta and then fails on every single send with #132000.
 */
function sentParamCount(build: (p: ReminderAlertParams) => Record<string, unknown>[]): number {
  const components = build({
    clientLabel: "Jane Tan",
    eventLabel: "Policy expiry",
    whenText: "in a month",
    suggestion: "Example suggestion.",
    deepLink: "https://app.example.com/dashboard?lead=example",
  })
  const body = components.find((c) => c.type === "body")
  return ((body?.parameters as unknown[] | undefined) ?? []).length
}

/**
 * Everything Meta will reject this payload for that can be known locally.
 *
 * Worth the fifty lines because the feedback loop is hours long: a submission
 * that comes back REJECTED costs another full review cycle, and the product
 * ships nothing until a template is approved.
 */
function validateDefinition(def: TemplateDefinition, expectedParams: number): string[] {
  const problems: string[] = []

  if (typeof def.name !== "string" || def.name.length === 0) problems.push("no template name")
  if (typeof def.language !== "string" || def.language.length === 0) problems.push("no language")
  if (def.category !== "UTILITY") {
    problems.push(
      `category is ${JSON.stringify(def.category)}, expected "UTILITY" — a reminder to the ` +
        "agent who owns the contact is utility, and MARKETING drags in opt-in rules",
    )
  }

  const components = (def.components as BodyComponent[] | undefined) ?? []
  const bodies = components.filter((c) => c.type === "BODY")
  if (bodies.length !== 1) {
    problems.push(`expected exactly one BODY component, found ${bodies.length}`)
    return problems
  }

  const text = bodies[0].text ?? ""
  if (text.length === 0) problems.push("the BODY component has no text")
  if (text.length > 1024) {
    problems.push(`BODY text is ${text.length} characters; Meta's limit is 1024`)
  }
  // Meta's rule is "no two parameters adjacent", and whitespace does not count
  // as separation — "{{2}} {{3}}" is rejected exactly like "{{2}}{{3}}". The
  // literal "}}{{" check this replaces missed the spaced form, which is the
  // one a human actually writes.
  if (/\}\}\s*\{\{/.test(text)) {
    problems.push("two variables are adjacent (whitespace between them does not count as text)")
  }
  // A body may not open or close on a variable. Both are silent rejections
  // that cost a full review cycle to discover.
  if (/^\s*\{\{\d+\}\}/.test(text)) problems.push("BODY begins with a variable; Meta rejects that")
  if (/\{\{\d+\}\}\s*$/.test(text)) problems.push("BODY ends with a variable; Meta rejects that")

  const placeholders = text.match(/\{\{\d+\}\}/g) ?? []
  const numbers = placeholders.map((p) => Number(p.slice(2, -2)))
  const inOrder = numbers.map((_, i) => i + 1)
  if (numbers.join(",") !== inOrder.join(",")) {
    problems.push(
      `variables must run {{1}}..{{N}} in order, found ${placeholders.join(" ") || "none"}`,
    )
  }
  if (numbers.length !== expectedParams) {
    problems.push(
      `BODY declares ${numbers.length} variables but buildReminderComponents() sends ` +
        `${expectedParams} — every send would fail with a parameter mismatch (#132000)`,
    )
  }

  // Meta requires an example for every template with variables and rejects the
  // submission outright without one, review queue not even entered.
  const rows = bodies[0].example?.body_text
  if (numbers.length > 0 && (!rows || rows.length === 0)) {
    problems.push(
      "example.body_text is missing — Meta rejects a template with variables and no example",
    )
  } else if (rows && rows.length > 0 && rows[0].length !== numbers.length) {
    problems.push(
      `example.body_text supplies ${rows[0].length} values for ${numbers.length} variables`,
    )
  } else if (rows && rows.length > 0 && rows[0].some((v) => v.trim().length === 0)) {
    problems.push("example.body_text contains a blank value; Meta requires a realistic sample")
  }

  return problems
}

/** The template as an agent would read it, example values filled in. The point
 * of --dry is to eyeball the wording before it costs a review cycle. */
function preview(def: TemplateDefinition): string {
  const body = bodyOf(def)
  if (!body?.text) return "  (no BODY component)"
  const values = body.example?.body_text?.[0] ?? []
  const rendered = values.reduce(
    (out, value, i) => out.split(`{{${i + 1}}}`).join(value),
    body.text,
  )
  return rendered
    .split("\n")
    .map((line) => `  │ ${line}`)
    .join("\n")
}

/** Meta's own message is accurate but rarely actionable, so pair it with the
 * cause that actually explains it nine times out of ten. */
function likelyCause(message: string): string | null {
  const m = message.toLowerCase()
  if (m.indexOf("already exists") !== -1) {
    return (
      "the template is already on this WABA. A name can only be registered once per " +
      "language — run --status to see the review state of the one that is there."
    )
  }
  if (m.indexOf("#200") !== -1 || m.indexOf("permission") !== -1) {
    return (
      "GOMA_NOTIFY_ACCESS_TOKEN lacks the whatsapp_business_management permission, or " +
      "the system user behind it has no role on this WABA."
    )
  }
  if (m.indexOf("invalid oauth") !== -1 || m.indexOf("cannot parse access token") !== -1) {
    return (
      "GOMA_NOTIFY_ACCESS_TOKEN is not a usable token — revoked, or copied with a line " +
      "break or surrounding quotes in it. Re-copy the system-user token."
    )
  }
  if (m.indexOf("session has expired") !== -1 || m.indexOf("access token") !== -1) {
    return (
      "GOMA_NOTIFY_ACCESS_TOKEN has expired. Tokens from the Graph Explorer last about " +
      "an hour; use a system-user token for anything permanent."
    )
  }
  if (m.indexOf("#803") !== -1 || m.indexOf("does not exist") !== -1) {
    return (
      "GOMA_NOTIFY_WABA_ID is probably the phone-number ID rather than the WhatsApp " +
      "Business Account ID — they look alike and are not interchangeable."
    )
  }
  if (m.indexOf("#100") !== -1 || m.indexOf("invalid parameter") !== -1) {
    return (
      "Meta rejected the payload shape. Run --dry and compare it against " +
      "clientEventReminderTemplateDefinition() in src/lib/notify/client-event-reminder.ts."
    )
  }
  // Meta reports both the app-level (#4) and WABA-level template throttles as a
  // "request limit reached" message rather than a distinct code.
  if (m.indexOf("rate limit") !== -1 || m.indexOf("request limit") !== -1) {
    return "this WABA has hit its template-management throttle. Wait a few minutes and retry."
  }
  return null
}

/**
 * The one thing an operator must not do while review is outstanding.
 *
 * An unapproved template does not bounce softly: the Graph call fails, the row
 * is retried twice more (MAX_ATTEMPTS in run-cycle.ts) and then parked as
 * 'failed', which nothing ever picks up again. Those reminders are lost, not
 * delayed, and their dates do not come round twice.
 */
function printCronWarning(): void {
  console.log("")
  console.log(RULE)
  console.log("  DO NOT enable the reminder cron until this template reports APPROVED.")
  console.log("")
  console.log("  Sending against an unapproved template fails at the Graph call. Each")
  console.log("  failure burns one of the reminder's 3 attempts, and the third parks the")
  console.log("  row terminally 'failed' — nothing retries it. Those reminders are lost,")
  console.log("  not delayed, and the date they were about has already passed.")
  console.log("")
  console.log(`  Until approval: keep REMINDER_DRY_RUN=1 in ${envFile}, and leave the`)
  console.log("  cron in vercel.json (*/15 on /api/cron/process-reminders) disabled in the")
  console.log("  deployment.")
  console.log(RULE)
}

/** Ask the WABA for this template. GET, so it is safe to run at any time. */
async function fetchRemoteTemplate(
  version: string,
  creds: Credentials,
  name: string,
  language: string,
): Promise<{ ok: true; template: RemoteTemplate | null } | { ok: false; message: string }> {
  // Token travels in the Authorization header, never the query string: Graph
  // and every proxy in between log full URLs.
  const url =
    `https://graph.facebook.com/${version}/${creds.wabaId}/message_templates` +
    `?name=${encodeURIComponent(name)}&limit=50` +
    // rejected_reason is NOT in the edge's default field set, so without this
    // the REJECTED branch can only ever print "none" — in the one situation
    // where Meta's answer is the whole point.
    `&fields=id,name,language,status,category,rejected_reason,components`

  let res: Response
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${creds.accessToken}` } })
  } catch (e) {
    return { ok: false, message: `could not reach graph.facebook.com — ${errText(e)}` }
  }

  const data = (await res.json().catch(() => null)) as GraphList | null
  if (!res.ok) {
    return { ok: false, message: data?.error?.message ?? `HTTP ${res.status}, no message returned` }
  }

  // Meta's ?name= filter has behaved as a prefix match, so re-filter locally
  // rather than reporting some neighbouring template's status as this one's.
  const named = (data?.data ?? []).filter((t) => t.name === name)
  const exact = named.find((t) => t.language === language)

  // Only an EXACT language match counts as registered. Falling back to "some
  // template with this name in any language" is worse than finding nothing:
  // WhatsApp Manager creates templates as en_US by default, so a hand-made one
  // would report APPROVED, suppress the submit, and then fail every single
  // send with #132001 because the sender asks for "en".
  if (!exact && named.length > 0) {
    const languages = Array.from(new Set(named.map((t) => t.language ?? "unknown"))).join(", ")
    return {
      ok: false,
      message:
        `a template named "${name}" exists on this WABA, but in ${languages} — not ` +
        `"${language}", which is what the sender asks for. Either register "${language}" ` +
        `(re-run without --status) or change CLIENT_EVENT_REMINDER_LANGUAGE to match. ` +
        `Left as-is, every send fails with #132001.`,
    }
  }
  return { ok: true, template: exact ?? null }
}

/** Print one template's review state and return this script's exit code. */
function reportStatus(t: RemoteTemplate, wabaId: string): number {
  const status = (t.status ?? "UNKNOWN").toUpperCase()
  console.log(`  Template : ${t.name ?? "?"} (${t.language ?? "?"}, ${t.category ?? "?"})`)
  console.log(`  WABA     : ${wabaId}`)
  console.log(`  Id       : ${t.id ?? "not returned"}`)
  console.log(`  Status   : ${status}`)
  console.log("")

  if (status === "APPROVED") {
    console.log("Approved — reminders can now be delivered for real. To switch it on:")
    console.log(`  1. Remove REMINDER_DRY_RUN from ${envFile} (and from the deployment).`)
    console.log("  2. Check GOMA_NOTIFY_PHONE_NUMBER_ID is a number attached to this WABA.")
    console.log("  3. Prove one real send with `npm run reminders:tick`.")
    console.log("  4. Only then enable the cron on /api/cron/process-reminders.")
    return 0
  }

  if (status === "PENDING" || status === "IN_APPEAL" || status === "PENDING_DELETION") {
    console.log("Still with Meta. Review usually lands within a few hours; nothing to do but")
    console.log("poll: `npm run template:register -- --status`.")
    printCronWarning()
    return 0
  }

  if (status === "REJECTED") {
    console.log(`Meta rejected it. Reason given: ${t.rejected_reason ?? "none"}`)
    console.log("")
    console.log("The wording is owned by clientEventReminderTemplateDefinition() in")
    console.log("src/lib/notify/client-event-reminder.ts. Edit it there, delete the rejected")
    console.log("template in Business Manager, then run `npm run template:register` again.")
    console.log("INCORRECT_CATEGORY usually means the suggested-message body read as marketing;")
    console.log("lead with the agent's task, not with an offer to the client.")
    printCronWarning()
    return 1
  }

  if (status === "PAUSED" || status === "DISABLED") {
    console.log("Meta has stopped this template on quality grounds, so sends will fail even")
    console.log("though it was approved once. Check the template's quality rating in Business")
    console.log("Manager before doing anything else — a PAUSED template resumes on its own,")
    console.log("a DISABLED one does not and must be replaced.")
    printCronWarning()
    return 1
  }

  console.log(`Unrecognised status "${status}". Treat it as not approved and check the`)
  console.log("template in Business Manager before enabling anything.")
  printCronWarning()
  return 1
}

async function main(): Promise<number> {
  const parsed = parseMode(process.argv.slice(2))
  if ("error" in parsed) {
    console.error(`${parsed.error}\n\n${USAGE}`)
    return 1
  }
  if (parsed.mode === "help") {
    console.log(USAGE)
    return 0
  }

  // Imported here, after the env file has been loaded above, matching
  // scripts/tick.ts — these modules read credentials out of process.env.
  const notify = await import("../src/lib/notify/client-event-reminder")
  const { GRAPH_API_VERSION } = await import("../src/lib/whatsapp-graph-version")

  const definition = notify.clientEventReminderTemplateDefinition()
  const name = String(definition.name ?? "")
  const language = String(definition.language ?? "")
  const expectedParams = sentParamCount(notify.buildReminderComponents)

  if (parsed.mode !== "status") {
    const problems = validateDefinition(definition, expectedParams)
    if (problems.length > 0) {
      console.error(`Refusing to submit "${name}" — Meta would reject it:`)
      for (const problem of problems) console.error(`  - ${problem}`)
      console.error("")
      console.error("Fix clientEventReminderTemplateDefinition() in")
      console.error("src/lib/notify/client-event-reminder.ts and run this again. Checking here")
      console.error("costs a second; finding out from Meta costs another review cycle.")
      return 1
    }
  }

  const creds = readCredentials()

  if (parsed.mode === "dry") {
    // --dry deliberately works without credentials: its job is to let a human
    // read the payload and the wording before any of this is configured.
    const target = creds.ok ? creds.value.wabaId : "<GOMA_NOTIFY_WABA_ID>"
    console.log(`POST https://graph.facebook.com/${GRAPH_API_VERSION}/${target}/message_templates`)
    console.log("")
    console.log(JSON.stringify(definition, null, 2))
    console.log("")
    console.log(`Rendered with the example values (${expectedParams} body params), as the agent`)
    console.log("would read it on WhatsApp:")
    console.log("")
    console.log(preview(definition))
    console.log("")
    if (!creds.ok) {
      console.log("Credentials are not set yet, so the URL above shows a placeholder.")
      console.log("")
      console.log(creds.message)
      console.log("")
    }
    console.log("Nothing was submitted. Drop --dry to send this to Meta for review.")
    printCronWarning()
    return 0
  }

  if (!creds.ok) {
    console.error(creds.message)
    return 1
  }

  const existing = await fetchRemoteTemplate(GRAPH_API_VERSION, creds.value, name, language)
  if (!existing.ok) {
    console.error(`Could not read the templates on WABA ${creds.value.wabaId}: ${existing.message}`)
    const cause = likelyCause(existing.message)
    if (cause) console.error(`\nLikely cause: ${cause}`)
    console.error("\nNothing was changed. Fix the above and run the command again.")
    return 1
  }

  if (parsed.mode === "status") {
    if (!existing.template) {
      console.log(`No template named "${name}" exists on WABA ${creds.value.wabaId}.`)
      console.log("")
      console.log("Register it with `npm run template:register` (or read the payload first")
      console.log("with `npm run template:register -- --dry`). Nothing reaches an agent until")
      console.log("it is APPROVED, and review takes hours — do this before anything else.")
      return 1
    }
    return reportStatus(existing.template, creds.value.wabaId)
  }

  // Submit. Checked first because a duplicate name is an error, not an update,
  // and because after a half-finished run the truth about what was submitted
  // lives on the WABA rather than in this terminal.
  if (existing.template) {
    console.log(`"${name}" is already registered on this WABA — nothing was submitted.`)
    console.log("")
    return reportStatus(existing.template, creds.value.wabaId)
  }

  let result: { ok: true; id: string } | { ok: false; error: string }
  try {
    result = await notify.registerClientEventReminderTemplate({
      wabaId: creds.value.wabaId,
      accessToken: creds.value.accessToken,
    })
  } catch (e) {
    // registerClientEventReminderTemplate() returns Meta's errors but lets a
    // transport failure through, and this is the one call that must not end as
    // a stack trace: the operator needs to know whether to retry.
    console.error(`The submission never reached Meta: ${errText(e)}`)
    console.error("")
    console.error("Check the network and run `npm run template:register -- --status` before")
    console.error("retrying — if the POST did land, a second one fails as a duplicate.")
    return 1
  }

  if (!result.ok) {
    console.error(`Meta refused the submission: ${result.error}`)
    const cause = likelyCause(result.error)
    if (cause) console.error(`\nLikely cause: ${cause}`)
    console.error("")
    console.error("Nothing is registered. Fix the above and run the command again;")
    console.error("`npm run template:register -- --status` shows what is on the WABA.")
    return 1
  }

  console.log(`Submitted "${name}" (${language}, ${String(definition.category)}) for review.`)
  console.log(`  WABA        : ${creds.value.wabaId}`)
  console.log(`  Template id : ${result.id || "not returned"}`)
  console.log(`  Body params : ${expectedParams}`)
  console.log("")
  console.log("What happens next:")
  console.log("  1. Meta reviews it — typically minutes to a few hours.")
  console.log("  2. Poll with `npm run template:register -- --status`.")
  console.log("  3. When it reads APPROVED, drop REMINDER_DRY_RUN and prove one real send")
  console.log("     with `npm run reminders:tick` before the cron is switched on.")
  printCronWarning()
  return 0
}

main()
  .then((code) => {
    // process.exitCode rather than process.exit(): everything this script has
    // to say is in the output above, and a hard exit can truncate it when the
    // output is piped.
    process.exitCode = code
  })
  .catch((err) => {
    console.error(`Unexpected failure: ${errText(err)}`)
    console.error("Run `npm run template:register -- --status` to see what, if anything,")
    console.error("reached the WABA before retrying.")
    process.exitCode = 1
  })
