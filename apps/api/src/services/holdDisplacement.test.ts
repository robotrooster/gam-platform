/**
 * S652 — an unpaid hold has no clock, and loses to money.
 *
 * Nic, asked how long a counter hold should last: "there's no timer for deposit
 * link but if it's not paid and someone else pays it boots them as unconfirmed
 * when there's no other spaces."
 *
 * The half that is easy to get wrong is "when there's no other spaces" —
 * displacing somebody is the LAST resort, and a park with a free equivalent
 * site must move them instead.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 10/2 (review): the card page a hold's pay link opened is closed at Stripe —
// mocked here; what is tested is that it is asked to, with the right page.
const { expireMock } = vi.hoisted(() => ({ expireMock: vi.fn(async (_l: string, _s: string) => undefined) }))
vi.mock('./stripeConnect', async (orig) => ({ ...(await orig() as any), expirePayLinkCheckoutSession: expireMock }))

import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { clearUnpaidHolds, notifyDisplacedHolds } from './holdDisplacement'

async function seed(opts: { sites: number; layout?: string; amp?: string }) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const ids: string[] = []
    for (let i = 1; i <= opts.sites; i++) {
      const u = await c.query(
        `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type,
                            nightly_rate, rv_site_layout, rv_amp_service)
         VALUES ($1,$2,$3,'vacant',500,'rv_spot',40,$4,$5) RETURNING id`,
        [propertyId, landlordId, `RV 0${i}`, opts.layout ?? 'back_in', opts.amp ?? '30'])
      ids.push(u.rows[0].id)
    }
    await c.query('COMMIT')
    return { landlordId, propertyId, unitIds: ids }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function hold(unitId: string, landlordId: string, opts: { paid?: boolean; locked?: boolean } = {}) {
  const r = await query<any>(
    `INSERT INTO unit_bookings
       (unit_id, landlord_id, guest_name, guest_email, lease_type, check_in, check_out, nights,
        total_amount, status, deposit_paid_at, locked_to_unit, hold_expires_at)
     VALUES ($1,$2,'Dale Carter','dale@t.dev','nightly','2027-03-06','2027-03-13',7,280,
             'tentative', $3, $4, NULL) RETURNING id`,
    [unitId, landlordId, opts.paid ? new Date() : null, opts.locked === true])
  return r[0].id
}

const withTx = async (fn: (c: any) => Promise<any>) => {
  const c = await db.connect()
  try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out }
  catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

beforeEach(async () => { await cleanupAllSchema(); expireMock.mockClear() })

describe('an unpaid hold yields to somebody who paid', () => {
  it('moves the holder to an equivalent free site rather than bumping them', async () => {
    const f = await seed({ sites: 2 })
    const held = await hold(f.unitIds[0], f.landlordId)

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out).toHaveLength(1)
    expect(out[0].outcome).toBe('moved')
    expect(out[0].toUnitNumber).toBe('RV 02')

    const [b] = await query<any>(`SELECT unit_id, status, displaced_at FROM unit_bookings WHERE id=$1`, [held])
    expect(b.unit_id).toBe(f.unitIds[1])
    expect(b.status).toBe('tentative')       // still theirs, still coming
    expect(b.displaced_at).toBeTruthy()
  })

  it('only bumps them when the park genuinely has nothing else', async () => {
    const f = await seed({ sites: 1 })
    const held = await hold(f.unitIds[0], f.landlordId)

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out[0].outcome).toBe('displaced')

    const [b] = await query<any>(`SELECT status, displaced_reason FROM unit_bookings WHERE id=$1`, [held])
    expect(b.status).toBe('cancelled')
    expect(b.displaced_reason).toMatch(/nothing else free/i)
  })

  it('never touches a booking that has paid a deposit', async () => {
    // The whole point of the rank. Paid beats unpaid, and a paid booking is a
    // paid booking whatever its status says.
    const f = await seed({ sites: 2 })
    const paid = await hold(f.unitIds[0], f.landlordId, { paid: true })

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out).toHaveLength(0)

    const [b] = await query<any>(`SELECT unit_id, status FROM unit_bookings WHERE id=$1`, [paid])
    expect(b.unit_id).toBe(f.unitIds[0])
    expect(b.status).toBe('tentative')
  })

  it('will not move a guest onto a site that does not match what they asked for', async () => {
    // A 50-amp pull-through is not accommodated by a 30-amp back-in.
    const f = await seed({ sites: 2 })
    const held = await hold(f.unitIds[0], f.landlordId)
    await query(`UPDATE unit_bookings SET required_amp_service='50' WHERE id=$1`, [held])

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out[0].outcome).toBe('displaced')
  })

  it('moves a locked hold rather than dropping it, and says it was locked', async () => {
    // Losing the site you asked for is a smaller injury than losing the stay.
    const f = await seed({ sites: 2 })
    await hold(f.unitIds[0], f.landlordId, { locked: true })

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out[0].outcome).toBe('moved')
    expect(out[0].wasLocked).toBe(true)
  })

  it('does not cascade one holder onto another holder\'s site', async () => {
    const f = await seed({ sites: 2 })
    await hold(f.unitIds[0], f.landlordId)
    await hold(f.unitIds[1], f.landlordId)

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out[0].outcome).toBe('displaced')
  })

  it('leaves a hold on other dates completely alone', async () => {
    const f = await seed({ sites: 1 })
    const other = await query<any>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, lease_type, check_in, check_out,
                                  nights, total_amount, status)
       VALUES ($1,$2,'Someone Else','nightly','2027-05-01','2027-05-05',4,160,'tentative') RETURNING id`,
      [f.unitIds[0], f.landlordId])

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out).toHaveLength(0)
    const [b] = await query<any>(`SELECT status FROM unit_bookings WHERE id=$1`, [other[0].id])
    expect(b.status).toBe('tentative')
  })
})

/**
 * 10/2 (review): a hold that loses its site loses its unpaid pay link too —
 * the link was for that site, at that site's price. It is closed (kept, never
 * deleted), and a card page the guest may have open is closed at Stripe.
 */
