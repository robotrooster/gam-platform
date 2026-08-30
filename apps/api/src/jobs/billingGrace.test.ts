/**
 * S600 — no-double-bill onboarding grace.
 *
 * Covers the three touch points of the landlord billing-activation gate:
 *   1. platformFeeAccrual gate — a landlord in grace (billing_starts_at NULL)
 *      or not-yet-started (billing_starts_at in a future cycle) is NOT billed,
 *      even with an occupied unit; a live landlord IS billed.
 *   2. activateBillingForSettledRent — first settled rent flips a NULL landlord
 *      to the current cycle; already-live landlords are untouched (idempotent).
 *   3. applyBillingGraceCaps — flips a NULL landlord to billing once the cap
 *      cycle arrives (explicit billing_grace_until, or the created_at+2mo
 *      fallback); leaves a landlord whose cap is still in the future alone.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { processPlatformFeeAccrual, applyBillingGraceCaps } from './platformFeeAccrual'
import { activateBillingForSettledRent } from '../services/billingActivation'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant,
  seedProperty, seedUnit,
  seedLease, seedLeaseTenant,
  seedRentPayment,
} from '../test/dbHelpers'

beforeEach(async () => {
  await cleanupAllSchema()
  await db.query(`DELETE FROM platform_fee_config`)
  await db.query(`DELETE FROM landlord_platform_fee_overrides`)
  await db.query(
    `INSERT INTO platform_fee_config (rate_per_unit, min_per_connect_account, notes)
     VALUES (2.00, 10.00, 'Test default')`
  )
})

// One landlord + property + one active, occupied (leased) unit — the property
// that WOULD accrue the platform fee if the landlord is live.
async function buildOccupiedStack(): Promise<{ landlordId: string; unitId: string; tenantId: string }> {
  const client = await getClient()
  try {
    const { userId: ownerUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId, managedByUserId: ownerUserId,
    })
    await client.query(
      `INSERT INTO property_allocation_rules
         (property_id, ach_fee_payer, card_fee_payer, platform_fee_payer)
       VALUES ($1, 'tenant', 'tenant', 'landlord')`,
      [propertyId]
    )
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
    await client.query(`UPDATE units SET status='active' WHERE id=$1`, [unitId])
    const leaseId = await seedLease(client, {
      unitId, landlordId, rentAmount: 1000, status: 'active', startDate: '2026-01-01',
    })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    return { landlordId, unitId, tenantId }
  } finally {
    client.release()
  }
}

async function setBilling(landlordId: string, startsAtSql: string | null, graceUntilSql?: string | null) {
  await db.query(
    `UPDATE landlords
        SET billing_starts_at  = ${startsAtSql === null ? 'NULL' : startsAtSql},
            billing_grace_until = ${graceUntilSql === undefined ? 'billing_grace_until' : (graceUntilSql === null ? 'NULL' : graceUntilSql)}
      WHERE id = $1`,
    [landlordId]
  )
}

async function accrualRowCount(landlordId: string): Promise<number> {
  const r = await db.query(`SELECT 1 FROM platform_fee_accruals WHERE landlord_id=$1`, [landlordId])
  return r.rowCount ?? 0
}

describe('S600 platform-fee accrual gate', () => {
  it('does NOT bill a landlord in grace (billing_starts_at NULL), even with an occupied unit', async () => {
    const { landlordId } = await buildOccupiedStack()
    await setBilling(landlordId, null)

    const result = await processPlatformFeeAccrual()

    expect(result.feesAccrued).toBe(0)
    expect(result.skippedPreBilling).toBe(1)
    expect(await accrualRowCount(landlordId)).toBe(0)
  })

  it('bills a live landlord (billing_starts_at = this cycle)', async () => {
    const { landlordId } = await buildOccupiedStack()
    // seedLandlord already sets billing_starts_at = this month; be explicit.
    await setBilling(landlordId, `date_trunc('month', now())::date`)

    const result = await processPlatformFeeAccrual()

    expect(result.feesAccrued).toBe(1)
    expect(result.skippedPreBilling).toBe(0)
    expect(await accrualRowCount(landlordId)).toBe(1)
  })

  it('does NOT bill this cycle when billing_starts_at is a future cycle', async () => {
    const { landlordId } = await buildOccupiedStack()
    await setBilling(landlordId, `(date_trunc('month', now()) + INTERVAL '1 month')::date`)

    const result = await processPlatformFeeAccrual()

    expect(result.feesAccrued).toBe(0)
    expect(result.skippedPreBilling).toBe(1)
    expect(await accrualRowCount(landlordId)).toBe(0)
  })
})

describe('S600 activateBillingForSettledRent', () => {
  it('flips a landlord in grace to the current cycle on first settled rent', async () => {
    const { landlordId, unitId, tenantId } = await buildOccupiedStack()
    await setBilling(landlordId, null)

    const client = await getClient()
    try {
      const paymentId = await seedRentPayment(client, {
        unitId, tenantId, landlordId, amount: 1000, status: 'settled',
      })
      const n = await activateBillingForSettledRent(client, [paymentId])
      expect(n).toBe(1)
    } finally {
      client.release()
    }

    const r = await db.query<{ ok: boolean }>(
      `SELECT (billing_starts_at = date_trunc('month', now())::date) AS ok FROM landlords WHERE id=$1`,
      [landlordId]
    )
    expect(r.rows[0].ok).toBe(true)
  })

  it('leaves an already-live landlord untouched (idempotent)', async () => {
    const { landlordId, unitId, tenantId } = await buildOccupiedStack()
    // Live since two months ago — activation must NOT move it.
    await setBilling(landlordId, `(date_trunc('month', now()) - INTERVAL '2 months')::date`)
    const client = await getClient()
    try {
      const paymentId = await seedRentPayment(client, { unitId, tenantId, landlordId, amount: 1000, status: 'settled' })
      const n = await activateBillingForSettledRent(client, [paymentId])
      expect(n).toBe(0)
    } finally {
      client.release()
    }
    const r = await db.query<{ unchanged: boolean }>(
      `SELECT (billing_starts_at = (date_trunc('month', now()) - INTERVAL '2 months')::date) AS unchanged
         FROM landlords WHERE id=$1`,
      [landlordId]
    )
    expect(r.rows[0].unchanged).toBe(true)
  })

  it('is a no-op with no rent payment ids', async () => {
    const client = await getClient()
    try {
      expect(await activateBillingForSettledRent(client, [])).toBe(0)
    } finally {
      client.release()
    }
  })
})

describe('S600 applyBillingGraceCaps', () => {
  it('flips a landlord to billing once the explicit grace cap arrives', async () => {
    const client = await getClient()
    let landlordId: string
    try {
      ;({ landlordId } = await seedLandlord(client))
    } finally { client.release() }
    // In grace, cap = last month (already arrived).
    await setBilling(landlordId!, null, `(date_trunc('month', now()) - INTERVAL '1 month')::date`)

    const flipped = await applyBillingGraceCaps()
    expect(flipped).toBeGreaterThanOrEqual(1)

    const r = await db.query<{ ok: boolean }>(
      `SELECT (billing_starts_at = (date_trunc('month', now()) - INTERVAL '1 month')::date) AS ok
         FROM landlords WHERE id=$1`,
      [landlordId!]
    )
    expect(r.rows[0].ok).toBe(true)
  })

  it('does NOT flip a landlord whose grace cap is still in the future', async () => {
    const client = await getClient()
    let landlordId: string
    try {
      ;({ landlordId } = await seedLandlord(client))
    } finally { client.release() }
    await setBilling(landlordId!, null, `(date_trunc('month', now()) + INTERVAL '1 month')::date`)

    await applyBillingGraceCaps()

    const r = await db.query<{ still_null: boolean }>(
      `SELECT (billing_starts_at IS NULL) AS still_null FROM landlords WHERE id=$1`, [landlordId!]
    )
    expect(r.rows[0].still_null).toBe(true)
  })

  it('falls back to created_at + 2 cycles when billing_grace_until is NULL', async () => {
    const client = await getClient()
    let landlordId: string
    try {
      ;({ landlordId } = await seedLandlord(client))
    } finally { client.release() }
    // NULL start + NULL grace, created 3 months ago → cap (created+2mo) has passed.
    await db.query(
      `UPDATE landlords
          SET billing_starts_at = NULL, billing_grace_until = NULL,
              created_at = now() - INTERVAL '3 months'
        WHERE id=$1`, [landlordId!]
    )

    await applyBillingGraceCaps()

    const r = await db.query<{ started: boolean }>(
      `SELECT (billing_starts_at IS NOT NULL
               AND billing_starts_at <= date_trunc('month', now())::date) AS started
         FROM landlords WHERE id=$1`, [landlordId!]
    )
    expect(r.rows[0].started).toBe(true)
  })
})
