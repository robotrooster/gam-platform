/**
 * 10/12 (Nic):
 *   G6 — a stay shortened past unpaid rent that a payment was tried on (a
 *        declined card, a returned bank pull): the LANDLORD CHOOSES at that
 *        moment — take those charges off (money already paid on them goes back
 *        to the guest as credit), or keep them owed. Until now that rent was
 *        simply kept, and GAM was told to "decide with the landlord".
 *   G7 — a bill the shortening emptied is VOIDED and kept (it was deleted),
 *        and gives the lease's due date back so the bill run can write that
 *        month again if the stay grows back.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db, getClient } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant, seedAllocationRule,
  setEffectiveProcessingRate,
} from '../test/dbHelpers'
import {
  syncLeaseWithBookingDates, pastEndAttemptedCharges, recordStayShortenedChoice,
  STAY_SHORTENED_CHOSEN_VOID_REASON, STAY_SHORTENED_RENT_VOID_REASON,
} from '../services/bookingLeaseBilling'

const stripeCancel = vi.hoisted(() => vi.fn(async (id: string) => ({ id, status: 'canceled' })))
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig<typeof import('../lib/stripe')>()),
  getStripe: () => ({ paymentIntents: { cancel: stripeCancel } }),
}))

beforeEach(async () => { await cleanupAllSchema(); stripeCancel.mockClear() })

const SUITE_RATE_NOTE = 'bookingLeaseBilling.shortenedChoice suite rate'

// Aug 10 2026 → Jan 28 2027, $950/mo (the same stay jobs/bookingLeaseBilling.test.ts uses).
const START = '2026-08-10'
const END = '2027-01-28'

async function seedStack() {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await seedAllocationRule(client, { propertyId, achFeePayer: 'tenant', cardFeePayer: 'tenant' })
    // 10/17: the rate this file's figures are worked out on, STATED rather than
    // seeded-if-missing: one row is open per method and cleanupAllSchema leaves the
    // rate card alone, so an insert-if-missing took whatever an earlier file left.
    await setEffectiveProcessingRate(client, {
      paymentMethod: 'ach',
      customerFacingFlat: 6, customerFacingPercent: 0,
      stripeCostFlat: 0, stripeCostPercent: 0.5,
      notes: SUITE_RATE_NOTE,
    })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 950, startDate: START })
    await seedLeaseTenant(client, { leaseId, tenantId })
    const bookingId = (await client.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, nights, guest_name, guest_email, status, source)
       VALUES ($1, $2, 'month_to_month', $3, $4, 171, 'Sched Guest', 'sched-guest@test.dev', 'confirmed', 'public') RETURNING id`,
      [unitId, landlordId, START, END])).rows[0].id
    await client.query(
      `UPDATE leases SET lease_source='booking_draft', source_booking_id=$2, end_date=$3, needs_review=false WHERE id=$1`,
      [leaseId, bookingId, END])
    // Arrival and September paid.
    await client.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',696.67,'settled','RENT','2026-08-10'),
              ($1,$2,$3,$4,'rent',950,'settled','RENT','2026-09-01')`, [unitId, tenantId, landlordId, leaseId])
    await client.query('COMMIT')
    return { userId, landlordId, tenantId, propertyId, unitId, leaseId, bookingId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

/** October's rent on its own bill, a bank pull bounced on it (a receipt applied, as the portal writes). */
async function bouncedOctober(s: Awaited<ReturnType<typeof seedStack>>): Promise<{ oct: string; invoiceId: string }> {
  const invoiceId = (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount)
     VALUES ($1, $2, $3, $4, 'INV-OCT', '2026-10-01', 950, 950) RETURNING id`,
    [s.landlordId, s.tenantId, s.leaseId, s.unitId])).rows[0].id
  const oct = (await db.query<{ id: string }>(
    `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, invoice_id, type, amount, status, entry_description, due_date,
                           stripe_payment_intent_id)
     VALUES ($1,$2,$3,$4,$5,'rent',950,'failed','RENT','2026-10-01','pi_oct_bounced') RETURNING id`,
    [s.unitId, s.tenantId, s.landlordId, s.leaseId, invoiceId])).rows[0].id
  const rem = (await db.query<{ id: string }>(
    `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method, stripe_payment_intent_id)
     VALUES ($1,$2,$3,950,950,0,'failed','ach','pi_oct_bounced') RETURNING id`, [s.tenantId, s.leaseId, s.landlordId])).rows[0].id
  await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, 950)`, [rem, oct])
  return { oct, invoiceId }
}

