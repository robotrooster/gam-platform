/**
 * A RENEWAL CONTINUES THE SCHEDULE.
 *
 * Nic (the rule, verbatim): "people get billed on their due date according to
 * how the landlord sets the property... the only thing we structured is that
 * the 29th through the 31st are moved to be due on the first because not every
 * month has those days and we don't want any skips."
 *
 * One tenancy, one billing schedule. The old lease bills every due date up to
 * its last day; the new lease every due date after. No off-cycle renewal bill,
 * no proration unless the landlord changed the due day on the new form, and
 * the renewal's own signing bill carries only one-time money the landlord put
 * on it.
 *
 * Every case runs through the real signing route, the real move-in bill and
 * the real nightly bill run, in both kinds of form: with a page 8 (the move-in
 * money table) and without one (Country Acres' "Mattoon Lease, EX A and B").
 * $1,000 rent today, $1,050 on the new lease, $500 deposit held, due the 1st
 * unless a case says otherwise.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { emailSigningRequestMock } = vi.hoisted(() => ({
  emailSigningRequestMock: vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailSigningRequest: emailSigningRequestMock,
  emailSigningReminder: vi.fn(async () => undefined),
  emailSigningCompleted: vi.fn(async () => undefined),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { randomUUID } from 'crypto'
import { DateTime } from 'luxon'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedUtilityMeter, seedUtilityBill,
} from '../test/dbHelpers'
import { esignRouter, createDocumentRecord } from './esign'
import { errorHandler } from '../middleware/errorHandler'
import { generateInvoices, unbilledDueDates } from '../jobs/invoiceGeneration'
import { generateMoveInInvoice } from '../jobs/moveInBundle'
import { processLeaseEnds, activatePendingLeases } from '../jobs/scheduler'
import { invoiceEndedLeaseBills } from '../services/utilityBilling'
import { voidDocument } from '../lib/voidDocument'
import { getLandlordRenewalTendency } from '../services/landlordRenewalTendency'
import { holdOverUntilNewLeaseStarts, closePredecessorOfStartedRenewals } from '../services/renewalSuccessor'

beforeEach(async () => {
  await cleanupAllSchema()
  emailSigningRequestMock.mockClear()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_renewal'
})

function buildApp() {
  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use('/api/esign', esignRouter)
  app.use(errorHandler)
  return app
}

interface Fixture {
  landlordId: string; landlordUserId: string; landlordToken: string
  tenantId: string; tenantUserId: string; tenantToken: string; tenantEmail: string
  unitId: string; propertyId: string
  oldLeaseId: string; depositId: string
}

/** A household on a $1,000 lease with a $500 deposit held. */
async function fixture(opts: {
  oldStart?: string; oldEnd: string | null; oldDueDay?: number
  dueMode?: 'fixed_day' | 'move_in_day'
}): Promise<Fixture> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId: landlordUserId, landlordId } = await seedLandlord(c)
    const tenantEmail = `t-${randomUUID()}@test.dev`
    const tenantId = await seedTenant(c, { email: tenantEmail })
    const tenantUserId = (await c.query<{ user_id: string }>(
      `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])).rows[0].user_id
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId })
    await c.query(`UPDATE properties SET rent_due_mode=$2, timezone='America/Phoenix' WHERE id=$1`,
      [propertyId, opts.dueMode ?? 'fixed_day'])
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const lease = await c.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date,
                           rent_due_day, signed_by_landlord, signed_by_tenant)
       VALUES ($1,$2,1000,$3,'active',$4,$5,$6,TRUE,TRUE) RETURNING id`,
      [unitId, landlordId, opts.oldEnd ? 'fixed_term' : 'month_to_month',
       opts.oldStart ?? '2025-06-15', opts.oldEnd, opts.oldDueDay ?? 1])
    const oldLeaseId = lease.rows[0].id
    await c.query(
      `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1,$2,'primary','active',NOW(),'original','joint_several')`, [oldLeaseId, tenantId])
    await c.query(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing, money_kind)
       VALUES ($1,'security_deposit',500,TRUE,'move_in','deposit')`, [oldLeaseId])
    const sd = await c.query<{ id: string }>(
      `INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, collected_amount, status, held_by)
       VALUES ($1,$2,$3,500,500,'funded','landlord') RETURNING id`, [unitId, oldLeaseId, tenantId])
    await c.query('COMMIT')
    const sign = (p: any) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })
    return {
      landlordId, landlordUserId, tenantId, tenantUserId, tenantEmail, unitId, propertyId,
      oldLeaseId, depositId: sd.rows[0].id,
      landlordToken: sign({ userId: landlordUserId, role: 'landlord', email: 'll@test.dev', profileId: landlordId, permissions: {} }),
      tenantToken: sign({ userId: tenantUserId, role: 'tenant', email: tenantEmail, profileId: tenantId, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const PAGE8 = ['move_in_first_month_rent', 'move_in_proration', 'move_in_security_deposit', 'move_in_total_due']

/** A renewal of the old lease, sent and waiting on the landlord's signature. */
async function renewalDoc(f: Fixture, values: Record<string, string>, opts: { page8: boolean }): Promise<string> {
  const d = await db.query<{ id: string }>(
    `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status, renews_lease_id)
     VALUES ($1,$2,'Lease Renewal','original_lease','in_progress',$3) RETURNING id`,
    [f.landlordId, f.unitId, f.oldLeaseId])
  const documentId = d.rows[0].id
  await db.query(
    `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
     VALUES ($1,$2,'landlord','L L','ll@test.dev',1,$3,'sent')`,
    [documentId, f.landlordUserId, crypto.randomBytes(32).toString('hex')])
  await db.query(
    `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
     VALUES ($1,$2,'primary','T T',$3,2,$4,'sent')`,
    [documentId, f.tenantUserId, f.tenantEmail, crypto.randomBytes(32).toString('hex')])
  const all: Record<string, string> = {
    rent_amount: '1050.00', security_deposit: '500.00', lease_type: 'fixed_term', auto_renew: 'false',
    ...values,
  }
  if (opts.page8) for (const col of PAGE8) all[col] = all[col] ?? ''
  for (const [col, val] of Object.entries(all)) {
    await db.query(
      `INSERT INTO lease_document_fields (document_id, field_type, signer_role, lease_column, value, required)
       VALUES ($1,'text','landlord',$2,$3,FALSE)`, [documentId, col, val === '' ? null : val])
  }
  return documentId
}

const signAs = (documentId: string, token: string, fieldValues: Array<{ fieldId: string; value: string }> = []) =>
  request(buildApp())
    .post(`/api/esign/sign/${documentId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ fieldValues })

async function newLease(f: Fixture) {
  return (await db.query<any>(
    `SELECT id, status, rent_due_day, supersedes_lease_id, is_existing_tenancy,
            to_char(start_date,'YYYY-MM-DD') AS start_date
       FROM leases WHERE unit_id=$1 AND id<>$2`, [f.unitId, f.oldLeaseId])).rows[0]
}

/** The nightly bill run, as it runs at 8am in Phoenix on `day`. */
async function billRunOn(day: string) {
  await generateInvoices(DateTime.fromISO(day, { zone: 'America/Phoenix' }).set({ hour: 8 }).toJSDate())
}

