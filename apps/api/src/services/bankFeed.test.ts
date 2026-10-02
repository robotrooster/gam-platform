// S570: bank feed — idempotent sync, auto-match to GAM disbursements, categorize
// → expense + merchant memory, suggestion recall, outflow-only guard, ignore.
// Pure-DB paths (no Stripe): the Stripe boundary is only createLinkSession /
// finalize / syncConnection's pull, which are exercised in the route/integration
// layer; here we drive upsertTransactions directly with normalized rows.
import { describe, it, expect, beforeEach } from 'vitest'
import { db, query } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedRentPayment, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import {
  upsertTransactions, autoMatchLandlord, categorizeTransaction, ignoreTransaction,
  suggestForMerchant, normalizeMerchant, listTransactions, setBooksStartDate, autoSettleDeclaredDeposits,
} from './bankFeed'
import { landlordExpensesTotal, unitAllocatedExpenses, createLandlordExpense } from './landlordExpenses'

beforeEach(async () => { await cleanupAllSchema() })

async function seed() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: llUser, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: llUser, managedByUserId: llUser })
    const unitA = await seedUnit(c, { propertyId, landlordId })
    const unitB = await seedUnit(c, { propertyId, landlordId })
    // A bank connection (as if the FC link already happened).
    const conn = await c.query(
      `INSERT INTO bank_connections (landlord_id, provider, stripe_fc_account_id, institution_name, display_name)
       VALUES ($1,'stripe_fc',$2,'Test Bank','Test Bank ••1111') RETURNING id`,
      [landlordId, 'fca_test_' + Math.abs(propertyId.split('-')[0].length)])
    await c.query('COMMIT')
    return { llUser, landlordId, propertyId, unitA, unitB, connectionId: conn.rows[0].id }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** S655: link the same physical account again (same bank, same last four), as a relink does. */
async function relinkSameBank(f: { landlordId: string; connectionId: string }, fcAccount = 'fca_relink_2') {
  await db.query(`UPDATE bank_connections SET account_last4 = '1111' WHERE id = $1`, [f.connectionId])
  return (await db.query<{ id: string }>(
    `INSERT INTO bank_connections (landlord_id, provider, stripe_fc_account_id, institution_name, account_last4, display_name)
     VALUES ($1, 'stripe_fc', $2, 'Test Bank', '1111', 'Test Bank ••1111') RETURNING id`,
    [f.landlordId, fcAccount])).rows[0].id
}

/** A stored row by its bank id, with the S655 columns as text. */
async function row(externalId: string): Promise<any> {
  return (await db.query(
    `SELECT id, status, ignored_reason, duplicate_of_id, bank_status, description,
            posted_date::text AS posted_date, amount::text AS amount
       FROM bank_transactions WHERE external_id = $1`, [externalId])).rows[0]
}

async function seedDisbursement(landlordId: string, amount: number, settledAt: string) {
  const r = await db.query(
    `INSERT INTO disbursements (landlord_id, amount, status, settled_at, target_date)
     VALUES ($1,$2,'settled',$3::timestamptz,$4::date) RETURNING id`,
    [landlordId, amount.toFixed(2), settledAt, settledAt])
  return r.rows[0].id
}

describe('normalizeMerchant', () => {
  it('strips store numbers, dates and noise to a stable key', () => {
    expect(normalizeMerchant('HOME DEPOT #1234 PHOENIX AZ 07/12')).toBe('HOME DEPOT PHOENIX AZ')
    expect(normalizeMerchant('POS DEBIT LOWES 0057 MESA')).toBe('LOWES MESA')
    expect(normalizeMerchant(null)).toBe('')
  })
})

