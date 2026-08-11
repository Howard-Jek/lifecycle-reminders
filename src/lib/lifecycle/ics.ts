/**
 * iCalendar (RFC 5545) serialisation for lifecycle events.
 *
 * v1 of the calendar is a subscribe-only ICS feed rather than a Google Calendar
 * OAuth integration: Google, Apple and Outlook all subscribe to an ICS URL
 * natively, it needs no OAuth or token refresh, and Postgres stays the single
 * source of truth with the calendar as a pure projection. Two-way sync is a
 * later step if subscribed feeds prove insufficient.
 *
 * Pure string building, no I/O — every escaping and folding rule below is a
 * place calendars silently reject a feed, so it is unit-tested directly.
 */

import { parseYmd, addDays } from "./occurrence"

export type IcsEvent = {
  /** Stable across regenerations — calendars key updates off this. */
  uid: string
  /** All-day date, YYYY-MM-DD. */
  date: string
  summary: string
  description?: string
  /** Yearly recurrence for birthdays and anniversaries. */
  yearly?: boolean
}

/**
 * RFC 5545 text escaping: backslash, semicolon, comma and newline are all
 * structural in ICS. A client name containing a comma ("Tan, Jane") would
 * otherwise split the field and corrupt the entry.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n")
}

/**
 * Fold lines at 75 octets per RFC 5545. Continuations start with a single
 * space. Folding counts BYTES, not characters — a name with non-ASCII
 * characters can exceed the octet limit while looking short, and some clients
 * reject the whole feed if a line runs over.
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= 75) return line

  const out: string[] = []
  let current = ""
  let currentBytes = 0
  // Iterate by code point so a multi-byte character is never split in half.
  for (const char of line) {
    const size = encoder.encode(char).length
    // 74 leaves room for the leading space on continuation lines.
    const limit = out.length === 0 ? 75 : 74
    if (currentBytes + size > limit) {
      out.push(current)
      current = char
      currentBytes = size
    } else {
      current += char
      currentBytes += size
    }
  }
  if (current) out.push(current)
  return out.map((seg, i) => (i === 0 ? seg : ` ${seg}`)).join("\r\n")
}

function ymdCompact(date: string): string {
  const { year, month, day } = parseYmd(date)
  return `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`
}

function stampUtc(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`
}

/**
 * Build a complete VCALENDAR.
 *
 * All-day events use DATE values with a DTEND of the following day, which is
 * RFC 5545's non-inclusive end — omitting it or setting it equal to DTSTART
 * makes several clients render a zero-length or missing entry.
 */
export function buildIcsFeed(input: {
  calendarName: string
  events: IcsEvent[]
  now: Date
}): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Goma//Lifecycle Reminders//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(input.calendarName)}`,
    // Hint to clients not to re-poll more than hourly; the data changes slowly.
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ]

  const dtstamp = stampUtc(input.now)

  for (const event of input.events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${ymdCompact(event.date)}`,
      `DTEND;VALUE=DATE:${ymdCompact(addDays(event.date, 1))}`,
      `SUMMARY:${escapeIcsText(event.summary)}`,
    )
    if (event.description) {
      lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`)
    }
    if (event.yearly) {
      lines.push("RRULE:FREQ=YEARLY")
    }
    lines.push("TRANSP:TRANSPARENT", "END:VEVENT")
  }

  lines.push("END:VCALENDAR")

  // CRLF throughout, per spec, with a trailing CRLF.
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`
}
