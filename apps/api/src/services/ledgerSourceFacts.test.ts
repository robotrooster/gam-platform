/**
 * 10/12 (Nic) — ledger P1: every money table keeps its history, and the facts
 * a ledger rebuild needs are stored by their writers when the money moves
 * (gam-ledger-design-2026-10-12 §P1). Each writer here is exercised directly;
 * the backfill is held to the same rules and to running twice for nothing.
 *
 * Every test runs inside a transaction that is rolled back.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeAll } from 'vitest'
import type { PoolClient } from 'pg'
import { DEPOSIT_COLLECTED_BY_VALUES } from '@gam/shared'
import { db } from '../db'
import {
  withRollback, seedLandlord, seedManager, seedTenant, seedProperty, seedUnit,
  seedAllocationRule, seedRentPayment, seedLease,
} from '../test/dbHelpers'
import { executeRentAllocation } from './allocation'
import { recordHeldItem } from './heldPayouts'
import { disputeFeePropertySql } from './incomeBasis'
import { reconcileSettledDepositPayment, stampDepositCollectedBy } from './leaseFeesSync'
import { recordSiteDeposit } from './stayPayments'
import { recordSaleRefund, saleRefundTax, saleRefundCardFeeShare } from './earlyCheckOut'
import { backfillLedgerSourceFacts, heldItemPropertyFromSource } from '../scripts/oct12_ledger_source_facts_backfill'

/** The money tables 20261013100000_audit_money_tables gives an audit trigger. */
const AUDITED_MONEY_TABLES = [
  'tenant_remittances', 'remittance_applications', 'tenant_declared_deposits',
  'bank_deposit_allocations', 'lease_prepaid_credit_draws', 'paid_ahead_choices',
  'payment_reversals', 'connect_disputes', 'lease_rent_components',
  'lot_rent_charges', 'propane_fills', 'suspended_utility_charges',
  'utility_owner_use_absorptions', 'security_deposit_interest_accruals',
  'sublessor_credit_balances', 'work_trade_settlements',
  'user_balance_ledger', 'held_payout_items', 'platform_transfer_intents',
  'connect_payouts', 'landlord_instant_margins',
  'landlord_gam_charges', 'landlord_gam_debits', 'platform_revenue_ledger', 'reserve_fund_ledger',
  'pm_monthly_fee_accruals', 'commission_accruals', 'screening_fee_accruals',
  'screening_prepayments', 'stripe_processing_costs',
  'flex_charge_statements', 'flex_charge_transactions',
  'flex_deposit_custody_charges', 'flexcredit_charges',
  'pos_transactions', 'pos_transaction_items', 'pos_refunds',
  'pos_eod_settlements', 'pos_held_payments', 'pos_reader_orders',
  'stay_payments', 'stay_refund_parts', 'stay_checkout_decisions',
  'home_sale_contracts', 'home_sale_installments',
  'landlord_expenses', 'landlord_other_income', 'bank_transactions',
  'bank_reconciliations', 'journal_entries', 'journal_entry_lines',
  'payroll_run_lines', 'property_transfers',
  'business_invoice_payments', 'business_invoice_lines',
  'business_pos_transactions', 'business_pos_transaction_lines',
  'business_platform_fee_accruals',
]

/**
 * Tables with a money column that are deliberately NOT journaled (the
 * migrations' headers say why — 20261013100000_audit_money_tables and
 * 20261013100010_audit_background_checks_money). Each one named with its
 * reason; a new money table fails the test below until it is journaled or
 * named here.
 */
const NOT_JOURNALED: Record<string, string> = {
  ach_monitoring_log: 'a log that is itself the record',
  ach_monitoring_log_archive: 'a log that is itself the record',
  pos_price_history: 'a log that is itself the record',
  allocation_splits: 'append-only (a trigger refuses UPDATE and DELETE)',
  lease_template_conditional_fees: 'template configuration',
  property_utility_rates: 'rate configuration',
  state_application_fee_caps: 'a rate table',
  state_deposit_interest_rates: 'a rate table',
  scheduled_lease_changes: 'a change waiting to be made — the lease it makes is journaled',
  sublessee_invitations: 'an invitation (subleasing is shelved)',
  business_quote_lines: 'a quote — what is billed is copied to business_invoice_lines',
  business_recurring_invoice_lines: 'a template — what is billed is copied to business_invoice_lines',
  business_work_order_lines: 'work in progress — what is billed is copied to business_invoice_lines',
  pos_session_items: 'a register cart before the sale — pos_transaction_items is journaled',
  pos_purchase_order_items: 'an order to a supplier, not money moved',
  utility_reading_runs: 'a summary of the bills a run made — utility_bills is journaled',
  fitness_milestones: 'not money (pounds)',
  generated_routes: 'not money (miles, minutes)',
}

