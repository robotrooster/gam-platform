/**
 * ─────────────────────────────────────────────────────────────
 * 10/20 — WHO SITS IN WHICH SEAT ON A DOCUMENT
 * ─────────────────────────────────────────────────────────────
 *
 * A template field is bound to a signer ROLE ('landlord', 'primary',
 * 'co_tenant_1'...), and the document builder matches each field to the signer
 * holding that role. A field whose role nobody holds is pruned, silently, and
 * the document goes out looking finished and unsignable — the defect Blu hit on
 * 10/20 with his work-trade form.
 *
 * So the mapping from REAL PEOPLE to those roles lives here, once, and every
 * door that builds a document from a household reads it.
 *
 * THE BUG THIS FILE WAS BORN FROM. `lease_tenants.role` holds 'primary' or
 * 'co_tenant' — two values, by its own CHECK constraint. A document signer's
 * role is 'primary' or 'co_tenant_1'..'co_tenant_3'. Three doors (the renewal,
 * the work-trade addendum, and the auto-draft that follows a renewal) handed the
 * lease's word straight to the builder, so the SECOND resident on a lease
 * arrived as 'co_tenant' — a role no template can carry. Before the S652 guard
 * that silently dropped every co-tenant box; after it, the builder refuses with
 * a 500 nobody can act on. 23 live leases have a co-tenant, so renewing any of
 * them, or sending its work-trade addendum, failed on the second resident.
 *
 * Nic's rule, 10/20: "if it's a tenant, it needs to be able to be signed by the
 * tenant." A seat that is offered is a seat somebody can be put in.
 */
import { DOCUMENT_SIGNER_ROLE_LABEL, type DocumentSignerRole } from '@gam/shared'
import { AppError } from '../middleware/errorHandler'
import { query } from '../db'
import { landlordSigningContact } from './landlordSigningContact'

export type Rows = (sql: string, params: any[]) => Promise<any[]>
const poolRows: Rows = (sql, params) => query<any>(sql, params)

/** The residents' seats on a form, in the order a lease fills them. */
export const HOUSEHOLD_SIGNER_ROLES = ['primary', 'co_tenant_1', 'co_tenant_2', 'co_tenant_3'] as const

/** Every seat a document raised from a resident's page can actually fill. */
export const RESIDENT_PAGE_SEATS: readonly string[] = ['landlord', ...HOUSEHOLD_SIGNER_ROLES]

export interface RosterRow {
  user_id: string
  first_name?: string | null
  last_name?: string | null
  email: string
  phone?: string | null
}

export interface SignerRow {
  userId: string
  role: string
  name: string
  email: string
  phone: string | null
  orderIndex: number
}

