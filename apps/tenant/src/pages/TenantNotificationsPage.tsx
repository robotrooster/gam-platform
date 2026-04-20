import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Bell, Check, Building2 } from 'lucide-react'

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
const tok = () => localStorage.getItem('gam_tenant_token')
const get = (p: string) => fetch(API+'/api'+p,{headers:{Authorization:'Bearer '+tok()}}).then(r=>r.json()).then(r=>r.data??r)
const patch = (p: string) => fetch(API+'/api'+p,{method:'PATCH',headers:{Authorization:'Bearer '+tok()}}).then(r=>r.json())
const post = (p: string, b: any) => fetch(API+'/api'+p,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tok()},body:JSON.stringify(b)}).then(r=>r.json())

export function TenantNotificationsPage() {
  const qc = useQueryClient()
  const { data: notifs = [], isLoading } = useQuery('tenant-notifs', () => get('/background/notifications'))

  const readMut = useMutation(
    (id: string) => patch('/background/notifications/'+id+'/read'),
    { onSuccess: () => qc.invalidateQueries('tenant-notifs') }
  )

  const respondMut = useMutation(
    ({ matchId, interested }: any) => post('/background/pool/match/'+matchId+'/respond', { interested }),
    { onSuccess: () => qc.invalidateQueries('tenant-notifs') }
  )

  const unread = (notifs as any[]).filter(n => !n.read).length

  return (
    <div style={{ maxWidth:560, margin:'0 auto' }}>
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:24 }}>
        <Bell size={22} style={{ color:'var(--gold, #c9a227)' }}/>
        <h1 style={{ color:'var(--text-0, #eef1f8)', fontSize:'1.2rem', fontWeight:800, margin:0 }}>Notifications</h1>
        {unread > 0 && <span style={{ padding:'2px 8px', borderRadius:20, background:'var(--gold, #c9a227)', color:'#060809', fontSize:'.7rem', fontWeight:700 }}>{unread}</span>}
      </div>

      {isLoading ? (
        <div style={{ textAlign:'center', color:'#4a5568', padding:32 }}>Loading...</div>
      ) : (notifs as any[]).length === 0 ? (
        <div style={{ textAlign:'center', color:'#4a5568', padding:48 }}>
          <Bell size={40} style={{ display:'block', margin:'0 auto 12px', opacity:.3 }}/>
          <div style={{ fontWeight:600 }}>No notifications yet</div>
          <div style={{ fontSize:'.82rem', marginTop:4 }}>Vacancy matches and updates will appear here</div>
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          {(notifs as any[]).map((n: any) => {
            const data = typeof n.data === 'string' ? JSON.parse(n.data||'{}') : n.data||{}
            const isMatch = n.type === 'match_interest'
            return (
              <div key={n.id} onClick={()=>!n.read&&readMut.mutate(n.id)}
                style={{ background: n.read?'#0a0d10':'rgba(201,162,39,.04)', border:'1px solid '+(n.read?'#1e2530':'rgba(201,162,39,.2)'), borderRadius:12, padding:16, cursor:n.read?'default':'pointer' }}>
                <div style={{ display:'flex', alignItems:'flex-start', gap:12 }}>
                  <div style={{ width:36, height:36, borderRadius:'50%', background:isMatch?'rgba(201,162,39,.1)':'rgba(34,197,94,.1)', border:'1px solid '+(isMatch?'rgba(201,162,39,.3)':'rgba(34,197,94,.3)'), display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    {isMatch ? <Building2 size={16} style={{ color:'#c9a227' }}/> : <Check size={16} style={{ color:'#22c55e' }}/>}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontWeight:700, color:'#eef1f8', fontSize:'.85rem', marginBottom:4 }}>{n.title}</div>
                    <div style={{ fontSize:'.78rem', color:'#4a5568', lineHeight:1.5, marginBottom:isMatch&&!data.responded?12:0 }}>{n.body}</div>
                    {isMatch && !data.responded && data.matchRequestId && (
                      <div style={{ display:'flex', gap:8 }}>
                        <button onClick={e=>{e.stopPropagation();respondMut.mutate({matchId:data.matchRequestId,interested:true})}}
                          style={{ padding:'8px 16px', borderRadius:8, border:'none', background:'#c9a227', color:'#060809', fontWeight:700, fontSize:'.78rem', cursor:'pointer' }}>
                          👍 Interested
                        </button>
                        <button onClick={e=>{e.stopPropagation();respondMut.mutate({matchId:data.matchRequestId,interested:false})}}
                          style={{ padding:'8px 16px', borderRadius:8, border:'1px solid #1e2530', background:'transparent', color:'#4a5568', fontSize:'.78rem', cursor:'pointer' }}>
                          Not Interested
                        </button>
                      </div>
                    )}
                    {data.responded && <div style={{ fontSize:'.72rem', color:'#22c55e', marginTop:4 }}>✓ Response sent</div>}
                  </div>
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