beforeAll(async () => {
  // The rates the allocation figures below are worked out on (the same pair
  // allocation.test.ts seeds): ACH 1.0% to the customer, card 3.25% + $0.30.
  const client = await db.connect()
  try {
    await client.query(
      `UPDATE platform_processing_rates SET effective_until = now()
        WHERE effective_until IS NULL AND effective_from < now()
          AND NOT (
            (payment_method = 'ach' AND customer_facing_flat = 0 AND customer_facing_percent = 1.0
              AND stripe_cost_flat = 0 AND stripe_cost_percent = 0.5)
            OR (payment_method = 'card' AND customer_facing_flat = 0.30 AND customer_facing_percent = 3.25
              AND stripe_cost_flat = 0.30 AND stripe_cost_percent = 2.9))
              OR (effective_until IS NULL AND effective_from < now()
                  AND (customer_facing_cap IS NOT NULL OR stripe_cost_cap IS NOT NULL))`)
    await client.query(
      `INSERT INTO platform_processing_rates (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent)
       SELECT 'ach', 0, 1.0, 0, 0.5
        WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method='ach' AND effective_until IS NULL)`)
    await client.query(
      `INSERT INTO platform_processing_rates (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent)
       SELECT 'card', 0.30, 3.25, 0.30, 2.9
        WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method='card' AND effective_until IS NULL)`)
  } finally {
    client.release()
  }
})

const num = (x: unknown) => Number(x)

/** A landlord with one property and a unit; the owner manages it unless a manager is named. */
async function park(client: PoolClient, o: { managerUserId?: string; taxRate?: number; nightly?: number } = {}) {
  const { userId: ownerUserId, landlordId } = await seedLandlord(client)
  const tenantId = await seedTenant(client)
  const propertyId = await seedProperty(client, { landlordId, ownerUserId, managedByUserId: o.managerUserId ?? ownerUserId })
  if (o.taxRate != null || o.nightly != null) {
    await client.query(`UPDATE properties SET short_term_tax_rate = $2, nightly_rate = $3 WHERE id = $1`,
      [propertyId, o.taxRate ?? 0, o.nightly ?? null])
  }
  const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
  return { ownerUserId, landlordId, tenantId, propertyId, unitId }
}

/** A rent row paid by bank through Stripe (the charge stamped, so GAM holds its money). */
async function paidRent(client: PoolClient, p: { unitId: string; tenantId: string; landlordId: string }, amount: number, pi: string) {
  const id = await seedRentPayment(client, { ...p, amount, stripePaymentIntentId: pi })
  await client.query(`UPDATE payments SET stripe_charge_id = 'ch_' || id::text WHERE id = $1`, [id])
  return id
}

async function splitOf(client: PoolClient, paymentId: string) {
  const r = await client.query(`SELECT * FROM allocation_splits WHERE payment_id = $1`, [paymentId])
  expect(r.rows).toHaveLength(1)
  return r.rows[0]
}

/** gross_held = fee withheld + supersedence + markup + PM due + manager due + owner − short_by, to the cent. */
function addsUp(s: any): void {
  const c = (x: unknown) => Math.round(num(x) * 100)
  expect(c(s.gross_held)).toBe(c(s.landlord_fee_withheld) + c(s.supersedence) + c(s.sublease_markup)
    + c(s.pm_fee_due) + c(s.manager_fee_due) + c(s.owner_share) - c(s.short_by))
}

// ── M1: the change journal ───────────────────────────────────────────────────

