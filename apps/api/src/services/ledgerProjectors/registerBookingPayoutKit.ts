/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P5: WHAT THE REGISTER, BOOKING AND
 * PAYOUT PROJECTORS SHARE
 *
 * The P5 projectors (register sales, refunds and set-aside payments; bookings;
 * the payout chain and GAM's charges — gam-ledger-design-2026-10-12 §6 F, G, H)
 * all read money rows the same few ways. Said once here:
 *
 *   - cents: every figure is whole cents (an integer) from the moment it is read;
 *   - signed lines: dr()/cr() write one line on a posting role, on the other
 *     side when the figure is negative, and nothing when it is zero (the engine
 *     refuses a zero line);
 *   - days: an event's day is its local calendar day — the property's time zone,
 *     else the company's books calendar (landlords.books_timezone, else the
 *     first property's, else America/Phoenix: the same fallback the engine
 *     reads, services/ledgerOwner) — read in SQL as 'YYYY-MM-DD' text;
 *   - splitting: a whole is split over weights by largest remainder, so the
 *     pieces always add back to the whole to the cent;
 *   - a register sale's make-up (saleMakeUp): what of it was GAM's background
 *     check, which taxes it carried (lodging vs sales tax, by name), what paid a
 *     stay (stay_payments) and what was goods — read by the sale, its refunds,
 *     a chargeback on it, and the stay it paid.
 *
 * Every projector here only READS committed facts (services/
 * ledgerProjectorPurity.test.ts): stored amounts and dates, never where GAM's
 * copy of the money sits now, never today's settings or rates.
 */
import type { PoolClient } from 'pg'
import type { LedgerAccountRole } from '@gam/shared'
import type { DesiredLine } from '../ledgerEngine'
import { LedgerSourceError } from '../ledgerEngine'

// ─── Cents and lines ─────────────────────────────────────────────────────────

/** A numeric column (text or number) as whole cents. */
export function toCents(v: string | number | null | undefined): number {
  return Math.round((Number(v) || 0) * 100)
}

/** Everything a line carries besides its role and side. */
export type LineExtra = Omit<DesiredLine, 'role' | 'debitCents' | 'creditCents' | 'accountId'>

/** A debit of `cents` on `role` — a credit when negative, nothing when zero. */
export function dr(role: LedgerAccountRole, cents: number, extra: LineExtra = {}): DesiredLine[] {
  if (!cents) return []
  return cents > 0 ? [{ ...extra, role, debitCents: cents }] : [{ ...extra, role, creditCents: -cents }]
}

/** A credit of `cents` on `role` — a debit when negative, nothing when zero. */
export function cr(role: LedgerAccountRole, cents: number, extra: LineExtra = {}): DesiredLine[] {
  return dr(role, -cents, extra)
}

/**
 * `total` cents split over `weights` (any non-negative numbers) by largest
 * remainder: the pieces add back to `total` exactly. All-zero weights put
 * everything on the first piece; no weights, nothing.
 */
export function splitCents(total: number, weights: number[]): number[] {
  if (!weights.length) return []
  const sum = weights.reduce((a, w) => a + Math.max(0, w), 0)
  if (!(sum > 0)) return weights.map((_, i) => (i === 0 ? total : 0))
  const sign = total < 0 ? -1 : 1
  const abs = Math.abs(total)
  const raw = weights.map(w => (abs * Math.max(0, w)) / sum)
  const out = raw.map(Math.floor)
  let left = abs - out.reduce((a, b) => a + b, 0)
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (let j = 0; left > 0 && j < order.length; j++, left--) out[order[j].i]++
  return out.map(c => c * sign)
}

/** Sums lines' debits minus credits (cents). */
export function netOf(lines: DesiredLine[]): number {
  return lines.reduce((a, l) => a + (l.debitCents ?? 0) - (l.creditCents ?? 0), 0)
}

// ─── Days ────────────────────────────────────────────────────────────────────

/** SQL: the company's books calendar for a landlord id expression (ledgerOwner's fallback). */
export function companyTzSql(landlordExpr: string): string {
  return `COALESCE((SELECT kl.books_timezone FROM landlords kl WHERE kl.id = ${landlordExpr}),
                   (SELECT kp.timezone FROM properties kp
                     WHERE kp.landlord_id = ${landlordExpr} AND kp.timezone IS NOT NULL
                     ORDER BY kp.created_at, kp.id LIMIT 1),
                   'America/Phoenix')`
}

/** SQL: a property's time zone, else its company's books calendar. */
export function propertyTzSql(propertyExpr: string, landlordExpr: string): string {
  return `COALESCE((SELECT kq.timezone FROM properties kq WHERE kq.id = ${propertyExpr}), ${companyTzSql(landlordExpr)})`
}

/** SQL: the local 'YYYY-MM-DD' day of a timestamptz in a time zone expression. */
export function localDaySql(tsExpr: string, tzExpr: string): string {
  return `((${tsExpr}) AT TIME ZONE (${tzExpr}))::date::text`
}

