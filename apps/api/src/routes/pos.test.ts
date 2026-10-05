/**
 * POS — POST /api/pos/transactions (S338 first pass).
 *
 * The money path. ~200-line endpoint (pos.ts:299-483) covering:
 *   - cash / card / terminal-PI / FlexCharge payment paths
 *   - server-side tax calc via calculateCartTax (mocked here)
 *   - stock decrement + inventory log + auto-PO when stock <= min
 *   - S70 cross-landlord guard (item_id from another landlord →
 *     transaction row inserts but stock does NOT decrement)
 *   - S242 stripePaymentIntentId validation (status/amount/metadata)
 *   - dedupe via pos_transactions_stripe_pi_uniq UNIQUE index
 *   - S254 FlexCharge gate: XOR tenant/posCustomer, charge_eligible
 *     items, account active + same landlord
 *
 * Out of scope: /sessions (separate slice), /eod/close, /terminal/*
 * direct calls, inventory CRUD endpoints. Each is a follow-up file.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { processingFeeFor } from '@gam/shared'
// S648 (Nic): every card sale carries the card fee, priced by the server.
const withCardFee = (net: number) => Math.round((net + processingFeeFor({ amount: net, paymentMethod: 'card' })) * 100)
import { db } from '../db'
import {
  cleanupAllSchema,
  seedLandlord, seedProperty, seedTenant, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

const {
  calculateCartTaxMock,
  retrieveTerminalPaymentIntentMock,
  getAccountForChargeMock,
  postFlexChargeTransactionMock,
  // S345: terminal mocks — hoisted so test cases can override return
  // values + assert call args.
  createConnectionTokenMock,
  registerReaderMock,
  listReadersMock,
  archiveReaderMock,
  createCardPresentPaymentIntentMock,
  processPaymentIntentOnReaderMock,
  captureTerminalPaymentIntentMock,
  cancelTerminalPaymentIntentMock,
  cancelReaderActionMock, showCartOnReaderMock, holdForTheCartMock, clearCartOnReaderMock, readerActionMock,
  startSaveCardPromptMock, readSaveCardAnswerMock, saveCardForCustomerMock, emailPosReceiptMock, readSaleCardMock,
} = vi.hoisted(() => ({
  // 10/2: the card a recorded sale was paid with, read back from Stripe.
  readSaleCardMock:        vi.fn(async (_pi: string): Promise<any> => null),
  startSaveCardPromptMock: vi.fn(async () => true),
  readSaveCardAnswerMock:  vi.fn(async (): Promise<any> => ({ answered: false })),
  saveCardForCustomerMock: vi.fn(async () => undefined),
  emailPosReceiptMock:     vi.fn(async () => undefined),
  cancelReaderActionMock: vi.fn(async () => undefined),
  showCartOnReaderMock: vi.fn(async (): Promise<boolean> => true),
  holdForTheCartMock:   vi.fn(async () => undefined),
  clearCartOnReaderMock: vi.fn(async () => true),
  readerActionMock:     vi.fn(async (): Promise<any> => null),
  calculateCartTaxMock: vi.fn(async (_landlordId: string, cart: any[]) => {
    // Default: no tax. Tests can override per case via mockResolvedValueOnce.
    const subtotal = cart.reduce((s, l) => s + (l.qty * l.unitPrice), 0)
    return {
      subtotal,
      taxAmount: 0,
      lines: cart.map(l => ({ itemId: l.itemId, lineSubtotal: l.qty * l.unitPrice, lineTax: 0 })),
    }
  }),
  retrieveTerminalPaymentIntentMock: vi.fn(async () => ({
    id:       'pi_mock',
    status:   'succeeded',
    amount:   0,  // tests override per case
    metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: '' },
  })),
  getAccountForChargeMock: vi.fn(async () => null as any),
  postFlexChargeTransactionMock: vi.fn(async () => ({
    id: 'fct_mock', account_id: 'acc_mock', amount: '0', status: 'posted',
  })),
  createConnectionTokenMock:          vi.fn(async () => 'pst_mock_secret'),
  registerReaderMock:                 vi.fn(async () => ({ id: 'rd_db_mock' })),
  listReadersMock:                    vi.fn(async () => [] as any[]),
  archiveReaderMock:                  vi.fn(async () => ({ id: 'rd_db_mock', status: 'archived' })),
  createCardPresentPaymentIntentMock: vi.fn(async () => ({ id: 'pi_card_mock', status: 'requires_payment_method', client_secret: 'pi_card_mock_secret' })),
  processPaymentIntentOnReaderMock:   vi.fn(async () => ({ id: 'tmr_mock', action: { status: 'in_progress', type: 'process_payment_intent' } })),
  captureTerminalPaymentIntentMock:   vi.fn(async () => ({ id: 'pi_card_mock', status: 'succeeded', amount: 1000 })),
  cancelTerminalPaymentIntentMock:    vi.fn(async () => ({ id: 'pi_card_mock', status: 'canceled' })),
}))
// S554: only the DB-hitting calculateCartTax is mocked; computeCartTotals (the
// real aggregation) is kept so /transactions + /cart-quote exercise the true
// total math on top of the mocked tax.
vi.mock('../services/posTax', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/posTax')>()),
  calculateCartTax: calculateCartTaxMock,
}))
vi.mock('../services/posTerminal', () => ({
  retrieveTerminalPaymentIntent:  retrieveTerminalPaymentIntentMock,
  retrieveTerminalPaymentIntentWithCharge: retrieveTerminalPaymentIntentMock,
  createConnectionToken:          createConnectionTokenMock,
  registerReader:                 registerReaderMock,
  listReaders:                    listReadersMock,
  archiveReader:                  archiveReaderMock,
  createCardPresentPaymentIntent: createCardPresentPaymentIntentMock,
  processPaymentIntentOnReader:   processPaymentIntentOnReaderMock,
  captureTerminalPaymentIntent:   captureTerminalPaymentIntentMock,
  cancelTerminalPaymentIntent:    cancelTerminalPaymentIntentMock,
  cancelReaderAction:             cancelReaderActionMock,
  showCartOnReader:               showCartOnReaderMock,
  holdForTheCart:                 holdForTheCartMock,
  clearCartOnReader:              clearCartOnReaderMock,
  readerAction:                   readerActionMock,
  READER_CART_PAUSE_MS:           0,
}))
// S654: the reader's save-card prompt and the Stripe attach are mocked; the
// card → customer bookkeeping runs for real.
vi.mock('../services/posCustomerCards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/posCustomerCards')>()
  return {
    ...actual,
    startSaveCardPrompt: startSaveCardPromptMock,
    readSaveCardAnswer:  readSaveCardAnswerMock,
    saveCardForCustomer: saveCardForCustomerMock,
    readSaleCard:        readSaleCardMock,
  }
})
vi.mock('../services/businessPdf', () => ({ renderPosReceiptPdf: vi.fn(async () => Buffer.from('%PDF-receipt')) }))
vi.mock('../services/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emailPosReceipt: emailPosReceiptMock,
}))
vi.mock('../services/flexCharge', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getAccountForCharge:        getAccountForChargeMock,
    postFlexChargeTransaction:  postFlexChargeTransactionMock,
  }
})

import { posRouter } from './pos'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/pos', posRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  calculateCartTaxMock.mockClear()
  retrieveTerminalPaymentIntentMock.mockClear()
  getAccountForChargeMock.mockClear()
  postFlexChargeTransactionMock.mockClear()
  createConnectionTokenMock.mockClear()
  createConnectionTokenMock.mockResolvedValue('pst_mock_secret')
  registerReaderMock.mockClear()
  registerReaderMock.mockResolvedValue({ id: 'rd_db_mock' } as any)
  listReadersMock.mockClear()
  listReadersMock.mockResolvedValue([])
  archiveReaderMock.mockClear()
  archiveReaderMock.mockResolvedValue({ id: 'rd_db_mock', status: 'archived' } as any)
  createCardPresentPaymentIntentMock.mockClear()
  createCardPresentPaymentIntentMock.mockResolvedValue({
    id: 'pi_card_mock', status: 'requires_payment_method', client_secret: 'pi_card_mock_secret',
  } as any)
  processPaymentIntentOnReaderMock.mockClear()
  processPaymentIntentOnReaderMock.mockResolvedValue({
    id: 'tmr_mock', action: { status: 'in_progress', type: 'process_payment_intent' },
  } as any)
  captureTerminalPaymentIntentMock.mockClear()
  captureTerminalPaymentIntentMock.mockResolvedValue({ id: 'pi_card_mock', status: 'succeeded', amount: 1000 } as any)
  cancelTerminalPaymentIntentMock.mockClear()
  cancelReaderActionMock.mockClear()
  showCartOnReaderMock.mockClear(); holdForTheCartMock.mockClear(); clearCartOnReaderMock.mockClear()
  readerActionMock.mockReset(); readerActionMock.mockResolvedValue(null)
  startSaveCardPromptMock.mockClear(); startSaveCardPromptMock.mockResolvedValue(true)
  readSaveCardAnswerMock.mockClear(); readSaveCardAnswerMock.mockResolvedValue({ answered: false })
  saveCardForCustomerMock.mockClear()
  emailPosReceiptMock.mockClear()
  readSaleCardMock.mockReset(); readSaleCardMock.mockResolvedValue(null)
  cancelTerminalPaymentIntentMock.mockResolvedValue({ id: 'pi_card_mock', status: 'canceled' } as any)
  // Re-arm defaults (tests override per case).
  calculateCartTaxMock.mockImplementation(async (_landlordId: string, cart: any[]) => {
    const subtotal = cart.reduce((s, l) => s + (l.qty * l.unitPrice), 0)
    return {
      subtotal,
      taxAmount: 0,
      lines: cart.map(l => ({ itemId: l.itemId, lineSubtotal: l.qty * l.unitPrice, lineTax: 0 })),
    }
  })
  retrieveTerminalPaymentIntentMock.mockResolvedValue({
    id: 'pi_mock', status: 'succeeded', amount: 0,
    metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: '' },
  })
  getAccountForChargeMock.mockResolvedValue(null)
  postFlexChargeTransactionMock.mockResolvedValue({
    id: 'fct_mock', account_id: 'acc_mock', amount: '0', status: 'posted',
  })
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_pos'
})

interface PosFixture {
  landlordUserId: string
  landlordId:     string
  propertyId:     string
  categoryId:     string
  landlordToken:  string
}

async function seedPosFixture(opts: { withConnectAccount?: boolean } = {}): Promise<PosFixture> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
    })
    const cat = await client.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active)
       VALUES ($1, 'Test Cat', 1, TRUE) RETURNING id`,
      [landlordId])
    if (opts.withConnectAccount) {
      await client.query(
        `UPDATE users SET stripe_connect_account_id = $1 WHERE id = $2`,
        ['acct_test_landlord', landlordUserId])
    }
    await client.query('COMMIT')
    const landlordToken = jwt.sign(
      { userId: landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' },
    )
    return { landlordUserId, landlordId, propertyId, categoryId: cat.rows[0].id, landlordToken }
  } catch (e) { await client.query('ROLLBACK'); throw e }
  finally { client.release() }
}

interface SeedItemOpts {
  sellPrice?:       number
  costPrice?:       number
  taxRate?:         number
  stockQty?:        number
  stockMin?:        number
  stockMax?:        number
  chargeEligible?:  boolean
  vendorId?:        string | null
  landlordId?:      string  // override for cross-landlord guard test
  propertyId?:      string
  categoryId?:      string
}

async function seedPosItem(f: PosFixture, opts: SeedItemOpts = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO pos_items
       (landlord_id, name, cost_price, sell_price, tax_rate,
        charge_eligible, stock_qty, stock_min, stock_max,
        vendor_id, property_id, category_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      opts.landlordId ?? f.landlordId,
      `Item ${randomUUID().slice(0, 6)}`,
      opts.costPrice ?? 0,
      opts.sellPrice ?? 10,
      opts.taxRate ?? 0,
      opts.chargeEligible ?? true,
      opts.stockQty ?? 999,
      opts.stockMin ?? 0,
      opts.stockMax ?? 999,
      opts.vendorId ?? null,
      opts.propertyId ?? f.propertyId,
      opts.categoryId ?? f.categoryId,
    ])
  return r.rows[0].id
}

async function seedRealTenant(): Promise<string> {
  const client = await db.connect()
  try {
    return await seedTenant(client)
  } finally { client.release() }
}

async function seedVendor(f: PosFixture): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO pos_vendors (landlord_id, name)
     VALUES ($1, $2) RETURNING id`,
    [f.landlordId, `V-${randomUUID().slice(0, 6)}`])
  return r.rows[0].id
}

describe('POST /api/pos/transactions — happy paths', () => {
  it('cash sale: subtotal/tax/total computed, line item + inventory log + stock decrement', async () => {
    const f = await seedPosFixture()
    const itemId = await seedPosItem(f, { sellPrice: 10, stockQty: 50, stockMin: 5 })
    calculateCartTaxMock.mockResolvedValueOnce({
      subtotal: 20, taxAmount: 1.60,
      lines: [{ itemId, lineSubtotal: 20, lineTax: 1.60 }],
    })

    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId: f.propertyId,
        items: [{ id: itemId, name: 'Item', qty: 2, price: 10, tax_rate: 0.08, category: 'Test Cat' }],
        paymentMethod: 'cash',
        changeGiven: 0,
      })

    expect(res.status).toBe(201)
    expect(res.body.data.payment_method).toBe('cash')
    expect(Number(res.body.data.subtotal)).toBe(20)
    expect(Number(res.body.data.tax_amount)).toBe(1.60)
    expect(Number(res.body.data.total)).toBe(21.60)

    // Line item written
    const lines = await db.query<{ item_id: string; qty: number; subtotal: string }>(
      `SELECT item_id, qty, subtotal FROM pos_transaction_items WHERE transaction_id = $1`,
      [res.body.data.id])
    expect(lines.rows.length).toBe(1)
    expect(lines.rows[0].item_id).toBe(itemId)
    expect(Number(lines.rows[0].qty)).toBe(2)

    // Stock decremented + inventory log row
    const item = await db.query<{ stock_qty: number }>(
      `SELECT stock_qty FROM pos_items WHERE id = $1`, [itemId])
    expect(Number(item.rows[0].stock_qty)).toBe(48)
    const log = await db.query<{ change_qty: number; reason: string; reference_id: string }>(
      `SELECT change_qty, reason, reference_id FROM pos_inventory_log WHERE item_id = $1`, [itemId])
    expect(log.rows.length).toBe(1)
    expect(Number(log.rows[0].change_qty)).toBe(-2)
    expect(log.rows[0].reason).toBe('sale')
    expect(log.rows[0].reference_id).toBe(res.body.data.id)
  })

  // S652 (Nic): "charge a transaction on propane at Mountain View… it's not
  // completing the sale." Propane sells by the gallon; 4.6 gallons hit
  // integer stock columns, the database refused "-4.6", and the sale rolled
  // back with the register none the wiser. Stock is numeric(12,3) now.
  it('a fractional quantity (4.6 gallons of propane) completes and moves stock by 4.6', async () => {
    const f = await seedPosFixture()
    const itemId = await seedPosItem(f, { sellPrice: 3.30, stockQty: 767, stockMin: 5 })
    calculateCartTaxMock.mockResolvedValueOnce({
      subtotal: 15.18, taxAmount: 1.00,
      lines: [{ itemId, lineSubtotal: 15.18, lineTax: 1.00 }],
    })
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId: f.propertyId,
        items: [{ id: itemId, name: 'Propane', qty: 4.6, price: 3.30, tax_rate: 0.066, category: 'Fuel' }],
        paymentMethod: 'cash',
        changeGiven: 0,
      })
    expect(res.status).toBe(201)
    const lines = await db.query<{ qty: string }>(
      `SELECT qty FROM pos_transaction_items WHERE transaction_id = $1`, [res.body.data.id])
    expect(Number(lines.rows[0].qty)).toBeCloseTo(4.6, 3)
    const item = await db.query<{ stock_qty: string }>(`SELECT stock_qty FROM pos_items WHERE id = $1`, [itemId])
    expect(Number(item.rows[0].stock_qty)).toBeCloseTo(762.4, 3)
    const log = await db.query<{ change_qty: string; stock_after: string }>(
      `SELECT change_qty, stock_after FROM pos_inventory_log WHERE item_id = $1`, [itemId])
    expect(Number(log.rows[0].change_qty)).toBeCloseTo(-4.6, 3)
    expect(Number(log.rows[0].stock_after)).toBeCloseTo(762.4, 3)
    // and the item list hands stock back as a number, not the driver's text
    const list = await request(buildApp()).get(`/api/pos/items?propertyId=${f.propertyId}`).set('Authorization', `Bearer ${f.landlordToken}`)
    const it = (list.body.data as any[]).find((x) => x.id === itemId)
    // (buildApp() has no camelCase middleware — the live app camelizes on the way out)
    expect(typeof it.stock_qty).toBe('number')
    expect(it.stock_qty).toBeCloseTo(762.4, 3)
  })

  // S654 (Nic, live, at the reader): "Reader not registered to landlord" on his
  // own S710 at his own park. His account owns more than one company; the
  // process call named no property, so the register guessed his HOME company.
  // The card charge itself says which company it belongs to — that is the one.
  it('an account with two companies can run its second company\'s reader', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const c = await db.connect()
    let l2 = '', p2 = ''
    try {
      await c.query('BEGIN')
      const other = await seedLandlord(c)
      l2 = other.landlordId
      p2 = await seedProperty(c, { landlordId: l2, ownerUserId: other.userId, managedByUserId: other.userId })
      await c.query(`INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1, $2, 'owner')`, [l2, f.landlordUserId])
      await c.query(`INSERT INTO pos_terminal_readers (landlord_id, property_id, stripe_reader_id, nickname, status, registered_at)
                     VALUES ($1, $2, 'tmr_second_company', 'Counter S710', 'active', NOW())`, [l2, p2])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const twoCompanies = jwt.sign(
      { userId: f.landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: null,
        landlordIds: [f.landlordId, l2], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_second', status: 'requires_payment_method', amount: 1059,
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: l2, gam_property_id: p2 },
    } as any)
    const ok = await request(buildApp())
      .post('/api/pos/terminal/payment-intents/pi_second/process')
      .set('Authorization', `Bearer ${twoCompanies}`)
      .send({ stripeReaderId: 'tmr_second_company' })
    expect(ok.status).toBe(200)
    expect(processPaymentIntentOnReaderMock).toHaveBeenCalledWith({ stripeReaderId: 'tmr_second_company', paymentIntentId: 'pi_second', allowRedisplay: true })

    // The first company's reader cannot run the second company's sale.
    await db.query(`INSERT INTO pos_terminal_readers (landlord_id, property_id, stripe_reader_id, nickname, status, registered_at)
                    VALUES ($1, $2, 'tmr_first_company', 'Other S710', 'active', NOW())`, [f.landlordId, f.propertyId])
    const wrong = await request(buildApp())
      .post('/api/pos/terminal/payment-intents/pi_second/process')
      .set('Authorization', `Bearer ${twoCompanies}`)
      .send({ stripeReaderId: 'tmr_first_company' })
    expect(wrong.status).toBe(404)

    // A stranger's account cannot see, run, capture, or void the charge at all.
    const strangerFixture = await seedPosFixture()
    for (const [method, path] of [['get', ''], ['post', '/process'], ['post', '/capture'], ['post', '/cancel']] as const) {
      const r = await (request(buildApp()) as any)[method](`/api/pos/terminal/payment-intents/pi_second${path}`)
        .set('Authorization', `Bearer ${strangerFixture.landlordToken}`).send({ stripeReaderId: 'tmr_second_company' })
      expect(r.status).toBe(404)
    }
  })

  // S654 (Nic, live): "Resume and Discard buttons are not doing anything." The
  // open tab belonged to Mountain View; the account also owns Oak Park; the
  // row-keyed calls named no property and guessed. The row names the company.
  it('an account with two companies resumes and discards an open tab at its second company', async () => {
    const f = await seedPosFixture()
    const c = await db.connect()
    let l2 = '', p2 = ''
    try {
      await c.query('BEGIN')
      const other = await seedLandlord(c)
      l2 = other.landlordId
      p2 = await seedProperty(c, { landlordId: l2, ownerUserId: other.userId, managedByUserId: other.userId })
      await c.query(`INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1, $2, 'owner')`, [l2, f.landlordUserId])
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const twoCompanies = jwt.sign(
      { userId: f.landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: null, landlordIds: [f.landlordId, l2], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const opened = await request(buildApp()).post('/api/pos/sessions')
      .set('Authorization', `Bearer ${twoCompanies}`).send({ propertyId: p2 })
    expect(opened.status).toBe(200)
    const sid = opened.body.data.id
    // No propertyId on any of these — the row says which company.
    const got = await request(buildApp()).get(`/api/pos/sessions/${sid}`).set('Authorization', `Bearer ${twoCompanies}`)
    expect(got.status).toBe(200)
    const cat2 = (await db.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active) VALUES ($1, 'Fuel', 1, TRUE) RETURNING id`, [l2])).rows[0].id
    const item2 = await seedPosItem({ ...f, landlordId: l2, propertyId: p2, categoryId: cat2 }, { sellPrice: 3.3, stockQty: 99 })
    const added = await request(buildApp()).post(`/api/pos/sessions/${sid}/items`)
      .set('Authorization', `Bearer ${twoCompanies}`).send({ itemId: item2, itemName: 'Propane', unitPrice: 3.3, qty: 1, taxRate: 0 })
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    const voided = await request(buildApp()).post(`/api/pos/sessions/${sid}/void`)
      .set('Authorization', `Bearer ${twoCompanies}`).send({ reason: 'discarded_at_terminal_load' })
    expect(voided.status).toBe(200)
    // A stranger's account still cannot see it.
    const stranger = await seedPosFixture()
    expect((await request(buildApp()).get(`/api/pos/sessions/${sid}`).set('Authorization', `Bearer ${stranger.landlordToken}`)).status).toBe(404)
  })

  // S654 (Nic): "automatically build a customer base." The card is the
  // customer; the printed name is the record; the reader asks about keeping
  // the card; the second tap of the same card is the same person.
  const tapped = (f: PosFixture, piId: string, amount: number, overrides: Record<string, unknown> = {}) => ({
    id: piId, status: 'requires_capture', amount,
    metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId, gam_property_id: f.propertyId },
    latest_charge: { id: 'ch_' + piId, payment_method_details: { type: 'card_present', card_present: {
      fingerprint: 'fp_jane_visa', brand: 'visa', last4: '4242', cardholder_name: 'JANE DOE', generated_card: 'pm_gen_jane', ...overrides } } },
  })
  it('a card at the register becomes a customer, and the reader asks about keeping the card', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const { stripeReaderId } = await seedTerminalReader(f)
    const itemId = await seedPosItem(f, { sellPrice: 25, stockQty: 999 })
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 25, taxAmount: 0, lines: [{ itemId, lineSubtotal: 25, lineTax: 0 }] })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce(tapped(f, 'pi_jane_1', withCardFee(25)) as any)
    const res = await request(buildApp()).post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Propane', qty: 1, price: 25 }], paymentMethod: 'card',
              stripePaymentIntentId: 'pi_jane_1', stripeReaderId })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const c = res.body.data.customer
    expect(c).toMatchObject({ firstName: 'Jane', lastName: 'Doe', last4: '4242', brand: 'visa', isNew: true, priorPurchases: 0, cardSaved: false, cardKeepable: true, prompting: true, readerId: stripeReaderId })
    // The card carried a name, so only the card question and the receipt email are asked.
    expect(startSaveCardPromptMock).toHaveBeenCalledWith(stripeReaderId, { askSave: true, askName: false, askEmail: true })
    const row = await db.query<any>(`SELECT first_name, last_name, email, created_from FROM pos_customers WHERE id = $1`, [c.id])
    expect(row.rows[0]).toEqual({ first_name: 'Jane', last_name: 'Doe', email: null, created_from: 'card_reader' })
    const card = await db.query<any>(`SELECT fingerprint, cardholder_name, stripe_payment_method_id FROM pos_customer_cards WHERE pos_customer_id = $1`, [c.id])
    expect(card.rows[0]).toEqual({ fingerprint: 'fp_jane_visa', cardholder_name: 'JANE DOE', stripe_payment_method_id: null })
    expect(res.body.data.pos_customer_id).toBe(c.id)

    // Same card again: same customer, one prior purchase, no new record, no second question once kept.
    await db.query(`UPDATE pos_customer_cards SET stripe_payment_method_id = 'pm_gen_jane', saved_at = NOW() WHERE pos_customer_id = $1`, [c.id])
    startSaveCardPromptMock.mockClear()
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 25, taxAmount: 0, lines: [{ itemId, lineSubtotal: 25, lineTax: 0 }] })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce(tapped(f, 'pi_jane_2', withCardFee(25)) as any)
    const again = await request(buildApp()).post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Propane', qty: 1, price: 25 }], paymentMethod: 'card',
              stripePaymentIntentId: 'pi_jane_2', stripeReaderId })
    expect(again.status).toBe(201)
    expect(again.body.data.customer).toMatchObject({ id: c.id, isNew: false, priorPurchases: 1, cardSaved: true })
    // Kept already, and the email on file now: nothing left to ask.
    await db.query(`UPDATE pos_customers SET email = 'jane@example.com' WHERE id = $1`, [c.id])
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 25, taxAmount: 0, lines: [{ itemId, lineSubtotal: 25, lineTax: 0 }] })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce(tapped(f, 'pi_jane_2b', withCardFee(25)) as any)
    startSaveCardPromptMock.mockClear()
    const third = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Propane', qty: 1, price: 25 }], paymentMethod: 'card', stripePaymentIntentId: 'pi_jane_2b', stripeReaderId })
    expect(third.status).toBe(201)
    expect(third.body.data.customer.prompting).toBe(false)
    expect(startSaveCardPromptMock).not.toHaveBeenCalled()
    expect((await db.query(`SELECT COUNT(*)::int AS n FROM pos_customers WHERE landlord_id = $1`, [f.landlordId])).rows[0].n).toBe(1)

    // The purchase history filters to this customer and names them.
    const hist = await request(buildApp()).get(`/api/pos/transactions?propertyId=${f.propertyId}&posCustomerId=${c.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(hist.status).toBe(200)
    expect(hist.body.data).toHaveLength(3)
    expect(hist.body.data[0].customer_name).toBe('Jane Doe')
  })

  // Nic's live test: Apple Pay — no name on the card, nothing reusable. The
  // customer is still made from the card, and the reader asks for a name and
  // an email instead of the card question.
  it('a phone-wallet tap (no name, nothing reusable) still becomes a customer and is asked for name + email', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const { stripeReaderId } = await seedTerminalReader(f)
    const itemId = await seedPosItem(f, { sellPrice: 10, stockQty: 999 })
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 10, taxAmount: 0, lines: [{ itemId, lineSubtotal: 10, lineTax: 0 }] })
    retrieveTerminalPaymentIntentMock.mockResolvedValue(tapped(f, 'pi_wallet', withCardFee(10), { cardholder_name: null, fingerprint: 'fp_wallet', generated_card: null, wallet: { type: 'apple_pay' } }) as any)
    const res = await request(buildApp()).post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Ice', qty: 1, price: 10 }], paymentMethod: 'card', stripePaymentIntentId: 'pi_wallet', stripeReaderId })
    expect(res.status).toBe(201)
    expect(res.body.data.customer).toMatchObject({ firstName: 'Card', lastName: 'Customer', isNew: true, cardKeepable: false, prompting: true, asks: { askSave: false, askName: true, askEmail: true } })
    expect(startSaveCardPromptMock).toHaveBeenCalledWith(stripeReaderId, { askSave: false, askName: true, askEmail: true })
    // They type their name and an email: the record is theirs now, the receipt goes out, nothing is "kept".
    readSaveCardAnswerMock.mockResolvedValueOnce({ answered: true, yes: null, name: 'Nic Rhoades', email: 'nic@example.com' })
    const ans = await request(buildApp()).get(`/api/pos/terminal/readers/${stripeReaderId}/save-card-answer?transactionId=${res.body.data.id}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(ans.body.data).toEqual({ answered: true, saved: false, reason: null, receiptSentTo: 'nic@example.com', nameSet: 'Nic Rhoades' })
    expect(saveCardForCustomerMock).not.toHaveBeenCalled()
    const row = await db.query<any>(`SELECT first_name, last_name, email FROM pos_customers WHERE id = $1`, [res.body.data.customer.id])
    expect(row.rows[0]).toEqual({ first_name: 'Nic', last_name: 'Rhoades', email: 'nic@example.com' })
    // Without a reader named, nothing is asked at all (a fresh tap of the same phone).
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 10, taxAmount: 0, lines: [{ itemId, lineSubtotal: 10, lineTax: 0 }] })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce(tapped(f, 'pi_wallet_2', withCardFee(10), { cardholder_name: null, fingerprint: 'fp_wallet', generated_card: null, wallet: { type: 'apple_pay' } }) as any)
    startSaveCardPromptMock.mockClear()
    const quiet = await request(buildApp()).post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Ice', qty: 1, price: 10 }], paymentMethod: 'card', stripePaymentIntentId: 'pi_wallet_2' })
    expect(quiet.status).toBe(201)
    expect(quiet.body.data.customer.prompting).toBe(false)
    expect(startSaveCardPromptMock).not.toHaveBeenCalled()
  })

  it('the reader\'s Yes keeps the card; No or nothing keeps nothing; a stranger\'s reader is 404', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const { stripeReaderId } = await seedTerminalReader(f)
    const itemId = await seedPosItem(f, { sellPrice: 25, stockQty: 999 })
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 25, taxAmount: 0, lines: [{ itemId, lineSubtotal: 25, lineTax: 0 }] })
    retrieveTerminalPaymentIntentMock.mockResolvedValue(tapped(f, 'pi_jane_3', withCardFee(25)) as any)
    const sale = await request(buildApp()).post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Propane', qty: 1, price: 25 }], paymentMethod: 'card',
              stripePaymentIntentId: 'pi_jane_3', stripeReaderId })
    expect(sale.status).toBe(201)
    const txId = sale.body.data.id
    const ask = (reader = stripeReaderId, token = f.landlordToken) => request(buildApp())
      .get(`/api/pos/terminal/readers/${reader}/save-card-answer?transactionId=${txId}`).set('Authorization', `Bearer ${token}`)
    expect((await ask()).body.data).toEqual({ answered: false })
    readSaveCardAnswerMock.mockResolvedValueOnce({ answered: true, yes: false, name: null, email: null })
    expect((await ask()).body.data).toMatchObject({ answered: true, saved: false, receiptSentTo: null, nameSet: null })
    expect(saveCardForCustomerMock).not.toHaveBeenCalled()
    // Yes, and an email typed on the reader: the card is kept, the receipt goes out, the email is theirs now.
    readSaveCardAnswerMock.mockResolvedValueOnce({ answered: true, yes: true, name: null, email: 'jane@example.com' })
    expect((await ask()).body.data).toEqual({ answered: true, saved: true, reason: null, receiptSentTo: 'jane@example.com', nameSet: null })
    expect(saveCardForCustomerMock).toHaveBeenCalledWith(expect.objectContaining({ customerId: sale.body.data.customer.id, generatedCard: 'pm_gen_jane', fingerprint: 'fp_jane_visa' }))
    expect(emailPosReceiptMock).toHaveBeenCalledWith('jane@example.com', expect.any(String), expect.any(String), withCardFee(25) / 100, expect.any(Buffer), expect.anything())
    expect((await db.query<any>(`SELECT email FROM pos_customers WHERE id = $1`, [sale.body.data.customer.id])).rows[0].email).toBe('jane@example.com')
    const stranger = await seedPosFixture()
    expect((await ask(stripeReaderId, stranger.landlordToken)).status).toBe(404)
  })

  it('emails the receipt with the customer\'s name and keeps the email they gave', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const itemId = await seedPosItem(f, { sellPrice: 25, stockQty: 999 })
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 25, taxAmount: 0, lines: [{ itemId, lineSubtotal: 25, lineTax: 0 }] })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce(tapped(f, 'pi_jane_4', withCardFee(25)) as any)
    const sale = await request(buildApp()).post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Propane', qty: 1, price: 25 }], paymentMethod: 'card', stripePaymentIntentId: 'pi_jane_4' })
    expect(sale.status).toBe(201)
    const bad = await request(buildApp()).post(`/api/pos/transactions/${sale.body.data.id}/email-receipt`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ email: 'not-an-email' })
    expect(bad.status).toBe(400)
    const ok = await request(buildApp()).post(`/api/pos/transactions/${sale.body.data.id}/email-receipt`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ email: 'Jane@Example.com' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.data.sentTo).toBe('jane@example.com')
    expect(emailPosReceiptMock).toHaveBeenCalledWith('jane@example.com', expect.any(String), expect.any(String), withCardFee(25) / 100, expect.any(Buffer), expect.anything())
    const row = await db.query<any>(`SELECT email FROM pos_customers WHERE id = $1`, [sale.body.data.customer.id])
    expect(row.rows[0].email).toBe('jane@example.com')
  })

  // S654 (Nic): the Customers tab — the whole base with counts and cards,
  // likely duplicates by email or phone (never by name), edit, fold one into
  // another, and fix which person a past sale belongs to.
  it('customers tab: list with counts, duplicates by email/phone, edit, merge, and re-assign a sale', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const itemId = await seedPosItem(f, { sellPrice: 25, stockQty: 999 })
    const mk = async (first: string, last: string, email: string | null, phone: string | null) =>
      (await db.query<{ id: string }>(
        `INSERT INTO pos_customers (landlord_id, first_name, last_name, email, phone) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [f.landlordId, first, last, email, phone])).rows[0].id
    const jane  = await mk('Jane', 'Doe', 'jane@example.com', null)
    const jane2 = await mk('J', 'Doe', null, '(602) 555-0100')                   // no email yet; a phone
    const bob   = await mk('Bob', 'Doe', null, '602-555-0100')                   // same phone as jane2 (different punctuation)
    const sam   = await mk('Sam', 'Doe', 'sam@example.com', null)                // same last name only — not a duplicate
    await db.query(`INSERT INTO pos_customer_cards (landlord_id, pos_customer_id, fingerprint, brand, last4, stripe_payment_method_id, saved_at)
                    VALUES ($1,$2,'fp_j2','visa','4242','pm_saved',NOW())`, [f.landlordId, jane2])
    // Two sales for jane2, one for jane.
    for (const [who, pi] of [[jane2, 'pi_c1'], [jane2, 'pi_c2'], [jane, 'pi_c3']] as const) {
      calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 25, taxAmount: 0, lines: [{ itemId, lineSubtotal: 25, lineTax: 0 }] })
      retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({ id: pi, status: 'succeeded', amount: withCardFee(25), metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId, gam_property_id: f.propertyId } } as any)
      const r = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.landlordToken}`)
        .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Propane', qty: 1, price: 25 }], paymentMethod: 'card', stripePaymentIntentId: pi, posCustomerId: who })
      expect(r.status, JSON.stringify(r.body)).toBe(201)
    }
    const list = await request(buildApp()).get(`/api/pos/customers?propertyId=${f.propertyId}`).set('Authorization', `Bearer ${f.landlordToken}`)
    expect(list.status).toBe(200)
    const by = Object.fromEntries(list.body.data.map((c: any) => [c.id, c]))
    expect(by[jane2]).toMatchObject({ purchases: 2, total_spent: withCardFee(25) / 100 * 2, cards: [{ brand: 'visa', last4: '4242', saved: true }] })
    expect(by[jane2].duplicate_ids).toEqual([bob])                        // phone ↔ bob, punctuation ignored
    expect(by[bob].duplicate_ids).toEqual([jane2])
    expect(by[jane].duplicate_ids).toEqual([])
    expect(by[sam].duplicate_ids).toEqual([])                             // a shared surname is not a match
    // Edit.
    const ed = await request(buildApp()).patch(`/api/pos/customers/${bob}`).set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ firstName: 'Robert', email: 'bob@example.com' })
    expect(ed.status).toBe(200)
    expect(ed.body.data).toMatchObject({ first_name: 'Robert', last_name: 'Doe', email: 'bob@example.com', phone: '602-555-0100' })
    // Re-assign jane's sale to sam.
    const sale = (await db.query<{ id: string }>(`SELECT id FROM pos_transactions WHERE pos_customer_id = $1`, [jane])).rows[0].id
    const re = await request(buildApp()).patch(`/api/pos/transactions/${sale}/customer`).set('Authorization', `Bearer ${f.landlordToken}`).send({ posCustomerId: sam })
    expect(re.status).toBe(200)
    expect(re.body.data).toMatchObject({ pos_customer_id: sam, tenant_id: null, customer_name: 'Sam Doe' })
    // Merge jane2 into jane: sales + cards move, jane keeps her email and gains jane2's phone, jane2 is archived.
    const mg = await request(buildApp()).post(`/api/pos/customers/${jane2}/merge`).set('Authorization', `Bearer ${f.landlordToken}`).send({ into: jane })
    expect(mg.status, JSON.stringify(mg.body)).toBe(200)
    expect(mg.body.data).toMatchObject({ id: jane, email: 'jane@example.com', phone: '(602) 555-0100' })   // kept hers, took the phone
    expect((await db.query<any>(`SELECT COUNT(*)::int AS n FROM pos_transactions WHERE pos_customer_id = $1`, [jane])).rows[0].n).toBe(2)
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_customer_cards WHERE fingerprint = 'fp_j2'`)).rows[0].pos_customer_id).toBe(jane)
    const gone = (await db.query<any>(`SELECT archived_at, notes FROM pos_customers WHERE id = $1`, [jane2])).rows[0]
    expect(gone.archived_at).not.toBeNull()
    expect(gone.notes).toContain(jane)
    // The folded record is out of the list; a stranger can touch none of it.
    const after = await request(buildApp()).get(`/api/pos/customers?propertyId=${f.propertyId}`).set('Authorization', `Bearer ${f.landlordToken}`)
    expect(after.body.data.map((c: any) => c.id)).not.toContain(jane2)
    // A card-made record that gives Jane's email for a receipt IS Jane: it folds into her.
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 25, taxAmount: 0, lines: [{ itemId, lineSubtotal: 25, lineTax: 0 }] })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce(tapped(f, 'pi_c4', withCardFee(25), { fingerprint: 'fp_new_card', cardholder_name: 'JANE DOE', generated_card: null }) as any)
    const r4 = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Propane', qty: 1, price: 25 }], paymentMethod: 'card', stripePaymentIntentId: 'pi_c4' })
    expect(r4.status).toBe(201)
    const fresh = r4.body.data.customer.id
    expect(fresh).not.toBe(jane)
    const rc = await request(buildApp()).post(`/api/pos/transactions/${r4.body.data.id}/email-receipt`).set('Authorization', `Bearer ${f.landlordToken}`).send({ email: 'jane@example.com' })
    expect(rc.status, JSON.stringify(rc.body)).toBe(200)
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_transactions WHERE id = $1`, [r4.body.data.id])).rows[0].pos_customer_id).toBe(jane)
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_customer_cards WHERE fingerprint = 'fp_new_card'`)).rows[0].pos_customer_id).toBe(jane)
    expect((await db.query<any>(`SELECT archived_at FROM pos_customers WHERE id = $1`, [fresh])).rows[0].archived_at).not.toBeNull()
    expect((await db.query<any>(`SELECT COUNT(*)::int AS n FROM pos_transactions WHERE pos_customer_id = $1`, [jane])).rows[0].n).toBe(3)
    const stranger = await seedPosFixture()
    expect((await request(buildApp()).patch(`/api/pos/customers/${jane}`).set('Authorization', `Bearer ${stranger.landlordToken}`).send({ firstName: 'X' })).status).toBe(404)
    expect((await request(buildApp()).post(`/api/pos/customers/${sam}/merge`).set('Authorization', `Bearer ${stranger.landlordToken}`).send({ into: jane })).status).toBe(404)
    expect((await request(buildApp()).patch(`/api/pos/transactions/${sale}/customer`).set('Authorization', `Bearer ${stranger.landlordToken}`).send({ posCustomerId: sam })).status).toBe(404)
  })

  it('card sale with valid terminal stripePaymentIntentId persists with PI stamp', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const itemId = await seedPosItem(f, { sellPrice: 25, stockQty: 999 })
    calculateCartTaxMock.mockResolvedValueOnce({
      subtotal: 25, taxAmount: 0,
      lines: [{ itemId, lineSubtotal: 25, lineTax: 0 }],
    })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_terminal_xyz', status: 'succeeded', amount: withCardFee(25),
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId },
    })

    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId: f.propertyId,
        items: [{ id: itemId, name: 'I', qty: 1, price: 25 }],
        paymentMethod: 'card',
        stripePaymentIntentId: 'pi_terminal_xyz',
      })

    expect(res.status).toBe(201)
    expect(res.body.data.stripe_payment_intent_id).toBe('pi_terminal_xyz')
    expect(retrieveTerminalPaymentIntentMock).toHaveBeenCalledWith({ paymentIntentId: 'pi_terminal_xyz' })
    // S648: the money is GAM's until the weekly batch; the landlord is owed
    // the sale less the card fee.
    const held = await db.query<any>(`SELECT amount, payout_intent_id FROM held_payout_items WHERE source_id = $1`, [res.body.data.id])
    expect(Number(held.rows[0].amount)).toBe(25)
    expect(held.rows[0].payout_intent_id).toBeNull()
  })

  it('S648: an absorbed-fee card sale holds the sale less GAM\'s fee for the landlord', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    await db.query(`UPDATE properties SET register_card_fee_payer = 'landlord' WHERE id = $1`, [f.propertyId])
    const itemId = await seedPosItem(f, { sellPrice: 20, stockQty: 999 })
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 20, taxAmount: 0, lines: [{ itemId, lineSubtotal: 20, lineTax: 0 }] })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_absorb', status: 'succeeded', amount: 2000,
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId },
    })
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'I', qty: 1, price: 20 }], paymentMethod: 'card', stripePaymentIntentId: 'pi_absorb' })
    expect(res.status).toBe(201)
    const fee = processingFeeFor({ amount: 20, paymentMethod: 'card' })
    expect(Number(res.body.data.total)).toBe(20)
    expect(Number(res.body.data.surcharge)).toBe(0)
    expect(Number(res.body.data.platform_fee)).toBe(fee)
    const held = await db.query<any>(`SELECT amount FROM held_payout_items WHERE source_id = $1`, [res.body.data.id])
    expect(Number(held.rows[0].amount)).toBe(Math.round((20 - fee) * 100) / 100)
  })

  it('S648: a card sale that didn\'t go through the reader is refused', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const itemId = await seedPosItem(f, { sellPrice: 25, stockQty: 999 })
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'I', qty: 1, price: 25 }], paymentMethod: 'card' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/card reader/i)
    const rows = await db.query(`SELECT 1 FROM pos_transactions WHERE landlord_id = $1`, [f.landlordId])
    expect(rows.rows).toHaveLength(0)
  })

  it('S648: an authorized-only charge is captured together with the sale', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const itemId = await seedPosItem(f, { sellPrice: 10, stockQty: 999 })
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 10, taxAmount: 0, lines: [{ itemId, lineSubtotal: 10, lineTax: 0 }] })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_auth', status: 'requires_capture', amount: withCardFee(10),
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId },
    })
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'I', qty: 1, price: 10 }], paymentMethod: 'card', stripePaymentIntentId: 'pi_auth' })
    expect(res.status).toBe(201)
    expect(captureTerminalPaymentIntentMock).toHaveBeenCalledWith({ paymentIntentId: 'pi_auth' })
  })

  it('S648: if the capture fails, no sale is recorded', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const itemId = await seedPosItem(f, { sellPrice: 10, stockQty: 999 })
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 10, taxAmount: 0, lines: [{ itemId, lineSubtotal: 10, lineTax: 0 }] })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_nocap', status: 'requires_capture', amount: withCardFee(10),
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId },
    })
    captureTerminalPaymentIntentMock.mockRejectedValueOnce(new Error('authorization expired'))
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'I', qty: 1, price: 10 }], paymentMethod: 'card', stripePaymentIntentId: 'pi_nocap' })
    expect(res.status).toBe(500)
    const rows = await db.query(`SELECT 1 FROM pos_transactions WHERE landlord_id = $1`, [f.landlordId])
    expect(rows.rows).toHaveLength(0)
  })

  it('S554 bug #2: card sale with a cart discount — PI minted at NET total matches, discount persisted', async () => {
    // Regression: the route dropped discountAmount and recomputed an
    // UNDISCOUNTED total, so the S242 amount-match guard 400'd after the
    // card was already captured. Here subtotal 25, tax 0, discount 5 →
    // NET total 20 → the terminal PI amount is 2000 cents. Pre-fix the
    // server computed total 25 (2500) and 400'd on the mismatch.
    const f = await seedPosFixture({ withConnectAccount: true })
    const itemId = await seedPosItem(f, { sellPrice: 25, stockQty: 999 })
    calculateCartTaxMock.mockResolvedValueOnce({
      subtotal: 25, taxAmount: 0,
      lines: [{ itemId, lineSubtotal: 25, lineTax: 0 }],
    })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_disc', status: 'succeeded', amount: withCardFee(20),
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId },
    })

    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId: f.propertyId,
        items: [{ id: itemId, name: 'I', qty: 1, price: 25 }],
        paymentMethod: 'card',
        stripePaymentIntentId: 'pi_disc',
        discountAmount: 5, discountReason: 'Loyalty',
      })

    expect(res.status).toBe(201)
    expect(Number(res.body.data.subtotal)).toBe(25)          // gross for books
    expect(Number(res.body.data.discount_amount)).toBe(5)
    expect(res.body.data.discount_reason).toBe('Loyalty')
    expect(Math.round(Number(res.body.data.total) * 100)).toBe(withCardFee(20))  // net + card fee
    expect(Number(res.body.data.surcharge)).toBe(processingFeeFor({ amount: 20, paymentMethod: 'card' }))
  })

  it('S554 bug #2: discount is clamped to [0, subtotal] (cannot invert a sale)', async () => {
    const f = await seedPosFixture()
    const itemId = await seedPosItem(f, { sellPrice: 10, stockQty: 999 })
    calculateCartTaxMock.mockResolvedValueOnce({
      subtotal: 10, taxAmount: 0,
      lines: [{ itemId, lineSubtotal: 10, lineTax: 0 }],
    })
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId: f.propertyId,
        items: [{ id: itemId, name: 'I', qty: 1, price: 10 }],
        paymentMethod: 'cash',
        discountAmount: 999,  // absurd — clamped to the subtotal
      })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.discount_amount)).toBe(10)
    expect(Number(res.body.data.total)).toBe(0)
  })

  // S650 (Nic): "Items are set prices. There's no custom item thing." A cart
  // line with no catalog item behind it is refused — a one-off goes on the
  // lease, or out as a pay link to somebody without one.
  it('refuses a line with no catalog item behind it', async () => {
    const f = await seedPosFixture()
    // No tax mock queued on purpose: the refusal lands before the cart is priced.

    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId: f.propertyId,
        items: [{ name: 'Misc walk-up', qty: 1, price: 15, tax_rate: 0.07 }],
        paymentMethod: 'cash',
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/every register item is one you set up/i)
    expect((await db.query(`SELECT id FROM pos_transactions`)).rows).toHaveLength(0)
  })

  it('refuses the whole sale when one line of a mixed cart is not a catalog item', async () => {
    const f = await seedPosFixture()
    const itemId = await seedPosItem(f, { sellPrice: 10, stockQty: 999 })

    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId: f.propertyId,
        items: [
          { id: itemId, name: 'Catalog',  qty: 1, price: 10 },
          { name: 'Walk-up', qty: 2, price: 5, tax_rate: 0.10 },
        ],
        paymentMethod: 'cash',
      })

    expect(res.status).toBe(400)
    expect((await db.query(`SELECT id FROM pos_transactions`)).rows).toHaveLength(0)
  })

  it('auto-draft PO fires when stock decrement hits stock_min and vendor is set', async () => {
    const f = await seedPosFixture()
    const vendorId = await seedVendor(f)
    const itemId = await seedPosItem(f, {
      sellPrice: 10, costPrice: 4, stockQty: 6, stockMin: 5, stockMax: 20, vendorId,
    })
    calculateCartTaxMock.mockResolvedValueOnce({
      subtotal: 20, taxAmount: 0,
      lines: [{ itemId, lineSubtotal: 20, lineTax: 0 }],
    })

    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId: f.propertyId,
        items: [{ id: itemId, name: 'I', qty: 2, price: 10 }],
        paymentMethod: 'cash',
      })

    expect(res.status).toBe(201)
    // Stock 6 - 2 = 4, which is <= stock_min (5) → auto-PO fires
    const po = await db.query<{ id: string; status: string; vendor_id: string; subtotal: string }>(
      `SELECT id, status, vendor_id, subtotal FROM pos_purchase_orders WHERE landlord_id = $1`,
      [f.landlordId])
    expect(po.rows.length).toBe(1)
    expect(po.rows[0].status).toBe('draft')
    expect(po.rows[0].vendor_id).toBe(vendorId)
    // reorder qty = stock_max - stock_qty(POST-decrement, i.e. 4) = 16; cost_price=4 → subtotal 64
    // BUT the auto-PO reads dbItem (pre-decrement value); pos.ts:495 uses item.stock_max - item.stock_qty
    // where item is the pre-decrement dbItem. So stock_qty=6, max=20 → reorderQty=14, subtotal=56.
    expect(Number(po.rows[0].subtotal)).toBe(56)
    const poItem = await db.query<{ qty_ordered: string; item_id: string }>(
      `SELECT qty_ordered, item_id FROM pos_purchase_order_items WHERE po_id = $1`, [po.rows[0].id])
    expect(Number(poItem.rows[0].qty_ordered)).toBe(14)
    expect(poItem.rows[0].item_id).toBe(itemId)
  })

  it('stock_qty=999 (untracked) items do NOT decrement stock or write inventory log', async () => {
    const f = await seedPosFixture()
    const itemId = await seedPosItem(f, { sellPrice: 5, stockQty: 999, stockMin: 999, stockMax: 999 })
    calculateCartTaxMock.mockResolvedValueOnce({
      subtotal: 5, taxAmount: 0,
      lines: [{ itemId, lineSubtotal: 5, lineTax: 0 }],
    })

    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId: f.propertyId,
        items: [{ id: itemId, name: 'I', qty: 3, price: 5 }],
        paymentMethod: 'cash',
      })

    expect(res.status).toBe(201)
    const item = await db.query<{ stock_qty: number }>(
      `SELECT stock_qty FROM pos_items WHERE id = $1`, [itemId])
    expect(Number(item.rows[0].stock_qty)).toBe(999)  // unchanged
    const log = await db.query(`SELECT id FROM pos_inventory_log WHERE item_id = $1`, [itemId])
    expect(log.rows.length).toBe(0)
  })
})

describe('POST /api/pos/transactions — FlexCharge gate (S254)', () => {
  it('happy path: posts FlexCharge tx after pos_transactions insert succeeds', async () => {
    const f = await seedPosFixture()
    const itemId = await seedPosItem(f, { sellPrice: 50, chargeEligible: true })
    const realTenantId = await seedRealTenant()
    getAccountForChargeMock.mockResolvedValueOnce({
      id: 'acc_fc_1', status: 'active', landlord_id: f.landlordId,
    })
    calculateCartTaxMock.mockResolvedValueOnce({
      subtotal: 50, taxAmount: 0,
      lines: [{ itemId, lineSubtotal: 50, lineTax: 0 }],
    })

    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        items: [{ id: itemId, name: 'I', qty: 1, price: 50 }],
        paymentMethod: 'charge',
        propertyId: f.propertyId,
        tenantId: realTenantId,
      })

    expect(res.status).toBe(201)
    expect(res.body.data.payment_method).toBe('charge')
    // platform_fee = subtotal * 0.01 = 0.50, added to what the customer is
    // charged (S648: the server sets it, as the register always displayed).
    expect(Number(res.body.data.platform_fee)).toBe(0.5)
    expect(Number(res.body.data.total)).toBe(50.5)
    // FlexCharge post called with the new pos_transaction id
    expect(postFlexChargeTransactionMock).toHaveBeenCalledTimes(1)
    const arg = (postFlexChargeTransactionMock.mock.calls as any[][])[0]![0] as any
    expect(arg.accountId).toBe('acc_fc_1')
    expect(arg.posTransactionId).toBe(res.body.data.id)
    expect(arg.amount).toBe(50.5)
  })

  it('propertyId required on every sale → 400 (W-12; generic guard now fires before the FlexCharge one)', async () => {
    const f = await seedPosFixture()
    const itemId = await seedPosItem(f, { sellPrice: 10, chargeEligible: true })
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        items: [{ id: itemId, name: 'I', qty: 1, price: 10 }],
        paymentMethod: 'charge',
        tenantId: randomUUID(),
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/property must be selected/i)
  })

  it('XOR: tenantId AND posCustomerId both set → 400', async () => {
    const f = await seedPosFixture()
    const itemId = await seedPosItem(f, { sellPrice: 10, chargeEligible: true })
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        items: [{ id: itemId, name: 'I', qty: 1, price: 10 }],
        paymentMethod: 'charge',
        propertyId: f.propertyId,
        tenantId: randomUUID(),
        posCustomerId: randomUUID(),
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/charge account is one person's/i)
  })

  it('walk-up item (no catalog id) on FlexCharge → 400', async () => {
    const f = await seedPosFixture()
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        items: [{ name: 'Walk-up', qty: 1, price: 10 }],  // no id
        paymentMethod: 'charge',
        propertyId: f.propertyId,
        tenantId: randomUUID(),
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/every register item is one you set up/i)
  })

  it('cart contains a non-charge-eligible item → 400', async () => {
    const f = await seedPosFixture()
    const eligibleId   = await seedPosItem(f, { sellPrice: 10, chargeEligible: true })
    const ineligibleId = await seedPosItem(f, { sellPrice: 5,  chargeEligible: false })
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        items: [
          { id: eligibleId,   name: 'OK', qty: 1, price: 10 },
          { id: ineligibleId, name: 'NO', qty: 1, price: 5 },
        ],
        paymentMethod: 'charge',
        propertyId: f.propertyId,
        tenantId: randomUUID(),
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cannot go on a charge account/i)
  })

  it('no FlexCharge account at this (customer, property) → 404', async () => {
    const f = await seedPosFixture()
    const itemId = await seedPosItem(f, { sellPrice: 10, chargeEligible: true })
    getAccountForChargeMock.mockResolvedValueOnce(null)  // explicit
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        items: [{ id: itemId, name: 'I', qty: 1, price: 10 }],
        paymentMethod: 'charge',
        propertyId: f.propertyId,
        tenantId: randomUUID(),
      })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/no charge account at this property/i)
  })

  it('FlexCharge account status != active → 409', async () => {
    const f = await seedPosFixture()
    const itemId = await seedPosItem(f, { sellPrice: 10, chargeEligible: true })
    getAccountForChargeMock.mockResolvedValueOnce({
      id: 'acc_suspended', status: 'suspended', landlord_id: f.landlordId,
    })
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        items: [{ id: itemId, name: 'I', qty: 1, price: 10 }],
        paymentMethod: 'charge',
        propertyId: f.propertyId,
        tenantId: randomUUID(),
      })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/charge account is on hold/i)
  })

  it('FlexCharge account belongs to a different landlord → 403', async () => {
    const f = await seedPosFixture()
    const itemId = await seedPosItem(f, { sellPrice: 10, chargeEligible: true })
    getAccountForChargeMock.mockResolvedValueOnce({
      id: 'acc_other', status: 'active', landlord_id: randomUUID(),
    })
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        items: [{ id: itemId, name: 'I', qty: 1, price: 10 }],
        paymentMethod: 'charge',
        propertyId: f.propertyId,
        tenantId: randomUUID(),
      })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/belongs to another company/i)
  })
})

describe('POST /api/pos/transactions — guards + idempotency', () => {
  it('empty items array → 400', async () => {
    const f = await seedPosFixture()
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ items: [], paymentMethod: 'cash', propertyId: f.propertyId })
    expect(res.status).toBe(400)
    // 10/2 (front desk foolproof): plain words, and the button to press.
    expect(res.body.error).toBe('The cart is empty — add what they are buying, then press Charge again.')
  })

  // 10/2 (review): a line naming another company's item is refused outright, in
  // the clerk's words — before, the sale was written (only the victim's stock
  // decrement was gated) and the tax lookup could fail with a database error.
  it('S70 cross-landlord guard: item_id belonging to another landlord → refused, nothing written, victim stock NOT decremented', async () => {
    const f = await seedPosFixture()
    // Victim landlord owns the real item
    const victimClient = await db.connect()
    let victimItemId: string
    let victimLandlordId: string
    try {
      await victimClient.query('BEGIN')
      const { landlordId: vlId } = await seedLandlord(victimClient)
      victimLandlordId = vlId
      const vPropId = await seedProperty(victimClient, {
        landlordId: vlId,
        ownerUserId: (await victimClient.query<{ user_id: string }>(
          `SELECT user_id FROM landlords WHERE id = $1`, [vlId])).rows[0].user_id,
        managedByUserId: (await victimClient.query<{ user_id: string }>(
          `SELECT user_id FROM landlords WHERE id = $1`, [vlId])).rows[0].user_id,
      })
      const vCat = await victimClient.query<{ id: string }>(
        `INSERT INTO pos_categories (landlord_id, name, sort_order, is_active)
         VALUES ($1, 'V', 1, TRUE) RETURNING id`, [vlId])
      const vItem = await victimClient.query<{ id: string }>(
        `INSERT INTO pos_items (landlord_id, name, sell_price, stock_qty, stock_min, stock_max, property_id, category_id)
         VALUES ($1, 'V Item', 10, 50, 5, 100, $2, $3) RETURNING id`,
        [vlId, vPropId, vCat.rows[0].id])
      victimItemId = vItem.rows[0].id
      await victimClient.query('COMMIT')
    } catch (e) { await victimClient.query('ROLLBACK'); throw e }
    finally { victimClient.release() }

    // Attacker (f.landlordId) submits a transaction referencing the victim's item
    // — in capitals too, which is the same item to the database.
    for (const id of [victimItemId, victimItemId.toUpperCase()]) {
      const res = await request(buildApp())
        .post('/api/pos/transactions')
        .set('Authorization', `Bearer ${f.landlordToken}`)
        .send({
          propertyId: f.propertyId,
          items: [{ id, name: 'Stolen', qty: 5, price: 10 }],
          paymentMethod: 'cash',
        })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/not on your register any more — take it out of the cart, then press Charge again/i)
    }
    expect((await db.query(`SELECT 1 FROM pos_transactions WHERE landlord_id = $1`, [f.landlordId])).rows).toHaveLength(0)
    // Victim's stock NOT touched
    const victimItem = await db.query<{ stock_qty: number }>(
      `SELECT stock_qty FROM pos_items WHERE id = $1`, [victimItemId])
    expect(Number(victimItem.rows[0].stock_qty)).toBe(50)
    // No inventory log on the victim item
    const log = await db.query(`SELECT id FROM pos_inventory_log WHERE item_id = $1`, [victimItemId])
    expect(log.rows.length).toBe(0)
  })

  it('duplicate stripePaymentIntentId → idempotent return existing row (200, not 201)', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const itemId = await seedPosItem(f, { sellPrice: 20, stockQty: 999 })
    calculateCartTaxMock.mockResolvedValue({
      subtotal: 20, taxAmount: 0,
      lines: [{ itemId, lineSubtotal: 20, lineTax: 0 }],
    })
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_dup', status: 'succeeded', amount: withCardFee(20),
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId },
    })
    const body = {
      items: [{ id: itemId, name: 'I', qty: 1, price: 20 }],
      paymentMethod: 'card',
      stripePaymentIntentId: 'pi_dup',
      propertyId: f.propertyId,
    }

    const first = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send(body)
    expect(first.status).toBe(201)

    const second = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send(body)
    expect(second.status).toBe(200)
    expect(second.body.data.id).toBe(first.body.data.id)
    expect(second.body.message).toMatch(/already recorded/i)

    // Only one pos_transactions row exists
    const rows = await db.query(`SELECT id FROM pos_transactions WHERE landlord_id = $1`, [f.landlordId])
    expect(rows.rows.length).toBe(1)
  })

  it('terminal PI status not succeeded → 400 (PI validation gate)', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const itemId = await seedPosItem(f, { sellPrice: 10, stockQty: 999 })
    calculateCartTaxMock.mockResolvedValueOnce({
      subtotal: 10, taxAmount: 0,
      lines: [{ itemId, lineSubtotal: 10, lineTax: 0 }],
    })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_pending', status: 'requires_payment_method', amount: 1000,
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId },
    })
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId: f.propertyId,
        items: [{ id: itemId, name: 'I', qty: 1, price: 10 }],
        paymentMethod: 'card',
        stripePaymentIntentId: 'pi_pending',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not approved/i)
  })

  it('terminal PI amount mismatch → 400 (PI validation gate)', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const itemId = await seedPosItem(f, { sellPrice: 10, stockQty: 999 })
    calculateCartTaxMock.mockResolvedValueOnce({
      subtotal: 10, taxAmount: 0,
      lines: [{ itemId, lineSubtotal: 10, lineTax: 0 }],
    })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_wrong_amt', status: 'succeeded', amount: 999,  // expected 10 + card fee
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId },
    })
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId: f.propertyId,
        items: [{ id: itemId, name: 'I', qty: 1, price: 10 }],
        paymentMethod: 'card',
        stripePaymentIntentId: 'pi_wrong_amt',
      })
    expect(res.status).toBe(400)
    // 10/2: the clerk is told what happened and what to press — not two cent figures.
    expect(res.body.error).toBe('The card charge did not match the cart — nothing was taken. Press Charge again.')
    expect(captureTerminalPaymentIntentMock).not.toHaveBeenCalled()
    expect((await db.query(`SELECT 1 FROM pos_transactions WHERE landlord_id = $1`, [f.landlordId])).rows).toHaveLength(0)
  })

  it('terminal PI metadata gam_purpose != pos_terminal → 400', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const itemId = await seedPosItem(f, { sellPrice: 10, stockQty: 999 })
    calculateCartTaxMock.mockResolvedValueOnce({
      subtotal: 10, taxAmount: 0,
      lines: [{ itemId, lineSubtotal: 10, lineTax: 0 }],
    })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_wrong_purpose', status: 'succeeded', amount: 1000,
      metadata: { gam_purpose: 'rent_payment', gam_landlord_id: f.landlordId },
    })
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId: f.propertyId,
        items: [{ id: itemId, name: 'I', qty: 1, price: 10 }],
        paymentMethod: 'card',
        stripePaymentIntentId: 'pi_wrong_purpose',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not started at this register — nothing was taken\. Press Charge again/)
  })

  it('terminal PI metadata gam_landlord_id mismatch → 403', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const itemId = await seedPosItem(f, { sellPrice: 10, stockQty: 999 })
    calculateCartTaxMock.mockResolvedValueOnce({
      subtotal: 10, taxAmount: 0,
      lines: [{ itemId, lineSubtotal: 10, lineTax: 0 }],
    })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_wrong_landlord', status: 'succeeded', amount: 1000,
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: randomUUID() },
    })
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId: f.propertyId,
        items: [{ id: itemId, name: 'I', qty: 1, price: 10 }],
        paymentMethod: 'card',
        stripePaymentIntentId: 'pi_wrong_landlord',
      })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/different company — nothing was taken/)
  })
})

// ─── POST /api/pos/transactions/:id/refund (S339) ──────────────
//
// Product rule (Nic-confirmed): GAM does NOT process refunds back to
// a card via Stripe. Refunds are cash/check only at cashier discretion
// for cash + card sales. FlexCharge sales reverse on the open account
// (refund_method='charge', auto-applied). Migration tightened the
// pos_refunds_method_check from ('cash','card','charge') to
// ('cash','check','charge').

/** Seed a completed POS transaction directly (skip the full /transactions
 *  ring-up flow — we're testing the refund endpoint in isolation). */
