/**
 * 10/24 (Nic + Blue) — A REPLACEMENT TAKES OVER A SPOT.
 *
 * Country Acres, MH 28. Susie McCoy is walking away from the mobile home and
 * owes rent; the Bowmans' daughter is taking over the home on a new installment
 * contract and wants the spot from November 1. Blue's problem, in Nic's words:
 *
 *   "we need a system for having people sign a lease for a spot and securing
 *    the spot before the other person is released... he needs the other person
 *    to sign their lease first... if the other person never fully commits, he
 *    can't release the original person and then be stuck with nothing."
 *
 * And the hard constraint that rules out everything we had:
 *
 *   "Blue's not comfortable associating them together at all, even on
 *    paperwork, even if they're not really living together, just to keep
 *    records clean."
 *
 * ── WHY THIS IS NOT renewalSuccessor ────────────────────────────────────────
 *
 * That subsystem is for a new lease of the household ALREADY LIVING THERE. Two
 * things make it wrong here, and both are the point:
 *
 *   1. It links the two leases with leases.supersedes_lease_id. That is the
 *      association Blue refuses — one person's paperwork pointing at another's.
 *      Here NOTHING on either lease points at the other. The spot and the dates
 *      are the only connection, which is unavoidable and names nobody.
 *
 *   2. It fires on the LANDLORD's signature, because for a renewal the same
 *      household owes the new rent whether they sign or not (Nic, 10/2: "they
 *      always get charged the new rent, whether or not they sign it"). Here that
 *      is backwards. Blue signing alone would release Susie before the
 *      replacement has committed, which is the exact thing he is protecting
 *      against. Nic: "The replacement person needs to sign before it fires,
 *      right? That's the thing that it's gated on... landlord always signs
 *      first."
 *
 * So: the landlord signs first, as he always does — that is him saying this spot
 * turns over on that date. The REPLACEMENT'S signature is what fires it. Until
 * then nothing moves and the sitting tenant keeps being billed, which is the
 * safe default and the one Nic asked for: "if Blue drafts it and then she
 * doesn't sign, then the old person could still be billed."
 *
 * ── WHY IT FIRES AT SIGNATURE AND NOT ON THE START DATE ─────────────────────
 *
 * renewalSuccessor deliberately waits for the start date, so nothing says the
 * old lease is ending while the new one is still pending. That is right when the
 * same household is billed either way. It is wrong here: the rent run generates
 * a month's invoices DAYS before they are due, so a sitting lease with no end
 * date on it would bill the departing tenant for a month the replacement owns.
 * Nic: "He just has to do that before the billing happens" — that race on a
 * human deadline is the thing this removes.
 *
 * ── WHAT THE DEPARTING TENANT KEEPS ─────────────────────────────────────────
 *
 * Nic: "her outstanding balance of what's unpaid at the time that we're going to
 * end the lease needs to be linked to her name so that we can, so that she can
 * make good on the amount when she says she's going to."
 *
 * So ending the lease never forgives anything. What is payable on it at that
 * moment is frozen against the person by name onto tenant_left_owing — the same
 * book the import writes, frozen at the figure, never recomputed afterwards
 * (memory: left-owing amount is frozen). The lease ends; the debt does not.
 *
 * ── IT ONLY EVER HAPPENS WHEN THE LANDLORD SAID SO ─────────────────────────
 *
 * 10/24 (Nic), on the first version of this, which found the sitting lease by
 * inference — an active lease on the space, a different household, covering the
 * new start:
 *
 *   "we got to gate it, make sure it's invite only, so the landlord has to
 *    proactively make a new lease for that spot when he has knowledge that the
 *    other person's going to be leaving... somebody else comes in, tries to book
 *    a reservation for 30 or more nights, and it generates a draft lease
 *    automatically... is that going to automatically try to boot a person
 *    there?"
 *
 * Inference cannot tell a handover from an overlap, so it would have. (Not by
 * that route — findStayConflict refuses a booking over an active lease, so a
 * reservation cannot reach an occupied site — but a lease drafted directly
 * could, and "the thing that saves us is a check somewhere else" is not a
 * design.)
 *
 * So the new lease NAMES the lease it replaces (leases.replaces_lease_id, set
 * from the document the landlord drafted). Nothing else hands anything over:
 * a booking draft, an application draft and an ordinary new lease all leave it
 * NULL, and NULL ends nobody. Guessing is gone.
 *
 * ── WHAT IS REFUSED ────────────────────────────────────────────────────────
 *
 * One SITTING lease plus one INCOMING lease is the normal case and is exactly
 * what this is for — Susie's runs years out and the replacement's starts
 * November 1, so they overlap on paper and that is not an error. What cannot be
 * resolved by any rule is TWO REPLACEMENTS of the same sitting lease: two
 * people both signed to take one space. The database refuses the second
 * outright (ux_leases_one_replacement_per_lease), because picking between two
 * people who both signed is not a thing software should do.
 *
 * A handover is also refused where it would reach back into a month already
 * invoiced to the sitting tenant (Nic: "we don't want it to reach back into a
 * month that's already invoiced"). Ending the lease before an invoice that is
 * already out would orphan it.
 *
 * ── WHAT IS NOT GUARDED, ON PURPOSE ────────────────────────────────────────
 *
 * GAM does not ask whether the departing tenant agreed to go. A landlord
 * drafting and signing a replacement lease for a spot is the landlord saying the
 * spot turns over, and GAM accommodates rather than refereeing (memory: never
 * gate on legality). What GAM does instead is make it impossible to do quietly:
 * the departing tenant is told their lease now ends on that date, so the person
 * it affects is the one who finds out first.
 *
 * ── AND IF TWO LEASES EVER DO OVERLAP ANYWAY ───────────────────────────────
 *
 * Billing is left exactly as it is: both get billed. Nic, choosing this over
 * billing nobody: "not every landlord is going to be on the software every day
 * or looking at their email... if both people get billed, the one that wasn't
 * supposed to get billed is going to be calling and texting the landlord to try
 * to resolve that. That's going to prompt him to get on and make a fix." A
 * silent hole has nobody who notices; a wrong bill has somebody who chases it
 * the same day. This module exists so it never gets that far.
 */
