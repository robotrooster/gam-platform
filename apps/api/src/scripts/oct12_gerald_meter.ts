/**
 * 10/12 (Nic) — Gerald Logue, Mountain View RV 48: his estimated electric comes
 * off and his meter is put back in service.
 *
 *   "Gerald Logue (Mountain View RV 48): void his $22.47 estimated electric and
 *    mark his meter working (zero use then bills $0). Mountain View's estimate
 *    setting stays on."
 *
 * His meter read 49083 on 8/1, 9/2 and 9/30. Zero use on an occupied space is
 * read as a stuck meter (services/utilityBilling), and Mountain View bills a
 * stuck meter from its lowest comparable neighbors, so his October bill
 * (INV-2026-00076) carried a $22.47 September estimate (107 kWh × $0.21). He
 * does not use power; the meter is fine.
 *
 *   1. The $22.47 electric line on INV-2026-00076 is VOIDED — soft (decisions
 *      #48.5): the row stays as a record, owed by nobody — under the household
 *      lock, the one way the platform voids a charge (services/chargeVoids
 *      voidUnowedCharges): refused, changing nothing, when any record points
 *      at it (account credit, a bank match, a receipt). Its reading is marked
 *      void beside it (kept, with why), the bill's total and utilities
 *      subtotal drop by the same amount, and its status follows what is left.
 *   2. His meter is put back through the landlord's own "Works, tenant uses no
 *      power" choice (10/12, Nic, M1 — services/meterRepair
 *      markMeterWorksNoUse): back in service, CONFIRMED WORKING with nobody
 *      using it (utility_meters.zero_use_confirmed_at and who confirmed it:
 *      the property's owner), and NO new reading — the meter was never
 *      replaced, so his history does not say it was (10/12 review: this used
 *      the "Repaired" path, which writes a 'meter_replaced' read). With the
 *      confirmation, his next flat read bills $0, which is no line at all
 *      (jobs/invoiceGeneration), instead of being marked broken and estimated
 *      again, until the meter moves, somebody marks it broken by hand, or he
 *      moves out. A meter already back in service is just confirmed, the
 *      same way.
 * Mountain View's estimate setting (properties.estimates_stuck_meters) is not
 * touched. Refuses, changing nothing, unless it finds exactly that line and
 * that meter. Run twice, the second run finds nothing to do.
 *
 * DRY RUN BY DEFAULT — everything runs in one transaction that is rolled back.
 * --apply commits.
 *   cd apps/api && npx ts-node -T src/scripts/oct12_gerald_meter.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct12_gerald_meter.ts --apply
 */
import type { PoolClient } from 'pg'
import { getClient } from '../db'
import { lockHousehold } from '../services/moneyPredicates'
import { markMeterWorksNoUse } from '../services/meterRepair'
import { voidUnowedCharges } from '../services/chargeVoids'

/** Who and what, as production has them (read 10/12). */
export const GERALD = {
  tenantId: 'c3abafbb-059d-4458-ab7f-9c516edca302',
  invoiceNumber: 'INV-2026-00076',
  amount: 22.47,
  unitNumber: 'RV 48',
} as const

export const ESTIMATE_VOID_REASON = 'Estimated electric taken off: the meter was working and he used no power (10/12, Nic)'
const ESTIMATE_NOTE = 'Voided: the meter was working — no power used'

export interface GeraldMeterReport {
  voided: { paymentId: string; invoiceNumber: string; amount: number; readingId: string | null } | null
  /** The meter was flagged broken and is back in service ("Works, tenant uses no power"). */
  meterBackInService: { meterId: string; label: string } | null
  /** The meter was confirmed working with nobody using it (it was not, before). */
  zeroUseConfirmed: { meterId: string; label: string } | null
  /** Why nothing was done, when nothing was. */
  refused: string | null
}

