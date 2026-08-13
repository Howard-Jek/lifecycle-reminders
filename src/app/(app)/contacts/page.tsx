import Link from "next/link"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { ContactSearch } from "./search"
import { Users } from "lucide-react"

export const dynamic = "force-dynamic"

const PAGE_SIZE = 50

/**
 * The contact list.
 *
 * The URL owns the query, and filtering and paging happen in Postgres — never
 * client-side over a partial page, which is the bug that makes a search box
 * look like it works until row 51.
 */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const q = typeof params.q === "string" ? params.q.trim() : ""
  const page = Math.max(0, Number(typeof params.page === "string" ? params.page : 0) || 0)

  const tenant = await requireTenant()
  const admin = createAdminClient()

  let query = admin
    .from("leads")
    .select("id, name, phone, email, assigned_member_id", { count: "exact" })
    .eq("business_id", tenant.businessId)
    .order("name")
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

  if (q) {
    // Escape the PostgREST or() separators so a comma or paren in the search
    // box cannot restructure the filter.
    const safe = q.replace(/[(),*]/g, " ").trim()
    if (safe) query = query.or(`name.ilike.%${safe}%,phone.ilike.%${safe}%,email.ilike.%${safe}%`)
  }

  const { data, count, error } = await query
  const rows = data ?? []

  const { data: memberRows } = await admin
    .from("team_members")
    .select("id, display_name")
    .eq("business_id", tenant.businessId)
  const members = new Map((memberRows ?? []).map((m) => [m.id as string, m.display_name as string]))

  // Event counts for the rows on screen only.
  const counts = new Map<string, number>()
  if (rows.length > 0) {
    const { data: events } = await admin
      .from("contact_events")
      .select("lead_id")
      .eq("business_id", tenant.businessId)
      .in(
        "lead_id",
        rows.map((r) => r.id as string),
      )
    for (const e of events ?? []) {
      const id = e.lead_id as string
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Contacts</h1>
        <p className="text-sm text-muted-foreground">
          {count ?? 0} {count === 1 ? "contact" : "contacts"}, and the dates worth watching.
        </p>
      </div>

      <div className="rounded-xl border bg-background shadow-sm">
        <div className="flex flex-col gap-4 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <ContactSearch initial={q} />
        </div>

        {error ? (
          <p className="m-5 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error.message}
          </p>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <div className="rounded-full bg-muted p-3">
              <Users className="size-5 text-muted-foreground" strokeWidth={1.75} />
            </div>
            <p className="text-sm font-medium">{q ? "No matches" : "No contacts yet"}</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {q ? "Try a different name or number." : "Import a spreadsheet to get started."}
            </p>
            {!q && (
              <Link
                href="/import"
                className="mt-2 inline-flex h-8 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Import contacts
              </Link>
            )}
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[30%] pl-5">Name</TableHead>
                  <TableHead className="w-[22%]">Phone</TableHead>
                  <TableHead className="w-[24%]">Agent</TableHead>
                  <TableHead className="w-[24%] pr-5 text-right">Dates</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id as string}>
                    <TableCell className="pl-5 font-medium">
                      {/* Same treatment as the reminder list's link to this
                          exact destination. A column of brand colour is a lot,
                          and toning it down here was tempting — but the host's
                          link colour is the host's to change, and forking it in
                          one table buys a calmer page at the cost of the app
                          disagreeing with itself about what a link looks like. */}
                      <Link
                        href={`/contacts/${row.id}`}
                        className="rounded-sm text-brand-ink hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        {row.name as string}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular-nums">
                      {row.phone as string}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.assigned_member_id ? (
                        members.get(row.assigned_member_id as string) ?? "Removed"
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">
                          unassigned
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="pr-5 text-right tabular-nums">
                      {counts.get(row.id as string) ?? 0}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t px-5 py-3">
                <PageLink q={q} page={page - 1} disabled={page === 0} label="Previous" />
                <span className="min-w-[3rem] text-center text-sm tabular-nums text-muted-foreground">
                  {page + 1} / {totalPages}
                </span>
                <PageLink
                  q={q}
                  page={page + 1}
                  disabled={page + 1 >= totalPages}
                  label="Next"
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function PageLink({
  q,
  page,
  disabled,
  label,
}: {
  q: string
  page: number
  disabled: boolean
  label: string
}) {
  if (disabled) {
    return <span className="text-sm text-muted-foreground/40">{label}</span>
  }
  const search = new URLSearchParams()
  if (q) search.set("q", q)
  if (page > 0) search.set("page", String(page))
  return (
    <Link
      href={`/contacts${search.size ? `?${search}` : ""}`}
      className="text-sm font-medium text-brand-ink hover:underline"
    >
      {label}
    </Link>
  )
}
