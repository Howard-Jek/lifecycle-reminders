"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CalendarPlus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { humaniseEventType } from "@/lib/lifecycle/labels"
import { daysBetween } from "@/lib/lifecycle/occurrence"
import { describeLeadTime } from "@/lib/notify/client-event-reminder"
import { formatYmd } from "@/lib/format-time"
import { cn } from "@/lib/utils"
import {
  addContactEvent,
  updateContactEvent,
  deleteContactEvent,
  assignContact,
  type EventInput,
} from "@/app/actions/contacts"
import type { KnownEventType } from "@/lib/lifecycle/event-types"

type EventRow = {
  id: string
  event_type: string
  label: string | null
  event_date: string
  recurrence: "none" | "yearly"
  source: string
  nextOn: string
}

/** Sentinel for the select. A real event_type can never be this: the action
 * normalises to [a-z0-9_], so no user value contains a space or a colon. */
const OTHER = "__other__"

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
  knownTypes,
}: {
  contactId: string
  assignedMemberId: string | null
  members: Array<{ id: string; display_name: string; active: boolean }>
  events: EventRow[]
  today: string
  knownTypes: KnownEventType[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [draft, setDraft] = useState<EventInput | null>(null)
  /** The row being edited, or null when adding. */
  const [editingId, setEditingId] = useState<string | null>(null)
  /** Held separately so switching to "Something else…" and back does not
   * destroy what was typed. */
  const [customType, setCustomType] = useState("")
  /** What the Type field held before "Something else…" was chosen.
   *
   * Backing out of the escape hatch used to reset the field to knownTypes[0],
   * which is whichever type this business uses MOST — normally `birthday`. So
   * opening a policy expiry, glancing at "Something else…", and clicking the ✕
   * relabelled the policy as a birthday, and because the type changed, saving
   * then binned the queued renewal reminders. Silent, plausible-looking, and
   * exactly the failure this product exists to prevent. */
  const [typeBeforeOther, setTypeBeforeOther] = useState("")
  /** The row awaiting a second click to confirm removal. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const resolvedType = draft?.event_type === OTHER ? customType.trim() : (draft?.event_type ?? "")
  /** Mirrors normalizeEventType() in the action, so the field can show what
   * will actually be stored before it is stored. */
  const normalisedCustom = customType
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  const editingEvent = editingId ? events.find((e) => e.id === editingId) : undefined

  function run(
    fn: () => Promise<{ ok: true; data?: unknown } | { ok: false; error: string }>,
    onOk?: (data: unknown) => string | null,
  ) {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const result = await fn()
      if (!result.ok) {
        setError(result.error)
        return
      }
      const message = onOk?.((result as { data?: unknown }).data)
      if (message) setNotice(message)
      setDraft(null)
      setEditingId(null)
      router.refresh()
    })
  }

  function startEdit(event: EventRow) {
    setError(null)
    setNotice(null)
    setConfirmingId(null)
    setCustomType("")
    setEditingId(event.id)
    setDraft({
      event_type: event.event_type,
      event_date: event.event_date,
      label: event.label ?? "",
      recurrence: event.recurrence,
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
            aria-label="Agent this contact is assigned to"
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
      {notice && (
        <p className="mb-4 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      )}

      {draft && (
        <div className="mb-6 rounded-lg border bg-background p-4">
          {/* Named, because the panel is detached from the row it belongs to.
              With two dates on a contact and an Edit button on each, an
              untitled form floating above the list gave no way to tell which
              one you had opened — and both rows kept live Edit and Remove
              buttons, so the answer could change under you. */}
          <p className="mb-4 text-sm font-medium">
            {editingEvent
              ? `Editing ${editingEvent.label || humaniseEventType(editingEvent.event_type)}`
              : "New date"}
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1">
            <label htmlFor={draft.event_type === OTHER ? "event-type-custom" : "event-type"} className="text-sm font-medium">
              Type
            </label>
            {/* A list, not an enum. The schema keeps event_type as free text —
                the engine is vertical-agnostic and a warranty or a visa renewal
                has to be a row, not a migration. But events and rules join by
                EXACT string equality, so a typo produces no error and no
                reminder, only silence. Choosing from what already works fixes
                that at the point of entry; "Something else" keeps the door
                open, and makes creating a type a deliberate act. */}
            {draft.event_type === OTHER ? (
              <div className="flex gap-1">
                <Input
                  autoFocus
                  id="event-type-custom"
                  value={customType}
                  onChange={(e) => setCustomType(e.target.value)}
                  placeholder="warranty_expiry"
                  aria-describedby="event-type-hint"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Back to the list of types"
                  onClick={() => {
                    setCustomType("")
                    setDraft({ ...draft, event_type: typeBeforeOther })
                  }}
                >
                  <X />
                </Button>
              </div>
            ) : (
              <select
                id="event-type"
                value={draft.event_type}
                onChange={(e) => {
                  if (e.target.value === OTHER) setTypeBeforeOther(draft.event_type)
                  setDraft({ ...draft, event_type: e.target.value })
                }}
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring"
              >
                {/* A REAL option for the empty state, not an absent one.
                    Without it a new draft's "" matched no option, so the
                    browser fell back to painting option 0 — the field read
                    "Birthday" while the value behind it was still empty, and
                    Save sat disabled with the form looking completely filled
                    in. Nothing on screen could explain it. */}
                {draft.event_type === "" && (
                  <option value="" disabled>
                    Choose a type…
                  </option>
                )}
                {knownTypes.length === 0 && draft.event_type !== "" && (
                  <option value="">No types yet</option>
                )}
                {knownTypes.map((t) => (
                  <option key={t.value} value={t.value}>
                    {humaniseEventType(t.value)}
                    {t.hasRule ? "" : " — no rule, will not fire"}
                  </option>
                ))}
                <option value={OTHER}>Something else…</option>
              </select>
            )}
            {/* The dropdown annotates a ruleless type with "will not fire".
                A type invented here has no rule BY DEFINITION, so without this
                the escape hatch is the one path that silently produces the
                dead-end the dropdown exists to warn about. The slug is shown
                because the action normalises the input — "Warranty Expiry" is
                stored as warranty_expiry — and an operator who cannot see that
                cannot match it in Settings. */}
            {draft.event_type === OTHER && (
              <p id="event-type-hint" className="text-xs text-muted-foreground">
                {normalisedCustom ? (
                  <>
                    Saved as <code className="font-mono">{normalisedCustom}</code>. Add a matching
                    rule in Settings or it will never send.
                  </>
                ) : (
                  <>A new type needs a matching rule in Settings before it sends anything.</>
                )}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="event-date" className="text-sm font-medium">
              Date
            </label>
            <Input
              id="event-date"
              type="date"
              value={draft.event_date}
              onChange={(e) => setDraft({ ...draft, event_date: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="event-label" className="text-sm font-medium">
              Label
            </label>
            <Input
              id="event-label"
              value={draft.label ?? ""}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              placeholder="AIA HealthShield"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="event-recurrence" className="text-sm font-medium">
              Repeats
            </label>
            <select
              id="event-recurrence"
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
            <Button
              disabled={pending || !resolvedType || !draft.event_date}
              onClick={() => {
                const payload = { ...draft, event_type: resolvedType }
                run(
                  () =>
                    editingId
                      ? updateContactEvent(contactId, editingId, payload)
                      : addContactEvent(contactId, payload),
                  (data) => {
                    const cleared = (data as { remindersCleared?: number } | undefined)
                      ?.remindersCleared
                    // Said out loud, because it is surprising: moving a date
                    // silently discards the reminders already scheduled against
                    // the old one.
                    //
                    // "cleared … will be rescheduled", not "rebuilt": the
                    // rebuild happens on the next engine run, not in this
                    // request. An operator who read "rebuilt" and went straight
                    // to the inbox would find nothing there and reasonably
                    // conclude the save had eaten it.
                    return cleared
                      ? `Saved. ${cleared} scheduled ${cleared === 1 ? "reminder was" : "reminders were"} cleared, and will be rescheduled for the new date shortly.`
                      : null
                  },
                )
              }}
            >
              {pending ? "Saving…" : editingId ? "Save changes" : "Save date"}
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setDraft(null)
                setEditingId(null)
                setCustomType("")
              }}
            >
              Cancel
            </Button>
            {/* A disabled button with no stated reason is a dead end. Both
                fields are required by the action, so say which one is missing
                rather than letting the operator hunt for it. */}
            {!pending && (!resolvedType || !draft.event_date) && (
              <span className="text-xs text-muted-foreground">
                {!resolvedType && !draft.event_date
                  ? "Pick a type and a date."
                  : !resolvedType
                    ? "Pick a type."
                    : "Pick a date."}
              </span>
            )}
          </div>
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
            <li
              key={event.id}
              className={cn(
                "flex flex-wrap items-center gap-3 px-2 py-3 transition-colors",
                // The row under edit is marked, so the panel above is anchored
                // to something rather than floating free.
                editingId === event.id && "-mx-2 rounded-lg bg-muted",
              )}
            >
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
                {/* Human format, not the raw column. The form beside this
                    renders 11/09/2026 in the native date input and the import
                    panel below shows the same, so leaving 2026-09-11 here put
                    three renderings and two formats on one card — one of them
                    ambiguous between 11 Sep and 9 Nov. */}
                <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                  {formatYmd(event.event_date)}
                  {event.nextOn !== event.event_date && (
                    <>
                      {" "}
                      · next on {formatYmd(event.nextOn)} (
                      {describeLeadTime(daysBetween(today, event.nextOn))})
                    </>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {confirmingId === event.id ? (
                  // Two steps, in place. Removing a date cascades its
                  // reminders, and it was one unguarded click with no undo and
                  // no toast system to offer one. An inline swap needs no
                  // dialog primitive and keeps the destructive verb off the
                  // resting state.
                  <>
                    <span className="text-xs text-muted-foreground">Remove this date?</span>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={pending}
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => {
                        setConfirmingId(null)
                        run(() => deleteContactEvent(contactId, event.id))
                      }}
                    >
                      Remove
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={pending}
                      onClick={() => setConfirmingId(null)}
                    >
                      Keep
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      size="xs"
                      // Disabled while another row is open: switching rows
                      // mid-edit used to swap the panel's contents in place and
                      // discard whatever had been typed, with no warning.
                      disabled={pending || (editingId !== null && editingId !== event.id)}
                      onClick={() => startEdit(event)}
                    >
                      {editingId === event.id ? "Editing" : "Edit"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={pending || editingId !== null}
                      onClick={() => setConfirmingId(event.id)}
                    >
                      Remove
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