describe('the hold\'s pay link goes with it', () => {
  async function linkFor(f: { landlordId: string; propertyId: string }, bookingId: string, sessionId: string | null) {
    return (await query<{ id: string }>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, tax_amount, discount_amount, total,
                                  customer_email, booking_id, last_checkout_session_id)
       VALUES ($1,$2,$3,(SELECT user_id FROM landlords WHERE id = $2),'one_time','Reservation deposit',
               '[{"id":null,"name":"Reservation deposit","qty":1,"price":56,"tax":0}]'::jsonb,56,0,0,56,'dale@t.dev',$4,$5) RETURNING id`,
      [Math.random().toString(16).slice(2).padEnd(48, '0').slice(0, 48), f.landlordId, f.propertyId, bookingId, sessionId]))[0].id
  }
  const linkStatus = async (id: string) => (await query<any>(`SELECT status FROM pos_pay_links WHERE id = $1`, [id]))[0].status

  it('cancelled for want of a site: its link is closed, its card page shut, and its register ticket voided', async () => {
    const f = await seed({ sites: 1 })
    const held = await hold(f.unitIds[0], f.landlordId)
    const link = await linkFor(f, held, 'cs_hold_1')
    const ticket = (await query<{ id: string }>(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, items, booking_id)
       VALUES ($1,$2,(SELECT user_id FROM landlords WHERE id = $1),'[]'::jsonb,$3) RETURNING id`,
      [f.landlordId, f.propertyId, held]))[0].id

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out[0]).toMatchObject({ outcome: 'displaced', linkClosed: true })
    expect(await linkStatus(link)).toBe('cancelled')
    expect(expireMock).toHaveBeenCalledTimes(1)
    expect(expireMock).toHaveBeenCalledWith(f.landlordId, 'cs_hold_1')
    const [t] = await query<any>(`SELECT status, void_reason FROM pos_open_tickets WHERE id = $1`, [ticket])
    expect(t.status).toBe('voided')
    expect(t.void_reason).toMatch(/lost its site/i)
  })

  // 10/3 (decisions #12): a MOVED hold keeps its pay link — it pays the same
  // booking, now on the new site. Only a CANCELLED hold closes its link.
  it('moved to another site: its pay link stays open and its card page untouched, its ticket says where they are, and the landlord is told the link still works', async () => {
    const f = await seed({ sites: 2 })
    const held = await hold(f.unitIds[0], f.landlordId)
    const link = await linkFor(f, held, 'cs_moved_page')
    const ticket = (await query<{ id: string }>(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, items, booking_id, note)
       VALUES ($1,$2,(SELECT user_id FROM landlords WHERE id = $1),'[]'::jsonb,$3,'Dale Carter · site RV 01 · 2027-03-06 → 2027-03-13') RETURNING id`,
      [f.landlordId, f.propertyId, held]))[0].id

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out[0]).toMatchObject({ outcome: 'moved', linkClosed: false, linkKept: true, toUnitNumber: 'RV 02' })
    expect(await linkStatus(link)).toBe('open')
    expect(expireMock).not.toHaveBeenCalled()
    const [l] = await query<any>(`SELECT last_checkout_session_id, booking_id FROM pos_pay_links WHERE id = $1`, [link])
    expect(l).toEqual({ last_checkout_session_id: 'cs_moved_page', booking_id: held })
    const [t] = await query<any>(`SELECT status, note FROM pos_open_tickets WHERE id = $1`, [ticket])
    expect(t.status).toBe('open')
    expect(t.note).toMatch(/moved to site RV 02 \(a paid reservation took site RV 01\)$/)

    await notifyDisplacedHolds(f.landlordId, f.propertyId, out)
    const [n] = await query<any>(`SELECT body FROM notifications WHERE type = 'booking_moved'`)
    expect(n.body).toMatch(/Their pay link still works — it now pays for site RV 02; nothing to resend\./)
    expect(n.body).not.toMatch(/call them to take payment|was closed/)
  })

  it('moved with no link out: nothing is said about a link', async () => {
    const f = await seed({ sites: 2 })
    await hold(f.unitIds[0], f.landlordId)
    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out[0]).toMatchObject({ outcome: 'moved', linkClosed: false, linkKept: false })
    await notifyDisplacedHolds(f.landlordId, f.propertyId, out)
    const [n] = await query<any>(`SELECT body FROM notifications WHERE type = 'booking_moved'`)
    expect(n.body).not.toMatch(/pay link/)
  })

  // 10/3 (review): the cancelled hold's ticket gives up only its stay — a tank
  // of propane held on the same ticket is still owed.
  it('cancelled for want of a site: a ticket that also carries propane stays open with the propane; the stay comes off it', async () => {
    const f = await seed({ sites: 1 })
    const held = await hold(f.unitIds[0], f.landlordId)
    const cat = (await query<{ id: string }>(`INSERT INTO pos_categories (landlord_id, name) VALUES ($1, 'Stuff') RETURNING id`, [f.landlordId]))[0].id
    const stayItem = await query<{ id: string }>(`INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, cost_price, stock_qty, stock_min, stock_max, stay_unit)
                             VALUES ($1,$2,$3,'RV site — nightly',0,0,999,0,999,'night') RETURNING id`, [f.landlordId, f.propertyId, cat])
    const propane = await query<{ id: string }>(`INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, cost_price, stock_qty, stock_min, stock_max)
                             VALUES ($1,$2,$3,'Propane (20 lb)',20,8,999,0,999) RETURNING id`, [f.landlordId, f.propertyId, cat])
    const items = [{ id: stayItem[0].id, name: 'RV site — nightly', qty: 7, price: 0, tax: 0 },
                   { id: propane[0].id, name: 'Propane (20 lb)', qty: 1, price: 20, tax: 0 }]
    const ticket = (await query<{ id: string }>(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, items, booking_id, note)
       VALUES ($1,$2,(SELECT user_id FROM landlords WHERE id = $1),$3::jsonb,$4,'Dale Carter · site RV 01') RETURNING id`,
      [f.landlordId, f.propertyId, JSON.stringify(items), held]))[0].id

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out[0].outcome).toBe('displaced')
    const [t] = await query<any>(`SELECT status, items, void_reason, note FROM pos_open_tickets WHERE id = $1`, [ticket])
    expect(t.status).toBe('open')
    expect(t.void_reason).toBeNull()
    expect(t.items).toEqual([items[1]])
    expect(t.note).toMatch(/The reservation lost its site to a guest who paid first — its stay was taken off this ticket; the rest is still owed$/)
  })

  it('a paid link, or another booking\'s link, is left alone', async () => {
    const f = await seed({ sites: 1 })
    const held = await hold(f.unitIds[0], f.landlordId)
    const paidLink = await linkFor(f, held, 'cs_paid')
    await query(`UPDATE pos_pay_links SET status = 'paid', paid_at = NOW() WHERE id = $1`, [paidLink])
    const elsewhere = await query<any>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, lease_type, check_in, check_out, nights, total_amount, status)
       VALUES ($1,$2,'Someone Else','nightly','2027-05-01','2027-05-05',4,160,'tentative') RETURNING id`, [f.unitIds[0], f.landlordId])
    const otherLink = await linkFor(f, elsewhere[0].id, 'cs_other')

    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out[0]).toMatchObject({ outcome: 'displaced', linkClosed: false })
    expect(await linkStatus(paidLink)).toBe('paid')
    expect(await linkStatus(otherLink)).toBe('open')
    expect(expireMock).not.toHaveBeenCalled()
  })
})

// 10/3 (review): a long stay drafts its lease alongside the booking. Still
// unsigned paperwork, it goes where the booking goes — moved with it, or
// terminated with it exactly as cancelling it on the schedule does. A signed
// (active) lease is never touched here.
describe('the hold\'s unsigned lease goes with it', () => {
  async function draftLease(f: { landlordId: string; unitIds: string[] }, bookingId: string, status = 'pending') {
    return (await query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date, needs_review, lease_source, source_booking_id)
       VALUES ($1,$2,280,'fixed_term',$4,'2027-03-06','2027-03-13',TRUE,'booking_draft',$3) RETURNING id`,
      [f.unitIds[0], f.landlordId, bookingId, status]))[0].id
  }
  const leaseRow = async (id: string) => (await query<any>(`SELECT unit_id, status FROM leases WHERE id = $1`, [id]))[0]

  it('moved to another site: its pending lease moves to the new site too, and its unit history says so', async () => {
    const f = await seed({ sites: 2 })
    const held = await hold(f.unitIds[0], f.landlordId)
    const lease = await draftLease(f, held)
    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out[0]).toMatchObject({ outcome: 'moved', toUnitNumber: 'RV 02' })
    expect(await leaseRow(lease)).toEqual({ unit_id: f.unitIds[1], status: 'pending' })
    const hist = await query<any>(
      `SELECT unit_id, to_char(effective_from, 'YYYY-MM-DD') AS from_d, to_char(effective_to, 'YYYY-MM-DD') AS to_d
         FROM lease_unit_history WHERE lease_id = $1 ORDER BY effective_to NULLS LAST`, [lease])
    expect(hist).toEqual([
      { unit_id: f.unitIds[0], from_d: '2027-03-06', to_d: '2027-03-06' },
      { unit_id: f.unitIds[1], from_d: '2027-03-06', to_d: null },
    ])
  })

  it('cancelled for want of a site: its pending lease is terminated, as the schedule\'s cancel does; another booking\'s lease is left alone', async () => {
    const f = await seed({ sites: 1 })
    const held = await hold(f.unitIds[0], f.landlordId)
    const lease = await draftLease(f, held)
    const other = (await query<any>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, guest_name, lease_type, check_in, check_out, nights, total_amount, status)
       VALUES ($1,$2,'Someone Else','nightly','2027-05-01','2027-05-05',4,160,'tentative') RETURNING id`, [f.unitIds[0], f.landlordId]))[0].id
    const otherLease = (await query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date, needs_review, lease_source, source_booking_id)
       VALUES ($1,$2,160,'fixed_term','pending','2027-05-01','2027-05-05',TRUE,'booking_draft',$3) RETURNING id`,
      [f.unitIds[0], f.landlordId, other]))[0].id
    const out = await withTx((c) => clearUnpaidHolds(c, f.unitIds[0], '2027-03-06', '2027-03-13'))
    expect(out[0]).toMatchObject({ outcome: 'displaced' })
    expect(await leaseRow(lease)).toEqual({ unit_id: f.unitIds[0], status: 'terminated' })
    expect(await leaseRow(otherLease)).toEqual({ unit_id: f.unitIds[0], status: 'pending' })
  })
})
