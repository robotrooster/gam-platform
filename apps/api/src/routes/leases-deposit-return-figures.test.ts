/**
 * Step 9 (final fix) — the deposit-return page shows the server's figures.
 *
 * Before this the landlord page worked the refund out itself (deposit +
 * interest − deductions) for its confirm text, its result tile and the staff
 * approval limit, while finalize (depositReturn.moveOutMath) worked it out its
 * own way. The landlord could confirm one figure while finalize wrote another.
 * These run the real move-out calculation through GET
 * /api/leases/:id/deposit-return (no service mocks) and pin what the page
 * reads: refund_amount, gap_amount, prepaid_credit_used, prepaid_credit_left,
 * deposit_interest_credited, the deposit interest still owed and who holds the
 * deposit — and POST /finalize refusing figures that moved since the confirm.
 *
 * Which money the deductions draw on first is moveOutMath's rule
 * (services/depositReturn.ts). Decision #46.2 (Nic, 10/4, FINAL): the
 * security deposit first; paid-ahead money only covers what the deposit
 * can't, and what is left of it waits for the landlord's choice. Decision
 * #46.3: the answer names who refunds which part (refund_from_gam /
 * refund_from_landlord). Decision #46.4: ending a lease whose tenant never
 * paid the move-in bill or moved in zeroes that bill.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedLeaseFee, seedSecurityDeposit,
} from '../test/dbHelpers'
import { leasesRouter } from './leases'
import { calculateDepositReturn } from '../services/depositReturn'
import { errorHandler } from '../middleware/errorHandler'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_deposit_figures'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/leases', leasesRouter)
  app.use(errorHandler)
  return app
}

beforeEach(cleanupAllSchema)

async function seedMoveOut(o: {
  deposit: number; cleaning?: number; paidAhead?: number; interestAccrued?: number; heldBy?: 'landlord' | 'gam_escrow'
}) {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    // An RV spot: its move-out walkthrough is the pull-out meter read, so the
    // draft can begin without an inspection.
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 1000, unitType: 'rv_spot' })
    const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 1000 })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    if (o.cleaning) await seedLeaseFee(c, { leaseId, feeType: 'cleaning_fee', amount: o.cleaning, dueTiming: 'move_out' })
    const depositId = await seedSecurityDeposit(c, {
      unitId, leaseId, tenantId, totalAmount: o.deposit, interestAccrued: o.interestAccrued ?? 0, heldBy: o.heldBy ?? 'landlord',
    })
    if (o.paidAhead) {
      await c.query(
        `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at)
         VALUES ($1, $2, $3, $3, 'landlord', NOW())`, [leaseId, tenantId, o.paidAhead.toFixed(2)])
    }
    const token = jwt.sign({ userId, role: 'landlord', email: 'l@t.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { leaseId, depositId, landlordId, tenantId, token, propertyId, unitId, userId }
  } finally { c.release() }
}

/**
 * A team member (onsite manager) on this landlord's account, with these
 * permissions and this property scope — a real user and scope row, as the
 * scope guards read them fresh.
 */
async function staffToken(landlordId: string, permissions: Record<string, boolean>,
  scope: { all?: boolean; propertyIds?: string[] }): Promise<string> {
  const c = await db.connect()
  try {
    const userId = (await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'onsite_manager', 'Lisa', 'Staff', TRUE) RETURNING id`, [`staff-${randomUUID()}@t.dev`])).rows[0].id
    await c.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties)
       VALUES ($1, $2, $3::uuid[], $4)`, [userId, landlordId, scope.propertyIds ?? [], scope.all === true])
    return jwt.sign({ userId, role: 'onsite_manager', email: 's@t.dev', landlordId, permissions },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
  } finally { c.release() }
}

const get = (leaseId: string, token: string) =>
  request(buildApp()).get(`/api/leases/${leaseId}/deposit-return`).set('Authorization', `Bearer ${token}`)

const begin = (leaseId: string, token: string) =>
  request(buildApp()).post(`/api/leases/${leaseId}/deposit-return`).set('Authorization', `Bearer ${token}`)
const finalize = (leaseId: string, token: string, body: Record<string, unknown> = {}) =>
  request(buildApp()).post(`/api/leases/${leaseId}/deposit-return/finalize`).set('Authorization', `Bearer ${token}`).send(body)

/** The figures the route answers with, as the one move-out calculation has them. */
const serverFigures = (c: NonNullable<Awaited<ReturnType<typeof calculateDepositReturn>>>) => ({
  total_deposit: c.total_deposit, total_deductions: c.total_deductions,
  refund_amount: c.refund_amount, gap_amount: c.gap_amount,
  prepaid_credit_used: c.prepaid_credit_used, prepaid_credit_left: c.prepaid_credit_left,
  deposit_interest_credited: c.deposit_interest_credited, interest_accrued: c.interest_accrued,
})

describe('the deposit-return page reads the figures finalize pays', () => {
  it('$500 deposit, $40 cleaning: the preview and the draft both say $460 back', async () => {
    const m = await seedMoveOut({ deposit: 500, cleaning: 40 })
    const preview = await get(m.leaseId, m.token)
    expect(preview.status).toBe(200)
    expect(preview.body.data).toMatchObject({
      preview: true, total_deposit: 500, total_deductions: 40, refund_amount: 460, gap_amount: 0,
      prepaid_credit_used: 0, prepaid_credit_left: 0, deposit_interest_credited: 0, interest_accrued: 0,
    })
    const started = await begin(m.leaseId, m.token)
    expect(started.status).toBe(200)
    const draft = await get(m.leaseId, m.token)
    expect(draft.body.data.id).toBe(started.body.data.id)
    expect(draft.body.data).toMatchObject({ status: 'draft', refund_amount: 460, gap_amount: 0 })
  })

  it('with money paid ahead, the preview and the draft carry the move-out calculation\'s own split — every paid-ahead dollar either used or left, every deduction paid once', async () => {
    const m = await seedMoveOut({ deposit: 500, cleaning: 40, paidAhead: 300 })
    const calc = (await calculateDepositReturn(m.leaseId))!
    const preview = (await get(m.leaseId, m.token)).body.data
    expect(preview).toMatchObject(serverFigures(calc))
    // Whichever money goes first, nothing is counted twice or lost.
    expect(preview.prepaid_credit_used + preview.prepaid_credit_left).toBe(300)
    expect(Math.round((preview.prepaid_credit_used + (500 - preview.refund_amount)) * 100) / 100).toBe(40)
    await begin(m.leaseId, m.token)
    expect((await get(m.leaseId, m.token)).body.data).toMatchObject({ status: 'draft', ...serverFigures(calc) })
  })

  it('deductions beyond the deposit and the paid-ahead money: the shortfall is the server\'s, the paid-ahead money all used', async () => {
    const m = await seedMoveOut({ deposit: 200, cleaning: 400, paidAhead: 100 })
    const res = await get(m.leaseId, m.token)
    expect(res.body.data).toMatchObject({
      refund_amount: 0, gap_amount: 100, prepaid_credit_used: 100, prepaid_credit_left: 0,
    })
  })

  it('a draft\'s saved damage lines are counted, and a figure the saved row went stale on is replaced by the live one', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await begin(m.leaseId, m.token)
    await db.query(
      `UPDATE deposit_returns SET damage_lines = $2::jsonb, refund_amount = 999, gap_amount = 0 WHERE lease_id = $1`,
      [m.leaseId, JSON.stringify([{ description: 'Broken window', amount: 80, evidenceDocumentIds: [randomUUID()] }])])
    const res = await get(m.leaseId, m.token)
    expect(res.body.data).toMatchObject({ refund_amount: 420, gap_amount: 0, damage_lines_total: 80 })
  })

  it('deposit interest is only what is still owed — a month the annual payout already credited is not shown again', async () => {
    // The record's running total is $42.50; the payout already credited $40 of it.
    const m = await seedMoveOut({ deposit: 500, interestAccrued: 42.5 })
    await db.query(
      `INSERT INTO security_deposit_interest_accruals
         (security_deposit_id, lease_id, accrual_month, state_code, effective_year, annual_rate_pct,
          principal_amount, days_held, days_in_month, interest_amount, paid_at)
       VALUES ($1, $2, '2026-01-01', 'XX', 2026, 1.0, 500, 31, 31, 40, NOW()),
              ($1, $2, '2026-02-01', 'XX', 2026, 1.0, 500, 28, 28, 2.5, NULL)`,
      [m.depositId, m.leaseId])
    const res = await get(m.leaseId, m.token)
    expect(res.body.data.interest_accrued).toBe(2.5)
    expect(res.body.data.refund_amount).toBe(502.5)
  })

  // Fix pass 2 (decisions #47c, Nic): who holds the deposit is never shown to
  // tenants or landlords — the page says how each part comes back
  // (refund_from_gam / refund_from_landlord) instead, so the holder is not sent.
  it.each(['landlord', 'gam_escrow'] as const)('never sends who holds the deposit (%s) — only how each part of the refund comes back', async (heldBy) => {
    const m = await seedMoveOut({ deposit: 500, heldBy })
    const before = (await get(m.leaseId, m.token)).body.data
    expect(before).not.toHaveProperty('deposit_held_by')
    expect(before.refund_from_gam + before.refund_from_landlord).toBe(500)
    await begin(m.leaseId, m.token)
    expect((await get(m.leaseId, m.token)).body.data).not.toHaveProperty('deposit_held_by')
  })
})

