/**
 * S652 — charging a card that is already on file, at the register.
 *
 * Nic: "maybe if they save a payment method on file as a point of sale
 * customer, we can just auto charge them on delivery and we don't even have to
 * take the reader with us." And, on tenants: "when somebody is a tenant and
 * they sign up, it is save and pay. The same button click does both. So once
 * they're already a tenant, the card is saved."
 *
 * He is right that the card is already there. GAM has never spent a separate
 * authorization to store one — rent's own charge carries
 * `setup_future_usage`, so the first payment saves the card and every later one
 * can be taken without the person present (S603). What was missing was a way to
 * SPEND it anywhere except autopay: the register insisted on the reader, so a
 * propane delivery to somebody whose card GAM already holds meant carrying
 * hardware to their door.
 *
 * WHY THIS WORKS WITHOUT ANY STRIPE GYMNASTICS: the saved card lives on GAM's
 * platform customer, and register sales are created on the platform account
 * too — not on the landlord's connected account (memory:
 * gam-pos-money-platform-held). Card and till are on the same side of the wall.
 *
 * CARDS ONLY, DELIBERATELY. A saved bank account is an ACH debit with a
 * multi-day settlement and a bounce window; handing somebody their propane on
 * the strength of one is a different decision from taking a card, and not one
 * to make silently behind a button labeled "card on file".
 */
import { query, queryOne } from '../db'
import { getStripe } from '../lib/stripe'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'
import { tenantLivesHereSql } from './posPeople'

export interface SavedCard {
  paymentMethodId: string
  stripeCustomerId: string
  brand: string | null
  last4: string | null
  /** Who it belongs to, for the receipt and the sale row. */
  holderName: string | null
}

/**
 * The card on file for whoever is standing at the counter.
 *
 * A sale is rung against a TENANT or a POS CUSTOMER — never both (the register
 * already enforces that). Each carries its own Stripe customer, so the lookup
 * follows whichever one the cashier picked.
 *
 * 10/2 — A MERGE MUST NOT LOSE A CARD. A card kept on the reader is attached to
 * the Stripe customer of the record it was kept on. Folding that record into
 * another moves the card's row, but the survivor keeps its own Stripe customer,
 * so looking only there could no longer find the card. So the card rows are
 * read too, and each saved card is charged through the Stripe customer it is
 * actually attached to (Stripe says which).
 *
 * 10/2 (review) — WHOSE CARD THIS COMPANY MAY TAKE. Naming somebody on a sale
 * needs only a tie of any kind (an invite, a booking, an earlier sale). Their
 * OWN card — the one on their GAM account, saved paying rent, possibly to
 * another company — is reached only while they LIVE here (tenantLivesHereSql: a
 * current place on a current lease of this company's, taken by them). A former
 * resident's account card is not; nor is a card they saved later paying rent at
 * a different company. Otherwise only cards kept at THIS company's register: the record's own Stripe
 * customer and the cards on its rows. Inviting an email and cancelling the
 * invite must never put a stranger's card behind the "On file" button.
 */
export async function savedCardFor(opts: {
  tenantId?: string | null
  posCustomerId?: string | null
  landlordId: string
}): Promise<SavedCard | null> {
  let holderName: string | null = null
  // Where to look, in order: Stripe customers (their chosen card first, then any
  // card), and saved cards from the register's own card rows.
  const customers: string[] = []
  let recordId: string | null = null

  if (opts.tenantId) {
    const t = await queryOne<any>(
      `SELECT CASE WHEN ${tenantLivesHereSql('t.id', '$2')} THEN t.stripe_customer_id END AS stripe_customer_id,
              u.first_name, u.last_name
         FROM tenants t JOIN users u ON u.id = t.user_id
        WHERE t.id = $1`, [opts.tenantId, opts.landlordId])
    if (!t) throw new AppError(404, 'That resident could not be found — remove them (×), then type their name and pick them again.')
    if (t.stripe_customer_id) customers.push(t.stripe_customer_id)
    holderName = [t.first_name, t.last_name].filter(Boolean).join(' ') || null
    const rec = await queryOne<{ id: string; stripe_customer_id: string | null }>(
      `SELECT id, stripe_customer_id FROM pos_customers
        WHERE landlord_id = $1 AND tenant_id = $2 AND archived_at IS NULL`, [opts.landlordId, opts.tenantId])
    if (rec) { recordId = rec.id; if (rec.stripe_customer_id) customers.push(rec.stripe_customer_id) }
  } else if (opts.posCustomerId) {
    // Scoped to the landlord ringing the sale: one company's register may not
    // charge another company's customer.
    // A resident's record reaches the card on their account only while they
    // live here — the record carrying their tenant id is not enough.
    const c = await queryOne<any>(
      `SELECT c.id, c.stripe_customer_id, c.first_name, c.last_name,
              CASE WHEN ${tenantLivesHereSql('t.id', '$2')} THEN t.stripe_customer_id END AS tenant_stripe_customer_id,
              u.first_name AS t_first, u.last_name AS t_last
         FROM pos_customers c
         LEFT JOIN tenants t ON t.id = c.tenant_id
         LEFT JOIN users u ON u.id = t.user_id
        WHERE c.id = $1 AND c.landlord_id = $2 AND c.archived_at IS NULL`,
      [opts.posCustomerId, opts.landlordId])
    if (!c) throw new AppError(404, 'That customer is not on this register any more — remove them (×), then type their name and pick them again.')
    recordId = c.id
    if (c.stripe_customer_id) customers.push(c.stripe_customer_id)
    if (c.tenant_stripe_customer_id) customers.push(c.tenant_stripe_customer_id)
    holderName = [c.t_first ?? c.first_name, c.t_last ?? c.last_name].filter(Boolean).join(' ') || null
  } else {
    throw new AppError(400, 'Pick who this sale is for before charging a card on file — type their name, pick them, then press Charge again.')
  }

  // Nothing to look up — no Stripe customer, no card kept here — is simply no card.
  if (!customers.length && !recordId) return null
  const asSaved = (card: any, stripeCustomerId: string): SavedCard => ({
    paymentMethodId: card.id,
    stripeCustomerId,
    brand: card.card?.brand ?? null,
    last4: card.card?.last4 ?? null,
    holderName,
  })

  // The record's own Stripe customer first — its default is the one they chose.
  if (customers.length) {
    const own = await cardOnStripeCustomer(customers[0])
    if (own) return asSaved(own, customers[0])
  }

  // Then the cards kept on the reader, through the Stripe customer each is on.
  if (recordId) {
    const rows = await query<{ stripe_payment_method_id: string }>(
      `SELECT stripe_payment_method_id FROM pos_customer_cards
        WHERE pos_customer_id = $1 AND landlord_id = $2 AND stripe_payment_method_id IS NOT NULL
        ORDER BY saved_at DESC NULLS LAST, last_seen_at DESC`, [recordId, opts.landlordId])
    const stripe = rows.length ? getStripe() : null
    for (const r of rows) {
      try {
        const pm: any = await stripe!.paymentMethods.retrieve(r.stripe_payment_method_id)
        const owner = typeof pm?.customer === 'string' ? pm.customer : pm?.customer?.id
        if (pm?.type === 'card' && owner) return asSaved(pm, owner)
      } catch (e) {
        logger.warn({ err: e, paymentMethod: r.stripe_payment_method_id }, '[pos] saved card could not be read')
      }
    }
  }

  // Then any other Stripe customer this person has (a resident's account).
  for (const cus of customers.slice(1)) {
    const card = await cardOnStripeCustomer(cus)
    if (card) return asSaved(card, cus)
  }
  return null
}

