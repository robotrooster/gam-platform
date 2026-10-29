/**
 * 10/12 (Nic) — GAM Books ledger, phase P3: a FULLY EDITABLE chart that can
 * never orphan or rewrite a posted line.
 *
 *   Nic: "landlords/bookkeepers may rename, add and delete accounts"
 *
 * Automatic postings name a posting role; the company's books_account_map
 * says which account each role posts to, from which day. GAM seeds it; the
 * company may repoint it (from the day it is made — history stays where it was
 * posted); deleting an account the map or posted lines use needs a
 * replacement, and nothing already posted ever moves. The database holds the
 * same rules when anything edits the chart directly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LEDGER_ACCOUNT_ROLE_DEFS } from '@gam/shared'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { inTx, ledgerCompany, addOtherIncome, postingsOf, linesOf, companyToday, outboxCount, type LedgerCompany } from '../test/ledgerFixtures'
import { drainLedgerOutbox, postSource, registerLedgerProjector, unregisterLedgerProjector, registeredLedgerSourceTypes } from './ledgerEngine'
import { otherIncomeTestProjector } from './ledgerTestProjector'
import { ensureChart, repointMapping, retireAccount, currentChartMap } from './booksLedgerChart'
import { rebuildOwner } from './ledgerRebuild'
import { checkOwner } from './ledgerCheck'
import { closeMonth } from './ledgerClose'
import { addDaysIso } from './ledgerOwner'

beforeEach(async () => {
  await cleanupAllSchema()
  registerLedgerProjector(otherIncomeTestProjector)
})
afterEach(() => {
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
})

async function account(co: LedgerCompany, code: string, name: string, type: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, $2, $3, $4) RETURNING id`,
    [co.landlordId, code, name, type])).rows[0].id
}
const accountByCode = async (co: LedgerCompany, code: string) =>
  (await db.query<{ id: string; active: boolean; replaced_by_account_id: string | null; type: string }>(
    `SELECT id, active, replaced_by_account_id, type FROM books_accounts WHERE landlord_id = $1 AND code = $2`, [co.landlordId, code])).rows[0]
const mapped = async (co: LedgerCompany, role: string) =>
  (await currentChartMap(co.owner)).find(m => m.kind === 'role' && m.value === role)!.accountId
const lineAccounts = async (sourceId: string) => {
  const active = (await postingsOf('other_income', sourceId)).filter(p => p.role === 'post' && !p.superseded_at)
  return (await linesOf(active[0].id)).map(l => l.account_code)
}

describe('seeding the chart', () => {
  it('GAM maps every posting role once, reusing an account the company already has at the suggested code and type', async () => {
    const co = await ledgerCompany()
    await db.query(`UPDATE properties SET timezone = 'America/Denver' WHERE landlord_id = $1`, [co.landlordId])
    const misc = await account(co, '4900', 'Misc income', 'income')
    const wrongType = await account(co, '4071', 'Electric (an expense here)', 'expense')
    const id = await addOtherIncome(co, { amount: 10, day: '2026-09-01' })
    await drainLedgerOutbox()

    const map = await currentChartMap(co.owner)
    expect(map.filter(m => m.kind === 'role')).toHaveLength(LEDGER_ACCOUNT_ROLE_DEFS.length)
    expect(await mapped(co, 'other_income')).toBe(misc)
    // A same-code account of another type is left alone; the role gets its own account.
    const electric = await mapped(co, 'utility_electric')
    expect(electric).not.toBe(wrongType)
    const e = (await db.query(`SELECT code, type, parent_account_id FROM books_accounts WHERE id = $1`, [electric])).rows[0]
    expect(e).toEqual({ code: '4071-1', type: 'income', parent_account_id: await mapped(co, 'utility_reimbursements') })
    expect(await lineAccounts(id)).toEqual(['1099', '4900'])
    // The calendar is pinned once the company has posted.
    expect((await db.query(`SELECT books_timezone FROM landlords WHERE id = $1`, [co.landlordId])).rows[0].books_timezone).toBe('America/Denver')

    // Seeding again changes nothing.
    const before = (await db.query(`SELECT count(*)::int AS n FROM books_accounts WHERE landlord_id = $1`, [co.landlordId])).rows[0].n
    await inTx(c => ensureChart(c, co.owner))
    const after = (await db.query(`SELECT count(*)::int AS n FROM books_accounts WHERE landlord_id = $1`, [co.landlordId])).rows[0].n
    expect(after).toBe(before)
    expect((await db.query(`SELECT count(*)::int AS n FROM books_account_map WHERE landlord_id = $1`, [co.landlordId])).rows[0].n)
      .toBe(LEDGER_ACCOUNT_ROLE_DEFS.length)
  })
})

describe('repointing a posting role', () => {
  it('applies from the day it is made: history stays where it was posted, a rebuild comes out the same, new postings use the new account', async () => {
    const co = await ledgerCompany()
    const sept = await addOtherIncome(co, { amount: 100, day: '2026-09-10' })
    await drainLedgerOutbox()
    const store = await account(co, '4950', 'Park store income', 'income')

    const r = await repointMapping({ owner: co.owner, kind: 'role', value: 'other_income', accountId: store, actorUserId: co.ownerUserId })
    expect(r).toEqual({ changed: true, effectiveFrom: await companyToday() })
    expect(await repointMapping({ owner: co.owner, kind: 'role', value: 'other_income', accountId: store, actorUserId: co.ownerUserId }))
      .toMatchObject({ changed: false })

    // History stays: nothing to re-post.
    expect((await rebuildOwner(co.owner, { mode: 'dry_run' })).counts.drift).toBe(0)
    expect(await lineAccounts(sept)).toEqual(['1099', '4900'])
    // A correction to September still books on September's account.
    await db.query(`UPDATE landlord_other_income SET amount = 110 WHERE id = $1`, [sept])
    await drainLedgerOutbox()
    expect(await lineAccounts(sept)).toEqual(['1099', '4900'])
    // Money from today on books to the new account.
    const today = await addOtherIncome(co, { amount: 5, day: await companyToday() })
    await drainLedgerOutbox()
    expect(await lineAccounts(today)).toEqual(['1099', '4950'])
  })

  it('refuses an account of the wrong type, another company\'s, or a deleted one', async () => {
    const co = await ledgerCompany()
    const other = await ledgerCompany()
    await addOtherIncome(co, { amount: 1, day: '2026-09-01' })
    await drainLedgerOutbox()
    const expense = await account(co, '5950', 'An expense', 'expense')
    const theirs = await account(other, '4950', 'Theirs', 'income')
    const gone = await account(co, '4960', 'Gone', 'income')
    await retireAccount({ owner: co.owner, accountId: gone, actorUserId: co.ownerUserId })
    const repoint = (accountId: string) => repointMapping({ owner: co.owner, kind: 'role', value: 'other_income', accountId, actorUserId: co.ownerUserId })
    await expect(repoint(expense)).rejects.toThrow(/needs an income account/)
    await expect(repoint(theirs)).rejects.toThrow(/not found in this company's chart/)
    await expect(repoint(gone)).rejects.toThrow(/is deleted/)
  })
})

describe('repointing reaches postings already made for its first day (10/12 (Nic) review)', () => {
  it('postings dated today or later (a bill posts on its due date) move at the next drain; nothing reads as drift', async () => {
    const co = await ledgerCompany()
    const today = await companyToday()
    const sept = await addOtherIncome(co, { amount: 100, day: '2026-09-10' })
    const same = await addOtherIncome(co, { amount: 5, day: today })
    const later = await addOtherIncome(co, { amount: 6, day: addDaysIso(today, 20) })
    await drainLedgerOutbox()
    const store = await account(co, '4950', 'Park store income', 'income')
    await repointMapping({ owner: co.owner, kind: 'role', value: 'other_income', accountId: store, actorUserId: co.ownerUserId })
    // Marked in the repoint's own transaction.
    expect(await outboxCount('other_income', same)).toBe(1)
    expect(await outboxCount('other_income', later)).toBe(1)
    expect(await outboxCount('other_income', sept)).toBe(0)
    const check = await checkOwner(co.owner)
    expect(check.findings.filter(f => f.severity === 'integrity' || f.severity === 'drift')).toEqual([])
    expect(check.repaired).toBe(0)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'books_ledger' AND title LIKE '%drifted%'`)).rows).toHaveLength(0)
    expect(await lineAccounts(same)).toEqual(['1099', '4950'])
    expect(await lineAccounts(later)).toEqual(['1099', '4950'])
    expect(await lineAccounts(sept)).toEqual(['1099', '4900'])
    expect((await rebuildOwner(co.owner, { mode: 'dry_run' })).counts.drift).toBe(0)
  })
})

describe('deleting an account', () => {
  it('one the map or posted lines use needs a replacement; nothing already posted moves, new postings use the replacement', async () => {
    const co = await ledgerCompany()
    const id = await addOtherIncome(co, { amount: 100, day: '2026-09-10' })
    await drainLedgerOutbox()
    const misc = await accountByCode(co, '4900')
    const linesBefore = (await db.query(`SELECT id, debit, credit FROM ledger_posting_lines WHERE account_id = $1 ORDER BY id`, [misc.id])).rows

    await expect(retireAccount({ owner: co.owner, accountId: misc.id, actorUserId: co.ownerUserId }))
      .rejects.toThrow(/Choose the account that takes its place/)
    const asset = await account(co, '1950', 'Not income', 'asset')
    await expect(retireAccount({ owner: co.owner, accountId: misc.id, replacementAccountId: asset, actorUserId: co.ownerUserId }))
      .rejects.toThrow(/must be one too/)

    const replacement = await account(co, '4950', 'Other income (new)', 'income')
    const r = await retireAccount({ owner: co.owner, accountId: misc.id, replacementAccountId: replacement, actorUserId: co.ownerUserId })
    expect(r).toEqual({ repointed: [{ kind: 'role', value: 'other_income' }], hadHistory: true })
    expect(await accountByCode(co, '4900')).toMatchObject({ active: false, replaced_by_account_id: replacement })
    expect(await mapped(co, 'other_income')).toBe(replacement)
    // Never orphaned, never rewritten.
    expect((await db.query(`SELECT id, debit, credit FROM ledger_posting_lines WHERE account_id = $1 ORDER BY id`, [misc.id])).rows).toEqual(linesBefore)
    // 10/12 (Nic) review: nothing is closed, so the replacement takes over the
    // whole history: the September posting is marked, and the next drain moves
    // it (a reversal and a new posting — the old lines stay as they were).
    expect(await outboxCount('other_income', id)).toBe(1)
    await drainLedgerOutbox()
    const kept = await db.query(`SELECT id, debit, credit FROM ledger_posting_lines WHERE id = ANY($1::uuid[]) ORDER BY id`, [linesBefore.map(l => l.id)])
    expect(kept.rows).toEqual(linesBefore)
    expect(await lineAccounts(id)).toEqual(['1099', '4950'])
    expect((await rebuildOwner(co.owner, { mode: 'dry_run' })).counts.drift).toBe(0)
    const next = await addOtherIncome(co, { amount: 7, day: await companyToday() })
    await drainLedgerOutbox()
    expect(await lineAccounts(next)).toEqual(['1099', '4950'])
  })

  it('an account nothing uses is simply turned off; one with only a hand journal line still needs a replacement', async () => {
    const co = await ledgerCompany()
    const unused = await account(co, '6100', 'Unused', 'expense')
    expect(await retireAccount({ owner: co.owner, accountId: unused, actorUserId: co.ownerUserId }))
      .toEqual({ repointed: [], hadHistory: false })
    expect((await db.query(`SELECT active FROM books_accounts WHERE id = $1`, [unused])).rows[0].active).toBe(false)

    const journaled = await account(co, '6200', 'Journaled', 'expense')
    const cash = await account(co, '1001', 'Petty cash', 'asset')
    await inTx(async c => {
      const e = (await c.query(`INSERT INTO journal_entries (landlord_id, entry_number, date, description) VALUES ($1, 1, '2026-09-01', 'x') RETURNING id`,
        [co.landlordId])).rows[0].id
      await c.query(`INSERT INTO journal_entry_lines (entry_id, account_id, debit) VALUES ($1, $2, 10)`, [e, journaled])
      await c.query(`INSERT INTO journal_entry_lines (entry_id, account_id, credit) VALUES ($1, $2, 10)`, [e, cash])
    })
    await expect(retireAccount({ owner: co.owner, accountId: journaled, actorUserId: co.ownerUserId }))
      .rejects.toThrow(/has posted history/)
  })
})

describe('the database holds the chart rules for anything that edits it directly', () => {
  it('refuses turning off, retyping, or moving an account the books use, and a hard delete of one with lines', async () => {
    const co = await ledgerCompany()
    const other = await ledgerCompany()
    await addOtherIncome(co, { amount: 3, day: '2026-09-01' })
    await drainLedgerOutbox()
    const misc = await accountByCode(co, '4900')
    await expect(db.query(`UPDATE books_accounts SET active = FALSE WHERE id = $1`, [misc.id])).rejects.toThrow(/where automatic postings go/)
    await expect(db.query(`UPDATE books_accounts SET type = 'expense' WHERE id = $1`, [misc.id])).rejects.toThrow(/type cannot change/)
    await expect(db.query(`UPDATE books_accounts SET landlord_id = $2 WHERE id = $1`, [misc.id, other.landlordId])).rejects.toThrow(/cannot move to another company/)
    await expect(db.query(`DELETE FROM books_accounts WHERE id = $1`, [misc.id])).rejects.toThrow(/foreign key/)
    await expect(db.query(`UPDATE books_accounts SET replaced_by_account_id = id WHERE id = $1`, [misc.id])).rejects.toThrow(/cannot replace itself/)
    // A rename and a renumber are always fine (Nic: fully editable).
    await db.query(`UPDATE books_accounts SET name = 'Odds and ends', code = '4999' WHERE id = $1`, [misc.id])
    // An account with history, no longer mapped, still needs its replacement named to turn off.
    const repl = await account(co, '4950', 'New', 'income')
    await repointMapping({ owner: co.owner, kind: 'role', value: 'other_income', accountId: repl, actorUserId: co.ownerUserId })
    await expect(db.query(`UPDATE books_accounts SET active = FALSE WHERE id = $1`, [misc.id])).rejects.toThrow(/has posted history/)
    await db.query(`UPDATE books_accounts SET active = FALSE, replaced_by_account_id = $2 WHERE id = $1`, [misc.id, repl])
  })

  it('the map is append-only, points only at an active account of the right type in the same chart, and never reaches into a closed month', async () => {
    const co = await ledgerCompany()
    const other = await ledgerCompany()
    await addOtherIncome(co, { amount: 3, day: '2026-09-01' })
    await drainLedgerOutbox()
    await expect(db.query(`UPDATE books_account_map SET note = 'x' WHERE landlord_id = $1`, [co.landlordId])).rejects.toThrow(/a repoint is a new row/)
    await expect(db.query(`DELETE FROM books_account_map WHERE landlord_id = $1`, [co.landlordId])).rejects.toThrow(/a repoint is a new row/)
    const ins = (accountId: string, from = '2026-10-01', role = 'other_income') => db.query(
      `INSERT INTO books_account_map (landlord_id, map_kind, map_value, account_id, effective_from) VALUES ($1, 'role', $2, $3, $4)`,
      [co.landlordId, role, accountId, from])
    await expect(ins(await account(other, '4950', 'Theirs', 'income'))).rejects.toThrow(/another company's chart/)
    await expect(ins(await account(co, '5950', 'Expense', 'expense'))).rejects.toThrow(/needs an income account/)
    const gone = await account(co, '4970', 'Gone', 'income')
    await db.query(`UPDATE books_accounts SET active = FALSE WHERE id = $1`, [gone])
    await expect(ins(gone)).rejects.toThrow(/is retired/)
    await expect(ins(await account(co, '4980', 'Fine', 'income'), '2026-10-01', 'no_such_role')).rejects.toThrow(/not a posting role/)
    await db.query(`INSERT INTO books_period_closes (landlord_id, action, closed_through, acted_by) VALUES ($1, 'close', '2026-09-30', $2)`,
      [co.landlordId, co.ownerUserId])
    await expect(ins(await account(co, '4990', 'Late', 'income'), '2026-09-15')).rejects.toThrow(/closed through 2026-09-30/)
    await ins(await account(co, '4991', 'After the close', 'income'), '2026-10-01')
  })

  it('a hand journal line on an account a control role maps to is refused; other accounts take it', async () => {
    const co = await ledgerCompany()
    await addOtherIncome(co, { amount: 3, day: '2026-09-01' })
    await drainLedgerOutbox()
    const ar = await mapped(co, 'ar_tenants')
    const repairs = await mapped(co, 'repairs_maintenance')
    const owner = await mapped(co, 'owner_equity')
    const entry = async (debitAcct: string) => inTx(async c => {
      const e = (await c.query(`INSERT INTO journal_entries (landlord_id, entry_number, date, description)
                                VALUES ($1, (SELECT COALESCE(max(entry_number), 0) + 1 FROM journal_entries WHERE landlord_id = $1), '2026-09-02', 'x') RETURNING id`,
        [co.landlordId])).rows[0].id
      await c.query(`INSERT INTO journal_entry_lines (entry_id, account_id, debit) VALUES ($1, $2, 10)`, [e, debitAcct])
      await c.query(`INSERT INTO journal_entry_lines (entry_id, account_id, credit) VALUES ($1, $2, 10)`, [e, owner])
    })
    await expect(entry(ar)).rejects.toThrow(/kept by GAM from the money records/)
    await entry(repairs)
    // Changing which account a posted journal line names runs the same guard.
    await expect(db.query(`UPDATE journal_entry_lines SET account_id = $1 WHERE account_id = $2`, [ar, repairs])).rejects.toThrow(/kept by GAM/)
    // Repointing a control role elsewhere keeps the old account closed to hand lines (it carried a control role).
    const newAr = await account(co, '1101', 'Receivables (new)', 'asset')
    await repointMapping({ owner: co.owner, kind: 'role', value: 'ar_tenants', accountId: newAr, actorUserId: co.ownerUserId })
    await expect(entry(ar)).rejects.toThrow(/kept by GAM/)
    await expect(entry(newAr)).rejects.toThrow(/kept by GAM/)
    expect(await postSource('other_income', 'missing')).toMatchObject({ posted: 0, reversed: 0 })
  })
})


describe('a deleted account\'s replacement takes over from the first open day (10/12 (Nic) review)', () => {
  it('open months move to it, closed months keep their account, and a record dated before the deletion books to it', async () => {
    const co = await ledgerCompany()
    const aug = await addOtherIncome(co, { amount: 100, day: '2026-08-10' })
    const sep = await addOtherIncome(co, { amount: 50, day: '2026-09-10' })
    await drainLedgerOutbox()
    await closeMonth({ owner: co.owner, through: '2026-08-31', actorUserId: co.ownerUserId })
    const misc = await accountByCode(co, '4900')
    const repl = await account(co, '4950', 'Other income (new)', 'income')
    await retireAccount({ owner: co.owner, accountId: misc.id, replacementAccountId: repl, actorUserId: co.ownerUserId })
    const row = await db.query(`SELECT effective_from::text AS f FROM books_account_map WHERE landlord_id = $1 AND account_id = $2`, [co.landlordId, repl])
    expect(row.rows).toEqual([{ f: '2026-09-01' }])
    expect(await outboxCount('other_income', sep)).toBe(1)
    expect(await outboxCount('other_income', aug)).toBe(0)
    await drainLedgerOutbox()
    expect(await lineAccounts(sep)).toEqual(['1099', '4950'])
    const sepPostings = await postingsOf('other_income', sep)
    expect(sepPostings.map(p => [p.role, p.accounting_date])).toEqual([['post', '2026-09-10'], ['reversal', '2026-09-10'], ['post', '2026-09-10']])
    expect(await lineAccounts(aug)).toEqual(['1099', '4900'])   // the closed month keeps its account
    // Entered after the deletion, dated before it.
    const backdated = await addOtherIncome(co, { amount: 7, day: '2026-09-05' })
    await drainLedgerOutbox()
    expect(await lineAccounts(backdated)).toEqual(['1099', '4950'])
    const open = await db.query(`SELECT COALESCE(sum(credit - debit), 0)::text AS n FROM ledger_posting_lines
                                  WHERE account_id = $1 AND accounting_date > '2026-08-31'`, [misc.id])
    expect(open.rows[0].n).toBe('0.00')
    const check = await checkOwner(co.owner)
    expect(check.findings.filter(f => f.severity === 'integrity' || f.severity === 'drift')).toEqual([])
    expect((await rebuildOwner(co.owner, { mode: 'dry_run' })).counts.drift).toBe(0)
  })
})

describe('a control account never shares (10/12 (Nic) review)', () => {
  const journal = (co: LedgerCompany, debitAccount: string, creditAccount: string) => inTx(async c => {
    const e = (await c.query(`INSERT INTO journal_entries (landlord_id, entry_number, date, description)
                              VALUES ($1, (SELECT COALESCE(max(entry_number), 0) + 1 FROM journal_entries WHERE landlord_id = $1), '2026-09-02', 'x') RETURNING id`,
      [co.landlordId])).rows[0].id
    await c.query(`INSERT INTO journal_entry_lines (entry_id, account_id, debit) VALUES ($1, $2, 10)`, [e, debitAccount])
    await c.query(`INSERT INTO journal_entry_lines (entry_id, account_id, credit) VALUES ($1, $2, 10)`, [e, creditAccount])
  })

  it('a control role is never pointed at an account another role uses, and no role joins a control account', async () => {
    const co = await ledgerCompany()
    await addOtherIncome(co, { amount: 3, day: '2026-09-01' })
    await drainLedgerOutbox()
    const ar = await mapped(co, 'ar_tenants')
    const checking = await mapped(co, 'bank_checking')
    const owner = await mapped(co, 'owner_equity')
    const repoint = (value: string, accountId: string) =>
      repointMapping({ owner: co.owner, kind: 'role', value, accountId, actorUserId: co.ownerUserId })
    await expect(repoint('due_from_gam', ar)).rejects.toThrow(/carries the postings for Accounts receivable: tenants/)
    await expect(repoint('suspense', ar)).rejects.toThrow(/kept by GAM for Accounts receivable: tenants/)
    await expect(repoint('due_from_gam', checking)).rejects.toThrow(/carries the postings for Checking/)

    // Deleting the receivables account: Checking cannot take its place, nor an account with hand entries.
    await expect(retireAccount({ owner: co.owner, accountId: ar, replacementAccountId: checking, actorUserId: co.ownerUserId }))
      .rejects.toThrow(/carries the postings for Checking/)
    const handKept = await account(co, '1102', 'Old receivables', 'asset')
    await journal(co, handKept, owner)
    await expect(retireAccount({ owner: co.owner, accountId: ar, replacementAccountId: handKept, actorUserId: co.ownerUserId }))
      .rejects.toThrow(/has journal entries/)
    const fresh = await account(co, '1101', 'Receivables (new)', 'asset')
    await retireAccount({ owner: co.owner, accountId: ar, replacementAccountId: fresh, actorUserId: co.ownerUserId })
    expect(await mapped(co, 'ar_tenants')).toBe(fresh)
    // Checking never carried a control role: it still takes a bookkeeper's hand entry.
    await journal(co, checking, owner)
  })

  it('GAM\'s seeding never hands a control role an account that has hand journal lines', async () => {
    const co = await ledgerCompany()
    const handKept = await account(co, '1100', 'Receivables (kept by hand)', 'asset')
    const cash = await account(co, '1001', 'Petty cash', 'asset')
    await journal(co, handKept, cash)
    await addOtherIncome(co, { amount: 3, day: '2026-09-01' })
    await drainLedgerOutbox()
    const ar = await mapped(co, 'ar_tenants')
    expect(ar).not.toBe(handKept)
    expect((await db.query(`SELECT code FROM books_accounts WHERE id = $1`, [ar])).rows[0].code).toBe('1100-1')
  })
})
