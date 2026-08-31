/**
 * The pack for the request being served.
 *
 * A one-function indirection with a real job: it is the ONLY place a vertical
 * turns into a pack, so the dev-only vertical switcher can be added — and
 * deleted at integration — by editing one file rather than every page.
 *
 * Async even though it does no I/O today, for the same reason: the switcher
 * reads a cookie, and a signature that changes later would touch every caller.
 *
 * The vertical is passed in rather than fetched. Every page that needs a pack
 * already reads a `businesses` row for the timezone, so `vertical` rides along
 * on a query that was happening anyway and this costs no round trip.
 */

import { packForVertical, type VerticalPack } from "./vertical-packs"

export async function currentPack(vertical: string | null | undefined): Promise<VerticalPack> {
  return packForVertical(vertical)
}
