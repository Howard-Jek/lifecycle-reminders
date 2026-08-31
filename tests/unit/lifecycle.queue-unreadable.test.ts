import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * A queue that cannot be READ is not a queue with nothing in it.
 *
 * The delivery fetch used to swallow its own error and return
 * `{sent: 0, failed: 0, skipped: 0}`, and every layer above believed it:
 * runReminderCycle returned normally, the cron route answered 200 with
 * ok:true, and the tick workflow went green — every fifteen minutes, while
 * nothing was delivered.
 *
 * reminders-tick.yml guards a 200 with ok:false in as many words, because "the
 * job would go green on a broken run, which is the failure mode a scheduler is
 * least able to afford". This path walked around that guard, and the trigger is
 * routine rather than exotic: Vercel deploys on push while migrations are
 * applied by hand, so a column the delivery query filters on can be absent for
 * minutes at a time.
 */

const SAVED: Record<string, string | undefined> = {}
const VARS = ["REMINDER_DRY_RUN", "APP_ENV", "GOMA_NOTIFY_PHONE_NUMBER_ID", "GOMA_NOTIFY_ACCESS_TOKEN"]

beforeEach(() => {
  for (const k of VARS) SAVED[k] = process.env[k]
  // A sender must exist, or deliverDue returns before it ever reads the queue.
  process.env.APP_ENV = "test"
  process.env.REMINDER_DRY_RUN = "1"
})

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

/**
 * A Supabase stand-in whose `reminders` reads fail the way PostgREST fails when
 * a filtered column does not exist. Every other table answers normally, so
 * materialisation completes and the only thing under test is the delivery read.
 *
 * `businesses` must report one with automatic sending ON. The auto-send gate
 * queries it before the delivery fetch and returns early when nothing is
 * enabled, so a stub that leaves it empty passes this test without ever
 * reaching the line it is meant to be testing.
 */
function stubAdmin(remindersReadError: { message: string } | null) {
  const from = (table: string) => {
    const failing = table === "reminders" && remindersReadError !== null
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
      in: () => chain,
      order: () => chain,
      insert: () => chain,
      update: () => chain,
      upsert: () => chain,
      delete: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single: () => Promise.resolve({ data: null, error: null }),
      range: () => Promise.resolve({ data: [], error: null }),
      // .limit() is NOT terminal: the auto-send gate appends .in()/.lte()
      // after it, so returning a promise here breaks the chain the real
      // builder allows. Everything terminates on await, via then.
      limit: () => chain,
      then: (r: (v: { data: unknown; error: unknown; count: number }) => unknown) =>
        r(
          failing
            ? { data: null, error: remindersReadError, count: 0 }
            : {
                data: table === "businesses" ? [{ id: "biz-1" }] : [],
                error: null,
                count: 0,
              },
        ),
    }
    return chain
  }
  return { from } as unknown as SupabaseClient
}

describe("runReminderCycle when the queue cannot be read", () => {
  it("throws, so the tick fails loudly instead of reporting an empty queue", async () => {
    const { runReminderCycle } = await import("@/lib/lifecycle/run-cycle")
    const admin = stubAdmin({
      message: 'column reminders.next_attempt_at does not exist',
    })

    await expect(runReminderCycle(admin)).rejects.toThrow(/could not read the reminder queue/i)
  })

  it("carries the database's own reason, so the cause is in the failure", async () => {
    const { runReminderCycle } = await import("@/lib/lifecycle/run-cycle")
    const admin = stubAdmin({ message: 'column reminders.next_attempt_at does not exist' })

    // The cron route puts this string in its 500 body and the workflow prints
    // it. A generic "cycle failed" would send someone to the logs for a fact
    // the error already had.
    await expect(runReminderCycle(admin)).rejects.toThrow(/next_attempt_at does not exist/)
  })

  it("still returns normally when the queue is merely empty", async () => {
    // The distinction the old code could not make. Nothing to send is a
    // successful tick; nothing readable is not.
    const { runReminderCycle } = await import("@/lib/lifecycle/run-cycle")
    const result = await runReminderCycle(stubAdmin(null))
    expect(result).toMatchObject({ sent: 0, failed: 0, skipped: 0 })
  })
})