async function seedCompletedTransaction(
  f: PosFixture,
  opts: { paymentMethod?: 'cash' | 'card' | 'charge'; total?: number } = {},
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO pos_transactions
       (landlord_id, cashier_id, payment_method, subtotal, tax_amount, total, status)
     VALUES ($1, $2, $3, $4, 0, $4, 'completed')
     RETURNING id`,
    [f.landlordId, f.landlordUserId, opts.paymentMethod ?? 'cash', opts.total ?? 50])
  return r.rows[0].id
}

describe('POST /api/pos/transactions/:id/refund', () => {
  it('cash sale refund (no method passed): defaults to cash, status → refunded', async () => {
    const f = await seedPosFixture()
    const txId = await seedCompletedTransaction(f, { paymentMethod: 'cash', total: 25 })
    const res = await request(buildApp())
      .post(`/api/pos/transactions/${txId}/refund`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ reason: 'customer changed mind' })
    expect(res.status).toBe(200)
    expect(res.body.data.refundMethod).toBe('cash')
    expect(Number(res.body.data.refundAmount)).toBe(25)
    const ref = await db.query<{ refund_method: string; amount: string }>(
      `SELECT refund_method, amount FROM pos_refunds WHERE transaction_id = $1`, [txId])
    expect(ref.rows[0].refund_method).toBe('cash')
    expect(Number(ref.rows[0].amount)).toBe(25)
    const tx = await db.query<{ status: string; refund_amount: string }>(
      `SELECT status, refund_amount FROM pos_transactions WHERE id = $1`, [txId])
    expect(tx.rows[0].status).toBe('refunded')
    expect(Number(tx.rows[0].refund_amount)).toBe(25)
  })

  it('card sale refund forces cashier-physical payout (method must be cash or check, not card)', async () => {
    const f = await seedPosFixture()
    const txId = await seedCompletedTransaction(f, { paymentMethod: 'card', total: 40 })
    const res = await request(buildApp())
      .post(`/api/pos/transactions/${txId}/refund`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ refundMethod: 'check' })
    expect(res.status).toBe(200)
    expect(res.body.data.refundMethod).toBe('check')
    const ref = await db.query<{ refund_method: string }>(
      `SELECT refund_method FROM pos_refunds WHERE transaction_id = $1`, [txId])
    expect(ref.rows[0].refund_method).toBe('check')
  })

  it('card sale refund: card refundMethod input rejected → 400', async () => {
    const f = await seedPosFixture()
    const txId = await seedCompletedTransaction(f, { paymentMethod: 'card', total: 30 })
    const res = await request(buildApp())
      .post(`/api/pos/transactions/${txId}/refund`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ refundMethod: 'card' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cash.*or.*check/i)
    const ref = await db.query(`SELECT id FROM pos_refunds WHERE transaction_id = $1`, [txId])
    expect(ref.rows.length).toBe(0)
  })

  /** Seed a FlexCharge account + originating charge for the pos_transaction.
   *  Returns the account_id and the original charge's flex_charge_transactions id. */
  async function seedFlexChargeAccountAndCharge(
    f: PosFixture,
    posTransactionId: string,
    chargeAmount: number,
  ): Promise<{ accountId: string; originalChargeId: string; tenantId: string }> {
    const tenantId = await seedRealTenant()
    const acct = await db.query<{ id: string }>(
      `INSERT INTO flex_charge_accounts
         (tenant_id, property_id, landlord_id, credit_limit, status)
       VALUES ($1, $2, $3, 500, 'active') RETURNING id`,
      [tenantId, f.propertyId, f.landlordId])
    const charge = await db.query<{ id: string }>(
      `INSERT INTO flex_charge_transactions
         (account_id, pos_transaction_id, amount, status)
       VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [acct.rows[0].id, posTransactionId, chargeAmount])
    return { accountId: acct.rows[0].id, originalChargeId: charge.rows[0].id, tenantId }
  }

  it('FlexCharge full refund: refund_method=charge, original charge preserved, reversal row inserted with -amount', async () => {
    const f = await seedPosFixture()
    const txId = await seedCompletedTransaction(f, { paymentMethod: 'charge', total: 100 })
    const { accountId, originalChargeId } = await seedFlexChargeAccountAndCharge(f, txId, 100)

    const res = await request(buildApp())
      .post(`/api/pos/transactions/${txId}/refund`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ refundMethod: 'cash', reason: 'returned item' })  // cashier input ignored, charge forced

    expect(res.status).toBe(200)
    expect(res.body.data.refundMethod).toBe('charge')

    // pos_refunds row written with method='charge'
    const ref = await db.query<{ refund_method: string; amount: string }>(
      `SELECT refund_method, amount FROM pos_refunds WHERE transaction_id = $1`, [txId])
    expect(ref.rows[0].refund_method).toBe('charge')
    expect(Number(ref.rows[0].amount)).toBe(100)

    // Original charge row UNCHANGED (audit trail posture: never mutate prior)
    const original = await db.query<{ amount: string; status: string }>(
      `SELECT amount, status FROM flex_charge_transactions WHERE id = $1`, [originalChargeId])
    expect(Number(original.rows[0].amount)).toBe(100)
    expect(original.rows[0].status).toBe('pending')

    // Reversal row inserted: same account, same pos_transaction, amount = -100, status='pending'
    const reversal = await db.query<{ id: string; account_id: string; amount: string; status: string; notes: string | null }>(
      `SELECT id, account_id, amount, status, notes FROM flex_charge_transactions
         WHERE pos_transaction_id = $1 AND amount < 0`, [txId])
    expect(reversal.rows.length).toBe(1)
    expect(reversal.rows[0].account_id).toBe(accountId)
    expect(Number(reversal.rows[0].amount)).toBe(-100)
    expect(reversal.rows[0].status).toBe('pending')
    expect(reversal.rows[0].notes).toMatch(/Refund: returned item/)

    // Account balance recomputation: SUM(amount) WHERE status IN ('pending','billed') = 100 + (-100) = 0
    const bal = await db.query<{ balance: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS balance FROM flex_charge_transactions
         WHERE account_id = $1 AND status IN ('pending','billed')`, [accountId])
    expect(Number(bal.rows[0].balance)).toBe(0)
  })

  it('FlexCharge partial refund: reversal row has -partialAmount, account balance reduced by partial', async () => {
    const f = await seedPosFixture()
    const txId = await seedCompletedTransaction(f, { paymentMethod: 'charge', total: 100 })
    const { accountId } = await seedFlexChargeAccountAndCharge(f, txId, 100)

    const res = await request(buildApp())
      .post(`/api/pos/transactions/${txId}/refund`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ amount: 30 })

    expect(res.status).toBe(200)
    expect(res.body.data.refundMethod).toBe('charge')

    const reversal = await db.query<{ amount: string }>(
      `SELECT amount FROM flex_charge_transactions WHERE pos_transaction_id = $1 AND amount < 0`, [txId])
    expect(reversal.rows.length).toBe(1)
    expect(Number(reversal.rows[0].amount)).toBe(-30)

    // Balance = 100 + (-30) = 70
    const bal = await db.query<{ balance: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS balance FROM flex_charge_transactions
         WHERE account_id = $1 AND status IN ('pending','billed')`, [accountId])
    expect(Number(bal.rows[0].balance)).toBe(70)

    // pos_transactions status is partial_refund, not refunded
    const tx = await db.query<{ status: string }>(
      `SELECT status FROM pos_transactions WHERE id = $1`, [txId])
    expect(tx.rows[0].status).toBe('partial_refund')
  })

  it('FlexCharge refund with no originating charge row → 409, atomic rollback (no pos_refunds row)', async () => {
    const f = await seedPosFixture()
    const txId = await seedCompletedTransaction(f, { paymentMethod: 'charge', total: 50 })
    // No flex_charge_transactions originating row seeded — corrupt state simulation

    const res = await request(buildApp())
      .post(`/api/pos/transactions/${txId}/refund`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/cannot be refunded here/i)

    // Atomicity: pos_refunds NOT written, pos_transactions NOT mutated
    const ref = await db.query(`SELECT id FROM pos_refunds WHERE transaction_id = $1`, [txId])
    expect(ref.rows.length).toBe(0)
    const tx = await db.query<{ status: string; refunded_at: string | null }>(
      `SELECT status, refunded_at FROM pos_transactions WHERE id = $1`, [txId])
    expect(tx.rows[0].status).toBe('completed')
    expect(tx.rows[0].refunded_at).toBeNull()
  })

  it('partial refund (amount < total) → status partial_refund', async () => {
    const f = await seedPosFixture()
    const txId = await seedCompletedTransaction(f, { paymentMethod: 'cash', total: 100 })
    const res = await request(buildApp())
      .post(`/api/pos/transactions/${txId}/refund`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ amount: 30, refundMethod: 'cash' })
    expect(res.status).toBe(200)
    expect(Number(res.body.data.refundAmount)).toBe(30)
    const tx = await db.query<{ status: string; refund_amount: string }>(
      `SELECT status, refund_amount FROM pos_transactions WHERE id = $1`, [txId])
    expect(tx.rows[0].status).toBe('partial_refund')
    expect(Number(tx.rows[0].refund_amount)).toBe(30)
  })

  it('over-refund is capped: single refund above total → 400; cumulative partials cannot exceed total (S587)', async () => {
    const f = await seedPosFixture()
    const txId = await seedCompletedTransaction(f, { paymentMethod: 'cash', total: 100 })

    // A single refund above the sale total is rejected.
    const over = await request(buildApp())
      .post(`/api/pos/transactions/${txId}/refund`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ amount: 150, refundMethod: 'cash' })
    expect(over.status).toBe(400)
    expect(over.body.error).toMatch(/more than the sale — \$100\.00 at most/i)

    // First partial of 70 succeeds (remaining 30).
    await request(buildApp()).post(`/api/pos/transactions/${txId}/refund`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ amount: 70, refundMethod: 'cash' }).expect(200)

    // A second partial of 40 exceeds the remaining 30 → 400.
    const second = await request(buildApp()).post(`/api/pos/transactions/${txId}/refund`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ amount: 40, refundMethod: 'cash' })
    expect(second.status).toBe(400)
    expect(second.body.error).toMatch(/more than is left to refund — \$30\.00 at most/i)

    // Exactly the remaining 30 succeeds and closes it out (cumulative 100 → refunded).
    await request(buildApp()).post(`/api/pos/transactions/${txId}/refund`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ amount: 30, refundMethod: 'cash' }).expect(200)
    const tx = await db.query<{ status: string; refund_amount: string }>(
      `SELECT status, refund_amount FROM pos_transactions WHERE id=$1`, [txId])
    expect(tx.rows[0].status).toBe('refunded')
    expect(Number(tx.rows[0].refund_amount)).toBe(100)  // cumulative 70 + 30
  })

  it('refund a voided transaction → 400', async () => {
    const f = await seedPosFixture()
    const txId = await seedCompletedTransaction(f, { paymentMethod: 'cash' })
    await db.query(`UPDATE pos_transactions SET status = 'voided' WHERE id = $1`, [txId])
    const res = await request(buildApp())
      .post(`/api/pos/transactions/${txId}/refund`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ refundMethod: 'cash' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/voided/i)
  })

  // 10/3 (review): a Refund that starts while a Void is committing reads the
  // sale again once it holds the row — the void already told the clerk to hand
  // the money back (and restocked), so the refund is refused and nothing is paid twice.
  it('a refund that waited behind a void reads the sale again and is refused — no refund row, the sale stays voided', async () => {
    const f = await seedPosFixture()
    const txId = await seedCompletedTransaction(f, { paymentMethod: 'cash', total: 22 })
    const other = await db.connect()
    try {
      await other.query('BEGIN')
      await other.query(`SELECT 1 FROM pos_transactions WHERE id = $1 FOR UPDATE`, [txId])
      const mine = request(buildApp()).post(`/api/pos/transactions/${txId}/refund`)
        .set('Authorization', `Bearer ${f.landlordToken}`).send({ refundMethod: 'cash', reason: 'race' }).then(r => r)
      // Wait until the refund is queued behind the void's lock.
      for (let i = 0; i < 100; i++) {
        const w = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%FROM pos_transactions WHERE id=$1 FOR UPDATE%'`)
        if (w.rows[0].n > 0) break
        await new Promise(r => setTimeout(r, 20))
      }
      await other.query(`UPDATE pos_transactions SET status = 'voided', void_reason = 'rung up wrong' WHERE id = $1`, [txId])
      await other.query('COMMIT')
      const res = await mine
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('That sale was voided, so there is nothing to refund — press Cancel.')
    } finally { other.release() }
    expect((await db.query(`SELECT id FROM pos_refunds WHERE transaction_id = $1`, [txId])).rows).toEqual([])
    const tx = await db.query<{ status: string; refund_amount: string | null; void_reason: string }>(
      `SELECT status, refund_amount, void_reason FROM pos_transactions WHERE id = $1`, [txId])
    expect(tx.rows[0]).toMatchObject({ status: 'voided', void_reason: 'rung up wrong' })
    expect(Number(tx.rows[0].refund_amount ?? 0)).toBe(0)
  })

  it('cross-landlord refund → 404 (scoped lookup)', async () => {
    const f = await seedPosFixture()
    const txId = await seedCompletedTransaction(f, { paymentMethod: 'cash' })
    const attackerClient = await db.connect()
    let attackerToken: string
    try {
      await attackerClient.query('BEGIN')
      const { userId: aUserId, landlordId: aId } = await seedLandlord(attackerClient)
      await attackerClient.query('COMMIT')
      attackerToken = jwt.sign(
        { userId: aUserId, role: 'landlord', email: 'a@x', profileId: aId, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' })
    } finally { attackerClient.release() }

    const res = await request(buildApp())
      .post(`/api/pos/transactions/${txId}/refund`)
      .set('Authorization', `Bearer ${attackerToken}`)
      .send({ refundMethod: 'cash' })
    expect(res.status).toBe(404)
  })
})

