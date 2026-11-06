/**
 * 11/5 (Nic) — A TENANCY THAT ENDS BOOKS WHAT THEY LEFT OWING, WHOEVER ENDED IT.
 *
 *   "That needs to be fixed right away, because people are going to leave
 *    regardless of if somebody's coming in to replace them or not."
 *
 * The defect these cover is a live one at Country Acres: MH 18 and MH 28 both
 * ended 10/31 owing money, and only MH 28 was on the left-owing book — because
 * a replacement signed for MH 28's lot and the only writer in GAM fired on that
 * signature. MH 18's lot sits empty, so nothing ran.
 *
 * So the tests are written from the OUTSIDE, through the things that really end
 * a tenancy — scheduler.processLeaseEnds for a move-out and the nightly sweep
 * for every other door — and not against the writer alone. "A tenancy ending
 * books it" is a claim about those paths, not about one function.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db, getClient, query } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { processLeaseEnds, bookTenanciesThatLeftOwing } from '../jobs/scheduler'
import { whatIsStillOwedOnLease, freezeWhatTheyLeftOwing } from './leftOwingFreeze'

beforeEach(async () => { await cleanupAllSchema() })

const pool = { query: query as any }

interface Scene {
  landlordId: string; userId: string; propertyId: string
  unitId: string; leaseId: string; tenantId: string
}

/**
 * A tenancy whose last day was yesterday — the state the 2am sweep finds. The
 * dwelling is the LANDLORD's unless told otherwise, because a tenant-owned
 * dwelling's end date lapses instead of ending anything (10/24 directive), and
 * that case has its own test below.
 */
async function endingTenancy(opts: {
  ownDwelling?: boolean
  endedDaysAgo?: number
} = {}): Promise<Scene> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId })
    await client.query(
      `UPDATE units SET dwelling_ownership = $2, unit_type = 'apartment', status = 'active'
        WHERE id = $1`, [unitId, opts.ownDwelling ? 'tenant' : 'landlord'])
    const leaseId = await seedLease(client, {
      unitId, landlordId, rentAmount: 450, startDate: '2026-01-01' })
    await client.query(
      `UPDATE leases SET end_date = CURRENT_DATE - $2::int, needs_review = FALSE WHERE id = $1`,
      [leaseId, opts.endedDaysAgo ?? 1])
    await seedLeaseTenant(client, { leaseId, tenantId })
    await client.query('COMMIT')
    return { landlordId, userId, propertyId, unitId, leaseId, tenantId }
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e }
  finally { client.release() }
}

/** The tag each charge type carries (payments_entry_description_check). */
const TAG: Record<string, string> = {
  rent: 'RENT', utility: 'UTILITY', late_fee: 'LATEFEE', fee: 'OTHERFEE',
  carried_balance: 'BALANCE', home_payment: 'HOMEPMT', deposit: 'DEPOSIT',
}

/** One owed charge on that tenancy. */
async function charge(s: Scene, o: {
  type: string; amount: number; tag?: string; owner?: string
  dueDaysAgo?: number; spaceCarryforward?: boolean
}): Promise<string> {
  let cfId: string | null = null
  if (o.spaceCarryforward) {
    cfId = (await db.query<{ id: string }>(
      `INSERT INTO space_rent_carryforwards
         (landlord_id, property_id, unit_id, origin_lease_id, origin_tenant_id,
          amount, opened_on, oldest_due_date)
       VALUES ($1,$2,$3,$4,$5,$6, CURRENT_DATE, CURRENT_DATE) RETURNING id`,
      [s.landlordId, s.propertyId, s.unitId, s.leaseId, s.tenantId, o.amount])).rows[0].id
  }
  const r = await db.query<{ id: string }>(
    `INSERT INTO payments
       (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
        entry_description, due_date, revenue_owner, space_carryforward_id)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7, CURRENT_DATE - $8::int, $9, $10)
     RETURNING id`,
    [s.unitId, s.leaseId, s.tenantId, s.landlordId, o.type, o.amount,
     o.tag ?? TAG[o.type] ?? 'OTHERFEE', o.dueDaysAgo ?? 10, o.owner ?? 'landlord', cfId])
  return r.rows[0].id
}

/**
 * What the book says about this PERSON with this landlord, if anything.
 *
 * 11/5: found by who they are, not by the lease — the record is one debt per
 * person and a lease is one part of it, so looking it up by a lease id would
 * miss the very consolidation this is here to check.
 */
async function book(s: Scene) {
  const r = await db.query<{
    amount: string; who: string; left_on: string | null
    settled_at: string | null; settled_reason: string | null
  }>(
    `SELECT amount::text AS amount, who, to_char(left_on,'YYYY-MM-DD') AS left_on,
            settled_at::text AS settled_at, settled_reason
       FROM tenant_left_owing
      WHERE landlord_id = $1
        AND user_id = (SELECT user_id FROM tenants WHERE id = $2)`,
    [s.landlordId, s.tenantId])
  return r.rows[0] ?? null
}

