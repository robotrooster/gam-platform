import { queryOne } from '../db'
import { streetNumber, streetTokens } from './addressVerification'

// ============================================================
// S616 (Nic) — are these two spaces near enough to be the same place?
//
// This started as a street-level test and Nic threw it out for the right
// reason: it gated on the ONE field nobody is sure of.
//
//   "Whatever I'm gonna name my next door neighbor's thing as should be
//    irrelevant to the matchup. We don't necessarily know the exact physical
//    address of the place next door... a landlord may not want to put that in,
//    or put it incorrectly. If it's a multiunit building they're not gonna know
//    which unit it is. So we need to make that not gated on getting it right...
//    It could be next door but the address could be way different, because it
//    could be a corner lot facing on the other street.
//
//    So we just need to look at: one, match it to the name; two, match it to
//    the same town; three, match it to them already having a user profile."
//
// The typed service address describes SOMEBODY ELSE'S BUILDING. Requiring it to
// line up meant the feature failed exactly where the landlord was least certain,
// and a corner lot fails it while being literally next door.
//
// What is reliable is what each landlord entered about THEIR OWN property. So
// the address test is the TOWN, and the deciding signal is the PERSON — the
// same human pays one landlord for utilities and the other for rent (enforced
// by the caller, services/crossPropertyAutoLink). A street-level agreement is
// still recorded when it happens, because it belongs in the audit trail; it
// just no longer decides anything.
//
// NOT the county parcel corpus, and not coordinates. Nic, on the first attempt:
// "we have no way to know if two landlords next to each other in a completely
// different state are gonna onboard tomorrow. It can't be gated on data that we
// don't have everywhere else yet." Half the properties in the database have no
// coordinates at all.
// ============================================================

export type AdjacencyBasis = 'same_address' | 'same_street' | 'same_town' | 'none'

export interface AdjacencyResult {
  basis: AdjacencyBasis
  /** True when GAM has enough to ask three people about it. */
  matched: boolean
  /** Plain-language evidence, shown on every approval screen — the people
   *  consenting should see WHY GAM thinks these are one place. */
  evidence: string
}

/** Postcodes compare on the first five digits: 85362 and 85362-1234 are one
 *  postcode, and the +4 is noise a landlord may or may not have typed. Used on
 *  the STRUCTURED zip column, where the whole value is the postcode. */
function zip5(zip: string | null | undefined): string | null {
  const m = (zip ?? '').match(/\d{5}/)
  return m ? m[0] : null
}

/**
 * A postcode inside a free-text address line, if there is one.
 *
 * NOT the same job as zip5, and conflating them was a real defect: a bare
 * five-digit scan reads the STREET NUMBER as a postcode, and Oak Park's own
 * address is "22658 Highway 89". That made the strongest branch below compare
 * "22658" against the property's real 85362, decide the postcodes disagreed,
 * and silently downgrade a same-address match to a weaker one.
 *
 * So the leading street number is removed first, and only a five-digit group
 * after it counts. A typed service address usually has no postcode at all,
 * which is why its absence must never be read as a mismatch.
 */
