// S655 money plan, Step 3: "Money received" and "Money billed".
//
// Nic (10/2): "a landlord should be able to see how much money came in this
// month, ACTUALLY came in, versus how much money actually was SCHEDULED to come
// in... Todd Niemeyer paid two months... one check... The rest was applied as a
// credit. That money has already been in the bank for approximately a month.
// But his rent for October is just showing up now and it's going to apply the
// credit... No new money is going into the bank this month where extra money
// went in last month. So people need to be able to see it both ways."
//
// ONE SELECT of dated, signed money facts (incomeEventsSql) backs every
// landlord report, Books, the dashboard cards and the agent tools, so no two
// screens can tell a landlord different numbers about the same month.
//
// Money received (the default) is strictly the day money ARRIVED:
//   - a bill's row counts its own new money on its settle day:
//       amount − landlord-issued credit − paid-ahead money that paid it.
//     Deposit interest that paid it counts (GAM funds it: new money that day).
//   - paid-ahead money counts in full on the day it arrived, on its own line
//     "Paid ahead for later bills", and $0 again when it pays a later bill.
//     Todd: September = both months of his check; October = $0 from Todd.
//   - a credit the landlord gave is never income.
//   - a reversal (dispute or bank return) is a negative on its own day; the
//     original stays in its month (a past month is never rewritten).
//   - a stay shortened adds no line (the money already arrived); paid-ahead
//     money that goes back into a move-out settlement is a negative that day.
// Money billed counts each bill in the month it was due, paid or not, with
// what became of it (paid, clearing, covered by money paid ahead, covered by
// deposit interest, kept from a deposit, still owed) inside the total, and a
// negative "Credits given" for credit the landlord issued.
//
// Days are the PROPERTY's calendar day (properties.timezone). Every event
// carries its category (decision #4: lot/space rent, each utility, late fees,
// home payments, ...) so the property breakdown and the P&L lines are two
// groupings of the same rows.

import {
  INCOME_BASES, DEFAULT_INCOME_BASIS, INCOME_BASIS_LABEL, INCOME_BASIS_NOTE,
  INCOME_LINES, INCOME_LINE_LABEL, BILLED_PARTS, BILLED_PART_LABEL,
  INCOME_CATEGORIES, INCOME_CATEGORY_LABEL, INCOME_UTILITY_CATEGORIES,
  type IncomeBasis, type IncomeLine, type BilledPart, type IncomeCategory,
} from '@gam/shared'
import { query } from '../db'
import { AppError } from '../middleware/errorHandler'
import { depositOrMoveOutRowSql } from './moneyPredicates'
import { STAY_SHORTENED_CREDIT_NOTE } from './bookingLeaseBilling'
import { RESERVATION_PAID_SQL } from './bookingLeaseDraft'
import { soldCheckOutSql, untaxedMonthStaySql } from './registerStay'
import { disputeShareLineSql, disputeFeeLineSql } from './paymentReversal'
import { PAID_AHEAD_PART_TAKEN_BACK } from './creditUse'

const round2 = (n: number) => Math.round(n * 100) / 100

// ─── The lines of a report ────────────────────────────────────────────────────

/**
 * Lines this module emits that packages/shared's INCOME_LINES does not list
 * yet (Step 16 adds them there; until then they live here, and the dedupe below
 * keeps this correct once it does):
 *   movedToCredit — Money billed: reservation money already paid and counted
 *     (as a stay) that was moved to credit for a later bill: a reservation
 *     deposit's leftover after the arrival rent (movedToCreditSql), and the
 *     part of a shortened stay's credit that came out of the reservation
 *     rather than out of a rent bill (stayShortenedCtes). Negative, under the
 *     stays category (STAY_MONEY_CATEGORY), so the later bill it pays is not
 *     billed twice and the stay nets to what it was worth. Rent moved to credit
 *     when a stay is shortened is "Stay shortened" (stayShortenedCreditSql).
 */
const EXTRA_LINES = ['movedToCredit'] as const
export type ReportLine = IncomeLine | typeof EXTRA_LINES[number]
export const REPORT_LINES: readonly ReportLine[] = [
  ...INCOME_LINES,
  ...EXTRA_LINES.filter(l => !(INCOME_LINES as readonly string[]).includes(l)),
]
export const REPORT_LINE_LABEL: Record<ReportLine, string> = {
  movedToCredit: 'Moved to credit',
  ...INCOME_LINE_LABEL,
}

// ─── THE definition of a landlord's income row ────────────────────────────────

/**
 * S654: THE definition of a landlord's income row, used by every report
 * (this module's money facts, the monthly P&L, owner statement, tax summary,
 * property reports, the report engine, Books). landlordPL re-exports it. A
 * payment row is the landlord's income when:
 *   - it is their money: revenue_owner 'landlord'. Never GAM's fees ('gam':
 *     decline, return, opt-in products), never paid-ahead money GAM holds
 *     ('held', it becomes a paid-ahead credit);
 *   - it is rent, a late fee, a fee, a utility, a home-sale payment, or a
 *     carried balance (pre-platform arrears and work-trade deficits: real
 *     money the tenant pays the landlord, shown as "Balances collected");
 *   - it is not a FlexPay pull ('FLEXPAY', written only by
 *     services/flexpay.ts): GAM reimbursing its own float plus its $25 fee;
 *   - S655: it is not a move-out row (moneyPredicates.depositOrMoveOutRowSql:
 *     DEPOSIT with no lease fee behind it — a refund the landlord owes back,
 *     or the shortfall past the deposit, which the deposit-return lines
 *     count). A non-refundable pet, key, cleaning or utility "deposit" FEE
 *     carries its lease_fee_id and is an ordinary fee.
 * Callers add status and their date window. Deposits are never income; they
 * are reported as held. With no alias the columns are qualified by the table
 * name, for a bare `FROM payments`.
 */
export const LANDLORD_INCOME_TYPES = ['rent', 'late_fee', 'fee', 'utility', 'home_payment', 'carried_balance'] as const
export function landlordIncomeSql(alias?: string): string {
  const x = a(alias ?? 'payments')
  return `(${x}.revenue_owner = 'landlord'
      AND ${x}.type IN (${LANDLORD_INCOME_TYPES.map(t => `'${t}'`).join(', ')})
      AND ${x}.entry_description IS DISTINCT FROM 'FLEXPAY'
      AND NOT ${depositOrMoveOutRowSql(x)})`
}

// ─── Rent and reservation money moved to credit ──────────────────────────────

/** A string constant as a SQL literal. */
const sqlText = (s: string) => `'${s.replace(/'/g, "''")}'`

/**
 * A paid-ahead credit (alias `c`) that a shortened stay banked: money already
 * paid and counted, moved to credit (funded_by 'reclassified'). Either it is
 * anchored to the rent row it reclassifies (source_payment_id), or it carries
 * bookingLeaseBilling's STAY_SHORTENED_CREDIT_NOTE with no anchor: a second
 * shortening against a row that already anchors one, or what is still over
 * after the stay was lengthened again (billLongerStay withdraws the credit and
 * re-makes the rest with no anchor, because the withdrawn credit keeps its
 * anchor and lease_prepaid_credits_source_payment_uidx allows one credit per
 * row). bankShortenedStayOverpayment banks everything the guest paid past the
 * shorter stay — every settled rent bill AND the reservation paid before the
 * lease — so Money billed takes it back off where it came from
 * (stayShortenedCtes): the rent bills, as "Stay shortened" under Lot/space
 * rent, and the reservation, as "Moved to credit" under the stay. The rent
 * card therefore nets it from the rent it came out of, and never counts that
 * rent again when the credit pays a later rent bill. Never NULL.
 */
export function stayShortenedCreditSql(c: string): string {
  const x = a(c)
  return `(${x}.funded_by IS NOT DISTINCT FROM 'reclassified'
      AND (${x}.source_payment_id IS NOT NULL OR ${x}.note IS NOT DISTINCT FROM ${sqlText(STAY_SHORTENED_CREDIT_NOTE)}))`
}

/**
 * A paid-ahead credit (alias `c`) that is a reservation deposit's leftover after
 * the arrival rent (moveInBundle's STAY_DEPOSIT_CREDIT_NOTE): reclassified and
 * not a shortened stay's. The deposit counted as "Stays and pay links" the day
 * it was paid; Money billed takes the leftover back off as "Moved to credit"
 * off the reservation's own payments, newest first, each on the day it counted
 * (reservationBackCtes; a reservation none of whose payments counted uses
 * reservationCountedAtSql, else the credit's received_at, which moveInBundle
 * sets to the reservation's paid day) — so the stay nets to what the arrival
 * rent used and no month reads negative. The later bill it pays counts it as
 * "covered by money paid ahead". The PM owner statement counts no stays, so it
 * leaves out both sides (ownerStatement). Never NULL.
 */
export function movedToCreditSql(c: string): string {
  const x = a(c)
  return `(${x}.funded_by IS NOT DISTINCT FROM 'reclassified' AND NOT ${stayShortenedCreditSql(x)})`
}

/**
 * A paid-ahead credit (alias `c`) the landlord's paid-ahead money screen
 * (services/paidAheadChoice) acted on: a Keep it or refund spend of it, money
 * left as the tenant's credit (left_by_choice_id), or such money carried to
 * their next lease (received_lease_id). Its arrival is never dropped when a
 * dispute or bank return withdraws it later — what was taken back comes off on
 * its own day instead (§0.0: a past month is never rewritten). Ordinary
 * withdrawn credits keep their older reading (they never arrived).
 */
export function choiceTouchedCreditSql(c: string): string {
  const x = a(c)
  return `(${x}.left_by_choice_id IS NOT NULL OR ${x}.received_lease_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM credit_uses k
                  WHERE k.prepaid_credit_id = ${x}.id AND k.status = 'applied'
                    AND (k.paid_ahead_choice_id IS NOT NULL OR k.refund_part_id IS NOT NULL)))`
}

/**
 * decisions #4: the category of reservation money — a stay deposit, and the
 * reservation money later moved to credit (a leftover, or a shortened stay's
 * reservation part). The deposit counted as a stay, so what is taken back off
 * comes off the stay too, never off Lot/space rent.
 */
const STAY_MONEY_CATEGORY: IncomeCategory = 'stays_and_pay_links'

/**
 * Of `amt` dollars of a reclassified credit's use (alias `c`, joined to
 * stayShortenedCtes' tk_share as `ts`), the part that is reservation money:
 * all of a reservation deposit's leftover, and of a shortened stay's credit
 * the lease's reservation share of the money its shortened-stay credits hold
 * (tk_share.share — one share per lease, so the order the credit is spent in
 * never matters). That share counts the reservation money that came back
 * through a rent bill too: the part of the bill a reservation deposit's
 * leftover had paid (stayShortenedCtes). Rent money paid ahead, deposit
 * interest and anything else: 0. The landlord reports put this part under the
 * stay when the credit goes into a move-out settlement; the PM owner statement
 * (which counts no stays) leaves it out of its billed block and adds it back at
 * move-out, exactly as it treats a leftover.
 */
export function reservationPartOfUseSql(amt: string, c: string, ts: string): string {
  const x = a(c), t = a(ts)
  return `(CASE WHEN ${movedToCreditSql(x)} THEN (${amt})
                WHEN ${stayShortenedCreditSql(x)}
                  THEN COALESCE(ROUND((${amt}) * ${t}.share, 2), 0)
                ELSE 0 END)`
}

// ─── The basis switch ─────────────────────────────────────────────────────────

/** `?basis=` on every report. Missing = Money received; anything else is a 400. */
export function parseIncomeBasis(raw: unknown): IncomeBasis {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_INCOME_BASIS
  const v = String(Array.isArray(raw) ? raw[0] : raw).trim().toLowerCase()
  if ((INCOME_BASES as readonly string[]).includes(v)) return v as IncomeBasis
  throw new AppError(400, `basis must be one of: ${INCOME_BASES.join(', ')}`)
}

export interface BasisMeta {
  basis: IncomeBasis
  label: string
  note: string
}
/** What every report echoes as meta.basis. */
export function basisMeta(basis: IncomeBasis): BasisMeta {
  return { basis, label: INCOME_BASIS_LABEL[basis], note: INCOME_BASIS_NOTE[basis] }
}

// ─── Figures shown BESIDE a total, never inside it ───────────────────────────

/**
 * Lines that are not income but are shown next to the total:
 *   clearing        a card or bank payment still clearing (Money received)
 *   creditsYouGave  credit the landlord issued that paid a bill this period
 *   workTrade       bills covered by work trade (never money)
 *   depositsHeld    security deposits received (held for the tenant)
 *   chargebackFees  what a chargeback on a register sale or stay deposit cost
 *                   beyond the sale itself and its tax: Stripe's dispute fee
 *                   and the card fee the buyer had paid (both netted from the
 *                   landlord's next payout)
 *   refundCardFees  10/4 (#38 Q4): the card fee a guest got back with an early
 *                   check-out refund — given back with the refund, netted from
 *                   the landlord's next payout (Stripe keeps its fee; GAM
 *                   absorbs nothing). The landlord's cost, on the refund day.
 */
export const ASIDE_LINES = ['clearing', 'creditsYouGave', 'workTrade', 'depositsHeld', 'chargebackFees', 'refundCardFees'] as const
export type AsideLine = typeof ASIDE_LINES[number]
export const ASIDE_LINE_LABEL: Record<AsideLine | 'paidAheadUnused' | 'collectedSoFar' | 'stillOwed', string> = {
  clearing:        'Still clearing',
  creditsYouGave:  'Credits you gave',
  workTrade:       'Covered by work trade',
  depositsHeld:    'Deposits received (held)',
  chargebackFees:  'Chargeback fees',
  refundCardFees:  'Card fees given back with refunds',
  paidAheadUnused: 'Paid ahead, not used yet',
  collectedSoFar:  'Collected so far',
  stillOwed:       'Still owed',
}

// ─── SQL building blocks ──────────────────────────────────────────────────────

const IDENT = /^[a-z_][a-z0-9_]*$/i
function a(alias: string): string {
  if (!IDENT.test(alias)) throw new Error(`incomeBasis: "${alias}" is not a table alias`)
  return alias
}

/**
 * A utility charge with no utility bill linked to it still says which utility
 * it is: a charge typed in by hand names the utility at the start of its note
 * ("Electric — Aug 2026 (461 kWh @ $0.2100, used before the lease was
 * signed)"). Production, 10/3: Mountain View's three August electric charges
 * paid in cash on the September bills ($96.81, $81.27, $25.20 = $203.28) were
 * entered that way and have no linked bill (the August bills written later
 * were voided as duplicates). Without this they read as "Other utilities" and
 * "how much electric was billed back" reads low. Postgres regex: \M is the
 * end of a word.
 */
const UTILITY_NAMED_IN_NOTES: ReadonlyArray<readonly [string, IncomeCategory]> = [
  ['^\\s*electric(ity)?\\M',      'electric'],
  ['^\\s*water\\M',               'water'],
  ['^\\s*sewer\\M',               'sewer'],
  ['^\\s*(natural\\s+)?gas\\M', 'gas'],
  ['^\\s*trash\\M',               'trash'],
]

/**
 * Decision #4: a charge's category, in this order: the utility bill it pays
 * (utility_bills.payment_id → utility_type), then its lease fee (trash_fee →
 * trash), then its entry (PROPANE, HOMEPMT, LATEFEE), then its type — a
 * utility with no linked bill by the utility its note names first
 * (UTILITY_NAMED_IN_NOTES), else "Other utilities". Rent is "Lot/space rent".
 * `ubType` is the utility type column already joined.
 */
export function categorySql(p: string, ubType: string, lf: string): string {
  const x = a(p), f = a(lf)
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i.test(ubType)) throw new Error('incomeBasis: bad utility type column')
  return `(CASE
      WHEN ${ubType} IN ('electric','water','sewer','gas','trash') THEN ${ubType}
      WHEN ${f}.fee_type = 'trash_fee' THEN 'trash'
      WHEN upper(COALESCE(${x}.entry_description, '')) = 'PROPANE' THEN 'propane'
      WHEN ${x}.type = 'home_payment' OR ${x}.entry_description = 'HOMEPMT' THEN 'home_payments'
      WHEN ${x}.type = 'late_fee' OR ${x}.entry_description = 'LATEFEE' THEN 'late_fees'
      WHEN ${x}.type = 'carried_balance' THEN 'balances_collected'
      ${UTILITY_NAMED_IN_NOTES.map(([re, cat]) => `WHEN ${x}.type = 'utility' AND COALESCE(${x}.notes, '') ~* '${re}' THEN '${cat}'`).join('\n      ')}
      WHEN ${x}.type = 'utility' THEN 'utility_other'
      WHEN ${x}.type = 'rent' THEN 'space_rent'
      ELSE 'other_fees' END)`
}

/** The P&L line of a charge, read off its category so the two groupings agree. */
function lineFromCategorySql(category: string): string {
  const utilities = INCOME_UTILITY_CATEGORIES.map(c => `'${c}'`).join(',')
  return `(CASE
      WHEN ${category} = 'space_rent' THEN 'rent'
      WHEN ${category} IN (${utilities}) THEN 'utilities'
      WHEN ${category} = 'late_fees' THEN 'lateFees'
      WHEN ${category} = 'home_payments' THEN 'homeSale'
      WHEN ${category} = 'balances_collected' THEN 'balances'
      ELSE 'fees' END)`
}

/** The property's calendar day of an instant. */
function localDay(ts: string, tz: string): string {
  return `((${ts}) AT TIME ZONE ${tz})::date`
}

// Parameters every branch shares:
//   $1 uuid[]  landlord ids (NULL = every landlord: the admin lens)
//   $2 date    first day
//   $3 date    last day (whole day)
//   $4 uuid[]  property ids (NULL = no property filter)
const LL = (col: string) => `($1::uuid[] IS NULL OR ${col} = ANY($1::uuid[]))`
// Instants are pre-filtered a day wide on each side, then cut on the property's own day.
const NEAR = (ts: string) => `(${ts} >= ($2::date - 1) AND ${ts} < ($3::date + 2))`
// Fix pass 3: a 'dispute' payout line giving a payee back what a chargeback GAM
// won took ('<dispute>:returned_on_win' — stripeCosts.wonChargebackReturnSourceId).
// Checked after disputeFeeLineSql, whose own hand-back line shares the suffix.
const WON_CHARGEBACK_RETURN = (h: string) => `(${h}.source_id LIKE '%:returned\\_on\\_win')`
const TZ = (pr: string) => `COALESCE(${a(pr)}.timezone, 'America/Phoenix')`

