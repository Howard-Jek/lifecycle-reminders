"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { KeyRound, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CopyButton } from "@/components/copy-button"
import { formatDateTime } from "@/lib/format-time"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  createIngestToken,
  revokeIngestToken,
  type IngestTokenView,
} from "@/app/actions/ingest-tokens"

export function TokensClient({
  tokens,
  timezone,
}: {
  tokens: IngestTokenView[]
  /** The BUSINESS's timezone, not the viewer's — see lib/format-time.ts. */
  timezone: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  /** Shown once. Only the hash is stored, so there is no second chance. */
  const [fresh, setFresh] = useState<string | null>(null)

  return (
    <section className="rounded-xl border bg-card p-6 shadow-sm ring-1 ring-foreground/5">
      <div className="mb-6">
        <h2 className="text-base font-semibold">API keys</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          For <code className="font-mono text-xs">POST /api/v1/contacts</code> — the same path the
          upload wizard uses, so anything that can reach it can feed the engine.
        </p>
      </div>

      {error && (
        <p className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {fresh && (
        <div className="mb-4 rounded-lg border p-4 ring-1 ring-brand/20">
          <p className="text-sm font-medium">Copy this key now</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Only its hash is stored, so it cannot be shown again.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-muted px-3 py-2 font-mono text-xs">
              {fresh}
            </code>
            <CopyButton value={fresh} />
            <Button variant="ghost" size="icon-sm" onClick={() => setFresh(null)}>
              <X />
            </Button>
          </div>
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-end gap-2">
        <div className="flex min-w-[14rem] flex-1 flex-col gap-1">
          <label className="text-sm font-medium">New key name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="GomaAI sync"
          />
        </div>
        <Button
          disabled={pending}
          onClick={() => {
            setError(null)
            startTransition(async () => {
              const result = await createIngestToken(name)
              if (result.ok) {
                setFresh(result.data)
                setName("")
                router.refresh()
              } else setError(result.error)
            })
          }}
        >
          <KeyRound data-icon="inline-start" />
          Create key
        </Button>
      </div>

      {tokens.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No keys yet.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40%]">Name</TableHead>
              <TableHead className="w-[20%]">Prefix</TableHead>
              <TableHead className="w-[25%]">Last used</TableHead>
              <TableHead className="w-[15%] text-right">&nbsp;</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((token) => (
              <TableRow key={token.id}>
                <TableCell className="font-medium">{token.name}</TableCell>
                <TableCell className="font-mono text-xs">{token.token_prefix}…</TableCell>
                <TableCell className="text-muted-foreground">
                  {token.last_used_at ? formatDateTime(token.last_used_at, timezone) : "Never"}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="destructive"
                    size="xs"
                    disabled={pending}
                    onClick={() => {
                      if (!confirm("Revoke this key? Anything using it stops working at once."))
                        return
                      startTransition(async () => {
                        const result = await revokeIngestToken(token.id)
                        if (result.ok) router.refresh()
                        else setError(result.error)
                      })
                    }}
                  >
                    Revoke
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}
