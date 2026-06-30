/**
 * S511 — buildAppointmentsIcs unit tests (pure; no DB).
 */
import { describe, it, expect } from 'vitest'
import {
  buildAppointmentsIcs,
  type CalendarFeedAppointment,
  type CalendarFeedBusiness,
} from './calendarFeed'

const business: CalendarFeedBusiness = { id: 'b1', name: 'Acme Hauling' }
const NOW = new Date('2026-06-22T10:00:00Z')

const appt = (over: Partial<CalendarFeedAppointment> = {}): CalendarFeedAppointment => ({
  id: 'a1',
  service_type: 'Weekly trash pickup',
  scheduled_for: '2026-06-23T14:30:00Z',
  duration_minutes: 30,
  status: 'scheduled',
  notes: null,
  first_name: 'Jane',
  last_name: 'Doe',
  company_name: null,
  street1: '100 Elm',
  city: 'Mesa',
  state: 'AZ',
  zip: '85201',
  ...over,
})

describe('buildAppointmentsIcs', () => {
  it('wraps events in a VCALENDAR with CRLF endings and a trailing newline', () => {
    const ics = buildAppointmentsIcs(business, [appt()], NOW)
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(ics).toContain('VERSION:2.0')
    expect(ics).toContain('PRODID:-//GAM//Business Appointments//EN')
    expect(ics).toContain('METHOD:PUBLISH')
  })

  it('emits DTSTART in UTC and DTEND = start + duration', () => {
    const ics = buildAppointmentsIcs(business, [appt({ duration_minutes: 90 })], NOW)
    expect(ics).toContain('DTSTART:20260623T143000Z')
    expect(ics).toContain('DTEND:20260623T160000Z') // +90m
  })

  it('summary combines service + customer; LOCATION from address', () => {
    const ics = buildAppointmentsIcs(business, [appt()], NOW)
    expect(ics).toContain('SUMMARY:Weekly trash pickup — Jane Doe')
    expect(ics).toContain('LOCATION:100 Elm\\, Mesa\\, AZ\\, 85201')
  })

  it('prefers company name for the customer label', () => {
    const ics = buildAppointmentsIcs(business, [appt({ company_name: 'Mesa Diner' })], NOW)
    expect(ics).toContain('SUMMARY:Weekly trash pickup — Mesa Diner')
  })

  it('stable UID per appointment id', () => {
    const ics = buildAppointmentsIcs(business, [appt({ id: 'xyz' })], NOW)
    expect(ics).toContain('UID:appt-xyz@gam.business')
  })

  it('cancelled / no_show → STATUS:CANCELLED; scheduled/completed → CONFIRMED', () => {
    expect(buildAppointmentsIcs(business, [appt({ status: 'cancelled' })], NOW))
      .toContain('STATUS:CANCELLED')
    expect(buildAppointmentsIcs(business, [appt({ status: 'no_show' })], NOW))
      .toContain('STATUS:CANCELLED')
    expect(buildAppointmentsIcs(business, [appt({ status: 'completed' })], NOW))
      .toContain('STATUS:CONFIRMED')
  })

  it('escapes commas, semicolons, backslashes and newlines in text', () => {
    const ics = buildAppointmentsIcs(business,
      [appt({ notes: 'Gate code 1;2, side\\back\nring bell' })], NOW)
    expect(ics).toContain('DESCRIPTION:Gate code 1\\;2\\, side\\\\back\\nring bell')
  })

  it('omits LOCATION/DESCRIPTION when address + notes are absent', () => {
    const ics = buildAppointmentsIcs(business,
      [appt({ street1: null, city: null, state: null, zip: null, notes: null })], NOW)
    expect(ics).not.toContain('LOCATION:')
    expect(ics).not.toContain('DESCRIPTION:')
  })

  it('folds lines longer than 75 octets with a leading-space continuation', () => {
    const long = 'X'.repeat(200)
    const ics = buildAppointmentsIcs(business, [appt({ service_type: long })], NOW)
    const summaryLine = ics.split('\r\n').find(l => l.startsWith('SUMMARY:'))!
    expect(new TextEncoder().encode(summaryLine).length).toBeLessThanOrEqual(75)
    // A continuation line (leading space) must exist.
    expect(ics.split('\r\n').some(l => l.startsWith(' '))).toBe(true)
  })

  it('renders one VEVENT per appointment', () => {
    const ics = buildAppointmentsIcs(business,
      [appt({ id: 'a1' }), appt({ id: 'a2' }), appt({ id: 'a3' })], NOW)
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(3)
    expect(ics.match(/END:VEVENT/g)?.length).toBe(3)
  })

  it('empty appointment list yields a valid empty calendar', () => {
    const ics = buildAppointmentsIcs(business, [], NOW)
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).toContain('END:VCALENDAR')
    expect(ics).not.toContain('BEGIN:VEVENT')
  })
})
