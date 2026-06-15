/**
 * S508 — saved payment methods + off-session auto-charge coverage.
 *
 * Mocks Stripe's PaymentIntents.create so we can simulate succeeded /
 * requires_action / decline outcomes without hitting the API.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'

const { piCreateMock, checkoutCreateMock } = vi.hoisted(() => ({
  piCreateMock: vi.fn(),
  checkoutCreateMock: vi.fn(),
}))

vi.mock('stripe', () => {
  const Stripe: any = function () {
    return {
      paymentIntents: {
        create: piCreateMock,
      },
      checkout: {
        sessions: {
          create: checkoutCreateMock,
        },
      },
    }
  }
  Stripe.default = Stripe
  return { default: Stripe }
})

// Mock the customer-facing email so we don't reach Resend.
const { emailBusinessInvoiceSentMock } = vi.hoisted(() => ({
  emailBusinessInvoiceSentMock: vi.fn(async () => undefined),
}))
vi.mock('./email', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, emailBusinessInvoiceSent: emailBusinessInvoiceSentMock }
})

import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { sendGeneratedInvoice } from './recurringInvoiceSend'

beforeEach(async () => {
  await cleanupAllSchema()
  piCreateMock.mockReset()
  checkoutCreateMock.mockReset()
  emailBusinessInvoiceSentMock.mockClear()
  emailBusinessInvoiceSentMock.mockImplementation(async () => undefined)
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy'
})

interface Fixture {
  businessId: string
  customerId: string
  invoiceId: string
}

async function seed(opts: {
  connectReady?: boolean
  customerHasSavedCard?: boolean
} = {}): Promise<Fixture> {
  const hash = await bcrypt.hash('pw', 12)
  const email = `o-${randomUUID()}@test.dev`
  const { rows: [u] } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, $2, 'business_owner', 'B', 'O', TRUE) RETURNING id`,
    [email, hash])
  const { rows: [b] } = await db.query<{ id: string }>(
    `INSERT INTO businesses
       (owner_user_id, name, business_type, email, enabled_features,
        stripe_connect_account_id, connect_payouts_enabled)
     VALUES ($1, 'Test Shop', 'other', $2,
             ARRAY['customers','staff','invoicing']::text[],
             $3, $4)
     RETURNING id`,
    [u.id, email,
     opts.connectReady === false ? null : 'acct_test',
     opts.connectReady === false ? false : true])

  const { rows: [c] } = await db.query<{ id: string }>(
    `INSERT INTO business_customers
       (business_id, customer_type, first_name, last_name,
        email, phone, street1, city, state, zip,
        stripe_customer_id, default_payment_method_id,
        payment_method_brand, payment_method_last4)
     VALUES ($1, 'individual', 'Jane', 'Doe',
             'jane@test.dev', '555-0100',
             '100 Main', 'Phoenix', 'AZ', '85001',
             $2, $3, $4, $5)
     RETURNING id`,
    [b.id,
     opts.customerHasSavedCard ? 'cus_test' : null,
     opts.customerHasSavedCard ? 'pm_test' : null,
     opts.customerHasSavedCard ? 'visa' : null,
     opts.customerHasSavedCard ? '4242' : null])

  const { rows: [inv] } = await db.query<{ id: string }>(
    `INSERT INTO business_invoices
       (business_id, customer_id, invoice_number, status,
        issue_date, due_date, subtotal, tax_amount, total_amount, amount_paid)
     VALUES ($1, $2, 'INV-0001', 'draft',
             CURRENT_DATE, CURRENT_DATE + 30, 100, 0, 100, 0)
     RETURNING id`,
    [b.id, c.id])

  return { businessId: b.id, customerId: c.id, invoiceId: inv.id }
}

// ═══════════════════════════════════════════════════════════════
//  Off-session auto-charge path
// ═══════════════════════════════════════════════════════════════

describe('sendGeneratedInvoice — auto-charge path (S508)', () => {
  it('charges off-session when customer has saved PM; marks invoice paid', async () => {
    const f = await seed({ customerHasSavedCard: true })
    piCreateMock.mockResolvedValue({ id: 'pi_test', status: 'succeeded' })

    const r = await sendGeneratedInvoice(f.invoiceId, f.businessId, null)
    expect(r).toBe('auto_paid')

    expect(piCreateMock).toHaveBeenCalledTimes(1)
    const piArgs = piCreateMock.mock.calls[0]![0]!
    expect(piArgs.customer).toBe('cus_test')
    expect(piArgs.payment_method).toBe('pm_test')
    expect(piArgs.off_session).toBe(true)
    expect(piArgs.confirm).toBe(true)
    expect(piArgs.amount).toBe(10000)  // $100 → 10000 cents
    expect(piArgs.transfer_data.destination).toBe('acct_test')

    const { rows: [inv] } = await db.query<{
      status: string; amount_paid: string; stripe_payment_intent_id: string;
      auto_charge_attempted_at: string | null;
    }>(
      `SELECT status, amount_paid, stripe_payment_intent_id, auto_charge_attempted_at
         FROM business_invoices WHERE id = $1`,
      [f.invoiceId])
    expect(inv.status).toBe('paid')
    expect(Number(inv.amount_paid)).toBe(100)
    expect(inv.stripe_payment_intent_id).toBe('pi_test')
    expect(inv.auto_charge_attempted_at).not.toBeNull()

    // Checkout Session NOT created when we auto-charge.
    expect(checkoutCreateMock).not.toHaveBeenCalled()
    // Customer email NOT sent (success doesn't generate the
    // pay-this-invoice email — that's only for non-auto-paid).
    expect(emailBusinessInvoiceSentMock).not.toHaveBeenCalled()
  })

  it('S510 update: off-session requires_action → sends card-update email + flips to sent', async () => {
    // The fallback path was updated in S510: instead of creating a
    // fresh Checkout link (which would mint a brand-new PM each
    // time), we now send the customer a card-update link that
    // replaces the saved PM in place.
    const f = await seed({ customerHasSavedCard: true })
    piCreateMock.mockResolvedValue({ id: 'pi_test', status: 'requires_action' })

    const r = await sendGeneratedInvoice(f.invoiceId, f.businessId, null)
    expect(r).toBe('email_sent')

    // No Checkout Session created on the S510 path.
    expect(checkoutCreateMock).not.toHaveBeenCalled()
    // No "pay this invoice" email — only the card-update email was
    // sent (mocked via the cardUpdateTokens module path, not the
    // invoice-sent path).
    expect(emailBusinessInvoiceSentMock).not.toHaveBeenCalled()

    const { rows: [inv] } = await db.query<{
      status: string; auto_charge_last_error: string;
    }>(
      `SELECT status, auto_charge_last_error
         FROM business_invoices WHERE id = $1`, [f.invoiceId])
    expect(inv.status).toBe('sent')
    expect(inv.auto_charge_last_error).toMatch(/requires_action/)

    // Token row was created for the card-update flow.
    const { rows: tokens } = await db.query(
      `SELECT id FROM business_customer_payment_update_tokens
        WHERE customer_id = $1`, [f.customerId])
    expect(tokens.length).toBe(1)
  })

  it('records auto_charge_last_error when Stripe throws (card declined) + emits card-update token', async () => {
    const f = await seed({ customerHasSavedCard: true })
    const declined = new Error('Your card was declined.')
    ;(declined as any).code = 'card_declined'
    piCreateMock.mockRejectedValueOnce(declined)

    const r = await sendGeneratedInvoice(f.invoiceId, f.businessId, null)
    expect(r).toBe('email_sent')

    const { rows: [inv] } = await db.query<{
      status: string; auto_charge_last_error: string;
    }>(
      `SELECT status, auto_charge_last_error
         FROM business_invoices WHERE id = $1`, [f.invoiceId])
    expect(inv.status).toBe('sent')
    expect(inv.auto_charge_last_error).toMatch(/card_declined/)

    const { rows: tokens } = await db.query(
      `SELECT id FROM business_customer_payment_update_tokens
        WHERE customer_id = $1`, [f.customerId])
    expect(tokens.length).toBe(1)
  })

  it('no saved card → goes straight to Checkout path', async () => {
    const f = await seed({ customerHasSavedCard: false })
    checkoutCreateMock.mockResolvedValue({
      id: 'cs_test', url: 'https://checkout.stripe.com/test',
    })

    const r = await sendGeneratedInvoice(f.invoiceId, f.businessId, null)
    expect(r).toBe('email_sent')
    expect(piCreateMock).not.toHaveBeenCalled()
    expect(checkoutCreateMock).toHaveBeenCalledTimes(1)
    // Should request save-for-future-use on the Checkout call
    const cArgs = checkoutCreateMock.mock.calls[0]![0]!
    expect(cArgs.payment_intent_data.setup_future_usage).toBe('off_session')
  })

  it('Connect not ready → skips Stripe entirely, just emails text-only', async () => {
    const f = await seed({ connectReady: false, customerHasSavedCard: false })
    const r = await sendGeneratedInvoice(f.invoiceId, f.businessId, null)
    expect(r).toBe('email_sent')
    expect(piCreateMock).not.toHaveBeenCalled()
    expect(checkoutCreateMock).not.toHaveBeenCalled()
    expect(emailBusinessInvoiceSentMock).toHaveBeenCalledTimes(1)
    const arg = (emailBusinessInvoiceSentMock.mock.calls as any[])[0][0]
    expect(arg.payUrl).toBeNull()
  })
})
