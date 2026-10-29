/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P4: WHAT EVERY TENANT-MONEY PROJECTOR
 * SHARES (gam-ledger-design-2026-10-12 §6 A-E and J, §9)
 *
 * The tenant-money projectors (tenantCharges, tenantReceipts, tenantCredits,
 * tenantDeposits, tenantReversals, tenantOpening; composed per source type in
 * tenantMoney) all read the same few facts about a bill row and the company:
 *
 *   loadPaymentFacts   one query for any number of payments rows: what the
 *                      row IS (its report category, the property it belongs
 *                      to, whether it is the landlord's money at all), its
 *                      own amount and the work-trade hours on it, the credit
 *                      spent on it, and the day it settled on the property's
 *                      calendar.
 *   loadCompanyBooks   the company's books start date and the two accounting
 *                      methods tenant money depends on — Nic 10/12: home sales
 *                      (L11) and work trade (L12) are the LANDLORD'S CHOICE,
 *                      NULL until the owner picks on the Books settings page
 *                      (services/booksSettings). A posting that depends on a
 *                      method not chosen WAITS: the projector refuses with
 *                      'owner_not_ready', the engine retries every 15 minutes
 *                      without telling an admin, and the settings page retries
 *                      it the moment the owner chooses.
 *   Lines              a balanced-line builder in whole cents (a negative
 *                      amount books on the other side; zero books nothing).
 *
 * Rules every P4 projector follows (design §1, §6 conventions, §8):
 *   - Company = the source row's own landlord_id, never the unit's today.
 *   - Dates are the property's local day ('YYYY-MM-DD'); a timestamp is read
 *     on the property's timezone, else the company's books calendar.
 *   - Facts, never current state: no platform_held, no release stamps, no
 *     fee-payer setting, no tax rate, no chart lookups (ledgerProjectorPurity).
 *   - Received ('in' lines) is tagged where money arrives or goes back.
 *   - Nic L13: paid-ahead money GAM holds is NOT on the landlord's balance
 *     sheet until it pays a bill — it books nothing when it arrives and books
 *     as money received (Due from GAM) on the day it pays a landlord's bill.
 *   - Rows that are never the landlord's (design §6 K): GAM's own rows, the
 *     FlexPay pull, FlexDeposit installment rows. The prepaid move-in box
 *     (revenue_owner 'held') is GAM-held paid-ahead money too (L13): billing it
 *     books nothing; paid at the desk it is landlord-held paid-ahead money from
 *     the receipt on.
 */
import type { PoolClient } from 'pg'
import type {
  LedgerAccountRole, LedgerReportCategory, LedgerCashEffect, BooksHomeSaleMethod, BooksWorkTradeMethod,
} from '@gam/shared'
import { LedgerSourceError, type DesiredLine } from '../ledgerEngine'
import { SPACE_COLS_SQL, spaceOf, rentParts, type SpaceFacts, type IncomePart } from './incomeLines'

// ─── Amounts ────────────────────────────────────────────────────────────────

/** A numeric read in SQL as whole cents (`round(x * 100)::bigint::text`) → a JS integer. */
export function centsOf(v: string | number | null | undefined): number {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n)) return 0
  return Math.round(n)
}

/** SQL: a numeric expression as whole cents, text (exact; never a float). */
export const cSql = (expr: string): string => `round((${expr}) * 100)::bigint::text`

// ─── Calendars ──────────────────────────────────────────────────────────────

/**
 * SQL: the company's books calendar — landlords.books_timezone once pinned,
 * else the first property's, else America/Phoenix (the same fallback
 * ledgerOwner.loadOwnerContext reads, so a projector and the engine agree on
 * every company-level day).
 */
export function companyTzSql(landlordExpr: string): string {
  return `COALESCE((SELECT lz.books_timezone FROM landlords lz WHERE lz.id = ${landlordExpr}),
                   (SELECT pz.timezone FROM properties pz
                     WHERE pz.landlord_id = ${landlordExpr} AND pz.timezone IS NOT NULL
                     ORDER BY pz.created_at, pz.id LIMIT 1),
                   'America/Phoenix')`
}

