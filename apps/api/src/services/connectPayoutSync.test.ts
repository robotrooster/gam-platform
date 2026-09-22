/**
 * S652 — payouts made in Stripe show up in GAM, with the bank they went to.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { syncConnectPayouts } from './connectPayoutSync'

beforeEach(async () => { await cleanupAllSchema() })

const fakeStripe = (payouts: any[]) => ({
  payouts: { list: async () => ({ data: payouts }) },
  accounts: { retrieveExternalAccount: async () => ({ bank_name: 'WELLS FARGO BANK NA (ARIZONA)', last4: '8739' }) },
})

describe('syncConnectPayouts', () => {
  it('a payout the landlord made in Stripe becomes a row, named for its bank and company; GAM\'s own row is stamped, not duplicated', async () => {
    const c = await db.connect()
    let ll: any
    try { await c.query('BEGIN'); ll = await seedLandlord(c); await c.query('COMMIT') } finally { c.release() }
    await db.query(`UPDATE landlords SET stripe_connect_account_id='acct_test1', business_name='Mountain View RV Park Ranch LLC' WHERE id=$1`, [ll.landlordId])
    await db.query(`INSERT INTO disbursements (user_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged)
                    VALUES ($1,'catch_up',413,'processing','po_auto',NOW(),0)`, [ll.userId])
    const now = Math.floor(Date.now() / 1000)
    const r = await syncConnectPayouts(fakeStripe([
      { id: 'po_auto',   amount: 41300,  status: 'paid', created: now, arrival_date: now, destination: 'ba_1' },
      { id: 'po_manual', amount: 415489, status: 'paid', created: now - 3600, arrival_date: now, destination: 'ba_1' },
    ]) as any)
    expect(r.created).toBe(1)
    expect(r.updated).toBe(1)
    const rows = (await db.query(`SELECT stripe_payout_id, trigger_type, amount, status, bank_name, bank_last4, landlord_id FROM disbursements ORDER BY amount`)).rows
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ stripe_payout_id: 'po_auto', trigger_type: 'catch_up', status: 'settled', bank_last4: '8739', landlord_id: ll.landlordId })
    expect(rows[1]).toMatchObject({ stripe_payout_id: 'po_manual', trigger_type: 'stripe_dashboard', status: 'settled', bank_last4: '8739' })
    expect(Number(rows[1].amount)).toBeCloseTo(4154.89, 2)
    // running again changes nothing
    const again = await syncConnectPayouts(fakeStripe([
      { id: 'po_manual', amount: 415489, status: 'paid', created: now - 3600, arrival_date: now, destination: 'ba_1' },
    ]) as any)
    expect(again.created).toBe(0)
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM disbursements`)).rows[0].n).toBe(2)
  })
})
