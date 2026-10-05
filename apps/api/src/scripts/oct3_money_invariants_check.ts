/**
 * S655 money plan P10 — the money invariants, over all of production.
 * READ-ONLY: one BEGIN READ ONLY transaction, rolled back. Writes nothing.
 *
 *   I1  every credit: amount_original = amount_remaining + Σ uses held/applied
 *   I2  payments.issued_credit_amount = Σ applied landlord-issued uses
 *       (deposit interest excluded: GAM funds it)
 *   I3  every settled receipt: amount = Σ applications + unapplied_amount, and
 *       no application is more than its row's money part (the rest of the row
 *       was paid by credit, not by this receipt)
 *   I4  money_part ≥ 0 (credit never pays more than a charge)
 *   I5  the owner share booked on a row ≤ what GAM held for the landlord on
 *       it when it settled, less the parts the landlord never receives (GAM-
 *       first money, payments.gam_supersedence_amount, and a sublease markup)
 *       — an UPPER BOUND on the room allocation books from, so only money GAM
 *       holds is ever paid out. It is looser than allocation by a landlord-
 *       paid processing fee (allocation also takes that off what GAM holds):
 *       who paid the fee is not stamped on the row (the property's rule can
 *       change after), so subtracting it here could flag a correct row; a
 *       share over-booked by no more than that fee passes. A disputed or
 *       returned row reads gam_held_part 0 now, so it is measured by what GAM held when it settled (its GAM-funded
 *       credit plus the money Stripe or the FlexPay float paid it). What the
 *       landlord gives back after a dispute (withheld, netted, pulled) is the
 *       recovery's job, tracked on payment_reversals; a recovery still pending
 *       is not a booking error, and recovered money is never subtracted here
 *       (it includes GAM-first money that was never the landlord's).
 *   I6  no live credit use on a charge credit may not pay
 *   I7  every settled landlord charge with money on it is backed by a receipt
 *       (or a named non-receipt source: a prior arrangement, a matched bank
 *       deposit, a FlexPay cover, the deposit at move-out), so money in ties to
 *       the rows it paid. The Reports tie-out (each "Money received" line equal
 *       to its source ledger) is Step 16's; this is the ledger half.
 *   I8  every unpaid owner share points at a settled row with platform_held
 *       (else the Tuesday batch strands it, or pays money GAM never held)
 *   I9  no credit held more than 10 days without a scheduled or in-flight retry
 * Plus: the units whose delinquency flips under M6 (saved credit no longer
 * masks late rent), so the deploy review sees them before the next payment
 * change flips them.
 *
 * Run (after the M1–M12 migrations):
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/oct3_money_invariants_check.ts
 * Exit code 1 when any invariant has a violation. Runs again the night before
 * the first Tuesday payout.
 */
import type { PoolClient } from 'pg'

export const INVARIANT_IDS = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9'] as const
export type InvariantId = typeof INVARIANT_IDS[number]

export const INVARIANT_LABEL: Record<InvariantId, string> = {
  I1: 'Every credit adds up: original = remaining + held and spent',
  I2: "Each charge's landlord-issued credit matches its spends",
  I3: 'Every settled receipt adds up to the rows it paid plus what it banked',
  I4: 'Credit never pays more than a charge',
  I5: 'Owner shares never exceed the money GAM held for the landlord on the row',
  I6: 'No credit sits on a charge credit may not pay',
  I7: 'Every charge with money on it is backed by a receipt',
  I8: 'Every unpaid owner share is on a settled, GAM-held charge',
  I9: 'No credit held more than 10 days without a retry',
}

export interface InvariantResult {
  id: InvariantId
  label: string
  violations: number
  /** Up to 50 examples. */
  sample: Record<string, unknown>[]
}

export interface InvariantReport {
  ok: boolean
  results: InvariantResult[]
  delinquencyFlips?: { count: number; units: Record<string, unknown>[] }
}

