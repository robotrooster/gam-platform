/**
 * 10/12 (Nic, ledger P1) — the three stored facts P1 left for their writers:
 *   payments.work_trade_credit        what the work-trade close took off a row
 *   payments.work_trade_settlement_id the carried-balance row a period's
 *                                     unworked hours were billed on
 *   home_sale_contracts.activated_at  when a sale went active
 * Each written by its writer; and the backfill works them out for rows from
 * before (named in ledger_derived_facts), idempotently.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { db, getClient } from '../db'
import { runWorkTradeSettlement, settleAgreementOnEnd } from './workTradeSettlement'
import { hourRateFor } from '../services/workTradeSettlement'
import { createHomeSaleContract, activateHomeSaleContractIn } from '../services/homeSale'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { ensureWorkTradeExtraHoursSchema } from '../test/pendingWorkTradeSchema'
import { backfillLedgerSourceFacts } from '../scripts/oct12_ledger_source_facts_backfill'

beforeAll(ensureWorkTradeExtraHoursSchema)
beforeEach(cleanupAllSchema)

/** One work-trade tenancy: 80-hour target, a $500 September bill. */
async function stack(opts: { noBill?: boolean } = {}) {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 500 })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 500 })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    const agreementId = (await client.query(
      `INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, start_date, status, monthly_hours_target, carry_forward_months, tracks_hours)
       VALUES ($1,$2,$3,'2026-08-01','active',80,1,TRUE) RETURNING id`, [unitId, tenantId, landlordId])).rows[0].id
    let invoiceId: string | null = null
    let rentId: string | null = null
    if (!opts.noBill) {
      invoiceId = (await client.query(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount,
                               work_trade_agreement_id, late_fee_exempt)
         VALUES ($1,$2,$3,$4,$5,'2026-09-01',500,500,$6,TRUE) RETURNING id`,
        [landlordId, tenantId, leaseId, unitId, `WT-${randomUUID().slice(0, 8)}`, agreementId])).rows[0].id
      rentId = (await client.query(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,$5,'rent',500,'pending','2026-09-01','RENT') RETURNING id`,
        [invoiceId, unitId, leaseId, tenantId, landlordId])).rows[0].id
    }
    const periodId = (await client.query(
      `INSERT INTO work_trade_settlements (agreement_id, invoice_id, period_month, target_hours, hour_rate, basis_amount)
       VALUES ($1,$2,'2026-09-01',80,$3,500) RETURNING id`, [agreementId, invoiceId, hourRateFor(500, 80).toFixed(4)])).rows[0].id
    return { userId, landlordId, tenantId, unitId, leaseId, agreementId, invoiceId, rentId, periodId }
  } finally { client.release() }
}

const logHours = (s: { agreementId: string; tenantId: string; userId: string }, hours: number) => db.query(
  `INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description, status)
   VALUES ($1,$2,$3,'2026-09-10',$4,'work','approved')`, [s.agreementId, s.tenantId, s.userId, hours])

const rowFacts = async (id: string) => (await db.query<any>(
  `SELECT amount::float AS amount, status, work_trade_credit::float AS credit FROM payments WHERE id = $1`, [id])).rows[0]

describe('payments.work_trade_credit — written at the month close', () => {
  it('a full month: the row reads $0 settled and keeps the $500 its hours paid', async () => {
    const s = await stack()
    await logHours(s, 80)
    await runWorkTradeSettlement('2026-09-01')
    expect(await rowFacts(s.rentId!)).toEqual({ amount: 0, status: 'settled', credit: 500 })
  })

  it('a short month: the row asks the lapse and keeps what the hours paid', async () => {
    const s = await stack()
    await logHours(s, 60)
    await runWorkTradeSettlement('2026-09-01')
    expect(await rowFacts(s.rentId!)).toEqual({ amount: 125, status: 'pending', credit: 375 })
  })
})

describe('payments.work_trade_settlement_id — the unworked hours billed with no bill', () => {
  it('names the period whose hours it bills', async () => {
    const s = await stack({ noBill: true })
    await logHours(s, 60)
    await runWorkTradeSettlement('2026-09-01')
    await settleAgreementOnEnd(s.agreementId)
    const carried = (await db.query<any>(
      `SELECT amount::float AS amount, work_trade_settlement_id FROM payments WHERE lease_id = $1 AND type = 'carried_balance'`,
      [s.leaseId])).rows
    expect(carried).toEqual([{ amount: 125, work_trade_settlement_id: s.periodId }])
  })
})

