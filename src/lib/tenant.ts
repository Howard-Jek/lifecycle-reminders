import { cache } from "react"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"

/**
 * Tenant resolution — the single place a request's business identity comes from.
 *
 * A business is its own entity (`businesses`), and people access it through
 * `business_members`. Data belongs to `business_id`; `userId` is only WHO is
 * acting (the seat) — audit trails, storage-upload prefixes, and nothing else.
 * Never use `userId` to scope a tenant query.
 *
 * One business per user is enforced today by `business_members_user_id_key`,
 * so resolution is unambiguous. When multi-business membership lands, that
 * constraint is dropped and this module grows an active-business selector —
 * callers are already shaped for it because they only ever see `businessId`.
 */

export type TenantRole = "owner" | "member"

export type Tenant = {
  /** The auth user acting in this request — the seat, NOT the tenant key. */
  userId: string
  /** The acting user's email, for display (avatar, menus). */
  email: string | null
  /** The business every tenant-owned query must be scoped by. */
  businessId: string
  role: TenantRole
}

/**
 * Resolve the current request's tenant. Returns null when unauthenticated.
 *
 * First-login bootstrap: a signed-in user with no membership gets a fresh
 * business (fresh uuid — never the user's id) plus an owner membership. This
 * is deliberately the ONLY place businesses are created, so signup, invited
 * users of the future, and any pre-membership stragglers all funnel through
 * one code path.
 *
 * The matching `business_settings` row is NOT created here: the
 * `businesses_create_settings_row` trigger does it, so the invariant holds for
 * ops scripts and hand-written INSERTs too (migration 20260727170000). The
 * business row itself carries the profile columns, at their defaults until
 * onboarding fills them in — see `isBusinessConfigured`.
 *
 * Wrapped in React cache(): one resolution per request no matter how many
 * actions/components ask.
 */
export const getTenant = cache(async (): Promise<Tenant | null> => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  // RLS on business_members lets a user read exactly their own rows; the
  // explicit eq() just states intent.
  const { data: membership, error: membershipError } = await supabase
    .from("business_members")
    .select("business_id, role")
    .eq("user_id", user.id)
    .maybeSingle()

  // A FAILED read is not "no membership" — minting on a transient DB error
  // would spawn spurious business rows. Bail; the caller treats it like
  // unauthenticated and the next request retries.
  if (membershipError) {
    console.error("[tenant] membership lookup failed:", membershipError.message)
    return null
  }

  if (membership) {
    return {
      userId: user.id,
      email: user.email ?? null,
      businessId: membership.business_id,
      role: membership.role as TenantRole,
    }
  }

  return mintBusinessForUser(user.id, user.email ?? null)
})

/**
 * Like getTenant() but for callers that cannot proceed unauthenticated
 * (server actions that would otherwise null-check every time).
 */
export async function requireTenant(): Promise<Tenant> {
  const tenant = await getTenant()
  if (!tenant) throw new Error("Not authenticated")
  return tenant
}

/**
 * Create a business + owner membership for a user that has none. Concurrency-
 * safe: if two requests race, the loser's membership insert hits the
 * one-business-per-user unique key, its orphan business row is removed, and
 * the winner's membership is read back.
 */
async function mintBusinessForUser(
  userId: string,
  email: string | null,
): Promise<Tenant | null> {
  const admin = createAdminClient()

  const { data: business, error: businessError } = await admin
    .from("businesses")
    .insert({ created_by: userId })
    .select("id")
    .single()
  if (businessError || !business) {
    console.error("[tenant] failed to create business:", businessError?.message)
    return null
  }

  const { error: memberError } = await admin
    .from("business_members")
    .insert({ business_id: business.id, user_id: userId, role: "owner" })

  if (!memberError) {
    return { userId, email, businessId: business.id, role: "owner" }
  }

  // Unique violation on user_id → a concurrent request minted first. Discard
  // our business row and adopt theirs. Any other error is a real failure.
  await admin.from("businesses").delete().eq("id", business.id)
  if (memberError.code !== "23505") {
    console.error("[tenant] failed to create membership:", memberError.message)
    return null
  }

  const { data: winner } = await admin
    .from("business_members")
    .select("business_id, role")
    .eq("user_id", userId)
    .maybeSingle()
  if (!winner) return null
  return { userId, email, businessId: winner.business_id, role: winner.role as TenantRole }
}