describe('bank feed sync', () => {
  it('upsert is idempotent on (connection, external_id)', async () => {
    const f = await seed()
    const rows = [{ externalId: 'fctxn_1', postedDate: '2026-08-10', amount: -120.5, description: 'HOME DEPOT #9 AZ' }]
    const first = await upsertTransactions(f.connectionId, f.landlordId, rows)
    const second = await upsertTransactions(f.connectionId, f.landlordId, rows)
    expect(first).toBe(1)
    expect(second).toBe(0)
    const all = await db.query('SELECT count(*)::int AS n FROM bank_transactions WHERE bank_connection_id=$1', [f.connectionId])
    expect(all.rows[0].n).toBe(1)
  })

  it('auto-matches an inbound deposit to a settled disbursement; outflow stays for review', async () => {
    const f = await seed()
    await seedDisbursement(f.landlordId, 1500, '2026-08-09')
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'in_1',  postedDate: '2026-08-11', amount: 1500,   description: 'GOLD ASSET MGMT PAYOUT' }, // matches (2 days)
      { externalId: 'out_1', postedDate: '2026-08-10', amount: -420.0, description: 'HOME DEPOT #1234' },       // stays
      { externalId: 'in_2',  postedDate: '2026-08-11', amount: 99.99,  description: 'RANDOM REFUND' },          // no disb → stays
    ])
    const matched = await db.query(`SELECT status, matched_disbursement_id FROM bank_transactions WHERE external_id='in_1'`)
    expect(matched.rows[0].status).toBe('matched')
    expect(matched.rows[0].matched_disbursement_id).toBeTruthy()
    const out = await db.query(`SELECT status FROM bank_transactions WHERE external_id='out_1'`)
    expect(out.rows[0].status).toBe('needs_review')
    const in2 = await db.query(`SELECT status FROM bank_transactions WHERE external_id='in_2'`)
    expect(in2.rows[0].status).toBe('needs_review')
  })

  it('does not double-match two deposits to the same disbursement', async () => {
    const f = await seed()
    await seedDisbursement(f.landlordId, 800, '2026-08-09')
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'in_a', postedDate: '2026-08-10', amount: 800, description: 'PAYOUT' },
      { externalId: 'in_b', postedDate: '2026-08-11', amount: 800, description: 'PAYOUT' },
    ])
    const matched = await db.query(`SELECT count(*)::int AS n FROM bank_transactions WHERE landlord_id=$1 AND status='matched'`, [f.landlordId])
    expect(matched.rows[0].n).toBe(1)
  })

  // S654: the sibling key read posted_date as a JS Date ('Wed Sep 30 …'), so it
  // never matched an incoming 'YYYY-MM-DD' and a relink imported the history twice.
  // S655: the copy on the NEW link is the one kept (the bank keeps updating
  // it); the untouched old copy is hidden as its duplicate, pointing at it.
  it('a relink does not import the same history again — the new copy is kept, the old one hidden as its duplicate', async () => {
    const f = await seed()
    const relink = await relinkSameBank(f)
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'old_1', postedDate: '2026-09-30', amount: -120.5, description: 'HOME DEPOT #9 AZ' },
    ])
    const inserted = await upsertTransactions(relink, f.landlordId, [
      { externalId: 'new_1', postedDate: '2026-09-30', amount: -120.5, description: 'HOME DEPOT #9 AZ' }, // same row, new link
      { externalId: 'new_2', postedDate: '2026-10-01', amount: -120.5, description: 'HOME DEPOT #9 AZ' }, // a new day
    ])
    expect(inserted).toBe(1)   // only new_2 is new to the landlord
    const old = await row('old_1')
    expect(old).toMatchObject({ status: 'ignored', ignored_reason: 'duplicate', duplicate_of_id: (await row('new_1')).id })
    const review = await listTransactions(f.landlordId, { status: 'needs_review' })
    expect(review.map((t: any) => t.description + '@' + String(t.posted_date))).toHaveLength(2)
    expect((await listTransactions(f.landlordId)).map((t: any) => t.id)).not.toContain(old.id)
  })

  // S654: books_start_date came back as a JS Date and `'2026-07-31' < Date` is
  // always false, so pre-start rows landed in the review queue.
  it('rows dated before the books start date land ignored as before_books; on/after it, for review', async () => {
    const f = await seed()
    await db.query(`UPDATE landlords SET books_start_date = '2026-08-01' WHERE id = $1`, [f.landlordId])
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'pre_1', postedDate: '2026-07-31', amount: -50, description: 'LOWES 0057 MESA' },
      { externalId: 'on_1',  postedDate: '2026-08-01', amount: -60, description: 'LOWES 0057 MESA' },
    ])
    const rows = await db.query<{ external_id: string; status: string; ignored_reason: string | null }>(
      `SELECT external_id, status, ignored_reason FROM bank_transactions WHERE landlord_id = $1 ORDER BY external_id`, [f.landlordId])
    expect(rows.rows).toEqual([
      { external_id: 'on_1', status: 'needs_review', ignored_reason: null },
      { external_id: 'pre_1', status: 'ignored', ignored_reason: 'before_books' },
    ])
  })
})

