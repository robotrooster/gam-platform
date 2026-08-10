/**
 * Sales/demo booking → iCalendar (S596).
 *
 * Two producers, one escaping/folding core (lib/ics.ts):
 *   - buildSalesFeedIcs()      → the private subscribe feed the owner adds
 *                                once; every booking then auto-appears.
 *   - buildDemoBookingIcs()    → the single VEVENT attached to the prospect's
 *                                confirmation email (adds the one call to their
 *                                calendar on open).
 *
 * The feed carries the survey brief in each event's DESCRIPTION and the Jitsi
 * room as LOCATION/URL, so the owner walks into every call already prepped and
 * one tap from joining.
 */

import { escapeIcsText, formatIcsUtc, assembleVcalendar } from '../lib/ics'

export interface DemoSlotRow {
  id: string
  starts_at: string | Date
  duration_minutes: number
  kind: string
  status: 'booked' | 'completed' | 'cancelled' | 'no_show'
  meeting_url: string | null
  prospect_name: string | null
  prospect_email: string | null
  prospect_phone: string | null
  notes: string | null
  // lead (joined)
  lead_portfolio_size?: string | null
  lead_property_type?: string | null
  lead_metadata?: Record<string, unknown> | null
}

function kindLabel(kind: string): string {
  return kind === 'onboarding' ? 'GAM Onboarding' : 'GAM Demo'
}

function endOf(row: { starts_at: string | Date; duration_minutes: number }): Date {
  const start = new Date(row.starts_at)
  return new Date(start.getTime() + (row.duration_minutes || 20) * 60_000)
}

// booked/completed → CONFIRMED; cancelled/no_show → CANCELLED (so a subscriber's
// calendar greys/removes the event).
function icalStatus(s: DemoSlotRow['status']): 'CONFIRMED' | 'CANCELLED' {
  return s === 'cancelled' || s === 'no_show' ? 'CANCELLED' : 'CONFIRMED'
}

/** The owner-facing pre-call brief packed into the event DESCRIPTION. */
function briefFor(row: DemoSlotRow): string {
  const meta = row.lead_metadata ?? {}
  const asArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  const types = asArr(meta.property_types)
  const propertyTypes = types.length ? types.join(', ') : (row.lead_property_type ?? '')
  const units = (typeof meta.unit_range === 'string' && meta.unit_range) || row.lead_portfolio_size || ''
  const pains = asArr(meta.pain_points)
  const contact = [row.prospect_email, row.prospect_phone].filter(Boolean).join(' · ')

  const lines: string[] = []
  if (contact) lines.push(`Contact: ${contact}`)
  if (propertyTypes) lines.push(`Manages: ${propertyTypes}`)
  if (units) lines.push(`Units (rough): ${units}`)
  if (pains.length) lines.push(`Pain points: ${pains.join(', ')}`)
  if (row.notes) lines.push(`In their words: ${row.notes}`)
  if (row.meeting_url) lines.push(`Join: ${row.meeting_url}`)
  return lines.join('\n')
}

function feedEvent(row: DemoSlotRow, dtstamp: string): string[] {
  const summaryName = row.prospect_name || row.prospect_email || 'Prospect'
  const lines = [
    'BEGIN:VEVENT',
    // Stable UID so updates replace (not duplicate) the event.
    `UID:demo-${row.id}@gam.sales`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${formatIcsUtc(new Date(row.starts_at))}`,
    `DTEND:${formatIcsUtc(endOf(row))}`,
    `SUMMARY:${escapeIcsText(`${kindLabel(row.kind)} — ${summaryName}`)}`,
    `STATUS:${icalStatus(row.status)}`,
    'ORGANIZER;CN=Gold Asset Management:mailto:no-reply@goldassetmanagement.com',
  ]
  if (row.meeting_url) {
    lines.push(`LOCATION:${escapeIcsText(row.meeting_url)}`)
    lines.push(`URL:${escapeIcsText(row.meeting_url)}`)
  }
  const brief = briefFor(row)
  if (brief) lines.push(`DESCRIPTION:${escapeIcsText(brief)}`)
  lines.push('END:VEVENT')
  return lines
}

/** Free/busy variant for a shared subscriber (spouse / assistant): the call's
 *  time block only — no prospect name, contact, survey brief, or join link, so
 *  their device never sees a prospect's personal data. */
function busyFeedEvent(row: DemoSlotRow, dtstamp: string): string[] {
  return [
    'BEGIN:VEVENT',
    // Distinct UID namespace so it can't collide with the full-detail event.
    `UID:demo-${row.id}-busy@gam.sales`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${formatIcsUtc(new Date(row.starts_at))}`,
    `DTEND:${formatIcsUtc(endOf(row))}`,
    `SUMMARY:${escapeIcsText(`Busy — ${kindLabel(row.kind)}`)}`,
    `STATUS:${icalStatus(row.status)}`,
    'TRANSP:OPAQUE',
    'END:VEVENT',
  ]
}

/**
 * The owner's private subscribe feed. `now` injected for deterministic tests.
 * scope 'full' = every prospect detail (owner's own link); scope 'busy' = time
 * blocks only, prospect data stripped (the shareable family/assistant link).
 */
export function buildSalesFeedIcs(rows: DemoSlotRow[], now: Date, scope: 'full' | 'busy' = 'full'): string {
  const dtstamp = formatIcsUtc(now)
  const build = scope === 'busy' ? busyFeedEvent : feedEvent
  return assembleVcalendar(
    [
      'VERSION:2.0',
      'PRODID:-//GAM//Sales Demos//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${escapeIcsText(scope === 'busy' ? 'GAM Schedule' : 'GAM Demos')}`,
      'X-PUBLISHED-TTL:PT15M',
    ],
    rows.map((r) => build(r, dtstamp)),
  )
}

/**
 * The single VEVENT attached to the prospect's confirmation email. Prospect
 * POV: no survey brief, just the call + how to join.
 */
export function buildDemoBookingIcs(input: {
  slotId: string
  startsAt: string | Date
  durationMinutes: number
  meetingUrl: string | null
  kind: string
  now: Date
}): string {
  const dtstamp = formatIcsUtc(input.now)
  const start = new Date(input.startsAt)
  const end = new Date(start.getTime() + (input.durationMinutes || 20) * 60_000)
  const descParts = [
    `Your ${input.durationMinutes || 20}-minute demo with Gold Asset Management.`,
  ]
  if (input.meetingUrl) descParts.push(`Join here: ${input.meetingUrl}`)
  const event = [
    'BEGIN:VEVENT',
    `UID:demo-${input.slotId}@gam.sales`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${formatIcsUtc(start)}`,
    `DTEND:${formatIcsUtc(end)}`,
    `SUMMARY:${escapeIcsText(`${kindLabel(input.kind)} with Gold Asset Management`)}`,
    'STATUS:CONFIRMED',
    'ORGANIZER;CN=Gold Asset Management:mailto:no-reply@goldassetmanagement.com',
  ]
  if (input.meetingUrl) {
    event.push(`LOCATION:${escapeIcsText(input.meetingUrl)}`)
    event.push(`URL:${escapeIcsText(input.meetingUrl)}`)
  }
  event.push(`DESCRIPTION:${escapeIcsText(descParts.join('\n'))}`)
  event.push('END:VEVENT')
  return assembleVcalendar(
    [
      'VERSION:2.0',
      'PRODID:-//GAM//Sales Demos//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
    ],
    [event],
  )
}
