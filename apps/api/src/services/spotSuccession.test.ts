/**
 * 10/24 (Nic + Blue) — MH 28, COUNTRY ACRES.
 *
 * Susie McCoy is walking away from the mobile home and owes rent. The Bowmans'
 * daughter is taking over the home and wants the space from November 1. Blue
 * will not associate the two of them on paperwork, and will not release Susie
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
} from '../test/dbHelpers'

const pool = new Pool({ connectionString: process.env.DATABASE_URL
  || `postgresql://postgres:gam_dev_password@localhost:5432/${process.env.DB_NAME || 'gam_test'}` })
const q = { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any) } as any

afterAll(async () => { await pool.end() })

/** Susie sitting on a space, and a replacement lease starting later. */
async function theSpace(opts: { newStart: string; sittingEnd?: string | null } ) {
  const c = await pool.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    // The sitting lease: a signed term running years out, like Susie's.
    const susie = await seedTenant(c)
    const sitting = await seedLease(c, { unitId, landlordId, rentAmount: 500,
      leaseType: 'fixed_term', status: 'active', startDate: '2025-06-01' })
    await c.query(`UPDATE leases SET end_date = $2::date, signed_by_landlord = TRUE, signed_by_tenant = TRUE
                    WHERE id = $1`, [sitting, opts.sittingEnd === undefined ? '2029-05-31' : opts.sittingEnd])
    await seedLeaseTenant(c, { leaseId: sitting, tenantId: susie, role: 'primary' })
    // The replacement's lease: its own terms, nothing pointing at Susie's.
    const heather = await seedTenant(c)
    const incoming = await seedLease(c, { unitId, landlordId, rentAmount: 560,
      leaseType: 'month_to_month', status: 'pending', startDate: opts.newStart })
    // 10/24: the landlord NAMES the tenancy being replaced. Nothing automatic
    // sets this, and without it nobody is ended — see the gate tests below.
    await c.query(`UPDATE leases SET end_date = NULL, signed_by_landlord = TRUE, signed_by_tenant = TRUE,
                                     replaces_lease_id = $2 WHERE id = $1`, [incoming, sitting])
    await seedLeaseTenant(c, { leaseId: incoming, tenantId: heather, role: 'primary' })
    return { landlordId, propertyId, unitId, sitting, incoming, susie, heather }
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
    // Susie's term runs to 2029 and is signed by both. GAM accommodates rather
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
      [s.sitting, s.susie, s.landlordId])

    const owed = await whatIsStillOwedOnLease(q, s.sitting)
    expect(owed.amount).toBe(1000)   // the settled one is not owed

    const out = await replacementTookOverSpot(q, s.incoming)
    expect(out!.owed).toBe(1000)
    const debt = (await pool.query<any>(
      `SELECT amount::text AS amount, who, source_kind, source_key,
              to_char(left_on, 'YYYY-MM-DD') AS left_on, settled_at
         FROM tenant_left_owing WHERE landlord_id = $1`, [s.landlordId])).rows
    expect(debt).toHaveLength(1)
    expect(debt[0]).toMatchObject({ amount: '1000.00', source_kind: 'lease', source_key: s.sitting,
                                    left_on: '2026-10-31', settled_at: null })

    // FROZEN. A second pass cannot double it or move it, and the amount does
    // not follow anything that happens to the lease afterwards.
    await pool.query(`UPDATE leases SET end_date = NULL WHERE id = $1`, [s.sitting])
    await replacementTookOverSpot(q, s.incoming)
    const again = (await pool.query<any>(
      `SELECT amount::text AS amount FROM tenant_left_owing WHERE landlord_id = $1`, [s.landlordId])).rows
    expect(again).toHaveLength(1)
    expect(again[0].amount).toBe('1000.00')
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
    // Nic, correcting me: "Susie's lease goes to for several more years, and
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
      [s.landlordId, s.susie, s.sitting, s.unitId, `INV-${Date.now()}`])
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
      [s.landlordId, s.susie, s.sitting, s.unitId, `INV-${Date.now()}-b`])
    expect(await whySpotCannotBeTakenOver(q,
      { unitId: s.unitId, startIso: '2026-11-01', replacesLeaseId: s.sitting, exceptLeaseId: s.incoming })).toBeNull()
    expect((await replacementTookOverSpot(q, s.incoming))!.endsOn).toBe('2026-10-31')
  })

  it('a VOIDED invoice past the handover does not block it', async () => {
    const s = await theSpace({ newStart: '2026-11-01' })
    await pool.query(
      `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, status, total_amount)
       VALUES ($1,$2,$3,$4,$5,'2026-11-01','void',500)`,
      [s.landlordId, s.susie, s.sitting, s.unitId, `INV-${Date.now()}-c`])
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
