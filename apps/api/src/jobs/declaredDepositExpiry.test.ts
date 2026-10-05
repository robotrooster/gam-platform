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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// A bank match (confirmDepositMatch) settles through the desk path, which may
// cancel a superseded pull after commit. Nothing here reaches Stripe.
vi.mock('../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getStripe: () => ({ paymentIntents: { cancel: vi.fn(async (id: string) => ({ id, status: 'canceled' })) } }) }
})

import { db, getClient } from '../db'
import {
  sweepExpiredDeclarations, resolveReportsRecordedByLandlord, RECORDED_BY_LANDLORD_RULE,
} from './declaredDepositExpiry'
import { confirmDepositMatch } from '../services/bankDepositConfirm'
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
async function linkBank(landlordId: string, opts: { syncedDaysAgo?: number | null; status?: string; linkedDaysAgo?: number } = {}) {
  // S655: a link only counts if it was there on the day of the deposit — by
  // default one linked two months ago.
  await db.query(
    `INSERT INTO bank_connections (landlord_id, provider, status, last_synced_at, created_at)
     VALUES ($1, 'stripe_fc', $2, CASE WHEN $3::int IS NULL THEN NULL ELSE NOW() - ($3::int * interval '1 day') END,
             NOW() - ($4::int * interval '1 day'))`,
    [landlordId, opts.status ?? 'active', opts.syncedDaysAgo === undefined ? 0 : opts.syncedDaysAgo, opts.linkedDaysAgo ?? 60])
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

  it('expires once a link that was there on the deposit day has synced past the window', async () => {
    const d = await declare(DECLARATION_EXPIRY_DAYS + 2, 'none')
    await linkBank(d.landlordId, { syncedDaysAgo: 0, linkedDaysAgo: DECLARATION_EXPIRY_DAYS + 3 })
    expect((await sweepExpiredDeclarations()).expired).toBe(1)
    expect((await statusOf(d.id)).status).toBe('unconfirmed')
  })

  // S655 (Step 9): a bank linked AFTER the report was never looking on the
  // day of the deposit — the old sweep counted it and wrote the report off.
  it('a bank linked after the deposit day does not count', async () => {
    const d = await declare(DECLARATION_EXPIRY_DAYS + 2, 'none')
    await linkBank(d.landlordId, { syncedDaysAgo: 0, linkedDaysAgo: 1 })
    expect((await sweepExpiredDeclarations()).expired).toBe(0)
    expect((await statusOf(d.id)).status).toBe('pending')
  })

  it('a deposit from before the company’s books start is never written off', async () => {
    const d = await declare(DECLARATION_EXPIRY_DAYS + 2)
    await db.query(`UPDATE landlords SET books_start_date = CURRENT_DATE - 3 WHERE id = $1`, [d.landlordId])
    expect((await sweepExpiredDeclarations()).expired).toBe(0)
    expect((await statusOf(d.id)).status).toBe('pending')
  })
})

