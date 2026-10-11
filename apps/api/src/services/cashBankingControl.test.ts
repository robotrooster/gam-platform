/**
 * S624 — the on-site cash control.
 *
 * Nic: "a landlord would mark each one paid as they collect the rent in person
 * in the office, and then the bulk deposit would be sorted and verified against
 * those ones that were marked paid in person. It needs a double verification."
 *
 * The thing being tested is a FRAUD CONTROL, not a reconciliation convenience:
 * money marked collected that never reached the bank, with names attached.
 *
 * S655 (Step 12): what is counted is what went into the bag — the desk RECEIPT
 * (what was handed over) and register cash — split into "on a deposit slip,
 * waiting for the bank" and "not on any slip". A receipt a bank match wrote,
 * and a prior arrangement (paid before GAM), is never cash to bank.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { cashBankingPosition } from './cashBankingControl'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease,
  seedLeaseTenant,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

interface Ctx { landlordId: string; propertyId: string; connectionId: string; userId: string }

async function build(): Promise<Ctx> {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    const conn = (await client.query(
      `INSERT INTO bank_connections (landlord_id, provider, status)
       VALUES ($1,'stripe_fc','active') RETURNING id`, [landlordId])).rows[0]
    return { landlordId, propertyId, connectionId: conn.id, userId }
  } finally { client.release() }
}

/**
 * A payment taken in person `daysAgo` back: the rent row settled by hand and
 * the desk receipt for what was handed over (applied to the rent; any extra
 * kept as paid-ahead money).
 */
async function collectInPerson(
  ctx: Ctx,
  opts: { amount: number; daysAgo: number; unit: string; handedOver?: number; method?: string },
): Promise<{ receiptId: string; rentId: string; tenantId: string; leaseId: string }> {
  const client = await getClient()
  try {
    const tenantId = await seedTenant(client)
    const unitId = await seedUnit(client, {
      propertyId: ctx.propertyId, landlordId: ctx.landlordId, rentAmount: opts.amount })
    await client.query(`UPDATE units SET unit_number=$2 WHERE id=$1`, [unitId, opts.unit])
    const leaseId = await seedLease(client, {
      unitId, landlordId: ctx.landlordId, rentAmount: opts.amount })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    const method = opts.method ?? 'cash'
    const rentId = (await client.query(
      `INSERT INTO payments
         (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
          due_date, entry_description, manual_method, settled_at)
       VALUES ($1,$2,$3,$4,'rent',$5,'settled',CURRENT_DATE,'RENT',$7,
               NOW() - ($6::int || ' days')::interval)
       RETURNING id`,
      [unitId, leaseId, tenantId, ctx.landlordId, opts.amount.toFixed(2), opts.daysAgo, method])).rows[0].id
    const handed = opts.handedOver ?? opts.amount
    const receiptId = (await client.query(
      `INSERT INTO tenant_remittances
         (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
          payment_method, gross_amount, settled_at, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,'settled',$7,NULL, NOW() - ($8::int || ' days')::interval, $9)
       RETURNING id`,
      [tenantId, leaseId, ctx.landlordId, handed.toFixed(2), opts.amount.toFixed(2),
       (handed - opts.amount).toFixed(2), method, opts.daysAgo, ctx.userId])).rows[0].id
    await client.query(
      `INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,$3)`,
      [receiptId, rentId, opts.amount.toFixed(2)])
    return { receiptId, rentId, tenantId, leaseId }
  } finally { client.release() }
}

/** The bag went to the bank: a slip with these receipts, matched to a bank row. */
async function bank(ctx: Ctx, receipts: Array<{ receiptId: string; amount: number }>) {
  const total = receipts.reduce((s, r) => s + r.amount, 0)
  const txn = (await db.query(
    `INSERT INTO bank_transactions
       (bank_connection_id, landlord_id, external_id, posted_date, amount, status)
     VALUES ($1,$2,$3,CURRENT_DATE,$4,'matched') RETURNING id`,
    [ctx.connectionId, ctx.landlordId, randomUUID(), total.toFixed(2)])).rows[0]
  const slip = (await db.query(
    `INSERT INTO bank_deposit_slips (landlord_id, deposit_date, total, status, created_by, bank_transaction_id, matched_at)
     VALUES ($1, CURRENT_DATE, $2, 'matched', $3, $4, now()) RETURNING id`,
    [ctx.landlordId, total.toFixed(2), ctx.userId, txn.id])).rows[0]
  for (const r of receipts) {
    await db.query(
      `INSERT INTO bank_deposit_slip_items (slip_id, remittance_id, amount) VALUES ($1,$2,$3)`,
      [slip.id, r.receiptId, r.amount.toFixed(2)])
  }
}

