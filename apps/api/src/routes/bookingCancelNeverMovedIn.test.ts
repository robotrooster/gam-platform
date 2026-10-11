/**
 * Step 9 final fix (fix pass 1) — CANCEL RESERVATION CLOSES THE LEASE DRAFTED
 * WITH IT (decisions #46.4: "never moved in → zero the unpaid move-in bill and
 * end the lease").
 *
 * A stay of 30 nights or more drafts a lease alongside it. Canceling the stay
 * on the Schedule used to end that lease with a bare UPDATE after the save:
 * the lease went 'terminated' and its move-in bill (issued by the landlord's
 * signature) stayed owed for a tenancy that never happened, and "They never
 * moved in" then said "This lease has already ended. Nothing else to do."
 * There is no no-show button on the Schedule, so canceling the stay is staff
 * saying the guest is not coming: the cancel now runs the same never-moved-in
 * close (lib/unwindIssuedLease.endLeaseNeverMovedIn, attested) in the same
 * transaction. When the close does not apply the cancel is refused in plain
 * words naming a step that exists, and nothing changes.
 *
 * These drive the real route (PATCH /api/units/:id/bookings/:bookingId), not a
 * direct status write.
 *
 * Final fix (fix pass 1, decisions #53): the close zeroes ONLY the unpaid
 * move-in bill (later bills stay owed, listed as "stays owed"); it is refused
 * whenever the stay was EVER checked in (its history, not only its status);
 * and it never runs blind — a cancel that would zero a bill or end a lease in
 * force must carry the total its confirm showed (expectedNeverMovedInTotal),
 * read from GET …/cancel-check. Tests that sent a bare cancel and expected it
 * to zero the bill now send the confirm's total (renamed where the name said
 * otherwise).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { unitsRouter } from './units'
import { incomeEvents } from '../services/incomeBasis'
import { leasesRouter } from './leases'
import { errorHandler } from '../middleware/errorHandler'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_booking_cancel_nmi'

// Fix pass 2 (review): the after-commit history diff can fail (it is
// best-effort). `fail` makes it fail, to prove a check-in and its set-back are
// written to the stay's history by the save itself.
const historyDiff = vi.hoisted(() => ({ fail: false }))
vi.mock('../services/bookingEvents', async () => {
  const actual = await vi.importActual<typeof import('../services/bookingEvents')>('../services/bookingEvents')
  return {
    ...actual,
    recordBookingChange: async (...a: Parameters<typeof actual.recordBookingChange>) => {
      if (historyDiff.fail) throw new Error('history insert failed')
      return actual.recordBookingChange(...a)
    },
  }
})

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/units', unitsRouter)
  app.use('/api/leases', leasesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => { historyDiff.fail = false; await cleanupAllSchema() })

/**
 * A confirmed stay of 60 nights starting in five days, with the lease drafted
 * from it — 'pending', the tenant and the landlord signed (the signature issued
 * its move-in bill: $1,000 rent + $500 deposit, unpaid). `leaseStatus` makes it
 * something else.
 */
async function stayWithDraftedLease(o: { leaseStatus?: 'pending' | 'active'; bill?: boolean } = {}) {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 1000, unitType: 'rv_spot' })
    const bookingId = (await c.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, tenant_id, guest_name, check_in, check_out, nights, status, lease_type, total_amount)
       VALUES ($1, $2, $3, 'Pat Guest', CURRENT_DATE + 5, CURRENT_DATE + 65, 60, 'confirmed', 'month_to_month', 2000) RETURNING id`,
      [unitId, landlordId, tenantId])).rows[0].id
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 1000, status: o.leaseStatus ?? 'pending' })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query(
      `UPDATE leases SET lease_source = 'booking_draft', source_booking_id = $2, signed_by_tenant = TRUE, signed_by_landlord = TRUE,
                         lease_type = 'month_to_month', start_date = CURRENT_DATE + 5, end_date = NULL
        WHERE id = $1`, [leaseId, bookingId])
    let inv: string | null = null
    const lines: string[] = []
    if (o.bill !== false) {
      inv = (await c.query<{ id: string }>(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, subtotal_deposits, total_amount)
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE + 5, 1000, 500, 1500) RETURNING id`,
        [landlordId, tenantId, leaseId, unitId, `INV-${randomUUID().slice(0, 8)}`])).rows[0].id
      for (const [type, entry, amount] of [['rent', 'RENT', 1000], ['deposit', 'DEPOSIT', 500]] as const) {
        lines.push((await c.query<{ id: string }>(
          `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', CURRENT_DATE + 5, $8) RETURNING id`,
          [inv, unitId, leaseId, tenantId, landlordId, type, amount, entry])).rows[0].id)
      }
    }
    const token = jwt.sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { userId, landlordId, tenantId, propertyId, unitId, bookingId, leaseId, inv, lines, token }
  } finally { c.release() }
}

/**
 * Cancel reservation as the Schedule's confirm sends it. Fix pass 3 (review):
 * the confirm always sends the lease count with its total, and the server now
 * requires both — so a total given here without a count carries the one lease
 * these fixtures draft. A test of a total sent ALONE uses `cancelRaw`.
 */
const cancelRaw = (f: { unitId: string; bookingId: string; token: string }, body: Record<string, unknown>) =>
  request(buildApp()).patch(`/api/units/${f.unitId}/bookings/${f.bookingId}`)
    .set('Authorization', `Bearer ${f.token}`).send(body)
const cancel = (f: { unitId: string; bookingId: string; token: string }, extra: Record<string, unknown> = {}) =>
  cancelRaw(f, {
    status: 'cancelled',
    ...('expectedNeverMovedInTotal' in extra && !('expectedNeverMovedInLeases' in extra) ? { expectedNeverMovedInLeases: 1 } : {}),
    ...extra,
  })

/**
 * GAM's $1 declined-card fee, written exactly as the Stripe webhook writes it
 * (routes/webhooks.ts, payment_intent.payment_failed on a card): copied from
 * the declined line — its space, lease, tenant, landlord and bill — 'pending',
 * 'DECLINEFEE', due today, the deterministic note, revenue_owner 'gam'.
 */
const declineFeeLikeTheWebhook = (declinedPaymentId: string, intent: string) => db.query(
  `INSERT INTO payments
     (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
      entry_description, due_date, invoice_id, notes, revenue_owner)
   SELECT p.unit_id, p.lease_id, p.tenant_id, p.landlord_id, 'fee', $2,
          'pending', 'DECLINEFEE', CURRENT_DATE, p.invoice_id, $3, 'gam'
     FROM payments p
    WHERE p.id = $1
      AND p.tenant_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM payments d WHERE d.entry_description = 'DECLINEFEE' AND d.notes = $3)`,
  [declinedPaymentId, '1.00', `Declined card attempt — ${intent}`])

