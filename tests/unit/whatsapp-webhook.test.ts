import { describe, it, expect } from "vitest"
import { createHmac } from "node:crypto"
import { verifySubscription, verifySignature } from "@/lib/notify/webhook-verify"
import { parseWebhookBatch, buildSenderIndex, matchSender } from "@/lib/notify/webhook-events"

/**
 * This endpoint is the one unauthenticated write surface in the app: a POST it
 * accepts can mark real reminders `failed`. The signature check is the entire
 * defence, so these tests are about what it REFUSES at least as much as what it
 * lets through.
 */

const SECRET = "app-secret-from-meta"
const sign = (body: string, secret = SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex")

const url = (params: Record<string, string>) =>
  new URL(`https://example.test/api/webhooks/whatsapp?${new URLSearchParams(params)}`)

describe("verifySubscription", () => {
  const TOKEN = "X5N=Sr8Zt?L"

  it("echoes the challenge when the token matches", () => {
    const result = verifySubscription(
      url({ "hub.mode": "subscribe", "hub.verify_token": TOKEN, "hub.challenge": "1158201444" }),
      TOKEN,
    )
    expect(result).toEqual({ ok: true, challenge: "1158201444" })
  })

  it("survives a token full of URL metacharacters", () => {
    // The token Meta was given contains '=' and '?'. Both are query-string
    // structure, so a hand-rolled parser would truncate it and the handshake
    // would fail for a token that is, in fact, correct.
    const result = verifySubscription(
      url({ "hub.mode": "subscribe", "hub.verify_token": TOKEN, "hub.challenge": "abc" }),
      TOKEN,
    )
    expect(result.ok).toBe(true)
  })

  it("refuses a wrong token", () => {
    const result = verifySubscription(
      url({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "abc" }),
      TOKEN,
    )
    expect(result).toEqual({ ok: false, status: 403, reason: "verify token mismatch" })
  })

  it("refuses a token that is a prefix of the real one", () => {
    // Guards the length check in front of timingSafeEqual, which throws rather
    // than returning false when the buffers differ in length.
    const result = verifySubscription(
      url({ "hub.mode": "subscribe", "hub.verify_token": TOKEN.slice(0, 4), "hub.challenge": "a" }),
      TOKEN,
    )
    expect(result.ok).toBe(false)
  })

  it("refuses when hub.mode is not subscribe", () => {
    const result = verifySubscription(
      url({ "hub.mode": "unsubscribe", "hub.verify_token": TOKEN, "hub.challenge": "abc" }),
      TOKEN,
    )
    expect(result.ok).toBe(false)
  })

  it("reports 503 rather than 403 when no token is configured", () => {
    // Different problem, different answer: 403 would send whoever is setting
    // this up looking for a typo in a value that was never read.
    const result = verifySubscription(
      url({ "hub.mode": "subscribe", "hub.verify_token": "anything", "hub.challenge": "abc" }),
      undefined,
    )
    expect(result).toMatchObject({ ok: false, status: 503 })
  })

  it("cannot be satisfied by an empty configured token", () => {
    const result = verifySubscription(
      url({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "abc" }),
      "   ",
    )
    expect(result).toMatchObject({ ok: false, status: 503 })
  })
})

describe("verifySignature", () => {
  const BODY = '{"object":"whatsapp_business_account","entry":[]}'

  it("accepts a correctly signed body", () => {
    expect(verifySignature(BODY, sign(BODY), SECRET)).toEqual({ ok: true })
  })

  it("accepts an uppercase hex digest", () => {
    expect(verifySignature(BODY, sign(BODY).toUpperCase(), SECRET).ok).toBe(true)
  })

  it("rejects a body that changed by one byte", () => {
    const header = sign(BODY)
    const tampered = BODY.replace("[]", '[{"id":"1"}]')
    expect(verifySignature(tampered, header, SECRET)).toMatchObject({ ok: false, status: 401 })
  })

  it("rejects a signature made with the wrong secret", () => {
    expect(verifySignature(BODY, sign(BODY, "not-the-app-secret"), SECRET)).toMatchObject({
      ok: false,
      status: 401,
    })
  })

  it("rejects a missing signature header", () => {
    expect(verifySignature(BODY, null, SECRET)).toMatchObject({ ok: false, status: 401 })
  })

  it("rejects sha1, which Meta also sends", () => {
    // X-Hub-Signature (sha1) rides alongside the sha256 header and is weaker.
    // Reading the wrong one is a real and easy mistake.
    expect(verifySignature(BODY, "sha1=" + "0".repeat(40), SECRET)).toMatchObject({ ok: false })
  })

  it("FAILS CLOSED when the app secret is unset", () => {
    // The whole point. An unconfigured secret must never mean "accept
    // anything" — this route writes to `reminders`.
    expect(verifySignature(BODY, sign(BODY), undefined)).toMatchObject({ ok: false, status: 503 })
    expect(verifySignature(BODY, sign(BODY), "  ")).toMatchObject({ ok: false, status: 503 })
  })

  it("cannot be bypassed with an empty signature", () => {
    expect(verifySignature(BODY, "sha256=", SECRET).ok).toBe(false)
  })
})

describe("parseWebhookBatch", () => {
  const wrap = (value: unknown) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "waba", changes: [{ field: "messages", value }] }],
  })

  it("pulls out a failed status with Meta's reason", () => {
    const batch = parseWebhookBatch(
      wrap({
        statuses: [
          {
            id: "wamid.ABC",
            status: "failed",
            errors: [
              { code: 131047, title: "Re-engagement message", error_data: { details: "24h window" } },
            ],
          },
        ],
      }),
    )
    expect(batch.statuses).toEqual([
      { wamid: "wamid.ABC", status: "failed", error: "[131047] 24h window" },
    ])
  })

  it("keeps delivered and read, so the caller decides what to act on", () => {
    const batch = parseWebhookBatch(
      wrap({ statuses: [{ id: "a", status: "delivered" }, { id: "b", status: "read" }] }),
    )
    expect(batch.statuses.map((s) => s.status)).toEqual(["delivered", "read"])
  })

  it("drops a status with an unknown state rather than storing it", () => {
    const batch = parseWebhookBatch(wrap({ statuses: [{ id: "a", status: "warp-speed" }] }))
    expect(batch.statuses).toEqual([])
  })

  it("reads a text reply", () => {
    const batch = parseWebhookBatch(
      wrap({
        messages: [
          { id: "wamid.X", from: "6591234567", type: "text", timestamp: "1755600000", text: { body: "on it" } },
        ],
      }),
    )
    expect(batch.messages).toEqual([
      {
        wamid: "wamid.X",
        from: "6591234567",
        type: "text",
        body: "on it",
        sentAt: "2025-08-19T10:40:00.000Z",
      },
    ])
  })

  it("keeps a media message with a null body rather than discarding it", () => {
    const batch = parseWebhookBatch(
      wrap({ messages: [{ id: "w", from: "65900", type: "image", image: { id: "media" } }] }),
    )
    expect(batch.messages[0]).toMatchObject({ type: "image", body: null, sentAt: null })
  })

  it("still returns the statuses beside a message type it cannot read", () => {
    // The reason this parser is lenient: a strict one would reject the whole
    // payload over the unfamiliar message and lose the delivery receipt
    // sitting next to it.
    const batch = parseWebhookBatch(
      wrap({
        messages: [{ id: "w", from: "65900", type: "some_future_type" }],
        statuses: [{ id: "wamid.OK", status: "failed", errors: [{ code: 1 }] }],
      }),
    )
    expect(batch.statuses).toHaveLength(1)
    expect(batch.messages).toHaveLength(1)
  })

  it("ignores a payload for a different Meta product", () => {
    expect(parseWebhookBatch({ object: "page", entry: [{ messaging: [{}] }] })).toEqual({
      statuses: [],
      messages: [],
    })
  })

  it("ignores non-message fields on the same subscription", () => {
    const batch = parseWebhookBatch({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "message_template_status_update", value: { statuses: [{ id: "x", status: "failed" }] } }] }],
    })
    expect(batch.statuses).toEqual([])
  })

  it("never throws on junk", () => {
    for (const junk of [null, undefined, "", 42, [], {}, { entry: "no" }, { object: "whatsapp_business_account", entry: [null] }]) {
      expect(() => parseWebhookBatch(junk)).not.toThrow()
    }
  })

  it("drops rows missing the fields the database requires", () => {
    const batch = parseWebhookBatch(
      wrap({
        statuses: [{ status: "failed" }],
        messages: [{ id: "no-from", type: "text" }, { from: "65900", type: "text" }],
      }),
    )
    expect(batch).toEqual({ statuses: [], messages: [] })
  })
})

