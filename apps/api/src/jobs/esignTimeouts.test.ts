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
}))

import { processEsignTimeouts } from './scheduler'
import { emailSigningReminder } from '../services/email'

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
  // S637 (Nic, DIRECTIVE) — REVERSES the S636 behaviour this test asserted.
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
