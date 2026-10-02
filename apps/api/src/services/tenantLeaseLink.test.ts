/**
 * S647 — one email, one flow.
 *
 * Nic (DIRECTIVE): "After I sign it, they click the email, and acceptance and
 * signing all becomes one flow for the tenant." A resident who has never set up
 * their account must get a link that sets it up AND opens the lease — never a
 * bare signing link alongside a separate portal invite.
 *
 * S654 — and that password link goes only to the address on the account, and
 * never for an account another company holds.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedTenant } from '../test/dbHelpers'
import { tenantLeaseLink } from './tenantLeaseLink'
import { randomUUID, randomBytes } from 'crypto'

const PLACEHOLDER = '$2b$10$placeholder_invite_pending'

beforeEach(cleanupAllSchema)

async function userFor(tenantId: string) {
  return (await db.query(`SELECT u.* FROM users u JOIN tenants t ON t.user_id=u.id WHERE t.id=$1`,
    [tenantId])).rows[0]
}

/** A resident who never set up, and a landlord's document with them on it. */
async function seat(opts: { token?: string | null; signerEmail?: (accountEmail: string) => string } = {}) {
  const c = await db.connect()
  let tenantId: string, landlordId: string
  try {
    tenantId = await seedTenant(c)
    landlordId = (await seedLandlord(c)).landlordId
  } finally { c.release() }
  const u = await userFor(tenantId)
  await db.query(`UPDATE users SET password_hash=$2, tenant_invite_token=$3,
                    tenant_invite_expires_at = CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() + INTERVAL '2 days' END,
                    tenant_invite_accepted_at=NULL WHERE id=$1`,
    [u.id, PLACEHOLDER, opts.token ?? null])
  const doc = (await db.query(
    `INSERT INTO lease_documents (landlord_id, title, document_type, status)
     VALUES ($1, 'Lease', 'original_lease', 'in_progress') RETURNING id`, [landlordId])).rows[0].id
  const signerToken = randomBytes(32).toString('hex')
  await db.query(
    `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token)
     VALUES ($1, $2, 'primary', 'Test Tenant', $3, 2, $4)`,
    [doc, u.id, opts.signerEmail ? opts.signerEmail(u.email) : u.email, signerToken])
  return { tenantId: tenantId!, landlordId: landlordId!, userId: u.id as string, email: u.email as string, doc, signerToken }
}

