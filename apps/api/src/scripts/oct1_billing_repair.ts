/**
 * S654 (2026-10-01) — repair the October 1 billing run, in one transaction.
 *
 * Nic: "Work trade people are on work trade. There's no bills going out to
 * those people. My people at my properties are auto complete work trade until
 * I change it back." And: "the ones that aren't billed correctly need to be
 * billed correctly" — the rent-to-own installment belongs ON the rent invoice.
 *
 *   1. Nic's agreements (Oak Park, Mountain View) stop tracking hours — the
 *      month closes covered in full.
 *   2. Every covered line on an October 1 work-trade invoice is suspended, the
 *      way the move-in bill and (from now) the monthly run write it.
 *   3. Every invoice carrying a suspended line gets the S634 total: the sum of
 *      what is actually owed. Four September invoices still carried gross
 *      totals from before S634.
 *   4. Open settlement periods on Nic's agreements ask for 0 hours; a period
 *      the load script pre-created without its invoice (Curtis) is linked; a
 *      September invoice that never got a period (MH 02) gets one.
 *   5. The six standalone October home payments move onto their rent invoices.
 *
 * DRY=1 prints the plan and rolls back. Run from apps/api:
 *   DRY=1 node -r ts-node/register src/scripts/oct1_billing_repair.ts
 */
import { getClient } from '../db'

const NIC_LANDLORDS = [
  '8d59242e-c1e5-48a7-b768-420c57fb5fca', // Oak Park Motel and RV LLC
  '96ec7df3-362d-4777-b54c-e9604313820f', // Mountain View RV Park Ranch LLC
]
const NOTE = 'Work trade — suspended while the hours are worked; settled at month close'
const ALL_UTILITIES = ['water', 'sewer', 'electric', 'gas', 'trash']

