import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { CONSUMER_TERMS_URL, CONSUMER_PRIVACY_URL } from '../lib/marketing'

export function AcceptInvitePage() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const navigate = useNavigate()

  const [inviteInfo, setInviteInfo] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // S637: they finished this already and came back to the same email.
  const [alreadyDone, setAlreadyDone] = useState(false)
  const [form, setForm] = useState({ password: '', confirmPassword: '', phone: '', acceptedTerms: false })
  const [showPw, setShowPw] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [step, setStep] = useState(0)
  // S578: mandatory email-2FA at activation. accept-invite returns a PENDING
  // session; the code exchange at /auth/email-otp/verify yields the real token.
  const [emailOtpSession, setEmailOtpSession] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [resent, setResent] = useState(false)

  useEffect(() => {
    if (!token) { setError('Invalid invite link'); setLoading(false); return }
    apiGet(`/tenants/invite-info?token=${token}`)
      .then((data: any) => { setInviteInfo(data); setLoading(false) })
      .catch(() => { setError('This invite link is invalid or has already been used.'); setLoading(false) })
  }, [token])

  const handleSubmit = async () => {
    if (form.password.length < 12) { setError('Password must be at least 12 characters'); return }
    if (form.password !== form.confirmPassword) { setError('Passwords do not match'); return }
    if (!form.acceptedTerms) { setError('You must accept the Terms of Service and Privacy Policy to continue'); return }
    setSubmitting(true)
    setError('')
    try {
      const res: any = await apiPost('/tenants/accept-invite', {
        token, password: form.password,
        phone: form.phone || undefined,
        acceptedTerms: true,
      })
      // S578: activation now issues a pending 2FA session. Move to the emailed-
      // code step rather than logging straight in.
      setEmailOtpSession(res.data.emailOtpSession)
      setCode(''); setResent(false); setStep(2); setSubmitting(false)
    } catch (e: any) {
      // S637: an already-accepted invite is a DIFFERENT outcome from a broken
      // one — they have an account and simply need to sign in.
      if (e?.response?.data?.code === 'ALREADY_ACCEPTED') setAlreadyDone(true)
      setError(e?.response?.data?.error || 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  const verifyCode = async () => {
    if (!emailOtpSession) return
    setSubmitting(true); setError('')
    try {
      const res: any = await apiPost('/auth/email-otp/verify', { emailOtpSession, code: code.trim() })
      localStorage.setItem('gam_tenant_token', res.data.token)
      const next = params.get('next')
      navigate(next || '/')
    } catch (e: any) {
      const msg = e?.response?.data?.error || 'Invalid code.'
      setError(msg)
      if (/session/i.test(msg)) { setEmailOtpSession(null); setStep(1) }
      setSubmitting(false)
    }
  }

  const resendCode = async () => {
    if (!emailOtpSession) return
    setError('')
    try { await apiPost('/auth/email-otp/resend', { emailOtpSession }); setResent(true) }
    catch { setError('Could not resend the code. Please try again.') }
  }

  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#060809' }}>
      <div style={{ width: 32, height: 32, border: '3px solid #1a2028', borderTopColor: '#c9a227', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
    </div>
  )

  // ── S637: THEY ARE NOT LOCKED OUT ───────────────────────────────────
  //
  // Nic: "Several more people tell me that their invite expired when they
  // already accepted it. They tried to go back to that email only to find out
  // that it's expired because they used it, and they think that it locked them
  // out, and they need a new invite."
  //
  // This is the screen that told them so. It said "Invalid Invite" and
  // "Contact your landlord for a new invite link" — advice that sends a tenant
  // with a perfectly good account back to the landlord for something they do
  // not need. Say what actually happened, and point at the door.
  if (alreadyDone) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#060809', padding: 24, fontFamily: 'system-ui' }}>
      <div style={{ maxWidth: 430, textAlign: 'center', color: '#b8c4d8' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
        <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#eef1f8', marginBottom: 8 }}>
          You&rsquo;re already set up
        </div>
        <div style={{ fontSize: '.88rem', lineHeight: 1.65 }}>
          This invite link has already been used — that&rsquo;s why it won&rsquo;t open again.
          Nothing is wrong with your account and you don&rsquo;t need a new invite.
        </div>
        <a href="/login" style={{ display: 'inline-block', marginTop: 18, padding: '11px 26px',
          background: '#c9a227', color: '#060809', borderRadius: 10, fontWeight: 800,
          textDecoration: 'none', fontSize: '.9rem' }}>Sign in</a>
        <div style={{ fontSize: '.8rem', color: '#8a96b0', marginTop: 18, lineHeight: 1.6 }}>
          Signing your lease? That comes as a <strong style={{ color: '#c9a227' }}>separate email</strong> —
          look for &ldquo;please sign&rdquo; in your inbox rather than reopening this one.
        </div>
      </div>
    </div>
  )

  if (error && !inviteInfo) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#060809', padding: 24, fontFamily: 'system-ui' }}>
      <div style={{ maxWidth: 400, textAlign: 'center', color: '#b8c4d8' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
        <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#eef1f8', marginBottom: 8 }}>Invalid Invite</div>
        <div style={{ fontSize: '.85rem', lineHeight: 1.6 }}>{error}</div>
        {/* S637: the commonest reason this screen appears is a link that was
            already used successfully — so lead with that, and only then offer
            the landlord. */}
        <div style={{ fontSize: '.8rem', color: '#8a96b0', marginTop: 14, lineHeight: 1.6 }}>
          If you already set a password with this link, you&rsquo;re done —{' '}
          <a href="/login" style={{ color: '#c9a227', fontWeight: 700 }}>sign in</a> instead.
          Your lease comes as a <strong style={{ color: '#c9a227' }}>separate email</strong>.
        </div>
        <div style={{ fontSize: '.75rem', color: '#3d4d68', marginTop: 10 }}>Still stuck? Ask your landlord to resend it.</div>
      </div>
    </div>
  )

  const unit = inviteInfo?.unit
  const user = inviteInfo?.user

  const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', background: '#141920', border: '1px solid #252e3d', borderRadius: 8, color: '#eef1f8', fontSize: '.85rem', outline: 'none', fontFamily: 'system-ui' }
  const labelStyle: React.CSSProperties = { fontSize: '.72rem', fontWeight: 600, color: '#7a8aaa', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }

  return (
    <div style={{ minHeight: '100vh', background: '#060809', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'system-ui' }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width: '100%', maxWidth: 480 }}>

        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#c9a227', letterSpacing: '.04em' }}>⚡ GAM</div>
          <div style={{ fontSize: '.75rem', color: '#3d4d68', marginTop: 2 }}>Gold Asset Management</div>
        </div>

        {step === 0 && (
          <div style={{ background: '#0a0d10', border: '1px solid #1e2530', borderRadius: 16, padding: 28 }}>
            <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#eef1f8', marginBottom: 6 }}>Welcome, {user?.firstName}! 👋</div>
            <div style={{ fontSize: '.82rem', color: '#7a8aaa', marginBottom: 20, lineHeight: 1.6 }}>
              Your landlord has invited you to manage your tenancy through GAM.
            </div>

            {unit && (
              <div style={{ background: '#0f1318', border: '1px solid #1e2530', borderRadius: 12, padding: 16, marginBottom: 20 }}>
                <div style={{ fontSize: '.68rem', fontWeight: 700, color: '#7a8aaa', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 10 }}>Your Unit</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(201,162,39,.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#c9a227' }}>🚪</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '.95rem', fontWeight: 700, color: '#eef1f8' }}>Unit {unit.unitNumber}</div>
                    <div style={{ fontSize: '.72rem', color: '#7a8aaa', marginTop: 2 }}>{unit.propertyName} · {unit.street1}, {unit.city}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '.95rem', color: '#c9a227', fontWeight: 700 }}>{fmt(unit.rentAmount)}</div>
                    <div style={{ fontSize: '.65rem', color: '#7a8aaa' }}>per month</div>
                  </div>
                </div>
              </div>
            )}

            {[
              { icon: '💳', title: 'Pay rent online', desc: 'ACH bank transfer — no checks' },
              { icon: '🔧', title: 'Maintenance requests', desc: 'Submit and track repairs instantly' },
              { icon: '📄', title: 'Your documents', desc: 'Leases and notices in one place' },
            ].map(item => (
              <div key={item.title} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid #1e2530', fontSize: '.78rem' }}>
                <span style={{ fontSize: '1.1rem' }}>{item.icon}</span>
                <div>
                  <div style={{ fontWeight: 600, color: '#eef1f8' }}>{item.title}</div>
                  <div style={{ color: '#7a8aaa', fontSize: '.7rem' }}>{item.desc}</div>
                </div>
              </div>
            ))}

            <button onClick={() => setStep(1)} style={{ width: '100%', marginTop: 20, padding: 13, borderRadius: 10, border: 'none', background: 'linear-gradient(135deg, #8a6c10, #c9a227)', color: '#060809', fontWeight: 700, fontSize: '.9rem', cursor: 'pointer' }}>
              Get Started →
            </button>
          </div>
        )}

        {step === 1 && (
          <div style={{ background: '#0a0d10', border: '1px solid #1e2530', borderRadius: 16, padding: 28 }}>
            <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#eef1f8', marginBottom: 4 }}>Set your password</div>
            <div style={{ fontSize: '.78rem', color: '#7a8aaa', marginBottom: 20 }}>Signing in as <strong style={{ color: '#b8c4d8' }}>{user?.email}</strong></div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Password</label>
              <div style={{ position: 'relative' }}>
                <input type={showPw ? 'text' : 'password'} style={{ ...inputStyle, paddingRight: 40 }} placeholder="Min 12 characters" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} autoFocus />
                <button type="button" onClick={() => setShowPw(v => !v)} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#7a8aaa' }}>
                  {showPw ? '🙈' : '👁️'}
                </button>
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Confirm Password</label>
              <input type={showPw ? 'text' : 'password'} style={inputStyle} placeholder="Repeat password" value={form.confirmPassword} onChange={e => setForm(f => ({ ...f, confirmPassword: e.target.value }))} />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Phone <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span></label>
              <input type="tel" style={inputStyle} placeholder="(555) 000-0000" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
            </div>

            <div style={{ marginBottom: 20, padding: '12px 14px', background: form.acceptedTerms ? 'rgba(34,197,94,.06)' : '#141a22', border: '1px solid ' + (form.acceptedTerms ? 'rgba(34,197,94,.25)' : '#1e2530'), borderRadius: 10 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.acceptedTerms} onChange={e => setForm(f => ({ ...f, acceptedTerms: e.target.checked }))} style={{ marginTop: 2 }} />
                <div>
                  <div style={{ fontSize: '.78rem', fontWeight: 600, color: '#eef1f8' }}>Platform Terms &amp; Privacy</div>
                  {/* S636 (Nic): the links are inside the <label>, so without
                      stopPropagation a click on one toggles the checkbox instead
                      of opening the document — which is exactly what "not
                      clickable" looked like. */}
                  <div style={{ fontSize: '.7rem', color: '#7a8aaa', marginTop: 2, lineHeight: 1.5 }}>
                    I agree to the{' '}
                    <a href={CONSUMER_TERMS_URL} target="_blank" rel="noopener noreferrer"
                       onClick={e => e.stopPropagation()}
                       style={{ color: '#c9a227' }}>Terms of Service</a>
                    {' '}and{' '}
                    <a href={CONSUMER_PRIVACY_URL} target="_blank" rel="noopener noreferrer"
                       onClick={e => e.stopPropagation()}
                       style={{ color: '#c9a227' }}>Privacy Policy</a>.
                  </div>
                </div>
              </label>
              {/* S636 (Nic): "Maybe we have those further down below for the
                  privacy policy and terms of service, in case there's people
                  that actually want to read them." Same reasoning as the email
                  fix — a link that will not open leaves no way to reach the
                  document, and this is the one someone is agreeing to. */}
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1e2530',
                            fontSize: '.63rem', color: '#5a6a86', lineHeight: 1.6, wordBreak: 'break-all' }}>
                Prefer to read them directly?<br />
                {CONSUMER_TERMS_URL}<br />
                {CONSUMER_PRIVACY_URL}
              </div>
            </div>

            {error && (
              <div style={{ color: '#ff4757', fontSize: '.75rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 14 }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setStep(0)} style={{ flex: 1, padding: 12, borderRadius: 10, border: '1px solid #252e3d', background: '#141920', color: '#7a8aaa', cursor: 'pointer', fontWeight: 600 }}>Back</button>
              <button
                onClick={handleSubmit}
                disabled={submitting || !form.password || !form.confirmPassword || !form.acceptedTerms}
                style={{ flex: 2, padding: 12, borderRadius: 10, border: 'none', background: submitting ? '#1a2028' : 'linear-gradient(135deg, #8a6c10, #c9a227)', color: '#060809', fontWeight: 700, cursor: submitting ? 'not-allowed' : 'pointer', opacity: (!form.password || !form.confirmPassword || !form.acceptedTerms) ? .5 : 1 }}
              >
                {submitting ? '...' : 'Create Account →'}
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ background: '#0a0d10', border: '1px solid #1e2530', borderRadius: 16, padding: 28 }}>
            <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#eef1f8', marginBottom: 6 }}>Check your email</div>
            <div style={{ fontSize: '.8rem', color: '#7a8aaa', marginBottom: 20, lineHeight: 1.6 }}>
              We sent a 6-digit code to <strong style={{ color: '#b8c4d8' }}>{user?.email}</strong>. Enter it to finish activating your account.
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Verification Code</label>
              <input
                style={{ ...inputStyle, fontFamily: 'monospace', letterSpacing: '.2em', textAlign: 'center', fontSize: '1rem' }}
                value={code} onChange={e => setCode(e.target.value)} autoFocus
                autoComplete="one-time-code" inputMode="numeric" placeholder="123 456"
                onKeyDown={e => { if (e.key === 'Enter' && code.trim()) verifyCode() }}
              />
            </div>

            {resent && !error && (
              <div style={{ color: '#22c55e', fontSize: '.75rem', background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 14 }}>A new code is on its way.</div>
            )}
            {error && (
              <div style={{ color: '#ff4757', fontSize: '.75rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 14 }}>{error}</div>
            )}

            <button
              onClick={verifyCode}
              disabled={submitting || !code.trim()}
              style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: submitting ? '#1a2028' : 'linear-gradient(135deg, #8a6c10, #c9a227)', color: '#060809', fontWeight: 700, cursor: submitting ? 'not-allowed' : 'pointer', opacity: !code.trim() ? .5 : 1 }}
            >
              {submitting ? '...' : 'Verify & Continue'}
            </button>
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <button onClick={resendCode} style={{ background: 'none', border: 'none', color: '#c9a227', fontSize: '.8rem', cursor: 'pointer', textDecoration: 'underline' }}>Resend code</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
