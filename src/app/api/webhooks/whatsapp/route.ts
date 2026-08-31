import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { verifySubscription, verifySignature } from "@/lib/notify/webhook-verify"
import {
  parseWebhookBatch,
  buildSenderIndex,
  matchSender,
  type InboundMessage,
  type StatusEvent,
} from "@/lib/notify/webhook-events"
import {
  resolveFailedReceipt,
  RESOLVABLE_FROM_RECEIPT,
  type ReceiptOwner,
} from "@/lib/lifecycle/failed-receipt"

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
    const [failed, stored, recorded] = await Promise.all([
      recordFailedSends(admin, statuses, owners),
      storeInboundMessages(admin, messages),
      recordStatusEvents(admin, statuses, owners),
    ])
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

type ReceiptOwners = Map<string, ReceiptOwner & { businessId: string }>

/**
 * Who owns each wamid in this payload, read once for the whole handler.
 *
 * Throws rather than returning an empty map on a read error: with no owners
 * nothing can be attributed, so every failure in the payload would be silently
 * dropped and Meta would never mention them again. The caller turns this into
 * a 500, which asks Meta to redeliver — the right trade, since the reason is
 * the only explanation of the failure that will ever exist.
 */
async function loadReceiptOwners(admin: Admin, statuses: StatusEvent[]): Promise<ReceiptOwners> {
  if (statuses.length === 0) return new Map()

  const { data, error } = await admin
    .from("reminders")
    .select("id, business_id, status, whatsapp_message_id")
    .in(
      "whatsapp_message_id",
      statuses.map((s) => s.wamid),
    )

  if (error) throw new Error(`resolving receipt owners: ${error.message}`)

  return new Map(
    (data ?? []).map((r) => [
      r.whatsapp_message_id as string,
      { id: r.id as string, status: r.status as string, businessId: r.business_id as string },
    ]),
  )
}

/**
 * Close the loop on sends Meta later rejected.
 *
 * This is the gap the webhook actually fills. The Graph call that queues a
 * message returns 200 with a message id long before Meta knows whether it can
 * be delivered — an invalid number, a blocked recipient or an expired template
 * all fail AFTERWARDS. Without this, `reminders` says `sent` forever and
 * "Needs attention" stays empty while nobody receives anything.
 *
 * Only `failed` is acted on. `delivered` and `read` are real signals but there
 * is nowhere to put them, and adding columns to record a state no screen shows
 * would be storage for its own sake.
 *
 * The decision itself is resolveFailedReceipt, in src/lib/lifecycle — pure, so
 * every race it arbitrates is tested without a stub. This is the plumbing.
 */
async function recordFailedSends(
  admin: Admin,
  statuses: StatusEvent[],
  owners: ReceiptOwners,
): Promise<number> {
  let updated = 0

  for (const receipt of statuses) {
    const verdict = resolveFailedReceipt(receipt, owners.get(receipt.wamid) ?? null)

    if (verdict.action === "skip") {
      if (verdict.reason === "unowned") {
        // Kept as a warning, not an error. The receipt itself is safe in
        // whatsapp_status_events either way; this only says that no row could
        // be marked right now. See resolveFailedReceipt for why we do not
        // force a redelivery to chase it.
        console.warn(
          `[whatsapp-webhook] failure receipt for ${receipt.wamid} matched no reminder ` +
            `(sent outside the queue, or its wamid is not stamped yet): ` +
            `${receipt.error ?? "no reason given"}`,
        )
      } else if (verdict.reason === "already-resolved") {
        console.info(
          `[whatsapp-webhook] failure receipt for ${receipt.wamid} arrived after the row was ` +
            `resolved — leaving it alone`,
        )
      }
      continue
    }

    const { data, error } = await admin
      .from("reminders")
      .update({ status: "failed", error: verdict.error })
      .eq("id", verdict.reminderId)
      // Re-asserted at the write, not merely checked in the verdict above: the
      // row can move between the read and this update, and the whole point of
      // the predicate is that the later writer wins.
      .in("status", RESOLVABLE_FROM_RECEIPT)
      .select("id")

    if (error) throw new Error(`marking ${receipt.wamid} failed: ${error.message}`)

    updated += data?.length ?? 0
  }

  return updated
}

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


/**
 * Keep every receipt, not only the ones we act on.
 *
 * `sent`, `delivered` and `read` were previously parsed and dropped, on the
 * reasoning that no column and no screen wanted them. The cost of that showed
 * up the first time a message was accepted with a real id and never arrived:
 * nothing anywhere could say whether Meta had reported a thing. "No receipt
 * arrived" and "delivered, and we threw it away" looked identical, and the
 * difference was the whole diagnosis.
 *
 * Best-effort, and deliberately last: this is a record, and failing to write
 * one must never cost the caller the status update that ran beside it.
 */
async function recordStatusEvents(
  admin: Admin,
  statuses: StatusEvent[],
  owners: ReceiptOwners,
): Promise<number> {
  if (statuses.length === 0) return 0

  // Attribution comes from the shared lookup. A test send matches nothing and
  // is still worth keeping — that is precisely the case that was impossible to
  // see before. So is a failure whose wamid is not stamped yet: the row write
  // has to wait, the record does not.
  const { data, error } = await admin.from("whatsapp_status_events").insert(
    statuses.map((s) => {
      const owner = owners.get(s.wamid)
      return {
        wamid: s.wamid,
        status: s.status,
        error: s.error,
        recipient: s.recipient,
        reminder_id: owner?.id ?? null,
        business_id: owner?.businessId ?? null,
        occurred_at: s.occurredAt,
      }
    }),
  ).select("id")

  if (error) {
    console.error(`[whatsapp-webhook] could not record status events: ${error.message}`)
    return 0
  }
  return data?.length ?? 0
}