"use server"

import { revalidatePath } from "next/cache"
import { randomBytes, createHash } from "node:crypto"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import type { ActionResult } from "./team-members"

/** What the UI is allowed to see. Never token_hash. */
export type IngestTokenView = {
  id: string
  name: string
  token_prefix: string
  last_used_at: string | null
  created_at: string
}

/**
 * Read through the service role, not the browser client.
 *
 * contact_ingest_tokens is a secret table with zero policies precisely because
 * RLS is row-level: any SELECT policy would ship token_hash alongside the
 * columns the settings page actually wants.
 */
export async function listIngestTokens(): Promise<IngestTokenView[]> {
  const tenant = await requireTenant()
  const { data, error } = await createAdminClient()
    .from("contact_ingest_tokens")
    .select("id, name, token_prefix, last_used_at, created_at")
    .eq("business_id", tenant.businessId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
  if (error) {
    console.error("[ingest-tokens] list failed:", error.message)
    return []
  }
  return (data ?? []) as IngestTokenView[]
}

/**
 * Mint a token. The raw value is returned once and never stored.
 *
 * 32 random bytes as hex: this is the sole credential on an endpoint that
 * writes contacts, so it has to be unguessable rather than merely unique.
 */
export async function createIngestToken(name: string): Promise<ActionResult<string>> {
  const tenant = await requireTenant()
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, error: "Give the key a name so you know what it is for." }

  const raw = randomBytes(32).toString("hex")
  const { error } = await createAdminClient().from("contact_ingest_tokens").insert({
    business_id: tenant.businessId,
    name: trimmed,
    token_hash: createHash("sha256").update(raw).digest("hex"),
    token_prefix: raw.slice(0, 8),
    created_by: tenant.userId,
  })

  if (error) {
    console.error("[ingest-tokens] create failed:", error.message)
    return { ok: false, error: error.message }
  }

  revalidatePath("/settings")
  return { ok: true, data: raw }
}

export async function revokeIngestToken(id: string): Promise<ActionResult> {
  const tenant = await requireTenant()
  // Stamped rather than deleted: the import rows that reference it stay
  // attributable, so "who pushed these 400 contacts?" survives the revoke.
  const { data, error } = await createAdminClient()
    .from("contact_ingest_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("business_id", tenant.businessId)
    .select("id")
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: "That key no longer exists." }

  revalidatePath("/settings")
  return { ok: true }
}
