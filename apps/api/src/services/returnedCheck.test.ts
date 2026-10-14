/**
 * 10/14 (Nic, answer 15): "A returned check inside a bigger deposit: void just
 * that check, AUTOMATICALLY reopen their invoice with any late fees that apply
 * and the returned-payment charge the bank issued (usually $25) — this needs to
 * be automatic as a big operation could take days to bounce the check and get
 * the info back to the front desk." Follow-up: the lease's returned-check fee,
 * else what the bank charged on its fee line. And answer 16: "if gam 100
 * percent knows who that money came from it can file it but no guessing" —
 * anything that is not certainly one check waits for a person (told once),
 * who picks the check on the Bank page; every take-back can be undone.
 *
 * The late-fee back-fill end to end, and the books' tie-outs after a
 * take-back and its undo: returnedCheckEndToEnd.test.ts.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db, getClient } from '../db'
import { createSlip } from './depositSlips'
import { reconcileDeposits, normalizeMerchant, ignoreTransaction, listTransactions } from './bankFeed'
import {
  takeBackReturnedChecks, readReturnedItemMemo, checkChoices, takeBackChosenCheck, FEE_LINE_GIVE_UP_DAYS, mentionsAReturn,
} from './returnedCheck'
import { undoDepositMatch } from './bankDepositConfirm'
import { projectBankMatchTenant, projectDepositSlip } from './ledgerProjectors/tenantReceipts'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant } from '../test/dbHelpers'

// The late-fee engine's back-fill runs for real in returnedCheckEndToEnd.test.ts;
// here, that each reopened bill is handed to it.
const lateFeeBackfills: string[] = []
vi.mock('../jobs/lateFees', async (orig) => ({
  ...(await orig<any>()),
  generateLateFeesForInvoice: async (id: string) => {
    lateFeeBackfills.push(id)
    return { invoicesScanned: 0, rowsWritten: 0, capsHit: 0, errors: [] }
  },
}))
// Every email the notices send (never sent for real in a test).
const emails = vi.hoisted(() => [] as Array<{ to: string; subject: string }>)
vi.mock('./email', async (orig) => ({
  ...(await orig<any>()),
  sendNotificationEmail: async (o: { to: string; subject: string }) => { emails.push({ to: o.to, subject: o.subject }); return 'msg_test' },
}))

beforeEach(async () => { await cleanupAllSchema(); lateFeeBackfills.length = 0; emails.length = 0 })

/** A day `n` days before today, YYYY-MM-DD. */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

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