// ── The move-out ──
//
// depositReturn's finalize keeps from the pool (deposit + interest + paid-ahead
// money) everything it deducts: cleaning + damage + other (DED) AND the unpaid
// bills it sweeps to paid_via_deposit. The gap — what the tenant still owes past
// the pool — is the WHOLE shortfall. Up to DED it is the deductions' own (they
// are still owed first); past DED it belongs to the swept bills: a tenant who
// skips out owing $700 of rent against a $400 deposit and $100 of cleaning
// leaves $400 kept, $100 of cleaning and $300 of rent still owed.

/** What a move-out (alias `dr`) deducts besides the bills it sweeps. */
function dedSql(dr: string): string {
  const d = a(dr)
  return `(${d}.cleaning_fee_amount
            + COALESCE((SELECT SUM((e->>'amount')::numeric) FROM jsonb_array_elements(${d}.damage_lines) e), 0)
            + COALESCE((SELECT SUM((e->>'amount')::numeric) FROM jsonb_array_elements(${d}.other_deductions) e), 0))`
}
const DED = dedSql('dr')

/**
 * A landlord bill (alias `s`) the move-out (alias `dr`) swept to its deposit.
 * Matched by the finalize itself, never by lease: the sweep reaches the whole
 * renewal chain, so a swept bill can sit on the PREVIOUS lease while the
 * deposit and the move-out sit on the new one. depositReturn's finalize marks
 * the swept bills paid_via_deposit with settled_at = NOW() in the same
 * transaction that stamps finalized_at = NOW(), so the two instants are equal.
 */
function sweptBySql(s: string, dr: string): string {
  const x = a(s), d = a(dr)
  return `(${x}.status = 'paid_via_deposit' AND ${x}.settled_at = ${d}.finalized_at
        AND ${x}.landlord_id = ${d}.landlord_id AND ${landlordIncomeSql(x)})`
}

/** A finalized move-out (alias `dr`). */
const FINALIZED = (dr: string) =>
  `(${a(dr)}.finalized_at IS NOT NULL AND ${a(dr)}.status NOT IN ('draft','awaiting_approval'))`

/**
 * A move-out's (alias `dr`) shortfall rows, as a LATERAL subquery returning
 * `id`: the gap row its finalize billed, and every row a dispute or bank return
 * reopened from it (payments.reversal_id → the reversal of the row before).
 * Pay in full: each row is paid whole, and a reversal moves what it took back
 * onto a fresh row, so the chain carries the gap between its rows. The PM
 * owner statement reads the same rows.
 */
export function gapChainSql(dr: string): string {
  const d = a(dr)
  return `(
      WITH RECURSIVE gch(id) AS (
        SELECT ${d}.gap_payment_id WHERE ${d}.gap_payment_id IS NOT NULL
        UNION ALL
        SELECT rp.id FROM gch
          JOIN payment_reversals gr ON gr.payment_id = gch.id
          JOIN payments rp ON rp.reversal_id = gr.id)
      SELECT id FROM gch)`
}

/**
 * Money received: `amt` dollars of a move-out's (alias `dr`) shortfall, split
 * the way the move-out split the shortfall (moveOutSweepSql): each bill it
 * swept carries its share of the shortfall past the deductions (the bill's
 * `short`, scaled to `amt`) under that bill's own category — swept rent the
 * tenant pays off later is lot rent collected, as Money billed counts it; the
 * rest — the deductions' own part, and a shortfall no swept bill carries — has
 * no category. A LATERAL subquery returning (category, amount) that adds up to
 * `amt` to the cent.
 */
function shortfallSplitSql(dr: string, amt: string): string {
  const d = a(dr)
  return `(
      WITH sf_share AS (
        SELECT ${categorySql('sfs', 'sfub.utility_type', 'sflf')} AS category,
               ROUND(sfmo.short * (${amt}) / NULLIF(${d}.gap_amount, 0), 2) AS amount
          FROM payments sfs
          LEFT JOIN lease_fees sflf ON sflf.id = sfs.lease_fee_id
          LEFT JOIN LATERAL (SELECT ub0.utility_type FROM utility_bills ub0
                              WHERE ub0.payment_id = sfs.id ORDER BY ub0.created_at, ub0.id LIMIT 1) sfub ON TRUE
          JOIN LATERAL ${moveOutSweepSql('sfs')} sfmo ON sfmo.move_out_id = ${d}.id
         WHERE ${sweptBySql('sfs', d)})
      SELECT category, amount FROM sf_share
      UNION ALL
      SELECT NULL::text, (${amt}) - COALESCE((SELECT SUM(amount) FROM sf_share), 0))`
}

/**
 * Money billed: one slice of the shortfall of the move-out `drId` — a swept
 * bill's share (`billShort`: the bill's `short`) or, with `billShort` null,
 * the deductions' own part — split by what became of the shortfall, read off
 * its rows (gapChainSql): a row paid is 'paid'; a row later disputed or
 * returned is 'paid' less what each of its reversals took back (its reopened
 * row carries that), as every returned bill is; a row still clearing is
 * 'clearing'; anything else is still owed — and with no gap row at all, the
 * whole slice is still owed.
 *
 * Every row, and every reversal of one, is cut into slices exactly as Money
 * received cuts it (shortfallSplitSql): a bill's slice of `x` dollars is
 * ROUND(short × x / gap, 2), the deductions' slice is `x` less every swept
 * bill's. So what Money billed says a bill collected of its shortfall is, to
 * the cent, what Money received counted for it as "Deposit shortfall
 * collected" less what disputes took back — rounding a bill's share once over
 * the whole chain instead drifts a cent or two from the per-row figures after a
 * partial dispute. A LATERAL subquery returning (part, amount) that adds up to
 * `amt` (the slice) to the cent.
 */
function gapPartSplitSql(drId: string, amt: string, billShort: string | null): string {
  // The slice of `x` dollars of one shortfall row (or of one reversal of it).
  const slice = (x: string) => billShort !== null
    ? `COALESCE(ROUND((${billShort}) * (${x}) / NULLIF(gdr.gap_amount, 0), 2), 0)`
    : `((${x}) - COALESCE((SELECT SUM(ROUND(gbs.short * (${x}) / NULLIF(gdr.gap_amount, 0), 2)) FROM gbs), 0))`
  // The deductions' slice is what the swept bills' shares leave: each bill's
  // `short`, read the way shortfallSplitSql reads it.
  const sweptShares = billShort !== null ? '' : `
      gbs AS (
        SELECT sfmo.short
          FROM gdr
          CROSS JOIN payments sfs
          JOIN LATERAL ${moveOutSweepSql('sfs')} sfmo ON sfmo.move_out_id = gdr.id
         WHERE ${sweptBySql('sfs', 'gdr')}),`
  return `(
      WITH gdr AS (SELECT * FROM deposit_returns WHERE id = ${drId}),${sweptShares}
      grow AS (
        SELECT gpr.id, GREATEST(gpr.amount, 0) AS amount,
               CASE WHEN gpr.status = 'settled'
                         OR (gpr.status = 'returned'
                             AND (gpr.settled_at IS NOT NULL
                                  OR EXISTS (SELECT 1 FROM payment_reversals gx WHERE gx.payment_id = gpr.id))) THEN 'paid'
                    WHEN gpr.status = 'processing' THEN 'clearing' END AS part
          FROM gdr
          CROSS JOIN LATERAL ${gapChainSql('gdr')} gc
          JOIN payments gpr ON gpr.id = gc.id),
      gpiece AS (
        SELECT part, amount AS x, 1 AS sgn FROM grow WHERE part IS NOT NULL
        UNION ALL
        SELECT 'paid', gpv.reversed_amount, -1
          FROM grow JOIN payment_reversals gpv ON gpv.payment_id = grow.id
         WHERE grow.part = 'paid'),
      gpart AS (
        SELECT gpiece.part, gpiece.sgn * ${slice('gpiece.x')} AS amount
          FROM gpiece CROSS JOIN gdr),
      gshare AS (
        SELECT pt.part, COALESCE((SELECT SUM(gq.amount) FROM gpart gq WHERE gq.part = pt.part), 0) AS amount
          FROM (VALUES ('paid'), ('clearing')) AS pt(part))
      SELECT part, amount FROM gshare
      UNION ALL
      SELECT 'stillOwed', (${amt}) - (SELECT SUM(amount) FROM gshare))`
}

/**
 * The shortfall past the deductions that no swept bill can carry (a move-out
 * whose bills were swept by something this module cannot match): it stays on
 * the move-out itself, as one uncategorized amount, so the move-out still adds
 * exactly what the pool kept.
 */
function unsharedShortfallSql(dr: string, ded: string): string {
  const d = a(dr)
  return `(CASE WHEN EXISTS (SELECT 1 FROM payments s WHERE ${sweptBySql('s', d)} AND s.amount > 0)
            THEN 0 ELSE GREATEST(${d}.gap_amount - ${ded}, 0) END)`
}
const UNSHARED_SHORTFALL = unsharedShortfallSql('dr', 'd.ded')

/**
 * What a finalized move-out (alias `dr`) kept for itself, beside the bills it
 * swept: its deductions less the shortfall up to them (still owed by the
 * tenant), less a shortfall past them that no swept bill carries. Under Money
 * received this is "Deposit deductions kept" plus the move-out's own
 * uncategorized "Kept from deposits"; the PM owner statement reads the same
 * figure, so the two never disagree about a move-out.
 */
export function moveOutDeductionsKeptSql(dr: string): string {
  const d = a(dr)
  const ded = dedSql(d)
  return `(${ded} - LEAST(${d}.gap_amount, ${ded}) - ${unsharedShortfallSql(d, ded)})`
}

/**
 * For a payment row (alias `p`): when it is a bill a move-out swept to its
 * deposit, that move-out and the bill's share of the shortfall past the
 * deductions — the part of the bill the pool never covered. One row or none,
 * joined as a LEFT JOIN LATERAL (… ) mo ON TRUE. Columns:
 *   move_out_id        the deposit return
 *   move_out_lease_id  its lease (where its deposit is recorded; a swept bill
 *                      can sit on the previous lease of a renewal chain)
 *   short              the bill's share: the bills swept share the shortfall
 *                      past the deductions by amount; the running total is
 *                      rounded, so the shares add up to it to the cent
 * Every screen that counts a swept bill (this module, the PM owner statement)
 * reads it, so none counts more than the pool kept. What became of the share
 * (Money billed) is the shortfall's own: gapPartSplitSql. When the tenant pays
 * the shortfall, shortfallSplitSql hands each bill its share back.
 */
export function moveOutSweepSql(p: string): string {
  const x = a(p)
  if (['dr', 'sh', 'sw', 'swp', 'e'].includes(x)) throw new Error(`incomeBasis: "${x}" is used inside moveOutSweepSql`)
  return `(
      SELECT dr.id AS move_out_id, dr.lease_id AS move_out_lease_id,
             ROUND(sh.beyond * sw.upto / NULLIF(sw.total, 0), 2)
               - ROUND(sh.beyond * (sw.upto - GREATEST(${x}.amount, 0)) / NULLIF(sw.total, 0), 2) AS short
        FROM deposit_returns dr
        CROSS JOIN LATERAL (SELECT GREATEST(dr.gap_amount - ${DED}, 0) AS beyond) sh
        CROSS JOIN LATERAL (
          SELECT SUM(GREATEST(swp.amount, 0)) AS total,
                 SUM(GREATEST(swp.amount, 0)) FILTER (WHERE swp.id <= ${x}.id) AS upto
            FROM payments swp WHERE ${sweptBySql('swp', 'dr')}) sw
       WHERE ${x}.status = 'paid_via_deposit'
         AND dr.finalized_at = ${x}.settled_at AND dr.landlord_id = ${x}.landlord_id
         AND ${FINALIZED('dr')}
       ORDER BY dr.id LIMIT 1)`
}

/**
 * One charge row with everything a basis needs, already split by who paid it:
 *   iss / pa / di   credit SPENT on it: landlord-issued, paid ahead, deposit
 *                   interest (v_payment_money: applied and reversed uses)
 *   hiss / hpa / hdi  credit SET ASIDE on it by a card or bank payment still
 *                   clearing, or by a failed one whose retry is scheduled
 *                   (held uses), by the same three kinds; held = their sum
 *   rvu             paid-ahead spends undone because the money that funded the
 *                   credit was disputed (reversed uses)
 *   rv / rv_n       what disputes and returns took back from this row
 *   move_out_id     a bill swept to a deposit: the move-out that swept it
 *   short           its share of that move-out's shortfall past the
 *                   deductions — the bills swept share it by amount (the
 *                   running total is rounded, so the shares add up to it to
 *                   the cent) — which the pool never covered
 *   reversal_id     a row a dispute or bank return reopened: the reversal it
 *                   re-asks (payments.reversal_id); NULL on an original bill
 * `ll` is the landlord filter (default: $1, a uuid[] or NULL for every landlord).
 */
function payCte(where: string, ll: (col: string) => string = LL): string {
  return `
  SELECT p.id, p.landlord_id, p.lease_id, p.type, p.status, p.due_date, p.settled_at, p.processed_at, p.created_at,
         p.reversal_id,
         u.property_id, u.id AS unit_id, ${TZ('pr')} AS tz,
         GREATEST(p.amount, 0)::numeric AS amt,
         LEAST(p.issued_credit_amount, GREATEST(p.amount, 0))::numeric AS iss,
         COALESCE(vm.paid_ahead_credit, 0)::numeric AS pa,
         COALESCE(vm.deposit_interest_credit, 0)::numeric AS di,
         COALESCE(cr.reversed_use, 0)::numeric AS rvu,
         COALESCE(cr.held_issued, 0)::numeric AS hiss,
         COALESCE(cr.held_paid_ahead, 0)::numeric AS hpa,
         COALESCE(cr.held_interest, 0)::numeric AS hdi,
         (COALESCE(cr.held_issued, 0) + COALESCE(cr.held_paid_ahead, 0) + COALESCE(cr.held_interest, 0))::numeric AS held,
         COALESCE(rv.reversed, 0)::numeric AS rv,
         COALESCE(rv.n, 0)::int AS rv_n,
         mo.move_out_id,
         COALESCE(mo.short, 0)::numeric AS short,
         ${categorySql('p', 'ub.utility_type', 'lf')} AS category
    FROM payments p
    LEFT JOIN leases pl     ON pl.id = p.lease_id
    LEFT JOIN units u       ON u.id = COALESCE(p.unit_id, pl.unit_id)
    LEFT JOIN properties pr ON pr.id = u.property_id
    LEFT JOIN lease_fees lf ON lf.id = p.lease_fee_id
    LEFT JOIN LATERAL (SELECT ub0.utility_type FROM utility_bills ub0
                        WHERE ub0.payment_id = p.id ORDER BY ub0.created_at, ub0.id LIMIT 1) ub ON TRUE
    LEFT JOIN v_payment_money vm ON vm.payment_id = p.id
    LEFT JOIN LATERAL (
      SELECT SUM(cu.amount) FILTER (WHERE cu.status = 'reversed') AS reversed_use,
             SUM(cu.amount) FILTER (WHERE cu.status = 'held' AND cu.prepaid_credit_id IS NOT NULL) AS held_paid_ahead,
             SUM(cu.amount) FILTER (WHERE cu.status = 'held' AND tc.category = 'deposit_interest')  AS held_interest,
             SUM(cu.amount) FILTER (WHERE cu.status = 'held' AND cu.tenant_credit_id IS NOT NULL
                                      AND tc.category IS DISTINCT FROM 'deposit_interest')        AS held_issued
        FROM credit_uses cu
        LEFT JOIN tenant_credits tc ON tc.id = cu.tenant_credit_id
       WHERE cu.payment_id = p.id) cr ON TRUE
    LEFT JOIN LATERAL (SELECT SUM(r.reversed_amount) AS reversed, COUNT(*) AS n
                         FROM payment_reversals r WHERE r.payment_id = p.id) rv ON TRUE
    LEFT JOIN LATERAL ${moveOutSweepSql('p')} mo ON TRUE
   WHERE ${ll('p.landlord_id')}
     AND ${landlordIncomeSql('p')}
     -- decisions #48.5 (charges5 review): a voided charge (nobody owes it; kept
     -- as a record) is left out of every figure — never billed, never "still
     -- owed", never collected. Only an owed charge can be voided, so it never
     -- had money behind it.
     AND p.status <> 'voided'
     AND ${where}`
}

// Column order of every branch below.
const COLS = 'landlord_id, property_id, unit_id, lease_id, payment_id, due_date, day, line, category, part, amount, in_total, move_out_id'

// ── Money received ──

/**
 * Money in flight on a charge: what is left after every credit SPENT on it and
 * every credit SET ASIDE on it. "Still clearing" is this figure under both
 * bases, so flipping the switch never shows two different clearing amounts for
 * the same payment. A deposit shortfall payment still clearing is not a bill
 * here (it is a move-out row): its own branch below puts the whole row beside
 * the total, split as Money billed splits it (gapPartSplitSql's 'clearing').
 */
const IN_FLIGHT = '(amt - iss - pa - di - held)'

/**
 * A row that settled counts on its settle day whatever happened to it later.
 * A row later disputed or returned ('returned') stays in its own month — a
 * past month is never rewritten — and what the reversal took back is its own
 * negative on the reversal day (payment_reversals). A row the legacy admin
 * return (POST /payments/:id/handle-return) marked 'returned' has no reversal
 * record, so nothing comes off for it yet; it still never drops out of the
 * month it settled in.
 */
const SETTLED_ONCE = `settled_at IS NOT NULL AND status IN ('settled','paid_via_deposit','returned')`

