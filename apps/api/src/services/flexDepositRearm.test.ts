// 10/27 (Nic) — A NEW BANK OR CARD RESTARTS A STUCK SCHEDULE.
//
//   "the other way is an automatic payment when payment method is changed at
//    all. new bank or new debit card."
//
// The usual reason a FlexDeposit installment goes 'missed' is that the account
// it pulled from stopped working, and the daily cron never looks at a missed
// row again — only 'pending' ones with a pull date. So the schedule sat stuck
// on a dead account even after the resident fixed it.
//
// What the re-arm does NOT do is charge anything, and these tests pin the
// boundaries: it must not touch a settled row, a completed plan, a voided
// deposit, a deposit already fully funded, or anybody else's installments.

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { rearmMissedFlexDepositInstallments } from './flexDeposit'
import { todayIn } from '../lib/timezone'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit, seedLease,
} from '../test/dbHelpers'

interface Built { tenantId: string; depositId: string; ids: Record<number, string> }

/**
 * A plan with installment 1 settled and installment 2 in whatever state the
 * test needs. Committed, because the service reads through the pool.
 */
async function plan(opts: {
  second: 'missed' | 'pending' | 'settled'
  planStatus?: 'active' | 'completed'
  voided?: boolean
  collected?: number
  total?: number
}): Promise<Built> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: ownerUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 1000, status: 'active' })
    const total = opts.total ?? 500
    // security_deposits_voided_is_stamped: a voided row must carry
    // status='voided', a void_reason AND a zero collected_amount, all three
    // together. Honouring it here rather than working around it — the
    // constraint is describing what a voided deposit actually is.
    const sd = await client.query<{ id: string }>(
      `INSERT INTO security_deposits
         (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by,
          flex_deposit_enabled, flex_deposit_plan_status, installment_count,
          installments_paid, installments_remaining, voided_at, void_reason)
       VALUES ($1, $2, $3, $4, $5, $8, 'gam_escrow', TRUE, $6, 2, 1, 1, $7, $9)
       RETURNING id`,
      [unitId, leaseId, tenantId, total.toFixed(2),
       opts.voided ? '0.00' : (opts.collected ?? 250).toFixed(2),
       opts.planStatus ?? 'active',
       opts.voided ? new Date().toISOString() : null,
       opts.voided ? 'voided' : 'partial',
       opts.voided ? 'test: voided deposit' : null])
    const depositId = sd.rows[0].id
    const ids: Record<number, string> = {}
    for (const [n, status] of [[1, 'settled'], [2, opts.second]] as const) {
      const r = await client.query<{ id: string }>(
        `INSERT INTO flex_deposit_installments
           (security_deposit_id, tenant_id, installment_number, installment_count,
            amount, due_date, status, attempt_count, primary_pull_date, retry_pull_date,
            defaulted_at, default_reason)
         VALUES ($1, $2, $3, 2, 250, CURRENT_DATE, $4, $5,
                 CURRENT_DATE - 30, CURRENT_DATE - 26, $6, $7)
         RETURNING id`,
        [depositId, tenantId, n, status,
         status === 'missed' ? 2 : 0,
         status === 'missed' ? new Date().toISOString() : null,
         status === 'missed' ? 'nsf' : null])
      ids[n] = r.rows[0].id
    }
    await client.query('COMMIT')
    return { tenantId, depositId, ids }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

const read = async (id: string) => (await db.query<{
  status: string; attempt_count: number; primary_pull_date: string | null;
  retry_pull_date: string | null;
  defaulted_at: string | null; default_reason: string | null
}>(
  `SELECT status, attempt_count, primary_pull_date::text, retry_pull_date::text,
          defaulted_at::text, default_reason
     FROM flex_deposit_installments WHERE id = $1`, [id])).rows[0]

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(
    `INSERT INTO system_features (key, enabled, description)
     VALUES ('flexdeposit_rollout_visible', TRUE, '10/27 re-arm test')
     ON CONFLICT (key) DO UPDATE SET enabled = TRUE`)
})

