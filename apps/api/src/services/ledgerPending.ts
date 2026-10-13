/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: WHICH TIE-OUT DIFFERENCES MEAN "STILL POSTING", NOT DRIFT
 *
 *   Nic: "within a minute (+ nightly tie-out check)"
 *
 * The nightly tie-outs (services/ledgerTenantChecks, ledgerDueFromGamCheck,
 * ledgerProjectors/payoutChecks) compare an account with the money records it
 * must equal. A difference while a record that posts to that account is still
 * waiting — an outbox row the drain has not reached, or a source failing or
 * waiting on the owner's choice — is the books being BEHIND ('pending'), not
 * wrong ('drift', which tells an admin). Design §8: "sources with pending
 * outbox entries are flagged, never counted as drift".
 *
 * 10/12 (Nic, ledger review): until now any waiting row of the company made
 * EVERY difference pending — including outbox rows of source types nothing
 * drains yet (expenses, other income, payroll: phases P6/P7), which never go
 * away, and records waiting on an owner's choice that post to some other
 * account. One edited expense hid every tie-out of its company for good. Now a
 * difference is pending only when a waiting source could post to THAT account:
 *
 *   - waiting = drainable outbox rows (the types the engine posts now, plus a
 *     moved books start's mark) and the source error records, of the company;
 *   - each check names the source types that post to its account (`types`),
 *     and, for a waiting bill row itself, which rows post there (`payment`) —
 *     e.g. 2050 only the prepaid move-in box, 2020 only deposit rows and bills
 *     the deposit paid, 1310 only home payments;
 *   - the receivables check (1100) is per tenant and property and the deposits
 *     GAM holds check (1070) per lease: there only the keys a waiting source
 *     touches are pending (loadPendingScope's tenantProperty / leases);
 *   - everything is pending while the company has no books start date, while a
 *     moved start date is being re-sorted, or while its opening posting (design
 *     J1, which carries every account) is waiting.
 * Read on the nightly check's REPEATABLE READ snapshot, like the checks.
 */
import type { PoolClient } from 'pg'
import { LEDGER_OUTBOX_BOOKS_START } from '@gam/shared'
import { drainableLedgerOutboxTypes } from './ledgerEngine'
import type { LedgerFindingSeverity } from './ledgerCheck'

/** SQL: the property of a payments row `p` (utility meter's, unit's, lease's) — the projectors' rule. */
export const PAYMENT_PROPERTY = `COALESCE(
  (SELECT um.property_id FROM utility_bills ub JOIN utility_meters um ON um.id = ub.meter_id WHERE ub.payment_id = p.id ORDER BY ub.created_at, ub.id LIMIT 1),
  (SELECT u.property_id FROM units u WHERE u.id = p.unit_id),
  (SELECT u2.property_id FROM leases l2 JOIN units u2 ON u2.id = l2.unit_id WHERE l2.id = p.lease_id))`

/** A waiting source of the company: in the outbox, or failing / waiting on the owner. */
export interface WaitingSource { type: string; id: string }

/** A bill row a waiting tenant-money source touches (the row itself, a receipt's, a credit's, a reversal's, a move-out balance). */
export interface WaitingPayment {
  id: string
  tenantId: string | null
  propertyId: string | null
  leaseId: string | null
  type: string
  revenueOwner: string | null
  status: string | null
  flexpay: boolean
}

export interface PendingScope {
  /** Every difference is pending (no books start, a moved start being re-sorted, the opening posting waiting). */
  everything: boolean
  sources: WaitingSource[]
  /** The rows waiting tenant-money sources touch, by id. */
  payments: Map<string, WaitingPayment>
  /** 'tenant|property' keys of those rows (the receivables check's keys). */
  tenantProperty: Set<string>
  /** Leases those rows, waiting deposit records and waiting move-outs belong to. */
  leases: Set<string>
}

/** Types whose waiting sources are resolved to the bill rows they touch. */
const ROW_TYPES = new Set(['payment', 'remittance', 'credit_use', 'payment_reversal', 'deposit_return'])

export async function loadPendingScope(client: PoolClient, landlordId: string): Promise<PendingScope> {
  const drainable = drainableLedgerOutboxTypes()
  const start = await client.query<{ has: boolean }>(
    `SELECT books_start_date IS NOT NULL AS has FROM landlords WHERE id = $1`, [landlordId])
  const w = (await client.query<{ t: string; id: string }>(
    `SELECT DISTINCT o.source_type AS t, o.source_id AS id FROM ledger_outbox o
      WHERE o.owner_id = $1 AND o.source_type = ANY($2::text[])
     UNION
     SELECT e.source_type, e.source_id FROM ledger_source_errors e WHERE e.owner_id = $1`, [landlordId, drainable])).rows
  const sources = w.map(x => ({ type: x.t, id: x.id }))
  const everything = !start.rows[0]?.has
    || sources.some(s => s.type === LEDGER_OUTBOX_BOOKS_START || (s.type === 'opening' && s.id === landlordId))

  const payments = new Map<string, WaitingPayment>()
  const tenantProperty = new Set<string>()
  const leases = new Set<string>()
  if (sources.some(s => ROW_TYPES.has(s.type) || s.type === 'security_deposit')) {
    const rows = (await client.query<{
      id: string; tenant_id: string | null; property_id: string | null; lease_id: string | null; type: string
      revenue_owner: string | null; status: string | null; flexpay: boolean
    }>(
      `WITH w(t, id) AS (SELECT * FROM unnest($1::text[], $2::text[])),
       pids AS (
         SELECT p.id FROM payments p JOIN w ON w.t = 'payment' AND w.id = p.id::text
         UNION SELECT ra.payment_id FROM remittance_applications ra JOIN w ON w.t = 'remittance' AND w.id = ra.remittance_id::text
         UNION SELECT cu.payment_id FROM credit_uses cu JOIN w ON w.t = 'credit_use' AND w.id = cu.id::text WHERE cu.payment_id IS NOT NULL
         UNION SELECT pr.payment_id FROM payment_reversals pr JOIN w ON w.t = 'payment_reversal' AND w.id = pr.id::text WHERE pr.payment_id IS NOT NULL
         UNION SELECT np.id FROM payment_reversals pr JOIN payments np ON np.reversal_id = pr.id
                JOIN w ON w.t = 'payment_reversal' AND w.id = pr.id::text
         UNION SELECT d.gap_payment_id FROM deposit_returns d JOIN w ON w.t = 'deposit_return' AND w.id = d.id::text
                WHERE d.gap_payment_id IS NOT NULL)
       SELECT p.id::text, p.tenant_id::text, (${PAYMENT_PROPERTY})::text AS property_id, p.lease_id::text, p.type,
              p.revenue_owner, p.status, p.flexpay_advance_id IS NOT NULL AS flexpay
         FROM payments p WHERE p.id IN (SELECT id FROM pids)`,
      [sources.map(s => s.type), sources.map(s => s.id)])).rows
    for (const r of rows) {
      payments.set(r.id, {
        id: r.id, tenantId: r.tenant_id, propertyId: r.property_id, leaseId: r.lease_id, type: r.type,
        revenueOwner: r.revenue_owner, status: r.status, flexpay: r.flexpay,
      })
      tenantProperty.add(`${r.tenant_id ?? ''}|${r.property_id ?? ''}`)
      if (r.lease_id) leases.add(r.lease_id)
    }
    const other = (await client.query<{ lease_id: string }>(
      `WITH w(t, id) AS (SELECT * FROM unnest($1::text[], $2::text[]))
       SELECT sd.lease_id::text AS lease_id FROM security_deposits sd JOIN w ON w.t = 'security_deposit' AND w.id = sd.id::text
       UNION SELECT d.lease_id::text FROM deposit_returns d JOIN w ON w.t = 'deposit_return' AND w.id = d.id::text`,
      [sources.map(s => s.type), sources.map(s => s.id)])).rows
    for (const r of other) if (r.lease_id) leases.add(r.lease_id)
  }
  return { everything, sources, payments, tenantProperty, leases }
}

/**
 * What posts to one account: the source types (`types`) and, for a waiting
 * bill row ('payment' source), which rows do (`payment`; absent = any).
 */
export interface PendingRule {
  types: readonly string[]
  payment?: (p: WaitingPayment) => boolean
}

/** Is a waiting source posting to this account? (`skip`: waiting sources the check leaves out of both sides.) */
export function waitingFor(scope: PendingScope, rule: PendingRule, skip?: (s: WaitingSource) => boolean): boolean {
  if (scope.everything) return true
  for (const s of scope.sources) {
    if (!rule.types.includes(s.type)) continue
    if (skip?.(s)) continue
    // A waiting bill row counts only when it is a row that posts here (a
    // receipt, a credit or a reversal touching it counts by its own type).
    if (rule.payment && s.type === 'payment') {
      const p = scope.payments.get(s.id)
      if (p && !rule.payment(p)) continue
    }
    return true
  }
  return false
}

export function severityOf(waiting: boolean): LedgerFindingSeverity {
  return waiting ? 'pending' : 'drift'
}