function receivedBranches(): string[] {
  const counted = SETTLED_ONCE
  return [
    // Each bill's own new money, on the day it settled. A swept row is kept
    // from the deposit — less its share of a shortfall past the deductions,
    // which the pool never covered (it counts as "Deposit shortfall collected"
    // when the tenant pays it), so a move-out adds exactly what the pool kept.
    `SELECT landlord_id, property_id, unit_id, lease_id, id, due_date, ${localDay('settled_at', 'tz')},
            CASE WHEN status = 'paid_via_deposit' THEN 'keptFromDeposits' ELSE ${lineFromCategorySql('category')} END,
            category, NULL::text, (amt - iss - pa - short), TRUE, move_out_id
       FROM rx_pay WHERE ${counted}`,
    // Beside: credit the landlord issued that came off this period's income.
    `SELECT landlord_id, property_id, unit_id, lease_id, id, due_date, ${localDay('settled_at', 'tz')},
            'creditsYouGave', category, NULL::text, iss, FALSE, move_out_id
       FROM rx_pay WHERE ${counted} AND iss > 0`,
    // Beside: a card or bank payment still clearing (the money in flight).
    `SELECT landlord_id, property_id, unit_id, lease_id, id, due_date, ${localDay('COALESCE(processed_at, created_at)', 'tz')},
            'clearing', category, NULL::text, ${IN_FLIGHT}, FALSE, NULL::uuid
       FROM rx_pay WHERE status = 'processing'`,
    // Paid-ahead money, in full, on the day it arrived. Reclassified rent (a
    // stay shortened, a reservation deposit's leftover) already counted when it
    // was paid; a withdrawn credit never arrived.
    // Review fix (choice46b pass 2), §0.0 — the day AND the place it arrived:
    //   - money left as the tenant's credit and carried to their next lease
    //     (paid_ahead_carry_left) counts on the lease it arrived on
    //     (received_lease_id), never the next one's property or past months;
    //   - a credit the landlord's paid-ahead money screen already acted on (a
    //     Keep it spend, or a refund from it) that a dispute or bank return
    //     then withdrew DID arrive: the take-back comes off on its own day
    //     ('returned' below, the refund on its day), so the arrival stays in
    //     its month — dropping it rewrote a past month and counted the
    //     take-back twice.
    `SELECT l.landlord_id, u.property_id, u.id, l.id, NULL::uuid, NULL::date,
            ${localDay('COALESCE(c.received_at, c.created_at)', TZ('pr'))},
            'paidAhead', NULL::text, NULL::text, c.amount_original, TRUE, NULL::uuid
       FROM lease_prepaid_credits c
       JOIN leases l ON l.id = COALESCE(c.received_lease_id, c.lease_id)
       LEFT JOIN units u ON u.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE ${LL('l.landlord_id')}
        AND (c.voided_at IS NULL OR ${choiceTouchedCreditSql('c')})
        AND c.funded_by IS DISTINCT FROM 'reclassified'
        AND ${NEAR('COALESCE(c.received_at, c.created_at)')}`,
    // Review fix (choice46b pass 3), §0.0: a credit the paid-ahead money
    // screen touched (above) that a dispute or bank return then WITHDREW kept
    // its arrival, so what was still on it — left as the tenant's credit, or
    // carried to their next lease — comes off on the day it was withdrawn,
    // where it arrived. (A Keep it spend comes off through its own payout
    // line below; a refund through its refund line: neither is still on it.)
    // So refund + leave + a full return nets to the arrival less everything
    // taken, and Leave it + a full dispute leaves the arrival's month as it was.
    `SELECT l.landlord_id, u.property_id, u.id, l.id, NULL::uuid, NULL::date,
            ${localDay('c.voided_at', TZ('pr'))},
            'returned', NULL::text, NULL::text, -c.amount_remaining, TRUE, NULL::uuid
       FROM lease_prepaid_credits c
       JOIN leases l ON l.id = COALESCE(c.received_lease_id, c.lease_id)
       LEFT JOIN units u ON u.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE ${LL('l.landlord_id')}
        AND c.voided_at IS NOT NULL AND c.amount_remaining > 0 AND ${choiceTouchedCreditSql('c')}
        AND c.funded_by IS DISTINCT FROM 'reclassified'
        AND ${NEAR('c.voided_at')}`,
    // Paid-ahead money that went into a move-out settlement: it already
    // counted when it arrived, so it comes back off on the finalize day
    // (deductions kept from the pool count on their own line). Reservation
    // money in it — a reservation deposit's leftover, or a shortened stay's
    // reservation share (reservationPartOfUseSql) — counted as a stay, never
    // as rent, so that part comes off the stay (the rent card leaves it out).
    // A move-out use is always paid-ahead money (credit_uses_move_out_is_paid_ahead).
    `SELECT l.landlord_id, u.property_id, u.id, l.id, NULL::uuid, NULL::date,
            ${localDay('dr.finalized_at', TZ('pr'))},
            'paidAheadRefunded', sp.category, NULL::text, -sp.amount, TRUE, dr.id
       FROM credit_uses cu
       JOIN deposit_returns dr ON dr.id = cu.deposit_return_id
       JOIN lease_prepaid_credits c ON c.id = cu.prepaid_credit_id
       -- Review fix (choice46b pass 3): where the money ARRIVED, as its arrival
       -- line reads it — money left as the tenant's credit and carried to a
       -- lease at another property (paid_ahead_carry_left) that this move-out
       -- swept comes off where it counted, never at the property that swept it
       -- (which counts what the pool kept on its own line).
       JOIN leases l ON l.id = COALESCE(c.received_lease_id, cu.lease_id)
       LEFT JOIN tk_share ts ON ts.lease_id = c.lease_id
       LEFT JOIN units u ON u.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
       CROSS JOIN LATERAL (SELECT ${reservationPartOfUseSql('cu.amount', 'c', 'ts')} AS stay) rp
       CROSS JOIN LATERAL (VALUES ('${STAY_MONEY_CATEGORY}'::text, rp.stay), (NULL::text, cu.amount - rp.stay)) AS sp(category, amount)
      WHERE ${LL('l.landlord_id')}
        AND cu.status = 'applied' AND dr.finalized_at IS NOT NULL
        AND ${NEAR('dr.finalized_at')}`,
    // 10/4 (decisions #38 Q8): a long stay's money paid past the day they left
    // (it already counted when the rent was paid), refunded at its early
    // check-out, comes back off on the refund day — the reservation's share of
    // it as a stay, the rest as rent. A part recorded on a register sale counts
    // through that sale's refund row instead; credit given back to credit
    // moves no money.
    // Fix round 2: a card refund Stripe later sent back keeps its own day and
    // is added back on the day it came back (rp.reversed_at) — a closed day is
    // never rewritten; its replacement part counts on the day it goes out.
    // Review fix (choice46b): a refund from the landlord's paid-ahead money
    // screen (services/paidAheadChoice — any ended lease, a stay behind it or
    // not) is the same: its money counted the day it arrived, so the refund
    // comes off on the day it went back (cash handed back, a card or bank
    // refund sent), and a refund Stripe sent back is added back on that day.
    // Keep it and Leave it as their credit move no money: they add nothing.
    // Pass 2: a refund of money carried from an earlier lease (left as their
    // credit, paid_ahead_carry_left) comes off where that money arrived
    // (received_lease_id), the place its arrival counted.
    `SELECT rp.landlord_id, u.property_id, u.id, l.id, NULL::uuid, NULL::date,
            ${localDay('ev.at', TZ('pr'))},
            'paidAheadRefunded',
            CASE WHEN rp.stay_payment_id IS NOT NULL THEN '${STAY_MONEY_CATEGORY}' END,
            NULL::text, ev.sign * (rp.toward_amount - rp.lodging_tax_share), TRUE, NULL::uuid
       FROM stay_refund_parts rp
       LEFT JOIN stay_checkout_decisions sd ON sd.id = rp.decision_id
       LEFT JOIN paid_ahead_choices pc ON pc.id = rp.paid_ahead_choice_id
       LEFT JOIN lease_prepaid_credits rc ON rc.id = rp.prepaid_credit_id AND pc.id IS NOT NULL
       JOIN leases l ON l.id = COALESCE(sd.lease_id, rc.received_lease_id, pc.lease_id)
       LEFT JOIN units u ON u.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
       CROSS JOIN LATERAL (VALUES (rp.refunded_at, -1), (rp.reversed_at, 1)) AS ev(at, sign)
      WHERE ${LL('rp.landlord_id')} AND COALESCE(sd.lease_id, pc.lease_id) IS NOT NULL AND rp.kind <> 'credit'
        AND rp.pos_refund_id IS NULL AND rp.status IN ('refunded', 'handed_back')
        AND ev.at IS NOT NULL AND ${NEAR('ev.at')}`,
    // Review fix (choice46b): money paid ahead the landlord KEPT on the
    // paid-ahead money screen, then taken back by a dispute or a bank return
    // of the payment that brought it in — it counted the day it arrived, so
    // it comes off on the day it was taken back ("Returned or disputed"),
    // as the landlord is charged it back on their payout
    // (creditUse.choiceNetSourceId; a payout line never read as a register
    // chargeback — its source id is an 'owner_share_' line).
    // Pass 2: counted exactly once with the arrival — the arrival stays in its
    // month even when the take-back withdrew the credit (the paidAhead branch
    // above), and this line is where that money arrived (received_lease_id).
    // Choice46d (review): the same for cash the desk handed back instead of
    // a card or bank refund of money GAM held — GAM released what it held to
    // the landlord, and a dispute or return took it back off their payout
    // (choiceNetSourceId keyed by the cash part, never a spend): the 4th
    // field of the source id names a Keep it spend OR that cash part.
    `SELECT h.landlord_id, u.property_id, u.id, l.id, NULL::uuid, NULL::date,
            ${localDay('h.created_at', TZ('pr'))},
            'returned', NULL::text, NULL::text, h.amount, TRUE, NULL::uuid
       FROM held_payout_items h
       CROSS JOIN LATERAL (SELECT CASE WHEN split_part(h.source_id, ':', 4) ~ '^[0-9a-f-]{36}$'
                                       THEN split_part(h.source_id, ':', 4)::uuid END AS ref) k
       LEFT JOIN credit_uses cu ON cu.id = k.ref AND cu.paid_ahead_choice_id IS NOT NULL
       LEFT JOIN stay_refund_parts crp ON crp.id = k.ref AND crp.kind = 'cash' AND crp.paid_ahead_choice_id IS NOT NULL
       JOIN paid_ahead_choices pc ON pc.id = COALESCE(cu.paid_ahead_choice_id, crp.paid_ahead_choice_id)
       JOIN lease_prepaid_credits kc ON kc.id = COALESCE(cu.prepaid_credit_id, crp.prepaid_credit_id)
       JOIN leases l ON l.id = COALESCE(kc.received_lease_id, pc.lease_id)
       LEFT JOIN units u ON u.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE ${LL('h.landlord_id')} AND h.source_type = 'dispute'
        AND h.source_id LIKE 'owner\\_share\\_returned:paid-ahead-choice:%'
        AND ${NEAR('h.created_at')}`,
    // Choice46d (review): a refund from the paid-ahead money screen that had
    // not gone out when a dispute or bank return of the payment it came from
    // took that money back (the part is marked PAID_AHEAD_PART_TAKEN_BACK —
    // the dispute gave it back to the tenant instead). Its money counted the
    // day it arrived and no refund ever comes off for it, so what the event
    // took comes off once, on the day the dispute or return was recorded
    // (the first record of either for that payment), where it arrived.
    `SELECT rp.landlord_id, u.property_id, u.id, l.id, NULL::uuid, NULL::date,
            ${localDay('tb.at', TZ('pr'))},
            'returned', NULL::text, NULL::text, -rp.toward_amount, TRUE, NULL::uuid
       FROM stay_refund_parts rp
       JOIN paid_ahead_choices pc ON pc.id = rp.paid_ahead_choice_id
       LEFT JOIN lease_prepaid_credits rc ON rc.id = rp.prepaid_credit_id
       JOIN leases l ON l.id = COALESCE(rc.received_lease_id, pc.lease_id)
       LEFT JOIN units u ON u.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
       CROSS JOIN LATERAL (
         -- Never before the part itself was made: a refund that went out, came
         -- back failed and was then marked (creditUse.undoOwedAgainForFailedRefunds)
         -- comes off on the day its replacement was made, never in a past month.
         SELECT GREATEST(rp.created_at, LEAST(
                  (SELECT MIN(d.created_at) FROM connect_disputes d WHERE d.stripe_payment_intent_id = rp.stripe_payment_intent_id),
                  (SELECT MIN(r.created_at) FROM payment_reversals r JOIN payments x ON x.id = r.payment_id
                    WHERE x.stripe_payment_intent_id = rp.stripe_payment_intent_id AND x.manual_method IS NULL),
                  (SELECT MIN(n.created_at) FROM admin_notifications n
                    WHERE n.category = 'paid_ahead_choice_taken_back' AND n.context->>'credit_id' = rp.prepaid_credit_id::text))) AS at) tb
      WHERE ${LL('rp.landlord_id')} AND rp.kind IN ('card', 'bank') AND rp.status = 'failed'
        AND rp.failure = ${sqlText(PAID_AHEAD_PART_TAKEN_BACK)}
        AND tb.at IS NOT NULL AND ${NEAR('tb.at')}`,
    // A dispute or return: the money each row lost, negative on the reversal
    // day. One record per row (the event + the row): a row the disputed charge
    // paid loses its money part; a later row whose paid-ahead spend the dispute
    // undid (a 'reversed' use) loses that spend — it counted when the money
    // arrived, so it must come off when that money goes back.
    `SELECT op.landlord_id, u.property_id, u.id, op.lease_id, op.id, op.due_date,
            ${localDay('r.created_at', TZ('pr'))},
            'returned', ${categorySql('op', 'ub.utility_type', 'lf')}, NULL::text, -r.reversed_amount, TRUE, NULL::uuid
       FROM payment_reversals r
       JOIN payments op ON op.id = r.payment_id
       LEFT JOIN leases pl ON pl.id = op.lease_id
       LEFT JOIN units u ON u.id = COALESCE(op.unit_id, pl.unit_id)
       LEFT JOIN properties pr ON pr.id = u.property_id
       LEFT JOIN lease_fees lf ON lf.id = op.lease_fee_id
       LEFT JOIN LATERAL (SELECT ub0.utility_type FROM utility_bills ub0
                           WHERE ub0.payment_id = op.id ORDER BY ub0.created_at, ub0.id LIMIT 1) ub ON TRUE
      WHERE ${LL('op.landlord_id')} AND ${landlordIncomeSql('op')}
        AND op.settled_at IS NOT NULL
        AND ${NEAR('r.created_at')}`,
    // ... but a later row whose loss is a paid-ahead spend the dispute undid
    // never counted that spend under Money received (it counted the day the
    // money arrived). Undoing the spend gives it back to the credit (the
    // ledger trigger), and the clawback below drains the credit whole — so the
    // spend comes off there, and its row's record is added back here, on the
    // day the spend was undone. The row's own money is untouched; what its
    // reopened row collects later is new money.
    `SELECT op.landlord_id, u.property_id, u.id, op.lease_id, op.id, op.due_date,
            ${localDay('cu.released_at', TZ('pr'))},
            'returned', ${categorySql('op', 'ub.utility_type', 'lf')}, NULL::text, cu.amount, TRUE, NULL::uuid
       FROM credit_uses cu
       JOIN payments op ON op.id = cu.payment_id
       LEFT JOIN leases pl ON pl.id = op.lease_id
       LEFT JOIN units u ON u.id = COALESCE(op.unit_id, pl.unit_id)
       LEFT JOIN properties pr ON pr.id = u.property_id
       LEFT JOIN lease_fees lf ON lf.id = op.lease_fee_id
       LEFT JOIN LATERAL (SELECT ub0.utility_type FROM utility_bills ub0
                           WHERE ub0.payment_id = op.id ORDER BY ub0.created_at, ub0.id LIMIT 1) ub ON TRUE
      WHERE ${LL('op.landlord_id')} AND ${landlordIncomeSql('op')}
        AND cu.status = 'reversed' AND cu.prepaid_credit_id IS NOT NULL
        AND op.settled_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = op.id)
        AND ${NEAR('cu.released_at')}`,
    // ... and the paid-ahead money a disputed charge had created, drained by
    // the clawback (it counted when it arrived): what was never spent, plus
    // every spend the dispute undid.
    `SELECT l.landlord_id, u.property_id, u.id, l.id, NULL::uuid, NULL::date,
            ${localDay('cu.applied_at', TZ('pr'))},
            'returned', NULL::text, NULL::text, -cu.amount, TRUE, NULL::uuid
       FROM credit_uses cu
       JOIN lease_prepaid_credits c ON c.id = cu.prepaid_credit_id
       -- Pass 2 (choice46b): where the money arrived, as its arrival line reads it.
       JOIN leases l ON l.id = COALESCE(c.received_lease_id, cu.lease_id)
       LEFT JOIN units u ON u.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE ${LL('l.landlord_id')}
        AND cu.payment_reversal_id IS NOT NULL AND cu.status = 'applied'
        AND c.voided_at IS NULL AND c.funded_by IS DISTINCT FROM 'reclassified'
        AND ${NEAR('cu.applied_at')}`,
    // A deposit shortfall the tenant paid after move-out, on the day it
    // arrived: "Deposit shortfall collected". It is split the way the
    // move-out split the shortfall — each swept bill's share carries that
    // bill's category, so rent swept at move-out and paid off later is lot rent
    // collected under both bases; the deductions' own part has no category.
    // Its rows are the gap row and any a dispute reopened from it: a row later
    // disputed stays in the month it settled, as every bill does.
    `SELECT gp.landlord_id, u.property_id, u.id, dr.lease_id, gp.id, gp.due_date,
            ${localDay('gp.settled_at', TZ('pr'))},
            'depositShortfall', sf.category, NULL::text, sf.amount, TRUE, dr.id
       FROM deposit_returns dr
       CROSS JOIN LATERAL ${gapChainSql('dr')} gc
       JOIN payments gp ON gp.id = gc.id
       LEFT JOIN leases l ON l.id = dr.lease_id
       LEFT JOIN units u ON u.id = COALESCE(gp.unit_id, l.unit_id)
       LEFT JOIN properties pr ON pr.id = u.property_id
       CROSS JOIN LATERAL ${shortfallSplitSql('dr', 'GREATEST(gp.amount, 0)')} sf
      WHERE ${LL('dr.landlord_id')} AND ${LL('gp.landlord_id')}
        AND gp.revenue_owner = 'landlord' AND gp.settled_at IS NOT NULL
        AND gp.status IN ('settled','returned')
        AND ${NEAR('gp.settled_at')}`,
    // ... and what a dispute or return took back from a paid shortfall,
    // negative on the reversal day, split the same way (a past month is never
    // rewritten). What the reopened row collects later is new money above.
    `SELECT gp.landlord_id, u.property_id, u.id, dr.lease_id, gp.id, gp.due_date,
            ${localDay('r.created_at', TZ('pr'))},
            'returned', sf.category, NULL::text, -sf.amount, TRUE, dr.id
       FROM deposit_returns dr
       CROSS JOIN LATERAL ${gapChainSql('dr')} gc
       JOIN payments gp ON gp.id = gc.id
       JOIN payment_reversals r ON r.payment_id = gp.id
       LEFT JOIN leases l ON l.id = dr.lease_id
       LEFT JOIN units u ON u.id = COALESCE(gp.unit_id, l.unit_id)
       LEFT JOIN properties pr ON pr.id = u.property_id
       CROSS JOIN LATERAL ${shortfallSplitSql('dr', 'r.reversed_amount')} sf
      WHERE ${LL('dr.landlord_id')} AND ${LL('gp.landlord_id')}
        AND gp.revenue_owner = 'landlord' AND gp.settled_at IS NOT NULL
        AND ${NEAR('r.created_at')}`,
    // Beside: a deposit shortfall payment still clearing, on the day it was
    // sent, split the same way — the swept rent's share is rent still
    // clearing — so Money received shows the same clearing figure Money billed
    // does. A shortfall row is a move-out row, never a bill of rx_pay, and no
    // credit can sit on it (creditEligibleRowSql), so all of it is in flight.
    `SELECT gp.landlord_id, u.property_id, u.id, dr.lease_id, gp.id, gp.due_date,
            ${localDay('COALESCE(gp.processed_at, gp.created_at)', TZ('pr'))},
            'clearing', sf.category, NULL::text, sf.amount, FALSE, dr.id
       FROM deposit_returns dr
       CROSS JOIN LATERAL ${gapChainSql('dr')} gc
       JOIN payments gp ON gp.id = gc.id
       LEFT JOIN leases l ON l.id = dr.lease_id
       LEFT JOIN units u ON u.id = COALESCE(gp.unit_id, l.unit_id)
       LEFT JOIN properties pr ON pr.id = u.property_id
       CROSS JOIN LATERAL ${shortfallSplitSql('dr', 'GREATEST(gp.amount, 0)')} sf
      WHERE ${LL('dr.landlord_id')} AND ${LL('gp.landlord_id')}
        AND gp.revenue_owner = 'landlord' AND gp.status = 'processing'
        AND ${NEAR('COALESCE(gp.processed_at, gp.created_at)')}`,
  ]
}