describe('the page is told who this is, and who may decide the paid-ahead money', () => {
  it('names the household and the space, and says the landlord may make the paid-ahead choice', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    const data = (await get(m.leaseId, m.token)).body.data
    expect(data.household.tenant_names).toEqual(['Test Tenant'])
    expect(data.household.unit_number).toBeTruthy()
    expect(data.household.property_name).toBeTruthy()
    expect(data.viewer_can_decide_paid_ahead).toBe(true)
  })

  it('after the lease ended (its people taken off it), the household is still named', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await db.query(`UPDATE lease_tenants SET status = 'removed', removed_reason = 'lease_ended', removed_at = NOW() WHERE lease_id = $1`, [m.leaseId])
    expect((await get(m.leaseId, m.token)).body.data.household.tenant_names).toEqual(['Test Tenant'])
  })

  it('a team member without "Issue refunds" is told they may not make the paid-ahead choice', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    const staff = await staffToken(m.landlordId, { 'leases.deposit_return': true }, { all: true })
    const res = await get(m.leaseId, staff)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ viewer_can_decide_paid_ahead: false, viewer_is_owner: false })
    const allowed = await staffToken(m.landlordId, { 'leases.deposit_return': true, 'pos.refund': true }, { propertyIds: [m.propertyId] })
    expect((await get(m.leaseId, allowed)).body.data.viewer_can_decide_paid_ahead).toBe(true)
  })
})

describe('finalize checks the figures the confirm showed', () => {
  it('a refund that moved since the confirm opened: 409 in plain words, nothing finalized', async () => {
    const m = await seedMoveOut({ deposit: 500, cleaning: 40 })
    await begin(m.leaseId, m.token)
    // The confirm said $460; the move-out fee goes up $25 before Finalize is
    // clicked. Only the lease fee changes — the one source finalize reads.
    await db.query(`UPDATE lease_fees SET amount = 65 WHERE lease_id = $1 AND due_timing = 'move_out'`, [m.leaseId])
    const res = await finalize(m.leaseId, m.token, { expectedRefund: 460, expectedGap: 0 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('The figures changed since you opened this, so nothing was paid out. ' +
      'The page now shows the new ones — review them and finalize again.')
    const row = await db.query<{ status: string; finalized_at: string | null }>(
      `SELECT status, finalized_at FROM deposit_returns WHERE lease_id = $1`, [m.leaseId])
    expect(row.rows[0]).toMatchObject({ status: 'draft', finalized_at: null })
    // The page reads the new figures and finalizes on them.
    expect((await get(m.leaseId, m.token)).body.data.refund_amount).toBe(435)
  })

  it('a shortfall that moved is refused the same way', async () => {
    const m = await seedMoveOut({ deposit: 200, cleaning: 300 })
    await begin(m.leaseId, m.token)
    const res = await finalize(m.leaseId, m.token, { expectedRefund: 0, expectedGap: 50 })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^The figures changed since you opened this/)
  })

  it('figures that still match: finalize goes through and records the refund the confirm showed', async () => {
    const m = await seedMoveOut({ deposit: 500, cleaning: 40 })
    await begin(m.leaseId, m.token)
    const res = await finalize(m.leaseId, m.token, { expectedRefund: 460, expectedGap: 0 })
    expect(res.status).toBe(200)
    const row = await db.query<{ status: string; refund_amount: string }>(
      `SELECT status, refund_amount::text FROM deposit_returns WHERE lease_id = $1`, [m.leaseId])
    expect(row.rows[0]).toMatchObject({ status: 'sent_refund', refund_amount: '460.00' })
  })

  it('a caller that sends no figures is not checked (as before)', async () => {
    const m = await seedMoveOut({ deposit: 500, cleaning: 40 })
    await begin(m.leaseId, m.token)
    expect((await finalize(m.leaseId, m.token)).status).toBe(200)
  })

  it('a figure that is not a number is refused as a bad request, nothing finalized', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await begin(m.leaseId, m.token)
    expect((await finalize(m.leaseId, m.token, { expectedRefund: 'lots' })).status).toBe(400)
    const row = await db.query<{ status: string }>(`SELECT status FROM deposit_returns WHERE lease_id = $1`, [m.leaseId])
    expect(row.rows[0].status).toBe('draft')
  })
})

// Decision #46.2 (Nic, 10/4, FINAL): move-out deductions come out of the
// SECURITY DEPOSIT FIRST; the rent paid ahead only covers what the deposit
// can't, and the rest of it goes to the landlord's choice (#46.1).
describe('#46.2 — the deposit pays the deductions first', () => {
  it('$500 deposit, $300 paid ahead, $40 cleaning: refund $460, no paid-ahead money used, $300 left', async () => {
    const m = await seedMoveOut({ deposit: 500, cleaning: 40, paidAhead: 300 })
    expect((await get(m.leaseId, m.token)).body.data).toMatchObject({
      refund_amount: 460, gap_amount: 0, prepaid_credit_used: 0, prepaid_credit_left: 300,
    })
  })

  it('$600 of deductions on a $500 deposit with $300 paid ahead: $100 of it used, $200 left, no refund', async () => {
    const m = await seedMoveOut({ deposit: 500, cleaning: 600, paidAhead: 300 })
    expect((await get(m.leaseId, m.token)).body.data).toMatchObject({
      refund_amount: 0, gap_amount: 0, prepaid_credit_used: 100, prepaid_credit_left: 200,
    })
  })
})

// Deposit-page review: one move-out fee source — the live lease fee at the
// moment of finalize (lease is law). A move-out fee edited, or a conditional
// fee the walkthrough marks failed, after Begin Move-Out is counted by the
// draft, its confirm and finalize alike, and the draft's stored figure is
// refreshed.
describe('one move-out fee source', () => {
  it('a move-out fee added after Begin Move-Out: the draft\'s refund is the refund finalize records', async () => {
    const m = await seedMoveOut({ deposit: 500, cleaning: 40 })
    await begin(m.leaseId, m.token)
    const c = await db.connect()
    try { await seedLeaseFee(c, { leaseId: m.leaseId, feeType: 'other_fee', amount: 25, dueTiming: 'other' }) }
    finally { c.release() }
    const shown = (await get(m.leaseId, m.token)).body.data.refund_amount
    expect((await finalize(m.leaseId, m.token, { expectedRefund: shown, expectedGap: 0 })).status).toBe(200)
    const row = await db.query<{ refund_amount: string }>(
      `SELECT refund_amount::text FROM deposit_returns WHERE lease_id = $1`, [m.leaseId])
    expect(Number(row.rows[0].refund_amount)).toBe(shown)
  })
})

describe('one move-out fee source: a conditional fee the walkthrough fails after Begin', () => {
  it('Begin, flip a conditional fee to failed, GET the draft, finalize with what it showed: the amounts are equal and the draft\'s stored fee is refreshed', async () => {
    const m = await seedMoveOut({ deposit: 500, cleaning: 40 })
    const c = await db.connect()
    let feeId: string
    try {
      feeId = (await c.query<{ id: string }>(
        `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable, condition_text)
         VALUES ($1, 'other_fee', 60, 'other', FALSE, 'Yard cleared at move-out') RETURNING id`, [m.leaseId])).rows[0].id
    } finally { c.release() }
    await begin(m.leaseId, m.token)
    expect((await get(m.leaseId, m.token)).body.data.refund_amount).toBe(460)
    await db.query(`UPDATE lease_fees SET condition_result = 'failed' WHERE id = $1`, [feeId!])
    const shown = (await get(m.leaseId, m.token)).body.data
    expect(shown).toMatchObject({ refund_amount: 400, cleaning_fee_amount: 100 })
    const done = await finalize(m.leaseId, m.token, { expectedRefund: shown.refund_amount, expectedGap: shown.gap_amount })
    expect(done.status).toBe(200)
    const row = await db.query<{ refund_amount: string; cleaning_fee_amount: string }>(
      `SELECT refund_amount::text, cleaning_fee_amount::text FROM deposit_returns WHERE lease_id = $1`, [m.leaseId])
    expect(row.rows[0]).toEqual({ refund_amount: '400.00', cleaning_fee_amount: '100.00' })
  })
})

describe('#46.3 — the page is told who refunds which part', () => {
  it('a deposit the landlord holds: the whole refund is the landlord\'s to hand back, before and after finalize', async () => {
    const m = await seedMoveOut({ deposit: 500, cleaning: 40, heldBy: 'landlord' })
    expect((await get(m.leaseId, m.token)).body.data).toMatchObject({ refund_amount: 460, refund_from_gam: 0, refund_from_landlord: 460 })
    await begin(m.leaseId, m.token)
    expect((await finalize(m.leaseId, m.token, { expectedRefund: 460, expectedGap: 0 })).status).toBe(200)
    expect((await get(m.leaseId, m.token)).body.data).toMatchObject({ refund_amount: 460, refund_from_gam: 0, refund_from_landlord: 460 })
  })

  it('a deposit GAM holds: GAM sends the refund', async () => {
    const m = await seedMoveOut({ deposit: 500, cleaning: 40, heldBy: 'gam_escrow' })
    expect((await get(m.leaseId, m.token)).body.data).toMatchObject({ refund_from_gam: 460, refund_from_landlord: 0 })
  })
})