// ─── POST /api/pos/transactions/:id/void (S339) ────────────────

describe('POST /api/pos/transactions/:id/void', () => {
  it('happy path: completed tx → voided, reason persisted', async () => {
    const f = await seedPosFixture()
    const txId = await seedCompletedTransaction(f, { paymentMethod: 'cash' })
    const res = await request(buildApp())
      .post(`/api/pos/transactions/${txId}/void`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ reason: 'rung up wrong' })
    expect(res.status).toBe(200)
    const tx = await db.query<{ status: string; void_reason: string }>(
      `SELECT status, void_reason FROM pos_transactions WHERE id = $1`, [txId])
    expect(tx.rows[0].status).toBe('voided')
    expect(tx.rows[0].void_reason).toBe('rung up wrong')
  })

  it('cannot void an already-refunded transaction → 400', async () => {
    const f = await seedPosFixture()
    const txId = await seedCompletedTransaction(f, { paymentMethod: 'cash' })
    await db.query(`UPDATE pos_transactions SET status = 'refunded' WHERE id = $1`, [txId])
    const res = await request(buildApp())
      .post(`/api/pos/transactions/${txId}/void`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ reason: 'too late' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already refunded, so it cannot be voided/i)
  })

  // 10/3 (review): a void says the sale never happened — refused where money
  // really moved (a card was charged) or something rides on the sale (a pay
  // link, a stay). History offers Void only where it would go through.
  it('refuses a card or card-on-file sale, and a sale that paid a pay link or a stay — in words that point to Refund (and the schedule); History says which', async () => {
    const f = await seedPosFixture()
    const voidIt = (id: string) => request(buildApp()).post(`/api/pos/transactions/${id}/void`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ reason: 'oops' })
    const card = await seedCompletedTransaction(f, { paymentMethod: 'card' })
    const onFile = (await db.query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, total, status)
       VALUES ($1, $2, 'card_on_file', 50, 0, 50, 'completed') RETURNING id`, [f.landlordId, f.landlordUserId])).rows[0].id
    for (const id of [card, onFile]) {
      const r = await voidIt(id)
      expect(r.status).toBe(409)
      expect(r.body.error).toBe('This sale was paid by card, so it cannot be voided — the card was charged. Press Refund instead to give the money back.')
    }
    // Paid a pay link.
    const linkSale = await seedCompletedTransaction(f, { paymentMethod: 'cash' })
    const link = (await db.query<{ id: string }>(
      `INSERT INTO pos_pay_links (token, landlord_id, property_id, created_by, kind, label, items, subtotal, total, customer_email, status, pos_transaction_id)
       VALUES (md5(random()::text) || md5(random()::text), $1, $2, $3, 'one_time', 'Propane', '[]'::jsonb, 20, 20, 'p@t.dev', 'paid', $4) RETURNING id`,
      [f.landlordId, f.propertyId, f.landlordUserId, linkSale])).rows[0].id
    await db.query(`UPDATE pos_transactions SET pay_link_id = $2 WHERE id = $1`, [linkSale, link])
    const viaLink = await voidIt(linkSale)
    expect(viaLink.status).toBe(409)
    expect(viaLink.body.error).toBe('This sale paid a pay link, so it cannot be voided — press Refund to give the money back. If it paid for a stay, cancel the stay on the schedule.')
    // Paid a stay: a line that is a stay item.
    const stayItem = (await db.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, name, category_id, sell_price, cost_price, tax_rate, stock_qty, stock_min, stock_max, stay_unit)
       VALUES ($1,$2,'RV site — nightly',$3,0,0,0,999,0,999,'night') RETURNING id`, [f.landlordId, f.propertyId, f.categoryId])).rows[0].id
    const staySale = await seedCompletedTransaction(f, { paymentMethod: 'cash' })
    await db.query(`INSERT INTO pos_transaction_items (transaction_id, item_id, item_name, qty, unit_price, subtotal) VALUES ($1,$2,'RV site — nightly',1,50,50)`, [staySale, stayItem])
    const viaStay = await voidIt(staySale)
    expect(viaStay.status).toBe(409)
    expect(viaStay.body.error).toBe('This sale paid for a stay, so it cannot be voided — press Refund to give the money back, and cancel the stay on the schedule.')
    // None of them was voided; a plain cash sale still is.
    const st = await db.query<{ status: string }>(`SELECT status FROM pos_transactions WHERE id = ANY($1::uuid[])`, [[card, onFile, linkSale, staySale]])
    expect(st.rows.every((r) => r.status === 'completed')).toBe(true)
    const cash = await seedCompletedTransaction(f, { paymentMethod: 'cash' })
    // History says, sale by sale, why Void is not offered (null: it is).
    const hist = await request(buildApp()).get(`/api/pos/transactions`).set('Authorization', `Bearer ${f.landlordToken}`)
    expect(hist.status).toBe(200)
    const why = Object.fromEntries(hist.body.data.map((t: any) => [t.id, t.voidBlocked ?? t.void_blocked ?? null]))
    expect(why).toMatchObject({ [card]: 'card', [onFile]: 'card', [linkSale]: 'pay_link', [staySale]: 'stay', [cash]: null })
    expect((await voidIt(cash)).status).toBe(200)
  })

  // 10/3 (review): a charge-account sale's charge stays on the customer's
  // account (the statement run bills 'pending' rows) — voided, it would bill a
  // charge with no sale. A sale that settled a delivery ticket would leave the
  // ticket settled and the goods owed nowhere. Both point to Refund.
  it('refuses a charge-account sale (its account charge untouched) and a sale that settled a delivery ticket — History hides Void on both', async () => {
    const f = await seedPosFixture()
    const voidIt = (id: string) => request(buildApp()).post(`/api/pos/transactions/${id}/void`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ reason: 'oops' })
    const onAccount = await seedCompletedTransaction(f, { paymentMethod: 'charge', total: 40 })
    const tenantId = await seedRealTenant()
    const acct = (await db.query<{ id: string }>(
      `INSERT INTO flex_charge_accounts (tenant_id, property_id, landlord_id, credit_limit, status)
       VALUES ($1, $2, $3, 500, 'active') RETURNING id`, [tenantId, f.propertyId, f.landlordId])).rows[0].id
    await db.query(`INSERT INTO flex_charge_transactions (account_id, pos_transaction_id, amount, status) VALUES ($1, $2, 40, 'pending')`, [acct, onAccount])
    const charged = await voidIt(onAccount)
    expect(charged.status).toBe(409)
    expect(charged.body.error).toBe('This sale is on their charge account, so it cannot be voided. Press Refund instead; that takes it off their account.')
    expect((await db.query(`SELECT amount::float AS amount, status FROM flex_charge_transactions WHERE account_id = $1`, [acct])).rows)
      .toEqual([{ amount: 40, status: 'pending' }])
    // A delivery ticket settled by a cash sale.
    const ticketSale = await seedCompletedTransaction(f, { paymentMethod: 'cash', total: 30 })
    const buyer = (await db.query<{ id: string }>(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name) VALUES ($1, 'Dale', 'Delivery') RETURNING id`, [f.landlordId])).rows[0].id
    const ticket = (await db.query<{ id: string }>(
      `INSERT INTO pos_open_tickets (landlord_id, property_id, created_by, pos_customer_id, items, note, status, settled_at, settled_transaction_id)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, 'Propane to MH 4', 'settled', NOW(), $5) RETURNING id`,
      [f.landlordId, f.propertyId, f.landlordUserId, buyer, ticketSale])).rows[0].id
    await db.query(`UPDATE pos_transactions SET open_ticket_id = $2 WHERE id = $1`, [ticketSale, ticket])
    const viaTicket = await voidIt(ticketSale)
    expect(viaTicket.status).toBe(409)
    expect(viaTicket.body.error).toBe('This sale settled a delivery ticket, so it cannot be voided — the ticket stays settled. Press Refund instead to give the money back.')
    const st = await db.query<{ status: string }>(`SELECT status FROM pos_transactions WHERE id = ANY($1::uuid[])`, [[onAccount, ticketSale]])
    expect(st.rows.map((r) => r.status)).toEqual(['completed', 'completed'])
    expect((await db.query(`SELECT status FROM pos_open_tickets WHERE id = $1`, [ticket])).rows[0].status).toBe('settled')
    const hist = await request(buildApp()).get(`/api/pos/transactions`).set('Authorization', `Bearer ${f.landlordToken}`)
    const why = Object.fromEntries(hist.body.data.map((t: any) => [t.id, t.voidBlocked ?? t.void_blocked ?? null]))
    expect(why).toMatchObject({ [onAccount]: 'charge', [ticketSale]: 'ticket' })
    // Refund still takes it off their account.
    const back = await request(buildApp()).post(`/api/pos/transactions/${onAccount}/refund`).set('Authorization', `Bearer ${f.landlordToken}`).send({})
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(Number((await db.query(`SELECT COALESCE(SUM(amount),0)::text AS s FROM flex_charge_transactions WHERE account_id = $1`, [acct])).rows[0].s)).toBe(0)
  })

  it('a void puts back on the shelf what the sale took — once, by what it actually took', async () => {
    const f = await seedPosFixture()
    const itemId = await seedPosItem(f, { sellPrice: 10, stockQty: 50, stockMin: 5 })
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 30, taxAmount: 0, lines: [{ itemId, lineSubtotal: 30, lineTax: 0 }] })
    const sale = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Item', qty: 3, price: 10, tax_rate: 0, category: 'Test Cat' }], paymentMethod: 'cash', changeGiven: 0 })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    const stock = async () => Number((await db.query<{ stock_qty: string }>(`SELECT stock_qty FROM pos_items WHERE id = $1`, [itemId])).rows[0].stock_qty)
    expect(await stock()).toBe(47)
    const voidIt = () => request(buildApp()).post(`/api/pos/transactions/${sale.body.data.id}/void`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ reason: 'rung up wrong' })
    expect((await voidIt()).status).toBe(200)
    expect(await stock()).toBe(50)
    const log = await db.query<{ change_qty: string; reason: string; notes: string | null; stock_before: string; stock_after: string }>(
      `SELECT change_qty, reason, notes, stock_before, stock_after FROM pos_inventory_log WHERE reference_id = $1 ORDER BY created_at`, [sale.body.data.id])
    expect(log.rows.map((r) => [r.reason, Number(r.change_qty), Number(r.stock_before), Number(r.stock_after), r.notes]))
      .toEqual([['sale', -3, 50, 47, null], ['return', 3, 47, 50, 'Sale voided']])
    // Pressed again: refused, and nothing goes back twice.
    const again = await voidIt()
    expect(again.status).toBe(400)
    expect(again.body.error).toMatch(/already voided, so it cannot be voided/i)
    expect(await stock()).toBe(50)
    // A sale that took nothing (the shelf was at 0) puts nothing back.
    await db.query(`UPDATE pos_items SET stock_qty = 0 WHERE id = $1`, [itemId])
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 20, taxAmount: 0, lines: [{ itemId, lineSubtotal: 20, lineTax: 0 }] })
    const empty = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Item', qty: 2, price: 10, tax_rate: 0, category: 'Test Cat' }], paymentMethod: 'cash', changeGiven: 0 })
    expect(empty.status, JSON.stringify(empty.body)).toBe(201)
    expect((await request(buildApp()).post(`/api/pos/transactions/${empty.body.data.id}/void`).set('Authorization', `Bearer ${f.landlordToken}`).send({})).status).toBe(200)
    expect(await stock()).toBe(0)
  })

  it('cross-landlord void → 404 (scoped lookup)', async () => {
    const f = await seedPosFixture()
    const txId = await seedCompletedTransaction(f, { paymentMethod: 'cash' })
    const attackerClient = await db.connect()
    let attackerToken: string
    try {
      await attackerClient.query('BEGIN')
      const { userId: aUserId, landlordId: aId } = await seedLandlord(attackerClient)
      await attackerClient.query('COMMIT')
      attackerToken = jwt.sign(
        { userId: aUserId, role: 'landlord', email: 'a@x', profileId: aId, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' })
    } finally { attackerClient.release() }

    const res = await request(buildApp())
      .post(`/api/pos/transactions/${txId}/void`)
      .set('Authorization', `Bearer ${attackerToken}`)
    expect(res.status).toBe(404)
  })
})

// ─── EOD reconciliation (S342) ─────────────────────────────────
//
// Service: posEod.ts. Sums pos_transactions + pos_refunds within the
// Phoenix-local business day window, upserts pos_eod_settlements.
//
// S342 fix-it-right: after S339 added 'check' as a refund_method,
// the EOD service still only summed cash/card/charge — check refunds
// vanished from settlements. Migration added the column, service
// now computes it. The cash drawer math (drawer_expected =
// opening_float + cash_sales - cash_refunds) stays unchanged —
// check refunds come from the checkbook, not the drawer.

/** Seed a completed POS transaction stamped with a specific created_at
 *  (Phoenix-local day). Lets us pin txns to a known business day for
 *  the EOD window math. */
async function seedTxOnDay(
  f: PosFixture,
  isoDate: string,  // 'YYYY-MM-DD'
  opts: { paymentMethod?: 'cash' | 'card' | 'charge'; total?: number; taxAmount?: number; surcharge?: number; status?: 'completed' | 'voided' | 'refunded' } = {},
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO pos_transactions
       (landlord_id, cashier_id, payment_method, subtotal, tax_amount, surcharge, total, status, created_at, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ($9 || ' 12:00:00 America/Phoenix')::timestamptz, $10)
     RETURNING id`,
    [f.landlordId, f.landlordUserId, opts.paymentMethod ?? 'cash',
     opts.total ?? 0, opts.taxAmount ?? 0, opts.surcharge ?? 0,
     opts.total ?? 0, opts.status ?? 'completed', isoDate, f.propertyId])
  return r.rows[0].id
}

