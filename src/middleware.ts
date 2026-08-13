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
     */
    "/((?!_next/static|_next/image|favicon.ico|api/calendar|api/v1|api/cron|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
}
