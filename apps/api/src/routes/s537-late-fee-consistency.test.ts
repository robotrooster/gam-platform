/**
 * S537: late-fee consistency — explicit per-(property, unit_type)
 * DECISIONS, the onboarding gate, and the billing policy ceiling.
 *
 * Rule under test (Nic-locked):
 *   1. Drafting authority = class policy (S535, covered in esign.test.ts).
 *   2. Billing authority = tenant-favorable minimum: an invoice never
 *      accrues more total late fee than EITHER the signed lease's own
 *      schedule OR the current class policy would produce.
 *   3. A unit class must hold an explicit decision (fee terms or no-fee)
 *      before units are added / tenants onboarded.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLateFeeDecision,
} from '../test/dbHelpers'
import { unitsRouter } from './units'
import { landlordsRouter } from './landlords'
import { errorHandler } from '../middleware/errorHandler'
import { generateLateFeesForTimezone } from '../jobs/lateFees'

const TZ = 'America/Phoenix'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/units', unitsRouter)
  app.use('/api/landlords', landlordsRouter)
  app.use(errorHandler)
  return app
}

function landlordToken(userId: string, landlordId: string) {
  return jwt.sign({ userId, role: 'landlord', profileId: landlordId },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

async function fixture() {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const ll = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await client.query(`UPDATE properties SET timezone=$2, late_fee_enabled=TRUE WHERE id=$1`, [propertyId, TZ])
    await client.query('COMMIT')
    return { ...ll, propertyId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

/** Lease + pending invoice due N days ago (property-local), with a rent
 *  payment row so percent-of-rent math has a base. */
async function leaseWithOverdueInvoice(f: any, opts: {
  unitId: string
  leaseFee: { amount: number | null; grace?: number; enabled?: boolean }
  rent?: number
  daysOverdue?: number
}) {
  const rent = opts.rent ?? 1000
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const leaseId = await seedLease(client, { unitId: opts.unitId, landlordId: f.landlordId, rentAmount: rent })
    await client.query(
      `UPDATE leases SET late_fee_enabled=$2, late_fee_initial_amount=$3,
              late_fee_initial_type='flat', late_fee_grace_days=$4 WHERE id=$1`,
      [leaseId, opts.leaseFee.enabled ?? true, opts.leaseFee.amount, opts.leaseFee.grace ?? 0])
    const inv = await client.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, status)
       VALUES ($1, $2, $3, $4, (NOW() AT TIME ZONE $5)::date - $6::int, $7, $7, 'pending') RETURNING id`,
      [f.landlordId, leaseId, opts.unitId, `INV-${Math.random().toString(36).slice(2, 8)}`, TZ, opts.daysOverdue ?? 10, rent])
    await client.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, type, amount, status, entry_description, due_date, invoice_id)
       VALUES ($1, $2, $3, 'rent', $4, 'pending', 'RENT', (NOW() AT TIME ZONE $5)::date - $6::int, $7)`,
      [f.landlordId, opts.unitId, leaseId, rent, TZ, opts.daysOverdue ?? 10, inv.rows[0].id])
    await client.query('COMMIT')
    return { leaseId, invoiceId: inv.rows[0].id }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

async function lateFeeTotal(invoiceId: string): Promise<number> {
  const r = await db.query<{ sum: string | null }>(
    `SELECT SUM(amount)::text AS sum FROM payments WHERE invoice_id=$1 AND type='late_fee'`, [invoiceId])
  return Number(r.rows[0]?.sum ?? 0)
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_s537'
})

// ─── The onboarding gate ─────────────────────────────────────────────