import type { PoolClient } from 'pg'
import { query as poolQuery } from '../db'
import { payableRowSql, requiredRowSql } from './moneyPredicates'
import { logger } from '../lib/logger'

type Q = { query: PoolClient['query'] } | { query: typeof poolQuery }

const run = async <T>(q: Q, sql: string, params: unknown[]): Promise<T[]> => {
  const r: any = await (q as any).query(sql, params)
  return (Array.isArray(r) ? r : r.rows) as T[]
}

export interface SittingLease {
  id: string
  landlordId: string
  unitId: string
  propertyId: string
  startDate: string
  endDate: string | null
  /** 'YYYY-MM-DD' the day before the replacement starts — where this lease now ends. */
  endsOn: string
}

/** The day before an ISO day, as 'YYYY-MM-DD'. */
export const dayBefore = (iso: string): string => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  t.setUTCDate(t.getUTCDate() - 1)
  return t.toISOString().slice(0, 10)
}

/**
 * THE LEASE THE LANDLORD NAMED, checked for the three things that would make
 * replacing it wrong. Returns null rather than throwing on any of them: a
 * replacement that cannot be made must never roll back a signature, and the
 * caller raises it for a human instead.
 *
 *   - it has to be on the SAME SPACE. A document naming a lease on another site
 *     would end a tenancy nowhere near the one being filled.
 *   - it has to still be RUNNING on the day the new one starts. Replacing a
 *     lease that already ended is a no-op, and replacing one that has not
 *     started is not a handover.
 *   - it must not be the SAME HOUSEHOLD. A household signing its own new lease
 *     is a renewal — services/renewalSuccessor — and routing it through here
 *     would end their tenancy and start a second one, which reads as a move-out
 *     to everything downstream.
 */
