/**
 * S655 — A NEW LEASE FOR A HOUSEHOLD ALREADY LIVING THERE (month-to-month too).
 *
 * Nic (10/2): "they always get charged the new rent, whether or not they sign
 * it... the old one is expired... they've had plenty of notice." And GAM never
 * gates on legality — there is no minimum-notice block.
 *
 *   - sending a new lease that starts on a chosen date ends the current lease
 *     the day before the new start (no overlap refusal);
 *   - from the new start date the household is billed the NEW rent, signed or
 *     not; the landlord-signed lease stays open for their signature;
 *   - a sitting tenant sees a banner, never the signing lock-in;
 *   - the landlord hears 14 days before the start and on the start date that
 *     it is still unsigned;
 *   - a park-wide sender drafts one for every household at once.
 *
 * The jobs read the database's own CURRENT_DATE, so the dates here are counted
 * from today in Phoenix.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  signingRequest: vi.fn(async (..._a: any[]) => undefined),
  newLeaseRequest: vi.fn(async (..._a: any[]) => undefined),
  newLeaseReminder: vi.fn(async (..._a: any[]) => undefined),
  draftLapsed: vi.fn(async (..._a: any[]) => undefined),
  tenantUnsigned: vi.fn(async (..._a: any[]) => undefined),
  landlordDigest: vi.fn(async (..._a: any[]) => undefined),
  notifyLeaseExpiring: vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailSigningRequest: mocks.signingRequest,
  emailSigningReminder: vi.fn(async () => undefined),
  emailSigningCompleted: vi.fn(async () => undefined),
  emailNewLeaseSigningRequest: mocks.newLeaseRequest,
  emailNewLeaseSigningReminder: mocks.newLeaseReminder,
  emailNewLeaseDraftLapsed: mocks.draftLapsed,
  emailNewLeaseTenantUnsigned: mocks.tenantUnsigned,
  emailNewLeasesAwaitingLandlord: mocks.landlordDigest,
}))
vi.mock('../services/notifications', async (orig) => ({
  ...(await orig() as any),
  notifyLeaseExpiring: mocks.notifyLeaseExpiring,
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import crypto, { randomUUID } from 'crypto'
import { DateTime } from 'luxon'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit } from '../test/dbHelpers'
import { esignRouter } from './esign'
import { tenantsRouter } from './tenants'
import { leasesRouter } from './leases'
import { errorHandler } from '../middleware/errorHandler'
import { generateInvoices, unbilledDueDates } from '../jobs/invoiceGeneration'
import { scheduleMoveOutInspections } from '../services/moveOutInspections'
import {
  activatePendingLeases, processLeaseEnds, processNewLeaseSignings, checkLeaseExpiryNotices,
} from '../jobs/scheduler'
import { runRenewalPings } from '../jobs/renewalPing'
import { calculateDepositReturn } from '../services/depositReturn'
import { recordMoveOutNotice } from '../services/moveOutNotice'
import { detectPortabilityEligible } from '../services/depositPortability'
import { isoToDocumentDate, nextDueDateAfter } from '@gam/shared'

const TZ = 'America/Phoenix'
const today = () => DateTime.now().setZone(TZ).toISODate()!
const plusDays = (n: number) => DateTime.now().setZone(TZ).plus({ days: n }).toISODate()!

beforeEach(async () => {
  await cleanupAllSchema()
  for (const m of Object.values(mocks)) m.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_new_lease'
})

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use('/api/esign', esignRouter)
  app.use('/api/tenants', tenantsRouter)
  app.use('/api/leases', leasesRouter)
  app.use(errorHandler)
  return app
}

const sign = (p: any) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

interface Household {
  landlordId: string; landlordUserId: string; landlordToken: string
  propertyId: string; unitId: string
  tenantId: string; tenantUserId: string; tenantEmail: string; tenantToken: string
  leaseId: string
}

/** A landlord and one property; `households` are added with addHousehold. */
async function seedPark() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    await c.query(`UPDATE properties SET rent_due_mode='fixed_day', timezone=$2 WHERE id=$1`, [propertyId, TZ])
    const tpl = await c.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, base_pdf_url, is_active, purpose)
       VALUES ($1,'Space Lease','/uploads/lease.pdf',TRUE,'lease') RETURNING id`, [landlordId])
    for (const [i, col] of ['rent_amount', 'start_date', 'end_date', 'rent_due_day', 'lease_type', 'security_deposit'].entries()) {
      await c.query(
        `INSERT INTO lease_template_fields
           (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required)
         VALUES ($1,'text','landlord',$2,$2,1,10,$3,80,14,FALSE)`, [tpl.rows[0].id, col, 20 * i + 20])
    }
    await c.query('COMMIT')
    const landlordToken = sign({ userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
      profileId: landlordId, landlordIds: [landlordId], permissions: {} })
    return { landlordId, landlordUserId, landlordToken, propertyId, templateId: tpl.rows[0].id }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A household on a month-to-month (or a fixed term), $500 deposit held, due the 1st. */
async function addHousehold(park: Awaited<ReturnType<typeof seedPark>>, opts: {
  rent?: number; end?: string | null; start?: string
} = {}): Promise<Household> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const tenantEmail = `t-${randomUUID()}@test.dev`
    const tenantId = await seedTenant(c, { email: tenantEmail })
    const tenantUserId = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])).rows[0].user_id
    const unitId = await seedUnit(c, { propertyId: park.propertyId, landlordId: park.landlordId })
    await c.query(`UPDATE units SET status='active' WHERE id=$1`, [unitId])
    const lease = await c.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date,
                           rent_due_day, signed_by_landlord, signed_by_tenant)
       VALUES ($1,$2,$3,$4,'active',$5,$6,1,TRUE,TRUE) RETURNING id`,
      [unitId, park.landlordId, opts.rent ?? 1000, opts.end ? 'fixed_term' : 'month_to_month',
       opts.start ?? '2025-06-15', opts.end ?? null])
    const leaseId = lease.rows[0].id
    await c.query(
      `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1,$2,'primary','active',NOW(),'original','joint_several')`, [leaseId, tenantId])
    await c.query(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing, money_kind)
       VALUES ($1,'security_deposit',500,TRUE,'move_in','deposit')`, [leaseId])
    await c.query(
      `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by)
       VALUES ($1,$2,$3,500,500,'funded','landlord')`, [unitId, leaseId, tenantId])
    await c.query('COMMIT')
    return {
      landlordId: park.landlordId, landlordUserId: park.landlordUserId, landlordToken: park.landlordToken,
      propertyId: park.propertyId, unitId, tenantId, tenantUserId, tenantEmail, leaseId,
      tenantToken: sign({ userId: tenantUserId, role: 'tenant', email: tenantEmail, profileId: tenantId, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const api = () => request(buildApp())

/** Draft through the real route, send, and have the landlord sign at `startIso` / `rent`. */
async function newLeaseSignedByLandlord(park: Awaited<ReturnType<typeof seedPark>>, h: Household, startIso: string, rent = '1050.00') {
  const drafted = await api().post('/api/esign/documents/renewal')
    .set('Authorization', `Bearer ${h.landlordToken}`).send({ leaseId: h.leaseId, templateId: park.templateId })
  expect(drafted.status).toBe(201)
  const docId = drafted.body.data.id
  const sent = await api().post(`/api/esign/documents/${docId}/send`).set('Authorization', `Bearer ${h.landlordToken}`).send({})
  expect(sent.status).toBe(200)
  const fields = (await db.query<{ id: string; lease_column: string }>(
    `SELECT id, lease_column FROM lease_document_fields WHERE document_id=$1 AND signer_role='landlord'`, [docId])).rows
  const fid = (col: string) => fields.find(f => f.lease_column === col)!.id
  const signed = await api().post(`/api/esign/sign/${docId}`).set('Authorization', `Bearer ${h.landlordToken}`)
    .send({ fieldValues: [
      { fieldId: fid('start_date'), value: isoToDocumentDate(startIso) },
      { fieldId: fid('rent_amount'), value: rent },
    ] })
  return { docId, signed }
}

/** The landlord signs an already-drafted new lease, typing `startIso` / `rent`. */
async function landlordSignsDoc(h: Household, docId: string, startIso: string, rent = '1050.00') {
  const fields = (await db.query<{ id: string; lease_column: string }>(
    `SELECT id, lease_column FROM lease_document_fields WHERE document_id=$1 AND signer_role='landlord'`, [docId])).rows
  const fid = (col: string) => fields.find(f => f.lease_column === col)!.id
  return api().post(`/api/esign/sign/${docId}`).set('Authorization', `Bearer ${h.landlordToken}`)
    .send({ fieldValues: [
      { fieldId: fid('start_date'), value: isoToDocumentDate(startIso) },
      { fieldId: fid('rent_amount'), value: rent },
    ] })
}

async function leaseRow(id: string) {
  return (await db.query<any>(
    `SELECT id, status, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date,
            rent_amount::float AS rent, signed_by_tenant, supersedes_lease_id, prepaid_monthly_draw::float AS draw
       FROM leases WHERE id=$1`, [id])).rows[0]
}
async function successorOf(h: Household) {
  return (await db.query<any>(`SELECT id FROM leases WHERE supersedes_lease_id=$1`, [h.leaseId])).rows[0]?.id as string | undefined
}
async function billRunOn(day: string) {
  await generateInvoices(DateTime.fromISO(day, { zone: TZ }).set({ hour: 8 }).toJSDate())
}

describe('a month-to-month household can be sent a new lease', () => {
  it('drafts as a "New Lease", sends without an overlap refusal, and the landlord\'s signature issues it — the old lease untouched', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const start = plusDays(40)
    const { docId, signed } = await newLeaseSignedByLandlord(park, h, start)
    expect(signed.status).toBe(200)

    const doc = (await db.query<any>(`SELECT title, status, lease_id FROM lease_documents WHERE id=$1`, [docId])).rows[0]
    expect(doc.title).toMatch(/^New Lease — Unit /)
    expect(doc.status).toBe('in_progress')

    const nl = await leaseRow(doc.lease_id)
    expect(nl).toMatchObject({ status: 'pending', start_date: start, rent: 1050, signed_by_tenant: false, supersedes_lease_id: h.leaseId })
    // Nothing is written on the month-to-month while the new lease waits.
    expect(await leaseRow(h.leaseId)).toMatchObject({ status: 'active', end_date: null })

    // The tenant is told it is a NEW lease (from <date>, at <rent>) — not an ending.
    expect(mocks.newLeaseRequest).toHaveBeenCalledTimes(1)
    expect(mocks.newLeaseRequest.mock.calls[0][5]).toMatchObject({ startDate: start, rent: '1050.00', started: false })
  })

  it('signed by the landlord ON its start date: the tenant is told it is their lease now, not that nothing changes', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const { signed } = await newLeaseSignedByLandlord(park, h, today())
    expect(signed.status).toBe(200)
    expect(mocks.newLeaseRequest).toHaveBeenCalledTimes(1)
    expect(mocks.newLeaseRequest.mock.calls[0][5]).toMatchObject({ startDate: today(), started: true })
  })

  it('still refuses any OTHER overlapping lease — a second new lease of the same household', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    await newLeaseSignedByLandlord(park, h, plusDays(40))
    // A second draft through the route is refused outright…
    const again = await api().post('/api/esign/documents/renewal')
      .set('Authorization', `Bearer ${h.landlordToken}`).send({ leaseId: h.leaseId, templateId: park.templateId })
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/already in progress/)
    // …and one that gets as far as sending meets the first new lease as an overlap.
    const d = await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status, renews_lease_id)
       VALUES ($1,$2,'New Lease','original_lease','pending',$3) RETURNING id`, [h.landlordId, h.unitId, h.leaseId])
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status) VALUES
         ($1,$2,'landlord','L L','ll@test.dev',1,$3,'pending'), ($1,$4,'primary','T T',$5,2,$6,'pending')`,
      [d.rows[0].id, h.landlordUserId, crypto.randomBytes(32).toString('hex'), h.tenantUserId, h.tenantEmail,
       crypto.randomBytes(32).toString('hex')])
    await db.query(
      `INSERT INTO lease_document_fields (document_id, field_type, signer_role, lease_column, value, required)
       VALUES ($1,'text','landlord','start_date',$2,FALSE), ($1,'text','landlord','end_date','-',FALSE)`,
      [d.rows[0].id, isoToDocumentDate(plusDays(60))])
    const sent = await api().post(`/api/esign/documents/${d.rows[0].id}/send`).set('Authorization', `Bearer ${h.landlordToken}`).send({})
    expect(sent.status).toBe(409)
    expect(sent.body.error).toMatch(/overlapping/)
  })

  it('refuses while a leaving date is on file, with the way to undo it', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    await recordMoveOutNotice({ leaseId: h.leaseId, on: plusDays(20), byUserId: h.landlordUserId })
    const res = await api().post('/api/esign/documents/renewal')
      .set('Authorization', `Bearer ${h.landlordToken}`).send({ leaseId: h.leaseId, templateId: park.templateId })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/down as leaving on .*call that off first/)
  })

  it('refuses a start on a date the current lease has already billed — that stretch would be billed twice', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const start = plusDays(40)
    await db.query(
      `INSERT INTO invoices (landlord_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, status)
       VALUES ($1,$2,$3,'INV-BILLED',$4,1000,1000,'pending')`, [h.landlordId, h.leaseId, h.unitId, start])
    const { signed, docId } = await newLeaseSignedByLandlord(park, h, start)
    expect(signed.status).toBe(409)
    expect(signed.body.error).toMatch(/already billed .* or later, so that stretch is not billed twice/)
    // The landlord's signature did not land; they can fix the box and sign.
    const ll = await db.query<{ status: string }>(
      `SELECT status FROM lease_document_signers WHERE document_id=$1 AND role='landlord'`, [docId])
    expect(ll.rows[0].status).not.toBe('signed')
  })

  it('no minimum notice: a new lease starting tomorrow is accepted', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const { signed } = await newLeaseSignedByLandlord(park, h, plusDays(1))
    expect(signed.status).toBe(200)
  })

  it('carries the landlord\'s monthly paid-ahead cap onto the new lease', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    await db.query(`UPDATE leases SET prepaid_monthly_draw=100 WHERE id=$1`, [h.leaseId])
    await newLeaseSignedByLandlord(park, h, plusDays(40))
    expect((await leaseRow((await successorOf(h))!)).draw).toBe(100)
  })
})

describe('the new lease takes over on its start date, signed by the tenant or not', () => {
  it('the old month-to-month ends the day before, the household is handed over, and the NEW rent is billed — unsigned', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!

    // The start date arrives (the tenant never signed). The old lease has
    // billed its own dates first.
    await db.query(`UPDATE leases SET start_date=$2 WHERE id=$1`, [nlId, today()])
    await billRunOn(today())
    await activatePendingLeases()
    await processLeaseEnds()

    expect(await leaseRow(h.leaseId)).toMatchObject({ status: 'expired', end_date: plusDays(-1) })
    expect(await leaseRow(nlId)).toMatchObject({ status: 'active', signed_by_tenant: false })
    // The deposit stays with the household.
    const sd = await db.query<{ lease_id: string }>(`SELECT lease_id FROM security_deposits WHERE unit_id=$1`, [h.unitId])
    expect(sd.rows[0].lease_id).toBe(nlId)
    // Still open for their signature — never canceled for want of it.
    await processNewLeaseSignings({ hour: 12 })
    expect((await db.query<any>(`SELECT status FROM lease_documents WHERE id=$1`, [docId])).rows[0].status).toBe('in_progress')

    // The first bill under the new lease is the new rent, on the household's due date.
    const firstDue = nextDueDateAfter(plusDays(-1), 1)
    await billRunOn(firstDue)
    const bills = await db.query<{ due: string; rent: number }>(
      `SELECT to_char(due_date,'YYYY-MM-DD') AS due, subtotal_rent::float AS rent FROM invoices
        WHERE lease_id=$1 AND status <> 'void' ORDER BY due_date`, [nlId])
    expect(bills.rows).toEqual([{ due: firstDue, rent: 1050 }])
    // And the old lease billed nothing on or after the new start.
    const oldLate = await db.query(`SELECT 1 FROM invoices WHERE lease_id=$1 AND due_date >= $2`, [h.leaseId, today()])
    expect(oldLate.rows).toHaveLength(0)
  })

  it('a new lease never comes into force beside the old one: if the old could not be ended tonight, it waits', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!
    await db.query(`UPDATE leases SET start_date=$2 WHERE id=$1`, [nlId, today()])
    const mod = await import('../services/renewalSuccessor')
    const spy = vi.spyOn(mod, 'closePredecessorOfStartedRenewals').mockRejectedValueOnce(new Error('db hiccup'))
    await activatePendingLeases()
    expect(spy).toHaveBeenCalled()
    expect(await leaseRow(nlId)).toMatchObject({ status: 'pending' })
    expect(await leaseRow(h.leaseId)).toMatchObject({ status: 'active', end_date: null })
    spy.mockRestore()
    // The next night it goes through.
    await billRunOn(today())
    await activatePendingLeases()
    await processLeaseEnds()
    expect(await leaseRow(h.leaseId)).toMatchObject({ status: 'expired', end_date: plusDays(-1) })
    expect(await leaseRow(nlId)).toMatchObject({ status: 'active' })
  })
})

describe('a signed fixed term and its new lease — never a stretch with no lease (decisions 10/2 #7)', () => {
  /** Every due date (the 1st) in (from, to], as the bill run would see them. */
  const firstsBetween = (fromExclusive: string, toInclusive: string) => {
    const out: string[] = []
    let d = nextDueDateAfter(fromExclusive, 1)
    while (d <= toInclusive) { out.push(d); d = nextDueDateAfter(d, 1) }
    return out
  }
  const unitStatus = async (h: Household) =>
    (await db.query<{ status: string }>(`SELECT status FROM units WHERE id=$1`, [h.unitId])).rows[0].status
  const depositReturns = async (ids: string[]) =>
    (await db.query(`SELECT 1 FROM deposit_returns WHERE lease_id = ANY($1)`, [ids])).rows.length

  it('starting the day after the term ends: it takes over that day, unsigned, at the new rent — no day billed by nobody', async () => {
    const park = await seedPark()
    const h = await addHousehold(park, { end: plusDays(-1) })   // the term's last day was yesterday
    const { signed } = await newLeaseSignedByLandlord(park, h, today())
    expect(signed.status).toBe(200)
    const nlId = (await successorOf(h))!

    await billRunOn(today())
    await activatePendingLeases()
    await processLeaseEnds()
    expect(await leaseRow(h.leaseId)).toMatchObject({ status: 'expired', end_date: plusDays(-1) })
    expect(await leaseRow(nlId)).toMatchObject({ status: 'active', signed_by_tenant: false })
    expect(await unitStatus(h)).toBe('active')
    expect(await depositReturns([h.leaseId, nlId])).toBe(0)

    // The old lease billed everything up to its last day; the new rent from there.
    const firstDue = nextDueDateAfter(plusDays(-1), 1)
    await billRunOn(firstDue)
    const newBills = await db.query<{ due: string; rent: number }>(
      `SELECT to_char(due_date,'YYYY-MM-DD') AS due, subtotal_rent::float AS rent FROM invoices WHERE lease_id=$1 AND status <> 'void'`, [nlId])
    expect(newBills.rows).toEqual([{ due: firstDue, rent: 1050 }])
    expect((await db.query(`SELECT 1 FROM invoices WHERE lease_id=$1 AND due_date >= $2`, [h.leaseId, today()])).rows).toHaveLength(0)
  })

  it('starting a month after the term ends: the household HOLDS OVER on the old lease, at the old rent, until the day before — never a move-out', async () => {
    const park = await seedPark()
    const h = await addHousehold(park, { end: plusDays(-1) })   // the term ran out yesterday…
    const start = plusDays(30)                                  // …and the new lease starts 31 days after its end
    const { signed } = await newLeaseSignedByLandlord(park, h, start)
    expect(signed.status).toBe(200)                             // a later start is accepted
    const nlId = (await successorOf(h))!

    // The night the term runs out: the old lease carries on to the day before
    // the new start. Nothing is handed over to a lease that has not started.
    await activatePendingLeases()
    await processLeaseEnds()
    expect(await leaseRow(h.leaseId)).toMatchObject({ status: 'active', end_date: plusDays(29), rent: 1000 })
    expect(await leaseRow(nlId)).toMatchObject({ status: 'pending' })
    expect(await unitStatus(h)).toBe('active')
    expect(await depositReturns([h.leaseId, nlId])).toBe(0)
    const tenants = await db.query<{ status: string }>(`SELECT status FROM lease_tenants WHERE lease_id=$1`, [h.leaseId])
    expect(tenants.rows.map(r => r.status)).toEqual(['active'])
    // Another night changes nothing.
    await activatePendingLeases()
    await processLeaseEnds()
    expect(await leaseRow(h.leaseId)).toMatchObject({ status: 'active', end_date: plusDays(29) })

    // Every due date while it holds over is billed — by the OLD lease, at the old rent.
    const held = firstsBetween(plusDays(-1), plusDays(29))
    for (const d of held) await billRunOn(d)
    await billRunOn(plusDays(29))                               // the eve of the new start
    const oldBills = await db.query<{ due: string; rent: number }>(
      `SELECT to_char(due_date,'YYYY-MM-DD') AS due, subtotal_rent::float AS rent FROM invoices
        WHERE lease_id=$1 AND due_date >= $2 AND status <> 'void' ORDER BY due_date`, [h.leaseId, today()])
    expect(oldBills.rows).toEqual(held.map(d => ({ due: d, rent: 1000 })))
    expect((await db.query(`SELECT 1 FROM invoices WHERE lease_id=$1`, [nlId])).rows).toHaveLength(0)
    // On the eve of the new start nothing is left unbilled, so the hand-off
    // that night does not wait.
    expect(await unbilledDueDates(h.leaseId, DateTime.fromISO(plusDays(29), { zone: TZ }).set({ hour: 8 }).toJSDate())).toEqual([])
  })

  it('the night the held-over lease reaches the new start, the household is handed over — no move-out walkthrough, the new rent from its due date', async () => {
    const park = await seedPark()
    const h = await addHousehold(park, { end: plusDays(-1) })
    await db.query(`UPDATE units SET unit_type='mobile_home' WHERE id=$1`, [h.unitId])
    await newLeaseSignedByLandlord(park, h, plusDays(30))
    const nlId = (await successorOf(h))!
    await activatePendingLeases()                                // holds over to plusDays(29)
    // A month on: the new start date has come (the old lease's held-over end is
    // the day before it).
    await db.query(`UPDATE leases SET end_date=$2 WHERE id=$1`, [h.leaseId, plusDays(-1)])
    await db.query(`UPDATE leases SET start_date=$2 WHERE id=$1`, [nlId, today()])
    await billRunOn(today())
    await activatePendingLeases()
    await processLeaseEnds()
    expect(await leaseRow(h.leaseId)).toMatchObject({ status: 'expired', end_date: plusDays(-1) })
    expect(await leaseRow(nlId)).toMatchObject({ status: 'active', signed_by_tenant: false })

    // The household is staying: no move-out walkthrough, no "OVERDUE" notice.
    const r = await scheduleMoveOutInspections()
    expect(r.scheduled).toBe(0)
    expect((await db.query(`SELECT 1 FROM unit_inspections WHERE lease_id = ANY($1)`, [[h.leaseId, nlId]])).rows).toHaveLength(0)
    expect((await db.query(`SELECT 1 FROM notifications WHERE type='moveout_inspection_due'`)).rows).toHaveLength(0)

    const firstDue = nextDueDateAfter(plusDays(-1), 1)
    await billRunOn(firstDue)
    const bills = await db.query<{ due: string; rent: number }>(
      `SELECT to_char(due_date,'YYYY-MM-DD') AS due, subtotal_rent::float AS rent FROM invoices WHERE lease_id=$1 AND status <> 'void'`, [nlId])
    expect(bills.rows).toEqual([{ due: firstDue, rent: 1050 }])
  })

  it('a start inside the signed term is refused, naming the day after it ends — the term is never cut short', async () => {
    const park = await seedPark()
    const h = await addHousehold(park, { end: plusDays(20) })
    const { signed, docId } = await newLeaseSignedByLandlord(park, h, plusDays(10))
    expect(signed.status).toBe(409)
    const endWords = DateTime.fromISO(plusDays(20)).toFormat('LLLL d, yyyy')
    const nextWords = DateTime.fromISO(plusDays(21)).toFormat('LLLL d, yyyy')
    expect(signed.body.error).toContain(`is on a signed lease through ${endWords}, so a new lease can start ${nextWords} or later. Change the start date.`)
    expect(await successorOf(h)).toBeUndefined()
    expect(await leaseRow(h.leaseId)).toMatchObject({ status: 'active', end_date: plusDays(20) })
    const ll = await db.query<{ status: string }>(`SELECT status FROM lease_document_signers WHERE document_id=$1 AND role='landlord'`, [docId])
    expect(ll.rows[0].status).not.toBe('signed')
  })

  it('canceling the new lease while the household holds over leaves them on the old lease through the day they were told — not moved out that night', async () => {
    const park = await seedPark()
    const h = await addHousehold(park, { end: plusDays(-1) })
    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(30))
    await activatePendingLeases()
    await processLeaseEnds()
    const ctx = (await api().get(`/api/esign/documents/renewal-context/${h.leaseId}`)
      .set('Authorization', `Bearer ${h.landlordToken}`)).body.data.openDraft
    expect(ctx).toMatchObject({ id: docId, can_cancel: true })
    const res = await api().post(`/api/esign/documents/${docId}/void`).set('Authorization', `Bearer ${h.landlordToken}`)
      .send({ reason: 'canceled by the landlord' })
    expect(res.status).toBe(200)
    await activatePendingLeases()
    await processLeaseEnds()
    expect(await leaseRow(h.leaseId)).toMatchObject({ status: 'active', end_date: plusDays(29) })
    expect(await unitStatus(h)).toBe('active')
    expect(await depositReturns([h.leaseId])).toBe(0)
  })
  it('canceled during a holdover and sent again: the SIGNED end is named, never the held-over day — and the next term is as long as the signed one', async () => {
    const park = await seedPark()
    // A one-year term (365 days) that ran out yesterday.
    const h = await addHousehold(park, { start: plusDays(-366), end: plusDays(-1) })
    const words = (iso: string) => DateTime.fromISO(iso).toFormat('LLLL d, yyyy')
    const first = await newLeaseSignedByLandlord(park, h, plusDays(30))
    expect(first.signed.status).toBe(200)
    await activatePendingLeases()                                // holds over to plusDays(29)
    const held = await db.query<any>(
      `SELECT to_char(end_date,'YYYY-MM-DD') AS end_date, to_char(holdover_signed_end_date,'YYYY-MM-DD') AS signed_end
         FROM leases WHERE id=$1`, [h.leaseId])
    expect(held.rows[0]).toEqual({ end_date: plusDays(29), signed_end: plusDays(-1) })

    // The landlord cancels it; the household stays on through the day they were told.
    const voided = await api().post(`/api/esign/documents/${first.docId}/void`).set('Authorization', `Bearer ${h.landlordToken}`)
      .send({ reason: 'canceled by the landlord' })
    expect(voided.status).toBe(200)

    // The park-wide list names when the signed lease ended — not the held-over day.
    const preview = await api().post('/api/esign/documents/renewal-batch/preview')
      .set('Authorization', `Bearer ${park.landlordToken}`)
      .send({ propertyId: park.propertyId, startDate: plusDays(45), rentMode: 'percent', rentValue: 5 })
    const row = preview.body.data.rows.find((r: any) => r.leaseId === h.leaseId)
    expect(row).toMatchObject({ ok: true, reason: null })
    expect(row.note).toBe(`Its signed lease ended ${words(plusDays(-1))}; it stays on today's rent until ${words(plusDays(44))}.`)

    // Sent again: a start inside the SIGNED term is refused naming the signed end…
    const again = await newLeaseSignedByLandlord(park, h, plusDays(-3))
    expect(again.signed.status).toBe(409)
    expect(again.signed.body.error).toContain(
      `is on a signed lease through ${words(plusDays(-1))}, so a new lease can start ${words(today())} or later.`)
    expect(again.signed.body.error).not.toContain(words(plusDays(29)))
    // …and the draft's own term runs from the day after the lease they are on now
    // ends, as long as the term they SIGNED (not that plus the holdover).
    const box = async (col: string) => (await db.query<any>(
      `SELECT value FROM lease_document_fields WHERE document_id=$1 AND lease_column=$2 AND signer_role='landlord'`,
      [again.docId, col])).rows[0]?.value
    expect(await box('end_date')).toBe(isoToDocumentDate(DateTime.fromISO(plusDays(30)).plus({ days: 365 }).toISODate()!))

    // A start inside the holdover is past the signed term: accepted.
    const ok = await landlordSignsDoc(h, again.docId, plusDays(10))
    expect(ok.status).toBe(200)
    const nlId = (await db.query<{ id: string }>(
      `SELECT id FROM leases WHERE supersedes_lease_id=$1 AND status IN ('pending','active')`, [h.leaseId])).rows[0].id
    expect(await leaseRow(nlId)).toMatchObject({ status: 'pending', start_date: plusDays(10) })
    // On its start date the held-over lease closes the day before; its signed end is kept.
    const { closePredecessorOfStartedRenewals } = await import('../services/renewalSuccessor')
    await closePredecessorOfStartedRenewals(async (sql, params) => ({ rows: (await db.query(sql, params)).rows }),
      { today: plusDays(10) })
    const closed = await db.query<any>(
      `SELECT to_char(end_date,'YYYY-MM-DD') AS end_date, to_char(holdover_signed_end_date,'YYYY-MM-DD') AS signed_end
         FROM leases WHERE id=$1`, [h.leaseId])
    expect(closed.rows[0]).toEqual({ end_date: plusDays(9), signed_end: plusDays(-1) })
  })

  it('a term that ran out before its new lease started keeps its signed end when it is closed the day before', async () => {
    const park = await seedPark()
    const h = await addHousehold(park, { end: plusDays(-5) })
    const { signed } = await newLeaseSignedByLandlord(park, h, today())   // signed on its own start date
    expect(signed.status).toBe(200)
    const r = await db.query<any>(
      `SELECT to_char(end_date,'YYYY-MM-DD') AS end_date, to_char(holdover_signed_end_date,'YYYY-MM-DD') AS signed_end
         FROM leases WHERE id=$1`, [h.leaseId])
    expect(r.rows[0]).toEqual({ end_date: plusDays(-1), signed_end: plusDays(-5) })
  })

  it('a month-to-month is never marked as held over', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!
    await db.query(`UPDATE leases SET start_date=$2 WHERE id=$1`, [nlId, today()])
    await activatePendingLeases()
    const r = await db.query<any>(
      `SELECT to_char(end_date,'YYYY-MM-DD') AS end_date, holdover_signed_end_date FROM leases WHERE id=$1`, [h.leaseId])
    expect(r.rows[0]).toEqual({ end_date: plusDays(-1), holdover_signed_end_date: null })
  })
})

