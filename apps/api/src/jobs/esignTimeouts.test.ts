/**
 * S636 — the two 48-hour signing windows.
 *
 * Nic: "From the time I sign it to the time tenants sign it needs to
 * only be forty eight hours... From the time the tenant accepts the
 * portal invite to the time the landlord signs the lease needs to also
 * be forty eight hours."
 *
 * The bug these lock down: auto-void only ever looked at status='sent',
 * and the landlord's signature flips a document to 'in_progress'. So
 * signing your own side removed the document from the expiry window
 * permanently — eleven real leases were parked there with no deadline
 * and (the reminder pass being one-shot) no further nudges.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'

vi.mock('node-cron', () => ({ default: { schedule: vi.fn() }, schedule: vi.fn() }))
vi.mock('../services/email', async (orig) => ({
  ...(await orig() as any),
  emailSigningReminder:    vi.fn(async () => undefined),
  emailDocumentAutoVoided: vi.fn(async () => undefined),
  emailSigningRequest:     vi.fn(async () => undefined),
}))

import { processEsignTimeouts } from './scheduler'
import { emailSigningReminder, emailSigningRequest, emailDocumentAutoVoided } from '../services/email'

// Comfortably after the grandfather cutover, so these fixtures are
// governed by their own timestamps rather than floored to it.
const HOURS_AGO = (n: number) => `NOW() - INTERVAL '${n} hours'`

async function seedDoc(opts: {
  status: 'sent' | 'in_progress'
  sentHoursAgo?: number
  landlordSignedHoursAgo?: number
  tenantInvitedHoursAgo?: number
  tenantRemindedHoursAgo?: number | null
  /** S647: a tenant who accepted their invite, i.e. someone actually waiting on the landlord. */
  tenantAcceptedHoursAgo?: number
}) {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const docId = randomUUID()
    await c.query(
      `INSERT INTO lease_documents (id, landlord_id, unit_id, title, document_type, status, sent_at, created_at)
       VALUES ($1,$2,$3,'Lease','original_lease',$4, ${opts.sentHoursAgo != null ? HOURS_AGO(opts.sentHoursAgo) : 'NULL'}, NOW())`,
      [docId, landlordId, unitId, opts.status])
    if (opts.landlordSignedHoursAgo != null) {
      await c.query(
        `INSERT INTO lease_document_signers
           (document_id, user_id, role, name, email, order_index, token, status, invite_sent, invite_sent_at, signed_at)
         VALUES ($1,$2,'landlord','LL',$3,1,$4,'signed',TRUE, ${HOURS_AGO(opts.landlordSignedHoursAgo + 1)}, ${HOURS_AGO(opts.landlordSignedHoursAgo)})`,
        [docId, userId, `ll-${randomUUID()}@t.dev`, randomUUID()])
    }
    if (opts.tenantInvitedHoursAgo != null) {
      await c.query(
        `INSERT INTO lease_document_signers
           (document_id, user_id, role, name, email, order_index, token, status, invite_sent, invite_sent_at, reminder_sent_at)
         VALUES ($1,$2,'primary','TT',$3,2,$4,'sent',TRUE, ${HOURS_AGO(opts.tenantInvitedHoursAgo)},
                 ${opts.tenantRemindedHoursAgo != null ? HOURS_AGO(opts.tenantRemindedHoursAgo) : 'NULL'})`,
        [docId, userId, `tt-${randomUUID()}@t.dev`, randomUUID()])
    }
    if (opts.tenantAcceptedHoursAgo != null) {
      const tenantId = await seedTenant(c)
      await c.query(
        `INSERT INTO pending_tenant_intents
           (landlord_id, tenant_id, unit_id, property_id, draft_document_id, accepted_at)
         VALUES ($1,$2,$3,$4,$5, ${HOURS_AGO(opts.tenantAcceptedHoursAgo)})`,
        [landlordId, tenantId, unitId, propertyId, docId])
    }
    await c.query('COMMIT')
    return docId
  } catch (e) { await c.query('ROLLBACK'); throw e }
  finally { c.release() }
}

