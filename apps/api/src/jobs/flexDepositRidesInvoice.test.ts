/**
 * 10/30 (Nic) — A DEPOSIT INSTALLMENT RIDES THE NEXT INVOICE.
 *
 *   "It needs to ride the next invoice... if a landlord allows mid-month
 *    move-ins and their bill is due the 15th each month, it needs to ride that
 *    bill."
 *
 * FlexDeposit installments 2..N used to run on an ACH pull of their own, dated
 * five days before a due date computed from the month the resident ENROLLED.
 * So the bank pull correlated with the signup day and nothing else: sign up on
 * the 20th and a debit landed on the 26th forever, in months the resident had
 * already been invoiced for.
 *
 * Heather Miller's plan found it on 10/29 — her move-in bill kept the FULL $450
 * deposit because she enrolled the day after it was written, installment 1 was
 * linked to nothing, and the unfunded-looking plan then offered a pay-ahead
 * that opened a live $450 ACH debit nobody had authorised.
 *
 * These lock in the replacement: no date arithmetic anywhere. The next
 * installment that needs funding rides the next invoice the lease generates,
 * one per bill, on whatever day that landlord bills.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { backfillInvoices } from './invoiceGeneration'
import { processFlexDepositInstallmentDue } from '../services/flexDeposit'

beforeEach(async () => { await cleanupAllSchema() })

const START = '2027-03-01'

/** A lease with a FlexDeposit plan: $450 over 4 x $112.50, fee $67. */
async function planOn(opts: {
  rentDueDay: number
  startDate?: string
  installmentDueDates?: string[]
}) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const leaseId = await seedLease(client, {
      unitId, landlordId, rentAmount: 450, startDate: opts.startDate ?? START })
    await seedLeaseTenant(client, { leaseId, tenantId })
    await client.query(
      `UPDATE leases SET rent_due_day = $2, needs_review = false WHERE id = $1`,
      [leaseId, opts.rentDueDay])

    const dep = await client.query<{ id: string }>(
      `INSERT INTO security_deposits
         (unit_id, lease_id, tenant_id, total_amount, collected_amount, status,
          held_by, flex_deposit_enabled, flex_deposit_plan_status,
          installment_count, installment_amount, installments_paid,
          installments_remaining, flex_deposit_service_fee)
       VALUES ($1, $2, $3, 450.00, 0.00, 'pending', 'gam_escrow', TRUE, 'active',
               4, 112.50, 0, 4, 67.00)
       RETURNING id`,
      [unitId, leaseId, tenantId])
    const depositId = dep.rows[0].id

    const dues = opts.installmentDueDates
      ?? ['2027-03-01', '2027-04-01', '2027-05-01', '2027-06-01']
    for (let n = 1; n <= 4; n++) {
      await client.query(
        `INSERT INTO flex_deposit_installments
           (security_deposit_id, tenant_id, installment_number, installment_count,
            amount, due_date, status)
         VALUES ($1, $2, $3, 4, 112.50, $4, 'pending')`,
        [depositId, tenantId, n, dues[n - 1]])
    }
    await client.query('COMMIT')
    return { leaseId, depositId, tenantId, unitId, landlordId, propertyId }
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e }
  finally { client.release() }
}

/** Deposit lines actually billed, by the invoice due date they landed on. */
async function depositLines(leaseId: string) {
  const r = await db.query<{ d: string; amount: string; n: string | null }>(
    `SELECT to_char(p.due_date,'YYYY-MM-DD') AS d, p.amount::text,
            i.installment_number::text AS n
       FROM payments p
       LEFT JOIN flex_deposit_installments i ON i.payment_id = p.id
      WHERE p.lease_id = $1 AND p.type = 'deposit' AND p.status <> 'voided'
      ORDER BY p.due_date, p.created_at`, [leaseId])
  return r.rows.map(x => ({ due: x.d, amount: Number(x.amount), installment: x.n ? Number(x.n) : null }))
}

async function installments(depositId: string) {
  const r = await db.query<{
    n: number; due: string; status: string; linked: boolean
    primary_pull_date: string | null; retry_pull_date: string | null
  }>(
    `SELECT installment_number AS n, to_char(due_date,'YYYY-MM-DD') AS due, status,
            (payment_id IS NOT NULL) AS linked, primary_pull_date, retry_pull_date
       FROM flex_deposit_installments
      WHERE security_deposit_id = $1 ORDER BY installment_number`, [depositId])
  return r.rows
}

