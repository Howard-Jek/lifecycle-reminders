import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { verifySubscription, verifySignature } from "@/lib/notify/webhook-verify"
import {
  parseWebhookBatch,
  buildSenderIndex,
  matchSender,
  type InboundMessage,
} from "@/lib/notify/webhook-events"
import {
  loadReceiptOwners,
  recordFailedSends,
  recordStatusEvents,
} from "@/lib/notify/reminder-receipts"

/**
 * Meta's callback URL for the platform WhatsApp number.
 *
 * Two unrelated jobs behind one path, because Meta insists on one path:
 *
 *   GET  — the one-time handshake that turns the subscription on.
 *   POST — every delivery receipt and every reply, forever after.
 *
 * NOTE FOR WHOEVER MOVES THIS: the path is registered in Meta's dashboard and
 * changing it silently stops delivery. Meta does not warn you, does not retry
 * to the new URL, and the only symptom is that failures stop being noticed —
 * which looks exactly like everything working.
 */

// node:crypto for the HMAC, so this must not be pushed to the edge runtime.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Meta's own timeout is ~20s; past it the payload is retried as undelivered. */
export const maxDuration = 30

export async function GET(request: Request) {
  const result = verifySubscription(new URL(request.url), process.env.GOMA_NOTIFY_VERIFY_TOKEN)

  if (!result.ok) {
    console.warn(`[whatsapp-webhook] verification refused: ${result.reason}`)
    // Plain text, and deliberately uninformative to the caller. Anyone can hit
    // this URL; only the logs get to know which of the two reasons it was.
    return new NextResponse("Forbidden", {
      status: result.status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  }

  console.info("[whatsapp-webhook] subscription verified")
  // text/plain, not JSON. Meta compares the body byte-for-byte against the
  // challenge it sent; NextResponse.json() would wrap it in quotes and the
  // handshake would fail with no explanation beyond "Callback URL error".
  return new NextResponse(result.challenge, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}

export async function POST(request: Request) {
  // .text(), before anything else touches the body. The signature covers the
  // raw bytes, and a Request body can only be read once.
  const rawBody = await request.text()

  const signature = verifySignature(
    rawBody,
    request.headers.get("x-hub-signature-256"),
    process.env.GOMA_NOTIFY_APP_SECRET,
  )
  if (!signature.ok) {
    console.warn(`[whatsapp-webhook] rejected: ${signature.reason}`)
    return NextResponse.json({ ok: false }, { status: signature.status })
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    // Signed but unparseable should be impossible. 200 regardless: a retry
    // would deliver the same bytes and fail the same way, and a webhook that
    // keeps answering non-2xx gets disabled by Meta.
    console.error("[whatsapp-webhook] signed payload was not valid JSON")
    return NextResponse.json({ ok: true, ignored: true })
  }

  // Scoped to OUR number, not merely to our Meta App — see parseWebhookBatch.
  const { statuses, messages, skipped } = parseWebhookBatch(payload, {
    phoneNumberId: process.env.GOMA_NOTIFY_PHONE_NUMBER_ID,
    wabaId: process.env.GOMA_NOTIFY_WABA_ID,
  })

  // A scope mismatch is either the guard doing its job or the guard eating
  // everything, and those look identical from the outside — silence. Logged and
  // returned so the difference is one curl away instead of a mystery.
  if (skipped.wabaMismatch > 0 || skipped.phoneMismatch > 0) {
    console.warn(
      `[whatsapp-webhook] ignored ${skipped.wabaMismatch} entr(ies) for another WABA and ` +
        `${skipped.phoneMismatch} change(s) for another number. If this is EVERY payload, ` +
        `GOMA_NOTIFY_WABA_ID / GOMA_NOTIFY_PHONE_NUMBER_ID do not match what Meta sends.`,
    )
  }

  try {
    const admin = createAdminClient()
    // Resolved ONCE and shared. Both writers below ask the same question — who
    // owns this wamid — and asking twice lets them answer it differently, which
    // is how a receipt gets logged against a reminder it was not applied to.
    const owners = await loadReceiptOwners(admin, statuses)
    // allSettled, not all: with `all` a second concurrent rejection is
    // discarded, so an operator fixes what the log named, redeploys, and hits
    // the other one with an identical 500 and nothing to say it had changed.
    const settled = await Promise.allSettled([
      recordFailedSends(admin, statuses, owners),
      storeInboundMessages(admin, messages),
      recordStatusEvents(admin, statuses, owners),
    ])
    const reasons = settled.flatMap((r) => (r.status === "rejected" ? [r.reason] : []))
    if (reasons.length > 0) {
      throw new AggregateError(reasons, reasons.map((r) => String(r)).join("; "))
    }
    const [failed, stored, recorded] = settled.map((r) =>
      r.status === "fulfilled" ? r.value : 0,
    ) as [number, number, number]
    return NextResponse.json({
      ok: true,
      statuses: statuses.length,
      failed,
      stored,
      recorded,
      skipped,
    })
  } catch (err) {
    // 500 so Meta RETRIES. The alternative — swallow it and answer 200 — loses
    // the payload permanently, because there is no way to ask Meta for it
    // again. The two writes that MATTER are idempotent: the reminder update is
    // scoped to statuses a receipt may overwrite, and inbound messages upsert
    // on wamid. The receipt log is not — a retry can leave a duplicate row in
    // whatsapp_status_events — and that is the accepted cost of not losing the
    // reason. It is an append-only record, read by wamid.
    console.error(
      `[whatsapp-webhook] processing failed, asking Meta to retry: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}

type Admin = ReturnType<typeof createAdminClient>


/**
 * Persist replies to the platform number.
 *
 * Attributed to a team member where the sending number is on a roster. When it
 * is not, the row is still written with a null business_id — see the migration
 * for why that case is the one worth keeping.
 */
async function storeInboundMessages(admin: Admin, messages: InboundMessage[]): Promise<number> {
  if (messages.length === 0) return 0

  /**
   * The WHOLE roster, deliberately not a filtered subset.
   *
   * The obvious version prefiltered in SQL with
   * `.in("whatsapp_number", [from, "+" + from])`. That is an EXACT STRING match,
   * while buildSenderIndex compares DIGITS — so a roster row stored as
   * "+65 9111 0022" was never fetched at all, and the mismatch was not merely a
   * missed attribution. It silently disarmed the ambiguity guard: when the same
   * number sits on two tenants and only one spelling matches the string list,
   * exactly one row comes back, the number LOOKS unambiguous, and the reply is
   * filed under that tenant — which is precisely the cross-tenant misfiling the
   * guard exists to prevent, reintroduced by the query in front of it.
   *
   * Matching in code is what makes the digit comparison authoritative. The cost
   * is a small scan: team_members is an attribution roster bounded by agent
   * headcount, not by clients or messages.
   */
  const ROSTER_CAP = 5000
  const { data: members, error: memberError } = await admin
    .from("team_members")
    .select("id, business_id, whatsapp_number")
    .limit(ROSTER_CAP)

  if (memberError) throw new Error(`resolving senders: ${memberError.message}`)

  // PostgREST truncates silently, and a truncated roster would quietly make a
  // duplicated number look unique again — the same failure by a different door.
  if ((members?.length ?? 0) >= ROSTER_CAP) {
    console.error(
      `[whatsapp-webhook] roster hit the ${ROSTER_CAP}-row cap — sender attribution may be ` +
        `incomplete and ambiguity undetected. Move this lookup to a normalised indexed column.`,
    )
  }

  const index = buildSenderIndex(members ?? [])

  const rows = messages.map((message) => {
    const { match, ambiguous } = matchSender(index, message.from)
    if (ambiguous) {
      // Not an error — the row is still stored, just unattributed. Logged
      // because somebody has to reconcile it by hand, and without a line here
      // there is nothing to tell them it happened.
      console.warn("[whatsapp-webhook] sender is on more than one roster — storing unattributed")
    }
    return {
      wamid: message.wamid,
      business_id: match?.business_id ?? null,
      team_member_id: match?.id ?? null,
      from_number: message.from,
      message_type: message.type,
      body: message.body,
      sent_at: message.sentAt,
    }
  })

  // ignoreDuplicates, keyed on the wamid unique constraint: Meta's delivery is
  // at-least-once, so the same reply arrives again whenever a response is slow.
  const { data, error } = await admin
    .from("whatsapp_inbound_messages")
    .upsert(rows, { onConflict: "wamid", ignoreDuplicates: true })
    .select("id")

  if (error) throw new Error(`storing inbound messages: ${error.message}`)
  return data?.length ?? 0
}
