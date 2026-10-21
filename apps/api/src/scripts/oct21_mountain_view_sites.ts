/**
 * 10/21 (Nic) — TWO THINGS ABOUT MOUNTAIN VIEW'S RV SITES, FROM READING THE OLD
 * SYSTEM'S EXPORT BESIDE GAM.
 *
 *   RV 34. "Martin Alvarado is in 33. 34 is vacant, and it actually is a 50 amp
 *          space. I didn't know it was 50 amp. So we can change that setting as
 *          well for that site." (Campground Master had Alvarado on 34; GAM has
 *          him on 33 and GAM is right.)
 *
 *   RV 15A. "15A is a real site. It doesn't have an electric meter on it though,
 *           and we just had the guy move out. We can add that as a site, 15A.
 *           I'm only going to probably put a work trade person in there though,
 *           because we can't bill for electric until we finish our upgrades."
 *
 * WHAT IT DOES
 *   1. RV 34's power: 'both' — 30 amp AND 50. Not '50' alone, because every one
 *      of the twenty 50-amp sites at this park is recorded 'both' (a 50-amp
 *      pedestal there carries a 30 as well), and '50' alone would make GAM
 *      refuse a 30-amp rig on a site that can take one. If 34's pedestal really
 *      is 50 only, that is a one-word change.
 *   2. Adds RV 15A: an RV site, vacant, every other setting copied from RV 15
 *      next door — the same columns retire-and-replace carries from one record
 *      of a space to the next (routes/units UNIT_CLONE_COPIED). No meter, no
 *      lease, no charge. A vacant space is never billed, so it costs no GAM fee
 *      until somebody is on it, and with no meter nothing can bill utilities on
 *      it either, which is the point until the upgrades are done.
 *
 * Nothing here is money: a site's power rating and a new empty site change no
 * bill. It still refuses rather than guesses — if RV 34 is not vacant, or 15A
 * already exists as something else, it changes nothing and says so.
 *
 * DRY RUN BY DEFAULT — reads production, writes nothing (it runs fine with
 * default_transaction_read_only on), printing every row it would change.
 *   cd apps/api && npx ts-node -T src/scripts/oct21_mountain_view_sites.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct21_mountain_view_sites.ts --apply
 */
import type { PoolClient } from 'pg'
import { getClient } from '../db'
import { UNIT_CLONE_COPIED } from '../routes/units'

export const MOUNTAIN_VIEW = {
  landlordId: '96ec7df3-362d-4777-b54c-e9604313820f',
  propertyId: 'dcccb7b8-7ac9-4ec2-b3ff-40bde536df01',
} as const

/** The site whose power rating was wrong, and what it really is. */
export const AMP_FIX = { number: 'RV 34', to: 'both' as const }
/** The site that was never in GAM, and the neighbour whose settings it takes. */
export const NEW_SITE = { number: 'RV 15A', copyFrom: 'RV 15' }

type Q = Pick<PoolClient, 'query'>

interface Site { id: string; unit_number: string; status: string; rv_amp_service: string; leased: boolean }

export interface SitesPlan {
  refused: string | null
  amp: { unitId: string; number: string; from: string; to: string } | null
  addSite: { copyFrom: { id: string; number: string }; unitNumber: string; columns: Record<string, unknown> } | null
}

async function readSites(q: Q, propertyId: string): Promise<Site[]> {
  return (await q.query<Site>(
    `SELECT u.id, u.unit_number, u.status, u.rv_amp_service,
            EXISTS (SELECT 1 FROM leases l WHERE l.unit_id = u.id AND l.status IN ('active','pending')) AS leased
       FROM units u
      WHERE u.property_id = $1 AND u.unit_type = 'rv_spot' AND u.retired_at IS NULL
      ORDER BY u.unit_number`, [propertyId])).rows
}

