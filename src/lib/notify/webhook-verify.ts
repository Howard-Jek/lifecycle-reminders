import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * The two independent secrets on Meta's webhook, which are constantly confused
 * for each other because Meta's own setup screen shows them side by side.
 *
 *   VERIFY TOKEN — a string you invent and type into the "Verify token" box.
 *     Used ONCE, on the GET handshake, and never again. It proves to Meta that
 *     whoever owns the callback URL also owns the dashboard.
 *
 *   APP SECRET — issued by Meta, on App Settings → Basic. Used on EVERY POST,
 *     as the key for the X-Hub-Signature-256 HMAC. It proves to us that a
 *     payload actually came from Meta.
 *
 * They are not interchangeable and the verify token is worthless for the second
 * job: it is a value we chose and typed into a web form, so it authenticates
 * nothing about an inbound POST. Getting this wrong is how a webhook ends up
 * accepting forged delivery receipts from anyone who can guess the URL — and
 * this endpoint's POST handler writes to `reminders`, so a forged payload could
 * mark real reminders failed.
 */

/** Constant-time string compare that tolerates unequal lengths. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  // timingSafeEqual THROWS on a length mismatch rather than returning false, so
  // the length check has to come first. It is not itself constant-time, which
  // leaks the length of the expected secret and nothing else.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export type VerificationOutcome =
  | { ok: true; challenge: string }
  | { ok: false; status: 403 | 503; reason: string }

/**
 * Meta's GET handshake.
 *
 * Meta calls the URL with hub.mode=subscribe, its own hub.challenge, and the
 * verify token you typed into the dashboard. Echo the challenge back verbatim,
 * as plain text, and the subscription goes live.
 *
 * The challenge is echoed rather than parsed on purpose — it is Meta's value,
 * we have no schema for it, and the endpoint returns it as text/plain so no
 * browser ever treats it as markup.
 */
export function verifySubscription(
  url: URL,
  expectedToken: string | undefined,
): VerificationOutcome {
  const token = expectedToken?.trim()
  if (!token) {
    // 503, not 403. "I have no configured token" and "your token is wrong" are
    // different operational problems, and answering 403 for the first sends
    // whoever is setting this up hunting for a typo in a value that was never
    // read.
    return { ok: false, status: 503, reason: "verify token not configured" }
  }

  const mode = url.searchParams.get("hub.mode")
  const provided = url.searchParams.get("hub.verify_token")
  const challenge = url.searchParams.get("hub.challenge")

  if (mode !== "subscribe" || provided === null || challenge === null) {
    return { ok: false, status: 403, reason: "not a subscription handshake" }
  }
  if (!safeEqual(provided, token)) {
    return { ok: false, status: 403, reason: "verify token mismatch" }
  }
  return { ok: true, challenge }
}

/**
 * Is this POST body genuinely from Meta?
 *
 * The HMAC is computed over the RAW bytes. Re-serialising the parsed JSON and
 * hashing that would fail intermittently and inexplicably — key order, unicode
 * escaping and whitespace all survive Meta's signature and none of them survive
 * a JSON.parse/stringify round trip.
 */
export function verifySignature(
  rawBody: string,
  header: string | null,
  appSecret: string | undefined,
): { ok: true } | { ok: false; status: 401 | 503; reason: string } {
  const secret = appSecret?.trim()
  if (!secret) {
    // Fails CLOSED. The alternative — accept unsigned payloads until the secret
    // is configured — is an open write endpoint, and "we will set it later" is
    // exactly how that becomes permanent.
    return { ok: false, status: 503, reason: "app secret not configured" }
  }
  // Case-folded once, so the prefix check and the digest compare agree. Meta
  // sends lowercase, but a header that differs only in case is not a forgery
  // and should not be rejected as one.
  const normalised = header?.trim().toLowerCase() ?? ""
  // Specifically sha256. Meta sends X-Hub-Signature (sha1) alongside this one,
  // and accepting whichever prefix turned up would let a caller downgrade to
  // the weaker digest by choosing it.
  if (!normalised.startsWith("sha256=")) {
    return { ok: false, status: 401, reason: "missing or malformed signature" }
  }

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
  if (!safeEqual(normalised.slice("sha256=".length), expected)) {
    return { ok: false, status: 401, reason: "signature mismatch" }
  }
  return { ok: true }
}
