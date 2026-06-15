import { useState } from 'react'
import { Link } from 'react-router-dom'
import { apiPost } from '../lib/api'
import { BUSINESS_TYPES, BUSINESS_TYPE_LABEL, BusinessType } from '@gam/shared'

export function SignupPage() {
  const [form, setForm] = useState({
    businessName: '',
    businessType: 'trash_hauling' as BusinessType,
    firstName: '', lastName: '',
    email: '', password: '', phone: '',
    acceptedTerms: false,
  })
  const [err, setErr] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const upd = <K extends keyof typeof form>(k: K, v: typeof form[K]) =>
    setForm(f => ({ ...f, [k]: v }))

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setPending(true)
    try {
      const res = await apiPost<{ token: string; user: any }>('/businesses', form)
      // Stash the token the same way AuthContext does + then re-login
      // to populate state. (We can't use auth.login() because that
      // hits /auth/login with a password; signup already minted us a
      // JWT.)
      localStorage.setItem('gam_business_token', res.data!.token)
      // Forcing a refresh by full nav — AuthContext picks up the token
      // from localStorage on next mount.
      window.location.href = '/dashboard'
    } catch (e: any) {
      setErr(e?.response?.data?.error || e?.message || 'Signup failed')
    } finally { setPending(false) }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'grid', placeItems: 'center',
      background: 'var(--bg-0)', color: 'var(--text-0)',
      padding: '40px 0',
    }}>
      <form onSubmit={onSubmit} style={{
        width: 440, padding: 32,
        background: 'var(--bg-1)',
        border: '1px solid var(--border-0)',
        borderRadius: 12,
      }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: 'var(--gold)' }}>
          Start your business on GAM
        </div>
        <div style={{ fontSize: 14, color: 'var(--text-2)', marginTop: 4, marginBottom: 24 }}>
          Service businesses — trash hauling, maintenance crews, rentals, more.
        </div>

        <label style={labelStyle}>Business name</label>
        <input value={form.businessName} onChange={e => upd('businessName', e.target.value)}
          required style={inputStyle} />

        <label style={labelStyle}>Business type</label>
        <select value={form.businessType}
          onChange={e => upd('businessType', e.target.value as BusinessType)}
          style={inputStyle}>
          {BUSINESS_TYPES.map(t => (
            <option key={t} value={t}>{BUSINESS_TYPE_LABEL[t]}</option>
          ))}
        </select>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={labelStyle}>First name</label>
            <input value={form.firstName} onChange={e => upd('firstName', e.target.value)}
              required style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Last name</label>
            <input value={form.lastName} onChange={e => upd('lastName', e.target.value)}
              required style={inputStyle} />
          </div>
        </div>

        <label style={labelStyle}>Email</label>
        <input value={form.email} onChange={e => upd('email', e.target.value)}
          type="email" required style={inputStyle} />

        <label style={labelStyle}>Phone (optional)</label>
        <input value={form.phone} onChange={e => upd('phone', e.target.value)}
          style={inputStyle} />

        <label style={labelStyle}>Password (12+ characters)</label>
        <input value={form.password} onChange={e => upd('password', e.target.value)}
          type="password" required minLength={12} style={inputStyle} />

        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 16,
          fontSize: 13, color: 'var(--text-1)', cursor: 'pointer',
        }}>
          <input type="checkbox" checked={form.acceptedTerms}
            onChange={e => upd('acceptedTerms', e.target.checked)} required
            style={{ marginTop: 3 }} />
          <span>I accept the Terms of Service and Privacy Policy.</span>
        </label>

        {err && <div style={errStyle}>{err}</div>}

        <button type="submit" disabled={pending}
          style={{ ...btnStyle, opacity: pending ? 0.6 : 1 }}>
          {pending ? 'Creating…' : 'Create business account'}
        </button>

        <div style={{
          marginTop: 16, textAlign: 'center', fontSize: 13,
          color: 'var(--text-2)',
        }}>
          Already have an account? <Link to="/login" style={{ color: 'var(--gold)' }}>Sign in</Link>
        </div>
      </form>
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, color: 'var(--text-2)',
  marginBottom: 6, marginTop: 12, fontFamily: 'var(--font-body)',
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 14, fontFamily: 'var(--font-body)',
  boxSizing: 'border-box',
}
const btnStyle: React.CSSProperties = {
  width: '100%', padding: '12px',
  background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 8,
  fontSize: 14, fontWeight: 600,
  marginTop: 20, cursor: 'pointer',
  fontFamily: 'var(--font-body)',
}
const errStyle: React.CSSProperties = {
  marginTop: 12, padding: '10px 12px',
  background: 'var(--red-bg)', color: 'var(--red)',
  border: '1px solid var(--red-dim)', borderRadius: 8,
  fontSize: 13, fontFamily: 'var(--font-body)',
}
