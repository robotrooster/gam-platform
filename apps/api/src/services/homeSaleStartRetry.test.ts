/**
 * 10/12 (Nic) — "Retry every morning."
 *
 * The landlord's signature starts a home sale billing (routes/esign.ts calls
 * activateHomeSaleContract right after it), but that call is best-effort: when
 * it fails, the sale sits 'pending_signature' and bills nothing until the
 * buyer signs. The daily home-sale run (billDueHomeSaleInstallments) now starts
 * every such sale first, with the steps the 10/12 one-time script used, and
 * the landlord is told either way: the morning it starts, and once, the
 * morning it could not.
 *
 * The data is built the way a failed start leaves it: the contract
 * 'pending_signature' with no schedule, the landlord signed, the buyer not,
 * and this month's bill out without the home payment.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { db, query, queryOne } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant } from '../test/dbHelpers'

// A start that throws: the own-signature check is the first thing the start
// asks, so failing it fails the start before anything is written.
const failStart = vi.hoisted(() => ({ on: false }))
vi.mock('./newLeaseInvite', async (orig) => {
  const real = await orig<typeof import('./newLeaseInvite')>()
  return {
    ...real,
    tenantsNeedingOwnSignature: async (...a: Parameters<typeof real.tenantsNeedingOwnSignature>) => {
      if (failStart.on) throw new Error('database went away')
      return real.tenantsNeedingOwnSignature(...a)
    },
  }
})

import { billDueHomeSaleInstallments, createHomeSaleContract, retryLandlordSignedHomeSaleStarts } from './homeSale'

const TZ = 'America/Chicago'

beforeEach(async () => { await cleanupAllSchema(); failStart.on = false })

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

const typedMonth = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(0, 4)}`

/**
 * $100 × 60 from two months before the park's first billing cycle (this
 * month). `typed` puts the terms on the agreement the way the landlord types
 * them; `landlordSigned: false` is an agreement nobody has signed yet.
 */