/** Read-only: everything --apply would change. */
export async function planMountainViewSites(q: Q, at: { landlordId: string; propertyId: string } = MOUNTAIN_VIEW): Promise<SitesPlan> {
  const plan: SitesPlan = { refused: null, amp: null, addSite: null }
  const prop = (await q.query<{ landlord_id: string }>(`SELECT landlord_id FROM properties WHERE id = $1`, [at.propertyId])).rows[0]
  if (!prop || prop.landlord_id !== at.landlordId) {
    plan.refused = 'Mountain View is not where it was (property or owner changed)'
    return plan
  }
  const sites = await readSites(q, at.propertyId)
  const byNumber = new Map(sites.map(s => [s.unit_number, s]))

  const amp = byNumber.get(AMP_FIX.number)
  if (!amp) { plan.refused = `${AMP_FIX.number} is not an RV site at Mountain View`; return plan }
  // Nic read it off the pedestal of a site he had just confirmed is EMPTY. A
  // site somebody is on is not one to re-rate from a conversation.
  if (amp.status !== 'vacant' || amp.leased) {
    plan.refused = `${AMP_FIX.number} is not vacant (status ${amp.status}${amp.leased ? ', a lease holds it' : ''}) — nothing changed`
    return plan
  }
  if (amp.rv_amp_service !== AMP_FIX.to) {
    plan.amp = { unitId: amp.id, number: amp.unit_number, from: amp.rv_amp_service, to: AMP_FIX.to }
  }

  const src = byNumber.get(NEW_SITE.copyFrom)
  if (!src) { plan.refused = `${NEW_SITE.copyFrom} is not an RV site at Mountain View, so there is nothing to copy ${NEW_SITE.number} from`; return plan }
  // Any row under that number, live or retired, is a reason to look before
  // adding a second one.
  const any = await q.query<{ unit_number: string; retired_at: string | null; unit_type: string }>(
    `SELECT unit_number, retired_at::text, unit_type FROM units
      WHERE property_id = $1 AND lower(btrim(unit_number)) = lower($2)`, [at.propertyId, NEW_SITE.number])
  const live = byNumber.get(NEW_SITE.number)
  if (any.rows.length && !live) {
    plan.refused = `${NEW_SITE.number} exists but is not a live RV site (${any.rows.map(r => `${r.unit_type}${r.retired_at ? `, retired ${r.retired_at.slice(0, 10)}` : ''}`).join('; ')}) — look before adding it`
    return plan
  }
  if (!live) {
    const row = (await q.query<Record<string, unknown>>(
      `SELECT ${UNIT_CLONE_COPIED.join(', ')} FROM units WHERE id = $1`, [src.id])).rows[0]
    plan.addSite = {
      copyFrom: { id: src.id, number: src.unit_number }, unitNumber: NEW_SITE.number,
      // A fresh site carries no class and no sub-type of its neighbour's.
      columns: { ...row, subtype_id: null },
    }
  }
  return plan
}

/** Inside the caller's transaction: writes what the plan says. */
export async function applyMountainViewSites(q: Q, plan: SitesPlan, at: { landlordId: string; propertyId: string } = MOUNTAIN_VIEW): Promise<{ newSiteId: string | null }> {
  if (plan.refused) throw new Error(plan.refused)
  if (plan.amp) {
    await q.query(`UPDATE units SET rv_amp_service = $2, updated_at = NOW() WHERE id = $1 AND status = 'vacant'`,
      [plan.amp.unitId, plan.amp.to])
  }
  let newSiteId: string | null = null
  if (plan.addSite) {
    const cols = { ...plan.addSite.columns, property_id: at.propertyId, landlord_id: at.landlordId }
    const names = [...Object.keys(cols), 'unit_number', 'status']
    const values = [...Object.values(cols), plan.addSite.unitNumber, 'vacant']
    newSiteId = (await q.query<{ id: string }>(
      `INSERT INTO units (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      values)).rows[0].id
  }
  return { newSiteId }
}

export function describeSitesPlan(plan: SitesPlan): string[] {
  if (plan.refused) return [`  Refused, nothing changed: ${plan.refused}`]
  const out: string[] = []
  out.push(plan.amp
    ? `  ${plan.amp.number} power: ${plan.amp.from} → ${plan.amp.to} (30 amp and 50, as the park's other 50-amp sites read)`
    : `  ${AMP_FIX.number} power is already ${AMP_FIX.to} — nothing to do`)
  out.push(plan.addSite
    ? `  Add ${plan.addSite.unitNumber}: an RV site, vacant, every other setting copied from ${plan.addSite.copyFrom.number} `
      + `(rent $${plan.addSite.columns.rent_amount}, nightly $${plan.addSite.columns.nightly_rate}, `
      + `weekly $${plan.addSite.columns.weekly_rate}, monthly $${plan.addSite.columns.monthly_rate}, `
      + `${plan.addSite.columns.rv_amp_service} amp, ${plan.addSite.columns.rv_site_layout}). No meter, no lease, no charge.`
    : `  ${NEW_SITE.number} is already a live RV site — nothing to do`)
  return out
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const c = await getClient()
  try {
    if (!apply) {
      const plan = await planMountainViewSites(c)
      console.log('DRY RUN (read-only)')
      for (const w of describeSitesPlan(plan)) console.log(w)
      console.log('Nothing written. Re-run with --apply to write.')
      return
    }
    await c.query('BEGIN')
    const plan = await planMountainViewSites(c)
    console.log('APPLY')
    for (const w of describeSitesPlan(plan)) console.log(w)
    if (plan.refused) { await c.query('ROLLBACK'); return }
    const r = await applyMountainViewSites(c, plan)
    await c.query('COMMIT')
    console.log(`Committed.${r.newSiteId ? ` ${NEW_SITE.number} is ${r.newSiteId}.` : ''}`)
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