/** A check taken at the desk on `day` for a month's rent, on its own bill. */
async function check(ctx: Ctx, amount: number, day: string, opts: { method?: string; unapplied?: number; first?: string } = {}) {
  const c = await getClient()
  try {
    const tenantId = await seedTenant(c)
    if (opts.first) await c.query(`UPDATE users SET first_name = $2 WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId, opts.first])
    const unitId = await seedUnit(c, { propertyId: ctx.propertyId, landlordId: ctx.landlordId, rentAmount: amount })
    const leaseId = await seedLease(c, { unitId, landlordId: ctx.landlordId, rentAmount: amount })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    const method = opts.method ?? 'check'
    const invoiceId = (await c.query(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$7,'settled') RETURNING id`,
      [ctx.landlordId, tenantId, leaseId, unitId, `INV-${randomUUID().slice(0, 8)}`, day, amount.toFixed(2)])).rows[0].id
    const at = `${day}T18:00:00Z`
    const rentId = (await c.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, invoice_id, type, amount, status, due_date,
                             entry_description, manual_method, settled_at)
       VALUES ($1,$2,$3,$4,$5,'rent',$6,'settled',$7::date,'RENT',$8,$9) RETURNING id`,
      [unitId, leaseId, tenantId, ctx.landlordId, invoiceId, amount.toFixed(2), day, method, at])).rows[0].id
    const total = amount + (opts.unapplied ?? 0)
    const id = (await c.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                       payment_method, settled_at, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,'settled',$7,$8,$9) RETURNING id`,
      [tenantId, leaseId, ctx.landlordId, total.toFixed(2), amount.toFixed(2), (opts.unapplied ?? 0).toFixed(2), method, at,
       ctx.userId])).rows[0].id
    await c.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,$3)`,
      [id, rentId, amount.toFixed(2)])
    const tenantUser = (await c.query(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    return { id, tenantId, tenantUser, leaseId, unitId, rentId, invoiceId, at }
  } finally { c.release() }
}

async function bankRow(ctx: Ctx, amount: number, postedDate: string, description: string, connectionId = ctx.connectionId) {
  return (await db.query(
    `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description,
                                    normalized_merchant, status, bank_status)
     VALUES ($1,$2,$3,$4::date,$5,$6,$7,'needs_review','posted') RETURNING id`,
    [connectionId, ctx.landlordId, randomUUID(), postedDate, amount.toFixed(2), description,
     normalizeMerchant(description)])).rows[0].id as string
}

/** The office banks these checks on one slip, and the bank shows the deposit. */
async function bank(ctx: Ctx, receiptIds: string[], total: number, day: string, o: { other?: number; connectionId?: string } = {}) {
  await createSlip({
    landlordId: ctx.landlordId, depositDate: day, receiptIds, createdBy: ctx.userId,
    ...(o.other ? { otherAmount: o.other, otherNote: 'vendor refund check', otherIsNotRent: true } : {}),
  })
  const deposit = await bankRow(ctx, total, day, 'BRANCH DEPOSIT', o.connectionId)
  await reconcileDeposits(ctx.landlordId)
  expect((await db.query(`SELECT status FROM bank_transactions WHERE id = $1`, [deposit])).rows[0].status).toBe('matched')
  return deposit
}

const lineOf = async (id: string) => (await db.query(
  `SELECT status, auto_settle_undo, ignored_reason FROM bank_transactions WHERE id = $1`, [id])).rows[0]
const notices = async (userId: string) => (await db.query(
  `SELECT title, body, data->>'notice' AS notice FROM notifications WHERE user_id = $1 AND type = 'bank_returned_check' ORDER BY created_at`, [userId])).rows
const emailOf = async (userId: string) => (await db.query(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0].email as string
const statusOf = async (table: 'payments' | 'tenant_remittances', id: string) =>
  (await db.query(`SELECT status FROM ${table} WHERE id = $1`, [id])).rows[0].status as string

describe('reading the bank’s words', () => {
  it('a deposited check returned, and the bank’s fee for one', () => {
    for (const m of ['RETURNED DEPOSIT ITEM', 'DEPOSITED ITEM RETURNED', 'RETURN ITEM CHK 1042', 'RETURNED CHECK',
      'RET DEP ITEM 10/03', 'CHARGEBACK DEPOSITED ITEM', 'Deposit Item Returned', 'RETURN DEPOSITED ITEM NSF']) {
      expect(readReturnedItemMemo(m), m).toBe('item')
    }
    for (const m of ['DEPOSITED ITEM RETURNED FEE', 'RETURN DEP ITEM CHG', 'RETURNED CHECK FEE', 'CHARGEBACK DEPOSITED ITEM FEE']) {
      expect(readReturnedItemMemo(m), m).toBe('fee')
    }
  })

  it('never an ACH, a card or processor chargeback, or a return that names no deposit or check', () => {
    for (const m of ['SQUARE INC CHARGEBACK', 'SQ *CHARGEBACK 460.00', 'STRIPE CHARGEBACK', 'CHARGEBACK', 'ACH RETURN ITEM',
      'RETURN ITEM ACH PPD', 'RETURNED ITEM ACH DEBIT', 'RETURN ITEM', 'RETURNED ITEM FEE', 'CHARGEBACK FEE',
      'DEPOSIT RETURN JOHN SMITH', 'OVERDRAFT ITEM RETURNED', 'HOME DEPOT 1234', 'BRANCH DEPOSIT', null]) {
      expect(readReturnedItemMemo(m), String(m)).toBeNull()
    }
  })

  it('a line that speaks of a return opens the checks to pick from on the Bank page; a fee or electronic money never does', () => {
    for (const m of ['RETURN ITEM', 'ITEM RETURNED NSF', 'RETURNED DEPOSIT ITEM', 'CHARGEBACK']) expect(mentionsAReturn(m), m).toBe(true)
    for (const m of ['RETURNED ITEM FEE', 'DEPOSITED ITEM RETURNED FEE', 'RETURN ITEM ACH PPD', 'SQUARE INC CHARGEBACK', 'HOME DEPOT 1234', null]) {
      expect(mentionsAReturn(m), String(m)).toBe(false)
    }
  })
})

describe('one check returned out of a bigger deposit', () => {
  it('takes back just that check, by itself: its bill is owed again, the late fees back-filled, the bank’s fee billed, the rest of the deposit untouched', async () => {
    const ctx = await build()
    const rosa = await check(ctx, 460, daysAgo(9), { first: 'Rosa' })
    const sam = await check(ctx, 300, daysAgo(9), { first: 'Sam' })
    await bank(ctx, [rosa.id, sam.id], 760, daysAgo(8))
    const returned = await bankRow(ctx, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    const fee = await bankRow(ctx, -25, daysAgo(2), 'DEPOSITED ITEM RETURNED FEE')

    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 1, waiting: 0, feesBilled: 0 })

    // Rosa's check, and only it, is taken back (kept on record).
    expect((await db.query(`SELECT status, undone_at IS NOT NULL AS undone FROM tenant_remittances WHERE id = $1`, [rosa.id])).rows[0])
      .toEqual({ status: 'failed', undone: true })
    expect((await db.query(`SELECT status, manual_method FROM payments WHERE id = $1`, [rosa.rentId])).rows[0])
      .toEqual({ status: 'pending', manual_method: null })
    expect(await statusOf('tenant_remittances', sam.id)).toBe('settled')
    expect(await statusOf('payments', sam.rentId)).toBe('settled')
    // Late fees from the bill's own due date (the engine's back-fill).
    expect(lateFeeBackfills).toEqual([rosa.invoiceId])
    // The bank's fee, billed to Rosa as the landlord's own one-off charge, due
    // today on no bill (never a monthly SUBSCRIP line, never on the late bill);
    // the fee line stays the landlord's bank expense.
    const billed = (await db.query(
      `SELECT type, amount::float AS amount, status, revenue_owner, tenant_id, invoice_id, entry_description, lease_id FROM payments
        WHERE tenant_id = $1 AND type = 'fee'`, [rosa.tenantId])).rows
    expect(billed).toEqual([{ type: 'fee', amount: 25, status: 'pending', revenue_owner: 'landlord', tenant_id: rosa.tenantId,
      invoice_id: null, entry_description: 'OTHERFEE', lease_id: rosa.leaseId }])
    expect((await lineOf(fee)).status).toBe('needs_review')
    // The returned line is matched to that check — never waiting to be filed as an expense.
    const line = await lineOf(returned)
    expect(line.status).toBe('matched')
    expect(line.auto_settle_undo).toMatchObject({
      kind: 'returned_check', returnedReceiptId: rosa.id, feeLineId: fee, feeAmount: 25, feeFrom: 'bank', pickedBy: null,
      rows: [{ paymentId: rosa.rentId, manualMethod: 'check', platformHeld: false }],
    })
    const listed = (await listTransactions(ctx.landlordId, { lineId: returned }))[0]
    expect(listed).toMatchObject({ match_kind: 'returned_check', returned_check_fee: 25, returned_check_tenant_name: 'Rosa Tenant', can_undo: true })
    await expect(ignoreTransaction(ctx.landlordId, returned)).rejects.toThrow(/Undo that first/)

    // Told once each, by email too: the owner (who also took the check) and Rosa.
    expect((await notices(ctx.userId)).map(n => n.title)).toEqual(['A check bounced — GAM took it back'])
    expect((await notices(ctx.userId))[0].body).toContain('A returned-check fee of $25.00 (what the bank charged) was billed to them.')
    expect((await notices(rosa.tenantUser)).map(n => n.title)).toEqual(['Your check was returned by the bank'])
    expect((await notices(rosa.tenantUser))[0].body).toContain('a returned-check fee of $25.00 is added')
    expect(emails.map(e => [e.to, e.subject]).sort()).toEqual([
      [await emailOf(ctx.userId), 'A check bounced — GAM took it back'],
      [await emailOf(rosa.tenantUser), 'Your check was returned by the bank'],
    ].sort())

    // Run again: nothing more happens, nobody is told twice.
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 0, waiting: 0, feesBilled: 0 })
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM payments WHERE tenant_id = $1 AND type = 'fee'`, [rosa.tenantId])).rows[0].n).toBe(1)
    expect(await notices(ctx.userId)).toHaveLength(1)
    expect(emails).toHaveLength(2)
  })

  it('the books: the bank’s line puts the check back in the drawer, once', async () => {
    const ctx = await build()
    const rosa = await check(ctx, 460, daysAgo(9))
    const sam = await check(ctx, 300, daysAgo(9))
    await bank(ctx, [rosa.id, sam.id], 760, daysAgo(8))
    const returned = await bankRow(ctx, -460, daysAgo(2), 'DEPOSITED ITEM RETURNED')
    await takeBackReturnedChecks(ctx.landlordId)
    const c = await getClient()
    try {
      const postings = await projectBankMatchTenant(c, returned)
      expect(postings).toHaveLength(1)
      const lines = postings[0].lines.map(l => [l.role, l.debitCents ?? 0, l.creditCents ?? 0, l.propertyId])
      expect(lines).toEqual([
        ['undeposited_funds', 46000, 0, ctx.propertyId],
        ['bank_checking', 0, 46000, ctx.propertyId],
      ])
      // The slip still moved the whole bag from the drawer into the bank, by the
      // same property — so the drawer nets to zero for the check that came back.
      const slipId = (await db.query(`SELECT id FROM bank_deposit_slips WHERE landlord_id = $1`, [ctx.landlordId])).rows[0].id
      const slip = (await projectDepositSlip(c, slipId))[0].lines
      expect(slip.filter(l => l.role === 'undeposited_funds').map(l => [l.creditCents ?? 0, l.propertyId]))
        .toEqual([[76000, ctx.propertyId]])
    } finally { c.release() }
  })

  it('the bank’s fee line that shows a day later is billed then, once, and the tenant hears it', async () => {
    const ctx = await build()
    const rosa = await check(ctx, 460, daysAgo(9))
    const sam = await check(ctx, 300, daysAgo(9))
    await bank(ctx, [rosa.id, sam.id], 760, daysAgo(8))
    const returned = await bankRow(ctx, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toMatchObject({ takenBack: 1 })
    expect((await db.query(`SELECT 1 FROM payments WHERE tenant_id = $1 AND type = 'fee'`, [rosa.tenantId])).rowCount).toBe(0)
    expect((await notices(ctx.userId))[0].body).toContain('The returned-check fee is billed to them when your bank’s fee for it shows')
    // The tenant is never told a fee was added that was not.
    expect((await notices(rosa.tenantUser))[0].body).toContain('If your landlord’s bank charges a fee for the returned check, that fee is added too')

    const fee = await bankRow(ctx, -30, daysAgo(1), 'RETURN DEP ITEM CHG')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 0, waiting: 0, feesBilled: 1 })
    expect((await db.query(`SELECT amount::float AS amount FROM payments WHERE tenant_id = $1 AND type = 'fee'`, [rosa.tenantId])).rows)
      .toEqual([{ amount: 30 }])
    expect((await lineOf(returned)).auto_settle_undo).toMatchObject({ feeLineId: fee, feeAmount: 30, feeFrom: 'bank' })
    expect((await notices(rosa.tenantUser)).map(n => n.notice)).toEqual(['taken_back', 'fee_billed'])
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 0, waiting: 0, feesBilled: 0 })
    expect(await notices(ctx.userId)).toHaveLength(1)
  })

  it('a bank fee line that never shows: nothing is billed, and the owner is told once', async () => {
    const ctx = await build()
    const rosa = await check(ctx, 460, daysAgo(22))
    const sam = await check(ctx, 300, daysAgo(22))
    await bank(ctx, [rosa.id, sam.id], 760, daysAgo(21))
    // Synced late: the returned line posted more than the window plus the grace ago.
    const returned = await bankRow(ctx, -460, daysAgo(3 + FEE_LINE_GIVE_UP_DAYS + 2), 'RETURNED DEPOSIT ITEM')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 1, waiting: 0, feesBilled: 0 })
    expect((await lineOf(returned)).auto_settle_undo).toMatchObject({ feeFrom: 'none', feePaymentId: null })
    expect((await db.query(`SELECT 1 FROM payments WHERE tenant_id = $1 AND type = 'fee'`, [rosa.tenantId])).rowCount).toBe(0)
    expect((await notices(ctx.userId)).map(n => n.notice)).toEqual(['taken_back', 'fee_none'])
    await takeBackReturnedChecks(ctx.landlordId)
    expect(await notices(ctx.userId)).toHaveLength(2)
  })
})

