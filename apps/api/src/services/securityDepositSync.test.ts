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
  opts: { depositMode?: 'landlord_held' | 'gam_escrow'; attachTenant?: boolean } = {},
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
  const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
  const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 1000, status: 'pending' })
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
  it('creates a pending row with held_by=landlord for a landlord_held property', async () => {
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 1200, client)
      const dep = await getDeposit(client, s.leaseId)
      expect(dep).not.toBeNull()
      expect(dep.status).toBe('pending')
      expect(dep.held_by).toBe('landlord')
      expect(Number(dep.total_amount)).toBe(1200)
      expect(Number(dep.collected_amount)).toBe(0)
    })
  })

  it('maps a gam_escrow property to held_by=gam_escrow', async () => {
    await withTx(async (client, s) => {
      await syncSecurityDepositRow(s.leaseId, 800, client)
      const dep = await getDeposit(client, s.leaseId)
      expect(dep.held_by).toBe('gam_escrow')
    }, { depositMode: 'gam_escrow' })
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