async function bills(f: Fixture) {
  return (await db.query<{ lease: string; due: string; rent: number; total: number; exempt: boolean }>(
    `SELECT CASE WHEN lease_id = $2 THEN 'old' ELSE 'new' END AS lease,
            to_char(due_date,'YYYY-MM-DD') AS due, subtotal_rent::float AS rent,
            total_amount::float AS total, late_fee_exempt AS exempt
       FROM invoices WHERE unit_id=$1 AND status <> 'void' ORDER BY due_date, lease`,
    [f.unitId, f.oldLeaseId])).rows
}

async function page8(documentId: string) {
  const r = await db.query<{ lease_column: string; value: string }>(
    `SELECT lease_column, value FROM lease_document_fields WHERE document_id=$1 AND lease_column = ANY($2)`,
    [documentId, PAGE8])
  return Object.fromEntries(r.rows.map(x => [x.lease_column, x.value]))
}

for (const page8Form of [true, false]) {
  const form = page8Form ? 'form with a page 8' : 'form with no page 8'

  describe(`a renewal continues the schedule — ${form}`, () => {
    it('old lease ends 6/14, renewal starts 6/15: old bills 6/1, nothing on 6/15, the new rent starts 7/1', async () => {
      const f = await fixture({ oldEnd: '2026-06-14' })
      const doc = await renewalDoc(f, { start_date: '6/15/2026', end_date: '6/14/2027', rent_due_day: '1st' }, { page8: page8Form })
      expect((await signAs(doc, f.landlordToken)).status).toBe(200)

      const nl = await newLease(f)
      expect(nl.supersedes_lease_id).toBe(f.oldLeaseId)
      expect(nl.is_existing_tenancy).toBe(false)

      // Signing billed nothing: no rent, no deposit (the $500 is already held).
      expect(await bills(f)).toEqual([])

      await billRunOn('2026-06-01')
      await billRunOn('2026-06-15')
      await billRunOn('2026-07-01')
      expect(await bills(f)).toEqual([
        { lease: 'old', due: '2026-06-01', rent: 1000, total: 1000, exempt: false },
        { lease: 'new', due: '2026-07-01', rent: 1050, total: 1050, exempt: false },
      ])
    })

    it('old lease ends ON a due date (8/1), renewal starts 8/2: the old lease bills 8/1, the new one starts with 9/1', async () => {
      const f = await fixture({ oldEnd: '2026-08-01' })
      const doc = await renewalDoc(f, { start_date: '8/2/2026', end_date: '8/1/2027', rent_due_day: '1st' }, { page8: page8Form })
      expect((await signAs(doc, f.landlordToken)).status).toBe(200)

      await billRunOn('2026-08-01')
      await billRunOn('2026-08-02')
      await billRunOn('2026-09-01')
      expect((await bills(f)).map(b => [b.lease, b.due, b.rent])).toEqual([
        ['old', '2026-08-01', 1000],
        ['new', '2026-09-01', 1050],
      ])
    })

    it('renewal on the due day (old ends 6/30, new 7/1): the new rent on 7/1 and nothing else', async () => {
      const f = await fixture({ oldEnd: '2026-06-30' })
      const doc = await renewalDoc(f, { start_date: '7/1/2026', end_date: '6/30/2027', rent_due_day: '1st' }, { page8: page8Form })
      expect((await signAs(doc, f.landlordToken)).status).toBe(200)
      await billRunOn('2026-07-01')
      // June was the old lease's (its catch-up window reaches it); July the new one's.
      expect((await bills(f)).map(b => [b.lease, b.due, b.rent])).toEqual([
        ['old', '2026-06-01', 1000],
        ['new', '2026-07-01', 1050],
      ])
      if (page8Form) {
        // Page 8 says what is billed: no rent, and the deposit already held is not owed again.
        expect(await page8(doc)).toEqual({
          move_in_first_month_rent: '0.00', move_in_proration: '0.00',
          move_in_security_deposit: '0.00', move_in_total_due: '0.00',
        })
      }
    })

    it('due on the move-in day (the 15th), no due-day box on the form, renewal 6/20: the tenant keeps the 15th', async () => {
      const f = await fixture({ oldStart: '2025-06-15', oldEnd: '2026-06-19', oldDueDay: 15, dueMode: 'move_in_day' })
      const doc = await renewalDoc(f, { start_date: '6/20/2026', end_date: '6/19/2027' }, { page8: page8Form })
      expect((await signAs(doc, f.landlordToken)).status).toBe(200)
      expect((await newLease(f)).rent_due_day).toBe(15)

      await billRunOn('2026-06-15')
      await billRunOn('2026-06-20')
      await billRunOn('2026-07-15')
      expect((await bills(f)).map(b => [b.lease, b.due, b.rent])).toEqual([
        ['old', '2026-06-15', 1000],
        ['new', '2026-07-15', 1050],
      ])
    })

    it('the due day changed on the new form (1st → 15th): one $490 bridge on 7/1, then $1,050 on 7/15', async () => {
      const f = await fixture({ oldEnd: '2026-06-30' })
      const doc = await renewalDoc(f, { start_date: '7/1/2026', end_date: '6/30/2027', rent_due_day: '15th' }, { page8: page8Form })
      expect((await signAs(doc, f.landlordToken)).status).toBe(200)
      expect((await newLease(f)).rent_due_day).toBe(15)

      await billRunOn('2026-07-01')
      await billRunOn('2026-07-15')
      expect((await bills(f)).map(b => [b.lease, b.due, b.rent])).toEqual([
        ['old', '2026-06-01', 1000],
        ['new', '2026-07-01', 490],
        ['new', '2026-07-15', 1050],
      ])
    })

    it('a deposit increase is the only thing the signing bills — dated the old lease\'s last day, no rent line', async () => {
      const f = await fixture({ oldEnd: '2026-06-14' })
      const doc = await renewalDoc(f, { start_date: '6/15/2026', end_date: '6/14/2027', rent_due_day: '1st',
        security_deposit: '600.00' }, { page8: page8Form })
      expect((await signAs(doc, f.landlordToken)).status).toBe(200)

      const one = await bills(f)
      expect(one).toHaveLength(1)
      expect(one[0]).toMatchObject({ lease: 'new', due: '2026-06-14', rent: 0, total: 100 })
      const lines = await db.query<{ type: string; amount: number }>(
        `SELECT p.type, p.amount::float AS amount FROM payments p JOIN invoices i ON i.id = p.invoice_id
          WHERE i.unit_id = $1`, [f.unitId])
      expect(lines.rows).toEqual([{ type: 'deposit', amount: 100 }])
      if (page8Form) {
        expect(await page8(doc)).toMatchObject({ move_in_security_deposit: '100.00', move_in_total_due: '100.00' })
      }
      // The regular bill still lands on 7/1 — the signing bill never takes its slot.
      await billRunOn('2026-07-01')
      expect((await bills(f)).map(b => [b.lease, b.due, b.rent])).toEqual([
        ['old', '2026-06-01', 1000],
        ['new', '2026-06-14', 0],
        ['new', '2026-07-01', 1050],
      ])
    })
  })
}

