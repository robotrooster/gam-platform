/**
 * S624 — confirming a bank deposit against the charges it paid.
 *
 * The matcher and the backdating math are pinned in their own files. This one
 * checks the promises the software actually has to KEEP for a cash-paying
 * tenant: the payment lands on the date the money moved, the late fees that
 * accrued while it was in transit come off, a fee already paid comes back as a
 * credit rather than vanishing, and one deposit can never settle rent twice.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// A bank pull a deposit replaces is canceled at Stripe after the commit —
// mocked; nothing reaches Stripe.
const stripeMocks = vi.hoisted(() => ({
  paymentIntentsCancel: vi.fn(async (id: string) => ({ id, status: 'canceled' })),
}))
vi.mock('../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getStripe: () => ({ paymentIntents: { cancel: stripeMocks.paymentIntentsCancel } }) }
})

import { db, getClient } from '../db'
import {
  confirmDepositMatch, pendingDepositRefusal, alertMatchedDepositVoided,
  LANDLORD_CONFIRM_ACCEPTS_PENDING_DEPOSITS, undoDepositMatch,
} from './bankDepositConfirm'
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
  rent?: number; postedDate?: string; declaredDate?: string | null; deposit?: number; declaredAmount?: number
} = {}): Promise<Stack & { declarationId: string | null }> {
  const rent = opts.rent ?? 250
  const deposit = opts.deposit ?? rent
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
      [conn.id, landlordId, randomUUID(), posted, deposit.toFixed(2)])).rows[0]

    let declarationId: string | null = null
    if (opts.declaredDate) {
      declarationId = (await client.query(
        `INSERT INTO tenant_declared_deposits
           (tenant_id, lease_id, landlord_id, amount, declared_date, method)
         VALUES ($1,$2,$3,$4,$5::date,'check') RETURNING id`,
        [tenantId, leaseId, landlordId, (opts.declaredAmount ?? deposit).toFixed(2), opts.declaredDate])).rows[0].id
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

  it('charges nothing for cash (S654), and marks the bank row matched', async () => {
    const s = await buildStack()
    // A prior settled rent, so this is not the tenant's first payment.
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type,
                             amount, status, due_date, entry_description, settled_at)
       VALUES ($1,$2,$3,$4,'rent',250,'settled','2026-08-01','RENT',NOW())`,
      [s.unitId, s.leaseId, s.tenantId, s.landlordId])

    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash',
    })
    // S654 (Nic, DIRECTIVE): "Paying cash or check is free." No fee row, and
    // the result carries no fee field — there is nothing to report.
    expect(r).not.toHaveProperty('feeBilledTo')
    const feeRows = (await db.query(
      `SELECT amount::float AS amount FROM payments
        WHERE lease_id=$1 AND type='fee'`, [s.leaseId])).rows
    expect(feeRows).toHaveLength(0)

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

  // S655: only a deposit still in review settles rent. A deposit already filed
  // as income is in the books once — settling rent off it too counts it twice.
  it('refuses a deposit already filed as income', async () => {
    const s = await buildStack()
    await db.query(`UPDATE bank_transactions SET status='categorized' WHERE id=$1`, [s.txnId])
    await expect(confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash' }))
      .rejects.toThrow(/already filed as income/)
    expect((await rentRow(s.rentId)).status).toBe('pending')
  })

  // S655 review: the income it booked is what counts, not the status — a row a
  // sync race once put back in review still has its income on file.
  it('refuses a deposit that already booked income, even back in review', async () => {
    const s = await buildStack()
    const inc = (await db.query(
      `INSERT INTO landlord_other_income (landlord_id, category, amount, income_date)
       SELECT landlord_id, 'other', amount, posted_date FROM bank_transactions WHERE id = $1 RETURNING id`,
      [s.txnId])).rows[0].id
    await db.query(`UPDATE bank_transactions SET landlord_other_income_id = $2 WHERE id = $1`, [s.txnId, inc])
    await expect(confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash' }))
      .rejects.toThrow(/already filed as income/)
    expect((await rentRow(s.rentId)).status).toBe('pending')
  })

  it('refuses a hidden copy from an earlier link to the same bank', async () => {
    const s = await buildStack()
    const kept = (await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, status)
       SELECT bank_connection_id, landlord_id, $2, posted_date, amount, 'needs_review'
         FROM bank_transactions WHERE id = $1 RETURNING id`, [s.txnId, randomUUID()])).rows[0].id
    await db.query(
      `UPDATE bank_transactions SET status='ignored', ignored_reason='duplicate', duplicate_of_id=$2 WHERE id=$1`,
      [s.txnId, kept])
    await expect(confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash' }))
      .rejects.toThrow(/hidden from review/)
    expect((await rentRow(s.rentId)).status).toBe('pending')
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

// ── S655 (money plan §3, the bank-deposit row; Step 9) ───────────────────────

/** Another open line on the same lease (and invoice, unless told otherwise). */
async function addLine(s: Stack, o: {
  type?: string; amount: number; due?: string; entry?: string; owner?: string
  status?: string; intent?: string | null; invoice?: string | null
}): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                           due_date, entry_description, revenue_owner, stripe_payment_intent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12) RETURNING id`,
    [o.invoice === undefined ? s.invoiceId : o.invoice, s.unitId, s.leaseId, s.tenantId, s.landlordId,
     o.type ?? 'utility', o.amount.toFixed(2), o.status ?? 'pending', o.due ?? '2026-09-01',
     o.entry ?? 'UTILITY', o.owner ?? 'landlord', o.intent ?? null])).rows[0].id
}

describe('S655: a deposit is new money for one household, never more than it pays', () => {
  it('bug 2: a deposit match spends no credit', async () => {
    const s = await buildStack()
    const issued = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason)
       VALUES ($1,$2,$3,100,100,'goodwill','a goodwill credit') RETURNING id`,
      [s.landlordId, s.tenantId, s.leaseId])).rows[0].id
    const ahead = (await db.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at)
       VALUES ($1,$2,40,40,'landlord',NOW()) RETURNING id`, [s.leaseId, s.tenantId])).rows[0].id

    await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check' })

    expect((await rentRow(s.rentId)).status).toBe('settled')
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM credit_uses`)).rows[0].n).toBe(0)
    expect(Number((await db.query(`SELECT amount_remaining FROM tenant_credits WHERE id=$1`, [issued])).rows[0].amount_remaining)).toBe(100)
    expect(Number((await db.query(`SELECT amount_remaining FROM lease_prepaid_credits WHERE id=$1`, [ahead])).rows[0].amount_remaining)).toBe(40)
    expect(Number((await db.query(`SELECT issued_credit_amount FROM payments WHERE id=$1`, [s.rentId])).rows[0].issued_credit_amount)).toBe(0)
  })

  it('refuses lines totaling more than the deposit', async () => {
    const s = await buildStack()                       // $250 deposit, $250 rent
    const water = await addLine(s, { amount: 40 })
    await expect(confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId, water], method: 'cash' }))
      .rejects.toThrow(/come to \$290\.00, more than this \$250\.00 deposit/)
    expect((await rentRow(s.rentId)).status).toBe('pending')
    expect((await rentRow(water)).status).toBe('pending')
    expect((await db.query(`SELECT status FROM bank_transactions WHERE id=$1`, [s.txnId])).rows[0].status).toBe('needs_review')
  })

  it('a short deposit reports covers $X of $Y owed', async () => {
    const s = await buildStack()
    const home = await addLine(s, { type: 'home_payment', entry: 'HOMEPMT', amount: 100 })
    const r = await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash' })
    expect(r).toMatchObject({ amountApplied: 250, owedBefore: 350, paidAhead: 0, coverage: 'covers $250.00 of $350.00 owed' })
    expect((await rentRow(home)).status).toBe('pending')
  })

  it('the excess becomes landlord-funded paid-ahead dated the deposit day', async () => {
    const s = await buildStack({ deposit: 300, postedDate: '2026-09-07' })
    const r = await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'money_order' })
    expect(r).toMatchObject({ amountApplied: 250, paidAhead: 50, coverage: null })

    const credit = (await db.query(
      `SELECT amount_original::float AS amount, amount_remaining::float AS remaining, funded_by,
              to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS received_on, source_remittance_id
         FROM lease_prepaid_credits WHERE lease_id=$1`, [s.leaseId])).rows
    expect(credit).toHaveLength(1)
    expect(credit[0]).toMatchObject({ amount: 50, remaining: 50, funded_by: 'landlord', received_on: '2026-09-07' })
    expect(credit[0].source_remittance_id).toBe(r.receiptId)
    expect(r.paidAheadCreditId).toBeTruthy()
  })

  it('every deposit writes one receipt with no gross amount, and an application per line it paid', async () => {
    const s = await buildStack({ deposit: 300 })
    const r = await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check' })
    const rem = (await db.query(
      `SELECT amount::float AS amount, applied_amount::float AS applied, unapplied_amount::float AS unapplied,
              gross_amount, processing_fee_amount::float AS fee, payment_method, status, tenant_id
         FROM tenant_remittances WHERE id=$1`, [r.receiptId])).rows[0]
    expect(rem).toMatchObject({ amount: 300, applied: 250, unapplied: 50, gross_amount: null, fee: 0,
                                payment_method: 'check', status: 'settled', tenant_id: s.tenantId })
    const apps = (await db.query(
      `SELECT payment_id, amount_applied::float AS amount FROM remittance_applications WHERE remittance_id=$1`,
      [r.receiptId])).rows
    expect(apps).toEqual([{ payment_id: s.rentId, amount: 250 }])
    // Paid outside Stripe: the row says how, so it is never read as GAM-held money.
    const row = (await db.query(
      `SELECT p.manual_method, p.platform_held, vm.gam_held_part::float AS gam_held
         FROM payments p JOIN v_payment_money vm ON vm.payment_id = p.id WHERE p.id=$1`, [s.rentId])).rows[0]
    expect(row).toMatchObject({ manual_method: 'check', platform_held: false, gam_held: 0 })
  })

  it('a late fee in flight is never zeroed', async () => {
    const s = await buildStack({ postedDate: '2026-09-07', declaredDate: '2026-09-04' })
    const clearing = await addLine(s, { type: 'late_fee', entry: 'LATEFEE', amount: 5, due: '2026-09-06',
                                        status: 'processing', intent: 'pi_fee_clearing' })
    const onItsWay = await addLine(s, { type: 'late_fee', entry: 'LATEFEE', amount: 5, due: '2026-09-07',
                                        status: 'pending', intent: 'pi_fee_on_its_way' })
    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check', declarationId: s.declarationId })
    expect(r.lateFeesUnbilled).toBe(0)
    for (const id of [clearing, onItsWay]) {
      const f = (await db.query(`SELECT amount::float AS amount, status FROM payments WHERE id=$1`, [id])).rows[0]
      expect(f.amount).toBe(5)
      expect(f.status).not.toBe('settled')
    }
  })

  it('a short deposit leaves the late fees an unpaid line still earned', async () => {
    const s = await buildStack({ postedDate: '2026-09-07', declaredDate: '2026-09-04' })
    const home = await addLine(s, { type: 'home_payment', entry: 'HOMEPMT', amount: 100 })
    await addLateFee(s, '2026-09-06', 5)
    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check', declarationId: s.declarationId })
    expect(r.lateFeesUnbilled).toBe(0)
    const fee = (await db.query(
      `SELECT amount::float AS amount, status FROM payments WHERE invoice_id=$1 AND type='late_fee'`, [s.invoiceId])).rows[0]
    expect(fee).toMatchObject({ amount: 5, status: 'pending' })
    expect((await rentRow(home)).status).toBe('pending')
  })

  it('the late-fee refund credit settles nothing inside the confirm — the whole-bill check pays what it covers afterwards', async () => {
    const s = await buildStack({ postedDate: '2026-09-07', declaredDate: '2026-09-04' })
    await addLateFee(s, '2026-09-06', 5, true)          // already paid: comes back as a $5 credit
    // October's water, on its own bill, owed now: the $5 credit covers it whole.
    const octWater = await addLine(s, { amount: 5, due: '2026-10-01', invoice: null })
    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check', declarationId: s.declarationId })
    expect(r.lateFeesRefunded).toBe(5)
    const uses = (await db.query(
      `SELECT u.source, u.status, u.payment_id FROM credit_uses u
         JOIN tenant_credits tc ON tc.id = u.tenant_credit_id
        WHERE tc.category = 'late_fee_refund'`)).rows
    // Spent only by the whole-bill check, after the confirm committed.
    expect(uses).toEqual([{ source: 'whole_bill', status: 'applied', payment_id: octWater }])
    expect((await rentRow(octWater)).status).toBe('settled')
  })

  it('a matching tenant report is confirmed even when the landlord’s screen does not send it, and its date governs', async () => {
    const s = await buildStack({ postedDate: '2026-09-07', declaredDate: '2026-09-04' })
    const r = await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check' })
    expect(r.effectivePaidDate).toBe('2026-09-04')
    expect(r.declarationId).toBe(s.declarationId)
    const d = (await db.query(`SELECT status, bank_transaction_id FROM tenant_declared_deposits WHERE id=$1`,
      [s.declarationId])).rows[0]
    expect(d).toMatchObject({ status: 'confirmed', bank_transaction_id: s.txnId })
  })

  it('a report for a different amount cannot date this deposit', async () => {
    const s = await buildStack({ postedDate: '2026-09-07', declaredDate: '2026-09-04', declaredAmount: 300 })
    await expect(confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check', declarationId: s.declarationId }))
      .rejects.toThrow(/That report is for \$300\.00, not this \$250\.00 deposit/)
    // Without it, the bank's date governs and the report is left alone.
    const r = await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check' })
    expect(r.effectivePaidDate).toBe('2026-09-07')
    expect((await db.query(`SELECT status FROM tenant_declared_deposits WHERE id=$1`, [s.declarationId])).rows[0].status)
      .toBe('pending')
  })

  it('refuses GAM’s own charges, work-trade lines and lines whose money is on its way', async () => {
    const s = await buildStack()
    const gamFee = await addLine(s, { type: 'fee', entry: 'RETURNFEE', owner: 'gam', amount: 4 })
    await expect(confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [gamFee], method: 'cash' }))
      .rejects.toThrow(/GAM’s own charge/)
    const clearing = await addLine(s, { amount: 10, status: 'processing', intent: 'pi_clearing' })
    await expect(confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [clearing], method: 'cash' }))
      .rejects.toThrow(/already on its way/)
    await db.query(`UPDATE payments SET work_trade_suspended_at = NOW() WHERE id=$1`, [s.rentId])
    await expect(confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash' }))
      .rejects.toThrow(/covered by work trade/)
  })

  it('refuses charges from two households in one deposit', async () => {
    const s = await buildStack({ deposit: 500 })
    const client = await getClient()
    let otherRent: string
    try {
      const other = await seedTenant(client)
      const unit2 = await seedUnit(client, {
        propertyId: (await client.query(`SELECT property_id FROM units WHERE id=$1`, [s.unitId])).rows[0].property_id,
        landlordId: s.landlordId, rentAmount: 250 })
      const lease2 = await seedLease(client, { unitId: unit2, landlordId: s.landlordId, rentAmount: 250 })
      await seedLeaseTenant(client, { leaseId: lease2, tenantId: other, role: 'primary' })
      otherRent = (await client.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,'rent',250,'pending','2026-09-01','RENT') RETURNING id`,
        [unit2, lease2, other, s.landlordId])).rows[0].id
    } finally { client.release() }
    await expect(confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId, otherRent], method: 'cash' }))
      .rejects.toThrow(/more than one household/)
    expect((await rentRow(s.rentId)).status).toBe('pending')
  })

  it('settles a home payment and the old carried balance like any bank-payable line', async () => {
    const s = await buildStack({ deposit: 450 })
    const home = await addLine(s, { type: 'home_payment', entry: 'HOMEPMT', amount: 100 })
    const carried = await addLine(s, { type: 'carried_balance', entry: 'BALANCE', amount: 100, invoice: null, due: '2026-01-01' })
    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId, home, carried], method: 'cash' })
    expect(r.settledChargeIds.sort()).toEqual([s.rentId, home, carried].sort())
    for (const id of [s.rentId, home, carried]) expect((await rentRow(id)).status).toBe('settled')
  })

  // Steps 9 and 12 (money plan leftovers): every settle that is not Stripe and
  // not credit marks how it was paid. A prepaid move-in box that once failed on
  // a card and is then paid by a bank deposit is money the LANDLORD holds.
  it('a bank-matched move-in box over an old failed intent becomes landlord-funded paid-ahead money', async () => {
    const s = await buildStack({ deposit: 300 })
    const fee = (await db.query<{ id: string }>(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, money_kind, is_refundable)
       VALUES ($1,'other_fee',300,'move_in','prepaid',FALSE) RETURNING id`, [s.leaseId])).rows[0].id
    const box = (await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                             entry_description, revenue_owner, lease_fee_id, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,$5,'fee',300,'failed','2026-09-01','OTHERFEE','held',$6,'pi_old_card') RETURNING id`,
      [s.invoiceId, s.unitId, s.leaseId, s.tenantId, s.landlordId, fee])).rows[0].id
    await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [box], method: 'check' })
    const row = (await db.query(`SELECT status, manual_method, platform_held FROM payments WHERE id=$1`, [box])).rows[0]
    expect(row).toMatchObject({ status: 'settled', manual_method: 'check', platform_held: false })
    const credit = (await db.query(
      `SELECT funded_by, amount_original::float AS amount FROM lease_prepaid_credits WHERE source_payment_id=$1`, [box])).rows
    expect(credit).toEqual([{ funded_by: 'landlord', amount: 300 }])
  })

  it('writes down everything it changed, so the match can be undone exactly', async () => {
    const s = await buildStack({ postedDate: '2026-09-07', declaredDate: '2026-09-04', deposit: 260 })
    await addLateFee(s, '2026-09-06', 5)                   // never owed: zeroed
    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check', declarationId: s.declarationId })
    const undo = (await db.query(`SELECT auto_settle_undo FROM bank_transactions WHERE id=$1`, [s.txnId])).rows[0].auto_settle_undo
    expect(undo).toMatchObject({
      version: 1,
      rows: [{ paymentId: s.rentId, priorStatus: 'pending', money: 250 }],
      lateFeesZeroed: [{ priorAmount: 5, priorStatus: 'pending' }],
      receiptId: r.receiptId,
      paidAheadCreditId: r.paidAheadCreditId,
      declarationId: s.declarationId,
    })
    expect(r.paidAhead).toBe(10)
    expect(undo.creditEventIds.length).toBeGreaterThan(0)
  })
})

// ── Step 9 review fixes ──────────────────────────────────────────────────────

const lateFees = async (invoiceId: string) => (await db.query(
  `SELECT to_char(due_date,'YYYY-MM-DD') AS tick, amount::float AS amount
     FROM payments WHERE invoice_id=$1 AND type='late_fee' ORDER BY due_date`, [invoiceId])).rows

describe('Step 9 review: late fees follow the day each line was really paid', () => {
  it('a line the desk recorded late keeps the late fees its own lateness earned; only fees after it was paid come back (desk first, then the match)', async () => {
    const s = await buildStack({ postedDate: '2026-09-07', declaredDate: '2026-09-04' })
    const water = await addLine(s, { amount: 40 })
    // The desk took the water on 9/10: after the 9/6 and 9/8 fees, before the 9/12 one.
    await db.query(
      `UPDATE payments SET status='settled', settled_at='2026-09-10T18:00:00Z', manual_method='cash' WHERE id=$1`, [water])
    await addLateFee(s, '2026-09-06', 5)
    await addLateFee(s, '2026-09-08', 5)
    await addLateFee(s, '2026-09-12', 5)
    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check', declarationId: s.declarationId })
    expect(r.lateFeesUnbilled).toBe(5)
    expect(await lateFees(s.invoiceId)).toEqual([
      { tick: '2026-09-06', amount: 5 }, { tick: '2026-09-08', amount: 5 }, { tick: '2026-09-12', amount: 0 },
    ])
  })

  it('matched while another line is still open, every late fee so far stands — the same rule in the other order (match first, then the desk)', async () => {
    const s = await buildStack({ postedDate: '2026-09-07', declaredDate: '2026-09-04' })
    const water = await addLine(s, { amount: 40 })
    await addLateFee(s, '2026-09-06', 5)
    await addLateFee(s, '2026-09-08', 5)
    await addLateFee(s, '2026-09-12', 5)
    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check', declarationId: s.declarationId })
    expect(r.lateFeesUnbilled).toBe(0)
    // The water is taken at the desk only now — after every one of those fees, so each was earned.
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW(), manual_method='cash' WHERE id=$1`, [water])
    expect(await lateFees(s.invoiceId)).toEqual([
      { tick: '2026-09-06', amount: 5 }, { tick: '2026-09-08', amount: 5 }, { tick: '2026-09-12', amount: 5 },
    ])
  })

  it('a line whose payment is still clearing counts as paid from the day that payment was made', async () => {
    const s = await buildStack({ postedDate: '2026-09-07', declaredDate: '2026-09-04' })
    const water = await addLine(s, { amount: 40, status: 'processing', intent: 'pi_water_clearing' })
    await db.query(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, payment_method,
                                       stripe_payment_intent_id, created_at)
       VALUES ($1,$2,$3,40,40,'ach','pi_water_clearing','2026-09-10T18:00:00Z')`,
      [s.tenantId, s.leaseId, s.landlordId])
    await addLateFee(s, '2026-09-08', 5)
    await addLateFee(s, '2026-09-12', 5)
    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check', declarationId: s.declarationId })
    expect(r.lateFeesUnbilled).toBe(5)
    expect(await lateFees(s.invoiceId)).toEqual([{ tick: '2026-09-08', amount: 5 }, { tick: '2026-09-12', amount: 0 }])
    expect((await rentRow(water)).status).toBe('processing')
  })

  // The late-fee engine (jobs/lateFees) charges while ANY line on the invoice
  // is unpaid, GAM's own included; the reversal follows the engine. Whether
  // GAM's line should drive the landlord's late fee is the engine's rule.
  it('GAM’s own unpaid charge on the bill keeps the late fees, exactly as the late-fee engine charged them', async () => {
    const s = await buildStack({ postedDate: '2026-09-07', declaredDate: '2026-09-04' })
    await addLine(s, { type: 'fee', entry: 'RETURNFEE', owner: 'gam', amount: 4 })
    await addLateFee(s, '2026-09-06', 5)
    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check', declarationId: s.declarationId })
    expect(r.lateFeesUnbilled).toBe(0)
    expect(await lateFees(s.invoiceId)).toEqual([{ tick: '2026-09-06', amount: 5 }])
  })

  it('a deposit paying lines on two bills keeps every late-fee refund credit in the undo record', async () => {
    const s = await buildStack({ postedDate: '2026-09-07', declaredDate: '2026-09-04', deposit: 290 })
    await addLateFee(s, '2026-09-06', 5, true)                     // paid: comes back as a credit
    const waterBill = (await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount)
       VALUES ($1,$2,$3,$4,$5,'2026-08-01',0,40) RETURNING id`,
      [s.landlordId, s.tenantId, s.leaseId, s.unitId, `W-${randomUUID().slice(0, 8)}`])).rows[0].id
    const water = await addLine(s, { amount: 40, invoice: waterBill, due: '2026-08-01' })   // August's water, still owed
    await addLateFee({ ...s, invoiceId: waterBill }, '2026-09-07', 5, true)   // paid too, on the other bill

    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId, water], method: 'check', declarationId: s.declarationId })
    expect(r.lateFeesRefunded).toBe(10)
    const credits = (await db.query<{ id: string }>(
      `SELECT id FROM tenant_credits WHERE category='late_fee_refund' ORDER BY id`)).rows.map(x => x.id)
    expect(credits).toHaveLength(2)
    expect([...r.undo.lateFeeRefundCreditIds].sort()).toEqual(credits)
    const saved = (await db.query(`SELECT auto_settle_undo FROM bank_transactions WHERE id=$1`, [s.txnId])).rows[0].auto_settle_undo
    expect([...saved.lateFeeRefundCreditIds].sort()).toEqual(credits)
    expect(saved).not.toHaveProperty('lateFeeRefundCreditId')
  })
})

