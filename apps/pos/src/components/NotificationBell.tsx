import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPatch, apiPost } from '../lib/api'
import { Bell, X, Check, CheckCheck, Send } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useQuery as useAuthQuery } from 'react-query'
import { apiGet as apiGetUnits } from '../lib/api'

const TYPE_ROUTES: Record<string, string> = {
  rent_collected:           '/reports',
  rent_failed:              '/units',
  disbursement_sent:        '/reports',
  maintenance_submitted:    '/maintenance',
  maintenance_assigned:     '/maintenance',
  maintenance_updated:      '/maintenance',
  maintenance_emergency:    '/maintenance',
  maintenance_approval_required: '/maintenance',
  maintenance_pm_alert:     '/maintenance',
  maintenance_building_notice: '/maintenance',
  lease_expiring_60:        '/leases',
  lease_expiring_30:        '/leases',
  lease_renewal_survey:     '/leases',
  lease_renewal_action_required: '/leases',
  pos_low_stock:            '/inventory',
  tenant_invite_accepted:   '/tenants',
  work_trade_reminder:      '/work-trade',
  bulk_message:             '/dashboard',
}

const TYPE_ICONS: Record<string, string> = {
  rent_collected:       '💸',
  rent_failed:          '⚠️',
  payment_failed:       '⚠️',
  disbursement_sent:    '🏦',
  maintenance_submitted:'🔧',
  maintenance_updated:  '🔧',
  lease_expiring_60:    '📋',
  lease_expiring_30:    '🚨',
  pos_low_stock:        '📦',
  tenant_invite_accepted:'👤',
  work_trade_reminder:  '⚡',
  bulk_message:         '📢',
}

