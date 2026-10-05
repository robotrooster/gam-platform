/**
 * S655 final sweep (10/3) — a new lease whose lease ENDED EARLY while nobody in
 * the household had signed it.
 *
 *   - Money paid on it holds the cancel (scheduler.processNewLeaseSignings). What
 *     it billed that was never owed comes off at once, so the household that left
 *     is not shown a deposit due on a lease that will never start
 *     (renewalSuccessor.clearNeverOwedOnHeldNewLease). The money that moved is
 *     never touched.
 *   - The held document is stamped LAST, only once GAM and every landlord-side
 *     person have been told. A notice that did not land is sent again next run —
 *     to only who is missing it.
 *   - An old emailed link opens it read-only with the reason, in the submit's
 *     own words (GET /esign/sign).
 *   - PATCH /leases/:id 'terminated' / 'expired' is refused while the new lease
 *     waits, like every other early-end door (newLeaseBlocksEarlyEnd).
 *
 * The jobs read the database's own CURRENT_DATE, so dates are counted from today
 * in Phoenix.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  /** userIds whose landlord-side notice "fails" (the real helper swallows a failure the same way). */
  dropNoticeFor: new Set<string>(),
  /** The GAM admin notice "fails". */
  dropAdmin: { on: false },
  /** Taking the never-owed charges off throws once. */
  failClear: { on: false },
  /** Taking the never-owed charges off throws this many more times. */
  failClearRuns: { n: 0 },
}))
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailSigningRequest: vi.fn(async () => undefined),
  emailSigningReminder: vi.fn(async () => undefined),
  emailSigningCompleted: vi.fn(async () => undefined),
  emailNewLeaseSigningRequest: vi.fn(async () => undefined),
  emailNewLeaseSigningReminder: vi.fn(async () => undefined),
  emailNewLeaseDraftLapsed: vi.fn(async () => undefined),
  emailNewLeaseTenantUnsigned: vi.fn(async () => undefined),
  emailNewLeasesAwaitingLandlord: vi.fn(async () => undefined),
}))
vi.mock('../services/notifications', async (orig) => {
  const real = await orig() as any
  return {
    ...real,
    createNotification: vi.fn(async (p: any) =>
      mocks.dropNoticeFor.has(p.userId) ? undefined : real.createNotification(p)),
  }
})
vi.mock('../services/adminNotifications', async (orig) => {
  const real = await orig() as any
  return {
    ...real,
    createAdminNotification: vi.fn(async (o: any) => mocks.dropAdmin.on ? undefined : real.createAdminNotification(o)),
  }
})
vi.mock('../services/renewalSuccessor', async (orig) => {
  const real = await orig() as any
  return {
    ...real,
    clearNeverOwedOnHeldNewLease: vi.fn(async (...a: any[]) => {
      if (mocks.failClear.on) { mocks.failClear.on = false; throw new Error('simulated failure taking the charges off') }
      if (mocks.failClearRuns.n > 0) { mocks.failClearRuns.n--; throw new Error('simulated failure taking the charges off') }
      return real.clearNeverOwedOnHeldNewLease(...a)
    }),
  }
})

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { DateTime } from 'luxon'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedUtilityMeter } from '../test/dbHelpers'
import { esignRouter } from './esign'
import { tenantsRouter } from './tenants'
import { leasesRouter } from './leases'
import { errorHandler } from '../middleware/errorHandler'
import { processNewLeaseSignings } from '../jobs/scheduler'
import { NEW_LEASE_AFTER_EARLY_END_CANNOT_SIGN, clearNeverOwedOnHeldNewLease } from '../services/renewalSuccessor'
import { isoToDocumentDate } from '@gam/shared'

const TZ = 'America/Phoenix'
const plusDays = (n: number) => DateTime.now().setZone(TZ).plus({ days: n }).toISODate()!

