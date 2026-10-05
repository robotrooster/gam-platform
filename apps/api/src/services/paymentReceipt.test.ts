/**
 * S655 (money plan, Step 11) — a receipt lists money and credit separately.
 *
 * Kim Harland's 9/9 receipt said $936 for a $486 money order: every line at its
 * full amount, summed and called "Total paid", though $450 of it was the
 * landlord's move-in special. The receipt now shows each charge by name, the
 * account credit as its own line, anything kept on the account, and a total
 * that is the money that actually changed hands.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { resendSendMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(async () => ({ data: { id: `m_${Math.random().toString(36).slice(2)}` }, error: null }) as any),
}))
vi.mock('resend', () => ({ Resend: class { emails = { send: resendSendMock } } }))

import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant,
  seedUtilityMeter, seedUtilityBill,
} from '../test/dbHelpers'
import { sendPaymentReceipt, receiptFigures } from './paymentReceipt'

beforeEach(async () => {
  await cleanupAllSchema()
  resendSendMock.mockClear()
  process.env.EMAIL_SEND_LIVE = '1'
})
afterEach(() => { delete process.env.EMAIL_SEND_LIVE })

const lastSend = () => (resendSendMock.mock.calls.at(-1) as any[])![0]

/** Kim's September: rent, water, trash on one lease, all still open. */
async function seedKim() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET name = 'Oak Park' WHERE id = $1`, [propertyId])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    await c.query(`UPDATE units SET unit_number = 'RV 22' WHERE id = $1`, [unitId])
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: 900 })
    const tenantId = await seedTenant(c, { email: `kim-${randomUUID()}@mailer-test.co` })
    await c.query(`UPDATE users SET first_name = 'Kim' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId])
    await seedLeaseTenant(c, { leaseId, tenantId })
    const inv = await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount, status)
       VALUES ($1,$2,$3,$4,$5,'2026-10-01',935.45,'pending') RETURNING id`,
      [ll.landlordId, tenantId, leaseId, unitId, `INV-K-${randomUUID().slice(0, 6)}`])
    const row = async (type: string, amount: number, entry: string) => (await c.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','2026-10-01',$8) RETURNING id`,
      [inv.rows[0].id, unitId, leaseId, tenantId, ll.landlordId, type, amount, entry])).rows[0].id
    const rent = await row('rent', 900, 'RENT')
    const water = await row('utility', 10.45, 'UTILITY')
    const trash = await row('utility', 25, 'UTILITY')
    for (const [id, type, amt] of [[water, 'water', 10.45], [trash, 'trash', 25]] as const) {
      const meterId = await seedUtilityMeter(c, { propertyId, utilityType: type })
      await seedUtilityBill(c, { meterId, unitId, tenantId, leaseId, landlordId: ll.landlordId, chargeAmount: amt, paymentId: id, utilityType: type })
    }
    await c.query('COMMIT')
    return { ...ll, tenantId, leaseId, unitId, rent, water, trash, ids: [rent, water, trash] }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

