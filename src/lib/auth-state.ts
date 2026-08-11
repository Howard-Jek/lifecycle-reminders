/**
 * The shape every auth form's `useActionState` carries.
 *
 * In its own module because a `"use server"` file may only export async
 * functions — a plain const alongside the actions is a build error, not a
 * style problem. The host app keeps `src/lib/plans/action-state.ts` for
 * exactly this reason.
 */
export type AuthState = { error: string | null }

export const NO_ERROR: AuthState = { error: null }
