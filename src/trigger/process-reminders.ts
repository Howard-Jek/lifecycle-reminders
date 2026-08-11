/**
 * Trigger.dev driver for the reminder cycle.
 *
 * Not wired up in the standalone — the Vercel cron route drives the same
 * function. It lives here so the integration path is proven rather than
 * asserted: dropping this add-on into GomaAI means deleting the route,
 * adding "process-reminders" to trigger.config.ts's dirs, and changing no
 * logic whatsoever.
 *
 * Requires `@trigger.dev/sdk` (a host dependency, deliberately not installed
 * here) — hence the type-only tolerance below.
 */

// @ts-expect-error — @trigger.dev/sdk is a host dependency, absent in the standalone.
import { schedules, logger } from "@trigger.dev/sdk"
import { createAdminClient } from "@/lib/supabase/admin"
import { runReminderCycle } from "@/lib/lifecycle/run-cycle"

export const processRemindersTask = schedules.task({
  id: "process-reminders",
  cron: "*/15 * * * *",
  maxDuration: 600,
  run: async () => {
    const result = await runReminderCycle(createAdminClient())
    logger.info("process-reminders done", result)
    return result
  },
})
