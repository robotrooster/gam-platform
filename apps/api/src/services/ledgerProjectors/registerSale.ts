/**
 * 10/12 (Nic) — GAM BOOKS LEDGER, PHASE P5: A REGISTER SALE POSTS ITSELF
 * (gam-ledger-design-2026-10-12 §6 F1, F2; Nic's 10/12 answers L8, L10)
 *
 * Source 'pos_sale' = one pos_transactions row (and its items): the counter,
 * a card on file, or a pay link the customer paid. Posted on the sale's day
 * (its property's calendar), one posting:
 *
 *   cash          Dr Undeposited funds (1040)   the total in the drawer
 *   card / card   Dr Due from GAM (1050)         what GAM holds for the landlord
 *   on file /     Dr Processing fees (5115)      GAM's card fee the customer did
 *   pay link                                     not pay on top (0 when they did)
 *
 *                 Cr Register sales (4500)       goods, before tax
 *                 Cr Guest deposits (2060)       what paid a stay, before tax —
 *                                                held until the guest arrives
 *                                                (Nic L10; the booking's own
 *                                                projector earns it, bookingStay)
 *                 Cr Sales tax payable (2040)    each named tax on its own
 *                                                sub-account; a stay's lodging
 *                                                tax to Lodging tax payable (2042)
 *                 Cr Due to GAM (2080)           cash only: GAM's background-check
 *                                                fee the drawer took (GAM takes it
 *                                                from the next payout — the
 *                                                'screening_fee' GAM charge posts
 *                                                nothing of its own, design H3)
 *
 * Received: the income, stay and tax credits carry cash_effect 'in' (the sale
 * is money in on its day). A card sale's background check is GAM's money from
 * the start (never held for the landlord): it is on neither side.
 *
 * "What GAM holds for the landlord" is the sale's own held payout line
 * (held_payout_items 'pos_sale', written with the sale: total − GAM's card fee
 * − GAM's background check); that line posts nothing itself (design G4). The
 * card fee is the balancing figure, so the posting always balances to the cent.
 *
 * Register stock (Nic L8, the company's choice, landlords.books_register_stock):
 * when the company counts what each item cost when it sells, the sale also
 * moves Σ qty × cost_price (as recorded on the sale's lines) from Inventory
 * (1210) to Cost of goods sold (5300); when stock is an expense when bought,
 * the sale posts no cost (the purchase did).
 *
 * A void (only a cash sale with no stay, ticket or link can be voided) posts
 * nothing: its posting is taken back as a correction (the engine dates it).
 * A refund is its own source (registerRefund). A store charge-account sale
 * ('charge') waits: charge accounts are not enabled (design F7) and their
 * money has no posting rule yet.
 */
import type { PoolClient } from 'pg'
import type { DesiredLine, DesiredPosting, LedgerProjector, LedgerSourceRef } from '../ledgerEngine'
import type { LedgerOwner } from '../ledgerOwner'
import {
  cr, dr, netOf, toCents, taxLines, loadSale, saleMakeUp, costPerItemSoldOn, missingFact, waitsOnRule, localDaySql, propertyTzSql,
} from './registerBookingPayoutKit'

