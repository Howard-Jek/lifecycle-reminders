"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CalendarPlus, Plus, RotateCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { CopyButton } from "@/components/copy-button"
import {
  createTeamMember,
  updateTeamMember,
  setTeamMemberActive,
  issueCalendarFeed,
  revokeCalendarFeed,
  type MemberInput,
} from "@/app/actions/team-members"
import type { TeamMember } from "@/lib/lifecycle/types"

const BLANK: MemberInput = {
  display_name: "",
  email: "",
  whatsapp_number: "",
  role: "agent",
}

export function TeamClient({
  members,
  feeds,
}: {
  members: TeamMember[]
  feeds: Record<string, string>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<MemberInput | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  /** Shown once, then gone: only the hash is stored. */
  const [freshUrl, setFreshUrl] = useState<{ memberId: string; url: string } | null>(null)

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null)
    startTransition(async () => {
      const result = await fn()
      if (!result.ok) {
        setError(result.error)
        return
      }
      setDraft(null)
      setEditingId(null)
      router.refresh()
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Team</h1>
          <p className="text-sm text-muted-foreground">
            Who a client belongs to, and the number their reminders go to.
          </p>
        </div>
        {!draft && (
          <Button onClick={() => setDraft({ ...BLANK })}>
            <Plus data-icon="inline-start" />
            Add member
          </Button>
        )}
      </div>

      {error && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      {freshUrl && (
        <div className="rounded-xl border bg-card p-4 shadow-sm ring-1 ring-brand/20">
          <p className="text-sm font-medium">Calendar link — copy it now</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Only a hash of this link is stored, so this is the one time it can be shown. Subscribe
            to it in Google or Apple Calendar. Re-issue to get a new one.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-muted px-3 py-2 font-mono text-xs">
              {freshUrl.url}
            </code>
            <CopyButton value={freshUrl.url} />
            <Button variant="ghost" size="icon-sm" onClick={() => setFreshUrl(null)}>
              <X />
            </Button>
          </div>
        </div>
      )}

      {draft && (
        <MemberForm
          value={draft}
          pending={pending}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() =>
            run(() => (editingId ? updateTeamMember(editingId, draft) : createTeamMember(draft)))
          }
        />
      )}

      <div className="rounded-xl border bg-background shadow-sm">
        {members.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-muted-foreground">
            No team members yet. Add one so imported clients have somebody to belong to.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[26%] pl-5">Name</TableHead>
                <TableHead className="w-[22%]">WhatsApp</TableHead>
                <TableHead className="w-[22%]">Email</TableHead>
                <TableHead className="w-[12%]">Role</TableHead>
                <TableHead className="w-[18%] pr-5 text-right">Calendar</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <TableRow key={member.id} className={member.active ? undefined : "opacity-50"}>
                  <TableCell className="pl-5 font-medium">
                    <span className="flex items-center gap-2">
                      {member.display_name}
                      {!member.active && (
                        <Badge variant="outline" className="text-muted-foreground">
                          inactive
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {member.whatsapp_number}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{member.email ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={member.role === "owner" ? "secondary" : "ghost"}>
                      {member.role}
                    </Badge>
                  </TableCell>
                  <TableCell className="pr-5">
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            const result = await issueCalendarFeed(member.id)
                            if (result.ok) {
                              setFreshUrl({ memberId: member.id, url: result.data })
                              router.refresh()
                            } else setError(result.error)
                          })
                        }
                      >
                        {feeds[member.id] ? (
                          <RotateCw data-icon="inline-start" />
                        ) : (
                          <CalendarPlus data-icon="inline-start" />
                        )}
                        {feeds[member.id] ? "Re-issue" : "Issue"}
                      </Button>
                      {feeds[member.id] && (
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={pending}
                          onClick={() => run(() => revokeCalendarFeed(member.id))}
                        >
                          Revoke
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={pending}
                        onClick={() => {
                          setEditingId(member.id)
                          setDraft({
                            display_name: member.display_name,
                            email: member.email ?? "",
                            whatsapp_number: member.whatsapp_number,
                            role: member.role as "owner" | "agent",
                          })
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={pending}
                        onClick={() => run(() => setTeamMemberActive(member.id, !member.active))}
                      >
                        {member.active ? "Deactivate" : "Reactivate"}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

function MemberForm({
  value,
  pending,
  onChange,
  onSave,
  onCancel,
}: {
  value: MemberInput
  pending: boolean
  onChange: (next: MemberInput) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm ring-1 ring-foreground/5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name">
          <Input
            value={value.display_name}
            onChange={(e) => onChange({ ...value, display_name: e.target.value })}
            placeholder="Jasmine Tan"
          />
        </Field>
        <Field label="WhatsApp number" hint="Where their reminders arrive">
          <Input
            value={value.whatsapp_number}
            onChange={(e) => onChange({ ...value, whatsapp_number: e.target.value })}
            placeholder="+65 9123 4567"
          />
        </Field>
        <Field label="Email" hint="Optional — helps match imports">
          <Input
            value={value.email ?? ""}
            onChange={(e) => onChange({ ...value, email: e.target.value })}
            placeholder="jasmine@example.com"
          />
        </Field>
        <Field label="Role" hint="The owner receives unassigned reminders">
          <select
            value={value.role}
            onChange={(e) => onChange({ ...value, role: e.target.value as "owner" | "agent" })}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring"
          >
            <option value="agent">Agent</option>
            <option value="owner">Owner</option>
          </select>
        </Field>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Button onClick={onSave} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