describe('an installment rides the next invoice, one per bill', () => {
  it('bills installments 2, 3 and 4 on the next three invoices in order', async () => {
    const s = await planOn({ rentDueDay: 1 })
    await backfillInvoices({ from: '2027-03-01', to: '2027-06-30', leaseId: s.leaseId })

    expect(await depositLines(s.leaseId)).toEqual([
      { due: '2027-04-01', amount: 112.5, installment: 2 },
      { due: '2027-05-01', amount: 112.5, installment: 3 },
      { due: '2027-06-01', amount: 112.5, installment: 4 },
    ])
  })

  it('never bills installment 1 — that one rides the move-in invoice', async () => {
    const s = await planOn({ rentDueDay: 1 })
    await backfillInvoices({ from: '2027-03-01', to: '2027-06-30', leaseId: s.leaseId })
    const inst = await installments(s.depositId)
    expect(inst[0].n).toBe(1)
    expect(inst[0].linked).toBe(false)
  })

  it('stamps the displayed due date from the bill it landed on, not a guess', async () => {
    // The plan was written with 1st-of-month guesses; this landlord bills the 15th.
    const s = await planOn({ rentDueDay: 15 })
    await backfillInvoices({ from: '2027-03-01', to: '2027-06-30', leaseId: s.leaseId })

    // This resident has no move-in invoice (an existing tenancy being taken
    // onto the platform), so the start month bills too and the installments
    // ride the first three bills there are. Which months they are is not the
    // point -- the point is that every date is the LANDLORD's billing day, and
    // not one of them is the 1st the plan was written with.
    const lines = await depositLines(s.leaseId)
    expect(lines.map(l => l.due)).toEqual(['2027-03-15', '2027-04-15', '2027-05-15'])
    expect(lines.every(l => l.due.endsWith('-15'))).toBe(true)

    // and the schedule the resident sees now says the 15th too
    const inst = await installments(s.depositId)
    expect(inst.filter(i => i.linked).map(i => i.due))
      .toEqual(['2027-03-15', '2027-04-15', '2027-05-15'])
  })

  it('puts no more than one installment on a single invoice', async () => {
    const s = await planOn({ rentDueDay: 1 })
    await backfillInvoices({ from: '2027-03-01', to: '2027-04-30', leaseId: s.leaseId })
    const lines = await depositLines(s.leaseId)
    expect(lines).toHaveLength(1)
    expect(lines[0].installment).toBe(2)
  })

  it('is idempotent — a re-run does not add a second line to the same bill', async () => {
    const s = await planOn({ rentDueDay: 1 })
    await backfillInvoices({ from: '2027-03-01', to: '2027-04-30', leaseId: s.leaseId })
    await backfillInvoices({ from: '2027-03-01', to: '2027-04-30', leaseId: s.leaseId })
    expect(await depositLines(s.leaseId)).toHaveLength(1)
  })
})

describe('what the invoice refuses to bill', () => {
  it('skips an installment already sitting on a live unpaid bill', async () => {
    const s = await planOn({ rentDueDay: 1 })
    await backfillInvoices({ from: '2027-03-01', to: '2027-04-30', leaseId: s.leaseId })
    // installment 2 is now billed and pending. The next invoice takes 3, not 2.
    await backfillInvoices({ from: '2027-03-01', to: '2027-05-31', leaseId: s.leaseId })
    expect((await depositLines(s.leaseId)).map(l => l.installment)).toEqual([2, 3])
  })

  it('re-bills an installment whose payment failed, instead of moving on', async () => {
    const s = await planOn({ rentDueDay: 1 })
    await backfillInvoices({ from: '2027-03-01', to: '2027-04-30', leaseId: s.leaseId })

    // Its bank returned it: the payment is terminal and the row went 'missed'.
    await db.query(
      `UPDATE payments SET status = 'returned'
        WHERE id = (SELECT payment_id FROM flex_deposit_installments
                     WHERE security_deposit_id = $1 AND installment_number = 2)`,
      [s.depositId])
    await db.query(
      `UPDATE flex_deposit_installments SET status = 'missed'
        WHERE security_deposit_id = $1 AND installment_number = 2`, [s.depositId])

    await backfillInvoices({ from: '2027-03-01', to: '2027-05-31', leaseId: s.leaseId })
    // installment 2 comes back on the May bill; 3 waits its turn.
    const lines = await depositLines(s.leaseId)
    expect(lines.filter(l => l.due === '2027-05-01').map(l => l.installment)).toEqual([2])
  })

  it('bills nothing more once the deposit is funded, however it got funded', async () => {
    const s = await planOn({ rentDueDay: 1 })
    // GAM-first routing satisfied the whole deposit out of other money.
    await db.query(
      `UPDATE security_deposits SET collected_amount = total_amount WHERE id = $1`,
      [s.depositId])
    await backfillInvoices({ from: '2027-03-01', to: '2027-06-30', leaseId: s.leaseId })
    expect(await depositLines(s.leaseId)).toEqual([])
  })

  it('bills nothing for a plan that is no longer active', async () => {
    const s = await planOn({ rentDueDay: 1 })
    await db.query(
      `UPDATE security_deposits SET flex_deposit_plan_status = 'completed' WHERE id = $1`,
      [s.depositId])
    await backfillInvoices({ from: '2027-03-01', to: '2027-06-30', leaseId: s.leaseId })
    expect(await depositLines(s.leaseId)).toEqual([])
  })
})

describe('nothing debits a bank on a schedule of its own any more', () => {
  it('writes no pull dates when an installment is billed', async () => {
    const s = await planOn({ rentDueDay: 1 })
    await backfillInvoices({ from: '2027-03-01', to: '2027-06-30', leaseId: s.leaseId })
    for (const i of await installments(s.depositId)) {
      expect(i.primary_pull_date).toBeNull()
      expect(i.retry_pull_date).toBeNull()
    }
  })

  // The guard that matters: a stale scheduler entry, an operator script or an
  // older deploy must not be able to start pulling banks again.
  it('the retired installment cron scans nothing and charges nobody', async () => {
    const s = await planOn({ rentDueDay: 1 })
    // Even handed rows that look exactly like the old cron's candidates.
    await db.query(
      `UPDATE flex_deposit_installments
          SET primary_pull_date = CURRENT_DATE - 1, retry_pull_date = CURRENT_DATE
        WHERE security_deposit_id = $1 AND installment_number > 1`, [s.depositId])

    const out = await processFlexDepositInstallmentDue(new Date('2027-04-02T12:00:00Z'))
    expect(out).toEqual({ candidates_scanned: 0, pulls_initiated: 0, errors: 0 })

    // and no deposit charge appeared from it
    expect(await depositLines(s.leaseId)).toEqual([])
  })
})
