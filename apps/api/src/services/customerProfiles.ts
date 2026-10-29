/**
 * ONE GAM CUSTOMER PER PERSON (Nic, 10/25).
 *
 *   "Each customer has one GAM customer account, so we can see everywhere that
 *    they interact with GAM. My mechanic uses GAM for invoices and quotes. My
 *    little grocery store uses it for inventory and point of sale. And customers
 *    that live here, that use that mechanic, that go to that grocery store,
 *    they're just automatically a customer at all three based on phone number
 *    match."
 *
 * This file is the spine: it decides WHO somebody is, records every place they
 * turn up, and is careful about who may see that.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * Three agreeing data points, never fewer (packages/shared customerMatch —
 * one definition for the register, the importer, the business portal and the
 * backfill). SQL narrows the candidates; the shared rule decides. Nothing here
 * re-implements the counting.
 *
 * ── WHAT CROSSES BETWEEN BUSINESSES, AND WHAT NEVER DOES ────────────────────
 * Nic, on the same subject earlier: "none of the sensitive information, none of
 * their payment history, their banking information, none of their lease
 * details... Name and phone number should be visible between different
 * properties." And, on the reservation lookup: it "won't tell me what other
 * parks they've necessarily stayed at, or when, or where."
 *
 * So there are two different reads here and they are not interchangeable:
 *
 *   lookupForBusiness()  — what the register, a reservation or the mechanic
 *                          gets: a NAME and a PHONE, so they can pick a person
 *                          they have seen before instead of retyping them. It
 *                          never says where else that person appears, and
 *                          carries no email, no balance, no history, no card.
 *
 *   appearancesForAdmin() — the whole picture, for GAM's own staff only. This
 *                          is the "see everywhere that they interact with GAM"
 *                          view, and it is deliberately not a landlord's.
 *
 * A caller who wants the second one has to say so and be a GAM admin; there is
 * no argument that quietly upgrades the first into the second.
 *
 * ── NOT BUILT YET, ON PURPOSE ───────────────────────────────────────────────
 * Using a saved payment method at another GAM business — the walletless idea.
 * Nic flagged the hole in it himself: "me just giving out somebody's phone
 * number and using their card to pay doesn't work... the person's account will
 * have to have some other sort of protection on there." Until that protection
 * is designed, a card stays with the business that took it. A shared payment
 * method is still read as a MATCH POINT here, which is only ever used to
 * recognise a person — never to charge one.
 */
import type { PoolClient } from 'pg'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import {
  isSamePerson, matchingPoints, hasEnoughPointsToMatch,
  normalizeName, normalizePhone, normalizeEmail,
  CUSTOMER_MATCH_POINTS_REQUIRED,
  type CustomerPoints, type CustomerLinkKind, type CustomerMatchPoint,
} from '@gam/shared'

type Client = PoolClient

/** Where an appearance lives, and who holds that record. */
export interface Appearance {
  kind: CustomerLinkKind
  refId: string
  landlordId?: string | null
  businessId?: string | null
}

const run = async <T = any>(client: Client | undefined, sql: string, params: any[]): Promise<T[]> =>
  client ? (await client.query(sql, params)).rows as T[] : query<T>(sql, params)

function rowPoints(r: any): CustomerPoints {
  return {
    firstName: r.first_name, lastName: r.last_name,
    phone: r.phone, email: r.email, paymentMethodRef: r.payment_method_ref ?? null,
  }
}

/**
 * The profiles that could be this person — narrowed in SQL by any single point
 * that could participate in a match, then decided by the shared rule. Cast
 * wide here on purpose: narrowing on two points in SQL would hide a person
 * whose third point is the one that differs.
 */
async function candidates(client: Client | undefined, p: CustomerPoints): Promise<any[]> {
  const phone = normalizePhone(p.phone)
  const email = normalizeEmail(p.email)
  const last = normalizeName(p.lastName)
  return run<any>(client,
    `SELECT id, first_name, last_name, phone, email
       FROM customer_profiles
      WHERE ($1 <> '' AND phone = $1)
         OR ($2 <> '' AND lower(email) = $2)
         OR ($3 <> '' AND lower(last_name) = $3)
      LIMIT 200`,
    [phone, email, last])
}

