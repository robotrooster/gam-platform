/**
 * 10/14 (Nic) — the answers that extend "If it never completed, it doesn't
 * exist" (lib/eraseUnfinishedDocument):
 *   #8 a lease the landlord's signature issued with only $0.00 bills is
 *      deleted, lease and all — and a $0.00 bill is "no money" ONLY when
 *      nothing was ever paid, credited or settled on it;
 *   #3 an unsigned sublease agreement takes its sublease request with it;
 *   #7 drafts out for signature nobody signed for 30 days are deleted
 *      nightly, the waiting signers told once.
 * (#1, #2 and the button's words: eraseUnfinishedDocument.test; #4/#5:
 * jobs/esignTimeouts.test; #6: routes/leaseDiscard.test.)
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('node-cron', () => ({ default: { schedule: vi.fn() }, schedule: vi.fn() }))
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailSigningRequest: vi.fn(async () => undefined),
  emailSigningCompleted: vi.fn(async () => undefined),
  emailDocumentAutoVoided: vi.fn(async () => undefined),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { db, query } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { esignRouter } from '../routes/esign'
import { errorHandler } from '../middleware/errorHandler'
import { eraseUnfinishedDocument, leaseMoneyTouchedSql, planErase } from './eraseUnfinishedDocument'
import { proveLease } from '../scripts/oct14_erase_documents'
import { processUnsignedDraftExpiry } from '../jobs/scheduler'
import { emailDocumentAutoVoided } from '../services/email'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/esign', esignRouter)
  app.use(errorHandler)
  return app
}

interface F {
  landlordId: string; landlordUserId: string; token: string
  tenantId: string; tenantUserId: string; unitId: string; propertyId: string
}
let f: F

beforeEach(async () => {
  await cleanupAllSchema()
  vi.clearAllMocks()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_erase1014'
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const tenantId = await seedTenant(c)
    const tenantUserId = (await c.query(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId: ll.userId, role: 'landlord', email: 'll@test.dev', profileId: ll.landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    f = { landlordId: ll.landlordId, landlordUserId: ll.userId, token, tenantId, tenantUserId, unitId, propertyId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
})

const exists = async (table: string, id: string) =>
  (await query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).length === 1

async function lease(status: 'pending' | 'active' | 'terminated' = 'active'): Promise<string> {
  const c = await db.connect()
  try {
    const leaseId = await seedLease(c, { unitId: f.unitId, landlordId: f.landlordId, status })
    await seedLeaseTenant(c, { leaseId, tenantId: f.tenantId })
    return leaseId
  } finally { c.release() }
}

/** A lease document with a landlord and a primary signer. */
async function doc(o: {
  status?: string; leaseId?: string | null; issued?: boolean; type?: string; title?: string
  sentDaysAgo?: number | null; landlordSigned?: boolean; packet?: string | null; renews?: string | null
  invited?: boolean
} = {}): Promise<string> {
  const d = (await query<{ id: string }>(
    `INSERT INTO lease_documents (landlord_id, unit_id, lease_id, title, document_type, status, issued_at, finalized_at,
                                  voided_at, sent_at, package_group_id, renews_lease_id)
     VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7 THEN NOW() END, CASE WHEN $7 THEN NOW() END,
             CASE WHEN $6 = 'voided' THEN NOW() END,
             CASE WHEN $8::int IS NOT NULL THEN NOW() - make_interval(days => $8::int) END, $9, $10)
     RETURNING id`,
    [f.landlordId, f.unitId, o.leaseId ?? null, o.title ?? 'Lease — Unit 1', o.type ?? 'original_lease',
     o.status ?? 'sent', o.issued === true, o.sentDaysAgo ?? null, o.packet ?? null, o.renews ?? null]))[0].id
  const invited = o.invited !== false
  await query(
    `INSERT INTO lease_document_signers
       (document_id, user_id, role, name, email, order_index, token, status, signed_at, invite_sent_at)
     VALUES ($1,$2,'landlord','L L','ll@test.dev',1,$3, $4, CASE WHEN $5 THEN NOW() END,
             CASE WHEN $6 THEN NOW() - INTERVAL '31 days' END),
            ($1,$7,'primary','T T','t@test.dev',2,$8,'pending', NULL, NULL)`,
    [d, f.landlordUserId, crypto.randomBytes(16).toString('hex'), o.landlordSigned ? 'signed' : 'sent',
     o.landlordSigned === true, invited, f.tenantUserId, crypto.randomBytes(16).toString('hex')])
  return d
}

