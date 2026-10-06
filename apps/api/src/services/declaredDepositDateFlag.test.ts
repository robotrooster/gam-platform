/**
 * 10/5 (Nic) — the date a tenant says they deposited, against the bank's.
 *
 * "When we get to the bank reconciliation stage, if they mark that they
 * paid... not only do we match the deposit on the bank feed but if they say
 * they paid on time and it was actually late we need to make sure that they
 * get the late fee and then they get flagged for false information."
 *
 *   - The tenant's date counts only when the bank posted the deposit that day
 *     or the NEXT BUSINESS DAY after it (a weekend or a bank holiday rolls
 *     forward): their date governs, late fees after it come off.
 *   - Posted later than that: the bank's date governs (late fees up to it
 *     stand), the deposit still pays the bill, the report is flagged (both
 *     dates kept) and counts as a strike; the landlord sees "Said they
 *     deposited Oct 1 — the bank shows Oct 6." and the tenant is told plainly
 *     that the bank's date was used, and why.
 *   - Undoing the match takes the flag (and the strike) away with it.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stripeMocks = vi.hoisted(() => ({
  paymentIntentsCancel: vi.fn(async (id: string) => ({ id, status: 'canceled' })),
}))
vi.mock('../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getStripe: () => ({ paymentIntents: { cancel: stripeMocks.paymentIntentsCancel } }) }
})

import { db, getClient } from '../db'
import { confirmDepositMatch, undoDepositMatch } from './bankDepositConfirm'
import { candidatesForDeposit } from './bankDepositCandidates'
import { declarationStrikes, UNCONFIRMED_STRIKE_LIMIT } from './declaredDepositTrust'
import { effectivePaidDateFor, declaredDateIsFalse } from './depositBackdate'
import { declarationReaches } from './bankDepositMatch'
import { listPaymentsByMonth } from './paymentsByMonth'
import { bankDateUsedText, declaredDateFlagText } from '@gam/shared'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

interface Stack {
  landlordId: string; landlordUserId: string; tenantId: string; tenantUserId: string; unitId: string; leaseId: string
  invoiceId: string; rentId: string; txnId: string; declarationId: string; connId: string
}

/** Rent due 2026-10-01 ($450, unpaid), a report the tenant made, and the bank's deposit. */
async function buildStack(o: { declared: string; posted: string; tenantId?: string; landlord?: { landlordId: string; userId: string } }): Promise<Stack> {
  const client = await getClient()
  try {
    const ll = o.landlord ?? await seedLandlord(client)
    const landlordId = ll.landlordId
    const tenantId = o.tenantId ?? await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await client.query(`UPDATE properties SET timezone = 'America/Phoenix' WHERE id = $1`, [propertyId])
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 450 })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 450 })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    const inv = (await client.query(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount)
       VALUES ($1,$2,$3,$4,$5,'2026-10-01',450,450) RETURNING id`,
      [landlordId, tenantId, leaseId, unitId, `F-${randomUUID().slice(0, 8)}`])).rows[0]
    const rent = (await client.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'rent',450,'pending','2026-10-01','RENT') RETURNING id`,
      [inv.id, unitId, leaseId, tenantId, landlordId])).rows[0]
    const conn = (await client.query(
      `INSERT INTO bank_connections (landlord_id, provider, status) VALUES ($1,'stripe_fc','active') RETURNING id`,
      [landlordId])).rows[0]
    const txn = (await client.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
       VALUES ($1,$2,$3,$4::date,450,'BRANCH DEPOSIT','needs_review') RETURNING id`,
      [conn.id, landlordId, randomUUID(), o.posted])).rows[0]
    const decl = (await client.query(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method, reference)
       VALUES ($1,$2,$3,450,$4::date,'cash','DEP-1001') RETURNING id`,
      [tenantId, leaseId, landlordId, o.declared])).rows[0]
    const tenantUserId = (await client.query(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    await client.query(`UPDATE users SET first_name = 'Rae', last_name = 'Tull' WHERE id = $1`, [tenantUserId])
    return {
      landlordId, landlordUserId: ll.userId, tenantId, tenantUserId, unitId, leaseId,
      invoiceId: inv.id, rentId: rent.id, txnId: txn.id, declarationId: decl.id, connId: conn.id,
    }
  } finally { client.release() }
}

async function lateFee(s: Stack, day: string, amount = 10, settled = false): Promise<string> {
  return (await db.query(
    `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, settled_at)
     VALUES ($1,$2,$3,$4,$5,'late_fee',$6,$7,$8::date,'LATEFEE', CASE WHEN $7 = 'settled' THEN NOW() ELSE NULL END) RETURNING id`,
    [s.invoiceId, s.unitId, s.leaseId, s.tenantId, s.landlordId, amount, settled ? 'settled' : 'pending', day])).rows[0].id
}
const fee = async (id: string) => (await db.query(
  `SELECT amount::float AS amount, status FROM payments WHERE id = $1`, [id])).rows[0]
