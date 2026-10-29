/**
 * THE COMPANY LINE AT A FOLD — FROM A SCOPED DESK.
 *
 * 10/20 (Nic), widening the register's customer book to the account: "that
 * could be people from my other property could be customers at this property
 * for propane. I shouldn't have to toggle." And, in the same breath, the limit
 * on it: do not merge, rewrite or repoint existing customer records — what each
 * company holds ABOUT a person stays that company's.
 *
 * The book got wider and the fold did not get a company line. The refusal the
 * widening shipped with asked whether the CALLER OWNS the survivor's company,
 * which is false for exactly the person who has to be stopped: the on-site
 * manager at Mountain View RV Park Ranch LLC holds pos.ring_sale, so her
 * landlord scope is [Mountain View] and Oak Park's company reads as "not hers".
 * The refusal was skipped and the fold ran — Mountain View's sales and its
 * charge account archived into Oak Park's record, in one request, with no undo
 * on that path. She needs no trick to reach the other record: the widened
 * people picker hands the desk every register customer on the account by name,
 * with its id.
 *
 * The same guard compared the survivor against the SESSION's company, so the
 * fold the other way round was open too — name Oak Park's record in the path,
 * stand at Mountain View, pick a Mountain View survivor.
 *
 * Both directions are pinned here — through the route the desk actually uses,
 * and against the fold itself with no route in front of it, because that is
 * where the rule now lives. Plus the one crossing that stays allowed (an
 * unconfirmed card-reader stand-in, which is a placeholder for whoever tapped
 * and not a company's book) and the desk's ordinary job inside one company,
 * which must keep working.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty } from '../test/dbHelpers'
import { posRouter } from './pos'
import { errorHandler } from '../middleware/errorHandler'
import { mergePosCustomers } from '../services/posCustomerCards'

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/pos', posRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_pos_company_line'
})

interface TwoParks {
  ownerUserId: string
  mv: string            // Mountain View RV Park Ranch LLC
  op: string            // Oak Park Motel and RV LLC
  mvProperty: string
  opProperty: string
  deskToken: string     // the front counter — onsite_manager scoped to Mountain View
  ownerToken: string    // Nic — the account, both companies
}

/** Nic's actual shape: one account, two LLCs, one park each. */
async function twoParks(): Promise<TwoParks> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { userId: ownerUserId, landlordId: mv } = await seedLandlord(client)
    await client.query(`UPDATE landlords SET business_name = 'Mountain View RV Park Ranch LLC' WHERE id = $1`, [mv])
    const op = (await client.query<{ id: string }>(
      `INSERT INTO landlords (user_id, business_name, billing_starts_at)
       VALUES ($1, 'Oak Park Motel and RV LLC', DATE '2000-01-01') RETURNING id`, [ownerUserId])).rows[0].id
    const mvProperty = await seedProperty(client, { landlordId: mv, ownerUserId, managedByUserId: ownerUserId })
    const opProperty = await seedProperty(client, { landlordId: op, ownerUserId, managedByUserId: ownerUserId })
    // The live row this was confirmed on: an on-site manager of one company who
    // may ring a sale. Her scope is that one company, which is the point.
    const desk = (await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1, 'x', 'onsite_manager', 'Front', 'Counter', TRUE) RETURNING id`,
      [`desk-${mv.slice(0, 8)}@test.dev`])).rows[0].id
    await client.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties)
       VALUES ($1, $2, $3, FALSE)`, [desk, mv, [mvProperty]])
    await client.query('COMMIT')
    const deskToken = jwt.sign(
      { userId: desk, role: 'onsite_manager', email: 'desk@test.dev', profileId: desk, landlordId: mv,
        permissions: { 'pos.ring_sale': true } },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    const ownerToken = jwt.sign(
      { userId: ownerUserId, role: 'landlord', email: 'owner@test.dev', profileId: null,
        landlordIds: [mv, op], permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { ownerUserId, mv, op, mvProperty, opProperty, deskToken, ownerToken }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

/**
 * A register customer of one company, with a sale and (unless asked otherwise) a
 * charge account of that company's. A record with no charge account is how the
 * same-company fold below is set up: one company allows one charge account per
 * person, and the fold's own 409 for two of them has its own test in pos.test.
 */
async function customerWithMoney(
  f: TwoParks, landlordId: string, propertyId: string, first: string, last: string,
  withChargeAccount = true,
): Promise<{ id: string; saleId: string; accountId: string | null }> {
  const id = (await db.query<{ id: string }>(
    `INSERT INTO pos_customers (landlord_id, first_name, last_name, created_from) VALUES ($1,$2,$3,'manual') RETURNING id`,
    [landlordId, first, last])).rows[0].id
  const saleId = (await db.query<{ id: string }>(
    `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, total, status, property_id, pos_customer_id)
     VALUES ($1, $2, 'cash', 24, 0, 24, 'completed', $3, $4) RETURNING id`,
    [landlordId, f.ownerUserId, propertyId, id])).rows[0].id
  const accountId = withChargeAccount ? (await db.query<{ id: string }>(
    `INSERT INTO flex_charge_accounts (pos_customer_id, property_id, landlord_id, credit_limit) VALUES ($1,$2,$3,200) RETURNING id`,
    [id, propertyId, landlordId])).rows[0].id : null
  return { id, saleId, accountId }
}

const live = async (id: string) => (await db.query<{ archived_at: Date | null }>(
  `SELECT archived_at FROM pos_customers WHERE id = $1`, [id])).rows[0].archived_at === null
const saleBelongsTo = async (saleId: string) => (await db.query<{ pos_customer_id: string | null }>(
  `SELECT pos_customer_id FROM pos_transactions WHERE id = $1`, [saleId])).rows[0].pos_customer_id
const accountBelongsTo = async (accountId: string | null) => (await db.query<{ pos_customer_id: string | null }>(
  `SELECT pos_customer_id FROM flex_charge_accounts WHERE id = $1`, [accountId])).rows[0].pos_customer_id

describe('a fold never crosses the company line, whoever is at the keyboard', () => {
  it('the scoped desk cannot fold her company\'s record into the account\'s OTHER company', async () => {
    const f = await twoParks()
    const mine = await customerWithMoney(f, f.mv, f.mvProperty, 'Bob', 'Housley')
    const theirs = await customerWithMoney(f, f.op, f.opProperty, 'Bob', 'Housley')

    const res = await request(buildApp()).post(`/api/pos/customers/${mine.id}/merge`)
      .set('Authorization', `Bearer ${f.deskToken}`).send({ into: theirs.id })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(String(res.body?.error)).toMatch(/different companies/i)
    // Nothing moved and nothing was closed: each company still holds its own.
    expect(await live(mine.id)).toBe(true)
    expect(await live(theirs.id)).toBe(true)
    expect(await saleBelongsTo(mine.saleId)).toBe(mine.id)
    expect(await accountBelongsTo(mine.accountId)).toBe(mine.id)
    expect(await accountBelongsTo(theirs.accountId)).toBe(theirs.id)
  })

  it('and cannot fold the other company\'s record into her own, either', async () => {
    const f = await twoParks()
    const mine = await customerWithMoney(f, f.mv, f.mvProperty, 'Bob', 'Housley')
    const theirs = await customerWithMoney(f, f.op, f.opProperty, 'Bob', 'Housley')

    const res = await request(buildApp()).post(`/api/pos/customers/${theirs.id}/merge`)
      .set('Authorization', `Bearer ${f.deskToken}`).send({ into: mine.id })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(String(res.body?.error)).toMatch(/different companies/i)
    expect(await live(theirs.id)).toBe(true)
    expect(await saleBelongsTo(theirs.saleId)).toBe(theirs.id)
    expect(await accountBelongsTo(theirs.accountId)).toBe(theirs.id)
  })

  it('the account itself is told it is two of its own companies, and still refused', async () => {
    const f = await twoParks()
    const mine = await customerWithMoney(f, f.mv, f.mvProperty, 'Bob', 'Housley')
    const theirs = await customerWithMoney(f, f.op, f.opProperty, 'Bob', 'Housley')

    const res = await request(buildApp()).post(`/api/pos/customers/${mine.id}/merge`)
      .set('Authorization', `Bearer ${f.ownerToken}`).send({ into: theirs.id })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(String(res.body?.error)).toMatch(/different companies of yours/i)
    expect(await live(mine.id)).toBe(true)
  })

  it('inside one company the desk still folds two records into one', async () => {
    const f = await twoParks()
    const keep = await customerWithMoney(f, f.mv, f.mvProperty, 'Bob', 'Housley')
    const dup = await customerWithMoney(f, f.mv, f.mvProperty, 'B', 'Housley', false)

    const res = await request(buildApp()).post(`/api/pos/customers/${dup.id}/merge`)
      .set('Authorization', `Bearer ${f.deskToken}`).send({ into: keep.id })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await live(dup.id)).toBe(false)
    expect(await saleBelongsTo(dup.saleId)).toBe(keep.id)
  })

  it('the fold refuses it on its own, with no route in front of it', async () => {
    const f = await twoParks()
    const mine = await customerWithMoney(f, f.mv, f.mvProperty, 'Bob', 'Housley')
    const theirs = await customerWithMoney(f, f.op, f.opProperty, 'Bob', 'Housley')
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await expect(mergePosCustomers(client, { landlordId: f.mv, loserId: mine.id, into: theirs.id, caller: f.ownerUserId }))
        .rejects.toThrow(/different companies/i)
      await client.query('ROLLBACK')
    } finally { client.release() }
    expect(await live(mine.id)).toBe(true)
    expect(await accountBelongsTo(mine.accountId)).toBe(mine.id)
  })

  it('an unconfirmed card-reader stand-in STILL folds across, because it is nobody yet', async () => {
    // The man taps a new card at Oak Park and is never named, so the reader
    // writes a placeholder there. Next week he buys propane at Mountain View and
    // the desk names him. One man, one record is the whole of the 10/20 lane, so
    // this crossing stays allowed: the stand-in carries one tap, no contact, no
    // resident and no money relationship, and the sale on it keeps Oak Park's
    // own landlord_id either way.
    const f = await twoParks()
    const him = await customerWithMoney(f, f.mv, f.mvProperty, 'Bob', 'Housley')
    const standIn = (await db.query<{ id: string }>(
      `INSERT INTO pos_customers (landlord_id, first_name, last_name, created_from) VALUES ($1,'Card','Customer','card_reader') RETURNING id`,
      [f.op])).rows[0].id
    const tapped = (await db.query<{ id: string }>(
      `INSERT INTO pos_transactions (landlord_id, cashier_id, payment_method, subtotal, tax_amount, total, status, property_id, pos_customer_id)
       VALUES ($1, $2, 'card', 30, 0, 30, 'completed', $3, $4) RETURNING id`,
      [f.op, f.ownerUserId, f.opProperty, standIn])).rows[0].id

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const fold = await mergePosCustomers(client, { landlordId: f.mv, loserId: standIn, into: him.id, caller: f.ownerUserId })
      await client.query('COMMIT')
      expect(fold.moved.pos_transactions).toEqual([tapped])
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    expect(await live(standIn)).toBe(false)
    expect(await saleBelongsTo(tapped)).toBe(him.id)
    // The sale is still Oak Park's sale — only who it names changed.
    expect((await db.query<{ landlord_id: string }>(
      `SELECT landlord_id FROM pos_transactions WHERE id = $1`, [tapped])).rows[0].landlord_id).toBe(f.op)
  })
})