// ── Money billed ──

/**
 * What became of one bill (a bx_pay row, alias `b`) as of today, as a VALUES
 * list of (part, amount):
 *   its own money: paid / clearing / kept from the deposit / still owed, less
 *     what a dispute or return took back (a reversed paid-ahead use comes off
 *     "covered by money paid ahead" instead) and less a swept bill's share of
 *     a move-out shortfall (gapPartSplitSql splits that share);
 *   covered by money paid ahead; covered by deposit interest.
 * The landlord-issued part has no part ("Credits given" takes it back off).
 * The bill's own branch and a shortened stay's take-back (stayShortenedCtes)
 * both read it, so the two can never describe the same bill differently.
 */
function ownBilledPartsSql(b: string): string {
  const x = a(b)
  return `(VALUES
           (CASE WHEN ${x}.status = 'settled' THEN 'paid'
                 WHEN ${x}.status = 'returned' AND (${x}.rv_n > 0 OR ${x}.settled_at IS NOT NULL) THEN 'paid'
                 WHEN ${x}.status = 'processing' THEN 'clearing'
                 WHEN ${x}.status = 'paid_via_deposit' THEN 'keptFromDeposit'
                 -- Only pending/failed reach here: a voided charge never does
                 -- (payCte leaves it out — decisions #48.5).
                 ELSE 'stillOwed' END,
            (${x}.amt - ${x}.iss - ${x}.hiss - ${x}.pa - ${x}.hpa - ${x}.di - ${x}.hdi - ${x}.short)
              - CASE WHEN ${x}.rv_n > 0 THEN GREATEST(${x}.rv - ${x}.rvu, 0) ELSE 0 END),
           ('coveredByPaidAhead', ${x}.pa + ${x}.hpa - CASE WHEN ${x}.rv_n > 0 THEN ${x}.rvu ELSE 0 END),
           ('coveredByDepositInterest', ${x}.di + ${x}.hdi))`
}

/**
 * A booking's (alias `b`) short-stay tax rate, in percent, as the reports read
 * it. A stay booked on the public page is quoted with the property's short-stay
 * tax already in it (priceStay: stays under 30 nights are taxed), and
 * its deposit is a share of that taxed total, so its pre-tax share is the
 * deposit over (1 + rate). decisions #33: the stay is taxed by the length it
 * was SOLD for (registerStay soldCheckOutSql: the booked check-out), never by
 * an early check-out — which changes occupancy only, so a deposit counted in a
 * past month is not rewritten by it (§0.0). The booking keeps no record of the
 * rate it was quoted at, so the property's current rate stands in for it.
 * `pr` is the booking's property.
 */
function stayTaxPctSql(b: string, pr: string): string {
  // 10/6 (Nic, shared priceStay), untaxed short of 30 nights:
  //  • the first month of a 30+ night stay booked online (untaxedMonthStaySql
  //    — the stay asked for is 30+ nights; firstStayMonth charges no tax);
  //  • a stay of exactly one calendar month (Feb 1 → Mar 1, 28 nights) only
  //    when the month's price won — its price is the monthly rate — and it was
  //    priced by the 10/6 rule (earlier ones were taxed, and past months'
  //    reports are never rewritten). The booking keeps no record of the tax it
  //    was charged; the current rate stands in, as above.
  const x = a(b)
  return `(CASE WHEN (${soldCheckOutSql(x)} - ${x}.check_in) < 30
                 AND NOT ${untaxedMonthStaySql(x)}
                 AND NOT ((${x}.check_in + INTERVAL '1 month')::date = ${soldCheckOutSql(x)}
                          AND ${x}.created_at >= DATE '2026-10-06'
                          AND ABS(COALESCE(${x}.total_amount, 0) - COALESCE(
                                (SELECT COALESCE(smu.monthly_rate, ${a(pr)}.monthly_rate) FROM units smu WHERE smu.id = ${x}.unit_id), -1)) < 0.005)
            THEN COALESCE(${a(pr)}.short_term_tax_rate, 0) ELSE 0 END)`
}

/**
 * 10/5 (Nic, M10/A5): the background check a register sale (alias `t`, a
 * pos_transactions row) carried — the fee recorded for it as the guest's
 * prepaid check, by the sale itself (the register, a schedule ticket) or by
 * the pay link it paid. GAM's screening money, never the landlord's income: by
 * card GAM keeps it, in cash GAM takes it back from their payout. A fee that
 * was not recorded (the stay already had one) stays the landlord's to give
 * back, and so stays in the sale.
 */
const saleScreeningSql = (t: string) => `COALESCE((SELECT SUM(ssp.amount) FROM screening_prepayments ssp
     WHERE ssp.status <> 'void' AND ssp.source_id IN (${t}.id, ${t}.pay_link_id)), 0)`

/** The background-check lines an unpaid pay link (alias `pl`) carries — not the landlord's to bill. */
const linkScreeningSql = (pl: string) => `COALESCE((SELECT SUM((sle->>'price')::numeric * COALESCE((sle->>'qty')::numeric, 1))
     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${pl}.items) = 'array' THEN ${pl}.items ELSE '[]'::jsonb END) sle
    WHERE sle->>'screening' = 'true' AND sle->>'id' IS NULL), 0)`

/**
 * The instant a reservation's money (alias `b`, a unit_bookings row) counted
 * as a stay under Money billed, or NULL when nothing was paid toward it: the
 * register sale or pay link that paid it (a sale through a one-time link is
 * billed on the day the link was sent, as that sale's own branch bills it),
 * else the booking-site deposit, else the stay paid whole. Reservation money
 * moved to credit is taken back off the reservation's own payments
 * (reservationPaymentsSql); this day is only for a reservation none of whose
 * payments the reports counted.
 */
function reservationCountedAtSql(b: string): string {
  const x = a(b)
  return `COALESCE(
      (SELECT CASE WHEN rlk.kind = 'one_time' THEN rlk.created_at ELSE rt.created_at END
         FROM pos_transactions rt LEFT JOIN pos_pay_links rlk ON rlk.id = rt.pay_link_id
        WHERE rt.id = ${x}.pos_transaction_id),
      ${x}.deposit_paid_at, ${x}.balance_paid_at)`
}

/**
 * The payments that counted a reservation (alias `b`, a unit_bookings row) as
 * a stay under Money billed, each with what it counted and the day it counted
 * on — exactly as their own branches count them (sharedBranches):
 *   the booking-site deposit: its own amount (siteDepositSql) at its pre-tax
 *     share, on the day it was paid;
 *   each register sale toward the reservation (the sale it names, a sale
 *     through a pay link or an open ticket for it): its net sale, on the day
 *     it was billed (a one-time link's day is the day it was sent).
 * A LATERAL subquery returning (at, k, day, amount): `at` and `k` order the
 * payments, newest first. Review of 10/3 (R5): a reservation can be paid in
 * two months — a $500 site deposit in August, a $40 link in September — so
 * reservation money moved to credit is taken back off these payments, newest
 * first, each in its own month (reservationBackCtes), never all of it off one
 * of them.
 */
function reservationPaymentsSql(b: string): string {
  const x = a(b)
  return `(
      SELECT ${x}.deposit_paid_at AS at, ${x}.id::text AS k,
             ${localDay(`${x}.deposit_paid_at`, `COALESCE(rpr.timezone, 'America/Phoenix')`)} AS day,
             ROUND(${siteDepositSql(x)} * 100 / (100 + ${stayTaxPctSql(x, 'rpr')}), 2) AS amount
        FROM units rpu
        LEFT JOIN properties rpr ON rpr.id = rpu.property_id
       WHERE rpu.id = ${x}.unit_id AND ${x}.deposit_paid_at IS NOT NULL AND ${x}.deposit_amount > 0
         AND EXISTS (SELECT 1 FROM held_payout_items rph
                      WHERE rph.source_type = 'booking_deposit' AND rph.source_id = ${x}.id::text)
      UNION ALL
      SELECT rps.at, rpt.id::text, ${localDay('rps.at', `COALESCE(rpp.timezone, 'America/Phoenix')`)},
             rpt.subtotal - rpt.discount_amount - ${saleScreeningSql('rpt')}
        FROM pos_transactions rpt
        LEFT JOIN pos_pay_links rpl ON rpl.id = rpt.pay_link_id
        LEFT JOIN properties rpp ON rpp.id = rpt.property_id
        CROSS JOIN LATERAL (SELECT CASE WHEN rpl.kind = 'one_time' THEN rpl.created_at ELSE rpt.created_at END AS at) rps
       WHERE rpt.landlord_id = ${x}.landlord_id
         AND rpt.status <> 'voided' AND rpt.payment_method <> 'charge'
         AND (rpt.id = ${x}.pos_transaction_id
              OR rpl.booking_id = ${x}.id
              OR EXISTS (SELECT 1 FROM pos_open_tickets rpo WHERE rpo.id = rpt.open_ticket_id AND rpo.booking_id = ${x}.id)))`
}

/**
 * Where the money a shortened stay moved to credit came from, as CTEs to put
 * in a WITH list (they read only `ll`, the landlord filter). Review of 10/3:
 * bankShortenedStayOverpayment banks everything the guest paid past the
 * shorter stay — every settled rent bill on the lease AND the reservation paid
 * before the lease (RESERVATION_PAID_SQL) — and anchors the credit to the
 * latest rent bill, so taking all of it off that one bill read a reservation
 * lease whose guest left two days in as Lot/space rent −$538.71 (collected so
 * far −$538.71) and its stay as $600.
 *
 * Each live shortened-stay credit is taken off where its own money came from,
 * each source no further than what it shows:
 *   1. its anchor bill first. Every anchor bill takes the credits anchored to
 *      it (capped at what it shows) before anything else, so a credit only
 *      ever moves its own bill's month — a re-made credit with no anchor
 *      (billLongerStay) uses the anchor of the withdrawn credit it replaced:
 *      the one withdrawn in the same transaction it was made in (voided_at =
 *      its created_at) with the received day it carried over, followed back
 *      through every re-making to the credit that had an anchor. Only that
 *      one: a fresh credit from a later shortening never takes the anchor of
 *      a credit withdrawn earlier on the lease (fix pass 1 of 10/4: a
 *      November correction read October $775 / November $279 for $930 /
 *      $124, rewriting October). Review of 10/4: the
 *      credits were pooled and taken off the newest anchor first, so a second
 *      shortening's credit on November pulled October's take-back onto
 *      November (October $1,259 / November $0 for $980 / $279), and making it
 *      rewrote October, a past month (§0.0).
 *   2. what its anchor bill could not take, and a credit with no anchor at
 *      all: the lease's rent bills money once paid (settled, paid from the
 *      deposit, or settled and later returned) due on or before the credit's
 *      own bound, newest first, each with what step 1 left of it. The bound
 *      is the anchor's due date; with no anchor, the newest bill whose rent
 *      money had settled by the day the credit's money was received and was
 *      still there when the credit was banked (bankOverpayment counts only
 *      settled and paid-from-deposit rent, and dates the credit by the newest
 *      such row, the one it could not anchor to) — nothing at all when no
 *      rent money had stayed, as then the money was the reservation's. A row
 *      returned or disputed before the credit was banked is not rent money
 *      the credit holds (fix pass 1 of 10/4: November rent disputed in full
 *      read "Stay shortened" −$44.87 for reservation money). Credits are
 *      served newest bound first, so a later bill
 *      a newer credit's money came from is never handed to an older credit,
 *      and an older credit never moves onto a bill due after its own;
 *   3. the reservation: at most what was paid toward it less the leftover
 *      already moved to credit at move-in (movedToCreditSql);
 *   4. anything still left (data no source explains: a lease whose
 *      reservation is not linked) is reservation money too, so rent is never
 *      taken below what it shows.
 * A bill is its original row plus every row a dispute or bank return reopened
 * from it (payments.reversal_id → the reversal of the row before; a reopened
 * row keeps the original's due date). Within a bill the money comes off what
 * became of it, in this order:
 *   still owed — after a dispute the reopened row asks for the money again,
 *     and the tenant holds the credit against it;
 *   paid, then kept from the deposit — the ordinary case;
 *   covered by money paid ahead that was rent money, then by deposit interest;
 *   covered by money paid ahead that was (partly) reservation money: a
 *     shortened stay's credit (its reservation share), then a reservation
 *     deposit's leftover — so reservation money comes back last, as it does
 *     across the lease (step 3 after the bills);
 *   still clearing, last — only while a payment for a reopened row is in
 *     flight and nothing else is left.
 * So the parts still add up to the total and "Collected so far" never goes
 * below zero or past what was billed. Review of 10/3 (P1): November's $460
 * card rent, shortened by $300, then disputed in full, reads $160 still owed
 * and nothing collected — never "Collected so far −$300".
 *
 * Reservation money that comes back through a bill is still reservation money.
 * Review of 10/3 (R6): a $600 site deposit left $410 after the arrival rent;
 * that $410 and $540 of cash paid October's $950, and the guest left Oct 5,
 * banking $827.42 — $540 of the cash and $287.42 of the leftover. Money billed
 * still takes all $827.42 off October's rent (the bill showed it), but the
 * lease's reservation share (tk_share) counts the $287.42, so at move-out the
 * reports hand it back off the stay (never off the rent card), and the PM owner
 * statement keeps it out of its billed block (tk_res_back) and adds it back.
 *
 * CTEs (each built on the ones before):
 *   tk_credit  live shortened-stay credits, with their (effective) anchor
 *   tk_pay     payCte's figures for every rent row of those leases (any due
 *              date: the window does not decide where the money came from)
 *   tk_grp     each row's bill (root_id: the original row)
 *   tk_bill    what each bill shows, part by part (ownBilledPartsSql)
 *   tk_billcap each bill: its lease, due date, what it shows in all (cap),
 *              when money first paid it (paid_at; paid_once), whether it
 *              anchors a credit
 *   tk_cover   each bill's "covered by money paid ahead", split by where the
 *              money came from: a reservation deposit's leftover (a1), a
 *              shortened stay's credit (a2), and the rest (rent money)
 *   tk_res     each lease's reservation money (cap) and when it counted
 *   tk_kc      each credit's anchor bill (anchor_root) and bound (step 2)
 *   tk_p1      step 1: per anchor bill, what its credits want and what it
 *              gives (no more than its cap)
 *   tk_src     steps 2–3's sources in order, newest first, with what step 1
 *              left of each (cap) and the running total (c_end)
 *   tk_dem     step 2's demands — each anchor bill's overflow and each credit
 *              with no anchor — newest bound first, with the running total
 *              (o_end) and where its sources start in the running total
 *              (s_start: everything due after its bound comes before it)
 *   tk_fill    each demand's stretch of the running total, [f_start, e_end):
 *              it starts where the demands before it stopped, or at its own
 *              start if that is later (e_end = o_end + the running max of
 *              s_start − what the demands before it asked)
 *   tk_total   each lease's total take-back (x)
 *   tk_slice   what each source gives (step 1 + steps 2–3)
 *   tk_part    a bill's slice, split by part (and, for money paid ahead, by
 *              where it came from: src)
 *   tk_rest    per demand, what no source covered (step 4)
 *   tk_share   per lease: credited (x), the reservation money in it and its
 *              share — what reservationPartOfUseSql reads
 *   tk_res_back per bill: the reservation money its take-back moved back to
 *              credit (the PM owner statement's reservationCover)
 */
