/**
 * S624 — deposit reports the bank never confirmed.
 *
 * The weaker half of the anti-fraud design, and it must stay weak on purpose:
 * the STRONG half is that a declaration credits nothing, so lying wins nothing.
 * This only cleans up and records a pattern. It must never accuse — a missing
 * deposit is far more often a wrong account number than a lie, and we genuinely
 * cannot tell the two apart.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { sweepExpiredDeclarations } from './declaredDepositExpiry'
import { DECLARATION_EXPIRY_DAYS } from '../routes/declaredDeposits'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease,
  seedLeaseTenant,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

/**
 * S655: a report only expires once the company's bank was actually read past
 * the report's window. declare() links one that synced today unless told 'none'.
 */
async function linkBank(landlordId: string, opts: { syncedDaysAgo?: number | null; status?: string } = {}) {
  await db.query(
    `INSERT INTO bank_connections (landlord_id, provider, status, last_synced_at)
     VALUES ($1, 'stripe_fc', $2, CASE WHEN $3::int IS NULL THEN NULL ELSE NOW() - ($3::int * interval '1 day') END)`,
    [landlordId, opts.status ?? 'active', opts.syncedDaysAgo === undefined ? 0 : opts.syncedDaysAgo])
}

async function declare(daysAgo: number, bank: 'synced' | 'none' = 'synced') {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 250 })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 250 })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
    const d = (await client.query(
      `INSERT INTO tenant_declared_deposits
         (tenant_id, lease_id, landlord_id, amount, declared_date, method)
       VALUES ($1,$2,$3,250,(CURRENT_DATE - $4::int),'cash') RETURNING id`,
      [tenantId, leaseId, landlordId, daysAgo])).rows[0]
    if (bank === 'synced') await linkBank(landlordId)
    return { id: d.id, tenantId, leaseId, landlordId }
  } finally { client.release() }
}

const statusOf = async (id: string) => (await db.query(
  `SELECT status, resolution_note FROM tenant_declared_deposits WHERE id=$1`,
  [id])).rows[0]

describe('expiring a report the bank never matched', () => {
  it('leaves a fresh claim alone — the deposit may still be in transit', async () => {
    const d = await declare(1)
    const r = await sweepExpiredDeclarations()
    expect(r.expired).toBe(0)
    expect((await statusOf(d.id)).status).toBe('pending')
  })

  it('expires one that has run out of time', async () => {
    const d = await declare(DECLARATION_EXPIRY_DAYS + 2)
    const r = await sweepExpiredDeclarations()
    expect(r.expired).toBe(1)
    const row = await statusOf(d.id)
    expect(row.status).toBe('unconfirmed')
    // Says what happened, not what the tenant did. We cannot tell a lie from a
    // deposit made into the wrong account, and the tenant is far more likely to
    // be the second.
    expect(row.resolution_note).toContain('could not find')
    expect(row.resolution_note).not.toMatch(/fraud|lied|false/i)
  })

  it('tells the tenant, and says their balance is unchanged', async () => {
    const d = await declare(DECLARATION_EXPIRY_DAYS + 2)
    await sweepExpiredDeclarations()
    const t = (await db.query(
      `SELECT user_id FROM tenants WHERE id=$1`, [d.tenantId])).rows[0]
    const n = (await db.query(
      `SELECT title, body FROM notifications WHERE user_id=$1`, [t.user_id])).rows[0]
    expect(n).toBeTruthy()
    expect(n.body).toContain('balance is unchanged')
    expect(n.body).toMatch(/talk to your landlord/i)
  })

  it('does not flag a landlord over a single miss', async () => {
    await declare(DECLARATION_EXPIRY_DAYS + 2)
    const r = await sweepExpiredDeclarations()
    expect(r.tenantsFlagged).toBe(0)
  })

  it('flags the landlord once a pattern forms', async () => {
    const client = await getClient()
    let ctx: any
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, {
        landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 250 })
      const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 250 })
      await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
      for (let i = 0; i < 2; i++) {
        await client.query(
          `INSERT INTO tenant_declared_deposits
             (tenant_id, lease_id, landlord_id, amount, declared_date, method)
           VALUES ($1,$2,$3,250,(CURRENT_DATE - $4::int),'cash')`,
          [tenantId, leaseId, landlordId, DECLARATION_EXPIRY_DAYS + 2 + i])
      }
      ctx = { landlordId, ownerUserId: userId }
    } finally { client.release() }
    await linkBank(ctx.landlordId)

    const r = await sweepExpiredDeclarations()
    expect(r.expired).toBe(2)
    expect(r.tenantsFlagged).toBeGreaterThan(0)

    const n = (await db.query(
      `SELECT title, body FROM notifications
        WHERE user_id=$1 AND landlord_id=$2`,
      [ctx.ownerUserId, ctx.landlordId])).rows[0]
    expect(n).toBeTruthy()
    // Even the landlord's version stays neutral and offers the innocent reading.
    expect(n.body).toContain('never credited')
    expect(n.body).toMatch(/wrong account number/i)
  })

  it('never touches a confirmed report', async () => {
    const d = await declare(DECLARATION_EXPIRY_DAYS + 5)
    const client = await getClient()
    try {
      const conn = (await client.query(
        `INSERT INTO bank_connections (landlord_id, provider, status)
         VALUES ($1,'stripe_fc','active') RETURNING id`, [d.landlordId])).rows[0]
      const txn = (await client.query(
        `INSERT INTO bank_transactions
           (bank_connection_id, landlord_id, external_id, posted_date, amount, status)
         VALUES ($1,$2,$3,CURRENT_DATE,250,'matched') RETURNING id`,
        [conn.id, d.landlordId, randomUUID()])).rows[0]
      await client.query(
        `UPDATE tenant_declared_deposits
            SET status='confirmed', bank_transaction_id=$2, confirmed_at=NOW()
          WHERE id=$1`, [d.id, txn.id])
    } finally { client.release() }

    const r = await sweepExpiredDeclarations()
    expect(r.expired).toBe(0)
    expect((await statusOf(d.id)).status).toBe('confirmed')
  })
})

