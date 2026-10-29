/**
 * 10/20 (Nic, relaying Blu) — THE PROPERTY TASK LIST.
 *
 *   "He wants to have a list that the maintenance person can consult and check
 *    off when it's done, kind of running in parallel to maintenance, sitting
 *    outside of it though... It's just like a task list of, hey, you know, fix
 *    these meters and do these things. It's stuff assigned by the landlord
 *    himself, not necessarily requests coming from the tenant, or work orders or
 *    whatever."
 *
 * Nic put it per-property, on the property page. So every function here takes a
 * property and never reaches past it.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT HAVE, because the absences ARE the
 * feature and the next session will be tempted to add every one of them:
 *
 *   no status           — a line is typed or ticked. There is no third state.
 *   no priority         — the landlord orders the list by typing it in order.
 *   no assignment       — the list belongs to the park, not to a person. Whoever
 *                         is there does the next line.
 *   no due date         — nothing here is late, because nothing here is tracked.
 *   no duration, ever   — Nic: "it's not counting how long it takes to get
 *                         closed after it's been open". created_at and done_at
 *                         both exist, and nothing subtracts one from the other.
 *                         If a report ever wants that figure, the answer is no.
 *   no notification     — see below.
 *
 * NOTHING IS NOTIFIED. A list nobody is paged about is the appeal: Blu's
 * complaint was the ceremony of filing a maintenance request for "fix these
 * meters", and an email per line would be the same ceremony wearing a different
 * hat. "One email per thing" points the same way — if a notice is ever wanted
 * it is one digest per property, not one per task, and that is Nic's call to
 * make rather than a default to inherit.
 *
 * A TICK IS KEPT, NOT COUNTED. done_at and done_by_user_id say who was there
 * and when, for good: GAM never erases. The first tick wins — ticking an
 * already-ticked line changes nothing rather than rewriting the name of whoever
 * actually did the work.
 */
import { query, queryOne } from '../db'
import type { PropertyListKind } from '@gam/shared'

export interface PropertyTaskListItem {
  id: string
  property_id: string
  body: string
  created_at: string
  added_by_user_id: string
  added_by_name: string | null
  done_at: string | null
  done_by_user_id: string | null
  done_by_name: string | null
  /** 10/21: set when the landlord took it off the list. The row never leaves. */
  hidden_at: string | null
  /** 'job' — the owner's task list. 'supply' — things to buy (10/21). */
  kind: PropertyListKind
  /**
   * 10/21: this line is the CALLER's own. A supply line is a request, so
   * whoever made it may take their own back while it is unbought — and the
   * screen should not have to know who is looking to work that out. The server
   * knows; it says so here.
   */
  mine?: boolean
}

/**
 * A row plus the property it is on — what the worker's cross-property read
 * needs — and, for the owner's shopping view, the COMPANY that would buy it
 * (10/21: one order, one set of books, per entity).
 */
export interface PropertyTaskListItemWithProperty extends PropertyTaskListItem {
  property_name: string
  landlord_id?: string
  entity_name?: string | null
}

const PERSON = (alias: string) =>
  `NULLIF(btrim(COALESCE(${alias}.first_name, '') || ' ' || COALESCE(${alias}.last_name, '')), '')`

/** What the company is called — its own name, else the person behind it. */
const ENTITY = `COALESCE(NULLIF(btrim(el.business_name), ''), ${PERSON('eu')})`

const COLUMNS = `
         i.id, i.property_id, i.body, i.created_at,
         i.added_by_user_id, ${PERSON('a')} AS added_by_name,
         i.done_at, i.done_by_user_id, ${PERSON('d')} AS done_by_name,
         i.hidden_at, i.kind,
         (i.added_by_user_id = $VIEWER) AS mine`

const FROM = `
    FROM property_task_list_items i
    JOIN users a ON a.id = i.added_by_user_id
    LEFT JOIN users d ON d.id = i.done_by_user_id`

// Open lines first, each group in the order the landlord typed them. A
// checklist is read top to bottom; what is left to do belongs at the top.
const ORDER = `ORDER BY (i.done_at IS NOT NULL), i.created_at, i.id`

/**
 * One park's list. Hidden lines are left out of the read and left in the table
 * — the landlord took them off the list, which is not the same as them never
 * having been there.
 *
 * 10/21 (Nic, after losing one to a stray click): `withHidden` returns them as
 * well, flagged, so the owner can read what they took off and put it back. The
 * worker's read never asks for it — a line somebody removed is not a job.
 */
