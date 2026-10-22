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
const untick = (token: string, propertyId: string, itemId: string) =>
  app().post(`/api/property-task-list/${propertyId}/items/${itemId}/undone`)
    .set('Authorization', `Bearer ${token}`).send({})
const unhide = (token: string, propertyId: string, itemId: string) =>
  app().post(`/api/property-task-list/${propertyId}/items/${itemId}/unhide`)
    .set('Authorization', `Bearer ${token}`).send({})
const listWithRemoved = (token: string, propertyId: string) =>
  app().get(`/api/property-task-list/${propertyId}?withHidden=1`).set('Authorization', `Bearer ${token}`)

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
      // 10/21 (Nic): the supply list — "anybody can contribute to a list of
      // things to purchase" — lives in this same table under a kind, because
      // the two lists are the same four columns and a second parallel table
      // for them is the duplication he killed the night before. It adds a
      // column; it still reports on nothing.
      'apps/api/src/db/migrations/20261023120000_a_supply_list_beside_the_task_list.sql',
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
      'hidden_at', 'hidden_by_user_id', 'id',
      // 10/21: which of the park's two lists this line is on — jobs, or things
      // to buy. Still no status, no priority, no assignee, no due date and no
      // recurrence: the absences are the feature.
      'kind',
      'property_id',
    ])
  })
})


/**
 * 10/21 (Nic), after a stray click on Mountain View's list:
 *
 *   "I clicked on it and it highlighted and I couldn't unclick it. And then I
 *    tried to X out of it and it deleted it from the list, not completed it. So
 *    whatever was there, I didn't get a chance to read it. Please revert that."
 *
 * Nothing had been erased — the row sat there with hidden_at stamped on it — but
 * nothing on screen could bring it back, which from where he stood is the same
 * as gone. Both one-way doors now have a way back, and both are the OWNER's:
 * the one-way tick is what stops a second tap on a worker's phone rewriting the
 * name of whoever did the work.
 */
