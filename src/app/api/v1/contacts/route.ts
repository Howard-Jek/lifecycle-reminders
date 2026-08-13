import { NextResponse } from "next/server"
import { createHash } from "node:crypto"
import { z } from "zod"
import { createAdminClient } from "@/lib/supabase/admin"
import { normalizePhone, parseCalendarDate, titleCaseName } from "@/lib/sanitize"
import { ingestContacts, type IngestContact, type IngestRejection } from "@/lib/import/ingest"

/**
 * Token-authed contact ingest.
 *
 * The standalone's integration seam: GomaAI (or a CRM, or a Zap) can push
 * contacts and their dates in without this app reaching into anyone's
 * database. Same `ingestContacts` path as the upload wizard, so the two cannot
 * drift.
 *
 * Auth is a bearer token compared by SHA-256 against `contact_ingest_tokens`.
 * The request carries no tenant identity of its own — the token IS the tenant
 * resolution, which is why its hash is globally unique.
 */

export const dynamic = "force-dynamic"

/** Bounded so one call cannot become an unbounded write. */
const MAX_CONTACTS = 500

const EventSchema = z.object({
  type: z.string().trim().min(1).max(100),
  date: z.string().trim().min(1).max(40),
  label: z.string().trim().max(200).nullish(),
  recurrence: z.enum(["none", "yearly"]).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
})

const ContactSchema = z.object({
  name: z.string().trim().max(200).nullish(),
  phone: z.string().trim().min(1).max(40),
  email: z.string().trim().max(200).nullish(),
  agent: z.string().trim().max(200).nullish(),
  events: z.array(EventSchema).max(50).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
})

const BodySchema = z.object({
  contacts: z.array(ContactSchema).min(1).max(MAX_CONTACTS),
  /**
   * Dial code or ISO-2 used to complete local phone numbers. Explicit rather
   * than inferred: guessing here silently attaches a Singapore number to a
   * Malaysian client.
   */
  default_country_code: z.string().trim().max(8).nullish(),
  /** e.g. "DD/MM/YYYY". Omit only when every date is already ISO. */
  date_format: z.string().trim().max(40).nullish(),
})

export async function POST(request: Request) {
  const header = request.headers.get("authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  if (!token) {
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 })
  }

  const admin = createAdminClient()
  const tokenHash = createHash("sha256").update(token).digest("hex")

  const { data: tokenRow } = await admin
    .from("contact_ingest_tokens")
    .select("id, business_id, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle<{ id: string; business_id: string; revoked_at: string | null }>()

  // One response for unknown and revoked alike — the difference is a probe.
  if (!tokenRow || tokenRow.revoked_at) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 })
  }

  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", issues: parsed.error.issues.slice(0, 20) },
      { status: 400 },
    )
  }

  const { contacts: incoming, default_country_code: countryCode, date_format: dateFormat } =
    parsed.data

  const contacts: IngestContact[] = []
  const rejections: IngestRejection[] = []

  incoming.forEach((row, index) => {
    const rowNumber = index + 1
    const raw = row as unknown as Record<string, unknown>

    const name = titleCaseName(row.name ?? null)
    if (!name) {
      rejections.push({ rowNumber, reason: "missing_name", raw })
      return
    }

    const phone = normalizePhone(row.phone, countryCode ?? null)
    if (!phone.phone) {
      rejections.push({
        rowNumber,
        reason: "invalid_phone",
        detail: phone.reason,
        raw,
        parsed: { name },
      })
      return
    }

    // An unreadable date is a row-level problem, not a contact-level one: the
    // contact still lands, and the date goes to the review queue so nobody has
    // to diff a spreadsheet to find out which cell was wrong.
    const events = []
    for (const event of row.events ?? []) {
      const date = parseCalendarDate(event.date, dateFormat ?? null)
      if (!date) {
        rejections.push({
          rowNumber,
          reason: "unparseable_date",
          detail: `"${event.date}" for ${event.type}`,
          raw,
          parsed: { name, phone: phone.phone },
        })
        continue
      }
      events.push({
        event_type: event.type,
        event_date: date,
        label: event.label ?? null,
        recurrence: event.recurrence ?? "none",
        payload: event.payload ?? {},
      })
    }

    contacts.push({
      rowNumber,
      name,
      phone: phone.phone,
      email: row.email ?? null,
      agentValue: row.agent ?? null,
      events,
      extra: row.extra ?? {},
      raw,
    })
  })

  try {
    const result = await ingestContacts(admin, {
      businessId: tokenRow.business_id,
      source: "api",
      ingestTokenId: tokenRow.id,
      contacts,
      rejections,
    })

    // Best-effort: a failed touch must not fail the ingest.
    await admin
      .from("contact_ingest_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", tokenRow.id)

    return NextResponse.json({
      ok: true,
      import_id: result.importId,
      received: result.totalRows,
      created: result.createdRows,
      updated: result.updatedRows,
      events_created: result.eventsCreated,
      needs_review: result.reviewRows,
      // Already inside their lead time — these go out on the next tick.
      due_now: result.due,
      errors: result.errors,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[ingest] failed:", message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
