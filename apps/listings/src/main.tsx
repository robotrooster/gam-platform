// S540: self-hosted fonts — no render-blocking external stylesheet
import '@fontsource/syne/600.css'
import '@fontsource/syne/700.css'
import '@fontsource/syne/800.css'
import '@fontsource/dm-sans/300.css'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/600.css'
import '@fontsource/dm-mono/400.css'
import '@fontsource/dm-mono/500.css'
import { SentryErrorBoundary } from './lib/sentry'
import React, { useState, useEffect, useCallback } from 'react'
import ReactDOM from 'react-dom/client'
import axios from 'axios'
import { applyCamelizeInterceptor } from '@gam/shared'
import { loadStripe } from '@stripe/stripe-js'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
const STRIPE_PK = (import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY || ''
const stripePromise = STRIPE_PK ? loadStripe(STRIPE_PK) : null

// S312: snake_case → camelCase RESPONSE transform (one-way; request bodies
// stay camelCase, which the backend zod schemas expect).
applyCamelizeInterceptor(axios)

// ── Auth token (this origin's localStorage) ──────────────────────────────
const TOK_KEY = 'gam_listings_token'
const getTok = () => { try { return localStorage.getItem(TOK_KEY) } catch { return null } }
const setTok = (t: string) => { try { localStorage.setItem(TOK_KEY, t) } catch { /* private mode */ } }
const clearTok = () => { try { localStorage.removeItem(TOK_KEY) } catch { /* ignore */ } }
const authCfg = () => { const t = getTok(); return t ? { headers: { Authorization: `Bearer ${t}` } } : {} }

const BG_APPROVED = ['approved', 'waived']

function money(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}
function money2(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

const css = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg0:#f8f7f4;--bg1:#ffffff;--bg2:#f3f2ef;--bg3:#e8e6e1;
  --b0:#e0ddd6;--b1:#d4d0c8;
  --t0:#1a1814;--t1:#3d3a32;--t2:#6b6760;--t3:#9c9890;
  --gold:#b8860b;--green:#2d6a4f;--red:#c1121f;--blue:#1d4e89;
  --font-d:'Syne',sans-serif;--font-b:'DM Sans',sans-serif;--font-m:'DM Mono',monospace
}
html{-webkit-font-smoothing:antialiased}
body{font-family:var(--font-b);background:var(--bg0);color:var(--t1);line-height:1.6;min-height:100vh}
h1,h2,h3{font-family:var(--font-d);color:var(--t0)}
button{cursor:pointer;font-family:var(--font-b)}
input,select,textarea{font-family:var(--font-b)}
a{color:var(--gold);text-decoration:none}

.header{background:var(--bg1);border-bottom:1px solid var(--b0);padding:0 40px;height:64px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50}
.logo{font-family:var(--font-d);font-size:1.2rem;font-weight:800;color:var(--t0)}
.logo span{color:var(--gold)}
.hdr-actions{display:flex;gap:10px;align-items:center;font-size:.85rem}
.hero{background:var(--t0);color:#fff;padding:64px 40px;text-align:center}
.hero h1{font-size:2.8rem;font-weight:800;color:#fff;margin-bottom:12px}
.hero p{color:rgba(255,255,255,.7);font-size:1rem;max-width:480px;margin:0 auto 28px}
.search-bar{display:flex;gap:8px;max-width:560px;margin:0 auto;flex-wrap:wrap;justify-content:center}
.search-bar input,.search-bar select{padding:10px 16px;border-radius:8px;border:none;font-size:.875rem;min-width:160px;flex:1}
.search-bar button{background:var(--gold);color:#fff;border:none;border-radius:8px;padding:10px 24px;font-weight:600;font-size:.875rem}
.main{max-width:1280px;margin:0 auto;padding:40px 24px}
.results-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.results-header h2{font-size:1.1rem;font-weight:700;color:var(--t0)}
.tier-note{font-size:.8rem;color:var(--t2);margin-bottom:24px}
.tier-note a{font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:24px}
.card{background:var(--bg1);border:1px solid var(--b0);border-radius:12px;overflow:hidden;transition:box-shadow .15s,transform .15s;cursor:pointer}
.card:hover{box-shadow:0 8px 32px rgba(0,0,0,.1);transform:translateY(-2px)}
.card-photos{position:relative;height:220px;background:var(--bg3);overflow:hidden}
.card-photos img{width:100%;height:100%;object-fit:cover}
.card-photos-count{position:absolute;bottom:10px;right:10px;background:rgba(0,0,0,.6);color:#fff;font-size:.7rem;padding:3px 8px;border-radius:12px;font-family:var(--font-m)}
.card-body{padding:18px}
.card-price{font-family:var(--font-d);font-size:1.5rem;font-weight:800;color:var(--t0);margin-bottom:4px}
.card-price span{font-size:.8rem;font-weight:400;color:var(--t2);font-family:var(--font-b)}
.card-address{font-size:.82rem;color:var(--t2);margin-bottom:10px}
.card-specs{display:flex;gap:16px;font-size:.78rem;color:var(--t2);margin-bottom:14px}
.card-specs strong{color:var(--t0)}
.card-available{font-size:.72rem;color:var(--green);font-weight:600;margin-bottom:12px}
.btn-apply{width:100%;background:var(--t0);color:#fff;border:none;border-radius:8px;padding:10px;font-weight:600;font-size:.82rem;transition:background .12s}
.btn-apply:hover{background:#2d2a22}

.overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;display:flex;align-items:flex-start;justify-content:center;padding:24px;overflow-y:auto}
.modal{background:var(--bg1);border-radius:16px;width:100%;max-width:860px;overflow:hidden;margin:auto}
.modal-photos{display:grid;grid-template-columns:2fr 1fr;gap:3px;height:400px;background:var(--bg3)}
.modal-photos img{width:100%;height:100%;object-fit:cover}
.modal-photos-grid{display:grid;grid-template-rows:1fr 1fr;gap:3px}
.modal-body{padding:28px}
.modal-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}
.modal-price{font-family:var(--font-d);font-size:2rem;font-weight:800;color:var(--t0)}
.modal-close{background:var(--bg2);border:none;border-radius:50%;width:36px;height:36px;font-size:1.1rem;color:var(--t2);cursor:pointer;flex-shrink:0}
.modal-specs{display:flex;gap:24px;margin-bottom:16px;flex-wrap:wrap}
.modal-spec{display:flex;flex-direction:column}
.modal-spec-val{font-family:var(--font-d);font-size:1.1rem;font-weight:700;color:var(--t0)}
.modal-spec-lbl{font-size:.65rem;color:var(--t3);text-transform:uppercase;letter-spacing:.08em}
.modal-desc{font-size:.875rem;color:var(--t2);line-height:1.7;margin-bottom:20px;padding:14px;background:var(--bg2);border-radius:8px}
.modal-footer{display:flex;gap:12px;flex-wrap:wrap}
.btn-primary{flex:1;min-width:180px;background:var(--gold);color:#fff;border:none;border-radius:8px;padding:12px;font-weight:700;font-size:.9rem}
.btn-primary:hover{filter:brightness(1.05)}
.btn-primary:disabled{opacity:.55;cursor:not-allowed}
.btn-secondary{background:var(--bg2);color:var(--t1);border:1px solid var(--b1);border-radius:8px;padding:12px 20px;font-weight:600;font-size:.875rem}

.gate{padding:16px;background:var(--bg2);border:1px solid var(--b0);border-radius:10px;margin-bottom:16px;font-size:.85rem;color:var(--t1)}
.gate strong{color:var(--t0)}
.contact-card{padding:16px 18px;background:#e8f3ee;border:1px solid #b7e4c7;border-radius:10px;margin-bottom:16px}
.contact-card h4{font-size:.95rem;color:var(--t0);margin-bottom:8px}
.contact-row{font-size:.9rem;color:var(--t1);margin-bottom:4px}
.contact-row b{color:var(--t0)}

/* AUTH / BG-CHECK MODAL */
.sheet-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto}
.sheet{background:var(--bg1);border-radius:16px;width:100%;max-width:460px;max-height:92vh;overflow-y:auto;padding:30px;margin:auto}
.sheet h2{font-size:1.35rem;font-weight:800;color:var(--t0);margin-bottom:4px}
.sheet .sub{font-size:.85rem;color:var(--t2);margin-bottom:22px}
.frow{margin-bottom:13px}
.frow2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:13px}
.fl{display:block;font-size:.7rem;font-weight:600;color:var(--t2);margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em}
.inp{width:100%;background:var(--bg2);border:1px solid var(--b1);border-radius:8px;color:var(--t0);padding:10px 12px;font-size:.9rem;outline:none;transition:border .12s}
.inp:focus{border-color:var(--gold)}
.chk{display:flex;align-items:flex-start;gap:10px;font-size:.82rem;color:var(--t1);margin-bottom:14px;cursor:pointer}
.chk input{width:17px;height:17px;margin-top:2px;flex-shrink:0}
.alert{padding:11px 14px;border-radius:8px;font-size:.82rem;margin-bottom:14px}
.alert-error{background:#ffe0e0;color:#c1121f;border:1px solid #ffb3b3}
.alert-info{background:#e7effb;color:#1d4e89;border:1px solid #c3d7f2}
.alert-success{background:#d8f3dc;color:#1b4332;border:1px solid #b7e4c7}
.link-btn{background:none;border:none;color:var(--gold);font-weight:600;font-size:.82rem;padding:0;cursor:pointer}
.sheet-actions{display:flex;gap:10px;margin-top:8px}
.fee-line{display:flex;justify-content:space-between;font-size:.9rem;padding:6px 0;border-bottom:1px solid var(--b0)}
.fee-total{font-weight:800;color:var(--t0);border-bottom:none;padding-top:10px}

.empty{text-align:center;padding:80px 20px;color:var(--t2)}
.empty h3{font-size:1.2rem;margin-bottom:8px;color:var(--t0)}
.spinner{display:inline-block;width:20px;height:20px;border:2px solid var(--b1);border-top-color:var(--gold);border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.loading{display:flex;align-items:center;justify-content:center;padding:80px;gap:12px;color:var(--t2)}
`

// ── Stripe card step (only mounted when a real clientSecret exists) ──────
function PayForm({ onConfirmed, onError }: { onConfirmed: () => void; onError: (m: string) => void }) {
  const stripe = useStripe()
  const elements = useElements()
  const [busy, setBusy] = useState(false)
  const pay = async () => {
    if (!stripe || !elements) return
    setBusy(true)
    const { error } = await stripe.confirmPayment({ elements, redirect: 'if_required' })
    if (error) { onError(error.message || 'Payment could not be completed'); setBusy(false); return }
    onConfirmed()
  }
  return (
    <div>
      <div style={{ marginBottom: 16 }}><PaymentElement /></div>
      <button className="btn-primary" style={{ width: '100%' }} disabled={busy || !stripe} onClick={pay}>
        {busy ? 'Processing…' : 'Pay & start background check'}
      </button>
    </div>
  )
}

// ── Sign up / log in (+ email-OTP 2FA) ───────────────────────────────────
function AuthFlow({ onClose, onAuthed }: { onClose: () => void; onAuthed: (token: string) => void }) {
  const [mode, setMode] = useState<'signup' | 'login'>('signup')
  const [stage, setStage] = useState<'form' | 'otp'>('form')
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', phone: '', password: '', acceptedTerms: false })
  const [code, setCode] = useState('')
  const [otpSession, setOtpSession] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [info, setInfo] = useState('')
  const set = (k: string, v: any) => setF(s => ({ ...s, [k]: v }))

  const submitForm = async () => {
    setErr(''); setBusy(true)
    try {
      if (mode === 'signup') {
        if (f.password.length < 12) { setErr('Password must be at least 12 characters.'); setBusy(false); return }
        if (!f.acceptedTerms) { setErr('Please accept the Terms and Privacy Policy.'); setBusy(false); return }
        const r = await axios.post(`${API}/api/auth/register`, {
          firstName: f.firstName, lastName: f.lastName, email: f.email,
          phone: f.phone || undefined, password: f.password, role: 'tenant', acceptedTerms: true,
        })
        setOtpSession(r.data.data.emailOtpSession)
        setInfo(`We emailed a 6-digit code to ${f.email}.`)
        setStage('otp')
      } else {
        const r = await axios.post(`${API}/api/auth/login`, { email: f.email, password: f.password })
        if (r.data.data.token) { finish(r.data.data.token); return }
        setOtpSession(r.data.data.emailOtpSession)
        setInfo(`We emailed a 6-digit code to ${f.email}.`)
        setStage('otp')
      }
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Something went wrong. Please try again.')
    } finally { setBusy(false) }
  }

  const verify = async () => {
    setErr(''); setBusy(true)
    try {
      const r = await axios.post(`${API}/api/auth/email-otp/verify`, { emailOtpSession: otpSession, code })
      finish(r.data.data.token)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'That code did not match. Try again.')
    } finally { setBusy(false) }
  }

  const resend = async () => {
    setErr(''); setInfo('')
    try { await axios.post(`${API}/api/auth/email-otp/resend`, { emailOtpSession: otpSession }); setInfo('A fresh code is on its way.') }
    catch { setErr('Could not resend the code.') }
  }

  const finish = (token: string) => { setTok(token); onAuthed(token) }

  return (
    <div className="sheet-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sheet">
        {stage === 'form' ? (
          <>
            <h2>{mode === 'signup' ? 'Create your free account' : 'Welcome back'}</h2>
            <div className="sub">
              {mode === 'signup'
                ? 'See exact addresses, every photo, and apply to any listing. A quick email code keeps your account secure — it links to your background check and, later, your bank.'
                : 'Log in to see full listing details and apply.'}
            </div>
            {err && <div className="alert alert-error">{err}</div>}
            {mode === 'signup' && (
              <div className="frow2">
                <div><label className="fl">First name</label><input className="inp" value={f.firstName} onChange={e => set('firstName', e.target.value)} /></div>
                <div><label className="fl">Last name</label><input className="inp" value={f.lastName} onChange={e => set('lastName', e.target.value)} /></div>
              </div>
            )}
            <div className="frow"><label className="fl">Email</label><input className="inp" type="email" value={f.email} onChange={e => set('email', e.target.value)} /></div>
            {mode === 'signup' && (
              <div className="frow"><label className="fl">Phone (optional)</label><input className="inp" value={f.phone} onChange={e => set('phone', e.target.value)} /></div>
            )}
            <div className="frow">
              <label className="fl">Password{mode === 'signup' ? ' (12+ characters)' : ''}</label>
              <input className="inp" type="password" value={f.password} onChange={e => set('password', e.target.value)} />
            </div>
            {mode === 'signup' && (
              <label className="chk">
                <input type="checkbox" checked={f.acceptedTerms} onChange={e => set('acceptedTerms', e.target.checked)} />
                <span>I agree to the Terms of Service and Privacy Policy.</span>
              </label>
            )}
            <button className="btn-primary" style={{ width: '100%' }} disabled={busy} onClick={submitForm}>
              {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Log in'}
            </button>
            <div style={{ textAlign: 'center', marginTop: 16, fontSize: '.82rem', color: 'var(--t2)' }}>
              {mode === 'signup' ? 'Already have an account? ' : "Don't have an account? "}
              <button className="link-btn" onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setErr('') }}>
                {mode === 'signup' ? 'Log in' : 'Sign up free'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>Enter your code</h2>
            <div className="sub">{info}</div>
            {err && <div className="alert alert-error">{err}</div>}
            <div className="frow">
              <label className="fl">6-digit code</label>
              <input className="inp" inputMode="numeric" maxLength={6} value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                style={{ fontFamily: 'var(--font-m)', fontSize: '1.3rem', letterSpacing: '.3em', textAlign: 'center' }} />
            </div>
            <button className="btn-primary" style={{ width: '100%' }} disabled={busy || code.length < 6} onClick={verify}>
              {busy ? 'Verifying…' : 'Verify & continue'}
            </button>
            <div style={{ textAlign: 'center', marginTop: 14 }}>
              <button className="link-btn" onClick={resend}>Resend code</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── In-app background check (speculative / portable — reusable across listings) ──
function BgCheckFlow({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [stage, setStage] = useState<'intro' | 'pay' | 'done'>('intro')
  const [price, setPrice] = useState<any>(null)
  const [f, setF] = useState({ firstName: '', lastName: '', consentPool: false, acceptedTerms: false })
  const [clientSecret, setClientSecret] = useState('')
  const [intentId, setIntentId] = useState('')
  const [testMode, setTestMode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k: string, v: any) => setF(s => ({ ...s, [k]: v }))

  useEffect(() => {
    axios.get(`${API}/api/background/price`, authCfg())
      .then(r => setPrice(r.data.data))
      .catch(() => setErr('Could not load screening pricing.'))
  }, [])

  const startPayment = async () => {
    setErr('')
    if (!f.firstName || !f.lastName) { setErr('Please enter your legal first and last name.'); return }
    if (!f.consentPool) { setErr('Please consent to the portable screening so it can be reused across listings.'); return }
    if (!f.acceptedTerms) { setErr('Please accept the Terms and Privacy Policy.'); return }
    setBusy(true)
    try {
      const r = await axios.post(`${API}/api/background/payment-intent`, { landlordId: null, unitId: null }, authCfg())
      if (r.data.data.feeWaived) { await submit('waived_no_charge'); return }
      setClientSecret(r.data.data.clientSecret || '')
      setIntentId(r.data.data.intentId)
      setTestMode(!!r.data.data.testMode)
      setStage('pay')
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Could not start payment. Please try again.')
    } finally { setBusy(false) }
  }

  const submit = async (paymentIntentId: string) => {
    setBusy(true); setErr('')
    try {
      const r = await axios.post(`${API}/api/background/submit`, {
        firstName: f.firstName, lastName: f.lastName,
        // Speculative / portable: no landlord — the screen goes to the renter
        // pool and unlocks Apply on every listing once it clears.
        landlordId: null, unitId: null, consentPool: true,
        applicantPaymentIntentId: paymentIntentId,
      }, authCfg())
      if (r.data && r.data.success === false) { setErr(r.data.error || 'Could not start the background check.'); setBusy(false); return }
      setStage('done')
      onDone()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Could not start the background check.')
    } finally { setBusy(false) }
  }

  return (
    <div className="sheet-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sheet">
        {stage === 'intro' && (
          <>
            <h2>Start your background check</h2>
            <div className="sub">One screening unlocks contact on <b>every</b> listing here — you only do this once. Checkr collects the sensitive details securely on their own page; we never see them.</div>
            {err && <div className="alert alert-error">{err}</div>}
            <div className="frow2">
              <div><label className="fl">Legal first name</label><input className="inp" value={f.firstName} onChange={e => set('firstName', e.target.value)} /></div>
              <div><label className="fl">Legal last name</label><input className="inp" value={f.lastName} onChange={e => set('lastName', e.target.value)} /></div>
            </div>
            {price && (
              <div style={{ margin: '10px 0 16px' }}>
                <div className="fee-line"><span>Screening fee</span><span>{money2(Number(price.applicantFee || 0))}</span></div>
                {Number(price.processingFee || 0) > 0 && <div className="fee-line"><span>Processing</span><span>{money2(Number(price.processingFee))}</span></div>}
                {Number(price.tax || 0) > 0 && <div className="fee-line"><span>Tax</span><span>{money2(Number(price.tax))}</span></div>}
                <div className="fee-line fee-total"><span>Total</span><span>{money2(Number(price.totalFee || 0))}</span></div>
              </div>
            )}
            <label className="chk">
              <input type="checkbox" checked={f.consentPool} onChange={e => set('consentPool', e.target.checked)} />
              <span>I want a <b>portable</b> screening added to the renter pool so I can reuse it across listings and landlords can see I'm cleared.</span>
            </label>
            <label className="chk">
              <input type="checkbox" checked={f.acceptedTerms} onChange={e => set('acceptedTerms', e.target.checked)} />
              <span>I agree to the Terms of Service and Privacy Policy.</span>
            </label>
            <div className="sheet-actions">
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn-primary" disabled={busy || !price} onClick={startPayment}>{busy ? 'Please wait…' : 'Continue to payment'}</button>
            </div>
          </>
        )}

        {stage === 'pay' && (
          <>
            <h2>Payment</h2>
            <div className="sub">Your screening fee{price ? ` — ${money2(Number(price.totalFee || 0))}` : ''}.</div>
            {err && <div className="alert alert-error">{err}</div>}
            {testMode ? (
              <>
                <div className="alert alert-info">Test mode — no real card is charged.</div>
                <button className="btn-primary" style={{ width: '100%' }} disabled={busy} onClick={() => submit(intentId)}>
                  {busy ? 'Starting…' : 'Simulate payment & start'}
                </button>
              </>
            ) : clientSecret && stripePromise ? (
              <Elements stripe={stripePromise} options={{ clientSecret }}>
                <PayForm onConfirmed={() => submit(intentId)} onError={setErr} />
              </Elements>
            ) : (
              <div className="alert alert-error">Payment isn’t available right now. Please try again later.</div>
            )}
          </>
        )}

        {stage === 'done' && (
          <>
            <h2>Check your email</h2>
            <div className="alert alert-success">Payment received. Checkr just emailed you a secure link to finish your screening.</div>
            <div className="sub">
              Complete it on Checkr’s page. As soon as it clears, come back here and your <b>Apply</b> button will reveal the landlord’s contact — on this listing and any other.
            </div>
            <button className="btn-primary" style={{ width: '100%' }} onClick={onClose}>Done</button>
          </>
        )}
      </div>
    </div>
  )
}

function App() {
  const [token, setToken] = useState<string | null>(getTok())
  const [bgStatus, setBgStatus] = useState<string | null>(null)
  const [listings, setListings] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<any>(null)
  const [search, setSearch] = useState({ city: '', maxRent: '', beds: '' })
  const [authOpen, setAuthOpen] = useState(false)
  const [bgOpen, setBgOpen] = useState(false)
  // Per-unit apply state: { [unitId]: { busy, error, contact } }
  const [applyState, setApplyState] = useState<Record<string, any>>({})
  const [pendingApplyUnit, setPendingApplyUnit] = useState<string | null>(null)

  const loadListings = useCallback(async () => {
    setLoading(true)
    try {
      const url = getTok()
        ? `${API}/api/public/properties/listings`
        : `${API}/api/public/properties/listings/browse`
      const r = await axios.get(url, authCfg())
      setListings(r.data.data)
    } catch {
      // A stale/expired token → fall back to the anonymous teaser.
      if (getTok()) { clearTok(); setToken(null) }
      try { const r = await axios.get(`${API}/api/public/properties/listings/browse`); setListings(r.data.data) } catch { /* ignore */ }
    } finally { setLoading(false) }
  }, [])

  const loadBgStatus = useCallback(async () => {
    if (!getTok()) { setBgStatus(null); return }
    try { const r = await axios.get(`${API}/api/background/status`, authCfg()); setBgStatus(r.data.data?.status ?? 'not_started') }
    catch { setBgStatus(null) }
  }, [])

  useEffect(() => { loadListings(); loadBgStatus() }, [loadListings, loadBgStatus, token])

  const onAuthed = (t: string) => {
    setToken(t); setAuthOpen(false)
    // If they were mid-apply, resume that unit's flow after we know their status.
    loadBgStatus()
  }

  const logout = () => { clearTok(); setToken(null); setBgStatus(null); setSelected(null); setApplyState({}) }

  const filtered = listings.filter(l => {
    if (search.city && !(String(l.city || '').toLowerCase().includes(search.city.toLowerCase()) ||
        String(l.propertyName || '').toLowerCase().includes(search.city.toLowerCase()))) return false
    if (search.maxRent && Number(l.rentAmount) > Number(search.maxRent)) return false
    if (search.beds && Number(l.bedrooms) < Number(search.beds)) return false
    return true
  })

  const doApply = async (unitId: string) => {
    setApplyState(s => ({ ...s, [unitId]: { busy: true } }))
    try {
      const r = await axios.post(`${API}/api/public/properties/listings/${unitId}/apply`, {}, authCfg())
      setApplyState(s => ({ ...s, [unitId]: { contact: r.data.data.landlord } }))
    } catch (e: any) {
      if (e?.response?.status === 403) {
        // Server says not screened — open the bg-check (defensive; UI usually gates first).
        setApplyState(s => ({ ...s, [unitId]: {} })); setPendingApplyUnit(unitId); setBgOpen(true)
      } else {
        setApplyState(s => ({ ...s, [unitId]: { error: e?.response?.data?.error || 'Could not apply. Please try again.' } }))
      }
    }
  }

  // The stateful Apply button click.
  const onApplyClick = (unitId: string) => {
    if (!getTok()) { setPendingApplyUnit(unitId); setAuthOpen(true); return }
    if (bgStatus && BG_APPROVED.includes(bgStatus)) { doApply(unitId); return }
    if (bgStatus === 'submitted') return // in-progress; button is disabled with a note
    setPendingApplyUnit(unitId); setBgOpen(true)
  }

  const applyLabel = (unitId: string) => {
    const st = applyState[unitId]
    if (st?.contact) return 'Contact revealed'
    if (st?.busy) return 'Applying…'
    if (!getTok()) return 'Sign up to apply'
    if (bgStatus && BG_APPROVED.includes(bgStatus)) return 'Apply & get contact'
    if (bgStatus === 'submitted') return 'Background check in progress'
    return 'Apply — start background check'
  }

  const loggedIn = !!token

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <header className="header">
        <div className="logo">GAM <span>Rentals</span></div>
        <div className="hdr-actions">
          {loggedIn ? (
            <>
              {bgStatus && BG_APPROVED.includes(bgStatus) && <span style={{ color: 'var(--green)', fontWeight: 600 }}>✓ Screened</span>}
              <button className="btn-secondary" style={{ padding: '7px 14px' }} onClick={logout}>Log out</button>
            </>
          ) : (
            <>
              <button className="link-btn" onClick={() => setAuthOpen(true)}>Log in</button>
              <button className="btn-secondary" style={{ padding: '7px 14px' }} onClick={() => setAuthOpen(true)}>Sign up free</button>
            </>
          )}
        </div>
      </header>

      <div className="hero">
        <h1>Find Your Next Home</h1>
        <p>Browse available rentals across the GAM platform.</p>
        <div className="search-bar">
          <input placeholder="City or property name" value={search.city} onChange={e => setSearch(s => ({ ...s, city: e.target.value }))} />
          <select value={search.beds} onChange={e => setSearch(s => ({ ...s, beds: e.target.value }))}>
            <option value="">Any beds</option>
            <option value="1">1+ beds</option>
            <option value="2">2+ beds</option>
            <option value="3">3+ beds</option>
          </select>
          <input type="number" placeholder="Max rent" value={search.maxRent} onChange={e => setSearch(s => ({ ...s, maxRent: e.target.value }))} />
        </div>
      </div>

      <div className="main">
        <div className="results-header">
          <h2>{filtered.length} {filtered.length === 1 ? 'home' : 'homes'} available</h2>
        </div>
        <div className="tier-note">
          {loggedIn
            ? <>Showing full details. {bgStatus && BG_APPROVED.includes(bgStatus) ? 'You’re screened — Apply reveals landlord contact.' : 'Apply to a home to start your one-time background check.'}</>
            : <>Showing previews. <button className="link-btn" onClick={() => setAuthOpen(true)}>Create a free account</button> to see exact addresses and every photo.</>}
        </div>

        {loading && <div className="loading"><span className="spinner" /> Loading listings…</div>}
        {!loading && filtered.length === 0 && (
          <div className="empty"><h3>No listings found</h3><p>Try adjusting your search, or check back soon.</p></div>
        )}

        <div className="grid">
          {filtered.map((l: any) => (
            <div key={l.id} className="card" onClick={() => setSelected(l)}>
              <div className="card-photos">
                {l.photos?.[0]
                  ? <img src={`${API}${l.photos[0]}`} alt="listing" />
                  : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--t3)', fontSize: '.82rem' }}>No photo</div>}
                {l.photoCount > 1 && <div className="card-photos-count">+{l.photoCount - 1} photos</div>}
              </div>
              <div className="card-body">
                <div className="card-price">{money(Number(l.rentAmount))}<span>/mo</span></div>
                <div className="card-address">
                  {loggedIn
                    ? <>{l.propertyName} · Unit {l.unitNumber}<br />{l.street1}, {l.city}, {l.state} {l.zip}</>
                    : <>{l.city}, {l.state}</>}
                </div>
                <div className="card-specs">
                  <span><strong>{l.bedrooms}</strong> bed</span>
                  <span><strong>{l.bathrooms}</strong> bath</span>
                  {l.sqft && <span><strong>{Number(l.sqft).toLocaleString()}</strong> sqft</span>}
                </div>
                {l.availableDate && <div className="card-available">Available {new Date(l.availableDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>}
                <button className="btn-apply" onClick={e => { e.stopPropagation(); setSelected(l) }}>
                  {loggedIn ? 'View & apply' : 'View details'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {selected && (
        <div className="overlay" onClick={e => { if (e.target === e.currentTarget) setSelected(null) }}>
          <div className="modal">
            {selected.photos?.length > 0 && (
              <div className="modal-photos">
                <img src={`${API}${selected.photos[0]}`} alt="main" />
                {selected.photos.length > 1 && (
                  <div className="modal-photos-grid">
                    {selected.photos.slice(1, 3).map((p: string, i: number) => (<img key={i} src={`${API}${p}`} alt={`photo ${i + 2}`} />))}
                  </div>
                )}
              </div>
            )}
            <div className="modal-body">
              <div className="modal-header">
                <div>
                  <div className="modal-price">{money(Number(selected.rentAmount))}<span style={{ fontSize: '.9rem', fontWeight: 400, color: 'var(--t2)', fontFamily: 'var(--font-b)' }}>/mo</span></div>
                  <div style={{ fontSize: '.82rem', color: 'var(--t2)', marginTop: 4 }}>
                    {loggedIn
                      ? <>{selected.propertyName} · Unit {selected.unitNumber} · {selected.street1}, {selected.city}, {selected.state} {selected.zip}</>
                      : <>{selected.city}, {selected.state}</>}
                  </div>
                </div>
                <button className="modal-close" onClick={() => setSelected(null)}>✕</button>
              </div>

              <div className="modal-specs">
                <div className="modal-spec"><span className="modal-spec-val">{selected.bedrooms}</span><span className="modal-spec-lbl">Bedrooms</span></div>
                <div className="modal-spec"><span className="modal-spec-val">{selected.bathrooms}</span><span className="modal-spec-lbl">Bathrooms</span></div>
                {selected.sqft && <div className="modal-spec"><span className="modal-spec-val">{Number(selected.sqft).toLocaleString()}</span><span className="modal-spec-lbl">Sq Ft</span></div>}
                {loggedIn && selected.securityDeposit != null && <div className="modal-spec"><span className="modal-spec-val">{money(Number(selected.securityDeposit))}</span><span className="modal-spec-lbl">Deposit</span></div>}
                {selected.availableDate && <div className="modal-spec"><span className="modal-spec-val">{new Date(selected.availableDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span><span className="modal-spec-lbl">Available</span></div>}
              </div>

              {loggedIn && selected.listingDescription && <div className="modal-desc">{selected.listingDescription}</div>}

              {!loggedIn && (
                <div className="gate">
                  <strong>Want the full picture?</strong> Create a free account to see the exact address, every photo, and to apply.
                </div>
              )}

              {loggedIn && applyState[selected.id]?.contact && (
                <div className="contact-card">
                  <h4>✓ Application sent — here’s the landlord</h4>
                  {applyState[selected.id].contact.name && <div className="contact-row"><b>{applyState[selected.id].contact.name}</b></div>}
                  {applyState[selected.id].contact.phone && <div className="contact-row">Phone: <b>{applyState[selected.id].contact.phone}</b></div>}
                  {applyState[selected.id].contact.email && <div className="contact-row">Email: <b>{applyState[selected.id].contact.email}</b></div>}
                </div>
              )}
              {loggedIn && bgStatus === 'submitted' && !applyState[selected.id]?.contact && (
                <div className="gate">Your background check is <strong>in progress</strong> — finish it from the email Checkr sent. Once it clears, Apply will reveal the landlord’s contact here.</div>
              )}
              {applyState[selected.id]?.error && <div className="alert alert-error">{applyState[selected.id].error}</div>}

              <div className="modal-footer">
                {!applyState[selected.id]?.contact && (
                  <button
                    className="btn-primary"
                    disabled={applyState[selected.id]?.busy || bgStatus === 'submitted'}
                    onClick={() => { if (!loggedIn) { setSelected(selected); } onApplyClick(selected.id) }}>
                    {applyLabel(selected.id)}
                  </button>
                )}
                <button className="btn-secondary" onClick={() => setSelected(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {authOpen && <AuthFlow onClose={() => setAuthOpen(false)} onAuthed={(t) => {
        onAuthed(t)
        // Resume a pending apply once the account exists (bg status loads async;
        // the button will reflect the right next step when they click again).
        setPendingApplyUnit(null)
      }} />}

      {bgOpen && <BgCheckFlow onClose={() => { setBgOpen(false); setPendingApplyUnit(null) }} onDone={() => { loadBgStatus(); }} />}
    </>
  )
}

const rootEl = document.getElementById('root')!
const appRoot: ReturnType<typeof ReactDOM.createRoot> =
  (window as any).__gam_app_root ?? ((window as any).__gam_app_root = ReactDOM.createRoot(rootEl))
appRoot.render(
  <React.StrictMode>
    <SentryErrorBoundary fallback={<div style={{ padding: 40, textAlign: 'center' }}>
      <div style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: 8 }}>Something went wrong</div>
      <button onClick={() => window.location.reload()}>Reload</button>
    </div>}>
      <App />
    </SentryErrorBoundary>
  </React.StrictMode>
)
