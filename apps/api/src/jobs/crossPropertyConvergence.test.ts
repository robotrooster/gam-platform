/**
 * S616 — the two landlord pieces converging in the right spot.
 *
 * Nic: "My friend's apartment and my utilities on the same physical place...
 * We just need to be able to divert the utilities that go to my property from
 * the rent that goes to the other property."
 *
 * The tenant sees ONE bill and no distinction — "to them, it's all going to the
 * same place." Underneath, each utility row still belongs to the landlord whose
 * meter turned, because the payout sweep scopes by payments.landlord_id rather
 * than by invoice.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant, seedUtilityMeter,
} from '../test/dbHelpers'
import { generateInvoices } from './invoiceGeneration'
import { generateServiceAgreementInvoices } from './serviceAgreementInvoices'
import { proposeLink } from '../services/crossPropertyLink'

beforeEach(async () => { await cleanupAllSchema() })

/**
 * Two landlords, one physical place:
 *   A (the utility landlord) — has a serviced space on his trash meter, and the
 *     service address he typed is B's property address.
 *   B (the unit landlord)    — leases that same place to the tenant.
 */
async function twoLandlordsOnePlace() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')

    const A = await seedLandlord(c)
    const propA = await seedProperty(c, {
      landlordId: A.landlordId, ownerUserId: A.userId, managedByUserId: A.userId,
    })
    await c.query(
      `UPDATE properties SET street1='22658 Highway 89', city='Yarnell',
                             state='AZ', zip='85362' WHERE id=$1`, [propA])

    const B = await seedLandlord(c)
    const propB = await seedProperty(c, {
      landlordId: B.landlordId, ownerUserId: B.userId, managedByUserId: B.userId,
    })
    await c.query(
      `UPDATE properties SET street1='22660 Highway 89', city='Yarnell',
                             state='AZ', zip='85362' WHERE id=$1`, [propB])

    // A's serviced space, addressed at B's building.
    const servicedUnitId = await seedUnit(c, { propertyId: propA, landlordId: A.landlordId })
    await c.query(`UPDATE units SET status='utility_service' WHERE id=$1`, [servicedUnitId])
    const tenantId = await seedTenant(c)
    const { rows: [sa] } = await c.query(
      `INSERT INTO utility_service_agreements
         (landlord_id, unit_id, tenant_id, start_date, service_address,
          late_fee_enabled, late_fee_grace_days, late_fee_initial_type,
          late_fee_initial_amount,
          -- S616: the payer has agreed — attested by the landlord, which is
          -- Nic's own case (cash collected by hand for years). Without this
          -- nothing is invoiced at all.
          payer_attested_at)
       VALUES ($1,$2,$3,'2026-01-01','22660 Highway 89', true, 5, 'flat', 25, NOW())
       RETURNING id`,
      [A.landlordId, servicedUnitId, tenantId])

    // B's real unit, leased to the SAME person, rent $950 due the 1st.
    const leasedUnitId = await seedUnit(c, { propertyId: propB, landlordId: B.landlordId })
    const leaseId = await seedLease(c, {
      unitId: leasedUnitId, landlordId: B.landlordId, status: 'active',
      rentAmount: 950, startDate: '2026-01-01',
    })
    await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
    await c.query(`UPDATE leases SET rent_due_day=1 WHERE id=$1`, [leaseId])

    await c.query('COMMIT')

    // A's trash meter, 1 can on the serviced space at $25.
    const c2 = await db.connect()
    let meterId = ''
    try {
      await c2.query('BEGIN')
      meterId = await seedUtilityMeter(c2, { propertyId: propA })
      await c2.query('COMMIT')
    } finally { c2.release() }
    await db.query(
      `UPDATE utility_meters SET billing_method='flat_rate', utility_type='trash',
              digits=NULL WHERE id=$1`, [meterId])
    await db.query(
      `INSERT INTO property_utility_rates (property_id, utility_type, rate_per_unit, base_fee)
       VALUES ($1,'trash',25,0) ON CONFLICT (property_id, utility_type)
       DO UPDATE SET rate_per_unit = EXCLUDED.rate_per_unit`, [propA])
    await db.query(
      `INSERT INTO utility_meter_units (meter_id, unit_id, quantity) VALUES ($1,$2,1)`,
      [meterId, servicedUnitId])

    return {
      A, B, tenantId, leaseId, servicedUnitId, leasedUnitId,
      agreementId: sa.id, propA, propB,
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

// S616: matching IS linking. Nic: "The other landlord shouldn't even see
// anything about it. We are matching it up on the back end without anybody
// knowing."
async function linkAndActivate(f: any) {
  return proposeLink({
    serviceAgreementId: f.agreementId, unitId: f.leasedUnitId, via: 'tenant_account',
  })
}

describe('cross-property convergence (S616)', () => {
  it('links on the address the utility landlord typed, with no approvals', async () => {
    const f = await twoLandlordsOnePlace()
    const link = await proposeLink({
      serviceAgreementId: f.agreementId, unitId: f.leasedUnitId, via: 'tenant_account',
    })
    // Live immediately. Nobody is asked: neither landlord's revenue changes,
    // and a landlord has no standing to refuse another a payment rail.
    expect(link.status).toBe('active')
    expect(link.activated_at).not.toBeNull()
    expect(link.address_match_basis).toBe('same_address')
    expect(link.address_match_evidence).toContain('22660 Highway 89')
  })

  it('moves the $2 platform fee to the leasing landlord when it links', async () => {
    const f = await twoLandlordsOnePlace()
    await linkAndActivate(f)
    const { rows: [sa] } = await db.query<any>(
      `SELECT superseded_by_lease_id FROM utility_service_agreements WHERE id=$1`,
      [f.agreementId])
    expect(sa.superseded_by_lease_id).toBe(f.leaseId)
  })

  // THE POINT OF THE WHOLE BUILD.
  it('one invoice to the tenant, and the utility money goes to the other landlord', async () => {
    const f = await twoLandlordsOnePlace()
    await linkAndActivate(f)

    await generateInvoices(new Date('2026-03-05T14:00:00Z'))

    // ONE invoice, from the LEASING landlord.
    const { rows: invs } = await db.query<any>(
      `SELECT id, landlord_id, total_amount::text AS total
         FROM invoices WHERE lease_id = $1`, [f.leaseId])
    expect(invs).toHaveLength(1)
    expect(invs[0].landlord_id).toBe(f.B.landlordId)
    expect(Number(invs[0].total)).toBe(975)     // $950 rent + $25 trash

    // Two rows on it, owned by two different landlords.
    const { rows: pays } = await db.query<any>(
      `SELECT type, amount::text AS amt, landlord_id, unit_id, lease_id
         FROM payments WHERE invoice_id = $1 ORDER BY type`, [invs[0].id])
    expect(pays).toHaveLength(2)

    const rent = pays.find((p: any) => p.type === 'rent')
    expect(Number(rent.amt)).toBe(950)
    expect(rent.landlord_id).toBe(f.B.landlordId)

    const util = pays.find((p: any) => p.type === 'utility')
    expect(Number(util.amt)).toBe(25)
    // The diversion: this row's money is the UTILITY landlord's.
    expect(util.landlord_id).toBe(f.A.landlordId)
    // It stays a fact about HIS space, not a bill against a unit he owns...
    expect(util.unit_id).toBe(f.servicedUnitId)
    // ...and it is NOT part of the other landlord's lease. Nic: "the utilities
    // are not tied to the lease from the landlord next door because they are
    // not part of that." The balance is scoped by INVOICE instead, which is how
    // the whole document still gets paid at once.
    expect(util.lease_id).toBeNull()
  })

  // The pay-in-full rule has to cover BOTH landlords' rows or it is not a
  // pay-in-full rule — it is a rule about one landlord that silently shorts
  // the other.
  it('the tenant balance is rent AND the neighbour utilities, together', async () => {
    const f = await twoLandlordsOnePlace()
    await linkAndActivate(f)
    await generateInvoices(new Date('2026-03-05T14:00:00Z'))

    const { fetchOutstandingRows } = await import('../services/rentCharge')
    const rows = await fetchOutstandingRows(f.tenantId, f.leaseId)
    const total = rows.reduce((s: number, r: any) => s + Number(r.amount), 0)

    expect(rows).toHaveLength(2)
    expect(total).toBe(975)            // $950 rent + $25 trash — one balance
    // Two landlords on one balance; paying it settles both.
    const landlords = new Set(rows.map((r: any) => r.landlord_id))
    expect(landlords.size).toBe(2)
    expect(landlords.has(f.A.landlordId)).toBe(true)
    expect(landlords.has(f.B.landlordId)).toBe(true)
  })

  // Nic: "we need to not allow partial payments at all... in the case of it
  // going to two different operators, how would you allocate that?" There is no
  // defensible answer, so the guard has to cover the WHOLE converged balance.
  it('a partial payment against a two-landlord balance is refused', async () => {
    const f = await twoLandlordsOnePlace()
    await linkAndActivate(f)
    await generateInvoices(new Date('2026-03-05T14:00:00Z'))

    // chargeLeaseBalance checks for a Stripe customer before it checks the
    // amount, so the fixture needs one to reach the pay-in-full guard.
    await db.query(`UPDATE tenants SET stripe_customer_id = 'cus_test' WHERE id = $1`,
      [f.tenantId])

    const { chargeLeaseBalance } = await import('../services/rentCharge')
    await expect(chargeLeaseBalance({
      tenantId: f.tenantId, leaseId: f.leaseId,
      amount: 950,                       // the rent, but not the neighbour's $25
      paymentMethodId: 'pm_test', paymentMethodType: 'ach', source: 'portal',
    })).rejects.toThrow(/paid in full/i)
  })

  it('the serviced space stops cutting its own invoice once linked', async () => {
    const f = await twoLandlordsOnePlace()
    await linkAndActivate(f)

    const res = await generateServiceAgreementInvoices(new Date('2026-03-05T14:00:00Z'))
    expect(res.invoicesInserted).toBe(0)
    const { rows } = await db.query(
      `SELECT id FROM invoices WHERE service_agreement_id = $1`, [f.agreementId])
    expect(rows).toHaveLength(0)
  })

  // Unlinked, it bills on its own exactly as S615 built it — the link is what
  // changes the behaviour, not the presence of a lease somewhere.
  it('without a link, both landlords bill separately as before', async () => {
    const f = await twoLandlordsOnePlace()

    await generateServiceAgreementInvoices(new Date('2026-03-05T14:00:00Z'))
    const { rows: own } = await db.query<any>(
      `SELECT total_amount::text AS total FROM invoices WHERE service_agreement_id = $1`,
      [f.agreementId])
    expect(own).toHaveLength(1)
    expect(Number(own[0].total)).toBe(25)

    await generateInvoices(new Date('2026-03-05T14:00:00Z'))
    const { rows: leaseInv } = await db.query<any>(
      `SELECT total_amount::text AS total FROM invoices WHERE lease_id = $1`, [f.leaseId])
    expect(Number(leaseInv[0].total)).toBe(950)   // rent only
  })

  it('refuses to link a unit that is not at the same place', async () => {
    const f = await twoLandlordsOnePlace()
    await db.query(
      `UPDATE properties SET street1='9 Elsewhere Rd', city='Toledo',
                             state='OH', zip='43606' WHERE id=$1`, [f.propB])
    await expect(proposeLink({
      serviceAgreementId: f.agreementId, unitId: f.leasedUnitId, via: 'proximity',
    })).rejects.toThrow(/not in the same town/i)
  })

  it('an admin can force a link the addresses could never show', async () => {
    const f = await twoLandlordsOnePlace()
    await db.query(
      `UPDATE properties SET street1='the blue house behind the shop' WHERE id=$1`,
      [f.propA])
    await db.query(
      `UPDATE utility_service_agreements SET service_address=NULL WHERE id=$1`,
      [f.agreementId])
    const link = await proposeLink({
      serviceAgreementId: f.agreementId, unitId: f.leasedUnitId,
      via: 'admin', force: true,
    })
    expect(link.status).toBe('active')
    expect(link.address_match_basis).toBe('none')
  })
})
