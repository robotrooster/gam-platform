/**
 * 10/14 (Nic): "Only the landlord can fix a birthday." A tenant's birthday
 * (copied off their signed lease; the happy-birthday email reads it) is read
 * and corrected by the landlord — the owner of a company the person has had a
 * lease with — on GET/PATCH /api/tenants/:id/birthday. The tenant cannot
 * change it, a team member never sees it, and another company's owner is
 * refused.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { tenantsRouter } from './tenants'
import { errorHandler } from '../middleware/errorHandler'
import { tenantBirthdayFrom } from '../services/tenantBirthday'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/tenants', tenantsRouter)
  a.use(errorHandler)
  return a
}
const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

beforeEach(async () => { await cleanupAllSchema() })

async function world() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const unitId = await seedUnit(c, { propertyId, landlordId: ll.landlordId })
    const leaseId = await seedLease(c, { unitId, landlordId: ll.landlordId, status: 'active' })
    const tenantId = await seedTenant(c)
    await seedLeaseTenant(c, { leaseId, tenantId })
    await c.query(`UPDATE tenants SET date_of_birth = '1985-10-14' WHERE id = $1`, [tenantId])
    const other = await seedLandlord(c)
    const tenantUser = (await c.query<{ user_id: string }>(`SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id
    await c.query('COMMIT')
    return {
      tenantId,
      owner: sign({ userId: ll.userId, role: 'landlord', email: 'o@t.dev', profileId: null, landlordIds: [ll.landlordId], permissions: {} }),
      otherOwner: sign({ userId: other.userId, role: 'landlord', email: 'x@t.dev', profileId: null, landlordIds: [other.landlordId], permissions: {} }),
      manager: sign({ userId: ll.userId, role: 'property_manager', email: 'm@t.dev', profileId: null, landlordId: ll.landlordId,
        permissions: { 'tenants.view': true, 'tenants.edit': true } }),
      tenant: sign({ userId: tenantUser, role: 'tenant', email: 't@t.dev', profileId: tenantId, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const stored = async (tenantId: string) =>
  (await db.query<{ d: string | null }>(`SELECT to_char(date_of_birth, 'YYYY-MM-DD') AS d FROM tenants WHERE id = $1`, [tenantId])).rows[0].d

describe('a tenant\'s birthday is the landlord\'s to fix (10/14, Nic)', () => {
  it('the landlord reads it and fixes it; the date saved is the date typed', async () => {
    const w = await world()
    const got = await request(app()).get(`/api/tenants/${w.tenantId}/birthday`).set('Authorization', `Bearer ${w.owner}`)
    expect([got.status, got.body.data]).toEqual([200, { dateOfBirth: '1985-10-14' }])
    const fixed = await request(app()).patch(`/api/tenants/${w.tenantId}/birthday`).set('Authorization', `Bearer ${w.owner}`)
      .send({ dateOfBirth: '1985-01-14' })
    expect([fixed.status, fixed.body.data]).toEqual([200, { dateOfBirth: '1985-01-14' }])
    expect(await stored(w.tenantId)).toBe('1985-01-14')
  })

  it('the tenant cannot change it; a team member and another company\'s owner are refused; nothing changes', async () => {
    const w = await world()
    for (const token of [w.tenant, w.manager, w.otherOwner]) {
      const r = await request(app()).patch(`/api/tenants/${w.tenantId}/birthday`).set('Authorization', `Bearer ${token}`)
        .send({ dateOfBirth: '1990-01-01' })
      expect(r.status).toBe(403)
      expect((await request(app()).get(`/api/tenants/${w.tenantId}/birthday`).set('Authorization', `Bearer ${token}`)).status).toBe(403)
    }
    const r = await request(app()).patch(`/api/tenants/${w.tenantId}/birthday`).set('Authorization', `Bearer ${w.tenant}`)
      .send({ dateOfBirth: '1990-01-01' })
    expect(r.body.error).toBe('Your landlord keeps your birthday on file. Ask them to fix it.')
    expect(await stored(w.tenantId)).toBe('1985-10-14')
  })

  it('not a date, before 1900, or not in the past: refused in words', async () => {
    const now = new Date('2026-10-14T16:15:00Z')
    expect(() => tenantBirthdayFrom('1985-02-30', now)).toThrow('Enter the birthday as a date, like 1980-04-23.')
    expect(() => tenantBirthdayFrom('10/14/1985', now)).toThrow('Enter the birthday as a date, like 1980-04-23.')
    expect(() => tenantBirthdayFrom('1899-12-31', now)).toThrow('That birthday is before 1900 — check the year.')
    expect(() => tenantBirthdayFrom('2026-10-14', now)).toThrow('That birthday is not a date in the past.')
    expect(tenantBirthdayFrom('2026-10-13', now)).toBe('2026-10-13')
    expect(tenantBirthdayFrom(null, now)).toBeNull()
  })
})
