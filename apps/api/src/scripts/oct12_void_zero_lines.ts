/**
 * 10/12 (Nic) — the $0 lines still owed are voided.
 *
 *   "Payment health = ONE definition everywhere … $0 lines are ignored."
 *
 * The monthly invoice run used to write a charge line for a utility reading
 * that billed nothing (jobs/invoiceGeneration now marks such a reading billed
 * and writes no line). Four of those lines were still open in production on
 * 10/12 — Gerald Logue's August electric (RV 48, 49083 → 49083) among them.
 * An open $0 line read like an unpaid bill: it counted against payment health,
 * looked like rent on the tenant profile, and kept late fees running.
 *
 * Each pending or failed $0 line that is not a late fee, not parked under work
 * trade and has no account credit on it is VOIDED (soft — decisions #48.5: the
 * row stays as a record, owed by nobody), under the household lock. Its
 * utility reading stays exactly as it is: billed, linked to the line it billed
 * — it was read and charged nothing. Every change is printed. Run twice, the
 * second run finds nothing.
 *
 * DRY RUN BY DEFAULT — everything runs in one transaction that is rolled back.
 * --apply commits.
 *   cd apps/api && npx ts-node -T src/scripts/oct12_void_zero_lines.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct12_void_zero_lines.ts --apply
 */
import type { PoolClient } from 'pg'
import { getClient } from '../db'
import { lockHousehold } from '../services/moneyPredicates'

export const ZERO_LINE_VOID_REASON = 'Nothing owed: this line billed $0.00 (10/12)'
const ZERO_LINE_NOTE = 'Voided: nothing owed ($0.00)'

export interface VoidedZeroLine {
  paymentId: string
  type: string
  invoiceNumber: string | null
  tenantId: string | null
  tenantName: string
  unitNumber: string | null
  propertyName: string | null
  notes: string | null
  /** The utility reading this line billed, and its status (kept as it is). */
  readingId: string | null
  readingStatus: string | null
}

/** Void every open $0 line, inside the caller's transaction. See the header. */
export async function voidZeroLines(client: PoolClient, opts: { landlordIds?: string[] | null } = {}): Promise<VoidedZeroLine[]> {
  const rows = (await client.query<{
    id: string; type: string; invoice_number: string | null; tenant_id: string | null; landlord_id: string
    first_name: string | null; last_name: string | null; unit_number: string | null; property_name: string | null
    notes: string | null; reading_id: string | null; reading_status: string | null
  }>(
    `SELECT p.id, p.type, inv.invoice_number, COALESCE(p.tenant_id, inv.tenant_id) AS tenant_id, p.landlord_id,
            tu.first_name, tu.last_name, u.unit_number, pr.name AS property_name, p.notes,
            ub.id AS reading_id, ub.status AS reading_status
       FROM payments p
       LEFT JOIN invoices inv  ON inv.id = p.invoice_id
       LEFT JOIN tenants t     ON t.id = COALESCE(p.tenant_id, inv.tenant_id)
       LEFT JOIN users tu      ON tu.id = t.user_id
       LEFT JOIN units u       ON u.id = p.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
       LEFT JOIN LATERAL (SELECT ub.id, ub.status FROM utility_bills ub WHERE ub.payment_id = p.id
                           ORDER BY ub.created_at, ub.id LIMIT 1) ub ON TRUE
      WHERE p.amount = 0
        AND p.type <> 'late_fee'
        AND p.status IN ('pending', 'failed')
        AND p.work_trade_suspended_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM credit_uses cu WHERE cu.payment_id = p.id AND cu.status IN ('held', 'applied'))
        AND ($1::uuid[] IS NULL OR p.landlord_id = ANY($1::uuid[]))
      ORDER BY pr.name NULLS LAST, u.unit_number NULLS LAST, p.due_date, p.id`,
    [opts.landlordIds ?? null])).rows
  const out: VoidedZeroLine[] = []
  for (const r of rows) {
    if (r.tenant_id) await lockHousehold(client, r.tenant_id, r.landlord_id)
    const done = await client.query(
      `UPDATE payments
          SET status = 'voided', voided_at = NOW(), void_reason = $2, next_retry_at = NULL,
              notes = COALESCE(notes || ' — ', '') || $3
        WHERE id = $1 AND status IN ('pending', 'failed') AND amount = 0`,
      [r.id, ZERO_LINE_VOID_REASON, ZERO_LINE_NOTE])
    if ((done.rowCount ?? 0) === 0) continue
    out.push({
      paymentId: r.id, type: r.type, invoiceNumber: r.invoice_number, tenantId: r.tenant_id,
      tenantName: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'Resident',
      unitNumber: r.unit_number, propertyName: r.property_name, notes: r.notes,
      readingId: r.reading_id, readingStatus: r.reading_status,
    })
  }
  return out
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const voided = await voidZeroLines(c)
    console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${voided.length} open $0 line(s) voided:`)
    for (const v of voided) {
      console.log(`  ${v.propertyName ?? '—'} ${v.unitNumber ?? '—'} · ${v.tenantName} · ${v.invoiceNumber ?? 'no bill'} · ${v.type} $0.00`
        + ` · payment ${v.paymentId}${v.readingId ? ` · reading ${v.readingId} stays ${v.readingStatus}` : ''}`
        + (v.notes ? `\n      ${v.notes}` : ''))
    }
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