// ─── Refusals ────────────────────────────────────────────────────────────────

/** A stored fact the projector needs is missing (design §4 M2: the source waits, named). */
export function missingFact(message: string): LedgerSourceError {
  return new LedgerSourceError('missing_fact', message)
}

/** Something the books cannot post until a product rule is set (the source waits with the reason). */
export function waitsOnRule(message: string): LedgerSourceError {
  return new LedgerSourceError('projector_error', message)
}

// ─── Taxes ───────────────────────────────────────────────────────────────────

/** The name the register and pay links give a stay's lodging tax (posPayLinks.withLodgingTax). */
export const LODGING_TAX_NAME = 'Lodging tax'

export interface TaxPart { name: string | null; lodging: boolean; cents: number }

/** The posting lines for tax parts (credits by default): lodging tax to 2042, every other named tax to its own 2040 sub-account. */
export function taxLines(parts: TaxPart[], side: 'cr' | 'dr', extra: LineExtra = {}): DesiredLine[] {
  const out: DesiredLine[] = []
  for (const t of parts) {
    if (!t.cents) continue
    const base: LineExtra = { ...extra, taxName: t.name ?? null }
    const write = side === 'cr' ? cr : dr
    if (t.lodging) out.push(...write('lodging_tax_payable', t.cents, base))
    else if (t.name) out.push(...write('sales_tax_payable', t.cents, { ...base, sub: { kind: 'sales_tax', value: t.name } }))
    else out.push(...write('sales_tax_payable', t.cents, base))
  }
  return out
}

/** `cents` of tax split like `parts` (the sale's own mix), adding back exactly. */
export function scaleTaxParts(parts: TaxPart[], cents: number): TaxPart[] {
  if (!cents) return []
  if (!parts.length) return [{ name: null, lodging: false, cents }]
  const pieces = splitCents(cents, parts.map(p => Math.abs(p.cents)))
  return parts.map((p, i) => ({ ...p, cents: pieces[i] })).filter(p => p.cents !== 0)
}

// ─── A register sale and what it was made of ─────────────────────────────────

export interface SaleRow {
  id: string
  landlord_id: string
  property_id: string | null
  tenant_id: string | null
  payment_method: string
  subtotal: string
  discount_amount: string
  tax_amount: string
  surcharge: string
  total: string
  platform_fee: string
  stripe_payment_intent_id: string | null
  pay_link_id: string | null
  status: string
  voided_at: string | null
  tax_breakdown: { name?: string; rate?: number; amount?: number }[] | null
  /** The sale's local day (its property's calendar, else the company's). */
  day: string
}

/** One sale, with its local day; null when it is gone. */
export async function loadSale(client: PoolClient, saleId: string): Promise<SaleRow | null> {
  const r = await client.query<SaleRow>(
    `SELECT t.id, t.landlord_id, t.property_id, t.tenant_id, t.payment_method,
            t.subtotal::text, t.discount_amount::text, t.tax_amount::text, t.surcharge::text, t.total::text,
            t.platform_fee::text, t.stripe_payment_intent_id, t.pay_link_id, t.status, t.voided_at::text,
            t.tax_breakdown,
            ${localDaySql('t.created_at', propertyTzSql('t.property_id', 't.landlord_id'))} AS day
       FROM pos_transactions t WHERE t.id::text = $1`, [saleId])
  return r.rows[0] ?? null
}

export interface SaleStayShare {
  bookingId: string
  unitId: string | null
  propertyId: string | null
  tenantId: string | null
  /** What the sale paid toward the stay, its lodging tax inside (stay_payments.toward_stay). */
  towardCents: number
  /** The sale's lodging tax that was this stay's. */
  lodgingTaxCents: number
  /** The stay's money before tax — what the stay earns. */
  preTaxCents: number
}

export interface SaleMakeUp {
  /** GAM's background-check money the sale carried (screening_prepayments recorded with it). */
  screeningCents: number
  /** subtotal − discount − background check: the sale's own money before tax. */
  preTaxCents: number
  /** The stays the sale paid toward. */
  stays: SaleStayShare[]
  /** The rest of preTaxCents: register goods. */
  goodsPreTaxCents: number
  /** The taxes the sale charged, adding up to tax_amount. */
  taxParts: TaxPart[]
}

/**
 * What a register sale was made of, from the sale and the rows written with it
 * (its stay payments and the background check recorded for it — both written in
 * the sale's own transaction, never changed after).
 *
 * The background check: every screening_prepayments row recorded against the
 * sale or the pay link it paid (the register's own refund rule reads the same
 * rows), whatever became of it later — a check voided by a chargeback was still
 * GAM's money on the sale's day.
 */
