import type { NextConfig } from "next"

/**
 * Security headers.
 *
 * Before this, the live deployment sent exactly one: `strict-transport-security`
 * from Vercel. No CSP, no nosniff, no framing control.
 *
 * WHAT IS DELIBERATELY NOT HERE: a `script-src` policy. This app renders an
 * inline theme-boot script (src/app/layout.tsx:32) and Next.js inlines its own
 * bootstrap, so `script-src 'self'` would break the app outright and
 * `'unsafe-inline'` would be a policy permitting precisely the thing it claims
 * to stop. Doing it properly means generating a nonce per request in middleware
 * and threading it through both — a real change with a real chance of silently
 * breaking hydration. Worth doing; not worth doing carelessly.
 *
 * So this ships the directives that need no nonce and cannot break anything,
 * which are also the ones carrying most of the value:
 *
 *   frame-ancestors  clickjacking. The app has destructive one-click actions
 *                    behind a session cookie, which is what framing attacks
 *                    exist to reach.
 *   object-src       legacy plugin embedding, a classic XSS escalation.
 *   base-uri         a `<base>` injection silently re-points every relative
 *                    script and form on the page.
 *   form-action      stops an injected form POSTing off-origin.
 */
const CONTENT_SECURITY_POLICY = [
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ")

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  // Redundant with frame-ancestors on modern browsers, and still the only one
  // older browsers understand.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  /**
   * `no-referrer`, not the usual `strict-origin-when-cross-origin`, because
   * this app puts a bearer credential IN A URL: the ICS feed is
   * /api/calendar/<token>, where the unguessable path IS the authentication —
   * a calendar client cannot send headers. Any referrer leak of that URL hands
   * over unauthenticated, unexpiring read access to one member's client names
   * and dates. There is no analytics here to pay for the strictness.
   */
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  // X-XSS-Protection is deliberately absent: it is dead in modern browsers and
  // its legacy filter introduced vulnerabilities of its own.
]

const nextConfig: NextConfig = {
  // `x-powered-by: Next.js` on every response is free fingerprinting.
  poweredByHeader: false,

  experimental: {
    // Spreadsheets travel through a server action. The framework default of
    // 1 MB silently truncates them; the parser's own 10 MB cap (src/lib/import
    // /read-file.ts) is the real limit and it reports when it is hit.
    serverActions: { bodySizeLimit: "30mb" },
  },

  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }]
  },
}

export default nextConfig
