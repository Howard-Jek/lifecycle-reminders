/**
 * The one path contacts take into the database.
 *
 * The upload wizard and `POST /api/v1/contacts` both normalise their input
 * into `IngestContact[]` and hand it here. Deliberately one implementation:
 * two ingest routes that upsert independently drift, and the way you find out
 * is a client whose events landed but whose agent did not.
 *
 * Everything here is deterministic. Attribution never guesses — a name that
 * matches nothing, or matches two people, becomes a review row rather than an
 * assignment.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { matchTeamMember } from "@/lib/lifecycle/match-member"
import { previewDueForLeads, type DuePreview } from "@/lib/lifecycle/due-preview"
import type { TeamMember } from "@/lib/lifecycle/types"
import type { ReviewReason } from "@/lib/types"

export type IngestEvent = {
  event_type: string
  event_date: string // YYYY-MM-DD, already parsed
  label?: string | null
  recurrence?: "none" | "yearly"
  payload?: Record<string, unknown>
}

export type IngestContact = {
  /** 1-based, for the review queue. */
  rowNumber: number
  name: string
  /** E.164, already normalised. */
  phone: string
  email?: string | null
  /** The raw agent cell, resolved against the roster here. */
  agentValue?: string | null
  events: IngestEvent[]
  /** Unmapped columns, kept verbatim into leads.context. */
  extra?: Record<string, unknown>
  /** The row exactly as received, persisted with any review item. */
  raw: Record<string, unknown>
}

/** A row that could not be turned into a contact at all. */
export type IngestRejection = {
  rowNumber: number
  reason: ReviewReason
  detail?: string
  raw: Record<string, unknown>
  parsed?: Record<string, unknown>
}

export type IngestResult = {
  importId: string
  totalRows: number
  createdRows: number
  updatedRows: number
  eventsCreated: number
  reviewRows: number
  /**
   * How much of this import is already inside its lead time and will go out on
   * the next tick. Surfaced so a burst is announced rather than a surprise.
   */
  due: DuePreview
  errors: string[]
}

const CHUNK = 500

