import { createHash, timingSafeEqual } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Bearer-token authentication for the machine-facing v1 API.
 *
 * Lifted out of `api/v1/contacts/route.ts`, which had it inline and was the
 * only endpoint that needed it. Now that a host app drives several endpoints,
 * one implementation is the point: an auth check that exists twice is an auth
 * check that will eventually disagree with itself.
 *
 * The request carries NO tenant identity of its own — no business id in the
 * path, no header naming a tenant. The token IS the tenant resolution, which is
 * why `contact_ingest_tokens.token_hash` is globally unique rather than unique
 * per business. A caller cannot ask for another tenant's data because there is
 * nowhere in the request to ask.
 */

export type ApiCaller = {
  businessId: string
  tokenId: string
}

export type AuthFailure = { reason: "missing" | "invalid" }

/**
 * Resolve a caller, or explain why not.
 *
 * Unknown and revoked tokens return the SAME failure. Distinguishing them tells
 * a prober that a token was once real, which is exactly the bit they are
 * fishing for.
 */
export async function authenticateApiToken(
  admin: SupabaseClient,
  request: Request,
): Promise<{ ok: true; caller: ApiCaller } | { ok: false; failure: AuthFailure }> {
  const header = request.headers.get("authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  if (!token) return { ok: false, failure: { reason: "missing" } }

  const tokenHash = createHash("sha256").update(token).digest("hex")

  const { data } = await admin
    .from("contact_ingest_tokens")
    .select("id, business_id, token_hash, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle<{
      id: string
      business_id: string
      token_hash: string
      revoked_at: string | null
    }>()

  if (!data || data.revoked_at) return { ok: false, failure: { reason: "invalid" } }

  // The database lookup already matched, so this compares two values known to
  // be equal — it is here so the final comparison is constant-time regardless,
  // and so that a future change to a scan-and-compare lookup does not silently
  // become timing-sensitive.
  const a = Buffer.from(tokenHash, "hex")
  const b = Buffer.from(data.token_hash, "hex")
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, failure: { reason: "invalid" } }
  }

  return { ok: true, caller: { businessId: data.business_id, tokenId: data.id } }
}

/**
 * Record that a token was used. Best-effort by design: a failed touch must
 * never fail the request it was observing.
 */
export async function touchToken(admin: SupabaseClient, tokenId: string): Promise<void> {
  try {
    await admin
      .from("contact_ingest_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", tokenId)
  } catch {
    // Deliberately swallowed.
  }
}
