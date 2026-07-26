/**
 * S554 Connect re-anchor, Stage 2 — the two invariants the money path relies on:
 *   1. LIVE landlord_members membership check (dissolution-proofing).
 *   2. COALESCE(entity, founding-user) account resolution — the entity account
 *      WINS when set, else falls back to the founding owner's user account.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { isLiveLandlordMember, assertLiveLandlordMember } from './landlordMembership'

beforeEach(async () => {
  await cleanupAllSchema()
})

async function seedLandlordWithMember(): Promise<{ userId: string; landlordId: string }> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    await c.query(
      `INSERT INTO landlord_members (landlord_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [landlordId, userId])
    await c.query('COMMIT')
    return { userId, landlordId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('landlordMembership — live member check', () => {
  it('true for a current member, false for a non-member', async () => {
    const { userId, landlordId } = await seedLandlordWithMember()
    expect(await isLiveLandlordMember(userId, landlordId)).toBe(true)
    // A different user is not a member.
    const other = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, email_verified)
       VALUES ($1,'x','landlord','No','Member',TRUE) RETURNING id`,
      [`nonmember-${Date.now()}@test.dev`])
    expect(await isLiveLandlordMember(other.rows[0].id, landlordId)).toBe(false)
  })

  it('assert throws 403 for a removed owner (stale-JWT scenario)', async () => {
    const { userId, landlordId } = await seedLandlordWithMember()
    // Remove the membership (simulates a co-owner being removed).
    await db.query(`DELETE FROM landlord_members WHERE landlord_id=$1 AND user_id=$2`, [landlordId, userId])
    await expect(assertLiveLandlordMember(userId, landlordId)).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('Connect re-anchor — COALESCE(entity, user) account resolution', () => {
  const RESOLVER = `SELECT COALESCE(l.stripe_connect_account_id, u.stripe_connect_account_id) AS acct
                      FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`

  it('entity account WINS when set', async () => {
    const { userId, landlordId } = await seedLandlordWithMember()
    await db.query(`UPDATE users SET stripe_connect_account_id='acct_user' WHERE id=$1`, [userId])
    await db.query(`UPDATE landlords SET stripe_connect_account_id='acct_entity' WHERE id=$1`, [landlordId])
    const { rows } = await db.query<{ acct: string }>(RESOLVER, [landlordId])
    expect(rows[0].acct).toBe('acct_entity')
  })

  it('falls back to the founding user account when the entity has none', async () => {
    const { userId, landlordId } = await seedLandlordWithMember()
    await db.query(`UPDATE users SET stripe_connect_account_id='acct_user' WHERE id=$1`, [userId])
    // landlords.stripe_connect_account_id stays NULL
    const { rows } = await db.query<{ acct: string }>(RESOLVER, [landlordId])
    expect(rows[0].acct).toBe('acct_user')
  })
})
