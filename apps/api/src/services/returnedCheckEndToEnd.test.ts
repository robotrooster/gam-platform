/**
 * 10/14 (Nic, answer 15) — a check returned out of a bigger deposit, end to
 * end, with nothing standing in for the real engines:
 *   - the books: after GAM takes the check back, and after the Undo, every
 *     tenant-money tie-out still equals the money records (no drift — a
 *     difference here blocks closing the month: ledgerClose closePreflight);
 *   - the late fees: the reopened bill gets the late fee the lease names, from
 *     its due date, as if it was never paid (jobs/lateFees, not mocked), and
 *     the Undo takes it off again (kept on record, voided).
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db } from '../db'
import { inTx } from '../test/ledgerFixtures'
import { cleanupTenantLedger, tenantCo, bill, receipt, drain, bankConnection, bal, type TenantCo } from '../test/ledgerTenantFixtures'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { registeredLedgerSourceTypes, unregisterLedgerProjector } from './ledgerEngine'
import { checkOwner, type LedgerFinding } from './ledgerCheck'
import { registerTenantLedgerProjectors } from './ledgerProjectors/tenantMoney'
import { registerTenantLedgerChecks, unregisterTenantLedgerChecks, TENANT_LEDGER_CHECKS } from './ledgerTenantChecks'
import { createSlip } from './depositSlips'
import { reconcileDeposits, normalizeMerchant } from './bankFeed'
import { takeBackReturnedChecks, undoReturnedDeposit } from './returnedCheck'
import { undoDepositMatch, confirmDepositMatch } from './bankDepositConfirm'
import { createIssuedCredit, applyCredit } from './creditUse'

// No email leaves a test.
vi.mock('./email', async (orig) => ({ ...(await orig<any>()), sendNotificationEmail: async () => 'msg_test' }))

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

async function bankRow(landlordId: string, connectionId: string, amount: number, day: string, description: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description,
                                    normalized_merchant, status, bank_status)
     VALUES ($1,$2,$3,$4::date,$5,$6,$7,'needs_review','posted') RETURNING id`,
    [connectionId, landlordId, `ext_${randomUUID()}`, day, amount.toFixed(2), description, normalizeMerchant(description)])).rows[0].id
}

describe('the books after a returned check is taken back, and after its Undo', () => {
  beforeEach(async () => {
    await cleanupTenantLedger()
    registerTenantLedgerProjectors()
    registerTenantLedgerChecks()
  })
  afterEach(() => {
    for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
    unregisterTenantLedgerChecks()
  })

  const TENANT_CHECKS = new Set(TENANT_LEDGER_CHECKS.map(c => c.name))
  const problems = (fs: LedgerFinding[]) => fs.filter(f => TENANT_CHECKS.has(f.check) && (f.severity === 'drift' || f.severity === 'integrity'))

  async function deposited(co: TenantCo) {
    const conn = await bankConnection(co)
    // Two desk checks from the household — rent and water — banked together.
    const rent = await bill(co, { amount: 460, due: daysAgo(12) })
    const water = await bill(co, { type: 'utility', amount: 300, due: daysAgo(12) })
    const { remittanceId: rentCheck } = await receipt(co, { method: 'check', settledAt: `${daysAgo(10)}T18:00:00Z`, apps: [{ paymentId: rent, amount: 460 }] })
    const { remittanceId: waterCheck } = await receipt(co, { method: 'check', settledAt: `${daysAgo(10)}T18:00:00Z`, apps: [{ paymentId: water, amount: 300 }] })
    await createSlip({ landlordId: co.landlordId, depositDate: daysAgo(9), receiptIds: [rentCheck, waterCheck], createdBy: co.ownerUserId })
    const deposit = await bankRow(co.landlordId, conn, 760, daysAgo(9), 'BRANCH DEPOSIT')
    await reconcileDeposits(co.landlordId)
    expect((await db.query(`SELECT status FROM bank_transactions WHERE id = $1`, [deposit])).rows[0].status).toBe('matched')
    return { conn, rent, water, rentCheck }
  }

  it('the drawer, the receivables and the settled bills tie out — before, after the take-back, and after the Undo', async () => {
    const co = await tenantCo({ booksStart: '2026-01-01' })
    const d = await deposited(co)
    await drain()
    expect(problems((await checkOwner({ landlordId: co.landlordId }, { repair: false })).findings)).toEqual([])

    const returned = await bankRow(co.landlordId, d.conn, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    await bankRow(co.landlordId, d.conn, -25, daysAgo(2), 'DEPOSITED ITEM RETURNED FEE')
    expect(await takeBackReturnedChecks(co.landlordId)).toMatchObject({ takenBack: 1 })
    await drain()
    expect(problems((await checkOwner({ landlordId: co.landlordId }, { repair: false })).findings)).toEqual([])
    // Counted once: the drawer is empty, and the household owes the rent again plus the bank's fee.
    expect(await bal(co.landlordId, 'undeposited_funds')).toBe(0)
    expect(await bal(co.landlordId, 'ar_tenants', { tenantId: co.tenantId })).toBe(46000 + 2500)

    await undoDepositMatch({ bankTransactionId: returned, landlordId: co.landlordId, undoneBy: co.ownerUserId })
    await drain()
    expect(problems((await checkOwner({ landlordId: co.landlordId }, { repair: false })).findings)).toEqual([])
    expect(await bal(co.landlordId, 'undeposited_funds')).toBe(0)
    expect(await bal(co.landlordId, 'ar_tenants', { tenantId: co.tenantId })).toBe(0)
  })

  // 10/14 afternoon (Nic): "a tenant's own single-check bank deposit that comes
  // back" — the deposit came in and went out again, so neither bank line is in
  // the books once its receipt is taken back; the rent and the fee are owed.
  it('a tenant’s own deposit that comes back: the books tie out, counted once — before, after the take-back, and after the Undo', async () => {
    const co = await tenantCo({ booksStart: '2026-01-01' })
    const conn = await bankConnection(co)
    const rent = await bill(co, { amount: 460, due: daysAgo(12) })
    const deposit = await bankRow(co.landlordId, conn, 460, daysAgo(10), 'MOBILE DEPOSIT')
    await confirmDepositMatch({ bankTransactionId: deposit, chargeIds: [rent], method: 'check', confirmedByUserId: co.ownerUserId })
    await drain()
    expect(problems((await checkOwner({ landlordId: co.landlordId }, { repair: false })).findings)).toEqual([])
    expect(await bal(co.landlordId, 'bank_checking')).toBe(46000)
    expect(await bal(co.landlordId, 'ar_tenants', { tenantId: co.tenantId })).toBe(0)

    const returned = await bankRow(co.landlordId, conn, -460, daysAgo(2), 'DEPOSITED ITEM RETURNED')
    await bankRow(co.landlordId, conn, -25, daysAgo(2), 'DEPOSITED ITEM RETURNED FEE')
    expect(await takeBackReturnedChecks(co.landlordId)).toMatchObject({ takenBack: 1 })
    await drain()
    expect(problems((await checkOwner({ landlordId: co.landlordId }, { repair: false })).findings)).toEqual([])
    // In and out again: nothing in the bank from either line, nothing in the drawer, the rent and the bank's fee owed.
    expect(await bal(co.landlordId, 'bank_checking')).toBe(0)
    expect(await bal(co.landlordId, 'undeposited_funds')).toBe(0)
    expect(await bal(co.landlordId, 'deposits_in_transit')).toBe(0)
    expect(await bal(co.landlordId, 'ar_tenants', { tenantId: co.tenantId })).toBe(46000 + 2500)

    await undoReturnedDeposit({ lineId: returned, landlordId: co.landlordId, undoneBy: co.ownerUserId })
    await drain()
    expect(problems((await checkOwner({ landlordId: co.landlordId }, { repair: false })).findings)).toEqual([])
    expect(await bal(co.landlordId, 'bank_checking')).toBe(46000)
    expect(await bal(co.landlordId, 'ar_tenants', { tenantId: co.tenantId })).toBe(0)
  })

  // 10/14 follow-up (Nic, answer 15: "reopen their invoice with any late fees
  // that apply"): the late fees the deposit's date had taken off — one at
  // $0.00, one paid by a late-fee credit (the landlord's own $5 already on it),
  // one already paid refunded as credit — come back with it, and go off again
  // on Undo. Counted once at every step.
  it('a tenant’s own deposit whose match took late fees off: the books tie out — before, after the take-back, and after the Undo', async () => {
    const co = await tenantCo({ booksStart: '2026-01-01' })
    const conn = await bankConnection(co)
    const rent = await bill(co, { amount: 460, due: daysAgo(20) })
    const zeroFee = await bill(co, { type: 'late_fee', amount: 15, due: daysAgo(6) })
    const creditFee = await bill(co, { type: 'late_fee', amount: 15, due: daysAgo(5) })
    const paidFee = await bill(co, { type: 'late_fee', amount: 10, due: daysAgo(4) })
    await receipt(co, { method: 'cash', settledAt: `${daysAgo(4)}T18:00:00Z`, apps: [{ paymentId: paidFee, amount: 10 }] })
    await inTx(async c => {
      const inv = (await c.query(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount)
         VALUES ($1,$2,$3,$4,$5,$6::date,460,460) RETURNING id`,
        [co.landlordId, co.tenantId, co.leaseId, co.unitId, `INV-${randomUUID().slice(0, 8)}`, daysAgo(20)])).rows[0].id
      await c.query(`UPDATE payments SET invoice_id = $2 WHERE id = ANY($1::uuid[])`, [[rent, zeroFee, creditFee, paidFee], inv])
      const goodwill = await createIssuedCredit(c, {
        landlordId: co.landlordId, tenantId: co.tenantId, leaseId: co.leaseId, amount: 5, category: 'goodwill', createdBy: co.ownerUserId,
      })
      await applyCredit(c, [{ creditKind: 'issued', creditId: goodwill, paymentId: creditFee, leaseId: co.leaseId, amount: 5,
        billingMonth: `${daysAgo(20).slice(0, 7)}-01` }], { source: 'desk', createdBy: co.ownerUserId })
    })
    const deposit = await bankRow(co.landlordId, conn, 460, daysAgo(18), 'MOBILE DEPOSIT')
    await confirmDepositMatch({ bankTransactionId: deposit, chargeIds: [rent], method: 'check', confirmedByUserId: co.ownerUserId })
    const m = (await db.query(`SELECT auto_settle_undo AS u FROM bank_transactions WHERE id = $1`, [deposit])).rows[0].u
    expect([m.lateFeesZeroed.length, m.lateFeesCredited.length, m.lateFeeRefundCreditIds.length]).toEqual([1, 1, 1])
    await drain()
    expect(problems((await checkOwner({ landlordId: co.landlordId }, { repair: false })).findings)).toEqual([])
    expect(await bal(co.landlordId, 'ar_tenants', { tenantId: co.tenantId })).toBe(0)

    const returned = await bankRow(co.landlordId, conn, -460, daysAgo(2), 'DEPOSITED ITEM RETURNED')
    await bankRow(co.landlordId, conn, -25, daysAgo(2), 'DEPOSITED ITEM RETURNED FEE')
    expect(await takeBackReturnedChecks(co.landlordId)).toMatchObject({ takenBack: 1 })
    await drain()
    expect(problems((await checkOwner({ landlordId: co.landlordId }, { repair: false })).findings)).toEqual([])
    // Owed once each: the rent, the $15 fee back from $0.00, the $10 the late-fee credit had paid, the bank's $25.
    expect(await bal(co.landlordId, 'ar_tenants', { tenantId: co.tenantId })).toBe(46000 + 1500 + 1000 + 2500)
    expect(await bal(co.landlordId, 'bank_checking')).toBe(0)

    await undoReturnedDeposit({ lineId: returned, landlordId: co.landlordId, undoneBy: co.ownerUserId })
    await drain()
    expect(problems((await checkOwner({ landlordId: co.landlordId }, { repair: false })).findings)).toEqual([])
    expect(await bal(co.landlordId, 'ar_tenants', { tenantId: co.tenantId })).toBe(0)
    expect(await bal(co.landlordId, 'bank_checking')).toBe(46000)
  })
})

describe('the late fees of a reopened bill, from its due date (the real engine)', () => {
  beforeEach(async () => { await cleanupAllSchema() })

  it('a bill a bounced check paid gets the lease’s late fee as if never paid; the Undo voids it', async () => {
    const TZ = 'America/Phoenix'
    const s = await inTx(async c => {
      const ll = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      await c.query(`UPDATE properties SET timezone = $2, late_fee_enabled = TRUE WHERE id = $1`, [propertyId, TZ])
      const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId, rentAmount: 460 })
      const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 460 })
      await c.query(
        `UPDATE leases SET late_fee_enabled = TRUE, late_fee_grace_days = 3,
                           late_fee_initial_amount = 25, late_fee_initial_type = 'flat' WHERE id = $1`, [leaseId])
      const tenantId = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      const conn = (await c.query(
        `INSERT INTO bank_connections (landlord_id, provider, status) VALUES ($1,'stripe_fc','active') RETURNING id`,
        [ll.landlordId])).rows[0].id as string
      // Rent due 15 days ago (the bill written before it came due), paid by check the day after it was due.
      const invoiceId = (await c.query(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount,
                              status, created_at)
         VALUES ($1,$2,$3,$4,$5,(NOW() AT TIME ZONE $6)::date - 15, 460, 460, 'pending', NOW() - interval '18 days') RETURNING id`,
        [ll.landlordId, tenantId, leaseId, unitId, `INV-${randomUUID().slice(0, 8)}`, TZ])).rows[0].id as string
      const rentId = (await c.query(
        `INSERT INTO payments (landlord_id, tenant_id, unit_id, lease_id, invoice_id, type, amount, status, entry_description, due_date,
                               created_at)
         VALUES ($1,$2,$3,$4,$5,'rent',460,'pending','RENT',(NOW() AT TIME ZONE $6)::date - 15, NOW() - interval '18 days') RETURNING id`,
        [ll.landlordId, tenantId, unitId, leaseId, invoiceId, TZ])).rows[0].id as string
      return { landlordId: ll.landlordId, userId: ll.userId, tenantId, leaseId, conn, invoiceId, rentId }
    })
    const paidAt = `${daysAgo(14)}T18:00:00Z`
    const checkId = await inTx(async c => {
      const id = (await c.query(
        `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                         payment_method, settled_at, received_by)
         VALUES ($1,$2,$3,460,460,0,'settled','check',$4,$5) RETURNING id`,
        [s.tenantId, s.leaseId, s.landlordId, paidAt, s.userId])).rows[0].id as string
      await c.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,460)`, [id, s.rentId])
      await c.query(`UPDATE payments SET status = 'settled', settled_at = $2, manual_method = 'check' WHERE id = $1`, [s.rentId, paidAt])
      return id
    })
    const lateFees = async () => (await db.query<{ amount: string; status: string }>(
      `SELECT amount::text AS amount, status FROM payments WHERE invoice_id = $1 AND type = 'late_fee' ORDER BY created_at`,
      [s.invoiceId])).rows
    expect(await lateFees()).toEqual([])

    // A $300 check from someone else went in the same bag; the bank shows the $760.
    const other = await inTx(async c => {
      const tenantId = await seedTenant(c)
      const id = (await c.query(
        `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method,
                                         settled_at, received_by)
         VALUES ($1,$2,300,0,300,'settled','check',$3,$4) RETURNING id`, [tenantId, s.landlordId, paidAt, s.userId])).rows[0].id as string
      return id
    })
    await createSlip({ landlordId: s.landlordId, depositDate: daysAgo(13), receiptIds: [checkId, other], createdBy: s.userId })
    await bankRow(s.landlordId, s.conn, 760, daysAgo(13), 'BRANCH DEPOSIT')
    await reconcileDeposits(s.landlordId)
    const returned = await bankRow(s.landlordId, s.conn, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')

    expect(await takeBackReturnedChecks(s.landlordId)).toMatchObject({ takenBack: 1 })
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [s.rentId])).rows[0].status).toBe('pending')
    // The lease's $25, from the bill's own due date (past its 3 grace days long ago).
    expect(await lateFees()).toEqual([{ amount: '25.00', status: 'pending' }])

    await undoDepositMatch({ bankTransactionId: returned, landlordId: s.landlordId, undoneBy: s.userId })
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [s.rentId])).rows[0].status).toBe('settled')
    expect(await lateFees()).toEqual([{ amount: '25.00', status: 'voided' }])
  })
})
