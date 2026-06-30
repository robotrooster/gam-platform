import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { apiPost } from '../lib/api'

export function LoginPage() {
  const { slug } = useParams<{ slug: string }>()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr(null)
    try {
      await apiPost(`/public/portal-login/${slug}`, { email })
      setSent(true)
    } catch (e: any) {
      setErr(e?.message || 'Something went wrong. Try again.')
    } finally { setBusy(false) }
  }

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, color: 'var(--text-0)', marginBottom: 6 }}>
          Customer portal
        </div>
        {sent ? (
          <div style={{ color: 'var(--text-1)', fontSize: 15, marginTop: 12 }}>
            If <strong style={{ color: 'var(--text-0)' }}>{email}</strong> is on file, we’ve emailed
            you a secure link to your portal. Check your inbox.
          </div>
        ) : (
          <form onSubmit={submit}>
            <div style={{ color: 'var(--text-2)', fontSize: 14, margin: '8px 0 20px' }}>
              Enter your email and we’ll send you a secure link to view your
              service status and invoices. No password needed.
            </div>
            {err && <div style={errBox}>{err}</div>}
            <label style={label}>Email</label>
            <input
              type="email" required value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com" style={input} autoFocus
            />
            <button type="submit" disabled={busy || !email} style={{ ...btn, opacity: busy || !email ? 0.6 : 1 }}>
              {busy ? 'Sending…' : 'Email me my link'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

const wrap: React.CSSProperties = {
  minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
}
const card: React.CSSProperties = {
  width: '100%', maxWidth: 420, padding: 28,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 14,
}
const label: React.CSSProperties = {
  display: 'block', fontSize: 12, color: 'var(--text-2)', marginBottom: 6,
}
const input: React.CSSProperties = {
  width: '100%', padding: '12px 14px', marginBottom: 16,
  background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8, fontSize: 15,
}
const btn: React.CSSProperties = {
  width: '100%', padding: '13px', background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700,
}
const errBox: React.CSSProperties = {
  padding: '10px 12px', marginBottom: 14,
  background: 'var(--red-bg)', color: 'var(--red)',
  border: '1px solid var(--red)', borderRadius: 8, fontSize: 13,
}