beforeEach(async () => {
  await cleanupAllSchema()
  mocks.dropNoticeFor.clear()
  mocks.dropAdmin.on = false
  mocks.failClear.on = false
  mocks.failClearRuns.n = 0
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_new_lease_held'
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
const api = () => request(buildApp())
const sign = (p: any) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

interface Household {
  landlordId: string; landlordUserId: string; landlordToken: string
  propertyId: string; unitId: string
  tenantId: string; tenantUserId: string; tenantEmail: string; tenantToken: string
  leaseId: string; templateId: string
}

/** A landlord, a property, and one household on a month-to-month with a $500 deposit held. */
async function seedHousehold(): Promise<Household> {
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
    const tenantEmail = `t-${randomUUID()}@test.dev`
    const tenantId = await seedTenant(c, { email: tenantEmail })
    const tenantUserId = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])).rows[0].user_id
    const unitId = await seedUnit(c, { propertyId, landlordId })
    await c.query(`UPDATE units SET status='active' WHERE id=$1`, [unitId])
    const leaseId = (await c.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date,
                           rent_due_day, signed_by_landlord, signed_by_tenant)
       VALUES ($1,$2,1000,'month_to_month','active','2025-06-15',NULL,1,TRUE,TRUE) RETURNING id`,
      [unitId, landlordId])).rows[0].id
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
      landlordId, landlordUserId, propertyId, unitId, tenantId, tenantUserId, tenantEmail, leaseId,
      templateId: tpl.rows[0].id,
      landlordToken: sign({ userId: landlordUserId, role: 'landlord', email: 'll@test.dev',
        profileId: landlordId, landlordIds: [landlordId], permissions: {} }),
      tenantToken: sign({ userId: tenantUserId, role: 'tenant', email: tenantEmail, profileId: tenantId, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** Draft, send and landlord-sign a new lease starting `startIso`; `deposit` raises the deposit box. */
async function newLeaseSignedByLandlord(h: Household, startIso: string, deposit?: string) {
  const drafted = await api().post('/api/esign/documents/renewal')
    .set('Authorization', `Bearer ${h.landlordToken}`).send({ leaseId: h.leaseId, templateId: h.templateId })
  expect(drafted.status).toBe(201)
  const docId = drafted.body.data.id as string
  const sent = await api().post(`/api/esign/documents/${docId}/send`).set('Authorization', `Bearer ${h.landlordToken}`).send({})
  expect(sent.status).toBe(200)
  const fields = (await db.query<{ id: string; lease_column: string }>(
    `SELECT id, lease_column FROM lease_document_fields WHERE document_id=$1 AND signer_role='landlord'`, [docId])).rows
  const fid = (col: string) => fields.find(f => f.lease_column === col)!.id
  const fieldValues = [
    { fieldId: fid('start_date'), value: isoToDocumentDate(startIso) },
    { fieldId: fid('rent_amount'), value: '1050.00' },
    ...(deposit ? [{ fieldId: fid('security_deposit'), value: deposit }] : []),
  ]
  const signed = await api().post(`/api/esign/sign/${docId}`).set('Authorization', `Bearer ${h.landlordToken}`).send({ fieldValues })
  expect(signed.status).toBe(200)
  const newLeaseId = (await db.query<{ id: string }>(`SELECT id FROM leases WHERE supersedes_lease_id=$1`, [h.leaseId])).rows[0].id
  return { docId, newLeaseId }
}

/** The way a lease still ends early under a waiting new lease: a paper lease imported over it. */
async function replacedByAnotherLease(h: Household) {
  await db.query(
    `UPDATE leases SET status='terminated', end_date=COALESCE(end_date, CURRENT_DATE),
                       terminated_at=COALESCE(terminated_at, NOW()), updated_at=NOW() WHERE id=$1`, [h.leaseId])
  await db.query(
    `UPDATE lease_tenants SET status='removed', removed_at=NOW(), removed_reason='replaced' WHERE lease_id=$1 AND status='active'`,
    [h.leaseId])
}

/** A payment that really moved on the new lease (part of the deposit increase, paid early). */
const paidOnNewLease = async (h: Household, leaseId: string, amount = 50) =>
  (await db.query<{ id: string }>(
    `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description, due_date)
     VALUES ($1,$2,$3,$4,'deposit',$5,'settled','DEPOSIT',CURRENT_DATE) RETURNING id`,
    [h.landlordId, h.tenantId, leaseId, h.unitId, amount])).rows[0].id

const heldNotices = async (userId: string) =>
  (await db.query<{ title: string; body: string; data: any }>(
    `SELECT title, body, data FROM notifications
      WHERE user_id=$1 AND type='lease_renewal_status' AND title LIKE '%can''t be canceled yet%' ORDER BY created_at`,
    [userId])).rows
/** The held emails that went to `userId` — the only copy for someone whose in-app notices of this kind are off. */
const heldEmails = async (userId: string) =>
  (await db.query<{ subject: string; status: string }>(
    `SELECT subject, status FROM email_send_log
      WHERE category='notif_lease_renewal_status' AND metadata->>'user_id'=$1
        AND subject LIKE '%can''t be canceled yet%' ORDER BY created_at`, [userId])).rows
const adminNotices = async () =>
  (await db.query(`SELECT 1 FROM admin_notifications WHERE category='new_lease_cancel_held'`)).rows.length
const heldAt = async (docId: string) =>
  (await db.query<{ at: Date | null }>(`SELECT new_lease_cancel_held_at AS at FROM lease_documents WHERE id=$1`, [docId])).rows[0].at
const unpaidOn = async (leaseId: string) =>
  (await db.query<{ type: string; amount: string; status: string }>(
    `SELECT type, amount::text, status FROM payments WHERE lease_id=$1 AND status IN ('pending','failed')`, [leaseId])).rows
const openBillsOn = async (leaseId: string) =>
  (await db.query(`SELECT 1 FROM invoices WHERE lease_id=$1 AND status IN ('pending','partial')`, [leaseId])).rows.length

describe('a held new lease (money paid on it) takes off what was never owed', () => {
  it('the deposit increase still due is taken off — the household that left is not asked for it — and the money paid is untouched', async () => {
    const h = await seedHousehold()
    const { docId, newLeaseId } = await newLeaseSignedByLandlord(h, plusDays(40), '600.00')
    // The landlord's signature billed the $100 increase on the new lease.
    const due = await unpaidOn(newLeaseId)
    expect(due.reduce((s, r) => s + Number(r.amount), 0)).toBe(100)
    expect(await openBillsOn(newLeaseId)).toBeGreaterThan(0)
    const payId = await paidOnNewLease(h, newLeaseId, 50)
    await replacedByAnotherLease(h)

    await processNewLeaseSignings({ hour: 12 })

    // Held, not canceled — and nothing unpaid is left on it.
    expect((await db.query<any>(`SELECT status FROM lease_documents WHERE id=$1`, [docId])).rows[0].status).toBe('in_progress')
    expect(await unpaidOn(newLeaseId)).toEqual([])
    expect(await openBillsOn(newLeaseId)).toBe(0)
    // The money that moved is exactly as it was.
    expect((await db.query<any>(`SELECT status, amount::float AS amount FROM payments WHERE id=$1`, [payId])).rows[0])
      .toEqual({ status: 'settled', amount: 50 })
    // The household's payments list shows nothing due on the lease that will never start.
    const mine = await api().get('/api/tenants/payments').set('Authorization', `Bearer ${h.tenantToken}`)
    expect(mine.status).toBe(200)
    const onNew = mine.body.data.filter((p: any) => p.lease_id === newLeaseId)
    expect(onNew.map((p: any) => p.status)).toEqual(['settled'])
    // The landlord is told, in plain words, that nothing unpaid is billed.
    const notes = await heldNotices(h.landlordUserId)
    expect(notes).toHaveLength(1)
    expect(notes[0].body).toContain('The deposit record is back on the lease that ended, and nothing unpaid on the new lease is billed to the household.')
    expect(await heldAt(docId)).not.toBeNull()

    // A second run finds nothing more to do.
    await processNewLeaseSignings({ hour: 12 })
    expect(await heldNotices(h.landlordUserId)).toHaveLength(1)
    expect(await adminNotices()).toBe(1)
  })

  it('a utility bill on it nobody paid goes back, unbilled, to the lease that ended; a paid one stays', async () => {
    const h = await seedHousehold()
    const { newLeaseId } = await newLeaseSignedByLandlord(h, plusDays(40))
    const c = await db.connect()
    let unpaidBill: string, paidBill: string, unpaidCharge: string, paidCharge: string
    try {
      const meterId = await seedUtilityMeter(c, { propertyId: h.propertyId })
      const charge = async (status: string) => (await c.query<{ id: string }>(
        `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description, due_date)
         VALUES ($1,$2,$3,$4,'utility',25,$5,'UTILITY',CURRENT_DATE) RETURNING id`,
        [h.landlordId, h.tenantId, newLeaseId, h.unitId, status])).rows[0].id
      unpaidCharge = await charge('pending')
      paidCharge = await charge('settled')
      const bill = async (paymentId: string, month: string) => (await c.query<{ id: string }>(
        `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month,
                                    charge_amount, payment_id, status, utility_type)
         VALUES ($1,$2,$3,$4,$5,$6,25,$7,'billed','water') RETURNING id`,
        [meterId, h.unitId, h.tenantId, newLeaseId, h.landlordId, month, paymentId])).rows[0].id
      unpaidBill = await bill(unpaidCharge, '2026-08-01')
      paidBill = await bill(paidCharge, '2026-09-01')
    } finally { c.release() }

    // It runs inside the job's transaction (each removal on its own savepoint).
    const inTxn = async () => {
      const t = await db.connect()
      try {
        await t.query('BEGIN')
        const out = await clearNeverOwedOnHeldNewLease(t.query.bind(t) as any, newLeaseId, h.leaseId)
        await t.query('COMMIT')
        return out
      } catch (e) { await t.query('ROLLBACK'); throw e } finally { t.release() }
    }
    const off = await inTxn()
    expect(off.utilityBills).toBe(1)
    expect(off.kept).toBe(0)
    const billRow = async (id: string) => (await db.query<any>(
      `SELECT lease_id, status, payment_id FROM utility_bills WHERE id=$1`, [id])).rows[0]
    expect(await billRow(unpaidBill)).toEqual({ lease_id: h.leaseId, status: 'unbilled', payment_id: null })
    expect((await db.query(`SELECT 1 FROM payments WHERE id=$1`, [unpaidCharge])).rows).toHaveLength(0)
    expect(await billRow(paidBill)).toEqual({ lease_id: newLeaseId, status: 'billed', payment_id: paidCharge })
    // Idempotent.
    expect(await inTxn()).toEqual({ charges: 0, bills: 0, retotaled: 0, utilityBills: 0, kept: 0, keptCharges: [] })
  })

  // Final sweep (10/3): the open bills are read BEFORE any line comes off. Each
  // removal re-rolls a bill's status, so a bill whose only unpaid line went
  // already read 'settled' — still totaling the line that was gone — and was
  // skipped; and a bill with a payment on its way was voided at $0, where that
  // payment then settled onto a dead bill.
  const billRow = async (id: string) => (await db.query<any>(
    `SELECT status, total_amount::float AS total, subtotal_deposits::float AS deposits, subtotal_fees::float AS fees
       FROM invoices WHERE id=$1`, [id])).rows[0]
  const moveInBill = async (leaseId: string) => (await db.query<{ id: string }>(
    `SELECT id FROM invoices WHERE lease_id=$1 AND status IN ('pending','partial')`, [leaseId])).rows[0].id

  it('a paid line on the same bill as the deposit increase: the bill is not voided — it is rebuilt to the paid line and reads paid', async () => {
    const h = await seedHousehold()
    const { docId, newLeaseId } = await newLeaseSignedByLandlord(h, plusDays(40), '600.00')
    const bill = await moveInBill(newLeaseId)
    // A $50 fee billed on the same move-in bill (in its total, as the bundle bills
    // it), and paid. The bill is part-paid.
    await db.query(`UPDATE invoices SET subtotal_fees = subtotal_fees + 50, total_amount = total_amount + 50 WHERE id=$1`, [bill])
    const feeId = (await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,$5,'fee',50,'settled','SUBSCRIP',CURRENT_DATE) RETURNING id`,
      [bill, h.landlordId, h.tenantId, newLeaseId, h.unitId])).rows[0].id
    expect(await billRow(bill)).toEqual({ status: 'partial', total: 150, deposits: 100, fees: 50 })
    await replacedByAnotherLease(h)

    await processNewLeaseSignings({ hour: 12 })

    // The $100 increase is off; the bill reads what is on it — the $50 paid — and paid.
    expect(await unpaidOn(newLeaseId)).toEqual([])
    expect(await billRow(bill)).toEqual({ status: 'settled', total: 50, deposits: 0, fees: 50 })
    expect((await db.query<any>(`SELECT status, amount::float AS amount FROM payments WHERE id=$1`, [feeId])).rows[0])
      .toEqual({ status: 'settled', amount: 50 })
    expect(await heldAt(docId)).not.toBeNull()
  })

  it('a payment on its way keeps its bill: rebuilt around it, not voided — and the bill reads paid once it settles', async () => {
    const h = await seedHousehold()
    const { docId, newLeaseId } = await newLeaseSignedByLandlord(h, plusDays(40), '600.00')
    const bill = await moveInBill(newLeaseId)
    // $50 toward the deposit, paid by bank and still on its way.
    const onItsWay = (await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,$5,'deposit',50,'processing','DEPOSIT',CURRENT_DATE) RETURNING id`,
      [bill, h.landlordId, h.tenantId, newLeaseId, h.unitId])).rows[0].id
    await replacedByAnotherLease(h)

    await processNewLeaseSignings({ hour: 12 })

    expect(await unpaidOn(newLeaseId)).toEqual([])
    // Rebuilt to the line still on it: $50, still open while the payment is on its way.
    expect(await billRow(bill)).toEqual({ status: 'pending', total: 50, deposits: 50, fees: 0 })
    expect(await heldAt(docId)).not.toBeNull()

    // It settles: the bill reads $50, paid — never a void $0 bill with money on it.
    await db.query(`UPDATE payments SET status='settled' WHERE id=$1`, [onItsWay])
    expect(await billRow(bill)).toEqual({ status: 'settled', total: 50, deposits: 50, fees: 0 })
  })

  it('a bill with nothing paid on it is still voided at $0', async () => {
    const h = await seedHousehold()
    const { newLeaseId } = await newLeaseSignedByLandlord(h, plusDays(40), '600.00')
    const bill = await moveInBill(newLeaseId)
    // The money that moved is not on this bill.
    await paidOnNewLease(h, newLeaseId, 50)
    await replacedByAnotherLease(h)
    await processNewLeaseSignings({ hour: 12 })
    expect(await billRow(bill)).toEqual({ status: 'void', total: 0, deposits: 100, fees: 0 })
  })

  /** A line on `bill`, in its total (as the move-in bundle bills it). */
  const lineOn = async (h: Household, bill: string, leaseId: string, type: 'fee' | 'deposit', amount: number, status: string) => {
    await db.query(
      `UPDATE invoices SET ${type === 'fee' ? 'subtotal_fees' : 'subtotal_deposits'} =
                           COALESCE(${type === 'fee' ? 'subtotal_fees' : 'subtotal_deposits'}, 0) + $2,
                           total_amount = total_amount + $2 WHERE id=$1`, [bill, amount])
    return (await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_DATE) RETURNING id`,
      [bill, h.landlordId, h.tenantId, leaseId, h.unitId, type, amount, status, type === 'fee' ? 'OTHERFEE' : 'DEPOSIT'])).rows[0].id
  }

  it('a line paid from the deposit is paid: a bill left with only that line reads paid, not open', async () => {
    const h = await seedHousehold()
    const { docId, newLeaseId } = await newLeaseSignedByLandlord(h, plusDays(40), '600.00')
    const bill = await moveInBill(newLeaseId)
    // A $40 fee on the move-in bill, already paid from the deposit, beside the $100 increase still due.
    const fromDeposit = await lineOn(h, bill, newLeaseId, 'fee', 40, 'paid_via_deposit')
    expect(await billRow(bill)).toEqual({ status: 'pending', total: 140, deposits: 100, fees: 40 })
    await paidOnNewLease(h, newLeaseId, 50)
    await replacedByAnotherLease(h)

    await processNewLeaseSignings({ hour: 12 })

    // The increase is off; the bill reads the $40 left on it — paid, not an open $40 bill with nothing owed.
    expect(await unpaidOn(newLeaseId)).toEqual([])
    expect(await billRow(bill)).toEqual({ status: 'settled', total: 40, deposits: 0, fees: 40 })
    expect(await openBillsOn(newLeaseId)).toBe(0)
    expect((await db.query<any>(`SELECT status, amount::float AS amount FROM payments WHERE id=$1`, [fromDeposit])).rows[0])
      .toEqual({ status: 'paid_via_deposit', amount: 40 })
    expect(await heldAt(docId)).not.toBeNull()
  })

  it('paid from the deposit and paid by the household on one bill: it reads paid once the increase is off', async () => {
    const h = await seedHousehold()
    const { newLeaseId } = await newLeaseSignedByLandlord(h, plusDays(40), '600.00')
    const bill = await moveInBill(newLeaseId)
    await lineOn(h, bill, newLeaseId, 'fee', 40, 'paid_via_deposit')
    await lineOn(h, bill, newLeaseId, 'fee', 25, 'settled')
    await replacedByAnotherLease(h)

    await processNewLeaseSignings({ hour: 12 })

    expect(await billRow(bill)).toEqual({ status: 'settled', total: 65, deposits: 0, fees: 65 })
  })

  it('a payment still on its way keeps the bill open, a line paid from the deposit beside it or not', async () => {
    const h = await seedHousehold()
    const { newLeaseId } = await newLeaseSignedByLandlord(h, plusDays(40), '600.00')
    const bill = await moveInBill(newLeaseId)
    await lineOn(h, bill, newLeaseId, 'fee', 40, 'paid_via_deposit')
    await lineOn(h, bill, newLeaseId, 'fee', 25, 'processing')
    await replacedByAnotherLease(h)

    await processNewLeaseSignings({ hour: 12 })

    expect(await billRow(bill)).toEqual({ status: 'pending', total: 65, deposits: 0, fees: 65 })
  })
})