const report = async (id: string) => (await db.query(
  `SELECT status, to_char(bank_posted_date,'YYYY-MM-DD') AS bank_posted_date, false_date_flagged_at, resolution_note
     FROM tenant_declared_deposits WHERE id = $1`, [id])).rows[0]
const settledOn = async (id: string) => (await db.query(
  `SELECT to_char(settled_at,'YYYY-MM-DD') AS d FROM payments WHERE id = $1`, [id])).rows[0].d
const confirm = (s: Stack) => confirmDepositMatch({
  bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash', declarationId: s.declarationId,
})

describe('the rule, as arithmetic', () => {
  it('the same day and the next business day hold; a weekend and a bank holiday roll forward', () => {
    expect(effectivePaidDateFor('2026-10-01', '2026-10-01')).toBe('2026-10-01')
    expect(effectivePaidDateFor('2026-10-01', '2026-10-02')).toBe('2026-10-01')   // Thu → Fri
    expect(effectivePaidDateFor('2026-10-02', '2026-10-05')).toBe('2026-10-02')   // Fri → Mon
    expect(effectivePaidDateFor('2026-10-03', '2026-10-05')).toBe('2026-10-03')   // Sat → Mon
    expect(effectivePaidDateFor('2026-10-09', '2026-10-13')).toBe('2026-10-09')   // Fri → Tue (Columbus Day Mon)
    expect(declaredDateIsFalse('2026-10-09', '2026-10-13')).toBe(false)
  })
  it('posted later than that: the bank date, and the report is false', () => {
    expect(effectivePaidDateFor('2026-10-01', '2026-10-05')).toBe('2026-10-05')   // Thu → Mon: Fri was open
    expect(declaredDateIsFalse('2026-10-01', '2026-10-05')).toBe(true)
    expect(effectivePaidDateFor('2026-10-02', '2026-10-06')).toBe('2026-10-06')   // Fri → Tue
    expect(declaredDateIsFalse('2026-10-02', '2026-10-06')).toBe(true)
    // A date after the bank's claims nothing earlier, and is never false.
    expect(effectivePaidDateFor('2026-10-07', '2026-10-05')).toBe('2026-10-05')
    expect(declaredDateIsFalse('2026-10-07', '2026-10-05')).toBe(false)
  })
  it('a holiday on a Saturday leaves the Friday before open at the bank; one on a Sunday closes the Monday after', () => {
    // Jul 4, 2026 is a Saturday: banks are open Fri Jul 3 (the Federal Reserve's rule).
    expect(effectivePaidDateFor('2026-07-02', '2026-07-03')).toBe('2026-07-02')
    expect(declaredDateIsFalse('2026-07-02', '2026-07-06')).toBe(true)        // Thu → Mon: Fri was open
    // Jul 4, 2027 is a Sunday: banks close Mon Jul 5.
    expect(declaredDateIsFalse('2027-07-02', '2027-07-06')).toBe(false)       // Fri → Tue holds
  })
  it('a report reaches a deposit posted up to a week after its date (Nic’s Oct 1 → Oct 6)', () => {
    expect(declarationReaches('2026-10-01', '2026-10-06')).toBe(true)
    expect(declarationReaches('2026-10-01', '2026-10-08')).toBe(true)
    expect(declarationReaches('2026-10-01', '2026-10-09')).toBe(false)
    expect(declarationReaches('2026-10-05', '2026-10-01')).toBe(true)
    expect(declarationReaches('2026-10-06', '2026-10-01')).toBe(false)
  })
})

