import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { FileText, Download, PenTool, CheckCircle, AlertCircle, RotateCcw } from 'lucide-react'
import { ADDENDUM_DIFF_FIELD_LABEL, formatAddendumDiffValue } from '@gam/shared'

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
  const [renewalIntent, setRenewalIntent] = useState<'yes'|'no'|'unsure'|null>(null)
  const [renewalNotes, setRenewalNotes] = useState('')
  const [renewalSubmitted, setRenewalSubmitted] = useState(false)
  const leaseDocRef = useRef<HTMLDivElement>(null)

  const { data: lease, isLoading } = useQuery('tenant-lease', () => get<any>('/tenants/lease'))

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
        {fullyExecuted && lease.id && (lease.status === 'active' || lease.status === 'pending') && (
          <EarlyTerminationSurface leaseId={lease.id} />
        )}
      </div>

      {/* S262: FlexDeposit accelerated / in_default banner. Renders
          when the tenant's deposit plan has triggered the 2-strike
          acceleration. 'accelerated' = pull in flight (info only).
          'in_default' = pull failed, manual retry available. Auto-
          hides when neither state applies. */}
      {(lease.status === 'active' || lease.status === 'pending') && (
        <FlexDepositAcceleratedBanner />
      )}

      {/* S256: deposit portability — when this lease is ending and the
          tenant has another GAM lease pending/active, offer to carry
          the deposit forward instead of receiving a refund. Auto-hides
          when not eligible. */}
      {lease.id && (lease.status === 'active' || lease.status === 'pending') && (
        <DepositPortabilitySection leaseId={lease.id} />
      )}
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

      {/* S483: state-law warnings on lease terms. Tenant sees the same
          hedged factual notices the landlord saw at PATCH time;
          completes the both-party transparency loop for lease terms
          (S478 closed entry-requests). Recomputed server-side per
          GET so they stay current as the catalog refreshes. */}
      {Array.isArray(lease.stateLawWarnings) && lease.stateLawWarnings.length > 0 && (
        <div style={{
          background: 'rgba(245,158,11,.08)',
          border: '1px solid rgba(245,158,11,.4)',
          borderRadius: 10,
          padding: '14px 18px',
          marginBottom: 20,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: '.7rem', fontWeight: 700,
            color: 'var(--amber, #f59e0b)', textTransform: 'uppercase',
            letterSpacing: '.06em', marginBottom: 10,
          }}>
            ⚠ Heads up — state-law check
          </div>
          {lease.stateLawWarnings.map((w: any, i: number) => (
            <div key={i} style={{
              marginBottom: i < lease.stateLawWarnings.length - 1 ? 14 : 0,
            }}>
              <div style={{ fontSize: '.85rem', color: 'var(--text-0)', lineHeight: 1.55, marginBottom: 6 }}>
                {w.message}
              </div>
              <div style={{
                fontSize: '.7rem', color: 'var(--text-3)',
                display: 'flex', flexWrap: 'wrap', gap: 10,
              }}>
                {w.citation && <span>{w.citation}</span>}
                {w.sourceUrl && (
                  <a href={w.sourceUrl} target="_blank" rel="noreferrer"
                    style={{ color: 'var(--amber, #f59e0b)', textDecoration: 'none' }}>
                    source ↗
                  </a>
                )}
                {w.sourceDate && <span>as of {String(w.sourceDate).slice(0, 10)}</span>}
              </div>
              {w.disclaimer && (
                <div style={{
                  fontSize: '.66rem', color: 'var(--text-3)',
                  fontStyle: 'italic', marginTop: 6, lineHeight: 1.45,
                }}>
                  {w.disclaimer}
                </div>
              )}
            </div>
          ))}
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

      {/* S210 (S202 carry): addendum history — non-material edits the
          landlord recorded against this lease. Each row shows the
          fields that changed (from → to). Empty list renders nothing.
          S213: pdf_filename rendered as "View PDF" link when present. */}
      {fullyExecuted && lease.id && (
        <AddendumHistorySection leaseId={lease.id} />
      )}

      {/* S198: Sublease management — request + view own subleases.
          Shown for active executed leases. Backend enforces
          subleasing_allowed policy on the lease. */}
      {fullyExecuted && lease.id && lease.status === 'active' && (
        <>
          <SubleaseSection leaseId={lease.id} />
          <SublessorCreditCard />
        </>
      )}
    </div>
  )
}

// ── ADDENDUM HISTORY ────────────────────────────────────────
// S210 (S202 carry): renders lease_addendum_recorded credit-ledger
// events for the current tenant's active lease. Backend at
// GET /api/tenants/lease/addendums returns the diff per addendum;
// /credit page shows the events but redacts payload, so this is
// the surface where the tenant sees WHAT actually changed.
// S212: field-label + money-formatting moved to @gam/shared so the
// API PDF generator + landlord surface can read the same map.
// S213: pdf_filename → "View PDF" link, served via
// /api/leases/:id/addendum-pdf/:filename. Browser <a> can't carry
// the Bearer token, so the click handler fetches with auth and
// opens a blob URL in a new tab.
type AddendumChange = { field: string; from: string; to: string }
type AddendumEvent  = {
  id:               string
  occurredAt:      string
  changes:          AddendumChange[]
  pdfFilename:     string | null
  recordedByName: string
}

async function openAddendumPdf(leaseId: string, filename: string, token: string) {
  const res = await fetch(`${API_URL}/api/leases/${leaseId}/addendum-pdf/${filename}`, {
    headers: { Authorization: 'Bearer ' + token },
  })
  if (!res.ok) {
    alert('Could not load PDF (status ' + res.status + ')')
    return
  }
  const blob = await res.blob()
  window.open(URL.createObjectURL(blob), '_blank')
}

