/**
 * 10/5 (Nic): "Yes, add them" — everyone who already ran a background check for
 * a company becomes a customer at that company's register (the same record a new
 * screening now makes; services/posPeople applicantRegisterRecord).
 *
 *   npx ts-node src/scripts/oct5_applicants_to_register.ts            # DRY: lists who
 *   npx ts-node src/scripts/oct5_applicants_to_register.ts --apply    # writes
 *
 * Renter-pool checks (no company of their own) are left out. Idempotent.
 */
import { db, query } from '../db'
import { applicantRegisterRecord } from '../services/posPeople'
import { getPoolIntakeShell } from '../services/poolIntake'

async function main() {
  const apply = process.argv.includes('--apply')
  // The renter pool's intake company is GAM's, not a landlord's: left out.
  const shell = await getPoolIntakeShell()
  const rows = await query<{ landlord_id: string; tenant_id: string; first_name: string | null; last_name: string | null; business_name: string | null; has_record: boolean }>(
    `SELECT DISTINCT ON (bc.landlord_id, bc.tenant_id)
            bc.landlord_id, bc.tenant_id, bc.first_name, bc.last_name, l.business_name,
            EXISTS (SELECT 1 FROM pos_customers pc WHERE pc.landlord_id = bc.landlord_id
                      AND pc.tenant_id = bc.tenant_id AND pc.archived_at IS NULL) AS has_record
       FROM background_checks bc
       JOIN landlords l ON l.id = bc.landlord_id
      WHERE bc.tenant_id IS NOT NULL
        AND bc.landlord_id IS DISTINCT FROM $1::uuid
      ORDER BY bc.landlord_id, bc.tenant_id, bc.created_at DESC`, [shell?.landlordId ?? null])
  for (const r of rows) {
    console.log(`${r.has_record ? 'already' : (apply ? 'adding ' : 'would add')}  ${r.business_name ?? r.landlord_id} · ${r.first_name ?? ''} ${r.last_name ?? ''}`)
    if (apply) await applicantRegisterRecord(db, r.landlord_id, r.tenant_id, { firstName: r.first_name, lastName: r.last_name })
  }
  console.log(`${rows.length} applicant(s) ${apply ? 'on the register' : '— DRY, nothing written'}`)
  await db.end()
}
main().catch(e => { console.error(e); process.exit(1) })
