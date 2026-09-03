import { useState, useEffect } from 'react'
import { useQuery, useMutation } from 'react-query'
import { Shield, Check, AlertCircle, Clock, XCircle } from 'lucide-react'
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

const inp = { width:'100%', padding:'9px 12px', border:'1px solid #1e2530', borderRadius:8, background:'#0a0d10', color:'#eef1f8', fontSize:'.85rem', outline:'none', boxSizing:'border-box' as const }
const lbl = { fontSize:'.72rem', fontWeight:600 as const, color:'#4a5568', textTransform:'uppercase' as const, letterSpacing:'.06em', display:'block' as const, marginBottom:5 }
// ── S636 (Nic, DIRECTIVE): THERE IS ONE INTAKE, AND IT IS TWO STEPS ──
//
// "That link is still showing a six fucking page process before doing the
// application... It's a whole page just for putting in my fucking address.
// If I'm doing a background check to look for somewhere to live, why... that
// address has nothing to do with anything. We're looking for criminal
// background check. We're looking for identity verification. All the other
// bullshit doesn't matter." And: "the mock portal thing... the six page
// thing, that should not exist."
//
// S579 kept a full legacy intake — name, DOB, SSN, home address, employment,
// income, previous landlord, ID upload — behind a provider check, on the
// theory that only dev would ever see it. It was not dev-only: the renter
// pool has no landlord by definition and resolved to it, as did anyone
// arriving with a bad id.
//
// None of it reaches the screener. A Checkr order carries name, email, DOB
// and the PROPERTY's address; Checkr collects identity and FCRA consent on
// its own hosted flow. So the six pages asked applicants for an SSN that was
// never sent and an address nothing read.
//
// What is left is consent and payment. The one exception is a ZIP on the
// pool route — see the Consent step — because a pool applicant with no
// location cannot be shown to landlords near them, which is the entire
// point of the pool.
const STEPS = ['Consent', 'Review & Pay'] as const

export function BackgroundCheckPage() {
  const [step, setStep] = useState(0)
  const [paid, setPaid] = useState(false)
  const [paymentIntentId, setPaymentIntentId] = useState<string>('')
  const [paymentClientSecret, setPaymentClientSecret] = useState<string>('')
  const [paymentTestMode, setPaymentTestMode] = useState(false)
  const [paymentInitError, setPaymentInitError] = useState<string>('')
  const [startTime] = useState(Date.now())
  const [countdown, setCountdown] = useState('')
  const [reapplyErr, setReapplyErr] = useState('')
  // S583 (Nic): removed the Mapbox address-autocomplete — it sent the applicant's
  // typed address to a third party (Mapbox), which GAM's no-external-data rule
  // doesn't allow. Address is now plain manual entry, verified only by GAM's own
  // /background/verify-address endpoint. (This whole legacy intake step is dropped
  // entirely under Checkr, which collects the address on its hosted flow.)
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
  // The name the check needs comes from the account, never a form field.
  useEffect(() => {
    if (providerCollectsPii && me) {
      setForm(f => ({
        ...f,
        firstName: f.firstName || (me as any).firstName || '',
        lastName:  f.lastName  || (me as any).lastName  || '',
      }))
    }
  }, [providerCollectsPii, me])
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
        // ── S636: THIS IS THE WHOLE PAYLOAD NOW ──
        // The six-page intake that produced SSN, home address, employment,
        // income, previous landlord and document uploads is gone — none of
        // it ever reached the screener. A Checkr order carries name, email,
        // DOB and the PROPERTY's address; Checkr collects identity and FCRA
        // consent on its own hosted flow.
        //
        // The name comes from the account, never a form field. The ZIP is
        // the pool route's only personal detail, and only because a pool
        // applicant with no location cannot be shown to landlords near them.
        firstName:form.firstName, lastName:form.lastName,
        zip: isSpeculative ? form.zip : null,
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
  const validZip = /^\d{5}(-\d{4})?$/.test(form.zip)
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

  // Checkr collects the FCRA credit/criminal consent on its OWN flow — GAM
  // only needs the pool-share (if speculative) + platform terms here. A pool
  // applicant also gives a ZIP, which is the only thing that lets a landlord
  // near them find them.
  const canNext: Record<string, boolean> = {
    'Consent': !!((providerCollectsPii||(form.consentCredit&&form.consentCriminal))
      && form.acceptedTerms
      && (!isSpeculative || (form.consentPool && validZip))),
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
        {STEPS[step]==='Consent'&&<div>
          {/* S636: the ONLY personal detail this intake still asks for, and
              only on the pool route. A pool applicant has named no property,
              so without a ZIP there is nothing to match them to landlords
              near them — which is the whole point of the pool. Everyone
              arriving from a property's QR or a landlord's link skips it. */}
          {isSpeculative&&<div style={{marginBottom:16}}>
            <label style={lbl}>ZIP code where you're looking to live *</label>
            <input style={{...inp,borderColor:form.zip&&!validZip?'#ef4444':undefined}}
              inputMode="numeric" maxLength={5} placeholder="85001"
              value={form.zip} onChange={e=>set('zip',e.target.value.replace(/\D/g,'').slice(0,5))}/>
            <div style={{fontSize:'.7rem',color:'#4a5568',marginTop:4}}>
              Used only to show you to landlords in that area.
            </div>
          </div>}
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
                {/* S636 (Nic): "people are gonna think that that means that
                    it's optional to share the background data with the
                    landlord where they're applying. It reads as vague. It
                    needs to say share my screening with ADDITIONAL
                    landlords. That way they know, hey, it's going to the
                    main landlord no matter what."
                    An applicant declining this must never believe they have
                    declined the check they are paying for. */}
                <div style={{fontSize:'.82rem',fontWeight:700,color:'#eef1f8',marginBottom:4}}>{isSpeculative?'Share my screening with landlords in the pool ':'Share my screening with additional landlords '}{isSpeculative?<span style={{fontSize:'.7rem',fontWeight:700,color:'#c9a227'}}>(required)</span>:<span style={{fontSize:'.7rem',fontWeight:400,color:'#c9a227'}}>(optional)</span>}</div>
                <div style={{fontSize:'.75rem',color:'#4a5568',lineHeight:1.5}}>{isSpeculative?'I authorize GAM to share my completed screening with landlords in the renter pool so they can offer me a place to live. I confirm this to process my check.':'The landlord you are applying to receives this screening either way. Tick this only if you also want GAM to tell you about matching vacancies from OTHER landlords — and even then, your report is shared only after you confirm interest.'}</div>
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
              {/* S636 (Nic): "why is it showing a service fee of five dollars?
                  That's our markup, but it needs to be blended into the
                  background and credit screening fee. It needs to not be three
                  line items. It needs to be card processing and background."
                  The books still hold screening and gamFee separately — this is
                  the applicant's receipt, and to them it is one price for one
                  screening. Card processing stays its own line because it is a
                  cost of paying by card, not part of the screen. */}
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}><span>Background &amp; credit screening</span><span>${(Number((price as any).breakdown?.screening ?? 0) + Number((price as any).breakdown?.gamFee ?? 0)).toFixed(2)}</span></div>
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