/** SQL: a property's timezone, else the company's books calendar. */
export function propertyTzSql(propertyExpr: string, landlordExpr: string): string {
  return `COALESCE((SELECT pt.timezone FROM properties pt WHERE pt.id = ${propertyExpr}), ${companyTzSql(landlordExpr)})`
}

/** SQL: a timestamptz as the local day 'YYYY-MM-DD' on `tzExpr` (NULL stays NULL). */
export function localDaySql(tsExpr: string, tzExpr: string): string {
  return `CASE WHEN (${tsExpr}) IS NULL THEN NULL ELSE ((${tsExpr}) AT TIME ZONE ${tzExpr})::date::text END`
}

/** SQL: the property a lease belongs to (its unit's). */
export function leasePropertySql(leaseExpr: string): string {
  return `(SELECT ul.property_id FROM leases ll JOIN units ul ON ul.id = ll.unit_id WHERE ll.id = ${leaseExpr})`
}

// ─── The company ────────────────────────────────────────────────────────────

export interface CompanyBooks {
  landlordId: string
  booksStart: string | null
  /** Nic L11. NULL = not chosen yet (a home-sale posting waits). */
  homeSaleMethod: BooksHomeSaleMethod | null
  /** Nic L12. NULL = not chosen yet (a work-trade posting waits). */
  workTradeMethod: BooksWorkTradeMethod | null
}

export async function loadCompanyBooks(client: PoolClient, landlordId: string): Promise<CompanyBooks> {
  const r = await client.query<{ books_start: string | null; home: BooksHomeSaleMethod | null; wt: BooksWorkTradeMethod | null }>(
    `SELECT books_start_date::text AS books_start, books_home_sale_method AS home, books_work_trade_method AS wt
       FROM landlords WHERE id = $1`, [landlordId])
  const row = r.rows[0]
  return {
    landlordId,
    booksStart: row?.books_start ?? null,
    homeSaleMethod: row?.home ?? null,
    workTradeMethod: row?.wt ?? null,
  }
}

/** Nic L11: the home-sale method, or the posting waits for the owner to choose it. */
export function requireHomeSaleMethod(co: CompanyBooks): BooksHomeSaleMethod {
  if (!co.homeSaleMethod) {
    throw new LedgerSourceError('owner_not_ready',
      'Waiting on the owner: how home sales count (the whole sale at signing, or income as each payment comes in) is not chosen yet on the Books settings page.')
  }
  return co.homeSaleMethod
}

/** Nic L12: the work-trade method, or the posting waits for the owner to choose it. */
export function requireWorkTradeMethod(co: CompanyBooks): BooksWorkTradeMethod {
  if (!co.workTradeMethod) {
    throw new LedgerSourceError('owner_not_ready',
      'Waiting on the owner: how work-trade hours that cover rent count (full rent plus a labor cost, a rent discount, or left out of the books) is not chosen yet on the Books settings page.')
  }
  return co.workTradeMethod
}

// ─── A bill row ─────────────────────────────────────────────────────────────

/**
 * Why a payments row is never on the landlord's book as a bill (design §6 A1
 * exclusions and K), or null when it is an ordinary landlord charge.
 *   gam             GAM's own row (revenue_owner 'gam') or the FlexPay pull
 *   flex_deposit    a FlexDeposit installment row (custody: GAM's)
 *   held_box        a prepaid move-in box (L13: GAM-held paid-ahead money)
 *   move_out_refund the move-out refund row (its money goes out as refund parts)
 */
export type RowExclusion = 'gam' | 'flex_deposit' | 'held_box' | 'move_out_refund'

