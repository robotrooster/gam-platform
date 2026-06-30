/**
 * RegisterPage — onboarding for a new PM company.
 *
 * Flow:
 *   1. If the user is not signed in, send them to the auth signup endpoint
 *      that mints a regular gam user (POST /auth/register).
 *   2. Once signed in (whether new or existing), call POST /pm/companies
 *      to create the company. The backend auto-creates a pm_staff row
 *      with role='owner' for the calling user.
 *   3. Refresh auth so the AuthContext picks up the new pm_staff
 *      membership and routes the user into the portal.
 *
 * If the user is already signed in but has no pm_staff membership, this
 * page is the redirect target — they jump straight to step 2.
 */

import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { apiPost } from '../lib/api'

export function RegisterPage() {
  const { user, login, refresh } = useAuth()
  const navigate = useNavigate()

  const [step, setStep] = useState<'account' | 'company'>(user ? 'company' : 'account')

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
      await apiPost('/auth/register', {
        firstName: first, lastName: last, email, password,
        role: 'landlord',
        acceptedTerms: true,
      })
      await login(email, password)
      setStep('company')
    } catch (ex: any) {
      setErr(ex?.response?.data?.error || 'Account creation failed.')
    } finally { setBusy(false) }
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
            {step === 'account' ? 'Create your account' : 'Register your PM company'}
          </div>
        </div>

        {/* When the user is already signed in but has no pm_staff
            membership, the PrivateRoute lands them here. Offer them a
            way out before assuming they want to start a PM company. */}
        {user && step === 'company' && (
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
              <input type="password" required minLength={8} className="input" value={password} onChange={e => setPassword(e.target.value)} style={{ width: '100%' }} />
            </div>

            <div style={{ marginBottom: 16, padding: '10px 12px', background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 8 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={acceptedTerms} onChange={e => setAcceptedTerms(e.target.checked)} style={{ marginTop: 2 }} />
                <div style={{ fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
                  I agree to the{' '}
                  <a href={`${(import.meta as any).env?.VITE_MARKETING_URL || 'http://localhost:3004'}/business/terms`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--gold)' }}>Terms of Service</a>
                  {' '}and{' '}
                  <a href={`${(import.meta as any).env?.VITE_MARKETING_URL || 'http://localhost:3004'}/business/privacy`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--gold)' }}>Privacy Policy</a>.
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
