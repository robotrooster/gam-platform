/**
 * S647 — one email, one flow.
 *
 * Nic (DIRECTIVE): "After I sign it, they click the email, and acceptance and
 * signing all becomes one flow for the tenant." A resident who has never set up
 * their account must get a link that sets it up AND opens the lease — never a
 * bare signing link alongside a separate portal invite.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedTenant } from '../test/dbHelpers'
import { tenantLeaseLink } from './tenantLeaseLink'
import { randomUUID } from 'crypto'

const PLACEHOLDER = '$2b$10$placeholder_invite_pending'

beforeEach(cleanupAllSchema)

async function userFor(tenantId: string) {
  return (await db.query(`SELECT u.* FROM users u JOIN tenants t ON t.user_id=u.id WHERE t.id=$1`,
    [tenantId])).rows[0]
}

describe('a tenant who never set up their account', () => {
  it('gets the setup link, carrying the lease as where it lands', async () => {
    const c = await db.connect()
    let tenantId: string
    try { tenantId = await seedTenant(c) } finally { c.release() }
    const u = await userFor(tenantId!)
    await db.query(`UPDATE users SET password_hash=$2, tenant_invite_token=NULL,
                    tenant_invite_accepted_at=NULL WHERE id=$1`, [u.id, PLACEHOLDER])
    const docId = randomUUID()

    const link = await tenantLeaseLink({ userId: u.id, documentId: docId, signerToken: 'sig123' })
    expect(link.needsSetup).toBe(true)
    expect(link.url).toContain('/accept-invite?token=')
    expect(link.url).toContain(`next=${encodeURIComponent(`/sign/${docId}`)}`)
    // Not the bare signing link — that is the second email this replaces.
    expect(link.url).not.toContain('/sign/sig123')

    const after = await userFor(tenantId!)
    expect(after.tenant_invite_token).toBeTruthy()
    expect(new Date(after.tenant_invite_expires_at).getTime()).toBeGreaterThan(Date.now() + 6 * 864e5)
  })

  it('reuses the token from the invite email they already have, so both links work', async () => {
    const c = await db.connect()
    let tenantId: string
    try { tenantId = await seedTenant(c) } finally { c.release() }
    const u = await userFor(tenantId!)
    await db.query(`UPDATE users SET password_hash=$2, tenant_invite_token='oldtoken',
                    tenant_invite_expires_at=NOW() - INTERVAL '3 days',
                    tenant_invite_accepted_at=NULL WHERE id=$1`, [u.id, PLACEHOLDER])

    const link = await tenantLeaseLink({ userId: u.id, documentId: randomUUID() })
    expect(link.url).toContain('token=oldtoken')
    // Drafted days ago, signed today: the link must not be dead on arrival.
    const after = await userFor(tenantId!)
    expect(new Date(after.tenant_invite_expires_at).getTime()).toBeGreaterThan(Date.now())
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