async function waitingSale(o: {
  landlordSigned?: boolean
  /** How long ago the landlord signed (default an hour). */
  signedMinutesAgo?: number
  /** Or the day he signed ('YYYY-MM-DD', noon at the park). */
  signedOn?: string
  /** `first: 'contract'` types the contract's own first month. */
  typed?: { monthly: string; payments: string; first: string | 'contract' }
} = {}) {
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
       VALUES ($1,$2,$3,$4,$5,$6,450,16.50,466.50,'pending') RETURNING id`,
      [ll.landlordId, tenantId, leaseId, unitId, `INV-R-${randomUUID().slice(0, 8)}`, thisMonth])).rows[0].id
    await c.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'rent',450,'pending',$6,'RENT'), ($1,$2,$3,$4,$5,'utility',16.50,'pending',$6,'UTILITY')`,
      [invoiceId, unitId, leaseId, tenantId, ll.landlordId, thisMonth])
    const signed = o.landlordSigned !== false
    const docId = (await c.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, lease_id, title, document_type, status)
       VALUES ($1,$2,$3,'Installment Contract','purchase_agreement',$4) RETURNING id`,
      [ll.landlordId, unitId, leaseId, signed ? 'in_progress' : 'sent'])).rows[0].id
    await c.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status, signed_at)
       VALUES ($1,$2,'landlord','Owner','owner@test.dev',1,$3,$4,
               CASE WHEN NOT $5::boolean THEN NULL
                    WHEN $6::date IS NOT NULL THEN ($6::date + time '12:00') AT TIME ZONE $8
                    ELSE NOW() - make_interval(mins => $7::int) END)`,
      [docId, ll.userId, randomUUID(), signed ? 'signed' : 'sent', signed, o.signedOn ?? null, o.signedMinutesAgo ?? 60, TZ])
    await c.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
       SELECT $1, t.user_id, 'primary', 'Buyer', 'buyer@test.dev', 2, $3, 'sent' FROM tenants t WHERE t.id = $2`,
      [docId, tenantId, randomUUID()])
    if (o.typed) {
      for (const [col, value] of [['sale_monthly_payment', o.typed.monthly], ['sale_term_months', o.typed.payments],
                                  ['sale_first_payment_month', o.typed.first === 'contract' ? typedMonth(start) : o.typed.first]]) {
        await c.query(
          `INSERT INTO lease_document_fields (document_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required, value)
           VALUES ($1,'text','landlord',$2,$2,1,10,10,100,20,false,$3)`, [docId, col, value])
      }
    }
    const k = await createHomeSaleContract(c, {
      unitId, leaseId: null, tenantId, landlordId: ll.landlordId,
      salePrice: 6000, downPayment: 0, annualInterestRate: 0, termMonths: 60, startMonth: start,
      planType: 'flat', pendingSignature: true,
    })
    await c.query(`UPDATE home_sale_contracts SET purchase_document_id = $2 WHERE id = $1`, [k.id, docId])
    return { contractId: k.id as string, docId, invoiceId, thisMonth, start, landlordId: ll.landlordId, landlordUser: ll.userId }
  })
}

const state = async (s: { contractId: string; invoiceId: string }) => ({
  status: (await queryOne<any>(`SELECT status FROM home_sale_contracts WHERE id = $1`, [s.contractId]))!.status,
  installments: (await queryOne<any>(`SELECT COUNT(*)::int AS n FROM home_sale_installments WHERE contract_id = $1`, [s.contractId]))!.n,
  // 10/25 (Nic): the trailer payment is on the contract's OWN bill, never the
  // rent bill. `bill` stays the rent bill, so these assertions say both things
  // at once: what was billed, and that the rent bill did not change.
  homeLines: await query<any>(
    `SELECT p.amount::float AS amount, p.notes FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
      WHERE i.home_sale_contract_id = $1 AND p.type = 'home_payment'
      ORDER BY p.notes`, [s.contractId]),
  bill: await queryOne<any>(`SELECT total_amount::float AS total, subtotal_home_payments::float AS home FROM invoices WHERE id = $1`, [s.invoiceId]),
})
const notices = (landlordId: string) => query<any>(
  `SELECT user_id, type, title, action_url FROM notifications WHERE landlord_id = $1 ORDER BY created_at, type`, [landlordId])
const adminAlerts = (docId: string) => query<any>(
  `SELECT severity, category FROM admin_notifications WHERE context->>'document_id' = $1`, [docId])

describe('the morning retry starts a sale the landlord signed that did not start', () => {
  it("the daily home-sale run starts it and puts what is due on the sale's own bill", async () => {
    const s = await waitingSale()
    await billDueHomeSaleInstallments(s.thisMonth)

    expect(await state(s)).toEqual({
      status: 'active', installments: 60,
      homeLines: [{ amount: 100, notes: 'Home payment 3 of 60' }],
      bill: { total: 466.5, home: 0 },
    })
  })

  it('tells the landlord it started, and nobody is alarmed', async () => {
    const s = await waitingSale()
    await retryLandlordSignedHomeSaleStarts()
    expect(await notices(s.landlordId)).toEqual([{
      user_id: s.landlordUser, type: 'home_sale_started',
      title: 'Home payments started — MH 18 at Country Acres', action_url: '/esign',
    }])
    expect(await adminAlerts(s.docId)).toEqual([])
  })

  it('a second morning starts nothing again, writes no second schedule, and tells nobody twice', async () => {
    const s = await waitingSale()
    expect(await retryLandlordSignedHomeSaleStarts()).toEqual({ started: 1, notStarted: 0 })
    const once = await state(s)
    expect(await retryLandlordSignedHomeSaleStarts()).toEqual({ started: 0, notStarted: 0 })
    await billDueHomeSaleInstallments(s.thisMonth)
    expect(await state(s)).toEqual(once)
    expect(await notices(s.landlordId)).toHaveLength(1)
  })

  it('leaves alone an agreement the landlord has not signed', async () => {
    const s = await waitingSale({ landlordSigned: false })
    expect(await retryLandlordSignedHomeSaleStarts()).toEqual({ started: 0, notStarted: 0 })
    expect((await state(s)).status).toBe('pending_signature')
    expect(await notices(s.landlordId)).toEqual([])
  })

  it('starts on the terms he typed when they are the sale on file', async () => {
    const s = await waitingSale({ typed: { monthly: '$100', payments: '60', first: 'contract' } })
    expect(await retryLandlordSignedHomeSaleStarts()).toEqual({ started: 1, notStarted: 0 })
    expect(await state(s)).toMatchObject({ status: 'active', installments: 60, homeLines: [{ amount: 100, notes: 'Home payment 3 of 60' }] })
  })
})

describe('a sale the morning retry cannot start', () => {
  it('stays waiting with nothing written, and the landlord and GAM hear once', async () => {
    const s = await waitingSale()
    failStart.on = true
    expect(await retryLandlordSignedHomeSaleStarts()).toEqual({ started: 0, notStarted: 1 })
    expect(await state(s)).toMatchObject({ status: 'pending_signature', installments: 0, homeLines: [] })
    expect(await notices(s.landlordId)).toEqual([{
      user_id: s.landlordUser, type: 'home_sale_not_started',
      title: 'Home payments not started — MH 18 at Country Acres', action_url: '/esign',
    }])
    expect(await adminAlerts(s.docId)).toEqual([{ severity: 'critical', category: 'home_sale_start_retry_failed' }])

    // The next morning it fails again: still trying, nobody told twice.
    expect(await retryLandlordSignedHomeSaleStarts()).toEqual({ started: 0, notStarted: 1 })
    expect(await notices(s.landlordId)).toHaveLength(1)
    expect(await adminAlerts(s.docId)).toHaveLength(1)

    // The morning after that it starts — and the landlord hears that too.
    failStart.on = false
    expect(await retryLandlordSignedHomeSaleStarts()).toEqual({ started: 1, notStarted: 0 })
    expect((await state(s)).status).toBe('active')
    expect((await notices(s.landlordId)).map(n => n.type)).toEqual(['home_sale_not_started', 'home_sale_started'])
  })

  it('one that fails never stops the others, or the billing', async () => {
    // No number of payments typed: the terms cannot be read.
    const bad = await waitingSale({ typed: { monthly: '$250', payments: '', first: '' } })
    const good = await waitingSale()
    const billed = await billDueHomeSaleInstallments(good.thisMonth)
    expect(billed).toBe(0)   // the good one's due payment went on its open bill, not standalone
    expect((await state(good)).status).toBe('active')
    expect((await state(bad)).status).toBe('pending_signature')
  })

  it('terms that cannot be read keep it waiting, and the landlord and GAM hear once', async () => {
    const s = await waitingSale({ typed: { monthly: '$250', payments: '', first: '' } })
    expect(await retryLandlordSignedHomeSaleStarts()).toEqual({ started: 0, notStarted: 1 })
    expect(await state(s)).toMatchObject({ status: 'pending_signature', installments: 0, homeLines: [] })
    const n = await query<any>(`SELECT type FROM notifications WHERE landlord_id = $1`, [s.landlordId])
    expect(n).toEqual([{ type: 'home_sale_not_started' }])
    expect(await adminAlerts(s.docId)).toEqual([{ severity: 'critical', category: 'home_sale_start_retry_failed' }])
  })

  it('leaves alone a signature made minutes ago — its own path is still starting the sale', async () => {
    // 10/12: the signature commits before its path records the terms and
    // starts the sale; a retry in that gap alarmed everyone for nothing.
    const s = await waitingSale({ signedMinutesAgo: 5, typed: { monthly: '$250', payments: '60', first: '' } })
    expect(await retryLandlordSignedHomeSaleStarts()).toEqual({ started: 0, notStarted: 0 })
    expect((await state(s)).status).toBe('pending_signature')
    expect(await notices(s.landlordId)).toEqual([])
    expect(await adminAlerts(s.docId)).toEqual([])
  })

  it('a buyer of another company waits for their own signature, and nobody is alarmed', async () => {
    const s = await waitingSale()
    const tenantUser = (await queryOne<any>(
      `SELECT t.user_id FROM home_sale_contracts c JOIN tenants t ON t.id = c.tenant_id WHERE c.id = $1`, [s.contractId]))!.user_id
    await db.query(`UPDATE lease_tenants SET status = 'void' WHERE tenant_id = (SELECT tenant_id FROM home_sale_contracts WHERE id = $1)`, [s.contractId])
    const other = await tx(c => seedLandlord(c))
    const otherDoc = (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, title, document_type, status)
       VALUES ($1,'Their lease elsewhere','general_contract','sent') RETURNING id`, [other.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
       VALUES ($1,$2,'party_1','Buyer','buyer@test.dev',1,$3,'sent')`, [otherDoc, tenantUser, randomUUID()])

    expect(await retryLandlordSignedHomeSaleStarts()).toEqual({ started: 0, notStarted: 0 })
    expect((await state(s)).status).toBe('pending_signature')
    expect(await notices(s.landlordId)).toEqual([])
    expect(await adminAlerts(s.docId)).toEqual([])
  })
})

describe('terms that did not record on his signature', () => {
  // 10/12: the retry used to start only; when RECORDING the typed terms was
  // what failed, the contract still held the drafted ones, the paper never
  // matched it, and the sale was skipped every morning for good.
  it('are recorded by the retry, which then starts the sale on them and prints the derived boxes', async () => {
    // He signed 20 days before this month began and typed $250 a month over
    // the $100 the agreement was drafted with, with no first-payment month:
    // that means the month after he SIGNED — this month — not next month.
    const thisMonth = (await queryOne<{ m: string }>(
      `SELECT to_char(date_trunc('month', (NOW() AT TIME ZONE $1)::date), 'YYYY-MM-DD') AS m`, [TZ]))!.m
    const signedOn = (await queryOne<{ d: string }>(`SELECT ($1::date - 20)::text AS d`, [thisMonth]))!.d
    const s = await waitingSale({ signedOn, typed: { monthly: '$250', payments: '60', first: '' } })
    for (const col of ['sale_financed_amount', 'sale_final_payment_amount', 'sale_final_payment_month']) {
      await db.query(
        `INSERT INTO lease_document_fields (document_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required)
         VALUES ($1,'text','landlord',$2,$2,1,10,10,100,20,false)`, [s.docId, col])
    }

    expect(await retryLandlordSignedHomeSaleStarts()).toEqual({ started: 1, notStarted: 0 })

    // The drafted record gave way to the paper.
    expect((await state(s)).status).toBe('cancelled')
    const k = (await queryOne<any>(
      `SELECT id, status, monthly_payment::float AS monthly, to_char(start_month, 'YYYY-MM-DD') AS start_month
         FROM home_sale_contracts WHERE purchase_document_id = $1 AND id <> $2`, [s.docId, s.contractId]))!
    expect(k).toMatchObject({ status: 'active', monthly: 250, start_month: thisMonth })
    expect(await state({ contractId: k.id, invoiceId: s.invoiceId })).toMatchObject({
      installments: 60, homeLines: [{ amount: 250, notes: 'Home payment 1 of 60' }],
    })
    const boxes = await query<any>(
      `SELECT lease_column, value FROM lease_document_fields
        WHERE document_id = $1 AND lease_column IN ('sale_financed_amount', 'sale_final_payment_amount')
        ORDER BY lease_column`, [s.docId])
    expect(boxes).toEqual([
      { lease_column: 'sale_final_payment_amount', value: '250.00' },
      { lease_column: 'sale_financed_amount', value: '15000.00' },
    ])
    expect((await notices(s.landlordId)).map(n => n.type)).toEqual(['home_sale_started'])
    expect(await adminAlerts(s.docId)).toEqual([])

    // A second morning: nothing recorded or started again.
    expect(await retryLandlordSignedHomeSaleStarts()).toEqual({ started: 0, notStarted: 0 })
    expect((await query<any>(`SELECT id FROM home_sale_contracts WHERE purchase_document_id = $1`, [s.docId]))).toHaveLength(2)
  })

})