// ── S655: relinking the same bank (Oak Park PNC ••9677) ──────────────────────
describe('relink copies pair one for one', () => {
  it('pairs the bank’s short pending wording with its posted wording for the same charge', async () => {
    const f = await seed()
    const relink = await relinkSameBank(f)
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'o_pin', postedDate: '2026-08-16', amount: -42.17, description: 'PIN POS MOUNTAINAI CARD#2971' },
    ])
    const n = await upsertTransactions(relink, f.landlordId, [
      { externalId: 'n_pin', postedDate: '2026-08-16', amount: -42.17, description: 'MOUNTAINAIRE M N0816 PEEPLES' },
    ])
    expect(n).toBe(0)
    expect(await row('o_pin')).toMatchObject({ ignored_reason: 'duplicate', duplicate_of_id: (await row('n_pin')).id })
    expect((await row('n_pin')).status).toBe('needs_review')
  })

  it('pairs a deposit that posted a day later on the new link, but not one five days away', async () => {
    const f = await seed()
    const relink = await relinkSameBank(f)
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'o_dl', postedDate: '2026-09-09', amount: 590.91, description: 'ACH DEP DOORLOOP *8598' },
      { externalId: 'o_far', postedDate: '2026-09-01', amount: 77.5, description: 'DEPOSIT' },
    ])
    await upsertTransactions(relink, f.landlordId, [
      { externalId: 'n_dl', postedDate: '2026-09-10', amount: 590.91, description: 'ST-X4O0K9S9Y9T4 DOORLOOP CORPORATE ACH' },
      { externalId: 'n_far', postedDate: '2026-09-06', amount: 77.5, description: 'DEPOSIT' },
    ])
    expect(await row('o_dl')).toMatchObject({ ignored_reason: 'duplicate', duplicate_of_id: (await row('n_dl')).id })
    expect((await row('o_far')).status).toBe('needs_review')     // five days apart: two transactions
    expect((await row('n_far')).status).toBe('needs_review')
  })

  // The S605 guard was a plain set: one old charge would have swallowed BOTH
  // identical charges on the new link, and a real charge would be lost.
  it('two identical same-day charges on the new link, one on the old: one pairs, the other is a real charge', async () => {
    const f = await seed()
    const relink = await relinkSameBank(f)
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'o_twin', postedDate: '2026-09-12', amount: -25, description: 'QT 412' },
    ])
    const n = await upsertTransactions(relink, f.landlordId, [
      { externalId: 'n_twin_a', postedDate: '2026-09-12', amount: -25, description: 'QT 412' },
      { externalId: 'n_twin_b', postedDate: '2026-09-12', amount: -25, description: 'QT 412' },
    ])
    expect(n).toBe(1)
    const onNew = await query<any>(
      `SELECT status FROM bank_transactions WHERE bank_connection_id = $1`, [relink])
    expect(onNew.map((r: any) => r.status)).toEqual(['needs_review', 'needs_review'])
    expect((await row('o_twin')).ignored_reason).toBe('duplicate')
  })

  it('identical text wins over a nearer date', async () => {
    const f = await seed()
    const relink = await relinkSameBank(f)
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'o_x', postedDate: '2026-09-10', amount: -60, description: 'SHELL OIL X' },
      { externalId: 'o_y', postedDate: '2026-09-11', amount: -60, description: 'CIRCLE K Y' },
    ])
    await upsertTransactions(relink, f.landlordId, [
      { externalId: 'n_x', postedDate: '2026-09-11', amount: -60, description: 'SHELL OIL X' },
      { externalId: 'n_y', postedDate: '2026-09-11', amount: -60, description: 'CIRCLE K Y' },
    ])
    expect((await row('o_x')).duplicate_of_id).toBe((await row('n_x')).id)
    expect((await row('o_y')).duplicate_of_id).toBe((await row('n_y')).id)
  })

  it('an old copy already filed is kept, and the new copy lands as its duplicate', async () => {
    const f = await seed()
    const relink = await relinkSameBank(f)
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'o_filed', postedDate: '2026-09-03', amount: -310, description: 'HOME DEPOT #9 AZ' },
    ])
    await categorizeTransaction(f.landlordId, (await row('o_filed')).id,
      { category: 'repairs', scopeKind: 'unit', unitId: f.unitA })
    const n = await upsertTransactions(relink, f.landlordId, [
      { externalId: 'n_filed', postedDate: '2026-09-03', amount: -310, description: 'HOME DEPOT #9 AZ' },
    ])
    expect(n).toBe(0)
    const copy = await row('n_filed')
    expect(copy).toMatchObject({ status: 'ignored', ignored_reason: 'duplicate', duplicate_of_id: (await row('o_filed')).id })
    expect((await row('o_filed')).status).toBe('categorized')
    expect(await landlordExpensesTotal(f.landlordId, '2026-09-01', '2026-09-30')).toBe(310)   // once
    expect((await listTransactions(f.landlordId)).map((t: any) => t.id)).not.toContain(copy.id)
  })

  it('a third link pairs with the copies kept on the second, and every hidden copy points at the one kept', async () => {
    const f = await seed()
    const second = await relinkSameBank(f)
    const third = await relinkSameBank(f, 'fca_relink_3')
    const r = { postedDate: '2026-09-20', amount: -88.8, description: 'ACE HARDWARE 0123' }
    await upsertTransactions(f.connectionId, f.landlordId, [{ externalId: 'l1', ...r }])
    await upsertTransactions(second, f.landlordId, [{ externalId: 'l2', ...r }])
    const n = await upsertTransactions(third, f.landlordId, [{ externalId: 'l3', ...r }])
    expect(n).toBe(0)
    const kept = await row('l3')
    expect(kept.status).toBe('needs_review')
    expect((await row('l1')).duplicate_of_id).toBe(kept.id)
    expect((await row('l2')).duplicate_of_id).toBe(kept.id)
    expect(await listTransactions(f.landlordId, { status: 'needs_review' })).toHaveLength(1)
  })
})

