import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { FileText, Download, PenTool, CheckCircle, AlertCircle, RotateCcw } from 'lucide-react'

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'

function useCountdown(targetDate: string | null) {
  const [time, setTime] = useState({ days:0, hours:0, minutes:0, seconds:0, ms:0, expired:false })
  useEffect(() => {
    if (!targetDate) return
    const tick = () => {
      const diff = new Date(targetDate).getTime() - Date.now()
      if (diff <= 0) { setTime(t => ({...t, expired:true})); return }
      setTime({
        days:    Math.floor(diff / 86400000),
        hours:   Math.floor((diff % 86400000) / 3600000),
        minutes: Math.floor((diff % 3600000) / 60000),
        seconds: Math.floor((diff % 60000) / 1000),
        ms:      Math.floor((diff % 1000) / 10),
        expired: false,
      })
    }
    tick()
    const id = setInterval(tick, 50)
    return () => clearInterval(id)
  }, [targetDate])
  return time
}

function get<T>(path: string): Promise<T> {
  const token = localStorage.getItem('gam_tenant_token')
  return fetch(`${API_URL}/api${path}`, { headers: { Authorization: `Bearer ${token}` } })
    .then(r => r.json()).then(r => r.data ?? r)
}
function post<T>(path: string, body: any): Promise<T> {
  const token = localStorage.getItem('gam_tenant_token')
  return fetch(`${API_URL}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    .then(r => r.json()).then(r => r.data ?? r)
}

// ── SIGNATURE CANVAS ─────────────────────────────────────────
function SignatureCanvas({ onSign }: { onSign: (dataUrl: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [drawing, setDrawing] = useState(false)
  const [hasDrawn, setHasDrawn] = useState(false)

  const getPos = (e: React.MouseEvent | React.TouchEvent, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    if ('touches' in e) {
      return { x: (e.touches[0].clientX - rect.left) * scaleX, y: (e.touches[0].clientY - rect.top) * scaleY }
    }
    return { x: ((e as React.MouseEvent).clientX - rect.left) * scaleX, y: ((e as React.MouseEvent).clientY - rect.top) * scaleY }
  }

  const start = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const pos = getPos(e, canvas)
    ctx.beginPath()
    ctx.moveTo(pos.x, pos.y)
    setDrawing(true)
    e.preventDefault()
  }

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!drawing) return
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const pos = getPos(e, canvas)
    ctx.strokeStyle = '#c9a227'
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineTo(pos.x, pos.y)
    ctx.stroke()
    setHasDrawn(true)
    e.preventDefault()
  }

  const end = () => {
    setDrawing(false)
    if (hasDrawn) onSign(canvasRef.current!.toDataURL())
  }

  const clear = () => {
    const canvas = canvasRef.current!
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height)
    setHasDrawn(false)
    onSign('')
  }

  return (
    <div>
      {(pendingDocs as any[]).length > 0 && (
        <div style={{ background:'rgba(201,162,39,.08)', border:'1px solid rgba(201,162,39,.3)', borderRadius:12, padding:'16px 20px', marginBottom:20, display:'flex', alignItems:'center', justifyContent:'space-between', gap:16 }}>
          <div>
            <div style={{ fontWeight:700, color:'var(--gold, #c9a227)', marginBottom:4 }}>📋 Document Awaiting Your Signature</div>
            <div style={{ fontSize:'.82rem', color:'var(--text-2, #b8c4d8)' }}>{(pendingDocs as any[])[0].title}</div>
          </div>
          <button onClick={()=>navigate('/sign/'+(pendingDocs as any[])[0].token)}
            style={{ padding:'10px 20px', borderRadius:8, border:'none', background:'var(--gold, #c9a227)', color:'#060809', fontWeight:700, cursor:'pointer', whiteSpace:'nowrap' as const, flexShrink:0 }}>
            Sign Now →
          </button>
        </div>
      )}
      <canvas ref={canvasRef} width={500} height={120}
        style={{ width:'100%', height:120, border:'2px dashed var(--gold)', borderRadius:10, background:'var(--bg-2)', cursor:'crosshair', touchAction:'none' }}
        onMouseDown={start} onMouseMove={draw} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={draw} onTouchEnd={end}
      />
      <button onClick={clear} style={{ marginTop:6, background:'none', border:'none', cursor:'pointer', fontSize:'.72rem', color:'var(--text-3)', display:'flex', alignItems:'center', gap:4 }}>
        <RotateCcw size={11} /> Clear
      </button>
    </div>
  )
}

function PdfViewer({ url, token }: { url:string; token:string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(1)
  const pdfRef = useRef<any>(null)
  const renderTaskRef = useRef<any>(null)
  const loadedRef = useRef(false)

  useEffect(() => {
    const load = async () => {
      if (loadedRef.current) return
      loadedRef.current = true
      if (!(window as any).pdfjsLib) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement('script')
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
          s.onload = () => { ;(window as any).pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; resolve() }
          s.onerror = reject; document.head.appendChild(s)
        })
      }
      const pdf = await (window as any).pdfjsLib.getDocument({ url, httpHeaders:{ Authorization:'Bearer '+token } }).promise
      pdfRef.current = pdf; setTotal(pdf.numPages)
      setTimeout(() => renderPage(pdf, 1), 150)
    }
    load().catch(console.error)
  }, [url])

  const renderPage = async (pdf:any, pageNum:number) => {
    if (!canvasRef.current || !containerRef.current) return
    // Cancel any in-progress render
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel()
      renderTaskRef.current = null
    }
    const p2 = await pdf.getPage(pageNum)
    const vp = p2.getViewport({ scale:1 })
    const scale = containerRef.current.clientWidth / vp.width
    const sv = p2.getViewport({ scale })
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')!
    canvas.width = sv.width; canvas.height = sv.height
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const task = p2.render({ canvasContext:ctx, viewport:sv })
    renderTaskRef.current = task
    try { await task.promise } catch(e:any) { if (e?.name !== 'RenderingCancelledException') console.error(e) }
  }

  const goPage = (n:number) => { setPage(n); if(pdfRef.current) renderPage(pdfRef.current, n) }

  return (
    <div ref={containerRef}>
      <canvas ref={canvasRef} style={{ display:'block', width:'100%' }}/>
      {total > 1 && (
        <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:12, padding:'10px', borderTop:'1px solid var(--border-0)' }}>
          <button className="btn btn-ghost btn-sm" disabled={page===1} onClick={()=>goPage(page-1)}>← Prev</button>
          <span style={{ fontSize:'.78rem', color:'var(--text-3)' }}>Page {page} of {total}</span>
          <button className="btn btn-ghost btn-sm" disabled={page===total} onClick={()=>goPage(page+1)}>Next →</button>
        </div>
      )}
    </div>
  )
}

export function LeasePage() {
  const navigate = useNavigate()
  const { data: pendingDocs = [] } = useQuery('pending-docs', () =>
    get('/esign/pending?t=' + Date.now()).then((r: any) => r)
  )
  const qc = useQueryClient()
  const [signMode, setSignMode] = useState<'type'|'draw'>('type')
  const [typedSig, setTypedSig] = useState('')
  const [drawnSig, setDrawnSig] = useState('')
  const [scrolled, setScrolled] = useState(false)
  const [agreed, setAgreed] = useState(false)
  const [showSign, setShowSign] = useState(false)
  const [renewalIntent, setRenewalIntent] = useState<'yes'|'no'|'unsure'|null>(null)
  const [renewalNotes, setRenewalNotes] = useState('')
  const [renewalSubmitted, setRenewalSubmitted] = useState(false)
  const leaseDocRef = useRef<HTMLDivElement>(null)

  const { data: lease, isLoading } = useQuery('tenant-lease', () => get<any>('/tenants/lease'))
  const { data: workTrade } = useQuery('tenant-worktrade', () => get<any>('/tenants/work-trade'))

  const signMut = useMutation(
    (sig: string) => post('/tenants/lease/sign', { signature: sig, signatureType: signMode, ip: 'client' }),
    { onSuccess: () => { qc.invalidateQueries('tenant-lease') } }
  )

  const renewalMut = useMutation(
    () => post(`/leases/${lease?.id}/renewal-intent`, { intent: renewalIntent, notes: renewalNotes }),
    { onSuccess: () => setRenewalSubmitted(true) }
  )

  const signature = signMode === 'type' ? typedSig : drawnSig
  const canSign   = agreed && scrolled && signature.length > 2

  const countdown = useCountdown((lease as any)?.endDate || null)

  if (isLoading) return <div style={{ padding:32, color:'var(--text-3)', textAlign:'center' }}>Loading lease…</div>

  // Show pending signing banner


  if (!lease) return (
    <div style={{ padding:48, textAlign:'center' }}>
      <FileText size={48} style={{ opacity:.2, display:'block', margin:'0 auto 12px' }} />
      <div style={{ fontSize:'.9rem', color:'var(--text-3)' }}>No lease on file yet.</div>
      <div style={{ fontSize:'.78rem', color:'var(--text-3)', marginTop:4 }}>Your landlord will upload your lease when ready.</div>
    </div>
  )

  const daysToExpiry = lease.endDate
    ? Math.ceil((new Date(lease.endDate).getTime() - Date.now()) / 86400000) : null
  const needsTenantSig = lease.signedByLandlord && !lease.signedByTenant
  const fullyExecuted = lease.signedByLandlord && lease.signedByTenant
  const showRenewalSurvey = daysToExpiry !== null && daysToExpiry <= 60 && daysToExpiry > 0 && !renewalSubmitted && !lease.tenantRenewalIntent && fullyExecuted

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:24 }}>
        <div>
          <h1 style={{ fontFamily:'var(--font-display)', fontSize:'1.4rem', fontWeight:800, color:'var(--text-0)', marginBottom:4 }}>Lease Agreement</h1>
          <p style={{ fontSize:'.82rem', color:'var(--text-3)' }}>
            {lease.propertyName} · Unit {lease.unitNumber}
            {lease.startDate && ` · ${new Date(lease.startDate).toLocaleDateString()} – ${new Date(lease.endDate).toLocaleDateString()}`}
          </p>
        </div>

      </div>
      {(pendingDocs as any[]).length > 0 && (
        <div style={{ background:'rgba(201,162,39,.08)', border:'1px solid rgba(201,162,39,.3)', borderRadius:12, padding:'16px 20px', marginBottom:20, display:'flex', alignItems:'center', justifyContent:'space-between', gap:16 }}>
          <div>
            <div style={{ fontWeight:700, color:'var(--gold, #c9a227)', marginBottom:4 }}>📋 Document Awaiting Your Signature</div>
            <div style={{ fontSize:'.82rem', color:'var(--text-2)' }}>{(pendingDocs as any[])[0].title} · {(pendingDocs as any[])[0].propertyName}</div>
          </div>
          <button onClick={()=>navigate('/sign/'+(pendingDocs as any[])[0].token)}
            style={{ padding:'10px 20px', borderRadius:8, border:'none', background:'var(--gold, #c9a227)', color:'#060809', fontWeight:700, cursor:'pointer', whiteSpace:'nowrap' as const, flexShrink:0 }}>
            Sign Now →
          </button>
        </div>
      )}

      {/* Status banner */}
      {fullyExecuted ? (
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'12px 16px', background:'rgba(30,219,122,.08)', border:'1px solid rgba(30,219,122,.25)', borderRadius:10, marginBottom:20 }}>
          <CheckCircle size={18} style={{ color:'var(--green)', flexShrink:0 }} />
          <div>
            <div style={{ fontSize:'.82rem', fontWeight:700, color:'var(--green)' }}>Lease Fully Executed</div>
            <div style={{ fontSize:'.72rem', color:'var(--text-3)' }}>Signed by all parties{lease.tenantSignedAt ? ' · ' + new Date(lease.tenantSignedAt).toLocaleString() : ''}</div>
          </div>
        </div>
      ) : needsTenantSig ? (
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'12px 16px', background:'rgba(201,162,39,.08)', border:'1px solid rgba(201,162,39,.3)', borderRadius:10, marginBottom:20 }}>
          <AlertCircle size={18} style={{ color:'var(--gold)', flexShrink:0 }} />
          <div>
            <div style={{ fontSize:'.82rem', fontWeight:700, color:'var(--gold)' }}>Your Signature Required</div>
            <div style={{ fontSize:'.72rem', color:'var(--text-3)' }}>Your landlord has signed. Please review and sign below.</div>
          </div>
        </div>
      ) : (
        <div style={{ padding:'12px 16px', background:'var(--bg-2)', border:'1px solid var(--border-0)', borderRadius:10, marginBottom:20, fontSize:'.82rem', color:'var(--text-3)' }}>
          📋 Waiting for landlord signature.
        </div>
      )}

      {/* Expiry countdown */}
      {lease.endDate && daysToExpiry !== null && daysToExpiry > 0 && (
        <div style={{ padding:'16px 20px', background: daysToExpiry <= 30 ? 'rgba(239,68,68,.06)' : daysToExpiry <= 60 ? 'rgba(245,158,11,.06)' : 'rgba(201,162,39,.04)', border:`1px solid ${daysToExpiry<=30?'rgba(239,68,68,.25)':daysToExpiry<=60?'rgba(245,158,11,.25)':'rgba(201,162,39,.2)'}`, borderRadius:12, marginBottom:20 }}>
          <div style={{ fontSize:'.65rem', color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.1em', fontWeight:600, marginBottom:10 }}>
            {daysToExpiry <= 30 ? '🚨 Lease Expires Soon' : daysToExpiry <= 60 ? '⚠️ Lease Expiring' : '📅 Lease Term Remaining'}
          </div>
          <div style={{ display:'flex', gap:12, alignItems:'flex-end' }}>
            {[
              { val: countdown.days,    label: 'Days' },
              { val: countdown.hours,   label: 'Hrs' },
              { val: countdown.minutes, label: 'Min' },
              { val: countdown.seconds, label: 'Sec' },
            ].map(u => (
              <div key={u.label} style={{ textAlign:'center' }}>
                <div style={{ fontFamily:'var(--font-m,monospace)', fontSize:'1.6rem', fontWeight:800, color: daysToExpiry<=30?'var(--red)':daysToExpiry<=60?'var(--amber)':'var(--gold)', lineHeight:1, minWidth:40 }}>
                  {String(u.val).padStart(2,'0')}
                </div>
                <div style={{ fontSize:'.58rem', color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.08em', marginTop:3 }}>{u.label}</div>
              </div>
            ))}
            <div style={{ textAlign:'center', marginBottom:2 }}>
              <div style={{ fontFamily:'var(--font-m,monospace)', fontSize:'.9rem', fontWeight:700, color: daysToExpiry<=30?'var(--red)':daysToExpiry<=60?'var(--amber)':'var(--gold)', lineHeight:1, minWidth:28 }}>.{String(countdown.ms).padStart(2,'0')}</div>
              <div style={{ fontSize:'.58rem', color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.08em', marginTop:3 }}>ms</div>
            </div>
          </div>
          <div style={{ fontSize:'.7rem', color:'var(--t3)', marginTop:10 }}>
            Expires {new Date(lease.endDate).toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}
          </div>
        </div>
      )}

      {/* Renewal survey */}
      {showRenewalSurvey && (
        <div style={{ background:'var(--bg-2)', border:'1px solid var(--border-0)', borderRadius:12, padding:20, marginBottom:20 }}>
          <div style={{ fontFamily:'var(--font-display)', fontSize:'.95rem', fontWeight:800, color:'var(--text-0)', marginBottom:6 }}>Do you plan to renew your lease?</div>
          <div style={{ fontSize:'.78rem', color:'var(--text-3)', marginBottom:16 }}>Your landlord needs to know your plans. This helps them prepare for renewal or find a new tenant.</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginBottom:14 }}>
            {[
              { val:'yes', icon:'✅', label:'Yes, I plan to renew' },
              { val:'no',  icon:'❌', label:"No, I'll be moving out" },
              { val:'unsure', icon:'❓', label:"I'm not sure yet" },
            ].map(opt => (
              <div key={opt.val} onClick={() => setRenewalIntent(opt.val as any)} style={{ padding:'12px 10px', borderRadius:10, cursor:'pointer', textAlign:'center', border:`2px solid ${renewalIntent===opt.val?'var(--gold)':'var(--border-0)'}`, background:renewalIntent===opt.val?'rgba(201,162,39,.08)':'var(--bg-3)', transition:'all .12s' }}>
                <div style={{ fontSize:'1.4rem', marginBottom:4 }}>{opt.icon}</div>
                <div style={{ fontSize:'.72rem', fontWeight:600, color:renewalIntent===opt.val?'var(--gold)':'var(--text-2)' }}>{opt.label}</div>
              </div>
            ))}
          </div>
          <textarea placeholder="Any notes for your landlord? (optional)" value={renewalNotes} onChange={e => setRenewalNotes(e.target.value)} rows={2} style={{ width:'100%', marginBottom:10, resize:'none', fontFamily:'inherit', fontSize:'.78rem', padding:'8px 10px', background:'var(--bg-3)', border:'1px solid var(--border-0)', borderRadius:8, color:'var(--text-0)' }} />
          <button className="btn btn-primary" disabled={!renewalIntent || renewalMut.isLoading} onClick={() => renewalMut.mutate()}>
            {renewalMut.isLoading ? <span className="spinner" /> : 'Submit Response'}
          </button>
        </div>
      )}

      {renewalSubmitted && (
        <div style={{ padding:'10px 14px', background:'rgba(30,219,122,.08)', border:'1px solid rgba(30,219,122,.25)', borderRadius:10, marginBottom:20, fontSize:'.82rem', color:'var(--green)' }}>
          ✓ Your renewal response has been submitted. Your landlord has been notified.
        </div>
      )}

      {/* Lease document */}
      <div style={{ background:'var(--bg-2)', border:'1px solid var(--border-0)', borderRadius:12, overflow:'hidden', marginBottom:20 }}>
        <div style={{ padding:'14px 18px', borderBottom:'1px solid var(--border-0)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div style={{ fontFamily:'var(--font-display)', fontSize:'.85rem', fontWeight:700, color:'var(--text-0)' }}>📄 {fullyExecuted ? 'Executed Lease Agreement' : 'Lease Document'}</div>
          {fullyExecuted && lease.documentUrl && (
            <a href={lease.documentUrl?.startsWith('http') ? lease.documentUrl : API_URL + lease.documentUrl} download="lease-agreement.pdf" className="btn btn-ghost btn-sm" style={{ textDecoration:'none', fontSize:'.72rem', display:'flex', alignItems:'center', gap:4 }}>
              <Download size={12}/> Download PDF
            </a>
          )}
        </div>
        {lease.documentUrl ? (
          <PdfViewer url={lease.documentUrl?.startsWith('http') ? lease.documentUrl : API_URL + lease.documentUrl} token={localStorage.getItem('gam_tenant_token')||''}/>
        ) : (
          <div ref={leaseDocRef} onScroll={e => { const el = e.currentTarget; if (el.scrollTop + el.clientHeight >= el.scrollHeight - 30) setScrolled(true) }}
            style={{ padding:24, maxHeight:400, overflowY:'auto', fontSize:'.82rem', color:'var(--text-2)', lineHeight:1.9 }}>
            <div style={{ fontFamily:'var(--font-display)', fontSize:'1rem', fontWeight:800, color:'var(--text-0)', textAlign:'center', marginBottom:20 }}>RESIDENTIAL LEASE AGREEMENT</div>
            <div style={{ marginBottom:12 }}><strong>Landlord:</strong> {lease.landlordName}</div>
            <div style={{ marginBottom:12 }}><strong>Tenant:</strong> {lease.tenantName}</div>
            <div style={{ marginBottom:12 }}><strong>Property:</strong> {lease.propertyName}, Unit {lease.unitNumber}</div>
            <div style={{ marginBottom:12 }}><strong>Term:</strong> {new Date(lease.startDate).toLocaleDateString()} to {new Date(lease.endDate).toLocaleDateString()}</div>
            <div style={{ marginBottom:12 }}><strong>Monthly Rent:</strong> ${lease.rentAmount}</div>
            <div style={{ marginBottom:12 }}><strong>Security Deposit:</strong> ${lease.securityDeposit}</div>
            <div style={{ borderTop:'1px solid var(--border-0)', paddingTop:16, marginTop:16, fontSize:'.75rem', color:'var(--text-3)' }}>
              By signing electronically, both parties agree to the terms stated herein. This electronic signature is legally binding under the federal E-SIGN Act and equivalent state-level electronic signature laws. Consult your local laws for any jurisdiction-specific requirements.
            </div>
          </div>
        )}
      </div>

      {/* Signature section */}
      {needsTenantSig && !fullyExecuted && (
        <div style={{ background:'var(--bg-2)', border:'2px solid rgba(201,162,39,.3)', borderRadius:12, padding:20 }}>
          <div style={{ fontFamily:'var(--font-display)', fontSize:'.95rem', fontWeight:800, color:'var(--text-0)', marginBottom:4 }}>Sign Your Lease</div>
          <div style={{ fontSize:'.78rem', color:'var(--text-3)', marginBottom:16 }}>Your signature is legally binding under UETA and the federal E-SIGN Act.</div>

          {/* Agree checkbox */}
          <label style={{ display:'flex', alignItems:'flex-start', gap:10, cursor:'pointer', marginBottom:16, padding:'10px 12px', background:'var(--bg-3)', borderRadius:8 }}>
            <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} style={{ marginTop:2 }} />
            <div style={{ fontSize:'.78rem', color:'var(--text-2)', lineHeight:1.5 }}>
              I have read and agree to the full lease agreement. I understand this electronic signature is legally binding.
            </div>
          </label>

          {/* Sign mode toggle */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:14 }}>
            {[
              { mode:'type', icon:'⌨️', label:'Type my name' },
              { mode:'draw', icon:'✍️', label:'Draw signature' },
            ].map(opt => (
              <div key={opt.mode} onClick={() => setSignMode(opt.mode as any)} style={{ padding:'10px 12px', borderRadius:8, cursor:'pointer', textAlign:'center', border:`1px solid ${signMode===opt.mode?'var(--gold)':'var(--border-0)'}`, background:signMode===opt.mode?'rgba(201,162,39,.06)':'var(--bg-3)', transition:'all .12s' }}>
                <div style={{ fontSize:'.85rem', marginBottom:2 }}>{opt.icon}</div>
                <div style={{ fontSize:'.72rem', fontWeight:600, color:signMode===opt.mode?'var(--gold)':'var(--text-3)' }}>{opt.label}</div>
              </div>
            ))}
          </div>

          {/* Signature input */}
          {signMode === 'type' ? (
            <div style={{ marginBottom:16 }}>
              <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:6 }}>Type your full legal name</label>
              <input value={typedSig} onChange={e => setTypedSig(e.target.value)} placeholder="Jane Marie Smith" style={{ width:'100%', fontFamily:'Georgia, serif', fontStyle:'italic', fontSize:'1.2rem', padding:'12px 14px', background:'var(--bg-3)', border:'2px solid var(--border-0)', borderRadius:10, color:'var(--gold)', outline:'none', boxSizing:'border-box' as const }} />
              <div style={{ fontSize:'.65rem', color:'var(--text-3)', marginTop:4 }}>
                Signing as {typedSig || '—'} · {new Date().toLocaleDateString()} · {new Date().toLocaleTimeString()}
              </div>
            </div>
          ) : (
            <div style={{ marginBottom:16 }}>
              <label style={{ fontSize:'.72rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:6 }}>Draw your signature</label>
              <SignatureCanvas onSign={setDrawnSig} />
            </div>
          )}

          {!scrolled && !lease.documentUrl && (
            <div style={{ fontSize:'.72rem', color:'var(--amber)', marginBottom:12 }}>↑ Please scroll through the full lease before signing</div>
          )}

          <button className="btn btn-primary" disabled={!canSign || signMut.isLoading} onClick={() => signMut.mutate(signature)} style={{ width:'100%', justifyContent:'center', padding:14, fontSize:'.9rem' }}>
            {signMut.isLoading ? <span className="spinner" /> : <><PenTool size={15} /> Sign Lease</>}
          </button>

          {signMut.isError && <div style={{ color:'var(--red)', fontSize:'.75rem', marginTop:8, textAlign:'center' }}>Signing failed. Please try again.</div>}
        </div>
      )}

      {/* Audit trail */}
      {fullyExecuted && (
        <div style={{ background:'var(--bg-2)', border:'1px solid var(--border-0)', borderRadius:10, padding:16, marginTop:16 }}>
          <div style={{ fontSize:'.72rem', fontWeight:700, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.07em', marginBottom:10 }}>Signature Audit Trail</div>
          {[
            lease.landlordSignedAt && { role:'Landlord', sig: "Landlord", at: lease.landlordSignedAt },
            lease.tenantSignedAt   && { role:'Tenant',   sig: signature,   at: lease.tenantSignedAt },
          ].filter(Boolean).map((s: any) => (
            <div key={s.role} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 0', borderBottom:'1px solid var(--border-0)' }}>
              <CheckCircle size={14} style={{ color:'var(--green)', flexShrink:0 }} />
              <div style={{ flex:1 }}>
                <div style={{ fontSize:'.78rem', fontWeight:600, color:'var(--text-0)' }}>{s.role}</div>
                <div style={{ fontFamily:'Georgia, serif', fontStyle:'italic', color:'var(--gold)', fontSize:'.85rem' }}>{s.sig?.slice(0,30)}{s.sig?.length > 30 ? '…' : ''}</div>
              </div>
              <div style={{ fontSize:'.65rem', color:'var(--text-3)' }}>{new Date(s.at).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
