/**
 * 10/14 (Nic) — Mountain View's mobile home spaces, as they really are.
 *
 *   D1. "'3' is actually space 3.5, a new space not in GAM yet: add 'MH 3.5',
 *       double-wide, $589, vacant, park-owned trailer for sale. MH 03 stays
 *       single-wide $460 (owner use)."
 *   D2. "Double-wide rents to $589: MH 11 and MH 26 (MH 09, MH 19 already
 *       $589). Doubles: 3.5, 9, 11, 19, 26."
 *   D3. "Tag Mountain View mobile homes 'Single wide' / 'Double wide'
 *       (subtypes; describe only, never price)."
 *   I7. "Every VACANT mobile home space at Mountain View has a park-owned
 *       trailer for sale (vacant now: MH 11, 12, 14, 17, 24, 26) → mark
 *       park-owned." ("we will not rent them for our operation only sell")
 *
 * What it does, at Mountain View only:
 *   1. Adds the space MH 3.5: a mobile home space (canonical number "MH 3.5" —
 *      the back-end name; no printed label, so the lease prints the number,
 *      gam-backend-name-vs-printed-name), vacant, space rent $589.00, the
 *      trailer the park's (dwelling_ownership 'landlord'). Every other setting
 *      is MH 09's — exactly the columns retire-and-replace carries from one
 *      record of a space to the next (routes/units UNIT_CLONE_COPIED); the ones
 *      it resets stay reset (a new identity, no eviction state, no pending
 *      activation, no On-Time Pay). No meter, no lease, no charge: a new
 *      vacant space is never billed and costs no GAM fee.
 *   2. Space rent $589.00 on MH 11 and MH 26 (both vacant).
 *   3. The trailer the park's (dwelling_ownership 'landlord') on the vacant
 *      spaces MH 11, 12, 14, 17, 24, 26 and MH 3.5.
 *   4. The mobile home subtypes: Double wide = MH 3.5, 09, 11, 19, 26; Single
 *      wide = every other mobile home space (MH 03 among them). Mountain View
 *      already has "Single Wide" and "Double Wide" (created 9/2); those are
 *      used (one class each — never a second "Single wide" beside "Single
 *      Wide"), and are created only when missing. A space carries exactly one
 *      of the two; any other tag it has is left alone. Classify only: nothing
 *      reads a subtype's price, and nothing here touches one.
 *   MH 03 is left as it is (single-wide, owner use, $460) — the run says so.
 *
 * No tenant's bill can change: a space whose rent or trailer owner changes
 * must be vacant with no lease (active or pending) — the run refuses, changing
 * nothing, otherwise. The lease is law: rent on a lease never reads a space's
 * rent; a tag never prices. Run twice, the second run finds nothing to do.
 *
 * DRY RUN BY DEFAULT — read-only (reads production, writes nothing; it can run
 * with default_transaction_read_only on), printing every row it would change.
 * --apply writes it all in one transaction.
 *   cd apps/api && npx ts-node -T src/scripts/oct14_mountain_view_spaces.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct14_mountain_view_spaces.ts --apply
 */
import type { PoolClient } from 'pg'
import { canonicalUnitNumber } from '@gam/shared'
import { getClient } from '../db'
import { UNIT_CLONE_COPIED } from '../routes/units'

export const MOUNTAIN_VIEW = {
  landlordId: '96ec7df3-362d-4777-b54c-e9604313820f',
  propertyId: 'dcccb7b8-7ac9-4ec2-b3ff-40bde536df01',
} as const

export const NEW_SPACE = canonicalUnitNumber('mobile_home', 'MH 3.5')
export const COPY_FROM = 'MH 09'
export const DOUBLE_RENT = 589
export const DOUBLES = [NEW_SPACE, 'MH 09', 'MH 11', 'MH 19', 'MH 26']
export const RENT_TO_589 = ['MH 11', 'MH 26']
export const PARK_OWNED = ['MH 11', 'MH 12', 'MH 14', 'MH 17', 'MH 24', 'MH 26', NEW_SPACE]
export const SINGLE_NAME = 'Single wide'
export const DOUBLE_NAME = 'Double wide'

