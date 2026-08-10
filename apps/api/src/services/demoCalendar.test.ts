/**
 * S596 — demo/sales iCalendar builders (pure; no DB, no IO).
 */

import { describe, it, expect } from 'vitest'
import { buildDemoBookingIcs, buildSalesFeedIcs, type DemoSlotRow } from './demoCalendar'

const NOW = new Date('2026-08-10T12:00:00Z')

describe('buildDemoBookingIcs (prospect single-event attachment)', () => {
  it('emits one 20-min VEVENT with the join link, CRLF-terminated', () => {
    const ics = buildDemoBookingIcs({
      slotId: 'abc', startsAt: '2026-08-11T20:00:00Z', durationMinutes: 20,
      meetingUrl: 'https://meet.jit.si/gam-demo-xyz', kind: 'demo', now: NOW,
    })
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).toContain('BEGIN:VEVENT')
    expect(ics).toContain('UID:demo-abc@gam.sales')
    expect(ics).toContain('DTSTART:20260811T200000Z')
    expect(ics).toContain('DTEND:20260811T202000Z') // +20 min
    expect(ics).toContain('LOCATION:https://meet.jit.si/gam-demo-xyz')
    expect(ics).toContain('URL:https://meet.jit.si/gam-demo-xyz')
    expect(ics.endsWith('\r\n')).toBe(true)
    expect(ics).toContain('\r\n') // CRLF joins
  })

  it('omits the location when there is no meeting url', () => {
    const ics = buildDemoBookingIcs({
      slotId: 'x', startsAt: '2026-08-11T20:00:00Z', durationMinutes: 20,
      meetingUrl: null, kind: 'demo', now: NOW,
    })
    expect(ics).not.toContain('LOCATION:')
  })
})

describe('buildSalesFeedIcs (owner subscribe feed)', () => {
  const base: DemoSlotRow = {
    id: 's1', starts_at: '2026-08-11T20:00:00Z', duration_minutes: 20, kind: 'demo',
    status: 'booked', meeting_url: 'https://meet.jit.si/gam-demo-1',
    prospect_name: 'Jane Doe', prospect_email: 'jane@x.com', prospect_phone: null,
    notes: 'rent collection', lead_portfolio_size: '51–150', lead_property_type: null,
    lead_metadata: { property_types: ['RV parks'], pain_points: ['Chasing rent'] },
  }

  it('names the calendar and packs the survey brief into DESCRIPTION', () => {
    const ics = buildSalesFeedIcs([base], NOW)
    expect(ics).toContain('X-WR-CALNAME:GAM Demos')
    expect(ics).toContain('SUMMARY:GAM Demo — Jane Doe')
    expect(ics).toContain('STATUS:CONFIRMED')
    // The DESCRIPTION is long → RFC 5545 line-folds it (CRLF + space). Unfold
    // before asserting content, exactly as any calendar client does.
    const unfolded = ics.replace(/\r\n /g, '')
    expect(unfolded).toContain('Manages: RV parks')
    expect(unfolded).toContain('Units (rough): 51–150')
    expect(unfolded).toContain('Pain points: Chasing rent')
    expect(unfolded).toContain('Join: https://meet.jit.si/gam-demo-1')
  })

  it('greys out cancelled/no-show as STATUS:CANCELLED', () => {
    const ics = buildSalesFeedIcs([{ ...base, status: 'cancelled' }], NOW)
    expect(ics).toContain('STATUS:CANCELLED')
  })

  it('escapes commas/semicolons in text per RFC 5545', () => {
    const ics = buildSalesFeedIcs([{ ...base, prospect_name: 'Doe, Jane; Co' }], NOW)
    expect(ics).toContain('SUMMARY:GAM Demo — Doe\\, Jane\\; Co')
  })
})
