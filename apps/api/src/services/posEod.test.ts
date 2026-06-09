/**
 * posEod.generateEodForAllActiveLandlords — the cron caller wrapper
 * around generateEodSettlement. Called daily at 3:30am Phoenix from
 * jobs/scheduler.ts to close yesterday's books for every landlord
 * that had POS activity. Skips landlords with zero activity to avoid
 * filling pos_eod_settlements with empty rows.
 *
 * Surfaces pinned:
 *   - DISTINCT landlord_id from pos_transactions UNION pos_refunds
 *     in the Phoenix-local day window.
 *   - Skips landlords with no activity (no settlement row written).
 *   - Refunds-only activity counts (UNION half of the active query).
 *   - Phoenix-local day boundary: txns on adjacent days don't trigger
 *     a same-landlord settlement on the wrong day.
 *   - Status defaults to 'auto_closed' (cron path passes no opts).
 *
 * The single-landlord generateEodSettlement engine has its own
 * pinned coverage via the route tests in pos.test.ts (S342). This
 * file only exercises the multi-landlord wrapper.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { generateEodForAllActiveLandlords } from './posEod'

beforeEach(async () => {
  await cleanupAllSchema()
})

interface LandlordFixture {
  landlordUserId: string
  landlordId:     string
  propertyId:     string
}

async function seedLandlordFixture(): Promise<LandlordFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    await client.query('COMMIT')
    return { landlordUserId, landlordId, propertyId }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

async function seedTxOnDay(
  f: LandlordFixture,
  isoDate: string,
  opts: { paymentMethod?: 'cash' | 'card' | 'charge'; total?: number } = {},
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO pos_transactions
       (landlord_id, cashier_id, payment_method, subtotal, tax_amount, total, status, created_at)
     VALUES ($1, $2, $3, $4, 0, $4, 'completed', ($5 || ' 12:00:00 America/Phoenix')::timestamptz)
     RETURNING id`,
    [f.landlordId, f.landlordUserId, opts.paymentMethod ?? 'cash',
     opts.total ?? 50, isoDate])
  return r.rows[0].id
}

async function seedRefundOnDay(
  f: LandlordFixture,
  isoDate: string,
  transactionId: string,
  refundMethod: 'cash' | 'check' | 'charge',
  amount: number,
): Promise<void> {
  await db.query(
    `INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method, created_at)
     VALUES ($1, $2, $3, $4, ($5 || ' 12:00:00 America/Phoenix')::timestamptz)`,
    [transactionId, f.landlordId, amount, refundMethod, isoDate])
}

describe('generateEodForAllActiveLandlords', () => {
  it('no POS activity on the day → returns empty array, no settlement rows written', async () => {
    await seedLandlordFixture()  // landlord exists but no txns/refunds
    const results = await generateEodForAllActiveLandlords('2026-05-22')
    expect(results).toEqual([])
    const rows = await db.query(`SELECT id FROM pos_eod_settlements`)
    expect(rows.rows.length).toBe(0)
  })

  it('multiple landlords with activity → DISTINCT settlement per landlord', async () => {
    const f1 = await seedLandlordFixture()
    const f2 = await seedLandlordFixture()
    const f3 = await seedLandlordFixture()
    await seedTxOnDay(f1, '2026-05-22', { paymentMethod: 'cash',   total: 100 })
    await seedTxOnDay(f2, '2026-05-22', { paymentMethod: 'card',   total: 50  })
    await seedTxOnDay(f3, '2026-05-22', { paymentMethod: 'charge', total: 75  })

    const results = await generateEodForAllActiveLandlords('2026-05-22')
    expect(results.length).toBe(3)
    const ids = results.map(r => r.landlordId).sort()
    expect(ids).toEqual([f1.landlordId, f2.landlordId, f3.landlordId].sort())
    // One settlement row per landlord
    const rows = await db.query<{ landlord_id: string }>(
      `SELECT landlord_id FROM pos_eod_settlements WHERE business_day = '2026-05-22'`)
    expect(rows.rows.length).toBe(3)
  })

  it('refunds-only activity (no txns that day) still triggers settlement (UNION)', async () => {
    const f = await seedLandlordFixture()
    // Seed a transaction on a PRIOR day, then a refund TODAY.
    // The active-landlord query UNIONs pos_refunds, so today should
    // still count even though the txn itself was yesterday.
    const txId = await seedTxOnDay(f, '2026-05-21', { paymentMethod: 'cash', total: 200 })
    await seedRefundOnDay(f, '2026-05-22', txId, 'cash', 30)

    const results = await generateEodForAllActiveLandlords('2026-05-22')
    expect(results.length).toBe(1)
    expect(results[0]!.landlordId).toBe(f.landlordId)
    expect(results[0]!.cashRefunds).toBe(30)
    // The prior-day txn is NOT in the 2026-05-22 sales totals
    expect(results[0]!.cashSales).toBe(0)
  })

  it('adjacent-day txns do not activate the landlord (Phoenix-local window)', async () => {
    const f1 = await seedLandlordFixture()
    const f2 = await seedLandlordFixture()
    // f1 has activity ON 2026-05-22; f2 has activity on 2026-05-21 only.
    await seedTxOnDay(f1, '2026-05-22', { paymentMethod: 'cash', total: 100 })
    await seedTxOnDay(f2, '2026-05-21', { paymentMethod: 'cash', total: 999 })

    const results = await generateEodForAllActiveLandlords('2026-05-22')
    expect(results.length).toBe(1)
    expect(results[0]!.landlordId).toBe(f1.landlordId)
    // f2 has no settlement row for 22nd
    const f2rows = await db.query(
      `SELECT id FROM pos_eod_settlements WHERE landlord_id = $1 AND business_day = '2026-05-22'`,
      [f2.landlordId])
    expect(f2rows.rows.length).toBe(0)
  })

  it('cron path defaults status to auto_closed (no opts passed)', async () => {
    const f = await seedLandlordFixture()
    await seedTxOnDay(f, '2026-05-22', { paymentMethod: 'cash', total: 100 })

    const results = await generateEodForAllActiveLandlords('2026-05-22')
    expect(results.length).toBe(1)
    expect(results[0]!.status).toBe('auto_closed')
    // Drawer fields stay null for cron path (no cashDrawerActual passed)
    expect(results[0]!.drawerActual).toBeNull()
    expect(results[0]!.drawerVariance).toBeNull()
  })
})
