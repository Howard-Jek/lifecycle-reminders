import { describe, it, expect } from "vitest"
import { createClient } from "@supabase/supabase-js"
import { MAX_ATTEMPTS } from "@/lib/lifecycle/retry-policy"
import { ATTENTION_FILTER } from "@/lib/lifecycle/inbox-filters"

/**
 * The reminder queue is addressed through PostgREST filter STRINGS, and a
 * malformed one does not throw — it changes which rows come back. `.or()` in
 * particular is hand-written syntax with its own nesting and comma rules, so a
 * typo there silently redefines a tab.
 *
 * These build the real queries and read the URL the client would have
 * requested. No network, no database: the assertion is that the filter we think
 * we wrote is the filter that goes on the wire.
 */

const client = createClient("https://example.supabase.co", "anon-key")
const urlOf = (q: unknown) => decodeURIComponent(String((q as { url: URL }).url))

/** Deliberately carries the dots and colons that make a timestamp risky inside
 * a `.or()` — PostgREST splits `column.op.value` on the first two dots only. */
const NOW = new Date("2026-09-01T02:00:00.000Z").toISOString()

describe("the delivery query", () => {
  const url = urlOf(
    client
      .from("reminders")
      .select("id, attempts, contact_events(event_type)")
      .eq("status", "queued")
      .lte("due_at", NOW)
      .lt("attempts", MAX_ATTEMPTS)
      .or(`next_attempt_at.is.null,next_attempt_at.lte.${NOW}`),
  )

  it("honours a scheduled wait without stranding rows that never had one", () => {
    // The is.null branch is what keeps every pre-existing row, and every first
    // attempt, eligible. Drop it and the whole queue stops being selected.
    expect(url).toContain("or=(next_attempt_at.is.null,next_attempt_at.lte.2026-09-01T02:00:00.000Z)")
  })

  it("carries the timestamp through the or() intact", () => {
    // PostgREST splits on the first two dots, so the fractional seconds and the
    // colons have to survive. If this ever truncates, the filter silently
    // becomes a comparison against a different instant.
    expect(url).toContain("2026-09-01T02:00:00.000Z")
    expect(url).not.toContain("lte.2026-09-01T02:00:00,")
  })

  it("caps attempts at the derived maximum", () => {
    expect(url).toContain(`attempts=lt.${MAX_ATTEMPTS}`)
    expect(url).toContain("attempts=lt.4")
  })

  it("embeds the event type without an inner join", () => {
    // `!inner` here would stop selecting reminders whose event was deleted, and
    // those are exactly the rows deliverOne needs in order to mark them skipped.
    expect(url).toContain("contact_events(event_type)")
    expect(url).not.toContain("contact_events!inner")
  })
})

describe("the inbox tabs", () => {
  it("Due shows only work nobody has tried yet", () => {
    const url = urlOf(
      client.from("reminders").select("id").eq("status", "queued").lte("due_at", NOW).eq("attempts", 0),
    )
    expect(url).toContain("attempts=eq.0")
  })

  it("Needs attention covers failed, skipped AND mid-retry rows", () => {
    const url = urlOf(client.from("reminders").select("id").or(ATTENTION_FILTER))
    expect(url).toContain("or=(status.in.(failed,skipped),and(status.eq.queued,attempts.gt.0))")
  })

  it("keeps Due and Needs attention disjoint", () => {
    // A queued row belongs to exactly one of them: attempts=0 or attempts>0.
    // Overlapping would double-count it in two badges and read as duplicated work.
    const due = urlOf(
      client.from("reminders").select("id").eq("status", "queued").eq("attempts", 0),
    )
    expect(due).toContain("attempts=eq.0")
    expect(ATTENTION_FILTER).toContain("attempts.gt.0")
  })
})
