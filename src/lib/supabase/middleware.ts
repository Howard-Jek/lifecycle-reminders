import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

/**
 * Refresh the auth cookie on every request and gate the app routes.
 *
 * Server components cannot write cookies, so without this the session silently
 * expires mid-session and every page starts redirecting to sign-in.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  // getUser(), never getSession(): only the former revalidates the JWT with
  // the auth server, and a cookie is attacker-supplied input.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname
  const isAuthRoute = path.startsWith("/signin") || path.startsWith("/signup")

  if (!user && !isAuthRoute) {
    const url = request.nextUrl.clone()
    url.pathname = "/signin"
    url.searchParams.set("next", path)
    return NextResponse.redirect(url)
  }

  if (user && isAuthRoute) {
    const url = request.nextUrl.clone()
    url.pathname = "/reminders"
    url.search = ""
    return NextResponse.redirect(url)
  }

  return response
}