describe('the renewal rule — the rest of the cases', () => {
  it('a typed 31st on the new form is due on the 1st', async () => {
    const f = await fixture({ oldEnd: '2026-06-30' })
    const doc = await renewalDoc(f, { start_date: '7/1/2026', end_date: '6/30/2027', rent_due_day: '31st' }, { page8: false })
    expect((await signAs(doc, f.landlordToken)).status).toBe(200)
    expect((await newLease(f)).rent_due_day).toBe(1)
  })

  it('a monthly fee across a bridge is prorated with the rent — the first full due date bills it whole once', async () => {
    // 1st → 15th with $60 pet rent: 7/1 bills 14 days of both ($490 + $28),
    // 7/15 the full month of both. In full on the bridge, half a period of pet
    // rent cost a whole month.
    const f = await fixture({ oldEnd: '2026-06-30' })
    const doc = await renewalDoc(f, { start_date: '7/1/2026', end_date: '6/30/2027', rent_due_day: '15th',
      pet_rent: '60.00' }, { page8: false })
    expect((await signAs(doc, f.landlordToken)).status).toBe(200)
    const nl = await newLease(f)
    expect((await db.query(`SELECT 1 FROM lease_fees WHERE lease_id=$1 AND fee_type='pet_rent'
                              AND due_timing='monthly_ongoing'`, [nl.id])).rows).toHaveLength(1)
    await billRunOn('2026-07-01')
    await billRunOn('2026-07-15')
    const newBills = (await bills(f)).filter(b => b.lease === 'new')
    expect(newBills.map(b => [b.due, b.rent, b.total])).toEqual([
      ['2026-07-01', 490, 518],
      ['2026-07-15', 1050, 1110],
    ])
    const fees = await db.query<{ due: string; amount: number }>(
      `SELECT to_char(due_date,'YYYY-MM-DD') AS due, amount::float AS amount FROM payments
        WHERE lease_id=$1 AND type='fee' ORDER BY due_date`, [nl.id])
    expect(fees.rows).toEqual([{ due: '2026-07-01', amount: 28 }, { due: '2026-07-15', amount: 60 }])
  })

  it('a renewal starting after the 20th gets no first-bill late-fee grace — that is for onboarding', async () => {
    const f = await fixture({ oldEnd: '2026-07-24' })
    const doc = await renewalDoc(f, { start_date: '7/25/2026', end_date: '7/24/2027', rent_due_day: '1st' }, { page8: true })
    expect((await signAs(doc, f.landlordToken)).status).toBe(200)
    await billRunOn('2026-08-01')
    expect(await bills(f)).toEqual([{ lease: 'new', due: '2026-08-01', rent: 1050, total: 1050, exempt: false }])
  })

  it('the signing bill of a renewal starting the 25th is not exempt either', async () => {
    // Called directly with a renewal dated ahead, so nothing about it is back-dated.
    const f = await fixture({ oldEnd: '2099-01-24' })
    const c = await db.connect()
    try {
      const nl = await c.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date, rent_due_day,
                             supersedes_lease_id, signed_by_landlord)
         VALUES ($1,$2,1050,'fixed_term','pending','2099-01-25','2100-01-24',1,$3,TRUE) RETURNING id`,
        [f.unitId, f.landlordId, f.oldLeaseId])
      await c.query(
        `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing, money_kind)
         VALUES ($1,'pet_fee',75,FALSE,'move_in','fee')`, [nl.rows[0].id])
      const r = await generateMoveInInvoice({
        lease_id: nl.rows[0].id, unit_id: f.unitId, tenant_id: f.tenantId, landlord_id: f.landlordId,
        rent_amount: 1050, start_date: '2099-01-25',
      }, c as any, { renewal: true })
      expect(r.invoiceCreated).toBe(true)
      const inv = (await c.query<any>(
        `SELECT to_char(due_date,'YYYY-MM-DD') AS due, subtotal_rent::float AS rent, total_amount::float AS total,
                late_fee_exempt FROM invoices WHERE id=$1`, [r.invoiceId])).rows[0]
      expect(inv).toEqual({ due: '2099-01-24', rent: 0, total: 75, late_fee_exempt: false })
    } finally { c.release() }
  })

  it('a renewal with nothing one-time to bill writes no invoice at all', async () => {
    const f = await fixture({ oldEnd: '2099-01-24' })
    const c = await db.connect()
    try {
      const nl = await c.query<{ id: string }>(
        `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date, rent_due_day,
                             supersedes_lease_id, signed_by_landlord)
         VALUES ($1,$2,1050,'fixed_term','pending','2099-01-25','2100-01-24',1,$3,TRUE) RETURNING id`,
        [f.unitId, f.landlordId, f.oldLeaseId])
      const r = await generateMoveInInvoice({
        lease_id: nl.rows[0].id, unit_id: f.unitId, tenant_id: f.tenantId, landlord_id: f.landlordId,
        rent_amount: 1050, start_date: '2099-01-25',
      }, c as any, { renewal: true })
      expect(r.invoiceCreated).toBe(false)
      expect((await c.query(`SELECT 1 FROM invoices WHERE lease_id=$1`, [nl.rows[0].id])).rows).toHaveLength(0)
    } finally { c.release() }
  })

  it('a pet-deposit increase bills as a deposit held for the household, not the landlord\'s fee', async () => {
    const f = await fixture({ oldEnd: '2026-06-14' })
    await db.query(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, is_refundable, due_timing, money_kind)
       VALUES ($1,'pet_deposit',200,TRUE,'move_in','deposit')`, [f.oldLeaseId])
    const doc = await renewalDoc(f, { start_date: '6/15/2026', end_date: '6/14/2027', rent_due_day: '1st',
      pet_deposit: '300.00' }, { page8: false })
    expect((await signAs(doc, f.landlordToken)).status).toBe(200)
    const nl = await newLease(f)
    const fees = await db.query<{ amount: number; money_kind: string; description: string }>(
      `SELECT amount::float AS amount, money_kind, description FROM lease_fees
        WHERE lease_id=$1 AND fee_type='pet_deposit' ORDER BY amount`, [nl.id])
    expect(fees.rows.map(r => [r.amount, r.money_kind])).toEqual([[100, 'deposit'], [200, 'deposit']])
    const line = await db.query<{ type: string; amount: number }>(
      `SELECT type, amount::float AS amount FROM payments WHERE lease_id=$1`, [nl.id])
    expect(line.rows).toEqual([{ type: 'deposit', amount: 100 }])
  })

  it('refuses an impossible start date typed while signing, before the landlord\'s signature lands', async () => {
    const f = await fixture({ oldEnd: '2026-06-14' })
    const doc = await renewalDoc(f, { start_date: '6/15/2026', end_date: '6/14/2027', rent_due_day: '1st' }, { page8: true })
    const start = (await db.query<{ id: string }>(
      `SELECT id FROM lease_document_fields WHERE document_id=$1 AND lease_column='start_date'`, [doc])).rows[0].id
    const res = await signAs(doc, f.landlordToken, [{ fieldId: start, value: '6/31/2026' }])
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/start date is not a date/i)
    const ll = await db.query<{ status: string }>(
      `SELECT status FROM lease_document_signers WHERE document_id=$1 AND role='landlord'`, [doc])
    expect(ll.rows[0].status).toBe('sent')
    expect(await newLease(f)).toBeUndefined()
  })

  // A signed FIXED TERM runs to its end: a new lease cannot start inside it.
  // Cutting a signed term short, at a new rent, on the landlord's signature
  // alone would override the lease the household signed (lease is law).
  // Refused while the landlord can still fix it, naming the first day the new
  // lease can start. From the day after the term the takeover rule applies
  // (decisions 10/2 #7), and a LATER start holds the household over at the old
  // rent until then — accepted (below).
  it('refuses a start typed inside a signed fixed term, naming the day after it ends, while the landlord can still fix it', async () => {
    const f = await fixture({ oldEnd: '2026-06-14' })
    const doc = await renewalDoc(f, { start_date: '6/15/2026', end_date: '6/14/2027', rent_due_day: '1st' }, { page8: false })
    const start = (await db.query<{ id: string }>(
      `SELECT id FROM lease_document_fields WHERE document_id=$1 AND lease_column='start_date'`, [doc])).rows[0].id
    const res = await signAs(doc, f.landlordToken, [{ fieldId: start, value: '6/10/2026' }])
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/is on a signed lease through June 14, 2026, so a new lease can start June 15, 2026 or later\. Change the start date\./)
    const ll = await db.query<{ status: string }>(
      `SELECT status FROM lease_document_signers WHERE document_id=$1 AND role='landlord'`, [doc])
    expect(ll.rows[0].status).toBe('sent')
    expect(await newLease(f)).toBeUndefined()
    const old = await db.query<{ end_date: string }>(
      `SELECT to_char(end_date,'YYYY-MM-DD') AS end_date FROM leases WHERE id=$1`, [f.oldLeaseId])
    expect(old.rows[0].end_date).toBe('2026-06-14')
  })

  it('a start the day after the signed term ends is accepted', async () => {
    const f = await fixture({ oldEnd: '2026-06-14' })
    const doc = await renewalDoc(f, { start_date: '6/15/2026', end_date: '6/14/2027', rent_due_day: '1st' }, { page8: false })
    const res = await signAs(doc, f.landlordToken, [])
    expect(res.status).toBe(200)
    expect((await newLease(f)).start_date).toBe('2026-06-15')
  })

  it('a start a month after the signed term ends is accepted — the household holds over until then (decisions 10/2 #7)', async () => {
    // Dates still to come, so the term is running when the landlord signs.
    const f = await fixture({ oldEnd: '2099-06-14' })
    const doc = await renewalDoc(f, { start_date: '6/15/2099', end_date: '6/14/2100', rent_due_day: '1st' }, { page8: false })
    const start = (await db.query<{ id: string }>(
      `SELECT id FROM lease_document_fields WHERE document_id=$1 AND lease_column='start_date'`, [doc])).rows[0].id
    const res = await signAs(doc, f.landlordToken, [{ fieldId: start, value: '7/15/2099' }])
    expect(res.status).toBe(200)
    expect((await newLease(f))).toMatchObject({ start_date: '2099-07-15', status: 'pending' })
    // Nothing is written on the term while it is still running.
    const old = await db.query<{ end_date: string }>(`SELECT to_char(end_date,'YYYY-MM-DD') AS end_date FROM leases WHERE id=$1`, [f.oldLeaseId])
    expect(old.rows[0].end_date).toBe('2099-06-14')
  })

  it('refuses a start on or before the day the current lease began, while the landlord can still fix it', async () => {
    const f = await fixture({ oldEnd: '2026-06-14' })
    const doc = await renewalDoc(f, { start_date: '6/15/2026', end_date: '6/14/2027', rent_due_day: '1st' }, { page8: false })
    const start = (await db.query<{ id: string }>(
      `SELECT id FROM lease_document_fields WHERE document_id=$1 AND lease_column='start_date'`, [doc])).rows[0].id
    const res = await signAs(doc, f.landlordToken, [{ fieldId: start, value: '6/1/2025' }])
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/has to start after June 15, 2025/)
    const ll = await db.query<{ status: string }>(
      `SELECT status FROM lease_document_signers WHERE document_id=$1 AND role='landlord'`, [doc])
    expect(ll.rows[0].status).toBe('sent')
    expect(await newLease(f)).toBeUndefined()
  })

  it('a value the signer cannot write does not count as the date being signed', async () => {
    // The tenant cannot change the landlord's start date, so their submit is
    // checked against the saved value — not against what they posted.
    const f = await fixture({ oldEnd: '2026-06-14' })
    const doc = await renewalDoc(f, { start_date: '6/15/2026', end_date: '6/14/2027', rent_due_day: '1st' }, { page8: false })
    expect((await signAs(doc, f.landlordToken)).status).toBe(200)
    const start = (await db.query<{ id: string }>(
      `SELECT id FROM lease_document_fields WHERE document_id=$1 AND lease_column='start_date'`, [doc])).rows[0].id
    const res = await signAs(doc, f.tenantToken, [{ fieldId: start, value: '6/31/2026' }])
    expect(res.status).toBe(200)
  })
})

