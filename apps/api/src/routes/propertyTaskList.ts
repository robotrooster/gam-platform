/**
 * 10/20 (Nic, relaying Blu) — THE PROPERTY TASK LIST, over the wire.
 *
 * A plain checklist on one park. The landlord types lines; the maintenance
 * person reads them and ticks them off. Deliberately NOT part of maintenance:
 * see services/propertyTaskList.ts for the list of what this does not have and
 * why, and the migration for why it is not a maintenance_requests row.
 *
 * WHO MAY DO WHAT, and why each way round.
 *
 * ADDING IS THE OWNER'S. Nic, in Blu's words: "It's stuff assigned by the
 * landlord himself, not necessarily requests coming from the tenant, or work
 * orders or whatever." A list the maintenance person can also write is a list
 * of what they already planned to do, which is a diary; the point of this one is
 * that somebody else decided. So landlord / admin / super_admin add, and staff
 * do not — including a property manager, who is the closest call of the three
 * and the one most likely to want it back. (Flagged for Nic rather than
 * decided here.)
 *
 * TICKING IS THE WORKER'S, because that is the entire request. Anybody the
 * landlord has put on that property can tick: the maintenance person, the
 * on-site manager, a property manager. They are each physically at the park and
 * "fix these meters" gets done by whoever is standing there. Their reach is
 * already decided per property (maintenance_worker_scopes and friends), so
 * assertPropertyInScope is the whole gate — a worker assigned to Mountain View
 * cannot read or tick Oak Park's list.
 *
 * A TENANT CANNOT SEE THIS AT ALL. There is no tenant route here and no tenant
 * role gets past the property check; a resident's repair is a maintenance
 * request, which is the surface that exists for it.
 *
 * NOTHING HERE TOUCHES A MAINTENANCE FIGURE. No query in this file or its
 * service reads or writes maintenance_requests, and nothing reads this table
 * but the checklist. propertyTaskList.test.ts holds that true.
 */
import { Router } from 'express'
import { z } from 'zod'
import { PROPERTY_LIST_KINDS, type PropertyListKind } from '@gam/shared'
import { requireAuth, assertPropertyInScope, getScopedPropertyIds } from '../middleware/auth'
import { canAccessLandlordResource } from '../middleware/scope'
import { landlordScopeIds } from '../lib/landlordScope'
import { AppError } from '../middleware/errorHandler'
import { query, queryOne } from '../db'
import {
  listPropertyTasks,
  listOpenTasksForScope,
  addPropertyTask,
  tickPropertyTask,
  hidePropertyTask,
  getPropertyTask,
  untickPropertyTask,
  unhidePropertyTask,
  worksHereOnTrade,
} from '../services/propertyTaskList'

export const propertyTaskListRouter = Router()
propertyTaskListRouter.use(requireAuth)

const PLATFORM_ROLES = new Set(['admin', 'super_admin'])
const OWNER_ROLES = new Set(['landlord', 'admin', 'super_admin'])

const addSchema = z.object({
  // One line, the way it would be said out loud. Capped so a paste of a whole
  // document cannot become a checklist item nobody can read on a phone.
  body: z.string().trim().min(1, 'Type the task first').max(500),
  // 10/21: which of the park's two lists. Absent means the task list, so every
  // caller written before the supply list keeps working.
  kind: z.enum(PROPERTY_LIST_KINDS).optional(),
})

/** Which list a request is about: ?kind=supply, else the task list. */
function kindOf(req: any): PropertyListKind {
  return req.query?.kind === 'supply' ? 'supply' : 'job'
}

/**
 * 10/21 (Nic) — WHO MAY WRITE WHICH LIST, WHICH IS INVERTED BETWEEN THEM.
 *
 *   job     "It's stuff assigned by the landlord himself" — the owner writes a
 *           line, anybody working the park ticks it off.
 *   supply  "Anybody can contribute to a list of things to purchase. The owner
 *           can consult that list when either ordering online or running to the
 *           store" — so anybody working the park writes, and the OWNER ticks it
 *           bought, because he is the one at the till.
 *
 * Everyone who gets this far has already passed reachProperty, which is what
 * "working the park" means: the owner, their staff scoped to it, or a resident
 * with a live work-trade agreement on it.
 */
function assertMayAdd(req: any, kind: PropertyListKind) {
  if (kind === 'job') assertOwner(req)
}
function assertMayTick(req: any, kind: PropertyListKind) {
  if (kind === 'supply') {
    if (!OWNER_ROLES.has(req.user?.role ?? '')) {
      throw new AppError(403, 'Only the owner marks a supply line bought — they are the one buying it')
    }
  }
}

