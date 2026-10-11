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
import { AppError } from '../middleware/errorHandler'

export interface CardIdentity {
  fingerprint: string
  brand: string | null
  last4: string | null
  cardholderName: string | null
  /** The reusable card Stripe generated from this tap, when it could. */
  generatedCard: string | null
}

/**
 * What the card told us — from a PaymentIntent retrieved with latest_charge
 * expanded. A tap at the reader (card_present) or, 10/2, a card typed online on
 * a pay link or charged on file (card): the same card has the same fingerprint
 * either way, so an online payment lands on the same person a tap would. An
 * online card carries no printed name; the name the payer typed on the card
 * page stands in for it. Only a tap yields a reusable card to keep.
 */
export function cardIdentityFromIntent(pi: Stripe.PaymentIntent | null | undefined): CardIdentity | null {
  const ch: any = pi && typeof (pi as any).latest_charge === 'object' ? (pi as any).latest_charge : null
  const pmd = ch?.payment_method_details
  const cp = pmd?.card_present ?? pmd?.interac_present
  if (cp?.fingerprint) {
    return {
      fingerprint:    String(cp.fingerprint),
      brand:          cp.brand ?? null,
      last4:          cp.last4 ?? null,
      cardholderName: cp.cardholder_name ? String(cp.cardholder_name).trim() : null,
      generatedCard:  cp.generated_card ?? null,
    }
  }
  const online = pmd?.card
  if (online?.fingerprint) {
    const typed = typeof ch?.billing_details?.name === 'string' ? ch.billing_details.name.trim() : ''
    return {
      fingerprint:    String(online.fingerprint),
      brand:          online.brand ?? null,
      last4:          online.last4 ?? null,
      cardholderName: typed || null,
      generatedCard:  null,
    }
  }
  return null
}

/**
 * 10/2: the card a recorded sale was paid with, read back from Stripe by the
 * sale's PaymentIntent. Register sales and pay links are charged on GAM's own
 * account, so a plain retrieve finds them. Null when the payment carried no
 * card we can recognize.
 */
export async function readSaleCard(paymentIntentId: string): Promise<CardIdentity | null> {
  const pi = await getStripe().paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] })
  return cardIdentityFromIntent(pi)
}