const statusOf = async (id: string) =>
  (await db.query<{ status: string }>(`SELECT status FROM lease_documents WHERE id=$1`, [id])).rows[0].status

beforeEach(async () => {
  await cleanupAllSchema()
  vi.clearAllMocks()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_esign'
  // Put the grandfather floor well in the past so these fixtures are
  // governed by their own timestamps. In production it sits at the
  // moment S636 shipped and protects the in-flight documents.
  process.env.ESIGN_48H_CUTOVER = '2020-01-01T00:00:00Z'
})

describe('S636 — window A: waiting on the landlord', () => {
  // S647: window A is "from the time the tenant accepts the portal invite to
  // the time the landlord signs". These fixtures now include the accepted
  // tenant that makes somebody actually be waiting.
  it('voids a document the landlord left unsigned for 48 hours after a tenant accepted', async () => {
    const id = await seedDoc({ status: 'sent', sentHoursAgo: 49, tenantAcceptedHoursAgo: 49 })
    await processEsignTimeouts()
    expect(await statusOf(id)).toBe('voided')
  })

  // S647 (Nic, DIRECTIVE): onboarding drafts leases for the landlord to sign
  // BEFORE anyone is told. Nobody is waiting on those, and voiding them after
  // two days would wipe an onboarding batch the landlord had not reached yet.
  it('never voids a draft that no tenant has accepted — it is the landlord\'s own queue', async () => {
    const id = await seedDoc({ status: 'sent', sentHoursAgo: 200 })
    await processEsignTimeouts()
    expect(await statusOf(id)).toBe('sent')
  })

  it('measures from the acceptance, not from when the draft was made', async () => {
    // Drafted a week ago at onboarding; the tenant accepted yesterday.
    const id = await seedDoc({ status: 'sent', sentHoursAgo: 170, tenantAcceptedHoursAgo: 24 })
    await processEsignTimeouts()
    expect(await statusOf(id)).toBe('sent')
  })

  it('leaves one still inside the window alone', async () => {
    const id = await seedDoc({ status: 'sent', sentHoursAgo: 47 })
    await processEsignTimeouts()
    expect(await statusOf(id)).toBe('sent')
  })

  it('does not void at 25 hours — the old window was 24h', async () => {
    const id = await seedDoc({ status: 'sent', sentHoursAgo: 25 })
    await processEsignTimeouts()
    expect(await statusOf(id)).toBe('sent')
  })
})

describe('S636 — window B: waiting on the tenant', () => {
  // S637 (Nic, DIRECTIVE) — REVERSES the S636 behavior this test asserted.
  //
  //   "I'm not gonna fucking sign it every time somebody fails to do their part
  //    on time. It needs to be resent to them for signature."
  //
  // Voiding here threw away the landlord's finished signature because a tenant
  // was slow. Two live leases were destroyed that way — Oak Park RV 24 and
  // Mountain View MH 25, the latter with two of three already signed.
  it('resends instead of voiding when only the tenant is outstanding', async () => {
    const id = await seedDoc({
      status: 'in_progress', sentHoursAgo: 50,
      landlordSignedHoursAgo: 49, tenantInvitedHoursAgo: 49,
    })
    await processEsignTimeouts()
    expect(await statusOf(id)).toBe('in_progress')      // survives, with signatures

    // The window restarts from the resend, so the very next run must not fire
    // again — otherwise it would mail the tenant every 15 minutes forever.
    const { rows } = await db.query<{ restarted: Date | null }>(
      `SELECT signing_window_restarted_at AS restarted FROM lease_documents WHERE id=$1`, [id])
    expect(rows[0].restarted).not.toBeNull()
    await processEsignTimeouts()
    expect(await statusOf(id)).toBe('in_progress')
  })

  // The landlord's own inaction is still his problem: nothing of his is at
  // stake, so the original window stands.
  it('still voids when the LANDLORD is the one who has not signed', async () => {
    const id = await seedDoc({ status: 'sent', sentHoursAgo: 50, tenantAcceptedHoursAgo: 50 })
    await processEsignTimeouts()
    expect(await statusOf(id)).toBe('voided')
  })

  it('leaves an in-progress document inside the window alone', async () => {
    const id = await seedDoc({
      status: 'in_progress', sentHoursAgo: 47,
      landlordSignedHoursAgo: 46, tenantInvitedHoursAgo: 46,
    })
    await processEsignTimeouts()
    expect(await statusOf(id)).toBe('in_progress')
  })

  it('never voids one where every signer is done', async () => {
    const id = await seedDoc({ status: 'in_progress', sentHoursAgo: 80, landlordSignedHoursAgo: 79 })
    await processEsignTimeouts()
    expect(await statusOf(id)).toBe('in_progress')
  })
})

