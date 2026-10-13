/**
 * 10/12 (Nic) — GAM Books ledger, phase P3: closing a month, and fixes.
 *
 *   L3 "close/reopen month: landlord's choice (owner decides who can close
 *       and reopen)" — closing is optional.
 *   L4 "fix in an open month: landlord's choice (change that month vs show on
 *       day made)"; after a close, fixes post to the open month, labeled as
 *       corrections.
 *
 * (gam-ledger-design-2026-10-12 §13, §17: "a closed month is never
 * rewritten", "the clamp keeps intended_date", "close vs poster race".)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import {
  inTx, ledgerCompany, addOtherIncome, postingsOf, linesOf, roleNet, companyToday, memProjector, markChanged,
  outboxCount, type LedgerCompany,
} from '../test/ledgerFixtures'
import {
  drainLedgerOutbox, postSource, registerLedgerProjector, unregisterLedgerProjector, registeredLedgerSourceTypes,
  ledgerTestHooks,
} from './ledgerEngine'
import { otherIncomeTestProjector } from './ledgerTestProjector'
import { closeMonth, reopenMonth, setLedgerSettings, getLedgerSettings, ledgerCloseTestHooks } from './ledgerClose'
import { retireAccount } from './booksLedgerChart'
import { checkOwner } from './ledgerCheck'
import { rebuildOwner } from './ledgerRebuild'

beforeEach(async () => {
  await cleanupAllSchema()
  registerLedgerProjector(otherIncomeTestProjector)
})
afterEach(() => {
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
  delete ledgerTestHooks.afterOwnerLock
  delete ledgerTestHooks.beforeCommit
  delete ledgerCloseTestHooks.afterExclusiveLock
})

async function bookkeeper(co: LedgerCompany, o: { access: 'read_only' | 'read_write'; companyWide: boolean; properties?: string[] | null }): Promise<string> {
  const u = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'bookkeeper', 'Book', 'Keeper', TRUE) RETURNING id`, [`bk-${randomUUID()}@test.dev`])).rows[0].id
  await db.query(
    `INSERT INTO bookkeeper_scopes (user_id, landlord_id, access_level, property_ids, company_wide) VALUES ($1, $2, $3, $4, $5)`,
    [u, co.landlordId, o.access, o.properties === undefined ? [co.propertyId, co.propertyId2] : o.properties, o.companyWide])
  return u
}
const lockOf = async (co: LedgerCompany) => (await getLedgerSettings(co.landlordId)).closedThrough
const integrityOrDrift = (r: Awaited<ReturnType<typeof checkOwner>>) => r.findings.filter(f => f.severity === 'integrity' || f.severity === 'drift')

describe('who may close and reopen (the owner decides)', () => {
  it('by default a company-wide bookkeeper who can edit may close; when the owner says "only me", only the owner may', async () => {
    const co = await ledgerCompany()
    const rw = await bookkeeper(co, { access: 'read_write', companyWide: true })
    // 10/12 (Nic, ledger decision 2): one level — the access level decides
    // nothing; a bookkeeper of ANOTHER company is the one refused here.
    const elsewhere = await bookkeeper(await ledgerCompany(), { access: 'read_write', companyWide: true })
    const partial = await bookkeeper(co, { access: 'read_write', companyWide: false, properties: [co.propertyId] })
    expect(await getLedgerSettings(co.landlordId)).toMatchObject({ closeBy: 'owner_or_bookkeeper', reopenBy: 'owner', openMonthFixes: 'restate' })

    await expect(closeMonth({ owner: co.owner, through: '2026-08-31', actorUserId: elsewhere })).rejects.toThrow(/may close a month/)
    await expect(closeMonth({ owner: co.owner, through: '2026-08-31', actorUserId: partial })).rejects.toThrow(/company-wide box/)
    expect(await closeMonth({ owner: co.owner, through: '2026-08-31', actorUserId: rw })).toMatchObject({ closedThrough: '2026-08-31' })
    // The owner hears when someone else closed their books.
    const note = await db.query(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'books_month_close'`, [co.ownerUserId])
    expect(note.rows.map(r => r.title)).toEqual(['A month was closed in your books'])

    await expect(setLedgerSettings({ landlordId: co.landlordId, actorUserId: rw, closeBy: 'owner' })).rejects.toThrow(/Only the owner/)
    await setLedgerSettings({ landlordId: co.landlordId, actorUserId: co.ownerUserId, closeBy: 'owner' })
    await expect(closeMonth({ owner: co.owner, through: '2026-09-30', actorUserId: rw })).rejects.toThrow(/Only the owner closes/)
    expect(await closeMonth({ owner: co.owner, through: '2026-09-30', actorUserId: co.ownerUserId })).toMatchObject({ closedThrough: '2026-09-30' })
  })

  it('by default only the owner reopens, always with a reason; the owner may let a company-wide bookkeeper reopen too', async () => {
    const co = await ledgerCompany()
    const rw = await bookkeeper(co, { access: 'read_write', companyWide: true })
    await closeMonth({ owner: co.owner, through: '2026-09-30', actorUserId: co.ownerUserId })
    await expect(reopenMonth({ owner: co.owner, month: '2026-09-01', actorUserId: rw, reason: 'missed a bill' })).rejects.toThrow(/Only the owner reopens/)
    await expect(reopenMonth({ owner: co.owner, month: '2026-09-01', actorUserId: co.ownerUserId, reason: '  ' })).rejects.toThrow(/Say why/)
    await setLedgerSettings({ landlordId: co.landlordId, actorUserId: co.ownerUserId, reopenBy: 'owner_or_bookkeeper' })
    expect(await reopenMonth({ owner: co.owner, month: '2026-09-15', actorUserId: rw, reason: 'missed a bill' }))
      .toMatchObject({ closedThrough: '2026-08-31' })
    const hist = await db.query(`SELECT action, closed_through::text AS t, reason FROM books_period_closes WHERE landlord_id = $1 ORDER BY id`, [co.landlordId])
    expect(hist.rows).toEqual([
      { action: 'close', t: '2026-09-30', reason: null },
      { action: 'reopen', t: '2026-08-31', reason: 'missed a bill' },
    ])
    // The history is never changed.
    await expect(db.query(`DELETE FROM books_period_closes WHERE landlord_id = $1`, [co.landlordId])).rejects.toThrow(/never changed or removed/)
  })
})

describe('who is asking comes first (10/12 (Nic) review)', () => {
  it('10/12 (Nic, one level): a company-wide bookkeeper whose row still says read_only closes like any other', async () => {
    const co = await ledgerCompany()
    const ro = await bookkeeper(co, { access: 'read_only', companyWide: true })
    expect(await closeMonth({ owner: co.owner, through: '2026-08-31', actorUserId: ro })).toMatchObject({ closedThrough: '2026-08-31' })
  })

  it('a user who may not close never sets off a drain or a retry', async () => {
    const co = await ledgerCompany()
    // Without the company-wide box (10/12: the only bookkeeper refused, one level).
    const ro = await bookkeeper(co, { access: 'read_write', companyWide: false, properties: [co.propertyId] })
    const id = await addOtherIncome(co, { amount: 9, day: '2026-09-09' })
    await expect(closeMonth({ owner: co.owner, through: '2026-08-31', actorUserId: ro })).rejects.toThrow(/may close a month/)
    expect(await outboxCount('other_income', id)).toBe(1)
    expect(await postingsOf('other_income', id)).toHaveLength(0)
  })
})

describe('a co-owner is an owner', () => {
  it('a partner the company invited (landlord_members) closes, reopens and sets the rules like the founding owner; every other owner hears', async () => {
    const co = await ledgerCompany()
    const partner = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'landlord', 'Pat', 'Partner', TRUE) RETURNING id`, [`partner-${randomUUID()}@test.dev`])).rows[0].id
    await db.query(`INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1, $2, 'owner')`, [co.landlordId, partner])
    await setLedgerSettings({ landlordId: co.landlordId, actorUserId: partner, closeBy: 'owner', reopenBy: 'owner' })
    await closeMonth({ owner: co.owner, through: '2026-09-30', actorUserId: partner })
    await reopenMonth({ owner: co.owner, month: '2026-09-01', actorUserId: partner, reason: 'late bill' })
    const notes = await db.query(`SELECT user_id, title FROM notifications WHERE type = 'books_month_close' ORDER BY created_at`)
    expect(notes.rows).toEqual([
      { user_id: co.ownerUserId, title: 'A month was closed in your books' },
      { user_id: co.ownerUserId, title: 'A closed month was reopened in your books' },
    ])
  })
})

describe('what a close and a reopen do', () => {
  it('a close is through a month end, after the month has ended, past the last close', async () => {
    const co = await ledgerCompany()
    const by = co.ownerUserId
    await expect(closeMonth({ owner: co.owner, through: '2026-09-15', actorUserId: by })).rejects.toThrow(/last day of a month/)
    await expect(closeMonth({ owner: co.owner, through: '2099-01-31', actorUserId: by })).rejects.toThrow(/once it has ended/)
    await closeMonth({ owner: co.owner, through: '2026-09-30', actorUserId: by })
    await expect(closeMonth({ owner: co.owner, through: '2026-08-31', actorUserId: by })).rejects.toThrow(/already closed through 2026-09-30/)
    await expect(reopenMonth({ owner: co.owner, month: '2026-10-01', actorUserId: by, reason: 'x' })).rejects.toThrow(/not closed/)
  })

  it('reopening a month reopens it and every later month; the earlier months stay closed until the books start', async () => {
    const co = await ledgerCompany({ booksStart: '2026-07-01' })
    const by = co.ownerUserId
    // One close covering July through September.
    await closeMonth({ owner: co.owner, through: '2026-09-30', actorUserId: by })
    await reopenMonth({ owner: co.owner, month: '2026-09-01', actorUserId: by, reason: 'fix September' })
    expect(await lockOf(co)).toBe('2026-08-31')
    await reopenMonth({ owner: co.owner, month: '2026-08-01', actorUserId: by, reason: 'fix August' })
    expect(await lockOf(co)).toBe('2026-07-31')
    // Reopening the books' first month leaves nothing closed.
    await reopenMonth({ owner: co.owner, month: '2026-07-01', actorUserId: by, reason: 'fix July' })
    expect(await lockOf(co)).toBeNull()
  })

  it('after a close, anything dated in the closed month lands on the first open day, keeps its own date, reads as a correction; the closed month never changes', async () => {
    const co = await ledgerCompany()
    const sept = await addOtherIncome(co, { amount: 100, day: '2026-09-10' })
    await drainLedgerOutbox()
    const closed = await closeMonth({ owner: co.owner, through: '2026-09-30', actorUserId: co.ownerUserId })
    expect(closed.snapshotRows).toBeGreaterThan(0)

    // A fix to September.
    await db.query(`UPDATE landlord_other_income SET amount = 120 WHERE id = $1`, [sept])
    await drainLedgerOutbox()
    const [, rev, next] = await postingsOf('other_income', sept)
    expect(rev).toMatchObject({ role: 'reversal', intended_date: '2026-09-10', accounting_date: '2026-10-01', is_correction: true })
    expect(next).toMatchObject({ role: 'post', intended_date: '2026-09-10', accounting_date: '2026-10-01', is_correction: true })
    expect((await linesOf(next.id)).every(l => l.intended_date === '2026-09-10' && l.accounting_date === '2026-10-01')).toBe(true)
    // A backdated record that arrives after the close.
    const late = await addOtherIncome(co, { amount: 5, day: '2026-09-20' })
    await drainLedgerOutbox()
    expect((await postingsOf('other_income', late))[0]).toMatchObject({ intended_date: '2026-09-20', accounting_date: '2026-10-01', is_correction: true })

    expect(await roleNet(co.landlordId, 'other_income', '2026-09-30')).toBe(100)
    expect(await roleNet(co.landlordId, 'other_income')).toBe(125)
    expect(integrityOrDrift(await checkOwner(co.owner))).toEqual([])
    expect((await rebuildOwner(co.owner, { mode: 'from_scratch' })).status).toBe('refused')
  })

  it('the database refuses a ledger line or a journal entry dated in a closed month, and moving an entry out of one', async () => {
    const co = await ledgerCompany()
    await addOtherIncome(co, { amount: 1, day: '2026-09-01' })
    await drainLedgerOutbox()
    const acct = (await db.query(`SELECT id FROM books_accounts WHERE landlord_id = $1 AND code = '1099'`, [co.landlordId])).rows[0].id
    const acct2 = (await db.query(`SELECT id FROM books_accounts WHERE landlord_id = $1 AND code = '5900'`, [co.landlordId])).rows[0].id
    const entry = await inTx(async c => {
      const e = (await c.query(`INSERT INTO journal_entries (landlord_id, entry_number, date, description) VALUES ($1, 1, '2026-09-25', 'x') RETURNING id`,
        [co.landlordId])).rows[0].id
      await c.query(`INSERT INTO journal_entry_lines (entry_id, account_id, debit) VALUES ($1, $2, 4)`, [e, acct2])
      await c.query(`INSERT INTO journal_entry_lines (entry_id, account_id, credit) VALUES ($1, $2, 4)`, [e, (await db.query(`SELECT id FROM books_accounts WHERE landlord_id = $1 AND code = '3010'`, [co.landlordId])).rows[0].id])
      return e
    })
    await closeMonth({ owner: co.owner, through: '2026-09-30', actorUserId: co.ownerUserId })

    await expect(inTx(async c => {
      const pid = randomUUID()
      await c.query(`INSERT INTO ledger_postings (id, landlord_id, source_type, source_id, role, intended_date, accounting_date, fingerprint, rule_version)
                     VALUES ($1, $2, 'opening', $3, 'post', '2026-09-15', '2026-09-15', 'x', 1)`, [pid, co.landlordId, randomUUID()])
      await c.query(`INSERT INTO ledger_posting_lines (posting_id, line_no, landlord_id, accounting_date, intended_date, account_id, debit)
                     VALUES ($1, 1, $2, '2026-09-15', '2026-09-15', $3, 1)`, [pid, co.landlordId, acct])
    })).rejects.toThrow(/closed through 2026-09-30/)
    await expect(db.query(`INSERT INTO journal_entries (landlord_id, entry_number, date, description) VALUES ($1, 2, '2026-09-15', 'x')`,
      [co.landlordId])).rejects.toThrow(/closed through 2026-09-30/)
    await db.query(`INSERT INTO journal_entries (landlord_id, entry_number, date, description) VALUES ($1, 3, '2026-10-02', 'x')`, [co.landlordId])
    await expect(db.query(`UPDATE journal_entries SET date = '2026-10-05' WHERE id = $1`, [entry])).rejects.toThrow(/cannot move out of it/)
    // Its lines are held the same way.
    await expect(db.query(`INSERT INTO journal_entry_lines (entry_id, account_id, debit) VALUES ($1, $2, 1)`, [entry, acct2])).rejects.toThrow(/Add a new entry dated after it/)
    await expect(db.query(`UPDATE journal_entry_lines SET debit = 5 WHERE entry_id = $1 AND debit > 0`, [entry])).rejects.toThrow(/Add a new entry dated after it/)
    await expect(db.query(`DELETE FROM journal_entry_lines WHERE entry_id = $1`, [entry])).rejects.toThrow(/Add a new entry dated after it/)
  })

  it('a close waits for nothing to be failing or waiting to post', async () => {
    const co = await ledgerCompany()
    const m = memProjector('deposit_slip')
    registerLedgerProjector(m.projector)
    const sid = randomUUID()
    m.wants.set(sid, [{ owner: co.owner, intendedDate: '2026-09-05', lines: [] }])
    m.throwFor.add(sid)
    await markChanged('deposit_slip', sid, co.landlordId)
    await expect(closeMonth({ owner: co.owner, through: '2026-09-30', actorUserId: co.ownerUserId })).rejects.toThrow(/not ready to close/)
    m.throwFor.delete(sid)
    expect(await closeMonth({ owner: co.owner, through: '2026-09-30', actorUserId: co.ownerUserId })).toMatchObject({ closedThrough: '2026-09-30' })
  })
})

describe('a reopen that leaves earlier months closed (10/12 (Nic) review)', () => {
  it('snapshots them under its own row, and the nightly check keeps proving them', async () => {
    const co = await ledgerCompany()
    await addOtherIncome(co, { amount: 100, day: '2026-08-10' })
    await addOtherIncome(co, { amount: 50, day: '2026-09-10' })
    await drainLedgerOutbox()
    await closeMonth({ owner: co.owner, through: '2026-09-30', actorUserId: co.ownerUserId })
    const r = await reopenMonth({ owner: co.owner, month: '2026-09-01', actorUserId: co.ownerUserId, reason: 'late bill' })
    expect(r.closedThrough).toBe('2026-08-31')
    expect(r.snapshotRows).toBeGreaterThan(0)
    const snap = await db.query(
      `SELECT sum(credits)::text AS c FROM ledger_close_balances b JOIN books_accounts a ON a.id = b.account_id
        WHERE b.close_id = $1 AND a.code = '4900'`, [r.closeId])
    expect(snap.rows[0].c).toBe('100.00')
    expect(integrityOrDrift(await checkOwner(co.owner))).toEqual([])
    // Were August to differ from it, the check would say so.
    await db.query(
      `INSERT INTO ledger_close_balances (close_id, landlord_id, account_id, property_id, debits, credits)
       SELECT close_id, landlord_id, account_id, property_id, 0, 1 FROM ledger_close_balances WHERE close_id = $1 LIMIT 1`, [r.closeId])
    expect((await checkOwner(co.owner)).findings.some(f => f.check === 'closed_month_changed')).toBe(true)
  })
})

describe('fixes to a month that is still open (the owner decides)', () => {
  it('"restate" changes that month; "show on the day made" leaves it and posts the fix today — new records still post on their own day', async () => {
    const co = await ledgerCompany()
    const a = await addOtherIncome(co, { amount: 100, day: '2026-09-10' })
    await drainLedgerOutbox()
    await db.query(`UPDATE landlord_other_income SET amount = 110 WHERE id = $1`, [a])
    await drainLedgerOutbox()
    expect((await postingsOf('other_income', a)).map(p => p.accounting_date)).toEqual(['2026-09-10', '2026-09-10', '2026-09-10'])

    await setLedgerSettings({ landlordId: co.landlordId, actorUserId: co.ownerUserId, openMonthFixes: 'day_made' })
    const today = await companyToday()
    await db.query(`UPDATE landlord_other_income SET amount = 130 WHERE id = $1`, [a])
    await drainLedgerOutbox()
    const ps = await postingsOf('other_income', a)
    expect(ps.slice(3).map(p => [p.role, p.intended_date, p.accounting_date, p.is_correction])).toEqual([
      ['reversal', '2026-09-10', today, true], ['post', '2026-09-10', today, true]])
    expect(await roleNet(co.landlordId, 'other_income', '2026-09-30')).toBe(110)
    const b = await addOtherIncome(co, { amount: 1, day: '2026-09-11' })
    await drainLedgerOutbox()
    expect((await postingsOf('other_income', b))[0]).toMatchObject({ accounting_date: '2026-09-11', is_correction: false })
  })

  it('a GAM rebuild or a chart change is not a fix: with "show on the day made" it restates in place, keeping each posting\'s dates', async () => {
    const co = await ledgerCompany()
    await setLedgerSettings({ landlordId: co.landlordId, actorUserId: co.ownerUserId, openMonthFixes: 'day_made' })
    const a = await addOtherIncome(co, { amount: 40, day: '2026-09-10' })
    await drainLedgerOutbox()
    expect((await rebuildOwner(co.owner, { mode: 'from_scratch' })).counts).toMatchObject({ posted: 1, reversed: 1, failed: 0 })
    expect((await postingsOf('other_income', a)).map(p => [p.role, p.accounting_date, p.is_correction])).toEqual([
      ['post', '2026-09-10', false], ['reversal', '2026-09-10', true], ['post', '2026-09-10', false]])
    // Deleting its account moves it to the replacement on its own day too.
    const misc = (await db.query(`SELECT id FROM books_accounts WHERE landlord_id = $1 AND code = '4900'`, [co.landlordId])).rows[0].id
    const repl = (await db.query(`INSERT INTO books_accounts (landlord_id, code, name, type) VALUES ($1, '4950', 'New', 'income') RETURNING id`,
      [co.landlordId])).rows[0].id
    await retireAccount({ owner: co.owner, accountId: misc, replacementAccountId: repl, actorUserId: co.ownerUserId })
    await drainLedgerOutbox()
    const ps = await postingsOf('other_income', a)
    expect(ps.slice(3).map(p => [p.role, p.accounting_date, p.is_correction])).toEqual([['reversal', '2026-09-10', true], ['post', '2026-09-10', false]])
    expect((await linesOf(ps[4].id)).map(l => l.account_code).sort()).toEqual(['1099', '4950'])
    // A real fix still shows on the day it was made.
    const today = await companyToday()
    await db.query(`UPDATE landlord_other_income SET amount = 45 WHERE id = $1`, [a])
    await drainLedgerOutbox()
    expect((await postingsOf('other_income', a)).slice(5).map(p => [p.role, p.accounting_date, p.is_correction])).toEqual([
      ['reversal', today, true], ['post', today, true]])
  })

  it('only the owner changes the settings; the books calendar moves only before the first posting', async () => {
    const co = await ledgerCompany()
    const rw = await bookkeeper(co, { access: 'read_write', companyWide: true })
    await expect(setLedgerSettings({ landlordId: co.landlordId, actorUserId: rw, openMonthFixes: 'day_made' })).rejects.toThrow(/Only the owner/)
    await expect(setLedgerSettings({ landlordId: co.landlordId, actorUserId: co.ownerUserId, timezone: 'Mars/Olympus' })).rejects.toThrow(/not a time zone/)
    expect(await setLedgerSettings({ landlordId: co.landlordId, actorUserId: co.ownerUserId, timezone: 'America/Chicago' }))
      .toMatchObject({ timezone: 'America/Chicago', timezonePinned: true })
    await addOtherIncome(co, { amount: 1, day: '2026-09-01' })
    await drainLedgerOutbox()
    await expect(setLedgerSettings({ landlordId: co.landlordId, actorUserId: co.ownerUserId, timezone: 'America/Denver' })).rejects.toThrow(/cannot move now/)
  })
})

describe('a close racing a poster (design §13 serialization)', () => {
  /** A September source whose capture row is already gone, so only the test's own postSource posts it. */
  async function septSource(co: LedgerCompany): Promise<string> {
    const id = await addOtherIncome(co, { amount: 50, day: '2026-09-10' })
    await db.query(`DELETE FROM ledger_outbox WHERE source_id = $1`, [id])
    return id
  }

  it('a poster that took the company lock first finishes inside September, and the close\'s snapshot includes it', async () => {
    const co = await ledgerCompany()
    const id = await septSource(co)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let entered!: () => void
    const inside = new Promise<void>(r => { entered = r })
    ledgerTestHooks.afterOwnerLock = async () => { entered(); await gate }
    const poster = postSource('other_income', id)
    await inside
    const close = closeMonth({ owner: co.owner, through: '2026-09-30', actorUserId: co.ownerUserId })
    await new Promise(res => setTimeout(res, 200))   // the close is now waiting for the poster
    release()
    expect(await poster).toMatchObject({ posted: 1 })
    await close
    expect((await postingsOf('other_income', id))[0]).toMatchObject({ accounting_date: '2026-09-10', is_correction: false })
    const snap = await db.query(
      `SELECT sum(credits)::text AS c FROM ledger_close_balances b JOIN books_accounts a ON a.id = b.account_id
        WHERE b.landlord_id = $1 AND a.code = '4900'`, [co.landlordId])
    expect(snap.rows[0].c).toBe('50.00')
    expect(integrityOrDrift(await checkOwner(co.owner))).toEqual([])
  })

  it('a poster that starts while the close holds the lock lands on the first open day', async () => {
    const co = await ledgerCompany()
    const id = await septSource(co)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let entered!: () => void
    const inside = new Promise<void>(r => { entered = r })
    ledgerCloseTestHooks.afterExclusiveLock = async () => { entered(); await gate }
    const close = closeMonth({ owner: co.owner, through: '2026-09-30', actorUserId: co.ownerUserId })
    await inside
    const poster = postSource('other_income', id)   // waits for the close
    await new Promise(res => setTimeout(res, 200))
    release()
    await close
    expect(await poster).toMatchObject({ posted: 1 })
    expect((await postingsOf('other_income', id))[0]).toMatchObject({ intended_date: '2026-09-10', accounting_date: '2026-10-01', is_correction: true })
    const snap = await db.query(`SELECT count(*)::int AS n FROM ledger_close_balances WHERE landlord_id = $1`, [co.landlordId])
    expect(snap.rows[0].n).toBe(0)
    expect(integrityOrDrift(await checkOwner(co.owner))).toEqual([])
  })
})
