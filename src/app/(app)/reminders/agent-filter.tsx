"use client"

import { useRouter } from "next/navigation"

/**
 * Which agent's reminders the inbox is showing.
 *
 * A select rather than the chip row the Dates filter uses, because this one
 * does not have a fixed three options — a book with twenty agents would wrap
 * the filter row past the list it filters. Same row and same label grammar, so
 * it still reads as one bank of filters.
 *
 * The hrefs are built by the page, not here. Every link on that page carries
 * the scope you are already in, and a second URL builder in a client component
 * is how one of those dimensions gets silently dropped on navigate.
 */
export function AgentFilter({
  options,
  value,
}: {
  /** value → where selecting it goes. Order is the order rendered. */
  options: Array<{ value: string; label: string; href: string }>
  value: string
}) {
  const router = useRouter()

  return (
    <div className="flex items-center gap-1">
      <label className="px-1 text-xs text-muted-foreground" htmlFor="agent-filter">
        Agent
      </label>
      <select
        id="agent-filter"
        value={value}
        onChange={(e) => {
          const next = options.find((o) => o.value === e.target.value)
          if (next) router.push(next.href)
        }}
        className="h-7 rounded-lg bg-background px-2 text-sm font-medium text-foreground ring-1 ring-foreground/10 hover:bg-muted"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}