type Q = Pick<PoolClient, 'query'>

interface Space {
  id: string; unit_number: string; status: string; rent_amount: string; dwelling_ownership: string | null; leased: boolean
  links: Array<{ id: string; name: string }>
}

export interface SpacesPlan {
  refused: string | null
  addSpace: { copyFrom: { id: string; number: string }; unitNumber: string; rent: number; columns: Record<string, unknown> } | null
  rents: Array<{ unitId: string; number: string; from: string; to: number }>
  ownership: Array<{ unitId: string | null; number: string; from: string | null; to: 'landlord' }>
  subtypes: { single: { id: string | null; name: string }; double: { id: string | null; name: string } }
  links: Array<{ unitId: string | null; number: string; add: 'single' | 'double'; remove: Array<{ id: string; name: string }> }>
  mh03: string | null
}

async function readSpaces(q: Q, propertyId: string): Promise<Space[]> {
  return (await q.query<Space>(
    `SELECT u.id, u.unit_number, u.status, u.rent_amount::text AS rent_amount, u.dwelling_ownership,
            EXISTS (SELECT 1 FROM leases l WHERE l.unit_id = u.id AND l.status IN ('active','pending')) AS leased,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) ORDER BY s.name)
                        FROM unit_subtype_links k JOIN property_unit_subtypes s ON s.id = k.subtype_id
                       WHERE k.unit_id = u.id), '[]'::jsonb) AS links
       FROM units u
      WHERE u.property_id = $1 AND u.unit_type = 'mobile_home' AND u.retired_at IS NULL
      ORDER BY u.unit_number`, [propertyId])).rows
}

