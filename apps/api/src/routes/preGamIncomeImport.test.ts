/**
 * 11/1 — IMPORTING OLD RECORDS THE WAY BLUE WILL ACTUALLY DO IT.
 *
 * Driven through the real HTTP routes, not the service, because the thing that
 * broke before was the ROUTE refusing a line with no lease
 * ("Onboard the tenant first") — the service was never the problem.
 *
 * Nic, 11/1: "it needs to be this unit brought this much money, attributed to
 * this person's contact information."
 *
 * The file in these tests is the shape of Country Acres' September: some
 * residents with leases, and some RV guests who never had one, in one CSV.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import type { PoolClient } from 'pg'
import express from 'express'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { landlordsRouter } from './landlords'
import { reportsRouter } from './reports'
import { errorHandler } from '../middleware/errorHandler'

// Same harness shape as csvImportPaymentHistory.test.ts: just the two routers
// this exercises, so nothing else in the app has to boot.
function buildApp() {
  const a = express()
  a.use(express.json({ limit: '10mb' }))
  a.use('/api/landlords', landlordsRouter)
  a.use('/api/reports', reportsRouter)
  a.use(errorHandler)
  return a
}
const app = buildApp()
const api = () => request(app)

/** A park with one leaseholder and one bare space. */
async function park(c: PoolClient) {
  const { userId, landlordId } = await seedLandlord(c, { email: `blue-${Date.now()}@test.dev` })
  const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
  await c.query(`UPDATE properties SET name = 'Country Acres Proof' WHERE id = $1`, [propertyId])

  // The resident, with a lease — the path that already worked.
  const residentUnit = await seedUnit(c, { propertyId, landlordId, rentAmount: 450 })
  await c.query(`UPDATE units SET unit_number = 'MH 22' WHERE id = $1`, [residentUnit])
  const tenantId = await seedTenant(c, { email: `troy-${Math.random().toString(36).slice(2)}@test.dev` })
  await c.query(
    `UPDATE users SET first_name='Troy', last_name='Bannon'
      WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId])
  const leaseId = await seedLease(c, { unitId: residentUnit, landlordId, rentAmount: 450, status: 'active' })
  await seedLeaseTenant(c, { leaseId, tenantId })

  // The RV space, no lease, no tenant — the whole point.
  const rvUnit = await seedUnit(c, { propertyId, landlordId, rentAmount: 589 })
  await c.query(`UPDATE units SET unit_number = 'RV 14' WHERE id = $1`, [rvUnit])

  const token = jwt.sign(
    { userId, role: 'landlord', email: `blue-${userId}@test.dev`, profileId: landlordId, permissions: {} },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
  return { userId, landlordId, propertyId, residentUnit, rvUnit, tenantId, leaseId, token }
}

const HEADERS = 'tenant_email,tenant_name,payer_phone,payment_date,amount,payment_type,payment_method,property_name,unit_number,reference'

const validate = (token: string, csv: string) =>
  api().post('/api/landlords/me/onboard-payment-history-csv/validate')
    .set('Authorization', `Bearer ${token}`).send({ csv, source: 'generic' })

// A generic upload must name where it came from (the CSV review queue reads it),
// so these say the honest thing: a paper ledger.
const commit = (token: string, rows: any[]) =>
  api().post('/api/landlords/me/onboard-payment-history-csv/commit')
    .set('Authorization', `Bearer ${token}`)
    .send({ rows, source: 'generic', claimedPlatformName: 'paper ledger' })

describe('importing old records with no lease behind them', () => {
  let c: PoolClient
  beforeEach(async () => {
    await cleanupAllSchema()
    if (!c) c = await getClient()
  })

  it('a line with no lease is no longer refused — it matches the SPACE and says so', async () => {
    const p = await park(c)
    const csv = `${HEADERS}\n`
      + `,Dale Okafor,928-555-0142,2026-09-15,589.00,rent,cash,Country Acres Proof,RV 14,W-204\n`
    const res = await validate(p.token, csv)
    expect(res.status).toBe(200)
    const row = res.body.data.rows[0]
    // It used to come back as a blocker. Now it resolves to the space.
    expect(row.issues.filter((i: any) => i.severity === 'block')).toHaveLength(0)
    expect(row.resolvedUnitId).toBe(p.rvUnit)
    expect(row.historyOnly).toBe(true)
    expect(res.body.data.summary.ready).toBe(1)
    // And the warning tells the landlord exactly what will happen to it.
    expect(JSON.stringify(row.issues)).toMatch(/past income for Country Acres Proof RV 14 from Dale Okafor/)
    expect(JSON.stringify(row.issues)).toMatch(/Nobody is billed/)
  })

  it('one file carries both kinds, and each goes where it belongs', async () => {
    const p = await park(c)
    const csv = `${HEADERS}\n`
      + `troy@test.dev,Troy Bannon,,2026-09-01,450.00,rent,check,Country Acres Proof,MH 22,R-1\n`
      + `,Dale Okafor,928-555-0142,2026-09-15,589.00,rent,cash,Country Acres Proof,RV 14,W-204\n`
    const v = await validate(p.token, csv)
    expect(v.body.data.summary.blockers).toBe(0)

    const res = await commit(p.token, v.body.data.rows)
    expect(res.status).toBe(200)
    // The resident's money went on the rent rail; the guest's did not.
    expect(res.body.data.committed).toBe(1)
    expect(res.body.data.pastIncome).toMatchObject({ recorded: 1, withPerson: 1 })

    const onTheRail = await db.query(
      `SELECT lease_id, status, invoice_id, amount::text AS amount FROM payments`)
    expect(onTheRail.rows).toHaveLength(1)
    expect(onTheRail.rows[0]).toMatchObject({ lease_id: p.leaseId, status: 'settled', invoice_id: null })

    const history = await db.query(
      `SELECT unit_id, amount::text AS amount, customer_profile_id, payer_name
         FROM pre_gam_income_history`)
    expect(history.rows).toHaveLength(1)
    expect(history.rows[0]).toMatchObject({ unit_id: p.rvUnit, amount: '589.00', payer_name: 'Dale Okafor' })
    expect(history.rows[0].customer_profile_id).toBeTruthy()
  })

  it('NOBODY IS BILLED by the import — not one charge, not one bill', async () => {
    const p = await park(c)
    const csv = `${HEADERS}\n`
      + `,Dale Okafor,928-555-0142,2026-09-15,589.00,rent,cash,Country Acres Proof,RV 14,W-204\n`
      + `,Nadia Prentice,928-555-0199,2026-09-20,420.00,rent,cash,Country Acres Proof,RV 14,W-205\n`
    const v = await validate(p.token, csv)
    await commit(p.token, v.body.data.rows)

    expect((await db.query(`SELECT 1 FROM invoices`)).rows).toHaveLength(0)
    // No payment row at all: both lines had no lease.
    expect((await db.query(`SELECT 1 FROM payments`)).rows).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM unit_bookings`)).rows).toHaveLength(0)
    expect((await db.query(`SELECT SUM(amount)::text AS t FROM pre_gam_income_history`)).rows[0].t)
      .toBe('1009.00')
  })

  it('without a space number it still refuses, and says what to add', async () => {
    const p = await park(c)
    const csv = `${HEADERS}\n`
      + `,Dale Okafor,928-555-0142,2026-09-15,589.00,rent,cash,Country Acres Proof,,W-204\n`
    const res = await validate(p.token, csv)
    const blocks = res.body.data.rows[0].issues.filter((i: any) => i.severity === 'block')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].message).toMatch(/Add the space number/)
  })

  it('a space that is not this company\'s is refused by name', async () => {
    const p = await park(c)
    const csv = `${HEADERS}\n`
      + `,Dale Okafor,928-555-0142,2026-09-15,589.00,rent,cash,Country Acres Proof,RV 99,W-204\n`
    const res = await validate(p.token, csv)
    const blocks = res.body.data.rows[0].issues.filter((i: any) => i.severity === 'block')
    expect(blocks[0].message).toMatch(/No space "RV 99"/)
  })

  it('the imported money shows on its own report, in the month it happened', async () => {
    const p = await park(c)
    const csv = `${HEADERS}\n`
      + `,Dale Okafor,928-555-0142,2026-09-15,589.00,rent,cash,Country Acres Proof,RV 14,W-204\n`
      + `,Dale Okafor,928-555-0142,2026-08-15,589.00,rent,cash,Country Acres Proof,RV 14,W-180\n`
    const v = await validate(p.token, csv)
    await commit(p.token, v.body.data.rows)

    const res = await api().get('/api/reports/pre-gam-income')
      .set('Authorization', `Bearer ${p.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(1178)
    expect(res.body.data.byMonth).toEqual([
      { month: '2026-09', total: 589 },
      { month: '2026-08', total: 589 },
    ])

    // Narrowed to one month, the way a monthly close reads it.
    const sept = await api().get('/api/reports/pre-gam-income?from=2026-09-01&to=2026-09-30')
      .set('Authorization', `Bearer ${p.token}`)
    expect(sept.body.data.total).toBe(589)
    expect(sept.body.data.rows[0]).toMatchObject({ unitNumber: 'RV 14', propertyName: 'Country Acres Proof' })
  })

  it('the P&L counts it — all the money in one place, and named so it reconciles', async () => {
      const p = await park(c)
      // September: one resident who paid on the old system, one RV guest.
      const csv = `${HEADERS}\n`
        + `troy@test.dev,Troy Bannon,,2026-09-01,450.00,rent,check,Country Acres Proof,MH 22,R-1\n`
        + `,Dale Okafor,928-555-0142,2026-09-15,589.00,rent,cash,Country Acres Proof,RV 14,W-204\n`
      const v = await validate(p.token, csv)
      await commit(p.token, v.body.data.rows)

      const pl = await api().get('/api/reports/monthly-pl?year=2026&month=9')
        .set('Authorization', `Bearer ${p.token}`)
      expect(pl.status).toBe(200)
      // Nic, 11/1: "Pnl needs to count all money from books recorded."
      // The resident's imported rent is on the rail (450); the RV guest's 589
      // was collected off-platform with no lease. The P&L shows BOTH.
      expect(pl.body.data.gross.preGamIncome).toBe(589)
      expect(pl.body.data.gross.rent).toBe(450)
      expect(pl.body.data.gross.total).toBe(1039)
      // Its own named line, so the statement can be reconciled against the ledger.
      expect(pl.body.data.lines.find((l: any) => l.line === 'preGamIncome'))
        .toMatchObject({ label: 'Collected before GAM', amount: 589 })
      // And broken out per space, so the operator sees where it came from.
      expect(pl.body.data.preGamIncomeByUnit[0]).toMatchObject({
        unitNumber: 'RV 14', propertyName: 'Country Acres Proof', total: 589,
      })

      // A month it did not happen in does not carry it, and gains no line.
      const aug = await api().get('/api/reports/monthly-pl?year=2026&month=8')
        .set('Authorization', `Bearer ${p.token}`)
      expect(aug.body.data.gross.preGamIncome).toBe(0)
      expect(aug.body.data.lines.find((l: any) => l.line === 'preGamIncome')).toBeUndefined()
  })

  // ── 11/1 (Nic): TYPING IT IN, FOR OPERATORS WITH NO FILE ───────────────────
  //
  //   "Build the way to type manual stuff in. People switching to gam may not
  //    use software so lots of stuff may go in manual."
  //
  // The import assumes an export exists. Somebody coming off a paper ledger has
  // nothing to upload, so the CSV alone leaves exactly the people who most need
  // the help with no way in.
  describe('typed in one at a time', () => {
    const manual = (token: string, body: any) =>
      api().post('/api/landlords/me/payment-history/manual')
        .set('Authorization', `Bearer ${token}`).send(body)

    it('lists every space and who is on it, so the form is one call', async () => {
      const p = await park(c)
      const res = await api().get('/api/landlords/me/payment-history/spaces')
        .set('Authorization', `Bearer ${p.token}`)
      expect(res.status).toBe(200)
      const mh = res.body.data.find((x: any) => x.unitNumber === 'MH 22')
      const rv = res.body.data.find((x: any) => x.unitNumber === 'RV 14')
      // The resident's space knows its lease and who lives there.
      expect(mh).toMatchObject({ leaseId: p.leaseId, residentName: 'Troy Bannon' })
      // The bare space offers no lease, which is how the form knows to ask who paid.
      expect(rv.leaseId).toBeNull()
      expect(rv.residentName).toBeNull()
    })

    it('on a resident: recorded as already paid, with NO bill behind it', async () => {
      const p = await park(c)
      const res = await manual(p.token, {
        unitId: p.residentUnit, leaseId: p.leaseId,
        paymentDate: '2026-09-01', amount: 450, paymentType: 'rent',
        paymentMethod: 'check', reference: 'ck 1041',
      })
      expect(res.status).toBe(200)
      expect(res.body.data.where).toBe('lease')
      expect(res.body.data.said).toMatch(/Nobody was billed/)

      const row = (await db.query(
        `SELECT status, invoice_id, lease_id, amount::text AS amount, import_source,
                settled_at::date::text AS settled
           FROM payments`)).rows[0]
      expect(row).toMatchObject({
        status: 'settled', invoice_id: null, lease_id: p.leaseId,
        amount: '450.00', import_source: 'manual', settled: '2026-09-01',
      })
      // The two things that would mean somebody got asked for money.
      expect((await db.query(`SELECT 1 FROM invoices`)).rows).toHaveLength(0)
      expect((await db.query(`SELECT 1 FROM pre_gam_income_history`)).rows).toHaveLength(0)
    })

    it('on a bare space: the space\'s past income, with the payer as a GAM customer', async () => {
      const p = await park(c)
      const res = await manual(p.token, {
        unitId: p.rvUnit,
        payerName: 'Dale Okafor', payerPhone: '928-555-0142', payerEmail: 'dale@example.test',
        paymentDate: '2026-09-15', amount: 589, paymentType: 'stay', paymentMethod: 'cash',
      })
      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ where: 'space', person: true })
      expect(res.body.data.said).toMatch(/from Dale Okafor/)

      const row = (await db.query(
        `SELECT unit_id, amount::text AS amount, income_type, customer_profile_id
           FROM pre_gam_income_history`)).rows[0]
      expect(row).toMatchObject({ unit_id: p.rvUnit, amount: '589.00', income_type: 'stay' })
      expect(row.customer_profile_id).toBeTruthy()
      // Not on the rent rail, and no bill anywhere.
      expect((await db.query(`SELECT 1 FROM payments`)).rows).toHaveLength(0)
      expect((await db.query(`SELECT 1 FROM invoices`)).rows).toHaveLength(0)
    })

    it('twelve lots typed in a row all land, and show on the P&L together', async () => {
      const p = await park(c)
      // The real shape of Blue's job: lot after lot, each with the day it came
      // in. Two rent payments for the SAME month on one lease is a duplicate and
      // has its own test below.
      const entries = [
        { unitId: p.residentUnit, leaseId: p.leaseId, paymentDate: '2026-09-05', amount: 450, paymentType: 'rent' },
        { unitId: p.rvUnit, payerName: 'Dale Okafor', payerPhone: '928-555-0142',
          paymentDate: '2026-09-08', amount: 589, paymentType: 'stay' },
        { unitId: p.rvUnit, payerName: 'Dale Okafor', payerPhone: '928-555-0142',
          paymentDate: '2026-09-22', amount: 450, paymentType: 'stay' },
      ]
      for (const e of entries) {
        const r = await manual(p.token, e)
        expect(r.status).toBe(200)
      }
      const pl = await api().get('/api/reports/monthly-pl?year=2026&month=9')
        .set('Authorization', `Bearer ${p.token}`)
      // Two lease payments on the rail, one space payment beside them — and the
      // P&L counts all of it, which is what Nic asked for.
      expect(pl.body.data.gross.rent).toBe(450)
      expect(pl.body.data.gross.preGamIncome).toBe(1039)
      expect(pl.body.data.gross.total).toBe(1489)
    })

    it('typing the same month\'s rent twice on one lease is refused, in plain words', async () => {
      const p = await park(c)
      const entry = {
        unitId: p.residentUnit, leaseId: p.leaseId,
        paymentDate: '2026-09-01', amount: 450, paymentType: 'rent',
      }
      expect((await manual(p.token, entry)).status).toBe(200)
      const again = await manual(p.token, entry)
      // This is the shape of a real mistake: working down a paper sheet and
      // keying a lot twice. The database refuses it; the message has to explain
      // it rather than show a constraint name.
      expect(again.status).toBe(409)
      expect(again.body.error).toMatch(/already a rent payment/i)
      expect(again.body.error).not.toMatch(/idempotent|constraint/i)
      // And exactly one payment is on the books.
      expect((await db.query(`SELECT 1 FROM payments`)).rows).toHaveLength(1)
    })

    it('typing the same space, day and amount twice is refused — the paper-sheet mistake', async () => {
      const p = await park(c)
      const entry = {
        unitId: p.rvUnit, payerName: 'Dale Okafor', payerPhone: '928-555-0142',
        paymentDate: '2026-09-15', amount: 589, paymentType: 'stay',
      }
      expect((await manual(p.token, entry)).status).toBe(200)
      // Each manual save is its OWN batch, so the import's per-file unique index
      // cannot see the line typed a minute ago. Caught in the browser against
      // real data: the same $589 landed twice. Somebody losing their place on a
      // ledger is the normal case here, not the edge one.
      const again = await manual(p.token, entry)
      expect(again.status).toBe(409)
      expect(again.body.error).toMatch(/already recorded/i)
      expect(again.body.error).toMatch(/Reference/)
      expect((await db.query(
        `SELECT 1 FROM pre_gam_income_history WHERE voided_at IS NULL`)).rows).toHaveLength(1)

      // A genuine second payment of the same amount that day has a way through:
      // the reference is what makes the two lines distinguishable.
      const withRef = await manual(p.token, { ...entry, reference: 'ck 2291' })
      expect(withRef.status).toBe(200)
      expect((await db.query(
        `SELECT 1 FROM pre_gam_income_history WHERE voided_at IS NULL`)).rows).toHaveLength(2)
    })

    it('a space with a lease but nobody named on it is not called empty', async () => {
      const p = await park(c)
      // Strip the primary tenant, leaving the lease — Copper Canyon House 01's
      // real shape in the demo data, and what made the list lie.
      await c.query(`UPDATE lease_tenants SET status='removed' WHERE lease_id=$1`, [p.leaseId])
      const res = await api().get('/api/landlords/me/payment-history/spaces')
        .set('Authorization', `Bearer ${p.token}`)
      const mh = res.body.data.find((x: any) => x.unitNumber === 'MH 22')
      expect(mh.leaseId).toBe(p.leaseId)
      expect(mh.residentName).toBeNull()
      expect(mh.hasLeaseWithoutResident).toBe(true)
      // And a space with no lease at all is still plainly that.
      const rv = res.body.data.find((x: any) => x.unitNumber === 'RV 14')
      expect(rv.leaseId).toBeNull()
      expect(rv.hasLeaseWithoutResident).toBe(false)
    })

    it('refuses another company\'s space', async () => {
      const mine = await park(c)
      const theirs = await park(c)
      const res = await manual(mine.token, {
        unitId: theirs.rvUnit, payerName: 'Dale Okafor',
        paymentDate: '2026-09-15', amount: 589, paymentType: 'stay',
      })
      // 403, not the route's own 404: the platform's unit gate refuses it
      // before this handler runs at all, which is the stronger place for it.
      // The route's own company check stays as defense in depth.
      expect(res.status).toBe(403)
      expect(res.body.error).toMatch(/not yours to act on/i)
    })

    it('refuses a lease that is not on that space', async () => {
      const p = await park(c)
      const res = await manual(p.token, {
        unitId: p.rvUnit, leaseId: p.leaseId,
        paymentDate: '2026-09-15', amount: 589, paymentType: 'rent',
      })
      expect(res.status).toBe(404)
      expect(res.body.error).toMatch(/not on this space/i)
    })

    it('refuses a zero or negative amount', async () => {
      const p = await park(c)
      for (const amount of [0, -50]) {
        const res = await manual(p.token, {
          unitId: p.rvUnit, payerName: 'Dale Okafor',
          paymentDate: '2026-09-15', amount, paymentType: 'stay',
        })
        expect(res.status).toBeGreaterThanOrEqual(400)
      }
      expect((await db.query(`SELECT 1 FROM pre_gam_income_history`)).rows).toHaveLength(0)
    })
  })

  it('the template carries the phone column, so an operator knows to fill it', async () => {
    const p = await park(c)
    const res = await api().get('/api/landlords/me/onboard-payment-history-csv/template?source=generic')
      .set('Authorization', `Bearer ${p.token}`)
    expect(res.status).toBe(200)
    expect(String(res.text ?? res.body)).toMatch(/payer_phone/)
  })
})
