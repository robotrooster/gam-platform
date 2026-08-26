/**
 * S624 — the on-site cash control.
 *
 * Nic: "a landlord would mark each one paid as they collect the rent in person
 * in the office, and then the bulk deposit would be sorted and verified against
 * those ones that were marked paid in person. It needs a double verification."
 *
 * The thing being tested is a FRAUD CONTROL, not a reconciliation convenience:
 * money marked collected that never reached the bank, with names attached.
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

async function build() {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    const conn = (await client.query(
      `INSERT INTO bank_connections (landlord_id, provider, status)
       VALUES ($1,'stripe_fc','active') RETURNING id`, [landlordId])).rows[0]
    return { landlordId, propertyId, connectionId: conn.id, client: null }
  } finally { client.release() }
}

/** A rent marked collected in person, `daysAgo` back. */
async function collectInPerson(
  ctx: { landlordId: string; propertyId: string },
  opts: { amount: number; daysAgo: number; unit: string },
): Promise<string> {
  const client = await getClient()
  try {
    const tenantId = await seedTenant(client)
    const unitId = await seedUnit(client, {
      propertyId: ctx.propertyId, landlordId: ctx.landlordId, rentAmount: opts.amount })
    await client.query(`UPDATE units SET unit_number=$2 WHERE id=$1`, [unitId, opts.unit])
    const leaseId = await seedLease(client, {
      unitId, landlordId: ctx.landlordId, rentAmount: opts.amount })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    const row = (await client.query(
      `INSERT INTO payments
         (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
          due_date, entry_description, manual_method, settled_at)
       VALUES ($1,$2,$3,$4,'rent',$5,'settled',CURRENT_DATE,'RENT','cash',
               NOW() - ($6::int || ' days')::interval)
       RETURNING id`,
      [unitId, leaseId, tenantId, ctx.landlordId, opts.amount.toFixed(2), opts.daysAgo])).rows[0]
    return row.id
  } finally { client.release() }
}

/** Say a deposit accounted for this collection. */
async function bank(ctx: any, paymentId: string, amount: number) {
  const txn = (await db.query(
    `INSERT INTO bank_transactions
       (bank_connection_id, landlord_id, external_id, posted_date, amount, status)
     VALUES ($1,$2,$3,CURRENT_DATE,$4,'matched') RETURNING id`,
    [ctx.connectionId, ctx.landlordId, randomUUID(), amount.toFixed(2)])).rows[0]
  await db.query(
    `INSERT INTO bank_deposit_allocations
       (bank_transaction_id, payment_id, landlord_id, amount, effective_paid_date)
     VALUES ($1,$2,$3,$4,CURRENT_DATE)`,
    [txn.id, paymentId, ctx.landlordId, amount.toFixed(2)])
}

describe('cash collected but never banked', () => {
  it('finds the gap, with names on it', async () => {
    const ctx = await build()
    const banked = await collectInPerson(ctx, { amount: 2750, daysAgo: 10, unit: 'Lot 1' })
    await collectInPerson(ctx, { amount: 250, daysAgo: 10, unit: 'Lot 2' })
    await bank(ctx, banked, 2750)

    const pos = await cashBankingPosition(ctx.landlordId)
    expect(pos.unbankedTotal).toBe(250)          // collected $3,000, banked $2,750
    expect(pos.unbanked).toHaveLength(1)
    expect(pos.unbanked[0].unitNumber).toBe('Lot 2')
    expect(pos.unbanked[0].daysOutstanding).toBe(10)
    expect(pos.oldestDays).toBe(10)
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

  it('honours a landlord’s own grace period', async () => {
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
    await bank(ctx, a, 500)
    await bank(ctx, b, 500)
    const pos = await cashBankingPosition(ctx.landlordId)
    expect(pos.unbanked).toHaveLength(0)
  })

  // Electronic rent is not "collected in person" and must never appear here —
  // it never passed through anyone's hands.
  it('ignores payments that were never manual', async () => {
    const ctx = await build()
    const id = await collectInPerson(ctx, { amount: 500, daysAgo: 10, unit: 'Lot 1' })
    await db.query(`UPDATE payments SET manual_method=NULL WHERE id=$1`, [id])
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
