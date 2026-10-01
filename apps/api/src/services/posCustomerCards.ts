/**
 * S654 (Nic): "automatically build a customer base… for a propane charge where
 * somebody's just paying with a card, it could automatically read the name on
 * their card, add them as a customer in the system, ask them if they want to
 * save their card for future use."
 *
 * The CARD is the customer (its Stripe fingerprint); the printed cardholder
 * name is the record's name. The save-card question is asked on the READER's
 * own screen, answered by the customer's own finger, after the payment — so
 * nobody wonders whether the desk saved it anyway. One tap, one authorization:
 * the reusable card came with the payment (`generated_card`), and keeping it
 * is an attach, not a second charge.
 */
import type { PoolClient } from 'pg'
import type Stripe from 'stripe'
import { query, queryOne } from '../db'
import { getStripe } from '../lib/stripe'
import { logger } from '../lib/logger'

export interface CardIdentity {
  fingerprint: string
  brand: string | null
  last4: string | null
  cardholderName: string | null
  /** The reusable card Stripe generated from this tap, when it could. */
  generatedCard: string | null
}

/** What the tap told us about the card — from a PaymentIntent retrieved with latest_charge expanded. */
export function cardIdentityFromIntent(pi: Stripe.PaymentIntent | null | undefined): CardIdentity | null {
  const ch: any = pi && typeof (pi as any).latest_charge === 'object' ? (pi as any).latest_charge : null
  const cp = ch?.payment_method_details?.card_present ?? ch?.payment_method_details?.interac_present
  if (!cp?.fingerprint) return null
  return {
    fingerprint:    String(cp.fingerprint),
    brand:          cp.brand ?? null,
    last4:          cp.last4 ?? null,
    cardholderName: cp.cardholder_name ? String(cp.cardholder_name).trim() : null,
    generatedCard:  cp.generated_card ?? null,
  }
}

/** "JANE DOE" → Jane Doe; "DOE/JANE" (some issuers) → Jane Doe; blank → Card Customer. */
export function nameFromCard(holder: string | null | undefined): { first: string; last: string } {
  const clean = (holder ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return { first: 'Card', last: 'Customer' }
  const title = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  if (clean.includes('/')) {
    const [l, f] = clean.split('/')
    return { first: title((f || 'Card').trim()), last: title((l || 'Customer').trim()) }
  }
  const parts = clean.split(' ').map(title)
  if (parts.length === 1) return { first: parts[0], last: '' }
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] }
}

export interface CardCustomer { customerId: string; isNew: boolean; cardSaved: boolean; firstName: string; lastName: string }

