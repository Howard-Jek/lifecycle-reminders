"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { saveBusinessProfile, type BusinessProfile } from "@/app/actions/business"

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
