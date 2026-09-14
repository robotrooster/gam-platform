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
      {/* S642 (Nic): the screening charge now stores the card, because THIS
          authorization is already being made and storing on it is free. That
          has to be said plainly on the form where the card is typed — a card
          kept for later off-session use is not something to do quietly, and a
          resident who finds it saved without being told reads it as a mistake.
          Stated, not asked: "no choices to be made by tenants." It is removable
          from the portal any time. */}
      <div style={{ fontSize: '.72rem', color: '#7a8aaa', lineHeight: 1.55, marginTop: 10 }}>
        We'll keep this card on file so it's ready if you move in — you can remove it from
        your portal at any time. Nothing else is charged to it today.
      </div>
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
// S642 (Nic, DIRECTIVE): "Can people pay for the background check, start the
// workflow, and have their tenant portal be created off of the information in
// the background check?… That way people know what's going on."
//
// The account step is part of THIS form, not a separate page in front of it. A
// walk-up used to be bounced to /signup, made an account, verified a 6-digit
// code, landed in a portal and then had to find the check again — four screens
// to start one thing. Someone already signed in (an invited resident screening
// voluntarily, or an applicant coming back) never sees it.
const ACCOUNT_STEP = 'Your account'
const BASE_STEPS = ['Consent', 'Review & Pay'] as const

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
  const [form, setForm] = useState({ firstName:'', lastName:'', dob:'', ssn:'', email:'', password:'', confirmPassword:'', street1:'', street2:'', city:'', state:'', zip:'', years:'', empStatus:'employed', employer:'', empPhone:'', income:'', prevName:'', prevPhone:'', prevEmail:'', moveIn:'', stay:'', consentCredit:false, consentCriminal:false, consentPool:false, acceptedTerms:false })
  const set = (k: string, v: any) => setForm(f=>({...f,[k]:v}))
  // S642: an anonymous walk-up now lands HERE rather than being bounced to
  // /signup, so these two must not fire without a session. Both are
  // authenticated routes, and the 401 interceptor in lib/api treats any 401
  // outside /auth/ as an expired session and redirects to /login — which would
  // throw a first-time applicant off this page before they ever saw the form.
  // (/background/price is public and stays enabled: the fee is on screen from
  // the first paint.)
  const [hasSession, setHasSession] = useState(!!tok())
  const { data: status, refetch } = useQuery('bg-status', () => get('/background/status'), { enabled: hasSession })
  const { data: me } = useQuery('tenant-me', () => get('/tenants/me'), { enabled: hasSession })
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
  // Somebody who already lives here and is screening voluntarily is not moving
  // in and has no term to name — the stay questions below are not theirs.
  const invitedResident = !!(me as any)?.onboardingUnitNumber || !!(me as any)?.unitId
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
        // ── S637 (Nic): THE QR'S LANDLORD HAS TO SURVIVE TO THE SUBMIT ──
        //
        // "I thought the check was linked to the QR code locked to the
        //  property. That should be locked to us."
        //
        // It is — in two of the three places that needed it. The price lookup
        // and the payment intent both fall back to the landlordId in the URL,
        // which is why Anastacio Erreguin's $44.99 charge carried Mountain View
        // in its metadata. This line did not, so a walk-up with no account
        // linkage submitted with landlordId null, the server read that as a
        // SPECULATIVE renter-pool intake, and his screening filed itself under
        // the GAM shell landlord instead of the park he was standing in. Nic
        // saw no notification because it was never his check.
        landlordId:(me as any)?.landlordId||new URLSearchParams(window.location.search).get('landlordId')||null,
        unitId:(me as any)?.unitId||(new URLSearchParams(window.location.search).get('unitId'))||null,
        // S636: carried in by the property's QR code, so a walk-up's check
        // binds to the park they scanned at.
        propertyId:new URLSearchParams(window.location.search).get('propertyId')||null,
        // ── S639 (Nic): ASK FOR THE STAY WHILE THEY ARE STANDING HERE ──
        //
        // "I don't know how much he's wanting to have the spot for... I don't
        //  wanna do back and forth with, hey, they told me something, and then
        //  I forgot because I was busy."
        //
        // Two questions at the front of the funnel are what turn an approval
        // into a lease the office can draft without another phone call.
        desiredMoveIn: form.moveIn || null,
        desiredTermMonths: form.stay && form.stay !== 'mtm' ? Number(form.stay) : null,
        desiredMonthToMonth: form.stay === 'mtm',
        timeToComplete:Math.round((Date.now()-startTime)/1000),
        applicantPaymentIntentId:paymentIntentId,
      })
    }).then(r => r.json())
  }, { onSuccess: () => refetch() })
  const validZip = /^\d{5}(-\d{4})?$/.test(form.zip)
  // S642: no bounce to /signup. Someone arriving without a session gets the
  // account step at the front of this same form; the account is created from
  // email + password when they continue past it.
  const [creatingAccount, setCreatingAccount] = useState(false)
  const [accountErr, setAccountErr] = useState('')
  // Frozen at mount, NOT derived from hasSession. Creating the account flips
  // hasSession true, and a reactive STEPS would drop the account step from the
  // array at that instant — the index the flow had just advanced to would then
  // point at 'Review & Pay' and the applicant would sail past Consent without
  // ever giving one.
  const [needsAccountStep] = useState(!tok())
  const STEPS = (needsAccountStep ? [ACCOUNT_STEP, ...BASE_STEPS] : BASE_STEPS) as readonly string[]

  const createAccountInline = async () => {
    setAccountErr('')
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) { setAccountErr('Enter a valid email address'); return false }
    if (form.password.length < 12) { setAccountErr('Password must be at least 12 characters'); return false }
    if (form.password !== form.confirmPassword) { setAccountErr('Passwords do not match'); return false }
    if (!form.acceptedTerms) { setAccountErr('You must accept the Terms of Service and Privacy Policy'); return false }
    setCreatingAccount(true)
    try {
      const params = new URLSearchParams(window.location.search)
      const res = await fetch(`${API}/api/auth/register-prospect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // No name: Checkr's order needs one and it is asked for at the consent
          // step, but the ACCOUNT is not named by a form — the matched legal
          // name from the completed report becomes the name on it.
          inline: true,
          email: form.email.trim(),
          password: form.password,
          acceptedTerms: true,
          landlordId: params.get('landlordId') || null,
          unitId: params.get('unitId') || null,
        }),
      })
      const body = await res.json()
      if (!res.ok || !body?.data?.token) {
        setAccountErr(body?.error || 'Could not create your account. Please try again.')
        return false
      }
      localStorage.setItem('gam_tenant_token', body.data.token)
      setHasSession(true)
      return true
    } catch {
      setAccountErr('Could not reach the server. Please try again.')
      return false
    } finally {
      setCreatingAccount(false)
    }
  }
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
        // S642: the account step guarantees a session before this step is
        // reachable, so there is nowhere to bounce to. If it is somehow missing,
        // surface it rather than throwing the applicant out of a paid flow.
        const token = tok()
        if (!token) {
          setPaymentInitError('Your session expired. Please reload the page and sign in.')
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
    // S642: terms are accepted HERE when the account is made here — an account
    // is the thing the terms govern. The consent step drops its own copy in
    // that case rather than asking twice for the same acceptance.
    [ACCOUNT_STEP]: !!(form.email && form.password && form.confirmPassword
      && form.acceptedTerms && !creatingAccount),
    'Consent': !!((providerCollectsPii||(form.consentCredit&&form.consentCriminal))
      && form.acceptedTerms && (invitedResident || (form.moveIn && form.stay))
      && (!isSpeculative || (form.consentPool && validZip))
      // Checkr's order cannot be opened without a name, so it is asked for once
      // here. It names the ORDER, not the account: the matched legal name off
      // the finished report is what the account ends up carrying.
      && form.firstName.trim() && form.lastName.trim()),
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
          <p style={{color:'#4a5568',maxWidth:400,lineHeight:1.6}}>Your application is in. To run your screening, complete the secure identity &amp; consent step with Checkr, our screening partner — it takes about two minutes. Checkr also emailed you this link — if this computer has no camera, open that email on your phone and finish there.</p>
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
      <h2 style={{color:'#eef1f8',margin:0}}>{isSpeculative?"You're in the renter pool":'Application Approved'}</h2>
      {/* S642 (Nic): a POOL applicant has no landlord, no unit and no lease, so
          "full access to your tenant portal" described a tenancy they do not
          have — it reads as though something should be there and isn't. They
          get told what actually happens next instead.

          "Maybe if anybody goes through that flow of self-sign-up, they see a
          coming soon thing." Browsing listings yourself is built but not
          deployed, so it is named as coming rather than linked or hidden —
          somebody who just paid to be screened is owed a straight answer about
          what they can do now. */}
      {isSpeculative ? (
        <>
          <p style={{color:'#4a5568',maxWidth:400,lineHeight:1.6}}>
            Your screening came back clear and you're in the renter pool. Landlords with
            open units in your area can find you from here — you don't need to do anything
            else, and we'll email you the moment one is interested.
          </p>
          <div style={{maxWidth:400,padding:'14px 18px',borderRadius:10,background:'#141a22',border:'1px solid #1e2530'}}>
            <div style={{fontSize:'.72rem',fontWeight:700,color:'#c9a227',letterSpacing:'.08em',textTransform:'uppercase',marginBottom:6}}>Coming soon</div>
            <div style={{fontSize:'.82rem',color:'#b8c4d8',lineHeight:1.6}}>
              Browsing open places yourself. For now the matching runs the other way —
              landlords come to you, and your screening is already good across every one
              of them.
            </div>
          </div>
        </>
      ) : (
        <p style={{color:'#4a5568',maxWidth:380}}>Your background check has been approved. You now have full access to your tenant portal.</p>
      )}
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
  // ── S639 (Nic): TELL THEM BEFORE THEY WORRY ────────────────────────────────
  //
  // "It's trying to offer them to pay for a background check, and I've told
  // them, no, you don't have to do that... a lot of people think that is about
  // to happen to them."
  //
  // An invited resident who lands here is not applying for anything — their
  // landlord onboarded them and their lease is waiting on the rest of the
  // household. The page still works (nobody is locked out of a screening they
  // genuinely want), but it says so at the top, before the fee is anywhere on
  // screen. The subtitle lies to them too — nothing here gates their portal —
  // so it goes for this case.
  return(
    <div style={{maxWidth:540,margin:'0 auto'}}>
      {invitedResident && (
        <div style={{background:'rgba(38,167,90,.08)', border:'1px solid rgba(38,167,90,.35)',
                     borderRadius:10, padding:'13px 15px', marginBottom:18, lineHeight:1.6}}>
          <div style={{fontWeight:700, color:'var(--green, #5fbf7f)', marginBottom:3}}>
            You don't need to do this.
          </div>
          <div style={{fontSize:'.86rem', color:'#b8c4d8'}}>
            Your landlord has already onboarded you
            {(me as any)?.onboardingUnitNumber ? ` for ${(me as any).onboardingUnitNumber}` : ''}, so
            there is no application to complete and nothing to pay. Your lease is drafted and sent
            for signature once everyone in your household accepts their portal invite.
          </div>
        </div>
      )}
      <div style={{textAlign:'center',marginBottom:24}}><div style={{width:52,height:52,borderRadius:'50%',background:'rgba(201,162,39,.1)',border:'2px solid #c9a227',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 10px'}}><Shield size={22} style={{color:'#c9a227'}}/></div><h1 style={{color:'#eef1f8',fontSize:'1.2rem',fontWeight:800,margin:'0 0 4px'}}>Background Check Application</h1><p style={{color:'#4a5568',fontSize:'.82rem',margin:0}}>{
        // S642: a walk-up joining the renter pool is not "accessing their tenant
        // portal" — they have no tenancy and no landlord. Saying so made the
        // page read as though they were in the wrong place.
        invitedResident ? 'Optional — your tenancy does not depend on this'
        : needsAccountStep ? 'Get screened once — landlords with open units find you'
        : 'Required before accessing your tenant portal'}</p></div>
      <div style={{display:'flex',gap:4,marginBottom:8}}>{STEPS.map((_,i)=><div key={i} style={{flex:1,height:3,borderRadius:2,background:i<=step?'#c9a227':'#141a22',transition:'background .2s'}}/>)}</div>
      <div style={{fontSize:'.7rem',color:'#4a5568',textAlign:'center',marginBottom:20}}>Step {step+1} of {STEPS.length} — {STEPS[step]}</div>
      <div style={{background:'#0a0d10',border:'1px solid #1e2530',borderRadius:12,padding:24,marginBottom:16}}>
        {/* S642: the account step. Email and a password — nothing else. No name
            field: "They never have a spot to type in their name. We're gonna
            generate accounts off a legal name." (Nic) */}
        {STEPS[step]===ACCOUNT_STEP&&<div>
          <div style={{fontSize:'.82rem',fontWeight:700,color:'#eef1f8',marginBottom:4}}>Set up your account</div>
          <div style={{fontSize:'.78rem',color:'#7a8aaa',lineHeight:1.6,marginBottom:16}}>
            This is how you'll sign back in to see your result. Your name comes off your
            screening report — there's nothing to type.
          </div>
          <label style={lbl}>Email address *</label>
          <input style={inp} type="email" autoComplete="email" value={form.email}
            onChange={e=>set('email',e.target.value)} placeholder="you@example.com"/>
          <label style={{...lbl,marginTop:12}}>Password *</label>
          <input style={inp} type="password" autoComplete="new-password" value={form.password}
            onChange={e=>set('password',e.target.value)} placeholder="At least 12 characters"/>
          <label style={{...lbl,marginTop:12}}>Confirm password *</label>
          <input style={inp} type="password" autoComplete="new-password" value={form.confirmPassword}
            onChange={e=>set('confirmPassword',e.target.value)}/>
          {form.confirmPassword.length>0&&form.password!==form.confirmPassword&&
            <div style={{fontSize:'.74rem',color:'#f59e0b',marginTop:6}}>Passwords don't match yet.</div>}
          <label style={{display:'flex',gap:10,alignItems:'flex-start',marginTop:16,cursor:'pointer'}}>
            <input type="checkbox" checked={form.acceptedTerms}
              onChange={e=>set('acceptedTerms',e.target.checked)} style={{marginTop:3}}/>
            <span style={{fontSize:'.78rem',color:'#b8c4d8',lineHeight:1.55}}>
              I agree to the <a href={CONSUMER_TERMS_URL} target="_blank" rel="noreferrer" style={{color:'#c9a227'}}>Terms of Service</a>
              {' '}and <a href={CONSUMER_PRIVACY_URL} target="_blank" rel="noreferrer" style={{color:'#c9a227'}}>Privacy Policy</a>.
            </span>
          </label>
          {accountErr&&<div style={{marginTop:14,padding:'10px 14px',borderRadius:8,background:'rgba(239,68,68,.08)',border:'1px solid rgba(239,68,68,.25)',color:'#ef4444',fontSize:'.8rem'}}>{accountErr}</div>}
        </div>}
        {STEPS[step]==='Consent'&&<div>
          {/* S642: Checkr's Tenant order will not open without a name, so it is
              asked for once, here, as the order's seed. The account is NOT named
              by it — the matched legal name off the finished report replaces it. */}
          {needsAccountStep&&<div style={{marginBottom:18,padding:'14px 16px',background:'#141a22',border:'1px solid #1e2530',borderRadius:10}}>
            <div style={{fontSize:'.82rem',fontWeight:700,color:'#eef1f8',marginBottom:4}}>Your legal name</div>
            <div style={{fontSize:'.75rem',color:'#7a8aaa',lineHeight:1.55,marginBottom:10}}>
              As it appears on your government ID — the screener matches against it.
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
              <div>
                <label style={lbl}>First name *</label>
                <input style={inp} autoComplete="given-name" value={form.firstName} onChange={e=>set('firstName',e.target.value)}/>
              </div>
              <div>
                <label style={lbl}>Last name *</label>
                <input style={inp} autoComplete="family-name" value={form.lastName} onChange={e=>set('lastName',e.target.value)}/>
              </div>
            </div>
          </div>}
          {/* S639: the two questions the office would otherwise have to chase
              by phone after an approval. Asked here, an approved applicant
              arrives with a move-in date and a term, and the lease can be
              drafted straight off the application. */}
          {!invitedResident&&<div style={{marginBottom:18,padding:'14px 16px',background:'#141a22',border:'1px solid #1e2530',borderRadius:10}}>
            <div style={{fontSize:'.82rem',fontWeight:700,color:'#eef1f8',marginBottom:10}}>About your stay</div>
            <label style={lbl}>When would you like to move in? *</label>
            <input style={inp} type="date" min={new Date().toISOString().slice(0,10)}
              value={form.moveIn} onChange={e=>set('moveIn',e.target.value)}/>
            <label style={{...lbl,marginTop:12}}>How long do you plan to stay? *</label>
            <select style={inp} value={form.stay} onChange={e=>set('stay',e.target.value)}>
              <option value="">Select…</option>
              <option value="mtm">Month to month</option>
              <option value="3">3 months</option>
              <option value="6">6 months</option>
              <option value="12">12 months</option>
              <option value="24">24 months</option>
            </select>
            <div style={{fontSize:'.7rem',color:'#4a5568',marginTop:6}}>
              So the office can have your paperwork ready. Nothing is locked in until you sign a lease.
            </div>
          </div>}
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
            {/* S642: asking the same acceptance twice reads as a bug. When the
                account step took it a moment ago, it is not asked again here. */}
            {!needsAccountStep&&<label style={{display:'flex',alignItems:'flex-start',gap:12,cursor:'pointer',marginBottom:14,padding:'14px 16px',background:form.acceptedTerms?'rgba(34,197,94,.06)':'#141a22',border:'1px solid '+(form.acceptedTerms?'rgba(34,197,94,.25)':'#1e2530'),borderRadius:10}}>
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
            </label>}
            <div style={{padding:'10px 14px',background:'#141a22',border:'1px solid #1e2530',borderRadius:8,fontSize:'.72rem',color:'#4a5568',lineHeight:1.5}}>By continuing I certify all information provided is accurate. Providing false information is grounds for immediate denial.</div>
        </div>}
        {STEPS[step]==='Review & Pay'&&<div style={{textAlign:'center'}}>
          <div style={{fontSize:'2rem',marginBottom:8}}>🛡️</div>
          <div style={{fontSize:'1.1rem',fontWeight:800,color:'#eef1f8',marginBottom:6}}>Review & Pay</div>
          <div style={{fontSize:'.82rem',color:'#4a5568',marginBottom:16}}>You pay for your own screening. {/* S636 (Nic): "What happens when a person is doing the background
              check flow from a desktop that does not have a webcam? It says
              a quick photo of your ID and a selfie right from your phone,
              but I'm on the desktop browser."
              The link is EMAILED, so the device you paid on does not have to
              be the device with the camera — but the copy assumed a phone and
              read like a dead end on a desktop. It now names the way out. */}
              {providerCollectsPii ? 'After payment, Checkr emails you a secure link to finish identity verification — a photo of your ID and a selfie. It takes about two minutes. On a computer without a camera, open that email on your phone and finish there.' : ''}</div>
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
        {step<STEPS.length-1?<button onClick={async()=>{
          // S642: leaving the account step is what creates the account. It has
          // to succeed before the flow moves on — the next step mints a Stripe
          // PaymentIntent against the session this call establishes.
          if(STEPS[step]===ACCOUNT_STEP){ if(!(await createAccountInline())) return }
          setStep(s=>s+1)
        }} disabled={!canNext[STEPS[step]]} style={{flex:1,padding:'12px',borderRadius:8,border:'none',background:canNext[STEPS[step]]?'#c9a227':'#141a22',color:canNext[STEPS[step]]?'#060809':'#4a5568',fontWeight:700,cursor:canNext[STEPS[step]]?'pointer':'not-allowed',fontSize:'.88rem'}}>{creatingAccount?'Creating your account…':'Continue →'}</button>:<button onClick={()=>submitMut.mutate()} disabled={!paid||submitMut.isLoading} style={{flex:1,padding:'12px',borderRadius:8,border:'none',background:paid?'#c9a227':'#141a22',color:paid?'#060809':'#4a5568',fontWeight:700,cursor:paid?'pointer':'not-allowed',fontSize:'.88rem'}}>{submitMut.isLoading?'Submitting...':'🔒 Submit Application'}</button>}
      </div>
    </div>
  )
}
