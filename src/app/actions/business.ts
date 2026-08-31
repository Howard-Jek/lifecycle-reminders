"use server"

import { revalidatePath } from "next/cache"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import type { ActionResult } from "./team-members"
import { isVertical, type Vertical } from "@/lib/lifecycle/verticals"

export type BusinessProfile = {
  business_name: string
  country_code: string
  timezone: string
  /**
   * The operator's industry, selecting their reminder pack.
   *
   * NULL is a real state, not a missing value: it means the question has not
   * been asked yet. `other` is a positive answer meaning "none of these fit".
   * Both resolve to the generic pack; only one of them is a question.
   */
  vertical: Vertical | null
}

export async function getBusinessProfile(): Promise<BusinessProfile> {
  const tenant = await requireTenant()
  const { data } = await createAdminClient()
    .from("businesses")
    .select("business_name, country_code, timezone, vertical")
    .eq("id", tenant.businessId)
    .maybeSingle<BusinessProfile>()

  return {
    business_name: data?.business_name ?? "",
    country_code: data?.country_code ?? "SG",
    timezone: data?.timezone ?? "Asia/Singapore",
    // Narrowed rather than trusted: this column predates its CHECK on older
    // rows, and an unrecognised value should read as "not chosen" rather than
    // reaching a <select> that has no matching option.
    vertical: isVertical(data?.vertical) ? data.vertical : null,
  }
}

export async function saveBusinessProfile(input: BusinessProfile): Promise<ActionResult> {
  const tenant = await requireTenant()

  const name = input.business_name.trim()
  const country = input.country_code.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(country)) {
    return { ok: false, error: "Country must be a two-letter ISO code, e.g. SG." }
  }

  // Validated against Intl rather than a list: an unknown zone makes every
  // due_at silently fall back to UTC, which moves every reminder by hours.
  const timezone = input.timezone.trim()
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone })
  } catch {
    return { ok: false, error: `"${timezone}" is not a timezone this system recognises.` }
  }

  // Checked here as well as by the CHECK constraint, so a bad value comes back
  // as a sentence rather than as a Postgres error nobody can read. `null` is
  // allowed through: clearing the industry is a legitimate edit.
  if (input.vertical !== null && !isVertical(input.vertical)) {
    return { ok: false, error: "That is not an industry we recognise." }
  }

  // UPDATE, never upsert: businesses rows are minted only by getTenant().
  // Selecting back turns "no row matched" — which supabase-js reports as
  // success — into a real failure.
  const { data, error } = await createAdminClient()
    .from("businesses")
    .update({ business_name: name, country_code: country, timezone, vertical: input.vertical })
    .eq("id", tenant.businessId)
    .select("id")
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: "Business not found." }

  revalidatePath("/settings")
  return { ok: true }
}