export interface PaymentFacts {
  id: string
  landlordId: string
  unitId: string | null
  leaseId: string | null
  tenantId: string | null
  type: string
  entryDescription: string | null
  status: string
  voided: boolean
  dueDate: string
  settledDay: string | null
  manualMethod: string | null
  revenueOwner: string
  reversalId: string | null
  flexpayAdvanceId: string | null
  workTradeSettlementId: string | null
  /**
   * 10/19 (Nic): the carried space-rent claim this row belongs to — set on the
   * one carried_balance charge, on its part-payment remainders, and on the rent
   * rows it was carried from. It decides the charge posting two ways
   * (tenantCharges A8b): the carried balance moves a RECEIVABLE instead of
   * booking income (the park already earned that rent, in its own months), and
   * the voided rent rows it names keep their own charges, so a park's real
   * September and October income stays in September and October.
   */
  spaceCarryforwardId: string | null
  homeSaleInstallmentId: string | null
  invoiceId: string | null
  leaseFeeId: string | null
  feeType: string | null
  depositCollectedBy: string | null
  propertyId: string | null
  tz: string
  /** The row's own amount (after any work-trade credit lowered it), cents. */
  amountCents: number
  /** Work-trade hours applied to the row at the month close, cents. */
  workTradeCents: number
  /** Credit spent on the row (credit uses applied or reversed), cents. */
  creditCents: number
  /** What the row billed: amount + work-trade credit, cents (design A1). */
  grossCents: number
  /** The row's own money: amount − credit spent on it, cents. */
  moneyCents: number
  category: LedgerReportCategory
  isMoveOutGap: boolean
  /** Paid by at least one settled receipt (a remittance application). */
  hasSettledApplication: boolean
  exclusion: RowExclusion | null
  /** 10/14 (Nic I1-I7): the space the row is for (its unit, else its lease's) as it stood when the row was billed, for which rent line it books to. */
  space: SpaceFacts | null
}

/** The UTILITY_NAMED_IN_NOTES patterns of services/incomeBasis.categorySql (a utility row with no bill). */
const UTILITY_NOTES: ReadonlyArray<readonly [string, LedgerReportCategory]> = [
  ['^\\s*electric(ity)?\\M', 'electric'],
  ['^\\s*water\\M', 'water'],
  ['^\\s*sewer\\M', 'sewer'],
  ['^\\s*(natural\\s+)?gas\\M', 'gas'],
  ['^\\s*trash\\M', 'trash'],
]

/**
 * SQL over the CTE row `b` (payments columns + ub_type, fee_type): the row's
 * report category — services/incomeBasis.categorySql's rule (one category per
 * row, by what it is), plus the ledger's two: a work-trade shortfall row is
 * space rent (design A9) and a refundable deposit is 'deposits' (not income).
 */
const CATEGORY_SQL = `(CASE
    WHEN b.work_trade_settlement_id IS NOT NULL THEN 'space_rent'
    WHEN b.type = 'deposit' THEN 'deposits'
    WHEN b.ub_type IN ('electric','water','sewer','gas','trash') THEN b.ub_type
    WHEN b.fee_type = 'trash_fee' THEN 'trash'
    WHEN upper(COALESCE(b.entry_description, '')) = 'PROPANE' THEN 'propane'
    WHEN b.type = 'home_payment' OR b.entry_description = 'HOMEPMT' THEN 'home_payments'
    WHEN b.type = 'late_fee' OR b.entry_description = 'LATEFEE' THEN 'late_fees'
    WHEN b.type = 'carried_balance' THEN 'balances_collected'
    ${UTILITY_NOTES.map(([re, cat]) => `WHEN b.type = 'utility' AND COALESCE(b.notes, '') ~* '${re}' THEN '${cat}'`).join('\n    ')}
    WHEN b.type = 'utility' THEN 'utility_other'
    WHEN b.type = 'rent' THEN 'space_rent'
    ELSE 'other_fees' END)`

