/**
 * S652 — work traders take maintenance jobs from their tenant portal.
 * Open work is visible to every work trader at the property, skilled work only
 * to those with the skill; a monitored person's skilled job waits for a check
 * by the landlord or a trusted work trader; a neighbour's contact details never
 * reach a work trader.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { workTradeRouter } from './workTrade'
import { maintenanceRouter } from './maintenance'
import { errorHandler } from '../middleware/errorHandler'

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/work-trade', workTradeRouter)
  a.use('/api/maintenance', maintenanceRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_wtjobs'
})

const sign = (p: object) => jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '1h' })

async function world() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const prop = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
    const mk = async () => {
      const unit = await seedUnit(c, { propertyId: prop, landlordId: ll.landlordId })
      const tenant = await seedTenant(c)
      const lease = await seedLease(c, { unitId: unit, landlordId: ll.landlordId, status: 'active' } as any)
      await seedLeaseTenant(c, { leaseId: lease, tenantId: tenant })
      const uid = (await c.query(`SELECT user_id FROM tenants WHERE id=$1`, [tenant])).rows[0].user_id
      return { unit, tenant, uid }
    }
    const trader = await mk(), trusted = await mk(), neighbour = await mk()
    await c.query(`UPDATE users SET first_name='Nora', last_name='Neighbour', phone='5551234567' WHERE id=$1`, [neighbour.uid]).catch(() => {})
    for (const [t, isTrusted] of [[trader, false], [trusted, true]] as const) {
      await c.query(`INSERT INTO work_trade_agreements (unit_id, tenant_id, landlord_id, start_date, status, trusted)
                     VALUES ($1,$2,$3,'2026-01-01','active',$4)`, [t.unit, t.tenant, ll.landlordId, isTrusted])
    }
    const job = async (title: string, category: string) => (await c.query(
      `INSERT INTO maintenance_requests (unit_id, tenant_id, landlord_id, title, description, priority, status, category)
       VALUES ($1,$2,$3,$4,'details','normal','open',$5) RETURNING id`,
      [neighbour.unit, neighbour.tenant, ll.landlordId, title, category])).rows[0].id
    const weeds = await job('Pull weeds by lot 4', 'landscape')
    const leak = await job('Water leak under sink', 'plumbing')
    await c.query('COMMIT')
    return {
      ll, prop, trader, trusted, neighbour, weeds, leak,
      landlordToken: sign({ userId: ll.userId, role: 'landlord', email: 'l@t.dev', profileId: null, landlordIds: [ll.landlordId], permissions: {} }),
      traderToken: sign({ userId: trader.uid, role: 'tenant', email: 't@t.dev', profileId: trader.tenant, permissions: {} }),
      trustedToken: sign({ userId: trusted.uid, role: 'tenant', email: 'tr@t.dev', profileId: trusted.tenant, permissions: {} }),
      neighbourToken: sign({ userId: neighbour.uid, role: 'tenant', email: 'n@t.dev', profileId: neighbour.tenant, permissions: {} }),
    }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const jobs = async (token: string) =>
  (await request(app()).get('/api/work-trade/jobs').set('Authorization', `Bearer ${token}`).expect(200)).body.data

describe('what a work trader sees', () => {
  it('open work to everyone, skilled work only with the skill — and never the neighbour\'s details', async () => {
    const w = await world()
    let d = await jobs(w.traderToken)
    expect(d.available.map((j: any) => j.title)).toEqual(['Pull weeds by lot 4'])
    const body = JSON.stringify(d)
    expect(body).not.toContain('Neighbour')
    expect(body).not.toContain('5551234567')

    await db.query(`UPDATE work_trade_agreements SET skills='{plumbing}' WHERE tenant_id=$1`, [w.trader.tenant])
    d = await jobs(w.traderToken)
    expect(d.available.map((j: any) => j.title).sort()).toEqual(['Pull weeds by lot 4', 'Water leak under sink'])
  })

  it('a tenant with no work trade agreement sees nothing and can take nothing', async () => {
    const w = await world()
    expect(await jobs(w.neighbourToken)).toEqual({ available: [], mine: [], toCheck: [] })
    const r = await request(app()).post(`/api/work-trade/jobs/${w.weeds}/take`).set('Authorization', `Bearer ${w.neighbourToken}`)
    expect(r.status).toBe(403)
  })

  it('a job set to "none" is hidden; "anyone" opens skilled work to all', async () => {
    const w = await world()
    await db.query(`UPDATE maintenance_requests SET work_trade_access='none' WHERE id=$1`, [w.weeds])
    await db.query(`UPDATE maintenance_requests SET work_trade_access='anyone' WHERE id=$1`, [w.leak])
    const d = await jobs(w.traderToken)
    expect(d.available.map((j: any) => j.title)).toEqual(['Water leak under sink'])
  })
})

describe('taking and finishing', () => {
  it('open work is done when marked done; the hours go in as Logged for a monitored person', async () => {
    const w = await world()
    await request(app()).post(`/api/work-trade/jobs/${w.weeds}/take`).set('Authorization', `Bearer ${w.traderToken}`).expect(200)
    // Taken: it leaves everyone else's list.
    expect((await jobs(w.trustedToken)).available.map((j: any) => j.title)).not.toContain('Pull weeds by lot 4')
    const r = await request(app()).post(`/api/work-trade/jobs/${w.weeds}/done`).set('Authorization', `Bearer ${w.traderToken}`)
      .send({ hours: 2, note: 'bagged it all' }).expect(200)
    expect(r.body.data.needsCheck).toBe(false)
    expect(r.body.data.log.status).toBe('pending')
    const row = (await db.query(`SELECT status, needs_check FROM maintenance_requests WHERE id=$1`, [w.weeds])).rows[0]
    expect(row).toEqual({ status: 'completed', needs_check: false })
  })

  it('someone else cannot take a job already taken', async () => {
    const w = await world()
    await request(app()).post(`/api/work-trade/jobs/${w.weeds}/take`).set('Authorization', `Bearer ${w.traderToken}`).expect(200)
    const r = await request(app()).post(`/api/work-trade/jobs/${w.weeds}/take`).set('Authorization', `Bearer ${w.trustedToken}`)
    expect(r.status).toBe(403)
  })

  it('skilled work by a monitored person waits for a check — a trusted work trader or the landlord confirms it, not the doer', async () => {
    const w = await world()
    await db.query(`UPDATE work_trade_agreements SET skills='{plumbing}' WHERE tenant_id=$1`, [w.trader.tenant])
    await request(app()).post(`/api/work-trade/jobs/${w.leak}/take`).set('Authorization', `Bearer ${w.traderToken}`).expect(200)
    const done = await request(app()).post(`/api/work-trade/jobs/${w.leak}/done`).set('Authorization', `Bearer ${w.traderToken}`).send({}).expect(200)
    expect(done.body.data.needsCheck).toBe(true)

    expect((await jobs(w.trustedToken)).toCheck.map((j: any) => j.title)).toEqual(['Water leak under sink'])
    const self = await request(app()).post(`/api/work-trade/jobs/${w.leak}/check`).set('Authorization', `Bearer ${w.traderToken}`)
    expect(self.status).toBe(403)
    await request(app()).post(`/api/work-trade/jobs/${w.leak}/check`).set('Authorization', `Bearer ${w.trustedToken}`).expect(200)
    const row = (await db.query(`SELECT needs_check, checked_by FROM maintenance_requests WHERE id=$1`, [w.leak])).rows[0]
    expect(row.needs_check).toBe(false)
    expect(row.checked_by).toBe(w.trusted.uid)
  })

  it('an ended agreement takes the jobs away', async () => {
    const w = await world()
    await db.query(`UPDATE work_trade_agreements SET status='ended' WHERE tenant_id=$1`, [w.trader.tenant])
    expect((await jobs(w.traderToken)).available).toEqual([])
  })
})

describe('the landlord assigning', () => {
  it('can assign to a live work trader there, cannot assign to a stranger, and can unassign', async () => {
    const w = await world()
    const ok = await request(app()).patch(`/api/maintenance/${w.leak}`).set('Authorization', `Bearer ${w.landlordToken}`)
      .send({ assignedTo: w.trader.uid })
    expect(ok.status).toBe(200)
    expect((await jobs(w.traderToken)).mine.map((j: any) => j.title)).toEqual(['Water leak under sink'])

    const stranger = await request(app()).patch(`/api/maintenance/${w.leak}`).set('Authorization', `Bearer ${w.landlordToken}`)
      .send({ assignedTo: w.neighbour.uid })
    expect(stranger.status).toBe(400)

    await request(app()).patch(`/api/maintenance/${w.leak}`).set('Authorization', `Bearer ${w.landlordToken}`)
      .send({ assignedTo: null }).expect(200)
    const row = (await db.query(`SELECT assigned_to FROM maintenance_requests WHERE id=$1`, [w.leak])).rows[0]
    expect(row.assigned_to).toBeNull()
  })
})

describe('when the agreement stops', () => {
  it('ending it hands their taken jobs back to the board', async () => {
    const w = await world()
    await request(app()).post(`/api/work-trade/jobs/${w.weeds}/take`).set('Authorization', `Bearer ${w.traderToken}`).expect(200)
    const ag = (await db.query(`SELECT id FROM work_trade_agreements WHERE tenant_id=$1`, [w.trader.tenant])).rows[0].id
    await request(app()).patch(`/api/work-trade/${ag}`).set('Authorization', `Bearer ${w.landlordToken}`).send({ status: 'ended' }).expect(200)
    const row = (await db.query(`SELECT assigned_to, status FROM maintenance_requests WHERE id=$1`, [w.weeds])).rows[0]
    expect(row).toEqual({ assigned_to: null, status: 'open' })
  })
})