function zipFromFreeText(line: string | null | undefined): string | null {
  const withoutStreetNumber = (line ?? '').replace(/^\s*\d{1,6}\b/, '')
  const m = withoutStreetNumber.match(/\b\d{5}\b/)
  return m ? m[0] : null
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Do two street descriptions name the same street? Distinctive tokens only,
 *  so "W Second St" and "Second Street" agree and "Second" and "Third" do not. */
function sameStreet(a: string, b: string): boolean {
  const ta = streetTokens(a)
  const tb = streetTokens(b)
  if (ta.length === 0 || tb.length === 0) return false
  return ta.some(t => tb.includes(t))
}

/** How far apart two street numbers may be and still be neighbours. Even and
 *  odd sides of a street run in twos, and a wide parcel can swallow several
 *  numbers, so this is deliberately loose — it only has to be tight enough to
 *  exclude the far end of the street. */
export const ADJACENT_NUMBER_SPAN = 24

export interface AddressParts {
  street1: string | null
  city: string | null
  state?: string | null
  zip: string | null
}

/**
 * Are the two PROPERTIES even in the same town?
 *
 * This gate exists because the strongest signal — the service address the
 * utility landlord typed — is free text that rarely carries a postcode. Without
 * this, "1442 W Second St" in Yarnell AZ matches "1442 W Second St" in Akron OH
 * on street and number alone, and reports it as the SAME ADDRESS. Numbered and
 * named streets repeat in every town in the country; nothing about the street
 * line can tell them apart.
 *
 * Same postcode is the ordinary case. The city+state alternative is there
 * because postcode boundaries genuinely run down the middle of some streets,
 * and two neighbours on opposite sides of one should not be refused.
 */
function sameLocality(a: AddressParts, b: AddressParts): boolean {
  const za = zip5(a.zip), zb = zip5(b.zip)
  if (za && zb && za === zb) return true
  const ca = norm(a.city), cb = norm(b.city)
  const sa = norm(a.state), sb = norm(b.state)
  return !!ca && ca === cb && !!sa && sa === sb
}

/**
 * Compare the address a utility landlord typed for the space he serves against
 * the address of a unit's property.
 */
export function compareAddresses(
  serviceAddress: string | null,
  serviceProperty: AddressParts,
  unitProperty: AddressParts,
): AdjacencyResult {
  // THE GATE: the same town. Both sides of this comparison are what a landlord
  // entered about their OWN property, so both are as reliable as anything GAM
  // holds. Same postcode is the ordinary case; city+state is the alternative
  // because postcode boundaries genuinely run down the middle of some streets.
  if (!sameLocality(serviceProperty, unitProperty)) {
    return {
      basis: 'none',
      matched: false,
      evidence: 'Those two properties are not in the same town, so GAM will not link them.',
    }
  }

  const town = norm(unitProperty.city) || 'the same town'
  const unitStreet = unitProperty.street1 ?? ''
  const svcStreet = serviceProperty.street1 ?? ''

  // Everything below only makes the EVIDENCE better. None of it can refuse a
  // link, because the typed service address is the field Nic explicitly said
  // must not gate anything.
  if (serviceAddress && unitStreet) {
    const svcNum = streetNumber(serviceAddress)
    const unitNum = streetNumber(unitStreet)
    const streetsAgree = sameStreet(serviceAddress, unitStreet)
    if (streetsAgree && svcNum && unitNum && svcNum === unitNum) {
      return {
        basis: 'same_address', matched: true,
        evidence: `The address recorded for the serviced space (${serviceAddress}) is the same address as this unit's property (${unitStreet}).`,
      }
    }
    if (streetsAgree && svcNum && unitNum
        && Math.abs(Number(svcNum) - Number(unitNum)) <= ADJACENT_NUMBER_SPAN) {
      return {
        basis: 'same_street', matched: true,
        evidence: `The serviced space is recorded at ${serviceAddress}; this unit's property is ${unitStreet} — the same street, a few numbers apart.`,
      }
    }
  }

  if (svcStreet && unitStreet && sameStreet(svcStreet, unitStreet)) {
    const a = streetNumber(svcStreet), b = streetNumber(unitStreet)
    if (a && b && Math.abs(Number(a) - Number(b)) <= ADJACENT_NUMBER_SPAN) {
      return {
        basis: 'same_street', matched: true,
        evidence: `${svcStreet} and ${unitStreet} are on the same street in ${town} — a few numbers apart.`,
      }
    }
  }

  // The ordinary answer, and a sufficient one. A corner lot addressed on the
  // other street lands here, which is the whole point of not gating on streets.
  return {
    basis: 'same_town', matched: true,
    evidence: `Both properties are in ${town}${unitProperty.zip ? ' ' + (zip5(unitProperty.zip) ?? '') : ''}, and the same person pays utilities at one and rents the other.`,
  }
}

/** The same comparison, loading both sides by id. */
export async function checkUnitAgainstAgreement(
  serviceAgreementId: string, unitId: string,
): Promise<AdjacencyResult> {
  const svc = await queryOne<any>(
    `SELECT sa.service_address, p.street1, p.city, p.state, p.zip
       FROM utility_service_agreements sa
       JOIN units u      ON u.id = sa.unit_id
       JOIN properties p ON p.id = u.property_id
      WHERE sa.id = $1`, [serviceAgreementId])
  if (!svc) return { basis: 'none', matched: false, evidence: 'Service agreement not found.' }

  const unit = await queryOne<any>(
    `SELECT p.street1, p.city, p.state, p.zip
       FROM units u JOIN properties p ON p.id = u.property_id
      WHERE u.id = $1`, [unitId])
  if (!unit) return { basis: 'none', matched: false, evidence: 'Unit not found.' }

  return compareAddresses(
    svc.service_address,
    { street1: svc.street1, city: svc.city, state: svc.state, zip: svc.zip },
    { street1: unit.street1, city: unit.city, state: unit.state, zip: unit.zip },
  )
}
