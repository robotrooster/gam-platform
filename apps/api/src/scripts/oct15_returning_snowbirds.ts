/**
 * 10/15 (Nic, urgent): "I've drafted two leases, one for Kay Howard and one for
 * Clint Cook. I forgot to do that through the workflow of them having been here
 * before ... I want you to hurry and migrate those so that they don't get
 * prompted for the background check because they're two of my snowbirds that
 * come seasonally."
 *
 * Both were invited to a space at Mountain View this morning with no door
 * chosen, so each would be asked to screen when they open the invite. This
 * takes the returning-resident door for them instead, through the same
 * function the invite modal calls (services/onboardingWindow
 * applyReturningResidentWaive): the attestation is recorded against Nic, and
 * it counts against the property's rolling-365-day allowance (25 of 100
 * sites, none used yet). Nothing else about either lease changes, and neither
 * resident is emailed.
 *
 *   npx ts-node -T src/scripts/oct15_returning_snowbirds.ts           (dry run)
 *   npx ts-node -T src/scripts/oct15_returning_snowbirds.ts --apply
 */
import { query } from '../db'
import { applyReturningResidentWaive, returningAllowanceFor } from '../services/onboardingWindow'

const APPLY = process.argv.includes('--apply')
const MOUNTAIN_VIEW = '96ec7df3-362d-4777-b54c-e9604313820f'
const PROPERTY = 'dcccb7b8-7ac9-4ec2-b3ff-40bde536df01'
const NIC = '8b2f26ad-173a-45cb-9c59-f7a27bfa81e3'

const PEOPLE = [
  { who: 'Kay Howard', tenantId: '52af5509-10a3-429a-9f97-88aef59269a4', unit: 'RV 21' },
  { who: 'Clint Cook', tenantId: '1a61b0f4-1e35-4523-baa6-3b83bbd7ebe2', unit: 'RV 18' },
]

async function state(tenantId: string) {
  // The same three things GET /api/background/status reads to decide whether
  // the tenant portal opens on the background-check page (routes/background).
  return (await query<{ screened: string; checks: string; waiver: string | null; spaces: string }>(
    `SELECT COALESCE(t.background_check_status, 'not_started') AS screened,
            (SELECT COALESCE(string_agg(b.status, ', '), 'none') FROM background_checks b WHERE b.user_id = t.user_id) AS checks,
            (SELECT i.waive_reason FROM pending_tenant_intents i
              WHERE i.tenant_id = t.id AND i.screening_waived = true AND i.cancelled_at IS NULL
              ORDER BY i.screening_waived_at DESC NULLS LAST LIMIT 1) AS waiver,
            (SELECT COALESCE(string_agg(DISTINCT u.unit_number, ', '), '-') FROM pending_tenant_intents i2
               JOIN units u ON u.id = i2.unit_id
              WHERE i2.tenant_id = t.id AND i2.cancelled_at IS NULL) AS spaces
       FROM tenants t WHERE t.id = $1`, [tenantId]))[0]
}

async function main() {
  const a0 = await returningAllowanceFor(PROPERTY, {})
  console.log(`Mountain View returning allowance: ${a0.used} used of ${a0.allowance} in the last 365 days\n`)

  for (const p of PEOPLE) {
    const unitId = (await query<{ id: string }>(
      `SELECT id FROM units WHERE property_id = $1 AND unit_number = $2`, [PROPERTY, p.unit]))[0]?.id
    if (!unitId) throw new Error(`${p.who}: no space ${p.unit} at Mountain View`)
    const before = await state(p.tenantId)
    if (!before) throw new Error(`${p.who}: no tenant record`)
    console.log(`${p.who} (${p.unit}; invited to ${before.spaces}): screening ${before.screened}, ` +
      `checks on file ${before.checks}, waiver ${before.waiver ?? 'none — the portal would open on the background check'}`)
    if (before.waiver === 'returning_resident') { console.log('  already a returning resident — nothing to do\n'); continue }
    if (!APPLY) { console.log('  would take the returning-resident door (attested by Nic)\n'); continue }
    const r = await applyReturningResidentWaive({
      tenantId: p.tenantId, landlordId: MOUNTAIN_VIEW, propertyId: PROPERTY, unitId, byUserId: NIC,
    })
    const after = await state(p.tenantId)
    console.log(`  done: waiver ${after.waiver}; no background check asked for; allowance now ${r.used} of ${r.allowance}\n`)
  }
  console.log(APPLY ? 'APPLIED' : 'DRY RUN — nothing written (pass --apply)')
  process.exit(0)
}

main().catch(e => { console.error('FAILED:', e?.message ?? e); process.exit(1) })