describe('Step 9 review: the bank’s own word on a deposit', () => {
  it('a deposit the bank voided cannot pay rent', async () => {
    const s = await buildStack()
    await db.query(`UPDATE bank_transactions SET bank_status='void' WHERE id=$1`, [s.txnId])
    await expect(confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash' }))
      .rejects.toThrow(/voided this deposit/)
    expect((await rentRow(s.rentId)).status).toBe('pending')
  })

  it('a deposit still pending at the bank: the landlord’s confirm takes it today — one switch, asked of Nic', async () => {
    expect(LANDLORD_CONFIRM_ACCEPTS_PENDING_DEPOSITS).toBe(true)
    const s = await buildStack()
    await db.query(`UPDATE bank_transactions SET bank_status='pending' WHERE id=$1`, [s.txnId])
    await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash' })
    expect((await rentRow(s.rentId)).status).toBe('settled')
    // Switched off, it is refused in plain words; posted (or stored before the bank's status was kept) never is.
    expect(pendingDepositRefusal('pending', false)).toMatch(/still pending at your bank/)
    expect(pendingDepositRefusal('posted', false)).toBeNull()
    expect(pendingDepositRefusal(null, false)).toBeNull()
  })

  it('a matched deposit the bank later voids is told to the landlord and GAM, by name; the rent stays settled', async () => {
    const s = await buildStack()
    await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'cash' })
    await db.query(`UPDATE bank_transactions SET bank_status='void' WHERE id=$1`, [s.txnId])
    expect(await alertMatchedDepositVoided(s.txnId)).toBe(true)

    const owner = (await db.query(`SELECT user_id FROM landlords WHERE id=$1`, [s.landlordId])).rows[0].user_id
    const n = (await db.query(
      `SELECT title, body FROM notifications WHERE user_id=$1 AND type='bank_deposit_voided'`, [owner])).rows
    expect(n).toHaveLength(1)
    expect(n[0].title).toBe('Your bank voided a deposit that paid rent')
    expect(n[0].body).toContain('$250.00 deposit of 2026-09-07')
    expect(n[0].body).toContain('Test Tenant')
    expect(n[0].body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)        // never an id in the landlord's words
    const admin = (await db.query(
      `SELECT context FROM admin_notifications WHERE category='bank_deposit_voided_after_match'`)).rows
    expect(admin).toHaveLength(1)
    expect(admin[0].context.payment_ids).toEqual([s.rentId])
    expect((await rentRow(s.rentId)).status).toBe('settled')
  })

  it('a deposit that was never matched is nobody’s alert', async () => {
    const s = await buildStack()
    expect(await alertMatchedDepositVoided(s.txnId)).toBe(false)
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category='bank_deposit_voided_after_match'`)).rowCount).toBe(0)
  })
})

describe('Step 9 review: a deposit over a bank payment waiting to retry', () => {
  beforeEach(() => { stripeMocks.paymentIntentsCancel.mockClear() })

  it('replaces the scheduled retry, gives back the credit it set aside, and cancels the old pull after the commit', async () => {
    const s = await buildStack()
    const credit = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason)
       VALUES ($1,$2,$3,50,50,'goodwill','a goodwill credit') RETURNING id`,
      [s.landlordId, s.tenantId, s.leaseId])).rows[0].id
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, payment_method)
       VALUES ($1,$2,$3,200,200,'ach') RETURNING id`, [s.tenantId, s.leaseId, s.landlordId])).rows[0].id
    // The autopay pull set $50 of credit aside, bounced, and is set to retry.
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, remittance_id, lease_id, amount, billing_month, source, status)
       VALUES ($1,$2,$3,$4,50,'2026-09-01','autopay','held')`, [credit, s.rentId, rem, s.leaseId])
    await db.query(`UPDATE tenant_remittances SET stripe_payment_intent_id='pi_retry_pull' WHERE id=$1`, [rem])
    await db.query(
      `UPDATE payments SET status='failed', stripe_payment_intent_id='pi_retry_pull', next_retry_at=NOW() + interval '3 days'
        WHERE id=$1`, [s.rentId])

    await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check' })

    const row = (await db.query(`SELECT status, next_retry_at FROM payments WHERE id=$1`, [s.rentId])).rows[0]
    expect(row).toEqual({ status: 'settled', next_retry_at: null })
    const use = (await db.query(`SELECT status, release_reason FROM credit_uses WHERE tenant_credit_id=$1`, [credit])).rows
    expect(use).toEqual([{ status: 'released', release_reason: 'superseded' }])
    expect(Number((await db.query(`SELECT amount_remaining FROM tenant_credits WHERE id=$1`, [credit])).rows[0].amount_remaining)).toBe(50)
    expect(stripeMocks.paymentIntentsCancel).toHaveBeenCalledWith('pi_retry_pull')
  })
})

