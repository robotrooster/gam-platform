import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { Eye, EyeOff, Check, DoorOpen, Building2 } from 'lucide-react'

export function AcceptInvitePage() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const navigate = useNavigate()

  const [inviteInfo, setInviteInfo] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ password: '', confirmPassword: '', phone: '', ssiSsdi: false })
  const [showPw, setShowPw] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (!token) { setError('Invalid invite link'); setLoading(false); return }
    apiGet(`/tenants/invite-info?token=${token}`)
      .then((data: any) => { setInviteInfo(data); setLoading(false) })
      .catch(() => { setError('This invite link is invalid or has already been used.'); setLoading(false) })
  }, [token])

  const handleSubmit = async () => {
    if (form.password.length < 8) { setError('Password must be at least 8 characters'); return }
    if (form.password !== form.confirmPassword) { setError('Passwords do not match'); return }
    setSubmitting(true)
    setError('')
    try {
      const res: any = await apiPost('/tenants/accept-invite', {
        token, password: form.password,
        phone: form.phone || undefined,
        ssiSsdi: form.ssiSsdi,
      })
      // Store token and redirect to tenant portal
      localStorage.setItem('gam_token', res.data.token)
      navigate('/')
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#060809' }}>
      <div style={{ width: 32, height: 32, border: '3px solid #1a2028', borderTopColor: '#c9a227', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
    </div>
  )

  if (error && !inviteInfo) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#060809', padding: 24, fontFamily: 'system-ui' }}>
      <div style={{ maxWidth: 400, textAlign: 'center', color: '#b8c4d8' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
        <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#eef1f8', marginBottom: 8 }}>Invalid Invite</div>
        <div style={{ fontSize: '.85rem', lineHeight: 1.6 }}>{error}</div>
        <div style={{ fontSize: '.75rem', color: '#3d4d68', marginTop: 12 }}>Contact your landlord for a new invite link.</div>
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
            <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#eef1f8', marginBottom: 6 }}>Welcome, {user?.first_name}! 👋</div>
            <div style={{ fontSize: '.82rem', color: '#7a8aaa', marginBottom: 20, lineHeight: 1.6 }}>
              Your landlord has invited you to manage your tenancy through GAM.
            </div>

            {unit && (
              <div style={{ background: '#0f1318', border: '1px solid #1e2530', borderRadius: 12, padding: 16, marginBottom: 20 }}>
                <div style={{ fontSize: '.68rem', fontWeight: 700, color: '#7a8aaa', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 10 }}>Your Unit</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(201,162,39,.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#c9a227' }}>🚪</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '.95rem', fontWeight: 700, color: '#eef1f8' }}>Unit {unit.unit_number}</div>
                    <div style={{ fontSize: '.72rem', color: '#7a8aaa', marginTop: 2 }}>{unit.property_name} · {unit.street1}, {unit.city}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '.95rem', color: '#c9a227', fontWeight: 700 }}>{fmt(unit.rent_amount)}</div>
                    <div style={{ fontSize: '.65rem', color: '#7a8aaa' }}>per month</div>
                  </div>
                </div>
              </div>
            )}

            {[
              { icon: '💳', title: 'Pay rent online', desc: 'ACH bank transfer — no checks' },
              { icon: '🔧', title: 'Maintenance requests', desc: 'Submit and track repairs instantly' },
              { icon: '📄', title: 'Your documents', desc: 'Leases and notices in one place' },
              { icon: '⚡', title: 'On-Time Pay', desc: 'Protect your rental history' },
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
                <input type={showPw ? 'text' : 'password'} style={{ ...inputStyle, paddingRight: 40 }} placeholder="Min 8 characters" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} autoFocus />
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

            <div style={{ marginBottom: 20, padding: '12px 14px', background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.2)', borderRadius: 10 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.ssiSsdi} onChange={e => setForm(f => ({ ...f, ssiSsdi: e.target.checked }))} style={{ marginTop: 2 }} />
                <div>
                  <div style={{ fontSize: '.78rem', fontWeight: 600, color: '#eef1f8' }}>I receive SSI or SSDI benefits</div>
                  <div style={{ fontSize: '.7rem', color: '#7a8aaa', marginTop: 2, lineHeight: 1.5 }}>Enables On-Time Pay — we initiate rent on time even if your benefits arrive late. $20/month service fee.</div>
                </div>
              </label>
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
                disabled={submitting || !form.password || !form.confirmPassword}
                style={{ flex: 2, padding: 12, borderRadius: 10, border: 'none', background: submitting ? '#1a2028' : 'linear-gradient(135deg, #8a6c10, #c9a227)', color: '#060809', fontWeight: 700, cursor: submitting ? 'not-allowed' : 'pointer', opacity: (!form.password || !form.confirmPassword) ? .5 : 1 }}
              >
                {submitting ? '...' : 'Create Account & Sign In'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
