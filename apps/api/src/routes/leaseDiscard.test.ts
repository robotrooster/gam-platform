/**
 * S640 (Nic) — an unsigned draft lease needs a way out.
 *
 *   "The one lease in review, that's the one that was supposed to delete when I
 *    deleted it from the master schedule. So why is that still there? There's
 *    no way to delete it either. So it's just useless filler... just delete it
 *    for now."
 *
 * That one survived because the reservation was cancelled hours before the code
 * that takes the draft with it went live. The real problem is that there was no
 * way out: a draft nobody can execute or complete sat on the dashboard as a
 * permanent action item whose only button opened a PDF that does not exist.
 *
 * Discard is a SOFT close — the row stays, marked terminated — and it stops at
 * paperwork nobody has signed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailSigningRequest: vi.fn(async () => undefined),
  emailSigningReminder: vi.fn(async () => undefined),
}))
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { leasesRouter } from './leases'
import { esignRouter } from './esign'
import { errorHandler } from '../middleware/errorHandler'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/leases', leasesRouter)
  app.use('/api/esign', esignRouter)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_discard'
})

async function seedDraft(status: string) {
  const c = await getClient()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 589 })
    const l = await c.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, rent_amount, lease_type, status, start_date,
                           needs_review, lease_source)
       VALUES ($1,$2,589,'month_to_month',$3, CURRENT_DATE, TRUE, 'booking_draft') RETURNING id`,
      [unitId, landlordId, status])
    await c.query('COMMIT')
    const token = jwt.sign(
      { userId, role: 'landlord', email: 'll@t.dev', landlordIds: [landlordId], profileId: landlordId, permissions: {} },
      process.env.JWT_SECRET!, { expiresIn: '1h' })
    return { token, leaseId: l.rows[0].id, landlordId, unitId, userId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const discard = (leaseId: string, token: string, body: Record<string, unknown> = {}) => request(buildApp())
  .post(`/api/leases/${leaseId}/discard`).set('Authorization', `Bearer ${token}`).send(body)

describe('POST /api/leases/:id/discard', () => {
  it('closes an unsigned pending draft and clears it off the review list', async () => {
    const f = await seedDraft('pending')
    const res = await discard(f.leaseId, f.token)
    expect(res.status).toBe(200)
    const l = (await db.query<any>('SELECT status, needs_review FROM leases WHERE id=$1', [f.leaseId])).rows[0]
    expect(l.status).toBe('terminated')
    expect(l.needs_review).toBe(false)
  })

  // GAM keeps everything — a discard hides the draft, it does not erase it.
  it('keeps the row', async () => {
    const f = await seedDraft('pending')
    await discard(f.leaseId, f.token)
    const n = await db.query<any>('SELECT COUNT(*)::int AS c FROM leases WHERE id=$1', [f.leaseId])
    expect(n.rows[0].c).toBe(1)
  })

  it('refuses an ACTIVE lease — no Discard ends a tenancy; it names “They never moved in — end the lease” and “They’re leaving on…”', async () => {
    const f = await seedDraft('active')
    const res = await discard(f.leaseId, f.token)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/They never moved in — end the lease/)
    const l = (await db.query<any>('SELECT status FROM leases WHERE id=$1', [f.leaseId])).rows[0]
    expect(l.status).toBe('active')
  })

  // Step 9 (final fix, fix pass 1 — decisions #46.4): a lease the TENANT
  // signed can't be voided, so Discard used to dead-end ("void the document
  // instead", then the void refused). It now runs the never-moved-in close.
  async function signedBy(f: { leaseId: string; landlordId: string }, role: 'tenant' | 'landlord') {
    const d = await db.query<{ id: string }>(
      `INSERT INTO lease_documents (lease_id, landlord_id, title, status)
       VALUES ($1,$2,'Lease','sent') RETURNING id`, [f.leaseId, f.landlordId])
    const su = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ('signer-' || gen_random_uuid() || '@t.dev','x',$1,'Some','One',TRUE) RETURNING id`, [role])
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, name, email, role, token, signed_at)
       VALUES ($1,$2,'Someone','someone@t.dev',$3, gen_random_uuid()::text, NOW())`,
      [d.rows[0].id, su.rows[0].id, role])
    return d.rows[0].id
  }

  /** A signer row on a document: signed now, or waiting (sent) for their turn. */
  async function signer(documentId: string, o: { role: string; userId?: string; signed: boolean; order: number }) {
    const userId = o.userId ?? (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ('signer-' || gen_random_uuid() || '@t.dev','x',$1,'Some','One',TRUE) RETURNING id`,
      [o.role === 'landlord' ? 'landlord' : 'tenant'])).rows[0].id
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, name, email, role, token, order_index, status, signed_at)
       VALUES ($1,$2,'Someone','someone@t.dev',$3, gen_random_uuid()::text, $4, $5, CASE WHEN $6 THEN NOW() END)`,
      [documentId, userId, o.role, o.order, o.signed ? 'signed' : 'sent', o.signed])
  }

  it('a lease the tenant signed and never paid: Discard ends it as never moved in instead of refusing — nothing on it is owed', async () => {
    const f = await seedDraft('pending')
    await signedBy(f, 'tenant')
    const res = await discard(f.leaseId, f.token, { expectedTotal: 0 })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'terminated', zeroed_total: 0 })
    const l = (await db.query<any>('SELECT status, termination_reason FROM leases WHERE id=$1', [f.leaseId])).rows[0]
    expect(l).toEqual({ status: 'terminated', termination_reason: 'The tenant never moved in' })
  })

  it('a lease the tenant signed with money paid on it: refused in plain words naming the move-out, nothing changed', async () => {
    const f = await seedDraft('pending')
    await signedBy(f, 'tenant')
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, landlord_id, type, amount, status, due_date, entry_description, settled_at, manual_method)
       VALUES ($1,$2,$3,'deposit',500,'settled',CURRENT_DATE,'DEPOSIT',NOW(),'cash')`, [f.unitId, f.leaseId, f.landlordId])
    const res = await discard(f.leaseId, f.token, { expectedTotal: 0 })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/\$500\.00 was already paid on this lease/)
    expect(res.body.error).toMatch(/Move out/)
    expect((await db.query<any>('SELECT status FROM leases WHERE id=$1', [f.leaseId])).rows[0].status).toBe('pending')
  })

  it('a lease only the landlord signed: refused with the next step — void it on the GoldSign page (that takes its bill back and tells the tenant)', async () => {
    const f = await seedDraft('pending')
    await signedBy(f, 'landlord')
    const res = await discard(f.leaseId, f.token)
    // Fix pass 3: a 409 with its code — the page's list was stale, so it reads
    // it again and the row shows "Void on the GoldSign page".
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('landlord_signed')
    expect(res.body.error).toMatch(/Void its document on the GoldSign page/)
    expect(res.body.error).not.toMatch(/E-Sign/)
    expect((await db.query<any>('SELECT status FROM leases WHERE id=$1', [f.leaseId])).rows[0].status).toBe('pending')
  })

  // Fix pass 3: an unsigned draft's paperwork already sent for signature ends
  // with it — a signing link already sent stops working.
  it('discarding an unsigned draft whose document was sent voids it, so a tenant signature afterwards is refused', async () => {
    const f = await seedDraft('pending')
    const docId = (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (lease_id, landlord_id, unit_id, title, status, document_type)
       VALUES ($1,$2,$3,'Lease','sent','original_lease') RETURNING id`, [f.leaseId, f.landlordId, f.unitId])).rows[0].id
    const sale = (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (lease_id, landlord_id, unit_id, title, status, document_type)
       VALUES ($1,$2,$3,'Sale','sent','purchase_agreement') RETURNING id`, [f.leaseId, f.landlordId, f.unitId])).rows[0].id
    await signer(docId, { role: 'landlord', userId: f.userId, signed: false, order: 1 })
    await signer(docId, { role: 'primary', signed: false, order: 2 })
    const res = await discard(f.leaseId, f.token)
    expect(res.status).toBe(200)
    const doc = (await db.query<any>(`SELECT status, voided_at, void_reason FROM lease_documents WHERE id = $1`, [docId])).rows[0]
    expect(doc.status).toBe('voided')
    expect(doc.voided_at).toBeTruthy()
    expect(doc.void_reason).toBe('The lease ended: the unsigned draft was discarded')
    expect((await db.query<any>(`SELECT status FROM lease_documents WHERE id = $1`, [sale])).rows[0].status).toBe('sent')
    // The link already sent no longer signs anything.
    const signRes = await request(buildApp())
      .post(`/api/esign/sign/${docId}`).set('Authorization', `Bearer ${f.token}`).send({ fieldValues: [] })
    expect(signRes.status).toBe(400)
    expect(signRes.body.error).toBe('Document has been voided')
    expect((await db.query<any>(`SELECT status FROM leases WHERE id = $1`, [f.leaseId])).rows[0].status).toBe('terminated')
  })

  // Fix pass 3: every Discard path checks the property scope (before only the
  // tenant-signed one did), and answers in plain words.
  it('a team member locked to another property is refused in plain words, and nothing changes', async () => {
    const f = await seedDraft('pending')
    const c = await getClient()
    let otherId: string
    try { otherId = await seedProperty(c, { landlordId: f.landlordId, ownerUserId: f.userId, managedByUserId: f.userId }) }
    finally { c.release() }
    const staffId = (await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ('staff-' || gen_random_uuid() || '@t.dev', 'x', 'onsite_manager', 'Lisa', 'Staff', TRUE) RETURNING id`)).rows[0].id
    await db.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, all_properties)
       VALUES ($1, $2, $3::uuid[], FALSE)`, [staffId, f.landlordId, [otherId!]])
    const staff = jwt.sign({ userId: staffId, role: 'onsite_manager', email: 's@t.dev', landlordId: f.landlordId,
      permissions: { 'leases.terminate': true } }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const res = await discard(f.leaseId, staff)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('You are not assigned to this property, so you can’t end its leases. Ask the landlord to add this property to your access.')
    expect((await db.query<any>('SELECT status FROM leases WHERE id=$1', [f.leaseId])).rows[0].status).toBe('pending')
  })

  // Fix pass 2: Discard sent from a stale list ("the unsigned draft … nothing
  // is sent") never zeroes a bill nobody was shown.
  it('a lease a tenant signed, Discard pressed without the confirm’s total: 409 in plain words naming “They never moved in — end the lease”, nothing changed', async () => {
    const f = await seedDraft('pending')
    await signedBy(f, 'tenant')
    const res = await discard(f.leaseId, f.token)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('tenant_signed')
    expect(res.body.error).toBe('A tenant signed this lease, so it isn’t an unsigned draft. ' +
      'Use “They never moved in — end the lease” — it shows exactly what would be zeroed first.')
    expect((await db.query<any>('SELECT status FROM leases WHERE id=$1', [f.leaseId])).rows[0].status).toBe('pending')
  })

  // Fix pass 2: the page and the server use ONE test for "a tenant signed" —
  // any non-landlord signer — not leases.signed_by_tenant, which is set only
  // once everyone has signed.
  it('a roommate lease the landlord issued where only the primary signed: the list says a tenant signed (though signed_by_tenant is false), and Discard without the confirm’s total is refused, nothing zeroed', async () => {
    const f = await seedDraft('pending')
    await db.query(`UPDATE leases SET signed_by_landlord = TRUE, signed_by_tenant = FALSE, lease_source = 'esigned' WHERE id = $1`, [f.leaseId])
    const docId = (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (lease_id, landlord_id, title, status, document_type)
       VALUES ($1,$2,'Lease','in_progress','original_lease') RETURNING id`, [f.leaseId, f.landlordId])).rows[0].id
    await signer(docId, { role: 'landlord', userId: f.userId, signed: true, order: 1 })
    await signer(docId, { role: 'primary', signed: true, order: 2 })
    await signer(docId, { role: 'co_tenant_1', signed: false, order: 3 })
    const inv = (await db.query<{ id: string }>(
      `INSERT INTO invoices (landlord_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount)
       VALUES ($1,$2,$3,'INV-' || substr(gen_random_uuid()::text, 1, 8), CURRENT_DATE, 589, 589) RETURNING id`,
      [f.landlordId, f.leaseId, f.unitId])).rows[0].id
    await db.query(
      `INSERT INTO payments (invoice_id, unit_id, lease_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',589,'pending',CURRENT_DATE,'RENT')`, [inv, f.unitId, f.leaseId, f.landlordId])

    const list = await request(buildApp()).get('/api/leases').set('Authorization', `Bearer ${f.token}`)
    const row = list.body.data.find((l: any) => l.id === f.leaseId)
    expect(row).toMatchObject({ signed_by_tenant: false, tenant_signed_any: true, anyone_signed: true })

    const res = await discard(f.leaseId, f.token)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('tenant_signed')
    expect((await db.query<any>(`SELECT status, amount::float AS amount FROM payments WHERE invoice_id = $1`, [inv])).rows)
      .toEqual([{ status: 'pending', amount: 589 }])
    // With the total the confirm showed, it closes — and the co-tenant's
    // signature still to come can no longer complete a document for an ended lease.
    const done = await discard(f.leaseId, f.token, { expectedTotal: 589 })
    expect(done.status).toBe(200)
    expect(done.body.data).toMatchObject({ status: 'terminated', zeroed_total: 589 })
    expect((await db.query<any>(`SELECT status FROM lease_documents WHERE id = $1`, [docId])).rows[0].status).toBe('voided')
  })

  it('the list tells an unsigned draft and a lease only the landlord signed apart from one a tenant signed', async () => {
    const draft = await seedDraft('pending')
    const mine = await seedDraft('pending')
    await signedBy(mine, 'landlord')
    const list = await request(buildApp()).get('/api/leases').set('Authorization', `Bearer ${draft.token}`)
    expect(list.body.data.find((l: any) => l.id === draft.leaseId)).toMatchObject({ tenant_signed_any: false, anyone_signed: false })
    const other = await request(buildApp()).get('/api/leases').set('Authorization', `Bearer ${mine.token}`)
    expect(other.body.data.find((l: any) => l.id === mine.leaseId)).toMatchObject({ tenant_signed_any: false, anyone_signed: true })
  })

  // Fix pass 2: a lease the tenant signed and the landlord had not (an older
  // document): Discard ends it, and its document is voided in the same
  // transaction — so a landlord signature later can't issue (and bill) a
  // lease that already ended.
  it('a tenant-signed-only lease discarded, then the landlord signs: the signature is refused and nothing is issued or billed', async () => {
    const f = await seedDraft('pending')
    const docId = (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (lease_id, landlord_id, unit_id, title, status, document_type)
       VALUES ($1,$2,$3,'Lease','in_progress','original_lease') RETURNING id`, [f.leaseId, f.landlordId, f.unitId])).rows[0].id
    await signer(docId, { role: 'primary', signed: true, order: 2 })
    await signer(docId, { role: 'landlord', userId: f.userId, signed: false, order: 1 })
    const res = await discard(f.leaseId, f.token, { expectedTotal: 0 })
    expect(res.status).toBe(200)
    const doc = (await db.query<any>(`SELECT status, voided_at, void_reason FROM lease_documents WHERE id = $1`, [docId])).rows[0]
    expect(doc.status).toBe('voided')
    expect(doc.voided_at).toBeTruthy()
    expect(doc.void_reason).toBe('The lease ended: the tenant never moved in')

    const signRes = await request(buildApp())
      .post(`/api/esign/sign/${docId}`).set('Authorization', `Bearer ${f.token}`).send({ fieldValues: [] })
    expect(signRes.status).toBe(400)
    expect(signRes.body.error).toBe('Document has been voided')
    expect((await db.query<any>(`SELECT COUNT(*)::int AS n FROM invoices WHERE lease_id = $1`, [f.leaseId])).rows[0].n).toBe(0)
    expect((await db.query<any>(`SELECT COUNT(*)::int AS n FROM payments WHERE lease_id = $1`, [f.leaseId])).rows[0].n).toBe(0)
    expect((await db.query<any>(`SELECT status FROM leases WHERE id = $1`, [f.leaseId])).rows[0].status).toBe('terminated')
  })

  it('refuses another account’s draft', async () => {
    const mine   = await seedDraft('pending')
    const theirs = await seedDraft('pending')
    const res = await discard(theirs.leaseId, mine.token)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('This lease isn’t on your account.')
    expect((await db.query<any>('SELECT status FROM leases WHERE id=$1', [theirs.leaseId])).rows[0].status).toBe('pending')
  })
})
