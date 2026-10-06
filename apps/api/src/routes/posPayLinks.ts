/**
 * S648 (Nic) — register pay links: charges for people who are not on a lease.
 *
 *   "We need a way to generate an item, a charge and send it to a link so they
 *    can pay by email... people that stay by the night or by the week... we sell
 *    propane. A lot of people want to pay with card. People that want to use the
 *    dump station, having the QR code for the dump station so people can scan
 *    it, pay their bill."
 *
 * The desk rings up a cart as usual and, instead of taking money, sends it as a
 * link. The link opens Stripe's own card page — GAM hosts no public payment form.
 * The customer pays the usual card fee on top (as with rent). When Stripe says it
 * is paid, the sale is recorded exactly like a counter card sale
 * (services/posSale) and any stay attached to it is confirmed on the schedule.
 *
 * one_time — emailed to one person; closes when paid.
 * standing — one item for anyone, behind a printed QR code (the dump station).
 *            Stays open; every payment is its own sale.
 */
import { Router } from 'express'
import type { PoolClient } from 'pg'
import crypto from 'crypto'
import QRCode from 'qrcode'
import { z } from 'zod'
import { cardFeeSplit, STAY_TERMS, STAY_SCREENING_NIGHTS, STAY_LEASE_CHOICE_NIGHTS, stayHeldWords, type CardFeePayer, type StayTerms } from '@gam/shared'
import { db, query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm, assertPropertyInScope } from '../middleware/auth'
import { canManageLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { computeCartTotals } from '../services/posTax'
import { insertPosSale } from '../services/posSale'
import { activateBillingForMoneyMoved } from '../services/billingActivation'
import { recordSaleTowardStay } from '../services/stayPayments'
import { logger } from '../lib/logger'
import { replyToProperty } from '../services/replyRouting'
import {
  personOnSale, residentRecord, applyCardToPerson, withSavepoint, searchPeople, peopleQueryGuard, peopleSearchLimiter, crossCompanyLimiter,
  parseForStaff, cartLineWords, NOT_ON_REGISTER, PICK_GONE, lowerLineIds, assertItemsAreOurs, customerFromElsewhere,
  assertWholeStays,
} from '../services/posPeople'
import { readSaleCard, findOrCreateCustomerForCard, type CardIdentity } from '../services/posCustomerCards'
import { DateTime } from 'luxon'
import { reservationDue, checkOutFor, releaseReservationTickets, ticketCarriesStay, stayTaxRate, taxInsidePayment,
  priceWholeStay, leaseDepositFor, stayExtensionQuote, extendStayByMonth, undoStayExtension, SCREENING_LINE_NAME,
  type ReservationDue } from '../services/registerStay'
import { stayNeeds, recordScreeningPrepayment, markScreeningRequired, chooseStayTerms, continuousStayNights, syncStayUtilityAgreement, screeningPaidForStay, type ScreeningCollectedBy } from '../services/stayTerms'

export const posPayLinksRouter = Router()
posPayLinksRouter.use(requireAuth)

const apiBase = () => (process.env.API_PUBLIC_URL || 'http://localhost:4000').replace(/\/$/, '')
export const payLinkUrl = (token: string) => `${apiBase()}/api/public/pay/${token}`

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * What a link charges by card. GAM's fee is always taken; the property's
 * setting when the link was made decides whether it's added on top (S648).
 */
export function payLinkCharge(total: number, payer: CardFeePayer = 'customer'): { fee: number; charged: number; held: number; customerFee: number } {
  const split = cardFeeSplit(total, payer)
  return { ...split, customerFee: payer === 'customer' ? split.fee : 0 }
}

const payerOf = (link: { card_fee_on_top: boolean }): CardFeePayer => link.card_fee_on_top ? 'customer' : 'landlord'

async function connectIdFor(landlordId: string): Promise<string | null> {
  // The payout account the landlord's share is sent to in the weekly batch
  // (S554: the entity's, else the founding owner's during the transition).
  // The charge itself is GAM's (S648) — no link goes out without somewhere
  // to pay the landlord.
  const row = await queryOne<{ id: string | null }>(
    `SELECT COALESCE(l.stripe_connect_account_id, u.stripe_connect_account_id) AS id
       FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`, [landlordId])
  return row?.id ?? null
}

const itemSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(120),
  cat: z.string().max(60).optional(),
  qty: z.number().positive(),
  price: z.number().nonnegative(),
  tax: z.number().nonnegative().optional(),
  // 10/3 (review): a stay's line carries the figure the register showed for it
  // (its site and nights, priced by the schedule) — a link never goes out at a
  // figure the clerk did not see (createPayLink refuses one that differs).
  stayTotal: z.number().nonnegative().optional(),
})

const createSchema = z.object({
  propertyId: z.string().uuid(),
  kind: z.enum(['one_time', 'standing']).default('one_time'),
  label: z.string().max(120).optional(),
  items: z.array(itemSchema).min(1),
  discountAmount: z.number().nonnegative().optional(),
  customer: z.object({
    name: z.string().max(120).optional(),
    email: z.string().email().optional(),
    phone: z.string().max(40).optional(),
  }).optional(),
  tenantId: z.string().uuid().optional(),
  posCustomerId: z.string().uuid().optional(),
  // 10/2 (review): someone found on GAM outside this company — the sealed pick
  // the search handed out. Their record here is made when the link is sent,
  // never at the pick (backing out of a pick leaves nothing behind).
  match: z.object({ pick: z.string().max(2000) }).optional(),
  bookingId: z.string().uuid().optional(),
  // S652 (Nic): a stay sold down this route takes the site off the board.
  // "Think of the stays like almost inventory where I've only got so many sites
  // on January 12th... when I send a pay link, it should use up inventory
  // according to what spot was booked and for how long."
  stay: z.object({
    // A new stay: its site, arrival and guest. 10/5 (Nic, R6): or, for "Add a
    // month", the stay here now that the month lengthens (extendBookingId).
    unitId:     z.string().uuid().nullish(),
    checkIn:    z.string().nullish(),
    guestName:  z.string().max(120).nullish(),
    guestPhone: z.string().max(40).nullish(),
    guestEmail: z.string().email().nullish(),
    /** 10/5 (Nic, R2): the counter's answer for a stay of 30+ nights. */
    stayTerms:  z.enum(STAY_TERMS).nullish(),
    extendBookingId: z.string().uuid().nullish(),
    /** 10/5 (Nic, R8): the background check's fee as the register showed it. */
    screeningFee: z.number().nonnegative().nullish(),
  }).optional(),
})

/**
 * 10/2 (front desk foolproof): what the clerk is told when a link's form cannot
 * be read — plain words and the button to press, never "items.0.qty: Number
 * must be greater than 0". `press` is the button on the screen that sent it.
 */
function linkWords(press: string): Record<string, string> {
  return {
    propertyId: `Pick the property at the top of the register first, then press ${press} again.`,
    kind: `Something on this link could not be read — close the window, open it again, then press ${press}.`,
    label: `That label is too long — shorten it to 120 characters, then press ${press} again.`,
    items: `The cart is empty — add what they are paying for, then press ${press} again.`,
    ...cartLineWords(press),
    discountAmount: `A discount cannot be below zero — fix it, then press ${press} again.`,
    'customer.name': `That name is too long — shorten it, then press ${press} again.`,
    'customer.email': `That email does not look right — check it, then press ${press} again.`,
    'customer.phone': `That phone number is too long — check it, then press ${press} again.`,
    tenantId: NOT_ON_REGISTER,
    posCustomerId: NOT_ON_REGISTER,
    match: PICK_GONE,
    bookingId: `That stay could not be found — pick the site and dates again, then press ${press} again.`,
    'stay.guestName': `That guest name is too long — shorten it, then press ${press} again.`,
    'stay.guestEmail': `That email does not look right — check it, then press ${press} again.`,
    'stay.guestPhone': `That phone number is too long — check it, then press ${press} again.`,
    'stay.stayTerms': `Pick Lease or No lease for the stay again, then press ${press} again.`,
    'stay.extendBookingId': `Pick the stay to add a month to again, then press ${press} again.`,
    'stay.screeningFee': `Pick the site and dates again (that shows the background check's fee), then press ${press} again.`,
    stay: `Pick the site and the arrival date again, then press ${press} again.`,
  }
}
const LINK_PROPERTY_FIRST = 'Pick the property at the top of the register first.'

async function propertyFor(req: any, propertyId: string) {
  const prop = await queryOne<{ id: string; name: string; landlord_id: string; register_card_fee_payer: CardFeePayer }>(
    `SELECT id, name, landlord_id, register_card_fee_payer FROM properties WHERE id = $1`, [propertyId])
  if (!prop) throw new AppError(404, 'That property is not on this account — pick the property at the top of the register, then try again.')
  if (!canManageLandlordResource(req.user, prop.landlord_id)) throw new AppError(403, 'That property is not on this account — pick the property at the top of the register, then try again.')
  await assertPropertyInScope(req.user, propertyId)
  return prop
}

/**
 * 10/2 (review): every stay line in an adjusted link is one the link already
 * had — the same item at the same price, and no more nights than it carried.
 * 10/3 (decisions #23): and no FEWER either — a reservation's nights change
 * only on the schedule (assertLinkStayWhole, after the reservation is read).
 */
async function assertLinkStaysKept(link: any, items: any[]): Promise<void> {
  // 10/2 (review): compared lowercase — an id sent in capitals is the same item.
  const idOf = (x: unknown) => (typeof x === 'string' ? x.trim().toLowerCase() : '')
  const ids = [...new Set(items.map((i) => idOf(i?.id)).filter((x) => /^[0-9a-f-]{36}$/.test(x)))]
  if (!ids.length) return
  const stays = await query<{ id: string; name: string }>(
    `SELECT id, name FROM pos_items WHERE id = ANY($1::uuid[]) AND landlord_id = $2 AND stay_unit IS NOT NULL`, [ids, link.landlord_id])
  if (!stays.length) return
  const key = (id: unknown, price: unknown) => `${idOf(id)}:${(Number(price) || 0).toFixed(2)}`
  const left = new Map<string, number>()
  for (const l of (Array.isArray(link.items) ? link.items : [])) {
    if (l?.id) left.set(key(l.id, l.price), (left.get(key(l.id, l.price)) ?? 0) + (Number(l.qty) || 0))
  }
  for (const it of items) {
    const s = stays.find((x) => x.id === idOf(it?.id))
    if (!s) continue
    const k = key(it.id, it.price)
    const have = left.get(k) ?? 0
    const q = Number(it.qty) || 0
    if (have <= 0 || q > have + 1e-9) {
      throw new AppError(400, `"${s.name}" is a stay — a link keeps the stay it was sent with, at its price; its nights, site and price change only on the schedule. `
        + 'Put that line back the way it was, then press Save changes; ring another stay on its own, with a site and dates.')
    }
    left.set(k, have - q)
  }
}

/**
 * 10/2 (review): a line with no register item is an amount somebody typed.
 * Only staff who may set prices send one — a cashier without "Apply
 * discounts" could otherwise send themselves a one-time link with a typed-in
 * "Propane" line at $1 and settle it at the desk in cash. Adjusting a link may
 * keep its OWN typed lines (the same name and price, and no more of them) —
 * the stay balance or deposit the system wrote, for instance.
 */
async function assertOneOffLinesAllowed(req: any, items: any[], kind: 'one_time' | 'standing', own: any[] = []): Promise<void> {
  const { canSetPrices } = await import('./pos')
  if (canSetPrices(req.user)) return
  const key = (l: any) => `${String(l?.name ?? '')}|${(Number(l?.price) || 0).toFixed(2)}`
  const left = new Map<string, number>()
  for (const l of own) if (!l?.id) left.set(key(l), (left.get(key(l)) ?? 0) + (Number(l?.qty) || 0))
  for (const it of items) {
    if (it?.id) continue
    const have = left.get(key(it)) ?? 0
    const q = Number(it?.qty) || 0
    if (have > 0 && q <= have + 1e-9) { left.set(key(it), have - q); continue }
    throw new AppError(403, kind === 'standing'
      ? 'Setting the price on a QR code needs the "Apply discounts" permission — ask the owner or a manager to make it.'
      : 'One-off amounts need the "Apply discounts" permission — ask the owner or a manager, or ring it from a register button.')
  }
}

type Q = Pick<PoolClient, 'query'>

/** The stay a pay link holds: its one stay line and the booking that holds the site. */
export interface LinkStay { bookingId: string; itemId: string; name: string; stayUnit: 'night' | 'week' | 'month'; qty: number; price: number }

/**
 * The stay a link carries of its own (a stay line, and the booking it put on
 * the schedule when it was sent) — or null: a link with no stay, or one whose
 * booking is somebody else's line (a deposit, a stay balance: a plain amount).
 */
export async function linkStayOf(q: Q, link: any): Promise<LinkStay | null> {
  if (!link?.booking_id) return null
  const lines = (Array.isArray(link.items) ? link.items : []).filter((l: any) => typeof l?.id === 'string' && l.id)
  const ids: string[] = [...new Set<string>(lines.map((l: any) => String(l.id).toLowerCase()))].filter((x) => /^[0-9a-f-]{36}$/.test(x))
  if (!ids.length) return null
  const stays = (await q.query<{ id: string; name: string; stay_unit: 'night' | 'week' | 'month' }>(
    `SELECT id, name, stay_unit FROM pos_items WHERE id = ANY($1::uuid[]) AND landlord_id = $2 AND stay_unit IS NOT NULL`,
    [ids, link.landlord_id])).rows
  if (!stays.length) return null
  const s = stays[0]
  const mine = lines.filter((l: any) => String(l.id).toLowerCase() === s.id)
  return { bookingId: link.booking_id, itemId: s.id, name: s.name, stayUnit: s.stay_unit,
           qty: mine.reduce((n: number, l: any) => n + (Number(l.qty) || 0), 0), price: Number(mine[0]?.price) || 0 }
}

/** How many of the link's stay these cart lines keep. */
export function stayQtyIn(items: any[], itemId: string): number {
  return (Array.isArray(items) ? items : [])
    .filter((i) => typeof i?.id === 'string' && i.id.trim().toLowerCase() === itemId)
    .reduce((n, i) => n + (Number(i.qty) || 0), 0)
}

const money = (n: number) => `$${n.toFixed(2)}`
const shortDay = (d: string) => DateTime.fromISO(d).toFormat('LLL d')
const nightsWord = (n: number) => `${n} night${n === 1 ? '' : 's'}`

/** "7 nights at site RV 07 (May 1 → May 8)" */
export function reservationWhat(due: Pick<ReservationDue, 'nights' | 'unitNumber' | 'checkIn' | 'checkOut'>): string {
  return `${nightsWord(due.nights)} at site ${due.unitNumber ?? '—'} (${shortDay(due.checkIn)} → ${shortDay(due.checkOut)})`
}

/** The name a reservation's line goes by in the cart, on the reader and on the receipt. */
export function reservationLineName(itemName: string, due: ReservationDue): string {
  const what = reservationWhat(due)
  // decisions #15: a long stay's line at the register is its deposit; its lease bills the rest.
  const tail = due.leaseBillsRest ? ' — the deposit now; its lease bills the rest'
    : due.paid > 0 ? `, balance after ${money(due.paid)} paid` : ''
  return `${itemName} — ${what}${tail}`.slice(0, 160)
}

/**
 * 10/3 (decisions #15): what the clerk is told when a reservation has nothing
 * left for the register to take — paid in full, or (a stay its lease bills)
 * its deposit paid.
 */
export function reservationPaidWords(due: Pick<ReservationDue, 'leaseBillsRest' | 'paid'> | null, tail = 'nothing was charged. Press Clear.'): string {
  if (due?.leaseBillsRest) {
    // 10/3 (review): nothing paid is never "the deposit is paid" — a long stay
    // with no deposit asked has nothing due at the register; its lease bills it.
    return due.paid > 0.005
      ? `The deposit on that reservation is paid — its lease bills the rest of the stay, not the register, so ${tail}`
      : `Nothing is due on that reservation at the register — its lease bills the stay, so ${tail}`
  }
  return `That reservation is already paid — ${tail}`
}

/**
 * 10/3 (review): what the clerk is told when a link's reservation is over —
 * and why, only as far as it is known: its site went to a guest who paid
 * first ONLY when the booking says so (displaced_at); otherwise it was
 * cancelled on the schedule, or marked a no-show. Same next step every time.
 */
export function linkReservationGoneWords(due: Pick<ReservationDue, 'status' | 'displaced'> | null,
  tail = 'nothing was charged. Press Clear, then close the link under Pay Links; if they still want to stay, ring the stay fresh with a site and dates.'): string {
  const why = !due ? 'is no longer on the schedule'
    : due.status === 'no_show' ? 'was marked a no-show'
    : due.displaced ? 'was canceled (its site went to a guest who paid first)'
    : 'was canceled on the schedule'
  return `The reservation on this pay link ${why} — ${tail}`
}

/**
 * 10/3 (review): why a link's reservation cannot be paid any more — over,
 * already paid, or no price — in the words of the screen the clerk is on, with
 * THAT screen's next step (`press`: the button pressed there). The register
 * (Charge) says "Press Clear"; Adjust (Save changes) changed nothing and has no
 * Clear; Send again sent nothing; the Pay Links list says what the link can do
 * now. Null when it can be paid.
 */
export function linkReservationClosedWords(due: ReservationDue | null, press = 'Charge'): string | null {
  const ringFresh = 'if they still want to stay, ring the stay fresh with a site and dates.'
  const t = press === 'Save changes'
    ? { gone: `nothing was changed. Close the link under Pay Links; ${ringFresh}`,
        paid: 'nothing was changed. Close the link under Pay Links.',
        noPrice: 'That reservation has no price on it — nothing was changed. Set its price on the schedule, then press Save changes again.' }
    : press === 'Send again'
      ? { gone: `nothing was sent. Close the link under Pay Links; ${ringFresh}`,
          paid: 'nothing was sent. Close the link under Pay Links.',
          noPrice: 'That reservation has no price on it — nothing was sent. Set its price on the schedule, then press Send again.' }
      : press === 'Pay Links'
        ? { gone: `nothing can be paid on this link. Press Close; ${ringFresh}`,
            paid: 'nothing more can be paid on this link. Press Close.',
            noPrice: 'Its reservation has no price on it — set its price on the schedule; until then this link cannot be paid.' }
        : { gone: undefined, paid: undefined,
            noPrice: 'That reservation has no price on it — nothing was charged. Set its price on the schedule, then open the link again.' }
  if (!due || due.closed) return linkReservationGoneWords(due, t.gone)
  if (due.noPrice) return t.noPrice
  if (due.paidInFull) return reservationPaidWords(due, t.paid)
  return null
}

/**
 * 10/3 (decisions #9, #23) — WHAT A PAY LINK CHARGES TOWARD ITS RESERVATION.
 *
 * A link that carries a reservation (booking_id) pays toward it, and what it
 * charges for it is the RESERVATION'S, read at the moment it is paid — never
 * the link's lines frozen when it was sent:
 *   - a link that HOLDS A STAY (linkStayOf) charges what the reservation still
 *     owes (reservationDue: the booking's own price, as the schedule priced it,
 *     less what was paid toward it; for a long stay its lease bills, the
 *     deposit — decisions #15). The schedule may have repriced it, moved it,
 *     lengthened or shortened it, or taken a payment toward it since; the link
 *     follows. decisions #23: a reservation's nights, site and price change
 *     ONLY on the schedule — never at the counter, in a quote or by Adjust.
 *     The stay is always charged whole (assertLinkStayWhole refuses fewer or
 *     more nights, or the stay taken out, in words that point to the schedule).
 *   - a link for a DEPOSIT, a BALANCE or an AMOUNT (typed lines) charges what
 *     it was sent for — never more than is left to pay (a second payment after
 *     the first would bill the reservation twice). The arrival-day balance link
 *     is the rest only while nothing else has been paid toward it.
 * A reservation that is over (cancelled, a no-show), already paid (for a long
 * stay: its deposit), or has no price is refused in the clerk's words.
 */
export interface LinkReservation {
  due: ReservationDue
  stay: LinkStay | null
  /** What the link was sent asking toward the reservation (its typed lines); null for a stay, which asks the reservation's own price. */
  asks: number | null
  /** What it charges toward the reservation now. */
  charge: number
  /**
   * 10/3 (decisions #21): the lodging tax inside what it charges toward the
   * reservation — the reservation's price has the property's short-term tax in
   * it (the schedule's pricing), and a sale records that part as tax, not as
   * the stay's price. A deposit, balance or amount link toward a short stay
   * carries its share of that tax too (taxInsidePayment — the parts add up to
   * the stay's tax, whichever door took each). `rate` is a fraction (0.12); 0
   * for a stay of 30 nights or more, or a long stay's deposit (decisions #15).
   */
  stayTax: { amount: number; rate: number }
}

/**
 * 10/3 (review): what the clerk is told when a link asks less than a long
 * stay's deposit. A stay its lease bills is paid its deposit whole (decisions
 * #15) — a part of it would be recorded as the deposit, and the rest never
 * asked for.
 */
export const longStayDepositWholeWords = (asks: number, deposit: number, nothing: 'charged' | 'changed' | 'sent' | 'resent' | 'listed') =>
  `This asks ${money(asks)} toward a long stay whose deposit is ${money(deposit)} — a long stay's deposit is paid whole (its lease bills the rest), `
  + (nothing === 'listed' ? 'so this link cannot be paid as it is. ' : `so nothing was ${nothing === 'resent' ? 'sent' : nothing}. `)
  + (nothing === 'sent'
    ? `Change the amount to ${money(deposit)}, then press Send link again.`
    : `Close this link under Pay Links, then take the ${money(deposit)} at the counter or send a new link for it.`)

/**
 * 10/3 (decisions #23): what the clerk is told when the cart (or an Adjust)
 * changes the nights of a link's reservation. Its nights, site and price
 * change only on the schedule; the link then charges what it owes.
 */