export async function namedSittingLease(
  q: Q, opts: { leaseId: string; unitId: string; startIso: string; newLeaseId: string },
): Promise<SittingLease | null> {
  const ends = dayBefore(opts.startIso)
  const rows = await run<any>(q, `
    SELECT l.id, l.landlord_id, l.unit_id, u.property_id,
           to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
           to_char(l.end_date,   'YYYY-MM-DD') AS end_date
      FROM leases l
      JOIN units u ON u.id = l.unit_id
     WHERE l.id = $1
       AND l.unit_id = $2
       AND l.id <> $3
       AND l.status = 'active'
       AND l.start_date <= $4::date
       AND (l.end_date IS NULL OR l.end_date >= $5::date)
       AND NOT EXISTS (
         SELECT 1 FROM lease_tenants a
           JOIN lease_tenants b ON b.tenant_id = a.tenant_id
          WHERE a.lease_id = l.id AND b.lease_id = $3
            AND a.status IN ('active','pending_add') AND b.status IN ('active','pending_add'))`,
    [opts.leaseId, opts.unitId, opts.newLeaseId, ends, opts.startIso])
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id, landlordId: r.landlord_id, unitId: r.unit_id, propertyId: r.property_id,
    startDate: r.start_date, endDate: r.end_date, endsOn: ends,
  }
}

/**
 * Which lease a landlord would be replacing if they drafted one for this space
 * starting on this day — what the drafting screen offers, so the landlord picks
 * a real tenancy rather than typing an id. Read-only; it hands nothing over.
 */
export async function sittingLeaseOnSpace(
  q: Q, opts: { unitId: string; startIso: string },
): Promise<SittingLease | null> {
  const ends = dayBefore(opts.startIso)
  const rows = await run<any>(q, `
    SELECT l.id, l.landlord_id, l.unit_id, u.property_id,
           to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
           to_char(l.end_date,   'YYYY-MM-DD') AS end_date
      FROM leases l
      JOIN units u ON u.id = l.unit_id
     WHERE l.unit_id = $1
       AND l.status = 'active'
       AND l.start_date <= $2::date
       AND (l.end_date IS NULL OR l.end_date >= $3::date)
     ORDER BY l.start_date DESC
     LIMIT 1`, [opts.unitId, ends, opts.startIso])
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id, landlordId: r.landlord_id, unitId: r.unit_id, propertyId: r.property_id,
    startDate: r.start_date, endDate: r.end_date, endsOn: ends,
  }
}

/**
 * A SECOND replacement already signed for this spot over the same days. This is
 * the one case no rule can settle, so the later signature is refused rather than
 * resolved — see the header.
 */
export async function otherIncomingLeaseOnSpot(
  q: Q, opts: { unitId: string; startIso: string; endIso: string | null; newLeaseId: string },
): Promise<{ leaseId: string; startDate: string } | null> {
  const rows = await run<any>(q, `
    SELECT l.id, to_char(l.start_date, 'YYYY-MM-DD') AS start_date
      FROM leases l
     WHERE l.unit_id = $1
       AND l.id <> $2
       AND l.status IN ('pending','active')
       AND l.signed_by_tenant
       AND l.signed_by_landlord
       -- INCOMING, not sitting: it starts on or after the day this one starts.
       -- A lease that was already running is the handover, not a rival.
       AND l.start_date >= $3::date
       -- And its days actually meet this one's.
       AND ($4::date IS NULL OR l.start_date <= $4::date)
     ORDER BY l.start_date
     LIMIT 1`,
    [opts.unitId, opts.newLeaseId, opts.startIso, opts.endIso])
  const r = rows[0]
  return r ? { leaseId: r.id, startDate: r.start_date } : null
}

export const TWO_REPLACEMENTS_FOR_ONE_SPOT =
  'Somebody else has already signed to take this space from that date. Two signed leases for the same days on '
  + 'one space is not something GAM can settle by itself — cancel whichever one is not going ahead, then send '
  + 'this one again.'

