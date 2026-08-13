"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Plus, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { RowActions } from "@/components/row-actions"
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
              {/* Below `sm` every column but the event name folds into a line
                  under it. This card has `p-6`, so a phone leaves under 300px
                  for the table — enough for one column of prose and the actions
                  menu, and not enough for four. */}
              <TableHead className="w-[85%] sm:w-[32%]">Event</TableHead>
              <TableHead className="hidden sm:table-cell sm:w-[16%]">Lead time</TableHead>
              <TableHead className="hidden sm:table-cell sm:w-[18%]">Window</TableHead>
              <TableHead className="hidden sm:table-cell sm:w-[22%]">Audience</TableHead>
              <TableHead className="w-[10%] text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
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
                  {/* `whitespace-normal` because the shared TableCell sets
                      `whitespace-nowrap` on every cell. Without it this line
                      cannot wrap, so it sets the table's min-content width and
                      pushes the actions menu outside the card's scroll
                      container — visible only if you think to swipe the table
                      sideways, which nobody does. */}
                  <span className="mt-0.5 block text-xs font-normal whitespace-normal text-muted-foreground sm:hidden">
                    <span className="tabular-nums">
                      {rule.offset_days === 0 ? "On the day" : `${rule.offset_days} days before`}
                    </span>{" "}
                    · {SEND_WINDOW_LABEL[rule.send_window as SendWindow]} ·{" "}
                    {rule.audience === "all_members" ? "Whole team" : "Assigned agent"}
                  </span>
                </TableCell>
                <TableCell className="hidden tabular-nums sm:table-cell">
                  {rule.offset_days === 0 ? "On the day" : `${rule.offset_days} days before`}
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {SEND_WINDOW_LABEL[rule.send_window as SendWindow]}
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {rule.audience === "all_members" ? "Whole team" : "Assigned agent"}
                </TableCell>
                <TableCell className="text-right">
                  <RowActions
                    label={`Actions for the ${humaniseEventType(rule.event_type)} rule`}
                    actions={[
                      {
                        label: "Edit rule",
                        disabled: pending,
                        onSelect: () => {
                          setEditingId(rule.id)
                          setDraft({
                            event_type: rule.event_type,
                            offset_days: rule.offset_days,
                            audience: rule.audience as RuleInput["audience"],
                            suggest_message: rule.suggest_message,
                            send_window: rule.send_window as SendWindow,
                            active: rule.active,
                          })
                        },
                      },
                      {
                        label: rule.active ? "Pause rule" : "Resume rule",
                        disabled: pending,
                        onSelect: () =>
                          run(() =>
                            updateReminderRule(rule.id, {
                              event_type: rule.event_type,
                              offset_days: rule.offset_days,
                              audience: rule.audience as RuleInput["audience"],
                              suggest_message: rule.suggest_message,
                              send_window: rule.send_window as SendWindow,
                              active: !rule.active,
                            }),
                          ),
                      },
                      {
                        label: "Delete rule",
                        disabled: pending,
                        destructive: true,
                        onSelect: () => {
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
                        },
                      },
                    ]}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}