export const stayChangesOnScheduleWords = (due: Pick<ReservationDue, 'nights' | 'unitNumber' | 'checkIn' | 'checkOut'>, press: string, nothing: 'charged' | 'changed') =>
  `This link holds ${reservationWhat(due)} — a reservation's nights, site and price change only on the schedule, so nothing was ${nothing}. `
  + `Put the stay back the way the link has it, then press ${press} again. To change the stay, change the reservation on the schedule first — the link then asks what it owes.`

/**
 * 10/3 (decisions #23): what the clerk is told when the register's reservation
 * line shows other nights than the reservation has — the register has no way
 * to change them, so the schedule did (or the screen is an old one). The step
 * is the one that works: open the link again, which shows it as it is now.
 */
export const linkStayNightsNowWords = (due: Pick<ReservationDue, 'nights' | 'unitNumber' | 'checkIn' | 'checkOut'>, press: string) =>
  `This link's reservation is ${reservationWhat(due)} now — a reservation's nights, site and price change only on the schedule, and the cart shows other nights, so nothing was charged. `
  + `Press Clear, open the link again from the list, then press ${press}.`

/** 10/3 (decisions #23): what the clerk is told when a link's stay is taken out of the cart (or off the link). */
export const linkStayRemovedWords = (stay: Pick<LinkStay, 'name'>, due: Pick<ReservationDue, 'nights' | 'unitNumber' | 'checkIn' | 'checkOut'>, press: string) =>
  `This link holds ${reservationWhat(due)} for "${stay.name}" — keep its stay in the cart, then press ${press} again. `
  + 'To give up the stay altogether, close the link under Pay Links (that lets the site go).'

/**
 * 10/3 (decisions #23): the cart (or an Adjust) keeps the link's stay WHOLE —
 * the link's own stay line(s), as many of them as the link carries. Fewer or
 * more nights (weeks, months) are refused; the reservation is changed on the
 * schedule, and the link follows it.
 */
export function assertLinkStayWhole(stay: LinkStay, due: ReservationDue, items: any[], press: string, nothing: 'charged' | 'changed'): void {
  const kept = stayQtyIn(items, stay.itemId)
  if (!(kept > 0)) throw new AppError(400, linkStayRemovedWords(stay, due, press))
  if (Math.abs(kept - stay.qty) > 1e-9) throw new AppError(400, stayChangesOnScheduleWords(due, press, nothing))
}

/** Is this one of the link's own lines that IS its reservation — its stay line, or (no stay) a typed line? */
const isReservationLine = (l: any, stay: LinkStay | null): boolean =>
  stay ? (typeof l?.id === 'string' && l.id.trim().toLowerCase() === stay.itemId) : (!l?.id && !isScreeningLine(l))

/**
 * What the link charges toward its reservation now (see LinkReservation), or
 * null for a link with no reservation. Throws, in the clerk's words, when the
 * reservation cannot be paid here. `press` is the button pressed again.
 */
export async function linkReservation(q: Q, link: any, opts: { lock?: boolean; press?: string } = {}): Promise<LinkReservation | null> {
  if (!link?.booking_id) return null
  const stay = await linkStayOf(q, link)
  const typed = linkBookingLines(link, stay)
  if (!stay && !typed.length) return null
  const press = opts.press ?? 'Charge'
  const due = await reservationDue(q, link.booking_id, { lock: opts.lock })
  // 10/3 (review): refused in the words of the screen pressed on (Adjust, Send again, the list, the register).
  const closedWords = linkReservationClosedWords(due, press)
  if (closedWords || !due) throw new AppError(409, closedWords ?? linkReservationGoneWords(due))
  // decisions #21: the lodging tax inside it, at the rate the schedule prices
  // these nights with. (A long stay's charge here is its deposit — decisions
  // #15 — and carries no tax.)
  const rate = due.leaseBillsRest ? 0 : stayTaxRate(due.rates, due.taxPct, due.bookedNights)
  if (!stay) {
    const asks = round2(typed.reduce((n, l) => n + l.qty * l.price, 0))
    const charge = round2(Math.min(asks, due.owed))
    // 10/3 (review): a long stay's deposit is paid whole — a link for part of
    // it would be recorded as the deposit and the rest never asked for.
    if (due.leaseBillsRest && charge < due.owed - 0.005) {
      throw new AppError(409, longStayDepositWholeWords(asks, due.owed,
        press === 'Save changes' ? 'changed' : press === 'Send again' ? 'resent' : press === 'Pay Links' ? 'listed' : 'charged'))
    }
    // 10/3 (review, decisions #21): a deposit or balance toward a short stay
    // has the stay's lodging tax in it too — its share, recorded as tax, the
    // same split the counter records for the same money.
    return { due, stay: null, asks, charge, stayTax: { amount: taxInsidePayment(due.paid, charge, rate), rate } }
  }
  // decisions #23: the stay is charged whole — what the reservation owes now.
  return { due, stay, asks: null, charge: due.owed, stayTax: { amount: taxInsidePayment(due.paid, due.owed, rate), rate } }
}

/**
 * The reservation's own line, as the register shows it: one line, at what it
 * charges, its tax in its price (shown untaxed). The sale records it split —
 * reservationSaleLine. A stay's line says its nights (the reservation's —
 * decisions #23: never changed here); a register that sends other nights back
 * is refused.
 */
export function linkReservationLine(link: any, res: LinkReservation): any {
  if (res.stay) {
    return { id: res.stay.itemId, name: reservationLineName(res.stay.name, res.due),
             qty: 1, price: res.charge, tax: 0, stay: true, reservation: true, stay_unit: res.stay.stayUnit,
             nights: res.due.nights, pay_link_id: link.id }
  }
  const first = linkBookingLines(link, null)[0]?.name || 'Toward the reservation'
  const name = res.asks != null && res.charge < res.asks - 0.005 ? `${first} — what is left on the reservation` : first
  return { id: null, name: name.slice(0, 160), qty: 1, price: res.charge, tax: 0, reservation: true, pay_link_id: link.id }
}

/**
 * 10/3 (decisions #21): the reservation's line as a SALE records it — the stay
 * at its price less the lodging tax inside it, and that tax as the line's tax
 * (rate as a fraction) — so the sale's subtotal, tax and total each say what
 * they are. What the guest pays is unchanged.
 */
export function reservationSaleLine(line: any, stayTax: { amount: number; rate: number } | null | undefined): any {
  if (!stayTax || !(stayTax.amount > 0)) return line
  const qty = Number(line.qty) || 1
  return { ...line, price: round2((qty * (Number(line.price) || 0) - stayTax.amount) / qty), tax: stayTax.rate }
}

/** 10/3 (decisions #21): the sale's named taxes with a stay's lodging tax beside the rest. */
export function withLodgingTax(breakdown: { name: string; rate: number; amount: number }[] | null | undefined,
                               stayTax: { amount: number; rate: number } | null | undefined): { name: string; rate: number; amount: number }[] {
  const out = (breakdown ?? []).map((b) => ({ ...b }))
  if (!stayTax || !(stayTax.amount > 0)) return out
  const same = out.find((b) => b.name === 'Lodging tax' && Math.abs(b.rate - stayTax.rate) < 1e-9)
  if (same) same.amount = round2(same.amount + stayTax.amount)
  else out.push({ name: 'Lodging tax', rate: stayTax.rate, amount: stayTax.amount })
  return out
}

/**
 * A link's lines as they are charged now: its reservation as one line at what
 * it charges (linkReservationLine), then every other line of its own priced as
 * sent (a tank of propane on the same link). A link with no reservation is its
 * own row, as stored. Reservation links take no discount (decisions #9).
 * 10/3 (decisions #21): a stay's lodging tax counts as tax, not subtotal — the
 * total is the same.
 */
export async function linkAsCharged(link: any, res: LinkReservation | null): Promise<{ items: any[]; rest: any[]; subtotal: number; taxAmount: number; discount: number; total: number }> {
  const items = Array.isArray(link.items) ? link.items : []
  if (!res) {
    return { items, rest: items, subtotal: Number(link.subtotal) || 0, taxAmount: Number(link.tax_amount) || 0,
             discount: Number(link.discount_amount) || 0, total: Number(link.total) || 0 }
  }
  const rest = items.filter((l: any) => !isReservationLine(l, res.stay))
  const r = rest.length ? await computeCartTotals(link.landlord_id, rest, { surcharge: 0, discountAmount: 0 })
    : { subtotal: 0, taxAmount: 0, total: 0 }
  const stayTax = res.stayTax?.amount ?? 0
  return { items: [linkReservationLine(link, res), ...rest], rest,
           subtotal: round2(Number(r.subtotal) + res.charge - stayTax), taxAmount: round2(Number(r.taxAmount) + stayTax), discount: 0,
           total: round2(Number(r.total) + res.charge) }
}

/** What a link asks now: its reservation (linkReservation) and its lines and totals as charged (linkAsCharged). */
export interface LinkAsksNow { res: LinkReservation | null; items: any[]; rest: any[]; subtotal: number; taxAmount: number; discount: number; total: number }

/**
 * 10/3 (decisions #23) — ONE AMOUNT FOR A LINK, AT EVERY DOOR.
 *
 * What a link asks right now — for a link that pays a reservation, what the
 * reservation owes now (linkReservation) beside its other lines priced as sent
 * (linkAsCharged); any other link, as stored. The Pay Links list, Send again,
 * the card page, the register (GET /pos/tickets/:id) and Adjust all read it
 * here, so the list, the email, the card page and the counter can never show
 * a reservation at two figures. Throws, in the clerk's words, when the
 * reservation cannot be paid (over, paid, no price).
 */
export async function linkAsksNow(q: Q, link: any, opts: { lock?: boolean; press?: string } = {}): Promise<LinkAsksNow> {
  const res = await linkReservation(q, link, opts)
  return { res, ...(await linkAsCharged(link, res)) }
}

/** The reservation a link's Close would cancel, as the Pay Links row shows it. */
export interface StayCloseCancels { guest: string | null; site: string | null; dates: string }

/**
 * 10/3 (review): THE STAY CLOSE WOULD CANCEL. Closing a link that holds its own
 * stay (linkStayOf) cancels the guest's reservation and lets the site go — but
 * only while that reservation is still the link's unpaid hold (tentative,
 * nothing paid on it: the same test the Close route cancels by). The Pay Links
 * row shows it and asks before Close. Null when Close cancels nothing.
 */
export async function stayCloseCancels(q: Q, link: any): Promise<StayCloseCancels | null> {
  if (!link?.booking_id || link.status !== 'open' || link.kind !== 'one_time') return null
  if (!(await linkStayOf(q, link))) return null
  const b = (await q.query<{ guest_name: string | null; unit_number: string | null; check_in: string; check_out: string }>(
    `SELECT b.guest_name, u.unit_number, to_char(b.check_in, 'YYYY-MM-DD') AS check_in, to_char(b.check_out, 'YYYY-MM-DD') AS check_out
       FROM unit_bookings b LEFT JOIN units u ON u.id = b.unit_id
      WHERE b.id = $1 AND b.status = 'tentative' AND b.deposit_paid_at IS NULL AND b.pos_transaction_id IS NULL`,
    [link.booking_id])).rows[0]
  if (!b) return null
  return { guest: b.guest_name?.trim() || link.customer_name?.trim() || null, site: b.unit_number ?? null,
           dates: `${shortDay(b.check_in)} → ${shortDay(b.check_out)}` }
}

/**
 * 10/3 (decisions #23): what the Pay Links list says beside a link whose
 * reservation cannot be paid any more — in the list's own words (the
 * register's say "press Clear"), with the next step. Null when it can be paid.
 */
async function linkListNote(link: any): Promise<string | null> {
  if (!link?.booking_id || link.status !== 'open' || link.kind !== 'one_time') return null
  return linkReservationClosedWords(await reservationDue(db, link.booking_id), 'Pay Links')
}

/**
 * What a link that was PAID ONLINE paid toward its reservation: its total as
 * its card page charged it (synced to the reservation when the page opened)
 * less its other lines. 0 for a link with no reservation. With the rest's own
 * subtotal and tax, so the sale records each.
 */
async function linkPaidToward(q: Q, link: any): Promise<{ toward: number; stay: LinkStay | null; rest: any[]; restSubtotal: number; restTax: number }> {
  const items = Array.isArray(link.items) ? link.items : []
  const stay = await linkStayOf(q, link)
  if (!link?.booking_id || (!stay && !linkBookingLines(link, stay).length)) return { toward: 0, stay, rest: items, restSubtotal: 0, restTax: 0 }
  const rest = items.filter((l: any) => !isReservationLine(l, stay))
  const r = rest.length ? await computeCartTotals(link.landlord_id, rest, { surcharge: 0, discountAmount: 0 })
    : { subtotal: 0, taxAmount: 0, total: 0 }
  return { toward: round2(Math.max(0, Number(link.total) - Number(r.total))), stay, rest,
           restSubtotal: round2(Number(r.subtotal)), restTax: round2(Number(r.taxAmount)) }
}

/**
 * 10/3: what a register still on the old screen shows for a link's stay when
 * it sends the stay line as the link carries it — the stay's figure as the
 * link last asked it (its total less its other lines). Read against what it
 * charges now: a reservation repriced since is refused with the new figure.
 */
export async function linkStayAsSent(q: Q, link: any): Promise<number> {
  return (await linkPaidToward(q, link)).toward
}

/** What the clerk is told when the cart shows another figure for a link's reservation than it charges now. */
export const linkReservationNowWords = (r: LinkReservation, press: string) =>
  `This link's reservation — ${reservationWhat(r.due)} — comes to ${money(r.charge)} now`
  + `${r.due.paid > 0 ? ` (${money(r.due.paid)} was already paid toward it)` : ''} — the cart shows something else, and nothing was charged. `
  + `Press Clear, open the link again from the list, then press ${press}.`

const typedKey = (l: any) => `${String(l?.name ?? '')}|${(Number(l?.price) || 0).toFixed(2)}`

/**
 * 10/2 (review): the lines a link for a reservation's DEPOSIT or BALANCE exists
 * for — a link that carries a booking (booking_id) but no stay of its own
 * (linkStayOf): the deposit a counter reservation emailed, the balance billed
 * on arrival day, an amount sent for a reservation. Its typed lines (no
 * register item) are what paying it pays: settled, the booking is confirmed
 * and its deposit or balance stamped paid (settleLinkBooking).
 */
export function linkBookingLines(link: any, stay: LinkStay | null): { name: string; price: number; qty: number }[] {
  if (!link?.booking_id || stay) return []
  const out = new Map<string, { name: string; price: number; qty: number }>()
  for (const l of (Array.isArray(link.items) ? link.items : [])) {
    // 10/5 (R8): its background check is GAM's — never money toward the reservation.
    if (l?.id || isScreeningLine(l)) continue
    const e = out.get(typedKey(l)) ?? { name: String(l?.name ?? ''), price: Number(l?.price) || 0, qty: 0 }
    e.qty += Number(l?.qty) || 0
    out.set(typedKey(l), e)
  }
  return [...out.values()]
}

// ── 10/5 (Nic): a link's background check and its added month ─────────────

/**
 * R8: a link's background-check line — a typed line the server wrote
 * (`screening: true`), never a register item, never part of what the link pays
 * toward a reservation. GAM's screening money: recorded as a check waiting for
 * the guest when the link is paid (recordLinkScreening).
 */
export const isScreeningLine = (l: any): boolean => !l?.id && l?.screening === true

/**
 * The link's background-check line (its name and fee), or null. `bookingId`:
 * the stay it is for — the link's own booking, or (a fee-only link,
 * createScreeningFeeLink) the stay named on the line.
 */
export function linkScreeningLine(link: any): { name: string; price: number; bookingId: string | null } | null {
  const l = (Array.isArray(link?.items) ? link.items : []).find(isScreeningLine)
  if (!l) return null
  const named = typeof l.bookingId === 'string' && /^[0-9a-f-]{36}$/i.test(l.bookingId) ? l.bookingId.toLowerCase() : null
  return { name: String(l.name ?? SCREENING_LINE_NAME), price: round2(Number(l.price) || 0), bookingId: link?.booking_id ?? named }
}

/**
 * 10/5 (Nic, A2): why a fee-only link cannot be paid now — its stay was
 * cancelled or marked a no-show ('stay_gone'), or the stay's check is already
 * paid for some other way ('paid') — or null (payable, or not a fee-only link).
 */
export async function feeOnlyLinkNotPayable(q: Q, link: any): Promise<'stay_gone' | 'paid' | null> {
  if (link?.booking_id || !isFeeOnlyLink(link)) return null
  const bookingId = linkScreeningLine(link)?.bookingId
  if (!bookingId) return null
  const r = (await q.query<{ status: string }>(
    `SELECT b.status FROM unit_bookings b WHERE b.id = $1`, [bookingId])).rows[0]
  if (!r || r.status === 'cancelled' || r.status === 'no_show') return 'stay_gone'
  // Paid for any stay of the continuous stay (R7) — one fee per stay, never two.
  return (await screeningPaidForStay(bookingId)) ? 'paid' : null
}

/**
 * 10/5 (Nic, A2): a link that carries nothing but a stay's background check
 * (createScreeningFeeLink) — sold from the schedule, not toward the stay.
 */
export function isFeeOnlyLink(link: any): boolean {
  const items = Array.isArray(link?.items) ? link.items : []
  return items.length > 0 && items.every(isScreeningLine)
}

/** R6: what an "Add a month" line carries — the stay, the month and the counter's lease answer. */
export interface LinkExtend { bookingId: string; fromCheckOut: string; checkOut: string; price: number; stayTerms: StayTerms | null }

/** The link's "Add a month" line, or null (a typed line the server wrote, `extend`). */
export function linkExtendLine(link: any): LinkExtend | null {
  const l = (Array.isArray(link?.items) ? link.items : []).find((x: any) => !x?.id && x?.extend && typeof x.extend === 'object')
  const e = l?.extend
  return e && typeof e.bookingId === 'string' ? { bookingId: e.bookingId, fromCheckOut: String(e.fromCheckOut), checkOut: String(e.checkOut),
    price: round2(Number(e.price) || 0), stayTerms: (STAY_TERMS as readonly string[]).includes(e.stayTerms) ? e.stayTerms : null } : null
}

/**
 * Adjust (and anything else that sends a link's lines back) keeps its
 * background check and its added month exactly as the server wrote them —
 * the same name, price and one of each — and they keep what they are. Lines
 * sent back come without the server's marks, so they are put back here.
 */
export function keepLinkServerLines(link: any, items: any[], press: string): any[] {
  const own = (Array.isArray(link?.items) ? link.items : []).filter((l: any) => !l?.id && (l?.screening === true || l?.extend))
  if (!own.length) return items
  const out = items.map((i) => ({ ...i }))
  for (const l of own) {
    const k = typedKey(l)
    const hit = out.find((i: any) => !i?.id && typedKey(i) === k && !i.screening && !i.extend)
    if (!hit || Number(hit.qty) !== Number(l.qty)) {
      throw new AppError(400, l.screening
        ? `This link carries the guest's background check (${money(Number(l.price) || 0)}) — it stays on the link as it is. Put that line back, then press ${press} again.`
        : `This link adds a month to their stay ("${l.name}") — that line stays as it is. Put it back, then press ${press} again; to give up the month, close the link.`)
    }
    if (l.screening) hit.screening = true
    if (l.screening && l.bookingId) hit.bookingId = l.bookingId
    if (l.extend) hit.extend = l.extend
  }
  return out
}

/** What recording a paid link's background check did (recordLinkScreening). */
export interface LinkScreeningRecorded {
  /** The guest's already-paid link email, sent once the payment commits. */
  afterCommit: () => Promise<void>
  /**
   * 10/5 (A5): the part of the payment GAM keeps on its own balance — the
   * check's fee when GAM collected it (a card) and this payment is the one
   * that recorded it; 0 otherwise. It comes out of the landlord's payout share.
   */
  gamKeeps: number
}

/**
 * R8: a paid link's background check — inside the payment's transaction.
 * Null when the link carries none. A fee-only link (createScreeningFeeLink)
 * was sold from the schedule (source 'schedule'); any other link is 'pay_link'.
 * A check this stay already had recorded is not recorded twice: the fee stays
 * in the sale as the landlord's to give back, and the error log says so.
 */
export async function recordLinkScreening(
  client: PoolClient, link: any,
  /**
   * 10/5 (A5): who holds the money. Paid online or by card at the counter, it
   * is on GAM's balance ('gam' — kept out of the landlord's payout share);
   * cash, check or money order at the counter, the landlord has it
   * ('landlord' — GAM takes it from their next payout). services/stayTerms
   * screeningCollectedBy(tender).
   */
  collectedBy: ScreeningCollectedBy,
): Promise<LinkScreeningRecorded | null> {
  const s = linkScreeningLine(link)
  if (!s || !(s.price > 0)) return null
  const b = s.bookingId ? (await client.query<{ guest_email: string | null; tenant_id: string | null }>(
    `SELECT guest_email, tenant_id FROM unit_bookings WHERE id = $1`, [s.bookingId])).rows[0] : null
  const rec = await recordScreeningPrepayment(client, {
    landlordId: link.landlord_id, propertyId: link.property_id, bookingId: b ? s.bookingId : null,
    tenantId: b?.tenant_id ?? null, email: b?.guest_email ?? link.customer_email ?? null,
    amount: s.price, source: isFeeOnlyLink(link) ? 'schedule' : 'pay_link', sourceId: link.id, collectedBy,
  })
  if (!rec.created) logger.error({ payLinkId: link.id, bookingId: s.bookingId }, '[pay-link] a background-check fee was paid for a stay that already had one recorded — left in the sale for the landlord to give back')
  return { afterCommit: rec.afterCommit, gamKeeps: rec.created && collectedBy === 'gam' ? s.price : 0 }
}

/**
 * R2/R11: a link that sold a stay of 30+ nights (or added a month to one) was
 * paid — its lease-or-stay answer is carried out now: a lease is drafted for
 * the landlord; a stay is billed its site's utilities. The landlord is told
 * either way. After the payment commits; never undoes it.
 */