/** A team member (not the owner) with exactly these permissions. */
async function staffToken(landlordId: string, permissions: Record<string, boolean>): Promise<string> {
  const u = (await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'property_manager', 'Desk', 'Staff', TRUE) RETURNING id`,
    [`desk-${randomUUID()}@test.dev`])).rows[0].id
  await db.query(
    `INSERT INTO property_manager_scopes (user_id, landlord_id, property_ids, all_properties)
     VALUES ($1, $2, '{}', TRUE)`, [u, landlordId])
  return jwt.sign({ userId: u, role: 'property_manager', email: 'desk@test.dev', profileId: u,
    landlordId, permissions }, process.env.JWT_SECRET!, { expiresIn: '1h' })
}

/** The words GAM's kept $1 fee gets, as the close says them (read from the confirm, so one source). */
const keptWordsOf = async (f: { leaseId: string; token: string }) =>
  (await request(buildApp()).get(`/api/leases/${f.leaseId}/never-moved-in`).set('Authorization', `Bearer ${f.token}`)).body.data.kept_words as string

const owed = async (tenantId: string) => (await db.query<{ n: number }>(
  `SELECT COUNT(*)::int AS n FROM payments WHERE tenant_id = $1 AND status IN ('pending', 'failed') AND amount > 0`, [tenantId])).rows[0].n

const bookingStatus = async (id: string) => (await db.query(`SELECT status FROM unit_bookings WHERE id = $1`, [id])).rows[0].status
const leaseStatus = async (id: string) => (await db.query(`SELECT status, termination_reason FROM leases WHERE id = $1`, [id])).rows[0]

describe('Cancel reservation runs the never-moved-in close on the lease drafted with the stay — in the same save', () => {
  it('a signed lease with its move-in bill unpaid: the cancel sent with the confirm’s total ends the lease, zeroes the bill and voids it, and says so — never a bill left owed', async () => {
    const f = await stayWithDraftedLease()
    const res = await cancel(f, { expectedNeverMovedInTotal: 1500 })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('cancelled')
    expect(res.body.data.leaseClosed).toBe('Pat Guest\'s lease drafted with this reservation ended with it. Nothing was paid on it, so the $1,500.00 move-in bill is no longer owed.')
    expect(await leaseStatus(f.leaseId)).toEqual({ status: 'terminated', termination_reason: 'The tenant never moved in' })
    expect(await owed(f.tenantId)).toBe(0)
    expect((await db.query(`SELECT status FROM invoices WHERE id = $1`, [f.inv])).rows[0].status).toBe('void')
    expect((await db.query(`SELECT status, removed_reason FROM lease_tenants WHERE lease_id = $1`, [f.leaseId])).rows[0])
      .toEqual({ status: 'removed', removed_reason: 'lease_ended' })
    // "They never moved in" on that lease then says the truth — nothing left — never a dead end with a bill owed.
    const after = await request(buildApp()).get(`/api/leases/${f.leaseId}/never-moved-in`).set('Authorization', `Bearer ${f.token}`)
    expect(after.body.data.words).toBe('This lease has already ended and nothing on it is still owed. Nothing else to do.')
  })

  it('an unsigned draft with no bill: the cancel ends it as before, nothing owed', async () => {
    const f = await stayWithDraftedLease({ bill: false })
    await db.query(`UPDATE leases SET signed_by_tenant = FALSE, signed_by_landlord = FALSE WHERE id = $1`, [f.leaseId])
    const res = await cancel(f)
    expect(res.status).toBe(200)
    expect(res.body.data.leaseClosed).toBe('Pat Guest\'s lease drafted with this reservation ended with it. Nothing was owed on it.')
    expect((await leaseStatus(f.leaseId)).status).toBe('terminated')
  })

  it('money was paid on the drafted lease: the cancel is refused in plain words naming a step that exists — the reservation and the lease are untouched', async () => {
    const f = await stayWithDraftedLease()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash' WHERE id = $1`, [f.lines[1]])
    const res = await cancel(f)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^Pat Guest's reservation has a lease drafted with it, and canceling the reservation ends that lease — but \$500\.00 was already paid on this lease, so it can’t be closed as if nothing happened\. /)
    // A pending lease has no Change menu: the step named is the one that starts it.
    expect(res.body.error).toMatch(/When the lease starts \([A-Z][a-z]{2} \d{1,2}, \d{4}\), use Change → “They’re leaving on…”/)
    expect(res.body.error).not.toMatch(/no-show/)
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
    expect((await leaseStatus(f.leaseId)).status).toBe('pending')
    expect(await owed(f.tenantId)).toBe(1)
  })

  it('a card payment on the move-in bill was declined: the cancel closes it, GAM’s $1 declined-card fee stays owed, and the words say so', async () => {
    const f = await stayWithDraftedLease()
    await db.query(`UPDATE payments SET status = 'failed', stripe_payment_intent_id = 'pi_declined_cancel' WHERE id = ANY($1::uuid[])`, [f.lines])
    await declineFeeLikeTheWebhook(f.lines[0], 'pi_declined_cancel')
    const kept = await keptWordsOf(f)
    expect(kept).toBe('Still owed after this: GAM’s own fee, Declined-payment fee ($1.00) — ending the lease never takes it off. It stays on the household’s balance.')
    const res = await cancel(f, { expectedNeverMovedInTotal: 1500 })
    expect(res.status).toBe(200)
    expect(res.body.data.leaseClosed).toBe(
      `Pat Guest's lease drafted with this reservation ended with it. Nothing was paid on it, so the $1,500.00 move-in bill is no longer owed. ${kept}`)
    // Fix pass 2 (review): zeroed and settled, never 'voided' at full amount —
    // Money billed reads a voided row as still owed.
    expect((await db.query(`SELECT status, amount::float AS amount FROM payments WHERE id = ANY($1::uuid[]) ORDER BY type DESC`, [f.lines])).rows)
      .toEqual([{ status: 'settled', amount: 0 }, { status: 'settled', amount: 0 }])
    expect((await db.query(`SELECT status, amount::float AS amount, invoice_id FROM payments WHERE entry_description = 'DECLINEFEE'`)).rows)
      .toEqual([{ status: 'pending', amount: 1, invoice_id: null }])
  })

  it('after the never-moved-in close of a declined-card lease, Money billed shows $0 still owed for it (the reports never count the zeroed bill)', async () => {
    const f = await stayWithDraftedLease()
    await db.query(`UPDATE payments SET status = 'failed', stripe_payment_intent_id = 'pi_declined_billed' WHERE id = ANY($1::uuid[])`, [f.lines])
    await declineFeeLikeTheWebhook(f.lines[0], 'pi_declined_billed')
    const window = { landlordIds: [f.landlordId], start: '2000-01-01', end: '2100-12-31' }
    const owedBefore = (await incomeEvents({ ...window, basis: 'billed' }))
      .filter(e => e.leaseId === f.leaseId && e.part === 'stillOwed').reduce((t, e) => t + e.amount, 0)
    expect(owedBefore).toBe(1000)
    expect((await cancel(f, { expectedNeverMovedInTotal: 1500 })).status).toBe(200)
    const after = (await incomeEvents({ ...window, basis: 'billed' })).filter(e => e.leaseId === f.leaseId)
    expect(after.filter(e => e.part === 'stillOwed').reduce((t, e) => t + e.amount, 0)).toBe(0)
    expect(after.reduce((t, e) => t + e.amount, 0)).toBe(0)
  })

  it('an unsigned draft with nothing to zero but GAM’s own fee on it: the cancel ends it and says the fee stays owed — never “Nothing was owed”', async () => {
    const f = await stayWithDraftedLease({ bill: false })
    await db.query(`UPDATE leases SET signed_by_tenant = FALSE, signed_by_landlord = FALSE WHERE id = $1`, [f.leaseId])
    // A one-off line the card was tried on (no bill), then the webhook's fee copied from it — then the line itself is gone
    // from the picture: only GAM's fee is left on the lease.
    const tried = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, stripe_payment_intent_id)
       VALUES ($1, $2, $3, $4, 'rent', 0, 'settled', CURRENT_DATE, 'RENT', 'pi_only_fee') RETURNING id`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId])).rows[0].id
    await declineFeeLikeTheWebhook(tried, 'pi_only_fee')
    const kept = await keptWordsOf(f)
    const res = await cancel(f)
    expect(res.status).toBe(200)
    expect(res.body.data.leaseClosed).toBe(`Pat Guest's lease drafted with this reservation ended with it. Nothing on it was zeroed. ${kept}`)
    expect(res.body.data.leaseClosed).not.toMatch(/Nothing was owed/)
    expect((await leaseStatus(f.leaseId)).status).toBe('terminated')
    expect((await db.query(`SELECT status FROM payments WHERE entry_description = 'DECLINEFEE'`)).rows[0].status).toBe('pending')
  })

  it('a team member who may cancel reservations but not “Terminate leases” cannot zero a move-in bill by canceling the stay: 403 in plain words, nothing changes', async () => {
    const f = await stayWithDraftedLease()
    const desk = await staffToken(f.landlordId, { 'schedule.edit_reservation': true })
    const res = await cancel({ ...f, token: desk })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe(
      'Canceling this reservation ends the lease drafted with it and zeroes its unpaid $1,500.00 move-in bill. '
      + 'That needs the "Terminate leases" permission, so nothing was changed. '
      + 'Ask the account owner to turn on "Terminate leases" for you on the Team page.')
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
    expect((await leaseStatus(f.leaseId)).status).toBe('pending')
    expect(await owed(f.tenantId)).toBe(2)
    // With "Terminate leases" too, the same cancel (with its confirm's total) goes through.
    const both = await staffToken(f.landlordId, { 'schedule.edit_reservation': true, 'leases.terminate': true })
    expect((await cancel({ ...f, token: both }, { expectedNeverMovedInTotal: 1500 })).status).toBe(200)
    expect(await owed(f.tenantId)).toBe(0)
  })

  it('a team member without “Terminate leases” still cancels a stay whose drafted lease has nothing to zero (S639 paperwork)', async () => {
    const f = await stayWithDraftedLease({ bill: false })
    await db.query(`UPDATE leases SET signed_by_tenant = FALSE, signed_by_landlord = FALSE WHERE id = $1`, [f.leaseId])
    const desk = await staffToken(f.landlordId, { 'schedule.edit_reservation': true })
    const res = await cancel({ ...f, token: desk })
    expect(res.status).toBe(200)
    expect((await leaseStatus(f.leaseId)).status).toBe('terminated')
  })

  it('fresh at the moment of action: a cancel sent with the total its confirm showed is refused 409 when the bill changed since, and nothing changes', async () => {
    const f = await stayWithDraftedLease()
    const stale = await cancel(f, { expectedNeverMovedInTotal: 1200 })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe('What this lease owes changed since you opened this, so nothing was closed. '
      + 'The window now shows what would be zeroed — check it and confirm again.')
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
    expect(await owed(f.tenantId)).toBe(2)
    expect((await cancel(f, { expectedNeverMovedInTotal: 1500 })).status).toBe(200)
    expect(await owed(f.tenantId)).toBe(0)
  })

  it('the reservation history the close writes uses American spelling (“canceled”)', async () => {
    const f = await stayWithDraftedLease({ leaseStatus: 'active' })
    const closed = await request(buildApp()).post(`/api/leases/${f.leaseId}/never-moved-in`).set('Authorization', `Bearer ${f.token}`)
      .send({ expectedTotal: 1500 })
    expect(closed.status).toBe(200)
    const ev = (await db.query(`SELECT event_type, summary FROM unit_booking_events WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1`, [f.bookingId])).rows[0]
    expect(ev.event_type).toBe('cancelled')
    expect(ev.summary).toBe('Reservation for Pat Guest canceled — they never moved in, and the lease drafted from it was ended')
  })

  // ── Fix pass 3 (review, HIGH): the usual no-show — the landlord signed, the
  // scheduler made the drafted lease 'active' on the check-in day, and staff
  // cancel the stay on or after that day. Before, the cancel answered 200 and
  // left the lease active, billing, its move-in bill owed.
  it('a drafted lease already in force (made active on the check-in day — the usual no-show): the confirmed cancel closes it too, never leaving the move-in bill owed or the lease billing', async () => {
    const f = await stayWithDraftedLease({ leaseStatus: 'active' })
    const res = await cancel(f, { expectedNeverMovedInTotal: 1500 })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('cancelled')
    expect(res.body.data.leaseClosed).toBe('Pat Guest\'s lease drafted with this reservation ended with it. Nothing was paid on it, so the $1,500.00 move-in bill is no longer owed.')
    expect(await leaseStatus(f.leaseId)).toEqual({ status: 'terminated', termination_reason: 'The tenant never moved in' })
    expect(await owed(f.tenantId)).toBe(0)
    expect((await db.query(`SELECT status FROM invoices WHERE id = $1`, [f.inv])).rows[0].status).toBe('void')
    expect((await db.query(`SELECT status FROM units WHERE id = $1`, [f.unitId])).rows[0].status).toBe('vacant')
    // "They never moved in" on that lease then says the truth — nothing left.
    const after = await request(buildApp()).get(`/api/leases/${f.leaseId}/never-moved-in`).set('Authorization', `Bearer ${f.token}`)
    expect(after.body.data.words).toBe('This lease has already ended and nothing on it is still owed. Nothing else to do.')
  })

  it('a drafted lease in force with money paid on it: the cancel is refused, naming the move-out on the Leases page — the reservation, the lease and the bill untouched', async () => {
    const f = await stayWithDraftedLease({ leaseStatus: 'active' })
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash' WHERE id = $1`, [f.lines[1]])
    const res = await cancel(f)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Pat Guest\'s reservation has a lease drafted with it, and canceling the reservation ends that lease — but '
      + '$500.00 was already paid on this lease, so it can’t be closed as if nothing happened. '
      + 'Use Change → “They’re leaving on…” on the Leases page, then Change → Move out — the move-out settles what they paid and returns what is theirs.')
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
    expect((await leaseStatus(f.leaseId)).status).toBe('active')
    expect(await owed(f.tenantId)).toBe(1)
  })

  it('a team member without “Terminate leases” cannot end a lease in force by canceling the stay, even with nothing to zero: 403, nothing changes', async () => {
    const f = await stayWithDraftedLease({ leaseStatus: 'active', bill: false })
    const desk = await staffToken(f.landlordId, { 'schedule.edit_reservation': true })
    const res = await cancel({ ...f, token: desk })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Canceling this reservation ends the lease drafted with it, which is already in force. '
      + 'That needs the "Terminate leases" permission, so nothing was changed. '
      + 'Ask the account owner to turn on "Terminate leases" for you on the Team page.')
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
    expect((await leaseStatus(f.leaseId)).status).toBe('active')
  })

  it('a No-show sent through the API (or the landlord assistant) with the confirm’s total runs the same close: the lease ends, the move-in bill zeroed', async () => {
    const f = await stayWithDraftedLease({ leaseStatus: 'active' })
    await db.query(`UPDATE unit_bookings SET check_in = CURRENT_DATE - 1, check_out = CURRENT_DATE + 59 WHERE id = $1`, [f.bookingId])
    const res = await request(buildApp()).patch(`/api/units/${f.unitId}/bookings/${f.bookingId}`)
      .set('Authorization', `Bearer ${f.token}`).send({ status: 'no_show', expectedNeverMovedInTotal: 1500, expectedNeverMovedInLeases: 1 })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('no_show')
    expect(res.body.data.leaseClosed).toBe('Pat Guest\'s lease drafted with this reservation ended with it. Nothing was paid on it, so the $1,500.00 move-in bill is no longer owed.')
    expect((await leaseStatus(f.leaseId)).status).toBe('terminated')
    expect(await owed(f.tenantId)).toBe(0)
  })

  it('a No-show refused by the close is refused in its own words and changes nothing', async () => {
    const f = await stayWithDraftedLease()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash' WHERE id = $1`, [f.lines[1]])
    const res = await request(buildApp()).patch(`/api/units/${f.unitId}/bookings/${f.bookingId}`)
      .set('Authorization', `Bearer ${f.token}`).send({ status: 'no_show' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^Pat Guest's reservation has a lease drafted with it, and marking the reservation a no-show ends that lease — but \$500\.00 was already paid/)
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
    expect((await leaseStatus(f.leaseId)).status).toBe('pending')
  })

  it('a stay that is checked in can’t be canceled or marked a no-show — the guest is on the site; the words name Check out, and nothing changes', async () => {
    const f = await stayWithDraftedLease()
    await db.query(`UPDATE unit_bookings SET status = 'checked_in', check_in = CURRENT_DATE - 1 WHERE id = $1`, [f.bookingId])
    const words = "Pat Guest is checked in, so the stay can't be canceled — they are on the site, and nothing was changed. "
      + 'When they leave, use Check out on the Schedule; it settles the nights they stayed.'
    // The confirm reads the same refusal (only Close) …
    const shown = (await cancelCheck(f)).body.data
    expect(shown).toMatchObject({ applies: false, words, total: 0 })
    // … and the press is refused in those words, with or without a total.
    for (const extra of [{}, { expectedNeverMovedInTotal: 1500 }]) {
      const res = await cancel(f, extra)
      expect(res.status).toBe(409)
      expect(res.body.error).toBe(words)
    }
    const ns = await patchStatus(f, 'no_show')
    expect(ns.status).toBe(409)
    expect(ns.body.error).toBe("Pat Guest is checked in, so they came and can't be marked a no-show — nothing was changed. "
      + 'When they leave, use Check out on the Schedule; it settles the nights they stayed.')
    expect(ns.body.error).not.toMatch(/Confirmed/)
    expect(await bookingStatus(f.bookingId)).toBe('checked_in')
    expect((await leaseStatus(f.leaseId)).status).toBe('pending')
    expect(await owed(f.tenantId)).toBe(2)
    // "They never moved in" on the Leases page refuses too, naming the check-in.
    const nmi = (await request(buildApp()).get(`/api/leases/${f.leaseId}/never-moved-in`).set('Authorization', `Bearer ${f.token}`)).body.data
    expect(nmi.applies).toBe(false)
    expect(nmi.words).toMatch(/^Their stay was checked in on .+, so they moved in\./)
  })

  it('a stay with no lease that is checked in can’t be canceled either (never “the site is free” while the guest is on it)', async () => {
    const f = await stayWithDraftedLease({ bill: false })
    await db.query(`UPDATE leases SET source_booking_id = NULL WHERE id = $1`, [f.leaseId])
    await db.query(`UPDATE unit_bookings SET status = 'checked_in', check_in = CURRENT_DATE - 1 WHERE id = $1`, [f.bookingId])
    const shown = (await cancelCheck(f)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/^Pat Guest is checked in, so the stay can't be canceled/)
    expect((await cancel(f, { expectedNeverMovedInTotal: 0 })).status).toBe(409)
    expect(await bookingStatus(f.bookingId)).toBe('checked_in')
  })
})

// ── Final fix (fix pass 1, decisions #53) ─────────────────────────────────────

/** A later month's bill on the drafted lease: $1,000 rent due `days` from today, unpaid. */
async function laterBill(f: { landlordId: string; tenantId: string; leaseId: string; unitId: string }, days = 35) {
  const inv = (await db.query<{ id: string }>(
    `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount)
     VALUES ($1, $2, $3, $4, $5, CURRENT_DATE + $6::int, 1000, 1000) RETURNING id`,
    [f.landlordId, f.tenantId, f.leaseId, f.unitId, `INV-${randomUUID().slice(0, 8)}`, days])).rows[0].id
  const line = (await db.query<{ id: string; due: string }>(
    `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
     VALUES ($1, $2, $3, $4, $5, 'rent', 1000, 'pending', CURRENT_DATE + $6::int, 'RENT')
     RETURNING id, to_char(due_date, 'YYYY-MM-DD') AS due`,
    [inv, f.unitId, f.leaseId, f.tenantId, f.landlordId, days])).rows[0]
  return { inv, line: line.id, due: line.due }
}

/** "Nov 8, 2026" — the way the close says a day. */
const sayDay = (ymd: string) => new Date(`${ymd}T12:00:00Z`)
  .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

const cancelCheck = (f: { unitId: string; bookingId: string; token: string }, q = '') =>
  request(buildApp()).get(`/api/units/${f.unitId}/bookings/${f.bookingId}/cancel-check${q}`).set('Authorization', `Bearer ${f.token}`)

const patchStatus = (f: { unitId: string; bookingId: string; token: string }, status: string) =>
  request(buildApp()).patch(`/api/units/${f.unitId}/bookings/${f.bookingId}`).set('Authorization', `Bearer ${f.token}`).send({ status })

/** The stay's status history into or out of a check-in / check-out: [from, to] pairs, oldest first. */
const arrivalHistory = async (bookingId: string) => (await db.query<{ f: string; t: string }>(
  `SELECT detail->>'from_status' AS f, detail->>'to_status' AS t FROM unit_booking_events
    WHERE booking_id = $1 AND event_type = 'status_changed'
      AND (detail->>'from_status' IN ('checked_in', 'checked_out') OR detail->>'to_status' IN ('checked_in', 'checked_out'))
    ORDER BY created_at, id`, [bookingId])).rows.map(r => [r.f, r.t])

describe('decisions #53 — the never-moved-in close zeroes only the move-in bill, never for a guest who was checked in, and never blind', () => {
  it('the review’s reproduction: checked in, set back to Confirmed, then Cancel reservation — refused 409 naming the check-in, and nothing changed', async () => {
    const f = await stayWithDraftedLease({ leaseStatus: 'active' })
    await db.query(`UPDATE unit_bookings SET check_in = CURRENT_DATE, check_out = CURRENT_DATE + 60 WHERE id = $1`, [f.bookingId])
    await laterBill(f)
    const inRes = await patchStatus(f, 'checked_in')
    expect(inRes.status, JSON.stringify(inRes.body)).toBe(200)
    const back = await patchStatus(f, 'confirmed')
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
    // Fix pass 2 (review): the check-in and its set-back are in the stay's
    // history the moment the save answers — written by the save, not after it.
    expect(await arrivalHistory(f.bookingId)).toEqual([['confirmed', 'checked_in'], ['checked_in', 'confirmed']])

    // The confirm shows the refusal (only Close) …
    const shown = (await cancelCheck(f)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/^Pat Guest's reservation has a lease drafted with it, and canceling the reservation ends that lease — but their stay was checked in on [A-Z][a-z]{2} \d{1,2}, \d{4} \(the Schedule shows it as Confirmed now\), so they moved in\. End the lease with a move-out instead: use Change → “They’re leaving on…” on the Leases page, then Change → Move out\.$/)
    expect(shown.words).not.toMatch(/back to Confirmed/)
    // … and the press is refused in the same words, with or without a total.
    for (const extra of [{}, { expectedNeverMovedInTotal: 1500 }]) {
      const res = await cancel(f, extra)
      expect(res.status).toBe(409)
      expect(res.body.error).toBe(shown.words)
    }
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
    expect((await leaseStatus(f.leaseId)).status).toBe('active')
    expect(await owed(f.tenantId)).toBe(3)
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM invoices WHERE lease_id = $1 AND status = 'void'`, [f.leaseId])).rows[0].n).toBe(0)
    // "They never moved in — end the lease" says the same about the history.
    const nmi = (await request(buildApp()).get(`/api/leases/${f.leaseId}/never-moved-in`).set('Authorization', `Bearer ${f.token}`)).body.data
    expect(nmi.applies).toBe(false)
    expect(nmi.words).toMatch(/^Their stay was checked in on .+ \(the Schedule shows it as Confirmed now\), so they moved in\./)
  })

  it('a stay checked in and then canceled by an older path still reads as moved in — the history decides, not the status now', async () => {
    const f = await stayWithDraftedLease({ leaseStatus: 'active' })
    await db.query(
      `INSERT INTO unit_booking_events (booking_id, unit_id, landlord_id, event_type, summary, detail)
       VALUES ($1, $2, $3, 'status_changed', 'Pat Guest status: confirmed → checked_in', '{"from_status":"confirmed","to_status":"checked_in"}')`,
      [f.bookingId, f.unitId, f.landlordId])
    const res = await cancel(f, { expectedNeverMovedInTotal: 1500 })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/their stay was checked in on .+, so they moved in\./)
    expect(await owed(f.tenantId)).toBe(2)
  })

  it('a multi-month active lease: the confirm lists the move-in bill as zeroed and the later month as “stays owed”; the cancel zeroes ONLY the move-in bill and the later bill stays owed on its own invoice', async () => {
    const f = await stayWithDraftedLease({ leaseStatus: 'active' })
    const later = await laterBill(f)
    const shown = (await cancelCheck(f)).body.data
    expect(shown).toMatchObject({ applies: true, words: null, total: 1500, kept_total: 1000, needs_total: true })
    expect(shown.leases).toHaveLength(1)
    const l = shown.leases[0]
    expect(l.household).toEqual({ tenant_names: ['Test Tenant'], unit_number: expect.any(String), property_name: expect.any(String) })
    expect(l.lines.map((x: any) => [x.label, x.amount])).toEqual([['Rent', 1000], ['Deposit', 500]])
    // Fix pass 2 (review): a later month's rent says the days it covers (a
    // month from its due day — the lease has no end date and no rent after it).
    const through = (await db.query<{ d: string }>(
      `SELECT to_char(($1::date + interval '1 month' - interval '1 day')::date, 'YYYY-MM-DD') AS d`, [later.due])).rows[0].d
    expect(l.kept).toEqual([{ payment_id: later.line, label: 'Rent', amount: 1000, why: 'later_bill', due_date: later.due,
                              period_start: later.due, period_end: through }])
    const keptWords = `Still owed after this: what is not on the move-in bill, Rent due ${sayDay(later.due)} ($1,000.00) — only the move-in bill is zeroed. `
      + `Rent due ${sayDay(later.due)} covers ${sayDay(later.due)} – ${sayDay(through)}. It stays on the household’s balance.`
    expect(l.kept_words).toBe(keptWords)

    const res = await cancel(f, { expectedNeverMovedInTotal: shown.total })
    expect(res.status).toBe(200)
    expect(res.body.data.leaseClosed).toBe(
      `Pat Guest's lease drafted with this reservation ended with it. Nothing was paid on it, so the $1,500.00 move-in bill is no longer owed. ${keptWords}`)
    expect((await db.query(`SELECT amount::float AS amount, status FROM payments WHERE id = ANY($1::uuid[]) ORDER BY type DESC`, [f.lines])).rows)
      .toEqual([{ amount: 0, status: 'settled' }, { amount: 0, status: 'settled' }])
    expect((await db.query(`SELECT amount::float AS amount, status, invoice_id FROM payments WHERE id = $1`, [later.line])).rows[0])
      .toEqual({ amount: 1000, status: 'pending', invoice_id: later.inv })
    expect((await db.query(`SELECT id, status FROM invoices WHERE lease_id = $1 ORDER BY created_at`, [f.leaseId])).rows)
      .toEqual([{ id: f.inv, status: 'void' }, { id: later.inv, status: 'pending' }])
    expect(await owed(f.tenantId)).toBe(1)
    expect((await leaseStatus(f.leaseId)).status).toBe('terminated')
    // Run again on the ended lease: the move-in bill is gone, so the later bill
    // is never treated as the move-in bill — nothing left to close.
    const again = (await request(buildApp()).get(`/api/leases/${f.leaseId}/never-moved-in`).set('Authorization', `Bearer ${f.token}`)).body.data
    expect(again.applies).toBe(false)
    expect(again.words).toBe(`This lease has already ended and nothing on it is left to close. ${keptWords}`)
    const list = (await request(buildApp()).get('/api/leases').set('Authorization', `Bearer ${f.token}`)).body.data
    expect(list.find((x: any) => x.id === f.leaseId)?.ended_bill_open).toBe(false)
  })

  it('never blind: a bare cancel that would zero the move-in bill is refused 409 in plain words naming the confirm, and nothing changes', async () => {
    const f = await stayWithDraftedLease()
    const res = await cancel(f)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Canceling this reservation ends the lease drafted with it and zeroes its unpaid $1,500.00 move-in bill. '
      + 'Nothing was changed. Use Cancel reservation on the Schedule — it shows, by name, what is zeroed and what stays owed before you confirm.')
    expect(res.body.error).not.toMatch(/Confirmed/)
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
    expect((await leaseStatus(f.leaseId)).status).toBe('pending')
    expect(await owed(f.tenantId)).toBe(2)
    // A bare No-show is refused the same way.
    const ns = await patchStatus(f, 'no_show')
    expect(ns.status).toBe(409)
    expect(ns.body.error).toMatch(/^Marking this reservation a no-show ends the lease drafted with it and zeroes its unpaid \$1,500\.00 move-in bill\. Nothing was changed\./)
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
  })

  it('never blind: a bare cancel that would end a lease in force (nothing to zero) is refused too', async () => {
    const f = await stayWithDraftedLease({ leaseStatus: 'active', bill: false })
    const res = await cancel(f)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Canceling this reservation ends the lease drafted with it, which is already in force. '
      + 'Nothing was changed. Use Cancel reservation on the Schedule — it shows, by name, what is zeroed and what stays owed before you confirm.')
    expect((await leaseStatus(f.leaseId)).status).toBe('active')
    expect((await cancel(f, { expectedNeverMovedInTotal: 0 })).status).toBe(200)
    expect((await leaseStatus(f.leaseId)).status).toBe('terminated')
  })

  it('the confirm read with no lease drafted: nothing to zero, the plain cancel, no total needed', async () => {
    const f = await stayWithDraftedLease({ bill: false })
    await db.query(`UPDATE leases SET source_booking_id = NULL WHERE id = $1`, [f.leaseId])
    const shown = (await cancelCheck(f)).body.data
    expect(shown).toMatchObject({ applies: true, words: null, leases: [], total: 0, needs_total: false })
    expect(shown.booking).toMatchObject({ id: f.bookingId, guest_name: 'Pat Guest', status: 'confirmed' })
    expect((await cancel(f)).status).toBe(200)
  })

  it('the confirm read for a team member without “Terminate leases” shows the refusal the press would get (only Close)', async () => {
    const f = await stayWithDraftedLease()
    const desk = await staffToken(f.landlordId, { 'schedule.edit_reservation': true })
    const shown = (await cancelCheck({ ...f, token: desk })).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toBe(
      'Canceling this reservation ends the lease drafted with it and zeroes its unpaid $1,500.00 move-in bill. '
      + 'That needs the "Terminate leases" permission, so nothing was changed. '
      + 'Ask the account owner to turn on "Terminate leases" for you on the Team page.')
    expect(shown.total).toBe(0)
  })

  it('the confirm read for a checked-out stay: the refusal names no way around it', async () => {
    const f = await stayWithDraftedLease({ bill: false })
    await db.query(`UPDATE unit_bookings SET status = 'checked_out' WHERE id = $1`, [f.bookingId])
    const shown = (await cancelCheck(f)).body.data
    expect(shown).toMatchObject({ applies: false, leases: [] })
    expect(shown.words).toBe("Pat Guest has already checked out, so the stay can't be canceled — a stay that happened stays on the schedule as its record, and nothing was changed.")
  })

  it('a bank pull set to be tried again that pays the move-in bill AND a later month is not stopped: the cancel waits for it (nothing changed)', async () => {
    const f = await stayWithDraftedLease({ leaseStatus: 'active' })
    const later = await laterBill(f)
    await db.query(
      `UPDATE payments SET status = 'failed', stripe_payment_intent_id = 'pi_both_bills', next_retry_at = NOW() + INTERVAL '2 days'
        WHERE id = ANY($1::uuid[])`, [[...f.lines, later.line]])
    const shown = (await cancelCheck(f)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/is set to be tried again on .+\. That try also pays other bills the household owes, so it can’t be stopped here/)
    const res = await cancel(f, { expectedNeverMovedInTotal: 1500 })
    expect(res.status).toBe(409)
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM payments WHERE stripe_payment_intent_id = 'pi_both_bills' AND next_retry_at IS NOT NULL`)).rows[0].n).toBe(3)
    expect((await leaseStatus(f.leaseId)).status).toBe('active')
  })
})


describe('final fix, fix pass 2 (review) — the never-moved-in close', () => {
  it('the check-in and its set-back reach the stay’s history even when the after-save history diff fails — so the cancel is still refused, nothing changed', async () => {
    const f = await stayWithDraftedLease({ leaseStatus: 'active' })
    await db.query(`UPDATE unit_bookings SET check_in = CURRENT_DATE, check_out = CURRENT_DATE + 60 WHERE id = $1`, [f.bookingId])
    historyDiff.fail = true
    expect((await patchStatus(f, 'checked_in')).status).toBe(200)
    expect((await patchStatus(f, 'confirmed')).status).toBe(200)
    // Each written once, by the save (no second copy from the diff afterwards).
    historyDiff.fail = false
    await new Promise(r => setTimeout(r, 50))
    expect(await arrivalHistory(f.bookingId)).toEqual([['confirmed', 'checked_in'], ['checked_in', 'confirmed']])
    const shown = (await cancelCheck(f)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/their stay was checked in on .+ \(the Schedule shows it as Confirmed now\), so they moved in\./)
    const res = await cancel(f, { expectedNeverMovedInTotal: 1500 })
    expect(res.status).toBe(409)
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
    expect((await leaseStatus(f.leaseId)).status).toBe('active')
    expect(await owed(f.tenantId)).toBe(2)
  })

  it('a plain status change that is not a check-in or check-out is still recorded once, by the after-save diff', async () => {
    const f = await stayWithDraftedLease({ bill: false })
    await db.query(`UPDATE leases SET source_booking_id = NULL WHERE id = $1`, [f.leaseId])
    expect((await patchStatus(f, 'tentative')).status).toBe(200)
    await new Promise(r => setTimeout(r, 50))
    const rows = (await db.query(`SELECT detail->>'from_status' AS f, detail->>'to_status' AS t FROM unit_booking_events WHERE booking_id = $1`, [f.bookingId])).rows
    expect(rows).toEqual([{ f: 'confirmed', t: 'tentative' }])
  })

  it('a hold GAM moved to another site before arrival (an unpaid hold yielding to a paid booking): Cancel reservation zeroes the move-in bill with the confirm’s total — never “they moved spaces”', async () => {
    const f = await stayWithDraftedLease()
    await db.query(`UPDATE unit_bookings SET status = 'tentative' WHERE id = $1`, [f.bookingId])
    const c = await db.connect()
    let other: string
    try {
      other = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId, rentAmount: 1000, unitType: 'rv_spot' })
      await c.query('BEGIN')
      const { clearUnpaidHolds } = await import('../services/holdDisplacement')
      const b = (await c.query(`SELECT check_in::text AS ci, check_out::text AS co FROM unit_bookings WHERE id = $1`, [f.bookingId])).rows[0]
      const moved = await clearUnpaidHolds(c, f.unitId, b.ci, b.co)
      await c.query('COMMIT')
      expect(moved.map(m => m.outcome)).toEqual(['moved'])
    } finally { c.release() }
    // The real move stamped the drafted lease with the new site and a move day.
    expect((await db.query(`SELECT unit_id, unit_moved_on IS NOT NULL AS stamped FROM leases WHERE id = $1`, [f.leaseId])).rows[0])
      .toEqual({ unit_id: other!, stamped: true })
    const moved = { ...f, unitId: other! }
    const shown = (await cancelCheck(moved)).body.data
    expect(shown).toMatchObject({ applies: true, words: null, total: 1500 })
    const res = await cancel(moved, { expectedNeverMovedInTotal: shown.total, expectedNeverMovedInLeases: shown.leases.length })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await bookingStatus(f.bookingId)).toBe('cancelled')
    expect(await leaseStatus(f.leaseId)).toEqual({ status: 'terminated', termination_reason: 'The tenant never moved in' })
    expect(await owed(f.tenantId)).toBe(0)
  })

  it('a household moved by hand on the Leases page (the move records who moved them) still lives there: refused as moving spaces, even after a hold move', async () => {
    const f = await stayWithDraftedLease()
    await db.query(`UPDATE unit_bookings SET displaced_at = NOW() WHERE id = $1`, [f.bookingId])
    await db.query(`UPDATE leases SET unit_moved_on = CURRENT_DATE WHERE id = $1`, [f.leaseId])
    await db.query(`UPDATE lease_unit_history SET moved_by_user_id = $2 WHERE lease_id = $1 AND effective_to IS NULL`, [f.leaseId, f.userId])
    const shown = (await cancelCheck(f)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/this household moved to this space from another one on the same lease/)
    expect((await cancel(f, { expectedNeverMovedInTotal: 1500 })).status).toBe(409)
    expect(await owed(f.tenantId)).toBe(2)
  })

  it('a lease drafted after the confirm read (it showed no lease): the press is refused 409 “changed since you opened this”, nothing changes', async () => {
    const f = await stayWithDraftedLease({ leaseStatus: 'active', bill: false })
    const res = await cancel(f, { expectedNeverMovedInTotal: 0, expectedNeverMovedInLeases: 0 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('The leases drafted with this reservation changed since you opened this, so nothing was changed. '
      + 'The window now shows what canceling it does — check it and confirm again.')
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
    expect((await leaseStatus(f.leaseId)).status).toBe('active')
    // With the count the fresh read shows, it goes through.
    expect((await cancel(f, { expectedNeverMovedInTotal: 0, expectedNeverMovedInLeases: 1 })).status).toBe(200)
  })

  it('a stay with no lease: the confirm’s $0 total and 0 leases go with the press and it cancels plainly', async () => {
    const f = await stayWithDraftedLease({ bill: false })
    await db.query(`UPDATE leases SET source_booking_id = NULL WHERE id = $1`, [f.leaseId])
    const res = await cancel(f, { expectedNeverMovedInTotal: 0, expectedNeverMovedInLeases: 0 })
    expect(res.status).toBe(200)
    expect(await bookingStatus(f.bookingId)).toBe('cancelled')
  })
})

describe('final fix, fix pass 3 (review) — the never-moved-in close', () => {
  it('a total sent without the lease count (an older screen, the API) is refused 409 in plain words — a lease in force since, with nothing to zero, is never ended unseen', async () => {
    const f = await stayWithDraftedLease({ leaseStatus: 'active', bill: false })
    // A read taken before the lease was drafted said $0; the totals would agree.
    const res = await cancelRaw(f, { status: 'cancelled', expectedNeverMovedInTotal: 0 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Canceling this reservation ends the lease drafted with it, which is already in force. '
      + 'Nothing was changed. Use Cancel reservation on the Schedule — it shows, by name, what is zeroed and what stays owed before you confirm.')
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
    expect((await leaseStatus(f.leaseId)).status).toBe('active')
  })

  it('a total sent without the lease count on a move-in bill is refused too, and nothing is zeroed', async () => {
    const f = await stayWithDraftedLease()
    const res = await cancelRaw(f, { status: 'cancelled', expectedNeverMovedInTotal: 1500 })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^Canceling this reservation ends the lease drafted with it and zeroes its unpaid \$1,500\.00 move-in bill\. Nothing was changed\./)
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
    expect((await leaseStatus(f.leaseId)).status).toBe('pending')
    expect(await owed(f.tenantId)).toBe(2)
  })

  it('an unsigned draft with nothing to zero and no total still cancels plainly (S639 paperwork — no confirm figures needed)', async () => {
    const f = await stayWithDraftedLease({ bill: false })
    const res = await cancelRaw(f, { status: 'cancelled' })
    expect(res.status).toBe(200)
    expect(await bookingStatus(f.bookingId)).toBe('cancelled')
    expect((await leaseStatus(f.leaseId)).status).toBe('terminated')
  })

  it('Cancel reservation on a stay already marked a no-show: the confirm says the site is already free, nothing else to do (only Close)', async () => {
    const f = await stayWithDraftedLease({ bill: false })
    await db.query(`UPDATE leases SET source_booking_id = NULL WHERE id = $1`, [f.leaseId])
    await db.query(`UPDATE unit_bookings SET status = 'no_show' WHERE id = $1`, [f.bookingId])
    const shown = (await cancelCheck(f)).body.data
    expect(shown).toMatchObject({
      applies: false, total: 0,
      words: 'This reservation is already marked a no-show, so its site is already free. Nothing else to do.',
    })
    expect(await bookingStatus(f.bookingId)).toBe('no_show')
  })

  it('the Leases page’s confirm and the Schedule’s confirm name the same people — an unsigned add-a-roommate included', async () => {
    const f = await stayWithDraftedLease()
    const c = await db.connect()
    try {
      const mate = await seedTenant(c)
      await seedLeaseTenant(c, { leaseId: f.leaseId, tenantId: mate, role: 'co_tenant' })
      await c.query(`UPDATE lease_tenants SET status = 'pending_add' WHERE lease_id = $1 AND tenant_id = $2`, [f.leaseId, mate])
    } finally { c.release() }
    const nmi = (await request(buildApp()).get(`/api/leases/${f.leaseId}/never-moved-in`).set('Authorization', `Bearer ${f.token}`)).body.data
    const sched = (await cancelCheck(f)).body.data
    expect(nmi.household.tenant_names.length).toBe(2)
    expect(nmi.household).toEqual(sched.leases[0].household)
  })

  it('a lease moved to another site with no mover recorded, after its stay was moved as a hold, is still read as the household moving spaces — never as the hold move', async () => {
    const f = await stayWithDraftedLease()
    const c = await db.connect()
    let other: string
    try {
      other = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId, rentAmount: 1000, unitType: 'rv_spot' })
    } finally { c.release() }
    // The stay was moved as a hold (it stays on the first site here) …
    await db.query(`UPDATE unit_bookings SET displaced_at = NOW() WHERE id = $1`, [f.bookingId])
    // … and the lease alone went to another site, nobody recorded as moving it.
    await db.query(`UPDATE leases SET unit_id = $2, unit_moved_on = CURRENT_DATE WHERE id = $1`, [f.leaseId, other!])
    const shown = (await cancelCheck(f)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/this household moved to this space from another one on the same lease/)
    expect((await cancel(f, { expectedNeverMovedInTotal: 1500 })).status).toBe(409)
    expect(await owed(f.tenantId)).toBe(2)
    expect((await leaseStatus(f.leaseId)).status).toBe('pending')
  })
})

describe('fix pass 1 of the #53 close (review) — money paid toward the reservation, and a closed stay brought back', () => {
  /**
   * Money paid toward the reservation (decisions #15: the counter or the
   * booking site takes the deposit, the lease bills the rest), as
   * jobs/moveInBundle leaves it on the move-in bill: what the arrival rent used
   * comes off the rent line; what it did not use is paid-ahead money on the
   * lease ('reclassified', the stay-deposit note).
   */
  async function reservationPaid(f: Awaited<ReturnType<typeof stayWithDraftedLease>>, paid: number) {
    await db.query(`UPDATE unit_bookings SET deposit_amount = $2, deposit_paid_at = NOW() - interval '1 day' WHERE id = $1`, [f.bookingId, paid])
    const used = Math.min(paid, 1000)
    if (used >= 1000) await db.query(`DELETE FROM payments WHERE id = $1`, [f.lines[0]])
    else await db.query(`UPDATE payments SET amount = $2 WHERE id = $1`, [f.lines[0], 1000 - used])
    await db.query(`UPDATE invoices SET subtotal_rent = $2::numeric, total_amount = $2::numeric + 500 WHERE id = $1`, [f.inv, 1000 - used])
    if (paid > 1000) {
      const { STAY_DEPOSIT_CREDIT_NOTE } = await import('../jobs/moveInBundle')
      await db.query(
        `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, note, received_at)
         VALUES ($1, $2, $3, $3, 'reclassified', $4, NOW())`, [f.leaseId, f.tenantId, paid - 1000, STAY_DEPOSIT_CREDIT_NOTE])
    }
  }
  const neverMovedIn = (f: { leaseId: string; token: string }, expectedTotal: number) =>
    request(buildApp()).post(`/api/leases/${f.leaseId}/never-moved-in`).set('Authorization', `Bearer ${f.token}`).send({ expectedTotal })

  it('a reservation deposit smaller than the first rent (taken off the move-in rent): Cancel reservation is refused, naming the money paid — never “Nothing was paid”, nothing zeroed', async () => {
    const f = await stayWithDraftedLease()
    await reservationPaid(f, 300)
    const shown = (await cancelCheck(f)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/^Pat Guest's reservation has a lease drafted with it, and canceling the reservation ends that lease — but \$300\.00 was paid toward the reservation this lease was drafted from, so it can’t be closed as if nothing happened\. /)
    const res = await cancel(f, { expectedNeverMovedInTotal: 1200 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(shown.words)
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
    expect((await leaseStatus(f.leaseId)).status).toBe('pending')
    expect(await owed(f.tenantId)).toBe(2)
    expect((await db.query(`SELECT status FROM invoices WHERE id = $1`, [f.inv])).rows[0].status).not.toBe('void')
  })

  it('a reservation deposit smaller than the first rent: “They never moved in — end the lease” is refused the same way through POST /leases/:id/never-moved-in', async () => {
    const f = await stayWithDraftedLease()
    await reservationPaid(f, 300)
    const read = (await request(buildApp()).get(`/api/leases/${f.leaseId}/never-moved-in`).set('Authorization', `Bearer ${f.token}`)).body.data
    expect(read.applies).toBe(false)
    expect(read.words).toMatch(/^\$300\.00 was paid toward the reservation this lease was drafted from, so it can’t be closed as if nothing happened\. /)
    const res = await neverMovedIn(f, 1200)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(read.words)
    expect((await leaseStatus(f.leaseId)).status).toBe('pending')
    expect(await owed(f.tenantId)).toBe(2)
  })

  it('a reservation deposit bigger than the first rent (the rest kept as paid-ahead money): refused through both doors, each dollar said once', async () => {
    const f = await stayWithDraftedLease()
    await reservationPaid(f, 1300)
    const shown = (await cancelCheck(f)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toContain('$1,000.00 was paid toward the reservation this lease was drafted from and $300.00 they paid ahead is on this lease, so it can’t be closed as if nothing happened.')
    expect((await cancel(f, { expectedNeverMovedInTotal: 500 })).status).toBe(409)
    const res = await neverMovedIn(f, 500)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^\$1,000\.00 was paid toward the reservation this lease was drafted from and \$300\.00 they paid ahead is on this lease/)
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
    expect((await leaseStatus(f.leaseId)).status).toBe('pending')
    expect(await owed(f.tenantId)).toBe(1)
  })

  it('money paid toward the reservation with no move-in bill yet (an unsigned draft): the cancel ends the draft plainly — the reservation money never touched the lease', async () => {
    const f = await stayWithDraftedLease({ bill: false })
    await db.query(`UPDATE leases SET signed_by_tenant = FALSE, signed_by_landlord = FALSE WHERE id = $1`, [f.leaseId])
    await db.query(`UPDATE unit_bookings SET deposit_amount = 300, deposit_paid_at = NOW() WHERE id = $1`, [f.bookingId])
    const res = await cancel(f)
    expect(res.status).toBe(200)
    expect(res.body.data.leaseClosed).toBe('Pat Guest\'s lease drafted with this reservation ended with it. Nothing was owed on it.')
  })

  it('a canceled stay whose drafted lease the close ended can’t be brought back (Confirmed, Tentative, Checked in or Checked out): 409 in plain words naming a new reservation, nothing changed', async () => {
    const f = await stayWithDraftedLease()
    expect((await cancel(f, { expectedNeverMovedInTotal: 1500 })).status).toBe(200)
    const { closedStayRefusal } = await import('./units')
    for (const to of ['confirmed', 'tentative', 'checked_in', 'checked_out']) {
      const res = await patchStatus(f, to)
      expect(res.status, to).toBe(409)
      expect(res.body.error).toBe(closedStayRefusal('Pat Guest', 'cancelled'))
    }
    expect(closedStayRefusal('Pat Guest', 'cancelled')).toBe('Pat Guest\'s reservation was canceled, and the lease drafted with it was ended as never moved in '
      + '(its move-in bill zeroed), so the reservation can’t be brought back — nothing was changed. If Pat Guest is coming after all, book a new reservation on the Schedule.')
    expect(await bookingStatus(f.bookingId)).toBe('cancelled')
    expect((await leaseStatus(f.leaseId)).status).toBe('terminated')
  })

  it('a no-show whose drafted lease the close ended can’t be brought back either', async () => {
    const f = await stayWithDraftedLease()
    expect((await cancelRaw(f, { status: 'no_show', expectedNeverMovedInTotal: 1500, expectedNeverMovedInLeases: 1 })).status).toBe(200)
    const res = await patchStatus(f, 'checked_in')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^Pat Guest was marked a no-show, and the lease drafted with it was ended as never moved in/)
    expect(await bookingStatus(f.bookingId)).toBe('no_show')
  })

  it('a lease that had already ended when the close zeroed what was left (its move-in bill voided by the close) also keeps its stay from being brought back', async () => {
    const f = await stayWithDraftedLease()
    await db.query(`UPDATE leases SET status = 'terminated', termination_reason = 'Hold lapsed' WHERE id = $1`, [f.leaseId])
    await db.query(`UPDATE unit_bookings SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [f.bookingId])
    expect((await neverMovedIn(f, 1500)).status).toBe(200)
    expect((await leaseStatus(f.leaseId)).termination_reason).toBe('Hold lapsed')
    expect((await patchStatus(f, 'confirmed')).status).toBe(409)
  })

  it('a canceled stay whose drafted lease ended some other way (no never-moved-in close) is not refused by this rule', async () => {
    const f = await stayWithDraftedLease({ bill: false })
    await db.query(`UPDATE leases SET status = 'terminated', termination_reason = 'Ended by hand' WHERE id = $1`, [f.leaseId])
    await db.query(`UPDATE unit_bookings SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [f.bookingId])
    const res = await patchStatus(f, 'confirmed')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
  })
})

describe('fix pass 2 of the #53 close (review) — a stay brought back, and reservation money read from the real move-in bill', () => {
  /**
   * The lease drafted from a paid reservation, billed through the REAL
   * jobs/moveInBundle (what the signature runs): the reservation money comes off
   * the arrival rent, and what the arrival rent did not use is kept on the lease
   * as paid-ahead money. Never hand-built rows.
   */
  async function billedFromPaidReservation(paid: number) {
    const f = await stayWithDraftedLease({ bill: false })
    await db.query(`UPDATE unit_bookings SET deposit_amount = $2, deposit_paid_at = NOW() - interval '1 day' WHERE id = $1`, [f.bookingId, paid])
    const dates = (await db.query<{ start: string }>(
      `UPDATE leases l SET end_date = b.check_out, needs_review = FALSE
         FROM unit_bookings b WHERE b.id = l.source_booking_id AND l.id = $1
       RETURNING to_char(l.start_date, 'YYYY-MM-DD') AS start`, [f.leaseId])).rows[0]
    const { generateMoveInInvoice } = await import('../jobs/moveInBundle')
    const r = await generateMoveInInvoice({
      lease_id: f.leaseId, unit_id: f.unitId, tenant_id: f.tenantId,
      landlord_id: f.landlordId, rent_amount: 1000, start_date: dates.start,
    })
    expect(r.invoiceCreated).toBe(true)
    return { ...f, bill: r }
  }
  const nothingZeroed = async (f: { leaseId: string; bookingId: string }) => {
    const { NEVER_MOVED_IN_NOTE } = await import('../lib/unwindIssuedLease')
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM payments WHERE lease_id = $1 AND strpos(COALESCE(notes, ''), $2) > 0`,
      [f.leaseId, NEVER_MOVED_IN_NOTE])).rows[0].n).toBe(0)
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM invoices WHERE lease_id = $1 AND status = 'void'`, [f.leaseId])).rows[0].n).toBe(0)
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
    expect((await leaseStatus(f.leaseId)).status).toBe('pending')
  }
  const neverMovedInRead = async (f: { leaseId: string; token: string }) =>
    (await request(buildApp()).get(`/api/leases/${f.leaseId}/never-moved-in`).set('Authorization', `Bearer ${f.token}`)).body.data

  it('an unsigned draft ended by a mistaken cancel can be brought back, and its paid reservation deposit is still on the stay', async () => {
    const f = await stayWithDraftedLease({ bill: false })
    await db.query(`UPDATE leases SET signed_by_tenant = FALSE, signed_by_landlord = FALSE WHERE id = $1`, [f.leaseId])
    await db.query(`UPDATE unit_bookings SET deposit_amount = 300, deposit_paid_at = NOW() - interval '1 day' WHERE id = $1`, [f.bookingId])
    const canceled = await cancel(f)
    expect(canceled.status).toBe(200)
    expect(canceled.body.data.leaseClosed).toBe('Pat Guest\'s lease drafted with this reservation ended with it. Nothing was owed on it.')
    const back = await patchStatus(f, 'confirmed')
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    const stay = (await db.query(`SELECT status, deposit_amount::float AS deposit, deposit_paid_at FROM unit_bookings WHERE id = $1`, [f.bookingId])).rows[0]
    expect(stay.status).toBe('confirmed')
    expect(stay.deposit).toBe(300)
    expect(stay.deposit_paid_at).not.toBeNull()
  })

  it('an unsigned draft with no money at all, canceled by mistake, can be brought back too', async () => {
    const f = await stayWithDraftedLease({ bill: false })
    await db.query(`UPDATE leases SET signed_by_tenant = FALSE, signed_by_landlord = FALSE WHERE id = $1`, [f.leaseId])
    expect((await cancel(f)).status).toBe(200)
    const back = await patchStatus(f, 'tentative')
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(await bookingStatus(f.bookingId)).toBe('tentative')
  })

  it('the refusal names a zeroed bill only when one was zeroed', async () => {
    const { closedStayRefusal } = await import('./units')
    // A move-in bill zeroed by the close: the words say so.
    const zeroed = await stayWithDraftedLease()
    expect((await cancel(zeroed, { expectedNeverMovedInTotal: 1500 })).status).toBe(200)
    const r1 = await patchStatus(zeroed, 'confirmed')
    expect(r1.status).toBe(409)
    expect(r1.body.error).toBe(closedStayRefusal('Pat Guest', 'cancelled', true))
    expect(r1.body.error).toContain('(its move-in bill zeroed)')
    // A signed lease the close ended with no bill on it: still refused (it was
    // issued), but never "its move-in bill zeroed" — none existed.
    const signed = await stayWithDraftedLease({ bill: false })
    const c2 = await cancel(signed)
    expect(c2.status).toBe(200)
    expect(c2.body.data.leaseClosed).toBe('Pat Guest\'s lease drafted with this reservation ended with it. Nothing was owed on it.')
    const r2 = await patchStatus(signed, 'confirmed')
    expect(r2.status).toBe(409)
    expect(r2.body.error).toBe('Pat Guest\'s reservation was canceled, and the lease drafted with it had been signed and was ended as never moved in, '
      + 'so the reservation can’t be brought back — nothing was changed. If Pat Guest is coming after all, book a new reservation on the Schedule.')
    expect(r2.body.error).not.toMatch(/zeroed/)
    expect(await bookingStatus(signed.bookingId)).toBe('cancelled')
  })

  it('a “They never moved in” that commits while the stay is being brought back is seen inside the save: refused 409, the stay stays canceled', async () => {
    // The lease ended some other way, its move-in bill still open, the stay
    // canceled — so bringing the stay back passes the check before the save.
    const f = await stayWithDraftedLease()
    await db.query(`UPDATE leases SET status = 'terminated', termination_reason = 'Hold lapsed' WHERE id = $1`, [f.leaseId])
    await db.query(`UPDATE unit_bookings SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [f.bookingId])
    const { getClient } = await import('../db')
    const { closeNeverMovedInBill } = await import('../lib/unwindIssuedLease')
    const other = await getClient()
    let pending: Promise<request.Response> | null = null
    try {
      await other.query('BEGIN')
      // The Leases page's close: takes the stay's row first, zeroes and voids the move-in bill.
      const closed = await closeNeverMovedInBill(other, f.leaseId, { attested: true })
      expect(closed.closed).toBe(true)
      pending = patchStatus(f, 'confirmed').then(r => r)
      // Wait until the save is waiting on the stay's row, then let the close commit.
      // Fix pass 1 (review LOW): the race must actually happen — if the save
      // never blocks on the row in time, the test fails instead of passing
      // without exercising it.
      let sawSaveWaiting = false
      for (let i = 0; i < 400; i++) {
        const waiting = (await db.query(
          `SELECT COUNT(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FROM unit_bookings WHERE id = $1 FOR UPDATE%'`)).rows[0].n
        if (waiting > 0) { sawSaveWaiting = true; break }
        await new Promise(res => setTimeout(res, 25))
      }
      await other.query('COMMIT')
      expect(sawSaveWaiting, 'the save never waited on the stay’s row — the race was not exercised').toBe(true)
    } catch (e) { await other.query('ROLLBACK').catch(() => {}); throw e } finally { other.release() }
    const res = await pending!
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    const { closedStayRefusal } = await import('./units')
    expect(res.body.error).toBe(closedStayRefusal('Pat Guest', 'cancelled', true))
    expect(await bookingStatus(f.bookingId)).toBe('cancelled')
  })

  it('a reservation deposit smaller than the first rent, billed through the real move-in bill: both doors refuse naming the money paid, and nothing is zeroed', async () => {
    const f = await billedFromPaidReservation(20)
    expect(f.bill.stayDepositCredited).toBe(20)
    expect(f.bill.stayDepositLeftover).toBe(0)
    const shown = (await cancelCheck(f)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/^Pat Guest's reservation has a lease drafted with it, and canceling the reservation ends that lease — but \$20\.00 was paid toward the reservation this lease was drafted from, so it can’t be closed as if nothing happened\. /)
    expect((await cancel(f, { expectedNeverMovedInTotal: f.bill.rentAmount })).status).toBe(409)
    const read = await neverMovedInRead(f)
    expect(read.applies).toBe(false)
    expect(read.words).toMatch(/^\$20\.00 was paid toward the reservation this lease was drafted from, so it can’t be closed as if nothing happened\. /)
    await nothingZeroed(f)
  })

  it('a reservation deposit bigger than the first rent, billed through the real move-in bill: each dollar said once, both doors refuse, nothing is zeroed', async () => {
    const f = await billedFromPaidReservation(1500)
    const { centsWords } = await import('../lib/unwindIssuedLease')
    const used = Math.round((f.bill.stayDepositCredited ?? 0) * 100)
    const left = Math.round((f.bill.stayDepositLeftover ?? 0) * 100)
    expect(used + left).toBe(150000)
    expect(left).toBeGreaterThan(0)
    const said = `${centsWords(used)} was paid toward the reservation this lease was drafted from and ${centsWords(left)} they paid ahead is on this lease, so it can’t be closed as if nothing happened.`
    const shown = (await cancelCheck(f)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toContain(said)
    expect((await cancel(f, { expectedNeverMovedInTotal: 0 })).status).toBe(409)
    expect((await neverMovedInRead(f)).words).toMatch(new RegExp(`^${said.replace(/[.*+?^${}()|[\]\\$]/g, '\\$&')}`))
    await nothingZeroed(f)
  })

  it('a withdrawn reservation leftover is not taken off again: a lease billed again after its leftover was voided says each dollar of the reservation once', async () => {
    const f = await billedFromPaidReservation(1500)
    const { centsWords } = await import('../lib/unwindIssuedLease')
    // The first bill's leftover withdrawn, and the move-in bill written again
    // (as a lease unwound and signed again is): the real move-in bill keeps a
    // new leftover in its place.
    //
    // Fix pass 1 (review LOW): built the way the real code does it, never by
    // deleting rows. The leftover is withdrawn by the real voidPaidAhead; the
    // first bill is voided the way unwindIssuedLease voids a bill (its unpaid
    // charge rows removed, the invoice KEPT as void with a $0 total — so the
    // voided bill is still the lease's first invoice). One invoice per lease
    // per due date (ux_invoices_lease_due_date), so the bill written again is
    // for the new start the lease was signed again with, a day later.
    const { getClient } = await import('../db')
    const { voidPaidAhead } = await import('../services/creditUse')
    const tx = await getClient()
    try {
      await tx.query('BEGIN')
      const leftover = (await tx.query(`SELECT id FROM lease_prepaid_credits WHERE lease_id = $1 AND voided_at IS NULL`, [f.leaseId])).rows
      expect(leftover).toHaveLength(1)
      await voidPaidAhead(tx, leftover[0].id, 'The lease was voided before it started')
      const invoiceIds = (await tx.query(`SELECT id FROM invoices WHERE lease_id = $1`, [f.leaseId])).rows.map(r => r.id)
      await tx.query(`DELETE FROM payments WHERE lease_id = $1 AND status IN ('pending','failed')`, [f.leaseId])
      await tx.query(`DELETE FROM payments WHERE invoice_id = ANY($1::uuid[]) AND status IN ('pending','failed')`, [invoiceIds])
      await tx.query(`UPDATE invoices SET status = 'void', total_amount = 0, updated_at = NOW() WHERE id = ANY($1::uuid[])`, [invoiceIds])
      await tx.query(`UPDATE leases SET start_date = start_date + 1 WHERE id = $1`, [f.leaseId])
      await tx.query('COMMIT')
    } catch (e) { await tx.query('ROLLBACK').catch(() => {}); throw e } finally { tx.release() }
    const start = (await db.query(`SELECT to_char(start_date, 'YYYY-MM-DD') AS s FROM leases WHERE id = $1`, [f.leaseId])).rows[0].s
    const { generateMoveInInvoice } = await import('../jobs/moveInBundle')
    const again = await generateMoveInInvoice({
      lease_id: f.leaseId, unit_id: f.unitId, tenant_id: f.tenantId, landlord_id: f.landlordId, rent_amount: 1000, start_date: start,
    })
    expect(again.invoiceCreated).toBe(true)
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM lease_prepaid_credits WHERE lease_id = $1`, [f.leaseId])).rows[0].n).toBe(2)
    const used = Math.round((again.stayDepositCredited ?? 0) * 100)
    const left = Math.round((again.stayDepositLeftover ?? 0) * 100)
    const shown = (await cancelCheck(f)).body.data
    expect(shown.words).toContain(`${centsWords(used)} was paid toward the reservation this lease was drafted from and ${centsWords(left)} they paid ahead is on this lease`)
    // The voided bill is still the lease's first invoice; nothing new was voided or zeroed.
    const firstInvoice = (await db.query(`SELECT status FROM invoices WHERE lease_id = $1 ORDER BY created_at, due_date, id LIMIT 1`, [f.leaseId])).rows[0]
    expect(firstInvoice.status).toBe('void')
    const { NEVER_MOVED_IN_NOTE } = await import('../lib/unwindIssuedLease')
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM payments WHERE lease_id = $1 AND strpos(COALESCE(notes, ''), $2) > 0`,
      [f.leaseId, NEVER_MOVED_IN_NOTE])).rows[0].n).toBe(0)
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM invoices WHERE lease_id = $1 AND status = 'void'`, [f.leaseId])).rows[0].n).toBe(1)
    expect(await bookingStatus(f.bookingId)).toBe('confirmed')
    expect((await leaseStatus(f.leaseId)).status).toBe('pending')
  })
})
