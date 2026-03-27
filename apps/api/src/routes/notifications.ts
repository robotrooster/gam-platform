import { Router } from 'express'
import { query, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { sendBulkNotification } from '../services/notifications'

export const notificationsRouter = Router()
notificationsRouter.use(requireAuth)

// GET /api/notifications — get user's notifications
notificationsRouter.get('/', async (req, res, next) => {
  try {
    const limit  = parseInt(req.query.limit as string) || 20
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
notificationsRouter.patch('/preferences', async (req, res, next) => {
  try {
    const { type, emailEnabled, smsEnabled, inAppEnabled } = req.body
    await query(`INSERT INTO notification_preferences (user_id,type,email_enabled,sms_enabled,in_app_enabled)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (user_id,type) DO UPDATE SET email_enabled=$3,sms_enabled=$4,in_app_enabled=$5`,
      [req.user!.userId, type, emailEnabled, smsEnabled, inAppEnabled])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// POST /api/notifications/bulk — landlord sends bulk message
notificationsRouter.post('/bulk', requireLandlord, async (req, res, next) => {
  try {
    const { title, body, propertyId, sendEmail, sendSMS } = req.body
    if (!title || !body) return res.status(400).json({ success: false, error: 'title and body required' })
    const result = await sendBulkNotification({
      landlordId: req.user!.profileId, propertyId, title, body, sendEmail, sendSMS
    })
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})