describe('the bank’s own state is followed', () => {
  it('a pending transaction is not stored until it posts', async () => {
    const f = await seed()
    const first = await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'p1', postedDate: '2026-09-16', amount: -42.17, description: 'PIN POS MOUNTAINAI', status: 'pending' },
    ])
    expect(first).toBe(0)
    expect(await row('p1')).toBeUndefined()
    const later = await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'p1', postedDate: '2026-09-17', amount: -42.17, description: 'MOUNTAINAIRE M N0816', status: 'posted' },
    ])
    expect(later).toBe(1)
    expect(await row('p1')).toMatchObject({ status: 'needs_review', bank_status: 'posted', description: 'MOUNTAINAIRE M N0816' })
  })

  it('a stored row nobody filed takes the bank’s posted wording, date and amount', async () => {
    const f = await seed()
    // As imported before S655: the pending record, stored as-is.
    await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, normalized_merchant, status)
       VALUES ($1,$2,'legacy_1','2026-09-09',-18.4,'PIN POS RESTAURNT','RESTAURNT','needs_review')`,
      [f.connectionId, f.landlordId])
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'legacy_1', postedDate: '2026-09-10', amount: -22.4, description: 'LOS AMIGOS CAFE 0909', status: 'posted' },
    ])
    expect(await row('legacy_1')).toMatchObject({
      posted_date: '2026-09-10', amount: '-22.40', description: 'LOS AMIGOS CAFE 0909', bank_status: 'posted', status: 'needs_review',
    })
  })

  it('a filed row keeps what was filed when the bank’s wording changes', async () => {
    const f = await seed()
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'f1', postedDate: '2026-09-09', amount: -40, description: 'PIN POS HDEPOT' },
    ])
    await categorizeTransaction(f.landlordId, (await row('f1')).id, { category: 'repairs', scopeKind: 'unit', unitId: f.unitA })
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'f1', postedDate: '2026-09-10', amount: -40, description: 'THE HOME DEPOT #0412' },
    ])
    expect(await row('f1')).toMatchObject({ description: 'PIN POS HDEPOT', posted_date: '2026-09-09', status: 'categorized' })
  })

  it('a voided transaction nobody filed is hidden as voided and never listed', async () => {
    const f = await seed()
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'v1', postedDate: '2026-09-09', amount: -75, description: 'HOTEL HOLD' },
    ])
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'v1', postedDate: '2026-09-09', amount: -75, description: 'HOTEL HOLD', status: 'void' },
    ])
    expect(await row('v1')).toMatchObject({ status: 'ignored', ignored_reason: 'bank_void', bank_status: 'void' })
    expect(await listTransactions(f.landlordId)).toHaveLength(0)
  })

  it('a voided transaction already filed stays in the books, flagged for the landlord', async () => {
    const f = await seed()
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'v2', postedDate: '2026-09-09', amount: -75, description: 'HOTEL HOLD' },
    ])
    await categorizeTransaction(f.landlordId, (await row('v2')).id, { category: 'repairs', scopeKind: 'unit', unitId: f.unitA })
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'v2', postedDate: '2026-09-09', amount: -75, description: 'HOTEL HOLD', status: 'void' },
    ])
    expect(await row('v2')).toMatchObject({ status: 'categorized', bank_status: 'void' })
    const [listed] = await listTransactions(f.landlordId)
    expect(listed.bank_status).toBe('void')
  })
})

describe('books start date moves only what it hid', () => {
  it('never brings back a copy, a voided row, or a row the landlord ignored', async () => {
    const f = await seed()
    await db.query(`UPDATE landlords SET books_start_date = '2026-09-01' WHERE id = $1`, [f.landlordId])
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'mine',  postedDate: '2026-09-05', amount: -10, description: 'PERSONAL' },
      { externalId: 'void',  postedDate: '2026-09-06', amount: -11, description: 'HOLD' },
      { externalId: 'early', postedDate: '2026-08-20', amount: -12, description: 'AUGUST' },
      { externalId: 'kept',  postedDate: '2026-09-07', amount: -13, description: 'KEPT' },
    ])
    await ignoreTransaction(f.landlordId, (await row('mine')).id)
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'void', postedDate: '2026-09-06', amount: -11, description: 'HOLD', status: 'void' },
    ])
    await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, status, ignored_reason, duplicate_of_id)
       VALUES ($1,$2,'copy','2026-09-07',-13,'ignored','duplicate',$3)`,
      [f.connectionId, f.landlordId, (await row('kept')).id])

    const moved = await setBooksStartDate(f.landlordId, '2026-08-01')
    expect(moved).toEqual({ ignored: 0, restored: 1 })                // only 'early'
    expect((await row('early')).status).toBe('needs_review')
    expect(await row('mine')).toMatchObject({ status: 'ignored', ignored_reason: 'landlord' })
    expect(await row('void')).toMatchObject({ status: 'ignored', ignored_reason: 'bank_void' })
    expect(await row('copy')).toMatchObject({ status: 'ignored', ignored_reason: 'duplicate' })

    // Clearing it does the same: only what the date hid comes back.
    await setBooksStartDate(f.landlordId, '2026-09-01')
    expect(await row('early')).toMatchObject({ status: 'ignored', ignored_reason: 'before_books' })
    const cleared = await setBooksStartDate(f.landlordId, null)
    expect(cleared).toEqual({ ignored: 0, restored: 1 })
    expect((await row('mine')).status).toBe('ignored')
    expect((await row('copy')).status).toBe('ignored')
  })
})