// S639: the cadence below was "every 2 hours, forever". On the live database
// that had produced 952 reminder emails to 39 people over eight days — about
// eighty to one resident — and was the shortest path to our own domain being
// treated as a spam sender, which would have taken the invites and receipts
// down with it. Now: once a day, five times, then stop.
describe('S639 — tenant reminders once a day, and they stop', () => {
  it('nudges a tenant again once a day has passed since the last one', async () => {
    await seedDoc({
      status: 'in_progress', sentHoursAgo: 40,
      landlordSignedHoursAgo: 39, tenantInvitedHoursAgo: 39, tenantRemindedHoursAgo: 25,
    })
    await processEsignTimeouts()
    expect(emailSigningReminder).toHaveBeenCalledTimes(1)
  })

  it('holds off when the last nudge was under a day ago', async () => {
    await seedDoc({
      status: 'in_progress', sentHoursAgo: 10,
      landlordSignedHoursAgo: 9, tenantInvitedHoursAgo: 9, tenantRemindedHoursAgo: 3,
    })
    await processEsignTimeouts()
    expect(emailSigningReminder).not.toHaveBeenCalled()
  })

  it('stops after five — somebody who ignored five is not signing because of a sixth', async () => {
    await seedDoc({
      status: 'in_progress', sentHoursAgo: 200,
      landlordSignedHoursAgo: 199, tenantInvitedHoursAgo: 199, tenantRemindedHoursAgo: 25,
    })
    await db.query(
      `UPDATE lease_document_signers SET reminder_count = 5 WHERE role <> 'landlord'`)
    await processEsignTimeouts()
    expect(emailSigningReminder).not.toHaveBeenCalled()
  })

  it('counts each nudge, so the cap can be reached', async () => {
    await seedDoc({
      status: 'in_progress', sentHoursAgo: 40,
      landlordSignedHoursAgo: 39, tenantInvitedHoursAgo: 39, tenantRemindedHoursAgo: 25,
    })
    await processEsignTimeouts()
    const { rows } = await db.query<any>(
      `SELECT reminder_count FROM lease_document_signers WHERE role <> 'landlord'`)
    expect(Number(rows[0].reminder_count)).toBe(1)
  })

  it('keeps the landlord-side nudge one-shot', async () => {
    // Landlord has NOT signed, so the tenant is not yet in the 2h loop
    // and their single reminder has already gone out.
    await seedDoc({ status: 'sent', sentHoursAgo: 10, tenantInvitedHoursAgo: 9, tenantRemindedHoursAgo: 5 })
    await processEsignTimeouts()
    expect(emailSigningReminder).not.toHaveBeenCalled()
  })
})