/** The parts that record is made of, live ones only. */
async function bookParts(s: Scene) {
  const r = await db.query<{ kind: string; source_key: string; amount: string }>(
    `SELECT p.kind, p.source_key, p.amount::text AS amount
       FROM tenant_left_owing_parts p
       JOIN tenant_left_owing o ON o.id = p.owing_id
      WHERE o.landlord_id = $1
        AND o.user_id = (SELECT user_id FROM tenants WHERE id = $2)
        AND p.voided_at IS NULL
      ORDER BY p.kind`, [s.landlordId, s.tenantId])
  return r.rows.map(x => ({ kind: x.kind, sourceKey: x.source_key, amount: Number(x.amount) }))
}

// ── THE DEFECT ITSELF ───────────────────────────────────────────────────────
describe('a tenancy ends with nobody replacing them', () => {
  it('books what they left owing — the MH 18 case, which booked nothing', async () => {
    const s = await endingTenancy()
    await charge(s, { type: 'rent', amount: 450 })
    await charge(s, { type: 'utility', amount: 16.5 })
    await charge(s, { type: 'late_fee', amount: 50 })

    expect(await book(s)).toBeNull()      // nothing before the ending
    await processLeaseEnds()

    // The ending itself happened: expired, and the space is free.
    expect((await db.query<any>(
      `SELECT status FROM leases WHERE id = $1`, [s.leaseId])).rows[0].status).toBe('expired')
    expect((await db.query<any>(
      `SELECT status FROM units WHERE id = $1`, [s.unitId])).rows[0].status).toBe('vacant')

    const b = await book(s)
    expect(b).not.toBeNull()
    expect(Number(b!.amount)).toBe(516.5)
    expect(b!.settled_at).toBeNull()
  })

  it('counts a CARRIED BALANCE, which the pay-now predicate left out', async () => {
    // The MH 18 arithmetic defect. whatIsStillOwedOnLease borrowed
    // moneyPredicates.requiredRowSql — the pay-in-full set, which drops a
    // carried balance on purpose (S622: paid last, optional, may be partial).
    // Right for a Pay Now button; a carried balance is exactly the money
    // somebody walks away from. $566.50 of MH 18's was invisible.
    const s = await endingTenancy()
    await charge(s, { type: 'rent', amount: 450 })
    await charge(s, { type: 'carried_balance', amount: 566.5, tag: 'BALANCE' })

    expect((await whatIsStillOwedOnLease(pool, s.leaseId)).amount).toBe(1016.5)
    await processLeaseEnds()
    expect(Number((await book(s))!.amount)).toBe(1016.5)
  })

  it('leaves out money that is not this landlord\'s claim', async () => {
    const s = await endingTenancy()
    await charge(s, { type: 'rent', amount: 450 })
    // Unpaid space rent on a tenant-owned home follows the SPACE — the next
    // lease drafted there picks the charge up. Booking it against the person
    // too would have two people owing one set of dollars.
    await charge(s, { type: 'carried_balance', amount: 300, tag: 'BALANCE', spaceCarryforward: true })
    // GAM's own fee. The tenant owes GAM; it is not the landlord's to settle
    // or to take a share of.
    await charge(s, { type: 'fee', amount: 4, tag: 'RETURNFEE', owner: 'gam' })

    expect((await whatIsStillOwedOnLease(pool, s.leaseId)).amount).toBe(450)
    await processLeaseEnds()
    expect(Number((await book(s))!.amount)).toBe(450)
  })

  it('books nothing when they left owing nothing', async () => {
    const s = await endingTenancy()
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount,
                             status, entry_description, due_date, revenue_owner)
       VALUES ($1,$2,$3,$4,'rent',450,'settled','RENT', CURRENT_DATE - 10, 'landlord')`,
      [s.unitId, s.leaseId, s.tenantId, s.landlordId])
    await processLeaseEnds()
    expect(await book(s)).toBeNull()
  })
})

// ── WHO MUST NEVER LAND ON IT ───────────────────────────────────────────────
describe('nobody who did not walk away', () => {
  it('a tenant-owned dwelling whose end date merely LAPSES is not on the book', async () => {
    // 10/24 (Nic, DIRECTIVE): a date nobody chose must never put somebody off
    // their space. Those leases carry on month-to-month, so they are not an
    // ending at all — and must not be read as one here either.
    const s = await endingTenancy({ ownDwelling: true })
    await charge(s, { type: 'rent', amount: 450 })
    await processLeaseEnds()

    const lease = (await db.query<any>(
      `SELECT status, end_date FROM leases WHERE id = $1`, [s.leaseId])).rows[0]
    expect(lease.status).toBe('active')
    expect(lease.end_date).toBeNull()
    expect(await book(s)).toBeNull()
    expect((await bookTenanciesThatLeftOwing()).booked).toBe(0)
  })

  it('a household that moved to another space with the same landlord is not on the book', async () => {
    const s = await endingTenancy()
    await charge(s, { type: 'rent', amount: 450 })
    // Their next space, live. They did not leave — they moved.
    const client = await getClient()
    try {
      const otherUnit = await seedUnit(client, {
        propertyId: s.propertyId, landlordId: s.landlordId })
      const nextLease = await seedLease(client, {
        unitId: otherUnit, landlordId: s.landlordId, startDate: '2026-11-01' })
      await seedLeaseTenant(client, { leaseId: nextLease, tenantId: s.tenantId })
    } finally { client.release() }

    expect((await bookTenanciesThatLeftOwing()).booked).toBe(0)
    expect(await book(s)).toBeNull()
  })
})

// ── THE FIVE DOORS THAT HAD NO HOOK ─────────────────────────────────────────
describe('the nightly sweep, for every ending that came through no hook', () => {
  it('books a tenancy that was simply terminated — the early-termination path', async () => {
    // services/leaseTermination ends a lease without even cutting a
    // deposit-return draft, so there was nowhere a hook could have gone. The
    // sweep reads the state it leaves behind.
    const s = await endingTenancy()
    await charge(s, { type: 'rent', amount: 450 })
    await charge(s, { type: 'fee', amount: 125, tag: 'OTHERFEE' })
    await db.query(
      `UPDATE leases SET status='terminated', terminated_at=NOW() WHERE id=$1`, [s.leaseId])
    await db.query(
      `UPDATE lease_tenants SET status='removed', removed_at=NOW(), removed_reason='lease_ended'
        WHERE lease_id=$1`, [s.leaseId])

    const r = await bookTenanciesThatLeftOwing()
    expect(r.booked).toBe(1)
    expect(Number((await book(s))!.amount)).toBe(575)
  })

  it('re-computes a figure the final arrears-billed utility has changed', async () => {
    // Susie McCoy's live row is $24.75 short for exactly this reason: water
    // bills a month behind, so the last cycle does not exist on the day
    // somebody leaves. The 10/31 recompute rule covers the takeover path; the
    // sweep is what applies it to everything else.
    const s = await endingTenancy()
    await charge(s, { type: 'rent', amount: 450 })
    await processLeaseEnds()
    expect(Number((await book(s))!.amount)).toBe(450)

    await charge(s, { type: 'utility', amount: 24.75, dueDaysAgo: 0 })
    expect((await bookTenanciesThatLeftOwing()).booked).toBe(1)
    expect(Number((await book(s))!.amount)).toBe(474.75)
  })

  it('settles the row when they pay everything off afterwards', async () => {
    const s = await endingTenancy()
    const rentId = await charge(s, { type: 'rent', amount: 450 })
    await processLeaseEnds()
    expect(Number((await book(s))!.amount)).toBe(450)

    await db.query(
      `UPDATE payments SET status='settled', settled_at=NOW() WHERE id=$1`, [rentId])
    await bookTenanciesThatLeftOwing()

    const b = await book(s)
    expect(b!.settled_at).not.toBeNull()
    expect(b!.settled_reason).toContain('Paid in full')
  })

  it('never moves a figure somebody has begun collecting against', async () => {
    const s = await endingTenancy()
    await charge(s, { type: 'rent', amount: 450 })
    await processLeaseEnds()
    await db.query(
      `UPDATE tenant_left_owing SET collected_amount = 100, settled_amount = 450
        WHERE landlord_id=$1
          AND user_id = (SELECT user_id FROM tenants WHERE id = $2)`,
      [s.landlordId, s.tenantId])

    // More money appears, and the sweep must not touch the figure.
    await charge(s, { type: 'utility', amount: 80, dueDaysAgo: 0 })
    expect((await bookTenanciesThatLeftOwing()).booked).toBe(0)
    expect(Number((await book(s))!.amount)).toBe(450)
  })
})

// ── THE DEPOSIT ─────────────────────────────────────────────────────────────
describe('the deposit comes off while the return is still open', () => {
  it('books only what the deposit will not cover, and nothing when it covers it all', async () => {
    const s = await endingTenancy()
    await charge(s, { type: 'rent', amount: 450 })
    // The draft the ending cuts, standing in for one with a real deposit: the
    // deposit it will spend is total_deposit less the refund.
    await db.query(
      `INSERT INTO deposit_returns
         (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount,
          unpaid_balance_amount, total_deductions, refund_amount, gap_amount)
       VALUES ($1,$2,$3, 300, 0, 450, 450, 0, 150)`,
      [s.leaseId, s.tenantId, s.landlordId])

    const froze = await freezeWhatTheyLeftOwing(pool, { leaseId: s.leaseId })
    expect(froze!.amount).toBe(150)

    // A deposit that covers everything books nothing at all — a person whose
    // deposit clears their balance must never be flagged.
    await db.query(
      `UPDATE deposit_returns SET total_deposit = 600, refund_amount = 150 WHERE lease_id = $1`,
      [s.leaseId])
    await db.query(`DELETE FROM tenant_left_owing WHERE source_key = $1`,
      [`carried:${s.tenantId}:${s.landlordId}`])
    expect(await freezeWhatTheyLeftOwing(pool, { leaseId: s.leaseId })).toBeNull()
  })

  it('takes nothing off once the return is finalized — the rows already moved', async () => {
    const s = await endingTenancy()
    await charge(s, { type: 'rent', amount: 450 })
    await db.query(
      `INSERT INTO deposit_returns
         (lease_id, tenant_id, landlord_id, total_deposit, cleaning_fee_amount,
          unpaid_balance_amount, total_deductions, refund_amount, gap_amount,
          status, finalized_at)
       VALUES ($1,$2,$3, 300, 0, 450, 450, 0, 150, 'sent_gap', NOW())`,
      [s.leaseId, s.tenantId, s.landlordId])

    // Finalize marks the swept rows paid from the deposit and raises the rest
    // as the gap invoice, so the rows ARE the answer. Subtracting the deposit
    // again would take it off twice.
    expect((await freezeWhatTheyLeftOwing(pool, { leaseId: s.leaseId }))!.amount).toBe(450)
  })
})

// ── 11/5: THE TENANCY IS ONE PART OF ONE DEBT ───────────────────────────────
//
//   "we need a way for it to only record once, but it needs to be able to be
//    infused from different sources."
//
// The writer no longer sets a figure; it writes the LEASE's part and
// services/leftOwingParts adds the person's parts up. These are the two claims
// that must hold of every door a tenancy can go out of, checked through the
// real paths rather than against the writer: the record is findable as a
// PERSON, and its figure is its live parts.
describe('what a tenancy ending leaves on the book', () => {
  it('is one part, keyed on the lease, on a record keyed on the person', async () => {
    const s = await endingTenancy()
    await charge(s, { type: 'rent', amount: 450 })
    await charge(s, { type: 'utility', amount: 16.5 })
    await processLeaseEnds()

    expect(await bookParts(s)).toEqual(
      [{ kind: 'lease', sourceKey: s.leaseId, amount: 466.5 }])
    const row = (await db.query<any>(
      `SELECT person_key, amount::float8 AS amount FROM tenant_left_owing
        WHERE landlord_id = $1`, [s.landlordId])).rows[0]
    expect(row.person_key).toBe(`user:${(await db.query<any>(
      `SELECT user_id FROM tenants WHERE id = $1`, [s.tenantId])).rows[0].user_id}`)
    expect(row.amount).toBe(466.5)
  })

  it('a stay of theirs lands on the SAME record, not a second one', async () => {
    // The collision that was live this morning: a tenancy ending and a stay
    // that was never paid off were two debts to the same landlord, so the next
    // landlord screening them saw a pile instead of a person.
    const s = await endingTenancy()
    await charge(s, { type: 'rent', amount: 450 })
    await processLeaseEnds()

    const { recordWalkAwayPart } = await import('./leftOwingParts')
    const userId = (await db.query<any>(
      `SELECT user_id FROM tenants WHERE id = $1`, [s.tenantId])).rows[0].user_id
    await recordWalkAwayPart(pool, {
      landlordId: s.landlordId, propertyId: s.propertyId,
      person: { userId }, kind: 'stay', sourceKey: 'a-booking-of-theirs', amount: 700 })

    expect((await db.query<any>(
      `SELECT count(*)::int AS n FROM tenant_left_owing WHERE landlord_id = $1`,
      [s.landlordId])).rows[0].n).toBe(1)
    expect(Number((await book(s))!.amount)).toBe(1150)

    // And paying the TENANCY off does not clear the stay with it — which is
    // exactly what settling the whole record used to do.
    await db.query(`UPDATE payments SET status='settled', settled_at=NOW() WHERE lease_id=$1`,
      [s.leaseId])
    await bookTenanciesThatLeftOwing()
    const after = await book(s)
    expect(after!.settled_at).toBeNull()
    expect(Number(after!.amount)).toBe(700)
    expect(await bookParts(s)).toEqual(
      [{ kind: 'stay', sourceKey: 'a-booking-of-theirs', amount: 700 }])
  })
})