export async function afterLinkPaid(link: any, byUserId: string | null): Promise<void> {
  if (!link?.booking_id) return
  try {
    const ext = linkExtendLine(link)
    if (!ext && !(await linkStayOf(db, link))) return
    const b = await queryOne<{ stay_terms: StayTerms | null; status: string; check_in: string; check_out: string
                               guest_email: string | null; tenant_id: string | null; property_id: string }>(
      `SELECT b.stay_terms, b.status, to_char(b.check_in, 'YYYY-MM-DD') AS check_in, to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
              b.guest_email, b.tenant_id, u.property_id
         FROM unit_bookings b JOIN units u ON u.id = b.unit_id WHERE b.id = $1`, [link.booking_id])
    if (!b || ['cancelled', 'no_show'].includes(b.status)) return
    const terms = ext?.stayTerms ?? b.stay_terms
    if (!terms) return
    const chain = await continuousStayNights({ propertyId: b.property_id, bookingId: link.booking_id, tenantId: b.tenant_id,
      email: b.guest_email, checkIn: b.check_in, checkOut: b.check_out })
    if (chain.nights < STAY_LEASE_CHOICE_NIGHTS) return
    await chooseStayTerms(link.booking_id, terms, { byUserId })
  } catch (err) {
    logger.error({ err, payLinkId: link.id, bookingId: link.booking_id }, '[pay-link] the lease-or-stay answer could not be carried out after the link was paid')
  }
}

/**
 * R13: the words a link's payer reads up front — "Your site is held through
 * …" — for a stay of 30+ nights with no lease (a stay it holds, or a month it
 * adds). Null for anything else.
 */
export async function linkHeldWords(link: any): Promise<string | null> {
  if (!link?.booking_id) return null
  const ext = linkExtendLine(link)
  if (!ext && !(await linkStayOf(db, link))) return null
  const b = await queryOne<{ stay_terms: StayTerms | null; check_in: string; check_out: string; guest_email: string | null; tenant_id: string | null; property_id: string }>(
    `SELECT b.stay_terms, to_char(b.check_in, 'YYYY-MM-DD') AS check_in, to_char(b.check_out, 'YYYY-MM-DD') AS check_out,
            b.guest_email, b.tenant_id, u.property_id
       FROM unit_bookings b JOIN units u ON u.id = b.unit_id WHERE b.id = $1`, [link.booking_id])
  if (!b) return null
  if ((ext?.stayTerms ?? b.stay_terms) !== 'stay') return null
  const chain = await continuousStayNights({ propertyId: b.property_id, bookingId: link.booking_id, tenantId: b.tenant_id,
    email: b.guest_email, checkIn: b.check_in, checkOut: b.check_out })
  return chain.nights >= STAY_LEASE_CHOICE_NIGHTS ? stayHeldWords(b.check_out) : null
}

/**
 * 10/2 (review): a link for a reservation's deposit or balance is paid as it
 * was sent, or not at all — the link's own line in the cart, the same name and
 * price, the whole of it. A $100 deposit link settled with a $20 tank of
 * propane (or the deposit at a penny) still confirmed the reservation and
 * stamped the deposit paid; the arrival-day bill then took the deposit as paid
 * and the missing $80 was never billed — and the hold could no longer be
 * displaced. Changing a reservation is done on the schedule.
 */
export function assertLinkBookingLinesKept(link: any, stay: LinkStay | null, items: any[], press: string): void {
  const own = linkBookingLines(link, stay)
  if (!own.length) return
  const kept = new Map<string, number>()
  for (const it of (Array.isArray(items) ? items : [])) {
    if (it?.id) continue
    kept.set(typedKey(it), (kept.get(typedKey(it)) ?? 0) + (Number(it?.qty) || 0))
  }
  for (const l of own) {
    if (Math.abs((kept.get(typedKey(l)) ?? 0) - l.qty) > 1e-9) {
      throw new AppError(400, `This link pays for a reservation — keep the "${l.name}" line just as it was (the whole amount), then press ${press} again. `
        + 'To change the reservation, use the schedule.')
    }
  }
}

/**
 * 10/2 (review): a pay link was paid — online (finalizePayLink) or at the
 * counter (POST /pos/transactions). One rule for both: the link's booking is
 * the guest's now — confirmed, with its deposit paid, so it can no longer be
 * displaced as an unpaid hold — and names the sale that paid it. A stay-balance
 * link marks its balance paid.
 *
 * WHAT IS PAID ADDS UP (10/2 review). A reservation's paid-ahead amount
 * (deposit_amount, once deposit_paid_at is stamped) is everything paid toward
 * it so far: `paidToward` — what THIS payment paid toward it (LinkReservation
 * .charge at the counter; what the card page charged online) — is ADDED to
 * what was paid before, and once the total paid covers the reservation's own
 * price its balance is stamped billed and paid — nothing is left for the
 * arrival-day run (services/stayBalance) to bill. A stay its lease bills
 * (decisions #15) is never stamped paid in full by its deposit: its lease
 * bills the rest.
 *
 * 10/3 (review): THE ARRIVAL-DAY BALANCE LINK IS NO EXCEPTION. It used to
 * stamp the balance paid whatever it paid — a $280 balance link paid after the
 * schedule repriced the stay to $320 marked the stay paid and the $40 was
 * never owed anywhere. It pays toward the reservation like any other link: its
 * balance is stamped paid only when what it paid covers what was still owed;
 * otherwise it is added to what was paid ahead (deposit_amount) and the rest
 * stays owed (the counter, or a new link, takes it).
 */
export async function settleLinkBooking(q: Q, link: any, saleId: string, stay: LinkStay | null, guestName: string | null = null,
                                        paidToward = 0): Promise<void> {
  // A balance link that names its booking only through balance_pay_link_id
  // (sent before links carried booking_id) is the rest of that booking.
  await q.query(
    `UPDATE unit_bookings SET balance_paid_at = COALESCE(balance_paid_at, NOW()), updated_at = NOW()
      WHERE balance_pay_link_id = $1 AND id IS DISTINCT FROM $2`, [link.id, link.booking_id ?? null])
  if (!link.booking_id) return
  const b = (await q.query<{ total: number; deposit_amount: number | null; deposit_paid: boolean; balance_pay_link_id: string | null }>(
    `SELECT COALESCE(total_amount, 0)::float AS total, deposit_amount::float AS deposit_amount,
            (deposit_paid_at IS NOT NULL) AS deposit_paid, balance_pay_link_id
       FROM unit_bookings WHERE id = $1 FOR UPDATE`, [link.booking_id])).rows[0]
  if (!b) return
  const paidHere = round2(Math.max(0, Number(paidToward) || 0))
  const towardIt = paidHere > 0
  // Paid before: a deposit stamped paid is its amount — or, with no amount on
  // record, the whole stay (services/registerStay reservationDue).
  const before = b.deposit_paid ? (b.deposit_amount == null ? Number(b.total) : Number(b.deposit_amount)) : 0
  const paidNow = towardIt ? round2(before + paidHere) : null
  const whole = towardIt && (Number(b.total) > 0 ? paidNow! >= Number(b.total) - 0.005 : !!stay)
  await q.query(
    `UPDATE unit_bookings
        SET status = CASE WHEN status = 'tentative' THEN 'confirmed' ELSE status END,
            deposit_amount = COALESCE($4::numeric, deposit_amount),
            deposit_paid_at = COALESCE(deposit_paid_at, NOW()), hold_expires_at = NULL,
            pos_transaction_id = COALESCE(pos_transaction_id, $2),
            guest_name = COALESCE(guest_name, $3),
            balance_billed_at = CASE WHEN $5::boolean THEN COALESCE(balance_billed_at, NOW()) ELSE balance_billed_at END,
            balance_paid_at   = CASE WHEN $5::boolean THEN COALESCE(balance_paid_at, NOW()) ELSE balance_paid_at END,
            updated_at = NOW()
      WHERE id = $1`, [link.booking_id, saleId, guestName, paidNow, whole])
  // 10/4 (decisions #37.B, #38): what this payment paid toward the stay,
  // itemized with how it was paid — an early check-out gives it back that way.
  if (towardIt) await recordSaleTowardStay(q, { bookingId: link.booking_id, saleId, toward: paidHere })
}

// ── 10/2 (review): one payment, one charge ───────────────────────────────

/** What the clerk is told when the link they are settling was paid online a moment ago. */
export const LINK_PAID_ONLINE = 'That link was just paid online — nothing was charged here. Press Clear.'
/** What the clerk is told when a card page that went out with a link could not be closed. */
export const LINK_PAGE_STUCK = 'The card page sent with this pay link could not be closed just now — nothing was charged. Wait a moment, then press Charge again.'
/** 10/2 (decisions #9): a reservation is charged at its own price — never less a discount. */
export const reservationNoDiscountWords = (press: string) =>
  `A reservation is charged at its own price — take the discount off, then press ${press} again. To change what it costs, change the reservation on the schedule.`

/**
 * 10/2 (review): close the card page a pay link last opened, and say whether
 * the payer finished paying on it first.
 *
 * A link's Stripe page can be open on the payer's phone while the desk settles
 * the same link — both took the money. So before anything is charged at the
 * counter (or the link is closed), the page is closed at Stripe, and Stripe is
 * asked how it ended: 'paid' means the payer got there first and the desk must
 * not charge; 'closed' (or 'none' — no page was ever opened) means nobody can
 * pay on it any more. A payment Stripe has not finished reporting is caught by
 * the link's own row when it lands (finalizePayLink). Throws when Stripe could
 * not be asked — the caller refuses rather than risk a second charge.
 */
export async function closeLinkCheckout(link: { id: string; landlord_id: string; last_checkout_session_id?: string | null }): Promise<'none' | 'closed' | 'paid'> {
  const sessionId = link?.last_checkout_session_id
  if (!sessionId) return 'none'
  const { expirePayLinkCheckoutSession } = await import('../services/stripeConnect')
  try {
    await expirePayLinkCheckoutSession(link.landlord_id, sessionId)
  } catch (e) {
    // Finished or closed between the read and the close — the read below says which.
    logger.warn({ err: e, payLinkId: link.id }, '[pay-link] the card page did not close cleanly')
  }
  const { getStripe } = await import('../lib/stripe')
  const page: any = await getStripe().checkout.sessions.retrieve(sessionId)
  if (page?.status === 'complete' || page?.payment_status === 'paid') return 'paid'
  if (page?.status === 'open') throw new Error(`pay link ${link.id}: its card page is still open`)
  return 'closed'
}

/**
 * 10/2 (review): close the card page a link has open RIGHT NOW — its page id
 * read fresh, just before closing it (a payer can open the link again while
 * the clerk is still at the counter). Returns how it ended and which page was
 * closed: the write that follows (settling, changing or closing the link)
 * claims the link only while that is still its page
 * (`last_checkout_session_id IS NOT DISTINCT FROM closedId`), so a page opened
 * in between is never left open behind it.
 */
export async function closeLinkPageNow(linkId: string): Promise<{ page: 'none' | 'closed' | 'paid'; closedId: string | null }> {
  const row = await queryOne<{ id: string; landlord_id: string; last_checkout_session_id: string | null }>(
    `SELECT id, landlord_id, last_checkout_session_id FROM pos_pay_links WHERE id = $1`, [linkId])
  if (!row) return { page: 'none', closedId: null }
  return { page: await closeLinkCheckout(row), closedId: row.last_checkout_session_id ?? null }
}

/** What the clerk is told when the payer opened the link again while it was being settled, changed or closed. */
export const linkOpenedMeanwhileWords = (what: 'charged' | 'changed' | 'closed', press: string) =>
  what === 'closed'
    ? `The payer opened this link on their phone just now — it is still open. Press ${press} again.`
    : `The payer opened this link on their phone just now — nothing was ${what} here. Press ${press} again.`

/** The card pages closed before a sale pays a reservation in full: link id → the page that was open (or null). */
export type PagesClosed = Map<string, string | null>

/**
 * Before a sale pays a reservation in full: close the card pages of the OTHER
 * open links on it (a deposit link still in the guest's inbox), and say whether
 * one of them was paid first. Same refusal as closeLinkCheckout. 10/2 (review):
 * returns every other open link with the page it had (null for none), so the
 * sale can refuse if one of them opened a new page meanwhile (closeIfPaidInFull).
 */
export async function closeOtherLinkCheckouts(bookingId: string, exceptLinkId: string | null): Promise<{ outcome: 'closed' | 'paid'; pages: PagesClosed }> {
  const others = await query<{ id: string; landlord_id: string; last_checkout_session_id: string | null }>(
    `SELECT id, landlord_id, last_checkout_session_id FROM pos_pay_links
      WHERE booking_id = $1 AND status = 'open' AND id IS DISTINCT FROM $2`,
    [bookingId, exceptLinkId])
  const pages: PagesClosed = new Map()
  for (const l of others) {
    pages.set(l.id, l.last_checkout_session_id ?? null)
    if (await closeLinkCheckout(l) === 'paid') return { outcome: 'paid', pages }
  }
  return { outcome: 'closed', pages }
}

/** What the clerk is told when another link on the reservation was opened while it was being paid in full. */
export const RESERVATION_LINK_OPENED = 'A pay link for this reservation was opened on the guest\'s phone just now — nothing was charged here. Press Charge again.'

/** A link closed because its reservation was paid in full — its card page is closed after the sale commits. */
export interface ClosedLink { id: string; landlord_id: string; last_checkout_session_id: string | null }

/**
 * 10/2 (decisions #9): PAYING A RESERVATION IN FULL CLOSES EVERYTHING ELSE
 * THAT WOULD TAKE MONEY FOR IT — every other open pay link on the booking (a
 * deposit link still in an inbox, an arrival-day balance link) is closed, and
 * an open register ticket for it is voided, in the same transaction as the sale
 * that paid it. Nothing is deleted. Run after the sale's own booking writes,
 * with the booking row locked; returns the links closed so their card pages
 * can be closed at Stripe once the sale commits (expireClosedLinks).
 *
 * 10/2 (review): `except.pages` — the pages the counter closed before taking
 * the money (closeOtherLinkCheckouts). A link that has a different page now
 * was opened again in between; that page could still be paid, so the sale is
 * refused (RESERVATION_LINK_OPENED) and rolls back, nothing taken.
 */
export async function closeIfPaidInFull(q: Q, bookingId: string | null | undefined,
                                        except: { linkId?: string | null; ticketId?: string | null; pages?: PagesClosed }): Promise<ClosedLink[]> {
  if (!bookingId) return []
  const due = await reservationDue(q, bookingId)
  if (!due || due.closed || !due.paidInFull) return []
  const closed = (await q.query<ClosedLink>(
    `UPDATE pos_pay_links SET status = 'cancelled', updated_at = NOW()
      WHERE booking_id = $1 AND status = 'open' AND id IS DISTINCT FROM $2
      RETURNING id, landlord_id, last_checkout_session_id`, [bookingId, except.linkId ?? null])).rows
  if (except.pages) {
    for (const l of closed) {
      if (l.last_checkout_session_id && l.last_checkout_session_id !== (except.pages.get(l.id) ?? null)) {
        throw new AppError(409, RESERVATION_LINK_OPENED)
      }
    }
  }
  // 10/3 (review): an open ticket for it gives up its stay — voided when the
  // stay was all it carried, kept open for anything else held on it.
  await releaseReservationTickets(q, bookingId,
    !due.leaseBillsRest ? 'The reservation was paid in full'
      : due.paid > 0.005 ? 'The reservation\'s deposit was paid — its lease bills the rest'
      : 'Nothing is due on the reservation at the register — its lease bills the stay',
    { exceptTicketId: except.ticketId ?? null })
  return closed
}

/** After the sale commits: the card pages of the links it closed are closed at Stripe too. Never fails the sale. */
export async function expireClosedLinks(links: ClosedLink[]): Promise<void> {
  for (const l of links) {
    if (!l.last_checkout_session_id) continue
    try {
      const { expirePayLinkCheckoutSession } = await import('../services/stripeConnect')
      await expirePayLinkCheckoutSession(l.landlord_id, l.last_checkout_session_id)
    } catch (e) {
      // A payment that lands on it anyway is caught when it arrives (finalizePayLink).
      logger.warn({ err: e, payLinkId: l.id }, '[pay-link] could not close the card page of a link closed with its reservation')
    }
  }
}

/**
 * The reservation a link is for, refused when there is nothing to take money
 * for: cancelled or a no-show (`cancelledWords`), or nothing left for the
 * register to take (reservationPaidWords — paid in full; for a stay its lease
 * bills, its deposit paid).
 */
export function assertReservationPayable(due: ReservationDue | null, cancelledWords: string, paidTail = 'nothing was charged. Press Clear.'): void {
  if (!due || due.closed) throw new AppError(409, cancelledWords)
  if (due.paidInFull) throw new AppError(409, reservationPaidWords(due, paidTail))
}

/** What the clerk is told when the stay's figure on the register is not what its nights cost now. */
export const linkStayNowWords = (what: string, total: number) =>
  `This stay — ${what} — comes to $${total.toFixed(2)} now — the register shows something else, and nothing was sent. `
  + 'Press Cancel, tap the site and dates above Charge, press Use this site, then press Email a pay link again.'

/**
 * Create a link (and email it, for a one-time link). Everything that decides the
 * amount is computed here, from the landlord's own catalog — nothing the
 * customer's page could change.
 */
