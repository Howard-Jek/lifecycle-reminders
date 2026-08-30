"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Play, RotateCcw, Send, Trash2, Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { formatTimeOfDay } from "@/lib/format-time"
import {
  runTickNow,
  sendAsAgent,
  replyAsClient,
  clearSandbox,
  requeueAllReminders,
  type SandboxRow,
} from "@/app/actions/sandbox"

type Contact = { id: string; name: string; phone: string }

export function SandboxClient({
  messages,
  contacts,
  senderConfigured,
  dryRun,
  tableMissing,
  timezone,
}: {
  messages: SandboxRow[]
  contacts: Contact[]
  senderConfigured: boolean
  dryRun: boolean
  tableMissing: boolean
  /** The BUSINESS's timezone, not the viewer's — see lib/format-time.ts. */
  timezone: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [leadId, setLeadId] = useState(contacts[0]?.id ?? "")
  const [agentDraft, setAgentDraft] = useState("")
  const [clientDraft, setClientDraft] = useState("")

  const selected = contacts.find((c) => c.id === leadId) ?? null

  // Two handsets, one transcript. A message leaving the agent is arriving at
  // the client, so each pane derives its own left/right from the roles rather
  // than from a stored direction flag.
  const agentThread = messages.filter((m) => m.to_role === "agent" || m.from_role === "agent")
  const clientThread = messages.filter((m) => m.to_role === "client" || m.from_role === "client")

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
      router.refresh()
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">Sandbox</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            The engine is real — this button runs the same cycle the cron runs, drafts with the
            same model and builds the same template params. The one thing it will not do is call
            WhatsApp: deliveries here are simulated, so nothing reaches a handset and nothing is
            billed, however this deployment is configured.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            disabled={pending}
            onClick={() =>
              run(runTickNow, (data) => {
                const r = data as { planned: number; inserted: number; sent: number; skipped: number }
                return `Materialised ${r.inserted} new, simulated ${r.sent} deliveries, skipped ${r.skipped}. Nothing was sent to WhatsApp.`
              })
            }
          >
            <Play data-icon="inline-start" />
            {pending ? "Running…" : "Run a tick now"}
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(requeueAllReminders, (data) => `Requeued ${data as number} reminders.`)
            }
          >
            <RotateCcw data-icon="inline-start" />
            Replay
          </Button>
          <Button variant="ghost" disabled={pending} onClick={() => run(clearSandbox)}>
            <Trash2 data-icon="inline-start" />
            Clear
          </Button>
        </div>
      </div>

      {tableMissing && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          The sandbox table is not there yet. Apply{" "}
          <code className="font-mono text-xs">supabase/migrations/20260811020000_sandbox.sql</code>{" "}
          and reload.
        </p>
      )}
      {error && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}
      {notice && (
        <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {/* The dry-run flag governs the CRON, not this page. It used to be
            shown here as though it described the button beside it, which read
            as a warning about the sandbox when it was a warning about
            production — and the button was the more dangerous of the two. */}
        <StatusChip ok okLabel="Sandbox sends are simulated — nothing reaches Meta" badLabel="" />
        <StatusChip
          ok={dryRun}
          okLabel="Scheduled sending: dry run on"
          badLabel="Scheduled sending: live when a scheduler runs"
        />
        <StatusChip
          ok={senderConfigured}
          okLabel="WhatsApp credentials present"
          badLabel="No WhatsApp credentials — reminders resolve to 'skipped'"
        />
        {contacts.length > 0 && (
          <span className="text-muted-foreground">
            Acting as{" "}
            <select
              value={leadId}
              onChange={(e) => setLeadId(e.target.value)}
              className="ml-1 h-6 rounded-md border border-input bg-transparent px-1.5 text-xs outline-none focus-visible:border-ring"
            >
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </span>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Phone
          title="The agent's phone"
          subtitle="Receives the reminder from your platform number"
          accent="brand"
          empty="No reminders delivered yet. Import some contacts, add a rule, then run a tick."
          messages={agentThread}
          mineRole="agent"
          timezone={timezone}
          draft={agentDraft}
          onDraft={setAgentDraft}
          placeholder={
            selected ? `Forward to ${selected.name}…` : "Add a contact to send to a client"
          }
          disabled={pending || !leadId}
          onSend={() =>
            run(
              () => sendAsAgent({ leadId, body: agentDraft }),
              () => {
                setAgentDraft("")
                return null
              },
            )
          }
        />

        <Phone
          title="The client's phone"
          subtitle="Receives whatever the agent chooses to send"
          accent="whatsapp"
          empty="Nothing sent to this client yet."
          messages={clientThread}
          mineRole="client"
          timezone={timezone}
          draft={clientDraft}
          onDraft={setClientDraft}
          placeholder="Reply as the client…"
          disabled={pending || !leadId}
          onSend={() =>
            run(
              () => replyAsClient({ leadId, body: clientDraft }),
              () => {
                setClientDraft("")
                return null
              },
            )
          }
        />
      </div>
    </div>
  )
}

function StatusChip({
  ok,
  okLabel,
  badLabel,
}: {
  ok: boolean
  okLabel: string
  badLabel: string
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full px-2.5 font-medium",
        ok
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
    >
      {ok ? okLabel : badLabel}
    </span>
  )
}

function Phone({
  title,
  subtitle,
  accent,
  empty,
  messages,
  mineRole,
  timezone,
  draft,
  onDraft,
  placeholder,
  disabled,
  onSend,
}: {
  title: string
  subtitle: string
  accent: "brand" | "whatsapp"
  empty: string
  messages: SandboxRow[]
  mineRole: "agent" | "client"
  timezone: string
  draft: string
  onDraft: (v: string) => void
  placeholder: string
  disabled: boolean
  onSend: () => void
}) {
  return (
    <section className="flex flex-col overflow-hidden rounded-2xl border bg-card shadow-sm ring-1 ring-foreground/5">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
            accent === "brand"
              ? "bg-brand/15 text-brand-ink"
              : "bg-[#25d366]/15 text-[#128c5e] dark:text-[#25d366]",
          )}
          aria-hidden
        >
          {mineRole === "agent" ? "A" : "C"}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </header>

      {/* Fixed height so both panes stay aligned and neither can push the page
          taller than the viewport as a demo goes on.

          `data-allow-overlap` is about the audit, not the design. Once the
          transcript is longer than 26rem, the bubbles scrolled past the bottom
          still report their laid-out position through getBoundingClientRect —
          which puts them geometrically on top of the composer below, even
          though `overflow-y-auto` clips them and nothing overlaps on screen.
          Confirmed by measuring the container (416px tall, 2911px of content,
          overflow-y auto) and checking the rendered page at 1280. */}
      <div
        data-allow-overlap
        className="flex h-[26rem] flex-col gap-3 overflow-y-auto bg-muted/40 px-4 py-4"
      >
        {messages.length === 0 ? (
          <p className="m-auto max-w-[16rem] text-center text-sm text-muted-foreground">{empty}</p>
        ) : (
          messages.map((m) => (
            <Bubble key={m.id} message={m} mineRole={mineRole} timezone={timezone} />
          ))
        )}
      </div>

      <div className="flex items-end gap-2 border-t p-3">
        <textarea
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          placeholder={placeholder}
          rows={2}
          className="min-h-0 w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring"
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line — the WhatsApp habit.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              if (!disabled && draft.trim()) onSend()
            }
          }}
        />
        <Button size="icon" disabled={disabled || !draft.trim()} onClick={onSend} aria-label="Send">
          <Send />
        </Button>
      </div>
    </section>
  )
}