/** Ticked onto an open slip: in the bag, the bank has not shown it yet. */
async function onOpenSlip(ctx: Ctx, receipt: { receiptId: string; amount: number }) {
  const slip = (await db.query(
    `INSERT INTO bank_deposit_slips (landlord_id, deposit_date, total, status, created_by)
     VALUES ($1, CURRENT_DATE, $2, 'open', $3) RETURNING id`,
    [ctx.landlordId, receipt.amount.toFixed(2), ctx.userId])).rows[0]
  await db.query(
    `INSERT INTO bank_deposit_slip_items (slip_id, remittance_id, amount) VALUES ($1,$2,$3)`,
    [slip.id, receipt.receiptId, receipt.amount.toFixed(2)])
  return slip.id as string
}

describe('cash collected but never banked', () => {
  it('finds the gap, with names on it', async () => {
    const ctx = await build()
    const banked = await collectInPerson(ctx, { amount: 2750, daysAgo: 10, unit: 'Lot 1' })
    await collectInPerson(ctx, { amount: 250, daysAgo: 10, unit: 'Lot 2' })
    await bank(ctx, [{ receiptId: banked.receiptId, amount: 2750 }])

    const pos = await cashBankingPosition(ctx.landlordId)
    expect(pos.unbankedTotal).toBe(250)          // collected $3,000, banked $2,750
    expect(pos.unbanked).toHaveLength(1)
    expect(pos.unbanked[0].unitNumber).toBe('Lot 2')
    expect(pos.unbanked[0].payerName).toBe('Test Tenant')
    expect(pos.unbanked[0].daysOutstanding).toBe(10)
    expect(pos.oldestDays).toBe(10)
    expect(pos.notOnSlip.total).toBe(250)
  })

  // An office collecting on the 1st and banking on the 3rd is NORMAL. Flagging
  // that would train people to ignore the report, which is worse than not having
  // one.
  it('leaves recent collections alone', async () => {
    const ctx = await build()
    await collectInPerson(ctx, { amount: 500, daysAgo: 1, unit: 'Lot 1' })
    const pos = await cashBankingPosition(ctx.landlordId)
    expect(pos.unbanked).toHaveLength(0)
    expect(pos.unbankedTotal).toBe(0)
    expect(pos.oldestDays).toBe(0)
  })

  it('honors a landlord’s own grace period', async () => {
    const ctx = await build()
    await collectInPerson(ctx, { amount: 500, daysAgo: 5, unit: 'Lot 1' })
    expect((await cashBankingPosition(ctx.landlordId, { graceDays: 7 })).unbanked)
      .toHaveLength(0)
    expect((await cashBankingPosition(ctx.landlordId, { graceDays: 3 })).unbanked)
      .toHaveLength(1)
  })

  it('reports nothing when everything was banked', async () => {
    const ctx = await build()
    const a = await collectInPerson(ctx, { amount: 500, daysAgo: 10, unit: 'Lot 1' })
    const b = await collectInPerson(ctx, { amount: 500, daysAgo: 10, unit: 'Lot 2' })
    await bank(ctx, [{ receiptId: a.receiptId, amount: 500 }, { receiptId: b.receiptId, amount: 500 }])
    const pos = await cashBankingPosition(ctx.landlordId)
    expect(pos.unbanked).toHaveLength(0)
  })

  // Electronic rent is not "collected in person" and must never appear here —
  // it never passed through anyone's hands.
  it('a card or bank payment through Stripe is never cash to bank', async () => {
    const ctx = await build()
    const c = await collectInPerson(ctx, { amount: 500, daysAgo: 10, unit: 'Lot 1' })
    await db.query(
      `UPDATE tenant_remittances SET payment_method = 'card', stripe_payment_intent_id = 'pi_x' WHERE id = $1`, [c.receiptId])
    expect((await cashBankingPosition(ctx.landlordId)).unbanked).toHaveLength(0)
  })

  it('counts deposits nobody has attributed, the other side of the question', async () => {
    const ctx = await build()
    await db.query(
      `INSERT INTO bank_transactions
         (bank_connection_id, landlord_id, external_id, posted_date, amount, status)
       VALUES ($1,$2,$3,CURRENT_DATE,900,'needs_review')`,
      [ctx.connectionId, ctx.landlordId, randomUUID()])
    const pos = await cashBankingPosition(ctx.landlordId)
    expect(pos.unattributedDeposits).toBe(1)
    expect(pos.unattributedTotal).toBe(900)
  })

  it('never reports another landlord’s cash', async () => {
    const a = await build()
    const b = await build()
    await collectInPerson(b, { amount: 500, daysAgo: 10, unit: 'Lot 9' })
    expect((await cashBankingPosition(a.landlordId)).unbanked).toHaveLength(0)
  })
})