/** Each check: SQL returning one row per violation. */
const CHECKS: Record<InvariantId, string> = {
  I1: `
    WITH c AS (
      SELECT 'issued' AS kind, tc.id, tc.amount_original, tc.amount_remaining,
             COALESCE((SELECT SUM(u.amount) FROM credit_uses u
                        WHERE u.tenant_credit_id = tc.id AND u.status IN ('held','applied')), 0) AS live
        FROM tenant_credits tc
      UNION ALL
      SELECT 'paid_ahead', pc.id, pc.amount_original, pc.amount_remaining,
             COALESCE((SELECT SUM(u.amount) FROM credit_uses u
                        WHERE u.prepaid_credit_id = pc.id AND u.status IN ('held','applied')), 0)
        FROM lease_prepaid_credits pc)
    SELECT kind, id, amount_original::text, amount_remaining::text, live::text
      FROM c WHERE amount_original <> amount_remaining + live
     ORDER BY kind, id`,
  I2: `
    SELECT p.id AS payment_id, p.issued_credit_amount::text AS column_value, COALESCE(x.s, 0)::text AS ledger_value
      FROM payments p
      LEFT JOIN LATERAL (
        SELECT SUM(u.amount) AS s FROM credit_uses u JOIN tenant_credits tc ON tc.id = u.tenant_credit_id
         WHERE u.payment_id = p.id AND u.status = 'applied' AND tc.category <> 'deposit_interest') x ON TRUE
     WHERE (p.issued_credit_amount <> 0 OR EXISTS (SELECT 1 FROM credit_uses u WHERE u.payment_id = p.id))
       AND p.issued_credit_amount <> COALESCE(x.s, 0)
     ORDER BY p.id`,
  I3: `
    SELECT r.id AS remittance_id, r.payment_method, r.amount::text, r.unapplied_amount::text,
           COALESCE(a.applied, 0)::text AS applications, a.over_row
      FROM tenant_remittances r
      LEFT JOIN LATERAL (
        SELECT SUM(ra.amount_applied) AS applied,
               bool_or(ra.amount_applied > vm.money_part + 0.005) AS over_row
          FROM remittance_applications ra JOIN v_payment_money vm ON vm.payment_id = ra.payment_id
         WHERE ra.remittance_id = r.id) a ON TRUE
     WHERE r.status = 'settled'
       AND (r.amount <> COALESCE(a.applied, 0) + r.unapplied_amount OR COALESCE(a.over_row, false))
     ORDER BY r.id`,
  I4: `
    SELECT vm.payment_id, vm.amount::text, vm.money_part::text
      FROM v_payment_money vm
     WHERE vm.amount >= 0 AND vm.money_part < -0.005
     ORDER BY vm.payment_id`,
  I5: `
    WITH s AS (
      SELECT l.reference_id AS payment_id, SUM(l.amount) AS owner_shares
        FROM user_balance_ledger l
       WHERE l.reference_type = 'payment' AND l.type = 'allocation_owner_share'
       GROUP BY l.reference_id),
    h AS (
      SELECT s.payment_id, s.owner_shares, p.status,
             CASE WHEN p.status = 'returned' AND p.revenue_owner = 'landlord'
                       AND p.type <> 'deposit' AND p.amount >= 0
                  THEN vm.gam_funded_credit
                       + CASE WHEN p.manual_method IS NULL
                               AND (p.stripe_charge_id IS NOT NULL OR p.flexpay_advance_id IS NOT NULL)
                              THEN vm.money_part ELSE 0 END
                  ELSE vm.gam_held_part END AS held_at_settle,
             COALESCE(p.gam_supersedence_amount, 0) + COALESCE(p.sublease_markup_amount, 0) AS never_theirs
        FROM s JOIN payments p ON p.id = s.payment_id
        JOIN v_payment_money vm ON vm.payment_id = s.payment_id)
    SELECT payment_id, status, owner_shares::text, held_at_settle::text, never_theirs::text
      FROM h
     WHERE owner_shares > GREATEST(0, held_at_settle - never_theirs) + 0.005
     ORDER BY payment_id`,
  I6: `
    SELECT u.id AS use_id, u.payment_id, u.status, p.type, p.revenue_owner, p.entry_description
      FROM credit_uses u JOIN payments p ON p.id = u.payment_id
     WHERE u.status IN ('held','applied')
       AND NOT (p.revenue_owner = 'landlord'
                AND p.type IN ('rent','utility','late_fee','fee')
                AND p.entry_description NOT IN ('FLEXPAY','HOMEPMT')
                AND NOT (p.entry_description = 'DEPOSIT' AND p.lease_fee_id IS NULL)
                AND p.work_trade_suspended_at IS NULL
                AND p.reversal_id IS NULL
                AND p.unit_id IS NOT NULL
                AND p.lease_id = u.lease_id)
     ORDER BY u.id`,
  I7: `
    SELECT p.landlord_id, to_char(date_trunc('month', p.settled_at), 'YYYY-MM') AS month,
           COUNT(*)::int AS rows, SUM(vm.money_part)::text AS money_with_no_receipt,
           (array_agg(p.id ORDER BY p.id))[1:5] AS examples
      FROM payments p JOIN v_payment_money vm ON vm.payment_id = p.id
     WHERE p.status = 'settled' AND p.revenue_owner = 'landlord' AND vm.money_part > 0.005
       AND p.type <> 'deposit'
       AND COALESCE(p.manual_method, '') <> 'prior_arrangement'
       AND p.flexpay_advance_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM remittance_applications ra WHERE ra.payment_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM bank_deposit_allocations b WHERE b.payment_id = p.id AND b.reversed_at IS NULL)
     GROUP BY p.landlord_id, date_trunc('month', p.settled_at)
     ORDER BY p.landlord_id, month`,
  I8: `
    SELECT l.id AS ledger_id, l.reference_id AS payment_id, l.amount::text, p.status, p.platform_held
      FROM user_balance_ledger l LEFT JOIN payments p ON p.id = l.reference_id
     WHERE l.reference_type = 'payment' AND l.type = 'allocation_owner_share'
       AND l.stripe_transfer_id IS NULL AND l.amount <> 0
       AND NOT (COALESCE(p.status, '') = 'settled' AND COALESCE(p.platform_held, false))
     ORDER BY l.id`,
  I9: `
    SELECT u.id AS use_id, u.payment_id, u.remittance_id, u.amount::text, u.held_at, p.status, p.next_retry_at
      FROM credit_uses u LEFT JOIN payments p ON p.id = u.payment_id
     WHERE u.status = 'held' AND u.held_at < now() - interval '10 days'
       AND NOT (COALESCE(p.status, '') = 'processing'
                OR (COALESCE(p.status, '') = 'failed' AND p.next_retry_at IS NOT NULL))
     ORDER BY u.id`,
}

