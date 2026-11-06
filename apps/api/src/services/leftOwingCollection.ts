// 10/27 (Nic) — THE SECOND DOOR: COLLECTING A DEBT, NOT BUYING ONE.
//
//   "We don't phrase it as the landlord assuming that debt. We phrase it as the
//    landlord will be collecting this debt on behalf of the previous landlord.
//    It's not optional. If they allow them on the platform, that's it."
//
// And on what the landlord is actually clicking:
//
//   "There's no button they click to accept the sort of taking on the debt.
//    It's they're clicking that they accept that a payment arrangement is going
//    to be added to that tenant's portal. And there's no options around it."
//
// So nothing here offers a choice. `theWords` is what the landlord is shown,
// `openCollection` records that they were shown it, and the arrangement starts.
// A landlord who does not want to collect does not take the resident; there is
// no third option, and no function here provides one.
//
// WHAT THIS FILE DOES NOT DO, and why that is deliberate: it does not move
// money. The installments ride the resident's rent (rentRider), what is
// collected is netted from the collecting landlord's disbursement, and a
// remainder at move-out is withdrawn from their balance. Those are three
// separate money paths with their own locks and their own tests; this file is
// the ARRANGEMENT — what is owed, to whom, by what schedule, and where the rest
// goes when the resident moves on again.

import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { amountBand } from './leftOwing'
import { recordHeldItem, type HeldItemProperty } from './heldPayouts'
import { recordWalkAwayPart, dropWalkAwayPart } from './leftOwingParts'
import { PAID_TOWARD_SQL } from './bookingLeaseDraft'

/**
 * ── HOW LONG IT IS SPREAD OVER (Nic, 10/29) ─────────────────────────────────
 *
 *   "It rides the same way on a bill that the flex products do. The landlord
 *    cannot set the terms of the repayment portion. We take the 80% of the
 *    outstanding... and then we figure out, hey, they're on a month-to-month
 *    lease, we're going to divide that either over 6 months or 4 months."
 *
 * SIX or FOUR. Not twelve, and never the landlord's choice — the schedule is
 * GAM's, exactly as a Flex product's is. A year was my own invention from
 * 10/21 when he had not named a number; he has now.
 *
 * Six is the default because it is the gentler of the two beside rent. Four is
 * the fallback for a balance too small to make six payments worth billing —
 * $100 over six months is $16.67 a month, below the floor and not worth the
 * line on the bill. Below four it simply finishes sooner.
 */
export const LEFT_OWING_INSTALLMENT_MONTHS = [6, 4] as const
export const LEFT_OWING_MIN_INSTALLMENT = 25

/**
 * ── WHAT A LEFT-OWING DEBT SETTLES AT, AND WHO GETS WHAT (Nic, FINAL 10/29) ──
 *
 *   "20% wiped off the board. 20% to the new landlord. 50% to the old
 *    landlord. And 10% to GAM." ... then, minutes later: "let's do 15 and 15.
 *    We're providing the new landlord the tools to get the job done and the
 *    information and the coordination. They're the ones taking the risk of
 *    letting the new person in. I think that's worth even amounts."
 *
 * Shares of the ORIGINAL debt. A $1,000 balance settles at $800: $500 to the
 * landlord who was left without it, $150 to GAM for brokering it, $150 to the
 * landlord doing the collecting, and $200 nobody ever pays. The old landlord
 * takes the discount because, in his words, they "thought they were going to
 * get nothing anyway".
 *
 * Nothing is fronted: the resident is billed monthly and each collection is
 * divvied as it arrives (SHARE_OF_COLLECTED below), so a part-paid arrangement
 * leaves nobody holding the rest.
 */
export const LEFT_OWING_SETTLEMENT_PCT = 0.80
export const LEFT_OWING_SHARE_OF_ORIGINAL = { owed: 0.50, gam: 0.15, collector: 0.15 } as const

/**
 * The same three shares expressed against what is actually COLLECTED, which is
 * what every payment is divided by. 50/80 = 62.5%, 15/80 = 18.75% each. Kept
 * derived rather than written twice so a re-price cannot leave the two
 * disagreeing — and asserted in the tests.
 */
export const LEFT_OWING_SHARE_OF_COLLECTED = {
  owed:      LEFT_OWING_SHARE_OF_ORIGINAL.owed / LEFT_OWING_SETTLEMENT_PCT,
  gam:       LEFT_OWING_SHARE_OF_ORIGINAL.gam / LEFT_OWING_SETTLEMENT_PCT,
  collector: LEFT_OWING_SHARE_OF_ORIGINAL.collector / LEFT_OWING_SETTLEMENT_PCT,
} as const

/** What a debt of `original` settles at — the figure the resident is billed. */
export function settledAmount(original: number): number {
  return Math.round(Math.max(0, original) * LEFT_OWING_SETTLEMENT_PCT * 100) / 100
}

/**
 * ── HOW ONE COLLECTION DIVIDES, WITHOUT DRIFT (Nic, 10/29) ──────────────────
 *
 *   "The old landlord would get a total of $500 and one penny, and the new
 *    landlord gets $149.99. That is not right. I'm glad I checked. It's only
 *    off by a penny, but over a lot of payments and a lot of time, that adds
 *    up."
 *
 * He checked the ladder and he was right. Splitting each payment on its own
 * rounded each share UP or DOWN independently, and six roundings in the same
 * direction left the old landlord a penny over his 50% and the new landlord a
 * penny under his 15%. Every payment summed correctly; the TOTALS did not.
 *
 * So the split is measured against the RUNNING TOTAL, not the payment: each
 * party's share of this payment is their share of everything collected so far,
 * less what they have already had. The error can never accumulate because it
 * is recomputed from the total every time — after any number of payments each
 * party holds exactly `round(collected × their rate)`, and the drift is at
 * most a cent WITHIN a payment rather than a cent per payment.
 *
 * GAM still takes the remainder, so the three shares add back to the cent of
 * what was collected.
 *
 * `collectedBefore` is the arrangement's collected_amount BEFORE this payment.
 */
