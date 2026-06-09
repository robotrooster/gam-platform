import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Bell, CheckCheck, ExternalLink } from 'lucide-react'
import { apiGet, apiPatch } from '../lib/api'

type Notification = {
  id: string
  type: string
  title: string
  body: string
  read: boolean
  readAt: string | null
  // `data` is a JSONB passthrough — content keys stay snake_case
  // (e.g., n.data.inspection_id, n.data.entry_request_id).
  data: Record<string, any> | null
  createdAt: string
  emailSent: boolean
  emailSentAt: string | null
  smsSent: boolean
  smsSentAt: string | null
}

const TYPE_LABEL: Record<string, string> = {
  rent_collected:                'Rent collected',
  rent_failed:                   'Rent failed',
  ach_retry_scheduled:           'ACH retry scheduled',
  ach_retries_exhausted:         'ACH retries exhausted',
  disbursement_sent:             'Disbursement sent',
  maintenance_submitted:         'Maintenance request',
  inspection_tenant_signed:      'Tenant signed inspection',
  inspection_finalized:          'Inspection finalized',
  inspection_scheduled_reminder: 'Inspection reminder',
  entry_request_responded:       'Entry response',
  lease_expiring:                'Lease expiring',
  low_stock:                     'Low POS stock',
  tenant_invite_accepted:        'Tenant accepted invite',
  dispute_resolved:              'Dispute resolved',
}

function deepLinkFor(n: Notification): string | null {
  const d = n.data ?? {}
  if (d.inspection_id) return `/inspections/${d.inspection_id}`
  if (d.entry_request_id) return `/entry-requests/${d.entry_request_id}`
  if (d.maintenance_request_id || d.requestId) {
    return `/maintenance` // no per-request page; nav to inbox
  }
  if (d.lease_id) return '/leases'
  if (d.dispute_id) return '/screening' // landlord-side review surface
  return null
}

export function NotificationsPage() {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<'all' | 'unread'>('all')

  const { data, isLoading } = useQuery(
    'notifications-inbox',
    () => apiGet<Notification[]>('/notifications?limit=100'),
    { refetchInterval: 60000 },
  )
  const all = (data as Notification[]) || []

  const list = useMemo(
    () => (filter === 'unread' ? all.filter(n => !n.read) : all),
    [all, filter],
  )
  const unreadCount = all.filter(n => !n.read).length

  const readMut = useMutation(
    (id: string) => apiPatch(`/notifications/${id}/read`, {}),
    { onSuccess: () => qc.invalidateQueries('notifications-inbox') },
  )
  const readAllMut = useMutation(
    () => apiPatch('/notifications/read-all', {}),
    { onSuccess: () => qc.invalidateQueries('notifications-inbox') },
  )

  return (
    <div style={{ maxWidth: 880 }}>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Bell size={22} /> Notifications
            {unreadCount > 0 && (
              <span style={{ background: 'var(--red)', color: 'white', borderRadius: 10, padding: '2px 8px', fontSize: '.7rem', fontWeight: 700 }}>
                {unreadCount} unread
              </span>
            )}
          </h1>
          <div className="page-sub">Inbox of all in-app notifications across your portfolio</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className={`btn ${filter === 'all' ? 'btn-primary' : 'btn-ghost'} btn-sm`}
            onClick={() => setFilter('all')}
          >
            All
          </button>
          <button
            className={`btn ${filter === 'unread' ? 'btn-primary' : 'btn-ghost'} btn-sm`}
            onClick={() => setFilter('unread')}
          >
            Unread{unreadCount > 0 ? ` (${unreadCount})` : ''}
          </button>
          {unreadCount > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={() => readAllMut.mutate()} disabled={readAllMut.isLoading}>
              <CheckCheck size={13} /> Mark all read
            </button>
          )}
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
        ) : list.length === 0 ? (
          <div style={{ padding: 48, color: 'var(--text-3)', textAlign: 'center' }}>
            <Bell size={32} style={{ opacity: .4 }} />
            <div style={{ marginTop: 12, fontWeight: 600 }}>{filter === 'unread' ? "You're all caught up." : 'No notifications yet.'}</div>
          </div>
        ) : (
          <div>
            {list.map(n => {
              const link = deepLinkFor(n)
              return (
                <div
                  key={n.id}
                  style={{
                    padding: '14px 16px',
                    borderBottom: '1px solid var(--border-0)',
                    background: n.read ? 'transparent' : 'rgba(201,162,39,.04)',
                    display: 'flex',
                    gap: 12,
                    alignItems: 'flex-start',
                  }}
                >
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: n.read ? 'var(--text-3)' : 'var(--gold)', marginTop: 6, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                      <strong style={{ color: 'var(--text-0)' }}>{n.title}</strong>
                      <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{new Date(n.createdAt).toLocaleString()}</span>
                      <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>· {TYPE_LABEL[n.type] || n.type.replace(/_/g, ' ')}</span>
                    </div>
                    <div style={{ fontSize: '.85rem', color: 'var(--text-2)', lineHeight: 1.45 }}>{n.body}</div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                      {n.emailSent && <span className="badge badge-muted" style={{ fontSize: '.65rem' }}>email sent</span>}
                      {n.smsSent && <span className="badge badge-muted" style={{ fontSize: '.65rem' }}>sms sent</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
                    {link && (
                      <a href={link} className="btn btn-ghost btn-sm" style={{ padding: '4px 8px' }}>
                        Open <ExternalLink size={11} />
                      </a>
                    )}
                    {!n.read && (
                      <button className="btn btn-ghost btn-sm" onClick={() => readMut.mutate(n.id)} style={{ padding: '4px 8px' }}>
                        Mark read
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
