/**
 * creditChainCheck — the nightly credit chain check (10/13, Nic: "ADD the
 * nightly chain check (break flagged in the morning admin email)").
 *
 *   - checkCreditChains       every chain verified; the broken ones named
 *                             (whose record, the first bad entry)
 *   - brokenChainsEmail       one line per broken chain, the break in words
 *   - flagBrokenCreditChains  one admin email (super admins) when any chain is
 *                             broken; nothing when all are whole (a chain whole
 *                             since its restart included); a "did not run"
 *                             email when the check cannot finish; `sent` read
 *                             back from admin_notifications, never assumed
 *                             (10/13, review)
 *
 * The real createAdminNotification writes its row here (only the mail call is
 * stubbed), so "on record" is the production path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedTenant, seedLandlord } from '../test/dbHelpers'
import { appendEvent, computeEventHash, restartChain, CHAIN_BREAK_LABEL, CHAIN_BREAKS } from './creditLedger'

/** The notification helper's write fails (it swallows the error, as in production). */
const h = vi.hoisted(() => ({ writeFails: false }))
const adminNote = vi.hoisted(() => vi.fn())
const sendMail = vi.hoisted(() => vi.fn(async (_o: any) => 'msg_mock'))
vi.mock('./email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendNotificationEmail: (o: any) => sendMail(o),
}))
vi.mock('./adminNotifications', async (importOriginal) => {
  const real = await importOriginal<typeof import('./adminNotifications')>()
  // A severity outside the table's CHECK makes the real insert fail; the real
  // helper logs it and returns as if nothing happened.
  adminNote.mockImplementation((o: any) => real.createAdminNotification(h.writeFails ? { ...o, severity: 'not-a-severity' } : o))
  return { ...real, createAdminNotification: (o: any) => adminNote(o) }
})

import {
  checkCreditChains, brokenChainsEmail, flagBrokenCreditChains, flagChainCheckFailed,
  CHAIN_BROKEN_CATEGORY, CHAIN_CHECK_FAILED_CATEGORY, type BrokenChain,
} from './creditChainCheck'

beforeEach(async () => {
  await cleanupAllSchema()
  adminNote.mockClear()
  sendMail.mockClear()
  h.writeFails = false
})

/** The admin notifications on record, oldest first. */
async function onRecord() {
  return (await db.query<{ severity: string; category: string; title: string; body: string; context: any }>(
    `SELECT severity, category, title, body, context FROM admin_notifications ORDER BY created_at, id`)).rows
}

async function superAdmin(email: string): Promise<void> {
  await db.query(
    `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'super_admin', 'Super', 'Admin', TRUE)`, [email])
}

const ON = new Date('2026-10-12T12:00:00Z')   // 10/12/2026 in Phoenix
const ev = (subjectType: 'tenant' | 'landlord', refId: string, i: number) => ({
  subjectType, subjectRefId: refId,
  eventType: 'payment_received_on_time' as const, eventData: { i },
  occurredAt: ON,
  attestationSource: 'gam_workflow_auto' as const,
  networkVisibility: 'visible_to_current_landlord' as const,
})

/** Re-link an event to follow another, its hash recomputed so only the link is wrong. */
async function relink(id: string, prevHash: Buffer) {
  const row = (await db.query<any>(`SELECT event_data, occurred_at, attestation_source, attestation_evidence FROM credit_events WHERE id = $1`, [id])).rows[0]
  const forged = computeEventHash({ prevHash, eventData: row.event_data, occurredAt: new Date(row.occurred_at),
    attestationSource: row.attestation_source, attestationEvidence: row.attestation_evidence })
  await db.query(`UPDATE credit_events SET prev_hash = $1, this_hash = $2 WHERE id = $3`, [prevHash, forged, id])
}