describe('canceling a new lease', () => {
  it('before it starts: the landlord can cancel it, and the household carries on exactly as before', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!
    const res = await api().post(`/api/esign/documents/${docId}/void`).set('Authorization', `Bearer ${h.landlordToken}`)
      .send({ reason: 'canceled by the landlord' })
    expect(res.status).toBe(200)
    expect((await leaseRow(nlId)).status).toBe('terminated')
    expect(await leaseRow(h.leaseId)).toMatchObject({ status: 'active', end_date: null })
    const sd = await db.query<{ lease_id: string }>(`SELECT lease_id FROM security_deposits WHERE unit_id=$1`, [h.unitId])
    expect(sd.rows[0].lease_id).toBe(h.leaseId)
  })

  it('once it has taken over it cannot be canceled — the household would be left on no lease', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!
    await db.query(`UPDATE leases SET start_date=$2 WHERE id=$1`, [nlId, today()])
    await billRunOn(today())
    await activatePendingLeases()
    await processLeaseEnds()
    const res = await api().post(`/api/esign/documents/${docId}/void`).set('Authorization', `Bearer ${h.landlordToken}`).send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/took over on .* can't be canceled: the household would be left with no lease.*They're leaving on/)
    expect((await leaseRow(nlId)).status).toBe('active')
  })

  it('from its start date a cancel is refused even while the hand-off still waits on the old lease\'s last bill — the household is never moved out', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!
    await db.query(`UPDATE leases SET start_date=$2 WHERE id=$1`, [nlId, today()])
    // On the start date, before the night's jobs have run: already refused.
    const early = await api().post(`/api/esign/documents/${docId}/void`).set('Authorization', `Bearer ${h.landlordToken}`).send({})
    expect(early.status).toBe(409)
    // The 2am job ends the old lease the day before; with no bill run yet the
    // old lease still owes its last bill, so the hand-off waits.
    await activatePendingLeases()
    await processLeaseEnds()
    expect(await leaseRow(h.leaseId)).toMatchObject({ status: 'active', end_date: plusDays(-1) })
    expect((await leaseRow(nlId)).status).toBe('pending')

    const res = await api().post(`/api/esign/documents/${docId}/void`).set('Authorization', `Bearer ${h.landlordToken}`).send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/took over on .* can't be canceled/)
    expect((await leaseRow(nlId)).status).toBe('pending')

    // Another night, the bill still not made: still waiting — never a move-out.
    await activatePendingLeases()
    await processLeaseEnds()
    expect((await leaseRow(h.leaseId)).status).toBe('active')
    const unit = async () => (await db.query<{ status: string }>(`SELECT status FROM units WHERE id=$1`, [h.unitId])).rows[0].status
    const returns = async () => (await db.query(`SELECT 1 FROM deposit_returns WHERE lease_id = ANY($1)`, [[h.leaseId, nlId]])).rows.length
    expect(await unit()).toBe('active')
    expect(await returns()).toBe(0)

    // The bill is made; that night the household is handed over.
    await billRunOn(today())
    await activatePendingLeases()
    await processLeaseEnds()
    expect((await leaseRow(h.leaseId)).status).toBe('expired')
    expect((await leaseRow(nlId)).status).toBe('active')
    expect(await unit()).toBe('active')
    expect(await returns()).toBe(0)
  })

  it('once anyone in the household has signed, the window offers no cancel and the desk is told the same next step', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!
    // A second person on the new lease who has NOT signed; the primary has.
    const c = await db.connect()
    let coUserId: string
    try {
      const coTenantId = await seedTenant(c, { email: `co-${randomUUID()}@test.dev` })
      coUserId = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [coTenantId])).rows[0].user_id
    } finally { c.release() }
    await db.query(`UPDATE lease_document_signers SET status='signed', signed_at=NOW() WHERE document_id=$1 AND role='primary'`, [docId])
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
       VALUES ($1,$2,'co_tenant_1','Co Tenant','co@test.dev',3,$3,'sent')`,
      [docId, coUserId!, crypto.randomBytes(32).toString('hex')])

    // (This test app does not camelize; the portal reads tenantSigned / canCancel.)
    const ctx = (await api().get(`/api/esign/documents/renewal-context/${h.leaseId}`)
      .set('Authorization', `Bearer ${h.landlordToken}`)).body.data.openDraft
    expect(ctx).toMatchObject({ id: docId, tenant_signed: true, started: false, can_cancel: false })
    // The server refuses the cancel the window no longer shows — in the very
    // words the window shows instead of the button.
    const res = await api().post(`/api/esign/documents/${docId}/void`).set('Authorization', `Bearer ${h.landlordToken}`).send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(ctx.cancel_refusal)
    expect(res.body.error).toMatch(/^Someone in the household has signed this new lease, so it can't be canceled.*They're leaving on…\)\.$/)
    expect((await leaseRow(nlId)).status).toBe('pending')
    // …and the desk is not sent to it: the leaving date goes on the new lease once it starts.
    await expect(recordMoveOutNotice({ leaseId: h.leaseId, on: plusDays(10), byUserId: h.landlordUserId }))
      .rejects.toThrow(/that the household has signed, so it can't be canceled\. Write down the leaving date on that new lease once it starts/)
  })

  it('before anyone has signed, the desk is pointed at the cancel button — and that cancel goes through', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(40))
    const ctx = (await api().get(`/api/esign/documents/renewal-context/${h.leaseId}`)
      .set('Authorization', `Bearer ${h.landlordToken}`)).body.data.openDraft
    expect(ctx).toMatchObject({ id: docId, tenant_signed: false, started: false, can_cancel: true, cancel_refusal: null })
    await expect(recordMoveOutNotice({ leaseId: h.leaseId, on: plusDays(10), byUserId: h.landlordUserId }))
      .rejects.toThrow(/cancel it first: Leases → Change → New lease — view or cancel → Cancel the new lease/)
    const res = await api().post(`/api/esign/documents/${docId}/void`).set('Authorization', `Bearer ${h.landlordToken}`)
      .send({ reason: 'canceled by the landlord' })
    expect(res.status).toBe(200)
  })

  it('a new lease whose old lease has already ended by its date is not canceled into no lease at all', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const start = plusDays(40)
    const { docId } = await newLeaseSignedByLandlord(park, h, start)
    await db.query(`UPDATE leases SET status='expired' WHERE id=$1`, [h.leaseId])
    // The window does not offer the cancel the server would refuse, and says why.
    const ctx = (await api().get(`/api/esign/documents/renewal-context/${h.leaseId}`)
      .set('Authorization', `Bearer ${h.landlordToken}`)).body.data.openDraft
    expect(ctx).toMatchObject({ id: docId, can_cancel: false })
    const res = await api().post(`/api/esign/documents/${docId}/void`).set('Authorization', `Bearer ${h.landlordToken}`).send({})
    expect(res.status).toBe(409)
    expect(ctx.cancel_refusal).toBe(res.body.error)
    expect(res.body.error).toBe(
      'The lease before this one has already ended, so canceling this new lease would leave the household with no lease. ' +
      `If they are leaving, write down the day they go on the new lease once it starts on ${DateTime.fromISO(start).toFormat('LLLL d, yyyy')} ` +
      "(Leases → Change → They're leaving on…).")
  })

  it('staff without the "Void documents" permission are not offered a cancel the server would refuse them', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(40))
    const pm = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','property_manager','Pat','Manager',TRUE) RETURNING id`, [`pm-${randomUUID()}@test.dev`])
    await db.query(
      `INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions)
       VALUES ($1,$2,$3,FALSE,'{"leases.create":true}'::jsonb)`, [pm.rows[0].id, park.landlordId, [park.propertyId]])
    const pmToken = sign({ userId: pm.rows[0].id, role: 'property_manager', email: 'pm@test.dev', profileId: pm.rows[0].id,
      landlordId: park.landlordId, landlordIds: [park.landlordId], permissions: { 'leases.create': true } })
    const ctx = await api().get(`/api/esign/documents/renewal-context/${h.leaseId}`).set('Authorization', `Bearer ${pmToken}`)
    expect(ctx.status).toBe(200)
    expect(ctx.body.data.openDraft).toMatchObject({ id: docId, can_cancel: false })
    expect(ctx.body.data.openDraft.cancel_refusal).toMatch(/needs the "Void documents" permission\. Ask the account owner/)
    const res = await api().post(`/api/esign/documents/${docId}/void`).set('Authorization', `Bearer ${pmToken}`).send({})
    expect(res.status).toBe(403)
    // The owner is offered it.
    const own = await api().get(`/api/esign/documents/renewal-context/${h.leaseId}`).set('Authorization', `Bearer ${h.landlordToken}`)
    expect(own.body.data.openDraft).toMatchObject({ can_cancel: true, cancel_refusal: null })
  })

  it('the window reports started from the start date', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(40))
    await db.query(`UPDATE leases SET start_date=$2 WHERE supersedes_lease_id=$1`, [h.leaseId, today()])
    const res = await api().get(`/api/esign/documents/renewal-context/${h.leaseId}`).set('Authorization', `Bearer ${h.landlordToken}`)
    expect(res.body.data.openDraft).toMatchObject({ id: docId, started: true, can_cancel: false })
    const voided = await api().post(`/api/esign/documents/${docId}/void`).set('Authorization', `Bearer ${h.landlordToken}`).send({})
    expect(voided.status).toBe(409)
    expect(res.body.data.openDraft.cancel_refusal).toBe(voided.body.error)
    expect(voided.body.error).toMatch(/took over on .* can't be canceled/)
  })
})