describe('S537 gate: explicit decision before units / onboarding', () => {
  it('POST /units refuses an UNDECIDED unit class with 422', async () => {
    const f = await fixture()
    const res = await request(buildApp())
      .post('/api/units')
      .set('Authorization', `Bearer ${landlordToken(f.userId, f.landlordId)}`)
      .send({ propertyId: f.propertyId, unitNumber: 'A1', unitType: 'rv_spot', rentAmount: 900 })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/late-fee decision/i)
  })

  it('POST /units succeeds once the class has a FEE decision', async () => {
    const f = await fixture()
    const client = await db.connect()
    try { await seedLateFeeDecision(client, { propertyId: f.propertyId, unitType: 'rv_spot', initialAmount: 25 }) }
    finally { client.release() }
    const res = await request(buildApp())
      .post('/api/units')
      .set('Authorization', `Bearer ${landlordToken(f.userId, f.landlordId)}`)
      .send({ propertyId: f.propertyId, unitNumber: 'A1', unitType: 'rv_spot', rentAmount: 900 })
    expect(res.status).toBe(201)
  })

  it('POST /units succeeds with an explicit NO-FEE decision', async () => {
    const f = await fixture()
    const client = await db.connect()
    try { await seedLateFeeDecision(client, { propertyId: f.propertyId, unitType: 'storage', noLateFee: true }) }
    finally { client.release() }
    const res = await request(buildApp())
      .post('/api/units')
      .set('Authorization', `Bearer ${landlordToken(f.userId, f.landlordId)}`)
      .send({ propertyId: f.propertyId, unitNumber: 'S1', unitType: 'storage', rentAmount: 100 })
    expect(res.status).toBe(201)
  })

  it('onboard-tenant refuses when the unit class lost its decision (422)', async () => {
    const f = await fixture()
    const client = await db.connect()
    let unitId: string
    try {
      await client.query('BEGIN')
      unitId = await seedUnit(client, { propertyId: f.propertyId, landlordId: f.landlordId })
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    // Simulate the undecided-with-units state directly (the API blocks
    // producing it via DELETE, so force it in SQL).
    await db.query(`DELETE FROM property_unit_type_late_fees WHERE property_id=$1`, [f.propertyId])
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenant')
      .set('Authorization', `Bearer ${landlordToken(f.userId, f.landlordId)}`)
      .send({
        firstName: 'Tess', lastName: 'Gate', email: 's537gate@test.dev', phone: '602-555-0001',
        unitId, leaseStart: '2026-01-01', monthlyRent: 800,
      })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/late-fee decision/i)
  })
})

// ─── Billing = PURE lease-stamp (S558, Nic) ──────────────────────────
// The signed lease is the ENTIRE billing authority. The current (property,
// unit_type) policy no longer bounds an already-signed lease's charges — a
// policy change only reaches leases signed/renewed after it. Removing the S537
// tenant-favorable ceiling keeps the charge == the document (FlexPay math +
// everything downstream stays consistent; a mid-lease change needs a
// superseding lease).
describe('S558 billing: total = the signed lease stamp, policy ignored', () => {
  it('lease $75 / policy $25 → bills $75 (the LEASE governs, not the policy)', async () => {
    const f = await fixture()
    const client = await db.connect()
    let unitId: string
    try {
      unitId = await seedUnit(client, { propertyId: f.propertyId, landlordId: f.landlordId, withLateFeeDecision: true })
      // Lower the CURRENT policy — must have no effect on the already-signed lease.
      await db.query(
        `UPDATE property_unit_type_late_fees SET late_fee_initial_amount=25, late_fee_grace_days=0 WHERE property_id=$1`,
        [f.propertyId])
    } finally { client.release() }
    const { invoiceId } = await leaseWithOverdueInvoice(f, { unitId, leaseFee: { amount: 75, grace: 0 } })

    await generateLateFeesForTimezone(TZ)
    expect(await lateFeeTotal(invoiceId)).toBe(75)
  })

  it('lease $10 / policy $25 → bills $10 (the lease stamp, whether above or below policy)', async () => {
    const f = await fixture()
    const client = await db.connect()
    let unitId: string
    try {
      unitId = await seedUnit(client, { propertyId: f.propertyId, landlordId: f.landlordId, withLateFeeDecision: true })
      await db.query(
        `UPDATE property_unit_type_late_fees SET late_fee_initial_amount=25, late_fee_grace_days=0 WHERE property_id=$1`,
        [f.propertyId])
    } finally { client.release() }
    const { invoiceId } = await leaseWithOverdueInvoice(f, { unitId, leaseFee: { amount: 10, grace: 0 } })

    await generateLateFeesForTimezone(TZ)
    expect(await lateFeeTotal(invoiceId)).toBe(10)
  })

  it('policy switched to NO-FEE after signing → the lease still bills its stamped $50', async () => {
    const f = await fixture()
    const client = await db.connect()
    let unitId: string
    try {
      unitId = await seedUnit(client, { propertyId: f.propertyId, landlordId: f.landlordId, withLateFeeDecision: true })
      await db.query(
        `UPDATE property_unit_type_late_fees
            SET no_late_fee=TRUE, late_fee_grace_days=NULL, late_fee_initial_amount=NULL, late_fee_initial_type=NULL
          WHERE property_id=$1`, [f.propertyId])
    } finally { client.release() }
    const { invoiceId } = await leaseWithOverdueInvoice(f, { unitId, leaseFee: { amount: 50, grace: 0 } })

    await generateLateFeesForTimezone(TZ)
    expect(await lateFeeTotal(invoiceId)).toBe(50)
  })

  it('policy row removed after signing → the lease still bills its stamped $50', async () => {
    const f = await fixture()
    const client = await db.connect()
    let unitId: string
    try { unitId = await seedUnit(client, { propertyId: f.propertyId, landlordId: f.landlordId }) }
    finally { client.release() }
    await db.query(`DELETE FROM property_unit_type_late_fees WHERE property_id=$1`, [f.propertyId])
    const { invoiceId } = await leaseWithOverdueInvoice(f, { unitId, leaseFee: { amount: 50, grace: 0 } })

    await generateLateFeesForTimezone(TZ)
    expect(await lateFeeTotal(invoiceId)).toBe(50)
  })

  it('the LEASE grace governs: due 2 days ago, lease grace 0, policy grace 5 → bills the $25 stamp', async () => {
    const f = await fixture()
    const client = await db.connect()
    let unitId: string
    try {
      unitId = await seedUnit(client, { propertyId: f.propertyId, landlordId: f.landlordId, withLateFeeDecision: true })
      await db.query(
        `UPDATE property_unit_type_late_fees SET late_fee_initial_amount=25, late_fee_grace_days=5 WHERE property_id=$1`,
        [f.propertyId])
    } finally { client.release() }
    const { invoiceId } = await leaseWithOverdueInvoice(f, { unitId, leaseFee: { amount: 25, grace: 0 }, daysOverdue: 2 })

    await generateLateFeesForTimezone(TZ)
    expect(await lateFeeTotal(invoiceId)).toBe(25)
  })
})

