"use server"

/**
 * A local-only override of which industry the app thinks this business is in.
 *
 * WHAT THIS IS FOR: there are twelve reminder packs and one way to look at
 * them, which is to be a business in that industry. Changing the column by hand
 * between every check is slow enough that packs would go unlooked-at, and a
 * pack nobody has seen is a pack nobody has proof-read.
 *
 * WHAT IT IS NOT: an operator feature. An operator's industry is a real fact
 * about them, collected at onboarding and stored on the business; it is not a
 * view toggle. So this never ships — see the three gates below.
 *
 * DELETED AT INTEGRATION, along with src/components/dev/. currentPack loses one
 * import and one `??`, which is the whole cost of having had it.
 */

import { cookies } from "next/headers"
import { isProductionRuntime } from "@/lib/env"
import { isVertical, type Vertical } from "@/lib/lifecycle/verticals"
// Imported, not declared here: a "use server" module may export only async
// functions, and one const export voids the entire module. See that file.
import { DEV_VERTICAL_COOKIE } from "./vertical-cookie"

/**
 * THREE gates, not one, and each closes a different door.
 *
 * A render-time check alone is not a gate: every export of a `"use server"`
 * module is a public POST endpoint, reachable by anyone who can guess it,
 * whether or not anything renders a form for it. And a cookie is client-owned,
 * so a value planted by hand must do nothing even if the write is unreachable.
 *
 * isProductionRuntime fails CLOSED — anything not explicitly `development` or
 * `test` is production, including a worker with no NODE_ENV at all — so the
 * safe answer is the default in all three places.
 */

/** The override in force for this request, or null. Gate: READ. */
export async function devVerticalOverride(): Promise<Vertical | null> {
  if (isProductionRuntime()) return null
  const value = (await cookies()).get(DEV_VERTICAL_COOKIE)?.value
  return isVertical(value) ? value : null
}

/** Set or clear the override. Gate: WRITE. */
export async function setDevVertical(vertical: string | null): Promise<void> {
  if (isProductionRuntime()) return

  const jar = await cookies()
  if (vertical === null || vertical === "") {
    jar.delete(DEV_VERTICAL_COOKIE)
    return
  }

  // Validated against the same list the database constrains, so a hand-crafted
  // POST can only ever name a pack that exists.
  if (!isVertical(vertical)) return

  jar.set(DEV_VERTICAL_COOKIE, vertical, {
    // Nothing client-side reads this — the server component passes the current
    // value down as a plain string — so there is no reason for script to see it.
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  })
}
