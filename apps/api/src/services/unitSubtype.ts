/**
 * S613 — linking an existing unit to one of the property's subtypes.
 *
 * Nic: "I also wanna figure out how to link subtypes to different units because
 * there's nowhere that I can see that links those."
 *
 * He was right. `units.subtype_id` has existed since S527, but it was only ever
 * written at unit CREATION, never read back onto a screen and never editable —
 * so a landlord who defined "Back-in 50 amp" after adding his spaces had no way
 * to say which spaces were that. The subtype was a creation-time prefill and
 * nothing else.
 *
 * Two things happen when a unit is linked, and they are deliberately separate:
 *
 *   LINKING  is classification — "this space is one of those." It changes no
 *            money and no lease term, so it is allowed on an occupied unit.
 *   APPLYING copies the subtype's values onto the unit. The unit's own copy
 *            stays authoritative (the S527 posture), so this is a one-time
 *            push, not a live inheritance — editing the subtype later never
 *            silently rewrites units that were minted from it.
 *
 * Applying splits by what a signed lease commits:
 *
 *   PHYSICAL facts (layout, amp service, bed/bath, storage size, who owns the
 *   dwelling) are facts about the space. Recording that space 12 really is a
 *   50-amp back-in is a correction, and correcting it matters — the booking
 *   engine and the utility splits read those columns. Allowed while leased.
 *
 *   PRICING (rent, deposit, nightly/weekly/monthly) is committed to the signed
 *   lease. Never touched while a lease is active or pending; the caller is told
 *   which units were held back rather than being left to assume it applied.
 */
import { PoolClient } from 'pg'
import { db, query, queryOne } from '../db'

export interface UnitSubtypeRow {
  id: string
  property_id: string
  unit_type: string
  name: string
  bedrooms: number | null
  bathrooms: string | number | null
  rv_site_layout: string | null
  rv_amp_service: string | null
  storage_size: string | null
  dwelling_ownership: string | null
  rent_amount: string | number | null
  security_deposit: string | number | null
  nightly_rate: string | number | null
  weekly_rate: string | number | null
  monthly_rate: string | number | null
}

export interface ApplySubtypeResult {
  /** Units whose subtype_id now points at this subtype. */
  linked: number
  /** Units that had their physical facts copied from the subtype. */
  detailsApplied: number
  /** Unit numbers whose PRICING was held back because they are leased. */
  pricingHeldBack: string[]
}

export async function loadSubtype(subtypeId: string, propertyId: string): Promise<UnitSubtypeRow | null> {
  return queryOne<UnitSubtypeRow>(
    `SELECT * FROM property_unit_subtypes WHERE id=$1 AND property_id=$2`,
    [subtypeId, propertyId],
  )
}

/**
 * Set which units carry this subtype. MEMBERSHIP SEMANTICS: units in `unitIds`
 * are linked, and any unit currently on this subtype that is NOT in the list is
 * unlinked — the caller is editing a checklist, so an unchecked box has to mean
 * something. Retired units are never touched.
 */
export async function setSubtypeUnits(
  subtype: UnitSubtypeRow,
  unitIds: string[],
  opts: { applyDetails: boolean },
): Promise<ApplySubtypeResult> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    // Every unit must be on this property and of this subtype's unit type — a
    // subtype describes one kind of space, and an apartment subtype on an RV
    // spot would push bedroom counts onto a bare site.
    const targets = unitIds.length === 0 ? [] : (await client.query(
      `SELECT u.id, u.unit_number, u.unit_type, u.property_id, u.retired_at,
              EXISTS (SELECT 1 FROM leases l WHERE l.unit_id = u.id
                        AND l.status IN ('active','pending')) AS leased
         FROM units u WHERE u.id = ANY($1::uuid[])`,
      [unitIds],
    )).rows

    if (targets.length !== unitIds.length) throw new Error('One of those units no longer exists.')
    const offProperty = targets.find(u => u.property_id !== subtype.property_id)
    if (offProperty) throw new Error(`Unit ${offProperty.unit_number} isn't on this property.`)
    const retired = targets.find(u => u.retired_at)
    if (retired) throw new Error(`Unit ${retired.unit_number} is retired, so it can't be given a subtype.`)
    const wrongType = targets.find(u => u.unit_type !== subtype.unit_type)
    if (wrongType) {
      throw new Error(
        `Unit ${wrongType.unit_number} isn't the same kind of unit as this subtype, ` +
        `so its details don't apply. Change the unit's type first, or pick a subtype that matches.`)
    }

    // Unlink anything dropped from the list.
    await client.query(
      `UPDATE units SET subtype_id = NULL, updated_at = NOW()
        WHERE subtype_id = $1 AND retired_at IS NULL
          AND NOT (id = ANY($2::uuid[]))`,
      [subtype.id, unitIds],
    )

    const result: ApplySubtypeResult = { linked: targets.length, detailsApplied: 0, pricingHeldBack: [] }
    for (const u of targets) {
      await client.query(`UPDATE units SET subtype_id=$1, updated_at=NOW() WHERE id=$2`, [subtype.id, u.id])
      if (!opts.applyDetails) continue
      await applyDetailsToUnit(client, subtype, u)
      result.detailsApplied++
      if (u.leased) result.pricingHeldBack.push(u.unit_number)
    }

    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/** Copy the subtype's values onto ONE unit. Pricing is skipped while leased. */
