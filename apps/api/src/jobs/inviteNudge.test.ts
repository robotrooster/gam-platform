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
})
