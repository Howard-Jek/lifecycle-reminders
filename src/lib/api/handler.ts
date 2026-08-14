import type { NextResponse } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createAdminClient } from "@/lib/supabase/admin"
import { authenticateApiToken, touchToken, type ApiCaller } from "./auth"
import { serverError, unauthorized } from "./respond"

/**
 * The shape every v1 route shares: authenticate, hand over a tenant-scoped
 * context, and never let a thrown error escape as a stack trace.
 *
 * Worth stating why the handler gets the SERVICE-ROLE client. RLS is row-level
 * and keyed on `auth.uid()`, and a token-authed machine caller has no auth user
 * — so RLS cannot scope it and would simply deny everything. Tenancy here is
 * enforced in application code instead: `caller.businessId` comes from the
 * token, and every query below filters on it explicitly.
 *
 * That trade is only safe if the filter is never forgotten, so it is applied in
 * one obvious place per query rather than being someone's responsibility to
 * remember. `tests/unit/api.tenancy.test.ts` pins that every v1 route file
 * mentions business_id.
 */
export async function withApiToken(
  request: Request,
  context: string,
  fn: (ctx: { admin: SupabaseClient; caller: ApiCaller }) => Promise<NextResponse>,
): Promise<NextResponse> {
  const admin = createAdminClient()

  const auth = await authenticateApiToken(admin, request)
  if (!auth.ok) return unauthorized(auth.failure)

  try {
    const response = await fn({ admin, caller: auth.caller })
    await touchToken(admin, auth.caller.tokenId)
    return response
  } catch (err) {
    return serverError(context, err)
  }
}

/**
 * Read a bounded, sane `limit` off the query string.
 *
 * Defaulting rather than erroring on nonsense: a caller that sends `limit=abc`
 * wants a page of results, not a lecture. The cap exists because PostgREST
 * silently truncates at 1000 and a caller who asked for more would otherwise
 * believe it had received everything.
 */
export function readLimit(url: URL, fallback = 50, max = 200): number {
  const raw = Number(url.searchParams.get("limit"))
  if (!Number.isFinite(raw) || raw < 1) return fallback
  return Math.min(Math.floor(raw), max)
}

/** Offset paging. Cursor paging would be better under concurrent writes; this
 * is honest about being simple, and the endpoints that use it are read-mostly. */
export function readOffset(url: URL): number {
  const raw = Number(url.searchParams.get("offset"))
  if (!Number.isFinite(raw) || raw < 0) return 0
  return Math.floor(raw)
}
