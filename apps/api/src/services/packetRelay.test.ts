/**
 * S654 — the packet relay mails a signer only at the address on their account.
 *
 * A signing token is a full stand-in for that signer (S629). advancePacket
 * mailed the signer ROW's address, and rows can hold an address the account
 * has since moved off: the landlord's email correction moved only the lease's
 * row, and older documents carry whatever the sender typed. Whoever read that
 * mailbox got a link that signs the whole packet as the resident. The landlord
 * is the one exception: their row may hold the property's on-site signing
 * address (services/landlordSigningContact), so it keeps its own.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { emailSigningRequestMock, emailSigningCompletedMock } = vi.hoisted(() => ({
  emailSigningRequestMock: vi.fn(async (..._a: any[]) => undefined),
  emailSigningCompletedMock: vi.fn(async (..._a: any[]) => undefined),
}))
vi.mock('./email', async (orig) => ({
  ...(await orig() as any),
  emailSigningRequest: emailSigningRequestMock,
  emailSigningCompleted: emailSigningCompletedMock,
}))

import { randomUUID } from 'crypto'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { advancePacket, announcePacketIfComplete } from './packetRelay'

const PLACEHOLDER = '$2b$10$placeholder_invite_pending'
const TYPO = 'y.typo@exampel.test'
const RIGHT = 'y.right@example.test'
const ONSITE = 'office@park.test'

beforeEach(async () => {
  await cleanupAllSchema()
  emailSigningRequestMock.mockClear()
  emailSigningCompletedMock.mockClear()
  process.env.TENANT_APP_URL = 'https://tenants.example.test'
})

/**
 * Landlord B's two-document packet. The landlord has signed both; Y — B's own
 * invitee, never set up — is next, with both signer rows still at the
 * mistyped address while the account holds the corrected one.
 */
async function packet(opts: { done?: boolean } = {}) {
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
  const yUser = (await db.query<{ id: string }>(
    `UPDATE users SET email=$2, password_hash=$3, tenant_invite_token=NULL, tenant_invite_expires_at=NULL,
                      tenant_invite_accepted_at=NULL
      WHERE id = (SELECT user_id FROM tenants WHERE id=$1) RETURNING id`,
    [tenantId!, RIGHT, PLACEHOLDER])).rows[0].id
  await db.query(
    `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id)
     VALUES ($1, $2, 'not_uploaded', $3)`, [landlordId!, tenantId!, unitId!])

  const group = randomUUID()
  const docs: string[] = []
  const yTokens: string[] = []
  for (const [i, title] of ['Lease', 'Pet addendum'].entries()) {
    const id = randomUUID()
    docs.push(id)
    await db.query(
      `INSERT INTO lease_documents (id, landlord_id, unit_id, title, document_type, status, package_group_id, package_sort_order)
       VALUES ($1,$2,$3,$4,'original_lease',$5,$6,$7)`,
      [id, landlordId!, unitId!, title, opts.done ? 'completed' : 'in_progress', group, i])
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status, signed_at)
       VALUES ($1,$2,'landlord','LL',$3,1,$4,'signed',NOW())`, [id, llUser!, ONSITE, randomUUID()])
    const tok = randomUUID()
    yTokens.push(tok)
    await db.query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status, signed_at)
       VALUES ($1,$2,'primary','Y',$3,2,$4,$5,${opts.done ? 'NOW()' : 'NULL'})`,
      [id, yUser, TYPO, tok, opts.done ? 'signed' : 'pending'])
  }
  return { group, docs, yUser, yTokens, llUser: llUser! }
}

describe('S654: advancePacket mails the next signer at the address on their account', () => {
  it('a resident whose signer rows hold an old address is mailed at the account, never the old one', async () => {
    const p = await packet()

    const out = await advancePacket(p.group)

    expect(emailSigningRequestMock).toHaveBeenCalledTimes(1)
    const call = emailSigningRequestMock.mock.calls[0]!
    expect(call[0]).toBe(RIGHT)
    expect(out.invited).toBe(RIGHT)
    for (const t of p.yTokens) expect(JSON.stringify(call)).not.toContain(t)
    // Mailed to the account itself, so this company's own never-set-up invitee
    // gets the one link that sets the account up and opens the lease (S647).
    expect(call[5]).toMatch(/\/accept-invite\?token=[0-9a-f]{64}&next=/)
    expect(call[6].needsSetup).toBe(true)
  })

  it('a landlord signer keeps the address on their row (the property\'s on-site signer)', async () => {
    const p = await packet()
    // Put the landlord back in line: unsign both landlord rows.
    await db.query(
      `UPDATE lease_document_signers SET status='pending', signed_at=NULL
        WHERE document_id = ANY($1::uuid[]) AND role='landlord'`, [p.docs])

    const out = await advancePacket(p.group)

    expect(emailSigningRequestMock).toHaveBeenCalledTimes(1)
    expect(emailSigningRequestMock.mock.calls[0]![0]).toBe(ONSITE)
    expect(out.invited).toBe(ONSITE)
  })
})

describe('S654: the packet completion note goes to the account too', () => {
  it('the resident is told at the account address; the landlord at their row address', async () => {
    const p = await packet({ done: true })

    const sent = await announcePacketIfComplete(p.group, () => 'https://portal.example.test')

    expect(sent).toBe(true)
    const to = emailSigningCompletedMock.mock.calls.map(c => c[0]).sort()
    expect(to).toEqual([ONSITE, RIGHT].sort())
    expect(to).not.toContain(TYPO)
  })
})