/** a → b, and c also after a (the pre-10/12 bug's fork): c is the first bad entry. */
async function forked(subjectType: 'tenant' | 'landlord', refId: string) {
  const a = await appendEvent(ev(subjectType, refId, 1))
  await appendEvent(ev(subjectType, refId, 2))
  const c = await appendEvent(ev(subjectType, refId, 3))
  await relink(c.eventId, a.thisHash)
  return { subjectId: a.subjectId, firstBad: c.eventId }
}

async function namedTenant(first: string, last: string): Promise<string> {
  const c = await db.connect()
  try {
    const tenantId = await seedTenant(c)
    await c.query(`UPDATE users SET first_name = $2, last_name = $3 WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`, [tenantId, first, last])
    return tenantId
  } finally { c.release() }
}

async function namedLandlord(businessName: string): Promise<string> {
  const c = await db.connect()
  try {
    const { landlordId } = await seedLandlord(c)
    await c.query(`UPDATE landlords SET business_name = $2 WHERE id = $1`, [landlordId, businessName])
    return landlordId
  } finally { c.release() }
}

describe('the nightly chain check (10/13)', () => {
  it('every chain whole — one never restarted, one whole since its restart: nothing sent', async () => {
    const t = await namedTenant('Whole', 'Chain')
    await appendEvent(ev('tenant', t, 1))
    await appendEvent(ev('tenant', t, 2))
    const r = await forked('tenant', await namedTenant('Restarted', 'Chain'))
    await restartChain({ subjectId: r.subjectId, note: 'Restarted 10/13/2026: the chain split in two (a fork).' })

    expect(await checkCreditChains()).toEqual({ subjects: 2, whole: 2, broken: [] })
    expect(await flagBrokenCreditChains()).toEqual({ subjects: 2, whole: 2, broken: 0, sent: false, errors: 0 })
    expect(adminNote).not.toHaveBeenCalled()
    expect(await onRecord()).toEqual([])
  })

  it('no credit records at all: nothing checked, nothing sent', async () => {
    expect(await flagBrokenCreditChains()).toEqual({ subjects: 0, whole: 0, broken: 0, sent: false, errors: 0 })
    expect(adminNote).not.toHaveBeenCalled()
  })

  it('broken chains are named: whose record (tenant name, company name), the first bad entry, the break', async () => {
    const jane = await namedTenant('Jane', 'Doe')
    const tf = await forked('tenant', jane)
    // A company's record with an entry changed after it was written.
    const oak = await namedLandlord('Oak Park LLC')
    await appendEvent(ev('landlord', oak, 1))
    const changed = await appendEvent(ev('landlord', oak, 2))
    await db.query(`UPDATE credit_events SET event_data = '{"i": 99}'::jsonb WHERE id = $1`, [changed.eventId])
    // A whole chain beside them.
    await appendEvent(ev('tenant', await namedTenant('Fine', 'Tenant'), 1))

    const r = await checkCreditChains()
    expect(r.subjects).toBe(3)
    expect(r.whole).toBe(1)
    expect(r.broken).toHaveLength(2)
    expect(r.broken).toEqual(expect.arrayContaining([
      {
        subjectId: tf.subjectId, subjectType: 'tenant', name: 'Jane Doe',
        firstBadEventId: tf.firstBad, firstBadEventType: 'payment_received_on_time', firstBadOn: '2026-10-12',
        break: 'fork', reason: expect.stringMatching(/a fork/),
      },
      {
        subjectId: changed.subjectId, subjectType: 'landlord', name: 'Oak Park LLC',
        firstBadEventId: changed.eventId, firstBadEventType: 'payment_received_on_time', firstBadOn: '2026-10-12',
        break: 'tampered', reason: 'this_hash does not match recomputed digest',
      },
    ]))

    await superAdmin('owner@gam.dev')
    expect(await flagBrokenCreditChains()).toEqual({ subjects: 3, whole: 1, broken: 2, sent: true, errors: 0 })
    expect(adminNote).toHaveBeenCalledTimes(1)   // one email for every broken chain
    const n = adminNote.mock.calls[0][0]
    expect(n).toMatchObject({
      severity: 'critical', category: 'credit_chain_broken', emailSuperAdmins: true,
      title: '2 credit history chains broken',
    })
    const lines = (n.body as string).split('\n')
    expect(lines).toHaveLength(2)
    const janeLine = lines.find((l) => l.includes('Jane Doe'))!
    expect(janeLine).toBe(
      `BROKEN — Jane Doe (tenant): first bad entry Payment Received On Time, 10/12/2026 (entry ${tf.firstBad})`
      + ` — ${CHAIN_BREAK_LABEL.fork}. Credit record ${tf.subjectId}.`)
    const oakLine = lines.find((l) => l.includes('Oak Park LLC'))!
    expect(oakLine).toBe(
      `BROKEN — Oak Park LLC (landlord): first bad entry Payment Received On Time, 10/12/2026 (entry ${changed.eventId})`
      + ` — ${CHAIN_BREAK_LABEL.tampered}. Credit record ${changed.subjectId}.`)
    // No raw identifiers in the words (the ids are labeled as entry / credit record ids).
    expect(n.body).not.toMatch(/payment_received_on_time|prev_hash|this_hash/)
    // 10/13 (review): the email prints the body as one paragraph, so the
    // context block under it names each chain again in words, one per chain.
    expect(n.context).toEqual({
      checked: 3, whole: 1,
      broken: expect.arrayContaining([
        {
          record: 'Jane Doe (tenant)', firstBadEntry: 'Payment Received On Time, 10/12/2026', problem: CHAIN_BREAK_LABEL.fork,
          subjectId: tf.subjectId, firstBadEventId: tf.firstBad, break: 'fork', reason: expect.stringMatching(/a fork/),
        },
        {
          record: 'Oak Park LLC (landlord)', firstBadEntry: 'Payment Received On Time, 10/12/2026', problem: CHAIN_BREAK_LABEL.tampered,
          subjectId: changed.subjectId, firstBadEventId: changed.eventId, break: 'tampered', reason: 'this_hash does not match recomputed digest',
        },
      ]),
    })
    // On record — the in-app row, exactly what was raised — and emailed to the super admin.
    const rows = await onRecord()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ severity: 'critical', category: CHAIN_BROKEN_CATEGORY, title: n.title, body: n.body, context: n.context })
    expect(sendMail).toHaveBeenCalledTimes(1)
    expect(sendMail.mock.calls[0][0]).toMatchObject({ to: 'owner@gam.dev', subject: '[GAM ADMIN CRITICAL] 2 credit history chains broken' })
    expect(sendMail.mock.calls[0][0].html).toContain('Jane Doe (tenant)')
  })

  it('the email is not on record (the helper swallowed a failed write): not sent, counted as an error', async () => {
    await forked('tenant', await namedTenant('Jane', 'Doe'))
    h.writeFails = true
    expect(await flagBrokenCreditChains()).toEqual({ subjects: 1, whole: 0, broken: 1, sent: false, errors: 1 })
    expect(adminNote).toHaveBeenCalledTimes(1)
    expect(await onRecord()).toEqual([])
    // The next night it is on record.
    h.writeFails = false
    expect(await flagBrokenCreditChains()).toEqual({ subjects: 1, whole: 0, broken: 1, sent: true, errors: 0 })
    expect((await onRecord()).map((r) => r.category)).toEqual([CHAIN_BROKEN_CATEGORY])
  })

  it('a check that cannot finish sends the "did not run" email instead — a quiet morning means every chain is whole', async () => {
    await forked('tenant', await namedTenant('Jane', 'Doe'))
    await superAdmin('owner@gam.dev')
    const down = { query: async () => { throw new Error('connection terminated') } }
    expect(await flagBrokenCreditChains(down as any)).toEqual({ subjects: 0, whole: 0, broken: 0, sent: true, errors: 1 })
    expect(adminNote).toHaveBeenCalledTimes(1)
    expect(adminNote.mock.calls[0][0]).toMatchObject({
      severity: 'warn', category: CHAIN_CHECK_FAILED_CATEGORY, emailSuperAdmins: true,
      title: 'The credit chain check did not run tonight',
    })
    const rows = await onRecord()
    expect(rows).toEqual([expect.objectContaining({ severity: 'warn', category: CHAIN_CHECK_FAILED_CATEGORY, context: { error: 'connection terminated' } })])
    expect(rows[0].body).toBe("Tonight's check of every credit history chain stopped before it finished: connection terminated. "
      + 'No chain was checked, so a morning without a broken-chain email does not mean every chain is whole. '
      + 'The check runs again tomorrow night.')
    expect(sendMail).toHaveBeenCalledTimes(1)
    expect(sendMail.mock.calls[0][0]).toMatchObject({ to: 'owner@gam.dev', subject: '[GAM ADMIN WARN] The credit chain check did not run tonight' })
  })

  it('"did not run" whose own write fails: not sent, never throws', async () => {
    h.writeFails = true
    expect(await flagChainCheckFailed(new Error('down'))).toBe(false)
    expect(await flagChainCheckFailed('down')).toBe(false)
    expect(await onRecord()).toEqual([])
  })

  it('a broken chain is flagged again every night it stays broken; once restarted it is not', async () => {
    const f = await forked('tenant', await namedTenant('Still', 'Broken'))
    expect((await flagBrokenCreditChains()).sent).toBe(true)
    expect((await flagBrokenCreditChains()).sent).toBe(true)
    expect(adminNote).toHaveBeenCalledTimes(2)
    expect(adminNote.mock.calls[1][0].title).toBe('1 credit history chain broken')
    expect(await onRecord()).toHaveLength(2)
    await restartChain({ subjectId: f.subjectId, note: 'Restarted: the chain split in two (a fork).' })
    expect(await flagBrokenCreditChains()).toEqual({ subjects: 1, whole: 1, broken: 0, sent: false, errors: 0 })
    expect(adminNote).toHaveBeenCalledTimes(2)
  })

  it('a tenant record whose tenant row is gone still gets a line', async () => {
    const f = await forked('tenant', randomUUID())
    const r = await checkCreditChains()
    expect(r.broken).toEqual([expect.objectContaining({ subjectId: f.subjectId, subjectType: 'tenant', name: null })])
    expect(brokenChainsEmail(r.broken).body).toMatch(/^BROKEN — A tenant with no name on file: first bad entry Payment Received On Time, 10\/12\/2026/)
  })
})

