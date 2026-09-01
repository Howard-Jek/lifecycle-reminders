"use server"

import { revalidatePath } from "next/cache"
import { randomBytes, createHash } from "node:crypto"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { normalizePhone } from "@/lib/sanitize"
import { appPublicUrl } from "@/lib/env"
import {
  sendRosterTestMessage,
  checkTestDelivery,
  type TestProgress,
} from "@/lib/notify/test-message"
import type { TeamMember } from "@/lib/lifecycle/types"

export type ActionResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { data: T }))
  | { ok: false; error: string }

/** SHA-256 hex. The only form any bearer token is ever stored in. */
function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex")
}

export async function listTeamMembers(): Promise<TeamMember[]> {
  const tenant = await requireTenant()
  const { data, error } = await createAdminClient()
    .from("team_members")
    .select("*")
    .eq("business_id", tenant.businessId)
    .order("active", { ascending: false })
    .order("display_name")
  if (error) {
    console.error("[team-members] list failed:", error.message)
    return []
  }
  return (data ?? []) as TeamMember[]
}

/** Which members currently have a live calendar feed. Never the token itself. */
export async function listCalendarFeedStatus(): Promise<Record<string, string>> {
  const tenant = await requireTenant()
  const { data } = await createAdminClient()
    .from("team_member_calendar_tokens")
    .select("member_id, issued_at, revoked_at")
    .eq("business_id", tenant.businessId)
    .is("revoked_at", null)
  const out: Record<string, string> = {}
  for (const row of data ?? []) out[row.member_id as string] = row.issued_at as string
  return out
}

export type MemberInput = {
  display_name: string
  email?: string | null
  whatsapp_number: string
  role: "owner" | "agent"
}

type MemberCheck =
  | { ok: false; error: string }
  | {
      ok: true
      displayName: string
      email: string | null
      whatsappNumber: string
      role: "owner" | "agent"
    }

function validate(input: MemberInput, countryCode: string): MemberCheck {
  const displayName = input.display_name.trim()
  if (!displayName) return { ok: false, error: "A name is required." }

  const email = input.email?.trim().toLowerCase() || null
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "That email address does not look right." }
  }

  // Validated here, before any write: a bad number is silent at delivery time
  // (the reminder just resolves to `skipped`), which is exactly the failure
  // that is hardest to notice.
  const phone = normalizePhone(input.whatsapp_number, countryCode)
  if (!phone.phone) return { ok: false, error: `WhatsApp number: ${phone.reason.toLowerCase()}.` }

  if (input.role !== "owner" && input.role !== "agent") {
    return { ok: false, error: "Role must be owner or agent." }
  }

  return { ok: true, displayName, email, whatsappNumber: phone.phone, role: input.role }
}

async function businessCountryCode(businessId: string): Promise<string> {
  const { data } = await createAdminClient()
    .from("businesses")
    .select("country_code")
    .eq("id", businessId)
    .maybeSingle<{ country_code: string | null }>()
  // Dial codes for the markets this ships into. Anything else must be entered
  // in full E.164, which normalizePhone accepts unchanged.
  const map: Record<string, string> = { SG: "+65", MY: "+60", US: "+1", GB: "+44", AU: "+61" }
  return map[(data?.country_code ?? "SG").toUpperCase()] ?? "+65"
}

/** Enough of the new row to offer a test send without a second round trip. */
export type CreatedMember = { id: string; display_name: string; whatsapp_number: string }