describe('a tenant who never set up their account', () => {
  it('gets the setup link, carrying the lease as where it lands', async () => {
    const s = await seat()
    const link = await tenantLeaseLink({ userId: s.userId, documentId: s.doc, signerToken: 'sig123' })
    expect(link.needsSetup).toBe(true)
    expect(link.url).toContain('/accept-invite?token=')
    expect(link.url).toContain(`next=${encodeURIComponent(`/sign/${s.doc}`)}`)
    // Not the bare signing link — that is the second email this replaces.
    expect(link.url).not.toContain('/sign/sig123')

    const after = await userFor(s.tenantId)
    expect(after.tenant_invite_token).toBeTruthy()
    expect(new Date(after.tenant_invite_expires_at).getTime()).toBeGreaterThan(Date.now() + 6 * 864e5)
  })

  it('reuses the still-live token from the invite email they already have, so both links work', async () => {
    const s = await seat({ token: 'oldtoken' })   // live for two more days
    // Their invite came from this same company.
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status) VALUES ($1, $2, 'not_uploaded')`,
      [s.landlordId, s.tenantId])

    const link = await tenantLeaseLink({ userId: s.userId, documentId: s.doc })
    expect(link.url).toContain('token=oldtoken')
    // Drafted days ago, signed today: the link must not be dead on arrival.
    const after = await userFor(s.tenantId)
    expect(new Date(after.tenant_invite_expires_at).getTime()).toBeGreaterThan(Date.now() + 6 * 864e5)
  })

  it('the address on the account matches in any letter case', async () => {
    const s = await seat()
    const link = await tenantLeaseLink({ userId: s.userId, documentId: s.doc, sendTo: s.email.toUpperCase() })
    expect(link.needsSetup).toBe(true)
  })
})

// S654: landlord B put landlord A's invitee on B's lease with B's own address
// in the email box, and this function handed B the live token A had sent.
describe('S654 — the password link goes only to the account, and only for its own company', () => {
  it('mailed anywhere but the account\'s own address: the plain link, and the token is left alone', async () => {
    const s = await seat({ token: 'a-live-link' })
    const before = await userFor(s.tenantId)
    const link = await tenantLeaseLink({
      userId: s.userId, documentId: s.doc, signerToken: s.signerToken, sendTo: 'attacker@evil.test' })
    expect(link.needsSetup).toBe(false)
    expect(link.url).toMatch(new RegExp(`/sign/${s.signerToken}$`))
    expect(link.url).not.toContain('a-live-link')
    const after = await userFor(s.tenantId)
    expect(after.tenant_invite_token).toBe('a-live-link')
    expect(new Date(after.tenant_invite_expires_at).getTime()).toBe(new Date(before.tenant_invite_expires_at).getTime())
  })

  it('a caller that does not say where it sends is checked against the signer row it mails', async () => {
    const s = await seat({ token: 'a-live-link', signerEmail: () => 'attacker@evil.test' })
    const link = await tenantLeaseLink({ userId: s.userId, documentId: s.doc, signerToken: s.signerToken })
    expect(link.needsSetup).toBe(false)
    expect(link.url).not.toContain('a-live-link')
    expect((await userFor(s.tenantId)).tenant_invite_token).toBe('a-live-link')
  })

  /** The resident is landlord A's invitee; the document is landlord B's (seat's landlord). */
  async function alsoInvitedByAnotherCompany(tenantId: string) {
    const c = await db.connect()
    let landlordA: string
    try { landlordA = (await seedLandlord(c)).landlordId } finally { c.release() }
    await db.query(
      `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status) VALUES ($1, $2, 'not_uploaded')`,
      [landlordA!, tenantId])
  }

  it("another company's invitee: their live link rides along to their own address, untouched", async () => {
    const s = await seat({ token: 'a-live-link' })
    await alsoInvitedByAnotherCompany(s.tenantId)
    const before = await userFor(s.tenantId)

    const link = await tenantLeaseLink({ userId: s.userId, documentId: s.doc, signerToken: s.signerToken })
    expect(link.needsSetup).toBe(true)
    expect(link.url).toContain('/accept-invite?token=a-live-link&next=')
    // Not minted, not extended: the first company's email works exactly as sent.
    const after = await userFor(s.tenantId)
    expect(after.tenant_invite_token).toBe('a-live-link')
    expect(new Date(after.tenant_invite_expires_at).getTime()).toBe(new Date(before.tenant_invite_expires_at).getTime())
    expect(after.updated_at).toEqual(before.updated_at)
  })

  it('a caller that mails the account\'s own address says so, and a stale signer row does not matter', async () => {
    // B's document still lists the address B typed; B's re-send goes to X's own.
    const s = await seat({ token: 'a-live-link', signerEmail: () => 'attacker@evil.test' })
    await alsoInvitedByAnotherCompany(s.tenantId)
    const before = await userFor(s.tenantId)
    const link = await tenantLeaseLink({
      userId: s.userId, documentId: s.doc, signerToken: s.signerToken, sendTo: s.email })
    expect(link.needsSetup).toBe(true)
    expect(link.url).toContain('/accept-invite?token=a-live-link&next=')
    expect(await userFor(s.tenantId)).toEqual(before)
  })

  it("another company's invitee whose link has run out: nothing is minted, the plain link", async () => {
    const s = await seat({ token: 'a-dead-link' })
    await db.query(`UPDATE users SET tenant_invite_expires_at = NOW() - INTERVAL '1 day' WHERE id=$1`, [s.userId])
    await alsoInvitedByAnotherCompany(s.tenantId)
    const before = await userFor(s.tenantId)

    const link = await tenantLeaseLink({ userId: s.userId, documentId: s.doc, signerToken: s.signerToken })
    expect(link.needsSetup).toBe(false)
    expect(link.url).toMatch(new RegExp(`/sign/${s.signerToken}$`))
    const after = await userFor(s.tenantId)
    expect(after.tenant_invite_token).toBe('a-dead-link')
    expect(new Date(after.tenant_invite_expires_at).getTime()).toBe(new Date(before.tenant_invite_expires_at).getTime())
  })

  it("another company's invitee with no link at all: nothing is minted", async () => {
    const s = await seat({ token: null })
    await alsoInvitedByAnotherCompany(s.tenantId)
    const link = await tenantLeaseLink({ userId: s.userId, documentId: s.doc, signerToken: s.signerToken })
    expect(link.needsSetup).toBe(false)
    expect((await userFor(s.tenantId)).tenant_invite_token).toBeNull()
  })

  it('no seat on the document, no setup link', async () => {
    const s = await seat({ token: 'a-live-link' })
    const link = await tenantLeaseLink({ userId: s.userId, documentId: randomUUID() })
    expect(link.needsSetup).toBe(false)
    expect((await userFor(s.tenantId)).tenant_invite_token).toBe('a-live-link')
  })
})

// S654: a token was reused whatever its age and given seven more days. A link
// mailed to a mistyped address therefore came back to life the day the
// landlord signed, and whoever reads that mailbox could set the password.
describe('S654 — a link that has run out never comes back', () => {
  const ownInvite = (s: { landlordId: string; tenantId: string }) => db.query(
    `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status) VALUES ($1, $2, 'not_uploaded')`,
    [s.landlordId, s.tenantId])

  it('the exact sequence: invited at a mistyped address, corrected, the link runs out, the landlord signs', async () => {
    const TYPO = 'y.typo@exampel.test'
    const RIGHT = 'y.right@example.test'
    // 1. Landlord B invites Y at a mistyped address. That email carries 'typo-token'.
    const s = await seat({ token: 'typo-token' })
    await ownInvite(s)
    await db.query(`UPDATE users SET email=$2 WHERE id=$1`, [s.userId, TYPO])
    await db.query(`UPDATE lease_document_signers SET email=$2 WHERE document_id=$1`, [s.doc, TYPO])

    // 2. B corrects the address before signing. The account and the lease's
    //    signer row move; nothing clears the token the mistyped mailbox holds.
    await db.query(`UPDATE users SET email=$2 WHERE id=$1`, [s.userId, RIGHT])
    await db.query(`UPDATE lease_document_signers SET email=$2 WHERE document_id=$1`, [s.doc, RIGHT])
    expect((await userFor(s.tenantId)).tenant_invite_token).toBe('typo-token')

    // 3. Eight days later that link has run out, and B signs. The relay mails
    //    Y at the address on the account.
    await db.query(`UPDATE users SET tenant_invite_expires_at = NOW() - INTERVAL '1 day' WHERE id=$1`, [s.userId])
    const link = await tenantLeaseLink({
      userId: s.userId, documentId: s.doc, signerToken: s.signerToken, sendTo: RIGHT })

    expect(link.needsSetup).toBe(true)
    expect(link.url).not.toContain('typo-token')
    const after = await userFor(s.tenantId)
    expect(after.tenant_invite_token).toMatch(/^[0-9a-f]{64}$/)
    expect(link.url).toContain(`/accept-invite?token=${after.tenant_invite_token}&next=`)
    expect(new Date(after.tenant_invite_expires_at).getTime()).toBeGreaterThan(Date.now() + 6 * 864e5)
    // Nothing still answers to the link the mistyped mailbox holds.
    expect((await db.query(`SELECT id FROM users WHERE tenant_invite_token = 'typo-token'`)).rows).toEqual([])
  })

  it('a token with no expiry on it is not reused either', async () => {
    const s = await seat({ token: 'no-clock' })
    await ownInvite(s)
    await db.query(`UPDATE users SET tenant_invite_expires_at = NULL WHERE id=$1`, [s.userId])
    const link = await tenantLeaseLink({ userId: s.userId, documentId: s.doc, signerToken: s.signerToken })
    expect(link.needsSetup).toBe(true)
    expect(link.url).not.toContain('no-clock')
    expect((await userFor(s.tenantId)).tenant_invite_token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('two sends at once on a run-out link agree on one fresh link', async () => {
    const s = await seat({ token: 'old-dead' })
    await ownInvite(s)
    await db.query(`UPDATE users SET tenant_invite_expires_at = NOW() - INTERVAL '1 day' WHERE id=$1`, [s.userId])
    const call = () => tenantLeaseLink({ userId: s.userId, documentId: s.doc, signerToken: s.signerToken })
    const [a, b] = await Promise.all([call(), call()])
    expect(a.url).not.toContain('old-dead')
    // Whichever email lands second must not have killed the first one's link.
    expect(a.url).toBe(b.url)
    expect(a.url).toContain(`token=${(await userFor(s.tenantId)).tenant_invite_token}&`)
  })
})

describe('a tenant who already has a login', () => {
  it('gets the ordinary signing link', async () => {
    const c = await db.connect()
    let tenantId: string
    try { tenantId = await seedTenant(c) } finally { c.release() }
    const u = await userFor(tenantId!)
    await db.query(`UPDATE users SET password_hash='$2b$10$realhashrealhashrealhash',
                    tenant_invite_accepted_at=NOW() WHERE id=$1`, [u.id])

    const link = await tenantLeaseLink({ userId: u.id, documentId: randomUUID(), signerToken: 'sig456' })
    expect(link.needsSetup).toBe(false)
    expect(link.url).toMatch(/\/sign\/sig456$/)
  })
})
