/**
 * S655 money plan Step 12 (K-B, Nic 10/2): "Make a bank deposit".
 *
 * Staff tick what went into the bag (recorded receipts, register cash) and add
 * anything GAM never recorded with a note. The bank row for exactly that total
 * within 5 business days matches the slip; the extra is filed as other income.
 * Without a slip, a bank row that is everything not yet banked — or the only
 * combination of what was collected in the 10 days before it — matches by
 * itself; anything else waits for a person with the closest proposal.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import {
  createSlip, voidSlip, listSlips, cashProposalFor, findCashCombination, slipLastBankDay, matchSlipByHand,
} from './depositSlips'
import { reconcileDeposits, normalizeMerchant, upsertTransactions } from './bankFeed'
import { undoDepositMatch } from './bankDepositConfirm'
import { bankFeedRouter } from '../routes/bankFeed'
import { errorHandler } from '../middleware/errorHandler'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

interface Ctx { landlordId: string; propertyId: string; connectionId: string; userId: string }

async function build(): Promise<Ctx> {
  const c = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET timezone = 'America/Phoenix' WHERE id = $1`, [propertyId])
    const conn = (await c.query(
      `INSERT INTO bank_connections (landlord_id, provider, status) VALUES ($1,'stripe_fc','active') RETURNING id`,
      [landlordId])).rows[0]
    return { landlordId, propertyId, connectionId: conn.id, userId }
  } finally { c.release() }
}

/** A payment taken at the desk on `day`: the rent settled by hand and its receipt. */
async function receipt(ctx: Ctx, amount: number, day: string, opts: { propertyId?: string; first?: string } = {}) {
  const c = await getClient()
  try {
    const tenantId = await seedTenant(c)
    if (opts.first) {
      await c.query(`UPDATE users SET first_name = $2 WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId, opts.first])
    }
    const unitId = await seedUnit(c, { propertyId: opts.propertyId ?? ctx.propertyId, landlordId: ctx.landlordId, rentAmount: amount })
    const leaseId = await seedLease(c, { unitId, landlordId: ctx.landlordId, rentAmount: amount })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    const at = `${day}T18:00:00Z`
    const rentId = (await c.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                             entry_description, manual_method, settled_at)
       VALUES ($1,$2,$3,$4,'rent',$5,'settled',$6::date,'RENT','cash',$7) RETURNING id`,
      [unitId, leaseId, tenantId, ctx.landlordId, amount.toFixed(2), day, at])).rows[0].id
    const id = (await c.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, status,
                                       payment_method, settled_at, received_by)
       VALUES ($1,$2,$3,$4,$4,'settled','cash',$5,$6) RETURNING id`,
      [tenantId, leaseId, ctx.landlordId, amount.toFixed(2), at, ctx.userId])).rows[0].id
    await c.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,$3)`,
      [id, rentId, amount.toFixed(2)])
    return { id, tenantId, leaseId, unitId, rentId }
  } finally { c.release() }
}

async function bankRow(ctx: Ctx, amount: number, postedDate: string, description = 'BRANCH DEPOSIT') {
  return (await db.query(
    `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description,
                                    normalized_merchant, status, bank_status)
     VALUES ($1,$2,$3,$4::date,$5,$6,$7,'needs_review','posted') RETURNING id`,
    [ctx.connectionId, ctx.landlordId, randomUUID(), postedDate, amount.toFixed(2), description,
     normalizeMerchant(description)])).rows[0].id as string
}

const txnOf = async (id: string) => (await db.query(
  `SELECT status, landlord_other_income_id, auto_settle_undo FROM bank_transactions WHERE id = $1`, [id])).rows[0]
const slipOf = async (id: string) => (await db.query(
  `SELECT status, source, bank_transaction_id, total::float AS total FROM bank_deposit_slips WHERE id = $1`, [id])).rows[0]

