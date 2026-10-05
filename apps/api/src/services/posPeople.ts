/**
 * 10/2 (Nic) — WHO A REGISTER SALE IS FOR: one typed flow, everywhere.
 *
 *   "When I select a customer from the drop-down list, it still lets me choose
 *    to add a customer. It should be one or the other. And it should be type
 *    their name, not a scroll down list... type somebody's last name and have
 *    it pop up. One flow. If they aren't in the system, I choose add new...
 *    And then on the history, same thing... if they're an existing customer I
 *    can click them and link them to that transaction. And then have it
 *    retroactively fill to any matching cards... I already have a tenant
 *    profile. So if I click my name as a customer, it should automatically
 *    fill it in in all matching card transactions."
 *
 * THE MODEL. One register record per person per company (pos_customers). A
 * resident's record points at their tenant row (pos_customers.tenant_id) and
 * reads their name and email from their account. Cards always hang on a
 * register record. A resident's sale carries both ids.
 *
 * A STAND-IN is a record the card reader made that nobody has confirmed: no
 * email, no phone, not a resident's, and still named "Card Customer" or exactly
 * the name printed on its card. A name typed on the reader's own screen counts
 * as confirmed — the customer said it.
 *
 * LINKING sale S (company L) to person R, in one database transaction:
 *   1. S moves to R — an explicit clerk action, so allowed even if S had
 *      someone else.
 *   2. S's card: S on a stand-in → that stand-in's card; S with nobody, paid by
 *      card → the card read back from Stripe; cash or a charge account → stop.
 *   3. The card at L: unknown → it goes on R; on a stand-in X → X is folded
 *      into R (its sales, cards, tickets and links move; X is archived, never
 *      deleted) — unless X carries a printed name whose last name differs from
 *      R's, in which case only S moves; on another confirmed person → nothing
 *      else moves and the clerk is told whose record the card is on.
 *   4. R a resident → their tenant id goes on every sale of R's lacking it.
 * Another confirmed person's or another resident's sales are never touched, and
 * nothing reads or writes another company's rows: cards are per company, and
 * Stripe fingerprints are GAM-wide, so matching across companies would tell one
 * company who owns a card at another. Matching spans every property of L.
 *
 * SEARCH. This property's residents and this company's register customers,
 * by part of a name, email or phone (a former resident by name, and by what
 * this company's own record holds — never their live account's contact). 10/2 (Nic, settled): everyone else on GAM
 * by part of a name too, and by an email or phone only when it was typed WHOLE
 * (never a piece of one) — "If there's five Bobs next door... I type Bob and then I
 * remember the last name... If they're a point of sale customer, it doesn't
 * matter. It doesn't link to the tenancy at all." Someone from elsewhere shows
 * as a name and a masked contact hint ONLY (j•••@gmail.com, or "phone on
 * file" — never digits of a phone the clerk did not type; elsewhereHint) —
 * never their company, site, "resident", lease, balance, payments or ids — and
 * picking them makes (or finds) a register record in THIS company. See
 * searchElsewhere, the one place that rule lives.
 *
 * WHO A SALE CAN NAME. A register customer of this company, or a tenant tied to
 * it in ANY way (tenantOfCompanySql). Never gated on residency: a person with
 * only an invite, a booking or an earlier register sale here is still somebody
 * the counter sells to (10/2, the Scott Duffy ticket that could not be cleared
 * or charged). The reader's breakdown never fails over the person at all — it
 * shows no name instead (nameForReader). Naming is ALL the any-tie rule allows.
 * What is on their own GAM account — its email and phone, and the card they
 * saved paying rent — reaches this register only while they LIVE under one of
 * its leases (tenantLivesHereSql): a current place they took themselves on a
 * current lease (one they signed, or one where this company is the only one
 * they have ever dealt with). 10/2 review: a landlord who invited an email and
 * cancelled it — or signed a lease for another company's resident on its own —
 * could otherwise charge that person's card and read their phone number.
 *
 * FORMER RESIDENTS (decisions #10, audience isolation). A company a person has
 * left sees only what ITS OWN register record holds for them (pos_customers
 * .email / .phone — what its clerks typed, or a receipt address they gave) —
 * never the live email and phone on the account they carried on to their next
 * home, and never their account card. The person is still found and named by
 * name; their live contact is simply not this company's any more.
 *
 * UNDO. A link that carried more than the sale (a card record folded in, a
 * card put on them, a resident's id stamped) hands back a sealed Undo that
 * puts every piece back exactly (undoLink). A record a pick from elsewhere
 * made at the register is let go again if the clerk takes the person back
 * off before anything was sold (letGoOfPick).
 */
import type { PoolClient } from 'pg'
import type { Request, Response, NextFunction } from 'express'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import rateLimit from 'express-rate-limit'
import type { ZodTypeAny, output as ZodOutput } from 'zod'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { mergePosCustomers, nameFromCard, cardLabel, MERGE_MOVED_TABLES, type CardIdentity, type MergeRecord } from './posCustomerCards'

type Q = Pick<PoolClient, 'query'>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
export const digitsOf = (s?: string | null): string => String(s ?? '').replace(/\D/g, '')
const phoneSql = (col: string) => `regexp_replace(COALESCE(${col}, ''), '\\D', '', 'g')`
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c)
const isCardCustomer = (first?: string | null, last?: string | null) => first === 'Card' && last === 'Customer'
const fullName = (first?: string | null, last?: string | null) => `${first ?? ''} ${last ?? ''}`.trim()
const sameText = (a?: string | null, b?: string | null) =>
  String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()

/**
 * SQL: tenant `t` is tied to company `l` in ANY way — a lease of any status, an
 * invite (resolved, cancelled or still open), a booking, an earlier register
 * sale, ticket or pay link, or a register record carrying them. 10/2 (Nic, the
 * Scott Duffy ticket): a person at the register is never gated on residency.
 * Two cancelled invites and no lease is still somebody this company knows.
 */
export const tenantOfCompanySql = (t: string, l: string) => `(
  EXISTS (SELECT 1 FROM lease_tenants lt_c JOIN leases l_c ON l_c.id = lt_c.lease_id
           WHERE lt_c.tenant_id = ${t} AND l_c.landlord_id = ${l})
  OR EXISTS (SELECT 1 FROM pending_tenant_intents pi_c WHERE pi_c.tenant_id = ${t} AND pi_c.landlord_id = ${l})
  OR EXISTS (SELECT 1 FROM unit_bookings b_c WHERE b_c.tenant_id = ${t} AND b_c.landlord_id = ${l})
  OR EXISTS (SELECT 1 FROM pos_transactions x_c WHERE x_c.tenant_id = ${t} AND x_c.landlord_id = ${l})
  OR EXISTS (SELECT 1 FROM pos_open_tickets k_c WHERE k_c.tenant_id = ${t} AND k_c.landlord_id = ${l})
  OR EXISTS (SELECT 1 FROM pos_pay_links p_c WHERE p_c.tenant_id = ${t} AND p_c.landlord_id = ${l})
  OR EXISTS (SELECT 1 FROM pos_customers r_c WHERE r_c.tenant_id = ${t} AND r_c.landlord_id = ${l}))`

/**
 * SQL: tenant `t` has dealt on GAM with some company OTHER than `l` — a place
 * on one of its leases (of any kind), an invite from it, a booking with it, an
 * application to it, or a screening for it (the card the screening fee was paid
 * with is kept on their account). Anything on their account may have come from
 * there.
 */
export const tenantTiedElsewhereSql = (t: string, l: string) => `(
  EXISTS (SELECT 1 FROM lease_tenants lt_e JOIN leases l_e ON l_e.id = lt_e.lease_id
           WHERE lt_e.tenant_id = ${t} AND l_e.landlord_id <> ${l})
  OR EXISTS (SELECT 1 FROM pending_tenant_intents pi_e WHERE pi_e.tenant_id = ${t} AND pi_e.landlord_id <> ${l})
  OR EXISTS (SELECT 1 FROM unit_bookings b_e WHERE b_e.tenant_id = ${t} AND b_e.landlord_id <> ${l})
  OR EXISTS (SELECT 1 FROM tenants tn_e JOIN unit_applications a_e ON a_e.applicant_user_id = tn_e.user_id
              LEFT JOIN properties pr_e ON pr_e.id = a_e.property_id
             WHERE tn_e.id = ${t} AND COALESCE(a_e.landlord_id, pr_e.landlord_id) IS DISTINCT FROM ${l})
  OR EXISTS (SELECT 1 FROM tenants tn_s JOIN background_checks bc_e ON bc_e.user_id = tn_s.user_id
              WHERE tn_s.id = ${t} AND bc_e.landlord_id <> ${l}))`

/**
 * The places that are CURRENT: on the lease now, or on their way off it. On a
 * lease that is itself current (CURRENT_LEASE_STATUSES) — signed and waiting to
 * start, or running.
 */
export const CURRENT_LEASE_PLACES = ['active', 'pending_remove'] as const
export const CURRENT_LEASE_STATUSES = ['pending', 'active'] as const

/**
 * SQL: tenant `t` lives under one of company `l`'s leases NOW — a current place
 * (CURRENT_LEASE_PLACES: on it now, or on their way off it — never
 * 'pending_add', which a landlord drafts alone, and never 'void') on a current
 * lease (CURRENT_LEASE_STATUSES) — and a place they TOOK THEMSELVES. THE
 * STRICT TIE (10/2 review). The any-tie rule above (tenantOfCompanySql) lets
 * this company NAME somebody on a sale, a ticket or the reader, nothing more.
 *
 * 10/2 (Nic: nobody is attached to a company without their OWN signature).
 * Since S647 the landlord's signature alone builds the lease — active from its
 * start date, the person's place 'active', signed_by_tenant still false — so a
 * company could invite another company's resident and sign a lease for them.
 * The lease counts only once the tenant signed it too (signed_by_tenant is set
 * when EVERY signer has signed), or when this company is the only one they have
 * ever dealt with on GAM (tenantTiedElsewhereSql): then nothing on their
 * account came from anywhere else — the residents a company onboarded itself,
 * whose paper lease was imported, keep their card and contact at its register.
 *
 * WHAT FOLLOWS WHERE THEY LIVE — everything on their own GAM account:
 *   - the CARD they saved (10/2 review, decided): card on file is for guests
 *     (memory: card-on-file is guests, not tenants); a resident's own card
 *     reaches a register only while they live there. Once they leave — their
 *     place removed, the lease expired or ended — the company they left no
 *     longer charges it, including a card they saved later paying rent at a
 *     different company;
 *   - their live EMAIL and PHONE (decisions #10): a former landlord sees only
 *     what its own register record holds for them (recordContactSql). The
 *     account's contact is wherever they live now — it is not the old
 *     company's to read, search or print on a receipt.
 */
