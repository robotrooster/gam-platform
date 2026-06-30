import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiPost, setToken, getToken } from '../api'

export function AuthPage() {
  const nav = useNavigate()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // Already authed (e.g. arrived via portal SSO) — go straight in.
  if (getToken()) { nav('/', { replace: true }); return null }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(''); setBusy(true)
    try {
      const res = mode === 'login'
        ? await apiPost('/auth/login', { email, password })
        : await apiPost('/fitness/register', { email, password, first_name: firstName, last_name: lastName })
      if (!res.success || !(res as any).data?.token) {
        setErr((res as any).error || 'Something went wrong'); setBusy(false); return
      }
      setToken((res as any).data.token)
      nav('/', { replace: true })
    } catch (e: any) {
      setErr(e.response?.data?.error || 'Network error'); setBusy(false)
    }
  }

  return (
    <div className="center">
      <div className="auth-card">
        <div style={{ textAlign: 'center', marginBottom: 26 }}>
          <div style={{ display: 'inline-grid', placeItems: 'center', width: 52, height: 52, borderRadius: 14, background: 'linear-gradient(135deg,var(--gold),var(--gold-soft))', color: '#0b0b0d', fontWeight: 800, fontSize: 24, marginBottom: 14 }}>G</div>
          <h1 style={{ fontSize: 24 }}>GAM <span style={{ color: 'var(--gold)' }}>Fitness</span></h1>
          <div className="muted" style={{ marginTop: 6, fontSize: 14 }}>
            {mode === 'login' ? 'Sign in to track your training' : 'Create an account and start lifting'}
          </div>
        </div>

        <form onSubmit={submit} className="card">
          {mode === 'signup' && (
            <div className="row">
              <label className="field"><span className="lbl">First name</span>
                <input value={firstName} onChange={e => setFirstName(e.target.value)} required /></label>
              <label className="field"><span className="lbl">Last name</span>
                <input value={lastName} onChange={e => setLastName(e.target.value)} required /></label>
            </div>
          )}
          <label className="field"><span className="lbl">Email</span>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required /></label>
          <label className="field"><span className="lbl">Password</span>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
              placeholder={mode === 'signup' ? 'At least 8 characters' : ''} /></label>
          {err && <div className="err">{err}</div>}
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div style={{ textAlign: 'center', marginTop: 18 }} className="muted">
          {mode === 'login'
            ? <>New here? <a style={{ color: 'var(--gold)', cursor: 'pointer' }} onClick={() => { setMode('signup'); setErr('') }}>Try it out — create an account</a></>
            : <>Already have an account? <a style={{ color: 'var(--gold)', cursor: 'pointer' }} onClick={() => { setMode('login'); setErr('') }}>Sign in</a></>}
        </div>
        <div className="muted" style={{ textAlign: 'center', marginTop: 14, fontSize: 12, color: 'var(--text-2)' }}>
          GAM landlords &amp; tenants: open Fitness from your portal to sign in automatically.
        </div>
      </div>
    </div>
  )
}
