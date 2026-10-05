/**
 * S655 money plan Step 16 — portal, desk, Outstanding, the bill email, the
 * 7 am digest and both agents show the same balance and the same credit for
 * one household.
 *
 * Nic (10/2): one household balance; landlord screens show the FULL balance
 * with "credit available $X" beside it; credit is never taken off what is
 * owed. Every surface that names what a person owes is read here through its
 * real entry point (the route a screen calls, the email function's arguments,
 * the agent tool's output) for the same household, and they must agree:
 *
 *   portal          GET  /api/payments/balance-context   (Pay Now)
 *   tenant agent    POST /api/payments/quote             (get_payment_quote)
 *                   get_my_payment_status, get_my_balance_breakdown
 *   desk            GET  /api/payments/:id/record-manual/quote
 *   Outstanding     GET  /api/balances
 *   bill email      sendPendingInvoiceNotices → emailInvoiceReady
 *   7 am digest     runLateBalanceDigest → sendLatePaymentDigest
 *   landlord agent  lookup_tenant_payment_status, query_portfolio
 *
 * The digest lists amounts only (it has no credit column), so it is held to
 * the balance alone.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import type { PoolClient } from 'pg'

const emailInvoiceReady = vi.hoisted(() => vi.fn(async (..._a: any[]) => 'msg_invoice'))
const sendLatePaymentDigest = vi.hoisted(() => vi.fn(async (..._a: any[]) => undefined))
vi.mock('./email', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emailInvoiceReady,
  sendLatePaymentDigest,
  sendNotificationEmail: vi.fn(async () => undefined),
}))
vi.mock('stripe', () => {
  function FakeStripe(this: any) {
    this.paymentMethods = { retrieve: vi.fn(async () => ({ id: 'pm_mock', card: { country: 'US' } })) }
    this.paymentIntents = { cancel: vi.fn(async (id: string) => ({ id })) }
  }
  return { default: FakeStripe }
})

import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedAllocationRule,
  seedUtilityMeter, seedUtilityBill,
} from '../test/dbHelpers'
import { paymentsRouter } from '../routes/payments'
import { balancesRouter } from '../routes/balances'
import { errorHandler } from '../middleware/errorHandler'
import { generateInvoices } from '../jobs/invoiceGeneration'
import { runLateBalanceDigest } from '../jobs/lateBalanceDigest'
import { sendPendingInvoiceNotices } from './invoiceNotice'
import { createPaidAhead, createIssuedCredit } from './creditUse'
import { getMyPayments } from './agents/tools/getMyPayments'
import { getMyBalanceBreakdown } from './agents/tools/getMyBalanceBreakdown'
import { lookupTenantPaymentStatus } from './agents/tools/lookupTenantPaymentStatus'
import { queryPortfolio } from './agents/tools/queryPortfolio'

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
}

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/payments', paymentsRouter)
  a.use('/api/balances', balancesRouter)
  a.use(errorHandler)
  return a
}
const sign = (claims: Record<string, unknown>) => jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' })

interface House {
  landlordUserId: string; landlordId: string; propertyId: string; unitId: string
  tenantId: string; tenantUserId: string; leaseId: string; invoiceId: string; rentId: string
  tenantToken: string; landlordToken: string
}

/**
 * One household at a park: September's bill (rent $460 + water $35) is due
 * and five-plus days late. $10 the landlord took as money paid ahead and a $15
 * goodwill credit sit on file.
 */
