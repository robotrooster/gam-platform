/**
 * S580: instant-withdrawal margin collection + circuit breaker.
 * The withdrawal route never pre-pulls GAM's margin; it records it `owed` and
 * the weekly batch collects it Connect→platform (idempotent). Repeated instant
 * failures trip a per-account circuit so withdrawals fall back to standard.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const transfersCreate  = vi.hoisted(() => vi.fn(async () => ({ id: 'tr_default' })))
const accountsRetrieve = vi.hoisted(() => vi.fn(async () => ({ id: 'acct_platform' })))
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({ transfers: { create: transfersCreate }, accounts: { retrieve: accountsRetrieve } }),
}))

import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import {
  isInstantDisabled, recordInstantFailure, recordInstantSuccess,
  recordInstantMarginOwed, collectOwedInstantMargins, INSTANT_CIRCUIT_THRESHOLD,
} from './instantWithdrawalMargin'

beforeEach(async () => {
  await cleanupAllSchema()
  transfersCreate.mockClear(); accountsRetrieve.mockClear()
  transfersCreate.mockResolvedValue({ id: 'tr_default' } as any)
})

async function seedLandlordId(): Promise<string> {
  const c = await db.connect()
  try { await c.query('BEGIN'); const { landlordId } = await seedLandlord(c); await c.query('COMMIT'); return landlordId }
  catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('circuit breaker', () => {
  it('trips after INSTANT_CIRCUIT_THRESHOLD consecutive failures; success resets', async () => {
    const acct = 'acct_cb_1'
    expect(await isInstantDisabled(acct)).toBe(false)
    for (let i = 1; i < INSTANT_CIRCUIT_THRESHOLD; i++) {
      expect((await recordInstantFailure(acct, 'boom')).disabled).toBe(false)
    }
    expect((await recordInstantFailure(acct, 'boom')).disabled).toBe(true)
    expect(await isInstantDisabled(acct)).toBe(true)
    await recordInstantSuccess(acct)
    expect(await isInstantDisabled(acct)).toBe(false)
  })
})

describe('instant margin receivable', () => {
  it('records owed, then collects it Connect→platform with a per-margin idempotency key', async () => {
    const landlordId = await seedLandlordId()
    const acct = 'acct_margin_1'
    const id = await recordInstantMarginOwed({ landlordId, connectAccountId: acct, amount: 5, disbursementId: null })
    expect(id).toBeTruthy()
    transfersCreate.mockResolvedValueOnce({ id: 'tr_collected' } as any)
    const res = await collectOwedInstantMargins(acct)
    expect(res).toMatchObject({ collected: 1, amount: 5, stillOwed: 0 })
    expect(transfersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 500, destination: 'acct_platform' }),
      expect.objectContaining({ stripeAccount: acct, idempotencyKey: `instant_margin_${id}` }),
    )
    const { rows: [m] } = await db.query<any>(`SELECT status, stripe_transfer_id FROM landlord_instant_margins WHERE id=$1`, [id])
    expect(m).toMatchObject({ status: 'collected', stripe_transfer_id: 'tr_collected' })
  })

  it('collection failure leaves the margin OWED for a future batch (never stranded, never double-collected)', async () => {
    const landlordId = await seedLandlordId()
    const acct = 'acct_margin_2'
    const id = await recordInstantMarginOwed({ landlordId, connectAccountId: acct, amount: 5, disbursementId: null })
    transfersCreate.mockRejectedValueOnce(new Error('insufficient balance'))
    const res = await collectOwedInstantMargins(acct)
    expect(res).toMatchObject({ collected: 0, stillOwed: 1 })
    const { rows: [m] } = await db.query<any>(`SELECT status, attempts FROM landlord_instant_margins WHERE id=$1`, [id])
    expect(m.status).toBe('owed')
    expect(m.attempts).toBe(1)
  })
})