// ─── Decision row API shapes ─────────────────────────────────────────

describe('S537 decision rows API', () => {
  it('DELETE refuses while units of the class exist (409)', async () => {
    const f = await fixture()
    const client = await db.connect()
    try { await seedUnit(client, { propertyId: f.propertyId, landlordId: f.landlordId, unitType: 'apartment' }) }
    finally { client.release() }
    const { propertiesRouter } = await import('./properties')
    const app = express()
    app.use(express.json())
    app.use('/api/properties', propertiesRouter)
    app.use(errorHandler)
    const res = await request(app)
      .delete(`/api/properties/${f.propertyId}/late-fee-overrides/apartment`)
      .set('Authorization', `Bearer ${landlordToken(f.userId, f.landlordId)}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/decision must stay/i)
  })

  it('PUT accepts the no-fee decision shape', async () => {
    const f = await fixture()
    const { propertiesRouter } = await import('./properties')
    const app = express()
    app.use(express.json())
    app.use('/api/properties', propertiesRouter)
    app.use(errorHandler)
    const res = await request(app)
      .put(`/api/properties/${f.propertyId}/late-fee-overrides`)
      .set('Authorization', `Bearer ${landlordToken(f.userId, f.landlordId)}`)
      .send({ unitType: 'storage', noLateFee: true })
    expect(res.status).toBe(200)
    // bare test app has no camelize middleware — keys arrive snake_case
    expect(res.body.data.no_late_fee).toBe(true)
    expect(res.body.data.late_fee_initial_amount).toBeNull()
  })
})

// ─── S537b: subtype type-lock + CSV-first import gates ───────────────

describe('S537b subtype locks the unit type', () => {
  it('conflicting body.unitType vs subtype → 400; subtype wins when body omits type', async () => {
    const f = await fixture()
    const client = await db.connect()
    try {
      await seedLateFeeDecision(client, { propertyId: f.propertyId, unitType: 'rv_spot', initialAmount: 20 })
      await client.query(
        `INSERT INTO property_unit_subtypes (property_id, unit_type, name, rv_site_layout, rv_amp_service, rent_amount)
         VALUES ($1, 'rv_spot', 'Back-in 30 amp', 'back_in', '30', 850)`, [f.propertyId])
    } finally { client.release() }
    const sub = await db.query<{ id: string }>(
      `SELECT id FROM property_unit_subtypes WHERE property_id=$1 AND name='Back-in 30 amp'`, [f.propertyId])
    const subtypeId = sub.rows[0].id

    const conflict = await request(buildApp())
      .post('/api/units')
      .set('Authorization', `Bearer ${landlordToken(f.userId, f.landlordId)}`)
      .send({ propertyId: f.propertyId, unitNumber: 'RV 01', subtypeId, unitType: 'storage' })
    expect(conflict.status).toBe(400)
    expect(conflict.body.error).toMatch(/rv spot subtype/i)

    const ok = await request(buildApp())
      .post('/api/units')
      .set('Authorization', `Bearer ${landlordToken(f.userId, f.landlordId)}`)
      .send({ propertyId: f.propertyId, unitNumber: 'RV 01', subtypeId })
    expect(ok.status).toBe(201)
    const created = await db.query<{ unit_type: string }>(
      `SELECT unit_type FROM units WHERE property_id=$1 AND unit_number='RV 01'`, [f.propertyId])
    expect(created.rows[0].unit_type).toBe('rv_spot')
  })
})

describe('S537b CSV-first property import', () => {
  const csvRow = (over: Record<string, string> = {}) => ({
    rowIndex: 0, propertyName: 'Import Park', street1: '9 CSV Way', street2: '',
    city: 'Mesa', state: 'AZ', zip: '85201', timezone: '', propertyType: 'rv_longterm',
    unitNumber: 'S1', bedrooms: '', bathrooms: '', sqft: '', unitType: 'rv_spot',
    rentAmount: '700', securityDeposit: '', issues: [], ...over,
  })

  it('commit refuses a blank/unrecognized unit type (no silent apartment)', async () => {
    const f = await fixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${landlordToken(f.userId, f.landlordId)}`)
      .send({ rows: [csvRow({ unitType: '' })], source: 'doorloop' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not a GAM unit type/i)
  })

  it('commit without a decision for a NEW property → 422 (gate holds)', async () => {
    const f = await fixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${landlordToken(f.userId, f.landlordId)}`)
      .send({ rows: [csvRow()], source: 'doorloop' })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/late-fee decision/i)
  })

  it('commit with a lateFeeDecisions payload creates property + units + decision row', async () => {
    const f = await fixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${landlordToken(f.userId, f.landlordId)}`)
      .send({
        rows: [csvRow(), csvRow({ rowIndex: 1, unitNumber: 'S2' } as any)],
        source: 'doorloop',
        lateFeeDecisions: [{ propertyName: 'Import Park', street1: '9 CSV Way', unitType: 'rv_spot',
                             noLateFee: false, graceDays: 3, initialAmount: 30, initialType: 'flat' }],
      })
    expect(res.status).toBe(200)
    const prop = await db.query<{ id: string }>(`SELECT id FROM properties WHERE name='Import Park'`)
    expect(prop.rows.length).toBe(1)
    const dec = await db.query<any>(
      `SELECT * FROM property_unit_type_late_fees WHERE property_id=$1 AND unit_type='rv_spot'`, [prop.rows[0].id])
    expect(dec.rows.length).toBe(1)
    expect(Number(dec.rows[0].late_fee_initial_amount)).toBe(30)
    const units = await db.query(`SELECT id FROM units WHERE property_id=$1`, [prop.rows[0].id])
    expect(units.rows.length).toBe(2)
  })

  it('commit honors an explicit no-fee decision', async () => {
    const f = await fixture()
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-properties-csv/commit')
      .set('Authorization', `Bearer ${landlordToken(f.userId, f.landlordId)}`)
      .send({
        rows: [csvRow()],
        source: 'doorloop',
        lateFeeDecisions: [{ propertyName: 'Import Park', street1: '9 CSV Way', unitType: 'rv_spot', noLateFee: true }],
      })
    expect(res.status).toBe(200)
    const dec = await db.query<any>(
      `SELECT f2.no_late_fee FROM property_unit_type_late_fees f2
        JOIN properties p ON p.id=f2.property_id WHERE p.name='Import Park'`)
    expect(dec.rows[0].no_late_fee).toBe(true)
  })
})

