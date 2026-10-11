/**
 * 10/5 (Nic) — WHO GETS THE REPLY.
 *
 * "why is GAM support getting a copy of the email ... where the message says if
 * something looks wrong, email your landlord and your landlord will respond to
 * it ... There needs to be a distinction between what goes to the landlord and
 * what actually comes to us."
 *
 * Every email used to carry GAM support as its reply address, so a tenant
 * answering an invoice, a receipt or a landlord's notice reached GAM and never
 * the landlord. The rule now: whoever runs the thing the email is about gets
 * the reply.
 *
 *   property  → the property's office email; until the property has one, the
 *               people who run it (its manager, the management company's staff,
 *               or the owner who runs it themselves — Nic 10/5: "whoever runs
 *               it"). GAM never gets these.
 *   business  → the business's own email (business-portal customers).
 *   person    → one named person (an invitation answers to who sent it).
 *   gam       → GAM support: GAM's own mail (sign-in, security, GAM's bill,
 *               payouts, signup). The default when nothing is said.
 */
import { queryOne } from '../db'
import { logger } from '../lib/logger'

export type ReplyTo =
  | { kind: 'gam' }
  | { kind: 'property'; propertyId: string }
  | { kind: 'business'; businessId: string }
  | { kind: 'person'; userId: string }

/** Shorthand for the common case. */
export const replyToProperty = (propertyId: string | null | undefined): ReplyTo | undefined =>
  propertyId ? { kind: 'property', propertyId } : undefined

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/
/** A real, deliverable-looking address — never a retired or reserved one. */
function usable(addr: string | null | undefined): string | null {
  const a = (addr ?? '').trim().toLowerCase()
  if (!EMAIL_RE.test(a)) return null
  if (/\.(invalid|test|localhost|example)$/.test(a)) return null
  return a
}
const MAX_REPLY_ADDRESSES = 10

/**
 * The addresses a reply should reach, or null for GAM support (the caller's
 * default). Never throws: a lookup that fails falls back to GAM support, so a
 * reply is never lost — it just lands where it always did.
 */
export async function replyAddressesFor(r: ReplyTo | null | undefined): Promise<string[] | null> {
  if (!r || r.kind === 'gam') return null
  try {
    let found: Array<string | null> = []
    if (r.kind === 'property') {
      const p = await queryOne<{ office_email: string | null }>(
        `SELECT office_email FROM properties WHERE id = $1`, [r.propertyId])
      if (!p) return null
      const office = usable(p.office_email)
      if (office) return [office]
      const { getPropertyResponsibleParty } = await import('./responsibleParty')
      const party = await getPropertyResponsibleParty(r.propertyId)
      found = (party?.primaries ?? []).map(x => usable(x.email))
      if (!found.some(Boolean)) found = [usable(party?.owner?.email)]
    } else if (r.kind === 'business') {
      const b = await queryOne<{ email: string | null; owner_email: string | null }>(
        `SELECT b.email, u.email AS owner_email
           FROM businesses b LEFT JOIN users u ON u.id = b.owner_user_id WHERE b.id = $1`, [r.businessId])
      found = [usable(b?.email) ?? usable(b?.owner_email)]
    } else if (r.kind === 'person') {
      const u = await queryOne<{ email: string | null }>(`SELECT email FROM users WHERE id = $1`, [r.userId])
      found = [usable(u?.email)]
    }
    const out = Array.from(new Set(found.filter((x): x is string => !!x))).slice(0, MAX_REPLY_ADDRESSES)
    if (!out.length) {
      logger.warn({ replyTo: r }, '[reply-routing] nobody to reply to — falling back to GAM support')
      return null
    }
    return out
  } catch (e) {
    logger.warn({ err: e, replyTo: r }, '[reply-routing] lookup failed — falling back to GAM support')
    return null
  }
}

/** The property a unit, lease or lease document belongs to — for callers that hold only one of those. */
export async function propertyIdForUnit(unitId: string | null | undefined): Promise<string | null> {
  if (!unitId) return null
  return (await queryOne<{ property_id: string }>(`SELECT property_id FROM units WHERE id = $1`, [unitId]))?.property_id ?? null
}
export async function propertyIdForLease(leaseId: string | null | undefined): Promise<string | null> {
  if (!leaseId) return null
  return (await queryOne<{ property_id: string }>(
    `SELECT u.property_id FROM leases l JOIN units u ON u.id = l.unit_id WHERE l.id = $1`, [leaseId]))?.property_id ?? null
}
export async function propertyIdForDocument(documentId: string | null | undefined): Promise<string | null> {
  if (!documentId) return null
  return (await queryOne<{ property_id: string }>(
    `SELECT u.property_id FROM lease_documents d JOIN units u ON u.id = d.unit_id WHERE d.id = $1`, [documentId]))?.property_id ?? null
}

