import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation } from 'react-query'
import { Shield, Upload, Check, AlertCircle, Lock, Clock, XCircle } from 'lucide-react'
import { loadStripe } from '@stripe/stripe-js'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'
import { CONSUMER_TERMS_URL, CONSUMER_PRIVACY_URL } from '../lib/marketing'

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'

// S577 (Nic): the APPLICANT pays for their own screen up front, on BOTH routes
// (applying to a landlord = routed on_behalf_of the landlord, who is just the
// property lock / merchant-of-record and nets $0; renter-pool = paid to GAM).
// So the Stripe Elements card step is restored in step 5.
const STRIPE_PK = (import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY || ''
const stripePromise = STRIPE_PK ? loadStripe(STRIPE_PK) : null

// Card form for the screening fee — mounted inside <Elements> with the
// PaymentIntent client secret. On success, hands the confirmed intent id up.
function ScreeningCardForm({ amountLabel, onPaid }: { amountLabel: string; onPaid: (intentId?: string) => void }) {
  const stripe = useStripe()
  const elements = useElements()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const pay = async () => {
    if (!stripe || !elements) return
    setBusy(true); setErr(null)
    const { error, paymentIntent } = await stripe.confirmPayment({ elements, redirect: 'if_required' })
    setBusy(false)
    if (error) { setErr(error.message || 'Payment failed'); return }
    if (paymentIntent && (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing')) {
      onPaid(paymentIntent.id)
    } else {
      setErr('Payment could not be completed — please try again.')
    }
  }
  return (
    <div style={{ textAlign: 'left' }}>
      <PaymentElement />
      {err && <div style={{ color: '#ef4444', fontSize: '.78rem', marginTop: 8 }}>{err}</div>}
      <button onClick={pay} disabled={busy || !stripe}
        style={{ width: '100%', marginTop: 14, padding: '12px', borderRadius: 8, border: 'none', background: busy ? '#141a22' : '#c9a227', color: busy ? '#4a5568' : '#060809', fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', fontSize: '.88rem' }}>
        {busy ? 'Processing…' : `Pay ${amountLabel}`}
      </button>
    </div>
  )
}

const tok = () => localStorage.getItem('gam_tenant_token')
const get = (p: string) => fetch(`${API}/api${p}`,{headers:{Authorization:`Bearer ${tok()}`}}).then(r=>r.json()).then(r=>r.data??r)
const uploadFile = async (p: string, file: File) => { const fd=new FormData(); fd.append('file',file); return fetch(`${API}/api${p}`,{method:'POST',headers:{Authorization:`Bearer ${tok()}`},body:fd}).then(r=>r.json()) }

const inp = { width:'100%', padding:'9px 12px', border:'1px solid #1e2530', borderRadius:8, background:'#0a0d10', color:'#eef1f8', fontSize:'.85rem', outline:'none', boxSizing:'border-box' as const }
const lbl = { fontSize:'.72rem', fontWeight:600 as const, color:'#4a5568', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block' as const, marginBottom:5 }
const STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ')
// S579: STEPS are provider-aware and computed INSIDE the component (see below).
// Checkr collects SSN/DOB/address/income/ID + FCRA consent on ITS OWN hosted
// flow, so GAM's page is minimal for Checkr; the mock/dev provider keeps the
// full legacy intake. The value below is only a fallback for the type.
const MOCK_STEPS = ['Personal Info','Address','Employment','ID Upload','Consent','Review & Pay']

export function BackgroundCheckPage() {
  const [step, setStep] = useState(0)
  const [idFile, setIdFile] = useState<File|null>(null)
  const [idUrl, setIdUrl] = useState('')
  const [, setUploading] = useState(false)
  const [incomeFiles, setIncomeFiles] = useState<{file:File,url:string}[]>([])
  const [incomeUploading, setIncomeUploading] = useState(false)
  const incomeRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const [phoneError, setPhoneError] = useState('')
  const [phoneValid, setPhoneValid] = useState(false)
  const [showSsn, setShowSsn] = useState(false)
  const [paid, setPaid] = useState(false)
  const [paymentIntentId, setPaymentIntentId] = useState<string>('')
  const [paymentClientSecret, setPaymentClientSecret] = useState<string>('')
  const [paymentTestMode, setPaymentTestMode] = useState(false)
  const [paymentInitError, setPaymentInitError] = useState<string>('')
  const [startTime] = useState(Date.now())
  const [countdown, setCountdown] = useState('')
  const [reapplyErr, setReapplyErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const idCameraRef = useRef<HTMLInputElement>(null)
  // S583 (Nic): removed the Mapbox address-autocomplete — it sent the applicant's
  // typed address to a third party (Mapbox), which GAM's no-external-data rule
  // doesn't allow. Address is now plain manual entry, verified only by GAM's own
  // /background/verify-address endpoint. (This whole legacy intake step is dropped
  // entirely under Checkr, which collects the address on its hosted flow.)
  const [addrVerified, setAddrVerified] = useState(false)
  const [addrChecking, setAddrChecking] = useState(false)
  const [addrWarn, setAddrWarn] = useState(false)
  const verifyTimer = useRef<any>(null)
  const [form, setForm] = useState({ firstName:'', lastName:'', dob:'', ssn:'', email:'', password:'', confirmPassword:'', street1:'', street2:'', city:'', state:'', zip:'', years:'', empStatus:'employed', employer:'', empPhone:'', income:'', prevName:'', prevPhone:'', prevEmail:'', consentCredit:false, consentCriminal:false, consentPool:false, acceptedTerms:false })
  const set = (k: string, v: any) => setForm(f=>({...f,[k]:v}))
  const { data: status, refetch } = useQuery('bg-status', () => get('/background/status'))
  const { data: me } = useQuery('tenant-me', () => get('/tenants/me'))
  // S551: fee breakdown + provider from the API. When the landlord screens
  // via Checkr Tenant, Checkr collects SSN/identity on ITS hosted apply flow
  // — GAM's form drops those fields entirely.
  const priceLandlordId = (me as any)?.landlordId || new URLSearchParams(window.location.search).get('landlordId') || ''
  const priceUnitId = (me as any)?.unitId || new URLSearchParams(window.location.search).get('unitId') || ''
  const { data: price } = useQuery(['bg-price', priceLandlordId, priceUnitId], () => get(`/background/price?landlordId=${priceLandlordId}&unitId=${priceUnitId}`))
  // S564: no landlord/property in scope → renter-pool intake. The applicant pays
  // GAM directly for their own portable report (the landlord route instead bills
  // the landlord, who owns the state-cap pass-through). Pool intake requires the
  // share authorization.
  const isSpeculative = !priceLandlordId
  const providerCollectsPii = !!(price as any)?.providerCollectsPii
  // S579: provider-aware step machine. Checkr → GAM only needs consent + payment
  // (name comes from the account; Checkr collects the rest on its hosted flow).
  // mock/dev → the full legacy intake.
  const STEPS = providerCollectsPii
    ? ['Consent', 'Review & Pay']
    : MOCK_STEPS
  // Checkr skips the "Personal Info" step, so seed the name the check needs from
  // the signed-in account.
  useEffect(() => {
    if (providerCollectsPii && me) {
      setForm(f => ({
        ...f,
        firstName: f.firstName || (me as any).firstName || '',
        lastName:  f.lastName  || (me as any).lastName  || '',
      }))
    }
  }, [providerCollectsPii, me])
  const handleIdUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setIdFile(f);
    setUploading(true);
    const r = await uploadFile('/background/upload-id', f);
    if (r.success) {
      // S554 (button-sweep bug #8): the /background/verify-id-name OCR call
      // was removed — the route never existed (404) and the submit route
      // ignored idVerification. The ID is uploaded here and verified
      // manually by staff downstream (blind-staff-entry standard).
      setIdUrl(r.data.url);
    }
    setUploading(false);
  }
  // Account creation is moved to the step-5 effect below so the
  // /background/payment-intent call (which requires auth) can run before
  // submit. By the time submitMut fires, a token already exists.
  const submitMut = useMutation(async () => {
    const token = tok()
    if (!token) throw new Error('Account not created — return to payment step')
    return fetch(`${API}/api/background/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      // S579: for Checkr, GAM's intake is minimal — name + payment + pool/terms
      // consent. Checkr collects DOB/SSN/address/income/ID + FCRA consent on its
      // own hosted flow, so null all of that here (the backend requires only name
      // + payment for Checkr). The mock/dev provider still sends the full set.
      body: JSON.stringify({
        firstName:form.firstName, lastName:form.lastName,
        dateOfBirth: providerCollectsPii ? null : form.dob,
        ssn: providerCollectsPii ? undefined : form.ssn.replace(/\D/g,''),
        street1: providerCollectsPii ? null : form.street1,
        street2: providerCollectsPii ? null : (form.street2||null),
        city: providerCollectsPii ? null : form.city,
        state: providerCollectsPii ? null : form.state,
        zip: providerCollectsPii ? null : form.zip,
        yearsAtAddress: providerCollectsPii ? null : (parseInt(form.years)||null),
        employmentStatus: providerCollectsPii ? null : form.empStatus,
        employerName: providerCollectsPii ? null : (form.employer||null),
        employerPhone: providerCollectsPii ? null : (form.empPhone||null),
        monthlyIncome: providerCollectsPii ? null : (parseFloat(form.income)||null),
        prevLandlordName: providerCollectsPii ? null : (form.prevName||null),
        prevLandlordPhone: providerCollectsPii ? null : (form.prevPhone||null),
        prevLandlordEmail: providerCollectsPii ? null : (form.prevEmail||null),
        idDocumentUrl: providerCollectsPii ? null : (idUrl||null),
        incomeDocUrls: providerCollectsPii ? [] : incomeFiles.map(f=>f.url),
        consentCredit: providerCollectsPii ? false : form.consentCredit,
        consentCriminal: providerCollectsPii ? false : form.consentCriminal,
        consentPool:form.consentPool,
        landlordId:(me as any)?.landlordId||null,
        unitId:(me as any)?.unitId||(new URLSearchParams(window.location.search).get('unitId'))||null,
        // S636: carried in by the property's QR code, so a walk-up's check
        // binds to the park they scanned at.
        propertyId:new URLSearchParams(window.location.search).get('propertyId')||null,
        timeToComplete:Math.round((Date.now()-startTime)/1000),
        applicantPaymentIntentId:paymentIntentId,
      })
    }).then(r => r.json())
  }, { onSuccess: () => refetch() })
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
    // S554 (button-sweep bug #12): the /background/check-phone "already in
    // use" lookup was removed — the route never existed (404) so it always
    // fell through to valid, and building it public would be a phone-
    // enumeration oracle. Format validation above is the real guard;
    // duplicate detection happens at account creation.
    setPhoneValid(true)
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
  // S578: this page is authenticated-only now. The account is created FIRST via
  // the dedicated signup page (with mandatory email-2FA); a prospect reaches the
  // check from INSIDE the gated portal. If we render without a session (e.g. a
  // direct hit on the public /background-check link), send them to sign up,
  // preserving any landlord/unit attribution in the URL.
  useEffect(()=>{
    if(!tok()){
      const qs = window.location.search
      window.location.replace('/signup' + qs)
    }
  },[])
  // S583: re-verify (GAM's own endpoint) whenever any address field changes —
  // street1 is now included since the Mapbox pick-to-verify path is gone.
  useEffect(()=>{
    if(form.city&&form.zip&&validZip&&form.street1){
      clearTimeout(verifyTimer.current)
      verifyTimer.current=setTimeout(()=>verifyAddr(form.street1,form.city,form.state,form.zip),1000)
    }
    return()=>clearTimeout(verifyTimer.current)
  },[form.street1,form.city,form.state,form.zip])
  // S84: on entering step 5, ensure tenant account exists (so we have a
  // token), then mint a Stripe PaymentIntent. Both flows write into
  // paymentClientSecret + paymentIntentId; the Elements form uses the
  // clientSecret to confirm, and submit attaches the intentId.
  useEffect(() => {
    if (STEPS[step] !== 'Review & Pay') return
    if (paymentClientSecret || paymentIntentId) return
    let cancelled = false
    ;(async () => {
      try {
        // S578: account is guaranteed to exist by now (created via signup/invite
        // before the portal renders this page). No inline account creation.
        const token = tok()
        if (!token) {
          const qs = window.location.search
          window.location.replace('/signup' + qs)
          return
        }
        const params = new URLSearchParams(window.location.search)
        const piRes = await fetch(`${API}/api/background/payment-intent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          // S551: same landlord/unit inputs as /submit so the state-cap fee
          // resolves identically on both calls.
          body: JSON.stringify({
            landlordId: (me as any)?.landlordId || params.get('landlordId') || null,
            unitId: (me as any)?.unitId || params.get('unitId') || null,
            propertyId: params.get('propertyId') || null,
          }),
        }).then(r => r.json())
        if (cancelled) return
        if (!piRes.success) {
          setPaymentInitError(piRes.error || 'Failed to initialize payment')
          return
        }
        if (piRes.data.feeWaived) {
          // Legacy no-charge path (not used under S577; kept as a safety net).
          setPaid(true)
          return
        }
        setPaymentClientSecret(piRes.data.clientSecret)
        setPaymentIntentId(piRes.data.intentId)
        setPaymentTestMode(!!piRes.data.testMode)
      } catch (e: any) {
        if (!cancelled) setPaymentInitError(e?.message || 'Failed to initialize payment')
      }
    })()
    return () => { cancelled = true }
  }, [step])

  // Countdown timer for denied status
  useEffect(() => {
    const check = (status as any)?.check
    if ((status as any)?.status !== 'denied' || !check?.decidedAt) return
    const reapply = new Date(check.decidedAt).getTime() + 90*24*60*60*1000
    const tick = () => {
      const diff = reapply - Date.now()
      if (diff <= 0) { setCountdown('Eligible now'); return }
      const d = Math.floor(diff/(24*60*60*1000))
      const h = Math.floor((diff%(24*60*60*1000))/(60*60*1000))
      const m = Math.floor((diff%(60*60*1000))/(60*1000))
      const s = Math.floor((diff%60000)/1000)
      const ms = Math.floor((diff%1000)/10)
      setCountdown(d+'d '+String(h).padStart(2,'0')+'h '+String(m).padStart(2,'0')+'m '+String(s).padStart(2,'0')+'s.'+String(ms).padStart(2,'0'))
    }
    tick()
    const interval = setInterval(tick, 50)
    return () => clearInterval(interval)
  }, [(status as any)?.status, (status as any)?.check?.decidedAt])

  // S579: keyed by step NAME so it works across both provider layouts.
  const canNext: Record<string, boolean> = {
    'Personal Info': !!(validName(form.firstName)&&validName(form.lastName)&&validDob&&(providerCollectsPii||validSsn)),
    'Address': !!(form.street1.length>=5&&form.city.length>=2&&validZip&&(addrVerified||addrWarn)),
    'Employment': !!(validPrev&&validIncome&&incomeFiles.length>=2&&form.income&&((['employed','part_time','self_employed'].includes(form.empStatus)?(form.employer&&form.empPhone):true))),
    'ID Upload': !!(providerCollectsPii||idUrl),
    // Checkr collects the FCRA credit/criminal consent on its OWN flow — GAM only
    // needs the pool-share (if speculative) + platform terms here.
    'Consent': !!((providerCollectsPii||(form.consentCredit&&form.consentCriminal))&&form.acceptedTerms&&(!isSpeculative||form.consentPool)),
    'Review & Pay': paid,
  }
  if((status as any)?.status==='submitted'){
    const chk = (status as any)?.check
    const applyUrl = chk?.status==='awaiting_applicant' ? (chk?.applicantRedirectUrl || null) : null
    return(
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'60vh',gap:16,textAlign:'center',padding:32}}>
      <div style={{width:72,height:72,borderRadius:'50%',background:'rgba(245,158,11,.1)',border:'2px solid #f59e0b',display:'flex',alignItems:'center',justifyContent:'center'}}><Clock size={32} style={{color:'#f59e0b'}}/></div>
      <h2 style={{color:'#eef1f8',margin:0}}>{applyUrl?'One More Step':'Application Under Review'}</h2>
      {applyUrl ? (
        <>
          <p style={{color:'#4a5568',maxWidth:400,lineHeight:1.6}}>Your application is in. To run your screening, complete the secure identity &amp; consent step with Checkr, our screening partner — it takes about two minutes. Checkr also emailed you this link.</p>
          <a href={applyUrl} target="_blank" rel="noopener noreferrer" style={{padding:'12px 28px',borderRadius:10,background:'#c9a227',color:'#060809',fontWeight:700,textDecoration:'none',fontSize:'.9rem'}}>Complete Screening with Checkr →</a>
        </>
      ) : (
        <p style={{color:'#4a5568',maxWidth:380,lineHeight:1.6}}>Your application is being reviewed. You will receive an email once a decision has been made.</p>
      )}
      {process.env.NODE_ENV !== 'production' && (
        <button onClick={async()=>{await fetch(API+'/api/background/dev-reset',{method:'POST',headers:{Authorization:'Bearer '+tok(),'Content-Type':'application/json'}});window.location.reload()}} style={{marginTop:8,padding:'6px 14px',borderRadius:6,border:'1px solid #333',background:'#141a22',color:'#4a5568',fontSize:'.72rem',cursor:'pointer'}}>🔧 Dev: Reset Application</button>
      )}
    </div>
  )}
  if((status as any)?.status==='approved')return(
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'60vh',gap:16,textAlign:'center',padding:32}}>
      <div style={{width:72,height:72,borderRadius:'50%',background:'rgba(34,197,94,.1)',border:'2px solid #22c55e',display:'flex',alignItems:'center',justifyContent:'center'}}><Check size={32} style={{color:'#22c55e'}}/></div>
      <h2 style={{color:'#eef1f8',margin:0}}>Application Approved</h2>
      <p style={{color:'#4a5568',maxWidth:380}}>Your background check has been approved. You now have full access to your tenant portal.</p>
    </div>
  )
  if((status as any)?.status==='denied'){
    const decidedAt = (status as any)?.check?.decidedAt ? new Date((status as any).check.decidedAt) : null
    const reapplyDate = decidedAt ? new Date(decidedAt.getTime() + 90*24*60*60*1000) : null
    const daysLeft = reapplyDate ? Math.max(0, Math.ceil((reapplyDate.getTime()-Date.now())/(24*60*60*1000))) : null
    return(
      <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'60vh',gap:16,textAlign:'center',padding:32}}>
        <div style={{width:72,height:72,borderRadius:'50%',background:'rgba(239,68,68,.1)',border:'2px solid #ef4444',display:'flex',alignItems:'center',justifyContent:'center'}}><XCircle size={32} style={{color:'#ef4444'}}/></div>
        <h2 style={{color:'#eef1f8',margin:0}}>Application Not Approved</h2>
        <p style={{color:'#4a5568',maxWidth:380,lineHeight:1.6}}>
          {(status as any)?.check?.decisionNotes || 'Your application did not meet the requirements at this time.'}
        </p>
        {daysLeft !== null && daysLeft > 0 && countdown && (
          <div style={{padding:'16px 24px',background:'#0a0d10',border:'1px solid #1e2530',borderRadius:12}}>
            <div style={{fontSize:'.72rem',color:'#4a5568',marginBottom:8,textTransform:'uppercase',letterSpacing:'.08em'}}>Time until reapplication</div>
            <div style={{display:'flex',alignItems:'flex-end',gap:4,flexWrap:'wrap',justifyContent:'center'}}>
              {countdown.replace('.', '|.').split(' ').map((part, i) => {
                const isMs = part.startsWith('.')
                return (
                  <div key={i} style={{textAlign:'center'}}>
                    <div style={{fontFamily:'monospace',fontSize:isMs?'2.5rem':'5rem',fontWeight:900,color:isMs?'#4a5568':'#eef1f8',letterSpacing:'.08em',lineHeight:1,marginBottom:isMs?'0.6rem':0}}>{part}</div>
                    <div style={{fontSize:'.55rem',color:'#4a5568',textTransform:'uppercase',letterSpacing:'.1em',marginTop:3}}>
                      {part.includes('d')&&!part.includes('h')?'days':part.includes('h')&&!part.includes('d')?'hrs':part.includes('m')&&!part.includes('s')?'min':part.includes('s')&&!part.startsWith('.')?'sec':isMs?'ms':''}
                    </div>
                  </div>
                )
              })}
            </div>
            {reapplyDate && <div style={{fontSize:'.68rem',color:'#4a5568',marginTop:6}}>Eligible: {reapplyDate.toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div>}
          </div>
        )}
        {daysLeft === 0 && (
          <>
            <button onClick={async()=>{
              // S554 (button-sweep bug #7): real applicant reapply route; the
              // 90-day cooldown is enforced server-side (dev-reset was admin-only → 403).
              setReapplyErr('')
              const r = await fetch(API+'/api/background/reapply',{method:'POST',headers:{Authorization:'Bearer '+tok(),'Content-Type':'application/json'}})
              if (r.ok) { window.location.reload() }
              else { const j = await r.json().catch(()=>({})); setReapplyErr(j?.error || 'Could not reapply yet') }
            }} style={{padding:'10px 24px',borderRadius:8,border:'none',background:'#c9a227',color:'#060809',fontWeight:700,cursor:'pointer'}}>
              Reapply Now
            </button>
            {reapplyErr && <div style={{fontSize:'.72rem',color:'#ef4444',marginTop:8}}>{reapplyErr}</div>}
          </>
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
        {STEPS[step]==='Personal Info'&&<div>
          {providerCollectsPii
            ? <div style={{background:'rgba(201,162,39,.06)',border:'1px solid rgba(201,162,39,.2)',borderRadius:8,padding:'8px 12px',marginBottom:14,fontSize:'.72rem',color:'#c9a227',display:'flex',gap:6}}><Lock size={12} style={{flexShrink:0,marginTop:1}}/> Sensitive details (SSN) are collected securely by Checkr, our screening partner — never by this form</div>
            : <div style={{background:'rgba(239,68,68,.06)',border:'1px solid rgba(239,68,68,.2)',borderRadius:8,padding:'8px 12px',marginBottom:14,fontSize:'.72rem',color:'#ef4444',display:'flex',gap:6}}><Lock size={12} style={{flexShrink:0,marginTop:1}}/> SSN encrypted with AES-256 — never stored in plaintext</div>}
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
            <div><label style={lbl}>First Name *</label><input style={{...inp,borderColor:form.firstName&&!validName(form.firstName)?'#ef4444':undefined}} value={form.firstName} onChange={e=>set('firstName',e.target.value.replace(/[^a-zA-Z\-' ]/g,''))} placeholder="Jane"/></div>
            <div><label style={lbl}>Last Name *</label><input style={{...inp,borderColor:form.lastName&&!validName(form.lastName)?'#ef4444':undefined}} value={form.lastName} onChange={e=>set('lastName',e.target.value.replace(/[^a-zA-Z\-' ]/g,''))} placeholder="Smith"/></div>
          </div>
          <div style={{marginBottom:10}}><label style={lbl}>Date of Birth * (18+)</label><input style={{...inp,borderColor:form.dob&&!validDob?'#ef4444':undefined,colorScheme:'dark',cursor:'pointer'}} type="date" value={form.dob} onChange={e=>set('dob',e.target.value)} max={minDob.toISOString().split('T')[0]}/>{form.dob&&!validDob&&<div style={{color:'#ef4444',fontSize:'.68rem',marginTop:3}}>Must be at least 18 years old</div>}</div>
          {!providerCollectsPii&&<div><label style={lbl}>Social Security Number *</label><div style={{position:'relative'}}><input style={{...inp,borderColor:form.ssn&&!validSsn?'#ef4444':undefined}} type="text" inputMode="numeric" value={ssnDisplay()} onChange={e=>{const d=e.target.value.replace(/\D/g,'');set('ssn',d.slice(0,9))}} onFocus={()=>setShowSsn(true)} onBlur={()=>setShowSsn(false)} placeholder="XXX-XX-XXXX"/><span style={{position:'absolute',right:10,top:'50%',transform:'translateY(-50%)',fontSize:'.75rem',color:'#4a5568',cursor:'pointer'}} onClick={()=>setShowSsn(s=>!s)}>{showSsn?'🙈':'👁'}</span></div>{form.ssn&&!validSsn&&<div style={{color:'#ef4444',fontSize:'.68rem',marginTop:3}}>{ssnDigits.length<9?(9-ssnDigits.length)+' more digits required':'Invalid SSN format'}</div>}{validSsn&&<div style={{color:'#22c55e',fontSize:'.68rem',marginTop:3}}>✓ Format verified — stored encrypted</div>}</div>}
        </div>}
        {STEPS[step]==='Address'&&<div>
          <div style={{marginBottom:10}}>
            <label style={lbl}>Street Address *</label>
            <input style={{...inp,borderColor:addrVerified?'#22c55e':addrWarn?'#f59e0b':undefined}} value={form.street1} onChange={e=>{set('street1',e.target.value);setAddrVerified(false);setAddrWarn(false)}} placeholder="2843 East Frontage Rd"/>
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
        {STEPS[step]==='Employment'&&<div>
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
                  onChange={e=>{set('prevPhone',fmtPhone(e.target.value));setPhoneValid(false);setPhoneError('')}} onBlur={e=>form.prevName&&validatePhone(e.target.value)}
                  placeholder="(555) 000-0000"/>
                {phoneError && <div style={{fontSize:'.68rem',color:'#ef4444',marginTop:3}}>{phoneError}</div>}
                {phoneValid && <div style={{fontSize:'.68rem',color:'#22c55e',marginTop:3}}>✓ Valid phone number</div>}
                {form.prevName&&!form.prevPhone&&<div style={{color:'#ef4444',fontSize:'.68rem',marginTop:3}}>Required if previous landlord provided</div>}
              </div><div><label style={lbl}>Email</label><input style={inp} type="email" value={form.prevEmail} onChange={e=>set('prevEmail',e.target.value)}/></div></div></div>
        </div>}
        {STEPS[step]==='ID Upload'&&<div>
          {providerCollectsPii
            ? <div style={{fontSize:'.82rem',color:'#b8c4d8',marginBottom:16,lineHeight:1.6}}>Identity verification is handled by Checkr, our screening partner, during their secure application step. Uploading an ID here is <strong style={{color:'#c9a227'}}>optional</strong> — it can speed up your landlord's review.</div>
            : <div style={{fontSize:'.82rem',color:'#b8c4d8',marginBottom:16,lineHeight:1.6}}>Upload a photo of your government-issued ID (driver's license, state ID, or passport). <strong style={{color:'#c9a227'}}>Required.</strong> Your name will be verified against this document.</div>}
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
          {/* S554 (button-sweep bug #8): the client-side ID/name-match card
              was removed — its /background/verify-id-name route never existed
              and the submit route ignored the result. ID is verified manually
              by staff downstream. */}
        </div>}
        {STEPS[step]==='Consent'&&<div>
          {providerCollectsPii
            ? <div style={{background:'rgba(201,162,39,.06)',border:'1px solid rgba(201,162,39,.2)',borderRadius:8,padding:'10px 14px',marginBottom:14,fontSize:'.75rem',color:'#b8c4d8',lineHeight:1.5}}>Your credit &amp; criminal screening authorization is collected securely by <strong style={{color:'#c9a227'}}>Checkr</strong>, our screening partner, on the next step (after payment). Here we just need the items below.</div>
            : [{k:'consentCredit',l:'Credit Check',b:'I authorize my landlord and/or GAM to obtain a consumer credit report as part of my rental application.'},{k:'consentCriminal',l:'Criminal Background Check',b:'I authorize my landlord and/or GAM to conduct a criminal background check. All information I have provided is true and accurate.'}].map(consent=>(
            <label key={consent.k} style={{display:'flex',alignItems:'flex-start',gap:12,cursor:'pointer',marginBottom:14,padding:'14px 16px',background:(form as any)[consent.k]?'rgba(34,197,94,.06)':'#141a22',border:'1px solid '+((form as any)[consent.k]?'rgba(34,197,94,.25)':'#1e2530'),borderRadius:10}}>
              <input type="checkbox" checked={(form as any)[consent.k]} onChange={e=>set(consent.k,e.target.checked)} style={{width:18,height:18,marginTop:2,flexShrink:0}}/>
              <div><div style={{fontSize:'.82rem',fontWeight:700,color:'#eef1f8',marginBottom:4}}>{consent.l}</div><div style={{fontSize:'.75rem',color:'#4a5568',lineHeight:1.5}}>{consent.b}</div></div>
            </label>
          ))}
          <label style={{display:'flex',alignItems:'flex-start',gap:12,cursor:'pointer',marginBottom:14,padding:'14px 16px',background:form.consentPool?'rgba(201,162,39,.08)':'#141a22',border:'1px solid '+(form.consentPool?'rgba(201,162,39,.35)':(isSpeculative?'rgba(201,162,39,.4)':'#1e2530')),borderRadius:10}}>
              <input type="checkbox" checked={form.consentPool} onChange={e=>set('consentPool',e.target.checked)} style={{width:18,height:18,marginTop:2,flexShrink:0}}/>
              <div>
                <div style={{fontSize:'.82rem',fontWeight:700,color:'#eef1f8',marginBottom:4}}>Share my screening with landlords {isSpeculative?<span style={{fontSize:'.7rem',fontWeight:700,color:'#c9a227'}}>(required)</span>:<span style={{fontSize:'.7rem',fontWeight:400,color:'#c9a227'}}>(optional)</span>}</div>
                <div style={{fontSize:'.75rem',color:'#4a5568',lineHeight:1.5}}>{isSpeculative?'I authorize GAM to share my completed screening with landlords in the renter pool so they can offer me a place to live. I confirm this to process my check.':'I consent to GAM notifying me of matching vacancies from other landlords on the platform. My report is only shared after I confirm interest and authorize access.'}</div>
              </div>
            </label>
            <label style={{display:'flex',alignItems:'flex-start',gap:12,cursor:'pointer',marginBottom:14,padding:'14px 16px',background:form.acceptedTerms?'rgba(34,197,94,.06)':'#141a22',border:'1px solid '+(form.acceptedTerms?'rgba(34,197,94,.25)':'#1e2530'),borderRadius:10}}>
              <input type="checkbox" checked={form.acceptedTerms} onChange={e=>set('acceptedTerms',e.target.checked)} style={{width:18,height:18,marginTop:2,flexShrink:0}}/>
              <div>
                <div style={{fontSize:'.82rem',fontWeight:700,color:'#eef1f8',marginBottom:4}}>Platform Terms &amp; Privacy</div>
                <div style={{fontSize:'.75rem',color:'#4a5568',lineHeight:1.5}}>
                  I agree to the{' '}
                  <a href={CONSUMER_TERMS_URL} target="_blank" rel="noopener noreferrer" style={{color:'#c9a227'}}>Terms of Service</a>
                  {' '}and{' '}
                  <a href={CONSUMER_PRIVACY_URL} target="_blank" rel="noopener noreferrer" style={{color:'#c9a227'}}>Privacy Policy</a>.
                </div>
              </div>
            </label>
            <div style={{padding:'10px 14px',background:'#141a22',border:'1px solid #1e2530',borderRadius:8,fontSize:'.72rem',color:'#4a5568',lineHeight:1.5}}>By continuing I certify all information provided is accurate. Providing false information is grounds for immediate denial.</div>
        </div>}
        {STEPS[step]==='Review & Pay'&&<div style={{textAlign:'center'}}>
          <div style={{fontSize:'2rem',marginBottom:8}}>🛡️</div>
          <div style={{fontSize:'1.1rem',fontWeight:800,color:'#eef1f8',marginBottom:6}}>Review & Pay</div>
          <div style={{fontSize:'.82rem',color:'#4a5568',marginBottom:16}}>You pay for your own screening. {providerCollectsPii ? 'After payment, Checkr emails you a secure link to finish identity verification — a quick photo of your ID and a selfie, right from your phone.' : ''}</div>
          {price && (
            <div style={{background:'#141a22',border:'1px solid #1e2530',borderRadius:12,padding:16,marginBottom:16,textAlign:'left',fontSize:'.82rem',color:'#b8c4d8'}}>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}><span>Background & credit screening</span><span>${Number((price as any).breakdown?.screening ?? 0).toFixed(2)}</span></div>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}><span>Service fee</span><span>${Number((price as any).breakdown?.gamFee ?? 0).toFixed(2)}</span></div>
              {Number((price as any).breakdown?.tax ?? 0) > 0 && <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}><span>Tax</span><span>${Number((price as any).breakdown?.tax).toFixed(2)}</span></div>}
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}><span>Card processing</span><span>${Number((price as any).breakdown?.processing ?? 0).toFixed(2)}</span></div>
              <div style={{display:'flex',justifyContent:'space-between',fontWeight:800,color:'#eef1f8',borderTop:'1px solid #1e2530',paddingTop:8,marginTop:4}}><span>Total</span><span>${Number((price as any).totalFee ?? 0).toFixed(2)}</span></div>
            </div>
          )}
          {paymentInitError && (
            <div style={{padding:'10px 14px',background:'rgba(239,68,68,.06)',border:'1px solid rgba(239,68,68,.25)',borderRadius:8,color:'#ef4444',fontSize:'.78rem',marginBottom:12}}>{paymentInitError}</div>
          )}
          {!paid && !paymentInitError && !paymentClientSecret && (
            <div style={{fontSize:'.78rem',color:'#4a5568',marginBottom:12}}>Setting up your payment…</div>
          )}
          {!paid && paymentClientSecret && paymentTestMode && (
            <button onClick={()=>setPaid(true)}
              style={{width:'100%',padding:'12px',borderRadius:8,border:'none',background:'#c9a227',color:'#060809',fontWeight:700,cursor:'pointer',fontSize:'.88rem'}}>
              Pay ${Number((price as any)?.totalFee ?? 0).toFixed(2)} (test mode)
            </button>
          )}
          {!paid && paymentClientSecret && !paymentTestMode && stripePromise && (
            <Elements stripe={stripePromise} options={{clientSecret:paymentClientSecret}}>
              <ScreeningCardForm amountLabel={`$${Number((price as any)?.totalFee ?? 0).toFixed(2)}`} onPaid={(id)=>{ if(id) setPaymentIntentId(id); setPaid(true) }} />
            </Elements>
          )}
          {!paid && paymentClientSecret && !paymentTestMode && !stripePromise && (
            <div style={{fontSize:'.78rem',color:'#ef4444',marginBottom:12}}>Card payment isn't configured — please contact support.</div>
          )}
          {paid && (
            <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:8,padding:'12px 20px',background:'rgba(34,197,94,.08)',border:'1px solid rgba(34,197,94,.25)',borderRadius:10,color:'#22c55e',fontWeight:700}}><Check size={18}/> Paid — click Submit below</div>
          )}
          {submitMut.isError&&<div style={{color:'#ef4444',fontSize:'.75rem',marginTop:10,display:'flex',gap:6,justifyContent:'center'}}><AlertCircle size={12}/> Submission failed — please try again</div>}
        </div>}
      </div>
      <div style={{display:'flex',gap:10}}>
        <button onClick={()=>step>0&&setStep(s=>s-1)} disabled={step===0} style={{padding:'10px 20px',borderRadius:8,border:'1px solid #1e2530',background:'transparent',color:step===0?'#4a5568':'#b8c4d8',cursor:step===0?'not-allowed':'pointer',fontSize:'.85rem'}}>← Back</button>
        {step<STEPS.length-1?<button onClick={()=>setStep(s=>s+1)} disabled={!canNext[STEPS[step]]} style={{flex:1,padding:'12px',borderRadius:8,border:'none',background:canNext[STEPS[step]]?'#c9a227':'#141a22',color:canNext[STEPS[step]]?'#060809':'#4a5568',fontWeight:700,cursor:canNext[STEPS[step]]?'pointer':'not-allowed',fontSize:'.88rem'}}>Continue →</button>:<button onClick={()=>submitMut.mutate()} disabled={!paid||submitMut.isLoading} style={{flex:1,padding:'12px',borderRadius:8,border:'none',background:paid?'#c9a227':'#141a22',color:paid?'#060809':'#4a5568',fontWeight:700,cursor:paid?'pointer':'not-allowed',fontSize:'.88rem'}}>{submitMut.isLoading?'Submitting...':'🔒 Submit Application'}</button>}
      </div>
    </div>
  )
}