export async function createTeamMember(input: MemberInput): Promise<ActionResult<CreatedMember>> {
  const tenant = await requireTenant()
  const checked = validate(input, await businessCountryCode(tenant.businessId))
  if (!checked.ok) return checked

  // Selected back rather than fire-and-forget: the caller offers to test the
  // number immediately, and asking "which row did I just create?" by matching
  // on the number would be guessing at the one moment we actually know.
  const { data, error } = await createAdminClient()
    .from("team_members")
    .insert({
      business_id: tenant.businessId,
      display_name: checked.displayName,
      email: checked.email,
      whatsapp_number: checked.whatsappNumber,
      role: checked.role,
    })
    .select("id, display_name, whatsapp_number")
    .maybeSingle<CreatedMember>()

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "Somebody on the team already has that WhatsApp number." }
    }
    console.error("[team-members] create failed:", error.message)
    return { ok: false, error: error.message }
  }
  if (!data) return { ok: false, error: "The member could not be created." }

  revalidatePath("/team")
  return { ok: true, data }
}

export async function updateTeamMember(id: string, input: MemberInput): Promise<ActionResult> {
  const tenant = await requireTenant()
  const checked = validate(input, await businessCountryCode(tenant.businessId))
  if (!checked.ok) return checked

  // Scoped by business_id as well as id, and selected back: supabase-js
  // reports "no row matched" as success with no error, so without the select
  // a cross-tenant id would look like a silent save.
  const { data, error } = await createAdminClient()
    .from("team_members")
    .update({
      display_name: checked.displayName,
      email: checked.email,
      whatsapp_number: checked.whatsappNumber,
      role: checked.role,
    })
    .eq("id", id)
    .eq("business_id", tenant.businessId)
    .select("id")
    .maybeSingle()

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "Somebody on the team already has that WhatsApp number." }
    }
    return { ok: false, error: error.message }
  }
  if (!data) return { ok: false, error: "That team member no longer exists." }

  revalidatePath("/team")
  return { ok: true }
}

/**
 * Deactivate, never delete.
 *
 * A hard delete would take the record that an agent was ever told about a
 * client's policy expiry with it, and `reminders.member_id` is ON DELETE
 * NO ACTION precisely so a direct delete fails loudly rather than quietly.
 * Deactivating also leaves their clients assigned, so reassignment is a
 * decision rather than a side effect.
 */
export async function setTeamMemberActive(id: string, active: boolean): Promise<ActionResult> {
  const tenant = await requireTenant()
  const { data, error } = await createAdminClient()
    .from("team_members")
    .update({ active })
    .eq("id", id)
    .eq("business_id", tenant.businessId)
    .select("id")
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: "That team member no longer exists." }

  revalidatePath("/team")
  return { ok: true }
}

/**
 * Issue (or re-issue) a member's ICS feed URL.
 *
 * Returns the full URL exactly once. Only the hash is stored, so this is the
 * single moment the raw token exists anywhere we control — re-issuing is the
 * only way to see it again, which is correct for a bearer credential.
 */
export async function issueCalendarFeed(memberId: string): Promise<ActionResult<string>> {
  const tenant = await requireTenant()
  const admin = createAdminClient()

  const { data: member } = await admin
    .from("team_members")
    .select("id")
    .eq("id", memberId)
    .eq("business_id", tenant.businessId)
    .maybeSingle()
  if (!member) return { ok: false, error: "That team member no longer exists." }

  // 32 bytes: this token is the entire authentication for the feed, because a
  // calendar client cannot send an auth header.
  const raw = randomBytes(32).toString("hex")

  const { error } = await admin.from("team_member_calendar_tokens").upsert(
    {
      member_id: memberId,
      business_id: tenant.businessId,
      token_hash: hashToken(raw),
      issued_at: new Date().toISOString(),
      last_used_at: null,
      revoked_at: null,
    },
    { onConflict: "member_id" },
  )
  if (error) {
    console.error("[team-members] calendar issue failed:", error.message)
    return { ok: false, error: error.message }
  }

  revalidatePath("/team")
  return { ok: true, data: `${appPublicUrl()}/api/calendar/${raw}` }
}

