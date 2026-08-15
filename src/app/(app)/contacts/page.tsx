import Link from "next/link"
import { requireTenant } from "@/lib/tenant"
import { createAdminClient } from "@/lib/supabase/admin"
import { cn } from "@/lib/utils"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { ContactSearch } from "./search"
import { Users } from "lucide-react"

export const metadata = { title: "Contacts" }

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
  // Bounded before it reaches the query. The filter below interpolates `q` into
  // a PostgREST `or()` expression, so length is not cosmetic: an unbounded
  // string becomes an unbounded expression, and 18,000 characters of it was
  // enough to make the database return an error the page then rendered.
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 100) : ""
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
    // Two separate jobs, and they were being confused for one.
    //
    // First: neutralise the PostgREST or() separators, so a comma or paren in
    // the search box cannot restructure the filter.
    //
    // Second: escape the LIKE metacharacters. `%` and `_` are wildcards inside
    // ilike, so searching for "50%" used to match every contact rather than
    // none — not a security hole, but a search box that silently lies.
    const safe = q
      .replace(/[(),*]/g, " ")
      .replace(/[%_\\]/g, (m) => "\\" + m)
      .trim()
    if (safe) query = query.or(`name.ilike.%${safe}%,phone.ilike.%${safe}%,email.ilike.%${safe}%`)
  }

  // The roster does not depend on which page of contacts is being shown, so it
  // rides alongside rather than after. A Supabase round-trip is ~130ms from a
  // laptop regardless of what it returns; sequencing two independent queries
  // doubles that for nothing.
  const [{ data, count, error }, memberRes] = await Promise.all([
    query,
    admin.from("team_members").select("id, display_name").eq("business_id", tenant.businessId),
  ])
  const rows = data ?? []
  // Logged here so the detail survives for whoever debugs it; the page below
  // renders a fixed string instead.
  if (error) console.error(`[contacts] query failed: ${error.message}`)
  const members = new Map(
    (memberRes.data ?? []).map((m) => [m.id as string, m.display_name as string]),
  )

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
          // The raw driver message is logged, not rendered. It carries column
          // names, SQLSTATE codes and fragments of the generated query — free
          // schema disclosure to anyone who can make the query fail, which
          // until the clamp above took a single long search term.
          <p className="m-5 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Could not load contacts. Try a simpler search, or reload the page.
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
  // Both states share a size so the row does not reflow as you page through,
  // and the enabled one clears the 24px minimum hit area — as a bare text link
  // it was 31×20px, which only became visible once there were enough contacts
  // to need a second page.
  const shared = "inline-flex h-8 items-center rounded-lg px-2.5 text-sm font-medium"

  if (disabled) {
    return <span className={cn(shared, "text-muted-foreground/40")}>{label}</span>
  }

  const search = new URLSearchParams()
  if (q) search.set("q", q)
  if (page > 0) search.set("page", String(page))
  return (
    <Link
      href={`/contacts${search.size ? `?${search}` : ""}`}
      className={cn(
        shared,
        "text-brand-ink transition-colors hover:bg-muted hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
      )}
    >
      {label}
    </Link>
  )
}