/** Reads the facts of every listed payments row (missing ids are simply absent). */
export async function loadPaymentFacts(client: PoolClient, ids: readonly string[]): Promise<Map<string, PaymentFacts>> {
  const out = new Map<string, PaymentFacts>()
  const uuids = [...new Set(ids)].filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
  if (uuids.length === 0) return out
  const r = await client.query<any>(
    `WITH b AS (
       SELECT p.*, lf.fee_type,
              (SELECT ub.utility_type FROM utility_bills ub WHERE ub.payment_id = p.id ORDER BY ub.created_at, ub.id LIMIT 1) AS ub_type,
              COALESCE(
                (SELECT um.property_id FROM utility_bills ub JOIN utility_meters um ON um.id = ub.meter_id
                  WHERE ub.payment_id = p.id ORDER BY ub.created_at, ub.id LIMIT 1),
                (SELECT u.property_id FROM units u WHERE u.id = p.unit_id),
                ${leasePropertySql('p.lease_id')}) AS prop
         FROM payments p LEFT JOIN lease_fees lf ON lf.id = p.lease_fee_id
        WHERE p.id = ANY($1::uuid[]))
     SELECT b.id, b.landlord_id, b.unit_id, b.lease_id, b.tenant_id, b.type, b.entry_description, b.status,
            (b.voided_at IS NOT NULL OR b.status = 'voided') AS voided,
            b.due_date::text AS due_date, ${localDaySql('b.settled_at', 'z.tz')} AS settled_day,
            b.manual_method, b.revenue_owner, b.reversal_id, b.flexpay_advance_id, b.work_trade_settlement_id, b.space_carryforward_id,
            b.home_sale_installment_id, b.invoice_id, b.lease_fee_id, b.fee_type, b.deposit_collected_by,
            b.prop AS property_id, z.tz,
            ${cSql('b.amount')} AS amount_c, ${cSql('b.work_trade_credit')} AS wtc_c,
            ${cSql(`COALESCE((SELECT sum(cu.amount) FROM credit_uses cu
                               WHERE cu.payment_id = b.id AND cu.status IN ('applied', 'reversed')), 0)`)} AS credit_c,
            ${CATEGORY_SQL} AS category,
            EXISTS (SELECT 1 FROM deposit_returns dr WHERE dr.gap_payment_id = b.id) AS is_gap,
            EXISTS (SELECT 1 FROM deposit_returns dr WHERE dr.refund_payment_id = b.id) AS is_refund_row,
            EXISTS (SELECT 1 FROM remittance_applications ra JOIN tenant_remittances tr ON tr.id = ra.remittance_id
                     WHERE ra.payment_id = b.id AND tr.status = 'settled' AND tr.undone_at IS NULL) AS has_app,
            (EXISTS (SELECT 1 FROM flex_deposit_installments f WHERE f.payment_id = b.id)
              OR (b.type = 'deposit' AND b.lease_fee_id IS NULL
                  AND EXISTS (SELECT 1 FROM security_deposits sd
                               WHERE sd.lease_id = b.lease_id AND sd.flex_deposit_enabled IS TRUE AND sd.status <> 'voided'))) AS is_flex
            , ${SPACE_COLS_SQL('su', 'sl', 'b.created_at')}
       FROM b
       CROSS JOIN LATERAL (SELECT ${propertyTzSql('b.prop', 'b.landlord_id')} AS tz) z
       LEFT JOIN leases sl ON sl.id = b.lease_id
       LEFT JOIN units su ON su.id = COALESCE(b.unit_id, sl.unit_id)`,
    [uuids])
  for (const x of r.rows) {
    const amountCents = centsOf(x.amount_c)
    const workTradeCents = centsOf(x.wtc_c)
    const creditCents = centsOf(x.credit_c)
    let exclusion: RowExclusion | null = null
    if (x.revenue_owner === 'gam' || x.entry_description === 'FLEXPAY') exclusion = 'gam'
    else if (x.is_flex) exclusion = 'flex_deposit'
    else if (x.is_refund_row) exclusion = 'move_out_refund'
    else if (x.revenue_owner === 'held') exclusion = 'held_box'
    out.set(x.id, {
      id: x.id, landlordId: x.landlord_id, unitId: x.unit_id, leaseId: x.lease_id, tenantId: x.tenant_id,
      type: x.type, entryDescription: x.entry_description, status: x.status, voided: !!x.voided,
      dueDate: x.due_date, settledDay: x.settled_day, manualMethod: x.manual_method, revenueOwner: x.revenue_owner,
      reversalId: x.reversal_id, flexpayAdvanceId: x.flexpay_advance_id, workTradeSettlementId: x.work_trade_settlement_id, spaceCarryforwardId: x.space_carryforward_id,
      homeSaleInstallmentId: x.home_sale_installment_id, invoiceId: x.invoice_id, leaseFeeId: x.lease_fee_id,
      feeType: x.fee_type, depositCollectedBy: x.deposit_collected_by, propertyId: x.property_id, tz: x.tz,
      amountCents, workTradeCents, creditCents,
      grossCents: amountCents + workTradeCents,
      moneyCents: amountCents - creditCents,
      category: x.category as LedgerReportCategory,
      isMoveOutGap: !!x.is_gap,
      hasSettledApplication: !!x.has_app,
      exclusion,
      space: spaceOf(x),
    })
  }
  return out
}