describe('making a slip', () => {
  it('a slip’s total is its receipts plus other money', async () => {
    const ctx = await build()
    const a = await receipt(ctx, 460, '2026-09-28')
    const b = await receipt(ctx, 250.5, '2026-09-29')
    const slip = await createSlip({
      landlordId: ctx.landlordId, depositDate: '2026-09-30', receiptIds: [a.id, b.id],
      otherAmount: 37.25, otherNote: 'Laundry quarters', otherIsNotRent: true, createdBy: ctx.userId,
    })
    expect(slip.total).toBe(747.75)
    expect(slip.otherAmount).toBe(37.25)
    expect(slip.status).toBe('open')
    expect(slip.items.map(i => [i.payerName, i.amount]).sort()).toEqual([['Test Tenant', 250.5], ['Test Tenant', 460]])
  })

  it('other money needs a note and a "none of it is rent" answer', async () => {
    const ctx = await build()
    const base = { landlordId: ctx.landlordId, depositDate: '2026-09-30', otherAmount: 20, createdBy: ctx.userId }
    await expect(createSlip({ ...base, otherIsNotRent: true })).rejects.toThrow(/Say what the other money is/)
    await expect(createSlip({ ...base, otherNote: 'Laundry' })).rejects.toThrow(/Is any of the other money rent\? Record each rent payment first/)
    const ok = await createSlip({ ...base, otherNote: 'Laundry', otherIsNotRent: true, propertyIds: [ctx.propertyId] })
    expect(ok.total).toBe(20)
    expect(ok.propertyId).toBe(ctx.propertyId)
  })

  it('a receipt sits on one live slip at a time', async () => {
    const ctx = await build()
    const a = await receipt(ctx, 300, '2026-09-28', { first: 'Rosa' })
    const first = await createSlip({ landlordId: ctx.landlordId, depositDate: '2026-09-29', receiptIds: [a.id], createdBy: ctx.userId })
    await expect(createSlip({ landlordId: ctx.landlordId, depositDate: '2026-09-30', receiptIds: [a.id], createdBy: ctx.userId }))
      .rejects.toThrow('Rosa Tenant’s $300.00 is already on the 2026-09-29 deposit slip. Take it off that slip (void it) or leave it out of this one.')
    await voidSlip(ctx.landlordId, first.id, ctx.userId)
    const second = await createSlip({ landlordId: ctx.landlordId, depositDate: '2026-09-30', receiptIds: [a.id], createdBy: ctx.userId })
    expect(second.total).toBe(300)
    expect((await slipOf(first.id)).status).toBe('void')
  })

  it('a total that changed since the screen read it is refused so the screen refetches', async () => {
    const ctx = await build()
    const a = await receipt(ctx, 300, '2026-09-28')
    await expect(createSlip({ landlordId: ctx.landlordId, depositDate: '2026-09-29', receiptIds: [a.id],
      expectedTotal: 250, createdBy: ctx.userId })).rejects.toThrow(/this slip now comes to \$300\.00/)
  })

  it('a staffer can put only cash taken at their own properties on a slip', async () => {
    const ctx = await build()
    const c = await getClient()
    let other: string
    try {
      other = await seedProperty(c, { landlordId: ctx.landlordId, ownerUserId: ctx.userId, managedByUserId: ctx.userId })
    } finally { c.release() }
    const mine = await receipt(ctx, 100, '2026-09-28')
    const theirs = await receipt(ctx, 200, '2026-09-28', { propertyId: other })
    await expect(createSlip({ landlordId: ctx.landlordId, depositDate: '2026-09-29', receiptIds: [theirs.id],
      createdBy: ctx.userId, propertyIds: [ctx.propertyId] })).rejects.toThrow(/property you are not assigned to/)
    const ok = await createSlip({ landlordId: ctx.landlordId, depositDate: '2026-09-29', receiptIds: [mine.id],
      createdBy: ctx.userId, propertyIds: [ctx.propertyId] })
    expect(ok.total).toBe(100)
  })
})