// S655 (decisions #11): a report the landlord then records by hand resolves as
// "recorded by your landlord" — it never stays pending forever, and is never a
// strike.
describe('a report the landlord recorded by hand', () => {
  // A recorded report points at its receipt (FK), and the shared cleanup
  // deletes receipts before reports: clear these first.
  afterEach(async () => { await db.query(`DELETE FROM tenant_declared_deposits WHERE recorded_remittance_id IS NOT NULL`) })

  async function receipt(d: { tenantId: string; leaseId: string; landlordId: string }, o: {
    amount: number; method?: string; daysAgo: number; status?: string
  }): Promise<string> {
    return (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, status,
                                       payment_method, settled_at)
       VALUES ($1,$2,$3,$4,$4,$5,$6, NOW() - ($7::int * interval '1 day')) RETURNING id`,
      [d.tenantId, d.leaseId, d.landlordId, o.amount.toFixed(2), o.status ?? 'settled', o.method ?? 'cash', o.daysAgo])).rows[0].id
  }

  it('closes as recorded when the landlord took the money at the desk (no bank linked)', async () => {
    const d = await declare(3, 'none')
    const rem = await receipt(d, { amount: 250, method: 'money_order', daysAgo: 1 })
    const r = await sweepExpiredDeclarations()
    expect(r).toMatchObject({ recorded: 1, expired: 0 })
    const row = (await db.query(
      `SELECT status, recorded_remittance_id, resolution_note FROM tenant_declared_deposits WHERE id=$1`, [d.id])).rows[0]
    expect(row.status).toBe('recorded')
    expect(row.recorded_remittance_id).toBe(rem)
    expect(row.resolution_note).toMatch(/Recorded by your landlord: a \$250\.00 money order payment/)
    const t = (await db.query(`SELECT user_id FROM tenants WHERE id=$1`, [d.tenantId])).rows[0]
    const n = (await db.query(`SELECT title, body FROM notifications WHERE user_id=$1`, [t.user_id])).rows
    expect(n.map((x: any) => x.title)).toContain('Your landlord recorded your payment')
  })

  it('where the bank is being read, waits for the bank match until the report’s window has run', async () => {
    const d = await declare(2)                                    // bank linked and synced, window still open
    await receipt(d, { amount: 250, method: 'cash', daysAgo: 1 })
    expect((await sweepExpiredDeclarations()).recorded).toBe(0)
    expect((await statusOf(d.id)).status).toBe('pending')
  })

  it('where GAM reads the bank, by default (#11 as written) a desk receipt does not close it: the report matches or expires, as before', async () => {
    const d = await declare(DECLARATION_EXPIRY_DAYS + 2)       // bank linked and read past the window
    await receipt(d, { amount: 300, method: 'check', daysAgo: DECLARATION_EXPIRY_DAYS })
    const r = await sweepExpiredDeclarations()
    expect(r).toMatchObject({ recorded: 0, expired: 1 })
    expect((await statusOf(d.id)).status).toBe('unconfirmed')
  })

  it('with the bank-read extension on (asked of Nic), a desk receipt closes it there too, and it is never a strike', async () => {
    const d = await declare(DECLARATION_EXPIRY_DAYS + 2)       // bank linked and read past the window
    await receipt(d, { amount: 300, method: 'check', daysAgo: DECLARATION_EXPIRY_DAYS })
    const on = { receiptWindowDays: null, atBankWatchedCompanies: true }
    expect((await resolveReportsRecordedByLandlord(undefined, on)).recorded).toBe(1)
    const r = await sweepExpiredDeclarations()
    expect(r).toMatchObject({ expired: 0, tenantsFlagged: 0 })
    expect((await statusOf(d.id)).status).toBe('recorded')
  })

  it('a receipt from before the reported day, for less, or by card does not close it', async () => {
    const d = await declare(3, 'none')
    await receipt(d, { amount: 250, daysAgo: 5 })                 // before the reported day
    await receipt(d, { amount: 200, daysAgo: 1 })                 // less than reported
    await receipt(d, { amount: 250, method: 'card', daysAgo: 1 }) // not money the landlord took by hand
    const r = await sweepExpiredDeclarations()
    expect(r.recorded).toBe(0)
    expect((await statusOf(d.id)).status).toBe('pending')
  })

  it('a receipt for exactly the reported amount goes to that report, not an older one', async () => {
    const d = await declare(30, 'none')                           // MH 21: $250 reported weeks ago…
    const exact = (await db.query<{ id: string }>(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method)
       VALUES ($1,$2,$3,815,CURRENT_DATE - 2,'cash') RETURNING id`,
      [d.tenantId, d.leaseId, d.landlordId])).rows[0].id         // …and $815 two days ago
    await receipt(d, { amount: 815, daysAgo: 1 })
    expect((await sweepExpiredDeclarations()).recorded).toBe(1)
    expect((await statusOf(exact)).status).toBe('recorded')
    expect((await statusOf(d.id)).status).toBe('pending')
  })

  it('a deposit the bank match used to confirm one report never closes another report', async () => {
    // MH 21: a $666.50 report from 9/4 the landlord never recorded, and an $815
    // report from 10/1. The bank is linked only after both (Blu linking
    // TruBlu's bank), and the $815 posts.
    const old = await declare(27, 'none')
    await db.query(`UPDATE tenant_declared_deposits SET amount = 666.50 WHERE id = $1`, [old.id])
    const recent = (await db.query<{ id: string }>(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method)
       VALUES ($1,$2,$3,815,CURRENT_DATE - 2,'cash') RETURNING id`,
      [old.tenantId, old.leaseId, old.landlordId])).rows[0].id
    const unit = (await db.query<{ unit_id: string }>(`SELECT unit_id FROM leases WHERE id=$1`, [old.leaseId])).rows[0]
    const inv = (await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount)
       VALUES ($1,$2,$3,$4,$5,CURRENT_DATE - 3,815,815) RETURNING id`,
      [old.landlordId, old.tenantId, old.leaseId, unit.unit_id, `MH21-${randomUUID().slice(0, 8)}`])).rows[0]
    const rent = (await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'rent',815,'pending',CURRENT_DATE - 3,'RENT') RETURNING id`,
      [inv.id, unit.unit_id, old.leaseId, old.tenantId, old.landlordId])).rows[0]
    const conn = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status, created_at, last_synced_at)
       VALUES ($1,'stripe_fc','active', NOW() - interval '1 day', NOW()) RETURNING id`, [old.landlordId])).rows[0]
    const txn = (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
       VALUES ($1,$2,$3,CURRENT_DATE - 1,815,'CASH DEPOSIT','needs_review') RETURNING id`,
      [conn.id, old.landlordId, randomUUID()])).rows[0]

    // The landlord matches the $815 deposit: it confirms the $815 report.
    const m = await confirmDepositMatch({ bankTransactionId: txn.id, chargeIds: [rent.id], method: 'cash' })
    expect(m.declarationId).toBe(recent)
    expect((await statusOf(recent)).status).toBe('confirmed')

    // The nightly sweep: that same $815 never also closes the $666.50 report.
    const r = await sweepExpiredDeclarations()
    expect(r).toMatchObject({ recorded: 0, expired: 0 })
    expect((await statusOf(old.id)).status).toBe('pending')
    const t = (await db.query(`SELECT user_id FROM tenants WHERE id=$1`, [old.tenantId])).rows[0]
    const told = (await db.query(`SELECT body FROM notifications WHERE user_id=$1 AND type='payment_recorded'`, [t.user_id])).rows
    expect(told.map((x: any) => x.body).join(' ')).not.toMatch(/covers the \$666\.50 deposit/)

    // Money the landlord later takes for it at the desk still closes it.
    await receipt(old, { amount: 666.50, method: 'cash', daysAgo: 0 })
    expect((await sweepExpiredDeclarations()).recorded).toBe(1)
    expect((await statusOf(old.id)).status).toBe('recorded')
  })

  it('one receipt closes one report, the oldest first', async () => {
    const d = await declare(4, 'none')
    const second = (await db.query<{ id: string }>(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method)
       VALUES ($1,$2,$3,250,CURRENT_DATE - 2,'cash') RETURNING id`,
      [d.tenantId, d.leaseId, d.landlordId])).rows[0].id
    await receipt(d, { amount: 250, daysAgo: 1 })
    const r = await sweepExpiredDeclarations()
    expect(r.recorded).toBe(1)
    expect((await statusOf(d.id)).status).toBe('recorded')
    expect((await statusOf(second)).status).toBe('pending')
  })
})