export async function createPayLink(req: any, body: z.infer<typeof createSchema>) {
  const press = body.kind === 'standing' ? 'Create QR code' : 'Send link'
  // 10/2 (review): every item id lowercase, as the database writes it.
  body = { ...body, items: lowerLineIds(body.items) }
  const prop = await propertyFor(req, body.propertyId)
  // 10/2: the person a link names is THIS company's — one of its register
  // customers or residents — exactly as at the counter. An id from anywhere
  // else is refused, not stored.
  if ([body.tenantId, body.posCustomerId, body.match].filter(Boolean).length > 1) {
    throw new AppError(400, `A link is for one person — remove the customer (×) and pick just one, then press ${press} again.`)
  }
  await personOnSale(prop.landlord_id, { tenantId: body.tenantId, posCustomerId: body.posCustomerId })
  // 10/2 (review): the register honors a link's prices and discount as they
  // were when it was sent, so sending one is held to the rule for ringing a
  // sale — a cashier without "Apply discounts" sends the catalog's prices and
  // no discount, and no typed-in amounts. (Imported when used: routes/pos is
  // the register's own module.)
  const { assertCashierPricing } = await import('./pos')
  await assertCashierPricing(req, (body.items as any[]).map((i) => ({ itemId: i.id ?? null, price: i.price })), body.discountAmount, prop.landlord_id, press)
  await assertOneOffLinesAllowed(req, body.items as any[], body.kind)
  await assertItemsAreOurs(prop.landlord_id, body.items as any[], press)
  await assertWholeStays(prop.landlord_id, body.items as any[], press)   // 10/2 (review): whole nights
  if (!(await connectIdFor(prop.landlord_id))) {
    throw new AppError(409, 'Card payments are not set up for this property yet — finish payout setup under Banking first.')
  }
  if (body.kind === 'one_time' && !body.customer?.email) {
    throw new AppError(400, 'An email address is needed to send the link — type theirs, then press Send link again.')
  }
  // S652 — A STAY SOLD DOWN THIS ROUTE USES UP INVENTORY.
  //
  // Nic: "Think of the stays like almost inventory where I've only got so many
  // sites on January 12th. The inventory replenishes January 13th because it's
  // a new day and new nights can be paid for. So when I send a pay link, it
  // should use up inventory according to what spot was booked and for how long."
  //
  // The failure this replaces was narrow and real: a cashier could tap a stay
  // item into the cart and press "Email a pay link" instead of taking payment.
  // That path accepted any list of items, totaled them and emailed a link —
  // it had no notion of a site or a date to ask for. Paid, it wrote a sale and
  // the Master Schedule never heard about it, which is the same failure
  // register stays were built to end, through a different door. (The booking
  // site and the counter's reservation flow were always fine; both write a
  // unit_bookings row.)
  //
  // So the link now carries the stay, and the site comes off the board when the
  // link is SENT, not when it is paid. An unpaid hold has no clock on it and
  // yields to somebody who pays — the same rank every other hold obeys
  // (services/holdDisplacement).
  const itemIds = (body.items as any[]).map((i) => i.id).filter(Boolean)
  let stayLine: { itemId: string; name: string; stayUnit: 'night' | 'week' | 'month'; qty: number } | null = null
  if (itemIds.length) {
    const stayItems = await query<{ id: string; name: string; stay_unit: string }>(
      `SELECT id, name, stay_unit FROM pos_items
        WHERE id = ANY($1::uuid[]) AND landlord_id = $2 AND stay_unit IS NOT NULL`,
      [itemIds, prop.landlord_id])
    if (stayItems.length > 1) {
      throw new AppError(400, 'One stay to a link — take the second stay out of the cart and send it on a link of its own.')
    }
    if (stayItems.length === 1) {
      const cartLine = (body.items as any[]).find((i) => i.id === stayItems[0].id)!
      stayLine = {
        itemId: stayItems[0].id, name: stayItems[0].name,
        stayUnit: stayItems[0].stay_unit as 'night' | 'week' | 'month',
        qty: Number(cartLine.qty) || 0,
      }
      if (!body.stay) {
        throw new AppError(400,
          `"${stayLine.name}" needs a site and an arrival date before a link can go out — `
          + 'pick them for the stay in the cart, then press Send link again. The site is held for them from the moment it is sent.')
      }
    }
  }
  if (body.stay && !stayLine) throw new AppError(400, `Nothing on this link is a stay — press Cancel, add the stay to the cart, then send the link again.`)
  // 10/2 (review): a link sent for a reservation that is already on the
  // schedule (bookingId, no stay of its own) pays THAT reservation when it is
  // paid — confirmed, deposit stamped paid (settleLinkBooking). So it carries
  // the amount owed on it, as its own line; a link of register items alone
  // would confirm the reservation for the price of a tank of propane.
  if (body.bookingId && !stayLine && !(body.items as any[]).some((i) => !i.id)) {
    throw new AppError(400, `A link for a reservation carries the amount owed on it — send the deposit from the reservation on the schedule instead, then try again.`)
  }
  // 10/2 (decisions #9): a reservation is charged at its own price — a link
  // that holds a stay, or pays toward a reservation, takes no discount.
  if ((stayLine || body.bookingId) && Number(body.discountAmount) > 0) {
    throw new AppError(400, reservationNoDiscountWords(press))
  }

  // The site's own rate, exactly as the counter and the booking site quote it.
  // (memory: gam-register-price-is-its-own-thing)
  let payItems = body.items as any[]
  // 10/2 (review): what the stay itself costs — the booking's total. (It was
  // the whole link's subtotal: a link for three nights and a tank of propane
  // put the propane on the booking too.) decisions #23: once sent, the stay is
  // the reservation's — changed only on the schedule.
  //
  // 10/5 (Nic, R5): a link sent from the register is the register — the stay
  // is priced in WHOLE nights, weeks or months at the site's rate for one of
  // them (priceWholeStay), never prorated, the same figure Charge takes.
  // R6: "Add a month" lengthens the stay here now instead (the month at the
  // monthly rate, a line toward that reservation). R1/R2/R8: what the stay
  // needs is the counter's (stayNeeds) — 22+ continuous nights with no check on
  // file put the background check's fee on the link as a line of its own; 30+
  // nights need the counter's lease-or-stay answer, and a lease is sent for its
  // deposit (its lease bills the rest).
  let stayTotal = 0
  let stayCharge = 0
  let stayTax = { base: 0, tax: 0, taxRate: 0 }
  let stayTerms: StayTerms | null = null
  let screeningFee = 0
  let screeningRequired = false
  let extendPlan: { bookingId: string; fromCheckOut: string; checkOut: string; price: number } | null = null
  let stayWhat: string | null = null
  if (stayLine && body.stay) {
    const shown = (body.items as any[]).find((i) => i.id === stayLine!.itemId)?.stayTotal
    const email = body.stay.guestEmail ?? body.customer?.email ?? null
    let needs: Awaited<ReturnType<typeof stayNeeds>>
    if (body.stay.extendBookingId) {
      if (stayLine.stayUnit !== 'month' || stayLine.qty !== 1) {
        throw new AppError(400, `Add a month adds one month — send it with the monthly stay at a quantity of 1, then press ${press} again.`)
      }
      const ext = await stayExtensionQuote(db, { landlordId: prop.landlord_id, propertyId: prop.id, bookingId: body.stay.extendBookingId, nothing: 'sent' })
      needs = await stayNeeds({ landlordId: prop.landlord_id, propertyId: prop.id, bookingId: ext.bookingId, tenantId: ext.tenantId,
        email: body.stay.guestEmail ?? ext.guestEmail ?? body.customer?.email ?? null, checkIn: ext.checkIn, checkOut: ext.checkOut,
        stayTerms: body.stay.stayTerms ?? null })
      stayWhat = reservationWhat({ nights: ext.addedNights, unitNumber: ext.unitNumber, checkIn: ext.fromCheckOut, checkOut: ext.checkOut })
      if (shown != null && Math.round(Number(shown) * 100) !== Math.round(ext.price * 100)) throw new AppError(409, linkStayNowWords(`a month added — ${stayWhat}`, ext.price))
      stayTerms = needs.leaseChoice === 'lease' || needs.leaseChoice === 'stay' ? needs.leaseChoice : null
      // 10/5 (Nic, M5): a month is sold only as a stay. Answered lease, no
      // month goes out — the lease is drafted instead (the register's Draft
      // their lease, POST /pos/stays/lease) and bills the months from then on.
      if (stayTerms === 'lease') {
        throw new AppError(409, 'They chose a lease, so no month is sent — the lease holds their site and bills the months from now on. '
          + 'Press Cancel, tap the stay above Charge, then press Draft their lease. Nothing was sent.')
      }
      extendPlan = { bookingId: ext.bookingId, fromCheckOut: ext.fromCheckOut, checkOut: ext.checkOut, price: ext.price }
      stayTotal = stayCharge = ext.price
      stayTax = { base: ext.price, tax: 0, taxRate: 0 }
      // The month is an amount toward that reservation (settleLinkBooking adds
      // it to what was paid), never a second stay on the schedule.
      payItems = payItems.map((i) => i.id === stayLine!.itemId
        ? { id: null, name: `Add a month — ${stayWhat}`.slice(0, 120), qty: 1, price: ext.price, tax: 0,
            extend: { ...extendPlan, stayTerms } }
        : i)
    } else {
      if (!body.stay.unitId || !body.stay.checkIn || !body.stay.guestName?.trim()) {
        throw new AppError(400, `"${stayLine.name}" needs a site, an arrival date and who it is for before a link can go out — pick them for the stay in the cart, then press ${press} again.`)
      }
      // The site has to be this property's before anything about it is read.
      const site = await queryOne<{ id: string }>(
        `SELECT id FROM units WHERE id = $1 AND property_id = $2 AND landlord_id = $3 AND retired_at IS NULL`,
        [body.stay.unitId, prop.id, prop.landlord_id])
      if (!site) throw new AppError(400, `That site is not at this property — pick the site again, then press ${press} again.`)
      const priced = await priceWholeStay(db, body.stay.unitId, stayLine.stayUnit, stayLine.qty, body.stay.checkIn,
        (unit, word) => `Site ${unit} has no ${word} rate set, so this stay cannot be priced — nothing was sent. `
          + `Set the site's ${word} rate (or the property's), then press ${press} again.`)
      needs = await stayNeeds({ landlordId: prop.landlord_id, propertyId: prop.id, email, checkIn: body.stay.checkIn,
        checkOut: priced.checkOut, stayTerms: body.stay.stayTerms ?? null })
      stayTerms = needs.leaseChoice === 'lease' || needs.leaseChoice === 'stay' ? needs.leaseChoice : null
      stayWhat = reservationWhat({ nights: priced.nights, unitNumber: priced.unitNumber, checkIn: body.stay.checkIn, checkOut: priced.checkOut })
      stayTotal = priced.total
      // R2/R4: a lease is sent for its deposit — the reservation then asks
      // exactly that (reservationDue: its lease bills the rest).
      stayCharge = stayTerms === 'lease' ? await leaseDepositFor(db, body.stay.unitId, priced.total, priced.nights) : priced.total
      stayTax = stayTerms === 'lease' ? { base: stayCharge, tax: 0, taxRate: 0 } : { base: priced.base, tax: priced.tax, taxRate: priced.taxRate }
      // 10/3 (review): the figure the clerk saw ("They pay") is the figure that
      // goes out — a site list opened before the site's rates changed is
      // refused before anything is held or sent, as Charge refuses it.
      if (shown != null && Math.round(Number(shown) * 100) !== Math.round(stayCharge * 100)) throw new AppError(409, linkStayNowWords(stayWhat, stayCharge))
      // The stay's line carries what one of it comes to before tax, and its
      // lodging tax as the line's tax; what the link charges for it is the
      // stay's own figure (stayCharge), never this line re-added.
      const per = round2(stayTax.base / stayLine.qty)
      payItems = payItems.map((i) => i.id === stayLine!.itemId ? { ...i, price: per, tax: stayTax.taxRate } : i)
    }
    // R7: a stay over three weeks needs the guest's email; R2: 30+ nights, the counter's answer.
    if (needs.nights >= STAY_SCREENING_NIGHTS && !(email || (extendPlan && needs.chain.email))) {
      throw new AppError(400, `This stay comes to ${needs.nights} nights in a row — a stay over three weeks needs the guest's email (their background check is sent to it). Type it, then press ${press} again.`)
    }
    if (needs.leaseChoice === 'needed') {
      throw new AppError(409, `This stay comes to ${needs.nights} nights in a row, so ask them: lease or no lease? `
        + 'A lease holds their site for as long as they stay. A stay holds it only through the time they have paid for. '
        + `Press Cancel, tap the stay above Charge, press Lease or No lease, then press ${press} again. Nothing was sent.`)
    }
    screeningRequired = needs.nights >= STAY_SCREENING_NIGHTS
    screeningFee = needs.screening === 'fee_due' ? round2(needs.screeningFee?.amount ?? 0) : 0
    // R8: the fee goes out only as the register showed it.
    if (screeningFee > 0 && Math.round((body.stay.screeningFee ?? -1) * 100) !== Math.round(screeningFee * 100)) {
      throw new AppError(409, `This stay comes to ${needs.nights} nights in a row and needs a background check — its ${money(screeningFee)} fee goes on the link, and the register shows something else, so nothing was sent. `
        + `Press Cancel, tap the stay above Charge, press Use this site, then press ${press} again.`)
    }
    if (screeningFee > 0) payItems = [...payItems, { id: null, name: SCREENING_LINE_NAME, qty: 1, price: screeningFee, tax: 0, screening: true }]
  }

  // A stay is its own figure; everything else on the link is priced as usual.
  // (The added month and the background check are lines of the server's own, at their own figures.)
  const restItems = payItems.filter((i) => !(stayLine && i.id === stayLine.itemId) && !i.extend && !i.screening)
  const restTotals = await computeCartTotals(prop.landlord_id, restItems, {
    surcharge: 0, discountAmount: stayLine ? 0 : (body.discountAmount ?? 0),
  })
  const totals = stayLine && body.stay
    ? { subtotal: round2(Number(restTotals.subtotal) + stayTax.base + screeningFee), taxAmount: round2(Number(restTotals.taxAmount) + stayTax.tax),
        discount: 0, total: round2(Number(restTotals.total) + stayCharge + screeningFee) }
    : restTotals
  if (!(Number(totals.total) > 0)) throw new AppError(400, `Nothing to charge — the total is $0. Add what they are paying for, then press ${press} again.`)
  if (body.bookingId) {
    const b = await queryOne<{ id: string }>(
      `SELECT b.id FROM unit_bookings b JOIN units u ON u.id = b.unit_id
        WHERE b.id = $1 AND u.property_id = $2`, [body.bookingId, prop.id])
    if (!b) throw new AppError(404, `That stay is not at this property — pick the site and dates again, then press ${press} again.`)
    // 10/2 (decisions #9): nothing is sent for a reservation with nothing left to pay.
    const due = await reservationDue(db, body.bookingId)
    assertReservationPayable(due,
      due?.status === 'no_show' ? 'That reservation was marked a no-show — nothing was sent. Look it up on the schedule.'
        : 'That reservation was canceled — nothing was sent. Look it up on the schedule.',
      'nothing was sent. Press Cancel.')
    // 10/2 (review): and never for more than is left to pay on it — paid after
    // another payment, it would bill the reservation twice.
    const asks = round2((body.items as any[]).filter((i) => !i.id).reduce((n, i) => n + (Number(i.qty) || 0) * (Number(i.price) || 0), 0))
    if (asks > due!.owed + 0.005) {
      throw new AppError(400, `That reservation has $${due!.owed.toFixed(2)} left to pay — a link for it can ask for that much at most. `
        + `Change the amount, then press ${press} again. To change what the reservation costs, use the schedule.`)
    }
    // 10/3 (review): a long stay's deposit is paid whole — a link for part of
    // it would be recorded as the deposit, and the rest of it never asked for.
    if (!stayLine && due!.leaseBillsRest && asks < due!.owed - 0.005) {
      throw new AppError(400, longStayDepositWholeWords(asks, due!.owed, 'sent'))
    }
  }
  // Someone picked from elsewhere: their record HERE is made now, with the link
  // (services/posPeople customerFromElsewhere) — the pick itself made nothing.
  let posCustomerId: string | null = body.posCustomerId ?? null
  let madeFromPick: string | null = null
  if (body.match) {
    const c = await getClient()
    try {
      await c.query('BEGIN')
      const r = await customerFromElsewhere(c, prop.landlord_id, req.user.userId, body.match.pick)
      await c.query('COMMIT')
      posCustomerId = r.customerId
      if (!r.existing) madeFromPick = r.customerId
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      throw e
    } finally { c.release() }
  }
  try {
    return await writePayLink(req, body, prop, { payItems, totals, stayLine, stayTotal, posCustomerId,
      stayTerms, screeningRequired, extendPlan, stayWhat })
  } catch (e) {
    // Nothing went out: a record made for the pick goes again.
    if (madeFromPick) {
      const { letGoOfPick } = await import('../services/posPeople')
      await letGoOfPick(db, prop.landlord_id, madeFromPick).catch(() => false)
    }
    throw e
  }
}

/** The writes of createPayLink: the held site (for a stay), the link, the email. */
async function writePayLink(req: any, body: z.infer<typeof createSchema>, prop: { id: string; name: string; landlord_id: string; register_card_fee_payer: CardFeePayer },
                            w: { payItems: any[]; totals: { subtotal: number; taxAmount: number; discount: number; total: number }
                                 stayLine: { itemId: string; name: string; stayUnit: 'night' | 'week' | 'month'; qty: number } | null
                                 stayTotal: number; posCustomerId: string | null
                                 /** 10/5 (Nic): the counter's lease-or-stay answer, a stay needing screening, a month added, and the stay in words. */
                                 stayTerms: StayTerms | null; screeningRequired: boolean
                                 extendPlan: { bookingId: string; fromCheckOut: string; checkOut: string; price: number } | null
                                 stayWhat: string | null }) {
  const { payItems, totals, stayLine, stayTotal } = w
  // The site comes off the board NOW. A link sitting unpaid in somebody's inbox
  // while the counter sells the same site to a walk-in is the double-booking
  // this whole mechanism exists to prevent — so the booking is written when the
  // link is sent, tentative and unpaid, and it is displaceable exactly like any
  // other unpaid hold. Both writes share one transaction: a held site with no
  // link, or a link with no site, are each worse than neither.
  let stayBookingId: string | null = body.bookingId ?? null
  // 10/3 (review): the hold and the link really do commit together now — one
  // client, one transaction. Before, the booking committed first and the link
  // was inserted after; a failed insert left a held site nobody could pay.
  const token = crypto.randomBytes(24).toString('hex')
  // 10/5: a stay's link says which stay — its site and dates — in the email and on the card page.
  const label = body.label?.trim()
    || (stayLine && w.stayWhat ? `${w.extendPlan ? 'Add a month' : stayLine.name} — ${w.stayWhat}`
      : body.items.length === 1 ? body.items[0].name : `${body.items.length} items`)
  const client = await getClient()
  let link: any
  try {
    await client.query('BEGIN')
    if (w.extendPlan) {
      // 10/5 (Nic, R6): the month comes off the board NOW, on the same stay —
      // a link that is closed unpaid gives it back (POST /:id/cancel). A link
      // is not payment, so it never moves anybody's hold.
      const ext = await extendStayByMonth(client, { landlordId: prop.landlord_id, propertyId: prop.id, bookingId: w.extendPlan.bookingId, nothing: 'sent' })
      if (Math.round(ext.price * 100) !== Math.round(w.extendPlan.price * 100) || ext.checkOut !== w.extendPlan.checkOut) {
        throw new AppError(409, 'That stay changed a moment ago — nothing was sent. Press Cancel, pick the stay again, then press Send link.')
      }
      if (body.stay?.guestEmail && !ext.guestEmail) {
        await client.query(`UPDATE unit_bookings SET guest_email = $2 WHERE id = $1 AND guest_email IS NULL`, [ext.bookingId, body.stay.guestEmail.toLowerCase()])
      }
      if (w.screeningRequired) await markScreeningRequired(client, ext.bookingId)
      stayBookingId = ext.bookingId
    } else if (body.stay && stayLine && body.stay.unitId && body.stay.checkIn) {
      const { checkOutFor, siteIsFree, createStayBooking } = await import('../services/registerStay')
      const checkOut = checkOutFor(body.stay.checkIn, stayLine.stayUnit, stayLine.qty)
      await client.query(
        `SELECT id FROM units WHERE id = $1 AND landlord_id = $2 FOR UPDATE`,
        [body.stay.unitId, prop.landlord_id])
      // A LINK IS NOT PAYMENT, so it displaces nobody. It may only take a site
      // nothing else is holding — the rank is money, not intent. createStayBooking
      // re-checks this under an advisory lock, which is what actually settles a
      // race; the check here is so the refusal reads like a sentence.
      if (!(await siteIsFree(client, body.stay.unitId, body.stay.checkIn, checkOut))) {
        throw new AppError(409, 'That site is not free for those dates — it is taken or someone is holding it, and a pay link cannot move a hold (only a payment can). Pick another site or other dates, then press Send link again — or charge for it here at the counter.')
      }
      const booking = await createStayBooking(client, {
        landlordId: prop.landlord_id,
        propertyId: prop.id,
        posTransactionId: null,
        status: 'tentative',
        lines: [{ itemId: stayLine.itemId, qty: stayLine.qty, stayUnit: stayLine.stayUnit,
                  name: stayLine.name, lineTotal: stayTotal }],
        details: {
          unitId: body.stay.unitId, checkIn: body.stay.checkIn,
          guestName: body.stay.guestName ?? '',
          guestPhone: body.stay.guestPhone ?? body.customer?.phone ?? null,
          guestEmail: body.stay.guestEmail ?? body.customer?.email ?? null,
        },
        // 10/5 (Nic, R2): the counter's answer rides on the hold — a lease is
        // then asked only its deposit (reservationDue), and is drafted, or the
        // stay's utilities set up, once the link is paid (afterLinkPaid).
        stayTerms: w.stayTerms,
        screeningRequired: w.screeningRequired,
      })
      stayBookingId = booking.bookingId
    }
    link = (await client.query(
      `INSERT INTO pos_pay_links
         (token, landlord_id, property_id, created_by, kind, label, items,
          subtotal, tax_amount, discount_amount, total,
          customer_name, customer_email, customer_phone, tenant_id, pos_customer_id, booking_id,
          card_fee_on_top, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               CASE WHEN $5 = 'one_time' THEN NOW() + INTERVAL '14 days' ELSE NULL END)
       RETURNING *`,
      [token, prop.landlord_id, prop.id, req.user.userId, body.kind, label.slice(0, 120),
       JSON.stringify(payItems), totals.subtotal, totals.taxAmount, totals.discount, totals.total,
       body.customer?.name ?? null, body.customer?.email?.toLowerCase() ?? null, body.customer?.phone ?? null,
       body.tenantId ?? null, w.posCustomerId, stayBookingId,
       prop.register_card_fee_payer === 'customer'])).rows[0]
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }

  const { customerFee, charged } = payLinkCharge(Number(link.total), payerOf(link))
  if (link.kind === 'one_time') {
    const { emailPayLink } = await import('../services/email')
    await emailPayLink({
      to: link.customer_email, name: link.customer_name, propertyName: prop.name,
      label: link.label, amount: Number(link.total), cardFee: customerFee, url: payLinkUrl(token),
      // 10/5 (Nic, R13/R8): how long a stay with no lease holds the site, and what its background check is for — said before they pay.
      note: await linkEmailNote(link),
      // 10/5: replies reach the people who run this property (services/replyRouting).
      ctx: { landlordId: prop.landlord_id, payLinkId: link.id, replyTo: replyToProperty(link.property_id) },
    }).catch((e: unknown) => logger.error({ err: e, payLinkId: link.id }, '[pay-link] email failed'))
  }
  return { ...link, url: payLinkUrl(token), card_fee: customerFee, charged }
}

/**
 * S652 — the deposit on a reservation taken at the counter.
 *
 * Nic's counter script ends here: dates, then what is available, then the space,
 * then a name and an email, "→ emailed a deposit pay link". The guest is not
 * standing at a card reader — they rang, or they walked off — so the deposit is
 * a link rather than a charge, and the site is held unpaid until it is paid.
 *
 * Deliberately the SAME deposit the booking site would have quoted for the same
 * stay (services/propertyBooking quoteStay), because a guest who phones and a
 * guest who books online are buying the identical nights on the identical site.
 *
 * Idempotent per booking: the row is claimed on `deposit_amount IS NULL`, so a
 * double-click never sends two links or bills two deposits.
 */
