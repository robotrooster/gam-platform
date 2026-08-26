/**
 * S624 — confirming a bank deposit against the charges it paid.
 *
 * The matcher and the backdating maths are pinned in their own files. This one
 * checks the promises the software actually has to KEEP for a cash-paying
 * tenant: the payment lands on the date the money moved, the late fees that
 * accrued while it was in transit come off, a fee already paid comes back as a
 * credit rather than vanishing, and one deposit can never settle rent twice.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { confirmDepositMatch } from './bankDepositConfirm'
import { MANUAL_PAYMENT_FEE } from '@gam/shared'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease,
  seedLeaseTenant,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

interface Stack {
  landlordId: string; tenantId: string; unitId: string; leaseId: string
  invoiceId: string; rentId: string; txnId: string
}

/** Rent due 2026-09-01, $250, unpaid; a $250 deposit posted on the 7th. */
async function buildStack(opts: {
  rent?: number; postedDate?: string; declaredDate?: string | null
} = {}): Promise<Stack & { declarationId: string | null }> {
  const rent = opts.rent ?? 250
  const posted = opts.postedDate ?? '2026-09-07'
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: rent })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: rent })
    await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })

    const inv = (await client.query(
      `INSERT INTO invoices
         (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
          subtotal_rent, total_amount)
       VALUES ($1,$2,$3,$4,$5,'2026-09-01',$6,$6) RETURNING id`,
      [landlordId, tenantId, leaseId, unitId, `D-${randomUUID().slice(0, 8)}`,
       rent.toFixed(2)])).rows[0]

    const rentRow = (await client.query(
      `INSERT INTO payments
         (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount,
          status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'rent',$6,'pending','2026-09-01','RENT') RETURNING id`,
      [inv.id, unitId, leaseId, tenantId, landlordId, rent.toFixed(2)])).rows[0]

    const conn = (await client.query(
      `INSERT INTO bank_connections (landlord_id, provider, status)
       VALUES ($1,'stripe_fc','active') RETURNING id`, [landlordId])).rows[0]
    const txn = (await client.query(
      `INSERT INTO bank_transactions
         (bank_connection_id, landlord_id, external_id, posted_date, amount,
          description, status)
       VALUES ($1,$2,$3,$4::date,$5,'MOBILE DEPOSIT','needs_review') RETURNING id`,
      [conn.id, landlordId, randomUUID(), posted, rent.toFixed(2)])).rows[0]

    let declarationId: string | null = null
    if (opts.declaredDate) {
      declarationId = (await client.query(
        `INSERT INTO tenant_declared_deposits
           (tenant_id, lease_id, landlord_id, amount, declared_date, method)
         VALUES ($1,$2,$3,$4,$5::date,'check') RETURNING id`,
        [tenantId, leaseId, landlordId, rent.toFixed(2), opts.declaredDate])).rows[0].id
    }

    return { landlordId, tenantId, unitId, leaseId,
             invoiceId: inv.id, rentId: rentRow.id, txnId: txn.id, declarationId }
  } finally { client.release() }
}

async function addLateFee(s: Stack, tickDate: string, amount: number, settled = false) {
  await db.query(
    `INSERT INTO payments
       (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount,
        status, due_date, entry_description, settled_at)
     VALUES ($1,$2,$3,$4,$5,'late_fee',$6,$7,$8::date,'LATEFEE',
             CASE WHEN $7='settled' THEN NOW() ELSE NULL END)`,
    [s.invoiceId, s.unitId, s.leaseId, s.tenantId, s.landlordId,
     amount.toFixed(2), settled ? 'settled' : 'pending', tickDate])
}

const rentRow = async (id: string) => (await db.query(
  `SELECT status, to_char(settled_at,'YYYY-MM-DD') AS settled_on, manual_method, notes
     FROM payments WHERE id=$1`, [id])).rows[0]

