/**
 * S652 — Lot 8 (Vickie Kimery): her home burned down before onboarding began;
 * the sheet was never updated. Nic: "hers needs to be gone completely." GAM
 * never erases — the packet is VOIDED (nine documents), the pending home sale
 * is cancelled by the void trigger, and her invite row is cancelled.
 *     npx ts-node src/scripts/mattoon/load19_void_lot8.ts
 */
import { query, getClient } from '../../db'
import { voidDocument } from '../../lib/voidDocument'

async function main() {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const q = (t: string, v?: any[]) => c.query(t, v)
    const docs = await q(`SELECT d.* FROM lease_documents d JOIN units u ON u.id=d.unit_id
                           WHERE u.property_id='e9743bfa-1972-4e40-8a1b-ad76a52a17b9' AND u.unit_number='MH 08' AND d.status<>'voided'`).then(r => r.rows)
    for (const d of docs) { await voidDocument(q as any, d, 'The home on Lot 8 burned down before onboarding; the sheet was out of date.'); console.log('voided', d.title) }
    const intents = await q(`UPDATE pending_tenant_intents SET cancelled_at=NOW(), updated_at=NOW()
                              WHERE unit_id=(SELECT id FROM units WHERE property_id='e9743bfa-1972-4e40-8a1b-ad76a52a17b9' AND unit_number='MH 08')
                                AND cancelled_at IS NULL RETURNING id`).then(r => r.rowCount)
    console.log('invites cancelled', intents)
    const sale = await q(`SELECT status FROM home_sale_contracts WHERE unit_id=(SELECT id FROM units WHERE property_id='e9743bfa-1972-4e40-8a1b-ad76a52a17b9' AND unit_number='MH 08')`).then(r => r.rows.map(x => x.status))
    console.log('home sale now', sale)
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}
main().then(() => process.exit(0), e => { console.error(e.message ?? e); process.exit(1) })
