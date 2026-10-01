/**
 * S641 — the tenant gets told their bill exists.
 *
 * Nic: "a lot of people are saying, oh, I never got my bill. I don't know what
 * I owe." Invoice generation sent no email at all; the only billing mail a
 * tenant had ever received was a late notice.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { resendSendMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(async () => ({ data: { id: `m_${Math.random().toString(36).slice(2)}` }, error: null }) as any),
}))
vi.mock('resend', () => ({ Resend: class { emails = { send: resendSendMock } } }))

import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { sendPendingInvoiceNotices } from './invoiceNotice'

const TZ = 'America/Phoenix'

beforeEach(async () => {
  await cleanupAllSchema()
  resendSendMock.mockClear()
  process.env.EMAIL_SEND_LIVE = '1'
})

// Vitest shares one process across files. A flag left set here leaks into the
// next suite, and that is how six real emails escaped a test run.
afterEach(() => { delete process.env.EMAIL_SEND_LIVE })

async function seedInvoice(opts: {
  dueDaysAgo?: number
  rent?: number
  tenantEmail?: string
  withTenant?: boolean
  workTradeCredit?: number
  suspendedRent?: boolean
  /** S654: stamp the invoice with a live agreement (the monthly run does). */
  workTradeAgreement?: boolean
  /** S654: a utility line the trade does not cover — owed as usual. */
  utilityOwed?: number
  /** S654: the S634 total (what is owed today); default = rent − credit. */
  total?: number
} = {}) {
  const rent = opts.rent ?? 460
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    await c.query(`UPDATE landlords SET business_name='Acme Ranch LLC' WHERE id=$1`, [ll.landlordId])
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    await c.query(`UPDATE properties SET timezone=$2, name='Acme Ranch' WHERE id=$1`, [propertyId, TZ])
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    await c.query(`UPDATE units SET unit_number='RV 12' WHERE id=$1`, [unitId])
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, rentAmount: rent })

    let tenantId: string | null = null
    if (opts.withTenant !== false) {
      tenantId = await seedTenant(c, { email: opts.tenantEmail ?? `t-${randomUUID()}@mailer-test.co` })
      await seedLeaseTenant(c, { leaseId, tenantId })
    }

    const inv = await c.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date,
                             subtotal_rent, total_amount, status, work_trade_credit_amount)
       VALUES ($1,$2,$3,$4,$5,(NOW() AT TIME ZONE $6)::date - $7::int, $8, $9, 'pending', $10)
       RETURNING id`,
      [ll.landlordId, tenantId, leaseId, unitId, `INV-${Math.random().toString(36).slice(2, 10)}`,
       TZ, opts.dueDaysAgo ?? 0, rent, opts.total ?? (rent - (opts.workTradeCredit ?? 0)), opts.workTradeCredit ?? 0])

    await c.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, type, amount, status,
                             entry_description, due_date, invoice_id, work_trade_suspended_at)
       VALUES ($1,$2,$3,'rent',$4,'pending','RENT',(NOW() AT TIME ZONE $5)::date, $6, $7)`,
      [ll.landlordId, unitId, leaseId, rent, TZ, inv.rows[0].id,
       opts.suspendedRent ? new Date() : null])
    if (opts.utilityOwed) {
      await c.query(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status,
                               entry_description, due_date, invoice_id, notes)
         VALUES ($1,$2,$3,$4,'utility',$5,'pending','UTILITY',(NOW() AT TIME ZONE $6)::date, $7,
                 'Water meter 03470 → 03537 · 6,700 gal')`,
        [ll.landlordId, unitId, leaseId, tenantId, opts.utilityOwed, TZ, inv.rows[0].id])
    }
    if (opts.workTradeAgreement && tenantId) {
      const a = await c.query<{ id: string }>(
        `INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, start_date, status, monthly_hours_target)
         VALUES ($1,$2,$3,'2026-01-01','active',80) RETURNING id`, [unitId, tenantId, ll.landlordId])
      await c.query(`UPDATE invoices SET work_trade_agreement_id=$2 WHERE id=$1`, [inv.rows[0].id, a.rows[0].id])
    }

    await c.query('COMMIT')
    return { invoiceId: inv.rows[0].id, tenantId, landlordId: ll.landlordId }
  } catch (e) {
    await c.query('ROLLBACK'); throw e
  } finally { c.release() }
}

const lastSend = () => (resendSendMock.mock.calls.at(-1) as any[])![0]

describe('invoice notices', () => {
  it('announces a freshly generated invoice and stamps sent_at', async () => {
    const { invoiceId } = await seedInvoice()
    const r = await sendPendingInvoiceNotices()
    expect(r.sent).toBe(1)

    const mail = lastSend()
    expect(mail.subject).toContain('$460.00')
    expect(mail.html).toContain('Acme Ranch')
    expect(mail.html).toContain('RV 12')
    expect(mail.html).toContain('Rent')

    const { rows } = await db.query(`SELECT sent_at FROM invoices WHERE id=$1`, [invoiceId])
    expect(rows[0].sent_at).not.toBeNull()
  })

  // S652 (Nic): Donald Hamp paid by check the day his bill was made; the next
  // morning's pass mailed him "$137.43 due".
  it('a bill paid before it was announced is never announced as due', async () => {
    const { invoiceId } = await seedInvoice()
    await db.query(`UPDATE invoices SET status = 'settled' WHERE id = $1`, [invoiceId])
    const r = await sendPendingInvoiceNotices()
    expect(r.sent).toBe(0)
    expect(resendSendMock).not.toHaveBeenCalled()
  })

  it('is idempotent — a second pass sends nothing', async () => {
    await seedInvoice()
    expect((await sendPendingInvoiceNotices()).sent).toBe(1)
    resendSendMock.mockClear()
    expect((await sendPendingInvoiceNotices()).sent).toBe(0)
    expect(resendSendMock).not.toHaveBeenCalled()
  })

  // A backfill or an admin catch-up must never turn into a mailout.
  it('leaves an old invoice alone — and does NOT mark it sent', async () => {
    const { invoiceId } = await seedInvoice({ dueDaysAgo: 60 })
    const r = await sendPendingInvoiceNotices()
    expect(r.considered).toBe(0)
    expect(resendSendMock).not.toHaveBeenCalled()

    // claiming we told them when we did not is the bug this file exists to fix
    const { rows } = await db.query(`SELECT sent_at FROM invoices WHERE id=$1`, [invoiceId])
    expect(rows[0].sent_at).toBeNull()
  })

  it('an explicit invoiceId overrides the recency window', async () => {
    const { invoiceId } = await seedInvoice({ dueDaysAgo: 60 })
    const r = await sendPendingInvoiceNotices({ invoiceId })
    expect(r.sent).toBe(1)
  })

  // Nobody to tell — a lease whose primary tenant row is gone still bills.
  it('no address on file: not sent, not stamped, counted', async () => {
    const { invoiceId } = await seedInvoice({ withTenant: false })
    const r = await sendPendingInvoiceNotices()
    expect(r.sent).toBe(0)
    expect(r.skippedNoEmail).toBe(1)
    const { rows } = await db.query(`SELECT sent_at FROM invoices WHERE id=$1`, [invoiceId])
    expect(rows[0].sent_at).toBeNull()
  })

  // Work trade is a real charge that nobody owes. It belongs on the bill as a
  // credit, never in the list of things to pay.
  // S654 (Nic): "Work trade people are on work trade. There's no bills going
  // out to those people." October 1 mailed nine of them "$460.00 due".
  it('a month the trade covers in full is told nothing — and not reconsidered', async () => {
    const { invoiceId } = await seedInvoice({ rent: 460, suspendedRent: true, workTradeAgreement: true, total: 0 })
    const r = await sendPendingInvoiceNotices()
    expect(r.sent).toBe(0)
    expect(r.skippedCovered).toBe(1)
    expect(resendSendMock).not.toHaveBeenCalled()
    const { rows } = await db.query(`SELECT sent_at FROM invoices WHERE id=$1`, [invoiceId])
    expect(rows[0].sent_at).not.toBeNull()
    resendSendMock.mockClear()
    expect((await sendPendingInvoiceNotices()).considered).toBe(0)
  })

  it('a trade that leaves a utility owed announces only the utility', async () => {
    await seedInvoice({ rent: 450, suspendedRent: true, workTradeAgreement: true, utilityOwed: 110.55, total: 110.55 })
    const r = await sendPendingInvoiceNotices()
    expect(r.sent).toBe(1)
    const mail = lastSend()
    expect(mail.subject).toContain('$110.55')
    expect(mail.html).toContain('6,700 gal')
    expect(mail.html).not.toContain('>Rent<')
    expect(mail.html).not.toContain('$450.00')
  })

  it('work trade shows as a credit, and the traded charge is not listed as owed', async () => {
    await seedInvoice({ rent: 460, workTradeCredit: 460, suspendedRent: true })
    const r = await sendPendingInvoiceNotices()
    expect(r.sent).toBe(1)

    const mail = lastSend()
    expect(mail.html).toContain('Work trade')
    expect(mail.html).toContain('-$460.00')
    expect(mail.subject).toContain('nothing due')
  })

  it('scopes to one timezone so each property is told at its own 7am', async () => {
    await seedInvoice()
    const r = await sendPendingInvoiceNotices({ timezone: 'America/New_York' })
    expect(r.considered).toBe(0)
    expect((await sendPendingInvoiceNotices({ timezone: TZ })).sent).toBe(1)
  })
})

// S653 (Nic): "most people are going to see that email, think they owe $900 or
// whatever... they just saw the headline on the email." The headline is the
// number they will actually be asked for.
describe('the headline is what they will actually pay', () => {
  it('nets the paid-ahead money this month may use — capped by their monthly draw', async () => {
    const f = await seedInvoice({ rent: 589 })
    const leaseId = (await db.query(`SELECT lease_id FROM invoices WHERE id=$1`, [f.invoiceId])).rows[0].lease_id
    await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining) VALUES ($1,$2,2000,2000)`, [leaseId, f.tenantId])
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 200 WHERE id=$1`, [leaseId])
    const r = await sendPendingInvoiceNotices()
    expect(r.sent).toBe(1)
    const mail = lastSend()
    expect(mail.subject).toContain('$389.00')            // 589 − 200
    expect(mail.html).toContain('Your paid-ahead credit')
    expect(mail.html).toContain('$200.00')
  })

  it('a line already covered when the bill was made is listed as covered, not due', async () => {
    const f = await seedInvoice({ rent: 589 })
    // a $60 water line the invoice run settled from paid-ahead credit
    const inv = (await db.query(`SELECT lease_id, unit_id, landlord_id FROM invoices WHERE id=$1`, [f.invoiceId])).rows[0]
    await db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, type, amount, status, entry_description, due_date, invoice_id, notes)
       VALUES ($1,$2,$3,'utility',60,'settled','UTILITY',CURRENT_DATE,$4,'Water — covered by prepaid credit (paid ahead)')`,
      [inv.landlord_id, inv.unit_id, inv.lease_id, f.invoiceId])
    await db.query(`UPDATE invoices SET total_amount = 649 WHERE id=$1`, [f.invoiceId])
    const r = await sendPendingInvoiceNotices()
    expect(r.sent).toBe(1)
    const mail = lastSend()
    expect(mail.subject).toContain('$589.00')            // the water is not owed
    expect(mail.html).toContain('covered (paid-ahead credit)')
  })
})
