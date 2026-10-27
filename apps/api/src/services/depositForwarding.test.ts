/**
 * S516: cross-property FlexDeposit custody forwarding (ToS § 9.1.6).
 *
 * executeDepositPortability must, given the target lease's own S515
 * deposit row, MERGE into it (delete the untouched duplicate, re-point the
 * funded row) and apply the custody-fee rule:
 *   - fully funded by the carry-forward (same/smaller deposit) → funded +
 *     custody_fee_active = FALSE (fee dissolves)
 *   - larger deposit at the new property → status partial, custody fee stays
 *     active until the top-up is funded.
 *
 * Functions run through the pool, so seeds are committed and cleaned per test.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  detectPortabilityEligible, authorizeDepositPortability, executeDepositPortability,
} from './depositPortability'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
  seedSecurityDeposit,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

// Seed: tenant with a FUNDED gam_escrow deposit on an active lease A, plus a
// target pending lease B that already has its own (S515) pending deposit row.
async function seedForwardScenario(targetTotal: number) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: ownerUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    const tenantId = await seedTenant(c)

    const unitA = await seedUnit(c, { propertyId, landlordId, rentAmount: 1000 })
    const leaseA = await seedLease(c, { unitId: unitA, landlordId, rentAmount: 1000, status: 'active' })
    await seedLeaseTenant(c, { leaseId: leaseA, tenantId, role: 'primary' })
    const depositId = await seedSecurityDeposit(c, {
      unitId: unitA, leaseId: leaseA, tenantId,
      totalAmount: 1000, collectedAmount: 1000, heldBy: 'gam_escrow', status: 'funded',
    })
    // Make the source a fully-funded FlexDeposit (2 settled installments) so
    // a larger-deposit forward exercises the top-up installment generator.
    await c.query(
      `UPDATE security_deposits
          SET flex_deposit_enabled = TRUE, flex_deposit_plan_status = 'completed',
              installment_count = 2, installments_paid = 2, installments_remaining = 0
        WHERE id = $1`, [depositId])
    await c.query(
      `INSERT INTO flex_deposit_installments
         (security_deposit_id, tenant_id, installment_number, installment_count,
          amount, due_date, status)
       VALUES ($1,$2,1,2,500,CURRENT_DATE,'settled'),
              ($1,$2,2,2,500,CURRENT_DATE,'settled')`, [depositId, tenantId])

    const unitB = await seedUnit(c, { propertyId, landlordId, rentAmount: 1100 })
    const leaseB = await seedLease(c, { unitId: unitB, landlordId, rentAmount: 1100, status: 'pending' })
    await seedLeaseTenant(c, { leaseId: leaseB, tenantId, role: 'primary' })
    const targetDepId = await seedSecurityDeposit(c, {
      unitId: unitB, leaseId: leaseB, tenantId,
      totalAmount: targetTotal, collectedAmount: 0, heldBy: 'gam_escrow', status: 'pending',
    })

    await c.query('COMMIT')
    return { tenantId, leaseA, leaseB, depositId, targetDepId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function getRow(id: string) {
  const r = await db.query(
    `SELECT lease_id, status, held_by, portability_status, custody_fee_active,
            total_amount::text FROM security_deposits WHERE id = $1`, [id])
  return r.rows[0] ?? null
}

describe('executeDepositPortability — custody forwarding (S516)', () => {
  it('same-size deposit: merges into target, voids the duplicate (kept), dissolves the custody fee', async () => {
    const s = await seedForwardScenario(1000)
    const elig = await detectPortabilityEligible({ leaseId: s.leaseA })
    expect(elig.eligible).toBe(true)
    expect(elig.target_lease_id).toBe(s.leaseB)

    await authorizeDepositPortability({
      tenantId: s.tenantId, depositId: s.depositId,
      targetLeaseId: s.leaseB, signature: 'tenant-signed',
    })
    const res = await executeDepositPortability({ depositId: s.depositId })
    expect(res.status).toBe('carried_forward')

    // Carried row now lives on lease B, fully funded, fee dissolved.
    const carried = await getRow(s.depositId)
    expect(carried.lease_id).toBe(s.leaseB)
    expect(carried.portability_status).toBe('carried_forward')
    expect(carried.status).toBe('funded')
    expect(carried.custody_fee_active).toBe(false)

    // The target lease's own (untouched) S515 row is no longer its deposit — no
    // duplicate. 10/12 (Nic, G8 — keep everything): voided and kept, not deleted.
    expect(await getRow(s.targetDepId)).toMatchObject({ lease_id: s.leaseB, status: 'voided' })
    const live = await db.query(`SELECT id FROM security_deposits WHERE lease_id = $1 AND status <> 'voided'`, [s.leaseB])
    expect(live.rows.map(r => r.id)).toEqual([s.depositId])
  })

  it('10/12 (Nic) review, G8: a voided deposit record is never carried — authorize and execute say it is not found', async () => {
    const s = await seedForwardScenario(1000)
    await authorizeDepositPortability({ tenantId: s.tenantId, depositId: s.depositId, targetLeaseId: s.leaseB, signature: 'tenant-signed' })
    await executeDepositPortability({ depositId: s.depositId })
    expect(await getRow(s.targetDepId)).toMatchObject({ status: 'voided' })
    // The tenant's own voided record, pointed at their old lease: refused, never a 500 from the record's own guard.
    await expect(authorizeDepositPortability({ tenantId: s.tenantId, depositId: s.targetDepId, targetLeaseId: s.leaseA, signature: 'tenant-signed' }))
      .rejects.toMatchObject({ statusCode: 404 })
    await expect(executeDepositPortability({ depositId: s.targetDepId })).rejects.toMatchObject({ statusCode: 404 })
    expect(await getRow(s.targetDepId)).toMatchObject({ lease_id: s.leaseB, status: 'voided' })
  })

  it('larger deposit at the new property: stays partial, custody fee stays active', async () => {
    const s = await seedForwardScenario(1500)  // needs $500 top-up over the $1000 carried
    await authorizeDepositPortability({
      tenantId: s.tenantId, depositId: s.depositId,
      targetLeaseId: s.leaseB, signature: 'tenant-signed',
    })
    await executeDepositPortability({ depositId: s.depositId })

    const carried = await getRow(s.depositId)
    expect(carried.lease_id).toBe(s.leaseB)
    expect(Number(carried.total_amount)).toBe(1500)
    expect(carried.status).toBe('partial')
    expect(carried.custody_fee_active).toBe(true)

    // ── 10/27 (Nic): NOTHING IS CHARGED AND NOTHING IS SPLIT YET ────────────
    //
    // This used to assert that top-up installments were generated here. They
    // were — which meant a resident was put on a payment plan nobody offered
    // them, at a fee priced as if the $500 were a new deposit. There are two
    // routes now and a plan is a thing people accept, so the forward leaves the
    // deposit under-funded and the charge waits for the election.
    const topups = await db.query(
      `SELECT 1 FROM flex_deposit_installments
        WHERE security_deposit_id = $1 AND status = 'pending'`, [s.depositId])
    expect(topups.rows.length).toBe(0)
    const charges = await db.query(
      `SELECT 1 FROM payments WHERE tenant_id = $1 AND status = 'pending'`, [s.tenantId])
    expect(charges.rows.length).toBe(0)
  })

  // ── 10/27 (Nic): THE TWO ROUTES ──────────────────────────────────────────
  //
  //   "i told you two things because there are 2 routes. a route for splitting
  //    the top up into payments and a route where its collected in single
  //    payment."
  //
  // $500 owed. One pull is $500 + $25 (the $5 movement is inside the $25 —
  // "The $25 price would already have that $5 price included in it"). Split is
  // the grid's under-$1,000 price on the TOP-UP, $48 on 2 or $67 on 4, plus $5
  // beside it.
  describe('what the top-up costs each way, and what each route charges', () => {
    const forwarded = async () => {
      const s = await seedForwardScenario(1500)
      await authorizeDepositPortability({
        tenantId: s.tenantId, depositId: s.depositId,
        targetLeaseId: s.leaseB, signature: 'tenant-signed',
      })
      await executeDepositPortability({ depositId: s.depositId })
      return s
    }

    it('quotes one pull at $25 and the splits at the top-up\'s own bracket plus $5', async () => {
      const s = await forwarded()
      const { quoteFlexDepositTopUp } = await import('./flexDeposit')
      const q = (await quoteFlexDepositTopUp(s.depositId))!
      expect(q.topUpAmount).toBe(500)
      expect(q.payInFull).toEqual({ fee: 25, firstPull: 525, total: 525 })
      expect(q.splits.map(x => [x.payments, x.fee, x.movementFee, x.installment, x.total]))
        .toEqual([[2, 48, 5, 250, 553], [4, 67, 5, 125, 572]])
      // The first collection takes payment 1 and both fees.
      expect(q.splits[0].firstPull).toBe(250 + 48 + 5)
      expect(q.splits[1].firstPull).toBe(125 + 67 + 5)
    })

    it('in one pull: one deposit charge, one fee, no installments', async () => {
      const s = await forwarded()
      const { electFlexDepositTopUp } = await import('./flexDeposit')
      const c = await db.connect()
      try {
        await c.query('BEGIN')
        const r = await electFlexDepositTopUp(c, { depositId: s.depositId, route: 'in_full' })
        expect(r).toEqual({ ok: true, charged: 525, installments: 0 })
        await c.query('COMMIT')
      } finally { c.release() }
      const rows = await db.query<{ type: string; amount: string; revenue_owner: string }>(
        `SELECT type, amount::text, revenue_owner FROM payments
          WHERE tenant_id = $1 AND status = 'pending' ORDER BY type`, [s.tenantId])
      // The deposit row takes the default owner, exactly as FlexDeposit
      // installment 1 does at move-in (jobs/moveInBundle) — it is custody
      // principal that comes back at move-out. The fee is GAM's, in its own
      // row, so a deposit return can never hand it back.
      expect(rows.rows.map(r => [r.type, Number(r.amount), r.revenue_owner]))
        .toEqual([['deposit', 500, 'landlord'], ['fee', 25, 'gam']])
      const inst = await db.query(
        `SELECT 1 FROM flex_deposit_installments
          WHERE security_deposit_id = $1 AND status = 'pending'`, [s.depositId])
      expect(inst.rows.length).toBe(0)
    })

    it('split into four: four payments of $125, the $67 grid price and the $5 movement', async () => {
      const s = await forwarded()
      const { electFlexDepositTopUp } = await import('./flexDeposit')
      const c = await db.connect()
      try {
        await c.query('BEGIN')
        const r = await electFlexDepositTopUp(c, { depositId: s.depositId, route: 'split', payments: 4 })
        expect(r).toEqual({ ok: true, charged: 197, installments: 4 })
        await c.query('COMMIT')
      } finally { c.release() }
      const inst = await db.query<{ amount: string; installment_number: number }>(
        `SELECT amount::text, installment_number FROM flex_deposit_installments
          WHERE security_deposit_id = $1 AND status = 'pending'
          ORDER BY installment_number`, [s.depositId])
      expect(inst.rows.map(r => Number(r.amount))).toEqual([125, 125, 125, 125])
      // Numbered after the original (settled) schedule, so the unique
      // (deposit, number) constraint holds.
      expect(inst.rows.every(r => Number(r.installment_number) > 2)).toBe(true)
      const fees = await db.query<{ amount: string }>(
        `SELECT amount::text FROM payments
          WHERE tenant_id = $1 AND type = 'fee' AND revenue_owner = 'gam'
          ORDER BY amount::numeric`, [s.tenantId])
      expect(fees.rows.map(r => Number(r.amount))).toEqual([5, 67])
    })

    it('a payment count the product does not sell is refused', async () => {
      const s = await forwarded()
      const { electFlexDepositTopUp } = await import('./flexDeposit')
      const c = await db.connect()
      try {
        await c.query('BEGIN')
        const r = await electFlexDepositTopUp(c, { depositId: s.depositId, route: 'split', payments: 3 })
        expect(r).toMatchObject({ ok: false })
        await c.query('ROLLBACK')
      } finally { c.release() }
    })
  })
})
