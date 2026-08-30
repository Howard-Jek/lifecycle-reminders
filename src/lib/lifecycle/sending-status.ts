/**
 * Is automatic sending actually running?
 *
 * Derived from the last recorded cycle rather than from configuration. The
 * schedulers live outside this app — a GitHub Actions workflow and a Vercel
 * cron — and either can be switched off without anything here being told. A
 * flag would go stale the first time that happened; a timestamp written by the
 * cycle itself cannot.
 */

export type SendingStatus = {
  state: "never" | "paused" | "live"
  /** ISO of the last recorded run, or null. */
  lastRunAt: string | null
  /** Whole minutes since that run. Null when there has never been one. */
  minutesSince: number | null
}

/**
 * How long without a run before sending counts as stopped.
 *
 * The scheduler runs every 15 minutes, so 90 is six missed ticks — comfortably
 * past a slow run or a brief outage, well short of a working day.
 *
 * A deployment relying ONLY on the daily Vercel cron reads as paused here, and
 * that is deliberate rather than a false positive: a once-daily run cannot
 * serve three send windows. Measured on this data, it delivered the morning
 * window on time and left the afternoon one ~20 hours late, which is much
 * closer to "not running" than to "running".
 */
export const STALE_AFTER_MINUTES = 90

export function deriveSendingStatus(
  lastRunAt: string | null,
  now: Date = new Date(),
): SendingStatus {
  if (!lastRunAt) return { state: "never", lastRunAt: null, minutesSince: null }

  const ran = new Date(lastRunAt)
  if (Number.isNaN(ran.getTime())) {
    // An unparseable timestamp is not evidence that anything ran.
    return { state: "never", lastRunAt: null, minutesSince: null }
  }

  const minutesSince = Math.max(0, Math.floor((now.getTime() - ran.getTime()) / 60000))
  return {
    state: minutesSince > STALE_AFTER_MINUTES ? "paused" : "live",
    lastRunAt,
    minutesSince,
  }
}

/** "just now" · "14 minutes ago" · "3 hours ago" · "2 days ago". */
export function describeAge(minutes: number): string {
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? "" : "s"} ago`
}
