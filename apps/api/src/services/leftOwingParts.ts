/**
 * 11/5 (Nic) — ONE WALK-AWAY DEBT PER PERSON, ADDED UP FROM ITS PARTS.
 *
 *   "I don't like recording it per lease because... people have short-term
 *    stays as well. Or people, 'hey, my card wasn't working when I went to buy
 *    some propane, and I'm going to come back with a new card,' and they never
 *    do. That wasn't a lease or a stay. ...we need a way for it to only record
 *    once, but it needs to be able to be infused from different sources."
 *
 * This file is that way. Every source calls recordWalkAwayPart with the thing
 * somebody walked away from; this finds the person's ONE live record with that
 * landlord, writes a part for the thing, and the record's figure becomes the
 * sum of its live parts. Nothing else writes tenant_left_owing.amount.
 *
 * ── WHY THIS HAD TO EXIST ───────────────────────────────────────────────────
 *
 * Before tonight there were three writers and they did not agree:
 *   • leftOwingFreeze set the amount for a lease that ended;
 *   • leftOwingCollection's stay path opened a SECOND record keyed on the
 *     BOOKING, so a resident who walked away from a lease and also left a stay
 *     unpaid was two debts to the same landlord — and the next landlord
 *     screening them saw a pile instead of a person;
 *   • its carry-forward path set a third figure on the lease record.
 * Each overwrote `amount` outright, so where two of them met the last one to
 * run won and the other's money vanished.
 *
 * Parts fix that by construction. Two writers that mean the same money use the
 * same (kind, source_key) and overwrite one part; two writers that mean
 * different money use different keys and both are counted. Neither can lose
 * the other's dollars, and the record explains itself — a landlord asking why
 * it says $1,683 can be shown the lease, the stay and the propane.
 *
 * ── WHO THE PERSON IS ───────────────────────────────────────────────────────
 *
 * leftOwing.personKey, imported and not copied. Their account if they have one,
 * else their email, else their phone — the same function the matcher uses when
 * another landlord screens them, because a writer that disagreed with the
 * matcher about who somebody is would split one person into two debts again,
 * which is the exact thing this is here to stop.
 *
 * A walk-in guest with no account is the person this book exists to catch, so
 * an account is a bonus and never a requirement. Somebody with no account, no
 * email and no phone gets NOTHING written: a debt that can never be matched
 * flags nobody and sits forever, which is worse than no debt at all.
 *
 * ── A RECORD SOMEBODY IS COLLECTING AGAINST DOES NOT MOVE ───────────────────
 *
 * Once a collection arrangement has taken a dollar, the figure is frozen: the
 * 80% settlement and the 50/15/15 split are all computed from it, so changing
 * it would re-price an arrangement already running against a resident's bill.
 * So a part offered to a frozen record is declined and logged, exactly as the
 * lease path already declined to re-compute one. The money is not lost — it is
 * what carryForwardOnDeparture carries into a fresh record when the resident
 * leaves — but it does not quietly re-write a live arrangement.
 */
import type { PoolClient } from 'pg'
import { query as poolQuery } from '../db'
import { personKey } from './leftOwing'
import { logger } from '../lib/logger'
import type { LeftOwingPartKind } from '@gam/shared'

type Q = { query: PoolClient['query'] } | { query: typeof poolQuery }

const run = async <T>(q: Q, sql: string, params: unknown[]): Promise<T[]> => {
  const r: any = await (q as any).query(sql, params)
  return (Array.isArray(r) ? r : r.rows) as T[]
}

const money = (n: number): number => Math.round(n * 100) / 100

/**
 * Who walked away. Everything is optional because a walk-in guest may be a
 * name and a phone number and nothing else — see the header.
 */
export interface WalkAwayPerson {
  userId?: string | null
  /** Their name as it was taken down, for the landlord reading the record. */
  who?: string | null
  email?: string | null
  phone?: string | null
}

export interface WalkAwayPart {
  landlordId: string
  /** Where it happened, for the city the flag shows. Null when unknown. */
  propertyId?: string | null
  person: WalkAwayPerson
  kind: LeftOwingPartKind
  /** The thing itself: a lease id, a booking id, a ticket id, a pay-link id. */
  sourceKey: string
  /** What is unpaid on that thing, in dollars. Zero or less writes nothing. */
  amount: number
  leftOn?: string | null
  /** Plain words for whoever reads the record. Never shown to another landlord. */
  note?: string | null
}