function AddendumHistorySection({ leaseId }: { leaseId: string }) {
  const { data, isLoading } = useQuery('tenant-lease-addendums', () =>
    get<AddendumEvent[]>('/tenants/lease/addendums')
  )
  const addendums: AddendumEvent[] = (data as AddendumEvent[] | undefined) ?? []

  if (isLoading || addendums.length === 0) return null

  return (
    <div style={{ background:'var(--bg-2)', border:'1px solid var(--border-0)', borderRadius:10, padding:16, marginTop:16 }}>
      <div style={{ fontSize:'.72rem', fontWeight:700, color:'var(--text-3)', textTransform:'uppercase' as const, letterSpacing:'.07em', marginBottom:10 }}>
        Lease Amendments ({addendums.length})
      </div>
      <div style={{ fontSize:'.7rem', color:'var(--text-3)', marginBottom:14 }}>
        Non-material changes your landlord recorded against this lease. Each amendment is part of your tenancy record.
      </div>
      {addendums.map(a => (
        <div key={a.id} style={{ padding:'10px 0', borderBottom:'1px solid var(--border-0)' }}>
          <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:4, flexWrap:'wrap' }}>
            <span style={{ fontSize:'.78rem', fontWeight:600, color:'var(--text-0)' }}>
              {new Date(a.occurredAt).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' })}
            </span>
            <span style={{ fontSize:'.65rem', color:'var(--text-3)' }}>
              {new Date(a.occurredAt).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' })}
            </span>
            {a.pdfFilename && (
              <button
                onClick={() => openAddendumPdf(leaseId, a.pdfFilename!, localStorage.getItem('gam_tenant_token') || '')}
                style={{ marginLeft:'auto', fontSize:'.68rem', padding:'2px 8px', background:'transparent', border:'1px solid var(--gold)', color:'var(--gold)', borderRadius:4, cursor:'pointer' }}>
                View PDF
              </button>
            )}
          </div>
          <div style={{ fontSize:'.68rem', color:'var(--text-3)', marginBottom:8 }}>
            Recorded by {a.recordedByName}
          </div>
          <div style={{ display:'grid', gap:6 }}>
            {(a.changes ?? []).map((c, i) => (
              <div key={i} style={{ fontSize:'.74rem', color:'var(--text-2)', display:'flex', flexWrap:'wrap', gap:6, alignItems:'baseline' }}>
                <span style={{ fontWeight:600, color:'var(--text-1)' }}>
                  {ADDENDUM_DIFF_FIELD_LABEL[c.field] ?? c.field}
                </span>
                <span style={{ color:'var(--text-3)', fontFamily:'var(--font-m, monospace)' }}>
                  {formatAddendumDiffValue(c.field, c.from)}
                </span>
                <span style={{ color:'var(--text-3)' }}>→</span>
                <span style={{ color:'var(--gold)', fontFamily:'var(--font-m, monospace)', fontWeight:600 }}>
                  {formatAddendumDiffValue(c.field, c.to)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── EARLY TERMINATION ───────────────────────────────────────
function EarlyTerminationSurface({ leaseId }: { leaseId: string }) {
  const qc = useQueryClient()
  const [showModal, setShowModal] = useState(false)
  const [understood, setUnderstood] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<any>(null)

  const { data: quote } = useQuery(
    ['termination-quote', leaseId],
    () => get<any>(`/leases/${leaseId}/termination-quote`),
    { staleTime: 30000 },
  )

  const requestMut = useMutation(
    () => post<any>(`/leases/${leaseId}/terminate-early`, { reason: reason || undefined }),
    {
      onSuccess: (res: any) => {
        setResult(res?.data ?? res)
        qc.invalidateQueries(['termination-quote', leaseId])
        qc.invalidateQueries('tenant-lease')
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed'),
    },
  )

  const cancelMut = useMutation(
    () => post(`/leases/${leaseId}/terminate-early/cancel`, {}),
    {
      onSuccess: () => qc.invalidateQueries(['termination-quote', leaseId]),
    },
  )

  const existing = quote?.existingRequest
  const isPending = existing?.status === 'requested' || existing?.status === 'failed'
  const fee = Number(quote?.feeAmount ?? 0)
  const basis = quote?.feeBasis ?? 'no_policy'

  return (
    <>
      {isPending ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, fontSize: '.78rem' }}>
          <span style={{ padding: '4px 10px', borderRadius: 12, background: 'rgba(245,158,11,.1)', color: 'var(--amber)', fontWeight: 600 }}>
            Termination {existing.status === 'failed' ? 'failed — retry' : 'pending'}
          </span>
          <button
            onClick={() => cancelMut.mutate()}
            style={{ background: 'none', border: 'none', color: 'var(--text-3)', fontSize: '.72rem', cursor: 'pointer', textDecoration: 'underline' }}
            disabled={cancelMut.isLoading}
          >
            Cancel request
          </button>
        </div>
      ) : (
        <button
          onClick={() => { setShowModal(true); setError(null); setResult(null); setUnderstood(false) }}
          style={{ padding: '8px 14px', borderRadius: 8, background: 'transparent', border: '1px solid var(--border-1, rgba(255,255,255,.15))', color: 'var(--text-2)', fontSize: '.78rem', cursor: 'pointer' }}
        >
          End lease early
        </button>
      )}

      {showModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}
          onClick={() => !requestMut.isLoading && setShowModal(false)}
        >
          <div
            style={{ background: 'var(--bg-1, #0a0d10)', border: '1px solid var(--border-0)', borderRadius: 12, padding: 24, width: 520, maxWidth: '92vw', color: 'var(--text-1)' }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.1rem', color: 'var(--text-0)', marginBottom: 12 }}>
              End your lease early
            </h3>

            {result ? (
              <div>
                <div style={{ background: 'rgba(34,197,94,.06)', border: '1px solid rgba(34,197,94,.25)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                  <strong style={{ color: 'var(--green)' }}>
                    {result.chargeStatus === 'paid' && '✓ Lease terminated'}
                    {result.chargeStatus === 'no_charge_needed' && '✓ Lease terminated (no fee on file)'}
                    {result.chargeStatus === 'failed' && '⚠ Termination failed'}
                  </strong>
                  <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 6 }}>
                    {result.chargeStatus === 'paid' && `Fee of $${fee.toFixed(2)} was charged. Your lease is now terminated.`}
                    {result.chargeStatus === 'no_charge_needed' && 'No early-termination fee was on file. Your lease is terminated.'}
                    {result.chargeStatus === 'failed' && `Auto-charge couldn't run: ${result.request?.feeChargeFailureReason || 'unknown'}. You can retry or contact your landlord to waive.`}
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => { setShowModal(false); setResult(null) }}
                    style={{ padding: '8px 14px', borderRadius: 8, background: 'var(--gold)', border: 'none', color: '#060809', fontWeight: 700, cursor: 'pointer' }}
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <>
                {error && <div style={{ background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 8, padding: 12, marginBottom: 12, color: 'var(--red)', fontSize: '.85rem' }}>{error}</div>}

                <div style={{ background: 'var(--bg-2, #0f1116)', borderRadius: 8, padding: 14, marginBottom: 14 }}>
                  <div style={{ fontSize: '.7rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>
                    Early-termination fee
                  </div>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.6rem', color: fee > 0 ? 'var(--text-0)' : 'var(--green)' }}>
                    {fee > 0 ? `$${fee.toFixed(2)}` : 'No fee'}
                  </div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 4 }}>
                    {basis === 'lease_specific' && 'Per the early-termination clause in your lease.'}
                    {basis === 'landlord_default' && `Per your landlord's default policy (${quote?.monthsRentMultiplier}× monthly rent).`}
                    {basis === 'no_policy' && 'Your landlord has no early-termination fee policy on file.'}
                  </div>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: 6 }}>
                    Reason (optional)
                  </label>
                  <textarea
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    rows={2}
                    placeholder="Brief context (job relocation, etc.)"
                    style={{ width: '100%', padding: 8, borderRadius: 6, background: 'var(--bg-2)', border: '1px solid var(--border-0)', color: 'var(--text-1)', fontFamily: 'inherit', fontSize: '.85rem' }}
                  />
                </div>

                {fee > 0 && (
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '.85rem', color: 'var(--text-2)', marginBottom: 16, cursor: 'pointer' }}>
                    <input type="checkbox" checked={understood} onChange={e => setUnderstood(e.target.checked)} style={{ marginTop: 2 }} />
                    <span>
                      I understand a fee of <strong style={{ color: 'var(--text-0)' }}>${fee.toFixed(2)}</strong> will be charged immediately to my on-file payment method, and my lease will terminate as soon as the charge succeeds. This cannot be undone except via dispute.
                    </span>
                  </label>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <button
                    onClick={() => setShowModal(false)}
                    disabled={requestMut.isLoading}
                    style={{ padding: '8px 14px', borderRadius: 8, background: 'transparent', border: '1px solid var(--border-0)', color: 'var(--text-2)', cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => requestMut.mutate()}
                    disabled={requestMut.isLoading || (fee > 0 && !understood)}
                    style={{ padding: '8px 14px', borderRadius: 8, background: fee > 0 && !understood ? 'var(--bg-3)' : 'var(--red)', border: 'none', color: 'white', fontWeight: 700, cursor: requestMut.isLoading || (fee > 0 && !understood) ? 'not-allowed' : 'pointer' }}
                  >
                    {requestMut.isLoading ? 'Processing…' : fee > 0 ? 'Pay & Terminate' : 'Terminate'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}

// ── SUBLEASE SECTION (S198) ─────────────────────────────────
// Tenant-side request + view own subleases (as sublessor or
// sublessee). Backend at routes/subleases.ts (S197).
type TenantSublease = {
  id: string
  masterLeaseId: string
  status: 'pending_invite' | 'pending' | 'awaiting_signatures' | 'active' | 'terminated'
  startDate: string
  endDate: string | null
  subMonthlyAmount: string
  masterShareAmount: string
  unitNumber: string
  propertyName: string
  sublessorName: string
  sublesseeName: string | null
  sublessorEmail: string
  sublesseeEmail: string
  sublessorTenantId: string
  sublesseeTenantId: string | null
  terminatedReason: string | null
  invitation_status?: 'sent' | 'accepted' | 'expired' | 'cancelled' | null
  invitationExpiresAt?: string | null
  subleaseDocumentId?: string | null
}

// ── S248: Sublessor credit balance + withdraw card ────────────────────────
// Tenant who subleases at a markup accrues (sub_monthly − master_share)
// per cycle. This card shows the balance + lets them withdraw to their
// bank via Stripe Connect Transfer. Hidden when no balance exists at all.

interface SublessorCreditPayload {
  totalBalance:    number
  totalEarned:     number
  totalWithdrawn:  number
  perSublease: Array<{
    subleaseId:    string
    propertyName:  string | null
    unitNumber:    string | null
    balance:        number
    totalEarned:   number
    totalWithdrawn:number
  }>
}

function SublessorCreditCard() {
  const qc = useQueryClient()
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const credit = useQuery<SublessorCreditPayload>(
    'sublessor-credit',
    () => get<SublessorCreditPayload>('/subleases/me/credit'),
  )

  const withdrawMut = useMutation(
    () => post<{ stripeTransferId: string; withdrawnCents: number }>(
      '/subleases/me/credit/withdraw',
      { amount: parseFloat(amount) },
    ),
    {
      onSuccess: (r) => {
        if ((r as any)?.success === false) {
          setError((r as any)?.error || 'Withdrawal failed')
          return
        }
        setSuccess(`Withdrew $${((r as any).withdrawnCents / 100).toFixed(2)} — Stripe Transfer ${(r as any).stripeTransferId}`)
        setAmount('')
        setError(null)
        qc.invalidateQueries('sublessor-credit')
      },
      onError: (e: any) => setError(e?.message || 'Withdrawal failed'),
    },
  )

  if (credit.isLoading) return null
  const data = credit.data
  if (!data || (data.totalBalance === 0 && data.totalEarned === 0)) {
    // No sublease activity — hide the card entirely.
    return null
  }

  const balance = data.totalBalance
  const wholeAmount = parseFloat(amount)
  const validAmount = Number.isFinite(wholeAmount) && wholeAmount > 0 && wholeAmount <= balance

  return (
    <div className="card" style={{ padding: 16, marginTop: 14 }}>
      <h3 style={{ margin: '0 0 4px', color: 'var(--text-0)' }}>Sublease earnings</h3>
      <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 14 }}>
        Profit from subleasing at a markup over master rent. Withdraw to your bank anytime.
      </div>

      <div style={{ display: 'flex', gap: 14, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 130 }}>
          <div style={{ fontSize: '.7rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Available</div>
          <div style={{ fontFamily: 'var(--font-m)', fontSize: '1.6rem', fontWeight: 800, color: 'var(--gold)' }}>
            ${balance.toFixed(2)}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 130 }}>
          <div style={{ fontSize: '.7rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Lifetime earned</div>
          <div style={{ fontFamily: 'var(--font-m)', fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-1)' }}>
            ${data.totalEarned.toFixed(2)}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 130 }}>
          <div style={{ fontSize: '.7rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Lifetime withdrawn</div>
          <div style={{ fontFamily: 'var(--font-m)', fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-1)' }}>
            ${data.totalWithdrawn.toFixed(2)}
          </div>
        </div>
      </div>

      {balance > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="number"
            step="0.01"
            placeholder="Amount to withdraw"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            style={{ flex: 1, minWidth: 160, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-0)', background: 'var(--bg-2)', color: 'var(--text-0)' }}
          />
          <button
            disabled={!validAmount || withdrawMut.isLoading}
            onClick={() => { setError(null); setSuccess(null); withdrawMut.mutate() }}
            className="btn btn-p"
            style={{ minWidth: 120 }}
          >
            {withdrawMut.isLoading ? 'Withdrawing…' : 'Withdraw'}
          </button>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 10, padding: 10, background: 'rgba(220,76,76,.1)', borderRadius: 6, color: 'var(--red)', fontSize: '.78rem' }}>
          {error}
          {error.toLowerCase().includes('set up payouts') && (
            <div style={{ marginTop: 8 }}>
              <a href="/payouts" style={{ display: 'inline-block', padding: '6px 14px', borderRadius: 6, background: 'var(--gold)', color: '#0a0f14', fontWeight: 600, fontSize: '.78rem', textDecoration: 'none' }}>
                Go to payouts setup →
              </a>
            </div>
          )}
        </div>
      )}
      {success && (
        <div style={{ marginTop: 10, padding: 10, background: 'rgba(38,167,90,.1)', borderRadius: 6, color: 'var(--green)', fontSize: '.78rem' }}>
          {success}
        </div>
      )}

      {data.perSublease.length > 1 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: '.78rem', color: 'var(--text-3)' }}>Per-sublease breakdown</summary>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.perSublease.map(s => (
              <div key={s.subleaseId} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: 'var(--bg-1)', borderRadius: 6, fontSize: '.78rem' }}>
                <span>{s.propertyName ?? 'Property'} · Unit {s.unitNumber ?? '—'}</span>
                <span style={{ fontFamily: 'var(--font-m)', fontWeight: 600 }}>${s.balance.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

// ── S256: Deposit portability section ─────────────────────────────────────
// Surfaces the carry-forward authorization at the tenant's current lease.
// Auto-hides when ineligible (no upcoming GAM lease, or no deposit row).
// On authorized state: shows confirmation + decline option.

interface PortabilityEligibility {
  eligible:             boolean
  reason:               string | null
  currentLeaseId:     string
  targetLeaseId:      string | null
  targetPropertyName: string | null
  targetLandlordId:   string | null
  depositId:           string | null
  depositAmount:       number | null
  heldBy:              'gam_escrow' | 'landlord' | null
}

function DepositPortabilitySection({ leaseId }: { leaseId: string }) {
  const qc = useQueryClient()
  const [showAuth, setShowAuth] = useState(false)
  const [signature, setSignature] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const { data: eligibility } = useQuery<PortabilityEligibility>(
    ['deposit-portability', leaseId],
    () => get<PortabilityEligibility>(`/tenants/me/deposit/portability/eligibility?leaseId=${leaseId}`),
  )

  // Read current portability state — when authorized/carried, hide the
  // "authorize" CTA and show a confirmation card with a decline option.
  const { data: meDeposit } = useQuery<any>(
    ['tenant-deposit-status', leaseId],
    () => get<any>('/tenants/me/deposit-interest').catch(() => null),
  )

  const authorize = useMutation(
    () => post('/tenants/me/deposit/portability/authorize', {
      depositId:     eligibility?.depositId,
      targetLeaseId: eligibility?.targetLeaseId,
      signature,
    }),
    {
      onSuccess: (r: any) => {
        if (r?.success === false) { setError(r?.error || 'Authorization failed'); return }
        setSuccess('Authorization recorded. Your deposit will carry forward when this lease ends.')
        setShowAuth(false)
        setSignature('')
        setAcknowledged(false)
        qc.invalidateQueries(['deposit-portability', leaseId])
        qc.invalidateQueries(['tenant-deposit-status', leaseId])
      },
      onError: (e: any) => setError(e?.message || 'Authorization failed'),
    },
  )

  const decline = useMutation(
    () => post('/tenants/me/deposit/portability/decline', {
      depositId: eligibility?.depositId,
    }),
    {
      onSuccess: () => {
        setSuccess('Authorization withdrawn. Your deposit will be returned through the standard process.')
        qc.invalidateQueries(['deposit-portability', leaseId])
        qc.invalidateQueries(['tenant-deposit-status', leaseId])
      },
    },
  )

  if (!eligibility) return null

  // Read portability_status if backend exposes it via /me/deposit-interest
  // (it returns the deposit row). Fall back to eligibility-only state.
  const portabilityStatus =
    meDeposit?.deposit?.portabilityStatus as
      | 'none' | 'pending_auth' | 'authorized' | 'carried_forward'
      | 'pending_transfer' | 'declined' | undefined

  // Carried-forward: terminal state, no UI needed (it's already done).
  if (portabilityStatus === 'carried_forward' || portabilityStatus === 'pending_transfer') return null

  // Authorized: show the confirmation card + decline option.
  if (portabilityStatus === 'authorized') {
    return (
      <div className="card" style={{ marginTop: 20, padding: 18, background: 'rgba(34,197,94,.06)', border: '1px solid rgba(34,197,94,.25)' }}>
        <h3 style={{ margin: '0 0 6px', color: 'var(--green)', fontSize: '1rem' }}>✓ Deposit carry-forward authorized</h3>
        <p style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.5 }}>
          When this lease ends, your deposit will transfer to {eligibility.targetPropertyName ?? 'your next GAM lease'} instead of being returned. Any unpaid balances at this lease will be deducted first.
        </p>
        <button onClick={() => decline.mutate()} disabled={decline.isLoading}
          style={{ padding: '6px 14px', borderRadius: 6, background: 'transparent', border: '1px solid var(--border-0)', color: 'var(--text-2)', fontSize: '.75rem', cursor: 'pointer' }}>
          {decline.isLoading ? 'Withdrawing…' : 'Withdraw authorization'}
        </button>
      </div>
    )
  }

  // Not eligible — hide.
  if (!eligibility.eligible) return null

  // Eligible — show the authorization CTA.
  return (
    <>
      <div className="card" style={{ marginTop: 20, padding: 18, background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.25)' }}>
        <h3 style={{ margin: '0 0 6px', color: 'var(--gold)', fontSize: '1rem' }}>💼 Carry your deposit forward</h3>
        <p style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.5 }}>
          You have an upcoming lease at <strong style={{ color: 'var(--text-0)' }}>{eligibility.targetPropertyName}</strong>.
          Instead of receiving a refund of your ${eligibility.depositAmount?.toFixed(2)} deposit at the end of this lease, you can transfer it forward to cover the deposit at your new lease.
          Any unpaid balances here will be deducted first.
        </p>
        <button onClick={() => { setError(null); setSuccess(null); setShowAuth(true) }}
          style={{ padding: '8px 18px', borderRadius: 8, background: 'var(--gold, #c9a227)', border: 'none', color: '#060809', fontWeight: 700, fontSize: '.82rem', cursor: 'pointer' }}>
          Authorize carry-forward
        </button>
        {success && <div style={{ marginTop: 10, color: 'var(--green)', fontSize: '.78rem' }}>{success}</div>}
      </div>

      {showAuth && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }} onClick={() => !authorize.isLoading && setShowAuth(false)}>
          <div style={{ background: 'var(--bg-1)', borderRadius: 12, padding: 24, width: 520, maxWidth: '92vw' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 14px', color: 'var(--text-0)' }}>Authorize deposit carry-forward</h3>

            <div style={{ background: 'rgba(245,158,11,.06)', border: '1px solid rgba(245,158,11,.25)', borderRadius: 8, padding: 12, marginBottom: 14, fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.55 }}>
              <div style={{ fontWeight: 600, color: 'var(--amber)', marginBottom: 6 }}>Before you sign — what you're agreeing to</div>
              <ul style={{ paddingLeft: 18, margin: 0 }}>
                <li>Your ${eligibility.depositAmount?.toFixed(2)} deposit transfers to your new lease at {eligibility.targetPropertyName} when this lease ends.</li>
                <li>Unpaid balances at this lease (rent, fees, damage) deduct from the deposit first; only the remainder carries forward.</li>
                <li>You waive your right to a refund of the deposit at this lease end. The deposit becomes collateral at the new lease.</li>
                <li>You can withdraw this authorization any time before the lease ends.</li>
              </ul>
              <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 8 }}>
                Check your local laws — some jurisdictions have specific tenant protections around deposit returns at tenancy end.
              </div>
            </div>

            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: '.7rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Signature (type your full name)</label>
              <input value={signature} onChange={e => setSignature(e.target.value)} placeholder="Your full name"
                style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid var(--border-0)', background: 'var(--bg-2)', color: 'var(--text-0)', fontFamily: 'cursive', fontSize: '1.1rem' }} />
            </div>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} style={{ marginTop: 3 }} />
              <span style={{ fontSize: '.78rem', color: 'var(--text-1)', fontWeight: 600 }}>I understand and agree to the terms above.</span>
            </label>

            {error && <div style={{ color: 'var(--red)', fontSize: '.78rem', marginBottom: 10 }}>{error}</div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setShowAuth(false)} disabled={authorize.isLoading}
                style={{ padding: '8px 14px', borderRadius: 8, background: 'transparent', border: '1px solid var(--border-0)', color: 'var(--text-2)', cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={() => authorize.mutate()}
                disabled={authorize.isLoading || !signature.trim() || !acknowledged}
                style={{ padding: '8px 14px', borderRadius: 8, background: 'var(--gold, #c9a227)', border: 'none', color: '#060809', fontWeight: 700, cursor: 'pointer' }}>
                {authorize.isLoading ? 'Submitting…' : 'Sign & authorize'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function SubleaseSection({ leaseId }: { leaseId: string }) {
  const qc = useQueryClient()
  const [showRequest, setShowRequest] = useState(false)
  const [showTerminate, setShowTerminate] = useState<TenantSublease | null>(null)
  const [form, setForm] = useState({
    sublesseeEmail: '',
    startDate: '',
    endDate: '',
    subMonthlyAmount: '',
    notes: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [terminateReason, setTerminateReason] = useState('')
  // S250: liability disclosure ack — required-checkbox gate on submit.
  // Tenant must explicitly acknowledge they remain on the master lease
  // before the sublease request goes through. Reset to false whenever
  // the modal closes.
  const [liabilityAck, setLiabilityAck] = useState(false)

  const { data: rows = [] } = useQuery<TenantSublease[]>(
    'tenant-subleases',
    () => get<TenantSublease[]>('/subleases'),
  )

  const requestMut = useMutation(
    () => post('/subleases', {
      masterLeaseId:    leaseId,
      sublesseeEmail:    form.sublesseeEmail,
      startDate:         form.startDate,
      endDate:           form.endDate || null,
      subMonthlyAmount: Number(form.subMonthlyAmount),
      notes:              form.notes || undefined,
    }),
    {
      onSuccess: (res: any) => {
        if (res?.success === false) {
          setError(res.error || 'Failed to request sublease')
          return
        }
        qc.invalidateQueries('tenant-subleases')
        setShowRequest(false)
        setForm({ sublesseeEmail: '', startDate: '', endDate: '', subMonthlyAmount: '', notes: '' })
        setLiabilityAck(false)
        setError(null)
      },
      onError: (e: any) => setError(e?.message || 'Failed to request sublease'),
    },
  )

  const terminateMut = useMutation(
    ({ id, reason }: { id: string; reason: string }) =>
      fetch(`${API_URL}/api/subleases/${id}/terminate`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('gam_tenant_token')}` },
        body: JSON.stringify({ reason }),
      }).then(r => r.json()),
    {
      onSuccess: () => {
        qc.invalidateQueries('tenant-subleases')
        setShowTerminate(null)
        setTerminateReason('')
      },
    },
  )

  const list = rows as TenantSublease[]
  const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString() : '—'
  const fmtMoney = (s: string) => `$${Number(s).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  return (
    <div style={{ marginTop: 24, padding: 16, background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: '.95rem', fontWeight: 700, color: 'var(--text-0)' }}>Subleases</h3>
        <button
          onClick={() => setShowRequest(true)}
          style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border-0)', background: 'transparent', color: 'var(--gold, #c9a227)', fontWeight: 600, fontSize: '.78rem', cursor: 'pointer' }}
        >
          + Request sublease
        </button>
      </div>

      {list.length === 0 ? (
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
          No subleases yet. If you need to sublease your unit, submit a request — your landlord will approve or deny.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {list.map(s => (
            <div key={s.id} style={{ padding: 10, background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 8, fontSize: '.82rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ color: 'var(--text-0)', fontWeight: 600 }}>
                    {s.sublessorName} → {s.sublesseeName ?? s.sublesseeEmail}
                  </div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
                    Unit {s.unitNumber} · {fmtDate(s.startDate)} → {fmtDate(s.endDate)} · {fmtMoney(s.subMonthlyAmount)}/mo
                  </div>
                  {s.status === 'pending_invite' && (
                    <div style={{ fontSize: '.7rem', color: 'var(--amber)', marginTop: 4 }}>
                      Invitation sent to {s.sublesseeEmail}. They have until {s.invitationExpiresAt ? fmtDate(s.invitationExpiresAt) : 'soon'} to accept and sign up.
                    </div>
                  )}
                  {s.status === 'awaiting_signatures' && s.subleaseDocumentId && (
                    <div style={{ marginTop: 6 }}>
                      <a href={`/sign/${s.subleaseDocumentId}`} style={{ display: 'inline-block', padding: '6px 12px', borderRadius: 6, background: 'var(--gold)', color: '#0a0f14', fontWeight: 600, fontSize: '.72rem', textDecoration: 'none' }}>
                        Sign sublease agreement →
                      </a>
                    </div>
                  )}
                  {s.terminatedReason && (
                    <div style={{ fontSize: '.7rem', color: 'var(--red)', marginTop: 4 }}>
                      Terminated: {s.terminatedReason}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{
                    padding: '2px 8px',
                    borderRadius: 999,
                    fontSize: '.68rem',
                    fontWeight: 600,
                    background:
                      s.status === 'active' ? 'rgba(34,197,94,.12)' :
                      s.status === 'pending' ? 'rgba(245,158,11,.12)' :
                      s.status === 'awaiting_signatures' ? 'rgba(201,162,39,.12)' :
                      s.status === 'pending_invite' ? 'rgba(59,130,246,.12)' :
                      'rgba(150,150,150,.12)',
                    color:
                      s.status === 'active' ? 'var(--green)' :
                      s.status === 'pending' ? 'var(--amber)' :
                      s.status === 'awaiting_signatures' ? 'var(--gold)' :
                      s.status === 'pending_invite' ? '#60a5fa' :
                      'var(--text-3)',
                  }}>
                    {s.status === 'pending_invite' ? 'awaiting accept' :
                     s.status === 'awaiting_signatures' ? 'sign required' :
                     s.status}
                  </span>
                  {s.status !== 'terminated' && s.status !== 'pending_invite' && s.status !== 'awaiting_signatures' && (
                    <button
                      onClick={() => setShowTerminate(s)}
                      style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-0)', background: 'transparent', color: 'var(--red)', fontSize: '.7rem', cursor: 'pointer' }}
                    >
                      End
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Request modal */}
      {showRequest && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }} onClick={() => !requestMut.isLoading && setShowRequest(false)}>
          <div style={{ background: 'var(--bg-1)', borderRadius: 12, padding: 20, width: 460, maxWidth: '92vw' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 14px', color: 'var(--text-0)' }}>Request sublease</h3>
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.5 }}>
              Your landlord will review and approve or deny. If the sublessee doesn't have a GAM account yet, we'll
              email them an invitation to sign up — your request stays pending until they accept.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={{ fontSize: '.7rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Sublessee email</label>
                <input
                  type="email"
                  value={form.sublesseeEmail}
                  onChange={e => setForm(s => ({ ...s, sublesseeEmail: e.target.value }))}
                  placeholder="sublessee@example.com"
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-0)', background: 'var(--bg-2)', color: 'var(--text-0)' }}
                />
              </div>
              <div>
                <label style={{ fontSize: '.7rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Start date</label>
                <input
                  type="date"
                  value={form.startDate}
                  onChange={e => setForm(s => ({ ...s, startDate: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-0)', background: 'var(--bg-2)', color: 'var(--text-0)' }}
                />
              </div>
              <div>
                <label style={{ fontSize: '.7rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>End date (optional)</label>
                <input
                  type="date"
                  value={form.endDate}
                  onChange={e => setForm(s => ({ ...s, endDate: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-0)', background: 'var(--bg-2)', color: 'var(--text-0)' }}
                />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={{ fontSize: '.7rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Monthly rent (sublessee pays)</label>
                <input
                  type="number"
                  step="0.01"
                  value={form.subMonthlyAmount}
                  onChange={e => setForm(s => ({ ...s, subMonthlyAmount: e.target.value }))}
                  placeholder="e.g. 1200.00"
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-0)', background: 'var(--bg-2)', color: 'var(--text-0)' }}
                />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={{ fontSize: '.7rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Note for landlord (optional)</label>
                <textarea
                  value={form.notes}
                  onChange={e => setForm(s => ({ ...s, notes: e.target.value }))}
                  rows={2}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-0)', background: 'var(--bg-2)', color: 'var(--text-0)' }}
                />
              </div>
            </div>

            {/* S250: liability disclosure — generic copy per CLAUDE.md
                no-state-specific-legal-language rule. Tenant must
                acknowledge before submitting. */}
            <div style={{
              background: 'rgba(245,158,11,.06)',
              border: '1px solid rgba(245,158,11,.25)',
              borderRadius: 8,
              padding: 12,
              marginBottom: 12,
              fontSize: '.75rem',
              color: 'var(--text-2)',
              lineHeight: 1.55,
            }}>
              <div style={{ fontWeight: 600, color: 'var(--amber)', marginBottom: 6 }}>
                Before you submit — understand what you're agreeing to
              </div>
              <ul style={{ paddingLeft: 18, margin: 0 }}>
                <li>You remain on the master lease. Your name stays on the original agreement with your landlord.</li>
                <li>You are joint-and-severally liable for rent if your sublessee defaults. If they miss a payment, the landlord can collect from you.</li>
                <li>Damage caused by your sublessee can be charged against your security deposit.</li>
                <li>Your landlord must approve every sublease before it activates.</li>
              </ul>
              <div style={{ marginTop: 8, fontSize: '.7rem', color: 'var(--text-3)' }}>
                Check your local laws — some jurisdictions add tenant protections or restrictions specific to subleasing.
              </div>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={liabilityAck}
                  onChange={e => setLiabilityAck(e.target.checked)}
                  style={{ marginTop: 2 }}
                />
                <span style={{ fontWeight: 600, color: 'var(--text-1)' }}>
                  I understand and accept these terms.
                </span>
              </label>
            </div>

            {error && <div style={{ color: 'var(--red)', fontSize: '.78rem', marginBottom: 10 }}>{error}</div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setShowRequest(false)}
                disabled={requestMut.isLoading}
                style={{ padding: '8px 14px', borderRadius: 8, background: 'transparent', border: '1px solid var(--border-0)', color: 'var(--text-2)', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={() => requestMut.mutate()}
                disabled={requestMut.isLoading || !form.sublesseeEmail || !form.startDate || !form.subMonthlyAmount || !liabilityAck}
                style={{ padding: '8px 14px', borderRadius: 8, background: 'var(--gold, #c9a227)', border: 'none', color: '#060809', fontWeight: 700, cursor: 'pointer' }}
              >
                {requestMut.isLoading ? 'Submitting…' : 'Submit request'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Terminate modal */}
      {showTerminate && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }} onClick={() => setShowTerminate(null)}>
          <div style={{ background: 'var(--bg-1)', borderRadius: 12, padding: 20, width: 420, maxWidth: '92vw' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 12px', color: 'var(--text-0)' }}>End sublease</h3>
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 12 }}>
              The other parties (sublessor / sublessee / landlord) will be notified.
            </div>
            <textarea
              value={terminateReason}
              onChange={e => setTerminateReason(e.target.value)}
              placeholder="Reason for ending the sublease"
              rows={3}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-0)', background: 'var(--bg-2)', color: 'var(--text-0)', marginBottom: 12 }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setShowTerminate(null)}
                style={{ padding: '8px 14px', borderRadius: 8, background: 'transparent', border: '1px solid var(--border-0)', color: 'var(--text-2)', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={() => terminateMut.mutate({ id: showTerminate.id, reason: terminateReason })}
                disabled={terminateMut.isLoading || !terminateReason.trim()}
                style={{ padding: '8px 14px', borderRadius: 8, background: 'var(--red)', border: 'none', color: 'white', fontWeight: 700, cursor: 'pointer' }}
              >
                {terminateMut.isLoading ? '…' : 'End sublease'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── S262: FlexDeposit accelerated / in_default banner ─────────────────────
// Renders at the top of LeasePage when the tenant's FlexDeposit plan
// has triggered the 2-strike acceleration. Two presentations:
//   accelerated: info-only banner (pull is in flight; 1–3 business days)
//   in_default:  warning banner with a manual "Pay full balance now" button
// Auto-hides for plans in 'active'/'completed' states.
function FlexDepositAcceleratedBanner() {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [retryStarted, setRetryStarted] = useState(false)

  const { data } = useQuery<any>(
    'tenant-flexdeposit',
    () => get<any>('/tenants/flexdeposit'),
  )
  const deposit = data?.deposit
  const status = deposit?.flexDepositPlanStatus as string | undefined

  const retry = useMutation(
    () => post('/tenants/flexdeposit/retry-acceleration', {}),
    {
      onSuccess: (r: any) => {
        if (r?.success === false) { setError(r?.error || 'Retry failed'); return }
        setError(null)
        setRetryStarted(true)
        qc.invalidateQueries('tenant-flexdeposit')
      },
      onError: (e: any) => setError(e?.message || 'Retry failed'),
    },
  )

  if (!deposit || (status !== 'accelerated' && status !== 'in_default')) return null

  const balance = Number(deposit.balanceDueTotal ?? 0)
  const sinceAccel = deposit.balanceDueFullAt
    ? Math.floor((Date.now() - new Date(deposit.balanceDueFullAt).getTime()) / 86400000)
    : 0

  if (status === 'accelerated') {
    return (
      <div style={{ padding:'14px 18px', background:'rgba(245,158,11,.06)', border:'1px solid rgba(245,158,11,.3)', borderRadius:12, marginBottom:20 }}>
        <div style={{ fontSize:'.78rem', fontWeight:700, color:'var(--gold, #c9a227)', marginBottom:6 }}>
          Deposit balance due in full — ${balance.toFixed(2)}
        </div>
        <div style={{ fontSize:'.78rem', color:'var(--text-2)' }}>
          We're collecting the full remaining deposit balance via ACH. This typically completes in 1–3 business days.
          {sinceAccel > 0 && ` Initiated ${sinceAccel} day${sinceAccel === 1 ? '' : 's'} ago.`}
        </div>
      </div>
    )
  }

  // in_default — manual retry available
  return (
    <div style={{ padding:'14px 18px', background:'rgba(239,68,68,.06)', border:'1px solid rgba(239,68,68,.3)', borderRadius:12, marginBottom:20 }}>
      <div style={{ display:'flex', alignItems:'flex-start', gap:14, flexWrap:'wrap' as const }}>
        <div style={{ flex:'1 1 280px' }}>
          <div style={{ fontSize:'.82rem', fontWeight:700, color:'var(--red, #ef4444)', marginBottom:4 }}>
            Deposit balance due in full — ${balance.toFixed(2)}
          </div>
          <div style={{ fontSize:'.76rem', color:'var(--text-2)' }}>
            The previous collection attempt did not clear. Pay the full balance now to bring your deposit current.
          </div>
        </div>
        <button
          onClick={() => retry.mutate()}
          disabled={retry.isLoading || retryStarted}
          style={{
            padding:'10px 20px', borderRadius:8, border:'none',
            background: retryStarted ? 'var(--bg-2)' : 'var(--gold, #c9a227)',
            color: retryStarted ? 'var(--text-3)' : '#060809',
            fontWeight:700, cursor: retryStarted ? 'default' : 'pointer',
            whiteSpace:'nowrap' as const,
          }}
        >
          {retry.isLoading ? 'Starting…' : retryStarted ? 'ACH pull initiated' : 'Pay full balance now'}
        </button>
      </div>
      {error && (
        <div style={{ marginTop:10, fontSize:'.74rem', color:'var(--red)', background:'rgba(239,68,68,.06)', padding:'8px 12px', borderRadius:6 }}>
          {error}
        </div>
      )}
    </div>
  )
}
