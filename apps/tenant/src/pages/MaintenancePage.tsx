import { useState, useEffect } from 'react'
import { apiGet, apiPost, apiUpload } from '../lib/api'
import { Plus, X, Send, MessageSquare, Clock, Check, Camera, Video, Play, ShieldCheck } from 'lucide-react'
import { MAINTENANCE_CATEGORIES, MAINTENANCE_CATEGORY_LABEL, MAINTENANCE_PRIORITY_LABEL } from '@gam/shared'
import { AuthedImg, openAuthedBlob } from '../components/AuthedMedia'
import { CameraCapture } from '../components/CameraCapture'

const PRI_COLORS: Record<string,string> = { emergency:'#ff4757', high:'#ffb820', normal:'#4a9eff', low:'#7a8aaa' }

// S571: elapsed open→resolved, shown on completed items (transparency history).
function resolutionSpan(createdAt: string, completedAt: string): string {
  const ms = new Date(completedAt).getTime() - new Date(createdAt).getTime()
  if (!isFinite(ms) || ms < 0) return ''
  const days = Math.floor(ms / 86400000)
  const hours = Math.floor((ms % 86400000) / 3600000)
  if (days >= 1) return `Resolved in ${days} day${days === 1 ? '' : 's'}`
  if (hours >= 1) return `Resolved in ${hours} hour${hours === 1 ? '' : 's'}`
  return 'Resolved in under an hour'
}
const catLabel = (r: any): string =>
  (r.category && (MAINTENANCE_CATEGORY_LABEL as any)[r.category]) || r.title || 'Request'
// S552: awaiting_approval added — the status IS returned to tenants (only its
// notification is suppressed), and the `|| req.status` fallback below was
// rendering the raw enum (S538 violation). Tenant-friendly framing: the
// landlord is approving the budget before work proceeds.
const ST_LABELS: Record<string,string>  = { open:'Open', assigned:'Assigned', awaiting_approval:'Pending Approval', in_progress:'In Progress', completed:'Completed', cancelled:'Cancelled' }