describe('#46.4 — ending a lease whose tenant never paid the move-in bill or moved in zeroes that bill', () => {
  const patch = (leaseId: string, token: string, body: Record<string, unknown>) =>
    request(buildApp()).patch(`/api/leases/${leaseId}`).set('Authorization', `Bearer ${token}`).send(body)

  /**
   * A signed lease GAM issued with its move-in bill ($1,000 rent + $500
   * deposit) unpaid. By default it never came into force: still 'pending',
   * starting in five days. `started` makes it an active lease past its start
   * date (the scheduler activates a lease on its start date whether or not
   * anything was paid).
   */
  async function moveInBill(m: { leaseId: string; landlordId: string; tenantId: string }, o: { started?: boolean } = {}) {
    const lease = (await db.query<{ unit_id: string }>(`SELECT unit_id FROM leases WHERE id = $1`, [m.leaseId])).rows[0]
    await db.query(`UPDATE leases SET status = $2, lease_source = 'esigned', signed_by_tenant = TRUE, signed_by_landlord = TRUE,
                            lease_type = 'fixed_term',
                            start_date = CASE WHEN $3 THEN CURRENT_DATE - 10 ELSE CURRENT_DATE + 5 END,
                            end_date = CASE WHEN $3 THEN CURRENT_DATE + 355 ELSE CURRENT_DATE + 370 END
                      WHERE id = $1`, [m.leaseId, o.started ? 'active' : 'pending', o.started === true])
    const inv = (await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, subtotal_deposits, total_amount)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE - 3, 1000, 500, 1500) RETURNING id`,
      [m.landlordId, m.tenantId, m.leaseId, lease.unit_id, `INV-${randomUUID().slice(0, 8)}`])).rows[0].id
    const line = async (type: string, entry: string, amount: number) => (await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', CURRENT_DATE - 3, $8) RETURNING id`,
      [inv, lease.unit_id, m.leaseId, m.tenantId, m.landlordId, type, amount, entry])).rows[0].id
    return { inv, rent: await line('rent', 'RENT', 1000), deposit: await line('deposit', 'DEPOSIT', 500) }
  }
  const owed = async (tenantId: string) => (await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM payments WHERE tenant_id = $1 AND status IN ('pending', 'failed') AND amount > 0`, [tenantId])).rows[0].n

  it('signed, billed, never paid, never moved in (the lease never came into force): ending the lease zeroes every line of the move-in bill with a plain note and voids the bill', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await db.query(`UPDATE security_deposits SET collected_amount = 0, status = 'pending' WHERE lease_id = $1`, [m.leaseId])
    const b = await moveInBill(m)
    expect(await owed(m.tenantId)).toBe(2)
    const res = await patch(m.leaseId, m.token, { status: 'terminated', terminationReason: 'Never moved in' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('terminated')
    expect(res.body.data.closed_move_in_bill ?? res.body.data.closedMoveInBill).toMatchObject({ amount: 1500 })
    const rows = (await db.query(`SELECT status, amount::float AS amount, notes FROM payments WHERE invoice_id = $1 ORDER BY type`, [b.inv])).rows
    expect(rows.map((r: any) => [r.status, r.amount])).toEqual([['settled', 0], ['settled', 0]])
    for (const r of rows) expect(r.notes).toMatch(/the tenant never paid the move-in bill or moved in, so nothing on it is owed/)
    expect((await db.query(`SELECT status FROM invoices WHERE id = $1`, [b.inv])).rows[0].status).toBe('void')
    expect(await owed(m.tenantId)).toBe(0)
    // A deposit record that never had a dollar is not a deposit.
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM security_deposits WHERE lease_id = $1`, [m.leaseId])).rows[0].n).toBe(0)
  })

  it('a deposit nobody paid is never a deposit to refund: after the never-moved-in end, the deposit return shows $0 held and $0 back', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await db.query(`UPDATE security_deposits SET collected_amount = 0, status = 'pending' WHERE lease_id = $1`, [m.leaseId])
    const c = await db.connect()
    try { await seedLeaseFee(c, { leaseId: m.leaseId, feeType: 'security_deposit', amount: 500, dueTiming: 'move_in' }) }
    finally { c.release() }
    await moveInBill(m)
    expect((await patch(m.leaseId, m.token, { status: 'terminated' })).status).toBe(200)
    // The lease still carries its $500 deposit fee; a fee is what the lease
    // asked for, never money anyone holds.
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM lease_fees WHERE lease_id = $1 AND fee_type = 'security_deposit'`, [m.leaseId])).rows[0].n).toBe(1)
    const shown = (await get(m.leaseId, m.token)).body.data
    expect(shown).toMatchObject({ total_deposit: 0, refund_amount: 0, refund_from_gam: 0, refund_from_landlord: 0 })
  })

  it('an active lease past its start date with only the move-in bill unpaid (the tenant may well live there): ending it keeps the rent owed', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await db.query(`UPDATE security_deposits SET collected_amount = 0, status = 'pending' WHERE lease_id = $1`, [m.leaseId])
    const b = await moveInBill(m, { started: true })
    const res = await patch(m.leaseId, m.token, { status: 'terminated', terminationReason: 'Eviction' })
    expect(res.status).toBe(200)
    expect(res.body.data.closed_move_in_bill ?? res.body.data.closedMoveInBill ?? null).toBeNull()
    expect((await db.query(`SELECT status, amount::float AS amount FROM payments WHERE id = $1`, [b.rent])).rows[0])
      .toEqual({ status: 'pending', amount: 1000 })
    expect((await db.query(`SELECT status FROM invoices WHERE id = $1`, [b.inv])).rows[0].status).not.toBe('void')
  })

  it('a renewal keeps its first bill owed — the household lives there: ended in its first month, or (never through this door) before it started', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    const b = await moveInBill(m, { started: true })
    const c = await db.connect()
    let before: string
    try {
      const lease = (await c.query<{ unit_id: string; landlord_id: string }>(`SELECT unit_id, landlord_id FROM leases WHERE id = $1`, [m.leaseId])).rows[0]
      before = await seedLease(c, { unitId: lease.unit_id, landlordId: lease.landlord_id, status: 'expired' })
    } finally { c.release() }
    await db.query(`UPDATE leases SET supersedes_lease_id = $2 WHERE id = $1`, [m.leaseId, before!])
    expect((await patch(m.leaseId, m.token, { status: 'terminated' })).status).toBe(200)
    expect((await db.query(`SELECT status, amount::float AS amount FROM payments WHERE id = $1`, [b.rent])).rows[0])
      .toEqual({ status: 'pending', amount: 1000 })
    // A renewal waiting to start is refused at the door (renewalSuccessor
    // .newLeaseBlocksEarlyEnd); the close itself never takes one either.
    await db.query(`UPDATE leases SET status = 'pending', start_date = CURRENT_DATE + 5, terminated_at = NULL WHERE id = $1`, [m.leaseId])
    const { closeNeverMovedInBill } = await import('../lib/unwindIssuedLease')
    const t = await db.connect()
    try {
      await t.query('BEGIN')
      expect((await closeNeverMovedInBill(t, m.leaseId)).closed).toBe(false)
      await t.query('ROLLBACK')
    } finally { t.release() }
  })

  it('ending the lease is one transaction: when the close fails, the lease is not ended and the household stays on it', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await db.query(`UPDATE security_deposits SET collected_amount = 0, status = 'pending' WHERE lease_id = $1`, [m.leaseId])
    const b = await moveInBill(m)
    const unwind = await import('../lib/unwindIssuedLease')
    const spy = vi.spyOn(unwind, 'closeNeverMovedInBill').mockRejectedValueOnce(new Error('lock timeout'))
    try {
      const res = await patch(m.leaseId, m.token, { status: 'terminated' })
      expect(res.status).toBe(500)
    } finally { spy.mockRestore() }
    const lease = (await db.query(`SELECT status, terminated_at FROM leases WHERE id = $1`, [m.leaseId])).rows[0]
    expect(lease).toMatchObject({ status: 'pending', terminated_at: null })
    expect((await db.query(`SELECT status FROM lease_tenants WHERE lease_id = $1`, [m.leaseId])).rows[0].status).toBe('active')
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [b.rent])).rows[0].status).toBe('pending')
    // Tried again, it ends and closes the bill.
    const again = await patch(m.leaseId, m.token, { status: 'terminated' })
    expect(again.status).toBe(200)
    expect(again.body.data.closed_move_in_bill).toMatchObject({ amount: 1500 })
  })

  it('a tenant who paid anything on the lease did start the tenancy: ending it leaves the unpaid lines owed', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    const b = await moveInBill(m)
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash' WHERE id = $1`, [b.deposit])
    const res = await patch(m.leaseId, m.token, { status: 'terminated' })
    expect(res.status).toBe(200)
    expect(res.body.data.closed_move_in_bill ?? res.body.data.closedMoveInBill ?? null).toBeNull()
    expect((await db.query(`SELECT status, amount::float AS amount FROM payments WHERE id = $1`, [b.rent])).rows[0])
      .toEqual({ status: 'pending', amount: 1000 })
  })

  it('a lease with a second bill (the tenancy ran a month) or an imported tenancy is an ordinary end: nothing is zeroed', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    const b = await moveInBill(m)
    const lease = (await db.query<{ unit_id: string }>(`SELECT unit_id FROM leases WHERE id = $1`, [m.leaseId])).rows[0]
    await db.query(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE + 27, 1000, 1000)`,
      [m.landlordId, m.tenantId, m.leaseId, lease.unit_id, `INV-${randomUUID().slice(0, 8)}`])
    expect((await patch(m.leaseId, m.token, { status: 'terminated' })).status).toBe(200)
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [b.rent])).rows[0].status).toBe('pending')

    const n = await seedMoveOut({ deposit: 500 })
    const nb = await moveInBill(n)
    await db.query(`UPDATE leases SET lease_source = 'imported' WHERE id = $1`, [n.leaseId])
    expect((await patch(n.leaseId, n.token, { status: 'terminated' })).status).toBe(200)
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [nb.rent])).rows[0].status).toBe('pending')
  })

  // ── Step 9 (final fix, fix pass 1): "They never moved in — end the lease" ──
  const nmiGet = (leaseId: string, token: string) =>
    request(buildApp()).get(`/api/leases/${leaseId}/never-moved-in`).set('Authorization', `Bearer ${token}`)
  const nmiPost = (leaseId: string, token: string, body: Record<string, unknown>) =>
    request(buildApp()).post(`/api/leases/${leaseId}/never-moved-in`).set('Authorization', `Bearer ${token}`).send(body)

  it('a lease the scheduler already made active on its start date, never paid, never moved into: the confirm lists exactly what is zeroed, and ending it zeroes that, voids the bill, ends the lease and empties the space', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await db.query(`UPDATE security_deposits SET collected_amount = 0, status = 'pending' WHERE lease_id = $1`, [m.leaseId])
    const b = await moveInBill(m, { started: true })
    await db.query(`UPDATE units SET status = 'active' WHERE id = $1`, [m.unitId])
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown).toMatchObject({ applies: true, words: null, status: 'active', total: 1500 })
    expect(shown.lines.map((l: any) => [l.label, l.amount])).toEqual([['Rent', 1000], ['Deposit', 500]])
    expect(shown.household.tenant_names).toEqual(['Test Tenant'])
    const res = await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'terminated', zeroed_total: 1500 })
    expect(await owed(m.tenantId)).toBe(0)
    expect((await db.query(`SELECT status FROM invoices WHERE id = $1`, [b.inv])).rows[0].status).toBe('void')
    const lease = (await db.query(`SELECT status, termination_reason, terminated_at FROM leases WHERE id = $1`, [m.leaseId])).rows[0]
    expect(lease).toMatchObject({ status: 'terminated', termination_reason: 'The tenant never moved in' })
    expect(lease.terminated_at).toBeTruthy()
    expect((await db.query(`SELECT status, removed_reason FROM lease_tenants WHERE lease_id = $1`, [m.leaseId])).rows[0])
      .toEqual({ status: 'removed', removed_reason: 'lease_ended' })
    expect((await db.query(`SELECT status FROM units WHERE id = $1`, [m.unitId])).rows[0].status).toBe('vacant')
  })

  // Final fix (fix pass 1, decisions #53 — renamed; it used to zero every
  // unpaid bill): only the move-in bill is zeroed; the later bill stays owed.
  it('a second bill already went out (the start date passed a month ago): staff saying they never moved in zeroes ONLY the move-in bill — the later bill stays owed, listed as “stays owed”', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await db.query(`UPDATE security_deposits SET collected_amount = 0, status = 'pending' WHERE lease_id = $1`, [m.leaseId])
    const b = await moveInBill(m, { started: true })
    const inv2 = (await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, 1000, 1000) RETURNING id`,
      [m.landlordId, m.tenantId, m.leaseId, m.unitId, `INV-${randomUUID().slice(0, 8)}`])).rows[0].id
    const later = (await db.query<{ id: string }>(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1, $2, $3, $4, $5, 'rent', 1000, 'pending', CURRENT_DATE, 'RENT') RETURNING id`, [inv2, m.unitId, m.leaseId, m.tenantId, m.landlordId])).rows[0].id
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown.total).toBe(1500)
    expect(shown.kept.map((k: any) => [k.payment_id, k.why, k.amount])).toEqual([[later, 'later_bill', 1000]])
    expect(shown.kept_words).toMatch(/^Still owed after this: what is not on the move-in bill, Rent due [A-Z][a-z]{2} \d{1,2}, \d{4} \(\$1,000\.00\) — only the move-in bill is zeroed\./)
    const res = await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ zeroed_total: 1500, kept_total: 1000 })
    expect(await owed(m.tenantId)).toBe(1)
    expect((await db.query(`SELECT id, status FROM invoices WHERE id = ANY($1::uuid[]) ORDER BY created_at`, [[b.inv, inv2]])).rows)
      .toEqual([{ id: b.inv, status: 'void' }, { id: inv2, status: 'pending' }])
    expect((await db.query(`SELECT amount::float AS amount, status, invoice_id FROM payments WHERE id = $1`, [later])).rows[0])
      .toEqual({ amount: 1000, status: 'pending', invoice_id: inv2 })
  })

  it('what the lease owes changed since the confirm opened: 409 in plain words, nothing closed; the fresh total then goes through', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await db.query(`UPDATE security_deposits SET collected_amount = 0, status = 'pending' WHERE lease_id = $1`, [m.leaseId])
    await moveInBill(m)
    const res = await nmiPost(m.leaseId, m.token, { expectedTotal: 1000 })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^What this lease owes changed since you opened this, so nothing was closed/)
    expect(await owed(m.tenantId)).toBe(2)
    expect((await db.query(`SELECT status FROM leases WHERE id = $1`, [m.leaseId])).rows[0].status).toBe('pending')
    expect((await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })).status).toBe(200)
  })

  it('money was paid: the confirm says so with the real next step (the move-out), and ending it this way is refused — nothing changes', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    const b = await moveInBill(m, { started: true })
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash' WHERE id = $1`, [b.deposit])
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/^\$500\.00 was already paid on this lease/)
    expect(shown.words).toMatch(/They’re leaving on…/)
    expect(shown.words).toMatch(/Move out/)
    const res = await nmiPost(m.leaseId, m.token, { expectedTotal: 0 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(shown.words)
    expect((await db.query(`SELECT status FROM payments WHERE id = $1`, [b.rent])).rows[0].status).toBe('pending')
    expect((await db.query(`SELECT status FROM leases WHERE id = $1`, [m.leaseId])).rows[0].status).toBe('active')
  })

  it('GAM’s records say they moved in (a finalized move-in walkthrough): refused, naming the walkthrough and the move-out', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await moveInBill(m, { started: true })
    await db.query(
      `INSERT INTO unit_inspections (unit_id, lease_id, landlord_id, inspection_type, status, finalized_at)
       VALUES ($1, $2, $3, 'move_in', 'finalized', NOW())`, [m.unitId, m.leaseId, m.landlordId])
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/^A move-in walkthrough was finalized on .+, so they moved in\./)
    expect((await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })).status).toBe(409)
    expect(await owed(m.tenantId)).toBe(2)
  })

  it('an imported tenancy is refused in plain words (the household already lives there)', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await moveInBill(m, { started: true })
    await db.query(`UPDATE leases SET lease_source = 'imported' WHERE id = $1`, [m.leaseId])
    expect((await nmiGet(m.leaseId, m.token)).body.data.words).toMatch(/^This tenancy was brought into GAM from before/)
  })

  // ── Fix pass 2: money that sits on the lease, or is on its way, is never closed as "nothing was paid" ──
  /** A never-paid, never-moved-in lease (the scheduler made it active) — the case the close is for — before anything below is added. */
  async function nothingPaid() {
    const m = await seedMoveOut({ deposit: 500 })
    await db.query(`UPDATE security_deposits SET collected_amount = 0, status = 'pending' WHERE lease_id = $1`, [m.leaseId])
    const b = await moveInBill(m, { started: true })
    expect((await nmiGet(m.leaseId, m.token)).body.data.applies).toBe(true)
    return { m, b }
  }
  /** Refused in these words on the confirm and on the close — and nothing changed. */
  async function refusedUnchanged(m: { leaseId: string; tenantId: string; token: string }, words: RegExp, total = 1500) {
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.lines).toEqual([])
    expect(shown.words).toMatch(words)
    const res = await nmiPost(m.leaseId, m.token, { expectedTotal: total })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(shown.words)
    expect(await owed(m.tenantId)).toBe(2)
    expect((await db.query(`SELECT status FROM leases WHERE id = $1`, [m.leaseId])).rows[0].status).toBe('active')
    return shown.words as string
  }

  it('money paid ahead sits on the lease (no line was settled): refused, naming it and the move-out — the credit stays', async () => {
    const { m } = await nothingPaid()
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at)
       VALUES ($1, $2, 300, 300, 'gam', NOW())`, [m.leaseId, m.tenantId])
    const words = await refusedUnchanged(m, /^\$300\.00 they paid ahead is on this lease, so it can’t be closed as if nothing happened\./)
    expect(words).toMatch(/Move out/)
    expect((await db.query(`SELECT amount_remaining::float AS r FROM lease_prepaid_credits WHERE lease_id = $1`, [m.leaseId])).rows[0].r).toBe(300)
  })

  it('money a landlord left as their credit, carried onto this new lease: refused — it is never closed away or offered again', async () => {
    const { m } = await nothingPaid()
    // What paid_ahead_carry_left leaves on the new lease: the tenant's money,
    // no longer marked as left by a choice (it now sits on this lease).
    const c = await db.connect()
    let ended: string
    try {
      const lease = (await c.query<{ unit_id: string; landlord_id: string }>(`SELECT unit_id, landlord_id FROM leases WHERE id = $1`, [m.leaseId])).rows[0]
      ended = await seedLease(c, { unitId: lease.unit_id, landlordId: lease.landlord_id, status: 'terminated' })
    } finally { c.release() }
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, received_lease_id, note)
       VALUES ($1, $2, 120, 120, 'gam', NOW() - interval '40 days', $3, 'Left as their credit')`, [m.leaseId, m.tenantId, ended!])
    await refusedUnchanged(m, /^\$120\.00 they paid ahead is on this lease/)
  })

  it('a funded deposit carried over from their last lease: refused, naming it — the deposit record is untouched', async () => {
    const { m } = await nothingPaid()
    const c = await db.connect()
    let prior: string
    try {
      const lease = (await c.query<{ unit_id: string }>(`SELECT unit_id FROM leases WHERE id = $1`, [m.leaseId])).rows[0]
      const priorLease = await seedLease(c, { unitId: lease.unit_id, landlordId: m.landlordId, status: 'terminated' })
      prior = await seedSecurityDeposit(c, { unitId: lease.unit_id, leaseId: priorLease, tenantId: m.tenantId, totalAmount: 500, status: 'disbursed' })
    } finally { c.release() }
    await db.query(`UPDATE security_deposits SET collected_amount = 500, status = 'funded', carried_from_deposit_id = $2 WHERE lease_id = $1`,
      [m.leaseId, prior!])
    await refusedUnchanged(m, /^\$500\.00 of security deposit carried over from their last lease is on this lease/)
    expect((await db.query(`SELECT collected_amount::float AS c FROM security_deposits WHERE lease_id = $1`, [m.leaseId])).rows[0].c).toBe(500)
  })

  it('a deposit paid on this lease’s own bill is said once — as paid — not again as a deposit on the lease', async () => {
    const { m, b } = await nothingPaid()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash' WHERE id = $1`, [b.deposit])
    await db.query(`UPDATE security_deposits SET collected_amount = 500, status = 'funded' WHERE lease_id = $1`, [m.leaseId])
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown.words).toMatch(/^\$500\.00 was already paid on this lease, so it can’t be closed/)
    expect(shown.words).not.toMatch(/security deposit/)
  })

  it('unspent account credit given on this lease: refused, naming it', async () => {
    const { m } = await nothingPaid()
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason)
       VALUES ($1, $2, $3, 25, 25, 'goodwill', 'Welcome')`, [m.landlordId, m.tenantId, m.leaseId])
    await refusedUnchanged(m, /^\$25\.00 of account credit is on this lease/)
  })

  it('the tenant reported paying at the bank and it is not matched yet: refused as on its way, nothing changed', async () => {
    const { m } = await nothingPaid()
    await db.query(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method)
       VALUES ($1, $2, $3, 1500, CURRENT_DATE - 1, 'cash')`, [m.tenantId, m.leaseId, m.landlordId])
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/^The tenant reported paying \$1,500\.00 at the bank on .+, and it hasn’t been matched yet/)
    expect((await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })).status).toBe(409)
    expect(await owed(m.tenantId)).toBe(2)
    expect((await db.query(`SELECT status FROM tenant_declared_deposits WHERE lease_id = $1`, [m.leaseId])).rows[0].status).toBe('pending')
  })

  it('credit already spent on an unpaid line (the line still owes the rest): said as credit used — money paid, not “on its way”', async () => {
    const { m, b } = await nothingPaid()
    const credit = (await db.query<{ id: string }>(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason)
       VALUES ($1, $2, $3, 40, 40, 'goodwill', 'Welcome') RETURNING id`, [m.landlordId, m.tenantId, m.leaseId])).rows[0].id
    await db.query(
      `INSERT INTO credit_uses (tenant_credit_id, payment_id, lease_id, amount, billing_month, source, status, applied_at)
       VALUES ($1, $2, $3, 40, date_trunc('month', CURRENT_DATE)::date, 'desk', 'applied', NOW())`, [credit, b.rent, m.leaseId])
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/^\$40\.00 of their credit was already used on its bills, so it can’t be closed as if nothing happened\./)
    expect(shown.words).not.toMatch(/on its way/)
  })

  it('a payment the bank sent back is never called “already paid”: it is said as sent back', async () => {
    const { m, b } = await nothingPaid()
    await db.query(`UPDATE payments SET status = 'returned', stripe_payment_intent_id = 'pi_returned_' || gen_random_uuid() WHERE id = $1`, [b.deposit])
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/^A \$500\.00 payment on this lease was sent back by their bank, so it can’t be closed/)
    expect(shown.words).not.toMatch(/already paid/)
  })

  // ── Fix pass 3 (review HIGH): a tried-and-failed payment is not money paid ──
  /**
   * A card or bank payment on the move-in bill, as rentCharge writes it when it
   * STARTS: one receipt with an application on each line, the lines carrying
   * the intent. Then the receipt and the lines are set to what became of it.
   */
  async function triedToPay(m: { leaseId: string; tenantId: string; landlordId: string }, b: { rent: string; deposit: string },
    o: { receipt: 'processing' | 'failed' | 'settled'; lines: 'processing' | 'failed' | 'settled'; method?: 'card' | 'ach'; retryInDays?: number }) {
    const pi = `pi_try_${randomUUID().slice(0, 8)}`
    const rem = (await db.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, status, payment_method, stripe_payment_intent_id, settled_at)
       VALUES ($1, $2, $3, 1500, 1500, $4, $5, $6, CASE WHEN $4 = 'settled' THEN NOW() END) RETURNING id`,
      [m.tenantId, m.leaseId, m.landlordId, o.receipt, o.method ?? 'card', pi])).rows[0].id
    for (const [id, amt] of [[b.rent, 1000], [b.deposit, 500]] as const) {
      await db.query(`INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied) VALUES ($1, $2, $3)`, [rem, id, amt])
    }
    await db.query(
      `UPDATE payments SET status = $2, stripe_payment_intent_id = $3,
              settled_at = CASE WHEN $2 = 'settled' THEN NOW() END,
              next_retry_at = CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() + make_interval(days => $4::int) END
        WHERE id = ANY($1::uuid[])`, [[b.rent, b.deposit], o.lines, pi, o.retryInDays ?? null])
    // Step 9 final fix (fix pass 1): a declined CARD attempt also gets GAM's
    // $1.00 declined-card fee on the same bill — written exactly as the Stripe
    // webhook writes it (routes/webhooks.ts, payment_intent.payment_failed):
    // pending, 'DECLINEFEE', revenue_owner 'gam', the intent in its note.
    if ((o.method ?? 'card') === 'card' && o.lines === 'failed') {
      await db.query(
        `INSERT INTO payments
           (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
            entry_description, due_date, invoice_id, notes, revenue_owner)
         SELECT p.unit_id, p.lease_id, p.tenant_id, p.landlord_id, 'fee', 1.00,
                'pending', 'DECLINEFEE', CURRENT_DATE, p.invoice_id, $2, 'gam'
           FROM payments p WHERE p.id = $1`, [b.rent, `Declined card attempt — ${pi}`])
    }
    return rem
  }
  /** GAM's declined-card fee line on the lease (the webhook's). */
  const declineFee = async (leaseId: string) => (await db.query(
    `SELECT id, status, amount::float AS amount, invoice_id, revenue_owner FROM payments
      WHERE lease_id = $1 AND entry_description = 'DECLINEFEE'`, [leaseId])).rows

  it('a card payment on the move-in bill was declined: the close zeroes the two lines with the plain note (never left at full amount for the reports to count as owed), and GAM’s $1 declined-card fee stays owed — said plainly in the confirm', async () => {
    const { m, b } = await nothingPaid()
    await triedToPay(m, b, { receipt: 'failed', lines: 'failed' })
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown).toMatchObject({ applies: true, words: null, total: 1500, kept_total: 1 })
    expect(shown.lines.map((l: any) => [l.label, l.amount])).toEqual([['Rent', 1000], ['Deposit', 500]])
    // GAM absorbs nothing: its own fee is never zeroed by the landlord's word.
    expect(shown.kept.map((k: any) => [k.label, k.amount, k.why])).toEqual([['Declined-payment fee', 1, 'gam_fee']])
    expect(shown.kept_words).toBe('Still owed after this: GAM’s own fee, Declined-payment fee ($1.00) — ending the lease never takes it off. It stays on the household’s balance.')
    const res = await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'terminated', zeroed_total: 1500 })
    // Fix pass 2 (review): a line a payment touched is zeroed with the plain
    // note, like any other — a 'voided' row keeps its amount and the reports'
    // Money billed (incomeBasis, round 4a) still reads it as owed.
    expect((await db.query(
      `SELECT status, amount::float AS amount, notes FROM payments
        WHERE id = ANY($1::uuid[]) ORDER BY type DESC`, [[b.rent, b.deposit]])).rows)
      .toEqual([
        { status: 'settled', amount: 0, notes: expect.stringMatching(/the tenant never paid the move-in bill or moved in/) },
        { status: 'settled', amount: 0, notes: expect.stringMatching(/the tenant never paid the move-in bill or moved in/) },
      ])
    // The fee is still owed, on its own (off the voided bill).
    expect(await declineFee(m.leaseId)).toEqual([expect.objectContaining({ status: 'pending', amount: 1, invoice_id: null, revenue_owner: 'gam' })])
    expect(await owed(m.tenantId)).toBe(1)
  })

  it('a payment on the move-in bill still clearing: said as still on its way — never “already paid” — and nothing changes', async () => {
    const { m, b } = await nothingPaid()
    await triedToPay(m, b, { receipt: 'processing', lines: 'processing' })
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/^A payment on this lease is still on its way, so it can’t be closed yet\. Try again once it clears or fails/)
    expect(shown.words).not.toMatch(/already paid/)
    expect((await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })).status).toBe(409)
    expect((await db.query(`SELECT status FROM leases WHERE id = $1`, [m.leaseId])).rows[0].status).toBe('active')
  })

  it('a bank pull set to be tried again that pays only this lease’s bill is stopped by the close — GAM never pulls for a tenancy that never happened', async () => {
    const { m, b } = await nothingPaid()
    await triedToPay(m, b, { receipt: 'processing', lines: 'failed', method: 'ach', retryInDays: 3 })
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown).toMatchObject({ applies: true, words: null, total: 1500 })
    expect((await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })).status).toBe(200)
    // The pull's schedule is gone (its intent is canceled after the commit), and the lines are zeroed.
    expect((await db.query(
      `SELECT status, amount::float AS amount, next_retry_at FROM payments WHERE id = ANY($1::uuid[]) ORDER BY id`, [[b.rent, b.deposit]])).rows)
      .toEqual([{ status: 'settled', amount: 0, next_retry_at: null }, { status: 'settled', amount: 0, next_retry_at: null }])
    expect(await owed(m.tenantId)).toBe(0)
  })

  it('a bank pull set to be tried again that also pays another bill the household owes is waited for (naming the retry day); after it fails for good the close applies', async () => {
    const { m, b } = await nothingPaid()
    const rem = await triedToPay(m, b, { receipt: 'processing', lines: 'failed', method: 'ach', retryInDays: 3 })
    // The same pull also carries a bill on another lease of the household's.
    const c = await db.connect()
    let other: string
    try {
      const lease = (await c.query<{ unit_id: string }>(`SELECT unit_id FROM leases WHERE id = $1`, [m.leaseId])).rows[0]
      other = await seedLease(c, { unitId: lease.unit_id, landlordId: m.landlordId, status: 'active' })
    } finally { c.release() }
    const pi = (await db.query(`SELECT stripe_payment_intent_id AS pi FROM payments WHERE id = $1`, [b.rent])).rows[0].pi
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, stripe_payment_intent_id, next_retry_at)
       SELECT unit_id, $2, tenant_id, landlord_id, 'utility', 40, 'failed', CURRENT_DATE, 'UTILITY', $3, NOW() + INTERVAL '3 days'
         FROM payments WHERE id = $1`, [b.rent, other!, pi])
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/^A bank payment on this lease didn’t go through and is set to be tried again on [A-Z][a-z]{2} \d{1,2}, \d{4}\. That try also pays other bills the household owes, so it can’t be stopped here and the lease can’t be closed yet\./)
    expect(shown.words).not.toMatch(/already paid/)
    expect((await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })).status).toBe(409)
    // The last try fails: no retry left, the receipt failed.
    await db.query(`UPDATE payments SET next_retry_at = NULL WHERE stripe_payment_intent_id = $1`, [pi])
    await db.query(`UPDATE tenant_remittances SET status = 'failed' WHERE id = $1`, [rem])
    expect((await nmiGet(m.leaseId, m.token)).body.data).toMatchObject({ applies: true, total: 1500 })
    expect((await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })).status).toBe(200)
  })

  it('a payment that went through on the move-in bill is still money paid: refused, naming it and the move-out', async () => {
    const { m, b } = await nothingPaid()
    await triedToPay(m, b, { receipt: 'settled', lines: 'settled' })
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/^\$1,500\.00 was already paid on this lease/)
    expect(shown.words).toMatch(/Move out/)
  })

  // ── Fix pass 3 (review medium): a lease drafted from a reservation ──
  it('a lease drafted from a reservation the Schedule still shows as coming: the confirm says the reservation is canceled with it, and the close cancels it in the same transaction — no confirmed reservation is left on an ended lease', async () => {
    const { m } = await nothingPaid()
    const lease = (await db.query<{ unit_id: string }>(`SELECT unit_id FROM leases WHERE id = $1`, [m.leaseId])).rows[0]
    const booking = (await db.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, tenant_id, guest_name, check_in, check_out, status, lease_type)
       VALUES ($1, $2, $3, 'Pat Guest', CURRENT_DATE - 10, CURRENT_DATE + 50, 'confirmed', 'month_to_month') RETURNING id`,
      [lease.unit_id, m.landlordId, m.tenantId])).rows[0].id
    await db.query(`UPDATE leases SET lease_source = 'booking_draft', source_booking_id = $2 WHERE id = $1`, [m.leaseId, booking])
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown).toMatchObject({ applies: true, total: 1500 })
    expect(shown.reservation_words).toMatch(/^The reservation it came from \(Pat Guest, checking in [A-Z][a-z]{2} \d{1,2}, \d{4}\) still shows on the Schedule as confirmed — it is canceled with the lease, so the space is free on the Schedule\.$/)
    // Never a step that does not exist (there is no no-show button on the Schedule).
    expect(JSON.stringify(shown)).not.toMatch(/no-show/)
    const res = await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'terminated', reservation_canceled: true })
    const b = (await db.query(`SELECT status, cancelled_at IS NOT NULL AS stamped FROM unit_bookings WHERE id = $1`, [booking])).rows[0]
    expect(b).toEqual({ status: 'cancelled', stamped: true })
    expect((await db.query(`SELECT event_type, summary FROM unit_booking_events WHERE booking_id = $1`, [booking])).rows)
      .toEqual([{ event_type: 'cancelled', summary: 'Reservation for Pat Guest canceled — they never moved in, and the lease drafted from it was ended' }])
    const left = (await db.query(
      `SELECT COUNT(*)::int AS n FROM unit_bookings b JOIN leases l ON l.source_booking_id = b.id
        WHERE l.status IN ('terminated', 'expired') AND b.status IN ('tentative', 'confirmed')`)).rows[0].n
    expect(left).toBe(0)
  })

  // ── Fix pass 3 (review low): the next step is one the lease actually shows ──
  it('a pending lease the landlord never signed, with money on it: names the landlord’s signature on the GoldSign page — never a start date gone by', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await db.query(`UPDATE security_deposits SET collected_amount = 0, status = 'pending' WHERE lease_id = $1`, [m.leaseId])
    await db.query(`UPDATE leases SET status = 'pending', lease_source = 'esigned', signed_by_landlord = FALSE,
                           start_date = CURRENT_DATE - 20 WHERE id = $1`, [m.leaseId])
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at)
       VALUES ($1, $2, 300, 300, 'gam', NOW())`, [m.leaseId, m.tenantId])
    const words = (await nmiGet(m.leaseId, m.token)).body.data.words as string
    expect(words).toMatch(/^\$300\.00 they paid ahead is on this lease, so it can’t be closed as if nothing happened\. The landlord hasn’t signed this lease, so it hasn’t started\. The landlord signs it on the GoldSign page; once it starts, use Change/)
    expect(words).not.toMatch(/When the lease starts/)
  })

  it('a pending lease the landlord signed that starts later: names its start day', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await db.query(`UPDATE security_deposits SET collected_amount = 0, status = 'pending' WHERE lease_id = $1`, [m.leaseId])
    await moveInBill(m)
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at)
       VALUES ($1, $2, 300, 300, 'gam', NOW())`, [m.leaseId, m.tenantId])
    expect((await nmiGet(m.leaseId, m.token)).body.data.words).toMatch(/ When the lease starts \([A-Z][a-z]{2} \d{1,2}, \d{4}\), use Change → “They’re leaving on…”/)
  })

  it('a leaving date already on file: the step names only Change → Move out (the menu shows “Leaving date — change or call off”, not “They’re leaving on…”)', async () => {
    const { m, b } = await nothingPaid()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash' WHERE id = $1`, [b.deposit])
    await db.query(`UPDATE leases SET move_out_notice_at = NOW() WHERE id = $1`, [m.leaseId])
    const words = (await nmiGet(m.leaseId, m.token)).body.data.words as string
    expect(words).toMatch(/Use Change → Move out on the Leases page — the move-out settles what they paid/)
    expect(words).not.toMatch(/They’re leaving on/)
  })

  it('a household’s new lease waiting after this one: the confirm shows the refusal (only Close), not a button every press of which fails', async () => {
    const { m } = await nothingPaid()
    const c = await db.connect()
    try {
      const lease = (await c.query<{ unit_id: string }>(`SELECT unit_id FROM leases WHERE id = $1`, [m.leaseId])).rows[0]
      const next = await seedLease(c, { unitId: lease.unit_id, landlordId: m.landlordId, status: 'pending' })
      await c.query(`UPDATE leases SET supersedes_lease_id = $2, lease_source = 'esigned', signed_by_landlord = TRUE,
                            start_date = CURRENT_DATE + 30 WHERE id = $1`, [next, m.leaseId])
    } finally { c.release() }
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/has a new lease starting .+ If they are leaving instead, cancel it first/)
    const res = await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(shown.words)
  })

  it('a team member who can end leases but not run a move-out is told to ask the landlord — never pointed at menu items they can’t see', async () => {
    const { m, b } = await nothingPaid()
    await db.query(`UPDATE payments SET status = 'settled', settled_at = NOW(), manual_method = 'cash' WHERE id = $1`, [b.deposit])
    const staff = await staffToken(m.landlordId, { 'leases.terminate': true }, { all: true })
    const words = (await nmiGet(m.leaseId, staff)).body.data.words
    expect(words).toMatch(/Ask the landlord to end it with a move-out/)
    expect(words).not.toMatch(/^Use Change/m)
    // Someone who can mark leaving and run the move-out is given the step itself.
    const full = await staffToken(m.landlordId, { 'leases.terminate': true, 'leases.edit': true, 'leases.deposit_return': true }, { all: true })
    expect((await nmiGet(m.leaseId, full)).body.data.words).toMatch(/ Use Change → “They’re leaving on…”/)
  })

  it('a lease ended this way voids its paperwork still waiting for signatures (never a home-sale document), so it can’t be signed later', async () => {
    const { m } = await nothingPaid()
    const doc = async (type: string, status: string) => (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (lease_id, landlord_id, title, status, document_type)
       VALUES ($1, $2, 'Doc', $3, $4) RETURNING id`, [m.leaseId, m.landlordId, status, type])).rows[0].id
    const lease = await doc('original_lease', 'in_progress')
    const addendum = await doc('addendum_terms', 'sent')
    const done = await doc('addendum_terms', 'completed')
    const sale = await doc('purchase_agreement', 'in_progress')
    expect((await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })).status).toBe(200)
    const st = async (id: string) => (await db.query(`SELECT status FROM lease_documents WHERE id = $1`, [id])).rows[0].status
    expect([await st(lease), await st(addendum), await st(done), await st(sale)]).toEqual(['voided', 'voided', 'completed', 'in_progress'])
  })

  // ── Step 9 final fix (fix pass 1) ──
  it('a charge billed on purpose (Charge an amount) is never zeroed: it stays owed, on its own, and the confirm says so (#46.4 — unpaid fees still go on the bill as usual)', async () => {
    const { m } = await nothingPaid()
    const charge = await request(buildApp()).post(`/api/leases/${m.leaseId}/charge`).set('Authorization', `Bearer ${m.token}`)
      .send({ amount: 75, description: 'Broken gate arm' })
    expect(charge.status).toBe(201)
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown).toMatchObject({ applies: true, total: 1500, kept_total: 75 })
    expect(shown.kept.map((k: any) => [k.label, k.amount, k.why])).toEqual([['Broken gate arm', 75, 'billed_charge']])
    expect(shown.kept_words).toBe('Still owed after this: the charge billed on purpose, Broken gate arm ($75.00). It stays on the household’s balance.')
    expect((await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })).status).toBe(200)
    expect((await db.query(`SELECT status, amount::float AS amount FROM payments WHERE id = $1`, [charge.body.data.paymentId])).rows[0])
      .toEqual({ status: 'pending', amount: 75 })
    expect(await owed(m.tenantId)).toBe(1)
  })

  it('a one-off charge still waiting on the lease for its next bill: refused, naming it and the step that exists (cancel it on the tenant’s page) — it is never lost with the lease', async () => {
    const { m } = await nothingPaid()
    const one = (await db.query<{ id: string }>(
      `INSERT INTO tenant_one_off_charges (landlord_id, tenant_id, lease_id, unit_id, charge_type, amount, reason, incident_date, status)
       VALUES ($1, $2, $3, $4, 'damage', 120, 'Broken window', CURRENT_DATE - 2, 'pending') RETURNING id`,
      [m.landlordId, m.tenantId, m.leaseId, m.unitId])).rows[0].id
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toMatch(/^You recorded a charge for this household that waits on this lease for its next bill: the \$120\.00 damage charge "Broken window" \(.+\)\. Ending the lease would leave it with no bill to go on, so it can’t be closed this way\. If it should not be billed, cancel it on the tenant’s page first, then try again\.$/)
    expect((await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })).status).toBe(409)
    expect(await owed(m.tenantId)).toBe(2)
    // Canceled on the tenant's page: the close goes through.
    await db.query(`UPDATE tenant_one_off_charges SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [one])
    expect((await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })).status).toBe(200)
  })

  it('a lease that already ended with its never-moved-in bill still owed (a reservation canceled before this fix): “They never moved in — zero the bill” is offered and zeroes it — never “Nothing else to do”; the lease keeps its status', async () => {
    const { m, b } = await nothingPaid()
    await db.query(`UPDATE leases SET status = 'terminated', terminated_at = NOW(), termination_reason = 'Reservation canceled' WHERE id = $1`, [m.leaseId])
    const list = await request(buildApp()).get('/api/leases').set('Authorization', `Bearer ${m.token}`)
    expect(list.body.data.find((l: any) => l.id === m.leaseId).ended_bill_open).toBe(true)
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown).toMatchObject({ applies: true, already_ended: true, total: 1500 })
    expect(JSON.stringify(shown)).not.toMatch(/Nothing else to do/)
    const res = await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'terminated', zeroed_total: 1500 })
    expect((await db.query(`SELECT status FROM invoices WHERE id = $1`, [b.inv])).rows[0].status).toBe('void')
    expect((await db.query(`SELECT termination_reason FROM leases WHERE id = $1`, [m.leaseId])).rows[0].termination_reason).toBe('Reservation canceled')
    expect(await owed(m.tenantId)).toBe(0)
    // Now nothing is left: said truthfully, and the list stops offering it.
    expect((await nmiGet(m.leaseId, m.token)).body.data.words).toBe('This lease has already ended and nothing on it is still owed. Nothing else to do.')
    const again = await request(buildApp()).get('/api/leases').set('Authorization', `Bearer ${m.token}`)
    expect(again.body.data.find((l: any) => l.id === m.leaseId).ended_bill_open).toBe(false)
  })

  it('a lease that ended with a move-out keeps what it owes, in words that say so', async () => {
    const { m } = await nothingPaid()
    await db.query(`UPDATE leases SET status = 'terminated' WHERE id = $1`, [m.leaseId])
    await db.query(
      `INSERT INTO deposit_returns (lease_id, landlord_id, tenant_id, total_deposit, total_deductions, status, finalized_at)
       VALUES ($1, $2, $3, 0, 0, 'sent_zero', NOW())`, [m.leaseId, m.landlordId, m.tenantId])
    const shown = (await nmiGet(m.leaseId, m.token)).body.data
    expect(shown.applies).toBe(false)
    expect(shown.words).toBe('This lease already ended with a move-out, so what it still owes stays owed — the move-out put it on their final bill.')
    expect((await nmiPost(m.leaseId, m.token, { expectedTotal: 1500 })).status).toBe(409)
    expect(await owed(m.tenantId)).toBe(2)
  })

  it('a pending lease brought in from before GAM: the refusal names the step that starts it, never the Change menu a pending lease does not have', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await moveInBill(m)
    await db.query(`UPDATE leases SET lease_source = 'imported', signed_by_landlord = FALSE WHERE id = $1`, [m.leaseId])
    const words = (await nmiGet(m.leaseId, m.token)).body.data.words as string
    expect(words).toMatch(/^This tenancy was brought into GAM from before, so the household already lives there and what it owes stays owed\. The landlord hasn’t signed this lease, so it hasn’t started\. The landlord signs it on the GoldSign page;/)
    expect(words).not.toMatch(/^To end it/m)
  })

  it('the confirm’s total is required, and a team member without "Terminate leases" is refused', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await moveInBill(m)
    expect((await nmiPost(m.leaseId, m.token, {})).status).toBe(400)
    const staff = await staffToken(m.landlordId, { 'leases.deposit_return': true }, { all: true })
    expect((await nmiGet(m.leaseId, staff)).status).toBe(403)
    expect((await nmiPost(m.leaseId, staff, { expectedTotal: 1500 })).status).toBe(403)
    expect(await owed(m.tenantId)).toBe(2)
  })
})

