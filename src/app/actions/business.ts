"use server"

import { revalidatePath } from "next/cache"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import type { ActionResult } from "./team-members"

export type BusinessProfile = {
  business_name: string
  country_code: string
  timezone: string
}

export async function getBusinessProfile(): Promise<BusinessProfile> {
  const tenant = await requireTenant()
  const { data } = await createAdminClient()
    .from("businesses")
    .select("business_name, country_code, timezone")
    .eq("id", tenant.businessId)
    .maybeSingle<BusinessProfile>()

  return {
    business_name: data?.business_name ?? "",
    country_code: data?.country_code ?? "SG",
    timezone: data?.timezone ?? "Asia/Singapore",
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

  // UPDATE, never upsert: businesses rows are minted only by getTenant().
  // Selecting back turns "no row matched" — which supabase-js reports as
  // success — into a real failure.
  const { data, error } = await createAdminClient()
    .from("businesses")
    .update({ business_name: name, country_code: country, timezone })
    .eq("id", tenant.businessId)
    .select("id")
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: "Business not found." }

  revalidatePath("/settings")
  return { ok: true }
}