describe('M1: every money table keeps its history', () => {
  it('each money table has its audit trigger (AFTER UPDATE OR DELETE, audit_row_change)', async () => {
    const r = await db.query<{ t: string }>(
      `SELECT c.relname AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
        WHERE NOT g.tgisinternal AND g.tgname = 'audit_' || c.relname
          AND g.tgfoid = 'audit_row_change'::regproc
          AND (g.tgtype & 1) = 1           -- FOR EACH ROW
          AND (g.tgtype & 8) = 8           -- DELETE
          AND (g.tgtype & 16) = 16`)       // UPDATE
    const audited = new Set(r.rows.map(x => x.t))
    const missing = AUDITED_MONEY_TABLES.filter(t => !audited.has(t))
    expect(missing).toEqual([])
  })

  it('every table with a money column is journaled, or named as deliberately not', async () => {
    // 10/12 (ledger P1 review): any numeric column whose name says money —
    // a short list of exact names could not see background_checks
    // (amount_charged, platform_net), GAM's screening money.
    const r = await db.query<{ t: string }>(
      `SELECT DISTINCT c.table_name AS t
         FROM information_schema.columns c
         JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
        WHERE c.table_schema = 'public' AND tb.table_type = 'BASE TABLE' AND c.data_type = 'numeric'
          AND (c.column_name LIKE '%amount%' OR c.column_name LIKE '%net%' OR c.column_name LIKE '%fee%'
               OR c.column_name LIKE '%total%' OR c.column_name LIKE '%price%' OR c.column_name LIKE '%paid%')
          AND NOT EXISTS (SELECT 1 FROM pg_trigger g
                           WHERE g.tgrelid = ('public.' || c.table_name)::regclass
                             AND g.tgfoid IN ('audit_row_change'::regproc, 'audit_row_change_redacted'::regproc,
                                              'audit_row_change_columns'::regproc))
        ORDER BY 1`)
    expect(r.rows.map(x => x.t).filter(t => !(t in NOT_JOURNALED))).toEqual([])
    // …and nothing is named as left out that is journaled after all.
    const named = await db.query<{ t: string }>(
      `SELECT c.relname AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
        WHERE NOT g.tgisinternal AND c.relname = ANY ($1::text[])
          AND g.tgfoid IN ('audit_row_change'::regproc, 'audit_row_change_redacted'::regproc, 'audit_row_change_columns'::regproc)`,
      [Object.keys(NOT_JOURNALED)])
    expect(named.rows).toEqual([])
  })

  it("background_checks journals GAM's screening money, never the applicant's file", async () => {
    await withRollback(async (client) => {
      const { landlordId, ownerUserId } = await park(client)
      const check = (await client.query<{ id: string }>(
        `INSERT INTO background_checks (landlord_id, user_id, amount_charged, platform_net, first_name, ssn_last4)
         VALUES ($1, $2, 45, 15, 'Pat', '1234') RETURNING id`, [landlordId, ownerUserId])).rows[0].id
      // A change to the applicant's file alone writes nothing.
      await client.query(`UPDATE background_checks SET first_name = 'Patricia', ssn_last4 = '9999' WHERE id = $1`, [check])
      // GAM's share rewritten: journaled, with only the money and whose it is.
      await client.query(`UPDATE background_checks SET platform_net = 0, first_name = 'P' WHERE id = $1`, [check])
      const j = (await client.query<{ op: string; old_row: Record<string, unknown>; new_row: Record<string, unknown> }>(
        `SELECT op, old_row, new_row FROM audit_row_changes WHERE table_name = 'background_checks' AND row_id = $1`, [check])).rows
      expect(j).toHaveLength(1)
      expect(num(j[0].old_row.platform_net)).toBe(15)
      expect(num(j[0].new_row.platform_net)).toBe(0)
      for (const row of [j[0].old_row, j[0].new_row]) {
        expect(row).not.toHaveProperty('first_name')
        expect(row).not.toHaveProperty('ssn_last4')
        expect(row).not.toHaveProperty('ssn_encrypted')
        expect(row).not.toHaveProperty('date_of_birth')
      }
    })
  })

  it('a change and a removal of a money row are journaled', async () => {
    await withRollback(async (client) => {
      const { landlordId, tenantId } = await park(client)
      const rem = (await client.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method)
         VALUES ($1, $2, 100, 100, 'settled', 'check') RETURNING id`, [tenantId, landlordId])).rows[0].id
      await client.query(`UPDATE tenant_remittances SET status = 'failed' WHERE id = $1`, [rem])
      const held = (await client.query<{ id: string }>(
        `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount) VALUES ($1, 'pos_sale', $2, 5) RETURNING id`,
        [landlordId, randomUUID()])).rows[0].id
      await client.query(`DELETE FROM held_payout_items WHERE id = $1`, [held])
      const j = (await client.query<{ table_name: string; op: string; was: string }>(
        `SELECT table_name, op, old_row->>'status' AS was FROM audit_row_changes
          WHERE row_id = ANY($1::uuid[]) ORDER BY id`, [[rem, held]])).rows
      expect(j).toEqual([
        { table_name: 'tenant_remittances', op: 'UPDATE', was: 'settled' },
        { table_name: 'held_payout_items', op: 'DELETE', was: null },
      ])
    })
  })
})

// ── allocation_splits ────────────────────────────────────────────────────────

describe('allocation_splits: the split is stored as it is made', () => {
  it('a bank payment the tenant paid the fee on: all of it to the owner, the receipt named', async () => {
    await withRollback(async (client) => {
      const p = await park(client)
      await seedAllocationRule(client, { propertyId: p.propertyId, achFeePayer: 'tenant' })
      const pi = `pi_${randomUUID().slice(0, 12)}`
      const paymentId = await paidRent(client, p, 1000, pi)
      const rem = (await client.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method, stripe_payment_intent_id)
         VALUES ($1, $2, 1000, 1000, 'settled', 'ach', $3) RETURNING id`, [p.tenantId, p.landlordId, pi])).rows[0].id

      await executeRentAllocation(client, paymentId, 'ach')

      const s = await splitOf(client, paymentId)
      expect(s).toMatchObject({ landlord_id: p.landlordId, property_id: p.propertyId, remittance_id: rem, credit_use_id: null })
      expect([s.gross_held, s.landlord_fee_withheld, s.landlord_fee_uncovered, s.owner_share, s.short_by].map(num))
        .toEqual([1000, 0, 0, 1000, 0])
      addsUp(s)
      // The owner share it explains says the same.
      const owner = (await client.query(`SELECT amount FROM user_balance_ledger WHERE reference_id = $1 AND type = 'allocation_owner_share'`,
        [paymentId])).rows[0]
      expect(num(owner.amount)).toBe(num(s.owner_share))
    })
  })

  it('a landlord-paid fee and a manager fee: what was withheld and what each was paid', async () => {
    await withRollback(async (client) => {
      const manager = await seedManager(client)
      const p = await park(client, { managerUserId: manager })
      await seedAllocationRule(client, { propertyId: p.propertyId, achFeePayer: 'landlord', rentPercent: 10 })
      const paymentId = await paidRent(client, p, 1000, `pi_${randomUUID().slice(0, 12)}`)

      await executeRentAllocation(client, paymentId, 'ach')

      const s = await splitOf(client, paymentId)
      // ACH 1.0% → $10 fee the landlord covers; manager 10% of the $990 left; the owner the rest.
      expect(num(s.gross_held)).toBe(1000)
      expect(num(s.landlord_fee_withheld)).toBe(10)
      expect(num(s.landlord_fee_uncovered)).toBe(0)
      expect([num(s.manager_fee_due), num(s.manager_paid)]).toEqual([99, 99])
      expect(num(s.owner_share)).toBe(891)
      expect(num(s.short_by)).toBe(0)
      // No receipt carries this charge: none named.
      expect(s.remittance_id).toBeNull()
      addsUp(s)
    })
  })

  it('cuts bigger than what GAM holds: the shortfall is stored, not only told to an admin', async () => {
    await withRollback(async (client) => {
      const manager = await seedManager(client)
      const p = await park(client, { managerUserId: manager })
      await seedAllocationRule(client, { propertyId: p.propertyId, achFeePayer: 'tenant', rentPercent: 10, rentPercentFloor: 150 })
      const paymentId = await paidRent(client, p, 100, `pi_${randomUUID().slice(0, 12)}`)

      await executeRentAllocation(client, paymentId, 'ach')

      const s = await splitOf(client, paymentId)
      expect(num(s.gross_held)).toBe(100)
      expect([num(s.manager_fee_due), num(s.manager_paid)]).toEqual([150, 100])
      expect(num(s.owner_share)).toBe(0)
      expect(num(s.short_by)).toBe(50)
      addsUp(s)
    })
  })

  it('is never changed or removed', async () => {
    await withRollback(async (client) => {
      const p = await park(client)
      await seedAllocationRule(client, { propertyId: p.propertyId, achFeePayer: 'tenant' })
      const paymentId = await paidRent(client, p, 500, `pi_${randomUUID().slice(0, 12)}`)
      await executeRentAllocation(client, paymentId, 'ach')
      await client.query('SAVEPOINT a')
      await expect(client.query(`UPDATE allocation_splits SET owner_share = 1 WHERE payment_id = $1`, [paymentId]))
        .rejects.toThrow(/never changed or removed/)
      await client.query('ROLLBACK TO SAVEPOINT a')
      await expect(client.query(`DELETE FROM allocation_splits WHERE payment_id = $1`, [paymentId]))
        .rejects.toThrow(/never changed or removed/)
      await client.query('ROLLBACK TO SAVEPOINT a')
      expect(num((await splitOf(client, paymentId)).owner_share)).toBe(500)
    })
  })
})