describe('S655: what went into the bag', () => {
  it('bank-match receipts and prior arrangements are never unbanked cash', async () => {
    const ctx = await build()
    // A receipt a bank match wrote: the money went straight into the bank.
    const matched = await collectInPerson(ctx, { amount: 300, daysAgo: 10, unit: 'Lot 1' })
    await db.query(
      `INSERT INTO bank_transactions
         (bank_connection_id, landlord_id, external_id, posted_date, amount, status, auto_settle_undo)
       VALUES ($1,$2,$3,CURRENT_DATE - 10,300,'matched',$4::jsonb)`,
      [ctx.connectionId, ctx.landlordId, randomUUID(),
       JSON.stringify({ version: 1, receiptId: matched.receiptId, rows: [] })])
    // A receipt recorded for rows a bank deposit paid before receipts existed.
    const historic = await collectInPerson(ctx, { amount: 400, daysAgo: 10, unit: 'Lot 2' })
    const t = (await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, status)
       VALUES ($1,$2,$3,CURRENT_DATE - 9,400,'matched') RETURNING id`,
      [ctx.connectionId, ctx.landlordId, randomUUID()])).rows[0]
    await db.query(
      `INSERT INTO bank_deposit_allocations (bank_transaction_id, payment_id, landlord_id, amount, effective_paid_date)
       VALUES ($1,$2,$3,400,CURRENT_DATE - 10)`, [t.id, historic.rentId, ctx.landlordId])
    // A prior arrangement: settled before GAM, no receipt at all.
    const client = await getClient()
    try {
      const tenantId = await seedTenant(client)
      const unitId = await seedUnit(client, { propertyId: ctx.propertyId, landlordId: ctx.landlordId })
      await client.query(
        `INSERT INTO payments (unit_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                               manual_method, settled_at)
         VALUES ($1,$2,$3,'rent',650,'settled',CURRENT_DATE - 20,'RENT','prior_arrangement', NOW() - interval '20 days')`,
        [unitId, tenantId, ctx.landlordId])
    } finally { client.release() }
    // Only real desk cash counts.
    const desk = await collectInPerson(ctx, { amount: 125, daysAgo: 10, unit: 'Lot 3' })

    const pos = await cashBankingPosition(ctx.landlordId)
    expect(pos.unbanked.map(u => u.id)).toEqual([desk.receiptId])
    expect(pos.unbankedTotal).toBe(125)
  })

  it('what was handed over is what goes in the bag: a $500 receipt that paid $460 and kept $40 counts $500', async () => {
    const ctx = await build()
    const r = await collectInPerson(ctx, { amount: 460, handedOver: 500, daysAgo: 6, unit: 'MH 25' })
    const pos = await cashBankingPosition(ctx.landlordId)
    expect(pos.unbanked).toHaveLength(1)
    expect(pos.unbanked[0]).toMatchObject({ id: r.receiptId, amount: 500, kind: 'receipt', paymentId: r.rentId })
  })

  it('splits into on a slip waiting for the bank and not on any slip; what is on a slip shows at once', async () => {
    const ctx = await build()
    const slipped = await collectInPerson(ctx, { amount: 200, daysAgo: 0, unit: 'Lot 1' })
    await collectInPerson(ctx, { amount: 75, daysAgo: 8, unit: 'Lot 2', method: 'check' })
    const slipId = await onOpenSlip(ctx, { receiptId: slipped.receiptId, amount: 200 })
    const pos = await cashBankingPosition(ctx.landlordId)
    expect(pos.onSlip.items.map(i => [i.amount, i.slipId])).toEqual([[200, slipId]])
    expect(pos.onSlip.total).toBe(200)
    expect(pos.notOnSlip.items.map(i => [i.amount, i.method])).toEqual([[75, 'check']])
    expect(pos.unbankedTotal).toBe(275)
  })

  it('register cash counts net of refunds; voided and card sales never', async () => {
    const ctx = await build()
    const sale = async (method: string, total: number, status: string, refund = 0) => (await db.query(
      `INSERT INTO pos_transactions (landlord_id, property_id, cashier_id, payment_method, subtotal, total, status,
                                     refund_amount, created_at)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7, NOW() - interval '6 days') RETURNING id`,
      [ctx.landlordId, ctx.propertyId, ctx.userId, method, total.toFixed(2), status, refund.toFixed(2)])).rows[0].id
    const kept = await sale('cash', 40, 'partial_refund', 10)
    await sale('cash', 25, 'voided')
    await sale('cash', 30, 'refunded', 30)
    await sale('card', 99, 'completed')
    const pos = await cashBankingPosition(ctx.landlordId)
    expect(pos.unbanked.map(u => [u.id, u.kind, u.amount])).toEqual([[kept, 'register_sale', 30]])
  })
})