describe('the old lease never bills on or after a signed renewal starts', () => {
  async function seedRenewal(f: Fixture, start: string, signedByTenant: boolean) {
    // Not yet signed by the tenant, it is still waiting (it can be cancelled).
    const r = await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, rent_due_day,
                           supersedes_lease_id, signed_by_landlord, signed_by_tenant)
       VALUES ($1,$2,1050,'month_to_month',$6,$3,1,$4,TRUE,$5) RETURNING id`,
      [f.unitId, f.landlordId, start, f.oldLeaseId, signedByTenant, signedByTenant ? 'active' : 'pending'])
    await db.query(
      `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1,$2,'primary','active',NOW(),'original','joint_several')`, [r.rows[0].id, f.tenantId])
    return r.rows[0].id
  }

  it('a month-to-month with no end written: the bill run before the lease-end job still stops it the day before', async () => {
    const f = await fixture({ oldEnd: null })
    await seedRenewal(f, '2026-09-01', true)
    await billRunOn('2026-08-01')
    await billRunOn('2026-09-01')
    expect((await bills(f)).map(b => [b.lease, b.due, b.rent])).toEqual([
      ['old', '2026-08-01', 1000],
      ['new', '2026-09-01', 1050],
    ])
  })

  it('a missed lease-end night leaves the old lease active — it still bills nothing after its last day', async () => {
    const f = await fixture({ oldEnd: '2026-08-14' })
    await seedRenewal(f, '2026-08-15', true)
    await billRunOn('2026-09-01')
    expect((await bills(f)).map(b => [b.lease, b.due])).toEqual([['new', '2026-09-01']])
  })

  it('a fixed-term lease printed past the renewal\'s start: the clamp alone stops it the day before', async () => {
    // Its own end date (10/31) would let it bill 10/1; only the signed renewal
    // starting 10/1 stops it. (With the end date before the start, the end
    // date would do it and this would prove nothing.)
    const f = await fixture({ oldEnd: '2026-10-31' })
    await seedRenewal(f, '2026-10-01', true)
    await billRunOn('2026-09-01')
    await billRunOn('2026-10-01')
    expect((await bills(f)).map(b => [b.lease, b.due, b.rent])).toEqual([
      ['old', '2026-09-01', 1000],
      ['new', '2026-10-01', 1050],
    ])
  })

  // Decisions 10/2 #7: THERE IS NEVER A STRETCH WITH NO LEASE. A term that
  // ends 9/30 with its new lease starting 10/31 holds over: the old lease bills
  // 10/1 at the old rent (that bill covers October), and the new rent starts on
  // 11/1 — no bridge for 10/31, and no month billed by nobody.
  it('a signed term that ends before its new lease starts holds over: the old rent for the month between, then the new rent', async () => {
    const f = await fixture({ oldEnd: '2026-09-30' })
    const nlId = await seedRenewal(f, '2026-10-31', false)
    await billRunOn('2026-09-01')
    await billRunOn('2026-10-01')
    await billRunOn('2026-10-31')
    expect((await bills(f)).map(b => [b.lease, b.due, b.rent])).toEqual([
      ['old', '2026-09-01', 1000],
      ['old', '2026-10-01', 1000],
    ])
    // The night of 10/31 the household is handed over (as the jobs do it).
    await db.query(`UPDATE leases SET status='expired', end_date='2026-10-30' WHERE id=$1`, [f.oldLeaseId])
    await db.query(`UPDATE leases SET status='active' WHERE id=$1`, [nlId])
    await billRunOn('2026-11-01')
    expect((await bills(f)).map(b => [b.lease, b.due, b.rent])).toEqual([
      ['old', '2026-09-01', 1000],
      ['old', '2026-10-01', 1000],
      ['new', '2026-11-01', 1050],
    ])
  })

  it('the holdover is written the night the term runs out — not while the term is still running, and only until the new start', async () => {
    const f = await fixture({ oldEnd: '2026-09-30' })
    const nlId = await seedRenewal(f, '2026-10-31', false)
    const end = async () => (await db.query<{ e: string }>(
      `SELECT to_char(end_date,'YYYY-MM-DD') AS e FROM leases WHERE id=$1`, [f.oldLeaseId])).rows[0].e
    const q = async (sql: string, params?: any[]) => ({ rows: (await db.query(sql, params)).rows })
    // On its last day the term stands as signed.
    expect(await holdOverUntilNewLeaseStarts(q, { today: '2026-09-30' })).toEqual([])
    expect(await end()).toBe('2026-09-30')
    // The day after: it carries on to the day before the new start.
    expect(await holdOverUntilNewLeaseStarts(q, { today: '2026-10-01' })).toEqual([
      { leaseId: f.oldLeaseId, renewalId: nlId, termEnded: '2026-09-30', holdsOverTo: '2026-10-30' }])
    expect(await end()).toBe('2026-10-30')
    // Once is enough; and a new lease starting the day after the term needs none.
    expect(await holdOverUntilNewLeaseStarts(q, { today: '2026-10-02' })).toEqual([])
    // On the start date the old lease's last day is the day before (no change here).
    expect(await closePredecessorOfStartedRenewals(q, { today: '2026-10-31' })).toEqual([])
    expect(await end()).toBe('2026-10-30')
  })

  it('a held-over end that was never written is closed on the start date — the day before, whichever way it moves', async () => {
    const f = await fixture({ oldEnd: '2026-09-30' })
    const nlId = await seedRenewal(f, '2026-10-31', false)
    const q = async (sql: string, params?: any[]) => ({ rows: (await db.query(sql, params)).rows })
    expect(await closePredecessorOfStartedRenewals(q, { today: '2026-10-31' })).toEqual([
      { predecessorId: f.oldLeaseId, renewalId: nlId, endDate: '2026-10-30' }])
  })

  // S655 (Nic, 10/2): "they always get charged the new rent, whether or not
  // they sign it... the old one is expired." The landlord's signature is what
  // counts; the tenant's stays open.
  it('a renewal the tenant has not signed yet still takes over: the old lease stops the day before', async () => {
    const f = await fixture({ oldEnd: null })
    await seedRenewal(f, '2026-09-01', false)
    await billRunOn('2026-08-01')
    await billRunOn('2026-09-01')
    expect((await bills(f)).filter(b => b.lease === 'old').map(b => b.due)).toEqual(['2026-08-01'])
  })
})

describe('renewal drafting starts from the household, not a new resident', () => {
  async function seedTemplate(f: Fixture) {
    const tpl = await db.query<{ id: string }>(
      `INSERT INTO lease_templates (landlord_id, name, base_pdf_url, is_active)
       VALUES ($1,'Lease','/uploads/lease.pdf',TRUE) RETURNING id`, [f.landlordId])
    const cols = ['rent_amount', 'start_date', 'end_date', 'security_deposit', 'rent_due_day',
      'pet_deposit', 'move_in_fee', ...PAGE8]
    for (const [i, col] of cols.entries()) {
      await db.query(
        `INSERT INTO lease_template_fields
           (template_id, field_type, signer_role, label, lease_column, page, x, y, width, height, required)
         VALUES ($1,'text','landlord',$2,$2,1,10,$3,80,14,FALSE)`, [tpl.rows[0].id, col, 20 * i + 20])
    }
    await db.query(
      `INSERT INTO property_fee_schedules (property_id, unit_type, fee_type, amount, is_refundable, due_timing) VALUES
         ($1,'apartment','pet_deposit',350,TRUE,'move_in'),
         ($1,'apartment','move_in_fee',50,FALSE,'move_in')`, [f.propertyId])
    return tpl.rows[0].id
  }

  async function draft(f: Fixture, templateId: string, prefillValues: Record<string, string>, renewsLeaseId: string | null) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const doc = await createDocumentRecord(c, {
        landlordId: f.landlordId, templateId, unitId: f.unitId, leaseId: null,
        title: 'Lease', basePdfUrl: null, documentType: 'original_lease' as any,
        targetLeaseTenantId: null, promoteLeaseTenantId: null, renewsLeaseId,
        signers: [
          { userId: f.landlordUserId, role: 'landlord', name: 'LL', email: 'll@test.dev', orderIndex: 1 },
          { userId: f.tenantUserId, role: 'primary', name: 'T T', email: f.tenantEmail, orderIndex: 2 },
        ],
        prefillValues,
      })
      await c.query('COMMIT')
      const rows = await db.query<{ lease_column: string; value: string | null }>(
        `SELECT lease_column, value FROM lease_document_fields WHERE document_id=$1`, [doc.id])
      return Object.fromEntries(rows.rows.map(r => [r.lease_column, r.value]))
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  it('no new-resident fee list and no rent on page 8; the deposit the draft carries stays', async () => {
    const f = await fixture({ oldEnd: '2026-06-14' })
    const tpl = await seedTemplate(f)
    const v = await draft(f, tpl, {
      start_date: '6/15/2026', end_date: '6/14/2027', rent_amount: '1050.00', rent_due_day: '1', security_deposit: '500',
    }, f.oldLeaseId)
    expect(v.pet_deposit).toBe('0.00')
    expect(v.move_in_fee).toBe('0.00')
    expect(v.security_deposit).toBe('500')
    expect(v.move_in_first_month_rent).toBe('0.00')
    expect(v.move_in_proration).toBe('0.00')
  })

  it('a new resident on the same unit still starts from the property\'s list (control)', async () => {
    const f = await fixture({ oldEnd: '2026-06-14' })
    const tpl = await seedTemplate(f)
    const v = await draft(f, tpl, { start_date: '6/15/2026', rent_amount: '1050.00' }, null)
    expect(v.pet_deposit).toBe('350.00')
    expect(v.move_in_fee).toBe('50.00')
  })

  it('the renewal keeps the household\'s due day — a move-in-day park does not move it to the renewal\'s start', async () => {
    const f = await fixture({ oldEnd: '2026-06-19', oldDueDay: 15, dueMode: 'move_in_day' })
    const tpl = await seedTemplate(f)
    const v = await draft(f, tpl, { start_date: '6/20/2026', rent_amount: '1050.00', rent_due_day: '15' }, f.oldLeaseId)
    expect(v.rent_due_day).toBe('15')
  })
})

describe('the hand-off: the old lease is in force through its last day, and its open money follows', () => {
  const dbToday = async () => (await db.query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`)).rows[0].d
  const plusDays = (iso: string, n: number) => DateTime.fromISO(iso).plus({ days: n }).toISODate()!

  async function renewalOf(f: Fixture, start: string, opts: { sameTenant?: boolean; linked?: boolean } = {}) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, rent_due_day,
                           supersedes_lease_id, signed_by_landlord, signed_by_tenant)
       VALUES ($1,$2,1050,'month_to_month','pending',$3,1,$4,TRUE,TRUE) RETURNING id`,
      [f.unitId, f.landlordId, start, opts.linked === false ? null : f.oldLeaseId])
    let tenantId = f.tenantId
    if (opts.sameTenant === false) {
      const c = await db.connect()
      try { tenantId = await seedTenant(c) } finally { c.release() }
    }
    await db.query(
      `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1,$2,'primary','active',NOW(),'original','joint_several')`, [r.rows[0].id, tenantId])
    return r.rows[0].id
  }

  /** The old lease's bills up to its last day are made (the hand-off waits for them otherwise). */
  async function oldLeaseBilled(f: Fixture) {
    for (const d of await unbilledDueDates(f.oldLeaseId)) {
      await db.query(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, total_amount)
         VALUES ($1,$2,$3,$4,$5,$6,0)`, [f.landlordId, f.tenantId, f.oldLeaseId, f.unitId, `T-${randomUUID()}`, d])
    }
  }
  const statusOf = async (leaseId: string) =>
    (await db.query<{ status: string }>(`SELECT status FROM leases WHERE id=$1`, [leaseId])).rows[0].status

  it('on its last day the lease-end job leaves a renewed lease active (it may still have a bill to make)', async () => {
    const today = await dbToday()
    const f = await fixture({ oldEnd: today })
    await renewalOf(f, plusDays(today, 1))
    await processLeaseEnds()
    const old = await db.query<{ status: string }>(`SELECT status FROM leases WHERE id=$1`, [f.oldLeaseId])
    expect(old.rows[0].status).toBe('active')
  })

  it('a plain move-out still ends on its end date', async () => {
    const today = await dbToday()
    const f = await fixture({ oldEnd: today })
    await processLeaseEnds()
    const old = await db.query<{ status: string }>(`SELECT status FROM leases WHERE id=$1`, [f.oldLeaseId])
    expect(old.rows[0].status).toBe('expired')
  })

  it('the morning after, it hands off — and the open money moves to the renewal; settled history stays', async () => {
    const today = await dbToday()
    const f = await fixture({ oldEnd: plusDays(today, -1) })
    const renewalId = await renewalOf(f, today)
    const c = await db.connect()
    let meterId = ''
    try {
      meterId = await seedUtilityMeter(c, { propertyId: f.propertyId, utilityType: 'electric' })
      // Last month's read, entered before the hand-off: open.
      await seedUtilityBill(c, { meterId, unitId: f.unitId, tenantId: f.tenantId, leaseId: f.oldLeaseId,
        landlordId: f.landlordId, chargeAmount: 10, status: 'unbilled', utilityType: 'electric',
        billingCycleMonth: DateTime.fromISO(today).startOf('month').minus({ months: 1 }).toISODate()! })
      // An older one already paid: history.
      await seedUtilityBill(c, { meterId, unitId: f.unitId, tenantId: f.tenantId, leaseId: f.oldLeaseId,
        landlordId: f.landlordId, chargeAmount: 42, status: 'paid', utilityType: 'electric',
        billingCycleMonth: DateTime.fromISO(today).startOf('month').minus({ months: 3 }).toISODate()! })
    } finally { c.release() }
    await db.query(
      `INSERT INTO tenant_one_off_charges (landlord_id, tenant_id, lease_id, unit_id, charge_type, amount, reason, incident_date)
       VALUES ($1,$2,$3,$4,'violation',25,'Fire lane',CURRENT_DATE - 3)`, [f.landlordId, f.tenantId, f.oldLeaseId, f.unitId])
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,10,10,'goodwill')`, [f.landlordId, f.tenantId, f.oldLeaseId])
    await db.query(
      `INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining, note)
       VALUES ($1,$2,300,300,'paid ahead by check')`, [f.oldLeaseId, f.tenantId])
    const fill = await db.query<{ id: string }>(
      `INSERT INTO propane_fills (property_id, landlord_id, unit_id, lease_id, tenant_id, gallons, price_per_gallon,
                                  total_amount, installment_count)
       VALUES ($1,$2,$3,$4,$5,100,3,300,2) RETURNING id`,
      [f.propertyId, f.landlordId, f.unitId, f.oldLeaseId, f.tenantId])
    await db.query(
      `INSERT INTO propane_fill_installments (fill_id, installment_number, amount, billing_cycle_month)
       VALUES ($1,2,150,date_trunc('month', CURRENT_DATE)::date)`, [fill.rows[0].id])
    // Autopay, already run this month.
    await db.query(
      `INSERT INTO tenant_autopay (tenant_id, lease_id, pull_day, payment_method_id, last_run_cycle)
       VALUES ($1,$2,5,'pm_test',date_trunc('month', CURRENT_DATE)::date)`, [f.tenantId, f.oldLeaseId])
    await oldLeaseBilled(f)

    await processLeaseEnds()

    const old = await db.query<{ status: string }>(`SELECT status FROM leases WHERE id=$1`, [f.oldLeaseId])
    expect(old.rows[0].status).toBe('expired')
    // The renewal comes into force at the hand-off.
    expect(await statusOf(renewalId)).toBe('active')
    const unit = await db.query<{ status: string }>(`SELECT status FROM units WHERE id=$1`, [f.unitId])
    expect(unit.rows[0].status).not.toBe('vacant')
    const where = async (sql: string) => (await db.query<{ lease_id: string }>(sql)).rows.map(r =>
      r.lease_id === renewalId ? 'renewal' : r.lease_id === f.oldLeaseId ? 'old' : r.lease_id)
    expect(await where(`SELECT lease_id FROM utility_bills ORDER BY charge_amount`)).toEqual(['renewal', 'old'])
    expect(await where(`SELECT lease_id FROM tenant_one_off_charges`)).toEqual(['renewal'])
    expect(await where(`SELECT lease_id FROM tenant_credits`)).toEqual(['renewal'])
    expect(await where(`SELECT lease_id FROM lease_prepaid_credits`)).toEqual(['renewal'])
    expect(await where(`SELECT lease_id FROM propane_fills`)).toEqual(['renewal'])
    // Autopay keeps pulling — for the lease now in force, as it was set up, and
    // not again for the month it already ran.
    const ap = await db.query<{ lease_id: string; pull_day: number; payment_method_id: string; ran: boolean }>(
      `SELECT lease_id, pull_day, payment_method_id,
              last_run_cycle = date_trunc('month', CURRENT_DATE)::date AS ran FROM tenant_autopay`)
    expect(ap.rows).toEqual([{ lease_id: renewalId, pull_day: 5, payment_method_id: 'pm_test', ran: true }])
    // Not a move-out: no deposit return for a household that is staying.
    expect((await db.query(`SELECT 1 FROM deposit_returns WHERE lease_id=$1`, [f.oldLeaseId])).rows).toHaveLength(0)
  })

  it('the moved read lands on the renewal\'s first bill, and the $10 credit keeps reducing it', async () => {
    const today = await dbToday()
    const f = await fixture({ oldEnd: plusDays(today, -1) })
    const renewalId = await renewalOf(f, today)
    const c = await db.connect()
    try {
      const meterId = await seedUtilityMeter(c, { propertyId: f.propertyId, utilityType: 'electric' })
      await seedUtilityBill(c, { meterId, unitId: f.unitId, tenantId: f.tenantId, leaseId: f.oldLeaseId,
        landlordId: f.landlordId, chargeAmount: 10, status: 'unbilled', utilityType: 'electric',
        billingCycleMonth: DateTime.fromISO(today).startOf('month').minus({ months: 1 }).toISODate()! })
    } finally { c.release() }
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,10,10,'goodwill')`, [f.landlordId, f.tenantId, f.oldLeaseId])
    await oldLeaseBilled(f)
    await processLeaseEnds()
    expect(await statusOf(renewalId)).toBe('active')

    const firstBill = DateTime.fromISO(today).day === 1 ? today
      : DateTime.fromISO(today).startOf('month').plus({ months: 1 }).toISODate()!
    await billRunOn(firstBill)
    const lines = await db.query<{ type: string; amount: number; status: string }>(
      `SELECT p.type, p.amount::float AS amount, p.status FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
        WHERE i.lease_id = $1 ORDER BY p.type`, [renewalId])
    expect(lines.rows).toEqual([
      { type: 'rent', amount: 1050, status: 'pending' },
      { type: 'utility', amount: 10, status: 'settled' },
    ])
    const credit = await db.query<{ r: number }>(`SELECT amount_remaining::float AS r FROM tenant_credits`)
    expect(credit.rows[0].r).toBe(0)
  })

  it('a bill held on the old lease\'s last day: the hand-off waits, the old lease bills it, then hands off', async () => {
    // Country Acres reviews its utility bills, and 8 of its 10 leases end on
    // the 1st: the 1st's bill waits on last month's reading run. Before, the
    // hand-off expired the old lease the next morning anyway and that month's
    // rent was billed by nobody.
    const today = await dbToday()
    let end = plusDays(today, -1)                       // its last day, and a due date
    if (Number(end.slice(8, 10)) > 28) end = end.slice(0, 8) + '28'
    const f = await fixture({ oldEnd: end, oldDueDay: Number(end.slice(8, 10)) })
    const renewalId = await renewalOf(f, plusDays(end, 1))
    // Last month's reading run is still open with this unit's meter unread:
    // every bill due from the end date's month on waits.
    const c = await db.connect()
    let runId = ''
    try {
      const meterId = await seedUtilityMeter(c, { propertyId: f.propertyId, utilityType: 'electric' })
      await c.query(`INSERT INTO utility_meter_units (meter_id, unit_id) VALUES ($1,$2)`, [meterId, f.unitId])
      await c.query(
        `INSERT INTO lease_utility_responsibilities (lease_id, utility_type, tenant_responsible)
         VALUES ($1,'electric',TRUE)`, [f.oldLeaseId])
      runId = (await c.query<{ id: string }>(
        `INSERT INTO utility_reading_runs (property_id, landlord_id, billing_cycle_month, opened_on, status)
         VALUES ($1,$2,$3,$4,'open') RETURNING id`,
        [f.propertyId, f.landlordId, DateTime.fromISO(end).startOf('month').minus({ months: 1 }).toISODate(), end])).rows[0].id
    } finally { c.release() }

    await billRunOn(today)
    expect((await bills(f)).filter(b => b.due === end)).toEqual([])

    // The 2am jobs: the old lease stays in force, and the renewal waits with it
    // — never two leases in force on the unit.
    await activatePendingLeases()
    await processLeaseEnds()
    expect(await statusOf(f.oldLeaseId)).toBe('active')
    expect(await statusOf(renewalId)).toBe('pending')

    // The run completes; the next bill run makes the old lease's last bill.
    await db.query(
      `UPDATE utility_reading_runs SET status='completed', completed_at=NOW(), approved_at=NOW() WHERE id=$1`, [runId])
    await billRunOn(today)
    expect((await bills(f)).filter(b => b.due === end).map(b => [b.lease, b.rent])).toEqual([['old', 1000]])

    // The next night it hands off, and the renewal comes into force.
    await activatePendingLeases()
    expect(await statusOf(renewalId)).toBe('pending')
    await processLeaseEnds()
    expect(await statusOf(f.oldLeaseId)).toBe('expired')
    expect(await statusOf(renewalId)).toBe('active')
  })

  it('the wait ends when the bill run would give up on the date (past its catch-up window)', async () => {
    const today = await dbToday()
    const f = await fixture({ oldEnd: plusDays(today, -40) })
    const renewalId = await renewalOf(f, plusDays(today, -39))
    // A month never billed, now beyond the run's reach: nothing to wait for.
    await activatePendingLeases()
    expect(await statusOf(renewalId)).toBe('active')
    await processLeaseEnds()
    expect(await statusOf(f.oldLeaseId)).toBe('expired')
  })

  it('a signed lease for somebody else on the unit is the next tenancy, not a hand-off: the household moves out', async () => {
    const today = await dbToday()
    const f = await fixture({ oldEnd: plusDays(today, -1) })
    await renewalOf(f, today, { sameTenant: false, linked: false })
    await db.query(
      `INSERT INTO tenant_credits (landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category)
       VALUES ($1,$2,$3,10,10,'goodwill')`, [f.landlordId, f.tenantId, f.oldLeaseId])
    await processLeaseEnds()
    const old = await db.query<{ status: string }>(`SELECT status FROM leases WHERE id=$1`, [f.oldLeaseId])
    expect(old.rows[0].status).toBe('expired')
    // The departing household's money stays with them, not the next tenant.
    expect((await db.query<{ lease_id: string }>(`SELECT lease_id FROM tenant_credits`)).rows[0].lease_id).toBe(f.oldLeaseId)
    // The unit is the next tenancy's — not vacated.
    const unit = await db.query<{ status: string }>(`SELECT status FROM units WHERE id=$1`, [f.unitId])
    expect(unit.rows[0].status).not.toBe('vacant')
    // And they get their deposit return, which a hand-off would have skipped.
    expect((await db.query(`SELECT 1 FROM deposit_returns WHERE lease_id=$1`, [f.oldLeaseId])).rows).toHaveLength(1)
  })

  it('a late read after the hand-off goes to the renewal — no "final utility" bill for a household that stayed', async () => {
    const today = await dbToday()
    const f = await fixture({ oldEnd: plusDays(today, -1) })
    const renewalId = await renewalOf(f, today)
    await db.query(`UPDATE leases SET status='expired' WHERE id=$1`, [f.oldLeaseId])
    const cycle = DateTime.fromISO(today).startOf('month').minus({ months: 1 }).toISODate()!
    const c = await db.connect()
    let meterId = ''
    try {
      meterId = await seedUtilityMeter(c, { propertyId: f.propertyId, utilityType: 'electric' })
      await seedUtilityBill(c, { meterId, unitId: f.unitId, tenantId: f.tenantId, leaseId: f.oldLeaseId,
        landlordId: f.landlordId, chargeAmount: 18, status: 'unbilled', utilityType: 'electric', billingCycleMonth: cycle })
    } finally { c.release() }
    await invoiceEndedLeaseBills(meterId, cycle)
    const bill = await db.query<{ lease_id: string }>(`SELECT lease_id FROM utility_bills`)
    expect(bill.rows[0].lease_id).toBe(renewalId)
    expect((await db.query(`SELECT 1 FROM invoices`)).rows).toHaveLength(0)
  })

  it('a real move-out read is still billed final, renewal or not', async () => {
    const today = await dbToday()
    const f = await fixture({ oldEnd: plusDays(today, -1) })
    await renewalOf(f, today)
    await db.query(`UPDATE leases SET status='expired' WHERE id=$1`, [f.oldLeaseId])
    const cycle = DateTime.fromISO(today).startOf('month').minus({ months: 1 }).toISODate()!
    const c = await db.connect()
    let meterId = ''
    try {
      meterId = await seedUtilityMeter(c, { propertyId: f.propertyId, utilityType: 'electric' })
      await seedUtilityBill(c, { meterId, unitId: f.unitId, tenantId: f.tenantId, leaseId: f.oldLeaseId,
        landlordId: f.landlordId, chargeAmount: 18, status: 'unbilled', utilityType: 'electric', billingCycleMonth: cycle })
    } finally { c.release() }
    await invoiceEndedLeaseBills(meterId, cycle, { moveOut: true })
    expect((await db.query(`SELECT 1 FROM invoices WHERE lease_id=$1`, [f.oldLeaseId])).rows).toHaveLength(1)
  })
})