/** Seed a pos_refunds row on a specific Phoenix-local day. */
async function seedRefundOnDay(
  f: PosFixture,
  isoDate: string,
  transactionId: string,
  refundMethod: 'cash' | 'check' | 'charge',
  amount: number,
): Promise<void> {
  await db.query(
    `INSERT INTO pos_refunds (transaction_id, landlord_id, amount, refund_method, created_at)
     VALUES ($1, $2, $3, $4, ($5 || ' 12:00:00 America/Phoenix')::timestamptz)`,
    [transactionId, f.landlordId, amount, refundMethod, isoDate])
}

describe('GET /api/pos/eod — list recent settlements', () => {
  it('returns landlord-scoped settlements ordered by business_day DESC, limit cap 90', async () => {
    const f = await seedPosFixture()
    // Seed three settlements on three different days, oldest first
    for (const day of ['2026-05-20', '2026-05-21', '2026-05-22']) {
      const { generateEodSettlement } = await import('../services/posEod')
      await generateEodSettlement(f.landlordId, f.propertyId, day, { status: 'auto_closed' })
    }
    const res = await request(buildApp())
      .get('/api/pos/eod')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(3)
    // DESC by business_day → 22, 21, 20
    expect(res.body.data.map((r: any) => r.business_day.slice(0, 10)))
      .toEqual(['2026-05-22', '2026-05-21', '2026-05-20'])
  })

  it('limit query param accepted; max cap 90', async () => {
    const f = await seedPosFixture()
    const { generateEodSettlement } = await import('../services/posEod')
    await generateEodSettlement(f.landlordId, f.propertyId, '2026-05-22', { status: 'auto_closed' })
    // limit=200 should clamp to 90 (verified by route at line 1193)
    const res = await request(buildApp())
      .get('/api/pos/eod?limit=200')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    // Just one row exists so can't truly assert 90; but verify the route
    // doesn't error on a high limit value.
    expect(res.body.data.length).toBe(1)
  })
})

describe('GET /api/pos/eod/:date — single settlement', () => {
  it('rejects malformed date → 400', async () => {
    const f = await seedPosFixture()
    const res = await request(buildApp())
      .get('/api/pos/eod/not-a-date')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/YYYY-MM-DD/i)
  })

  it('404 when no settlement exists for that date', async () => {
    const f = await seedPosFixture()
    const res = await request(buildApp())
      .get('/api/pos/eod/2026-05-22')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(404)
  })

  it('happy: returns the settlement row', async () => {
    const f = await seedPosFixture()
    const { generateEodSettlement } = await import('../services/posEod')
    await generateEodSettlement(f.landlordId, f.propertyId, '2026-05-22', { status: 'auto_closed' })
    const res = await request(buildApp())
      .get('/api/pos/eod/2026-05-22')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    // W-12: per-property settlements → the day endpoint returns an array
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].business_day.slice(0, 10)).toBe('2026-05-22')
    expect(res.body.data[0].status).toBe('auto_closed')
    expect(res.body.data[0].property_id).toBe(f.propertyId)
  })
})

describe('POST /api/pos/eod/close — manual close with drawer count', () => {
  it('rejects missing businessDay → 400', async () => {
    const f = await seedPosFixture()
    const res = await request(buildApp())
      .post('/api/pos/eod/close')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, cashDrawerActual: 100 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/businessDay/i)
  })

  it('rejects missing cashDrawerActual → 400', async () => {
    const f = await seedPosFixture()
    const res = await request(buildApp())
      .post('/api/pos/eod/close')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, businessDay: '2026-05-22' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cashDrawerActual/i)
  })

  it('happy: sums cash/card/charge sales + cash/check/charge refunds, drawer variance computed', async () => {
    const f = await seedPosFixture()
    // Three sales on 2026-05-22
    const cashTxId   = await seedTxOnDay(f, '2026-05-22', { paymentMethod: 'cash',   total: 100, taxAmount: 8, surcharge: 0 })
    const cardTxId   = await seedTxOnDay(f, '2026-05-22', { paymentMethod: 'card',   total: 50,  taxAmount: 4, surcharge: 0 })
    await seedTxOnDay(f, '2026-05-22', { paymentMethod: 'charge', total: 75 })
    // Three refunds spanning all three method types (S342 check coverage)
    await seedRefundOnDay(f, '2026-05-22', cashTxId, 'cash',   20)
    await seedRefundOnDay(f, '2026-05-22', cardTxId, 'check',  15)  // card sale refunded via check
    const chargeTxId = await seedTxOnDay(f, '2026-05-22', { paymentMethod: 'charge', total: 30 })
    await seedRefundOnDay(f, '2026-05-22', chargeTxId, 'charge', 10)

    const res = await request(buildApp())
      .post('/api/pos/eod/close')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId: f.propertyId,
        businessDay: '2026-05-22',
        cashDrawerActual: 175,
        openingFloat: 100,
        notes: 'Friday close',
      })

    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('manually_closed')
    expect(res.body.data.cashSales).toBe(100)
    expect(res.body.data.cardSales).toBe(50)
    expect(res.body.data.chargeSales).toBe(105)  // 75 + 30
    expect(res.body.data.cashRefunds).toBe(20)
    expect(res.body.data.checkRefunds).toBe(15)
    expect(res.body.data.chargeRefunds).toBe(10)
    expect(res.body.data.cardRefunds).toBe(0)  // S339: 'card' refund_method removed
    // drawer_expected = opening_float + cash_sales - cash_refunds = 100 + 100 - 20 = 180
    expect(res.body.data.drawerExpected).toBe(180)
    // drawer_actual = 175 → variance = -5 (short)
    expect(res.body.data.drawerActual).toBe(175)
    expect(res.body.data.drawerVariance).toBe(-5)
    expect(res.body.data.txCount).toBe(4)
    expect(res.body.data.refundCount).toBe(3)
  })

  it('re-running for same day updates totals (upsert via UNIQUE(landlord_id, business_day))', async () => {
    const f = await seedPosFixture()
    await seedTxOnDay(f, '2026-05-22', { paymentMethod: 'cash', total: 50 })
    // First close
    await request(buildApp())
      .post('/api/pos/eod/close')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, businessDay: '2026-05-22', cashDrawerActual: 50, openingFloat: 0 })

    // Late-arriving sale on same day
    await seedTxOnDay(f, '2026-05-22', { paymentMethod: 'cash', total: 30 })
    // Re-close picks up the new sale
    const res = await request(buildApp())
      .post('/api/pos/eod/close')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, businessDay: '2026-05-22', cashDrawerActual: 80, openingFloat: 0 })
    expect(res.status).toBe(200)
    expect(res.body.data.cashSales).toBe(80)
    expect(res.body.data.txCount).toBe(2)
    // Still one settlement row, not two
    const rows = await db.query(`SELECT id FROM pos_eod_settlements WHERE landlord_id = $1`, [f.landlordId])
    expect(rows.rows.length).toBe(1)
  })

  it('only counts txns in the Phoenix-local day window', async () => {
    const f = await seedPosFixture()
    // 2026-05-22 sale
    await seedTxOnDay(f, '2026-05-22', { paymentMethod: 'cash', total: 100 })
    // 2026-05-21 sale — should NOT count in 2026-05-22 settlement
    await seedTxOnDay(f, '2026-05-21', { paymentMethod: 'cash', total: 999 })

    const res = await request(buildApp())
      .post('/api/pos/eod/close')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, businessDay: '2026-05-22', cashDrawerActual: 100, openingFloat: 0 })
    expect(res.status).toBe(200)
    expect(res.body.data.cashSales).toBe(100)  // only the 22nd
    expect(res.body.data.txCount).toBe(1)
  })
})

describe('POST /api/pos/eod/regenerate — re-derive + reopened', () => {
  it('rejects missing businessDay → 400', async () => {
    const f = await seedPosFixture()
    const res = await request(buildApp())
      .post('/api/pos/eod/regenerate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId,})
    expect(res.status).toBe(400)
  })

  it('re-derives the settlement and flips status to reopened', async () => {
    const f = await seedPosFixture()
    await seedTxOnDay(f, '2026-05-22', { paymentMethod: 'cash', total: 50 })
    // Initial close
    await request(buildApp())
      .post('/api/pos/eod/close')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, businessDay: '2026-05-22', cashDrawerActual: 50, openingFloat: 0 })

    // Late refund added after the close
    await seedRefundOnDay(f, '2026-05-22', (await db.query<{ id: string }>(
      `SELECT id FROM pos_transactions WHERE landlord_id = $1`, [f.landlordId])).rows[0].id, 'cash', 10)

    // Regenerate to pick up the late refund
    const res = await request(buildApp())
      .post('/api/pos/eod/regenerate')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, businessDay: '2026-05-22' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('reopened')
    expect(res.body.data.cashRefunds).toBe(10)
    // DB row reflects the reopened status flip
    const row = await db.query<{ status: string; cash_refunds: string }>(
      `SELECT status, cash_refunds FROM pos_eod_settlements
        WHERE landlord_id = $1 AND business_day = $2`,
      [f.landlordId, '2026-05-22'])
    expect(row.rows[0].status).toBe('reopened')
    expect(Number(row.rows[0].cash_refunds)).toBe(10)
  })
})

// ─── POS sessions (S343) ───────────────────────────────────────
//
// pos_sessions is the server-of-record cart state for POS terminals
// (replaced the client-side useState cart at S263). Each session is
// `open` until the cashier either /complete's it (links it to a
// committed pos_transactions row) or /void's it (abandoned cart).
//
// Endpoint surface:
//   POST   /sessions                            open
//   GET    /sessions                            list (status + property filter)
//   GET    /sessions/:id                        single + items
//   PATCH  /sessions/:id                        edit customer/discount/notes
//   POST   /sessions/:id/items                  add line item
//   PATCH  /sessions/:id/items/:itemId          edit qty/price/notes
//   DELETE /sessions/:id/items/:itemId          remove line
//   POST   /sessions/:id/void                   abandon
//   POST   /sessions/:id/complete               link to txn + close
//
// Totals (subtotal, tax_amount, total) are recomputed via
// recomputeSessionTotals after every item mutation + discount edit.

/** Seed an open pos_sessions row directly (skip POST /sessions plumbing). */
async function seedOpenSession(
  f: PosFixture,
  opts: { discountAmount?: number } = {},
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO pos_sessions
       (property_id, landlord_id, opened_by_user_id, discount_amount)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [f.propertyId, f.landlordId, f.landlordUserId, opts.discountAmount ?? 0])
  return r.rows[0].id
}