// ── payments.deposit_collected_by ────────────────────────────────────────────

describe('payments.deposit_collected_by: stored once, when the deposit settles', () => {
  async function depositRow(client: PoolClient, p: Awaited<ReturnType<typeof park>>, o: { platformHeld: boolean; pi: string | null; manual: string | null }) {
    const leaseId = await seedLease(client, { unitId: p.unitId, landlordId: p.landlordId })
    return (await client.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date,
                             settled_at, platform_held, stripe_payment_intent_id, manual_method)
       VALUES ($1, $2, $3, $4, 'deposit', 500, 'settled', 'DEPOSIT', CURRENT_DATE, NOW(), $5, $6, $7) RETURNING id`,
      [p.unitId, leaseId, p.tenantId, p.landlordId, o.platformHeld, o.pi, o.manual])).rows[0].id
  }
  const collectedBy = async (client: PoolClient, id: string) =>
    (await client.query(`SELECT deposit_collected_by FROM payments WHERE id = $1`, [id])).rows[0].deposit_collected_by

  it('paid online onto GAM\'s balance: gam — and a move-out clearing platform_held does not change it', async () => {
    await withRollback(async (client) => {
      const p = await park(client)
      const id = await depositRow(client, p, { platformHeld: true, pi: 'pi_dep_online', manual: null })
      await reconcileSettledDepositPayment(id, client)
      expect(await collectedBy(client, id)).toBe('gam')
      // What a finalize does to the row afterwards (decisions #54): the live
      // definition would now read 'landlord'; the stored fact stays.
      await client.query(`UPDATE payments SET platform_held = FALSE WHERE id = $1`, [id])
      await stampDepositCollectedBy(client, [id])
      expect(await collectedBy(client, id)).toBe('gam')
    })
  })

  it('paid in cash at the desk: landlord (the manual settle stamps it)', async () => {
    await withRollback(async (client) => {
      const p = await park(client)
      const id = await depositRow(client, p, { platformHeld: false, pi: null, manual: 'cash' })
      await stampDepositCollectedBy(client, [id])
      expect(await collectedBy(client, id)).toBe('landlord')
    })
  })

  it('the values match the table\'s CHECK (one definition)', async () => {
    const def = (await db.query<{ d: string }>(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'payments_deposit_collected_by_check'`)).rows[0].d
    for (const v of DEPOSIT_COLLECTED_BY_VALUES) expect(def).toContain(`'${v}'`)
    expect(def.match(/'[a-z_]+'/g)).toHaveLength(DEPOSIT_COLLECTED_BY_VALUES.length)
  })
})

// ── held_payout_items.property_id ────────────────────────────────────────────