async function shortenTo(s: { bookingId: string }, checkOut: string) {
  await db.query(`UPDATE unit_bookings SET check_out = $2 WHERE id = $1`, [s.bookingId, checkOut])
  await syncLeaseWithBookingDates(s.bookingId)
}

const landlordNote = async (landlordId: string) =>
  (await db.query<any>(`SELECT body, data FROM notifications WHERE type='booking_lease_sync' AND landlord_id=$1`, [landlordId])).rows

describe('G6: what the landlord is asked', () => {
  it('lists rent on the nights a shortening takes away that a payment was tried on — and nothing else', async () => {
    const s = await seedStack()
    const { oct } = await bouncedOctober(s)
    // A plain unpaid November is simply taken off: not asked about.
    await db.query(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,'rent',950,'pending','RENT','2026-11-01')`, [s.unitId, s.tenantId, s.landlordId, s.leaseId])
    const ask = await pastEndAttemptedCharges(s.bookingId, '2026-09-20')
    expect(ask).not.toBeNull()
    expect(ask!.lines).toEqual([{ paymentId: oct, dueDate: '2026-10-01', amount: 950, status: 'failed', paymentTried: true }])
    expect(ask!.words).toContain('The stay now ends September 20, 2026')
    expect(ask!.words).toContain('$950.00 of rent for nights after that (October 2026) had a payment tried on it')
    // Not shorter: nothing to ask.
    expect(await pastEndAttemptedCharges(s.bookingId, END)).toBeNull()
  })
})

describe('G6: the landlord chose to take those charges off', () => {
  it('voids the bounced rent as a record (a receipt points at it — the landlord said so), voids its emptied bill, and tells nobody to decide', async () => {
    const s = await seedStack()
    const { oct, invoiceId } = await bouncedOctober(s)
    const ask = (await pastEndAttemptedCharges(s.bookingId, '2026-09-20'))!
    await recordStayShortenedChoice({ bookingId: s.bookingId, asked: ask, choice: 'void', chosenBy: s.userId })

    await shortenTo(s, '2026-09-20')

    const row = (await db.query<any>(`SELECT status, void_reason, amount::float AS amount, invoice_id FROM payments WHERE id = $1`, [oct])).rows[0]
    expect(row).toEqual({ status: 'voided', void_reason: STAY_SHORTENED_CHOSEN_VOID_REASON, amount: 950, invoice_id: invoiceId })
    // The receipt that pointed at it is kept.
    expect((await db.query(`SELECT 1 FROM remittance_applications WHERE payment_id = $1`, [oct])).rowCount).toBe(1)
    // G7: the emptied bill is voided and kept, and gave the lease's date back.
    const bill = (await db.query<any>(
      `SELECT status, lease_id, voided_from_lease_id, total_amount::float AS total FROM invoices WHERE id = $1`, [invoiceId])).rows[0]
    expect(bill).toEqual({ status: 'void', lease_id: null, voided_from_lease_id: s.leaseId, total: 0 })
    // Nobody is asked to decide with the landlord: they decided.
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'stay_shortened_rent_kept'`)).rowCount).toBe(0)
    const note = await landlordNote(s.landlordId)
    expect(note).toHaveLength(1)
    expect(note[0].body).toContain('as you chose, $950.00 of rent due after the new end (October 2026) that a payment was tried on was taken off')
    expect(note[0].data).toMatchObject({ shortenedChoice: 'void' })
    // Carried out once.
    const c = (await db.query<any>(`SELECT applied_at IS NOT NULL AS applied FROM stay_shortened_charge_choices`)).rows
    expect(c).toEqual([{ applied: true }])
  })

  it('money already paid on it (the guest\'s paid-ahead credit) goes back to them as credit; only the rest is taken off', async () => {
    const s = await seedStack()
    const { oct } = await bouncedOctober(s)
    // $200 of the guest's own paid-ahead money was spent on October before the bank pull for the rest bounced.
    const credit = (await db.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at)
       VALUES ($1, $2, 200, 200, 'gam', now()) RETURNING id`, [s.leaseId, s.tenantId])).rows[0].id
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1, $2, $3, 200, '2026-10-01', 'portal', 'applied', now())`, [credit, oct, s.leaseId])
    const ask = (await pastEndAttemptedCharges(s.bookingId, '2026-09-20'))!
    expect(ask.lines[0].amount).toBe(750)   // what is still unpaid on it
    await recordStayShortenedChoice({ bookingId: s.bookingId, asked: ask, choice: 'void', chosenBy: s.userId })

    await shortenTo(s, '2026-09-20')

    const row = (await db.query<any>(`SELECT status, amount::float AS amount FROM payments WHERE id = $1`, [oct])).rows[0]
    expect(row).toEqual({ status: 'settled', amount: 200 })
    // Banked as money paid ahead: $370.81 over on arrival + September, and the $200 that paid October.
    const banked = (await db.query<any>(
      `SELECT COALESCE(SUM(amount_original), 0)::float AS a FROM lease_prepaid_credits
        WHERE lease_id = $1 AND funded_by = 'reclassified' AND voided_at IS NULL`, [s.leaseId])).rows[0].a
    expect(banked).toBe(570.81)
    const note = await landlordNote(s.landlordId)
    expect(note[0].body).toContain('the $200.00 already paid on it went back to them as money paid ahead')
    // 10/12 (Nic) review: the $200 GAM held (paid ahead through Stripe) is the
    // landlord's share now — booked like any settle from credit — because the
    // guest's new credit is rent that already went out (reclassified, never GAM's).
    expect((await db.query<any>(`SELECT platform_held FROM payments WHERE id = $1`, [oct])).rows[0].platform_held).toBe(true)
    const share = (await db.query<any>(
      `SELECT COALESCE(SUM(amount), 0)::float AS a FROM user_balance_ledger
        WHERE reference_id = $1 AND reference_type = 'payment' AND type = 'allocation_owner_share'`, [oct])).rows[0].a
    expect(share).toBeGreaterThan(0)
  })

  it('10/12 (Nic) review: a bank deposit matched to part of it went to the landlord\'s own bank — the closed row is not GAM-held and pays nothing out', async () => {
    const s = await seedStack()
    const { oct } = await bouncedOctober(s)
    await db.query(`UPDATE payments SET platform_held = TRUE WHERE id = $1`, [oct])   // what the tried pull set, never cleared
    const conn = (await db.query<{ id: string }>(
      `INSERT INTO bank_connections (landlord_id, provider, status) VALUES ($1,'stripe_fc','active') RETURNING id`, [s.landlordId])).rows[0].id
    const line = (await db.query<{ id: string }>(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status, bank_status)
       VALUES ($1,$2,'dep-oct-part','2026-10-03',300,'BRANCH DEPOSIT','matched','posted') RETURNING id`, [conn, s.landlordId])).rows[0].id
    await db.query(
      `INSERT INTO bank_deposit_allocations (bank_transaction_id, payment_id, landlord_id, amount, effective_paid_date)
       VALUES ($1,$2,$3,300,'2026-10-03')`, [line, oct, s.landlordId])
    const ask = (await pastEndAttemptedCharges(s.bookingId, '2026-09-20'))!
    await recordStayShortenedChoice({ bookingId: s.bookingId, asked: ask, choice: 'void', chosenBy: s.userId })

    await shortenTo(s, '2026-09-20')

    expect((await db.query<any>(`SELECT status, amount::float AS amount, platform_held FROM payments WHERE id = $1`, [oct])).rows[0])
      .toEqual({ status: 'settled', amount: 300, platform_held: false })
    expect((await db.query(
      `SELECT 1 FROM user_balance_ledger WHERE reference_id = $1 AND reference_type = 'payment'`, [oct])).rowCount).toBe(0)
    // The $300 is banked back as the guest's money paid ahead — rent that went to the landlord (reclassified).
    const banked = (await db.query<any>(
      `SELECT COALESCE(SUM(amount_original), 0)::float AS a FROM lease_prepaid_credits
        WHERE lease_id = $1 AND funded_by = 'reclassified' AND voided_at IS NULL`, [s.leaseId])).rows[0].a
    expect(banked).toBe(670.81)
  })
})

describe('G6: the landlord chose to keep them owed', () => {
  it('the bounced rent stays owed, and GAM is not asked to decide', async () => {
    const s = await seedStack()
    const { oct } = await bouncedOctober(s)
    const ask = (await pastEndAttemptedCharges(s.bookingId, '2026-09-20'))!
    await recordStayShortenedChoice({ bookingId: s.bookingId, asked: ask, choice: 'keep', chosenBy: s.userId })

    await shortenTo(s, '2026-09-20')

    expect((await db.query<any>(`SELECT status FROM payments WHERE id = $1`, [oct])).rows[0].status).toBe('failed')
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'stay_shortened_rent_kept'`)).rowCount).toBe(0)
    const note = await landlordNote(s.landlordId)
    expect(note[0].body).toContain('as you chose, $950.00 of rent due after the new end (October 2026) that a payment was tried on stays owed')
  })

  it('without an answer (a sync from elsewhere), it is kept and GAM is told, as before', async () => {
    const s = await seedStack()
    await bouncedOctober(s)
    await shortenTo(s, '2026-09-20')
    expect((await db.query(`SELECT 1 FROM admin_notifications WHERE category = 'stay_shortened_rent_kept'`)).rowCount).toBe(1)
  })
})