/** Inside the caller's transaction. See the header. */
export async function fixGeraldMeter(
  client: PoolClient,
  who: { tenantId: string; invoiceNumber: string; amount: number; unitNumber: string } = GERALD,
): Promise<GeraldMeterReport> {
  const out: GeraldMeterReport = { voided: null, meterBackInService: null, zeroUseConfirmed: null, refused: null }
  const lines = (await client.query<{
    id: string; landlord_id: string; unit_id: string; invoice_id: string; status: string; reading_id: string | null
  }>(
    `SELECT p.id, p.landlord_id, p.unit_id, p.invoice_id, p.status,
            (SELECT ub.id FROM utility_bills ub WHERE ub.payment_id = p.id ORDER BY ub.created_at, ub.id LIMIT 1) AS reading_id
       FROM payments p
       JOIN invoices inv ON inv.id = p.invoice_id
       JOIN units u ON u.id = p.unit_id
      WHERE inv.invoice_number = $1
        AND COALESCE(p.tenant_id, inv.tenant_id) = $2
        AND u.unit_number = $3
        AND p.type = 'utility'
        AND p.amount = $4
      FOR UPDATE OF p`,
    [who.invoiceNumber, who.tenantId, who.unitNumber, who.amount])).rows
  if (lines.length > 1) return { ...out, refused: `found ${lines.length} $${who.amount} electric lines on ${who.invoiceNumber}; expected one` }
  const line = lines[0] ?? null
  if (line && !['pending', 'failed', 'voided'].includes(line.status)) {
    return { ...out, refused: `the $${who.amount} line on ${who.invoiceNumber} is ${line.status} — money is on it, so it is refunded, not voided` }
  }
  const meters = (await client.query<{
    id: string; label: string; out_of_service: boolean; zero_use_confirmed: boolean; owner: string
  }>(
    `SELECT m.id, m.label, m.out_of_service, (m.zero_use_confirmed_at IS NOT NULL) AS zero_use_confirmed,
            pr.owner_user_id AS owner
       FROM utility_meters m
       JOIN utility_meter_units mu ON mu.meter_id = m.id
       JOIN units u ON u.id = mu.unit_id
       JOIN properties pr ON pr.id = m.property_id
      WHERE u.unit_number = $1 AND m.utility_type = 'electric' AND m.billing_method = 'submeter'
        AND u.id = COALESCE($2::uuid, (SELECT l.unit_id FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id
                                        WHERE lt.tenant_id = $3 AND l.status = 'active' ORDER BY l.start_date DESC LIMIT 1))
      FOR UPDATE OF m`,
    [who.unitNumber, line?.unit_id ?? null, who.tenantId])).rows
  if (meters.length !== 1) return { ...out, refused: `found ${meters.length} electric submeters on ${who.unitNumber}; expected one` }
  const meter = meters[0]

  if (line && line.status !== 'voided') {
    await lockHousehold(client, who.tenantId, line.landlord_id)
    // The one way the platform voids a charge (services/chargeVoids), with the
    // check every other void path makes: a line a record points at is never voided.
    const { voided, held } = await voidUnowedCharges((t, p) => client.query(t, p), [line.id], ESTIMATE_VOID_REASON)
    if (held.length) {
      return { ...out, refused: `a record points at the $${who.amount} line on ${who.invoiceNumber} (account credit, a bank match or a receipt) — it is not voided` }
    }
    if (voided.length !== 1) {
      return { ...out, refused: `the $${who.amount} line on ${who.invoiceNumber} could not be voided (it is no longer owed)` }
    }
    await client.query(
      `UPDATE payments SET notes = COALESCE(notes || ' — ', '') || $2 WHERE id = $1`, [line.id, ESTIMATE_NOTE])
    if (line.reading_id) {
      await client.query(
        `UPDATE utility_bills
            SET status = 'void', notes = COALESCE(notes || ' — ', '') || $2, updated_at = NOW()
          WHERE id = $1 AND status IN ('billed', 'unbilled')`, [line.reading_id, ESTIMATE_NOTE])
    }
    await client.query(
      `UPDATE invoices
          SET total_amount = GREATEST(0, total_amount - $2::numeric),
              subtotal_utilities = GREATEST(0, subtotal_utilities - $2::numeric),
              updated_at = NOW()
        WHERE id = $1`, [line.invoice_id, who.amount])
    await client.query(`SELECT fn_invoice_status_rollup_single($1::uuid)`, [line.invoice_id])
    out.voided = { paymentId: line.id, invoiceNumber: who.invoiceNumber, amount: who.amount, readingId: line.reading_id }
  }

  // "Works, tenant uses no power" — flagged or not, the same choice (it sets the
  // confirmation and who made it together, and writes no reading).
  if (meter.out_of_service || !meter.zero_use_confirmed) {
    await markMeterWorksNoUse(client, { meterId: meter.id, userId: meter.owner })
    if (meter.out_of_service) out.meterBackInService = { meterId: meter.id, label: meter.label }
    out.zeroUseConfirmed = { meterId: meter.id, label: meter.label }
  }
  return out
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const r = await fixGeraldMeter(c)
    console.log(apply ? 'APPLY' : 'DRY RUN')
    if (r.refused) console.log(`  Refused, nothing changed: ${r.refused}`)
    console.log(r.voided
      ? `  Voided the $${r.voided.amount} estimated electric on ${r.voided.invoiceNumber} (payment ${r.voided.paymentId}`
        + `${r.voided.readingId ? `, reading ${r.voided.readingId} marked void` : ''}); the bill total and utilities subtotal drop $${r.voided.amount}.`
      : '  No estimated electric line to void (already voided, or not found).')
    console.log(r.meterBackInService
      ? `  Meter "${r.meterBackInService.label}" (${r.meterBackInService.meterId}) back in service: works, tenant uses no power (no new reading).`
      : '  Meter already in service (or not found).')
    console.log(r.zeroUseConfirmed
      ? `  Meter "${r.zeroUseConfirmed.label}" confirmed working with no use: a flat read now bills $0 instead of being marked stuck.`
      : '  Meter already confirmed working (or not found).')
    if (r.refused) { await c.query('ROLLBACK'); return }
    await c.query(apply ? 'COMMIT' : 'ROLLBACK')
    console.log(apply ? 'Committed.' : 'Rolled back (dry run). Re-run with --apply to write.')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
}
