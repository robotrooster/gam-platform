/**
 * S553 — sales-call scheduling: slot generation from availability windows
 * and race-safe booking (partial unique index). Emails mocked; real test DB.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('./email', () => ({
  sendSalesCallConfirmation: vi.fn().mockResolvedValue(null),
  sendSalesCallReminder: vi.fn().mockResolvedValue(null),
}))

import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { listAvailableSlots, bookSalesCall } from './salesCalls'
import { sendSalesCallConfirmation } from './email'

beforeEach(async () => {
  await cleanupAllSchema()
  vi.clearAllMocks()
  // one all-week window so every test day has slots regardless of weekday
  for (let wd = 0; wd <= 6; wd++) {
    await db.query(
      `INSERT INTO sales_call_availability (weekday, start_time, end_time) VALUES ($1, '09:00', '16:00')`,
      [wd])
  }
})

describe('listAvailableSlots', () => {
  it('offers 30-min-aligned slots, none inside the 2h notice window', async () => {
    const slots = await listAvailableSlots()
    expect(slots.length).toBeGreaterThan(0)
    const soonest = new Date(slots[0]).getTime()
    expect(soonest).toBeGreaterThan(Date.now() + 2 * 3600_000 - 1000)
    for (const iso of slots) {
      expect(new Date(iso).getMinutes() % 30).toBe(0)
    }
    // sorted ascending
    const times = slots.map((s) => new Date(s).getTime())
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it('excludes booked starts', async () => {
    const slots = await listAvailableSlots()
    const target = slots[0]
    await db.query(
      `INSERT INTO sales_call_slots (starts_at, mode, prospect_name, prospect_email)
       VALUES ($1, 'video', 'Taken', 't@x.com')`, [target])
    const after = await listAvailableSlots()
    expect(after).not.toContain(target)
    expect(after.length).toBe(slots.length - 1)
  })

  it('returns nothing with no active windows', async () => {
    await db.query(`DELETE FROM sales_call_availability`)
    expect(await listAvailableSlots()).toEqual([])
  })
})

describe('bookSalesCall', () => {
  it('books an offered slot, creates a qualified lead, and emails the confirmation', async () => {
    const [slot] = await listAvailableSlots()
    const r = await bookSalesCall({
      startsAt: slot, mode: 'video', name: 'Sam Rivera', email: 'sam@example.com',
    })
    expect(r.ok).toBe(true)
    expect(sendSalesCallConfirmation).toHaveBeenCalledTimes(1)
    const lead = (await db.query(`SELECT status, email FROM sales_leads`)).rows[0]
    expect(lead).toMatchObject({ status: 'qualified', email: 'sam@example.com' })
    const call = (await db.query(`SELECT status, mode FROM sales_call_slots`)).rows[0]
    expect(call).toMatchObject({ status: 'booked', mode: 'video' })
  })

  it('links an existing lead by conversation id instead of duplicating', async () => {
    const conv = '11111111-1111-4111-8111-111111111111'
    await db.query(
      `INSERT INTO sales_leads (conversation_id, name, email, status) VALUES ($1, 'Sam', 'sam@example.com', 'new')`,
      [conv])
    const [slot] = await listAvailableSlots()
    const r = await bookSalesCall({
      startsAt: slot, mode: 'phone', name: 'Sam', email: 'sam@example.com', phone: '5551234', conversationId: conv,
    })
    expect(r.ok).toBe(true)
    const leads = await db.query(`SELECT status FROM sales_leads`)
    expect(leads.rows).toHaveLength(1)
    expect(leads.rows[0].status).toBe('qualified') // new → qualified on booking
  })

  it('refuses a slot that was just taken, and a time that was never offered', async () => {
    const [slot] = await listAvailableSlots()
    expect((await bookSalesCall({ startsAt: slot, mode: 'video', name: 'A', email: 'a@x.com' })).ok).toBe(true)
    const again = await bookSalesCall({ startsAt: slot, mode: 'video', name: 'B', email: 'b@x.com' })
    expect(again.ok).toBe(false)
    const never = await bookSalesCall({ startsAt: '2026-08-01T03:07:00Z', mode: 'video', name: 'C', email: 'c@x.com' })
    expect(never.ok).toBe(false)
  })
})