/** Read-only: everything --apply would change, row by row. */
export async function planMountainViewSpaces(q: Q, at: { landlordId: string; propertyId: string } = MOUNTAIN_VIEW): Promise<SpacesPlan> {
  const plan: SpacesPlan = {
    refused: null, addSpace: null, rents: [], ownership: [],
    subtypes: { single: { id: null, name: SINGLE_NAME }, double: { id: null, name: DOUBLE_NAME } }, links: [], mh03: null,
  }
  const prop = (await q.query<{ landlord_id: string }>(`SELECT landlord_id FROM properties WHERE id = $1`, [at.propertyId])).rows[0]
  if (!prop || prop.landlord_id !== at.landlordId) { plan.refused = 'Mountain View is not where it was (property or owner changed)'; return plan }
  const spaces = await readSpaces(q, at.propertyId)
  const byNumber = new Map(spaces.map(s => [s.unit_number, s]))
  // Every number named must be one of the property's mobile home spaces.
  for (const n of new Set([COPY_FROM, ...DOUBLES, ...RENT_TO_589, ...PARK_OWNED].filter(x => x !== NEW_SPACE))) {
    if (!byNumber.has(n)) { plan.refused = `${n} is not a mobile home space at Mountain View`; return plan }
  }
  // No tenant's bill may change: every space whose rent or trailer owner
  // changes is vacant, with no lease.
  for (const n of new Set([...RENT_TO_589, ...PARK_OWNED].filter(x => x !== NEW_SPACE))) {
    const s = byNumber.get(n)!
    if (s.status !== 'vacant' || s.leased) { plan.refused = `${n} is not vacant (status ${s.status}${s.leased ? ', a lease holds it' : ''}) — nothing changed`; return plan }
  }
  const any = await q.query(`SELECT 1 FROM units WHERE property_id = $1 AND lower(btrim(unit_number)) = lower($2)`, [at.propertyId, NEW_SPACE])
  const newSpace = byNumber.get(NEW_SPACE)
  if (any.rows.length && !newSpace) { plan.refused = `${NEW_SPACE} exists but is not a live mobile home space — look before adding it`; return plan }
  if (!newSpace) {
    const src = byNumber.get(COPY_FROM)!
    const row = (await q.query<Record<string, unknown>>(
      `SELECT ${UNIT_CLONE_COPIED.join(', ')} FROM units WHERE id = $1`, [src.id])).rows[0]
    plan.addSpace = {
      copyFrom: { id: src.id, number: src.unit_number }, unitNumber: NEW_SPACE, rent: DOUBLE_RENT,
      columns: { ...row, rent_amount: DOUBLE_RENT.toFixed(2), dwelling_ownership: 'landlord', subtype_id: null },
    }
  } else if (newSpace.leased || newSpace.status !== 'vacant') {
    plan.refused = `${NEW_SPACE} is no longer vacant — nothing changed`; return plan
  }
  for (const n of RENT_TO_589) {
    const s = byNumber.get(n)!
    if (Number(s.rent_amount) !== DOUBLE_RENT) plan.rents.push({ unitId: s.id, number: n, from: s.rent_amount, to: DOUBLE_RENT })
  }
  if (newSpace && Number(newSpace.rent_amount) !== DOUBLE_RENT) {
    plan.rents.push({ unitId: newSpace.id, number: NEW_SPACE, from: newSpace.rent_amount, to: DOUBLE_RENT })
  }
  for (const n of PARK_OWNED) {
    const s = byNumber.get(n)
    if (!s) continue // the new space is written park-owned
    if (s.dwelling_ownership !== 'landlord') plan.ownership.push({ unitId: s.id, number: n, from: s.dwelling_ownership, to: 'landlord' })
  }
  // The two classes: the property's own, whatever their capitals.
  const classes = (await q.query<{ id: string; name: string }>(
    `SELECT id, name FROM property_unit_subtypes WHERE property_id = $1 AND unit_type = 'mobile_home'
        AND lower(btrim(name)) IN (lower($2), lower($3)) ORDER BY created_at, id`, [at.propertyId, SINGLE_NAME, DOUBLE_NAME])).rows
  const single = classes.find(c => c.name.trim().toLowerCase() === SINGLE_NAME.toLowerCase())
  const double = classes.find(c => c.name.trim().toLowerCase() === DOUBLE_NAME.toLowerCase())
  plan.subtypes = { single: { id: single?.id ?? null, name: single?.name ?? SINGLE_NAME }, double: { id: double?.id ?? null, name: double?.name ?? DOUBLE_NAME } }
  const wide = new Set([single?.id, double?.id].filter((x): x is string => !!x))
  const all = [...spaces.map(s => s.unit_number), ...(newSpace ? [] : [NEW_SPACE])]
  for (const n of all) {
    const s = byNumber.get(n)
    const want: 'single' | 'double' = DOUBLES.includes(n) ? 'double' : 'single'
    const wantId = want === 'double' ? double?.id : single?.id
    const has = (s?.links ?? []).filter(l => wide.has(l.id))
    const remove = has.filter(l => l.id !== wantId)
    const present = !!wantId && has.some(l => l.id === wantId)
    if (!present || remove.length) plan.links.push({ unitId: s?.id ?? null, number: n, add: want, remove })
  }
  const mh03 = byNumber.get('MH 03')
  if (mh03) {
    const tag = mh03.links.filter(l => wide.has(l.id)).map(l => l.name).join(', ') || 'no wide tag yet'
    plan.mh03 = `MH 03 left as it is: ${mh03.status}, $${mh03.rent_amount}, ${tag}${plan.links.some(l => l.number === 'MH 03') ? ' (tagged Single wide below)' : ''}.`
  }
  return plan
}