describe('held_payout_items.property_id: written with every line', () => {
  const lineProperty = async (client: PoolClient, sourceId: string) =>
    (await client.query(`SELECT property_id FROM held_payout_items WHERE source_id = $1`, [sourceId])).rows[0].property_id

  it('named outright, or read from the payment, sale or lease the line is about', async () => {
    await withRollback(async (client) => {
      const p = await park(client)
      const rent = await paidRent(client, p, 100, `pi_${randomUUID().slice(0, 12)}`)
      const sale = (await client.query<{ id: string }>(
        `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, total, property_id)
         VALUES ($1, $2, 'card', 10, 10, $3) RETURNING id`, [p.landlordId, p.ownerUserId, p.propertyId])).rows[0].id
      const leaseId = await seedLease(client, { unitId: p.unitId, landlordId: p.landlordId })
      const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
      await recordHeldItem({ landlordId: p.landlordId, sourceType: 'booking_deposit', sourceId: ids[0], amount: 5, property: { propertyId: p.propertyId } }, client)
      await recordHeldItem({ landlordId: p.landlordId, sourceType: 'dispute', sourceId: ids[1], amount: -5, property: { paymentId: rent } }, client)
      await recordHeldItem({ landlordId: p.landlordId, sourceType: 'pos_sale', sourceId: ids[2], amount: 5, property: { saleId: sale } }, client)
      await recordHeldItem({ landlordId: p.landlordId, sourceType: 'deposit_settlement', sourceId: ids[3], amount: 5, property: { leaseId } }, client)
      for (const s of ids) expect(await lineProperty(client, s)).toBe(p.propertyId)
    })
  })

  it('a Stripe charge: its one property for this landlord; company-level when it paid at two', async () => {
    await withRollback(async (client) => {
      const p = await park(client)
      const other = await seedProperty(client, { landlordId: p.landlordId, ownerUserId: p.ownerUserId, managedByUserId: p.ownerUserId })
      const otherUnit = await seedUnit(client, { propertyId: other, landlordId: p.landlordId })
      const secondHere = await seedUnit(client, { propertyId: p.propertyId, landlordId: p.landlordId })
      const one = `pi_${randomUUID().slice(0, 12)}`, two = `pi_${randomUUID().slice(0, 12)}`
      // One charge paying rent on two spaces of the same park: still that park.
      await paidRent(client, p, 100, one)
      await paidRent(client, { ...p, unitId: secondHere }, 100, one)
      // One charge paying at two parks: company-level.
      const third = await seedUnit(client, { propertyId: p.propertyId, landlordId: p.landlordId })
      await paidRent(client, { ...p, unitId: third }, 100, two)
      await paidRent(client, { ...p, unitId: otherUnit }, 100, two)
      await recordHeldItem({ landlordId: p.landlordId, sourceType: 'dispute', sourceId: `du_${one}`, amount: -1, property: { charge: one } }, client)
      await recordHeldItem({ landlordId: p.landlordId, sourceType: 'dispute', sourceId: `du_${two}`, amount: -1, property: { charge: two } }, client)
      expect(await lineProperty(client, `du_${one}`)).toBe(p.propertyId)
      expect(await lineProperty(client, `du_${two}`)).toBeNull()
    })
  })

  it("a rent dispute's fee line: the property the reports put it at, never company-level (10/12 review)", async () => {
    await withRollback(async (client) => {
      const p = await park(client)
      const other = await seedProperty(client, { landlordId: p.landlordId, ownerUserId: p.ownerUserId, managedByUserId: p.ownerUserId })
      const otherUnit = await seedUnit(client, { propertyId: other, landlordId: p.landlordId })
      // One charge paying $900 here and $100 at the other park.
      const pi = `pi_${randomUUID().slice(0, 12)}`
      await paidRent(client, p, 900, pi)
      await paidRent(client, { ...p, unitId: otherUnit }, 100, pi)
      const fee = `stripe_fee_kept:${pi}:${p.landlordId}`
      const back = `${fee}:returned_on_win`
      await recordHeldItem({ landlordId: p.landlordId, sourceType: 'dispute', sourceId: fee, amount: -15, property: { disputeFeeLine: fee } }, client)
      await recordHeldItem({ landlordId: p.landlordId, sourceType: 'dispute', sourceId: back, amount: 15, property: { disputeFeeLine: back } }, client)
      expect(await lineProperty(client, fee)).toBe(p.propertyId)
      expect(await lineProperty(client, back)).toBe(p.propertyId)
      // The same property Money received and the owner statement read.
      const reports = (await client.query<{ property_id: string }>(
        `SELECT fp.property_id FROM held_payout_items h CROSS JOIN LATERAL ${disputeFeePropertySql('h')} fp
          WHERE h.source_id = $1`, [fee])).rows[0]
      expect(reports.property_id).toBe(p.propertyId)
      // The backfill places a line from before 10/12 by the same rule.
      expect(await heldItemPropertyFromSource(client, { landlordId: p.landlordId, sourceId: fee, sourceType: 'dispute' }))
        .toMatchObject({ propertyId: p.propertyId })
    })
  })

  it("a business's line is company-level whatever it names", async () => {
    await withRollback(async (client) => {
      const p = await park(client)
      const biz = (await client.query<{ id: string }>(
        `INSERT INTO businesses (name, owner_user_id, business_type, email) VALUES ('Biz', $1, 'other', $2) RETURNING id`,
        [p.ownerUserId, `biz-${randomUUID()}@test.dev`])).rows[0].id
      const sid = randomUUID()
      await recordHeldItem({ businessId: biz, sourceType: 'business_pos_sale', sourceId: sid, amount: 5, property: { propertyId: p.propertyId } }, client)
      expect(await lineProperty(client, sid)).toBeNull()
    })
  })
})

// ── stay_payments.lodging_tax_amount ─────────────────────────────────────────