describe('the bank row arrives', () => {
  it('a bank row equal to an open slip within 5 business days matches it and files the extra as other income', async () => {
    const ctx = await build()
    const a = await receipt(ctx, 460, '2026-09-25')
    const slip = await createSlip({
      landlordId: ctx.landlordId, depositDate: '2026-09-28', receiptIds: [a.id],
      otherAmount: 40, otherNote: 'Laundry quarters', otherIsNotRent: true, createdBy: ctx.userId,
    })
    expect(slipLastBankDay('2026-09-28')).toBe('2026-10-05')
    const late = await bankRow(ctx, 500, '2026-10-06')        // the 6th business day: too late
    await reconcileDeposits(ctx.landlordId)
    expect((await txnOf(late)).status).toBe('needs_review')
    const t = await bankRow(ctx, 500, '2026-10-05')           // the 5th business day
    const r = await reconcileDeposits(ctx.landlordId)
    expect(r.slips).toBe(1)
    const row = await txnOf(t)
    expect(row.status).toBe('matched')
    expect(await slipOf(slip.id)).toMatchObject({ status: 'matched', bank_transaction_id: t })
    const inc = (await db.query(
      `SELECT amount::float AS amount, description, income_date::text AS income_date, status, property_id
         FROM landlord_other_income WHERE id = $1`, [row.landlord_other_income_id])).rows[0]
    expect(inc).toMatchObject({ amount: 40, description: 'Laundry quarters', income_date: '2026-10-05', status: 'active', property_id: ctx.propertyId })
  })

  it('deposited everything matches without a slip', async () => {
    const ctx = await build()
    const a = await receipt(ctx, 460, '2026-09-20')
    const b = await receipt(ctx, 250, '2026-09-28')
    const c = await receipt(ctx, 125.75, '2026-09-29')
    const t = await bankRow(ctx, 835.75, '2026-09-30')
    const r = await reconcileDeposits(ctx.landlordId)
    expect(r.inferred).toBe(1)
    expect((await txnOf(t)).status).toBe('matched')
    const slip = (await db.query(
      `SELECT id, source, status, total::float AS total, created_by FROM bank_deposit_slips WHERE bank_transaction_id = $1`, [t])).rows[0]
    expect(slip).toMatchObject({ source: 'inferred', status: 'matched', total: 835.75, created_by: null })
    const items = (await db.query(`SELECT remittance_id FROM bank_deposit_slip_items WHERE slip_id = $1`, [slip.id])).rows
    expect(items.map((i: any) => i.remittance_id).sort()).toEqual([a.id, b.id, c.id].sort())
  })

  it('exactly one combination within 10 days matches; anything else waits with the closest proposal', async () => {
    // One combination: 300 + 125 = 425 (the 460 is too big; the 90 from 3 weeks ago is outside the window).
    const one = await build()
    await receipt(one, 90, '2026-09-05')
    const r300 = await receipt(one, 300, '2026-09-26')
    const r125 = await receipt(one, 125, '2026-09-27')
    await receipt(one, 460, '2026-09-28')
    const t1 = await bankRow(one, 425, '2026-09-30')
    expect((await reconcileDeposits(one.landlordId)).inferred).toBe(1)
    const items = (await db.query(
      `SELECT i.remittance_id FROM bank_deposit_slip_items i JOIN bank_deposit_slips s ON s.id = i.slip_id
        WHERE s.bank_transaction_id = $1`, [t1])).rows.map((x: any) => x.remittance_id).sort()
    expect(items).toEqual([r300.id, r125.id].sort())

    // Two combinations (100+50 and 75+75): waits, with one proposed.
    const two = await build()
    await receipt(two, 100, '2026-09-26')
    await receipt(two, 50, '2026-09-26')
    await receipt(two, 75, '2026-09-27')
    await receipt(two, 75, '2026-09-28')
    await receipt(two, 400, '2026-09-28')
    const t2 = await bankRow(two, 150, '2026-09-30')
    expect((await reconcileDeposits(two.landlordId)).inferred).toBe(0)
    expect((await txnOf(t2)).status).toBe('needs_review')
    const p2 = await cashProposalFor(db, two.landlordId, { amount: 150, posted_date: '2026-09-30' })
    expect(p2.kind).toBe('several')
    expect(p2.totalCents).toBe(15000)
    expect(p2.items.map(i => i.amount).sort((x, y) => x - y)).toEqual([50, 100])

    // Nothing adds up: waits, with the closest proposed.
    const none = await build()
    await receipt(none, 100, '2026-09-26')
    await receipt(none, 60, '2026-09-27')
    const t3 = await bankRow(none, 150, '2026-09-30')
    expect((await reconcileDeposits(none.landlordId)).inferred).toBe(0)
    expect((await txnOf(t3)).status).toBe('needs_review')
    const p3 = await cashProposalFor(db, none.landlordId, { amount: 150, posted_date: '2026-09-30' })
    expect(p3.kind).toBe('closest')
    expect(p3.totalCents).toBe(10000)
    expect(p3.note).toMatch(/The closest is \$100\.00 — \$50\.00 short/)
  })

  it('a Wells Fargo branch deposit, written with its time and street, is the office’s cash', async () => {
    const ctx = await build()
    await receipt(ctx, 460, '2026-09-14')
    await receipt(ctx, 323.39, '2026-09-15')
    const t = await bankRow(ctx, 783.39, '2026-09-15',
      'EDEPOSIT IN BRANCH 09/15/26 02:31:45 PM 123 W CONTINENTAL RD GREEN VALLEY AZ')
    expect((await reconcileDeposits(ctx.landlordId)).inferred).toBe(1)
    expect((await txnOf(t)).status).toBe('matched')
  })

  it('DEPOSIT MADE IN A BRANCH/STORE is the office’s cash', async () => {
    // Step 12 fix round 2: "MADE" and "A" are the bank's words, not a payer's.
    // Before, the payer key "DEPOSIT MADE IN A" read as a named payer, so the
    // office's own bag was never worked out for it.
    const ctx = await build()
    await receipt(ctx, 460, '2026-09-28')
    await receipt(ctx, 125.5, '2026-09-29')
    const t = await bankRow(ctx, 585.5, '2026-09-30', 'DEPOSIT MADE IN A BRANCH/STORE CHECK')
    expect((await reconcileDeposits(ctx.landlordId)).inferred).toBe(1)
    expect((await txnOf(t)).status).toBe('matched')
  })

  it('a deposit whose memo names a payer is never taken for the office’s cash', async () => {
    const ctx = await build()
    await receipt(ctx, 48.39, '2026-09-30')
    const t = await bankRow(ctx, 48.39, '2026-10-01', 'Square Inc       SQ261001   261001 T3H80F2ZQ67M')
    expect((await reconcileDeposits(ctx.landlordId)).inferred).toBe(0)
    expect((await txnOf(t)).status).toBe('needs_review')
  })

  it('a slip with a same-amount reported deposit goes to review', async () => {
    const ctx = await build()
    const a = await receipt(ctx, 250, '2026-09-27')
    const slip = await createSlip({ landlordId: ctx.landlordId, depositDate: '2026-09-28', receiptIds: [a.id], createdBy: ctx.userId })
    // A tenant says they paid $250 at the bank that week.
    const t2 = await receipt(ctx, 999, '2026-09-01')
    await db.query(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method)
       VALUES ($1,$2,$3,250,'2026-09-29','cash')`, [t2.tenantId, t2.leaseId, ctx.landlordId])
    const t = await bankRow(ctx, 250, '2026-09-29')
    const r = await reconcileDeposits(ctx.landlordId)
    expect(r.slips + r.declared + r.inferred + r.autoSettled).toBe(0)
    expect((await txnOf(t)).status).toBe('needs_review')
    expect((await slipOf(slip.id)).status).toBe('open')
  })

  it('a slip and a tenant’s whole bill of the same amount: neither is applied by itself', async () => {
    const ctx = await build()
    const a = await receipt(ctx, 815, '2026-09-27')
    const slip = await createSlip({ landlordId: ctx.landlordId, depositDate: '2026-09-28', receiptIds: [a.id], createdBy: ctx.userId })
    const b = await receipt(ctx, 1, '2026-09-01')
    const rent = (await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, created_at)
       VALUES ($1,$2,$3,$4,'rent',815,'pending','2026-09-25','RENT','2026-09-25T14:00:00Z') RETURNING id`,
      [b.unitId, b.leaseId, b.tenantId, ctx.landlordId])).rows[0].id
    const t = await bankRow(ctx, 815, '2026-09-30')
    const r = await reconcileDeposits(ctx.landlordId)
    expect(r.slips + r.autoSettled).toBe(0)
    expect((await txnOf(t)).status).toBe('needs_review')
    expect((await slipOf(slip.id)).status).toBe('open')
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [rent])).rows[0].status).toBe('pending')
  })

  it('two slips of the same amount wait for a person, who matches the right one by hand', async () => {
    const ctx = await build()
    const a = await receipt(ctx, 200, '2026-09-26')
    const b = await receipt(ctx, 200, '2026-09-27')
    const first = await createSlip({ landlordId: ctx.landlordId, depositDate: '2026-09-28', receiptIds: [a.id], createdBy: ctx.userId })
    const second = await createSlip({ landlordId: ctx.landlordId, depositDate: '2026-09-28', receiptIds: [b.id], createdBy: ctx.userId })
    const t = await bankRow(ctx, 200, '2026-09-29')
    expect((await reconcileDeposits(ctx.landlordId)).slips).toBe(0)
    expect((await txnOf(t)).status).toBe('needs_review')
    const matched = await matchSlipByHand(ctx.landlordId, second.id, t, ctx.userId)
    expect(matched.status).toBe('matched')
    expect((await txnOf(t)).status).toBe('matched')
    expect((await slipOf(first.id)).status).toBe('open')
    await expect(matchSlipByHand(ctx.landlordId, first.id, t, ctx.userId)).rejects.toThrow('That bank deposit is already filed or matched.')
  })

  it('a slip made after its bank row arrived matches at once', async () => {
    const ctx = await build()
    const a = await receipt(ctx, 410, '2026-09-27')
    const t = await bankRow(ctx, 410, '2026-09-30', 'BRANCH DEPOSIT')
    // Not everything: another receipt is still in the drawer, so nothing is worked out alone.
    await receipt(ctx, 410, '2026-09-26')
    await reconcileDeposits(ctx.landlordId)
    expect((await txnOf(t)).status).toBe('needs_review')
    const slip = await createSlip({ landlordId: ctx.landlordId, depositDate: '2026-09-29', receiptIds: [a.id], createdBy: ctx.userId })
    expect((await slipOf(slip.id)).status).toBe('matched')
    expect((await txnOf(t)).status).toBe('matched')
  })
})

