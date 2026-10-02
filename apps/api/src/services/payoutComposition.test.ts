/**
 * S655 (Nic) — a payout says which payments it carried.
 *
 * "$2,638.11 from GAM" arrived in Mountain View's bank and nothing said which
 * rent it was. These pin the two halves: linking a payout to the transfers it
 * swept (stampPayoutTransfers), and itemizing those transfers back to the
 * payments, register sales and GAM charges inside them (payoutComposition) —
 * with any gap shown as its own line, never hidden.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedRentPayment } from '../test/dbHelpers'
import { stampPayoutTransfers, payoutComposition } from './payoutComposition'

beforeEach(async () => { await cleanupAllSchema() })

const ACCOUNT = 'acct_mountain_view'

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const tenantId = await seedTenant(c)
    await c.query('COMMIT')
    return { userId, landlordId, unitId, tenantId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function transfer(f: { landlordId: string; userId: string }, o: {
  amount: number; grossOwed?: number; transferredAt: string; transferId?: string
}): Promise<string> {
  return (await db.query(
    `INSERT INTO platform_transfer_intents
       (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, status,
        stripe_transfer_id, transferred_at)
     VALUES ($1,$2,$3,$4,$5,'transferred',$6,$7::timestamptz) RETURNING id`,
    [f.landlordId, f.userId, ACCOUNT, o.amount, o.grossOwed ?? o.amount,
     o.transferId ?? `tr_${Math.random().toString(36).slice(2)}`, o.transferredAt])).rows[0].id
}

async function payout(f: { landlordId: string; userId: string }, amount: number, at: string,
  o: { trigger?: string; status?: string } = {}): Promise<string> {
  return (await db.query(
    `INSERT INTO disbursements (user_id, landlord_id, trigger_type, amount, status, stripe_payout_id, initiated_at, created_at)
     VALUES ($1,$2,$6,$3,$7,$4,$5::timestamptz,$5::timestamptz) RETURNING id`,
    [f.userId, f.landlordId, amount, `po_${Math.random().toString(36).slice(2)}`, at,
     o.trigger ?? 'auto_friday', o.status ?? 'settled'])).rows[0].id
}

/** The company's Connect account is ACCOUNT, so its payouts are this account's. */
async function ownsAccount(f: { landlordId: string }) {
  await db.query(`UPDATE landlords SET stripe_connect_account_id = $2 WHERE id = $1`, [f.landlordId, ACCOUNT])
}

/** An owner share riding a transfer: what the payment put in the landlord's pocket. */
async function ownerShare(f: { userId: string }, paymentId: string, amount: number, transferRef: string) {
  await db.query(
    `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, reference_id, reference_type, stripe_transfer_id)
     VALUES ($1,'allocation_owner_share',$2,$2,$3,'payment',$4)`, [f.userId, amount, paymentId, transferRef])
}

const linkedTo = async (intentId: string) =>
  (await db.query(`SELECT disbursement_id FROM platform_transfer_intents WHERE id = $1`, [intentId])).rows[0].disbursement_id

const gapNotices = async () =>
  (await db.query(`SELECT title, context FROM admin_notifications WHERE category = 'payout_composition_gap'`)).rows

describe('linking a payout to the transfers it swept', () => {
  it('takes the transfers that landed before it — and leaves one that landed after for the next payout', async () => {
    const f = await seed()
    const a = await transfer(f, { amount: 589, transferredAt: '2026-09-08T18:00:00Z' })
    const b = await transfer(f, { amount: 2049.11, transferredAt: '2026-09-10T21:31:46Z' })
    const later = await transfer(f, { amount: 14.07, transferredAt: '2026-09-30T18:00:00Z' })
    const disb = await payout(f, 2638.11, '2026-09-10T21:31:47Z')

    const r = await stampPayoutTransfers({
      disbursementId: disb, connectAccountId: ACCOUNT, payoutAmount: 2638.11, payoutAt: new Date('2026-09-10T21:31:47Z'),
    })
    expect(r).toMatchObject({ transfersTotal: 2638.11, residual: 0 })
    expect(await linkedTo(a)).toBe(disb)
    expect(await linkedTo(b)).toBe(disb)
    expect(await linkedTo(later)).toBeNull()
    expect(await gapNotices()).toHaveLength(0)
  })

  it('oldest first: a transfer that does not fit waits, and the gap is shown and raised to an admin', async () => {
    const f = await seed()
    const first = await transfer(f, { amount: 500, transferredAt: '2026-09-01T18:00:00Z' })
    const second = await transfer(f, { amount: 300, transferredAt: '2026-09-02T18:00:00Z' })
    const disb = await payout(f, 600, '2026-09-03T18:00:00Z')
    const r = await stampPayoutTransfers({
      disbursementId: disb, connectAccountId: ACCOUNT, payoutAmount: 600, payoutAt: new Date('2026-09-03T18:00:00Z'),
    })
    expect(r).toMatchObject({ transfersTotal: 500, residual: 100 })
    expect(await linkedTo(first)).toBe(disb)
    expect(await linkedTo(second)).toBeNull()
    const [notice] = await gapNotices()
    expect(notice.title).toMatch(/\$600\.00 payout does not equal/)

    const comp = await payoutComposition(disb)
    expect(comp!.adjustments).toContainEqual({ kind: 'residual', label: 'Not traced to a payment GAM moved', amount: 100 })
  })

  it('never takes another account’s transfers, or one already in a payout', async () => {
    const f = await seed()
    const mine = await transfer(f, { amount: 100, transferredAt: '2026-09-01T18:00:00Z' })
    await db.query(`UPDATE platform_transfer_intents SET destination_connect_account_id = 'acct_someone_else' WHERE id = $1`, [mine])
    const disb = await payout(f, 100, '2026-09-03T18:00:00Z')
    const r = await stampPayoutTransfers({ disbursementId: disb, connectAccountId: ACCOUNT, payoutAmount: 100, notifyOnGap: false })
    expect(r.intentIds).toEqual([])
    expect(await linkedTo(mine)).toBeNull()
  })
})