export async function ingestContacts(
  admin: SupabaseClient,
  input: {
    businessId: string
    source: "upload" | "api"
    fileName?: string | null
    ingestTokenId?: string | null
    createdBy?: string | null
    contacts: IngestContact[]
    /** Rows the caller already rejected during parsing. */
    rejections?: IngestRejection[]
  },
): Promise<IngestResult> {
  const { businessId, contacts, rejections = [] } = input
  const errors: string[] = []

  const { data: importRow, error: importError } = await admin
    .from("contact_imports")
    .insert({
      business_id: businessId,
      source: input.source,
      file_name: input.fileName ?? null,
      ingest_token_id: input.ingestTokenId ?? null,
      created_by: input.createdBy ?? null,
      status: "processing",
      total_rows: contacts.length + rejections.length,
    })
    .select("id")
    .single()

  if (importError || !importRow) {
    throw new Error(`Could not start the import: ${importError?.message ?? "unknown error"}`)
  }
  const importId = importRow.id as string

  const reviews: Array<{
    business_id: string
    import_id: string
    row_number: number
    raw: Record<string, unknown>
    parsed: Record<string, unknown>
    reason: ReviewReason
    detail: string | null
  }> = rejections.map((r) => ({
    business_id: businessId,
    import_id: importId,
    row_number: r.rowNumber,
    raw: r.raw,
    parsed: r.parsed ?? {},
    reason: r.reason,
    detail: r.detail ?? null,
  }))

  // ── Duplicate phones inside this batch ────────────────────────────────────
  // Upserting the same key twice in one statement is a Postgres error
  // ("ON CONFLICT DO UPDATE command cannot affect row a second time"), so the
  // duplicate has to be resolved here. Last row wins, and the earlier one is
  // queued for review — silently dropping it is how a client's real agent gets
  // overwritten by a stale export.
  const byPhone = new Map<string, IngestContact>()
  for (const contact of contacts) {
    const existing = byPhone.get(contact.phone)
    if (existing) {
      reviews.push({
        business_id: businessId,
        import_id: importId,
        row_number: existing.rowNumber,
        raw: existing.raw,
        parsed: { phone: existing.phone, name: existing.name },
        reason: "duplicate_in_batch",
        detail: `Superseded by row ${contact.rowNumber}, which has the same phone number.`,
      })
    }
    byPhone.set(contact.phone, contact)
  }
  const deduped = Array.from(byPhone.values())

  // ── Attribution ───────────────────────────────────────────────────────────
  const { data: memberRows } = await admin
    .from("team_members")
    .select("*")
    .eq("business_id", businessId)
  const members = (memberRows ?? []) as TeamMember[]

  const assignmentByPhone = new Map<string, string | null>()
  for (const contact of deduped) {
    const match = matchTeamMember(contact.agentValue, members)
    if (match.status === "matched") {
      assignmentByPhone.set(contact.phone, match.memberId)
      continue
    }
    assignmentByPhone.set(contact.phone, null)
    if (match.status === "needs_review") {
      reviews.push({
        business_id: businessId,
        import_id: importId,
        row_number: contact.rowNumber,
        raw: contact.raw,
        parsed: { phone: contact.phone, name: contact.name, agent: contact.agentValue ?? null },
        reason: match.reason === "ambiguous" ? "ambiguous_member" : "unknown_member",
        detail:
          match.reason === "ambiguous"
            ? `"${contact.agentValue}" matches more than one team member.`
            : `"${contact.agentValue}" is not on the team.`,
      })
    }
  }

  // ── Contacts ──────────────────────────────────────────────────────────────
  // Which phones already exist, so created vs updated is a real number rather
  // than a guess. Read before the upsert, deliberately.
  const existingPhones = new Set<string>()
  for (let i = 0; i < deduped.length; i += CHUNK) {
    const slice = deduped.slice(i, i + CHUNK).map((c) => c.phone)
    const { data } = await admin
      .from("leads")
      .select("phone")
      .eq("business_id", businessId)
      .in("phone", slice)
    for (const row of data ?? []) existingPhones.add(row.phone as string)
  }

  const leadIdByPhone = new Map<string, string>()
  for (let i = 0; i < deduped.length; i += CHUNK) {
    const batch = deduped.slice(i, i + CHUNK).map((c) => ({
      business_id: businessId,
      name: c.name,
      phone: c.phone,
      email: c.email ?? null,
      context: c.extra ?? {},
    }))
    const { data, error } = await admin
      .from("leads")
      .upsert(batch, { onConflict: "business_id,phone" })
      .select("id, phone")
    if (error) {
      errors.push(`Contacts ${i + 1}–${i + batch.length}: ${error.message}`)
      continue
    }
    for (const row of data ?? []) leadIdByPhone.set(row.phone as string, row.id as string)
  }

  // ── Events ────────────────────────────────────────────────────────────────
  const eventRows = deduped.flatMap((contact) => {
    const leadId = leadIdByPhone.get(contact.phone)
    if (!leadId) return []
    return contact.events.map((event) => ({
      business_id: businessId,
      lead_id: leadId,
      event_type: event.event_type,
      label: event.label ?? null,
      event_date: event.event_date,
      recurrence: event.recurrence ?? "none",
      source: input.source === "api" ? "api" : "import",
      payload: event.payload ?? {},
    }))
  })

  let eventsCreated = 0
  for (let i = 0; i < eventRows.length; i += CHUNK) {
    const batch = eventRows.slice(i, i + CHUNK)
    // ignoreDuplicates against contact_events_identity_key: re-importing the
    // same spreadsheet is a no-op rather than a pile of duplicates.
    const { data, error } = await admin
      .from("contact_events")
      .upsert(batch, {
        onConflict: "lead_id,event_type,event_date,label",
        ignoreDuplicates: true,
      })
      .select("id")
    if (error) {
      errors.push(`Events ${i + 1}–${i + batch.length}: ${error.message}`)
      continue
    }
    eventsCreated += data?.length ?? 0
  }

  // ── Apply attribution ─────────────────────────────────────────────────────
  // Grouped by member: one UPDATE per agent, not one per contact.
  //
  // Only non-null assignments are written. A blank or stale agent column must
  // never clear an assignment somebody made by hand in the UI.
  const leadsByMember = new Map<string, string[]>()
  for (const [phone, memberId] of assignmentByPhone) {
    if (!memberId) continue
    const leadId = leadIdByPhone.get(phone)
    if (!leadId) continue
    const list = leadsByMember.get(memberId)
    if (list) list.push(leadId)
    else leadsByMember.set(memberId, [leadId])
  }

  for (const [memberId, leadIds] of leadsByMember) {
    for (let i = 0; i < leadIds.length; i += CHUNK) {
      const { error } = await admin
        .from("leads")
        .update({ assigned_member_id: memberId })
        .eq("business_id", businessId)
        .in("id", leadIds.slice(i, i + CHUNK))
      if (error) errors.push(`Assigning to member ${memberId}: ${error.message}`)
    }
  }

  // ── Review queue ──────────────────────────────────────────────────────────
  // Attach the resolved lead where one exists, so resolving a review is a
  // single assignment rather than a re-import.
  for (const review of reviews) {
    const phone = (review.parsed as { phone?: string }).phone
    if (phone && leadIdByPhone.has(phone)) {
      ;(review.parsed as Record<string, unknown>).lead_id = leadIdByPhone.get(phone)
    }
  }

  for (let i = 0; i < reviews.length; i += CHUNK) {
    const { error } = await admin
      .from("contact_import_reviews")
      .upsert(reviews.slice(i, i + CHUNK), { onConflict: "import_id,row_number" })
    if (error) errors.push(`Review queue: ${error.message}`)
  }

  // Computed AFTER the events land and attribution is applied, so it reflects
  // the rows as they actually are — including the assignment this import just
  // made, which decides who each reminder is addressed to.
  const due = await previewDueForLeads(
    admin,
    businessId,
    Array.from(new Set(leadIdByPhone.values())),
  )

  const createdRows = deduped.filter((c) => !existingPhones.has(c.phone)).length
  const result: IngestResult = {
    importId,
    totalRows: contacts.length + rejections.length,
    createdRows,
    updatedRows: deduped.length - createdRows,
    eventsCreated,
    reviewRows: reviews.length,
    due,
    errors,
  }

  await admin
    .from("contact_imports")
    .update({
      // "completed with errors" is still completed: the rows that landed are
      // real, and calling the whole import failed would invite a re-upload
      // that changes nothing.
      status: leadIdByPhone.size === 0 && deduped.length > 0 ? "failed" : "completed",
      created_rows: result.createdRows,
      updated_rows: result.updatedRows,
      events_created: result.eventsCreated,
      review_rows: result.reviewRows,
      errors,
    })
    .eq("id", importId)

  return result
}
