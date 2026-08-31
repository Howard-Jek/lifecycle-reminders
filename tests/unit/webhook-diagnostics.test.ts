import { describe, it, expect, vi, afterEach } from "vitest"
import {
  callbackUrlFor,
  fingerprintVerifyToken,
  probeCallbackUrl,
  WEBHOOK_PATH,
} from "@/lib/notify/webhook-diagnostics"

/**
 * These probes exist to explain a failure Meta refuses to explain, so the thing
 * under test is mostly the WORDING and the classification: a 308 must not be
 * reported as a token problem, and a Vercel login page must not be reported as
 * a 403 from our own route. Getting either wrong sends an operator to edit a
 * value that was never read.
 */

const TOKEN = "X5N=SrJ8Zt?L"
const URL_UNDER_TEST = "https://lifecycle-app-tau.vercel.app" + WEBHOOK_PATH

/** The challenge the probe invented, recovered from the URL it requested. */
function challengeFrom(call: string): string {
  return new URL(call).searchParams.get("hub.challenge")!
}

function stubFetch(handler: (url: string) => Response) {
  // `init` is declared even though the handler ignores it: the redirect test
  // asserts on it, and a one-parameter spy makes calls[0][1] a type error.
  const spy = vi.fn(async (input: string | URL, init?: RequestInit) => {
    void init
    return handler(String(input))
  })
  vi.stubGlobal("fetch", spy)
  return spy
}

afterEach(() => vi.unstubAllGlobals())

describe("callbackUrlFor", () => {
  it("appends the one registered path", () => {
    expect(callbackUrlFor("https://lifecycle-app-tau.vercel.app")).toBe(URL_UNDER_TEST)
  })

  it("does not produce a double slash from a trailing-slash APP_PUBLIC_URL", () => {
    // A '//' here becomes a 308 in production, which is precisely the failure
    // these probes exist to catch — emitting one ourselves would be absurd.
    expect(callbackUrlFor("https://lifecycle-app-tau.vercel.app/")).toBe(URL_UNDER_TEST)
    expect(callbackUrlFor("https://lifecycle-app-tau.vercel.app///")).toBe(URL_UNDER_TEST)
  })
})

describe("probeCallbackUrl", () => {
  it("passes when the challenge comes back verbatim", async () => {
    const spy = stubFetch((url) => new Response(challengeFrom(url), { status: 200 }))
    const probe = await probeCallbackUrl(URL_UNDER_TEST, TOKEN)
    expect(probe.tone).toBe("good")
    expect(probe.status).toBe(200)
    expect(spy).toHaveBeenCalledOnce()
  })

  it("sends a DIFFERENT challenge each time", async () => {
    const seen: string[] = []
    stubFetch((url) => {
      seen.push(challengeFrom(url))
      return new Response(challengeFrom(url), { status: 200 })
    })
    await probeCallbackUrl(URL_UNDER_TEST, TOKEN)
    await probeCallbackUrl(URL_UNDER_TEST, TOKEN)
    // A fixed challenge would let a cached response pass as a live success.
    expect(seen[0]).not.toBe(seen[1])
  })

  it("never follows a redirect, and reports it as the fault", async () => {
    // The Location header echoes the WHOLE query string back — token included.
    // That is real Next.js behaviour, and it is how the token nearly ended up
    // rendered in the settings panel.
    const spy = stubFetch(
      () =>
        new Response(null, {
          status: 308,
          headers: {
            location: `${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(TOKEN)}`,
          },
        }),
    )
    const probe = await probeCallbackUrl(URL_UNDER_TEST, TOKEN)
    expect(probe.tone).toBe("bad")
    expect(probe.status).toBe(308)
    expect(probe.detail).toMatch(/does not follow redirects/i)
    expect(probe.evidence).toContain(WEBHOOK_PATH)
    // redirect: "manual" is the whole point — following it would turn the most
    // common cause of this bug into a passing check.
    expect(spy.mock.calls[0][1]).toMatchObject({ redirect: "manual" })
  })

  it("blames the token on a plain-text 403 from our own route", async () => {
    stubFetch(
      () =>
        new Response("Forbidden", {
          status: 403,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    )
    const probe = await probeCallbackUrl(URL_UNDER_TEST, TOKEN)
    expect(probe.tone).toBe("bad")
    expect(probe.detail).toMatch(/byte-identical/i)
    expect(probe.detail).not.toMatch(/deployment protection/i)
  })

  it("blames deployment protection on an HTML 401, not the token", async () => {
    stubFetch(
      () =>
        new Response("<html><body>Authentication Required</body></html>", {
          status: 401,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    )
    const probe = await probeCallbackUrl(URL_UNDER_TEST, TOKEN)
    expect(probe.tone).toBe("bad")
    expect(probe.detail).toMatch(/Deployment Protection/i)
    // The token is fine in this case; saying otherwise wastes the operator's day.
    expect(probe.detail).not.toMatch(/byte-identical/i)
  })

  it("calls out a 200 whose body is not the challenge", async () => {
    // A JSON-wrapped challenge is the classic: 200, looks right, fails at Meta.
    stubFetch((url) => new Response(JSON.stringify(challengeFrom(url)), { status: 200 }))
    const probe = await probeCallbackUrl(URL_UNDER_TEST, TOKEN)
    expect(probe.tone).toBe("bad")
    expect(probe.status).toBe(200)
    expect(probe.detail).toMatch(/byte-for-byte/i)
  })

  it("reports 404 as a wrong path rather than a wrong token", async () => {
    stubFetch(() => new Response("Not Found", { status: 404 }))
    const probe = await probeCallbackUrl(URL_UNDER_TEST, TOKEN)
    expect(probe.detail).toMatch(/wrong|does not have this route/i)
  })

  it("reports 503 as unconfigured on the serving deployment", async () => {
    stubFetch(() => new Response("Forbidden", { status: 503 }))
    const probe = await probeCallbackUrl(URL_UNDER_TEST, TOKEN)
    expect(probe.detail).toMatch(/no verify token configured/i)
  })

  it("says so plainly when no token is configured, without calling out", async () => {
    const spy = stubFetch(() => new Response("", { status: 200 }))
    const probe = await probeCallbackUrl(URL_UNDER_TEST, "   ")
    expect(probe.tone).toBe("bad")
    expect(probe.status).toBeNull()
    expect(probe.detail).toMatch(/GOMA_NOTIFY_VERIFY_TOKEN/)
    expect(spy).not.toHaveBeenCalled()
  })

  it("survives the callback URL being unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("getaddrinfo ENOTFOUND") }))
    const probe = await probeCallbackUrl(URL_UNDER_TEST, TOKEN)
    expect(probe.tone).toBe("bad")
    expect(probe.status).toBeNull()
    expect(probe.detail).toMatch(/APP_PUBLIC_URL/)
  })

  it("NEVER puts the verify token in anything it shows the operator", async () => {
    // The panel is read aloud and screenshotted. The token must reach the wire
    // and stop there — it is in the request URL, so redaction is not automatic.
    const responses: Array<() => Response> = [
      () => new Response("nope", { status: 403 }),
      () =>
        new Response(null, {
          status: 308,
          headers: {
            location: `/x?hub.verify_token=${encodeURIComponent(TOKEN)}`,
          },
        }),
      // Lower-case percent-encoding, which some layers emit instead of upper.
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "/x?hub.verify_token=X5N%3dSrJ8Zt%3fL" },
        }),
      () => new Response(`echoed back: ${TOKEN}`, { status: 500 }),
      () => new Response("wrong-body", { status: 200 }),
      () => new Response("gone", { status: 404 }),
    ]
    for (const make of responses) {
      stubFetch(make)
      const probe = await probeCallbackUrl(URL_UNDER_TEST, TOKEN)
      const shown = `${probe.label} ${probe.detail} ${probe.evidence ?? ""}`
      expect(shown).not.toContain(TOKEN)
      expect(shown).not.toContain(encodeURIComponent(TOKEN))
    }
  })

  it("does send the real token on the wire", async () => {
    const spy = stubFetch((url) => new Response(challengeFrom(url), { status: 200 }))
    await probeCallbackUrl(URL_UNDER_TEST, TOKEN)
    const requested = new URL(String(spy.mock.calls[0][0]))
    expect(requested.searchParams.get("hub.verify_token")).toBe(TOKEN)
    expect(requested.searchParams.get("hub.mode")).toBe("subscribe")
  })
})

