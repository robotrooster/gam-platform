import { useState, useRef, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from 'react-query'
import { Check, AlertCircle, ChevronLeft, ChevronRight, Upload, PenTool, ArrowRight } from 'lucide-react'

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
const tok = () => localStorage.getItem('gam_tenant_token')
function authFetch(path: string, opts: RequestInit = {}) {
  return fetch(API + '/api' + path, { ...opts, headers: { Authorization: 'Bearer ' + tok(), ...(opts.headers||{}) } })
}

const SIG_FONTS = [
  { id:'elegant',     name:'Elegant',        css:"italic 42px Georgia, serif" },
  { id:'terminator',  name:'Terminator',     css:"terminator" },
  { id:'matrix',      name:'Matrix',         css:"matrix" },
  { id:'bladerunner', name:'Blade Runner',   css:"bladerunner" },
  { id:'teamfury',    name:'Mad Max',        css:"teamfury" },
]
const FONT_LINK = ""

// Canvas-rendered signature preview — visually distinct styles regardless of system fonts
function SigPreview({ text, fontCss, small }: { text:string; fontCss:string; small?:boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Inject @font-face for custom fonts once
  useEffect(() => {
    if (document.querySelector('style[data-gam-fonts]')) return
    const style = document.createElement('style')
    style.setAttribute('data-gam-fonts','1')
    style.textContent = `
      @font-face { font-family: 'Terminator'; src: url('/fonts/terminator.ttf'); }
      @font-face { font-family: 'Matrix'; src: url('/fonts/matrix.ttf'); }
      @font-face { font-family: 'BladeRunner'; src: url('/fonts/bladerunner.ttf'); }
      @font-face { font-family: 'TeamFury'; src: url('/fonts/teamfury.ttf'); }
    `
    document.head.appendChild(style)
    // Preload fonts
    ;['Terminator','Matrix','BladeRunner','TeamFury'].forEach(f => {
      new FontFace(f, `url('/fonts/${f.toLowerCase()}.ttf')`).load().then(font => document.fonts.add(font)).catch(()=>{})
    })
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const w = small ? 130 : 250
    const h = small ? 54 : 64
    canvas.width = w; canvas.height = h
    ctx.clearRect(0, 0, w, h)

    const movieFonts: Record<string,string> = {
      terminator: 'Terminator',
      matrix: 'Matrix',
      bladerunner: 'BladeRunner',
      teamfury: 'TeamFury',
    }
    if (movieFonts[fontCss]) {
      const fontFamily = movieFonts[fontCss]
      const fontSize = small ? 26 : 34
      const fontStr = `${fontSize}px '${fontFamily}'`
      const drawIt = () => {
        ctx.clearRect(0,0,w,h)
        ctx.font = fontStr
        ctx.textBaseline = 'middle'
        ctx.fillStyle = '#1a1a1a'
        ctx.fillText(text, 6, h/2, w-12)
      }
      document.fonts.load(fontStr).then(drawIt).catch(drawIt)
    } else {
      ctx.font = fontCss
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#1a1a1a'
      if (fontCss.includes('Arial')) {
        ctx.transform(1, 0.02, -0.02, 1, 0, 0)
      }
      ctx.fillText(text, 8, h/2, w-16)
    }
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

  useEffect(() => {
    if (!document.querySelector('link[href*="googleapis"]')) {
      const link = document.createElement('link')
      link.rel='stylesheet'; link.href=FONT_LINK; document.head.appendChild(link)
    }
  }, [])

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
function SignatureSetup({ name, initials, onComplete }: { name:string; initials:string; onComplete:(sig:string,init:string,font:string)=>void }) {
  const [selectedFont, setSelectedFont] = useState(SIG_FONTS[0].id)
  const [typedName, setTypedName] = useState(name)
  const [tab, setTab] = useState<'type'|'upload'>('type')
  const [uploadedSig, setUploadedSig] = useState<string|null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const currentFont = SIG_FONTS.find(f=>f.id===selectedFont)!

  useEffect(() => {
    // Preload PDF.js while user picks font
    if (!(window as any).pdfjsLib) {
      const s = document.createElement('script')
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
      s.onload = () => { ;(window as any).pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js' }
      document.head.appendChild(s)
    }
  }, [])

  const handleComplete = () => {
    if (tab==='upload' && uploadedSig) { onComplete(uploadedSig, initials, currentFont.css); return }
    // Render to canvas dataURL for special fonts
    const movieFontMap: Record<string,string> = { terminator:'Terminator', matrix:'Matrix', bladerunner:'BladeRunner', teamfury:'TeamFury' }
    if (movieFontMap[currentFont.css]) {
      const fontFamily = movieFontMap[currentFont.css]
      const renderToDataUrl = (text: string, small: boolean) => {
        const canvas = document.createElement('canvas')
        const w = small?130:250; const h = small?54:64
        canvas.width=w; canvas.height=h
        const ctx = canvas.getContext('2d')!
        ctx.font = `${small?26:34}px '${fontFamily}'`
        ctx.textBaseline = 'middle'
        ctx.fillStyle = '#1a1a1a'
        ctx.fillText(text, 6, h/2, w-12)
        return canvas.toDataURL()
      }
      onComplete(renderToDataUrl(typedName,false), renderToDataUrl(initials,true), currentFont.css)
      return
    }
    onComplete(typedName, initials, currentFont.css)
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
                <label style={{ fontSize:'.68rem', fontWeight:600, color:'#999', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:5 }}>Your Name</label>
                <input value={typedName} onChange={e=>setTypedName(e.target.value)}
                  style={{ width:'100%', padding:'9px 13px', border:'1px solid #e5e7eb', borderRadius:9, fontSize:'1rem', outline:'none', boxSizing:'border-box' as const }}/>
              </div>
              <div style={{ marginBottom:16 }}>
                <label style={{ fontSize:'.68rem', fontWeight:600, color:'#999', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block', marginBottom:8 }}>Select Font Style</label>
                <div style={{ display:'flex', flexDirection:'column' as const, gap:5 }}>
                  {SIG_FONTS.map(font=>(
                    <div key={font.id} onClick={()=>setSelectedFont(font.id)}
                      style={{ padding:'10px 14px', border:`2px solid ${selectedFont===font.id?'#c9a227':'#e5e7eb'}`, borderRadius:9, cursor:'pointer', background:selectedFont===font.id?'#fffbf0':'white', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                      <SigPreview text={typedName||'Your Name'} fontCss={font.css}/>
                      <span style={{ fontSize:'.65rem', color:'#bbb' }}>{font.name}</span>
                    </div>
                  ))}
                </div>
              </div>
              {/* Preview both signature and initials */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:16 }}>
                <div style={{ padding:'12px', background:'#f8f8f5', borderRadius:9, textAlign:'center' as const }}>
                  <div style={{ fontSize:'.65rem', color:'#bbb', marginBottom:4 }}>SIGNATURE</div>
                  <SigPreview text={typedName||'Your Name'} fontCss={currentFont.css}/>
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
          <button onClick={handleComplete} disabled={tab==='type'?!typedName.trim():!uploadedSig}
            style={{ width:'100%', padding:'14px', borderRadius:11, border:'none', background:'#c9a227', color:'white', fontWeight:700, cursor:'pointer', fontSize:'.95rem' }}>
            Continue to Document →
          </button>
        </div>
      </div>
    </div>
  )
}

type Stage = 'signing'|'review'|'done'

export function SignPage() {
  const { documentId } = useParams<{ documentId:string }>()
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

  const { data, isLoading, error } = useQuery(['sign', documentId],
    () => authFetch('/esign/sign/'+documentId).then(r=>r.json()).then(r=>{ if(!r.success)throw new Error(r.error); return r.data }),
    { retry:false }
  )
  const submitMut = useMutation(
    () => authFetch('/esign/sign/'+documentId, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ fieldValues: Object.entries(fieldValues).map(([fieldId,value])=>({fieldId,value})) }) }).then(r=>r.json()),
    { onSuccess:(res:any)=>{ setAllDone(res.completed); setStage('done') } }
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
    if (!(window as any).pdfjsLib) {
      await new Promise<void>((resolve,reject) => {
        const s = document.createElement('script')
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
        s.onload = () => { ;(window as any).pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; resolve() }
        s.onerror = reject; document.head.appendChild(s)
      })
    }
    const fullUrl = url.startsWith('http') ? url : API+url
    const pdf = await (window as any).pdfjsLib.getDocument({ url:fullUrl, httpHeaders:{ Authorization:'Bearer '+tok() } }).promise
    pdfRef.current = pdf
    setPdfPageCount(pdf.numPages)
    await renderPageImperative(pdf, 1)
  }, [renderPageImperative])

  useEffect(() => { if (data?.document?.base_pdf_url && setupDone) loadPdf(data.document.base_pdf_url) }, [data, setupDone])
  useEffect(() => { if (pdfRef.current && setupDone) renderPageImperative(pdfRef.current, currentPage) }, [currentPage, setupDone])
  useEffect(() => {
    if (!data?.fields) return
    const today = new Date().toLocaleDateString()
    const updates: Record<string,string> = {}
    data.fields.filter((f:any)=>f.field_type==='date').forEach((f:any)=>{ updates[f.id]=today })
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

  const { signer, document:doc, fields } = data
  const allFields = fields || []
  const requiredFields = allFields.filter((f:any)=>f.required)
  const unfilledRequired = requiredFields.filter((f:any)=>!fieldValues[f.id]?.trim())
  const nextField = unfilledRequired[0]
  const pageFields = allFields.filter((f:any)=>f.page===currentPage)
  const currentPageRequired = pageFields.filter((f:any)=>f.required)
  const currentPageComplete = currentPageRequired.every((f:any)=>fieldValues[f.id]?.trim())
  const allFilled = unfilledRequired.length === 0

  const handleFieldClick = (field:any) => {
    if (field.field_type==='signature' && savedSig) {
      setFieldValues(p=>({...p,[field.id]:savedSig.value}))
      if(savedSig.font) setFieldFonts(p=>({...p,[field.id]:savedSig.font!}))
      setTimeout(()=>jumpToNext(field.id), 150)
      return
    }
    if (field.field_type==='initials' && savedInit) {
      setFieldValues(p=>({...p,[field.id]:savedInit.value}))
      if(savedInit.font) setFieldFonts(p=>({...p,[field.id]:savedInit.font!}))
      setTimeout(()=>jumpToNext(field.id), 150)
      return
    }
    if (field.field_type==='date') {
      setFieldValues(p=>({...p,[field.id]:new Date().toLocaleDateString()}))
      setTimeout(()=>jumpToNext(field.id), 150)
      return
    }
    setActiveField(field)
  }

  const handleSave = (value:string, font?:string) => {
    if (activeField.field_type==='signature') {
      setSavedSig({value,font})
      const initials = signer.name.split(' ').filter(Boolean).map((n:string)=>n[0].toUpperCase()).join('')
      setSavedInit({value:initials, font})
    }
    if (activeField.field_type==='initials') setSavedInit({value,font})
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
          <div style={{ fontSize:'.72rem', color:'var(--text-3)' }}>Signing as <strong style={{ color:'var(--gold,#c9a227)' }}>{signer.name}</strong> · {Object.keys(fieldValues).filter(k=>fieldValues[k]).length}/{requiredFields.length} fields complete</div>
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
            const colors: Record<string,string> = { signature:'#c9a227', initials:'#4a9eff', date:'#22c55e', text:'#a78bfa', checkbox:'#f59e0b', radio_group:'#ec4899' }
            const color = colors[f.field_type]||'#c9a227'
            return (
              <div key={f.id} id={'field-'+f.id}
                onClick={()=>!val&&handleFieldClick(f)}
                style={{
                  position:'absolute', left:f.x*s, top:f.y*s, width:f.width*s, height:f.height*s,
                  border:`2px solid ${val?'#22c55e':isNext?color:'#aaa'}`,
                  borderRadius:6, background:val?'rgba(34,197,94,.12)':isNext?`${color}20`:'rgba(180,180,180,.08)',
                  cursor:val?'default':'pointer', display:'flex', alignItems:'center', justifyContent:'center',
                  overflow:'hidden', boxSizing:'border-box' as const,
                  boxShadow:isNext&&!val?`0 0 0 3px ${color}55`:'', zIndex:val?4:isNext?6:5
                }}>
                {val ? (
                  (f.field_type==='signature'||f.field_type==='initials') && val.startsWith('data:')
                    ? <img src={val} style={{ width:'100%', height:'100%', objectFit:'contain' }}/>
                    : <span style={{ fontFamily:fieldFonts[f.id]||'inherit', fontSize:Math.max(9,f.height*s*0.5), color:'#1a1a1a', padding:4, whiteSpace:'nowrap' as const, overflow:'hidden', textOverflow:'ellipsis' }}>{val}</span>
                ) : (
                  <span style={{ fontSize:Math.max(7,f.height*s*0.28), color:isNext?color:'#aaa', fontWeight:700, pointerEvents:'none' }}>
                    {f.field_type==='signature'?'Sign':f.field_type==='initials'?'Initial':f.field_type==='date'?'Date':f.field_type==='checkbox'?'☐':'Click'}
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

      {activeField && (activeField.field_type==='signature'||activeField.field_type==='initials') && (
        <SignatureChooser name={signer.name} type={activeField.field_type} onSelect={handleSave} onClose={()=>setActiveField(null)}/>
      )}

      {activeField && activeField.field_type!=='signature' && activeField.field_type!=='initials' && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.6)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:'white', borderRadius:16, padding:24, maxWidth:360, width:'100%' }}>
            <div style={{ fontWeight:700, color:'#1a1a1a', marginBottom:14 }}>{activeField.label||activeField.field_type}</div>
            {activeField.field_type==='checkbox' && (
              <label style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer', padding:'11px', border:'1px solid #e5e7eb', borderRadius:8, marginBottom:14 }}>
                <input type="checkbox" defaultChecked={fieldValues[activeField.id]==='checked'} onChange={e=>setFieldValues(p=>({...p,[activeField.id]:e.target.checked?'checked':''}))} style={{ width:20, height:20 }}/>
                <span>{activeField.label||'I agree'}</span>
              </label>
            )}
            {activeField.field_type==='radio_group' && (
              <div style={{ display:'flex', flexDirection:'column' as const, gap:7, marginBottom:14 }}>
                {(activeField.options||'Yes,No').split(',').map((opt:string)=>opt.trim()).map((opt:string)=>(
                  <label key={opt} style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer', padding:'9px 13px', border:`2px solid ${fieldValues[activeField.id]===opt?'#c9a227':'#e5e7eb'}`, borderRadius:8 }}>
                    <input type="radio" checked={fieldValues[activeField.id]===opt} onChange={()=>setFieldValues(p=>({...p,[activeField.id]:opt}))} style={{ width:16, height:16 }}/>
                    <span style={{ fontWeight:fieldValues[activeField.id]===opt?600:400 }}>{opt}</span>
                  </label>
                ))}
              </div>
            )}
            {activeField.field_type==='text' && (
              <input defaultValue={fieldValues[activeField.id]||''} onChange={e=>setFieldValues(p=>({...p,[activeField.id]:e.target.value}))}
                placeholder={activeField.label||'Enter text'} style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:'.9rem', outline:'none', boxSizing:'border-box' as const, marginBottom:14 }}/>
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
                  <span style={{ fontSize:'.75rem', color:'#999', textTransform:'capitalize' as const }}>{f.field_type.replace('_',' ')} · p{f.page}</span>
                  {(f.field_type==='signature'||f.field_type==='initials') && fieldValues[f.id].startsWith('data:')
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