describe('the returned-check fee: the lease’s, else the bank’s', () => {
  /** The tenant's signed lease, with its "Returned payment fee" field filled in. */
  async function leaseNames(ctx: Ctx, leaseId: string, value: string) {
    const doc = (await db.query(
      `INSERT INTO lease_documents (landlord_id, lease_id, title, status, completed_at)
       VALUES ($1,$2,'Lease','completed',now()) RETURNING id`, [ctx.landlordId, leaseId])).rows[0].id
    await db.query(
      `INSERT INTO lease_document_fields (document_id, field_type, signer_role, label, value)
       VALUES ($1,'text','landlord','Returned payment fee',$2)`, [doc, value])
  }

  it('the fee the signed lease names is billed, not the bank’s', async () => {
    const ctx = await build()
    const rosa = await check(ctx, 460, daysAgo(9))
    const sam = await check(ctx, 300, daysAgo(9))
    await leaseNames(ctx, rosa.leaseId, '$35.00')
    await bank(ctx, [rosa.id, sam.id], 760, daysAgo(8))
    const returned = await bankRow(ctx, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    const fee = await bankRow(ctx, -25, daysAgo(2), 'DEPOSITED ITEM RETURNED FEE')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toMatchObject({ takenBack: 1 })
    expect((await db.query(`SELECT amount::float AS amount FROM payments WHERE tenant_id = $1 AND type = 'fee'`, [rosa.tenantId])).rows)
      .toEqual([{ amount: 35 }])
    expect((await lineOf(returned)).auto_settle_undo).toMatchObject({ feeFrom: 'lease', feeAmount: 35, feeLineId: fee })
    expect((await notices(ctx.userId))[0].body).toContain('A returned-check fee of $35.00 (what their lease names) was billed to them.')
    // The bank's fee line is still the landlord's bank expense, and nothing more is billed later.
    expect((await lineOf(fee)).status).toBe('needs_review')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 0, waiting: 0, feesBilled: 0 })
  })

  it('a lease fee GAM cannot read as an amount: nothing is billed, the owner is told to add it', async () => {
    const ctx = await build()
    const rosa = await check(ctx, 460, daysAgo(9))
    const sam = await check(ctx, 300, daysAgo(9))
    await leaseNames(ctx, rosa.leaseId, '$25 or 5% of the check')
    await bank(ctx, [rosa.id, sam.id], 760, daysAgo(8))
    await bankRow(ctx, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    await bankRow(ctx, -25, daysAgo(1), 'DEPOSITED ITEM RETURNED FEE')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toMatchObject({ takenBack: 1, feesBilled: 0 })
    expect((await db.query(`SELECT 1 FROM payments WHERE tenant_id = $1 AND type = 'fee'`, [rosa.tenantId])).rowCount).toBe(0)
    expect((await notices(ctx.userId))[0].body)
      .toContain('Their lease names a returned-payment fee GAM could not read as an amount ("$25 or 5% of the check"), so no fee was billed — add it by hand.')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 0, waiting: 0, feesBilled: 0 })
  })
})

