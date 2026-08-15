import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * With no WhatsApp sender configured, a cycle must leave the queue ALONE.
 *
 * The engine used to resolve every due reminder to a terminal `skipped`,
 * reasoning that "not configured" is permanent for this deployment. It is not:
 * the credentials are missing because nobody has set them yet — it is step 4 of
 * the setup checklist — and marking the queue terminal destroys real work in
 * order to record a fact the deployment already knows about itself.
 *
 * It only became urgent when the cycle started running every 15 minutes to
 * serve the afternoon and evening send windows. At one run a day the damage was
 * one day's reminders; at four runs an hour it is the whole backlog before
 * lunch, leaving nothing to deliver once the credentials finally arrive.
 */

const SENDER_VARS = [
  "GOMA_NOTIFY_PHONE_NUMBER_ID",
  "GOMA_NOTIFY_ACCESS_TOKEN",
  "GOMA_NOTIFY_WABA_ID",
  "REMINDER_DRY_RUN",
] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(SENDER_VARS.map((k) => [k, process.env[k]]))
  for (const k of SENDER_VARS) delete process.env[k]
  // isProductionRuntime() fails closed, and env.ts refuses REMINDER_DRY_RUN in
  // production — so the test has to declare itself non-production to be able to
  // exercise the dry-run branch at all.
  process.env.APP_ENV = "test"
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

/**
 * A Supabase stand-in with no active rules — so materialisation is a no-op and
 * anything the test observes came from the delivery half.
 *
 * Every write path records itself, so "touched nothing" is an assertion about
 * observed calls rather than about the absence of an error.
 */
function stubAdmin() {
  const touched: string[] = []
  const patches: Record<string, unknown>[] = []
  const from = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      lte: () => chain,
      lt: () => chain,
      gt: () => chain,
      gte: () => chain,
      is: () => chain,
      not: () => chain,
      neq: () => chain,
      or: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single: () => Promise.resolve({ data: null, error: null }),
      in: () => chain,
      order: () => chain,
      range: () => Promise.resolve({ data: [], error: null }),
      limit: () => Promise.resolve({ data: [], error: null }),
      update: (patch: Record<string, unknown>) => {
        touched.push(`update:${table}`)
        patches.push(patch)
        return chain
      },
      upsert: () => {
        touched.push(`upsert:${table}`)
        return chain
      },
      delete: () => {
        touched.push(`delete:${table}`)
        return chain
      },
      then: (r: (v: { data: unknown; error: null; count: number }) => unknown) =>
        r({ data: [], error: null, count: 0 }),
    }
    return chain
  }
  return { admin: { from } as unknown as SupabaseClient, touched, patches }
}

describe("getGomaSender — the guard's input", () => {
  it("is null when neither credential is set", async () => {
    const { getGomaSender } = await import("@/lib/notify/goma-sender")
    expect(getGomaSender()).toBeNull()
  })

  it("stands in for the credentials under dry run, so the path stays exercisable", async () => {
    process.env.REMINDER_DRY_RUN = "1"
    const { getGomaSender } = await import("@/lib/notify/goma-sender")
    // This is why the guard checks the SENDER rather than the raw variables:
    // excluding dry run would disable the one mode that exists to rehearse
    // delivery before Meta approves the template.
    expect(getGomaSender()).not.toBeNull()
  })

  it("needs both variables, not either", async () => {
    process.env.GOMA_NOTIFY_PHONE_NUMBER_ID = "123"
    const { getGomaSender } = await import("@/lib/notify/goma-sender")
    expect(getGomaSender()).toBeNull()
  })
})

describe("runReminderCycle with no sender", () => {
  it("never resolves a reminder because the sender is missing", async () => {
    const { admin, patches } = stubAdmin()
    const { runReminderCycle } = await import("@/lib/lifecycle/run-cycle")

    const result = await runReminderCycle(admin)

    // The stuck-claim sweep DOES write, before delivery and regardless of any
    // sender: two filtered bulk UPDATEs that match nothing on a healthy queue.
    // One of them legitimately sets status='failed' (a claim that died with no
    // attempts left), so `failed` cannot be the marker here.
    //
    // `skipped` can, because nothing else in the cycle produces it — it was
    // written by exactly one line, the not_configured branch this change
    // removed. Its absence IS the regression test.
    expect(patches.filter((p) => p.status === "skipped")).toEqual([])
    expect(patches.filter((p) => p.status === "sent")).toEqual([])

    expect(result.sent).toBe(0)
    expect(result.failed).toBe(0)
    // And specifically NOT counted as skipped, which is what it used to report.
    expect(result.skipped).toBe(0)
  })
})
