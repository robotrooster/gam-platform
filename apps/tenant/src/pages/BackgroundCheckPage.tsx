import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation } from 'react-query'
import { Shield, Upload, Check, AlertCircle, Lock, Clock, XCircle } from 'lucide-react'

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
const tok = () => localStorage.getItem('gam_tenant_token')
const get = (p: string) => fetch(`${API}/api${p}`,{headers:{Authorization:`Bearer ${tok()}`}}).then(r=>r.json()).then(r=>r.data??r)
const post = (p: string, b: any) => fetch(`${API}/api${p}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${tok()}`},body:JSON.stringify(b)}).then(r=>r.json())
const uploadFile = async (p: string, file: File) => { const fd=new FormData(); fd.append('file',file); return fetch(`${API}/api${p}`,{method:'POST',headers:{Authorization:`Bearer ${tok()}`},body:fd}).then(r=>r.json()) }

const inp = { width:'100%', padding:'9px 12px', border:'1px solid #1e2530', borderRadius:8, background:'#0a0d10', color:'#eef1f8', fontSize:'.85rem', outline:'none', boxSizing:'border-box' as const }
const lbl = { fontSize:'.72rem', fontWeight:600 as const, color:'#4a5568', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block' as const, marginBottom:5 }
const STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ')
const STEPS = ['Personal Info','Address','Employment','ID Upload','Consent','Review & Pay']

export function BackgroundCheckPage() {
  const [step, setStep] = useState(0)
  const [idFile, setIdFile] = useState<File|null>(null)
  const [idUrl, setIdUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [idVerifying, setIdVerifying] = useState(false)
  const [incomeFiles, setIncomeFiles] = useState<{file:File,url:string}[]>([])
  const [incomeUploading, setIncomeUploading] = useState(false)
  const incomeRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const [phoneChecking, setPhoneChecking] = useState(false)
  const [phoneError, setPhoneError] = useState('')
  const [phoneValid, setPhoneValid] = useState(false)
  const [idNameMatch, setIdNameMatch] = useState<any>(null)
  const [showSsn, setShowSsn] = useState(false)
  const [paid, setPaid] = useState(false)
  const [startTime] = useState(Date.now())
  const [countdown, setCountdown] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const idCameraRef = useRef<HTMLInputElement>(null)
  const [suggestions, setSuggestions] = useState<any[]>([])
  const [showSugg, setShowSugg] = useState(false)
  const [addrVerified, setAddrVerified] = useState(false)
  const [userCoords, setUserCoords] = useState<{lat:number,lon:number}|null>(null)
  const [locationDenied, setLocationDenied] = useState(false)
  const [addrChecking, setAddrChecking] = useState(false)
  const [addrWarn, setAddrWarn] = useState(false)
  const searchTimer = useRef<any>(null)
  const verifyTimer = useRef<any>(null)
  const [form, setForm] = useState({ firstName:'', lastName:'', dob:'', ssn:'', street1:'', street2:'', city:'', state:'AZ', zip:'', years:'', empStatus:'employed', employer:'', empPhone:'', income:'', prevName:'', prevPhone:'', prevEmail:'', consentCredit:false, consentCriminal:false })
  const set = (k: string, v: any) => setForm(f=>({...f,[k]:v}))
  const { data: status, refetch } = useQuery('bg-status', () => get('/background/status'))
  const { data: me } = useQuery('tenant-me', () => get('/tenants/me'))
  const handleIdUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setIdFile(f);
    setUploading(true);
    const r = await uploadFile('/background/upload-id', f);
    if (r.success) {
      setIdUrl(r.data.url);
      setUploading(false);
      setIdVerifying(true);
      try {
        const v = await post('/background/verify-id-name', { idDocumentUrl: r.data.url, firstName: form.firstName, lastName: form.lastName, dateOfBirth: form.dob, zip: form.zip });
        if (v.success) setIdNameMatch(v.data);
      } catch (err) {
        console.error('[ID verify]', err);
      } finally {
        setIdVerifying(false);
      }
    } else {
      setUploading(false);
    }
  }
  const submitMut = useMutation(() => post('/background/submit', { firstName:form.firstName, lastName:form.lastName, dateOfBirth:form.dob, ssn:form.ssn.replace(/\D/g,''), street1:form.street1, street2:form.street2||null, city:form.city, state:form.state, zip:form.zip, yearsAtAddress:parseInt(form.years)||null, employmentStatus:form.empStatus, employerName:form.employer||null, employerPhone:form.empPhone||null, monthlyIncome:parseFloat(form.income)||null, prevLandlordName:form.prevName||null, prevLandlordPhone:form.prevPhone||null, prevLandlordEmail:form.prevEmail||null, idDocumentUrl:idUrl||null, incomeDocUrls:incomeFiles.map(f=>f.url), consentCredit:form.consentCredit, consentCriminal:form.consentCriminal, consentPool:form.consentPool, landlordId:(me as any)?.landlord_id||null, unitId:(me as any)?.unit_id||null, timeToComplete:Math.round((Date.now()-startTime)/1000), idVerification:idNameMatch||null }), { onSuccess: () => refetch() })
  const ssnFmt = (d: string) => d.length<=3?d:d.length<=5?d.slice(0,3)+'-'+d.slice(3):d.slice(0,3)+'-'+d.slice(3,5)+'-'+d.slice(5)
  const ssnDisplay = () => { const d=form.ssn; return showSsn?ssnFmt(d):ssnFmt(d).replace(/\d/g,'•') }
  const today = new Date()
  const minDob = new Date(today.getFullYear()-18,today.getMonth(),today.getDate())
  const validDob = form.dob?new Date(form.dob)<=minDob:false
  const validZip = /^\d{5}(-\d{4})?$/.test(form.zip)
  const validName = (n: string) => n.trim().replace(/[^a-zA-Z]/g,'').length>=4
  const ssnDigits = form.ssn.replace(/\D/g,'')
  const validSsn = (() => {
    const d = ssnDigits
    if (d.length !== 9) return false
    // Reserved/invalid area codes
    if (d.slice(0,3) === '000') return false
    if (d.slice(0,3) === '666') return false
    if (d.startsWith('9')) return false
    // Invalid group/serial
    if (d.slice(3,5) === '00') return false
    if (d.slice(5) === '0000') return false
    // All same digit
    if (/^(\d)\1{8}$/.test(d)) return false
    // Known fake sequences
    if (d === '123456789') return false
    if (d === '987654321') return false
    if (d === '111111111') return false
    if (d === '222222222') return false
    if (d === '333333333') return false
    if (d === '444444444') return false
    if (d === '555555555') return false
    if (d === '777777777') return false
    if (d === '888888888') return false
    if (d === '123123123') return false
    if (d === '321321321') return false
    // No 4+ of same digit in any position
    const counts: Record<string,number> = {}
    for (const ch of d) counts[ch] = (counts[ch]||0)+1
    if (Object.values(counts).some(v => v >= 5)) return false
    // No 3+ sequential ascending
    for (let i=0;i<=6;i++) {
      const a=parseInt(d[i]),b=parseInt(d[i+1]),c2=parseInt(d[i+2])
      if (b===a+1&&c2===b+1) return false
      if (b===a-1&&c2===b-1) return false
    }
    // Repeating 2-digit pattern (e.g. 121212121)
    if (/^(\d{2})\1{3}\d$/.test(d)||/^(\d{3})\1{2}\d{0,3}$/.test(d)) return false
    return true
  })()
  const validIncome = !form.income||(parseFloat(form.income)>0&&parseFloat(form.income)<1000000)
  const validPrev = form.prevName.trim().split(' ').filter(Boolean).length>=2&&validName(form.prevName)&&!!form.prevPhone&&phoneValid
  const MAPBOX_TOKEN = (import.meta as any).env?.VITE_MAPBOX_TOKEN || ''

  const fmtPhone = (v: string) => {
    const d = v.replace(/\D/g,'').slice(0,10)
    if (d.length<=3) return d
    if (d.length<=6) return d.slice(0,3)+'-'+d.slice(3)
    return d.slice(0,3)+'-'+d.slice(3,6)+'-'+d.slice(6)
  }

  const fmtZip = (v: string) => {
    const d = v.replace(/\D/g,'').slice(0,9)
    if (d.length<=5) return d
    return d.slice(0,5)+'-'+d.slice(5)
  }
  const validatePhone = async (phone: string) => {
    const digits = phone.replace(/\D/g,'')
    setPhoneValid(false)
    setPhoneError('')
    if (digits.length < 10) return
    // Basic format checks
    if (digits.length !== 10 && !(digits.length === 11 && digits[0]==='1')) {
      setPhoneError('Invalid phone number format'); return
    }
    const clean = digits.length===11 ? digits.slice(1) : digits
    // Area code cannot start with 0 or 1
    if (clean[0]==='0'||clean[0]==='1') { setPhoneError('Invalid area code'); return }
    // Obvious fake numbers
    if (/^(\d)\1{9}$/.test(clean)) { setPhoneError('Invalid phone number'); return }
    if (clean==='1234567890'||clean==='0987654321') { setPhoneError('Invalid phone number'); return }
    // Exchange code cannot start with 0 or 1
    if (clean[3]==='0'||clean[3]==='1') { setPhoneError('Invalid phone number'); return }
    // Check against system
    setPhoneChecking(true)
    try {
      const res = await fetch(API+'/api/background/check-phone?phone='+encodeURIComponent(clean), {
        headers:{Authorization:'Bearer '+tok()}
      })
      const data = await res.json()
      if (data.data?.taken) { setPhoneError(data.data.reason||'Phone number already in use'); return }
      setPhoneValid(true)
    } catch(e) { setPhoneValid(true) } // network error — don't block
    setPhoneChecking(false)
  }

  const searchAddr = async (val: string) => {
    if (val.length<3){setSuggestions([]);setShowSugg(false);return}
    try {
      const proximity = userCoords ? `&proximity=${userCoords.lon},${userCoords.lat}` : ''
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(val)}.json?access_token=${MAPBOX_TOKEN}&country=us&types=address&limit=6${proximity}`
      console.log('[MAPBOX] fetching:', url.slice(0,80))
      const res = await fetch(url)
      const data = await res.json()
      console.log('[MAPBOX] got features:', data.features?.length)
      setSuggestions(data.features||[])
      setShowSugg((data.features||[]).length>0)
    } catch(e) { console.error('[MAPBOX]',e); setSuggestions([]); setShowSugg(false) }
  }
  const pickSuggestion = (s: any) => {
    const ctx = s.context||[]
    const getCtx = (id: string) => ctx.find((c: any)=>c.id.startsWith(id))?.text||''
    const street = s.place_name ? s.place_name.split(',')[0] : s.text||''
    const city = getCtx('place')
    const stateShort = ctx.find((c: any)=>c.id.startsWith('region'))?.short_code?.replace('US-','')||form.state
    const zip = getCtx('postcode')
    setForm(f=>({...f, street1:street||f.street1, city:city||f.city, state:stateShort||f.state, zip:zip||f.zip}))
    setSuggestions([]); setShowSugg(false); setAddrVerified(true); setAddrWarn(false)
  }
  const verifyAddr = async (street: string, city: string, state: string, zip: string) => {
    if(!street||!city||!zip||zip.replace(/\D/g,'').length<5)return
    setAddrChecking(true);setAddrVerified(false);setAddrWarn(false)
    try {
      const params=new URLSearchParams({street,city,state,zip})
      const res=await fetch(API+'/api/background/verify-address?'+params)
      const data=await res.json()
      if(data.data?.valid){setAddrVerified(true);setAddrWarn(false)}
      else if(data.data?.error){/* unavailable */}
      else{setAddrWarn(true);setAddrVerified(false)}
    } catch(e){}
    setAddrChecking(false)
  }
  // Request geolocation when on address step
  useEffect(()=>{
    if(step===1 && !userCoords && !locationDenied){
      navigator.geolocation.getCurrentPosition(
        pos => setUserCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        () => setLocationDenied(true),
        { timeout: 8000, maximumAge: 300000 }
      )
    }
  },[step])

  useEffect(()=>{
    if(form.city&&form.zip&&validZip&&form.street1){
      clearTimeout(verifyTimer.current)
      verifyTimer.current=setTimeout(()=>verifyAddr(form.street1,form.city,form.state,form.zip),1000)
    }
    return()=>clearTimeout(verifyTimer.current)
  },[form.city,form.state,form.zip])
  // Countdown timer for denied status
  useEffect(() => {
    const check = (status as any)?.check
    if ((status as any)?.status !== 'denied' || !check?.decided_at) return
    const reapply = new Date(check.decided_at).getTime() + 90*24*60*60*1000
    const tick = () => {
      const diff = reapply - Date.now()
      if (diff <= 0) { setCountdown('Eligible now'); return }
      const d = Math.floor(diff/(24*60*60*1000))
      const h = Math.floor((diff%(24*60*60*1000))/(60*60*1000))
      const m = Math.floor((diff%(60*60*1000))/(60*1000))
      const s = Math.floor((diff%60000)/1000)
      setCountdown(d+'d '+String(h).padStart(2,'0')+'h '+String(m).padStart(2,'0')+'m '+String(s).padStart(2,'0')+'s')
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [(status as any)?.status, (status as any)?.check?.decided_at])

  const canNext=[
    !!(validName(form.firstName)&&validName(form.lastName)&&validDob&&validSsn),
    !!(form.street1.length>=5&&form.city.length>=2&&validZip&&(addrVerified||addrWarn)),
    !!(validPrev&&validIncome&&incomeFiles.length>=2&&form.income&&((['employed','part_time','self_employed'].includes(form.empStatus)?(form.employer&&form.empPhone):true))),
    !!(idUrl),
    !!(form.consentCredit&&form.consentCriminal),
    paid,
  ]
  if((status as any)?.status==='submitted')return(
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'60vh',gap:16,textAlign:'center',padding:32}}>
      <div style={{width:72,height:72,borderRadius:'50%',background:'rgba(245,158,11,.1)',border:'2px solid #f59e0b',display:'flex',alignItems:'center',justifyContent:'center'}}><Clock size={32} style={{color:'#f59e0b'}}/></div>
      <h2 style={{color:'#eef1f8',margin:0}}>Application Under Review</h2>
      <p style={{color:'#4a5568',maxWidth:380,lineHeight:1.6}}>Your application is being reviewed. You will receive an email once a decision has been made.</p>
      {process.env.NODE_ENV !== 'production' && (
        <button onClick={async()=>{await fetch(API+'/api/background/dev-reset',{method:'POST',headers:{Authorization:'Bearer '+tok(),'Content-Type':'application/json'}});window.location.reload()}} style={{marginTop:8,padding:'6px 14px',borderRadius:6,border:'1px solid #333',background:'#141a22',color:'#4a5568',fontSize:'.72rem',cursor:'pointer'}}>🔧 Dev: Reset Application</button>
      )}
    </div>
  )
  if((status as any)?.status==='approved')return(
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'60vh',gap:16,textAlign:'center',padding:32}}>
      <div style={{width:72,height:72,borderRadius:'50%',background:'rgba(34,197,94,.1)',border:'2px solid #22c55e',display:'flex',alignItems:'center',justifyContent:'center'}}><Check size={32} style={{color:'#22c55e'}}/></div>
      <h2 style={{color:'#eef1f8',margin:0}}>Application Approved</h2>
      <p style={{color:'#4a5568',maxWidth:380}}>Your background check has been approved. You now have full access to your tenant portal.</p>
    </div>
  )
  if((status as any)?.status==='denied'){
    const decidedAt = (status as any)?.check?.decided_at ? new Date((status as any).check.decided_at) : null
    const reapplyDate = decidedAt ? new Date(decidedAt.getTime() + 90*24*60*60*1000) : null
    const daysLeft = reapplyDate ? Math.max(0, Math.ceil((reapplyDate.getTime()-Date.now())/(24*60*60*1000))) : null
    return(
      <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'60vh',gap:16,textAlign:'center',padding:32}}>
        <div style={{width:72,height:72,borderRadius:'50%',background:'rgba(239,68,68,.1)',border:'2px solid #ef4444',display:'flex',alignItems:'center',justifyContent:'center'}}><XCircle size={32} style={{color:'#ef4444'}}/></div>
        <h2 style={{color:'#eef1f8',margin:0}}>Application Not Approved</h2>
        <p style={{color:'#4a5568',maxWidth:380,lineHeight:1.6}}>
          {(status as any)?.check?.decision_notes || 'Your application did not meet the requirements at this time.'}
        </p>
        {daysLeft !== null && daysLeft > 0 && countdown && (
          <div style={{padding:'16px 24px',background:'#0a0d10',border:'1px solid #1e2530',borderRadius:12}}>
            <div style={{fontSize:'.72rem',color:'#4a5568',marginBottom:8,textTransform:'uppercase',letterSpacing:'.08em'}}>Time until reapplication</div>
            <div style={{fontFamily:'monospace',fontSize:'5rem',fontWeight:900,color:'#eef1f8',letterSpacing:'.12em',lineHeight:1}}>{countdown}</div>
            {reapplyDate && <div style={{fontSize:'.68rem',color:'#4a5568',marginTop:6}}>Eligible: {reapplyDate.toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div>}
          </div>
        )}
        {daysLeft === 0 && (
          <button onClick={async()=>{await fetch(API+'/api/background/dev-reset',{method:'POST',headers:{Authorization:'Bearer '+tok(),'Content-Type':'application/json'}});window.location.reload()}} style={{padding:'10px 24px',borderRadius:8,border:'none',background:'#c9a227',color:'#060809',fontWeight:700,cursor:'pointer'}}>
            Reapply Now
          </button>
        )}
        {process.env.NODE_ENV !== 'production' && (
          <button onClick={async()=>{await fetch(API+'/api/background/dev-reset',{method:'POST',headers:{Authorization:'Bearer '+tok(),'Content-Type':'application/json'}});window.location.reload()}} style={{padding:'6px 14px',borderRadius:6,border:'1px solid #333',background:'#141a22',color:'#4a5568',fontSize:'.72rem',cursor:'pointer'}}>🔧 Dev: Reset Application</button>
        )}
      </div>
    )
  }
  return(
    <div style={{maxWidth:540,margin:'0 auto'}}>
      <div style={{textAlign:'center',marginBottom:24}}><div style={{width:52,height:52,borderRadius:'50%',background:'rgba(201,162,39,.1)',border:'2px solid #c9a227',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 10px'}}><Shield size={22} style={{color:'#c9a227'}}/></div><h1 style={{color:'#eef1f8',fontSize:'1.2rem',fontWeight:800,margin:'0 0 4px'}}>Background Check Application</h1><p style={{color:'#4a5568',fontSize:'.82rem',margin:0}}>Required before accessing your tenant portal</p></div>
      <div style={{display:'flex',gap:4,marginBottom:8}}>{STEPS.map((_,i)=><div key={i} style={{flex:1,height:3,borderRadius:2,background:i<=step?'#c9a227':'#141a22',transition:'background .2s'}}/>)}</div>
      <div style={{fontSize:'.7rem',color:'#4a5568',textAlign:'center',marginBottom:20}}>Step {step+1} of {STEPS.length} — {STEPS[step]}</div>
      <div style={{background:'#0a0d10',border:'1px solid #1e2530',borderRadius:12,padding:24,marginBottom:16}}>
        {step===0&&<div>
          <div style={{background:'rgba(239,68,68,.06)',border:'1px solid rgba(239,68,68,.2)',borderRadius:8,padding:'8px 12px',marginBottom:14,fontSize:'.72rem',color:'#ef4444',display:'flex',gap:6}}><Lock size={12} style={{flexShrink:0,marginTop:1}}/> SSN encrypted with AES-256 — never stored in plaintext</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
            <div><label style={lbl}>First Name *</label><input style={{...inp,borderColor:form.firstName&&!validName(form.firstName)?'#ef4444':undefined}} value={form.firstName} onChange={e=>set('firstName',e.target.value.replace(/[^a-zA-Z\-' ]/g,''))} placeholder="Jane"/></div>
            <div><label style={lbl}>Last Name *</label><input style={{...inp,borderColor:form.lastName&&!validName(form.lastName)?'#ef4444':undefined}} value={form.lastName} onChange={e=>set('lastName',e.target.value.replace(/[^a-zA-Z\-' ]/g,''))} placeholder="Smith"/></div>
          </div>
          <div style={{marginBottom:10}}><label style={lbl}>Date of Birth * (18+)</label><input style={{...inp,borderColor:form.dob&&!validDob?'#ef4444':undefined,colorScheme:'dark',cursor:'pointer'}} type="date" value={form.dob} onChange={e=>set('dob',e.target.value)} max={minDob.toISOString().split('T')[0]}/>{form.dob&&!validDob&&<div style={{color:'#ef4444',fontSize:'.68rem',marginTop:3}}>Must be at least 18 years old</div>}</div>
          <div><label style={lbl}>Social Security Number *</label><div style={{position:'relative'}}><input style={{...inp,borderColor:form.ssn&&!validSsn?'#ef4444':undefined}} type="text" inputMode="numeric" value={ssnDisplay()} onChange={e=>{const d=e.target.value.replace(/\D/g,'');set('ssn',d.slice(0,9))}} onFocus={()=>setShowSsn(true)} onBlur={()=>setShowSsn(false)} placeholder="XXX-XX-XXXX"/><span style={{position:'absolute',right:10,top:'50%',transform:'translateY(-50%)',fontSize:'.75rem',color:'#4a5568',cursor:'pointer'}} onClick={()=>setShowSsn(s=>!s)}>{showSsn?'🙈':'👁'}</span></div>{form.ssn&&!validSsn&&<div style={{color:'#ef4444',fontSize:'.68rem',marginTop:3}}>{ssnDigits.length<9?(9-ssnDigits.length)+' more digits required':'Invalid SSN format'}</div>}{validSsn&&<div style={{color:'#22c55e',fontSize:'.68rem',marginTop:3}}>✓ Format verified — stored encrypted</div>}</div>
        </div>}
        {step===1&&<div>
          {!userCoords && !locationDenied && (
            <div style={{marginBottom:12,padding:'10px 14px',background:'rgba(201,162,39,.06)',border:'1px solid rgba(201,162,39,.2)',borderRadius:8,fontSize:'.75rem',color:'#c9a227',display:'flex',alignItems:'center',gap:8}}>
              <span>📍</span> Allow location access for more accurate address suggestions
            </div>
          )}
          {locationDenied && (
            <div style={{marginBottom:12,padding:'8px 14px',background:'rgba(74,86,104,.08)',border:'1px solid #1e2530',borderRadius:8,fontSize:'.72rem',color:'#4a5568'}}>
              Location access denied — type your full address including city and state for best results
            </div>
          )}
          <div style={{marginBottom:10,position:'relative'}}>
            <label style={lbl}>Street Address *</label>
            <input style={{...inp,borderColor:addrVerified?'#22c55e':addrWarn?'#f59e0b':undefined}} value={form.street1} onChange={e=>{const v=e.target.value;set('street1',v);setAddrVerified(false);setAddrWarn(false);clearTimeout(searchTimer.current);searchTimer.current=setTimeout(()=>{console.log('[SEARCH] calling searchAddr with:', v);searchAddr(v)},250)}} onBlur={()=>setTimeout(()=>setShowSugg(false),400)} placeholder="2843 East Frontage Rd"/>
            {showSugg&&suggestions.length>0&&(
              <div style={{position:'absolute',top:'100%',left:0,right:0,background:'#0f1319',border:'1px solid #1e2530',borderRadius:8,zIndex:100,overflow:'hidden',boxShadow:'0 8px 24px rgba(0,0,0,.5)'}}>
                {suggestions.slice(0,5).map((s,i)=>(
                  <div key={i} onMouseDown={()=>pickSuggestion(s)} style={{padding:'9px 12px',cursor:'pointer',borderBottom:i<4?'1px solid #1e2530':'none'}} onMouseEnter={e=>(e.currentTarget as HTMLElement).style.background='#1a2030'} onMouseLeave={e=>(e.currentTarget as HTMLElement).style.background=''}>
                    <div style={{fontSize:'.8rem',fontWeight:600,color:'#eef1f8'}}>{s.place_name ? s.place_name.split(',')[0] : s.text || ''}</div>
                    <div style={{fontSize:'.7rem',color:'#4a5568',marginTop:2}}>{s.place_name ? s.place_name.split(',').slice(1,3).join(',').trim() : ''}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{minHeight:18,marginTop:4}}>
              {addrChecking&&<div style={{fontSize:'.7rem',color:'#4a5568'}}>Verifying address...</div>}
              {addrVerified&&!addrChecking&&<div style={{fontSize:'.72rem',color:'#22c55e'}}>✓ Address verified</div>}
              {addrWarn&&!addrChecking&&<div style={{fontSize:'.72rem',color:'#f59e0b'}}>⚠️ Address not found — double check before continuing</div>}
            </div>
          </div>
          <div style={{marginBottom:10}}><label style={lbl}>Apt / Unit</label><input style={inp} value={form.street2} onChange={e=>set('street2',e.target.value)} placeholder="Apt 4B"/></div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 70px 90px',gap:10,marginBottom:10}}>
            <div><label style={lbl}>City *</label><input style={inp} value={form.city} onChange={e=>{set('city',e.target.value);setAddrVerified(false)}} placeholder="Phoenix"/></div>
            <div><label style={lbl}>State</label><select style={inp} value={form.state} onChange={e=>{set('state',e.target.value);setAddrVerified(false)}}>{STATES.map(s=><option key={s} value={s}>{s}</option>)}</select></div>
            <div><label style={lbl}>ZIP *</label><input style={{...inp,borderColor:form.zip&&!validZip?'#ef4444':undefined}} value={form.zip} onChange={e=>{set('zip',fmtZip(e.target.value));setAddrVerified(false)}} placeholder="85031" maxLength={10}/>{form.zip&&!validZip&&<div style={{color:'#ef4444',fontSize:'.68rem',marginTop:3}}>5-digit ZIP required</div>}</div>
          </div>
          <div><label style={lbl}>Years at Address</label><input style={inp} type="number" min="0" value={form.years} onChange={e=>set('years',e.target.value)} placeholder="2"/></div>
        </div>}
        {step===2&&<div>
          <div style={{marginBottom:10}}><label style={lbl}>Income Source *</label><select style={inp} value={form.empStatus} onChange={e=>set('empStatus',e.target.value)}>{[['employed','Employment — Full-time'],['part_time','Employment — Part-time'],['self_employed','Self-Employment / Business'],['retired','Retirement / Pension'],['ssi_ssdi','SSI / SSDI / Disability'],['investment','Investment / Passive Income'],['student','Student Loans / Grants'],['other','Other Income Source']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div>
          {['employed','part_time','self_employed'].includes(form.empStatus)&&<>
            <div style={{marginBottom:10}}><label style={lbl}>Employer Name *</label><input style={{...inp,borderColor:form.employer===''&&['employed','part_time','self_employed'].includes(form.empStatus)?'#ef4444':undefined}} value={form.employer} onChange={e=>set('employer',e.target.value)} placeholder="Acme Corp"/></div>
            <div style={{marginBottom:10}}><label style={lbl}>Employer Phone *</label><input style={{...inp,borderColor:form.empPhone===''&&['employed','part_time','self_employed'].includes(form.empStatus)?'#ef4444':undefined}} type="tel" value={form.empPhone} onChange={e=>set('empPhone',fmtPhone(e.target.value))} placeholder="555-000-0000"/></div>
          </>}
          <div style={{marginBottom:14}}>
            <label style={lbl}>Proof of Income * <span style={{fontWeight:400,textTransform:'none' as const,color:'#4a5568'}}>(2 documents required — pay stubs, bank statements, award letters)</span></label>
            <div style={{display:'flex',gap:8,marginBottom:8}}>
              <button type="button" onClick={()=>incomeRef.current?.click()} style={{flex:1,padding:'10px',borderRadius:8,border:'1px dashed #1e2530',background:'#141a22',color:'#b8c4d8',cursor:'pointer',fontSize:'.78rem',display:'flex',alignItems:'center',justifyContent:'center',gap:6}}>
                <Upload size={14}/> Upload File
              </button>
              <button type="button" onClick={()=>cameraRef.current?.click()} style={{flex:1,padding:'10px',borderRadius:8,border:'1px dashed #1e2530',background:'#141a22',color:'#b8c4d8',cursor:'pointer',fontSize:'.78rem',display:'flex',alignItems:'center',justifyContent:'center',gap:6}}>
                📷 Take Photo
              </button>
            </div>
            <input ref={incomeRef} type="file" accept="image/jpeg,image/png,application/pdf" multiple style={{display:'none'}} onChange={async e=>{
              const files = Array.from(e.target.files||[]).slice(0, 2-incomeFiles.length)
              setIncomeUploading(true)
              for (const file of files) {
                const r = await uploadFile('/background/upload-id', file)
                if (r.success) setIncomeFiles(prev=>[...prev,{file,url:r.data.url}].slice(0,2))
              }
              setIncomeUploading(false)
            }}/>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{display:'none'}} onChange={async e=>{
              const file = e.target.files?.[0]
              if (!file || incomeFiles.length>=2) return
              setIncomeUploading(true)
              const r = await uploadFile('/background/upload-id', file)
              if (r.success) setIncomeFiles(prev=>[...prev,{file,url:r.data.url}].slice(0,2))
              setIncomeUploading(false)
            }}/>
            {incomeUploading && <div style={{fontSize:'.72rem',color:'#4a5568',marginBottom:6}}>Uploading...</div>}
            {incomeFiles.length>0 && (
              <div style={{display:'flex',flexDirection:'column' as const,gap:6,marginBottom:6}}>
                {incomeFiles.map((f,i)=>(
                  <div key={i} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 10px',background:'rgba(34,197,94,.06)',border:'1px solid rgba(34,197,94,.25)',borderRadius:7}}>
                    <Check size={12} style={{color:'#22c55e',flexShrink:0}}/>
                    <span style={{fontSize:'.75rem',color:'#22c55e',flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' as const}}>{f.file.name}</span>
                    <button onClick={()=>setIncomeFiles(prev=>prev.filter((_,j)=>j!==i))} style={{background:'none',border:'none',cursor:'pointer',color:'#ef4444',fontSize:'.75rem',flexShrink:0}}>✕</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{fontSize:'.68rem',color: incomeFiles.length>=2?'#22c55e':incomeFiles.length===1?'#f59e0b':'#4a5568'}}>
              {incomeFiles.length>=2?'✓ 2 documents uploaded':incomeFiles.length===1?'1 of 2 documents uploaded — add one more':'Upload or photograph 2 income documents'}
            </div>
          </div>
          <div style={{marginBottom:14}}><label style={lbl}>Monthly Income *</label><div style={{position:'relative'}}><span style={{position:'absolute',left:10,top:'50%',transform:'translateY(-50%)',color:'#4a5568'}}>$</span><input style={{...inp,paddingLeft:22,borderColor:(!form.income||!validIncome)?'#ef4444':undefined}} type="number" min="0" value={form.income} onChange={e=>set('income',e.target.value)} placeholder="3000"/></div>{form.income&&!validIncome&&<div style={{color:'#ef4444',fontSize:'.68rem',marginTop:3}}>Enter a valid amount</div>}</div>
          <div style={{borderTop:'1px solid #1e2530',paddingTop:14}}><div style={{fontSize:'.72rem',fontWeight:700,color:'#4a5568',textTransform:'uppercase',letterSpacing:'.07em',marginBottom:10}}>Previous Landlord *</div><div style={{marginBottom:8}}><label style={lbl}>Full Name *</label><input style={{...inp,borderColor:form.prevName&&!validPrev?'#ef4444':undefined}} value={form.prevName} onChange={e=>set('prevName',e.target.value)} placeholder="John Smith"/>{form.prevName&&!validPrev&&<div style={{color:'#ef4444',fontSize:'.68rem',marginTop:3}}>Enter first and last name</div>}</div><div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}><div>
                <label style={lbl}>Phone *</label>
                <input style={{...inp, borderColor:form.prevName&&!phoneValid&&form.prevPhone?'#ef4444':form.prevName&&phoneValid?'#22c55e':undefined}} type="tel" value={form.prevPhone}
                  onChange={e=>{set('prevPhone',e.target.value);setPhoneValid(false);setPhoneError('')}}
                  onChange={e=>{set('prevPhone',fmtPhone(e.target.value));setPhoneValid(false);setPhoneError('')}} onBlur={e=>form.prevName&&validatePhone(e.target.value)}
                  placeholder="(555) 000-0000"/>
                {phoneChecking && <div style={{fontSize:'.68rem',color:'#4a5568',marginTop:3}}>Checking...</div>}
                {phoneError && <div style={{fontSize:'.68rem',color:'#ef4444',marginTop:3}}>{phoneError}</div>}
                {phoneValid && <div style={{fontSize:'.68rem',color:'#22c55e',marginTop:3}}>✓ Valid phone number</div>}
                {form.prevName&&!form.prevPhone&&<div style={{color:'#ef4444',fontSize:'.68rem',marginTop:3}}>Required if previous landlord provided</div>}
              </div><div><label style={lbl}>Email</label><input style={inp} type="email" value={form.prevEmail} onChange={e=>set('prevEmail',e.target.value)}/></div></div></div>
        </div>}
        {step===3&&<div>
          <div style={{fontSize:'.82rem',color:'#b8c4d8',marginBottom:16,lineHeight:1.6}}>Upload a photo of your government-issued ID (driver's license, state ID, or passport). <strong style={{color:'#c9a227'}}>Required.</strong> Your name will be verified against this document.</div>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,application/pdf" style={{display:'none'}} onChange={handleIdUpload}/>
          <input ref={idCameraRef} type="file" accept="image/*" capture="environment" style={{display:'none'}} onChange={handleIdUpload}/>
          {idFile ? (
            <div style={{border:'2px dashed rgba(34,197,94,.4)',borderRadius:12,padding:24,textAlign:'center',background:'rgba(34,197,94,.04)'}}>
              <Check size={28} style={{color:'#22c55e',display:'block',margin:'0 auto 6px'}}/>
              <div style={{color:'#22c55e',fontWeight:600,fontSize:'.82rem',marginBottom:8}}>{idFile.name}</div>
              <div style={{display:'flex',gap:8,justifyContent:'center'}}>
                <button type="button" onClick={()=>fileRef.current?.click()} style={{padding:'6px 14px',borderRadius:7,border:'1px solid #1e2530',background:'#141a22',color:'#b8c4d8',cursor:'pointer',fontSize:'.75rem'}}>Replace File</button>
                <button type="button" onClick={()=>idCameraRef.current?.click()} style={{padding:'6px 14px',borderRadius:7,border:'1px solid #1e2530',background:'#141a22',color:'#b8c4d8',cursor:'pointer',fontSize:'.75rem'}}>📷 Retake Photo</button>
              </div>
            </div>
          ) : (
            <div style={{border:'2px dashed #1e2530',borderRadius:12,padding:24,background:'#141a22'}}>
              <div style={{textAlign:'center',marginBottom:16}}>
                <Upload size={28} style={{color:'#4a5568',display:'block',margin:'0 auto 8px'}}/>
                <div style={{color:'#b8c4d8',fontSize:'.82rem',fontWeight:600,marginBottom:4}}>Upload your government-issued ID</div>
                <div style={{color:'#4a5568',fontSize:'.7rem'}}>Driver's license, state ID, or passport</div>
              </div>
              <div style={{display:'flex',gap:10}}>
                <button type="button" onClick={()=>fileRef.current?.click()} style={{flex:1,padding:'10px',borderRadius:8,border:'1px dashed #1e2530',background:'#0d1117',color:'#b8c4d8',cursor:'pointer',fontSize:'.78rem',display:'flex',alignItems:'center',justifyContent:'center',gap:6}}>
                  <Upload size={14}/> Upload File
                </button>
                <button type="button" onClick={()=>idCameraRef.current?.click()} style={{flex:1,padding:'10px',borderRadius:8,border:'1px dashed #1e2530',background:'#0d1117',color:'#b8c4d8',cursor:'pointer',fontSize:'.78rem',display:'flex',alignItems:'center',justifyContent:'center',gap:6}}>
                  📷 Take Photo
                </button>
              </div>
              <div style={{textAlign:'center',marginTop:10,fontSize:'.68rem',color:'#4a5568'}}>JPEG, PNG, or PDF · Max 10MB · Required</div>
            </div>
          )}
          {idVerifying && <div style={{marginTop:12,fontSize:'.78rem',color:'#4a5568',display:'flex',alignItems:'center',gap:6}}><span style={{display:'inline-block',width:10,height:10,border:'2px solid #4a5568',borderTopColor:'#c9a227',borderRadius:'50%',animation:'spin 1s linear infinite'}}/> Verifying name against ID...</div>}
          {idNameMatch && !idVerifying && (
            <div style={{marginTop:12,padding:'12px 14px',background:idNameMatch.fullMatch?'rgba(34,197,94,.06)':idNameMatch.closeMatch?'rgba(245,158,11,.06)':'rgba(239,68,68,.06)',border:'1px solid '+(idNameMatch.fullMatch?'rgba(34,197,94,.25)':idNameMatch.closeMatch?'rgba(245,158,11,.25)':'rgba(239,68,68,.25)'),borderRadius:10}}>
              {idNameMatch.fullMatch && <div style={{color:'#22c55e',fontSize:'.78rem',fontWeight:600}}>✓ Name matches ID document</div>}
              {!idNameMatch.fullMatch && idNameMatch.closeMatch && idNameMatch.suggestedFirstName && (
                <div>
                  <div style={{color:'#f59e0b',fontSize:'.78rem',fontWeight:600,marginBottom:6}}>⚠️ Possible name mismatch — ID shows:</div>
                  <div style={{fontSize:'.82rem',color:'#eef1f8',marginBottom:8}}>{idNameMatch.suggestedFirstName} {idNameMatch.suggestedLastName}</div>
                  <button onClick={()=>{set('firstName',idNameMatch.suggestedFirstName||form.firstName);set('lastName',idNameMatch.suggestedLastName||form.lastName);setIdNameMatch({...idNameMatch,fullMatch:true})}} style={{padding:'6px 14px',borderRadius:7,border:'none',background:'#f59e0b',color:'#060809',fontWeight:700,fontSize:'.75rem',cursor:'pointer'}}>Use ID Name</button>
                </div>
              )}
              {!idNameMatch.fullMatch && !idNameMatch.closeMatch && idNameMatch.suggestedFirstName && (
                <div>
                  <div style={{color:'#ef4444',fontSize:'.78rem',fontWeight:600,marginBottom:6}}>✗ Name does not match ID — ID shows:</div>
                  <div style={{fontSize:'.82rem',color:'#eef1f8',marginBottom:8}}>{idNameMatch.suggestedFirstName} {idNameMatch.suggestedLastName}</div>
                  <button onClick={()=>{set('firstName',idNameMatch.suggestedFirstName||form.firstName);set('lastName',idNameMatch.suggestedLastName||form.lastName);setIdNameMatch({...idNameMatch,fullMatch:true})}} style={{padding:'6px 14px',borderRadius:7,border:'none',background:'#ef4444',color:'white',fontWeight:700,fontSize:'.75rem',cursor:'pointer'}}>Correct My Name</button>
                </div>
              )}
              {!idNameMatch.suggestedFirstName && <div style={{color:'#4a5568',fontSize:'.78rem'}}>Could not read name from ID — a staff member will verify manually.</div>}
              {idNameMatch.dobMismatch && <div style={{color:'#ef4444',fontSize:'.78rem',fontWeight:600,marginTop:6}}>✗ Date of birth does not match ID</div>}
              {idNameMatch.expired && <div style={{color:'#ef4444',fontSize:'.78rem',fontWeight:600,marginTop:6}}>⚠️ ID appears to be expired — please use a valid ID</div>}
              {idNameMatch.expirationDate && !idNameMatch.expired && <div style={{color:'#22c55e',fontSize:'.78rem',marginTop:6}}>✓ ID valid until {new Date(idNameMatch.expirationDate).toLocaleDateString()}</div>}
              {idNameMatch.idType && <div style={{color:'#4a5568',fontSize:'.72rem',marginTop:4}}>Document type: {idNameMatch.idType.replace(/_/g,' ')}</div>}
            </div>
          )}
        </div>}
        {step===4&&<div>
          {[{k:'consentCredit',l:'Credit Check',b:'I authorize my landlord and/or GAM to obtain a consumer credit report as part of my rental application.'},{k:'consentCriminal',l:'Criminal Background Check',b:'I authorize my landlord and/or GAM to conduct a criminal background check. All information I have provided is true and accurate.'}].map(consent=>(
            <label key={consent.k} style={{display:'flex',alignItems:'flex-start',gap:12,cursor:'pointer',marginBottom:14,padding:'14px 16px',background:(form as any)[consent.k]?'rgba(34,197,94,.06)':'#141a22',border:'1px solid '+((form as any)[consent.k]?'rgba(34,197,94,.25)':'#1e2530'),borderRadius:10}}>
              <input type="checkbox" checked={(form as any)[consent.k]} onChange={e=>set(consent.k,e.target.checked)} style={{width:18,height:18,marginTop:2,flexShrink:0}}/>
              <div><div style={{fontSize:'.82rem',fontWeight:700,color:'#eef1f8',marginBottom:4}}>{consent.l}</div><div style={{fontSize:'.75rem',color:'#4a5568',lineHeight:1.5}}>{consent.b}</div></div>
            </label>
          ))}
          <label style={{display:'flex',alignItems:'flex-start',gap:12,cursor:'pointer',marginBottom:14,padding:'14px 16px',background:form.consentPool?'rgba(201,162,39,.06)':'#141a22',border:'1px solid '+(form.consentPool?'rgba(201,162,39,.25)':'#1e2530'),borderRadius:10}}>
              <input type="checkbox" checked={form.consentPool} onChange={e=>set('consentPool',e.target.checked)} style={{width:18,height:18,marginTop:2,flexShrink:0}}/>
              <div>
                <div style={{fontSize:'.82rem',fontWeight:700,color:'#eef1f8',marginBottom:4}}>GAM Vacancy Matching <span style={{fontSize:'.7rem',fontWeight:400,color:'#c9a227'}}>(optional)</span></div>
                <div style={{fontSize:'.75rem',color:'#4a5568',lineHeight:1.5}}>I consent to GAM notifying me of matching vacancies from other landlords on the platform. My report will only be shared after I confirm interest and authorize access. I pay nothing additional.</div>
              </div>
            </label>
            <div style={{padding:'10px 14px',background:'#141a22',border:'1px solid #1e2530',borderRadius:8,fontSize:'.72rem',color:'#4a5568',lineHeight:1.5}}>By continuing I certify all information provided is accurate. Providing false information is grounds for immediate denial.</div>
        </div>}
        {step===5&&<div style={{textAlign:'center'}}>
          <div style={{fontSize:'2rem',marginBottom:8}}>💳</div>
          <div style={{fontSize:'1.1rem',fontWeight:800,color:'#eef1f8',marginBottom:6}}>Background Check Fee</div>
          <div style={{fontSize:'.82rem',color:'#4a5568',marginBottom:20}}>Payment required before your application is submitted.</div>
          <div style={{background:'#141a22',border:'1px solid #1e2530',borderRadius:12,padding:20,marginBottom:20,textAlign:'left'}}>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:8,fontSize:'.82rem'}}><span style={{color:'#4a5568'}}>Platform Background Check</span><span style={{color:'#eef1f8',fontFamily:'monospace'}}>$25.00</span></div>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:12,fontSize:'.82rem'}}><span style={{color:'#4a5568'}}>Processing & Report Fee</span><span style={{color:'#eef1f8',fontFamily:'monospace'}}>$20.00</span></div>
            <div style={{display:'flex',justifyContent:'space-between',borderTop:'1px solid #1e2530',paddingTop:12,fontWeight:700}}><span style={{color:'#eef1f8'}}>Total</span><span style={{color:'#c9a227',fontFamily:'monospace',fontSize:'1.1rem'}}>$45.00</span></div>
          </div>
          <div style={{background:'rgba(201,162,39,.06)',border:'1px solid rgba(201,162,39,.2)',borderRadius:8,padding:'10px 14px',marginBottom:16,fontSize:'.75rem',color:'#c9a227'}}>⚠️ Stripe is in test mode — no real charge will occur</div>
          {!paid?<button onClick={()=>setPaid(true)} style={{width:'100%',padding:'14px',borderRadius:10,border:'none',background:'#c9a227',color:'#060809',fontWeight:700,fontSize:'.95rem',cursor:'pointer'}}>💳 Pay $45.00 — Submit Application</button>:<div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:8,padding:'12px 20px',background:'rgba(34,197,94,.08)',border:'1px solid rgba(34,197,94,.25)',borderRadius:10,color:'#22c55e',fontWeight:700}}><Check size={18}/> Payment confirmed — click Submit below</div>}
          {submitMut.isError&&<div style={{color:'#ef4444',fontSize:'.75rem',marginTop:10,display:'flex',gap:6,justifyContent:'center'}}><AlertCircle size={12}/> Submission failed — please try again</div>}
        </div>}
      </div>
      <div style={{display:'flex',gap:10}}>
        <button onClick={()=>step>0&&setStep(s=>s-1)} disabled={step===0} style={{padding:'10px 20px',borderRadius:8,border:'1px solid #1e2530',background:'transparent',color:step===0?'#4a5568':'#b8c4d8',cursor:step===0?'not-allowed':'pointer',fontSize:'.85rem'}}>← Back</button>
        {step<STEPS.length-1?<button onClick={()=>setStep(s=>s+1)} disabled={!canNext[step]} style={{flex:1,padding:'12px',borderRadius:8,border:'none',background:canNext[step]?'#c9a227':'#141a22',color:canNext[step]?'#060809':'#4a5568',fontWeight:700,cursor:canNext[step]?'pointer':'not-allowed',fontSize:'.88rem'}}>Continue →</button>:<button onClick={()=>submitMut.mutate()} disabled={!paid||submitMut.isLoading} style={{flex:1,padding:'12px',borderRadius:8,border:'none',background:paid?'#c9a227':'#141a22',color:paid?'#060809':'#4a5568',fontWeight:700,cursor:paid?'pointer':'not-allowed',fontSize:'.88rem'}}>{submitMut.isLoading?'Submitting...':'🔒 Submit Application'}</button>}
      </div>
    </div>
  )
}