/** A bill on the lease and one charge row on it. */
async function bill(leaseId: string, o: { amount?: number; status?: string; billStatus?: string; manual?: string | null; due?: string } = {}) {
  const inv = (await query<{ id: string }>(
    `INSERT INTO invoices (lease_id, tenant_id, landlord_id, unit_id, due_date, total_amount, status, invoice_number)
     VALUES ($1,$2,$3,$4,$7,$5,$6, 'INV-' || substr(md5(random()::text), 1, 10)) RETURNING id`,
    [leaseId, f.tenantId, f.landlordId, f.unitId, o.amount ?? 0, o.billStatus ?? 'settled', o.due ?? '2026-09-30']))[0].id
  const pay = (await query<{ id: string }>(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, invoice_id, type, amount, status, due_date, manual_method, notes,
                           entry_description, voided_at, void_reason)
     VALUES ($1,$2,$3,$4,$5,'utility',$6,$7,'2026-09-30',$8,'Final electric — meter 362 → 362','UTILITY',
             CASE WHEN $7 = 'voided' THEN NOW() END, CASE WHEN $7 = 'voided' THEN 'lease voided' END) RETURNING id`,
    [f.unitId, leaseId, f.tenantId, f.landlordId, inv, o.amount ?? 0, o.status ?? 'settled',
     o.manual === undefined ? 'cash' : o.manual]))[0].id
  return { inv, pay }
}

const touched = async (leaseId: string) =>
  (await query<{ t: boolean }>(`SELECT ${leaseMoneyTouchedSql('$1')} AS t`, [leaseId]))[0].t

async function inTx<T>(fn: (q: any) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const out = await fn(c.query.bind(c))
    await c.query('COMMIT')
    return out
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

describe('10/14 (Nic, #8): RV 09 — a voided lease with only $0.00 bills is deleted, lease and all', () => {
  it('the document, the lease it issued, its $0.00 bills (one marked paid in cash for $0.00), its utility bill and its bell notifications go; the person stays', async () => {
    const leaseId = await lease('terminated')
    const id = await doc({ status: 'voided', leaseId, issued: true })
    const moveIn = await bill(leaseId, { billStatus: 'void', status: 'voided', manual: null, due: '2026-10-01' })
    const final = await bill(leaseId)
    const meter = (await query<{ id: string }>(
      `INSERT INTO utility_meters (property_id, utility_type, label, billing_method)
       VALUES ($1,'electric','Meter 362','submeter') RETURNING id`, [f.propertyId]))[0].id
    const ub = (await query<{ id: string }>(
      `INSERT INTO utility_bills (meter_id, unit_id, lease_id, landlord_id, tenant_id, billing_cycle_month, utility_type,
                                  usage_amount, charge_amount, payment_id, status)
       VALUES ($1, $2, $3, $4, $5, '2026-09-01', 'electric', 0, 0, $6, 'billed') RETURNING id`,
      [meter, f.unitId, leaseId, f.landlordId, f.tenantId, final.pay]))[0].id
    await query(
      `INSERT INTO notifications (user_id, type, title, body, data)
       VALUES ($1,'final_utility_invoice','Final utilities billed — unit RV 09','$0.00', jsonb_build_object('leaseId', $2::text))`,
      [f.landlordUserId, leaseId])

    // The proof the cleanup prints: no dollar on any line, nothing tried.
    const proof = await proveLease(async (s: string, p?: any[]) => ({ rows: await query(s, p) }), leaseId)
    expect(proof.moneyTouched).toBe(false)
    expect(proof.charges.every(c => c.money.length === 0)).toBe(true)
    expect(proof.charges.map(c => c.amount)).toEqual(['0.00', '0.00'])

    const out = await inTx(q => eraseUnfinishedDocument(q, { id, lease_id: leaseId, document_type: 'original_lease' }, { onlyVoided: true }))
    expect(out).toMatchObject({ erased: true, leaseId })
    expect(await exists('lease_documents', id)).toBe(false)
    expect(await exists('leases', leaseId)).toBe(false)
    for (const x of [moveIn.inv, final.inv]) expect(await exists('invoices', x)).toBe(false)
    for (const x of [moveIn.pay, final.pay]) expect(await exists('payments', x)).toBe(false)
    expect(await exists('utility_bills', ub)).toBe(false)
    expect(await query(`SELECT 1 FROM notifications WHERE data->>'leaseId' = $1`, [leaseId])).toHaveLength(0)
    expect(await exists('tenants', f.tenantId)).toBe(true)
  })

  it('a $0.00 bill is money the moment anything was paid, credited or settled on it — then the lease and its document stay', async () => {
    const leaseId = await lease('terminated')
    const { pay } = await bill(leaseId)
    expect(await touched(leaseId)).toBe(false)            // $0.00, marked paid by hand: no money
    const cases: Array<[string, string]> = [
      ['a card or bank attempt', `UPDATE payments SET stripe_payment_intent_id = 'pi_test_1' WHERE id = $1`],
      ['an overpayment credit came of it', `UPDATE payments SET issued_credit_amount = 5 WHERE id = $1`],
      ['work trade credited on it', `UPDATE payments SET work_trade_credit = 5 WHERE id = $1`],
      ['paid from a deposit', `UPDATE payments SET status = 'paid_via_deposit' WHERE id = $1`],
      ['a dollar on the line', `UPDATE payments SET amount = 0.01 WHERE id = $1`],
    ]
    for (const [why, sql] of cases) {
      await query(`UPDATE payments SET stripe_payment_intent_id = NULL, issued_credit_amount = 0, work_trade_credit = 0,
                          status = 'settled', amount = 0 WHERE id = $1`, [pay])
      expect(await touched(leaseId), `before: ${why}`).toBe(false)
      await query(sql, [pay])
      expect(await touched(leaseId), why).toBe(true)
    }
    const id = await doc({ status: 'voided', leaseId, issued: true })
    const out = await inTx(q => eraseUnfinishedDocument(q, { id, lease_id: leaseId, document_type: 'original_lease' }, { onlyVoided: true }))
    expect(out).toMatchObject({ erased: false, reason: 'lease_money' })
    expect(await exists('leases', leaseId)).toBe(true)
  })

  it('a bill for more than $0.00, even voided, is money: the lease was billed', async () => {
    const leaseId = await lease('terminated')
    await bill(leaseId, { amount: 460, status: 'voided', billStatus: 'void', manual: null })
    expect(await touched(leaseId)).toBe(true)
  })

  it('pressed before any void: a lease only the landlord signed, nothing billed, is deleted with its lease — the space is freed and the invite it resolved is canceled', async () => {
    const leaseId = await lease('active')
    await query(`UPDATE units SET status = 'active' WHERE id = $1`, [f.unitId])
    const id = await doc({ status: 'in_progress', leaseId, issued: true, landlordSigned: true })
    await bill(leaseId, { status: 'pending', billStatus: 'pending', manual: null })
    const intent = (await query<{ id: string }>(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, unit_id, parser_status, draft_document_id, resolved_at, resolved_lease_id)
       VALUES ($1,$2,$3,'not_uploaded',$4, NOW(), $5) RETURNING id`, [f.landlordId, f.tenantId, f.unitId, id, leaseId]))[0].id
    const res = await request(buildApp()).post(`/api/esign/documents/${id}/void`)
      .set('Authorization', `Bearer ${f.token}`).send({ reason: 'not needed' })
    expect(res.status).toBe(200)
    expect(res.body.data.deleted).toBe(true)
    expect(await exists('lease_documents', id)).toBe(false)
    expect(await exists('leases', leaseId)).toBe(false)
    expect((await query<any>(`SELECT status FROM units WHERE id = $1`, [f.unitId]))[0].status).toBe('vacant')
    expect((await query<any>(
      `SELECT cancelled_at IS NOT NULL AS c, resolved_lease_id FROM pending_tenant_intents WHERE id = $1`, [intent]))[0])
      .toEqual({ c: true, resolved_lease_id: null })
  })

  it('another record on the lease it issued (an inspection, a notice…) keeps it: voided, with the reason', async () => {
    const leaseId = await lease('active')
    const id = await doc({ status: 'in_progress', leaseId, issued: true, landlordSigned: true })
    const other = await doc({ status: 'completed', leaseId, type: 'addendum_terms', title: 'Pet addendum' })
    expect(other).toBeTruthy()
    const out = await inTx(q => eraseUnfinishedDocument(q, { id, lease_id: leaseId, document_type: 'original_lease' }))
    expect(out).toMatchObject({ erased: false, reason: 'lease_in_use' })
  })
})