describe('a leaving date once the new lease has taken over', () => {
  it('goes on the new lease, even while the hand-off waits — and the household leaves from it', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!
    await db.query(`UPDATE leases SET start_date=$2 WHERE id=$1`, [nlId, today()])
    await activatePendingLeases()
    await processLeaseEnds()
    expect((await leaseRow(nlId)).status).toBe('pending')   // the hand-off waits on the old lease's last bill

    // The desk opens the row it sees (the old lease) and writes the day.
    const marked = await recordMoveOutNotice({ leaseId: h.leaseId, on: plusDays(12), byUserId: h.landlordUserId })
    expect(marked.id).toBe(nlId)
    expect(await leaseRow(nlId)).toMatchObject({ end_date: plusDays(12) })
    expect(await leaseRow(h.leaseId)).toMatchObject({ status: 'active', end_date: plusDays(-1) })

    // The hand-off goes through; the new lease is in force and ends on that day.
    await billRunOn(today())
    await activatePendingLeases()
    await processLeaseEnds()
    expect(await leaseRow(nlId)).toMatchObject({ status: 'active', end_date: plusDays(12) })
  })
})

describe('the lease a new lease follows is ended EARLY while the new lease waits', () => {
  const unitStatus = async (h: Household) =>
    (await db.query<{ status: string }>(`SELECT status FROM units WHERE id=$1`, [h.unitId])).rows[0].status
  const docStatus = async (docId: string) =>
    (await db.query<{ status: string }>(`SELECT status FROM lease_documents WHERE id=$1`, [docId])).rows[0].status
  const billsOn = async (leaseId: string) =>
    (await db.query(`SELECT 1 FROM invoices WHERE lease_id=$1 AND status <> 'void'`, [leaseId])).rows.length
  /** The tenant presses "End lease early" (no early-termination fee on file → it would end at once). */
  const tenantEndsEarly = (h: Household, leaseId = h.leaseId) =>
    api().post(`/api/leases/${leaseId}/terminate-early`).set('Authorization', `Bearer ${h.tenantToken}`).send({})
  /**
   * The way a lease still ends early under a waiting new lease: another lease
   * REPLACED it — a paper lease imported over it (jobs/leaseParser/resolveIntent
   * step 5c, these exact writes). The tenant's and the landlord's own early-end
   * buttons are refused up front (tests below).
   */
  const replacedByAnotherLease = async (h: Household) => {
    await db.query(
      `UPDATE leases SET status='terminated', end_date=COALESCE(end_date, CURRENT_DATE),
                         terminated_at=COALESCE(terminated_at, NOW()), updated_at=NOW() WHERE id=$1`, [h.leaseId])
    await db.query(
      `UPDATE lease_tenants SET status='removed', removed_at=NOW(), removed_reason='replaced' WHERE lease_id=$1 AND status='active'`,
      [h.leaseId])
  }

  it('a month-to-month household\'s lease is replaced and nobody signed the new one: it is canceled, never starts, and nothing is billed', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!

    await replacedByAnotherLease(h)
    await db.query(`UPDATE units SET status='vacant' WHERE id=$1`, [h.unitId])
    expect((await leaseRow(h.leaseId)).status).toBe('terminated')

    // The next run cancels the new lease, exactly as the window's Cancel would:
    // the deposit record goes back to the lease that ended.
    await processNewLeaseSignings({ hour: 12 })
    expect(await docStatus(docId)).toBe('voided')
    expect((await leaseRow(nlId)).status).toBe('terminated')
    const sd = await db.query<{ lease_id: string }>(`SELECT lease_id FROM security_deposits WHERE unit_id=$1`, [h.unitId])
    expect(sd.rows[0].lease_id).toBe(h.leaseId)
    // The landlord hears once, in plain words.
    const notes = await db.query<{ title: string; body: string }>(
      `SELECT title, body FROM notifications WHERE user_id=$1 AND type='lease_renewal_status'`, [h.landlordUserId])
    expect(notes.rows).toHaveLength(1)
    expect(notes.rows[0].title).toMatch(/^New lease canceled — /)
    expect(notes.rows[0].body).toContain('ended early on')
    expect(notes.rows[0].body).toContain('nobody in the household had signed the new lease')
    // Another run does nothing more.
    await processNewLeaseSignings({ hour: 12 })
    expect((await db.query(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='lease_renewal_status'`, [h.landlordUserId])).rows).toHaveLength(1)

    // The start date comes: nothing comes into force, the space stays empty, nothing is billed.
    await db.query(`UPDATE leases SET start_date=$2 WHERE id=$1`, [nlId, today()])
    await activatePendingLeases()
    await processLeaseEnds()
    await billRunOn(today())
    await billRunOn(nextDueDateAfter(today(), 1))
    expect((await leaseRow(nlId)).status).toBe('terminated')
    expect(await unitStatus(h)).toBe('vacant')
    expect(await billsOn(nlId)).toBe(0)
  })

  it('even before it is canceled it never comes into force — and the landlord can cancel it by hand', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!
    await replacedByAnotherLease(h)
    await db.query(`UPDATE units SET status='vacant' WHERE id=$1`, [h.unitId])

    // The start date passes before any cancel ran.
    await db.query(`UPDATE leases SET start_date=$2 WHERE id=$1`, [nlId, today()])
    await activatePendingLeases()
    await processLeaseEnds()
    await billRunOn(today())
    expect((await leaseRow(nlId)).status).toBe('pending')
    expect(await unitStatus(h)).toBe('vacant')
    expect(await billsOn(nlId)).toBe(0)

    // Nobody is staying on, so the window offers the cancel and the server takes it.
    const ctx = (await api().get(`/api/esign/documents/renewal-context/${h.leaseId}`)
      .set('Authorization', `Bearer ${h.landlordToken}`)).body.data.openDraft
    expect(ctx).toMatchObject({ id: docId, can_cancel: true, cancel_refusal: null })
    const res = await api().post(`/api/esign/documents/${docId}/void`).set('Authorization', `Bearer ${h.landlordToken}`)
      .send({ reason: 'canceled by the landlord' })
    expect(res.status).toBe(200)
    expect((await leaseRow(nlId)).status).toBe('terminated')
  })

  it('somebody in the household signed it: it stands, is never canceled for them, and takes over on its start date (decisions 10/2 #8)', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!
    await db.query(`UPDATE lease_document_signers SET status='signed', signed_at=NOW() WHERE document_id=$1 AND role <> 'landlord'`, [docId])
    await db.query(`UPDATE leases SET status='terminated', terminated_at=NOW() WHERE id=$1`, [h.leaseId])

    await processNewLeaseSignings({ hour: 12 })
    expect(await docStatus(docId)).not.toBe('voided')
    expect((await leaseRow(nlId)).status).toBe('pending')
    const ctx = (await api().get(`/api/esign/documents/renewal-context/${h.leaseId}`)
      .set('Authorization', `Bearer ${h.landlordToken}`)).body.data.openDraft
    expect(ctx).toMatchObject({ can_cancel: false })
    expect(ctx.cancel_refusal).toMatch(/has signed this new lease, so it can't be canceled.*They're leaving on/)

    await db.query(`UPDATE leases SET start_date=$2 WHERE id=$1`, [nlId, today()])
    await activatePendingLeases()
    expect((await leaseRow(nlId)).status).toBe('active')
  })

  it('a held-over fixed term replaced early gets its move-out walkthrough — the unsigned new lease no longer hides it', async () => {
    const park = await seedPark()
    const h = await addHousehold(park, { end: plusDays(-1) })
    await db.query(`UPDATE units SET unit_type='mobile_home' WHERE id=$1`, [h.unitId])
    await newLeaseSignedByLandlord(park, h, plusDays(2))
    await activatePendingLeases()                                 // holds over to plusDays(1)
    expect(await leaseRow(h.leaseId)).toMatchObject({ status: 'active', end_date: plusDays(1) })
    await replacedByAnotherLease(h)

    // Before anything cancels the new lease, the walkthrough is already scheduled.
    const r = await scheduleMoveOutInspections()
    expect(r.scheduled).toBe(1)
    const insp = await db.query<{ lease_id: string }>(
      `SELECT lease_id FROM unit_inspections WHERE inspection_type='move_out' AND unit_id=$1`, [h.unitId])
    expect(insp.rows.map(x => x.lease_id)).toEqual([h.leaseId])
  })

  it('no "not signed yet" alert about a new lease whose household ended its lease early', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!
    await db.query(`UPDATE leases SET status='terminated', terminated_at=NOW() WHERE id=$1`, [h.leaseId])
    await db.query(`UPDATE leases SET start_date=$2 WHERE id=$1`, [nlId, today()])
    const r = await runRenewalPings()
    expect(r.unsignedAlerts).toBe(0)
    expect(mocks.tenantUnsigned).not.toHaveBeenCalled()
  })

  it('ending a lease early while its new lease waits is refused up front, in the front desk\'s words (newLeaseBlocksEarlyEnd)', async () => {
    const { newLeaseBlocksEarlyEnd } = await import('../services/renewalSuccessor')
    const rq = async (sql: string, params?: any[]) => ({ rows: (await db.query(sql, params)).rows })
    const park = await seedPark()
    const h = await addHousehold(park)
    const words = DateTime.fromISO(plusDays(40)).toFormat('LLLL d, yyyy')
    expect(await newLeaseBlocksEarlyEnd(rq, h.leaseId, 'tenant')).toBeNull()

    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!
    // Nobody has signed: cancel it first.
    expect(await newLeaseBlocksEarlyEnd(rq, h.leaseId, 'landlord')).toMatch(
      new RegExp(`has a new lease starting ${words}\\. If they are leaving instead, cancel it first: Leases → Change → New lease — view or cancel → Cancel the new lease\\. Then end this lease\\.$`))
    expect(await newLeaseBlocksEarlyEnd(rq, h.leaseId, 'tenant')).toBe(
      `There is a new lease for ${(await db.query<any>(`SELECT unit_number FROM units WHERE id=$1`, [h.unitId])).rows[0].unit_number} starting ${words}. ` +
      'To end your lease early instead, ask the office to cancel that new lease first, then come back here.')
    // The new lease itself cannot be ended before it starts.
    expect(await newLeaseBlocksEarlyEnd(rq, nlId, 'tenant')).toMatch(/^This new lease starts .*, so it can't be ended before it starts\./)
    expect(await newLeaseBlocksEarlyEnd(rq, nlId, 'landlord')).toMatch(/has not started yet .* cancel it instead/)

    // Somebody has signed: it stands; the leaving date goes on it once it starts.
    await db.query(`UPDATE lease_document_signers SET status='signed', signed_at=NOW() WHERE document_id=$1 AND role <> 'landlord'`, [docId])
    expect(await newLeaseBlocksEarlyEnd(rq, h.leaseId, 'landlord')).toMatch(
      /that the household has signed, so this lease can't be ended early — a signed lease stands\. Write down the day they leave on the new lease once it starts \(Leases → Change → They're leaving on…\)\.$/)
    expect(await newLeaseBlocksEarlyEnd(rq, h.leaseId, 'tenant')).toMatch(
      /^Your household has signed the new lease for .* so this lease can't be ended early — a signed lease stands\. If you are moving out, tell the office/)
  })

  // ── The tenant's and the landlord's own early-end buttons (decisions 10/2 #8) ──
  const terminationRequests = async (h: Household) =>
    (await db.query(`SELECT status FROM lease_termination_requests WHERE lease_id=$1`, [h.leaseId])).rows

  it('"End lease early" is refused while nobody has signed the new lease — cancel it first — and the lease stays in force', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!

    const res = await tenantEndsEarly(h)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^There is a new lease for .* starting .*\. To end your lease early instead, ask the office to cancel that new lease first, then come back here\.$/)
    expect((await leaseRow(h.leaseId)).status).toBe('active')
    expect((await leaseRow(nlId)).status).toBe('pending')
    expect(await unitStatus(h)).toBe('active')
    expect(await terminationRequests(h)).toHaveLength(0)
  })

  it('once somebody in the household has signed it, "End lease early" is refused with the leaving-date step — the lease stays in force', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!
    await db.query(`UPDATE lease_document_signers SET status='signed', signed_at=NOW() WHERE document_id=$1 AND role <> 'landlord'`, [docId])

    const res = await tenantEndsEarly(h)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^Your household has signed the new lease for .* so this lease can't be ended early — a signed lease stands\. If you are moving out, tell the office the day you are leaving; it goes on the new lease once that starts\.$/)
    expect((await leaseRow(h.leaseId)).status).toBe('active')
    // Nor the new lease itself, before it starts.
    const own = await tenantEndsEarly(h, nlId)
    expect(own.status).toBe(409)
    expect(own.body.error).toMatch(/^This new lease starts .*, so it can't be ended before it starts\. If you are moving out, tell the office the day you are leaving\.$/)
    expect((await leaseRow(nlId)).status).toBe('pending')
    expect(await unitStatus(h)).toBe('active')
    expect(await terminationRequests(h)).toHaveLength(0)
  })

  it('a request made BEFORE the new lease was signed cannot be waived through by the landlord afterwards — the lease stays in force', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    // An early-termination fee is on the lease and the tenant has no card on
    // file, so the request waits ('failed') for the landlord instead of ending
    // the lease at once.
    await db.query(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing)
       VALUES ($1,'early_termination_fee',500,FALSE,'move_out')`, [h.leaseId])
    const asked = await tenantEndsEarly(h)
    expect(asked.status).toBe(200)
    expect(asked.body.data.chargeStatus).toBe('failed')
    expect((await leaseRow(h.leaseId)).status).toBe('active')

    // Then the landlord signs a new lease for the household.
    await newLeaseSignedByLandlord(park, h, plusDays(40))
    const waived = await api().post(`/api/leases/${h.leaseId}/waive-early-termination`)
      .set('Authorization', `Bearer ${h.landlordToken}`).send({ reason: 'let them go' })
    expect(waived.status).toBe(409)
    expect(waived.body.error).toMatch(/ has a new lease starting .*\. If they are leaving instead, cancel it first: Leases → Change → New lease — view or cancel → Cancel the new lease\. Then end this lease\.$/)
    expect((await leaseRow(h.leaseId)).status).toBe('active')
    expect(await unitStatus(h)).toBe('active')
    expect((await terminationRequests(h)).map((r: any) => r.status)).toEqual(['failed'])
  })

  it('after the new lease is canceled, "End lease early" works again', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(40))
    expect((await tenantEndsEarly(h)).status).toBe(409)
    expect((await leaseRow(h.leaseId)).status).toBe('active')

    const canceled = await api().post(`/api/esign/documents/${docId}/void`)
      .set('Authorization', `Bearer ${h.landlordToken}`).send({ reason: 'canceled by the landlord' })
    expect(canceled.status).toBe(200)

    const res = await tenantEndsEarly(h)
    expect(res.status).toBe(200)
    expect((await leaseRow(h.leaseId)).status).toBe('terminated')
  })

  // ── Money already paid on the new lease ─────────────────────────────────
  /** A payment that really moved on the new lease (a deposit top-up paid early). */
  const paidOnNewLease = async (h: Household, leaseId: string, amount = 50) =>
    (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'deposit',$5,'settled','DEPOSIT',CURRENT_DATE) RETURNING id`,
      [h.landlordId, h.tenantId, leaseId, h.unitId, amount])).rows[0].id
  const leaseNotices = async (userId: string) =>
    (await db.query<{ title: string; body: string }>(
      `SELECT title, body FROM notifications WHERE user_id=$1 AND type='lease_renewal_status' ORDER BY created_at`, [userId])).rows
  const heldAdminNotices = async () =>
    (await db.query(`SELECT 1 FROM admin_notifications WHERE category='new_lease_cancel_held'`)).rows.length

  it('money paid on it holds the cancel: the landlord side and GAM hear ONCE, the deposit goes back to the lease that ended, and once the money is returned it is canceled', async () => {
    const { logger } = await import('../lib/logger')
    const errors = vi.spyOn(logger, 'error')
    const park = await seedPark()
    const h = await addHousehold(park)
    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!
    const depositLease = async () =>
      (await db.query<{ lease_id: string }>(`SELECT lease_id FROM security_deposits WHERE unit_id=$1`, [h.unitId])).rows[0].lease_id
    // The landlord's signature moved the household's deposit record onto the new lease.
    expect(await depositLease()).toBe(nlId)
    const payId = await paidOnNewLease(h, nlId)
    await replacedByAnotherLease(h)

    try {
      await processNewLeaseSignings({ hour: 12 })
      // Not canceled — and not failing, either.
      expect(await docStatus(docId)).toBe('in_progress')
      expect((await leaseRow(nlId)).status).toBe('pending')
      expect(errors.mock.calls.some(c => String(c[1] ?? '').includes('could not cancel a new lease'))).toBe(false)
      // The deposit record is back on the lease that ended, for its return.
      expect(await depositLease()).toBe(h.leaseId)
      const notes = await leaseNotices(h.landlordUserId)
      expect(notes).toHaveLength(1)
      expect(notes[0].title).toMatch(/^New lease can't be canceled yet — /)
      expect(notes[0].body).toContain('It will never start, but $50.00 was already paid on it, so it can\'t be canceled until that money is returned or moved.')
      expect(notes[0].body).toContain('GAM has been told. To speed it up, email support@goldassetmanagement.com and name the space. Once it is sorted, the new lease is canceled for you.')
      expect(await heldAdminNotices()).toBe(1)

      // The next runs leave it be: no second notice, no error every 15 minutes.
      await processNewLeaseSignings({ hour: 12 })
      await processNewLeaseSignings({ hour: 12 })
      expect(await leaseNotices(h.landlordUserId)).toHaveLength(1)
      expect(await heldAdminNotices()).toBe(1)
      expect(errors.mock.calls.some(c => /\[ESIGN-TIMEOUTS\]/.test(String(c[1] ?? '')))).toBe(false)

      // Its start date passes: it still never comes into force.
      await db.query(`UPDATE leases SET start_date=$2 WHERE id=$1`, [nlId, today()])
      await activatePendingLeases()
      expect((await leaseRow(nlId)).status).toBe('pending')
      await db.query(`UPDATE leases SET start_date=$2 WHERE id=$1`, [nlId, plusDays(40)])

      // GAM returns the money: the next run cancels it like any other.
      await db.query(`UPDATE payments SET status='returned' WHERE id=$1`, [payId])
      await processNewLeaseSignings({ hour: 12 })
      expect(await docStatus(docId)).toBe('voided')
      expect((await leaseRow(nlId)).status).toBe('terminated')
      expect(await depositLease()).toBe(h.leaseId)
      const after = await leaseNotices(h.landlordUserId)
      expect(after).toHaveLength(2)
      expect(after[1].title).toMatch(/^New lease canceled — /)
    } finally {
      errors.mockRestore()
    }
  })

  it('the window and the cancel route say WHY money paid on a new lease stops the cancel, and who sorts it out', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!
    await paidOnNewLease(h, nlId)
    const unit = (await db.query<any>(`SELECT COALESCE(display_label, unit_number) AS label FROM units WHERE id=$1`, [h.unitId])).rows[0].label
    const why = (tail: string) => `$50.00 has already been paid on this new lease, so it can't be canceled until that money is ` +
      `returned or moved — GAM support does that. Email support@goldassetmanagement.com and name ${unit}. ${tail}`
    const ctx = async () => (await api().get(`/api/esign/documents/renewal-context/${h.leaseId}`)
      .set('Authorization', `Bearer ${h.landlordToken}`)).body.data.openDraft

    // The household is still on its lease: the landlord cancels it once it is sorted.
    expect(await ctx()).toMatchObject({ id: docId, can_cancel: false, cancel_refusal: why('Once it is sorted, you can cancel it here.') })
    const res = await api().post(`/api/esign/documents/${docId}/void`).set('Authorization', `Bearer ${h.landlordToken}`)
      .send({ reason: 'canceled by the landlord' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(why('Once it is sorted, you can cancel it here.'))
    expect(await docStatus(docId)).toBe('in_progress')

    // Its lease was replaced: it is canceled for them once it is sorted.
    await replacedByAnotherLease(h)
    expect((await ctx()).cancel_refusal).toBe(why('Once it is sorted, the new lease is canceled for you.'))
  })

  it('the household is not reminded of, shown, or let sign a new lease whose lease was replaced — and the landlord\'s Leases page says it will be canceled', async () => {
    const park = await seedPark()
    const gone = await addHousehold(park)
    const staying = await addHousehold(park)
    const goneDoc = (await newLeaseSignedByLandlord(park, gone, plusDays(14))).docId
    await newLeaseSignedByLandlord(park, staying, plusDays(14))
    const goneNl = (await successorOf(gone))!
    const stayingNl = (await successorOf(staying))!
    // Both were sent the new lease long enough ago that the 14-day reminder is due.
    await db.query(`UPDATE lease_document_signers SET invite_sent_at = NOW() - INTERVAL '20 days', reminder_sent_at = NULL
                     WHERE role <> 'landlord' AND document_id IN (SELECT id FROM lease_documents WHERE renews_lease_id = ANY($1::uuid[]))`,
      [[gone.leaseId, staying.leaseId]])
    await paidOnNewLease(gone, goneNl)            // so the cancel waits and the lease stays in the tables
    await replacedByAnotherLease(gone)

    // 9am: only the household that is staying is reminded.
    await processNewLeaseSignings({ hour: 9 })
    expect(mocks.newLeaseReminder.mock.calls.map(c => c[0])).toEqual([staying.tenantEmail])

    // Their portal shows no lease to sign — not as their lease, not as a banner.
    const list = await api().get('/api/tenants/leases').set('Authorization', `Bearer ${gone.tenantToken}`)
    expect(list.status).toBe(200)
    expect(list.body.data.map((l: any) => l.id)).not.toContain(goneNl)
    const me = await api().get('/api/tenants/me').set('Authorization', `Bearer ${gone.tenantToken}`)
    expect(me.body.data.pending_renewal_document_id).toBeNull()

    // The emailed link cannot make it stand either.
    const signed = await api().post(`/api/esign/sign/${goneDoc}`).set('Authorization', `Bearer ${gone.tenantToken}`).send({ fieldValues: [] })
    expect(signed.status).toBe(409)
    expect(signed.body.error).toBe('The lease this new lease was to follow has ended, so it can no longer be signed — it is being canceled. If you meant to stay, contact the office.')
    expect((await db.query(`SELECT 1 FROM lease_document_signers WHERE document_id=$1 AND role <> 'landlord' AND signed_at IS NOT NULL`, [goneDoc])).rows).toHaveLength(0)

    // The landlord's list: the server says which one will not start.
    const leases = await api().get('/api/leases').set('Authorization', `Bearer ${gone.landlordToken}`)
    const row = (id: string) => leases.body.data.find((l: any) => l.id === id)
    expect(row(goneNl).new_lease_wont_start).toBe(true)
    expect(row(stayingNl).new_lease_wont_start).toBe(false)
    expect(row(staying.leaseId).new_lease_wont_start).toBe(false)
  })
})

