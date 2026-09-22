/**
 * S652 — THE LANDLORD SEES THE UTILITY BILLS BEFORE THE TENANTS DO.
 *
 * Nic (for Blu, whose meter reader is new): "Blu wants to approve and see what
 * the bills are gonna be before they're generated... he'd rather fix it before
 * the people get billed than wait till they complain and have to fix it
 * retroactively." And: "without changing the billing."
 *
 * So nothing here prices anything. The bills on the review are computed by the
 * SAME engine the invoice run uses (generateBillsForProperty), just earlier, and
 * left unissued: a tenant never sees an unissued bill (GET /utility/bills), and
 * where the company chose to review (landlords.review_utility_bills), an
 * invoice that would carry them is held until the landlord approves
 * (invoiceGeneration). Off, the bills go through on their own. Correcting a read throws the
 * unissued bills away so the same engine prices them again from the fixed read.
 */
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { generateBillsForProperty } from './utilityBilling'

const cycleDateOf = (d: any) => {
  const s = d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : String(d).slice(0, 10)
  return s
}

/** Everything the review page shows for one reading run. */
export async function billReview(runId: string) {
  const run = await queryOne<any>(
    `SELECT r.*, p.name AS property_name, l.review_utility_bills
       FROM utility_reading_runs r JOIN properties p ON p.id = r.property_id
       JOIN landlords l ON l.id = r.landlord_id WHERE r.id = $1`, [runId])
  if (!run) throw new AppError(404, 'Reading run not found')
  const cycle = cycleDateOf(run.billing_cycle_month)

  // Price what can be priced now — the same call the invoice run makes. Bills
  // already made are kept (the engine skips a meter-unit-cycle that has one).
  if (run.status !== 'completed') {
    await generateBillsForProperty(run.property_id, new Date(cycle + 'T00:00:00Z'))
  }

  const rows = await query<any>(`
    SELECT m.id AS meter_id, m.label, m.utility_type, m.billing_method, m.digits,
           cur.id AS reading_id, cur.reading_value, cur.reading_date, cur.needs_review, cur.review_note,
           -- The bill's own start read when there is a bill; otherwise the
           -- read before this one, whatever it was taken for.
           COALESCE(ub.reading_start, (SELECT pr.reading_value FROM utility_meter_readings pr
             WHERE pr.meter_id = m.id AND pr.id IS DISTINCT FROM cur.id
               AND (pr.billing_cycle_month < $2::date
                    OR (cur.id IS NOT NULL AND pr.reading_date < cur.reading_date))
             ORDER BY pr.reading_date DESC, pr.created_at DESC LIMIT 1)) AS prior_value,
           ub.id AS bill_id, ub.usage_amount, ub.charge_amount, ub.status AS bill_status, ub.payment_id,
           u.unit_number, tu.first_name AS tenant_first, tu.last_name AS tenant_last
      FROM utility_meters m
      LEFT JOIN utility_meter_readings cur
             ON cur.meter_id = m.id AND cur.billing_cycle_month = $2::date AND cur.reason = 'monthly_cycle'
      LEFT JOIN utility_bills ub ON ub.meter_id = m.id AND ub.billing_cycle_month = $2::date
      LEFT JOIN units u ON u.id = COALESCE(ub.unit_id,
             (SELECT mu.unit_id FROM utility_meter_units mu WHERE mu.meter_id = m.id LIMIT 1))
      LEFT JOIN tenants tt ON tt.id = ub.tenant_id
      LEFT JOIN users tu ON tu.id = tt.user_id
     WHERE m.property_id = $1 AND m.billing_method IN ('submeter','rubs')
       AND ($3::text IS NULL OR m.utility_type = $3)
     ORDER BY u.unit_number NULLS LAST, m.utility_type, m.label`,
    [run.property_id, cycle, run.utility_type ?? null])

  const lines = rows.map(r => ({
    meterId: r.meter_id, label: r.label, utilityType: r.utility_type, billingMethod: r.billing_method,
    digits: r.digits, unitNumber: r.unit_number,
    readingId: r.reading_id, reading: r.reading_value != null ? Number(r.reading_value) : null,
    readOn: r.reading_date, prior: r.prior_value != null ? Number(r.prior_value) : null,
    flagged: !!r.needs_review, flagNote: r.review_note,
    tenant: [r.tenant_first, r.tenant_last].filter(Boolean).join(' ') || null,
    usage: r.usage_amount != null ? Number(r.usage_amount) : null,
    charge: r.charge_amount != null ? Number(r.charge_amount) : null,
    issued: r.bill_id ? (r.bill_status !== 'unbilled' || !!r.payment_id) : false,
  }))
  const total = lines.reduce((s, l) => s + (l.charge ?? 0), 0)
  return {
    run: {
      id: run.id, propertyId: run.property_id, propertyName: run.property_name, cycle,
      utilityType: run.utility_type, status: run.status,
      approvedAt: run.approved_at, reviewRequired: run.review_utility_bills === true,
    },
    lines,
    totals: {
      bills: lines.filter(l => l.charge != null).length,
      amount: Math.round(total * 100) / 100,
      unread: lines.filter(l => l.reading == null).length,
      flagged: lines.filter(l => l.flagged).length,
    },
  }
}

/**
 * A read changed before anything was issued: drop the property's unissued bills
 * for that cycle onward, so the engine prices them again from the fixed number.
 * The whole property, not just the meter — a submeter's usage comes off its RUBS
 * master's pool, so fixing one read can move a neighbour's share.
 * Returns false (and drops nothing) if anything from that span was issued.
 */
export async function dropUnissuedBillsFrom(meterId: string, cycleMonth: any): Promise<boolean> {
  const cycle = cycleDateOf(cycleMonth)
  const issued = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM utility_bills
      WHERE meter_id = $1 AND billing_cycle_month >= $2::date
        AND (status <> 'unbilled' OR payment_id IS NOT NULL)`, [meterId, cycle])
  if ((issued?.n ?? 0) > 0) return false
  await query(
    `DELETE FROM utility_bills ub USING utility_meters m, utility_meters me
      WHERE me.id = $1 AND m.property_id = me.property_id AND m.utility_type = me.utility_type
        AND ub.meter_id = m.id AND ub.billing_cycle_month >= $2::date
        AND ub.status = 'unbilled' AND ub.payment_id IS NULL`, [meterId, cycle])
  return true
}