// S655: Country Acres has no bank linked, and MH 21's $666.50 report of 9/4
// expired anyway as "not found in your landlord's bank feed" — a strike for a
// deposit nobody could look for. The 10/1 report would have been the second
// strike and an alert to the landlord.
describe('a report only expires once the bank was actually looked at', () => {
  it('never expires while the company has no bank linked', async () => {
    const d = await declare(DECLARATION_EXPIRY_DAYS + 20, 'none')
    const r = await sweepExpiredDeclarations()
    expect(r.expired).toBe(0)
    expect((await statusOf(d.id)).status).toBe('pending')
  })

  it('waits while the linked bank has not synced past the end of the report’s window', async () => {
    const d = await declare(DECLARATION_EXPIRY_DAYS + 2, 'none')
    // Last read the day after the deposit — the window ran six more days.
    await linkBank(d.landlordId, { syncedDaysAgo: DECLARATION_EXPIRY_DAYS + 1 })
    expect((await sweepExpiredDeclarations()).expired).toBe(0)
    expect((await statusOf(d.id)).status).toBe('pending')
  })

  it('a disconnected link does not count as looking', async () => {
    const d = await declare(DECLARATION_EXPIRY_DAYS + 2, 'none')
    await linkBank(d.landlordId, { status: 'disconnected' })
    expect((await sweepExpiredDeclarations()).expired).toBe(0)
    expect((await statusOf(d.id)).status).toBe('pending')
  })

  it('no strike and no alert to the landlord for reports there was no bank to check', async () => {
    const first = await declare(DECLARATION_EXPIRY_DAYS + 20, 'none')
    await db.query(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method)
       VALUES ($1,$2,$3,815,(CURRENT_DATE - $4::int),'cash')`,
      [first.tenantId, first.leaseId, first.landlordId, DECLARATION_EXPIRY_DAYS + 1])
    const r = await sweepExpiredDeclarations()
    expect(r).toMatchObject({ expired: 0, tenantsFlagged: 0 })
    const n = await db.query(`SELECT 1 FROM notifications WHERE landlord_id = $1`, [first.landlordId])
    expect(n.rowCount).toBe(0)
  })

  it('expires once a link has synced past the window', async () => {
    const d = await declare(DECLARATION_EXPIRY_DAYS + 2, 'none')
    await linkBank(d.landlordId, { syncedDaysAgo: 0 })
    expect((await sweepExpiredDeclarations()).expired).toBe(1)
    expect((await statusOf(d.id)).status).toBe('unconfirmed')
  })
})
