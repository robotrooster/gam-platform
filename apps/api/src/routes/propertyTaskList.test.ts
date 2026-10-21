/**
 * 10/20 (Nic, relaying Blu) — THE PARK'S TASK LIST.
 *
 *   "He's looking at a better way for kind of a maintenance, like a task list,
 *    right, for your maintenance person. He doesn't want to sit there and go
 *    through and add everything as a maintenance request per se, but he wants to
 *    have a list that the maintenance person can consult and check off when it's
 *    done, kind of running in parallel to maintenance, sitting outside of it
 *    though, where it's, you know, it's not counting how long it takes to get
 *    closed after it's been open and stuff like that... It's stuff assigned by
 *    the landlord himself."
 *
 * What is tested is the list AND its separation, because the separation is the
 * request and it is the thing a later session would erode first:
 *
 *   - the landlord types lines and they come back in the order typed;
 *   - the maintenance person ticks them, and the tick keeps their name for good;
 *   - the maintenance person cannot WRITE the list — Nic said the landlord
 *     assigns it — and cannot make a line disappear;
 *   - a worker assigned to one park cannot read or tick another park's list;
 *   - another landlord's park answers 404, not 403: one landlord never learns
 *     what exists at another's property;
 *   - and NOTHING about maintenance moves when this list is used. Every
 *     maintenance figure is byte-identical before and after a park's whole
 *     checklist is written and worked through, and nothing in the codebase
 *     reads this table but the checklist itself.
 *
 * Run (the migration this needs is deliberately not on production yet):
 *
 *   DB_NAME=gam_cb_test TEST_APPLY_MIGRATIONS_AFTER=20261022140000 \
 *     npx vitest run routes/propertyTaskList.test
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'

let propertyTaskListRouter: any, maintenanceRouter: any, errorHandler: any
beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_property_task_list'
  ;({ propertyTaskListRouter } = await import('./propertyTaskList'))
  ;({ maintenanceRouter } = await import('./maintenance'))
  ;({ errorHandler } = await import('../middleware/errorHandler'))
})

function buildApp() {
  const app = express()
  app.use(express.json())
  // The API camelizes every response; the frontend reads camelCase off these.
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body: any) => originalJson(camelCaseKeys(body))
    next()
  })
  app.use('/api/property-task-list', propertyTaskListRouter)
  app.use('/api/maintenance', maintenanceRouter)
  app.use(errorHandler)
  return app
}

/** One landlord, one park with a space on it. */
async function seedPark(name = 'Mountain View RV Park') {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET name = $2 WHERE id = $1`, [propertyId, name])
    const unitId = await seedUnit(c, { propertyId, landlordId })
    await c.query('COMMIT')
    return { userId, landlordId, propertyId, unitId, token: landlordToken(userId, landlordId) }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const landlordToken = (userId: string, landlordId: string) =>
  jwt.sign({ userId, role: 'landlord', email: `ll-${userId}@t.dev`,
             profileId: landlordId, landlordIds: [landlordId], permissions: {} },
           process.env.JWT_SECRET!, { expiresIn: '1h' })

/**
 * The maintenance person, scoped the way the landlord scopes them — the park(s)
 * they are assigned to, nothing else. `allProperties` is the other real shape.
 */
async function seedWorker(
  landlordId: string,
  opts: { propertyIds?: string[]; allProperties?: boolean; role?: string } = {},
) {
  const userId = randomUUID()
  const role = opts.role ?? 'maintenance'
  await db.query(
    `INSERT INTO users (id, email, password_hash, first_name, last_name, role)
     VALUES ($1, $2, 'x', 'Dale', 'Pruitt', $3)`,
    [userId, `worker-${userId}@t.dev`, role])
  if (role === 'maintenance') {
    await db.query(
      `INSERT INTO maintenance_worker_scopes
         (user_id, landlord_id, property_ids, unit_ids, job_categories, all_properties)
       VALUES ($1, $2, $3, '{}', '{}', $4)`,
      [userId, landlordId, opts.propertyIds ?? [], opts.allProperties === true])
  }
  return {
    userId,
    token: jwt.sign({ userId, role, email: `worker-${userId}@t.dev`,
                      profileId: userId, landlordId, permissions: {} },
                    process.env.JWT_SECRET!, { expiresIn: '1h' }),
  }
}

const app = () => request(buildApp())
const list = (token: string, propertyId: string) =>
  app().get(`/api/property-task-list/${propertyId}`).set('Authorization', `Bearer ${token}`)
const mine = (token: string) =>
  app().get('/api/property-task-list').set('Authorization', `Bearer ${token}`)
const add = (token: string, propertyId: string, body: string) =>
  app().post(`/api/property-task-list/${propertyId}`).set('Authorization', `Bearer ${token}`).send({ body })
const tick = (token: string, propertyId: string, itemId: string) =>
  app().post(`/api/property-task-list/${propertyId}/items/${itemId}/done`)
    .set('Authorization', `Bearer ${token}`).send({})
const hide = (token: string, propertyId: string, itemId: string) =>
  app().post(`/api/property-task-list/${propertyId}/items/${itemId}/hide`)
    .set('Authorization', `Bearer ${token}`).send({})

// ─────────────────────────────────────────────────────────────────────────────

describe('the landlord writes the list', () => {
  it('takes a line at a time, in the order typed, with no ceremony around it', async () => {
    const f = await seedPark()

    // Nic asked for "something smooth": a line, enter, the next line.
    for (const line of ['Fix the meters on row C', 'Re-gravel the pull-through at RV 14', 'Swap the laundry room bulb'])
      expect((await add(f.token, f.propertyId, line)).status, line).toBe(200)

    const res = await list(f.token, f.propertyId)
    expect(res.status).toBe(200)
    expect(res.body.data.map((i: any) => i.body)).toEqual([
      'Fix the meters on row C',
      'Re-gravel the pull-through at RV 14',
      'Swap the laundry room bulb',
    ])
    // Typed, not ticked, and nobody is named as having done it yet.
    expect(res.body.data.every((i: any) => i.doneAt === null && i.doneByUserId === null)).toBe(true)
  })

  it('will not take a blank line, or a pasted document', async () => {
    const f = await seedPark()
    expect((await add(f.token, f.propertyId, '   ')).status).toBe(400)
    expect((await add(f.token, f.propertyId, 'x'.repeat(501))).status).toBe(400)
    expect((await list(f.token, f.propertyId)).body.data).toEqual([])
  })

  it('takes a line off the list without erasing it', async () => {
    const f = await seedPark()
    const id = (await add(f.token, f.propertyId, 'Call the propane company')).body.data.id

    expect((await hide(f.token, f.propertyId, id)).status).toBe(200)
    expect((await list(f.token, f.propertyId)).body.data).toEqual([])

    // GAM never erases: the line, and who put it there, are still in the table.
    const [row] = await query<any>(
      `SELECT body, added_by_user_id, hidden_at, hidden_by_user_id
         FROM property_task_list_items WHERE id = $1`, [id])
    expect(row.body).toBe('Call the propane company')
    expect(row.added_by_user_id).toBe(f.userId)
    expect(row.hidden_at).not.toBeNull()
    expect(row.hidden_by_user_id).toBe(f.userId)
  })
})

describe('the maintenance person ticks it off', () => {
  it('ticks a line, and the tick keeps their name and the time', async () => {
    const f = await seedPark()
    const w = await seedWorker(f.landlordId, { propertyIds: [f.propertyId] })
    const id = (await add(f.token, f.propertyId, 'Fix the meters on row C')).body.data.id

    const res = await tick(w.token, f.propertyId, id)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.doneAt).not.toBeNull()
    expect(res.body.data.doneByUserId).toBe(w.userId)
    expect(res.body.data.doneByName).toBe('Dale Pruitt')
  })

  it('reads the park\'s list to know what to do', async () => {
    const f = await seedPark()
    const w = await seedWorker(f.landlordId, { propertyIds: [f.propertyId] })
    await add(f.token, f.propertyId, 'Fix the meters on row C')

    const res = await list(w.token, f.propertyId)
    expect(res.status).toBe(200)
    expect(res.body.data.map((i: any) => i.body)).toEqual(['Fix the meters on row C'])
  })

  it('a second tap changes nothing — the first ticker keeps the credit', async () => {
    const f = await seedPark()
    const first = await seedWorker(f.landlordId, { propertyIds: [f.propertyId] })
    const second = await seedWorker(f.landlordId, { propertyIds: [f.propertyId] })
    const id = (await add(f.token, f.propertyId, 'Fix the meters on row C')).body.data.id

    const one = await tick(first.token, f.propertyId, id)
    const again = await tick(second.token, f.propertyId, id)

    // Not an error — a phone in a gravel lot gets tapped twice. And the name on
    // the row is still the person who actually did the work.
    expect(again.status).toBe(200)
    expect(again.body.data.doneByUserId).toBe(first.userId)
    expect(again.body.data.doneAt).toBe(one.body.data.doneAt)
  })

  it('a ticked line stays on the list, below the open ones, with its history', async () => {
    const f = await seedPark()
    const w = await seedWorker(f.landlordId, { propertyIds: [f.propertyId] })
    const first = (await add(f.token, f.propertyId, 'Fix the meters on row C')).body.data.id
    await add(f.token, f.propertyId, 'Swap the laundry room bulb')

    await tick(w.token, f.propertyId, first)

    const res = await list(f.token, f.propertyId)
    // What is left to do is read first; the done line is kept, not dropped.
    expect(res.body.data.map((i: any) => i.body)).toEqual([
      'Swap the laundry room bulb',
      'Fix the meters on row C',
    ])
    const done = res.body.data.find((i: any) => i.body === 'Fix the meters on row C')
    expect(done.doneByUserId).toBe(w.userId)
    expect(done.doneByName).toBe('Dale Pruitt')
    expect(done.addedByUserId).toBe(f.userId)
  })

  it('cannot write the list — Nic: the landlord assigns it', async () => {
    const f = await seedPark()
    const w = await seedWorker(f.landlordId, { propertyIds: [f.propertyId] })

    const res = await add(w.token, f.propertyId, 'Take Thursday off')
    expect(res.status).toBe(403)
    expect((await list(f.token, f.propertyId)).body.data).toEqual([])
  })

  it('cannot make a line disappear', async () => {
    const f = await seedPark()
    const w = await seedWorker(f.landlordId, { propertyIds: [f.propertyId] })
    const id = (await add(f.token, f.propertyId, 'Fix the meters on row C')).body.data.id

    expect((await hide(w.token, f.propertyId, id)).status).toBe(403)
    // Still there, still to do.
    expect((await list(f.token, f.propertyId)).body.data.map((i: any) => i.body))
      .toEqual(['Fix the meters on row C'])
  })

  it('an on-site manager on the property ticks too — whoever is standing there', async () => {
    const f = await seedPark()
    const m = await seedWorker(f.landlordId, { role: 'onsite_manager' })
    await db.query(
      `INSERT INTO onsite_manager_scopes (user_id, landlord_id, property_ids, unit_ids, all_properties, permissions)
       VALUES ($1, $2, $3, '{}', false, '{}'::jsonb)`,
      [m.userId, f.landlordId, [f.propertyId]])
    const id = (await add(f.token, f.propertyId, 'Fix the meters on row C')).body.data.id

    const res = await tick(m.token, f.propertyId, id)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.doneByUserId).toBe(m.userId)
  })
})

describe('the list belongs to one park, and one account', () => {
  it('a worker assigned to one park cannot read or tick another park\'s list', async () => {
    const mine_ = await seedPark('Mountain View RV Park')
    // A second park under the SAME landlord, which the worker is not on.
    const other = await (async () => {
      const c = await db.connect()
      try {
        const id = await seedProperty(c, { landlordId: mine_.landlordId, ownerUserId: mine_.userId, managedByUserId: mine_.userId })
        await c.query(`UPDATE properties SET name = 'Oak Park' WHERE id = $1`, [id])
        return id
      } finally { c.release() }
    })()
    const w = await seedWorker(mine_.landlordId, { propertyIds: [mine_.propertyId] })
    const theirs = (await add(mine_.token, other, 'Fix the meters on row C')).body.data.id

    expect((await list(w.token, other)).status).toBe(403)
    expect((await tick(w.token, other, theirs)).status).toBe(403)
    // And it is genuinely untouched.
    const [row] = await query<any>(`SELECT done_at FROM property_task_list_items WHERE id = $1`, [theirs])
    expect(row.done_at).toBeNull()
  })

  it('an item id from another park is not reachable by naming a park you do have', async () => {
    const f = await seedPark()
    const other = await seedPark('Oak Park')
    const theirs = (await add(other.token, other.propertyId, 'Fix the meters on row C')).body.data.id

    // The caller holds f's park legitimately and points it at another
    // landlord's item. The property id is in the WHERE, so there is no row.
    expect((await tick(f.token, f.propertyId, theirs)).status).toBe(404)
    const [row] = await query<any>(`SELECT done_at FROM property_task_list_items WHERE id = $1`, [theirs])
    expect(row.done_at).toBeNull()
  })

  it('another landlord\'s park answers 404, never 403 — it does not confirm the park exists', async () => {
    const f = await seedPark()
    const other = await seedPark('Somebody Else\'s Park')

    expect((await list(f.token, other.propertyId)).status).toBe(404)
    expect((await add(f.token, other.propertyId, 'Fix their meters')).status).toBe(404)
    expect((await query<any>(`SELECT id FROM property_task_list_items`)).length).toBe(0)
  })

  it('the worker\'s own screen shows their parks\' open lines and nobody else\'s', async () => {
    const f = await seedPark('Mountain View RV Park')
    const stranger = await seedPark('Another Landlord\'s Park')
    const w = await seedWorker(f.landlordId, { propertyIds: [f.propertyId] })

    const done = (await add(f.token, f.propertyId, 'Already handled')).body.data.id
    await add(f.token, f.propertyId, 'Fix the meters on row C')
    await add(stranger.token, stranger.propertyId, 'Not their business')
    await tick(w.token, f.propertyId, done)

    const res = await mine(w.token)
    expect(res.status).toBe(200)
    // Open lines only — a checklist screen shows what is left.
    expect(res.body.data.map((i: any) => i.body)).toEqual(['Fix the meters on row C'])
    expect(res.body.data[0].propertyName).toBe('Mountain View RV Park')
  })

  it('an unauthenticated caller gets nothing', async () => {
    const f = await seedPark()
    expect((await app().get(`/api/property-task-list/${f.propertyId}`)).status).toBe(401)
    expect((await app().post(`/api/property-task-list/${f.propertyId}`).send({ body: 'x' })).status).toBe(401)
  })
})

describe('it sits outside maintenance, and that is the point', () => {
  /** Every maintenance figure the platform reports for this landlord. */
  async function maintenanceFigures(token: string) {
    const res = await app().get('/api/maintenance/stats/summary').set('Authorization', `Bearer ${token}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    // The one Nic named by name: "how long it takes to get closed after it's
    // been open" — getPortfolioStats.averageDaysToComplete, and the counts the
    // dashboard and the monthly property report read.
    const [agg] = await query<any>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled'))::int AS open,
              ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 86400)
                    FILTER (WHERE completed_at IS NOT NULL)::numeric, 1) AS avg_days
         FROM maintenance_requests`)
    return { summary: res.body.data, agg }
  }

  it('writing and working a whole checklist moves no maintenance figure at all', async () => {
    const f = await seedPark()
    const w = await seedWorker(f.landlordId, { propertyIds: [f.propertyId] })
    // A real repair, so the figures are not all zero and a change would show.
    await db.query(
      `INSERT INTO maintenance_requests (unit_id, landlord_id, title, description, status, actual_cost, completed_at)
       VALUES ($1, $2, 'Water heater', 'No hot water', 'completed', 320, NOW())`,
      [f.unitId, f.landlordId])

    const before = await maintenanceFigures(f.token)

    const ids: string[] = []
    for (const line of ['Fix the meters on row C', 'Re-gravel RV 14', 'Swap the laundry bulb'])
      ids.push((await add(f.token, f.propertyId, line)).body.data.id)
    for (const id of ids) await tick(w.token, f.propertyId, id)
    await hide(f.token, f.propertyId, ids[0])

    const after = await maintenanceFigures(f.token)
    // Not "roughly the same" — identical. A checklist is not a repair job.
    expect(after).toEqual(before)
    // And no request was invented out of a checklist line.
    expect(before.agg.total).toBe(1)
    expect(after.agg.total).toBe(1)
  })

  it('nothing in the codebase reads this table but the checklist itself', () => {
    // The guard that matters in six months. A report, a dashboard tile or a
    // nightly job quietly joining this table is how "sitting outside of it"
    // ends — and it would pass every other test in this file.
    const ALLOWED = new Set([
      'apps/api/src/services/propertyTaskList.ts',
      'apps/api/src/routes/propertyTaskList.ts',
      'apps/api/src/routes/propertyTaskList.test.ts',
      'apps/api/src/db/migrations/20261022150000_a_task_list_is_not_a_work_order.sql',
      'apps/api/src/db/schema.sql',   // the generated dump, once this migration lands
      // 10/20 (Nic): ONE task list, not two. The old landlord-wide Tasks tab is
      // retired and its still-open lines were moved onto the park lists — a
      // one-time fold, plus the function that does it so it can be re-run for
      // anything added before the tab stopped being offered. It WRITES this
      // table rather than reporting on it, which is the thing the guard is
      // here to prevent, and it is still not maintenance.
      'apps/api/src/db/migrations/20261022182000_one_task_list_not_two.sql',
      'apps/api/src/routes/oneTaskList.test.ts',
    ])
    const repo = join(__dirname, '..', '..', '..', '..')
    const hits: string[] = []
    const skip = new Set(['node_modules', '.git', 'dist', '.claude', 'uploads', 'build', 'coverage'])
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (skip.has(name)) continue
        const full = join(dir, name)
        let st
        try { st = statSync(full) } catch { continue }
        if (st.isDirectory()) { walk(full); continue }
        if (!/\.(ts|tsx|js|sql)$/.test(name)) continue
        const rel = full.slice(repo.length + 1)
        if (ALLOWED.has(rel)) continue
        if (readFileSync(full, 'utf8').includes('property_task_list_items')) hits.push(rel)
      }
    }
    walk(join(repo, 'apps'))
    walk(join(repo, 'packages'))
    expect(hits, hits.length
      ? `\nThese read the task-list table, which is meant to sit outside maintenance:\n  ${hits.join('\n  ')}\n` +
        'If a report or job genuinely should read it, that is a product decision for Nic — ' +
        'add it to ALLOWED here with the reason.\n'
      : '').toEqual([])
  })

  it('the table never grew maintenance\'s shape', async () => {
    // Nic listed what this is not: no status, no priority, no assignment, no
    // due date, nothing timing how long a line was open. A column added later
    // is how a checklist becomes a work-order queue.
    const cols = (await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'property_task_list_items'`))
      .map(r => r.column_name).sort()
    expect(cols).toEqual([
      'added_by_user_id', 'body', 'created_at', 'done_at', 'done_by_user_id',
      'hidden_at', 'hidden_by_user_id', 'id', 'property_id',
    ])
  })
})