describe('cancelling a renewal the landlord signed puts the deposit back', () => {
  async function voidIt(documentId: string) {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const doc = (await c.query(`SELECT * FROM lease_documents WHERE id=$1`, [documentId])).rows[0]
      await voidDocument(c.query.bind(c) as any, doc, 'tenant did not sign')
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  const deposit = async (f: Fixture) => (await db.query<any>(
    `SELECT lease_id, total_amount::float AS total, collected_amount::float AS collected, status
       FROM security_deposits WHERE id=$1`, [f.depositId])).rows[0]

  it('the deposit record returns to the lease still in force, as it was', async () => {
    const f = await fixture({ oldEnd: '2026-06-14' })
    await db.query(
      `INSERT INTO lease_renewal_requests (lease_id, tenant_id, landlord_id, requested_by_user_id, status)
       VALUES ($1,$2,$3,$4,'approved')`, [f.oldLeaseId, f.tenantId, f.landlordId, f.tenantUserId])
    const doc = await renewalDoc(f, { start_date: '6/15/2026', end_date: '6/14/2027', rent_due_day: '1st' }, { page8: true })
    expect((await signAs(doc, f.landlordToken)).status).toBe(200)
    const nl = await newLease(f)
    expect((await deposit(f)).lease_id).toBe(nl.id)

    await voidIt(doc)
    expect(await deposit(f)).toEqual({ lease_id: f.oldLeaseId, total: 500, collected: 500, status: 'funded' })
    const req = await db.query<{ status: string }>(`SELECT status FROM lease_renewal_requests WHERE lease_id=$1`, [f.oldLeaseId])
    expect(req.rows[0].status).toBe('approved')
    const terminated = await db.query<{ status: string }>(`SELECT status FROM leases WHERE id=$1`, [nl.id])
    expect(terminated.rows[0].status).toBe('terminated')
  })

  it('autopay set up on the renewal goes back to the lease still in force', async () => {
    const f = await fixture({ oldEnd: '2026-06-14' })
    const doc = await renewalDoc(f, { start_date: '6/15/2026', end_date: '6/14/2027', rent_due_day: '1st' }, { page8: false })
    expect((await signAs(doc, f.landlordToken)).status).toBe(200)
    const nl = await newLease(f)
    await db.query(
      `INSERT INTO tenant_autopay (tenant_id, lease_id, pull_day) VALUES ($1,$2,3)`, [f.tenantId, nl.id])
    await voidIt(doc)
    const ap = await db.query<{ lease_id: string }>(`SELECT lease_id FROM tenant_autopay`)
    expect(ap.rows).toEqual([{ lease_id: f.oldLeaseId }])
  })

  it('with a deposit increase: the unpaid increase comes off, and the deposit is funded again', async () => {
    const f = await fixture({ oldEnd: '2026-06-14' })
    const doc = await renewalDoc(f, { start_date: '6/15/2026', end_date: '6/14/2027', rent_due_day: '1st',
      security_deposit: '650.00' }, { page8: true })
    expect((await signAs(doc, f.landlordToken)).status).toBe(200)
    expect(await deposit(f)).toMatchObject({ total: 650, status: 'partial' })

    await voidIt(doc)
    expect(await deposit(f)).toEqual({ lease_id: f.oldLeaseId, total: 500, collected: 500, status: 'funded' })
    // The increase bill is void, not owed.
    expect((await bills(f))).toEqual([])
  })
})

describe('the renewal-tendency report counts real renewals only', () => {
  it('a renewal that was voided before the tenant signed is not a renewal', async () => {
    const c = await db.connect()
    let landlordId = ''
    try {
      await c.query('BEGIN')
      const ll = await seedLandlord(c)
      landlordId = ll.landlordId
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      for (const [i, newRent] of [1100, 1100, 1100, 2000].entries()) {
        const unitId = await seedUnit(c, { propertyId, landlordId })
        const old = await c.query<{ id: string }>(
          `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date)
           VALUES ($1,$2,1000,'fixed_term','expired','2025-01-01','2025-12-31') RETURNING id`, [unitId, landlordId])
        const voided = i === 3
        const nl = await c.query<{ id: string }>(
          `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date, end_date, supersedes_lease_id)
           VALUES ($1,$2,$3,'fixed_term',$4,'2026-01-01','2026-12-31',$5) RETURNING id`,
          [unitId, landlordId, newRent, voided ? 'terminated' : 'active', old.rows[0].id])
        if (voided) {
          await c.query(
            `INSERT INTO lease_documents (landlord_id, unit_id, lease_id, title, document_type, status)
             VALUES ($1,$2,$3,'Lease Renewal','original_lease','voided')`, [landlordId, unitId, nl.rows[0].id])
        }
      }
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

    const t = await getLandlordRenewalTendency(landlordId)
    expect(t).toMatchObject({ renewal_count: 3, median_increase_pct: 10, avg_increase_pct: 10, ended_count: 4 })
    expect(t!.non_renewal_rate_pct).toBe(25)
  })
})
