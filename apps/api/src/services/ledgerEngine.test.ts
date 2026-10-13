/**
 * 10/12 (Nic) — GAM Books ledger, phase P3: the engine, end to end
 * (gam-ledger-design-2026-10-12 §3, §8, §9, §17 "Engine").
 *
 *   Nic: "within a minute (+ nightly tie-out check)"
 *
 * The engine is proven on a real money table with real capture triggers
 * (landlord_other_income through the test projector, never registered in
 * production) and, for shapes no table gives yet, on a projector whose wanted
 * postings the test sets by hand. The engine commits on its own connections,
 * so every test works on committed rows and starts from a clean database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedTenant } from '../test/dbHelpers'
import {
  inTx, ledgerCompany, addOtherIncome, postingsOf, linesOf, roleNet, outboxCount, memProjector, markChanged,
} from '../test/ledgerFixtures'
import type { PoolClient } from 'pg'
import {
  postSource, drainLedgerOutbox, kickLedgerAfterCommit, currentLedgerXid, registerLedgerProjector,
  unregisterLedgerProjector, registeredLedgerSourceTypes, ledgerTestHooks, normalizeDesired, storedFingerprint,
  resetLedgerStaleNoticeClock,
} from './ledgerEngine'
import { otherIncomeTestProjector } from './ledgerTestProjector'
import { rebuildOwner } from './ledgerRebuild'
import { checkOwner } from './ledgerCheck'
import { afterRowsSettled } from './settleHooks'

const OI = 'other_income'

beforeEach(async () => {
  await cleanupAllSchema()
  registerLedgerProjector(otherIncomeTestProjector)
})

afterEach(() => {
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
  delete ledgerTestHooks.afterOwnerLock
  delete ledgerTestHooks.beforeCommit
})

const activeOf = async (id: string) => (await postingsOf(OI, id)).filter(p => p.role === 'post' && !p.superseded_at)

describe('posting a source', () => {
  it('a money row posts balanced lines on its own day, tagged with its property, at the next drain', async () => {
    const co = await ledgerCompany()
    const id = await addOtherIncome(co, { amount: 125.5, day: '2026-09-15' })
    expect(await outboxCount(OI, id)).toBe(1)

    const s = await drainLedgerOutbox()
    expect(s).toMatchObject({ skipped: false, posted: 1, failed: 0 })
    expect(await outboxCount()).toBe(0)

    const [p] = await postingsOf(OI, id)
    expect(p).toMatchObject({ role: 'post', posting_kind: 'main', intended_date: '2026-09-15', accounting_date: '2026-09-15',
      is_correction: false, superseded_at: null, landlord_id: co.landlordId })
    const lines = await linesOf(p.id)
    expect(lines.map(l => [l.account_code, l.account_role, l.debit, l.credit, l.property_id, l.cash_effect, l.report_category]))
      .toEqual([
        ['1099', 'suspense', '125.50', '0.00', co.propertyId, null, null],
        ['4900', 'other_income', '0.00', '125.50', co.propertyId, 'in', 'other_income'],
      ])
    const c = await db.connect()
    try { expect(await storedFingerprint(c, p.id)).toBe(p.fingerprint) } finally { c.release() }
  })

  it('posting the same source again writes nothing (idempotent)', async () => {
    const co = await ledgerCompany()
    const id = await addOtherIncome(co, { amount: 40, day: '2026-09-02' })
    await drainLedgerOutbox()
    const again = await postSource(OI, id)
    expect(again).toMatchObject({ posted: 0, reversed: 0, unchanged: 1 })
    await markChanged(OI, id, co.landlordId)
    const s = await drainLedgerOutbox()
    expect(s).toMatchObject({ posted: 0, reversed: 0, unchanged: 1 })
    expect(await outboxCount()).toBe(0)
    expect(await postingsOf(OI, id)).toHaveLength(1)
  })

  it('a changed amount restates: the old posting is reversed line for line and superseded by the new one', async () => {
    const co = await ledgerCompany()
    const id = await addOtherIncome(co, { amount: 100, day: '2026-09-10' })
    await drainLedgerOutbox()
    await db.query(`UPDATE landlord_other_income SET amount = 160 WHERE id = $1`, [id])
    expect(await drainLedgerOutbox()).toMatchObject({ posted: 1, reversed: 1 })

    const [orig, rev, next] = await postingsOf(OI, id)
    expect(rev).toMatchObject({ role: 'reversal', reverses_posting_id: orig.id, is_correction: true,
      intended_date: '2026-09-10', accounting_date: '2026-09-10' })
    expect(orig.superseded_by).toBe(next.id)
    expect(orig.superseded_at).not.toBeNull()
    expect(next).toMatchObject({ role: 'post', is_correction: true, superseded_at: null, accounting_date: '2026-09-10' })
    const o = await linesOf(orig.id)
    const r = await linesOf(rev.id)
    expect(r.map(l => [l.account_id, l.property_id, l.debit, l.credit])).toEqual(o.map(l => [l.account_id, l.property_id, l.credit, l.debit]))
    expect(await roleNet(co.landlordId, 'other_income')).toBe(160)
    expect(await roleNet(co.landlordId, 'suspense')).toBe(-160)
  })

  it('a void reverses and posts nothing new; removing the row afterwards changes nothing more', async () => {
    const co = await ledgerCompany()
    const id = await addOtherIncome(co, { amount: 75, day: '2026-09-20' })
    await drainLedgerOutbox()
    await db.query(`UPDATE landlord_other_income SET status = 'voided', voided_at = now() WHERE id = $1`, [id])
    expect(await drainLedgerOutbox()).toMatchObject({ posted: 0, reversed: 1 })
    expect(await activeOf(id)).toHaveLength(0)
    expect(await roleNet(co.landlordId, 'other_income')).toBe(0)
    await db.query(`DELETE FROM landlord_other_income WHERE id = $1`, [id])
    expect(await drainLedgerOutbox()).toMatchObject({ posted: 0, reversed: 0, failed: 0 })
    expect(await postingsOf(OI, id)).toHaveLength(2)
  })

  it('a row removed while it still had a posting is reversed', async () => {
    const co = await ledgerCompany()
    const id = await addOtherIncome(co, { amount: 30, day: '2026-09-21' })
    await drainLedgerOutbox()
    await db.query(`DELETE FROM landlord_other_income WHERE id = $1`, [id])
    expect(await drainLedgerOutbox()).toMatchObject({ reversed: 1, posted: 0 })
    expect(await roleNet(co.landlordId, 'other_income')).toBe(0)
  })

  it('a new rule version with identical lines posts nothing (the fingerprint decides, not the version)', async () => {
    const co = await ledgerCompany()
    const id = await addOtherIncome(co, { amount: 12, day: '2026-09-03' })
    await drainLedgerOutbox()
    registerLedgerProjector({ ...otherIncomeTestProjector, ruleVersion: 7 })
    expect(await postSource(OI, id)).toMatchObject({ posted: 0, unchanged: 1 })
    expect((await postingsOf(OI, id))[0].rule_version).toBe(1)
  })

  it('value that moves between properties gets clearing lines, so every property balances on its own', async () => {
    const co = await ledgerCompany()
    const m = memProjector('deposit_slip')
    registerLedgerProjector(m.projector)
    const sid = randomUUID()
    m.wants.set(sid, [{ owner: co.owner, intendedDate: '2026-09-05', lines: [
      { role: 'suspense', debitCents: 10_000, propertyId: co.propertyId },
      { role: 'other_income', creditCents: 10_000, propertyId: co.propertyId2 },
    ] }])
    expect(await postSource('deposit_slip', sid)).toMatchObject({ posted: 1 })
    const [p] = await postingsOf('deposit_slip', sid)
    const lines = await linesOf(p.id)
    expect(lines).toHaveLength(4)
    const clearing = lines.filter(l => l.system_line)
    expect(clearing.map(l => [l.account_role, l.property_id, l.debit, l.credit]).sort()).toEqual([
      ['interproperty_clearing', co.propertyId, '0.00', '100.00'],
      ['interproperty_clearing', co.propertyId2, '100.00', '0.00'],
    ].sort())
    const byProp = new Map<string, number>()
    for (const l of lines) byProp.set(String(l.property_id), (byProp.get(String(l.property_id)) ?? 0) + Number(l.debit) - Number(l.credit))
    expect([...byProp.values()]).toEqual([0, 0])
  })

  it('lines that do not balance are refused: the source keeps its outbox row and its error, and an admin hears after 3 tries', async () => {
    const co = await ledgerCompany()
    const m = memProjector('deposit_slip')
    registerLedgerProjector(m.projector)
    const sid = randomUUID()
    m.wants.set(sid, [{ owner: co.owner, intendedDate: '2026-09-05', lines: [
      { role: 'suspense', debitCents: 10_000, propertyId: co.propertyId },
      { role: 'other_income', creditCents: 9_000, propertyId: co.propertyId },
    ] }])
    await markChanged('deposit_slip', sid, co.landlordId)
    const s = await drainLedgerOutbox()
    expect(s.failed).toBe(1)
    expect(await outboxCount('deposit_slip', sid)).toBe(1)
    const e1 = (await db.query(`SELECT reason_code, attempts, owner_id FROM ledger_source_errors WHERE source_id = $1`, [sid])).rows[0]
    expect(e1).toMatchObject({ reason_code: 'unbalanced', attempts: 1, owner_id: co.landlordId })
    for (let i = 0; i < 3; i++) expect((await postSource('deposit_slip', sid)).error?.reasonCode).toBe('unbalanced')
    const e4 = (await db.query(`SELECT attempts, noticed_at FROM ledger_source_errors WHERE source_id = $1`, [sid])).rows[0]
    expect(e4.attempts).toBe(4)
    expect(e4.noticed_at).not.toBeNull()
    const notes = await db.query(`SELECT title FROM admin_notifications WHERE category = 'books_ledger'`)
    expect(notes.rows.map(r => r.title)).toContain('A money record keeps failing to post to the books')
    expect(await postingsOf('deposit_slip', sid)).toHaveLength(0)
    // Fixed at the source: it posts and its error is gone.
    m.wants.get(sid)![0].lines[1].creditCents = 10_000
    expect((await drainLedgerOutbox({ ignoreBackoff: true })).posted).toBe(1)
    expect((await db.query(`SELECT 1 FROM ledger_source_errors WHERE source_id = $1`, [sid])).rows).toHaveLength(0)
    expect(await outboxCount()).toBe(0)
  })

  it('normalizeDesired refuses fractions of a cent, two-sided lines, unknown roles and computed roles', () => {
    const owner = { landlordId: randomUUID() }
    const bad = (lines: any[]) => () => normalizeDesired([{ owner, intendedDate: '2026-09-01', lines }], 'opening', 'x')
    expect(bad([{ role: 'suspense', debitCents: 10.5 }, { role: 'other_income', creditCents: 10.5 }])).toThrow(/whole-cent/)
    expect(bad([{ role: 'suspense', debitCents: 10, creditCents: 10 }])).toThrow(/exactly one/)
    expect(bad([{ role: 'no_such_role', debitCents: 10 }, { role: 'other_income', creditCents: 10 }])).toThrow(/Unknown posting role/)
    expect(bad([{ role: 'retained_earnings', debitCents: 10 }, { role: 'other_income', creditCents: 10 }])).toThrow(/worked out/)
    expect(() => normalizeDesired([{ owner, intendedDate: '9/1/2026', lines: [] }], 'opening', 'x')).toThrow(/intended date/)
  })
})

describe('the database guarantees', () => {
  async function postedLine(co: Awaited<ReturnType<typeof ledgerCompany>>) {
    const id = await addOtherIncome(co, { amount: 10, day: '2026-09-01' })
    await drainLedgerOutbox()
    const [p] = await postingsOf(OI, id)
    return { posting: p, lines: await linesOf(p.id) }
  }

  it('lines and postings are append-only: never changed, never removed', async () => {
    const co = await ledgerCompany()
    const { posting, lines } = await postedLine(co)
    await expect(db.query(`UPDATE ledger_posting_lines SET memo = 'x' WHERE posting_id = $1`, [posting.id])).rejects.toThrow(/never changed or removed/)
    await expect(db.query(`DELETE FROM ledger_posting_lines WHERE posting_id = $1`, [posting.id])).rejects.toThrow(/never changed or removed/)
    await expect(db.query(`UPDATE ledger_postings SET memo = 'x' WHERE id = $1`, [posting.id])).rejects.toThrow(/never changed/)
    await expect(db.query(`DELETE FROM ledger_postings WHERE id = $1`, [posting.id])).rejects.toThrow(/never removed/)
    await db.query(`UPDATE ledger_postings SET superseded_at = now() WHERE id = $1`, [posting.id]).catch(() => {})
    await expect(db.query(`UPDATE ledger_postings SET superseded_at = now() WHERE id = $1`, [posting.id])).rejects.toThrow(/already superseded/)
    expect(lines).toHaveLength(2)
  })

  it('a posting that does not balance per property, has one line, posts to another chart, or adds lines later is refused', async () => {
    const co = await ledgerCompany()
    const other = await ledgerCompany()
    const { posting, lines } = await postedLine(co)
    await postedLine(other)
    const otherAcct = (await db.query(`SELECT id FROM books_accounts WHERE landlord_id = $1 AND code = '1099'`, [other.landlordId])).rows[0].id
    const insertPosting = (c: any, pid: string) => c.query(
      `INSERT INTO ledger_postings (id, landlord_id, source_type, source_id, role, intended_date, accounting_date, fingerprint, rule_version)
       VALUES ($1, $2, 'opening', $3, 'post', '2026-09-01', '2026-09-01', 'x', 1)`, [pid, co.landlordId, randomUUID()])
    const insertLine = (c: any, pid: string, n: number, acct: string, dr: number, cr: number, prop: string | null) => c.query(
      `INSERT INTO ledger_posting_lines (posting_id, line_no, landlord_id, accounting_date, intended_date, account_id, property_id, debit, credit)
       VALUES ($1, $2, $3, '2026-09-01', '2026-09-01', $4, $5, $6, $7)`, [pid, n, co.landlordId, acct, prop, dr, cr])
    // One line only.
    await expect(inTx(async c => { const pid = randomUUID(); await insertPosting(c, pid); await insertLine(c, pid, 1, lines[0].account_id, 5, 0, null) }))
      .rejects.toThrow(/at least two/)
    // Balanced overall, not per property.
    await expect(inTx(async c => {
      const pid = randomUUID(); await insertPosting(c, pid)
      await insertLine(c, pid, 1, lines[0].account_id, 5, 0, co.propertyId)
      await insertLine(c, pid, 2, lines[1].account_id, 0, 5, co.propertyId2)
    })).rejects.toThrow(/does not balance for property/)
    // Another company's account.
    await expect(inTx(async c => { const pid = randomUUID(); await insertPosting(c, pid); await insertLine(c, pid, 1, otherAcct, 5, 0, null) }))
      .rejects.toThrow(/its own company's chart/)
    // A line added to a posting made in an earlier transaction.
    await expect(insertLine(db, posting.id, 9, lines[0].account_id, 1, 0, null)).rejects.toThrow(/same transaction/)
  })
})

describe('the books start date', () => {
  it('nothing dated before the books start posts (the opening posting carries it)', async () => {
    const co = await ledgerCompany({ booksStart: '2026-09-01' })
    const id = await addOtherIncome(co, { amount: 50, day: '2026-08-20' })
    const s = await drainLedgerOutbox()
    expect(s).toMatchObject({ posted: 0, failed: 0 })
    expect(await outboxCount()).toBe(0)
    expect(await postingsOf(OI, id)).toHaveLength(0)
    // The start moves earlier: the row is now inside the books.
    await db.query(`UPDATE landlords SET books_start_date = '2026-08-01' WHERE id = $1`, [co.landlordId])
    expect(await outboxCount('opening', co.landlordId)).toBe(1)
    expect(await postSource(OI, id)).toMatchObject({ posted: 1 })
    // …and later again: the posting is taken back.
    await db.query(`UPDATE landlords SET books_start_date = '2026-09-01' WHERE id = $1`, [co.landlordId])
    expect(await postSource(OI, id)).toMatchObject({ reversed: 1, posted: 0, suppressed: 1 })
  })

  it('a company with no books start date posts nothing and says why, until it picks one', async () => {
    const co = await ledgerCompany({ booksStart: null })
    const id = await addOtherIncome(co, { amount: 50, day: '2026-09-20' })
    expect((await drainLedgerOutbox()).failed).toBe(1)
    expect(await outboxCount(OI, id)).toBe(1)
    const e = (await db.query(`SELECT reason_code FROM ledger_source_errors WHERE source_id = $1`, [id])).rows[0]
    expect(e.reason_code).toBe('no_books_start')
    const r = await rebuildOwner(co.owner, { mode: 'apply' })
    expect(r.status).toBe('refused')
    expect(r.reason).toMatch(/no books start date/)
    // Picking a start date lets the waiting source through at once (no backoff wait).
    await db.query(`UPDATE landlords SET books_start_date = '2026-09-01' WHERE id = $1`, [co.landlordId])
    expect((await drainLedgerOutbox()).posted).toBe(1)
    expect(await activeOf(id)).toHaveLength(1)
  })
})

describe('the outbox, the drain and the kick', () => {
  it('a change committed after the drain read its key stays in the outbox for the next pass', async () => {
    const co = await ledgerCompany()
    const id = await addOtherIncome(co, { amount: 100, day: '2026-09-10' })
    let fired = false
    ledgerTestHooks.afterOwnerLock = async () => {
      if (fired) return
      fired = true
      // Committed by a money write while the poster is inside its transaction.
      await db.query(`UPDATE landlord_other_income SET amount = 130 WHERE id = $1`, [id])
    }
    const first = await drainLedgerOutbox()
    expect(first.posted).toBe(1)
    expect(await outboxCount(OI, id)).toBe(1)
    expect(await roleNet(co.landlordId, 'other_income')).toBe(100)
    delete ledgerTestHooks.afterOwnerLock
    expect(await drainLedgerOutbox()).toMatchObject({ reversed: 1, posted: 1 })
    expect(await roleNet(co.landlordId, 'other_income')).toBe(130)
    expect(await outboxCount()).toBe(0)
  })

  it('the kick posts one transaction\'s sources once it commits, waits while it is open, and posts nothing for a rollback', async () => {
    const co = await ledgerCompany()
    // Committed, then kicked.
    const committed = await inTx(async c => {
      const r = await c.query(`INSERT INTO landlord_other_income (landlord_id, property_id, category, amount, income_date)
                               VALUES ($1, $2, 'other', 20, '2026-09-11') RETURNING id`, [co.landlordId, co.propertyId])
      return { id: r.rows[0].id as string, xid: await currentLedgerXid(c) }
    })
    // Another company's waiting row is not this transaction's: the kick leaves it.
    const other = await addOtherIncome(co, { amount: 5, day: '2026-09-12' })
    expect(await kickLedgerAfterCommit(committed.xid)).toBe('drained')
    expect(await activeOf(committed.id)).toHaveLength(1)
    expect(await outboxCount(OI, other)).toBe(1)

    // Still open when kicked: the kick waits for it.
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const r = await c.query(`INSERT INTO landlord_other_income (landlord_id, property_id, category, amount, income_date)
                               VALUES ($1, $2, 'other', 21, '2026-09-11') RETURNING id`, [co.landlordId, co.propertyId])
      const xid = await currentLedgerXid(c)
      const kick = kickLedgerAfterCommit(xid)
      await new Promise(res => setTimeout(res, 150))
      await c.query('COMMIT')
      expect(await kick).toBe('drained')
      expect(await activeOf(r.rows[0].id)).toHaveLength(1)

      // Rolled back: nothing.
      await c.query('BEGIN')
      await c.query(`INSERT INTO landlord_other_income (landlord_id, category, amount, income_date) VALUES ($1, 'other', 22, '2026-09-11')`, [co.landlordId])
      const xid2 = await currentLedgerXid(c)
      await c.query('ROLLBACK')
      expect(await kickLedgerAfterCommit(xid2)).toBe('rolled_back')
    } finally {
      c.release()
    }
  })

  it('two posters of one source at once post it once (the drain and a kick racing)', async () => {
    const co = await ledgerCompany()
    const id = await addOtherIncome(co, { amount: 60, day: '2026-09-13' })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let entered!: () => void
    const inside = new Promise<void>(r => { entered = r })
    let first = true
    ledgerTestHooks.afterOwnerLock = async () => {
      if (!first) return
      first = false
      entered()
      await gate
    }
    const a = postSource(OI, id)
    await inside
    const b = postSource(OI, id)   // waits on the source lock
    await new Promise(res => setTimeout(res, 100))
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect([ra.posted, rb.posted].sort()).toEqual([0, 1])
    expect(rb.unchanged).toBe(1)
    expect(await postingsOf(OI, id)).toHaveLength(1)
  })

  it('only one minute drain runs at a time', async () => {
    const c = await db.connect()
    try {
      await c.query(`SELECT pg_advisory_lock(hashtextextended('ledger_drain', 0))`)
      expect((await drainLedgerOutbox()).skipped).toBe(true)
      await c.query(`SELECT pg_advisory_unlock(hashtextextended('ledger_drain', 0))`)
      expect((await drainLedgerOutbox()).skipped).toBe(false)
    } finally {
      c.release()
    }
  })

  it('a dark ledger (nothing registered) drains nothing and the kick is idle', async () => {
    unregisterLedgerProjector(OI)
    const co = await ledgerCompany()
    await addOtherIncome(co, { amount: 9, day: '2026-09-14' })
    expect(await drainLedgerOutbox()).toMatchObject({ keys: 0, posted: 0 })
    expect(await kickLedgerAfterCommit('1')).toBe('idle')
    expect(await outboxCount()).toBe(1)
  })

  it('a settle kicks the books right after it commits (settleHooks), and does nothing extra while the ledger is dark', async () => {
    const co = await ledgerCompany()
    const tenantId = await inTx(c => seedTenant(c))
    const m = memProjector('payment')
    const settle = async () => {
      const pid = (await db.query<{ id: string }>(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date)
         VALUES ($1, $2, $3, 'fee', 10, 'pending', 'OTHERFEE', CURRENT_DATE) RETURNING id`, [co.unitId, tenantId, co.landlordId])).rows[0].id
      // The bill's own insert was another transaction (the minute drain's); only the settle's rows are the kick's.
      await db.query(`DELETE FROM ledger_outbox WHERE source_id = $1`, [pid])
      const c = await db.connect()
      try {
        await c.query('BEGIN')
        const ids = (await c.query(`UPDATE payments SET status = 'settled', settled_at = now() WHERE id = $1 AND status <> 'settled' RETURNING id`, [pid])).rows.map(r => r.id)
        const after = await afterRowsSettled(c, ids, { attestationSource: 'gam_workflow_auto', receipt: null })
        await c.query('COMMIT')
        await after.afterCommit()
      } finally { c.release() }
      return pid
    }
    // Dark for payments: the settle's outbox rows wait.
    const darkPid = await settle()
    await new Promise(res => setTimeout(res, 300))
    expect(await outboxCount('payment', darkPid)).toBeGreaterThan(0)
    // Posting on: the kick drains the settle's own rows without waiting for the minute.
    registerLedgerProjector(m.projector)
    const pid = await settle()
    for (let i = 0; i < 50 && (await outboxCount('payment', pid)) > 0; i++) await new Promise(res => setTimeout(res, 100))
    expect(await outboxCount('payment', pid)).toBe(0)
    expect(await outboxCount('payment', darkPid)).toBeGreaterThan(0)   // another transaction's rows: the minute drain's
  })
})

describe('rebuild', () => {
  it('is deterministic: after normal posting a dry run and an apply find nothing, and from scratch re-posts identical lines', async () => {
    const co = await ledgerCompany()
    const ids = [
      await addOtherIncome(co, { amount: 10, day: '2026-09-01' }),
      await addOtherIncome(co, { amount: 20.25, day: '2026-09-05', propertyId: co.propertyId2 }),
      await addOtherIncome(co, { amount: 30, day: '2026-09-09', isCommon: true }),
    ]
    await drainLedgerOutbox()
    const before = await Promise.all(ids.map(async id => (await activeOf(id))[0].fingerprint))

    const dry = await rebuildOwner(co.owner, { mode: 'dry_run' })
    expect(dry).toMatchObject({ status: 'done', counts: { sources: 3, drift: 0, unchanged: 3, posted: 0 } })
    const apply = await rebuildOwner(co.owner, { mode: 'apply' })
    expect(apply.counts).toMatchObject({ sources: 3, posted: 0, reversed: 0, unchanged: 3, failed: 0 })
    const scratch = await rebuildOwner(co.owner, { mode: 'from_scratch' })
    expect(scratch.counts).toMatchObject({ sources: 3, posted: 3, reversed: 3, failed: 0 })

    const after = await Promise.all(ids.map(async id => (await activeOf(id))[0].fingerprint))
    expect(after).toEqual(before)
    expect(await roleNet(co.landlordId, 'other_income')).toBe(60.25)
    const runs = await db.query(`SELECT mode, status FROM ledger_rebuild_runs WHERE landlord_id = $1 ORDER BY started_at`, [co.landlordId])
    expect(runs.rows).toEqual([
      { mode: 'dry_run', status: 'done' }, { mode: 'apply', status: 'done' }, { mode: 'from_scratch', status: 'done' }])
    const check = await checkOwner(co.owner)
    expect(check.findings.filter(f => f.severity === 'integrity' || f.severity === 'drift')).toEqual([])
  })

  it('reverses a source whose row was removed while nothing was listening', async () => {
    const co = await ledgerCompany()
    const id = await addOtherIncome(co, { amount: 44, day: '2026-09-04' })
    await drainLedgerOutbox()
    await db.query(`DELETE FROM landlord_other_income WHERE id = $1`, [id])
    await db.query(`DELETE FROM ledger_outbox`)   // the change was never captured
    const dry = await rebuildOwner(co.owner, { mode: 'dry_run' })
    expect(dry.counts.drift).toBe(1)
    expect(dry.drift[0]).toMatchObject({ sourceId: id, status: 'stale' })
    expect((await rebuildOwner(co.owner, { mode: 'apply' })).counts).toMatchObject({ reversed: 1, posted: 0 })
    expect((await rebuildOwner(co.owner, { mode: 'dry_run' })).counts.drift).toBe(0)
  })
})

describe('the nightly check', () => {
  it('finds drift, records it, and re-posts it from the source — never a plug', async () => {
    const co = await ledgerCompany()
    const a = await addOtherIncome(co, { amount: 10, day: '2026-09-01' })
    const b = await addOtherIncome(co, { amount: 15, day: '2026-09-02' })
    await drainLedgerOutbox()
    await db.query(`UPDATE landlord_other_income SET amount = 18 WHERE id = $1`, [b])
    await db.query(`DELETE FROM ledger_outbox`)   // a change that was never captured

    const r1 = await checkOwner(co.owner)
    const drift = r1.findings.filter(f => f.severity === 'drift')
    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ check: 'source_drift', detail: { sourceId: b, status: 'changed' } })
    expect(r1.repaired).toBe(1)
    expect(await roleNet(co.landlordId, 'other_income')).toBe(28)
    const run = (await db.query(`SELECT mode, status, counts FROM ledger_rebuild_runs WHERE id = $1`, [r1.runId])).rows[0]
    expect(run).toMatchObject({ mode: 'check', status: 'done', counts: { drift: 1, integrity: 0, repaired: 1 } })
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'books_ledger' AND title LIKE '%drifted%'`)).rows).toHaveLength(1)
    // Nothing balancing was invented: every posting is a source's own.
    const kinds = await db.query(`SELECT DISTINCT source_type FROM ledger_postings WHERE landlord_id = $1`, [co.landlordId])
    expect(kinds.rows.map(x => x.source_type)).toEqual([OI])

    const r2 = await checkOwner(co.owner)
    expect(r2.findings.filter(f => f.severity !== 'info')).toEqual([])
    expect(a).toBeTruthy()
  })

  it('a source that keeps failing is reported as pending, not as drift', async () => {
    const co = await ledgerCompany()
    const m = memProjector('deposit_slip')
    registerLedgerProjector(m.projector)
    const sid = randomUUID()
    m.wants.set(sid, [{ owner: co.owner, intendedDate: '2026-09-05', lines: [] }])
    m.throwFor.add(sid)
    await markChanged('deposit_slip', sid, co.landlordId)
    const r = await checkOwner(co.owner)
    expect(r.findings.filter(f => f.severity === 'drift' || f.severity === 'integrity')).toEqual([])
    expect(r.findings.map(f => f.check)).toEqual(expect.arrayContaining(['failing', 'source_drift']))
    expect(r.findings.find(f => f.check === 'source_drift')!.severity).toBe('pending')
  })
})


describe('a moved books start date (10/12 (Nic) review)', () => {
  it('re-posts every source between the old and the new date, both ways, at the next drain — a rebuild then finds nothing', async () => {
    const co = await ledgerCompany({ booksStart: '2026-01-01' })
    const march = await addOtherIncome(co, { amount: 30, day: '2026-03-10' })
    const july = await addOtherIncome(co, { amount: 70, day: '2026-07-10' })
    await drainLedgerOutbox()
    expect(await activeOf(march)).toHaveLength(1)

    // Later: March now opens in the opening posting, so its own posting is taken back.
    await db.query(`UPDATE landlords SET books_start_date = '2026-06-01' WHERE id = $1`, [co.landlordId])
    expect(await outboxCount('books_start', `${co.landlordId}|2026-01-01|2026-06-01`)).toBe(1)
    await drainLedgerOutbox()
    expect(await activeOf(march)).toHaveLength(0)
    expect(await postingsOf(OI, july)).toHaveLength(1)   // after both dates: untouched
    expect(await outboxCount('books_start')).toBe(0)
    expect((await rebuildOwner(co.owner, { mode: 'dry_run' })).counts.drift).toBe(0)

    // Earlier again: March is inside the books and posts again.
    await db.query(`UPDATE landlords SET books_start_date = '2026-02-01' WHERE id = $1`, [co.landlordId])
    await drainLedgerOutbox()
    expect(await activeOf(march)).toHaveLength(1)
    expect((await rebuildOwner(co.owner, { mode: 'dry_run' })).counts.drift).toBe(0)
    expect((await checkOwner(co.owner)).findings.filter(f => f.severity === 'integrity' || f.severity === 'drift')).toEqual([])
  })

  it('picking a start date for the first time leaves no mark (nothing crossed it)', async () => {
    const co = await ledgerCompany({ booksStart: null })
    await db.query(`UPDATE landlords SET books_start_date = '2026-03-01' WHERE id = $1`, [co.landlordId])
    expect(await outboxCount('books_start')).toBe(0)
    expect(await outboxCount('opening', co.landlordId)).toBe(1)
  })
})

describe('the books never take what a money request needs (10/12 (Nic) review)', () => {
  it('with every API connection checked out, the drain and the after-commit kick still post (the books have their own pool)', async () => {
    const co = await ledgerCompany()
    const id = await addOtherIncome(co, { amount: 8, day: '2026-09-03' })
    const kicked = await inTx(async c => {
      const r = await c.query(`INSERT INTO landlord_other_income (landlord_id, property_id, category, amount, income_date)
                               VALUES ($1, $2, 'other', 9, '2026-09-04') RETURNING id`, [co.landlordId, co.propertyId])
      return { id: r.rows[0].id as string, xid: await currentLedgerXid(c) }
    })
    const held: PoolClient[] = []
    try {
      for (let i = 0; i < Number(db.options.max); i++) held.push(await db.connect())
      expect(db.idleCount).toBe(0)
      expect(await kickLedgerAfterCommit(kicked.xid)).toBe('drained')
      expect((await drainLedgerOutbox()).failed).toBe(0)
    } finally {
      for (const c of held) c.release()
    }
    expect(await activeOf(id)).toHaveLength(1)
    expect(await activeOf(kicked.id)).toHaveLength(1)
  })

  it('a poster that cannot get the company lock within a second steps aside: nothing written, no error, the outbox row waits for the next pass', async () => {
    const co = await ledgerCompany()
    const id = await addOtherIncome(co, { amount: 12, day: '2026-09-02' })
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      // What a month close holds, for longer than it ever does.
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`ledger_owner:${co.landlordId}`])
      const started = Date.now()
      expect(await drainLedgerOutbox()).toMatchObject({ keys: 1, deferred: 1, failed: 0, posted: 0 })
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(await postSource(OI, id)).toMatchObject({ busy: true, posted: 0 })
    } finally {
      await c.query('ROLLBACK').catch(() => {})
      c.release()
    }
    expect((await db.query(`SELECT 1 FROM ledger_source_errors WHERE source_id = $1`, [id])).rows).toHaveLength(0)
    expect(await outboxCount(OI, id)).toBe(1)
    expect((await drainLedgerOutbox()).posted).toBe(1)
  })

  it('kicks go through one queue: the same transaction kicked twice is one kick, and a burst all posts', async () => {
    const co = await ledgerCompany()
    const xids: string[] = []
    for (let i = 0; i < 12; i++) {
      xids.push(await inTx(async c => {
        await c.query(`INSERT INTO landlord_other_income (landlord_id, property_id, category, amount, income_date)
                       VALUES ($1, $2, 'other', $3, '2026-09-05')`, [co.landlordId, co.propertyId, i + 1])
        return currentLedgerXid(c)
      }))
    }
    const first = kickLedgerAfterCommit(xids[0])
    expect(kickLedgerAfterCommit(xids[0])).toBe(first)
    const results = await Promise.all([first, ...xids.slice(1).map(x => kickLedgerAfterCommit(x))])
    expect(results.every(r => r === 'drained')).toBe(true)
    expect(await outboxCount()).toBe(0)
    expect(await roleNet(co.landlordId, 'other_income')).toBe(78)
  })
})

describe('the "waiting to post" notice (10/12 (Nic) review)', () => {
  it('a source held back only because its company has not picked a books start date never raises it; a stuck one does', async () => {
    resetLedgerStaleNoticeClock()
    const waiting = () => db.query(`SELECT 1 FROM admin_notifications WHERE category = 'books_ledger' AND title LIKE '%waiting to post%'`)
    const noStart = await ledgerCompany({ booksStart: null })
    await addOtherIncome(noStart, { amount: 5, day: '2026-09-01' })
    await drainLedgerOutbox()
    await db.query(`UPDATE ledger_outbox SET at = now() - interval '20 minutes'`)
    await drainLedgerOutbox()
    expect((await waiting()).rows).toHaveLength(0)

    const co = await ledgerCompany()
    const m = memProjector('deposit_slip')
    registerLedgerProjector(m.projector)
    const sid = randomUUID()
    m.wants.set(sid, [{ owner: co.owner, intendedDate: '2026-09-05', lines: [] }])
    m.throwFor.add(sid)
    await markChanged('deposit_slip', sid, co.landlordId)
    await drainLedgerOutbox()
    await db.query(`UPDATE ledger_outbox SET at = now() - interval '20 minutes' WHERE source_id = $1`, [sid])
    await drainLedgerOutbox()
    expect((await waiting()).rows).toHaveLength(1)
    resetLedgerStaleNoticeClock()
  })
})