export function splitCollection(
  collectedBefore: number,
  payment: number,
): { owed: number; collector: number; gam: number } {
  const before = Math.round(Math.max(0, collectedBefore) * 100)
  const pay = Math.round(Math.max(0, payment) * 100)
  const after = before + pay
  const at = (total: number, rate: number) => Math.round(total * rate)
  const owed = at(after, LEFT_OWING_SHARE_OF_COLLECTED.owed)
    - at(before, LEFT_OWING_SHARE_OF_COLLECTED.owed)
  const collector = at(after, LEFT_OWING_SHARE_OF_COLLECTED.collector)
    - at(before, LEFT_OWING_SHARE_OF_COLLECTED.collector)
  return { owed: owed / 100, collector: collector / 100, gam: (pay - owed - collector) / 100 }
}

/** What rides each month, and over how many months. */
export function installmentFor(total: number): { amount: number; months: number } {
  const t = Math.round(Math.max(0, total) * 100) / 100
  if (t <= 0) return { amount: 0, months: 0 }
  // Six first, then four: the first term whose monthly payment clears the
  // floor. A balance too small for either is paid in as many whole
  // floor-sized months as it takes, which is fewer than four by definition.
  for (const months of LEFT_OWING_INSTALLMENT_MONTHS) {
    const even = Math.ceil((t / months) * 100) / 100
    if (even >= LEFT_OWING_MIN_INSTALLMENT) {
      // The last month is whatever is left, so the total is never overshot.
      return { amount: Math.min(even, t), months: Math.max(1, Math.ceil(t / even)) }
    }
  }
  const amount = Math.min(LEFT_OWING_MIN_INSTALLMENT, t)
  return { amount, months: Math.max(1, Math.ceil(t / amount)) }
}

/**
 * THE SENTENCE THE LANDLORD IS SHOWN. Stored with the acknowledgment, because
 * what they were told is the whole of what they agreed to and the wording will
 * change over time.
 *
 * It says what will happen, not what they may choose — there is no choice —
 * and it never names the other landlord or the exact figure, which is the same
 * rule the first door follows.
 */
export function theWords(total: number, months: number, installment: number): string {
  return (
    `Taking this resident on means GAM will collect what they still owe another `
    + `operator on the platform, ${amountBand(total)}, on that operator's behalf. `
    + `A payment arrangement of ${money(installment)} a month for ${months} `
    + `${months === 1 ? 'month' : 'months'} is added to the resident's portal and rides their rent. `
    + `You keep your share of everything collected. If they leave before it is paid off, `
    + `the remainder is settled from your disbursements and follows them to wherever they go next.`
  )
}

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export interface CollectionOffer {
  owingId:      string
  /** A band, never the figure — the same rule as the first door. */
  about:        string | null
  total:        number
  installment:  number
  months:       number
  words:        string
}

/**
 * WHAT A LANDLORD MUST BE TOLD before this resident can be taken on.
 *
 * Returns one offer per unsettled GAM debt the resident carries, or an empty
 * list when there is nothing to collect — which is the ordinary case and means
 * the onboarding proceeds with no extra step at all.
 *
 * Imported balances are never here: the database refuses an arrangement against
 * one, and a watch-list note is not a thing anybody collects.
 */
export async function collectionOffersFor(args: {
  tenantId:             string
  collectingLandlordId: string
}): Promise<CollectionOffer[]> {
  const rows = await query<{ id: string; amount: string }>(
    `SELECT o.id, o.amount::text
       FROM tenant_left_owing o
       JOIN tenants t ON t.id = $1
      WHERE o.settled_at IS NULL
        AND o.source_kind <> 'import'
        AND o.landlord_id <> $2
        AND o.user_id = t.user_id
        -- Already being collected by this landlord: no second arrangement.
        AND NOT EXISTS (
          SELECT 1 FROM left_owing_collections c
           WHERE c.owing_id = o.id AND c.collecting_landlord_id = $2)
      ORDER BY o.left_on NULLS LAST, o.id`,
    [args.tenantId, args.collectingLandlordId],
  )
  return rows.map((r) => {
    // 10/29: what is collected is the SETTLED amount, so that is the figure
    // offered, banded, and spread into installments — never the original.
    const total = settledAmount(Number(r.amount))
    const { amount, months } = installmentFor(total)
    return {
      owingId: r.id,
      about: amountBand(total),
      total,
      installment: amount,
      months,
      words: theWords(total, months, amount),
    }
  })
}

/**
 * Open the arrangement. Called when the landlord acknowledges — which is the
 * same moment they take the resident on, because the two are not separable.
 *
 * Idempotent on (owing_id, collecting_landlord_id): taking the same resident
 * on twice does not raise the debt twice.
 */