async function household(): Promise<House> {
  const base = await tx(async c => {
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    await c.query(`UPDATE properties SET name = 'Oak Park', timezone = 'America/Phoenix' WHERE id = $1`, [propertyId])
    await seedAllocationRule(c, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 460 })
    await c.query(`UPDATE units SET unit_number = 'MH 25' WHERE id = $1`, [unitId])
    const tenantId = await seedTenant(c)
    const tenantUserId = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    await c.query(`UPDATE users SET first_name = 'Mae', last_name = 'Agreement' WHERE id = $1`, [tenantUserId])
    const leaseId = (await c.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
       VALUES ($1, $2, 460, 'month_to_month', 'active', '2026-07-01') RETURNING id`, [unitId, landlordId])).rows[0].id
    await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, 'primary')`, [leaseId, tenantId])
    return { landlordUserId, landlordId, propertyId, unitId, tenantId, tenantUserId, leaseId }
  })
  await generateInvoices(new Date('2026-09-01T15:00:00Z'))
  const inv = (await db.query<{ id: string }>(`SELECT id FROM invoices WHERE lease_id = $1 AND due_date = '2026-09-01'`, [base.leaseId])).rows[0]
  const rentId = (await db.query<{ id: string }>(`SELECT id FROM payments WHERE invoice_id = $1 AND type = 'rent'`, [inv.id])).rows[0].id
  // August's water, on September's bill (utilities bill in arrears).
  await tx(async c => {
    const meterId = await seedUtilityMeter(c, { propertyId: base.propertyId, utilityType: 'water' })
    const waterRow = (await c.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, invoice_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,'utility',35,'pending','2026-09-01','UTILITY') RETURNING id`,
      [base.unitId, base.leaseId, base.tenantId, base.landlordId, inv.id])).rows[0].id
    await seedUtilityBill(c, { meterId, unitId: base.unitId, tenantId: base.tenantId, leaseId: base.leaseId, landlordId: base.landlordId,
      chargeAmount: 35, paymentId: waterRow, billingCycleMonth: '2026-08-01', utilityType: 'water' })
    await c.query(`UPDATE invoices SET total_amount = total_amount + 35 WHERE id = $1`, [inv.id])
    await createPaidAhead(c, { leaseId: base.leaseId, tenantId: base.tenantId, amount: 10, fundedBy: 'landlord', receivedAt: '2026-08-20T17:00:00Z' })
    await createIssuedCredit(c, { landlordId: base.landlordId, tenantId: base.tenantId, amount: 15, category: 'goodwill',
      reason: 'Sorry about the water outage', createdBy: base.landlordUserId })
  })
  return {
    ...base, invoiceId: inv.id, rentId,
    tenantToken: sign({ userId: base.tenantUserId, role: 'tenant', email: 'mae@t.dev', profileId: base.tenantId }),
    landlordToken: sign({ userId: base.landlordUserId, role: 'landlord', email: 'll@t.dev', profileId: base.landlordId,
      landlordIds: [base.landlordId], permissions: {} }),
  }
}

/** Every surface's (balance, credit) for this household. null credit: the surface has no credit figure. */
async function everySurface(h: House): Promise<Record<string, { balance: number; credit: number | null }>> {
  const out: Record<string, { balance: number; credit: number | null }> = {}

  const portal = await request(app()).get('/api/payments/balance-context').set('Authorization', `Bearer ${h.tenantToken}`)
  expect(portal.status).toBe(200)
  out.portal = {
    balance: portal.body.data.totalOutstanding,
    credit: portal.body.data.leases.reduce((s: number, l: any) => s + l.usableCredit, 0),
  }

  const quote = await request(app()).post('/api/payments/quote').set('Authorization', `Bearer ${h.tenantToken}`).send({ method: 'card' })
  expect(quote.status).toBe(200)
  out.tenantAgentQuote = { balance: quote.body.data.outstanding, credit: quote.body.data.usableCredit }

  const desk = await request(app()).get(`/api/payments/${h.rentId}/record-manual/quote`).set('Authorization', `Bearer ${h.landlordToken}`)
  expect(desk.status).toBe(200)
  out.desk = { balance: desk.body.data.fullBalance, credit: desk.body.data.creditAvailable }

  const bal = await request(app()).get('/api/balances?include=clearing').set('Authorization', `Bearer ${h.landlordToken}`)
  expect(bal.status).toBe(200)
  const mine = (bal.body.data.residents ?? bal.body.data.rows ?? bal.body.data).filter?.((r: any) => r.tenant_id === h.tenantId)
    ?? []
  expect(mine).toHaveLength(1)
  out.outstanding = { balance: Number(mine[0].balance), credit: mine[0].credit_available }

  emailInvoiceReady.mockClear()
  await db.query(`UPDATE invoices SET sent_at = NULL WHERE id = $1`, [h.invoiceId])
  const sent = await sendPendingInvoiceNotices({ invoiceId: h.invoiceId })
  expect(sent.sent).toBe(1)
  const email = emailInvoiceReady.mock.calls[0][1]
  out.billEmail = { balance: email.total, credit: email.creditAvailable }

  sendLatePaymentDigest.mockClear()
  await runLateBalanceDigest()
  const digestItems = sendLatePaymentDigest.mock.calls.flatMap((c: any[]) => c[0].items).filter((i: any) => i.tenantId === h.tenantId)
  expect(digestItems).toHaveLength(1)
  out.digest = { balance: digestItems[0].amount, credit: null }

  const tenantActor = { userId: h.tenantUserId, role: 'tenant' as const, profileId: h.tenantId, landlordIds: [] }
  const landlordActor = { userId: h.landlordUserId, role: 'landlord' as const, profileId: '', landlordIds: [h.landlordId] } as any
  const status: any = await getMyPayments.execute({}, tenantActor as any)
  out.tenantAgentStatus = { balance: status.outstandingBalance, credit: status.creditAvailable }
  const breakdown: any = await getMyBalanceBreakdown.execute({}, tenantActor as any)
  out.tenantAgentBreakdown = { balance: breakdown.totalOwed, credit: breakdown.creditAvailable }
  const lookup: any = await lookupTenantPaymentStatus.execute({ tenant: 'Mae Agreement' }, landlordActor)
  expect(lookup.ok).toBe(true)
  out.landlordAgentLookup = { balance: lookup.outstandingBalance, credit: lookup.creditAvailable }
  const portfolio: any = await queryPortfolio.execute({ subject: 'tenants', measure: 'balance_owed' }, landlordActor)
  out.landlordAgentPortfolio = { balance: portfolio.results.find((r: any) => r.name === 'Mae Agreement')?.value, credit: null }
  return out
}

function expectAllAgree(all: Record<string, { balance: number; credit: number | null }>, balance: number, credit: number) {
  const expected = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { balance, credit: v.credit === null ? null : credit }]))
  const round = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, {
    balance: Math.round(Number(v.balance) * 100) / 100,
    credit: v.credit === null ? null : Math.round(Number(v.credit) * 100) / 100,
  }]))
  expect(round).toEqual(expected)
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_balance_agreement'
  await db.query(
    `INSERT INTO platform_processing_rates
       (payment_method, customer_facing_flat, customer_facing_percent, stripe_cost_flat, stripe_cost_percent)
     SELECT 'card', 0.55, 3.5, 0.26, 0.7
      WHERE NOT EXISTS (SELECT 1 FROM platform_processing_rates WHERE payment_method = 'card' AND effective_until IS NULL)`)
})

describe('one household, one balance, one credit figure on every surface', () => {
  it('portal, desk, Outstanding, the bill email, the 7 am digest and both agents show the same balance and the same credit for one household', async () => {
    const h = await household()
    // $460 + $35 owed in full; $10 paid ahead + $15 goodwill would pay $25 of it.
    expectAllAgree(await everySurface(h), 495, 25)
  })

  it('money still clearing, a work-trade line and GAM\'s FlexPay pull are owed nowhere; a bounced and reopened line is owed once everywhere', async () => {
    const h = await household()
    const row = (o: Record<string, unknown>) => {
      const all: Record<string, unknown> = {
        unit_id: h.unitId, lease_id: h.leaseId, tenant_id: h.tenantId, landlord_id: h.landlordId, invoice_id: h.invoiceId,
        type: 'utility', status: 'pending', due_date: '2026-09-01', entry_description: 'UTILITY', ...o,
      }
      const cols = Object.keys(all)
      return db.query<{ id: string }>(
        `INSERT INTO payments (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(all))
    }
    // Trash: a bank payment for it is on its way (clearing, not owed).
    await row({ amount: 20, status: 'processing', stripe_payment_intent_id: 'pi_agree_clearing' })
    // Work trade covers the electric: owed by nobody.
    await row({ amount: 40, work_trade_suspended_at: new Date() })
    // GAM's FlexPay pull: never part of a tenant's bill.
    await row({ type: 'fee', amount: 25, revenue_owner: 'gam', entry_description: 'FLEXPAY', invoice_id: null, due_date: '2026-09-06' })
    // August rent, paid, then the bank sent it back: the 'returned' original and its reopened row.
    const aug = (await row({ type: 'rent', amount: 300, status: 'returned', entry_description: 'RENT', due_date: '2026-08-01', invoice_id: null, return_code: 'R01' })).rows[0].id
    const rv = (await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount, stripe_event_id, raw_event)
       VALUES ($1,$2,$3,$4,'ach_return',300,'evt_agree_aug','{}') RETURNING id`, [aug, h.landlordId, h.tenantId, h.leaseId])).rows[0].id
    await row({ type: 'rent', amount: 300, entry_description: 'RENT', due_date: '2026-08-01', invoice_id: null, reversal_id: rv })

    const all = await everySurface(h)
    // The bill email speaks for September's bill only; every other surface for
    // the whole household: September's $495 + the reopened August $300.
    const { billEmail, ...wholeHousehold } = all
    expect(Math.round(billEmail.balance * 100) / 100).toBe(495)
    // Credit never pays a row reopened after a bounce, so it is still $25.
    expectAllAgree(wholeHousehold, 495 + 300, 25)
    expect(billEmail.credit).toBe(25)
  })

  it('a GAM charge on the bill (paid online, never by credit) is in the same full balance on every surface', async () => {
    const h = await household()
    // A tenant-paid GAM fee on September's bill: the desk lists it as "Pay
    // online", the portal as GAM's own line — both inside the full balance.
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, invoice_id, type, amount, status, due_date,
                             entry_description, revenue_owner)
       VALUES ($1,$2,$3,$4,$5,'fee',12,'pending','2026-09-01','OTHERFEE','gam')`,
      [h.unitId, h.leaseId, h.tenantId, h.landlordId, h.invoiceId])
    await db.query(`UPDATE invoices SET total_amount = total_amount + 12 WHERE id = $1`, [h.invoiceId])
    // Credit pays only the landlord's lines, so it is still $25.
    expectAllAgree(await everySurface(h), 495 + 12, 25)
  })

  it('a co-tenant hears the same household bill; only the lease\'s credit is theirs to use, not the primary\'s own', async () => {
    const h = await household()
    const coTenantId = await tx(c => seedTenant(c))
    const coUserId = (await db.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [coTenantId])).rows[0].user_id
    await db.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, 'co_tenant')`, [h.leaseId, coTenantId])
    const coToken = sign({ userId: coUserId, role: 'tenant', email: 'co@t.dev', profileId: coTenantId })

    const portal = await request(app()).get('/api/payments/balance-context').set('Authorization', `Bearer ${coToken}`)
    expect(portal.status).toBe(200)
    expect(portal.body.data.totalOutstanding).toBe(495)
    // The $10 paid ahead is the lease's; the $15 goodwill was given to the
    // primary tenant personally, so only the lease's $10 is the co-tenant's to use.
    const coCredit = portal.body.data.leases.reduce((s: number, l: any) => s + l.usableCredit, 0)
    const status: any = await getMyPayments.execute({}, { userId: coUserId, role: 'tenant', profileId: coTenantId, landlordIds: [] } as any)
    expect(status.outstandingBalance).toBe(495)
    expect(status.creditAvailable).toBe(coCredit)
    expect(coCredit).toBe(10)
  })
})
