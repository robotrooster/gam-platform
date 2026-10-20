/**
 * 10/19 (Nic) — THE PRORATED RENT IS CALCULATED, NEVER TYPED, ON THE SERVER TOO.
 *
 *   "Just lock the box so it's not typable. The prorated box. Yeah, we want the
 *    deposit and pet deposit to be typable. The proration is derived from a
 *    mid-month start. That's based on their lease amount. It should be
 *    auto-calculated. That doesn't need to be, that one does not need to be
 *    typable."
 *
 * The signing page gives the landlord nothing to type into that box. A page is
 * one door, and the value lands through POST /esign/sign — so a submit carrying
 * a proration that disagrees with the lease's own start date, rent and due day
 * is refused here, whatever drew the form that sent it.
 *
 * The real numbers, from Mountain View: Kay Howard (RV 21) and Clint Cook
 * (RV 18) were both drafted days after they arrived, both dated 10/15 — the day
 * the forms were filled out — and both charged $323.00, which is the 17 days
 * from the 15th at $589 a month across a 31-day October. From 10/13 it is
 * $361.00 and from 10/16 it is $304.00: one was about $38 short, the other
 * about $19 over.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailSigningRequest: vi.fn(async () => undefined),
  emailSigningReminder: vi.fn(async () => undefined),
  emailSigningCompleted: vi.fn(async () => undefined),
}))
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import crypto, { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit } from '../test/dbHelpers'
import { esignRouter } from './esign'
import { errorHandler } from '../middleware/errorHandler'

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_proration_derived'
})

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use('/api/esign', esignRouter)
  app.use(errorHandler)
  return app
}

const jwtFor = (p: any) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

/** Mountain View, an RV site, and the landlord who signs. */
async function park(opts: { prorates?: boolean; dueDay?: number } = {}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    // S631: the intent_default_existing_tenancy trigger reads every invite
    // written in a landlord's first 28 days as papering a resident who was
    // already there — and an onboarding resident has no move-in to prorate at
    // all. This park has been on GAM a while, so these are real move-ins.
    await c.query(`UPDATE landlords SET created_at = now() - INTERVAL '120 days' WHERE id = $1`, [landlordId])
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    if (opts.prorates === false) {
      // 10/18 (Nic): a park that does not cut a month into days.
      await c.query(`UPDATE properties SET prorates_mid_month_rent = FALSE WHERE id = $1`, [propertyId])
    }
    if (opts.dueDay != null) {
      // One click in the property's own "When rent is due" dropdown.
      await c.query(`UPDATE properties SET rent_due_mode = 'fixed_day', rent_due_day = $2 WHERE id = $1`,
        [propertyId, opts.dueDay])
    }
    await c.query('COMMIT')
    return { userId, landlordId, propertyId, unitId,
      token: jwtFor({ userId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} }) }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type Park = Awaited<ReturnType<typeof park>>

async function resident() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const email = `r-${randomUUID().slice(0, 8)}@test.dev`
    const tenantId = await seedTenant(c, { email })
    const userId = (await c.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])).rows[0].user_id
    await c.query('COMMIT')
    return { tenantId, userId, email }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type Res = Awaited<ReturnType<typeof resident>>

/**
 * A drafted $589 lease starting 10/15/2026, rent due the 1st, with page 8 as
 * the draft stamped it — the proration already at the figure that start date
 * produces.
 */
