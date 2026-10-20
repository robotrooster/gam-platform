import { useQuery } from 'react-query'
import { MailX } from 'lucide-react'
import { emailCategoryLabel } from '@gam/shared'
import { api, apiGet } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { usePerms } from '../lib/permissions'
import { NotificationPreferences } from '../../../../packages/shared-ui/NotificationPreferences'

interface EmailFailureRow {
  id: string
  toEmail: string
  subject: string
  category: string | null
  errorMessage: string | null
  relatedEntityType: string | null
  relatedEntityId: string | null
  metadata: any
  createdAt: string
}

/**
 * W-53 (S531): merged into Settings as a section — the standalone nav item and
 * page are gone; /notification-prefs redirects to /settings.
 *
 * 10/20 (Nic): the list itself is no longer written here. It used to be sixteen
 * hand-typed rows, which is how a landlord came to be looking at a page that
 * was missing twenty-two of the types GAM actually sends him — and showing two
 * ('Rent failed', 'Disbursement sent') that nothing has ever sent. Every row now
 * comes from the one notification catalog in @gam/shared, through the same
 * component the tenant portal renders.
 */
export function NotificationPrefsSection() {
  const { user } = useAuth()
  const { can } = usePerms()

  return (
    <div>
      <NotificationPreferences
        audience="landlord"
        title="Notification Preferences"
        api={{
          get:   (url) => apiGet<any[]>(url),
          patch: (url, body) => api.patch(url, body).then(r => r.data),
        }}
        // A team member has no birthday on file and is never emailed one, so
        // they are not shown a switch that would do nothing.
        isAccountHolder={user?.role === 'landlord'}
      />

      {/* S168: surface failed email sends from email_send_log so landlords
            see when GAM tried to email a tenant/staff and the send didn't
            land. Endpoint is requireLandlord; PMs don't see this. Failures
            are scoped per-landlord by senders that thread landlord_id ctx
            (see services/email.ts — most senders do). */}
      {user?.role === 'landlord' && can('notification_prefs.email_failures') && <EmailFailuresCard />}
    </div>
  )
}

function EmailFailuresCard() {
  const { data, isLoading } = useQuery<{ rows: EmailFailureRow[]; sinceDays: number; limit: number }>(
    'email-failures',
    () => apiGet('/landlords/me/email-failures?since_days=30&limit=50'),
    { staleTime: 60_000 },
  )
  const rows = data?.rows ?? []

  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '1rem', marginBottom: 6 }}>
        <MailX size={18} /> Email Delivery Issues
      </h2>
      <div className="card" style={{ padding: 12, marginBottom: 10, fontSize: '.78rem', color: 'var(--text-3)' }}>
        Last 30 days of email sends that failed (rejected by the provider, bounced,
        or couldn't be queued). If a tenant or staff member didn't receive an
        expected email, the reason should appear here.
      </div>
      <div className="card" style={{ padding: 0 }}>
        {isLoading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: '.84rem' }}>
            No email delivery failures in the last 30 days.
          </div>
        ) : (
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>When</th>
                <th>To</th>
                <th>Subject</th>
                <th>Category</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td style={{ fontSize: '.78rem', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                    {new Date(r.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td style={{ fontSize: '.82rem' }}>{r.toEmail}</td>
                  <td style={{ fontSize: '.82rem', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.subject}
                  </td>
                  {/* 10/20: this printed the stored string — "late_payment_notice",
                      "esign_signing_reminder" — directly under eighty rows of
                      careful English (memory: gam-no-raw-enums-in-ui).
                      notificationLabel could not cover it: an email's category
                      and a notification's type are two different namespaces,
                      which is itself why they are reconciled in one place now
                      (@gam/shared emailCategories). */}
                  <td style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
                    {r.category ? emailCategoryLabel(r.category) : '—'}
                  </td>
                  <td style={{ fontSize: '.78rem', color: 'var(--red, #dc4c4c)', maxWidth: 320 }}>
                    {r.errorMessage || '(no message)'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {rows.length === (data?.limit ?? 50) && (
        <div style={{ fontSize: '.74rem', color: 'var(--text-3)', textAlign: 'right', marginTop: 6 }}>
          Showing the latest {data?.limit} failures. Older ones decay automatically.
        </div>
      )}
    </div>
  )
}