describe('POST /api/pos/sessions', () => {
  it('happy: opens session stamped with property + opened_by + zeros', async () => {
    const f = await seedPosFixture()
    const res = await request(buildApp())
      .post('/api/pos/sessions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, notes: 'Friday morning' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('open')
    expect(res.body.data.property_id).toBe(f.propertyId)
    expect(res.body.data.opened_by_user_id).toBe(f.landlordUserId)
    expect(Number(res.body.data.subtotal)).toBe(0)
    expect(Number(res.body.data.total)).toBe(0)
    expect(res.body.data.notes).toBe('Friday morning')
  })

  it('rejects missing propertyId → 400', async () => {
    const f = await seedPosFixture()
    const res = await request(buildApp())
      .post('/api/pos/sessions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Pick the property at the top of the register/i)
  })

  it('rejects property belonging to another landlord → 403', async () => {
    const f = await seedPosFixture()
    const attackerClient = await db.connect()
    let attackerPropertyId: string
    try {
      await attackerClient.query('BEGIN')
      const { userId: vUid, landlordId: vLid } = await seedLandlord(attackerClient)
      attackerPropertyId = await seedProperty(attackerClient, {
        landlordId: vLid, ownerUserId: vUid, managedByUserId: vUid,
      })
      await attackerClient.query('COMMIT')
    } finally { attackerClient.release() }

    const res = await request(buildApp())
      .post('/api/pos/sessions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: attackerPropertyId })
    expect(res.status).toBe(403)
  })

  it('rejects both tenantId + posCustomerId set (XOR) → 400', async () => {
    const f = await seedPosFixture()
    const res = await request(buildApp())
      .post('/api/pos/sessions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, tenantId: randomUUID(), posCustomerId: randomUUID() })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/A cart is for one person/i)
  })
})

describe('GET /api/pos/sessions — list', () => {
  it('returns landlord-scoped open sessions with item_count', async () => {
    const f = await seedPosFixture()
    const s1 = await seedOpenSession(f)
    const s2 = await seedOpenSession(f)
    // Add 2 items to s1
    await db.query(
      `INSERT INTO pos_session_items (session_id, item_name, qty, unit_price, subtotal)
       VALUES ($1, 'A', 1, 5, 5), ($1, 'B', 2, 3, 6)`, [s1])

    const res = await request(buildApp())
      .get('/api/pos/sessions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(2)
    const byId = Object.fromEntries(res.body.data.map((r: any) => [r.id, r]))
    expect(byId[s1].item_count).toBe(2)
    expect(byId[s2].item_count).toBe(0)
  })
})

describe('GET /api/pos/sessions/:id — single + items', () => {
  it('happy: returns session + items', async () => {
    const f = await seedPosFixture()
    const sId = await seedOpenSession(f)
    await db.query(
      `INSERT INTO pos_session_items (session_id, item_name, qty, unit_price, subtotal)
       VALUES ($1, 'Coffee', 2, 4, 8)`, [sId])
    const res = await request(buildApp())
      .get(`/api/pos/sessions/${sId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.session.id).toBe(sId)
    expect(res.body.data.items.length).toBe(1)
    expect(res.body.data.items[0].item_name).toBe('Coffee')
  })

  it('cross-landlord → 404 (scoped lookup)', async () => {
    const f = await seedPosFixture()
    const sId = await seedOpenSession(f)
    const attackerClient = await db.connect()
    let attackerToken: string
    try {
      await attackerClient.query('BEGIN')
      const { userId: aUid, landlordId: aLid } = await seedLandlord(attackerClient)
      await attackerClient.query('COMMIT')
      attackerToken = jwt.sign(
        { userId: aUid, role: 'landlord', email: 'a@x', profileId: aLid, permissions: {} },
        process.env.JWT_SECRET!, { expiresIn: '1h' })
    } finally { attackerClient.release() }
    const res = await request(buildApp())
      .get(`/api/pos/sessions/${sId}`)
      .set('Authorization', `Bearer ${attackerToken}`)
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/pos/sessions/:id — discount / notes', () => {
  it('discountAmount update recomputes total (subtotal + tax - discount)', async () => {
    const f = await seedPosFixture()
    const sId = await seedOpenSession(f)
    // Seed an item: 2 @ $10, 10% tax → subtotal 20, tax 2, total 22
    await db.query(
      `INSERT INTO pos_session_items (session_id, item_name, qty, unit_price, tax_rate, subtotal)
       VALUES ($1, 'X', 2, 10, 0.10, 20)`, [sId])
    // Pre-compute once so subtotals are populated
    await request(buildApp()).patch(`/api/pos/sessions/${sId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ notes: 'init' })

    // Now apply a $5 discount
    const res = await request(buildApp())
      .patch(`/api/pos/sessions/${sId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ discountAmount: 5 })
    expect(res.status).toBe(200)
    const row = await db.query<{ subtotal: string; tax_amount: string; discount_amount: string; total: string }>(
      `SELECT subtotal, tax_amount, discount_amount, total FROM pos_sessions WHERE id = $1`, [sId])
    expect(Number(row.rows[0].subtotal)).toBe(20)
    expect(Number(row.rows[0].tax_amount)).toBe(2)
    expect(Number(row.rows[0].discount_amount)).toBe(5)
    expect(Number(row.rows[0].total)).toBe(17)  // 20 + 2 - 5
  })

  it('non-open session → 409', async () => {
    const f = await seedPosFixture()
    const sId = await seedOpenSession(f)
    await db.query(`UPDATE pos_sessions SET status = 'voided' WHERE id = $1`, [sId])
    const res = await request(buildApp())
      .patch(`/api/pos/sessions/${sId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ notes: 'late' })
    expect(res.status).toBe(409)
  })

  it('negative discountAmount → 400', async () => {
    const f = await seedPosFixture()
    const sId = await seedOpenSession(f)
    const res = await request(buildApp())
      .patch(`/api/pos/sessions/${sId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ discountAmount: -1 })
    expect(res.status).toBe(400)
  })
})

describe('Session items: add / patch / delete + recompute', () => {
  it('POST adds line item, recomputes session totals', async () => {
    const f = await seedPosFixture()
    const sId = await seedOpenSession(f)
    const res = await request(buildApp())
      .post(`/api/pos/sessions/${sId}/items`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ itemId: await seedPosItem(f, { sellPrice: 5, stockQty: 999 }), itemName: 'Burger', qty: 2, unitPrice: 5, taxRate: 0.08 })
    expect(res.status).toBe(200)
    const sess = await db.query<{ subtotal: string; tax_amount: string; total: string }>(
      `SELECT subtotal, tax_amount, total FROM pos_sessions WHERE id = $1`, [sId])
    expect(Number(sess.rows[0].subtotal)).toBe(10)
    expect(Number(sess.rows[0].tax_amount)).toBe(0.80)
    expect(Number(sess.rows[0].total)).toBe(10.80)
  })

  it('POST rejects qty <= 0 → 400', async () => {
    const f = await seedPosFixture()
    const sId = await seedOpenSession(f)
    const res = await request(buildApp())
      .post(`/api/pos/sessions/${sId}/items`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ itemId: await seedPosItem(f, { sellPrice: 5, stockQty: 999 }), itemName: 'X', qty: 0, unitPrice: 5 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/quantity above zero/i)
  })

  it('PATCH updates qty, refreshes line subtotal + session total', async () => {
    const f = await seedPosFixture()
    const sId = await seedOpenSession(f)
    // Add via API to ensure session totals start populated
    const add = await request(buildApp())
      .post(`/api/pos/sessions/${sId}/items`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ itemId: await seedPosItem(f, { sellPrice: 10, stockQty: 999 }), itemName: 'X', qty: 1, unitPrice: 10 })
    const itemId = add.body.data.id

    const res = await request(buildApp())
      .patch(`/api/pos/sessions/${sId}/items/${itemId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ qty: 3 })
    expect(res.status).toBe(200)
    const item = await db.query<{ qty: string; subtotal: string }>(
      `SELECT qty, subtotal FROM pos_session_items WHERE id = $1`, [itemId])
    expect(Number(item.rows[0].qty)).toBe(3)
    expect(Number(item.rows[0].subtotal)).toBe(30)  // qty * unit_price
    const sess = await db.query<{ subtotal: string; total: string }>(
      `SELECT subtotal, total FROM pos_sessions WHERE id = $1`, [sId])
    expect(Number(sess.rows[0].subtotal)).toBe(30)
    expect(Number(sess.rows[0].total)).toBe(30)
  })

  it('DELETE removes line, recomputes session total to 0', async () => {
    const f = await seedPosFixture()
    const sId = await seedOpenSession(f)
    const add = await request(buildApp())
      .post(`/api/pos/sessions/${sId}/items`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ itemId: await seedPosItem(f, { sellPrice: 10, stockQty: 999 }), itemName: 'X', qty: 1, unitPrice: 10 })
    const itemId = add.body.data.id

    const res = await request(buildApp())
      .delete(`/api/pos/sessions/${sId}/items/${itemId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    const items = await db.query(`SELECT id FROM pos_session_items WHERE session_id = $1`, [sId])
    expect(items.rows.length).toBe(0)
    const sess = await db.query<{ total: string }>(
      `SELECT total FROM pos_sessions WHERE id = $1`, [sId])
    expect(Number(sess.rows[0].total)).toBe(0)
  })
})

describe('POST /api/pos/sessions/:id/void', () => {
  it('voids an open session with reason; sets closed_at', async () => {
    const f = await seedPosFixture()
    const sId = await seedOpenSession(f)
    const res = await request(buildApp())
      .post(`/api/pos/sessions/${sId}/void`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ reason: 'customer left' })
    expect(res.status).toBe(200)
    const sess = await db.query<{ status: string; void_reason: string; closed_at: string | null }>(
      `SELECT status, void_reason, closed_at FROM pos_sessions WHERE id = $1`, [sId])
    expect(sess.rows[0].status).toBe('voided')
    expect(sess.rows[0].void_reason).toBe('customer left')
    expect(sess.rows[0].closed_at).toBeTruthy()
  })

  it('non-open session → 404 (scoped to status=open)', async () => {
    const f = await seedPosFixture()
    const sId = await seedOpenSession(f)
    await db.query(`UPDATE pos_sessions SET status = 'completed' WHERE id = $1`, [sId])
    const res = await request(buildApp())
      .post(`/api/pos/sessions/${sId}/void`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(404)
  })
})

describe('POST /api/pos/sessions/:id/complete', () => {
  it('happy: links transactionId, flips to completed, stamps closed_at', async () => {
    const f = await seedPosFixture()
    const sId = await seedOpenSession(f)
    const txId = await seedCompletedTransaction(f, { paymentMethod: 'cash', total: 50 })
    const res = await request(buildApp())
      .post(`/api/pos/sessions/${sId}/complete`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ transactionId: txId })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('completed')
    expect(res.body.data.completed_transaction_id).toBe(txId)
    expect(res.body.data.closed_at).toBeTruthy()
  })

  // 10/2: another company's sale does not exist to this register — 404, in the clerk's words.
  it('cross-landlord transactionId → 404 (defense against malicious cashier)', async () => {
    const f = await seedPosFixture()
    const sId = await seedOpenSession(f)
    // Seed a transaction owned by a different landlord
    const otherClient = await db.connect()
    let otherTxId: string
    try {
      await otherClient.query('BEGIN')
      const { userId: oUid, landlordId: oLid } = await seedLandlord(otherClient)
      const txRes = await otherClient.query<{ id: string }>(
        `INSERT INTO pos_transactions
           (landlord_id, cashier_id, payment_method, subtotal, tax_amount, total, status)
         VALUES ($1, $2, 'cash', 10, 0, 10, 'completed')
         RETURNING id`, [oLid, oUid])
      otherTxId = txRes.rows[0].id
      await otherClient.query('COMMIT')
    } finally { otherClient.release() }

    const res = await request(buildApp())
      .post(`/api/pos/sessions/${sId}/complete`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ transactionId: otherTxId })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not on this register/i)
    // Session remains open — no side effects
    const sess = await db.query<{ status: string }>(
      `SELECT status FROM pos_sessions WHERE id = $1`, [sId])
    expect(sess.rows[0].status).toBe('open')
  })

  it('idempotent: re-call with same transactionId returns success', async () => {
    const f = await seedPosFixture()
    const sId = await seedOpenSession(f)
    const txId = await seedCompletedTransaction(f, { paymentMethod: 'cash', total: 50 })
    // First call
    await request(buildApp())
      .post(`/api/pos/sessions/${sId}/complete`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ transactionId: txId })
    // Second call with same txId → should still 200 (idempotent)
    const res = await request(buildApp())
      .post(`/api/pos/sessions/${sId}/complete`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ transactionId: txId })
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(sId)
    expect(res.body.data.completed_transaction_id).toBe(txId)
  })
})

// ─── POS Terminal — Stripe Terminal hardware path (S345) ───────
//
// All Stripe Terminal API calls fire under the landlord's Connect
// account. Routes here are mostly thin wrappers over the posTerminal
// service; tests focus on the load-bearing gates:
//   - getLandlordConnectId (409 when no Connect account onboarded)
//   - Cross-landlord property checks (POST /readers, POST /pi)
//   - Reader ownership checks (POST /pi/:id/process)
//   - PI metadata.gam_landlord_id check (GET /pi/:id)
//
// All Stripe calls are mocked via the posTerminal service mocks set
// up at the top of this file.

/** Seed a registered terminal reader for the landlord at their property. */
async function seedTerminalReader(
  f: PosFixture,
  opts: { stripeReaderId?: string; status?: 'active' | 'archived' } = {},
): Promise<{ id: string; stripeReaderId: string }> {
  const stripeReaderId = opts.stripeReaderId ?? `tmr_${randomUUID().slice(0, 8)}`
  const r = await db.query<{ id: string }>(
    `INSERT INTO pos_terminal_readers
       (landlord_id, property_id, stripe_reader_id, nickname, status)
     VALUES ($1, $2, $3, 'Front desk', $4) RETURNING id`,
    [f.landlordId, f.propertyId, stripeReaderId, opts.status ?? 'active'])
  return { id: r.rows[0].id, stripeReaderId }
}

describe('POST /api/pos/terminal/connection-token', () => {
  it('happy: returns secret from createConnectionToken', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const res = await request(buildApp())
      .post('/api/pos/terminal/connection-token')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.secret).toBe('pst_mock_secret')
    expect(createConnectionTokenMock).toHaveBeenCalledWith(undefined)
  })

  // S648: readers live on GAM's account, one location per property.
  it('scoped to the register\'s property; another landlord\'s property → 400', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const ok = await request(buildApp())
      .post('/api/pos/terminal/connection-token')
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ propertyId: f.propertyId })
    expect(ok.status).toBe(200)
    expect(createConnectionTokenMock).toHaveBeenLastCalledWith(f.propertyId)
    const g = await seedPosFixture()
    const bad = await request(buildApp())
      .post('/api/pos/terminal/connection-token')
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ propertyId: g.propertyId })
    expect(bad.status).toBe(400)
  })
})

describe('POST /api/pos/terminal/readers', () => {
  it('happy: calls registerReader with sanitized inputs, returns 201', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const res = await request(buildApp())
      .post('/api/pos/terminal/readers')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId:       f.propertyId,
        registrationCode: '  abcd-efgh  ',
        nickname:         '  Front Desk  ',
        label:            '  primary  ',
      })
    expect(res.status).toBe(201)
    const arg = (registerReaderMock.mock.calls as any[][])[0]![0] as any
    expect(arg.landlordId).toBe(f.landlordId)
    expect(arg.propertyId).toBe(f.propertyId)
    expect(arg.registrationCode).toBe('abcd-efgh')  // trimmed
    expect(arg.nickname).toBe('Front Desk')
    expect(arg.label).toBe('primary')
  })

  it('no payout account → 409: the landlord\'s share would have nowhere to go', async () => {
    const f = await seedPosFixture()
    const res = await request(buildApp())
      .post('/api/pos/terminal/readers')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, registrationCode: 'abc', nickname: 'X' })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/payout account/i)
    expect(registerReaderMock).not.toHaveBeenCalled()
  })

  it('missing registrationCode → 400, no service call', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const res = await request(buildApp())
      .post('/api/pos/terminal/readers')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, nickname: 'X' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/registrationCode/i)
    expect(registerReaderMock).not.toHaveBeenCalled()
  })

  it('cross-landlord property → 400, no service call', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    // Seed another landlord + property; pass that propertyId
    const otherClient = await db.connect()
    let otherPropertyId: string
    try {
      await otherClient.query('BEGIN')
      const { userId: oUid, landlordId: oLid } = await seedLandlord(otherClient)
      otherPropertyId = await seedProperty(otherClient, {
        landlordId: oLid, ownerUserId: oUid, managedByUserId: oUid,
      })
      await otherClient.query('COMMIT')
    } finally { otherClient.release() }

    const res = await request(buildApp())
      .post('/api/pos/terminal/readers')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: otherPropertyId, registrationCode: 'abc', nickname: 'X' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/does not belong to this landlord/i)
    expect(registerReaderMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/pos/terminal/readers', () => {
  it('calls listReaders with landlord + optional propertyId filter', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    listReadersMock.mockResolvedValueOnce([
      { id: 'rd1', stripe_reader_id: 'tmr_1', nickname: 'N1', property_id: f.propertyId } as any,
    ])
    const res = await request(buildApp())
      .get(`/api/pos/terminal/readers?propertyId=${f.propertyId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(listReadersMock).toHaveBeenCalledWith(f.landlordId, f.propertyId)
    expect(res.body.data.length).toBe(1)
  })
})

describe('DELETE /api/pos/terminal/readers/:id', () => {
  it('calls archiveReader with landlord-scoped id', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const readerId = randomUUID()
    const res = await request(buildApp())
      .delete(`/api/pos/terminal/readers/${readerId}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(archiveReaderMock).toHaveBeenCalledWith(f.landlordId, readerId)
    expect(res.body.data.status).toBe('archived')
  })
})

describe('POST /api/pos/terminal/payment-intents', () => {
  // S648 (Nic): the reader charges the cart plus the card fee, priced by the
  // server from the cart — the register no longer sends an amount.
  it('refuses a charge with no cart', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const res = await request(buildApp())
      .post('/api/pos/terminal/payment-intents')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ amountCents: 1500, propertyId: f.propertyId })
    expect(res.status).toBe(400)
    expect(createCardPresentPaymentIntentMock).not.toHaveBeenCalled()
  })

  it('cross-landlord property → 400', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const otherClient = await db.connect()
    let otherPropertyId: string
    try {
      await otherClient.query('BEGIN')
      const { userId: oUid, landlordId: oLid } = await seedLandlord(otherClient)
      otherPropertyId = await seedProperty(otherClient, {
        landlordId: oLid, ownerUserId: oUid, managedByUserId: oUid,
      })
      await otherClient.query('COMMIT')
    } finally { otherClient.release() }
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 0, taxAmount: 0, lines: [] })
    const res = await request(buildApp())
      .post('/api/pos/terminal/payment-intents')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ items: [{ id: null, name: 'Coffee', qty: 1, price: 10 }], propertyId: otherPropertyId })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/does not belong to this landlord/i)
    expect(createCardPresentPaymentIntentMock).not.toHaveBeenCalled()
  })

  it('S648: a property that absorbs the fee charges the cart alone; GAM\'s fee still comes out', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    await db.query(`UPDATE properties SET register_card_fee_payer = 'landlord' WHERE id = $1`, [f.propertyId])
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 0, taxAmount: 0, lines: [] })
    const res = await request(buildApp())
      .post('/api/pos/terminal/payment-intents')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ items: [{ id: null, name: 'Propane', qty: 1, price: 20 }], propertyId: f.propertyId })
    expect(res.status).toBe(201)
    const arg = (createCardPresentPaymentIntentMock.mock.calls as any[][])[0]![0] as any
    expect(arg.amountCents).toBe(2000)
    expect(arg.cardFeeCents).toBe(Math.round(processingFeeFor({ amount: 20, paymentMethod: 'card' }) * 100))
    expect(res.body.data.cardFee).toBe(0)
  })

  it('charges the cart plus the card fee, and the fee is GAM\'s', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 0, taxAmount: 0, lines: [] })
    const res = await request(buildApp())
      .post('/api/pos/terminal/payment-intents')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ items: [{ id: null, name: 'Coffee + bagel', qty: 1, price: 15 }], propertyId: f.propertyId, description: 'Coffee + bagel' })
    expect(res.status).toBe(201)
    expect(res.body.data.id).toBe('pi_card_mock')
    expect(res.body.data.clientSecret).toBe('pi_card_mock_secret')
    const arg = (createCardPresentPaymentIntentMock.mock.calls as any[][])[0]![0] as any
    const fee = processingFeeFor({ amount: 15, paymentMethod: 'card' })
    expect(arg.amountCents).toBe(withCardFee(15))
    expect(arg.cardFeeCents).toBe(Math.round(fee * 100))
    expect(arg.landlordId).toBe(f.landlordId)
    expect(arg.description).toBe('Coffee + bagel')
  })
})

describe('GET /api/pos/terminal/payment-intents/:id', () => {
  // S654: a charge that is not yours does not exist to you — 404, not a 403
  // that confirms it is someone else's.
  it('cross-landlord metadata → 404', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_other', status: 'succeeded', amount: 500,
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: randomUUID() },
      last_payment_error: null,
    } as any)
    const res = await request(buildApp())
      .get('/api/pos/terminal/payment-intents/pi_other')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not one of this register's — press Charge again/i)
  })

  it('happy: returns id + status + amount + lastPaymentError', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_ok', status: 'requires_capture', amount: 2500,
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId },
      last_payment_error: { message: 'card declined retried' },
    } as any)
    const res = await request(buildApp())
      .get('/api/pos/terminal/payment-intents/pi_ok')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe('pi_ok')
    expect(res.body.data.status).toBe('requires_capture')
    expect(res.body.data.amount).toBe(2500)
    expect(res.body.data.lastPaymentError).toBe('card declined retried')
  })
})

describe('POST /api/pos/terminal/payment-intents/:id/process', () => {
  it('missing stripeReaderId → 400', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const res = await request(buildApp())
      .post('/api/pos/terminal/payment-intents/pi_x/process')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({})
    expect(res.status).toBe(400)
    expect(processPaymentIntentOnReaderMock).not.toHaveBeenCalled()
  })

  it('reader not paired to the sale\'s company → 404', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    // S654: the company comes from the charge; the reader must be paired to it.
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_x', status: 'requires_payment_method', amount: 500,
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId, gam_property_id: f.propertyId },
    } as any)
    // No reader seeded for this company
    const res = await request(buildApp())
      .post('/api/pos/terminal/payment-intents/pi_x/process')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ stripeReaderId: 'tmr_ghost' })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not paired/i)
    expect(processPaymentIntentOnReaderMock).not.toHaveBeenCalled()
  })

  // S654 (Nic): the reader shows the breakdown before it asks for the card;
  // a timed-out charge clears the reader and KEEPS the charge.
  it('shows the cart on the reader (lines, tax, fee, total) priced by the server', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const { stripeReaderId } = await seedTerminalReader(f)
    const itemId = await seedPosItem(f, { sellPrice: 10, stockQty: 9 })
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 20, taxAmount: 1.5, lines: [{ itemId, lineSubtotal: 20, lineTax: 1.5 }] })
    const fee = withCardFee(21.5) - Math.round(21.5 * 100)
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_show', status: 'requires_payment_method', amount: withCardFee(21.5),
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId, gam_property_id: f.propertyId },
    } as any)
    const res = await request(buildApp())
      .post('/api/pos/terminal/payment-intents/pi_show/process')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ stripeReaderId, items: [{ id: itemId, name: 'Propane', qty: 2, price: 10 }] })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(showCartOnReaderMock).toHaveBeenCalledTimes(1)
    const cart: any = (showCartOnReaderMock.mock.calls as any[])[0][0]
    expect(cart.stripeReaderId).toBe(stripeReaderId)
    expect(cart.lines[0]).toEqual({ description: 'Propane ×2', amountCents: 2000, quantity: 1 })
    expect(cart.lines[1].description).toBe('Card processing fee')
    expect(cart.lines[1].amountCents).toBe(fee)
    expect(cart.taxCents).toBe(150)
    expect(cart.totalCents).toBe(withCardFee(21.5))
    expect(processPaymentIntentOnReaderMock).toHaveBeenCalled()
  })

  it('refuses to put a changed cart on the reader', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const { stripeReaderId } = await seedTerminalReader(f)
    const itemId = await seedPosItem(f, { sellPrice: 10, stockQty: 9 })
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 30, taxAmount: 0, lines: [{ itemId, lineSubtotal: 30, lineTax: 0 }] })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_changed', status: 'requires_payment_method', amount: withCardFee(20),
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId, gam_property_id: f.propertyId },
    } as any)
    const res = await request(buildApp())
      .post('/api/pos/terminal/payment-intents/pi_changed/process')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ stripeReaderId, items: [{ id: itemId, name: 'Propane', qty: 3, price: 10 }] })
    expect(res.status).toBe(409)
    expect(showCartOnReaderMock).not.toHaveBeenCalled()
    expect(processPaymentIntentOnReaderMock).not.toHaveBeenCalled()
  })

  it('clear-reader clears the paired reader and keeps the charge; a stranger\'s reader is refused', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const { stripeReaderId } = await seedTerminalReader(f)
    retrieveTerminalPaymentIntentMock.mockResolvedValue({
      id: 'pi_keep_me', status: 'requires_payment_method', amount: 500,
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId, gam_property_id: f.propertyId },
    } as any)
    const ok = await request(buildApp()).post('/api/pos/terminal/payment-intents/pi_keep_me/clear-reader')
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ stripeReaderId })
    expect(ok.status).toBe(200)
    expect(cancelReaderActionMock).toHaveBeenCalledWith(stripeReaderId)
    expect(cancelTerminalPaymentIntentMock).not.toHaveBeenCalled()
    cancelReaderActionMock.mockClear()
    const foreign = await request(buildApp()).post('/api/pos/terminal/payment-intents/pi_keep_me/clear-reader')
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ stripeReaderId: 'tmr_not_mine' })
    expect(foreign.status).toBe(404)
    expect(cancelReaderActionMock).not.toHaveBeenCalled()
    // The void still clears the paired reader too.
    const voided = await request(buildApp()).post('/api/pos/terminal/payment-intents/pi_keep_me/cancel')
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ stripeReaderId })
    expect(voided.status).toBe(200)
    expect(cancelReaderActionMock).toHaveBeenCalledWith(stripeReaderId)
    expect(cancelTerminalPaymentIntentMock).toHaveBeenCalled()
  })

  it('happy: calls processPaymentIntentOnReader, returns reader + action', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const { stripeReaderId } = await seedTerminalReader(f)
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_x', status: 'requires_capture', amount: 1000,
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId },
    } as any)
    const res = await request(buildApp())
      .post('/api/pos/terminal/payment-intents/pi_x/process')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ stripeReaderId })
    expect(res.status).toBe(200)
    expect(res.body.data.readerId).toBe('tmr_mock')
    expect(res.body.data.action.status).toBe('in_progress')
  })

  it('archived reader → 404 (active-only scope)', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const { stripeReaderId } = await seedTerminalReader(f, { status: 'archived' })
    const res = await request(buildApp())
      .post('/api/pos/terminal/payment-intents/pi_x/process')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ stripeReaderId })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/pos/terminal/payment-intents/:id/capture', () => {
  it('happy: returns succeeded PI', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_x', status: 'requires_capture', amount: 1000,
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId },
    } as any)
    const res = await request(buildApp())
      .post('/api/pos/terminal/payment-intents/pi_x/capture')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('succeeded')
    expect(captureTerminalPaymentIntentMock).toHaveBeenCalledWith({ paymentIntentId: 'pi_x' })
  })

  // S648: every register's charges share GAM's account — the charge's own
  // landlord stamp is the fence.
  it('another landlord\'s charge → 404, nothing captured', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_x', status: 'requires_capture', amount: 1000,
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: randomUUID() },
    } as any)
    const res = await request(buildApp())
      .post('/api/pos/terminal/payment-intents/pi_x/capture')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(404)
    expect(captureTerminalPaymentIntentMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/pos/terminal/payment-intents/:id/cancel', () => {
  it('happy: returns canceled PI', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_x', status: 'requires_capture', amount: 1000,
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId },
    } as any)
    const res = await request(buildApp())
      .post('/api/pos/terminal/payment-intents/pi_x/cancel')
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('canceled')
    expect(cancelTerminalPaymentIntentMock).toHaveBeenCalledWith({ paymentIntentId: 'pi_x' })
  })
})

// POS #1: business-level default margin
describe('GET/PATCH /api/pos/settings (default margin)', () => {
  it('defaults to null, persists a set value, and rejects out-of-range', async () => {
    const f = await seedPosFixture()
    const app = buildApp()
    const auth = { Authorization: `Bearer ${f.landlordToken}` }

    const g0 = await request(app).get('/api/pos/settings').set(auth)
    expect(g0.status).toBe(200)
    expect(g0.body.data.defaultMarginPct).toBeNull()

    const set = await request(app).patch('/api/pos/settings').set(auth).send({ defaultMarginPct: 40 })
    expect(set.status).toBe(200)
    expect(set.body.data.defaultMarginPct).toBe(40)

    const g1 = await request(app).get('/api/pos/settings').set(auth)
    expect(g1.body.data.defaultMarginPct).toBe(40)

    const bad = await request(app).patch('/api/pos/settings').set(auth).send({ defaultMarginPct: 150 })
    expect(bad.status).toBe(400)

    const clear = await request(app).patch('/api/pos/settings').set(auth).send({ defaultMarginPct: null })
    expect(clear.status).toBe(200)
    expect(clear.body.data.defaultMarginPct).toBeNull()
  })
})


// ── S649 (Nic): "there's no item at all" ──────────────────────────────────
// An account that owns two companies got "You own more than one company" from
// every register call, so the register was empty. The property names the
// company; the register must work from it.
describe('S649 a two-company account uses the register by property', () => {
  it('lists and rings items for the property\'s own company', async () => {
    const f = await seedPosFixture()
    const c = await db.connect()
    let secondLandlord = ''
    try {
      secondLandlord = (await c.query<{ id: string }>(
        `INSERT INTO landlords (user_id, business_name) VALUES ($1, 'Second Park LLC') RETURNING id`,
        [f.landlordUserId])).rows[0].id
    } finally { c.release() }
    const itemId = await seedPosItem(f, { sellPrice: 12, stockQty: 999 })
    const token = jwt.sign(
      { userId: f.landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: null,
        landlordIds: [f.landlordId, secondLandlord], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    // S654 (Nic, DIRECTIVE): no default company. A list that names no property
    // is ASKED which company — never answered with "the founding company's".
    // The register always names its property (next call).
    const bare = await request(buildApp()).get('/api/pos/items').set('Authorization', `Bearer ${token}`)
    expect(bare.status, JSON.stringify(bare.body)).toBe(400)
    expect(String(bare.body?.error)).toMatch(/more than one company/i)
    const res = await request(buildApp()).get(`/api/pos/items?propertyId=${f.propertyId}`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.map((i: any) => i.id)).toContain(itemId)
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 12, taxAmount: 0, lines: [{ itemId, lineSubtotal: 12, lineTax: 0 }] })
    const sale = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${token}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'I', qty: 1, price: 12 }], paymentMethod: 'cash' })
    expect(sale.status).toBe(201)
    expect(sale.body.data.landlord_id).toBe(f.landlordId)
  })
})

// S654 (Nic): "it goes away. It needs to be there the whole time … link it to be
// always on the screen until the payment is processed. Also, it doesn't show a
// customer name … I need to be able to choose a customer from the drop-down menu
// to link to that transaction and it should show their name on the pay screen."
describe('S654 the breakdown on the reader while the cart is rung, with the customer', () => {
  async function residentAt(f: PosFixture, first = 'Dakota', last = 'Lane'): Promise<string> {
    const client = await db.connect()
    try {
      const tenantId = await seedTenant(client)
      await client.query(`UPDATE users SET first_name = $1, last_name = $2 WHERE id = (SELECT user_id FROM tenants WHERE id = $3)`, [first, last, tenantId])
      const unitId = await seedUnit(client, { propertyId: f.propertyId, landlordId: f.landlordId })
      const leaseId = await seedLease(client, { unitId, landlordId: f.landlordId })
      await seedLeaseTenant(client, { leaseId, tenantId })
      return tenantId
    } finally { client.release() }
  }
  async function customerOf(f: PosFixture, first: string, last: string, email: string | null = null): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, email) VALUES ($1,$2,$3,$4) RETURNING id`,
      [f.landlordId, first, last, email])
    return r.rows[0].id
  }

  it('puts the server-priced breakdown on the reader with the picked customer\'s name', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const { stripeReaderId } = await seedTerminalReader(f)
    const itemId = await seedPosItem(f, { sellPrice: 10, stockQty: 9 })
    const customerId = await customerOf(f, 'Jane', 'Doe')
    calculateCartTaxMock.mockResolvedValueOnce({ subtotal: 20, taxAmount: 1.5, lines: [{ itemId, lineSubtotal: 20, lineTax: 1.5 }] })
    const res = await request(buildApp()).post(`/api/pos/terminal/readers/${stripeReaderId}/cart`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Propane', qty: 2, price: 10 }], posCustomerId: customerId })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.shown).toBe(true)
    const cart: any = (showCartOnReaderMock.mock.calls as any[])[0][0]
    expect(cart.who).toBe('Jane Doe')
    // The tax, the card fee and the total are the server's — the same figures the charge will use.
    expect(cart.lines[0]).toEqual({ description: 'Propane ×2', amountCents: 2000, quantity: 1 })
    expect(cart.lines[1].description).toBe('Card processing fee')
    expect(cart.taxCents).toBe(150)
    expect(cart.totalCents).toBe(withCardFee(21.5))
    expect(processPaymentIntentOnReaderMock).not.toHaveBeenCalled()
  })

  it('names a resident of the property; another company\'s customer shows no name (never a failure); another company\'s reader is refused', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const other = await seedPosFixture()
    const { stripeReaderId } = await seedTerminalReader(f)
    const { stripeReaderId: otherReader } = await seedTerminalReader(other)
    const itemId = await seedPosItem(f, { sellPrice: 4, stockQty: 9 })
    const tenantId = await residentAt(f)
    const ok = await request(buildApp()).post(`/api/pos/terminal/readers/${stripeReaderId}/cart`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Ice', qty: 1, price: 4 }], tenantId })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect((showCartOnReaderMock.mock.calls as any[])[0][0].who).toBe('Dakota Lane')

    // 10/2: the breakdown never fails over the person — somebody who cannot be
    // named here shows no name, and nothing of theirs reaches the reader.
    const stranger = await customerOf(other, 'Not', 'Mine')
    const foreignCustomer = await request(buildApp()).post(`/api/pos/terminal/readers/${stripeReaderId}/cart`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Ice', qty: 1, price: 4 }], posCustomerId: stranger })
    expect(foreignCustomer.status, JSON.stringify(foreignCustomer.body)).toBe(200)
    expect(foreignCustomer.body.data.shown).toBe(true)
    expect((showCartOnReaderMock.mock.calls as any[])[1][0].who).toBeNull()
    const foreignReader = await request(buildApp()).post(`/api/pos/terminal/readers/${otherReader}/cart`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Ice', qty: 1, price: 4 }] })
    expect(foreignReader.status).toBe(404)
    expect(showCartOnReaderMock).toHaveBeenCalledTimes(2)
  })

  it('leaves a reader alone that is mid-payment or asking the last customer a question; an empty cart takes the breakdown down', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const { stripeReaderId } = await seedTerminalReader(f)
    const itemId = await seedPosItem(f, { sellPrice: 4, stockQty: 9 })
    readerActionMock.mockResolvedValueOnce({ type: 'collect_inputs', status: 'in_progress' })
    const busy = await request(buildApp()).post(`/api/pos/terminal/readers/${stripeReaderId}/cart`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Ice', qty: 1, price: 4 }] })
    expect(busy.status).toBe(200)
    expect(busy.body.data).toMatchObject({ shown: false, busy: 'collect_inputs' })
    expect(showCartOnReaderMock).not.toHaveBeenCalled()

    // A breakdown already up is simply replaced.
    readerActionMock.mockResolvedValueOnce({ type: 'set_reader_display', status: 'in_progress' })
    const again = await request(buildApp()).post(`/api/pos/terminal/readers/${stripeReaderId}/cart`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Ice', qty: 2, price: 4 }] })
    expect(again.body.data.shown).toBe(true)

    const empty = await request(buildApp()).post(`/api/pos/terminal/readers/${stripeReaderId}/cart`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [] })
    expect(empty.status).toBe(200)
    expect(clearCartOnReaderMock).toHaveBeenCalledWith(stripeReaderId, expect.stringMatching(/^register:/))
  })

  it('Charge after the breakdown was up finishes at once; a breakdown that was not up is held; the name rides along', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const { stripeReaderId } = await seedTerminalReader(f)
    const itemId = await seedPosItem(f, { sellPrice: 10, stockQty: 9 })
    const customerId = await customerOf(f, 'Jane', 'Doe')
    const pi = (id: string) => ({
      id, status: 'requires_payment_method', amount: withCardFee(10),
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId, gam_property_id: f.propertyId },
    } as any)
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce(pi('pi_up'))
    const up = await request(buildApp()).post('/api/pos/terminal/payment-intents/pi_up/process')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ stripeReaderId, items: [{ id: itemId, name: 'Propane', qty: 1, price: 10 }], posCustomerId: customerId, cartOnReader: true })
    expect(up.status, JSON.stringify(up.body)).toBe(200)
    expect(holdForTheCartMock).not.toHaveBeenCalled()
    expect((showCartOnReaderMock.mock.calls as any[])[0][0].who).toBe('Jane Doe')
    expect(processPaymentIntentOnReaderMock).toHaveBeenCalledTimes(1)

    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce(pi('pi_cold'))
    const cold = await request(buildApp()).post('/api/pos/terminal/payment-intents/pi_cold/process')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ stripeReaderId, items: [{ id: itemId, name: 'Propane', qty: 1, price: 10 }] })
    expect(cold.status).toBe(200)
    expect(holdForTheCartMock).toHaveBeenCalledTimes(1)
  })

  it('a breakdown another flow had taken over is held for reading even when the register says it was up', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const { stripeReaderId } = await seedTerminalReader(f)
    const itemId = await seedPosItem(f, { sellPrice: 10, stockQty: 9 })
    retrieveTerminalPaymentIntentMock.mockResolvedValueOnce({
      id: 'pi_taken', status: 'requires_payment_method', amount: withCardFee(10),
      metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId, gam_property_id: f.propertyId },
    } as any)
    showCartOnReaderMock.mockResolvedValueOnce('took_over' as any)
    const res = await request(buildApp()).post('/api/pos/terminal/payment-intents/pi_taken/process')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ stripeReaderId, items: [{ id: itemId, name: 'Propane', qty: 1, price: 10 }], cartOnReader: true })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(holdForTheCartMock).toHaveBeenCalledTimes(1)
    expect((showCartOnReaderMock.mock.calls as any[])[0][0].owner).toMatch(/^register:/)
  })

  it('the card-on-file lookup refuses another company\'s customer', async () => {
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    const stranger = await customerOf(other, 'Not', 'Mine')
    const res = await request(buildApp()).get(`/api/pos/card-on-file?propertyId=${f.propertyId}&posCustomerId=${stranger}`)
      .set('Authorization', `Bearer ${f.landlordToken}`)
    expect(res.status).toBe(404)
  })

  it('adds a customer with a first name only; an email already on the list picks that customer', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const first = await request(buildApp()).post('/api/pos/customers')
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ propertyId: f.propertyId, firstName: 'Cash' })
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    const row = await db.query(`SELECT landlord_id, first_name, last_name, email, created_from FROM pos_customers WHERE id = $1`, [first.body.data.id])
    expect(row.rows[0]).toMatchObject({ landlord_id: f.landlordId, first_name: 'Cash', last_name: '', email: null, created_from: 'manual' })
    const existing = await customerOf(f, 'Jane', 'Doe', 'jane@example.com')
    const dup = await request(buildApp()).post('/api/pos/customers')
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ propertyId: f.propertyId, firstName: 'J', email: 'JANE@example.com' })
    expect(dup.status).toBe(200)
    expect(dup.body.data).toMatchObject({ id: existing, existing: true })
  })

  it('a cash sale cannot name another company\'s customer', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const other = await seedPosFixture()
    const itemId = await seedPosItem(f, { sellPrice: 5, stockQty: 9 })
    const stranger = await customerOf(other, 'Not', 'Mine')
    const res = await request(buildApp()).post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ items: [{ id: itemId, name: 'Ice', qty: 1, price: 5, tax: 0 }], paymentMethod: 'cash', propertyId: f.propertyId,
              posCustomerId: stranger, subtotal: 5, taxAmount: 0, total: 5 })
    expect(res.status).toBe(404)
    const n = await db.query(`SELECT COUNT(*)::int AS n FROM pos_transactions WHERE landlord_id = $1`, [f.landlordId])
    expect(n.rows[0].n).toBe(0)
  })
})

describe('S654 a card the reader took', () => {
  it('a card the reader took is only ever recorded as a card sale', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const itemId = await seedPosItem(f, { sellPrice: 5, stockQty: 9 })
    const res = await request(buildApp()).post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ items: [{ id: itemId, name: 'Ice', qty: 1, price: 5, tax: 0 }], paymentMethod: 'cash', propertyId: f.propertyId,
              subtotal: 5, taxAmount: 0, total: 5, stripePaymentIntentId: 'pi_from_reader' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/card sale/i)
  })
})

// ── 10/2 (Nic): one typed customer flow, and linking a sale fills in its card ──
//
//   "type somebody's last name and have it pop up... on the history, same
//    thing... link them to that transaction. And then have it retroactively
//    fill to any matching cards... I already have a tenant profile. So if I
//    click my name as a customer, it should automatically fill it in in all
//    matching card transactions."

async function residentOf(f: PosFixture, first: string, last: string,
                          opts: { site?: string; email?: string; phone?: string; status?: 'active' | 'pending' | 'expired' | 'terminated'; propertyId?: string } = {}): Promise<string> {
  const client = await db.connect()
  try {
    const tenantId = await seedTenant(client, opts.email ? { email: opts.email } : {})
    await client.query(`UPDATE users SET first_name = $1, last_name = $2, phone = $3 WHERE id = (SELECT user_id FROM tenants WHERE id = $4)`,
      [first, last, opts.phone ?? null, tenantId])
    const unitId = await seedUnit(client, { propertyId: opts.propertyId ?? f.propertyId, landlordId: f.landlordId })
    if (opts.site) await client.query(`UPDATE units SET unit_number = $1 WHERE id = $2`, [opts.site, unitId])
    const leaseId = await seedLease(client, { unitId, landlordId: f.landlordId, status: opts.status ?? 'active' })
    await seedLeaseTenant(client, { leaseId, tenantId })
    return tenantId
  } finally { client.release() }
}

async function customerRow(f: PosFixture, first: string, last: string,
                           opts: { email?: string | null; phone?: string | null; fromCard?: boolean } = {}): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO pos_customers (landlord_id, first_name, last_name, email, phone, created_from) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [f.landlordId, first, last, opts.email ?? null, opts.phone ?? null, opts.fromCard ? 'card_reader' : 'manual'])).rows[0].id
}

