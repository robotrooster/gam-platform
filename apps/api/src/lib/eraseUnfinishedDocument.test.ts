/**
 * 10/13 (Nic) — "If it never completed, it doesn't exist."
 *
 * The void button (POST /api/esign/documents/:id/void) erases a document that
 * never completed and that no money touched, with every row hanging off it,
 * and voids anything else exactly as before. The GoldSign list labels the
 * button from the same test (end_action). Each case below runs the real route.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailSigningRequest: vi.fn(async () => undefined),
  emailSigningCompleted: vi.fn(async () => undefined),
}))

import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { db, query } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { esignRouter } from '../routes/esign'
import { errorHandler } from '../middleware/errorHandler'
import { removeOrphanedDocumentFiles, planErase } from './eraseUnfinishedDocument'
import { createLocalDriver } from './storage'
import { lockHousehold } from '../services/moneyPredicates'

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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_erase'
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

/** A document with a landlord and a primary signer, and two boxes. */
async function doc(o: {
  status?: string; type?: string; leaseId?: string | null; issued?: boolean; title?: string
  packet?: string | null; pdf?: string | null; landlordSigned?: boolean; residentSigned?: boolean
} = {}): Promise<string> {
  const d = (await query<{ id: string }>(
    `INSERT INTO lease_documents (landlord_id, unit_id, lease_id, title, document_type, status, issued_at,
                                  package_group_id, base_pdf_url, voided_at)
     VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7 THEN NOW() END, $8, $9, CASE WHEN $6 = 'voided' THEN NOW() END)
     RETURNING id`,
    [f.landlordId, f.unitId, o.leaseId ?? null, o.title ?? 'Lease — Unit 1', o.type ?? 'original_lease',
     o.status ?? 'sent', o.issued === true, o.packet ?? null, o.pdf ?? null]))[0].id
  await query(
    `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status, signed_at)
     VALUES ($1,$2,'landlord','L L','ll@test.dev',1,$3, $4, CASE WHEN $5 THEN NOW() END),
            ($1,$6,'primary','T T','t@test.dev',2,$7, $8, CASE WHEN $9 THEN NOW() END)`,
    [d, f.landlordUserId, crypto.randomBytes(16).toString('hex'), o.landlordSigned ? 'signed' : 'sent', o.landlordSigned === true,
     f.tenantUserId, crypto.randomBytes(16).toString('hex'), o.residentSigned ? 'signed' : 'pending', o.residentSigned === true])
  await query(
    `INSERT INTO lease_document_fields (document_id, field_type, signer_role, page)
     VALUES ($1,'signature','landlord',1), ($1,'signature','primary',1)`, [d])
  return d
}

const press = (id: string) => request(buildApp())
  .post(`/api/esign/documents/${id}/void`).set('Authorization', `Bearer ${f.token}`).send({ reason: 'not needed' })

const exists = async (id: string) =>
  (await query(`SELECT 1 FROM lease_documents WHERE id = $1`, [id])).length === 1
const statusOf = async (id: string) =>
  (await query<{ status: string }>(`SELECT status FROM lease_documents WHERE id = $1`, [id]))[0]?.status

async function lease(): Promise<string> {
  const c = await db.connect()
  try {
    const leaseId = await seedLease(c, { unitId: f.unitId, landlordId: f.landlordId })
    await seedLeaseTenant(c, { leaseId, tenantId: f.tenantId })
    return leaseId
  } finally { c.release() }
}