export async function listPropertyTasks(
  propertyId: string,
  opts: { withHidden?: boolean; kind?: PropertyListKind; viewerUserId?: string | null } = {},
): Promise<PropertyTaskListItem[]> {
  return query<PropertyTaskListItem>(
    `SELECT ${COLUMNS.replace('$VIEWER', '$4')} ${FROM}
      WHERE i.property_id = $1 AND ($2::boolean OR i.hidden_at IS NULL)
        AND i.kind = $3 ${ORDER}`,
    [propertyId, opts.withHidden === true, opts.kind ?? 'job', opts.viewerUserId ?? null],
  )
}

/**
 * Every open line on the properties this caller may see, with the park's name
 * on each. This is the maintenance person's read: they work several parks and
 * want one list, so the grouping happens on screen rather than in six calls.
 *
 * Both filters are the caller's, resolved before we get here, and both are
 * `null` only for a platform admin:
 *   landlordIds — the entities whose properties this caller may read at all.
 *                 An empty array sees nothing, which is the right answer for a
 *                 role with no landlord scope.
 *   propertyIds — the worker's assigned parks (maintenance_worker_scopes).
 *                 null means every property of those entities.
 */
export async function listOpenTasksForScope(
  landlordIds: string[] | null,
  propertyIds: string[] | null,
  kind: PropertyListKind = 'job',
  viewerUserId: string | null = null,
): Promise<PropertyTaskListItemWithProperty[]> {
  return query<PropertyTaskListItemWithProperty>(
    `SELECT ${COLUMNS.replace('$VIEWER', '$4')}, p.name AS property_name,
            p.landlord_id, ${ENTITY} AS entity_name
       ${FROM}
       JOIN properties p ON p.id = i.property_id
       LEFT JOIN landlords el ON el.id = p.landlord_id
       LEFT JOIN users eu ON eu.id = el.user_id
      WHERE i.hidden_at IS NULL
        AND i.done_at IS NULL
        AND i.kind = $3
        AND ($1::uuid[] IS NULL OR p.landlord_id = ANY($1))
        AND ($2::uuid[] IS NULL OR i.property_id = ANY($2))
      -- 10/21 (Nic): the shopping view groups by COMPANY, because an order and
      -- its bookkeeping are the company's — "if I'm buying a doorknob for this
      -- single family house and a new window for this other single family
      -- house, if it's at the same LLC, it's going to be under the same
      -- bookkeeping." The property is still on every line: that is the delivery
      -- address and the house the doorknob is for.
      ORDER BY entity_name NULLS LAST, p.landlord_id, p.name, i.created_at, i.id`,
    [landlordIds, propertyIds, kind, viewerUserId],
  )
}