;(async () => {
  const dry = process.env.DRY === '1'
  const c = await getClient()
  try {
    await c.query('BEGIN')

    // 1. Auto-complete for Nic's people.
    const r1 = await c.query(
      `UPDATE work_trade_agreements a SET tracks_hours = false, updated_at = NOW()
        WHERE a.landlord_id = ANY($1::uuid[]) AND a.status IN ('active','paused') AND a.tracks_hours = true
        RETURNING (SELECT u.unit_number FROM units u WHERE u.id = a.unit_id) AS unit`, [NIC_LANDLORDS])
    console.log(`1. tracks_hours=false on ${r1.rowCount} agreements:`, r1.rows.map(r => r.unit).join(', '))

    // 2. Suspend the covered lines on October 1 invoices of active agreements.
    const r2 = await c.query(
      `WITH ag AS (
         SELECT a.id, a.covered_charges,
                (a.covered_charges IS NULL OR cardinality(a.covered_charges) = 0) AS covers_all
           FROM work_trade_agreements a WHERE a.status = 'active'),
       target AS (
         SELECT p.id, p.type, p.amount, i.invoice_number
           FROM payments p
           JOIN invoices i ON i.id = p.invoice_id
           JOIN ag ON ag.id = i.work_trade_agreement_id
           LEFT JOIN utility_bills ub ON ub.payment_id = p.id
          WHERE i.due_date = '2026-10-01'
            AND p.status = 'pending'
            AND p.work_trade_suspended_at IS NULL
            AND p.amount > 0
            AND COALESCE(p.entry_description, '') <> 'LATEFEE'
            AND (
                 (p.type = 'rent' AND (ag.covers_all OR 'rent' = ANY(ag.covered_charges)))
              OR (p.type = 'fee' AND p.entry_description = 'SUBSCRIP' AND (ag.covers_all OR 'fees' = ANY(ag.covered_charges)))
              OR (p.type = 'utility' AND p.entry_description = 'PROPANE' AND (ag.covers_all OR 'propane' = ANY(ag.covered_charges)))
              OR (p.type = 'utility' AND p.entry_description = 'UTILITY' AND ub.id IS NOT NULL
                    AND ub.service_agreement_id IS NULL
                    AND (ag.covers_all OR ub.utility_type = ANY(ag.covered_charges)))
              OR (p.type = 'utility' AND p.entry_description = 'UTILITY' AND ub.id IS NULL
                    AND (ag.covers_all OR ag.covered_charges @> $2::text[]))
            ))
       UPDATE payments p
          SET work_trade_suspended_at = NOW(),
              notes = CASE WHEN p.notes IS NULL OR p.notes = '' THEN $1 ELSE p.notes || ' — ' || $1 END
         FROM target t WHERE p.id = t.id
       RETURNING t.invoice_number, t.type, t.amount`, [NOTE, ALL_UTILITIES])
    console.log(`2. suspended ${r2.rowCount} lines:`)
    for (const r of r2.rows) console.log(`     ${r.invoice_number} ${r.type} $${r.amount}`)

    // 3. The S634 total on every invoice that carries a suspended line.
    const r3 = await c.query(
      `UPDATE invoices i
          SET total_amount = COALESCE((SELECT SUM(p.amount) FROM payments p
                                        WHERE p.invoice_id = i.id AND p.work_trade_suspended_at IS NULL
                                          AND p.status <> 'failed'), 0),
              updated_at = NOW()
        WHERE i.status <> 'void'
          AND EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.work_trade_suspended_at IS NOT NULL)
          AND i.total_amount <> COALESCE((SELECT SUM(p.amount) FROM payments p
                                           WHERE p.invoice_id = i.id AND p.work_trade_suspended_at IS NULL
                                             AND p.status <> 'failed'), 0)
        RETURNING invoice_number, due_date, total_amount`)
    console.log(`3. totals rebuilt on ${r3.rowCount} invoices:`)
    for (const r of r3.rows) console.log(`     ${r.invoice_number} ${String(r.due_date).slice(0, 10)} → $${r.total_amount}`)

    // 4a. Nic's open periods ask for nothing.
    const r4a = await c.query(
      `UPDATE work_trade_settlements s SET target_hours = 0, hour_rate = 0, updated_at = NOW()
         FROM work_trade_agreements a
        WHERE a.id = s.agreement_id AND a.landlord_id = ANY($1::uuid[]) AND s.status = 'open'
          AND (s.target_hours <> 0 OR s.hour_rate <> 0)
        RETURNING (SELECT u.unit_number FROM units u WHERE u.id = a.unit_id) AS unit, s.period_month`, [NIC_LANDLORDS])
    console.log(`4a. ${r4a.rowCount} periods set to 0 hours:`, r4a.rows.map(r => `${r.unit}@${String(r.period_month).slice(0, 7)}`).join(', '))

    // 4b. A period opened without its invoice (pre-created by a load script)
    //     is linked to the invoice the run made for that month.
    const r4b = await c.query(
      `UPDATE work_trade_settlements s SET invoice_id = i.id, updated_at = NOW()
         FROM invoices i
        WHERE s.invoice_id IS NULL AND s.status = 'open'
          AND i.work_trade_agreement_id = s.agreement_id AND i.due_date = s.period_month AND i.status <> 'void'
        RETURNING i.invoice_number, s.period_month`)
    console.log(`4b. ${r4b.rowCount} periods linked to their invoice:`, r4b.rows.map(r => r.invoice_number).join(', '))

    // 4c. A work-trade invoice with no period at all gets one (0 hours, the
    //     covered basis = the suspended lines), closed like its neighbours so
    //     the next monthly close settles it.
    const r4c = await c.query(
      `INSERT INTO work_trade_settlements
         (agreement_id, invoice_id, period_month, target_hours, hour_rate, basis_amount, period_start, period_end, close_run_at)
       SELECT i.work_trade_agreement_id, i.id, i.due_date, 0, 0,
              COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id AND p.work_trade_suspended_at IS NOT NULL), 0),
              i.due_date, (i.due_date + INTERVAL '1 month' - INTERVAL '1 day')::date,
              CASE WHEN i.due_date < date_trunc('month', CURRENT_DATE)::date THEN NOW() ELSE NULL END
         FROM invoices i
         JOIN work_trade_agreements a ON a.id = i.work_trade_agreement_id
        WHERE a.landlord_id = ANY($1::uuid[]) AND i.status <> 'void'
          AND EXTRACT(DAY FROM i.due_date) = 1
          AND NOT EXISTS (SELECT 1 FROM work_trade_settlements s WHERE s.agreement_id = a.id AND s.period_month = i.due_date)
       RETURNING period_month, basis_amount`, [NIC_LANDLORDS])
    console.log(`4c. ${r4c.rowCount} missing periods created:`, r4c.rows.map(r => `${String(r.period_month).slice(0, 7)} basis $${r.basis_amount}`).join(', '))

    // 5. The standalone October home payments move onto their rent invoices.
    const r5 = await c.query(
      `WITH moved AS (
         UPDATE payments p SET invoice_id = i.id, lease_id = COALESCE(p.lease_id, i.lease_id)
           FROM invoices i
          WHERE p.type = 'home_payment' AND p.invoice_id IS NULL AND p.status = 'pending'
            AND p.due_date = '2026-10-01'
            AND i.tenant_id = p.tenant_id AND i.unit_id = p.unit_id AND i.due_date = '2026-10-01'
            AND i.status IN ('pending','partial')
          RETURNING p.amount, i.id AS invoice_id)
       UPDATE invoices i
          SET subtotal_home_payments = i.subtotal_home_payments + m.amt,
              total_amount = i.total_amount + m.amt,
              updated_at = NOW()
         FROM (SELECT invoice_id, SUM(amount) AS amt FROM moved GROUP BY invoice_id) m
        WHERE i.id = m.invoice_id
       RETURNING i.invoice_number, m.amt AS home_payment, i.total_amount`)
    console.log(`5. ${r5.rowCount} home payments moved onto invoices:`)
    for (const r of r5.rows) console.log(`     ${r.invoice_number} +$${r.home_payment} → total $${r.total_amount}`)

    if (dry) { await c.query('ROLLBACK'); console.log('DRY RUN — rolled back') }
    else { await c.query('COMMIT'); console.log('COMMITTED') }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    console.error(e)
    process.exit(1)
  } finally {
    c.release()
    process.exit(0)
  }
})()
