// S570: bank feed — idempotent sync, auto-match to GAM disbursements, categorize
// → expense + merchant memory, suggestion recall, outflow-only guard, ignore.
// Pure-DB paths (no Stripe): the Stripe boundary is only createLinkSession /
// finalize / syncConnection's pull, which are exercised in the route/integration
// layer; here we drive upsertTransactions directly with normalized rows.
import { describe, it, expect, beforeEach } from 'vitest'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import {
  upsertTransactions, autoMatchLandlord, categorizeTransaction, ignoreTransaction,
  suggestForMerchant, normalizeMerchant, listTransactions,
} from './bankFeed'
import { landlordExpensesTotal, unitAllocatedExpenses } from './landlordExpenses'

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
