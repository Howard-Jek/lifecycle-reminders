import { NextResponse } from "next/server"
import { timingSafeEqual } from "node:crypto"
import { createAdminClient } from "@/lib/supabase/admin"
import { runReminderCycle } from "@/lib/lifecycle/run-cycle"

/**
 * The scheduler's entry point.
 *
 * All the logic lives in runReminderCycle, which imports nothing about how it
 * was triggered. This route is one of three drivers — the others are
 * src/trigger/process-reminders.ts (for the host's Trigger.dev worker) and
 * scripts/tick.ts (for a local run) — and swapping between them changes no
 * behaviour at all.
 */

export const dynamic = "force-dynamic"
// The delivery budget inside the cycle is 4 minutes, sized to finish well
// within this. Vercel enforces the ceiling per plan tier; on Hobby, point an
// external scheduler at this same route instead.
export const maxDuration = 300

/** Constant-time compare, so a wrong secret leaks nothing through timing. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    // Refuse rather than run unauthenticated: this endpoint spends money (a
    // model call per reminder) and sends WhatsApp messages.
    console.error("[cron] CRON_SECRET is not set — refusing to run")
    return NextResponse.json({ error: "not configured" }, { status: 503 })
  }

  const header = request.headers.get("authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  if (!token || !secretMatches(token, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  try {
    const result = await runReminderCycle(createAdminClient())
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[cron] reminder cycle threw:", message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

// Vercel Cron issues GET. Same guard, same work.
export const GET = POST
