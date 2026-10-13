/**
 * 10/12 (Nic) — GAM Books ledger, phase P4: the nightly tie-outs for tenant
 * money equal the money records (gam-ledger-design-2026-10-12 §8 table, §17
 * "Nightly checks: each equals its operational truth on seeded data,
 * including an ACH in flight").
 *
 *   Nic: "within a minute (+ nightly tie-out check)"
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { inTx, memProjector } from '../test/ledgerFixtures'
import { seedTenant } from '../test/dbHelpers'
import {
  cleanupTenantLedger, tenantCo, bill, receipt, paidAhead, spend, drain, bankConnection, bal, type TenantCo,
} from '../test/ledgerTenantFixtures'
import { registeredLedgerSourceTypes, unregisterLedgerProjector, registerLedgerProjector } from './ledgerEngine'
import { checkOwner, type LedgerFinding } from './ledgerCheck'
import { registerTenantLedgerProjectors } from './ledgerProjectors/tenantMoney'
import { registerTenantLedgerChecks, unregisterTenantLedgerChecks, TENANT_LEDGER_CHECKS } from './ledgerTenantChecks'
import { registerP5, sale } from '../test/ledgerP5Fixtures'
import { registerLedgerCheck, unregisterLedgerCheck } from './ledgerCheck'
import { P5_LEDGER_CHECKS } from './ledgerProjectors/registerBookingPayoutAll'

beforeEach(async () => {
  await cleanupTenantLedger()
  registerTenantLedgerProjectors()
  registerTenantLedgerChecks()
  for (const c of P5_LEDGER_CHECKS) registerLedgerCheck(c)
})
afterEach(() => {
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
  unregisterTenantLedgerChecks()
  for (const c of P5_LEDGER_CHECKS) unregisterLedgerCheck(c.name)
})

const TENANT_CHECKS = new Set(TENANT_LEDGER_CHECKS.map(c => c.name).concat(['gam_held_paid_ahead_on_books']))
const ours = (fs: LedgerFinding[]) => fs.filter(f => TENANT_CHECKS.has(f.check))

/** A month of a company's tenant money, every shape the checks tie. */
async function aMonth(co: TenantCo): Promise<void> {
  const conn = await bankConnection(co)
  // Paid by card; a card surplus GAM holds, later paying October (L13).
  const sept = await bill(co, { amount: 1000, due: '2026-09-01' })
  const { creditId: gamCredit } = await receipt(co, { method: 'card', settledAt: '2026-09-02T18:00:00Z',
    apps: [{ paymentId: sept, amount: 1000 }], surplus: 100 })
  const oct = await bill(co, { amount: 1000, due: '2026-10-01' })
  await spend(co, { paymentId: oct, prepaidCreditId: gamCredit!, amount: 100, appliedAt: '2026-10-01T15:00:00Z', settle: false })
  // October's rest is a bank payment still in flight.
  await inTx(async c => {
    const rem = (await c.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method,
                                       stripe_payment_intent_id)
       VALUES ($1, $2, $3, 900, 900, 0, 'processing', 'ach', $4) RETURNING id`,
      [co.tenantId, co.leaseId, co.landlordId, `pi_${randomUUID()}`])).rows[0].id
    await c.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, 900)`, [rem, oct])
    await c.query(`UPDATE payments SET status = 'processing' WHERE id = $1`, [oct])
  })
  // A late fee still owed; the cash the desk took with $50 kept as paid-ahead
  // money; a landlord-held paid-ahead spend on a utility.
  await bill(co, { type: 'late_fee', amount: 25, due: '2026-09-06' })
  const water = await bill(co, { type: 'utility', amount: 80, due: '2026-09-01' })
  const typedIn = await paidAhead(co, { amount: 50, fundedBy: 'landlord', receivedAt: '2026-08-20T15:00:00Z', note: 'Carried over' })
  await spend(co, { paymentId: water, prepaidCreditId: typedIn, amount: 50, appliedAt: '2026-09-03T15:00:00Z', settle: false })
  await receipt(co, { method: 'cash', settledAt: '2026-09-04T17:00:00Z', apps: [{ paymentId: water, amount: 30 }], surplus: 50 })
  // A bank-deposit receipt the bank has not shown yet, and one it has.
  const fee = await bill(co, { type: 'fee', amount: 40, due: '2026-09-01' })
  await receipt(co, { method: 'bank_deposit', settledAt: '2026-09-06T17:00:00Z', apps: [{ paymentId: fee, amount: 40 }] })
  const fee2 = await bill(co, { type: 'fee', amount: 60, due: '2026-09-02' })
  const { remittanceId: matched } = await receipt(co, { method: 'bank_deposit', settledAt: '2026-09-06T17:00:00Z',
    apps: [{ paymentId: fee2, amount: 60 }] })
  await db.query(
    `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, status, auto_settle_undo)
     VALUES ($1, $2, $3, '2026-09-08', 60, 'matched', jsonb_build_object('receiptId', $4::text))`,
    [conn, co.landlordId, `ext_${randomUUID()}`, matched])
  // A deposit paid through GAM; a prior arrangement; paid-ahead money from before GAM.
  const dep = await bill(co, { type: 'deposit', amount: 500, due: '2026-09-01', depositCollectedBy: 'gam' })
  await receipt(co, { method: 'card', settledAt: '2026-09-01T18:00:00Z', apps: [{ paymentId: dep, amount: 500 }] })
  await bill(co, { type: 'utility', amount: 33, due: '2026-09-01', status: 'settled', manualMethod: 'prior_arrangement',
    settledAt: '2026-09-18T18:00:00Z' })
  await paidAhead(co, { amount: 37.6, fundedBy: 'landlord', receivedAt: '2026-08-12T19:00:00Z', note: 'Paid ahead before GAM' })
}