describe('the never-signed draft and the reminders', () => {
  /** A new lease in the state the landlord left it, directly in the tables. */
  async function seedDoc(h: Household, opts: { issued: boolean; start: string; invitedDaysAgo?: number; issuedDaysAgo?: number; tenantSigned?: boolean }) {
    let leaseId: string | null = null
    if (opts.issued) {
      leaseId = (await db.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, rent_due_day,
                             supersedes_lease_id, signed_by_landlord, signed_by_tenant)
         VALUES ($1,$2,1050,'month_to_month','pending',$3,1,$4,TRUE,$5) RETURNING id`,
        [h.unitId, h.landlordId, opts.start, h.leaseId, !!opts.tenantSigned])).rows[0].id
      await db.query(
        `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
         VALUES ($1,$2,'primary','active',NOW(),'original','joint_several')`, [leaseId, h.tenantId])
    }
    const d = await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status, renews_lease_id, lease_id,
                                    issued_at, created_at)
       VALUES ($1,$2,'New Lease','original_lease',$3,$4,$5,
               CASE WHEN $6 THEN NOW() - make_interval(days => $7) END, NOW() - make_interval(days => $7)) RETURNING id`,
      [h.landlordId, h.unitId, opts.issued ? 'in_progress' : 'sent', h.leaseId, leaseId, opts.issued, opts.issuedDaysAgo ?? 0])
    const invited = `NOW() - make_interval(days => ${Number(opts.invitedDaysAgo ?? 0)})`
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status, signed_at, invite_sent_at)
       VALUES ($1,$2,'landlord','L L','ll@test.dev',1,$3,$4, CASE WHEN $5 THEN NOW() END, ${invited})`,
      [d.rows[0].id, h.landlordUserId, crypto.randomBytes(32).toString('hex'), opts.issued ? 'signed' : 'sent', opts.issued])
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status, signed_at, invite_sent_at)
       VALUES ($1,$2,'primary','Pat Resident',$3,2,$4,$5, CASE WHEN $6 THEN NOW() END, CASE WHEN $7 THEN ${invited} END)`,
      [d.rows[0].id, h.tenantUserId, h.tenantEmail, crypto.randomBytes(32).toString('hex'),
       opts.tenantSigned ? 'signed' : (opts.issued ? 'sent' : 'pending'), !!opts.tenantSigned, opts.issued])
    await db.query(
      `INSERT INTO lease_document_fields (document_id, field_type, signer_role, lease_column, value, required) VALUES
         ($1,'text','landlord','start_date',$2,FALSE), ($1,'text','landlord','rent_amount','1050.00',FALSE)`,
      [d.rows[0].id, isoToDocumentDate(opts.start)])
    return { docId: d.rows[0].id, leaseId }
  }
  const docStatus = async (id: string) => (await db.query<any>(`SELECT status FROM lease_documents WHERE id=$1`, [id])).rows[0].status

  it('a draft the landlord never signed lapses once its start date has passed — only the landlord hears, nothing changes', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const lapsed = await seedDoc(h, { issued: false, start: plusDays(-1) })
    const waiting = await seedDoc(await addHousehold(park), { issued: false, start: plusDays(10) })
    await processNewLeaseSignings({ hour: 12 })
    expect(await docStatus(lapsed.docId)).toBe('voided')
    expect(await docStatus(waiting.docId)).toBe('sent')
    // The landlord side only (the signer and the account owner); the household
    // was never sent the draft.
    const to = mocks.draftLapsed.mock.calls.map(c => c[0])
    expect(to).toContain('ll@test.dev')
    expect(to).not.toContain(h.tenantEmail)
    expect(await leaseRow(h.leaseId)).toMatchObject({ status: 'active', end_date: null })
  })

  it('a new lease the landlord signed is never canceled for want of the tenant\'s signature', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const issued = await seedDoc(h, { issued: true, start: plusDays(-2), invitedDaysAgo: 30 })
    await processNewLeaseSignings({ hour: 12 })
    expect(await docStatus(issued.docId)).toBe('in_progress')
  })

  it('reminds the tenant 14 days out and 3 days out — once each', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const d = await seedDoc(h, { issued: true, start: plusDays(14), invitedDaysAgo: 20, issuedDaysAgo: 20 })
    await processNewLeaseSignings({ hour: 9 })
    expect(mocks.newLeaseReminder).toHaveBeenCalledTimes(1)
    expect(mocks.newLeaseReminder.mock.calls[0][5]).toMatchObject({ startDate: plusDays(14) })
    expect(mocks.newLeaseReminder.mock.calls[0][5].forLandlord).toBeFalsy()
    await processNewLeaseSignings({ hour: 9 })
    expect(mocks.newLeaseReminder).toHaveBeenCalledTimes(1)
    // Eleven days on: the 3-day reminder.
    await db.query(`UPDATE leases SET start_date=$2 WHERE id=$1`, [d.leaseId, plusDays(3)])
    await db.query(`UPDATE lease_document_signers SET reminder_sent_at = NOW() - INTERVAL '11 days'
                     WHERE document_id=$1 AND role <> 'landlord'`, [d.docId])
    await processNewLeaseSignings({ hour: 9 })
    expect(mocks.newLeaseReminder).toHaveBeenCalledTimes(2)
  })

  it('reminds the LANDLORD each morning while a draft waits on their signature — once a day', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    await seedDoc(h, { issued: false, start: plusDays(30), invitedDaysAgo: 2 })
    await processNewLeaseSignings({ hour: 8 })
    expect(mocks.landlordDigest).toHaveBeenCalledTimes(1)
    expect(mocks.landlordDigest.mock.calls[0][0]).toBe('ll@test.dev')
    expect(mocks.landlordDigest.mock.calls[0][2]).toEqual([
      expect.objectContaining({ startDate: plusDays(30), rent: '1050.00' })])
    expect(mocks.newLeaseReminder).not.toHaveBeenCalled()
    await processNewLeaseSignings({ hour: 8 })
    expect(mocks.landlordDigest).toHaveBeenCalledTimes(1)
  })

  it('one morning email for every draft waiting on the same landlord — with one link that signs them in a row', async () => {
    const park = await seedPark()
    const docs = []
    for (let i = 0; i < 3; i++) docs.push(await seedDoc(await addHousehold(park), { issued: false, start: plusDays(30), invitedDaysAgo: 2 }))
    await processNewLeaseSignings({ hour: 8 })
    expect(mocks.landlordDigest).toHaveBeenCalledTimes(1)
    const [to, , items, url] = mocks.landlordDigest.mock.calls[0]
    expect(to).toBe('ll@test.dev')
    expect(items).toHaveLength(3)
    const tokens = (await db.query<{ token: string }>(
      `SELECT token FROM lease_document_signers WHERE document_id = ANY($1) AND role='landlord'`, [docs.map(d => d.docId)])).rows.map(r => r.token)
    const m = /\/sign\/([0-9a-f]{64})\?queue=([0-9a-f,]+)$/.exec(String(url))
    expect(m).not.toBeNull()
    expect([m![1], ...m![2].split(',')].sort()).toEqual([...tokens].sort())
    // Every one is stamped, so tomorrow is one email again, not three.
    const stamped = await db.query(`SELECT 1 FROM lease_document_signers WHERE document_id = ANY($1) AND role='landlord' AND reminder_count = 1`,
      [docs.map(d => d.docId)])
    expect(stamped.rows).toHaveLength(3)
  })

  it('drafts that lapse together are one email to each landlord-side person', async () => {
    const park = await seedPark()
    await seedDoc(await addHousehold(park), { issued: false, start: plusDays(-1) })
    await seedDoc(await addHousehold(park), { issued: false, start: plusDays(-1) })
    await processNewLeaseSignings({ hour: 12 })
    const toLl = mocks.draftLapsed.mock.calls.filter(c => c[0] === 'll@test.dev')
    expect(toLl).toHaveLength(1)
    expect(toLl[0][2]).toHaveLength(2)
  })

  it('a new lease sent inside the 14 days gets no 14-day reminder on top of its signing request', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    await seedDoc(h, { issued: true, start: plusDays(10), invitedDaysAgo: 0 })
    await processNewLeaseSignings({ hour: 9 })
    expect(mocks.newLeaseReminder).not.toHaveBeenCalled()
  })

  it('the landlord hears 14 days before the start, then on the start date, that the tenant has not signed', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const d = await seedDoc(h, { issued: true, start: plusDays(14), issuedDaysAgo: 20, invitedDaysAgo: 20 })
    let r = await runRenewalPings()
    expect(r.unsignedAlerts).toBe(1)
    expect(mocks.tenantUnsigned.mock.calls[0][3]).toMatchObject({ stage: 'soon' })
    expect(mocks.tenantUnsigned.mock.calls[0][2]).toEqual([expect.objectContaining({ tenantNames: 'Pat Resident', startDate: plusDays(14) })])
    r = await runRenewalPings()
    expect(r.unsignedAlerts).toBe(0)
    await db.query(`UPDATE leases SET start_date=$2 WHERE id=$1`, [d.leaseId, today()])
    r = await runRenewalPings()
    expect(r.unsignedAlerts).toBe(1)
    expect(mocks.tenantUnsigned.mock.calls[1][3]).toMatchObject({ stage: 'started' })
    expect((await runRenewalPings()).unsignedAlerts).toBe(0)
  })

  it('households of one landlord that have not signed are ONE alert email per stage, listing them all', async () => {
    const park = await seedPark()
    for (let i = 0; i < 3; i++) {
      await seedDoc(await addHousehold(park), { issued: true, start: plusDays(14), issuedDaysAgo: 20, invitedDaysAgo: 20 })
    }
    const r = await runRenewalPings()
    expect(r.unsignedAlerts).toBe(3)
    expect(mocks.tenantUnsigned).toHaveBeenCalledTimes(1)
    expect(mocks.tenantUnsigned.mock.calls[0][2]).toHaveLength(3)
    expect(mocks.tenantUnsigned.mock.calls[0][3]).toMatchObject({ stage: 'soon' })
    const notes = await db.query(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='lease_renewal_status'`, [park.landlordUserId])
    expect(notes.rows).toHaveLength(1)
    expect((await runRenewalPings()).unsignedAlerts).toBe(0)
    expect(mocks.tenantUnsigned).toHaveBeenCalledTimes(1)
  })

  it('no "not signed" alert for a lease the landlord only just sent, or once the tenant has signed', async () => {
    const park = await seedPark()
    await seedDoc(await addHousehold(park), { issued: true, start: plusDays(5), issuedDaysAgo: 0 })
    await seedDoc(await addHousehold(park), { issued: true, start: plusDays(14), issuedDaysAgo: 20, tenantSigned: true })
    expect((await runRenewalPings()).unsignedAlerts).toBe(0)
  })
})

describe('the sitting tenant sees a banner and a next lease — never the lock-in, never "ending"', () => {
  it('GET /me: the new lease is not the signing lock-in; it is pending_renewal_* (their turn)', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const start = plusDays(40)
    const { docId } = await newLeaseSignedByLandlord(park, h, start)
    const me = await api().get('/api/tenants/me').set('Authorization', `Bearer ${h.tenantToken}`)
    expect(me.status).toBe(200)
    expect(me.body.data.pending_lease_document_id).toBeNull()
    expect(me.body.data).toMatchObject({
      pending_renewal_document_id: docId, pending_renewal_start_date: start,
      pending_renewal_rent: '1050.00', pending_renewal_waiting_on_is_me: true,
    })
    // Two leases on file, one tenancy: FlexPay is not paused for "more than one lease".
    await db.query(`UPDATE tenants SET flexpay_enrolled=TRUE WHERE id=$1`, [h.tenantId])
    const me2 = await api().get('/api/tenants/me').set('Authorization', `Bearer ${h.tenantToken}`)
    expect(me2.body.data.flexpay_paused_multi_lease).toBe(false)
  })

  it('GET /leases and /lease: the lease in force first, the new one attached as next_lease — not a second lease', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const start = plusDays(40)
    const { docId } = await newLeaseSignedByLandlord(park, h, start)
    const list = await api().get('/api/tenants/leases').set('Authorization', `Bearer ${h.tenantToken}`)
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0].id).toBe(h.leaseId)
    expect(list.body.data[0].next_lease).toMatchObject({ start_date: start, signed_by_tenant: false, document_id: docId })
    const one = await api().get('/api/tenants/lease').set('Authorization', `Bearer ${h.tenantToken}`)
    expect(one.body.data.id).toBe(h.leaseId)
    expect(one.body.data.next_lease.start_date).toBe(start)
  })

  it('GET /sign gives the signing page the first bill under the new lease, with no session needed', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const start = plusDays(40)
    const { docId } = await newLeaseSignedByLandlord(park, h, start)
    // The emailed link: the tenant's own signer token, no Authorization header.
    const token = (await db.query<{ token: string }>(
      `SELECT token FROM lease_document_signers WHERE document_id=$1 AND role='primary'`, [docId])).rows[0].token
    const res = await api().get(`/api/esign/sign/${token}`)
    expect(res.status).toBe(200)
    const rb = res.body.data.renewal_billing
    expect(rb).toMatchObject({ previous_end_date: null, previous_due_day: 1, start_date: start, rent: 1050, due_day: 1, started: false })
    const first = nextDueDateAfter(DateTime.fromISO(start).minus({ days: 1 }).toISODate()!, 1)
    const words = DateTime.fromISO(first).toFormat('LLLL d, yyyy')
    expect(rb.summary).toContain(words)
    expect(rb.summary).toContain('$1,050.00')
    expect(rb.box_money_kinds).toEqual([])
  })

  it('GET /sign says the new lease has started once its start date has come', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const { docId } = await newLeaseSignedByLandlord(park, h, plusDays(40))
    await db.query(`UPDATE lease_document_fields SET value=$2 WHERE document_id=$1 AND lease_column='start_date'`,
      [docId, isoToDocumentDate(today())])
    const token = (await db.query<{ token: string }>(
      `SELECT token FROM lease_document_signers WHERE document_id=$1 AND role='primary'`, [docId])).rows[0].token
    const res = await api().get(`/api/esign/sign/${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.renewal_billing).toMatchObject({ start_date: today(), started: true })
  })
})