describe('confirming a deposit', () => {
  it('settles the rent on the BANK’s date, not today', async () => {
    const s = await buildStack({ postedDate: '2026-09-07' })
    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check',
    })
    expect(r.effectivePaidDate).toBe('2026-09-07')
    const row = await rentRow(s.rentId)
    expect(row.status).toBe('settled')
    expect(row.settled_on).toBe('2026-09-07')
    expect(row.manual_method).toBe('check')
    expect(row.notes).toContain('bank deposit posted 2026-09-07')
  })

  // The Friday-afternoon deposit that posts on Monday. THIS is the promise.
  it('a corroborated declaration earns the tenant their own, earlier date', async () => {
    const s = await buildStack({ postedDate: '2026-09-07', declaredDate: '2026-09-04' })
    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check',
      declarationId: s.declarationId,
    })
    expect(r.effectivePaidDate).toBe('2026-09-04')
    expect((await rentRow(s.rentId)).settled_on).toBe('2026-09-04')
    const d = (await db.query(
      `SELECT status, bank_transaction_id FROM tenant_declared_deposits WHERE id=$1`,
      [s.declarationId])).rows[0]
    expect(d.status).toBe('confirmed')
    expect(d.bank_transaction_id).toBe(s.txnId)
  })

  it('removes late fees charged after the rent was really paid', async () => {
    const s = await buildStack({ postedDate: '2026-09-07', declaredDate: '2026-09-04' })
    await addLateFee(s, '2026-09-06', 5)     // after the 4th — never owed
    await addLateFee(s, '2026-09-07', 5)     // after the 4th — never owed

    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check',
      declarationId: s.declarationId,
    })
    expect(r.lateFeesUnbilled).toBe(10)

    const fees = (await db.query(
      `SELECT amount::float AS amount, status, notes FROM payments
        WHERE invoice_id=$1 AND type='late_fee'`, [s.invoiceId])).rows
    expect(fees).toHaveLength(2)                       // nothing deleted
    for (const f of fees) {
      expect(f.amount).toBe(0)
      expect(f.notes).toContain('Reversed')
    }
  })

  it('keeps a late fee that was genuinely earned before payment', async () => {
    const s = await buildStack({ postedDate: '2026-09-20' })
    await addLateFee(s, '2026-09-06', 5)     // earned — rent wasn't paid until the 20th
    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash',
    })
    expect(r.lateFeesUnbilled).toBe(0)
    const fee = (await db.query(
      `SELECT amount::float AS amount, status FROM payments
        WHERE invoice_id=$1 AND type='late_fee'`, [s.invoiceId])).rows[0]
    expect(fee.amount).toBe(5)
    expect(fee.status).toBe('pending')
  })

  // GAM does not erase money that moved — a fee already PAID comes back as a
  // credit, not as a deleted charge.
  it('refunds an already-paid late fee as a credit', async () => {
    const s = await buildStack({ postedDate: '2026-09-07', declaredDate: '2026-09-04' })
    await addLateFee(s, '2026-09-06', 5, true)   // already paid

    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check',
      declarationId: s.declarationId,
    })
    expect(r.lateFeesRefunded).toBe(5)
    expect(r.lateFeesUnbilled).toBe(0)
    const credit = (await db.query(
      `SELECT amount_original::float AS amount, category, reason
         FROM tenant_credits WHERE tenant_id=$1`, [s.tenantId])).rows[0]
    expect(credit.amount).toBe(5)
    expect(credit.category).toBe('late_fee_refund')
    expect(credit.reason).toContain('2026-09-04')
  })

  it('raises the manual-payment fee, and marks the bank row matched', async () => {
    const s = await buildStack()
    // Give the tenant a prior settled rent so this isn't the free first payment.
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type,
                             amount, status, due_date, entry_description, settled_at)
       VALUES ($1,$2,$3,$4,'rent',250,'settled','2026-08-01','RENT',NOW())`,
      [s.unitId, s.leaseId, s.tenantId, s.landlordId])

    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash',
    })
    expect(r.feeBilledTo).toBe('tenant')
    const fee = (await db.query(
      `SELECT amount::float AS amount, entry_description, invoice_id FROM payments
        WHERE lease_id=$1 AND entry_description='MANUALPAY'`, [s.leaseId])).rows[0]
    expect(fee.amount).toBe(MANUAL_PAYMENT_FEE)
    // S620: the fee belongs to NO invoice, so the late-fee engine cannot grow it.
    expect(fee.invoice_id).toBeNull()

    const txn = (await db.query(
      `SELECT status, matched_payment_id FROM bank_transactions WHERE id=$1`,
      [s.txnId])).rows[0]
    expect(txn.status).toBe('matched')
    expect(txn.matched_payment_id).toBe(s.rentId)
  })
})

describe('guards', () => {
  it('will not settle rent twice off one deposit', async () => {
    const s = await buildStack()
    await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash' })
    await expect(confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash' }))
      .rejects.toThrow(/already been matched/)
  })

  it('refuses a charge belonging to another landlord', async () => {
    const a = await buildStack()
    const b = await buildStack()
    await expect(confirmDepositMatch({
      bankTransactionId: a.txnId, chargeIds: [b.rentId], method: 'cash' }))
      .rejects.toThrow(/different landlord/)
  })

  it('refuses while the unit is in eviction mode', async () => {
    const s = await buildStack()
    await db.query(`UPDATE units SET payment_block=TRUE WHERE id=$1`, [s.unitId])
    await expect(confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash' }))
      .rejects.toThrow(/eviction mode/)
  })

  it('refuses an outflow', async () => {
    const s = await buildStack()
    await db.query(`UPDATE bank_transactions SET amount=-250 WHERE id=$1`, [s.txnId])
    await expect(confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash' }))
      .rejects.toThrow(/Only a deposit/)
  })

  it('leaves everything untouched when any charge is bad', async () => {
    const s = await buildStack()
    await expect(confirmDepositMatch({
      bankTransactionId: s.txnId,
      chargeIds: [s.rentId, randomUUID()], method: 'cash' }))
      .rejects.toThrow(/no longer exists/)
    expect((await rentRow(s.rentId)).status).toBe('pending')
    const txn = (await db.query(
      `SELECT status FROM bank_transactions WHERE id=$1`, [s.txnId])).rows[0]
    expect(txn.status).toBe('needs_review')
  })
})