/**
 * WHO IS THIS? The one GAM customer for an appearance — found when three
 * points agree with somebody already known, created when they do not.
 *
 * Returns `null` when the appearance does not carry three points of its own: a
 * register row holding only "Mike" identifies nobody, and inventing a profile
 * for it would make a stranger GAM thinks it knows. Those rows stay unlinked
 * until somebody fills in a phone or an email.
 *
 * AMBIGUITY IS NOT RESOLVED BY GUESSING. When two different profiles both
 * match on three points, this refuses rather than picking one — the merge is a
 * person's decision (gam-left-owing-matching: "unsure → GAM admin").
 */
export async function resolveProfile(
  client: Client | undefined,
  points: CustomerPoints,
  at: Appearance,
): Promise<{ profileId: string; created: boolean; matchedOn: CustomerMatchPoint[] } | null> {
  if (!hasEnoughPointsToMatch(points)) return null

  // Already linked? The link is the answer; nothing is re-decided.
  const existing = await run<any>(client,
    `SELECT profile_id, matched_on FROM customer_profile_links WHERE kind = $1 AND ref_id = $2`,
    [at.kind, at.refId])
  if (existing.length) {
    return { profileId: existing[0].profile_id, created: false, matchedOn: existing[0].matched_on ?? [] }
  }

  const hits = (await candidates(client, points))
    .map(r => ({ row: r, points: matchingPoints(points, rowPoints(r)) }))
    .filter(h => h.points.length >= CUSTOMER_MATCH_POINTS_REQUIRED)

  const distinct = [...new Set(hits.map(h => h.row.id))]
  if (distinct.length > 1) {
    throw new AppError(409,
      'This person matches more than one GAM customer on three points. A GAM admin has to say which, '
      + 'because merging the wrong two puts one person\'s money on another\'s account.')
  }

  let profileId: string
  let created = false
  let matchedOn: CustomerMatchPoint[] = []
  if (hits.length) {
    profileId = hits[0].row.id
    matchedOn = hits[0].points
  } else {
    const made = await run<any>(client,
      `INSERT INTO customer_profiles (first_name, last_name, phone, email)
       VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''))
       RETURNING id`,
      [normalizeName(points.firstName) || '', normalizeName(points.lastName) || '',
       normalizePhone(points.phone), normalizeEmail(points.email)])
    profileId = made[0].id
    created = true
    // A new profile is this appearance's own points — it agrees with itself on
    // every point it has, which is at least the three that let it be created.
    matchedOn = matchingPoints(points, points)
  }

  await run(client,
    `INSERT INTO customer_profile_links (profile_id, kind, ref_id, landlord_id, business_id, matched_on, points)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (kind, ref_id) DO NOTHING`,
    [profileId, at.kind, at.refId, at.landlordId ?? null, at.businessId ?? null,
     JSON.stringify(matchedOn), matchedOn.length])

  return { profileId, created, matchedOn }
}

/**
 * WHAT THE REGISTER, A RESERVATION OR THE MECHANIC GETS. Nic asked for exactly
 * this: "If somebody's making a reservation that has been here before, we need
 * a way to have it just select a previous person instead of typing out their
 * full name... if I type in their phone number, it can pull their customer
 * information from it."
 *
 * A name and a phone, nothing else — and NOT where else they appear ("won't
 * tell me what other parks they've necessarily stayed at, or when, or where").
 * Email is left out too: it is one of the points that identifies a person, and
 * handing it to a business the person has not dealt with is not GAM's to do.
 */