describe('brokenChainsEmail', () => {
  const base: BrokenChain = {
    subjectId: 's1', subjectType: 'property', name: null, firstBadEventId: 'e1',
    firstBadEventType: null, firstBadOn: null, break: null, reason: 'first event has non-null prev_hash',
  }
  it('every break has words', () => {
    for (const b of CHAIN_BREAKS) expect(CHAIN_BREAK_LABEL[b]).toMatch(/^[a-z]/)
  })
  it('falls back to the record kind, "an entry" and the reason when nothing better is known', () => {
    expect(brokenChainsEmail([base])).toEqual({
      title: '1 credit history chain broken',
      body: 'BROKEN — A property record: first bad entry an entry (entry e1) — first event has non-null prev_hash. Credit record s1.',
    })
    expect(brokenChainsEmail([{ ...base, subjectType: null }]).body).toMatch(/^BROKEN — A credit record: first bad entry an entry \(entry e1\)/)
    expect(brokenChainsEmail([{ ...base, subjectType: 'landlord' }]).body).toMatch(/^BROKEN — A landlord record: /)
    expect(brokenChainsEmail([{ ...base, firstBadEventType: 'lease_signed', firstBadOn: '2026-01-05' }]).body)
      .toMatch(/first bad entry Lease Signed, 1\/5\/2026 \(entry e1\)/)
  })
})
