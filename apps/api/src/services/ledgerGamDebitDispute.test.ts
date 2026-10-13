/**
 * 10/13 (Nic) — GAM Books ledger: a GAM fee pull the landlord's bank disputes
 * posts to the books.
 *
 *   Nic, 10/13: "GAM fee pull disputed by landlord's bank: AUTOMATIC — the
 *   disputed fees reopen as owed by the landlord, collected on the next pull,
 *   admin told."
 *
 * The money side (services/landlordGamDebit handleGamDebitDispute) reopens the
 * fees, voids the pull's own $6 and bills what the dispute cost at cost. The
 * books follow: the pull posts a second posting of its own on the dispute's
 * day — Dr Outstanding checks and debits (2015, the money coming back) / Cr
 * Due to GAM (2080, owed again) for everything the pull had paid — and the
 * voided $6 and the dispute's cost post through their own charges. Through a
 * pull, its bank line, the dispute and the next pull that collects again, Due
 * to GAM equals what the landlord owes, 2015 equals what the bank still has to
 * clear, debits equal credits, and the nightly check finds no integrity
 * problem and no drift. Real tables, real capture triggers, the production
 * projectors and checks; Stripe is stubbed.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'

const stripeCreate = vi.hoisted(() => vi.fn(async (): Promise<any> => ({ id: 'pi_unused', status: 'processing' })))
/** Stripe's own fee on a pull: $0.27 (its charge's balance transaction). */
const stripeRetrieve = vi.hoisted(() => vi.fn(async (id: string): Promise<any> => (
  { id, latest_charge: { id: `ch_${id}`, balance_transaction: { fee: 27 }, failure_balance_transaction: null } })))
const disputeRetrieve = vi.hoisted(() => vi.fn(async (id: string): Promise<any> => ({ id, balance_transactions: [] })))
vi.mock('stripe', () => {
  function FakeStripe(this: any) {
    this.paymentIntents = { create: stripeCreate, retrieve: stripeRetrieve, cancel: vi.fn(async (id: string) => ({ id })) }
    this.disputes = { retrieve: disputeRetrieve }
  }
  return { default: FakeStripe }
})
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig() as any),
  getStripe: () => ({ paymentIntents: { create: stripeCreate, retrieve: stripeRetrieve }, disputes: { retrieve: disputeRetrieve } }),
}))

import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { ledgerCompany, postingsOf, linesOf, outboxCount, roleNet, companyToday, type LedgerCompany } from '../test/ledgerFixtures'
import { chargeLandlord, outstandingForLandlord } from './landlordGamAccount'
import { debitLandlordForCharges, settleGamDebit, handleGamDebitDispute } from './landlordGamDebit'
import { matchLineToRecord } from './bankMoneyOut'
import { drainLedgerOutbox, ledgerProjectorFor } from './ledgerEngine'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from './ledgerProjectors'
import { checkOwner } from './ledgerCheck'
import { rebuildOwner } from './ledgerRebuild'
import { dueToGamCheck } from './ledgerProjectors/payoutChecks'
import { outstandingChecksCheck } from './ledgerTenantChecks'
import { ledgerCashFlow } from './ledgerReports'

beforeEach(async () => {
  await cleanupAllSchema()
  registerProductionLedgerProjectors()
  stripeCreate.mockClear()
  stripeRetrieve.mockClear()
})
afterEach(() => unregisterProductionLedgerProjectors())

/** Oak Park: GAM's fees pulled from its bank (a $40 threshold), company-level costs in a Company column. */
async function oakPark(): Promise<LedgerCompany & { connectionId: string }> {
  const co = await ledgerCompany()
  await db.query(
    `UPDATE landlords SET books_company_costs_method = 'company_bucket', gam_debit_payment_method_id = 'pm_test_bank',
                          stripe_fc_customer_id = 'cus_test' WHERE id = $1`, [co.landlordId])
  await db.query(`UPDATE properties SET gam_debit_threshold = 40 WHERE landlord_id = $1`, [co.landlordId])
  const connectionId = (await db.query<{ id: string }>(
    `INSERT INTO bank_connections (landlord_id, provider, status, display_name) VALUES ($1, 'stripe_fc', 'active', 'Operating') RETURNING id`,
    [co.landlordId])).rows[0].id
  return { ...co, connectionId }
}

/** A pull made the way the nightly sweep makes it, and its success as the webhook records it. */
async function pullAndSettle(co: LedgerCompany, pi: string): Promise<{ debitId: string; total: number }> {
  stripeCreate.mockResolvedValueOnce({ id: pi, status: 'processing' })
  const made = await debitLandlordForCharges(co.landlordId)
  expect(made.status).toBe('debited')
  await settleGamDebit(pi, true, undefined, made.debitId)
  return { debitId: made.debitId!, total: made.total! }
}