describe('10/21 (Nic): nothing on this list is one-way for the owner', () => {
  it('un-ticks a line the owner ticked by accident, and clears the ticker with it', async () => {
    const park = await seedPark()
    const { body: added } = await add(park.token, park.propertyId, 'Fix the meters on row C')
    const id = added.data.id
    await tick(park.token, park.propertyId, id)
    expect((await list(park.token, park.propertyId)).body.data[0].doneAt).toBeTruthy()

    const r = await untick(park.token, park.propertyId, id)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const back = (await list(park.token, park.propertyId)).body.data[0]
    // Not done, and by nobody — a line that is not done was not done by anyone.
    expect(back.doneAt).toBeNull()
    expect(back.doneByUserId).toBeNull()
    expect(back.doneByName).toBeNull()
    expect(back.body).toBe('Fix the meters on row C')
  })

  it('puts back a line the X took off the list, with its words intact', async () => {
    const park = await seedPark()
    const { body: added } = await add(park.token, park.propertyId,
      'Final electric read — RV 44, take it the day they leave')
    const id = added.data.id
    await hide(park.token, park.propertyId, id)
    // Gone from the list, as before …
    expect((await list(park.token, park.propertyId)).body.data).toHaveLength(0)
    // … but readable by the owner, which is what was missing.
    const removed = (await listWithRemoved(park.token, park.propertyId)).body.data
    expect(removed).toHaveLength(1)
    expect(removed[0].hiddenAt).toBeTruthy()
    expect(removed[0].body).toContain('Final electric read')

    const r = await unhide(park.token, park.propertyId, id)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const live = (await list(park.token, park.propertyId)).body.data
    expect(live).toHaveLength(1)
    expect(live[0].hiddenAt).toBeNull()
    expect(live[0].body).toContain('Final electric read')
  })

  it('putting a line back says nothing about whether the work was done', async () => {
    const park = await seedPark()
    const { body: added } = await add(park.token, park.propertyId, 'Re-gravel site 12')
    const id = added.data.id
    await tick(park.token, park.propertyId, id)
    const whoTicked = (await list(park.token, park.propertyId)).body.data[0].doneByUserId
    await hide(park.token, park.propertyId, id)
    await unhide(park.token, park.propertyId, id)
    const back = (await list(park.token, park.propertyId)).body.data[0]
    expect(back.doneAt).toBeTruthy()
    expect(back.doneByUserId).toBe(whoTicked)
  })

  it('the worker can tick but can neither un-tick, put back, nor see what was taken off', async () => {
    const park = await seedPark()
    const worker = await seedWorker(park.landlordId, { propertyIds: [park.propertyId] })
    const { body: a } = await add(park.token, park.propertyId, 'Swap the bulb at the gate')
    const { body: b } = await add(park.token, park.propertyId, 'Check the pump')
    await tick(worker.token, park.propertyId, a.data.id)
    await hide(park.token, park.propertyId, b.data.id)

    expect((await untick(worker.token, park.propertyId, a.data.id)).status).toBe(403)
    expect((await unhide(worker.token, park.propertyId, b.data.id)).status).toBe(403)
    // The worker's tick stands, with their name on it.
    const theirs = (await list(worker.token, park.propertyId)).body.data
    expect(theirs).toHaveLength(1)
    expect(theirs[0].doneByUserId).toBe(worker.userId)
    // And asking for the removed pile gets them nothing — it is not a job list.
    const asked = (await listWithRemoved(worker.token, park.propertyId)).body.data
    expect(asked.map((x: any) => x.body)).toEqual(['Swap the bulb at the gate'])
  })

  it('un-ticking an open line and putting back a line already on the list change nothing', async () => {
    const park = await seedPark()
    const { body: added } = await add(park.token, park.propertyId, 'Tighten the gate latch')
    const id = added.data.id
    expect((await untick(park.token, park.propertyId, id)).status).toBe(200)
    expect((await unhide(park.token, park.propertyId, id)).status).toBe(200)
    const live = (await list(park.token, park.propertyId)).body.data
    expect(live).toHaveLength(1)
    expect(live[0].doneAt).toBeNull()
    expect(live[0].hiddenAt).toBeNull()
  })

  it('another landlord\'s line is not un-tickable or restorable by naming a park you do have', async () => {
    const mine = await seedPark()
    const theirs = await seedPark('Oak Park Motel and RV')
    const { body: hers } = await add(theirs.token, theirs.propertyId, 'Their job')
    await tick(theirs.token, theirs.propertyId, hers.data.id)
    // The item id is a body-supplied reference: naming my own park with their
    // item must not reach it.
    expect((await untick(mine.token, mine.propertyId, hers.data.id)).status).toBe(404)
    expect((await unhide(mine.token, mine.propertyId, hers.data.id)).status).toBe(404)
    expect((await list(theirs.token, theirs.propertyId)).body.data[0].doneAt).toBeTruthy()
  })
})

/**
 * 10/21 (Nic) — THE SUPPLY LIST, AND WORK-TRADE PEOPLE SEEING ANY OF THIS.
 *
 *   "We also need a way for maybe maintenance people or work trade people to
 *    put in sort of a collected shopping cart pool of, hey, we need to buy some
 *    new paint brushes and new trash bags. Like, anybody can contribute to a
 *    list of things to purchase. The owner can consult that list when either
 *    ordering online or running to the store. But that way he doesn't have text
 *    messages from like 5 or 6 different people."
 *
 *   "And we need work trade people to be able to see this task list in the
 *    system."
 *
 * Two rules, and the first is INVERTED between the lists, which is the only
 * reason they are not one list:
 *
 *   job     the owner writes; anybody working the park ticks.
 *   supply  anybody working the park writes; only the owner ticks it bought.
 *
 * The second rule is about WHO COUNTS AS WORKING THE PARK. A work-trade
 * resident is a TENANT — not staff — so until now they got a flat 404 on the
 * list of the jobs they are there to do. Their claim is their own agreement.
 */