describe('flags and undo', () => {
  it('a slip not seen in 5 business days is flagged', async () => {
    const ctx = await build()
    const a = await receipt(ctx, 120, '2026-08-28')
    const b = await receipt(ctx, 80, '2026-08-28')
    const old = await createSlip({ landlordId: ctx.landlordId, depositDate: '2026-09-01', receiptIds: [a.id], createdBy: ctx.userId })
    const today = (await db.query(`SELECT to_char((now() AT TIME ZONE 'America/Phoenix')::date, 'YYYY-MM-DD') AS d`)).rows[0].d
    const fresh = await createSlip({ landlordId: ctx.landlordId, depositDate: today, receiptIds: [b.id], createdBy: ctx.userId })
    const slips = await listSlips(ctx.landlordId)
    const o = slips.find(s => s.id === old.id)!
    const f = slips.find(s => s.id === fresh.id)!
    expect(o.overdue).toBe(true)
    expect(o.flag).toMatch(/^Not seen at the bank by 2026-09-09 \(5 business days after 2026-09-01\)/)
    expect(f.overdue).toBe(false)
    expect(f.flag).toBeNull()
  })

  it('undoing a slip match reopens the slip, voids its other income, and the feed never re-matches that deposit by itself', async () => {
    const ctx = await build()
    const a = await receipt(ctx, 460, '2026-09-25')
    const slip = await createSlip({
      landlordId: ctx.landlordId, depositDate: '2026-09-28', receiptIds: [a.id],
      otherAmount: 40, otherNote: 'Laundry', otherIsNotRent: true, createdBy: ctx.userId,
    })
    const t = await bankRow(ctx, 500, '2026-09-29')
    await reconcileDeposits(ctx.landlordId)
    const income = (await txnOf(t)).landlord_other_income_id
    expect(income).toBeTruthy()
    const res = await undoDepositMatch({ bankTransactionId: t, landlordId: ctx.landlordId, undoneBy: ctx.userId })
    expect(res).toMatchObject({ kind: 'deposit_slip', slipReopened: true })
    expect((await slipOf(slip.id)).status).toBe('open')
    expect((await db.query(`SELECT status FROM landlord_other_income WHERE id = $1`, [income])).rows[0].status).toBe('voided')
    const row = await txnOf(t)
    expect(row.status).toBe('needs_review')
    expect(row.auto_settle_undo.undone).toBe(true)
    await reconcileDeposits(ctx.landlordId)
    expect((await txnOf(t)).status).toBe('needs_review')
    // A matched slip cannot be voided; an open one can.
    await voidSlip(ctx.landlordId, slip.id, ctx.userId)
    expect((await slipOf(slip.id)).status).toBe('void')
  })

  it('a matched slip cannot be voided — the match is undone first', async () => {
    const ctx = await build()
    const a = await receipt(ctx, 70, '2026-09-25')
    const slip = await createSlip({ landlordId: ctx.landlordId, depositDate: '2026-09-28', receiptIds: [a.id], createdBy: ctx.userId })
    await bankRow(ctx, 70, '2026-09-29')
    await reconcileDeposits(ctx.landlordId)
    await expect(voidSlip(ctx.landlordId, slip.id, ctx.userId)).rejects.toThrow(/already matched to the \$70\.00 bank deposit of 2026-09-29/)
  })
})

