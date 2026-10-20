import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { sendBulkNotification } from '../services/notifications'
import { landlordIdForProperty, landlordScopeIds } from '../lib/landlordScope'
import { AppError } from '../middleware/errorHandler'
import { isKnownNotificationType, isCriticalNotificationType } from '@gam/shared'

export const notificationsRouter = Router()
notificationsRouter.use(requireAuth)

// GET /api/notifications — get user's notifications
notificationsRouter.get('/', async (req, res, next) => {
  try {
    // S409 (S402 finding): pre-fix used `parseInt(limit) || 20` which
    // accepted negative values (LIMIT -1 → 500 from postgres 22023)
    // and unbounded positives (?limit=999999 → potential heap blow-up
    // on huge notification tables). Clamp to [1, 200]. Self-DoS only
    // since the query is caller-scoped, but no reason to leave the
    // edge cases sharp.
    const rawLimit = parseInt(req.query.limit as string)
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 200)
      : 20
    const unread = req.query.unread === 'true'
    const notes  = await query<any>(`
      SELECT * FROM notifications
      WHERE user_id = $1
      ${unread ? 'AND read = FALSE' : ''}
      ORDER BY created_at DESC LIMIT $2`,
      [req.user!.userId, limit])
    const unreadCount = await queryOne<any>(
      'SELECT COUNT(*)::int as count FROM notifications WHERE user_id=$1 AND read=FALSE',
      [req.user!.userId])
    res.json({ success: true, data: notes, unreadCount: unreadCount?.count || 0 })
  } catch (e) { next(e) }
})

// PATCH /api/notifications/:id/read
notificationsRouter.patch('/:id/read', async (req, res, next) => {
  try {
    await query('UPDATE notifications SET read=TRUE,read_at=NOW() WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user!.userId])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// PATCH /api/notifications/read-all
notificationsRouter.patch('/read-all', async (req, res, next) => {
  try {
    await query('UPDATE notifications SET read=TRUE,read_at=NOW() WHERE user_id=$1 AND read=FALSE',
      [req.user!.userId])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// GET /api/notifications/preferences
notificationsRouter.get('/preferences', async (req, res, next) => {
  try {
    const prefs = await query<any>('SELECT * FROM notification_preferences WHERE user_id=$1', [req.user!.userId])
    res.json({ success: true, data: prefs })
  } catch (e) { next(e) }
})

// PATCH /api/notifications/preferences
//
// S409 (S402 finding): pre-fix had no validation on body at all — type could be
// any string of any length. The note then said an allow-list would be brittle
// because the type list was hand-kept and growing.
//
// 10/20: there IS one list now (@gam/shared notificationCatalog), the compiler
// enforces it on the send side, and so this route checks against it. A type
// nobody can send is a row nobody can act on.
const prefUpdateSchema = z.object({
  type:          z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'type must be snake_case, ≤64 chars'),
  emailEnabled:  z.boolean(),
  inAppEnabled:  z.boolean(),
})
// One answer, or the whole page's worth at once. "Turn every optional email
// off" has to record an answer for all 100-plus types, and 100-plus round trips
// is how half of them end up unanswered.
const prefsPatchSchema = z.union([
  prefUpdateSchema,
  z.object({ updates: z.array(prefUpdateSchema).min(1).max(300) }),
])
notificationsRouter.patch('/preferences', async (req, res, next) => {
  try {
    const parsed  = prefsPatchSchema.parse(req.body)
    const updates = 'updates' in parsed ? parsed.updates : [parsed]

    const unknown = updates.map(u => u.type).filter(t => !isKnownNotificationType(t))
    if (unknown.length) {
      throw new AppError(400, `GAM does not send: ${[...new Set(unknown)].join(', ')}`)
    }

    // 10/20 (Nic): the critical ones "are the ones that they're still going to
    // get." The page shows their boxes locked, and the stored row is written to
    // match what delivery actually does — a row reading email-off for a type
    // that emails anyway is the exact lie that made a landlord think he had
    // turned something off.
    const rows = new Map<string, { email: boolean; inApp: boolean }>()
    for (const u of updates) {
      rows.set(u.type, isCriticalNotificationType(u.type)
        ? { email: true, inApp: true }
        : { email: u.emailEnabled, inApp: u.inAppEnabled })
    }
    const types = [...rows.keys()]
    await query(`
      INSERT INTO notification_preferences (user_id, type, email_enabled, in_app_enabled)
      SELECT $1, t, e, a
        FROM unnest($2::text[], $3::boolean[], $4::boolean[]) AS s(t, e, a)
      ON CONFLICT (user_id, type)
      DO UPDATE SET email_enabled  = EXCLUDED.email_enabled,
                    in_app_enabled = EXCLUDED.in_app_enabled,
                    updated_at     = NOW()`,
      [req.user!.userId, types,
       types.map(t => rows.get(t)!.email), types.map(t => rows.get(t)!.inApp)])

    res.json({
      success: true,
      data: { saved: types.length, alwaysOn: types.filter(isCriticalNotificationType) },
    })
  } catch (e) { next(e) }
})

// POST /api/notifications/bulk — landlord sends bulk message
// S129: opened to property_manager via notifications.send_bulk.
notificationsRouter.post('/bulk', requirePerm('notifications.send_bulk'), async (req, res, next) => {
  try {
    const { title, body, propertyId, sendEmail } = req.body
    if (!title || !body) return res.status(400).json({ success: false, error: 'title and body required' })
    if (propertyId !== undefined && propertyId !== null && propertyId !== '' &&
        !/^[0-9a-f-]{36}$/i.test(String(propertyId))) {
      return res.status(400).json({ success: false, error: 'propertyId must be a uuid' })
    }
    // S633: a blast goes to one company's residents. When a property is named,
    // that property's company IS the answer — nothing for the caller to get
    // wrong. Otherwise the account must say which, because "every tenant" at the
    // entity the session happened to sit on is the wrong set of people to
    // message, and messages cannot be unsent.
    // S654 (Nic, DIRECTIVE): no default company. A property names its company;
    // "all properties" on an account that owns several means ALL of them —
    // every company the account acts for — never the one it happened to found.
    const targets = propertyId
      ? [await landlordIdForProperty(req.user!, String(propertyId), query)]
      : landlordScopeIds(req.user!)
    if (!targets.length) throw new AppError(400, 'No landlord scope on this user')
    const results = await Promise.all(targets.map(landlordId => sendBulkNotification({
      landlordId, propertyId: propertyId || undefined, title, body, sendEmail,
    })))
    const result = results.reduce((acc: any, r: any) => {
      for (const [k, v] of Object.entries(r ?? {})) acc[k] = typeof v === 'number' ? (Number(acc[k] ?? 0) + v) : (acc[k] ?? v)
      return acc
    }, {})
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})
