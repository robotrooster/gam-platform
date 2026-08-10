/**
 * S553 engine + S596 demo rules: slot generation from availability windows,
 * kind scoping, the 1h lead buffer, "window-started → no same-day" cutoff,
 * 20-min events, Jitsi room per booking, and race-safe booking (partial unique
 * index). Emails mocked; real test DB.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('./email', () => ({
  sendDemoBookingConfirmation: vi.fn().mockResolvedValue(null),
  sendDemoBookingHeadsUp: vi.fn().mockResolvedValue(null),
  sendSalesCallReminder: vi.fn().mockResolvedValue(null),
}))

import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { listAvailableSlots, bookSalesCall, groupSlotsByDay, formatSlotForHumans } from './salesCalls'
import { sendDemoBookingConfirmation, sendDemoBookingHeadsUp } from './email'

// Business-tz (America/Phoenix) YYYY-MM-DD for a given instant.
function phxDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

beforeEach(async () => {
  await cleanupAllSchema()
  vi.clearAllMocks()
  // one all-week demo window so every test day has slots regardless of weekday
  for (let wd = 0; wd <= 6; wd++) {
    await db.query(
      `INSERT INTO sales_call_availability (weekday, start_time, end_time, kind) VALUES ($1, '09:00', '16:00', 'demo')`,
      [wd])
  }
})

describe('listAvailableSlots', () => {
  it('offers 30-min-aligned slots, none inside the 1h lead buffer, sorted', async () => {
    const slots = await listAvailableSlots('demo')
    expect(slots.length).toBeGreaterThan(0)
    const soonest = new Date(slots[0]).getTime()
    expect(soonest).toBeGreaterThan(Date.now() + 60 * 60_000 - 1000)
    for (const iso of slots) expect(new Date(iso).getMinutes() % 30).toBe(0)
    const times = slots.map((s) => new Date(s).getTime())
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it('excludes booked starts (of any kind — one rep, one calendar)', async () => {
    const slots = await listAvailableSlots('demo')
    const target = slots[0]
    await db.query(
      `INSERT INTO sales_call_slots (starts_at, mode, kind, prospect_name, prospect_email)
       VALUES ($1, 'video', 'demo', 'Taken', 't@x.com')`, [target])
    const after = await listAvailableSlots('demo')
    expect(after).not.toContain(target)
    expect(after.length).toBe(slots.length - 1)
  })

  it('closes the whole day once a window has already started (no same-day)', async () => {
    // A window that "started" at 00:00 means today is already inside it → today
    // must yield no slots; the soonest slot lands tomorrow.
    await db.query(`DELETE FROM sales_call_availability`)
    for (let wd = 0; wd <= 6; wd++) {
      await db.query(
        `INSERT INTO sales_call_availability (weekday, start_time, end_time, kind) VALUES ($1, '00:00', '23:30', 'demo')`,
        [wd])
    }
    const slots = await listAvailableSlots('demo')
    const today = phxDate(new Date())
    for (const iso of slots) expect(phxDate(new Date(iso))).not.toBe(today)
  })

  it('is scoped by kind — a demo query never sees onboarding windows', async () => {
    await db.query(`DELETE FROM sales_call_availability`)
    for (let wd = 0; wd <= 6; wd++) {
      await db.query(
        `INSERT INTO sales_call_availability (weekday, start_time, end_time, kind) VALUES ($1, '09:00', '16:00', 'onboarding')`,
        [wd])
    }
    expect(await listAvailableSlots('demo')).toEqual([])
    expect((await listAvailableSlots('onboarding')).length).toBeGreaterThan(0)
  })

  it('returns nothing with no active windows', async () => {
    await db.query(`DELETE FROM sales_call_availability`)
    expect(await listAvailableSlots('demo')).toEqual([])
  })
})

describe('formatSlotForHumans', () => {
  const iso = '2026-08-11T20:00:00Z' // 20:00 UTC
  it('formats in the given timezone (prospect-local)', () => {
    expect(formatSlotForHumans(iso, 'America/New_York')).toContain('4:00') // EDT UTC-4
    expect(formatSlotForHumans(iso, 'America/Phoenix')).toContain('1:00')  // MST UTC-7
    expect(formatSlotForHumans(iso)).toContain('1:00')                     // default = Phoenix
  })
  it('falls back to Phoenix on an invalid timezone rather than throwing', () => {
    expect(formatSlotForHumans(iso, 'Not/AZone')).toContain('1:00')
  })
})

describe('groupSlotsByDay', () => {
  it('buckets slots into business-tz days', async () => {
    const slots = await listAvailableSlots('demo')
    const days = groupSlotsByDay(slots)
    expect(days.length).toBeGreaterThan(0)
    expect(days.reduce((n, d) => n + d.slots.length, 0)).toBe(slots.length)
    for (const d of days) {
      expect(d.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(d.slots.every((s) => typeof s.timeLabel === 'string')).toBe(true)
    }
  })
})

describe('bookSalesCall (demo)', () => {
  it('books a slot as a 20-min video demo with a Jitsi room, and emails prospect + owner', async () => {
    const [slot] = await listAvailableSlots('demo')
    const r = await bookSalesCall({
      startsAt: slot, name: 'Sam Rivera', email: 'sam@example.com',
      propertyTypes: ['RV or mobile-home parks'], unitRange: '51–150',
      painPoints: ['Chasing rent / late payments'], lookingFor: 'rent collection',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.meetingUrl).toMatch(/gam-demo-/)
    expect(sendDemoBookingConfirmation).toHaveBeenCalledTimes(1)
    expect(sendDemoBookingHeadsUp).toHaveBeenCalledTimes(1)
    const lead = (await db.query(`SELECT status, email, portfolio_size, metadata FROM sales_leads`)).rows[0]
    expect(lead).toMatchObject({ status: 'qualified', email: 'sam@example.com', portfolio_size: '51–150' })
    expect(lead.metadata.property_types).toEqual(['RV or mobile-home parks'])
    const call = (await db.query(`SELECT status, mode, kind, duration_minutes, meeting_url FROM sales_call_slots`)).rows[0]
    expect(call).toMatchObject({ status: 'booked', mode: 'video', kind: 'demo', duration_minutes: 20 })
    expect(call.meeting_url).toMatch(/gam-demo-/)
  })

  it('stores the prospect timezone for prospect-local emails', async () => {
    const [slot] = await listAvailableSlots('demo')
    const r = await bookSalesCall({ startsAt: slot, name: 'Ann', email: 'ann@x.com', timezone: 'America/New_York' })
    expect(r.ok).toBe(true)
    const row = (await db.query(`SELECT prospect_timezone FROM sales_call_slots`)).rows[0]
    expect(row.prospect_timezone).toBe('America/New_York')
  })

  it('links an existing lead by conversation id instead of duplicating', async () => {
    const conv = '11111111-1111-4111-8111-111111111111'
    await db.query(
      `INSERT INTO sales_leads (conversation_id, name, email, status) VALUES ($1, 'Sam', 'sam@example.com', 'new')`,
      [conv])
    const [slot] = await listAvailableSlots('demo')
    const r = await bookSalesCall({
      startsAt: slot, name: 'Sam', email: 'sam@example.com', phone: '5551234', conversationId: conv,
    })
    expect(r.ok).toBe(true)
    const leads = await db.query(`SELECT status FROM sales_leads`)
    expect(leads.rows).toHaveLength(1)
    expect(leads.rows[0].status).toBe('qualified') // new → qualified on booking
  })

  it('refuses a slot that was just taken, and a time that was never offered', async () => {
    const [slot] = await listAvailableSlots('demo')
    expect((await bookSalesCall({ startsAt: slot, name: 'A', email: 'a@x.com' })).ok).toBe(true)
    const again = await bookSalesCall({ startsAt: slot, name: 'B', email: 'b@x.com' })
    expect(again.ok).toBe(false)
    const never = await bookSalesCall({ startsAt: '2020-01-01T03:07:00Z', name: 'C', email: 'c@x.com' })
    expect(never.ok).toBe(false)
  })
})
