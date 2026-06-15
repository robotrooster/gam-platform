import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setPending(true)
    try {
      await login(email, password)
      navigate('/dashboard')
    } catch (e: any) {
      setErr(e?.response?.data?.error || e?.message || 'Login failed')
    } finally { setPending(false) }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'grid', placeItems: 'center',
      background: 'var(--bg-0)', color: 'var(--text-0)',
    }}>
      <form onSubmit={onSubmit} style={{
        width: 360, padding: 32,
        background: 'var(--bg-1)',
        border: '1px solid var(--border-0)',
        borderRadius: 12,
      }}>
        <div style={{
          fontFamily: 'var(--font-display)', fontSize: 24, color: 'var(--gold)',
        }}>GAM</div>
        <div style={{
          fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--text-2)',
          marginTop: 2, marginBottom: 24,
        }}>for Businesses</div>

        <label style={labelStyle}>Email</label>
        <input
          value={email} onChange={e => setEmail(e.target.value)}
          type="email" required
          style={inputStyle}
        />

        <label style={labelStyle}>Password</label>
        <input
          value={password} onChange={e => setPassword(e.target.value)}
          type="password" required
          style={inputStyle}
        />

        {err && <div style={errStyle}>{err}</div>}

        <button
          type="submit" disabled={pending}
          style={{ ...btnStyle, opacity: pending ? 0.6 : 1 }}
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>

        <div style={{
          marginTop: 16, textAlign: 'center', fontSize: 13,
          color: 'var(--text-2)',
        }}>
          New business owner? <Link to="/signup" style={{ color: 'var(--gold)' }}>Sign up</Link>
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