describe('anything that is not certainly one check waits for a person', () => {
  it('two checks of that amount in matched deposits: nothing is taken back, the owner is told once, by email', async () => {
    const ctx = await build()
    const a = await check(ctx, 460, daysAgo(9))
    const b = await check(ctx, 460, daysAgo(9))
    await bank(ctx, [a.id, b.id], 920, daysAgo(8))
    const returned = await bankRow(ctx, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 0, waiting: 1, feesBilled: 0 })
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 0, waiting: 1, feesBilled: 0 })
    expect((await lineOf(returned)).status).toBe('needs_review')
    expect([await statusOf('tenant_remittances', a.id), await statusOf('tenant_remittances', b.id)]).toEqual(['settled', 'settled'])
    const told = await notices(ctx.userId)
    expect(told).toHaveLength(1)
    expect(told[0].title).toBe('Your bank returned a check — it needs you')
    expect(told[0].body).toContain('2 payments of $460.00 were in deposits matched')
    expect(told[0].body).toContain('pick the check that bounced')
    expect(emails.map(e => e.subject)).toEqual(['Your bank returned a check — it needs you'])
  })

  it('a slip’s other money big enough to be that check: GAM cannot be sure, so nothing is taken back', async () => {
    const ctx = await build()
    const rosa = await check(ctx, 460, daysAgo(9))
    await bank(ctx, [rosa.id], 920, daysAgo(8), { other: 460 })
    await bankRow(ctx, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 0, waiting: 1, feesBilled: 0 })
    expect(await statusOf('payments', rosa.rentId)).toBe('settled')
    expect((await notices(ctx.userId))[0].body).toContain('Money GAM cannot see inside could hold a check of $460.00 too')
  })

  it('a deposit GAM cannot see inside blocks it; an electronic credit (a Square payout) does not', async () => {
    const ctx = await build()
    const rosa = await check(ctx, 460, daysAgo(9))
    const sam = await check(ctx, 300, daysAgo(9))
    await bank(ctx, [rosa.id, sam.id], 760, daysAgo(8))
    await bankRow(ctx, 912.4, daysAgo(6), 'Square Inc       SQ261001   261001 T3H80F2ZQ67M')
    const branch = await bankRow(ctx, 900, daysAgo(5), 'MOBILE DEPOSIT')
    const returned = await bankRow(ctx, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 0, waiting: 1, feesBilled: 0 })
    expect(await statusOf('payments', rosa.rentId)).toBe('settled')
    // The owner files the mobile deposit as other income: still not a deposit GAM can see inside.
    await db.query(`UPDATE bank_transactions SET status = 'ignored', ignored_reason = 'landlord' WHERE id = $1`, [branch])
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 0, waiting: 1, feesBilled: 0 })
    // A copy of a line the bank already sent is not money at all: with it gone, only the Square payout is left.
    await db.query(`UPDATE bank_transactions SET ignored_reason = 'duplicate', duplicate_of_id = $2 WHERE id = $1`, [branch, returned])
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 1, waiting: 0, feesBilled: 0 })
    expect(await statusOf('payments', rosa.rentId)).toBe('pending')
  })

  it('a check banked to another of the company’s accounts is never the one this account returned', async () => {
    const ctx = await build()
    const other = (await db.query(
      `INSERT INTO bank_connections (landlord_id, provider, status) VALUES ($1,'stripe_fc','active') RETURNING id`,
      [ctx.landlordId])).rows[0].id
    const rosa = await check(ctx, 460, daysAgo(9))
    await bank(ctx, [rosa.id], 460, daysAgo(8), { connectionId: other })
    await bankRow(ctx, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 0, waiting: 1, feesBilled: 0 })
    expect(await statusOf('payments', rosa.rentId)).toBe('settled')
  })

  it('no check of that amount, a cash payment of that amount, or a check outside the window: nothing is taken back', async () => {
    const ctx = await build()
    const cash = await check(ctx, 460, daysAgo(9), { method: 'cash' })
    const old = await check(ctx, 300, daysAgo(60))
    await bank(ctx, [cash.id], 460, daysAgo(8))
    await bank(ctx, [old.id], 300, daysAgo(59))
    await bankRow(ctx, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    await bankRow(ctx, -300, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 0, waiting: 2, feesBilled: 0 })
    expect([await statusOf('payments', cash.rentId), await statusOf('payments', old.rentId)]).toEqual(['settled', 'settled'])
  })

  it('a check and a money order of that amount: GAM cannot tell which came back; a money order alone is not taken back either', async () => {
    const ctx = await build()
    const chk = await check(ctx, 460, daysAgo(9))
    const mo = await check(ctx, 460, daysAgo(9), { method: 'money_order' })
    const other = await check(ctx, 300, daysAgo(9), { method: 'money_order' })
    await bank(ctx, [chk.id, mo.id, other.id], 1220, daysAgo(8))
    await bankRow(ctx, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    await bankRow(ctx, -300, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 0, waiting: 2, feesBilled: 0 })
    for (const r of [chk, mo, other]) expect(await statusOf('tenant_remittances', r.id)).toBe('settled')
    const bodies = (await notices(ctx.userId)).map(n => n.body).join(' ')
    expect(bodies).toContain('2 payments of $460.00')
    expect(bodies).toContain('is a money order, which GAM does not take back by itself')
  })

  it('a check part of which was kept as credit is not taken back by itself', async () => {
    const ctx = await build()
    const rosa = await check(ctx, 460, daysAgo(9), { unapplied: 40 })
    const sam = await check(ctx, 300, daysAgo(9))
    await bank(ctx, [rosa.id, sam.id], 800, daysAgo(8))
    const returned = await bankRow(ctx, -500, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 0, waiting: 1, feesBilled: 0 })
    expect((await lineOf(returned)).status).toBe('needs_review')
    expect(await statusOf('payments', rosa.rentId)).toBe('settled')
    expect((await notices(ctx.userId))[0].body).toContain('kept as credit or paid ahead')
  })

  it('a card chargeback or an ACH return is never read as a check, and nobody is told about it', async () => {
    const ctx = await build()
    const rosa = await check(ctx, 460, daysAgo(9))
    await bank(ctx, [rosa.id], 460, daysAgo(8))
    await bankRow(ctx, -460, daysAgo(2), 'SQUARE INC CHARGEBACK')
    await bankRow(ctx, -460, daysAgo(2), 'RETURN ITEM ACH PPD')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 0, waiting: 0, feesBilled: 0 })
    expect(await statusOf('payments', rosa.rentId)).toBe('settled')
    expect(await notices(ctx.userId)).toEqual([])
  })

  it('told it waits, then GAM becomes sure (the slip is matched): taken back, and the owner is told that too', async () => {
    const ctx = await build()
    const rosa = await check(ctx, 460, daysAgo(9))
    const sam = await check(ctx, 300, daysAgo(9))
    // The bank's deposit is in, but the desk has not made the slip yet.
    const deposit = await bankRow(ctx, 760, daysAgo(8), 'BRANCH DEPOSIT')
    const returned = await bankRow(ctx, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 0, waiting: 1, feesBilled: 0 })
    await createSlip({ landlordId: ctx.landlordId, depositDate: daysAgo(8), receiptIds: [rosa.id, sam.id], createdBy: ctx.userId })
    await reconcileDeposits(ctx.landlordId)
    expect((await lineOf(deposit)).status).toBe('matched')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 1, waiting: 0, feesBilled: 0 })
    expect((await lineOf(returned)).status).toBe('matched')
    expect((await notices(ctx.userId)).map(n => n.title)).toEqual([
      'Your bank returned a check — it needs you', 'A check bounced — GAM took it back',
    ])
  })
})

