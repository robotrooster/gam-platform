/**
 * S515: security_deposits lifecycle wiring.
 *
 * Verifies the production creation path the table never had — a deposit
 * amount set on a lease now produces a security_deposits row — plus the
 * idempotency guards (never clobber a FlexDeposit-enrolled / funded row)
 * and the settle reconcile that advances collected_amount + status.
 *
 * All tests run inside a single transaction client passed through to the
 * helpers, then roll back — no commit, fully isolated.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  syncSecurityDepositLeaseFee,
  syncSecurityDepositRow,
  reconcileSettledDepositPayment,
} from './leaseFeesSync'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import type { PoolClient } from 'pg'

beforeEach(cleanupAllSchema)

interface Stack {
  client: PoolClient
  leaseId: string
  unitId: string
  tenantId: string
  landlordId: string
  propertyId: string
}

// Build landlord → property → unit → lease → primary tenant in the caller's
// transaction. depositMode sets the property's deposit_handling_mode.
async function buildStack(
  client: PoolClient,
  opts: {
    depositMode?: 'landlord_held' | 'gam_escrow'
    attachTenant?: boolean
    leaseSource?: 'esigned' | 'imported'
    custodyState?: string
    custodyStatus?: 'supported' | 'blocked'
  } = {},
): Promise<Omit<Stack, 'client'>> {
  const { userId: ownerUserId, landlordId } = await seedLandlord(client)
  const propertyId = await seedProperty(client, {
    landlordId, ownerUserId, managedByUserId: ownerUserId,
  })
  if (opts.depositMode) {
    await client.query(
      `UPDATE properties SET deposit_handling_mode = $1 WHERE id = $2`,
      [opts.depositMode, propertyId],
    )
  }
  // S604: GAM may only take custody where the state's law permits its vehicle,
  // and the gate FAILS CLOSED — a state with no custody row resolves to
  // 'landlord'. gam_test is rebuilt from the schema dump so the catalog is
  // empty; seed the property's state as supported unless a test wants the
  // blocked path.
  const stateCode = opts.custodyState ?? 'XZ'
  await client.query(`UPDATE properties SET state = $1 WHERE id = $2`, [stateCode, propertyId])
  if (opts.custodyStatus !== 'blocked') {
    await client.query(
      `INSERT INTO state_deposit_custody_rules
         (state_code, custody_status, allows_treasury_bills, statute_citation)
       VALUES ($1, 'supported', true, 'test')
       ON CONFLICT (state_code) DO UPDATE SET custody_status='supported'`,
      [stateCode])
  }
  const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
  const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 1000, status: 'pending' })
  // S602: lease_source drives who holds the deposit (native → GAM escrow; imported → landlord).
  if (opts.leaseSource) {
    await client.query(`UPDATE leases SET lease_source = $1 WHERE id = $2`, [opts.leaseSource, leaseId])
  }
  const tenantId = await seedTenant(client)
  if (opts.attachTenant !== false) {
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
  }
  return { leaseId, unitId, tenantId, landlordId, propertyId }
}

async function getDeposit(client: PoolClient, leaseId: string) {
  const r = await client.query(
    `SELECT total_amount::text, collected_amount::text, status, held_by,
            flex_deposit_enabled
       FROM security_deposits WHERE lease_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [leaseId],
  )
  return r.rows[0] ?? null
}

async function withTx(fn: (client: PoolClient, s: Omit<Stack, 'client'>) => Promise<void>, opts?: any) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const s = await buildStack(client, opts)
    await fn(client, s)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

describe('syncSecurityDepositRow — creation', () => {
  it('new (native) lease → held_by=gam_escrow even on a landlord_held property', async () => {
    // S602: GAM holds ALL new-tenant deposits in escrow. Default property mode is
    // landlord_held; a native (non-imported) lease overrides it to gam_escrow.
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 1200, client)
      const dep = await getDeposit(client, s.leaseId)
      expect(dep).not.toBeNull()
      expect(dep.status).toBe('pending')
      expect(dep.held_by).toBe('gam_escrow')
      expect(Number(dep.total_amount)).toBe(1200)
      expect(Number(dep.collected_amount)).toBe(0)
    })
  })

  // S604 custody gate — the state's law overrides the lease-source rule.
  it('S604: a state GAM cannot custody in forces held_by=landlord, even for a NEW lease', async () => {
    // Washington requires a trust account at an institution located in WA; a
    // brokerage Treasury position does not qualify, so GAM must not take custody
    // no matter that this is a native GAM lease.
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 1200, client)
      const dep = await getDeposit(client, s.leaseId)
      expect(dep.held_by).toBe('landlord')
    }, { custodyState: 'XY', custodyStatus: 'blocked' })
  })

  // Fix pass 1 (final fix): one custody gate — the plan uses the same
  // predicate as gamMayHoldDeposits / depositCustody.canCustodyDeposits.
  it('S604: a state marked supported that does not allow the vehicle GAM uses (Treasury bills) plans the landlord, as the gate says', async () => {
    await withTx(async (client, s) => {
      await client.query(
        `INSERT INTO state_deposit_custody_rules (state_code, custody_status, allows_treasury_bills, statute_citation)
         VALUES ('XT', 'supported', false, 'test')
         ON CONFLICT (state_code) DO UPDATE SET custody_status = 'supported', allows_treasury_bills = false`)
      await client.query(`UPDATE properties SET state = 'XT' WHERE id = $1`, [s.propertyId])
      await syncSecurityDepositRow(s.leaseId, 1200, client)
      expect((await getDeposit(client, s.leaseId)).held_by).toBe('landlord')
      const { gamMayHoldDeposits } = await import('./leaseFeesSync')
      expect(await gamMayHoldDeposits(client, s.leaseId)).toBe(false)
    })
  })

  it('S604: FAILS CLOSED — an unresearched state also resolves to landlord', async () => {
    // No row in the catalog must never read as permission.
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 1200, client)
      const dep = await getDeposit(client, s.leaseId)
      expect(dep.held_by).toBe('landlord')
    }, { custodyState: 'XW', custodyStatus: 'blocked' })
  })

  it('imported lease on a landlord_held property → held_by=landlord', async () => {
    // Existing (pre-onboarding) tenant: the deposit stays in the landlord's custody.
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 1200, client)
      const dep = await getDeposit(client, s.leaseId)
      expect(dep.held_by).toBe('landlord')
    }, { leaseSource: 'imported' })
  })

  it('imported lease turned over to GAM (gam_escrow property) → held_by=gam_escrow', async () => {
    // FlexVault: the landlord turned an existing deposit over to GAM.
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 800, client)
      const dep = await getDeposit(client, s.leaseId)
      expect(dep.held_by).toBe('gam_escrow')
    }, { leaseSource: 'imported', depositMode: 'gam_escrow' })
  })

  it('skips creation when no primary tenant is attached yet', async () => {
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 1000, client)
      const dep = await getDeposit(client, s.leaseId)
      expect(dep).toBeNull()
    }, { attachTenant: false })
  })

  it('does not create a row when amount is 0', async () => {
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 0, client)
      expect(await getDeposit(client, s.leaseId)).toBeNull()
    })
  })
})

describe('syncSecurityDepositRow — idempotency / no-clobber', () => {
  it('updates total_amount on an untouched row when re-synced (no duplicate row)', async () => {
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 1000, client)
      await syncSecurityDepositRow(s.leaseId, 1500, client)
      const rows = await client.query(
        `SELECT total_amount::text FROM security_deposits WHERE lease_id = $1`, [s.leaseId])
      expect(rows.rows).toHaveLength(1)
      expect(Number(rows.rows[0].total_amount)).toBe(1500)
    })
  })

  it('does NOT clobber a FlexDeposit-enrolled row on re-sync', async () => {
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 1000, client)
      await client.query(
        `UPDATE security_deposits
            SET flex_deposit_enabled = TRUE, flex_deposit_plan_status = 'active',
                installment_count = 3
          WHERE lease_id = $1`, [s.leaseId])
      await syncSecurityDepositRow(s.leaseId, 2000, client)  // fee edited
      const dep = await getDeposit(client, s.leaseId)
      expect(dep.flex_deposit_enabled).toBe(true)
      expect(Number(dep.total_amount)).toBe(1000)  // unchanged — plan locked the schedule
    })
  })

  it('amount→0 removes an untouched row but keeps a funded one', async () => {
    await withTx(async (client, s) => {
      // untouched → removed
      await syncSecurityDepositRow(s.leaseId, 1000, client)
      await syncSecurityDepositRow(s.leaseId, 0, client)
      expect(await getDeposit(client, s.leaseId)).toBeNull()
      // recreate + mark collected → not removed
      await syncSecurityDepositRow(s.leaseId, 1000, client)
      await client.query(
        `UPDATE security_deposits SET collected_amount = 500 WHERE lease_id = $1`, [s.leaseId])
      await syncSecurityDepositRow(s.leaseId, 0, client)
      expect(await getDeposit(client, s.leaseId)).not.toBeNull()
    })
  })
})

describe('syncSecurityDepositLeaseFee — wrapper also creates the row', () => {
  it('writes both the lease_fees row and the security_deposits row', async () => {
    await withTx(async (client, s) => {
      await syncSecurityDepositLeaseFee(s.leaseId, 950, client)
      const fee = await client.query(
        `SELECT amount::text FROM lease_fees
          WHERE lease_id = $1 AND fee_type = 'security_deposit'`, [s.leaseId])
      expect(fee.rows).toHaveLength(1)
      const dep = await getDeposit(client, s.leaseId)
      expect(dep).not.toBeNull()
      expect(Number(dep.total_amount)).toBe(950)
    })
  })
})

describe('reconcileSettledDepositPayment', () => {
  it('bumps collected_amount + flips status to funded for a regular deposit', async () => {
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 1000, client)
      const pay = await client.query<{ id: string }>(
        `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id,
            type, amount, status, entry_description, due_date)
         VALUES ($1, $2, $3, $4, 'deposit', 1000, 'settled', 'DEPOSIT', CURRENT_DATE)
         RETURNING id`,
        [s.landlordId, s.tenantId, s.leaseId, s.unitId],
      )
      await reconcileSettledDepositPayment(pay.rows[0].id, client)
      const dep = await getDeposit(client, s.leaseId)
      expect(Number(dep.collected_amount)).toBe(1000)
      expect(dep.status).toBe('funded')
    })
  })

  it('skips a FlexDeposit-enrolled deposit row (its own reconcilers own collected)', async () => {
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 1000, client)
      await client.query(
        `UPDATE security_deposits SET flex_deposit_enabled = TRUE WHERE lease_id = $1`, [s.leaseId])
      const pay = await client.query<{ id: string }>(
        `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id,
            type, amount, status, entry_description, due_date)
         VALUES ($1, $2, $3, $4, 'deposit', 333, 'settled', 'DEPOSIT', CURRENT_DATE)
         RETURNING id`,
        [s.landlordId, s.tenantId, s.leaseId, s.unitId],
      )
      await reconcileSettledDepositPayment(pay.rows[0].id, client)
      const dep = await getDeposit(client, s.leaseId)
      expect(Number(dep.collected_amount)).toBe(0)  // untouched by this reconciler
    })
  })
})

// ─── 10/4 (decisions #46.3, Nic, FINAL) ──────────────────────────────────────
// "There is NO property setting for who holds deposits … the holder is decided
// by HOW THE DEPOSIT WAS COLLECTED": through GAM → GAM holds it (where the S604
// custody gate allows); in person or into the landlord's bank → the landlord.
// held_by planned at billing is only a plan — every settle sets it.
describe('decisions #46.3: who holds a deposit is set by how it was collected', () => {
  async function depositCharge(client: PoolClient, s: Omit<Stack, 'client'>, o: {
    amount: number; status?: 'pending' | 'settled'; intent?: string | null; manualMethod?: string | null
  }): Promise<string> {
    return (await client.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, tenant_id, lease_id, unit_id, type, amount, status, entry_description, due_date,
                             stripe_payment_intent_id, manual_method, platform_held, settled_at)
       VALUES ($1, $2, $3, $4, 'deposit', $5, $6, 'DEPOSIT', CURRENT_DATE, $7, $8, $9,
               CASE WHEN $6 = 'settled' THEN NOW() END)
       RETURNING id`,
      [s.landlordId, s.tenantId, s.leaseId, s.unitId, o.amount, o.status ?? 'settled', o.intent ?? null,
       o.manualMethod ?? null, !!o.intent && !o.manualMethod])).rows[0].id
  }

  it('paid through GAM where GAM may hold deposits: GAM holds it', async () => {
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 1000, client)
      expect((await getDeposit(client, s.leaseId)).held_by).toBe('gam_escrow')   // the plan
      const pay = await depositCharge(client, s, { amount: 1000, intent: 'pi_portal_deposit' })
      const r = await reconcileSettledDepositPayment(pay, client)
      expect(r).toMatchObject({ amount: 1000, priorHeldBy: 'gam_escrow', heldBy: 'gam_escrow', priorStatus: 'pending' })
      expect(await getDeposit(client, s.leaseId)).toMatchObject({ status: 'funded', held_by: 'gam_escrow' })
      expect(Number((await getDeposit(client, s.leaseId)).collected_amount)).toBe(1000)
    })
  })

  it('an imported lease planned for the landlord but paid through GAM where the custody gate allows: GAM holds it', async () => {
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 800, client)
      expect((await getDeposit(client, s.leaseId)).held_by).toBe('landlord')     // the plan
      const pay = await depositCharge(client, s, { amount: 800, intent: 'pi_imported_paid_online' })
      await reconcileSettledDepositPayment(pay, client)
      expect((await getDeposit(client, s.leaseId)).held_by).toBe('gam_escrow')
    }, { leaseSource: 'imported' })
  })

  it('paid through GAM where the custody gate does not let GAM hold deposits: the landlord holds it, as before', async () => {
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 1000, client)
      const pay = await depositCharge(client, s, { amount: 1000, intent: 'pi_blocked_state' })
      await reconcileSettledDepositPayment(pay, client)
      expect(await getDeposit(client, s.leaseId)).toMatchObject({ held_by: 'landlord', status: 'funded' })
    }, { custodyState: 'XB', custodyStatus: 'blocked' })
  })

  it('paid in cash at the desk on a lease planned for GAM: the landlord holds it, and the deposit record counts it (the desk settle records it)', async () => {
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 500, client)
      expect((await getDeposit(client, s.leaseId)).held_by).toBe('gam_escrow')   // the plan
      const charge = await depositCharge(client, s, { amount: 500, status: 'pending' })
      const { settleManualRentPayment } = await import('./manualPaymentSettle')
      const r = await settleManualRentPayment(client, {
        payment: { id: charge, landlord_id: s.landlordId, tenant_id: s.tenantId, unit_id: s.unitId, lease_id: s.leaseId,
                   due_date: new Date().toISOString().slice(0, 10) } as any,
        method: 'cash', settledAt: null, settleHousehold: true, amountTendered: 500, takenBy: null, source: 'desk',
        sendReceipt: false,
      })
      expect(r.settledPaymentIds).toEqual([charge])
      expect(r.depositRecords).toEqual([expect.objectContaining({ amount: 500, priorHeldBy: 'gam_escrow', heldBy: 'landlord' })])
      const dep = await getDeposit(client, s.leaseId)
      expect(dep).toMatchObject({ held_by: 'landlord', status: 'funded' })
      expect(Number(dep.collected_amount)).toBe(500)
    })
  })

  it('a check matched as one named charge (the bank-deposit match’s settle) is the landlord’s too', async () => {
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 500, client)
      const charge = await depositCharge(client, s, { amount: 500, status: 'pending' })
      const { settleManualRentPayment } = await import('./manualPaymentSettle')
      const r = await settleManualRentPayment(client, {
        payment: { id: charge, landlord_id: s.landlordId, tenant_id: s.tenantId, unit_id: s.unitId, lease_id: s.leaseId,
                   due_date: new Date().toISOString().slice(0, 10) } as any,
        method: 'check', settledAt: null,
      })
      expect(r.depositRecords).toEqual([expect.objectContaining({ amount: 500, heldBy: 'landlord' })])
      expect((await getDeposit(client, s.leaseId)).held_by).toBe('landlord')
    })
  })

  it('a desk payment toward a deposit GAM already holds part of: the record stays GAM’s; the desk part is told apart at move-out by its own payment', async () => {
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 1000, client)
      await reconcileSettledDepositPayment(await depositCharge(client, s, { amount: 600, intent: 'pi_first_part' }), client)
      const r = await reconcileSettledDepositPayment(await depositCharge(client, s, { amount: 400, manualMethod: 'cash' }), client)
      expect(r).toMatchObject({ amount: 400, priorHeldBy: 'gam_escrow', heldBy: 'gam_escrow' })
      const dep = await getDeposit(client, s.leaseId)
      expect(dep).toMatchObject({ held_by: 'gam_escrow', status: 'funded' })
      expect(Number(dep.collected_amount)).toBe(1000)
    })
  })

  it('a hand-made settled row with no payment facts on it keeps the planned holder', async () => {
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 1000, client)
      await reconcileSettledDepositPayment(await depositCharge(client, s, { amount: 1000 }), client)
      expect((await getDeposit(client, s.leaseId)).held_by).toBe('gam_escrow')
    })
  })
})