export const tenantLivesHereSql = (t: string, l: string) => `EXISTS (
  SELECT 1 FROM lease_tenants lt_h JOIN leases l_h ON l_h.id = lt_h.lease_id
   WHERE lt_h.tenant_id = ${t} AND l_h.landlord_id = ${l}
     AND lt_h.status IN (${CURRENT_LEASE_PLACES.map((s) => `'${s}'`).join(', ')})
     AND l_h.status IN (${CURRENT_LEASE_STATUSES.map((s) => `'${s}'`).join(', ')})
     AND (l_h.signed_by_tenant = TRUE OR NOT ${tenantTiedElsewhereSql(t, l)}))`

/**
 * SQL: the email and phone a register record shows — the ones on the
 * resident's own account while they LIVE here (tenantLivesHereSql), else only
 * the record's own (decisions #10: a former landlord never reads the live
 * account's contact). `c` is the pos_customers alias, `u` their account's
 * users row.
 */
export const recordContactSql = (c: string, u: string) => {
  const lives = tenantLivesHereSql(`${c}.tenant_id`, `${c}.landlord_id`)
  return {
    email: `COALESCE(CASE WHEN ${lives} THEN ${u}.email END, ${c}.email)`,
    phone: `COALESCE(CASE WHEN ${lives} THEN ${u}.phone END, ${c}.phone)`,
  }
}

/** Is this tenant tied to this company in any way (tenantOfCompanySql)? */
async function tenantTiedTo(q: Q, landlordId: string, tenantId: string): Promise<boolean> {
  if (!UUID.test(tenantId)) return false
  return !!(await q.query(`SELECT 1 FROM tenants tn WHERE tn.id = $1 AND ${tenantOfCompanySql('tn.id', '$2')}`, [tenantId, landlordId])).rows[0]
}

// ── Who a sale names ─────────────────────────────────────────────────────

export interface SalePerson { name: string | null; tenantId: string | null; customerId: string | null }

/**
 * S654/10-2: the person a sale names must be THIS company's — one of its
 * register customers, or a tenant tied to it in any way (tenantOfCompanySql) —
 * and their name is what the reader shows. A name-less card record shows none.
 */
export async function salePerson(landlordId: string, ids: { tenantId?: unknown; posCustomerId?: unknown }): Promise<SalePerson | null> {
  const tenantId = typeof ids.tenantId === 'string' && ids.tenantId ? ids.tenantId : null
  const posCustomerId = typeof ids.posCustomerId === 'string' && ids.posCustomerId ? ids.posCustomerId : null
  if (tenantId && posCustomerId) throw new AppError(400, 'A sale is for one person — remove the customer (×) and pick just one.')
  if (posCustomerId) {
    const c = UUID.test(posCustomerId) ? await queryOne<any>(
      `SELECT c.id, c.tenant_id, c.first_name, c.last_name, u.first_name AS t_first, u.last_name AS t_last
         FROM pos_customers c
         LEFT JOIN tenants tn ON tn.id = c.tenant_id
         LEFT JOIN users u ON u.id = tn.user_id
        WHERE c.id = $1 AND c.landlord_id = $2 AND c.archived_at IS NULL`,
      [posCustomerId, landlordId]) : null
    if (!c) throw new AppError(404, NOT_ON_REGISTER)
    const name = c.tenant_id ? fullName(c.t_first, c.t_last)
      : isCardCustomer(c.first_name, c.last_name) ? '' : fullName(c.first_name, c.last_name)
    return { name: name || null, tenantId: c.tenant_id ?? null, customerId: c.id }
  }
  if (tenantId) {
    const t = UUID.test(tenantId) ? await queryOne<any>(
      `SELECT NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS name,
              (SELECT c.id FROM pos_customers c WHERE c.landlord_id = $2 AND c.tenant_id = tn.id AND c.archived_at IS NULL) AS customer_id
         FROM tenants tn JOIN users u ON u.id = tn.user_id
        WHERE tn.id = $1 AND ${tenantOfCompanySql('tn.id', '$2')}`,
      [tenantId, landlordId]) : null
    if (!t) throw new AppError(404, NOT_ON_REGISTER)
    return { name: t.name, tenantId, customerId: t.customer_id ?? null }
  }
  return null
}

/** What the clerk is told when a sale names somebody this company has never had. */
export const NOT_ON_REGISTER = 'That person is not on this register — remove them (×), then type their name and pick them again, or add them as a new customer.'

/** The name a sale shows (or null) — refuses anyone who is not this company's. */
export async function personOnSale(landlordId: string, ids: { tenantId?: unknown; posCustomerId?: unknown }): Promise<string | null> {
  return (await salePerson(landlordId, ids))?.name ?? null
}

/**
 * The name the reader's breakdown leads with. 10/2: putting the cart up (or
 * taking it down) NEVER fails over the person — somebody who cannot be named
 * here simply shows no name. The sale itself still checks who it names.
 */
export async function nameForReader(landlordId: string, ids: { tenantId?: unknown; posCustomerId?: unknown }): Promise<string | null> {
  try { return await personOnSale(landlordId, ids) } catch { return null }
}

/**
 * A resident's register record at this company — made the first time they are
 * linked to a sale. The caller has already established the tenant is this
 * company's. Safe under a race: the partial unique index decides.
 */
export async function residentRecord(q: Q, landlordId: string, tenantId: string): Promise<string> {
  const found = await q.query<{ id: string }>(
    `SELECT id FROM pos_customers WHERE landlord_id = $1 AND tenant_id = $2 AND archived_at IS NULL`, [landlordId, tenantId])
  if (found.rows[0]) return found.rows[0].id
  const u = await q.query<{ first_name: string; last_name: string }>(
    `SELECT u.first_name, u.last_name FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [tenantId])
  if (!u.rows[0]) throw new AppError(404, 'That resident could not be found — remove them (×), then type their name and pick them again.')
  const made = await q.query<{ id: string }>(
    `INSERT INTO pos_customers (landlord_id, first_name, last_name, created_from, tenant_id)
     VALUES ($1, $2, $3, 'manual', $4)
     ON CONFLICT (landlord_id, tenant_id) WHERE archived_at IS NULL AND tenant_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [landlordId, u.rows[0].first_name || '', u.rows[0].last_name || '', tenantId])
  if (made.rows[0]) return made.rows[0].id
  const again = await q.query<{ id: string }>(
    `SELECT id FROM pos_customers WHERE landlord_id = $1 AND tenant_id = $2 AND archived_at IS NULL`, [landlordId, tenantId])
  return again.rows[0].id
}

// ── Stand-ins and cards ──────────────────────────────────────────────────

interface RecordState {
  id: string
  firstName: string
  lastName: string
  tenantId: string | null
  /** A reader-made record nobody has confirmed. */
  standIn: boolean
  /** A stand-in whose name came printed on its card (not "Card Customer"). */
  printedName: boolean
  card: string | null
}

async function recordState(q: Q, customerId: string): Promise<RecordState | null> {
  const r = (await q.query<any>(
    `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.tenant_id, c.created_from,
            u.first_name AS t_first, u.last_name AS t_last,
            (SELECT COALESCE(array_agg(k.cardholder_name), '{}') FROM pos_customer_cards k WHERE k.pos_customer_id = c.id) AS printed,
            (SELECT json_build_object('brand', k.brand, 'last4', k.last4) FROM pos_customer_cards k
              WHERE k.pos_customer_id = c.id ORDER BY k.last_seen_at DESC LIMIT 1) AS card
       FROM pos_customers c
       LEFT JOIN tenants tn ON tn.id = c.tenant_id
       LEFT JOIN users u ON u.id = tn.user_id
      WHERE c.id = $1`, [customerId])).rows[0]
  if (!r) return null
  const firstName = r.tenant_id ? (r.t_first ?? r.first_name) : r.first_name
  const lastName = r.tenant_id ? (r.t_last ?? r.last_name) : r.last_name
  const unconfirmed = r.created_from === 'card_reader' && !r.email && !r.phone && !r.tenant_id
  const placeholder = isCardCustomer(r.first_name, r.last_name)
  const printedName = unconfirmed && !placeholder && (r.printed as (string | null)[]).some((h) => {
    if (!h) return false
    const n = nameFromCard(h)
    return sameText(n.first, r.first_name) && sameText(n.last, r.last_name)
  })
  return {
    id: r.id, firstName, lastName, tenantId: r.tenant_id ?? null,
    standIn: unconfirmed && (placeholder || printedName), printedName,
    card: cardLabel(r.card),
  }
}

/** A reader-made record nobody has confirmed (see the header), as it stands right now — null when the record is not one. */
export type StandIn = RecordState
export async function standInNow(q: Q, customerId: string): Promise<StandIn | null> {
  const s = await recordState(q, customerId)
  return s?.standIn ? s : null
}

/** A card put on a person: the row was new (prevOwner null), or moved off a closed record. */
export interface CardAttach { fingerprint: string; prevOwner: string | null; on: string }

export type CardOutcome =
  | { kind: 'none' }
  | { kind: 'attached'; card: string | null; attach?: CardAttach }
  | { kind: 'already'; card: string | null }
  | { kind: 'folded'; card: string | null; earlier: number; later: number; fold?: MergeRecord }
  | { kind: 'named'; card: string | null; earlier: number; later: number }
  | { kind: 'printed_other'; card: string | null; ownerName: string }
  | { kind: 'other_person'; card: string | null; ownerName: string }
  | { kind: 'not_moved'; card: string | null; reason: string }

interface SaleRef { id: string; created_at: Date | string }

async function salesBeside(q: Q, customerId: string, sale: SaleRef | null): Promise<{ earlier: number; later: number }> {
  const r = (await q.query<{ earlier: number; later: number }>(
    `SELECT COUNT(*) FILTER (WHERE created_at < $2)::int AS earlier,
            COUNT(*) FILTER (WHERE created_at >= $2)::int AS later
       FROM pos_transactions WHERE pos_customer_id = $1 AND id <> $3`,
    [customerId, sale?.created_at ?? new Date(), sale?.id ?? '00000000-0000-0000-0000-000000000000'])).rows[0]
  return { earlier: r?.earlier ?? 0, later: r?.later ?? 0 }
}

/**
 * Fold a stand-in into the person — the card, every sale on it, its tickets and
 * links. Not when the card carries somebody else's printed name: then the
 * person paid with another person's card, and only the sale in hand moves.
 */
async function foldStandIn(q: Q, landlordId: string, x: RecordState, into: { id: string; lastName: string }, sale: SaleRef | null): Promise<CardOutcome> {
  if (x.printedName && !sameText(x.lastName, into.lastName)) {
    return { kind: 'printed_other', card: x.card, ownerName: fullName(x.firstName, x.lastName) }
  }
  const counts = await salesBeside(q, x.id, sale)
  const fold = await mergePosCustomers(q as PoolClient, { landlordId, loserId: x.id, into: into.id })
  return { kind: 'folded', card: x.card, ...counts, fold }
}

