/**
 * 10/13 (Nic) — GAM Books ledger: a record that arrives AFTER its account was
 * deleted posts to the account that took its place.
 *
 *   Nic, 10/13: a landlord deletes an account (say 'Repairs') and picks a
 *   replacement ('Maintenance'). Open months move to the replacement, closed
 *   months keep the old account. A record dated inside an already-closed month
 *   that arrives after the deletion posts as a correction in the open month to
 *   the REPLACEMENT ("The replacement").
 *
 * A new posting never puts a line on a deleted account (a reversal still
 * negates what it takes back line for line, on the account it was posted to);
 * a posting already in the books stays as it is only while it sits on a day
 * the deleted account kept (books_accounts.replaced_from: the first open day
 * at the deletion). So:
 *   (a) the late closed-month record lands on the replacement, in the open
 *       month, as a correction — and a closed-month record CHANGED after the
 *       deletion is taken back off the old account and re-posted to the
 *       replacement, in the open month (the engine's line-for-line reversal,
 *       and Nic's "the replacement" for what is written now);
 *   (b) records in open months move (10/12), and so does a correction already
 *       sitting in the open month for a closed-month record;
 *   (c) closed months' own lines never change, nothing reads as drift, and a
 *       month reopened after the deletion keeps what it had while new records
 *       in it go to the replacement.
 * Real tables, real capture triggers, the real engine (the test projector:
 * money filed as other income, Dr Suspense 1099 / Cr Other income 4900; and a
 * bookkeeper's journal entry, which names its account itself).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { inTx, ledgerCompany, addOtherIncome, postingsOf, linesOf, type LedgerCompany } from '../test/ledgerFixtures'
import { drainLedgerOutbox, postSource, registerLedgerProjector, unregisterLedgerProjector, registeredLedgerSourceTypes } from './ledgerEngine'
import { otherIncomeTestProjector } from './ledgerTestProjector'
import { manualJournalProjector } from './ledgerProjectors/manualJournal'
import { retireAccount } from './booksLedgerChart'
import { rebuildOwner } from './ledgerRebuild'
import { checkOwner } from './ledgerCheck'
import { closeMonth, reopenMonth } from './ledgerClose'

beforeEach(async () => {
  await cleanupAllSchema()
  registerLedgerProjector(otherIncomeTestProjector)
  registerLedgerProjector(manualJournalProjector)
})
afterEach(() => {
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
})

async function account(co: LedgerCompany, code: string, name: string, type: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, $2, $3, $4) RETURNING id`,
    [co.landlordId, code, name, type])).rows[0].id
}
const idOfCode = async (co: LedgerCompany, code: string) =>
  (await db.query<{ id: string }>(`SELECT id FROM books_accounts WHERE landlord_id = $1 AND code = $2`, [co.landlordId, code])).rows[0].id
const activeOf = async (sourceType: string, sourceId: string) =>
  (await postingsOf(sourceType, sourceId)).filter(p => p.role === 'post' && !p.superseded_at)
const lineAccounts = async (sourceType: string, sourceId: string) => {
  const active = await activeOf(sourceType, sourceId)
  return (await linesOf(active[0].id)).map(l => l.account_code)
}
/** Every line posted on or before `through` (a closed month's own lines), exactly as stored. */
const linesThrough = async (co: LedgerCompany, through: string) => (await db.query(
  `SELECT id, posting_id, account_id, debit::text AS debit, credit::text AS credit, accounting_date::text AS day
     FROM ledger_posting_lines WHERE landlord_id = $1 AND accounting_date <= $2::date ORDER BY id`, [co.landlordId, through])).rows
/** What an account carries in the open months (credit − debit). */
const openNet = async (accountId: string, after: string) => Number((await db.query<{ n: string }>(
  `SELECT COALESCE(sum(credit - debit), 0)::text AS n FROM ledger_posting_lines WHERE account_id = $1 AND accounting_date > $2::date`,
  [accountId, after])).rows[0].n)
/** Debits = credits, for the company and on every account taken together. */
const balanced = async (co: LedgerCompany) => (await db.query<{ dr: string; cr: string }>(
  `SELECT COALESCE(sum(debit), 0)::text AS dr, COALESCE(sum(credit), 0)::text AS cr FROM ledger_posting_lines WHERE landlord_id = $1`,
  [co.landlordId])).rows[0]
async function clean(co: LedgerCompany): Promise<void> {
  const check = await checkOwner(co.owner)
  expect(check.findings.filter(f => f.severity === 'integrity' || f.severity === 'drift')).toEqual([])
  expect(check.repaired).toBe(0)
  expect((await rebuildOwner(co.owner, { mode: 'dry_run' })).counts.drift).toBe(0)
  const b = await balanced(co)
  expect(b.dr).toBe(b.cr)
}

