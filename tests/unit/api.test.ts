import { describe, it, expect } from "vitest"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { SupabaseClient } from "@supabase/supabase-js"
import { authenticateApiToken } from "@/lib/api/auth"
import {
  toPublicReminder,
  toPublicContact,
  toPublicEvent,
  toPublicMember,
  toPublicRule,
  toPublicReview,
} from "@/lib/api/serialize"

const hash = (token: string) => createHash("sha256").update(token).digest("hex")

/** A Supabase stand-in whose token table contains exactly `rows`. */
function adminWithTokens(rows: Record<string, unknown>[]): SupabaseClient {
  return {
    from: () => {
      let matched = rows
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (_col: string, value: unknown) => {
          matched = matched.filter((r) => r.token_hash === value)
          return chain
        },
        maybeSingle: async () => ({ data: matched[0] ?? null, error: null }),
      }
      return chain
    },
  } as unknown as SupabaseClient
}

const request = (headers: Record<string, string> = {}) =>
  new Request("https://example.test/api/v1/reminders", { headers })

describe("authenticateApiToken", () => {
  it("rejects a request with no Authorization header", async () => {
    const result = await authenticateApiToken(adminWithTokens([]), request())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.reason).toBe("missing")
  })

  it("rejects a header that is not a Bearer token", async () => {
    const result = await authenticateApiToken(
      adminWithTokens([]),
      request({ authorization: "Basic abc123" }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.reason).toBe("missing")
  })

  it("resolves the tenant from the token, since the request names none", async () => {
    // The whole tenancy model in one assertion: nothing in the request says
    // which business it is for, so the token has to say.
    const admin = adminWithTokens([
      { id: "tok_1", business_id: "biz_1", token_hash: hash("secret"), revoked_at: null },
    ])
    const result = await authenticateApiToken(admin, request({ authorization: "Bearer secret" }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.caller.businessId).toBe("biz_1")
      expect(result.caller.tokenId).toBe("tok_1")
    }
  })

  it("stores only the hash — the raw token never has to be known", async () => {
    const admin = adminWithTokens([
      { id: "tok_1", business_id: "biz_1", token_hash: hash("secret"), revoked_at: null },
    ])
    const wrong = await authenticateApiToken(admin, request({ authorization: "Bearer wrong" }))
    expect(wrong.ok).toBe(false)
  })

  it("answers a revoked token exactly as it answers an unknown one", async () => {
    // Distinguishing them tells a prober that a token was once real, which is
    // the one bit they are fishing for.
    const revoked = await authenticateApiToken(
      adminWithTokens([
        { id: "t", business_id: "b", token_hash: hash("old"), revoked_at: "2026-01-01T00:00:00Z" },
      ]),
      request({ authorization: "Bearer old" }),
    )
    const unknown = await authenticateApiToken(
      adminWithTokens([]),
      request({ authorization: "Bearer never-existed" }),
    )
    expect(revoked.ok).toBe(false)
    expect(unknown.ok).toBe(false)
    if (!revoked.ok && !unknown.ok) {
      expect(revoked.failure).toEqual(unknown.failure)
    }
  })
})

describe("serialisers", () => {
  /** Every row in this app carries business_id. None of them may leave. */
  const rowWithTenant = {
    id: "1",
    business_id: "biz_secret",
    status: "queued",
    occurrence_date: "2026-09-01",
    due_at: "2026-08-25T01:00:00Z",
    event_id: "e1",
    rule_id: "r1",
    lead_id: "l1",
    event_type: "birthday",
    event_date: "1990-09-01",
    name: "Tan Wei Ming",
    phone: "+6591234567",
    display_name: "Jasmine Tan",
    whatsapp_number: "+6592220033",
    role: "agent",
    active: true,
    offset_days: 7,
    audience: "assigned",
    suggest_message: true,
    send_window: "morning",
    import_id: "i1",
    row_number: 9,
    reason: "unknown_member",
  }

  const serialisers = [
    ["reminder", toPublicReminder],
    ["contact", toPublicContact],
    ["event", toPublicEvent],
    ["member", toPublicMember],
    ["rule", toPublicRule],
    ["review", toPublicReview],
  ] as const

  for (const [name, fn] of serialisers) {
    it(`never emits business_id from a ${name}`, () => {
      const out = fn(rowWithTenant) as Record<string, unknown>
      expect(Object.keys(out)).not.toContain("business_id")
      expect(JSON.stringify(out)).not.toContain("biz_secret")
    })
  }

  it("defaults a missing payload to an object rather than null", () => {
    // A caller doing `event.payload.foo` should not have to null-check a column
    // that is conceptually always there.
    expect(toPublicEvent({ ...rowWithTenant, payload: null }).payload).toEqual({})
    expect(toPublicReview({ ...rowWithTenant, raw: null, parsed: null }).raw).toEqual({})
  })
})

describe("every v1 route scopes its queries to the caller's tenant", () => {
  // A source-level check, and deliberately so. These handlers run on the
  // SERVICE-ROLE client because a token-authed caller has no auth.uid() for RLS
  // to key on — so RLS cannot save a query that forgets its business filter.
  // The filter is the only thing standing between tenants, and forgetting one
  // in a new route is the single most expensive mistake available here.
  const dir = join(process.cwd(), "src/app/api/v1")

  function routeFiles(base: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(base)) {
      const full = join(base, entry)
      if (statSync(full).isDirectory()) out.push(...routeFiles(full))
      else if (entry === "route.ts") out.push(full)
    }
    return out
  }

  const files = routeFiles(dir)

  it("finds the routes at all, so this test cannot pass vacuously", () => {
    expect(files.length).toBeGreaterThanOrEqual(7)
  })

  for (const file of files) {
    const label = file.slice(file.indexOf("api/v1"))

    it(`${label} takes its tenant from the token`, () => {
      const source = readFileSync(file, "utf8")
      // The invariant is not "mentions business_id" — it is that the tenant
      // comes from `caller`, which comes from the token, and never from the
      // path, the query string or the body. A route may then either filter
      // directly or hand the value to something that does; the ingest route
      // does the latter, passing it to ingestContacts, which applies it to
      // every write and every lookup.
      expect(source).toContain("caller.businessId")
      // And it must never accept a tenant from the caller's own input.
      expect(source).not.toMatch(/searchParams\.get\(["']business_id/)
      expect(source).not.toMatch(/body\.business_id|\.business_id\s*=\s*parsed/)
    })

    it(`${label} authenticates`, () => {
      expect(readFileSync(file, "utf8")).toContain("withApiToken")
    })
  }
})