describe('the rest of the platform reads the new lease as the same tenancy', () => {
  it('the front desk cannot write down a leaving date while a new lease is waiting — and is told how to undo it', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    await newLeaseSignedByLandlord(park, h, plusDays(40))
    await expect(recordMoveOutNotice({ leaseId: h.leaseId, on: plusDays(10), byUserId: h.landlordUserId }))
      .rejects.toThrow(/new lease starting .* cancel it first/)
  })

  it('deposit portability never offers the household\'s own new lease as somewhere to carry the deposit', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    await newLeaseSignedByLandlord(park, h, plusDays(40))
    const nlId = (await successorOf(h))!
    const fromOld = await detectPortabilityEligible({ leaseId: h.leaseId, tenantId: h.tenantId })
    expect(fromOld.target_lease_id).toBeNull()
    const fromNew = await detectPortabilityEligible({ leaseId: nlId, tenantId: h.tenantId })
    expect(fromNew.target_lease_id).toBeNull()
  })

  it('the lease-expiry notice skips a fixed term that already has a new lease to follow it', async () => {
    const park = await seedPark()
    const ending = await addHousehold(park, { end: plusDays(20) })
    const renewing = await addHousehold(park, { end: plusDays(20) })
    await db.query(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, rent_due_day,
                           supersedes_lease_id, signed_by_landlord, signed_by_tenant)
       VALUES ($1,$2,1050,'month_to_month','pending',$3,1,$4,TRUE,FALSE)`,
      [renewing.unitId, park.landlordId, plusDays(21), renewing.leaseId])
    await checkLeaseExpiryNotices()
    const sent = await db.query<{ id: string; at: string | null }>(
      `SELECT id, expiration_notice_sent_at AS at FROM leases WHERE id = ANY($1)`, [[ending.leaseId, renewing.leaseId]])
    const at = Object.fromEntries(sent.rows.map(r => [r.id, r.at]))
    expect(at[ending.leaseId]).not.toBeNull()
    expect(at[renewing.leaseId]).toBeNull()
  })

  it('renewal pings: no "are you staying?" and no "lease ending" alert for a lease with a new lease to follow it', async () => {
    const park = await seedPark()
    const h = await addHousehold(park, { end: plusDays(30) })
    await db.query(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, rent_due_day,
                           supersedes_lease_id, signed_by_landlord, signed_by_tenant)
       VALUES ($1,$2,1050,'month_to_month','pending',$3,1,$4,TRUE,FALSE)`,
      [h.unitId, park.landlordId, plusDays(31), h.leaseId])
    const r = await runRenewalPings()
    expect(r.pinged).toBe(0)
    expect(r.alerted).toBe(0)
  })
})

