import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { apiPost } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { Eye, EyeOff, Check, AlertCircle } from 'lucide-react'

function PasswordStrength({ password }: { password: string }) {
  const checks = [
    { label: '8+ characters', pass: password.length >= 8 },
    { label: 'Uppercase letter', pass: /[A-Z]/.test(password) },
    { label: 'Number', pass: /\d/.test(password) },
  ]
  const strength = checks.filter(c => c.pass).length
  const colors = ['var(--red)', 'var(--amber)', 'var(--green)']
  const labels = ['Weak', 'Fair', 'Strong']

  if (!password) return null
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: i < strength ? colors[strength - 1] : 'var(--bg-4)', transition: 'background .2s' }} />
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 10 }}>
          {checks.map(c => (
            <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: '.65rem', color: c.pass ? 'var(--green)' : 'var(--text-3)' }}>
              <Check size={9} /> {c.label}
            </div>
          ))}
        </div>
        {strength > 0 && <span style={{ fontSize: '.65rem', color: colors[strength - 1], fontWeight: 700 }}>{labels[strength - 1]}</span>}
      </div>
    </div>
  )
}

export function RegisterPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const [agreed, setAgreed] = useState(false)
  const [form, setForm] = useState({
    firstName: '', lastName: '', email: '', phone: '',
    password: '', businessName: '', ein: '',
  })

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!agreed) { setErr('Please agree to the terms to continue'); return }
    if (form.password.length < 8) { setErr('Password must be at least 8 characters'); return }
    setLoading(true); setErr('')
    try {
      await apiPost('/auth/register', { ...form, role: 'landlord' })
      await login(form.email, form.password)
      navigate('/onboarding')
    } catch (e: any) {
      setErr(e.response?.data?.error || 'Registration failed. Please try again.')
    } finally { setLoading(false) }
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-0)', display: 'flex' }}>

      {/* Left panel — branding */}
      <div style={{ width: 420, flexShrink: 0, background: 'var(--bg-1)', borderRight: '1px solid var(--border-0)', padding: '48px 40px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.6rem', fontWeight: 800, color: 'var(--gold)', letterSpacing: '.04em', marginBottom: 40 }}>⚡ GAM</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-0)', lineHeight: 1.3, marginBottom: 16 }}>
            The smarter way to manage property
          </div>
          <div style={{ fontSize: '.85rem', color: 'var(--text-3)', lineHeight: 1.8, marginBottom: 40 }}>
            Guaranteed rent on the 1st. Automated ACH. On-Time Pay SLA for every unit.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {[
              { icon: '💸', title: 'On-Time Pay SLA', desc: 'Rent initiated every 1st — guaranteed' },
              { icon: '🏦', title: 'Automated ACH', desc: 'No checks, no chasing tenants' },
              { icon: '📊', title: 'Full portfolio view', desc: 'Every unit, every payment, one dashboard' },
              { icon: '⚡', title: '$15/unit/month', desc: 'Everything included, no hidden fees' },
            ].map(f => (
              <div key={f.title} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--bg-2)', border: '1px solid var(--border-0)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', flexShrink: 0 }}>{f.icon}</div>
                <div>
                  <div style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--text-0)' }}>{f.title}</div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
          © 2026 Gold Asset Management LLC · Arizona
        </div>
      </div>

      {/* Right panel — form */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 24px', overflowY: 'auto' }}>
        <div style={{ width: '100%', maxWidth: 480 }}>
          <div style={{ marginBottom: 32 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.3rem', fontWeight: 800, color: 'var(--text-0)', marginBottom: 6 }}>Create your account</div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>Already registered? <Link to="/login" style={{ color: 'var(--gold)' }}>Sign in</Link></div>
          </div>

          {err && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.25)', borderRadius: 8, padding: '10px 12px', marginBottom: 16, fontSize: '.78rem', color: 'var(--red)' }}>
              <AlertCircle size={14} /> {err}
            </div>
          )}

          <form onSubmit={onSubmit}>
            {/* Name */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>First Name *</label>
                <input className="input" placeholder="Jane" value={form.firstName} onChange={e => set('firstName', e.target.value)} required autoFocus style={{ width: '100%' }} />
              </div>
              <div>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Last Name *</label>
                <input className="input" placeholder="Smith" value={form.lastName} onChange={e => set('lastName', e.target.value)} required style={{ width: '100%' }} />
              </div>
            </div>

            {/* Email */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Email Address *</label>
              <input className="input" type="email" placeholder="jane@example.com" value={form.email} onChange={e => set('email', e.target.value)} required style={{ width: '100%' }} />
            </div>

            {/* Phone */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Phone *</label>
              <input className="input" type="tel" placeholder="(555) 000-0000" value={form.phone} onChange={e => set('phone', e.target.value)} required style={{ width: '100%' }} />
            </div>

            {/* Business name */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>
                Business Name <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional — LLC, partnership, etc.)</span>
              </label>
              <input className="input" placeholder="Smith Properties LLC" value={form.businessName} onChange={e => set('businessName', e.target.value)} style={{ width: '100%' }} />
            </div>

            {/* Password */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Password *</label>
              <div style={{ position: 'relative' }}>
                <input
                  className="input"
                  type={showPw ? 'text' : 'password'}
                  placeholder="Min 8 characters"
                  value={form.password}
                  onChange={e => set('password', e.target.value)}
                  required
                  style={{ width: '100%', paddingRight: 40 }}
                />
                <button type="button" onClick={() => setShowPw(v => !v)} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)' }}>
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <PasswordStrength password={form.password} />
            </div>

            {/* Terms */}
            <div style={{ marginBottom: 20, padding: '12px 14px', background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} style={{ marginTop: 2 }} />
                <div style={{ fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
                  I agree to the <span style={{ color: 'var(--gold)', cursor: 'pointer' }}>Platform Participation Agreement</span> and <span style={{ color: 'var(--gold)', cursor: 'pointer' }}>On-Time Pay SLA</span>. I understand these are pending attorney review.
                </div>
              </label>
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading || !agreed}
              style={{ width: '100%', padding: 14, justifyContent: 'center', fontSize: '.9rem' }}
            >
              {loading ? <span className="spinner" /> : 'Create account — start onboarding →'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
