/**
 * S652 — Blu's signatures billed years of history. Take it back, keep the leases.
 *
 * The packets were drafted by script, so no INVITE existed for these households
 * — and the invite is where GAM learns "this is an existing tenancy". Issuance
 * read the lease start dates off Blu's sheet (2018, 2021, 2023…) as move-in
 * dates and billed the first month at each, then the late-fee job and the
 * monthly run piled on. Blu got "Day 2090" alerts; the tenants would have seen
 * rent owed since 2018.
 *
 * What this does, per lease Blu has signed: flags it as an existing tenancy,
 * removes the charges nobody ever owed and voids their invoices (the same
 * primitives unwindIssuedLease uses — a charge with nothing paid on it is
 * removed, an invoice is voided, never erased). The August water cycle was
 * billed by Blu himself before GAM; a void bill row per meter records that and
 * keeps the monthly run from billing it again — September's usage is the first
 * GAM bills, on October's invoice, as Nic said. And for the lots Blu has not
 * signed yet, the invite row is written now so their issuance is right.
 *     npx ts-node src/scripts/mattoon/load17_no_history_billed.ts [--apply]
 */
import { query, getClient } from '../../db'

const APPLY = process.argv.includes('--apply')
const PROPERTY = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'
const LANDLORD = 'e8904104-ab16-4d02-b6f8-cac88d738aae'
const CYCLE = '2026-08-01'

async function main() {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const q = async (t: string, v: any[] = []) => (await c.query(t, v)).rows

    // ── 1. The leases Blu's signatures issued ──────────────────────────────
    const leases = await q(
      `SELECT l.id, u.unit_number, l.start_date, l.is_existing_tenancy FROM leases l JOIN units u ON u.id=l.unit_id
        WHERE l.landlord_id=$1 AND u.property_id=$2 ORDER BY u.unit_number`, [LANDLORD, PROPERTY])
    for (const l of leases) {
      const moved = (await q(`SELECT count(*)::int AS n FROM payments WHERE lease_id=$1 AND status NOT IN ('pending','failed')`, [l.id]))[0].n
      if (moved) throw new Error(`${l.unit_number}: money already moved on this lease — stopping`)
      const charges = await q(`SELECT type, amount, due_date FROM payments WHERE lease_id=$1 OR invoice_id IN (SELECT id FROM invoices WHERE lease_id=$1)`, [l.id])
      const invoices = await q(`SELECT id, due_date, total_amount FROM invoices WHERE lease_id=$1`, [l.id])
      console.log(`${l.unit_number}  lease from ${l.start_date}  existing=${l.is_existing_tenancy} → TRUE;  remove ${charges.map((p: any) => `${p.type} $${p.amount} due ${p.due_date}`).join(', ') || 'nothing'};  void ${invoices.length} invoice(s)`)
      await q(`UPDATE leases SET is_existing_tenancy=TRUE, updated_at=NOW() WHERE id=$1`, [l.id])
      // Utility bills the run attached: the bill stays as the record that the
      // cycle is accounted for (Blu billed it), its charge goes.
      const bills = await q(`SELECT id, payment_id, billing_cycle_month, charge_amount FROM utility_bills WHERE lease_id=$1`, [l.id])
      for (const b of bills) {
        console.log(`  utility bill ${b.billing_cycle_month} $${b.charge_amount} → void (billed by the landlord before GAM)`)
        await q(`UPDATE utility_bills SET payment_id=NULL, status='void', updated_at=NOW(),
                        notes=COALESCE(notes||' — ','')||'void: this cycle was billed by the landlord before the tenancy came onto GAM' WHERE id=$1`, [b.id])
        if (b.payment_id) await q(`DELETE FROM payments WHERE id=$1 AND status IN ('pending','failed')`, [b.payment_id])
      }
      await q(`DELETE FROM payments WHERE (lease_id=$1 OR invoice_id IN (SELECT id FROM invoices WHERE lease_id=$1)) AND status IN ('pending','failed')`, [l.id])
      await q(`DELETE FROM work_trade_settlements WHERE invoice_id IN (SELECT id FROM invoices WHERE lease_id=$1) AND status='open'`, [l.id])
      await q(`UPDATE invoices SET status='void', total_amount=0, updated_at=NOW(),
                      notes=COALESCE(notes||' — ','')||'void: billed history for an existing tenancy; GAM bills from October 2026' WHERE lease_id=$1`, [l.id])
      await q(`DELETE FROM security_deposits WHERE lease_id=$1 AND status='pending' AND COALESCE(collected_amount,0)=0 AND carried_from_deposit_id IS NULL`, [l.id])
    }

    // ── 2. The August water cycle is Blu's, on every meter ─────────────────
    // The Jul 28 → Aug 26 reads are the cycle Blu billed himself; GAM's first
    // bill is September's usage, on October's invoice. A read stamped
    // 'billed_off_platform' is not a cycle read (nothing bills from it) but it
    // is still the prior read September measures from.
    const reads = await q(
      `UPDATE utility_meter_readings r SET reason='billed_off_platform'
         FROM utility_meters m WHERE m.id=r.meter_id AND m.property_id=$1
          AND r.billing_cycle_month=$2 AND r.reason='monthly_cycle'
        RETURNING r.id`, [PROPERTY, CYCLE])
    console.log(`  August reads marked billed off platform: ${reads.length}`)

    // ── 3. The invite row for every household Blu has not signed yet ───────
    const unsigned = await q(
      `SELECT d.id AS doc_id, d.unit_id, u.unit_number, t.id AS tenant_id, s.name
         FROM lease_documents d JOIN units u ON u.id=d.unit_id
         JOIN lease_document_signers s ON s.document_id=d.id AND s.role IN ('primary','co_tenant_1','co_tenant_2','co_tenant_3')
         JOIN tenants t ON t.user_id=s.user_id
        WHERE u.property_id=$1 AND d.document_type='original_lease' AND d.status NOT IN ('voided','completed')
          AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.unit_id=d.unit_id AND l.status IN ('active','pending'))
          AND NOT EXISTS (SELECT 1 FROM pending_tenant_intents i WHERE i.tenant_id=t.id AND i.unit_id=d.unit_id AND i.cancelled_at IS NULL)`, [PROPERTY])
    for (const r of unsigned) {
      console.log(`  ${r.unit_number}: invite row for ${r.name} — existing tenancy, so the signature bills from October`)
      await q(`INSERT INTO pending_tenant_intents (landlord_id, tenant_id, unit_id, property_id, is_existing_tenancy, draft_document_id, parser_status)
               VALUES ($1,$2,$3,$4,TRUE,$5,'not_uploaded')`, [LANDLORD, r.tenant_id, r.unit_id, PROPERTY, r.doc_id])
    }

    const left = await q(`SELECT count(*)::int AS n FROM payments WHERE landlord_id=$1 AND status='pending'`, [LANDLORD])
    console.log(`\npending charges left on the landlord: ${left[0].n}`)
    await c.query(APPLY ? 'COMMIT' : 'ROLLBACK')
    console.log(APPLY ? 'APPLIED' : '(dry run — nothing written)')
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}
main().then(() => process.exit(0), e => { console.error(e.message ?? e); process.exit(1) })