describe('deposit return follows the tenancy back through its earlier leases', () => {
  it('a pet deposit paid on the old lease comes back at the new lease\'s move-out, and the old lease\'s unpaid line is swept', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    // $200 pet deposit, PAID on the old lease.
    const fee = await db.query<{ id: string }>(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing, money_kind)
       VALUES ($1,'pet_deposit',200,TRUE,'move_in','deposit') RETURNING id`, [h.leaseId])
    await db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description,
                             due_date, lease_fee_id, settled_at)
       VALUES ($1,$2,$3,$4,'deposit',200,'settled','DEPOSIT','2025-06-15',$5,NOW())`,
      [h.landlordId, h.unitId, h.leaseId, h.tenantId, fee.rows[0].id])
    // A charge left unpaid on the old lease.
    await db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'fee',35,'pending','OTHERFEE','2026-08-01')`,
      [h.landlordId, h.unitId, h.leaseId, h.tenantId])
    // The new lease, handed over: the security deposit record moved to it.
    const nl = await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, rent_due_day,
                           supersedes_lease_id, signed_by_landlord, signed_by_tenant)
       VALUES ($1,$2,1050,'month_to_month','active','2026-09-01',1,$3,TRUE,TRUE) RETURNING id`,
      [h.unitId, h.landlordId, h.leaseId])
    await db.query(
      `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1,$2,'primary','active',NOW(),'original','joint_several')`, [nl.rows[0].id, h.tenantId])
    // Signed as this household's new lease (the only way an e-signed lease
    // follows another).
    await db.query(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status, renews_lease_id, lease_id)
       VALUES ($1,$2,'New Lease','original_lease','completed',$3,$4)`, [h.landlordId, h.unitId, h.leaseId, nl.rows[0].id])
    await db.query(`UPDATE security_deposits SET lease_id=$2 WHERE lease_id=$1`, [h.leaseId, nl.rows[0].id])
    await db.query(`UPDATE leases SET status='expired', end_date='2026-08-31' WHERE id=$1`, [h.leaseId])

    const calc = await calculateDepositReturn(nl.rows[0].id)
    expect(calc!.total_deposit).toBe(700)
    expect(calc!.unpaid_balance_lines.map(l => l.amount)).toEqual([35])
  })

  it('never follows a PDF import back to a DIFFERENT household on the same space — their deposits and unpaid bills stay theirs', async () => {
    const park = await seedPark()
    const a = await addHousehold(park)
    // Household A: a $200 pet deposit PAID, and $300 rent left unpaid.
    const fee = await db.query<{ id: string }>(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing, money_kind)
       VALUES ($1,'pet_deposit',200,TRUE,'move_in','deposit') RETURNING id`, [a.leaseId])
    await db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description,
                             due_date, lease_fee_id, settled_at)
       VALUES ($1,$2,$3,$4,'deposit',200,'settled','DEPOSIT','2025-06-15',$5,NOW())`,
      [a.landlordId, a.unitId, a.leaseId, a.tenantId, fee.rows[0].id])
    await db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',300,'pending','RENT','2026-08-01')`,
      [a.landlordId, a.unitId, a.leaseId, a.tenantId])
    // Household B imported over A on the same space (the PDF import links it).
    const c = await db.connect()
    let bTenantId: string
    try { bTenantId = await seedTenant(c, { email: `b-${randomUUID()}@test.dev` }) } finally { c.release() }
    await db.query(`UPDATE leases SET status='terminated', end_date='2026-08-31' WHERE id=$1`, [a.leaseId])
    const b = await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, rent_due_day,
                           supersedes_lease_id, lease_source, signed_by_landlord, signed_by_tenant)
       VALUES ($1,$2,900,'month_to_month','active','2026-09-01',1,$3,'imported',TRUE,TRUE) RETURNING id`,
      [a.unitId, a.landlordId, a.leaseId])
    await db.query(
      `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1,$2,'primary','active',NOW(),'original','joint_several')`, [b.rows[0].id, bTenantId!])
    await db.query(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing, money_kind)
       VALUES ($1,'security_deposit',500,TRUE,'move_in','deposit')`, [b.rows[0].id])
    await db.query(
      `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by)
       VALUES ($1,$2,$3,500,500,'funded','landlord')`, [a.unitId, b.rows[0].id, bTenantId!])

    const calc = await calculateDepositReturn(b.rows[0].id)
    expect(calc!.total_deposit).toBe(500)
    expect(calc!.unpaid_balance_lines).toEqual([])
  })
})