async function draft(p: Park, r: Res, opts: {
  start?: string
  proration?: string
  existingTenancy?: boolean
  /** Leave the "rent is due on the" box off the form, the way every real
   *  template that prints a prorated-rent line does. */
  noDueDayBox?: boolean
} = {}): Promise<string> {
  const documentId = (await db.query<{ id: string }>(
    `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
     VALUES ($1,$2,'Mountain View RV Lease','original_lease','in_progress') RETURNING id`,
    [p.landlordId, p.unitId])).rows[0].id
  await db.query(
    `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
     VALUES ($1,$2,'landlord','Nic Rhoades','ll@test.dev',1,$3,'sent'),
            ($1,$4,'primary','Kay Howard',$5,2,$6,'sent')`,
    [documentId, p.userId, crypto.randomBytes(32).toString('hex'),
     r.userId, r.email, crypto.randomBytes(32).toString('hex')])
  const values: Record<string, string> = {
    start_date: opts.start ?? '2026-10-15',
    end_date: '2027-12-31',
    rent_amount: '589.00',
    rent_due_day: '1',
    lease_type: 'fixed_term',
    auto_renew: 'false',
    security_deposit: '500.00',
    move_in_first_month_rent: '0.00',
    move_in_proration: opts.proration ?? '323.00',
    move_in_security_deposit: '500.00',
    move_in_total_due: '823.00',
  }
  if (opts.noDueDayBox) delete values.rent_due_day
  for (const [col, val] of Object.entries(values)) {
    await db.query(
      `INSERT INTO lease_document_fields (document_id, field_type, signer_role, lease_column, value, required)
       VALUES ($1,$2,'landlord',$3,$4,FALSE)`,
      [documentId, col.endsWith('_date') ? 'date' : 'text', col, val])
  }
  await db.query(
    `INSERT INTO pending_tenant_intents
       (landlord_id, tenant_id, parser_status, unit_id, property_id, draft_document_id, is_existing_tenancy)
     VALUES ($1,$2,'not_uploaded',$3,$4,$5,$6)`,
    [p.landlordId, r.tenantId, p.unitId, p.propertyId, documentId, opts.existingTenancy === true])
  return documentId
}

const landlordSigns = (documentId: string, token: string, fieldValues: Array<{ fieldId: string; value: string }> = []) =>
  request(buildApp()).post(`/api/esign/sign/${documentId}`)
    .set('Authorization', `Bearer ${token}`).send({ fieldValues })

/** The ids of this document's boxes, by lease column. */
async function boxes(documentId: string): Promise<Record<string, string>> {
  const rows = (await db.query<{ id: string; lease_column: string }>(
    `SELECT id, lease_column FROM lease_document_fields WHERE document_id=$1 AND lease_column IS NOT NULL`,
    [documentId])).rows
  return Object.fromEntries(rows.map(r => [r.lease_column, r.id]))
}
const storedProration = (documentId: string) => db.query<{ value: string }>(
  `SELECT value FROM lease_document_fields WHERE document_id=$1 AND lease_column='move_in_proration'`,
  [documentId]).then(r => r.rows[0].value)