// ── S655 Step 12 (K-C): Undo ─────────────────────────────────────────────────

describe('Step 12: undoing a deposit match', () => {
  /** A $260 deposit for $250 rent, reported on the 4th: a $5 fee zeroed, a paid $5 fee refunded, $10 paid ahead. */
  async function matched() {
    const s = await buildStack({ postedDate: '2026-09-07', declaredDate: '2026-09-04', deposit: 260 })
    await addLateFee(s, '2026-09-06', 5)                   // unpaid, never owed: zeroed
    await addLateFee(s, '2026-09-05', 5, true)             // paid, never owed: refunded as a credit
    const r = await confirmDepositMatch({
      bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check', declarationId: s.declarationId })
    expect(r.lateFeesUnbilled).toBe(5)
    expect(r.lateFeesRefunded).toBe(5)
    expect(r.paidAhead).toBe(10)
    return { s, r }
  }

  it('Undo restores rows, late fees, the refund credit and the excess credit exactly', async () => {
    const { s, r } = await matched()
    const owner = (await db.query(`SELECT user_id FROM landlords WHERE id=$1`, [s.landlordId])).rows[0].user_id
    const res = await undoDepositMatch({ bankTransactionId: s.txnId, landlordId: s.landlordId, undoneBy: owner })
    expect(res).toMatchObject({ kind: 'tenant_deposit', reopenedChargeIds: [s.rentId], lateFeesRestored: 1, declarationId: s.declarationId })

    expect(await rentRow(s.rentId)).toMatchObject({ status: 'pending', settled_on: null, manual_method: null })
    const fees = (await db.query(
      `SELECT to_char(due_date,'YYYY-MM-DD') AS tick, amount::float AS amount, status FROM payments
        WHERE invoice_id=$1 AND type='late_fee' ORDER BY due_date`, [s.invoiceId])).rows
    expect(fees).toEqual([{ tick: '2026-09-05', amount: 5, status: 'settled' }, { tick: '2026-09-06', amount: 5, status: 'pending' }])
    const refund = (await db.query(`SELECT status FROM tenant_credits WHERE id = ANY($1::uuid[])`, [r.undo.lateFeeRefundCreditIds])).rows
    expect(refund).toEqual([{ status: 'void' }])
    const ahead = (await db.query(`SELECT voided_at IS NOT NULL AS voided, amount_remaining::float AS left FROM lease_prepaid_credits WHERE id=$1`,
      [r.paidAheadCreditId])).rows[0]
    expect(ahead).toEqual({ voided: true, left: 10 })
    const alloc = (await db.query(`SELECT reversed_at IS NOT NULL AS reversed, reversed_by FROM bank_deposit_allocations WHERE bank_transaction_id=$1`, [s.txnId])).rows
    expect(alloc).toEqual([{ reversed: true, reversed_by: owner }])
    expect((await db.query(`SELECT status FROM tenant_remittances WHERE id=$1`, [r.receiptId])).rows[0].status).toBe('failed')
    expect((await db.query(`SELECT status, bank_transaction_id FROM tenant_declared_deposits WHERE id=$1`, [s.declarationId])).rows[0])
      .toEqual({ status: 'pending', bank_transaction_id: null })
    const marks = (await db.query(`SELECT id, superseded_by, superseded_reason FROM credit_events WHERE id = ANY($1::uuid[])`,
      [r.undo.creditEventIds])).rows
    expect(marks.length).toBeGreaterThan(0)
    for (const m of marks) expect(m).toMatchObject({ superseded_by: m.id, superseded_reason: 'attestation_invalidated' })
    const txn = (await db.query(`SELECT status, matched_payment_id, auto_settled_at, auto_settle_undo FROM bank_transactions WHERE id=$1`, [s.txnId])).rows[0]
    expect(txn).toMatchObject({ status: 'needs_review', matched_payment_id: null, auto_settled_at: null })
    expect(txn.auto_settle_undo).toMatchObject({ undone: true, undoneBy: owner, was: { receiptId: r.receiptId } })

    // The landlord can match it again, to the right charges this time.
    const again = await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check' })
    expect(again.settledChargeIds).toEqual([s.rentId])
  })

  it('Undo is refused after a later change', async () => {
    // The refund credit was used on a later bill.
    const { s, r } = await matched()
    const oct = (await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',250,'pending','2026-10-01','RENT') RETURNING id`,
      [s.unitId, s.leaseId, s.tenantId, s.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,5,'2026-10-01','desk','applied',now())`, [r.undo.lateFeeRefundCreditIds[0], oct, s.leaseId])
    await expect(undoDepositMatch({ bankTransactionId: s.txnId, landlordId: s.landlordId, undoneBy: null }))
      .rejects.toThrow('The $5.00 late-fee refund credit from this match has already been used (or is set aside for a payment). Nothing was undone — the match stays as it is.')
    expect((await rentRow(s.rentId)).status).toBe('settled')
    expect((await db.query(`SELECT status FROM bank_transactions WHERE id=$1`, [s.txnId])).rows[0].status).toBe('matched')

    // A line it paid was taken back by a reversal since.
    const b = await matched()
    await db.query(`UPDATE payments SET status='returned' WHERE id=$1`, [b.s.rentId])
    await expect(undoDepositMatch({ bankTransactionId: b.s.txnId, landlordId: b.s.landlordId, undoneBy: null }))
      .rejects.toThrow(/no longer paid by this deposit\). Nothing was undone/)
    expect((await db.query(`SELECT status FROM tenant_remittances WHERE id=$1`, [b.r.receiptId])).rows[0].status).toBe('settled')

    // Another company cannot undo it, and a payout match has nothing to undo.
    const c = await matched()
    await expect(undoDepositMatch({ bankTransactionId: c.s.txnId, landlordId: b.s.landlordId, undoneBy: null }))
      .rejects.toThrow('Deposit not found')
  })
})

// ── Step 9 review (fix pass 1): a security deposit paid by bank deposit ──────

describe('Step 9 review: a security deposit paid by bank deposit is on the deposit record', () => {
  /** A $500 security deposit owed (record at $0, landlord-held) and a $500 bank deposit for it. */
  async function securityOwed(o: { heldBy?: 'landlord' | 'gam_escrow' } = {}) {
    const s = await buildStack({ deposit: 500 })
    const depositId = (await db.query<{ id: string }>(
      `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, held_by, status)
       VALUES ($1,$2,$3,500,0,$4,'pending') RETURNING id`,
      [s.unitId, s.leaseId, s.tenantId, o.heldBy ?? 'landlord'])).rows[0].id
    const chargeId = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'deposit',500,'pending','2026-09-01','DEPOSIT') RETURNING id`,
      [s.unitId, s.leaseId, s.tenantId, s.landlordId])).rows[0].id
    return { s, depositId, chargeId }
  }
  const record = async (id: string) => (await db.query(
    `SELECT collected_amount::float AS collected, status FROM security_deposits WHERE id=$1`, [id])).rows[0]

  it('a matched security-deposit charge raises the deposit record, and Undo lowers it by exactly that', async () => {
    const { s, depositId, chargeId } = await securityOwed()
    const r = await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [chargeId], method: 'check' })
    expect(r.settledChargeIds).toEqual([chargeId])
    expect(await record(depositId)).toEqual({ collected: 500, status: 'funded' })
    expect(r.undo.securityDepositRaised).toEqual([{ depositId, amount: 500, priorHeldBy: 'landlord', priorStatus: 'pending' }])

    await undoDepositMatch({ bankTransactionId: s.txnId, landlordId: s.landlordId, undoneBy: null })
    expect(await record(depositId)).toEqual({ collected: 0, status: 'pending' })
    expect((await rentRow(chargeId)).status).toBe('pending')
  })

  // 10/4 (decisions #46.3, Nic, FINAL) — replaces "GAM escrow: a bank-matched
  // security deposit leaves GAM's record as it is … (how such a deposit is
  // handled is Nic's call)". A deposit is held by whoever collected it: paid
  // straight into the landlord's bank, the LANDLORD holds it, whatever was
  // planned at billing.
  it('#46.3: a security deposit planned for GAM but paid into the landlord’s bank is held by the landlord — the record counts it and says so, GAM accrues no interest on it, and GAM gets an information notice', async () => {
    const { s, depositId, chargeId } = await securityOwed({ heldBy: 'gam_escrow' })
    const r = await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [chargeId], method: 'check' })
    expect(r.settledChargeIds).toEqual([chargeId])
    // The money is in the landlord's bank: the record counts it, as the landlord's.
    expect(await record(depositId)).toEqual({ collected: 500, status: 'funded' })
    expect((await db.query(`SELECT held_by FROM security_deposits WHERE id=$1`, [depositId])).rows[0].held_by).toBe('landlord')
    expect(r.undo.securityDepositRaised).toEqual([{ depositId, amount: 500, priorHeldBy: 'gam_escrow', priorStatus: 'pending' }])
    // So GAM accrues no statutory interest on money it never held.
    const { runMonthlyAccrual } = await import('./depositInterest')
    const monthStart = (await db.query(`SELECT to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD') AS m`)).rows[0].m
    const acc = await runMonthlyAccrual(monthStart)
    expect(acc.accrued_count).toBe(0)
    expect((await db.query(
      `SELECT COUNT(*)::int AS n FROM security_deposit_interest_accruals WHERE security_deposit_id=$1`, [depositId])).rows[0].n).toBe(0)
    // GAM is told, for information only — nothing to do by hand.
    const notes = (await db.query(
      `SELECT severity, body, context FROM admin_notifications WHERE category='escrow_deposit_paid_to_landlord'`)).rows
    expect(notes).toHaveLength(1)
    expect(notes[0].severity).toBe('info')
    expect(notes[0].context).toMatchObject({ payment_id: chargeId, security_deposit_id: depositId, amount: 500, held_by: 'landlord' })
    expect(notes[0].body).toMatch(/the landlord holds it/)
    expect(notes[0].body).toMatch(/nothing needs doing/)
  })

  it('GAM escrow: undoing the bank match tells GAM by name, once, that its earlier "paid into the landlord’s bank" notice no longer applies', async () => {
    const { s, depositId, chargeId } = await securityOwed({ heldBy: 'gam_escrow' })
    await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [chargeId], method: 'check' })
    const earlier = (await db.query(
      `SELECT id FROM admin_notifications WHERE category='escrow_deposit_paid_to_landlord'`)).rows
    expect(earlier).toHaveLength(1)
    const res = await undoDepositMatch({ bankTransactionId: s.txnId, landlordId: s.landlordId, undoneBy: null })
    expect(res.reopenedChargeIds).toEqual([chargeId])
    expect((await rentRow(chargeId)).status).toBe('pending')
    expect(await record(depositId)).toEqual({ collected: 0, status: 'pending' })
    // Who holds it goes back to what was planned before the match.
    expect((await db.query(`SELECT held_by FROM security_deposits WHERE id=$1`, [depositId])).rows[0].held_by).toBe('gam_escrow')
    const undone = (await db.query(
      `SELECT body, context FROM admin_notifications WHERE category='escrow_deposit_paid_to_landlord_undone'`)).rows
    expect(undone).toHaveLength(1)
    expect(undone[0].context).toMatchObject({
      earlier_notice_id: earlier[0].id, payment_id: chargeId, security_deposit_id: depositId, bank_transaction_id: s.txnId,
    })
    expect(undone[0].body).toMatch(/no longer applies/)
  })

  it('landlord-held: undoing the bank match sends GAM no escrow notice', async () => {
    const { s, chargeId } = await securityOwed()
    await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [chargeId], method: 'check' })
    await undoDepositMatch({ bankTransactionId: s.txnId, landlordId: s.landlordId, undoneBy: null })
    expect((await db.query(
      `SELECT COUNT(*)::int AS n FROM admin_notifications WHERE category LIKE 'escrow_deposit_paid_to_landlord%'`)).rows[0].n).toBe(0)
  })

  it('a FlexDeposit installment cannot be paid by a bank deposit — refused in plain words, nothing changed', async () => {
    const { s, depositId, chargeId } = await securityOwed({ heldBy: 'gam_escrow' })
    await db.query(`UPDATE security_deposits SET flex_deposit_enabled = TRUE WHERE id=$1`, [depositId])
    await expect(confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [chargeId], method: 'check' }))
      .rejects.toThrow('One of those charges is a FlexDeposit installment — it is paid online to GAM, so a bank deposit can’t pay it. Leave it out.')
    expect((await rentRow(chargeId)).status).toBe('pending')
    expect((await db.query(`SELECT status FROM bank_transactions WHERE id=$1`, [s.txnId])).rows[0].status).toBe('needs_review')
  })

  it('a rent-only match writes nothing about a security deposit', async () => {
    const s = await buildStack()
    const r = await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [s.rentId], method: 'check' })
    expect(r.undo.securityDepositRaised).toBeUndefined()
  })

  it('Undo is refused once the security deposit it paid has been returned at move-out', async () => {
    const { s, depositId, chargeId } = await securityOwed()
    await confirmDepositMatch({ bankTransactionId: s.txnId, chargeIds: [chargeId], method: 'check' })
    await db.query(`UPDATE security_deposits SET status='disbursed', disbursed_at=NOW() WHERE id=$1`, [depositId])
    await expect(undoDepositMatch({ bankTransactionId: s.txnId, landlordId: s.landlordId, undoneBy: null }))
      .rejects.toThrow('The security deposit this deposit paid has already been returned at move-out. Nothing was undone — the match stays as it is.')
    expect(await record(depositId)).toEqual({ collected: 500, status: 'disbursed' })
    expect((await rentRow(chargeId)).status).toBe('settled')
  })
})
