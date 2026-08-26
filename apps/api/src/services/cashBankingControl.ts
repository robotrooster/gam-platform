// S624 — did the office bank what it collected?
//
// Nic (S624): "a landlord would mark each one paid as they collect the rent in
// person in the office, and then the bulk deposit would be sorted and verified
// against those ones that were marked paid in person. It needs a double
// verification."
//
// This is worth more than the reconciliation time it saves. On-site staff take
// cash and mark each tenant paid; the deposit posts days later; nobody has ever
// been able to check the two against each other without doing it by hand. A
// property collecting $3,000 and banking $2,750 leaves a $250 gap WITH NAMES
// ATTACHED — the specific rents that were marked collected and never reached the
// bank. For an owner running a park through staff, that control has simply not
// existed.
//
// It reports; it never accuses and never reverses anything. Cash legitimately
// sits in a drawer over a weekend, and a deposit legitimately spans two days of
// collection. The output is "here is what is outstanding and for how long",
// which is a question a human should answer.

import { query } from '../db'
import { DateTime } from 'luxon'

export interface UnbankedCollection {
  paymentId: string
  tenantName: string
  unitNumber: string
  amount: number
  collectedOn: string
  daysOutstanding: number
  method: string
}

export interface CashBankingPosition {
  /** Rents marked collected in person that no bank deposit has accounted for. */
  unbanked: UnbankedCollection[]
  unbankedTotal: number
  /** The oldest gap, in days. The number that actually matters. */
  oldestDays: number
  /**
   * Deposits in the window that no charge was matched to — the other side of
   * the same question. Money arrived that nobody has attributed.
   */
  unattributedDeposits: number
  unattributedTotal: number
}

/**
 * Where a landlord's cash stands right now.
 *
 * `graceDays` exists because same-day banking is not the standard anyone works
 * to — an office collecting on the 1st and banking on the 3rd is normal, and
 * flagging that as a discrepancy would train people to ignore the report. Only
 * what is older than the grace shows up.
 */
export async function cashBankingPosition(
  landlordId: string, opts: { graceDays?: number; asOf?: string } = {},
): Promise<CashBankingPosition> {
  const grace = opts.graceDays ?? 3
  const asOf = opts.asOf ?? DateTime.now().setZone('America/Phoenix').toISODate()!

  const unbanked = await query<any>(
    `SELECT p.id,
            TRIM(COALESCE(usr.first_name,'') || ' ' || COALESCE(usr.last_name,''))
              AS tenant_name,
            u.unit_number,
            p.amount::float AS amount,
            to_char(p.settled_at,'YYYY-MM-DD') AS collected_on,
            ($2::date - p.settled_at::date)::int AS days_outstanding,
            p.manual_method
       FROM payments p
       JOIN units u ON u.id = p.unit_id
       JOIN tenants t ON t.id = p.tenant_id
       JOIN users usr ON usr.id = t.user_id
      WHERE p.landlord_id = $1
        AND p.status = 'settled'
        AND p.manual_method IS NOT NULL
        -- The whole test: marked collected, no deposit ever accounted for it.
        AND NOT EXISTS (SELECT 1 FROM bank_deposit_allocations a
                         WHERE a.payment_id = p.id)
        AND p.settled_at::date <= ($2::date - $3::int)
        -- A year back is plenty; older than that is a books problem, not a
        -- banking one, and dragging it into this report would bury the signal.
        AND p.settled_at::date >= ($2::date - 365)
      ORDER BY p.settled_at`,
    [landlordId, asOf, grace])

  const rows: UnbankedCollection[] = unbanked.map((r: any) => ({
    paymentId: r.id, tenantName: r.tenant_name || 'Tenant',
    unitNumber: r.unit_number, amount: Number(r.amount),
    collectedOn: r.collected_on, daysOutstanding: Number(r.days_outstanding),
    method: r.manual_method,
  }))

  const other = await query<{ n: string; total: string }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0)::text AS total
       FROM bank_transactions
      WHERE landlord_id = $1 AND amount > 0 AND status = 'needs_review'
        AND posted_date >= ($2::date - 90)`,
    [landlordId, asOf])

  return {
    unbanked: rows,
    unbankedTotal: Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100,
    oldestDays: rows.length ? Math.max(...rows.map(r => r.daysOutstanding)) : 0,
    unattributedDeposits: parseInt(other[0]?.n ?? '0', 10),
    unattributedTotal: Math.round(Number(other[0]?.total ?? 0) * 100) / 100,
  }
}
