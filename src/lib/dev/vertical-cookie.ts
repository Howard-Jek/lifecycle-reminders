/**
 * The cookie name, in a plain module rather than beside the actions that use it.
 *
 * NOT a stylistic split. A `"use server"` module may export only async
 * functions — Next treats every export as a callable server action — and a
 * single non-async export makes the whole module resolve to NOTHING. The
 * failure is silent in typecheck and in vitest, because both resolve the file
 * normally; it appears only at build, as "the module has no exports at all",
 * and it would take the switcher, the layout and every page importing
 * currentPack down with it.
 */
export const DEV_VERTICAL_COOKIE = "lifecycle_dev_vertical"