export async function revokeCalendarFeed(memberId: string): Promise<ActionResult> {
  const tenant = await requireTenant()
  // Delete rather than stamp revoked_at: the row holds nothing worth keeping
  // once revoked, and removing it means a leaked token cannot be matched at
  // all rather than matched-then-rejected.
  const { error } = await createAdminClient()
    .from("team_member_calendar_tokens")
    .delete()
    .eq("member_id", memberId)
    .eq("business_id", tenant.businessId)

  if (error) return { ok: false, error: error.message }
  revalidatePath("/team")
  return { ok: true }
}

export type TestSendReceipt = {
  displayName: string
  /** The number the message was addressed to, echoed back from the sender. */
  number: string
  /** True when nothing left the building — REMINDER_DRY_RUN is on. */
  dryRun: boolean
  /**
   * The member is deactivated.
   *
   * Worth surfacing precisely because the test still ARRIVES: the send path
   * does not consult `active`, only the materialiser does. Without saying so,
   * a delivered test to an inactive agent reads as proof that their reminders
   * work, when in fact they will never receive one.
   */
  inactive: boolean
  /** Meta's id for the message, so its receipts can be looked up. */
  whatsappMessageId: string
  /** When it went, so a reply can be told from earlier chatter. */
  sentAt: string
}

/**
 * Put one real message on one agent's handset.
 *
 * The only send this app performs on demand, and the only one an operator can
 * trigger by hand. It exists because a saved number is not a verified one:
 * validation proves the shape, and every remaining failure — wrong person,
 * no WhatsApp account on that number — is silent at delivery time.
 *
 * Scoped to the caller's own roster by the same query that authorises it. Every
 * export of a `"use server"` module is a public POST endpoint, so the business
 * filter here is the access control, not a convenience: without it this would
 * be an authenticated relay that sends from a verified business number to any
 * uuid a caller can guess.
 */
export async function sendTestMessage(memberId: string): Promise<ActionResult<TestSendReceipt>> {
  const tenant = await requireTenant()

  const { data: member } = await createAdminClient()
    .from("team_members")
    .select("id, display_name, whatsapp_number, active")
    .eq("id", memberId)
    .eq("business_id", tenant.businessId)
    .maybeSingle<{
      id: string
      display_name: string
      whatsapp_number: string | null
      active: boolean
    }>()

  if (!member) return { ok: false, error: "That team member no longer exists." }

  const result = await sendRosterTestMessage(member)
  if (!result.ok) return { ok: false, error: result.error }

  return {
    ok: true,
    data: {
      displayName: member.display_name,
      number: result.to,
      dryRun: result.dryRun,
      inactive: !member.active,
      // Carried out so the caller can ask what happened NEXT. Without it the
      // only thing anyone ever learns about a test is that Meta accepted it.
      whatsappMessageId: result.whatsappMessageId,
      sentAt: new Date().toISOString(),
    },
  }
}

/**
 * What became of a test send.
 *
 * Split from sendTestMessage because the interesting part is asynchronous: Meta
 * answers the Graph call in milliseconds and reports actual delivery seconds
 * later, over the webhook. A server action cannot sit and wait for that, so the
 * page asks again.
 *
 * Scoped to the caller's own roster by the same query that authorises the send,
 * and for the same reason — every export here is a public POST endpoint, so
 * without the business filter this would tell any caller who could guess a
 * member id and a wamid whether that person had read their messages.
 */
export async function checkTestMessage(
  memberId: string,
  wamid: string,
  sentAtIso: string,
): Promise<ActionResult<TestProgress>> {
  const tenant = await requireTenant()
  const admin = createAdminClient()

  const { data: member } = await admin
    .from("team_members")
    .select("id, whatsapp_number")
    .eq("id", memberId)
    .eq("business_id", tenant.businessId)
    .maybeSingle<{ id: string; whatsapp_number: string | null }>()

  if (!member?.whatsapp_number) {
    return { ok: false, error: "That team member no longer exists." }
  }

  return {
    ok: true,
    data: await checkTestDelivery(admin, {
      wamid,
      number: member.whatsapp_number,
      sinceIso: sentAtIso,
    }),
  }
}