// Step 9 review (fix pass 3): the deposit-return routes move money, so a team
// member locked to some properties may work only on those properties' move-outs
// — the same gate the paid-ahead choice page uses.
describe('a team member locked to other properties cannot open, begin, edit or finalize this move-out', () => {
  const WORDS = 'You are not assigned to this property, so you can\'t work on its move-outs. ' +
    'Ask the landlord to add this property to your access.'
  const patchDraft = (leaseId: string, token: string) =>
    request(buildApp()).patch(`/api/leases/${leaseId}/deposit-return`).set('Authorization', `Bearer ${token}`).send({ notes: 'x' })

  it('locked to another property: 403 in plain words on GET, Begin, the damage lines and Finalize — nothing written', async () => {
    const m = await seedMoveOut({ deposit: 500, cleaning: 40 })
    const c = await db.connect()
    let otherProperty: string
    try { otherProperty = await seedProperty(c, { landlordId: m.landlordId, ownerUserId: m.userId, managedByUserId: m.userId }) }
    finally { c.release() }
    const staff = await staffToken(m.landlordId, { 'leases.deposit_return': true, 'pos.refund': true }, { propertyIds: [otherProperty!] })
    for (const res of [await get(m.leaseId, staff), await begin(m.leaseId, staff)]) {
      expect(res.status).toBe(403)
      expect(res.body.error).toBe(WORDS)
    }
    // The landlord begins it; the locked staffer still cannot edit or finalize it.
    expect((await begin(m.leaseId, m.token)).status).toBe(200)
    for (const res of [await patchDraft(m.leaseId, staff), await finalize(m.leaseId, staff, { expectedRefund: 460, expectedGap: 0 })]) {
      expect(res.status).toBe(403)
      expect(res.body.error).toBe(WORDS)
    }
    const row = await db.query<{ status: string; notes: string | null }>(`SELECT status, notes FROM deposit_returns WHERE lease_id = $1`, [m.leaseId])
    expect(row.rows[0]).toEqual({ status: 'draft', notes: null })
  })

  it('assigned to every property (or this one): the move-out opens, begins and finalizes as before', async () => {
    const m = await seedMoveOut({ deposit: 500, cleaning: 40 })
    const all = await staffToken(m.landlordId, { 'leases.deposit_return': true }, { all: true })
    expect((await get(m.leaseId, all)).status).toBe(200)
    expect((await begin(m.leaseId, all)).status).toBe(200)
    const here = await staffToken(m.landlordId, { 'leases.deposit_return': true }, { propertyIds: [m.propertyId] })
    expect((await patchDraft(m.leaseId, here)).status).toBe(200)
    expect((await finalize(m.leaseId, here, { expectedRefund: 460, expectedGap: 0 })).status).toBe(200)
  })
})

