/**
 * 10/13 evening (Nic): "Bank takes back a bounced deposit that was MATCHED to
 * income: void what bounced." — the counterpart of a deposit FILED as income
 * (10/13: "Bank void of a deposit filed as other income → VOID the income
 * record too"). When the bank voids a deposit that was matched, the sync takes
 * back what it was matched to by itself (services/bankFeed voidWhatBounced):
 *   - a deposit that paid a tenant's bills: the receipt is closed as taken back
 *     (kept on record), the bills are owed again, the tenant and the owner told;
 *   - a deposit slip of other money alone (services/depositSlips.test.ts):
 *     that money voided, the slip open again.
 * Left for the owner (told, as before): a deposit matched before GAM kept a
 * record of what a match changes, a GAM payout, one the Undo refuses, and —
 * 10/13 review, GAM cannot take back a payment recorded at the desk yet — a
 * deposit tied to a hand-logged receipt, or a slip with payments in it
 * (services/depositSlips.test.ts).
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getStripe: () => ({ paymentIntents: { cancel: vi.fn(async (id: string) => ({ id, status: 'canceled' })) } }) }
})

import { db, getClient } from '../db'
import { confirmDepositMatch } from './bankDepositConfirm'
import { upsertTransactions, voidWhatBounced } from './bankFeed'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

/** Rent due 2026-09-01, $250, unpaid; a $250 mobile deposit on the 7th, on a linked bank. */
async function stack() {
  const c = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 250 })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 250 })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    const inv = (await c.query(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount)
       VALUES ($1,$2,$3,$4,$5,'2026-09-01',250,250) RETURNING id`,
      [landlordId, tenantId, leaseId, unitId, `B-${randomUUID().slice(0, 8)}`])).rows[0]
    const rentId = (await c.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'rent',250,'pending','2026-09-01','RENT') RETURNING id`,
      [inv.id, unitId, leaseId, tenantId, landlordId])).rows[0].id
    const connectionId = (await c.query(
      `INSERT INTO bank_connections (landlord_id, provider, status) VALUES ($1,'stripe_fc','active') RETURNING id`, [landlordId])).rows[0].id
    const externalId = `dep_${randomUUID().slice(0, 8)}`
    const txnId = (await c.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status, bank_status)
       VALUES ($1,$2,$3,'2026-09-07',250,'MOBILE DEPOSIT','needs_review','pending') RETURNING id`,
      [connectionId, landlordId, externalId])).rows[0].id
    const tenantUserId = (await c.query(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    await c.query(`UPDATE users SET first_name = 'Dana', last_name = 'Renter' WHERE id = $1`, [tenantUserId])
    await c.query(`UPDATE units SET unit_number = 'RV 7' WHERE id = $1`, [unitId])
    return { userId, landlordId, tenantId, tenantUserId, rentId, connectionId, externalId, txnId }
  } finally { c.release() }
}

const voidAtTheBank = (s: Awaited<ReturnType<typeof stack>>) => upsertTransactions(s.connectionId, s.landlordId, [
  { externalId: s.externalId, postedDate: '2026-09-07', amount: 250, description: 'MOBILE DEPOSIT', status: 'void' },
])

const line = async (id: string) => (await db.query(
  `SELECT status, ignored_reason, bank_status, matched_payment_id, (auto_settle_undo->>'bankVoided')::boolean AS bank_voided,
          (auto_settle_undo->>'undone')::boolean AS undone
     FROM bank_transactions WHERE id = $1`, [id])).rows[0]

describe('a matched deposit the bank takes back (10/13 evening, Nic: "void what bounced")', () => {
  it('a deposit that paid rent (a pending mobile deposit the landlord confirmed): the receipt is taken back, the rent is owed again, the line set aside, both sides told', async () => {
    const s = await stack()
    const r = await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check', confirmedByUserId: s.userId })
    const receiptId = r.receiptId
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [s.rentId])).rows[0].status).toBe('settled')

    await voidAtTheBank(s)

    // What bounced is taken back: the rent is owed again, as it was.
    expect((await db.query(`SELECT status, manual_method FROM payments WHERE id = $1`, [s.rentId])).rows[0])
      .toEqual({ status: 'pending', manual_method: null })
    // The receipt stays on record, closed as taken back.
    const rec = (await db.query(`SELECT status, undone_at IS NOT NULL AS undone, notes FROM tenant_remittances WHERE id = $1`, [receiptId])).rows[0]
    expect(rec).toMatchObject({ status: 'failed', undone: true })
    expect(rec.notes).toMatch(/the bank took this deposit back \(it did not go through\), so it was taken back off the bills it paid/)
    // The line is set aside as the bank's void — not back in review to be filed.
    expect(await line(s.txnId)).toEqual({
      status: 'ignored', ignored_reason: 'bank_void', bank_status: 'void', matched_payment_id: null, bank_voided: true, undone: true,
    })
    // The owner hears what was taken back; the tenant that the deposit did not go through.
    const owner = (await db.query(`SELECT title, body, action_url FROM notifications WHERE user_id = $1 AND type = 'bank_deposit_voided'`, [s.userId])).rows
    expect(owner).toEqual([{
      title: 'Your bank took back a deposit that paid rent',
      body: 'Your bank voided the $250.00 deposit of Sep 7, 2026 that was matched to Dana Renter (RV 7)\'s bills — the money did not come in. '
        + 'GAM took it back off those bills: they are owed again, and the payment stays on record as taken back. Your tenant was told.',
      action_url: '/bank',
    }])
    await new Promise(res => setTimeout(res, 50))   // the tenant's notice goes out after the commit
    const tenant = (await db.query(`SELECT body FROM notifications WHERE user_id = $1 AND type = 'payment_recorded'`, [s.tenantUserId])).rows
    expect(tenant.map((n: any) => n.body)).toContain('The $250.00 bank deposit of 2026-09-07 did not go through — the bank took it back, so it was taken off your bill. '
      + 'What it paid is owed again. If you think this is a mistake, check with your bank and tell your landlord.')
    // Nobody was told to Undo it by hand.
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'bank_deposit_voided_after_match'`)).rowCount).toBe(0)
    // Heard again: nothing more.
    await voidAtTheBank(s)
    expect((await db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'bank_deposit_voided'`, [s.userId])).rowCount).toBe(1)
  })

  it('a deposit matched before GAM kept a record of what a match changes stays as it is — the owner and GAM are told, as before', async () => {
    const s = await stack()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = now(), manual_method = 'check' WHERE id = $1`, [s.rentId])
    await db.query(`UPDATE bank_transactions SET status = 'matched', matched_payment_id = $2 WHERE id = $1`, [s.txnId, s.rentId])
    await voidAtTheBank(s)
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [s.rentId])).rows[0].status).toBe('settled')
    expect(await line(s.txnId)).toMatchObject({ status: 'matched', bank_status: 'void' })
    expect((await db.query(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'bank_deposit_voided'`, [s.userId])).rows)
      .toEqual([{ title: 'Your bank voided a deposit that paid rent' }])
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'bank_deposit_voided_after_match'`)).rowCount).toBe(1)
  })

  it('takes back only a matched deposit the bank voided — never a posted one, a payout, or a money-out match', async () => {
    const s = await stack()
    await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check', confirmedByUserId: s.userId })
    expect(await voidWhatBounced(s.txnId)).toBe(false)                 // still pending at the bank, not voided
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [s.rentId])).rows[0].status).toBe('settled')
    expect(await voidWhatBounced(randomUUID())).toBe(false)            // no such line
    // A money-in loan match the bank voided is not a deposit matched to income (bankMoneyOut releases it).
    const loanLine = (await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status, bank_status, matched_kind)
       VALUES ($1, $2, $3, '2026-09-08', 5000, 'LOAN PROCEEDS', 'matched', 'void', 'loan_funding') RETURNING id`,
      [s.connectionId, s.landlordId, `loan_${randomUUID().slice(0, 8)}`])).rows[0].id
    expect(await voidWhatBounced(loanLine)).toBe(false)
    expect((await db.query(`SELECT status FROM bank_transactions WHERE id = $1`, [loanLine])).rows[0].status).toBe('matched')
    // 10/13 review: a deposit tied to a receipt the office logged by hand stays as it is (GAM cannot
    // take a desk payment back yet) — the owner is told instead, as before.
    const deskLine = (await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status, bank_status, auto_settle_undo)
       VALUES ($1, $2, $3, '2026-09-09', 500, 'BRANCH DEPOSIT', 'matched', 'void', $4::jsonb) RETURNING id`,
      [s.connectionId, s.landlordId, `desk_${randomUUID().slice(0, 8)}`,
       JSON.stringify({ version: 1, kind: 'recorded_deposit', receiptId: randomUUID() })])).rows[0].id
    expect(await voidWhatBounced(deskLine)).toBe(false)
    expect((await db.query(`SELECT status, auto_settle_undo->>'kind' AS kind FROM bank_transactions WHERE id = $1`, [deskLine])).rows[0])
      .toEqual({ status: 'matched', kind: 'recorded_deposit' })
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [s.rentId])).rows[0].status).toBe('settled')
  })
})
