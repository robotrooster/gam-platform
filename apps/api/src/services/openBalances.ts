/**
 * S654 — WHO OWES WHAT, ONE DEFINITION.
 *
 * The front-desk Outstanding list (GET /api/balances) and the 7am overdue
 * digest must give the same answer. They did not: the digest summed RENT rows
 * only, so Oak Park's morning email said $2,860 overdue while $4,519.33 was
 * open — every September utility bill was missing, and a resident with two
 * spaces showed as two people.
 *
 * This is the Outstanding list's own per-person math, lifted out of
 * routes/balances.ts unchanged so both read it: open invoice total
 * (pending|partial) less money settled or in flight, per space; one line per
 * person; landlord credit spent once, oldest bill first. With no filter it
 * returns exactly what the list always showed.
 */
import { allocateCredits } from '@gam/shared'
import { query } from '../db'
import { addDaysTo, todayIn } from '../lib/timezone'

export interface OpenSpace {
  lease_id: string | null
  unit_number: string | null
  property_id: string | null
  property_name: string | null
  open_amount: number
  credit_applied: number
  balance: number
  open_invoices: number
  oldest_due_date: string
}

export interface OpenTenantBalance {
  tenant_id: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  email: string | null
  unit_number: string | null
  property_id: string | null
  property_ids: string[]
  property_name: string | null
  balance: string
  credit_on_account: number
  open_invoices: number
  oldest_due_date: string
  spaces: OpenSpace[]
}

export interface OpenBalanceFilter {
  /** The account's companies. Required — there is no default company. */
  landlordIds: string[]
  /** A property-locked worker's scope; null = every property. */
  propertyIds?: string[] | null
  /** Only bills due this many days ago or earlier (GAM's Phoenix calendar). */
  overdueDays?: number | null
  /** Leave out units in eviction mode — no one should be chased for those. */
  excludePaymentBlocked?: boolean
}

