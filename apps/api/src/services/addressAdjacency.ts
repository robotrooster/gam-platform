import { queryOne } from '../db'
import { streetNumber, streetTokens } from './addressVerification'

// ============================================================
// S616 (Nic) — is this unit at the place I already supply?
//
// Nic, rejecting the first attempt: "Don't use the Arizona parcel data. We have
// no way to know if two landlords next to each other in a completely different
// state are gonna onboard tomorrow. It can't be gated on data that we don't
// have everywhere else yet. It needs to be address matched, not parcel matched."
//
// He is right twice over. The parcel corpus is AZ-only, and the coordinates the
// first attempt actually used are barely better: HALF the properties in the
// database have none, because a geocoder that cannot place a rural address
// leaves them null. A check that silently does nothing for half the platform is
// not a check.
//
// THE SIGNAL WE ALREADY HAVE, AND I WALKED PAST IT. When a landlord sets up a
// serviced space he types the service address — the address of the place next
// door that he supplies. When that neighbour's landlord later onboards, HE types
// the address of the same building. Two people, independently, describing one
// physical place. That is the match, it is pure text, and it works identically
// in Yarnell and in Ohio.
//
// The second case is the one where nobody typed a service address, or the
// utility landlord described it loosely ("the blue house"). Then the fallback is
// what "next door" literally means: the same street in the same postcode, with
// street numbers close together.
//
// WHAT THIS IS FOR. It decides whether GAM may RAISE the question on its own.
// It is never the authority for converging anything — three people still have
// to approve, and a human can always propose a link this never spots. So a miss
// costs a suggestion, not the feature.
// ============================================================

export type AdjacencyBasis = 'same_address' | 'same_street' | 'none'

export interface AdjacencyResult {
  basis: AdjacencyBasis
  /** True when GAM has enough to ask three people about it. */
  matched: boolean
  /** Plain-language evidence, shown on every approval screen — the people
   *  consenting should see WHY GAM thinks these are one place. */
  evidence: string
}

/** Postcodes compare on the first five digits: 85362 and 85362-1234 are one
 *  postcode, and the +4 is noise a landlord may or may not have typed. */
function zip5(zip: string | null | undefined): string | null {
  const m = (zip ?? '').match(/\d{5}/)
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
  const unitZip = zip5(unitProperty.zip)
  const unitStreet = unitProperty.street1 ?? ''

  // Two spaces cannot be next door if the properties are not in the same town.
  // Checked FIRST so no branch below can report a confident match on a street
  // name that happens to repeat a thousand miles away.
  if (!sameLocality(serviceProperty, unitProperty)) {
    return {
      basis: 'none',
      matched: false,
      evidence: 'Those two properties are not in the same town, so GAM will not suggest linking them.',
    }
  }

  // ── 1. The typed service address vs the other landlord's own address ──
  // The strongest thing available, because two different people described the
  // same place without seeing each other's answer.
  if (serviceAddress && unitStreet) {
    const svcNum = streetNumber(serviceAddress)
    const unitNum = streetNumber(unitStreet)
    const streetsAgree = sameStreet(serviceAddress, unitStreet)
    // A typed service address rarely carries a postcode, so the postcode is
    // corroboration when present and never a requirement.
    const svcZip = zip5(serviceAddress)
    const zipOk = !svcZip || !unitZip || svcZip === unitZip

    if (streetsAgree && zipOk && svcNum && unitNum && svcNum === unitNum) {
      return {
        basis: 'same_address',
        matched: true,
        evidence: `The address recorded for the serviced space (${serviceAddress}) is the same address as this unit's property (${unitStreet}).`,
      }
    }
    if (streetsAgree && zipOk && svcNum && unitNum
        && Math.abs(Number(svcNum) - Number(unitNum)) <= ADJACENT_NUMBER_SPAN) {
      return {
        basis: 'same_street',
        matched: true,
        evidence: `The serviced space is recorded at ${serviceAddress}; this unit's property is ${unitStreet} — the same street, a few numbers apart.`,
      }
    }
  }

  // ── 2. No usable service address: fall back to the two PROPERTIES ──
  // Literally what "next door" means — same street, same postcode, numbers
  // close together.
  const svcStreet = serviceProperty.street1 ?? ''
  const svcPropZip = zip5(serviceProperty.zip)
  if (svcStreet && unitStreet && svcPropZip && unitZip && svcPropZip === unitZip) {
    const a = streetNumber(svcStreet)
    const b = streetNumber(unitStreet)
    if (sameStreet(svcStreet, unitStreet) && a && b
        && Math.abs(Number(a) - Number(b)) <= ADJACENT_NUMBER_SPAN) {
      return {
        basis: 'same_street',
        matched: true,
        evidence: `${svcStreet} and ${unitStreet} are on the same street in ${norm(unitProperty.city) || 'the same town'} ${unitZip} — a few numbers apart.`,
      }
    }
  }

  return {
    basis: 'none',
    matched: false,
    evidence: 'GAM could not tell from the addresses that these are the same place, so it will not suggest the link on its own. Someone who knows they are can still propose it.',
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