// Step 9 review: which hand-recorded receipt may close a report is ONE rule
// (RECORDED_BY_LANDLORD_RULE), with two answers asked of Nic. These pin what it
// does today and what each answer would do.
describe('Step 9 review: which receipt closes a report is one rule', () => {
  afterEach(async () => { await db.query(`DELETE FROM tenant_declared_deposits WHERE recorded_remittance_id IS NOT NULL`) })

  async function deskReceipt(d: { tenantId: string; leaseId: string; landlordId: string }, amount: number, daysAgo: number) {
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, status, payment_method, settled_at)
       VALUES ($1,$2,$3,$4,$4,'settled','cash', NOW() - ($5::int * interval '1 day'))`,
      [d.tenantId, d.leaseId, d.landlordId, amount.toFixed(2), daysAgo])
  }

  it('today it is decisions #11 as written: no time limit, and only companies with no bank GAM reads', () => {
    expect(RECORDED_BY_LANDLORD_RULE).toEqual({ receiptWindowDays: null, atBankWatchedCompanies: false })
  })

  it('as written, a later month’s desk payment of at least the reported amount closes an older report', async () => {
    const d = await declare(40, 'none')                      // reported 40 days ago, never recorded
    await deskReceipt(d, 815, 2)                              // next month's payment at the desk
    expect((await sweepExpiredDeclarations()).recorded).toBe(1)
    expect((await statusOf(d.id)).status).toBe('recorded')
  })

  it('with a receipt window, the next month’s payment never closes an older report', async () => {
    const rule = { receiptWindowDays: 10, atBankWatchedCompanies: false }
    const d = await declare(40, 'none')
    await deskReceipt(d, 815, 2)                              // 38 days after the reported day
    expect((await resolveReportsRecordedByLandlord(undefined, rule)).recorded).toBe(0)
    expect((await statusOf(d.id)).status).toBe('pending')
    await deskReceipt(d, 250, 35)                             // 5 days after it: inside the window
    expect((await resolveReportsRecordedByLandlord(undefined, rule)).recorded).toBe(1)
    expect((await statusOf(d.id)).status).toBe('recorded')
  })

  it('with the bank-read extension off (the default), a report where the bank was read only matches or expires — never closed by a desk receipt', async () => {
    const rule = RECORDED_BY_LANDLORD_RULE
    const watched = await declare(DECLARATION_EXPIRY_DAYS + 2)            // bank linked and read past the window
    await deskReceipt(watched, 250, DECLARATION_EXPIRY_DAYS)
    const noBank = await declare(3, 'none')
    await deskReceipt(noBank, 250, 1)
    expect((await resolveReportsRecordedByLandlord(undefined, rule)).recorded).toBe(1)
    expect((await statusOf(watched.id)).status).toBe('pending')
    expect((await statusOf(noBank.id)).status).toBe('recorded')
  })

  it('refuses a window that is not a whole number of days', async () => {
    await expect(resolveReportsRecordedByLandlord(undefined, { receiptWindowDays: 2.5, atBankWatchedCompanies: true }))
      .rejects.toThrow(/whole number of days/)
  })
})
