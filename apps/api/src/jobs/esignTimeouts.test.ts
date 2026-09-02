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
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'

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
  it('voids a document the landlord left unsigned for 48 hours', async () => {
    const id = await seedDoc({ status: 'sent', sentHoursAgo: 49 })
    await processEsignTimeouts()
    expect(await statusOf(id)).toBe('voided')
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
  it('voids when the landlord signed 48h ago and the tenant never did', async () => {
    const id = await seedDoc({
      status: 'in_progress', sentHoursAgo: 50,
      landlordSignedHoursAgo: 49, tenantInvitedHoursAgo: 49,
    })
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

describe('S636 — tenant reminders every 2 hours', () => {
  it('nudges a tenant again once 2 hours have passed since the last one', async () => {
    await seedDoc({
      status: 'in_progress', sentHoursAgo: 10,
      landlordSignedHoursAgo: 9, tenantInvitedHoursAgo: 9, tenantRemindedHoursAgo: 3,
    })
    await processEsignTimeouts()
    expect(emailSigningReminder).toHaveBeenCalledTimes(1)
  })

  it('holds off when the last nudge was under 2 hours ago', async () => {
    await seedDoc({
      status: 'in_progress', sentHoursAgo: 10,
      landlordSignedHoursAgo: 9, tenantInvitedHoursAgo: 9, tenantRemindedHoursAgo: 1,
    })
    await processEsignTimeouts()
    expect(emailSigningReminder).not.toHaveBeenCalled()
  })

  it('keeps the landlord-side nudge one-shot', async () => {
    // Landlord has NOT signed, so the tenant is not yet in the 2h loop
    // and their single reminder has already gone out.
    await seedDoc({ status: 'sent', sentHoursAgo: 10, tenantInvitedHoursAgo: 9, tenantRemindedHoursAgo: 5 })
    await processEsignTimeouts()
    expect(emailSigningReminder).not.toHaveBeenCalled()
  })
})