describe('the park-wide sender: a new lease for every household at once', () => {
  it('previews each household with its new rent and form, says why one cannot go, then drafts the rest into the landlord\'s signing queue', async () => {
    const park = await seedPark()
    const a = await addHousehold(park, { rent: 1000 })
    const b = await addHousehold(park, { rent: 800 })
    const c = await addHousehold(park, { rent: 600 })
    await recordMoveOutNotice({ leaseId: b.leaseId, on: plusDays(15), byUserId: park.landlordUserId })
    const start = plusDays(45)
    const body = { propertyId: park.propertyId, startDate: start, rentMode: 'percent', rentValue: 5 }

    const preview = await api().post('/api/esign/documents/renewal-batch/preview')
      .set('Authorization', `Bearer ${park.landlordToken}`).send(body)
    expect(preview.status).toBe(200)
    const rows = Object.fromEntries(preview.body.data.rows.map((r: any) => [r.leaseId, r]))
    expect(rows[a.leaseId]).toMatchObject({ ok: true, currentRent: 1000, newRent: 1050, templateName: 'Space Lease' })
    expect(rows[c.leaseId]).toMatchObject({ ok: true, newRent: 630 })
    expect(rows[b.leaseId].ok).toBe(false)
    expect(rows[b.leaseId].reason).toMatch(/leaving/)
    // Nothing was written by the preview.
    expect((await db.query(`SELECT 1 FROM lease_documents`)).rows).toHaveLength(0)

    const made = await api().post('/api/esign/documents/renewal-batch')
      .set('Authorization', `Bearer ${park.landlordToken}`).send(body)
    expect(made.status).toBe(201)
    expect(made.body.data.created).toHaveLength(2)
    expect(made.body.data.skipped.map((s: any) => s.leaseId)).toEqual([b.leaseId])
    for (const cr of made.body.data.created) {
      const doc = (await db.query<any>(`SELECT status, title, renews_lease_id FROM lease_documents WHERE id=$1`, [cr.documentId])).rows[0]
      expect(doc.status).toBe('sent')
      expect(doc.title).toMatch(/^New Lease/)
      const vals = Object.fromEntries((await db.query<any>(
        `SELECT lease_column, value FROM lease_document_fields WHERE document_id=$1`, [cr.documentId])).rows
        .map((r: any) => [r.lease_column, r.value]))
      expect(vals.start_date).toBe(isoToDocumentDate(start))
      expect(vals.end_date).toBe('-')
      expect(vals.rent_amount).toBe(doc.renews_lease_id === a.leaseId ? '1050.00' : '630.00')
    }
    // No email: the landlord is at the screen, signing them in one pass.
    expect(mocks.signingRequest).not.toHaveBeenCalled()
    // And ONE notification for the batch, not one per household.
    const notes = await db.query<{ title: string; body: string }>(
      `SELECT title, body FROM notifications WHERE user_id=$1 AND type='esign_request'`, [park.landlordUserId])
    expect(notes.rows).toHaveLength(1)
    expect(notes.rows[0].title).toBe('2 new leases are ready to sign')
    expect(notes.rows[0].body).toContain(`2 new leases starting ${DateTime.fromISO(start).toFormat('LLLL d, yyyy')} are waiting for your signature`)
  })

  it('a household on a signed fixed term that runs past the start date is left out, with the day its new lease can start', async () => {
    const park = await seedPark()
    const longTerm = await addHousehold(park, { end: plusDays(400) })
    const endsFirst = await addHousehold(park, { start: plusDays(-345), end: plusDays(20) })
    const mtm = await addHousehold(park)
    const start = plusDays(45)
    const body = { propertyId: park.propertyId, startDate: start, rentMode: 'percent', rentValue: 5 }
    const preview = await api().post('/api/esign/documents/renewal-batch/preview')
      .set('Authorization', `Bearer ${park.landlordToken}`).send(body)
    const rows = Object.fromEntries(preview.body.data.rows.map((r: any) => [r.leaseId, r]))
    const longWords = DateTime.fromISO(plusDays(400)).toFormat('LLLL d, yyyy')
    const nextWords = DateTime.fromISO(plusDays(401)).toFormat('LLLL d, yyyy')
    expect(rows[longTerm.leaseId].ok).toBe(false)
    expect(rows[longTerm.leaseId].reason).toBe(
      `On a signed lease through ${longWords}. Its new lease can start ${nextWords} — send that one from its own row (Change → New lease from a date…).`)
    expect(rows[endsFirst.leaseId].ok).toBe(true)
    expect(rows[mtm.leaseId].ok).toBe(true)
    // The term that ends first holds over at today's rent until the day before
    // the new start (decisions 10/2 #7) — and its row says so.
    expect(rows[endsFirst.leaseId].note).toBe(
      `Signed through ${DateTime.fromISO(plusDays(20)).toFormat('LLLL d, yyyy')}; stays on today's rent until ` +
      `${DateTime.fromISO(plusDays(44)).toFormat('LLLL d, yyyy')}.`)
    expect(rows[mtm.leaseId].note).toBeNull()

    const made = await api().post('/api/esign/documents/renewal-batch')
      .set('Authorization', `Bearer ${park.landlordToken}`).send(body)
    expect(made.body.data.created.map((x: any) => x.leaseId).sort()).toEqual([endsFirst.leaseId, mtm.leaseId].sort())
    // The term that ends first keeps its length from the new start.
    const doc = made.body.data.created.find((x: any) => x.leaseId === endsFirst.leaseId).documentId
    const end = (await db.query<any>(
      `SELECT value FROM lease_document_fields WHERE document_id=$1 AND lease_column='end_date'`, [doc])).rows[0].value
    expect(end).toBe(isoToDocumentDate(DateTime.fromISO(start).plus({ days: 365 }).toISODate()!))
    // Nothing was drafted or changed for the long term.
    expect(await leaseRow(longTerm.leaseId)).toMatchObject({ status: 'active', end_date: plusDays(400) })
  })

  it('a stay booked at the front desk is not a resident\'s lease: never listed, never re-leased', async () => {
    const park = await seedPark()
    const stay = await addHousehold(park)
    await db.query(`UPDATE leases SET lease_source='booking_draft' WHERE id=$1`, [stay.leaseId])
    const resident = await addHousehold(park)
    const preview = await api().post('/api/esign/documents/renewal-batch/preview')
      .set('Authorization', `Bearer ${park.landlordToken}`)
      .send({ propertyId: park.propertyId, startDate: plusDays(45), rentMode: 'same' })
    expect(preview.body.data.rows.map((r: any) => r.leaseId)).toEqual([resident.leaseId])
    const one = await api().post('/api/esign/documents/renewal')
      .set('Authorization', `Bearer ${park.landlordToken}`).send({ leaseId: stay.leaseId, templateId: park.templateId })
    expect(one.status).toBe(409)
    expect(one.body.error).toMatch(/stay booked at the front desk/)
  })

  it('a property manager scoped to another park can neither list nor draft this park\'s new leases', async () => {
    const park = await seedPark()
    const h = await addHousehold(park)
    const c = await db.connect()
    let pmToken: string
    try {
      await c.query('BEGIN')
      const other = await seedProperty(c, { landlordId: park.landlordId, ownerUserId: park.landlordUserId, managedByUserId: park.landlordUserId })
      const pm = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1,'x','property_manager','Pat','Manager',TRUE) RETURNING id`, [`pm-${randomUUID()}@test.dev`])
      await c.query(
        `INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions)
         VALUES ($1,$2,$3,FALSE,'{"leases.create":true}'::jsonb)`, [pm.rows[0].id, park.landlordId, [other]])
      await c.query('COMMIT')
      pmToken = sign({ userId: pm.rows[0].id, role: 'property_manager', email: 'pm@test.dev', profileId: pm.rows[0].id,
        landlordId: park.landlordId, permissions: { 'leases.create': true } })
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const body = { propertyId: park.propertyId, startDate: plusDays(45), rentMode: 'same' }
    const preview = await api().post('/api/esign/documents/renewal-batch/preview').set('Authorization', `Bearer ${pmToken!}`).send(body)
    expect(preview.status).toBe(403)
    expect(preview.body.error).toBe('That property is not one you work at.')
    expect(preview.body.data).toBeUndefined()
    const made = await api().post('/api/esign/documents/renewal-batch').set('Authorization', `Bearer ${pmToken!}`).send(body)
    expect(made.status).toBe(403)
    const one = await api().post('/api/esign/documents/renewal').set('Authorization', `Bearer ${pmToken!}`)
      .send({ leaseId: h.leaseId, templateId: park.templateId })
    expect(one.status).toBe(403)
    const ctx = await api().get(`/api/esign/documents/renewal-context/${h.leaseId}`).set('Authorization', `Bearer ${pmToken!}`)
    expect(ctx.status).toBe(403)
    expect((await db.query(`SELECT 1 FROM lease_documents`)).rows).toHaveLength(0)
  })

  it('a start date of today or earlier is refused before anything is drafted', async () => {
    const park = await seedPark()
    await addHousehold(park)
    const res = await api().post('/api/esign/documents/renewal-batch/preview')
      .set('Authorization', `Bearer ${park.landlordToken}`)
      .send({ propertyId: park.propertyId, startDate: today(), rentMode: 'same' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Pick a start date after today.')
  })

  it('only the households the landlord kept in are drafted', async () => {
    const park = await seedPark()
    const a = await addHousehold(park)
    await addHousehold(park)
    const made = await api().post('/api/esign/documents/renewal-batch')
      .set('Authorization', `Bearer ${park.landlordToken}`)
      .send({ propertyId: park.propertyId, startDate: plusDays(45), rentMode: 'amount', rentValue: 925, leaseIds: [a.leaseId] })
    expect(made.status).toBe(201)
    expect(made.body.data.created.map((x: any) => x.leaseId)).toEqual([a.leaseId])
    const v = await db.query<any>(
      `SELECT value FROM lease_document_fields WHERE document_id=$1 AND lease_column='rent_amount'`, [made.body.data.created[0].documentId])
    expect(v.rows[0].value).toBe('925.00')
  })
})
