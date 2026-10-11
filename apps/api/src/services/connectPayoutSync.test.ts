/**
 * S652 — payouts made in Stripe show up in GAM, with the bank they went to.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db } from '../db'
import { logger } from '../lib/logger'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { syncConnectPayouts } from './connectPayoutSync'
import { PAYOUT_GAP_NOTICE } from './payoutComposition'

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
    const failed = fakeStripe([
      { id: 'po_bounce', amount: 15000, status: 'failed', created: now - 3600, arrival_date: now, destination: 'ba_1' },
    ]) as any
    await syncConnectPayouts(failed)
    expect(await carriedBy(t)).toBeNull()
    // ...and the next night does not hand them back to the failed payout.
    await syncConnectPayouts(failed)
    expect(await carriedBy(t)).toBeNull()
  })
})

// S655 review: recording what a payout carried is best-effort — the run and the
// webhook log a failure and move on, because the money has already gone. Nothing
// tried again, and no later payout may take what an earlier sweep carried, so
// one hiccup left a sweep "not traced" for good. The sync now tries again.
describe('a payout whose record of what it carried failed', () => {
  async function landlordWithAccount(account: string) {
    const c = await db.connect()
    let ll: any
    try { await c.query('BEGIN'); ll = await seedLandlord(c); await c.query('COMMIT') } finally { c.release() }
    await db.query(`UPDATE landlords SET stripe_connect_account_id=$2 WHERE id=$1`, [ll.landlordId, account])
    return ll
  }
  const transfer = async (ll: any, account: string, amount: number, landedHoursAgo: number, ref: string) => (await db.query(
    `INSERT INTO platform_transfer_intents
       (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, status, stripe_transfer_id, transferred_at)
     VALUES ($1,$2,$3,$4,$4,'transferred',$5, NOW() - ($6::int * interval '1 hour')) RETURNING id`,
    [ll.landlordId, ll.userId, account, amount, ref, landedHoursAgo])).rows[0].id
  const carriedBy = async (intentId: string) => (await db.query(
    `SELECT d.stripe_payout_id FROM platform_transfer_intents i LEFT JOIN disbursements d ON d.id = i.disbursement_id WHERE i.id=$1`,
    [intentId])).rows[0].stripe_payout_id
  const gamSweep = async (ll: any, payoutId: string, amount: number, hoursAgo: number) => db.query(
    `INSERT INTO disbursements (user_id, landlord_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged, created_at)
     VALUES ($1,$2,'auto_friday',$3,'processing',$4, NOW() - ($5::int * interval '1 hour'),0, NOW() - ($5::int * interval '1 hour'))`,
    [ll.userId, ll.landlordId, amount, payoutId, hoursAgo])

  it('a GAM sweep left with nothing linked is linked by the next sync, and ties out', async () => {
    const ll = await landlordWithAccount('acct_hiccup')
    const now = Math.floor(Date.now() / 1000)
    const a = await transfer(ll, 'acct_hiccup', 120, 48, 'tr_hiccup_a')
    const b = await transfer(ll, 'acct_hiccup', 80, 24, 'tr_hiccup_b')
    const later = await transfer(ll, 'acct_hiccup', 15, 1, 'tr_hiccup_later')
    await gamSweep(ll, 'po_hiccup', 200, 12)          // its own record failed: nothing linked
    await syncConnectPayouts(fakeStripe([
      { id: 'po_hiccup', amount: 20000, status: 'in_transit', created: now - 12 * 3600, arrival_date: now, destination: 'ba_1' },
    ]) as any)
    expect(await carriedBy(a)).toBe('po_hiccup')
    expect(await carriedBy(b)).toBe('po_hiccup')
    expect(await carriedBy(later)).toBeNull()        // landed after the payout: the next one's
    const open = (await db.query(
      `SELECT count(*)::int AS n FROM admin_notifications
        WHERE category = 'payout_composition_gap' AND acknowledged_at IS NULL`)).rows[0].n
    expect(open).toBe(0)
  })

  it('a payout filed from Stripe whose record failed is linked the next time the sync runs', async () => {
    const ll = await landlordWithAccount('acct_hiccup2')
    const now = Math.floor(Date.now() / 1000)
    const t = await transfer(ll, 'acct_hiccup2', 90, 72, 'tr_hiccup2')
    const payout = { id: 'po_hiccup2', amount: 9000, status: 'paid', created: now - 48 * 3600, arrival_date: now, destination: 'ba_1' }
    // The first attempt to record it fails.
    await db.query(`
      CREATE OR REPLACE FUNCTION zz_test_refuse_link() RETURNS trigger AS $$
      BEGIN
        IF NEW.disbursement_id IS NOT NULL THEN RAISE EXCEPTION 'test: the database hiccuped'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`)
    await db.query(`CREATE TRIGGER zz_test_refuse_link BEFORE UPDATE ON platform_transfer_intents
                      FOR EACH ROW EXECUTE FUNCTION zz_test_refuse_link()`)
    try {
      expect(await syncConnectPayouts(fakeStripe([payout]) as any)).toMatchObject({ created: 1 })
      expect(await carriedBy(t)).toBeNull()
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS zz_test_refuse_link ON platform_transfer_intents`)
      await db.query(`DROP FUNCTION IF EXISTS zz_test_refuse_link()`)
    }
    expect(await syncConnectPayouts(fakeStripe([payout]) as any)).toMatchObject({ created: 0, updated: 1 })
    expect(await carriedBy(t)).toBe('po_hiccup2')
  })

  it('a payout made minutes ago is left to the code that filed it, which may still be recording it', async () => {
    const ll = await landlordWithAccount('acct_fresh')
    const now = Math.floor(Date.now() / 1000)
    const t = await transfer(ll, 'acct_fresh', 60, 24, 'tr_fresh')
    await gamSweep(ll, 'po_fresh', 60, 0)
    await syncConnectPayouts(fakeStripe([
      { id: 'po_fresh', amount: 6000, status: 'pending', created: now, arrival_date: now, destination: 'ba_1' },
    ]) as any)
    expect(await carriedBy(t)).toBeNull()
  })
})

// S655 review: some payouts rightly carry no transfer — a dashboard payout
// smaller than the oldest waiting transfer takes none. The nightly re-record of
// a payout with nothing linked raised its "does not equal the transfers inside
// it" notice again every night after an admin acknowledged it.
describe('an admin is told about a payout that does not tie out once, not every night', () => {
  async function landlordWithAccount(account: string) {
    const c = await db.connect()
    let ll: any
    try { await c.query('BEGIN'); ll = await seedLandlord(c); await c.query('COMMIT') } finally { c.release() }
    await db.query(`UPDATE landlords SET stripe_connect_account_id=$2 WHERE id=$1`, [ll.landlordId, account])
    return ll
  }
  const transfer = async (ll: any, account: string, amount: number, landedHoursAgo: number, ref: string) => (await db.query(
    `INSERT INTO platform_transfer_intents
       (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, status, stripe_transfer_id, transferred_at)
     VALUES ($1,$2,$3,$4,$4,'transferred',$5, NOW() - ($6::int * interval '1 hour')) RETURNING id`,
    [ll.landlordId, ll.userId, account, amount, ref, landedHoursAgo])).rows[0].id
  const carriedBy = async (intentId: string) => (await db.query(
    `SELECT d.stripe_payout_id FROM platform_transfer_intents i LEFT JOIN disbursements d ON d.id = i.disbursement_id WHERE i.id=$1`,
    [intentId])).rows[0].stripe_payout_id
  const notices = async (payoutId: string) => (await db.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE n.acknowledged_at IS NULL)::int AS open
       FROM admin_notifications n
       JOIN disbursements d ON d.id::text = n.context->>'disbursementId'
      WHERE n.category = 'payout_composition_gap' AND d.stripe_payout_id = $1`, [payoutId])).rows[0]
  const hoursAgo = (h: number) => Math.floor(Date.now() / 1000) - h * 3600

  it('a gap the admin acknowledged is not raised again by the syncs that follow', async () => {
    const ll = await landlordWithAccount('acct_acked')
    const t = await transfer(ll, 'acct_acked', 500, 72, 'tr_acked')
    // $100 out of the dashboard; the $500 waiting does not fit, so it carried none.
    const stripe = fakeStripe([
      { id: 'po_small', amount: 10000, status: 'paid', created: hoursAgo(48), arrival_date: hoursAgo(24), destination: 'ba_1' },
    ]) as any
    await syncConnectPayouts(stripe)
    expect(await carriedBy(t)).toBeNull()
    expect(await notices('po_small')).toEqual({ total: 1, open: 1 })

    await db.query(`UPDATE admin_notifications SET acknowledged_at = NOW() WHERE category = 'payout_composition_gap'`)
    await syncConnectPayouts(stripe)
    await syncConnectPayouts(stripe)
    expect(await notices('po_small')).toEqual({ total: 1, open: 0 })
    expect(await carriedBy(t)).toBeNull()
  })

  it('a payout that comes to carry a transfer later is linked, and its notice closed once it ties out', async () => {
    const ll = await landlordWithAccount('acct_back')
    const t = await transfer(ll, 'acct_back', 150, 72, 'tr_back')
    const first = { id: 'po_first', amount: 15000, status: 'in_transit', created: hoursAgo(60), arrival_date: hoursAgo(12), destination: 'ba_1' }
    const second = { id: 'po_second', amount: 15000, status: 'paid', created: hoursAgo(48), arrival_date: hoursAgo(24), destination: 'ba_1' }
    await syncConnectPayouts(fakeStripe([second, first]) as any)
    expect(await carriedBy(t)).toBe('po_first')
    expect(await notices('po_second')).toEqual({ total: 1, open: 1 })    // $150 not traced

    // The first payout bounces: its transfer goes back on the balance, and the
    // second payout (already made) is the one that carried that money.
    await syncConnectPayouts(fakeStripe([second, { ...first, status: 'failed' }]) as any)
    expect(await carriedBy(t)).toBe('po_second')
    expect(await notices('po_second')).toEqual({ total: 1, open: 0 })
  })

  it('a payout the admin was never told about — its first record failed — is raised once', async () => {
    const ll = await landlordWithAccount('acct_untold')
    // A GAM sweep whose own record failed, with no transfer of GAM's behind it.
    await db.query(
      `INSERT INTO disbursements (user_id, landlord_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged, created_at)
       VALUES ($1,$2,'auto_friday',50,'processing','po_untold', NOW() - interval '12 hours',0, NOW() - interval '12 hours')`,
      [ll.userId, ll.landlordId])
    const stripe = fakeStripe([
      { id: 'po_untold', amount: 5000, status: 'paid', created: hoursAgo(12), arrival_date: hoursAgo(1), destination: 'ba_1' },
    ]) as any
    await syncConnectPayouts(stripe)
    expect(await notices('po_untold')).toEqual({ total: 1, open: 1 })
    await db.query(`UPDATE admin_notifications SET acknowledged_at = NOW() WHERE category = 'payout_composition_gap'`)
    await syncConnectPayouts(stripe)
    expect(await notices('po_untold')).toEqual({ total: 1, open: 0 })
  })

  // The sync asks "was the admin ever told?" by the notice's category. A copy of
  // it that drifted from payoutComposition's would always answer no, and every
  // night would raise an acknowledged gap again. One constant, and it stays the
  // category production's notices already carry.
  it('asks about the same notice category payoutComposition raises, the one production’s notices carry', () => {
    expect(PAYOUT_GAP_NOTICE).toBe('payout_composition_gap')
  })

  // The sync first tries the re-record in a transaction it rolls back. The API
  // logs are kept and searched: a take-back logged by that trial never
  // happened, and the real one was logged twice.
  it('a late dashboard payout taking transfers back from a later sweep is logged once, by the call that does it', async () => {
    const ll = await landlordWithAccount('acct_takeback')
    const t = await transfer(ll, 'acct_takeback', 100, 72, 'tr_takeback')
    // A later GAM sweep carried it, because the dashboard payout before that
    // sweep had not been recorded yet.
    const sweep = (await db.query(
      `INSERT INTO disbursements (user_id, landlord_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged, created_at)
       VALUES ($1,$2,'auto_friday',100,'processing','po_sweep_after', NOW() - interval '24 hours',0, NOW() - interval '24 hours')
       RETURNING id`, [ll.userId, ll.landlordId])).rows[0].id
    await db.query(`UPDATE platform_transfer_intents SET disbursement_id = $1 WHERE id = $2`, [sweep, t])
    // The dashboard payout made before that sweep, filed with nothing linked.
    await db.query(
      `INSERT INTO disbursements (user_id, landlord_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged, created_at)
       VALUES ($1,$2,'stripe_dashboard',100,'processing','po_dash_late', NOW() - interval '48 hours',0, NOW() - interval '48 hours')`,
      [ll.userId, ll.landlordId])

    const info = vi.spyOn(logger, 'info')
    try {
      await syncConnectPayouts(fakeStripe([
        { id: 'po_dash_late', amount: 10000, status: 'paid', created: hoursAgo(48), arrival_date: hoursAgo(24), destination: 'ba_1' },
      ]) as any)
      expect(await carriedBy(t)).toBe('po_dash_late')
      const takeBacks = info.mock.calls.filter(args => args.some(a => typeof a === 'string' && /took back the transfers/.test(a)))
      expect(takeBacks).toHaveLength(1)
    } finally {
      info.mockRestore()
    }
  })
})

// S655 review: the payout run can file a payout between this sync's lookup and
// its insert. With stripe_payout_id unique and ON CONFLICT, the sync updates the
// run's row (status, bank) instead of writing a second 'stripe_dashboard' row.
describe('one payout, one row', () => {
  async function untilSomeoneWaitsOnALock() {
    for (let i = 0; i < 200; i++) {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)
      if (r.rows[0].n > 0) return
      await new Promise(res => setTimeout(res, 25))
    }
    throw new Error('nothing ever waited on the lock')
  }

  it('a payout the weekly run files while the sync is filing it stays one row — the run’s, with the bank stamped on it', async () => {
    const c = await db.connect()
    let ll: any
    try { await c.query('BEGIN'); ll = await seedLandlord(c); await c.query('COMMIT') } finally { c.release() }
    await db.query(`UPDATE landlords SET stripe_connect_account_id='acct_both' WHERE id=$1`, [ll.landlordId])
    const now = Math.floor(Date.now() / 1000)

    const run = await db.connect()
    let sync: Promise<any>
    try {
      await run.query('BEGIN')
      await run.query(
        `INSERT INTO disbursements (user_id, landlord_id, trigger_type, amount, status, stripe_payout_id, initiated_at, fee_charged)
         VALUES ($1,$2,'auto_friday',250,'processing','po_both',NOW(),0)`, [ll.userId, ll.landlordId])
      sync = syncConnectPayouts(fakeStripe([
        { id: 'po_both', amount: 25000, status: 'paid', created: now, arrival_date: now, destination: 'ba_1' },
      ]) as any)
      sync.catch(() => {})
      await untilSomeoneWaitsOnALock()          // the sync's insert, waiting on the run's
      await run.query('COMMIT')
    } finally { run.release() }

    expect(await sync!).toMatchObject({ created: 0, updated: 1 })
    const rows = (await db.query(`SELECT trigger_type, status, bank_last4 FROM disbursements WHERE stripe_payout_id='po_both'`)).rows
    expect(rows).toEqual([{ trigger_type: 'auto_friday', status: 'settled', bank_last4: '8739' }])
  })
})