describe('filing guards', () => {
  it('refuses to file a copy, a row from before the books, or a row the bank voided', async () => {
    const f = await seed()
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'g_kept', postedDate: '2026-09-07', amount: -13, description: 'KEPT' },
      { externalId: 'g_void', postedDate: '2026-09-08', amount: -14, description: 'HOLD' },
    ])
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'g_void', postedDate: '2026-09-08', amount: -14, description: 'HOLD', status: 'void' },
    ])
    await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, status, ignored_reason, duplicate_of_id)
       VALUES ($1,$2,'g_copy','2026-09-07',-13,'ignored','duplicate',$3),
              ($1,$2,'g_early','2026-07-07',-15,'ignored','before_books',NULL)`,
      [f.connectionId, f.landlordId, (await row('g_kept')).id])
    const file = async (ext: string) => categorizeTransaction(f.landlordId, (await row(ext)).id,
      { category: 'repairs', scopeKind: 'unit', unitId: f.unitA })
    await expect(file('g_copy')).rejects.toThrow(/second copy/i)
    await expect(file('g_early')).rejects.toThrow(/books start/i)
    await expect(file('g_void')).rejects.toThrow(/voided/i)
    expect(await landlordExpensesTotal(f.landlordId, '2026-07-01', '2026-09-30')).toBe(0)
  })

  it('a row the landlord ignored can still be filed if they change their mind', async () => {
    const f = await seed()
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'later', postedDate: '2026-09-07', amount: -30, description: 'LOWES' },
    ])
    await ignoreTransaction(f.landlordId, (await row('later')).id)
    await categorizeTransaction(f.landlordId, (await row('later')).id, { category: 'repairs', scopeKind: 'unit', unitId: f.unitA })
    expect(await row('later')).toMatchObject({ status: 'categorized', ignored_reason: null })
  })

  it('refuses to book a tenant deposit already applied to rent as income', async () => {
    const f = await seed()
    const c = await db.connect()
    let paymentId: string
    try {
      const tenantId = await seedTenant(c)
      paymentId = await seedRentPayment(c, { unitId: f.unitA, tenantId, landlordId: f.landlordId, amount: 500 })
    } finally { c.release() }
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'dep', postedDate: '2026-09-07', amount: 500, description: 'DEPOSIT' },
    ])
    await db.query(`UPDATE bank_transactions SET status='matched', matched_payment_id=$2 WHERE external_id='dep' AND landlord_id=$1`,
      [f.landlordId, paymentId])
    await expect(categorizeTransaction(f.landlordId, (await row('dep')).id,
      { category: 'other', scopeKind: 'unit', unitId: f.unitA })).rejects.toThrow(/tenant’s rent.*double/i)
  })

  it('income cannot be filed against another company’s unit', async () => {
    const f = await seed()
    // Another company, with its own property and unit (no bank link needed).
    const c = await db.connect()
    let other: { propertyId: string; unitA: string }
    try {
      const o = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId: o.landlordId, ownerUserId: o.userId, managedByUserId: o.userId })
      other = { propertyId, unitA: await seedUnit(c, { propertyId, landlordId: o.landlordId }) }
    } finally { c.release() }
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'inc', postedDate: '2026-09-07', amount: 120, description: 'COINMACH' },
    ])
    await expect(categorizeTransaction(f.landlordId, (await row('inc')).id,
      { category: 'laundry', scopeKind: 'unit', unitId: other.unitA })).rejects.toThrow(/does not belong to you/i)
    await expect(categorizeTransaction(f.landlordId, (await row('inc')).id,
      { category: 'laundry', scopeKind: 'property_common', propertyId: other.propertyId })).rejects.toThrow(/does not belong to you/i)
    expect((await row('inc')).status).toBe('needs_review')
  })

  it('two clicks at once book the charge once', async () => {
    const f = await seed()
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'dbl', postedDate: '2026-09-07', amount: -64, description: 'LOWES' },
    ])
    const id = (await row('dbl')).id
    const body = { category: 'repairs', scopeKind: 'unit' as const, unitId: f.unitA }
    const results = await Promise.allSettled([
      categorizeTransaction(f.landlordId, id, body), categorizeTransaction(f.landlordId, id, body)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(await landlordExpensesTotal(f.landlordId, '2026-09-01', '2026-09-30')).toBe(64)
  })
})

/** Wait until some other connection is blocked on a row lock (the sync waiting on a filing). */
async function untilSomeoneWaitsOnALock() {
  for (let i = 0; i < 200; i++) {
    const r = await db.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)
    if (r.rows[0].n > 0) return
    await new Promise(res => setTimeout(res, 25))
  }
  throw new Error('nothing ever waited on the row lock')
}

/**
 * S655 review: categorize locks its row, but the sync used to read rows without
 * locking and then overwrite them — so a row the landlord filed mid-sync could
 * be hidden as a copy, or put back in review with its expense still booked and
 * filed a second time. These hold the landlord's filing open while a sync runs,
 * commit it, and check nothing the landlord filed was undone.
 */
describe('a sync never undoes a filing that happens while it runs', () => {
  /** What categorizeTransaction does, held open: the expense booked, the row locked, then filed. */
  async function fileWhileSyncing(f: any, txnId: string, sync: () => Promise<number>) {
    const expense = await createLandlordExpense({
      landlordId: f.landlordId, propertyId: null, unitId: f.unitA, category: 'repairs', amount: 310,
      description: 'HOME DEPOT', vendor: 'HOME DEPOT', expenseDate: '2026-09-03', isCommon: false,
    })
    const filing = await db.connect()
    try {
      await filing.query('BEGIN')
      await filing.query(`SELECT id FROM bank_transactions WHERE id = $1 FOR UPDATE`, [txnId])
      const running = sync()
      running.catch(() => {})
      await untilSomeoneWaitsOnALock()
      await filing.query(
        `UPDATE bank_transactions SET status = 'categorized', expense_id = $2, categorized_at = now() WHERE id = $1`,
        [txnId, expense.id])
      await filing.query('COMMIT')
      return await running
    } finally { filing.release() }
  }

  it('an old copy filed while a relink sync runs stays filed, and the new copy lands as its duplicate', async () => {
    const f = await seed()
    const relink = await relinkSameBank(f)
    const r = { postedDate: '2026-09-03', amount: -310, description: 'HOME DEPOT #9 AZ' }
    await upsertTransactions(f.connectionId, f.landlordId, [{ externalId: 'o_race', ...r }])
    const old = (await row('o_race')).id

    const n = await fileWhileSyncing(f, old,
      () => upsertTransactions(relink, f.landlordId, [{ externalId: 'n_race', ...r }]))

    expect(n).toBe(0)
    expect(await row('o_race')).toMatchObject({ status: 'categorized', ignored_reason: null })
    expect(await row('n_race')).toMatchObject({ status: 'ignored', ignored_reason: 'duplicate', duplicate_of_id: old })
    expect(await landlordExpensesTotal(f.landlordId, '2026-09-01', '2026-09-30')).toBe(310)
  })

  it('a row filed while the sync takes the bank’s new wording stays filed, keeps its text, and is never booked twice', async () => {
    const f = await seed()
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'fr', postedDate: '2026-09-03', amount: -310, description: 'PIN POS HDEPOT' },
    ])
    const id = (await row('fr')).id

    await fileWhileSyncing(f, id, () => upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'fr', postedDate: '2026-09-04', amount: -310, description: 'THE HOME DEPOT #0412' },
    ]))

    expect(await row('fr')).toMatchObject({ status: 'categorized', description: 'PIN POS HDEPOT', posted_date: '2026-09-03' })
    await expect(categorizeTransaction(f.landlordId, id, { category: 'repairs', scopeKind: 'unit', unitId: f.unitA }))
      .rejects.toThrow(/already categorized/i)
    expect(await landlordExpensesTotal(f.landlordId, '2026-09-01', '2026-09-30')).toBe(310)
  })

  it('saving the books start date while a row is being filed waits for it, and leaves the filed row alone', async () => {
    const f = await seed()
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'bs_filed', postedDate: '2026-07-20', amount: -310, description: 'HOME DEPOT' },
      { externalId: 'bs_other', postedDate: '2026-07-21', amount: -12, description: 'QUIKTRIP' },
    ])
    const id = (await row('bs_filed')).id
    const filing = await db.connect()
    let moved: { ignored: number; restored: number }
    try {
      await filing.query('BEGIN')
      await filing.query(`SELECT id FROM bank_transactions WHERE id = $1 FOR UPDATE`, [id])
      const saving = setBooksStartDate(f.landlordId, '2026-08-01')
      saving.catch(() => {})
      await untilSomeoneWaitsOnALock()
      await filing.query(`UPDATE bank_transactions SET status = 'categorized', categorized_at = now() WHERE id = $1`, [id])
      await filing.query('COMMIT')
      moved = await saving
    } finally { filing.release() }
    expect(moved).toEqual({ ignored: 1, restored: 0 })
    expect((await row('bs_filed')).status).toBe('categorized')
    expect(await row('bs_other')).toMatchObject({ status: 'ignored', ignored_reason: 'before_books' })
  })

  it('a row that already booked an expense is never filed again, whatever its status says', async () => {
    const f = await seed()
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'booked', postedDate: '2026-09-03', amount: -310, description: 'HOME DEPOT' },
    ])
    const id = (await row('booked')).id
    const expense = await createLandlordExpense({
      landlordId: f.landlordId, propertyId: null, unitId: f.unitA, category: 'repairs', amount: 310,
      description: 'HOME DEPOT', vendor: 'HOME DEPOT', expenseDate: '2026-09-03', isCommon: false,
    })
    // The state the race used to leave behind: back in review, expense still booked.
    await db.query(`UPDATE bank_transactions SET expense_id = $2 WHERE id = $1`, [id, expense.id])
    await expect(categorizeTransaction(f.landlordId, id, { category: 'repairs', scopeKind: 'unit', unitId: f.unitA }))
      .rejects.toThrow(/already filed in your books/i)
    expect(await landlordExpensesTotal(f.landlordId, '2026-09-01', '2026-09-30')).toBe(310)
  })
})

/**
 * S655 review: rows stored before S655 can still be pending at the bank. The
 * automatic paths — matching a deposit to a GAM payout, settling a tenant's
 * reported rent from it — wait until the bank has posted it, because a pending
 * deposit can still be voided and the rent would stay marked paid.
 */
describe('a deposit still pending at the bank', () => {
  async function legacyDeposit(f: any, externalId: string, amount: number, postedDate: string, description: string) {
    await db.query(
      `INSERT INTO bank_transactions
         (bank_connection_id, landlord_id, external_id, posted_date, amount, description, normalized_merchant, status)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,'needs_review')`,
      [f.connectionId, f.landlordId, externalId, postedDate, amount.toFixed(2), description, normalizeMerchant(description)])
  }

  it('is not matched to a GAM payout until the bank posts it', async () => {
    const f = await seed()
    await seedDisbursement(f.landlordId, 1200, '2026-09-09T18:00:00Z')
    await legacyDeposit(f, 'gam_p', 1200, '2026-09-10', 'GAM PAYOUT')
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'gam_p', postedDate: '2026-09-10', amount: 1200, description: 'GAM PAYOUT', status: 'pending' },
    ])
    expect(await row('gam_p')).toMatchObject({ status: 'needs_review', bank_status: 'pending' })
    expect(await autoMatchLandlord(f.landlordId)).toBe(0)

    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'gam_p', postedDate: '2026-09-10', amount: 1200, description: 'GAM PAYOUT', status: 'posted' },
    ])
    expect(await row('gam_p')).toMatchObject({ status: 'matched', bank_status: 'posted' })
  })

  it('does not settle a tenant’s reported rent until the bank posts it', async () => {
    const f = await seed()
    const today = (await db.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d as string
    const c = await db.connect()
    let rentId: string
    try {
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId: f.unitA, landlordId: f.landlordId, rentAmount: 250 })
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      rentId = (await c.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,'rent',250,'pending',CURRENT_DATE,'RENT') RETURNING id`,
        [f.unitA, leaseId, tenantId, f.landlordId])).rows[0].id
      await c.query(
        `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method)
         VALUES ($1,$2,$3,250,CURRENT_DATE,'cash')`, [tenantId, leaseId, f.landlordId])
    } finally { c.release() }
    const rentStatus = async () => (await db.query(`SELECT status FROM payments WHERE id = $1`, [rentId])).rows[0].status

    await legacyDeposit(f, 'cash_p', 250, today, 'ATM CASH DEPOSIT')
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'cash_p', postedDate: today, amount: 250, description: 'ATM CASH DEPOSIT', status: 'pending' },
    ])
    expect(await autoSettleDeclaredDeposits(f.landlordId)).toBe(0)
    expect(await rentStatus()).toBe('pending')
    expect((await row('cash_p')).status).toBe('needs_review')

    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'cash_p', postedDate: today, amount: 250, description: 'ATM CASH DEPOSIT', status: 'posted' },
    ])
    expect(await rentStatus()).toBe('settled')
    expect((await row('cash_p')).status).toBe('matched')
  })
})

