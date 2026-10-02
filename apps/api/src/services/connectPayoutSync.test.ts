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

// S655: a payout made in Stripe sweeps the same balance GAM's transfers fill,
// so it carries the transfers that landed before it — and Stripe lists newest
// first, so filing order matters.
describe('payouts filed from Stripe record what they carried', () => {
  async function landlordWithAccount(account: string) {
    const c = await db.connect()
    let ll: any
    try { await c.query('BEGIN'); ll = await seedLandlord(c); await c.query('COMMIT') } finally { c.release() }
    await db.query(`UPDATE landlords SET stripe_connect_account_id=$2 WHERE id=$1`, [ll.landlordId, account])
    return ll
  }
  const transfer = async (ll: any, account: string, amount: number, landedSecondsAgo: number) => (await db.query(
    `INSERT INTO platform_transfer_intents
       (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, status, stripe_transfer_id, transferred_at)
     VALUES ($1,$2,$3,$4,$4,'transferred',$5, NOW() - ($6::int * interval '1 second')) RETURNING id`,
    [ll.landlordId, ll.userId, account, amount, `tr_${landedSecondsAgo}`, landedSecondsAgo])).rows[0].id
  const carriedBy = async (intentId: string) => (await db.query(
    `SELECT d.stripe_payout_id FROM platform_transfer_intents i LEFT JOIN disbursements d ON d.id = i.disbursement_id WHERE i.id=$1`,
    [intentId])).rows[0].stripe_payout_id

  it('each payout takes the transfers waiting before it, oldest payout first', async () => {
    const ll = await landlordWithAccount('acct_dash')
    const now = Math.floor(Date.now() / 1000)
    const early = await transfer(ll, 'acct_dash', 200, 8 * 86400)
    const late = await transfer(ll, 'acct_dash', 300, 86400)
    // Newest first, as Stripe lists them.
    await syncConnectPayouts(fakeStripe([
      { id: 'po_new', amount: 30000, status: 'paid', created: now - 3600, arrival_date: now, destination: 'ba_1' },
      { id: 'po_old', amount: 20000, status: 'paid', created: now - 7 * 86400, arrival_date: now, destination: 'ba_1' },
    ]) as any)
    expect(await carriedBy(early)).toBe('po_old')
    expect(await carriedBy(late)).toBe('po_new')
  })

  it('a payout that fails puts its transfers back in the queue for the next one', async () => {
    const ll = await landlordWithAccount('acct_fail')
    const now = Math.floor(Date.now() / 1000)
    const t = await transfer(ll, 'acct_fail', 150, 86400)
    await syncConnectPayouts(fakeStripe([
      { id: 'po_bounce', amount: 15000, status: 'in_transit', created: now - 3600, arrival_date: now, destination: 'ba_1' },
    ]) as any)
    expect(await carriedBy(t)).toBe('po_bounce')
    await syncConnectPayouts(fakeStripe([
      { id: 'po_bounce', amount: 15000, status: 'failed', created: now - 3600, arrival_date: now, destination: 'ba_1' },
    ]) as any)
    expect(await carriedBy(t)).toBeNull()
  })
})