/** A landlord-issued credit spent on these rows (applied), then the rows settled. */
async function payWithCredit(k: Awaited<ReturnType<typeof seedKim>>, uses: Array<[string, number]>) {
  const total = uses.reduce((s, [, a]) => s + a, 0)
  const credit = await db.query<{ id: string }>(
    `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status)
     VALUES ($1,$2,$3,$4,$4,'other','Move In Special','active') RETURNING id`, [k.landlordId, k.tenantId, k.leaseId, total])
  for (const [paymentId, amount] of uses) {
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,$4,'2026-10-01','desk','applied',NOW())`, [credit.rows[0].id, paymentId, k.leaseId, amount])
  }
}
const settle = (ids: string[], method: string | null) => db.query(
  `UPDATE payments SET status = 'settled', settled_at = '2026-09-09T17:00:00Z', manual_method = $2 WHERE id = ANY($1::uuid[])`,
  [ids, method])

describe('receiptFigures', () => {
  it('Kim: $935.45 of lines, $450 of credit, $0.55 kept — the money is $486.00', () => {
    const f = receiptFigures([
      { type: 'rent', amount: 900, notes: null, due_date: 'Oct 1, 2026', due_month_label: 'October', credit_used: 450 },
      { type: 'utility', amount: 10.45, notes: null, utility_type: 'water', due_date: 'Oct 1, 2026', due_month_label: 'October', credit_used: 0 },
      { type: 'utility', amount: 25, notes: null, utility_type: 'trash', due_date: 'Oct 1, 2026', due_month_label: 'October', credit_used: 0 },
    ], 0.55)
    expect(f.linesTotal).toBe(935.45)
    expect(f.creditApplied).toBe(450)
    expect(f.creditBanked).toBe(0.55)
    expect(f.amount).toBe(486)
    expect(f.lines.map(l => l.label)).toEqual(['Rent', 'Water', 'Trash'])
    expect(f.billLabel).toBe('October bill')
  })

  it('credit never counts for more than the lines it paid', () => {
    const f = receiptFigures([{ type: 'rent', amount: 100, notes: null, due_date: 'x', credit_used: 150 }])
    expect(f.creditApplied).toBe(100)
    expect(f.amount).toBe(0)
  })
})

describe('sendPaymentReceipt', () => {
  it('a receipt lists money and credit separately', async () => {
    const k = await seedKim()
    await payWithCredit(k, [[k.rent, 450]])
    await settle(k.ids, 'money_order')
    await sendPaymentReceipt({ paymentIds: k.ids, method: 'money order', reference: '55187081609', creditBanked: 0.55 })
    const mail = lastSend()
    expect(mail.subject).toBe('Receipt — $486.00 for Unit RV 22 — Oak Park')
    expect(mail.html).toContain('Account credit applied')
    expect(mail.html).toContain('-$450.00')
    expect(mail.html).toContain('Kept on your account as credit')
    expect(mail.html).toContain('+$0.55')
    expect(mail.html).toContain('$486.00')
    expect(mail.html).not.toContain('$936')
    expect(mail.html).not.toContain('$935.45</span></div>')
    // each line by name, never "Utilities"
    expect(mail.html).toContain('Water')
    expect(mail.html).toContain('Trash')
    expect(mail.html).not.toContain('Utilities')
    // the rent line names the day it was due (it once printed the day of the week)
    expect(mail.html).toContain('due Oct 1, 2026')
    const log = await db.query(`SELECT metadata FROM email_send_log WHERE category = 'payment_receipt' ORDER BY created_at DESC LIMIT 1`)
    expect(log.rows[0].metadata).toMatchObject({ amount: 486, credit_applied: 450, credit_banked: 0.55, credit_only: false })
  })

  it('a bill paid entirely with account credit: "paid with your account credit", nothing charged', async () => {
    const k = await seedKim()
    await payWithCredit(k, [[k.rent, 900], [k.water, 10.45], [k.trash, 25]])
    await settle(k.ids, null)
    await sendPaymentReceipt({ paymentIds: k.ids, method: 'your account credit' })
    const mail = lastSend()
    expect(mail.subject).toBe('Your October bill was paid with your account credit — Unit RV 22 — Oak Park')
    expect(mail.html).toContain('Nothing was charged to you')
    expect(mail.html).toContain('-$935.45')
    expect(mail.html).not.toContain('Paid by your account credit')
  })

  it('no credit: the money paid is the lines, exactly as before', async () => {
    const k = await seedKim()
    await settle(k.ids, 'cash')
    await sendPaymentReceipt({ paymentIds: k.ids, method: 'cash' })
    const mail = lastSend()
    expect(mail.subject).toBe('Receipt — $935.45 for Unit RV 22 — Oak Park')
    expect(mail.html).not.toContain('Account credit applied')
  })

  it('a card payment still clearing counts the credit it set aside', async () => {
    const k = await seedKim()
    const credit = await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status)
       VALUES ($1,$2,$3,100,100,'goodwill','test','active') RETURNING id`, [k.landlordId, k.tenantId, k.leaseId])
    const rem = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, lease_id, amount, applied_amount, payment_method, status, stripe_payment_intent_id)
       VALUES ($1,$2,$3,835.45,835.45,'ach','processing','pi_receipt_held') RETURNING id`, [k.tenantId, k.landlordId, k.leaseId])
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, remittance_id, lease_id, amount, billing_month, source, status)
       VALUES ($1,$2,$3,$4,100,'2026-10-01','portal','held')`, [credit.rows[0].id, k.rent, rem.rows[0].id, k.leaseId])
    await db.query(`UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_receipt_held' WHERE id = ANY($1::uuid[])`, [k.ids])
    await sendPaymentReceipt({ paymentIds: k.ids, method: 'bank transfer', pending: true })
    const mail = lastSend()
    expect(mail.subject).toBe('Payment received — $835.45 for Unit RV 22 — Oak Park')
    expect(mail.html).toContain('-$100.00')
  })
})