describe('what a matched row was matched to', () => {
  it('a GAM payout row lists the payments it carried', async () => {
    const f = await seed()
    const c = await db.connect()
    let tenantId: string, paymentId: string
    try {
      tenantId = await seedTenant(c)
      paymentId = await seedRentPayment(c, { unitId: f.unitA, tenantId, landlordId: f.landlordId, amount: 589 })
    } finally { c.release() }
    const disbId = await seedDisbursement(f.landlordId, 589, '2026-09-10')
    const intent = (await db.query(
      `INSERT INTO platform_transfer_intents
         (landlord_id, landlord_user_id, destination_connect_account_id, amount, gross_owed, status,
          stripe_transfer_id, transferred_at, disbursement_id)
       VALUES ($1,$2,'acct_x',589,589,'transferred','tr_1','2026-09-08',$3) RETURNING id`,
      [f.landlordId, f.llUser, disbId])).rows[0].id
    await db.query(
      `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, reference_id, reference_type, stripe_transfer_id)
       VALUES ($1,'allocation_owner_share',589,589,$2,'payment','tr_1')`, [f.llUser, paymentId])
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'payout', postedDate: '2026-09-11', amount: 589, description: 'GOLD ASSET MGMT' },
    ])
    const [t] = await listTransactions(f.landlordId, { status: 'matched' })
    expect(t.match_kind).toBe('gam_payout')
    expect(t.payout_breakdown.traced).toBe(true)
    expect(t.payout_breakdown.payments).toHaveLength(1)
    expect(t.payout_breakdown.payments[0]).toMatchObject({ paymentId, intentId: intent, what: 'Rent', amount: 589 })
    expect(t.payout_breakdown.summary).toMatch(/^\$589\.00 from GAM — 1 payment: .* rent \$589\.00$/)
  })

  it('a tenant’s own deposit is labeled as one, not as a GAM payout', async () => {
    const f = await seed()
    const c = await db.connect()
    let paymentId: string
    try {
      const tenantId = await seedTenant(c)
      paymentId = await seedRentPayment(c, { unitId: f.unitA, tenantId, landlordId: f.landlordId, amount: 666.5 })
    } finally { c.release() }
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'cash', postedDate: '2026-09-07', amount: 666.5, description: 'DEPOSIT' },
    ])
    await db.query(`UPDATE bank_transactions SET status='matched', matched_payment_id=$2 WHERE external_id='cash' AND landlord_id=$1`,
      [f.landlordId, paymentId])
    const [t] = await listTransactions(f.landlordId, { status: 'matched' })
    expect(t.match_kind).toBe('tenant_deposit')
    expect(t.matched_tenant_name).toBe('Test Tenant')
    expect(t.payout_breakdown).toBeUndefined()
  })
})