describe('the void button erases a document that never completed and no money touched', () => {
  it('an unsigned draft goes, with its signers and boxes — nothing of it is kept', async () => {
    const id = await doc()
    const res = await press(id)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ deleted: true, documents: [{ id, title: 'Lease — Unit 1' }] })
    expect(await exists(id)).toBe(false)
    expect(await query(`SELECT 1 FROM lease_document_signers WHERE document_id = $1`, [id])).toHaveLength(0)
    expect(await query(`SELECT 1 FROM lease_document_fields WHERE document_id = $1`, [id])).toHaveLength(0)
  })

  it('so does one only the landlord signed that never issued (a landlord signature binds nobody, S558)', async () => {
    const id = await doc({ status: 'in_progress', landlordSigned: true })
    const res = await press(id)
    expect(res.body.data.deleted).toBe(true)
    expect(await exists(id)).toBe(false)
  })

  it('10/14 (Nic, #2): one co-tenant signed, the other never, nothing billed — deleted', async () => {
    const id = await doc({ status: 'in_progress', residentSigned: true })
    // The second resident, who never signed.
    const c = await db.connect()
    let coUser: string
    try { coUser = (await c.query(`SELECT user_id FROM tenants WHERE id = $1`, [await seedTenant(c)])).rows[0].user_id } finally { c.release() }
    await query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
       VALUES ($1,$2,'co_tenant_1','C T','c@test.dev',3,$3,'sent')`, [id, coUser, crypto.randomBytes(16).toString('hex')])
    const res = await press(id)
    expect(res.status).toBe(200)
    expect(res.body.data.deleted).toBe(true)
    expect(await exists(id)).toBe(false)
  })

  it('a resident signed a lease that billed the household: it stays, and the void refuses it as before (supersede)', async () => {
    const leaseId = await lease()
    const id = await doc({ status: 'in_progress', landlordSigned: true, residentSigned: true, issued: true, leaseId })
    await query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',460,'pending','2026-11-01','RENT')`, [f.unitId, leaseId, f.tenantId, f.landlordId])
    const res = await press(id)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/superseding/)
    expect(await statusOf(id)).toBe('in_progress')
  })

  it('one whose landlord signature issued a lease stays on record as voided, with its reason', async () => {
    const id = await doc({ status: 'in_progress', landlordSigned: true, issued: true })
    const res = await press(id)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ deleted: false })
    const row = (await query<any>(`SELECT status, void_reason FROM lease_documents WHERE id = $1`, [id]))[0]
    expect(row).toEqual({ status: 'voided', void_reason: 'not needed' })
  })

  it('10/14 (Nic, #1): a lease an OPEN invite waits on is deleted and the invite canceled — its link stops working, its screening waiver closes, and the hourly re-draft passes it by', async () => {
    const id = await doc()
    const intent = (await query<{ id: string }>(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, unit_id, parser_status, draft_document_id)
       VALUES ($1,$2,$3,'not_uploaded',$4) RETURNING id`, [f.landlordId, f.tenantId, f.unitId, id]))[0].id
    const waiver = (await query<{ id: string }>(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, screening_waived)
       VALUES ($1,$2,'not_uploaded',TRUE) RETURNING id`, [f.landlordId, f.tenantId]))[0].id
    const res = await press(id)
    expect(res.body.data.deleted).toBe(true)
    expect(await exists(id)).toBe(false)
    const pti = (await query<any>(
      `SELECT draft_document_id, cancelled_at IS NOT NULL AS canceled FROM pending_tenant_intents WHERE id = $1`, [intent]))[0]
    expect(pti).toEqual({ draft_document_id: null, canceled: true })
    expect((await query<any>(`SELECT cancelled_at IS NOT NULL AS c FROM pending_tenant_intents WHERE id = $1`, [waiver]))[0].c).toBe(true)
    // The hourly re-draft reads open invites only (householdLeaseDraft).
    expect(await query(
      `SELECT 1 FROM pending_tenant_intents WHERE id = $1 AND resolved_at IS NULL AND cancelled_at IS NULL`, [intent])).toHaveLength(0)
  })

  it('a closed (canceled) invite lets go of the lease it pointed at, and the lease is erased', async () => {
    const id = await doc()
    const intent = (await query<{ id: string }>(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, unit_id, parser_status, draft_document_id, cancelled_at)
       VALUES ($1,$2,$3,'not_uploaded',$4, NOW()) RETURNING id`, [f.landlordId, f.tenantId, f.unitId, id]))[0].id
    const res = await press(id)
    expect(res.body.data.deleted).toBe(true)
    const pti = (await query<any>(`SELECT draft_document_id, cancelled_at FROM pending_tenant_intents WHERE id = $1`, [intent]))[0]
    expect(pti.draft_document_id).toBeNull()
    expect(pti.cancelled_at).not.toBeNull()
  })

  it('an add-tenant addendum takes the person who never joined off the lease; a remove-tenant one leaves its person on it', async () => {
    const leaseId = await lease()
    const joinerC = await db.connect()
    let joiner = ''
    try { joiner = await seedTenant(joinerC) } finally { joinerC.release() }
    const add = await doc({ type: 'addendum_add', leaseId, title: 'Add a tenant' })
    await query(
      `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, add_document_id)
       VALUES ($1,$2,'co_tenant','pending_add',$3)`, [leaseId, joiner, add])
    expect((await press(add)).body.data.deleted).toBe(true)
    expect(await query(`SELECT 1 FROM lease_tenants WHERE tenant_id = $1`, [joiner])).toHaveLength(0)

    const target = (await query<{ id: string }>(
      `SELECT id FROM lease_tenants WHERE lease_id = $1 AND tenant_id = $2`, [leaseId, f.tenantId]))[0].id
    const rm = (await query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, lease_id, title, document_type, status, target_lease_tenant_id)
       VALUES ($1,$2,$3,'Remove a tenant','addendum_remove','sent',$4) RETURNING id`,
      [f.landlordId, f.unitId, leaseId, target]))[0].id
    await query(`UPDATE lease_tenants SET status = 'pending_remove', remove_document_id = $2 WHERE id = $1`, [target, rm])
    expect((await press(rm)).body.data.deleted).toBe(true)
    const lt = (await query<any>(`SELECT status, remove_document_id FROM lease_tenants WHERE id = $1`, [target]))[0]
    expect(lt).toEqual({ status: 'active', remove_document_id: null })
  })

  it('money changes that never reached billing go with it; one that reached billing keeps the document (voided)', async () => {
    const leaseId = await lease()
    const draft = await doc({ type: 'addendum_terms', leaseId, title: 'Rent change' })
    await query(
      `INSERT INTO scheduled_lease_changes (lease_id, source_document_id, change_type, effective_date, new_rent_amount, status)
       VALUES ($1,$2,'rent','2026-12-01',1100,'scheduled')`, [leaseId, draft])
    expect((await press(draft)).body.data.deleted).toBe(true)
    expect(await query(`SELECT 1 FROM scheduled_lease_changes WHERE source_document_id = $1`, [draft])).toHaveLength(0)

    const billed = await doc({ type: 'addendum_terms', leaseId, title: 'Rent change 2' })
    await query(
      `INSERT INTO scheduled_lease_changes (lease_id, source_document_id, change_type, effective_date, new_rent_amount, status, applied_at)
       VALUES ($1,$2,'rent','2026-10-01',1100,'applied', NOW())`, [leaseId, billed])
    expect((await press(billed)).body.data.deleted).toBe(false)
    expect(await statusOf(billed)).toBe('voided')
  })

  async function agreement(status: 'pending_signature' | 'active') {
    const id = await doc({ type: 'purchase_agreement', title: 'Installment contract' })
    const sale = (await query<{ id: string }>(
      `INSERT INTO home_sale_contracts
         (unit_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount,
          annual_interest_rate, term_months, monthly_payment, start_month, status,
          installments_total, purchase_document_id, activated_at)
       VALUES ($1,$2,$3,11000,0,11000,0,55,200,'2026-11-01',$4,55,$5, CASE WHEN $4 = 'active' THEN NOW() END) RETURNING id`,
      [f.unitId, f.tenantId, f.landlordId, status, id]))[0].id
    await query(
      `INSERT INTO home_sale_installments (contract_id, installment_number, billing_month, amount, principal_portion, interest_portion, remaining_balance)
       VALUES ($1, 1, '2026-11-01', 200, 200, 0, 10800)`, [sale])
    return { id, sale }
  }

  it('the home sale an unsigned installment contract papered never started: it goes with the contract, schedule and all', async () => {
    const { id, sale } = await agreement('pending_signature')
    expect((await press(id)).body.data.deleted).toBe(true)
    expect(await query(`SELECT 1 FROM home_sale_contracts WHERE id = $1`, [sale])).toHaveLength(0)
    expect(await query(`SELECT 1 FROM home_sale_installments WHERE contract_id = $1`, [sale])).toHaveLength(0)
  })

  it('a sale that started keeps its contract on record', async () => {
    const { id } = await agreement('active')
    const out = await planErase(async (s, p) => ({ rows: await query(s, p) }), id)
    expect(out).toMatchObject({ erased: false, reason: 'sale_started' })
  })
})