/** The default card on a Stripe customer, else any card it has. */
async function cardOnStripeCustomer(stripeCustomerId: string): Promise<any | null> {
  const stripe = getStripe()
  let pmId: string | null = null
  try {
    const customer = await stripe.customers.retrieve(stripeCustomerId)
    if (customer && !('deleted' in customer && customer.deleted)) {
      const def = (customer as any).invoice_settings?.default_payment_method as string | null
      if (def) {
        const pm = await stripe.paymentMethods.retrieve(def)
        if (pm.type === 'card') pmId = pm.id
      }
    }
  } catch { /* fall through to the list */ }

  if (pmId) return stripe.paymentMethods.retrieve(pmId)
  const cards = await stripe.paymentMethods.list({ customer: stripeCustomerId, type: 'card', limit: 1 })
  return cards.data[0] ?? null
}

/**
 * Take the money, with nobody present.
 *
 * `off_session` tells Stripe the cardholder is not here to answer a challenge.
 * Most cards go through; some banks insist on the person, and that refusal is
 * the one failure the counter must be told about in words that say what to do
 * next — run it on the reader — rather than "payment failed".
 *
 * 10/2: the card is HELD here (capture_method manual) and the money taken only
 * when the sale is written (captureSavedCard, inside the sale's own
 * transaction) — exactly like the reader. A sale that cannot be written (a
 * ticket settled at another register a moment ago, a pay link just paid
 * online) lets the hold go (releaseSavedCardHold): nobody is ever charged for
 * a sale that is not on record. `held` is false only for an intent Stripe
 * already settled.
 */
export async function chargeSavedCard(opts: {
  card: SavedCard
  amountCents: number
  landlordId: string
  propertyId: string | null
  description: string
}): Promise<{ paymentIntentId: string; held: boolean }> {
  if (!Number.isInteger(opts.amountCents) || opts.amountCents <= 0) {
    throw new AppError(400, 'There is nothing to charge — the total is $0. Add what they are buying, then press Charge again.')
  }
  const stripe = getStripe()
  try {
    const pi = await stripe.paymentIntents.create({
      amount: opts.amountCents,
      currency: 'usd',
      customer: opts.card.stripeCustomerId,
      payment_method: opts.card.paymentMethodId,
      payment_method_types: ['card'],
      off_session: true,
      confirm: true,
      capture_method: 'manual',
      description: opts.description,
      metadata: {
        gam_purpose: 'pos_card_on_file',
        gam_landlord_id: opts.landlordId,
        ...(opts.propertyId ? { gam_property_id: opts.propertyId } : {}),
      },
    })
    if (pi.status !== 'requires_capture' && pi.status !== 'succeeded') {
      throw new AppError(402, 'The card on file did not go through — nothing was charged. Run the card on the reader instead, or take another form of payment.')
    }
    return { paymentIntentId: pi.id, held: pi.status === 'requires_capture' }
  } catch (e: any) {
    if (e instanceof AppError) throw e
    const code = e?.code ?? e?.raw?.code
    if (code === 'authentication_required') {
      throw new AppError(402,
        'Their bank wants the cardholder present for this one. Run the card on the reader instead.')
    }
    const declineMsg = e?.raw?.message ?? e?.message ?? 'The card was declined'
    logger.warn({ err: declineMsg, landlordId: opts.landlordId }, '[pos] card on file declined')
    throw new AppError(402, `${declineMsg}. Take another form of payment.`)
  }
}

/** Take the money held on a card on file — called as the sale is written. */
export async function captureSavedCard(paymentIntentId: string): Promise<void> {
  await getStripe().paymentIntents.capture(paymentIntentId)
}

/** Let go of a hold on a card on file whose sale did not go through — nothing is charged. */
export async function releaseSavedCardHold(paymentIntentId: string): Promise<void> {
  await getStripe().paymentIntents.cancel(paymentIntentId)
}
