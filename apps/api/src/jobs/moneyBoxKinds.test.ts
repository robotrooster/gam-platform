/**
 * S653 (Nic): "we need to be able to tag the money boxes as either credits or
 * debits... that's the difference between a refundable pet deposit versus a
 * non-refundable pet fee."
 *
 * The box's TAG — fee / deposit / prepaid — decides what the engine does with
 * the money, never the box's name:
 *   fee      → the landlord's money at settlement
 *   deposit  → held in trust (never paid to the landlord), returned at move-out
 *   prepaid  → held by GAM, becomes paid-ahead credit the moment it settles,
 *              drawn down by the next rent invoices
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { generateMoveInInvoice } from './moveInBundle'
import { calculateDepositReturn } from '../services/depositReturn'
import { reconcileSettledDepositPayment } from '../services/leaseFeesSync'
import { FEE_ROW_SPECS, defaultMoneyKind } from '@gam/shared'

beforeEach(async () => { await cleanupAllSchema() })

async function seedStack() {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 600, startDate: '2026-10-01' })
    await seedLeaseTenant(client, { leaseId, tenantId })
    // Three boxes on page 8, one of each kind. pet_deposit is tagged DEPOSIT,
    // pet_fee FEE, and the "Rent pre-payment" box (last_month_rent tag) PREPAID.
    const fee = async (t: string, amt: number, kind: string, desc: string) => (await client.query<{ id: string }>(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing, money_kind, description)
       VALUES ($1, $2, $3, $4, 'move_in', $5, $6) RETURNING id`,
      [leaseId, t, amt, kind !== 'fee', kind, desc])).rows[0].id
    const petDepositFee = await fee('pet_deposit', 150, 'deposit', 'Pet deposit')
    const petFeeFee = await fee('pet_fee', 75, 'fee', 'Pet fee')
    const prepaidFee = await fee('last_month_rent', 1200, 'prepaid', 'Rent pre-payment')
    await client.query('COMMIT')
    return { userId, landlordId, tenantId, propertyId, unitId, leaseId, petDepositFee, petFeeFee, prepaidFee }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

async function moveIn(s: Awaited<ReturnType<typeof seedStack>>) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await generateMoveInInvoice({
      lease_id: s.leaseId, unit_id: s.unitId, tenant_id: s.tenantId,
      landlord_id: s.landlordId, rent_amount: 600, start_date: '2026-10-01',
    } as any, client)
    await client.query('COMMIT')
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

const rowFor = async (leaseId: string, feeId: string) => (await db.query<any>(
  `SELECT id, type, amount::text, revenue_owner, entry_description, notes, status FROM payments WHERE lease_id=$1 AND lease_fee_id=$2`,
  [leaseId, feeId])).rows[0]

describe('the tag on a money box decides what the money is', () => {
  it('bills a DEPOSIT-tagged box as held money, a FEE box as the landlord\'s, a PREPAID box as GAM-held', async () => {
    const s = await seedStack()
    await moveIn(s)
    const dep = await rowFor(s.leaseId, s.petDepositFee)
    expect(dep).toMatchObject({ type: 'deposit', entry_description: 'DEPOSIT', revenue_owner: 'landlord', notes: 'Pet deposit' })
    const fee = await rowFor(s.leaseId, s.petFeeFee)
    expect(fee).toMatchObject({ type: 'fee', revenue_owner: 'landlord', notes: 'Pet fee' })
    const pre = await rowFor(s.leaseId, s.prepaidFee)
    expect(pre).toMatchObject({ type: 'fee', revenue_owner: 'held', notes: 'Rent pre-payment' })
    // and the invoice carries all three plus October's rent
    const inv = (await db.query<any>(`SELECT total_amount::text FROM invoices WHERE lease_id=$1`, [s.leaseId])).rows[0]
    expect(Number(inv.total_amount)).toBe(600 + 150 + 75 + 1200)
  })

  it('a PREPAID box becomes paid-ahead credit the moment it settles — once, whichever way it settled', async () => {
    const s = await seedStack()
    await moveIn(s)
    const pre = await rowFor(s.leaseId, s.prepaidFee)
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])).rows).toHaveLength(0)
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`, [pre.id])
    const credits = (await db.query<any>(`SELECT amount_original::text, amount_remaining::text, source_payment_id FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])).rows
    expect(credits).toHaveLength(1)
    expect(credits[0]).toMatchObject({ amount_original: '1200.00', amount_remaining: '1200.00', source_payment_id: pre.id })
    // a second settle transition (a re-run, a reversal-then-resettle) does not double it
    await db.query(`UPDATE payments SET status='pending' WHERE id=$1`, [pre.id])
    await db.query(`UPDATE payments SET status='settled' WHERE id=$1`, [pre.id])
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])).rows).toHaveLength(1)
    // a FEE box settling mints nothing
    const fee = await rowFor(s.leaseId, s.petFeeFee)
    await db.query(`UPDATE payments SET status='settled' WHERE id=$1`, [fee.id])
    expect((await db.query(`SELECT 1 FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])).rows).toHaveLength(1)
  })

  it('a DEPOSIT-tagged box comes back at move-out and never funds the security-deposit pool', async () => {
    const s = await seedStack()
    // A $500 security deposit alongside, with its own pool row.
    await db.query(`INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing, money_kind) VALUES ($1,'security_deposit',500,TRUE,'move_in','deposit')`, [s.leaseId])
    await db.query(`INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by) VALUES ($1,$2,$3,500,0,'pending','landlord')`, [s.unitId, s.leaseId, s.tenantId])
    await moveIn(s)
    const dep = await rowFor(s.leaseId, s.petDepositFee)
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`, [dep.id])
    await reconcileSettledDepositPayment(dep.id)
    const pool = (await db.query<any>(`SELECT collected_amount::text, status FROM security_deposits WHERE lease_id=$1`, [s.leaseId])).rows[0]
    expect(pool).toMatchObject({ collected_amount: '0.00', status: 'pending' })   // the pet deposit is not the security deposit

    // settle the security deposit too, then look at the return
    const sec = (await db.query<any>(`SELECT id FROM payments WHERE lease_id=$1 AND type='deposit' AND lease_fee_id IS NULL`, [s.leaseId])).rows[0]
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`, [sec.id])
    await reconcileSettledDepositPayment(sec.id)
    // everything else on the invoice paid, so nothing sweeps
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE lease_id=$1 AND status='pending'`, [s.leaseId])
    await db.query(`UPDATE leases SET status='expired', end_date='2026-12-31' WHERE id=$1`, [s.leaseId])
    const calc = (await calculateDepositReturn(s.leaseId))!
    expect(calc.total_deposit).toBe(650)          // 500 security + 150 pet deposit
    expect(calc.prepaid_credit_remaining).toBe(1200) // the unspent pre-payment is the renter's too
    expect(calc.refund_amount).toBe(650 + 1200)
  })

  it('an unpaid DEPOSIT box is not in the pool — only money that settled is held', async () => {
    const s = await seedStack()
    await moveIn(s)
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE lease_id=$1 AND lease_fee_id IS DISTINCT FROM $2`, [s.leaseId, s.petDepositFee])
    await db.query(`UPDATE leases SET status='expired', end_date='2026-12-31' WHERE id=$1`, [s.leaseId])
    const calc = (await calculateDepositReturn(s.leaseId))!
    expect(calc.total_deposit).toBe(0)
  })
})

describe('the box tag overrides the name at execution', () => {
  it('pet_deposit defaults to deposit, pet_fee to fee, the pre-payment box to prepaid — and a landlord tag wins', () => {
    expect(defaultMoneyKind('pet_deposit')).toBe('deposit')
    expect(defaultMoneyKind('pet_fee')).toBe('fee')
    expect(defaultMoneyKind('last_month_rent')).toBe('prepaid')
    const vals: any = { pet_deposit: '150', pet_fee: '75', last_month_rent: '1200' }
    expect(FEE_ROW_SPECS.pet_deposit.parse(vals)).toMatchObject({ money_kind: 'deposit', is_refundable: true })
    expect(FEE_ROW_SPECS.pet_fee.parse(vals)).toMatchObject({ money_kind: 'fee', is_refundable: false })
    // the landlord tagged the pet "deposit" as a fee they keep, and the pet fee as refundable
    expect(FEE_ROW_SPECS.pet_deposit.parse(vals, { pet_deposit: 'fee' })).toMatchObject({ money_kind: 'fee', is_refundable: false })
    expect(FEE_ROW_SPECS.pet_fee.parse(vals, { pet_fee: 'deposit' })).toMatchObject({ money_kind: 'deposit', is_refundable: true })
    expect(FEE_ROW_SPECS.last_month_rent.parse(vals, { last_month_rent: 'deposit' })).toMatchObject({ money_kind: 'deposit' })
  })
})
