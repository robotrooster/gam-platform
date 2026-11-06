/**
 * 10/24 (Nic + Blue) — MH 28, COUNTRY ACRES.
 *
 * Amias Fotheringay is walking away from the mobile home and owes rent. The Bowmans'
 * daughter is taking over the home and wants the space from November 1. Blue
 * will not associate the two of them on paperwork, and will not release Amias
 * until the replacement has actually signed.
 *
 * Nic: "The replacement person needs to sign before it fires, right? That's the
 * thing that it's gated on. It's if the other person never fully commits, he
 * can't release the original person and then be stuck with nothing."
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import {
  replacementTookOverSpot, whySpotCannotBeTakenOver, whatIsStillOwedOnLease,
  namedSittingLease, sittingLeaseOnSpace, dayBefore,
  TWO_REPLACEMENTS_FOR_ONE_SPOT,
} from './spotSuccession'
import {
  seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant,
  seedUtilityMeter,
} from '../test/dbHelpers'

const pool = new Pool({ connectionString: process.env.DATABASE_URL
  || `postgresql://postgres:gam_dev_password@localhost:5432/${process.env.DB_NAME || 'gam_test'}` })
const q = { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any) } as any

afterAll(async () => { await pool.end() })

/** Amias sitting on a space, and a replacement lease starting later. */
async function theSpace(opts: { newStart: string; sittingEnd?: string | null } ) {
  const c = await pool.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    // The sitting lease: a signed term running years out, like Amias's.
    const amias = await seedTenant(c)
    const sitting = await seedLease(c, { unitId, landlordId, rentAmount: 500,
      leaseType: 'fixed_term', status: 'active', startDate: '2025-06-01' })
    await c.query(`UPDATE leases SET end_date = $2::date, signed_by_landlord = TRUE, signed_by_tenant = TRUE
                    WHERE id = $1`, [sitting, opts.sittingEnd === undefined ? '2029-05-31' : opts.sittingEnd])
    await seedLeaseTenant(c, { leaseId: sitting, tenantId: amias, role: 'primary' })
    // The replacement's lease: its own terms, nothing pointing at Amias's.
    const heather = await seedTenant(c)
    const incoming = await seedLease(c, { unitId, landlordId, rentAmount: 560,
      leaseType: 'month_to_month', status: 'pending', startDate: opts.newStart })
    // 10/24: the landlord NAMES the tenancy being replaced. Nothing automatic
    // sets this, and without it nobody is ended — see the gate tests below.
    await c.query(`UPDATE leases SET end_date = NULL, signed_by_landlord = TRUE, signed_by_tenant = TRUE,
                                     replaces_lease_id = $2 WHERE id = $1`, [incoming, sitting])
    await seedLeaseTenant(c, { leaseId: incoming, tenantId: heather, role: 'primary' })
    return { landlordId, propertyId, unitId, sitting, incoming, amias, heather }
  } finally { c.release() }
}

const leaseRow = async (id: string) => (await pool.query<any>(
  `SELECT to_char(end_date, 'YYYY-MM-DD') AS end_date, status FROM leases WHERE id = $1`, [id])).rows[0]

