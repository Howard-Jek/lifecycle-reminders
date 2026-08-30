/**
 * Is automatic sending actually running?
 *
 * TWO FACTS, not one, and conflating them is what this module exists to stop:
 *
 *   INTENT — `businesses.auto_send_enabled`, which the operator controls. Only
 *   this can say "off". A missing heartbeat cannot: silence is not a decision.
 *
 *   EVIDENCE — the last cycle the engine actually recorded. Only this can say
 *   "on and working". The flag cannot: the schedulers live OUTSIDE this app, in
 *   a GitHub Actions workflow, and GitHub disables scheduled workflows in
 *   dormant repositories without telling anyone.
 *
 * Which is why `stalled` is its own state and the most useful one here. Switched
 * on, and nothing running: the operator believes messages are going out and
 * they are not. Deriving state from the heartbeat alone reported that as
 * "paused", which reads like a choice somebody made.
 */

export type SendingStatus = {
  /**
   * `off`     — the operator has it switched off. Nothing will be sent.
   * `stalled` — switched ON, but no cycle has run recently. Something is wrong.
   * `live`    — switched on and running.
   */
  state: "off" | "stalled" | "live"
  /** True when nothing has ever run — a different thing to check from a
   * scheduler that has stopped. */
  neverRun: boolean
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
  /** `businesses.auto_send_enabled`. The only thing that can report "off". */
  autoSendEnabled: boolean,
  now: Date = new Date(),
): SendingStatus {
  const ran = lastRunAt ? new Date(lastRunAt) : null
  // An unparseable timestamp is not evidence that anything ran.
  const valid = ran && !Number.isNaN(ran.getTime()) ? ran : null
  const minutesSince = valid
    ? Math.max(0, Math.floor((now.getTime() - valid.getTime()) / 60000))
    : null

  // Checked FIRST. Off is a decision, and it holds whatever the heartbeat says
  // — including on a deployment where some other tenant's cycle is ticking
  // along and writing runs this business must not be credited with.
  if (!autoSendEnabled) {
    return { state: "off", neverRun: valid === null, lastRunAt: valid ? lastRunAt : null, minutesSince }
  }

  const fresh = minutesSince !== null && minutesSince <= STALE_AFTER_MINUTES
  return {
    state: fresh ? "live" : "stalled",
    neverRun: valid === null,
    lastRunAt: valid ? lastRunAt : null,
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