const tag = (co: LedgerCompany, p: string | null) => (p === co.propertyId ? 'p1' : p === co.propertyId2 ? 'p2' : p)
/** The active postings of a source: kind, day, and each line as [role, property, debit, credit]. */
async function posted(co: LedgerCompany, sourceType: string, sourceId: string) {
  const out: { kind: string; day: string; memo: string | null; lines: (string | number | null)[][] }[] = []
  for (const p of (await postingsOf(sourceType, sourceId)).filter(x => x.role === 'post' && !x.superseded_at)) {
    const memo = (await db.query<{ memo: string | null }>(`SELECT memo FROM ledger_postings WHERE id = $1`, [p.id])).rows[0].memo
    out.push({ kind: p.posting_kind, day: p.intended_date, memo,
      lines: (await linesOf(p.id)).map(l => [l.account_role, tag(co, l.property_id), Number(l.debit), Number(l.credit)]) })
  }
  return out
}

/** The nightly check finds nothing wrong; a dry-run rebuild finds no drift; debits equal credits. */
async function clean(co: LedgerCompany): Promise<void> {
  const check = await checkOwner(co.owner)
  expect(check.findings.filter(f => f.severity === 'integrity' || f.severity === 'drift')).toEqual([])
  expect(check.repaired).toBe(0)
  expect((await rebuildOwner(co.owner, { mode: 'dry_run' })).counts.drift).toBe(0)
  const b = (await db.query<{ dr: string; cr: string }>(
    `SELECT COALESCE(sum(debit), 0)::text AS dr, COALESCE(sum(credit), 0)::text AS cr FROM ledger_posting_lines WHERE landlord_id = $1`,
    [co.landlordId])).rows[0]
  expect(b.dr).toBe(b.cr)
}

