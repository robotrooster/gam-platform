/**
 * 10/13 (Nic): the happy-birthday email — WHO is greeted (current tenants and
 * landlords with a birthday on file), WHEN (Phoenix's today; Feb 29 on Feb 28
 * in a year without one), and ONCE a person a year. Email is mocked; nothing
 * is ever sent from a test.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

vi.mock('../services/email', () => ({
  emailBirthdayGreeting: vi.fn(async () => 'msg-id'),
  mailLeavesThisMachine: vi.fn(() => true),
}))

import { runBirthdayEmails, birthdaysOn, BIRTHDAY_NOTIFICATION_TYPE } from './birthdayEmails'
import { emailBirthdayGreeting, mailLeavesThisMachine } from '../services/email'

const sendMock = emailBirthdayGreeting as unknown as ReturnType<typeof vi.fn>
const mailLiveMock = mailLeavesThisMachine as unknown as ReturnType<typeof vi.fn>

// 2026-10-14 09:15 Phoenix (= 16:15 UTC).
const MORNING = new Date('2026-10-14T16:15:00Z')

beforeEach(async () => {
  await cleanupAllSchema()
  sendMock.mockReset()
  sendMock.mockImplementation(async () => 'msg-id')
  mailLiveMock.mockReset()
  mailLiveMock.mockImplementation(() => true)
})

async function tx<T>(fn: (c: any) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const out = await fn(c)
    await c.query('COMMIT')
    return out
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A tenant on a lease at a fresh landlord's property. */
async function seedResident(opts: {
  dob?: string | null
  leaseStatus?: 'pending' | 'active' | 'expired' | 'terminated'
  seatStatus?: 'active' | 'removed' | 'pending_add' | 'pending_remove' | 'void'
  demoLandlord?: boolean
  firstName?: string
} = {}) {
  return tx(async (c) => {
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, status: opts.leaseStatus ?? 'active' })
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId })
    if (opts.seatStatus && opts.seatStatus !== 'active') {
      await c.query(`UPDATE lease_tenants SET status = $2 WHERE lease_id = $1`, [leaseId, opts.seatStatus])
    }
    await c.query(`UPDATE tenants SET date_of_birth = $2 WHERE id = $1`,
      [tenantId, opts.dob === undefined ? '1985-10-14' : opts.dob])
    if (opts.demoLandlord) await c.query(`UPDATE landlords SET is_demo = TRUE WHERE id = $1`, [ll.landlordId])
    const { rows: [t] } = await c.query(
      `UPDATE users SET first_name = $2 FROM tenants t WHERE t.id = $1 AND users.id = t.user_id
       RETURNING users.id, users.email`, [tenantId, opts.firstName ?? 'Rosa'])
    return { tenantId, tenantUserId: t.id as string, tenantEmail: t.email as string, landlord: ll }
  })
}

/** A landlord account (founding owner of a company) with this birthday. */
async function seedOwner(dob: string | null, firstName = 'Nic') {
  return tx(async (c) => {
    const ll = await seedLandlord(c, { firstName })
    await c.query(`UPDATE users SET date_of_birth = $2 WHERE id = $1`, [ll.userId, dob])
    return ll
  })
}

async function greetings(userId: string) {
  const { rows } = await db.query<{ greeting_year: number }>(
    `SELECT greeting_year FROM birthday_greetings WHERE user_id = $1 ORDER BY greeting_year`, [userId])
  return rows.map(r => r.greeting_year)
}

