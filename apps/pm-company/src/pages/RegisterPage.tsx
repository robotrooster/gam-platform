/**
 * RegisterPage — onboarding for a new PM company.
 *
 * Flow:
 *   1. If the user is not signed in, send them to the auth signup endpoint
 *      that mints a regular gam user (POST /auth/register).
 *   1b. S655: enter the 6-digit code emailed to them. Since S578 every new
 *      account proves its address with that code before it gets a session —
 *      /auth/register returns a pending session, not a sign-in. This page used
 *      to ignore it and call password sign-in straight away, which production
 *      refuses for an unproven address ("Please verify your email"), so every
 *      PM self-signup stopped on an error with the account half made.
 *   2. Once signed in (whether new or existing), call POST /pm/companies
 *      to create the company. The backend auto-creates a pm_staff row
 *      with role='owner' for the calling user.
 *   3. Refresh auth so the AuthContext picks up the new pm_staff
 *      membership and routes the user into the portal.
 *
 * If the user is already signed in but has no pm_staff membership, this
 * page is the redirect target — they jump straight to step 2.
 */

import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { PASSWORD_MIN_LEN } from '@gam/shared'
import { useAuth } from '../context/AuthContext'
import { apiPost } from '../lib/api'
import { BUSINESS_TERMS_URL, BUSINESS_PRIVACY_URL } from '../lib/marketing'

// S639: the code step must survive leaving the page — a phone browser can
// discard and reload the tab while someone reads the code in their mail app.
// sessionStorage holds only the short-lived pending session, which is
// worthless without the code from their inbox.
function usePendingOtpSession(key: string): [string | null, (v: string | null) => void] {
  const [v, setV] = useState<string | null>(() => {
    try { return sessionStorage.getItem(key) } catch { return null }
  })
  const set = (next: string | null) => {
    setV(next)
    try {
      if (next) sessionStorage.setItem(key, next)
      else sessionStorage.removeItem(key)
    } catch { /* private mode — behaves as plain state */ }
  }
  return [v, set]
}