function timeAgo(date: string) {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds/60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds/3600)}h ago`
  return `${Math.floor(seconds/86400)}d ago`
}

export function NotificationBell() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [showBulk, setShowBulk] = useState(false)
  const [bulkForm, setBulkForm] = useState({ title:'', body:'', propertyId:'', sendEmail:true, sendSMS:false })
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  const { data, refetch } = useQuery(
    'notifications',
    () => apiGet<any>('/notifications?limit=30'),
    { refetchInterval: 30000 } // poll every 30s
  )

  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))

  const raw = data as any
  const notifications = Array.isArray(raw) ? raw : (raw?.data || [])
  const unreadCount   = raw?.unreadCount || notifications.filter((n:any) => !n.read).length

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const readMut = useMutation(
    (id: string) => apiPatch(`/notifications/${id}/read`, {}),
    { onSuccess: () => qc.invalidateQueries('notifications') }
  )

  const readAllMut = useMutation(
    () => apiPatch('/notifications/read-all', {}),
    { onSuccess: () => qc.invalidateQueries('notifications') }
  )

  const bulkMut = useMutation(
    () => apiPost('/notifications/bulk', bulkForm),
    { onSuccess: (res: any) => {
      alert(`Message sent to ${res.data?.sent} tenants.`)
      setShowBulk(false)
      setBulkForm({ title:'', body:'', propertyId:'', sendEmail:true, sendSMS:false })
    }}
  )

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {/* Bell button */}
      <button onClick={() => setOpen(v => !v)} style={{ position:'relative', background:'none', border:'none', cursor:'pointer', color:'var(--text-3)', padding:6, borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center' }}
        onMouseEnter={e => (e.currentTarget as any).style.background='var(--bg-3)'}
        onMouseLeave={e => (e.currentTarget as any).style.background='none'}>
        <Bell size={18} />
        {unreadCount > 0 && (
          <div style={{ position:'absolute', top:2, right:2, width:16, height:16, borderRadius:'50%', background:'var(--red)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'.55rem', fontWeight:800, color:'white' }}>
            {unreadCount > 9 ? '9+' : unreadCount}
          </div>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div style={{ position:'absolute', top:'calc(100% + 8px)', right:0, width:380, background:'var(--bg-1)', border:'1px solid var(--border-0)', borderRadius:12, boxShadow:'0 8px 40px rgba(0,0,0,.5)', zIndex:500, overflow:'hidden' }}>

          {/* Header */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 16px', borderBottom:'1px solid var(--border-0)' }}>
            <div style={{ fontFamily:'var(--font-display)', fontSize:'.85rem', fontWeight:700, color:'var(--text-0)' }}>
              Notifications {unreadCount > 0 && <span style={{ marginLeft:6, fontSize:'.65rem', padding:'1px 6px', background:'var(--red)', color:'white', borderRadius:10 }}>{unreadCount}</span>}
            </div>
            <div style={{ display:'flex', gap:6 }}>
              <button onClick={() => setShowBulk(v => !v)} className="btn btn-ghost btn-sm" title="Send bulk message" style={{ fontSize:'.68rem' }}>
                <Send size={12} /> Message Tenants
              </button>
              {unreadCount > 0 && (
                <button onClick={() => readAllMut.mutate()} className="btn btn-ghost btn-sm" title="Mark all read">
                  <CheckCheck size={13} />
                </button>
              )}
            </div>
          </div>

          {/* Bulk message form */}
          {showBulk && (
            <div style={{ padding:'12px 16px', borderBottom:'1px solid var(--border-0)', background:'var(--bg-2)' }}>
              <div style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', marginBottom:8, textTransform:'uppercase', letterSpacing:'.06em' }}>Send Message to Tenants</div>
              <select className="input" style={{ width:'100%', marginBottom:6, fontSize:'.75rem' }} value={bulkForm.propertyId} onChange={e => setBulkForm(f => ({...f, propertyId: e.target.value}))}>
                <option value="">All properties</option>
                {(properties as any[]).map((p:any) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <input className="input" placeholder="Subject / Title" value={bulkForm.title} onChange={e => setBulkForm(f => ({...f,title:e.target.value}))} style={{ width:'100%', marginBottom:6, fontSize:'.75rem' }} />
              <textarea className="input" placeholder="Message…" value={bulkForm.body} onChange={e => setBulkForm(f => ({...f,body:e.target.value}))} rows={2} style={{ width:'100%', marginBottom:8, resize:'none', fontSize:'.75rem' }} />
              <div style={{ display:'flex', gap:12, alignItems:'center', marginBottom:8 }}>
                <label style={{ display:'flex', alignItems:'center', gap:4, fontSize:'.72rem', cursor:'pointer' }}>
                  <input type="checkbox" checked={bulkForm.sendEmail} onChange={e => setBulkForm(f => ({...f,sendEmail:e.target.checked}))} /> Email
                </label>
                <label style={{ display:'flex', alignItems:'center', gap:4, fontSize:'.72rem', cursor:'pointer' }}>
                  <input type="checkbox" checked={bulkForm.sendSMS} onChange={e => setBulkForm(f => ({...f,sendSMS:e.target.checked}))} /> SMS
                </label>
              </div>
              <div style={{ display:'flex', gap:6 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowBulk(false)}>Cancel</button>
                <button className="btn btn-primary btn-sm" disabled={!bulkForm.title || !bulkForm.body || bulkMut.isLoading} onClick={() => bulkMut.mutate()}>
                  {bulkMut.isLoading ? <span className="spinner" /> : <><Send size={11} /> Send</>}
                </button>
              </div>
            </div>
          )}

          {/* Notification list */}
          <div style={{ maxHeight:400, overflowY:'auto' }}>
            {notifications.length === 0 ? (
              <div style={{ padding:32, textAlign:'center', color:'var(--text-3)', fontSize:'.82rem' }}>
                <Bell size={24} style={{ opacity:.3, display:'block', margin:'0 auto 8px' }} />
                No notifications
              </div>
            ) : (
              notifications.map((n: any) => (
                <div key={n.id} onClick={e => {
                  e.stopPropagation()
                  if (!n.read) readMut.mutate(n.id)
                  const route = TYPE_ROUTES[n.type]
                  if (route) { setOpen(false); window.location.href = route }
                }}
                  style={{ display:'flex', gap:10, padding:'10px 16px', borderBottom:'1px solid var(--border-0)', cursor: n.is_read ? 'default' : 'pointer', background: n.is_read ? 'transparent' : 'rgba(201,162,39,.03)', transition:'background .12s' }}
                  onMouseEnter={e => !n.is_read && ((e.currentTarget as any).style.background = 'rgba(201,162,39,.06)')}
                  onMouseLeave={e => !n.is_read && ((e.currentTarget as any).style.background = 'rgba(201,162,39,.03)')}
                >
                  <div style={{ fontSize:'1.1rem', flexShrink:0, marginTop:1 }}>{TYPE_ICONS[n.type] || '🔔'}</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:'.78rem', fontWeight: n.is_read ? 500 : 700, color:'var(--text-0)', marginBottom:2 }}>{n.title}</div>
                    <div style={{ fontSize:'.7rem', color:'var(--text-3)', lineHeight:1.4, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{n.body}</div>
                    <div style={{ fontSize:'.62rem', color:'var(--text-3)', marginTop:3 }}>{timeAgo(n.created_at)}</div>
                  </div>
                  {!n.is_read && <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--gold)', flexShrink:0, marginTop:6 }} />}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