describe('Step 12 review: the bank changes its mind, and two hands at once', () => {
  it('when the bank voids a deposit matched to a slip, the owner is told the office’s deposit never came in', async () => {
    const ctx = await build()
    const a = await receipt(ctx, 460, '2026-09-25')
    const b = await receipt(ctx, 75, '2026-09-26')
    const slip = await createSlip({
      landlordId: ctx.landlordId, depositDate: '2026-09-28', receiptIds: [a.id, b.id], createdBy: ctx.userId,
    })
    await upsertTransactions(ctx.connectionId, ctx.landlordId, [
      { externalId: 'bag_1', postedDate: '2026-09-29', amount: 535, description: 'BRANCH DEPOSIT' },
    ])
    expect((await slipOf(slip.id)).status).toBe('matched')
    await upsertTransactions(ctx.connectionId, ctx.landlordId, [
      { externalId: 'bag_1', postedDate: '2026-09-29', amount: 535, description: 'BRANCH DEPOSIT', status: 'void' },
    ])
    const n = (await db.query(`SELECT title, body, action_url FROM notifications WHERE user_id = $1 AND type = 'bank_deposit_voided'`,
      [ctx.userId])).rows
    expect(n).toEqual([{
      title: 'Your bank voided an office deposit',
      body: 'Your bank voided the $535.00 deposit of 2026-09-29 that was matched to your deposit slip of 2026-09-28 (2 payments) — the money did not come in. ' +
        'Find out what happened to that bag. Then open the deposit on the Bank page and press Undo, so those payments show as not banked again.',
      action_url: '/bank',
    }])
    // Undo still works on the voided row, and the payments are waiting to be banked again.
    const t = (await db.query(`SELECT id FROM bank_transactions WHERE external_id = 'bag_1'`)).rows[0].id
    await undoDepositMatch({ bankTransactionId: t, landlordId: ctx.landlordId, undoneBy: ctx.userId })
    expect((await slipOf(slip.id)).status).toBe('open')
  })

  it('a person matching a slip while the sync holds the same deposit waits its turn — never a deadlock', async () => {
    const ctx = await build()
    const a = await receipt(ctx, 200, '2026-09-26')
    const slip = await createSlip({ landlordId: ctx.landlordId, depositDate: '2026-09-28', receiptIds: [a.id], createdBy: ctx.userId })
    const t = await bankRow(ctx, 200, '2026-09-29')
    // The sync's order: the bank row, then the slip.
    const sync = await getClient()
    try {
      await sync.query('BEGIN')
      await sync.query(`SELECT id FROM bank_transactions WHERE id = $1 FOR UPDATE`, [t])
      const byHand = matchSlipByHand(ctx.landlordId, slip.id, t, ctx.userId).then(v => ({ ok: v }), e => ({ err: e }))
      // Wait until the person's match is queued behind the sync.
      for (let i = 0; i < 100; i++) {
        const w = (await db.query(
          `SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].n
        if (w > 0) break
        await new Promise(r => setTimeout(r, 20))
      }
      // The sync still gets the slip (the person did not take it first).
      await sync.query(`SET LOCAL lock_timeout = '3s'`)
      await sync.query(`SELECT id FROM bank_deposit_slips WHERE id = $1 FOR UPDATE`, [slip.id])
      await sync.query('ROLLBACK')
      const r: any = await byHand
      expect(r.err).toBeUndefined()
      expect(r.ok.status).toBe('matched')
    } finally { sync.release() }
    expect((await txnOf(t)).status).toBe('matched')
  })
})

describe('finding the combination', () => {
  it('counts to two and keeps the oldest first', () => {
    expect(findCashCombination([100, 50, 75, 75], 150)).toMatchObject({ exactCount: 2, exact: [0, 1] })
    expect(findCashCombination([300, 125, 460], 425)).toMatchObject({ exactCount: 1, exact: [0, 1] })
    expect(findCashCombination([100, 60], 150)).toMatchObject({ exactCount: 0, closestCents: 100, closest: [0] })
    // Everything together is still short: the closest is everything.
    expect(findCashCombination([1250, 46000], 49760)).toMatchObject({ exactCount: 0, closestCents: 47250, closest: [0, 1] })
  })

  it('a search that runs out of steps never reads as one sure answer', () => {
    // Every amount even, the target odd: nothing adds up, and proving it takes a long search.
    const many = Array.from({ length: 40 }, (_, i) => 200 + 2 * i)
    const r = findCashCombination(many, 5001, 1000)
    expect(r.exhausted).toBe(true)
    expect(r.exactCount).toBe(0)
  })
})

describe('the routes, for front-desk staff', () => {
  const SECRET = 'test_jwt_secret_slips'
  function app() {
    const a = express()
    a.use(express.json())
    a.use('/api/bank-feed', bankFeedRouter)
    a.use(errorHandler)
    return a
  }
  async function staff(ctx: Ctx, perms: Record<string, boolean>) {
    process.env.JWT_SECRET = SECRET
    const u = (await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Lisa','Desk',TRUE) RETURNING id`, [`fd-${randomUUID()}@t.dev`])).rows[0].id
    await db.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, permissions) VALUES ($1,$2,$3,$4::jsonb)`,
      [u, ctx.landlordId, [ctx.propertyId], JSON.stringify(perms)])
    return jwt.sign({ userId: u, role: 'onsite_manager', email: 'x@t.dev', profileId: null,
      landlordId: ctx.landlordId, permissions: perms }, SECRET, { expiresIn: '1h' })
  }

  it('staff who take payments list what is not banked and make a slip; staff who do not are refused', async () => {
    const ctx = await build()
    const c = await getClient()
    let other: string
    try {
      other = await seedProperty(c, { landlordId: ctx.landlordId, ownerUserId: ctx.userId, managedByUserId: ctx.userId })
    } finally { c.release() }
    const mine = await receipt(ctx, 100, '2026-09-28')
    await receipt(ctx, 200, '2026-09-28', { propertyId: other })
    const tok = await staff(ctx, { take_payment: true })
    const list = await request(app()).get('/api/bank-feed/deposits/undeposited').set('Authorization', `Bearer ${tok}`)
    expect(list.status, JSON.stringify(list.body)).toBe(200)
    expect(list.body.data.notOnSlip.map((i: any) => i.id)).toEqual([mine.id])
    const made = await request(app()).post('/api/bank-feed/deposit-slips').set('Authorization', `Bearer ${tok}`)
      .send({ depositDate: '2026-09-29', receiptIds: [mine.id], expectedTotal: 100 })
    expect(made.status, JSON.stringify(made.body)).toBe(200)
    expect(made.body.data.total).toBe(100)
    const after = await request(app()).get('/api/bank-feed/deposits/undeposited').set('Authorization', `Bearer ${tok}`)
    expect(after.body.data.onSlip.map((i: any) => i.id)).toEqual([mine.id])
    // Matching a slip to a bank row is the owner's.
    const t = await bankRow(ctx, 5, '2026-09-29')
    const refused = await request(app()).post('/api/bank-feed/deposit-slips').set('Authorization', `Bearer ${tok}`)
      .send({ depositDate: '2026-09-29', otherAmount: 5, otherNote: 'x', otherIsNotRent: true, bankTransactionId: t })
    expect(refused.status).toBe(403)

    const noPerm = await staff(ctx, {})
    const denied = await request(app()).get('/api/bank-feed/deposits/undeposited').set('Authorization', `Bearer ${noPerm}`)
    expect(denied.status).toBe(403)
  })

  it('a staffer with every property sees the slips but never the bank’s own deposits; the owner sees them', async () => {
    const ctx = await build()
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
    await receipt(ctx, 120, day(3))
    const t = await bankRow(ctx, 120.5, day(1))   // no combination is exact: it waits, with the closest proposal
    process.env.JWT_SECRET = SECRET
    const u = (await db.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','onsite_manager','Lisa','Desk',TRUE) RETURNING id`, [`fd-${randomUUID()}@t.dev`])).rows[0].id
    await db.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, all_properties, permissions) VALUES ($1,$2,TRUE,$3::jsonb)`,
      [u, ctx.landlordId, JSON.stringify({ take_payment: true })])
    const staffTok = jwt.sign({ userId: u, role: 'onsite_manager', email: 'x@t.dev', profileId: null,
      landlordId: ctx.landlordId, permissions: { take_payment: true } }, SECRET, { expiresIn: '1h' })
    const asStaff = await request(app()).get('/api/bank-feed/deposit-slips').set('Authorization', `Bearer ${staffTok}`)
    expect(asStaff.status, JSON.stringify(asStaff.body)).toBe(200)
    expect(asStaff.body.data.waiting).toEqual([])

    const ownerTok = jwt.sign({ userId: ctx.userId, role: 'landlord', email: 'o@t.dev', profileId: null,
      landlordIds: [ctx.landlordId], permissions: {} }, SECRET, { expiresIn: '1h' })
    const asOwner = await request(app()).get('/api/bank-feed/deposit-slips').set('Authorization', `Bearer ${ownerTok}`)
    expect(asOwner.status, JSON.stringify(asOwner.body)).toBe(200)
    expect(asOwner.body.data.waiting.map((w: any) => w.transactionId)).toEqual([t])
  })

  // decisions.md #48.1, on the owner's deposit-slip screen and both slip-match routes.
  it('a transfer memo gets no office-cash proposal or fitting slip and cannot be matched to a slip', async () => {
    const ctx = await build()
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
    const onSlip = await receipt(ctx, 100, day(3))
    const loose = await receipt(ctx, 50, day(3))
    const slip = await createSlip({ landlordId: ctx.landlordId, depositDate: day(2), receiptIds: [onSlip.id], createdBy: ctx.userId })
    // Same amounts as the open slip and the loose cash, but the memo says the money moved between accounts.
    const xferSlip = await bankRow(ctx, 100, day(1), 'ONLINE TRANSFER FROM CHK 1234')
    const xferCash = await bankRow(ctx, 50, day(1), 'XFER FROM SAVINGS 5678')
    process.env.JWT_SECRET = SECRET
    const ownerTok = jwt.sign({ userId: ctx.userId, role: 'landlord', email: 'o@t.dev', profileId: null,
      landlordIds: [ctx.landlordId], permissions: {} }, SECRET, { expiresIn: '1h' })

    const listed = await request(app()).get('/api/bank-feed/deposit-slips').set('Authorization', `Bearer ${ownerTok}`)
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    expect(listed.body.data.waiting).toEqual([])

    const accept = await request(app()).post('/api/bank-feed/deposit-slips').set('Authorization', `Bearer ${ownerTok}`)
      .send({ depositDate: day(1), receiptIds: [loose.id], expectedTotal: 50, bankTransactionId: xferCash })
    expect(accept.status, JSON.stringify(accept.body)).toBe(409)
    expect(accept.body.error).toMatch(/transfer between accounts/)

    const byHand = await request(app()).post(`/api/bank-feed/deposit-slips/${slip.id}/match`).set('Authorization', `Bearer ${ownerTok}`)
      .send({ bankTransactionId: xferSlip })
    expect(byHand.status, JSON.stringify(byHand.body)).toBe(409)
    expect(byHand.body.error).toMatch(/transfer between accounts/)

    // Nothing moved: both bank rows still wait for the owner, the slip is still open, the loose cash on no slip.
    expect((await txnOf(xferSlip)).status).toBe('needs_review')
    expect((await txnOf(xferCash)).status).toBe('needs_review')
    expect((await slipOf(slip.id)).status).toBe('open')
    expect((await listSlips(ctx.landlordId)).filter(s => s.status !== 'void').map(s => s.id)).toEqual([slip.id])
  })

  // decisions.md #48.1, review fix: transfers are left out before the list is cut short.
  it('twenty newer transfer memos never push an older office-cash deposit that fits a slip off the owner\u2019s list', async () => {
    const ctx = await build()
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
    const r = await receipt(ctx, 75, day(6))
    const slip = await createSlip({ landlordId: ctx.landlordId, depositDate: day(5), receiptIds: [r.id], createdBy: ctx.userId })
    const older = await bankRow(ctx, 75, day(4))
    for (let i = 0; i < 20; i++) await bankRow(ctx, 75, day(1), i % 2 ? `ONLINE TRANSFER FROM CHK ${1000 + i}` : `XFER FROM SAVINGS ${i}`)
    process.env.JWT_SECRET = SECRET
    const ownerTok = jwt.sign({ userId: ctx.userId, role: 'landlord', email: 'o@t.dev', profileId: null,
      landlordIds: [ctx.landlordId], permissions: {} }, SECRET, { expiresIn: '1h' })
    const listed = await request(app()).get('/api/bank-feed/deposit-slips').set('Authorization', `Bearer ${ownerTok}`)
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    expect(listed.body.data.waiting.map((w: any) => w.transactionId)).toEqual([older])
    expect(listed.body.data.waiting[0].fittingSlipIds).toEqual([slip.id])
  })

  it('newer deposits that name a payer and fit no slip never push an older office-cash deposit off the list', async () => {
    const ctx = await build()
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
    const r = await receipt(ctx, 75, day(6))
    const slip = await createSlip({ landlordId: ctx.landlordId, depositDate: day(5), receiptIds: [r.id], createdBy: ctx.userId })
    const older = await bankRow(ctx, 75, day(4))
    for (let i = 0; i < 25; i++) await bankRow(ctx, 300 + i, day(1), 'ACME PLUMBING SUPPLY REFUND')
    process.env.JWT_SECRET = SECRET
    const ownerTok = jwt.sign({ userId: ctx.userId, role: 'landlord', email: 'o@t.dev', profileId: null,
      landlordIds: [ctx.landlordId], permissions: {} }, SECRET, { expiresIn: '1h' })
    const listed = await request(app()).get('/api/bank-feed/deposit-slips').set('Authorization', `Bearer ${ownerTok}`)
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    expect(listed.body.data.waiting.map((w: any) => w.transactionId)).toEqual([older])
    expect(listed.body.data.waiting[0].fittingSlipIds).toEqual([slip.id])
  })

  it('a word that only contains TRANSFER (TRANSFERRED) is not read as a transfer memo', async () => {
    const ctx = await build()
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
    const r = await receipt(ctx, 75, day(6))
    await createSlip({ landlordId: ctx.landlordId, depositDate: day(5), receiptIds: [r.id], createdBy: ctx.userId })
    const t = await bankRow(ctx, 75, day(4), 'DEPOSIT TRANSFERRED')
    process.env.JWT_SECRET = SECRET
    const ownerTok = jwt.sign({ userId: ctx.userId, role: 'landlord', email: 'o@t.dev', profileId: null,
      landlordIds: [ctx.landlordId], permissions: {} }, SECRET, { expiresIn: '1h' })
    const listed = await request(app()).get('/api/bank-feed/deposit-slips').set('Authorization', `Bearer ${ownerTok}`)
    expect(listed.body.data.waiting.map((w: any) => w.transactionId)).toEqual([t])
  })
})