describe('stay_payments.lodging_tax_amount: the tax inside a booking-site deposit', () => {
  async function booking(client: PoolClient, p: Awaited<ReturnType<typeof park>>, nights: number) {
    return (await client.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, nights, lease_type, status, deposit_amount)
       VALUES ($1, $2, CURRENT_DATE + 30, CURRENT_DATE + 30 + $3::int, $3, 'nightly', 'confirmed', 99) RETURNING id`,
      [p.unitId, p.landlordId, nights])).rows[0].id
  }
  const taxOf = async (client: PoolClient, bookingId: string) =>
    (await client.query(`SELECT lodging_tax_amount FROM stay_payments WHERE booking_id = $1`, [bookingId])).rows[0].lodging_tax_amount

  it('a 3-night stay taxed at 10%: the deposit less its pre-tax share', async () => {
    await withRollback(async (client) => {
      const p = await park(client, { taxRate: 10, nightly: 100 })
      const b = await booking(client, p, 3)
      await recordSiteDeposit(client, { bookingId: b, landlordId: p.landlordId, paymentIntentId: 'pi_site_1', deposit: 99, charged: 103, gamFee: 4 })
      expect(num(await taxOf(client, b))).toBe(9)       // 99 − 90.00
    })
  })

  it('the first month of a 30+ night booking-site stay is not taxed, even a 28-night February with no monthly rate (10/12 review)', async () => {
    await withRollback(async (client) => {
      const p = await park(client, { taxRate: 10, nightly: 50 })
      await client.query(`UPDATE properties SET weekly_rate = 200, monthly_rate = NULL WHERE id = $1`, [p.propertyId])
      const b = (await client.query<{ id: string }>(
        `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, nights, lease_type, status, deposit_amount, source)
         VALUES ($1, $2, '2027-02-01', '2027-03-01', 28, 'month_to_month', 'confirmed', 800, 'public') RETURNING id`,
        [p.unitId, p.landlordId])).rows[0].id
      await recordSiteDeposit(client, { bookingId: b, landlordId: p.landlordId, paymentIntentId: 'pi_site_feb', deposit: 800, charged: 800, gamFee: 28 })
      expect(num(await taxOf(client, b))).toBe(0)
    })
  })

  it('a 30-night stay is not taxed: 0', async () => {
    await withRollback(async (client) => {
      const p = await park(client, { taxRate: 10, nightly: 100 })
      const b = await booking(client, p, 30)
      await recordSiteDeposit(client, { bookingId: b, landlordId: p.landlordId, paymentIntentId: 'pi_site_2', deposit: 500, charged: 500, gamFee: 18 })
      expect(num(await taxOf(client, b))).toBe(0)
    })
  })
})

// ── pos_refunds.tax_refunded ─────────────────────────────────────────────────

describe('pos_refunds.tax_refunded: the tax a register refund gives back', () => {
  async function sale(client: PoolClient, p: Awaited<ReturnType<typeof park>>, subtotal: number, tax: number) {
    return (await client.query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, total, property_id)
       VALUES ($1, $2, 'cash', $3, $4, $5, $6) RETURNING id`,
      [p.landlordId, p.ownerUserId, subtotal, tax, subtotal + tax, p.propertyId])).rows[0].id
  }

  it('half of a $108 sale with $8 tax gives back $4 of tax; a card fee given back is never tax', async () => {
    await withRollback(async (client) => {
      const p = await park(client)
      const t = await sale(client, p, 100, 8)
      const refundId = await recordSaleRefund(client, { saleId: t, landlordId: p.landlordId, amount: 54, method: 'cash', reason: 'half back' })
      const r = (await client.query(`SELECT tax_refunded FROM pos_refunds WHERE id = $1`, [refundId])).rows[0]
      expect(num(r.tax_refunded)).toBe(4)
      expect(await saleRefundTax(client, t, 56, 2)).toBe(4)
    })
  })

  it("a card sale's card fee handed back in cash is never tax, and no refund gives back more tax than was taken (10/12 review)", async () => {
    await withRollback(async (client) => {
      const p = await park(client)
      // subtotal 100, tax 10, the guest's card fee on top 4.40: total 114.40.
      const t = (await client.query<{ id: string }>(
        `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, surcharge, total, property_id, stripe_payment_intent_id)
         VALUES ($1, $2, 'card', 100, 10, 4.40, 114.40, $3, 'pi_sur') RETURNING id`, [p.landlordId, p.ownerUserId, p.propertyId])).rows[0].id
      const fee = await saleRefundCardFeeShare(client, t, 114.40)
      expect(fee).toBe(4.4)
      expect(await saleRefundTax(client, t, 114.40, fee)).toBe(10)
      // Half of it first, then the rest: the fee and the tax add up to the sale's, never more.
      const half = await saleRefundCardFeeShare(client, t, 57.20)
      expect(half).toBe(2.2)
      const first = await recordSaleRefund(client, { saleId: t, landlordId: p.landlordId, amount: 57.20, method: 'cash', reason: 'half', cardFeeRefunded: half })
      const rest = await saleRefundCardFeeShare(client, t, 57.20)
      const second = await recordSaleRefund(client, { saleId: t, landlordId: p.landlordId, amount: 57.20, method: 'cash', reason: 'rest', cardFeeRefunded: rest })
      const rows = (await client.query<{ fee: string; tax: string }>(
        `SELECT card_fee_refunded AS fee, tax_refunded AS tax FROM pos_refunds WHERE id = ANY($1::uuid[])`, [[first, second]])).rows
      expect(rows.reduce((a, r) => a + Math.round(num(r.fee) * 100), 0)).toBe(440)
      expect(rows.reduce((a, r) => a + Math.round(num(r.tax) * 100), 0)).toBe(1000)
      // A refund stated with no card fee can never take the tax past what was collected.
      expect(await saleRefundTax(client, t, 114.40, 0)).toBe(0)
    })
  })

  it('a sale with no tax gives back none', async () => {
    await withRollback(async (client) => {
      const p = await park(client)
      const t = await sale(client, p, 50, 0)
      const refundId = await recordSaleRefund(client, { saleId: t, landlordId: p.landlordId, amount: 50, method: 'cash', reason: 'all back' })
      expect(num((await client.query(`SELECT tax_refunded FROM pos_refunds WHERE id = $1`, [refundId])).rows[0].tax_refunded)).toBe(0)
    })
  })
})

