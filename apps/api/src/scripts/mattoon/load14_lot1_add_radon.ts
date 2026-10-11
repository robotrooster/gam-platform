/**
 * S652 — the two radon papers join the Lot 1 packet.
 *
 * The package left them out because the unit is a SALE and the radon disclosure
 * is marked for rentals. The Sheptocks are renting the lot and buying the home
 * on installments — until payoff the park still owns the dwelling they live in,
 * and Nic wants the radon papers in Blu's packet. Same signers, same packet,
 * numbered after what is already there.
 *     npx ts-node src/scripts/mattoon/load14_lot1_add_radon.ts
 */
import { query, queryOne, getClient } from '../../db'
import { createDocumentRecord } from '../../routes/esign'

const GROUP = '3878f05e-62b6-4144-af65-b986f4ae8988'

async function main() {
  const lease = await queryOne<any>(
    `SELECT d.*, u.unit_number, p.name AS property_name FROM lease_documents d
       JOIN units u ON u.id = d.unit_id JOIN properties p ON p.id = u.property_id
      WHERE d.package_group_id=$1 AND d.document_type='original_lease'`, [GROUP])
  if (!lease) throw new Error('Lot 1 packet not found')
  const signers = await query<any>(
    `SELECT s.user_id AS "userId", s.role, s.name, s.email, s.phone, s.order_index AS "orderIndex"
       FROM lease_document_signers s WHERE s.document_id=$1 ORDER BY s.order_index`, [lease.id])
  const last = await queryOne<{ n: number }>(`SELECT COALESCE(MAX(package_sort_order),0)::int AS n FROM lease_documents WHERE package_group_id=$1`, [GROUP])
  const have = await query<any>(`SELECT template_id FROM lease_documents WHERE package_group_id=$1`, [GROUP])
  const held = new Set(have.map((h: any) => h.template_id))

  const client = await getClient()
  try {
    await client.query('BEGIN')
    let order = (last?.n ?? 0) + 1
    for (const needle of ['Disclosure of Information on Radon Hazards', 'Radon Guide for Tenants']) {
      const t = await queryOne<any>(
        `SELECT id, name, base_pdf_url FROM lease_templates WHERE landlord_id=$1 AND is_active AND name ILIKE $2`,
        [lease.landlord_id, `%${needle}%`])
      if (!t) throw new Error(`Blu has no template like "${needle}"`)
      if (held.has(t.id)) { console.log(`already in: ${t.name}`); continue }
      const doc = await createDocumentRecord(client, {
        landlordId: lease.landlord_id, templateId: t.id, unitId: lease.unit_id, leaseId: null,
        title: `${t.name} — ${lease.unit_number}`, basePdfUrl: t.base_pdf_url, documentType: 'addendum_terms',
        targetLeaseTenantId: null, promoteLeaseTenantId: null, signers, prefillValues: {},
        packageGroupId: GROUP, packageId: lease.package_id, packageSortOrder: order++,
      } as any)
      // The packet is already with Blu; these travel with it.
      await client.query(`UPDATE lease_documents SET status='sent', sent_at=NOW(), updated_at=NOW() WHERE id=$1`, [doc.id])
      console.log(`added: ${doc.title}`)
    }
    await client.query('COMMIT')
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
  const n = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM lease_documents WHERE package_group_id=$1`, [GROUP])
  console.log(`packet now ${n?.n} documents`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