export async function createBookingDepositLink(opts: {
  bookingId: string; landlordId: string; propertyId: string
  amount: number; guestName: string | null; guestEmail: string
  /**
   * 10/5 (Nic, A2): the background check's fee (stayNeeds().screeningFee.amount)
   * for a stay that needs one with nothing on file — added as its own fixed
   * line the payer cannot take off. GAM's money, never the deposit: paid, it
   * is recorded as the guest's prepaid check (recordLinkScreening). A $0
   * deposit with a fee still makes a link — for the fee alone
   * (createScreeningFeeLink).
   */
  screeningFee?: number | null
}): Promise<{ id: string; url: string } | null> {
  const fee = round2(Number(opts.screeningFee) || 0)
  if (!(opts.amount > 0)) {
    if (!(fee > 0)) return null
    return createScreeningFeeLink({ bookingId: opts.bookingId, landlordId: opts.landlordId, propertyId: opts.propertyId,
      amount: fee, guestName: opts.guestName, guestEmail: opts.guestEmail })
  }
  if (!(await connectIdFor(opts.landlordId))) throw new AppError(409, 'Card payments are not set up for this property yet — finish payout setup under Banking first.')
  const client = await getClient()
  let link: any
  let propName = ''
  try {
    await client.query('BEGIN')
    const claimed = await client.query(
      `UPDATE unit_bookings SET deposit_amount = $2, updated_at = NOW()
        WHERE id = $1 AND deposit_amount IS NULL RETURNING id`, [opts.bookingId, opts.amount])
    if (!claimed.rows.length) { await client.query('ROLLBACK'); return null }
    const prop = (await client.query<{ name: string; booking_card_fee_payer: CardFeePayer }>(
      `SELECT name, booking_card_fee_payer FROM properties WHERE id = $1`, [opts.propertyId])).rows[0]
    propName = prop.name
    const owner = (await client.query<{ user_id: string }>(
      `SELECT user_id FROM landlords WHERE id = $1`, [opts.landlordId])).rows[0]
    const items: any[] = [{ id: null, name: 'Reservation deposit', qty: 1, price: opts.amount, tax: 0 }]
    // 10/5 (Nic, R8/A2): the check rides on the deposit link as its own line.
    if (fee > 0) items.push(screeningLinkLine(fee))
    const total = round2(opts.amount + fee)
    const token = crypto.randomBytes(24).toString('hex')
    link = (await client.query(
      `INSERT INTO pos_pay_links
         (token, landlord_id, property_id, created_by, kind, label, items,
          subtotal, tax_amount, discount_amount, total,
          customer_name, customer_email, booking_id, card_fee_on_top)
       VALUES ($1,$2,$3,$4,'one_time',$5,$6::jsonb,$7,0,0,$7,$8,$9,$10,$11)
       RETURNING *`,
      [token, opts.landlordId, opts.propertyId, owner.user_id,
       fee > 0 ? 'Reservation deposit and background check' : 'Reservation deposit', JSON.stringify(items), total, opts.guestName,
       opts.guestEmail.toLowerCase(), opts.bookingId, prop.booking_card_fee_payer === 'customer'])).rows[0]
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }

  // No expiry on the LINK either. A deposit link that dies on its own leaves a
  // held site and a guest holding a dead URL, and somebody has to notice.
  const { customerFee } = payLinkCharge(Number(link.total), payerOf(link))
  const { emailPayLink } = await import('../services/email')
  await emailPayLink({
    to: link.customer_email, name: link.customer_name, propertyName: propName,
    label: link.label, amount: Number(link.total), cardFee: customerFee, url: payLinkUrl(link.token),
    neverExpires: true,
    note: await linkEmailNote(link),
    // 10/5: replies reach the people who run this property (services/replyRouting).
    ctx: { landlordId: opts.landlordId, payLinkId: link.id, replyTo: replyToProperty(link.property_id) },
  }).catch((e: unknown) => logger.error({ err: e, payLinkId: link.id }, '[deposit-link] email failed'))
  return { id: link.id, url: payLinkUrl(link.token) }
}

/**
 * 10/5 (Nic): what a link's email says before the amount is paid — R13's
 * held-through sentence for a 30+ night stay with no lease, and what the
 * background check on it is for (R8). Null when neither applies.
 */
async function linkEmailNote(link: any): Promise<string | null> {
  const held = await linkHeldWords(link).catch(() => null)
  const parts = [held, linkScreeningLine(link) ? SCREENING_LINK_NOTE : null].filter(Boolean)
  return parts.length ? parts.join(' ') : null
}

/** 10/5 (Nic, R8): what the guest is told about the background check a link carries. */
const SCREENING_LINK_NOTE = 'Your stay comes to more than three weeks, so a background check is required. '
  + 'Once this is paid, we email you the link to fill it out — you are not charged for it again.'

/** A link's background-check line, as the server writes it (isScreeningLine). `bookingId` names the stay on a fee-only link. */
function screeningLinkLine(fee: number, bookingId?: string): Record<string, unknown> {
  return { id: null, name: SCREENING_LINE_NAME, qty: 1, price: round2(fee), tax: 0, screening: true, ...(bookingId ? { bookingId } : {}) }
}

/**
 * 10/5 (Nic, A2) — A LINK FOR THE BACKGROUND CHECK ALONE.
 *
 * "A schedule edit/drag that makes an existing stay need the fee creates and
 * emails a pay link for the fee automatically (check-in waits anyway)." The
 * stay itself is already arranged (paid, or billed some other way); this link
 * carries only the check's fixed line — the payer cannot take it off — and the
 * card fee follows the property's one fee choice (A1), like any link.
 *
 * It is NOT a link for the reservation: the stay is named on its line
 * (`bookingId`), never as the link's booking_id, so nothing that pays, closes
 * or reprices a reservation (paid in full elsewhere, a deposit, the arrival-day
 * balance, Close on another link) ever touches it, and paying it is never
 * money toward the stay. Paid, it records the guest's prepaid check (source
 * 'schedule'; online it is GAM's money on GAM's balance — A5) and the guest is
 * emailed the check's own link.
 *
 * Idempotent per booking: an unpaid fee-only link already out for the stay is
 * returned, never a second one; a stay whose check is already paid for gets
 * none (null). Null when amount <= 0.
 */
export async function createScreeningFeeLink(opts: {
  bookingId: string; landlordId: string; propertyId: string
  amount: number; guestName: string | null; guestEmail: string
}): Promise<{ id: string; url: string } | null> {
  const amount = round2(Number(opts.amount) || 0)
  if (!(amount > 0)) return null
  if (!(await connectIdFor(opts.landlordId))) throw new AppError(409, 'Card payments are not set up for this property yet — finish payout setup under Banking first.')
  const client = await getClient()
  let link: any
  let propName = ''
  try {
    await client.query('BEGIN')
    // One at a time per stay: two schedule saves a moment apart send one link.
    const b = (await client.query<{ id: string }>(
      `SELECT b.id FROM unit_bookings b JOIN units u ON u.id = b.unit_id
        WHERE b.id = $1 AND u.landlord_id = $2 AND u.property_id = $3 FOR UPDATE OF b`,
      [opts.bookingId, opts.landlordId, opts.propertyId])).rows[0]
    if (!b) throw new AppError(404, 'That reservation is not at this property any more — no link was sent.')
    const open = (await client.query<{ id: string; token: string }>(
      `SELECT id, token FROM pos_pay_links
        WHERE landlord_id = $1 AND status = 'open' AND kind = 'one_time' AND booking_id IS NULL
          AND items @> $2::jsonb
        ORDER BY created_at LIMIT 1`,
      [opts.landlordId, JSON.stringify([{ screening: true, bookingId: opts.bookingId }])])).rows[0]
    if (open) { await client.query('ROLLBACK'); return { id: open.id, url: payLinkUrl(open.token) } }
    // Already paid for this stay (the counter, a deposit link, the booking site): nothing to send.
    if (await screeningPaidForStay(opts.bookingId)) { await client.query('ROLLBACK'); return null }
    const prop = (await client.query<{ name: string; register_card_fee_payer: CardFeePayer }>(
      `SELECT name, register_card_fee_payer FROM properties WHERE id = $1`, [opts.propertyId])).rows[0]
    propName = prop.name
    const owner = (await client.query<{ user_id: string }>(
      `SELECT user_id FROM landlords WHERE id = $1`, [opts.landlordId])).rows[0]
    const items = [screeningLinkLine(amount, opts.bookingId)]
    const token = crypto.randomBytes(24).toString('hex')
    link = (await client.query(
      `INSERT INTO pos_pay_links
         (token, landlord_id, property_id, created_by, kind, label, items,
          subtotal, tax_amount, discount_amount, total,
          customer_name, customer_email, booking_id, card_fee_on_top)
       VALUES ($1,$2,$3,$4,'one_time',$5,$6::jsonb,$7,0,0,$7,$8,$9,NULL,$10)
       RETURNING *`,
      [token, opts.landlordId, opts.propertyId, owner.user_id, 'Background check for your stay', JSON.stringify(items), amount,
       opts.guestName, opts.guestEmail.toLowerCase(),
       // A1: the property's one fee choice (the DB keeps its register and booking settings the same).
       prop.register_card_fee_payer === 'customer'])).rows[0]
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }

  // No expiry: check-in waits on the check, so the link stays good until it is paid or closed.
  const { customerFee } = payLinkCharge(Number(link.total), payerOf(link))
  const { emailPayLink } = await import('../services/email')
  await emailPayLink({
    to: link.customer_email, name: link.customer_name, propertyName: propName,
    label: link.label, amount: Number(link.total), cardFee: customerFee, url: payLinkUrl(link.token),
    neverExpires: true, note: await linkEmailNote(link),
    ctx: { landlordId: opts.landlordId, payLinkId: link.id, replyTo: replyToProperty(link.property_id) },
  }).catch((e: unknown) => logger.error({ err: e, payLinkId: link.id }, '[screening-link] email failed'))
  return { id: link.id, url: payLinkUrl(link.token) }
}

/**
 * S649 — the balance of a short stay, billed on arrival day (services/stayBalance).
 * A one-time link tied to the booking; the card fee follows the property's
 * booking-site setting. Idempotent per booking: the booking row is claimed
 * first, so a second run never sends a second link.
 */
export async function createStayBalanceLink(opts: {
  bookingId: string; landlordId: string; propertyId: string; label: string
  amount: number; guestName: string | null; guestEmail: string
}): Promise<{ id: string } | null> {
  if (!(opts.amount > 0)) return null
  if (!(await connectIdFor(opts.landlordId))) throw new AppError(409, 'Card payments are not set up for this property yet — finish payout setup under Banking first.')
  const client = await getClient()
  let link: any
  let propName = ''
  try {
    await client.query('BEGIN')
    const claimed = await client.query(
      `UPDATE unit_bookings SET balance_billed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND balance_billed_at IS NULL RETURNING id`, [opts.bookingId])
    if (!claimed.rows.length) { await client.query('ROLLBACK'); return null }
    const prop = (await client.query<{ name: string; booking_card_fee_payer: CardFeePayer }>(
      `SELECT name, booking_card_fee_payer FROM properties WHERE id = $1`, [opts.propertyId])).rows[0]
    propName = prop.name
    const owner = (await client.query<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [opts.landlordId])).rows[0]
    const items = [{ id: null, name: opts.label.slice(0, 120), qty: 1, price: opts.amount, tax: 0 }]
    link = (await client.query(
      `INSERT INTO pos_pay_links
         (token, landlord_id, property_id, created_by, kind, label, items,
          subtotal, tax_amount, discount_amount, total,
          customer_name, customer_email, booking_id, card_fee_on_top, expires_at)
       VALUES ($1,$2,$3,$4,'one_time',$5,$6::jsonb,$7,0,0,$7,$8,$9,$10,$11, NOW() + INTERVAL '14 days')
       RETURNING *`,
      [crypto.randomBytes(24).toString('hex'), opts.landlordId, opts.propertyId, owner.user_id,
       'Stay balance', JSON.stringify(items), opts.amount, opts.guestName, opts.guestEmail.toLowerCase(),
       opts.bookingId, prop.booking_card_fee_payer === 'customer'])).rows[0]
    await client.query(`UPDATE unit_bookings SET balance_pay_link_id = $2 WHERE id = $1`, [opts.bookingId, link.id])
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
  const { customerFee } = payLinkCharge(Number(link.total), payerOf(link))
  const { emailPayLink } = await import('../services/email')
  await emailPayLink({
    to: link.customer_email, name: link.customer_name, propertyName: propName,
    label: opts.label, amount: Number(link.total), cardFee: customerFee, url: payLinkUrl(link.token),
    // 10/5: replies reach the people who run this property (services/replyRouting).
    ctx: { landlordId: opts.landlordId, payLinkId: link.id, replyTo: replyToProperty(link.property_id) },
  }).catch((e: unknown) => logger.error({ err: e, payLinkId: link.id }, '[stay-balance] email failed'))
  return { id: link.id }
}

// GET /api/pos/pay-links/people?propertyId=&q= — S649 (Nic): who to send a bill to.
//
// 10/2: the register's own search (services/posPeople searchPeople), so a pay
// link finds people exactly as the register does: this property's residents
// and this company's customers by part of a name, email or phone; anyone else
// on GAM by part of a name or an email or phone typed whole, as a name and a
// masked hint only — never their real
// email or phone (the old search here answered an email with the person's
// phone too). Same guard and the same limit (one count, shared with the
// register). The company is the property's.
posPayLinksRouter.get('/people', requirePerm('pos.ring_sale'), peopleQueryGuard, peopleSearchLimiter, crossCompanyLimiter, async (req: any, res, next) => {
  try {
    const propertyId = parseForStaff(z.string().uuid(), req.query.propertyId, {}, LINK_PROPERTY_FIRST)
    const prop = await propertyFor(req, propertyId)
    const people = await searchPeople({ landlordId: prop.landlord_id, propertyId, userId: req.user.userId, q: req.query.q, allowElsewhere: !req.crossCompanyLimited })
    res.json({ success: true, data: people, ...(req.crossCompanyLimited ? { elsewhereLimited: true } : {}) })
  } catch (e) { next(e) }
})

posPayLinksRouter.post('/', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const press = req.body?.kind === 'standing' ? 'Create QR code' : 'Send link'
    const body = parseForStaff(createSchema, req.body, linkWords(press),
      `The link could not be made — check the cart and the details, then press ${press} again.`)
    res.status(201).json({ success: true, data: await createPayLink(req, body) })
  } catch (e) { next(e) }
})

// GET /api/pos/pay-links?propertyId= — open links and standing QR codes.
posPayLinksRouter.get('/', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const propertyId = parseForStaff(z.string().uuid(), req.query.propertyId, {}, LINK_PROPERTY_FIRST)
    await propertyFor(req, propertyId)
    const rows = await query<any>(
      `SELECT l.*,
              (SELECT COUNT(*)::int FROM pos_transactions t WHERE t.pay_link_id = l.id) AS times_paid
         FROM pos_pay_links l
        WHERE l.property_id = $1
          AND (l.status = 'open' OR l.paid_at > NOW() - INTERVAL '7 days')
        ORDER BY (l.kind = 'standing') DESC, l.created_at DESC
        LIMIT 100`, [propertyId])
    // 10/3 (decisions #23): an open link that pays a reservation is listed at
    // what it asks NOW (linkAsksNow — the same figure Send again emails, the
    // card page charges and the register takes), never the figure stored when
    // it was sent. Its stored lines stay as they are (`items`); one whose
    // reservation can no longer be paid says why and what to press (`note`).
    const data = []
    for (const r of rows) {
      let shown = { subtotal: r.subtotal, tax_amount: r.tax_amount, total: r.total }
      let note: string | null = null
      // 10/3 (review): the stay Close would cancel — so the row can say so, and ask first.
      let holdsStay: StayCloseCancels | null = null
      if (r.booking_id && r.status === 'open' && r.kind === 'one_time') {
        holdsStay = await stayCloseCancels(db, r)
        note = await linkListNote(r)
        if (!note) {
          try {
            const now = await linkAsksNow(db, r, { press: 'Pay Links' })
            shown = { subtotal: now.subtotal, tax_amount: now.taxAmount, total: now.total }
          } catch (e) {
            if (!(e instanceof AppError)) throw e
            note = e.message
          }
        }
      }
      data.push({ ...r, ...shown, note, holds_stay: holdsStay, url: payLinkUrl(r.token), ...payLinkCharge(Number(shown.total), payerOf(r)) })
    }
    res.json({ success: true, data })
  } catch (e) { next(e) }
})

