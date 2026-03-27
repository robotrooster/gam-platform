import { useState, useEffect } from 'react'
import { apiGet, apiPost } from '../lib/api'
import { Plus, X, Send, MessageSquare, Clock, Check, AlertTriangle } from 'lucide-react'

const PRI_COLORS: Record<string,string> = { emergency:'#ff4757', high:'#ffb820', normal:'#4a9eff', low:'#7a8aaa' }
const ST_LABELS: Record<string,string>  = { open:'Open', assigned:'Assigned', in_progress:'In Progress', completed:'Completed', cancelled:'Cancelled' }

export function MaintenancePage() {
  const [requests, setRequests] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [selected, setSelected] = useState<any>(null)
  const [detail, setDetail] = useState<any>(null)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState({ title:'', description:'', priority:'normal', photos:[] as string[] })

  const load = async () => {
    try { setRequests(await apiGet('/maintenance')) }
    catch(e) {}
    setLoading(false)
  }

  const loadDetail = async (id: string) => {
    try { setDetail(await apiGet(`/maintenance/${id}`)) }
    catch(e) {}
  }

  useEffect(() => { load() }, [])

  const submit = async () => {
    if (!form.title || !form.description) return
    setSubmitting(true)
    try {
      const me: any = await apiGet('/tenants/me')
      await apiPost('/maintenance', { ...form, unitId: me.unit_id })
      setShowAdd(false)
      setForm({ title:'', description:'', priority:'normal', photos:[] })
      load()
    } catch(e) {}
    setSubmitting(false)
  }

  const sendComment = async () => {
    if (!comment.trim() || !selected) return
    try {
      await apiPost(`/maintenance/${selected.id}/comments`, { message: comment })
      setComment('')
      loadDetail(selected.id)
    } catch(e) {}
  }

  const s = {
    page: { padding:20, fontFamily:'system-ui', background:'#060809', minHeight:'100vh', color:'#b8c4d8' } as React.CSSProperties,
    card: { background:'#0a0d10', border:'1px solid #1e2530', borderRadius:12, padding:16, marginBottom:12 } as React.CSSProperties,
    input: { width:'100%', padding:'9px 11px', background:'#141920', border:'1px solid #252e3d', borderRadius:8, color:'#eef1f8', fontSize:'.85rem', outline:'none', fontFamily:'system-ui', boxSizing:'border-box' as const },
    label: { fontSize:'.68rem', fontWeight:700, color:'#7a8aaa', textTransform:'uppercase' as const, letterSpacing:'.08em', display:'block', marginBottom:5 },
    btn: { padding:'10px 16px', borderRadius:8, border:'none', background:'linear-gradient(135deg,#8a6c10,#c9a227)', color:'#060809', fontWeight:700, cursor:'pointer', fontFamily:'system-ui' } as React.CSSProperties,
  }

  if (selected) {
    const req = detail || selected
    const comments = detail?.comments || []
    return (
      <div style={s.page}>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:16 }}>
          <button onClick={() => { setSelected(null); setDetail(null) }} style={{ background:'none', border:'none', cursor:'pointer', color:'#c9a227', fontSize:'.85rem', fontWeight:600 }}>← Back</button>
        </div>

        <div style={s.card}>
          <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:10 }}>
            <div>
              <div style={{ fontSize:'1rem', fontWeight:800, color:'#eef1f8', marginBottom:4 }}>{req.title}</div>
              <div style={{ display:'flex', gap:6 }}>
                <span style={{ fontSize:'.65rem', padding:'2px 8px', borderRadius:10, background:`${PRI_COLORS[req.priority]}18`, border:`1px solid ${PRI_COLORS[req.priority]}40`, color:PRI_COLORS[req.priority], fontWeight:700, textTransform:'capitalize' as const }}>{req.priority}</span>
                <span style={{ fontSize:'.65rem', padding:'2px 8px', borderRadius:10, background:'#141920', border:'1px solid #252e3d', color:'#b8c4d8', fontWeight:600 }}>{ST_LABELS[req.status] || req.status}</span>
              </div>
            </div>
            <div style={{ fontSize:'.7rem', color:'#7a8aaa' }}>{new Date(req.created_at).toLocaleDateString()}</div>
          </div>
          <div style={{ fontSize:'.82rem', color:'#b8c4d8', lineHeight:1.6 }}>{req.description}</div>
          {req.scheduled_at && (
            <div style={{ marginTop:10, padding:'7px 10px', background:'rgba(201,162,39,.06)', border:'1px solid rgba(201,162,39,.2)', borderRadius:7, fontSize:'.72rem', color:'#c9a227', display:'flex', alignItems:'center', gap:6 }}>
              <Clock size={12} /> Scheduled: {new Date(req.scheduled_at).toLocaleString()}
            </div>
          )}
          {req.status === 'completed' && req.actual_cost && (
            <div style={{ marginTop:8, padding:'7px 10px', background:'rgba(30,219,122,.06)', border:'1px solid rgba(30,219,122,.2)', borderRadius:7, fontSize:'.72rem', color:'#1edb7a', display:'flex', alignItems:'center', gap:6 }}>
              <Check size={12} /> Completed · Cost: ${parseFloat(req.actual_cost).toFixed(2)}
            </div>
          )}
        </div>

        {/* Comments */}
        <div style={s.card}>
          <div style={{ fontSize:'.72rem', fontWeight:700, color:'#7a8aaa', textTransform:'uppercase' as const, letterSpacing:'.08em', marginBottom:10 }}>Updates</div>
          <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:12 }}>
            {comments.length === 0 && <div style={{ fontSize:'.78rem', color:'#7a8aaa' }}>No updates yet.</div>}
            {comments.map((c: any) => (
              <div key={c.id} style={{ padding:'8px 10px', background:'#0f1318', border:'1px solid #1e2530', borderRadius:8 }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                  <span style={{ fontSize:'.7rem', fontWeight:600, color: c.role==='tenant'?'#4a9eff':'#c9a227' }}>{c.first_name} {c.last_name} <span style={{ fontWeight:400, color:'#7a8aaa', textTransform:'capitalize' as const }}>({c.role})</span></span>
                  <span style={{ fontSize:'.62rem', color:'#7a8aaa' }}>{new Date(c.created_at).toLocaleString()}</span>
                </div>
                <div style={{ fontSize:'.78rem', color:'#b8c4d8', lineHeight:1.5 }}>{c.message}</div>
              </div>
            ))}
          </div>
          {req.status !== 'completed' && req.status !== 'cancelled' && (
            <div style={{ display:'flex', gap:8 }}>
              <input style={s.input} placeholder="Add a comment or update…" value={comment} onChange={e => setComment(e.target.value)} onKeyDown={e => e.key==='Enter' && sendComment()} />
              <button onClick={sendComment} disabled={!comment.trim()} style={{ ...s.btn, padding:'9px 14px', opacity: comment.trim()?1:.5 }}>
                <Send size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={s.page}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <div>
          <div style={{ fontFamily:'system-ui', fontSize:'1.1rem', fontWeight:800, color:'#eef1f8' }}>Maintenance</div>
          <div style={{ fontSize:'.72rem', color:'#7a8aaa' }}>{requests.filter(r=>r.status==='open').length} open requests</div>
        </div>
        <button onClick={() => setShowAdd(true)} style={{ ...s.btn, display:'flex', alignItems:'center', gap:6, fontSize:'.82rem' }}>
          <Plus size={14} /> New Request
        </button>
      </div>

      {loading ? (
        <div style={{ display:'flex', justifyContent:'center', padding:40 }}>
          <div style={{ width:28, height:28, border:'3px solid #1a2028', borderTopColor:'#c9a227', borderRadius:'50%', animation:'spin 1s linear infinite' }} />
        </div>
      ) : requests.length === 0 ? (
        <div style={{ textAlign:'center', padding:'40px 0', color:'#7a8aaa' }}>
          <div style={{ fontSize:32, marginBottom:8 }}>🔧</div>
          <div style={{ fontSize:'.9rem', fontWeight:600, color:'#b8c4d8' }}>No maintenance requests</div>
          <div style={{ fontSize:'.78rem', marginTop:4 }}>Submit a request when something needs attention.</div>
        </div>
      ) : (
        requests.map(r => (
          <div key={r.id} onClick={() => { setSelected(r); loadDetail(r.id) }} style={{ ...s.card, cursor:'pointer', borderColor: r.priority==='emergency'?'rgba(255,71,87,.3)':r.priority==='high'?'rgba(255,184,32,.2)':'#1e2530' }}>
            <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between' }}>
              <div style={{ flex:1 }}>
                <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
                  <span style={{ fontSize:'.65rem', padding:'2px 7px', borderRadius:10, background:`${PRI_COLORS[r.priority]}15`, border:`1px solid ${PRI_COLORS[r.priority]}35`, color:PRI_COLORS[r.priority], fontWeight:700, textTransform:'capitalize' as const }}>{r.priority}</span>
                  <span style={{ fontSize:'.65rem', color:'#7a8aaa', fontWeight:600, textTransform:'capitalize' as const }}>{ST_LABELS[r.status]}</span>
                  {parseInt(r.comment_count) > 0 && <span style={{ fontSize:'.62rem', color:'#7a8aaa', display:'flex', alignItems:'center', gap:2 }}><MessageSquare size={9} />{r.comment_count}</span>}
                </div>
                <div style={{ fontSize:'.88rem', fontWeight:700, color:'#eef1f8' }}>{r.title}</div>
                <div style={{ fontSize:'.72rem', color:'#7a8aaa', marginTop:2 }}>{new Date(r.created_at).toLocaleDateString()}</div>
              </div>
              <div style={{ color:'#c9a227', fontSize:'.75rem' }}>→</div>
            </div>
            {r.scheduled_at && (
              <div style={{ marginTop:8, fontSize:'.7rem', color:'#c9a227', display:'flex', alignItems:'center', gap:4 }}>
                <Clock size={10} /> Scheduled {new Date(r.scheduled_at).toLocaleDateString()}
              </div>
            )}
          </div>
        ))
      )}

      {/* New request modal */}
      {showAdd && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.7)', backdropFilter:'blur(4px)', display:'flex', alignItems:'center', justifyContent:'center', padding:16, zIndex:100 }} onClick={() => setShowAdd(false)}>
          <div style={{ background:'#0a0d10', border:'1px solid #1e2530', borderRadius:16, padding:24, width:'100%', maxWidth:440 }} onClick={e => e.stopPropagation()}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <div style={{ fontSize:'1rem', fontWeight:800, color:'#eef1f8' }}>New Maintenance Request</div>
              <button onClick={() => setShowAdd(false)} style={{ background:'none', border:'none', cursor:'pointer', color:'#7a8aaa' }}><X size={16} /></button>
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={s.label}>Issue Title *</label>
              <input style={s.input} placeholder="e.g. Leaking faucet in bathroom" value={form.title} onChange={e => setForm(f=>({...f,title:e.target.value}))} autoFocus />
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={s.label}>Description *</label>
              <textarea style={{ ...s.input, resize:'vertical' as const }} rows={3} placeholder="Describe the issue in detail — when it started, how bad it is…" value={form.description} onChange={e => setForm(f=>({...f,description:e.target.value}))} />
            </div>
            <div style={{ marginBottom:20 }}>
              <label style={s.label}>Priority</label>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:6 }}>
                {['emergency','high','normal','low'].map(p => (
                  <div key={p} onClick={() => setForm(f=>({...f,priority:p}))} style={{ padding:'8px 4px', borderRadius:8, cursor:'pointer', textAlign:'center', border:`1px solid ${form.priority===p?'#c9a227':'#252e3d'}`, background:form.priority===p?'rgba(201,162,39,.08)':'#141920', fontSize:'.7rem', fontWeight:600, color:form.priority===p?'#c9a227':'#7a8aaa', textTransform:'capitalize' as const, transition:'all .12s' }}>
                    {p}
                  </div>
                ))}
              </div>
              {form.priority === 'emergency' && (
                <div style={{ marginTop:8, padding:'7px 10px', background:'rgba(255,71,87,.06)', border:'1px solid rgba(255,71,87,.2)', borderRadius:7, fontSize:'.7rem', color:'#ff4757', display:'flex', alignItems:'center', gap:6 }}>
                  <AlertTriangle size={11} /> Emergency requests alert your landlord immediately.
                </div>
              )}
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <button onClick={() => setShowAdd(false)} style={{ flex:1, padding:11, borderRadius:8, border:'1px solid #252e3d', background:'#141920', color:'#7a8aaa', cursor:'pointer', fontWeight:600 }}>Cancel</button>
              <button onClick={submit} disabled={submitting || !form.title || !form.description} style={{ flex:2, ...s.btn, opacity:(!form.title||!form.description)?'.5':'1' }}>
                {submitting ? '…' : 'Submit Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