// ─── S652 (Nic, Blu): "he just wants one per packet" ─────────────────────────
//
// Eight re-drafted packets produced fifty-four reminder emails in one tick,
// one per document. A packet is reminded about once, and every document in it
// is stamped so the cadence and the cap count packets.
describe('S652 — one reminder per signer per packet', () => {
  it('sends one email for a packet of three and stamps all three signer rows', async () => {
    const first = await seedDoc({
      status: 'in_progress', sentHoursAgo: 40,
      landlordSignedHoursAgo: 39, tenantInvitedHoursAgo: 39, tenantRemindedHoursAgo: 25,
    })
    const base = (await db.query<any>(
      `SELECT d.landlord_id, d.unit_id, s.user_id, s.email, s.name
         FROM lease_documents d JOIN lease_document_signers s ON s.document_id = d.id AND s.role = 'primary'
        WHERE d.id = $1`, [first])).rows[0]
    const llUser = (await db.query<any>(
      `SELECT user_id FROM lease_document_signers WHERE document_id = $1 AND role = 'landlord'`, [first])).rows[0].user_id
    const packet = randomUUID()
    await db.query(`UPDATE lease_documents SET package_group_id = $2, package_sort_order = 0 WHERE id = $1`, [first, packet])
    for (const [i, title] of [[1, 'Radon'], [2, 'Lead paint']] as const) {
      const id = randomUUID()
      await db.query(
        `INSERT INTO lease_documents (id, landlord_id, unit_id, title, document_type, status, sent_at, created_at, package_group_id, package_sort_order)
         VALUES ($1,$2,$3,$4,'addendum_terms','in_progress', NOW() - INTERVAL '40 hours', NOW(), $5, $6)`,
        [id, base.landlord_id, base.unit_id, title, packet, i])
      await db.query(
        `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status, invite_sent, invite_sent_at, signed_at)
         VALUES ($1,$2,'landlord','LL',$3,1,$4,'signed',TRUE, NOW() - INTERVAL '40 hours', NOW() - INTERVAL '39 hours')`,
        [id, llUser, `ll-${randomUUID()}@t.dev`, randomUUID()])
      await db.query(
        `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status, invite_sent, invite_sent_at, reminder_sent_at)
         VALUES ($1,$2,'primary',$3,$4,2,$5,'sent',TRUE, NOW() - INTERVAL '39 hours', NOW() - INTERVAL '25 hours')`,
        [id, base.user_id, base.name, base.email, randomUUID()])
    }
    await processEsignTimeouts()
    expect(emailSigningReminder).toHaveBeenCalledTimes(1)
    const [, , title, , , , meta] = (emailSigningReminder as any).mock.calls[0]
    expect(meta.documentCount).toBe(3)
    expect(title).toMatch(/3 documents/)
    // the link opens the FIRST document of the packet
    expect(meta.documentId).toBe(first)
    const { rows } = await db.query<any>(
      `SELECT reminder_count, reminder_sent_at FROM lease_document_signers WHERE role = 'primary' AND email = $1`, [base.email])
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(Number(r.reminder_count)).toBe(1)
      expect(new Date(r.reminder_sent_at).getTime()).toBeGreaterThan(Date.now() - 60_000)
    }
  })
})