describe('home_sale_contracts.activated_at', () => {
  it('a sale written active is active from then; one awaiting signature gets it when it starts', async () => {
    const s = await stack({ noBill: true })
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const active = await createHomeSaleContract(c, {
        unitId: s.unitId, leaseId: null, tenantId: s.tenantId, landlordId: s.landlordId,
        salePrice: 1200, downPayment: 0, annualInterestRate: 0, termMonths: 12, startMonth: '2026-11-01', planType: 'flat',
      } as any)
      await c.query('COMMIT')
      expect((await db.query<any>(`SELECT activated_at IS NOT NULL AS on FROM home_sale_contracts WHERE id = $1`, [active.id])).rows[0].on).toBe(true)
      await db.query(`UPDATE home_sale_contracts SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [active.id])

      await c.query('BEGIN')
      const waiting = await createHomeSaleContract(c, {
        unitId: s.unitId, leaseId: null, tenantId: s.tenantId, landlordId: s.landlordId,
        salePrice: 1200, downPayment: 0, annualInterestRate: 0, termMonths: 12, startMonth: '2026-11-01', planType: 'flat',
        pendingSignature: true,
      } as any)
      const docId = (await c.query<{ id: string }>(
        `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
         VALUES ($1,$2,'Installment contract','purchase_agreement','completed') RETURNING id`, [s.landlordId, s.unitId])).rows[0].id
      await c.query(`UPDATE home_sale_contracts SET purchase_document_id = $2 WHERE id = $1`, [waiting.id, docId])
      await c.query('COMMIT')
      expect((await db.query<any>(`SELECT activated_at FROM home_sale_contracts WHERE id = $1`, [waiting.id])).rows[0].activated_at).toBeNull()

      await c.query('BEGIN')
      await activateHomeSaleContractIn(c, docId)
      await c.query('COMMIT')
      const after = (await db.query<any>(`SELECT status, activated_at IS NOT NULL AS on FROM home_sale_contracts WHERE id = $1`, [waiting.id])).rows[0]
      expect(after).toEqual({ status: 'active', on: true })
    } finally { c.release() }
  })
})

describe('the backfill (scripts/oct12_ledger_source_facts_backfill)', () => {
  it('works the three facts out for rows from before, names each, and a second run writes nothing', async () => {
    // A month closed by the old code: the rent row rewritten 500 → 0 in the
    // same transaction that raised its bill's work-trade credit (the journal
    // keeps both, one changed_at).
    const s = await stack()
    const c = await getClient()
    try {
      await c.query('BEGIN')
      await c.query(`UPDATE payments SET amount = 0, status = 'settled', settled_at = now() WHERE id = $1`, [s.rentId])
      await c.query(`UPDATE invoices SET work_trade_credit_amount = 500, total_amount = 0 WHERE id = $1`, [s.invoiceId])
      await c.query('COMMIT')
    } finally { c.release() }
    // An unworked-hours row the old code wrote with only a note.
    await db.query(`UPDATE work_trade_settlements SET status = 'billed', billed_at = now() WHERE id = $1`, [s.periodId])
    const carried = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, notes)
       VALUES ($1,$2,$3,$4,'carried_balance',125,'pending','BALANCE',CURRENT_DATE,
               'Work-trade hours not completed for September 2026 — billed when the agreement ended') RETURNING id`,
      [s.unitId, s.leaseId, s.tenantId, s.landlordId])).rows[0].id
    // A sale that went active before activated_at existed.
    const sale = (await db.query<{ id: string }>(
      `INSERT INTO home_sale_contracts (unit_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount,
         annual_interest_rate, term_months, monthly_payment, start_month, status, installments_total, created_at)
       VALUES ($1,$2,$3,1200,0,1200,0,12,100,'2026-11-01','active',12,'2026-09-22T19:05:07Z') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId])).rows[0].id
    // A cancelled one that never went active stays NULL.
    const never = (await db.query<{ id: string }>(
      `INSERT INTO home_sale_contracts (unit_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount,
         annual_interest_rate, term_months, monthly_payment, start_month, status, installments_total)
       VALUES ($1,$2,$3,900,0,900,0,9,100,'2026-11-01','cancelled',9) RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId])).rows[0].id

    const run = async () => {
      const cl = await getClient()
      try {
        await cl.query('BEGIN')
        const r = await backfillLedgerSourceFacts(cl)
        await cl.query('COMMIT')
        return r
      } catch (e) { await cl.query('ROLLBACK').catch(() => {}); throw e } finally { cl.release() }
    }
    const first = await run()
    expect(first).toMatchObject({ workTradeCredit: 1, workTradeSettlementLinks: 1, workTradeCreditUnresolved: [], workTradeSettlementUnresolved: [] })
    expect(first.homeSaleActivatedAt).toBeGreaterThanOrEqual(1)

    expect(await rowFacts(s.rentId!)).toEqual({ amount: 0, status: 'settled', credit: 500 })
    expect((await db.query<any>(`SELECT work_trade_settlement_id FROM payments WHERE id = $1`, [carried])).rows[0].work_trade_settlement_id).toBe(s.periodId)
    expect((await db.query<any>(`SELECT activated_at::text AS at FROM home_sale_contracts WHERE id = $1`, [sale])).rows[0].at)
      .toMatch(/^2026-09-2/)
    expect((await db.query<any>(`SELECT activated_at FROM home_sale_contracts WHERE id = $1`, [never])).rows[0].activated_at).toBeNull()
    const named = (await db.query<any>(
      `SELECT table_name, column_name FROM ledger_derived_facts
        WHERE column_name IN ('work_trade_credit', 'work_trade_settlement_id', 'activated_at') ORDER BY table_name, column_name`)).rows
    expect(named).toEqual(expect.arrayContaining([
      { table_name: 'home_sale_contracts', column_name: 'activated_at' },
      { table_name: 'payments', column_name: 'work_trade_credit' },
      { table_name: 'payments', column_name: 'work_trade_settlement_id' },
    ]))

    const second = await run()
    expect(second).toMatchObject({ workTradeCredit: 0, workTradeSettlementLinks: 0, homeSaleActivatedAt: 0, workTradeCreditUnresolved: [] })
  })

  it('a bill whose credit the journal cannot explain is listed, never guessed', async () => {
    const s = await stack()
    // Credited when the bill was written (before S634): no journal of the rows.
    await db.query(`UPDATE invoices SET work_trade_credit_amount = 200 WHERE id = $1`, [s.invoiceId])
    // That raise IS journaled, but no row fell with it.
    const cl = await getClient()
    try {
      await cl.query('BEGIN')
      const r = await backfillLedgerSourceFacts(cl)
      await cl.query('ROLLBACK')
      expect(r.workTradeCreditUnresolved).toEqual([{ invoiceId: s.invoiceId, credit: '200.00', explained: '0.00' }])
      expect(r.workTradeCredit).toBe(0)
    } finally { cl.release() }
  })
})
