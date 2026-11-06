import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { Bell, Check, Building2, ChevronRight, X } from 'lucide-react'

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
const tok = () => localStorage.getItem('gam_tenant_token')
const get = (p: string) => fetch(API+'/api'+p,{headers:{Authorization:'Bearer '+tok()}}).then(r=>r.json()).then(r=>r.data??r)
const del = (p: string) => fetch(API+'/api'+p,{method:'DELETE',headers:{Authorization:'Bearer '+tok()}}).then(r=>r.json())
const patch = (p: string, b?: any) => fetch(API+'/api'+p,{method:'PATCH',headers:{...(b!==undefined?{'Content-Type':'application/json'}:{}),Authorization:'Bearer '+tok()},body:b!==undefined?JSON.stringify(b):undefined}).then(r=>r.json())

/**
 * Where a notice takes you when you tap it.
 *
 * 10/30 (Nic): "if the tenants are going to use this, actions need to be able
 * to happen when stuff is clicked." Most notices already carry an action_url —
 * the emergency-contact one points at /profile#emergency-contact — and the page
 * simply ignored it. The biggest kind does NOT carry one: in production 135
 * "please sign this" notices have no link at all, which is the one notice where
 * the whole point is to go and do the thing. Those carry the document id in
 * their data, so the destination is derivable.
 *
 * Deriving here rather than backfilling the column means the notices already
 * sitting unread become useful immediately, without touching stored rows.
 */
function destinationOf(n: any, data: any): string | null {
  // The API camelCases every key on its way out (see the outgoing middleware in
  // apps/api/src/index.ts), so the column action_url arrives as actionUrl. Read
  // both: the snake_case name is what the database and every emitter call it,
  // and getting this wrong silently makes every notice unclickable.
  if (n.actionUrl) return n.actionUrl
  if (n.action_url) return n.action_url
  switch (n.type) {
    case 'esign_request':
    case 'esign_completed':
      return data.documentId ? `/sign/${data.documentId}` : '/communication?tab=documents'
    case 'maintenance_updated':
    case 'maintenance_created':
      return '/communication?tab=maintenance'
    case 'inspection_scheduled':
    case 'inspection_scheduled_reminder':
      return '/inspections'
    case 'entry_request_new':
      return '/communication?tab=entry'
    default:
      return null
  }
}