export interface WalkAwayRecord {
  owingId: string
  /** The record's whole figure: every live part added up. */
  total: number
  /** What THIS part contributes to it. */
  amount: number
  who: string | null
  /** True when the record already existed and this part joined it. */
  joined: boolean
}

/** The identity this book is keyed on, or null when there is nothing to key on. */
export function walkAwayPersonKey(p: WalkAwayPerson): string | null {
  return personKey({ userId: p.userId, name: p.who, email: p.email, phone: p.phone })
}

/**
 * The record's figure, re-read from its live parts. The ONE place
 * tenant_left_owing.amount is written.
 *
 * Returns the new total, or null when the record is frozen (see the header) or
 * gone. A record whose parts have all been voided is SETTLED rather than set to
 * zero: the amount CHECK is `> 0`, and more to the point a zero-dollar debt
 * still flagging somebody is the worst failure this book has.
 */
export async function refreshWalkAwayTotal(
  q: Q, owingId: string, opts?: { settledReason?: string },
): Promise<number | null> {
  const cur = (await run<{ frozen: boolean }>(q, `
    SELECT (settled_at IS NOT NULL OR COALESCE(collected_amount, 0) > 0) AS frozen
      FROM tenant_left_owing WHERE id = $1`, [owingId]))[0]
  if (!cur || cur.frozen) return null

  const sum = Number((await run<{ total: string }>(q, `
    SELECT COALESCE(SUM(amount), 0)::text AS total
      FROM tenant_left_owing_parts
     WHERE owing_id = $1 AND voided_at IS NULL`, [owingId]))[0]?.total ?? 0)
  const total = money(sum)

  if (total <= 0) {
    await run(q, `
      UPDATE tenant_left_owing
         SET settled_at = NOW(), settled_amount = 0,
             settled_reason = $2, updated_at = NOW()
       WHERE id = $1 AND settled_at IS NULL AND COALESCE(collected_amount, 0) = 0`,
      [owingId, opts?.settledReason
        ?? 'Nothing is owed here any more — every part of this was paid or withdrawn'])
    return 0
  }

  await run(q, `
    UPDATE tenant_left_owing
       SET amount = $2, updated_at = NOW()
     WHERE id = $1 AND amount <> $2`, [owingId, total.toFixed(2)])
  return total
}

/**
 * Find the person's live record with this landlord, locked. Null when they have
 * none — which is the ordinary case the first time somebody walks away.
 *
 * ── A RECORD THAT SETTLED BECAUSE IT EMPTIED OUT IS RE-OPENED ───────────────
 *
 * Two different things settle a record and only one of them is a decision:
 *
 *   • its last part was withdrawn, so there was nothing left to owe. That is
 *     bookkeeping, and it reverses: a check-out undone, the balance settled,
 *     then undone again leaves the guest owing for that stay once more. It is
 *     recognised by collected_amount 0 and settled_amount 0 — what
 *     refreshWalkAwayTotal writes — with no live part on it.
 *   • somebody closed it: a later landlord collected it out, it was carried to
 *     the next landlord, a person at GAM settled it. Those carry a figure or a
 *     collection and are NEVER re-opened here.
 *
 * Re-opening the first kind rather than starting a second record keeps one
 * person's history in one place, and the change journal records the re-open.
 */
async function liveRecordFor(
  q: Q, landlordId: string, key: string,
): Promise<{ id: string; frozen: boolean } | null> {
  const r = (await run<{ id: string; frozen: boolean }>(q, `
    SELECT id, (COALESCE(collected_amount, 0) > 0) AS frozen
      FROM tenant_left_owing
     WHERE landlord_id = $1 AND person_key = $2 AND settled_at IS NULL
     ORDER BY created_at
     LIMIT 1
     FOR UPDATE`, [landlordId, key]))[0]
  if (r) return r

  const reopened = (await run<{ id: string }>(q, `
    UPDATE tenant_left_owing
       SET settled_at = NULL, settled_amount = NULL, settled_reason = NULL,
           updated_at = NOW()
     WHERE id = (SELECT o.id FROM tenant_left_owing o
                  WHERE o.landlord_id = $1 AND o.person_key = $2
                    AND o.settled_at IS NOT NULL
                    AND COALESCE(o.collected_amount, 0) = 0
                    AND o.settled_amount = 0
                    AND NOT EXISTS (SELECT 1 FROM tenant_left_owing_parts p
                                     WHERE p.owing_id = o.id AND p.voided_at IS NULL)
                  ORDER BY o.updated_at DESC
                  LIMIT 1)
    RETURNING id`, [landlordId, key]))[0]
  return reopened ? { id: reopened.id, frozen: false } : null
}