/** Units M6 flips to delinquent: rent is late, and only saved credit was hiding it. */
const M6_FLIPS = `
  WITH owed AS (
    SELECT u.id AS unit_id, u.unit_number, pr.name AS property, u.status,
           COALESCE(SUM(p.amount), 0) AS owed
      FROM units u
      JOIN properties pr ON pr.id = u.property_id
      JOIN payments p ON p.unit_id = u.id
      LEFT JOIN leases l ON l.id = p.lease_id
     WHERE p.type = 'rent' AND p.status IN ('pending','failed') AND p.work_trade_suspended_at IS NULL
       AND (NOW() AT TIME ZONE COALESCE(pr.timezone, 'America/Phoenix'))::date
             > p.due_date + COALESCE(l.late_fee_grace_days, pr.late_fee_grace_days, 5)
     GROUP BY u.id, u.unit_number, pr.name, u.status),
  credit AS (
    SELECT l.unit_id, COALESCE(SUM(c.amount_remaining), 0) AS credit
      FROM tenant_credits c
      JOIN lease_tenants lt ON lt.tenant_id = c.tenant_id AND lt.status = 'active'
      JOIN leases l ON l.id = lt.lease_id AND l.status = 'active'
     WHERE c.status = 'active' AND c.amount_remaining > 0
     GROUP BY l.unit_id)
  SELECT o.property, o.unit_number, o.status, o.owed::text, COALESCE(c.credit, 0)::text AS saved_credit
    FROM owed o LEFT JOIN credit c ON c.unit_id = o.unit_id
   WHERE o.owed > 0 AND o.owed - COALESCE(c.credit, 0) <= 0
   ORDER BY o.property, o.unit_number`

/**
 * Run the checks on the caller's client (read-only queries; the caller picks
 * the transaction). `only` limits the run (the backfill checks I1–I3).
 */
export async function checkMoneyInvariants(
  client: PoolClient,
  opts: { only?: readonly InvariantId[]; withDelinquencyFlips?: boolean } = {},
): Promise<InvariantReport> {
  const ids = opts.only ?? INVARIANT_IDS
  const results: InvariantResult[] = []
  for (const id of ids) {
    const r = await client.query<Record<string, unknown>>(CHECKS[id])
    results.push({ id, label: INVARIANT_LABEL[id], violations: r.rows.length, sample: r.rows.slice(0, 50) })
  }
  const report: InvariantReport = { ok: results.every(r => r.violations === 0), results }
  if (opts.withDelinquencyFlips) {
    const f = await client.query<Record<string, unknown>>(M6_FLIPS)
    report.delinquencyFlips = { count: f.rows.length, units: f.rows }
  }
  return report
}

export function printInvariantReport(report: InvariantReport, log: (s: string) => void = console.log): void {
  for (const r of report.results) {
    log(`${r.violations === 0 ? 'PASS' : 'FAIL'}  ${r.id}  ${r.label}${r.violations ? ` — ${r.violations} violation(s)` : ''}`)
    for (const s of r.sample.slice(0, 10)) log(`        ${JSON.stringify(s)}`)
  }
  if (report.delinquencyFlips) {
    log(`M6: ${report.delinquencyFlips.count} unit(s) become delinquent once saved credit stops masking late rent`)
    for (const u of report.delinquencyFlips.units) log(`        ${JSON.stringify(u)}`)
  }
}

if (require.main === module) {
  ;(async () => {
    const { getClient } = await import('../db')
    const c = await getClient()
    let code = 0
    try {
      await c.query('BEGIN READ ONLY')
      const report = await checkMoneyInvariants(c, { withDelinquencyFlips: true })
      printInvariantReport(report)
      code = report.ok ? 0 : 1
    } catch (e) {
      console.error(e)
      code = 2
    } finally {
      await c.query('ROLLBACK').catch(() => {})
      c.release()
      process.exit(code)
    }
  })()
}