async function applyDetailsToUnit(
  client: PoolClient,
  s: UnitSubtypeRow,
  u: { id: string; leased: boolean },
): Promise<void> {
  const isRv = s.unit_type === 'rv_spot'
  const hasBeds = ['apartment', 'single_family', 'mobile_home'].includes(s.unit_type)
  const ownershipRelevant = isRv || s.unit_type === 'mobile_home'

  // COALESCE against the unit's current value: a subtype that leaves a fact
  // blank is saying nothing about it, not saying "clear it".
  await client.query(
    `UPDATE units SET
       bedrooms          = CASE WHEN $2 THEN COALESCE($3::int, bedrooms) ELSE bedrooms END,
       bathrooms         = CASE WHEN $2 THEN COALESCE($4::numeric, bathrooms) ELSE bathrooms END,
       rv_site_layout    = CASE WHEN $5 THEN COALESCE($6::text, rv_site_layout) ELSE rv_site_layout END,
       rv_amp_service    = CASE WHEN $5 THEN COALESCE($7::text, rv_amp_service) ELSE rv_amp_service END,
       storage_size      = CASE WHEN $8 THEN COALESCE($9::text, storage_size) ELSE storage_size END,
       dwelling_ownership= CASE WHEN $10 THEN COALESCE($11::text, dwelling_ownership) ELSE dwelling_ownership END,
       updated_at = NOW()
     WHERE id = $1`,
    [u.id,
     hasBeds, s.bedrooms, s.bathrooms,
     isRv, s.rv_site_layout === 'none' ? null : s.rv_site_layout,
           s.rv_amp_service === 'none' ? null : s.rv_amp_service,
     s.unit_type === 'storage', s.storage_size,
     ownershipRelevant, s.dwelling_ownership],
  )

  if (u.leased) return   // rent and deposit belong to the signed lease

  await client.query(
    `UPDATE units SET
       rent_amount      = COALESCE($2::numeric, rent_amount),
       security_deposit = COALESCE($3::numeric, security_deposit),
       nightly_rate     = CASE WHEN $4 THEN COALESCE($5::numeric, nightly_rate) ELSE nightly_rate END,
       weekly_rate      = CASE WHEN $4 THEN COALESCE($6::numeric, weekly_rate)  ELSE weekly_rate  END,
       monthly_rate     = CASE WHEN $4 THEN COALESCE($7::numeric, monthly_rate) ELSE monthly_rate END,
       updated_at = NOW()
     WHERE id = $1`,
    [u.id, s.rent_amount, s.security_deposit, isRv, s.nightly_rate, s.weekly_rate, s.monthly_rate],
  )
}

/** Link ONE unit (or clear it with subtypeId = null). Used by the unit page. */
export async function linkUnitToSubtype(
  unit: { id: string; unit_number: string; unit_type: string; property_id: string; leased: boolean },
  subtypeId: string | null,
  opts: { applyDetails: boolean },
): Promise<{ subtype: UnitSubtypeRow | null; pricingHeldBack: boolean }> {
  if (subtypeId === null) {
    await query(`UPDATE units SET subtype_id=NULL, updated_at=NOW() WHERE id=$1`, [unit.id])
    return { subtype: null, pricingHeldBack: false }
  }
  const s = await loadSubtype(subtypeId, unit.property_id)
  if (!s) throw new Error('That subtype is not on this property.')
  if (s.unit_type !== unit.unit_type) {
    throw new Error(
      `"${s.name}" describes a different kind of unit, so its details don't apply here. ` +
      `Pick a subtype for this unit's type, or change the unit's type first.`)
  }
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query(`UPDATE units SET subtype_id=$1, updated_at=NOW() WHERE id=$2`, [s.id, unit.id])
    if (opts.applyDetails) await applyDetailsToUnit(client, s, unit)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
  return { subtype: s, pricingHeldBack: opts.applyDetails && unit.leased }
}
