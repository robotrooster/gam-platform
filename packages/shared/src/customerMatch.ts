/**
 * ONE GAM CUSTOMER PER PERSON — THE MATCH RULE (Nic, 10/25).
 *
 *   "Each customer has one GAM customer account, so we can see everywhere that
 *    they interact with GAM... anywhere that person pops up in GAM, it is one
 *    GAM account. It has to have at least three matching data points of
 *    information. It could be first name, last name, and phone number, or
 *    email, and it could be a payment method saved on file."
 *
 * So: THREE agreeing points, never fewer. The points are
 *
 *     first name · last name · phone · email · a saved payment method
 *
 * and the common shape is the obvious one — first name + last name + phone is
 * three. Two is how you merge strangers: "Mike Smith" and a shared area code is
 * not a person, and the cost of being wrong here is somebody's propane bill, or
 * their card, landing on the wrong account.
 *
 * WHY IT IS ALL IN ONE FILE. The register's lookup, the campground importer,
 * the business portal and the backfill all have to agree about who somebody is.
 * A second opinion about that is a duplicate customer, and a duplicate customer
 * is the thing this exists to stop.
 *
 * WHAT A POINT IS NOT. A point has to be present on BOTH sides to agree — two
 * records with no phone do not "match on phone". A blank is not a match, which
 * is why countMatchPoints only counts what both sides actually have.
 */

/** The worlds a GAM customer can turn up in (customer_profile_links.kind). */
export const CUSTOMER_LINK_KINDS = ['tenant', 'pos_customer', 'business_customer'] as const
export type CustomerLinkKind = typeof CUSTOMER_LINK_KINDS[number]

export const CUSTOMER_LINK_KIND_LABEL: Record<CustomerLinkKind, string> = {
  tenant:            'Resident',
  pos_customer:      'Register customer',
  business_customer: 'Business customer',
}

/** The data points a match may be made of. */
export const CUSTOMER_MATCH_POINTS = ['first_name', 'last_name', 'phone', 'email', 'payment_method'] as const
export type CustomerMatchPoint = typeof CUSTOMER_MATCH_POINTS[number]

/** Nic: "at least three matching data points of information." */
export const CUSTOMER_MATCH_POINTS_REQUIRED = 3

/** What GAM knows about one appearance of a person. */
export interface CustomerPoints {
  firstName?: string | null
  lastName?: string | null
  phone?: string | null
  email?: string | null
  /**
   * A saved payment method both sides share — Stripe's customer id is the
   * stand-in, since a card on file lives on it. Nic counts this as a point:
   * "it could be a payment method saved on file."
   */
  paymentMethodRef?: string | null
}

/** A name, for comparison: case and surrounding space never decide a person. */
export function normalizeName(v: string | null | undefined): string {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * A phone, for comparison: digits only, and a leading US 1 dropped so
 * +1 (928) 555-0100 and 9285550100 are the same number. Fewer than 10 digits
 * is not a phone number anybody can be matched on, so it counts as absent.
 */
export function normalizePhone(v: string | null | undefined): string {
  const d = String(v ?? '').replace(/\D/g, '')
  const n = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  return n.length >= 10 ? n : ''
}

/** An email, for comparison. */
export function normalizeEmail(v: string | null | undefined): string {
  return String(v ?? '').trim().toLowerCase()
}

export function normalizePoints(p: CustomerPoints): Record<CustomerMatchPoint, string> {
  return {
    first_name:     normalizeName(p.firstName),
    last_name:      normalizeName(p.lastName),
    phone:          normalizePhone(p.phone),
    email:          normalizeEmail(p.email),
    payment_method: String(p.paymentMethodRef ?? '').trim(),
  }
}

/**
 * Which points agree between two appearances. A point counts only when BOTH
 * sides have it — a blank is never a match.
 */
export function matchingPoints(a: CustomerPoints, b: CustomerPoints): CustomerMatchPoint[] {
  const x = normalizePoints(a)
  const y = normalizePoints(b)
  return CUSTOMER_MATCH_POINTS.filter(k => x[k] !== '' && x[k] === y[k])
}

export function countMatchPoints(a: CustomerPoints, b: CustomerPoints): number {
  return matchingPoints(a, b).length
}

/** The same person, by Nic's rule: three agreeing points or more. */
export function isSamePerson(a: CustomerPoints, b: CustomerPoints): boolean {
  return countMatchPoints(a, b) >= CUSTOMER_MATCH_POINTS_REQUIRED
}

/**
 * Can this appearance ever be matched to anybody? Three points have to exist
 * on it before three can agree — a register row holding only "Mike" never
 * identifies a person, and must not be merged into one.
 */
export function hasEnoughPointsToMatch(p: CustomerPoints): boolean {
  const n = normalizePoints(p)
  return CUSTOMER_MATCH_POINTS.filter(k => n[k] !== '').length >= CUSTOMER_MATCH_POINTS_REQUIRED
}

/** What a link says it matched on, in plain words for a person reading it. */
export function matchPointsSentence(points: readonly CustomerMatchPoint[]): string {
  const label: Record<CustomerMatchPoint, string> = {
    first_name: 'first name', last_name: 'last name', phone: 'phone',
    email: 'email', payment_method: 'a saved payment method',
  }
  const names = points.map(p => label[p])
  if (names.length === 0) return 'nothing'
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
