/**
 * 10/12 (Nic, ledger P0) — migration 20261013090000's replay of every past GAM
 * charge collection, and the shared lists the P0 migrations' CHECKs mirror.
 *
 * The replay is what made production's history a record: 4 payout batches
 * ($82 + $48 + $175.50 + $6) and 1 bank pull ($54) = the $365.50 collected on
 * its 9 charges. These tests give it the same shapes — a batch that kept two
 * charges, a partial collection carried to the next batch, a pull — and the
 * double collection it must refuse to paper over.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  HELD_ITEM_SOURCES, PLATFORM_TRANSFER_PURPOSES, LANDLORD_GAM_CHARGE_VOID_REASONS,
} from '@gam/shared'
import { db } from './index'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { HELD_ITEM_SOURCES as HELD_FROM_SERVICE } from '../services/heldPayouts'

const checkValues = async (constraint: string, table: string): Promise<string[]> => {
  const def = (await db.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = $1 AND conrelid = $2::regclass`, [constraint, table])).rows[0]?.def ?? ''
  return [...def.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]).sort()
}

describe('the shared lists and the database agree (CLAUDE.md: one definition per value set)', () => {
  it('held item sources — deposit_settlement included, and the service re-exports the shared list', async () => {
    expect(await checkValues('held_payout_items_source_type_check', 'held_payout_items')).toEqual([...HELD_ITEM_SOURCES].sort())
    expect(HELD_ITEM_SOURCES).toContain('deposit_settlement')
    expect(HELD_FROM_SERVICE).toBe(HELD_ITEM_SOURCES)
  })

  it('transfer purposes', async () => {
    expect(await checkValues('platform_transfer_intents_purpose_check', 'platform_transfer_intents'))
      .toEqual([...PLATFORM_TRANSFER_PURPOSES].sort())
  })

  it('GAM charge void reasons', async () => {
    expect(await checkValues('landlord_gam_charges_void_reason_check', 'landlord_gam_charges'))
      .toEqual([...LANDLORD_GAM_CHARGE_VOID_REASONS].sort())
  })
})

describe('landlord_gam_charge_collections_backfill(): the replay of past collections', () => {
  let landlordId: string
  let userId: string

  beforeEach(async () => {
    await cleanupAllSchema()
    const c = await db.connect()
    try { ({ landlordId, userId } = await seedLandlord(c)) } finally { c.release() }
  })

  const charge = async (amount: number, collected: number, createdAt: string): Promise<string> =>
    (await db.query<{ id: string }>(
      `INSERT INTO landlord_gam_charges (landlord_id, kind, amount, collected_amount, source_type, source_id, created_at)
       VALUES ($1, 'subscription', $2, $3, 'platform_fee_accrual', gen_random_uuid(), $4) RETURNING id`,
      [landlordId, amount, collected, createdAt])).rows[0].id
  /** A payout batch that kept `kept` of GAM charges (gam_fees_kept_amount = gross − netted − amount). */
  const batch = async (kept: number, at: string): Promise<string> =>
    (await db.query<{ id: string }>(
      `INSERT INTO platform_transfer_intents
         (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, status, created_at, transferred_at)
       VALUES ($1, $2, 'acct_bf', 500, $3, 'transferred', $4, $4) RETURNING id`,
      [landlordId, userId, 500 + kept, at])).rows[0].id
  const pull = async (chargeIds: string[], total: number, at: string, status = 'succeeded'): Promise<string> =>
    (await db.query<{ id: string }>(
      `INSERT INTO landlord_gam_debits (landlord_id, charges_amount, bank_cost_amount, total_amount, status, charge_ids, created_at, settled_at)
       VALUES ($1, $2, 0, $2, $3, $4, $5, $5) RETURNING id`,
      [landlordId, total, status, chargeIds, at])).rows[0].id
  const run = async () => (await db.query<{ rows_written: number; amount_written: string }>(
    `SELECT * FROM landlord_gam_charge_collections_backfill()`)).rows[0]
  const collections = async () => (await db.query<any>(
    `SELECT charge_id, amount::text AS amount, platform_transfer_intent_id AS intent, landlord_gam_debit_id AS debit, derived
       FROM landlord_gam_charge_collections c ORDER BY c.collected_at, c.amount DESC`)).rows

  it('replays batches oldest charge first and pulls by their own charges, ties to the cent, and writes nothing twice', async () => {
    // Production's shapes: a batch keeping two charges whole ($88 + $87.50),
    // one keeping part of a charge that the next batch finishes, and a pull.
    const sept = await charge(48, 48, '2026-09-19T12:00:00Z')        // collected by the pull
    const oct = await charge(88, 88, '2026-10-01T08:00:00Z')
    const piece = await charge(87.5, 87.5, '2026-10-05T12:00:00Z')
    const nov = await charge(50, 50, '2026-10-06T12:00:00Z')         // 30 then 20
    const open = await charge(24, 0, '2026-10-07T12:00:00Z')         // never collected
    const d = await pull([sept], 48, '2026-10-01T12:00:00Z')
    const failed = await pull([oct], 88, '2026-10-02T12:00:00Z', 'failed')
    const b1 = await batch(175.5, '2026-10-05T18:00:00Z')
    const b2 = await batch(30, '2026-10-06T18:00:00Z')
    const b3 = await batch(20, '2026-10-08T18:00:00Z')

    expect(await run()).toEqual({ rows_written: 5, amount_written: '273.50' })
    expect(await collections()).toEqual([
      { charge_id: sept, amount: '48.00', intent: null, debit: d, derived: true },
      { charge_id: oct, amount: '88.00', intent: b1, debit: null, derived: true },
      { charge_id: piece, amount: '87.50', intent: b1, debit: null, derived: true },
      { charge_id: nov, amount: '30.00', intent: b2, debit: null, derived: true },
      { charge_id: nov, amount: '20.00', intent: b3, debit: null, derived: true },
    ])
    // The failed pull collected nothing; the open charge has nothing.
    expect((await collections()).some((r: any) => r.debit === failed || r.charge_id === open)).toBe(false)

    // Run again (after the code is live): nothing new, nothing doubled.
    expect(await run()).toEqual({ rows_written: 0, amount_written: '0' })
  })

  it('fills only what the code did not record itself, and leaves the code\'s rows as they are', async () => {
    const a = await charge(30, 30, '2026-10-01T08:00:00Z')
    const b = await charge(20, 20, '2026-10-01T09:00:00Z')
    const first = await batch(30, '2026-10-02T18:00:00Z')
    const second = await batch(20, '2026-10-03T18:00:00Z')
    // The new code recorded the first batch itself (not derived).
    await db.query(
      `INSERT INTO landlord_gam_charge_collections (charge_id, platform_transfer_intent_id, amount, collected_at)
       VALUES ($1, $2, 30, '2026-10-02T18:00:00Z')`, [a, first])
    expect(await run()).toEqual({ rows_written: 1, amount_written: '20.00' })
    expect(await collections()).toEqual([
      { charge_id: a, amount: '30.00', intent: first, debit: null, derived: false },
      { charge_id: b, amount: '20.00', intent: second, debit: null, derived: true },
    ])
  })

  it('refuses when a pull took money its charges no longer owed — a double collection is never papered over', async () => {
    // The 10/12 defect: a batch netted the $48 while the pull carrying it was
    // pending, then the pull settled and took the $48 again.
    const fee = await charge(48, 48, '2026-09-19T12:00:00Z')
    await batch(48, '2026-09-21T18:00:00Z')
    await pull([fee], 48, '2026-09-26T12:00:00Z')
    await expect(run()).rejects.toThrow(/bank pull .* took 48/)
    expect(await collections()).toEqual([])
  })

  it('refuses when what a charge says was collected is not what its collections add up to', async () => {
    await charge(48, 48, '2026-09-19T12:00:00Z')                    // collected by nothing on file
    await expect(run()).rejects.toThrow(/do not tie/)
  })
})
