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
// A real dispute runs paymentReversal.handlePaymentReversal; its side trips
// (late-fee back-fill, the landlord's alert, the recovery decision) are not read here.
vi.mock('../jobs/lateFees', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  generateLateFeesForInvoice: vi.fn(async () => ({ invoicesScanned: 0, rowsWritten: 0, capsHit: 0, errors: [] })),
}))
vi.mock('./responsibleParty', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), getPropertyResponsibleParty: vi.fn(async () => null),
}))
vi.mock('./reversalRecovery', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), decideReversalRecovery: vi.fn(async () => null),
}))

import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease, seedTenant, seedLeaseTenant, seedUtilityMeter, seedUtilityBill } from '../test/dbHelpers'
import { sendPendingInvoiceNotices, payNowLink, chargeLabel, chargeDetail, chargeLabelColumnsSql } from './invoiceNotice'
import { handlePaymentReversal } from './paymentReversal'
import { sendPaymentReceipt } from './paymentReceipt'
import { portalLink } from '../lib/portalUrls'
import { verifyEmailFactorToken } from '../routes/emailOtp'

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

  // S654 (Nic): the Pay now link signs the resident in with just their password.
  it('the Pay now link vouches for the resident\'s inbox and lands on Payments', async () => {
    const { tenantId } = await seedInvoice()
    await sendPendingInvoiceNotices()
    const html: string = lastSend().html
    const m = html.match(/\/login\?ef=([^&"']+)&amp;to=([^"']+)|\/login\?ef=([^&"']+)&to=([^"']+)/)
    expect(m).not.toBeNull()
    const ef = decodeURIComponent(m![1] ?? m![3]); const to = decodeURIComponent(m![2] ?? m![4])
    expect(to).toBe('/payments')
    const { rows: [t] } = await db.query<{ user_id: string; email: string }>(
      `SELECT t.user_id, u.email FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [tenantId])
    expect(verifyEmailFactorToken(ef)).toEqual({ userId: t.user_id, email: t.email })
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
// whatever... they just saw the headline on the email."
// S655 (Nic, 10/2): "credit auto-applies only when it covers the WHOLE bill;
// otherwise the tenant is asked, 'Use all $X' or 'Save it for later'." So the
// headline is the FULL bill, and the credit is a sentence beside it saying what
// Pay Now will offer — never a deduction they did not choose.
describe('the full bill, with the credit Pay Now will offer beside it', () => {
  it('the email shows the full bill and the credit Pay Now will offer (capped by the monthly draw)', async () => {
    const f = await seedInvoice({ rent: 589 })
    const leaseId = (await db.query(`SELECT lease_id FROM invoices WHERE id=$1`, [f.invoiceId])).rows[0].lease_id
    await db.query(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by) VALUES ($1,$2,2000,2000,'landlord')`, [leaseId, f.tenantId])
    await db.query(`UPDATE leases SET prepaid_monthly_draw = 200 WHERE id=$1`, [leaseId])
    const r = await sendPendingInvoiceNotices()
    expect(r.sent).toBe(1)
    const mail = lastSend()
    expect(mail.subject).toContain('$589.00')            // nothing netted
    expect(mail.html).toMatch(/You have <strong[^>]*>\$200\.00<\/strong> credit available — you can use it when you pay\./)
    expect(mail.html).not.toContain('Your paid-ahead credit')
    expect(mail.html).not.toContain('-$200.00')
  })

  it('a credit smaller than the bill is said beside it and changes nothing (MH 25: $10 against $460)', async () => {
    const f = await seedInvoice({ rent: 460 })
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, status)
       VALUES ($1,$2,NULL,10,10,'goodwill','test','active')`, [f.landlordId, f.tenantId])
    await sendPendingInvoiceNotices()
    const mail = lastSend()
    expect(mail.subject).toContain('$460.00')
    expect(mail.html).toContain('$10.00</strong> credit available')
  })

  it('no credit, no credit sentence', async () => {
    await seedInvoice({ rent: 460 })
    await sendPendingInvoiceNotices()
    expect(lastSend().html).not.toContain('credit available')
  })

  it('a line the account credit already paid is listed as covered, not due', async () => {
    const f = await seedInvoice({ rent: 589 })
    const inv = (await db.query(`SELECT lease_id, unit_id, landlord_id FROM invoices WHERE id=$1`, [f.invoiceId])).rows[0]
    // a $60 water line the bill run paid from paid-ahead money (credit_uses, applied)
    const w = await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date, invoice_id, notes)
       VALUES ($1,$2,$3,$4,'utility',60,'pending','UTILITY',CURRENT_DATE,$5,'Water — covered by prepaid credit (paid ahead)') RETURNING id`,
      [inv.landlord_id, inv.unit_id, inv.lease_id, f.tenantId, f.invoiceId])
    const c = await db.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by)
       VALUES ($1,$2,60,60,'landlord') RETURNING id`, [inv.lease_id, f.tenantId])
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1,$2,$3,60,date_trunc('month', CURRENT_DATE)::date,'whole_bill','applied',NOW())`,
      [c.rows[0].id, w.rows[0].id, inv.lease_id])
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`, [w.rows[0].id])
    await db.query(`UPDATE invoices SET total_amount = 649 WHERE id=$1`, [f.invoiceId])
    const r = await sendPendingInvoiceNotices()
    expect(r.sent).toBe(1)
    const mail = lastSend()
    expect(mail.subject).toContain('$589.00')            // the water is not owed
    expect(mail.html).toContain('covered (paid with your account credit)')
    // the tag is beside the name, never the name
    expect(mail.html).not.toContain('covered by prepaid credit')
  })

  it('a late fee already on the bill is part of what it owes', async () => {
    const f = await seedInvoice({ rent: 460 })
    const inv = (await db.query(`SELECT lease_id, unit_id, landlord_id FROM invoices WHERE id=$1`, [f.invoiceId])).rows[0]
    await db.query(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date, invoice_id)
       VALUES ($1,$2,$3,$4,'late_fee',15,'pending','LATEFEE',CURRENT_DATE,$5)`,
      [inv.landlord_id, inv.unit_id, inv.lease_id, f.tenantId, f.invoiceId])
    await sendPendingInvoiceNotices({ invoiceId: f.invoiceId, updated: true })
    const mail = lastSend()
    expect(mail.subject).toContain('$475.00')
    expect(mail.html).toContain('Late fee')
  })
})

