/**
 * Resolve a spreadsheet's agent cell ("Servicing FA", "RM", "Agent") to a
 * team member.
 *
 * Deterministic only. This is the correctness half of the multi-tenant
 * challenge — if a client is attributed to the wrong agent, the wrong person is
 * reminded and the right one never is — so it NEVER guesses. Anything short of
 * an unambiguous match returns `needs_review`, and the import surfaces those
 * rows for the operator to assign. Their reminders fall back to the org owner's
 * number in the meantime, so nothing is silently lost.
 *
 * A fuzzy AI pass ("J. Tan" → "Jasmine Tan") is a deliberate later addition,
 * and it should propose into the same review queue rather than auto-assign.
 */

import type { TeamMember } from "./types"

export type MemberMatch =
  | { status: "matched"; memberId: string; matchedOn: "email" | "phone" | "name" }
  | { status: "unassigned" }
  | { status: "needs_review"; reason: "no_match" | "ambiguous"; candidates: string[] }

/** Lowercase, collapse whitespace, drop punctuation and common honorifics so
 * "Ms. Jasmine  Tan" and "jasmine tan" compare equal. */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(mr|mrs|ms|miss|dr|prof)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Digits only, so "+65 9123 4567" and "6591234567" compare equal. */
function normalizePhone(value: string): string {
  return value.replace(/\D/g, "")
}

export function matchTeamMember(
  rawValue: string | undefined | null,
  members: TeamMember[],
): MemberMatch {
  const value = rawValue?.trim()
  // A blank agent cell is a legitimate state, not an error: the client simply
  // isn't assigned yet. Distinguished from needs_review so the operator's
  // review queue only contains rows that actually need a decision.
  if (!value) return { status: "unassigned" }

  const active = members.filter((m) => m.active)
  if (active.length === 0) return { status: "needs_review", reason: "no_match", candidates: [] }

  // Email is the only truly unique identifier here, so it wins outright.
  const asEmail = value.toLowerCase()
  const byEmail = active.filter((m) => m.email?.toLowerCase() === asEmail)
  if (byEmail.length === 1) {
    return { status: "matched", memberId: byEmail[0].id, matchedOn: "email" }
  }

  const digits = normalizePhone(value)
  if (digits.length >= 7) {
    // Suffix comparison so a sheet's local "91234567" matches a stored
    // "+6591234567" without needing to know the country code.
    const byPhone = active.filter((m) => {
      const stored = normalizePhone(m.whatsapp_number)
      return stored.endsWith(digits) || digits.endsWith(stored)
    })
    if (byPhone.length === 1) {
      return { status: "matched", memberId: byPhone[0].id, matchedOn: "phone" }
    }
    if (byPhone.length > 1) {
      return { status: "needs_review", reason: "ambiguous", candidates: byPhone.map((m) => m.id) }
    }
  }

  const normalized = normalizeName(value)
  if (normalized) {
    const byName = active.filter((m) => normalizeName(m.display_name) === normalized)
    if (byName.length === 1) {
      return { status: "matched", memberId: byName[0].id, matchedOn: "name" }
    }
    // Two agents genuinely called "John Tan" is exactly when guessing is worst.
    if (byName.length > 1) {
      return { status: "needs_review", reason: "ambiguous", candidates: byName.map((m) => m.id) }
    }
  }

  return { status: "needs_review", reason: "no_match", candidates: [] }
}

/** Resolve one agent value per lead phone, plus the rows needing a human. */
export function matchMembersForRows(
  rows: Array<{ rowNumber: number; phone: string; agentValue: string | undefined }>,
  members: TeamMember[],
): {
  assignmentByPhone: Map<string, string | null>
  review: Array<{ rowNumber: number; phone: string; agentValue: string; reason: string }>
} {
  const assignmentByPhone = new Map<string, string | null>()
  const review: Array<{ rowNumber: number; phone: string; agentValue: string; reason: string }> = []

  for (const row of rows) {
    const match = matchTeamMember(row.agentValue, members)
    if (match.status === "matched") {
      assignmentByPhone.set(row.phone, match.memberId)
      continue
    }
    // Unassigned and needs-review both leave the lead unassigned; only the
    // latter is worth the operator's attention.
    assignmentByPhone.set(row.phone, null)
    if (match.status === "needs_review") {
      review.push({
        rowNumber: row.rowNumber,
        phone: row.phone,
        agentValue: (row.agentValue ?? "").trim(),
        reason: match.reason,
      })
    }
  }

  return { assignmentByPhone, review }
}