/**
 * Can this caller touch this park's list at all, and does the park exist?
 *
 * Another landlord's property answers 404, not 403. One landlord must never
 * learn what exists at another landlord's property, and "Forbidden" on a
 * guessed id confirms the id is real.
 */
async function reachProperty(req: any, propertyId: string) {
  const p = await queryOne<{ id: string; landlord_id: string; name: string }>(
    `SELECT id, landlord_id, name FROM properties WHERE id = $1`, [propertyId])
  if (!p) throw new AppError(404, 'Property not found')
  // 10/21 (Nic): "we need work trade people to be able to see this task list in
  // the system." A work-trade resident is a TENANT, so neither the
  // landlord-resource check below nor the staff scope tables let them past —
  // they were getting a flat 404 on the list of the jobs they are there to do.
  // Their claim is their own agreement on a unit at this park, and nothing
  // else: a resident without one still sees nothing.
  if (req.user?.role === 'tenant') {
    if (!(await worksHereOnTrade(req.user.userId, propertyId))) {
      throw new AppError(404, 'Property not found')
    }
    return p
  }
  if (!canAccessLandlordResource(req.user, p.landlord_id)) throw new AppError(404, 'Property not found')
  await assertPropertyInScope(req.user, propertyId)
  return p
}

/** The landlord's own press. Staff tick lines; they do not write them. */
function assertOwner(req: any) {
  if (!OWNER_ROLES.has(req.user?.role)) {
    throw new AppError(403, 'Only the property owner can change this list')
  }
}

/**
 * GET /api/property-task-list — every open line on the parks this caller may
 * see, the park's name on each. The maintenance person's one screen: they work
 * several parks and should not have to open each in turn.
 */
propertyTaskListRouter.get('/', async (req, res, next) => {
  try {
    // A platform admin reads across entities; everybody else is held to their
    // own. An empty landlord scope means an empty list, which is the right
    // answer for a role that has no landlord at all.
    const landlordIds = PLATFORM_ROLES.has(req.user!.role) ? null : landlordScopeIds(req.user!)
    const propertyIds = await getScopedPropertyIds(req.user)
    // 10/21: ?kind=supply is the owner's shopping view — every park's open
    // supply lines at once, each carrying its property and its company, so one
    // order covers one company's houses and never two companies' at a time.
    res.json({
      success: true,
      data: await listOpenTasksForScope(landlordIds, propertyIds, kindOf(req), req.user!.userId),
    })
  } catch (e) { next(e) }
})

/**
 * GET /api/property-task-list/my-parks — the parks this person may write a
 * line for, whether or not either list has anything on it yet.
 *
 * 10/21 (Nic): the maintenance person is the whole reason the supply list
 * exists — "a collected shopping cart pool... so he doesn't have text messages
 * from like 5 or 6 different people" — and their screen could only ever show
 * parks that ALREADY had a line on them. Which means the first thing that ran
 * out at a quiet park could never be written down, because the park was not on
 * the screen to write it against. A list you cannot start is not a list.
 *
 * Read-only, and it widens nothing: the same scope the cross-park list uses,
 * so it names exactly the parks whose lines this person can already see.
 *
 * DECLARED BEFORE /:propertyId, or Express reads "my-parks" as a property id.
 */
