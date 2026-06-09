import { query, queryOne } from '../db'
import { sendNotificationEmail } from './email'
import { logger } from '../lib/logger'

// S132: admin notification surface. Replaces console.error for the
// admin-relevant alert sites (ACH retry confirm failures, allocation
// engine breaks, post-commit pm_transfer failures, lease build
// failures from e-sign). In-app row always; email to super_admins
// fires on critical only.

export type AdminNotificationSeverity = 'info' | 'warn' | 'critical'

export interface CreateAdminNotificationOpts {
  severity: AdminNotificationSeverity
  category: string
  title:    string
  body?:    string
  context?: Record<string, unknown>
  /**
   * S298: force the super_admin email path even for non-critical
   * notifications. Used by csv-import-review pending notifications
   * (severity='info' but operationally need super_admin to see
   * promptly because the review queue is otherwise pull-only).
   * Default false preserves the prior critical-only email gate
   * for system-failure notifications.
   */
  emailSuperAdmins?: boolean
  /**
   * S316: optional deep link rendered as a call-to-action button
   * in the email body. Skipped if missing. Url should be absolute
   * (callers pass `${ADMIN_APP_URL}/path` so the link is clickable
   * from any mail client).
   */
  action?: { label: string; url: string }
}

/**
 * Insert one row in admin_notifications and (for critical) email all
 * super_admins. Best-effort: a failure inside the helper logs but
 * never throws — admin-alert plumbing must not break the caller's
 * primary flow.
 */
export async function createAdminNotification(opts: CreateAdminNotificationOpts): Promise<void> {
  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO admin_notifications (severity, category, title, body, context)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [opts.severity, opts.category, opts.title, opts.body ?? null,
       opts.context ? JSON.stringify(opts.context) : null]
    )

    if ((opts.severity === 'critical' || opts.emailSuperAdmins) && row) {
      const admins = await query<{ email: string; id: string }>(
        `SELECT id, email FROM users WHERE role = 'super_admin' AND email IS NOT NULL`
      )
      const subject = `[GAM ADMIN ${opts.severity.toUpperCase()}] ${opts.title}`
      const html = renderAdminEmailHtml(opts)
      for (const a of admins) {
        await sendNotificationEmail({
          to:               a.email,
          subject,
          html,
          notificationType: `admin_${opts.category}`,
          userId:           a.id,
          notificationId:   row.id,
        }).catch(err => {
          logger.error({ err: err, ctx: a.email }, '[admin-notif] super_admin email failed for')
        })
      }
    }
  } catch (e) {
    // Never throw from here — caller's primary flow shouldn't fail
    // because the alert system did.
    logger.error({ err: e }, '[admin-notif] createAdminNotification failed:')
  }
}

function renderAdminEmailHtml(opts: CreateAdminNotificationOpts): string {
  const ctxBlock = opts.context
    ? `<pre style="background:#0a0f14;color:#e2e8f0;padding:12px;border-radius:6px;overflow:auto;font-size:.78rem">${escapeHtml(JSON.stringify(opts.context, null, 2))}</pre>`
    : ''
  const sevColor = opts.severity === 'critical' ? '#e53e3e'
                : opts.severity === 'warn'     ? '#dd6b20'
                : '#3182ce'
  // S316: render optional CTA button. Url is wrapped in escapeHtml +
  // a same-attribute quote scheme so a malformed URL can't break out
  // of the href context.
  const actionBlock = opts.action
    ? `<div style="margin:16px 0 4px">
         <a href="${escapeHtml(opts.action.url)}"
            style="display:inline-block;padding:10px 18px;background:#c9a227;color:#0a0f14;font-weight:600;text-decoration:none;border-radius:6px;font-size:.85rem">
           ${escapeHtml(opts.action.label)}
         </a>
       </div>`
    : ''
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif">
    <div style="border-left:4px solid ${sevColor};padding:8px 12px;margin-bottom:16px">
      <div style="text-transform:uppercase;font-size:.72rem;letter-spacing:.08em;color:${sevColor};font-weight:700">${opts.severity}</div>
      <div style="font-size:1.1rem;font-weight:600;color:#1a202c">${escapeHtml(opts.title)}</div>
      <div style="color:#4a5568;font-size:.85rem;margin-top:4px">${escapeHtml(opts.category)}</div>
    </div>
    ${opts.body ? `<p style="color:#2d3748;line-height:1.5">${escapeHtml(opts.body)}</p>` : ''}
    ${actionBlock}
    ${ctxBlock}
  </div>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