async function cardRow(f: PosFixture, customerId: string, fingerprint: string, last4: string, printed: string | null = null): Promise<void> {
  await db.query(
    `INSERT INTO pos_customer_cards (landlord_id, pos_customer_id, fingerprint, brand, last4, cardholder_name) VALUES ($1,$2,$3,'visa',$4,$5)`,
    [f.landlordId, customerId, fingerprint, last4, printed])
}

/** A recorded sale, at a property, for whoever (or nobody). */
async function saleRow(f: PosFixture, opts: { propertyId?: string | null; posCustomerId?: string | null; tenantId?: string | null;
                                              paymentMethod?: 'cash' | 'card'; pi?: string | null; at?: string } = {}): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, total, status, property_id,
                                   pos_customer_id, tenant_id, stripe_payment_intent_id, created_at)
     VALUES ($1,$2,$3,10,0,10,'completed',$4,$5,$6,$7,COALESCE($8::timestamptz, NOW())) RETURNING id`,
    [f.landlordId, f.landlordUserId, opts.paymentMethod ?? 'cash', opts.propertyId === undefined ? f.propertyId : opts.propertyId,
     opts.posCustomerId ?? null, opts.tenantId ?? null, opts.pi ?? null, opts.at ?? null])).rows[0].id
}

const tapOf = (f: PosFixture, piId: string, amount: number, card: Record<string, unknown>) => ({
  id: piId, status: 'requires_capture', amount,
  metadata: { gam_purpose: 'pos_terminal', gam_landlord_id: f.landlordId, gam_property_id: f.propertyId },
  latest_charge: { id: 'ch_' + piId, payment_method_details: { type: 'card_present', card_present: {
    brand: 'visa', cardholder_name: null, generated_card: null, ...card } } },
})

/** A card sale rung at the register — the tap is mocked, everything else is real. */
async function tapSale(f: PosFixture, itemId: string, price: number, piId: string, card: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  calculateCartTaxMock.mockResolvedValueOnce({ subtotal: price, taxAmount: 0, lines: [{ itemId, lineSubtotal: price, lineTax: 0 }] })
  retrieveTerminalPaymentIntentMock.mockResolvedValueOnce(tapOf(f, piId, withCardFee(price), card) as any)
  return request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.landlordToken}`)
    .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Propane', qty: 1, price }], paymentMethod: 'card',
            stripePaymentIntentId: piId, ...extra })
}

const link = (f: PosFixture, saleId: string, body: any, token = f.landlordToken) => request(buildApp())
  .patch(`/api/pos/transactions/${saleId}/customer`).set('Authorization', `Bearer ${token}`).send(body)

const searchAt = (f: PosFixture, q: string, propertyId = f.propertyId, token = f.landlordToken) => request(buildApp())
  .get(`/api/pos/people?propertyId=${propertyId}&q=${encodeURIComponent(q)}`).set('Authorization', `Bearer ${token}`)

/** A cashier (on-site manager) assigned to some of the company's properties only. */
async function cashierFor(f: PosFixture, propertyIds: string[]): Promise<string> {
  const u = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1,'x','onsite_manager','Front','Desk',TRUE) RETURNING id`, [`desk-${randomUUID()}@t.dev`])
  const perms = { 'pos.ring_sale': true, 'pos.refund': true, 'pos.void': true, 'pos.end_of_day': true }
  await db.query(
    `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties, permissions) VALUES ($1,$2,$3,FALSE,$4)`,
    [u.rows[0].id, f.landlordId, propertyIds, JSON.stringify(perms)])
  return jwt.sign({ userId: u.rows[0].id, role: 'onsite_manager', email: 'desk@t.dev', landlordId: f.landlordId, permissions: perms },
    process.env.JWT_SECRET!, { expiresIn: '1h' })
}

async function secondProperty(f: PosFixture): Promise<string> {
  const c = await db.connect()
  try { return await seedProperty(c, { landlordId: f.landlordId, ownerUserId: f.landlordUserId, managedByUserId: f.landlordUserId }) }
  finally { c.release() }
}

// 10/2 (review): a wrong pick in History could not be undone — linking folded
// the sale's card record into the person picked (its other sales, and a card
// kept on file, behind their "On file"), and Change customer moved only the
// one sale back. Undo puts every piece back.
describe('10/2 (review) a wrong pick is put back with Undo', () => {
  const undo = (f: PosFixture, saleId: string, token: string, auth = f.landlordToken) => request(buildApp())
    .post(`/api/pos/transactions/${saleId}/customer/undo`).set('Authorization', `Bearer ${auth}`).send({ undo: token })

  async function keptCardStandIn(f: PosFixture) {
    const standIn = await customerRow(f, 'Card', 'Customer', { fromCard: true })
    await db.query(`UPDATE pos_customers SET stripe_customer_id = 'cus_standin' WHERE id = $1`, [standIn])
    await cardRow(f, standIn, 'fp_stranger', '1234')
    await db.query(`UPDATE pos_customer_cards SET stripe_payment_method_id = 'pm_kept', saved_at = NOW() WHERE fingerprint = 'fp_stranger'`)
    const s1 = await saleRow(f, { posCustomerId: standIn, paymentMethod: 'card', at: '2026-09-30T12:00:00Z' })
    const s2 = await saleRow(f, { posCustomerId: standIn, paymentMethod: 'card' })
    return { standIn, s1, s2 }
  }

  it('linked to the wrong resident, the folded card record, its other sale and its kept card all go back — once', async () => {
    const f = await seedPosFixture()
    const { standIn, s1, s2 } = await keptCardStandIn(f)
    const wrong = await residentOf(f, 'Wrong', 'Person')
    const res = await link(f, s2, { tenantId: wrong })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.message).toBe('Linked to Wrong Person — also 1 earlier sale on Visa ••1234.')
    expect(typeof res.body.data.undo).toBe('string')
    const record = res.body.data.pos_customer_id
    // The fold happened: the stranger's card and sale are on the wrong person.
    expect((await db.query<any>(`SELECT pos_customer_id, tenant_id FROM pos_transactions WHERE id = $1`, [s1])).rows[0]).toEqual({ pos_customer_id: record, tenant_id: wrong })
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_customer_cards WHERE fingerprint = 'fp_stranger'`)).rows[0].pos_customer_id).toBe(record)
    expect((await db.query<any>(`SELECT stripe_customer_id FROM pos_customers WHERE id = $1`, [record])).rows[0].stripe_customer_id).toBe('cus_standin')

    const back = await undo(f, s2, res.body.data.undo)
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(back.body.data.message).toBe('Put back — this sale and 1 other sale are the way they were.')
    expect(back.body.data).toMatchObject({ pos_customer_id: standIn, tenant_id: null, undo: null })
    const sales = (await db.query<any>(`SELECT id, pos_customer_id, tenant_id FROM pos_transactions WHERE id = ANY($1::uuid[]) ORDER BY created_at`, [[s1, s2]])).rows
    expect(sales.map((x: any) => [x.pos_customer_id, x.tenant_id])).toEqual([[standIn, null], [standIn, null]])
    expect((await db.query<any>(`SELECT pos_customer_id, stripe_payment_method_id FROM pos_customer_cards WHERE fingerprint = 'fp_stranger'`)).rows[0])
      .toEqual({ pos_customer_id: standIn, stripe_payment_method_id: 'pm_kept' })
    expect((await db.query<any>(`SELECT archived_at, stripe_customer_id FROM pos_customers WHERE id = $1`, [standIn])).rows[0])
      .toEqual({ archived_at: null, stripe_customer_id: 'cus_standin' })
    expect((await db.query<any>(`SELECT stripe_customer_id, tenant_id FROM pos_customers WHERE id = $1`, [record])).rows[0])
      .toEqual({ stripe_customer_id: null, tenant_id: wrong })
    // Once only.
    const twice = await undo(f, s2, res.body.data.undo)
    expect(twice.status).toBe(409)
    expect(twice.body.error).toMatch(/can no longer be undone here — .*pick the right person/)
  })

  it('an Undo is the clerk\'s own, for that sale, only while the sale still names whom it was linked to', async () => {
    const f = await seedPosFixture()
    const { s2 } = await keptCardStandIn(f)
    const bob = await customerRow(f, 'Bob', 'Wrong')
    const res = await link(f, s2, { posCustomerId: bob })
    const token = res.body.data.undo
    const other = await seedPosFixture()
    expect((await undo(f, s2, token, other.landlordToken)).status).toBe(404)
    const cashier = await cashierFor(f, [f.propertyId])
    expect((await undo(f, s2, token, cashier)).status).toBe(409)
    expect((await undo(f, randomUUID(), token)).status).toBe(404)
    expect((await undo(f, s2, 'x'.repeat(80))).status).toBe(409)
    // Linked again since: the old Undo no longer applies.
    const jane = await customerRow(f, 'Jane', 'Right')
    expect((await link(f, s2, { posCustomerId: jane })).status).toBe(200)
    expect((await undo(f, s2, token)).status).toBe(409)
  })

  it('a card put on the person by the link comes off again, and the sale names nobody', async () => {
    const f = await seedPosFixture()
    const bob = await customerRow(f, 'Bob', 'Smith')
    const sale = await saleRow(f, { paymentMethod: 'card', pi: 'pi_unknown_card' })
    readSaleCardMock.mockResolvedValueOnce({ fingerprint: 'fp_unknown', brand: 'mastercard', last4: '5100', cardholderName: null, generatedCard: null })
    const res = await link(f, sale, { posCustomerId: bob })
    expect(res.body.data.message).toBe('Linked to Bob Smith. Mastercard ••5100 is on their record now.')
    const back = await undo(f, sale, res.body.data.undo)
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(back.body.data).toMatchObject({ pos_customer_id: null, tenant_id: null })
    expect((await db.query(`SELECT 1 FROM pos_customer_cards WHERE fingerprint = 'fp_unknown'`)).rows).toHaveLength(0)
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_transactions WHERE id = $1`, [sale])).rows[0].pos_customer_id).toBeNull()
  })

  it('a stand-in named by "Add new" gets its name back; a customer the link made goes again', async () => {
    const f = await seedPosFixture()
    const standIn = await customerRow(f, 'Card', 'Customer', { fromCard: true })
    const s = await saleRow(f, { posCustomerId: standIn, paymentMethod: 'card' })
    const named = await link(f, s, { addNew: { firstName: 'Pat', lastName: 'Typed', email: 'pat@typed.dev' } })
    expect(named.body.data.message).toMatch(/^Saved Pat Typed/)
    expect((await undo(f, s, named.body.data.undo)).status).toBe(200)
    expect((await db.query<any>(`SELECT first_name, last_name, email FROM pos_customers WHERE id = $1`, [standIn])).rows[0])
      .toEqual({ first_name: 'Card', last_name: 'Customer', email: null })
    // A cash sale linked to a brand-new customer: undone, that record goes again.
    const cash = await saleRow(f, { paymentMethod: 'cash' })
    const made = await link(f, cash, { addNew: { firstName: 'Ona', lastName: 'Time' } })
    const madeId = made.body.data.pos_customer_id
    expect((await undo(f, cash, made.body.data.undo)).status).toBe(200)
    expect((await db.query<any>(`SELECT archived_at FROM pos_customers WHERE id = $1`, [madeId])).rows[0].archived_at).not.toBeNull()
  })

  it('at the register: the tapped card\'s record folded into the person picked goes back with Undo; the sale stays theirs', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const itemId = await seedPosItem(f, { sellPrice: 5, stockQty: 999 })
    const bob = await customerRow(f, 'Bob', 'Walker', { phone: '602-555-0123' })
    const standIn = await customerRow(f, 'Card', 'Customer', { fromCard: true })
    await cardRow(f, standIn, 'fp_not_bob', '4444')
    const earlier = await saleRow(f, { posCustomerId: standIn, paymentMethod: 'card' })
    const res = await tapSale(f, itemId, 5, 'pi_wrong_bob', { fingerprint: 'fp_not_bob', last4: '4444' }, { posCustomerId: bob })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.customer).toMatchObject({ id: bob, cardNote: 'Also 1 earlier sale on Visa ••4444.' })
    expect(typeof res.body.data.customer.cardUndo).toBe('string')
    const back = await undo(f, res.body.data.id, res.body.data.customer.cardUndo)
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(back.body.data.message).toBe('Put back — the card and 1 other sale went back where they were; this sale stays with Bob Walker.')
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_transactions WHERE id = $1`, [earlier])).rows[0].pos_customer_id).toBe(standIn)
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_customer_cards WHERE fingerprint = 'fp_not_bob'`)).rows[0].pos_customer_id).toBe(standIn)
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_transactions WHERE id = $1`, [res.body.data.id])).rows[0].pos_customer_id).toBe(bob)
    // A tap that folded nothing hands back no Undo.
    const plain = await tapSale(f, itemId, 5, 'pi_bob_own', { fingerprint: 'fp_bob_own', last4: '9999' }, { posCustomerId: bob })
    expect(plain.body.data.customer.cardUndo).toBeNull()
  })
})

describe('10/2 linking a sale to a person fills in every sale on the same card', () => {
  const visa9767 = { fingerprint: 'fp_nic_9767', last4: '9767' }

  it("Nic's scenario: two sales on one card sit on a stand-in; linking one to his resident record fills in both", async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const { stripeReaderId } = await seedTerminalReader(f)
    const itemId = await seedPosItem(f, { sellPrice: 5, stockQty: 999 })
    const nic = await residentOf(f, 'Nicholas', 'Rhoades', { site: 'MH 02' })
    // 10/01: two taps of his Visa ••9767 with nobody picked — one nameless "Card Customer".
    const s1 = await tapSale(f, itemId, 5, 'pi_nic_1', visa9767)
    const s2 = await tapSale(f, itemId, 5, 'pi_nic_2', visa9767)
    expect(s1.status, JSON.stringify(s1.body)).toBe(201)
    expect(s2.status).toBe(201)
    const standIn = s1.body.data.pos_customer_id
    expect(s2.body.data.pos_customer_id).toBe(standIn)
    expect((await db.query<any>(`SELECT first_name, last_name, created_from FROM pos_customers WHERE id = $1`, [standIn])).rows[0])
      .toEqual({ first_name: 'Card', last_name: 'Customer', created_from: 'card_reader' })

    // He clicks his own name on the later sale.
    const res = await link(f, s2.body.data.id, { tenantId: nic })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const nicRecord = res.body.data.pos_customer_id
    expect(nicRecord).not.toBe(standIn)
    expect(res.body.data).toMatchObject({ tenant_id: nic, customer_name: 'Nicholas Rhoades', also_moved: 1, card: 'Visa ••9767' })
    expect(res.body.data.message).toBe('Linked to Nicholas Rhoades — also 1 earlier sale on Visa ••9767.')
    // Both sales are his, as a resident; the card is on his record; the stand-in is closed, not deleted.
    const sales = (await db.query<any>(`SELECT pos_customer_id, tenant_id FROM pos_transactions WHERE id = ANY($1::uuid[])`,
      [[s1.body.data.id, s2.body.data.id]])).rows
    expect(sales).toEqual([{ pos_customer_id: nicRecord, tenant_id: nic }, { pos_customer_id: nicRecord, tenant_id: nic }])
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_customer_cards WHERE fingerprint = 'fp_nic_9767'`)).rows[0].pos_customer_id).toBe(nicRecord)
    expect((await db.query<any>(`SELECT archived_at FROM pos_customers WHERE id = $1`, [standIn])).rows[0].archived_at).not.toBeNull()
    expect((await db.query<any>(`SELECT tenant_id FROM pos_customers WHERE id = $1`, [nicRecord])).rows[0].tenant_id).toBe(nic)

    // A later tap of the same card with nobody picked is his — as a resident —
    // and the reader asks him nothing (card on file is for guests).
    const s3 = await tapSale(f, itemId, 5, 'pi_nic_3', { ...visa9767, generated_card: 'pm_gen_nic' }, { stripeReaderId })
    expect(s3.status).toBe(201)
    expect(s3.body.data).toMatchObject({ pos_customer_id: nicRecord, tenant_id: nic })
    expect(s3.body.data.customer).toMatchObject({ id: nicRecord, firstName: 'Nicholas', lastName: 'Rhoades', isResident: true, prompting: false, priorPurchases: 2 })
    expect(startSaveCardPromptMock).not.toHaveBeenCalled()
  })

  it('a resident picked at the register: the sale names them and their record, and the tapped card goes on their record without asking', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const { stripeReaderId } = await seedTerminalReader(f)
    const itemId = await seedPosItem(f, { sellPrice: 5, stockQty: 999 })
    const ann = await residentOf(f, 'Ann', 'Resident')
    const res = await tapSale(f, itemId, 5, 'pi_ann_1', { fingerprint: 'fp_ann', last4: '1111', generated_card: 'pm_gen_ann' },
      { tenantId: ann, stripeReaderId })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const record = res.body.data.pos_customer_id
    expect(record).toBeTruthy()
    expect(res.body.data.tenant_id).toBe(ann)
    expect((await db.query<any>(`SELECT tenant_id FROM pos_customers WHERE id = $1`, [record])).rows[0].tenant_id).toBe(ann)
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_customer_cards WHERE fingerprint = 'fp_ann'`)).rows[0].pos_customer_id).toBe(record)
    expect(res.body.data.customer).toMatchObject({ isResident: true, prompting: false })
    expect(startSaveCardPromptMock).not.toHaveBeenCalled()
    // A cash sale for her is the same record — one record per person per company.
    const cash = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Ice', qty: 1, price: 5 }], paymentMethod: 'cash', tenantId: ann })
    expect(cash.status).toBe(201)
    expect(cash.body.data).toMatchObject({ pos_customer_id: record, tenant_id: ann })
    expect((await db.query<any>(`SELECT COUNT(*)::int AS n FROM pos_customers WHERE tenant_id = $1`, [ann])).rows[0].n).toBe(1)
  })

  it('a register customer picked, then a card tapped: the card is theirs, a stand-in on it folds in, and the reader asks to keep it and for an email — never a name', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const { stripeReaderId } = await seedTerminalReader(f)
    const itemId = await seedPosItem(f, { sellPrice: 5, stockQty: 999 })
    const bob = await customerRow(f, 'Bob', 'Walker', { phone: '602-555-0123' })
    const standIn = await customerRow(f, 'Card', 'Customer', { fromCard: true })
    await cardRow(f, standIn, 'fp_bob', '4444')
    const earlier = await saleRow(f, { posCustomerId: standIn, paymentMethod: 'card' })
    const res = await tapSale(f, itemId, 5, 'pi_bob_1', { fingerprint: 'fp_bob', last4: '4444', generated_card: 'pm_gen_bob' },
      { posCustomerId: bob, stripeReaderId })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.pos_customer_id).toBe(bob)
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_transactions WHERE id = $1`, [earlier])).rows[0].pos_customer_id).toBe(bob)
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_customer_cards WHERE fingerprint = 'fp_bob'`)).rows[0].pos_customer_id).toBe(bob)
    expect(res.body.data.customer).toMatchObject({ id: bob, cardNote: 'Also 1 earlier sale on Visa ••4444.', prompting: true })
    expect(startSaveCardPromptMock).toHaveBeenCalledWith(stripeReaderId, { askSave: true, askName: false, askEmail: true })
  })

  it('never overwrites: a card on a confirmed person stays theirs, only the sale in hand moves, and the clerk is told whose card it is', async () => {
    const f = await seedPosFixture()
    const jane = await customerRow(f, 'Jane', 'Doe', { email: 'jane@example.com' })
    await cardRow(f, jane, 'fp_jane', '4242')
    const janesOwn = await saleRow(f, { posCustomerId: jane, paymentMethod: 'card' })
    const bob = await customerRow(f, 'Bob', 'Smith')
    // A card sale that named nobody (an emailed pay link before cards were read).
    const sale = await saleRow(f, { paymentMethod: 'card', pi: 'pi_paid_online' })
    readSaleCardMock.mockResolvedValueOnce({ fingerprint: 'fp_jane', brand: 'visa', last4: '4242', cardholderName: null, generatedCard: null })
    const res = await link(f, sale, { posCustomerId: bob })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(readSaleCardMock).toHaveBeenCalledWith('pi_paid_online')
    expect(res.body.data.message).toBe("Linked to Bob Smith. This card is on Jane Doe's record; only this sale changed.")
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_transactions WHERE id = $1`, [sale])).rows[0].pos_customer_id).toBe(bob)
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_transactions WHERE id = $1`, [janesOwn])).rows[0].pos_customer_id).toBe(jane)
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_customer_cards WHERE fingerprint = 'fp_jane'`)).rows[0].pos_customer_id).toBe(jane)
    expect((await db.query<any>(`SELECT first_name, last_name, archived_at FROM pos_customers WHERE id = $1`, [jane])).rows[0])
      .toEqual({ first_name: 'Jane', last_name: 'Doe', archived_at: null })
  })

  it('an unknown card on a sale that named nobody goes onto the person it is linked to', async () => {
    const f = await seedPosFixture()
    const bob = await customerRow(f, 'Bob', 'Smith')
    const sale = await saleRow(f, { paymentMethod: 'card', pi: 'pi_new_card' })
    readSaleCardMock.mockResolvedValueOnce({ fingerprint: 'fp_new', brand: 'mastercard', last4: '5100', cardholderName: null, generatedCard: null })
    const res = await link(f, sale, { posCustomerId: bob })
    expect(res.status).toBe(200)
    expect(res.body.data.message).toBe('Linked to Bob Smith. Mastercard ••5100 is on their record now.')
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_customer_cards WHERE fingerprint = 'fp_new'`)).rows[0].pos_customer_id).toBe(bob)
    // A cash sale has no card to read.
    const cash = await saleRow(f, { paymentMethod: 'cash' })
    readSaleCardMock.mockClear()
    expect((await link(f, cash, { posCustomerId: bob })).status).toBe(200)
    expect(readSaleCardMock).not.toHaveBeenCalled()
  })

  it('a card printed with somebody else\'s last name is theirs: linking one of its sales moves only that sale', async () => {
    const f = await seedPosFixture()
    const nic = await residentOf(f, 'Nicholas', 'Rhoades')
    const printed = await customerRow(f, 'Jane', 'Doe', { fromCard: true })
    await cardRow(f, printed, 'fp_printed', '3333', 'JANE DOE')
    const s1 = await saleRow(f, { posCustomerId: printed, paymentMethod: 'card' })
    const s2 = await saleRow(f, { posCustomerId: printed, paymentMethod: 'card' })
    const res = await link(f, s1, { tenantId: nic })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.message).toBe("Linked to Nicholas Rhoades. The card used is in Jane Doe's name; only this sale changed.")
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_transactions WHERE id = $1`, [s2])).rows[0].pos_customer_id).toBe(printed)
    expect((await db.query<any>(`SELECT archived_at FROM pos_customers WHERE id = $1`, [printed])).rows[0].archived_at).toBeNull()
    // The same last name is the same person: Janet Doe takes the card and its sales.
    const janet = await customerRow(f, 'Janet', 'Doe', { email: 'janet@example.com' })
    const res2 = await link(f, s2, { posCustomerId: janet })
    expect(res2.status).toBe(200)
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_customer_cards WHERE fingerprint = 'fp_printed'`)).rows[0].pos_customer_id).toBe(janet)
    expect((await db.query<any>(`SELECT archived_at FROM pos_customers WHERE id = $1`, [printed])).rows[0].archived_at).not.toBeNull()
  })

  it('"Add new" on a stand-in\'s sale names the stand-in — the card and all its sales are that person', async () => {
    const f = await seedPosFixture()
    const standIn = await customerRow(f, 'Card', 'Customer', { fromCard: true })
    await cardRow(f, standIn, 'fp_wallet', '1111')
    const s1 = await saleRow(f, { posCustomerId: standIn, paymentMethod: 'card', at: '2026-10-01T10:00:00Z' })
    await saleRow(f, { posCustomerId: standIn, paymentMethod: 'card', at: '2026-10-01T12:00:00Z' })
    const res = await link(f, s1, { addNew: { firstName: 'Jane', lastName: 'Doe', email: 'Jane@Example.com', phone: '602-555-0101' } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ pos_customer_id: standIn, customer_name: 'Jane Doe', also_moved: 1 })
    expect(res.body.data.message).toBe('Saved Jane Doe — also 1 later sale on Visa ••1111.')
    expect((await db.query<any>(`SELECT first_name, last_name, email, phone, archived_at FROM pos_customers WHERE id = $1`, [standIn])).rows[0])
      .toEqual({ first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', phone: '602-555-0101', archived_at: null })
    expect((await db.query<any>(`SELECT COUNT(*)::int AS n FROM pos_customers WHERE landlord_id = $1`, [f.landlordId])).rows[0].n).toBe(1)
  })

  it('"Add new" with an email already on file is that customer; the stand-in folds into them', async () => {
    const f = await seedPosFixture()
    const known = await customerRow(f, 'Jane', 'Doe', { email: 'jane@example.com' })
    const standIn = await customerRow(f, 'Card', 'Customer', { fromCard: true })
    await cardRow(f, standIn, 'fp_x', '7777')
    const sale = await saleRow(f, { posCustomerId: standIn, paymentMethod: 'card' })
    const res = await link(f, sale, { addNew: { firstName: 'J', lastName: 'D', email: 'jane@example.com' } })
    expect(res.status).toBe(200)
    expect(res.body.data.pos_customer_id).toBe(known)
    expect((await db.query<any>(`SELECT first_name FROM pos_customers WHERE id = $1`, [known])).rows[0].first_name).toBe('Jane')
    expect((await db.query<any>(`SELECT archived_at FROM pos_customers WHERE id = $1`, [standIn])).rows[0].archived_at).not.toBeNull()
  })

  // Defect 1: "Edit customer" typed Bob over the sale's customer Jane and
  // renamed JANE everywhere — all her sales, her card, her history.
  it('changing a sale\'s customer moves that one sale — the person it named before is never renamed', async () => {
    const f = await seedPosFixture()
    const jane = await customerRow(f, 'Jane', 'Doe', { email: 'jane@example.com' })
    const sale1 = await saleRow(f, { posCustomerId: jane })
    const sale2 = await saleRow(f, { posCustomerId: jane })
    const res = await link(f, sale1, { addNew: { firstName: 'Bob', lastName: 'Smith' } })
    expect(res.status).toBe(200)
    const bob = res.body.data.pos_customer_id
    expect(bob).not.toBe(jane)
    expect((await db.query<any>(`SELECT first_name, last_name, email FROM pos_customers WHERE id = $1`, [jane])).rows[0])
      .toEqual({ first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com' })
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_transactions WHERE id = $1`, [sale2])).rows[0].pos_customer_id).toBe(jane)
    // The old typed-in route is gone.
    expect((await request(buildApp()).put(`/api/pos/transactions/${sale2}/customer-info`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ firstName: 'Bob' })).status).toBe(404)
    // A resident's sale can be re-linked too (it moves only that sale), and cleared.
    const ann = await residentOf(f, 'Ann', 'Resident')
    const toAnn = await link(f, sale2, { tenantId: ann })
    expect(toAnn.body.data).toMatchObject({ tenant_id: ann, customer_name: 'Ann Resident' })
    const cleared = await link(f, sale2, { posCustomerId: null })
    expect(cleared.status).toBe(200)
    expect((await db.query<any>(`SELECT pos_customer_id, tenant_id FROM pos_transactions WHERE id = $1`, [sale2])).rows[0])
      .toEqual({ pos_customer_id: null, tenant_id: null })
    expect((await link(f, sale2, {})).status).toBe(400)
    expect((await link(f, sale2, { posCustomerId: jane, tenantId: ann })).status).toBe(400)
  })

  it('another company: its sale is not found, and its customers and residents cannot be linked', async () => {
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    const theirSale = await saleRow(other)
    const theirCustomer = await customerRow(other, 'Zed', 'Elsewhere')
    const theirResident = await residentOf(other, 'Zoe', 'Elsewhere')
    const mine = await customerRow(f, 'Mine', 'Own')
    expect((await link(f, theirSale, { posCustomerId: mine })).status).toBe(404)
    const sale = await saleRow(f)
    expect((await link(f, sale, { posCustomerId: theirCustomer })).status).toBe(404)
    expect((await link(f, sale, { tenantId: theirResident })).status).toBe(404)
    expect((await db.query<any>(`SELECT pos_customer_id, tenant_id FROM pos_transactions WHERE id = $1`, [sale])).rows[0])
      .toEqual({ pos_customer_id: null, tenant_id: null })
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_transactions WHERE id = $1`, [theirSale])).rows[0].pos_customer_id).toBeNull()
  })

  it('someone found outside the company gets a record here holding their name (and only what was typed in full), and the sale is theirs', async () => {
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    await customerRow(other, 'Zed', 'Elsewhere', { email: 'zed@elsewhere.com', phone: '602-555-0199' })
    const sale = await saleRow(f)
    // By part of the name: their name only crosses over.
    const byName = (await searchAt(f, 'elsew')).body.data.find((p: any) => p.kind === 'elsewhere')
    const res = await link(f, sale, { match: { pick: byName.pick } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const row = (await db.query<any>(`SELECT landlord_id, first_name, last_name, email, phone FROM pos_customers WHERE id = $1`, [res.body.data.pos_customer_id])).rows[0]
    expect(row).toEqual({ landlord_id: f.landlordId, first_name: 'Zed', last_name: 'Elsewhere', email: null, phone: null })
    // Typed in full, the email they typed comes too — on a fresh company.
    const g = await seedPosFixture()
    const sale2 = await saleRow(g)
    const byEmail = (await searchAt(g, 'zed@elsewhere.com')).body.data.find((p: any) => p.kind === 'elsewhere')
    const res2 = await link(g, sale2, { match: { pick: byEmail.pick } })
    expect(res2.status, JSON.stringify(res2.body)).toBe(200)
    expect((await db.query<any>(`SELECT email, phone FROM pos_customers WHERE id = $1`, [res2.body.data.pos_customer_id])).rows[0])
      .toEqual({ email: 'zed@elsewhere.com', phone: null })
    // A pick that is not one the search handed out is nobody.
    expect((await link(f, sale, { match: { pick: 'not-a-real-pick-not-a-real-pick-not-a-real-pick' } })).status).toBe(404)
  })
})

// Defect 3: History and the actions on a sale loaded it by id with only the
// company checked — a cashier assigned to one park reached another park's sales.
describe('10/2 a cashier works only the properties they are assigned to', () => {
  it('history, refund, void, receipt email and the customer link stop at their properties', async () => {
    const f = await seedPosFixture()
    const parkB = await secondProperty(f)
    const desk = await cashierFor(f, [f.propertyId])
    const mineA = await saleRow(f, { propertyId: f.propertyId })
    const notMine = await saleRow(f, { propertyId: parkB })
    const legacy = await saleRow(f, { propertyId: null })
    const bob = await customerRow(f, 'Bob', 'Smith')
    const as = (r: request.Test) => r.set('Authorization', `Bearer ${desk}`)

    const all = await as(request(buildApp()).get('/api/pos/transactions'))
    expect(all.status).toBe(200)
    expect(all.body.data.map((t: any) => t.id)).toEqual([mineA])
    expect((await as(request(buildApp()).get(`/api/pos/transactions?propertyId=${parkB}`))).status).toBe(403)
    expect((await as(request(buildApp()).get(`/api/pos/transactions/sales?propertyId=${parkB}`))).status).toBe(403)
    expect((await as(request(buildApp()).post(`/api/pos/transactions/${notMine}/refund`)).send({ refundMethod: 'cash' })).status).toBe(403)
    expect((await as(request(buildApp()).post(`/api/pos/transactions/${notMine}/void`)).send({})).status).toBe(403)
    expect((await as(request(buildApp()).post(`/api/pos/transactions/${legacy}/void`)).send({})).status).toBe(403)
    expect((await as(request(buildApp()).post(`/api/pos/transactions/${notMine}/email-receipt`)).send({ email: 'a@example.com' })).status).toBe(403)
    expect((await link(f, notMine, { posCustomerId: bob }, desk)).status).toBe(403)
    expect((await searchAt(f, 'Bob', parkB, desk)).status).toBe(403)
    expect(emailPosReceiptMock).not.toHaveBeenCalled()
    expect((await db.query<any>(`SELECT status, pos_customer_id FROM pos_transactions WHERE id = $1`, [notMine])).rows[0])
      .toEqual({ status: 'completed', pos_customer_id: null })
    // Their own park works.
    expect((await link(f, mineA, { posCustomerId: bob }, desk)).status).toBe(200)
    expect((await searchAt(f, 'Bob', f.propertyId, desk)).status).toBe(200)
    expect((await as(request(buildApp()).post(`/api/pos/transactions/${mineA}/void`)).send({})).status).toBe(200)
  })

  // Review fix: the reader's answer loaded the sale with only the company
  // checked, and can email its receipt, keep a card on its customer and name
  // their record.
  it('the reader\'s answer stops at their properties too — no receipt, no card kept, no name set on another park\'s sale', async () => {
    const f = await seedPosFixture()
    const parkB = await secondProperty(f)
    const desk = await cashierFor(f, [f.propertyId])
    const { stripeReaderId } = await seedTerminalReader(f)
    const standIn = await customerRow(f, 'Card', 'Customer', { fromCard: true })
    const notMine = await saleRow(f, { propertyId: parkB, posCustomerId: standIn, paymentMethod: 'card', pi: 'pi_park_b' })
    const mine = await saleRow(f, { propertyId: f.propertyId, posCustomerId: standIn, paymentMethod: 'card', pi: 'pi_park_a' })
    const answerFor = (saleId: string) => request(buildApp())
      .get(`/api/pos/terminal/readers/${stripeReaderId}/save-card-answer?transactionId=${saleId}`).set('Authorization', `Bearer ${desk}`)
    readSaveCardAnswerMock.mockResolvedValue({ answered: true, yes: true, name: 'Someone Else', email: 'x@example.com' })
    expect((await answerFor(notMine)).status).toBe(403)
    expect(readSaveCardAnswerMock).not.toHaveBeenCalled()
    expect(emailPosReceiptMock).not.toHaveBeenCalled()
    expect(saveCardForCustomerMock).not.toHaveBeenCalled()
    expect((await db.query<any>(`SELECT first_name, last_name, email FROM pos_customers WHERE id = $1`, [standIn])).rows[0])
      .toEqual({ first_name: 'Card', last_name: 'Customer', email: null })
    // Their own park's sale is answered.
    readSaveCardAnswerMock.mockResolvedValue({ answered: false })
    const ok = await answerFor(mine)
    expect(ok.status).toBe(200)
    expect(ok.body.data).toEqual({ answered: false })
  })

  it('the "On file" lookup and starting a card charge stop at their properties too', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const parkB = await secondProperty(f)
    const desk = await cashierFor(f, [f.propertyId])
    const bob = await customerRow(f, 'Bob', 'Smith')
    const itemId = await seedPosItem(f, { sellPrice: 5 })
    const as = (r: request.Test) => r.set('Authorization', `Bearer ${desk}`)
    expect((await as(request(buildApp()).get(`/api/pos/card-on-file?propertyId=${parkB}&posCustomerId=${bob}`))).status).toBe(403)
    expect((await as(request(buildApp()).get(`/api/pos/card-on-file?posCustomerId=${bob}`))).status).toBe(403)
    const charge = await as(request(buildApp()).post('/api/pos/terminal/payment-intents'))
      .send({ propertyId: parkB, items: [{ id: itemId, name: 'Ice', qty: 1, price: 5 }] })
    expect(charge.status).toBe(403)
    expect(createCardPresentPaymentIntentMock).not.toHaveBeenCalled()
    // At their own park the lookup answers (nobody's card here).
    const own = await as(request(buildApp()).get(`/api/pos/card-on-file?propertyId=${f.propertyId}&posCustomerId=${bob}`))
    expect(own.status, JSON.stringify(own.body)).toBe(200)
    expect(own.body.data).toBeNull()
  })
})

