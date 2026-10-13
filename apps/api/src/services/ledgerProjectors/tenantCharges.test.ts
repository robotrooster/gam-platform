/**
 * 10/12 (Nic) — GAM Books ledger, phase P4, family A: tenant bills post
 * themselves (gam-ledger-design-2026-10-12 §6 A1-A9, A7b; §17 "Projectors").
 *
 *   Nic 10/12: "charges recorded when billed AND payments when received (both
 *   always)"; deposits are a liability; home sales and work trade are the
 *   landlord's choice.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../../db'
import { seedUtilityMeter, seedLeaseFee } from '../../test/dbHelpers'
import { inTx } from '../../test/ledgerFixtures'
import { tenantCo, bill, receipt, drain, bal, activeLines, triples, sourceError } from '../../test/ledgerTenantFixtures'
import { cleanupTenantLedger } from '../../test/ledgerTenantFixtures'
import { registeredLedgerSourceTypes, unregisterLedgerProjector } from '../ledgerEngine'
import { registerTenantLedgerProjectors } from './tenantMoney'

beforeEach(async () => {
  await cleanupTenantLedger()
  registerTenantLedgerProjectors()
})
afterEach(() => {
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
})

describe('A1 / A3: a bill posts its charge on its due date', () => {
  it('rent: Dr receivables / Cr space rent, tagged with the property, tenant and the row', async () => {
    const co = await tenantCo()
    const id = await bill(co, { amount: 1000, due: '2026-09-01' })
    await drain()
    const lines = await activeLines('payment', id)
    expect(lines.every(l => l.kind === 'charge' && l.day === '2026-09-01')).toBe(true)
    expect(triples(lines)).toEqual([['ar_tenants', 100000, 0], ['space_rent', 0, 100000]])
    expect(lines.every(l => l.propertyId === co.propertyId && l.tenantId === co.tenantId && l.paymentId === id)).toBe(true)
    expect(lines.every(l => l.category === 'space_rent' && l.cash === null)).toBe(true)
  })

  it('a late fee books to late fees; a pet fee to pet fees; any other fee to other fees', async () => {
    const co = await tenantCo()
    const late = await bill(co, { type: 'late_fee', amount: 25, due: '2026-09-06' })
    const petFee = await inTx(c => seedLeaseFee(c, { leaseId: co.leaseId, feeType: 'pet_fee', amount: 50, dueTiming: 'move_in' }))
    const pet = await bill(co, { type: 'fee', entry: 'OTHERFEE', amount: 50, due: '2026-09-01', leaseFeeId: petFee })
    const other = await bill(co, { type: 'fee', entry: 'OTHERFEE', amount: 30, due: '2026-09-01' })
    await drain()
    expect(triples(await activeLines('payment', late))).toEqual([['ar_tenants', 2500, 0], ['late_fees', 0, 2500]])
    expect(triples(await activeLines('payment', pet))).toEqual([['ar_tenants', 5000, 0], ['pet_fees', 0, 5000]])
    expect(triples(await activeLines('payment', other))).toEqual([['ar_tenants', 3000, 0], ['other_fees', 0, 3000]])
  })

  it('an amount rewrite restates; a void reverses (a correction, no new money)', async () => {
    const co = await tenantCo()
    const id = await bill(co, { amount: 500, due: '2026-09-01' })
    await drain()
    await db.query(`UPDATE payments SET amount = 450 WHERE id = $1`, [id])
    await drain()
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(45000)
    expect(await bal(co.landlordId, 'space_rent')).toBe(-45000)
    await db.query(`UPDATE payments SET status = 'voided', voided_at = now(), void_reason = 'test' WHERE id = $1`, [id])
    await drain()
    expect(await activeLines('payment', id)).toEqual([])
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(0)
    expect(await bal(co.landlordId, 'space_rent')).toBe(0)
  })

  it('a part payment that split a row: the original restates and the remainder posts its own part — together, the whole bill', async () => {
    const co = await tenantCo()
    const id = await bill(co, { type: 'carried_balance', amount: 100, due: '2026-09-01' })
    await drain()
    await db.query(`UPDATE payments SET amount = 60 WHERE id = $1`, [id])
    const rest = await bill(co, { type: 'carried_balance', amount: 40, due: '2026-09-01' })
    await db.query(`UPDATE payments SET is_remainder = TRUE WHERE id = $1`, [rest])
    await drain()
    expect(triples(await activeLines('payment', id))).toEqual([['ar_tenants', 6000, 0], ['opening_balance_equity', 0, 6000]])
    expect(triples(await activeLines('payment', rest))).toEqual([['ar_tenants', 4000, 0], ['opening_balance_equity', 0, 4000]])
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(10000)
  })
})

describe('A2: a utility line — the payment amount is the truth, the bills say what and the tax', () => {
  it('splits the amount across its bills by their charge, with the tax (capped at the amount) owed', async () => {
    const co = await tenantCo()
    const { water, electric } = await inTx(async c => ({
      water: await seedUtilityMeter(c, { propertyId: co.propertyId, utilityType: 'water' }),
      electric: await seedUtilityMeter(c, { propertyId: co.propertyId, utilityType: 'electric' }),
    }))
    const id = await bill(co, { type: 'utility', amount: 110, due: '2026-09-01' })
    await db.query(
      `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month, charge_amount, tax_amount,
                                  payment_id, status, utility_type)
       VALUES ($1, $3, $4, $5, $6, '2026-08-01', 60, 6, $7, 'billed', 'water'),
              ($2, $3, $4, $5, $6, '2026-08-01', 40, 4, $7, 'billed', 'electric')`,
      [water, electric, co.unitId, co.tenantId, co.leaseId, co.landlordId, id])
    await drain()
    expect(triples(await activeLines('payment', id)).sort()).toEqual([
      ['ar_tenants', 11000, 0], ['utility_electric', 0, 4000], ['utility_tax_payable', 0, 1000], ['utility_water', 0, 6000],
    ])
  })

  it('a line that no longer matches its bill (Oak Park: $3.00 paid against a $32.00 bill) books the payment amount', async () => {
    const co = await tenantCo()
    const meter = await inTx(c => seedUtilityMeter(c, { propertyId: co.propertyId, utilityType: 'water' }))
    const id = await bill(co, { type: 'utility', amount: 3, due: '2026-09-01' })
    await db.query(
      `INSERT INTO utility_bills (meter_id, unit_id, tenant_id, lease_id, landlord_id, billing_cycle_month, charge_amount, payment_id, status, utility_type)
       VALUES ($1, $2, $3, $4, $5, '2026-08-01', 32, $6, 'billed', 'water')`,
      [meter, co.unitId, co.tenantId, co.leaseId, co.landlordId, id])
    await drain()
    expect(triples(await activeLines('payment', id))).toEqual([['ar_tenants', 300, 0], ['utility_water', 0, 300]])
  })
})

describe('A4-A9: what a row is decides where it books', () => {
  it('A4 a refundable deposit is owed back (2020), never income', async () => {
    const co = await tenantCo()
    const id = await bill(co, { type: 'deposit', amount: 800, due: '2026-09-01' })
    await drain()
    expect(triples(await activeLines('payment', id))).toEqual([['ar_tenants', 80000, 0], ['security_deposits_payable', 0, 80000]])
    expect((await activeLines('payment', id)).every(l => l.category === 'deposits')).toBe(true)
  })

  it('A6 the prepaid move-in box books nothing when billed (Nic L13); GAM rows and the FlexPay pull never book', async () => {
    const co = await tenantCo()
    const box = await bill(co, { type: 'fee', amount: 300, due: '2026-09-01', revenueOwner: 'held' })
    const gam = await bill(co, { type: 'fee', entry: 'RETURNFEE', amount: 4, due: '2026-09-01', revenueOwner: 'gam' })
    const flexpay = await bill(co, { type: 'rent', entry: 'FLEXPAY', amount: 900, due: '2026-09-01', revenueOwner: 'gam' })
    await drain()
    for (const id of [box, gam, flexpay]) expect(await activeLines('payment', id)).toEqual([])
  })

  it('A8 an opening carried balance is owed but never income (3900); A9 a work-trade shortfall row is space rent', async () => {
    const co = await tenantCo()
    const carried = await bill(co, { type: 'carried_balance', amount: 250, due: '2026-09-01' })
    const settlement = await inTx(async c => {
      const a = (await c.query<{ id: string }>(
        `INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, start_date, monthly_hours_target)
         VALUES ($1, $2, $3, '2026-08-01', 20) RETURNING id`, [co.unitId, co.tenantId, co.landlordId])).rows[0].id
      return (await c.query<{ id: string }>(
        `INSERT INTO work_trade_settlements (agreement_id, period_month, period_start, period_end, target_hours, hours_worked,
                                             hours_applied, hour_rate, basis_amount, credit_applied, status)
         VALUES ($1, '2026-08-01', '2026-08-01', '2026-08-31', 20, 10, 10, 15, 300, 150, 'billed') RETURNING id`, [a])).rows[0].id
    })
    const shortfall = await bill(co, { type: 'carried_balance', amount: 150, due: '2026-09-02', workTradeSettlementId: settlement })
    await drain()
    expect(triples(await activeLines('payment', carried))).toEqual([['ar_tenants', 25000, 0], ['opening_balance_equity', 0, 25000]])
    expect(triples(await activeLines('payment', shortfall))).toEqual([['ar_tenants', 15000, 0], ['space_rent', 0, 15000]])
  })

  it('a bill work-trade hours covered posts its full rent (amount + work_trade_credit) beside the hours', async () => {
    const co = await tenantCo({ workTrade: 'rent_and_labor' })
    const id = await bill(co, { amount: 0, due: '2026-09-01', status: 'settled', settledAt: '2026-10-01T12:00:00Z', workTradeCredit: 460 })
    await drain()
    const lines = await activeLines('payment', id)
    expect(triples(lines, 'charge')).toEqual([['ar_tenants', 46000, 0], ['space_rent', 0, 46000]])
    expect(triples(lines, 'work_trade')).toEqual([['work_trade_labor', 46000, 0], ['ar_tenants', 0, 46000]])
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(0)
  })
})

describe('A7 / A7b: home payments, by the owner\'s choice (Nic L11)', () => {
  async function contract(co: Awaited<ReturnType<typeof tenantCo>>) {
    return inTx(async c => {
      const k = (await c.query<{ id: string }>(
        `INSERT INTO home_sale_contracts (unit_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount,
                                          annual_interest_rate, term_months, monthly_payment, start_month, installments_total,
                                          status, activated_at)
         VALUES ($1, $2, $3, 12000, 2000, 10000, 6, 60, 193.33, '2026-09-01', 60, 'active', '2026-08-20T12:00:00Z') RETURNING id`,
        [co.unitId, co.tenantId, co.landlordId])).rows[0].id
      const i1 = (await c.query<{ id: string }>(
        `INSERT INTO home_sale_installments (contract_id, installment_number, billing_month, amount, principal_portion, interest_portion, remaining_balance)
         VALUES ($1, 1, '2026-09-01', 193.33, 143.33, 50.00, 9856.67) RETURNING id`, [k])).rows[0].id
      const i2 = (await c.query<{ id: string }>(
        `INSERT INTO home_sale_installments (contract_id, installment_number, billing_month, amount, principal_portion, interest_portion, remaining_balance)
         VALUES ($1, 2, '2026-10-01', 193.33, 144.05, 49.28, 9712.62) RETURNING id`, [k])).rows[0].id
      return { k, i1, i2 }
    })
  }

  it('whole sale at signing: the principal pays down the note (1310) and the interest is income', async () => {
    const co = await tenantCo({ homeSale: 'whole_sale_at_signing' })
    const { i2 } = await contract(co)
    const id = await bill(co, { type: 'home_payment', amount: 193.33, due: '2026-10-01', homeSaleInstallmentId: i2 })
    await db.query(`UPDATE home_sale_installments SET payment_id = $1 WHERE id = $2`, [id, i2])
    await drain()
    expect(triples(await activeLines('payment', id))).toEqual([
      ['ar_tenants', 19333, 0], ['home_notes_receivable', 0, 14405], ['home_note_interest', 0, 4928],
    ])
  })

  it('income as paid: the principal is home-sale income', async () => {
    const co = await tenantCo({ homeSale: 'income_as_paid' })
    const { i2 } = await contract(co)
    const id = await bill(co, { type: 'home_payment', amount: 193.33, due: '2026-10-01', homeSaleInstallmentId: i2 })
    await drain()
    expect(triples(await activeLines('payment', id))).toEqual([
      ['ar_tenants', 19333, 0], ['home_sales', 0, 14405], ['home_note_interest', 0, 4928],
    ])
  })

  it('not chosen yet: the home payment waits on the owner (no admin notice), and posts once chosen', async () => {
    const co = await tenantCo()
    const { i2 } = await contract(co)
    const id = await bill(co, { type: 'home_payment', amount: 193.33, due: '2026-10-01', homeSaleInstallmentId: i2 })
    await drain()
    expect(await activeLines('payment', id)).toEqual([])
    expect(await sourceError('payment', id)).toMatchObject({ reason_code: 'owner_not_ready' })
    await db.query(`UPDATE landlords SET books_home_sale_method = 'whole_sale_at_signing' WHERE id = $1`, [co.landlordId])
    await db.query(`UPDATE ledger_source_errors SET next_try_at = now() WHERE owner_id = $1`, [co.landlordId])
    await drain()
    expect(triples(await activeLines('payment', id))).toHaveLength(3)
    expect(await sourceError('payment', id)).toBeNull()
  })

  it('A7b an installment paid outside GAM posts on its billing month to "paid outside GAM, to confirm", counted as received', async () => {
    const co = await tenantCo({ homeSale: 'whole_sale_at_signing' })
    const { i1 } = await contract(co)
    await db.query(`UPDATE home_sale_installments SET settled_off_platform_at = now() WHERE id = $1`, [i1])
    await drain()
    const lines = await activeLines('home_installment', i1)
    expect(lines.every(l => l.day === '2026-09-01')).toBe(true)
    expect(triples(lines)).toEqual([['suspense', 19333, 0], ['home_notes_receivable', 0, 14333], ['home_note_interest', 0, 5000]])
    expect(lines.filter(l => l.cash === 'in').map(l => l.category)).toEqual(['home_payments', 'home_payments'])
  })
})

describe('the receivable follows the bill', () => {
  it('a paid bill nets 1100 to zero: charged on its due date, received on its own day', async () => {
    const co = await tenantCo()
    const id = await bill(co, { amount: 700, due: '2026-09-01' })
    await receipt(co, { method: 'cash', settledAt: '2026-09-03T17:00:00Z', apps: [{ paymentId: id, amount: 700 }] })
    await drain()
    expect(await bal(co.landlordId, 'ar_tenants')).toBe(0)
    expect(await bal(co.landlordId, 'space_rent')).toBe(-70000)
    expect(await bal(co.landlordId, 'undeposited_funds')).toBe(70000)
  })
})