/**
 * S655 review: a payout filed before the backfill linked September's payouts
 * would have claimed September's transfers — they were "waiting" only because
 * nothing had recorded which payout carried them. A GAM sweep pays out the
 * whole balance, so nothing older than the last one can be in a later payout.
 */
describe('a payout never claims what an earlier GAM sweep already carried', () => {
  it('skips transfers older than the last weekly sweep, even when that sweep was never linked', async () => {
    const f = await seed()
    await ownsAccount(f)
    const sept1 = await transfer(f, { amount: 589, transferredAt: '2026-09-08T18:00:00Z' })
    const sept2 = await transfer(f, { amount: 2049.11, transferredAt: '2026-09-10T21:31:46Z' })
    await payout(f, 2638.11, '2026-09-10T21:31:47Z')               // paid them; nothing recorded yet
    const oct = await transfer(f, { amount: 700, transferredAt: '2026-10-05T18:00:00Z' })
    const disb = await payout(f, 700, '2026-10-06T18:00:00Z')

    const r = await stampPayoutTransfers({
      disbursementId: disb, connectAccountId: ACCOUNT, payoutAmount: 700, payoutAt: new Date('2026-10-06T18:00:00Z'),
    })
    expect(r).toMatchObject({ intentIds: [oct], transfersTotal: 700, residual: 0 })
    expect(await linkedTo(sept1)).toBeNull()
    expect(await linkedTo(sept2)).toBeNull()
    expect(await gapNotices()).toHaveLength(0)
  })

  it('a payout made in the Stripe dashboard bounds nothing — it may not have taken everything', async () => {
    const f = await seed()
    await ownsAccount(f)
    const waiting = await transfer(f, { amount: 300, transferredAt: '2026-09-01T18:00:00Z' })
    await payout(f, 100, '2026-09-02T18:00:00Z', { trigger: 'stripe_dashboard' })
    const disb = await payout(f, 300, '2026-09-05T18:00:00Z')
    const r = await stampPayoutTransfers({
      disbursementId: disb, connectAccountId: ACCOUNT, payoutAmount: 300, payoutAt: new Date('2026-09-05T18:00:00Z'),
    })
    expect(r.intentIds).toEqual([waiting])
    expect(r.residual).toBe(0)
  })

  it('a transfer whose payout failed after a later sweep is carried by the next payout', async () => {
    const f = await seed()
    await ownsAccount(f)
    const bounced = await transfer(f, { amount: 500, transferredAt: '2026-09-01T10:00:00Z' })
    await payout(f, 500, '2026-09-01T18:00:00Z', { status: 'failed' })   // came back onto the balance later
    const other = await transfer(f, { amount: 100, transferredAt: '2026-09-02T18:00:00Z' })
    const sweep = await payout(f, 100, '2026-09-03T18:00:00Z', { trigger: 'catch_up' })
    await db.query(`UPDATE platform_transfer_intents SET disbursement_id = $1 WHERE id = $2`, [sweep, other])
    const disb = await payout(f, 500, '2026-09-08T18:00:00Z')
    const r = await stampPayoutTransfers({
      disbursementId: disb, connectAccountId: ACCOUNT, payoutAmount: 500, payoutAt: new Date('2026-09-08T18:00:00Z'),
    })
    expect(r).toMatchObject({ intentIds: [bounced], residual: 0 })
  })

  it('another account’s sweep bounds nothing here', async () => {
    const f = await seed()
    await ownsAccount(f)
    const waiting = await transfer(f, { amount: 250, transferredAt: '2026-09-01T18:00:00Z' })
    const g = await seed()
    await db.query(`UPDATE landlords SET stripe_connect_account_id = 'acct_someone_else' WHERE id = $1`, [g.landlordId])
    await payout(g, 999, '2026-09-03T18:00:00Z')
    const disb = await payout(f, 250, '2026-09-05T18:00:00Z')
    const r = await stampPayoutTransfers({
      disbursementId: disb, connectAccountId: ACCOUNT, payoutAmount: 250, payoutAt: new Date('2026-09-05T18:00:00Z'),
    })
    expect(r.intentIds).toEqual([waiting])
  })
})

