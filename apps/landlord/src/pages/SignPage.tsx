import { useState, useRef, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from 'react-query'
import { Check, AlertCircle, ChevronLeft, ChevronRight, Upload, PenTool, ArrowRight } from 'lucide-react'
import { LEASE_COLUMN_CATEGORY, humanize } from '@gam/shared'
import { toast } from '../components/dialogs'
import { loadPdfjs } from '../lib/pdfjs'

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
const tok = () => localStorage.getItem('gam_token')
function authFetch(path: string, opts: RequestInit = {}) {
  return fetch(API + '/api' + path, { ...opts, headers: { Authorization: 'Bearer ' + tok(), ...(opts.headers||{}) } })
}

// S233: replaced movie-font signature options (Terminator / Matrix /
// Blade Runner / Mad Max) with system-fallback professional ones.
// Identical replacement to apps/tenant/src/pages/SignPage.tsx.
const SIG_FONTS = [
  { id:'elegant',  name:'Elegant',  css:"italic 42px Georgia, 'Times New Roman', serif" },
  { id:'script',   name:'Script',   css:"40px 'Snell Roundhand', 'Edwardian Script ITC', 'Apple Chancery', cursive" },
  { id:'cursive',  name:'Cursive',  css:"40px 'Brush Script MT', 'Lucida Handwriting', cursive" },
  { id:'classic',  name:'Classic',  css:"italic 40px 'Palatino Linotype', 'Book Antiqua', Palatino, serif" },
  { id:'modern',   name:'Modern',   css:"italic 38px Garamond, 'Times New Roman', serif" },
]

// Canvas-rendered signature preview — visually distinct styles regardless of system fonts
function SigPreview({ text, fontCss, small }: { text:string; fontCss:string; small?:boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const w = small ? 130 : 250
    const h = small ? 54 : 64
    canvas.width = w; canvas.height = h
    ctx.clearRect(0, 0, w, h)

    ctx.font = fontCss
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#1a1a1a'
    ctx.fillText(text, 8, h/2, w-16)
  }, [text, fontCss, small])
  return <canvas ref={canvasRef} style={{ display:'block', maxWidth:'100%' }}/>
}