describe('the tenant-money tie-outs', () => {
  it('every account equals its money records on a month with every shape (an ACH in flight included)', async () => {
    const co = await tenantCo({ booksStart: '2026-08-01', homeSale: 'whole_sale_at_signing', workTrade: 'rent_and_labor' })
    await aMonth(co)
    await drain()
    const res = await checkOwner({ landlordId: co.landlordId }, { repair: false })
    expect(ours(res.findings)).toEqual([])
    expect(res.findings.filter(f => f.severity === 'integrity' || f.severity === 'drift')).toEqual([])
  })

  it('a settled bill no receipt, credit or arrangement explains is found (it would sit open in receivables)', async () => {
    const co = await tenantCo()
    const rent = await bill(co, { amount: 700, due: '2026-09-01' })
    await drain()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = now() WHERE id = $1`, [rent])
    await drain()
    const res = await checkOwner({ landlordId: co.landlordId }, { repair: false })
    const f = ours(res.findings)
    expect(f.find(x => x.check === 'settled_rows_explained')).toMatchObject({ severity: 'drift', detail: { paymentId: rent, amountCents: 70000, explainedCents: 0 } })
    expect(f.find(x => x.check === 'tenant_receivables')).toMatchObject({ severity: 'drift', detail: { ledgerCents: 70000, expectedCents: 0 } })
  })

  it('while a record is still waiting to post, a difference is pending, not drift', async () => {
    const co = await tenantCo()
    await bill(co, { amount: 250, due: '2026-09-01' })
    // Not drained: checkOwner drains first, so park the source behind a back-off.
    const id = (await db.query<{ id: string }>(`SELECT id FROM payments WHERE landlord_id = $1`, [co.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO ledger_source_errors (source_type, source_id, owner_id, reason_code, attempts, last_error, next_try_at)
       VALUES ('payment', $1, $2, 'owner_not_ready', 1, 'waiting', now() + interval '1 hour')`, [id, co.landlordId])
    const res = await checkOwner({ landlordId: co.landlordId }, { repair: false })
    expect(ours(res.findings).find(x => x.check === 'tenant_receivables')).toMatchObject({ severity: 'pending' })
    expect(res.findings.filter(f => f.severity === 'drift')).toEqual([])
  })

  // 10/12 (Nic, ledger review): a waiting record makes only what it posts to pending.
  it('a waiting source of a type nothing posts yet, or a bill waiting on the owner, never hides another account\'s drift', async () => {
    const co = await tenantCo()
    const otherTenant = await inTx(c => seedTenant(c))
    // A bill waiting on the owner's choice (parked behind its back-off), and an
    // edited expense (phase P6: nothing drains it yet).
    const waitingRent = await bill(co, { amount: 250, due: '2026-09-01' })
    await db.query(
      `INSERT INTO ledger_source_errors (source_type, source_id, owner_id, reason_code, attempts, last_error, next_try_at)
       VALUES ('payment', $1, $2, 'owner_not_ready', 1, 'waiting', now() + interval '1 hour')`, [waitingRent, co.landlordId])
    await db.query(`INSERT INTO ledger_outbox (source_type, source_id, owner_id) VALUES ('expense', $1, $2)`, [randomUUID(), co.landlordId])
    // Records the books never saw (written with the capture off — test only):
    // another tenant's bill and a cash receipt in the drawer.
    await inTx(async c => {
      await c.query(`SET LOCAL session_replication_role = replica`)
      await c.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, revenue_owner)
         VALUES ($1, $2, $3, $4, 'fee', 400, 'pending', '2026-09-01', 'OTHERFEE', 'landlord')`, [co.unitId, co.leaseId, otherTenant, co.landlordId])
      await c.query(
        `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method, settled_at)
         VALUES ($1, $2, $3, 30, 0, 30, 'settled', 'cash', '2026-09-03T18:00:00Z')`, [co.tenantId, co.leaseId, co.landlordId])
    })
    const res = await checkOwner({ landlordId: co.landlordId }, { repair: false })
    const f = ours(res.findings)
    expect(f.find(x => x.check === 'undeposited_funds')).toMatchObject({ severity: 'drift', detail: { ledgerCents: 0, expectedCents: 3000 } })
    const ar = f.filter(x => x.check === 'tenant_receivables')
    expect(ar.find(x => (x.detail as any).tenantId === co.tenantId)).toMatchObject({ severity: 'pending', detail: { expectedCents: 25000 } })
    expect(ar.find(x => (x.detail as any).tenantId === otherTenant)).toMatchObject({ severity: 'drift', detail: { expectedCents: 40000 } })
  })

  it('the drawer (1040) counts a refunded cash sale once, keeps a cash sale refunded by check, and loses a card sale refunded in cash', async () => {
    const co = await tenantCo()
    registerP5()
    const refund = async (saleId: string, amount: number, method: 'cash' | 'check') => {
      await db.query(
        `INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method, tax_refunded, card_fee_refunded)
         VALUES ($1, $2, $3, $4, 0, 0)`, [saleId, co.landlordId, amount, method])
      // recordSaleRefund raises the sale's refund_amount (and its status) with the refund.
      await db.query(
        `UPDATE pos_transactions SET refund_amount = refund_amount + $2,
                status = CASE WHEN refund_amount + $2 >= total THEN 'refunded' ELSE 'partial_refund' END WHERE id = $1`, [saleId, amount])
    }
    const partly = await sale(co, { subtotal: 50, at: '2026-09-10 18:00:00+00' })
    await refund(partly, 20, 'cash')
    const whole = await sale(co, { subtotal: 30, at: '2026-09-10 18:00:00+00' })
    await refund(whole, 30, 'cash')
    const byCheck = await sale(co, { subtotal: 40, at: '2026-09-10 18:00:00+00' })
    await refund(byCheck, 40, 'check')
    const card = await sale(co, { method: 'card', subtotal: 25, platformFee: 1, held: 24, at: '2026-09-10 18:00:00+00' })
    await refund(card, 10, 'cash')
    expect(await drain()).toMatchObject({ failed: 0 })
    // Drawer: 50 − 20 + 30 − 30 + 40 − 10 = 60. Outstanding checks: 40.
    expect(await bal(co.landlordId, 'undeposited_funds')).toBe(6000)
    expect(await bal(co.landlordId, 'outstanding_checks')).toBe(-4000)
    const res = await checkOwner({ landlordId: co.landlordId }, { repair: false })
    expect(ours(res.findings)).toEqual([])
  })

  it('2015 holds every check and bank pull the bank has not cleared: refund checks, register refunds by check, GAM fee pulls', async () => {
    const co = await tenantCo()
    registerP5()
    const charge = (await db.query<{ id: string }>(
      `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, source_type, notes) VALUES ($1, $2, 'subscription', 54, 'platform_fee', 'Platform fee') RETURNING id`,
      [co.landlordId, co.propertyId])).rows[0].id
    const debit = (await db.query<{ id: string }>(
      `INSERT INTO landlord_gam_debits (landlord_id, charges_amount, total_amount, status, charge_ids, settled_at)
       VALUES ($1, 54, 54, 'succeeded', ARRAY[$2::uuid], '2026-09-20T18:00:00Z') RETURNING id`, [co.landlordId, charge])).rows[0].id
    await db.query(
      `INSERT INTO landlord_gam_charge_collections (charge_id, landlord_gam_debit_id, amount, collected_at) VALUES ($1, $2, 54, '2026-09-20T18:00:00Z')`,
      [charge, debit])
    const s = await sale(co, { subtotal: 15, at: '2026-09-10 18:00:00+00' })
    await db.query(
      `INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method, tax_refunded, card_fee_refunded) VALUES ($1, $2, 15, 'check', 0, 0)`,
      [s, co.landlordId])
    expect(await drain()).toMatchObject({ failed: 0 })
    expect(await bal(co.landlordId, 'outstanding_checks')).toBe(-(5400 + 1500))
    const res = await checkOwner({ landlordId: co.landlordId }, { repair: false })
    expect(ours(res.findings)).toEqual([])
    expect(res.findings.filter(x => x.check === 'p5_due_to_gam')).toEqual([])
  })

  it('L13: a line on 1055 (paid-ahead money GAM holds) is an integrity finding', async () => {
    const co = await tenantCo()
    const m = memProjector('work_trade_hours')
    registerLedgerProjector(m.projector)
    m.wants.set('x1', [{ owner: { landlordId: co.landlordId }, intendedDate: '2026-09-01', lines: [
      { role: 'due_from_gam_tenant_money', debitCents: 100 }, { role: 'tenant_prepayments', creditCents: 100 },
    ] }])
    await db.query(`INSERT INTO ledger_outbox (source_type, source_id, owner_id) VALUES ('work_trade_hours', 'x1', $1)`, [co.landlordId])
    await drain()
    const res = await checkOwner({ landlordId: co.landlordId }, { repair: false })
    expect(res.findings.find(f => f.check === 'gam_held_paid_ahead_on_books')).toMatchObject({ severity: 'integrity' })
  })

  it('home notes tie per contract; a refund by check sits in 2015', async () => {
    const co = await tenantCo({ booksStart: '2026-10-01', homeSale: 'whole_sale_at_signing' })
    const k = await inTx(async c => (await c.query<{ id: string }>(
      `INSERT INTO home_sale_contracts (unit_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount, annual_interest_rate,
                                        term_months, monthly_payment, start_month, installments_total, status, activated_at)
       VALUES ($1, $2, $3, 5000, 0, 5000, 0, 50, 100, '2019-01-01', 50, 'active', '2026-09-20T18:00:00Z') RETURNING id`,
      [co.unitId, co.tenantId, co.landlordId])).rows[0].id)
    await db.query(
      `INSERT INTO home_sale_installments (contract_id, installment_number, billing_month, amount, principal_portion, interest_portion,
                                           remaining_balance, settled_off_platform_at)
       VALUES ($1, 1, '2026-09-01', 100, 100, 0, 4900, now()), ($1, 2, '2026-10-01', 100, 100, 0, 4800, now())`, [k])
    const dep = await bill(co, { type: 'deposit', amount: 200, due: '2026-10-01' })
    await receipt(co, { method: 'cash', settledAt: '2026-10-01T18:00:00Z', apps: [{ paymentId: dep, amount: 200 }] })
    const ret = (await db.query<{ id: string }>(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, total_deductions, refund_amount, status, finalized_at)
       VALUES ($1, $2, $3, 200, 0, 200, 'sent_refund', '2026-10-31T18:00:00Z') RETURNING id`, [co.leaseId, co.tenantId, co.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO stay_refund_parts (landlord_id, deposit_return_id, seq, kind, toward_amount, amount, label, status, refunded_at)
       VALUES ($1, $2, 1, 'check', 200, 200, 'Deposit refund', 'refunded', '2026-11-02T18:00:00Z')`, [co.landlordId, ret])
    await drain()
    const res = await checkOwner({ landlordId: co.landlordId }, { repair: false })
    expect(ours(res.findings)).toEqual([])
  })
})