export function stayShortenedCtes(ll: (col: string) => string = LL): string {
  return `
  tk_credit AS (
    SELECT c.id, c.lease_id, c.amount_original AS amt, c.created_at, c.received_at,
           l.landlord_id, u.property_id, u.id AS unit_id, ${TZ('pr')} AS tz,
           COALESCE(c.source_payment_id, rm.src) AS anchor_id,
           COALESCE(rm.banked_at, c.created_at) AS banked_at
      FROM lease_prepaid_credits c
      JOIN leases l ON l.id = c.lease_id
      LEFT JOIN units u ON u.id = l.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
      -- A credit billLongerStay re-made: the credit it replaced was withdrawn
      -- in the same transaction (voided_at = the re-made one's created_at)
      -- and handed on its received day (received_at, or created_at when it
      -- had none). That day went through a JS Date on the way, which keeps
      -- whole milliseconds only, so created_at is cut to milliseconds before
      -- it is compared. Followed back through every re-making: src is the first
      -- anchor on the way, banked_at when the first credit was made.
      LEFT JOIN LATERAL (
        WITH RECURSIVE tk_rm(id, created_at, received_at, src, depth) AS (
          SELECT c.id, c.created_at, c.received_at, c.source_payment_id, 0
          UNION ALL
          SELECT v.id, v.created_at, v.received_at, v.source_payment_id, rmp.depth + 1
            FROM tk_rm rmp
            JOIN lease_prepaid_credits v
              ON v.lease_id = c.lease_id AND v.id <> rmp.id
             AND v.voided_at = rmp.created_at
             AND COALESCE(v.received_at, date_trunc('milliseconds', v.created_at)) = rmp.received_at
             AND ${stayShortenedCreditSql('v')}
           WHERE rmp.src IS NULL AND rmp.depth < 20)
        SELECT (SELECT r.src FROM tk_rm r WHERE r.src IS NOT NULL ORDER BY r.depth, r.id LIMIT 1) AS src,
               (SELECT r.created_at FROM tk_rm r ORDER BY r.depth DESC, r.id LIMIT 1) AS banked_at) rm ON TRUE
     WHERE ${ll('l.landlord_id')} AND c.voided_at IS NULL AND ${stayShortenedCreditSql('c')}),
  tk_pay AS (${payCte(`p.type = 'rent' AND p.work_trade_suspended_at IS NULL
     AND p.lease_id IN (SELECT tkc.lease_id FROM tk_credit tkc)`, ll)}),
  tk_grp AS (
    SELECT r.id AS root_id, ch.id
      FROM tk_pay r
      CROSS JOIN LATERAL (
        WITH RECURSIVE tkch(id) AS (
          SELECT r.id
          UNION ALL
          SELECT rp.id FROM tkch
            JOIN payment_reversals tr ON tr.payment_id = tkch.id
            JOIN payments rp ON rp.reversal_id = tr.id)
        SELECT id FROM tkch) ch
     WHERE r.reversal_id IS NULL),
  tk_bill AS (
    SELECT g.root_id, v.part, SUM(v.amount) AS amount
      FROM tk_grp g
      JOIN tk_pay t ON t.id = g.id
      CROSS JOIN LATERAL ${ownBilledPartsSql('t')} AS v(part, amount)
     GROUP BY g.root_id, v.part),
  tk_billcap AS (
    SELECT r.id AS root_id, r.lease_id, r.landlord_id, r.property_id, r.unit_id, r.due_date, r.created_at, r.status,
           COALESCE((SELECT SUM(GREATEST(tb.amount, 0)) FROM tk_bill tb WHERE tb.root_id = r.id), 0) AS cap,
           pd.paid_at, (pd.paid_at IS NOT NULL) AS paid_once,
           EXISTS (SELECT 1 FROM tk_credit k JOIN tk_grp g ON g.id = k.anchor_id WHERE g.root_id = r.id) AS anchor
      FROM tk_pay r
      CROSS JOIN LATERAL (
        SELECT MIN(t.settled_at) AS paid_at
          FROM tk_grp g JOIN tk_pay t ON t.id = g.id
         WHERE g.root_id = r.id AND t.settled_at IS NOT NULL
           AND t.status IN ('settled','paid_via_deposit','returned')) pd
     WHERE r.reversal_id IS NULL),
  -- What paid ahead money covered on each bill (cpa, as the bill shows it),
  -- split by where it came from: a1 a reservation deposit's leftover (all
  -- reservation money), a2 a shortened stay's credit (its lease's reservation
  -- share is reservation money: tk_share), and the rest rent money paid ahead.
  -- The same uses the PM owner statement reads (spent or set aside). A credit
  -- in use is never withdrawn (billLongerStay bills the nights instead) and
  -- paid-ahead money only pays its own lease, so every a2 credit is one of
  -- this lease's live credits (tk_credit).
  tk_cover AS (
    SELECT x.root_id, x.cpa, LEAST(x.r1, x.cpa) AS a1, LEAST(x.r2, x.cpa - LEAST(x.r1, x.cpa)) AS a2
      FROM (
        SELECT bc.root_id,
               GREATEST(COALESCE((SELECT tb.amount FROM tk_bill tb
                                   WHERE tb.root_id = bc.root_id AND tb.part = 'coveredByPaidAhead'), 0), 0) AS cpa,
               COALESCE(rv.r1, 0) AS r1, COALESCE(rv.r2, 0) AS r2
          FROM tk_billcap bc
          LEFT JOIN LATERAL (
            SELECT SUM(cu.amount) FILTER (WHERE ${movedToCreditSql('rc')}) AS r1,
                   SUM(cu.amount) FILTER (WHERE ${stayShortenedCreditSql('rc')}) AS r2
              FROM tk_grp g
              JOIN credit_uses cu ON cu.payment_id = g.id AND cu.status IN ('applied','held')
              JOIN lease_prepaid_credits rc ON rc.id = cu.prepaid_credit_id AND rc.funded_by = 'reclassified'
             WHERE g.root_id = bc.root_id) rv ON TRUE) x),
  tk_res AS (
    SELECT l.id AS lease_id, l.landlord_id, u.property_id, u.id AS unit_id, ${TZ('pr')} AS tz,
           ${reservationCountedAtSql('b')} AS counted_at,
           GREATEST(COALESCE(CASE WHEN l.is_existing_tenancy OR l.supersedes_lease_id IS NOT NULL THEN 0
                                  ELSE ${RESERVATION_PAID_SQL} END, 0)
                    - COALESCE((SELECT SUM(m.amount_original) FROM lease_prepaid_credits m
                                 WHERE m.lease_id = l.id AND m.voided_at IS NULL AND ${movedToCreditSql('m')}), 0),
                    0) AS cap
      FROM leases l
      LEFT JOIN unit_bookings b ON b.id = l.source_booking_id
      LEFT JOIN units u ON u.id = l.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
     WHERE l.id IN (SELECT tkc.lease_id FROM tk_credit tkc)),
  -- Each credit's anchor bill and its bound (step 2): the anchor's due date;
  -- with no anchor, the newest bill whose rent money had settled by the day
  -- the credit's money was received and was still there when the credit was
  -- banked (what bankOverpayment counted: settled or paid from the deposit,
  -- or returned only after the banking); NULL (no bill at all) when none.
  -- The credit's received_at was copied from the anchor bill's settled_at
  -- through a JS Date, which keeps whole milliseconds only, so settled_at is
  -- cut to milliseconds before the compare (else the bill the money came
  -- from settles a fraction of a millisecond "after" and drops out).
  tk_kc AS (
    SELECT k.id, k.lease_id, k.landlord_id, k.property_id, k.unit_id, k.tz, k.created_at, k.amt,
           abc.root_id AS anchor_root, abc.due_date AS anchor_due,
           CASE WHEN abc.root_id IS NOT NULL THEN abc.due_date
                ELSE (SELECT MAX(pb.due_date) FROM tk_billcap pb
                       WHERE pb.lease_id = k.lease_id
                         AND EXISTS (
                           SELECT 1 FROM tk_grp kg JOIN tk_pay kt ON kt.id = kg.id
                            WHERE kg.root_id = pb.root_id AND kt.settled_at IS NOT NULL
                              AND date_trunc('milliseconds', kt.settled_at) <= COALESCE(k.received_at, k.created_at)
                              AND (kt.status IN ('settled','paid_via_deposit')
                                   OR (kt.status = 'returned' AND EXISTS (
                                         SELECT 1 FROM payment_reversals kr
                                          WHERE kr.payment_id = kt.id AND kr.created_at > k.banked_at))))) END AS bound
      FROM tk_credit k
      LEFT JOIN tk_grp ag ON ag.id = k.anchor_id
      LEFT JOIN tk_billcap abc ON abc.root_id = ag.root_id),
  -- Step 1: every anchor bill takes its own credits first, no further than it shows.
  tk_p1 AS (
    SELECT kc.anchor_root AS root_id, kc.lease_id, SUM(kc.amt) AS want, LEAST(SUM(kc.amt), MAX(bc.cap)) AS amount
      FROM tk_kc kc
      JOIN tk_billcap bc ON bc.root_id = kc.anchor_root
     GROUP BY kc.anchor_root, kc.lease_id),
  -- Steps 2–3's sources, newest first: the bills money once paid (or that
  -- anchor a credit) with what step 1 left of them, then the reservation.
  tk_src AS (
    SELECT q.lease_id, q.kind, q.root_id, q.due_date, q.cap,
           SUM(q.cap) OVER (PARTITION BY q.lease_id ORDER BY q.ord ROWS UNBOUNDED PRECEDING) AS c_end
      FROM (
        SELECT bc.lease_id, 'bill'::text AS kind, bc.root_id, bc.due_date, bc.cap - COALESCE(p1.amount, 0) AS cap,
               ROW_NUMBER() OVER (PARTITION BY bc.lease_id
                                  ORDER BY bc.due_date DESC, bc.created_at DESC, bc.root_id DESC) AS ord
          FROM tk_billcap bc
          LEFT JOIN tk_p1 p1 ON p1.root_id = bc.root_id
         WHERE bc.cap - COALESCE(p1.amount, 0) > 0 AND (bc.paid_once OR bc.anchor)
        UNION ALL
        SELECT rs.lease_id, 'reservation', NULL::uuid, NULL::date, rs.cap, 9223372036854775807
          FROM tk_res rs WHERE rs.cap > 0) q),
  -- Step 2's demands, newest bound first: what each anchor bill could not
  -- take, and each credit with no anchor. A demand may use only the sources
  -- due on or before its bound (and the reservation): they start at s_start
  -- in the running total, after everything due later.
  tk_dem AS (
    SELECT d.lease_id, d.anchor_root, d.credit_id, d.bound, d.amount,
           SUM(d.amount) OVER (PARTITION BY d.lease_id ORDER BY d.bound DESC NULLS LAST, d.anchor_root, d.credit_id
                               ROWS UNBOUNDED PRECEDING) AS o_end,
           COALESCE((SELECT SUM(s.cap) FROM tk_src s
                      WHERE s.lease_id = d.lease_id AND s.kind = 'bill'
                        AND (d.bound IS NULL OR s.due_date > d.bound)), 0) AS s_start
      FROM (
        SELECT p1.lease_id, p1.root_id AS anchor_root, NULL::uuid AS credit_id, bc.due_date AS bound,
               p1.want - p1.amount AS amount
          FROM tk_p1 p1
          JOIN tk_billcap bc ON bc.root_id = p1.root_id
         WHERE p1.want - p1.amount > 0
        UNION ALL
        SELECT kc.lease_id, NULL::uuid, kc.id, kc.bound, kc.amt
          FROM tk_kc kc
         WHERE kc.anchor_root IS NULL AND kc.amt > 0) d),
  -- Each demand fills [f_start, e_end) of the running total: from where the
  -- demands before it stopped, or from its own s_start if that is later.
  tk_fill AS (
    SELECT f.*, f.e_end - f.amount AS f_start
      FROM (
        SELECT d.*,
               d.o_end + MAX(d.s_start - (d.o_end - d.amount))
                           OVER (PARTITION BY d.lease_id ORDER BY d.bound DESC NULLS LAST, d.anchor_root, d.credit_id
                                 ROWS UNBOUNDED PRECEDING) AS e_end
          FROM tk_dem d) f),
  tk_total AS (
    SELECT lease_id, SUM(amt) AS x FROM tk_credit GROUP BY lease_id),
  tk_slice AS (
    SELECT z.lease_id, z.kind, z.root_id, SUM(z.amount) AS amount
      FROM (
        SELECT p1.lease_id, 'bill'::text AS kind, p1.root_id, p1.amount FROM tk_p1 p1
        UNION ALL
        SELECT s.lease_id, s.kind, s.root_id,
               GREATEST(LEAST(s.c_end, f.e_end) - GREATEST(s.c_end - s.cap, f.f_start), 0)
          FROM tk_src s
          JOIN tk_fill f ON f.lease_id = s.lease_id) z
     GROUP BY z.lease_id, z.kind, z.root_id),
  tk_part AS (
    SELECT q.root_id, q.part, q.src,
           LEAST(q.avail, GREATEST(q.slice - (SUM(q.avail) OVER (PARTITION BY q.root_id ORDER BY q.ord) - q.avail), 0)) AS amount
      FROM (
        SELECT s.root_id, s.amount AS slice, o.part, o.src, o.ord,
               CASE o.src WHEN 'paidAhead'   THEN cv.cpa - cv.a1 - cv.a2
                          WHEN 'shortened'   THEN cv.a2
                          WHEN 'reservation' THEN cv.a1
                          ELSE GREATEST(COALESCE(tb.amount, 0), 0) END AS avail
          FROM tk_slice s
          JOIN tk_cover cv ON cv.root_id = s.root_id
          CROSS JOIN (VALUES ('stillOwed', 'bill', 1), ('paid', 'bill', 2), ('keptFromDeposit', 'bill', 3),
                             ('coveredByPaidAhead', 'paidAhead', 4), ('coveredByDepositInterest', 'bill', 5),
                             ('coveredByPaidAhead', 'shortened', 6), ('coveredByPaidAhead', 'reservation', 7),
                             ('clearing', 'bill', 8)) AS o(part, src, ord)
          LEFT JOIN tk_bill tb ON tb.root_id = s.root_id AND tb.part = o.part
         WHERE s.kind = 'bill' AND s.amount > 0) q),
  -- Step 4, per demand: what is past the end of every source. It is dated
  -- like its credit (an anchor bill's demand: its newest credit).
  tk_rest AS (
    SELECT k.id, f.lease_id, k.landlord_id, k.property_id, k.unit_id, k.tz, k.created_at, k.anchor_due,
           GREATEST(f.e_end - GREATEST(COALESCE(cp.total, 0), f.f_start), 0) AS amount
      FROM tk_fill f
      CROSS JOIN LATERAL (
        SELECT kc.* FROM tk_kc kc
         WHERE kc.lease_id = f.lease_id
           AND (kc.id = f.credit_id OR (f.credit_id IS NULL AND kc.anchor_root = f.anchor_root))
         ORDER BY kc.created_at DESC, kc.id DESC LIMIT 1) k
      LEFT JOIN (SELECT lease_id, SUM(cap) AS total FROM tk_src GROUP BY lease_id) cp ON cp.lease_id = f.lease_id),
  -- The reservation money in a lease's shortened-stay credits (x): the
  -- reservation (step 3), what no source explains (step 4), what came back off
  -- a bill a reservation deposit's leftover had paid (a1), and the share of
  -- what came back off a bill one of these credits had paid (a2: u). The a2
  -- money is the credits' own, carrying the same share, so the share is
  --   (res + share * u) / x   =>   share = res / (x - u)
  -- (with x - u = 0 nothing but a2 came back, and nothing says it was the
  -- reservation's). reservation = share * x.
  tk_share AS (
    SELECT t.lease_id, t.x AS credited, sh.share * t.x AS reservation, sh.share
      FROM tk_total t
      CROSS JOIN LATERAL (
        SELECT COALESCE((SELECT SUM(s.amount) FROM tk_slice s WHERE s.lease_id = t.lease_id AND s.kind = 'reservation'), 0)
               + COALESCE((SELECT SUM(r.amount) FROM tk_rest r WHERE r.lease_id = t.lease_id), 0)
               + COALESCE((SELECT SUM(p.amount) FROM tk_part p JOIN tk_billcap pb ON pb.root_id = p.root_id
                            WHERE pb.lease_id = t.lease_id AND p.src = 'reservation'), 0) AS res,
               COALESCE((SELECT SUM(p.amount) FROM tk_part p JOIN tk_billcap pb ON pb.root_id = p.root_id
                          WHERE pb.lease_id = t.lease_id AND p.src = 'shortened'), 0) AS u) z
      CROSS JOIN LATERAL (
        SELECT CASE WHEN t.x - z.u > 0 THEN LEAST(GREATEST(z.res, 0) / (t.x - z.u), 1) ELSE 0 END AS share) sh),
  tk_res_back AS (
    SELECT bc.root_id, bc.lease_id, bc.landlord_id, bc.property_id, bc.due_date,
           COALESCE(SUM(p.amount) FILTER (WHERE p.src = 'reservation'), 0)
           + ROUND(COALESCE(SUM(p.amount) FILTER (WHERE p.src = 'shortened'), 0) * COALESCE(MAX(sh.share), 0), 2) AS amount
      FROM tk_part p
      JOIN tk_billcap bc ON bc.root_id = p.root_id
      LEFT JOIN tk_share sh ON sh.lease_id = bc.lease_id
     WHERE p.src IN ('reservation', 'shortened') AND p.amount > 0
     GROUP BY bc.root_id, bc.lease_id, bc.landlord_id, bc.property_id, bc.due_date)`
}

