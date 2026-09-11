/**
 * S641 — the tenant gets told their bill exists.
 *
 * Nic: "a lot of people are saying, oh, I never got my bill. I don't know what
 * I owe." Invoice generation sent no email at all; the only billing mail a
 * tenant had ever received was a late notice.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

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

async function seedInvoice(opts: {
  dueDaysAgo?: number
  rent?: number
  tenantEmail?: string
  withTenant?: boolean
  workTradeCredit?: number
  suspendedRent?: boolean
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
       TZ, opts.dueDaysAgo ?? 0, rent, rent - (opts.workTradeCredit ?? 0), opts.workTradeCredit ?? 0])

    await c.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, type, amount, status,
                             entry_description, due_date, invoice_id, work_trade_suspended_at)
       VALUES ($1,$2,$3,'rent',$4,'pending','RENT',(NOW() AT TIME ZONE $5)::date, $6, $7)`,
      [ll.landlordId, unitId, leaseId, rent, TZ, inv.rows[0].id,
       opts.suspendedRent ? new Date() : null])

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
