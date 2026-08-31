/**
 * Which contacts belong to the industry currently being previewed.
 *
 * The switcher on its own only changes WORDS — the same contacts stay on
 * screen, relabelled. That is honest about the engine (a pack is vocabulary,
 * not a filter) and useless as a demo: reading dental labels over a book of
 * insurance policies tells you nothing about whether the dental pack is any
 * good.
 *
 * So when an override is in force, the app is scoped to that vertical's demo
 * contacts — seeded by scripts/seed-verticals.ts and tagged
 * `leads.context.demo_vertical`.
 *
 * DEV ONLY, and the gating is not a detail. Filtering rows is a far more
 * dangerous behaviour than renaming a column: a filter that leaked into
 * production would HIDE an operator's contacts and their due reminders, with
 * no error and nothing on screen to say anything was missing. That is the
 * worst failure this product could have, so the scope resolves to null in
 * production before it reads anything, and null is "no filter at all" rather
 * than "an empty list".
 *
 * DELETED AT INTEGRATION with the rest of src/lib/dev/.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { devVerticalOverride } from "./vertical-switch"

/** The key scripts/seed-verticals.ts writes into leads.context. */
export const DEMO_VERTICAL_KEY = "demo_vertical"

export type VerticalScope = {
  vertical: string
  /** The demo contacts for this vertical. Possibly empty — see below. */
  leadIds: string[]
  /** Their dates, so reminders can be narrowed without a two-level embed. */
  eventIds: string[]
}

/**
 * Resolve the scope for this request, or null when nothing should be filtered.
 *
 * Null in three cases, and they are all "show everything": production, no
 * override chosen, or the override could not be resolved. An EMPTY scope is
 * different and deliberate — a vertical with no demo contacts seeded shows an
 * empty book, which is the truth about that vertical rather than a fallback to
 * somebody else's data.
 */
export async function devVerticalScope(
  admin: SupabaseClient,
  businessId: string,
): Promise<VerticalScope | null> {
  const vertical = await devVerticalOverride()
  if (!vertical) return null

  const { data: leads, error: leadErr } = await admin
    .from("leads")
    .select("id")
    .eq("business_id", businessId)
    .eq(`context->>${DEMO_VERTICAL_KEY}`, vertical)

  if (leadErr) {
    // Loud, and then no filter. Failing OPEN is right here for the same reason
    // the production gate exists: showing too much in a dev preview is a
    // cosmetic problem, showing too little looks like data loss.
    console.error(`[dev-scope] could not resolve ${vertical}: ${leadErr.message}`)
    return null
  }

  const leadIds = (leads ?? []).map((l) => l.id as string)
  if (leadIds.length === 0) return { vertical, leadIds: [], eventIds: [] }

  const { data: events, error: eventErr } = await admin
    .from("contact_events")
    .select("id")
    .eq("business_id", businessId)
    .in("lead_id", leadIds)

  if (eventErr) {
    console.error(`[dev-scope] could not resolve dates for ${vertical}: ${eventErr.message}`)
    return null
  }

  return { vertical, leadIds, eventIds: (events ?? []).map((e) => e.id as string) }
}