export function MaintenancePage() {
  const [requests, setRequests] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [selected, setSelected] = useState<any>(null)
  const [detail, setDetail] = useState<any>(null)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // S571: tenant evidence media (photos/video) attached to a request. Captured
  // LIVE through the camera only — no album/file-picker path.
  const [media, setMedia] = useState<any[]>([])
  const [mediaUploading, setMediaUploading] = useState(false)
  const [mediaCaption, setMediaCaption] = useState('')
  const [mediaError, setMediaError] = useState('')
  const [cameraMode, setCameraMode] = useState<null | 'photo' | 'video'>(null)
  // S571: tenant picks a category (title is derived server-side) and does NOT
  // set priority — the in-house agent recommends it, the landlord can override.
  const [form, setForm] = useState({ category:'', description:'', photos:[] as string[] })

  const load = async () => {
    try { setRequests(await apiGet('/maintenance')) }
    catch(e) {}
    setLoading(false)
  }

  const loadDetail = async (id: string) => {
    try { setDetail(await apiGet(`/maintenance/${id}`)) }
    catch(e) {}
  }

  const loadMedia = async (id: string) => {
    try { setMedia(await apiGet(`/maintenance/${id}/media`)) }
    catch(e) { setMedia([]) }
  }

  const openRequest = (r: any) => {
    setSelected(r); setDetail(null); setMedia([]); setMediaError(''); setMediaCaption('')
    loadDetail(r.id); loadMedia(r.id)
  }

  const uploadMedia = async (file: File) => {
    if (!selected) return
    setMediaUploading(true); setMediaError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('capturedLive', 'true')
      if (mediaCaption.trim()) fd.append('caption', mediaCaption.trim())
      await apiUpload(`/maintenance/${selected.id}/media`, fd)
      setMediaCaption('')
      loadMedia(selected.id)
    } catch(e: any) {
      setMediaError(e?.response?.data?.error || 'Upload failed. Please try again.')
    }
    setMediaUploading(false)
  }

  useEffect(() => { load() }, [])

  const submit = async () => {
    if (!form.category || form.description.trim().length < 5) return
    setSubmitting(true)
    try {
      const me: any = await apiGet('/tenants/me')
      await apiPost('/maintenance', { category: form.category, description: form.description, photos: form.photos, unitId: me.unitId })
      setShowAdd(false)
      setForm({ category:'', description:'', photos:[] })
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
          <button onClick={() => { setSelected(null); setDetail(null); setMedia([]) }} style={{ background:'none', border:'none', cursor:'pointer', color:'#c9a227', fontSize:'.85rem', fontWeight:600 }}>← Back</button>
        </div>

        <div style={s.card}>
          <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:10 }}>
            <div>
              <div style={{ fontSize:'1rem', fontWeight:800, color:'#eef1f8', marginBottom:4 }}>{catLabel(req)}</div>
              <div style={{ display:'flex', gap:6 }}>
                <span style={{ fontSize:'.65rem', padding:'2px 8px', borderRadius:10, background:`${PRI_COLORS[req.priority]}18`, border:`1px solid ${PRI_COLORS[req.priority]}40`, color:PRI_COLORS[req.priority], fontWeight:700 }}>{(MAINTENANCE_PRIORITY_LABEL as any)[req.priority] || req.priority} priority</span>
                <span style={{ fontSize:'.65rem', padding:'2px 8px', borderRadius:10, background:'#141920', border:'1px solid #252e3d', color:'#b8c4d8', fontWeight:600 }}>{ST_LABELS[req.status] || req.status}</span>
              </div>
            </div>
            <div style={{ fontSize:'.7rem', color:'#7a8aaa' }}>{new Date(req.createdAt).toLocaleDateString()}</div>
          </div>
          <div style={{ fontSize:'.82rem', color:'#b8c4d8', lineHeight:1.6 }}>{req.description}</div>
          {req.scheduledAt && (
            <div style={{ marginTop:10, padding:'7px 10px', background:'rgba(201,162,39,.06)', border:'1px solid rgba(201,162,39,.2)', borderRadius:7, fontSize:'.72rem', color:'#c9a227', display:'flex', alignItems:'center', gap:6 }}>
              <Clock size={12} /> Scheduled: {new Date(req.scheduledAt).toLocaleString()}
            </div>
          )}
          {req.status === 'completed' && req.completedAt && (
            <div style={{ marginTop:8, padding:'7px 10px', background:'rgba(30,219,122,.06)', border:'1px solid rgba(30,219,122,.2)', borderRadius:7, fontSize:'.72rem', color:'#1edb7a', display:'flex', alignItems:'center', gap:6 }}>
              <Check size={12} /> {resolutionSpan(req.createdAt, req.completedAt)}
            </div>
          )}
        </div>

        {/* S571: tenant evidence media — photos/video of the issue or a
            "supposed fix", attached to this request. Landlord can't delete it. */}
        <div style={s.card}>
          <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
            <div style={{ fontSize:'.72rem', fontWeight:700, color:'#7a8aaa', textTransform:'uppercase' as const, letterSpacing:'.08em' }}>Photos &amp; video</div>
          </div>
          <div style={{ fontSize:'.72rem', color:'#7a8aaa', marginBottom:10, display:'flex', alignItems:'center', gap:5, lineHeight:1.5 }}>
            <ShieldCheck size={12} style={{ color:'#1edb7a', flexShrink:0 }} /> Your record. Add proof of the issue or a fix — your landlord can view it but can't delete it.
          </div>

          {media.length > 0 && (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(96px,1fr))', gap:8, marginBottom:12 }}>
              {media.map((m: any) => {
                const mine = m.uploaderRole === 'tenant'
                const who = mine ? 'You' : m.uploaderRole === 'maintenance' ? 'Maintenance' : 'Landlord'
                const afterClose = req.status === 'completed' && req.completedAt && new Date(m.createdAt).getTime() > new Date(req.completedAt).getTime()
                return (
                  <div key={m.id} style={{ position:'relative', borderRadius:8, overflow:'hidden', border:`1px solid ${afterClose ? 'rgba(255,184,32,.5)' : '#1e2530'}`, background:'#0f1318' }}>
                    {afterClose && (
                      <div style={{ position:'absolute', top:4, left:4, zIndex:2, fontSize:'.54rem', fontWeight:800, color:'#0a0d10', background:'#ffb820', borderRadius:4, padding:'1px 5px', letterSpacing:'.02em' }}>AFTER CLOSE</div>
                    )}
                    {m.mediaType === 'video' ? (
                      <div onClick={() => openAuthedBlob(m.fileUrl)} style={{ width:'100%', height:96, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer', color:'#c9a227', flexDirection:'column', gap:4 }}>
                        <Play size={22} /><span style={{ fontSize:'.6rem', color:'#7a8aaa' }}>Play video</span>
                      </div>
                    ) : (
                      <div onClick={() => openAuthedBlob(m.fileUrl)} style={{ cursor:'pointer', width:'100%', height:96 }}>
                        <AuthedImg path={m.fileUrl} alt={m.caption || 'photo'} style={{ width:'100%', height:'96px', objectFit:'cover' }} />
                      </div>
                    )}
                    <div style={{ padding:'3px 5px', fontSize:'.58rem', color: mine ? '#4a9eff' : '#c9a227', fontWeight:700, background:'#0a0d10' }}>
                      {who} · {new Date(m.createdAt).toLocaleDateString()}{m.capturedLive ? ' · live' : ''}
                      {m.caption && <div style={{ color:'#8a97ac', fontWeight:400, marginTop:1, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{m.caption}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <input style={{ ...s.input, marginBottom:8 }} placeholder="Optional note (e.g. 'still leaking after the visit')" value={mediaCaption} onChange={e => setMediaCaption(e.target.value)} />
          {mediaError && <div style={{ fontSize:'.7rem', color:'#ff4757', marginBottom:8 }}>{mediaError}</div>}
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={() => setCameraMode('photo')} disabled={mediaUploading} style={{ ...s.btn, display:'flex', alignItems:'center', gap:6, fontSize:'.8rem', opacity: mediaUploading ? .6 : 1 }}>
              <Camera size={14} /> {mediaUploading ? 'Uploading…' : 'Take photo'}
            </button>
            <button onClick={() => setCameraMode('video')} disabled={mediaUploading} style={{ padding:'10px 16px', borderRadius:8, border:'1px solid #252e3d', background:'#141920', color:'#b8c4d8', fontWeight:700, cursor:'pointer', display:'flex', alignItems:'center', gap:6, fontSize:'.8rem', opacity: mediaUploading ? .6 : 1 }}>
              <Video size={14} /> Record video
            </button>
          </div>
          <div style={{ fontSize:'.66rem', color:'#7a8aaa', marginTop:6 }}>Captured live through your camera — not uploaded from your library.</div>
        </div>

        {/* Comments */}
        <div style={s.card}>
          <div style={{ fontSize:'.72rem', fontWeight:700, color:'#7a8aaa', textTransform:'uppercase' as const, letterSpacing:'.08em', marginBottom:10 }}>Updates</div>
          <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:12 }}>
            {comments.length === 0 && <div style={{ fontSize:'.78rem', color:'#7a8aaa' }}>No updates yet.</div>}
            {comments.map((c: any) => (
              <div key={c.id} style={{ padding:'8px 10px', background:'#0f1318', border:'1px solid #1e2530', borderRadius:8 }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                  <span style={{ fontSize:'.7rem', fontWeight:600, color: c.role==='tenant'?'#4a9eff':'#c9a227' }}>{c.firstName} {c.lastName} <span style={{ fontWeight:400, color:'#7a8aaa', textTransform:'capitalize' as const }}>({c.role})</span></span>
                  <span style={{ fontSize:'.62rem', color:'#7a8aaa' }}>{new Date(c.createdAt).toLocaleString()}</span>
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

        {cameraMode && (
          <CameraCapture
            mode={cameraMode}
            onCapture={(file) => uploadMedia(file)}
            onClose={() => setCameraMode(null)}
          />
        )}
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
          <div key={r.id} onClick={() => openRequest(r)} style={{ ...s.card, cursor:'pointer', borderColor: r.priority==='emergency'?'rgba(255,71,87,.3)':r.priority==='high'?'rgba(255,184,32,.2)':'#1e2530' }}>
            <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between' }}>
              <div style={{ flex:1 }}>
                <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
                  <span style={{ fontSize:'.65rem', padding:'2px 7px', borderRadius:10, background:`${PRI_COLORS[r.priority]}15`, border:`1px solid ${PRI_COLORS[r.priority]}35`, color:PRI_COLORS[r.priority], fontWeight:700 }}>{(MAINTENANCE_PRIORITY_LABEL as any)[r.priority] || r.priority}</span>
                  <span style={{ fontSize:'.65rem', color:'#7a8aaa', fontWeight:600, textTransform:'capitalize' as const }}>{ST_LABELS[r.status]}</span>
                  {parseInt(r.commentCount) > 0 && <span style={{ fontSize:'.62rem', color:'#7a8aaa', display:'flex', alignItems:'center', gap:2 }}><MessageSquare size={9} />{r.commentCount}</span>}
                </div>
                <div style={{ fontSize:'.88rem', fontWeight:700, color:'#eef1f8' }}>{catLabel(r)}</div>
                {r.description && <div style={{ fontSize:'.74rem', color:'#8a97ac', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const, maxWidth:'46ch' }}>{r.description}</div>}
                <div style={{ fontSize:'.72rem', color:'#7a8aaa', marginTop:2 }}>{new Date(r.createdAt).toLocaleDateString()}</div>
              </div>
              <div style={{ color:'#c9a227', fontSize:'.75rem' }}>→</div>
            </div>
            {r.scheduledAt && r.status !== 'completed' && (
              <div style={{ marginTop:8, fontSize:'.7rem', color:'#c9a227', display:'flex', alignItems:'center', gap:4 }}>
                <Clock size={10} /> Scheduled {new Date(r.scheduledAt).toLocaleDateString()}
              </div>
            )}
            {r.status === 'completed' && r.completedAt && (
              <div style={{ marginTop:8, fontSize:'.7rem', color:'#1edb7a', display:'flex', alignItems:'center', gap:4 }}>
                <Check size={10} /> {resolutionSpan(r.createdAt, r.completedAt)}
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
              <label style={s.label}>Category *</label>
              <select style={{ ...s.input, cursor:'pointer' }} value={form.category} onChange={e => setForm(f=>({...f,category:e.target.value}))} autoFocus>
                <option value="" disabled>Select a category…</option>
                {MAINTENANCE_CATEGORIES.map(c => (
                  <option key={c} value={c}>{MAINTENANCE_CATEGORY_LABEL[c]}</option>
                ))}
              </select>
            </div>
            <div style={{ marginBottom:16 }}>
              <label style={s.label}>What's wrong? *</label>
              <textarea style={{ ...s.input, resize:'vertical' as const }} rows={4} placeholder="Describe the issue — what's wrong, where it is, and when it started…" value={form.description} onChange={e => setForm(f=>({...f,description:e.target.value}))} />
            </div>
            <div style={{ marginBottom:20, padding:'8px 10px', background:'rgba(74,158,255,.06)', border:'1px solid rgba(74,158,255,.2)', borderRadius:7, fontSize:'.7rem', color:'#8ab8ff', lineHeight:1.5 }}>
              We'll assess how urgent this is and route it to your landlord. If it's an emergency (gas, fire, flooding, no heat/water, or you can't secure your unit), call your landlord or emergency services directly too.
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <button onClick={() => setShowAdd(false)} style={{ flex:1, padding:11, borderRadius:8, border:'1px solid #252e3d', background:'#141920', color:'#7a8aaa', cursor:'pointer', fontWeight:600 }}>Cancel</button>
              <button onClick={submit} disabled={submitting || !form.category || form.description.trim().length < 5} style={{ flex:2, ...s.btn, opacity:(!form.category||form.description.trim().length<5)?'.5':'1' }}>
                {submitting ? '…' : 'Submit Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