describe('finalize checks who refunds which part and the paid-ahead money used, not only the totals', () => {
  it('the holder changed after the page opened (same refund, different payer): 409 in plain words, nothing finalized', async () => {
    const m = await seedMoveOut({ deposit: 500, cleaning: 40, heldBy: 'gam_escrow' })
    await begin(m.leaseId, m.token)
    const shown = (await get(m.leaseId, m.token)).body.data
    expect(shown).toMatchObject({ refund_amount: 460, refund_from_gam: 460, refund_from_landlord: 0 })
    await db.query(`UPDATE security_deposits SET held_by = 'landlord' WHERE id = $1`, [m.depositId])
    const res = await finalize(m.leaseId, m.token, {
      expectedRefund: 460, expectedGap: 0, expectedRefundFromGam: 460, expectedRefundFromLandlord: 0, expectedPaidAheadUsed: 0,
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^The figures changed since you opened this/)
    expect((await db.query(`SELECT status FROM deposit_returns WHERE lease_id = $1`, [m.leaseId])).rows[0].status).toBe('draft')
    // The page reads the new split and finalizes on it.
    const fresh = (await get(m.leaseId, m.token)).body.data
    expect(fresh).toMatchObject({ refund_from_gam: 0, refund_from_landlord: 460 })
    expect((await finalize(m.leaseId, m.token, {
      expectedRefund: 460, expectedGap: 0, expectedRefundFromGam: 0, expectedRefundFromLandlord: 460, expectedPaidAheadUsed: 0,
    })).status).toBe(200)
  })

  it('the paid-ahead money used moved while refund and shortfall stayed $0 (a pet deposit settled): 409, nothing spent', async () => {
    const m = await seedMoveOut({ deposit: 500, cleaning: 650, paidAhead: 300 })
    await begin(m.leaseId, m.token)
    expect((await get(m.leaseId, m.token)).body.data).toMatchObject({ refund_amount: 0, gap_amount: 0, prepaid_credit_used: 150 })
    const c = await db.connect()
    try {
      const feeId = (await c.query<{ id: string }>(
        `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable, money_kind)
         VALUES ($1, 'pet_deposit', 100, 'move_in', TRUE, 'deposit') RETURNING id`, [m.leaseId])).rows[0].id
      await c.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                               lease_fee_id, settled_at, manual_method)
         VALUES ($1, $2, $3, $4, 'deposit', 100, 'settled', CURRENT_DATE, 'DEPOSIT', $5, NOW(), 'cash')`,
        [m.unitId, m.leaseId, m.tenantId, m.landlordId, feeId])
    } finally { c.release() }
    const res = await finalize(m.leaseId, m.token, { expectedRefund: 0, expectedGap: 0, expectedPaidAheadUsed: 150 })
    expect(res.status).toBe(409)
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM credit_uses WHERE source = 'move_out'`)).rows[0].n).toBe(0)
    expect((await get(m.leaseId, m.token)).body.data).toMatchObject({ refund_amount: 0, gap_amount: 0, prepaid_credit_used: 50, prepaid_credit_left: 250 })
  })
})