// POST /api/pos/pay-links/:id/cancel
// PATCH /api/pos/pay-links/:id — S652 (Nic): "does it let you edit the ticket
// or pay link, or once the link is sent is it fixed to those items? ...if we
// need to do last minute prorations or adjustments, the functionality of the
// front counter person needs to be there." An OPEN one-time link can have its
// lines changed until it is paid: a final electric read, a correction. Same
// link, same address; the person just sees the new total. A checkout the payer
// already started at the old amount is closed at Stripe first, so the old
// figure can never be paid. 10/3 (decisions #23): a reservation on the link is
// not one of those lines — its nights, site and price change on the schedule,
// and the link asks what it owes.
posPayLinksRouter.patch('/:id', requirePerm('pos.ring_sale'), async (req: any, res, next) => {
  try {
    const body = parseForStaff(z.object({
      items: z.array(itemSchema).min(1).max(60),
      discountAmount: z.number().min(0).optional(),
      label: z.string().max(120).optional(),
    }), req.body, { ...linkWords('Save changes'), items: 'Keep at least one line (60 at most), then press Save changes again.' },
    'The changes could not be saved — check each line, then press Save changes again.')
    const link = /^[0-9a-f-]{36}$/i.test(String(req.params.id))
      ? await queryOne<any>(`SELECT * FROM pos_pay_links WHERE id = $1`, [req.params.id]) : null
    if (!link || !canManageLandlordResource(req.user, link.landlord_id)) {
      throw new AppError(404, 'That pay link is not on this account any more — open the list again to see what is still out.')
    }
    await assertPropertyInScope(req.user, link.property_id)
    if (link.kind !== 'one_time') throw new AppError(400, 'A standing QR link has one price and no lines to adjust — close it and make a new one instead.')
    if (link.status !== 'open') throw new AppError(409, 'This link has already been paid or closed — there is nothing to adjust. Open the list again to see what is still out.')
    // 10/3 (review): a link whose reservation is over (cancelled, a no-show),
    // already paid, or has no price is refused first, in Adjust's own words —
    // nothing was changed, and the next step is one this screen has.
    if (link.booking_id) {
      const closedWords = linkReservationClosedWords(await reservationDue(db, link.booking_id), 'Save changes')
      if (closedWords) throw new AppError(409, closedWords)
    }
    // 10/2 (review): every item id lowercase, as the database writes it.
    link.items = lowerLineIds(Array.isArray(link.items) ? link.items : [])
    // 10/5 (Nic, R6/R8): its background check and its added month stay as the server wrote them.
    const items = keepLinkServerLines(link, lowerLineIds(body.items as any[]), 'Save changes')
    // Same rules as sending it (createPayLink): the catalog's prices, no
    // discount and no typed-in amounts for a cashier — except the link's own:
    // its lines at its prices (no more of them than it carries), and its
    // discount for the share of the link the adjustment keeps. 10/2 (review):
    // the link's whole discount used to ride along whatever was left — $50 off
    // ten tanks kept at $50 off three. With no discount sent, the link keeps
    // its own for the share kept (linkDiscountFor).
    const { assertCashierPricing, cashiersOwn, termsOfLinkFor, carriesLinkDiscountPastShare, linkDiscountWholeWords } = await import('./pos')
    const terms = termsOfLinkFor(link, items)
    const discount = body.discountAmount ?? terms.discount
    // 10/2 (decisions #9): a link for a reservation is its price, whole.
    if (link.booking_id && Number(discount) > 0) throw new AppError(400, reservationNoDiscountWords('Save changes'))
    if (body.discountAmount != null && carriesLinkDiscountPastShare(req.user, link, items, discount)) {
      throw new AppError(403, linkDiscountWholeWords('Save changes'))
    }
    const own = cashiersOwn(items.map((i) => ({ itemId: i.id ?? null, price: i.price, qty: i.qty })), discount, terms)
    await assertCashierPricing(req, own.lines, own.discount, link.landlord_id, 'Save changes')
    await assertOneOffLinesAllowed(req, items, 'one_time', link.items)
    await assertItemsAreOurs(link.landlord_id, items, 'Save changes')
    await assertWholeStays(link.landlord_id, items, 'Save changes')   // 10/2 (review): whole nights
    // 10/2 (review): a stay on the link was priced from its site, and the site
    // held for those nights, when the link was sent. An adjustment keeps it —
    // the same stay item at the same price — and never adds a stay (or more
    // nights) the schedule has not heard of. Stays are not held to the
    // catalog price (the site decides), so without this a price on a stay
    // line could be set to anything here and then settled as the link's own
    // at the counter.
    await assertLinkStaysKept(link, items)
    const stay = await linkStayOf(db, link)
    // 10/2 (review): a link for a reservation's deposit or balance keeps that
    // line whole — paid online it confirms the reservation and stamps it paid.
    assertLinkBookingLinesKept(link, stay, items, 'Save changes')
    // 10/3 (decisions #23): a link for a reservation is charged what the
    // reservation owes now — Adjust changes the OTHER lines on it (a tank of
    // propane), never the stay: its nights, site and price change only on the
    // schedule, and a stay line kept short (or long, or taken out) is refused.
    const linkRes = await linkReservation(db, link, { press: 'Save changes' })
    if (stay && linkRes) assertLinkStayWhole(stay, linkRes.due, items, 'Save changes', 'changed')
    const totals = linkRes
      ? await linkAsCharged({ ...link, items }, linkRes)
      : await computeCartTotals(link.landlord_id, items, { surcharge: 0, discountAmount: discount })
    if (!(Number(totals.total) > 0)) throw new AppError(400, 'Nothing to charge — the total is $0. Put back what they are paying for, then press Save changes again.')

    // The payer may have a card page open at the OLD amount. Close it. 10/2
    // (review): and if they finished paying on it a moment ago, the link is not
    // changed — changed under it, the payment would no longer match the link
    // and would be recorded as nothing (finalizePayLink's amount check). The
    // page is read fresh and closed just before the change, and the change
    // lands only while that is still the link's page: one opened in between
    // (still at the old amount) refuses the change — pressed again, it closes
    // that one too.
    let page: { page: 'none' | 'closed' | 'paid'; closedId: string | null }
    try {
      page = await closeLinkPageNow(link.id)
    } catch (e) {
      logger.warn({ err: e, payLinkId: link.id }, '[pay-link] could not close the old card page before changing the link')
      throw new AppError(503, 'The card page sent with this link could not be closed just now — nothing was changed. Wait a moment, then press Save changes again.')
    }
    if (page.page === 'paid') {
      throw new AppError(409, 'That link was just paid online — nothing was changed. Open the list again in a moment; it shows as paid once the payment lands.')
    }
    const label = body.label?.trim()
      || (items.length === 1 ? items[0].name : `${items.length} items`)
    // The link changes only while its reservation still owes what was read above.
    const client = await getClient()
    let updated: any
    try {
      await client.query('BEGIN')
      if (linkRes) {
        const now = await linkReservation(client, link, { lock: true, press: 'Save changes' })
        if (!now || Math.round(now.charge * 100) !== Math.round(linkRes.charge * 100)) {
          throw new AppError(409, 'That reservation changed on the schedule a moment ago — nothing was changed. Open the list again, then press Save changes.')
        }
      }
      updated = (await client.query<any>(
        `UPDATE pos_pay_links
            SET items = $2::jsonb, subtotal = $3, tax_amount = $4, discount_amount = $5, total = $6,
                label = $7, last_checkout_session_id = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'open' AND last_checkout_session_id IS NOT DISTINCT FROM $8 RETURNING *`,
        [link.id, JSON.stringify(items), totals.subtotal, totals.taxAmount, totals.discount, totals.total, label.slice(0, 120), page.closedId])).rows[0]
      if (!updated) {
        const now = (await client.query<{ status: string }>(`SELECT status FROM pos_pay_links WHERE id = $1`, [link.id])).rows[0]
        if (now?.status === 'open') throw new AppError(409, linkOpenedMeanwhileWords('changed', 'Save changes'))
        throw new AppError(409, 'This link was paid a moment ago — there is nothing to adjust. Open the list again to see what is still out.')
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally { client.release() }
    const { customerFee, charged } = payLinkCharge(Number(updated.total), payerOf(updated))
    res.json({ success: true, data: { ...updated, url: payLinkUrl(updated.token), card_fee: customerFee, charged } })
  } catch (e) { next(e) }
})

const LINK_GONE = 'That pay link is not on this account any more — open the Pay Links list again to see what is still out.'

/** Said before the never-moved-in close's own words when it refuses a pay link's close. */
const PAY_LINK_LEASE_REFUSAL_LEAD =
  'The link was not closed. This hold has a lease drafted with it, and closing the link ends that lease — but '

/** The 409 when closing a link would zero a drafted lease's move-in bill (decisions #53: never blind). */
function payLinkWouldZeroWords(amount: number): string {
  return `The link was not closed. The lease drafted with this hold has an unpaid ${centsWordsOf(amount)} move-in bill, ` +
    'and closing the link would zero it. Cancel the reservation on the Schedule instead — it shows what ending ' +
    'the lease zeroes before anything changes.'
}
/** Added when a close is refused after the link's card page was already closed. */
const PAY_LINK_PAGE_CLOSED_WORDS =
  'The link is still open, but the card page it had was closed — if the payer was on it, they open the link again to pay.'
const centsWordsOf = (amount: number) =>
  `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * Before a link's card page is closed: when the link's unpaid hold would be
 * canceled and a lease drafted with it is more than paperwork (the landlord
 * signed it, or it has a bill), the never-moved-in close must apply and zero
 * nothing — else the close is refused now, with nothing changed.
 */
async function refuseClosingOverIssuedLease(bookingId: string): Promise<void> {
  const issued = (await query<{ id: string }>(
    `SELECT l.id FROM leases l
       JOIN unit_bookings b ON b.id = l.source_booking_id
      WHERE l.source_booking_id = $1 AND l.status IN ('pending','draft')
        AND b.status = 'tentative' AND b.deposit_paid_at IS NULL AND b.pos_transaction_id IS NULL
        AND (l.signed_by_landlord IS TRUE OR EXISTS (SELECT 1 FROM invoices i WHERE i.lease_id = l.id))
      ORDER BY l.created_at, l.id`, [bookingId]))
  if (!issued.length) return
  const { assessNeverMovedIn } = await import('../lib/unwindIssuedLease')
  const q = (text: string, params?: any[]) => db.query(text, params)
  for (const l of issued) {
    const a = await assessNeverMovedIn(q, l.id, { attested: true, lock: false, cancelingBooking: bookingId })
    if (!a.applies) {
      const words = a.words ?? 'This lease can’t be closed as never moved in.'
      throw new AppError(409, `${PAY_LINK_LEASE_REFUSAL_LEAD}${words.charAt(0).toLowerCase()}${words.slice(1)}`)
    }
    if (Math.round(a.total * 100) > 0) throw new AppError(409, payLinkWouldZeroWords(a.total))
  }
}

posPayLinksRouter.post('/:id/cancel', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const link = /^[0-9a-f-]{36}$/i.test(String(req.params.id))
      ? await queryOne<any>(`SELECT * FROM pos_pay_links WHERE id = $1`, [req.params.id]) : null
    if (!link) throw new AppError(404, LINK_GONE)
    await propertyFor(req, link.property_id)
    if (link.status !== 'open') throw new AppError(409, 'That link is already closed or paid — open the Pay Links list again to see what is still out.')
    // 10/2 (review): its card page is closed at Stripe FIRST — a payer could be
    // on it right now. One they already finished paying on is not closed: the
    // money is in, and closing the link would leave it paid with no sale (the
    // payment records itself as it lands). A standing QR code's pages are each
    // a payment of their own, so a finished one never stops it being retired.
    // 10/2 (review): the page is read fresh and closed just before, and an
    // emailed link closes only while that is still its page — one the payer
    // opened in between would stay payable behind a closed link. (A standing
    // QR code's pages are each their own payment, opened by anyone at any
    // time: it is retired whatever page is open.)
    // 10/4 (review LOW): a hold whose drafted lease the landlord signed, or
    // that already has its move-in bill, is ended through the never-moved-in
    // close below — never a bare status change. Asked before the card page is
    // closed: a close that would zero a bill (it never runs blind, decisions
    // #53) or that does not apply is refused with the link left as it was.
    const stay = await linkStayOf(db, link)
    if (stay) await refuseClosingOverIssuedLease(stay.bookingId)
    let page: { page: 'none' | 'closed' | 'paid'; closedId: string | null }
    try {
      page = await closeLinkPageNow(link.id)
    } catch (e) {
      logger.warn({ err: e, payLinkId: link.id }, '[pay-link] could not close the card page before closing the link')
      throw new AppError(503, 'The card page sent with this link could not be closed just now — the link is still open. Wait a moment, then press Close again.')
    }
    if (page.page === 'paid' && link.kind === 'one_time') {
      throw new AppError(409, 'That link was just paid online — it was not closed. Open the Pay Links list again in a moment; it shows as paid once the payment lands.')
    }
    // 10/2 (review): a link that held a site lets it go when it is closed — an
    // unpaid hold nobody can pay any more would keep the site off the board.
    // Only the hold the link made itself, and only while nothing is paid on it.
    let stayCancelled = false
    let stopAfterCommit: string[] = []
    let closingLease = false
    // 10/5 (Nic, R6): a month a link added, given back when the link closes unpaid.
    const extend = linkExtendLine(link)
    let monthGivenBack = false
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const closed = await client.query(
        `UPDATE pos_pay_links SET status = 'cancelled', updated_at = NOW()
          WHERE id = $1 AND status = 'open' AND (kind = 'standing' OR last_checkout_session_id IS NOT DISTINCT FROM $2) RETURNING id`,
        [link.id, page.closedId])
      if (!closed.rows.length) {
        const now = (await client.query<{ status: string }>(`SELECT status FROM pos_pay_links WHERE id = $1`, [link.id])).rows[0]
        if (now?.status === 'open') throw new AppError(409, linkOpenedMeanwhileWords('closed', 'Close'))
        throw new AppError(409, 'That link was paid or closed a moment ago — open the Pay Links list again to see what is still out.')
      }
      if (stay) {
        const letGo = await client.query(
          `UPDATE unit_bookings SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW(),
                  notes = TRIM(COALESCE(notes, '') || ' Held by a pay link that was closed before it was paid.')
            WHERE id = $1 AND status = 'tentative' AND deposit_paid_at IS NULL AND pos_transaction_id IS NULL`, [stay.bookingId])
        stayCancelled = (letGo.rowCount ?? 0) > 0
        // 10/3 (review): a hold lengthened on the schedule to a long stay has a
        // lease drafted from it. Closing the link ends that unsigned draft too
        // — the same rule holdDisplacement and the schedule's cancel follow — so
        // the site really is free. A signed (active) lease is never touched.
        if (stayCancelled) {
          // Paperwork only (never signed by the landlord, no bill made): a bare end, as before.
          await client.query(
            `UPDATE leases SET status = 'terminated', updated_at = NOW()
              WHERE source_booking_id = $1 AND status IN ('pending','draft')
                AND signed_by_landlord IS NOT TRUE
                AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.lease_id = leases.id)`, [stay.bookingId])
          // 10/4 (review LOW): anything else goes through the one never-moved-in
          // close (decisions #46.4) — the household taken off, nothing left
          // owed on an ended lease. Checked again here, under its locks: a
          // close that would now zero a bill is refused and nothing changes.
          const issued = (await client.query<{ id: string; unit_id: string }>(
            `SELECT id, unit_id FROM leases WHERE source_booking_id = $1 AND status IN ('pending','draft')
              ORDER BY created_at, id`, [stay.bookingId])).rows
          if (issued.length) {
            const { endLeaseNeverMovedIn } = await import('../lib/unwindIssuedLease')
            closingLease = true
            for (const l of issued) {
              const closed = await endLeaseNeverMovedIn(client, l, {
                cancelingBooking: stay.bookingId, actorUserId: (req as any).user?.userId ?? null,
                refusalLead: PAY_LINK_LEASE_REFUSAL_LEAD,
              })
              if (closed.closedAmount > 0) throw new AppError(409, payLinkWouldZeroWords(closed.closedAmount))
              stopAfterCommit.push(...closed.cancelAfterCommit)
            }
          }
        }
      }
      // 10/5 (Nic, R5/R6): the stay is held only through what is paid — a
      // month nobody paid for goes back on the board with the link. Only while
      // nothing was paid toward it and the stay still ends where the month
      // left it (a stay changed on the schedule since is left as it is).
      if (extend) {
        monthGivenBack = await undoStayExtension(client, extend)
        if (!monthGivenBack) logger.warn({ payLinkId: link.id, bookingId: extend.bookingId }, '[pay-link] closed link\'s added month was not given back — the stay changed since it was sent')
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      // 10/4 (review LOW): what the lease owes changed between the check above
      // and this one (a bill made, a payment started) — refused here, after
      // the card page was already closed. Say so: the link is still open and
      // the payer opens it again to get a fresh page.
      if (e instanceof AppError && closingLease && page.page === 'closed') {
        throw new AppError(e.statusCode, `${e.message} ${PAY_LINK_PAGE_CLOSED_WORDS}`)
      }
      throw e
    } finally { client.release() }
    if (stopAfterCommit.length) {
      const { cancelSupersededIntents } = await import('../services/creditUse')
      await cancelSupersededIntents(stopAfterCommit)   // never throws
    }
    // R11: a stay billed its site's utilities is billed only through its check-out again.
    if (extend && monthGivenBack) {
      await syncStayUtilityAgreement(extend.bookingId).catch((err) =>
        logger.error({ err, bookingId: extend.bookingId }, '[pay-link] stay utility agreement not brought back in step'))
    }
    // 10/3 (review): the row says whether a reservation went with it.
    res.json({ success: true, data: { stayCancelled, ...(extend ? { monthGivenBack } : {}) } })
  } catch (e) { next(e) }
})

// POST /api/pos/pay-links/:id/resend — a one-time link, to the same address.
posPayLinksRouter.post('/:id/resend', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const link = /^[0-9a-f-]{36}$/i.test(String(req.params.id))
      ? await queryOne<any>(`SELECT * FROM pos_pay_links WHERE id = $1`, [req.params.id]) : null
    if (!link) throw new AppError(404, LINK_GONE)
    const prop = await propertyFor(req, link.property_id)
    if (link.kind !== 'one_time' || link.status !== 'open') throw new AppError(409, 'Only an emailed link that is still waiting can be sent again — open the Pay Links list again to see what is still out.')
    // 10/3 (decisions #23): the email says what the link asks NOW — the figure
    // the list shows, the card page charges and the counter takes (linkAsksNow)
    // — and the link is saved at it before anything is sent. A card page the
    // payer has open at the old figure is closed first (as Adjust does), so the
    // old figure can never be paid.
    let total = Number(link.total)
    if (link.booking_id) {
      const closedWords = linkReservationClosedWords(await reservationDue(db, link.booking_id), 'Send again')
      if (closedWords) throw new AppError(409, closedWords)
      const now = await linkAsksNow(db, link, { press: 'Send again' })
      total = now.total
      const cents = (n: unknown) => Math.round(Number(n) * 100)
      if (cents(now.total) !== cents(link.total) || cents(now.subtotal) !== cents(link.subtotal) || cents(now.taxAmount) !== cents(link.tax_amount)) {
        let page: { page: 'none' | 'closed' | 'paid'; closedId: string | null }
        try {
          page = await closeLinkPageNow(link.id)
        } catch (e) {
          logger.warn({ err: e, payLinkId: link.id }, '[pay-link] could not close the old card page before sending the link again')
          throw new AppError(503, 'The card page sent with this link could not be closed just now — nothing was sent. Wait a moment, then press Send again.')
        }
        if (page.page === 'paid') {
          throw new AppError(409, 'That link was just paid online — nothing was sent. Open the list again in a moment; it shows as paid once the payment lands.')
        }
        const saved = await queryOne<{ id: string }>(
          `UPDATE pos_pay_links SET subtotal = $2, tax_amount = $3, total = $4, last_checkout_session_id = NULL, updated_at = NOW()
            WHERE id = $1 AND status = 'open' AND last_checkout_session_id IS NOT DISTINCT FROM $5 RETURNING id`,
          [link.id, now.subtotal, now.taxAmount, now.total, page.closedId])
        if (!saved) {
          const st = await queryOne<{ status: string }>(`SELECT status FROM pos_pay_links WHERE id = $1`, [link.id])
          throw new AppError(409, st?.status === 'open'
            ? 'The payer opened this link on their phone just now — nothing was sent. Press Send again in a moment.'
            : 'That link was paid or closed a moment ago — nothing was sent. Open the Pay Links list again to see what is still out.')
        }
      }
    }
    const { emailPayLink } = await import('../services/email')
    const { customerFee } = payLinkCharge(total, payerOf(link))
    await emailPayLink({
      to: link.customer_email, name: link.customer_name, propertyName: prop.name,
      label: link.label, amount: total, cardFee: customerFee, url: payLinkUrl(link.token),
      // 10/5 (Nic): sent again, it says what it said the first time (R13, R8).
      note: await linkEmailNote(link),
      neverExpires: !link.expires_at,
      // 10/5: replies reach the people who run this property (services/replyRouting).
      ctx: { landlordId: link.landlord_id, payLinkId: link.id, replyTo: replyToProperty(link.property_id) },
    })
    // A link sent with no expiry (a deposit, a background check) keeps none — only a 14-day link gets 14 more days.
    await query(`UPDATE pos_pay_links SET expires_at = CASE WHEN expires_at IS NULL THEN NULL ELSE NOW() + INTERVAL '14 days' END, updated_at = NOW() WHERE id = $1`, [link.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// GET /api/pos/pay-links/:id/qr.png — the printable QR for a standing link.
posPayLinksRouter.get('/:id/qr.png', requirePerm('pos.ring_sale'), async (req, res, next) => {
  try {
    const link = /^[0-9a-f-]{36}$/i.test(String(req.params.id))
      ? await queryOne<any>(`SELECT * FROM pos_pay_links WHERE id = $1`, [req.params.id]) : null
    if (!link) throw new AppError(404, LINK_GONE)
    await propertyFor(req, link.property_id)
    const png = await QRCode.toBuffer(payLinkUrl(link.token), { width: 600, margin: 2 })
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.send(png)
  } catch (e) { next(e) }
})

// ── PUBLIC: the link itself ──────────────────────────────────────────────
//
// No login — the booking site already takes deposits without one, and after
// hours at the dump station is exactly when nobody is at the desk (Nic). The
// token is the only key; it opens Stripe's card page for a server-fixed amount
// and reveals nothing else.
export const publicPayRouter = Router()

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{margin:0;background:#0a0b0e;color:#c4ccde;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px}
.c{max-width:420px;background:#141720;border:1px solid #252d42;border-radius:14px;padding:28px}
h1{color:#f0f2f7;font-size:1.3rem;margin:0 0 8px}.g{color:#c9a227;font-weight:700;letter-spacing:.04em;font-size:.8rem;text-transform:uppercase}</style>
</head><body><div class="c"><div class="g">Gold Asset Management</div>${body}</div></body></html>`

const escapeHtml = (s: string) => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

/** 10/2 (review): how long a card page opened from a link stays payable — Stripe's shortest (30 minutes), plus two for clock drift. */
export const LINK_PAGE_MINUTES = 32

/**
 * Open a card page (a Stripe Checkout Session) for a link. S648 (Nic): the money
 * lands with GAM — the landlord's share (the link total) is paid in the weekly
 * batch and the card fee is GAM's. 10/2 (review): the page closes itself after
 * LINK_PAGE_MINUTES. A page left open in a forgotten tab could otherwise be paid
 * a day after the link was settled, changed or closed — real money taken a
 * second time. Opening the link again is always a fresh page.
 */
async function openLinkCardPage(link: any, customerFee: number, heldWords: string | null = null): Promise<{ sessionId: string; hostedUrl: string }> {
  const { getStripe } = await import('../lib/stripe')
  const metadata = { gam_purpose: 'pos_pay_link', gam_pay_link_id: link.id, gam_landlord_id: link.landlord_id }
  const askName = link.kind === 'standing'
  // 10/5 (Nic, R8): the background check is its own line on the card page, as on the link.
  const screening = linkScreeningLine(link)
  const screeningCents = screening ? Math.round(screening.price * 100) : 0
  const lines = [
    { name: `${link.label} — ${link.property_name}`, amountCents: Math.round(Number(link.total) * 100) - screeningCents },
    ...(screening ? [{ name: screening.name, amountCents: screeningCents }] : []),
    { name: 'Card processing fee', amountCents: Math.round(customerFee * 100) },
  ].filter((l) => l.amountCents > 0)
  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: lines.map((l) => ({
      quantity: 1,
      price_data: { currency: 'usd', unit_amount: l.amountCents, product_data: { name: l.name.slice(0, 250) } },
    })),
    // A platform charge — no transfer (pos_transactions.payout_owed pays the landlord).
    payment_intent_data: { metadata },
    metadata,
    customer_email: link.customer_email ?? undefined,
    // 10/5 (Nic, R13): a stay with no lease is held only through what is
    // paid — said up front, beside the Pay button.
    ...(heldWords ? { custom_text: { submit: { message: heldWords } } } : {}),
    phone_number_collection: { enabled: askName },
    custom_fields: askName ? [{ key: 'name', label: { type: 'custom', custom: 'Your name' }, type: 'text' }] : undefined,
    success_url: `${apiBase()}/api/public/pay/${link.token}/done`,
    cancel_url: `${apiBase()}/api/public/pay/${link.token}`,
    expires_at: Math.floor(Date.now() / 1000) + LINK_PAGE_MINUTES * 60,
  })
  if (!session.url) throw new Error(`pay link ${link.id}: Stripe returned a card page with no address`)
  return { sessionId: session.id, hostedUrl: session.url }
}

/** A card page that was made but is not the link's (the link changed while it was made): closed again. Never fails the request. */
async function dropLinkCardPage(link: any, sessionId: string): Promise<void> {
  try {
    const { expirePayLinkCheckoutSession } = await import('../services/stripeConnect')
    await expirePayLinkCheckoutSession(link.landlord_id, sessionId)
  } catch (e) {
    // It closes itself after LINK_PAGE_MINUTES; a payment on it is caught as it lands (finalizePayLink).
    logger.warn({ err: e, payLinkId: link.id, sessionId }, '[pay-link] could not close a card page the link no longer points at')
  }
}

const notFoundPage = () => page('Link not found', '<h1>This link isn’t valid</h1><p>Check the link, or ask the office for a new one.</p>')
const paidPage = (link: any) => page('Already paid', `<h1>Already paid — thank you</h1><p>${escapeHtml(link.label)} at ${escapeHtml(link.property_name)} is paid.</p>`)
const closedPage = (link: any) => page('Link closed', `<h1>This link has closed</h1><p>Ask ${escapeHtml(link.property_name)} for a new one.</p>`)

/** Why a link is not paid here right now — the page the payer sees instead — or null when it can be paid. */
async function linkNotPayable(link: any): Promise<{ status: number; html: string } | null> {
  if (link.status === 'paid') return { status: 200, html: paidPage(link) }
  if (link.status !== 'open' || (link.expires_at && new Date(link.expires_at) < new Date())) return { status: 410, html: closedPage(link) }
  // 10/2 (review): a stay whose site went to a guest who paid first is not
  // sold here — the payer would be charged for a site they no longer have.
  // (What it charges for a reservation that IS still payable is the
  // reservation's own, read as the page opens — linkReservation.)
  if (link.booking_id) {
    const due = await reservationDue(db, link.booking_id)
    if (!due || due.closed) {
      return { status: 410, html: page('Stay no longer available',
        `<h1>This stay is no longer available</h1><p>Nothing was charged. Please contact ${escapeHtml(link.property_name)} to book again.</p>`) }
    }
    // 10/2 (decisions #9): a reservation already paid in full is not paid again
    // here. 10/3 (decisions #15): nor a long stay whose deposit is paid — its lease bills the rest.
    if (due.paidInFull) {
      return { status: 200, html: due.leaseBillsRest
        ? (due.paid > 0.005
          ? page('Deposit paid', `<h1>Your deposit is paid — thank you</h1><p>The rest of your stay is billed on your lease, and nothing was charged here. Questions? Contact ${escapeHtml(link.property_name)}.</p>`)
          : page('Nothing due here', `<h1>Nothing is due on this link</h1><p>Your stay is billed on your lease, and nothing was charged here. Questions? Contact ${escapeHtml(link.property_name)}.</p>`))
        : page('Already paid', `<h1>This reservation is already paid — thank you</h1><p>Nothing more is owed on it, and nothing was charged. Questions? Contact ${escapeHtml(link.property_name)}.</p>`) }
    }
    if (due.noPrice) {
      return { status: 409, html: page('Link needs updating',
        `<h1>This link needs updating</h1><p>Your reservation has no price on it yet, so nothing was charged. Please contact ${escapeHtml(link.property_name)}.</p>`) }
    }
  }
  // 10/5 (Nic, A2): a link for a stay's background check alone is paid only
  // while the stay stands and its check is not already paid for.
  const feeOnly = await feeOnlyLinkNotPayable(db, link)
  if (feeOnly === 'stay_gone') {
    return { status: 410, html: page('Stay no longer available',
      `<h1>This stay is no longer available</h1><p>Nothing was charged. Please contact ${escapeHtml(link.property_name)} if you still want to stay.</p>`) }
  }
  if (feeOnly === 'paid') {
    return { status: 200, html: page('Already paid',
      `<h1>Your background check is already paid — thank you</h1><p>Nothing was charged here. Look for the email with the link to fill it out, or contact ${escapeHtml(link.property_name)}.</p>`) }
  }
  if (!(await connectIdFor(link.landlord_id))) {
    return { status: 503, html: page('Not available', `<h1>Card payment isn’t available right now</h1><p>Please pay ${escapeHtml(link.property_name)} directly.</p>`) }
  }
  return null
}