/** The dimensions a line carries for a bill row (its property, unit, lease, tenant and the row itself). */
export function rowDims(f: PaymentFacts): LineDims {
  return { propertyId: f.propertyId, unitId: f.unitId, leaseId: f.leaseId, tenantId: f.tenantId, paymentId: f.id }
}

// ─── Where income books ─────────────────────────────────────────────────────

/** A report category's income role (design §5 category maps). */
const CATEGORY_INCOME_ROLE: Partial<Record<LedgerReportCategory, LedgerAccountRole>> = {
  space_rent: 'space_rent',
  electric: 'utility_electric',
  water: 'utility_water',
  sewer: 'utility_sewer',
  gas: 'utility_gas',
  trash: 'utility_trash',
  propane: 'utility_propane',
  utility_other: 'utility_other',
  late_fees: 'late_fees',
  other_fees: 'other_fees',
  stays_and_pay_links: 'stay_income',
  register_sales: 'register_sales',
  other_income: 'other_income',
}

/** Lease fee types that have an income account of their own (design §5: 4030 / 4040 / 4060). */
const FEE_TYPE_INCOME_ROLE: Record<string, LedgerAccountRole> = {
  application_fee: 'application_fees',
  pet_fee: 'pet_fees',
  pet_rent: 'pet_fees',
  pet_deposit: 'pet_fees',
  storage_rent: 'storage_fees',
}

/** The income role a bill row's charge credits (not for deposits, home payments or carried balances). */
export function incomeRoleFor(f: Pick<PaymentFacts, 'category' | 'feeType'>): LedgerAccountRole {
  if (f.category === 'other_fees' && f.feeType && FEE_TYPE_INCOME_ROLE[f.feeType]) return FEE_TYPE_INCOME_ROLE[f.feeType]
  const role = CATEGORY_INCOME_ROLE[f.category]
  if (!role) throw new LedgerSourceError('projector_error', `No income account for category ${f.category}`)
  return role
}

/**
 * 10/14 (Nic I1-I7): the income a bill row's `cents` credit (or, negative,
 * take back), on its line(s): rent by the space it is for (incomeLines
 * rentParts — a park-owned trailer's rent in two, lot and trailer), every
 * other category on its one role (incomeRoleFor). A charge and whatever later
 * takes it back call this with the same row, so both land on the same lines.
 */
export function incomePartsFor(f: Pick<PaymentFacts, 'category' | 'feeType' | 'space'>, cents: number): IncomePart[] {
  if (!cents) return []
  const role = incomeRoleFor(f)
  return role === 'space_rent' ? rentParts(f.space, cents, role) : [{ role, cents }]
}