describe('categorize', () => {
  it('categorizing an outflow creates a unit expense, flips status, and remembers the merchant', async () => {
    const f = await seed()
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'out_hd', postedDate: '2026-08-10', amount: -250, description: 'HOME DEPOT #1234 AZ' },
    ])
    const [txn] = await listTransactions(f.landlordId, { status: 'needs_review' })
    const res = await categorizeTransaction(f.landlordId, txn.id, {
      category: 'maintenance', scopeKind: 'unit', unitId: f.unitA,
    })
    expect(res.expenseId).toBeTruthy()
    // Expense landed in the P&L.
    expect(await landlordExpensesTotal(f.landlordId, '2026-08-01', '2026-08-31')).toBe(250)
    // Txn flipped.
    const after = await db.query(`SELECT status, expense_id FROM bank_transactions WHERE id=$1`, [txn.id])
    expect(after.rows[0].status).toBe('categorized')
    expect(after.rows[0].expense_id).toBe(res.expenseId)
    // Merchant remembered.
    const sug = await suggestForMerchant(f.landlordId, 'HOME DEPOT AZ')
    expect(sug?.category).toBe('maintenance')
    expect(sug?.scopeKind).toBe('unit')
    expect(sug?.unitId).toBe(f.unitA)
  })

  it('property_allocate scope creates a common expense divided across units', async () => {
    const f = await seed()   // 2 units
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'ins', postedDate: '2026-08-10', amount: -600, description: 'STATE FARM INS' },
    ])
    const [txn] = await listTransactions(f.landlordId, { status: 'needs_review' })
    await categorizeTransaction(f.landlordId, txn.id, {
      category: 'insurance', scopeKind: 'property_allocate', propertyId: f.propertyId,
    })
    expect(await unitAllocatedExpenses(f.unitA, '2026-08-01', '2026-08-31')).toBe(300)
    expect(await unitAllocatedExpenses(f.unitB, '2026-08-01', '2026-08-31')).toBe(300)
  })

  it('second categorize of same merchant bumps hit_count and updates the remembered choice', async () => {
    const f = await seed()
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'hd1', postedDate: '2026-08-10', amount: -50, description: 'HOME DEPOT #1 AZ' },
      { externalId: 'hd2', postedDate: '2026-08-12', amount: -70, description: 'HOME DEPOT #2 AZ' },
    ])
    const rows = await listTransactions(f.landlordId, { status: 'needs_review' })
    await categorizeTransaction(f.landlordId, rows[0].id, { category: 'maintenance', scopeKind: 'unit', unitId: f.unitA })
    await categorizeTransaction(f.landlordId, rows[1].id, { category: 'repairs', scopeKind: 'unit', unitId: f.unitB })
    const sug = await suggestForMerchant(f.landlordId, 'HOME DEPOT AZ')
    expect(sug?.hitCount).toBe(2)
    expect(sug?.category).toBe('repairs')   // most recent choice wins
    expect(sug?.unitId).toBe(f.unitB)
  })

  // S605 (Nic): "if the only option is to ignore it, why are we even showing it
  // on this page?" — inbound money used to be rejected outright, which meant any
  // income GAM didn't collect (laundry, an insurance claim, cash rent deposited)
  // could never reach the P&L. It now books to landlord_other_income.
  it('categorizes an inbound (money-in) transaction as income', async () => {
    const f = await seed()
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'in_x', postedDate: '2026-08-10', amount: 500, description: 'COINMACH LAUNDRY' },
    ])
    const [txn] = await listTransactions(f.landlordId, { status: 'needs_review' })
    const res = await categorizeTransaction(f.landlordId, txn.id,
      { category: 'laundry', scopeKind: 'unit', unitId: f.unitA })
    expect(res.incomeId).toBeTruthy()
    expect(res.expenseId).toBeUndefined()   // must NOT land on the expense side

    const [inc] = await query<any>('SELECT * FROM landlord_other_income WHERE id = $1', [res.incomeId])
    expect(Number(inc.amount)).toBe(500)    // stored positive, not as a negative expense
    expect(inc.category).toBe('laundry')
  })

  // The sign of the amount decides the side, so neither category set may cross
  // over — otherwise a deposit could be filed as 'repairs' and quietly reduce
  // reported profit instead of raising it.
  it('refuses an income category on money out, and an expense category on money in', async () => {
    const f = await seed()
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'out_y', postedDate: '2026-08-10', amount: -80, description: 'ACE HARDWARE' },
      { externalId: 'in_y', postedDate: '2026-08-10', amount: 80, description: 'DEPOSIT' },
    ])
    const txns = await listTransactions(f.landlordId, { status: 'needs_review' })
    const out = txns.find((t: any) => Number(t.amount) < 0)
    const inn = txns.find((t: any) => Number(t.amount) > 0)

    await expect(categorizeTransaction(f.landlordId, out.id,
      { category: 'laundry', scopeKind: 'unit', unitId: f.unitA })).rejects.toThrow(/expense category/i)
    await expect(categorizeTransaction(f.landlordId, inn.id,
      { category: 'repairs', scopeKind: 'unit', unitId: f.unitA })).rejects.toThrow(/income category/i)
  })

  // Money GAM already sent the landlord reaches the P&L through `payments`.
  // Booking it again here would report the same rent twice.
  it('refuses to book a matched GAM disbursement as income', async () => {
    const f = await seed()
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'in_matched', postedDate: '2026-08-10', amount: 500, description: 'GAM PAYOUT' },
    ])
    const [txn] = await query<any>(
      `UPDATE bank_transactions SET status='matched' WHERE landlord_id=$1 AND external_id='in_matched' RETURNING *`,
      [f.landlordId])
    await expect(categorizeTransaction(f.landlordId, txn.id,
      { category: 'other', scopeKind: 'unit', unitId: f.unitA })).rejects.toThrow(/double/i)
  })

  it('unit scope requires a unit; property scope requires a property', async () => {
    const f = await seed()
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'o1', postedDate: '2026-08-10', amount: -10, description: 'X' },
    ])
    const [txn] = await listTransactions(f.landlordId, { status: 'needs_review' })
    await expect(categorizeTransaction(f.landlordId, txn.id, { category: 'other', scopeKind: 'unit' }))
      .rejects.toThrow(/unit is required/i)
  })
})

