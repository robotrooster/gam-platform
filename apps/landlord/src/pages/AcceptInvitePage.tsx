import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'

// Staff-invitation accept page. The landlord adds a staff member on the Team
// page → this is the "next page" the invitee lands on from their email link
// (/invite/:token). Reads GET /invitations/:token (pre-filled name/phone from
// the invite), collects a password, POSTs /invitations/:token/accept. The
// accept endpoint returns no session token, so we route to /login on success.
interface InviteInfo {
  email: string
  status: string
  inviterName: string
  userExists: boolean
  firstName: string | null
  lastName: string | null
  phone: string | null
}

const wrap: React.CSSProperties = { minHeight: '100vh', background: '#060809', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'system-ui' }
const card: React.CSSProperties = { background: '#0a0d10', border: '1px solid #1e2530', borderRadius: 16, padding: 28, width: '100%', maxWidth: 460 }
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', background: '#141920', border: '1px solid #252e3d', borderRadius: 8, color: '#eef1f8', fontSize: '.85rem', outline: 'none', boxSizing: 'border-box' }
const labelStyle: React.CSSProperties = { fontSize: '.72rem', fontWeight: 600, color: '#7a8aaa', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }

export function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()

  const [info, setInfo] = useState<InviteInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '', password: '', confirm: '' })

  useEffect(() => {
    if (!token) { setError('Invalid invite link.'); setLoading(false); return }
    apiGet<InviteInfo>(`/invitations/${token}`)
      .then(data => {
        if (data.status !== 'pending') { setError(`This invitation is ${data.status}.`); setLoading(false); return }
        setInfo(data)
        setForm(f => ({ ...f, firstName: data.firstName || '', lastName: data.lastName || '', phone: data.phone || '' }))
        setLoading(false)
      })
      .catch(() => { setError('This invite link is invalid or has already been used.'); setLoading(false) })
  }, [token])

  const submit = async () => {
    setError('')
    if (!info?.userExists) {
      if (!form.firstName.trim() || !form.lastName.trim()) { setError('First and last name are required.'); return }
      if (form.password.length < 8) { setError('Password must be at least 8 characters.'); return }
      if (form.password !== form.confirm) { setError('Passwords do not match.'); return }
    }
    setSubmitting(true)
    try {
      await apiPost(`/invitations/${token}/accept`, info?.userExists ? {} : {
        password: form.password,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        phone: form.phone.trim() || undefined,
      })
      setDone(true)
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.response?.data?.message || 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  if (loading) return (
    <div style={wrap}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width: 32, height: 32, border: '3px solid #1a2028', borderTopColor: '#c9a227', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
    </div>
  )

  if (error && !info) return (
    <div style={wrap}>
      <div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
        <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#eef1f8', marginBottom: 8 }}>Invitation unavailable</div>
        <div style={{ fontSize: '.85rem', color: '#b8c4d8', lineHeight: 1.6 }}>{error}</div>
        <div style={{ fontSize: '.75rem', color: '#3d4d68', marginTop: 12 }}>Ask your employer to send a new invite link.</div>
      </div>
    </div>
  )

  if (done) return (
    <div style={wrap}>
      <div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
        <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#eef1f8', marginBottom: 8 }}>You're all set</div>
        <div style={{ fontSize: '.85rem', color: '#b8c4d8', lineHeight: 1.6, marginBottom: 20 }}>
          Your account is ready. Sign in to get started — your employer will set what you can access.
        </div>
        <button onClick={() => navigate('/login')} style={{ padding: '12px 28px', borderRadius: 10, border: 'none', background: 'linear-gradient(135deg, #8a6c10, #c9a227)', color: '#060809', fontWeight: 700, fontSize: '.9rem', cursor: 'pointer' }}>
          Go to sign in →
        </button>
      </div>
    </div>
  )

  return (
    <div style={wrap}>
      <div style={{ width: '100%', maxWidth: 460 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#c9a227', letterSpacing: '.04em' }}>⚡ GAM</div>
          <div style={{ fontSize: '.75rem', color: '#3d4d68', marginTop: 2 }}>Gold Asset Management</div>
        </div>
        <div style={card}>
          <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#eef1f8', marginBottom: 6 }}>
            {info?.userExists ? 'Join the team' : 'Create your account'}
          </div>
          <div style={{ fontSize: '.82rem', color: '#7a8aaa', marginBottom: 20, lineHeight: 1.6 }}>
            <strong style={{ color: '#b8c4d8' }}>{info?.inviterName}</strong> invited you to join their team on GAM.
            {' '}Signing in as <strong style={{ color: '#b8c4d8' }}>{info?.email}</strong>.
          </div>

          {info?.userExists ? (
            <div style={{ fontSize: '.8rem', color: '#b8c4d8', marginBottom: 20, lineHeight: 1.6 }}>
              You already have a GAM account with this email. Accept to join this team — you'll sign in with your existing password.
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
                <div>
                  <label style={labelStyle}>First name</label>
                  <input style={inputStyle} value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} />
                </div>
                <div>
                  <label style={labelStyle}>Last name</label>
                  <input style={inputStyle} value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} />
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Phone <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span></label>
                <input type="tel" style={inputStyle} value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="(555) 000-0000" />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Password</label>
                <input type="password" style={inputStyle} placeholder="Min 8 characters" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
              </div>
              <div style={{ marginBottom: 18 }}>
                <label style={labelStyle}>Confirm password</label>
                <input type="password" style={inputStyle} placeholder="Repeat password" value={form.confirm} onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))} />
              </div>
            </>
          )}

          {error && (
            <div style={{ color: '#ff4757', fontSize: '.75rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 14 }}>
              {error}
            </div>
          )}

          <button
            onClick={submit}
            disabled={submitting}
            style={{ width: '100%', padding: 13, borderRadius: 10, border: 'none', background: submitting ? '#1a2028' : 'linear-gradient(135deg, #8a6c10, #c9a227)', color: '#060809', fontWeight: 700, fontSize: '.9rem', cursor: submitting ? 'not-allowed' : 'pointer' }}
          >
            {submitting ? '…' : info?.userExists ? 'Accept invitation' : 'Create account'}
          </button>
        </div>
      </div>
    </div>
  )
}
