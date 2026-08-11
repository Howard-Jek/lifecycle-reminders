import { describe, it, expect } from "vitest"
import { isProductionRuntime, isDryRun, assertEnv, appPublicUrl } from "@/lib/env"

/** A complete, valid environment. Individual tests break one thing at a time. */
const VALID = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  APP_PUBLIC_URL: "https://lifecycle.example.com",
  CRON_SECRET: "secret",
  NODE_ENV: "development",
} as NodeJS.ProcessEnv

describe("isProductionRuntime", () => {
  it("trusts VERCEL_ENV over NODE_ENV when both are present", () => {
    // A Vercel PREVIEW deploy has NODE_ENV=production, which is exactly why
    // VERCEL_ENV must win.
    expect(isProductionRuntime({ VERCEL_ENV: "preview", NODE_ENV: "production" })).toBe(false)
    expect(isProductionRuntime({ VERCEL_ENV: "production", NODE_ENV: "development" })).toBe(true)
  })

  it("falls back to NODE_ENV when VERCEL_ENV is absent", () => {
    expect(isProductionRuntime({ NODE_ENV: "development" })).toBe(false)
    expect(isProductionRuntime({ NODE_ENV: "test" })).toBe(false)
    expect(isProductionRuntime({ NODE_ENV: "production" })).toBe(true)
  })

  it("FAILS CLOSED when neither variable is set", () => {
    // The regression this exists for: the host's equivalent helper returns
    // false here, and a bare worker process — the one that owns every outbound
    // send — is precisely where neither var is guaranteed.
    expect(isProductionRuntime({})).toBe(true)
    expect(isProductionRuntime({ NODE_ENV: "" })).toBe(true)
  })
})

describe("isDryRun", () => {
  it("accepts 1 and true, and nothing else", () => {
    expect(isDryRun({ REMINDER_DRY_RUN: "1" })).toBe(true)
    expect(isDryRun({ REMINDER_DRY_RUN: "true" })).toBe(true)
    expect(isDryRun({ REMINDER_DRY_RUN: "TRUE" })).toBe(true)
    expect(isDryRun({ REMINDER_DRY_RUN: "0" })).toBe(false)
    expect(isDryRun({ REMINDER_DRY_RUN: "" })).toBe(false)
    expect(isDryRun({})).toBe(false)
  })
})

describe("assertEnv", () => {
  it("passes on a complete environment", () => {
    expect(() => assertEnv(VALID)).not.toThrow()
  })

  it("names the variable that is missing", () => {
    const rest = { ...VALID }
    delete rest.SUPABASE_SERVICE_ROLE_KEY
    expect(() => assertEnv(rest)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/)
  })

  it("names every missing variable at once, not just the first", () => {
    // Reporting one at a time turns a fresh deploy into five round-trips.
    expect(() => assertEnv({ NODE_ENV: "development" })).toThrow(/NEXT_PUBLIC_SUPABASE_URL/)
    expect(() => assertEnv({ NODE_ENV: "development" })).toThrow(/CRON_SECRET/)
  })

  it("rejects a relative APP_PUBLIC_URL", () => {
    // The failure this prevents: APP_PUBLIC_URL becomes the deep link inside
    // every reminder, and a wrong value produces a message that looks fine and
    // links nowhere.
    expect(() => assertEnv({ ...VALID, APP_PUBLIC_URL: "/app" })).toThrow(/absolute URL/)
  })

  it("rejects a non-http scheme", () => {
    expect(() => assertEnv({ ...VALID, APP_PUBLIC_URL: "ftp://example.com" })).toThrow(
      /http or https/,
    )
  })

  it("refuses to boot with the dry-run flag in production", () => {
    expect(() =>
      assertEnv({ ...VALID, NODE_ENV: "production", REMINDER_DRY_RUN: "1" }),
    ).toThrow(/REMINDER_DRY_RUN/)
  })

  it("allows the dry-run flag outside production", () => {
    expect(() => assertEnv({ ...VALID, REMINDER_DRY_RUN: "1" })).not.toThrow()
  })
})

describe("appPublicUrl", () => {
  it("strips trailing slashes so deep links never double up", () => {
    expect(appPublicUrl({ APP_PUBLIC_URL: "https://example.com/" })).toBe("https://example.com")
    expect(appPublicUrl({ APP_PUBLIC_URL: "https://example.com///" })).toBe("https://example.com")
    expect(appPublicUrl({ APP_PUBLIC_URL: "https://example.com" })).toBe("https://example.com")
  })
})
