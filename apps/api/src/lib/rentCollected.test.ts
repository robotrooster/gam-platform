/**
 * S642 — the admin overview and the landlord dashboard disagreed by $460.
 *
 * Nic: "There is a four hundred and sixty dollar discrepancy there. That's one
 * mobile home… Collected this month needs to show any in-flight stuff. Those
 * two cards need to match up."
 *
 * Admin counted settled + ACH-still-clearing; the landlord dashboard and the
 * Reports page counted settled only. The gap was a single real ACH payment
 * mid-flight, whose tenant's bank had already been debited.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { collectedRentMtd, RENT_RECEIVED_STATUSES } from './rentCollected'
import { STAY_DEPOSIT_CREDIT_NOTE } from '../jobs/moveInBundle'

beforeEach(async () => { await cleanupAllSchema() })

async function seedRent(rows: Array<{ status: string; amount: number; type?: string; monthsAgo?: number }>) {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { landlordId, userId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ('rc-' || gen_random_uuid() || '@t.dev','x','tenant','R','C') RETURNING id`)
    const t = await c.query<{ id: string }>(
      `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [u.rows[0].id])
    for (const [i, r] of rows.entries()) {
      const when = `NOW() - INTERVAL '${r.monthsAgo ?? 0} months'`
      // ux_payments_unit_rent_due_date_active allows ONE active rent charge per
      // unit per due date — the guard against double-billing a month. Each
      // seeded row therefore gets its own due date; the figure under test keys
      // off settled_at/created_at, so this changes nothing it measures.
      await c.query(
        `INSERT INTO payments (tenant_id, landlord_id, unit_id, type, amount, status,
                               entry_description, due_date, settled_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'RENT',
                 (date_trunc('month', ${when})::date + $7::int),
                 CASE WHEN $6 = 'processing' THEN NULL ELSE ${when} END, ${when})`,
        [t.rows[0].id, landlordId, unitId, r.type ?? 'rent', r.amount, r.status, i])
    }
    await c.query('COMMIT')
    return { landlordId, propertyId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('collectedRentMtd — one definition for every screen', () => {
  // S655 (money plan §2): "Still clearing (ACH or card processing): shown
  // beside the total, not inside it." The $460 nobody could see is now its own
  // figure on the card ("+ $460 still clearing"), never summed into what
  // arrived.
  it('clearing is its own figure', async () => {
    const { landlordId } = await seedRent([
      { status: 'settled', amount: 17460 },
      { status: 'processing', amount: 460 },
    ])
    const r = await collectedRentMtd([landlordId])
    expect(r.collected).toBe(17460)
    expect(r.inFlight).toBe(460)
    // Money billed: the clearing part is inside this month's bills.
    expect(r.billed.clearing).toBe(460)
  })

  it('a FlexPay pull is not collected rent', async () => {
    const { landlordId } = await seedRent([
      { status: 'settled', amount: 700 },
    ])
    await db.query(
      `INSERT INTO payments (tenant_id, landlord_id, unit_id, type, amount, status, entry_description, due_date, settled_at, revenue_owner)
       SELECT tenant_id, landlord_id, unit_id, 'fee', 725, 'settled', 'FLEXPAY', due_date + 9, NOW(), 'gam'
         FROM payments WHERE landlord_id = $1 LIMIT 1`, [landlordId])
    await db.query(
      `INSERT INTO payments (tenant_id, landlord_id, unit_id, type, amount, status, entry_description, due_date, settled_at)
       SELECT tenant_id, landlord_id, unit_id, 'rent', 725, 'settled', 'FLEXPAY', due_date + 10, NOW()
         FROM payments WHERE landlord_id = $1 AND entry_description = 'RENT' LIMIT 1`, [landlordId])
    const r = await collectedRentMtd([landlordId])
    expect(r.collected).toBe(700)
    const all = await collectedRentMtd([landlordId], null, { scope: 'all' })
    expect(all.collected).toBe(700)
  })

  it('the landlord-scoped figure equals the platform-wide one when there is one landlord', async () => {
    // Exactly Nic's situation today, and the reason the mismatch was visible.
    const { landlordId } = await seedRent([
      { status: 'settled', amount: 1000 },
      { status: 'processing', amount: 250 },
    ])
    const scoped = await collectedRentMtd([landlordId])
    const platform = await collectedRentMtd(null)
    expect(scoped.collected).toBe(platform.collected)
    expect(scoped.inFlight).toBe(platform.inFlight)
  })

  it('a pending charge is NOT collected — nobody has sent anything', async () => {
    const { landlordId } = await seedRent([
      { status: 'settled', amount: 500 },
      { status: 'pending', amount: 900 },
    ])
    const r = await collectedRentMtd([landlordId])
    expect(r.collected).toBe(500)
    expect(r.inFlight).toBe(0)
  })

  it('ignores last month, including last month’s in-flight', async () => {
    const { landlordId } = await seedRent([
      { status: 'settled', amount: 300 },
      { status: 'settled', amount: 999, monthsAgo: 1 },
    ])
    const r = await collectedRentMtd([landlordId])
    expect(r.collected).toBe(300)
  })

  it('is rent only — utilities and fees belong to the heartbeat, not this card', async () => {
    const { landlordId } = await seedRent([
      { status: 'settled', amount: 400 },
      { status: 'settled', amount: 25, type: 'utility' },
      { status: 'settled', amount: 10, type: 'late_fee' },
    ])
    const r = await collectedRentMtd([landlordId])
    expect(r.collected).toBe(400)
  })

  it('filters to one property when the dashboard is scoped', async () => {
    const { landlordId, propertyId } = await seedRent([{ status: 'settled', amount: 750 }])
    expect((await collectedRentMtd([landlordId], propertyId)).collected).toBe(750)
    expect((await collectedRentMtd([landlordId], randomUUID())).collected).toBe(0)
  })

  it('a list of properties scopes the card to a team member’s properties; an empty list sees nothing', async () => {
    const { landlordId, propertyId } = await seedRent([{ status: 'settled', amount: 750 }])
    expect((await collectedRentMtd([landlordId], [propertyId, randomUUID()])).collected).toBe(750)
    expect((await collectedRentMtd([landlordId], [randomUUID()])).collected).toBe(0)
    expect((await collectedRentMtd([landlordId], [])).collected).toBe(0)
  })

  it('the status list is the one the admin overview uses', async () => {
    expect([...RENT_RECEIVED_STATUSES].sort())
      .toEqual(['paid_via_deposit', 'processing', 'settled'])
  })

  it('includes money paid ahead this month, and says how much of it there is', async () => {
    const { landlordId } = await seedRent([{ status: 'settled', amount: 460 }])
    const c = await getClient()
    try {
      const u = await c.query<{ id: string; unit_id: string; tenant_id: string }>(
        `SELECT id, unit_id, tenant_id FROM payments WHERE landlord_id = $1 LIMIT 1`, [landlordId])
      const lease = await c.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date)
         VALUES ($1,$2,460,'month_to_month','active','2026-01-01') RETURNING id`, [u.rows[0].unit_id, landlordId])
      await c.query(
        `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, created_at)
         VALUES ($1,$2,460,460,'landlord',now(),now())`, [lease.rows[0].id, u.rows[0].tenant_id])
    } finally { c.release() }
    const r = await collectedRentMtd([landlordId])
    expect(r.collected).toBe(920)
    expect(r.paidAhead).toBe(460)
    // Money billed: the paid-ahead money is not a bill.
    expect(r.billed.amount).toBe(460)
  })
})

// S655 fix round 2: the rent card agrees with the P&L about money that comes
// back off — a move-out whose shortfall is larger than its deductions, and the
// clawback of paid-ahead money whose charge was disputed.
describe('collectedRentMtd — what comes back off the rent card', () => {
  async function world() {
    const c = await getClient()
    try {
      const { landlordId, userId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 460 })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, { unitId, landlordId, rentAmount: 460 })
      await seedLeaseTenant(c, { leaseId, tenantId })
      return { landlordId, unitId, tenantId, leaseId }
    } finally { c.release() }
  }
  type Wd = Awaited<ReturnType<typeof world>>
  async function row(w: Wd, o: {
    type?: string; amount: number; due: string; status: string; settledAt?: string; stripe?: string; leaseId?: string
  }) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description,
                             due_date, settled_at, stripe_charge_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::timestamptz,$11) RETURNING id`,
      [w.unitId, o.leaseId ?? w.leaseId, w.tenantId, w.landlordId, o.type ?? 'rent', o.amount, o.status,
       o.type === 'utility' ? 'UTILITY' : o.type === 'fee' ? 'DEPOSIT' : 'RENT', o.due, o.settledAt ?? null, o.stripe ?? null])
    return r.rows[0].id
  }
  async function moveOut(w: Wd, o: { deposit: number; cleaning: number; swept: number; gap: number; at: string; leaseId?: string }) {
    const leaseId = o.leaseId ?? w.leaseId
    const gapRow = await row(w, { type: 'fee', amount: o.gap, due: o.at.slice(0, 10), status: 'pending', leaseId })
    await db.query(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines,
                                    other_deductions, unpaid_balance_amount, total_deductions, gap_amount, gap_payment_id,
                                    status, finalized_at)
       VALUES ($1,$2,$3,$4,$5,'[]','[]',$6,$7,$8,$9,'sent_gap',$10)`,
      [leaseId, w.tenantId, w.landlordId, o.deposit, o.cleaning, o.swept, o.swept + o.cleaning, o.gap, gapRow, o.at])
  }
  /** The household's renewal: a landlord-signed new lease that supersedes the world's lease. */
  async function renewal(w: Wd): Promise<string> {
    const c = await getClient()
    try {
      const next = await seedLease(c, { unitId: w.unitId, landlordId: w.landlordId, rentAmount: 460 })
      await seedLeaseTenant(c, { leaseId: next, tenantId: w.tenantId })
      await c.query(`UPDATE leases SET status = 'expired' WHERE id = $1`, [w.leaseId])
      await c.query(`UPDATE leases SET supersedes_lease_id = $2 WHERE id = $1`, [next, w.leaseId])
      return next
    } finally { c.release() }
  }
  const card = async (w: Wd, month: string) => ({
    rent: await collectedRentMtd([w.landlordId], null, { month }),
    all: await collectedRentMtd([w.landlordId], null, { month, scope: 'all' }),
  })

  it('a move-out gap from unpaid rent: the rent card equals what the deposit pool kept', async () => {
    const w = await world()
    const fin = '2026-10-15T10:00:00-07:00'
    // $700 of rent never paid, swept to a $400 deposit; $100 of cleaning; the gap is $400.
    for (const [due, amt] of [['2026-08-01', 200], ['2026-09-01', 250], ['2026-10-01', 250]] as const) {
      await row(w, { amount: amt, due, status: 'paid_via_deposit', settledAt: fin })
    }
    await moveOut(w, { deposit: 400, cleaning: 100, swept: 700, gap: 400, at: fin })
    const oct = await card(w, '2026-10-01')
    expect(oct.all.collected).toBe(400)      // the P&L and the income card
    expect(oct.rent.collected).toBe(400)     // was 700: the pool only ever held $400
  })

  it('a move-out that swept rent and a utility takes only the rent’s share of the shortfall off the rent card', async () => {
    const w = await world()
    const fin = '2026-10-15T10:00:00-07:00'
    await row(w, { amount: 700, due: '2026-10-01', status: 'paid_via_deposit', settledAt: fin })
    await row(w, { type: 'utility', amount: 300, due: '2026-10-01', status: 'paid_via_deposit', settledAt: fin })
    // $1,000 swept + $100 cleaning against a $400 pool: the gap is $700, $600 past the cleaning.
    await moveOut(w, { deposit: 400, cleaning: 100, swept: 1000, gap: 700, at: fin })
    const oct = await card(w, '2026-10-01')
    expect(oct.all.collected).toBe(400)
    // Rent was 700 of the 1,000 swept, so it takes 70% of the −600: 700 − 420.
    expect(oct.rent.collected).toBe(280)
    // Money billed says the same: of the $700 rent bill, $280 was kept and $420 is still owed.
    expect(oct.rent.billed).toEqual({ amount: 700, collected: 280, clearing: 0, stillOwed: 420 })
    expect(oct.all.billed).toEqual({ amount: 1100, collected: 400, clearing: 0, stillOwed: 700 })
  })

  it("Money billed: a move-out gap from unpaid rent — the rent card's collected so far equals what the pool kept, and the rest is still owed", async () => {
    const w = await world()
    const fin = '2026-10-15T10:00:00-07:00'
    // $700 of October rent swept to a $400 deposit; $100 of cleaning; the gap is $400.
    await row(w, { amount: 700, due: '2026-10-01', status: 'paid_via_deposit', settledAt: fin })
    await moveOut(w, { deposit: 400, cleaning: 100, swept: 700, gap: 400, at: fin })
    const oct = await card(w, '2026-10-01')
    // The shortfall goes to the cleaning first ($100 still owed), the rest to the rent ($300).
    expect(oct.rent.billed).toEqual({ amount: 700, collected: 400, clearing: 0, stillOwed: 300 })
    expect(oct.all.billed).toEqual({ amount: 800, collected: 400, clearing: 0, stillOwed: 400 })
    // All that was swept was rent, so the two cards agree on what was collected.
    expect(oct.rent.billed.collected).toBe(oct.all.billed.collected)
    expect(oct.rent.collected).toBe(oct.all.collected)
  })

  it('after the tenant pays the gap, the Money received rent card equals the Money billed rent collected (700)', async () => {
    const w = await world()
    const fin = '2026-10-15T10:00:00-07:00'
    // $700 of October rent swept to a $400 deposit; $100 of cleaning; the $400 gap is paid on Oct 20.
    await row(w, { amount: 700, due: '2026-10-01', status: 'paid_via_deposit', settledAt: fin })
    await moveOut(w, { deposit: 400, cleaning: 100, swept: 700, gap: 400, at: fin })
    const gap = (await db.query<{ gap_payment_id: string }>(
      `SELECT gap_payment_id FROM deposit_returns WHERE landlord_id = $1`, [w.landlordId])).rows[0].gap_payment_id
    await db.query(`UPDATE payments SET status = 'settled', settled_at = '2026-10-20T10:00:00-07:00' WHERE id = $1`, [gap])
    const oct = await card(w, '2026-10-01')
    expect(oct.rent.billed).toEqual({ amount: 700, collected: 700, clearing: 0, stillOwed: 0 })
    expect(oct.rent.collected).toBe(700)          // was 400: the rent's $300 of the gap sat on an uncategorized line
    expect(oct.rent.collected).toBe(oct.rent.billed.collected)
    // The income card: $400 kept + $400 of the gap paid, both ways.
    expect(oct.all.collected).toBe(800)
    expect(oct.all.billed).toEqual({ amount: 800, collected: 800, clearing: 0, stillOwed: 0 })
  })

  it('a move-out that swept rent and a utility: when the gap is paid, the rent card collects only the rent’s share of it', async () => {
    const w = await world()
    const fin = '2026-10-15T10:00:00-07:00'
    await row(w, { amount: 700, due: '2026-10-01', status: 'paid_via_deposit', settledAt: fin })
    await row(w, { type: 'utility', amount: 300, due: '2026-10-01', status: 'paid_via_deposit', settledAt: fin })
    await moveOut(w, { deposit: 400, cleaning: 100, swept: 1000, gap: 700, at: fin })
    const gap = (await db.query<{ gap_payment_id: string }>(
      `SELECT gap_payment_id FROM deposit_returns WHERE landlord_id = $1`, [w.landlordId])).rows[0].gap_payment_id
    await db.query(`UPDATE payments SET status = 'settled', settled_at = '2026-10-20T10:00:00-07:00' WHERE id = $1`, [gap])
    const oct = await card(w, '2026-10-01')
    // Rent: $280 kept at move-out + its $420 of the gap.
    expect(oct.rent.collected).toBe(700)
    expect(oct.rent.billed).toEqual({ amount: 700, collected: 700, clearing: 0, stillOwed: 0 })
    expect(oct.all.collected).toBe(1100)
    expect(oct.all.billed).toEqual({ amount: 1100, collected: 1100, clearing: 0, stillOwed: 0 })
  })

  it('a paid gap later disputed: only the rent’s share comes off the rent card on the dispute day', async () => {
    const w = await world()
    const fin = '2026-10-15T10:00:00-07:00'
    await row(w, { amount: 700, due: '2026-10-01', status: 'paid_via_deposit', settledAt: fin })
    await moveOut(w, { deposit: 400, cleaning: 100, swept: 700, gap: 400, at: fin })
    const gap = (await db.query<{ gap_payment_id: string }>(
      `SELECT gap_payment_id FROM deposit_returns WHERE landlord_id = $1`, [w.landlordId])).rows[0].gap_payment_id
    await db.query(`UPDATE payments SET status = 'settled', settled_at = '2026-10-20T10:00:00-07:00', stripe_charge_id = 'ch_gap'
                     WHERE id = $1`, [gap])
    const rev = (await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                      stripe_event_id, raw_event, created_at)
       VALUES ($1,$2,$3,$4,'card_dispute',400,'evt_gap','{}','2026-11-05T10:00:00-07:00') RETURNING id`,
      [gap, w.landlordId, w.tenantId, w.leaseId])).rows[0].id
    await db.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [gap])
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, reversal_id)
       VALUES ($1,$2,$3,$4,'fee',400,'pending','DEPOSIT','2026-10-15',$5)`,
      [w.unitId, w.leaseId, w.tenantId, w.landlordId, rev])
    const oct = await card(w, '2026-10-01')
    expect(oct.rent.collected).toBe(700)          // October stays as it was
    const nov = await card(w, '2026-11-01')
    expect(nov.all.collected).toBe(-400)
    expect(nov.rent.collected).toBe(-300)         // the cleaning's $100 is not rent
  })

  it('a shortfall payment still clearing: the rent card shows the rent’s share as still clearing under both bases', async () => {
    const w = await world()
    const fin = '2026-10-15T10:00:00-07:00'
    // $300 of rent swept to a $200 deposit; the $100 gap is paid by bank and still clearing.
    await row(w, { amount: 300, due: '2026-10-01', status: 'paid_via_deposit', settledAt: fin })
    await moveOut(w, { deposit: 200, cleaning: 0, swept: 300, gap: 100, at: fin })
    await db.query(
      `UPDATE payments SET status = 'processing', stripe_payment_intent_id = 'pi_gap', processed_at = '2026-10-20T10:00:00-07:00'
        WHERE id = (SELECT gap_payment_id FROM deposit_returns WHERE landlord_id = $1)`, [w.landlordId])
    const oct = await card(w, '2026-10-01')
    expect(oct.rent.collected).toBe(200)
    expect(oct.rent.inFlight).toBe(100)           // was 0: the dashboard read "+ $0 still clearing"
    expect(oct.rent.billed).toEqual({ amount: 300, collected: 200, clearing: 100, stillOwed: 0 })
    expect(oct.rent.inFlight).toBe(oct.rent.billed.clearing)
    expect(oct.all.inFlight).toBe(oct.all.billed.clearing)
  })

  it('three equal swept rent bills and a partly disputed gap: both bases agree to the cent', async () => {
    const w = await world()
    const fin = '2026-10-15T10:00:00-07:00'
    // Three $100 rent bills swept to a $200 deposit: the $100 gap is all theirs,
    // a third each (33.34 / 33.33 / 33.33).
    for (const due of ['2026-10-01', '2026-10-02', '2026-10-03']) {
      await row(w, { amount: 100, due, status: 'paid_via_deposit', settledAt: fin })
    }
    await moveOut(w, { deposit: 200, cleaning: 0, swept: 300, gap: 100, at: fin })
    const gap = (await db.query<{ gap_payment_id: string }>(
      `SELECT gap_payment_id FROM deposit_returns WHERE landlord_id = $1`, [w.landlordId])).rows[0].gap_payment_id
    // Oct 20: the gap is paid in full; Oct 25: $50 of it is disputed — the gap
    // row goes 'returned' and a fresh $50 row is reopened.
    await db.query(`UPDATE payments SET status = 'settled', settled_at = '2026-10-20T10:00:00-07:00', stripe_charge_id = 'ch_gap'
                     WHERE id = $1`, [gap])
    const rev = (await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                      stripe_event_id, raw_event, created_at)
       VALUES ($1,$2,$3,$4,'card_dispute',50,'evt_gap50','{}','2026-10-25T10:00:00-07:00') RETURNING id`,
      [gap, w.landlordId, w.tenantId, w.leaseId])).rows[0].id
    await db.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [gap])
    const reopened = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, entry_description, due_date, reversal_id)
       VALUES ($1,$2,$3,$4,'fee',50,'pending','DEPOSIT','2026-10-15',$5) RETURNING id`,
      [w.unitId, w.leaseId, w.tenantId, w.landlordId, rev])).rows[0].id

    const oct = await card(w, '2026-10-01')
    // Each bill: its share paid less its share disputed, rounded row by row on both sides
    // (33.34 − 16.67, 33.33 − 16.67, 33.33 − 16.67): $200 kept + $49.99.
    expect(oct.rent.collected).toBe(249.99)
    expect(oct.rent.billed).toEqual({ amount: 300, collected: 249.99, clearing: 0, stillOwed: 50.01 })
    expect(oct.rent.collected).toBe(oct.rent.billed.collected)    // was 249.99 vs 250.01
    // The cent the rounding leaves sits on the shortfall's uncategorized part, the same way under both.
    expect(oct.all.collected).toBe(250)
    expect(oct.all.billed).toEqual({ amount: 300, collected: 250, clearing: 0, stillOwed: 50 })

    // Oct 28: the reopened $50 is paid in cash. Every bill is whole again, both ways.
    await db.query(`UPDATE payments SET status = 'settled', settled_at = '2026-10-28T10:00:00-07:00', manual_method = 'cash'
                     WHERE id = $1`, [reopened])
    const paid = await card(w, '2026-10-01')
    expect(paid.rent.collected).toBe(300)
    expect(paid.rent.billed).toEqual({ amount: 300, collected: 300, clearing: 0, stillOwed: 0 })
    expect(paid.all.collected).toBe(300)
    expect(paid.all.billed).toEqual({ amount: 300, collected: 300, clearing: 0, stillOwed: 0 })
  })

  it('a renewal-chain move-out (swept rent on the previous lease): the rent card equals what the deposit pool kept', async () => {
    const w = await world()
    const next = await renewal(w)
    const fin = '2026-10-15T10:00:00-07:00'
    // The rent went unpaid on the previous lease; the deposit and the move-out sit on the new one.
    await row(w, { amount: 700, due: '2026-10-01', status: 'paid_via_deposit', settledAt: fin })
    await moveOut(w, { deposit: 400, cleaning: 100, swept: 700, gap: 400, at: fin, leaseId: next })
    const oct = await card(w, '2026-10-01')
    expect(oct.all.collected).toBe(400)
    expect(oct.rent.collected).toBe(400)     // was 700: matched by lease id, the shortfall never found the rent
    expect(oct.rent.billed).toEqual({ amount: 700, collected: 400, clearing: 0, stillOwed: 300 })
    expect(oct.all.billed).toEqual({ amount: 800, collected: 400, clearing: 0, stillOwed: 400 })
  })

  it('a disputed pay-ahead comes off the rent card on the dispute day', async () => {
    const w = await world()
    // Oct 3: one $660 card charge — October's $460 rent and $200 paid ahead (GAM holds it).
    const oct = await row(w, { amount: 460, due: '2026-10-01', status: 'settled', settledAt: '2026-10-03T10:00:00-07:00', stripe: 'ch_660' })
    const credit = (await db.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by, received_at, created_at)
       VALUES ($1,$2,200,200,'gam','2026-10-03T10:00:00-07:00','2026-10-03T10:00:00-07:00') RETURNING id`,
      [w.leaseId, w.tenantId])).rows[0].id
    // Nov 20: the charge is disputed — the rent row loses its money, and the clawback drains the $200.
    const at = '2026-11-20T10:00:00-07:00'
    const rev = (await db.query<{ id: string }>(
      `INSERT INTO payment_reversals (payment_id, landlord_id, tenant_id, lease_id, reversal_type, reversed_amount,
                                      stripe_event_id, raw_event, created_at)
       VALUES ($1,$2,$3,$4,'card_dispute',460,'evt_660','{}',$5) RETURNING id`,
      [oct, w.landlordId, w.tenantId, w.leaseId, at])).rows[0].id
    await db.query(`UPDATE payments SET status = 'returned' WHERE id = $1`, [oct])
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, payment_reversal_id, lease_id, amount, billing_month, source, status, held_at, applied_at)
       VALUES ($1,$2,$3,200,'2026-11-01','reversal','applied',$4::timestamptz,$4::timestamptz)`,
      [credit, rev, w.leaseId, at])

    const octCard = await card(w, '2026-10-01')
    expect(octCard.rent.collected).toBe(660)
    expect(octCard.rent.paidAhead).toBe(200)
    const nov = await card(w, '2026-11-01')
    expect(nov.all.collected).toBe(-660)
    expect(nov.rent.collected).toBe(-660)    // was −460: the $200 counted in October, so it comes off in November
  })
  it('a reservation deposit’s leftover handed back through a move-out leaves the rent card at $0: it counted as a stay, never as rent', async () => {
    const w = await world()
    // $58.06 of a reservation deposit was left over after the arrival rent and never used.
    const leftover = (await db.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, funded_by,
                                          received_at, created_at, note)
       VALUES ($1,$2,58.06,58.06,'reclassified','2026-07-02T10:00:00-07:00','2026-07-10T10:00:00-07:00',$3) RETURNING id`,
      [w.leaseId, w.tenantId, STAY_DEPOSIT_CREDIT_NOTE])).rows[0].id
    // Aug 20: move-out with $100 of cleaning; the pool ($400 + the $58.06) keeps $100 and refunds the rest.
    const fin = '2026-08-20T10:00:00-07:00'
    const dr = (await db.query<{ id: string }>(
      `INSERT INTO deposit_returns (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount, damage_lines,
                                    other_deductions, unpaid_balance_amount, total_deductions, gap_amount, status, finalized_at)
       VALUES ($1,$2,$3,400,100,'[]','[]',0,100,0,'sent_refund',$4) RETURNING id`,
      [w.leaseId, w.tenantId, w.landlordId, fin])).rows[0].id
    await db.query(
      `INSERT INTO credit_uses (prepaid_credit_id, deposit_return_id, lease_id, amount, billing_month, source, status, held_at, applied_at)
       VALUES ($1,$2,$3,58.06,'2026-08-01','move_out','applied',$4::timestamptz,$4::timestamptz)`, [leftover, dr, w.leaseId, fin])

    const aug = await card(w, '2026-08-01')
    expect(aug.rent.collected).toBe(0)
    // The whole income card: the $100 kept less the $58.06 that already counted (as a stay).
    expect(aug.all.collected).toBe(41.94)
  })
})
