/**
 * Tool: get_unit_lease (landlord) — the lease on ONE unit the landlord names.
 *
 * S617 (Nic): "when does the lease end for spot number one?" A landlord had no
 * way to ask that. get_lease_expirations answers "what is ending soon", which is
 * a different question, and lookup_tenant_payment_status answers about money.
 * Asked about a specific unit's lease the agent had nothing to call, so it
 * either declined or reached for the wrong tool and asked another question.
 *
 * The lookup is deliberately forgiving, because people type the short lazy
 * version. Nic: "they are lazy... they take the shortest, easiest route to get
 * the information they want." So "spot 1", "RV one", "101", "Apt 101" all find
 * their way, and where that is genuinely ambiguous the answer is a QUESTION
 * about which property — never a guess between two units.
 */
import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface Row {
  unit_number: string | null
  property_name: string | null
  unit_type: string | null
  lease_id: string | null
  status: string | null
  start_date: string | null
  end_date: string | null
  rent_amount: string | null
  rent_due_day: number | null
  late_fee_grace_days: number | null
  tenant_name: string | null
}

/** Words that name exactly ONE kind of unit. Loose ones — "spot", "site",
 *  "lot", "unit" — are excluded on purpose: Nic uses them generically, so
 *  treating them as a type would silently pick a kind he did not mean. */
const TYPE_WORDS: Record<string, string> = {
  rv: 'rv_spot', campsite: 'campsite', apt: 'apartment', apartment: 'apartment',
  house: 'single_family', trailer: 'mobile_home', storage: 'storage',
  parking: 'parking', slip: 'boat_slip',
}

export const getUnitLease: AgentTool = {
  name: 'get_unit_lease',
  description:
    'The lease on ONE of this landlord’s units: who is in it, the rent, the due day, the grace ' +
    'period, and the start and end dates. Accepts however the landlord refers to it — "spot 1", ' +
    '"RV 01", "Apt 101", "101", or a property name with a unit. Use for "when does the lease end ' +
    'for X", "who is in X", "what is the rent on X", "is X leased". If the reference matches ' +
    'units at more than one property it returns the properties to choose between — ask which, ' +
    'then call this again with the property named.',
  parameters: {
    type: 'object',
    properties: {
      unit: { type: 'string', description: 'How the landlord referred to the unit, verbatim.' },
      property: { type: 'string', description: 'Property name, when they have narrowed it down.' },
    },
    required: ['unit'],
  },
  audiences: ['landlord'],

  async execute(args: Record<string, unknown>, actor: AgentActor) {
    let unit = String(args.unit ?? '').trim()

    // S617 (Nic's exact phrasing): "when does the lease end for spot number
    // one?" People say the number, they do not type it. Without this the digit
    // extraction finds nothing in "spot number one" and the tool reports no
    // match on a unit that plainly exists.
    const WORD_NUMBERS: Record<string, string> = {
      one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
      eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
      thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
      seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
    }
    if (!/\d/.test(unit)) {
      for (const [w, d] of Object.entries(WORD_NUMBERS)) {
        if (new RegExp(`\\b${w}\\b`, 'i').test(unit)) { unit = unit.replace(new RegExp(`\\b${w}\\b`, 'i'), d); break }
      }
    }
    const property = String(args.property ?? '').trim()
    if (!unit) return { ok: false, error: 'Say which unit — a number or name is enough.' }

    const named = Object.entries(TYPE_WORDS)
      .filter(([w, t]) => t && new RegExp(`\\b${w}\\b`, 'i').test(unit))
      .map(([, t]) => t)
    const typeFilter = named.length > 0 ? [...new Set(named)] : null

    let rows = await query<Row>(
      `SELECT un.unit_number, p.name AS property_name, un.unit_type,
              l.id AS lease_id, l.status, l.start_date, l.end_date,
              l.rent_amount, l.rent_due_day, l.late_fee_grace_days,
              NULLIF(TRIM(COALESCE(us.first_name,'') || ' ' || COALESCE(us.last_name,'')), '') AS tenant_name
         FROM units un
         JOIN properties p ON p.id = un.property_id
         LEFT JOIN leases l ON l.unit_id = un.id AND l.status = 'active'
         LEFT JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.status = 'active' AND lt.role = 'primary'
         LEFT JOIN tenants t ON t.id = lt.tenant_id
         LEFT JOIN users us ON us.id = t.user_id
        WHERE p.landlord_id = $1
          AND (
               un.unit_number ILIKE $2
            OR ($3 ~ '[0-9]'
                AND regexp_replace(un.unit_number, '[^0-9]', '', 'g') <> ''
                AND regexp_replace(un.unit_number, '[^0-9]', '', 'g')::bigint
                    = regexp_replace($3, '[^0-9]', '', 'g')::bigint)
          )
          AND ($4::text[] IS NULL OR un.unit_type = ANY($4))
          AND ($5 = '' OR p.name ILIKE '%' || $5 || '%')
        ORDER BY p.name, un.unit_number`,
      [actor.profileId, `%${unit}%`, unit, typeFilter, property]
    )

    // S617: "rv 1" also matched RV 10, because a substring search on "RV 1"
    // catches it. When the reference carries a number and some unit matches
    // that number EXACTLY, the loose substring hits are noise — drop them
    // rather than asking the landlord to choose between spot 1 and spot 10.
    const digits = unit.replace(/[^0-9]/g, '')
    const exactNumeric = digits
      ? rows.filter((r) => (r.unit_number ?? '').replace(/[^0-9]/g, '') !== '' &&
          Number((r.unit_number ?? '').replace(/[^0-9]/g, '')) === Number(digits))
      : []
    if (exactNumeric.length > 0 && exactNumeric.length < rows.length) rows = exactNumeric

    if (rows.length === 0) {
      return { ok: false, error: `Nothing in your portfolio matches “${unit}”${property ? ` at ${property}` : ''}. Ask them to check the unit number, or offer to list the units at a property.` }
    }

    // More than one PROPERTY -> that is the question worth asking. Never list
    // every unit: a portfolio of single-family homes would produce hundreds.
    const properties = [...new Set(rows.map((r) => r.property_name ?? '(unknown)'))]
    if (properties.length > 1) {
      return {
        ok: false,
        needsDisambiguation: true,
        scope: 'property',
        totalMatches: rows.length,
        message:
          `"${unit}" matches units at ${properties.length} of your properties. Ask WHICH PROPERTY, ` +
          'offer this list, and once they pick one call this tool again with that property named — ' +
          'then give them the answer rather than another question.',
        properties: properties.slice(0, 12),
      }
    }

    const describe = (r: Row) => ({
      property: r.property_name,
      unit: r.unit_number,
      unitType: r.unit_type,
      leased: !!r.lease_id,
      tenant: r.tenant_name,
      rent: r.rent_amount == null ? null : Number(r.rent_amount),
      rentDueDay: r.rent_due_day,
      lateFeeGraceDays: r.late_fee_grace_days,
      leaseStart: r.start_date,
      leaseEnd: r.end_date,
      note: r.lease_id ? undefined : 'No active lease — this unit is not currently rented.',
    })

    if (rows.length === 1) return { ok: true, matchedOn: 'unit', unit: describe(rows[0]) }
    return {
      ok: true,
      matchedOn: 'several-at-one-property',
      message: 'Several units at this property match. Give them the list and ask which.',
      units: rows.slice(0, 15).map(describe),
    }
  },
}
