/**
 * 11/4 (Nic) — A CHARGE THAT RIDES THE NEXT BILL, AND IS ASKED FOR BY NOTHING
 * UNTIL IT DOES.
 *
 *   "That $4 retry fee just needs to go on. It needs to ride the next bill...
 *    Hide it so it doesn't show as outstanding, so the landlord or her aren't
 *    confused by a $4 charge sitting there till next month."
 *
 * The $4 a bank charges GAM for returning a debit is billed the moment the bank
 * refuses it (routes/webhooks) — "GAM eats no fees" — but the resident is in the
 * middle of paying the bill that pull was for, and a $4 landing on it, or
 * sitting by itself on Outstanding, reads to both of them as a glitch.
 *
 * So the charge is written with no invoice and `held_for_next_bill_at` set
 * (migration 20261104160000). These hold both halves of that: while it is held
 * NOTHING asks anybody for it, and the next bill the lease generates carries it
 * at that bill's due date, once.
 *
 * The figures are read through the surfaces Nic reads — Outstanding
 * (listOpenTenantBalances) and the bill page / printed sheet (openBillsFor) —
 * not through the predicate alone, because "it doesn't show as outstanding" is
 * a claim about those two and not about a WHERE clause.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { backfillInvoices } from './invoiceGeneration'
import { processLeaseEnds } from './scheduler'
import { payableRowSql } from '../services/moneyPredicates'
import { listOpenTenantBalances } from '../services/openBalances'
import { openBillsFor, OWED_TO_GAM } from '../services/openBills'

beforeEach(async () => { await cleanupAllSchema() })

/** A $450 lease, billed on the `rentDueDay`, with one $4 return fee on it. */
async function leaseWithFee(opts: { held: boolean; rentDueDay?: number }) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    // Starts BEFORE the bill these read, because the start month never bills
    // (invoiceGeneration leaves a move-in month to the move-in bundle).
    const leaseId = await seedLease(client, {
      unitId, landlordId, rentAmount: 450, startDate: '2027-01-01' })
    await seedLeaseTenant(client, { leaseId, tenantId })
    await client.query(
      `UPDATE leases SET rent_due_day = $2, needs_review = false WHERE id = $1`,
      [leaseId, opts.rentDueDay ?? 1])
    await client.query('COMMIT')

    // The bill the bounced pull was for, written first — this is the bill the
    // resident is in the middle of paying when the bank refuses the debit.
    await backfillInvoices({ from: '2027-03-01', to: '2027-03-31', leaseId })

    const fee = await db.query<{ id: string }>(
      `INSERT INTO payments
         (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
          entry_description, due_date, notes, revenue_owner, held_for_next_bill_at)
       VALUES ($1, $2, $3, $4, 'fee', 4.00, 'pending', 'RETURNFEE', '2027-03-18',
               'Returned bank payment — pi_held (evt_held)', 'gam', $5)
       RETURNING id`,
      [unitId, leaseId, tenantId, landlordId,
       opts.held ? new Date('2027-03-18T12:00:00Z') : null])
    return { leaseId, tenantId, unitId, landlordId, propertyId, feeId: fee.rows[0].id }
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e }
  finally { client.release() }
}

/** The fee as the database holds it: which bill, which day, still held, asked for? */
async function feeRow(feeId: string) {
  const r = await db.query<{
    held: boolean; invoiced: boolean; due: string; amount: string
    bill_due: string | null; payable: boolean
  }>(
    `SELECT (p.held_for_next_bill_at IS NOT NULL) AS held,
            (p.invoice_id IS NOT NULL) AS invoiced,
            to_char(p.due_date,'YYYY-MM-DD') AS due, p.amount::text AS amount,
            to_char(i.due_date,'YYYY-MM-DD') AS bill_due,
            ${payableRowSql('p')} AS payable
       FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
      WHERE p.id = $1`, [feeId])
  return r.rows[0]
}

/** What the two surfaces say: GAM's figure on the bills, and the lines' names. */
async function surfaces(s: { tenantId: string; landlordId: string }) {
  const { bills } = await openBillsFor({
    tenantIds: [s.tenantId], landlordIds: [s.landlordId],
    scopedPropertyIds: null, seesWorkTrade: true })
  const outstanding = await listOpenTenantBalances({ landlordIds: [s.landlordId] })
  return {
    gamOwed: Math.round(bills.reduce((t, b) => t + Number(b.gam_owed ?? 0), 0) * 100) / 100,
    landlordBalance: Math.round(bills.reduce((t, b) => t + Number(b.balance ?? 0), 0) * 100) / 100,
    gamLines: bills.flatMap(b => b.lines).filter(l => l.gam)
      .map(l => `${l.label}: ${l.detail} $${Number(l.amount).toFixed(2)}`),
    outstandingBalance: outstanding.reduce((t, o) => t + Number(o.balance ?? 0), 0),
  }
}