// ── the backfill ─────────────────────────────────────────────────────────────

describe('the backfill: facts worked out for rows from before, named as worked out, never twice', () => {
  it('fills every fact, names each in ledger_derived_facts, and a second run writes nothing', async () => {
    await withRollback(async (client) => {
      const p = await park(client, { taxRate: 10, nightly: 100 })
      // An owner share booked before allocation_splits existed (no split row).
      const rent = await paidRent(client, p, 800, `pi_${randomUUID().slice(0, 12)}`)
      await client.query(
        `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, reference_id, reference_type, property_id)
         VALUES ($1, 'allocation_owner_share', 800, 800, $2, 'payment', $3)`, [p.ownerUserId, rent, p.propertyId])
      // A deposit paid online before the column existed.
      const leaseId = await seedLease(client, { unitId: p.unitId, landlordId: p.landlordId })
      const dep = (await client.query<{ id: string }>(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date,
                               settled_at, platform_held, stripe_payment_intent_id)
         VALUES ($1, $2, $3, $4, 'deposit', 300, 'settled', 'DEPOSIT', CURRENT_DATE, NOW(), TRUE, 'pi_old_dep') RETURNING id`,
        [p.unitId, leaseId, p.tenantId, p.landlordId])).rows[0].id
      // A receipt undone before undone_at existed; the bank line still carries its Undo marker.
      const rem = (await client.query<{ id: string }>(
        `INSERT INTO tenant_remittances (tenant_id, landlord_id, amount, applied_amount, status, payment_method, settled_at)
         VALUES ($1, $2, 250, 250, 'failed', 'check', NOW() - INTERVAL '2 days') RETURNING id`, [p.tenantId, p.landlordId])).rows[0].id
      const conn = (await client.query<{ id: string }>(`INSERT INTO bank_connections (landlord_id) VALUES ($1) RETURNING id`, [p.landlordId])).rows[0].id
      await client.query(
        `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, auto_settle_undo)
         VALUES ($1, $2, $3, CURRENT_DATE, 250, $4::jsonb)`,
        [conn, p.landlordId, `ext_${randomUUID()}`, JSON.stringify({
          version: 1, undone: true, undoneAt: '2026-10-01T15:00:00.000Z', undoneBy: p.ownerUserId, was: { receiptId: rem } })])
      // A register card sale's held line with no property; a refund and a void with no facts.
      const sale = (await client.query<{ id: string }>(
        `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, total, property_id)
         VALUES ($1, $2, 'card', 100, 8, 108, $3) RETURNING id`, [p.landlordId, p.ownerUserId, p.propertyId])).rows[0].id
      const held = (await client.query<{ id: string }>(
        `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount) VALUES ($1, 'pos_sale', $2, 100) RETURNING id`,
        [p.landlordId, sale])).rows[0].id
      const refund = (await client.query<{ id: string }>(
        `INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method) VALUES ($1, $2, 54, 'cash') RETURNING id`,
        [sale, p.landlordId])).rows[0].id
      const voided = (await client.query<{ id: string }>(
        `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, total, status, property_id, created_at)
         VALUES ($1, $2, 'cash', 20, 20, 'voided', $3, NOW() - INTERVAL '3 days') RETURNING id`,
        [p.landlordId, p.ownerUserId, p.propertyId])).rows[0].id
      // A booking-site deposit with no tax recorded.
      const b = (await client.query<{ id: string }>(
        `INSERT INTO unit_bookings (unit_id, landlord_id, check_in, check_out, nights, lease_type, status, deposit_amount)
         VALUES ($1, $2, CURRENT_DATE + 40, CURRENT_DATE + 43, 3, 'nightly', 'confirmed', 99) RETURNING id`,
        [p.unitId, p.landlordId])).rows[0].id
      const stay = (await client.query<{ id: string }>(
        `INSERT INTO stay_payments (booking_id, landlord_id, kind, stripe_payment_intent_id, method, toward_stay)
         VALUES ($1, $2, 'site_deposit', 'pi_site_old', 'card', 99) RETURNING id`, [b, p.landlordId])).rows[0].id

      const first = await backfillLedgerSourceFacts(client)
      expect(first.allocationSplits).toBeGreaterThanOrEqual(1)

      const s = await splitOf(client, rent)
      expect([num(s.gross_held), num(s.landlord_fee_withheld), num(s.owner_share), num(s.short_by)]).toEqual([800, 0, 800, 0])
      addsUp(s)
      expect((await client.query(`SELECT deposit_collected_by FROM payments WHERE id = $1`, [dep])).rows[0].deposit_collected_by).toBe('gam')
      const r = (await client.query(`SELECT undone_at, undone_by FROM tenant_remittances WHERE id = $1`, [rem])).rows[0]
      expect(new Date(r.undone_at).toISOString()).toBe('2026-10-01T15:00:00.000Z')
      expect(r.undone_by).toBe(p.ownerUserId)
      expect((await client.query(`SELECT property_id FROM held_payout_items WHERE id = $1`, [held])).rows[0].property_id).toBe(p.propertyId)
      expect(num((await client.query(`SELECT tax_refunded FROM pos_refunds WHERE id = $1`, [refund])).rows[0].tax_refunded)).toBe(4)
      const v = (await client.query(`SELECT voided_at = created_at AS at_sale FROM pos_transactions WHERE id = $1`, [voided])).rows[0]
      expect(v.at_sale).toBe(true)
      expect(num((await client.query(`SELECT lodging_tax_amount FROM stay_payments WHERE id = $1`, [stay])).rows[0].lodging_tax_amount)).toBe(9)

      // Every value it worked out is named as worked out.
      const named = (await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM ledger_derived_facts
          WHERE row_id = ANY($1::uuid[]) ORDER BY table_name, column_name`,
        [[s.id, dep, rem, held, refund, voided, stay]])).rows
      expect(named).toEqual([
        { table_name: 'allocation_splits', column_name: '*' },
        { table_name: 'held_payout_items', column_name: 'property_id' },
        { table_name: 'payments', column_name: 'deposit_collected_by' },
        { table_name: 'pos_refunds', column_name: 'tax_refunded' },
        { table_name: 'pos_transactions', column_name: 'voided_at' },
        { table_name: 'stay_payments', column_name: 'lodging_tax_amount' },
        { table_name: 'tenant_remittances', column_name: 'undone_at' },
        { table_name: 'tenant_remittances', column_name: 'undone_by' },
      ])

      const second = await backfillLedgerSourceFacts(client)
      expect(second).toMatchObject({
        allocationSplits: 0, depositCollectedBy: 0, remittancesUndone: 0, heldItemProperties: 0,
        stayLodgingTax: 0, refundTax: 0, salesVoidedAt: 0,
      })
    })
  })

  it('an owner share whose payment names no property gets no split, and is listed — never skipped in silence (10/12 review)', async () => {
    await withRollback(async (client) => {
      const p = await park(client)
      const orphan = (await client.query<{ id: string }>(
        `INSERT INTO payments (tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
         VALUES ($1, $2, 'rent', 300, 'settled', 'RENT', CURRENT_DATE, NOW()) RETURNING id`, [p.tenantId, p.landlordId])).rows[0].id
      await client.query(
        `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, reference_id, reference_type)
         VALUES ($1, 'allocation_owner_share', 300, 300, $2, 'payment')`, [p.ownerUserId, orphan])
      const r = await backfillLedgerSourceFacts(client)
      expect(r.allocationSplitsUnresolved).toContainEqual({ paymentId: orphan, ownerShare: '300.00' })
      expect((await client.query(`SELECT 1 FROM allocation_splits WHERE payment_id = $1`, [orphan])).rowCount).toBe(0)
    })
  })

  it('one split per payment: a second write of the same payment is never a second row (10/12 review)', async () => {
    await withRollback(async (client) => {
      const p = await park(client)
      await seedAllocationRule(client, { propertyId: p.propertyId, achFeePayer: 'tenant' })
      const paymentId = await paidRent(client, p, 400, `pi_${randomUUID().slice(0, 12)}`)
      await executeRentAllocation(client, paymentId, 'ach')
      // A second split for it — what an overlapping backfill would write — is refused by the index.
      await client.query('SAVEPOINT b')
      await expect(client.query(
        `INSERT INTO allocation_splits (payment_id, landlord_id, property_id, gross_held, owner_share)
         VALUES ($1, $2, $3, 400, 400)`, [paymentId, p.landlordId, p.propertyId])).rejects.toThrow(/allocation_splits_one_per_payment/)
      await client.query('ROLLBACK TO SAVEPOINT b')
      expect((await client.query(`SELECT 1 FROM allocation_splits WHERE payment_id = $1`, [paymentId])).rowCount).toBe(1)
    })
  })

  it('a held line is tied to its property from what its source names — a dispute record, a charge — or left alone', async () => {
    await withRollback(async (client) => {
      const p = await park(client)
      const pi = `pi_${randomUUID().slice(0, 12)}`
      const rent = await paidRent(client, p, 100, pi)
      expect(await heldItemPropertyFromSource(client, { landlordId: p.landlordId, sourceId: `owner_share_untouched:${rent}` }))
        .toMatchObject({ propertyId: p.propertyId })
      expect(await heldItemPropertyFromSource(client, { landlordId: p.landlordId, sourceId: `processing_fee:${pi}` }))
        .toMatchObject({ propertyId: p.propertyId })
      expect(await heldItemPropertyFromSource(client, { landlordId: p.landlordId, sourceId: 'cash' })).toBeNull()
    })
  })
})
