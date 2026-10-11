// S647 one-time: draft leases for households invited under the old flow who
// never accepted, so the landlord can sign first. Uses the same functions the
// invite route uses — no private copy of the drafting rules.
import { db, getClient } from '../db'
import { autoDraftLeasesForUnit } from '../services/leaseOnboarding'
import { createDocumentRecord, autoSendDraftedDocument } from '../routes/esign'

const APPLY = process.argv.includes('--apply')

async function main() {
  const units = await db.query<any>(`
    SELECT DISTINCT pti.unit_id, pr.name AS property, u.unit_number
      FROM pending_tenant_intents pti
      JOIN units u ON u.id = pti.unit_id
      JOIN properties pr ON pr.id = u.property_id
     WHERE pti.resolved_at IS NULL AND pti.cancelled_at IS NULL
       AND pti.draft_document_id IS NULL
     ORDER BY pr.name, u.unit_number`)
  console.log(`${units.rows.length} space(s)\n`)
  for (const r of units.rows) {
    const where = `${r.property} · ${r.unit_number}`
    if (!APPLY) { console.log(`DRY  ${where}`); continue }
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const out = await autoDraftLeasesForUnit(client as any, r.unit_id, createDocumentRecord)
      await client.query('COMMIT')
      for (const id of out.draftedDocumentIds) {
        await autoSendDraftedDocument(id, { emailFirstSigner: false })
      }
      console.log(out.draftedDocumentIds.length
        ? `OK   ${where}  drafted ${out.draftedDocumentIds.length}`
        : `SKIP ${where}  not drafted — see the landlord notification`)
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => {})
      console.log(`FAIL ${where}  ${e.message}`)
    } finally { client.release() }
  }
  await db.end()
}
main().catch(e => { console.error(e); process.exit(1) })