describe('a GAM fee pull the landlord\'s bank disputes', () => {
  it('posts the money coming back and the fees owed again; Due to GAM and 2015 tie at every step through the next pull', async () => {
    const co = await oakPark()
    const today = await companyToday()
    // Oak Park's $48 platform fee, pulled with its $6 transfer cost: $54.
    await chargeLandlord(null, { landlordId: co.landlordId, propertyId: co.propertyId, kind: 'subscription', amount: 48,
      sourceType: 'test_platform_fee', sourceId: randomUUID() })
    const sep = await pullAndSettle(co, 'pi_gam_pull_sep')
    expect(sep.total).toBe(54)
    await drainLedgerOutbox()
    expect(await roleNet(co.landlordId, 'due_to_gam')).toBe(0)
    expect(await roleNet(co.landlordId, 'outstanding_checks')).toBe(54)   // owed to the bank until its line matches
    await clean(co)

    // The pull's bank line matches it: 2015 clears.
    const out = (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, normalized_merchant, status, bank_status)
       VALUES ($1, $2, $3, $4, -54.00, 'GAM FEES', 'GAM FEES', 'needs_review', 'posted') RETURNING id`,
      [co.connectionId, co.landlordId, randomUUID(), today])).rows[0].id
    await matchLineToRecord({ landlordId: co.landlordId, lineId: out, kind: 'gam_debit', recordId: sep.debitId, by: null })
    await drainLedgerOutbox()
    expect(await roleNet(co.landlordId, 'outstanding_checks')).toBe(0)
    const bankLine = await posted(co, 'bank_match', out)
    // The cash flow reads the $54 that left the bank as what it paid: GAM's fees.
    const cashFlow = () => ledgerCashFlow({ landlordIds: [co.landlordId] }, `${today.slice(0, 7)}-01`, today)
    const paidMonth = await cashFlow()
    expect(paidMonth.rows).toEqual([{ section: 'operating', key: 'GAM fees and charges', label: 'GAM fees and charges', amount: -54 }])
    await clean(co)

    // The landlord's bank disputes the pull: the $48 is owed again, the $6 is voided, the dispute's $15.27 billed at cost.
    expect(await handleGamDebitDispute({
      paymentIntentId: 'pi_gam_pull_sep', stripeDisputeId: 'du_sep', disputeStatus: 'needs_response', eventStatus: 'needs_response',
      disputedCents: 5400, feeCents: 1500, feeStated: true,
    })).toMatchObject({ handled: true, action: 'reopened', reopened: 48, costBilled: 15.27 })
    expect(await outstandingForLandlord(co.landlordId)).toBe(63.27)
    // Stamping the pull disputed marks the pull itself for posting (its capture reads disputed_at).
    expect(await outboxCount('gam_debit', sep.debitId)).toBeGreaterThan(0)
    // Until it posts, the tie-outs see the difference as waiting, never drift.
    const c = await db.connect()
    try {
      expect((await dueToGamCheck.run(c, co.owner)).map(f => [f.check, f.severity])).toEqual([['p5_due_to_gam', 'pending']])
      expect((await outstandingChecksCheck.run(c, co.owner)).map(f => [f.check, f.severity])).toEqual([['outstanding_checks', 'pending']])
    } finally { c.release() }

    await drainLedgerOutbox()
    expect(await posted(co, 'gam_debit', sep.debitId)).toEqual([
      { kind: 'main', day: today, memo: 'GAM fees paid by bank pull', lines: [
        ['due_to_gam', null, 6, 0], ['outstanding_checks', null, 0, 6],
        ['due_to_gam', 'p1', 48, 0], ['outstanding_checks', 'p1', 0, 48],
      ] },
      { kind: 'cancellation', day: today, memo: 'GAM fee pull your bank disputed: the money comes back and the charges are owed again', lines: [
        ['outstanding_checks', null, 6, 0], ['due_to_gam', null, 0, 6],
        ['outstanding_checks', 'p1', 48, 0], ['due_to_gam', 'p1', 0, 48],
      ] },
    ])
    // The pull's own posting was never re-posted: one 'main' posting, no reversal.
    expect((await postingsOf('gam_debit', sep.debitId)).map(p => [p.role, p.posting_kind])).toEqual([['post', 'main'], ['post', 'cancellation']])
    // What the dispute cost GAM is its own charge, and says what happened.
    const costCharge = (await db.query<{ dispute_cost_charge_id: string }>(
      `SELECT dispute_cost_charge_id FROM landlord_gam_debits WHERE id = $1`, [sep.debitId])).rows[0].dispute_cost_charge_id
    expect(await posted(co, 'gam_charge', costCharge)).toEqual([{ kind: 'main', day: today,
      memo: 'What a bank pull of GAM\'s fees your bank disputed cost',
      lines: [['chargeback_fees', null, 15.27, 0], ['due_to_gam', null, 0, 15.27]] }])
    // Due to GAM is what the landlord owes again; 2015 holds the $54 coming back.
    expect(await roleNet(co.landlordId, 'due_to_gam')).toBe(63.27)
    expect(await roleNet(co.landlordId, 'outstanding_checks')).toBe(-54)
    // The pull's bank line still clears the pull, and only the pull.
    expect(await posted(co, 'bank_match', out)).toEqual(bankLine)
    // 10/13 (Nic): the month the pull was paid reads the same after the
    // dispute — the dispute's own posting is the money coming back, never what
    // the bank line paid (it does not move cash until the return's bank line).
    expect(await cashFlow()).toEqual(paidMonth)
    await clean(co)

    // Collected again on the next pull: the $48, the $15.27 and the new pull's own $6.
    const oct = await pullAndSettle(co, 'pi_gam_pull_oct')
    expect(oct.total).toBe(69.27)
    await drainLedgerOutbox()
    expect(await outstandingForLandlord(co.landlordId)).toBe(0)
    expect(await roleNet(co.landlordId, 'due_to_gam')).toBe(0)
    // 2015: the new pull until its line matches, less the disputed $54 still coming back.
    expect(await roleNet(co.landlordId, 'outstanding_checks')).toBe(15.27)
    await clean(co)
  })

  it('a pull paid months before its dispute: the dispute posts on its own day, and the pull is listed for any range the dispute falls in', async () => {
    const co = await oakPark()
    await chargeLandlord(null, { landlordId: co.landlordId, propertyId: co.propertyId2, kind: 'subscription', amount: 48,
      sourceType: 'test_platform_fee', sourceId: randomUUID() })
    const sep = await pullAndSettle(co, 'pi_gam_pull_old')
    // The pull went through long ago; the dispute is today.
    await db.query(`UPDATE landlord_gam_debits SET settled_at = '2026-03-10 18:00:00+00' WHERE id = $1`, [sep.debitId])
    await handleGamDebitDispute({
      paymentIntentId: 'pi_gam_pull_old', stripeDisputeId: 'du_old', disputeStatus: 'needs_response', eventStatus: 'needs_response',
      disputedCents: 5400, feeCents: 1500, feeStated: true,
    })
    await drainLedgerOutbox()
    const today = await companyToday()
    const c = await db.connect()
    try {
      const refs = await ledgerProjectorFor('gam_debit')!.listSources(c, co.owner, { since: today })
      expect(refs.map(r => [r.id, r.day])).toEqual([[sep.debitId, '2026-03-10']])
    } finally { c.release() }
    expect((await posted(co, 'gam_debit', sep.debitId)).map(p => [p.kind, p.day]).sort())
      .toEqual([['cancellation', today], ['main', '2026-03-10']])
    expect(await roleNet(co.landlordId, 'due_to_gam')).toBe(63.27)
    await clean(co)
  })

  it('posts once: a webhook retry, a rebuild and a rebuild from scratch change nothing', async () => {
    const co = await oakPark()
    await chargeLandlord(null, { landlordId: co.landlordId, propertyId: co.propertyId, kind: 'subscription', amount: 48,
      sourceType: 'test_platform_fee', sourceId: randomUUID() })
    const sep = await pullAndSettle(co, 'pi_gam_pull_retry')
    await drainLedgerOutbox()
    const dispute = {
      paymentIntentId: 'pi_gam_pull_retry', stripeDisputeId: 'du_retry', disputeStatus: 'needs_response', eventStatus: 'needs_response',
      disputedCents: 5400, feeCents: 1500, feeStated: true,
    }
    expect(await handleGamDebitDispute(dispute)).toMatchObject({ action: 'reopened', reopened: 48, costBilled: 15.27 })
    await drainLedgerOutbox()
    const costCharge = (await db.query<{ dispute_cost_charge_id: string }>(
      `SELECT dispute_cost_charge_id FROM landlord_gam_debits WHERE id = $1`, [sep.debitId])).rows[0].dispute_cost_charge_id
    /** Everything the company's books hold, as stored: each posting and its lines. */
    const books = async () => (await db.query(
      `SELECT p.id, p.source_type, p.source_id, p.posting_kind, p.role, p.superseded_at IS NULL AS active,
              p.intended_date::text AS day, p.accounting_date::text AS booked,
              json_agg(json_build_array(l.line_no, l.account_id, l.property_id, l.debit::text, l.credit::text) ORDER BY l.line_no) AS lines
         FROM ledger_postings p JOIN ledger_posting_lines l ON l.posting_id = p.id
        WHERE p.landlord_id = $1 GROUP BY p.id ORDER BY p.id`, [co.landlordId])).rows
    const before = await books()
    /** A source's active postings by kind (one transaction posts them in no set order). */
    const byKind = async (sourceType: string, sourceId: string) =>
      (await posted(co, sourceType, sourceId)).sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
    const pull = await byKind('gam_debit', sep.debitId)
    const cost = await byKind('gam_charge', costCharge)
    expect(pull.map(p => p.kind)).toEqual(['cancellation', 'main'])
    const owed = await roleNet(co.landlordId, 'due_to_gam')
    const coming = await roleNet(co.landlordId, 'outstanding_checks')
    // No bank line matched either way: the pull owed to the bank and the money coming back net in 2015.
    expect([owed, coming]).toEqual([63.27, 0])
    await clean(co)

    // Stripe sends the same event again: nothing reopens twice, nothing posts twice.
    expect(await handleGamDebitDispute(dispute)).toMatchObject({ handled: true, action: 'already_reopened' })
    // ... and the dispute moving on (Stripe reviewing it) changes nothing either.
    expect(await handleGamDebitDispute({ ...dispute, disputeStatus: 'under_review', eventStatus: 'under_review' }))
      .toMatchObject({ handled: true, action: 'already_reopened' })
    await drainLedgerOutbox()
    expect(await outstandingForLandlord(co.landlordId)).toBe(63.27)
    expect(await books()).toEqual(before)

    // A rebuild finds every posting already right.
    const apply = await rebuildOwner(co.owner, { mode: 'apply' })
    expect(apply.status).toBe('done')
    expect(apply.counts).toMatchObject({ posted: 0, reversed: 0, failed: 0, drift: 0 })
    expect(await books()).toEqual(before)
    await clean(co)

    // A rebuild from scratch re-posts everything — to exactly what it was.
    const scratch = await rebuildOwner(co.owner, { mode: 'from_scratch' })
    expect(scratch.status).toBe('done')
    expect(scratch.counts.failed).toBe(0)
    expect(scratch.counts.posted).toBeGreaterThan(0)
    expect(scratch.counts.reversed).toBe(scratch.counts.posted)
    expect(await byKind('gam_debit', sep.debitId)).toEqual(pull)
    expect(await byKind('gam_charge', costCharge)).toEqual(cost)
    expect(await roleNet(co.landlordId, 'due_to_gam')).toBe(owed)
    expect(await roleNet(co.landlordId, 'outstanding_checks')).toBe(coming)
    await clean(co)
  })
})
