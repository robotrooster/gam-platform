// 10/27 (Nic) — HIS FLOWCHART, AS TESTS.
//
//   "This month coming up, do we have tenants moving out? Okay, do they have
//    deposits that GAM holds? If yes, what is the total we're holding, and
//    what is the total amount funded, or that the landlord is owed? And is
//    there a difference? If there's a difference, what is that difference?
//    That's how much cash we potentially need that month. If there's no
//    tenants scheduled to move out that month, that's it. It just, the flow
//    chart stops right there."
//
// And the scope rule, which is most of the value here:
//
//   "for all of these people where we're not even holding the deposit, none of
//    that data matters... The data on other people moving out doesn't matter if
//    we don't have the deposit."
//
// So the two exclusions below are the heart of the tests: a rent-to-own end
// date is a purchase installment and not a departure, and a tenant-owned
// dwelling does not end on its end date at all. Both would otherwise put money
// in a month where no deposit is ever returned.

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { flexDepositExposure, flexDepositReserve } from './flexDepositExposure'
import {
  cleanupAllSchema,
  seedLandlord, seedTenant, seedProperty, seedUnit, seedLease,
} from '../test/dbHelpers'

interface Opts {
  /** null = month-to-month, no end date. */
  endDate?: string | null
  total?: number
  collected?: number
  /** FALSE makes it an ordinary deposit GAM is not holding under a plan. */
  flex?: boolean
  planStatus?: 'active' | 'completed'
  dwelling?: 'landlord' | 'tenant'
  /** Attach an active rent-to-own contract, making the end date a payoff date. */
  homeSale?: boolean
  leaseStatus?: 'active' | 'pending' | 'expired'
  noticeRecorded?: boolean
}

async function departing(o: Opts = {}): Promise<void> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: ownerUserId, landlordId } = await seedLandlord(client)
    const tenantId = await seedTenant(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId, managedByUserId: ownerUserId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
    await client.query(`UPDATE units SET dwelling_ownership = $2 WHERE id = $1`,
      [unitId, o.dwelling ?? 'landlord'])
    const leaseId = await seedLease(client, {
      unitId, landlordId, rentAmount: 1000,
      status: o.leaseStatus ?? 'active',
      leaseType: o.endDate === undefined || o.endDate === null ? 'month_to_month' : 'fixed_term',
    })
    await client.query(
      `UPDATE leases SET end_date = $2::date, move_out_notice_at = $3 WHERE id = $1`,
      [leaseId, o.endDate ?? null, o.noticeRecorded ? new Date().toISOString() : null])
    if (o.homeSale) {
      await client.query(
        `INSERT INTO home_sale_contracts
           (unit_id, lease_id, tenant_id, landlord_id, sale_price, down_payment,
            financed_amount, annual_interest_rate, term_months, monthly_payment,
            start_month, status, installments_total)
         VALUES ($1, $2, $3, $4, 30000, 0, 30000, 0, 120, 250,
                 CURRENT_DATE, 'active', 120)`,
        [unitId, leaseId, tenantId, landlordId])
    }
    await client.query(
      `INSERT INTO security_deposits
         (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by,
          flex_deposit_enabled, flex_deposit_plan_status)
       VALUES ($1, $2, $3, $4, $5, 'partial', 'gam_escrow', $6, $7)`,
      [unitId, leaseId, tenantId,
       (o.total ?? 1000).toFixed(2), (o.collected ?? 250).toFixed(2),
       o.flex ?? true, (o.flex ?? true) ? (o.planStatus ?? 'active') : null])
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

/** A month a few ahead of today, as YYYY-MM-DD, so the horizon includes it. */
function monthsOut(n: number): string {
  const d = new Date()
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 15))
  return t.toISOString().slice(0, 10)
}

beforeEach(cleanupAllSchema)

describe('the flowchart stops at the first empty step', () => {
  it('answers a true $0 with no deposits in custody at all', async () => {
    const e = await flexDepositExposure()
    // Called as a service, so these are the service's own snake_case keys.
    // The admin client camelizes over the wire; that is the route's contract,
    // not this one's.
    expect(e.custody_plans).toBe(0)
    expect(e.custody_unfunded).toBe(0)
    expect(e.months).toEqual([])
    expect(e.peak_month).toBeNull()
    expect(e.cash_required).toBe(0)
  })

  it('ignores a move-out whose deposit GAM is not holding', async () => {
    // His rule: "The data on other people moving out doesn't matter if we
    // don't have the deposit."
    await departing({ flex: false, endDate: monthsOut(1) })
    const e = await flexDepositExposure()
    expect(e.custody_plans).toBe(0)
    expect(e.months).toEqual([])
    expect(e.cash_required).toBe(0)
  })

  it('counts a plan with nobody scheduled to leave, but needs no cash for a month', async () => {
    await departing({ endDate: null })
    const e = await flexDepositExposure()
    expect(e.custody_plans).toBe(1)
    expect(e.custody_unfunded).toBe(750)
    // Nobody is on the calendar...
    expect(e.months).toEqual([])
    expect(e.peak_month).toBeNull()
    // ...but a month-to-month resident can leave on a few days' notice, so the
    // one-surprise allowance is what has to be standing by.
    expect(e.unscheduled_plans).toBe(1)
    expect(e.unexpected_allowance).toBe(750)
    expect(e.cash_required).toBe(750)
  })
})