describe('ignore + suggestion attach', () => {
  it('ignore removes a txn from the review queue', async () => {
    const f = await seed()
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'ig', postedDate: '2026-08-10', amount: -10, description: 'X' },
    ])
    const [txn] = await listTransactions(f.landlordId, { status: 'needs_review' })
    await ignoreTransaction(f.landlordId, txn.id)
    const queue = await listTransactions(f.landlordId, { status: 'needs_review' })
    expect(queue.length).toBe(0)
  })

  it('listTransactions attaches the remembered suggestion to a matching merchant row', async () => {
    const f = await seed()
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'a', postedDate: '2026-08-10', amount: -40, description: 'HOME DEPOT #1 AZ' },
    ])
    let [txn] = await listTransactions(f.landlordId, { status: 'needs_review' })
    await categorizeTransaction(f.landlordId, txn.id, { category: 'maintenance', scopeKind: 'unit', unitId: f.unitA })
    // A second charge from the same merchant should carry the suggestion.
    await upsertTransactions(f.connectionId, f.landlordId, [
      { externalId: 'b', postedDate: '2026-08-13', amount: -60, description: 'HOME DEPOT #7 AZ' },
    ])
    const [next] = await listTransactions(f.landlordId, { status: 'needs_review' })
    expect(next.suggested_category).toBe('maintenance')
    expect(next.suggested_scope_kind).toBe('unit')
    expect(next.suggested_unit_id).toBe(f.unitA)
  })
})