describe('the held document is stamped only once everyone has been told', () => {
  /** A second landlord-side person: a manager who signed the new lease for the landlord. */
  async function addLandlordSideSigner(docId: string) {
    const c = await db.connect()
    try {
      const email = `mgr-${randomUUID()}@test.dev`
      const userId = (await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1,'x','property_manager','Mia','Manager',TRUE) RETURNING id`, [email])).rows[0].id
      await c.query(
        `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status, signed_at)
         VALUES ($1,$2,'landlord','Mia Manager',$3,0,$4,'signed',NOW())`,
        [docId, userId, email, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')])
      return userId
    } finally { c.release() }
  }

  /** Held with money paid, the lease replaced; a manager signed for the landlord too. */
  async function heldWithTwoOnTheLandlordSide() {
    const h = await seedHousehold()
    const { docId, newLeaseId } = await newLeaseSignedByLandlord(h, plusDays(40), '600.00')
    const managerId = await addLandlordSideSigner(docId)
    await paidOnNewLease(h, newLeaseId, 50)
    await replacedByAnotherLease(h)
    return { h, docId, newLeaseId, managerId }
  }
  const esignErrors = (spy: any) => spy.mock.calls.filter((c: any[]) => /\[ESIGN-TIMEOUTS\]/.test(String(c[1] ?? '')))

  it('a landlord-side notice that did not land leaves it unstamped; the next run tells only who was missed — GAM is not told twice', async () => {
    const { logger } = await import('../lib/logger')
    const errors = vi.spyOn(logger, 'error')
    try {
      const { h, docId, newLeaseId, managerId } = await heldWithTwoOnTheLandlordSide()

      // The owner's notice fails this run.
      mocks.dropNoticeFor.add(h.landlordUserId)
      await processNewLeaseSignings({ hour: 12 })
      expect(await heldAt(docId)).toBeNull()                       // not everyone told: no stamp
      expect(await heldNotices(managerId)).toHaveLength(1)
      expect(await heldNotices(h.landlordUserId)).toHaveLength(0)
      expect(await adminNotices()).toBe(1)
      // The money side is done already: deposit back on the ended lease, nothing unpaid left.
      expect((await db.query<any>(`SELECT lease_id FROM security_deposits WHERE unit_id=$1`, [h.unitId])).rows[0].lease_id).toBe(h.leaseId)
      expect(await unpaidOn(newLeaseId)).toEqual([])

      // Next run it lands: only the owner hears — not the manager again, not GAM again.
      mocks.dropNoticeFor.clear()
      await processNewLeaseSignings({ hour: 12 })
      expect(await heldNotices(h.landlordUserId)).toHaveLength(1)
      expect(await heldNotices(managerId)).toHaveLength(1)
      expect(await adminNotices()).toBe(1)
      expect(await heldAt(docId)).not.toBeNull()

      // Stamped: later runs leave it be.
      await processNewLeaseSignings({ hour: 12 })
      expect(await heldNotices(h.landlordUserId)).toHaveLength(1)
      expect(await heldNotices(managerId)).toHaveLength(1)
      expect(await adminNotices()).toBe(1)
      expect(esignErrors(errors)).toEqual([])
    } finally {
      errors.mockRestore()
    }
  })

  it('GAM\'s notice that did not land leaves it unstamped too; the next run tells GAM — the landlord side is not told twice', async () => {
    const { h, docId, managerId } = await heldWithTwoOnTheLandlordSide()
    mocks.dropAdmin.on = true
    await processNewLeaseSignings({ hour: 12 })
    expect(await heldNotices(h.landlordUserId)).toHaveLength(1)
    expect(await heldNotices(managerId)).toHaveLength(1)
    expect(await adminNotices()).toBe(0)
    expect(await heldAt(docId)).toBeNull()

    mocks.dropAdmin.on = false
    await processNewLeaseSignings({ hour: 12 })
    expect(await adminNotices()).toBe(1)
    expect(await heldNotices(h.landlordUserId)).toHaveLength(1)
    expect(await heldNotices(managerId)).toHaveLength(1)
    expect(await heldAt(docId)).not.toBeNull()
  })

  it('taking the charges off failed: everyone is still told, it stays unstamped, and the next run takes them off and stamps it', async () => {
    const { logger } = await import('../lib/logger')
    const errors = vi.spyOn(logger, 'error')
    try {
      const { h, docId, newLeaseId } = await heldWithTwoOnTheLandlordSide()
      mocks.failClear.on = true
      await processNewLeaseSignings({ hour: 12 })
      expect(await heldAt(docId)).toBeNull()
      expect(await unpaidOn(newLeaseId)).not.toEqual([])
      // The deposit still went back, and nobody waits in silence.
      expect((await db.query<any>(`SELECT lease_id FROM security_deposits WHERE unit_id=$1`, [h.unitId])).rows[0].lease_id).toBe(h.leaseId)
      const owner = await heldNotices(h.landlordUserId)
      expect(owner).toHaveLength(1)
      expect(owner[0].body).not.toContain('nothing unpaid')         // not said while it is not true
      const gam = (await db.query<{ body: string }>(`SELECT body FROM admin_notifications WHERE category='new_lease_cancel_held'`)).rows
      expect(gam).toHaveLength(1)
      expect(gam[0].body).toContain('Its unpaid charges could not be taken off yet; the next run tries again.')
      expect(esignErrors(errors).map((c: any[]) => c[1])).toEqual(
        ['[ESIGN-TIMEOUTS] could not take the unpaid charges off a held new lease — retried next run'])

      await processNewLeaseSignings({ hour: 12 })
      expect(await unpaidOn(newLeaseId)).toEqual([])
      expect(await openBillsOn(newLeaseId)).toBe(0)
      expect(await heldAt(docId)).not.toBeNull()
      expect(await heldNotices(h.landlordUserId)).toHaveLength(1)
      expect(await adminNotices()).toBe(1)
    } finally {
      errors.mockRestore()
    }
  })

  it('an unpaid charge another record points at stays, and GAM is told to take it off by hand — the rest come off, it is stamped', async () => {
    const { logger } = await import('../lib/logger')
    const errors = vi.spyOn(logger, 'error')
    try {
      const h = await seedHousehold()
      const { docId, newLeaseId } = await newLeaseSignedByLandlord(h, plusDays(40), '600.00')
      const due = (await db.query<{ id: string }>(
        `SELECT id FROM payments WHERE lease_id=$1 AND status='pending' LIMIT 1`, [newLeaseId])).rows[0].id
      // An ACH log entry points at it (no ON DELETE on that link).
      await db.query(`INSERT INTO ach_monitoring_log (payment_id, event_type, tenant_id) VALUES ($1,'first_sender',$2)`, [due, h.tenantId])
      await paidOnNewLease(h, newLeaseId, 50)
      await replacedByAnotherLease(h)

      await processNewLeaseSignings({ hour: 12 })
      expect((await unpaidOn(newLeaseId)).length).toBe(1)
      expect((await db.query(`SELECT 1 FROM payments WHERE id=$1`, [due])).rows).toHaveLength(1)
      expect(await openBillsOn(newLeaseId)).toBe(0)
      const gam = (await db.query<{ body: string }>(`SELECT body FROM admin_notifications WHERE category='new_lease_cancel_held'`)).rows
      expect(gam[0].body).toContain('1 unpaid charge on it could not be taken off because other records point at it ' +
        // A new lease's move-in bill is due the day before it starts.
        `(the $100.00 deposit charge due ${DateTime.fromISO(plusDays(39)).toFormat('LLLL d, yyyy')}) — take it off by hand ` +
        'so the household is not asked to pay.')
      expect((await heldNotices(h.landlordUserId))[0].body).not.toContain('nothing unpaid')
      expect(await heldAt(docId)).not.toBeNull()
      expect(esignErrors(errors)).toEqual([])
    } finally {
      errors.mockRestore()
    }
  })

  it('someone who turned in-app notices of this kind off is told by email alone — it is still stamped', async () => {
    const h = await seedHousehold()
    const { docId, newLeaseId } = await newLeaseSignedByLandlord(h, plusDays(40))
    await db.query(
      `INSERT INTO notification_preferences (user_id, type, email_enabled, in_app_enabled)
       VALUES ($1,'lease_renewal_status',TRUE,FALSE)`, [h.landlordUserId])
    await paidOnNewLease(h, newLeaseId, 50)
    await replacedByAnotherLease(h)
    await processNewLeaseSignings({ hour: 12 })
    expect(await heldNotices(h.landlordUserId)).toHaveLength(0)
    expect(await heldEmails(h.landlordUserId)).toHaveLength(1)
    expect(await adminNotices()).toBe(1)
    expect(await heldAt(docId)).not.toBeNull()
  })

  // Final sweep (10/3): someone whose in-app notices of this kind are off has no
  // notice row to read back, so they counted as never told — every run that
  // found the document still unstamped emailed them the same notice again
  // (every 15 minutes while a fault lasted). The email that went out is read
  // back and recorded on the document instead.
  describe('in-app notices off: the email is their one copy, sent once', () => {
    /** Held with $50 paid, the lease replaced; the owner's in-app notices of this kind are off (and emails, if `email` is false). */
    async function heldEmailOnly(opts: { email?: boolean; manager?: boolean } = {}) {
      const h = await seedHousehold()
      const { docId, newLeaseId } = await newLeaseSignedByLandlord(h, plusDays(40), '600.00')
      const managerId = opts.manager ? await addLandlordSideSigner(docId) : null
      await db.query(
        `INSERT INTO notification_preferences (user_id, type, email_enabled, in_app_enabled)
         VALUES ($1,'lease_renewal_status',$2,FALSE)`, [h.landlordUserId, opts.email ?? true])
      await paidOnNewLease(h, newLeaseId, 50)
      await replacedByAnotherLease(h)
      return { h, docId, newLeaseId, managerId }
    }
    const recorded = async (docId: string) =>
      (await db.query<{ new_value: any }>(
        `SELECT new_value FROM audit_log
          WHERE action='document.new_lease_cancel_held_emailed' AND entity_type='lease_document' AND entity_id=$1`,
        [docId])).rows.map(r => r.new_value.userId)

    it('the clear-up failed once: one email, not one per run — then it is stamped', async () => {
      const { h, docId, newLeaseId } = await heldEmailOnly()
      mocks.failClear.on = true
      await processNewLeaseSignings({ hour: 12 })
      expect(await heldAt(docId)).toBeNull()
      expect(await heldEmails(h.landlordUserId)).toHaveLength(1)
      expect(await recorded(docId)).toEqual([h.landlordUserId])

      // A full run: the charges come off, nobody is emailed again, it is stamped.
      await processNewLeaseSignings({ hour: 12 })
      expect(await unpaidOn(newLeaseId)).toEqual([])
      expect(await heldEmails(h.landlordUserId)).toHaveLength(1)
      expect(await heldNotices(h.landlordUserId)).toHaveLength(0)
      expect(await adminNotices()).toBe(1)
      expect(await heldAt(docId)).not.toBeNull()

      await processNewLeaseSignings({ hour: 12 })
      expect(await heldEmails(h.landlordUserId)).toHaveLength(1)
    })

    it('the clear-up keeps failing: still one email over every run, and no stamp until the charges come off', async () => {
      const { h, docId, newLeaseId } = await heldEmailOnly()
      mocks.failClearRuns.n = 4
      for (let run = 0; run < 4; run++) await processNewLeaseSignings({ hour: 12 })
      expect(await heldEmails(h.landlordUserId)).toHaveLength(1)
      expect(await heldAt(docId)).toBeNull()

      await processNewLeaseSignings({ hour: 12 })
      expect(await unpaidOn(newLeaseId)).toEqual([])
      expect(await heldEmails(h.landlordUserId)).toHaveLength(1)
      expect(await heldAt(docId)).not.toBeNull()
    })

    it("GAM's notice or a manager's did not land: the owner is not emailed again while those are sent", async () => {
      const { h, docId, managerId } = await heldEmailOnly({ manager: true })
      mocks.dropAdmin.on = true
      mocks.dropNoticeFor.add(managerId!)
      await processNewLeaseSignings({ hour: 12 })
      expect(await heldEmails(h.landlordUserId)).toHaveLength(1)
      expect(await heldAt(docId)).toBeNull()

      mocks.dropAdmin.on = false
      mocks.dropNoticeFor.clear()
      await processNewLeaseSignings({ hour: 12 })
      expect(await adminNotices()).toBe(1)
      expect(await heldNotices(managerId!)).toHaveLength(1)
      expect(await heldEmails(h.landlordUserId)).toHaveLength(1)
      expect(await heldAt(docId)).not.toBeNull()
    })

    it('their email did not go out: it stays unstamped, and the next run emails them once and stamps it', async () => {
      const { h, docId } = await heldEmailOnly()
      mocks.dropNoticeFor.add(h.landlordUserId)
      await processNewLeaseSignings({ hour: 12 })
      expect(await heldEmails(h.landlordUserId)).toHaveLength(0)
      expect(await recorded(docId)).toEqual([])
      expect(await adminNotices()).toBe(1)
      expect(await heldAt(docId)).toBeNull()

      mocks.dropNoticeFor.clear()
      await processNewLeaseSignings({ hour: 12 })
      expect(await heldEmails(h.landlordUserId)).toHaveLength(1)
      expect(await adminNotices()).toBe(1)
      expect(await heldAt(docId)).not.toBeNull()

      await processNewLeaseSignings({ hour: 12 })
      expect(await heldEmails(h.landlordUserId)).toHaveLength(1)
    })

    it('in-app notices and emails of this kind both off: nothing is sent, and it is stamped', async () => {
      const { h, docId } = await heldEmailOnly({ email: false })
      await processNewLeaseSignings({ hour: 12 })
      expect(await heldEmails(h.landlordUserId)).toHaveLength(0)
      expect(await heldNotices(h.landlordUserId)).toHaveLength(0)
      expect(await adminNotices()).toBe(1)
      expect(await heldAt(docId)).not.toBeNull()
    })
  })
})

describe('GAM hears about charges left for it to take off by hand, even when an earlier notice could not say so', () => {
  const gamRows = async () => (await db.query<{ title: string; body: string; context: any }>(
    `SELECT title, body, context FROM admin_notifications WHERE category='new_lease_cancel_held' ORDER BY created_at, id`)).rows
  /** The move-in bill's due date in words — the day before the new lease starts. */
  const dueWords = () => DateTime.fromISO(plusDays(39)).toFormat('LLLL d, yyyy')

  /** Held with $50 paid; the first run's clear-up fails, so GAM hears "the next run tries again". */
  async function firstRunClearUpFails() {
    const h = await seedHousehold()
    const { docId, newLeaseId } = await newLeaseSignedByLandlord(h, plusDays(40), '600.00')
    await paidOnNewLease(h, newLeaseId, 50)
    await replacedByAnotherLease(h)
    mocks.failClear.on = true
    await processNewLeaseSignings({ hour: 12 })
    const gam = await gamRows()
    expect(gam).toHaveLength(1)
    expect(gam[0].body).toContain('Its unpaid charges could not be taken off yet; the next run tries again.')
    expect(gam[0].context).toMatchObject({ cleared: false, kept: 0 })
    expect(await heldAt(docId)).toBeNull()
    // Before the next run, an ACH log entry comes to point at the $100 deposit charge.
    const due = (await db.query<{ id: string }>(
      `SELECT id FROM payments WHERE lease_id=$1 AND status='pending' AND type='deposit'`, [newLeaseId])).rows[0].id
    await db.query(`INSERT INTO ach_monitoring_log (payment_id, event_type, tenant_id) VALUES ($1,'first_sender',$2)`, [due, h.tenantId])
    return { h, docId, newLeaseId, due }
  }

  it('the clear-up failed once, then the next run had to keep one charge: GAM gets one follow-up naming it, then it is stamped', async () => {
    const { h, docId, newLeaseId, due } = await firstRunClearUpFails()

    await processNewLeaseSignings({ hour: 12 })
    expect(await unpaidOn(newLeaseId)).toEqual([{ type: 'deposit', amount: '100.00', status: 'pending' }])
    const gam = await gamRows()
    expect(gam).toHaveLength(2)
    expect(gam[1].title).toMatch(/^Unpaid charges to take off by hand — /)
    expect(gam[1].body).toContain('Its unpaid charges have now been taken off, except: 1 unpaid charge on it could not be ' +
      `taken off because other records point at it (the $100.00 deposit charge due ${dueWords()}) — take it off by hand ` +
      'so the household is not asked to pay.')
    expect(gam[1].context).toMatchObject({ cleared: true, kept: 1, kept_payment_ids: [due], follow_up: true })
    expect(await heldAt(docId)).not.toBeNull()
    // The landlord side was told once, in the first run, and not again.
    expect(await heldNotices(h.landlordUserId)).toHaveLength(1)

    // Stamped: later runs leave it be — no second follow-up.
    await processNewLeaseSignings({ hour: 12 })
    expect(await gamRows()).toHaveLength(2)
  })

  it('a follow-up that did not land leaves it unstamped; the next run sends it, once, and stamps it', async () => {
    const { docId } = await firstRunClearUpFails()

    mocks.dropAdmin.on = true
    await processNewLeaseSignings({ hour: 12 })
    expect(await gamRows()).toHaveLength(1)
    expect(await heldAt(docId)).toBeNull()               // GAM's notice does not say what was kept: no stamp

    mocks.dropAdmin.on = false
    await processNewLeaseSignings({ hour: 12 })
    const gam = await gamRows()
    expect(gam).toHaveLength(2)
    expect(gam[1].context).toMatchObject({ cleared: true, kept: 1, follow_up: true })
    expect(await heldAt(docId)).not.toBeNull()

    await processNewLeaseSignings({ hour: 12 })
    expect(await gamRows()).toHaveLength(2)
  })

  it('the clear-up failed once and the next run took everything off: no follow-up is needed — it is stamped', async () => {
    const h = await seedHousehold()
    const { docId, newLeaseId } = await newLeaseSignedByLandlord(h, plusDays(40), '600.00')
    await paidOnNewLease(h, newLeaseId, 50)
    await replacedByAnotherLease(h)
    mocks.failClear.on = true
    await processNewLeaseSignings({ hour: 12 })
    await processNewLeaseSignings({ hour: 12 })
    expect(await unpaidOn(newLeaseId)).toEqual([])
    expect(await gamRows()).toHaveLength(1)
    expect(await heldAt(docId)).not.toBeNull()
  })
})

describe('an old emailed link to a new lease whose lease ended early opens read-only, with the reason', () => {
  it('GET /esign/sign says why — the same words the submit refuses with — and offers nothing to fill in', async () => {
    const h = await seedHousehold()
    const { docId } = await newLeaseSignedByLandlord(h, plusDays(40))
    const token = (await db.query<{ token: string }>(
      `SELECT token FROM lease_document_signers WHERE document_id=$1 AND role <> 'landlord'`, [docId])).rows[0].token

    // While the household is still on its lease, it is theirs to sign.
    const before = await api().get(`/api/esign/sign/${token}`)
    expect(before.status).toBe(200)
    expect(before.body.data).toMatchObject({ readOnly: false, closedReason: null })

    await replacedByAnotherLease(h)
    // The emailed link (no session) and the portal (signed in) both read it.
    for (const res of [
      await api().get(`/api/esign/sign/${token}`),
      await api().get(`/api/esign/sign/${docId}`).set('Authorization', `Bearer ${h.tenantToken}`),
    ]) {
      expect(res.status).toBe(200)
      expect(res.body.data.readOnly).toBe(true)
      expect(res.body.data.closedReason).toBe(NEW_LEASE_AFTER_EARLY_END_CANNOT_SIGN)
      expect(res.body.data.waitingOn).toBeNull()
      expect(res.body.data.fields.every((f: any) => f.mine === false)).toBe(true)
    }
    // The submit refuses in exactly those words.
    const post = await api().post(`/api/esign/sign/${docId}`).set('Authorization', `Bearer ${h.tenantToken}`).send({ fieldValues: [] })
    expect(post.status).toBe(409)
    expect(post.body.error).toBe(NEW_LEASE_AFTER_EARLY_END_CANNOT_SIGN)
  })

  it('a household member who already signed is never told it is closed — their lease stands', async () => {
    const h = await seedHousehold()
    const { docId } = await newLeaseSignedByLandlord(h, plusDays(40))
    await db.query(`UPDATE lease_document_signers SET status='signed', signed_at=NOW() WHERE document_id=$1 AND role <> 'landlord'`, [docId])
    await replacedByAnotherLease(h)
    const res = await api().get(`/api/esign/sign/${docId}`).set('Authorization', `Bearer ${h.tenantToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.closedReason).toBeNull()
    expect(res.body.data.readOnly).toBe(true)                      // they signed: the ordinary re-open
  })
})