// S637: "the person who paid gets a receipt". Lease charges carry the primary
// resident's tenant_id, so the receipt used to go to the primary whoever paid.
describe('the receipt goes to the person who paid', () => {
  async function coTenant(k: Awaited<ReturnType<typeof seedKim>>) {
    const c = await db.connect()
    try {
      const email = `ray-${randomUUID()}@mailer-test.co`
      const co = await seedTenant(c, { email })
      await c.query(`UPDATE users SET first_name = 'Ray' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [co])
      await seedLeaseTenant(c, { leaseId: k.leaseId, tenantId: co, role: 'co_tenant' })
      return { co, email }
    } finally { c.release() }
  }
  const kimEmail = async (tenantId: string) => (await db.query<{ email: string }>(
    `SELECT u.email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [tenantId])).rows[0].email

  it('a co-tenant\'s card payment of the lease\'s rent emails the co-tenant, not the primary', async () => {
    const k = await seedKim()
    const ray = await coTenant(k)
    // Ray pays the lease's whole bill by card; every row is billed to Kim.
    const rem = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, lease_id, amount, applied_amount, payment_method, status, stripe_payment_intent_id, settled_at)
       VALUES ($1,$2,$3,935.45,935.45,'card','settled','pi_receipt_ray',NOW()) RETURNING id`, [ray.co, k.landlordId, k.leaseId])
    for (const [id, amt] of [[k.rent, 900], [k.water, 10.45], [k.trash, 25]] as const) {
      await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,$3)`, [rem.rows[0].id, id, amt])
    }
    await settle(k.ids, null)
    await sendPaymentReceipt({ paymentIds: k.ids, method: 'card' })
    const mail = lastSend()
    expect(mail.to).toEqual(ray.email)
    expect(mail.to).not.toEqual(await kimEmail(k.tenantId))
    expect(mail.html).toContain('Ray')
    expect(mail.subject).toBe('Receipt — $935.45 for Unit RV 22 — Oak Park')
    const log = await db.query(`SELECT to_email FROM email_send_log WHERE category = 'payment_receipt' ORDER BY created_at DESC LIMIT 1`)
    expect(log.rows[0].to_email).toBe(ray.email)
  })

  it('an earlier attempt that failed does not decide who paid', async () => {
    const k = await seedKim()
    const ray = await coTenant(k)
    // Kim's bank payment failed; Ray then paid.
    const failed = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, lease_id, amount, applied_amount, payment_method, status, created_at)
       VALUES ($1,$2,$3,900,900,'ach','failed',NOW() + interval '1 minute') RETURNING id`, [k.tenantId, k.landlordId, k.leaseId])
    const paid = await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, landlord_id, lease_id, amount, applied_amount, payment_method, status, settled_at)
       VALUES ($1,$2,$3,900,900,'cash','settled',NOW()) RETURNING id`, [ray.co, k.landlordId, k.leaseId])
    for (const r of [failed.rows[0].id, paid.rows[0].id]) {
      await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1,$2,900)`, [r, k.rent])
    }
    await settle([k.rent], 'cash')
    await sendPaymentReceipt({ paymentIds: [k.rent], method: 'cash' })
    expect(lastSend().to).toEqual(ray.email)
  })

  it('a bill a co-tenant paid with credit emails the payer the caller names', async () => {
    const k = await seedKim()
    const ray = await coTenant(k)
    await payWithCredit(k, [[k.rent, 900], [k.water, 10.45], [k.trash, 25]])
    await settle(k.ids, null)
    await sendPaymentReceipt({ paymentIds: k.ids, method: 'your account credit', payerTenantId: ray.co })
    expect(lastSend().to).toEqual(ray.email)
  })

  it('with no remittance and no payer named, the person the bill is in the name of gets it', async () => {
    const k = await seedKim()
    await coTenant(k)
    await settle(k.ids, 'cash')
    await sendPaymentReceipt({ paymentIds: k.ids, method: 'cash' })
    expect(lastSend().to).toEqual(await kimEmail(k.tenantId))
  })
})
