/**
 * S655 money plan, Step 3 — fix round 1 (review of 10/3).
 *
 * The PM owner statement's billed block is an information block beside gross
 * (§2, E6). It read every Money billed fact for the owner's properties —
 * register sales, stays, pay links (open one-time links as still owed) and
 * other income the landlord filed — while gross on the same statement counts
 * only residents' bills and paid-ahead money. So a park with register sales
 * showed a fully paid month as billed and "collected so far" past gross. The
 * block now covers the same money gross does.
 *
 * Fix round 2 (review of 10/3): a reservation deposit's leftover moved to
 * credit ("Moved to credit") takes stay money back off — money gross never
 * counted — so the block read billed −$58.06 in a month with no bills, and the
 * bill it later paid read collected $58.06 past what any resident paid. Both
 * sides stay out now. And a leftover that goes into a move-out settlement is no
 * longer taken off gross as though it had counted when it arrived.
 *
 * Fix round 3 (review of 10/3): the landlord's report takes the leftover off in
 * the month the reservation was paid, not the month it was moved to credit.
 *
 * Its own file: ownerStatement.test.ts is being written by another step's round
 * at the same time (money plan §4: each extra writer gets its own test file).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { ownerStatement, STATEMENT_BILLED_EXCLUDES } from './ownerStatement'
import { incomeTotals } from './incomeBasis'
import { STAY_DEPOSIT_CREDIT_NOTE } from '../jobs/moveInBundle'

beforeEach(cleanupAllSchema)

async function park() {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 1000 })
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 1000 })
    await seedLeaseTenant(c, { leaseId, tenantId })
    return { userId, landlordId, propertyId, unitId, tenantId, leaseId }
  } finally { c.release() }
}

describe('the owner statement’s billed block covers the money gross counts', () => {
  it('a register sale, an open pay link and other income stay out of the billed block: a fully paid month of rent reads billed and collected equal to gross', async () => {
    const p = await park()
    // August rent, paid in cash at the desk: the manager took it directly.
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                             due_date, settled_at, manual_method, revenue_owner)
       VALUES ($1,$2,$3,$4,'rent',1000,'settled','RENT','2026-08-01','2026-08-03T10:00:00-07:00','cash','landlord')`,
      [p.unitId, p.leaseId, p.tenantId, p.landlordId])
    // A register sale on the property ($50 + $4 tax).
    await db.query(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, discount_amount, tax_amount,
                                     surcharge, total, status, property_id, created_at)
       VALUES ($1,$2,'cash',50,0,4,0,54,'completed',$3,'2026-08-12T10:00:00-07:00')`,
      [p.landlordId, p.userId, p.propertyId])
    // An open one-time pay link (still owed under Money billed).
    await db.query(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, discount_amount,
                                  tax_amount, total, customer_email, status, created_at)
       VALUES ('tok-stmt', $1, $2, $3, 'one_time', 'Propane', '[]', 40, 0, 3, 43, 'g@t.dev', 'open',
               '2026-08-14T10:00:00-07:00')`,
      [p.landlordId, p.propertyId, p.userId])
    // Laundry money the landlord filed.
    await db.query(
      `INSERT INTO landlord_other_income (landlord_id, property_id, category, amount, income_date)
       VALUES ($1,$2,'laundry',25,'2026-08-20')`, [p.landlordId, p.propertyId])

    // The landlord's own Money billed report counts all of it.
    const report = await incomeTotals({ landlordIds: [p.landlordId], start: '2026-08-01', end: '2026-08-31', basis: 'billed' })
    expect(report.total).toBe(1115)

    const s = await ownerStatement({ landlordId: p.landlordId, periodMonth: '2026-08' })
    expect(s.totals.grossCollected).toBe(1000)
    expect(s.totals.billed).toEqual({ billed: 1000, collectedSoFar: 1000, clearing: 0, stillOwed: 0 })
    expect(s.properties[0].billed).toEqual({ billed: 1000, collectedSoFar: 1000, clearing: 0, stillOwed: 0 })
    expect(s.totals.billed.collectedSoFar).toBeLessThanOrEqual(s.totals.grossCollected)
  })

  it('leaves out exactly the register-and-stays, other-income and moved-to-credit lines', () => {
    expect([...STATEMENT_BILLED_EXCLUDES].sort()).toEqual(['movedToCredit', 'otherIncome', 'registerAndStays'])
  })

  it('a reservation deposit’s leftover stays out on both sides: no negative month, and the bill it pays reads what residents paid', async () => {
    const p = await park()
    // The reservation deposit was paid in August (a stay: the statement has no
    // line for it). The lease was signed Sep 14 and $58.06 of the deposit was
    // left over after the arrival rent: moveInBundle keeps it as credit.
    const leftover = (await db.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by,
                                          received_at, created_at, note)
       VALUES ($1,$2,58.06,58.06,'reclassified','2026-08-20T10:00:00-07:00','2026-09-14T10:00:00-07:00',$3) RETURNING id`,
      [p.leaseId, p.tenantId, STAY_DEPOSIT_CREDIT_NOTE])).rows[0].id
    for (const month of ['2026-08', '2026-09']) {
      const stmt = await ownerStatement({ landlordId: p.landlordId, periodMonth: month })
      expect(stmt.totals.grossCollected).toBe(0)
      expect(stmt.totals.billed).toEqual({ billed: 0, collectedSoFar: 0, clearing: 0, stillOwed: 0 })
    }
    // The landlord's own Money billed report counts the stay, so it takes the
    // leftover back off — in August, the month the reservation was paid (its
    // received day), never as a negative September.
    expect((await incomeTotals({ landlordIds: [p.landlordId], start: '2026-08-01', end: '2026-08-31', basis: 'billed' }))
      .lines.movedToCredit).toBe(-58.06)
    expect((await incomeTotals({ landlordIds: [p.landlordId], start: '2026-09-01', end: '2026-09-30', basis: 'billed' }))
      .total).toBe(0)

    // October's $1,000 rent: $58.06 from the leftover, $941.94 in cash at the desk.
    const oct = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                             due_date, revenue_owner)
       VALUES ($1,$2,$3,$4,'rent',1000,'pending','RENT','2026-10-01','landlord') RETURNING id`,
      [p.unitId, p.leaseId, p.tenantId, p.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, held_at, applied_at)
       VALUES ($1,$2,$3,58.06,'2026-10-01','whole_bill','applied','2026-10-01T07:00:00-07:00','2026-10-01T07:00:00-07:00')`,
      [leftover, oct, p.leaseId])
    await db.query(
      `UPDATE payments SET status = 'settled', settled_at = '2026-10-03T10:00:00-07:00', manual_method = 'cash' WHERE id = $1`, [oct])
    const s = await ownerStatement({ landlordId: p.landlordId, periodMonth: '2026-10' })
    expect(s.totals.grossCollected).toBe(941.94)
    expect(s.totals.collectedDirectly).toBe(941.94)
    expect(s.totals.billed).toEqual({ billed: 941.94, collectedSoFar: 941.94, clearing: 0, stillOwed: 0 })
    expect(s.properties[0].billed).toEqual(s.totals.billed)
  })

  it('a stay-shortened credit stays in the billed block: it is rent the statement counted when it was paid', async () => {
    const p = await park()
    const nov = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                             due_date, settled_at, manual_method, revenue_owner)
       VALUES ($1,$2,$3,$4,'rent',1000,'settled','RENT','2026-11-01','2026-10-25T10:00:00-07:00','cash','landlord') RETURNING id`,
      [p.unitId, p.leaseId, p.tenantId, p.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by,
                                          received_at, created_at, source_payment_id)
       VALUES ($1,$2,400,400,'reclassified','2026-10-28T10:00:00-07:00','2026-10-28T10:00:00-07:00',$3)`,
      [p.leaseId, p.tenantId, nov])
    const s = await ownerStatement({ landlordId: p.landlordId, periodMonth: '2026-11' })
    expect(s.totals.billed).toEqual({ billed: 600, collectedSoFar: 600, clearing: 0, stillOwed: 0 })
  })
})

describe('a reservation deposit’s leftover that goes into a move-out settlement', () => {
  async function moveOut(heldBy: 'landlord' | 'gam_escrow') {
    const p = await park()
    await db.query(
      `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by)
       VALUES ($1,$2,$3,400,400,'funded',$4)`, [p.unitId, p.leaseId, p.tenantId, heldBy])
    // $58.06 of the reservation deposit was left over and never used.
    const leftover = (await db.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by,
                                          received_at, created_at, note)
       VALUES ($1,$2,58.06,58.06,'reclassified','2026-07-02T10:00:00-07:00','2026-07-10T10:00:00-07:00',$3) RETURNING id`,
      [p.leaseId, p.tenantId, STAY_DEPOSIT_CREDIT_NOTE])).rows[0].id
    // Aug 20: move-out with $100 of cleaning. The pool ($400 + $58.06) keeps $100 and refunds $358.06.
    const fin = '2026-08-20T10:00:00-07:00'
    const dr = (await db.query<{ id: string }>(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines,
                                    other_deductions, unpaid_balance_amount, total_deductions, gap_amount,
                                    status, finalized_at)
       VALUES ($1,$2,$3,400,100,'[]','[]',0,100,0,'sent_refund',$4) RETURNING id`,
      [p.leaseId, p.tenantId, p.landlordId, fin])).rows[0].id
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, deposit_return_id, lease_id, amount, billing_month, source, status, held_at, applied_at)
       VALUES ($1,$2,$3,58.06,'2026-08-01','move_out','applied',$4::timestamptz,$4::timestamptz)`,
      [leftover, dr, p.leaseId, fin])
    return p
  }

  it('the manager held the deposit: the $100 kept counts in full, collected directly — the leftover never counted, so it is not taken off', async () => {
    const p = await moveOut('landlord')
    const aug = await ownerStatement({ landlordId: p.landlordId, periodMonth: '2026-08' })
    expect(aug.totals.grossCollected).toBe(100)
    expect(aug.totals.collectedDirectly).toBe(100)
    expect(aug.totals.collectedThroughGam).toBe(0)
  })

  it('GAM held the deposit in escrow: GAM pays out $41.94 (the manager already holds the $58.06), and gross is still the $100 kept', async () => {
    const p = await moveOut('gam_escrow')
    const aug = await ownerStatement({ landlordId: p.landlordId, periodMonth: '2026-08' })
    expect(aug.totals.collectedThroughGam).toBe(41.94)
    expect(aug.totals.collectedDirectly).toBe(58.06)
    expect(aug.totals.grossCollected).toBe(100)
  })
})
