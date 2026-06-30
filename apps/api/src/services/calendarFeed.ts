/**
 * S511 — appointments → iCalendar (RFC 5545) feed.
 *
 * Powers the one-way calendar sync (walkthrough Business #7): GAM publishes a
 * private ICS feed that the owner subscribes to in Google / Apple / Outlook.
 * This module is pure string-building — no DB, no IO — so it's trivially
 * testable. The public route (publicBusinessCalendar.ts) fetches the rows and
 * hands them here.
 *
 * Deliberately minimal + spec-correct on the parts that matter for
 * interoperability: CRLF line endings, 75-octet line folding, text escaping,
 * UTC DTSTART/DTEND, stable UIDs, and STATUS/METHOD so cancellations propagate.
 */

import { humanizeServiceType } from '@gam/shared'

export interface CalendarFeedAppointment {
  id: string
  service_type: string
  scheduled_for: string | Date
  duration_minutes: number
  status: 'scheduled' | 'completed' | 'cancelled' | 'no_show'
  notes: string | null
  // Customer (joined)
  first_name: string | null
  last_name: string | null
  company_name: string | null
  street1: string | null
  city: string | null
  state: string | null
  zip: string | null
}

export interface CalendarFeedBusiness {
  id: string
  name: string
}

// RFC 5545 §3.3.11 — escape backslash, semicolon, comma, and newlines in TEXT.
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

// RFC 5545 §3.1 — fold lines longer than 75 octets; continuation lines start
// with a single space. We measure bytes (UTF-8) so multibyte chars don't break
// the limit. Simple and conservative.
function foldLine(line: string): string {
  const enc = new TextEncoder()
  if (enc.encode(line).length <= 75) return line
  const out: string[] = []
  let cur = ''
  let curBytes = 0
  for (const ch of line) {
    const chBytes = enc.encode(ch).length
    // Account for the leading space on continuation lines (limit 74 there).
    const limit = out.length === 0 ? 75 : 74
    if (curBytes + chBytes > limit) {
      out.push(cur)
      cur = ch
      curBytes = chBytes
    } else {
      cur += ch
      curBytes += chBytes
    }
  }
  if (cur) out.push(cur)
  return out.map((l, i) => (i === 0 ? l : ` ${l}`)).join('\r\n')
}

// → 20260622T143000Z
function formatUtc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  )
}

function customerLabel(a: CalendarFeedAppointment): string {
  if (a.company_name) return a.company_name
  const name = `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim()
  return name || 'Customer'
}

function locationLine(a: CalendarFeedAppointment): string {
  return [a.street1, a.city, a.state, a.zip].filter(Boolean).join(', ')
}

// Map GAM appointment status → iCalendar VEVENT STATUS. Cancelled/no-show both
// surface as CANCELLED so a subscriber's calendar greys/removes the event;
// scheduled → CONFIRMED; completed → CONFIRMED (it still happened).
function icalStatus(s: CalendarFeedAppointment['status']): 'CONFIRMED' | 'CANCELLED' {
  return s === 'cancelled' || s === 'no_show' ? 'CANCELLED' : 'CONFIRMED'
}

function buildEvent(
  a: CalendarFeedAppointment,
  business: CalendarFeedBusiness,
  dtstamp: string,
): string[] {
  const start = new Date(a.scheduled_for)
  const end = new Date(start.getTime() + a.duration_minutes * 60 * 1000)
  const summary = `${humanizeServiceType(a.service_type)} — ${customerLabel(a)}`
  const loc = locationLine(a)
  const lines = [
    'BEGIN:VEVENT',
    // Stable, globally-unique UID so updates replace (not duplicate) the event.
    `UID:appt-${a.id}@gam.business`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${formatUtc(start)}`,
    `DTEND:${formatUtc(end)}`,
    `SUMMARY:${escapeText(summary)}`,
    `STATUS:${icalStatus(a.status)}`,
    `ORGANIZER;CN=${escapeText(business.name)}:mailto:no-reply@gam.business`,
  ]
  if (loc) lines.push(`LOCATION:${escapeText(loc)}`)
  if (a.notes) lines.push(`DESCRIPTION:${escapeText(a.notes)}`)
  lines.push('END:VEVENT')
  return lines
}

/**
 * Build the full VCALENDAR document for a business's appointments.
 * `now` is injected so the output is deterministic in tests.
 */
export function buildAppointmentsIcs(
  business: CalendarFeedBusiness,
  appointments: CalendarFeedAppointment[],
  now: Date,
): string {
  const dtstamp = formatUtc(now)
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GAM//Business Appointments//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(`${business.name} — Appointments`)}`,
    'X-PUBLISHED-TTL:PT1H',
  ]
  for (const a of appointments) lines.push(...buildEvent(a, business, dtstamp))
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