/** Inside the caller's transaction: writes what the plan says. */
export async function applyMountainViewSpaces(q: Q, plan: SpacesPlan, at: { landlordId: string; propertyId: string } = MOUNTAIN_VIEW): Promise<{ newSpaceId: string | null }> {
  if (plan.refused) throw new Error(plan.refused)
  let newSpaceId: string | null = null
  if (plan.addSpace) {
    const cols = { ...plan.addSpace.columns, property_id: at.propertyId, landlord_id: at.landlordId }
    const names = [...Object.keys(cols), 'unit_number', 'status']
    const values = [...Object.values(cols), plan.addSpace.unitNumber, 'vacant']
    newSpaceId = (await q.query<{ id: string }>(
      `INSERT INTO units (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, values)).rows[0].id
  }
  for (const r of plan.rents) {
    await q.query(`UPDATE units SET rent_amount = $2, updated_at = NOW() WHERE id = $1 AND status = 'vacant'`, [r.unitId, r.to.toFixed(2)])
  }
  for (const o of plan.ownership) {
    await q.query(`UPDATE units SET dwelling_ownership = 'landlord', updated_at = NOW() WHERE id = $1 AND status = 'vacant'`, [o.unitId])
  }
  const ensure = async (s: { id: string | null; name: string }) => s.id ?? (await q.query<{ id: string }>(
    `INSERT INTO property_unit_subtypes (property_id, unit_type, name) VALUES ($1, 'mobile_home', $2) RETURNING id`,
    [at.propertyId, s.name])).rows[0].id
  const ids = { single: await ensure(plan.subtypes.single), double: await ensure(plan.subtypes.double) }
  for (const l of plan.links) {
    const unitId = l.unitId ?? newSpaceId
    if (!unitId) throw new Error(`No space for ${l.number}`)
    for (const r of l.remove) await q.query(`DELETE FROM unit_subtype_links WHERE unit_id = $1 AND subtype_id = $2`, [unitId, r.id])
    await q.query(`INSERT INTO unit_subtype_links (unit_id, subtype_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [unitId, ids[l.add]])
  }
  return { newSpaceId }
}

export function describeSpacesPlan(plan: SpacesPlan): string[] {
  if (plan.refused) return [`  Refused, nothing changed: ${plan.refused}`]
  const out: string[] = []
  const nothing = !plan.addSpace && !plan.rents.length && !plan.ownership.length && !plan.links.length
    && !!plan.subtypes.single.id && !!plan.subtypes.double.id
  if (nothing) out.push('  Nothing to change: Mountain View already reads this way.')
  if (plan.addSpace) {
    const c = plan.addSpace.columns
    out.push(`  Add space ${plan.addSpace.unitNumber} (mobile home, vacant, space rent $${plan.addSpace.rent.toFixed(2)}, the trailer the park's), its other settings ${plan.addSpace.copyFrom.number}'s:`)
    out.push(`    ${Object.entries(c).filter(([k]) => !['property_id', 'landlord_id'].includes(k)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`)
  }
  for (const r of plan.rents) out.push(`  ${r.number} (${r.unitId}): space rent $${r.from} → $${r.to.toFixed(2)} (vacant, no lease)`)
  for (const o of plan.ownership) out.push(`  ${o.number} (${o.unitId ?? 'new'}): trailer owner ${o.from ?? 'not set'} → the park's (landlord) — vacant, for sale`)
  for (const s of [plan.subtypes.single, plan.subtypes.double]) if (!s.id) out.push(`  Create the mobile home subtype "${s.name}"`)
  for (const l of plan.links) {
    const name = l.add === 'double' ? plan.subtypes.double.name : plan.subtypes.single.name
    out.push(`  ${l.number}${l.unitId ? ` (${l.unitId})` : ''}: tag "${name}"${l.remove.length ? `, untag ${l.remove.map(r => `"${r.name}"`).join(', ')}` : ''}`)
  }
  if (plan.mh03) out.push(`  ${plan.mh03}`)
  out.push('  No lease, charge, bill or GAM fee changes: every space whose rent or trailer owner changes is vacant with no lease; tags never price.')
  return out
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const c = await getClient()
  try {
    if (!apply) {
      const plan = await planMountainViewSpaces(c)
      console.log('DRY RUN (read-only)')
      for (const w of describeSpacesPlan(plan)) console.log(w)
      console.log('Nothing written. Re-run with --apply to write.')
      return
    }
    await c.query('BEGIN')
    const plan = await planMountainViewSpaces(c)
    console.log('APPLY')
    for (const w of describeSpacesPlan(plan)) console.log(w)
    if (plan.refused) { await c.query('ROLLBACK'); return }
    const r = await applyMountainViewSpaces(c, plan)
    await c.query('COMMIT')
    console.log(`Committed.${r.newSpaceId ? ` ${NEW_SPACE} is ${r.newSpaceId}.` : ''}`)
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
