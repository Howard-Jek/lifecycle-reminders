import { describe, it, expect, vi, afterEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { reassignContactReminders } from "@/lib/lifecycle/reassign-reminders"

/**
 * The contract here is about what happens AFTER the assignment is committed.
 *
 * By the time this runs, leads.assigned_member_id is already changed. So a
 * failure moving the reminders is not "the assignment failed" — reporting it
 * as one would show an error for something that worked and invite a retry that
 * changes nothing.
 */

function stub(result: { data: unknown; error: { message: string } | null }) {
  const maybeSingle = vi.fn(async () => result)
  // Params declared so the call-args assertions below are type-checked too;
  // an untyped vi.fn() gives mock.calls an empty tuple type.
  const rpc = vi.fn((_fn: string, _args: Record<string, unknown>) => ({ maybeSingle }))
  return { client: { rpc } as unknown as SupabaseClient, rpc, maybeSingle }
}

afterEach(() => vi.restoreAllMocks())

describe("reassignContactReminders", () => {
  it("passes the tenant, contact and new agent through to the function", () => {
    const { client, rpc } = stub({ data: { moved: 2, superseded: 0 }, error: null })
    return reassignContactReminders(client, "biz-1", "lead-1", "member-2").then(() => {
      expect(rpc).toHaveBeenCalledWith("reassign_contact_reminders", {
        p_business_id: "biz-1",
        p_lead_id: "lead-1",
        p_member_id: "member-2",
      })
    })
  })

  it("passes a null agent through rather than skipping the call", async () => {
    // Unassigning is a real reassignment: those rows move to the owner's
    // fallback number. Treating null as "nothing to do" would leave them
    // addressed to the agent the contact was just taken away from.
    const { client, rpc } = stub({ data: { moved: 1, superseded: 0 }, error: null })
    await reassignContactReminders(client, "biz-1", "lead-1", null)
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_member_id: null })
  })

  it("never throws when the function errors, and says so in the log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { client } = stub({ data: null, error: { message: "function does not exist" } })

    await expect(
      reassignContactReminders(client, "biz-1", "lead-1", "member-2"),
    ).resolves.toEqual({ moved: 0, superseded: 0 })

    // The consequence is invisible from the UI — reminders keep going to the
    // old agent — so the log line has to name the contact and the cause.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][0])).toContain("lead-1")
    expect(String(spy.mock.calls[0][0])).toContain("function does not exist")
  })

  it("reports zeros rather than NaN when the function returns no row", async () => {
    const { client } = stub({ data: null, error: null })
    await expect(
      reassignContactReminders(client, "biz-1", "lead-1", "member-2"),
    ).resolves.toEqual({ moved: 0, superseded: 0 })
  })

  it("stays quiet when there was nothing to move", async () => {
    // The common case by far: a contact with no dates yet, or one reassigned
    // twice in a row. A log line per no-op is a log nobody reads.
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const { client } = stub({ data: { moved: 0, superseded: 0 }, error: null })
    await reassignContactReminders(client, "biz-1", "lead-1", "member-2")
    expect(info).not.toHaveBeenCalled()
  })
})