export function RegisterPage() {
  const { user, loginWithEmailOtp, resendEmailOtp, refresh } = useAuth()
  const navigate = useNavigate()

  const [emailOtpSession, setEmailOtpSession] = usePendingOtpSession('gam.otp.pm.register')
  const [step, setStep] = useState<'account' | 'code' | 'company'>(
    user ? 'company' : (emailOtpSession ? 'code' : 'account'))
  // A signed-in visitor whose session finished loading after this page mounted
  // belongs on the company step, not the account form.
  useEffect(() => { if (user && step === 'account') setStep('company') }, [user, step])
  // True once THIS page created the account, so the "you're signed in but not
  // in a PM company" note is not shown to someone who signed up a second ago.
  const [justRegistered, setJustRegistered] = useState(false)
  const [code, setCode] = useState('')
  const [resent, setResent] = useState(false)

  // account form
  const [first, setFirst] = useState('')
  const [last, setLast]   = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [acceptedTerms, setAcceptedTerms] = useState(false)

  // company form
  const [companyName, setCompanyName] = useState('')
  const [businessEmail, setBusinessEmail] = useState('')
  const [businessPhone, setBusinessPhone] = useState('')
  const [ein, setEin] = useState('')

  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submitAccount = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!acceptedTerms) { setErr('You must accept the Terms of Service and Privacy Policy to continue.'); return }
    setErr(null); setBusy(true)
    try {
      // S29X: snake_case → camelCase to match registerSchema. The
      // backend insists on firstName/lastName + role + acceptedTerms.
      // Pre-S29X this call posted snake_case + no role and would have
      // failed schema validation — the pm-company self-register path
      // was effectively broken. Now fixed.
      const res = await apiPost<any>('/auth/register', {
        firstName: first, lastName: last, email, password,
        role: 'landlord',
        acceptedTerms: true,
      })
      // S655: the account exists; the emailed code finishes signing in.
      if (!res.data?.emailOtpSession) throw new Error('Your account was created. Sign in to continue.')
      setEmailOtpSession(res.data.emailOtpSession)
      setCode(''); setResent(false)
      setStep('code')
    } catch (ex: any) {
      setErr(ex?.response?.data?.error || ex?.message || 'Account creation failed.')
    } finally { setBusy(false) }
  }

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setBusy(true)
    try {
      await loginWithEmailOtp(emailOtpSession!, code.trim())
      setEmailOtpSession(null)
      setJustRegistered(true)
      setStep('company')
    } catch (ex: any) {
      const msg = ex?.response?.data?.error || 'That code did not work. Try again.'
      if (/session/i.test(msg)) {
        // The pending sign-in ran out. The account is there; signing in sends a new code.
        setEmailOtpSession(null)
        setErr('Your sign-in timed out. Your account was created, so sign in to continue.')
        setStep('account')
      } else setErr(msg)
    } finally { setBusy(false) }
  }

  const resend = async () => {
    setErr(null); setResent(false)
    try { await resendEmailOtp(emailOtpSession!); setResent(true) }
    catch (ex: any) { setErr(ex?.response?.data?.error || 'Could not resend the code.') }
  }

  const submitCompany = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setBusy(true)
    try {
      await apiPost('/pm/companies', {
        name: companyName,
        businessEmail: businessEmail || null,
        businessPhone: businessPhone || null,
        ein: ein || null,
      })
      await refresh()
      navigate('/')
    } catch (ex: any) {
      setErr(ex?.response?.data?.error || 'Company creation failed.')
    } finally { setBusy(false) }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-0)' }}>
      <div className="card" style={{ width: 460, padding: 32 }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--gold)' }}>⚡ GAM PM</div>
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
            {step === 'account' ? 'Create your account'
              : step === 'code' ? 'Check your email'
              : 'Register your PM company'}
          </div>
        </div>

        {/* When the user is already signed in but has no pm_staff
            membership, the PrivateRoute lands them here. Offer them a
            way out before assuming they want to start a PM company. */}
        {user && step === 'company' && !justRegistered && (
          <div style={{ marginBottom: 16, padding: 12, background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.25)', borderRadius: 8, fontSize: '.78rem', color: 'var(--text-2)' }}>
            <div style={{ marginBottom: 8 }}>
              You&apos;re signed in as <strong>{user.email}</strong> but not a member of any PM company.
              Register one below — or head to your other portal:
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <a className="btn btn-ghost btn-sm"
                 href={(import.meta as any).env?.VITE_LANDLORD_APP_URL || 'http://localhost:3001'}
                 rel="noopener">Landlord Portal</a>
              <a className="btn btn-ghost btn-sm"
                 href={(import.meta as any).env?.VITE_TENANT_APP_URL || 'http://localhost:3002'}
                 rel="noopener">Tenant Portal</a>
            </div>
          </div>
        )}

        {step === 'account' && (
          <form onSubmit={submitAccount}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
              <div>
                <label style={lbl}>First name</label>
                <input className="input" required value={first} onChange={e => setFirst(e.target.value)} style={{ width: '100%' }} />
              </div>
              <div>
                <label style={lbl}>Last name</label>
                <input className="input" required value={last} onChange={e => setLast(e.target.value)} style={{ width: '100%' }} />
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Email</label>
              <input type="email" required className="input" value={email} onChange={e => setEmail(e.target.value)} style={{ width: '100%' }} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={lbl}>Password</label>
              {/* S655: the server requires PASSWORD_MIN_LEN (12); this said 8, so an
                  8-11 character password passed here and failed on submit. */}
              <input type="password" required minLength={PASSWORD_MIN_LEN} className="input" value={password} onChange={e => setPassword(e.target.value)} style={{ width: '100%' }} />
              <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 4 }}>At least {PASSWORD_MIN_LEN} characters.</div>
            </div>

            <div style={{ marginBottom: 16, padding: '10px 12px', background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 8 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={acceptedTerms} onChange={e => setAcceptedTerms(e.target.checked)} style={{ marginTop: 2 }} />
                <div style={{ fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
                  {/* S636/S640: stopPropagation because the links live inside the
                      checkbox <label>; URLs from lib/marketing so a missing build
                      var can't ship a localhost link. */}
                  I agree to the{' '}
                  <a href={BUSINESS_TERMS_URL} target="_blank" rel="noopener noreferrer"
                     onClick={e => e.stopPropagation()}
                     style={{ color: 'var(--gold)' }}>Terms of Service</a>
                  {' '}and{' '}
                  <a href={BUSINESS_PRIVACY_URL} target="_blank" rel="noopener noreferrer"
                     onClick={e => e.stopPropagation()}
                     style={{ color: 'var(--gold)' }}>Privacy Policy</a>.
                </div>
              </label>
            </div>

            {err && <ErrBox msg={err} />}

            <button type="submit" className="btn btn-primary" disabled={busy || !acceptedTerms} style={{ width: '100%' }}>
              {busy ? 'Creating account…' : 'Continue'}
            </button>

            <div style={{ marginTop: 14, textAlign: 'center', fontSize: '.78rem', color: 'var(--text-3)' }}>
              Already have an account? <Link to="/login" style={{ color: 'var(--gold)' }}>Sign in</Link>
            </div>
          </form>
        )}

        {step === 'code' && (
          <form onSubmit={submitCode}>
            <div style={{ marginBottom: 16, fontSize: '.8rem', color: 'var(--text-2)', textAlign: 'center', lineHeight: 1.5 }}>
              We emailed a 6-digit code to {email ? <strong>{email}</strong> : 'you'}. Enter it to finish creating your account.
              {resent && (
                <div style={{ fontSize: '.72rem', color: 'var(--green, #46a758)', marginTop: 4 }}>A new code is on its way.</div>
              )}
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={lbl}>Code</label>
              <input type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus required
                     className="input" value={code} onChange={e => setCode(e.target.value)} placeholder="123456"
                     style={{ width: '100%', textAlign: 'center', letterSpacing: '.2em', fontFamily: 'var(--font-mono)' }} />
            </div>

            {err && <ErrBox msg={err} />}

            <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()} style={{ width: '100%' }}>
              {busy ? 'Checking…' : 'Verify and continue'}
            </button>
            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <button type="button" disabled={busy} onClick={resend}
                      style={{ background: 'none', border: 'none', color: 'var(--gold)', fontSize: '.78rem', cursor: 'pointer', textDecoration: 'underline' }}>
                Resend code
              </button>
            </div>
          </form>
        )}

        {step === 'company' && (
          <form onSubmit={submitCompany}>
            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Company name *</label>
              <input className="input" required value={companyName} onChange={e => setCompanyName(e.target.value)}
                     placeholder="Smith Property Management" style={{ width: '100%' }} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Business email</label>
              <input type="email" className="input" value={businessEmail} onChange={e => setBusinessEmail(e.target.value)} style={{ width: '100%' }} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Business phone</label>
              <input className="input" value={businessPhone} onChange={e => setBusinessPhone(e.target.value)} style={{ width: '100%' }} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={lbl}>EIN</label>
              <input className="input" value={ein} onChange={e => setEin(e.target.value)}
                     placeholder="For 1099 reporting" style={{ width: '100%' }} />
            </div>

            {err && <ErrBox msg={err} />}

            <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Creating company…' : 'Create PM Company'}
            </button>

            <div style={{ marginTop: 14, fontSize: '.72rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
              You&apos;ll be set as the company&apos;s owner. You can invite staff,
              create fee plans, and link properties from the dashboard.
              Banking setup happens after registration via Stripe Connect.
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

const lbl: React.CSSProperties = {
  fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)',
  textTransform: 'uppercase', letterSpacing: '.06em',
  display: 'block', marginBottom: 5,
}

function ErrBox({ msg }: { msg: string }) {
  return (
    <div style={{ padding: 8, background: 'rgba(220,76,76,.1)', borderRadius: 6, fontSize: '.74rem', color: 'var(--red, #dc4c4c)', marginBottom: 12 }}>
      {msg}
    </div>
  )
}
