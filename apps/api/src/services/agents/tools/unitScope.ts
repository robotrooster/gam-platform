/**
 * S636 (Nic, DIRECTIVE): "Every single action towards a unit is absolutely a
 * hundred percent scoped to that property. Because when I onboard five other
 * parks with the same types of unit numbers, that's gonna be a problem."
 *
 * Unit numbers are unique only WITHIN a property. Oak Park and Mountain View
 * both have an RV 24, an RV 28, an RV 34 and an MH 09, and every park after them
 * will collide too. The agent tools resolved a spoken unit with
 *
 *     WHERE unit_number ILIKE $1 AND landlord_id = ANY(...) ORDER BY … LIMIT 1
 *
 * so with two matches they silently picked one — which books an inspection, a
 * payment or an expense against the wrong park and says nothing about it.
 *
 * Same shape as resolveActorCompany (S634): one match is unambiguous and needs
 * no question; several is a question, not a guess. A landlord who says "RV 28"
 * while owning two of them has not told us which, and inventing an answer is
 * worse than a conversational turn.
 */
import { query } from '../../../db'
import { actorLandlordIds, type AgentActor } from './types'

export type UnitChoice =
  | { ok: true; unitId: string; unitNumber: string; propertyId: string; propertyName: string }
  | { ok: false; error: string }

export async function resolveActorUnit(
  actor: AgentActor,
  spokenUnit: unknown,
  spokenProperty?: unknown,
): Promise<UnitChoice> {
  const needle = String(spokenUnit ?? '').trim()
  if (!needle) return { ok: false, error: 'Which unit?' }

  const rows = await query<{
    id: string; unit_number: string; property_id: string; property_name: string
  }>(
    `SELECT u.id, u.unit_number, p.id AS property_id, p.name AS property_name
       FROM units u
       JOIN properties p ON p.id = u.property_id
      WHERE u.landlord_id = ANY($1::uuid[])
        AND u.unit_number ILIKE $2
      ORDER BY p.name, u.unit_number`,
    [actorLandlordIds(actor), needle],
  )

  if (rows.length === 0) {
    return { ok: false, error: `No unit “${needle}” on your account. Check the unit number.` }
  }
  if (rows.length === 1) {
    const r = rows[0]
    return { ok: true, unitId: r.id, unitNumber: r.unit_number,
             propertyId: r.property_id, propertyName: r.property_name }
  }

  // Several properties have a unit by this number. If they named one, use it.
  const prop = String(spokenProperty ?? '').trim().toLowerCase()
  if (prop) {
    const hits = rows.filter(r => r.property_name.toLowerCase().includes(prop))
    if (hits.length === 1) {
      const r = hits[0]
      return { ok: true, unitId: r.id, unitNumber: r.unit_number,
               propertyId: r.property_id, propertyName: r.property_name }
    }
    if (hits.length === 0) {
      return { ok: false,
        error: `You have a ${needle} but not at a property called “${spokenProperty}”. `
             + `It is at: ${rows.map(r => r.property_name).join(', ')}.` }
    }
  }
  return { ok: false,
    error: `${needle} exists at more than one of your properties `
         + `(${rows.map(r => r.property_name).join(', ')}). Which one?` }
}

/** The `property` parameter a tool using the resolver above should declare. */
export const UNIT_PROPERTY_PARAM = {
  property: {
    type: 'string',
    description:
      'Which property the unit is at, by name (e.g. "Oak Park"). Only needed when the same '
      + 'unit number exists at more than one — leave blank and you will be told which to choose from.',
  },
} as const
