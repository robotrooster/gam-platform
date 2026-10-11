/**
 * 10/4 (gate review, LOW) — THE OTHER TWO DOORS THAT END A HOLD'S LEASE.
 *
 * An unpaid hold that ends on its own (the booking sweep's hold expiry) or
 * whose pay link is closed at the register used to end every 'pending' /
 * 'draft' lease drafted with it by a bare status change. A lease the landlord
 * signed — whose move-in bill may already exist — then ended with that bill
 * still owed and the household still on it. Now:
 *   - paperwork only (never signed by the landlord, no bill) ends with the bare
 *     change, as before;
 *   - anything else goes through the one never-moved-in close
 *     (lib/unwindIssuedLease.endLeaseNeverMovedIn, decisions #46.4 / #53).
 * The sweep is the system acting on "they never paid": it zeroes the unpaid
 * move-in bill (#46.4). Closing a pay link is a staff press with no confirm,
 * so it never zeroes a bill blind (#53): it is refused, naming the Schedule's
 * Cancel reservation, with the link left open and the card page untouched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { pages, onExpire, sentEmails } = vi.hoisted(() => ({
  pages: new Map<string, string>(), onExpire: { run: null as null | (() => Promise<void>) },
  sentEmails: [] as Array<{ to: string; subject: string; html: string; notificationType: string }>,
}))
// The notification email as it would go out (captured, never sent).
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  sendNotificationEmail: async (o: { to: string; subject: string; html: string; notificationType: string }) => { sentEmails.push(o); return null },
}))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig() as any),
  getStripe: () => ({ checkout: { sessions: {
    create: async () => ({ id: 'cs_x', url: 'https://checkout.stripe.test/cs_x' }),
    retrieve: async (id: string) => ({ id, status: pages.get(id) ?? 'expired', payment_status: 'unpaid' }),
    expire: async (id: string) => { pages.set(id, 'expired'); if (onExpire.run) await onExpire.run(); return { id, status: 'expired' } },
  } } }),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { posPayLinksRouter } from './posPayLinks'
import { sweepBookingHoldsAndClaims } from '../services/propertyBooking'
import { NEVER_MOVED_IN_REASON } from '../lib/unwindIssuedLease'
import { errorHandler } from '../middleware/errorHandler'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_hold_lease_nmi'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/pos/pay-links', posPayLinksRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => { pages.clear(); onExpire.run = null; sentEmails.length = 0; await cleanupAllSchema() })

/**
 * An unpaid tentative hold with a lease drafted from it. `signed`: the landlord
 * signed it; `bill`: its move-in bill ($1,000 rent + $500 deposit, unpaid) was
 * made. `expired`: the hold ran out a minute ago.
 */
async function holdWithLease(o: { signed: boolean; bill: boolean; expired?: boolean }) {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 1000, unitType: 'rv_spot' })
    const bookingId = (await c.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, tenant_id, guest_name, check_in, check_out, nights, status, lease_type, total_amount, hold_expires_at)
       VALUES ($1, $2, $3, 'Pat Guest', CURRENT_DATE + 5, CURRENT_DATE + 65, 60, 'tentative', 'month_to_month', 2000,
               now() + ($4 || ' minutes')::interval) RETURNING id`,
      [unitId, landlordId, tenantId, o.expired ? '-1' : '60'])).rows[0].id
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 1000, status: 'pending' })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query(
      `UPDATE leases SET lease_source = 'booking_draft', source_booking_id = $2, signed_by_tenant = $3, signed_by_landlord = $3,
                         lease_type = 'month_to_month', start_date = CURRENT_DATE + 5, end_date = NULL
        WHERE id = $1`, [leaseId, bookingId, o.signed])
    let inv: string | null = null
    if (o.bill) {
      inv = (await c.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, subtotal_deposits, total_amount)
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE + 5, 1000, 500, 1500) RETURNING id`,
        [landlordId, tenantId, leaseId, unitId, `INV-${randomUUID().slice(0, 8)}`])).rows[0].id
      for (const [type, entry, amount] of [['rent', 'RENT', 1000], ['deposit', 'DEPOSIT', 500]] as const) {
        await c.query(
          `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', CURRENT_DATE + 5, $8)`,
          [inv, unitId, leaseId, tenantId, landlordId, type, amount, entry])
      }
    }
    // The pay link the desk sent for the hold: a stay item, one month.
    const cat = (await c.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name) VALUES ($1, 'Sites') RETURNING id`, [landlordId])).rows[0].id
    const item = (await c.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, cost_price, stock_qty, stock_min, stock_max, tax_rate, stay_unit)
       VALUES ($1, $2, $3, 'Monthly site', 2000, 0, 0, 0, 0, 0, 'month') RETURNING id`, [landlordId, propertyId, cat])).rows[0].id
    const linkId = (await c.query<{ id: string }>(
      `INSERT INTO pos_pay_links (landlord_id, property_id, created_by, kind, label, token, items, subtotal, tax_amount, total, status, booking_id, customer_email)
       VALUES ($1, $2, $3, 'one_time', 'Site hold', $4, $5::jsonb, 2000, 0, 2000, 'open', $6, 'pat@guest.dev') RETURNING id`,
      [landlordId, propertyId, userId, randomUUID().replace(/-/g, ''),
       JSON.stringify([{ id: item, name: 'Monthly site', qty: 1, price: 2000 }]), bookingId])).rows[0].id
    const token = jwt.sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: null, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { landlordId, tenantId, unitId, bookingId, leaseId, inv, linkId, token }
  } finally { c.release() }
}