/** The customer this card belongs to — made on the spot the first time it is seen at this company. */
export async function findOrCreateCustomerForCard(client: PoolClient, opts: { landlordId: string; card: CardIdentity }): Promise<CardCustomer> {
  const existing = await client.query<any>(
    `SELECT c.pos_customer_id, c.stripe_payment_method_id, p.first_name, p.last_name
       FROM pos_customer_cards c JOIN pos_customers p ON p.id = c.pos_customer_id
      WHERE c.landlord_id = $1 AND c.fingerprint = $2 AND p.archived_at IS NULL`,
    [opts.landlordId, opts.card.fingerprint])
  if (existing.rows[0]) {
    await client.query(
      `UPDATE pos_customer_cards SET last_seen_at = NOW(), last4 = COALESCE($3, last4), brand = COALESCE($4, brand)
        WHERE landlord_id = $1 AND fingerprint = $2`,
      [opts.landlordId, opts.card.fingerprint, opts.card.last4, opts.card.brand])
    const r = existing.rows[0]
    return { customerId: r.pos_customer_id, isNew: false, cardSaved: !!r.stripe_payment_method_id, firstName: r.first_name, lastName: r.last_name }
  }
  const { first, last } = nameFromCard(opts.card.cardholderName)
  const created = await client.query<{ id: string }>(
    `INSERT INTO pos_customers (landlord_id, first_name, last_name, email, created_from)
     VALUES ($1, $2, $3, NULL, 'card_reader') RETURNING id`, [opts.landlordId, first, last])
  const customerId = created.rows[0].id
  await client.query(
    `INSERT INTO pos_customer_cards (landlord_id, pos_customer_id, fingerprint, brand, last4, cardholder_name)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [opts.landlordId, customerId, opts.card.fingerprint, opts.card.brand, opts.card.last4, opts.card.cardholderName])
  return { customerId, isNew: true, cardSaved: false, firstName: first, lastName: last }
}

// The installed Stripe SDK predates the reader's input prompts; the REST call is plain.
async function stripeForm(method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<any> {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY unset')
  const res = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.error?.message || `Stripe ${res.status}`)
  return json
}

export const SAVE_CARD_PROMPT = {
  title: 'Save this card for next time?',   // reader limit: 40 characters
  description: 'Kept by GAM, the payment platform — never written down at the counter. No is fine.',
}
export const RECEIPT_EMAIL_PROMPT = {
  title: 'Email a receipt?',
  description: 'Type your email for a copy, or skip.',
}

/**
 * Put the questions on the reader's own screen: Save this card? (Yes / No
 * thanks, required) then an optional email for the receipt. Best-effort: a
 * reader that cannot prompt simply does not. Stripe's own form: the choices
 * carry an `id` and `text`; the answer comes back as the chosen id.
 */
export async function startSaveCardPrompt(stripeReaderId: string, opts: { askEmail?: boolean } = {}): Promise<boolean> {
  try {
    const form: Record<string, string> = {
      'inputs[0][type]': 'selection',
      'inputs[0][required]': 'true',
      'inputs[0][custom_text][title]': SAVE_CARD_PROMPT.title,
      'inputs[0][custom_text][description]': SAVE_CARD_PROMPT.description,
      'inputs[0][selection][choices][0][style]': 'primary',
      'inputs[0][selection][choices][0][id]': 'yes',
      'inputs[0][selection][choices][0][text]': 'Yes',
      'inputs[0][selection][choices][1][style]': 'secondary',
      'inputs[0][selection][choices][1][id]': 'no',
      'inputs[0][selection][choices][1][text]': 'No thanks',
    }
    if (opts.askEmail !== false) {
      form['inputs[1][type]'] = 'email'
      form['inputs[1][required]'] = 'false'
      form['inputs[1][custom_text][title]'] = RECEIPT_EMAIL_PROMPT.title
      form['inputs[1][custom_text][description]'] = RECEIPT_EMAIL_PROMPT.description
      form['inputs[1][custom_text][skip_button]'] = 'No receipt'
    }
    await stripeForm('POST', `/v1/terminal/readers/${stripeReaderId}/collect_inputs`, form)
    return true
  } catch (e) {
    logger.warn({ err: e, stripeReaderId }, '[reader] save-card prompt could not start')
    return false
  }
}

export type SaveCardAnswer =
  | { answered: false }
  | { answered: true; yes: boolean; email: string | null; reason?: string }

/** What the customer pressed, if anything yet. A screen left alone for two minutes fails the prompt. */
export async function readSaveCardAnswer(stripeReaderId: string): Promise<SaveCardAnswer> {
  const reader: any = await stripeForm('GET', `/v1/terminal/readers/${stripeReaderId}`)
  const action = reader?.action
  if (!action || action.type !== 'collect_inputs') return { answered: true, yes: false, email: null, reason: 'nothing on the reader' }
  if (action.status === 'in_progress') return { answered: false }
  if (action.status !== 'succeeded') return { answered: true, yes: false, email: null, reason: action.failure_message || String(action.status) }
  const inputs: any[] = action.collect_inputs?.inputs ?? []
  const choice = inputs.find(i => i.type === 'selection')?.selection
  const emailIn = inputs.find(i => i.type === 'email')
  const email = emailIn && !emailIn.skipped && typeof emailIn.email?.value === 'string' ? emailIn.email.value.trim().toLowerCase() : null
  return { answered: true, yes: String(choice?.id ?? choice?.text ?? '').toLowerCase() === 'yes', email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null }
}

/** Keep the card: attach the tap's reusable card to the customer's Stripe record and make it their card on file. */
export async function saveCardForCustomer(opts: { landlordId: string; customerId: string; generatedCard: string; fingerprint: string }): Promise<void> {
  const stripe = getStripe()
  const c = await queryOne<any>(
    `SELECT id, first_name, last_name, email, stripe_customer_id FROM pos_customers WHERE id = $1 AND landlord_id = $2`,
    [opts.customerId, opts.landlordId])
  if (!c) throw new Error('customer not found')
  let stripeCustomerId: string | null = c.stripe_customer_id
  if (!stripeCustomerId) {
    const sc = await stripe.customers.create({
      name: `${c.first_name} ${c.last_name}`.trim() || undefined,
      email: c.email || undefined,
      metadata: { gam_pos_customer_id: c.id, gam_landlord_id: opts.landlordId },
    })
    stripeCustomerId = sc.id
    await query(`UPDATE pos_customers SET stripe_customer_id = $1, updated_at = NOW() WHERE id = $2`, [stripeCustomerId, c.id])
  }
  await stripe.paymentMethods.attach(opts.generatedCard, { customer: stripeCustomerId })
  await stripe.customers.update(stripeCustomerId, { invoice_settings: { default_payment_method: opts.generatedCard } })
  await query(
    `UPDATE pos_customer_cards SET stripe_payment_method_id = $1, saved_at = NOW()
      WHERE landlord_id = $2 AND fingerprint = $3`,
    [opts.generatedCard, opts.landlordId, opts.fingerprint])
}