/**
 * The link itself. 10/2 (review): ONE CARD PAGE AT A TIME for an emailed
 * (one-time) link. Every load used to open a new Stripe page and forget the
 * one before — the cancel button on Stripe's page comes back here too — so a
 * payer with two tabs had two payable pages and the desk, settling the link,
 * closed only the newest. Now:
 *   1. the page the link last opened is closed first; if the payer finished
 *      paying on it, they are told it is paid and no new page opens;
 *   2. the new page is saved on the link only while the link is still open
 *      and still points at the page closed in step 1 — a link settled, changed
 *      or closed (or opened in another tab) meanwhile drops the new page, and
 *      the link is read again;
 *   3. every page closes itself after LINK_PAGE_MINUTES.
 * A standing QR code is opened by anyone, at any time, for a payment of their
 * own: its pages are never closed for the next scanner.
 */
publicPayRouter.get('/pay/:token', async (req, res, next) => {
  try {
    if (!/^[a-f0-9]{48}$/.test(req.params.token)) return res.status(404).send(notFoundPage())
    for (let attempt = 0; attempt < 3; attempt++) {
      const link = await queryOne<any>(
        `SELECT l.*, p.name AS property_name FROM pos_pay_links l
           JOIN properties p ON p.id = l.property_id WHERE l.token = $1`, [req.params.token])
      if (!link) return res.status(404).send(notFoundPage())
      const refused = await linkNotPayable(link)
      if (refused) {
        // 10/3 (review): a link refused here closes the card page it last
        // opened, too — the page could otherwise still be paid in another tab.
        if (link.kind === 'one_time' && link.status !== 'paid' && link.last_checkout_session_id) {
          try {
            if (await closeLinkCheckout(link) === 'paid') return res.send(paidPage(link))
          } catch (e) {
            logger.warn({ err: e, payLinkId: link.id }, '[pay-link] could not close the card page of a link that can no longer be paid')
          }
        }
        return res.status(refused.status).send(refused.html)
      }
      const before: string | null = link.kind === 'one_time' ? (link.last_checkout_session_id ?? null) : null
      if (before) {
        let was: 'none' | 'closed' | 'paid'
        try {
          was = await closeLinkCheckout(link)
        } catch (e) {
          logger.warn({ err: e, payLinkId: link.id }, '[pay-link] could not close the last card page before opening a new one')
          return res.status(503).send(page('Try again in a minute',
            `<h1>Card payment isn’t available just this minute</h1><p>Nothing was charged. Please open the link again in a minute.</p>`))
        }
        if (was === 'paid') return res.send(paidPage(link))
      }
      // 10/3 (decisions #9, #23): a link for a reservation charges the
      // reservation's own amount, read now (linkAsksNow — the same figure the
      // list, Send again and the counter show) — the schedule may have
      // repriced or moved it, or a payment toward it landed, since the link was
      // sent. The link's totals are brought up to date with the page.
      let synced: { subtotal: number; taxAmount: number; total: number } | null = null
      if (link.booking_id) {
        try {
          const now = await linkAsksNow(db, link)
          if (now.res) {
            synced = now
            link.total = now.total
          }
        } catch (e) {
          if (!(e instanceof AppError)) throw e
          return res.status(409).send(page('Link needs updating',
            `<h1>This link needs updating</h1><p>Nothing was charged. Please contact ${escapeHtml(link.property_name)} for an up-to-date link.</p>`))
        }
      }
      const { customerFee } = payLinkCharge(Number(link.total), payerOf(link))
      const heldWords = await linkHeldWords(link).catch(() => null)
      const session = await openLinkCardPage(link, customerFee, heldWords)
      const saved = await queryOne<{ id: string }>(
        `UPDATE pos_pay_links SET last_checkout_session_id = $2, updated_at = NOW(),
                subtotal = COALESCE($4::numeric, subtotal), tax_amount = COALESCE($5::numeric, tax_amount), total = COALESCE($6::numeric, total)
          WHERE id = $1 AND status = 'open' AND (kind = 'standing' OR last_checkout_session_id IS NOT DISTINCT FROM $3)
          RETURNING id`, [link.id, session.sessionId, before, synced?.subtotal ?? null, synced?.taxAmount ?? null, synced?.total ?? null])
      if (saved) return res.redirect(303, session.hostedUrl)
      await dropLinkCardPage(link, session.sessionId)
    }
    return res.status(409).send(page('Opened somewhere else',
      `<h1>This link was just opened somewhere else</h1><p>Nothing was charged. Please open the link again to pay.</p>`))
  } catch (e) { next(e) }
})

publicPayRouter.get('/pay/:token/done', async (req, res, next) => {
  try {
    const link = /^[a-f0-9]{48}$/.test(req.params.token) ? await queryOne<any>(
      `SELECT l.id, l.label, l.items, l.booking_id, l.landlord_id, p.name AS property_name FROM pos_pay_links l
         JOIN properties p ON p.id = l.property_id WHERE l.token = $1`, [req.params.token]) : null
    // 10/5 (Nic, R13): and, for a stay with no lease, how long the site is held.
    const held = link ? await linkHeldWords(link).catch(() => null) : null
    res.send(page('Payment received',
      `<h1>Payment received — thank you</h1><p>${link ? `${escapeHtml(link.label)} at ${escapeHtml(link.property_name)}.` : ''} A receipt is on its way to your email.</p>`
      + (held ? `<p>${escapeHtml(held)}</p>` : '')))
  } catch (e) { next(e) }
})

// ── PAID ─────────────────────────────────────────────────────────────────

/**
 * Why a payment that landed was held rather than recorded as a sale
 * (pos_held_payments.reason). 'deposit_part': part of a long stay's deposit,
 * which is paid whole (decisions #15) — its own reason, so the Pay Links table
 * and the notice say so (never "an old version of the link": nobody changed it).
 */
export type HeldReason = 'paid_twice' | 'wrong_amount' | 'over_owed' | 'deposit_part'

/**
 * 10/3 (decisions #13) — A PAYMENT THAT DOES NOT FIT IS HELD, NEVER LOST,
 * NEVER REFUNDED ON ITS OWN.
 *
 * Nic: "There should never be duplicate payments in the first place. And if
 * there are, do NOT automatically refund. Landlord needs notification before
 * refunding." Duplicates are prevented structurally (one live card page per
 * link; the counter closes the page before charging). One that lands anyway —
 * a link paid twice, a page paid at an amount the link no longer asks, a
 * payment for more than the reservation still owes — is RECORDED here, keyed
 * on its payment, so no dollar is lost: GAM holds it, it is not a sale and it
 * is in nobody's payouts. The landlord is told with the amount and a one-click
 * "Refund this payment" (POST /api/pos/held-payments/:id/refund — the account
 * owner only, never automatic). Returns the held row's id (the same one when
 * Stripe delivers the payment twice).
 */
async function holdPayment(q: Q, o: { link: any; paymentIntentId: string; amount: number; reason: HeldReason; payer: string | null; note: string }): Promise<string> {
  const ins = await q.query<{ id: string }>(
    `INSERT INTO pos_held_payments
       (landlord_id, property_id, pay_link_id, booking_id, stripe_payment_intent_id, reason, amount, payer_name, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (stripe_payment_intent_id) DO NOTHING RETURNING id`,
    [o.link.landlord_id, o.link.property_id, o.link.id, o.link.booking_id ?? null, o.paymentIntentId, o.reason,
     round2(o.amount), o.payer, o.note.slice(0, 500)])
  // 10/5 (Nic): "money movement is the end of onboarding" — a payment that
  // landed and is held is still money through GAM. Not a link for the
  // background check alone: that is GAM's screening money.
  if (ins.rows[0] && !(!o.link.booking_id && isFeeOnlyLink(o.link))) {
    await activateBillingForMoneyMoved(q, [o.link.landlord_id])
  }
  if (ins.rows[0]) return ins.rows[0].id
  return (await q.query<{ id: string }>(`SELECT id FROM pos_held_payments WHERE stripe_payment_intent_id = $1`, [o.paymentIntentId])).rows[0].id
}

/**
 * Where the notice's one click lands: the held payment on the Pay Links tab,
 * with its Refund button (which calls POST /api/pos/held-payments/:id/refund).
 */
const heldPaymentUrl = (heldId: string) => `/pos?tab=paylinks&held=${heldId}`

/**
 * After a payment toward a reservation that did NOT pay it in full: the card
 * pages other links on it have open were opened at amounts that may be more
 * than is owed now. Each one whose amount is not what it would charge now is
 * closed at Stripe (the link stays open; opening it again charges what is
 * owed). Never fails the payment.
 */
export async function closeStaleLinkPages(bookingId: string | null | undefined, exceptLinkId: string | null): Promise<void> {
  if (!bookingId) return
  const others = await query<any>(
    `SELECT * FROM pos_pay_links
      WHERE booking_id = $1 AND status = 'open' AND kind = 'one_time' AND last_checkout_session_id IS NOT NULL
        AND id IS DISTINCT FROM $2`, [bookingId, exceptLinkId])
  for (const l of others) {
    let stale = true
    try {
      const now = await linkAsksNow(db, l)
      if (now.res) stale = Math.round(now.total * 100) !== Math.round(Number(l.total) * 100)
    } catch { stale = true }
    if (!stale) continue
    try {
      const { expirePayLinkCheckoutSession } = await import('../services/stripeConnect')
      await expirePayLinkCheckoutSession(l.landlord_id, l.last_checkout_session_id)
    } catch (e) {
      logger.warn({ err: e, payLinkId: l.id }, '[pay-link] could not close a card page that asks more than its reservation owes now')
    }
  }
}

/**
 * Stripe says a pay-link checkout finished. Records the sale (once per
 * PaymentIntent), closes a one-time link, confirms an attached stay. A payment
 * that does not fit — the link already paid, the amount not the link's, more
 * than its reservation still owes — is held, not recorded as a sale
 * (holdPayment), and the landlord is told once with a Refund button.
 */