// ── 11/4: A HELD CHARGE WHEN THERE IS NO NEXT BILL ──────────────────────────
//
// The hold is released by the bill that adopts it, and only ACTIVE leases
// generate bills. So a tenancy that ends while a charge is held would leave it
// held for good: invisible everywhere, swept by nothing, and GAM has already
// paid the bank for it. processLeaseEnds releases it before anything else in
// the ending runs, so the rest of the move-out machinery treats it as the
// ordinary owed charge it now is — a fee already incurred stands when somebody
// leaves; only future charges are severed.
describe('the tenancy ends while a charge is held', () => {
  it('releases the hold, so it is owed and the move-out can see it', async () => {
    const client = await getClient()
    let leaseId = '', feeId = ''
    try {
      await client.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(client)
      const tenantId = await seedTenant(client)
      const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(client, { propertyId, landlordId })
      await client.query(`UPDATE units SET dwelling_ownership = 'landlord', unit_type = 'apartment', status = 'active' WHERE id = $1`, [unitId])
      const lease = await client.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, status, lease_type, start_date, end_date, rent_amount,
                             signed_by_tenant, signed_by_landlord)
         VALUES ($1, $2, 'active', 'fixed_term', CURRENT_DATE - 90, CURRENT_DATE - 1, 450, TRUE, TRUE)
         RETURNING id`, [unitId, landlordId])
      leaseId = lease.rows[0].id
      await seedLeaseTenant(client, { leaseId, tenantId })
      const fee = await client.query<{ id: string }>(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
                               entry_description, due_date, notes, revenue_owner, held_for_next_bill_at)
         VALUES ($1, $2, $3, $4, 'fee', 4.00, 'pending', 'RETURNFEE', CURRENT_DATE - 2,
                 'Returned bank payment — pi_end (evt_end)', 'gam', NOW())
         RETURNING id`, [unitId, leaseId, tenantId, landlordId])
      feeId = fee.rows[0].id
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e }
    finally { client.release() }

    // Held, so nothing asks for it — the state the tenancy ends in.
    expect((await feeRow(feeId)).payable).toBe(false)

    await processLeaseEnds()
    // The ending itself must have happened — the release is a step inside it.
    expect((await db.query<any>(
      `SELECT status FROM leases WHERE id = $1`, [leaseId])).rows[0].status).toBe('expired')

    const after = await feeRow(feeId)
    expect(after.held).toBe(false)     // the hold is gone
    expect(after.payable).toBe(true)   // and it is ordinary owed money now
    expect(Number(after.amount)).toBe(4)
  })
})

describe('a held charge is asked for by nothing until a bill carries it', () => {
  it('is on no bill, in no figure and in no line while it is held', async () => {
    const s = await leaseWithFee({ held: true })
    const fee = await feeRow(s.feeId)
    expect(fee.payable).toBe(false)
    expect(fee.invoiced).toBe(false)

    const v = await surfaces(s)
    expect(v.gamOwed).toBe(0)        // no stray $4 against GAM on March's bill
    expect(v.gamLines).toEqual([])   // and no line for it anywhere
    expect(v.landlordBalance).toBe(450)       // the rent they are paying, untouched
    expect(v.outstandingBalance).toBe(450)    // Outstanding reads the same
  })

  it('the same charge, not held, IS asked for — so it is the hold doing the work', async () => {
    const s = await leaseWithFee({ held: false })
    expect((await feeRow(s.feeId)).payable).toBe(true)

    const v = await surfaces(s)
    expect(v.gamOwed).toBe(4)
    expect(v.gamLines).toEqual([`${OWED_TO_GAM}: Returned-payment fee $4.00`])
    // Still never part of the landlord's own balance — that rule is older than
    // this one and is not what the hold is for.
    expect(v.landlordBalance).toBe(450)
  })

  it('rides the next bill, at that bill\'s due date, and is owed from then on', async () => {
    const s = await leaseWithFee({ held: true })
    await backfillInvoices({ from: '2027-04-01', to: '2027-04-30', leaseId: s.leaseId })

    const fee = await feeRow(s.feeId)
    expect(fee.held).toBe(false)
    expect(fee.invoiced).toBe(true)
    // It took the bill's day — not the 18th the bank refused the debit on.
    expect(fee.due).toBe('2027-04-01')
    expect(fee.bill_due).toBe('2027-04-01')
    expect(Number(fee.amount)).toBe(4)
    expect(fee.payable).toBe(true)

    const v = await surfaces(s)
    expect(v.gamOwed).toBe(4)
    expect(v.gamLines).toEqual([`${OWED_TO_GAM}: Returned-payment fee $4.00`])
  })

  it('a landlord billing the 15th gets it on the 15th — the bill decides, not the calendar', async () => {
    const s = await leaseWithFee({ held: true, rentDueDay: 15 })
    await backfillInvoices({ from: '2027-04-01', to: '2027-04-30', leaseId: s.leaseId })
    expect((await feeRow(s.feeId)).due).toBe('2027-04-15')
  })

  it('only one bill carries it: later months do not bill it again', async () => {
    const s = await leaseWithFee({ held: true })
    await backfillInvoices({ from: '2027-04-01', to: '2027-06-30', leaseId: s.leaseId })

    expect((await db.query<{ n: string; due: string }>(
      `SELECT COUNT(*)::text AS n, to_char(MIN(due_date),'YYYY-MM-DD') AS due
         FROM payments WHERE lease_id = $1 AND entry_description = 'RETURNFEE'`,
      [s.leaseId])).rows[0]).toEqual({ n: '1', due: '2027-04-01' })

    // It is on the APRIL bill and on no other, though May and June were written.
    const where = await db.query<{ due: string }>(
      `SELECT to_char(i.due_date,'YYYY-MM-DD') AS due
         FROM payments p JOIN invoices i ON i.id = p.invoice_id
        WHERE p.lease_id = $1 AND p.entry_description = 'RETURNFEE'`, [s.leaseId])
    expect(where.rows.map(r => r.due)).toEqual(['2027-04-01'])
    expect(Number((await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM invoices WHERE lease_id = $1`, [s.leaseId])).rows[0].n))
      .toBeGreaterThanOrEqual(3)
  })
})