describe('S537b tenant-CSV mode suggestion', () => {
  it('validate reports undecided pairs with the most frequent (fee, grace) prefill', async () => {
    const f = await fixture()
    const client = await db.connect()
    let unitIds: string[] = []
    try {
      for (const n of ['T1', 'T2', 'T3']) {
        const u = await seedUnit(client, { propertyId: f.propertyId, landlordId: f.landlordId, unitType: 'rv_spot' })
        await client.query(`UPDATE units SET unit_number=$2 WHERE id=$1`, [u, n])
        unitIds.push(u)
      }
    } finally { client.release() }
    // rv_spot deliberately UNDECIDED. Two leases at $30/3d, one at $50/5d
    // → suggestion must be 30/3.
    const propName = (await db.query<{ name: string }>(`SELECT name FROM properties WHERE id=$1`, [f.propertyId])).rows[0].name
    const csv = [
      'first_name,last_name,email,phone,property_name,unit_number,lease_start,monthly_rent,late_fee_amount,late_fee_grace_days',
      `Ann,One,ann1@s537.dev,602-555-0101,${propName},T1,2026-01-01,700,30,3`,
      `Bob,Two,bob2@s537.dev,602-555-0102,${propName},T2,2026-01-01,700,30,3`,
      `Cat,Three,cat3@s537.dev,602-555-0103,${propName},T3,2026-01-01,700,50,5`,
    ].join('\n')
    const res = await request(buildApp())
      .post('/api/landlords/me/onboard-tenants-csv/validate')
      .set('Authorization', `Bearer ${landlordToken(f.userId, f.landlordId)}`)
      .send({ csv, source: 'generic', claimedPlatformName: 'TestPlatform' })
    expect(res.status).toBe(200)
    const missing = res.body.data.missingLateFeeDecisions
    expect(missing.length).toBe(1)
    expect(missing[0].unitType).toBe('rv_spot')
    expect(missing[0].suggested.initialAmount).toBe(30)
    expect(missing[0].suggested.graceDays).toBe(3)
    expect(missing[0].suggested.leaseCount).toBe(2)
    expect(missing[0].suggested.leaseTotal).toBe(3)
  })
})