// decisions #17 (Nic, 10/3): "Bill and email lines name the utility: 'Water',
// 'Electric', 'Trash', 'Sewer' — never a generic 'Utilities' line." Kim
// Harland's October email read "Utilities $10.45" (water) and "Utilities $25" (trash).
describe('each line names what it is', () => {
  async function utilityLine(f: { invoiceId: string; tenantId: string | null }, type: 'water' | 'trash' | 'electric', amount: number, note: string | null) {
    const c = await db.connect()
    try {
      const inv = (await c.query(`SELECT i.lease_id, i.unit_id, i.landlord_id, u.property_id FROM invoices i JOIN units u ON u.id = i.unit_id WHERE i.id=$1`, [f.invoiceId])).rows[0]
      const p = await c.query<{ id: string }>(
        `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date, invoice_id, notes)
         VALUES ($1,$2,$3,$4,'utility',$5,'pending','UTILITY',CURRENT_DATE,$6,$7) RETURNING id`,
        [inv.landlord_id, inv.unit_id, inv.lease_id, f.tenantId, amount, f.invoiceId, note])
      const meterId = await seedUtilityMeter(c, { propertyId: inv.property_id, utilityType: type })
      await seedUtilityBill(c, { meterId, unitId: inv.unit_id, tenantId: f.tenantId!, leaseId: inv.lease_id,
        landlordId: inv.landlord_id, chargeAmount: amount, paymentId: p.rows[0].id, utilityType: type })
    } finally { c.release() }
  }

  it('Kim Harland, October: Water and Trash, never "Utilities"', async () => {
    const f = await seedInvoice({ rent: 450 })
    await utilityLine(f, 'water', 10.45, null)
    await utilityLine(f, 'trash', 25, null)
    await sendPendingInvoiceNotices()
    const mail = lastSend()
    expect(mail.html).toContain('Water')
    expect(mail.html).toContain('Trash')
    expect(mail.html).not.toContain('Utilities')
    expect(mail.subject).toContain('$485.45')
  })

  it('a payment tag in a note is never the line\'s name; the meter read is its detail', async () => {
    const f = await seedInvoice({ rent: 450 })
    await utilityLine(f, 'electric', 46.2, 'Electric meter 44999 → 45219 (Sep 2 → Sep 30) · 220 kWh — Recorded as manual cash payment')
    await sendPendingInvoiceNotices()
    const html: string = lastSend().html
    expect(html).toContain('Electric')
    expect(html).toContain('meter 44999 → 45219 (Sep 2 → Sep 30) · 220 kWh')
    expect(html).not.toContain('Recorded as manual')
  })

  // A dispute or bank return reopens a charge as a NEW row (paymentReversal):
  // no utility bill, no lease fee, only the note "Reopened after payment
  // reversal". It is still the same charge, and is named as it was.
  const disputeIt = (paymentId: string, amount: number, eventId: string) => handlePaymentReversal({
    paymentId, reversalType: 'card_dispute', reversedAmount: amount, reversalFee: 0, stripeEventId: eventId, rawEvent: {},
  })
  const settleByCard = (id: string, pi: string) => db.query(
    `UPDATE payments SET status='settled', settled_at=NOW(), stripe_payment_intent_id=$2 WHERE id=$1`, [id, pi])
  const reopenedBy = async (reversalId: string | undefined) =>
    (await db.query<{ id: string }>(`SELECT id FROM payments WHERE reversal_id = $1`, [reversalId])).rows[0].id

  it('a disputed water line\'s reopened row is named Water on the bill email and the receipt', async () => {
    const f = await seedInvoice({ rent: 450 })
    await utilityLine(f, 'water', 40, null)
    const water = (await db.query<{ id: string }>(
      `SELECT id FROM payments WHERE invoice_id = $1 AND type = 'utility'`, [f.invoiceId])).rows[0].id
    await settleByCard(water, 'pi_water_disputed')
    const rev = await disputeIt(water, 40, 'evt_water_disputed')
    expect(rev.handled).toBe(true)
    const reopened = await reopenedBy(rev.reversalId)

    // The bill email: the original is not owed, the reopened row is, as Water.
    await sendPendingInvoiceNotices({ invoiceId: f.invoiceId })
    const bill: string = lastSend().html
    expect(bill).toContain('Water')
    expect(bill).not.toMatch(/Reopened|>\s*Utility\s*</)
    expect(lastSend().subject).toContain('$490.00')

    // The receipt once the reopened water is paid at the desk.
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW(), manual_method='cash' WHERE id=$1`, [reopened])
    resendSendMock.mockClear()
    expect(await sendPaymentReceipt({ paymentIds: [reopened], method: 'cash' })).not.toBeNull()
    const receipt: string = lastSend().html
    expect(receipt).toContain('Water')
    expect(receipt).not.toMatch(/Reopened|>\s*Utility\s*</)
  })

  it('a reopened lease fee keeps its fee name, and a line disputed twice is still named by the charge first billed', async () => {
    const f = await seedInvoice({ rent: 450 })
    const inv = (await db.query(`SELECT lease_id, unit_id, landlord_id FROM invoices WHERE id=$1`, [f.invoiceId])).rows[0]
    const fee = (await db.query<{ id: string }>(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing, description)
       VALUES ($1,'pet_rent',25,false,'monthly_ongoing',NULL) RETURNING id`, [inv.lease_id])).rows[0].id
    const pet = (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date, invoice_id, lease_fee_id)
       VALUES ($1,$2,$3,$4,'fee',25,'pending','OTHERFEE',CURRENT_DATE,$5,$6) RETURNING id`,
      [inv.landlord_id, inv.unit_id, inv.lease_id, f.tenantId, f.invoiceId, fee])).rows[0].id
    const elec = (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date, invoice_id, notes)
       VALUES ($1,$2,$3,$4,'utility',22.47,'pending','UTILITY',CURRENT_DATE,$5,
               'Electric meter 86386 → 86493 (Sep 2 → Sep 30) · 107 kWh') RETURNING id`,
      [inv.landlord_id, inv.unit_id, inv.lease_id, f.tenantId, f.invoiceId])).rows[0].id

    await settleByCard(pet, 'pi_pet_1')
    const petAgain = await reopenedBy((await disputeIt(pet, 25, 'evt_pet_1')).reversalId)
    // Paid again by card, and disputed again.
    await settleByCard(petAgain, 'pi_pet_2')
    const petThird = await reopenedBy((await disputeIt(petAgain, 25, 'evt_pet_2')).reversalId)
    await settleByCard(elec, 'pi_elec_1')
    const elecAgain = await reopenedBy((await disputeIt(elec, 22.47, 'evt_elec_1')).reversalId)

    const row = async (id: string) => (await db.query<any>(
      `SELECT p.type, p.notes, p.entry_description, ${chargeLabelColumnsSql('p')} FROM payments p WHERE p.id = $1`, [id])).rows[0]
    for (const id of [petAgain, petThird]) {
      const r = await row(id)
      expect(r.fee_type).toBe('pet_rent')
      expect(chargeLabel(r)).toBe('Pet rent')
      expect(chargeDetail(r)).toBeNull()
    }
    // Named by its meter read, which only the charge first billed carries.
    const e = await row(elecAgain)
    expect(chargeLabel(e)).toBe('Electric')
    expect(chargeDetail(e)).toBe('meter 86386 → 86493 (Sep 2 → Sep 30) · 107 kWh')
    // A charge that was never reopened reads exactly as before.
    expect(await row(elec).then(r => r.origin_notes)).toBeNull()

    // A note with more than one segment: the reopen copies only its first
    // ("Final electric — reopened after a payment reversal"), and the line
    // owed again still reads the whole original, meter read included.
    const fin = (await db.query<{ id: string }>(
      `INSERT INTO payments (landlord_id, unit_id, lease_id, tenant_id, type, amount, status, entry_description, due_date, invoice_id, notes)
       VALUES ($1,$2,$3,$4,'utility',18.20,'pending','UTILITY',CURRENT_DATE,$5,'Final electric — meter 100 → 200') RETURNING id`,
      [inv.landlord_id, inv.unit_id, inv.lease_id, f.tenantId, f.invoiceId])).rows[0].id
    await settleByCard(fin, 'pi_fin_1')
    const finAgain = await reopenedBy((await disputeIt(fin, 18.20, 'evt_fin_1')).reversalId)
    const fa = await row(finAgain)
    expect(fa.notes).toBe('Final electric — reopened after a payment reversal')
    expect(chargeLabel(fa)).toBe('Electric')
    expect(chargeDetail(fa)).toBe(chargeDetail(await row(fin)))
    expect(chargeDetail(fa)).toBe('Final electric — meter 100 → 200')
  })
})

