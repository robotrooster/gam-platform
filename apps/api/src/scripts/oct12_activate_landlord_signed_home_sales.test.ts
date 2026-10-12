/**
 * 10/12 (Nic) — the one-time start of every home sale whose installment
 * contract the landlord signed under the old code (Country Acres MH 18 and
 * MH 24). The data is built the way the old code left it: the contract at
 * 'pending_signature' with no schedule, the landlord signed, the buyer not,
 * and the month's bill out without the home payment. A dry run reports exactly
 * what --apply then does and changes nothing; a second run finds nothing.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db, query, queryOne } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { createHomeSaleContract } from '../services/homeSale'
import { activateLandlordSignedHomeSales, printStartReport } from './oct12_activate_landlord_signed_home_sales'

const TZ = 'America/Chicago'

beforeEach(cleanupAllSchema)

async function tx<T>(fn: (c: PoolClient) => Promise<T>, commit: boolean): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query(commit ? 'COMMIT' : 'ROLLBACK')
    return r
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

/**
 * MH 18's shape: $100 × 60 from two months before the park's first billing
 * cycle (this month), landlord signed, buyer not; this month's bill pending
 * with rent and water and no home payment. `landlordSigned: false` is a
 * contract nobody has signed yet — not this script's business.
 */
async function waitingSale(o: { landlordSigned?: boolean } = {}) {
  const thisMonth = (await queryOne<{ m: string }>(
    `SELECT to_char(date_trunc('month', (NOW() AT TIME ZONE $1)::date), 'YYYY-MM-DD') AS m`, [TZ]))!.m
  const start = (await queryOne<{ m: string }>(`SELECT to_char($1::date - interval '2 months', 'YYYY-MM-DD') AS m`, [thisMonth]))!.m
  return tx(async c => {
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId, state: 'IL' })
    await c.query(`UPDATE properties SET timezone = $2, first_billing_cycle = $3, name = 'Country Acres' WHERE id = $1`, [propertyId, TZ, thisMonth])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId, unitType: 'mobile_home' })
    await c.query(`UPDATE units SET dwelling_ownership = 'landlord', unit_number = 'MH 18' WHERE id = $1`, [unitId])
    const tenantId = await seedTenant(c)
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 450, leaseType: 'month_to_month' })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    const invoiceId = (await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
                             subtotal_rent, subtotal_utilities, total_amount, status)
       VALUES ($1,$2,$3,$4,'INV-2026-00024',$5,450,16.50,466.50,'pending') RETURNING id`,
      [ll.landlordId, tenantId, leaseId, unitId, thisMonth])).rows[0].id
    await c.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'rent',450,'pending',$6,'RENT'), ($1,$2,$3,$4,$5,'utility',16.50,'pending',$6,'UTILITY')`,
      [invoiceId, unitId, leaseId, tenantId, ll.landlordId, thisMonth])
    const docId = (await c.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, lease_id, title, document_type, status)
       VALUES ($1,$2,$3,'Mattoon Installment Contract','purchase_agreement',$4) RETURNING id`,
      [ll.landlordId, unitId, leaseId, o.landlordSigned === false ? 'sent' : 'in_progress'])).rows[0].id
    await c.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status, signed_at)
       VALUES ($1,$2,'landlord','Owner','owner@test.dev',1,$3,$4,$5)`,
      [docId, ll.userId, randomUUID(), o.landlordSigned === false ? 'sent' : 'signed',
       o.landlordSigned === false ? null : new Date()])
    await c.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
       SELECT $1, t.user_id, 'primary', 'Buyer', 'buyer@test.dev', 2, $3, 'sent' FROM tenants t WHERE t.id = $2`,
      [docId, tenantId, randomUUID()])
    const k = await createHomeSaleContract(c, {
      unitId, leaseId: null, tenantId, landlordId: ll.landlordId,
      salePrice: 6000, downPayment: 0, annualInterestRate: 0, termMonths: 60, startMonth: start,
      planType: 'flat', pendingSignature: true,
    })
    await c.query(`UPDATE home_sale_contracts SET purchase_document_id = $2 WHERE id = $1`, [k.id, docId])
    return { contractId: k.id as string, invoiceId, thisMonth }
  }, true)
}

const state = async (contractId: string, invoiceId: string) => ({
  contract: await queryOne<any>(`SELECT status, installments_billed, installments_paid FROM home_sale_contracts WHERE id = $1`, [contractId]),
  installments: (await queryOne<any>(`SELECT COUNT(*)::int AS n FROM home_sale_installments WHERE contract_id = $1`, [contractId]))!.n,
  homeLines: await query<any>(`SELECT amount::float AS amount, notes FROM payments WHERE invoice_id = $1 AND type = 'home_payment'`, [invoiceId]),
  bill: await queryOne<any>(`SELECT total_amount::float AS total, subtotal_home_payments::float AS home FROM invoices WHERE id = $1`, [invoiceId]),
})

describe('oct12_activate_landlord_signed_home_sales', () => {
  it('a dry run reports each sale and changes nothing', async () => {
    const s = await waitingSale()
    const before = await state(s.contractId, s.invoiceId)
    const r = await tx(c => activateLandlordSignedHomeSales(c), false)

    expect(r.skipped).toEqual([])
    expect(r.started).toHaveLength(1)
    expect(r.started[0]).toMatchObject({
      contractId: s.contractId, property: 'Country Acres', unit: 'MH 18',
      installmentsCreated: 60, stampedOffPlatform: 2,
      attached: [{ installmentNumber: 3, amount: 100, invoiceId: s.invoiceId, dueDate: s.thisMonth, invoiceNumber: 'INV-2026-00024' }],
    })
    const printed: string[] = []
    printStartReport(r, l => printed.push(l))
    expect(printed.join('\n')).toContain('home payment 3 $100.00 → bill INV-2026-00024')

    expect(await state(s.contractId, s.invoiceId)).toEqual(before)
    expect(before).toMatchObject({ contract: { status: 'pending_signature' }, installments: 0, homeLines: [], bill: { total: 466.5, home: 0 } })
  })

  it('--apply does what the dry run reported, and a second run finds nothing', async () => {
    const s = await waitingSale()
    const r = await tx(c => activateLandlordSignedHomeSales(c), true)
    expect(r.started).toHaveLength(1)
    expect(await state(s.contractId, s.invoiceId)).toEqual({
      contract: { status: 'active', installments_billed: 3, installments_paid: 2 },
      installments: 60,
      homeLines: [{ amount: 100, notes: 'Home payment 3 of 60' }],
      bill: { total: 566.5, home: 100 },
    })
    const again = await tx(c => activateLandlordSignedHomeSales(c), true)
    expect(again).toEqual({ started: [], skipped: [] })
  })

  it('leaves alone a contract the landlord has not signed', async () => {
    const s = await waitingSale({ landlordSigned: false })
    const r = await tx(c => activateLandlordSignedHomeSales(c), true)
    expect(r).toEqual({ started: [], skipped: [] })
    expect((await state(s.contractId, s.invoiceId)).contract.status).toBe('pending_signature')
  })
})