describe('G7: a bill a shortened stay emptied', () => {
  it('is voided and kept, and the bill run can write that month again when the stay grows back', async () => {
    const s = await seedStack()
    const invoiceId = (await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount)
       VALUES ($1, $2, $3, $4, 'INV-NOV', '2026-11-01', 950, 950) RETURNING id`,
      [s.landlordId, s.tenantId, s.leaseId, s.unitId])).rows[0].id
    const nov = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, tenant_id, landlord_id, lease_id, invoice_id, type, amount, status, entry_description, due_date)
       VALUES ($1,$2,$3,$4,$5,'rent',950,'pending','RENT','2026-11-01') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId, s.leaseId, invoiceId])).rows[0].id
    // 10/12 (Nic) review: November's work-trade period was open on that bill.
    const agreement = (await db.query<{ id: string }>(
      `INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, start_date) VALUES ($1,$2,$3,'2026-08-10') RETURNING id`,
      [s.unitId, s.tenantId, s.landlordId])).rows[0].id
    const period = (await db.query<{ id: string }>(
      `INSERT INTO work_trade_settlements (agreement_id, invoice_id, period_month, target_hours, hour_rate, basis_amount, period_start, period_end)
       VALUES ($1,$2,'2026-11-01',80,11.875,950,'2026-11-01','2026-11-30') RETURNING id`, [agreement, invoiceId])).rows[0].id

    await shortenTo(s, '2026-10-20')

    const row = (await db.query<any>(`SELECT status, void_reason, invoice_id FROM payments WHERE id = $1`, [nov])).rows[0]
    expect(row).toEqual({ status: 'voided', void_reason: STAY_SHORTENED_RENT_VOID_REASON, invoice_id: invoiceId })
    const bill = (await db.query<any>(
      `SELECT status, lease_id, voided_from_lease_id, notes FROM invoices WHERE id = $1`, [invoiceId])).rows[0]
    expect(bill).toMatchObject({ status: 'void', lease_id: null, voided_from_lease_id: s.leaseId })
    expect(bill.notes).toContain('Voided: the stay now ends October 20, 2026')
    // Its open work-trade period has nothing left to credit: voided and kept, never closed onto the void bill.
    const wt = (await db.query<any>(`SELECT status, voided_at IS NOT NULL AS voided, void_reason FROM work_trade_settlements WHERE id = $1`, [period])).rows[0]
    expect(wt).toMatchObject({ status: 'voided', voided: true })
    expect(wt.void_reason).toContain('the stay now ends October 20, 2026')
    // The lease's November slot is free again: the bill run's own insert goes through.
    const again = await db.query(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount)
       VALUES ($1, $2, $3, $4, 'INV-NOV-2', '2026-11-01', 950, 950)
       ON CONFLICT (lease_id, due_date) DO NOTHING RETURNING id`, [s.landlordId, s.tenantId, s.leaseId, s.unitId])
    expect(again.rowCount).toBe(1)
  })
})