export async function listOpenTenantBalances(opts: OpenBalanceFilter): Promise<OpenTenantBalance[]> {
  const { landlordIds } = opts
  if (!landlordIds.length) return []
  const propertyIds = opts.propertyIds ?? null

  // S654: the digest's two filters. Added only when asked for, so the list's
  // own query is exactly the one it always ran. The cutoff is a plain calendar
  // date, so it never depends on the host clock.
  const params: unknown[] = [landlordIds, propertyIds]
  let filters = ''
  if (opts.overdueDays != null) {
    params.push(addDaysTo(todayIn(null), -opts.overdueDays))
    filters += `\n        AND i.due_date <= $${params.length}::date`
  }
  if (opts.excludePaymentBlocked === true) {
    filters += `\n        AND u.payment_block IS NOT TRUE`
  }

  // ── S648 (Nic): ONE LINE PER PERSON, AND EVERY DOLLAR COUNTED ONCE ──────
  //
  // Billy Jose Miranda rents RV 34 and RV 35 and showed as two people owing
  // $457.07 and $470.22. Grouping by tenant AND unit also subtracted his
  // account credit once per space — a $100 credit took $200 off. "Every
  // dollar should only be counted once. Everywhere."
  //
  // So: what is open is summed per space here, the credit is read once per
  // tenant below, and allocateCredits spends it once, oldest bill first.
  const spaces = await query<any>(`
      SELECT
        t.id                                        AS tenant_id,
        tu.first_name, tu.last_name, tu.phone, tu.email,
        i.lease_id,
        u.unit_number,
        pr.id                                       AS property_id,
        pr.name                                     AS property_name,
        SUM(i.total_amount - COALESCE(pd.paid, 0))::float AS open_amount,
        COUNT(*)::int                               AS open_invoices,
        to_char(MIN(i.due_date), 'YYYY-MM-DD')      AS oldest_due_date
      FROM invoices i
      JOIN tenants t          ON t.id  = i.tenant_id
      LEFT JOIN users tu      ON tu.id = t.user_id
      LEFT JOIN units u       ON u.id  = i.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
      LEFT JOIN (
        SELECT invoice_id, SUM(amount) AS paid
          FROM payments
         -- S637 (Nic): money in flight is not outstanding — an ACH debit sits
         -- 'processing' ~4 business days; a failure flips it back to owed.
         -- S638 (Nic): work trade is not an outstanding balance. S654: a
         -- suspended line is written OUTSIDE total_amount by every bill writer
         -- (the S634 shape), so it is not netted again here — doing so drove
         -- RV 50 and RV 51 to -$589 and hid two October bills behind their
         -- September. A month-close deficit bills unsuspended and lands here.
         WHERE status IN ('settled', 'processing')
           AND invoice_id IS NOT NULL
         GROUP BY invoice_id
      ) pd ON pd.invoice_id = i.id
      WHERE i.landlord_id = ANY($1::uuid[])
        AND i.status IN ('pending', 'partial')
        AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))${filters}
      GROUP BY t.id, tu.first_name, tu.last_name, tu.phone, tu.email,
               i.lease_id, u.unit_number, pr.id, pr.name
      HAVING SUM(i.total_amount - COALESCE(pd.paid, 0)) > 0
    `, params)

  const tenantIds = [...new Set(spaces.map(r => r.tenant_id))]
  // S637 (Nic): "It's a credit against the overall ledger." Read at its own
  // grain — per tenant, per lease tie — and never joined into the rows above.
  const credits = tenantIds.length ? await query<any>(`
      SELECT tenant_id, lease_id, SUM(amount_remaining)::float AS amount
        FROM tenant_credits
       WHERE tenant_id = ANY($1::uuid[]) AND landlord_id = ANY($2::uuid[])
         AND status = 'active' AND amount_remaining > 0
       GROUP BY tenant_id, lease_id`, [tenantIds, landlordIds]) : []

  const out: OpenTenantBalance[] = []
  for (const tenantId of tenantIds) {
    const mine = spaces.filter(r => r.tenant_id === tenantId)
      .sort((a, b) => String(a.oldest_due_date).localeCompare(String(b.oldest_due_date)))
    const keyOf = (r: any, i: number) => r.lease_id || `space:${i}`
    const alloc = allocateCredits(
      credits.filter(c => c.tenant_id === tenantId).map(c => ({ leaseId: c.lease_id, amount: c.amount })),
      mine.map((r, i) => ({ key: keyOf(r, i), leaseId: r.lease_id, total: r.open_amount, earliestDue: r.oldest_due_date })))
    const breakdown: OpenSpace[] = mine.map((r, i) => {
      const credit = alloc.applied[keyOf(r, i)] ?? 0
      return {
        lease_id: r.lease_id,
        unit_number: r.unit_number,
        property_id: r.property_id,
        property_name: r.property_name,
        open_amount: Math.round(r.open_amount * 100) / 100,
        credit_applied: credit,
        balance: Math.round((r.open_amount - credit) * 100) / 100,
        open_invoices: r.open_invoices,
        oldest_due_date: r.oldest_due_date,
      }
    })
    const balance = Math.round(breakdown.reduce((s, x) => s + x.balance, 0) * 100) / 100
    if (balance <= 0) continue
    const first = mine[0]
    const uniq = (xs: any[]) => [...new Set(xs.filter(Boolean))]
    out.push({
      tenant_id: tenantId,
      first_name: first.first_name, last_name: first.last_name,
      phone: first.phone, email: first.email,
      // Joined for the screens that print one line ("RV 34, RV 35").
      unit_number: uniq(mine.map(r => r.unit_number)).join(', ') || null,
      property_id: first.property_id,
      property_ids: uniq(mine.map(r => r.property_id)),
      property_name: uniq(mine.map(r => r.property_name)).join(', ') || null,
      balance: balance.toFixed(2),
      credit_on_account: Math.round(
        breakdown.reduce((s, x) => s + x.credit_applied, 0) * 100 + alloc.remaining * 100) / 100,
      open_invoices: mine.reduce((s, r) => s + r.open_invoices, 0),
      oldest_due_date: first.oldest_due_date,
      spaces: breakdown,
    })
  }
  return out
}
