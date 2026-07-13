import { useState } from 'react'
import { Link } from 'react-router-dom'
import { apiPost } from '../lib/api'
import { BUSINESS_TYPES, BUSINESS_TYPE_LABEL, BusinessType } from '@gam/shared'

/**
 * S538 — POS self-signup. A standalone seller (farmer's market,
 * convenience store) creates an account directly on the POS portal;
 * under the hood this is the SAME lightweight business row the business
 * portal creates (POST /api/businesses — one entity model, no third
 * operator type). The business portal is later available to them with
 * this same login. EIN optional by design.
 */
export function SignupPage() {
  const [form, setForm] = useState({
    businessName: '',
    businessType: 'mini_market' as BusinessType,
    firstName: '', lastName: '',
    email: '', password: '', phone: '', ein: '',
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
      const payload = { ...form, ein: form.ein || undefined, phone: form.phone || undefined }
      const res = await apiPost<{ token: string; user: any }>('/businesses', payload)
      // Signup already minted a JWT — stash it under the POS portal's
      // token key and hard-nav so AuthContext picks it up on mount.
      localStorage.setItem('gam_token', res.data!.token)
      window.location.href = '/pos'
    } catch (e: any) {
      setErr(e?.response?.data?.error?.message || e?.response?.data?.error || e?.message || 'Signup failed')
    } finally { setPending(false) }
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-1)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0' }}>
      <div style={{ width: '100%', maxWidth: 440, padding: 24 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: '2.5rem', marginBottom: 8 }}>⚡</div>
          <div style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--gold)', letterSpacing: '-0.5px' }}>GAM POS</div>
          <div style={{ fontSize: '.82rem', color: 'var(--text-3)', marginTop: 4 }}>Create your register account</div>
        </div>

        <form onSubmit={onSubmit} className="card" style={{ padding: 28 }}>
          <label style={labelStyle}>Business name</label>
          <input className="form-input" value={form.businessName} onChange={e => upd('businessName', e.target.value)}
            required style={{ width: '100%' }} />

          <label style={labelStyle}>Business type</label>
          <select className="form-select" value={form.businessType}
            onChange={e => upd('businessType', e.target.value as BusinessType)}
            style={{ width: '100%' }}>
            {BUSINESS_TYPES.map(t => (
              <option key={t} value={t}>{BUSINESS_TYPE_LABEL[t]}</option>
            ))}
          </select>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>First name</label>
              <input className="form-input" value={form.firstName} onChange={e => upd('firstName', e.target.value)}
                required style={{ width: '100%' }} />
            </div>
            <div>
              <label style={labelStyle}>Last name</label>
              <input className="form-input" value={form.lastName} onChange={e => upd('lastName', e.target.value)}
                required style={{ width: '100%' }} />
            </div>
          </div>

          <label style={labelStyle}>Email</label>
          <input className="form-input" value={form.email} onChange={e => upd('email', e.target.value)}
            type="email" required style={{ width: '100%' }} />

          <label style={labelStyle}>Phone (optional)</label>
          <input className="form-input" value={form.phone} onChange={e => upd('phone', e.target.value)}
            style={{ width: '100%' }} />

          <label style={labelStyle}>EIN (optional)</label>
          <input className="form-input" value={form.ein} onChange={e => upd('ein', e.target.value)}
            placeholder="12-3456789" style={{ width: '100%' }} />

          <label style={labelStyle}>Password (12+ characters)</label>
          <input className="form-input" value={form.password} onChange={e => upd('password', e.target.value)}
            type="password" required minLength={12} style={{ width: '100%' }} />

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 16, fontSize: '.8rem', color: 'var(--text-1)', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.acceptedTerms}
              onChange={e => upd('acceptedTerms', e.target.checked)} required
              style={{ marginTop: 3 }} />
            <span>I accept the Terms of Service and Privacy Policy.</span>
          </label>

          {err && <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(220,53,69,.08)', border: '1px solid rgba(220,53,69,.2)', borderRadius: 8, fontSize: '.82rem', color: 'var(--red)' }}>{err}</div>}

          <button type="submit" className="btn btn-primary" disabled={pending}
            style={{ width: '100%', padding: '12px 0', fontSize: '1rem', marginTop: 20 }}>
            {pending ? 'Creating…' : 'Create account'}
          </button>

          <div style={{ marginTop: 16, textAlign: 'center', fontSize: '.8rem', color: 'var(--text-3)' }}>
            Already have an account? <Link to="/login" style={{ color: 'var(--gold)' }}>Sign in</Link>
          </div>
        </form>
      </div>
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '.75rem', color: 'var(--text-3)',
  marginBottom: 5, marginTop: 12,
}
