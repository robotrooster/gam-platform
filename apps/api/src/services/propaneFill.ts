/**
 * S609 — recording a propane fill. ONE implementation, two callers.
 *
 * Lifted out of POST /propane/fills so a DELIVERY (one master bill, several
 * tanks) records each line through exactly the same code as a single fill.
 * Two copies of "how a propane fill bills" is how one path accelerates a prior
 * balance and the other quietly doesn't.
 *
 * NIC'S MODEL, in his words:
 *
 *   "We use separate tanks filled on one invoice (master) and then charge
 *    tenants according to their gallons that went into their tank... There is a
 *    master bill that comes to the property, and we assign out each station that
 *    had their fill. It's already on the bill in terms of gallons, so we just
 *    need to be able to type in this many gallons at this unit or some units
 *    that don't have it, don't get those gallons because they don't have
 *    propane. It's a per time fill... it may be once every three months."
 *
 * So it is NOT a metered utility and NOT a monthly cycle — it is an event that
 * happens when the truck comes, priced from the one invoice, split by the
 * gallons that physically went into each tank.
 */

import type { PoolClient } from 'pg'
import { propaneSplitOptions } from '@gam/shared'
import { AppError } from '../middleware/errorHandler'

const monthStart = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
const addMonths = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCMonth(d.getUTCMonth() + n)
  return monthStart(d)
}

export interface UnitFillContext {
  id: string
  landlord_id: string
  property_id: string
  unit_number: string
  /** S613: this space has a tank to fill. No tank, no fill. */
  has_propane_tank: boolean
  propane_allow_installments: boolean
  propane_split_min_gallons: string
  propane_split_four_min_gallons: string
}

/**
 * Everything that must be true BEFORE any money row is written. Separated so a
 * multi-tank delivery can check every line first: transcribing one invoice
 * should fail whole or succeed whole, never leave six tanks recorded and two
 * missing against a bill that has to reconcile.
 */
export async function validateFillLine(
  client: PoolClient,
  unit: UnitFillContext,
  args: { gallons: number; installments: number },
): Promise<{ leaseId: string; tenantId: string }> {
  // S613 (Nic): "You need to link which units even HAVE tanks to be filled so
  // that you can record the event in the first place." A fill against a space
  // with no tank on record is a transcription slip — the delivery form no longer
  // offers those units, so reaching here means the wrong line got typed.
  if (!unit.has_propane_tank) {
    throw new AppError(400,
      `Unit ${unit.unit_number} has no propane tank on record. Mark it under Utilities on the ` +
      `unit's page — that is what tells the delivery form which spaces to offer.`)
  }
  const lt = await client.query<{ lease_id: string; tenant_id: string }>(
    `SELECT vlat.lease_id, vlat.tenant_id
       FROM v_lease_active_tenants vlat
       JOIN leases l ON l.id = vlat.lease_id
      WHERE l.unit_id = $1 AND l.status = 'active' AND vlat.role = 'primary'
      LIMIT 1`, [unit.id])
  if (!lt.rows[0]) {
    throw new AppError(400, `Unit ${unit.unit_number} has no active lease — a propane fill bills the tenant`)
  }
  if (args.installments > 1) {
    if (!unit.propane_allow_installments) {
      throw new AppError(400, 'Split payments are not enabled for this property')
    }
    const opts = propaneSplitOptions(
      args.gallons,
      Number(unit.propane_split_min_gallons),
      Number(unit.propane_split_four_min_gallons))
    if (!opts.includes(args.installments)) {
      throw new AppError(400, `A ${args.gallons} gal fill on ${unit.unit_number} can't split into ${args.installments} payments`)
    }
  }
  return { leaseId: lt.rows[0].lease_id, tenantId: lt.rows[0].tenant_id }
}

/**
 * Write one fill: the fill row, its installments, the immediate first charge,
 * and the acceleration of any prior unbilled balance on that unit.
 *
 * Caller owns the transaction and must have taken the per-unit advisory lock.
 */
