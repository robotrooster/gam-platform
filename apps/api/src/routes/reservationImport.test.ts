/**
 * 10/20 (Nic) — BRINGING THE OLD SYSTEM'S SCHEDULE IN, AND THE TEXTED ONES AFTER IT.
 *
 *   "I said import because I'm importing a fucking schedule for people that are
 *    coming. I have other reservations that are texted to me. It's two
 *    things... The file importer gets all my other reservations in there that
 *    were booked first... The people that have been texting me are the newer
 *    reservations. They don't get a spot if there's no spot to put them. That's
 *    why the importer happens first, and then the typed by hand ones come
 *    after."
 *
 * THE FIRST TEST IN THIS FILE IS THE ONE THAT MATTERS MOST: bringing a batch in
 * emails NOBODY. Not a confirmation, not a deposit link, not a site reveal.
 * These guests have already been told they are confirmed and several have
 * already paid Nic a deposit; with real customers mid-migration a blast is the
 * worst thing this build could do, so the count asserted is zero emails of any
 * kind, and a second test reads the service's own source so a future session
 * cannot quietly add a send.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import fs from 'fs'
import path from 'path'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedTenant } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'

// The counter's own tax run is not what this is about (the register is reached
// through the reservation form's deposit route, which the import never takes).
vi.mock('../services/posTax', async (orig) => ({
  ...(await orig<any>()),
  calculateCartTax: async (_l: string, cart: any[]) => ({
    subtotal: cart.reduce((s: number, l: any) => s + l.qty * l.unitPrice, 0),
    taxAmount: 0,
    lines: cart.map((l: any) => ({ ...l, taxRate: 0, tax: 0 })),
  }),
}))

let bookingsRouter: any, unitsRouter: any, errorHandler: any
beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_reservation_import'
  ;({ bookingsRouter } = await import('./bookings'))
  ;({ unitsRouter } = await import('./units'))
  ;({ errorHandler } = await import('../middleware/errorHandler'))
})

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/bookings', bookingsRouter)
  app.use('/api/units', unitsRouter)
  app.use(errorHandler)
  return app
}

/** Mountain View, Nic's own rates: $49 a night, $269 a week, $589 a month, 6.60% lodging tax. */
async function seed(opts: { sites?: string[] } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(
      `UPDATE properties
          SET name = 'Mountain View RV Park', booking_deposit_pct = 10, short_term_tax_rate = 6.6,
              nightly_rate = 49, weekly_rate = 269, monthly_rate = 589,
              booking_card_fee_payer = 'customer', timezone = 'America/Phoenix'
        WHERE id = $1`, [propertyId])
    await c.query(
      `UPDATE landlords SET stripe_connect_account_id = 'acct_ri_' || replace($1::text,'-','') WHERE id = $1`,
      [landlordId])
    const sites: Record<string, string> = {}
    for (const number of opts.sites ?? ['RV 12', 'RV 13', 'RV 14']) {
      const u = await c.query<{ id: string }>(
        `INSERT INTO units (property_id, landlord_id, unit_number, status, rent_amount, unit_type,
                            nightly_rate, weekly_rate, monthly_rate, is_bookable, lease_types_allowed)
         VALUES ($1,$2,$3,'vacant',500,'rv_spot',49,269,589,TRUE,ARRAY['nightly','weekly','month_to_month'])
         RETURNING id`, [propertyId, landlordId, number])
      sites[number] = u.rows[0].id
    }
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', profileId: landlordId, landlordIds: [landlordId], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, propertyId, sites, token }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A worker with exactly these boxes ticked, at this one park. */
async function worker(f: any, perms: Record<string, boolean>): Promise<string> {
  const u = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`,
    [`desk-${Math.random().toString(36).slice(2)}@t.dev`])
  await query(
    `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions)
     VALUES ($1,$2,$3,FALSE,$4)`,
    [u[0].id, f.landlordId, [f.propertyId], JSON.stringify(perms)])
  return jwt.sign({ userId: u[0].id, role: 'onsite_manager', email: 'desk@t.dev', landlordId: f.landlordId, permissions: perms },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

const validate = (f: any, body: any, token = f.token) =>
  request(buildApp()).post('/api/bookings/import/validate')
    .set('Authorization', `Bearer ${token}`).send({ propertyId: f.propertyId, door: 'file', ...body })

const commit = (f: any, body: any, token = f.token) =>
  request(buildApp()).post('/api/bookings/import/commit')
    .set('Authorization', `Bearer ${token}`).send({ propertyId: f.propertyId, door: 'file', ...body })

const board = () => query<any>(
  `SELECT b.guest_name, b.guest_email, b.check_in::text AS check_in, b.check_out::text AS check_out,
          b.nights, b.total_amount::float AS total_amount, b.status, b.lease_type, b.locked_to_unit,
          b.lock_reason, b.migrated_door, b.told_outside_gam, b.deposit_amount::float AS deposit_amount,
          b.deposit_paid_at, b.deposit_off_platform_method, b.deposit_off_platform_ref,
          b.stay_terms, b.screening_required, b.deposit_pay_link_id, b.pos_transaction_id,
          b.import_extra_data, u.unit_number
     FROM unit_bookings b JOIN units u ON u.id = b.unit_id ORDER BY b.check_in, u.unit_number`)

const emailsSent = async () => (await query<any>(`SELECT category, to_email FROM email_send_log`))

const rowIssues = (res: any, index: number) =>
  res.body.data.rows[index].issues.map((i: any) => `${i.severity}:${i.field}:${i.message}`)
const blockersOn = (res: any, index: number) =>
  res.body.data.rows[index].issues.filter((i: any) => i.severity === 'block')

// ════════════════════════════════════════════════════════════════════════════

describe('it sends nothing', () => {
  it('a whole batch — file and hand, deposits and all — emails NOBODY', async () => {
    const f = await seed()
    const csv = [
      'Guest,Email,Phone,Site,Arrival,Departure,Total,Deposit,Res #',
      'Dale Carter,dale@mailer-test.co,520-555-0110,RV 14,2027-03-06,2027-03-13,286.75,28.68,RES-1',
      'Marie Okafor,marie@mailer-test.co,,,2027-03-08,2027-03-15,286.75,,RES-2',
    ].join('\n')
    const first = await commit(f, { csv })
    expect(first.status).toBe(200)
    expect(first.body.data.committed).toMatchObject({ created: 2 })

    const hand = await commit(f, {
      door: 'hand',
      rows: [{
        guestName: 'Tom Reyes', email: 'tom@mailer-test.co', checkIn: '2027-04-01',
        checkOut: '2027-04-08', totalAmount: '269', depositPaid: '26.90', depositMethod: 'check',
        depositRef: '4417',
      }],
    })
    expect(hand.status).toBe(200)

    expect(await board()).toHaveLength(3)
    // Not one email of any category — not a confirmation, not a deposit link,
    // not a site reveal, not a stay-assistant link.
    expect(await emailsSent()).toEqual([])
    // And nothing that asks a guest for money was created either.
    const [links, intents] = await Promise.all([
      query<any>(`SELECT id FROM pos_pay_links`),
      query<any>(`SELECT id FROM pos_transactions`),
    ])
    expect(links).toEqual([])
    expect(intents).toEqual([])
  })

  it('the importer has no way to send anything — read off its own source', () => {
    // Written where it cannot rot: a session that adds "just a confirmation" to
    // the import has to delete this test to do it.
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'reservationImport.ts'), 'utf8')
    const banned = [
      /from '\.\/email'/, /services\/email/, /\bemail[A-Z]\w*\(/, /sendBookingConfirmation/,
      /createBookingDepositLink/, /createStayBalanceLink/, /sendStayWorkTradeInvite/,
      /notifyDisplacedHolds/, /clearUnpaidHolds/,
    ]
    expect(banned.filter(re => re.test(src))).toEqual([])
  })
})

describe('the file importer', () => {
  it('reads another park system\'s column names and dates, and keeps what it could not use', async () => {
    const f = await seed()
    const csv = [
      'Reservation #,Name,E-mail,Cell,Space #,Arrive,Depart,Nights,Grand Total,Paid,Rig Length,Comments',
      'RES-1041,"Carter, Dale",DALE@Mailer-Test.co,520-555-0110,14,03/06/2027,03/13/2027,7,"$286.75","$28.68",38 ft,Promised 14 on the phone',
    ].join('\n')
    const res = await validate(f, { csv })
    expect(res.status).toBe(200)
    expect(res.body.data.rows[0]).toMatchObject({
      guestName: 'Dale Carter',           // "Carter, Dale" turned round
      email: 'dale@mailer-test.co',
      checkIn: '2027-03-06',
      checkOut: '2027-03-13',
      nights: 7,
      totalAmount: 286.75,
      depositPaid: 28.68,
      siteNumber: 'RV 14',                // "14" found RV 14
      lockedToSite: true,
      placedByGam: false,
    })
    expect(blockersOn(res, 0)).toEqual([])
    // The column GAM has no field for is kept, not dropped.
    expect(res.body.data.rows[0].extra).toMatchObject({ 'Rig Length': '38 ft' })
    expect(res.body.data.notes.join(' ')).toContain('American style')
    // A preview writes nothing.
    expect(await board()).toEqual([])
  })

  it('locks a promised space and leaves a space GAM chose unlocked', async () => {
    const f = await seed()
    const csv = [
      'guest_name,site,check_in,check_out,total_amount',
      'Dale Carter,RV 14,2027-03-06,2027-03-13,286.75',
      'Marie Okafor,,2027-03-06,2027-03-13,286.75',
    ].join('\n')
    const res = await commit(f, { csv })
    expect(res.status).toBe(200)
    const rows = await board()
    const dale = rows.find(r => r.guest_name === 'Dale Carter')!
    const marie = rows.find(r => r.guest_name === 'Marie Okafor')!
    // Promised RV 14 → nothing may move them off it (scheduleCompression and
    // holdDisplacement both refuse a locked stay).
    expect(dale).toMatchObject({
      unit_number: 'RV 14', locked_to_unit: true, lock_reason: 'promised_before_gam',
      status: 'confirmed', lease_type: 'weekly', migrated_door: 'file', told_outside_gam: true,
      nights: 7, total_amount: 286.75,
    })
    // Nobody promised Marie anything, so the packer may keep moving her.
    expect(marie.locked_to_unit).toBe(false)
    expect(marie.lock_reason).toBeNull()
    expect(marie.unit_number).not.toBe('RV 14')
    // The import asks nobody about a lease and starts no background check.
    expect(dale.stay_terms).toBeNull()
    expect(dale.screening_required).toBe(false)
  })

  it('writes down a deposit paid in the old system without inventing a GAM payment', async () => {
    const f = await seed()
    const res = await commit(f, {
      csv: [
        'guest_name,site,check_in,check_out,total_amount,deposit,ref',
        'Dale Carter,RV 14,2027-03-06,2027-03-13,286.75,28.68,CK-4417',
      ].join('\n'),
      rows: undefined,
    })
    expect(res.status).toBe(200)
    const [b] = await board()
    expect(b.deposit_amount).toBe(28.68)
    expect(b.deposit_paid_at).not.toBeNull()
    // Where the money really came from, so no report reads it as GAM's.
    expect(b.deposit_off_platform_method).toBe('other')
    expect(b.deposit_off_platform_ref).toBe('CK-4417')
    // Nothing that moves money was created: no pay link, no register sale, no
    // payment row, nothing in GAM's own book.
    expect(b.deposit_pay_link_id).toBeNull()
    expect(b.pos_transaction_id).toBeNull()
    expect(await query(`SELECT id FROM payments`)).toEqual([])
    expect(await query(`SELECT id FROM platform_revenue_ledger`)).toEqual([])
  })

  it('refuses a row that says the deposit is paid but not how much', async () => {
    const f = await seed()
    const res = await validate(f, {
      csv: ['guest_name,site,check_in,check_out,total,paid',
            'Dale Carter,RV 14,2027-03-06,2027-03-13,286.75,Y'].join('\n'),
    })
    // Writing "paid" with no figure would have the arrival ticket bill the WHOLE
    // stay — the guest charged their deposit a second time.
    expect(blockersOn(res, 0).map((i: any) => i.field)).toContain('depositPaid')
    const refused = await commit(f, {
      csv: ['guest_name,site,check_in,check_out,total,paid',
            'Dale Carter,RV 14,2027-03-06,2027-03-13,286.75,Y'].join('\n'),
    })
    expect(refused.status).toBe(400)
    expect(await board()).toEqual([])
  })

  it('prices a row with no figure off the park\'s own rate card, and says so', async () => {
    const f = await seed()
    const res = await validate(f, {
      csv: ['guest_name,site,check_in,check_out', 'Dale Carter,RV 14,2027-03-06,2027-03-13'].join('\n'),
    })
    expect(res.body.data.rows[0].totalAmount).toBe(286.75)
    expect(rowIssues(res, 0).join(' ')).toContain('park\'s own price')
  })

  it('names what it could not read instead of refusing the file', async () => {
    const f = await seed()
    const res = await validate(f, {
      csv: [
        'guest_name,site,check_in,check_out,total',
        ',RV 12,2027-03-06,2027-03-13,100',                 // nobody
        'Ann Diaz,RV 12,not a date,2027-03-13,100',         // unreadable arrival
        'Bo Lane,RV 99,2027-03-06,2027-03-13,100',          // no such space
        'Cy Munoz,RV 12,2027-03-13,2027-03-06,100',         // leaves before arriving
        'Di Novak,RV 12,2027-05-01,2027-05-08,nonsense',    // unreadable figure
      ].join('\n'),
    })
    expect(res.status).toBe(200)
    expect(blockersOn(res, 0).map((i: any) => i.field)).toEqual(['guestName'])
    expect(blockersOn(res, 1).map((i: any) => i.field)).toEqual(['checkIn'])
    expect(blockersOn(res, 2).map((i: any) => i.field)).toEqual(['unitNumber'])
    expect(blockersOn(res, 3).map((i: any) => i.field)).toEqual(['checkOut'])
    expect(blockersOn(res, 4)).toEqual([])                  // a figure is a warning
    expect(rowIssues(res, 4).join(' ')).toContain('warn:totalAmount')
    expect(res.body.data.summary.blockers).toBe(4)
  })

  it('refuses rows for another park on the account rather than filing them here', async () => {
    const f = await seed()
    await query(
      `INSERT INTO properties (landlord_id, name, street1, city, state, zip, type, owner_user_id, managed_by_user_id)
       VALUES ($1,'Oak Park Estates','1 Oak','Phoenix','AZ','85001','mixed',$2,$2)`,
      [f.landlordId, f.userId])
    const res = await validate(f, {
      csv: ['guest_name,park,site,check_in,check_out',
            'Dale Carter,Oak Park Estates,RV 14,2027-03-06,2027-03-13'].join('\n'),
    })
    expect(blockersOn(res, 0)[0].message).toContain('Oak Park Estates')
    expect(blockersOn(res, 0)[0].message).toContain('Mountain View RV Park')
  })

  it('but a "Location" column full of the old system\'s own words only gets a warning', async () => {
    // Another park system's park column is called "Location", and its contents
    // may be "Loop B". Blocking every row in the file over that would be absurd.
    const f = await seed()
    const res = await validate(f, {
      csv: ['guest_name,location,site,check_in,check_out,total',
            'Dale Carter,Loop B,RV 14,2027-03-06,2027-03-13,286.75'].join('\n'),
    })
    expect(blockersOn(res, 0)).toEqual([])
    expect(rowIssues(res, 0).join(' ')).toContain('not the name of any park on this account')
    expect(res.body.data.rows[0].siteNumber).toBe('RV 14')
  })
})

describe('two claims on one space', () => {
  it('will not put an imported guest on a space a live reservation holds, and moves nobody', async () => {
    const f = await seed()
    // A reservation taken at the desk, already on RV 14.
    const live = await request(buildApp()).post(`/api/units/${f.sites['RV 14']}/bookings`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ guestName: 'Ida Brooks', leaseType: 'nightly', checkIn: '2027-03-08', checkOut: '2027-03-11',
              source: 'direct', lockedToUnit: true })
    expect(live.status).toBe(201)

    const csv = ['guest_name,site,check_in,check_out,total',
                 'Dale Carter,RV 14,2027-03-06,2027-03-13,286.75'].join('\n')
    const res = await validate(f, { csv })
    const blocker = blockersOn(res, 0)[0]
    expect(blocker.field).toBe('unitNumber')
    expect(blocker.message).toContain('RV 14')
    expect(blocker.message).toContain('Ida Brooks')
    expect(blocker.message).toContain('nobody is moved automatically')

    // The commit refuses the whole batch, and Ida is exactly where she was.
    const refused = await commit(f, { csv })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toContain('Nothing was brought in')
    const rows = await board()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ guest_name: 'Ida Brooks', unit_number: 'RV 14' })
    expect(rows[0].displaced_at ?? null).toBeNull()
  })

  it('catches two rows in the same file promised the same space', async () => {
    const f = await seed()
    const csv = [
      'guest_name,site,check_in,check_out,total',
      'Dale Carter,RV 14,2027-03-06,2027-03-13,286.75',
      'Marie Okafor,RV 14,2027-03-10,2027-03-17,286.75',
    ].join('\n')
    const res = await validate(f, { csv })
    expect(blockersOn(res, 0)).toEqual([])
    expect(blockersOn(res, 1)[0].message).toContain('Another row in this file')
    expect((await commit(f, { csv })).status).toBe(400)
    expect(await board()).toEqual([])
  })

  it('never stacks two placed rows onto one space', async () => {
    const f = await seed({ sites: ['RV 12', 'RV 13'] })
    const csv = [
      'guest_name,check_in,check_out,total',
      'Dale Carter,2027-03-06,2027-03-13,286.75',
      'Marie Okafor,2027-03-06,2027-03-13,286.75',
    ].join('\n')
    const res = await commit(f, { csv })
    expect(res.status).toBe(200)
    const rows = await board()
    expect(new Set(rows.map(r => r.unit_number)).size).toBe(2)
  })

  // 10/20 — THE ONE THAT SHIPPED BROKEN, AND IT REFUSED THE WRONG GUEST.
  //
  // Mountain View's season file carries both kinds of row mixed together: a few
  // name the space the old system promised, most name nothing. Taking the
  // spaces in file order, the row GAM PLACED went first, the board was empty so
  // best-fit broke the tie on unit number, and it landed on RV 01 — the space
  // the guest further down the file had actually been promised. That guest was
  // the one refused, and the preview's only ways out were to type a different
  // space over the promise or drop them. A promise now goes before a pick
  // inside one file, the same way the file door goes before the hand door.
  it('a space GAM picked never takes a space a later row in the file was promised', async () => {
    const f = await seed({ sites: ['RV 01', 'RV 02', 'RV 03'] })
    const csv = [
      'guest_name,site,check_in,check_out,total',
      'Dale Carter,,2027-03-06,2027-03-13,286.75',        // no space named — GAM places them
      'Marie Okafor,RV 01,2027-03-06,2027-03-13,286.75',  // was promised RV 01
    ].join('\n')

    const res = await validate(f, { csv })
    expect(blockersOn(res, 0)).toEqual([])
    expect(blockersOn(res, 1)).toEqual([])
    // The promise is kept, and it is locked so compression cannot take it back.
    expect(res.body.data.rows[1].siteNumber).toBe('RV 01')
    expect(res.body.data.rows[1].lockedToSite).toBe(true)
    // GAM's own pick went somewhere else.
    expect(res.body.data.rows[0].placedByGam).toBe(true)
    expect(res.body.data.rows[0].siteNumber).not.toBe('RV 01')

    expect((await commit(f, { csv })).status).toBe(200)
    const rows = await board()
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.guest_name === 'Marie Okafor')).toMatchObject({
      unit_number: 'RV 01', locked_to_unit: true, lock_reason: 'promised_before_gam',
    })
    expect(rows.find(r => r.guest_name === 'Dale Carter')!.unit_number).not.toBe('RV 01')
    expect(rows.find(r => r.guest_name === 'Dale Carter')!.locked_to_unit).toBe(false)
  })

  it('names the other guest and their line of the file when two promises collide', async () => {
    const f = await seed()
    const csv = [
      'guest_name,site,check_in,check_out,total',
      'Dale Carter,RV 14,2027-03-06,2027-03-13,286.75',
      'Marie Okafor,RV 14,2027-03-10,2027-03-17,286.75',
    ].join('\n')
    const message = blockersOn(await validate(f, { csv }), 1)[0].message
    expect(message).toContain('Another row in this file')
    expect(message).toContain('row 1')
    expect(message).toContain('Dale Carter')
    expect(message).toContain('settle which one keeps it')
  })

  // The placement retry asked the picker again and got the same space back
  // every time (the ranking reads the pool, so each try scored the same board),
  // so a space the stay check refuses used up all three tries and the row was
  // told the park was full with another space standing empty.
  it('moves on to the next space when the one GAM picked turns out to be held', async () => {
    const f = await seed({ sites: ['RV 01', 'RV 02'] })
    // RV 01 is held for a tenant completing onboarding. It still reads vacant
    // and bookable, so the picker offers it first and the stay check refuses it.
    const c = await db.connect()
    try {
      const tenantId = await seedTenant(c)
      await c.query(
        `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, unit_id, property_id)
         VALUES ($1,$2,$3,$4)`,
        [f.landlordId, tenantId, f.sites['RV 01'], f.propertyId])
    } finally { c.release() }

    const csv = ['guest_name,check_in,check_out,total',
                 'Dale Carter,2027-03-06,2027-03-13,286.75'].join('\n')
    expect((await commit(f, { csv })).status).toBe(200)
    expect((await board())[0].unit_number).toBe('RV 02')
  })

  it('says so plainly when there is nowhere to put them — "no spot to put them"', async () => {
    const f = await seed({ sites: ['RV 12'] })
    const csv = [
      'guest_name,check_in,check_out,total',
      'Dale Carter,2027-03-06,2027-03-13,286.75',
      'Marie Okafor,2027-03-06,2027-03-13,286.75',
    ].join('\n')
    const res = await validate(f, { csv })
    expect(blockersOn(res, 0)).toEqual([])
    expect(blockersOn(res, 1)[0].message).toContain('Nothing to put them on')
    expect(blockersOn(res, 1)[0].message).toContain('Mountain View RV Park')
  })
})

describe('an unpaid hold is not moved to make room — it is put in front of Nic', () => {
  it('blocks the row rather than displacing the guest holding the space', async () => {
    // An unpaid hold normally steps aside for money (S652). An import is not a
    // payment at that moment, and moving the holder would email them
    // (emailBookingSiteChanged) — which this door may never do. So the clash is
    // surfaced and Nic settles it from the schedule, where the notice goes out
    // from the door that is supposed to send it.
    const f = await seed()
    const held = await request(buildApp()).post(`/api/units/${f.sites['RV 14']}/bookings`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ guestName: 'Pat Ruiz', guestEmail: 'pat@mailer-test.co', leaseType: 'nightly',
              checkIn: '2027-03-08', checkOut: '2027-03-11', source: 'direct', payMode: 'link' })
    expect([200, 201]).toContain(held.status)
    await query(`UPDATE unit_bookings SET status='tentative', deposit_paid_at=NULL, hold_expires_at=NULL`)

    const res = await validate(f, {
      csv: ['guest_name,site,check_in,check_out,total',
            'Dale Carter,RV 14,2027-03-06,2027-03-13,286.75'].join('\n'),
    })
    expect(blockersOn(res, 0)[0].message).toContain('Pat Ruiz')
    // Pat is where she was, and was never told her space had moved. (Counted by
    // category rather than by a total: setting the hold up sends her its own
    // deposit link, which is the door that is meant to email her.)
    const [pat] = await query<any>(`SELECT displaced_at, displaced_from_unit, unit_id FROM unit_bookings`)
    expect(pat.displaced_at).toBeNull()
    expect(pat.displaced_from_unit).toBeNull()
    expect(pat.unit_id).toBe(f.sites['RV 14'])
    expect((await emailsSent()).filter(e => e.category === 'booking_site_changed')).toEqual([])
  })
})

describe('a seasonal stay', () => {
  it('comes in as a month-to-month stay with no lease, no screening and nobody asked anything', async () => {
    const f = await seed()
    const res = await commit(f, {
      csv: ['guest_name,email,site,check_in,check_out,total,deposit',
            'Vic Cardoza,vic@mailer-test.co,RV 14,2027-01-04,2027-04-04,1767,176.70'].join('\n'),
    })
    expect(res.status).toBe(200)
    const [b] = await board()
    expect(b).toMatchObject({
      lease_type: 'month_to_month', nights: 90, total_amount: 1767,
      locked_to_unit: true, told_outside_gam: true, deposit_amount: 176.7,
    })
    // The import asks nobody lease-or-stay and starts no background check — that
    // stay was agreed months ago, not today (routes/units does both for a stay
    // being taken NOW; this door deliberately does neither).
    expect(b.stay_terms).toBeNull()
    expect(b.screening_required).toBe(false)
    expect(await query(`SELECT id FROM leases`)).toEqual([])
    expect(await query(`SELECT id FROM background_checks`)).toEqual([])
    expect(await emailsSent()).toEqual([])
  })
})

describe('the same file twice', () => {
  it('adds nobody a second time', async () => {
    const f = await seed()
    const csv = [
      'Res #,guest_name,site,check_in,check_out,total',
      'RES-1,Dale Carter,RV 14,2027-03-06,2027-03-13,286.75',
      'RES-2,Marie Okafor,RV 13,2027-03-06,2027-03-13,286.75',
    ].join('\n')
    expect((await commit(f, { csv })).body.data.committed).toMatchObject({ created: 2, skipped: 0 })
    const again = await commit(f, { csv })
    expect(again.status).toBe(200)
    expect(again.body.data.committed).toMatchObject({ created: 0, skipped: 2 })
    expect(again.body.data.rows[0].alreadyIn).toBe(true)
    expect(rowIssues(again, 0).join(' ')).toContain('Already brought in')
    expect(await board()).toHaveLength(2)
  })

  it('recognizes the same reservation with no reservation number in the file', async () => {
    const f = await seed()
    const csv = ['guest_name,site,check_in,check_out,total',
                 'Dale Carter,RV 14,2027-03-06,2027-03-13,286.75'].join('\n')
    await commit(f, { csv })
    const again = await commit(f, { csv })
    expect(again.body.data.committed).toMatchObject({ created: 0, skipped: 1 })
    expect(await board()).toHaveLength(1)
  })

  it('keeps only the first of two identical rows inside one file', async () => {
    const f = await seed()
    const csv = [
      'guest_name,site,check_in,check_out,total',
      'Dale Carter,RV 14,2027-03-06,2027-03-13,286.75',
      'Dale Carter,RV 14,2027-03-06,2027-03-13,286.75',
    ].join('\n')
    const res = await commit(f, { csv })
    expect(res.status).toBe(200)
    expect(await board()).toHaveLength(1)
    expect(rowIssues(res, 1).join(' ')).toContain('appears earlier in this file')
  })
})

describe('the typed-in ones come after', () => {
  it('warns that the old schedule has not been brought in yet, and stops warning once it has', async () => {
    const f = await seed()
    const before = await validate(f, {
      door: 'hand',
      rows: [{ guestName: 'Tom Reyes', checkIn: '2027-04-01', checkOut: '2027-04-08', totalAmount: '269' }],
    })
    expect(before.body.data.notes.join(' ')).toContain('old schedule has not been brought in yet')
    expect(blockersOn(before, 0)).toEqual([])   // warned, never blocked

    await commit(f, {
      csv: ['guest_name,site,check_in,check_out,total',
            'Dale Carter,RV 14,2027-03-06,2027-03-13,286.75'].join('\n'),
    })
    const after = await validate(f, {
      door: 'hand',
      rows: [{ guestName: 'Tom Reyes', checkIn: '2027-04-01', checkOut: '2027-04-08', totalAmount: '269' }],
    })
    expect(after.body.data.notes.join(' ')).not.toContain('old schedule has not been brought in yet')
  })

  it('records which door a reservation came through', async () => {
    const f = await seed()
    await commit(f, { csv: ['guest_name,site,check_in,check_out,total',
                            'Dale Carter,RV 14,2027-03-06,2027-03-13,286.75'].join('\n') })
    await commit(f, {
      door: 'hand',
      rows: [{ guestName: 'Tom Reyes', checkIn: '2027-04-01', checkOut: '2027-04-08', totalAmount: '269' }],
    })
    const rows = await board()
    expect(rows.find(r => r.guest_name === 'Dale Carter')!.migrated_door).toBe('file')
    expect(rows.find(r => r.guest_name === 'Tom Reyes')!.migrated_door).toBe('hand')
  })

  it('a typed row may also be promised a space, and is locked to it', async () => {
    const f = await seed()
    const res = await commit(f, {
      door: 'hand',
      rows: [{ guestName: 'Tom Reyes', unitNumber: 'RV 13', checkIn: '2027-04-01', checkOut: '2027-04-08',
               totalAmount: '269' }],
    })
    expect(res.status).toBe(200)
    const [b] = await board()
    expect(b).toMatchObject({ unit_number: 'RV 13', locked_to_unit: true, lock_reason: 'promised_before_gam' })
  })
})

describe('GAM does not confirm a guest Nic already confirmed', () => {
  it('refuses the confirmation on an imported reservation, and sends it on a deliberate second ask', async () => {
    const f = await seed()
    await commit(f, {
      csv: ['guest_name,email,site,check_in,check_out,total',
            'Dale Carter,dale@mailer-test.co,RV 14,2027-03-06,2027-03-13,286.75'].join('\n'),
    })
    const [b] = await query<any>(`SELECT id FROM unit_bookings`)

    const refused = await request(buildApp()).post(`/api/bookings/${b.id}/confirmation`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(refused.status).toBe(409)
    expect(refused.body.error).toContain('already told')
    expect(await emailsSent()).toEqual([])

    const anyway = await request(buildApp()).post(`/api/bookings/${b.id}/confirmation`)
      .set('Authorization', `Bearer ${f.token}`).send({ sendAnyway: true })
    expect(anyway.status).toBe(200)
    expect((await emailsSent()).map(e => e.category)).toContain('booking_confirmation')
  })

  it('a row the desk says has NOT been told is confirmable as normal', async () => {
    const f = await seed()
    await commit(f, {
      door: 'hand',
      rows: [{ guestName: 'Tom Reyes', email: 'tom@mailer-test.co', checkIn: '2027-04-01',
               checkOut: '2027-04-08', totalAmount: '269', toldOutsideGam: false }],
    })
    const [b] = await query<any>(`SELECT id, told_outside_gam FROM unit_bookings`)
    expect(b.told_outside_gam).toBe(false)
    const sent = await request(buildApp()).post(`/api/bookings/${b.id}/confirmation`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(sent.status).toBe(200)
  })
})

describe('the arrival ticket (S649) — not this lane\'s, verified from it', () => {
  it('an imported stay whose deposit is recorded is billed the rest on arrival day', async () => {
    const f = await seed()
    await commit(f, {
      csv: ['guest_name,email,site,check_in,check_out,total,deposit',
            'Dale Carter,dale@mailer-test.co,RV 14,2027-03-06,2027-03-13,286.75,28.68'].join('\n'),
    })
    const { billStayBalances } = await import('../services/stayBalance')
    // Arrival morning at Mountain View (Phoenix is UTC-7 all year).
    const result = await billStayBalances(new Date('2027-03-06T17:00:00Z'))
    expect(result).toMatchObject({ billed: 1, failed: 0 })
    const [link] = await query<any>(`SELECT total::float AS total FROM pos_pay_links`)
    expect(link.total).toBe(258.07)          // 286.75 less the 28.68 already in
  })

  // 10/20 (review, blocker): THE SEASONAL ONE. The confirmation quotes a
  // seasonal guest the FIRST MONTH ("if they're seasonal and going to be here
  // more than the 30 days, I just want it to tell them the first month's
  // rate"), and the arrival ticket used to email him the whole season less his
  // deposit — $1,617 on a card page under an email that said $589. The import
  // holds the whole season on the board because it has to: he was promised
  // those dates and that site. What he OWES on arrival is a month.
  it('an imported SEASON is billed its first month on arrival, not the whole season', async () => {
    const f = await seed()
    await commit(f, {
      csv: ['guest_name,email,site,check_in,check_out,total,deposit',
            'Hal Brenner,hal@mailer-test.co,RV 14,2027-03-06,2027-06-06,1767.00,150.00'].join('\n'),
    })
    const [b] = await board()
    expect(b).toMatchObject({ check_in: '2027-03-06', check_out: '2027-06-06', nights: 92,
                              total_amount: 1767, deposit_amount: 150, lease_type: 'month_to_month' })

    const { billStayBalances } = await import('../services/stayBalance')
    const result = await billStayBalances(new Date('2027-03-06T17:00:00Z'))
    expect(result).toMatchObject({ billed: 1, failed: 0 })
    const [link] = await query<any>(
      `SELECT total::float AS total, items->0->>'name' AS line FROM pos_pay_links`)
    expect(link.total).toBe(439)        // $589 for March 6 → April 6, less the $150 already in
    // And the line he reads on the card page says which month it is, so $439
    // cannot be mistaken for the season.
    expect(link.line).toContain('First month')
    expect(link.line).toContain('April 6, 2027')
  })

  it('an imported stay with NO deposit raises nothing on arrival day', async () => {
    // NOT a claim that this is right — it is what services/stayBalance does
    // today (it bills only a stay whose deposit_paid_at is set), pinned here so
    // the gap is visible from this lane rather than discovered on a Monday
    // morning in March. Reported, not changed: the arrival ticket is another
    // lane's file.
    const f = await seed()
    await commit(f, {
      csv: ['guest_name,email,site,check_in,check_out,total',
            'Marie Okafor,marie@mailer-test.co,RV 13,2027-03-06,2027-03-13,286.75'].join('\n'),
    })
    const { billStayBalances } = await import('../services/stayBalance')
    expect(await billStayBalances(new Date('2027-03-06T17:00:00Z'))).toMatchObject({ billed: 0 })
    expect(await query(`SELECT id FROM pos_pay_links`)).toEqual([])
  })
})

describe('who may do it', () => {
  it('a worker who may schedule can bring the schedule in', async () => {
    const f = await seed()
    const token = await worker(f, { 'schedule.create_reservation': true, 'bookings.view': true })
    const res = await commit(f, {
      csv: ['guest_name,site,check_in,check_out,total',
            'Dale Carter,RV 14,2027-03-06,2027-03-13,286.75'].join('\n'),
    }, token)
    expect(res.status).toBe(200)
  })

  it('but not the deposits — that takes a way to take payments too', async () => {
    const f = await seed()
    const token = await worker(f, { 'schedule.create_reservation': true })
    const res = await commit(f, {
      csv: ['guest_name,site,check_in,check_out,total,deposit',
            'Dale Carter,RV 14,2027-03-06,2027-03-13,286.75,28.68'].join('\n'),
    }, token)
    expect(res.status).toBe(403)
    expect(res.body.error).toContain('money changing hands')
    expect(await board()).toEqual([])

    const paid = await worker(f, { 'schedule.create_reservation': true, take_payment: true })
    expect((await commit(f, {
      csv: ['guest_name,site,check_in,check_out,total,deposit',
            'Dale Carter,RV 14,2027-03-06,2027-03-13,286.75,28.68'].join('\n'),
    }, paid)).status).toBe(200)
  })

  it('another landlord\'s park is not importable into', async () => {
    const f = await seed()
    const other = await seed()
    const res = await request(buildApp()).post('/api/bookings/import/commit')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ propertyId: other.propertyId, door: 'file',
              rows: [{ guestName: 'Dale Carter', checkIn: '2027-03-06', checkOut: '2027-03-13' }] })
    expect([403, 404]).toContain(res.status)
    expect(await query(`SELECT id FROM unit_bookings`)).toEqual([])
  })
})

describe('the review queue', () => {
  it('records a reservations file beside the tenant, property and payment ones', async () => {
    const f = await seed()
    await commit(f, {
      csv: ['guest_name,site,check_in,check_out,total',
            'Dale Carter,RV 14,2027-03-06,2027-03-13,286.75'].join('\n'),
      claimedPlatformName: 'Campground Master',
    })
    const [attempt] = await query<any>(
      `SELECT import_type, status, row_count, column_headers, claimed_platform_name
         FROM csv_import_attempts ORDER BY created_at DESC LIMIT 1`)
    expect(attempt).toMatchObject({ import_type: 'reservation', status: 'committed', row_count: 1 })
    expect(attempt.column_headers).toContain('guest_name')
  })

  it('a typed-in reservation is not a file, so nothing is queued for review', async () => {
    const f = await seed()
    await commit(f, {
      door: 'hand',
      rows: [{ guestName: 'Tom Reyes', checkIn: '2027-04-01', checkOut: '2027-04-08' }],
    })
    expect(await query(`SELECT id FROM csv_import_attempts`)).toEqual([])
  })
})
