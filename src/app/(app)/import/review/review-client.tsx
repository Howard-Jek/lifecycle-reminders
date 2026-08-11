"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { REVIEW_REASON_LABEL, type ReviewReason } from "@/lib/types"
import { resolveReview } from "@/app/actions/imports"

export type ReviewRow = {
  id: string
  row_number: number
  raw: Record<string, string>
  parsed: Record<string, unknown>
  reason: ReviewReason
  detail: string | null
  created_at: string
}

export function ReviewClient({
  rows,
  members,
}: {
  rows: ReviewRow[]
  members: Array<{ id: string; display_name: string }>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<Record<string, string>>({})

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-12 text-center shadow-sm ring-1 ring-foreground/5">
        <div className="mx-auto w-fit rounded-full bg-emerald-500/10 p-3">
          <CheckCircle2
            className="size-6 text-emerald-600 dark:text-emerald-400"
            strokeWidth={1.75}
          />
        </div>
        <p className="mt-4 text-sm font-medium">Nothing to review</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Every imported row was attributed without a guess.
        </p>
      </div>
    )
  }

  function run(id: string, memberId: string | null) {
    setError(null)
    startTransition(async () => {
      const result = await resolveReview(id, memberId)
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      {rows.map((row) => {
        const canAssign = Boolean(row.parsed?.lead_id)
        return (
          <div
            key={row.id}
            className="rounded-xl border bg-card p-5 shadow-sm ring-1 ring-foreground/5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {(row.parsed?.name as string) ?? `Row ${row.row_number}`}
                  <Badge variant="outline" className="text-amber-700 dark:text-amber-400">
                    {REVIEW_REASON_LABEL[row.reason] ?? row.reason}
                  </Badge>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Row {row.row_number}
                  {row.detail ? ` · ${row.detail}` : ""}
                </p>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {canAssign && (
                  <>
                    <select
                      value={choice[row.id] ?? ""}
                      onChange={(e) => setChoice({ ...choice, [row.id]: e.target.value })}
                      className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring"
                    >
                      <option value="">Assign to…</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.display_name}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      disabled={pending || !choice[row.id]}
                      onClick={() => run(row.id, choice[row.id])}
                    >
                      Assign
                    </Button>
                  </>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => run(row.id, null)}
                >
                  Dismiss
                </Button>
              </div>
            </div>

            {/* The row as received. Persisted so a fix needs no re-upload. */}
            <div className="mt-3 overflow-x-auto rounded-lg bg-muted/60 p-3">
              <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
                {Object.entries(row.raw)
                  .filter(([, value]) => String(value ?? "").trim())
                  .slice(0, 12)
                  .map(([key, value]) => (
                    <div key={key} className="flex gap-1.5">
                      <dt className="text-muted-foreground">{key}:</dt>
                      <dd className="font-medium">{String(value)}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          </div>
        )
      })}
    </div>
  )
}