describe("fingerprintVerifyToken", () => {
  /**
   * The point of this probe is telling three Vercel environment rows apart
   * without printing any of them. A test that only checked "returns a Probe"
   * would miss the one property that matters: the value never appears.
   */

  it("reports the length and the environment it is running in", () => {
    vi.stubEnv("VERCEL_ENV", "production")
    const probe = fingerprintVerifyToken(TOKEN)
    expect(probe.tone).toBe("good")
    expect(probe.evidence).toContain("production")
    expect(probe.evidence).toContain(String(TOKEN.length))
  })

  it("says 'local' rather than guessing an environment off Vercel", () => {
    // Naming "development" here would point at a Vercel row that is not in play.
    vi.stubEnv("VERCEL_ENV", "")
    expect(fingerprintVerifyToken(TOKEN).evidence).toContain("local")
  })

  it("flags surrounding whitespace, and reports the TRIMMED length", () => {
    const probe = fingerprintVerifyToken(`  ${TOKEN}\n`)
    expect(probe.tone).toBe("bad")
    expect(probe.detail).toMatch(/whitespace/i)
    // The trimmed length is the one to compare against Meta's box; reporting
    // the padded length would send someone hunting for a token 3 characters
    // longer than the one they have.
    expect(probe.evidence).toContain(`${TOKEN.length} characters + surrounding whitespace`)
  })

  it("treats an unset token as unset", () => {
    for (const empty of [undefined, "", "   "]) {
      const probe = fingerprintVerifyToken(empty)
      expect(probe.tone).toBe("bad")
      expect(probe.detail).toMatch(/not set on this deployment/i)
    }
  })

  it("blames the environment scoping, not the operator, when absent", () => {
    // The common cause is a variable set for Preview only, or set without a
    // redeploy — not a variable nobody ever typed.
    const probe = fingerprintVerifyToken(undefined)
    expect(probe.detail).toMatch(/DIFFERENT environment|without redeploying/i)
  })

  it("NEVER contains the token value", () => {
    for (const raw of [TOKEN, `  ${TOKEN}  `, `${TOKEN}\n`]) {
      const probe = fingerprintVerifyToken(raw)
      const shown = `${probe.label} ${probe.detail} ${probe.evidence ?? ""}`
      expect(shown).not.toContain(TOKEN)
      // Nor any run of it long enough to narrow a guess.
      expect(shown).not.toContain(TOKEN.slice(0, 6))
    }
  })
})