describe('the bank posted it when the tenant said (or the next business day)', () => {
  it('posted the same day: the tenant’s date governs, no flag', async () => {
    const s = await buildStack({ declared: '2026-10-05', posted: '2026-10-05' })
    const r = await confirm(s)
    expect(r.effectivePaidDate).toBe('2026-10-05')
    expect(r.declaredDateFlag).toBeNull()
    const d = await report(s.declarationId)
    expect(d.status).toBe('confirmed')
    expect(d.bank_posted_date).toBe('2026-10-05')
    expect(d.false_date_flagged_at).toBeNull()
    expect(await declarationStrikes(s.tenantId)).toBe(0)
  })

  it('posted the next business day: the late fee charged after the tenant’s date comes off', async () => {
    const s = await buildStack({ declared: '2026-10-01', posted: '2026-10-02' })
    const after = await lateFee(s, '2026-10-02')
    const r = await confirm(s)
    expect(r.effectivePaidDate).toBe('2026-10-01')
    expect(r.lateFeesUnbilled).toBe(10)
    expect(await fee(after)).toMatchObject({ amount: 0, status: 'settled' })
    expect(await settledOn(s.rentId)).toBe('2026-10-01')
    expect(r.declaredDateFlag).toBeNull()
  })

  it('Friday → Monday is honest: the weekend’s late fees come off', async () => {
    const s = await buildStack({ declared: '2026-10-02', posted: '2026-10-05' })
    const sat = await lateFee(s, '2026-10-03')
    const sun = await lateFee(s, '2026-10-04')
    const mon = await lateFee(s, '2026-10-05')
    const r = await confirm(s)
    expect(r.effectivePaidDate).toBe('2026-10-02')
    expect(r.lateFeesUnbilled).toBe(30)
    for (const id of [sat, sun, mon]) expect((await fee(id)).amount).toBe(0)
    expect((await report(s.declarationId)).false_date_flagged_at).toBeNull()
  })

  it('a bank holiday rolls forward too (Friday → Tuesday over Columbus Day)', async () => {
    const s = await buildStack({ declared: '2026-10-09', posted: '2026-10-13' })
    const r = await confirm(s)
    expect(r.effectivePaidDate).toBe('2026-10-09')
    expect(r.declaredDateFlag).toBeNull()
  })
})

