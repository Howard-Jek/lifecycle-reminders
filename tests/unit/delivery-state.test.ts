import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { loadDeliveryStates, DELIVERY_STAGES } from "@/lib/lifecycle/delivery-state"

/**
 * Reading Meta's side of the story.
 *
 * `reminders.status` says whether WE handed the message over. Whether it
 * arrived, whether anyone opened it, and why it failed are facts only Meta has,
 * and they have been landing in whatsapp_status_events all along with nothing
 * reading them.
 */

function stub(rows: unknown[], onQuery?: (ids: string[]) => void) {
  const chain = {
    select: () => chain,
    in: (_col: string, ids: string[]) => {
      onQuery?.(ids)
      return Promise.resolve({ data: rows, error: null })
    },
  }
  return { from: () => chain } as unknown as SupabaseClient
}

const receipt = (over: Record<string, unknown>) => ({
  wamid: "w1",
  status: "sent",
  error: null,
  error_code: null,
  occurred_at: "2026-08-30T03:01:28.000Z",
  received_at: "2026-08-30T03:01:28.000Z",
  ...over,
})

describe("loadDeliveryStates", () => {
  it("reports the FURTHEST stage, not the most recent receipt", async () => {
    // Meta does not guarantee receipt order. A `sent` arriving after a `read`
    // must not walk the trail backwards and tell the operator it was never
    // opened.
    const states = await loadDeliveryStates(
      stub([receipt({ status: "read" }), receipt({ status: "sent" })]),
      ["w1"],
    )
    expect(states.get("w1")?.stage).toBe("read")
  })

  it("climbs sent → delivered → read", async () => {
    const states = await loadDeliveryStates(
      stub([receipt({ status: "sent" }), receipt({ status: "delivered" })]),
      ["w1"],
    )
    expect(states.get("w1")?.stage).toBe("delivered")
  })

  it("keeps a failure alongside the stage it got to", async () => {
    // A message really can be `sent` and then fail — that is exactly the
    // sequence on this deployment, and showing only one of the two would hide
    // either the failure or how far it got.
    const states = await loadDeliveryStates(
      stub([
        receipt({ status: "sent" }),
        receipt({ status: "failed", error_code: "131049", error: "[131049] engagement" }),
      ]),
      ["w1"],
    )
    const s = states.get("w1")
    expect(s?.stage).toBe("sent")
    expect(s?.failure?.code).toBe("131049")
  })

  it("keeps the LATEST failure when a retry fails differently", async () => {
    const states = await loadDeliveryStates(
      stub([
        receipt({ status: "failed", error_code: "131026", occurred_at: "2026-08-30T01:00:00.000Z" }),
        receipt({ status: "failed", error_code: "131049", occurred_at: "2026-08-31T01:00:00.000Z" }),
      ]),
      ["w1"],
    )
    expect(states.get("w1")?.failure?.code).toBe("131049")
  })

  it("says nothing rather than guessing when Meta has not reported", async () => {
    // An absent receipt is unknown. Rendering "not delivered" would be a claim
    // we have no evidence for — Meta suppresses `read` entirely if the
    // recipient turns receipts off.
    const states = await loadDeliveryStates(stub([]), ["w1"])
    expect(states.get("w1")).toBeUndefined()
  })

  it("asks for nothing when there are no message ids", async () => {
    let asked = false
    const states = await loadDeliveryStates(
      stub([], () => {
        asked = true
      }),
      [],
    )
    expect(states.size).toBe(0)
    expect(asked).toBe(false)
  })

  it("de-duplicates ids before asking", async () => {
    let seen: string[] = []
    await loadDeliveryStates(
      stub([], (ids) => {
        seen = ids
      }),
      ["w1", "w1", "w1"],
    )
    expect(seen).toEqual(["w1"])
  })

  it("orders the stages the way Meta reports them", () => {
    // The component renders this array directly, so the order IS the UI.
    expect([...DELIVERY_STAGES]).toEqual(["sent", "delivered", "read"])
  })
})