/**
 * Reservation money moved to credit, taken back off the reservation's own
 * payments (Money billed only), as CTEs to put in a WITH list after
 * stayShortenedCtes (they read tk_slice, tk_res and tk_rest, and `ll`).
 *
 * A lease's reservation money moved to credit is: a reservation deposit's
 * leftover after the arrival rent (movedToCreditSql), the reservation's part
 * of its shortened stays' credits (step 3), and what no source explains
 * (step 4). It already counted, as a stay, on the days the reservation's
 * payments counted (reservationPaymentsSql), so it comes back off them, newest
 * first, each no further than what it counted and on its own day — the oldest
 * takes whatever is left, so the lease always nets to the cent. Review of 10/3
 * (R5): a $500 site deposit Aug 20 and a $40 link sent Sep 5; the arrival rent
 * used $95 and $445 was left over: September reads $40 − $40 = $0 and August
 * $500 − $405 = $95, never September −$405. A reservation none of whose
 * payments the reports counted takes each piece back on the day it has always
 * used (reservationCountedAtSql, else the credit's own day).
 *
 *   rb_piece  each piece of reservation money moved to credit, with that day
 *   rb_lease  per lease, all of it (total)
 *   rb_pay    the reservation's counted payments, per lease
 *   rb_alloc  what comes off each payment, newest first
 */
function reservationBackCtes(): string {
  return `
  rb_piece AS (
    SELECT l.id AS lease_id, l.landlord_id, u.property_id, u.id AS unit_id, c.amount_original AS amount,
           ${localDay(`COALESCE(${reservationCountedAtSql('b')}, c.received_at, c.created_at)`, TZ('pr'))} AS day
      FROM lease_prepaid_credits c
      JOIN leases l ON l.id = c.lease_id
      LEFT JOIN unit_bookings b ON b.id = l.source_booking_id
      LEFT JOIN units u ON u.id = l.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
     WHERE ${LL('l.landlord_id')} AND c.voided_at IS NULL AND ${movedToCreditSql('c')}
    UNION ALL
    SELECT rs.lease_id, rs.landlord_id, rs.property_id, rs.unit_id, s.amount, ${localDay('rs.counted_at', 'rs.tz')}
      FROM tk_slice s
      JOIN tk_res rs ON rs.lease_id = s.lease_id
     WHERE s.kind = 'reservation' AND s.amount > 0
    UNION ALL
    SELECT r.lease_id, r.landlord_id, r.property_id, r.unit_id, r.amount,
           COALESCE(${localDay('rs.counted_at', 'rs.tz')}, r.anchor_due, ${localDay('r.created_at', 'r.tz')})
      FROM tk_rest r
      LEFT JOIN tk_res rs ON rs.lease_id = r.lease_id
     WHERE r.amount > 0),
  rb_lease AS (
    SELECT lease_id, MIN(landlord_id::text)::uuid AS landlord_id, MIN(property_id::text)::uuid AS property_id,
           MIN(unit_id::text)::uuid AS unit_id, SUM(amount) AS total
      FROM rb_piece GROUP BY lease_id),
  rb_pay AS (
    SELECT rl.lease_id, x.at, x.k, x.day, x.amount
      FROM rb_lease rl
      JOIN leases l ON l.id = rl.lease_id
      JOIN unit_bookings b ON b.id = l.source_booking_id
      CROSS JOIN LATERAL ${reservationPaymentsSql('b')} x
     WHERE l.is_existing_tenancy IS NOT TRUE AND l.supersedes_lease_id IS NULL
       AND x.amount > 0),
  rb_alloc AS (
    SELECT q.lease_id, q.day,
           CASE WHEN q.n = q.cnt THEN GREATEST(q.total - q.before, 0)
                ELSE LEAST(q.amount, GREATEST(q.total - q.before, 0)) END AS amount
      FROM (
        SELECT rp.lease_id, rp.day, rp.amount, rl.total,
               ROW_NUMBER() OVER w AS n,
               COUNT(*) OVER (PARTITION BY rp.lease_id) AS cnt,
               SUM(rp.amount) OVER w - rp.amount AS before
          FROM rb_pay rp
          JOIN rb_lease rl ON rl.lease_id = rp.lease_id
        WINDOW w AS (PARTITION BY rp.lease_id ORDER BY rp.at DESC, rp.k DESC ROWS UNBOUNDED PRECEDING)) q)`
}

function billedBranches(): string[] {
  return [
    // Each bill in the month it was due, split into what became of it, as of
    // today. Credit set aside on it by a payment still clearing (held) counts
    // as the kind it will be when that payment lands, so "clearing" is only
    // the money in flight — the same figure Money received shows beside it:
    //   its own money: paid / clearing / kept from the deposit / still owed,
    //     less what a dispute or return took back (a reversed paid-ahead use
    //     comes off "covered by money paid ahead" instead);
    //   covered by money paid ahead; covered by deposit interest;
    //   the landlord-issued part, in the bill's own line with no part — the
    //     negative "Credits given" below takes it back off;
    //   a bill swept to a deposit: its share of the move-out's shortfall past
    //     the deductions, which the pool never covered, takes what became of
    //     the shortfall (still owed until the tenant pays it) instead of "kept".
    // A returned row is paid, less what its reversal took back. The legacy
    // admin return (POST /payments/:id/handle-return) writes no reversal
    // record, so a row it marked counts paid in full — as Money received
    // counts it on its settle day (SETTLED_ONCE) — never "still owed": nothing
    // can pay a returned row.
    `SELECT b.landlord_id, b.property_id, b.unit_id, b.lease_id, b.id, b.due_date, b.due_date,
            ${lineFromCategorySql('b.category')}, b.category, v.part, v.amount, TRUE, b.move_out_id
       FROM bx_pay b
       CROSS JOIN LATERAL (
         SELECT vv.part, vv.amount FROM ${ownBilledPartsSql('b')} AS vv(part, amount)
         UNION ALL
         SELECT NULL::text, b.iss + b.hiss
         UNION ALL
         SELECT gs.part, gs.amount FROM ${gapPartSplitSql('b.move_out_id', 'b.short', 'b.short')} gs
          WHERE b.move_out_id IS NOT NULL AND b.short <> 0
       ) AS v(part, amount)
      WHERE v.amount <> 0`,
    `SELECT landlord_id, property_id, unit_id, lease_id, id, due_date, due_date,
            'creditsGiven', category, NULL::text, -(iss + hiss), TRUE, move_out_id
       FROM bx_pay WHERE iss + hiss > 0`,
    // Money already paid and counted, moved to credit for a later bill:
    // negative, so that later bill (which counts it as "covered by money paid
    // ahead") is not billed twice.
    //   "Stay shortened", under Lot/space rent: what a shortened stay's credit
    //     took back off the rent bills it came out of (stayShortenedCtes), each
    //     on its own bill's due date and split by what became of that bill —
    //     so the parts still add up to the total, "Collected so far" stays
    //     between zero and what was billed, and the rent card nets it from the
    //     rent it came out of. It carries its bill's id, so a list of the
    //     charges behind a total (the monthly statement, Books' rent roll)
    //     nets it from that bill: the November rent shortened by $300 lists
    //     $160 billed and $160 collected, never $460.
    `SELECT bc.landlord_id, bc.property_id, bc.unit_id, bc.lease_id, bc.root_id, bc.due_date, bc.due_date,
            'stayShortened', 'space_rent', tp.part, -tp.amount, TRUE, NULL::uuid
       FROM tk_part tp
       JOIN tk_billcap bc ON bc.root_id = tp.root_id
      WHERE tp.amount > 0`,
    //   "Moved to credit", under the stay (STAY_MONEY_CATEGORY): reservation
    //     money — the part of a shortened stay's credit the reservation paid
    //     (and what no source explains), and a reservation deposit's leftover
    //     after the arrival rent — taken back off the reservation's own
    //     payments, newest first, each on the day it counted as a stay
    //     (reservationBackCtes), so the stay nets to what it was worth in the
    //     months it counted and no month reads negative. Paid: the reservation
    //     was paid.
    `SELECT rl.landlord_id, rl.property_id, rl.unit_id, rl.lease_id, NULL::uuid, NULL::date, ra.day,
            'movedToCredit', '${STAY_MONEY_CATEGORY}', 'paid', -ra.amount, TRUE, NULL::uuid
       FROM rb_alloc ra
       JOIN rb_lease rl ON rl.lease_id = ra.lease_id
      WHERE ra.amount > 0`,
    //     ... and a reservation none of whose payments the reports counted:
    //     each piece on its own day.
    `SELECT rp.landlord_id, rp.property_id, rp.unit_id, rp.lease_id, NULL::uuid, NULL::date, rp.day,
            'movedToCredit', '${STAY_MONEY_CATEGORY}', 'paid', -rp.amount, TRUE, NULL::uuid
       FROM rb_piece rp
      WHERE NOT EXISTS (SELECT 1 FROM rb_pay x WHERE x.lease_id = rp.lease_id)`,
    // Open one-time pay links: billed, still owed (by the day they were sent).
    // One per reservation — several links can be open on one booking (paying
    // one in full closes the rest), so only the newest counts — and never a
    // link already past its expiry.
    `SELECT pl.landlord_id, pl.property_id, NULL::uuid, NULL::uuid, NULL::uuid, NULL::date,
            ${localDay('pl.created_at', TZ('pr'))},
            'registerAndStays', 'stays_and_pay_links', 'stillOwed', (pl.subtotal - pl.discount_amount - ${linkScreeningSql('pl')}), TRUE, NULL::uuid
       FROM pos_pay_links pl
       LEFT JOIN properties pr ON pr.id = pl.property_id
      WHERE ${LL('pl.landlord_id')} AND pl.kind = 'one_time' AND pl.status = 'open'
        AND (pl.expires_at IS NULL OR pl.expires_at > now())
        -- 10/5 (M10): a link for nothing but a background check bills the landlord nothing.
        AND (pl.subtotal - pl.discount_amount - ${linkScreeningSql('pl')}) > 0
        AND NOT EXISTS (
              SELECT 1 FROM pos_pay_links nl
               WHERE pl.booking_id IS NOT NULL AND nl.booking_id = pl.booking_id AND nl.id <> pl.id
                 AND nl.kind = 'one_time' AND nl.status = 'open'
                 AND (nl.expires_at IS NULL OR nl.expires_at > now())
                 AND (nl.created_at, nl.id) > (pl.created_at, pl.id))
        AND ${NEAR('pl.created_at')}`,
  ]
}

// ── Both bases ──

/**
 * SQL (a LATERAL subquery), on a held_payout_items alias: the property (and its
 * time zone, for the day) of a rent dispute's fee line ('stripe_fee_kept:…',
 * paymentReversal.disputeFeeLineSql), read from the disputed charge (the
 * intent is the source id's second part): this landlord's remittance first;
 * else this landlord's rows that remittance paid (a household payment split
 * across two landlords is one remittance under the first); else this
 * landlord's rows that carry the intent themselves (a charge with no
 * remittance — paymentReversal's single-row path); else (choice46e fix pass
 * 2) the bills this landlord's money paid ahead from that charge paid; else
 * the lease that money arrived on; else, last, the landlord's first property —
 * so the line is never dropped from the owner statement it is on the payout
 * of. Fix pass 2: one charge can
 * cover this landlord's rows at two properties, so within a step the property
 * with the largest share of the charge wins, then the lowest property id — the
 * same property (and day) on every read. Shared by Money received (its
 * chargeback-fee line) and the owner statement (the payout line it carries),
 * so both put the fee at the same property on the same day.
 */
export function disputeFeePropertySql(h: string): string {
  a(h)
  return `(
         SELECT x.property_id, x.tz FROM (
           SELECT 1 AS pick, u.property_id, pr.timezone AS tz, tr.amount AS share
             FROM tenant_remittances tr
             JOIN leases l ON l.id = tr.lease_id
             JOIN units u ON u.id = l.unit_id
             LEFT JOIN properties pr ON pr.id = u.property_id
            WHERE ${disputeFeeLineSql(h)}
              AND tr.stripe_payment_intent_id = split_part(${h}.source_id, ':', 2)
              AND tr.landlord_id = ${h}.landlord_id
           UNION ALL
           SELECT 2, u.property_id, pr.timezone, SUM(ra.amount_applied)
             FROM tenant_remittances tr
             JOIN remittance_applications ra ON ra.remittance_id = tr.id
             JOIN payments p ON p.id = ra.payment_id
             LEFT JOIN leases l ON l.id = p.lease_id
             JOIN units u ON u.id = COALESCE(p.unit_id, l.unit_id)
             LEFT JOIN properties pr ON pr.id = u.property_id
            WHERE ${disputeFeeLineSql(h)}
              AND tr.stripe_payment_intent_id = split_part(${h}.source_id, ':', 2)
              AND p.landlord_id = ${h}.landlord_id
            GROUP BY u.property_id, pr.timezone
           UNION ALL
           SELECT 3, u.property_id, pr.timezone, SUM(p.amount)
             FROM payments p
             LEFT JOIN leases l ON l.id = p.lease_id
             JOIN units u ON u.id = COALESCE(p.unit_id, l.unit_id)
             LEFT JOIN properties pr ON pr.id = u.property_id
            WHERE ${disputeFeeLineSql(h)}
              AND p.stripe_payment_intent_id = split_part(${h}.source_id, ':', 2)
              AND p.landlord_id = ${h}.landlord_id
            GROUP BY u.property_id, pr.timezone
           UNION ALL
           -- Choice46e fix pass 2: a charge none of the steps above can place
           -- (a receipt with no lease, whose money was all paid ahead) is
           -- placed by that money: first this landlord's bills its spends
           -- paid, then the lease it arrived on — never dropped.
           SELECT 4, u.property_id, pr.timezone, SUM(cu.amount)
             FROM tenant_remittances tr
             JOIN lease_prepaid_credits c ON c.source_remittance_id = tr.id
             JOIN credit_uses cu ON cu.prepaid_credit_id = c.id AND cu.payment_id IS NOT NULL
             JOIN payments p ON p.id = cu.payment_id
             LEFT JOIN leases l ON l.id = p.lease_id
             JOIN units u ON u.id = COALESCE(p.unit_id, l.unit_id)
             LEFT JOIN properties pr ON pr.id = u.property_id
            WHERE ${disputeFeeLineSql(h)}
              AND tr.stripe_payment_intent_id = split_part(${h}.source_id, ':', 2)
              AND p.landlord_id = ${h}.landlord_id
            GROUP BY u.property_id, pr.timezone
           UNION ALL
           SELECT 5, u.property_id, pr.timezone, SUM(c.amount_original)
             FROM tenant_remittances tr
             JOIN lease_prepaid_credits c ON c.source_remittance_id = tr.id
             JOIN leases l ON l.id = COALESCE(c.received_lease_id, c.lease_id)
             JOIN units u ON u.id = l.unit_id
             JOIN properties pr ON pr.id = u.property_id
            WHERE ${disputeFeeLineSql(h)}
              AND tr.stripe_payment_intent_id = split_part(${h}.source_id, ':', 2)
              AND pr.landlord_id = ${h}.landlord_id
            GROUP BY u.property_id, pr.timezone
           UNION ALL
           -- Last of all (nothing of the charge is at a property of this
           -- landlord's): their first property, so the payout line is always
           -- on the statement and the statement still ties to the payout.
           SELECT 6, pr.id, pr.timezone, 0
             FROM properties pr
            WHERE ${disputeFeeLineSql(h)} AND pr.landlord_id = ${h}.landlord_id
              AND pr.id = (SELECT p6.id FROM properties p6 WHERE p6.landlord_id = ${h}.landlord_id
                            ORDER BY p6.created_at NULLS LAST, p6.id LIMIT 1)
         ) x ORDER BY x.pick, x.share DESC, x.property_id LIMIT 1
       )`
}

/**
 * A booking-site deposit's own amount, for a booking (alias `b`) whose deposit
 * was paid on the public booking page (it has a 'booking_deposit' held item):
 * one payment, counted once, on the day it arrived.
 *
 * unit_bookings.deposit_amount is that figure only until something else is
 * paid toward the reservation: a pay link or the counter ADDS what it paid to
 * it (settleLinkBooking: everything paid toward the reservation so far) — and
 * each of those payments counts as its own sale on its own day. So the
 * deposit is deposit_amount less what the sales made toward this reservation
 * after it paid (subtotal less discount plus tax: what the guest paid toward
 * it, before the card fee), never less than what GAM holds for the landlord
 * from the deposit itself (the held item: the deposit, less GAM's card fee
 * when the landlord chose to absorb it) and never more than deposit_amount.
 * Exact whenever nothing else was paid toward the reservation, and whenever
 * the guest paid the card fee on top (the property's default).
 *
 * Fix pass (review r3, §0.0 / decisions #33 — money already received is never
 * rewritten): a deposit itemized when it landed (stay_payments, kind
 * 'site_deposit', since 10/4) is read from that row — what it paid toward the
 * stay, fixed for good. deposit_amount is a running figure later writes move
 * (an early check-out puts it in step with what is still with the landlord
 * after a register refund), and the estimate below then fell to the held
 * item: with the property covering the card fee, a $200 deposit's day read
 * $192.45 after the check-out. The estimate stays only for a deposit paid
 * before the itemizing.
 */
function siteDepositSql(b: string): string {
  const x = a(b)
  return `COALESCE(
    (SELECT sdp.toward_stay FROM stay_payments sdp
      WHERE sdp.booking_id = ${x}.id AND sdp.kind = 'site_deposit'),
    LEAST(${x}.deposit_amount, GREATEST(
      (SELECT sdh.amount FROM held_payout_items sdh
        WHERE sdh.source_type = 'booking_deposit' AND sdh.source_id = ${x}.id::text
        ORDER BY sdh.created_at, sdh.id LIMIT 1),
      ${x}.deposit_amount - COALESCE((
        SELECT SUM(sdt.subtotal - sdt.discount_amount + sdt.tax_amount - ${saleScreeningSql('sdt')}) FROM pos_transactions sdt
         WHERE sdt.landlord_id = ${x}.landlord_id AND sdt.created_at > ${x}.deposit_paid_at
           AND (sdt.id = ${x}.pos_transaction_id
                OR EXISTS (SELECT 1 FROM pos_pay_links sdl WHERE sdl.id = sdt.pay_link_id AND sdl.booking_id = ${x}.id)
                OR EXISTS (SELECT 1 FROM pos_open_tickets sdo WHERE sdo.id = sdt.open_ticket_id AND sdo.booking_id = ${x}.id))),
        0))))`
}