describe('#46.4 — a finalized return still says what it closed as no longer owed', () => {
  it('a never-paid pet deposit closed at finalize is listed on the finished record, with its amount', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    const c = await db.connect()
    try {
      const feeId = (await c.query<{ id: string }>(
        `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, is_refundable, money_kind, description)
         VALUES ($1, 'pet_deposit', 200, 'move_in', TRUE, 'deposit', 'Dog deposit') RETURNING id`, [m.leaseId])).rows[0].id
      await c.query(
        `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, lease_fee_id)
         VALUES ($1, $2, $3, $4, 'deposit', 200, 'pending', CURRENT_DATE - 40, 'DEPOSIT', $5)`,
        [m.unitId, m.leaseId, m.tenantId, m.landlordId, feeId])
    } finally { c.release() }
    await begin(m.leaseId, m.token)
    const shown = (await get(m.leaseId, m.token)).body.data
    expect(shown.closed_at_move_out_total).toBe(200)
    expect((await finalize(m.leaseId, m.token, { expectedRefund: shown.refund_amount, expectedGap: shown.gap_amount })).status).toBe(200)
    const done = (await get(m.leaseId, m.token)).body.data
    expect(done.finalized_at).toBeTruthy()
    expect(done.closed_at_move_out_total).toBe(200)
    expect(done.closed_at_move_out_lines).toEqual([
      expect.objectContaining({ kind: 'deposit', label: 'Dog deposit', amount: 200 }),
    ])
  })
})