describe('10/21 (Nic): the supply list, and who may write which list', () => {
  const addKind = (token: string, propertyId: string, body: string, kind: string) =>
    app().post(`/api/property-task-list/${propertyId}`)
      .set('Authorization', `Bearer ${token}`).send({ body, kind })
  const listKind = (token: string, propertyId: string, kind: string) =>
    app().get(`/api/property-task-list/${propertyId}?kind=${kind}`).set('Authorization', `Bearer ${token}`)
  const mineKind = (token: string, kind: string) =>
    app().get(`/api/property-task-list?kind=${kind}`).set('Authorization', `Bearer ${token}`)

  /** A resident who works off their rent at this park, which is a TENANT. */
  async function seedWorkTradeResident(
    landlordId: string, propertyId: string, unitId: string,
    opts: { status?: string; endDate?: string | null } = {},
  ) {
    const userId = randomUUID()
    await db.query(
      `INSERT INTO users (id, email, password_hash, first_name, last_name, role)
       VALUES ($1, $2, 'x', 'Susan', 'Geisman', 'tenant')`, [userId, `wt-${userId}@t.dev`])
    const { rows: [t] } = await db.query<{ id: string }>(
      `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [userId])
    await db.query(
      `INSERT INTO work_trade_agreements
         (unit_id, tenant_id, landlord_id, duties, start_date, end_date, status, monthly_hours_target, covered_charges)
       VALUES ($1,$2,$3,'Around the park','2026-09-01',$5::date,$4,80,'{rent}')`,
      [unitId, t.id, landlordId, opts.status ?? 'active', opts.endDate ?? null])
    return {
      userId,
      token: jwt.sign({ userId, role: 'tenant', email: `wt-${userId}@t.dev`, profileId: t.id, permissions: {} },
                      process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  }

  it('anybody working the park adds to the supply list; only the owner adds to the task list', async () => {
    const park = await seedPark()
    const worker = await seedWorker(park.landlordId, { propertyIds: [park.propertyId] })

    // The thing Nic asked for: the maintenance person's own request.
    const asked = await addKind(worker.token, park.propertyId, 'Trash bags — the 55 gallon ones', 'supply')
    expect(asked.status, JSON.stringify(asked.body)).toBe(200)
    // And the thing that must not change: the task list stays the owner's.
    expect((await addKind(worker.token, park.propertyId, 'Repaint the office', 'job')).status).toBe(403)
    expect((await addKind(park.token, park.propertyId, 'Repaint the office', 'job')).status).toBe(200)
  })

  it('only the owner marks a supply line bought — he is the one at the till', async () => {
    const park = await seedPark()
    const worker = await seedWorker(park.landlordId, { propertyIds: [park.propertyId] })
    const { body: added } = await addKind(worker.token, park.propertyId, 'Paint brushes', 'supply')

    const theirs = await tick(worker.token, park.propertyId, added.data.id)
    expect(theirs.status).toBe(403)
    expect(theirs.body.error).toMatch(/owner/i)
    expect((await tick(park.token, park.propertyId, added.data.id)).status).toBe(200)
    const bought = (await listKind(park.token, park.propertyId, 'supply')).body.data[0]
    expect(bought.doneAt).toBeTruthy()
  })

  it('whoever asked for a thing may take their own request back, but not somebody else\'s and not once it is bought', async () => {
    const park = await seedPark()
    const dale = await seedWorker(park.landlordId, { propertyIds: [park.propertyId] })
    const sam = await seedWorker(park.landlordId, { propertyIds: [park.propertyId] })
    const { body: a } = await addKind(dale.token, park.propertyId, 'Trash bags', 'supply')
    const { body: b } = await addKind(sam.token, park.propertyId, 'A doorknob for 14', 'supply')

    // Somebody else's request is not theirs to cancel.
    expect((await hide(dale.token, park.propertyId, b.data.id)).status).toBe(403)
    // Their own, while unbought, is.
    expect((await hide(dale.token, park.propertyId, a.data.id)).status).toBe(200)
    // Once the owner has bought it, the money is spent and it is his line.
    await tick(park.token, park.propertyId, b.data.id)
    expect((await hide(sam.token, park.propertyId, b.data.id)).status).toBe(403)
  })

  it('the two lists never bleed into each other', async () => {
    const park = await seedPark()
    await addKind(park.token, park.propertyId, 'Take pictures of MH 14 and get it listed', 'job')
    await addKind(park.token, park.propertyId, 'Trash bags', 'supply')
    expect((await listKind(park.token, park.propertyId, 'job')).body.data.map((x: any) => x.body))
      .toEqual(['Take pictures of MH 14 and get it listed'])
    expect((await listKind(park.token, park.propertyId, 'supply')).body.data.map((x: any) => x.body))
      .toEqual(['Trash bags'])
    // And no kind named at all is the task list, so every caller written before
    // the supply list existed still reads what it always read.
    expect((await list(park.token, park.propertyId)).body.data.map((x: any) => x.body))
      .toEqual(['Take pictures of MH 14 and get it listed'])
  })

  it('the shopping view puts every park of one company together, each line naming its park', async () => {
    const park = await seedPark('Spanishfork')
    // A second park on the SAME company: one order, one set of books.
    const c = await db.connect()
    let second: string
    try {
      second = await seedProperty(c, { landlordId: park.landlordId, ownerUserId: park.userId, managedByUserId: park.userId })
      await c.query(`UPDATE properties SET name = 'Springville' WHERE id = $1`, [second])
      await c.query(`UPDATE landlords SET business_name = 'R&N property' WHERE id = $1`, [park.landlordId])
    } finally { c.release() }
    await addKind(park.token, park.propertyId, 'A doorknob for the front', 'supply')
    await addKind(park.token, second, 'A new window', 'supply')
    await addKind(park.token, park.propertyId, 'Repaint the office', 'job')

    const run = (await mineKind(park.token, 'supply')).body.data
    expect(run.map((x: any) => [x.entityName, x.propertyName, x.body])).toEqual([
      ['R&N property', 'Spanishfork', 'A doorknob for the front'],
      ['R&N property', 'Springville', 'A new window'],
    ])
    // The jobs are not on the shopping run.
    expect(JSON.stringify(run)).not.toContain('Repaint the office')
  })
})

describe('10/21 (Nic): "we need work trade people to be able to see this task list"', () => {
  const addKind = (token: string, propertyId: string, body: string, kind: string) =>
    app().post(`/api/property-task-list/${propertyId}`)
      .set('Authorization', `Bearer ${token}`).send({ body, kind })

  async function resident(
    landlordId: string, propertyId: string, unitId: string,
    opts: { trade?: boolean; status?: string; endDate?: string | null } = {},
  ) {
    const userId = randomUUID()
    await db.query(
      `INSERT INTO users (id, email, password_hash, first_name, last_name, role)
       VALUES ($1, $2, 'x', 'Susan', 'Geisman', 'tenant')`, [userId, `res-${userId}@t.dev`])
    const { rows: [t] } = await db.query<{ id: string }>(
      `INSERT INTO tenants (user_id) VALUES ($1) RETURNING id`, [userId])
    if (opts.trade !== false) {
      await db.query(
        `INSERT INTO work_trade_agreements
           (unit_id, tenant_id, landlord_id, duties, start_date, end_date, status, monthly_hours_target, covered_charges)
         VALUES ($1,$2,$3,'Around the park','2026-09-01',$5::date,$4,80,'{rent}')`,
        [unitId, t.id, landlordId, opts.status ?? 'active', opts.endDate ?? null])
    }
    return {
      userId,
      token: jwt.sign({ userId, role: 'tenant', email: `res-${userId}@t.dev`, profileId: t.id, permissions: {} },
                      process.env.JWT_SECRET!, { expiresIn: '1h' }),
    }
  }

  it('reads the park\'s list and ticks a line off, on the strength of their own agreement', async () => {
    const park = await seedPark()
    const susan = await resident(park.landlordId, park.propertyId, park.unitId)
    const { body: job } = await add(park.token, park.propertyId, 'Take pictures of MH 14 and get it listed')

    const read = await list(susan.token, park.propertyId)
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(read.body.data.map((x: any) => x.body)).toEqual(['Take pictures of MH 14 and get it listed'])

    const ticked = await tick(susan.token, park.propertyId, job.data.id)
    expect(ticked.status, JSON.stringify(ticked.body)).toBe(200)
    expect((await list(park.token, park.propertyId)).body.data[0].doneByUserId).toBe(susan.userId)
  })

  it('and can ask for supplies, which is the other half of what Nic asked for', async () => {
    const park = await seedPark()
    const susan = await resident(park.landlordId, park.propertyId, park.unitId)
    const asked = await addKind(susan.token, park.propertyId, 'A new hose for the wash bay', 'supply')
    expect(asked.status, JSON.stringify(asked.body)).toBe(200)
    // Still not the task list: that is the owner's.
    expect((await addKind(susan.token, park.propertyId, 'Repaint the office', 'job')).status).toBe(403)
  })

  it('a PAUSED agreement still reads it — a snowbird back a week early is not locked out', async () => {
    const park = await seedPark()
    const kent = await resident(park.landlordId, park.propertyId, park.unitId, { status: 'paused' })
    await add(park.token, park.propertyId, 'Walk the fence line')
    expect((await list(kent.token, park.propertyId)).status).toBe(200)
  })

  it('a resident with NO work trade sees nothing — "get apartment 4 listed" is not a renter\'s business', async () => {
    const park = await seedPark()
    const renter = await resident(park.landlordId, park.propertyId, park.unitId, { trade: false })
    await add(park.token, park.propertyId, 'Take pictures of MH 14')
    const r = await list(renter.token, park.propertyId)
    // 404, not 403: a renter learns nothing about what exists here.
    expect(r.status).toBe(404)
    expect(JSON.stringify(r.body)).not.toContain('MH 14')
  })

  it('an ENDED agreement is nothing — their hours were billed when it ended', async () => {
    const park = await seedPark()
    const gone = await resident(park.landlordId, park.propertyId, park.unitId, { status: 'ended' })
    await add(park.token, park.propertyId, 'Clear the laundry room')
    expect((await list(gone.token, park.propertyId)).status).toBe(404)
  })

  it('a work-trade resident at ANOTHER park gets nothing here', async () => {
    const mine = await seedPark('Mountain View RV Park')
    const theirs = await seedPark('Oak Park Motel and RV')
    const elsewhere = await resident(theirs.landlordId, theirs.propertyId, theirs.unitId)
    await add(mine.token, mine.propertyId, 'Take pictures of MH 14')
    expect((await list(elsewhere.token, mine.propertyId)).status).toBe(404)
  })

  it('and they cannot write the task list, un-tick, remove or see what was removed', async () => {
    const park = await seedPark()
    const susan = await resident(park.landlordId, park.propertyId, park.unitId)
    const { body: job } = await add(park.token, park.propertyId, 'Walk the fence line')
    await tick(susan.token, park.propertyId, job.data.id)
    expect((await add(susan.token, park.propertyId, 'A list of my own')).status).toBe(403)
    expect((await untick(susan.token, park.propertyId, job.data.id)).status).toBe(403)
    expect((await hide(susan.token, park.propertyId, job.data.id)).status).toBe(403)
    expect((await listWithRemoved(susan.token, park.propertyId)).body.data.every((x: any) => !x.hiddenAt)).toBe(true)
  })
})

/**
 * 10/21 (Nic) — A LIST YOU CANNOT START IS NOT A LIST.
 *
 *   "we also need a way for maybe maintenance people or work trade people to
 *    put in sort of a collected shopping cart pool of, hey, we need to buy some
 *    new paint brushes and new trash bags... that way he doesn't have text
 *    messages from like 5 or 6 different people."
 *
 * The maintenance person's screen could only ever show parks that ALREADY had
 * a line on them, so the first thing that ran out at a quiet park could never
 * be written down — the park was not on screen to write it against.
 */
describe('the parks a person may write a line for', () => {
  const myParks = (token: string) =>
    app().get('/api/property-task-list/my-parks').set('Authorization', `Bearer ${token}`)

  it('names a park with nothing on either list yet', async () => {
    const park = await seedPark()
    const res = await myParks(park.token)
    expect(res.status).toBe(200)
    expect(res.body.data.map((p: any) => p.propertyId)).toContain(park.propertyId)
  })

  it('names only this account\'s parks', async () => {
    const mine_ = await seedPark('Mine')
    const theirs = await seedPark('Theirs')
    const ids = (await myParks(mine_.token)).body.data.map((p: any) => p.propertyId)
    expect(ids).toContain(mine_.propertyId)
    expect(ids).not.toContain(theirs.propertyId)
  })

  it('a worker sees the parks they are ON, and no others', async () => {
    const park = await seedPark('Theirs')
    const other = await seedPark('Not theirs')
    const worker = await seedWorker(park.landlordId, { propertyIds: [park.propertyId] })
    const ids = (await myParks(worker.token)).body.data.map((p: any) => p.propertyId)
    expect(ids).toEqual([park.propertyId])
    expect(ids).not.toContain(other.propertyId)
  })

  it('is not read as a property id — "my-parks" is its own route', async () => {
    const park = await seedPark()
    const res = await myParks(park.token)
    // The /:propertyId route would have refused this as a bad id.
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
  })
})