propertyTaskListRouter.get('/my-parks', async (req, res, next) => {
  try {
    const landlordIds = PLATFORM_ROLES.has(req.user!.role) ? null : landlordScopeIds(req.user!)
    const propertyIds = await getScopedPropertyIds(req.user)
    if (landlordIds && landlordIds.length === 0) return res.json({ success: true, data: [] })
    if (propertyIds && propertyIds.length === 0) return res.json({ success: true, data: [] })
    const rows = await query<{ property_id: string; property_name: string }>(
      `SELECT p.id AS property_id, p.name AS property_name
         FROM properties p
        WHERE ($1::uuid[] IS NULL OR p.landlord_id = ANY($1))
          AND ($2::uuid[] IS NULL OR p.id = ANY($2))
        ORDER BY p.name`,
      [landlordIds, propertyIds])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

/**
 * GET /api/property-task-list/:propertyId — this park's list, open lines first.
 *
 * `?withHidden=1` adds the lines that were taken off the list, flagged, so they
 * can be read and put back — 10/21, after a stray X took one off and nothing on
 * screen could bring it back. The OWNER's only: a line somebody removed is not
 * a job, and a worker's screen must not grow a pile of them.
 */
propertyTaskListRouter.get('/:propertyId', async (req, res, next) => {
  try {
    await reachProperty(req, req.params.propertyId)
    const asked = req.query.withHidden === '1' || req.query.withHidden === 'true'
    const withHidden = asked && OWNER_ROLES.has(req.user?.role ?? '')
    res.json({
      success: true,
      data: await listPropertyTasks(req.params.propertyId, {
        withHidden, kind: kindOf(req), viewerUserId: req.user!.userId,
      }),
    })
  } catch (e) { next(e) }
})

/**
 * POST /api/property-task-list/:propertyId — add a line.
 *
 * One line per call on purpose: the screen types a line, presses enter, and
 * types the next one. Nic asked for "something smooth", and smooth is no modal
 * between the landlord and the next task.
 */
propertyTaskListRouter.post('/:propertyId', async (req, res, next) => {
  try {
    await reachProperty(req, req.params.propertyId)
    const parsed = addSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message || 'Type the task first')
    }
    const kind = parsed.data.kind ?? 'job'
    assertMayAdd(req, kind)
    const item = await addPropertyTask(req.params.propertyId, parsed.data.body, req.user!.userId, kind)
    res.json({ success: true, data: item })
  } catch (e) { next(e) }
})

/**
 * POST /api/property-task-list/:propertyId/items/:itemId/done — tick it off.
 *
 * The worker's press, and the only write they have. Ticking an already-ticked
 * line changes nothing and still answers 200: a second tap on a phone is not an
 * error, and it must not rewrite the name of whoever actually did the work.
 */
propertyTaskListRouter.post('/:propertyId/items/:itemId/done', async (req, res, next) => {
  try {
    await reachProperty(req, req.params.propertyId)
    // The line decides who may tick it: a job is the worker's press, a supply
    // line is the owner saying they bought it.
    const existing = await getPropertyTask(req.params.propertyId, req.params.itemId)
    if (!existing) throw new AppError(404, 'That task is not on this property\'s list')
    assertMayTick(req, existing.kind)
    const item = await tickPropertyTask(req.params.propertyId, req.params.itemId, req.user!.userId)
    if (!item) throw new AppError(404, 'That task is not on this property\'s list')
    res.json({ success: true, data: item })
  } catch (e) { next(e) }
})

/**
 * POST /api/property-task-list/:propertyId/items/:itemId/undone — un-tick it.
 *
 * 10/21 (Nic): "I clicked on it and it highlighted and I couldn't unclick it."
 * The owner's, like adding and removing — never the worker's, because the
 * one-way tick is what stops a second tap on a phone rewriting the name of
 * whoever did the work. Un-ticking an open line changes nothing and answers 200.
 */
propertyTaskListRouter.post('/:propertyId/items/:itemId/undone', async (req, res, next) => {
  try {
    await reachProperty(req, req.params.propertyId)
    assertOwner(req)
    const item = await untickPropertyTask(req.params.propertyId, req.params.itemId)
    if (!item) throw new AppError(404, 'That task is not on this property\'s list')
    res.json({ success: true, data: item })
  } catch (e) { next(e) }
})

/**
 * POST /api/property-task-list/:propertyId/items/:itemId/unhide — put it back.
 *
 * 10/21 (Nic): "I tried to X out of it and it deleted it from the list, not
 * completed it… Please revert that." The row was never erased; there was just
 * no way back on screen. This is it, and it leaves the tick as it was.
 */
propertyTaskListRouter.post('/:propertyId/items/:itemId/unhide', async (req, res, next) => {
  try {
    await reachProperty(req, req.params.propertyId)
    assertOwner(req)
    const item = await unhidePropertyTask(req.params.propertyId, req.params.itemId)
    if (!item) throw new AppError(404, 'That task is not on this property\'s list')
    res.json({ success: true, data: item })
  } catch (e) { next(e) }
})

/**
 * POST /api/property-task-list/:propertyId/items/:itemId/hide — take it off the
 * list. The landlord's, not the worker's: a line the maintenance person could
 * make disappear is a line that never has to be done.
 *
 * GAM never erases. The row and its history stay; the list stops showing it.
 */
propertyTaskListRouter.post('/:propertyId/items/:itemId/hide', async (req, res, next) => {
  try {
    await reachProperty(req, req.params.propertyId)
    const existing = await getPropertyTask(req.params.propertyId, req.params.itemId)
    if (!existing) throw new AppError(404, 'That task is not on this property\'s list')
    // 10/21: a job line is the owner's to remove, as it always was. A SUPPLY
    // line is a request somebody made, so they may also take their OWN back
    // while it is still unbought — "we need trash bags" typed twice should not
    // need the owner to tidy up. Somebody else's request is never theirs to
    // cancel.
    const ownRequest = existing.kind === 'supply'
      && existing.added_by_user_id === req.user!.userId
      && !existing.done_at
    if (!ownRequest) assertOwner(req)
    await hidePropertyTask(req.params.propertyId, req.params.itemId, req.user!.userId)
    res.json({ success: true, data: { id: existing.id, hidden: true } })
  } catch (e) { next(e) }
})