describe('review 10/14: one money rule — billing somebody keeps a lease, whenever the void happened', () => {
  /** RV 09 as it really is: the move-in bill billed $495.42; the 9/18 void deleted its lines and zeroed only the total. */
  async function rv09(): Promise<{ leaseId: string; id: string; moveIn: string; final: { inv: string; pay: string } }> {
    const leaseId = await lease('terminated')
    const id = await doc({ status: 'voided', leaseId, issued: true })
    const moveIn = (await query<{ id: string }>(
      `INSERT INTO invoices (lease_id, tenant_id, landlord_id, unit_id, due_date, total_amount, subtotal_rent, subtotal_utilities,
                             status, invoice_number)
       VALUES ($1,$2,$3,$4,'2026-10-01',0,495.00,0.42,'void','INV-' || substr(md5(random()::text), 1, 10)) RETURNING id`,
      [leaseId, f.tenantId, f.landlordId, f.unitId]))[0].id
    return { leaseId, id, moveIn, final: await bill(leaseId) }
  }

  it('RV 09: a bill voided before 10/12 whose subtotals still show $495.42 is money — kept, the same as a voided $495.42 line', async () => {
    const r = await rv09()
    expect(await touched(r.leaseId)).toBe(true)
    const out = await inTx(q => eraseUnfinishedDocument(q, { id: r.id, lease_id: r.leaseId, document_type: 'original_lease' }, { onlyVoided: true }))
    expect(out).toMatchObject({ erased: false, reason: 'lease_money' })
    expect(await exists('leases', r.leaseId)).toBe(true)
    const proof = await proveLease(async (s2: string, p?: any[]) => ({ rows: await query(s2, p) }), r.leaseId)
    expect(proof.bills.find(b => b.id === r.moveIn)).toMatchObject({ total: '0.00', billed: '495.42', status: 'void' })
  })

  it('once Nic confirms knowing what it billed (--erase-voided-unpaid): erased, lease and all, its "signed a lease" marks withdrawn and kept', async () => {
    const r = await rv09()
    const subject = (await query<{ id: string }>(
      `INSERT INTO credit_subjects (subject_type, subject_ref_id) VALUES ('tenant', $1) RETURNING id`, [f.tenantId]))[0].id
    const mark = (await query<{ id: string }>(
      `INSERT INTO credit_events (subject_id, event_type, event_data, occurred_at, attestation_source, network_visibility, this_hash)
       VALUES ($1, 'lease_signed', jsonb_build_object('lease_id', $2::text, 'document_id', $3::text), NOW(), 'platform',
               'private_to_subject', '\\x00') RETURNING id`, [subject, r.leaseId, r.id]))[0].id
    const opts = { onlyVoided: true, voidedUnpaidIds: [r.id] }
    // Only for a voided document named: the same press without the name keeps it.
    expect(await inTx(q => planErase(q, r.id, { onlyVoided: true }))).toMatchObject({ erased: false, reason: 'lease_money' })
    const out = await inTx(q => eraseUnfinishedDocument(q, { id: r.id, lease_id: r.leaseId, document_type: 'original_lease' }, opts))
    expect(out).toMatchObject({ erased: true, leaseId: r.leaseId })
    expect(await exists('leases', r.leaseId)).toBe(false)
    expect(await exists('invoices', r.moveIn)).toBe(false)
    expect((await query<any>(`SELECT superseded_by = id AS self, superseded_reason FROM credit_events WHERE id = $1`, [mark]))[0])
      .toEqual({ self: true, superseded_reason: 'withdrawn_no_lease' })
  })

  it('confirmed or not, anything paid on it still keeps it', async () => {
    const r = await rv09()
    await query(`UPDATE payments SET amount = 20, status = 'settled' WHERE id = $1`, [r.final.pay])
    const out = await inTx(q => eraseUnfinishedDocument(q, { id: r.id, lease_id: r.leaseId, document_type: 'original_lease' },
      { onlyVoided: true, voidedUnpaidIds: [r.id] }))
    expect(out).toMatchObject({ erased: false, reason: 'lease_money' })
  })

  it("a tenant's report that they paid at the bank is money (it would be deleted with the lease)", async () => {
    const leaseId = await lease('active')
    expect(await touched(leaseId)).toBe(false)
    await query(
      `INSERT INTO tenant_declared_deposits (tenant_id, lease_id, landlord_id, amount, declared_date, method)
       VALUES ($1,$2,$3,460,'2026-10-01','cash')`, [f.tenantId, leaseId, f.landlordId])
    expect(await touched(leaseId)).toBe(true)
  })

  it('a lease still in force with a $0.00 line marked paid: kept, so the button says Void — and the void refuses it in its own words', async () => {
    const leaseId = await lease('active')
    const id = await doc({ status: 'in_progress', leaseId, issued: true, landlordSigned: true })
    await bill(leaseId)                                   // $0.00, settled by hand
    expect(await touched(leaseId)).toBe(false)            // no money by the lease test…
    const plan = await inTx(q => planErase(q, id))        // …but the void would refuse it
    expect(plan).toMatchObject({ erased: false, reason: 'lease_money' })
    const res = await request(buildApp()).post(`/api/esign/documents/${id}/void`)
      .set('Authorization', `Bearer ${f.token}`).send({ reason: 'not needed' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Money has already been paid on this lease, so it cannot be voided. Create a superseding document instead.')
    expect(await exists('lease_documents', id)).toBe(true)
  })

  it('an invite the lease resolved that never pointed at the document (hand-drafted on GoldSign) is canceled too — no automatic re-draft', async () => {
    const leaseId = await lease('active')
    const id = await doc({ status: 'in_progress', leaseId, issued: true, landlordSigned: true })
    const intent = (await query<{ id: string }>(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, unit_id, parser_status, draft_document_id, resolved_at, resolved_lease_id)
       VALUES ($1,$2,$3,'not_uploaded',NULL, NOW(), $4) RETURNING id`, [f.landlordId, f.tenantId, f.unitId, leaseId]))[0].id
    const out = await inTx(q => eraseUnfinishedDocument(q, { id, lease_id: leaseId, document_type: 'original_lease' }))
    expect(out).toMatchObject({ erased: true, leaseId })
    expect((await query<any>(
      `SELECT cancelled_at IS NOT NULL AS c, resolved_at, resolved_lease_id FROM pending_tenant_intents WHERE id = $1`, [intent]))[0])
      .toEqual({ c: true, resolved_at: null, resolved_lease_id: null })
  })
})

describe('10/14 (Nic, #3): an unsigned sublease agreement takes the sublease request with it', () => {
  async function sublease(status: string): Promise<{ doc: string; sub: string; inv: string }> {
    const leaseId = await lease('active')
    const c = await db.connect()
    let sublessee: string
    try { sublessee = await seedTenant(c) } finally { c.release() }
    const inv = (await query<{ id: string }>(
      `INSERT INTO sublessee_invitations (token, sublessor_tenant_id, master_lease_id, sublessee_email, sub_monthly_amount,
                                          master_share_amount, start_date, status, expires_at)
       VALUES ($1,$2,$3,'s@test.dev',500,400,'2026-11-01','accepted', NOW() + INTERVAL '7 days') RETURNING id`,
      [crypto.randomBytes(8).toString('hex'), f.tenantId, leaseId]))[0].id
    const d = await doc({ type: 'sublease_agreement', title: 'Sublease Agreement', leaseId: null })
    const sub = (await query<{ id: string }>(
      `INSERT INTO subleases (master_lease_id, sublessee_tenant_id, sublessor_tenant_id, status, start_date,
                              sub_monthly_amount, master_share_amount, sublessee_invitation_id, sublease_document_id)
       VALUES ($1,$2,$3,$4,'2026-11-01',500,400,$5,$6) RETURNING id`,
      [leaseId, sublessee, f.tenantId, status, inv, d]))[0].id
    await query(`UPDATE sublessee_invitations SET sublease_id = $1 WHERE id = $2`, [sub, inv])
    return { doc: d, sub, inv }
  }

  it('deleted: the agreement and the request; the sublessee\'s invite stays, canceled (keep-everything for a person)', async () => {
    const s = await sublease('awaiting_signatures')
    const res = await request(buildApp()).post(`/api/esign/documents/${s.doc}/void`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(res.body.data.deleted).toBe(true)
    expect(await exists('lease_documents', s.doc)).toBe(false)
    expect(await exists('subleases', s.sub)).toBe(false)
    expect((await query<any>(
      `SELECT status, sublease_id, cancelled_at IS NOT NULL AS c, sublessee_email FROM sublessee_invitations WHERE id = $1`, [s.inv]))[0])
      .toEqual({ status: 'cancelled', sublease_id: null, c: true, sublessee_email: 's@test.dev' })
  })

  it('a sublease that started keeps its agreement', async () => {
    const s = await sublease('active')
    const out = await inTx(q => eraseUnfinishedDocument(q, { id: s.doc, document_type: 'sublease_agreement' }))
    expect(out).toMatchObject({ erased: false, reason: 'sublease' })
    expect(await exists('subleases', s.sub)).toBe(true)
  })
})

describe('10/14 (Nic, #7): drafts out for signature nobody signed for 30 days are deleted nightly', () => {
  it('31 days out, nobody signed: deleted, and the waiting signer told once that it expired', async () => {
    const id = await doc({ sentDaysAgo: 31 })
    const out = await processUnsignedDraftExpiry()
    expect(out.deleted).toEqual([id])
    expect(await exists('lease_documents', id)).toBe(false)
    const calls = (emailDocumentAutoVoided as any).mock.calls
    // Only the landlord was sent a link (the tenant waits on his signature, S647).
    expect(calls.map((c: any[]) => c[0])).toEqual(['ll@test.dev'])
    // …and their copy never tells them to contact the landlord.
    expect(calls[0][4]).toMatchObject({ deleted: true, toLandlord: true })
  })

  it('left alone: 29 days out, someone signed, never sent, or a new lease on its own start-date clock', async () => {
    const young = await doc({ sentDaysAgo: 29 })
    const signed = await doc({ sentDaysAgo: 40, status: 'in_progress', landlordSigned: true })
    const unsent = await doc({ status: 'pending', sentDaysAgo: null, invited: false })
    const renewal = await doc({ sentDaysAgo: 40, renews: await lease('active') })
    const out = await processUnsignedDraftExpiry()
    expect(out.deleted).toEqual([])
    for (const id of [young, signed, unsent, renewal]) expect(await exists('lease_documents', id)).toBe(true)
    expect(emailDocumentAutoVoided).not.toHaveBeenCalled()
  })

  it('a packet is one thing: its lease takes the forms, and each waiting signer gets ONE email for the packet', async () => {
    const packet = crypto.randomUUID()
    const leaseDoc = await doc({ sentDaysAgo: 35, packet })
    const form1 = await doc({ sentDaysAgo: 35, packet, type: 'addendum_terms', title: 'Radon' })
    const form2 = await doc({ sentDaysAgo: 35, packet, type: 'addendum_terms', title: 'Lead' })
    const out = await processUnsignedDraftExpiry()
    expect(out.deleted).toEqual([leaseDoc])
    for (const id of [leaseDoc, form1, form2]) expect(await exists('lease_documents', id)).toBe(false)
    expect((emailDocumentAutoVoided as any).mock.calls).toHaveLength(1)
  })

  it('a draft the erase keeps (a rent change from it already reached the bill) is LEFT as it is — never voided, nobody emailed', async () => {
    const leaseId = await lease('active')
    const id = await doc({ sentDaysAgo: 35, type: 'addendum_terms', title: 'Rent change', leaseId })
    await query(
      `INSERT INTO scheduled_lease_changes (lease_id, change_type, effective_date, new_rent_amount, status, source_document_id)
       VALUES ($1,'rent','2026-10-01',600,'applied',$2)`, [leaseId, id])
    const out = await processUnsignedDraftExpiry()
    expect(out).toEqual({ deleted: [], kept: [id] })
    expect((await query<any>(`SELECT status FROM lease_documents WHERE id = $1`, [id]))[0].status).toBe('sent')
    expect(emailDocumentAutoVoided).not.toHaveBeenCalled()
  })

  it('a packet one person signed any part of is left whole', async () => {
    const packet = crypto.randomUUID()
    const leaseDoc = await doc({ sentDaysAgo: 35, packet })
    const form = await doc({ sentDaysAgo: 35, packet, type: 'addendum_terms', title: 'Radon', landlordSigned: true, status: 'in_progress' })
    expect((await processUnsignedDraftExpiry()).deleted).toEqual([])
    for (const id of [leaseDoc, form]) expect(await exists('lease_documents', id)).toBe(true)
  })
})