/**
 * A month already invoiced to the sitting tenant, at or past the handover.
 * Ending their lease before an invoice that is already out would orphan it.
 */
export async function billedPastTheHandover(
  q: Q, opts: { sittingLeaseId: string; startIso: string },
): Promise<{ dueDate: string } | null> {
  const rows = await run<any>(q, `
    SELECT to_char(i.due_date, 'YYYY-MM-DD') AS due_date
      FROM invoices i
     WHERE i.lease_id = $1
       AND i.due_date >= $2::date
       AND i.status <> 'void'
       AND i.voided_from_lease_id IS NULL
     ORDER BY i.due_date
     LIMIT 1`, [opts.sittingLeaseId, opts.startIso])
  const r = rows[0]
  return r ? { dueDate: r.due_date } : null
}

export const HANDOVER_REACHES_A_BILLED_MONTH = (dueDate: string): string =>
  `The space is already billed to the resident who has it, for ${dueDate}. A new lease starting before that `
  + 'would end their lease behind a bill that is already out. Start this lease after that month, or settle that '
  + 'invoice first.'

/** What the departing resident still owes on the lease being ended. */
export async function whatIsStillOwedOnLease(
  q: Q, leaseId: string,
): Promise<{ amount: number; rows: number }> {
  const rows = await run<{ amount: string; rows: string }>(q, `
    SELECT COALESCE(SUM(p.amount), 0)::text AS amount, COUNT(*)::text AS rows
      FROM payments p
     WHERE ${requiredRowSql('p', '$1')} AND ${payableRowSql('p')}`, [leaseId])
  return { amount: Number(rows[0]?.amount ?? 0), rows: Number(rows[0]?.rows ?? 0) }
}

/**
 * THE TWO REFUSALS, ASKED BEFORE A DOCUMENT IS EVER SENT.
 *
 * Returns the sentence to refuse with, or null when the space can be taken over.
 * Folded into esign's canTenantsSignNewLease so every door that drafts, sends or
 * signs a lease asks it, and so the landlord finds out while he is still holding
 * the thing rather than after somebody has signed it.
 *
 * A NO-OP FOR EVERY ORDINARY CASE. With nobody sitting on the space there is
 * nothing to take over and nothing to refuse — a new lease on an empty site, a
 * household renewing its own, a second lease the same landlord drafts for their
 * own tenant elsewhere, all answer null here.
 */
export async function whySpotCannotBeTakenOver(
  q: Q, opts: {
    unitId: string; startIso: string
    /** The lease this document says it replaces. NOTHING to check without one. */
    replacesLeaseId?: string | null
    exceptLeaseId?: string | null
  },
): Promise<string | null> {
  if (!opts.replacesLeaseId) return null
  const self = opts.exceptLeaseId ?? '00000000-0000-0000-0000-000000000000'

  // Somebody else already signed to replace this same tenancy. The database
  // refuses the second outright too (ux_leases_one_replacement_per_lease); this
  // is the same refusal said in words, before a document goes out.
  const rival = await run<{ id: string }>(q, `
    SELECT id FROM leases
     WHERE replaces_lease_id = $1 AND id <> $2
       AND status IN ('pending','active')
       AND signed_by_tenant AND signed_by_landlord
     LIMIT 1`, [opts.replacesLeaseId, self])
  if (rival.length) return TWO_REPLACEMENTS_FOR_ONE_SPOT

  const sitting = await namedSittingLease(q,
    { leaseId: opts.replacesLeaseId, unitId: opts.unitId, startIso: opts.startIso, newLeaseId: self })
  if (!sitting) return REPLACES_A_LEASE_THAT_DOES_NOT_FIT

  const billed = await billedPastTheHandover(q, { sittingLeaseId: sitting.id, startIso: opts.startIso })
  if (billed) return HANDOVER_REACHES_A_BILLED_MONTH(billed.dueDate)
  return null
}

