import type { CookieOptions } from "@supabase/ssr"

/**
 * How the session cookie is written, in one place.
 *
 * `@supabase/ssr` defaults to a cookie that is neither `HttpOnly` nor `Secure`,
 * because its browser client has to be able to read the session. Observed on
 * the live deployment before this existed:
 *
 *   sb-<ref>-auth-token=base64-eyJhY2Nlc3NfdG9rZW4i…; Path=/; SameSite=lax;
 *   Max-Age=34560000
 *
 * — no HttpOnly, no Secure, 400 days, and `document.cookie` returned the whole
 * thing. That value is an access token AND a refresh token, so any script that
 * ever runs on this origin could lift a durable session.
 *
 * `httpOnly` is free here, and only because nothing in this app reads the
 * session from the browser: `src/lib/supabase/client.ts` had zero importers and
 * was deleted alongside this file. Auth happens entirely in server actions. If
 * a browser client is ever reintroduced it will break loudly against this,
 * which is the correct outcome — it should be a decision, not a regression.
 *
 * `secure` is conditional so `http://localhost` still works in development; a
 * Secure cookie is dropped by the browser over plain HTTP, which would make
 * local sign-in fail in a way that looks like bad credentials.
 */
export const AUTH_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  // 30 days rather than the default 400. The refresh token rotates well inside
  // this, so the only thing a longer window buys is a longer replay window for
  // a stolen cookie.
  maxAge: 60 * 60 * 24 * 30,
}

/**
 * Merge with whatever the library asked for.
 *
 * Ours win: the library's defaults are the thing being corrected. Anything it
 * sets that we do not name — `domain`, say — is preserved.
 */
export function withAuthCookieOptions(options: CookieOptions | undefined): CookieOptions {
  return { ...options, ...AUTH_COOKIE_OPTIONS }
}