/** A new line on this park's list, in the landlord's words. */
export async function addPropertyTask(
  propertyId: string,
  body: string,
  addedByUserId: string,
  kind: PropertyListKind = 'job',
): Promise<PropertyTaskListItem> {
  const { id } = (await queryOne<{ id: string }>(
    `INSERT INTO property_task_list_items (property_id, body, added_by_user_id, kind)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [propertyId, body, addedByUserId, kind],
  ))!
  return (await getPropertyTask(propertyId, id))!
}

/**
 * 10/21 (Nic) — "we need work trade people to be able to see this task list in
 * the system."
 *
 * A work-trade resident is a TENANT, not staff, so neither the landlord-resource
 * check nor the worker scope tables admit them — they were getting a flat 404.
 * Their claim is their own agreement: a live one on a unit at THIS property.
 *
 * Live includes PAUSED, the same rule that decides whether they get the Work
 * Trade page at all (routes/tenants work-trade, 10/19: Nic chose to show a
 * paused agreement). A snowbird whose hours are paused while they are away must
 * not be locked out of the list the day they drive back in. An ENDED agreement
 * is nothing: their hours were billed when it ended.
 *
 * A resident with no work-trade agreement sees nothing, which is the point —
 * "get apartment 4 listed" is not a renter's business.
 */
export async function worksHereOnTrade(userId: string, propertyId: string): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `SELECT TRUE AS ok
       FROM work_trade_agreements w
       JOIN units u ON u.id = w.unit_id
       JOIN tenants t ON t.id = w.tenant_id
      WHERE u.property_id = $2 AND t.user_id = $1
        AND w.status IN ('active', 'paused')
        AND (w.end_date IS NULL OR w.end_date >= CURRENT_DATE)
      LIMIT 1`,
    [userId, propertyId],
  )
  return row?.ok === true
}

/**
 * Tick a line off.
 *
 * The property id is in the WHERE rather than trusted from the caller's earlier
 * check: an item id is a body-supplied reference, and a line belonging to
 * another park must not be reachable by naming a park you do have.
 *
 * Returns the row either way, so a second tap on a phone is a no-op rather than
 * a 404 — and the first ticker's name survives it. Returns null only when no
 * such line exists on this property.
 */
export async function tickPropertyTask(
  propertyId: string,
  itemId: string,
  userId: string,
): Promise<PropertyTaskListItem | null> {
  await query(
    `UPDATE property_task_list_items
        SET done_at = NOW(), done_by_user_id = $3
      WHERE id = $1 AND property_id = $2 AND hidden_at IS NULL AND done_at IS NULL`,
    [itemId, propertyId, userId],
  )
  return getPropertyTask(propertyId, itemId)
}

/**
 * 10/21 (Nic) — UN-TICK IT.
 *
 *   "I clicked on it and it highlighted and I couldn't unclick it."
 *
 * Ticking was deliberately one-way so that a second tap from a worker's phone
 * could not rewrite the name of whoever actually did the work. That reasoning
 * holds for the WORKER and was wrong for the LANDLORD, who had no way back from
 * a stray click on their own list. So the owner — and only the owner, the same
 * hand that may add and remove — can put a line back to not-done. The tick and
 * the ticker's name are cleared together, because a line that is not done was
 * not done by anybody.
 */
export async function untickPropertyTask(
  propertyId: string,
  itemId: string,
): Promise<PropertyTaskListItem | null> {
  await query(
    `UPDATE property_task_list_items
        SET done_at = NULL, done_by_user_id = NULL
      WHERE id = $1 AND property_id = $2 AND hidden_at IS NULL AND done_at IS NOT NULL`,
    [itemId, propertyId],
  )
  return getPropertyTask(propertyId, itemId)
}

/**
 * 10/21 (Nic) — PUT IT BACK ON THE LIST.
 *
 *   "I tried to X out of it and it deleted it from the list, not completed it.
 *    So whatever was there, I didn't get a chance to read it. Please revert
 *    that."
 *
 * Nothing was ever erased — the row sat there with hidden_at stamped on it —
 * but nothing on screen could bring it back, which from where he was standing
 * is the same as gone. This is the way back. Its tick, if it had one, is left
 * exactly as it was: putting a line back on the list says nothing about whether
 * the work was done.
 */
export async function unhidePropertyTask(
  propertyId: string,
  itemId: string,
): Promise<PropertyTaskListItem | null> {
  await query(
    `UPDATE property_task_list_items
        SET hidden_at = NULL, hidden_by_user_id = NULL
      WHERE id = $1 AND property_id = $2 AND hidden_at IS NOT NULL`,
    [itemId, propertyId],
  )
  return getPropertyTask(propertyId, itemId)
}

/**
 * Take a line off the list. The GAM version of deleting one: the row, its tick
 * and both names stay exactly where they are, and the read stops showing it.
 */
export async function hidePropertyTask(
  propertyId: string,
  itemId: string,
  userId: string,
): Promise<PropertyTaskListItem | null> {
  const before = await getPropertyTask(propertyId, itemId)
  if (!before) return null
  await query(
    `UPDATE property_task_list_items
        SET hidden_at = NOW(), hidden_by_user_id = $3
      WHERE id = $1 AND property_id = $2 AND hidden_at IS NULL`,
    [itemId, propertyId, userId],
  )
  return before
}

/** One line, scoped to its park. Hidden lines included — callers decide. */
export async function getPropertyTask(
  propertyId: string,
  itemId: string,
): Promise<PropertyTaskListItem | null> {
  return (await queryOne<PropertyTaskListItem>(
    `SELECT ${COLUMNS.replace('$VIEWER', 'NULL')} ${FROM} WHERE i.id = $1 AND i.property_id = $2`,
    [itemId, propertyId],
  )) ?? null
}
