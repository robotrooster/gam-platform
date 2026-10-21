/**
 * 10/20 (Nic) — ONE TASK LIST, NOT TWO.
 *
 * Blu's per-property task list went in yesterday and works. What was left was
 * the redundancy beside it: an older landlord-wide "Tasks" tab in the
 * Maintenance Portal with due dates and daily/weekly/monthly repeats,
 * half-used. Nic, on another duplicated surface the same evening:
 *
 *     "That doesn't need to be its own tab. That's kind of ridiculous."
 *
 * So the old list stops being offered and its still-open lines move onto the
 * park they belong to. What is tested here is the fold and the three things
 * about it that would be easy to get quietly wrong:
 *
 *   - a line lands on the RIGHT park, worked out from what the row itself
 *     points at — never guessed;
 *   - a line nothing points at is LEFT ALONE and says so in plain words, rather
 *     than being dropped on whichever park sorted first;
 *   - nothing is erased. The old row keeps its title, its due date, the repeat
 *     somebody set up and whoever finished it, and gains a pointer to the line
 *     it became. GAM never erases.
 *
 * And the two guarantees Blu's list was built on, which a data move is exactly
 * the kind of change that breaks: no maintenance figure moves, and nobody is
 * emailed about any of it.
 *
 * Run (the migrations this needs are deliberately not on production yet):
 *
 *   DB_NAME=gam_fin_test TEST_APPLY_MIGRATIONS_AFTER=20261022140000 \
 *     npx vitest run routes/oneTaskList.test
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { db, query, queryOne } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { camelCaseKeys } from '../lib/caseConversion'

let propertyTaskListRouter: any, maintenancePortalRouter: any, maintenanceRouter: any, errorHandler: any
beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_one_task_list'
  ;({ propertyTaskListRouter } = await import('./propertyTaskList'))
  ;({ maintenancePortalRouter } = await import('./maintenance-portal'))
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
  app.use('/api/maint-portal', maintenancePortalRouter)
  app.use('/api/maintenance', maintenanceRouter)
  app.use(errorHandler)
  return app
}

const app = () => request(buildApp())

const landlordToken = (userId: string, landlordId: string) =>
  jwt.sign({ userId, role: 'landlord', email: `ll-${userId}@t.dev`,
             profileId: landlordId, landlordIds: [landlordId], permissions: {} },
           process.env.JWT_SECRET!, { expiresIn: '1h' })

/** One company, one park with a space on it. */
async function seedPark(name: string) {
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

/** A second park under the SAME company — Nic's own shape: two parks, one account. */
async function addPark(f: { landlordId: string; userId: string }, name: string) {
  const c = await db.connect()
  try {
    const id = await seedProperty(c, {
      landlordId: f.landlordId, ownerUserId: f.userId, managedByUserId: f.userId })
    await c.query(`UPDATE properties SET name = $2 WHERE id = $1`, [id, name])
    return id
  } finally { c.release() }
}

/** The maintenance person, scoped to the parks the landlord put them on. */
async function seedWorker(
  landlordId: string,
  opts: { propertyIds?: string[]; allProperties?: boolean } = {},
) {
  const userId = randomUUID()
  await db.query(
    `INSERT INTO users (id, email, password_hash, first_name, last_name, role)
     VALUES ($1, $2, 'x', 'Dale', 'Pruitt', 'maintenance')`,
    [userId, `worker-${userId}@t.dev`])
  await db.query(
    `INSERT INTO maintenance_worker_scopes
       (user_id, landlord_id, property_ids, unit_ids, job_categories, all_properties)
     VALUES ($1, $2, $3, '{}', '{}', $4)`,
    [userId, landlordId, opts.propertyIds ?? [], opts.allProperties === true])
  return userId
}

/** A line on the OLD landlord-wide list, the way the retired tab wrote them. */
async function oldTask(
  landlordId: string,
  t: { title?: string; description?: string; assignedTo?: string | null
        dueDate?: string | null; recurrence?: string; completed?: boolean
        completedBy?: string | null } = {},
) {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO daily_tasks
       (landlord_id, title, description, assigned_to, due_date, recurrence,
        completed, completed_at, completed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             CASE WHEN $7 THEN NOW() ELSE NULL END, $8)
     RETURNING id`,
    [landlordId, t.title ?? 'Check the pool chemicals', t.description ?? null,
     t.assignedTo ?? null, t.dueDate ?? null, t.recurrence ?? 'none',
     t.completed === true, t.completedBy ?? null])
  return row!.id
}

/** The fold itself — the production path, called the way the migration calls it. */
const fold = () =>
  queryOne<{ folded: number; left_alone: number }>(
    `SELECT * FROM fold_old_task_list_into_property_lists()`)

const parkList = (token: string, propertyId: string) =>
  app().get(`/api/property-task-list/${propertyId}`).set('Authorization', `Bearer ${token}`)

const oldRow = (id: string) =>
  queryOne<any>(`SELECT * FROM daily_tasks WHERE id = $1`, [id])

// ─────────────────────────────────────────────────────────────────────────────

describe('an old line lands on the park it belongs to', () => {
  it('a company with one park has only one park it could mean', async () => {
    const f = await seedPark('Mountain View RV Park')
    const id = await oldTask(f.landlordId, { title: 'Fix the meters on row C' })

    expect(await fold()).toEqual({ folded: 1, left_alone: 0 })

    const res = await parkList(f.token, f.propertyId)
    expect(res.status).toBe(200)
    expect(res.body.data.map((i: any) => i.body)).toEqual(['Fix the meters on row C'])
    // Typed by the landlord, not ticked: it was still to do, and it still is.
    expect(res.body.data[0].doneAt).toBeNull()
    expect(res.body.data[0].addedByUserId).toBe(f.userId)

    // And the old row is still here, pointing at the line it became.
    const row = await oldRow(id)
    expect(row.title).toBe('Fix the meters on row C')
    expect(row.completed).toBe(false)
    expect(row.folded_into_property_task_id).toBe(res.body.data[0].id)
    expect(row.fold_note).toBeNull()
  })

  it('two parks, and the person it was given to works one of them', async () => {
    const f = await seedPark('Mountain View RV Park')
    const oak = await addPark(f, 'Oak Park')
    const dale = await seedWorker(f.landlordId, { propertyIds: [oak] })
    await oldTask(f.landlordId, { title: 'Re-gravel the pull-through at RV 14', assignedTo: dale })

    expect(await fold()).toEqual({ folded: 1, left_alone: 0 })

    // On Dale's park, and on no other.
    expect((await parkList(f.token, oak)).body.data.map((i: any) => i.body))
      .toEqual(['Re-gravel the pull-through at RV 14'])
    expect((await parkList(f.token, f.propertyId)).body.data).toEqual([])
  })

  it('the title and the detail read as one line, because the park\'s list has no detail field', async () => {
    const f = await seedPark('Mountain View RV Park')
    await oldTask(f.landlordId, { title: 'Swap the laundry bulb', description: 'The one over the dryers' })

    await fold()

    expect((await parkList(f.token, f.propertyId)).body.data[0].body)
      .toBe('Swap the laundry bulb — The one over the dryers')
  })

  it('one landlord\'s old list never lands on another landlord\'s park', async () => {
    const mine = await seedPark('Mountain View RV Park')
    const stranger = await seedPark('Another Landlord\'s Park')
    await oldTask(mine.landlordId, { title: 'Fix the meters on row C' })
    await oldTask(stranger.landlordId, { title: 'Not their business' })

    expect(await fold()).toEqual({ folded: 2, left_alone: 0 })

    expect((await parkList(mine.token, mine.propertyId)).body.data.map((i: any) => i.body))
      .toEqual(['Fix the meters on row C'])
    expect((await parkList(stranger.token, stranger.propertyId)).body.data.map((i: any) => i.body))
      .toEqual(['Not their business'])
  })
})

describe('a line nothing points at is left alone, and says so', () => {
  it('two parks and nobody named — not folded, and the reason is on the row', async () => {
    const f = await seedPark('Mountain View RV Park')
    await addPark(f, 'Oak Park')
    const id = await oldTask(f.landlordId, { title: 'Order more gravel', recurrence: 'monthly' })

    expect(await fold()).toEqual({ folded: 0, left_alone: 1 })

    // Nothing invented on either park.
    expect((await query<any>(`SELECT id FROM property_task_list_items`)).length).toBe(0)

    // Still exactly as it was, plus a note a person can read.
    const row = await oldRow(id)
    expect(row.title).toBe('Order more gravel')
    expect(row.recurrence).toBe('monthly')
    expect(row.completed).toBe(false)
    expect(row.folded_into_property_task_id).toBeNull()
    expect(row.fold_note).toContain('nothing on this item names a property')
    expect(row.fold_note).toContain('was not guessed at')
  })

  it('a worker who covers every park points at every park, which points at none', async () => {
    const f = await seedPark('Mountain View RV Park')
    await addPark(f, 'Oak Park')
    const everywhere = await seedWorker(f.landlordId, { allProperties: true })
    await oldTask(f.landlordId, { title: 'Walk both parks', assignedTo: everywhere })

    expect(await fold()).toEqual({ folded: 0, left_alone: 1 })
    expect((await query<any>(`SELECT id FROM property_task_list_items`)).length).toBe(0)
  })

  it('a worker assigned to two of the parks is still a guess', async () => {
    const f = await seedPark('Mountain View RV Park')
    const oak = await addPark(f, 'Oak Park')
    const both = await seedWorker(f.landlordId, { propertyIds: [f.propertyId, oak] })
    await oldTask(f.landlordId, { title: 'Walk both parks', assignedTo: both })

    expect(await fold()).toEqual({ folded: 0, left_alone: 1 })
  })

  it('a wordless row has nothing to put on a list', async () => {
    // The old POST had no title validator, so this is a shape that can exist.
    const f = await seedPark('Mountain View RV Park')
    const id = await oldTask(f.landlordId, { title: '   ' })

    expect(await fold()).toEqual({ folded: 0, left_alone: 1 })
    expect((await oldRow(id)).fold_note).toContain('no words on it')
  })
})

describe('a repeat is carried in the line\'s own words, never dropped', () => {
  it('says when it was due and how often it repeated, the way somebody would say it', async () => {
    const f = await seedPark('Mountain View RV Park')
    const id = await oldTask(f.landlordId, {
      title: 'Check the pool chemicals', dueDate: '2026-10-04', recurrence: 'daily' })

    await fold()

    const line = (await parkList(f.token, f.propertyId)).body.data[0]
    expect(line.body).toBe('Check the pool chemicals (was due Oct 4, 2026 and set to repeat every day)')
    // Never the raw column value.
    expect(line.body).not.toContain('daily')

    // And the rule itself is still where somebody set it up. GAM never erases.
    const row = await oldRow(id)
    expect(row.recurrence).toBe('daily')
    expect(row.due_date).not.toBeNull()
  })

  it('a repeat with no due date, and a due date with no repeat, each read on their own', async () => {
    const f = await seedPark('Mountain View RV Park')
    await oldTask(f.landlordId, { title: 'Empty the dumpsters', recurrence: 'weekly' })
    await oldTask(f.landlordId, { title: 'Call the propane company', dueDate: '2026-10-04' })

    expect(await fold()).toEqual({ folded: 2, left_alone: 0 })

    expect((await parkList(f.token, f.propertyId)).body.data.map((i: any) => i.body)).toEqual([
      'Empty the dumpsters (was set to repeat every week)',
      'Call the propane company (was due Oct 4, 2026)',
    ])
  })

  it('a line with neither says nothing extra — it is just the job', async () => {
    const f = await seedPark('Mountain View RV Park')
    await oldTask(f.landlordId, { title: 'Fix the meters on row C' })

    await fold()
    expect((await parkList(f.token, f.propertyId)).body.data[0].body)
      .toBe('Fix the meters on row C')
  })

  it('the park\'s list did NOT grow a repeat column to hold them', async () => {
    // The absences are the feature (migration 20261022150000). Four half-used
    // rows are not a reason to put a due date and a recurrence on a checklist
    // Nic asked to have neither.
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

describe('nothing is erased, and nothing is done twice', () => {
  it('a finished line is not resurrected as something to do', async () => {
    const f = await seedPark('Mountain View RV Park')
    const id = await oldTask(f.landlordId, {
      title: 'Blew out the sprinklers', completed: true, completedBy: f.userId })

    expect(await fold()).toEqual({ folded: 0, left_alone: 0 })
    expect((await parkList(f.token, f.propertyId)).body.data).toEqual([])

    // Still finished, still saying who finished it.
    const row = await oldRow(id)
    expect(row.completed).toBe(true)
    expect(row.completed_by).toBe(f.userId)
    expect(row.completed_at).not.toBeNull()
  })

  it('running it again folds nothing a second time', async () => {
    const f = await seedPark('Mountain View RV Park')
    await oldTask(f.landlordId, { title: 'Fix the meters on row C' })

    expect(await fold()).toEqual({ folded: 1, left_alone: 0 })
    // The gap between this migration reaching production and the tab going
    // away is exactly why it can be run again by hand.
    expect(await fold()).toEqual({ folded: 0, left_alone: 0 })
    expect((await parkList(f.token, f.propertyId)).body.data.length).toBe(1)
  })

  it('a line added in that gap is picked up by the next run', async () => {
    const f = await seedPark('Mountain View RV Park')
    await oldTask(f.landlordId, { title: 'Fix the meters on row C' })
    await fold()

    await oldTask(f.landlordId, { title: 'Reset the breaker at RV 9' })
    expect(await fold()).toEqual({ folded: 1, left_alone: 0 })
    expect((await parkList(f.token, f.propertyId)).body.data.map((i: any) => i.body))
      .toEqual(['Fix the meters on row C', 'Reset the breaker at RV 9'])
  })
})

describe('the old tab is gone, and its record is still readable', () => {
  const src = (p: string) => readFileSync(join(__dirname, '..', '..', '..', '..', p), 'utf8')

  it('the Maintenance Portal page does not offer the old Tasks tab any more', () => {
    const page = src('apps/landlord/src/pages/MaintenancePortalPage.tsx')
    // No tab, no panel, no way to write to the old list from the screen.
    expect(page).not.toContain("tab==='tasks'")
    expect(page).not.toContain("'/maint-portal/tasks'")
    expect(page).not.toContain('/maint-portal/tasks/')
    expect(page).not.toContain('Add Task')
    // And the one list that is left is simply "Tasks" — the qualifier only
    // existed to tell it apart from the tab that is gone.
    expect(page).toContain("label:'Tasks'")
    expect(page).not.toContain("label:'Property Tasks'")
  })

  it('neither write endpoint exists any more', async () => {
    const f = await seedPark('Mountain View RV Park')
    const id = await oldTask(f.landlordId, { title: 'Fix the meters on row C' })

    const posted = await app().post('/api/maint-portal/tasks')
      .set('Authorization', `Bearer ${f.token}`).send({ title: 'A second list' })
    expect(posted.status).toBe(404)
    const patched = await app().patch(`/api/maint-portal/tasks/${id}/complete`)
      .set('Authorization', `Bearer ${f.token}`).send({})
    expect(patched.status).toBe(404)

    // Nothing was written either way.
    expect((await query<any>(`SELECT id FROM daily_tasks`)).length).toBe(1)
    expect((await oldRow(id)).completed).toBe(false)
  })

  it('the record still reads, and each row says where its line went', async () => {
    const f = await seedPark('Mountain View RV Park')
    const kept = await oldTask(f.landlordId, {
      title: 'Check the pool chemicals', recurrence: 'weekly' })
    const done = await oldTask(f.landlordId, {
      title: 'Blew out the sprinklers', completed: true, completedBy: f.userId })
    await fold()

    const res = await app().get('/api/maint-portal/tasks').set('Authorization', `Bearer ${f.token}`)
    expect(res.status).toBe(200)
    const byId = Object.fromEntries(res.body.data.map((t: any) => [t.id, t]))
    // Both rows readable — including the finished one, which the old screen's
    // "due today or repeating" filter used to hide.
    expect(Object.keys(byId).sort()).toEqual([kept, done].sort())
    // The repeat somebody set up is still there to read.
    expect(byId[kept].recurrence).toBe('weekly')
    expect(byId[kept].foldedIntoPropertyTaskId).not.toBeNull()
    expect(byId[done].completed).toBe(true)
    expect(byId[done].foldedIntoPropertyTaskId).toBeNull()

    // The pointer resolves to the line that is actually on the park's list.
    const live = (await parkList(f.token, f.propertyId)).body.data
    expect(live.map((i: any) => i.id)).toEqual([byId[kept].foldedIntoPropertyTaskId])
  })

  it('the assistant is not left pointing at the dead surface', () => {
    // An action whose endpoint is gone means the agent offers to put a job on
    // the board and the job lands nowhere anybody looks.
    const actions = src('apps/api/src/services/agents/portalActions.ts')
    expect(actions).not.toContain("id: 'create_daily_task'")
    expect(actions).not.toContain("id: 'complete_daily_task'")
    const profiles = src('apps/api/src/services/agents/profiles.ts')
    expect(profiles).not.toContain("'create_daily_task'")
    expect(profiles).not.toContain("'complete_daily_task'")
  })
})

describe('it moves no maintenance figure, and emails nobody', () => {
  /** Every maintenance figure the platform reports for this landlord. */
  async function maintenanceFigures(token: string) {
    const res = await app().get('/api/maintenance/stats/summary').set('Authorization', `Bearer ${token}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const [agg] = await query<any>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled'))::int AS open,
              ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 86400)
                    FILTER (WHERE completed_at IS NOT NULL)::numeric, 1) AS avg_days
         FROM maintenance_requests`)
    return { summary: res.body.data, agg }
  }

  it('folding a whole old list moves nothing about maintenance and notifies nobody', async () => {
    const f = await seedPark('Mountain View RV Park')
    // A real repair, so the figures are not all zero and a change would show.
    await db.query(
      `INSERT INTO maintenance_requests (unit_id, landlord_id, title, description, status, actual_cost, completed_at)
       VALUES ($1, $2, 'Water heater', 'No hot water', 'completed', 320, NOW())`,
      [f.unitId, f.landlordId])
    for (const t of ['Fix the meters on row C', 'Re-gravel RV 14', 'Empty the dumpsters'])
      await oldTask(f.landlordId, { title: t, recurrence: 'weekly' })

    const before = await maintenanceFigures(f.token)
    const notifiedBefore = (await query<any>(`SELECT id FROM notifications`)).length

    expect(await fold()).toEqual({ folded: 3, left_alone: 0 })

    const after = await maintenanceFigures(f.token)
    // Not "roughly the same" — identical. A checklist is not a repair job, and
    // moving one between lists does not make it one.
    expect(after).toEqual(before)
    expect(before.agg.total).toBe(1)
    // Nobody was told. Nic's own reasoning on the park list was that an email
    // per line is the ceremony Blu is trying to get away from; a silent data
    // move is not a reason to send three.
    expect((await query<any>(`SELECT id FROM notifications`)).length).toBe(notifiedBefore)
  })
})

describe('both halves of the move can be run again', () => {
  const migration = (f: string) =>
    readFileSync(join(__dirname, '..', 'db', 'migrations', f), 'utf8')

  // The two files the move is made of: the one that builds the park's list, and
  // the one that empties the old list onto it.
  const BUILDS_THE_LIST = '20261022150000_a_task_list_is_not_a_work_order.sql'
  const FOLDS_THE_OLD_ONE = '20261022182000_one_task_list_not_two.sql'

  /**
   * 10/20 — THE FOLD MIGRATION IS MEANT TO BE RUN TWICE, SO THE FILE HAS TO
   * SURVIVE IT.
   *
   * Its own header says so: it reaches production before the code that removes
   * the old tab, so for the gap between them a landlord can still add a line to
   * the old list, and the fix for that is to run it again by hand —
   *
   *     SELECT * FROM fold_old_task_list_into_property_lists();
   *
   * That was true of the function and NOT true of the file around it. A second
   * pass died on `ADD COLUMN folded_into_property_task_id` (42701) before it
   * ever reached the fold, and the file that builds the list died one step
   * earlier on `CREATE TABLE property_task_list_items` (42P07) — so the repo's
   * own expand-only gate (routes/posPropaneProduct.test.ts, which applies every
   * migration production has not seen yet twice) was red on both.
   *
   * A migration that only works on an empty database is one a re-run turns into
   * an outage, and a file that aborts halfway is worse than one that never
   * started. So: run both files again, twice over, on a database that already
   * has them — and check the thing that actually matters afterwards, which is
   * that the park's list says what it said. A re-run that doubled Blu's
   * checklist would pass a "no error" test and still be wrong.
   */
  it('running both files again changes nothing, and does not line the park twice', async () => {
    const f = await seedPark('Mountain View RV Park')
    await oldTask(f.landlordId, { title: 'Fix the meters on row C' })

    // Twice, not once: the first pass is the ordinary re-run and the second is
    // the one that catches a file that only survives being re-run once.
    for (let pass = 1; pass <= 2; pass++) {
      await db.query(migration(BUILDS_THE_LIST))
      // The fold runs off the end of this file, so this is the hand re-run.
      await db.query(migration(FOLDS_THE_OLD_ONE))
    }

    // ONE line, not four. Three folds ran (one here per pass, after the first)
    // and the line it had already made is the line it still has.
    const live = (await parkList(f.token, f.propertyId)).body.data
    expect(live.map((i: any) => i.body)).toEqual(['Fix the meters on row C'])
    expect(await fold()).toEqual({ folded: 0, left_alone: 0 })

    // And the old row still points at that one line.
    const [old] = await query<any>(`SELECT * FROM daily_tasks`)
    expect(old.folded_into_property_task_id).toBe(live[0].id)
    expect(old.fold_note).toBeNull()
  })

  it('leaves the shape it made: each column once, each key under its own name', async () => {
    await db.query(migration(BUILDS_THE_LIST))
    await db.query(migration(FOLDS_THE_OLD_ONE))

    const cols = await query<any>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'daily_tasks'
          AND column_name IN ('folded_into_property_task_id', 'fold_note')
        ORDER BY column_name`)
    expect(cols).toEqual([
      { column_name: 'fold_note', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'folded_into_property_task_id', data_type: 'uuid', is_nullable: 'YES' },
    ])

    // Dropping a key by name and adding it back is what makes the second pass a
    // no-op; the failure that would hide behind that is a SECOND key under a
    // name Postgres invented, which is a constraint nobody can drop by name
    // again. One key, the name the file gave it.
    const pointerKeys = await query<any>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.daily_tasks'::regclass AND contype = 'f'
          AND confrelid = 'public.property_task_list_items'::regclass
        ORDER BY conname`)
    expect(pointerKeys.map((r: any) => r.conname))
      .toEqual(['daily_tasks_folded_into_property_task_id_fkey'])

    const parkListKeys = await query<any>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.property_task_list_items'::regclass AND contype = 'f'
        ORDER BY conname`)
    expect(parkListKeys.map((r: any) => r.conname)).toEqual([
      'property_task_list_items_added_by_user_id_fkey',
      'property_task_list_items_done_by_user_id_fkey',
      'property_task_list_items_hidden_by_user_id_fkey',
      'property_task_list_items_property_id_fkey',
    ])
  })
})