export async function openCollection(args: {
  owingId:              string
  tenantId:             string
  collectingLandlordId: string
  acknowledgedBy:       string
  client?:              PoolClient
}): Promise<{ id: string; installment: number; months: number } | null> {
  const run = async (c: PoolClient | null) => {
    const one = async <T>(sql: string, params: unknown[]): Promise<T | null> =>
      c ? ((await c.query(sql, params)).rows[0] ?? null) : queryOne<T>(sql, params as any[])

    const debt = await one<{ amount: string; landlord_id: string; source_kind: string; settled_at: string | null }>(
      `SELECT amount::text, landlord_id, source_kind, settled_at::text
         FROM tenant_left_owing WHERE id = $1`, [args.owingId])
    if (!debt) throw new AppError(404, 'That debt is not on file.')
    if (debt.settled_at) return null                        // paid since: nothing to collect
    if (debt.source_kind === 'import') {
      // The database refuses this too; saying it here gives a caller a sentence
      // rather than a constraint violation.
      throw new AppError(409,
        'That balance came from another platform. It is a note for landlords, not something GAM collects.')
    }
    if (debt.landlord_id === args.collectingLandlordId) return null   // their own debt

    // ── 10/29 (Nic): THE BALANCE IS THE DEBT'S, NOT THIS LANDLORD'S ────────
    //
    // The settlement is stamped on the debt the first time anybody takes the
    // resident on, and every landlord after that collects against what is
    // LEFT of it. Without this, a resident moving between parks — the case
    // this product exists for — hands each park an arrangement for the whole
    // settled amount and the debt gets collected over and over.
    const settled = settledAmount(Number(debt.amount))
    await one(
      `UPDATE tenant_left_owing
          SET settled_amount = COALESCE(settled_amount, $2::numeric), updated_at = NOW()
        WHERE id = $1`, [args.owingId, settled.toFixed(2)])
    const live = await one<{ settled_amount: string; collected_amount: string }>(
      `SELECT settled_amount::text, collected_amount::text
         FROM tenant_left_owing WHERE id = $1`, [args.owingId])
    // What is left for THIS landlord to collect.
    const total = Math.round(
      Math.max(0, Number(live!.settled_amount) - Number(live!.collected_amount)) * 100) / 100
    if (total <= 0) return null           // somebody else finished it
    const { amount, months } = installmentFor(total)
    const row = await one<{ id: string }>(
      `INSERT INTO left_owing_collections
         (owing_id, owed_landlord_id, collecting_landlord_id, tenant_id,
          total_amount, installment_amount, acknowledged_by, acknowledged_words)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (owing_id, collecting_landlord_id) DO NOTHING
       RETURNING id`,
      [args.owingId, debt.landlord_id, args.collectingLandlordId, args.tenantId,
       total.toFixed(2), amount.toFixed(2), args.acknowledgedBy, theWords(total, months, amount)])
    if (!row) {
      const existing = await one<{ id: string }>(
        `SELECT id FROM left_owing_collections
          WHERE owing_id = $1 AND collecting_landlord_id = $2`,
        [args.owingId, args.collectingLandlordId])
      return existing ? { id: existing.id, installment: amount, months } : null
    }
    return { id: row.id, installment: amount, months }
  }

  if (args.client) return run(args.client)
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const r = await run(c)
    await c.query('COMMIT')
    return r
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally { c.release() }
}

/**
 * THIS MONTH'S INSTALLMENT, as a bill line on the resident's invoice.
 *
 *   "The tenant will be charged in installments in addition to whatever rent
 *    that new landlord has."
 *
 * Written as an ordinary carried balance (type 'carried_balance',
 * entry_description 'BALANCE'), which is the shape every other carried balance
 * on the platform uses — so it inherits the invoice, the reminders and the
 * landlord's own late-fee rules, and FlexPay never fronts it (coverLineSql
 * excludes carried balances by name, and GAM should not advance one landlord's
 * money to settle another's old debt).
 *
 * Never bills past what is left: the last month is the remainder, not the full
 * installment. Idempotent per (arrangement, due date) — the invoice run is
 * replayable by design and a unique index backs that up.
 *
 * Returns what was billed, or 0 when there was nothing to bill.
 */
/**
 * ── WHAT THIS ARRANGEMENT MAY BE BILLED RIGHT NOW ──────────────────────────
 *
 * One answer, because there are now two places that collect: the monthly rent
 * rider for a resident on a lease, and the stay bill for a guest who never
 * signs one. If they disagreed, a guest who paid on a stay would be billed
 * again on a lease, or an installment would go uncollected because each side
 * assumed the other had it.
 *
 * Three limits, and the smallest wins:
 *
 *   1. ONE INSTALLMENT PER CALENDAR MONTH, wherever it is collected. The
 *      schedule Nic set is six months or four — "we're going to divide that
 *      either over 6 months or 4 months" — which has to mean six payments, not
 *      six payments plus one for every night they stay somewhere.
 *   2. What is left to BILL, which is not what is left to COLLECT: a line
 *      sitting unpaid on last month's invoice must not be billed again just
 *      because the money has not arrived.
 *   3. What is left on the DEBT at all. Another park may have been chipping at
 *      it since this arrangement opened, and billing past it would charge the
 *      resident for money somebody else already collected.
 */
export async function collectionDueNow(
  collectionId: string, c: Pick<PoolClient, 'query'>,
): Promise<number> {
  const row = (await c.query<{
    installment: string; total: string; billed: string; this_month: string; debt_left: string
  }>(
    `SELECT col.installment_amount::text AS installment,
            col.total_amount::text AS total,
            COALESCE((SELECT SUM(p.amount) FROM payments p
                       WHERE p.left_owing_collection_id = col.id
                         AND p.status IN ('pending','processing','settled')), 0)::text AS billed,
            COALESCE((SELECT SUM(p.amount) FROM payments p
                       WHERE p.left_owing_collection_id = col.id
                         AND p.status IN ('pending','processing','settled')
                         AND date_trunc('month', COALESCE(p.due_date, p.created_at))
                             = date_trunc('month', CURRENT_DATE)), 0)::text AS this_month,
            GREATEST(0, COALESCE(o.settled_amount, 0) - o.collected_amount)::text AS debt_left
       FROM left_owing_collections col
       JOIN tenant_left_owing o ON o.id = col.owing_id
      WHERE col.id = $1 AND col.status = 'active'`,
    [collectionId])).rows[0]
  if (!row) return 0
  const r2 = (n: number) => Math.round(n * 100) / 100
  const monthLeft = r2(Number(row.installment) - Number(row.this_month))
  const billLeft = r2(Number(row.total) - Number(row.billed))
  const debtLeft = r2(Number(row.debt_left))
  return Math.max(0, Math.min(monthLeft, billLeft, debtLeft))
}

