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
  seedLandlord, seedProperty, seedTenant,
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
  cancelReaderActionMock, showCartOnReaderMock,
  startSaveCardPromptMock, readSaveCardAnswerMock, saveCardForCustomerMock, emailPosReceiptMock,
} = vi.hoisted(() => ({
  startSaveCardPromptMock: vi.fn(async () => true),
  readSaveCardAnswerMock:  vi.fn(async (): Promise<any> => ({ answered: false })),
  saveCardForCustomerMock: vi.fn(async () => undefined),
  emailPosReceiptMock:     vi.fn(async () => undefined),
  cancelReaderActionMock: vi.fn(async () => undefined),
  showCartOnReaderMock: vi.fn(async () => undefined),
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
  showCartOnReaderMock.mockClear()
  startSaveCardPromptMock.mockClear(); startSaveCardPromptMock.mockResolvedValue(true)
  readSaveCardAnswerMock.mockClear(); readSaveCardAnswerMock.mockResolvedValue({ answered: false })
  saveCardForCustomerMock.mockClear()
  emailPosReceiptMock.mockClear()
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
    expect(res.body.error).toMatch(/Exactly one of tenantId or posCustomerId/i)
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
    expect(res.body.error).toMatch(/not eligible for FlexCharge/i)
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
    expect(res.body.error).toMatch(/No FlexCharge account/i)
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
    expect(res.body.error).toMatch(/account is suspended/i)
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
    expect(res.body.error).toMatch(/different landlord/i)
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
    expect(res.body.error).toMatch(/items array required/i)
  })

  it('S70 cross-landlord guard: item_id belonging to another landlord → transaction inserts, victim stock NOT decremented', async () => {
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
    calculateCartTaxMock.mockResolvedValueOnce({
      subtotal: 10, taxAmount: 0,
      lines: [{ itemId: victimItemId, lineSubtotal: 10, lineTax: 0 }],
    })
    const res = await request(buildApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${f.landlordToken}`)
      .send({
        propertyId: f.propertyId,
        items: [{ id: victimItemId, name: 'Stolen', qty: 5, price: 10 }],
        paymentMethod: 'cash',
      })
    // Transaction inserts (cart isn't rejected; only stock decrement is gated)
    expect(res.status).toBe(201)
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
    expect(res.body.error).toMatch(new RegExp(`amount 999.*does not match.*${withCardFee(10)}`, 'i'))
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
    expect(res.body.error).toMatch(/not a POS terminal sale/i)
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
    expect(res.body.error).toMatch(/different landlord/i)
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
    expect(res.body.error).toMatch(/no originating flex_charge_transactions row/i)

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
    expect(over.body.error).toMatch(/exceeds the sale total/i)

    // First partial of 70 succeeds (remaining 30).
    await request(buildApp()).post(`/api/pos/transactions/${txId}/refund`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ amount: 70, refundMethod: 'cash' }).expect(200)

    // A second partial of 40 exceeds the remaining 30 → 400.
    const second = await request(buildApp()).post(`/api/pos/transactions/${txId}/refund`)
      .set('Authorization', `Bearer ${f.landlordToken}`).send({ amount: 40, refundMethod: 'cash' })
    expect(second.status).toBe(400)
    expect(second.body.error).toMatch(/remaining refundable/i)

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
    expect(res.body.error).toMatch(/Only completed transactions can be voided/i)
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
    expect(res.body.error).toMatch(/propertyId required/i)
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
    expect(res.body.error).toMatch(/mutually exclusive/i)
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
    expect(res.body.error).toMatch(/qty must be positive/i)
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

  it('cross-landlord transactionId → 403 (defense against malicious cashier)', async () => {
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
    expect(res.status).toBe(403)
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
    expect(res.body.error).toMatch(/not found/i)
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