export const REPLACES_A_LEASE_THAT_DOES_NOT_FIT =
  'The lease this one is set to replace is not a current tenancy on this space for those dates — it may have '
  + 'ended already, it may be on another space, or it may belong to the same household. Pick the resident '
  + 'being replaced again, then send it.'

/**
 * 10/24 (Nic) — WHAT THE DRAFTING SCREEN PUTS IN FRONT OF THE LANDLORD.
 *
 *   "maybe just have the window prompt them with a, hey, this lease there's a
 *    lease already in place for this unit. Do you want to replace this one? And
 *    have the new one start on this date and the old one terminate when the new
 *    one starts. And actually show the name of the person and the unit that is
 *    being replaced. That way, if the landlord accidentally clicked on the wrong
 *    unit, they have all that information right in front of them and they can
 *    say, oh, no, change unit... let's make it very prominent so there's no
 *    accidental screwing it up."
 *
 * So this answers, for a space and a start date: is somebody on it, WHO, and
 * what exactly happens to them if this goes ahead. Every figure the warning
 * shows comes from here rather than being assembled on the screen — the date
 * the sitting lease would end is the same `dayBefore` the handover itself uses,
 * so the landlord cannot be shown one date and have another happen.
 *
 * Read-only. Nothing is handed over by asking.
 */
export interface SpaceOccupant {
  leaseId: string
  /** The resident being replaced, by name — the thing that catches a wrong unit. */
  who: string
  spaceLabel: string
  startDate: string
  endDate: string | null
  /** Where their lease would end if this replacement goes ahead. */
  wouldEndOn: string
  /** What they still owe, which does not go away when the lease ends. */
  owed: number
  /** True when somebody has already been signed in to replace them. */
  alreadyBeingReplaced: boolean
}

export async function whoIsOnThisSpace(
  q: Q, opts: { unitId: string; startIso: string; landlordId: string },
): Promise<SpaceOccupant | null> {
  const sitting = await sittingLeaseOnSpace(q, { unitId: opts.unitId, startIso: opts.startIso })
  if (!sitting || sitting.landlordId !== opts.landlordId) return null
  const people = await run<{ who: string }>(q, `
    SELECT u.first_name || ' ' || u.last_name AS who
      FROM lease_tenants lt
      JOIN tenants t ON t.id = lt.tenant_id
      JOIN users u ON u.id = t.user_id
     WHERE lt.lease_id = $1 AND lt.status IN ('active','pending_add')
     ORDER BY (lt.role = 'primary') DESC`, [sitting.id])
  const label = await run<{ label: string }>(q, `
    SELECT COALESCE(NULLIF(display_label, ''), unit_number, 'this space') AS label
      FROM units WHERE id = $1`, [opts.unitId])
  const rival = await run<{ id: string }>(q, `
    SELECT id FROM leases
     WHERE replaces_lease_id = $1 AND status IN ('pending','active') LIMIT 1`, [sitting.id])
  const owed = await whatIsStillOwedOnLease(q, sitting.id)
  return {
    leaseId: sitting.id,
    who: people.map(p => p.who).filter(Boolean).join(' and ') || 'the current resident',
    spaceLabel: label[0]?.label ?? 'this space',
    startDate: sitting.startDate,
    endDate: sitting.endDate,
    wouldEndOn: sitting.endsOn,
    owed: owed.amount,
    alreadyBeingReplaced: rival.length > 0,
  }
}

export interface HandoverResult {
  sittingLeaseId: string
  endsOn: string
  /** Frozen against their name; 0 when they owed nothing. */
  owed: number
  leftOwingId: string | null
}

/**
 * THE WHOLE OPERATION, run the moment the replacement's signature lands.
 *
 * Returns null when there is nothing to take over (the ordinary case: a new
 * lease on an empty space), so the caller can treat it as a no-op.
 *
 * Throws when the handover cannot be made — a rival signed lease, or a month
 * already billed. Both are refusals the landlord has to act on, and both are
 * checked again before the document is ever sent, so reaching them here means
 * the world changed while it was out for signature.
 */
