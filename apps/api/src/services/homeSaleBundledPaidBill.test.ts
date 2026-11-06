/**
 * 11/1 — A BUNDLED INSTALLMENT MUST NOT REOPEN A BILL THAT WAS PAID.
 *
 * Country Acres bills as one invoice a month (properties.home_payments_own_bill
 * = FALSE), so a trailer installment rides the buyer's rent bill. That is Blue's
 * choice and is not in question here.
 *
 * What happened on MH 28: Heather Miller moved in on 11/1 and paid her November
 * bill on 10/30, when rent and her deposit were the only things on it. Her
 * installment reached her afterwards, bundled onto that same bill, and took it
 * from the $629.50 she had paid in full back to $729.50 — telling a brand-new
 * resident she owed $100 she had never been billed for. It was the first thing
 * she asked her landlord about.
 *
 * Bundling is only ever right while the bill is still open. These tests pin the
 * line between the two: an open bill gets the installment, a finished one never
 * does, and "finished" includes a bill whose money is still clearing — because
 * the payer has done everything they are going to do.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { attachDueInstallmentsToOpenInvoices } from './homeSale'
import { todayIn } from '../lib/timezone'

beforeEach(async () => { await cleanupAllSchema() })

/** This month, on GAM's own calendar — no Date in the middle (10/31 landmine). */
const THIS_MONTH = () => {
  const [y, m] = todayIn(null).split('-').map(Number)
  return `${y}-${String(m).padStart(2, '0')}-01`
}

/**
 * A buyer renting the space they are buying the home on, at a park that bills
 * one invoice a month. One installment due this month, unbilled.
 */
async function buyerAtABundledPark() {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    // The setting under test: one bill a month, the way Country Acres runs.
    await client.query(`UPDATE properties SET home_payments_own_bill = FALSE WHERE id = $1`, [propertyId])
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 450 })
    await client.query(
      `UPDATE units SET dwelling_ownership = 'tenant', unit_type = 'mobile_home', status = 'active'
        WHERE id = $1`, [unitId])

    const buyerId = await seedTenant(client, { email: `buyer-${randomUUID()}@test.dev` })
    const lease = await client.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, status, lease_type, start_date, rent_amount,
                           signed_by_tenant, signed_by_landlord)
       VALUES ($1, $2, 'active', 'month_to_month', CURRENT_DATE - 30, 450, TRUE, TRUE)
       RETURNING id`, [unitId, landlordId])
    const leaseId = lease.rows[0].id
    await seedLeaseTenant(client, { leaseId, tenantId: buyerId })

    const contract = await client.query<{ id: string }>(
      `INSERT INTO home_sale_contracts
         (unit_id, tenant_id, landlord_id, sale_price, financed_amount, term_months,
          monthly_payment, start_month, installments_total, status)
       VALUES ($1, $2, $3, 3600, 3600, 36, 100, $4::date, 36, 'active')
       RETURNING id`, [unitId, buyerId, landlordId, THIS_MONTH()])
    const contractId = contract.rows[0].id
    await client.query(
      `INSERT INTO home_sale_installments
         (contract_id, installment_number, billing_month, amount,
          principal_portion, interest_portion, remaining_balance)
       VALUES ($1, 1, $2::date, 100, 100, 0, 3500)`, [contractId, THIS_MONTH()])

    await client.query('COMMIT')
    return { landlordId, propertyId, unitId, buyerId, leaseId, contractId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

/** That month's rent bill, with its rent line in the given state. */
async function rentBill(f: any, rentStatus: 'pending' | 'settled' | 'processing') {
  const inv = await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number,
                           due_date, subtotal_rent, total_amount, status)
     VALUES ($1, $2, $3, $4, $5, $6::date, 450, 450, 'pending')
     RETURNING id`,
    [f.landlordId, f.buyerId, f.leaseId, f.unitId, `INV-TEST-${randomUUID().slice(0, 8)}`, THIS_MONTH()])
  await db.query(
    `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id,
                           type, amount, status, due_date, entry_description,
                           settled_at)
     VALUES ($1, $2, $3, $4, $5, 'rent', 450, $6, $7::date, 'RENT',
             CASE WHEN $6 = 'settled' THEN NOW() ELSE NULL END)`,
    [inv.rows[0].id, f.unitId, f.leaseId, f.buyerId, f.landlordId, rentStatus, THIS_MONTH()])
  return inv.rows[0].id
}

/** Where the installment landed: its bill, and whether that bill is the rent bill. */
const landed = async (contractId: string) => (await db.query<any>(
  `SELECT p.invoice_id, p.amount::float AS amount, p.status,
          i.home_sale_contract_id IS NOT NULL AS own_bill,
          i.total_amount::float AS bill_total
     FROM home_sale_installments h
     JOIN payments p ON p.id = h.payment_id
     JOIN invoices i ON i.id = p.invoice_id
    WHERE h.contract_id = $1`, [contractId])).rows

