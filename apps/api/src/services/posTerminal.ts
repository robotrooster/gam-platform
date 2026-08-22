// S241: Stripe Terminal reader-management service.
// S242: + card-present PaymentIntent lifecycle (create / process on
//         reader / capture / cancel).
//
// Nic decision: "if we are using stripe api any stripe hardware should
// work." This service wraps the Stripe Terminal API for:
//
//   - Connection Tokens (client SDK auth)
//   - Reader registration (pair a physical reader to a property)
//   - Reader listing (active readers per property)
//   - Reader archival (soft-disable in our table; Stripe-side delete
//     is a separate operation owners can do via dashboard if needed)
//   - Card-present PaymentIntents — create, push-to-reader (server-
//     driven flow), capture, cancel
//
// All Stripe API calls fire under the LANDLORD's Connect account
// (stripeAccount override). The Terminal reader belongs to the
// landlord's Stripe account, not GAM's platform — same posture as the
// rest of the POS revenue model (POS sales are landlord revenue, not
// GAM revenue). The PaymentIntent is therefore created directly on the
// landlord's Connect account; NO `transfer_data` / `application_fee_amount`
// — gross stays on the landlord's balance, Stripe's IC+ fee is netted
// by Stripe automatically, GAM's revenue from POS is the monthly per-
// unit platform fee (billed separately via the platform subscription
// engine), NOT a per-transaction cut.

import { getStripe } from '../lib/stripe'
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import type Stripe from 'stripe'

interface ReaderRow {
  id:                string
  landlord_id:       string
  property_id:       string
  stripe_reader_id:  string
  nickname:          string
  status:            'active' | 'archived'
  registered_at:     string
  created_at:        string
  updated_at:        string
}

/**
 * Create a Connection Token for the Terminal SDK. The client SDK uses
 * this to authenticate with Stripe Terminal — short-lived (a few
 * minutes); the SDK fetches a fresh one on each connection attempt.
 */
export async function createConnectionToken(
  landlordConnectAccountId: string,
): Promise<string> {
  const stripe = getStripe()
  const token = await stripe.terminal.connectionTokens.create(
    {},
    { stripeAccount: landlordConnectAccountId },
  )
  if (!token.secret) {
    throw new AppError(500, 'Stripe returned a Connection Token with no secret')
  }
  return token.secret
}

/**
 * Register a physical reader with Stripe + persist locally. The
 * registration_code is shown on the reader's screen when the operator
 * enters pairing mode; it's a one-time human-readable code that maps
 * to a Stripe reader id on the backend side.
 *
 * Returns the inserted row (with stripe_reader_id stamped) on success.
 * Throws if Stripe rejects the code OR if this reader is already
 * registered for this landlord.
 */