function SignatureChooser({ name, type, onSelect, onClose }: { name:string; type:'signature'|'initials'; onSelect:(val:string,font?:string)=>void; onClose:()=>void }) {
  const initials = name.split(' ').filter(Boolean).map((n:string)=>n[0].toUpperCase()).join('')
  const [tab, setTab] = useState<'type'|'upload'>('type')
  const [selectedFont, setSelectedFont] = useState(SIG_FONTS[0].id)
  const [typedVal, setTypedVal] = useState(type==='initials' ? initials : name)
  const fileRef = useRef<HTMLInputElement>(null)
  const currentFont = SIG_FONTS.find(f=>f.id===selectedFont)

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.75)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'white', borderRadius:20, width:'100%', maxWidth:460, overflow:'hidden', boxShadow:'0 24px 80px rgba(0,0,0,.4)' }}>
        <div style={{ padding:'20px 24px 0' }}>
          <div style={{ fontWeight:800, fontSize:'1.05rem', color:'#1a1a1a', marginBottom:4 }}>{type==='signature'?'Create Your Signature':'Create Your Initials'}</div>
          <p style={{ fontSize:'.8rem', color:'#999', margin:'0 0 14px' }}>{type==='initials'?'Initials are locked to your name on file.':'Applied to all signature fields.'}</p>
          <div style={{ display:'flex', borderBottom:'2px solid #f0f0f0' }}>
            {(['type','upload'] as const).map(t=>(
              <button key={t} onClick={()=>setTab(t)} style={{ padding:'8px 18px', border:'none', background:'none', cursor:'pointer', fontSize:'.82rem', fontWeight:600, color:tab===t?'#c9a227':'#999', borderBottom:tab===t?'2px solid #c9a227':'2px solid transparent', marginBottom:-2 }}>
                {t==='type'?'Choose Style':'Upload Image'}
              </button>
            ))}
          </div>
        </div>
        <div style={{ padding:'18px 24px' }}>
          {tab==='type' && (
            <>
              <div style={{ marginBottom:12 }}>
                <label style={{ fontSize:'.68rem', fontWeight:600, color:'#999', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:5 }}>{type==='signature'?'Your Name':'Your Initials (locked)'}</label>
                {type==='initials'
                  ? <div style={{ padding:'9px 13px', background:'#f5f5f0', borderRadius:9, fontSize:'.95rem', color:'#888', border:'1px solid #eee' }}>{typedVal}</div>
                  : <input value={typedVal} onChange={e=>setTypedVal(e.target.value)} style={{ width:'100%', padding:'9px 13px', border:'1px solid #e5e7eb', borderRadius:9, fontSize:'1rem', outline:'none', boxSizing:'border-box' as const }}/>
                }
              </div>
              <div style={{ marginBottom:14 }}>
                <label style={{ fontSize:'.68rem', fontWeight:600, color:'#999', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:6 }}>Font Style</label>
                <div style={{ display:'flex', flexDirection:'column' as const, gap:5 }}>
                  {SIG_FONTS.map(font=>(
                    <div key={font.id} onClick={()=>setSelectedFont(font.id)}
                      style={{ padding:'10px 14px', border:`2px solid ${selectedFont===font.id?'#c9a227':'#e5e7eb'}`, borderRadius:9, cursor:'pointer', background:selectedFont===font.id?'#fffbf0':'white', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                      <SigPreview text={typedVal||(type==='initials'?'JD':'John Doe')} fontCss={font.css} small={type==='initials'}/>
                      <span style={{ fontSize:'.65rem', color:'#bbb' }}>{font.name}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ padding:'10px 14px', background:'#f8f8f5', borderRadius:9, textAlign:'center' as const, marginBottom:14 }}>
                <div style={{ fontSize:'.65rem', color:'#bbb', marginBottom:3 }}>Preview</div>
                <SigPreview text={typedVal||(type==='initials'?'JD':'John Doe')} fontCss={currentFont?.css||''} small={type==='initials'}/>
              </div>
              <button onClick={()=>onSelect(typedVal, currentFont?.css)} disabled={!typedVal.trim()}
                style={{ width:'100%', padding:'13px', borderRadius:11, border:'none', background:typedVal?'#c9a227':'#eee', color:typedVal?'white':'#aaa', fontWeight:700, cursor:typedVal?'pointer':'not-allowed', fontSize:'.9rem' }}>
                Use This {type==='signature'?'Signature':'Initial'}
              </button>
            </>
          )}
          {tab==='upload' && (
            <>
              <div onClick={()=>fileRef.current?.click()} style={{ border:'2px dashed #e5e7eb', borderRadius:11, padding:36, textAlign:'center' as const, cursor:'pointer', marginBottom:14 }}>
                <Upload size={30} style={{ color:'#ccc', display:'block', margin:'0 auto 8px' }}/>
                <div style={{ fontWeight:600, color:'#999', marginBottom:4 }}>Click to upload signature image</div>
                <div style={{ fontSize:'.72rem', color:'#bbb' }}>PNG or JPG recommended</div>
              </div>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg" style={{ display:'none' }}
                onChange={e=>{ const f=e.target.files?.[0]; if(!f)return; const r=new FileReader(); r.onload=ev=>onSelect(ev.target?.result as string); r.readAsDataURL(f) }}/>
            </>
          )}
        </div>
        <div style={{ padding:'0 24px 20px' }}>
          <button onClick={onClose} style={{ width:'100%', padding:'11px', borderRadius:10, border:'1px solid #e5e7eb', background:'white', cursor:'pointer', color:'#777' }}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
// ── UPFRONT SIGNATURE + INITIALS SETUP ───────────────────────
// S234: name + initials locked to the signer record (same fix as the
// tenant SignPage). See that file for the full reasoning.
function SignatureSetup({ name, initials, onComplete }: { name:string; initials:string; onComplete:(sig:string,init:string,font:string)=>void }) {
  const [selectedFont, setSelectedFont] = useState(SIG_FONTS[0].id)
  const [tab, setTab] = useState<'type'|'upload'>('type')
  const [uploadedSig, setUploadedSig] = useState<string|null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const currentFont = SIG_FONTS.find(f=>f.id===selectedFont)!

  useEffect(() => {
    // Preload PDF.js while user picks font
    loadPdfjs()
  }, [])

  const handleComplete = () => {
    if (tab==='upload' && uploadedSig) { onComplete(uploadedSig, initials, currentFont.css); return }
    onComplete(name, initials, currentFont.css)
  }

  return (
    <div style={{ maxWidth:480, margin:'0 auto', padding:'32px 20px' }}>
      <div style={{ textAlign:'center', marginBottom:24 }}>
        <div style={{ fontWeight:800, fontSize:'1.2rem', color:'var(--text-0)', marginBottom:6 }}>Set Up Your Signature</div>
        <p style={{ fontSize:'.83rem', color:'var(--text-3)', margin:0 }}>Choose your signature style once — it will be applied to all signature and initial fields.</p>
      </div>

      <div style={{ background:'white', borderRadius:16, overflow:'hidden', boxShadow:'0 4px 24px rgba(0,0,0,.15)' }}>
        <div style={{ padding:'20px 24px 0' }}>
          <div style={{ display:'flex', borderBottom:'2px solid #f0f0f0' }}>
            {(['type','upload'] as const).map(t=>(
              <button key={t} onClick={()=>setTab(t)} style={{ padding:'8px 18px', border:'none', background:'none', cursor:'pointer', fontSize:'.82rem', fontWeight:600, color:tab===t?'#c9a227':'#999', borderBottom:tab===t?'2px solid #c9a227':'2px solid transparent', marginBottom:-2 }}>
                {t==='type'?'⌨️ Choose Style':'📎 Upload Image'}
              </button>
            ))}
          </div>
        </div>

        <div style={{ padding:'20px 24px' }}>
          {tab==='type' && (
            <>
              <div style={{ marginBottom:14 }}>
                <label style={{ fontSize:'.68rem', fontWeight:600, color:'#999', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:5 }}>Your Name <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0, color:'#bbb' }}>(on file — contact your admin to update)</span></label>
                <div style={{ padding:'9px 13px', background:'#f5f5f0', borderRadius:9, fontSize:'1rem', color:'#666', border:'1px solid #eee' }}>{name}</div>
              </div>
              <div style={{ marginBottom:16 }}>
                <label style={{ fontSize:'.68rem', fontWeight:600, color:'#999', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:8 }}>Select Font Style</label>
                <div style={{ display:'flex', flexDirection:'column' as const, gap:5 }}>
                  {SIG_FONTS.map(font=>(
                    <div key={font.id} onClick={()=>setSelectedFont(font.id)}
                      style={{ padding:'10px 14px', border:`2px solid ${selectedFont===font.id?'#c9a227':'#e5e7eb'}`, borderRadius:9, cursor:'pointer', background:selectedFont===font.id?'#fffbf0':'white', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                      <SigPreview text={name} fontCss={font.css}/>
                      <span style={{ fontSize:'.65rem', color:'#bbb' }}>{font.name}</span>
                    </div>
                  ))}
                </div>
              </div>
              {/* Preview both signature and initials */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:16 }}>
                <div style={{ padding:'12px', background:'#f8f8f5', borderRadius:9, textAlign:'center' as const }}>
                  <div style={{ fontSize:'.65rem', color:'#bbb', marginBottom:4 }}>SIGNATURE</div>
                  <SigPreview text={name} fontCss={currentFont.css}/>
                </div>
                <div style={{ padding:'12px', background:'#f8f8f5', borderRadius:9, textAlign:'center' as const }}>
                  <div style={{ fontSize:'.65rem', color:'#bbb', marginBottom:4 }}>INITIALS</div>
                  <SigPreview text={initials} fontCss={currentFont.css} small/>
                </div>
              </div>
            </>
          )}
          {tab==='upload' && (
            <>
              <div onClick={()=>fileRef.current?.click()} style={{ border:'2px dashed #e5e7eb', borderRadius:11, padding:36, textAlign:'center' as const, cursor:'pointer', marginBottom:14, background:uploadedSig?'#f8fff8':'white' }}>
                {uploadedSig
                  ? <img src={uploadedSig} style={{ maxHeight:80, maxWidth:'100%', objectFit:'contain', display:'block', margin:'0 auto' }}/>
                  : <><Upload size={30} style={{ color:'#ccc', display:'block', margin:'0 auto 8px' }}/><div style={{ fontWeight:600, color:'#999' }}>Click to upload signature image</div><div style={{ fontSize:'.72rem', color:'#bbb', marginTop:4 }}>PNG or JPG · White/transparent background</div></>
                }
              </div>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg" style={{ display:'none' }}
                onChange={e=>{ const f=e.target.files?.[0]; if(!f)return; const r=new FileReader(); r.onload=ev=>setUploadedSig(ev.target?.result as string); r.readAsDataURL(f) }}/>
              <p style={{ fontSize:'.75rem', color:'#aaa', textAlign:'center' as const }}>Your initials will use the first font style with your initials derived from your name.</p>
            </>
          )}
          <button onClick={handleComplete} disabled={tab==='type'?false:!uploadedSig}
            style={{ width:'100%', padding:'14px', borderRadius:11, border:'none', background:'#c9a227', color:'white', fontWeight:700, cursor:'pointer', fontSize:'.95rem' }}>
            Continue to Document →
          </button>
        </div>
      </div>
    </div>
  )
}

type Stage = 'signing'|'review'|'done'

// S534: a 'date' field is auto-stampable only when it records WHEN the
// signer signed. Term dates (lease start/end) are deliberate inputs.
const isDateSignedField = (f: any) =>
  f.leaseColumn === 'date_signed' || (!f.leaseColumn && /date\s*signed|signed\s*date/i.test(f.label || ''))

export function SignPage() {
  const { token } = useParams<{ token:string }>()
  const navigate = useNavigate()
  const [stage, setStage]             = useState<Stage>('signing')
  const [fieldValues, setFieldValues] = useState<Record<string,string>>({})
  const [fieldFonts, setFieldFonts]   = useState<Record<string,string>>({})
  const [savedSig, setSavedSig]       = useState<{value:string,font?:string}|null>(null)
  const [savedInit, setSavedInit]     = useState<{value:string,font?:string}|null>(null)
  const [activeField, setActiveField] = useState<any>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [pdfPageCount, setPdfPageCount] = useState(1)
  const [pdfDims, setPdfDims]         = useState<{width:number,height:number}|null>(null)
  const [allDone, setAllDone]         = useState(false)
  const [setupDone, setSetupDone]     = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const pdfRef       = useRef<any>(null)
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const scaleRef     = useRef(1)

  const { data, isLoading, error } = useQuery(['sign', token],
    () => authFetch('/esign/sign/'+token).then(r=>r.json()).then(r=>{ if(!r.success)throw new Error(r.error); return r.data }),
    { retry:false }
  )
  // S535: surface API sign failures — pre-fix a {success:false} response
  // flowed into onSuccess and showed the success screen on a FAILED sign
  // (e.g. the landlord-pass lease-term completeness 400).
  const submitMut = useMutation(
    () => authFetch('/esign/sign/'+token, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ fieldValues: Object.entries(fieldValues).map(([fieldId,value])=>({fieldId,value})) }) })
      .then(r=>r.json())
      .then((r:any)=>{ if(!r.success) throw new Error(r.error || 'Signing failed'); return r }),
    { onSuccess:(res:any)=>{ setAllDone(res.data?.completed ?? res.completed); setStage('done') },
      onError:(e:any)=>{ setStage('signing'); toast.error(e?.message || 'Signing failed — try again.') } }
  )

  const renderPageImperative = useCallback(async (pdf:any, pageNum:number) => {
    if (!canvasRef.current || !containerRef.current) return
    const page = await pdf.getPage(pageNum)
    const containerWidth = containerRef.current.clientWidth
    const vp = page.getViewport({ scale:1 })
    const scale = containerWidth / vp.width
    scaleRef.current = scale
    const sv = page.getViewport({ scale })
    const canvas = canvasRef.current
    canvas.width = sv.width
    canvas.height = sv.height
    canvas.style.width = '100%'
    canvas.style.display = 'block'
    await page.render({ canvasContext:canvas.getContext('2d')!, viewport:sv }).promise
    setPdfDims({ width:sv.width, height:sv.height })
  }, [])

  const loadPdf = useCallback(async (url:string) => {
    const pdfjsLib = await loadPdfjs()
    const fullUrl = url.startsWith('http') ? url : API+url
    const pdf = await pdfjsLib.getDocument({ url:fullUrl, httpHeaders:{ Authorization:'Bearer '+tok() } }).promise
    pdfRef.current = pdf
    setPdfPageCount(pdf.numPages)
    await renderPageImperative(pdf, 1)
  }, [renderPageImperative])

  useEffect(() => { if (data?.document?.basePdfUrl && setupDone) loadPdf(data.document.basePdfUrl) }, [data, setupDone])
  useEffect(() => { if (pdfRef.current && setupDone) renderPageImperative(pdfRef.current, currentPage) }, [currentPage, setupDone])
  useEffect(() => {
    if (!data?.fields) return
    const today = new Date().toLocaleDateString()
    const updates: Record<string,string> = {}
    // S534 (Nic): load draft-time PREFILLED values (identity + carry-over
    // facts stamped at document creation) so they display and count —
    // pre-fix they rendered as empty fields the signer had to re-type.
    data.fields.forEach((f:any)=>{ if (f.value) updates[f.id] = f.value })
    // Auto-date ONLY the signature-date fields. Pre-fix EVERY date field
    // auto-filled with today — including Lease Start / Lease End on a
    // renewal, which let the landlord sign without ever choosing dates.
    data.fields
      .filter((f:any)=>f.fieldType==='date' && !updates[f.id] && isDateSignedField(f))
      .forEach((f:any)=>{ updates[f.id]=today })
    if (Object.keys(updates).length) setFieldValues(prev=>({...prev,...updates}))
  }, [data])

  if (isLoading) return <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'60vh', color:'var(--text-3)' }}>Loading document...</div>
  if (error||!data) return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:'60vh', gap:16, textAlign:'center', padding:32 }}>
      <AlertCircle size={40} style={{ color:'var(--red)' }}/>
      <h2 style={{ color:'var(--text-0)' }}>Invalid Signing Link</h2>
      <p style={{ color:'var(--text-3)', maxWidth:380 }}>This link may be invalid or not associated with your account.</p>
      <button className="btn btn-ghost" onClick={()=>navigate('/')}>Back to Portal</button>
    </div>
  )

  const { signer, document:doc, fields, readOnly } = data
  const allFields = fields || []
  // S556: conditional (nested) fields. A child radio is only shown/required
  // when its parent's current selection == the child's trigger option. Match a
  // child to its parent by (child.parentFieldId == parent.templateFieldId).
  const isFieldActive = (f:any): boolean => {
    if (!f.parentFieldId) return true
    const parent = allFields.find((p:any)=> p.templateFieldId && p.templateFieldId === f.parentFieldId)
    if (!parent) return true // parent not in this signer's set → always show
    return (fieldValues[parent.id] ?? parent.value ?? null) === f.parentOption
  }
  // Set a value and clear any children of this field whose trigger no longer
  // matches (Nic: clear on parent change — no stale sub-answer).
  const setFieldValue = (fieldId:string, value:string) => {
    setFieldValues(prev => {
      const next:Record<string,string> = { ...prev, [fieldId]: value }
      const self = allFields.find((x:any)=> x.id === fieldId)
      if (self?.templateFieldId) {
        for (const child of allFields) {
          if (child.parentFieldId === self.templateFieldId && child.parentOption !== value) delete next[child.id]
        }
      }
      return next
    })
  }

  // S235: read-only re-open. Same pattern as tenant SignPage —
  // backend serves terminal-state docs (and post-sign signers) with
  // readOnly:true so the landlord can re-open executed leases without
  // hitting the throw the GET previously emitted.
  if (readOnly) {
    return <ReadOnlyView doc={doc} signer={signer} fields={allFields} onBack={()=>navigate('/')} />
  }

  // Only ACTIVE fields count toward gating/rendering — a hidden conditional
  // child is neither shown nor required (S556).
  const activeFields = allFields.filter(isFieldActive)
  const requiredFields = activeFields.filter((f:any)=>f.required)
  const unfilledRequired = requiredFields.filter((f:any)=>!fieldValues[f.id]?.trim())
  const nextField = unfilledRequired[0]
  const pageFields = activeFields.filter((f:any)=>f.page===currentPage)
  const currentPageRequired = pageFields.filter((f:any)=>f.required)
  const currentPageComplete = currentPageRequired.every((f:any)=>fieldValues[f.id]?.trim())
  const allFilled = unfilledRequired.length === 0

  const handleFieldClick = (field:any) => {
    if (field.fieldType==='signature' && savedSig) {
      setFieldValues(p=>({...p,[field.id]:savedSig.value}))
      if(savedSig.font) setFieldFonts(p=>({...p,[field.id]:savedSig.font!}))
      setTimeout(()=>jumpToNext(field.id), 150)
      return
    }
    if (field.fieldType==='initials' && savedInit) {
      setFieldValues(p=>({...p,[field.id]:savedInit.value}))
      if(savedInit.font) setFieldFonts(p=>({...p,[field.id]:savedInit.font!}))
      setTimeout(()=>jumpToNext(field.id), 150)
      return
    }
    if (field.fieldType==='date' && isDateSignedField(field)) {
      // Signature-date: stamping today IS the intent.
      setFieldValues(p=>({...p,[field.id]:new Date().toLocaleDateString()}))
      setTimeout(()=>jumpToNext(field.id), 150)
      return
    }
    // Term dates (lease start/end) and everything else open the editor —
    // the signer chooses the value deliberately (S534).
    setActiveField(field)
  }

  const handleSave = (value:string, font?:string) => {
    if (activeField.fieldType==='signature') {
      setSavedSig({value,font})
      const initials = signer.name.split(' ').filter(Boolean).map((n:string)=>n[0].toUpperCase()).join('')
      setSavedInit({value:initials, font})
    }
    if (activeField.fieldType==='initials') setSavedInit({value,font})
    const filledId = activeField.id
    setFieldValues(p=>({...p,[filledId]:value}))
    if (font) setFieldFonts(p=>({...p,[filledId]:font}))
    setActiveField(null)
    setTimeout(()=>jumpToNext(filledId), 150)
  }

  const jumpToNext = (justFilledId: string) => {
    const stillUnfilled = requiredFields.filter((f:any) => f.id !== justFilledId && !fieldValues[f.id]?.trim())
    const next = stillUnfilled[0]
    if (!next) return
    if (next.page !== currentPage) {
      setCurrentPage(next.page)
      setTimeout(()=>pulseField(next.id), 600)
    } else {
      pulseField(next.id)
    }
  }

  const pulseField = (fieldId:string) => {
    const el = document.getElementById('field-'+fieldId)
    const container = containerRef.current
    if (!el || !container) return
    const top = el.offsetTop - container.clientHeight/2 + el.offsetHeight/2
    container.scrollTop = Math.max(0, top)
    el.style.transition = 'box-shadow .15s'
    el.style.boxShadow = '0 0 0 6px rgba(201,162,39,.8)'
    setTimeout(()=>{ if(el) el.style.boxShadow='' }, 1000)
  }

  const goToNextField = () => {
    if (!nextField) return
    if (nextField.page !== currentPage) {
      setCurrentPage(nextField.page)
      setTimeout(()=>pulseField(nextField.id), 600)
    } else {
      pulseField(nextField.id)
    }
  }
  // Show upfront signature setup if not done yet
  if (!setupDone && signer) {
    const initials = signer.name.split(' ').filter(Boolean).map((n:string)=>n[0].toUpperCase()).join('')
    return <SignatureSetup name={signer.name} initials={initials} onComplete={(sig,init,font)=>{ setSavedSig({value:sig,font}); setSavedInit({value:init,font}); setSetupDone(true) }}/>
  }

  if (stage==='done') return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:'60vh', gap:16, textAlign:'center', padding:32 }}>
      <div style={{ width:80, height:80, borderRadius:'50%', background:'rgba(34,197,94,.1)', border:'2px solid var(--green)', display:'flex', alignItems:'center', justifyContent:'center' }}><Check size={36} style={{ color:'var(--green)' }}/></div>
      <h2 style={{ color:'var(--text-0)', margin:0 }}>{allDone?'Document Fully Executed!':'Signatures Submitted!'}</h2>
      <p style={{ color:'var(--text-3)', maxWidth:400, lineHeight:1.6 }}>{allDone?'All parties have signed. A copy will be sent to your email.':'Your signatures have been recorded. The next party will be notified.'}</p>
      <div style={{ fontSize:'.75rem', color:'var(--text-3)' }}>Signed: {new Date().toLocaleString()} · UETA & E-SIGN Act compliant</div>
      <button className="btn btn-primary" onClick={()=>navigate('/lease')}>Back to Lease</button>
    </div>
  )

  return (
    <div>
      <div style={{ position:'sticky', top:0, zIndex:100, background:'var(--bg-1,#0f1319)', borderBottom:'1px solid var(--border-0)', padding:'10px 0', marginBottom:12, display:'flex', alignItems:'center', justifyContent:'space-between', gap:10 }}>
        <div>
          <div style={{ fontWeight:700, color:'var(--text-0)', fontSize:'.95rem' }}>{doc.title}</div>
          <div style={{ fontSize:'.72rem', color:'var(--text-3)' }}>Signing as <strong style={{ color:'var(--gold,#c9a227)' }}>{signer.name}</strong> · {requiredFields.length-unfilledRequired.length}/{requiredFields.length} required fields complete</div>
        </div>
        <div style={{ display:'flex', gap:8, flexShrink:0 }}>
          {pdfPageCount>1 && <>
            <button className="btn btn-ghost btn-sm" disabled={currentPage===1} onClick={()=>setCurrentPage(p=>p-1)}><ChevronLeft size={13}/></button>
            <span style={{ fontSize:'.75rem', color:'var(--text-3)', alignSelf:'center' }}>{currentPage}/{pdfPageCount}{!currentPageComplete&&pdfPageCount>1?' 🔒':''}</span>
            <button className="btn btn-ghost btn-sm" disabled={currentPage===pdfPageCount||!currentPageComplete} onClick={()=>setCurrentPage(p=>p+1)} title={!currentPageComplete?'Complete all fields on this page first':''}><ChevronRight size={13}/></button>
          </>}
          {!allFilled && nextField && <button onClick={goToNextField} className="btn btn-primary btn-sm">Next Field <ArrowRight size={13}/></button>}
          {allFilled && <button onClick={()=>setStage('review')} className="btn btn-primary">Review & Sign <ArrowRight size={14}/></button>}
        </div>
      </div>

      <div style={{ height:3, background:'var(--bg-3)', borderRadius:2, marginBottom:12, overflow:'hidden' }}>
        <div style={{ height:'100%', background:'var(--gold,#c9a227)', borderRadius:2, width:`${requiredFields.length?Math.round((requiredFields.length-unfilledRequired.length)/requiredFields.length*100):0}%`, transition:'width .3s' }}/>
      </div>

      <div ref={containerRef} style={{ position:'relative', background:'#525659', borderRadius:12, overflow:'auto', maxHeight:'78vh', marginBottom:16 }}>
        <div style={{ position:'relative', display:'inline-block', width:'100%' }}>
          <canvas ref={canvasRef}/>
          {pdfDims && pageFields.map((f:any) => {
            const s = scaleRef.current
            const val = fieldValues[f.id]||''
            const isNext = nextField?.id===f.id
            // S535 (Nic): IDENTITY fields (tenant, unit, property) are
            // system records stamped from the linked unit/tenant — never
            // free-typed on the document. A prefilled identity field is
            // locked; fixing a wrong name/unit happens on the record,
            // not the lease. LATE-FEE fields lock when the property has
            // a late-fee POLICY (identical terms for every tenant —
            // fair-housing); clicking one opens the policy explainer.
            // Only VALUED late-fee fields lock — a doc drafted before the
            // policy existed has empty ones the landlord must still fill.
            const isPolicyLateFee = !!data.propertyLateFee && !!f.leaseColumn && String(f.leaseColumn).startsWith('late_fee_') && !!val
            const locked = !!val && f.leaseColumn && LEASE_COLUMN_CATEGORY[f.leaseColumn as keyof typeof LEASE_COLUMN_CATEGORY] === 'identity'
            const colors: Record<string,string> = { signature:'#c9a227', initials:'#4a9eff', date:'#22c55e', text:'#a78bfa', checkbox:'#f59e0b', radio_group:'#ec4899' }
            const color = colors[f.fieldType]||'#c9a227'
            return (
              <div key={f.id} id={'field-'+f.id}
                // S534: filled fields stay CLICKABLE — renewal prefills are
                // defaults the landlord must be able to quick-edit.
                // S535: policy late-fee fields always open (the click shows
                // the read-only policy explainer, not an editor).
                onClick={()=>{ if (isPolicyLateFee) { setActiveField(f); return } if (!locked) handleFieldClick(f) }}
                title={locked?'Linked to the unit/tenant record — edit the record, not the document':isPolicyLateFee?'Set by the property late-fee policy — click for details':undefined}
                style={{
                  position:'absolute', left:f.x*s, top:f.y*s, width:f.width*s, height:f.height*s,
                  border:`2px solid ${val?'#22c55e':isNext?color:'#aaa'}`,
                  borderRadius:6, background:val?'rgba(34,197,94,.12)':isNext?`${color}20`:'rgba(180,180,180,.08)',
                  cursor:locked?'not-allowed':val?'default':'pointer', display:'flex', alignItems:'center', justifyContent:'center',
                  overflow:'hidden', boxSizing:'border-box' as const,
                  boxShadow:isNext&&!val?`0 0 0 3px ${color}55`:'', zIndex:val?4:isNext?6:5
                }}>
                {val ? (
                  (f.fieldType==='signature'||f.fieldType==='initials') && val.startsWith('data:')
                    ? <img src={val} style={{ width:'100%', height:'100%', objectFit:'contain' }}/>
                    : <span style={{ fontFamily:fieldFonts[f.id]||'inherit', fontSize:Math.max(9,f.height*s*0.5), color:'#1a1a1a', padding:4, whiteSpace:'nowrap' as const, overflow:'hidden', textOverflow:'ellipsis' }}>{val}</span>
                ) : (
                  <span style={{ fontSize:Math.max(7,f.height*s*0.28), color:isNext?color:'#aaa', fontWeight:700, pointerEvents:'none' }}>
                    {f.fieldType==='signature'?'Sign':f.fieldType==='initials'?'Initial':f.fieldType==='date'?'Date':f.fieldType==='checkbox'?'☐':'Click'}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {!allFilled && <div style={{ padding:'9px 14px', background:'rgba(201,162,39,.06)', border:'1px solid rgba(201,162,39,.2)', borderRadius:10, fontSize:'.77rem', color:'var(--gold,#c9a227)', display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
        <PenTool size={13}/> Click highlighted fields to sign. Use <strong>Next Field</strong> to jump to the next one.
      </div>}

      {activeField && (activeField.fieldType==='signature'||activeField.fieldType==='initials') && (
        <SignatureChooser name={signer.name} type={activeField.fieldType} onSelect={handleSave} onClose={()=>setActiveField(null)}/>
      )}

      {/* S535 (Nic): property late-fee POLICY explainer — read-only. The
          document's late-fee fields are stamped from the property policy
          so every tenant gets identical terms; the popup states exactly
          which day the fee starts given this lease's due day + grace. */}
      {activeField && data.propertyLateFee && String(activeField.leaseColumn||'').startsWith('late_fee_') && !!fieldValues[activeField.id] && (() => {
        const plf = data.propertyLateFee
        // S535: no policy row for this unit class → the lease has NO late
        // fees ('N/A') and the fields stay locked; the fix is a policy
        // row on the property, never a hand-typed value here.
        if (plf.none) {
          return (
            <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.6)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
              <div style={{ background:'white', borderRadius:16, padding:24, maxWidth:400, width:'100%' }}>
                <div style={{ fontWeight:700, color:'#1a1a1a', marginBottom:12 }}>No Late-Fee Policy — {plf.propertyName}{plf.unitType ? ` · ${humanize(plf.unitType)} units` : ''}</div>
                <div style={{ background:'#fef3c7', border:'1px solid #d97706', borderRadius:8, padding:'10px 12px', marginBottom:14, fontSize:'.8rem', color:'#78350f', lineHeight:1.55 }}>
                  No late-fee policy is set for this unit type, so this lease has <strong>no late fees</strong> ("N/A").
                  Late fees are never typed per lease — set a policy for {plf.unitType ? humanize(plf.unitType) : 'this'} units
                  on the property page and it applies to all future leases of that type.
                </div>
                <button onClick={()=>setActiveField(null)} style={{ width:'100%', padding:'10px', borderRadius:8, border:'none', background:'#c9a227', color:'white', fontWeight:700, cursor:'pointer' }}>Close</button>
              </div>
            </div>
          )
        }
        const dueDayField = allFields.find((x:any)=>x.leaseColumn==='rent_due_day')
        const dueDay = Number((dueDayField && (fieldValues[dueDayField.id] || dueDayField.value)) || 1)
        const grace = Number(plf.lateFeeGraceDays ?? 5)
        const startDay = dueDay + grace
        const ord = (n:number) => n + (n%10===1&&n%100!==11?'st':n%10===2&&n%100!==12?'nd':n%10===3&&n%100!==13?'rd':'th')
        const fee = plf.lateFeeInitialType === 'percent_of_rent'
          ? `${Number(plf.lateFeeInitialAmount)}% of rent`
          : `$${Number(plf.lateFeeInitialAmount).toFixed(2)}`
        return (
          <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.6)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
            <div style={{ background:'white', borderRadius:16, padding:24, maxWidth:400, width:'100%' }}>
              <div style={{ fontWeight:700, color:'#1a1a1a', marginBottom:12 }}>Late Fee Policy — {plf.propertyName}{plf.unitType ? ` · ${humanize(plf.unitType)} units` : ''}</div>
              <div style={{ background:'#fef3c7', border:'1px solid #d97706', borderRadius:8, padding:'10px 12px', marginBottom:12, fontSize:'.78rem', color:'#78350f', lineHeight:1.55 }}>
                Late fees are set per <strong>unit type</strong> at the property so every tenant of a
                class has identical terms (fair-housing). This document reflects that policy — to change
                it, edit the property&apos;s Late Fee Policy; changes apply to future leases of this type.
              </div>
              <div style={{ fontSize:'.82rem', color:'#1a1a1a', lineHeight:1.7, marginBottom:12 }}>
                Initial fee: <strong>{fee}</strong> · Grace period: <strong>{grace} day{grace===1?'':'s'}</strong>
                {plf.lateFeeAccrualAmount != null && plf.lateFeeAccrualPeriod && (
                  <> · Accrues {plf.lateFeeAccrualType==='percent_of_rent' ? `${Number(plf.lateFeeAccrualAmount)}%` : `$${Number(plf.lateFeeAccrualAmount).toFixed(2)}`} {plf.lateFeeAccrualPeriod}</>
                )}
              </div>
              <div style={{ background:'#f4f7f4', border:'1px solid #22c55e', borderRadius:8, padding:'10px 12px', marginBottom:14, fontSize:'.8rem', color:'#14532d', lineHeight:1.55 }}>
                Rent is due on the <strong>{ord(dueDay)}</strong>. With the {grace}-day grace period, the late
                fee starts on the <strong>{ord(startDay)}</strong> of each month — the {ord(startDay-1)} is the
                last day to pay without a fee.
              </div>
              <button onClick={()=>setActiveField(null)} style={{ width:'100%', padding:'10px', borderRadius:8, border:'none', background:'#c9a227', color:'white', fontWeight:700, cursor:'pointer' }}>Close</button>
            </div>
          </div>
        )
      })()}

      {activeField && activeField.fieldType!=='signature' && activeField.fieldType!=='initials' && !(data.propertyLateFee && String(activeField.leaseColumn||'').startsWith('late_fee_') && !!fieldValues[activeField.id]) && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.6)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:'white', borderRadius:16, padding:24, maxWidth:360, width:'100%' }}>
            <div style={{ fontWeight:700, color:'#1a1a1a', marginBottom:14 }}>{activeField.label||activeField.fieldType}</div>
            {/* S535 (Nic): renewal rent-increase quick presets — one click
                recalculates from the current rent; the input below stays
                for any flat custom amount. */}
            {activeField.leaseColumn === 'rent_amount' && Number(data.carriedRent) > 0 && (
              <div style={{ marginBottom:14 }}>
                <div style={{ fontSize:'.72rem', color:'#999', marginBottom:8 }}>
                  Current rent ${Number(data.carriedRent).toFixed(2)} — quick presets, or type a flat amount below:
                </div>
                <div style={{ display:'flex', gap:6, flexWrap:'wrap' as const }}>
                  {[['Keep', 0], ['+3%', 3], ['+5%', 5], ['+10%', 10]].map(([label, pct]) => {
                    const amt = (Number(data.carriedRent) * (1 + (pct as number) / 100))
                    return (
                      <button key={String(label)}
                        onClick={()=>{ setFieldValues(p=>({...p,[activeField.id]:amt.toFixed(2)})); const id=activeField.id; setActiveField(null); setTimeout(()=>jumpToNext(id),150) }}
                        style={{ padding:'8px 12px', borderRadius:8, border:'1.5px solid #c9a227', background:'#fdf8ec', color:'#78350f', fontWeight:700, fontSize:'.8rem', cursor:'pointer' }}>
                        {label} · ${amt.toFixed(2)}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            {/* S535 (Nic): '-' = month-to-month. The completeness gate
                requires a value in every term field on a signed document,
                so the dash is the explicit no-end-date entry. */}
            {activeField.leaseColumn === 'end_date' && (
              <div style={{ marginBottom:14 }}>
                <button
                  onClick={()=>{ setFieldValues(p=>({...p,[activeField.id]:'-'})); const id=activeField.id; setActiveField(null); setTimeout(()=>jumpToNext(id),150) }}
                  style={{ width:'100%', padding:'10px', borderRadius:8, border:'1.5px solid #c9a227', background:'#fdf8ec', color:'#78350f', fontWeight:700, fontSize:'.82rem', cursor:'pointer', marginBottom:8 }}>
                  Month-to-month — no end date (enters &quot;-&quot;)
                </button>
                <div style={{ background:'#fef3c7', border:'1px solid #d97706', borderRadius:8, padding:'8px 12px', fontSize:'.74rem', color:'#78350f', lineHeight:1.5 }}>
                  A <strong>&quot;-&quot;</strong> in the end date means the lease runs month-to-month with no fixed end. Pick a date below for a fixed term.
                </div>
              </div>
            )}
            {/* S534 (Nic): double-count guard overlay — the deposit on a
                renewal is already held; the number typed here can never
                re-bill the carried amount. */}
            {activeField.leaseColumn === 'security_deposit' && Number(data.carriedDeposit) > 0 && (
              <div style={{ background:'#fef3c7', border:'1px solid #d97706', borderRadius:8, padding:'10px 12px', marginBottom:14, fontSize:'.78rem', color:'#78350f', lineHeight:1.5 }}>
                <strong>${Number(data.carriedDeposit).toFixed(2)} is already held from the current lease</strong> and
                carries forward — it is never re-billed.
                Keep it at ${Number(data.carriedDeposit).toFixed(2)} to carry it unchanged.
                Enter a <strong>higher</strong> amount and the tenant is billed only the difference.
                A <strong>lower</strong> amount is not refunded automatically — process a partial
                return from the lease&apos;s Move-out tools.
              </div>
            )}
            {activeField.fieldType==='checkbox' && (
              <label style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer', padding:'11px', border:'1px solid #e5e7eb', borderRadius:8, marginBottom:14 }}>
                <input type="checkbox" defaultChecked={fieldValues[activeField.id]==='checked'} onChange={e=>setFieldValues(p=>({...p,[activeField.id]:e.target.checked?'checked':''}))} style={{ width:20, height:20 }}/>
                <span>{activeField.label||'I agree'}</span>
              </label>
            )}
            {activeField.fieldType==='radio_group' && (
              <div style={{ display:'flex', flexDirection:'column' as const, gap:7, marginBottom:14 }}>
                {(activeField.options||'Yes,No').split(',').map((opt:string)=>opt.trim()).map((opt:string)=>(
                  <label key={opt} style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer', padding:'9px 13px', border:`2px solid ${fieldValues[activeField.id]===opt?'#c9a227':'#e5e7eb'}`, borderRadius:8 }}>
                    <input type="radio" checked={fieldValues[activeField.id]===opt} onChange={()=>setFieldValue(activeField.id, opt)} style={{ width:16, height:16 }}/>
                    <span style={{ fontWeight:fieldValues[activeField.id]===opt?600:400 }}>{opt}</span>
                  </label>
                ))}
              </div>
            )}
            {activeField.fieldType==='text' && (
              <input defaultValue={fieldValues[activeField.id]||''} onChange={e=>setFieldValues(p=>({...p,[activeField.id]:e.target.value}))}
                placeholder={activeField.label||'Enter text'} style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:'.9rem', outline:'none', boxSizing:'border-box' as const, marginBottom:14 }}/>
            )}
            {activeField.fieldType==='date' && (
              // S534: term dates (lease start/end) are picked deliberately —
              // stored as the locale string the stamped PDF prints.
              <input type="date" onChange={e=>{ const v = e.target.value ? new Date(e.target.value + 'T12:00:00').toLocaleDateString() : ''; setFieldValues(p=>({...p,[activeField.id]:v})) }}
                style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:'.9rem', outline:'none', boxSizing:'border-box' as const, marginBottom:14 }}/>
            )}
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={()=>setActiveField(null)} style={{ flex:1, padding:'10px', borderRadius:8, border:'1px solid #e5e7eb', background:'white', cursor:'pointer' }}>Cancel</button>
              <button onClick={()=>setActiveField(null)} style={{ flex:1, padding:'10px', borderRadius:8, border:'none', background:'#c9a227', color:'white', fontWeight:700, cursor:'pointer' }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {stage==='review' && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.75)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:'white', borderRadius:20, maxWidth:460, width:'100%', padding:26 }}>
            <h2 style={{ color:'#1a1a1a', margin:'0 0 6px' }}>Review & Submit</h2>
            <p style={{ color:'#999', margin:'0 0 18px', fontSize:'.83rem' }}>Review your signatures before submitting.</p>
            <div style={{ display:'flex', flexDirection:'column' as const, gap:7, marginBottom:18 }}>
              {allFields.filter((f:any)=>fieldValues[f.id]).map((f:any)=>(
                <div key={f.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'7px 11px', background:'#f8f8f5', borderRadius:8 }}>
                  <span style={{ fontSize:'.75rem', color:'#999', textTransform:'capitalize' as const }}>{humanize(f.fieldType)} · p{f.page}</span>
                  {(f.fieldType==='signature'||f.fieldType==='initials') && fieldValues[f.id].startsWith('data:')
                    ? <img src={fieldValues[f.id]} style={{ height:28, maxWidth:110, objectFit:'contain' }}/>
                    : <span style={{ fontFamily:fieldFonts[f.id]||'inherit', fontSize:'.95rem', color:'#1a1a1a', fontWeight:600 }}>{fieldValues[f.id]}</span>
                  }
                  <Check size={13} style={{ color:'#22c55e', flexShrink:0 }}/>
                </div>
              ))}
            </div>
            <div style={{ padding:'11px 14px', background:'#fffdf5', border:'1px solid rgba(201,162,39,.3)', borderRadius:9, fontSize:'.73rem', color:'#999', lineHeight:1.6, marginBottom:18 }}>
              By clicking Submit, you confirm your electronic signature is legally binding under UETA and the federal E-SIGN Act.
            </div>
            <div style={{ display:'flex', gap:9 }}>
              <button onClick={()=>setStage('signing')} style={{ flex:1, padding:'12px', borderRadius:10, border:'1px solid #e5e7eb', background:'white', cursor:'pointer', fontWeight:600 }}>← Edit</button>
              <button onClick={()=>submitMut.mutate()} disabled={submitMut.isLoading}
                style={{ flex:2, padding:'12px', borderRadius:10, border:'none', background:'#c9a227', color:'white', fontWeight:800, cursor:'pointer' }}>
                {submitMut.isLoading?'Submitting...':'✓ Submit Signatures'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// S235: read-only re-open view. Mirror of apps/tenant/src/pages/SignPage.tsx
// — same shape, same backend payload contract.
function ReadOnlyView({
  doc, signer, fields, onBack,
}: {
  doc: any
  signer: any
  fields: any[]
  onBack: () => void
}) {
  const status = doc?.status as string
  const signerStatus = signer?.status as string
  const banner: { tone: 'green'|'gold'|'red'|'muted'; label: string; sub: string } =
    status === 'completed'         ? { tone:'green', label:'Fully executed', sub:'All parties have signed.' } :
    status === 'voided'            ? { tone:'red',   label:'Voided',         sub: doc?.voidReason || 'This document was voided and is no longer in effect.' } :
    status === 'execution_failed'  ? { tone:'red',   label:'Execution failed', sub:'A problem occurred during execution. Investigate via the GoldSign dashboard.' } :
    signerStatus === 'signed'      ? { tone:'green', label:'You signed',     sub:'Awaiting other parties to complete.' } :
    signerStatus === 'declined'    ? { tone:'red',   label:'You declined',   sub: signer?.declineReason ? `Reason: ${signer.declineReason}` : 'No reason was provided.' } :
                                     { tone:'muted', label:'Read-only',       sub:'' }
  const pdfUrl = doc?.executedPdfUrl || doc?.basePdfUrl
  const filledFields = (fields || []).filter((f:any) => f.value != null && String(f.value).trim() !== '')

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: '24px 16px' }}>
      <button onClick={onBack} className="btn btn-ghost btn-sm" style={{ marginBottom: 16 }}>← Back to portal</button>

      <div style={{
        display:'flex', alignItems:'flex-start', gap: 12, padding: '14px 18px', borderRadius: 12,
        background:
          banner.tone === 'green' ? 'rgba(34,197,94,.08)' :
          banner.tone === 'red'   ? 'rgba(220,76,76,.08)' :
          banner.tone === 'gold'  ? 'rgba(201,162,39,.08)' :
                                    'var(--bg-2)',
        border: `1px solid ${
          banner.tone === 'green' ? 'rgba(34,197,94,.25)' :
          banner.tone === 'red'   ? 'rgba(220,76,76,.25)' :
          banner.tone === 'gold'  ? 'rgba(201,162,39,.25)' :
                                    'var(--border-0)'
        }`,
        marginBottom: 14,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>
            {doc?.title || 'Document'} — <span style={{
              color:
                banner.tone === 'green' ? 'var(--green)' :
                banner.tone === 'red'   ? 'var(--red, #dc4c4c)' :
                banner.tone === 'gold'  ? 'var(--gold)' :
                                          'var(--text-2)',
            }}>{banner.label}</span>
          </div>
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
            {banner.sub}
          </div>
        </div>
      </div>

      {pdfUrl ? (
        <div style={{ background:'#525659', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
          <iframe
            src={pdfUrl}
            style={{ width: '100%', height: '78vh', border: 'none', display: 'block' }}
            title={doc?.title || 'Document'}
          />
        </div>
      ) : (
        <div style={{ padding: 20, background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10, color: 'var(--text-3)', fontSize: '.85rem', marginBottom: 16 }}>
          The document PDF is not available to display here.
        </div>
      )}

      {filledFields.length > 0 && (
        <div style={{ background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>
            Field values ({filledFields.length})
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {filledFields.map((f:any) => (
              <div key={f.id} style={{ padding: '6px 10px', background: 'var(--bg-2)', borderRadius: 6, fontSize: '.78rem' }}>
                <div style={{ color: 'var(--text-3)', fontSize: '.7rem' }}>{f.label || f.fieldType}</div>
                <div style={{ color: 'var(--text-1)' }}>
                  {f.fieldType === 'signature' || f.fieldType === 'initials'
                    ? <em style={{ color: 'var(--text-3)' }}>(signed)</em>
                    : String(f.value).slice(0, 80)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', textAlign: 'center' }}>
        UETA &amp; E-SIGN Act compliant · Read-only re-open
      </div>
    </div>
  )
}