describe('bundling an installment onto the rent bill', () => {
  it('rides the rent bill while it is still open — the setting works', async () => {
    const f = await buyerAtABundledPark()
    const rentInvoiceId = await rentBill(f, 'pending')
    await attachDueInstallmentsToOpenInvoices(f.contractId)
    const rows = await landed(f.contractId)
    expect(rows).toHaveLength(1)
    expect(rows[0].invoice_id).toBe(rentInvoiceId)
    expect(rows[0].own_bill).toBe(false)
  })

  it('takes its OWN bill when the rent bill is already paid in full', async () => {
    const f = await buyerAtABundledPark()
    const rentInvoiceId = await rentBill(f, 'settled')
    await attachDueInstallmentsToOpenInvoices(f.contractId)
    const rows = await landed(f.contractId)
    expect(rows).toHaveLength(1)
    // The money is still owed — it is simply not a line on a settled receipt.
    expect(rows[0].amount).toBe(100)
    expect(rows[0].status).toBe('pending')
    expect(rows[0].invoice_id).not.toBe(rentInvoiceId)
    expect(rows[0].own_bill).toBe(true)
  })

  it('leaves the paid rent bill at the figure the resident paid', async () => {
    const f = await buyerAtABundledPark()
    const rentInvoiceId = await rentBill(f, 'settled')
    await attachDueInstallmentsToOpenInvoices(f.contractId)
    const bill = (await db.query<any>(
      `SELECT total_amount::float AS total, subtotal_home_payments::float AS home
         FROM invoices WHERE id = $1`, [rentInvoiceId])).rows[0]
    expect(bill.total).toBe(450)
    expect(bill.home).toBe(0)
  })

  it('RIDES the rent bill when its money is still clearing — MH 28 exactly', async () => {
    const f = await buyerAtABundledPark()
    // She paid; the ACH has not landed. The bill is not closed, so the
    // installment belongs on it — 11/1 (Nic): "The trailer payments ride the
    // invoices not a separate bill."
    const rentInvoiceId = await rentBill(f, 'processing')
    await attachDueInstallmentsToOpenInvoices(f.contractId)
    const rows = await landed(f.contractId)
    expect(rows).toHaveLength(1)
    expect(rows[0].invoice_id).toBe(rentInvoiceId)
    expect(rows[0].own_bill).toBe(false)
  })

  it("a NEXT-MONTH installment joins this month's bill once that bill exists — MH 28's real miss", async () => {
    // Her lease and her installment contract were signed in one packet on
    // 10/28. Her move-in bill was dated 11/1 and her first installment was
    // November's, so on the day she signed the attach could not see it: it
    // waited for the calendar and reached her only after she had paid.
    const f = await buyerAtABundledPark()
    // Push the installment to NEXT month and write the bill for that month —
    // the shape of a move-in bill dated ahead of the signing day.
    const nextMonth = (() => {
      const [y, m] = THIS_MONTH().split('-').map(Number)
      const t = y * 12 + (m - 1) + 1
      return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`
    })()
    await db.query(
      `UPDATE home_sale_installments SET billing_month = $2::date WHERE contract_id = $1`,
      [f.contractId, nextMonth])
    const bill = (await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number,
                             due_date, subtotal_rent, total_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6::date,450,450,'pending') RETURNING id`,
      [f.landlordId, f.buyerId, f.leaseId, f.unitId,
       `INV-NEXT-${randomUUID().slice(0, 8)}`, nextMonth])).rows[0]
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id,
                             type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'rent',450,'pending',$6::date,'RENT')`,
      [bill.id, f.unitId, f.leaseId, f.buyerId, f.landlordId, nextMonth])

    await attachDueInstallmentsToOpenInvoices(f.contractId)
    const rows = await landed(f.contractId)
    expect(rows).toHaveLength(1)
    expect(rows[0].invoice_id).toBe(bill.id)
    expect(rows[0].own_bill).toBe(false)
  })

  it('a next-month installment with NO bill yet still waits — no early billing', async () => {
    const f = await buyerAtABundledPark()
    const nextMonth = (() => {
      const [y, m] = THIS_MONTH().split('-').map(Number)
      const t = y * 12 + (m - 1) + 1
      return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`
    })()
    await db.query(
      `UPDATE home_sale_installments SET billing_month = $2::date WHERE contract_id = $1`,
      [f.contractId, nextMonth])
    // This month's bill is open, but the installment is NEXT month's.
    await rentBill(f, 'pending')
    await attachDueInstallmentsToOpenInvoices(f.contractId)
    expect(await landed(f.contractId)).toHaveLength(0)
  })

  it('still waits when no rent bill has been written yet this month', async () => {
    const f = await buyerAtABundledPark()
    // 04:20 run, before the 07:00 monthly bills: the setting must hold.
    await attachDueInstallmentsToOpenInvoices(f.contractId)
    expect(await landed(f.contractId)).toHaveLength(0)
  })

  it('bills it once, not once per run', async () => {
    const f = await buyerAtABundledPark()
    await rentBill(f, 'settled')
    await attachDueInstallmentsToOpenInvoices(f.contractId)
    await attachDueInstallmentsToOpenInvoices(f.contractId)
    expect(await landed(f.contractId)).toHaveLength(1)
  })
})