/** "Visa ••9767" — how a card is named to the clerk. */
export function cardLabel(card: { brand?: string | null; last4?: string | null } | null | undefined): string | null {
  if (!card?.last4) return null
  const names: Record<string, string> = {
    visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', american_express: 'American Express',
    discover: 'Discover', diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay', interac: 'Interac',
  }
  const b = String(card.brand ?? '').toLowerCase()
  return `${names[b] ?? 'Card'} ••${card.last4}`
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
  // A card row belongs to one company once (UNIQUE landlord_id, fingerprint), so
  // it is read whatever state its customer is in: a row left on a closed record
  // is moved to the new one below, never inserted twice.
  const existing = await client.query<any>(
    `SELECT c.pos_customer_id, c.stripe_payment_method_id, p.first_name, p.last_name, p.archived_at
       FROM pos_customer_cards c JOIN pos_customers p ON p.id = c.pos_customer_id
      WHERE c.landlord_id = $1 AND c.fingerprint = $2`,
    [opts.landlordId, opts.card.fingerprint])
  if (existing.rows[0] && !existing.rows[0].archived_at) {
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
  if (existing.rows[0]) {
    await client.query(
      `UPDATE pos_customer_cards SET pos_customer_id = $3, last_seen_at = NOW(), last4 = COALESCE($4, last4), brand = COALESCE($5, brand)
        WHERE landlord_id = $1 AND fingerprint = $2`,
      [opts.landlordId, opts.card.fingerprint, customerId, opts.card.last4, opts.card.brand])
    return { customerId, isNew: true, cardSaved: !!existing.rows[0].stripe_payment_method_id, firstName: first, lastName: last }
  }
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
export const NAME_PROMPT = {
  title: 'Your name?',
  description: 'For your receipt and your purchase history here. Skip if you prefer.',
}

/**
 * Put the questions on the reader's own screen: Save this card? (Yes / No
 * thanks, required) then an optional email for the receipt. Best-effort: a
 * reader that cannot prompt simply does not. Stripe's own form: the choices
 * carry an `id` and `text`; the answer comes back as the chosen id.
 */
export interface PromptAsks { askSave: boolean; askName: boolean; askEmail: boolean }

/**
 * Only what is missing is asked: keep the card (when the tap produced a
 * reusable one), a name (when the card carried none — phone wallets never
 * do), an email for the receipt (when we have none). Nothing missing, nothing
 * asked. Returns false when there was nothing to ask or the reader refused.
 */
export async function startSaveCardPrompt(stripeReaderId: string, asks: PromptAsks): Promise<boolean> {
  if (!asks.askSave && !asks.askName && !asks.askEmail) return false
  try {
    const form: Record<string, string> = {}
    let i = 0
    if (asks.askSave) {
      form[`inputs[${i}][type]`] = 'selection'
      form[`inputs[${i}][required]`] = 'true'
      form[`inputs[${i}][custom_text][title]`] = SAVE_CARD_PROMPT.title
      form[`inputs[${i}][custom_text][description]`] = SAVE_CARD_PROMPT.description
      form[`inputs[${i}][selection][choices][0][style]`] = 'primary'
      form[`inputs[${i}][selection][choices][0][id]`] = 'yes'
      form[`inputs[${i}][selection][choices][0][text]`] = 'Yes'
      form[`inputs[${i}][selection][choices][1][style]`] = 'secondary'
      form[`inputs[${i}][selection][choices][1][id]`] = 'no'
      form[`inputs[${i}][selection][choices][1][text]`] = 'No thanks'
      i++
    }
    if (asks.askName) {
      form[`inputs[${i}][type]`] = 'text'
      form[`inputs[${i}][required]`] = 'false'
      form[`inputs[${i}][custom_text][title]`] = NAME_PROMPT.title
      form[`inputs[${i}][custom_text][description]`] = NAME_PROMPT.description
      form[`inputs[${i}][custom_text][skip_button]`] = 'Skip'
      i++
    }
    if (asks.askEmail) {
      form[`inputs[${i}][type]`] = 'email'
      form[`inputs[${i}][required]`] = 'false'
      form[`inputs[${i}][custom_text][title]`] = RECEIPT_EMAIL_PROMPT.title
      form[`inputs[${i}][custom_text][description]`] = RECEIPT_EMAIL_PROMPT.description
      form[`inputs[${i}][custom_text][skip_button]`] = 'No receipt'
      i++
    }
    await stripeForm('POST', `/v1/terminal/readers/${stripeReaderId}/collect_inputs`, form)
    return true
  } catch (e) {
    logger.warn({ err: e, stripeReaderId }, '[reader] prompt could not start')
    return false
  }
}

export type SaveCardAnswer =
  | { answered: false }
  | { answered: true; yes: boolean | null; name: string | null; email: string | null; reason?: string }

/** What the customer pressed, if anything yet. A screen left alone for two minutes fails the prompt. */
export async function readSaveCardAnswer(stripeReaderId: string): Promise<SaveCardAnswer> {
  const reader: any = await stripeForm('GET', `/v1/terminal/readers/${stripeReaderId}`)
  const action = reader?.action
  if (!action || action.type !== 'collect_inputs') return { answered: true, yes: null, name: null, email: null, reason: 'nothing on the reader' }
  if (action.status === 'in_progress') return { answered: false }
  if (action.status !== 'succeeded') return { answered: true, yes: null, name: null, email: null, reason: action.failure_message || String(action.status) }
  const inputs: any[] = action.collect_inputs?.inputs ?? []
  const choice = inputs.find(i => i.type === 'selection')
  const nameIn = inputs.find(i => i.type === 'text')
  const emailIn = inputs.find(i => i.type === 'email')
  const email = emailIn && !emailIn.skipped && typeof emailIn.email?.value === 'string' ? emailIn.email.value.trim().toLowerCase() : null
  const name = nameIn && !nameIn.skipped && typeof nameIn.text?.value === 'string' ? nameIn.text.value.replace(/\s+/g, ' ').trim().slice(0, 80) : null
  return {
    answered: true,
    yes: choice ? String(choice.selection?.id ?? choice.selection?.text ?? '').toLowerCase() === 'yes' : null,
    name: name || null,
    email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null,
  }
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
  // The Yes IS the consent: the kept card may be shown to them next time.
  await stripeForm('POST', `/v1/payment_methods/${opts.generatedCard}`, { allow_redisplay: 'always' }).catch((e: unknown) =>
    logger.warn({ err: e, paymentMethod: opts.generatedCard }, '[reader] allow_redisplay'))
  await query(
    `UPDATE pos_customer_cards SET stripe_payment_method_id = $1, saved_at = NOW()
      WHERE landlord_id = $2 AND fingerprint = $3`,
    [opts.generatedCard, opts.landlordId, opts.fingerprint])
}

/**
 * 10/2: exactly what a fold did, so it can be put back (posPeople undoLink) —
 * the rows that moved, by id and table; the sales that took the survivor's
 * tenant id; and both records' own details as they were before.
 */
export const MERGE_MOVED_TABLES = ['pos_transactions', 'pos_customer_cards', 'pos_open_tickets', 'pos_pay_links', 'pos_sessions', 'pos_customer_invitations', 'flex_charge_accounts'] as const
export type MergeMovedTable = typeof MERGE_MOVED_TABLES[number]
export interface MergeRecord {
  loserId: string
  into: string
  moved: Partial<Record<MergeMovedTable, string[]>>
  stamped: string[]
  loserBefore: { email: string | null; phone: string | null; notes: string | null }
  intoBefore: { email: string | null; phone: string | null; stripe_customer_id: string | null; tenant_id: string | null; elsewhere_ref: string | null }
}

/**
 * S654 (Nic): fold one customer record into another. Purchases, cards, open
 * tickets, pay links, register sessions, invitations and the charge account
 * move; the survivor keeps its own email/phone and takes the other's when it
 * had none; the folded record is archived, never deleted (its email moves
 * with the survivor when taken, because an address belongs to one live record
 * per company). Throws 409 when both hold something only one can. Returns what
 * it did (MergeRecord), so a fold made by a wrong pick can be put back.
 */
export async function mergePosCustomers(client: PoolClient, opts: { landlordId: string; loserId: string; into: string }): Promise<MergeRecord> {
  if (opts.loserId === opts.into) throw new AppError(400, 'That is the same customer — pick a different one to merge into.')
  const both = await client.query<any>(
    `SELECT id, email, phone, notes, stripe_customer_id, tenant_id, elsewhere_ref FROM pos_customers
      WHERE id = ANY($1::uuid[]) AND landlord_id = $2 AND archived_at IS NULL FOR UPDATE`,
    [[opts.loserId, opts.into], opts.landlordId])
  if (both.rows.length !== 2) throw new AppError(404, 'One of those customers was already merged or closed — open the Customers tab again and pick from the fresh list.')
  const loser = both.rows.find((r: any) => r.id === opts.loserId)
  const survivor = both.rows.find((r: any) => r.id === opts.into)
  // 10/2: a record that is a resident's carries them. Two different residents
  // are two people, whatever their records say, and are never folded together.
  if (loser.tenant_id && survivor.tenant_id && loser.tenant_id !== survivor.tenant_id) {
    throw new AppError(409, 'Those are two different residents, so their records stay apart — press Cancel. If a sale is on the wrong one, open it in History and pick the right person.')
  }
  const tenantId: string | null = survivor.tenant_id ?? loser.tenant_id ?? null
  const takeEmail = !survivor.email && !!loser.email
  const takePhone = !survivor.phone && !!loser.phone
  const record: MergeRecord = {
    loserId: opts.loserId, into: opts.into, moved: {}, stamped: [],
    loserBefore: { email: loser.email ?? null, phone: loser.phone ?? null, notes: loser.notes ?? null },
    intoBefore: { email: survivor.email ?? null, phone: survivor.phone ?? null, stripe_customer_id: survivor.stripe_customer_id ?? null,
                  tenant_id: survivor.tenant_id ?? null, elsewhere_ref: survivor.elsewhere_ref ?? null },
  }
  try {
    for (const table of MERGE_MOVED_TABLES) {
      const moved = await client.query<{ id: string }>(
        `UPDATE ${table} SET pos_customer_id = $1 WHERE pos_customer_id = $2 RETURNING id`, [opts.into, opts.loserId])
      if (moved.rows.length) record.moved[table] = moved.rows.map((r) => r.id)
    }
    // The folded record lets go of what the survivor takes, then is archived.
    await client.query(
      `UPDATE pos_customers SET archived_at = NOW(), updated_at = NOW(),
              email = CASE WHEN $3::boolean THEN NULL ELSE email END,
              phone = CASE WHEN $4::boolean THEN NULL ELSE phone END,
              notes = TRIM(COALESCE(notes, '') || ' Merged into customer ' || $2 || COALESCE(' (email ' || email || ')', ''))
        WHERE id = $1`, [opts.loserId, opts.into, takeEmail, takePhone])
    // The folded record is archived above first, so the survivor can take its
    // resident link without two live records naming the same resident — and,
    // 10/2, where it was picked from elsewhere, so picking that person again
    // still finds this one record.
    await client.query(
      `UPDATE pos_customers SET email = COALESCE(email, $2), phone = COALESCE(phone, $3),
              stripe_customer_id = COALESCE(stripe_customer_id, $4), tenant_id = COALESCE(tenant_id, $5),
              elsewhere_ref = COALESCE(elsewhere_ref, $6), updated_at = NOW()
        WHERE id = $1`, [opts.into, takeEmail ? loser.email : null, takePhone ? loser.phone : null, loser.stripe_customer_id, tenantId,
                         loser.elsewhere_ref ?? null])
    // A resident's purchases say so: every sale on the record names them.
    if (tenantId) {
      const stamped = await client.query<{ id: string }>(
        `UPDATE pos_transactions SET tenant_id = $2 WHERE pos_customer_id = $1 AND tenant_id IS NULL RETURNING id`, [opts.into, tenantId])
      record.stamped = stamped.rows.map((r) => r.id)
    }
  } catch (e: any) {
    if (e?.code === '23505') throw new AppError(409, 'Both customers have something only one can hold (a charge account) — press Cancel, close one of the two charge accounts, then press Merge again.')
    throw e
  }
  return record
}