// ─── S638: a resend goes to ONE person, never the whole household ────────────
//
// Nic: "I don't want it to send to them at all out of order because I have
// several people that think they already did it when they actually haven't."
//
// The resend-instead-of-void path (S637) looped over EVERY outstanding signer
// and mailed them all in one pass, stamping invite_sent_at on each. Brandon
// Valdez and Yesenia Sanchez were both mailed at 15:15:02 on the 7th; Ruben
// Chavarin and Obed Parra both at 13:45:02 on the 8th. The one behind opened
// it, filled it in, could not submit, and reported themselves as done.
describe('S638 a timeout resend targets only the current signer', () => {
  it('mails the primary and leaves the co-tenant untouched', async () => {
    const docId = await seedDoc({
      status: 'in_progress',
      landlordSignedHoursAgo: 60,      // past the 48h window → triggers the resend
      tenantInvitedHoursAgo: 59,
    })
    // A co-tenant sitting behind the primary, never invited.
    const c = await db.connect()
    try {
      // Reuse the document's landlord user — the signer row only needs a
      // valid user_id; which person it is does not matter for turn order.
      const { rows: [any0] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM lease_document_signers WHERE document_id=$1 LIMIT 1`, [docId])
      await c.query(
        `INSERT INTO lease_document_signers
           (document_id, user_id, role, name, email, order_index, token, status, invite_sent)
         VALUES ($1,$2,'co_tenant_1','CT',$3,3,$4,'pending',FALSE)`,
        [docId, any0.user_id, `ct-${randomUUID()}@t.dev`, randomUUID()])
    } finally { c.release() }

    await processEsignTimeouts()

    const { rows } = await db.query<{ role: string; status: string; invite_sent_at: string | null }>(
      `SELECT role, status, invite_sent_at FROM lease_document_signers
        WHERE document_id = $1 ORDER BY order_index`, [docId])
    const primary = rows.find(r => r.role === 'primary')!
    const co      = rows.find(r => r.role === 'co_tenant_1')!

    // The person whose turn it is gets chased.
    expect(primary.status).toBe('sent')
    expect(primary.invite_sent_at).not.toBeNull()
    // The one behind them is still waiting — no mail, no stamp, no false start.
    expect(co.status).toBe('pending')
    expect(co.invite_sent_at).toBeNull()
  })
})

// ─── S654: a signing link goes only to the address on the signer's account ───
//
// A signing token is a full stand-in for that signer (S629). The reminders and
// the 48-hour resend mailed it to the signer ROW's address. Rows can hold an
// old address: the landlord's email correction moved only the lease's row, so
// a packet's second document still pointed at the mistyped mailbox, and the
// reminder sent that mailbox a token whose signing page lists the lease too.
describe('S654 — reminders and resends go to the account, not the signer row', () => {
  const PLACEHOLDER = '$2b$10$placeholder_invite_pending'
  const TYPO = 'y.typo@exampel.test'
  const RIGHT = 'y.right@example.test'

  /** Landlord B's unit, and Y: B's own invitee, never set up, now at the corrected address. */
  async function companyAndResident() {
    const c = await db.connect()
    let landlordId: string, llUser: string, unitId: string, tenantId: string
    try {
      await c.query('BEGIN')
      const l = await seedLandlord(c)
      landlordId = l.landlordId; llUser = l.userId
      const propertyId = await seedProperty(c, { landlordId, ownerUserId: llUser, managedByUserId: llUser })
      unitId = await seedUnit(c, { propertyId, landlordId })
      tenantId = await seedTenant(c)
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    const y = (await db.query<{ id: string }>(
      `UPDATE users SET email=$2, password_hash=$3, tenant_invite_token=NULL, tenant_invite_expires_at=NULL,
                        tenant_invite_accepted_at=NULL
        WHERE id = (SELECT user_id FROM tenants WHERE id=$1) RETURNING id`,
      [tenantId!, RIGHT, PLACEHOLDER])).rows[0].id
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id)
       VALUES ($1, $2, 'not_uploaded', $3)`, [landlordId!, tenantId!, unitId!])
    return { landlordId: landlordId!, llUser: llUser!, unitId: unitId!, yUser: y }
  }

  /** A document the landlord has signed, with Y waiting on it at `rowEmail`. */
  async function signedByLandlord(f: Awaited<ReturnType<typeof companyAndResident>>, o: {
    title: string; rowEmail: string; packet?: string; sort?: number
    landlordSignedHoursAgo: number; yInvitedHoursAgo: number; yRemindedHoursAgo?: number | null
  }) {
    const id = randomUUID()
    await db.query(
      `INSERT INTO lease_documents (id, landlord_id, unit_id, title, document_type, status, sent_at, created_at,
                                    package_group_id, package_sort_order)
       VALUES ($1,$2,$3,$4,'original_lease','in_progress', ${HOURS_AGO(o.landlordSignedHoursAgo + 1)}, NOW(), $5, $6)`,
      [id, f.landlordId, f.unitId, o.title, o.packet ?? null, o.sort ?? 0])
    await db.query(
      `INSERT INTO lease_document_signers
         (document_id, user_id, role, name, email, order_index, token, status, invite_sent, invite_sent_at, signed_at)
       VALUES ($1,$2,'landlord','LL','ll@b.test',1,$3,'signed',TRUE, ${HOURS_AGO(o.landlordSignedHoursAgo + 1)}, ${HOURS_AGO(o.landlordSignedHoursAgo)})`,
      [id, f.llUser, randomUUID()])
    const token = randomUUID()
    await db.query(
      `INSERT INTO lease_document_signers
         (document_id, user_id, role, name, email, order_index, token, status, invite_sent, invite_sent_at, reminder_sent_at)
       VALUES ($1,$2,'primary','Y',$3,2,$4,'sent',TRUE, ${HOURS_AGO(o.yInvitedHoursAgo)},
               ${o.yRemindedHoursAgo != null ? HOURS_AGO(o.yRemindedHoursAgo) : 'NULL'})`,
      [id, f.yUser, o.rowEmail, token])
    return { id, token }
  }

  it('the reminder: one email for the packet, to the account, never to the stale row', async () => {
    const f = await companyAndResident()
    const packet = randomUUID()
    // The correction moved the lease's row; the second document still holds the typo.
    await signedByLandlord(f, { title: 'Lease', rowEmail: RIGHT, packet, sort: 0,
      landlordSignedHoursAgo: 30, yInvitedHoursAgo: 30, yRemindedHoursAgo: 25 })
    const second = await signedByLandlord(f, { title: 'Pet addendum', rowEmail: TYPO, packet, sort: 1,
      landlordSignedHoursAgo: 30, yInvitedHoursAgo: 30, yRemindedHoursAgo: 25 })

    await processEsignTimeouts()

    const calls = (emailSigningReminder as any).mock.calls
    expect(calls.map((c: any[]) => c[0])).toEqual([RIGHT])
    expect(calls[0][6].documentCount).toBe(2)
    expect(JSON.stringify(calls)).not.toContain(second.token)
    // Both of Y's rows were stamped by that one email.
    const { rows } = await db.query<any>(
      `SELECT reminder_count FROM lease_document_signers WHERE user_id = $1`, [f.yUser])
    expect(rows.map(r => Number(r.reminder_count))).toEqual([1, 1])
  })

  it('the reminder carries the setup link once it goes to the account itself', async () => {
    const f = await companyAndResident()
    await signedByLandlord(f, { title: 'Lease', rowEmail: TYPO,
      landlordSignedHoursAgo: 30, yInvitedHoursAgo: 30, yRemindedHoursAgo: 25 })
    await processEsignTimeouts()
    const calls = (emailSigningReminder as any).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(RIGHT)
    expect(calls[0][5]).toMatch(/\/accept-invite\?token=[0-9a-f]{64}&next=/)
    expect(calls[0][6].needsSetup).toBe(true)
  })

  it('the 48-hour resend goes to the account, never to the stale row', async () => {
    const f = await companyAndResident()
    const doc = await signedByLandlord(f, { title: 'Lease', rowEmail: TYPO,
      landlordSignedHoursAgo: 60, yInvitedHoursAgo: 59 })

    await processEsignTimeouts()

    const calls = (emailSigningRequest as any).mock.calls
    expect(calls.map((c: any[]) => c[0])).toEqual([RIGHT])
    expect(calls[0][5]).toMatch(/\/accept-invite\?token=[0-9a-f]{64}&next=/)
    expect(calls[0][6].needsSetup).toBe(true)
    expect(JSON.stringify((emailSigningReminder as any).mock.calls)).not.toContain(TYPO)
    expect(await statusOf(doc.id)).toBe('in_progress')
  })

  it('an auto-void notice goes to the account too', async () => {
    const f = await companyAndResident()
    const id = randomUUID()
    // Waiting on the landlord past window A, with Y's row at the typo.
    await db.query(
      `INSERT INTO lease_documents (id, landlord_id, unit_id, title, document_type, status, sent_at, created_at)
       VALUES ($1,$2,$3,'Lease','original_lease','sent', ${HOURS_AGO(60)}, NOW())`, [id, f.landlordId, f.unitId])
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status)
       VALUES ($1,$2,'primary','Y',$3,2,$4,'pending')`, [id, f.yUser, TYPO, randomUUID()])
    await db.query(
      `UPDATE pending_tenant_intents SET draft_document_id=$1, accepted_at=${HOURS_AGO(60)} WHERE landlord_id=$2`,
      [id, f.landlordId])

    await processEsignTimeouts()

    expect(await statusOf(id)).toBe('voided')
    const to = (emailDocumentAutoVoided as any).mock.calls.map((c: any[]) => c[0])
    expect(to).toContain(RIGHT)
    expect(to).not.toContain(TYPO)
  })
})
