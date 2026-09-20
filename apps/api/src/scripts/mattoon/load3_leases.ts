/**
 * S651 — Mattoon load, stage 3: lease documents, drafted for Blu only.
 *
 * Uses draftHouseholdLease, the same path a normal invite takes, so this is a
 * real test of the signing package rather than a special case built beside it.
 * That matters here: Nic wants to find out whether the flow works on a live
 * park, and a bespoke loader would have proved nothing.
 *
 * NOTHING IS SENT. createDocumentRecord writes rows and mails nobody, and the
 * landlord is signer 1 with residents 2..N — so even when signing requests do
 * go out, a tenant cannot be reached until Blu has signed. Nic: "send it to
 * Blu, don't let anything go to any tenants yet."
 */
import { query } from '../../db'
import { draftHouseholdLease } from '../../services/householdLeaseDraft'
import fs from 'fs'

const DRY = process.env.DRY === '1'
const SRC = __dirname + '/lots.json'
const PROPERTY = 'e9743bfa-1972-4e40-8a1b-ad76a52a17b9'
const LANDLORD = 'e8904104-ab16-4d02-b6f8-cac88d738aae'

async function main() {
  const rows: any[] = JSON.parse(fs.readFileSync(SRC, 'utf8'))
  const seen = new Set<string>()
  const occ = rows.filter((r) => {
    const ok = /^\d+$/.test(r.lot) && r.tenant && r.tenant.toLowerCase() !== 'vacant' && !seen.has(r.lot)
    if (ok) seen.add(r.lot)
    return ok
  })

  let drafted = 0, skipped = 0
  for (const r of occ) {
    const unitNumber = `Lot ${r.lot}`
    const unit = await query<any>(
      `SELECT id FROM units WHERE property_id=$1 AND unit_number=$2 AND retired_at IS NULL`,
      [PROPERTY, unitNumber])
    if (!unit.length) { console.log(`  ${unitNumber.padEnd(8)} no such unit — skipped`); skipped++; continue }

    // Residents are resolved by the addresses on the sheet. A household whose
    // mailbox belongs to somebody else on GAM (Lot 1) has no account here and
    // is skipped rather than guessed at.
    const emails = [...new Set(String(r.email ?? '').split(/\n/).map((e: string) => e.trim().toLowerCase()).filter(Boolean))]
    const residents = await query<any>(
      `SELECT u.id AS user_id, u.first_name||' '||u.last_name AS name, u.email, u.phone
         FROM users u WHERE lower(u.email) = ANY($1::text[]) AND u.role = 'tenant'
        ORDER BY array_position($1::text[], lower(u.email))`, [emails])
    if (!residents.length) {
      console.log(`  ${unitNumber.padEnd(8)} no tenant account (${emails.join(', ') || 'no email on the sheet'}) — skipped`)
      skipped++; continue
    }

    if (DRY) {
      console.log(`  ${unitNumber.padEnd(8)} would draft for ${residents.map((x: any) => x.name).join(', ')}`)
      drafted++; continue
    }
    const res = await draftHouseholdLease({
      landlordId: LANDLORD, unitId: unit[0].id,
      residents: residents.map((x: any) => ({
        userId: x.user_id, name: x.name, email: x.email, phone: x.phone,
      })),
    })
    if ((res as any).drafted) {
      console.log(`  ${unitNumber.padEnd(8)} drafted  ${(res as any).documentId}`)
      drafted++
    } else {
      console.log(`  ${unitNumber.padEnd(8)} NOT drafted — ${(res as any).reason}`)
      skipped++
    }
  }
  console.log(`\n${drafted} drafted · ${skipped} skipped`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