describe('a typed proration never lands through the signing route', () => {
  it('refuses a figure that disagrees with the start date, and says what it should be', async () => {
    const p = await park()
    const r = await resident()
    const documentId = await draft(p, r)
    const box = await boxes(documentId)

    const res = await landlordSigns(documentId, p.token, [{ fieldId: box.move_in_proration, value: '400.00' }])
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('$400.00')
    expect(res.body.error).toContain('$323.00')
    expect(res.body.error).toContain('calculated, never typed')
    // Nothing was written: the box still reads what the draft derived.
    expect(await storedProration(documentId)).toBe('323.00')
    expect((await db.query(
      `SELECT status FROM lease_document_signers WHERE document_id=$1 AND role='landlord'`,
      [documentId])).rows[0].status).toBe('sent')
  })

  it('accepts the figure the start date produces', async () => {
    const p = await park()
    const r = await resident()
    const documentId = await draft(p, r)
    const box = await boxes(documentId)

    const res = await landlordSigns(documentId, p.token, [{ fieldId: box.move_in_proration, value: '323.00' }])
    expect(res.status).toBe(200)
    expect(await storedProration(documentId)).toBe('323.00')
  })

  it('checks it against the start date being SIGNED, not the one on file — the Kay/Clint case', async () => {
    const p = await park()
    const r = await resident()
    const documentId = await draft(p, r)
    const box = await boxes(documentId)

    // Kay actually arrived on the 13th. 10/15's $323.00 is $38 short.
    const refused = await landlordSigns(documentId, p.token, [
      { fieldId: box.start_date, value: '10/13/2026' },
      { fieldId: box.move_in_proration, value: '323.00' },
    ])
    expect(refused.status).toBe(400)
    expect(refused.body.error).toContain('$361.00')

    const ok = await landlordSigns(documentId, p.token, [
      { fieldId: box.start_date, value: '10/13/2026' },
      { fieldId: box.move_in_proration, value: '361.00' },
    ])
    expect(ok.status).toBe(200)
    expect(await storedProration(documentId)).toBe('361.00')
  })

  it('a park that answers No to mid-month proration wants the whole month', async () => {
    const p = await park({ prorates: false })
    const r = await resident()
    const documentId = await draft(p, r, { proration: '589.00' })
    const box = await boxes(documentId)

    const refused = await landlordSigns(documentId, p.token, [{ fieldId: box.move_in_proration, value: '323.00' }])
    expect(refused.status).toBe(400)
    expect(refused.body.error).toContain('$589.00')

    expect((await landlordSigns(documentId, p.token,
      [{ fieldId: box.move_in_proration, value: '589.00' }])).status).toBe(200)
  })

  it('an onboarding resident has no move-in to prorate — $0, and a typed figure is refused', async () => {
    const p = await park()
    const r = await resident()
    const documentId = await draft(p, r, { existingTenancy: true, proration: '0.00' })
    const box = await boxes(documentId)

    const refused = await landlordSigns(documentId, p.token, [{ fieldId: box.move_in_proration, value: '323.00' }])
    expect(refused.status).toBe(400)
    expect(refused.body.error).toContain('$0.00')

    expect((await landlordSigns(documentId, p.token,
      [{ fieldId: box.move_in_proration, value: '0.00' }])).status).toBe(200)
    expect(await storedProration(documentId)).toBe('0.00')
  })

  // 10/19 review — THE DAY RENT IS DUE, WHEN THE FORM HAS NO BOX FOR IT.
  //
  // Not one of the six templates that prints a prorated-rent line carries a
  // "rent is due on the" box, so this check had nothing to read and used the
  // 1st — while the lease it goes on to create takes the property's own day.
  // At a park due on the 15th it refused the correct figure BY NAME, and the
  // box has no editor the landlord could use to agree with it.
  it("a park due the 15th wants the proration to the 15th, not to the 1st", async () => {
    const p = await park({ dueDay: 15 })
    const r = await resident()
    const documentId = await draft(p, r, { start: '2026-10-20', proration: '494.00', noDueDayBox: true })
    const box = await boxes(documentId)

    // 10/20 up to 11/15 is 26 of that period's 31 days: $494.00. To the 1st it
    // is 12/31 = $228.00, and 10/20–11/15 would be billed by nothing at all.
    const refused = await landlordSigns(documentId, p.token, [{ fieldId: box.move_in_proration, value: '228.00' }])
    expect(refused.status).toBe(400)
    expect(refused.body.error).toContain('$494.00')

    expect((await landlordSigns(documentId, p.token,
      [{ fieldId: box.move_in_proration, value: '494.00' }])).status).toBe(200)
    expect(await storedProration(documentId)).toBe('494.00')
    // And the lease it created is on the park's day, so the two agree.
    expect((await db.query<{ rent_due_day: number }>(
      `SELECT rent_due_day FROM leases WHERE unit_id = $1`, [p.unitId])).rows[0].rent_due_day).toBe(15)
  })

  it("the mirror case does not over-charge: 10/10 at a park due the 15th is 5 days", async () => {
    const p = await park({ dueDay: 15 })
    const r = await resident()
    const documentId = await draft(p, r, { start: '2026-10-10', proration: '98.17', noDueDayBox: true })
    const box = await boxes(documentId)

    // 5 of the 30 days from 9/15: $98.17. To the 1st it is $418.00, and the
    // regular run bills the whole $589.00 again on the 15th.
    const refused = await landlordSigns(documentId, p.token, [{ fieldId: box.move_in_proration, value: '418.00' }])
    expect(refused.status).toBe(400)
    expect(refused.body.error).toContain('$98.17')

    expect((await landlordSigns(documentId, p.token,
      [{ fieldId: box.move_in_proration, value: '98.17' }])).status).toBe(200)
  })

  it('a due-day box on the form still wins over the park rule', async () => {
    const p = await park({ dueDay: 15 })
    const r = await resident()
    const documentId = await draft(p, r, { start: '2026-10-20', proration: '228.00' })
    const box = await boxes(documentId)
    // The form says the 1st, so the 1st it is: 12/31 = $228.00.
    expect((await landlordSigns(documentId, p.token,
      [{ fieldId: box.move_in_proration, value: '228.00' }])).status).toBe(200)
  })

  // 10/19 review: the refusal used to end "the start date is what to fix" in
  // every case — including the ones where moving the start date changes
  // nothing. A clerk reading that goes changing dates on somebody's lease.
  it('names what actually moves the figure, not always the start date', async () => {
    // Three parks, three units: an onboarding intent sits on its UNIT, so a
    // second lease on the same space would read as onboarding too.
    const onboardingPark = await park()
    const r1 = await resident()
    const onboarding = await draft(onboardingPark, r1, { existingTenancy: true, proration: '0.00' })
    const b1 = await boxes(onboarding)
    const refusedOnboarding = await landlordSigns(onboarding, onboardingPark.token,
      [{ fieldId: b1.move_in_proration, value: '323.00' }])
    expect(refusedOnboarding.status).toBe(400)
    expect(refusedOnboarding.body.error).toContain('already living here')
    expect(refusedOnboarding.body.error).not.toContain('the start date is what to fix')

    const wholeMonth = await park({ prorates: false })
    const r2 = await resident()
    const flat = await draft(wholeMonth, r2, { proration: '589.00' })
    const b2 = await boxes(flat)
    const refusedFlat = await landlordSigns(flat, wholeMonth.token,
      [{ fieldId: b2.move_in_proration, value: '323.00' }])
    expect(refusedFlat.status).toBe(400)
    expect(refusedFlat.body.error).toContain('whole month as a whole month')
    expect(refusedFlat.body.error).not.toContain('the start date is what to fix')

    // And where the start date IS the lever, it still says so.
    const normalPark = await park()
    const r3 = await resident()
    const normal = await draft(normalPark, r3)
    const b3 = await boxes(normal)
    const refusedNormal = await landlordSigns(normal, normalPark.token,
      [{ fieldId: b3.move_in_proration, value: '400.00' }])
    expect(refusedNormal.status).toBe(400)
    expect(refusedNormal.body.error).toContain('the start date is what to fix')
  })

  it('a February start and a 31-day-month start each come out on their own real days', async () => {
    for (const [start, figure] of [['2026-02-14', '315.54'], ['2026-10-14', '342.00']] as const) {
      await cleanupAllSchema()
      const p = await park()
      const r = await resident()
      const documentId = await draft(p, r, { start, proration: figure })
      const box = await boxes(documentId)
      // A flat 30-day month would make February's 15 days $294.50.
      const refused = await landlordSigns(documentId, p.token, [{ fieldId: box.move_in_proration, value: '294.50' }])
      expect(refused.status).toBe(400)
      expect(refused.body.error).toContain(`$${figure}`)
      expect((await landlordSigns(documentId, p.token,
        [{ fieldId: box.move_in_proration, value: figure }])).status).toBe(200)
    }
  })
})