export async function replacementTookOverSpot(
  q: Q, newLeaseId: string,
): Promise<HandoverResult | null> {
  const nw = (await run<any>(q, `
    SELECT l.id, l.unit_id, l.landlord_id, l.replaces_lease_id,
           l.signed_by_tenant, l.signed_by_landlord,
           to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
           to_char(l.end_date,   'YYYY-MM-DD') AS end_date
      FROM leases l WHERE l.id = $1`, [newLeaseId]))[0]
  if (!nw?.start_date) return null
  // BOTH SIGNATURES, checked here and not only by the caller. Today the only
  // caller is the point where the tenant's signature lands, but "it is safe
  // because of where it is called from" is the kind of thing that stops being
  // true quietly. The landlord signs first and the replacement's signature is
  // what fires this (Nic: "The replacement person needs to sign before it fires
  // ... if the other person never fully commits, he can't release the original
  // person and then be stuck with nothing"), so an unsigned draft hands over
  // nothing no matter who asks.
  if (!nw.signed_by_tenant || !nw.signed_by_landlord) return null
  // THE GATE. No named lease, no handover — an ordinary new lease, a booking
  // draft and an application draft all land here and all leave without doing
  // anything. See the header.
  if (!nw.replaces_lease_id) return null

  const sitting = await namedSittingLease(q,
    { leaseId: nw.replaces_lease_id, unitId: nw.unit_id, startIso: nw.start_date, newLeaseId })
  if (!sitting) return null

  const billed = await billedPastTheHandover(q,
    { sittingLeaseId: sitting.id, startIso: nw.start_date })
  if (billed) throw new Error(HANDOVER_REACHES_A_BILLED_MONTH(billed.dueDate))

  // What they owe is read BEFORE the lease is ended, and frozen. Reading it
  // after would be reading a lease that no longer bills.
  const owed = await whatIsStillOwedOnLease(q, sitting.id)

  await run(q, `
    UPDATE leases
       SET end_date = $2::date, updated_at = NOW()
     WHERE id = $1`, [sitting.id, sitting.endsOn])

  let leftOwingId: string | null = null
  if (owed.amount > 0) {
    // Frozen at this figure against the person by name — the same book the
    // import writes. One row per lease (tenant_left_owing_source_uniq), so a
    // second pass cannot double it or move it.
    const who = await run<any>(q, `
      SELECT t.id AS tenant_id, u.id AS user_id, u.email, u.phone,
             u.first_name || ' ' || u.last_name AS who
        FROM lease_tenants lt
        JOIN tenants t ON t.id = lt.tenant_id
        JOIN users u ON u.id = t.user_id
       WHERE lt.lease_id = $1 AND lt.status IN ('active','pending_add')
       ORDER BY (lt.role = 'primary') DESC
       LIMIT 1`, [sitting.id])
    const p = who[0]
    if (p) {
      const ins = await run<{ id: string }>(q, `
        INSERT INTO tenant_left_owing
          (landlord_id, property_id, user_id, email, phone, who, amount, source_kind, source_key, left_on)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'lease', $8, $9::date)
        ON CONFLICT (landlord_id, source_kind, source_key) DO NOTHING
        RETURNING id`,
        [sitting.landlordId, sitting.propertyId, p.user_id, p.email, p.phone, p.who,
         owed.amount, sitting.id, sitting.endsOn])
      leftOwingId = ins[0]?.id ?? null
    }
  }

  logger.info({ sittingLeaseId: sitting.id, newLeaseId, endsOn: sitting.endsOn,
                owed: owed.amount, leftOwingId },
    '[spot-succession] a replacement signed, so the sitting lease ends the day before theirs starts')
  return { sittingLeaseId: sitting.id, endsOn: sitting.endsOn, owed: owed.amount, leftOwingId }
}
