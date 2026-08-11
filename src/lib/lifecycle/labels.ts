/**
 * Display helpers for lifecycle events.
 *
 * A standalone leaf module because the ICS route needs this too, and importing
 * it from src/trigger/process-reminders.ts would be a VALUE import of a
 * Trigger.dev task — every other app-side reference to @/trigger/* in this repo
 * is `import type` and therefore erased. A value import executes
 * schedules.task({...}) at module load and drags the Trigger SDK plus both AI
 * SDKs into the route bundle.
 */

/** 'policy_expiry' → 'Policy expiry'. */
export function humaniseEventType(eventType: string): string {
  const words = eventType.replace(/_/g, " ").trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
