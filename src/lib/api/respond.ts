import { NextResponse } from "next/server"
import type { z } from "zod"
import type { AuthFailure } from "./auth"

/**
 * One response envelope for the whole v1 API.
 *
 * Every success is `{ ok: true, ... }` and every failure is
 * `{ ok: false, error: string }`, because the caller is a program: it should be
 * able to branch on one field without knowing which endpoint it called. The
 * existing ingest endpoint already answered this way; these helpers make it the
 * rule rather than a coincidence.
 */

export function ok<T extends Record<string, unknown>>(data: T): NextResponse {
  return NextResponse.json({ ok: true, ...data })
}

export function badRequest(error: string, issues?: z.ZodIssue[]): NextResponse {
  return NextResponse.json(
    // Capped: a malformed bulk body can produce hundreds of issues, and a
    // response big enough to be its own problem helps nobody debug.
    { ok: false, error, ...(issues ? { issues: issues.slice(0, 20) } : {}) },
    { status: 400 },
  )
}

export function unauthorized(failure: AuthFailure): NextResponse {
  return NextResponse.json(
    { ok: false, error: failure.reason === "missing" ? "missing bearer token" : "invalid token" },
    { status: 401 },
  )
}

/**
 * Used both for genuinely absent rows and for rows belonging to another tenant.
 *
 * That is deliberate. Answering 403 for a row that exists elsewhere confirms it
 * exists, turning the endpoint into an oracle for enumerating other businesses'
 * ids. "Not found" is true from where the caller is standing.
 */
export function notFound(what = "not found"): NextResponse {
  return NextResponse.json({ ok: false, error: what }, { status: 404 })
}

export function methodNotAllowed(): NextResponse {
  return NextResponse.json({ ok: false, error: "method not allowed" }, { status: 405 })
}

/** The message is logged in full; the caller gets a stable, uninformative one. */
export function serverError(context: string, err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[api/v1] ${context}: ${message}`)
  return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 })
}

/** Parse JSON without letting a malformed body throw past the handler. */
export async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await request.json() }
  } catch {
    return { ok: false }
  }
}
