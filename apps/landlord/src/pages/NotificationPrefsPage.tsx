import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Bell, MailX } from 'lucide-react'
import { api, apiGet } from '../lib/api'
import { useAuth } from '../context/AuthContext'

const LANDLORD_NOTIFICATION_TYPES: { type: string; label: string }[] = [
  { type: 'rent_collected',                label: 'Rent collected' },
  { type: 'rent_failed',                   label: 'Rent failed' },
  { type: 'ach_retry_scheduled',           label: 'ACH retry scheduled' },
  { type: 'ach_retries_exhausted',         label: 'ACH retries exhausted' },
  { type: 'disbursement_sent',             label: 'Disbursement sent' },
  { type: 'maintenance_submitted',         label: 'New maintenance request' },
  { type: 'inspection_tenant_signed',      label: 'Tenant signed inspection' },
  { type: 'inspection_finalized',          label: 'Inspection finalized' },
  { type: 'inspection_scheduled_reminder', label: 'Inspection scheduled reminder' },
  { type: 'entry_request_responded',       label: 'Tenant responded to entry request' },
  { type: 'lease_expiring',                label: 'Lease expiring' },
  { type: 'low_stock',                     label: 'Low POS stock' },
  { type: 'tenant_invite_accepted',        label: 'Tenant accepted invite' },
]

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

export function NotificationPrefsPage() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const { data: prefs = [], isLoading } = useQuery<any[]>('notification-prefs', () =>
    apiGet<any[]>('/notifications/preferences'),
  )
  const prefMap = new Map<string, any>()
  for (const p of (prefs as any[])) prefMap.set(p.type, p)

  const update = useMutation(
    (body: { type: string; emailEnabled: boolean; smsEnabled: boolean; inAppEnabled: boolean }) =>
      api.patch('/notifications/preferences', body).then(r => r.data),
    { onSuccess: () => qc.invalidateQueries('notification-prefs') },
  )

  const toggle = (type: string, channel: 'email' | 'sms', currentVal: boolean) => {
    const current = prefMap.get(type) || { emailEnabled: true, smsEnabled: false, inAppEnabled: true }
    update.mutate({
      type,
      emailEnabled: channel === 'email' ? !currentVal : current.emailEnabled,
      smsEnabled:   channel === 'sms'   ? !currentVal : current.smsEnabled,
      inAppEnabled: current.inAppEnabled,
    })
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Bell size={22} /> Notification Preferences
          </h1>
          <div className="page-sub">Choose how GAM contacts you for each event type</div>
        </div>
      </div>

      <div className="card" style={{ padding: 12, marginBottom: 16, fontSize: '.82rem', color: 'var(--text-2)' }}>
        In-app notifications always show in your dashboard. Email and SMS
        are optional channels per type. Defaults: email on, SMS off.
      </div>

      <div className="card" style={{ padding: 0 }}>
        {isLoading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>
        ) : (
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Notification</th>
                <th style={{ textAlign: 'center' }}>Email</th>
                <th style={{ textAlign: 'center' }}>SMS</th>
              </tr>
            </thead>
            <tbody>
              {LANDLORD_NOTIFICATION_TYPES.map(({ type, label }) => {
                const p = prefMap.get(type) || { emailEnabled: true, smsEnabled: false }
                return (
                  <tr key={type}>
                    <td><strong>{label}</strong></td>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" checked={p.emailEnabled} onChange={() => toggle(type, 'email', p.emailEnabled)} />
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" checked={p.smsEnabled} onChange={() => toggle(type, 'sms', p.smsEnabled)} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* S168: surface failed email sends from email_send_log so landlords
            see when GAM tried to email a tenant/staff and the send didn't
            land. Endpoint is requireLandlord; PMs don't see this. Failures
            are scoped per-landlord by senders that thread landlord_id ctx
            (see services/email.ts — most senders do). */}
      {user?.role === 'landlord' && <EmailFailuresCard />}
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
                  <td style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>{r.category || '—'}</td>
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