/**
 * An email (or any one identifier) says a stand-in is somebody this company
 * already has — a register customer, or a resident. By the same rule as
 * linking a sale: the stand-in folds into them, unless its card is printed
 * with a different last name (then it is somebody else's card, and nothing
 * moves). Only a stand-in is ever folded this way; a person the clerk or the
 * customer named is never merged into someone on an address alone. A
 * resident's register record is made only when there is something to fold.
 */
export async function foldStandInInto(q: Q, landlordId: string, x: StandIn,
                                      into: { customerId?: string; tenantId?: string }): Promise<CardOutcome> {
  const lastName = into.customerId
    ? (await recordState(q, into.customerId))?.lastName ?? ''
    : (await q.query<{ last_name: string | null }>(
        `SELECT u.last_name FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [into.tenantId])).rows[0]?.last_name ?? ''
  if (x.printedName && !sameText(x.lastName, lastName)) {
    return { kind: 'printed_other', card: x.card, ownerName: fullName(x.firstName, x.lastName) }
  }
  const id = into.customerId ?? await residentRecord(q, landlordId, into.tenantId!)
  if (id === x.id) return { kind: 'none' }
  return foldStandIn(q, landlordId, x, { id, lastName }, null)
}

/**
 * A card used for person R's sale, at company L: unknown → it is R's now; on a
 * stand-in → the stand-in is folded into R; on another confirmed person →
 * nothing moves (it is theirs, and the clerk is told).
 */
export async function applyCardToPerson(q: Q, opts: {
  landlordId: string; card: CardIdentity; person: { id: string; lastName: string }; sale?: SaleRef | null
}): Promise<CardOutcome> {
  const label = cardLabel(opts.card)
  const row = (await q.query<any>(
    `SELECT k.pos_customer_id, p.archived_at FROM pos_customer_cards k JOIN pos_customers p ON p.id = k.pos_customer_id
      WHERE k.landlord_id = $1 AND k.fingerprint = $2`, [opts.landlordId, opts.card.fingerprint])).rows[0]
  if (!row) {
    await q.query(
      `INSERT INTO pos_customer_cards (landlord_id, pos_customer_id, fingerprint, brand, last4, cardholder_name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [opts.landlordId, opts.person.id, opts.card.fingerprint, opts.card.brand, opts.card.last4, opts.card.cardholderName])
    return { kind: 'attached', card: label, attach: { fingerprint: opts.card.fingerprint, prevOwner: null, on: opts.person.id } }
  }
  const seen = () => q.query(
    `UPDATE pos_customer_cards SET last_seen_at = NOW(), last4 = COALESCE($3, last4), brand = COALESCE($4, brand)
      WHERE landlord_id = $1 AND fingerprint = $2`, [opts.landlordId, opts.card.fingerprint, opts.card.last4, opts.card.brand])
  if (row.pos_customer_id === opts.person.id) { await seen(); return { kind: 'already', card: label } }
  if (row.archived_at) {
    await q.query(`UPDATE pos_customer_cards SET pos_customer_id = $3, last_seen_at = NOW() WHERE landlord_id = $1 AND fingerprint = $2`,
      [opts.landlordId, opts.card.fingerprint, opts.person.id])
    return { kind: 'attached', card: label, attach: { fingerprint: opts.card.fingerprint, prevOwner: row.pos_customer_id, on: opts.person.id } }
  }
  await seen()
  const owner = await recordState(q, row.pos_customer_id)
  if (owner?.standIn) return foldStandIn(q, opts.landlordId, owner, opts.person, opts.sale ?? null)
  const ownerName = owner && !isCardCustomer(owner.firstName, owner.lastName) ? fullName(owner.firstName, owner.lastName) : ''
  return { kind: 'other_person', card: label, ownerName: ownerName || 'another customer' }
}

let savepointSeq = 0
/**
 * Card bookkeeping is never a reason to lose the thing it rides on: a sale is
 * still recorded, a link still made, if folding a record runs into something
 * only one record may hold.
 */
export async function withSavepoint<T>(q: Q, fn: () => Promise<T>, onError: (e: any) => T): Promise<T> {
  const name = `pos_people_${++savepointSeq}`
  await q.query(`SAVEPOINT ${name}`)
  try {
    const out = await fn()
    await q.query(`RELEASE SAVEPOINT ${name}`)
    return out
  } catch (e) {
    await q.query(`ROLLBACK TO SAVEPOINT ${name}`)
    return onError(e)
  }
}

/** What happened to the card, in the clerk's words (no trailing period). */
export function cardOutcomeSentence(o: CardOutcome): string | null {
  const card = o.kind !== 'none' && o.card ? o.card : null
  switch (o.kind) {
    case 'folded':
    case 'named': {
      const n = o.earlier + o.later
      if (!n) return null
      const when = o.later === 0 ? 'earlier ' : o.earlier === 0 ? 'later ' : 'other '
      return `also ${n} ${when}sale${n === 1 ? '' : 's'} on ${card ?? 'the same card'}`
    }
    case 'attached': return card ? `${card} is on their record now` : null
    case 'other_person': return `this card is on ${o.ownerName}'s record; only this sale changed`
    case 'printed_other': return `the card used is in ${o.ownerName}'s name; only this sale changed`
    case 'not_moved': return `the other sales on ${card ?? 'that card'} could not be moved (${o.reason})`
    default: return null
  }
}

// ── Finding the same person ──────────────────────────────────────────────

/**
 * An email or phone this company already has is that person. A register
 * customer's email or phone, or a resident's account email.
 */
export async function findSamePerson(q: Q, landlordId: string, email: string | null | undefined, phone: string | null | undefined): Promise<{ customerId?: string; tenantId?: string } | null> {
  const e = email ? email.trim().toLowerCase() : ''
  if (e) {
    const c = (await q.query<{ id: string; archived_at: Date | null }>(
      `SELECT id, archived_at FROM pos_customers WHERE landlord_id = $1 AND lower(email) = $2`, [landlordId, e])).rows[0]
    if (c && !c.archived_at) return { customerId: c.id }
    if (c) throw new AppError(409, 'That email is on a customer record that was closed — use a different email or leave it blank, then press Add customer again.')
    const r = (await q.query<{ id: string }>(
      `SELECT t.id FROM tenants t JOIN users u ON u.id = t.user_id
        WHERE lower(u.email) = $2 AND ${tenantOfCompanySql('t.id', '$1')} LIMIT 1`, [landlordId, e])).rows[0]
    if (r) return { tenantId: r.id }
  }
  const d = digitsOf(phone)
  if (d.length >= 7) {
    const c = (await q.query<{ id: string }>(
      `SELECT id FROM pos_customers
        WHERE landlord_id = $1 AND archived_at IS NULL AND right(${phoneSql('phone')}, 10) = right($2, 10)
        ORDER BY created_at LIMIT 1`, [landlordId, d])).rows[0]
    if (c) return { customerId: c.id }
  }
  return null
}

export interface NewPerson { firstName: string; lastName?: string | null; email?: string | null; phone?: string | null }

function cleanNew(p: NewPerson): { first: string; last: string; email: string | null; phone: string | null } {
  const first = String(p.firstName ?? '').trim().slice(0, 80)
  if (!first) throw new AppError(400, 'Type at least a first name, then press Add customer.')
  const email = p.email ? String(p.email).trim().toLowerCase() : null
  if (email && !EMAIL.test(email)) throw new AppError(400, 'That email does not look right — check it, or leave it blank, then press Add customer again.')
  return { first, last: String(p.lastName ?? '').trim().slice(0, 80), email: email || null, phone: p.phone ? String(p.phone).trim().slice(0, 40) || null : null }
}

/**
 * "Add new customer": a first name is enough; an email or phone this company
 * already has picks that person instead of making a second record.
 */
export async function addCustomer(q: Q, landlordId: string, p: NewPerson): Promise<{ customerId: string; tenantId: string | null; existing: boolean }> {
  const n = cleanNew(p)
  const same = await findSamePerson(q, landlordId, n.email, n.phone)
  if (same?.customerId) return { customerId: same.customerId, tenantId: await tenantOfRecord(q, same.customerId), existing: true }
  if (same?.tenantId) return { customerId: await residentRecord(q, landlordId, same.tenantId), tenantId: same.tenantId, existing: true }
  const row = (await q.query<{ id: string }>(
    `INSERT INTO pos_customers (landlord_id, first_name, last_name, email, phone, created_from)
     VALUES ($1, $2, $3, $4, $5, 'manual') RETURNING id`,
    [landlordId, n.first, n.last, n.email, n.phone])).rows[0]
  return { customerId: row.id, tenantId: null, existing: false }
}

async function tenantOfRecord(q: Q, customerId: string): Promise<string | null> {
  return (await q.query<{ tenant_id: string | null }>(`SELECT tenant_id FROM pos_customers WHERE id = $1`, [customerId])).rows[0]?.tenant_id ?? null
}

/**
 * Someone found on GAM outside this company (searchElsewhere), picked at this
 * register. The clerk's screen never held an id: it holds a sealed pick, made
 * for this clerk at this company a few minutes ago, which only this server can
 * open. What happens, in order:
 *   - a tenant tied to this company in any way after all (a resident of its
 *     other park, say) → their resident record here, exactly as if found here;
 *   - someone this company already has by that person's email or phone → that
 *     record;
 *   - picked from elsewhere before → the record that pick made;
 *   - otherwise a NEW record of this company's: their name, and only an email
 *     or phone the clerk typed in full. Nothing else crosses — no contact they
 *     did not type, no tenancy link, nothing of the other company's.
 */
export async function customerFromElsewhere(q: Q, landlordId: string, userId: string, pick: string): Promise<{ customerId: string; tenantId: string | null; existing: boolean }> {
  const c = openPick(pick)
  if (!c || c.l !== landlordId || c.u !== userId || c.x < Date.now()) throw new AppError(404, PICK_GONE)
  const src = c.s === 'u'
    ? (await q.query<any>(
        `SELECT u.first_name, u.last_name, u.email, u.phone, tn.id AS tenant_id
           FROM users u JOIN tenants tn ON tn.user_id = u.id WHERE u.id = $1 AND u.role = 'tenant'`, [c.id])).rows[0]
    : (await q.query<any>(
        `SELECT first_name, last_name, email, phone, NULL::uuid AS tenant_id FROM pos_customers
          WHERE id = $1 AND landlord_id <> $2 AND archived_at IS NULL`, [c.id, landlordId])).rows[0]
  if (!src) throw new AppError(404, PICK_GONE)

  if (src.tenant_id && await tenantTiedTo(q, landlordId, src.tenant_id)) {
    return { customerId: await residentRecord(q, landlordId, src.tenant_id), tenantId: src.tenant_id, existing: true }
  }
  const same = await findSamePerson(q, landlordId, src.email, src.phone).catch(() => null)
  if (same?.customerId) return { customerId: same.customerId, tenantId: await tenantOfRecord(q, same.customerId), existing: true }
  if (same?.tenantId) return { customerId: await residentRecord(q, landlordId, same.tenantId), tenantId: same.tenantId, existing: true }

  const ref = `${c.s}:${c.id}`
  const before = (await q.query<{ id: string; tenant_id: string | null }>(
    `SELECT id, tenant_id FROM pos_customers WHERE landlord_id = $1 AND elsewhere_ref = $2 AND archived_at IS NULL`, [landlordId, ref])).rows[0]
  if (before) return { customerId: before.id, tenantId: before.tenant_id ?? null, existing: true }

  // Only what the clerk typed in full — and an address only one record here may hold.
  const typedEmail = c.e && !(await q.query(`SELECT 1 FROM pos_customers WHERE landlord_id = $1 AND lower(email) = $2`, [landlordId, c.e])).rows[0]
    ? c.e : null
  const made = (await q.query<{ id: string }>(
    `INSERT INTO pos_customers (landlord_id, first_name, last_name, email, phone, created_from, elsewhere_ref)
     VALUES ($1, $2, $3, $4, $5, 'manual', $6)
     ON CONFLICT (landlord_id, elsewhere_ref) WHERE archived_at IS NULL AND elsewhere_ref IS NOT NULL DO NOTHING
     RETURNING id`,
    [landlordId, String(src.first_name ?? '').trim() || 'Customer', String(src.last_name ?? '').trim(), typedEmail, c.p ?? null, ref])).rows[0]
  if (made) return { customerId: made.id, tenantId: null, existing: false }
  const raced = (await q.query<{ id: string }>(
    `SELECT id FROM pos_customers WHERE landlord_id = $1 AND elsewhere_ref = $2 AND archived_at IS NULL`, [landlordId, ref])).rows[0]
  if (!raced) throw new AppError(409, 'They could not be added just now — type their name again and pick them.')
  return { customerId: raced.id, tenantId: null, existing: true }
}

/** What the clerk is told when a past sale cannot be found for them. */
export const SALE_GONE = 'That sale is not on this register — open History again and pick it from the list.'

/** What the clerk is told when a pick from elsewhere cannot be used. */
export const PICK_GONE = 'That pick has run out — type their name again and pick them from the list.'

// ── Linking a sale ───────────────────────────────────────────────────────

export type LinkTarget =
  | { kind: 'customer'; posCustomerId: string }
  | { kind: 'resident'; tenantId: string }
  | { kind: 'new'; person: NewPerson }
  | { kind: 'elsewhere'; pick: string; userId: string }
  | { kind: 'clear' }

export interface LinkResult {
  id: string
  pos_customer_id: string | null
  tenant_id: string | null
  customer_name: string | null
  also_moved: number
  card: string | null
  message: string
  /**
   * 10/2 (review): handed back to put the link back exactly as it was —
   * POST /pos/transactions/:id/customer/undo. Sealed: the screen never reads
   * it. Null when there is nothing to put back.
   */
  undo: string | null
}

/**
 * Link sale S to a person — the History row, the panel after a sale, and the
 * API's one way to say who a past sale was for. Runs on the caller's open
 * transaction. `saleCard` is the card read back from Stripe for a sale that
 * named nobody (read before the transaction; it is only used if S still names
 * nobody once locked). `userId`: the clerk, so the Undo it hands back is theirs.
 */
export async function linkSaleToPerson(client: Q, opts: {
  landlordId: string; saleId: string; target: LinkTarget; saleCard?: CardIdentity | null; userId?: string
}): Promise<LinkResult> {
  const L = opts.landlordId
  const sale = (await client.query<any>(
    `SELECT id, tenant_id, pos_customer_id, payment_method, created_at
       FROM pos_transactions WHERE id = $1 AND landlord_id = $2 FOR UPDATE`, [opts.saleId, L])).rows[0]
  if (!sale) throw new AppError(404, SALE_GONE)

  if (opts.target.kind === 'clear') {
    await client.query(`UPDATE pos_transactions SET pos_customer_id = NULL, tenant_id = NULL WHERE id = $1`, [sale.id])
    return { id: sale.id, pos_customer_id: null, tenant_id: null, customer_name: null, also_moved: 0, card: null,
             message: 'This sale no longer names a customer.', undo: null }
  }

  const prevId: string | null = sale.pos_customer_id ?? null
  const prev = prevId ? await recordState(client, prevId) : null
  let personId: string
  let renamedPrev = false
  // What this link changes besides the sale, so Undo can put it back.
  let renamed: LinkUndo['renamed']
  let made: string | undefined

  const t = opts.target
  if (t.kind === 'customer') {
    const c = UUID.test(t.posCustomerId) ? (await client.query<{ id: string }>(
      `SELECT id FROM pos_customers WHERE id = $1 AND landlord_id = $2 AND archived_at IS NULL`, [t.posCustomerId, L])).rows[0] : null
    if (!c) throw new AppError(404, NOT_ON_REGISTER)
    personId = c.id
  } else if (t.kind === 'resident') {
    const ok = UUID.test(t.tenantId) ? (await client.query(
      `SELECT 1 FROM tenants tn WHERE tn.id = $1 AND ${tenantOfCompanySql('tn.id', '$2')}`, [t.tenantId, L])).rows[0] : null
    if (!ok) throw new AppError(404, NOT_ON_REGISTER)
    personId = await residentRecord(client, L, t.tenantId)
  } else if (t.kind === 'elsewhere') {
    const r = await customerFromElsewhere(client, L, t.userId, t.pick)
    personId = r.customerId
    if (!r.existing) made = r.customerId
  } else {
    // "Add new" — unless they are already here by email or phone. A sale on an
    // unconfirmed card record is this person's card: the record is named, so
    // every sale on that card is theirs. Not when the card is printed with a
    // different last name — that is someone else's card.
    const n = cleanNew(t.person)
    const same = await findSamePerson(client, L, n.email, n.phone)
    if (same?.customerId) personId = same.customerId
    else if (same?.tenantId) personId = await residentRecord(client, L, same.tenantId)
    else if (prev?.standIn && (!prev.printedName || sameText(prev.lastName, n.last))) {
      const before = (await client.query<any>(
        `SELECT first_name, last_name, email, phone FROM pos_customers WHERE id = $1`, [prev.id])).rows[0]
      renamed = { id: prev.id, first: before.first_name, last: before.last_name, email: before.email ?? null, phone: before.phone ?? null }
      await client.query(
        `UPDATE pos_customers SET first_name = $2, last_name = $3, email = $4, phone = $5, updated_at = NOW() WHERE id = $1`,
        [prev.id, n.first, n.last, n.email, n.phone])
      personId = prev.id
      renamedPrev = true
    } else {
      personId = (await client.query<{ id: string }>(
        `INSERT INTO pos_customers (landlord_id, first_name, last_name, email, phone, created_from)
         VALUES ($1, $2, $3, $4, $5, 'manual') RETURNING id`, [L, n.first, n.last, n.email, n.phone])).rows[0].id
      made = personId
    }
  }

  const person = (await recordState(client, personId))!
  // 1. The sale is theirs.
  await client.query(`UPDATE pos_transactions SET pos_customer_id = $2, tenant_id = $3 WHERE id = $1`,
    [sale.id, personId, person.tenantId])

  // 2–3. Its card, and every sale on it.
  let outcome: CardOutcome = { kind: 'none' }
  const into = { id: personId, lastName: person.lastName }
  // The reason is a short clause inside the clerk's sentence — never a whole
  // refusal (with its own "press Cancel") pasted into it.
  const notMoved = (card: string | null) => (e: any): CardOutcome =>
    ({ kind: 'not_moved', card, reason: /charge account/i.test(String(e?.message ?? '')) ? 'both records have a charge account' : 'something only one record can hold' })
  if (renamedPrev) {
    outcome = { kind: 'named', card: prev!.card, ...(await salesBeside(client, personId, sale)) }
  } else if (prev && prev.id !== personId && prev.standIn) {
    outcome = await withSavepoint(client, () => foldStandIn(client, L, prev, into, sale), notMoved(prev.card))
  } else if (!prevId && !sale.tenant_id && (sale.payment_method === 'card' || sale.payment_method === 'card_on_file') && opts.saleCard) {
    const card = opts.saleCard
    outcome = await withSavepoint(client, () => applyCardToPerson(client, { landlordId: L, card, person: into, sale }), notMoved(cardLabel(card)))
  }

  // 4. A resident's sales say so.
  let stamped: string[] = []
  if (person.tenantId) {
    stamped = (await client.query<{ id: string }>(
      `UPDATE pos_transactions SET tenant_id = $2 WHERE pos_customer_id = $1 AND landlord_id = $3 AND tenant_id IS NULL RETURNING id`,
      [personId, person.tenantId, L])).rows.map((r) => r.id)
  }

  const name = fullName(person.firstName, person.lastName) || 'this customer'
  const sentence = cardOutcomeSentence(outcome)
  const lead = renamedPrev ? `Saved ${name}` : `Linked to ${name}`
  const message = !sentence ? `${lead}.`
    : (outcome.kind === 'folded' || outcome.kind === 'named') ? `${lead} — ${sentence}.`
    : `${lead}. ${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`
  const undo = opts.userId ? sealUndo({
    l: L, u: opts.userId,
    sale: { id: sale.id, c: prevId, t: sale.tenant_id ?? null, to: personId },
    ...(outcome.kind === 'folded' && outcome.fold ? { fold: outcome.fold } : {}),
    ...(outcome.kind === 'attached' && outcome.attach ? { attach: outcome.attach } : {}),
    ...(renamed ? { renamed } : {}),
    ...(made ? { made } : {}),
    stamped,
  }) : null
  return {
    id: sale.id, pos_customer_id: personId, tenant_id: person.tenantId, customer_name: name,
    also_moved: (outcome.kind === 'folded' || outcome.kind === 'named') ? outcome.earlier + outcome.later : 0,
    card: outcome.kind !== 'none' ? outcome.card : null,
    message, undo,
  }
}

// ── Undo ─────────────────────────────────────────────────────────────────

/**
 * 10/2 (review): a wrong pick can be put back. Linking a sale (or a card
 * tapped for the person picked at the register) can carry far more than the
 * one sale: a card record folded in with all its other sales and a card kept
 * on file, a card put on their record, a resident's id stamped on sales. Change
 * customer moves only the one sale back, so a wrong pick used to leave a
 * stranger's sales — and their kept card, behind the wrong person's "On file" —
 * where they landed. Undo puts every one of those back exactly: the rows that
 * moved, by id; the records' own details as they were. Sealed with the server's
 * key, bound to this company and this clerk, good for half an hour, and only
 * while the sale still names whom the link named.
 */
interface LinkUndo {
  l: string; u: string; x: number
  /** The sale: who it named before (c, t) and whom the link made it name (to). */
  sale: { id: string; c: string | null; t: string | null; to: string | null }
  fold?: MergeRecord
  attach?: CardAttach
  renamed?: { id: string; first: string; last: string; email: string | null; phone: string | null }
  /** A record this link made (typed in, or picked from elsewhere). */
  made?: string
  /** Sales that took the person's tenant id. */
  stamped: string[]
}
const UNDO_LABEL = 'gam-pos-link-undo'
const UNDO_TTL_MS = 30 * 60_000
/** A fold of a card record with hundreds of sales makes a long token; past this, no Undo is offered. */
const UNDO_MAX = 24_000

export function sealUndo(u: Omit<LinkUndo, 'x'>): string | null {
  const token = seal(UNDO_LABEL, { ...u, x: Date.now() + UNDO_TTL_MS })
  return token.length <= UNDO_MAX ? token : null
}

/** What the clerk is told when an Undo can no longer be used. */
export const UNDO_GONE = 'That can no longer be undone here — it ran out or was already done. Open the sale in History and pick the right person.'

/**
 * The Undo a sale rung at the register hands back when the card tapped was
 * folded into the person picked (cardNote): the sale stays theirs — they were
 * picked — and the card record and its other sales go back.
 */
export function saleTimeUndo(opts: { landlordId: string; userId: string; saleId: string; customerId: string; tenantId: string | null; outcome: CardOutcome | null }): string | null {
  const o = opts.outcome
  if (!o || o.kind !== 'folded' || !o.fold) return null
  return sealUndo({
    l: opts.landlordId, u: opts.userId,
    sale: { id: opts.saleId, c: opts.customerId, t: opts.tenantId, to: opts.customerId },
    fold: o.fold, stamped: [],
  })
}

/**
 * Is a register record EMPTY — nothing ever written against it: no sale, no
 * ticket, no pay link, no card, no invitation, no charge account? (An open
 * cart only copies the register's screen, so it does not count.)
 */
async function recordHoldsNothing(q: Q, customerId: string): Promise<boolean> {
  const r = (await q.query<{ any: boolean }>(
    `SELECT (EXISTS (SELECT 1 FROM pos_transactions WHERE pos_customer_id = $1)
          OR EXISTS (SELECT 1 FROM pos_open_tickets WHERE pos_customer_id = $1)
          OR EXISTS (SELECT 1 FROM pos_pay_links WHERE pos_customer_id = $1)
          OR EXISTS (SELECT 1 FROM pos_customer_cards WHERE pos_customer_id = $1)
          OR EXISTS (SELECT 1 FROM pos_customer_invitations WHERE pos_customer_id = $1)
          OR EXISTS (SELECT 1 FROM flex_charge_accounts WHERE pos_customer_id = $1)) AS any`, [customerId])).rows[0]
  return !r?.any
}

/**
 * Close a record nothing was ever written against — archived, never deleted.
 * Its email and phone go into its note, so an address it held is free for the
 * next record (a closed record holding an address would otherwise refuse it),
 * and an open cart that named it names nobody.
 */
async function closeEmptyRecord(q: Q, landlordId: string, customerId: string, why: string): Promise<boolean> {
  if (!(await recordHoldsNothing(q, customerId))) return false
  const closed = await q.query(
    `UPDATE pos_customers
        SET archived_at = NOW(), updated_at = NOW(), email = NULL, phone = NULL,
            notes = TRIM(COALESCE(notes, '') || ' ' || $3 || COALESCE(' (email ' || email || ')', '') || COALESCE(' (phone ' || phone || ')', ''))
      WHERE id = $1 AND landlord_id = $2 AND archived_at IS NULL AND tenant_id IS NULL RETURNING id`,
    [customerId, landlordId, why])
  if (!closed.rows.length) return false
  await q.query(`UPDATE pos_sessions SET pos_customer_id = NULL, updated_at = NOW() WHERE pos_customer_id = $1 AND status = 'open'`, [customerId])
  return true
}

/**
 * 10/2 (review, front desk foolproof: "back out with one button and no side
 * effects"). Picking someone from elsewhere at the register makes their record
 * here at once — the register's every step (the reader, a ticket, the card on
 * file) names people by record. When the clerk takes them back off (× or
 * Clear) before anything was written against them, that record goes again:
 * only a record made from a pick, only an empty one, only this company's.
 */
export async function letGoOfPick(q: Q, landlordId: string, customerId: string): Promise<boolean> {
  if (!UUID.test(customerId)) return false
  const c = (await q.query<{ id: string }>(
    `SELECT id FROM pos_customers WHERE id = $1 AND landlord_id = $2 AND archived_at IS NULL
        AND elsewhere_ref IS NOT NULL AND tenant_id IS NULL FOR UPDATE`, [customerId, landlordId])).rows[0]
  if (!c) return false
  return closeEmptyRecord(q, landlordId, c.id, 'Picked at the register and taken off again before anything was sold.')
}

/** Put a link back (see LinkUndo). Runs on the caller's open transaction. */
export async function undoLink(client: Q, opts: { landlordId: string; userId: string; saleId: string; token: unknown }): Promise<LinkResult> {
  const u = unseal(UNDO_LABEL, opts.token, UNDO_MAX) as LinkUndo | null
  if (!u || u.l !== opts.landlordId || u.u !== opts.userId || typeof u.x !== 'number' || u.x < Date.now()
      || u.sale?.id !== opts.saleId) {
    throw new AppError(409, UNDO_GONE)
  }
  const L = opts.landlordId
  const sale = (await client.query<any>(
    `SELECT id, pos_customer_id FROM pos_transactions WHERE id = $1 AND landlord_id = $2 FOR UPDATE`, [opts.saleId, L])).rows[0]
  if (!sale) throw new AppError(404, SALE_GONE)
  if ((sale.pos_customer_id ?? null) !== (u.sale.to ?? null)) throw new AppError(409, UNDO_GONE)

  let movedBack = 0
  // The card record folded in comes back, with everything that moved with it.
  if (u.fold) {
    const f = u.fold
    const loser = (await client.query<{ id: string }>(
      `SELECT id FROM pos_customers WHERE id = $1 AND landlord_id = $2 AND archived_at IS NOT NULL FOR UPDATE`, [f.loserId, L])).rows[0]
    const survivor = (await client.query<{ id: string }>(
      `SELECT id FROM pos_customers WHERE id = $1 AND landlord_id = $2 AND archived_at IS NULL FOR UPDATE`, [f.into, L])).rows[0]
    if (!loser || !survivor) throw new AppError(409, UNDO_GONE)
    // The survivor gives back what it took (an address first: one live record per address).
    await client.query(
      `UPDATE pos_customers SET email = $2, phone = $3, stripe_customer_id = $4, tenant_id = $5, elsewhere_ref = $6, updated_at = NOW()
        WHERE id = $1`,
      [f.into, f.intoBefore.email, f.intoBefore.phone, f.intoBefore.stripe_customer_id, f.intoBefore.tenant_id, f.intoBefore.elsewhere_ref])
    await client.query(
      `UPDATE pos_customers SET archived_at = NULL, email = $2, phone = $3, notes = $4, updated_at = NOW() WHERE id = $1`,
      [f.loserId, f.loserBefore.email, f.loserBefore.phone, f.loserBefore.notes])
    for (const table of MERGE_MOVED_TABLES) {
      const ids = f.moved[table]
      if (!ids?.length) continue
      const back = await client.query(
        `UPDATE ${table} SET pos_customer_id = $1 WHERE id = ANY($2::uuid[]) AND pos_customer_id = $3`, [f.loserId, ids, f.into])
      if (table === 'pos_transactions') movedBack += back.rowCount ?? 0
    }
    if (f.stamped.length) {
      await client.query(`UPDATE pos_transactions SET tenant_id = NULL WHERE id = ANY($1::uuid[]) AND id <> $2`, [f.stamped, u.sale.id])
    }
  }
  // A card put on them: back where it was — off a closed record, or not known here at all.
  if (u.attach) {
    const a = u.attach
    if (a.prevOwner) {
      await client.query(
        `UPDATE pos_customer_cards SET pos_customer_id = $3 WHERE landlord_id = $1 AND fingerprint = $2 AND pos_customer_id = $4`,
        [L, a.fingerprint, a.prevOwner, a.on])
    } else {
      // Only the bare row this link wrote: never a card kept on file since.
      await client.query(
        `DELETE FROM pos_customer_cards WHERE landlord_id = $1 AND fingerprint = $2 AND pos_customer_id = $3 AND stripe_payment_method_id IS NULL`,
        [L, a.fingerprint, a.on])
    }
  }
  if (u.renamed) {
    await client.query(
      `UPDATE pos_customers SET first_name = $2, last_name = $3, email = $4, phone = $5, updated_at = NOW() WHERE id = $1 AND landlord_id = $6`,
      [u.renamed.id, u.renamed.first, u.renamed.last, u.renamed.email, u.renamed.phone, L])
  }
  if (u.stamped.length) {
    await client.query(`UPDATE pos_transactions SET tenant_id = NULL WHERE id = ANY($1::uuid[]) AND id <> $2`, [u.stamped, u.sale.id])
  }
  // The sale names whom it named before.
  await client.query(`UPDATE pos_transactions SET pos_customer_id = $2, tenant_id = $3 WHERE id = $1`, [u.sale.id, u.sale.c, u.sale.t])
  // A record this link made, with nothing left on it, goes again.
  if (u.made && u.made !== u.sale.c) await closeEmptyRecord(client, L, u.made, 'Made by a link that was undone.')

  const now = u.sale.c ? await recordState(client, u.sale.c) : null
  const name = now ? (fullName(now.firstName, now.lastName) || null) : null
  const shownName = name && !isCardCustomer(now?.firstName, now?.lastName) ? name : null
  const others = movedBack
  const sales = `${others} other sale${others === 1 ? '' : 's'}`
  // At the register the person was picked for this very sale: it stays theirs.
  const stays = u.sale.c === u.sale.to
  const message = stays
    ? `Put back — the card${others > 0 ? ` and ${sales}` : ''} went back where ${others > 0 ? 'they were' : 'it was'}; this sale stays with ${shownName ?? 'them'}.`
    : `Put back — this sale${others > 0 ? ` and ${sales} are` : ' is'} the way ${others > 0 ? 'they were' : 'it was'}.`
  return {
    id: u.sale.id, pos_customer_id: u.sale.c, tenant_id: u.sale.t, customer_name: shownName,
    also_moved: others, card: null, undo: null, message,
  }
}

// ── Search ───────────────────────────────────────────────────────────────

export interface PersonHit {
  key: string
  kind: 'resident' | 'customer' | 'elsewhere'
  tenantId: string | null
  customerId: string | null
  name: string
  hint: string | null
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  /** Someone from elsewhere only: the sealed pick handed back to choose them (never an id). */
  pick?: string
}

const OWN_LIMIT = 8

function wordsOf(q: string): string[] {
  return q.split(/\s+/).map((w) => w.trim()).filter((w) => /[\p{L}\p{N}]/u.test(w)).slice(0, 5)
}

/** Every typed word must match the first name, last name or email; 3+ digits match inside the phone. */
function wordFilter(words: string[], cols: { first: string; last: string; email: string; phone: string }, params: any[]): string {
  if (!words.length) return 'FALSE'
  return words.map((w) => {
    const p = params.push(`%${likeEscape(w)}%`)
    const d = digitsOf(w)
    const phone = d.length >= 3 ? ` OR ${phoneSql(cols.phone)} LIKE $${params.push(`%${d}%`)}` : ''
    return `(${cols.first} ILIKE $${p} OR ${cols.last} ILIKE $${p} OR ${cols.email} ILIKE $${p}${phone})`
  }).join(' AND ')
}

/**
 * Outside this company a phone matches only WHOLE: the full number with its
 * area code (the last ten digits), or a number kept without one typed exactly.
 */
export const ELSEWHERE_PHONE_FULL = 10
export const ELSEWHERE_PHONE_LOCAL = 7
const PHONE_WORD = /^[\d()+.-]+$/

/**
 * The words a search outside this company reads: a phone typed in pieces
 * ("602 555 0199", "bob 602 555-0199") is one number, not three words.
 */
function elsewhereTokens(words: string[]): string[] {
  const out: string[] = []
  for (const w of words) {
    const prev = out.length ? out[out.length - 1] : null
    if (prev !== null && PHONE_WORD.test(w) && PHONE_WORD.test(prev) && digitsOf(w) && digitsOf(prev)) out[out.length - 1] = prev + w
    else out.push(w)
  }
  return out
}

/**
 * 10/2 (privacy, settled with Nic's "five Bobs" — which is about NAMES): the
 * filter for people at OTHER companies. Every typed word must match the first
 * or last name IN PART — or a contact detail WHOLE: the whole email address,
 * the whole part of it before the "@", or the whole phone number
 * (ELSEWHERE_PHONE_FULL / ELSEWHERE_PHONE_LOCAL). Never a piece of one. The
 * masked hint a match comes back with (z•••@gmail.com — elsewhereHint) hands
 * the clerk the ends of a stranger's email; matching on any piece of it would
 * let the hit-or-miss of each search rebuild the rest one character at a time
 * (review, 10/2: "bob 77@gmail.com" hit, "bob 177@gmail.com" missed). So "bob"
 * finds every Bob, "zqprivate77@gmail.com" or "602 555 0199" finds its owner,
 * and "gmail.com", "7@gmail.com" or "550199" lists nobody. This company's own
 * people — its register customers, and anybody who lives under one of its
 * leases, at any of its parks — keep the looser wordFilter (a former resident
 * does not: decisions #10).
 */
function elsewhereFilter(words: string[], cols: { first: string; last: string; email: string; phone: string }, params: any[]): string {
  const tokens = elsewhereTokens(words)
  if (!tokens.length) return 'FALSE'
  const phone = phoneSql(cols.phone)
  return tokens.map((w) => {
    const p = params.push(`%${likeEscape(w)}%`)
    const lower = w.toLowerCase()
    const email = lower.includes('@')
      ? ` OR lower(${cols.email}) = $${params.push(lower)}`
      : ` OR split_part(lower(${cols.email}), '@', 1) = $${params.push(lower)}`
    const d = digitsOf(w)
    const whole = !PHONE_WORD.test(w) ? ''
      : d.length >= ELSEWHERE_PHONE_FULL ? ` OR (length(${phone}) >= ${ELSEWHERE_PHONE_FULL} AND right(${phone}, ${ELSEWHERE_PHONE_FULL}) = $${params.push(d.slice(-ELSEWHERE_PHONE_FULL))})`
      : d.length >= ELSEWHERE_PHONE_LOCAL ? ` OR ${phone} = $${params.push(d)}`
      : ''
    return `(${cols.first} ILIKE $${p} OR ${cols.last} ILIKE $${p}${email}${whole})`
  }).join(' AND ')
}

/**
 * The order the clerk sees: 0 — a typed word starts the last name; 1 — it
 * starts the first name; 2 — anything else. Each query sorts by it BEFORE its
 * LIMIT (a park with hundreds of loose matches must still put the last name
 * typed at the top), and the merged list sorts by the same number.
 */
function rankSql(words: string[], cols: { first: string; last: string }, params: any[]): string {
  const starts = words.map((w) => `$${params.push(`${likeEscape(w)}%`)}`)
  const any = (col: string) => starts.map((p) => `${col} ILIKE ${p}`).join(' OR ')
  return `(CASE WHEN ${any(cols.last)} THEN 0 WHEN ${any(cols.first)} THEN 1 ELSE 2 END)`
}

// ── Staff forms ──────────────────────────────────────────────────────────

/**
 * 10/2 (Nic, front desk foolproof): a staff-facing form refused in plain words
 * with the next step — never a parser path like "addNew.firstName: …" or
 * "items.0.qty: Number must be greater than 0". `words` maps the first field
 * the parser stopped at to what the clerk is told: its full path
 * ("addNew.firstName"), the same path with list positions as N ("items.N.qty"),
 * or its top-level field ("items").
 */
export function parseForStaff<S extends ZodTypeAny>(schema: S, data: unknown, words: Record<string, string>, otherwise: string): ZodOutput<S> {
  const r = schema.safeParse(data)
  if (r.success) return r.data as ZodOutput<S>
  const path = r.error.issues[0]?.path ?? []
  const key = path.map(String).join('.')
  const anyIndex = path.map((p) => (typeof p === 'number' ? 'N' : String(p))).join('.')
  const top = String(path[0] ?? '')
  throw new AppError(400, words[key] ?? words[anyIndex] ?? words[top] ?? otherwise)
}

/**
 * What the clerk is told about one cart line the server cannot take — the
 * same words on the register, a ticket and a pay link. `press` names the
 * button to press again.
 */
export function cartLineWords(press: string): Record<string, string> {
  return {
    'items.N.qty': `A line in the cart needs a quantity above zero — fix how many, then press ${press} again.`,
    'items.N.price': `A line in the cart has a price below zero — take that line out, add it again, then press ${press} again.`,
    'items.N.tax': `A line in the cart has a tax below zero — take that line out, add it again, then press ${press} again.`,
    'items.N.id': `One of those items is not on your register any more — take it out of the cart, then press ${press} again.`,
    'items.N.name': `An item name in the cart is too long — take that line out, add it again, then press ${press} again.`,
    'items.N.stayTotal': `The stay's price in the cart could not be read — tap the site and dates, press Use this site, then press ${press} again.`,
  }
}

/**
 * 10/2 (review): a cart line's register item id, as the database writes it —
 * lowercase. Postgres reads "ABC…" and "abc…" as the same uuid; a JS Map or a
 * string compare does not, so an id sent in capitals slipped past every check
 * keyed by the database's own id (the cashier pricing rule, a pay link's own
 * lines) while the sale still found the item. Every route that takes cart
 * lines reads them through here first.
 */
export function lowerLineIds<T>(items: T): T {
  if (!Array.isArray(items)) return items
  return items.map((i: any) => (i && typeof i.id === 'string' ? { ...i, id: i.id.trim().toLowerCase() } : i)) as unknown as T
}

/**
 * Every cart line that names a register item names one of THIS company's —
 * refused in the clerk's words (never a database error) otherwise.
 */
export async function assertItemsAreOurs(landlordId: string, items: any[], press: string): Promise<void> {
  const ids = [...new Set((Array.isArray(items) ? items : []).map((i) => i?.id).filter((x: unknown): x is string => typeof x === 'string' && x !== ''))]
  if (!ids.length) return
  const known = ids.every((id) => UUID.test(id))
    ? await query<{ id: string }>(`SELECT id FROM pos_items WHERE id = ANY($1::uuid[]) AND landlord_id = $2`, [ids, landlordId])
    : []
  if (known.length !== ids.length) throw new AppError(400, cartLineWords(press)['items.N.id'])
}

/** What one of quantity buys on a stay item, said the way a person counts it. */
const STAY_UNIT_PLURAL: Record<string, string> = { night: 'nights', week: 'weeks', month: 'months' }

/** A stay quantity is a whole number of nights (or weeks, or months), one or more. */
export function isWholeStayQty(qty: unknown): boolean {
  const n = Number(qty)
  return Number.isFinite(n) && Math.abs(n - Math.round(n)) < 1e-9 && Math.round(n) >= 1
}

/** What the clerk is told about a stay that is not whole nights (or weeks, or months). */
export function wholeStayWords(stayUnit: string | null | undefined, itemName: string, press: string): string {
  return `A stay is whole ${STAY_UNIT_PLURAL[String(stayUnit)] ?? 'nights'} — fix how many on "${itemName}", then press ${press} again.`
}

/**
 * 10/2 (review): every stay line in a cart is a whole number of nights (or
 * weeks, or months). Half a night has no check-out date: a three-night link
 * settled at 0.5 left its booking checking in and out the same day, 0 nights,
 * and the site the guest was told they had went free. Read from the ITEM
 * (pos_items.stay_unit), wherever a stay quantity is taken — the register, a
 * reservation ticket, a pay link sent or adjusted.
 */
export async function assertWholeStays(landlordId: string, items: any[], press: string): Promise<void> {
  const lines = Array.isArray(items) ? items : []
  const idOf = (x: unknown) => (typeof x === 'string' ? x.trim().toLowerCase() : '')
  const ids = [...new Set(lines.map((i) => idOf(i?.id)).filter((x) => UUID.test(x)))]
  if (!ids.length) return
  const stays = await query<{ id: string; name: string; stay_unit: string }>(
    `SELECT id, name, stay_unit FROM pos_items WHERE id = ANY($1::uuid[]) AND landlord_id = $2 AND stay_unit IS NOT NULL`,
    [ids, landlordId])
  for (const it of lines) {
    const s = stays.find((x) => x.id === idOf(it?.id))
    if (s && !isWholeStayQty(it?.qty)) throw new AppError(400, wholeStayWords(s.stay_unit, s.name, press))
  }
}

// ── What was typed ──────────────────────────────────────────────────────

/** Longest search the register takes, in characters as sent. Longer is refused (400). */
export const PEOPLE_QUERY_MAX = 120

/**
 * THE one reading of what was typed — the search AND the limit on looking
 * outside this company both read it here, so what is counted is always exactly
 * what is searched. Unicode-normalized; invisible characters (zero-width
 * spaces, soft hyphens, byte-order marks) dropped; tabs, newlines and every odd
 * space one plain space; trimmed. Padding a search, or dressing it in invisible
 * characters, is the same search — and the same count.
 */
export function normalizePeopleQuery(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : raw == null ? '' : Array.isArray(raw) ? String(raw[0] ?? '') : String(raw)
  return s.normalize('NFKC')
    .replace(/[\u00ad\u180e\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The words a search outside this company uses, from the normalized text:
 * words of two characters or more, and at least one of three. Empty means
 * nothing is looked up elsewhere — and nothing is counted.
 */
export function elsewhereWords(normalized: string): string[] {
  const words = wordsOf(normalized).filter((w) => w.length >= 2)
  return words.some((w) => w.length >= 3) ? words : []
}

/** Refuses a search the register would never send: more than one, or too long. */
export function peopleQueryGuard(req: Request, _res: Response, next: NextFunction): void {
  const q = (req.query as any)?.q
  if (q != null && typeof q !== 'string') return next(new AppError(400, 'Type one name, email or phone number to search.'))
  if (typeof q === 'string' && q.length > PEOPLE_QUERY_MAX) {
    return next(new AppError(400, `That search is too long — type part of a name, email or phone number (${PEOPLE_QUERY_MAX} characters at most).`))
  }
  next()
}

// ── Picks from elsewhere ─────────────────────────────────────────────────

/**
 * A person from outside this company comes back with no id — only a sealed
 * pick the clerk's screen hands back unread when they are chosen. Sealed
 * (AES-256-GCM, keyed off the server secret), bound to this company and this
 * clerk, good for half an hour. `e`/`p`: the email or phone the clerk typed IN
 * FULL, the only contact detail a pick may carry into this company's record.
 */
interface PickClaims { s: 'u' | 'c'; id: string; l: string; u: string; x: number; e?: string; p?: string }
const PICK_TTL_MS = 30 * 60_000

/** A key of the server's own for one kind of sealed token (never hard-coded: derived from the server secret). */
function sealKey(label: string): Buffer {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new AppError(500, 'The register is not set up to look people up right now.')
  return createHash('sha256').update(`${label}:${secret}`).digest()
}

/** Seal `claims` (AES-256-GCM) so only this server can read them back. */
function seal(label: string, claims: object): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', sealKey(label), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(claims), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}

/** What a sealed token holds — null for anything this server did not seal with that label. */
function unseal(label: string, token: unknown, maxLength: number): any | null {
  if (typeof token !== 'string' || token.length < 40 || token.length > maxLength) return null
  try {
    const raw = Buffer.from(token, 'base64url')
    const decipher = createDecipheriv('aes-256-gcm', sealKey(label), raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'))
  } catch { return null }
}

const PICK_LABEL = 'gam-pos-people-pick'

export function sealPick(c: Omit<PickClaims, 'x'> & { x?: number }): string {
  return seal(PICK_LABEL, { ...c, x: c.x ?? Date.now() + PICK_TTL_MS })
}

export function openPick(token: unknown): PickClaims | null {
  const c = unseal(PICK_LABEL, token, 2000)
  if (!c || (c.s !== 'u' && c.s !== 'c') || !UUID.test(String(c.id)) || typeof c.l !== 'string' || typeof c.u !== 'string' || typeof c.x !== 'number') return null
  return c as PickClaims
}

/** j•••@gmail.com — the first letter and the domain, nothing else. */
export function maskEmail(email: string | null | undefined): string | null {
  const e = String(email ?? '').trim().toLowerCase()
  const at = e.lastIndexOf('@')
  if (at < 1 || at === e.length - 1) return null
  return `${e[0]}•••@${e.slice(at + 1)}`
}

/** What tells two people of the same name apart, masked: phone ••1234, else j•••@gmail.com. (This company's own people.) */
export function maskedHint(email: string | null | undefined, phone: string | null | undefined): string | null {
  const d = digitsOf(phone)
  if (d.length >= 4) return `phone ••${d.slice(-4)}`
  return maskEmail(email)
}

/**
 * The hint on somebody from ELSEWHERE. 10/2 (review): never digits of a phone
 * the clerk did not type. "Bob Smith · phone ••0199" handed a stranger's last
 * four digits to anyone who typed a name; with the area code and the last four
 * known, about a thousand whole-number guesses (each one a search that either
 * finds Bob Smith or does not) rebuilt the rest of his number. So: the masked
 * email (j•••@gmail.com — the first letter and the domain); with no email,
 * "phone on file"; "phone ••0199" only when the clerk typed that whole number
 * themselves (it tells them nothing they did not type).
 */
export function elsewhereHint(email: string | null | undefined, phone: string | null | undefined, phoneTypedWhole: boolean): string | null {
  const d = digitsOf(phone)
  if (phoneTypedWhole && d.length >= 4) return `phone ••${d.slice(-4)}`
  return maskEmail(email) ?? (d.length >= 4 ? 'phone on file' : null)
}

const ELSEWHERE_LIMIT = 8

/**
 * ── THE CROSS-COMPANY RULE (10/2, Nic — settled) ─────────────────────────
 *
 * "If there's five Bobs next door... I type Bob and then I remember the last
 *  name from a visual cue from seeing the five Bobs pop down... If they're a
 *  point of sale customer, it doesn't matter. It doesn't link to the tenancy
 *  at all."
 *
 * Part of a name finds people outside this company too — GAM tenant accounts
 * and other companies' register customers — and so does an email or phone
 * typed WHOLE: the whole address (or the whole part before the "@"), the whole
 * number (elsewhereFilter; "gmail.com", "7@gmail.com" or "550199" lists nobody,
 * so the masked hint can never be grown into the rest of it). Each comes back as
 * a NAME and a MASKED contact hint (elsewhereHint: j•••@gmail.com, else "phone
 * on file" — the last digits of a phone only when the clerk typed it whole) and
 * nothing else — no company, no site, no "resident", no lease, balance or
 * payment history, no ids, not even their real email or phone. Up to eight.
 * Not listed: anyone this register already lists as its own (this property's
 * residents and invitees, this company's register customers — by record, by
 * email or by phone), unconfirmed card records, and records that are themselves
 * picks from elsewhere (the person they copy is listed instead). Picking one
 * goes through customerFromElsewhere: a record in THIS company only.
 * Widening or narrowing the rule is a change to this function only.
 */
async function searchElsewhere(opts: { landlordId: string; propertyId: string; userId: string; typed: string; words: string[] }): Promise<PersonHit[]> {
  const { landlordId: L, propertyId: P, words } = opts
  const mine = (col: { email: string; phone: string }) => `EXISTS (
       SELECT 1 FROM pos_customers m WHERE m.landlord_id = $1 AND m.archived_at IS NULL
          AND ((${col.email} IS NOT NULL AND m.email IS NOT NULL AND lower(m.email) = lower(${col.email}))
            OR (length(${phoneSql(col.phone)}) >= 7 AND right(${phoneSql('m.phone')}, 10) = right(${phoneSql(col.phone)}, 10))))`

  const up: any[] = [L, P]
  const accounts = await query<any>(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.phone,
            ${rankSql(words, { first: 'u.first_name', last: 'u.last_name' }, up)} AS rnk
       FROM users u JOIN tenants tn ON tn.user_id = u.id
      WHERE u.role = 'tenant'
        AND TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) <> ''
        -- Somebody who LIVES under THIS company's leases (at its other park,
        -- say) is this company's own: any part of their email or phone finds
        -- them. Anyone else on GAM — a former resident of this company included
        -- (decisions #10) — only by the stricter rule (elsewhereFilter).
        AND (CASE WHEN ${tenantLivesHereSql('tn.id', '$1')}
                  THEN ${wordFilter(words, { first: 'u.first_name', last: 'u.last_name', email: 'u.email', phone: 'u.phone' }, up)}
                  ELSE ${elsewhereFilter(words, { first: 'u.first_name', last: 'u.last_name', email: 'u.email', phone: 'u.phone' }, up)} END)
        AND NOT EXISTS (SELECT 1 FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id JOIN units un ON un.id = l.unit_id
                         WHERE lt.tenant_id = tn.id AND l.landlord_id = $1 AND un.property_id = $2 AND lt.status <> 'void')
        AND NOT EXISTS (SELECT 1 FROM pending_tenant_intents i
                         WHERE i.tenant_id = tn.id AND i.landlord_id = $1 AND i.property_id = $2 AND i.cancelled_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM pos_customers m WHERE m.landlord_id = $1 AND m.archived_at IS NULL
                         AND (m.tenant_id = tn.id OR m.elsewhere_ref = 'u:' || u.id::text))
        AND NOT ${mine({ email: 'u.email', phone: 'u.phone' })}
      ORDER BY rnk, u.last_name, u.first_name
      LIMIT 40`, up)

  const cp: any[] = [L]
  const customers = await query<any>(
    `SELECT c.id, c.first_name, c.last_name, c.email, c.phone,
            ${rankSql(words, { first: 'c.first_name', last: 'c.last_name' }, cp)} AS rnk
       FROM pos_customers c
      WHERE c.landlord_id <> $1 AND c.archived_at IS NULL AND c.tenant_id IS NULL AND c.elsewhere_ref IS NULL
        AND NOT (c.first_name = 'Card' AND c.last_name = 'Customer')
        AND NOT (c.created_from = 'card_reader' AND c.email IS NULL AND c.phone IS NULL)
        AND TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) <> ''
        AND ${elsewhereFilter(words, { first: 'c.first_name', last: 'c.last_name', email: 'c.email', phone: 'c.phone' }, cp)}
        AND NOT EXISTS (SELECT 1 FROM pos_customers m WHERE m.landlord_id = $1 AND m.archived_at IS NULL AND m.elsewhere_ref = 'c:' || c.id::text)
        AND NOT ${mine({ email: 'c.email', phone: 'c.phone' })}
        -- A GAM account with the same email is that person: they are listed (or left out) as the account.
        AND NOT (c.email IS NOT NULL AND EXISTS (SELECT 1 FROM users u2 WHERE u2.role = 'tenant' AND lower(u2.email) = lower(c.email)))
      ORDER BY rnk, c.last_name, c.first_name
      LIMIT 40`, cp)

  // One row per person: an account before a register copy, the first of
  // several companies' copies, matched by email or phone.
  const typedEmail = EMAIL.test(opts.typed) ? opts.typed.toLowerCase() : null
  const typedDigits = /^[\d\s()+.-]+$/.test(opts.typed) && digitsOf(opts.typed).length >= 10 ? digitsOf(opts.typed).slice(-10) : null
  const seen = new Set<string>()
  const rows = [
    ...accounts.map((r: any) => ({ ...r, s: 'u' as const })),
    ...customers.map((r: any) => ({ ...r, s: 'c' as const })),
  ].sort((a, b) => Number(a.rnk) - Number(b.rnk))   // stable: accounts first within a rank
  const out: PersonHit[] = []
  for (const r of rows) {
    const email = r.email ? String(r.email).trim().toLowerCase() : ''
    const phone10 = digitsOf(r.phone).length >= 7 ? digitsOf(r.phone).slice(-10) : ''
    if ((email && seen.has(`e:${email}`)) || (phone10 && seen.has(`p:${phone10}`))) continue
    if (email) seen.add(`e:${email}`)
    if (phone10) seen.add(`p:${phone10}`)
    const pick = sealPick({
      s: r.s, id: r.id, l: L, u: opts.userId,
      ...(typedEmail && typedEmail === email ? { e: typedEmail } : {}),
      ...(typedDigits && phone10 && typedDigits === phone10 ? { p: opts.typed } : {}),
    })
    const first = String(r.first_name ?? '').trim(), last = String(r.last_name ?? '').trim()
    out.push({
      key: `x:${createHash('sha256').update(pick).digest('hex').slice(0, 16)}`, kind: 'elsewhere',
      tenantId: null, customerId: null, name: fullName(first, last),
      hint: elsewhereHint(r.email, r.phone, !!(typedDigits && phone10 && typedDigits === phone10)),
      firstName: first, lastName: last, email: null, phone: null, pick,
    })
    if (out.length >= ELSEWHERE_LIMIT) break
  }
  return out
}

/**
 * The register's type-ahead. Under two characters, nothing. Up to eight of
 * this property's residents and this company's register customers, then up to
 * eight people from elsewhere on GAM (searchElsewhere — name and a masked hint
 * only). Explicit columns only: no balances, rent, lease dates or payment
 * history ever leave here. `q` is read through normalizePeopleQuery — the same
 * reading the limit on looking elsewhere counts.
 */
export async function searchPeople(opts: { landlordId: string; propertyId: string; userId: string; q: unknown; allowElsewhere: boolean }): Promise<PersonHit[]> {
  const typed = normalizePeopleQuery(opts.q)
  if (typed.length < 2) return []
  const words = wordsOf(typed)
  if (!words.length) return []
  const L = opts.landlordId, P = opts.propertyId

  // 10/2 (review): the email and phone on somebody's own GAM account are read
  // — shown, and searched — only while they LIVE under one of this company's
  // leases (tenantLivesHereSql). An invite, a place a landlord drafted for
  // them (pending_add), or a tenancy that has ended (decisions #10: a former
  // resident) lists them by name — with whatever this company's own register
  // record holds for them, merged in below.
  const lives = tenantLivesHereSql('t.id', '$1')
  const acct = { first: 'u.first_name', last: 'u.last_name',
                 email: `(CASE WHEN ${lives} THEN u.email END)`, phone: `(CASE WHEN ${lives} THEN u.phone END)` }

  const rp: any[] = [L, P]
  const residents = await query<any>(
    `SELECT t.id AS tenant_id, u.first_name, u.last_name, ${acct.email} AS email, ${acct.phone} AS phone,
            bool_or(l.status IN ('pending', 'active') AND lt.status IN ('active', 'pending_remove')) AS current,
            -- A place drafted for them that they have not taken yet (an addendum
            -- adding them): they are on their way in, not a resident yet.
            bool_or(l.status IN ('pending', 'active') AND lt.status = 'pending_add') AS adding,
            (array_agg(un.unit_number ORDER BY (l.status IN ('pending', 'active')) DESC, l.created_at DESC))[1] AS site,
            ${rankSql(words, { first: 'u.first_name', last: 'u.last_name' }, rp)} AS rnk,
            (SELECT MAX(x.created_at) FROM pos_transactions x WHERE x.landlord_id = $1 AND x.tenant_id = t.id) AS last_purchase
       FROM tenants t
       JOIN users u ON u.id = t.user_id
       JOIN lease_tenants lt ON lt.tenant_id = t.id
       JOIN leases l ON l.id = lt.lease_id
       JOIN units un ON un.id = l.unit_id
      WHERE l.landlord_id = $1 AND un.property_id = $2
        AND lt.status <> 'void'   -- a voided place was never theirs
        AND ${wordFilter(words, acct, rp)}
      GROUP BY t.id, u.first_name, u.last_name, u.email, u.phone
      ORDER BY rnk, last_purchase DESC NULLS LAST, u.last_name, u.first_name
      LIMIT 40`, rp)

  const ip: any[] = [L, P]
  const invited = await query<any>(
    `SELECT * FROM (
       SELECT DISTINCT ON (t.id) t.id AS tenant_id, u.first_name, u.last_name, ${acct.email} AS email, ${acct.phone} AS phone,
              un.unit_number AS site,
              ${rankSql(words, { first: 'u.first_name', last: 'u.last_name' }, ip)} AS rnk
         FROM pending_tenant_intents i
         JOIN tenants t ON t.id = i.tenant_id
         JOIN users u ON u.id = t.user_id
         LEFT JOIN units un ON un.id = i.unit_id
        WHERE i.landlord_id = $1 AND i.property_id = $2 AND i.cancelled_at IS NULL
          AND ${wordFilter(words, acct, ip)}
        ORDER BY t.id, i.created_at DESC
     ) v
     ORDER BY v.rnk, v.last_name, v.first_name
     LIMIT 20`, ip)

  // An unnamed card record ("Card Customer") has no name to rank by.
  const cp: any[] = [L]
  const customers = await query<any>(
    `SELECT p.*,
            CASE WHEN p.tenant_id IS NULL AND p.first_name = 'Card' AND p.last_name = 'Customer' THEN 2
                 ELSE ${rankSql(words, { first: 'p.first_name', last: 'p.last_name' }, cp)} END AS rnk
       FROM (
       SELECT c.id, c.tenant_id, c.created_from,
              COALESCE(u.first_name, c.first_name) AS first_name, COALESCE(u.last_name, c.last_name) AS last_name,
              -- 10/2 (review): the account's own email and phone only for
              -- somebody who lives here now (recordContactSql).
              ${recordContactSql('c', 'u').email} AS email, ${recordContactSql('c', 'u').phone} AS phone,
              c.email AS own_email, c.phone AS own_phone,
              (SELECT k.last4 FROM pos_customer_cards k WHERE k.pos_customer_id = c.id ORDER BY k.last_seen_at DESC LIMIT 1) AS card_last4,
              (SELECT MAX(x.created_at) FROM pos_transactions x WHERE x.pos_customer_id = c.id) AS last_purchase
         FROM pos_customers c
         LEFT JOIN tenants tn ON tn.id = c.tenant_id
         LEFT JOIN users u ON u.id = tn.user_id
        WHERE c.landlord_id = $1 AND c.archived_at IS NULL
     ) p
     WHERE NOT (p.tenant_id IS NULL AND p.first_name = 'Card' AND p.last_name = 'Customer' AND p.own_email IS NULL AND p.own_phone IS NULL)
       AND ${wordFilter(words, { first: 'p.first_name', last: 'p.last_name', email: 'p.email', phone: 'p.phone' }, cp)}
     ORDER BY rnk, p.last_purchase DESC NULLS LAST, p.last_name, p.first_name
     LIMIT 40`, cp)

  type Ranked = PersonHit & { rank: number; lastPurchase: number }
  const byTenant = new Map<string, Ranked>()
  const hits: Ranked[] = []
  const ts = (v: any) => (v ? new Date(v).getTime() : 0)
  for (const r of residents) {
    const site = r.site ? `Site ${r.site}` : null
    const h: Ranked = {
      key: `t:${r.tenant_id}`, kind: 'resident', tenantId: r.tenant_id, customerId: null,
      name: fullName(r.first_name, r.last_name) || 'Resident',
      hint: [r.current ? 'resident' : r.adding ? 'invited' : 'former resident', site].filter(Boolean).join(' · '),
      firstName: r.first_name ?? '', lastName: r.last_name ?? '', email: r.email ?? null, phone: r.phone ?? null,
      rank: Number(r.rnk), lastPurchase: ts(r.last_purchase),
    }
    byTenant.set(r.tenant_id, h); hits.push(h)
  }
  for (const r of invited) {
    if (byTenant.has(r.tenant_id)) continue
    const h: Ranked = {
      key: `t:${r.tenant_id}`, kind: 'resident', tenantId: r.tenant_id, customerId: null,
      name: fullName(r.first_name, r.last_name) || 'Resident',
      hint: ['invited', r.site ? `Site ${r.site}` : null].filter(Boolean).join(' · '),
      firstName: r.first_name ?? '', lastName: r.last_name ?? '', email: r.email ?? null, phone: r.phone ?? null,
      rank: Number(r.rnk), lastPurchase: 0,
    }
    byTenant.set(r.tenant_id, h); hits.push(h)
  }
  for (const c of customers) {
    const mine = c.tenant_id ? byTenant.get(c.tenant_id) : undefined
    if (mine) {
      mine.customerId = c.id
      mine.lastPurchase = Math.max(mine.lastPurchase, ts(c.last_purchase))
      // decisions #10: somebody who no longer lives here shows what this
      // company's own record holds for them (recordContactSql) — never their
      // live account's.
      mine.email = mine.email ?? c.email ?? null
      mine.phone = mine.phone ?? c.phone ?? null
      continue
    }
    const d = digitsOf(c.phone)
    const placeholder = isCardCustomer(c.first_name, c.last_name)
    hits.push({
      key: `c:${c.id}`, kind: 'customer', tenantId: null, customerId: c.id,
      name: placeholder ? 'Unnamed customer' : (fullName(c.first_name, c.last_name) || 'Customer'),
      hint: d.length >= 4 ? `phone ••${d.slice(-4)}` : c.email ? String(c.email) : c.card_last4 ? `card ••${c.card_last4}` : null,
      firstName: placeholder ? '' : (c.first_name ?? ''), lastName: placeholder ? '' : (c.last_name ?? ''),
      email: c.email ?? null, phone: c.phone ?? null,
      rank: Number(c.rnk), lastPurchase: ts(c.last_purchase),
    })
  }

  // Each source arrived already in this order (rankSql); merged, the same order.
  hits.sort((a, b) => a.rank - b.rank || b.lastPurchase - a.lastPurchase || a.name.localeCompare(b.name))
  const own: PersonHit[] = hits.slice(0, OWN_LIMIT).map(({ rank: _r, lastPurchase: _lp, ...h }) => h)

  if (opts.allowElsewhere) {
    const words = elsewhereWords(typed)
    if (words.length) own.push(...await searchElsewhere({ landlordId: L, propertyId: P, userId: opts.userId, typed, words }))
  }
  return own
}

// ── Rate limits ──────────────────────────────────────────────────────────

const userKey = (req: Request) => (req as any).user?.userId ?? req.ip ?? 'anonymous'

/** The type-ahead: a search per keystroke pause, 120 a minute per person. */
export const peopleSearchLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Searching too quickly — wait a moment and type again.' },
})

/**
 * Searches that look outside this company: 40 per ten minutes per person,
 * shared by the register and the pay-link window (one limiter, one count).
 * Counted from normalizePeopleQuery + elsewhereWords — the very reading the
 * search runs on — so padding, invisible characters or odd spacing never make
 * an uncounted search. Past the limit the search still answers with this
 * company's own people; nobody from elsewhere until the window passes.
 * Picking someone already found is not a search and is not counted.
 */
export const CROSS_COMPANY_WINDOW_MS = 10 * 60_000
export const CROSS_COMPANY_MAX = 40
export const crossCompanyLimiter = rateLimit({
  windowMs: CROSS_COMPANY_WINDOW_MS,
  max: CROSS_COMPANY_MAX,
  keyGenerator: userKey,
  standardHeaders: false,
  legacyHeaders: false,
  skip: (req) => elsewhereWords(normalizePeopleQuery((req.query as any)?.q)).length === 0,
  handler: (req, _res, next) => { (req as any).crossCompanyLimited = true; next() },
})