/** August posted and closed, then 'Other income' (4900) deleted in favor of 4950. */
async function augustClosedThenDeleted(co: LedgerCompany, before?: () => Promise<void>) {
  const aug = await addOtherIncome(co, { amount: 100, day: '2026-08-10' })
  await drainLedgerOutbox()
  await closeMonth({ owner: co.owner, through: '2026-08-31', actorUserId: co.ownerUserId })
  if (before) await before()
  const closed = await linesThrough(co, '2026-08-31')
  const misc = await idOfCode(co, '4900')
  const repl = await account(co, '4950', 'Other income (new)', 'income')
  await retireAccount({ owner: co.owner, accountId: misc, replacementAccountId: repl, actorUserId: co.ownerUserId })
  // 10/22 (Nic): "if there's a race for something to happen first and it's
  // finding out that something is okay if it gets there first and finding out
  // something's not okay if it is a little bit slower, then we need to make it
  // slower... we need to take the conservative approach to make sure things
  // don't get missed."
  //
  // Closing a month and retiring an account both leave work on the ledger
  // outbox. A caller that asks "is this ledger sound?" before that work lands
  // is asking the wrong moment, and gets an answer that depends on how busy
  // the machine is — this file passed alone and failed about one run in three
  // under the deploy gate's six workers, on a drift finding that was simply
  // not finished yet.
  //
  // So the setup hands back a ledger that has settled. It is drained here
  // rather than in each test, because every test that uses this setup wants
  // the same thing and the one that forgot is exactly how this got through.
  await drainLedgerOutbox()
  return { aug, closed, misc, repl }
}

describe('(a) a record dated in a closed month that arrives after its account was deleted', () => {
  it('posts to the replacement, in the open month, as a correction; the closed month keeps every line it had', async () => {
    const co = await ledgerCompany()
    const { aug, closed, misc, repl } = await augustClosedThenDeleted(co)
    // The replacement took over from the first open day; the deletion is stamped with it.
    expect((await db.query(`SELECT replaced_by_account_id, replaced_from::text AS f FROM books_accounts WHERE id = $1`, [misc])).rows[0])
      .toEqual({ replaced_by_account_id: repl, f: '2026-09-01' })

    // Entered after the deletion, dated inside closed August.
    const late = await addOtherIncome(co, { amount: 7, day: '2026-08-20' })
    await drainLedgerOutbox()
    const ps = await postingsOf('other_income', late)
    expect(ps.map(p => [p.role, p.intended_date, p.accounting_date, p.is_correction])).toEqual([
      ['post', '2026-08-20', '2026-09-01', true],
    ])
    expect(await lineAccounts('other_income', late)).toEqual(['1099', '4950'])
    // Nothing new lands on the deleted account; August's own lines are as they were.
    expect(await openNet(misc, '2026-08-31')).toBe(0)
    expect(await openNet(repl, '2026-08-31')).toBe(7)
    expect(await linesThrough(co, '2026-08-31')).toEqual(closed)
    expect(await lineAccounts('other_income', aug)).toEqual(['1099', '4900'])

    await clean(co)
    // Posted again, nothing moves: the closed record keeps the deleted account, the late one keeps the replacement.
    expect(await postSource('other_income', aug)).toMatchObject({ posted: 0, reversed: 0, unchanged: 1 })
    expect(await postSource('other_income', late)).toMatchObject({ posted: 0, reversed: 0, unchanged: 1 })
  })

  it('a closed-month record CHANGED after the deletion is taken off the old account and re-posted to the replacement, both in the open month', async () => {
    const co = await ledgerCompany()
    const { aug, closed, misc, repl } = await augustClosedThenDeleted(co)
    await db.query(`UPDATE landlord_other_income SET amount = 120 WHERE id = $1`, [aug])
    await drainLedgerOutbox()
    const ps = await postingsOf('other_income', aug)
    expect(ps.map(p => [p.role, p.intended_date, p.accounting_date, p.is_correction])).toEqual([
      ['post', '2026-08-10', '2026-08-10', false],
      ['reversal', '2026-08-10', '2026-09-01', true],
      ['post', '2026-08-10', '2026-09-01', true],
    ])
    // The reversal takes back exactly what August posted, on the account it was posted to.
    expect((await linesOf(ps[1].id)).map(l => [l.account_code, l.debit, l.credit])).toEqual([['1099', '0.00', '100.00'], ['4900', '100.00', '0.00']])
    expect((await linesOf(ps[2].id)).map(l => [l.account_code, l.debit, l.credit])).toEqual([['1099', '120.00', '0.00'], ['4950', '0.00', '120.00']])
    expect(await linesThrough(co, '2026-08-31')).toEqual(closed)
    expect(await openNet(misc, '2026-08-31')).toBe(-100)
    expect(await openNet(repl, '2026-08-31')).toBe(120)
    await clean(co)
  })

  it('a bookkeeper\'s journal entry in a closed month keeps the deleted account it names — never drift; an open month\'s moves', async () => {
    const co = await ledgerCompany()
    const odd = await account(co, '5901', 'Odd jobs', 'expense')
    const cash = await account(co, '1001', 'Petty cash', 'asset')
    const entry = (date: string, n: number) => inTx(async c => {
      const e = (await c.query<{ id: string }>(
        `INSERT INTO journal_entries (landlord_id, entry_number, date, description) VALUES ($1, $2, $3, 'Odd job') RETURNING id`,
        [co.landlordId, n, date])).rows[0].id
      await c.query(`INSERT INTO journal_entry_lines (entry_id, account_id, debit) VALUES ($1, $2, 40)`, [e, odd])
      await c.query(`INSERT INTO journal_entry_lines (entry_id, account_id, credit) VALUES ($1, $2, 40)`, [e, cash])
      return e
    })
    const aug = await entry('2026-08-05', 1)
    const sep = await entry('2026-09-05', 2)
    await drainLedgerOutbox()
    await closeMonth({ owner: co.owner, through: '2026-08-31', actorUserId: co.ownerUserId })
    const closed = await linesThrough(co, '2026-08-31')
    const oddNew = await account(co, '5902', 'Odd jobs (new)', 'expense')
    await retireAccount({ owner: co.owner, accountId: odd, replacementAccountId: oddNew, actorUserId: co.ownerUserId })
    await drainLedgerOutbox()
    expect((await lineAccounts('manual_journal', aug)).sort()).toEqual(['1001', '5901'])
    expect((await lineAccounts('manual_journal', sep)).sort()).toEqual(['1001', '5902'])
    expect(await linesThrough(co, '2026-08-31')).toEqual(closed)
    await clean(co)
  })
})