export const registerSaleProjector: LedgerProjector = {
  sourceType: 'pos_sale',
  // 2 (10/12 integrate): goods sold through a pay link or for a stay count under "Stays and pay links".
  ruleVersion: 2,

  async project(client: PoolClient, saleId: string): Promise<DesiredPosting[]> {
    const sale = await loadSale(client, saleId)
    if (!sale || sale.status === 'voided' || sale.voided_at) return []
    if (sale.payment_method === 'charge') {
      throw waitsOnRule('A store charge-account sale posts once charge accounts are enabled (design F7); nothing is posted for it yet.')
    }
    const card = sale.payment_method === 'card' || sale.payment_method === 'card_on_file'
    if (card && !sale.stripe_payment_intent_id) {
      throw missingFact('A card sale with no card payment on record: GAM cannot tell where its money went.')
    }
    const mk = await saleMakeUp(client, sale)
    const at = { propertyId: sale.property_id, tenantId: sale.tenant_id }
    const lines: DesiredLine[] = []

    // 10/12 (Nic, ledger integrate): which income category the goods count
    // under — the reports' own rule (incomeBasis SALE_STAY_CATEGORY_SQL): money
    // through a pay link, or a sale tied to a stay (a booking or an open ticket
    // for one), is "Stays and pay links"; the rest is "Register sales". The
    // account stays Register sales (4500) either way.
    const viaLinkOrStay = !!sale.pay_link_id || !!(await client.query<{ s: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM unit_bookings sb WHERE sb.pos_transaction_id::text = $1)
           OR EXISTS (SELECT 1 FROM pos_transactions t JOIN pos_open_tickets ot ON ot.id = t.open_ticket_id
                       WHERE t.id::text = $1 AND ot.booking_id IS NOT NULL) AS s`, [sale.id])).rows[0]?.s
    const goodsCategory = viaLinkOrStay ? 'stays_and_pay_links' as const : 'register_sales' as const

    // What the sale earned and the taxes it collected.
    lines.push(...cr('register_sales', mk.goodsPreTaxCents, { ...at, cashEffect: 'in', reportCategory: goodsCategory }))
    for (const s of mk.stays) {
      lines.push(...cr('guest_deposits', s.preTaxCents, {
        propertyId: s.propertyId ?? sale.property_id, unitId: s.unitId, tenantId: s.tenantId ?? sale.tenant_id,
        cashEffect: 'in', reportCategory: 'stays_and_pay_links', memo: 'Paid toward a stay (held until the guest arrives)',
      }))
    }
    lines.push(...taxLines(mk.taxParts, 'cr', { ...at, cashEffect: 'in', reportCategory: 'tax_collected' }))

    // What the sale brought in for the landlord (its income and tax, above).
    const broughtIn = -netOf(lines)
    const total = toCents(sale.total)
    const onTop = toCents(sale.surcharge)
    if (card) {
      const held = await client.query<{ amount: string }>(
        `SELECT amount::text AS amount FROM held_payout_items WHERE source_type = 'pos_sale' AND source_id = $1`, [sale.id])
      // 10/12 (Nic, ledger review): the held line is written with the sale
      // (posSale.recordSale, one transaction) whenever GAM holds anything for
      // the landlord. A card sale that brought the landlord money and has no
      // line is a missing fact — it waits, named, instead of booking the whole
      // sale as a card fee (design §4: projectors refuse missing facts).
      if (!held.rows[0] && broughtIn > 0) {
        throw missingFact('A card sale with no held payout line: GAM cannot tell what of it it holds for you and what was its card fee.')
      }
      const heldCents = toCents(held.rows[0]?.amount)
      lines.push(...dr('due_from_gam', heldCents, { ...at, memo: 'Card sale money GAM holds for you until your payout' }))
      // GAM's card fee the customer did not pay on top: everything the sale
      // brought in for the landlord (its income and tax, credited above —
      // total − fee on top − GAM's background check) less what GAM holds.
      lines.push(...dr('processing_fees', broughtIn - heldCents, { ...at, memo: 'Card fee on a register sale' }))
    } else {
      lines.push(...dr('undeposited_funds', total, { ...at, memo: 'Register cash sale' }))
      // GAM's background-check fee the drawer took: owed to GAM.
      lines.push(...cr('due_to_gam', mk.screeningCents, { ...at, memo: 'Background-check fee taken in cash — GAM\'s' }))
      // A surcharge on a cash sale stays in the drawer: the landlord's.
      lines.push(...cr('register_sales', onTop, { ...at, cashEffect: 'in', reportCategory: goodsCategory }))
    }

    // Nic L8: cost per item sold, when the company counts stock that way.
    if (await costPerItemSoldOn(client, sale.landlord_id, sale.day)) {
      const cost = await client.query<{ c: string }>(
        `SELECT COALESCE(SUM(ROUND(qty * cost_price, 2)), 0)::text AS c
           FROM pos_transaction_items WHERE transaction_id::text = $1 AND cost_price > 0`, [sale.id])
      const costCents = toCents(cost.rows[0]?.c)
      lines.push(...dr('cost_of_goods_sold', costCents, { ...at, memo: 'What the items sold cost' }))
      lines.push(...cr('inventory', costCents, { ...at, memo: 'Stock sold' }))
    }

    return [{
      owner: { landlordId: sale.landlord_id },
      intendedDate: sale.day,
      memo: sale.pay_link_id ? 'Pay link payment' : card ? 'Register card sale' : 'Register cash sale',
      lines,
    }]
  },

  async listSources(client: PoolClient, owner: LedgerOwner, opts: { since?: string | null }): Promise<LedgerSourceRef[]> {
    if (!owner.landlordId) return []
    const r = await client.query<{ id: string; day: string }>(
      `SELECT t.id::text AS id, ${localDaySql('t.created_at', propertyTzSql('t.property_id', 't.landlord_id'))} AS day
         FROM pos_transactions t
        WHERE t.landlord_id = $1 AND ($2::date IS NULL OR t.created_at >= $2::date - INTERVAL '1 day')`,
      [owner.landlordId, opts.since ?? null])
    return r.rows
  },
}