describe("sender attribution", () => {
  const priscillaA = { id: "m1", business_id: "biz-a", whatsapp_number: "+6591110022" }
  const priscillaB = { id: "m2", business_id: "biz-b", whatsapp_number: "+6591110022" }
  const marcus = { id: "m3", business_id: "biz-a", whatsapp_number: "+6598887777" }

  it("attributes a number that identifies exactly one member", () => {
    const index = buildSenderIndex([priscillaA, marcus])
    expect(matchSender(index, "6598887777")).toEqual({
      match: { id: "m3", business_id: "biz-a" },
      ambiguous: false,
    })
  })

  it("matches across the +/no-+ spelling difference", () => {
    // Meta sends "6598887777"; the roster stores "+6598887777".
    const index = buildSenderIndex([marcus])
    expect(matchSender(index, "6598887777").match?.id).toBe("m3")
  })

  it("tolerates a roster number stored with spaces and punctuation", () => {
    const index = buildSenderIndex([{ ...marcus, whatsapp_number: "+65 9888 7777" }])
    expect(matchSender(index, "6598887777").match?.id).toBe("m3")
  })

  it("REFUSES to attribute a number on two different businesses", () => {
    // The cross-tenant case. business_id drives the RLS policy on
    // whatsapp_inbound_messages, so guessing here would let one agency read
    // another agency's reply.
    const index = buildSenderIndex([priscillaA, priscillaB])
    expect(matchSender(index, "6591110022")).toEqual({ match: null, ambiguous: true })
  })

  it("gives the same answer whichever order the rows arrive in", () => {
    const forward = matchSender(buildSenderIndex([priscillaA, priscillaB]), "6591110022")
    const reverse = matchSender(buildSenderIndex([priscillaB, priscillaA]), "6591110022")
    expect(forward).toEqual(reverse)
    expect(forward.match).toBeNull()
  })

  it("refuses even when the duplicates are inside ONE business", () => {
    // No cross-tenant risk here, but attributing a reply to the wrong colleague
    // is still wrong, and there is no basis to choose between them.
    const index = buildSenderIndex([priscillaA, { ...priscillaA, id: "m9" }])
    expect(matchSender(index, "6591110022").match).toBeNull()
  })

  it("reports an unknown number as unmatched, not ambiguous", () => {
    // The two must stay distinguishable: one means "nobody", the other means
    // "somebody, and we will not say who".
    const index = buildSenderIndex([marcus])
    expect(matchSender(index, "6512345678")).toEqual({ match: null, ambiguous: false })
  })

  it("ignores roster rows with no number at all", () => {
    const index = buildSenderIndex([{ id: "m4", business_id: "biz-a", whatsapp_number: null }])
    expect(index.size).toBe(0)
  })
})

describe("attribution survives inconsistent number FORMATTING", () => {
  it("still detects ambiguity when the duplicates are spelled differently", () => {
    // The regression that mattered. An earlier version prefiltered in SQL with
    // an exact string match while this index compares digits, so the
    // space-formatted row was never fetched — the number then looked unique and
    // the reply was filed under one of two tenants.
    const index = buildSenderIndex([
      { id: "m1", business_id: "biz-a", whatsapp_number: "+6591110022" },
      { id: "m2", business_id: "biz-b", whatsapp_number: "+65 9111 0022" },
      { id: "m3", business_id: "biz-c", whatsapp_number: "(65) 9111-0022" },
    ])
    expect(matchSender(index, "6591110022")).toEqual({ match: null, ambiguous: true })
  })

  it("attributes a uniquely-held number however it is punctuated", () => {
    const index = buildSenderIndex([
      { id: "m1", business_id: "biz-a", whatsapp_number: "+65 9888 7777" },
    ])
    expect(matchSender(index, "6598887777").match).toEqual({ id: "m1", business_id: "biz-a" })
  })
})
