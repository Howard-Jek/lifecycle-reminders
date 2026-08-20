import type { NextRequest } from "next/server"
import { updateSession } from "@/lib/supabase/middleware"

export async function middleware(request: NextRequest) {
  return updateSession(request)
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and the two unauthenticated API
     * surfaces, which carry their own bearer credentials:
     *   /api/calendar/<token>  — an ICS feed; calendar clients send no cookies
     *   /api/v1/*              — token-authed ingest
     *   /api/cron/*            — CRON_SECRET
     *   /api/health            — names missing config; must work when nothing else does
     *   /api/webhooks/*        — Meta signs with X-Hub-Signature-256
     *
     * The webhook exclusion is not an optimisation. Meta's verification GET
     * carries no cookies, so without it the handshake receives 307 -> /signin
     * and the dashboard reports only "The callback URL or verify token
     * couldn't be validated" — with the URL and token both perfectly correct.
     */
    "/((?!_next/static|_next/image|favicon.ico|api/calendar|api/v1|api/cron|api/health|api/webhooks|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
}