function sharedBranches(basis: IncomeBasis): string[] {
  // A register sale paid through a one-time link is billed on the day the link was sent.
  const saleTs = basis === 'billed'
    ? `CASE WHEN lk.kind = 'one_time' THEN lk.created_at ELSE t.created_at END`
    : 't.created_at'
  const stayCategory = `CASE WHEN t.pay_link_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM unit_bookings sb WHERE sb.pos_transaction_id = t.id)
            OR EXISTS (SELECT 1 FROM pos_open_tickets ot WHERE ot.id = t.open_ticket_id AND ot.booking_id IS NOT NULL)
          THEN 'stays_and_pay_links' ELSE 'register_sales' END`
  // Pre-tax share of a refund: the refund times (net sale) / (net sale + tax).
  // 10/5 (M10): the background check is never refunded and never the sale's income — left out of the share.
  const preTax = (amt: string) =>
    `ROUND(${amt} * (t.subtotal - t.discount_amount - ${saleScreeningSql('t')}) / NULLIF(t.subtotal - t.discount_amount - ${saleScreeningSql('t')} + t.tax_amount, 0), 2)`
  // A booking-site deposit's pre-tax share: the deposit over (1 + the stay's
  // short-stay tax rate, stayTaxPctSql).
  const stayTaxPct = stayTaxPctSql
  const siteDeposit = siteDepositSql('b')
  // A store charge (FlexCharge, payment_method 'charge') is not money: the
  // account's paydown row (FCPAYDOWN) is, and counts when it settles.
  const saleRows = `t.status <> 'voided' AND t.payment_method <> 'charge' AND ${LL('t.landlord_id')}`
  const moveOutFrom = `
       FROM deposit_returns dr
       JOIN leases l ON l.id = dr.lease_id
       LEFT JOIN units u ON u.id = l.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
       CROSS JOIN LATERAL (SELECT ${DED} AS ded) d
       CROSS JOIN LATERAL (SELECT ${UNSHARED_SHORTFALL} AS unshared) un`
  const moveOutWhere = `${LL('dr.landlord_id')} AND ${FINALIZED('dr')}
        AND ${NEAR('dr.finalized_at')}`
  const branches = [
    // Register sales, stays and pay links: net of tax and card fee, on the sale day.
    `SELECT t.landlord_id, t.property_id, NULL::uuid, NULL::uuid, NULL::uuid, NULL::date,
            ${localDay(saleTs, TZ('pr'))},
            'registerAndStays', ${stayCategory}, 'paid', (t.subtotal - t.discount_amount - ${saleScreeningSql('t')}), TRUE, NULL::uuid
       FROM pos_transactions t
       LEFT JOIN pos_pay_links lk ON lk.id = t.pay_link_id
       LEFT JOIN properties pr ON pr.id = t.property_id
      WHERE ${saleRows} AND ${NEAR(saleTs)}`,
    // Refunds, negative on the refund day at the pre-tax share. 10/4
    // (decisions #38 Q4): a card refund also gives back the card fee the guest
    // paid on that part (card_fee_refunded) — never part of the sale's income,
    // so it is left out before the share is taken.
    // Fix round 2: a card refund Stripe later sent back (r.reversed_at) keeps
    // its own day and is added back on the day it came back — never rewritten.
    `SELECT t.landlord_id, t.property_id, NULL::uuid, NULL::uuid, NULL::uuid, NULL::date,
            ${localDay('ev.at', TZ('pr'))},
            'registerAndStays', ${stayCategory}, 'paid', ev.sign * ${preTax('(r.amount - r.card_fee_refunded)')}, TRUE, NULL::uuid
       FROM pos_refunds r
       JOIN pos_transactions t ON t.id = r.transaction_id
       LEFT JOIN properties pr ON pr.id = t.property_id
       CROSS JOIN LATERAL (VALUES (r.created_at, -1), (r.reversed_at, 1)) AS ev(at, sign)
      WHERE ${saleRows} AND ev.at IS NOT NULL AND ${NEAR('ev.at')}`,
    // A refund recorded on the sale only (no refund row).
    `SELECT t.landlord_id, t.property_id, NULL::uuid, NULL::uuid, NULL::uuid, NULL::date,
            ${localDay('t.refunded_at', TZ('pr'))},
            'registerAndStays', ${stayCategory}, 'paid', -${preTax('t.refund_amount')}, TRUE, NULL::uuid
       FROM pos_transactions t
       LEFT JOIN properties pr ON pr.id = t.property_id
      WHERE ${saleRows} AND t.refund_amount > 0 AND t.refunded_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pos_refunds r WHERE r.transaction_id = t.id)
        AND ${NEAR('t.refunded_at')}`,
    // A chargeback on a register sale or a stay deposit, on its day, at the
    // property of the sale. recordChargeback (heldPayouts) nets the landlord
    // the whole disputed charge plus Stripe's dispute fee. Only the sale's
    // pre-tax share comes off income — that is all the sale ever added — and
    // its tax goes back with it; the rest (Stripe's dispute fee and the card
    // fee the buyer had paid) is shown beside the total as "Chargeback fees".
    // A chargeback whose charge cannot be found takes its whole amount off,
    // as before.
    //
    // A rent dispute also writes payout lines under source 'dispute'
    // (paymentReversal): the landlord's own share of the disputed rent moved
    // between batches ('owner_share_…') — rent already counted on its own row,
    // whose loss is that row's reversal — is left out entirely; and the card
    // or bank fee netted from the payout ('stripe_fee_kept:…') is the
    // landlord's cost, shown beside the total as a chargeback fee at the
    // rent's property, on that property's own day, never as a register sale.
    //
    // Fix pass 3: a chargeback GAM won gets a line giving the payee back what
    // it took (stripeCosts.wonChargebackReturnSourceId: '<dispute>:returned_on_win',
    // positive — the disputed amount, plus Stripe's dispute fee when Stripe
    // gave that back too). It is read against the same dispute (the suffix
    // stripped) and is the chargeback's mirror, on its own day: the sale's
    // pre-tax share comes back to income, its tax goes back to the payee
    // untouched, and the rest comes off "Chargeback fees". Never a whole new
    // sale.
    `SELECT h.landlord_id, COALESCE(cb.property_id, fp.property_id), cb.unit_id, NULL::uuid, NULL::uuid, NULL::date,
            ${localDay('h.created_at', `COALESCE(cb.tz, fp.tz, 'America/Phoenix')`)},
            v.line, COALESCE(cb.category, 'register_sales'), v.part, v.amount, v.in_total, NULL::uuid
       FROM held_payout_items h
       LEFT JOIN connect_disputes cd ON cd.stripe_dispute_id = regexp_replace(h.source_id, ':returned_on_win$', '')
       LEFT JOIN LATERAL (
         SELECT t.property_id, NULL::uuid AS unit_id, pr.timezone AS tz, ${stayCategory} AS category,
                ROUND(LEAST(cd.amount, t.total) * (t.subtotal - t.discount_amount - ${saleScreeningSql('t')}) / NULLIF(t.total, 0), 2) AS sale,
                ROUND(LEAST(cd.amount, t.total) * t.tax_amount / NULLIF(t.total, 0), 2) AS tax
           FROM pos_transactions t
           LEFT JOIN properties pr ON pr.id = t.property_id
          WHERE cd.stripe_payment_intent_id IS NOT NULL
            AND t.stripe_payment_intent_id = cd.stripe_payment_intent_id
            AND t.landlord_id = h.landlord_id
         UNION ALL
         SELECT u.property_id, b.unit_id, pr.timezone, 'stays_and_pay_links',
                ROUND(LEAST(cd.amount, ${siteDeposit}) * 100 / (100 + ${stayTaxPct('b', 'pr')}), 2),
                LEAST(cd.amount, ${siteDeposit})
                  - ROUND(LEAST(cd.amount, ${siteDeposit}) * 100 / (100 + ${stayTaxPct('b', 'pr')}), 2)
           FROM unit_bookings b
           JOIN units u ON u.id = b.unit_id
           LEFT JOIN properties pr ON pr.id = u.property_id
          WHERE cd.stripe_payment_intent_id IS NOT NULL
            AND b.stripe_payment_intent_id = cd.stripe_payment_intent_id
            AND b.landlord_id = h.landlord_id AND b.deposit_amount > 0
         LIMIT 1
       ) cb ON TRUE
       -- The property (and its time zone, for the day) of a rent dispute's
       -- fee line (disputeFeePropertySql).
       LEFT JOIN LATERAL ${disputeFeePropertySql('h')} fp ON TRUE
       CROSS JOIN LATERAL (VALUES
         ('registerAndStays', 'paid',
          CASE WHEN ${disputeFeeLineSql('h')} THEN 0
               WHEN cb.sale IS NOT NULL AND ${WON_CHARGEBACK_RETURN('h')} THEN cb.sale
               WHEN cb.sale IS NOT NULL THEN -cb.sale ELSE h.amount END, TRUE),
         ('chargebackFees', NULL::text,
          CASE WHEN ${disputeFeeLineSql('h')} THEN -h.amount
               WHEN cb.sale IS NOT NULL AND ${WON_CHARGEBACK_RETURN('h')} THEN -(h.amount - cb.sale - cb.tax)
               WHEN cb.sale IS NOT NULL THEN -h.amount - cb.sale - cb.tax ELSE 0 END, FALSE)
       ) AS v(line, part, amount, in_total)
      WHERE ${LL('h.landlord_id')} AND h.landlord_id IS NOT NULL AND h.source_type = 'dispute'
        AND NOT ${disputeShareLineSql('h')}
        AND ${NEAR('h.created_at')}`,
    // A stay deposit paid on the public booking page (no register row behind
    // it), at its pre-tax share — as a register stay or a pay link counts —
    // on the day it arrived, at its own amount (siteDepositSql): a pay link or
    // the counter paid toward the same reservation later is its own sale, on
    // its own day, never added to the deposit's.
    `SELECT b.landlord_id, u.property_id, b.unit_id, NULL::uuid, NULL::uuid, NULL::date,
            ${localDay('b.deposit_paid_at', TZ('pr'))},
            'registerAndStays', 'stays_and_pay_links', 'paid',
            ROUND(${siteDeposit} * 100 / (100 + ${stayTaxPct('b', 'pr')}), 2), TRUE, NULL::uuid
       FROM unit_bookings b
       JOIN units u ON u.id = b.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE ${LL('b.landlord_id')} AND b.deposit_paid_at IS NOT NULL AND b.deposit_amount > 0
        AND EXISTS (SELECT 1 FROM held_payout_items h
                     WHERE h.source_type = 'booking_deposit' AND h.source_id = b.id::text)
        AND ${NEAR('b.deposit_paid_at')}`,
    // 10/4 (decisions #38): a booking-site deposit refunded at a short stay's
    // early check-out (no register sale behind it, so no pos_refunds row):
    // negative on the refund day, at the pre-tax share (the lodging tax inside
    // it goes back with it). The day the deposit arrived is never rewritten.
    // A refund Stripe sent back keeps its day and is added back on the day it came back.
    `SELECT rp.landlord_id, u.property_id, b.unit_id, NULL::uuid, NULL::uuid, NULL::date,
            ${localDay('ev.at', TZ('pr'))},
            'registerAndStays', 'stays_and_pay_links', 'paid', ev.sign * (rp.toward_amount - rp.lodging_tax_share), TRUE, NULL::uuid
       FROM stay_refund_parts rp
       JOIN stay_checkout_decisions sd ON sd.id = rp.decision_id
       JOIN unit_bookings b ON b.id = rp.booking_id
       JOIN units u ON u.id = b.unit_id
       LEFT JOIN properties pr ON pr.id = u.property_id
       CROSS JOIN LATERAL (VALUES (rp.refunded_at, -1), (rp.reversed_at, 1)) AS ev(at, sign)
      WHERE ${LL('rp.landlord_id')} AND sd.lease_id IS NULL AND rp.pos_refund_id IS NULL
        AND rp.stay_payment_id IS NOT NULL AND rp.status IN ('refunded', 'handed_back')
        AND ev.at IS NOT NULL AND ${NEAR('ev.at')}`,
    // 10/4 (decisions #38 Q4): the card fee a guest got back with an early
    // check-out refund (every card or bank part that went out, a register
    // sale's included — its sale refund row leaves the fee out of income; and
    // a card refund given back in cash instead, fix round 2, which carries the
    // same fee). Not income: the landlord's cost, beside the total (a positive
    // cost, like chargebackFees), on the refund day — and taken off again on
    // the day Stripe sent a refund back (rp.reversed_at).
    // Review fix (choice46b): the card fee given back with a refund from the
    // landlord's paid-ahead money screen too (a card or bank refund, or one
    // given back in cash instead) — at that lease's unit, as rent ('space_rent').
    // Pass 2: for money carried from an earlier lease, at the lease it arrived
    // on (received_lease_id), beside its refund line.
    `SELECT rp.landlord_id, u.property_id, u.id, COALESCE(sd.lease_id, pcl.id), NULL::uuid, NULL::date,
            ${localDay('ev.at', TZ('pr'))},
            'refundCardFees', CASE WHEN sd.lease_id IS NULL AND pc.id IS NULL THEN 'stays_and_pay_links' ELSE 'space_rent' END,
            NULL::text, -ev.sign * rp.card_fee_back, FALSE, NULL::uuid
       FROM stay_refund_parts rp
       LEFT JOIN stay_checkout_decisions sd ON sd.id = rp.decision_id
       LEFT JOIN paid_ahead_choices pc ON pc.id = rp.paid_ahead_choice_id
       LEFT JOIN lease_prepaid_credits rc ON rc.id = rp.prepaid_credit_id AND pc.id IS NOT NULL
       LEFT JOIN leases pcl ON pcl.id = COALESCE(rc.received_lease_id, pc.lease_id)
       LEFT JOIN unit_bookings b ON b.id = rp.booking_id
       JOIN units u ON u.id = CASE WHEN pc.id IS NOT NULL THEN pcl.unit_id ELSE b.unit_id END
       LEFT JOIN properties pr ON pr.id = u.property_id
       CROSS JOIN LATERAL (VALUES (rp.refunded_at, -1), (rp.reversed_at, 1)) AS ev(at, sign)
      WHERE ${LL('rp.landlord_id')} AND (sd.id IS NOT NULL OR pc.id IS NOT NULL) AND rp.status IN ('refunded', 'handed_back')
        AND rp.card_fee_back > 0
        AND ev.at IS NOT NULL AND ${NEAR('ev.at')}`,
    // Money GAM never handled, filed by the landlord (laundry, interest, Square payouts...).
    `SELECT oi.landlord_id, oi.property_id, oi.unit_id, NULL::uuid, NULL::uuid, NULL::date, oi.income_date,
            'otherIncome', 'other_income', 'paid', oi.amount, TRUE, NULL::uuid
       FROM landlord_other_income oi
      WHERE ${LL('oi.landlord_id')} AND oi.status = 'active' AND oi.voided_at IS NULL
        AND oi.income_date BETWEEN $2::date AND $3::date`,
    // The move-out's deductions (cleaning + damage + other, `ded`), on the
    // finalize day. The bills it swept count on their own rows above, each
    // less its share of a shortfall past `ded` (payCte's `short`); the
    // shortfall up to `ded` is the deductions' own. A shortfall past `ded`
    // with no swept bill to carry it (`unshared`) stays here.
    basis === 'received'
      // Money received: deductions kept = ded less the shortfall (up to ded),
      // so the move-out adds exactly what the pool kept. The shortfall counts
      // as "Deposit shortfall collected" when the tenant pays it.
      ? `SELECT dr.landlord_id, u.property_id, u.id, dr.lease_id, NULL::uuid, NULL::date,
            ${localDay('dr.finalized_at', TZ('pr'))},
            v.line, NULL::text, NULL::text, v.amount, TRUE, dr.id
       ${moveOutFrom}
       CROSS JOIN LATERAL (VALUES
         ('depositDeductions', d.ded - LEAST(dr.gap_amount, d.ded)),
         ('keptFromDeposits', -un.unshared)
       ) AS v(line, amount)
      WHERE ${moveOutWhere}`
      // Money billed: deductions in full on the finalize day — kept from the
      // deposit, less the shortfall up to ded, which takes what became of the
      // shortfall (paid, clearing, or still owed until it is paid).
      : `SELECT dr.landlord_id, u.property_id, u.id, dr.lease_id, NULL::uuid, NULL::date,
            ${localDay('dr.finalized_at', TZ('pr'))},
            'depositDeductions', NULL::text, v.part, v.amount, TRUE, dr.id
       ${moveOutFrom}
       CROSS JOIN LATERAL (
         SELECT 'keptFromDeposit'::text, d.ded - LEAST(dr.gap_amount, d.ded) - un.unshared
         UNION ALL
         SELECT gs.part, gs.amount FROM ${gapPartSplitSql('dr.id', 'LEAST(dr.gap_amount, d.ded) + un.unshared', null)} gs
       ) AS v(part, amount)
      WHERE ${moveOutWhere} AND v.amount <> 0`,
    // Beside: bills covered by work trade (never money), by due date. While
    // the month is open its covered lines sit suspended at their full amount;
    // at month close (jobs/workTradeSettlement) the lines the hours covered
    // drop to $0 (or to the lapse), the suspension is lifted, and what was
    // covered is recorded on the invoice (work_trade_credit_amount). So an
    // invoice still carrying suspended lines reads them; any other invoice
    // reads its recorded credit — a closed month keeps saying what work trade
    // covered, and nothing is counted twice.
    `SELECT p.landlord_id, u.property_id, u.id, p.lease_id, p.id, p.due_date, p.due_date,
            'workTrade', ${categorySql('p', 'ub.utility_type', 'lf')}, NULL::text, p.amount, FALSE, NULL::uuid
       FROM payments p
       LEFT JOIN leases pl ON pl.id = p.lease_id
       LEFT JOIN units u ON u.id = COALESCE(p.unit_id, pl.unit_id)
       LEFT JOIN lease_fees lf ON lf.id = p.lease_fee_id
       LEFT JOIN LATERAL (SELECT ub0.utility_type FROM utility_bills ub0
                           WHERE ub0.payment_id = p.id ORDER BY ub0.created_at, ub0.id LIMIT 1) ub ON TRUE
      WHERE ${LL('p.landlord_id')} AND ${landlordIncomeSql('p')}
        AND p.work_trade_suspended_at IS NOT NULL
        AND p.due_date BETWEEN $2::date AND $3::date`,
    `SELECT i.landlord_id, u.property_id, u.id, i.lease_id, NULL::uuid, i.due_date, i.due_date,
            'workTrade', NULL::text, NULL::text, i.work_trade_credit_amount, FALSE, NULL::uuid
       FROM invoices i
       LEFT JOIN units u ON u.id = i.unit_id
      WHERE ${LL('i.landlord_id')}
        AND i.work_trade_credit_amount > 0 AND i.status <> 'void'
        AND i.due_date BETWEEN $2::date AND $3::date
        AND NOT EXISTS (SELECT 1 FROM payments sp
                         WHERE sp.invoice_id = i.id AND sp.work_trade_suspended_at IS NOT NULL)`,
    // Beside: security deposits received, held for the tenant (never income).
    `SELECT p.landlord_id, u.property_id, u.id, p.lease_id, p.id, p.due_date,
            ${localDay('p.settled_at', TZ('pr'))},
            'depositsHeld', NULL::text, NULL::text, p.amount, FALSE, NULL::uuid
       FROM payments p
       LEFT JOIN leases pl ON pl.id = p.lease_id
       LEFT JOIN units u ON u.id = COALESCE(p.unit_id, pl.unit_id)
       LEFT JOIN properties pr ON pr.id = u.property_id
      WHERE ${LL('p.landlord_id')} AND p.type = 'deposit' AND p.revenue_owner <> 'gam'
        AND p.status = 'settled' AND p.settled_at IS NOT NULL
        AND ${NEAR('p.settled_at')}`,
  ]
  return branches
}