/**
 * RECORD ONE THING SOMEBODY WALKED AWAY FROM.
 *
 * Idempotent per (person, kind, thing): running it again restates that part
 * rather than adding a second one, and a part that was withdrawn and is owed
 * again comes back. So a check-out undone and redone, or a nightly sweep that
 * re-reads a lease, cannot inflate anybody's debt.
 *
 * Returns null — doing nothing — when there is nothing owed, nobody to key it
 * on, or the record is frozen.
 */
export async function recordWalkAwayPart(
  q: Q, part: WalkAwayPart,
): Promise<WalkAwayRecord | null> {
  const amount = money(part.amount)
  if (amount <= 0) return null

  const key = walkAwayPersonKey(part.person)
  if (!key) {
    logger.warn({ landlordId: part.landlordId, kind: part.kind, sourceKey: part.sourceKey },
      '[left-owing] nothing to key this debt on — no account, no email, no phone, so it is not recorded')
    return null
  }

  const who = part.person.who?.trim() || null
  const email = part.person.email?.trim() || null
  const phone = part.person.phone?.trim() || null

  const existing = await liveRecordFor(q, part.landlordId, key)
  if (existing?.frozen) {
    logger.warn({ owingId: existing.id, kind: part.kind, sourceKey: part.sourceKey, amount },
      '[left-owing] a collection is already running against this debt, so its figure is frozen — '
      + 'this part is not added; it carries forward when the resident leaves')
    return null
  }

  let owingId = existing?.id ?? null
  if (owingId) {
    // Fill in anything the record did not know. COALESCE in this direction so a
    // stay that carries a phone number completes a lease record that had none,
    // and never the other way round — a later source with a blank field must
    // not erase a contact point another landlord would be matched on.
    await run(q, `
      UPDATE tenant_left_owing
         SET who         = COALESCE(who, $2),
             email       = COALESCE(email, $3),
             phone       = COALESCE(phone, $4),
             user_id     = COALESCE(user_id, $5),
             property_id = COALESCE(property_id, $6),
             left_on     = COALESCE(left_on, $7::date),
             updated_at  = NOW()
       WHERE id = $1`,
      [owingId, who, email, phone, part.person.userId ?? null,
       part.propertyId ?? null, part.leftOn ?? null])
  } else {
    // A fresh record. source_kind/source_key are PROVENANCE only — what opened
    // it — and the thing's own id keys them, so somebody who settles one debt
    // and later walks away from something else gets a new record rather than
    // colliding with the settled one under the legacy unique.
    const parentKind = part.kind === 'carried' ? 'lease' : part.kind
    const made = await run<{ id: string }>(q, `
      INSERT INTO tenant_left_owing
        (landlord_id, property_id, user_id, email, who, phone,
         amount, source_kind, source_key, person_key, left_on)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date)
      ON CONFLICT (landlord_id, source_kind, source_key) DO UPDATE
         SET person_key = COALESCE(tenant_left_owing.person_key, EXCLUDED.person_key),
             updated_at = NOW()
      RETURNING id`,
      [part.landlordId, part.propertyId ?? null, part.person.userId ?? null,
       email, who, phone, amount.toFixed(2), parentKind, part.sourceKey, key,
       part.leftOn ?? null])
    owingId = made[0]?.id ?? null
    if (!owingId) return null
    // THE ON CONFLICT CAUGHT A RECORD THAT ALREADY EXISTS FOR THIS THING, and
    // the person lookup above did not find it. Two ways that happens, and
    // neither is ours to write on:
    //   • it is SETTLED — somebody decided this debt was done, and re-opening
    //     it is not a writer's call;
    //   • it belongs to SOMEBODY ELSE — two people on one lease, where the
    //     record was opened in the other one's name. Writing a part here would
    //     put this person's money on their co-tenant's debt.
    const got = (await run<{ settled: boolean; mine: boolean }>(q, `
      SELECT (settled_at IS NOT NULL) AS settled,
             (person_key IS NOT DISTINCT FROM $2) AS mine
        FROM tenant_left_owing WHERE id = $1`, [owingId, key]))[0]
    if (!got || got.settled || !got.mine) {
      logger.warn({ owingId, kind: part.kind, sourceKey: part.sourceKey,
                    settled: got?.settled, mine: got?.mine },
        '[left-owing] a debt already exists against this thing and it is not this '
        + 'person\'s open one — nothing written')
      return null
    }
  }

  await run(q, `
    INSERT INTO tenant_left_owing_parts
      (owing_id, kind, source_key, amount, left_on, note)
    VALUES ($1, $2, $3, $4, $5::date, $6)
    ON CONFLICT (owing_id, kind, source_key) DO UPDATE
       SET amount      = EXCLUDED.amount,
           left_on     = COALESCE(EXCLUDED.left_on, tenant_left_owing_parts.left_on),
           note        = COALESCE(EXCLUDED.note, tenant_left_owing_parts.note),
           -- Owed again after being withdrawn: the part comes back rather than
           -- a second one being written beside it.
           voided_at   = NULL,
           void_reason = NULL,
           updated_at  = NOW()`,
    [owingId, part.kind, part.sourceKey, amount.toFixed(2),
     part.leftOn ?? null, part.note ?? null])

  const total = await refreshWalkAwayTotal(q, owingId)
  if (total == null) return null
  return { owingId, total, amount, who, joined: existing != null }
}