describe('a packet is one thing (S652)', () => {
  it('deleting the lease takes its unfinished forms; a completed form stays; deleting one form takes only that form', async () => {
    const packet = crypto.randomUUID()
    const leaseDoc = await doc({ packet })
    const formA = await doc({ packet, type: 'addendum_terms', title: 'Lead paint' })
    const formB = await doc({ packet, type: 'addendum_terms', title: 'Bed bugs', status: 'voided' })
    const signedForm = await doc({ packet, type: 'addendum_terms', title: 'Pool rules', status: 'completed' })
    const res = await press(leaseDoc)
    expect(res.body.data.deleted).toBe(true)
    expect(res.body.data.documents.map((d: any) => d.id).sort()).toEqual([leaseDoc, formA, formB].sort())
    expect(await exists(formA)).toBe(false)
    expect(await exists(formB)).toBe(false)
    expect(await statusOf(signedForm)).toBe('completed')

    const packet2 = crypto.randomUUID()
    const lease2 = await doc({ packet: packet2 })
    const form2 = await doc({ packet: packet2, type: 'addendum_terms', title: 'Lead paint' })
    expect((await press(form2)).body.data.deleted).toBe(true)
    expect(await statusOf(lease2)).toBe('sent')
  })

  it('a packet whose installment contract already started billing keeps its lease (voided) and every form', async () => {
    const packet = crypto.randomUUID()
    const leaseDoc = await doc({ packet })
    const form = await doc({ packet, type: 'addendum_terms', title: 'Lead paint' })
    const sale = await doc({ packet, type: 'purchase_agreement', title: 'Installment contract' })
    await query(
      `INSERT INTO home_sale_contracts
         (unit_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount,
          annual_interest_rate, term_months, monthly_payment, start_month, status,
          installments_total, purchase_document_id, activated_at)
       VALUES ($1,$2,$3,11000,0,11000,0,55,200,'2026-11-01','active',55,$4, NOW())`,
      [f.unitId, f.tenantId, f.landlordId, sale])
    const res = await press(leaseDoc)
    expect(res.body.data.deleted).toBe(false)
    expect(await statusOf(leaseDoc)).toBe('voided')
    expect(await statusOf(form)).toBe('sent')
    expect(await statusOf(sale)).toBe('sent')
  })
})

