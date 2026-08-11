"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Input } from "@/components/ui/input"

/**
 * Search, debounced into the URL.
 *
 * The URL is the source of truth, so a shared link reproduces the same view
 * and paging cannot disagree with the filter.
 */
export function ContactSearch({ initial }: { initial: string }) {
  const router = useRouter()
  const [value, setValue] = useState(initial)

  useEffect(() => {
    if (value === initial) return
    const timer = setTimeout(() => {
      const search = new URLSearchParams()
      if (value.trim()) search.set("q", value.trim())
      router.push(`/contacts${search.size ? `?${search}` : ""}`)
    }, 300)
    return () => clearTimeout(timer)
  }, [value, initial, router])

  return (
    <Input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder="Search name, phone or email…"
      className="sm:max-w-xs"
    />
  )
}