describe('a scheduled departure with a deposit in custody', () => {
  it('reports owed, funded and the difference for that month', async () => {
    const end = monthsOut(2)
    await departing({ endDate: end, total: 1000, collected: 250 })
    const e = await flexDepositExposure()
    expect(e.months).toHaveLength(1)
    const m = e.months[0]
    expect(m.month).toBe(end.slice(0, 7))
    expect(m.owed).toBe(1000)      // the landlord's books read the whole deposit
    expect(m.funded).toBe(250)     // what the resident actually paid in
    expect(m.cash_needed).toBe(750) // the difference — GAM's cash that month
    expect(e.peak_month).toEqual({ month: end.slice(0, 7), cash_needed: 750 })
  })

  it('needs no cash when the resident funded the whole thing', async () => {
    await departing({ endDate: monthsOut(1), total: 1000, collected: 1000 })
    const e = await flexDepositExposure()
    expect(e.months[0].cash_needed).toBe(0)
    // A month that needs nothing is not the peak.
    expect(e.peak_month).toBeNull()
    expect(e.cash_required).toBe(0)
  })

  it('names the heaviest month as the peak, not the first or the last', async () => {
    await departing({ endDate: monthsOut(1), total: 500, collected: 250 })   // 250
    await departing({ endDate: monthsOut(2), total: 2000, collected: 250 })  // 1750
    await departing({ endDate: monthsOut(3), total: 800, collected: 300 })   // 500
    const e = await flexDepositExposure()
    expect(e.months).toHaveLength(3)
    expect(e.peak_month?.month).toBe(monthsOut(2).slice(0, 7))
    expect(e.peak_month?.cash_needed).toBe(1750)
  })

  it('sums several departures inside one month', async () => {
    const end = monthsOut(2)
    await departing({ endDate: end, total: 1000, collected: 250 })
    await departing({ endDate: end, total: 600, collected: 100 })
    const e = await flexDepositExposure()
    expect(e.months).toHaveLength(1)
    expect(e.months[0].departures).toHaveLength(2)
    expect(e.months[0].cash_needed).toBe(1250)
  })
})

describe('the two end dates that are not departures', () => {
  it('leaves a rent-to-own payoff date out of the calendar', async () => {
    // Nine of the ten end-dated active leases in production are these, running
    // to 2033. Their end date is a final purchase installment, and no deposit
    // is ever returned on it.
    await departing({ endDate: monthsOut(3), homeSale: true })
    const e = await flexDepositExposure()
    expect(e.custody_plans).toBe(1)
    expect(e.months).toEqual([])
    // It is not forgotten — it falls into the unscheduled bucket, where an
    // actual departure would still be covered.
    expect(e.unscheduled_plans).toBe(1)
  })

  it('leaves a tenant-owned dwelling out of the calendar', async () => {
    // The nightly job wipes the end date and flips the lease to month-to-month
    // for these: nothing vacates and no deposit return is cut. The resident
    // owns the home and rents the ground under it.
    await departing({ endDate: monthsOut(3), dwelling: 'tenant' })
    const e = await flexDepositExposure()
    expect(e.custody_plans).toBe(1)
    expect(e.months).toEqual([])
    expect(e.unscheduled_plans).toBe(1)
  })

  it('still counts a CANCELLED rent-to-own, because that is a tenancy again', async () => {
    const end = monthsOut(2)
    await departing({ endDate: end, homeSale: true })
    await db.query(`UPDATE home_sale_contracts SET status = 'cancelled'`)
    const e = await flexDepositExposure()
    expect(e.months).toHaveLength(1)
    expect(e.months[0].month).toBe(end.slice(0, 7))
  })
})

describe('what is not in custody', () => {
  it('ignores a completed plan, which is fully funded and risk-free', async () => {
    await departing({ endDate: monthsOut(1), planStatus: 'completed', collected: 1000 })
    const e = await flexDepositExposure()
    expect(e.custody_plans).toBe(0)
    expect(e.cash_required).toBe(0)
  })

  it('never reports a negative unfunded figure when routing over-collected', async () => {
    // GAM-first routing raises collected_amount with no clamp, unlike its three
    // sibling writers, so it can exceed the total. A bare subtraction would
    // read as negative exposure and quietly offset somebody else's real gap.
    await departing({ endDate: monthsOut(1), total: 500, collected: 900 })
    const e = await flexDepositExposure()
    expect(e.custody_unfunded).toBe(0)
    expect(e.months[0].cash_needed).toBe(0)
  })

  it('leaves a resident who already gave notice out of the surprise allowance', async () => {
    // They are on the calendar, so counting them as a surprise too would
    // reserve the same dollars twice.
    await departing({ endDate: monthsOut(1), noticeRecorded: true })
    const e = await flexDepositExposure()
    expect(e.unexpected_allowance).toBe(0)
    expect(e.cash_required).toBe(e.peak_month?.cash_needed ?? 0)
  })
})

describe('the reserve', () => {
  it('is $0 before any FlexDeposit fee is booked', async () => {
    expect(await flexDepositReserve()).toBe(0)
  })

  it('is fees banked less shortfalls paid, and nothing else GAM earns', async () => {
    await db.query(
      `INSERT INTO platform_revenue_ledger (type, amount, balance_after)
       VALUES ('flexdeposit_fee', 67, 67),
              ('flexdeposit_shortfall', -250, -183),
              ('flexdeposit_recovery', 100, -83),
              -- Real income, but not standing behind this product. Letting it
              -- in would let the ceiling rise on money meant for something else.
              ('screening_margin', 46.03, -37)`)
    expect(await flexDepositReserve()).toBe(-83)
  })

  it('reports headroom against what the months actually need', async () => {
    await db.query(
      `INSERT INTO platform_revenue_ledger (type, amount, balance_after)
       VALUES ('flexdeposit_fee', 1000, 1000)`)
    await departing({ endDate: monthsOut(1), total: 1000, collected: 250 })
    const e = await flexDepositExposure()
    expect(e.reserve).toBe(1000)
    expect(e.cash_required).toBe(750)
    expect(e.headroom).toBe(250)
  })
})