describe('birthdaysOn', () => {
  it('an ordinary day greets that month and day', () => {
    expect(birthdaysOn('2026-10-14')).toEqual({ year: 2026, month: 10, days: [14] })
  })
  it('Feb 28 of a year with no Feb 29 greets the Feb 29 birthdays too', () => {
    expect(birthdaysOn('2027-02-28')).toEqual({ year: 2027, month: 2, days: [28, 29] })
    expect(birthdaysOn('2100-02-28').days).toEqual([28, 29]) // 2100 is not a leap year
  })
  it('in a leap year Feb 28 is only Feb 28 — Feb 29 gets its own day', () => {
    expect(birthdaysOn('2028-02-28').days).toEqual([28])
    expect(birthdaysOn('2028-02-29').days).toEqual([29])
    expect(birthdaysOn('2000-02-28').days).toEqual([28]) // 2000 is a leap year
  })
})

describe('runBirthdayEmails', () => {
  it('a current tenant whose birthday is today is emailed once, by first name, and the year is logged', async () => {
    const r = await seedResident({ firstName: 'Rosa' })
    const res = await runBirthdayEmails(MORNING)

    expect(res).toMatchObject({ date: '2026-10-14', birthdays: 1, sent: 1, notSent: 0, errors: 0 })
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock.mock.calls[0][0]).toMatchObject({
      to: r.tenantEmail, firstName: 'Rosa', ctx: { userId: r.tenantUserId, audience: 'tenant' },
    })
    expect(await greetings(r.tenantUserId)).toEqual([2026])
  })

  it('once a year — a second run the same day (or later that year) sends nothing', async () => {
    const r = await seedResident()
    await runBirthdayEmails(MORNING)
    sendMock.mockClear()

    const again = await runBirthdayEmails(MORNING)
    expect(again).toMatchObject({ birthdays: 1, sent: 0, alreadyGreeted: 1 })
    expect(sendMock).not.toHaveBeenCalled()
    expect(await greetings(r.tenantUserId)).toEqual([2026])
  })

  it('next year is a new year — greeted again', async () => {
    const r = await seedResident()
    await runBirthdayEmails(MORNING)
    const nextYear = await runBirthdayEmails(new Date('2027-10-14T16:15:00Z'))
    expect(nextYear.sent).toBe(1)
    expect(await greetings(r.tenantUserId)).toEqual([2026, 2027])
  })

  it('"today" is Phoenix\'s date, not UTC\'s', async () => {
    await seedResident({ dob: '1985-10-14' })
    // 2026-10-15 05:00 UTC is still 10:00 pm on the 14th in Phoenix.
    const res = await runBirthdayEmails(new Date('2026-10-15T05:00:00Z'))
    expect(res).toMatchObject({ date: '2026-10-14', sent: 1 })
  })

  it('no birthday on file, or a birthday on another day → never emailed', async () => {
    await seedResident({ dob: null })
    await seedResident({ dob: '1985-10-15' })
    await seedResident({ dob: '1985-11-14' })
    const res = await runBirthdayEmails(MORNING)
    expect(res).toMatchObject({ birthdays: 0, sent: 0 })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('a "birthday" of today or later is a typo, not a birthday → skipped', async () => {
    await seedResident({ dob: '2026-10-14' })
    expect((await runBirthdayEmails(MORNING)).sent).toBe(0)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('only CURRENT tenants — not a lease that ended or has not started, not a seat taken off the lease', async () => {
    await seedResident({ leaseStatus: 'expired' })
    await seedResident({ leaseStatus: 'terminated' })
    await seedResident({ leaseStatus: 'pending' })
    await seedResident({ seatStatus: 'removed' })
    await seedResident({ seatStatus: 'pending_add' })
    await seedResident({ seatStatus: 'void' })
    expect((await runBirthdayEmails(MORNING)).sent).toBe(0)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('a roommate whose removal is still waiting on signatures still lives there → greeted', async () => {
    const r = await seedResident({ seatStatus: 'pending_remove', firstName: 'Rosa' })
    const res = await runBirthdayEmails(MORNING)
    expect(res).toMatchObject({ birthdays: 1, sent: 1 })
    expect(sendMock.mock.calls[0][0]).toMatchObject({ firstName: 'Rosa', ctx: { userId: r.tenantUserId } })
    expect(await greetings(r.tenantUserId)).toEqual([2026])
  })

  it('tenants of a demo company are left out', async () => {
    await seedResident({ demoLandlord: true })
    expect((await runBirthdayEmails(MORNING)).sent).toBe(0)
  })

  it('a landlord with today\'s birthday on their profile is emailed; one without a birthday is not', async () => {
    const owner = await seedOwner('1979-10-14', 'Nic')
    await seedOwner(null)
    await seedOwner('1979-10-13')
    const res = await runBirthdayEmails(MORNING)

    expect(res).toMatchObject({ birthdays: 1, sent: 1 })
    expect(sendMock.mock.calls[0][0]).toMatchObject({
      firstName: 'Nic', ctx: { userId: owner.userId, audience: 'landlord' },
    })
    expect(await greetings(owner.userId)).toEqual([2026])
  })

  it('a co-owner of a company is a landlord too', async () => {
    const founder = await seedOwner(null)
    const coOwnerId = await tx(async (c) => {
      const { rows: [u] } = await c.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified, date_of_birth)
         VALUES ('coowner-bday@test.dev', 'x', 'landlord', 'Dana', 'Co', TRUE, '1990-10-14') RETURNING id`)
      await c.query(`INSERT INTO landlord_members (landlord_id, user_id) VALUES ($1, $2)`, [founder.landlordId, u.id])
      return u.id as string
    })
    const res = await runBirthdayEmails(MORNING)
    expect(res.sent).toBe(1)
    expect(sendMock.mock.calls[0][0]).toMatchObject({ firstName: 'Dana', ctx: { userId: coOwnerId, audience: 'landlord' } })
  })

  it('a landlord account that owns only a demo or system company is left out', async () => {
    const demo = await seedOwner('1979-10-14')
    await db.query(`UPDATE landlords SET is_demo = TRUE WHERE id = $1`, [demo.landlordId])
    const sys = await seedOwner('1979-10-14')
    await db.query(`UPDATE landlords SET is_system = TRUE WHERE id = $1`, [sys.landlordId])
    expect((await runBirthdayEmails(MORNING)).sent).toBe(0)
  })

  it('a birthday on a team member (not a landlord account) is not read', async () => {
    await seedOwner(null)
    await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified, date_of_birth)
       VALUES ('pm-bday@test.dev', 'x', 'property_manager', 'Pat', 'M', TRUE, '1990-10-14')`)
    expect((await runBirthdayEmails(MORNING)).sent).toBe(0)
  })

  it('one person on both lists gets ONE email', async () => {
    const owner = await seedOwner('1979-10-14')
    // The landlord's own account also has a tenant row on an active lease.
    await tx(async (c) => {
      const propertyId = await seedProperty(c, { landlordId: owner.landlordId, ownerUserId: owner.userId, managedByUserId: owner.userId })
      const unitId = await seedUnit(c, { propertyId, landlordId: owner.landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId: owner.landlordId })
      const { rows: [t] } = await c.query(
        `INSERT INTO tenants (user_id, date_of_birth) VALUES ($1, '1979-10-14') RETURNING id`, [owner.userId])
      await seedLeaseTenant(c, { leaseId, tenantId: t.id })
    })
    const res = await runBirthdayEmails(MORNING)
    expect(res).toMatchObject({ birthdays: 1, sent: 1 })
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('switched off (the birthday email preference) → not emailed; switched back on → emailed', async () => {
    const r = await seedResident()
    await db.query(
      `INSERT INTO notification_preferences (user_id, type, email_enabled, in_app_enabled) VALUES ($1, $2, FALSE, TRUE)`,
      [r.tenantUserId, BIRTHDAY_NOTIFICATION_TYPE])
    const off = await runBirthdayEmails(MORNING)
    expect(off).toMatchObject({ birthdays: 1, optedOut: 1, sent: 0 })
    expect(sendMock).not.toHaveBeenCalled()
    expect(await greetings(r.tenantUserId)).toEqual([])

    await db.query(`UPDATE notification_preferences SET email_enabled = TRUE WHERE user_id = $1`, [r.tenantUserId])
    expect((await runBirthdayEmails(MORNING)).sent).toBe(1)
  })

  it('a different email type switched off does not stop the birthday email', async () => {
    const r = await seedResident()
    await db.query(
      `INSERT INTO notification_preferences (user_id, type, email_enabled, in_app_enabled) VALUES ($1, 'bulk_message', FALSE, TRUE)`,
      [r.tenantUserId])
    expect((await runBirthdayEmails(MORNING)).sent).toBe(1)
  })

  it('Feb 29 birthdays: greeted on Feb 28 in 2027, on Feb 29 (not Feb 28) in 2028', async () => {
    const r = await seedResident({ dob: '1988-02-29' })
    const feb28_2027 = new Date('2027-02-28T16:15:00Z')
    expect((await runBirthdayEmails(feb28_2027)).sent).toBe(1)

    expect((await runBirthdayEmails(new Date('2028-02-28T16:15:00Z'))).birthdays).toBe(0)
    expect((await runBirthdayEmails(new Date('2028-02-29T16:15:00Z'))).sent).toBe(1)
    expect(await greetings(r.tenantUserId)).toEqual([2027, 2028])
  })

  it('a Feb 28 birthday is still greeted on Feb 28 in a non-leap year', async () => {
    await seedResident({ dob: '1988-02-28' })
    expect((await runBirthdayEmails(new Date('2027-02-28T16:15:00Z'))).sent).toBe(1)
  })

  it('a send that did not go out gives the year back, so a later run can still greet', async () => {
    const r = await seedResident()
    sendMock.mockImplementation(async () => null)
    const res = await runBirthdayEmails(MORNING)
    expect(res).toMatchObject({ sent: 0, notSent: 1 })
    expect(await greetings(r.tenantUserId)).toEqual([])

    sendMock.mockImplementation(async () => 'msg-id')
    expect((await runBirthdayEmails(MORNING)).sent).toBe(1)
    expect(await greetings(r.tenantUserId)).toEqual([2026])
  })

  it('a send that throws is counted, gives the year back, and does not stop the others', async () => {
    const a = await seedResident({ firstName: 'Ann' })
    const b = await seedResident({ firstName: 'Bea' })
    sendMock.mockImplementation(async (args: any) => {
      if (args.firstName === 'Ann') throw new Error('boom')
      return 'msg-id'
    })
    const res = await runBirthdayEmails(MORNING)
    expect(res).toMatchObject({ birthdays: 2, sent: 1, errors: 1 })
    expect(await greetings(a.tenantUserId)).toEqual([])
    expect(await greetings(b.tenantUserId)).toEqual([2026])
  })

  it('a machine that sends no mail counts the birthdays but claims and sends nothing', async () => {
    const r = await seedResident()
    mailLiveMock.mockImplementation(() => false)
    const res = await runBirthdayEmails(MORNING)
    expect(res).toMatchObject({ birthdays: 1, mailOff: true, sent: 0, notSent: 0, alreadyGreeted: 0 })
    expect(sendMock).not.toHaveBeenCalled()
    expect(await greetings(r.tenantUserId)).toEqual([])
  })

  it('a dev API on the shared database runs first at 9:15 → production still greets the person', async () => {
    const r = await seedResident()
    mailLiveMock.mockImplementation(() => false)
    await runBirthdayEmails(MORNING) // the dev machine
    mailLiveMock.mockImplementation(() => true)
    const prod = await runBirthdayEmails(MORNING)
    expect(prod).toMatchObject({ sent: 1, alreadyGreeted: 0, mailOff: false })
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(await greetings(r.tenantUserId)).toEqual([2026])
  })
})
