/** S582: tenant invite nudge — eligibility + self-spacing. Email is mocked. */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'

vi.mock('../services/email', () => ({
  emailTenantInviteReminder: vi.fn(async () => {}),
}))

import { nudgeExpiringInvites } from './inviteNudge'
import { emailTenantInviteReminder } from '../services/email'

beforeEach(async () => {
  await cleanupAllSchema()
  ;(emailTenantInviteReminder as any).mockClear()
})

async function seedInvite(opts: { expiresInDays: number; accepted?: boolean; nudgedDaysAgo?: number | null }) {
  const client = await db.connect()
  let landlordId = '', tenantId = '', unitId = ''
  try {
    await client.query('BEGIN')
    const ll = await seedLandlord(client); landlordId = ll.landlordId
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    unitId = await seedUnit(client, { propertyId, landlordId })
    tenantId = await seedTenant(client)
    await client.query('COMMIT')
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }

  const uid = (await db.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id=$1`, [tenantId])).rows[0].user_id
  await db.query(
    `UPDATE users SET tenant_invite_token = 'tok-' || $1, tenant_invite_expires_at = NOW() + ($2 * INTERVAL '1 day') WHERE id = $3`,
    [tenantId, opts.expiresInDays, uid])
  await db.query(
    `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id, accepted_at, invite_last_nudged_at)
     VALUES ($1, $2, 'not_uploaded', $3, ${opts.accepted ? 'NOW()' : 'NULL'},
             ${opts.nudgedDaysAgo != null ? `NOW() - ($4 * INTERVAL '1 day')` : 'NULL'})`,
    opts.nudgedDaysAgo != null ? [landlordId, tenantId, unitId, opts.nudgedDaysAgo] : [landlordId, tenantId, unitId])
  return { landlordId, tenantId, unitId }
}

describe('nudgeExpiringInvites', () => {
  it('eligible invite (expiring soon, unaccepted, never nudged) → nudged + stamped', async () => {
    const s = await seedInvite({ expiresInDays: 2 })
    const res = await nudgeExpiringInvites()
    expect(res.nudged).toBe(1)
    expect(emailTenantInviteReminder).toHaveBeenCalledTimes(1)
    const stamp = await db.query<{ n: string | null }>(
      `SELECT invite_last_nudged_at AS n FROM pending_tenant_intents WHERE unit_id=$1`, [s.unitId])
    expect(stamp.rows[0].n).not.toBeNull()
  })

  it('already accepted → not nudged', async () => {
    await seedInvite({ expiresInDays: 2, accepted: true })
    expect((await nudgeExpiringInvites()).nudged).toBe(0)
    expect(emailTenantInviteReminder).not.toHaveBeenCalled()
  })

  it('already expired → not nudged', async () => {
    await seedInvite({ expiresInDays: -1 })
    expect((await nudgeExpiringInvites()).nudged).toBe(0)
  })

  it('expiring far out (outside the 4-day window) → not nudged yet', async () => {
    await seedInvite({ expiresInDays: 6 })
    expect((await nudgeExpiringInvites()).nudged).toBe(0)
  })

  it('nudged 1 day ago (inside the 2-day gap) → not re-nudged', async () => {
    await seedInvite({ expiresInDays: 2, nudgedDaysAgo: 1 })
    expect((await nudgeExpiringInvites()).nudged).toBe(0)
  })

  it('nudged 3 days ago (past the gap) → nudged again', async () => {
    await seedInvite({ expiresInDays: 2, nudgedDaysAgo: 3 })
    expect((await nudgeExpiringInvites()).nudged).toBe(1)
  })

  // S655: since S647 the lease drafts at invite and waits for the LANDLORD's
  // signature; the tenant hears nothing until he signs, and from then on the
  // e-sign reminders carry the signing link. "Your invite is expiring" about a
  // lease nobody has signed yet went out 38 times since 9/1.
  async function withDraft(intentUnitId: string, landlordId: string, status: string) {
    const d = (await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
       VALUES ($1, $2, 'Lease', 'original_lease', $3) RETURNING id`, [landlordId, intentUnitId, status])).rows[0]
    await db.query(`UPDATE pending_tenant_intents SET draft_document_id = $1 WHERE unit_id = $2`, [d.id, intentUnitId])
  }

  it('an invite whose lease is drafted and waiting on the landlord is never nudged', async () => {
    const s = await seedInvite({ expiresInDays: 2 })
    await withDraft(s.unitId, s.landlordId, 'pending')
    expect((await nudgeExpiringInvites()).nudged).toBe(0)
    expect(emailTenantInviteReminder).not.toHaveBeenCalled()
  })

  it('nor once the landlord has signed — the e-sign reminders own that lease', async () => {
    const s = await seedInvite({ expiresInDays: 2 })
    await withDraft(s.unitId, s.landlordId, 'in_progress')
    expect((await nudgeExpiringInvites()).nudged).toBe(0)
  })

  it('a voided draft no longer counts: the plain invite is nudged again', async () => {
    const s = await seedInvite({ expiresInDays: 2 })
    await withDraft(s.unitId, s.landlordId, 'voided')
    expect((await nudgeExpiringInvites()).nudged).toBe(1)
  })

  // The old job read TENANT_APP_URL once, at import, with a localhost
  // fallback; in production with the variable missing every reminder linked to
  // localhost. Both cases are pinned here, with the environment set per test.
  async function linkWith(env: { NODE_ENV?: string; TENANT_APP_URL?: string }): Promise<string> {
    const saved = { NODE_ENV: process.env.NODE_ENV, TENANT_APP_URL: process.env.TENANT_APP_URL }
    try {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v
      }
      await seedInvite({ expiresInDays: 2 })
      await nudgeExpiringInvites()
      return (emailTenantInviteReminder as any).mock.calls[0][4] as string
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v
      }
    }
  }

  it('the reminder link goes to the tenant portal the server is configured with', async () => {
    const url = await linkWith({ TENANT_APP_URL: 'https://tenant.portal.example/' })
    expect(url).toMatch(/^https:\/\/tenant\.portal\.example\/accept-invite\?token=tok-/)
  })

  it('in production with the variable missing, the link is the real tenant portal, never localhost', async () => {
    const url = await linkWith({ NODE_ENV: 'production', TENANT_APP_URL: undefined })
    expect(url).not.toMatch(/localhost/)
    expect(url).toMatch(/^https:\/\/tenant\.goldassetmanagement\.com\/accept-invite\?token=tok-/)
  })
})

