import { z } from "zod"
import { withApiToken } from "@/lib/api/handler"
import { ok, badRequest, readJson } from "@/lib/api/respond"
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
 * resolution, which is why its hash is globally unique. That check now lives in
 * `lib/api/auth.ts` and is shared with every other v1 route: an auth check that
 * exists twice is one that will eventually disagree with itself.
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
  return withApiToken(request, "contacts.ingest", async ({ admin, caller }) => {
    const json = await readJson(request)
    if (!json.ok) return badRequest("body must be JSON")

    const parsed = BodySchema.safeParse(json.body)
    if (!parsed.success) return badRequest("invalid body", parsed.error.issues)

    const {
      contacts: incoming,
      default_country_code: countryCode,
      date_format: dateFormat,
    } = parsed.data

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

    const result = await ingestContacts(admin, {
      businessId: caller.businessId,
      source: "api",
      ingestTokenId: caller.tokenId,
      contacts,
      rejections,
    })

    return ok({
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
  })
}
