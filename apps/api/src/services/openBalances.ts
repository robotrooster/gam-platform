/**
 * S654 — WHO OWES WHAT, ONE DEFINITION.
 *
 * The front-desk Outstanding list (GET /api/balances) and the 7am overdue
 * digest must give the same answer. They did not: the digest summed RENT rows
 * only, so Oak Park's morning email said $2,860 overdue while $4,519.33 was
 * open — every September utility bill was missing, and a resident with two
 * spaces showed as two people.
 *
 * Outstanding = open invoice total (pending|partial) less money settled or in
 * flight, per space; one line per person; paid-ahead credit off first (it is
 * lease-bound), then landlord credit spent once per company, oldest bill first,
 * and only on the lease's own charges (S654: never a neighbor's utility on the
 * bill — the charge collects that in cash).
 */
import { allocateCredits } from '@gam/shared'
import { query, db } from '../db'
import { addDaysTo, todayIn } from '../lib/timezone'
import { prepaidPlan, fetchOutstandingRows, netLeaseGroups, type OpenChargeRow } from './rentCharge'

const cents = (n: number) => Math.round(n * 100) / 100

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
  /** Landlord credit taken off these bills or still on the account, plus the
   *  paid-ahead credit taken off these bills (S654). */
  credit_on_account: number
  /** S654: paid-ahead money still held for later bills — NOT taken off. */
  prepaid_held: number
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
  // A plain calendar date, so the cutoff never depends on the host clock.
  const dueOnOrBefore = opts.overdueDays != null
    ? addDaysTo(todayIn(null), -opts.overdueDays) : null
  const excludeBlocked = opts.excludePaymentBlocked === true

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
      i.landlord_id,
      u.unit_number,
      pr.id                                       AS property_id,
      pr.name                                     AS property_name,
      SUM(i.total_amount - COALESCE(pd.paid, 0))::float AS open_amount,
      COUNT(*)::int                               AS open_invoices,
      to_char(MIN(i.due_date), 'YYYY-MM-DD')      AS oldest_due_date,
      array_agg(i.id::text)                       AS invoice_ids,
      -- S654: what the landlord's credit may clear — the lease's own open
      -- rows on these bills (a neighbor's utility carries no lease).
      SUM(COALESCE(el.open, 0))::float            AS own_open
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
    LEFT JOIN (
      SELECT invoice_id, lease_id, SUM(amount) AS open
        FROM payments
       WHERE invoice_id IS NOT NULL AND work_trade_suspended_at IS NULL
         AND ((status = 'pending' AND stripe_payment_intent_id IS NULL) OR status = 'failed')
       GROUP BY invoice_id, lease_id
    ) el ON el.invoice_id = i.id AND el.lease_id = i.lease_id
    WHERE i.landlord_id = ANY($1::uuid[])
      AND i.status IN ('pending', 'partial')
      AND ($2::uuid[] IS NULL OR u.property_id = ANY($2::uuid[]))
      AND ($3::date IS NULL OR i.due_date <= $3::date)
      AND (NOT $4::boolean OR u.payment_block IS NOT TRUE)
    GROUP BY t.id, tu.first_name, tu.last_name, tu.phone, tu.email,
             i.lease_id, i.landlord_id, u.unit_number, pr.id, pr.name
    HAVING SUM(i.total_amount - COALESCE(pd.paid, 0)) > 0
  `, [landlordIds, propertyIds, dueOnOrBefore, excludeBlocked])

  const tenantIds = [...new Set(spaces.map(r => r.tenant_id))]
  // S637 (Nic): "It's a credit against the overall ledger." Read at its own
  // grain — per tenant, per lease tie — and never joined into the rows above.
  const credits = tenantIds.length ? await query<any>(`
    SELECT tenant_id, lease_id, landlord_id, SUM(amount_remaining)::float AS amount
      FROM tenant_credits
     WHERE tenant_id = ANY($1::uuid[]) AND landlord_id = ANY($2::uuid[])
       AND status = 'active' AND amount_remaining > 0
     GROUP BY tenant_id, lease_id, landlord_id`, [tenantIds, landlordIds]) : []

  // S654: paid-ahead credit, spent bill by bill (prepaidPlan) — the same takes
  // the charge settles. Only leases holding some are planned, so a portfolio
  // with none costs one query.
  const leaseIds = [...new Set(spaces.map(r => r.lease_id).filter(Boolean))] as string[]
  const prepaidHeld = new Map<string, number>()
  if (leaseIds.length) {
    const held = await query<{ lease_id: string; remaining: number }>(`
      SELECT lease_id, SUM(amount_remaining)::float AS remaining
        FROM lease_prepaid_credits
       WHERE lease_id = ANY($1::uuid[]) AND amount_remaining > 0
       GROUP BY lease_id`, [leaseIds])
    for (const h of held) prepaidHeld.set(h.lease_id, cents(Number(h.remaining)))
  }
  const prepaidOnBill = new Map<string, number>()
  const planned = new Set<string>()
  for (const r of spaces) {
    const key = `${r.tenant_id}:${r.lease_id}`
    if (!r.lease_id || !(prepaidHeld.get(r.lease_id)! > 0) || planned.has(key)) continue
    planned.add(key)
    const plan = await prepaidPlan(db, r.lease_id, await fetchOutstandingRows(r.tenant_id, r.lease_id))
    for (const t of plan.takes) prepaidOnBill.set(t.invoiceId, t.take)
  }

  const out: OpenTenantBalance[] = []
  for (const tenantId of tenantIds) {
    // S654: unit number breaks a same-day tie — every bill is due the 1st, and
    // a tie left "RV 35, RV 34" to whatever order the database returned.
    const mine = spaces.filter(r => r.tenant_id === tenantId)
      .sort((a, b) => String(a.oldest_due_date).localeCompare(String(b.oldest_due_date))
        || String(a.unit_number ?? '').localeCompare(String(b.unit_number ?? ''), undefined, { numeric: true }))

    // S654: paid-ahead first — what the charge would take off the bills on
    // this line (a bill belongs to one space, so nothing is counted twice).
    const prepaidOn = mine.map(r => cents(Math.min(r.open_amount,
      ((r.invoice_ids ?? []) as string[]).reduce((s, id) => s + (prepaidOnBill.get(id) ?? 0), 0))))

    // S654: each company's credit on its own bills only — an account with two
    // companies never takes one's general credit off the other's bill (the
    // charge never would). Capped at the lease's own open charges.
    const keyOf = (r: any, i: number) => r.lease_id || `space:${i}`
    const applied: Record<string, number> = {}
    let creditLeft = 0
    for (const landlordId of new Set(mine.map(r => r.landlord_id))) {
      const idx = mine.map((r, i) => (r.landlord_id === landlordId ? i : -1)).filter(i => i >= 0)
      const alloc = allocateCredits(
        credits.filter(c => c.tenant_id === tenantId && c.landlord_id === landlordId)
          .map(c => ({ leaseId: c.lease_id, amount: c.amount })),
        idx.map(i => ({ key: keyOf(mine[i], i), leaseId: mine[i].lease_id,
                        total: Math.max(0, cents(Math.min(mine[i].open_amount, mine[i].own_open) - prepaidOn[i])),
                        earliestDue: mine[i].oldest_due_date })))
      Object.assign(applied, alloc.applied)
      creditLeft += alloc.remaining
    }
    // A company with credit and no bill on this line still has it on account.
    creditLeft += credits.filter(c => c.tenant_id === tenantId && !mine.some(r => r.landlord_id === c.landlord_id))
      .reduce((s, c) => s + Number(c.amount), 0)
    const breakdown: OpenSpace[] = mine.map((r, i) => {
      const landlordCredit = applied[keyOf(r, i)] ?? 0
      const credit = prepaidOn[i] > 0 ? cents(landlordCredit + prepaidOn[i]) : landlordCredit
      return {
        lease_id: r.lease_id,
        unit_number: r.unit_number,
        property_id: r.property_id,
        property_name: r.property_name,
        open_amount: cents(r.open_amount),
        credit_applied: credit,
        balance: cents(r.open_amount - credit),
        open_invoices: r.open_invoices,
        oldest_due_date: r.oldest_due_date,
      }
    })
    const balance = cents(breakdown.reduce((s, x) => s + x.balance, 0))
    if (balance <= 0) continue
    // S654: paid-ahead money still held after these bills, once per lease. Kept
    // out of credit_on_account: the desk says "taken off" of that figure, and
    // with a $100 monthly draw on $1,000 held only $100 was.
    const prepaidStillHeld = [...new Set(mine.map(r => r.lease_id).filter(Boolean))]
      .reduce((s, leaseId) => {
        const usedHere = mine.reduce((u, r, i) => u + (r.lease_id === leaseId ? prepaidOn[i] : 0), 0)
        return s + Math.max(0, (prepaidHeld.get(leaseId) ?? 0) - usedHere)
      }, 0)
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
      // As before round 2 (landlord credit applied + left on the account), plus
      // the paid-ahead credit taken off these bills.
      credit_on_account: cents(breakdown.reduce((s, x) => s + x.credit_applied, 0) + creditLeft),
      prepaid_held: cents(prepaidStillHeld),
      open_invoices: mine.reduce((s, r) => s + r.open_invoices, 0),
      oldest_due_date: first.oldest_due_date,
      spaces: breakdown,
    })
  }
  return out
}

/** S654: one lease's open charges as the tenant sees them (gross, oldest first). */
export interface TenantLeaseGroup {
  leaseId: string | null
  landlordId: string
  outstanding: number
  rows: OpenChargeRow[]
}

export interface TenantLeaseNet {
  /** Paid-ahead credit taken off this lease's charges. */
  prepaidApplied: number
  /** The landlord's credit taken off what was left. */
  creditApplied: number
  /** Landlord credit still on the account after these bills (shown once per landlord). */
  creditRemaining: number
  /** What is owed now, never below zero. */
  outstanding: number
  /** S654: the pay floor — due now, net of both credits; the charge's own figure. */
  requiredNow: number
}

/**
 * S654: the tenant's own figure, ONE way — the portal (balance-context) and the
 * tenant agent both read this, so the agent never quotes $460 while the portal
 * and the bill email say $450. Paid-ahead first (it is lease-bound), then the
 * landlord's credit, spent once across that landlord's leases, oldest bill
 * first (S648), on each lease's own charges. The arithmetic is rentCharge's
 * netLease — the same the charge enforces — so the figure shown is the floor.
 */
export async function netTenantLeaseBalances(
  tenantId: string,
  groups: TenantLeaseGroup[],
): Promise<Map<string | null, TenantLeaseNet>> {
  const nets = await netLeaseGroups(db, tenantId, groups)
  const out = new Map<string | null, TenantLeaseNet>()
  groups.forEach((g, i) => {
    const n = nets[i]
    out.set(g.leaseId, {
      prepaidApplied: n.prepaid.total,
      creditApplied: n.landlordAll,
      creditRemaining: n.creditRemaining,
      outstanding: n.outstanding,
      requiredNow: n.requiredNow,
    })
  })
  return out
}