describe('the bank posted it later than that — the stated date was false', () => {
  it('the bank’s date governs: late fees up to it stand, the deposit still pays the bill', async () => {
    const s = await buildStack({ declared: '2026-10-01', posted: '2026-10-06' })
    const before1 = await lateFee(s, '2026-10-02')
    const before2 = await lateFee(s, '2026-10-06')
    const afterBank = await lateFee(s, '2026-10-07')   // charged after the money WAS in the bank
    const r = await confirm(s)
    expect(r.effectivePaidDate).toBe('2026-10-06')
    expect(r.settledChargeIds).toContain(s.rentId)
    expect(await settledOn(s.rentId)).toBe('2026-10-06')
    expect(await fee(before1)).toMatchObject({ amount: 10, status: 'pending' })
    expect(await fee(before2)).toMatchObject({ amount: 10, status: 'pending' })
    expect((await fee(afterBank)).amount).toBe(0)
    expect(r.lateFeesUnbilled).toBe(10)
    expect(r.declaredDateFlag).toEqual({ declaredDate: '2026-10-01', bankPostedDate: '2026-10-06' })
  })

  it('the flag and both dates are kept, it is a strike, and the tenant is told plainly', async () => {
    const s = await buildStack({ declared: '2026-10-01', posted: '2026-10-06' })
    await confirm(s)
    const d = await report(s.declarationId)
    expect(d.status).toBe('confirmed')
    expect(d.bank_posted_date).toBe('2026-10-06')
    expect(d.false_date_flagged_at).not.toBeNull()
    expect(d.resolution_note).toBe(bankDateUsedText('2026-10-01', '2026-10-06'))
    expect(d.resolution_note).toBe(
      'The bank shows this deposit on Oct 6, not Oct 1. A deposit counts from the day you made it only when the bank shows it '
      + 'that day or the next business day, so your payment counts from Oct 6, and any late fees up to then stay.')
    expect(d.resolution_note).not.toMatch(/false|lie|fraud/i)
    expect(await declarationStrikes(s.tenantId)).toBe(1)

    // Told on their notice too, in the same words (after the commit).
    await new Promise(r => setTimeout(r, 150))
    const notes = (await db.query(`SELECT body FROM notifications WHERE user_id = $1`, [s.tenantUserId])).rows
    expect(notes.some((n: any) => n.body.includes(bankDateUsedText('2026-10-01', '2026-10-06')))).toBe(true)
  })

  it('the landlord sees the flag on the payment and on their notice', async () => {
    const s = await buildStack({ declared: '2026-10-01', posted: '2026-10-06' })
    await confirm(s)
    expect(declaredDateFlagText('2026-10-01', '2026-10-06')).toBe('Said they deposited Oct 1 — the bank shows Oct 6.')
    const ledger = await listPaymentsByMonth({ landlordIds: [s.landlordId], propertyIds: null, month: '2026-10', withTotals: false })
    const p = ledger.payments.find(x => x.method === 'cash')!
    expect(p.deposit_date_flag).toEqual({ said: '2026-10-01', bank: '2026-10-06' })
    await new Promise(r => setTimeout(r, 150))
    const notes = (await db.query(`SELECT body FROM notifications WHERE user_id = $1`, [s.landlordUserId])).rows
    expect(notes.some((n: any) => n.body.includes('Said they deposited Oct 1 — the bank shows Oct 6.'))).toBe(true)
  })

  it('the match screen says so before anything is recorded', async () => {
    const s = await buildStack({ declared: '2026-10-01', posted: '2026-10-06' })
    const c = await candidatesForDeposit({
      id: s.txnId, landlord_id: s.landlordId, amount: 450, posted_date: '2026-10-06', description: 'BRANCH DEPOSIT',
    })
    const top = c.candidates[0]
    expect(top.confidence).toBe('declared')
    expect(top.declaration).toMatchObject({ id: s.declarationId, declaredDate: '2026-10-01', reference: 'DEP-1001', dateHolds: false })
    // Said once — by the match screen's own flag line (from dateHolds), never also in the reason.
    expect(top.reason).not.toContain('Said they deposited')
  })

  it('a second flag reaches the strike limit and the landlord is told', async () => {
    const s1 = await buildStack({ declared: '2026-10-01', posted: '2026-10-06' })
    await confirm(s1)
    const s2 = await buildStack({
      declared: '2026-10-01', posted: '2026-10-06', tenantId: s1.tenantId,
      landlord: { landlordId: s1.landlordId, userId: s1.landlordUserId },
    })
    await confirm(s2)
    expect(await declarationStrikes(s1.tenantId)).toBe(UNCONFIRMED_STRIKE_LIMIT)
    await new Promise(r => setTimeout(r, 200))
    const told = (await db.query(
      `SELECT title, body FROM notifications WHERE user_id = $1 AND type = 'deposit_reports_unconfirmed'`, [s1.landlordUserId])).rows
    expect(told.length).toBeGreaterThan(0)
    // The landlord is told WHO — they cannot have the conversation without a name.
    expect(told[0].body).toMatch(/^Rae Tull \(.+\) has now made 2 bank deposit reports/)
  })

  it('a landlord is told only of reports made to them — never another company\'s', async () => {
    const a = await buildStack({ declared: '2026-10-01', posted: '2026-10-06' })
    await confirm(a)
    const b = await buildStack({ declared: '2026-10-01', posted: '2026-10-06', tenantId: a.tenantId })   // another landlord
    await confirm(b)
    // The button's trust is the tenant's own: both count there.
    expect(await declarationStrikes(a.tenantId)).toBe(2)
    expect(await declarationStrikes(a.tenantId, b.landlordId)).toBe(1)
    await new Promise(r => setTimeout(r, 200))
    const told = (await db.query(
      `SELECT 1 FROM notifications WHERE user_id = ANY($1::uuid[]) AND type = 'deposit_reports_unconfirmed'`,
      [[a.landlordUserId, b.landlordUserId]])).rows
    expect(told).toHaveLength(0)
  })

  it('a report the deposit would flag is never attached by amount alone — only when someone chose it', async () => {
    const s = await buildStack({ declared: '2026-10-01', posted: '2026-10-06' })
    const r = await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash' })
    expect(r.declarationId).toBeNull()
    expect(r.declaredDateFlag).toBeNull()
    expect(r.effectivePaidDate).toBe('2026-10-06')
    const d = await report(s.declarationId)
    expect(d.status).toBe('pending')
    expect(d.false_date_flagged_at).toBeNull()
    expect(await declarationStrikes(s.tenantId)).toBe(0)
  })

  it('undoing the match takes the flag and the strike away', async () => {
    const s = await buildStack({ declared: '2026-10-01', posted: '2026-10-06' })
    await confirm(s)
    await undoDepositMatch({ bankTransactionId: s.txnId, landlordId: s.landlordId, undoneBy: null })
    const d = await report(s.declarationId)
    expect(d.status).toBe('pending')
    expect(d.false_date_flagged_at).toBeNull()
    expect(d.bank_posted_date).toBeNull()
    expect(d.resolution_note).toBeNull()
    expect(await declarationStrikes(s.tenantId)).toBe(0)
  })
})

describe('a weekly payer with two reports a deposit could reach', () => {
  it('the deposit is this week’s report, never a flag on last week’s', async () => {
    const s = await buildStack({ declared: '2026-10-01', posted: '2026-10-08' })
    // This week's report, the same amount, made the day the bank posted it.
    const thisWeek = (await db.query(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method, reference)
       VALUES ($1,$2,$3,450,'2026-10-08','cash','DEP-1002') RETURNING id`,
      [s.tenantId, s.leaseId, s.landlordId])).rows[0].id
    const c = await candidatesForDeposit({
      id: s.txnId, landlord_id: s.landlordId, amount: 450, posted_date: '2026-10-08', description: 'BRANCH DEPOSIT',
    })
    expect(c.candidates.filter(x => x.confidence === 'declared')).toHaveLength(1)
    expect(c.candidates[0].declaration).toMatchObject({ id: thisWeek, dateHolds: true })
    // Confirmed without naming a report, the household's report the deposit bears out is the one used.
    const r = await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash' })
    expect(r.declarationId).toBe(thisWeek)
    expect(r.declaredDateFlag).toBeNull()
    expect((await report(s.declarationId)).status).toBe('pending')
  })
})
