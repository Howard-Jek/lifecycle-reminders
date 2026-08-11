"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CalendarPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { humaniseEventType } from "@/lib/lifecycle/labels"
import { daysBetween } from "@/lib/lifecycle/occurrence"
import { describeLeadTime } from "@/lib/notify/client-event-reminder"
import {
  addContactEvent,
  deleteContactEvent,
  assignContact,
  type EventInput,
} from "@/app/actions/contacts"

type EventRow = {
  id: string
  event_type: string
  label: string | null
  event_date: string
  recurrence: "none" | "yearly"
  source: string
  nextOn: string
}

const BLANK: EventInput = {
  event_type: "",
  event_date: "",
  label: "",
  recurrence: "yearly",
}

export function EventsClient({
  contactId,
  assignedMemberId,
  members,
  events,
  today,
}: {
  contactId: string
  assignedMemberId: string | null
  members: Array<{ id: string; display_name: string; active: boolean }>
  events: EventRow[]
  today: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<EventInput | null>(null)

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null)
    startTransition(async () => {
      const result = await fn()
      if (!result.ok) {
        setError(result.error)
        return
      }
      setDraft(null)
      router.refresh()
    })
  }

  return (
    <section className="rounded-xl border bg-card p-6 shadow-sm ring-1 ring-foreground/5">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Dates</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Birthdays and anniversaries recur; one-off dates fire once.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={assignedMemberId ?? ""}
            disabled={pending}
            onChange={(e) => run(() => assignContact(contactId, e.target.value || null))}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring"
          >
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.active}>
                {m.display_name}
                {m.active ? "" : " (inactive)"}
              </option>
            ))}
          </select>
          {!draft && (
            <Button onClick={() => setDraft({ ...BLANK })}>
              <CalendarPlus data-icon="inline-start" />
              Add date
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {draft && (
        <div className="mb-6 grid gap-4 rounded-lg border bg-background p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Type</label>
            <Input
              value={draft.event_type}
              onChange={(e) => setDraft({ ...draft, event_type: e.target.value })}
              placeholder="policy_expiry"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Date</label>
            <Input
              type="date"
              value={draft.event_date}
              onChange={(e) => setDraft({ ...draft, event_date: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Label</label>
            <Input
              value={draft.label ?? ""}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              placeholder="AIA HealthShield"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Repeats</label>
            <select
              value={draft.recurrence}
              onChange={(e) =>
                setDraft({ ...draft, recurrence: e.target.value as "none" | "yearly" })
              }
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring"
            >
              <option value="yearly">Every year</option>
              <option value="none">Once</option>
            </select>
          </div>
          <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-4">
            <Button disabled={pending} onClick={() => run(() => addContactEvent(contactId, draft))}>
              {pending ? "Saving…" : "Save date"}
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {events.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No dates recorded yet.
        </p>
      ) : (
        <ul className="divide-y">
          {events.map((event) => (
            <li key={event.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {event.label || humaniseEventType(event.event_type)}
                  {event.recurrence === "yearly" && (
                    <Badge variant="ghost" className="text-muted-foreground">
                      yearly
                    </Badge>
                  )}
                  {event.source === "manual" && (
                    <Badge variant="outline" className="text-muted-foreground">
                      added by hand
                    </Badge>
                  )}
                </p>
                <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                  {event.event_date}
                  {event.nextOn !== event.event_date && (
                    <> · next on {event.nextOn} ({describeLeadTime(daysBetween(today, event.nextOn))})</>
                  )}
                </p>
              </div>
              <Button
                variant="ghost"
                size="xs"
                disabled={pending}
                onClick={() => run(() => deleteContactEvent(contactId, event.id))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