export async function lookupForBusiness(opts: {
  phone?: string | null
  lastName?: string | null
  limit?: number
}): Promise<Array<{ profileId: string; firstName: string; lastName: string; phone: string | null }>> {
  const phone = normalizePhone(opts.phone)
  const last = normalizeName(opts.lastName)
  // A lookup needs something real to look up; it never lists everybody.
  if (!phone && last.length < 2) return []
  const rows = await query<any>(
    `SELECT id, first_name, last_name, phone
       FROM customer_profiles
      WHERE ($1 <> '' AND phone = $1)
         OR ($2 <> '' AND lower(last_name) LIKE $2 || '%')
      ORDER BY last_name, first_name
      LIMIT $3`,
    [phone, last, Math.min(opts.limit ?? 10, 25)])
  return rows.map(r => ({
    profileId: r.id, firstName: r.first_name, lastName: r.last_name, phone: r.phone ?? null,
  }))
}

/**
 * "SO WE CAN SEE EVERYWHERE THAT THEY INTERACT WITH GAM." GAM's own staff only.
 *
 * This is the view a landlord deliberately does NOT get: knowing that your
 * resident also shops at the grocery store down the road is not yours to know
 * because you both use GAM. The caller has to be a GAM admin and has to ask.
 */
export async function appearancesForAdmin(
  profileId: string,
  asking: { role?: string } | undefined,
): Promise<Array<{ kind: CustomerLinkKind; refId: string; landlordId: string | null; businessId: string | null; matchedOn: CustomerMatchPoint[]; linkedAt: string }>> {
  if (asking?.role !== 'admin' && asking?.role !== 'super_admin') {
    throw new AppError(403,
      'Only GAM staff can see everywhere a customer appears. A business sees the people it deals with.')
  }
  const rows = await query<any>(
    `SELECT kind, ref_id, landlord_id, business_id, matched_on, created_at::text AS created_at
       FROM customer_profile_links WHERE profile_id = $1 ORDER BY created_at`,
    [profileId])
  return rows.map(r => ({
    kind: r.kind, refId: r.ref_id, landlordId: r.landlord_id, businessId: r.business_id,
    matchedOn: r.matched_on ?? [], linkedAt: r.created_at,
  }))
}

/** The one GAM customer behind a given row, if it has been linked. */
export async function profileForRef(kind: CustomerLinkKind, refId: string): Promise<string | null> {
  const r = await queryOne<{ profile_id: string }>(
    `SELECT profile_id FROM customer_profile_links WHERE kind = $1 AND ref_id = $2`, [kind, refId])
  return r?.profile_id ?? null
}

/**
 * 10/25 (Nic): "people change their phone numbers and stuff from time to time.
 * And so it'll have to be able to be edited on that."
 *
 * The identifying points, changed by a person, with who and when recorded. The
 * wider repair and merge work ("there's going to be a lot of design that goes
 * into it for fixing things later on") is not this; this is the honest minimum
 * so a changed number does not mean a second person.
 */
export async function updateProfilePoints(
  profileId: string,
  points: Pick<CustomerPoints, 'firstName' | 'lastName' | 'phone' | 'email'>,
  byUserId: string,
): Promise<void> {
  const updated = await queryOne<{ id: string }>(
    `UPDATE customer_profiles
        SET first_name = COALESCE(NULLIF($2, ''), first_name),
            last_name  = COALESCE(NULLIF($3, ''), last_name),
            phone      = CASE WHEN $4::text IS NULL THEN phone ELSE NULLIF($4, '') END,
            email      = CASE WHEN $5::text IS NULL THEN email ELSE NULLIF($5, '') END,
            points_changed_at = NOW(),
            points_changed_by = $6,
            updated_at = NOW()
      WHERE id = $1
     RETURNING id`,
    [profileId,
     points.firstName === undefined ? '' : normalizeName(points.firstName),
     points.lastName === undefined ? '' : normalizeName(points.lastName),
     points.phone === undefined ? null : normalizePhone(points.phone),
     points.email === undefined ? null : normalizeEmail(points.email),
     byUserId])
  if (!updated) throw new AppError(404, 'That GAM customer was not found.')
}