export async function recordFill(
  client: PoolClient,
  args: {
    unit: UnitFillContext
    leaseId: string
    tenantId: string
    gallons: number
    pricePerGallon: number
    installments: number
    createdByUserId: string
    clientKey?: string | null
    /** S613: this tank's share of the ticket's delivery charge. Untaxed. */
    deliveryFeeShare?: number
    // S632: what the delivery cost and what was added to it. Snapshotted so a
    // fill explains itself later without depending on today's markup setting.
    trueCostPerGallon?: number | null
    markupPerGallon?: number | null
    invoiceTotal?: number | null
    invoiceGallons?: number | null
  },
): Promise<any> {
  const { unit } = args

  // Landlord-configured propane tax (S533) — snapshot on the fill; installments
  // split the tax-inclusive total.
  const taxRow = await client.query<{ tax_rate_pct: string }>(
    `SELECT tax_rate_pct FROM property_utility_tax_rates
      WHERE property_id = $1 AND utility_type = 'propane'`, [unit.property_id])
  const taxRatePct = Number(taxRow.rows[0]?.tax_rate_pct || 0)
  const subtotal = Math.round(args.gallons * args.pricePerGallon * 100) / 100
  const taxAmount = Math.round(subtotal * taxRatePct) / 100
  // S613: the delivery charge rides on TOP of the taxed fuel. The propane tax
  // rate is a fuel tax on the gallons — applying it to a hazmat or per-stop fee
  // would invent a tax the landlord never configured.
  const deliveryFee = Math.round((args.deliveryFeeShare ?? 0) * 100) / 100
  const total = Math.round((subtotal + taxAmount + deliveryFee) * 100) / 100

  // S609 (Nic): THE SPLIT IS IN GALLONS. "If it's a hundred and ninety gallons,
  // you do three forty-eights and then a forty-six." Even gallons to the nearest
  // whole, the LAST installment carrying the remainder so the pieces sum to the
  // fill exactly — a tenant can check 48 gallons against their tank in a way
  // they can never check a quarter of a dollar figure.
  //
  // Dollars follow the gallons rather than being split themselves, so each
  // installment's amount is honestly "these gallons at this price".
  const perGallonWithTax = args.gallons > 0 ? total / args.gallons : 0
  const evenGallons = Math.round(args.gallons / args.installments)
  const gallonsSplit = Array.from({ length: args.installments }, (_, i) =>
    i === args.installments - 1
      ? Math.round((args.gallons - evenGallons * (args.installments - 1)) * 100) / 100
      : evenGallons)
  const amounts = gallonsSplit.map((g, i) =>
    i === args.installments - 1
      // The last amount is what's LEFT of the total, so the money reconciles to
      // the fill even where rounded gallons don't divide cleanly.
      ? Math.round((total - gallonsSplit.slice(0, -1)
          .reduce((sum, gg) => sum + Math.round(gg * perGallonWithTax * 100) / 100, 0)) * 100) / 100
      : Math.round(g * perGallonWithTax * 100) / 100)

  const fill = await client.query<any>(
    `INSERT INTO propane_fills
       (property_id, landlord_id, unit_id, lease_id, tenant_id, gallons,
        price_per_gallon, total_amount, installment_count, created_by_user_id,
        tax_rate_pct, tax_amount, client_key, delivery_fee_share,
        true_cost_per_gallon, markup_per_gallon, invoice_total, invoice_gallons)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [unit.property_id, unit.landlord_id, unit.id, args.leaseId, args.tenantId,
     args.gallons, args.pricePerGallon, total, args.installments, args.createdByUserId,
     taxRatePct, taxAmount, args.clientKey ?? null, deliveryFee,
     args.trueCostPerGallon ?? null, args.markupPerGallon ?? null,
     args.invoiceTotal ?? null, args.invoiceGallons ?? null])
  const fillId = fill.rows[0].id

  // S609 (Nic): NOTHING BILLS IMMEDIATELY. "All decided before any money moves."
  //
  // Installment #1 used to be charged the instant the fill was recorded, as a
  // standalone due-today row outside any invoice. That landed mid-month and —
  // because rent is pay-in-full — could stop the tenant paying their RENT until
  // they could also cover the propane. A fill is not an emergency; it rides the
  // next bill like everything else.
  //
  // The whole schedule is written now and never moves: an August fill split four
  // ways bills September, October, November, December. That fixed schedule is
  // what lets the tenant see what is coming instead of being surprised monthly.
  //
  // S609 (Nic): FILLS QUEUE BEHIND EACH OTHER — "It shouldn't overlap on the
  // December invoice. That's not really a thing." An August fill split four ways
  // runs Sep–Dec; a November refill starts in JANUARY, after the last scheduled
  // installment, so an invoice never carries two propane installments at once.
  // One propane line per bill, always.
  const lastScheduled = await client.query<{ last: string | null }>(
    `SELECT MAX(i.billing_cycle_month)::text AS last
       FROM propane_fill_installments i
       JOIN propane_fills f ON f.id = i.fill_id
      WHERE f.unit_id = $1 AND i.payment_id IS NULL`,
    [unit.id])
  const nextFree = lastScheduled.rows[0]?.last
    ? addMonths(lastScheduled.rows[0].last, 1)
    : null
  const nextMonth = addMonths(monthStart(new Date()), 1)
  // Whichever is later: next month, or the month after everything already queued.
  const firstCycle = nextFree && nextFree > nextMonth ? nextFree : nextMonth

  for (let i = 0; i < args.installments; i++) {
    await client.query(
      `INSERT INTO propane_fill_installments
         (fill_id, installment_number, amount, gallons, billing_cycle_month, payment_id)
       VALUES ($1,$2,$3,$4,$5,NULL)`,
      [fillId, i + 1, amounts[i].toFixed(2), gallonsSplit[i],
       addMonths(firstCycle, i)])
  }

  // ACCELERATION REMOVED (S609, Nic — supersedes the earlier rule).
  //
  // A new fill used to make the ENTIRE prior balance due immediately: every
  // not-yet-billed installment from earlier fills became a standalone due-now
  // payment. The reasoning was that the refill truck doesn't coordinate with the
  // office, so a tenant could stack fills.
  //
  // That is incompatible with the model Nic specified: "All decided before any
  // money moves", with each installment landing on a known future invoice. It
  // also re-created the exact harm the immediate charge was removed for — a
  // mid-month due-now row that, under pay-in-full, can block the tenant paying
  // their RENT. A tenant two fills deep would suddenly owe both in full.
  //
  // Two overlapping fills simply run two schedules; each month's invoice carries
  // whatever installments fall in it, and that month's total is pay-in-full like
  // any other bill. Nothing is forgiven and nothing is hidden — it is spread the
  // way the landlord chose when they recorded the fill.
  //
  // If stacking ever needs a brake, the right one is a limit on recording a new
  // fill while a balance is open — a decision at the counter, not a surprise on
  // the tenant's ledger.

  return fill.rows[0]
}

/**
 * S609 (Nic): AT MOVE-OUT, every remaining propane installment comes due.
 *
 *   "We need to set it where any future installments preset for propane become
 *    due in full on a final bill at a move out. That's the only place where
 *    acceleration would still be needed."
 *
 * This is the one acceleration that survives, and it is the opposite case from
 * the one removed. Accelerating on a NEW FILL punished a tenant who was still
 * living there and paying on schedule. Accelerating at MOVE-OUT collects propane
 * that has already been delivered and burned from the person who used it — there
 * is no future invoice left to put it on, so unbilled means unbilled forever and
 * the landlord eats it.
 *
 * The move-out sweep (services/depositReturn) reads `payments` rows, and a
 * scheduled installment is deliberately NOT one until its month arrives. So the
 * schedule has to be turned into real charges here or it is invisible at exactly
 * the moment it must be counted.
 *
 * Idempotent: only installments with no payment yet are billed, so re-opening a
 * deposit return cannot charge twice.
 */
export async function billRemainingPropaneAtMoveOut(
  client: PoolClient,
  leaseId: string,
): Promise<{ billed: number; amount: number }> {
  const pending = await client.query<{
    id: string; amount: string; gallons: string | null
    installment_number: number; installment_count: number
    unit_id: string; tenant_id: string; landlord_id: string; fill_gallons: string
  }>(
    `SELECT i.id, i.amount::text, i.gallons::text,
            i.installment_number, f.installment_count,
            f.unit_id, f.tenant_id, f.landlord_id, f.gallons::text AS fill_gallons
       FROM propane_fill_installments i
       JOIN propane_fills f ON f.id = i.fill_id
      WHERE f.lease_id = $1 AND i.payment_id IS NULL
      ORDER BY f.fill_date, i.installment_number
      FOR UPDATE OF i`,
    [leaseId])

  let amount = 0
  for (const inst of pending.rows) {
    const pay = await client.query<{ id: string }>(
      `INSERT INTO payments
         (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
          due_date, entry_description, notes)
       VALUES ($1,$2,$3,$4,'utility',$5,'pending',CURRENT_DATE,'PROPANE',$6)
       RETURNING id`,
      [inst.unit_id, leaseId, inst.tenant_id, inst.landlord_id,
       Number(inst.amount).toFixed(2),
       `Propane — payment ${inst.installment_number} of ${inst.installment_count}` +
       (inst.gallons ? ` (${Number(inst.gallons)} gal)` : '') +
       ' — due in full at move-out'])
    await client.query(
      `UPDATE propane_fill_installments SET payment_id = $1 WHERE id = $2`,
      [pay.rows[0].id, inst.id])
    amount = Math.round((amount + Number(inst.amount)) * 100) / 100
  }
  return { billed: pending.rows.length, amount }
}
