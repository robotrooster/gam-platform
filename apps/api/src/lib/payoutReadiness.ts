/**
 * Can GAM pay this account's rent out? One answer for every place that asks.
 *
 * 10/12 (Nic): Blu co-owns Oak Park (payouts live) and owns TruBlu Management
 * LLC, which holds Country Acres and has no Stripe account at all. Every
 * readiness check asked "can ANY company in scope be paid?", so Oak Park
 * answered for TruBlu: the to-do list never said "Set up payouts", the agent
 * said he was set up, and Country Acres' rent had nowhere to go.
 *
 * THE RULE. Ready = every company in scope that has a property can be paid.
 * When no company has a property yet, ready = any company can be paid — that
 * keeps S620's case quiet: a co-owner of a funded company carries the empty
 * company registration gave them, and there is no money in it to route.
 * A company with no properties and no payouts is never the reason for a nag.
 *
 * Reads the cached landlords.connect_payouts_enabled, kept current by the
 * account.updated webhook and the status endpoint's sync.
 */
import { query } from '../db'

export interface UnpaidCompany {
  id: string
  businessName: string | null
}

export interface PayoutReadiness {
  /** Rent for every property in scope can be paid out. */
  ready: boolean
  /** Companies with at least one property whose payouts are not live. */
  unpaid: UnpaidCompany[]
}

interface Row {
  id: string
  business_name: string | null
  payouts: boolean
  has_property: boolean
}

export async function payoutReadiness(landlordIds: string[]): Promise<PayoutReadiness> {
  if (landlordIds.length === 0) return { ready: false, unpaid: [] }
  const rows = await query<Row>(
    `SELECT l.id, l.business_name,
            COALESCE(l.connect_payouts_enabled, FALSE) AS payouts,
            EXISTS (SELECT 1 FROM properties p WHERE p.landlord_id = l.id) AS has_property
       FROM landlords l
      WHERE l.id = ANY($1::uuid[])
      ORDER BY l.created_at, l.id`,
    [landlordIds])
  const unpaid = rows
    .filter((r) => r.has_property && !r.payouts)
    .map((r) => ({ id: r.id, businessName: r.business_name }))
  const anyPaid = rows.some((r) => r.payouts)
  // With a property somewhere, "nothing unpaid" already implies one is paid;
  // with none, it falls back to "any company can be paid".
  return { ready: unpaid.length === 0 && anyPaid, unpaid }
}
