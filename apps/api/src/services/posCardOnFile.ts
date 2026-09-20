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
 * to make silently behind a button labelled "card on file".
 */
import { queryOne } from '../db'
import { getStripe } from '../lib/stripe'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'

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
 */
export async function savedCardFor(opts: {
  tenantId?: string | null
  posCustomerId?: string | null
  landlordId: string
}): Promise<SavedCard | null> {
  let stripeCustomerId: string | null = null
  let holderName: string | null = null

  if (opts.tenantId) {
    const t = await queryOne<any>(
      `SELECT t.stripe_customer_id, u.first_name, u.last_name
         FROM tenants t JOIN users u ON u.id = t.user_id
        WHERE t.id = $1`, [opts.tenantId])
    if (!t) throw new AppError(404, 'No such tenant')
    stripeCustomerId = t.stripe_customer_id
    holderName = [t.first_name, t.last_name].filter(Boolean).join(' ') || null
  } else if (opts.posCustomerId) {
    // Scoped to the landlord ringing the sale: one company's register may not
    // charge another company's customer.
    const c = await queryOne<any>(
      `SELECT stripe_customer_id, first_name, last_name FROM pos_customers
        WHERE id = $1 AND landlord_id = $2 AND archived_at IS NULL`,
      [opts.posCustomerId, opts.landlordId])
    if (!c) throw new AppError(404, 'No such customer')
    stripeCustomerId = c.stripe_customer_id
    holderName = [c.first_name, c.last_name].filter(Boolean).join(' ') || null
  } else {
    throw new AppError(400, 'Pick who this sale is for before charging a card on file.')
  }

  if (!stripeCustomerId) return null

  const stripe = getStripe()
  // The default first — it is the one they chose — then any card they have.
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

  let card: any = null
  if (pmId) {
    card = await stripe.paymentMethods.retrieve(pmId)
  } else {
    const cards = await stripe.paymentMethods.list({ customer: stripeCustomerId, type: 'card', limit: 1 })
    card = cards.data[0] ?? null
  }
  if (!card) return null

  return {
    paymentMethodId: card.id,
    stripeCustomerId,
    brand: card.card?.brand ?? null,
    last4: card.card?.last4 ?? null,
    holderName,
  }
}

/**
 * Take the money, with nobody present.
 *
 * `off_session` tells Stripe the cardholder is not here to answer a challenge.
 * Most cards go through; some banks insist on the person, and that refusal is
 * the one failure the counter must be told about in words that say what to do
 * next — run it on the reader — rather than "payment failed".
 */
export async function chargeSavedCard(opts: {
  card: SavedCard
  amountCents: number
  landlordId: string
  propertyId: string | null
  description: string
}): Promise<{ paymentIntentId: string }> {
  if (!Number.isInteger(opts.amountCents) || opts.amountCents <= 0) {
    throw new AppError(400, 'Nothing to charge')
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
      description: opts.description,
      metadata: {
        gam_purpose: 'pos_card_on_file',
        gam_landlord_id: opts.landlordId,
        ...(opts.propertyId ? { gam_property_id: opts.propertyId } : {}),
      },
    })
    if (pi.status !== 'succeeded') {
      throw new AppError(402, `The card on file did not go through (${pi.status}). Run it on the reader instead.`)
    }
    return { paymentIntentId: pi.id }
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