describe('re-arming a missed installment', () => {
  // 10/30 (Nic): REWRITTEN. This used to assert a pull date of today, because
  // re-arming put the row back in a daily ACH cron's path. That cron is retired
  // -- installments ride the next invoice the lease generates -- so re-arming
  // means exactly one thing now: the row is billable again, with no date on it
  // and nothing scheduled to debit a bank.
  it('makes it billable again, and schedules no bank pull at all', async () => {
    const p = await plan({ second: 'missed' })
    expect(await rearmMissedFlexDepositInstallments(p.tenantId)).toBe(1)
    const row = await read(p.ids[2])
    expect(row.status).toBe('pending')
    expect(row.attempt_count).toBe(0)
    // The whole point of the rewrite: no pull date, ever.
    expect(row.primary_pull_date).toBeNull()
    expect(row.retry_pull_date).toBeNull()
  })

  it('keeps the record that it failed, and why', async () => {
    // Re-arming is not pretending the pull never failed. The history has to
    // survive, or nobody can tell a clean plan from a repaired one.
    const p = await plan({ second: 'missed' })
    await rearmMissedFlexDepositInstallments(p.tenantId)
    const row = await read(p.ids[2])
    expect(row.defaulted_at).not.toBeNull()
    expect(row.default_reason).toBe('nsf')
  })

  it('leaves the settled installment alone', async () => {
    const p = await plan({ second: 'missed' })
    await rearmMissedFlexDepositInstallments(p.tenantId)
    expect((await read(p.ids[1])).status).toBe('settled')
  })

  it('does nothing twice — a second bank added changes nothing', async () => {
    const p = await plan({ second: 'missed' })
    expect(await rearmMissedFlexDepositInstallments(p.tenantId)).toBe(1)
    expect(await rearmMissedFlexDepositInstallments(p.tenantId)).toBe(0)
  })
})

describe('what it must never touch', () => {
  it('a plan that already completed', async () => {
    const p = await plan({ second: 'missed', planStatus: 'completed' })
    expect(await rearmMissedFlexDepositInstallments(p.tenantId)).toBe(0)
    expect((await read(p.ids[2])).status).toBe('missed')
  })

  it('a voided deposit', async () => {
    const p = await plan({ second: 'missed', voided: true })
    expect(await rearmMissedFlexDepositInstallments(p.tenantId)).toBe(0)
  })

  it('a deposit already fully funded — GAM-first routing may have paid it', async () => {
    // The installment row still says 'missed', but the money is all in. Pulling
    // again would collect a deposit twice.
    const p = await plan({ second: 'missed', collected: 500, total: 500 })
    expect(await rearmMissedFlexDepositInstallments(p.tenantId)).toBe(0)
    expect((await read(p.ids[2])).status).toBe('missed')
  })

  it('an installment that is merely pending, not missed', async () => {
    // Its pull dates are the schedule's, and moving them forward would pull
    // early. Only a dead-ended row is re-armed.
    const p = await plan({ second: 'pending' })
    expect(await rearmMissedFlexDepositInstallments(p.tenantId)).toBe(0)
    expect((await read(p.ids[2])).primary_pull_date)
      .not.toBe(todayIn(null))
  })

  it('another resident\'s installments', async () => {
    const mine = await plan({ second: 'missed' })
    const theirs = await plan({ second: 'missed' })
    expect(await rearmMissedFlexDepositInstallments(mine.tenantId)).toBe(1)
    expect((await read(theirs.ids[2])).status).toBe('missed')
  })

  it('anything at all while FlexDeposit is switched off', async () => {
    const p = await plan({ second: 'missed' })
    await db.query(`UPDATE system_features SET enabled = FALSE WHERE key = 'flexdeposit_rollout_visible'`)
    expect(await rearmMissedFlexDepositInstallments(p.tenantId)).toBe(0)
  })
})