describe('10/2 typing a name at the register finds the person', () => {
  it('finds this property\'s residents by part of a last name, with their site; a former resident says so; under two letters finds nothing', async () => {
    const f = await seedPosFixture()
    const nic = await residentOf(f, 'Nicholas', 'Rhoades', { site: 'MH 02' })
    await residentOf(f, 'Ray', 'Rhodes', { site: '14', status: 'terminated' })
    const parkB = await secondProperty(f)
    // Another property's resident is not listed as this register's own — no
    // site, no "resident" — only as anyone else on GAM is: a name and a hint.
    await residentOf(f, 'Rhonda', 'Elsewhere', { propertyId: parkB })
    const res = await searchAt(f, 'rho')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.map((p: any) => [p.name, p.hint, p.kind])).toEqual([
      ['Nicholas Rhoades', 'resident · Site MH 02', 'resident'],
      ['Ray Rhodes', 'former resident · Site 14', 'resident'],
      ['Rhonda Elsewhere', 't•••@test.dev', 'elsewhere'],
    ])
    expect(res.body.data[0]).toMatchObject({ key: `t:${nic}`, kind: 'resident', tenantId: nic })
    expect((await searchAt(f, 'r')).body.data).toEqual([])
    expect((await searchAt(f, 'zz')).body.data).toEqual([])
  })

  it('every word must match; 3+ digits match inside a phone; unnamed card records are hidden; a printed card name shows its card', async () => {
    const f = await seedPosFixture()
    await customerRow(f, 'Jane', 'Doe', { phone: '(602) 555-0101' })
    await customerRow(f, 'Jane', 'Smith', { email: 'jsmith@example.com' })
    const standIn = await customerRow(f, 'Card', 'Customer', { fromCard: true })
    await cardRow(f, standIn, 'fp_hidden', '9999')
    const printed = await customerRow(f, 'Pat', 'Card', { fromCard: true })
    await cardRow(f, printed, 'fp_pat', '4321', 'PAT CARD')
    const names = async (q: string) => (await searchAt(f, q)).body.data.map((p: any) => p.name)
    expect(await names('jane')).toEqual(['Jane Doe', 'Jane Smith'])
    expect(await names('jane do')).toEqual(['Jane Doe'])
    expect(await names('555-01')).toEqual(['Jane Doe'])
    expect(await names('jsmith')).toEqual(['Jane Smith'])
    expect(await names('card')).toEqual(['Pat Card'])
    const hints = (await searchAt(f, 'jane')).body.data.map((p: any) => p.hint)
    expect(hints).toEqual(['phone ••0101', 'jsmith@example.com'])
    expect((await searchAt(f, 'pat')).body.data[0]).toMatchObject({ kind: 'customer', customerId: printed, hint: 'card ••4321' })
  })

  it('a resident\'s register record shows as the resident, under their account name', async () => {
    const f = await seedPosFixture()
    const ann = await residentOf(f, 'Ann', 'Resident')
    const sale = await saleRow(f)
    const linked = await link(f, sale, { tenantId: ann })
    const res = await searchAt(f, 'resident')
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toMatchObject({ kind: 'resident', tenantId: ann, customerId: linked.body.data.pos_customer_id, name: 'Ann Resident' })
  })

  // 10/2 (Nic, settled): "If there's five Bobs next door... I type Bob and then
  // I remember the last name from a visual cue from seeing the five Bobs pop
  // down... If they're a point of sale customer, it doesn't matter."
  it('people at other companies are found by part of a name, or a whole email or phone — a name and a masked hint, nothing else', async () => {
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    const zedId = await customerRow(other, 'Zed', 'Elsewhere', { email: 'zed@elsewhere.com', phone: '602-555-0199' })
    const zoe = await residentOf(other, 'Zoe', 'Away', { email: 'zoe@away.com' })
    const bob1 = await customerRow(other, 'Bob', 'Marsh', { phone: '480-555-0111' })
    await customerRow(other, 'Bob', 'Tanner', { email: 'btanner@gmail.com' })
    await customerRow(other, 'Card', 'Customer', { fromCard: true })           // a nameless card is nobody
    await customerRow(other, 'Bob', 'Printed', { fromCard: true })             // an unconfirmed card record is nobody
    const bobs = (await searchAt(f, 'bob')).body.data
    // 10/2 (review): never digits of a stranger's phone the clerk did not type
    // — a masked email, else just "phone on file".
    expect(bobs.map((p: any) => [p.name, p.hint, p.kind])).toEqual([
      ['Bob Marsh', 'phone on file', 'elsewhere'],
      ['Bob Tanner', 'b•••@gmail.com', 'elsewhere'],
    ])
    // A whole email, a whole phone, part of a last name. A phone typed whole
    // comes back with its own last four (nothing the clerk did not type).
    expect((await searchAt(f, 'zed@elsewhere.com')).body.data.map((p: any) => [p.name, p.hint])).toEqual([['Zed Elsewhere', 'z•••@elsewhere.com']])
    expect((await searchAt(f, '602-555-0199')).body.data.map((p: any) => [p.name, p.hint])).toEqual([['Zed Elsewhere', 'phone ••0199']])
    expect((await searchAt(f, 'zed')).body.data.map((p: any) => [p.name, p.hint])).toEqual([['Zed Elsewhere', 'z•••@elsewhere.com']])
    expect((await searchAt(f, '480-555-0111')).body.data.map((p: any) => [p.name, p.hint])).toEqual([['Bob Marsh', 'phone ••0111']])
    expect((await searchAt(f, 'awa')).body.data.map((p: any) => [p.name, p.hint])).toEqual([['Zoe Away', 'z•••@away.com']])
    // Never a piece of an email or phone.
    expect((await searchAt(f, 'zed@else')).body.data).toEqual([])
    expect((await searchAt(f, '555-0199')).body.data).toEqual([])
    // Under three letters nothing outside is looked up.
    expect((await searchAt(f, 'bo')).body.data).toEqual([])
    // No company, no site, no "resident", no ids, no real email or phone.
    const all = await Promise.all(['bob', 'zed', 'zoe', 'zed@elsewhere.com'].map((q) => searchAt(f, q)))
    const raw = JSON.stringify(all.map((r) => r.body))
    for (const leak of [other.landlordId, other.propertyId, zedId, zoe, bob1, 'Test Property', 'resident', 'zed@elsewhere.com', 'zoe@away.com',
                        'btanner', '602-555-0199', '6025550199', '480-555-0111', 'Site']) {
      expect(raw).not.toContain(leak)
    }
    for (const hit of all.flatMap((r) => r.body.data)) {
      expect(hit).toMatchObject({ kind: 'elsewhere', tenantId: null, customerId: null, email: null, phone: null })
      expect(typeof hit.pick).toBe('string')
    }
  })

  it('picking someone from elsewhere makes a record HERE only — their name, and an email only when it was typed in full; picking again is the same record', async () => {
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    const zedId = await customerRow(other, 'Zed', 'Elsewhere', { email: 'zed@elsewhere.com', phone: '602-555-0199' })
    const zoe = await residentOf(other, 'Zoe', 'Away', { email: 'zoe@away.com' })
    const pickBody = (pick: string) => ({ propertyId: f.propertyId, match: { pick } })
    const post = (body: any, token = f.landlordToken) => request(buildApp()).post('/api/pos/customers').set('Authorization', `Bearer ${token}`).send(body)

    const zoeHit = (await searchAt(f, 'zoe')).body.data[0]
    const picked = await post(pickBody(zoeHit.pick))
    expect(picked.status, JSON.stringify(picked.body)).toBe(201)
    expect(picked.body.data).toMatchObject({ first_name: 'Zoe', last_name: 'Away', email: null, phone: null, kind: 'customer', tenant_id: null })
    const zoeRow = (await db.query<any>(`SELECT landlord_id, tenant_id, email, phone, elsewhere_ref FROM pos_customers WHERE id = $1`, [picked.body.data.id])).rows[0]
    expect(zoeRow).toMatchObject({ landlord_id: f.landlordId, tenant_id: null, email: null, phone: null })   // no tenancy link
    // Picked again: the same record, no second one.
    const again = await post(pickBody(zoeHit.pick))
    expect(again.body.data.id).toBe(picked.body.data.id)
    expect((await db.query(`SELECT 1 FROM pos_customers WHERE landlord_id = $1`, [f.landlordId])).rows).toHaveLength(1)
    // ...and from now on they are this company's own, listed once, by name.
    expect((await searchAt(f, 'zoe')).body.data.map((p: any) => [p.kind, p.name])).toEqual([['customer', 'Zoe Away']])

    // Typed in full: that email (and only that) comes with them.
    const zedHit = (await searchAt(f, 'zed@elsewhere.com')).body.data[0]
    const zed = await post(pickBody(zedHit.pick))
    expect(zed.body.data).toMatchObject({ first_name: 'Zed', last_name: 'Elsewhere', email: 'zed@elsewhere.com', phone: null })
    // The other company's records are untouched.
    expect((await db.query<any>(`SELECT landlord_id, email FROM pos_customers WHERE id = $1`, [zedId])).rows[0])
      .toEqual({ landlord_id: other.landlordId, email: 'zed@elsewhere.com' })
    expect((await db.query(`SELECT 1 FROM pos_customers WHERE tenant_id = $1`, [zoe])).rows).toHaveLength(0)

    // A pick is good only for the clerk and the company it was handed to.
    const g = await seedPosFixture()
    const stolen = await request(buildApp()).post('/api/pos/customers').set('Authorization', `Bearer ${g.landlordToken}`)
      .send({ propertyId: g.propertyId, match: { pick: zedHit.pick } })
    expect(stolen.status).toBe(404)
    expect(stolen.body.error).toMatch(/type their name again/i)
    expect((await post(pickBody('x'.repeat(60)))).status).toBe(404)
  })

  // 10/2 (review, "back out with one button and no side effects"): picking
  // someone from elsewhere makes their record here; taken back off (× or
  // Clear) before anything was sold, it goes again.
  it('a pick taken back off before anything was sold leaves nothing behind; one with a sale, or a record that was not a pick, stays', async () => {
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    await customerRow(other, 'Zed', 'Elsewhere', { email: 'zed@elsewhere.com', phone: '602-555-0199' })
    const pickZed = async () => {
      const hit = (await searchAt(f, 'zed@elsewhere.com')).body.data.find((p: any) => p.kind === 'elsewhere')
      expect(hit).toBeTruthy()
      return request(buildApp()).post('/api/pos/customers').set('Authorization', `Bearer ${f.landlordToken}`)
        .send({ propertyId: f.propertyId, match: { pick: hit.pick } })
    }
    const letGo = (id: string, token = f.landlordToken) => request(buildApp()).post(`/api/pos/customers/${id}/let-go`).set('Authorization', `Bearer ${token}`).send({})
    const first = await pickZed()
    expect(first.status).toBe(201)
    const a = first.body.data.id
    const gone = await letGo(a)
    expect(gone.status, JSON.stringify(gone.body)).toBe(200)
    expect(gone.body.data).toEqual({ letGo: true })
    const row = (await db.query<any>(`SELECT archived_at, email, notes FROM pos_customers WHERE id = $1`, [a])).rows[0]
    expect(row.archived_at).not.toBeNull()
    expect(row.email).toBeNull()                      // the address is free again…
    expect(row.notes).toMatch(/zed@elsewhere\.com/)   // …and kept on the closed record's note
    const list = await request(buildApp()).get(`/api/pos/customers?propertyId=${f.propertyId}`).set('Authorization', `Bearer ${f.landlordToken}`)
    expect(list.body.data.map((c: any) => c.id)).not.toContain(a)
    // Picked again later: a fresh record, with the email typed in full.
    const second = await pickZed()
    expect(second.status).toBe(201)
    const b = second.body.data.id
    expect(b).not.toBe(a)
    expect(second.body.data.email).toBe('zed@elsewhere.com')
    // With a sale on it, it stays.
    const itemId = await seedPosItem(f, { sellPrice: 5, stockQty: 999 })
    const sale = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, items: [{ id: itemId, name: 'Ice', qty: 1, price: 5 }], paymentMethod: 'cash', posCustomerId: b })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect((await letGo(b)).body.data).toEqual({ letGo: false })
    expect((await db.query<any>(`SELECT archived_at FROM pos_customers WHERE id = $1`, [b])).rows[0].archived_at).toBeNull()
    // A customer added by hand is never let go this way; nor is another company's.
    const manual = await customerRow(f, 'Hand', 'Added')
    expect((await letGo(manual)).body.data).toEqual({ letGo: false })
    const theirs = (await request(buildApp()).post('/api/pos/customers').set('Authorization', `Bearer ${other.landlordToken}`)
      .send({ propertyId: other.propertyId, firstName: 'Their', lastName: 'Own' })).body.data.id
    expect((await letGo(theirs)).body.data).toEqual({ letGo: false })
    expect((await db.query<any>(`SELECT archived_at FROM pos_customers WHERE id = $1`, [theirs])).rows[0].archived_at).toBeNull()
  })

  it('someone this company already has is linked, not copied: same email on a register customer here, or a resident of this company\'s other park', async () => {
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    // The same person on two companies' registers, by email.
    await customerRow(other, 'Pat', 'Rivers', { email: 'pat@rivers.com' })
    const mine = await customerRow(f, 'Patricia', 'Rivers', { email: 'pat@rivers.com' })
    // Already this company's own by email, so nobody from elsewhere is listed for it.
    expect((await searchAt(f, 'rivers')).body.data.map((p: any) => [p.kind, p.customerId])).toEqual([['customer', mine]])
    // A resident of this company's other park shows as a name only — and picked, is their resident record.
    const parkB = await secondProperty(f)
    const rhonda = await residentOf(f, 'Rhonda', 'Parkb', { propertyId: parkB, email: 'rhonda@parkb.com' })
    const hit = (await searchAt(f, 'parkb')).body.data[0]
    expect(hit).toMatchObject({ kind: 'elsewhere', name: 'Rhonda Parkb', email: null, tenantId: null })
    const picked = await request(buildApp()).post('/api/pos/customers').set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, match: { pick: hit.pick } })
    expect(picked.status, JSON.stringify(picked.body)).toBe(200)
    expect(picked.body.data).toMatchObject({ tenant_id: rhonda, kind: 'resident', existing: true })
  })

  it('returns only what the picker needs — never balances, lease dates or payment history', async () => {
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    await residentOf(f, 'Ann', 'Resident', { site: '3' })
    await customerRow(f, 'Andy', 'Walkin', { email: 'andy@example.com' })
    await customerRow(other, 'Anders', 'Faraway', { email: 'anders@far.com' })
    const res = await searchAt(f, 'an')
    expect(res.body.data).toHaveLength(2)
    for (const hit of res.body.data) {
      expect(Object.keys(hit).sort()).toEqual(['customerId', 'email', 'firstName', 'hint', 'key', 'kind', 'lastName', 'name', 'phone', 'tenantId'])
    }
    const far = (await searchAt(f, 'anders')).body.data
    expect(far).toHaveLength(1)
    expect(Object.keys(far[0]).sort()).toEqual(['customerId', 'email', 'firstName', 'hint', 'key', 'kind', 'lastName', 'name', 'phone', 'pick', 'tenantId'])
  })

  // 10/2 (privacy, settled): Nic's "five Bobs" is about NAMES. Outside this
  // company a contact detail matches only WHOLE — the whole address, the whole
  // part before the "@", the whole number. 10/2 (review): matching any piece of
  // one (six characters, then) let the hit-or-miss of each search, padded past
  // the masked hint's own ends, rebuild a stranger's email or phone one
  // character at a time.
  it('outside this company an email or phone matches only whole — never a piece of one, however long; names in part; at home everything in part', async () => {
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    await customerRow(other, 'Bob', 'Marsh', { phone: '480-555-0111' })
    await customerRow(other, 'Bob', 'Tanner', { email: 'btanner@gmail.com' })
    await customerRow(other, 'Bob', 'Local', { phone: '555-0177' })   // kept without an area code
    const found = async (q: string) => (await searchAt(f, q)).body.data.map((p: any) => [p.kind, p.name])
    // A name, in part.
    expect(await found('tann')).toEqual([['elsewhere', 'Bob Tanner']])
    expect(await found('bob')).toEqual([['elsewhere', 'Bob Local'], ['elsewhere', 'Bob Marsh'], ['elsewhere', 'Bob Tanner']])
    // An email: the whole address, or the whole part before the "@" — nothing less.
    for (const piece of ['gmail', 'gmail.com', '@gmail.com', 'r@gmail.com', 'btanne', 'tanner@gmail.com', 'bob @gmail.com', 'bob r@gmail.com']) {
      expect(await found(piece), piece).toEqual([])
    }
    expect(await found('btanner@gmail.com')).toEqual([['elsewhere', 'Bob Tanner']])
    expect(await found('BTanner@Gmail.com')).toEqual([['elsewhere', 'Bob Tanner']])
    expect(await found('btanner')).toEqual([['elsewhere', 'Bob Tanner']])
    expect(await found('bob btanner@gmail.com')).toEqual([['elsewhere', 'Bob Tanner']])
    // A phone: the whole number with its area code (or one kept without one, typed exactly).
    for (const piece of ['0111', '5-0111', '55-0111', '5550111', '550111', '80 555 0111', 'bob 550111', 'bob 5550111', '0177']) {
      expect(await found(piece), piece).toEqual([])
    }
    expect(await found('480-555-0111')).toEqual([['elsewhere', 'Bob Marsh']])
    expect(await found('480 555 0111')).toEqual([['elsewhere', 'Bob Marsh']])
    expect(await found('+1 (480) 555-0111')).toEqual([['elsewhere', 'Bob Marsh']])
    expect(await found('bob 480 555 0111')).toEqual([['elsewhere', 'Bob Marsh']])
    expect(await found('555-0177')).toEqual([['elsewhere', 'Bob Local']])
    // This company's own people still match on any part of an email or phone.
    await customerRow(f, 'Ann', 'Local', { email: 'ann@gmail.com', phone: '602-555-0123' })
    expect(await found('gmai')).toEqual([['customer', 'Ann Local']])
    expect(await found('0123')).toEqual([['customer', 'Ann Local']])
    expect(await found('ann@')).toEqual([['customer', 'Ann Local']])
    // So do the people who lease with this company at its other parks (listed
    // by name and a masked hint, as for anyone not at this property).
    const parkB = await secondProperty(f)
    await residentOf(f, 'Rita', 'Parkb', { propertyId: parkB, phone: '928-555-0177' })
    expect(await found('928-555-01')).toEqual([['elsewhere', 'Rita Parkb']])
  })

  // The review's own probe: the masked hint hands over the email's domain and
  // the phone's last four; padding each guess past them answered yes or no.
  // 10/2 (review, again): and the last four themselves were the shortcut — with
  // the area code known, ~1,000 whole-number guesses rebuilt the number. A
  // name search shows no phone digits at all.
  it('a stranger\'s email or phone cannot be grown out of the masked hint, one character at a time', async () => {
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    await customerRow(other, 'Bob', 'Smith', { email: 'zqprivate77@gmail.com', phone: '602-555-0199' })
    await customerRow(other, 'Bob', 'Nomail', { phone: '602-555-0177' })
    const hit = async (q: string) => (await searchAt(f, q)).body.data.filter((p: any) => p.kind === 'elsewhere').length
    expect((await searchAt(f, 'bob smith')).body.data[0]).toMatchObject({ name: 'Bob Smith', hint: 'z•••@gmail.com' })
    expect((await searchAt(f, 'bob nomail')).body.data[0]).toMatchObject({ name: 'Bob Nomail', hint: 'phone on file' })
    const named = (await searchAt(f, 'bob')).body.data
    expect(named).toHaveLength(2)
    for (const p of named) expect(`${p.hint} ${p.name} ${p.email} ${p.phone}`).not.toMatch(/\d/)
    for (const guess of ['bob @gmail.com', 'bob 7@gmail.com', 'bob 77@gmail.com', 'bob 8@gmail.com', 'bob e77@gmail.com',
                         'bob 990199', 'bob 550199', 'bob 5550199', 'bob 25550199', 'bob 025550199']) {
      expect(await hit(guess), guess).toBe(0)
    }
    expect(await hit('bob zqprivate77@gmail.com')).toBe(1)
    expect(await hit('bob 602 555 0199')).toBe(1)
  })

  it('a search over 120 characters is refused, and so is more than one search at once', async () => {
    const f = await seedPosFixture()
    expect((await searchAt(f, 'b'.repeat(121))).status).toBe(400)
    expect((await searchAt(f, 'bob' + ' '.repeat(118))).status).toBe(400)
    expect((await searchAt(f, 'b'.repeat(120))).status).toBe(200)
    const two = await request(buildApp()).get(`/api/pos/people?propertyId=${f.propertyId}&q=bob&q=ann`).set('Authorization', `Bearer ${f.landlordToken}`)
    expect(two.status).toBe(400)
  })

  it('looking outside the company is limited to 40 searches in ten minutes per person; past that only this company\'s people come back', async () => {
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    await customerRow(other, 'Zed', 'Elsewhere', { email: 'zed@elsewhere.com' })
    await customerRow(f, 'Zelda', 'Zedmore')
    for (let i = 0; i < 40; i++) {
      const r = await searchAt(f, 'zed')
      expect(r.body.data.map((p: any) => p.kind)).toEqual(['customer', 'elsewhere'])
      expect(r.body.elsewhereLimited).toBeUndefined()
    }
    const limited = await searchAt(f, 'zed')
    expect(limited.status).toBe(200)
    expect(limited.body.data.map((p: any) => p.name)).toEqual(['Zelda Zedmore'])
    // 10/2 (review): and it says so — the picker tells the clerk why fewer
    // people show, instead of quietly showing them.
    expect(limited.body.elsewhereLimited).toBe(true)
    // Any search outside is limited, not just the one repeated.
    expect((await searchAt(f, 'elsewhere')).body.data).toEqual([])
    // Another person's count is their own (and to them both of these are from elsewhere).
    const g = await seedPosFixture()
    expect((await searchAt(g, 'zed')).body.data.map((p: any) => p.name)).toEqual(['Zelda Zedmore', 'Zed Elsewhere'])
  })

  // Review fix: the limit and the search each read the typed text their own
  // way, so padding it (or dressing it in invisible characters) could make a
  // search the limit never counted. One reading now: normalizePeopleQuery.
  it('padding, tabs, odd spaces and invisible characters are the same search — every one counts toward the limit', async () => {
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    await customerRow(other, 'Zed', 'Elsewhere', { email: 'zed@elsewhere.com' })
    const padded = [
      '   zed   ', 'zed' + ' '.repeat(100), '\tzed\n', '\u00a0zed\u2003', 'z\u200bed', '\ufeffzed\u200d', 'ZED', ' z e d elsewhere ',
    ]
    for (let i = 0; i < 40; i++) {
      const r = await searchAt(f, padded[i % padded.length])
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.body.data.map((p: any) => p.name)).toEqual(['Zed Elsewhere'])
    }
    for (const q of padded) {
      const r = await searchAt(f, q)
      expect(r.status).toBe(200)
      expect(JSON.stringify(r.body)).not.toContain('Zed')
    }
  })

  it('picking someone already found is not a search: it works past the limit, and only with the pick the search handed out', async () => {
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    await customerRow(other, 'Zed', 'Elsewhere', { phone: '602-555-0199' })
    const hit = (await searchAt(f, 'zed')).body.data[0]
    for (let i = 0; i < 40; i++) await searchAt(f, 'zed')
    expect((await searchAt(f, 'zed')).body.data).toEqual([])
    const sale = await saleRow(f)
    const res = await link(f, sale, { match: { pick: hit.pick } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect((await db.query<any>(`SELECT first_name, phone FROM pos_customers WHERE id = $1`, [res.body.data.pos_customer_id])).rows[0])
      .toEqual({ first_name: 'Zed', phone: null })
    // The old way of naming someone from elsewhere (their email or phone) is not accepted.
    expect((await link(f, sale, { match: { phone: '6025550199' } })).status).toBe(400)
  })

  // Review fix: each query cut its rows at 40 before anything was ranked, so a
  // big park's last-name match could fall off the list entirely.
  it('the last name typed comes first even with more than 40 loose matches among the customers', async () => {
    const f = await seedPosFixture()
    const names = Array.from({ length: 55 }, (_, i) => `Joanna${i}`)
    await db.query(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, created_from)
       VALUES ${names.map((_, i) => `($1, $${i + 2}, 'Brown', 'manual')`).join(', ')}`, [f.landlordId, ...names])
    await customerRow(f, 'Andy', 'Zimmer')
    await customerRow(f, 'Bo', 'Andrews')
    const res = await searchAt(f, 'an')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(8)
    expect(res.body.data.slice(0, 3).map((p: any) => p.name)).toEqual(['Bo Andrews', 'Andy Zimmer', 'Joanna0 Brown'])
  })

  it('the last name typed comes first even with more than 40 loose matches among the residents', async () => {
    const f = await seedPosFixture()
    for (let i = 0; i < 42; i++) await residentOf(f, `Dana${i}`, 'Smith')
    // The last of them in tenant order — where a cut at 40 that had not
    // ranked anything yet would drop him.
    const c = await db.connect()
    try {
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
         VALUES ($1, 'x', 'tenant', 'Al', 'Danforth', TRUE) RETURNING id`, [`al-${randomUUID()}@t.dev`])
      const danforth = 'ffffffff-ffff-4fff-bfff-ffffffffffff'
      await c.query(`INSERT INTO tenants (id, user_id) VALUES ($1, $2)`, [danforth, u.rows[0].id])
      const unitId = await seedUnit(c, { propertyId: f.propertyId, landlordId: f.landlordId })
      await c.query(`UPDATE units SET unit_number = '7' WHERE id = $1`, [unitId])
      await seedLeaseTenant(c, { leaseId: await seedLease(c, { unitId, landlordId: f.landlordId, status: 'active' }), tenantId: danforth })
    } finally { c.release() }
    const res = await searchAt(f, 'dan')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(8)
    expect(res.body.data[0]).toMatchObject({ name: 'Al Danforth', hint: 'resident · Site 7' })
  })
})