export async function billInstallment(args: {
  collectionId: string
  invoiceId:    string | null
  unitId:       string
  leaseId:      string
  tenantId:     string
  landlordId:   string
  dueDate:      string
  client:       PoolClient
}): Promise<number> {
  const c = args.client
  const amount = await collectionDueNow(args.collectionId, c)
  if (amount <= 0) return 0

  const ins = await c.query<{ id: string }>(
    `INSERT INTO payments (
       invoice_id, unit_id, lease_id, tenant_id, landlord_id,
       type, amount, status, due_date, entry_description, notes,
       left_owing_collection_id
     ) VALUES ($1, $2, $3, $4, $5, 'carried_balance', $6, 'pending', $7, 'BALANCE', $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [args.invoiceId, args.unitId, args.leaseId, args.tenantId, args.landlordId,
     amount.toFixed(2), args.dueDate,
     // ── What the resident reads (Nic, 10/29) ─────────────────────────────
     //
     //   "It's going to be flagged as owed to your previous landlord. The
     //    tenant is not going to know that the new landlord is getting a cut
     //    of the deal. Or that GAM is. It's going to say, owed to your
     //    previous landlord, and that's that."
     //
     // So the line says who it is FOR and stops. The three-way split is
     // GAM's business and the landlords' — it never reaches this bill, and
     // nothing here hints that the money divides at all.
     //
     // "Your previous landlord" is a role, not a name, so the rule that the
     // other operator is never identified still holds.
     'Owed to your previous landlord',
     args.collectionId])
  return ins.rows[0] ? amount : 0
}

/**
 * Money actually collected, applied to the arrangement and to the debt behind
 * it. Called by whatever collected it (the rent rider today), never by a
 * screen.
 *
 * Settles the debt once it is whole — which is what makes the flag go away for
 * every other landlord, so it has to happen on the same transaction as the
 * money or a paid debt keeps flagging somebody.
 */
export async function applyCollected(args: {
  collectionId: string
  amount:       number
  /** The bill line that was paid — what makes the money move idempotent. */
  paymentId?:   string | null
  client:       PoolClient
}): Promise<{ collected: number; applied: number; complete: boolean }> {
  const c = args.client
  // Locked and read before it is written, because the money that moves is the
  // DELTA, not what the resident paid: a payment that overshoots what is left
  // owing credits only the remainder, and only the remainder is the other
  // landlord's. The excess is the resident's own money and stays theirs.
  const before = await c.query<{ collected_amount: string; total_amount: string; owing_id: string; collecting_landlord_id: string }>(
    `SELECT collected_amount::text, total_amount::text, owing_id, collecting_landlord_id
       FROM left_owing_collections
      WHERE id = $1 AND status = 'active'
      FOR UPDATE`,
    [args.collectionId])
  const was = before.rows[0]
  if (!was) return { collected: 0, applied: 0, complete: false }

  const paid    = Math.max(0, Math.round(args.amount * 100) / 100)
  const total   = Number(was.total_amount)
  const already = Number(was.collected_amount)
  const applied = Math.round(Math.min(paid, Math.max(0, total - already)) * 100) / 100

  const upd = await c.query<{ collected_amount: string; total_amount: string; owing_id: string }>(
    `UPDATE left_owing_collections
        SET collected_amount = LEAST(collected_amount + $2::numeric, total_amount),
            status = CASE WHEN collected_amount + $2::numeric >= total_amount
                          THEN 'complete' ELSE status END,
            updated_at = NOW()
      WHERE id = $1 AND status = 'active'
      RETURNING collected_amount::text, total_amount::text, owing_id`,
    [args.collectionId, paid.toFixed(2)])
  const row = upd.rows[0]
  if (!row) return { collected: 0, applied: 0, complete: false }

  // The money leaves the landlord who collected it and divides three ways, in
  // the same transaction as the credit. A credit without the movement would
  // show a debt coming down while the money sat with the wrong landlord.
  if (applied > 0 && args.paymentId) {
    await divideCollection({
      client:          c,
      owingId:         row.owing_id,
      collectingId:    was.collecting_landlord_id,
      amount:          applied,
      collectedBefore: already,
      sourceKey:       args.paymentId,
      from:         { paymentId: args.paymentId },
      why:          'Collected for another operator — not your income',
    })
  }

  // 10/29: the DEBT's running total rises with this arrangement's, because it
  // is what every other landlord bills against and what decides when the whole
  // thing is finished. Capped by the CHECK, so a race cannot push it past the
  // settlement.
  if (applied > 0) {
    await c.query(
      `UPDATE tenant_left_owing
          SET collected_amount = LEAST(collected_amount + $2::numeric,
                                       COALESCE(settled_amount, collected_amount + $2::numeric)),
              updated_at = NOW()
        WHERE id = $1`,
      [row.owing_id, applied.toFixed(2)])
  }

  // Finished when the DEBT is, not when this one landlord's schedule is: a
  // resident who paid half at one park and half at the next owes nobody
  // anything, and neither arrangement reached its own total alone.
  const debtNow = await c.query<{ done: boolean }>(
    `SELECT (settled_amount IS NOT NULL AND collected_amount >= settled_amount) AS done
       FROM tenant_left_owing WHERE id = $1`, [row.owing_id])
  const complete = debtNow.rows[0]?.done === true
  if (complete) {
    // The debt is settled, so the flag stops. Same transaction as the money:
    // a debt that is paid and still flagging is the worst failure this has.
    await c.query(
      `UPDATE tenant_left_owing
          SET settled_at = NOW(), settled_reason = 'collected_by_later_landlord', updated_at = NOW()
        WHERE id = $1 AND settled_at IS NULL`,
      [row.owing_id])
  }
  return { collected: Number(row.collected_amount), applied, complete }
}

/**
 * ── A STAY ENDS WITH MONEY STILL OWED (Nic, 10/29) ──────────────────────────
 *
 *   "The entire point of this was because of semi-short-term RV stays where
 *    people bounce around from place to place every month. If they leave
 *    without paying their last electric bill and do the same thing next month
 *    at another place and the same thing a third month at a third place,
 *    nothing..."
 *
 * Nothing was the right word. The carry-forward that records a departing
 * resident's balance has exactly one trigger — finalizing a deposit return at
 * a LEASE move-out. A guest who stays three weeks and drives off owing left no
 * trace at all: no debt raised, so no flag at the next park, so nothing for
 * any of this to collect. The collection machinery was complete and had
 * nothing to collect, for precisely the resident it was built for.
 *
 * THE PERSON IS ALWAYS THERE. A nightly or weekly guest has no `tenants` row —
 * which is what I first mistook for having no record of them — but every
 * booking carries their name, and nearly all carry a phone or an email. That
 * is exactly what tenant_left_owing holds and what leftOwing matches another
 * landlord's arrival against (account, then email, then phone). So the debt is
 * raised against the GUEST, and a tenant row is a bonus rather than a
 * requirement.
 *
 * Idempotent per (landlord, 'stay', booking): a re-run, or a check-out undone
 * and redone, restates the amount rather than raising a second debt. A stay
 * that was paid raises nothing and clears any debt a previous run left.
 */
export async function stayDebtOnCheckOut(args: {
  client:    PoolClient
  bookingId: string
}): Promise<{ owingId: string; amount: number } | null> {
  const c = args.client
  const b = await c.query<{
    landlord_id: string; property_id: string; unpaid: string
    who: string | null; email: string | null; phone: string | null
    user_id: string | null; left_on: string
  }>(
    // PAID_TOWARD_SQL is the one definition of what a reservation has been
    // paid (services/bookingLeaseDraft) — the full total once the balance is
    // settled, the deposit once that is, and nothing before either. Anything
    // the stay is worth beyond that is what they left owing.
    `SELECT b.landlord_id, u.property_id,
            GREATEST(COALESCE(b.total_amount, 0) - COALESCE(${PAID_TOWARD_SQL}, 0), 0)::text AS unpaid,
            NULLIF(btrim(COALESCE(b.guest_name, '')), '')  AS who,
            NULLIF(btrim(COALESCE(b.guest_email, '')), '') AS email,
            NULLIF(btrim(COALESCE(b.guest_phone, '')), '') AS phone,
            (SELECT t.user_id FROM tenants t WHERE t.id = b.tenant_id) AS user_id,
            to_char(COALESCE(b.check_out, CURRENT_DATE), 'YYYY-MM-DD') AS left_on
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
      WHERE b.id = $1`,
    [args.bookingId])
  const row = b.rows[0]
  if (!row) return null

  const unpaid = Math.round(Number(row.unpaid) * 100) / 100

  // ── 11/5 (Nic): THE STAY IS A PART OF THEIR ONE DEBT, NOT A DEBT OF ITS OWN
  //
  //   "I don't like recording it per lease because... people have short-term
  //    stays as well. ...we need a way for it to only record once, but it needs
  //    to be able to be infused from different sources."
  //
  // This used to open its own record keyed on the BOOKING, so a resident who
  // walked away from a lease AND left a stay unpaid was two debts to the same
  // landlord and the next landlord screening them saw a pile instead of a
  // person. Now it writes one PART and services/leftOwingParts puts it on the
  // person's single live record — matching them the same way the flag read
  // does, so a guest with no account lands on their own record and a resident
  // with one lands on theirs.
  const person = {
    userId: row.user_id, who: row.who, email: row.email, phone: row.phone,
  }

  // Paid in full — and if an earlier run raised a debt for this stay (a
  // check-out undone, then the balance settled), it is no longer true. Only the
  // STAY's part is withdrawn: paying off a stay does not pay off a lease or a
  // counter tab that is on the same record.
  if (unpaid <= 0) {
    await dropWalkAwayPart(c, {
      landlordId: row.landlord_id, person, kind: 'stay', sourceKey: args.bookingId,
      reason: 'The stay was paid after all — nothing is owed on it',
    })
    return null
  }

  // Nobody to attach it to. A booking with no name at all cannot be matched to
  // a person at the next park, and a debt that can never be matched is worse
  // than no debt: it flags nobody and sits forever. recordWalkAwayPart declines
  // it for the same reason; this is only here so the reason stays readable.
  if (!row.who && !row.email && !row.phone) return null

  const rec = await recordWalkAwayPart(c, {
    landlordId: row.landlord_id,
    propertyId: row.property_id,
    person,
    kind: 'stay',
    sourceKey: args.bookingId,
    amount: unpaid,
    leftOn: row.left_on,
    note: 'A stay that was never paid off',
  })
  if (!rec) return null
  // The STAY's figure, which is what the desk's own event line says they
  // checked out owing — not the record's total, which may carry more of theirs.
  return { owingId: rec.owingId, amount: rec.amount }
}

/**
 * ── THE RESIDENT LEAVES BEFORE IT IS PAID OFF ───────────────────────────────
 *
 *   "if the full amount is not collected by the time the tenant leaves the
 *    second landlord, then the second landlord pays... The first landlord will
 *    be made whole, and the second landlord's owed amount will be calculated
 *    based on that first landlord's balance that was passed on, plus any
 *    outstanding from what was accrued with that second landlord, and that will
 *    show to a third landlord."
 *
 * So three things happen at once, and either all of them do or none:
 *   1. the first landlord's debt is SETTLED — they are whole, whoever pays;
 *   2. the remainder is owed by the collecting landlord (their disbursement
 *      settles it — that is the money path, not this function);
 *   3. that remainder, plus anything the resident ran up with the collecting
 *      landlord, becomes a NEW debt in the collecting landlord's name, which is
 *      what a third landlord will see.
 *
 * Returns the new debt's id, or null when there was nothing left to carry.
 */
export async function carryForwardOnDeparture(args: {
  tenantId:  string
  /** The landlord the resident is leaving. */
  landlordId: string
  /** Anything they ran up with THIS landlord, already computed by the caller. */
  ownBalance: number
  /**
   * 11/5 — THE TENANCY the own balance is owed on. It is the key the lease's
   * part is written under, and services/leftOwingFreeze writes its part under
   * the same one, so the two restate ONE part instead of counting the same
   * unpaid rent twice. Without it the own balance would be the record's second
   * helping of money it already carries.
   */
  leaseId:    string
  propertyId: string | null
  client:     PoolClient
}): Promise<string | null> {
  const c = args.client
  const open = await c.query<{ id: string; owing_id: string; total_amount: string; collected_amount: string }>(
    `SELECT id, owing_id, total_amount::text, collected_amount::text
       FROM left_owing_collections
      WHERE tenant_id = $1 AND collecting_landlord_id = $2 AND status = 'active'
      FOR UPDATE`,
    [args.tenantId, args.landlordId])

  // ── 10/29 (Nic): WHAT CARRIES IS WHAT THE LANDLORD ACTUALLY PAID OUT ──────
  //
  //   "that $187.50 that the new landlord fronts the old landlord goes onto
  //    the tenant's left owing bill, so they would owe that plus any unpaid
  //    rent from the second landlord, had they showed up to a third landlord."
  //
  // Not the whole uncollected arrangement. On a $1,000 debt settled at $800
  // with $500 collected, $300 of the arrangement is outstanding — but the
  // collecting landlord only pays out $187.50 of it, the old landlord's share.
  // The other $112.50 was GAM's cut and their own on money nobody ever
  // collected, and neither of them is out a penny of it.
  //
  // Carrying the full $300 would have the resident owing a third landlord for
  // money the second one never spent, and would hand the second landlord a
  // profit on the resident leaving.
  const carried = open.rows.reduce(
    (s, r) => s + splitCollection(
      Number(r.collected_amount),
      Math.max(0, Number(r.total_amount) - Number(r.collected_amount))).owed, 0)
  const total = Math.round((carried + Math.max(0, args.ownBalance)) * 100) / 100
  if (total <= 0) {
    // Nothing outstanding anywhere: close the arrangements as complete.
    for (const r of open.rows) {
      await c.query(
        `UPDATE left_owing_collections SET status = 'complete', updated_at = NOW() WHERE id = $1`, [r.id])
    }
    return null
  }

  // ── 11/5 (Nic): THE NEW DEBT IS THE PERSON'S, AND IT IS MADE OF PARTS ─────
  //
  //   "we need a way for it to only record once, but it needs to be able to be
  //    infused from different sources."
  //
  // Two different pots of money arrive here and they used to be added together
  // into one figure this function set outright:
  //
  //   • what the resident ran up with THIS landlord — the same unpaid rent
  //     services/leftOwingFreeze books as the LEASE's part. Same money, so the
  //     same part, keyed on the lease. Before parts, whichever of the two ran
  //     second simply overwrote the other's total.
  //   • what this landlord PAID OUT of an earlier landlord's debt when the
  //     resident left part-way through. That is not the lease's rent and never
  //     was, so it is its own 'carried' part, one per arrangement.
  //
  // Each lands on the person's one live record, and the record is their parts
  // added up — which is what a third landlord sees: one debt, not a pile.
  const whoRow = (await c.query<{
    user_id: string; who: string | null; email: string | null; phone: string | null
  }>(
    `SELECT u.id AS user_id,
            NULLIF(btrim(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS who,
            NULLIF(btrim(COALESCE(u.email, '')), '') AS email,
            NULLIF(btrim(COALESCE(u.phone, '')), '') AS phone
       FROM tenants t JOIN users u ON u.id = t.user_id
      WHERE t.id = $1`, [args.tenantId])).rows[0]
  if (!whoRow) return null
  const person = {
    userId: whoRow.user_id, who: whoRow.who, email: whoRow.email, phone: whoRow.phone,
  }

  let newId: string | null = null
  const ownBalance = Math.round(Math.max(0, args.ownBalance) * 100) / 100
  if (ownBalance > 0) {
    const rec = await recordWalkAwayPart(c, {
      landlordId: args.landlordId, propertyId: args.propertyId, person,
      kind: 'lease', sourceKey: args.leaseId, amount: ownBalance,
      leftOn: null, note: 'Unpaid at move-out, after the deposit',
    })
    newId = rec?.owingId ?? newId
  }
  for (const r of open.rows) {
    const owedShare = splitCollection(
      Number(r.collected_amount),
      Math.max(0, Number(r.total_amount) - Number(r.collected_amount))).owed
    if (owedShare <= 0) continue
    const rec = await recordWalkAwayPart(c, {
      landlordId: args.landlordId, propertyId: args.propertyId, person,
      kind: 'carried', sourceKey: r.id, amount: owedShare,
      leftOn: null,
      note: 'Paid to the operator this debt was being collected for, when the resident left',
    })
    newId = rec?.owingId ?? newId
  }
  // Nothing written at all: the parts writer declined every one of them — no
  // way to identify the person, or a record of theirs that a collection is
  // already running against. Either way the three things below must not happen
  // on half a record, so none of them do.
  if (!newId) {
    logger.error({ tenant_id: args.tenantId, landlord_id: args.landlordId, total },
      '[left-owing] a departing resident\'s balance could not be carried forward — '
      + 'the debt was NOT raised and nothing was settled')
    return null
  }

  for (const r of open.rows) {
    // THE SECOND LANDLORD PAYS WHAT WAS NOT COLLECTED. His words: "if the full
    // amount is not collected by the time the tenant leaves the second
    // landlord, then the second landlord pays." It comes off their next
    // disbursement and goes to the landlord owed, so "made whole" is money and
    // not only a settled flag.
    //
    // 10/29, AND THIS IS A DECISION I MADE, NOT ONE HE GAVE: what the
    // collecting landlord covers is the OLD LANDLORD'S SHARE of what is left,
    // not the whole remainder. Under the settlement the landlord owed is
    // entitled to 50% of the original — on a $1,000 debt settled at $800 with
    // $300 collected, they have had $187.50 and are still owed $312.50, not
    // $500. Paying the whole $500 would hand them more than the settlement
    // promises and charge the collecting landlord for GAM's cut and their own.
    // GAM and the collecting landlord simply do not earn their shares on money
    // nobody collected.
    //
    // Flip it by sending `unpaid` instead of `unpaidOwedShare` if he wants the
    // collecting landlord to stand behind the full remainder.
    const unpaid = Math.round((Number(r.total_amount) - Number(r.collected_amount)) * 100) / 100
    const unpaidOwedShare = splitCollection(Number(r.collected_amount), unpaid).owed
    await moveToOwedLandlord({
      client:       c,
      owingId:      r.owing_id,
      collectingId: args.landlordId,
      amount:       unpaidOwedShare,
      sourceKey:    `departure:${r.id}`,
      from:         { propertyId: args.propertyId },
      why:          'What a resident left unpaid of a debt you collect for another operator',
    })
    // The first landlord is made whole however the money gets there, so their
    // debt is settled here and not when the disbursement clears — he was
    // explicit that they are not left waiting on the second landlord.
    await c.query(
      `UPDATE tenant_left_owing
          SET settled_at = NOW(), settled_reason = 'carried_to_next_landlord', updated_at = NOW()
        WHERE id = $1 AND settled_at IS NULL`, [r.owing_id])
    await c.query(
      `UPDATE left_owing_collections
          SET status = 'carried', carried_to_owing_id = $2, updated_at = NOW()
        WHERE id = $1`, [r.id, newId])
  }
  logger.info({ tenant_id: args.tenantId, landlord_id: args.landlordId, carried, own: args.ownBalance, total },
    '[left-owing] a balance followed the resident to their next landlord')
  return newId
}

/**
 * ── THE MONEY REACHES THE LANDLORD WHO IS OWED ──────────────────────────────
 *
 * The installment rides the COLLECTING landlord's invoice, because that is the
 * invoice the resident gets. So the allocation engine credits it to them as an
 * owner share, exactly as it does every other carried balance — and this
 * dollar is not theirs. It is the money the other operator was left without.
 *
 * Nic, 10/20, on what the collecting landlord agrees to when they take the
 * resident:
 *
 *   "they can pay you and we'll collect the money from you. But if you click
 *    on this and they don't pay, we're collecting that debt from you. You're
 *    going to be paying that debt on that tenant's behalf. So only... Only
 *    open it if you're ready to freaking rock and roll."
 *
 * Two held items in the ordinary weekly batch move it, which is the mechanism
 * S648 already built for every cent GAM holds — positives and negatives net in
 * one payout, so neither landlord waits on a special transfer:
 *
 *   • NEGATIVE against the collecting landlord, for what was collected. Their
 *     own rent is untouched; only this line comes off, which is why taking the
 *     resident does not cost them their disbursement.
 *   • POSITIVE to the landlord owed, for the same figure. They are made whole
 *     by what arrives, when it arrives.
 *
 * THE FULL FIGURE, both sides, and GAM takes nothing. A collecting landlord who
 * elected to cover processing fees covers this one too — that is their own
 * election, and GAM never absorbs a fee (S512). Netting a smaller figure than
 * is paid out would leave GAM funding the difference.
 *
 * Idempotent per side: held items are unique per (source_type, source_id), and
 * `sourceKey` is the payment for an installment, or the arrangement for the
 * remainder at departure. A replayed webhook writes neither twice.
 */
/**
 * ── ONE COLLECTION, DIVIDED THREE WAYS (Nic, 10/29) ─────────────────────────
 *
 *   "The books need to split three ways per payment and go to the correct
 *    connect accounts. We don't need to have it go like auto to each
 *    landlord's bank and the GAM's bank. It needs to be booked accurately and
 *    split in the Stripe Connect balances."
 *
 * So nothing is paid out here. The whole collection is netted OFF the landlord
 * who collected it — it was never their income, only their invoice — and the
 * shares land in the right Connect balances for the ordinary payout to carry.
 *
 * Gross both ways, deliberately. The collecting landlord's own cut comes back
 * as its own positive line rather than being kept out of the negative, because
 * his instruction on this money has been consistent since 10/22: "the whole
 * thing needs to go out and then come back, not just take it off the top,
 * because it's gonna look weird in the books that way."
 *
 * GAM's share is simply what is left on the platform balance once the two
 * positives are written, and it is BOOKED (platform_revenue_ledger
 * 'left_owing_share') so it is earnings rather than an unexplained residue.
 * Booked per collection as it arrives: a part-paid arrangement earns GAM only
 * the part that was paid.
 */
async function divideCollection(args: {
  client:        PoolClient
  owingId:       string
  collectingId:  string
  amount:        number
  /** What the arrangement had collected BEFORE this payment — the split is
   *  measured against the running total so it cannot drift (splitCollection). */
  collectedBefore: number
  sourceKey:     string
  from:          HeldItemProperty
  why:           string
}): Promise<void> {
  const amount = Math.round(args.amount * 100) / 100
  if (amount <= 0) return

  const owed = await args.client.query<{ landlord_id: string; property_id: string | null }>(
    `SELECT landlord_id, property_id FROM tenant_left_owing WHERE id = $1`, [args.owingId])
  const to = owed.rows[0]
  if (!to) throw new AppError(500, 'A collection arrangement points at a debt that is not there')

  const share = splitCollection(args.collectedBefore, amount)

  // 1. The whole thing off the landlord who collected it.
  await recordHeldItem({
    landlordId:  args.collectingId,
    sourceType:  'left_owing_netted',
    sourceId:    args.sourceKey,
    amount:      -amount,
    description: args.why,
    property:    args.from,
  }, args.client)

  // 2. The landlord who was left without it. Their line sits on THEIR property,
  //    never the collecting landlord's.
  if (share.owed > 0) {
    await recordHeldItem({
      landlordId:  to.landlord_id,
      sourceType:  'left_owing_paid',
      sourceId:    args.sourceKey,
      amount:      share.owed,
      description: 'Collected toward what a former resident left owing',
      property:    { propertyId: to.property_id },
    }, args.client)
  }

  // 3. The collecting landlord's own share, back to them.
  if (share.collector > 0) {
    await recordHeldItem({
      landlordId:  args.collectingId,
      sourceType:  'left_owing_share',
      sourceId:    args.sourceKey,
      amount:      share.collector,
      description: 'Your share of what you collected for another operator',
      property:    args.from,
    }, args.client)
  }

  // 4. GAM's, booked. Rides the caller's transaction so the earnings land with
  //    the money that earned them, or not at all.
  //
  // ── 10/29 (review): KEYED ON THE PAYMENT, NOT THE DEBT ───────────────────
  //
  // This booked against the DEBT (`owingId`), and platform_revenue_ledger has
  // UNIQUE (reference_id, reference_type, type) with a duplicate check that
  // returns bare — `if (dup) return`, no error and no log. So one debt could
  // only ever carry ONE left_owing_share row: the first installment booked
  // GAM's share and every installment after it booked nothing at all, while
  // the cash stayed on the platform balance as an unexplained residue. On a
  // $1,000 debt collected over six months that is $25 booked against $150
  // earned, which is the exact failure the header above says this booking
  // exists to prevent.
  //
  // The two held-item sides were already keyed on the payment (sourceKey), so
  // only GAM's own share was wrong. Keyed the same way it is right for the same
  // reason: one booking per payment, and a replayed settle still books once.
  if (share.gam > 0) {
    const { recordPlatformRevenue } = await import('./platformRevenue')
    await recordPlatformRevenue({
      type:          'left_owing_share',
      amount:        share.gam,
      referenceId:   args.sourceKey,
      referenceType: 'payment',
      propertyId:    to.property_id,
      notes:         'GAM share of a left-owing settlement collected',
    }, args.client)
  }
}

async function moveToOwedLandlord(args: {
  client:        PoolClient
  owingId:       string
  collectingId:  string
  amount:        number
  /** Unique per movement: the payment id, or `departure:<arrangement>`. */
  sourceKey:     string
  /** Where the NEGATIVE line sits — the collecting landlord's own space. */
  from:          HeldItemProperty
  why:           string
}): Promise<void> {
  const amount = Math.round(args.amount * 100) / 100
  if (amount <= 0) return

  // Who is owed, and the space the debt was run up at — their line belongs on
  // their own property, never on the collecting landlord's.
  const owed = await args.client.query<{ landlord_id: string; property_id: string | null }>(
    `SELECT landlord_id, property_id FROM tenant_left_owing WHERE id = $1`, [args.owingId])
  const to = owed.rows[0]
  if (!to) throw new AppError(500, 'A collection arrangement points at a debt that is not there')

  // A landlord collecting their own debt would be paying themselves, and the
  // money would move in a circle. No guard is needed here: the arrangement
  // itself cannot exist (left_owing_collections_not_self), which is the right
  // place for it — one CHECK instead of a test in every writer.

  await recordHeldItem({
    landlordId: args.collectingId,
    sourceType: 'left_owing_netted',
    sourceId:   args.sourceKey,
    amount:     -amount,
    description: args.why,
    property:   args.from,
  }, args.client)

  await recordHeldItem({
    landlordId: to.landlord_id,
    sourceType: 'left_owing_paid',
    sourceId:   args.sourceKey,
    amount:     amount,
    description: 'Collected toward what a former resident left owing',
    property:   { propertyId: to.property_id },
  }, args.client)

  logger.info({ owing_id: args.owingId, from: args.collectingId, to: to.landlord_id, amount },
    '[left-owing] money moved from the landlord who collected it to the landlord who is owed')
}