// ─── S537c: payment-race protection (postmark rule + stop-on-paid) ───

describe('S537c late fees vs in-flight and settled payments', () => {
  async function overdueWithRentStatus(f: any, rentStatus: string) {
    const client = await db.connect()
    let unitId: string
    try {
      unitId = await seedUnit(client, { propertyId: f.propertyId, landlordId: f.landlordId, withLateFeeDecision: true })
      await db.query(
        `UPDATE property_unit_type_late_fees SET late_fee_initial_amount=25, late_fee_grace_days=5,
                late_fee_accrual_amount=5, late_fee_accrual_type='flat', late_fee_accrual_period='daily'
          WHERE property_id=$1`, [f.propertyId])
    } finally { client.release() }
    const { leaseId, invoiceId } = await leaseWithOverdueInvoice(f, {
      unitId, leaseFee: { amount: 25, grace: 5 }, daysOverdue: 10,
    })
    // The signed lease prints the same $5/day accrual the policy carries —
    // billing is min(lease, policy), so the lease must define it too.
    await db.query(
      `UPDATE leases SET late_fee_accrual_amount=5, late_fee_accrual_type='flat', late_fee_accrual_period='daily' WHERE id=$1`,
      [leaseId])
    await db.query(`UPDATE payments SET status=$2 WHERE invoice_id=$1 AND type='rent'`, [invoiceId, rentStatus])
    return { leaseId, invoiceId }
  }

  it("ACH in flight ('processing') → NO late fee while it clears (postmark rule)", async () => {
    const f = await fixture()
    const { invoiceId } = await overdueWithRentStatus(f, 'processing')
    await generateLateFeesForTimezone(TZ)
    expect(await lateFeeTotal(invoiceId)).toBe(0)
  })

  it('failed payment → fees back-fill retroactively (initial + every missed daily tick)', async () => {
    const f = await fixture()
    const { invoiceId } = await overdueWithRentStatus(f, 'failed')
    await generateLateFeesForTimezone(TZ)
    // due 10 days ago, 5-day grace: initial $25 on day 6 (5 days ago) +
    // daily $5 ticks on the 4 days after, through today = 25 + 5*5 = 50.
    // (tick dates: start+1 .. start+5 where start+5 = today)
    expect(await lateFeeTotal(invoiceId)).toBe(50)
  })

  it('rent settled with an unpaid late fee attached → accrual STOPS (no snowball)', async () => {
    const f = await fixture()
    const { invoiceId } = await overdueWithRentStatus(f, 'pending')
    await generateLateFeesForTimezone(TZ)
    const afterFirstRun = await lateFeeTotal(invoiceId)
    expect(afterFirstRun).toBeGreaterThan(0)
    // Tenant pays the rent — invoice goes partial (late fee still open).
    await db.query(`UPDATE payments SET status='settled' WHERE invoice_id=$1 AND type='rent'`, [invoiceId])
    const inv = await db.query<{ status: string }>(`SELECT status FROM invoices WHERE id=$1`, [invoiceId])
    expect(inv.rows[0].status).toBe('partial')
    await generateLateFeesForTimezone(TZ)
    expect(await lateFeeTotal(invoiceId)).toBe(afterFirstRun) // not a cent more
  })
})