export async function saleMakeUp(client: PoolClient, sale: SaleRow): Promise<SaleMakeUp> {
  const scr = await client.query<{ s: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS s FROM screening_prepayments
      WHERE source_id IS NOT NULL AND source_id IN ($1, $2)`, [sale.id, sale.pay_link_id ?? sale.id])
  const screeningCents = toCents(scr.rows[0]?.s)
  const preTaxCents = toCents(sale.subtotal) - toCents(sale.discount_amount) - screeningCents
  const taxCents = toCents(sale.tax_amount)

  const stayRows = (await client.query<{
    booking_id: string; unit_id: string | null; property_id: string | null; tenant_id: string | null; toward: string
  }>(
    `SELECT sp.booking_id, b.unit_id, u.property_id, b.tenant_id, SUM(sp.toward_stay)::text AS toward
       FROM stay_payments sp
       LEFT JOIN unit_bookings b ON b.id = sp.booking_id
       LEFT JOIN units u ON u.id = b.unit_id
      WHERE sp.pos_transaction_id::text = $1 AND sp.kind = 'pos_sale'
      GROUP BY sp.booking_id, b.unit_id, u.property_id, b.tenant_id
      ORDER BY sp.booking_id`, [sale.id])).rows

  // The taxes, by name: the breakdown scaled to tax_amount (it is the amount
  // the customer paid). No breakdown: one unnamed tax — a stay's lodging tax
  // when the sale paid a stay, else sales tax.
  const breakdown = Array.isArray(sale.tax_breakdown)
    ? sale.tax_breakdown.filter(b => b && typeof b.name === 'string' && Number(b.amount) > 0)
    : []
  let taxParts: TaxPart[]
  if (!taxCents) taxParts = []
  else if (breakdown.length) {
    const pieces = splitCents(taxCents, breakdown.map(b => toCents(b.amount)))
    const merged = new Map<string, TaxPart>()
    breakdown.forEach((b, i) => {
      const name = String(b.name)
      const prior = merged.get(name)
      if (prior) prior.cents += pieces[i]
      else merged.set(name, { name, lodging: name === LODGING_TAX_NAME, cents: pieces[i] })
    })
    taxParts = [...merged.values()].filter(t => t.cents !== 0)
  } else {
    taxParts = [{ name: stayRows.length ? LODGING_TAX_NAME : null, lodging: stayRows.length > 0, cents: taxCents }]
  }

  // Each stay's share of the lodging tax: by what the sale paid toward it,
  // never more than that.
  const lodgingCents = taxParts.filter(t => t.lodging).reduce((a, t) => a + t.cents, 0)
  const towards = stayRows.map(s => toCents(s.toward))
  const lodgingShares = splitCents(Math.min(lodgingCents, towards.reduce((a, b) => a + b, 0)), towards)
  let stays: SaleStayShare[] = stayRows.map((s, i) => ({
    bookingId: s.booking_id, unitId: s.unit_id, propertyId: s.property_id, tenantId: s.tenant_id,
    towardCents: towards[i], lodgingTaxCents: Math.min(lodgingShares[i] ?? 0, towards[i]),
    preTaxCents: towards[i] - Math.min(lodgingShares[i] ?? 0, towards[i]),
  }))
  // The stays can never take more than the sale's own money before tax.
  const stayTotal = stays.reduce((a, s) => a + s.preTaxCents, 0)
  if (stayTotal > Math.max(0, preTaxCents)) {
    const scaled = splitCents(Math.max(0, preTaxCents), stays.map(s => s.preTaxCents))
    stays = stays.map((s, i) => ({ ...s, preTaxCents: scaled[i] }))
  }
  const goodsPreTaxCents = preTaxCents - stays.reduce((a, s) => a + s.preTaxCents, 0)
  return { screeningCents, preTaxCents, stays, goodsPreTaxCents, taxParts }
}

/**
 * Is the register's stock counted per item sold on `day`? The company's
 * choice (Nic 10/12 L8) in force on that day: 10/12 (Nic, ledger review) every
 * change is kept (books_register_stock_changes, migration 20261014170100, with
 * the first day each applies; NULL = from the books start), and the sale reads
 * the latest one on or before its own day (the later of two the same day) — so
 * a change of mind, however many, never re-dates a sale already booked, and a
 * rebuild comes out the same. A company that never changed it has no rows and
 * reads its one choice (landlords.books_register_stock).
 */
export async function costPerItemSoldOn(client: PoolClient, landlordId: string, day: string): Promise<boolean> {
  const r = await client.query<{ method: string | null }>(
    `SELECT COALESCE(
       (SELECT c.method FROM books_register_stock_changes c
         WHERE c.landlord_id = $1 AND (c.effective_from IS NULL OR c.effective_from <= $2::date)
         ORDER BY c.effective_from DESC NULLS LAST, c.id DESC LIMIT 1),
       (SELECT CASE WHEN l.books_register_stock_from IS NULL OR l.books_register_stock_from <= $2::date
                    THEN l.books_register_stock
                    WHEN l.books_register_stock = 'cost_per_item_sold' THEN 'expense_when_bought'
                    ELSE 'cost_per_item_sold' END
          FROM landlords l WHERE l.id = $1)) AS method`, [landlordId, day])
  return r.rows[0]?.method === 'cost_per_item_sold'
}
