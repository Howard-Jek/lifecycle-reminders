"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Plus, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { humaniseEventType } from "@/lib/lifecycle/labels"
import { SEND_WINDOWS, SEND_WINDOW_LABEL, type SendWindow } from "@/lib/types"
import {
  createReminderRule,
  updateReminderRule,
  deleteReminderRule,
  seedInsuranceRules,
  type RuleInput,
} from "@/app/actions/reminder-rules"
import type { ReminderRule } from "@/lib/lifecycle/types"

const BLANK: RuleInput = {
  event_type: "",
  offset_days: 7,
  audience: "assigned",
  suggest_message: true,
  send_window: "morning",
  active: true,
}

export function RulesClient({ rules }: { rules: ReminderRule[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [draft, setDraft] = useState<RuleInput | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null)
    setNotice(null)
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
    <section className="rounded-xl border bg-card p-6 shadow-sm ring-1 ring-foreground/5">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Reminder rules</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            When a date approaches, who hears about it. Event types are free text — insurance is
            just the first set.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {rules.length === 0 && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await seedInsuranceRules()
                  if (result.ok) {
                    setNotice(`Added ${result.data} starter rules — edit or delete any of them.`)
                    router.refresh()
                  } else setError(result.error)
                })
              }
            >
              <Sparkles data-icon="inline-start" />
              Seed insurance defaults
            </Button>
          )}
          {!draft && (
            <Button onClick={() => setDraft({ ...BLANK })}>
              <Plus data-icon="inline-start" />
              Add rule
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p className="mb-4 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      )}

      {draft && (
        <div className="mb-6 rounded-lg border bg-background p-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Event type</label>
              <Input
                value={draft.event_type}
                onChange={(e) => setDraft({ ...draft, event_type: e.target.value })}
                placeholder="policy_expiry"
              />
              <p className="text-xs text-muted-foreground">
                Anything you like — it must match the column you mapped on import.
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Lead time (days before)</label>
              <Input
                type="number"
                min={0}
                max={365}
                value={draft.offset_days}
                onChange={(e) => setDraft({ ...draft, offset_days: Number(e.target.value) })}
              />
              <p className="text-xs text-muted-foreground">0 fires on the day itself.</p>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Send window</label>
              <select
                value={draft.send_window}
                onChange={(e) =>
                  setDraft({ ...draft, send_window: e.target.value as SendWindow })
                }
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring"
              >
                {SEND_WINDOWS.map((w) => (
                  <option key={w} value={w}>
                    {SEND_WINDOW_LABEL[w]}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">In the business&apos;s own timezone.</p>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Who hears</label>
              <select
                value={draft.audience}
                onChange={(e) =>
                  setDraft({ ...draft, audience: e.target.value as RuleInput["audience"] })
                }
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring"
              >
                <option value="assigned">The assigned agent</option>
                <option value="all_members">Everyone on the team</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Unassigned clients fall back to the owner.
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={draft.suggest_message}
                onCheckedChange={(checked: boolean) =>
                  setDraft({ ...draft, suggest_message: checked })
                }
              />
              Draft a suggested opener
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={draft.active}
                onCheckedChange={(checked: boolean) => setDraft({ ...draft, active: checked })}
              />
              Active
            </label>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <Button
              disabled={pending}
              onClick={() =>
                run(() =>
                  editingId ? updateReminderRule(editingId, draft) : createReminderRule(draft),
                )
              }
            >
              {pending ? "Saving…" : "Save rule"}
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setDraft(null)
                setEditingId(null)
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {rules.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No rules yet. Without one, imported dates sit in the calendar and nothing is ever sent.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[28%]">Event</TableHead>
              <TableHead className="w-[16%]">Lead time</TableHead>
              <TableHead className="w-[18%]">Window</TableHead>
              <TableHead className="w-[20%]">Audience</TableHead>
              <TableHead className="w-[18%] text-right">&nbsp;</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((rule) => (
              <TableRow key={rule.id} className={rule.active ? undefined : "opacity-50"}>
                <TableCell className="font-medium">
                  <span className="flex items-center gap-2">
                    {humaniseEventType(rule.event_type)}
                    {!rule.suggest_message && (
                      <Badge variant="outline" className="text-muted-foreground">
                        no draft
                      </Badge>
                    )}
                    {!rule.active && (
                      <Badge variant="outline" className="text-muted-foreground">
                        paused
                      </Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell className="tabular-nums">
                  {rule.offset_days === 0 ? "On the day" : `${rule.offset_days} days before`}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {SEND_WINDOW_LABEL[rule.send_window as SendWindow]}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {rule.audience === "all_members" ? "Whole team" : "Assigned agent"}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={pending}
                      onClick={() => {
                        setEditingId(rule.id)
                        setDraft({
                          event_type: rule.event_type,
                          offset_days: rule.offset_days,
                          audience: rule.audience as RuleInput["audience"],
                          suggest_message: rule.suggest_message,
                          send_window: rule.send_window as SendWindow,
                          active: rule.active,
                        })
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={pending}
                      onClick={() =>
                        run(() =>
                          updateReminderRule(rule.id, {
                            event_type: rule.event_type,
                            offset_days: rule.offset_days,
                            audience: rule.audience as RuleInput["audience"],
                            suggest_message: rule.suggest_message,
                            send_window: rule.send_window as SendWindow,
                            active: !rule.active,
                          }),
                        )
                      }
                    >
                      {rule.active ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      variant="destructive"
                      size="xs"
                      disabled={pending}
                      onClick={() => {
                        // Deleting cascades to this rule's reminders, including
                        // ones already sent — that record is often the only
                        // proof the agent was told. Pausing is the safe option,
                        // so say so rather than quietly doing it.
                        if (
                          !confirm(
                            "Delete this rule? Its reminders are deleted too, including ones already sent. Pause it instead to stop new ones.",
                          )
                        )
                          return
                        run(() => deleteReminderRule(rule.id))
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}
