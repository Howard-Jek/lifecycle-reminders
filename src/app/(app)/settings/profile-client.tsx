"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { saveBusinessProfile, type BusinessProfile } from "@/app/actions/business"
import { INDUSTRY_OPTIONS, isVertical } from "@/lib/lifecycle/verticals"

export function ProfileClient({ profile }: { profile: BusinessProfile }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [value, setValue] = useState(profile)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  return (
    <section className="rounded-xl border bg-card p-6 shadow-sm ring-1 ring-foreground/5">
      <div className="mb-6">
        <h2 className="text-base font-semibold">Business</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The timezone is load-bearing: a morning reminder means 9am here, not on the server.
          The industry decides which reminder rules and wording you start with.
        </p>
      </div>

      {error && (
        <p className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {saved && (
        <p className="mb-4 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          Saved.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium">Business name</label>
          <Input
            value={value.business_name}
            onChange={(e) => setValue({ ...value, business_name: e.target.value })}
            placeholder="Acme Financial"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium">Country</label>
          <Input
            value={value.country_code}
            onChange={(e) => setValue({ ...value, country_code: e.target.value })}
            placeholder="SG"
          />
          <p className="text-xs text-muted-foreground">
            Completes local phone numbers on import.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium">Timezone</label>
          <Input
            value={value.timezone}
            onChange={(e) => setValue({ ...value, timezone: e.target.value })}
            placeholder="Asia/Singapore"
          />
          <p className="text-xs text-muted-foreground">An IANA name, e.g. Asia/Singapore.</p>
        </div>
        <div className="flex flex-col gap-1 sm:col-span-3">
          <label className="text-sm font-medium" htmlFor="vertical">
            Industry
          </label>
          {/* A native select, matching the Input controls beside it. The empty
              option is a real choice — "not chosen yet" is a state the column
              models with NULL, and hiding it would make the first industry in
              the list look like an answer nobody gave. */}
          <select
            id="vertical"
            className="border-input bg-background focus-visible:ring-ring h-9 rounded-md border px-3 py-1 text-sm shadow-xs focus-visible:ring-1 focus-visible:outline-none"
            value={value.vertical ?? ""}
            onChange={(e) =>
              setValue({ ...value, vertical: isVertical(e.target.value) ? e.target.value : null })
            }
          >
            <option value="">Not set</option>
            {INDUSTRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Pick the closest match. It changes the starting rules and the wording, never your
            existing dates or rules.
          </p>
        </div>
      </div>

      <Button
        className="mt-4"
        disabled={pending}
        onClick={() => {
          setError(null)
          setSaved(false)
          startTransition(async () => {
            const result = await saveBusinessProfile(value)
            if (result.ok) {
              setSaved(true)
              router.refresh()
            } else setError(result.error)
          })
        }}
      >
        {pending ? "Saving…" : "Save"}
      </Button>
    </section>
  )
}