/**
 * THE one SELECT of dated, signed money facts for a basis, one row per fact:
 *   landlord_id, property_id, unit_id, lease_id, payment_id, due_date,
 *   day       the property's calendar day the fact counts on
 *   line      a REPORT_LINES value (in_total) or an ASIDE_LINES value (beside)
 *   category  an INCOME_CATEGORIES value, or NULL for money with no category
 *             (paid ahead, deposit deductions and their part of a shortfall
 *             paid later, a clawback); a shortfall's part that covered a swept
 *             bill carries that bill's category; reservation money moved to
 *             credit, or handed back at move-out, carries the stay's
 *             (STAY_MONEY_CATEGORY)
 *   part      Money billed: a BILLED_PARTS value (what became of the bill)
 *   amount    signed dollars
 *   in_total  TRUE = inside the total; FALSE = shown beside it
 *   move_out_id  the move-out (deposit_returns.id) a fact belongs to: its
 *             deductions, the bills it swept, paid-ahead money that went into
 *             it, the shortfall the tenant paid (or is paying) after it;
 *             NULL otherwise
 * Parameters: $1 landlord ids (uuid[], NULL = all), $2 first day, $3 last day,
 * $4 property ids (uuid[], NULL = all).
 */
export function incomeEventsSql(basis: IncomeBasis): string {
  const window = basis === 'received'
    ? `((p.settled_at IS NOT NULL AND ${NEAR('p.settled_at')})
        OR (p.status = 'processing' AND ${NEAR('COALESCE(p.processed_at, p.created_at)')}))`
    : `(p.due_date BETWEEN $2::date AND $3::date AND p.work_trade_suspended_at IS NULL)`
  const cte = basis === 'received' ? 'rx_pay' : 'bx_pay'
  const branches = [
    ...(basis === 'received' ? receivedBranches() : billedBranches()),
    ...sharedBranches(basis),
  ]
  // Both bases read where a shortened stay's money came from (stayShortenedCtes):
  // Money billed takes it back off there, and Money received puts the
  // reservation's share of it under the stay when it goes into a move-out.
  // Money billed also takes reservation money moved to credit back off the
  // reservation's own payments (reservationBackCtes).
  return `
WITH ${cte} AS (${payCte(window)}
),
${stayShortenedCtes()}${basis === 'billed' ? `,${reservationBackCtes()}` : ''}
SELECT ev.landlord_id, ev.property_id, ev.unit_id, ev.lease_id, ev.payment_id,
       ev.due_date::text AS due_date, ev.day::text AS day,
       ev.line, ev.category, ev.part, ROUND(ev.amount::numeric, 2)::text AS amount, ev.in_total, ev.move_out_id
  FROM (
    ${branches.join('\n    UNION ALL\n    ')}
  ) AS ev(${COLS})
 WHERE ev.day BETWEEN $2::date AND $3::date
   AND ev.amount <> 0
   AND ($4::uuid[] IS NULL OR ev.property_id = ANY($4::uuid[]))`
}

// ─── Reading the facts ────────────────────────────────────────────────────────

export interface IncomeEvent {
  landlordId: string
  propertyId: string | null
  unitId: string | null
  /** The lease the money belongs to; null for register sales, stays, pay links and other income. */
  leaseId: string | null
  paymentId: string | null
  dueDate: string | null
  /** The property's calendar day, 'YYYY-MM-DD'. */
  day: string
  line: ReportLine | AsideLine
  category: IncomeCategory | null
  part: BilledPart | null
  amount: number
  inTotal: boolean
  /**
   * The move-out (deposit_returns.id) this fact belongs to, or null. Group a
   * move-out's facts by this, never by lease: the bills a move-out sweeps can
   * sit on the previous lease of a renewal chain.
   */
  moveOutId: string | null
}

export interface IncomeQuery {
  /** null = every landlord (the admin lens). An empty list sees nothing. */
  landlordIds: string[] | null
  /** 'YYYY-MM-DD' (a longer timestamp is cut to its date). */
  start: string
  end: string
  basis: IncomeBasis
  /** null/undefined = every property; an empty list sees nothing. */
  propertyIds?: string[] | null
}

const ymd = (d: string) => String(d).slice(0, 10)

export async function incomeEvents(q: IncomeQuery): Promise<IncomeEvent[]> {
  if (q.landlordIds && q.landlordIds.length === 0) return []
  if (q.propertyIds && q.propertyIds.length === 0) return []
  const rows = await query<any>(incomeEventsSql(q.basis),
    [q.landlordIds ?? null, ymd(q.start), ymd(q.end), q.propertyIds ?? null])
  return rows.map(r => ({
    landlordId: r.landlord_id,
    propertyId: r.property_id ?? null,
    unitId: r.unit_id ?? null,
    leaseId: r.lease_id ?? null,
    paymentId: r.payment_id ?? null,
    dueDate: r.due_date ?? null,
    day: r.day,
    line: r.line,
    category: r.category ?? null,
    part: r.part ?? null,
    amount: Number(r.amount),
    inTotal: r.in_total === true,
    moveOutId: r.move_out_id ?? null,
  }))
}

// ─── Totals ───────────────────────────────────────────────────────────────────

export interface IncomeBeside {
  clearing: number
  creditsYouGave: number
  workTrade: number
  depositsHeld: number
  /** What chargebacks cost beyond the sale and its tax (Stripe's fee, the buyer's card fee). */
  chargebackFees: number
  /** The card fee guests got back with early check-out refunds (the landlord's cost, #38 Q4). */
  refundCardFees: number
  /** Money billed: the parts already collected (paid, covered, kept). */
  collectedSoFar: number
  /** Money billed: the part still owed. */
  stillOwed: number
}

export interface IncomeSummary {
  basis: IncomeBasis
  lines: Record<ReportLine, number>
  total: number
  /** Money billed: what became of the total (adds up to it). All 0 under Money received. */
  parts: Record<BilledPart, number>
  beside: IncomeBeside
}

const COLLECTED_PARTS: readonly BilledPart[] = ['paid', 'coveredByPaidAhead', 'coveredByDepositInterest', 'keptFromDeposit']

function zeroLines(): Record<ReportLine, number> {
  return Object.fromEntries(REPORT_LINES.map(l => [l, 0])) as Record<ReportLine, number>
}
function zeroParts(): Record<BilledPart, number> {
  return Object.fromEntries(BILLED_PARTS.map(p => [p, 0])) as Record<BilledPart, number>
}

/** Add up a set of facts (already filtered to one period/scope). Pure. */
export function summarize(events: readonly IncomeEvent[], basis: IncomeBasis): IncomeSummary {
  const lines = zeroLines()
  const parts = zeroParts()
  const beside: IncomeBeside = {
    clearing: 0, creditsYouGave: 0, workTrade: 0, depositsHeld: 0, chargebackFees: 0, refundCardFees: 0, collectedSoFar: 0, stillOwed: 0,
  }
  let total = 0
  for (const e of events) {
    if (e.inTotal) {
      if ((REPORT_LINES as readonly string[]).includes(e.line)) lines[e.line as ReportLine] += e.amount
      total += e.amount
      if (basis === 'billed' && e.part) parts[e.part] += e.amount
    } else if ((ASIDE_LINES as readonly string[]).includes(e.line)) {
      beside[e.line as AsideLine] += e.amount
    }
  }
  for (const k of REPORT_LINES) lines[k] = round2(lines[k])
  for (const k of BILLED_PARTS) parts[k] = round2(parts[k])
  if (basis === 'billed') {
    beside.clearing = parts.clearing
    beside.collectedSoFar = round2(COLLECTED_PARTS.reduce((s, p) => s + parts[p], 0))
    beside.stillOwed = parts.stillOwed
  }
  for (const k of Object.keys(beside) as (keyof IncomeBeside)[]) beside[k] = round2(beside[k])
  return { basis, lines, total: round2(total), parts, beside }
}

export interface IncomeTotals extends IncomeSummary {
  meta: BasisMeta
  period: { start: string; end: string }
  /** Paid-ahead money received by the last day and not yet used by it. */
  paidAheadUnused: number
}

/**
 * Paid-ahead money on hand at the end of a day: received on or before it, not
 * withdrawn, less every use live at the end of that day — set aside or spent by
 * then, and not given back or undone by then (a released use or an undone
 * spend returns its money to the credit, as the ledger trigger does).
 */
export async function paidAheadUnusedAt(q: Omit<IncomeQuery, 'start' | 'basis'>): Promise<number> {
  if (q.landlordIds && q.landlordIds.length === 0) return 0
  if (q.propertyIds && q.propertyIds.length === 0) return 0
  const row = await query<{ s: string }>(`
    SELECT COALESCE(SUM(GREATEST(c.amount_original - COALESCE(used.amt, 0), 0)), 0)::text AS s
      FROM lease_prepaid_credits c
      JOIN leases l ON l.id = c.lease_id
      LEFT JOIN units u ON u.id = l.unit_id
      LEFT JOIN properties pr ON pr.id = u.property_id
      LEFT JOIN LATERAL (
        SELECT SUM(cu.amount) AS amt FROM credit_uses cu
         WHERE cu.prepaid_credit_id = c.id
           AND ${localDay('LEAST(cu.held_at, COALESCE(cu.applied_at, cu.held_at))', TZ('pr'))} <= $2::date
           AND (cu.released_at IS NULL OR ${localDay('cu.released_at', TZ('pr'))} > $2::date)
      ) used ON TRUE
     WHERE ${LL('l.landlord_id')}
       AND c.voided_at IS NULL
       AND ${localDay('COALESCE(c.received_at, c.created_at)', TZ('pr'))} <= $2::date
       AND ($3::uuid[] IS NULL OR u.property_id = ANY($3::uuid[]))`,
    [q.landlordIds ?? null, ymd(q.end), q.propertyIds ?? null])
  return round2(Number(row[0]?.s ?? 0))
}

/** The totals for one period and scope under one basis. */
export async function incomeTotals(q: IncomeQuery): Promise<IncomeTotals> {
  const [events, paidAheadUnused] = await Promise.all([incomeEvents(q), paidAheadUnusedAt(q)])
  return {
    ...summarize(events, q.basis),
    meta: basisMeta(q.basis),
    period: { start: ymd(q.start), end: ymd(q.end) },
    paidAheadUnused,
  }
}

/** Facts grouped by 'YYYY-MM' (the property's month). */
export function byMonth(events: readonly IncomeEvent[]): Map<string, IncomeEvent[]> {
  const out = new Map<string, IncomeEvent[]>()
  for (const e of events) {
    const k = e.day.slice(0, 7)
    const list = out.get(k)
    if (list) list.push(e); else out.set(k, [e])
  }
  return out
}

/** The lines as a list for a screen: label and amount (a line that takes money off is negative). */
export function lineList(lines: Record<ReportLine, number>): Array<{ line: ReportLine; label: string; amount: number }> {
  return REPORT_LINES
    .filter(l => (lines[l] ?? 0) !== 0)
    .map(l => ({ line: l, label: REPORT_LINE_LABEL[l], amount: lines[l] }))
}

/** The beside figures as a list for a screen (non-zero only). */
export function besideList(
  beside: IncomeBeside, paidAheadUnused: number | null, basis: IncomeBasis,
): Array<{ key: string; label: string; amount: number }> {
  const keys: Array<keyof typeof ASIDE_LINE_LABEL> = basis === 'received'
    ? ['clearing', 'creditsYouGave', 'workTrade', 'depositsHeld', 'chargebackFees', 'refundCardFees', 'paidAheadUnused']
    : ['collectedSoFar', 'clearing', 'stillOwed', 'workTrade', 'depositsHeld', 'chargebackFees', 'refundCardFees', 'paidAheadUnused']
  const value = (k: keyof typeof ASIDE_LINE_LABEL): number =>
    k === 'paidAheadUnused' ? (paidAheadUnused ?? 0) : (beside as any)[k] ?? 0
  return keys.filter(k => value(k) !== 0).map(k => ({ key: k, label: ASIDE_LINE_LABEL[k], amount: value(k) }))
}

export function partList(parts: Record<BilledPart, number>): Array<{ part: BilledPart; label: string; amount: number }> {
  return BILLED_PARTS.filter(p => parts[p] !== 0).map(p => ({ part: p, label: BILLED_PART_LABEL[p], amount: parts[p] }))
}

// ─── Decision #4: the category breakdown ─────────────────────────────────────

export interface CategoryRow {
  category: IncomeCategory
  label: string
  /** Billed in the period (by due date), net of credits given. */
  billed: number
  /** Money received: received in the period. Money billed: collected so far of what was billed. */
  collected: number
  /** Money billed: still clearing / still owed of what was billed. */
  clearing: number
  stillOwed: number
  /** What counts toward the total under the chosen basis. */
  amount: number
}

export interface CategoryBreakdown {
  basis: IncomeBasis
  meta: BasisMeta
  categories: CategoryRow[]
  /** Money with no category, inside the total (paid ahead, deposit deductions, ...). */
  lines: Array<{ line: ReportLine; label: string; amount: number }>
  total: number
}

/** Pure: the breakdown from already-read facts (billed facts always; received facts under Money received). */
export function breakdownFrom(
  basis: IncomeBasis, billedEvents: readonly IncomeEvent[], receivedEvents: readonly IncomeEvent[] | null,
): CategoryBreakdown {
  const rows = new Map<IncomeCategory, CategoryRow>()
  for (const c of INCOME_CATEGORIES) {
    rows.set(c, { category: c, label: INCOME_CATEGORY_LABEL[c], billed: 0, collected: 0, clearing: 0, stillOwed: 0, amount: 0 })
  }
  const lineTotals = zeroLines()
  for (const e of billedEvents) {
    if (!e.inTotal) continue
    if (!e.category) {
      if (basis === 'billed') lineTotals[e.line as ReportLine] += e.amount
      continue
    }
    const r = rows.get(e.category)!
    r.billed += e.amount
    if (basis === 'billed') {
      if (e.part && COLLECTED_PARTS.includes(e.part)) r.collected += e.amount
      if (e.part === 'clearing') r.clearing += e.amount
      if (e.part === 'stillOwed') r.stillOwed += e.amount
    }
  }
  if (basis === 'received') {
    for (const e of receivedEvents ?? []) {
      if (!e.inTotal) continue
      if (!e.category) { lineTotals[e.line as ReportLine] += e.amount; continue }
      rows.get(e.category)!.collected += e.amount
    }
  }
  const categories = [...rows.values()].map(r => {
    const out = {
      ...r,
      billed: round2(r.billed), collected: round2(r.collected),
      clearing: round2(r.clearing), stillOwed: round2(r.stillOwed),
    }
    out.amount = basis === 'received' ? out.collected : out.billed
    return out
  })
  for (const k of REPORT_LINES) lineTotals[k] = round2(lineTotals[k])
  const lines = lineList(lineTotals)
  const total = round2(categories.reduce((s, c) => s + c.amount, 0) + lines.reduce((s, l) => s + l.amount, 0))
  return { basis, meta: basisMeta(basis), categories, lines, total }
}

/**
 * Decision #4 (Nic): "here's the total collected... how much electric was billed
 * back, property-wide... the distinction between lot rent collected, late fees,
 * trailer payments." Income by category, billed vs collected, under the switch.
 * The property report and the dashboard property-health card both read this.
 */
export async function categoryTotals(q: IncomeQuery): Promise<CategoryBreakdown> {
  const billed = await incomeEvents({ ...q, basis: 'billed' })
  const received = q.basis === 'received' ? await incomeEvents({ ...q, basis: 'received' }) : null
  return breakdownFrom(q.basis, billed, received)
}