export async function registerReader(opts: {
  landlordId: string
  landlordConnectAccountId: string
  propertyId: string
  registrationCode: string
  nickname: string
  label?: string  // optional Stripe-side label
}): Promise<ReaderRow> {
  const stripe = getStripe()
  const stripeReader = await stripe.terminal.readers.create(
    {
      registration_code: opts.registrationCode,
      label: opts.label ?? opts.nickname,
    },
    { stripeAccount: opts.landlordConnectAccountId },
  )

  // Persist locally. UNIQUE on (landlord_id, stripe_reader_id) catches
  // race / re-registration; turn 23505 into a clean conflict message.
  try {
    const row = await queryOne<ReaderRow>(
      `INSERT INTO pos_terminal_readers
         (landlord_id, property_id, stripe_reader_id, nickname)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [opts.landlordId, opts.propertyId, stripeReader.id, opts.nickname],
    )
    return row!
  } catch (e: any) {
    if (e?.code === '23505') {
      throw new AppError(409, 'Reader already registered with this landlord')
    }
    throw e
  }
}

/**
 * List active readers for a property (or all properties belonging to
 * this landlord if propertyId is omitted).
 */
export async function listReaders(
  landlordId: string,
  propertyId?: string,
): Promise<ReaderRow[]> {
  if (propertyId) {
    return query<ReaderRow>(
      `SELECT * FROM pos_terminal_readers
        WHERE landlord_id = $1 AND property_id = $2 AND status = 'active'
        ORDER BY nickname`,
      [landlordId, propertyId],
    )
  }
  return query<ReaderRow>(
    `SELECT * FROM pos_terminal_readers
      WHERE landlord_id = $1 AND status = 'active'
      ORDER BY nickname`,
    [landlordId],
  )
}

/**
 * Soft-archive a reader. The Stripe-side record stays — landlord can
 * delete via the Stripe dashboard if desired. Local archival hides
 * the reader from POS UI without losing historical references.
 */
export async function archiveReader(
  landlordId: string,
  readerId: string,
): Promise<ReaderRow> {
  const row = await queryOne<ReaderRow>(
    `UPDATE pos_terminal_readers
        SET status = 'archived', updated_at = NOW()
      WHERE id = $1 AND landlord_id = $2 AND status = 'active'
      RETURNING *`,
    [readerId, landlordId],
  )
  if (!row) throw new AppError(404, 'Reader not found or already archived')
  return row
}

// ── CARD-PRESENT PAYMENT INTENTS (S242) ──────────────────────────────

/**
 * Create a card-present PaymentIntent for a POS terminal sale.
 *
 * Runs under the landlord's Connect account — the PI lives there
 * entirely. `capture_method='manual'` is the card-present default;
 * the reader auths on tap/insert/swipe, transitioning the PI to
 * `requires_capture`, and the caller flips to `succeeded` via
 * `captureTerminalPaymentIntent` once the sale is finalized in POS
 * (allows cancel-after-auth if the operator voids the sale before
 * recording the transaction).
 *
 * Metadata is the dispatch key for the platform webhook handler:
 * Connect-account `payment_intent.succeeded` events with
 * `metadata.gam_purpose='pos_terminal'` are skipped by the rent
 * allocation path (defensive — they have no matching `payments` row
 * anyway, but the metadata makes the intent explicit and audit-
 * friendly).
 */
export async function createCardPresentPaymentIntent(opts: {
  landlordConnectAccountId: string
  landlordId:               string
  propertyId:               string
  amountCents:              number       // total to charge in cents
  currency?:                string       // default 'usd'
  description?:             string
  // Optional: stamp a draft tx id from the POS UI so the eventual
  // POST /pos/transactions can de-dupe on PI id (we already have a
  // UNIQUE on pos_transactions.stripe_payment_intent_id).
  posDraftRef?:             string
}): Promise<Stripe.PaymentIntent> {
  if (!Number.isInteger(opts.amountCents) || opts.amountCents <= 0) {
    throw new AppError(400, 'amountCents must be a positive integer')
  }
  const stripe = getStripe()
  const intent = await stripe.paymentIntents.create(
    {
      amount:               opts.amountCents,
      currency:             opts.currency ?? 'usd',
      payment_method_types: ['card_present'],
      capture_method:       'manual',
      description:          opts.description ?? 'GAM POS sale',
      metadata: {
        gam_purpose:     'pos_terminal',
        gam_landlord_id: opts.landlordId,
        gam_property_id: opts.propertyId,
        ...(opts.posDraftRef ? { gam_pos_draft_ref: opts.posDraftRef } : {}),
      },
    },
    { stripeAccount: opts.landlordConnectAccountId },
  )
  return intent
}

/**
 * Push a created PaymentIntent to a physical reader (server-driven
 * flow). The reader prompts the customer (tap / insert / swipe);
 * Stripe transitions the PI to `requires_capture` on successful auth
 * or `requires_payment_method` on failure. The reader's
 * `action.status` field on the returned object reflects in-progress
 * state.
 *
 * Client-driven readers (handheld Bluetooth, used via the Terminal JS
 * SDK in the browser) skip this step — the client SDK collects the
 * payment method and confirms the PI directly. This route is only for
 * smart readers (S700, WisePOS E, etc.).
 */
export async function processPaymentIntentOnReader(opts: {
  landlordConnectAccountId: string
  stripeReaderId:           string
  paymentIntentId:          string
}): Promise<Stripe.Terminal.Reader> {
  const stripe = getStripe()
  const reader = await stripe.terminal.readers.processPaymentIntent(
    opts.stripeReaderId,
    { payment_intent: opts.paymentIntentId },
    { stripeAccount: opts.landlordConnectAccountId },
  )
  return reader
}

/**
 * Capture a card-present PaymentIntent that's in `requires_capture`
 * after a successful reader auth. Settles the auth → flips PI to
 * `succeeded` → funds land in the landlord's Connect balance per
 * their payout schedule.
 */
export async function captureTerminalPaymentIntent(opts: {
  landlordConnectAccountId: string
  paymentIntentId:          string
}): Promise<Stripe.PaymentIntent> {
  const stripe = getStripe()
  const intent = await stripe.paymentIntents.capture(
    opts.paymentIntentId,
    {},
    { stripeAccount: opts.landlordConnectAccountId },
  )
  return intent
}

/**
 * Cancel a card-present PaymentIntent before capture — operator voids
 * the sale, customer walks, reader times out, etc. Safe to call on
 * a PI in `requires_payment_method`, `requires_capture`, or
 * `requires_action`; Stripe rejects cancel on already-`succeeded` or
 * already-`canceled`. Caller handles those branches.
 */
export async function cancelTerminalPaymentIntent(opts: {
  landlordConnectAccountId: string
  paymentIntentId:          string
}): Promise<Stripe.PaymentIntent> {
  const stripe = getStripe()
  const intent = await stripe.paymentIntents.cancel(
    opts.paymentIntentId,
    undefined,
    { stripeAccount: opts.landlordConnectAccountId },
  )
  return intent
}

/**
 * Retrieve a PaymentIntent under the landlord's Connect account.
 * Used by POST /pos/transactions to verify a terminal-paid sale: the
 * caller-supplied PI id must exist on the landlord's Connect, must
 * carry the POS-terminal metadata, must be in `succeeded` status, and
 * the amount must match the POS-computed total.
 */
export async function retrieveTerminalPaymentIntent(opts: {
  landlordConnectAccountId: string
  paymentIntentId:          string
}): Promise<Stripe.PaymentIntent> {
  const stripe = getStripe()
  return stripe.paymentIntents.retrieve(
    opts.paymentIntentId,
    {},
    { stripeAccount: opts.landlordConnectAccountId },
  )
}

// ═══════════════════════════════════════════════════════════════════
// S536 (Nic): BUSINESS-scope Terminal — the POS portal is the front
// counter for businesses too, and "swiping the card or tap completes
// the transaction." Readers pair to the BUSINESS's Connect account;
// PaymentIntents are DIRECT charges there (business pays Stripe's
// card-present cost) with GAM's markup as application_fee_amount —
// structurally impossible for GAM to lose money on a sale. The
// process/capture/cancel/retrieve helpers above are account-generic
// and are reused as-is.
// ═══════════════════════════════════════════════════════════════════

interface BusinessReaderRow {
  id:               string
  business_id:      string
  stripe_reader_id: string
  nickname:         string
  status:           'active' | 'archived'
  registered_at:    string
}

// S536 rework: ALL money flows through GAM. Readers register on the
// PLATFORM account (not the business's Connect), inside a per-business
// Terminal Location built from the business address; charges are
// platform destination charges. Friday payouts batch the balance out.
async function getOrCreateBusinessLocation(businessId: string): Promise<string> {
  const biz = await queryOne<any>(
    `SELECT name, street1, street2, city, state, zip, stripe_terminal_location_id
       FROM businesses WHERE id = $1`, [businessId])
  if (!biz) throw new AppError(404, 'Business not found')
  if (biz.stripe_terminal_location_id) return biz.stripe_terminal_location_id
  if (!biz.street1 || !biz.city || !biz.state || !biz.zip) {
    throw new AppError(409, 'Add the business address in Settings before pairing a reader — Stripe requires a location')
  }
  const stripe = getStripe()
  const loc = await stripe.terminal.locations.create({
    display_name: biz.name,
    address: {
      line1: biz.street1, line2: biz.street2 ?? undefined,
      city: biz.city, state: biz.state, postal_code: biz.zip, country: 'US',
    },
  })
  await query(`UPDATE businesses SET stripe_terminal_location_id = $1 WHERE id = $2`, [loc.id, businessId])
  return loc.id
}

export async function registerBusinessReader(opts: {
  businessId:               string
  businessConnectAccountId: string
  registrationCode:         string
  nickname:                 string
  label?:                   string
}): Promise<BusinessReaderRow> {
  const stripe = getStripe()
  const locationId = await getOrCreateBusinessLocation(opts.businessId)
  const reader = await stripe.terminal.readers.create(
    {
      registration_code: opts.registrationCode,
      label:             opts.label ?? opts.nickname,
      location:          locationId,
      metadata:          { gam_business_id: opts.businessId },
    },
  )
  const row = await queryOne<BusinessReaderRow>(
    `INSERT INTO business_terminal_readers (business_id, stripe_reader_id, nickname)
     VALUES ($1, $2, $3)
     RETURNING id, business_id, stripe_reader_id, nickname, status, registered_at`,
    [opts.businessId, reader.id, opts.nickname])
  return row!
}

export async function listBusinessReaders(businessId: string): Promise<BusinessReaderRow[]> {
  return query<BusinessReaderRow>(
    `SELECT id, business_id, stripe_reader_id, nickname, status, registered_at
       FROM business_terminal_readers
      WHERE business_id = $1 AND status = 'active'
      ORDER BY registered_at DESC`, [businessId])
}

export async function archiveBusinessReader(businessId: string, id: string): Promise<BusinessReaderRow> {
  const row = await queryOne<BusinessReaderRow>(
    `UPDATE business_terminal_readers
        SET status = 'archived', updated_at = NOW()
      WHERE id = $1 AND business_id = $2 AND status = 'active'
      RETURNING id, business_id, stripe_reader_id, nickname, status, registered_at`,
    [id, businessId])
  if (!row) throw new AppError(404, 'Reader not found')
  return row
}

export async function assertBusinessReader(businessId: string, stripeReaderId: string): Promise<void> {
  const row = await queryOne(
    `SELECT 1 FROM business_terminal_readers
      WHERE business_id = $1 AND stripe_reader_id = $2 AND status = 'active'`,
    [businessId, stripeReaderId])
  if (!row) throw new AppError(404, 'Reader not paired to this business')
}

export async function createBusinessCardPresentPaymentIntent(opts: {
  businessConnectAccountId: string
  businessId:               string
  amountCents:              number
  platformCutCents:      number
  currency?:                string
  description?:             string
}): Promise<Stripe.PaymentIntent> {
  if (!Number.isInteger(opts.amountCents) || opts.amountCents <= 0) {
    throw new AppError(400, 'amountCents must be a positive integer')
  }
  const stripe = getStripe()
  // Platform destination charge: GAM is the merchant, the gross (minus
  // GAM's application fee) transfers to the business's Connect balance,
  // and the Friday payout batch moves it to their bank.
  return stripe.paymentIntents.create(
    {
      amount:                 opts.amountCents,
      currency:               opts.currency ?? 'usd',
      payment_method_types:   ['card_present'],
      capture_method:         'manual',
      application_fee_amount: Math.max(0, Math.round(opts.platformCutCents)),
      transfer_data:          { destination: opts.businessConnectAccountId },
      on_behalf_of:           opts.businessConnectAccountId,
      description:            opts.description ?? 'POS sale',
      metadata: {
        gam_purpose:     'business_pos_terminal',
        gam_business_id: opts.businessId,
      },
    },
  )
}

// Platform-account variants of the PI lifecycle (business terminal
// flow) — same shapes as the landlord fns above minus the
// stripeAccount override.
export async function processBusinessPIOnReader(opts: { stripeReaderId: string; paymentIntentId: string }): Promise<Stripe.Terminal.Reader> {
  const stripe = getStripe()
  return stripe.terminal.readers.processPaymentIntent(opts.stripeReaderId, { payment_intent: opts.paymentIntentId })
}
export async function retrieveBusinessPI(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
  return getStripe().paymentIntents.retrieve(paymentIntentId)
}
export async function captureBusinessPI(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
  return getStripe().paymentIntents.capture(paymentIntentId)
}
export async function cancelBusinessPI(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
  return getStripe().paymentIntents.cancel(paymentIntentId)
}