describe('chargeLabel / chargeDetail', () => {
  it('names a charge by what it is, from its bill, its fee, its code, its type', () => {
    expect(chargeLabel({ type: 'rent', notes: 'Recorded as manual cash payment' })).toBe('Rent')
    expect(chargeLabel({ type: 'utility', utility_type: 'water', notes: 'Recorded as manual money_order payment (ref 55187081609)' })).toBe('Water')
    expect(chargeLabel({ type: 'utility', notes: 'RV 44 — Electric meter 22646 → 22734 (Sep 27 → Sep 30) · 88 kWh' })).toBe('Electric')
    expect(chargeLabel({ type: 'utility', notes: null })).toBe('Utility')
    expect(chargeLabel({ type: 'utility', entry_description: 'PROPANE', notes: null })).toBe('Propane')
    expect(chargeLabel({ type: 'fee', fee_type: 'trash_fee', notes: null })).toBe('Trash')
    expect(chargeLabel({ type: 'fee', fee_type: 'pet_rent', notes: null })).toBe('Pet rent')
    expect(chargeLabel({ type: 'fee', entry_description: 'DECLINEFEE', notes: null })).toBe('Declined-payment fee')
    expect(chargeLabel({ type: 'late_fee', notes: 'Waived by landlord 10/3: moved' })).toBe('Late fee')
    expect(chargeLabel({ type: 'home_payment', notes: 'Home payment 104 of 132' })).toBe('Home payment')
  })

  it('keeps the read or the period as detail, and drops payment tags, the space and internal notes', () => {
    expect(chargeDetail({ type: 'utility', notes: 'Water — Aug 2026 (used before the lease was signed) — Recorded as manual check payment (ref 1292)' }))
      .toBe('Aug 2026 (used before the lease was signed)')
    expect(chargeDetail({ type: 'utility', notes: 'RV 44 — Electric meter 22646 → 22734 · 88 kWh' })).toBe('meter 22646 → 22734 · 88 kWh')
    expect(chargeDetail({ type: 'home_payment', notes: 'Home payment 104 of 132' })).toBe('104 of 132')
    expect(chargeDetail({ type: 'rent', notes: 'S652: corrected to the agreed $440 rent' })).toBeNull()
    expect(chargeDetail({ type: 'utility', notes: 'Work trade — suspended while the hours are worked; settled at month close' })).toBeNull()
    expect(chargeDetail({ type: 'rent', notes: null })).toBeNull()
  })

  it('a reopened charge is named and detailed by the charge it was reopened from, never by its reopen note', () => {
    const reopened = { type: 'utility', notes: 'Reopened after payment reversal', origin_notes: 'Water — Aug 2026 (used before the lease was signed)' }
    expect(chargeLabel(reopened)).toBe('Water')
    expect(chargeDetail(reopened)).toBe('Aug 2026 (used before the lease was signed)')
    expect(chargeLabel({ type: 'utility', notes: 'Reopened after payment reversal', origin_notes: null })).toBe('Utility')
    // Its own note wins when it says what the charge is.
    expect(chargeLabel({ type: 'utility', notes: 'Trash', origin_notes: 'Water' })).toBe('Trash')
    // The reopen copies only the FIRST segment of the original's note: a final
    // meter bill keeps its read wherever the line is owed again.
    const finalBill = {
      type: 'utility', utility_type: 'electric',
      notes: 'Final electric — reopened after a payment reversal',
      origin_notes: 'Final electric — meter 100 → 200',
    }
    expect(chargeLabel(finalBill)).toBe('Electric')
    expect(chargeDetail(finalBill)).toBe('Final electric — meter 100 → 200')
    expect(chargeDetail({ type: 'utility', utility_type: 'electric', notes: 'Final electric — meter 100 → 200' }))
      .toBe('Final electric — meter 100 → 200')
    // Disputed twice: the copy of a copy still reads the original whole.
    expect(chargeDetail({ ...finalBill, notes: 'Final electric — reopened after a payment reversal' })).toBe('Final electric — meter 100 → 200')
  })
})

// S654: payNowLink is shared by every tenant email that sends someone to pay
// (the bill, the landlord's balance reminder, the bank-setup nudge).
describe('payNowLink', () => {
  it('signs the token for the account and its login email, landing on Payments', () => {
    const userId = randomUUID()
    const link = payNowLink({ tenant_user_id: userId, tenant_email: 'pat@mailer-test.co' })
    const u = new URL(link)
    expect(link.startsWith(portalLink('tenant', 'login?ef='))).toBe(true)
    expect(u.searchParams.get('to')).toBe('/payments')
    expect(verifyEmailFactorToken(u.searchParams.get('ef')!)).toEqual({ userId, email: 'pat@mailer-test.co' })
  })

  it('no portal account (no user or no login email) gets the plain Payments link', () => {
    expect(payNowLink({ tenant_user_id: null, tenant_email: 'pat@mailer-test.co' })).toBe(portalLink('tenant', 'payments'))
    expect(payNowLink({ tenant_user_id: randomUUID(), tenant_email: null })).toBe(portalLink('tenant', 'payments'))
  })
})