const fullName = (r: RosterRow) =>
  `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email

function label(role: string): string {
  return DOCUMENT_SIGNER_ROLE_LABEL[role as DocumentSignerRole] ?? role
}

/**
 * A lease's household as document signer rows: the first is the primary, the
 * rest are co-tenant 1, 2, 3 — the roles templates are actually built with.
 *
 * `startOrderIndex` is where this group sits in the signing order (2 when the
 * landlord signs first, which is every lease-bearing document — S28 → S535).
 *
 * A household bigger than the four seats a lease form has is refused in words
 * the landlord can act on, rather than reaching the builder as 'co_tenant_4'
 * and coming back as a 500 about fields matching no template.
 */
export function householdSignerRows(
  roster: RosterRow[],
  opts: { startOrderIndex?: number } = {},
): SignerRow[] {
  const start = opts.startOrderIndex ?? 1
  if (roster.length > HOUSEHOLD_SIGNER_ROLES.length) {
    const extra = roster.slice(HOUSEHOLD_SIGNER_ROLES.length).map(fullName).join(', ')
    throw new AppError(409,
      `A lease form has signature boxes for ${HOUSEHOLD_SIGNER_ROLES.length} residents and this household has ` +
      `${roster.length}. ${extra} ${roster.length - HOUSEHOLD_SIGNER_ROLES.length === 1 ? 'has' : 'have'} no box to sign. ` +
      'Send the document to the four on the lease and add the rest with an addendum.')
  }
  return roster.map((r, i) => ({
    userId: r.user_id,
    role: HOUSEHOLD_SIGNER_ROLES[i],
    name: fullName(r),
    email: r.email,
    phone: r.phone ?? null,
    orderIndex: start + i,
  }))
}

// ─────────────────────────────────────────────────────────────
// A DOCUMENT RAISED FROM ONE RESIDENT'S PAGE
// ─────────────────────────────────────────────────────────────
//
// Nic, 10/20, on Blu's work-trade form: "can he just go into Curtis's file, add
// a template that way, and have it signed to him? Like, there's some sort of
// broken flow there that we need to get fixed."
//
// So the resident's page fills the seats itself: the resident is the Primary
// Tenant, the landlord is the Landlord, and anyone else on their lease takes the
// co-tenant seats in the order the lease has them. Nobody has to know what a
// signer role is — which is the whole point of prefilling it.
//
// THE PERSON WHOSE PAGE IT IS, IS THE PRIMARY. Not whichever role they hold on
// their lease: the document is theirs, raised from their file, and a co-tenant
// on a lease is still the person this paper is for.

export interface Seat { userId: string; name: string; email: string; phone: string | null }

export interface ResidentSeats {
  tenantId: string
  residentName: string
  residentEmail: string
  /** The resident's current space, when they have one — the form's identity boxes. */
  unitId: string | null
  unitLabel: string | null
  propertyName: string | null
  /** role → the person who signs it. */
  seats: Map<string, Seat>
}

/**
 * The seats a document raised from this resident's page can fill, for one
 * company of the account.
 *
 * Null when GAM has no such resident. A resident with no lease at all still
 * gets their own seat and the landlord's — a work-trade form, a park-rules
 * acknowledgment or a plain agreement does not need a lease behind it.
 */
export async function residentSigningSeats(
  opts: { tenantId: string; landlordId: string; scopeIds: string[] },
  q: Rows = poolRows,
): Promise<ResidentSeats | null> {
  const resident = (await q(
    `SELECT t.id, t.user_id, u.first_name, u.last_name, u.email, u.phone
       FROM tenants t JOIN users u ON u.id = t.user_id
      WHERE t.id = $1`, [opts.tenantId]))[0]
  if (!resident) return null

  // Their lease with this account, the document's own company first — an
  // account's two parks are two companies and both are the landlord's (S633),
  // so a resident of either may be sent a form filed under either.
  const companies = Array.from(new Set([opts.landlordId, ...opts.scopeIds].filter(Boolean)))
  const lease = (await q(
    `SELECT l.id, l.unit_id, l.landlord_id, un.property_id,
            COALESCE(un.display_label, un.unit_number) AS unit_label, p.name AS property_name
       FROM lease_tenants lt
       JOIN leases l ON l.id = lt.lease_id
       LEFT JOIN units un ON un.id = l.unit_id
       LEFT JOIN properties p ON p.id = un.property_id
      WHERE lt.tenant_id = $1
        AND lt.status IN ('active','pending_add')
        AND l.status IN ('active','pending')
        AND l.landlord_id = ANY($2::uuid[])
      ORDER BY (l.landlord_id = $3) DESC,
               CASE l.status WHEN 'active' THEN 0 ELSE 1 END,
               l.start_date DESC
      LIMIT 1`, [opts.tenantId, companies, opts.landlordId]))[0] ?? null

  const seats = new Map<string, Seat>()
  seats.set('primary', {
    userId: resident.user_id,
    name: fullName(resident),
    email: resident.email,
    phone: resident.phone ?? null,
  })

  if (lease) {
    // The rest of the household, the resident themself left out: they already
    // hold the primary seat on this document whatever their lease says.
    const others = await q(
      `SELECT u.id AS user_id, u.first_name, u.last_name, u.email, u.phone
         FROM lease_tenants lt
         JOIN tenants t ON t.id = lt.tenant_id
         JOIN users u ON u.id = t.user_id
        WHERE lt.lease_id = $1 AND lt.status IN ('active','pending_add') AND lt.tenant_id <> $2
        ORDER BY CASE lt.role WHEN 'primary' THEN 0 ELSE 1 END, u.first_name, u.last_name`,
      [lease.id, opts.tenantId])
    others.slice(0, HOUSEHOLD_SIGNER_ROLES.length - 1).forEach((r: RosterRow, i: number) => {
      seats.set(HOUSEHOLD_SIGNER_ROLES[i + 1], {
        userId: r.user_id, name: fullName(r), email: r.email, phone: r.phone ?? null,
      })
    })
  }

  // Who signs for the landlord at this property — the on-site manager where the
  // property names one, and at the address that login signs at (S630/S654).
  const landlord = await landlordSigningContact(
    opts.landlordId,
    { propertyId: lease?.property_id ?? null, unitId: lease?.unit_id ?? null },
    { query: async (sql: string, params: any[]) => ({ rows: await q(sql, params) }) })
  if (landlord) {
    seats.set('landlord', {
      userId: landlord.userId, name: landlord.name, email: landlord.email, phone: landlord.phone,
    })
  }

  // THE SPACE COMES ALONG ONLY WHEN IT IS THIS COMPANY'S SPACE. The household
  // is the household — an account's companies are all the same landlord's — so
  // a sibling company's lease still fills the co-tenant seats. The unit does
  // not travel: a document filed under one company never points at another
  // company's space, even inside one account (S633).
  const ownUnit = lease && lease.landlord_id === opts.landlordId
  return {
    tenantId: resident.id,
    residentName: fullName(resident),
    residentEmail: resident.email,
    unitId: ownUnit ? lease.unit_id : null,
    unitLabel: ownUnit ? lease.unit_label : null,
    propertyName: ownUnit ? lease.property_name : null,
    seats,
  }
}

// ─────────────────────────────────────────────────────────────
// D9 — A ROLE OFFERED MUST BE A ROLE THAT CAN BE ASSIGNED
// ─────────────────────────────────────────────────────────────
//
// The silent bind-to-nobody is what cost Blu his evening, so the resident's
// page says, before anything is sent, exactly which boxes get a person and
// which do not. A form whose boxes this door cannot fill is not offered from
// this door: it says so, and names where it CAN be sent from.

export interface SeatPlan {
  /** The boxes that get a real person, in signing order. */
  willSign: Array<{ role: string; label: string; name: string }>
  /** Boxes for a second or third resident this household does not have. */
  leftOff: Array<{ role: string; label: string }>
  sendable: boolean
  /** Why not, in plain words with the next step. Null when it is sendable. */
  reason: string | null
}

/**
 * What would happen if this form were sent from this resident's page.
 *
 * `roles` is every signer role the template's boxes are bound to.
 */
export function planResidentSeats(roles: string[], ctx: ResidentSeats): SeatPlan {
  const asked = Array.from(new Set(roles.filter(r => !!r)))
  const order = (r: string) => {
    const i = RESIDENT_PAGE_SEATS.indexOf(r)
    return i === -1 ? RESIDENT_PAGE_SEATS.length : i
  }
  const sorted = [...asked].sort((a, b) => order(a) - order(b))
  const willSign = sorted
    .filter(r => ctx.seats.has(r))
    .map(r => ({ role: r, label: label(r), name: ctx.seats.get(r)!.name }))
  // Only a RESIDENT's box is ever "left off" — a second or third resident this
  // household does not have, which is what pruning an absent role has always
  // meant on a lease. The landlord's box is not optional: see below.
  const leftOff = sorted
    .filter(r => (HOUSEHOLD_SIGNER_ROLES as readonly string[]).includes(r) && !ctx.seats.has(r))
    .map(r => ({ role: r, label: label(r) }))
  const foreign = sorted.filter(r => !RESIDENT_PAGE_SEATS.includes(r))

  if (!asked.length) {
    return { willSign, leftOff, sendable: false,
      reason: 'This form has no signature boxes yet. Place one for each person who signs ' +
        '(GoldSign → Templates), then send it from here.' }
  }
  if (foreign.length) {
    const words = foreign.map(label)
    const list = words.length === 1 ? `a ${words[0]} box`
      : `${words.slice(0, -1).map(w => `a ${w}`).join(', ')} and a ${words[words.length - 1]} box`
    return { willSign, leftOff, sendable: false,
      reason: `This form has ${list}, and ${ctx.residentName}'s page has nobody to put there. ` +
        'Send it from GoldSign → New Contract, where you type in each person who signs.' }
  }
  if (asked.includes('landlord') && !ctx.seats.has('landlord')) {
    // Never silently: an unbound landlord box on a signed agreement is the
    // defect this whole lane is about, so it refuses instead.
    return { willSign, leftOff, sendable: false,
      reason: 'GAM does not know who signs for the landlord at this company yet, so the landlord box on this ' +
        'form has nobody. Set the lease-signing name and email on the property, then send it from here.' }
  }
  if (!willSign.length) {
    return { willSign, leftOff, sendable: false,
      reason: `Every box on this form is for another resident, and ${ctx.residentName} is the only one on the lease.` }
  }
  return { willSign, leftOff, sendable: true, reason: null }
}

/** The signer rows that plan turns into, landlord first where there is one. */
export function residentSignerRows(plan: SeatPlan, ctx: ResidentSeats): SignerRow[] {
  return plan.willSign.map((s, i) => {
    const seat = ctx.seats.get(s.role)!
    return {
      userId: seat.userId, role: s.role, name: seat.name,
      email: seat.email, phone: seat.phone, orderIndex: i + 1,
    }
  })
}