describe('GET /documents says which the button does', () => {
  it('Delete for a document nothing keeps, Void for one that issued, nothing for a completed one', async () => {
    const erasable = await doc({ title: 'Draft' })
    const issued = await doc({ title: 'Issued', status: 'in_progress', landlordSigned: true, issued: true })
    const done = await doc({ title: 'Done', status: 'completed' })
    const res = await request(buildApp()).get('/api/esign/documents').set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    const by = Object.fromEntries(res.body.data.map((d: any) => [d.id, d.end_action]))
    expect(by).toEqual({ [erasable]: 'delete', [issued]: 'void', [done]: null })
    // 10/13 review: Void says WHY it can't delete, so the landlord can act on it.
    const why = Object.fromEntries(res.body.data.map((d: any) => [d.id, d.end_reason]))
    expect(why).toEqual({ [erasable]: null, [issued]: 'It issued a lease and billed the household.', [done]: null })
    expect(res.body.data.every((d: any) => !('kept_reason' in d))).toBe(true)
  })

  it('10/14: an open invite waiting on a lease no longer keeps it (Delete); money on the lease it issued is the reason given', async () => {
    const id = await doc()
    await query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, unit_id, parser_status, draft_document_id)
       VALUES ($1,$2,$3,'not_uploaded',$4)`, [f.landlordId, f.tenantId, f.unitId, id])
    const leaseId = await lease()
    const billed = await doc({ title: 'Billed', status: 'in_progress', landlordSigned: true, issued: true, leaseId })
    await query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',460,'pending','2026-11-01','RENT')`, [f.unitId, leaseId, f.tenantId, f.landlordId])
    const res = await request(buildApp()).get('/api/esign/documents').set('Authorization', `Bearer ${f.token}`)
    expect(res.body.data.find((d: any) => d.id === id)).toMatchObject({ end_action: 'delete', end_reason: null })
    expect(res.body.data.find((d: any) => d.id === billed)).toMatchObject({
      end_action: 'void',
      end_reason: 'Money touched the lease it issued: something on it was billed, paid, credited or settled.',
    })
  })

  it('the new-lease window gets the same answer for an open new lease (renewal-context)', async () => {
    const leaseId = await lease()
    const draft = (await query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status, renews_lease_id)
       VALUES ($1,$2,'New lease — Unit 1','original_lease','sent',$3) RETURNING id`,
      [f.landlordId, f.unitId, leaseId]))[0].id
    const ctx = async () => (await request(buildApp()).get(`/api/esign/documents/renewal-context/${leaseId}`)
      .set('Authorization', `Bearer ${f.token}`)).body.data.openDraft
    expect(await ctx()).toMatchObject({ id: draft, end_action: 'delete', end_reason: null })
    expect('kept_reason' in (await ctx())).toBe(false)
    await query(`UPDATE lease_documents SET issued_at = NOW() WHERE id = $1`, [draft])
    expect(await ctx()).toMatchObject({ id: draft, end_action: 'void', end_reason: 'It issued a lease and billed the household.' })
  })
})

describe('files an erased document alone used', () => {
  it('are removed after the erase; a template\'s shared paper stays', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erase-doc-'))
    const dir = path.join(root, 'leases')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'only-mine.pdf'), 'x')
    fs.writeFileSync(path.join(dir, 'shared.pdf'), 'x')
    await query(`INSERT INTO lease_templates (landlord_id, name, base_pdf_url) VALUES ($1,'Lease','/api/esign/files/shared.pdf')`, [f.landlordId])
    const q = async (s: string, p?: any[]) => ({ rows: await query(s, p) })
    const r = await removeOrphanedDocumentFiles(q, ['/api/esign/files/only-mine.pdf', '/api/esign/files/shared.pdf'], createLocalDriver(root))
    expect(r).toEqual({ removed: ['/api/esign/files/only-mine.pdf'], left: [] })
    expect(fs.existsSync(path.join(dir, 'only-mine.pdf'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'shared.pdf'))).toBe(true)
    fs.rmSync(root, { recursive: true, force: true })
  })
})

describe('10/13 review — what the button never does', () => {
  it('an already voided document is refused as before (400), never erased by a direct press', async () => {
    const id = await doc({ status: 'voided' })
    const res = await press(id)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already voided/)
    expect(await statusOf(id)).toBe('voided')
  })

  it('the bell notifications that only point at an erased document go with it; one about another document stays', async () => {
    const id = await doc()
    const other = await doc({ title: 'Other lease' })
    await query(
      `INSERT INTO notifications (user_id, type, title, body, action_url, data)
       VALUES ($1,'lease_ready_to_sign','Lease drafted — ready for your signature','RV 25','/esign', jsonb_build_object('documentId', $2::text)),
              ($1,'esign_request','Document ready to sign','RV 25','/esign', jsonb_build_object('document_id', $2::text)),
              ($1,'esign_request','Document ready to sign','RV 26','/esign', jsonb_build_object('documentId', $3::text)),
              ($1,'maintenance','Leak','RV 25', NULL, NULL)`,
      [f.landlordUserId, id, other])
    expect((await press(id)).body.data.deleted).toBe(true)
    const left = await query<{ body: string; type: string }>(
      `SELECT type, body FROM notifications WHERE user_id = $1 ORDER BY body, type`, [f.landlordUserId])
    expect(left).toEqual([{ type: 'maintenance', body: 'RV 25' }, { type: 'esign_request', body: 'RV 26' }])
  })

  it('a packet lease erased with an installment contract that never started takes the sale and its schedule too', async () => {
    const packet = crypto.randomUUID()
    const leaseDoc = await doc({ packet })
    const saleDoc = await doc({ packet, type: 'purchase_agreement', title: 'Installment contract' })
    const sale = await pendingSale(saleDoc)
    const res = await press(leaseDoc)
    expect(res.body.data.deleted).toBe(true)
    expect(await exists(saleDoc)).toBe(false)
    expect(await query(`SELECT 1 FROM home_sale_contracts WHERE id = $1`, [sale])).toHaveLength(0)
  })

  it('a home sale the morning retry starts WHILE its packet lease is being deleted: the delete waits, then keeps the packet — the sale and its schedule are never deleted', async () => {
    const packet = crypto.randomUUID()
    const leaseDoc = await doc({ packet })
    const saleDoc = await doc({ packet, type: 'purchase_agreement', title: 'Installment contract' })
    const sale = await pendingSale(saleDoc)

    // The start (services/homeSale.activateHomeSaleContractIn): the buyer's
    // household lock, then the contract made active with its schedule — held
    // open while the landlord presses Delete on the packet's lease.
    const starter = await db.connect()
    let res: any
    try {
      await starter.query('BEGIN')
      await lockHousehold(starter, f.tenantId, f.landlordId)
      await starter.query(
        `UPDATE home_sale_contracts SET status = 'active', activated_at = NOW() WHERE id = $1`, [sale])
      await starter.query(
        `INSERT INTO home_sale_installments (contract_id, installment_number, billing_month, amount, principal_portion, interest_portion, remaining_balance)
         VALUES ($1, 1, '2026-11-01', 200, 200, 0, 10800)`, [sale])
      const pressed = press(leaseDoc).then(r => r)
      await waitForALockWait()
      await starter.query('COMMIT')
      res = await pressed
    } catch (e) { await starter.query('ROLLBACK').catch(() => {}); throw e } finally { starter.release() }

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ deleted: false })
    expect(await statusOf(leaseDoc)).toBe('voided')
    expect(await statusOf(saleDoc)).toBe('sent')
    expect((await query<any>(`SELECT status FROM home_sale_contracts WHERE id = $1`, [sale]))[0]).toEqual({ status: 'active' })
    expect(await query(`SELECT 1 FROM home_sale_installments WHERE contract_id = $1`, [sale])).toHaveLength(1)
  })
})

/** An installment contract waiting for signatures on `documentId`. */
async function pendingSale(documentId: string): Promise<string> {
  return (await query<{ id: string }>(
    `INSERT INTO home_sale_contracts
       (unit_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount,
        annual_interest_rate, term_months, monthly_payment, start_month, status,
        installments_total, purchase_document_id)
     VALUES ($1,$2,$3,11000,0,11000,0,55,200,'2026-11-01','pending_signature',55,$4) RETURNING id`,
    [f.unitId, f.tenantId, f.landlordId, documentId]))[0].id
}

/** Until some session is waiting on a lock (the press, behind the start). */
async function waitForALockWait(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const n = (await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pg_locks WHERE NOT granted`))[0].n
    if (n > 0) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error('the press never waited on a lock')
}
