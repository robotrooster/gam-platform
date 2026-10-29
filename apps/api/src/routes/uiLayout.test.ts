/**
 * 10/21 (Nic) — WHERE SOMEBODY PUT THEIR OWN THINGS.
 *
 *   "Did you ever build my idea for people being able to drag the left
 *    navigation bar into an order of their choosing... I feel like there's a
 *    lot of stuff that I brought up that got skipped, and unless I remember it
 *    again, it just doesn't get built."
 *
 * The thing worth guarding is what this is NOT. A saved order is a preference
 * about things a person can already open — never a way to reach one they
 * cannot. The screen proves that half (applyOrder reorders the list
 * visibleNavItemsFor already produced, so a key for a page they do not have
 * matches nothing). This end proves the rest: one person's arrangement is
 * theirs, it cannot be read or written by anybody else, and nothing but a
 * tidy list of known-length strings is ever stored.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord } from '../test/dbHelpers'
import { errorHandler } from '../middleware/errorHandler'
import { uiLayoutRouter } from './uiLayout'

const SECRET = 'test-secret-ui-layout'
const app = () => {
  const a = express()
  a.use(express.json())
  a.use('/api/ui-layout', uiLayoutRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => { await cleanupAllSchema(); process.env.JWT_SECRET = SECRET })

async function person() {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    await c.query('COMMIT')
    return { userId, landlordId,
      token: jwt.sign({ userId, role: 'landlord', email: `u-${userId.slice(0, 6)}@t.dev`, landlordIds: [landlordId], permissions: {} },
        SECRET, { expiresIn: '1h' }) }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}
type P = Awaited<ReturnType<typeof person>>
const get = (p: P, s = 'landlord_nav') => request(app()).get(`/api/ui-layout/${s}`).set('Authorization', `Bearer ${p.token}`)
const put = (p: P, layout: any, s = 'landlord_nav') =>
  request(app()).put(`/api/ui-layout/${s}`).set('Authorization', `Bearer ${p.token}`).send({ layout })

describe('a screen arranged the way one person works', () => {
  it('starts with nothing saved, which means the screen draws the way it always did', async () => {
    const p = await person()
    const res = await get(p)
    expect(res.status).toBe(200)
    expect(res.body.data.layout).toEqual([])
  })

  it('keeps the order they dragged, and reads it back', async () => {
    const p = await person()
    const order = ['/schedule', '/dashboard', '/tenants']
    expect((await put(p, order)).status).toBe(200)
    expect((await get(p)).body.data.layout).toEqual(order)
  })

  it('is one person\'s own — nobody else reads it and nobody else writes it', async () => {
    const a = await person()
    const b = await person()
    await put(a, ['/schedule', '/dashboard'])
    expect((await get(b)).body.data.layout).toEqual([])
    await put(b, ['/tenants'])
    expect((await get(a)).body.data.layout).toEqual(['/schedule', '/dashboard'])
  })

  it('the two screens are arranged separately', async () => {
    const p = await person()
    await put(p, ['/schedule'], 'landlord_nav')
    await put(p, ['rent-roll', 'occupancy'], 'landlord_dashboard')
    expect((await get(p, 'landlord_nav')).body.data.layout).toEqual(['/schedule'])
    expect((await get(p, 'landlord_dashboard')).body.data.layout).toEqual(['rent-roll', 'occupancy'])
  })

  it('Reset writes an empty order and KEEPS the row — nothing in GAM is erased', async () => {
    const p = await person()
    await put(p, ['/schedule', '/dashboard'])
    expect((await put(p, [])).status).toBe(200)
    expect((await get(p)).body.data.layout).toEqual([])
    const rows = await query(`SELECT 1 FROM user_ui_layout WHERE user_id = $1`, [p.userId])
    expect(rows).toHaveLength(1)
  })

  it('stores a tidy list and nothing else — no blanks, no repeats, no objects, nothing oversized', async () => {
    const p = await person()
    const res = await put(p, ['/schedule', '', '  /dashboard  ', '/schedule', 42, null, { to: '/x' }, 'y'.repeat(200)])
    expect(res.status).toBe(200)
    expect(res.body.data.layout).toEqual(['/schedule', '/dashboard'])
  })

  it('refuses a screen it does not have, and an arrangement that is not a list', async () => {
    const p = await person()
    expect((await get(p, 'somebody_elses_screen')).status).toBe(404)
    expect((await put(p, ['/x'], 'somebody_elses_screen')).status).toBe(404)
    expect((await put(p, { '/schedule': 1 })).status).toBe(400)
    expect((await put(p, Array.from({ length: 300 }, (_, i) => `/p${i}`))).status).toBe(400)
  })

  it('needs somebody signed in', async () => {
    expect((await request(app()).get('/api/ui-layout/landlord_nav')).status).toBe(401)
    expect((await request(app()).put('/api/ui-layout/landlord_nav').send({ layout: [] })).status).toBe(401)
  })
})