describe('a replacement takes over a space', () => {
  it('ends the sitting lease the day before the replacement starts, and links the two to nothing', async () => {
    const s = await theSpace({ newStart: '2026-11-01' })
    const out = await replacementTookOverSpot(q, s.incoming)
    expect(out).not.toBeNull()
    expect(out!.sittingLeaseId).toBe(s.sitting)
    expect(out!.endsOn).toBe('2026-10-31')
    expect((await leaseRow(s.sitting)).end_date).toBe('2026-10-31')

    // BLUE'S HARD CONSTRAINT: "not comfortable associating them together at
    // all, even on paperwork." Nothing on either lease points at the other.
    const link = await pool.query<any>(
      `SELECT supersedes_lease_id FROM leases WHERE id = ANY($1::uuid[])`, [[s.sitting, s.incoming]])
    expect(link.rows.every((r: any) => r.supersedes_lease_id === null)).toBe(true)
    // And they share no resident.
    const shared = await pool.query(
      `SELECT 1 FROM lease_tenants a JOIN lease_tenants b ON b.tenant_id = a.tenant_id
        WHERE a.lease_id = $1 AND b.lease_id = $2`, [s.sitting, s.incoming])
    expect(shared.rows).toHaveLength(0)
  })

  it('cuts short a SIGNED fixed term, because the landlord signing a replacement is him saying the space turns over', async () => {
    // Amias's term runs to 2029 and is signed by both. GAM accommodates rather
    // than refereeing whether she agreed to go (never gate on legality) — what
    // it does instead is tell her, which the esign caller does.
    const s = await theSpace({ newStart: '2026-11-01' })
    await replacementTookOverSpot(q, s.incoming)
    expect((await leaseRow(s.sitting)).end_date).toBe('2026-10-31')
  })

  it('does nothing at all when the space is empty — the ordinary new lease', async () => {
    const c = await pool.connect()
    try {
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const t = await seedTenant(c)
      const only = await seedLease(c, { unitId, landlordId, status: 'pending', startDate: '2026-11-01' })
      await seedLeaseTenant(c, { leaseId: only, tenantId: t, role: 'primary' })
      expect(await replacementTookOverSpot(q, only)).toBeNull()
    } finally { c.release() }
  })

  it('leaves a household renewing its OWN lease alone — that is renewalSuccessor, not this', async () => {
    const c = await pool.connect()
    try {
      const { userId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const same = await seedTenant(c)
      const old = await seedLease(c, { unitId, landlordId, status: 'active', startDate: '2025-06-01' })
      await seedLeaseTenant(c, { leaseId: old, tenantId: same, role: 'primary' })
      const renewal = await seedLease(c, { unitId, landlordId, status: 'pending', startDate: '2026-11-01' })
      await seedLeaseTenant(c, { leaseId: renewal, tenantId: same, role: 'primary' })
      // Same resident on both, so this module has nothing to say.
      // Even if somebody pointed it at the old lease, the same household is
      // a renewal and this module declines it.
      await c.query(`UPDATE leases SET replaces_lease_id = $2 WHERE id = $1`, [renewal, old])
      expect(await namedSittingLease(q,
        { leaseId: old, unitId, startIso: '2026-11-01', newLeaseId: renewal })).toBeNull()
      expect(await replacementTookOverSpot(q, renewal)).toBeNull()
    } finally { c.release() }
  })
})

describe('what the departing resident keeps owing', () => {
  it('freezes what is unpaid against their name, and never forgives it', async () => {
    // Nic: "her outstanding balance of what's unpaid at the time that we're
    // going to end the lease needs to be linked to her name so that we can, so
    // that she can make good on the amount when she says she's going to."
    const s = await theSpace({ newStart: '2026-11-01' })
    await pool.query(
      `INSERT INTO payments (lease_id, tenant_id, landlord_id, amount, type, status, due_date, entry_description)
       VALUES ($1,$2,$3,500,'rent','pending','2026-09-01','RENT'),
              ($1,$2,$3,500,'rent','pending','2026-10-01','RENT'),
              ($1,$2,$3,120,'utility','settled','2026-09-05','UTILITY')`,
      [s.sitting, s.amias, s.landlordId])

    const owed = await whatIsStillOwedOnLease(q, s.sitting)
    expect(owed.amount).toBe(1000)   // the settled one is not owed

    const out = await replacementTookOverSpot(q, s.incoming)
    expect(out!.owed).toBe(1000)
    const debt = (await pool.query<any>(
      `SELECT amount::text AS amount, who, source_kind, person_key,
              to_char(left_on, 'YYYY-MM-DD') AS left_on, settled_at
         FROM tenant_left_owing WHERE landlord_id = $1`, [s.landlordId])).rows
    expect(debt).toHaveLength(1)
    // 11/5 (Nic): the record is keyed on the PERSON with this landlord, not on
    // the lease — "one debt per person per landlord", so a tenancy ending, a
    // deposit return coming up short, a stay and a counter tab all land on one
    // record instead of four. person_key is the key; source_key only records
    // which of them opened it.
    const theirUserId = (await pool.query<any>(
      `SELECT user_id FROM tenants WHERE id = $1`, [s.amias])).rows[0].user_id
    expect(debt[0]).toMatchObject({ amount: '1000.00', source_kind: 'lease',
                                    person_key: `user:${theirUserId}`,
                                    left_on: '2026-10-31', settled_at: null })
    // And the figure is its parts added up — one part, the tenancy.
    const parts = (await pool.query<any>(
      `SELECT p.kind, p.source_key, p.amount::text AS amount
         FROM tenant_left_owing_parts p WHERE p.owing_id = $1 AND p.voided_at IS NULL`,
      [(await pool.query<any>(`SELECT id FROM tenant_left_owing WHERE landlord_id = $1`,
        [s.landlordId])).rows[0].id])).rows
    expect(parts).toEqual([{ kind: 'lease', source_key: s.sitting, amount: '1000.00' }])

    // A second pass cannot double it. 10/31: the figure is RE-COMPUTED rather
    // than written once, so it also cannot drift away from GAM's own money
    // rows — recomputing the same $1,000 changes nothing, and nothing that
    // happens to the lease shape afterwards moves it.
    await pool.query(`UPDATE leases SET end_date = NULL WHERE id = $1`, [s.sitting])
    await replacementTookOverSpot(q, s.incoming)
    const again = (await pool.query<any>(
      `SELECT amount::text AS amount FROM tenant_left_owing WHERE landlord_id = $1`, [s.landlordId])).rows
    expect(again).toHaveLength(1)
    expect(again[0].amount).toBe('1000.00')
  })

  // ── 10/31 (Nic): THE FINAL CYCLE'S UTILITIES COUNT ───────────────────────
  //
  //   "we need the water usage for number 28 to go to the lease that's being
  //    ended as part of the final expenses... Fix the number 28 gap where it'll
  //    add that money to her bill if she ever gets around to paying it."
  //
  // Utilities bill in ARREARS, so the last cycle's usage is written after the
  // handover is computed and sits as a utility bill with no payment row. Country
  // Acres Lot 28 froze at $739.60 on 10/28 and October's water ($24.75) landed
  // on 10/29, so the money that followed her was short — and would be short for
  // every resident who leaves at a cycle boundary.
  it("counts the final cycle's utilities in what she is recorded as owing", async () => {
    const s = await theSpace({ newStart: '2026-11-01' })
    await pool.query(
      `INSERT INTO payments (lease_id, tenant_id, landlord_id, amount, type, status, due_date, entry_description)
       VALUES ($1,$2,$3,450,'rent','pending','2026-10-01','RENT')`,
      [s.sitting, s.amias, s.landlordId])
    const meterId = await (async () => {
      const c = await pool.connect()
      try { return await seedUtilityMeter(c as any, { propertyId: s.propertyId, utilityType: 'water', billingMethod: 'submeter' }) }
      finally { c.release() }
    })()
    // October's water on the lease that is ending: no payment row yet, still
    // 'unbilled'. This is the shape a final cycle's utility always has, because
    // utilities bill in arrears.
    await pool.query(
      `INSERT INTO utility_bills
         (meter_id, unit_id, lease_id, tenant_id, landlord_id, billing_cycle_month,
          usage_amount, allocation_method, charge_amount, tax_amount, status, utility_type)
       VALUES ($1,$2,$3,$4,$5,'2026-10-01',1500,'submeter',24.75,0,'unbilled','water')`,
      [meterId, s.unitId, s.sitting, s.amias, s.landlordId])

    const owed = await whatIsStillOwedOnLease(q, s.sitting)
    expect(owed.amount).toBe(474.75)      // 450 rent + 24.75 water

    const out = await replacementTookOverSpot(q, s.incoming)
    expect(out!.owed).toBe(474.75)
    const debt = (await pool.query<any>(
      `SELECT amount::text AS amount FROM tenant_left_owing
        WHERE landlord_id = $1 AND source_kind = 'lease'`, [s.landlordId])).rows
    expect(debt).toHaveLength(1)
    expect(debt[0].amount).toBe('474.75')
  })

  // ── THE REMAINING GAP, DELIBERATELY PINNED ────────────────────────────────
  //
  // `replacementTookOverSpot` fires ONCE, on the replacement's signature, and
  // nothing re-runs it. So a utility bill written AFTER that moment — which is
  // the normal case, since the meter is read at month end and the handover is
  // signed whenever it is signed — is seen by the calculation but never reaches
  // the stored figure. Country Acres Lot 28: frozen $739.60 on 10/28, water
  // written 10/29, corrected by hand on 10/31.
  //
  // The calculation is right, and the INSERT will take a new figure while
  // nobody has collected against it. What is missing is the TRIGGER, and that
  // is a mechanism decision (a hook where utility bills are written, or reading
  // the figure live at the collection surfaces) — Nic's call, not a guess.
  it('sees a utility bill that lands after the handover, even though nothing re-runs the handover yet', async () => {
    const s = await theSpace({ newStart: '2026-11-01' })
    await pool.query(
      `INSERT INTO payments (lease_id, tenant_id, landlord_id, amount, type, status, due_date, entry_description)
       VALUES ($1,$2,$3,450,'rent','pending','2026-10-01','RENT')`,
      [s.sitting, s.amias, s.landlordId])
    await replacementTookOverSpot(q, s.incoming)
    const frozen = (await pool.query<any>(
      `SELECT amount::text AS amount FROM tenant_left_owing
        WHERE landlord_id = $1 AND source_kind = 'lease'`, [s.landlordId])).rows
    expect(frozen[0].amount).toBe('450.00')

    const meterId = await (async () => {
      const c = await pool.connect()
      try { return await seedUtilityMeter(c as any, { propertyId: s.propertyId, utilityType: 'water', billingMethod: 'submeter' }) }
      finally { c.release() }
    })()
    await pool.query(
      `INSERT INTO utility_bills
         (meter_id, unit_id, lease_id, tenant_id, landlord_id, billing_cycle_month,
          usage_amount, allocation_method, charge_amount, tax_amount, status, utility_type)
       VALUES ($1,$2,$3,$4,$5,'2026-10-01',1500,'submeter',24.75,0,'unbilled','water')`,
      [meterId, s.unitId, s.sitting, s.amias, s.landlordId])

    // The arithmetic already includes it — whatever ends up calling this will
    // get the right number.
    expect((await whatIsStillOwedOnLease(q, s.sitting)).amount).toBe(474.75)
  })

  it('a utility line already on an invoice is counted once, not twice', async () => {
    const s = await theSpace({ newStart: '2026-11-01' })
    const pay = (await pool.query<any>(
      `INSERT INTO payments (lease_id, tenant_id, landlord_id, amount, type, status, due_date, entry_description)
       VALUES ($1,$2,$3,39.60,'utility','pending','2026-10-01','UTILITY') RETURNING id`,
      [s.sitting, s.amias, s.landlordId])).rows[0].id
    const meterId = await (async () => {
      const c = await pool.connect()
      try { return await seedUtilityMeter(c as any, { propertyId: s.propertyId, utilityType: 'water', billingMethod: 'submeter' }) }
      finally { c.release() }
    })()
    await pool.query(
      `INSERT INTO utility_bills
         (meter_id, unit_id, lease_id, tenant_id, landlord_id, billing_cycle_month,
          usage_amount, allocation_method, charge_amount, tax_amount, status, utility_type, payment_id)
       VALUES ($1,$2,$3,$4,$5,'2026-09-01',2400,'submeter',39.60,0,'billed','water',$6)`,
      [meterId, s.unitId, s.sitting, s.amias, s.landlordId, pay])

    // The payment row carries it; the utility_bills row has a payment_id and is
    // excluded, so it is $39.60 and not $79.20.
    const owed = await whatIsStillOwedOnLease(q, s.sitting)
    expect(owed.amount).toBe(39.60)
  })

  it('writes no debt when they owed nothing', async () => {
    const s = await theSpace({ newStart: '2026-11-01' })
    const out = await replacementTookOverSpot(q, s.incoming)
    expect(out!.owed).toBe(0)
    expect(out!.leftOwingId).toBeNull()
    expect((await pool.query(`SELECT 1 FROM tenant_left_owing WHERE landlord_id = $1`, [s.landlordId])).rows)
      .toHaveLength(0)
  })
})

describe('what is refused', () => {
  it('the NORMAL case is not refused: one sitting lease running years out, one replacement starting inside it', async () => {
    // Nic, correcting me: "Amias's lease goes to for several more years, and
    // this new person is going to start November 1st." That overlap is the
    // feature, not the error.
    const s = await theSpace({ newStart: '2026-11-01' })
    expect(await whySpotCannotBeTakenOver(q,
      { unitId: s.unitId, startIso: '2026-11-01', replacesLeaseId: s.sitting, exceptLeaseId: s.incoming })).toBeNull()
  })

  it('a SECOND replacement of the same tenancy is refused by the database, not resolved', async () => {
    const s = await theSpace({ newStart: '2026-11-01' })
    const c = await pool.connect()
    try {
      const rival = await seedTenant(c)
      const rivalLease = await seedLease(c, { unitId: s.unitId, landlordId: s.landlordId,
        status: 'pending', startDate: '2026-11-01' })
      await seedLeaseTenant(c, { leaseId: rivalLease, tenantId: rival, role: 'primary' })
      // One replacement per tenancy, enforced in the schema
      // (ux_leases_one_replacement_per_lease). Two people signed to take one
      // space is not something software should pick between, so the second one
      // cannot even be drafted until the first is cancelled.
      await expect(c.query(
        `UPDATE leases SET replaces_lease_id = $2 WHERE id = $1`, [rivalLease, s.sitting]))
        .rejects.toThrow(/ux_leases_one_replacement_per_lease/)
    } finally { c.release() }
    // And the first one still works.
    expect((await replacementTookOverSpot(q, s.incoming))!.endsOn).toBe('2026-10-31')
  })

  it('a draft the resident has not signed hands nothing over', async () => {
    // Nic: "if Blue drafts it and then she doesn't sign, then the old person
    // could still be billed."
    const s = await theSpace({ newStart: '2026-11-01' })
    await pool.query(`UPDATE leases SET signed_by_tenant = FALSE WHERE id = $1`, [s.incoming])
    expect(await replacementTookOverSpot(q, s.incoming)).toBeNull()
    expect((await leaseRow(s.sitting)).end_date).toBe('2029-05-31')
  })

  it('a lease that names NOBODY ends nobody — the RV booking Nic was worried about', async () => {
    // Nic: "somebody else comes in, tries to book a reservation for 30 or more
    // nights, and it generates a draft lease automatically... is that going to
    // automatically try to boot a person there?" No. Nothing automatic names a
    // lease to replace, and without one this does nothing at all.
    const s = await theSpace({ newStart: '2026-11-01' })
    await pool.query(`UPDATE leases SET replaces_lease_id = NULL, lease_source = 'booking_draft'
                       WHERE id = $1`, [s.incoming])
    expect(await replacementTookOverSpot(q, s.incoming)).toBeNull()
    expect((await leaseRow(s.sitting)).end_date).toBe('2029-05-31')
    // And nothing is refused on the way in either — an ordinary lease on an
    // occupied space is not this feature's business.
    expect(await whySpotCannotBeTakenOver(q,
      { unitId: s.unitId, startIso: '2026-11-01', replacesLeaseId: null, exceptLeaseId: s.incoming })).toBeNull()
  })

  it('refuses a replacement pointed at a lease on another space — a mis-picked unit', async () => {
    const s = await theSpace({ newStart: '2026-11-01' })
    const c = await pool.connect()
    let otherUnitsLease = ''
    try {
      const otherUnit = await seedUnit(c, { propertyId: s.propertyId, landlordId: s.landlordId })
      const neighbour = await seedTenant(c)
      otherUnitsLease = await seedLease(c, { unitId: otherUnit, landlordId: s.landlordId,
        status: 'active', startDate: '2025-06-01' })
      await seedLeaseTenant(c, { leaseId: otherUnitsLease, tenantId: neighbour, role: 'primary' })
    } finally { c.release() }
    const why = await whySpotCannotBeTakenOver(q,
      { unitId: s.unitId, startIso: '2026-11-01', replacesLeaseId: otherUnitsLease, exceptLeaseId: s.incoming })
    expect(why).toMatch(/not a current tenancy on this space/i)
  })

  it('refuses a handover that would reach back into a month already invoiced', async () => {
    // Nic: "we don't want it to reach back into a month that's already invoiced."
    const s = await theSpace({ newStart: '2026-11-01' })
    await pool.query(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, status, total_amount)
       VALUES ($1,$2,$3,$4,$5,'2026-11-01','pending',500)`,
      [s.landlordId, s.amias, s.sitting, s.unitId, `INV-${Date.now()}`])
    const why = await whySpotCannotBeTakenOver(q,
      { unitId: s.unitId, startIso: '2026-11-01', replacesLeaseId: s.sitting, exceptLeaseId: s.incoming })
    expect(why).toMatch(/already billed/i)
    await expect(replacementTookOverSpot(q, s.incoming)).rejects.toThrow(/already billed/i)
    expect((await leaseRow(s.sitting)).end_date).toBe('2029-05-31')
  })

  it('a month invoiced BEFORE the handover is fine — only what is on or past it blocks', async () => {
    const s = await theSpace({ newStart: '2026-11-01' })
    await pool.query(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, status, total_amount)
       VALUES ($1,$2,$3,$4,$5,'2026-10-01','pending',500)`,
      [s.landlordId, s.amias, s.sitting, s.unitId, `INV-${Date.now()}-b`])
    expect(await whySpotCannotBeTakenOver(q,
      { unitId: s.unitId, startIso: '2026-11-01', replacesLeaseId: s.sitting, exceptLeaseId: s.incoming })).toBeNull()
    expect((await replacementTookOverSpot(q, s.incoming))!.endsOn).toBe('2026-10-31')
  })

  it('a VOIDED invoice past the handover does not block it', async () => {
    const s = await theSpace({ newStart: '2026-11-01' })
    await pool.query(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, status, total_amount)
       VALUES ($1,$2,$3,$4,$5,'2026-11-01','void',500)`,
      [s.landlordId, s.amias, s.sitting, s.unitId, `INV-${Date.now()}-c`])
    expect(await whySpotCannotBeTakenOver(q,
      { unitId: s.unitId, startIso: '2026-11-01', replacesLeaseId: s.sitting, exceptLeaseId: s.incoming })).toBeNull()
  })
})

describe('the day before', () => {
  it('walks months and leap years rather than subtracting 24 hours', () => {
    expect(dayBefore('2026-11-01')).toBe('2026-10-31')
    expect(dayBefore('2026-01-01')).toBe('2025-12-31')
    expect(dayBefore('2028-03-01')).toBe('2028-02-29')
    expect(dayBefore('2027-03-01')).toBe('2027-02-28')
  })
})