export function TenantNotificationsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data: notifs = [], isLoading } = useQuery('tenant-notifs', () =>
    get('/notifications?limit=100').then((r: any) => Array.isArray(r) ? r : (r?.items ?? [])))

  const readMut = useMutation(
    (id: string) => patch('/notifications/'+id+'/read'),
    { onSuccess: () => qc.invalidateQueries('tenant-notifs') }
  )

  // 10/30 (Nic): clearing one is evidence, not erasure — the row stays on the
  // server with dismissed_at, because "they went through with deleting it"
  // means they were on the page looking at it.
  const dismissMut = useMutation(
    (id: string) => del('/notifications/'+id),
    { onSuccess: () => qc.invalidateQueries('tenant-notifs') }
  )

  const respondMut = useMutation(
    // S554 (button-sweep bug #6): route is PATCH, not POST → this 404'd silently.
    ({ matchId, interested }: any) => patch('/background/pool/match/'+matchId+'/respond', { interested }),
    { onSuccess: () => qc.invalidateQueries('tenant-notifs') }
  )

  const unread = (notifs as any[]).filter(n => !n.read).length

  return (
    <div style={{ maxWidth:560, margin:'0 auto' }}>
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:24 }}>
        <Bell size={22} style={{ color:'var(--gold, #c9a227)' }}/>
        <h1 style={{ color:'var(--t0)', fontSize:'1.2rem', fontWeight:800, margin:0 }}>Notifications</h1>
        {unread > 0 && <span style={{ padding:'2px 8px', borderRadius:20, background:'var(--gold, #c9a227)', color:'#060809', fontSize:'.7rem', fontWeight:700 }}>{unread}</span>}
      </div>

      {isLoading ? (
        <div style={{ textAlign:'center', color:'var(--t3)', padding:32 }}>Loading...</div>
      ) : (notifs as any[]).length === 0 ? (
        <div style={{ textAlign:'center', color:'var(--t3)', padding:48 }}>
          <Bell size={40} style={{ display:'block', margin:'0 auto 12px', opacity:.3 }}/>
          <div style={{ fontWeight:600 }}>No notifications yet</div>
          <div style={{ fontSize:'.82rem', marginTop:4 }}>Vacancy matches and updates will appear here</div>
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          {(notifs as any[]).map((n: any) => {
            let data: any = {}
            try { data = typeof n.data === 'string' ? JSON.parse(n.data||'{}') : n.data||{} } catch { data = {} }
            const isMatch = n.type === 'match_interest'
            // A match notice answers itself with its own two buttons, so tapping
            // the card must not navigate out from under them.
            const to = isMatch ? null : destinationOf(n, data)
            const go = () => {
              if (!n.read) readMut.mutate(n.id)
              if (to) navigate(to)
            }
            return (
              <div key={n.id} onClick={go} role={to ? 'button' : undefined} tabIndex={to ? 0 : undefined}
                onKeyDown={to ? (e)=>{ if (e.key==='Enter'||e.key===' ') { e.preventDefault(); go() } } : undefined}
                style={{ background: n.read?'var(--bg-2)':'rgba(201,162,39,.04)', border:'1px solid '+(n.read?'var(--b1)':'rgba(201,162,39,.2)'), borderRadius:12, padding:16, cursor:(to||!n.read)?'pointer':'default' }}>
                <div style={{ display:'flex', alignItems:'flex-start', gap:12 }}>
                  <div style={{ width:36, height:36, borderRadius:'50%', background:isMatch?'rgba(201,162,39,.1)':'rgba(34,197,94,.1)', border:'1px solid '+(isMatch?'rgba(201,162,39,.3)':'rgba(34,197,94,.3)'), display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    {isMatch ? <Building2 size={16} style={{ color:'#c9a227' }}/> : <Check size={16} style={{ color:'#22c55e' }}/>}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontWeight:700, color:'var(--t0)', fontSize:'.85rem', marginBottom:4 }}>{n.title}</div>
                    <div style={{ fontSize:'.78rem', color:'var(--t3)', lineHeight:1.5, marginBottom:isMatch&&!data.responded?12:0 }}>{n.body}</div>
                    {isMatch && !data.responded && data.matchRequestId && (
                      <div style={{ display:'flex', gap:8 }}>
                        <button onClick={e=>{e.stopPropagation();respondMut.mutate({matchId:data.matchRequestId,interested:true})}}
                          style={{ padding:'8px 16px', borderRadius:8, border:'none', background:'#c9a227', color:'#060809', fontWeight:700, fontSize:'.78rem', cursor:'pointer' }}>
                          👍 Interested
                        </button>
                        <button onClick={e=>{e.stopPropagation();respondMut.mutate({matchId:data.matchRequestId,interested:false})}}
                          style={{ padding:'8px 16px', borderRadius:8, border:'1px solid var(--b1)', background:'transparent', color:'var(--t3)', fontSize:'.78rem', cursor:'pointer' }}>
                          Not Interested
                        </button>
                      </div>
                    )}
                    {data.responded && <div style={{ fontSize:'.72rem', color:'#22c55e', marginTop:4 }}>✓ Response sent</div>}
                  </div>
                  {to && <ChevronRight size={16} style={{ color:'var(--t3)', flexShrink:0, alignSelf:'center' }} />}
                  <button onClick={e=>{e.stopPropagation();dismissMut.mutate(n.id)}} aria-label="Clear this notification"
                    style={{ background:'none', border:'none', cursor:'pointer', color:'var(--t3)', padding:4,
                             borderRadius:6, flexShrink:0, alignSelf:'flex-start', minWidth:28, minHeight:28,
                             display:'inline-flex', alignItems:'center', justifyContent:'center' }}>
                    <X size={14} />
                  </button>
                  {!n.read && <div style={{ width:8, height:8, borderRadius:'50%', background:'#c9a227', flexShrink:0, marginTop:4 }}/>}
                </div>
                <div style={{ fontSize:'.65rem', color:'#2a3040', marginTop:8, textAlign:'right' }}>
                  {new Date(n.createdAt).toLocaleString()}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}