/**
 * WITHDRAW ONE PART — it turned out not to be owed, or it was paid.
 *
 * The part is voided and never deleted, so the change journal still explains
 * why the figure moved ([[gam-data-retention-keep-everything]]). When it was
 * the last live part the record settles; when it was not, the record stands at
 * what the rest of it comes to — a lease paid off after somebody left does not
 * clear the propane they never came back for.
 *
 * Returns the record's new total, 0 when it settled, or null when there was
 * nothing matching to withdraw.
 */
export async function dropWalkAwayPart(
  q: Q,
  opts: {
    landlordId: string
    /**
     * Optional, and only a narrowing. A part is keyed on the THING — a lease
     * id, a booking id, a ticket id — so the thing alone finds it. Callers who
     * already know whose it is pass the person and get that checked too;
     * callers who are simply settling a ticket (the register, a paid pay link)
     * do not have to resolve a person to let go of its part.
     */
    person?: WalkAwayPerson
    kind: LeftOwingPartKind
    sourceKey: string
    reason: string
  },
): Promise<number | null> {
  const key = opts.person ? walkAwayPersonKey(opts.person) : null
  if (opts.person && !key) return null

  const found = (await run<{ owing_id: string }>(q, `
    UPDATE tenant_left_owing_parts p
       SET voided_at = NOW(), void_reason = $4, updated_at = NOW()
     WHERE p.kind = $2 AND p.source_key = $3 AND p.voided_at IS NULL
       AND p.owing_id IN (SELECT o.id FROM tenant_left_owing o
                           WHERE o.landlord_id = $1
                             AND ($5::text IS NULL OR o.person_key = $5)
                             AND o.settled_at IS NULL
                             AND COALESCE(o.collected_amount, 0) = 0)
    RETURNING p.owing_id`,
    [opts.landlordId, opts.kind, opts.sourceKey, opts.reason, key]))[0]
  if (!found) return null

  return await refreshWalkAwayTotal(q, found.owing_id, { settledReason: opts.reason })
}

/** What a record is made of, newest first — for a screen or a script. */
export async function walkAwayParts(
  q: Q, owingId: string,
): Promise<{ kind: string; sourceKey: string; amount: number; leftOn: string | null
            note: string | null; voidedAt: string | null }[]> {
  const rows = await run<{
    kind: string; source_key: string; amount: string; left_on: string | null
    note: string | null; voided_at: string | null
  }>(q, `
    SELECT kind, source_key, amount::text AS amount,
           to_char(left_on, 'YYYY-MM-DD') AS left_on, note, voided_at::text
      FROM tenant_left_owing_parts
     WHERE owing_id = $1
     ORDER BY voided_at IS NOT NULL, created_at DESC`, [owingId])
  return rows.map(r => ({
    kind: r.kind, sourceKey: r.source_key, amount: Number(r.amount),
    leftOn: r.left_on, note: r.note, voidedAt: r.voided_at,
  }))
}