// Step 9 (final fix, fix pass 1): what the page is told so it never offers a
// step that ends in an error, and says what was already decided.
describe('the deposit page after a paid-ahead choice, with its evidence, its approvals and who may act', () => {
  // The shared schema cleanup does not reach paid_ahead_choices (it points at
  // the lease), so this file clears its own.
  afterEach(async () => {
    await db.query(`UPDATE lease_prepaid_credits SET left_by_choice_id = NULL WHERE left_by_choice_id IS NOT NULL`)
    await db.query(`DELETE FROM paid_ahead_choices`)
  })
  const patchDraft = (leaseId: string, token: string, body: Record<string, unknown>) =>
    request(buildApp()).patch(`/api/leases/${leaseId}/deposit-return`).set('Authorization', `Bearer ${token}`).send(body)
  const sendBack = (leaseId: string, token: string) =>
    request(buildApp()).post(`/api/leases/${leaseId}/deposit-return/send-back`).set('Authorization', `Bearer ${token}`)

  it('after "Leave it as their credit": the finished return reports $0 paid ahead left to decide, and who left it as their credit and when', async () => {
    const m = await seedMoveOut({ deposit: 500, cleaning: 40, paidAhead: 300 })
    await begin(m.leaseId, m.token)
    expect((await finalize(m.leaseId, m.token, { expectedRefund: 460, expectedGap: 0 })).status).toBe(200)
    expect((await get(m.leaseId, m.token)).body.data).toMatchObject({ prepaid_credit_left: 300, paid_ahead_choice: null })
    const choice = (await db.query<{ id: string }>(
      `INSERT INTO paid_ahead_choices (lease_id, landlord_id, left_amount, refund_choice, refund_total, rest_choice, rest_amount,
                                       idempotency_key, decided_by)
       VALUES ($1, $2, 300, 'no_refund', 0, 'credit', 300, $3, $4) RETURNING id`,
      [m.leaseId, m.landlordId, randomUUID(), m.userId])).rows[0].id
    await db.query(`UPDATE lease_prepaid_credits SET left_by_choice_id = $2 WHERE lease_id = $1`, [m.leaseId, choice])
    const shown = (await get(m.leaseId, m.token)).body.data
    expect(shown.prepaid_credit_left).toBe(0)
    expect(shown.paid_ahead_choice).toMatchObject({ refund_choice: 'no_refund', rest_choice: 'credit', rest_amount: 300 })
    expect(shown.paid_ahead_choice.decided_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(shown.paid_ahead_choice.decided_by_name).toBeTruthy()
  })

  it('a choice made before the move-out began (no deposit held, nothing owed then): the move-out neither counts that money nor offers it again', async () => {
    const m = await seedMoveOut({ deposit: 500, cleaning: 650, paidAhead: 300 })
    const choice = (await db.query<{ id: string }>(
      `INSERT INTO paid_ahead_choices (lease_id, landlord_id, left_amount, refund_choice, refund_total, rest_choice, rest_amount,
                                       idempotency_key, decided_by)
       VALUES ($1, $2, 300, 'no_refund', 0, 'credit', 300, $3, $4) RETURNING id`,
      [m.leaseId, m.landlordId, randomUUID(), m.userId])).rows[0].id
    await db.query(`UPDATE lease_prepaid_credits SET left_by_choice_id = $2 WHERE lease_id = $1`, [m.leaseId, choice])
    const preview = (await get(m.leaseId, m.token)).body.data
    expect(preview).toMatchObject({ prepaid_credit_used: 0, prepaid_credit_left: 0, gap_amount: 150 })
    expect(preview.paid_ahead_choice).toMatchObject({ rest_choice: 'credit' })
  })

  it('each damage line’s photo or receipt comes back by its name (only this landlord’s documents)', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await begin(m.leaseId, m.token)
    const doc = (await db.query<{ id: string }>(
      `INSERT INTO documents (lease_id, landlord_id, type, name, url) VALUES ($1, $2, 'receipt', 'Damage evidence — carpet', '/x') RETURNING id`,
      [m.leaseId, m.landlordId])).rows[0].id
    expect((await patchDraft(m.leaseId, m.token, { damageLines: [{ description: 'Carpet', amount: 50, evidenceDocumentIds: [doc] }] })).status).toBe(200)
    expect((await get(m.leaseId, m.token)).body.data.damage_evidence).toEqual([{ id: doc, name: 'Damage evidence — carpet' }])
  })

  it('who may run the move-out: the landlord yes; a team member without "Deposit return" no (they can still read it)', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    expect((await get(m.leaseId, m.token)).body.data.viewer_can_run_move_out).toBe(true)
    const reader = await staffToken(m.landlordId, { 'leases.view': true }, { all: true })
    const res = await get(m.leaseId, reader)
    expect(res.status).toBe(200)
    expect(res.body.data.viewer_can_run_move_out).toBe(false)
  })

  it('a team member’s finalize that sends no figures is still held to the approval limit: parked (202), nothing paid, the landlord notified once', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await db.query(`UPDATE landlords SET deposit_return_approval_threshold = 300 WHERE id = $1`, [m.landlordId])
    const staff = await staffToken(m.landlordId, { 'leases.deposit_return': true }, { all: true })
    await begin(m.leaseId, staff)
    const res = await finalize(m.leaseId, staff)
    expect(res.status).toBe(202)
    expect(res.body.data).toMatchObject({ status: 'awaiting_approval', refund_amount: 500, threshold: 300 })
    expect((await db.query(`SELECT status, finalized_at FROM deposit_returns WHERE lease_id = $1`, [m.leaseId])).rows[0])
      .toEqual({ status: 'awaiting_approval', finalized_at: null })
    expect((await finalize(m.leaseId, staff)).status).toBe(202)
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'deposit_return_approval'`)).rows[0].n).toBe(1)
  })

  it('waiting for approval: the owner is told they can approve it or send it back to draft; Send back to draft reopens it for changes; a team member cannot send it back', async () => {
    const m = await seedMoveOut({ deposit: 500 })
    await db.query(`UPDATE landlords SET deposit_return_approval_threshold = 300 WHERE id = $1`, [m.landlordId])
    const staff = await staffToken(m.landlordId, { 'leases.deposit_return': true }, { all: true })
    await begin(m.leaseId, staff)
    expect((await finalize(m.leaseId, staff)).status).toBe(202)
    const ownerTry = await patchDraft(m.leaseId, m.token, { notes: 'x' })
    expect(ownerTry.status).toBe(409)
    expect(ownerTry.body.error).toMatch(/waiting for your approval/)
    expect(ownerTry.body.error).toMatch(/Send back to draft/)
    const staffTry = await patchDraft(m.leaseId, staff, { notes: 'x' })
    expect(staffTry.body.error).toMatch(/waiting for the landlord's approval/)
    expect((await sendBack(m.leaseId, staff)).status).toBe(403)
    const back = await sendBack(m.leaseId, m.token)
    expect(back.status).toBe(200)
    expect(back.body.data.status).toBe('draft')
    expect((await patchDraft(m.leaseId, m.token, { notes: 'changed' })).status).toBe(200)
    const again = await sendBack(m.leaseId, m.token)
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/already a draft/)
  })
})

describe('decisions #48.6 (fix pass 2): a payment stuck past a week is told to GAM by the page’s read', () => {
  it('GET alone says GAM has been told and creates the deposit_payment_stuck_at_move_out notice once — a second read adds none', async () => {
    const f = await seedMoveOut({ deposit: 500 })
    const { STUCK_DEPOSIT_PAYMENT_MESSAGE } = await import('../services/depositReturn')
    const pay = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             stripe_payment_intent_id, created_at)
       VALUES ($1,$2,$3,$4,'rent',450,'processing',CURRENT_DATE - 10,'RENT','pi_stuck_get', NOW() - INTERVAL '9 days') RETURNING id`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId])).rows[0].id
    const read = () => request(buildApp()).get(`/api/leases/${f.leaseId}/deposit-return`).set('Authorization', `Bearer ${f.token}`)
    const first = await read()
    expect(first.status).toBe(200)
    expect(first.body.data.payments_clearing).toBe(STUCK_DEPOSIT_PAYMENT_MESSAGE)
    await read()
    const notes = (await db.query(
      `SELECT context FROM admin_notifications WHERE category = 'deposit_payment_stuck_at_move_out'`)).rows
    expect(notes).toHaveLength(1)
    expect(notes[0].context.payment_id).toBe(pay)
    expect(notes[0].context.lease_id).toBe(f.leaseId)
  })

  it('a payment still clearing inside its time: the read names the day it should clear and tells GAM nothing', async () => {
    const f = await seedMoveOut({ deposit: 500 })
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                             stripe_payment_intent_id, created_at)
       VALUES ($1,$2,$3,$4,'rent',450,'processing',CURRENT_DATE,'RENT','pi_fresh_get', NOW())`,
      [f.unitId, f.leaseId, f.tenantId, f.landlordId])
    const res = await request(buildApp()).get(`/api/leases/${f.leaseId}/deposit-return`).set('Authorization', `Bearer ${f.token}`)
    expect(res.body.data.payments_clearing).toMatch(/is still clearing, so the move-out can’t be finalized yet\. It should clear by [A-Z][a-z]{2} \d{1,2}, \d{4}\. Finalize once it clears or fails\.$/)
    expect((await db.query(
      `SELECT COUNT(*)::int AS n FROM admin_notifications WHERE category = 'deposit_payment_stuck_at_move_out'`)).rows[0].n).toBe(0)
  })
})
