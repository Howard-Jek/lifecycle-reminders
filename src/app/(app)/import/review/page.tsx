import Link from "next/link"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { ReviewClient, type ReviewRow } from "./review-client"

export const dynamic = "force-dynamic"

/**
 * The review queue.
 *
 * The gap PR #16 left open: unattributed and unparseable rows were counted in
 * the import log and listed nowhere, so the operator's only recourse was to
 * re-upload and hope. Persisting the raw row makes each one resolvable without
 * the source file.
 */
export default async function ReviewPage() {
  const tenant = await requireTenant()
  const admin = createAdminClient()

  const [{ data: rows }, { data: memberRows }] = await Promise.all([
    admin
      .from("contact_import_reviews")
      .select("id, row_number, raw, parsed, reason, detail, created_at, import_id")
      .eq("business_id", tenant.businessId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(200),
    admin
      .from("team_members")
      .select("id, display_name, active")
      .eq("business_id", tenant.businessId)
      .eq("active", true)
      .order("display_name"),
  ])

  return (
    <div className="space-y-6">
      <div>
        <Link href="/import" className="text-sm text-muted-foreground hover:underline">
          ← Import
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Review queue</h1>
        <p className="text-sm text-muted-foreground">
          Rows the importer would have had to guess at. Their reminders fall back to the owner
          until somebody decides.
        </p>
      </div>

      <ReviewClient
        rows={(rows ?? []) as unknown as ReviewRow[]}
        members={(memberRows ?? []) as Array<{ id: string; display_name: string }>}
      />
    </div>
  )
}