// Review (b): "N previous purchases" after a sale counted every company's sales
// that named the resident — a resident at two companies brought the other
// company's register history onto this one's screen.
describe('10/2 the count of previous purchases is this company\'s only', () => {
  it('a resident who also buys at another company sees only this company\'s purchases counted', async () => {
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    const tenantId = await residentOf(f, 'Dual', 'Resident')
    const c = await db.connect()
    try {
      const unitId = await seedUnit(c, { propertyId: other.propertyId, landlordId: other.landlordId })
      await seedLeaseTenant(c, { leaseId: await seedLease(c, { unitId, landlordId: other.landlordId, status: 'active' }), tenantId })
    } finally { c.release() }
    await saleRow(other, { tenantId })
    await saleRow(other, { tenantId })
    await saleRow(other, { tenantId })
    const itemId = await seedPosItem(f, { sellPrice: 5, stockQty: 9 })
    const ring = () => request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ items: [{ id: itemId, name: 'Ice', qty: 1, price: 5, tax: 0 }], paymentMethod: 'cash', propertyId: f.propertyId,
              tenantId, subtotal: 5, taxAmount: 0, total: 5 })
    const first = await ring()
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    expect(first.body.data.customer).toMatchObject({ isResident: true, tenantId, priorPurchases: 0 })
    const second = await ring()
    expect(second.body.data.customer.priorPurchases).toBe(1)
    // The other company's own count is untouched by this one's.
    const otherItem = await seedPosItem(other, { sellPrice: 5, stockQty: 9 })
    const there = await request(buildApp()).post('/api/pos/transactions').set('Authorization', `Bearer ${other.landlordToken}`)
      .send({ items: [{ id: otherItem, name: 'Ice', qty: 1, price: 5, tax: 0 }], paymentMethod: 'cash', propertyId: other.propertyId,
              tenantId, subtotal: 5, taxAmount: 0, total: 5 })
    expect(there.status, JSON.stringify(there.body)).toBe(201)
    expect(there.body.data.customer.priorPurchases).toBe(3)
  })
})

describe('10/2 one record per person: adding, editing, merging', () => {
  it('"Add new" picks the person already here — a phone on file, or a resident\'s account email', async () => {
    const f = await seedPosFixture()
    const bob = await customerRow(f, 'Bob', 'Walker', { phone: '602-555-0123' })
    const ann = await residentOf(f, 'Ann', 'Resident', { email: 'ann@example.com' })
    const add = (body: any) => request(buildApp()).post('/api/pos/customers').set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, ...body })
    const byPhone = await add({ firstName: 'Robert', phone: '(602) 555-0123' })
    expect(byPhone.status).toBe(200)
    expect(byPhone.body.data).toMatchObject({ id: bob, existing: true, kind: 'customer', first_name: 'Bob' })
    const byResidentEmail = await add({ firstName: 'A', email: 'ANN@example.com' })
    expect(byResidentEmail.status).toBe(200)
    expect(byResidentEmail.body.data).toMatchObject({ existing: true, kind: 'resident', tenant_id: ann, first_name: 'Ann', last_name: 'Resident' })
    expect((await add({ lastName: 'Nofirst' })).status).toBe(400)
  })

  it('a resident\'s record is not edited at the register, and a receipt email does not become theirs', async () => {
    const f = await seedPosFixture()
    const ann = await residentOf(f, 'Ann', 'Resident')
    const sale = await saleRow(f)
    const record = (await link(f, sale, { tenantId: ann })).body.data.pos_customer_id
    const edit = await request(buildApp()).patch(`/api/pos/customers/${record}`).set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ firstName: 'Someone', email: 'else@example.com' })
    expect(edit.status).toBe(409)
    const rc = await request(buildApp()).post(`/api/pos/transactions/${sale}/email-receipt`).set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ email: 'family@example.com' })
    expect(rc.status, JSON.stringify(rc.body)).toBe(200)
    expect((await db.query<any>(`SELECT email, archived_at FROM pos_customers WHERE id = $1`, [record])).rows[0]).toEqual({ email: null, archived_at: null })
    // The Customers tab lists the record under their account name, as a resident.
    const list = await request(buildApp()).get(`/api/pos/customers?propertyId=${f.propertyId}`).set('Authorization', `Bearer ${f.landlordToken}`)
    expect(list.body.data.find((c: any) => c.id === record)).toMatchObject({ first_name: 'Ann', last_name: 'Resident', is_resident: true, tenant_id: ann, purchases: 1 })
  })

  it('a receipt sent to a resident\'s email from a card-only sale makes that card theirs; a named customer is not folded into a resident by an email', async () => {
    const f = await seedPosFixture()
    const ann = await residentOf(f, 'Ann', 'Resident', { email: 'ann@example.com' })
    const standIn = await customerRow(f, 'Card', 'Customer', { fromCard: true })
    await cardRow(f, standIn, 'fp_ann_card', '2222')
    const sale = await saleRow(f, { posCustomerId: standIn, paymentMethod: 'card' })
    const send = (id: string, email: string) => request(buildApp()).post(`/api/pos/transactions/${id}/email-receipt`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ email })
    expect((await send(sale, 'Ann@Example.com')).status).toBe(200)
    const after = (await db.query<any>(`SELECT pos_customer_id, tenant_id FROM pos_transactions WHERE id = $1`, [sale])).rows[0]
    expect(after.tenant_id).toBe(ann)
    expect((await db.query<any>(`SELECT tenant_id FROM pos_customers WHERE id = $1`, [after.pos_customer_id])).rows[0].tenant_id).toBe(ann)
    expect((await db.query<any>(`SELECT archived_at FROM pos_customers WHERE id = $1`, [standIn])).rows[0].archived_at).not.toBeNull()
    // Bob, named by the clerk, has his receipt sent to Ann's address: it goes, and Bob stays Bob.
    const bob = await customerRow(f, 'Bob', 'Walker')
    const bobSale = await saleRow(f, { posCustomerId: bob })
    expect((await send(bobSale, 'ann@example.com')).status).toBe(200)
    expect((await db.query<any>(`SELECT email, archived_at FROM pos_customers WHERE id = $1`, [bob])).rows[0]).toEqual({ email: null, archived_at: null })
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_transactions WHERE id = $1`, [bobSale])).rows[0].pos_customer_id).toBe(bob)
    // An address held by a closed record cannot be written twice — the receipt still goes.
    await db.query(`INSERT INTO pos_customers (landlord_id, first_name, last_name, email, archived_at) VALUES ($1,'Old','Record','old@example.com',NOW())`, [f.landlordId])
    const third = await saleRow(f, { posCustomerId: await customerRow(f, 'Cy', 'New') })
    const r = await send(third, 'old@example.com')
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.sentTo).toBe('old@example.com')
  })

  it('a merge never folds two residents together, and a stand-in folded into a resident carries the resident onto its sales', async () => {
    const f = await seedPosFixture()
    const ann = await residentOf(f, 'Ann', 'Resident')
    const ben = await residentOf(f, 'Ben', 'Resident')
    const annRec = (await link(f, await saleRow(f), { tenantId: ann })).body.data.pos_customer_id
    const benRec = (await link(f, await saleRow(f), { tenantId: ben })).body.data.pos_customer_id
    const merge = (loser: string, into: string) => request(buildApp()).post(`/api/pos/customers/${loser}/merge`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ into })
    expect((await merge(annRec, benRec)).status).toBe(409)
    const standIn = await customerRow(f, 'Card', 'Customer', { fromCard: true })
    const s = await saleRow(f, { posCustomerId: standIn, paymentMethod: 'card' })
    // Folding the resident's record INTO the stand-in: the survivor becomes the resident's.
    expect((await merge(annRec, standIn)).status).toBe(200)
    expect((await db.query<any>(`SELECT tenant_id FROM pos_customers WHERE id = $1`, [standIn])).rows[0].tenant_id).toBe(ann)
    expect((await db.query<any>(`SELECT tenant_id FROM pos_transactions WHERE id = $1`, [s])).rows[0].tenant_id).toBe(ann)
  })

  // Review fix: a receipt sent to a resident's address folded the sale's card
  // record into the resident without the printed-name rule linking uses — Jane
  // Doe's card and sales became Nic's.
  it('a receipt emailed to a resident or a customer from a card printed with another last name moves nothing', async () => {
    const f = await seedPosFixture()
    const nic = await residentOf(f, 'Nicholas', 'Rhoades', { email: 'nic@example.com' })
    const bob = await customerRow(f, 'Bob', 'Smith', { email: 'bob@example.com' })
    const jane = await customerRow(f, 'Jane', 'Doe', { fromCard: true })
    await cardRow(f, jane, 'fp_jane_printed', '5555', 'JANE DOE')
    const s1 = await saleRow(f, { posCustomerId: jane, paymentMethod: 'card' })
    const s2 = await saleRow(f, { posCustomerId: jane, paymentMethod: 'card' })
    const send = (id: string, email: string) => request(buildApp()).post(`/api/pos/transactions/${id}/email-receipt`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ email })
    expect((await send(s1, 'nic@example.com')).status).toBe(200)
    expect((await send(s2, 'bob@example.com')).status).toBe(200)
    expect(emailPosReceiptMock).toHaveBeenCalledTimes(2)
    expect((await db.query<any>(`SELECT pos_customer_id, tenant_id FROM pos_transactions WHERE id = ANY($1::uuid[]) ORDER BY created_at`, [[s1, s2]])).rows)
      .toEqual([{ pos_customer_id: jane, tenant_id: null }, { pos_customer_id: jane, tenant_id: null }])
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_customer_cards WHERE fingerprint = 'fp_jane_printed'`)).rows[0].pos_customer_id).toBe(jane)
    expect((await db.query<any>(`SELECT email, archived_at FROM pos_customers WHERE id = $1`, [jane])).rows[0]).toEqual({ email: null, archived_at: null })
    expect((await db.query<any>(`SELECT COUNT(*)::int AS n FROM pos_customers WHERE tenant_id = $1`, [nic])).rows[0].n).toBe(0)
    expect((await db.query<any>(`SELECT COUNT(*)::int AS n FROM pos_transactions WHERE pos_customer_id = $1`, [bob])).rows[0].n).toBe(0)
  })

  // Review fix: the reader now asks a picked customer for an email too, and the
  // emailed address folded whoever the sale named into whoever held it.
  it('a customer the clerk picked who types someone else\'s email on the reader gets the receipt and stays themselves; a nameless card named and given a known email at once is that person', async () => {
    const f = await seedPosFixture({ withConnectAccount: true })
    const { stripeReaderId } = await seedTerminalReader(f)
    const itemId = await seedPosItem(f, { sellPrice: 5, stockQty: 999 })
    const jane = await customerRow(f, 'Jane', 'Doe', { email: 'jane@example.com' })
    const bob = await customerRow(f, 'Bob', 'Walker', { phone: '602-555-0123' })
    const answer = (saleId: string) => request(buildApp())
      .get(`/api/pos/terminal/readers/${stripeReaderId}/save-card-answer?transactionId=${saleId}`).set('Authorization', `Bearer ${f.landlordToken}`)
    const sale = await tapSale(f, itemId, 5, 'pi_bob_reader', { fingerprint: 'fp_bob_reader', last4: '4444' }, { posCustomerId: bob, stripeReaderId })
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    expect(sale.body.data.customer.asks).toMatchObject({ askName: false, askEmail: true })
    readSaveCardAnswerMock.mockResolvedValueOnce({ answered: true, yes: null, name: null, email: 'jane@example.com' })
    expect((await answer(sale.body.data.id)).body.data).toMatchObject({ answered: true, receiptSentTo: 'jane@example.com' })
    // The History "Email receipt" button, the same.
    expect((await request(buildApp()).post(`/api/pos/transactions/${sale.body.data.id}/email-receipt`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ email: 'jane@example.com' })).status).toBe(200)
    expect(emailPosReceiptMock).toHaveBeenCalledTimes(2)
    expect((await db.query<any>(`SELECT email, archived_at FROM pos_customers WHERE id = $1`, [bob])).rows[0]).toEqual({ email: null, archived_at: null })
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_transactions WHERE id = $1`, [sale.body.data.id])).rows[0].pos_customer_id).toBe(bob)
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_customer_cards WHERE fingerprint = 'fp_bob_reader'`)).rows[0].pos_customer_id).toBe(bob)
    expect((await db.query<any>(`SELECT COUNT(*)::int AS n FROM pos_transactions WHERE pos_customer_id = $1`, [jane])).rows[0].n).toBe(0)

    // A phone-wallet tap (no name on it) answered with a name AND Jane's email
    // together: the customer told the reader who they are — the card is Jane's.
    const wallet = await tapSale(f, itemId, 5, 'pi_wallet_jane', { fingerprint: 'fp_wallet_jane', last4: '1212', wallet: { type: 'apple_pay' } }, { stripeReaderId })
    expect(wallet.status).toBe(201)
    const nameless = wallet.body.data.customer.id
    expect(wallet.body.data.customer.asks).toMatchObject({ askName: true, askEmail: true })
    readSaveCardAnswerMock.mockResolvedValueOnce({ answered: true, yes: null, name: 'Jane Doe', email: 'jane@example.com' })
    expect((await answer(wallet.body.data.id)).body.data).toMatchObject({ receiptSentTo: 'jane@example.com', nameSet: 'Jane Doe' })
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_transactions WHERE id = $1`, [wallet.body.data.id])).rows[0].pos_customer_id).toBe(jane)
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_customer_cards WHERE fingerprint = 'fp_wallet_jane'`)).rows[0].pos_customer_id).toBe(jane)
    expect((await db.query<any>(`SELECT archived_at FROM pos_customers WHERE id = $1`, [nameless])).rows[0].archived_at).not.toBeNull()
  })
})

// ── 10/2 (review): a register cart names only this company's person ──────
//
// The open-cart copy kept on the server took any tenant or customer id it was
// sent, and reading the cart back printed that person's name — a clerk who
// knew a tenant's id could read their name; a cashier could read or change
// another park's cart.
describe('10/2 an open cart names only this company\'s person, at a property the caller works', () => {
  it('opening a cart with somebody else\'s person stores nobody; reading it shows no name', async () => {
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    const theirs = await customerRow(other, 'Zed', 'Elsewhere')
    const strangerTenant = await residentOf(other, 'Sam', 'Stranger')
    for (const who of [{ posCustomerId: theirs }, { tenantId: strangerTenant }]) {
      const opened = await request(buildApp()).post('/api/pos/sessions').set('Authorization', `Bearer ${f.landlordToken}`)
        .send({ propertyId: f.propertyId, ...who })
      expect(opened.status, JSON.stringify(opened.body)).toBe(200)
      expect(opened.body.data).toMatchObject({ pos_customer_id: null, tenant_id: null })
    }
    // A row written before this fix still prints no stranger's name.
    const legacy = (await db.query<{ id: string }>(
      `INSERT INTO pos_sessions (property_id, landlord_id, opened_by_user_id, tenant_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [f.propertyId, f.landlordId, f.landlordUserId, strangerTenant])).rows[0].id
    await db.query(`INSERT INTO pos_session_items (session_id, item_name, qty, unit_price, subtotal) VALUES ($1,'A',1,5,5)`, [legacy])
    const one = await request(buildApp()).get(`/api/pos/sessions/${legacy}`).set('Authorization', `Bearer ${f.landlordToken}`)
    expect(one.status).toBe(200)
    expect(one.body.data.session.customer_name).toBeNull()
    const list = await request(buildApp()).get(`/api/pos/sessions?status=open&propertyId=${f.propertyId}`).set('Authorization', `Bearer ${f.landlordToken}`)
    expect(JSON.stringify(list.body)).not.toContain('Stranger')
    // This company's own customer is stored and named.
    const bob = await customerRow(f, 'Bob', 'Smith')
    const mine = await request(buildApp()).post('/api/pos/sessions').set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, posCustomerId: bob })
    expect(mine.body.data.pos_customer_id).toBe(bob)
    const back = await request(buildApp()).get(`/api/pos/sessions/${mine.body.data.id}`).set('Authorization', `Bearer ${f.landlordToken}`)
    expect(back.body.data.session.customer_name).toBe('Bob Smith')
  })

  it('changing a cart to somebody else\'s person is refused; a cashier reaches only their own park\'s carts', async () => {
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    const theirs = await customerRow(other, 'Zed', 'Elsewhere')
    const bob = await customerRow(f, 'Bob', 'Smith')
    const sId = await seedOpenSession(f)
    const patch = (body: any, token = f.landlordToken, id = sId) =>
      request(buildApp()).patch(`/api/pos/sessions/${id}`).set('Authorization', `Bearer ${token}`).send(body)
    const refused = await patch({ posCustomerId: theirs })
    expect(refused.status).toBe(404)
    expect(refused.body.error).toMatch(/not on this register/i)
    expect((await db.query<any>(`SELECT pos_customer_id FROM pos_sessions WHERE id = $1`, [sId])).rows[0].pos_customer_id).toBeNull()
    expect((await patch({ posCustomerId: bob })).status).toBe(200)

    const parkB = await secondProperty(f)
    const desk = await cashierFor(f, [parkB])
    expect((await patch({ notes: 'mine now' }, desk)).status).toBe(403)
    expect((await request(buildApp()).get(`/api/pos/sessions/${sId}`).set('Authorization', `Bearer ${desk}`)).status).toBe(403)
    expect((await request(buildApp()).get(`/api/pos/sessions?status=open&propertyId=${f.propertyId}`).set('Authorization', `Bearer ${desk}`)).status).toBe(403)
    const theirList = await request(buildApp()).get('/api/pos/sessions?status=open').set('Authorization', `Bearer ${desk}`)
    expect(theirList.status).toBe(200)
    expect(theirList.body.data).toEqual([])
    expect((await db.query<any>(`SELECT notes FROM pos_sessions WHERE id = $1`, [sId])).rows[0].notes).toBeNull()
  })

  it('a cashier cannot add, change or remove lines on another park\'s cart, nor discard or close it', async () => {
    const f = await seedPosFixture()
    const sId = await seedOpenSession(f)
    const itemId = await seedPosItem(f, { sellPrice: 5 })
    const line = (await request(buildApp()).post(`/api/pos/sessions/${sId}/items`).set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ itemId, itemName: 'Ice', qty: 1, unitPrice: 5 }))
    expect(line.status, JSON.stringify(line.body)).toBe(200)
    const lineId = line.body.data.id
    const parkB = await secondProperty(f)
    const desk = await cashierFor(f, [parkB])
    const as = (r: any) => r.set('Authorization', `Bearer ${desk}`)
    expect((await as(request(buildApp()).post(`/api/pos/sessions/${sId}/items`)).send({ itemId, itemName: 'Ice', qty: 2, unitPrice: 5 })).status).toBe(403)
    expect((await as(request(buildApp()).patch(`/api/pos/sessions/${sId}/items/${lineId}`)).send({ qty: 9 })).status).toBe(403)
    expect((await as(request(buildApp()).delete(`/api/pos/sessions/${sId}/items/${lineId}`))).status).toBe(403)
    expect((await as(request(buildApp()).post(`/api/pos/sessions/${sId}/void`)).send({ reason: 'x' })).status).toBe(403)
    const sale = await saleRow(f)
    expect((await as(request(buildApp()).post(`/api/pos/sessions/${sId}/complete`)).send({ transactionId: sale })).status).toBe(403)
    // Nothing changed.
    expect((await db.query<any>(`SELECT status FROM pos_sessions WHERE id = $1`, [sId])).rows[0].status).toBe('open')
    expect((await db.query<any>(`SELECT qty FROM pos_session_items WHERE session_id = $1`, [sId])).rows.map((r: any) => Number(r.qty))).toEqual([1])
    // A cashier of THIS park works it; a sale from another park does not close it.
    const deskA = await cashierFor(f, [f.propertyId])
    expect((await request(buildApp()).patch(`/api/pos/sessions/${sId}/items/${lineId}`).set('Authorization', `Bearer ${deskA}`).send({ qty: 2 })).status).toBe(200)
    const otherParkSale = await saleRow(f, { propertyId: parkB })
    const wrong = await request(buildApp()).post(`/api/pos/sessions/${sId}/complete`).set('Authorization', `Bearer ${f.landlordToken}`).send({ transactionId: otherParkSale })
    expect(wrong.status).toBe(409)
    expect((await request(buildApp()).post(`/api/pos/sessions/${sId}/complete`).set('Authorization', `Bearer ${deskA}`).send({ transactionId: sale })).status).toBe(200)
  })
})

// ── 10/2 (review): every refusal at the counter says what to press next ───
describe('10/2 staff-facing refusals are plain words with the next step', () => {
  it('a form the server cannot read is never answered with a parser path', async () => {
    const f = await seedPosFixture()
    const sale = await saleRow(f)
    const noName = await link(f, sale, { addNew: { firstName: '   ' } })
    expect(noName.status).toBe(400)
    expect(noName.body.error).toBe('Type at least a first name, then press Add customer.')
    const badEmail = await link(f, sale, { addNew: { firstName: 'Al', email: 'not-an-email' } })
    expect(badEmail.status).toBe(400)
    expect(badEmail.body.error).toMatch(/does not look right — check it, or leave it blank/)
    const gone = await link(f, '00000000-0000-4000-8000-000000000000', { posCustomerId: await customerRow(f, 'Al', 'Ok') })
    expect(gone.status).toBe(404)
    expect(gone.body.error).toMatch(/open History again/)
    const emptyTicket = await request(buildApp()).post('/api/pos/tickets').set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, posCustomerId: await customerRow(f, 'Bo', 'Ok'), items: [] })
    expect(emptyTicket.status).toBe(400)
    expect(emptyTicket.body.error).toMatch(/cart is empty — add what they are taking/)
    const merge = await request(buildApp()).post(`/api/pos/customers/${await customerRow(f, 'Cy', 'Ok')}/merge`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ into: 'nobody' })
    expect(merge.status).toBe(400)
    expect(merge.body.error).toMatch(/Pick the customer to merge into/)
    for (const r of [noName, badEmail, emptyTicket, merge]) expect(r.body.error).not.toMatch(/addNew|firstName|items:|into:/)
  })

  it('somebody picked from elsewhere who is only loosely tied here comes back by name — not with their account\'s phone or email', async () => {
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    const jo = await residentOf(other, 'Jo', 'Faraway', { email: 'jo@faraway.dev', phone: '602-555-0177' })
    // This company invited her email once and cancelled it.
    await db.query(`INSERT INTO pending_tenant_intents (landlord_id, tenant_id, property_id, cancelled_at) VALUES ($1,$2,$3,NOW())`,
      [f.landlordId, jo, f.propertyId])
    const hit = (await searchAt(f, 'faraway')).body.data.find((h: any) => h.kind === 'elsewhere')
    expect(hit).toBeTruthy()
    const made = await request(buildApp()).post('/api/pos/customers').set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ propertyId: f.propertyId, match: { pick: hit.pick } })
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300)
    expect(made.body.data).toMatchObject({ first_name: 'Jo', last_name: 'Faraway', email: null, phone: null })
    expect(JSON.stringify(made.body)).not.toMatch(/faraway\.dev|555-?0177/)
  })

  // 10/2 (review): the emailed receipt printed the email on a tenant's own GAM
  // account for anybody tied here in any way — a cancelled invite was enough.
  it('a receipt prints the account email only for somebody who leases here; otherwise the address it was sent to', async () => {
    const { renderPosReceiptPdf } = await import('../services/businessPdf')
    const pdf = vi.mocked(renderPosReceiptPdf)
    const f = await seedPosFixture()
    const other = await seedPosFixture()
    const jo = await residentOf(other, 'Jo', 'Faraway', { email: 'jo@faraway.dev' })
    await db.query(`INSERT INTO pending_tenant_intents (landlord_id, tenant_id, property_id, cancelled_at) VALUES ($1,$2,$3,NOW())`,
      [f.landlordId, jo, f.propertyId])
    const loose = await saleRow(f, { tenantId: jo })
    pdf.mockClear()
    const sent = await request(buildApp()).post(`/api/pos/transactions/${loose}/email-receipt`).set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ email: 'typed@counter.dev' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    expect((pdf.mock.calls[0][0] as any).customer).toMatchObject({ firstName: 'Jo', lastName: 'Faraway', email: 'typed@counter.dev' })
    expect(JSON.stringify(pdf.mock.calls[0][0])).not.toContain('jo@faraway.dev')

    // A resident who leases here: their account's email is theirs to print.
    const ann = await residentOf(f, 'Ann', 'Resident', { email: 'ann@lease.dev' })
    const leased = await saleRow(f, { tenantId: ann })
    pdf.mockClear()
    await request(buildApp()).post(`/api/pos/transactions/${leased}/email-receipt`).set('Authorization', `Bearer ${f.landlordToken}`)
      .send({ email: 'typed@counter.dev' })
    expect((pdf.mock.calls[0][0] as any).customer).toMatchObject({ firstName: 'Ann', email: 'ann@lease.dev' })
  })

  it('a merge of two different residents is refused with the next step', async () => {
    const f = await seedPosFixture()
    const ann = await residentOf(f, 'Ann', 'Resident')
    const ben = await residentOf(f, 'Ben', 'Resident')
    const a = (await link(f, await saleRow(f), { tenantId: ann })).body.data.pos_customer_id
    const b = (await link(f, await saleRow(f), { tenantId: ben })).body.data.pos_customer_id
    const res = await request(buildApp()).post(`/api/pos/customers/${a}/merge`).set('Authorization', `Bearer ${f.landlordToken}`).send({ into: b })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Those are two different residents, so their records stay apart — press Cancel. If a sale is on the wrong one, open it in History and pick the right person.')
  })
})