describe('PATCH /leases/:id cannot end a lease while its new lease waits', () => {
  const patch = (h: Household, leaseId: string, status: string) =>
    api().patch(`/api/leases/${leaseId}`).set('Authorization', `Bearer ${h.landlordToken}`).send({ status })
  const state = async (h: Household) => ({
    lease: (await db.query<any>(`SELECT status FROM leases WHERE id=$1`, [h.leaseId])).rows[0].status,
    unit: (await db.query<any>(`SELECT status FROM units WHERE id=$1`, [h.unitId])).rows[0].status,
    people: (await db.query<any>(`SELECT status FROM lease_tenants WHERE lease_id=$1`, [h.leaseId])).rows.map(r => r.status),
  })

  it("refuses 'terminated' and 'expired' — cancel the new lease first — and changes nothing", async () => {
    const h = await seedHousehold()
    const { newLeaseId } = await newLeaseSignedByLandlord(h, plusDays(40))
    for (const status of ['terminated', 'expired']) {
      const res = await patch(h, h.leaseId, status)
      expect(res.status).toBe(409)
      expect(res.body.error).toMatch(/ has a new lease starting .*\. If they are leaving instead, cancel it first: Leases → Change → New lease — view or cancel → Cancel the new lease\. Then end this lease\.$/)
    }
    expect(await state(h)).toEqual({ lease: 'active', unit: 'active', people: ['active'] })
    // Nor can the waiting new lease itself be ended before it starts.
    const own = await patch(h, newLeaseId, 'terminated')
    expect(own.status).toBe(409)
    expect(own.body.error).toMatch(/has not started yet .* cancel it instead/)
    expect((await db.query<any>(`SELECT status FROM leases WHERE id=$1`, [newLeaseId])).rows[0].status).toBe('pending')
  })

  it('once somebody in the household has signed it, the refusal names the leaving-date step', async () => {
    const h = await seedHousehold()
    const { docId } = await newLeaseSignedByLandlord(h, plusDays(40))
    await db.query(`UPDATE lease_document_signers SET status='signed', signed_at=NOW() WHERE document_id=$1 AND role <> 'landlord'`, [docId])
    const res = await patch(h, h.leaseId, 'terminated')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/that the household has signed, so this lease can't be ended early — a signed lease stands\. Write down the day they leave on the new lease once it starts/)
    expect((await state(h)).lease).toBe('active')
  })

  it('with no new lease waiting (or once it is canceled) the lease ends as before', async () => {
    const h = await seedHousehold()
    const { docId } = await newLeaseSignedByLandlord(h, plusDays(40))
    const canceled = await api().post(`/api/esign/documents/${docId}/void`)
      .set('Authorization', `Bearer ${h.landlordToken}`).send({ reason: 'canceled by the landlord' })
    expect(canceled.status).toBe(200)
    const res = await patch(h, h.leaseId, 'terminated')
    expect(res.status).toBe(200)
    expect(await state(h)).toMatchObject({ lease: 'terminated', unit: 'vacant' })
  })

  /** A lease written straight onto the household's space (the lease that replaced theirs, or a stale draft). */
  const leaseOnTheSpace = async (h: Household, status: 'active' | 'pending', start: string) =>
    (await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date,
                           rent_due_day, signed_by_landlord, signed_by_tenant)
       VALUES ($1,$2,900,'month_to_month',$3,$4,NULL,1,TRUE,$5) RETURNING id`,
      [h.unitId, h.landlordId, status, start, status === 'active'])).rows[0].id

  it('a lease that already ended is not ended again — no dead end to "cancel it first", and nothing changes', async () => {
    const h = await seedHousehold()
    const { newLeaseId } = await newLeaseSignedByLandlord(h, plusDays(40))
    await paidOnNewLease(h, newLeaseId, 50)                    // so the new lease can't be canceled
    await replacedByAnotherLease(h)
    const replacement = await leaseOnTheSpace(h, 'active', plusDays(-1))
    expect((await state(h)).unit).toBe('active')

    // Switching how it ended is refused in plain words — not "cancel the new lease first".
    const flip = await patch(h, h.leaseId, 'expired')
    expect(flip.status).toBe(409)
    expect(flip.body.error).toBe("This lease has already ended, so it can't be ended again. Nothing else to do.")
    expect(await state(h)).toMatchObject({ lease: 'terminated', unit: 'active' })
    expect((await db.query<any>(`SELECT status FROM leases WHERE id=$1`, [replacement])).rows[0].status).toBe('active')
    // Still "after an early end": the held new lease never starts.
    expect((await db.query<any>(`SELECT status FROM leases WHERE id=$1`, [newLeaseId])).rows[0].status).toBe('pending')
  })

  // Final sweep (10/3): an ended lease PATCHed back to 'active' read 'active' with
  // nobody on it, and its held new lease (money paid, nobody signed) was no longer
  // "after an early end" — it would start on its date for a household that left.
  it("an ended lease is not brought back ('active' / 'pending') — the held new lease after it stays stopped", async () => {
    const h = await seedHousehold()
    const { docId, newLeaseId } = await newLeaseSignedByLandlord(h, plusDays(40))
    await paidOnNewLease(h, newLeaseId, 50)                    // so the new lease is held, not canceled
    await replacedByAnotherLease(h)
    await processNewLeaseSignings({ hour: 12 })
    expect(await heldAt(docId)).not.toBeNull()

    for (const status of ['active', 'pending']) {
      const res = await patch(h, h.leaseId, status)
      expect(res.status).toBe(409)
      expect(res.body.error).toBe("This lease has already ended, so it can't be made active again. If the household is " +
        'staying, give them a new lease: Tenants → Invite Tenant.')
    }
    expect(await state(h)).toMatchObject({ lease: 'terminated', people: ['removed'] })
    expect((await db.query<any>(`SELECT status FROM leases WHERE id=$1`, [newLeaseId])).rows[0].status).toBe('pending')
    // Still after an early end: the next run still leaves the new lease stopped — it never starts.
    await processNewLeaseSignings({ hour: 12 })
    expect((await db.query<any>(`SELECT status FROM leases WHERE id=$1`, [newLeaseId])).rows[0].status).toBe('pending')
    expect((await db.query<any>(`SELECT status FROM lease_documents WHERE id=$1`, [docId])).rows[0].status).toBe('in_progress')
  })

  it('an expired lease with no new lease after it is not brought back either', async () => {
    const h = await seedHousehold()
    expect((await patch(h, h.leaseId, 'expired')).status).toBe(200)
    const res = await patch(h, h.leaseId, 'active')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^This lease has already ended, so it can't be made active again\./)
    expect(await state(h)).toEqual({ lease: 'expired', unit: 'vacant', people: ['removed'] })
  })

  it('the same status again is no change: the space the lease that replaced it holds stays occupied', async () => {
    const h = await seedHousehold()
    expect((await patch(h, h.leaseId, 'terminated')).status).toBe(200)
    expect(await state(h)).toEqual({ lease: 'terminated', unit: 'vacant', people: ['removed'] })
    await leaseOnTheSpace(h, 'active', plusDays(-1))           // the next household moves in
    expect((await state(h)).unit).toBe('active')

    const again = await patch(h, h.leaseId, 'terminated')
    expect(again.status).toBe(200)
    expect(await state(h)).toEqual({ lease: 'terminated', unit: 'active', people: ['removed'] })
  })

  it('ending a pending lease whose start date has passed never empties the space another lease is in force on', async () => {
    const h = await seedHousehold()
    const stale = await leaseOnTheSpace(h, 'pending', plusDays(-10))
    const res = await patch(h, stale, 'terminated')
    expect(res.status).toBe(200)
    expect((await db.query<any>(`SELECT status FROM leases WHERE id=$1`, [stale])).rows[0].status).toBe('terminated')
    // The household's own lease is in force on it: the space stays occupied.
    expect(await state(h)).toEqual({ lease: 'active', unit: 'active', people: ['active'] })
  })
})
