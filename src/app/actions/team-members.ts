"use server"

import { revalidatePath } from "next/cache"
import { randomBytes, createHash } from "node:crypto"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { normalizePhone } from "@/lib/sanitize"
import { appPublicUrl } from "@/lib/env"
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

export async function createTeamMember(input: MemberInput): Promise<ActionResult> {
  const tenant = await requireTenant()
  const checked = validate(input, await businessCountryCode(tenant.businessId))
  if (!checked.ok) return checked

  const { error } = await createAdminClient().from("team_members").insert({
    business_id: tenant.businessId,
    display_name: checked.displayName,
    email: checked.email,
    whatsapp_number: checked.whatsappNumber,
    role: checked.role,
  })

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "Somebody on the team already has that WhatsApp number." }
    }
    console.error("[team-members] create failed:", error.message)
    return { ok: false, error: error.message }
  }

  revalidatePath("/team")
  return { ok: true }
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
