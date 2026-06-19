/**
 * S518 — appointment reminder sender coverage. Email is mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'

const reminderMock = vi.fn()
vi.mock('./email', () => ({
  emailBusinessAppointmentReminder: (...a: any[]) => reminderMock(...a),
}))

import { sendAppointmentReminders } from './appointmentReminders'

beforeEach(async () => {
  await cleanupAllSchema()
  reminderMock.mockReset()
  reminderMock.mockResolvedValue(undefined)
})

async function seed(opts: { email?: string | null; offsetHours?: number; status?: string } = {}) {
  const email = `o-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'business_owner', 'Biz', 'Owner', TRUE) RETURNING id`, [email])
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses (owner_user_id, name, business_type, email, enabled_features)
     VALUES ($1, 'Salon Co', 'mini_market', $2, ARRAY['customers','staff','appointments']) RETURNING id`,
    [u.id, email])
  const custEmail = opts.email === undefined ? 'cust@x.com' : opts.email
  const { rows: [c] } = await db.query<{ id: string }>(
    `INSERT INTO business_customers (business_id, customer_type, first_name, last_name, email, street1, city, state, zip)
     VALUES ($1, 'individual', 'Jane', 'Doe', $2, '1 Elm', 'Phoenix', 'AZ', '85001') RETURNING id`,
    [b.id, custEmail])
  const offset = opts.offsetHours ?? 3
  const { rows: [a] } = await db.query<{ id: string }>(
    `INSERT INTO appointments (business_id, customer_id, service_type, scheduled_for, duration_minutes, status,
       ${opts.status === 'cancelled' ? 'cancelled_at,' : ''} created_at)
     VALUES ($1, $2, 'Haircut', NOW() + ($3 * interval '1 hour'), 30, $4,
       ${opts.status === 'cancelled' ? 'NOW(),' : ''} NOW()) RETURNING id`,
    [b.id, c.id, offset, opts.status ?? 'scheduled'])
  return { businessId: b.id, customerId: c.id, appointmentId: a.id }
}

describe('sendAppointmentReminders', () => {
  it('emails an upcoming appointment and stamps reminder_sent_at', async () => {
    const f = await seed({ offsetHours: 3 })
    const res = await sendAppointmentReminders()
    expect(res.sent).toBe(1)
    expect(reminderMock).toHaveBeenCalledOnce()
    const { rows: [a] } = await db.query<{ reminder_sent_at: string | null }>(
      `SELECT reminder_sent_at FROM appointments WHERE id = $1`, [f.appointmentId])
    expect(a.reminder_sent_at).not.toBeNull()
  })

  it('skips a business that has opted out of reminders', async () => {
    const f = await seed({ offsetHours: 3 })
    await db.query(`UPDATE businesses SET appointment_reminders_enabled = FALSE WHERE id = $1`, [f.businessId])
    const res = await sendAppointmentReminders()
    expect(res.sent).toBe(0)
    expect(reminderMock).not.toHaveBeenCalled()
    const { rows: [a] } = await db.query<{ reminder_sent_at: string | null }>(
      `SELECT reminder_sent_at FROM appointments WHERE id = $1`, [f.appointmentId])
    expect(a.reminder_sent_at).toBeNull() // not stamped — can still send if re-enabled
  })

  it('is idempotent — a second run sends nothing', async () => {
    await seed({ offsetHours: 3 })
    await sendAppointmentReminders()
    reminderMock.mockClear()
    const res2 = await sendAppointmentReminders()
    expect(res2.sent).toBe(0)
    expect(reminderMock).not.toHaveBeenCalled()
  })

  it('skips appointments outside the 24h window', async () => {
    await seed({ offsetHours: 48 })  // too far out
    const res = await sendAppointmentReminders()
    expect(res.considered).toBe(0)
  })

  it('skips past appointments', async () => {
    await seed({ offsetHours: -2 })
    const res = await sendAppointmentReminders()
    expect(res.considered).toBe(0)
  })

  it('skips customers with no email', async () => {
    await seed({ email: null, offsetHours: 3 })
    const res = await sendAppointmentReminders()
    expect(res.considered).toBe(0)
  })

  it('skips cancelled appointments', async () => {
    await seed({ status: 'cancelled', offsetHours: 3 })
    const res = await sendAppointmentReminders()
    expect(res.considered).toBe(0)
  })

  it('does not stamp when the email send fails (retries next run)', async () => {
    const f = await seed({ offsetHours: 3 })
    reminderMock.mockRejectedValueOnce(new Error('SMTP down'))
    const res = await sendAppointmentReminders()
    expect(res.failed).toBe(1)
    const { rows: [a] } = await db.query<{ reminder_sent_at: string | null }>(
      `SELECT reminder_sent_at FROM appointments WHERE id = $1`, [f.appointmentId])
    expect(a.reminder_sent_at).toBeNull()
  })
})
