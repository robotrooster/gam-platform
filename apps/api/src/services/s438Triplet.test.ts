/**
 * S438 services-audit triplet slice — small-helper sweep.
 *
 *   - systemFeatures.ts (37 lines): isFeatureEnabled / listFeatures /
 *     setFeatureEnabled
 *   - leaseFeesSync.ts (63 lines): syncSecurityDepositLeaseFee
 *     (DELETE-then-INSERT upsert; zero/negative amount clears row)
 *   - connectPayouts.ts (131 lines): firePayoutForConnectAccount /
 *     getConnectBalance / getAvailableUsdBalance /
 *     getInstantAvailableUsdBalance
 *
 * Three small services in one session, matching the S428 triplet cadence.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const {
  payoutsCreateMock, balanceRetrieveMock,
} = vi.hoisted(() => ({
  payoutsCreateMock:   vi.fn(async () => ({ id: 'po_mock' } as any)),
  balanceRetrieveMock: vi.fn(async () => ({
    available: [], pending: [], instant_available: [],
  } as any)),
}))

vi.mock('../lib/stripe', () => ({
  getStripe: () => ({
    payouts: { create: payoutsCreateMock },
    balance: { retrieve: balanceRetrieveMock },
  }),
}))

import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease,
} from '../test/dbHelpers'
import {
  isFeatureEnabled, listFeatures, setFeatureEnabled,
} from './systemFeatures'
import { syncSecurityDepositLeaseFee } from './leaseFeesSync'
import {
  firePayoutForConnectAccount, getConnectBalance,
  getAvailableUsdBalance, getInstantAvailableUsdBalance,
} from './connectPayouts'

beforeEach(async () => {
  await cleanupAllSchema()
  payoutsCreateMock.mockReset()
  balanceRetrieveMock.mockReset()
  payoutsCreateMock.mockResolvedValue({ id: 'po_default' } as any)
  balanceRetrieveMock.mockResolvedValue({
    available: [], pending: [], instant_available: [],
  } as any)
})

// ═════════════════════════ systemFeatures ═════════════════════════

describe('systemFeatures', () => {
  it('isFeatureEnabled: missing key → false (short-circuit, no "not found" error)', async () => {
    expect(await isFeatureEnabled('does_not_exist')).toBe(false)
  })

  it('isFeatureEnabled: enabled=FALSE → false', async () => {
    await db.query(
      `INSERT INTO system_features (key, enabled, description) VALUES ($1, FALSE, 'S438')`,
      ['feature_off'])
    expect(await isFeatureEnabled('feature_off')).toBe(false)
  })

  it('isFeatureEnabled: enabled=TRUE → true', async () => {
    await db.query(
      `INSERT INTO system_features (key, enabled, description) VALUES ($1, TRUE, 'S438')`,
      ['feature_on'])
    expect(await isFeatureEnabled('feature_on')).toBe(true)
  })

  it('listFeatures: returns rows ordered by key', async () => {
    await db.query(
      `INSERT INTO system_features (key, enabled, description) VALUES
         ('z_last', TRUE, 'z'),
         ('a_first', FALSE, 'a'),
         ('m_middle', TRUE, 'm')`)
    const rows = await listFeatures()
    expect(rows.map(r => r.key)).toEqual(['a_first', 'm_middle', 'z_last'])
  })

  it('setFeatureEnabled: flips enabled + stamps updated_by_user_id', async () => {
    await db.query(
      `INSERT INTO system_features (key, enabled, description) VALUES ('toggle_me', FALSE, 't')`)
    const c = await db.connect()
    let userId = ''
    try {
      await c.query('BEGIN')
      const { userId: uid } = await seedLandlord(c)
      userId = uid
      await c.query('COMMIT')
    } finally { c.release() }
    await setFeatureEnabled('toggle_me', true, userId)
    const { rows: [row] } = await db.query<any>(
      `SELECT enabled, updated_by_user_id FROM system_features WHERE key='toggle_me'`)
    expect(row.enabled).toBe(true)
    expect(row.updated_by_user_id).toBe(userId)
  })

  it('setFeatureEnabled: unknown key → noop (UPDATE matches 0; no throw)', async () => {
    const c = await db.connect()
    let userId = ''
    try {
      await c.query('BEGIN')
      const { userId: uid } = await seedLandlord(c)
      userId = uid
      await c.query('COMMIT')
    } finally { c.release() }
    await expect(setFeatureEnabled('never_existed', true, userId))
      .resolves.toBeUndefined()
  })
})

// ═════════════════════════ leaseFeesSync ═════════════════════════

describe('syncSecurityDepositLeaseFee', () => {
  async function seedLeaseFor(): Promise<string> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: userId, managedByUserId: userId,
      })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const leaseId = await seedLease(c, { unitId, landlordId })
      await c.query('COMMIT')
      return leaseId
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('amount > 0 → inserts security_deposit move_in row with is_refundable=TRUE', async () => {
    const leaseId = await seedLeaseFor()
    await syncSecurityDepositLeaseFee(leaseId, 1500)
    const { rows } = await db.query<any>(
      `SELECT amount, fee_type, due_timing, is_refundable, description
         FROM lease_fees WHERE lease_id=$1`, [leaseId])
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].amount)).toBe(1500)
    expect(rows[0].fee_type).toBe('security_deposit')
    expect(rows[0].due_timing).toBe('move_in')
    expect(rows[0].is_refundable).toBe(true)
    expect(rows[0].description).toBe('Security deposit')
  })

  it('amount = 0 → removes any existing security_deposit move_in row', async () => {
    const leaseId = await seedLeaseFor()
    await syncSecurityDepositLeaseFee(leaseId, 1500)
    await syncSecurityDepositLeaseFee(leaseId, 0)
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM lease_fees WHERE lease_id=$1`, [leaseId])
    expect(rows[0].n).toBe(0)
  })

  it('amount < 0 → removes any existing row (treated as "no deposit")', async () => {
    const leaseId = await seedLeaseFor()
    await syncSecurityDepositLeaseFee(leaseId, 1500)
    await syncSecurityDepositLeaseFee(leaseId, -100)
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM lease_fees WHERE lease_id=$1`, [leaseId])
    expect(rows[0].n).toBe(0)
  })

  it('amount change overwrites prior row (DELETE-then-INSERT, no duplicates)', async () => {
    const leaseId = await seedLeaseFor()
    await syncSecurityDepositLeaseFee(leaseId, 1500)
    await syncSecurityDepositLeaseFee(leaseId, 2000)
    const { rows } = await db.query<any>(
      `SELECT amount FROM lease_fees WHERE lease_id=$1`, [leaseId])
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].amount)).toBe(2000)
  })

  it('only touches security_deposit move_in rows; other lease_fees rows preserved', async () => {
    const leaseId = await seedLeaseFor()
    // Seed an unrelated lease_fee (a cleaning fee at move_out).
    await db.query(
      `INSERT INTO lease_fees (lease_id, fee_type, due_timing, amount, is_refundable)
       VALUES ($1, 'cleaning_fee', 'move_out', 200, FALSE)`, [leaseId])
    await syncSecurityDepositLeaseFee(leaseId, 1500)
    const { rows } = await db.query<any>(
      `SELECT fee_type, due_timing FROM lease_fees WHERE lease_id=$1 ORDER BY fee_type`,
      [leaseId])
    expect(rows).toHaveLength(2)
    expect(rows.find((r: any) => r.fee_type === 'cleaning_fee')).toBeDefined()
    expect(rows.find((r: any) => r.fee_type === 'security_deposit')).toBeDefined()
  })

  it('works with a transactional client arg (writes via the passed client)', async () => {
    const leaseId = await seedLeaseFor()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await syncSecurityDepositLeaseFee(leaseId, 750, client)
      // Inside the transaction, the row is visible to this client.
      const { rows } = await client.query<any>(
        `SELECT amount FROM lease_fees WHERE lease_id=$1`, [leaseId])
      expect(Number(rows[0].amount)).toBe(750)
      await client.query('ROLLBACK')
    } finally { client.release() }
    // After rollback, the row is gone — proves syncSecurityDepositLeaseFee
    // wrote through the passed client (not the global pool).
    const { rows: postRollback } = await db.query(
      `SELECT COUNT(*)::int AS n FROM lease_fees WHERE lease_id=$1`, [leaseId])
    expect(postRollback[0].n).toBe(0)
  })
})

// ═════════════════════════ connectPayouts ═════════════════════════

describe('firePayoutForConnectAccount', () => {
  it('amount ≤ 0 → 400', async () => {
    await expect(firePayoutForConnectAccount({
      connectAccountId: 'acct_test', amount: 0, idempotencyKey: 'k',
    })).rejects.toThrow(/must be positive/)
    await expect(firePayoutForConnectAccount({
      connectAccountId: 'acct_test', amount: -1, idempotencyKey: 'k',
    })).rejects.toThrow(/must be positive/)
  })

  it('missing idempotencyKey → 400', async () => {
    await expect(firePayoutForConnectAccount({
      connectAccountId: 'acct_test', amount: 100, idempotencyKey: '',
    })).rejects.toThrow(/idempotencyKey is required/)
  })

  it('happy: cents conversion + stripeAccount + idempotencyKey passed; method defaults to "standard"', async () => {
    payoutsCreateMock.mockResolvedValueOnce({ id: 'po_happy' } as any)
    const res = await firePayoutForConnectAccount({
      connectAccountId: 'acct_test', amount: 12.34,
      idempotencyKey: 'k_test_123',
    })
    expect(res.id).toBe('po_happy')
    expect(payoutsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1234,
        currency: 'usd',
        method: 'standard',
      }),
      expect.objectContaining({
        stripeAccount: 'acct_test',
        idempotencyKey: 'k_test_123',
      })
    )
  })

  it('method=instant pass-through', async () => {
    await firePayoutForConnectAccount({
      connectAccountId: 'acct_test', amount: 100,
      method: 'instant', idempotencyKey: 'k',
    })
    expect(payoutsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'instant' }),
      expect.anything()
    )
  })

  it('description + metadata included when present, omitted when absent', async () => {
    await firePayoutForConnectAccount({
      connectAccountId: 'acct_test', amount: 50, idempotencyKey: 'k',
      description: 'Test payout', metadata: { gam_kind: 'auto_friday' },
    })
    expect(payoutsCreateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        description: 'Test payout',
        metadata: { gam_kind: 'auto_friday' },
      }),
      expect.anything()
    )
    payoutsCreateMock.mockClear()
    await firePayoutForConnectAccount({
      connectAccountId: 'acct_test', amount: 50, idempotencyKey: 'k2',
    })
    const lastCall = (payoutsCreateMock.mock.calls[0] as any[])[0]
    expect(lastCall.description).toBeUndefined()
    expect(lastCall.metadata).toBeUndefined()
  })
})

describe('getConnectBalance + USD helpers', () => {
  it('getConnectBalance maps cents → dollars for all three buckets', async () => {
    balanceRetrieveMock.mockResolvedValueOnce({
      available:         [{ currency: 'usd', amount: 12345 }],
      pending:           [{ currency: 'usd', amount: 6789 }],
      instant_available: [{ currency: 'usd', amount: 1000 }],
    } as any)
    const bal = await getConnectBalance('acct_test')
    expect(bal.available[0]).toEqual({ currency: 'usd', amount: 123.45 })
    expect(bal.pending[0]).toEqual({ currency: 'usd', amount: 67.89 })
    expect(bal.instant_available[0]).toEqual({ currency: 'usd', amount: 10 })
    expect(balanceRetrieveMock).toHaveBeenCalledWith({ stripeAccount: 'acct_test' })
  })

  it('getConnectBalance: missing instant_available defaults to []', async () => {
    balanceRetrieveMock.mockResolvedValueOnce({
      available: [], pending: [],
    } as any)
    const bal = await getConnectBalance('acct_test')
    expect(bal.instant_available).toEqual([])
  })

  it('getAvailableUsdBalance: returns USD amount in dollars', async () => {
    balanceRetrieveMock.mockResolvedValueOnce({
      available: [
        { currency: 'cad', amount: 9999 },
        { currency: 'usd', amount: 5000 },
      ],
      pending: [], instant_available: [],
    } as any)
    expect(await getAvailableUsdBalance('acct_test')).toBe(50)
  })

  it('getAvailableUsdBalance: no USD bucket → 0', async () => {
    balanceRetrieveMock.mockResolvedValueOnce({
      available: [{ currency: 'cad', amount: 9999 }],
      pending: [], instant_available: [],
    } as any)
    expect(await getAvailableUsdBalance('acct_test')).toBe(0)
  })

  it('getInstantAvailableUsdBalance: returns USD instant amount in dollars', async () => {
    balanceRetrieveMock.mockResolvedValueOnce({
      available: [], pending: [],
      instant_available: [{ currency: 'usd', amount: 2500 }],
    } as any)
    expect(await getInstantAvailableUsdBalance('acct_test')).toBe(25)
  })

  it('getInstantAvailableUsdBalance: no USD bucket → 0', async () => {
    balanceRetrieveMock.mockResolvedValueOnce({
      available: [], pending: [], instant_available: [],
    } as any)
    expect(await getInstantAvailableUsdBalance('acct_test')).toBe(0)
  })
})