describe('(b) open months move to the replacement', () => {
  it('a record in an open month moves, and so does a correction already in the open month for a closed-month record', async () => {
    const co = await ledgerCompany()
    let lateBefore = ''
    const { aug, closed, misc, repl } = await augustClosedThenDeleted(co, async () => {
      // Entered after August closed but BEFORE the deletion: a correction on September 1, on 4900.
      lateBefore = await addOtherIncome(co, { amount: 9, day: '2026-08-25' })
      await drainLedgerOutbox()
      expect(await lineAccounts('other_income', lateBefore)).toEqual(['1099', '4900'])
    })
    const sep = await addOtherIncome(co, { amount: 50, day: '2026-09-10' })
    await drainLedgerOutbox()
    expect(await lineAccounts('other_income', sep)).toEqual(['1099', '4950'])
    // The open month's correction moved with the open months, keeping its dates.
    expect(await lineAccounts('other_income', lateBefore)).toEqual(['1099', '4950'])
    expect((await activeOf('other_income', lateBefore)).map(p => [p.intended_date, p.accounting_date, p.is_correction]))
      .toEqual([['2026-08-25', '2026-09-01', true]])
    expect(await lineAccounts('other_income', aug)).toEqual(['1099', '4900'])
    expect(await openNet(misc, '2026-08-31')).toBe(0)
    expect(await openNet(repl, '2026-08-31')).toBe(59)
    expect(await linesThrough(co, '2026-08-31')).toEqual(closed)
    await clean(co)
  })
})

describe('(c) closed months never change', () => {
  it('a month reopened after the deletion keeps what it had (never drift); a new record in it goes to the replacement', async () => {
    const co = await ledgerCompany()
    const { aug, misc, repl } = await augustClosedThenDeleted(co)
    await reopenMonth({ owner: co.owner, month: '2026-08-01', actorUserId: co.ownerUserId, reason: 'A late bill' })
    await clean(co)
    expect(await lineAccounts('other_income', aug)).toEqual(['1099', '4900'])
    const reopened = await addOtherIncome(co, { amount: 11, day: '2026-08-25' })
    await drainLedgerOutbox()
    expect((await activeOf('other_income', reopened)).map(p => [p.intended_date, p.accounting_date, p.is_correction]))
      .toEqual([['2026-08-25', '2026-08-25', false]])
    expect(await lineAccounts('other_income', reopened)).toEqual(['1099', '4950'])
    expect(await openNet(misc, '2026-07-31')).toBe(100)
    expect(await openNet(repl, '2026-07-31')).toBe(11)
    await clean(co)
  })
})