describe('what a payout carried', () => {
  it('lists every payment, register sale and GAM charge — and the lines add up to the payout', async () => {
    const f = await seed()
    const c = await db.connect()
    let rent: string, utility: string
    try {
      rent = await seedRentPayment(c, { unitId: f.unitId, tenantId: f.tenantId, landlordId: f.landlordId, amount: 495 })
      utility = (await c.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, settled_at)
         VALUES ($1,$2,$3,'utility',25.20,'settled','UTILITY',CURRENT_DATE,NOW()) RETURNING id`,
        [f.unitId, f.tenantId, f.landlordId])).rows[0].id
    } finally { c.release() }
    // Gross $534.27 owed; $82 of GAM charges taken out before it was sent.
    const intent = await transfer(f, { amount: 452.27, grossOwed: 534.27, transferredAt: '2026-09-21T18:00:00Z', transferId: 'tr_mv' })
    await ownerShare(f, rent, 495, 'tr_mv')
    await ownerShare(f, utility, 25.20, 'tr_mv')
    await db.query(
      `INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, description, payout_intent_id)
       VALUES ($1,'pos_sale','pos_1',14.07,'Register card sale',$2)`, [f.landlordId, intent])
    const disb = await payout(f, 452.27, '2026-09-21T18:00:04Z')
    await db.query(`UPDATE platform_transfer_intents SET disbursement_id = $1 WHERE id = $2`, [disb, intent])

    const comp = (await payoutComposition(disb))!
    expect(comp.traced).toBe(true)
    expect(comp.payments.map(p => [p.what, p.amount])).toEqual([['Rent', 495], ['Utilities', 25.2]])
    expect(comp.payments[0]).toMatchObject({ tenantName: 'Test Tenant', type: 'rent' })
    expect(comp.heldItems).toEqual([expect.objectContaining({ label: 'Register card sale', amount: 14.07 })])
    expect(comp.adjustments).toEqual([{ kind: 'gam_charges', label: 'GAM charges taken out before it was sent', amount: -82 }])
    expect(comp.gamChargesNetted).toBe(82)
    const lines = comp.payments.reduce((s, p) => s + p.amount * 100, 0)
      + comp.heldItems.reduce((s, h) => s + h.amount * 100, 0)
      + comp.adjustments.reduce((s, a) => s + a.amount * 100, 0)
    expect(Math.round(lines)).toBe(45227)
    expect(comp.summary).toMatch(/^\$452\.27 from GAM — 2 payments: .* rent \$495\.00, .* utilities \$25\.20; 1 other item: Register card sale \$14\.07, less \$82\.00 of GAM charges$/)
  })

  it('itemizes a batch GAM charges ate entirely (no money moved, still accounted for)', async () => {
    const f = await seed()
    const c = await db.connect()
    let rent: string
    try { rent = await seedRentPayment(c, { unitId: f.unitId, tenantId: f.tenantId, landlordId: f.landlordId, amount: 82 }) }
    finally { c.release() }
    const intent = await transfer(f, { amount: 0, grossOwed: 82, transferredAt: '2026-09-21T18:00:00Z' })
    await db.query(`UPDATE platform_transfer_intents SET stripe_transfer_id = 'netted:' || id::text WHERE id = $1`, [intent])
    await ownerShare(f, rent, 82, `netted:${intent}`)
    const disb = await payout(f, 0.01, '2026-09-22T18:00:00Z')
    await db.query(`UPDATE platform_transfer_intents SET disbursement_id = $1 WHERE id = $2`, [disb, intent])
    const comp = (await payoutComposition(disb))!
    expect(comp.payments).toHaveLength(1)
    expect(comp.adjustments.map(a => a.kind)).toEqual(['gam_charges', 'residual'])
  })

  it('a payout GAM cannot trace says so instead of guessing', async () => {
    const f = await seed()
    const disb = await payout(f, 4154.89, '2026-09-21T12:18:07Z')
    const comp = (await payoutComposition(disb))!
    expect(comp.traced).toBe(false)
    expect(comp.payments).toEqual([])
    expect(comp.summary).toBe('$4,154.89 from GAM — GAM has no record of which payments this payout carried.')
  })
})