export async function finalizePayLink(session: {
  id: string; amount_total: number | null; payment_intent: string | null
  metadata: Record<string, string> | null
  customer_details?: { email?: string | null; name?: string | null; phone?: string | null } | null
  custom_fields?: Array<{ key: string; text?: { value?: string | null } | null }> | null
}): Promise<{ recorded: boolean; reason?: string; heldPaymentId?: string }> {
  const linkId = session.metadata?.gam_pay_link_id
  if (!linkId || !session.payment_intent) return { recorded: false, reason: 'not a pay link' }
  // 10/2: the card it was paid with, so the online payment lands on the same
  // person a tap of that card would. Read before the transaction opens, and
  // never a reason not to record the sale.
  const card: CardIdentity | null = await readSaleCard(session.payment_intent).catch((e) => {
    logger.warn({ err: e, linkId }, '[pay-link] could not read the card it was paid with')
    return null
  })
  const client = await getClient()
  let closedWithIt: ClosedLink[] = []
  let partOfReservation = false
  let screeningAfterCommit: (() => Promise<void>) | null = null
  try {
    await client.query('BEGIN')
    const link = (await client.query(`SELECT * FROM pos_pay_links WHERE id = $1 FOR UPDATE`, [linkId])).rows[0]
    if (!link) { await client.query('ROLLBACK'); return { recorded: false, reason: 'link gone' } }
    const dup = await client.query(`SELECT 1 FROM pos_transactions WHERE stripe_payment_intent_id = $1`, [session.payment_intent])
    if (dup.rows.length) { await client.query('ROLLBACK'); return { recorded: false, reason: 'already recorded' } }
    const { fee, charged, held, customerFee } = payLinkCharge(Number(link.total), payerOf(link))
    const payer = session.custom_fields?.find(f => f.key === 'name')?.text?.value ?? session.customer_details?.name ?? link.customer_name ?? null
    const paid = round2((Number(session.amount_total) || 0) / 100)
    const holdAndTell = async (reason: HeldReason, note: string, tell: (heldId: string) => Promise<void>, why: string) => {
      const heldId = await holdPayment(client, { link, paymentIntentId: session.payment_intent!, amount: paid, reason, payer, note })
      // 10/3 (review): the link lets go of the page that was paid. While it
      // pointed at it, every later step on the link (the counter, Adjust,
      // Close, opening it again) read that page as "just paid online" and
      // refused, for good. The payment is held above; the link works again.
      // Only while that is still its page — one opened since is left alone.
      await client.query(
        `UPDATE pos_pay_links SET last_checkout_session_id = NULL, updated_at = NOW()
          WHERE id = $1 AND last_checkout_session_id = $2`, [link.id, session.id])
      await client.query('COMMIT')
      logger.error({ linkId, paymentIntentId: session.payment_intent, heldId, reason, paid },
        `[pay-link] ${why} — held, not recorded as a sale; the landlord is told with a refund button`)
      await tell(heldId).catch((e) => logger.error({ err: e, linkId, heldId }, '[pay-link] could not tell the landlord about a held payment'))
      return { recorded: false, reason: why, heldPaymentId: heldId }
    }
    const already = await client.query<{ id: string }>(
      `SELECT id FROM pos_held_payments WHERE stripe_payment_intent_id = $1`, [session.payment_intent])
    if (already.rows.length) { await client.query('ROLLBACK'); return { recorded: false, reason: 'already held', heldPaymentId: already.rows[0].id } }
    if (Math.round(charged * 100) !== Number(session.amount_total)) {
      return await holdAndTell('wrong_amount', `Paid $${paid.toFixed(2)}; the link asked $${charged.toFixed(2)}.`,
        (heldId) => tellLandlordWrongAmount({ link, heldId, paymentIntentId: session.payment_intent!, paid, asks: charged, payer }),
        'amount mismatch')
    }
    // 10/2 (review): ONE PAYMENT, ONE SALE. An emailed link the desk already
    // settled (or a second card page the payer finished in another tab), or a
    // link for a reservation that has already been paid in full, was paid
    // twice. 10/3 (review): and a payment toward a reservation is checked
    // against what it still owes AS IT LANDS (under the booking's lock) — a
    // second link paid after the first, or the arrival-day balance link paid
    // after something else was, asks more than is left.
    const due = link.booking_id ? await reservationDue(client, link.booking_id, { lock: true }) : null
    const twice: 'link' | 'reservation' | null =
      link.kind === 'one_time' && link.status === 'paid' ? 'link'
        : due && !due.closed && due.paidInFull ? 'reservation' : null
    if (twice) {
      return await holdAndTell('paid_twice', twice === 'link' ? 'The link was already paid.' : 'The reservation was already paid.',
        (heldId) => tellLandlordPaidTwice({ link, heldId, paymentIntentId: session.payment_intent!, amount: paid, payer, why: twice, due }),
        'already paid')
    }
    // 10/5 (M3): a link for the background check alone, paid on a card page
    // opened before the check was paid another way, is the fee paid twice —
    // held for the landlord to refund, never recorded as a sale.
    if (!link.booking_id && isFeeOnlyLink(link) && (await feeOnlyLinkNotPayable(client, link)) === 'paid') {
      return await holdAndTell('paid_twice', 'The guest\'s background check was already paid.',
        (heldId) => tellLandlordPaidTwice({ link, heldId, paymentIntentId: session.payment_intent!, amount: paid, payer, why: 'screening', due: null }),
        'background check already paid')
    }
    const { toward, stay, rest, restSubtotal, restTax } = await linkPaidToward(client, link)
    // 10/3 (review): whether Close on this link would cancel the guest's stay —
    // the same test the Pay Links row and Close itself use (stayCloseCancels:
    // the link's own stay, still its unpaid tentative hold), read here before
    // holdAndTell commits. A stay link whose booking another payment already
    // confirmed is an ordinary open link: closing it cancels nothing.
    const closeCancelsStay = async () => (await stayCloseCancels(client, link)) != null
    if (due && !due.closed && toward > due.owed + 0.005) {
      const closeCancels = await closeCancelsStay()
      return await holdAndTell('over_owed', `Paid $${toward.toFixed(2)} toward the reservation; $${due.owed.toFixed(2)} was left to pay on it.`,
        (heldId) => tellLandlordOverOwed({ link, heldId, paymentIntentId: session.payment_intent!, paid, toward, due, payer, closeCancels }),
        'more than owed')
    }
    // 10/3 (review): a long stay's deposit is paid whole (decisions #15) — a
    // page opened for part of it (before the stay became one its lease bills)
    // is not recorded as the deposit, which would leave the rest never asked
    // for. Held under its own reason; the landlord is told why and the steps
    // that work (the link itself is refused everywhere now, so "send it again"
    // would not).
    if (due && !due.closed && due.leaseBillsRest && toward < due.owed - 0.005) {
      const closeCancels = await closeCancelsStay()
      return await holdAndTell('deposit_part', `Paid $${toward.toFixed(2)} toward a long stay whose deposit is $${due.owed.toFixed(2)} — a deposit is paid whole.`,
        (heldId) => tellLandlordDepositPart({ link, heldId, paymentIntentId: session.payment_intent!, paid, due, payer, stayLink: !!stay, closeCancels }),
        'part of a long stay\'s deposit')
    }
    // 10/2: a resident's sale names their register record too.
    let personId: string | null = link.pos_customer_id ?? null
    if (link.tenant_id && !personId) {
      personId = await withSavepoint(client, () => residentRecord(client, link.landlord_id, link.tenant_id),
        (e) => { logger.warn({ err: e, linkId }, '[pay-link] no register record for the resident'); return null })
    }
    let saleTenantId: string | null = link.tenant_id ?? null
    let personLastName = ''
    if (personId) {
      const r = (await client.query<{ tenant_id: string | null; last_name: string | null }>(
        `SELECT c.tenant_id, COALESCE(u.last_name, c.last_name) AS last_name
           FROM pos_customers c LEFT JOIN tenants tn ON tn.id = c.tenant_id LEFT JOIN users u ON u.id = tn.user_id
          WHERE c.id = $1`, [personId])).rows[0]
      saleTenantId = saleTenantId ?? r?.tenant_id ?? null
      personLastName = r?.last_name ?? ''
    }
    // The card: on the person the link was for (the same rule as a tap at the
    // counter), else it finds — or starts — its own record.
    if (card) {
      await withSavepoint(client, async () => {
        if (personId) {
          await applyCardToPerson(client, { landlordId: link.landlord_id, card, person: { id: personId, lastName: personLastName } })
        } else {
          personId = (await findOrCreateCustomerForCard(client, { landlordId: link.landlord_id, card })).customerId
        }
      }, (e) => { logger.warn({ err: e, linkId }, '[pay-link] card not recorded against a customer') })
    }
    // A link for nobody, paid with a card already on a resident's register
    // record: the card found the resident, and their sale names them too.
    if (personId && !saleTenantId) {
      saleTenantId = (await client.query<{ tenant_id: string | null }>(
        `SELECT tenant_id FROM pos_customers WHERE id = $1`, [personId])).rows[0]?.tenant_id ?? null
    }
    // 10/3: a link for a reservation records its reservation as the one line
    // its page charged — what it paid toward it — beside its other lines.
    // 10/3 (decisions #21): a stay's lodging tax is in that figure; the sale
    // records it as tax (the line's price less it, the tax on the line), at
    // the rate the schedule prices these nights with — the same split the
    // counter records. What was paid is unchanged. 10/3 (review): so does a
    // deposit or balance link toward a short stay (the arrival-day balance is
    // how most booking-site stays are paid) — its share of the stay's tax
    // (taxInsidePayment), so a deposit and a balance add up to the stay's tax.
    const reservationPart = link.booking_id && (stay || linkBookingLines(link, stay).length)
    const taxRate = reservationPart && due && !due.closed && !due.leaseBillsRest ? stayTaxRate(due.rates, due.taxPct, due.bookedNights) : 0
    const stayTax = { amount: taxInsidePayment(due?.paid ?? 0, toward, taxRate), rate: taxRate }
    const saleItems = reservationPart
      ? [reservationSaleLine({ id: stay?.itemId ?? null, name: stay ? (due ? reservationLineName(stay.name, due) : stay.name) : (linkBookingLines(link, null)[0]?.name || 'Toward the reservation'),
           qty: 1, price: toward, tax: 0 }, stayTax), ...rest]
      : link.items
    let taxBreakdown: { name: string; rate: number; amount: number }[] | null = null
    if (reservationPart && stayTax.amount > 0) {
      const { cartTaxBreakdown } = await import('./pos')
      taxBreakdown = withLodgingTax(await cartTaxBreakdown(link.landlord_id, rest), stayTax)
    }
    // 10/2 (review): a reservation that was CANCELLED while the payer had the
    // card page open (its site went to a guest who paid first — only NEW page
    // loads are refused) is not stamped paid: the money is real and is
    // recorded below, but a cancelled booking with a paid deposit tells nobody
    // anything. The landlord is told instead (below), to refund or rebook.
    const booking = link.booking_id ? (await client.query<{ status: string; unit_number: string | null; check_in: string; check_out: string; guest_name: string | null; displaced: boolean }>(
      `SELECT b.status, u.unit_number, to_char(b.check_in, 'YYYY-MM-DD') AS check_in, to_char(b.check_out, 'YYYY-MM-DD') AS check_out, b.guest_name,
              (b.displaced_at IS NOT NULL AND b.displaced_from_unit IS NOT DISTINCT FROM b.unit_id) AS displaced
         FROM unit_bookings b LEFT JOIN units u ON u.id = b.unit_id WHERE b.id = $1 FOR UPDATE OF b`, [link.booking_id])).rows[0] : null
    const bookingGone = !!link.booking_id && (!booking || booking.status === 'cancelled' || booking.status === 'no_show')
    // 10/5 (Nic, R8/A5): the background check it carried is GAM's, waiting for
    // the guest — paid online, it is on GAM's balance, so it is recorded BEFORE
    // the sale and kept out of the landlord's payout share (never also charged
    // back to them). A check the stay already had stays in the sale for the
    // landlord to give back (recordLinkScreening logs it).
    let screening: LinkScreeningRecorded | null = null
    if (!bookingGone) {
      screening = await recordLinkScreening(client, link, 'gam')
    } else if (linkScreeningLine(link)) {
      logger.error({ linkId }, '[pay-link] a background-check fee was paid on a link whose stay is gone — left in the sale for the landlord to refund')
    }
    const { tx } = await insertPosSale(client, {
      landlordId: link.landlord_id, propertyId: link.property_id, cashierId: link.created_by,
      paymentMethod: 'card', tenantId: saleTenantId, posCustomerId: personId,
      subtotal: reservationPart ? round2(restSubtotal + toward - stayTax.amount) : Number(link.subtotal),
      taxAmount: reservationPart ? round2(restTax + stayTax.amount) : Number(link.tax_amount),
      surcharge: customerFee,
      total: charged, platformFee: fee, stripePaymentIntentId: session.payment_intent,
      payoutOwed: round2(Math.max(0, held - (screening?.gamKeeps ?? 0))),
      paidOnline: true,   // S653: paid by the customer on the link, not at the counter
      discountAmount: reservationPart ? 0 : Number(link.discount_amount), discountReason: null,
      items: saleItems, taxBreakdown,
      // 10/5: a link for the background check alone is GAM's screening money —
      // it does not end the landlord's free onboarding window.
      screeningOnly: !link.booking_id && isFeeOnlyLink(link),
    })
    await client.query(`UPDATE pos_transactions SET pay_link_id = $2 WHERE id = $1`, [tx.id, link.id])
    if (link.kind === 'one_time') {
      await client.query(
        `UPDATE pos_pay_links SET status = 'paid', paid_at = NOW(), pos_transaction_id = $2, updated_at = NOW()
          WHERE id = $1`, [link.id, tx.id])
    }
    // S649: the arrival-day balance of a stay. 10/2 (review): one rule with the
    // counter (settleLinkBooking) — the booking is confirmed and names this
    // sale; a stay paid in full on its link leaves nothing to bill on arrival.
    const name = session.custom_fields?.find(f => f.key === 'name')?.text?.value
      ?? session.customer_details?.name ?? null
    if (!bookingGone) {
      await settleLinkBooking(client, link, tx.id, stay, name, toward)
      // 10/2 (decisions #9): paid in full now — every other way of paying it closes.
      closedWithIt = await closeIfPaidInFull(client, link.booking_id, { linkId: link.id })
      partOfReservation = !!link.booking_id && !closedWithIt.length
    }
    screeningAfterCommit = screening?.afterCommit ?? null
    await client.query('COMMIT')
    await expireClosedLinks(closedWithIt)
    if (screeningAfterCommit) await screeningAfterCommit()
    // 10/5 (Nic, R2/R11): its lease-or-stay answer is carried out now that it is paid.
    if (!bookingGone) await afterLinkPaid(link, null)
    // 10/3 (review): paid toward it but not in full — other links' open pages
    // may now ask more than is left; those pages close (their links stay open).
    if (partOfReservation) await closeStaleLinkPages(link.booking_id, link.id)
    // 10/3 (review): paid toward it, something is still owed, and nothing is
    // set to ask for it — the landlord is told once, with the next step.
    if (partOfReservation) {
      await tellLandlordIfLeftOwed({ link, saleId: tx.id, paid: toward, payer: name ?? link.customer_name ?? null })
        .catch((e) => logger.error({ err: e, linkId, saleId: tx.id }, '[pay-link] could not tell the landlord what is still owed on a reservation'))
    }
    if (bookingGone) {
      await tellLandlordPaidForGoneReservation({ link, saleId: tx.id, amount: charged, payer: name ?? link.customer_name ?? null, booking })
        .catch((e) => logger.error({ err: e, linkId, saleId: tx.id }, '[pay-link] could not tell the landlord about a payment for a cancelled reservation'))
    } else if (link.kind === 'one_time' && link.status === 'cancelled') {
      // 10/2 (review): an emailed link the office had CLOSED was paid on a card
      // page still open somewhere. The money is real and is recorded as the
      // sale it was for — but the office closed it for a reason (most often:
      // rung up fresh at the counter), so somebody is told, once.
      await tellLandlordPaidAfterClose({ link, saleId: tx.id, paymentIntentId: session.payment_intent, amount: charged, payer })
        .catch((e) => logger.error({ err: e, linkId, saleId: tx.id }, '[pay-link] could not tell the landlord about a closed link that was paid'))
    }
    return { recorded: true }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

/** The part of every held-payment notice: where the money is, and the one step that sends it back. */
const HELD_REFUND_STEP = 'GAM is holding it: it was not recorded as a sale and it is not in your payouts. '
  + 'Open this notice and press Refund this payment to send it back to their card — do not pay it back from the drawer.'

/**
 * 10/2 (review): a pay link was paid online after it had already been paid —
 * settled at the desk, paid in another tab, or its reservation paid in full.
 * 10/3 (decisions #13): the payment is held (holdPayment); the account holder
 * is told ONCE (a webhook delivered twice tells them once), with the Refund
 * button. Register refunds are cash or check from the drawer, and this money
 * never reached the drawer — so it is not refunded there.
 */
async function tellLandlordPaidTwice(o: {
  link: any; heldId: string; paymentIntentId: string; amount: number; payer: string | null; why: 'link' | 'reservation' | 'screening'
  due: ReservationDue | null
}): Promise<void> {
  const who = o.payer || o.link.customer_name || 'A customer'
  const before = o.why === 'link'
    ? 'after it had already been paid (at the counter, or on another card page)'
    : o.why === 'screening'
    ? 'after the guest\'s background check had already been paid another way'
    : o.due?.leaseBillsRest ? (o.due.paid > 0.005
      ? 'after the deposit on the reservation it was for had already been paid (its lease bills the rest)'
      : 'for a reservation with nothing due at the register (its lease bills the stay)')
    : 'after the reservation it was for had already been paid in full'
  await tellLandlordOnce(o.link, o.paymentIntentId, 'pay_link_paid_twice', {
    title: `${who} paid twice — $${o.amount.toFixed(2)} is held for you to refund`,
    body: `${who} paid $${o.amount.toFixed(2)} online on the pay link "${o.link.label}" ${before}. ` + HELD_REFUND_STEP,
    data: { posTransactionId: o.link.pos_transaction_id ?? null, heldPaymentId: o.heldId, amount: o.amount },
    actionUrl: heldPaymentUrl(o.heldId),
  })
}

/**
 * 10/3 (review): a payment toward a reservation landed after other money had
 * already gone toward it (or after the schedule repriced it down), and asked
 * more than was left. Held whole (the reservation still shows what it owes);
 * the landlord is told the overage once.
 *
 * 10/3 (review): THE NEXT STEP IS ONE THAT WORKS. The link was not paid (the
 * payment is held), so while it is open it still asks — now just what the
 * reservation owes (linkReservation): the step is Send again on it, or take it
 * at the counter. A link whose Close would CANCEL THE STAY (`closeCancels`:
 * stayCloseCancels — the link's own stay, still its unpaid tentative hold) is
 * never to be closed "to send a new one" — closing it cancels the guest's
 * reservation and lets the site go — so the notice says to keep it open. A stay
 * link whose booking is already confirmed (the usual case: another payment
 * came in first) is told the plain open-link words; closing it cancels nothing.
 */
async function tellLandlordOverOwed(o: {
  link: any; heldId: string; paymentIntentId: string; paid: number; toward: number; due: ReservationDue; payer: string | null; closeCancels: boolean
}): Promise<void> {
  const who = o.payer || o.link.customer_name || 'A customer'
  const over = round2(o.toward - o.due.owed)
  const site = o.due.unitNumber ? ` for site ${o.due.unitNumber}` : ''
  const owed = `$${o.due.owed.toFixed(2)}`
  const open = o.link.status === 'open'
  const keep = o.closeCancels ? 'This link holds their reservation, so keep it open (closing it cancels the stay).' : 'This link is still open.'
  const step = 'press Send again on it under Pay Links, or take it at the counter.'
  // (A link no longer open has nothing to send again or open at the counter —
  // the schedule is where its reservation is.)
  const next = !open
    ? (o.due.noPrice ? ' Its reservation has no price on it now — set its price on the schedule.'
      : ` The reservation still shows ${owed} owed — after the refund, look the reservation up on the schedule.`)
    : o.due.noPrice
      ? ` ${keep} Its reservation has no price on it now — set its price on the schedule, then ${step}`
      : o.closeCancels
        ? ` ${keep} It now asks the ${owed} still owed. Once the refund is under way, ${step}`
        : ` This link is still open and now asks the ${owed} still owed. Once the refund is under way, ${step}`
  await tellLandlordOnce(o.link, o.paymentIntentId, 'pay_link_over_owed', {
    title: `${who} paid $${over.toFixed(2)} more than their reservation owed — $${o.paid.toFixed(2)} is held for you to refund`,
    body: `${who} paid $${o.paid.toFixed(2)} online on the pay link "${o.link.label}" toward the reservation${site}, `
      + `but only ${owed} was left to pay on it when the payment landed — $${over.toFixed(2)} more than was owed`
      // 10/3 (review): the cause only when it is known — money had gone toward it first.
      + (o.due.paid > 0.005 ? ' (another payment toward it came in first). ' : '. ') + HELD_REFUND_STEP + next,
    data: { heldPaymentId: o.heldId, amount: o.paid, overage: over, owed: o.due.owed },
    actionUrl: heldPaymentUrl(o.heldId),
  })
}

/**
 * 10/3 (review, decisions #15): a card page opened for PART of a reservation's
 * deposit was paid after the stay became a long stay (its lease bills the
 * stay; the register takes the deposit, whole). Held whole (holdPayment,
 * 'deposit_part'); the landlord is told what happened — the link was never
 * changed — and the steps that work.
 *
 * 10/3 (review): TWO KINDS OF LINK, TWO NEXT STEPS. A link sent WITH THE
 * STAY ITSELF (`stayLink`) already asks the whole deposit now (it charges what
 * the reservation owes), so the step is Send again (or take it at the
 * counter); while its Close would cancel the stay (`closeCancels`:
 * stayCloseCancels — still the unpaid tentative hold) the notice also says to
 * keep it open, since closing it lets the site go. A link sent for an AMOUNT
 * toward the reservation (a deposit typed for part of it) is refused
 * everywhere now: that one is closed, and the whole deposit taken or sent anew.
 */
async function tellLandlordDepositPart(o: {
  link: any; heldId: string; paymentIntentId: string; paid: number; due: ReservationDue; payer: string | null
  stayLink: boolean; closeCancels: boolean
}): Promise<void> {
  const who = o.payer || o.link.customer_name || 'A customer'
  const site = o.due.unitNumber ? ` for site ${o.due.unitNumber}` : ''
  const deposit = `$${o.due.owed.toFixed(2)}`
  const sendAgain = `Once the refund is under way, press Send again on it under Pay Links, or take the ${deposit} at the counter.`
  const next = o.stayLink && o.link.status === 'open'
    ? (o.closeCancels
      ? ` This link holds their reservation, so keep it open (closing it would cancel the stay) — it now asks the whole ${deposit} deposit. `
      : ` This link is still open and now asks the whole ${deposit} deposit. `) + sendAgain
    : o.stayLink
      ? ` Then take the ${deposit} deposit at the counter or send a new link for it.`
      : o.link.status === 'open'
        ? ` Then close this link under Pay Links, and take the ${deposit} deposit at the counter or send a new link for it.`
        : ` Then take the ${deposit} deposit at the counter or send a new link for it.`
  await tellLandlordOnce(o.link, o.paymentIntentId, 'pay_link_deposit_part', {
    title: `${who} paid $${o.paid.toFixed(2)} toward a long stay's ${deposit} deposit — it is held for you to refund`,
    body: `${who} paid $${o.paid.toFixed(2)} online on the pay link "${o.link.label}" toward the reservation${site}, `
      + `which is now a long stay whose deposit is ${deposit} — a deposit is paid whole, so this payment is held. `
      + HELD_REFUND_STEP + next,
    data: { heldPaymentId: o.heldId, amount: o.paid, deposit: o.due.owed },
    actionUrl: heldPaymentUrl(o.heldId),
  })
}

/**
 * 10/3 (review) — A PAYMENT THAT LEAVES SOMETHING OWED THAT NOBODY WILL ASK FOR.
 *
 * A link paid toward a reservation without paying it in full is normal — a
 * deposit, with the arrival-day bill to come. But when nothing else is set to
 * ask for what is left — no other open pay link or register ticket for it, and
 * no arrival-day bill coming (already sent, the arrival day passed, or no
 * email to send it to) — the guest believes they paid and the landlord would
 * only see it by opening the reservation (a balance link paid after the
 * schedule repriced the stay up). The account holder is told ONCE per sale,
 * with the amount and the next step. Called after the sale commits; the link
 * paid online (finalizePayLink) or at the counter (POST /pos/transactions).
 */
export async function tellLandlordIfLeftOwed(o: { link: any; saleId: string; paid: number; payer: string | null }): Promise<boolean> {
  const bookingId = o.link?.booking_id
  if (!bookingId) return false
  const due = await reservationDue(db, bookingId)
  if (!due || due.closed || due.paidInFull || !(due.owed > 0.005)) return false
  const otherLink = await queryOne(
    `SELECT 1 FROM pos_pay_links
      WHERE booking_id = $1 AND status = 'open' AND kind = 'one_time' AND id IS DISTINCT FROM $2
        AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`, [bookingId, o.link.id])
  if (otherLink) return false
  const tickets = await query<{ id: string; landlord_id: string; items: any }>(
    `SELECT id, landlord_id, items FROM pos_open_tickets WHERE booking_id = $1 AND status = 'open'`, [bookingId])
  for (const t of tickets) if (await ticketCarriesStay(db, t)) return false
  // The arrival-day run (services/stayBalance) bills what is left on a short
  // stay on its arrival day (or the day after) — the same test it uses.
  const arrival = await queryOne<{ bills: boolean; unit_number: string | null; check_in: string; check_out: string; guest_name: string | null }>(
    `SELECT (b.status IN ('confirmed', 'checked_in') AND b.deposit_paid_at IS NOT NULL AND b.balance_billed_at IS NULL
             AND b.guest_email IS NOT NULL AND b.total_amount > COALESCE(b.deposit_amount, 0)
             AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.source_booking_id = b.id)
             AND b.check_in >= (NOW() AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date - 1
             AND b.check_out > (NOW() AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date) AS bills,
            u.unit_number, to_char(b.check_in, 'YYYY-MM-DD') AS check_in, to_char(b.check_out, 'YYYY-MM-DD') AS check_out, b.guest_name
       FROM unit_bookings b LEFT JOIN units u ON u.id = b.unit_id LEFT JOIN properties p ON p.id = u.property_id
      WHERE b.id = $1`, [bookingId])
  if (!arrival || (arrival.bills && !due.leaseBillsRest)) return false
  const already = await queryOne(
    `SELECT 1 FROM notifications WHERE type = 'pay_link_left_owed' AND data->>'posTransactionId' = $1 LIMIT 1`, [o.saleId])
  if (already) return false
  const owner = await queryOne<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [o.link.landlord_id])
  if (!owner) return false
  const who = o.payer || arrival.guest_name || o.link.customer_name || 'A guest'
  const site = arrival.unit_number ? `site ${arrival.unit_number}` : 'their site'
  const owed = money(due.owed)
  const { createNotification } = await import('../services/notifications')
  await createNotification({
    userId: owner.user_id,
    landlordId: o.link.landlord_id,
    type: 'pay_link_left_owed',
    title: `${who} still owes ${owed} on their reservation — nothing is set to ask for it`,
    body: `${who} paid ${money(o.paid)} on the pay link "${o.link.label}" toward the reservation for ${site} (${arrival.check_in} to ${arrival.check_out}), `
      + `but ${owed} is still owed on it, and nothing is set to ask for it: no other pay link or register ticket is out for it, and no arrival-day bill will ask for it. `
      + `Take the ${owed} at the counter, or send them a new link for it.`,
    data: { payLinkId: o.link.id, posTransactionId: o.saleId, bookingId, owed: due.owed, paid: o.paid },
  })
  return true
}

/**
 * 10/2 (review): ONE NOTICE PER PAYMENT. Stripe can deliver the same payment
 * more than once; the account holder hears about it once (keyed on the
 * payment and the kind of notice).
 */
async function tellLandlordOnce(link: any, paymentIntentId: string, type: string,
                                n: { title: string; body: string; data?: Record<string, unknown>; actionUrl?: string }): Promise<void> {
  const already = await queryOne(
    `SELECT 1 FROM notifications WHERE type = $2 AND data->>'paymentIntentId' = $1 LIMIT 1`, [paymentIntentId, type])
  if (already) return
  const owner = await queryOne<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [link.landlord_id])
  if (!owner) return
  const { createNotification } = await import('../services/notifications')
  await createNotification({
    userId: owner.user_id,
    landlordId: link.landlord_id,
    type,
    title: n.title,
    body: n.body,
    data: { payLinkId: link.id, paymentIntentId, bookingId: link.booking_id ?? null, ...(n.data ?? {}) },
    ...(n.actionUrl ? { actionUrl: n.actionUrl } : {}),
  })
}

/**
 * 10/2 (review): a card page was paid at an amount that is not the link's any
 * more — the link was changed (Adjust) after the payer opened it. Real money,
 * but not what the link asks: held (decisions #13), the account holder told
 * once with the Refund button, and what the link asks now.
 */
async function tellLandlordWrongAmount(o: { link: any; heldId: string; paymentIntentId: string; paid: number; asks: number; payer: string | null }): Promise<void> {
  const who = o.payer || o.link.customer_name || 'A customer'
  const now = o.link.status === 'open'
    ? ` The link is still open for $${o.asks.toFixed(2)} — once the refund is under way, press Send again on it under Pay Links, or settle it at the counter.`
    : ''
  await tellLandlordOnce(o.link, o.paymentIntentId, 'pay_link_amount_mismatch', {
    title: `${who} paid $${o.paid.toFixed(2)} on an old version of a pay link — it is held for you to refund`,
    body: `${who} paid $${o.paid.toFixed(2)} online for the pay link "${o.link.label}", but the link had been changed to $${o.asks.toFixed(2)} after they opened it. `
      + HELD_REFUND_STEP + now,
    data: { paid: o.paid, linkAsks: o.asks, heldPaymentId: o.heldId },
    actionUrl: heldPaymentUrl(o.heldId),
  })
}

/**
 * 10/2 (review): an emailed link the office had closed was paid on a card page
 * still open somewhere. The sale is recorded (the money is real and is in the
 * payouts), and the account holder is told once: if they took the money some
 * other way too, one of the two goes back.
 */
async function tellLandlordPaidAfterClose(o: { link: any; saleId: string; paymentIntentId: string; amount: number; payer: string | null }): Promise<void> {
  const who = o.payer || o.link.customer_name || 'A customer'
  await tellLandlordOnce(o.link, o.paymentIntentId, 'pay_link_paid_after_close', {
    title: `${who} paid a pay link that had been closed — check it was not paid twice`,
    body: `${who} paid $${o.amount.toFixed(2)} online on the pay link "${o.link.label}" after it had been closed. `
      + 'The payment is recorded as a register sale and is in your payouts. '
      + 'If they also paid for this another way (rung up at the counter, or on a new link), refund one of the two sales under Point of Sale → History.',
    data: { posTransactionId: o.saleId },
  })
}

/**
 * 10/2 (review): somebody paid a link for a reservation that had already been
 * cancelled (or marked a no-show) while their card page was open. The sale is
 * recorded (the money is real); the account holder is told plainly, with the
 * next step, because this is a refund or a rebooking and only a person can
 * choose which. 10/3 (review): the cause is stated only as far as it is known —
 * "its site went to a guest who paid first" only when the booking says so.
 */
async function tellLandlordPaidForGoneReservation(o: {
  link: any; saleId: string; amount: number; payer: string | null
  booking: { status: string; unit_number: string | null; check_in: string; check_out: string; guest_name: string | null; displaced: boolean } | null
}): Promise<void> {
  logger.error({ linkId: o.link.id, saleId: o.saleId, bookingId: o.link.booking_id },
    '[pay-link] paid for a reservation that was already cancelled — the landlord is told to refund or rebook')
  const owner = await queryOne<{ user_id: string }>(`SELECT user_id FROM landlords WHERE id = $1`, [o.link.landlord_id])
  if (!owner) return
  const who = o.payer || o.booking?.guest_name || 'A guest'
  const site = o.booking?.unit_number ? `site ${o.booking.unit_number}` : 'their site'
  const dates = o.booking ? ` (${o.booking.check_in} to ${o.booking.check_out})` : ''
  const why = !o.booking ? 'was no longer on the schedule'
    : o.booking.status === 'no_show' ? 'had already been marked a no-show'
    : o.booking.displaced ? 'had already been canceled (its site went to a guest who paid first)'
    : 'had already been canceled on the schedule'
  const { createNotification } = await import('../services/notifications')
  await createNotification({
    userId: owner.user_id,
    landlordId: o.link.landlord_id,
    type: 'pay_link_reservation_gone',
    title: `${who} paid for a reservation that was no longer on — refund or rebook`,
    body: `${who} paid $${o.amount.toFixed(2)} on the pay link "${o.link.label}" for ${site}${dates}, but that reservation ${why}. `
      + 'The payment is recorded as a register sale. '
      + 'Call them, then either refund the sale under Point of Sale → History, or book them a site on the schedule.',
    data: { payLinkId: o.link.id, posTransactionId: o.saleId, bookingId: o.link.booking_id },
  })
}