describe('the person picks the check that bounced', () => {
  it('two checks of that amount: the owner sees both and picks one; just that one is taken back, as for GAM', async () => {
    const ctx = await build()
    const a = await check(ctx, 460, daysAgo(9), { first: 'Ana' })
    const b = await check(ctx, 460, daysAgo(9), { first: 'Bo' })
    await bank(ctx, [a.id, b.id], 920, daysAgo(8))
    const returned = await bankRow(ctx, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    await bankRow(ctx, -25, daysAgo(2), 'DEPOSITED ITEM RETURNED FEE')
    expect(await takeBackReturnedChecks(ctx.landlordId)).toMatchObject({ waiting: 1 })

    const choices = await checkChoices(ctx.landlordId, returned)
    expect(choices.map(c => [c.tenantName, c.method, c.amount, c.tenantDeposit]).sort()).toEqual([
      ['Ana Tenant', 'check', 460, false], ['Bo Tenant', 'check', 460, false],
    ])
    await expect(takeBackChosenCheck({ landlordId: ctx.landlordId, lineId: returned, remittanceId: randomUUID(), by: ctx.userId }))
      .rejects.toThrow(/not a check of \$460.00/)
    const r = await takeBackChosenCheck({ landlordId: ctx.landlordId, lineId: returned, remittanceId: b.id, by: ctx.userId })
    expect(r).toMatchObject({ remittanceId: b.id, reopenedPaymentIds: [b.rentId], fee: { kind: 'bank', cents: 2500 } })
    expect(await statusOf('payments', b.rentId)).toBe('pending')
    expect(await statusOf('payments', a.rentId)).toBe('settled')
    expect((await lineOf(returned)).auto_settle_undo).toMatchObject({ kind: 'returned_check', pickedBy: ctx.userId })
    expect((await notices(ctx.userId)).map(n => n.title)).toEqual([
      'Your bank returned a check — it needs you', 'A check bounced — GAM took it back',
    ])
    expect((await notices(ctx.userId))[1].body).toContain('took just that check back, as you picked')
    // Nothing left to pick on a line that is matched.
    expect(await checkChoices(ctx.landlordId, returned)).toEqual([])
  })

  it('a pick whose take-back is not clean is refused in words, and nothing changes', async () => {
    const ctx = await build()
    const rosa = await check(ctx, 460, daysAgo(9), { unapplied: 40 })
    await bank(ctx, [rosa.id], 500, daysAgo(8))
    const returned = await bankRow(ctx, -500, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    await expect(takeBackChosenCheck({ landlordId: ctx.landlordId, lineId: returned, remittanceId: rosa.id, by: ctx.userId }))
      .rejects.toThrow(/kept as credit or paid ahead.*Nothing was taken back/)
    expect(await statusOf('payments', rosa.rentId)).toBe('settled')
    expect((await lineOf(returned)).status).toBe('needs_review')
  })
})

describe('Undo (Nic 10/12: "every bank filing (hand-filed too) can be undone (kept on record)")', () => {
  it('puts the check back exactly: its bill paid again on its old day, the fee and the bounce’s late fees voided, the line back in review for good', async () => {
    const ctx = await build()
    const rosa = await check(ctx, 460, daysAgo(9))
    const sam = await check(ctx, 300, daysAgo(9))
    await bank(ctx, [rosa.id, sam.id], 760, daysAgo(8))
    const returned = await bankRow(ctx, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    await bankRow(ctx, -25, daysAgo(2), 'DEPOSITED ITEM RETURNED FEE')
    await takeBackReturnedChecks(ctx.landlordId)
    const feeId = (await lineOf(returned)).auto_settle_undo.feePaymentId as string
    // A late fee the back-fill wrote on the reopened bill.
    const late = (await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, invoice_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'late_fee',15,'pending',CURRENT_DATE,'LATEFEE') RETURNING id`,
      [rosa.unitId, rosa.leaseId, rosa.tenantId, ctx.landlordId, rosa.invoiceId])).rows[0].id

    const r = await undoDepositMatch({ bankTransactionId: returned, landlordId: ctx.landlordId, undoneBy: ctx.userId })
    expect(r).toMatchObject({ kind: 'returned_check', checkPutBack: { paidAgainIds: [rosa.rentId], feeVoided: feeId, lateFeesVoided: [late] } })
    expect((await db.query(`SELECT status, manual_method, settled_at = $2::timestamptz AS same_day FROM payments WHERE id = $1`,
      [rosa.rentId, rosa.at])).rows[0]).toEqual({ status: 'settled', manual_method: 'check', same_day: true })
    expect((await db.query(`SELECT status, undone_at FROM tenant_remittances WHERE id = $1`, [rosa.id])).rows[0])
      .toEqual({ status: 'settled', undone_at: null })
    expect(await statusOf('payments', feeId)).toBe('voided')
    expect(await statusOf('payments', late)).toBe('voided')
    const line = await lineOf(returned)
    expect(line.status).toBe('needs_review')
    expect(line.auto_settle_undo).toMatchObject({ undone: true, was: { kind: 'returned_check' } })
    expect((await notices(rosa.tenantUser)).map(n => n.title)).toContain('Your returned check was put back')
    // A person took it back off: GAM never takes this line back by itself again (the person still may).
    expect(await takeBackReturnedChecks(ctx.landlordId)).toEqual({ takenBack: 0, waiting: 0, feesBilled: 0 })
    expect(await statusOf('payments', rosa.rentId)).toBe('settled')
    expect((await checkChoices(ctx.landlordId, returned)).map(c => c.remittanceId)).toEqual([rosa.id])
  })

  it('is refused when the tenant paid what the check paid again since, and the slip cannot be undone under it', async () => {
    const ctx = await build()
    const rosa = await check(ctx, 460, daysAgo(9))
    const sam = await check(ctx, 300, daysAgo(9))
    const deposit = await bank(ctx, [rosa.id, sam.id], 760, daysAgo(8))
    const returned = await bankRow(ctx, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    await takeBackReturnedChecks(ctx.landlordId)
    await expect(undoDepositMatch({ bankTransactionId: deposit, landlordId: ctx.landlordId, undoneBy: ctx.userId }))
      .rejects.toThrow(/returned by the bank and taken back. Undo that first/)
    await db.query(`UPDATE payments SET status = 'settled', settled_at = now(), manual_method = 'cash' WHERE id = $1`, [rosa.rentId])
    await expect(undoDepositMatch({ bankTransactionId: returned, landlordId: ctx.landlordId, undoneBy: ctx.userId }))
      .rejects.toThrow(/paid again.*Nothing was undone/)
    expect((await lineOf(returned)).status).toBe('matched')
    expect(await statusOf('tenant_remittances', rosa.id)).toBe('failed')
  })

  it('the bank voiding its own returned line puts the check back the same way, set aside, and the owner hears it', async () => {
    const ctx = await build()
    const rosa = await check(ctx, 460, daysAgo(9))
    const sam = await check(ctx, 300, daysAgo(9))
    await bank(ctx, [rosa.id, sam.id], 760, daysAgo(8))
    const returned = await bankRow(ctx, -460, daysAgo(2), 'RETURNED DEPOSIT ITEM')
    await takeBackReturnedChecks(ctx.landlordId)
    const r = await undoDepositMatch({ bankTransactionId: returned, landlordId: ctx.landlordId, undoneBy: null, bankVoided: true })
    expect(r.kind).toBe('returned_check')
    expect(await lineOf(returned)).toMatchObject({ status: 'ignored', ignored_reason: 'bank_void' })
    expect(await statusOf('payments', rosa.rentId)).toBe('settled')
    expect((await notices(ctx.userId)).map(n => n.title)).toContain('Your bank took back a returned check')
  })
})
