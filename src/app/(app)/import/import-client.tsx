"use client"

import { useRef, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  previewSheet,
  commitImport,
  type SheetPreview,
  type EventColumnChoice,
} from "@/app/actions/imports"

/**
 * The import wizard.
 *
 * Four steps, all deterministic: choose a file, confirm the column mapping,
 * resolve any ambiguous date format, then commit. Nothing is written until the
 * last step, and the operator has seen the interpretation before it happens.
 */
export function ImportClient({ defaultCountry }: { defaultCountry: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<SheetPreview | null>(null)
  const [done, setDone] = useState<{
    created: number
    updated: number
    events: number
    review: number
    dueContacts: number
  } | null>(null)

  const [nameColumn, setNameColumn] = useState("")
  const [phoneColumn, setPhoneColumn] = useState("")
  const [emailColumn, setEmailColumn] = useState("")
  const [agentColumn, setAgentColumn] = useState("")
  const [countryCode, setCountryCode] = useState(defaultCountry)
  const [eventColumns, setEventColumns] = useState<EventColumnChoice[]>([])

  const unresolved = eventColumns.filter((c) => c.ambiguous && !c.date_format)

  function onFile(formData: FormData) {
    setError(null)
    setDone(null)
    startTransition(async () => {
      const result = await previewSheet(formData)
      if (!result.ok) {
        setError(result.error)
        return
      }
      const data = result.data
      setPreview(data)
      setNameColumn(data.guess.name ?? "")
      setPhoneColumn(data.guess.phone ?? "")
      setEmailColumn(data.guess.email ?? "")
      setAgentColumn(data.guess.agent ?? "")
      setEventColumns(data.eventColumns)
    })
  }

  if (done) {
    return (
      <div className="rounded-xl border bg-card p-8 text-center shadow-sm ring-1 ring-foreground/5">
        <div className="mx-auto w-fit rounded-full bg-emerald-500/10 p-3">
          <CheckCircle2 className="size-6 text-emerald-600 dark:text-emerald-400" strokeWidth={1.75} />
        </div>
        <h2 className="mt-4 text-base font-semibold">Import complete</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="tabular-nums">{done.created}</span> new,{" "}
          <span className="tabular-nums">{done.updated}</span> updated,{" "}
          <span className="tabular-nums">{done.events}</span> dates recorded.
        </p>
        {done.dueContacts > 0 && (
          // Said plainly and BEFORE the review notice: this is the only outcome
          // of an import that causes messages to leave the building, and an
          // operator who uploads a book of clients should not discover it by
          // watching their team's phones light up fifteen minutes later.
          <p className="mx-auto mt-4 max-w-md rounded-lg bg-blue-500/10 px-3 py-2 text-sm text-blue-700 dark:text-blue-400">
            <span className="tabular-nums">{done.dueContacts}</span>{" "}
            {done.dueContacts === 1 ? "contact has a date" : "contacts have dates"}{" "}
            already inside the lead time — their reminders go out on the next run. Pause a rule in
            Settings first if you would rather they didn&apos;t.
          </p>
        )}

        {done.review > 0 && (
          <p className="mx-auto mt-4 max-w-md rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            <span className="tabular-nums">{done.review}</span>{" "}
            {done.review === 1 ? "row needs" : "rows need"} a decision — an agent name that matched
            nothing, or a date that could not be read. Nothing was guessed.
          </p>
        )}
        <div className="mt-6 flex justify-center gap-2">
          {done.review > 0 && (
            <Link
              href="/import/review"
              className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Review {done.review} {done.review === 1 ? "row" : "rows"}
            </Link>
          )}
          <Button
            variant="outline"
            onClick={() => {
              setDone(null)
              setPreview(null)
              router.refresh()
            }}
          >
            Import another file
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      {!preview ? (
        <form action={onFile}>
          <FileDropzone pending={pending} />
        </form>
      ) : (
        <>
          <section className="rounded-xl border bg-card p-6 shadow-sm ring-1 ring-foreground/5">
            <h2 className="text-base font-semibold">Map the columns</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {preview.rowCount.toLocaleString()} rows.{" "}
              {preview.truncated && "Only the first 20,000 will be imported. "}
              We have guessed — check before committing.
            </p>

            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <ColumnPicker
                label="Name"
                required
                headers={preview.headers}
                value={nameColumn}
                onChange={setNameColumn}
              />
              <ColumnPicker
                label="Phone"
                required
                headers={preview.headers}
                value={phoneColumn}
                onChange={setPhoneColumn}
              />
              <ColumnPicker
                label="Email"
                headers={preview.headers}
                value={emailColumn}
                onChange={setEmailColumn}
              />
              <ColumnPicker
                label="Agent"
                hint="Matched exactly, never guessed"
                headers={preview.headers}
                value={agentColumn}
                onChange={setAgentColumn}
              />
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">Country code</label>
                <Input value={countryCode} onChange={(e) => setCountryCode(e.target.value)} />
                <p className="text-xs text-muted-foreground">Completes local numbers.</p>
              </div>
            </div>
          </section>

          <section className="rounded-xl border bg-card p-6 shadow-sm ring-1 ring-foreground/5">
            <h2 className="text-base font-semibold">Dates</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Each of these becomes an event type your reminder rules can match.
            </p>

            {eventColumns.length === 0 ? (
              <p className="mt-4 rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                No date columns detected. Add them by hand on a contact afterwards, or rename the
                column to something like &ldquo;Policy expiry&rdquo; and re-read the file.
              </p>
            ) : (
              <div className="mt-5 space-y-4">
                {eventColumns.map((column, index) => (
                  <div
                    key={column.header}
                    className="grid gap-4 rounded-lg border bg-background p-4 sm:grid-cols-2 lg:grid-cols-4"
                  >
                    <div className="flex flex-col gap-1">
                      <label className="text-sm font-medium">Column</label>
                      <p className="flex h-8 items-center truncate text-sm text-muted-foreground">
                        {column.header}
                      </p>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-sm font-medium">Event type</label>
                      <Input
                        value={column.event_type}
                        onChange={(e) =>
                          setEventColumns((prev) =>
                            prev.map((c, i) =>
                              i === index ? { ...c, event_type: e.target.value } : c,
                            ),
                          )
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-sm font-medium">Repeats</label>
                      <select
                        value={column.recurrence}
                        onChange={(e) =>
                          setEventColumns((prev) =>
                            prev.map((c, i) =>
                              i === index
                                ? { ...c, recurrence: e.target.value as "none" | "yearly" }
                                : c,
                            ),
                          )
                        }
                        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring"
                      >
                        <option value="yearly">Every year</option>
                        <option value="none">Once</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-sm font-medium">Date format</label>
                      <select
                        value={column.date_format ?? ""}
                        onChange={(e) =>
                          setEventColumns((prev) =>
                            prev.map((c, i) =>
                              i === index ? { ...c, date_format: e.target.value || null } : c,
                            ),
                          )
                        }
                        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring"
                      >
                        <option value="">Detect automatically</option>
                        <option value="DD/MM/YYYY">Day first (31/12/2026)</option>
                        <option value="MM/DD/YYYY">Month first (12/31/2026)</option>
                        <option value="YYYY-MM-DD">ISO (2026-12-31)</option>
                      </select>
                      {column.ambiguous && !column.date_format && (
                        <p className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
                          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                          Every date in this column is under the 13th, so day-first and month-first
                          both parse. Pick one — guessing would move real dates.
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border bg-card p-6 shadow-sm ring-1 ring-foreground/5">
            <h2 className="text-base font-semibold">First five rows</h2>
            <div className="mt-4 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {preview.headers.map((header) => (
                      <TableHead key={header}>{header}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.sample.map((row, i) => (
                    <TableRow key={i}>
                      {preview.headers.map((header) => (
                        <TableCell key={header} className="max-w-[16rem] truncate">
                          {row[header]}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={pending || !nameColumn || !phoneColumn || unresolved.length > 0}
              onClick={() => {
                setError(null)
                startTransition(async () => {
                  const result = await commitImport({
                    stashKey: preview.stashKey,
                    nameColumn,
                    phoneColumn,
                    emailColumn: emailColumn || null,
                    agentColumn: agentColumn || null,
                    countryCode,
                    eventColumns,
                  })
                  if (!result.ok) {
                    setError(result.error)
                    return
                  }
                  setDone(result.data)
                  router.refresh()
                })
              }}
            >
              {pending ? "Importing…" : `Import ${preview.rowCount.toLocaleString()} rows`}
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => setPreview(null)}>
              Choose a different file
            </Button>
            {unresolved.length > 0 && (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                Pick a date format for {unresolved.map((c) => c.header).join(", ")} first.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** Bytes as the operator would say them. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/** Kept beside the input's `accept`, which only ever filters the picker dialog
 * — a dropped file is subject to no filter at all. */
const ACCEPTED_EXTENSIONS = [".csv", ".xlsx", ".xlsm", ".txt"]

/**
 * Choose a spreadsheet.
 *
 * The input is transparent and stretched over the message rather than hidden,
 * so the input ITSELF is the click and tap target across the whole zone —
 * rather than a 1×1px box that only works because a label happens to wrap it.
 * The ring is drawn on the label through `focus-within`, so a keyboard user
 * sees the same affordance a mouse user does.
 *
 * The submit button sits outside that label deliberately: inside it, one click
 * would both submit the form and re-open the file picker, because the click
 * bubbles to the label.
 */
function FileDropzone({ pending }: { pending: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [chosen, setChosen] = useState<{ name: string; size: number } | null>(null)
  const [rejected, setRejected] = useState<string | null>(null)

  /** @returns whether the file was accepted. */
  function take(files: FileList | null): boolean {
    const file = files?.[0]
    if (!file) {
      setChosen(null)
      setRejected(null)
      return false
    }

    const name = file.name.toLowerCase()
    if (!ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      // Said here rather than after the upload: the server rejects it too, but
      // only once the whole file has crossed the wire.
      setChosen(null)
      setRejected(`${file.name} is not a spreadsheet. Use ${ACCEPTED_EXTENSIONS.join(", ")}.`)
      return false
    }

    setRejected(null)
    setChosen({ name: file.name, size: file.size })
    return true
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        // Moving between the input, the label and the button all fire
        // dragleave on this element; without the containment check the
        // highlight flickers the whole way across the zone.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        // Assigning to `.files` is what makes a dropped file part of the form
        // submission — the server action reads FormData, not this component's
        // state, so the input has to actually hold the file.
        if (inputRef.current && e.dataTransfer.files.length > 0) {
          // Only adopt it if it passes — otherwise the input would be holding a
          // file the UI says it rejected, and the form would submit it.
          if (take(e.dataTransfer.files)) inputRef.current.files = e.dataTransfer.files
          else inputRef.current.value = ""
        }
      }}
      className={cn(
        "flex flex-col items-center rounded-xl border border-dashed bg-card p-10 text-center shadow-sm transition-colors",
        dragging ? "border-brand bg-brand/5" : "hover:bg-muted/40",
      )}
    >
      {/* The label covers the message but NOT the button below it. With the
          button inside, one click would both submit the form and re-open the
          file picker, because the click bubbles to the label. */}
      {/* The ring is on the label, not the outer card: the card also contains
          the submit button, and lighting the whole drop zone when focus is on
          "Read file" says the file field is focused when it isn't. */}
      <label className="relative flex w-full cursor-pointer flex-col items-center rounded-lg focus-within:ring-3 focus-within:ring-ring/50">
        <input
          ref={inputRef}
          type="file"
          name="file"
          accept=".csv,.xlsx,.xlsm,.txt"
          required
          onChange={(e) => {
            if (!take(e.target.files)) e.target.value = ""
          }}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />

        <span
          className={cn(
            "rounded-full p-3 transition-colors",
            chosen ? "bg-emerald-500/10" : "bg-muted",
          )}
        >
          {chosen ? (
            <FileSpreadsheet
              className="size-5 text-emerald-600 dark:text-emerald-400"
              strokeWidth={1.75}
            />
          ) : (
            <Upload className="size-5 text-muted-foreground" strokeWidth={1.75} />
          )}
        </span>

        {chosen ? (
          <>
            <span className="mt-4 text-base font-semibold wrap-anywhere">{chosen.name}</span>
            <span className="mt-1 text-sm tabular-nums text-muted-foreground">
              {formatSize(chosen.size)} · choose a different file
            </span>
          </>
        ) : (
          <>
            <span className="mt-4 text-base font-semibold">
              Drop a spreadsheet here, or click to choose
            </span>
            <span className="mt-1 max-w-md text-sm text-muted-foreground">
              .csv or .xlsx, up to 10 MB and 20,000 rows. Nothing is written until you confirm how
              the columns map.
            </span>
          </>
        )}
      </label>

      {rejected && (
        <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {rejected}
        </p>
      )}

      {/* Not disabled when no file is chosen. `Button` carries
          `disabled:pointer-events-none`, so a disabled submit swallows the
          click and says nothing at all — worse than the plain input this
          replaced, where the browser's own `required` validation spoke up.
          Left enabled, that validation still fires and points at the field. */}
      <Button type="submit" className="mt-5" disabled={pending}>
        {pending ? "Reading…" : chosen ? "Read file" : "Choose a file first"}
      </Button>
    </div>
  )
}

function ColumnPicker({
  label,
  hint,
  required,
  headers,
  value,
  onChange,
}: {
  label: string
  hint?: string
  required?: boolean
  headers: string[]
  value: string
  onChange: (next: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium">
        {label}
        {required && <span className="ml-1 text-brand">*</span>}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring"
      >
        <option value="">{required ? "Choose a column…" : "Not in this file"}</option>
        {headers.map((header) => (
          <option key={header} value={header}>
            {header}
          </option>
        ))}
      </select>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