const leaseRow = async (id: string) => (await db.query(
  `SELECT status, termination_reason FROM leases WHERE id = $1`, [id])).rows[0]
const owed = async (tenantId: string) => Number((await db.query<{ s: string }>(
  `SELECT COALESCE(SUM(amount), 0)::text AS s FROM payments WHERE tenant_id = $1 AND status IN ('pending','failed')`, [tenantId])).rows[0].s)
const household = async (leaseId: string) => (await db.query(
  `SELECT status FROM lease_tenants WHERE lease_id = $1`, [leaseId])).rows[0].status
const closeLink = (f: { linkId: string; token: string }) =>
  request(buildApp()).post(`/api/pos/pay-links/${f.linkId}/cancel`).set('Authorization', `Bearer ${f.token}`)

describe('an expired hold ends its lease the right way', () => {
  it('paperwork only (unsigned, no bill): ended by the bare change, as before', async () => {
    const f = await holdWithLease({ signed: false, bill: false, expired: true })
    expect((await sweepBookingHoldsAndClaims()).holdsExpired).toBe(1)
    expect((await leaseRow(f.leaseId)).status).toBe('terminated')
    expect((await leaseRow(f.leaseId)).termination_reason).toBeNull()
  })

  it('a signed lease with its move-in bill unpaid: the never-moved-in close zeroes and voids the bill, ends the lease and takes the household off', async () => {
    const f = await holdWithLease({ signed: true, bill: true, expired: true })
    expect(await owed(f.tenantId)).toBe(1500)
    expect((await sweepBookingHoldsAndClaims()).holdsExpired).toBe(1)
    expect(await leaseRow(f.leaseId)).toEqual({ status: 'terminated', termination_reason: NEVER_MOVED_IN_REASON })
    expect(await owed(f.tenantId)).toBe(0)
    expect((await db.query(`SELECT status FROM invoices WHERE id = $1`, [f.inv])).rows[0].status).toBe('void')
    expect(await household(f.leaseId)).toBe('removed')
  })

  it('a signed lease with money paid on it: the close does not apply — the lease and its bill are left as they were', async () => {
    const f = await holdWithLease({ signed: true, bill: true, expired: true })
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash'
                     WHERE lease_id = $1 AND type = 'deposit'`, [f.leaseId])
    expect((await sweepBookingHoldsAndClaims()).holdsExpired).toBe(1)
    expect((await leaseRow(f.leaseId)).status).toBe('pending')
    expect(await owed(f.tenantId)).toBe(1000)
  })

  it('a signed lease the close refuses: the landlord is told once, naming the lease, the tenant and why', async () => {
    const f = await holdWithLease({ signed: true, bill: true, expired: true })
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash'
                     WHERE lease_id = $1 AND type = 'deposit'`, [f.leaseId])
    await sweepBookingHoldsAndClaims()
    const owner = (await db.query<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [f.landlordId])).rows[0].user_id
    const notes = (await db.query(
      `SELECT type, title, body, action_url, data FROM notifications WHERE user_id = $1 AND type = 'hold_lease_left_open'`, [owner])).rows
    expect(notes).toHaveLength(1)
    expect(notes[0].action_url).toBe(`/leases?open=${f.leaseId}`)
    expect(notes[0].data).toMatchObject({ leaseId: f.leaseId, bookingId: f.bookingId })
    const tenantName = (await db.query<{ n: string }>(
      `SELECT TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS n FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
      [f.tenantId])).rows[0].n
    expect(notes[0].title).toContain(tenantName)
    expect(notes[0].body).toContain('the site was let go, but the lease signed with it was not ended.')
    expect(notes[0].body).toContain('Open the lease and decide what happens to it')
    // The close's own words, which name the next step.
    expect(notes[0].body).toContain('$500.00 was already paid on this lease')
    expect(notes[0].body).toContain('They’re leaving on…')
    // The next sweep does not tell them again (the hold is already let go).
    await sweepBookingHoldsAndClaims()
    expect((await db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'hold_lease_left_open'`, [owner])).rows).toHaveLength(1)
  })

  it('the left-open email escapes the guest name typed on the public booking form and links to the lease', async () => {
    const f = await holdWithLease({ signed: true, bill: true, expired: true })
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash'
                     WHERE lease_id = $1 AND type = 'deposit'`, [f.leaseId])
    // No household member has a name, so the email falls back to the guest
    // name from the booking form — which here carries markup.
    await db.query(`UPDATE users SET first_name = '', last_name = '' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [f.tenantId])
    await db.query(`UPDATE unit_bookings SET guest_name = '<b>Pat</b> <img src=x onerror=alert(1)>' WHERE id = $1`, [f.bookingId])
    await sweepBookingHoldsAndClaims()
    const mail = sentEmails.filter(e => e.notificationType === 'hold_lease_left_open')
    expect(mail).toHaveLength(1)
    expect(mail[0].html).not.toContain('<b>Pat</b>')
    expect(mail[0].html).not.toContain('<img')
    expect(mail[0].html).toContain('&lt;b&gt;Pat&lt;/b&gt; &lt;img src=x onerror=alert(1)&gt;')
    // A button straight to the lease in the landlord portal.
    expect(mail[0].html).toMatch(new RegExp(`<a href="[^"]*/leases\\?open=${f.leaseId}" class="btn">Open the lease</a>`))
    // The in-app copy stays plain text (the screen escapes it), name as typed.
    const owner = (await db.query<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [f.landlordId])).rows[0].user_id
    const note = (await db.query(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'hold_lease_left_open'`, [owner])).rows[0]
    expect(note.title).toContain('<b>Pat</b>')
  })

  it('a lease the close ends: nobody is told it was left open', async () => {
    const f = await holdWithLease({ signed: true, bill: true, expired: true })
    await sweepBookingHoldsAndClaims()
    expect((await db.query(`SELECT 1 FROM notifications WHERE type = 'hold_lease_left_open'`)).rows).toHaveLength(0)
    expect((await leaseRow(f.leaseId)).status).toBe('terminated')
  })
})

describe('closing a pay link ends its hold\'s lease the right way', () => {
  it('paperwork only: the link closes, the hold is let go and the draft ends', async () => {
    const f = await holdWithLease({ signed: false, bill: false })
    const res = await closeLink(f)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.stayCancelled).toBe(true)
    expect((await leaseRow(f.leaseId)).status).toBe('terminated')
  })

  it('a lease the landlord signed with no bill yet: closed through the never-moved-in close — ended and the household taken off', async () => {
    const f = await holdWithLease({ signed: true, bill: false })
    const res = await closeLink(f)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await leaseRow(f.leaseId)).toEqual({ status: 'terminated', termination_reason: NEVER_MOVED_IN_REASON })
    expect(await household(f.leaseId)).toBe('removed')
  })

  it('a move-in bill it would zero: refused in plain words naming the Schedule — the link, the hold, the lease and the bill untouched', async () => {
    const f = await holdWithLease({ signed: true, bill: true })
    const res = await closeLink(f)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('The link was not closed. The lease drafted with this hold has an unpaid $1,500.00 move-in bill, ' +
      'and closing the link would zero it. Cancel the reservation on the Schedule instead — it shows what ending the lease zeroes before anything changes.')
    expect((await db.query(`SELECT status FROM pos_pay_links WHERE id = $1`, [f.linkId])).rows[0].status).toBe('open')
    expect((await db.query(`SELECT status FROM unit_bookings WHERE id = $1`, [f.bookingId])).rows[0].status).toBe('tentative')
    expect((await leaseRow(f.leaseId)).status).toBe('pending')
    expect(await owed(f.tenantId)).toBe(1500)
  })

  it('the lease changes while the card page is being closed: refused, and the words say the page was closed and the link is still open', async () => {
    const f = await holdWithLease({ signed: true, bill: false })
    // The payer has the card page open; while GAM closes it, a payment lands on the lease.
    await db.query(`UPDATE pos_pay_links SET last_checkout_session_id = 'cs_old' WHERE id = $1`, [f.linkId])
    pages.set('cs_old', 'open')
    onExpire.run = async () => {
      await db.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, settled_at, manual_method, entry_description)
         VALUES ($1, $2, $3, $4, 'deposit', 500, 'settled', CURRENT_DATE, NOW(), 'cash', 'DEPOSIT')`,
        [f.unitId, f.leaseId, f.tenantId, f.landlordId])
    }
    const res = await closeLink(f)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^The link was not closed\. This hold has a lease drafted with it/)
    expect(res.body.error.endsWith('The link is still open, but the card page it had was closed — if the payer was on it, they open the link again to pay.')).toBe(true)
    expect(pages.get('cs_old')).toBe('expired')
    expect((await db.query(`SELECT status FROM pos_pay_links WHERE id = $1`, [f.linkId])).rows[0].status).toBe('open')
    expect((await db.query(`SELECT status FROM unit_bookings WHERE id = $1`, [f.bookingId])).rows[0].status).toBe('tentative')
    expect((await leaseRow(f.leaseId)).status).toBe('pending')
  })

  it('a refusal before the card page is touched does not mention the page', async () => {
    const f = await holdWithLease({ signed: true, bill: true })
    await db.query(`UPDATE pos_pay_links SET last_checkout_session_id = 'cs_old' WHERE id = $1`, [f.linkId])
    pages.set('cs_old', 'open')
    const res = await closeLink(f)
    expect(res.status).toBe(409)
    expect(res.body.error).not.toContain('card page it had was closed')
    expect(pages.get('cs_old')).toBe('open')
  })
})