/** The utility-type income role (4071-4075). */
export function utilityRoleFor(type: string | null): LedgerAccountRole {
  switch (type) {
    case 'electric': return 'utility_electric'
    case 'water': return 'utility_water'
    case 'sewer': return 'utility_sewer'
    case 'gas': return 'utility_gas'
    case 'trash': return 'utility_trash'
    default: return 'utility_other'
  }
}

// ─── Lines ──────────────────────────────────────────────────────────────────

export interface LineDims {
  propertyId?: string | null
  unitId?: string | null
  leaseId?: string | null
  tenantId?: string | null
  paymentId?: string | null
  vendorId?: string | null
  reportCategory?: LedgerReportCategory | null
  cashEffect?: LedgerCashEffect | null
  taxName?: string | null
  memo?: string | null
  sub?: DesiredLine['sub']
}

/**
 * Balanced lines in whole cents. dr/cr take a signed amount: a negative one
 * books on the other side (a negative bill is a credit memo), zero books
 * nothing (a line is never written for $0).
 */
export class Lines {
  readonly lines: DesiredLine[] = []

  dr(role: LedgerAccountRole, cents: number, dims: LineDims = {}): this { return this.put(role, cents, dims) }
  cr(role: LedgerAccountRole, cents: number, dims: LineDims = {}): this { return this.put(role, -cents, dims) }

  /** An exact account (an opening balance the owner put on an account they picked). */
  drAccount(accountId: string, cents: number, dims: LineDims = {}): this { return this.put(undefined, cents, dims, accountId) }

  get empty(): boolean { return this.lines.length === 0 }

  /** Σ debits − Σ credits, by property ('' = company level). */
  netByProperty(): Map<string, number> {
    const m = new Map<string, number>()
    for (const l of this.lines) {
      const k = l.propertyId ?? ''
      m.set(k, (m.get(k) ?? 0) + (l.debitCents ?? 0) - (l.creditCents ?? 0))
    }
    return m
  }

  private put(role: LedgerAccountRole | undefined, signed: number, dims: LineDims, accountId?: string): this {
    if (!Number.isSafeInteger(signed)) {
      throw new LedgerSourceError('projector_error', `A line amount is not whole cents (${signed}) on ${role ?? accountId}`)
    }
    if (signed === 0) return this
    const line: DesiredLine = {
      ...(role ? { role } : {}),
      ...(accountId ? { accountId } : {}),
      ...(dims.sub ? { sub: dims.sub } : {}),
      propertyId: dims.propertyId ?? null,
      unitId: dims.unitId ?? null,
      leaseId: dims.leaseId ?? null,
      tenantId: dims.tenantId ?? null,
      paymentId: dims.paymentId ?? null,
      vendorId: dims.vendorId ?? null,
      reportCategory: dims.reportCategory ?? null,
      cashEffect: dims.cashEffect ?? null,
      taxName: dims.taxName ?? null,
      memo: dims.memo ?? null,
    }
    if (signed > 0) line.debitCents = signed
    else line.creditCents = -signed
    this.lines.push(line)
    return this
  }
}

/** Splits `total` cents across `weights` in proportion (largest remainder; the parts add up exactly). */
export function splitCents(total: number, weights: readonly number[]): number[] {
  const n = weights.length
  if (n === 0) return []
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0)
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0))
  const raw = weights.map(w => (total * Math.max(0, w)) / sum)
  const floor = raw.map(x => Math.trunc(x))
  let left = total - floor.reduce((s, x) => s + x, 0)
  const order = raw.map((x, i) => ({ i, frac: Math.abs(x - Math.trunc(x)) })).sort((a, b) => b.frac - a.frac || a.i - b.i)
  const step = left >= 0 ? 1 : -1
  for (let k = 0; left !== 0 && k < order.length * 2; k++) {
    floor[order[k % order.length].i] += step
    left -= step
  }
  return floor
}

/** A UUID check for source ids (a malformed id names no row). */
export function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}
