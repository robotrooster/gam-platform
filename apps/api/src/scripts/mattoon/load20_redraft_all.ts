/**
 * S652 — Every Country Acres packet re-drafted from today's templates.
 *
 * Nic: "Just re-draft all of his packets." A document is a copy of its
 * template taken at draft time, so last night's packets carry last night's
 * templates. Nothing has been billed and no tenant has signed, so: the invite
 * row is written for every household first (an existing tenancy — so the
 * landlord's signature bills from October, never history), every document is
 * VOIDED (the leases Blu's signatures issued are unwound by the same routine
 * the void button uses; the pending sales are cancelled by the void trigger),
 * and load16 drafts the lot fresh, in lot order, one email per lot to Blu.
 *     npx ts-node src/scripts/mattoon/load20_redraft_all.ts [--apply]
 *     then: NODE_ENV=production npx ts-node src/scripts/mattoon/load16_everyone_on_their_package.ts --apply --only 1,6,11,17,18,21,22,24,28,29,30
 */
import { query, getClient } from '../../db'
import { voidDocument } from '../../lib/voidDocument'
import fs from 'fs'

const APPLY = process.argv.includes('--apply')
const PROPERTY = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'
const LANDLORD = 'e8904104-ab16-4d02-b6f8-cac88d738aae'
const LOTS = ['1', '6', '11', '17', '18', '21', '22', '24', '28', '29', '30']

async function main() {
  const sheet: any[] = JSON.parse(fs.readFileSync(__dirname + '/lots.json', 'utf8'))
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const q = (t: string, v?: any[]) => c.query(t, v)
    for (const lot of LOTS) {
      const label = `MH ${lot.padStart(2, '0')}`
      const unit = (await q(`SELECT id FROM units WHERE property_id=$1 AND unit_number=$2 AND retired_at IS NULL`, [PROPERTY, label])).rows[0]
      if (!unit) throw new Error(`${label} not found`)
      const row = sheet.find((r) => String(r.lot) === lot)
      const household: string[] = String(row?.tenant ?? '').split(/\n/).map((n: string) => n.trim()).filter(Boolean)
      const residents = (await q(
        `SELECT t.id AS tenant_id, u.first_name||' '||u.last_name AS name FROM users u JOIN tenants t ON t.user_id=u.id
          WHERE u.role='tenant' AND u.first_name||' '||u.last_name = ANY($1::text[])`, [household])).rows
      if (!residents.length) throw new Error(`${label}: no resident account`)

      // 1. The invite row: this is an existing tenancy.
      let intents = 0
      for (const r of residents) {
        const ins = await q(
          `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, unit_id, property_id, is_existing_tenancy, parser_status)
           SELECT $1,$2,$3,$4,TRUE,'not_uploaded'
            WHERE NOT EXISTS (SELECT 1 FROM pending_tenant_intents i WHERE i.tenant_id=$2 AND i.unit_id=$3 AND i.cancelled_at IS NULL)
           RETURNING id`, [LANDLORD, r.tenant_id, unit.id, PROPERTY])
        intents += ins.rowCount ?? 0
      }
      await q(`UPDATE pending_tenant_intents SET is_existing_tenancy=TRUE, updated_at=NOW() WHERE unit_id=$1 AND cancelled_at IS NULL AND NOT is_existing_tenancy`, [unit.id])

      // 2. Void the packet; the lease it issued is unwound by the same routine.
      const docs = (await q(`SELECT * FROM lease_documents WHERE unit_id=$1 AND status NOT IN ('voided','completed') ORDER BY document_type <> 'original_lease', package_sort_order`, [unit.id])).rows
      for (const d of docs) await voidDocument(q as any, d, 'Re-drafted from the updated templates (S652)')
      const lease = (await q(`SELECT status FROM leases WHERE unit_id=$1 ORDER BY created_at DESC LIMIT 1`, [unit.id])).rows[0]
      const sale = (await q(`SELECT string_agg(status, ',') AS s FROM home_sale_contracts WHERE unit_id=$1`, [unit.id])).rows[0]
      console.log(`${label}: ${residents.map((r: any) => r.name).join(' + ')} — invite rows added ${intents}; voided ${docs.length} document(s); lease now ${lease?.status ?? 'none'}; sales ${sale?.s ?? 'none'}`)
    }
    const left = (await q(`SELECT count(*)::int AS n FROM payments WHERE landlord_id=$1 AND status='pending'`, [LANDLORD])).rows[0].n
    console.log(`pending charges on the landlord: ${left}`)
    await c.query(APPLY ? 'COMMIT' : 'ROLLBACK')
    console.log(APPLY ? 'APPLIED' : '(dry run — nothing written)')
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}
main().then(() => process.exit(0), e => { console.error(e.message ?? e); process.exit(1) })
