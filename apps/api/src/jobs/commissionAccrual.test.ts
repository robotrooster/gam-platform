/**
 * S567 portfolio-manager commission accrual.
 *
 * Locks the money rules (per occupied unit/month):
 *   - Closer present → closer earns BOTH halves (closing 25¢ + service 25¢);
 *     pot gets only the always-10¢.
 *   - Self-closed (no closer) → closing 25¢ → POT; service 25¢ → the assigned
 *     CS specialist (never pot); pot also gets the always-10¢.
 *   - Fully orphan (no closer, no CS) → closing 25¢ + always-10¢ → pot; the
 *     service row is SKIPPED (never pot) and the landlord is flagged; a later
 *     run fills service once a CS manager is assigned.
 *   - Vacant-only landlord accrues nothing.
 *   - Idempotent: re-running the same month never double-counts.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { processCommissionAccrual } from './commissionAccrual'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'

const MONTH = new Date(Date.UTC(2026, 6, 1)) // 2026-07-01

async function seedRep(role: 'admin' | 'super_admin' = 'admin'): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x',$2,'Rep','PM',TRUE) RETURNING id`,
    [`rep-${Math.random().toString(36).slice(2)}@test.dev`, role])
  return r.rows[0].id
}

// Landlord with N occupied (non-vacant) units + optional closer / CS manager /
// referring landlord.
async function seedLandlordWithUnits(opts: {
  occupied: number; vacant?: number; closerId?: string | null; serviceId?: string | null; referredBy?: string | null
  // S592: set the founding owner's PERSON-level upline (the accrual fallback).
  ownerUpline?: string | null
}): Promise<string> {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    await client.query(
      `UPDATE landlords SET portfolio_manager_id=$1, service_manager_id=$2, referred_by_user_id=$3 WHERE id=$4`,
      [opts.closerId ?? null, opts.serviceId ?? null, opts.referredBy ?? null, landlordId])
    if (opts.ownerUpline !== undefined) {
      await client.query(`UPDATE users SET referred_by_user_id=$1 WHERE id=$2`, [opts.ownerUpline, userId])
    }
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    for (let i = 0; i < opts.occupied; i++) {
      const u = await seedUnit(client, { propertyId, landlordId })
      await client.query(`UPDATE units SET status='active' WHERE id=$1`, [u])
    }
    for (let i = 0; i < (opts.vacant ?? 0); i++) {
      const u = await seedUnit(client, { propertyId, landlordId })
      await client.query(`UPDATE units SET status='vacant' WHERE id=$1`, [u])
    }
    return landlordId
  } finally { client.release() }
}

async function sum(where: string, params: any[] = []): Promise<number> {
  const r = await db.query<{ s: string }>(
    `SELECT COALESCE(SUM(amount),0) AS s FROM commission_accruals WHERE ${where}`, params)
  return +r.rows[0].s
}

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(`DELETE FROM commission_accruals`)
})

describe('commission accrual', () => {
  it('closer earns both halves; pot gets only the always-10¢', async () => {
    const closer = await seedRep()
    await seedLandlordWithUnits({ occupied: 2, closerId: closer })
    const res = await processCommissionAccrual(MONTH)

    // 2 units: closing 0.50 + service 0.50 to closer = 1.00; pot 0.20.
    expect(await sum('manager_id=$1 AND NOT to_pot', [closer])).toBe(1.00)
    expect(await sum('to_pot')).toBe(0.20)
    expect(res.unassignedCsLandlords).toHaveLength(0)
  })

  it('self-closed: closing 25¢ pots, service 25¢ pays the CS specialist', async () => {
    const cs = await seedRep()
    await seedLandlordWithUnits({ occupied: 4, closerId: null, serviceId: cs })
    await processCommissionAccrual(MONTH)

    // 4 units: service 1.00 → cs (never pot). Pot = closing 1.00 + always 0.40.
    expect(await sum('manager_id=$1 AND NOT to_pot', [cs])).toBe(1.00)
    expect(await sum('role=$1 AND to_pot', ['service'])).toBe(0)      // service NEVER pots
    expect(await sum('to_pot')).toBe(1.40)
  })

  it('fully orphan: closing + always pot, service skipped (never pot), flagged', async () => {
    const l = await seedLandlordWithUnits({ occupied: 3, closerId: null, serviceId: null })
    const res = await processCommissionAccrual(MONTH)

    // 3 units: closing 0.75 → pot, always 0.30 → pot = 1.05. No service row.
    expect(await sum('to_pot')).toBe(1.05)
    expect(await sum("role='service'")).toBe(0)
    expect(res.unassignedCsLandlords).toContain(l)
  })

  it('landlord referral: closing 25¢ → referring landlord, CS 25¢ → assigned PM', async () => {
    const referrer = await seedRep('admin')      // stand-in user id for the referring landlord
    const csPm = await seedRep()
    await seedLandlordWithUnits({ occupied: 4, closerId: null, serviceId: csPm, referredBy: referrer })
    await processCommissionAccrual(MONTH)

    // 4 units: closing 1.00 → referrer (NOT pot — they're the closer); service
    // 1.00 → CS PM (referrer does NOT do CS). Pot = only the always-0.40.
    expect(await sum('manager_id=$1 AND NOT to_pot', [referrer])).toBe(1.00)
    expect(await sum('manager_id=$1 AND NOT to_pot', [csPm])).toBe(1.00)
    expect(await sum('to_pot')).toBe(0.40)
  })

  it('vacant-only landlord accrues nothing', async () => {
    await seedLandlordWithUnits({ occupied: 0, vacant: 5, closerId: await seedRep() })
    const res = await processCommissionAccrual(MONTH)
    expect(await sum('1=1')).toBe(0)
    expect(res.skippedZeroOccupied).toBeGreaterThanOrEqual(1)
  })

  it('is idempotent across re-runs', async () => {
    const closer = await seedRep()
    await seedLandlordWithUnits({ occupied: 2, closerId: closer })
    await processCommissionAccrual(MONTH)
    await processCommissionAccrual(MONTH)
    await processCommissionAccrual(MONTH)
    expect(await sum('NOT to_pot')).toBe(1.00)
    expect(await sum('to_pot')).toBe(0.20)
  })

  it('fills the service row on a re-run once CS is assigned', async () => {
    const l = await seedLandlordWithUnits({ occupied: 2, closerId: null, serviceId: null })
    await processCommissionAccrual(MONTH)
    expect(await sum("role='service'")).toBe(0)

    const cs = await seedRep()
    await db.query(`UPDATE landlords SET service_manager_id=$1 WHERE id=$2`, [cs, l])
    await processCommissionAccrual(MONTH)

    expect(await sum('manager_id=$1 AND NOT to_pot', [cs])).toBe(0.50) // 2 × 0.25
    // Closing (0.50) + always (0.20) already potted on run 1; unchanged.
    expect(await sum('to_pot')).toBe(0.70)
  })

  // S592: person-level upline fallback (survives 1031/new-LLC; pays a co-owner's
  // captured primary on their own account).
  it('fallback: no entity closer but owner has a LANDLORD upline → closing pays the upline, service to the CS specialist', async () => {
    const client = await getClient()
    let upline = ''
    try { ({ userId: upline } = await seedLandlord(client)) } finally { client.release() }
    const cs = await seedRep()
    await seedLandlordWithUnits({ occupied: 2, closerId: null, referredBy: null, serviceId: cs, ownerUpline: upline })
    await processCommissionAccrual(MONTH)

    // closing 0.50 → the upline (a landlord referrer → does NOT do CS, so it did NOT pot)
    expect(await sum('manager_id=$1 AND role=$2 AND NOT to_pot', [upline, 'closing'])).toBe(0.50)
    // service 0.50 → the CS specialist
    expect(await sum('manager_id=$1 AND role=$2 AND NOT to_pot', [cs, 'service'])).toBe(0.50)
    // pot = only the always-10¢ × 2
    expect(await sum('to_pot')).toBe(0.20)
  })

  it('fallback: owner upline is a REP → closer does CS, both halves pay the rep', async () => {
    const rep = await seedRep()
    await seedLandlordWithUnits({ occupied: 2, closerId: null, referredBy: null, ownerUpline: rep })
    await processCommissionAccrual(MONTH)
    expect(await sum('manager_id=$1 AND NOT to_pot', [rep])).toBe(1.00) // both halves
    expect(await sum('to_pot')).toBe(0.20)
  })

  it('an explicit entity closer WINS over the owner person-upline', async () => {
    const explicitCloser = await seedRep()
    const client = await getClient()
    let upline = ''
    try { ({ userId: upline } = await seedLandlord(client)) } finally { client.release() }
    await seedLandlordWithUnits({ occupied: 2, closerId: explicitCloser, ownerUpline: upline })
    await processCommissionAccrual(MONTH)
    expect(await sum('manager_id=$1 AND NOT to_pot', [explicitCloser])).toBe(1.00)
    expect(await sum('manager_id=$1', [upline])).toBe(0)
  })
})
