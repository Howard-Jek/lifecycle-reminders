import Link from "next/link"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { ImportClient } from "./import-client"
import { formatDate } from "@/lib/format-time"

export const dynamic = "force-dynamic"

export default async function ImportPage() {
  const tenant = await requireTenant()
  const admin = createAdminClient()

  const [{ data: business }, { data: history }] = await Promise.all([
    admin
      .from("businesses")
      .select("country_code, timezone")
      .eq("id", tenant.businessId)
      .maybeSingle<{ country_code: string | null; timezone: string | null }>(),
    admin
      .from("contact_imports")
      .select("id, source, file_name, status, total_rows, created_rows, updated_rows, events_created, review_rows, created_at")
      .eq("business_id", tenant.businessId)
      .order("created_at", { ascending: false })
      .limit(10),
  ])

  const dialCodes: Record<string, string> = {
    SG: "+65", MY: "+60", US: "+1", GB: "+44", AU: "+61",
  }
  const defaultCountry = dialCodes[(business?.country_code ?? "SG").toUpperCase()] ?? "+65"
  // Server-rendered, so this is not a hydration risk — but without a timezone
  // it would print the SERVER's date, which on Vercel is UTC and can be a day
  // out from the operator's.
  const timezone = business?.timezone || "Asia/Singapore"

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Import</h1>
        <p className="text-sm text-muted-foreground">
          Contacts and their dates, from a spreadsheet. Nothing is guessed — anything unclear goes
          to the review queue.
        </p>
      </div>

      <ImportClient defaultCountry={defaultCountry} />

      {(history ?? []).length > 0 && (
        <section className="rounded-xl border bg-card p-6 shadow-sm ring-1 ring-foreground/5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Recent imports</h2>
            <Link
              href="/import/review"
              className="inline-flex min-h-6 items-center rounded-lg text-sm font-medium text-brand-ink hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Review queue
            </Link>
          </div>
          <ul className="mt-4 divide-y">
            {(history ?? []).map((row) => (
              <li key={row.id as string} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">
                  {(row.file_name as string) ?? `API batch`}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {row.created_rows as number} new · {row.updated_rows as number} updated ·{" "}
                  {row.events_created as number} dates
                </span>
                {(row.review_rows as number) > 0 && (
                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 tabular-nums dark:text-amber-400">
                    {row.review_rows as number} to review
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {formatDate(row.created_at as string, timezone)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