function Bubble({
  message,
  mineRole,
  timezone,
}: {
  message: SandboxRow
  mineRole: "agent" | "client"
  timezone: string
}) {
  const mine = message.from_role === mineRole
  const isTemplate = Boolean(message.template_name)

  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm",
          mine
            ? "rounded-br-sm bg-[#d9fdd3] text-neutral-900"
            : "rounded-bl-sm bg-background text-foreground ring-1 ring-foreground/10",
        )}
      >
        {isTemplate && (
          <div className="mb-1.5 flex items-center gap-1.5">
            <Badge variant="outline" className="border-foreground/20 text-[0.65rem]">
              template · {message.template_name}
            </Badge>
          </div>
        )}

        <p className="whitespace-pre-wrap wrap-anywhere leading-relaxed">{message.body}</p>

        {isTemplate && message.template_params && (
          // The five positional params, as Meta receives them — already clamped
          // and whitespace-collapsed. This is the thing worth eyeballing before
          // the template goes for review, so it is one click away rather than
          // buried in a log.
          <details className="mt-2">
            <summary className="flex cursor-pointer items-center gap-1 text-[0.7rem] text-neutral-600 select-none">
              <Info className="size-3" />
              What Meta actually receives
            </summary>
            <ol className="mt-1.5 space-y-1">
              {message.template_params.map((param, i) => (
                <li key={i} className="flex gap-1.5 text-[0.7rem] text-neutral-700">
                  <span className="shrink-0 font-mono opacity-60">{`{{${i + 1}}}`}</span>
                  <span className="wrap-anywhere">{param}</span>
                </li>
              ))}
            </ol>
          </details>
        )}

        <p
          className={cn(
            "mt-1 text-right text-[0.65rem] tabular-nums",
            mine ? "text-neutral-500" : "text-muted-foreground",
          )}
        >
          {formatTimeOfDay(message.created_at, timezone)}
        </p>
      </div>
    </div>
  )
}
