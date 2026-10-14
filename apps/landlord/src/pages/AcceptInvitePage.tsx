import { useEffect, useState } from 'react'
import { useParams, useNavigate, Navigate } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { continueToSignIn } from './LoginPage'
import { bookkeeperAccessSummary, type BookkeeperAccessChoice } from '@gam/shared'

// Staff-invitation accept page. The landlord adds a staff member on the Team
// page → this is the "next page" the invitee lands on from their email link
// (/invite/:token). Reads GET /invitations/:token (pre-filled name/phone from
// the invite), collects a password, POSTs /invitations/:token/accept.
//
// ── 10/13 (Nic): ONE PATH FROM THE EMAIL TO HER PAGES ────────────────────────
//
// "There was some kind of issue on the signing up flow through the bookkeeper
// invite link ... it told her to sign in and then something about it not going
// anywhere ... whatever the process is, it's not smooth."
//
// The live log: she created her account at 16:31, opened the link again at
// 16:32 and 16:34, and got in at 16:37 only by finding the portal's sign-in on
// her own. This page had told her "You keep the books in GAM Books — sign in
// there" with a button to GAM Books' /login, which answered with a 404, and
// reopening the link said "This invitation is accepted. Ask your employer to
// send a new invite link."
//
// Now: Create account goes straight to the emailed-code step (the accept hands
// back the account's pending pass), and the code lands her on her own pages in
// this portal — a bookkeeper's Bookkeeping, Payments and Rent Roll live here
// (10/12: the Books pages are inside this portal, not a link out). That
// replaces the 10/11 ending, which sent a bookkeeper to GAM Books to sign in
// (and GAM Books has no Payments page). A link opened again says the account is set up and offers Sign in
// (or, signed in already as that address, goes to her pages). An existing
// account signs in and comes right back here to accept. Every role on the Team
// page (bookkeeper, on-site manager, property manager, maintenance) uses it.
interface InviteInfo {
  email: string
  role?: string
  status: string
  /** 10/13: a pending invitation past its expiry, by the server's clock. */
  expired?: boolean
  inviterName: string
  userExists: boolean
  firstName: string | null
  lastName: string | null
  phone: string | null
  // 10/12 (Nic): a bookkeeper invitation's boxes, so the summary below says
  // what they give — the bank account and payroll only when Company-wide is.
  bookkeeperAccess?: BookkeeperAccessChoice
}

/** What POST /invitations/:token/accept answers. A new account carries its code step (10/13). */
interface AcceptResult {
  userId: string
  role: string
  requiresEmailOtp?: boolean
  emailOtpSession?: string
  otpSent?: boolean
}

const wrap: React.CSSProperties = { minHeight: '100vh', background: '#060809', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'system-ui' }
const card: React.CSSProperties = { background: '#0a0d10', border: '1px solid #1e2530', borderRadius: 16, padding: 28, width: '100%', maxWidth: 460 }
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', background: '#141920', border: '1px solid #252e3d', borderRadius: 8, color: 'var(--text-0)', fontSize: '.85rem', outline: 'none', boxSizing: 'border-box' }
const labelStyle: React.CSSProperties = { fontSize: '.72rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }
const titleStyle: React.CSSProperties = { fontSize: '1.2rem', fontWeight: 800, color: 'var(--text-0)', marginBottom: 8 }
const bodyStyle: React.CSSProperties = { fontSize: '.85rem', color: 'var(--text-1)', lineHeight: 1.6 }

const sameAddress = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

export function AcceptInvitePage() {
  const { token = '' } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const { user, loading: authLoading, logout } = useAuth()

  const [info, setInfo] = useState<InviteInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [joinedTeam, setJoinedTeam] = useState(false)
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '', password: '', confirm: '' })

  useEffect(() => {
    if (!token) { setError('Invalid invite link.'); setLoading(false); return }
    apiGet<InviteInfo>(`/invitations/${token}`)
      .then(data => {
        setInfo(data)
        setForm(f => ({ ...f, firstName: data.firstName || '', lastName: data.lastName || '', phone: data.phone || '' }))
        setLoading(false)
      })
      .catch(() => { setError('This invite link is invalid or has already been used.'); setLoading(false) })
  }, [token])

  // 10/13: this link, after signing in — the sign-in page returns here.
  const signInHref = `/login?next=${encodeURIComponent(`/invite/${token}`)}`
  const signedInAsInvitee = !!user && sameAddress(user.email, info?.email)
  const signedInAsSomeoneElse = !!user && !!info && !signedInAsInvitee
  // Sign out of whoever else this device is signed in as, then sign in as the invitee.
  const goSignIn = (to: string) => { if (signedInAsSomeoneElse) logout(); navigate(to) }

  const submit = async () => {
    setError('')
    if (!info?.userExists) {
      if (!form.firstName.trim() || !form.lastName.trim()) { setError('First and last name are required.'); return }
      if (form.password.length < 8) { setError('Password must be at least 8 characters.'); return }
      if (form.password !== form.confirm) { setError('Passwords do not match.'); return }
    }
    setSubmitting(true)
    try {
      const r = await apiPost<AcceptResult>(`/invitations/${token}/accept`, info?.userExists ? {} : {
        password: form.password,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        phone: form.phone.trim() || undefined,
      })
      if (info?.userExists) { setJoinedTeam(true); setSubmitting(false); return }
      // 10/13: a new account goes straight to its code step, then its pages.
      const d = r.data
      continueToSignIn(navigate, {
        joined: { email: info!.email, otpSent: d?.otpSent },
        emailOtpSession: d?.requiresEmailOtp ? d.emailOtpSession : undefined,
      })
    } catch (e: any) {
      // A second tap, or the link finished in another tab: it is set up — say so.
      if (e?.response?.data?.code === 'ALREADY_ACCEPTED') {
        setInfo(i => i ? { ...i, status: 'accepted', userExists: true } : i)
        setSubmitting(false)
        return
      }
      setError(e?.response?.data?.error || e?.response?.data?.message || 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  if (loading || (authLoading && !!info)) return (
    <div style={wrap}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width: 32, height: 32, border: '3px solid #1a2028', borderTopColor: '#c9a227', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
    </div>
  )

  if (error && !info) return (
    <div style={wrap}>
      <div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
        <div style={titleStyle}>Invitation unavailable</div>
        <div style={bodyStyle}>{error}</div>
        <div style={{ fontSize: '.75rem', color: '#3d4d68', marginTop: 12 }}>Ask the person who invited you to send a new invite link.</div>
        <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => navigate('/login')}>Go to sign in</button>
      </div>
    </div>
  )

  const inviter = info?.inviterName || 'the person who invited you'

  // ── 10/13: the link opened again after the account was set up ────────────
  if (info?.status === 'accepted') {
    // Signed in already as that address: straight to their pages.
    if (signedInAsInvitee) return <Navigate to="/" replace />
    return (
      <div style={wrap}>
        <div style={{ ...card, textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
          <div style={titleStyle}>Your account is already set up</div>
          <div style={{ ...bodyStyle, marginBottom: 20 }}>
            <strong style={{ color: 'var(--text-0)' }}>{info.email}</strong> was set up with this link. Sign in with that email
            and your password — you don't need a new invitation.
          </div>
          {signedInAsSomeoneElse && (
            <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 12 }}>
              This device is signed in as {user!.email}.
            </div>
          )}
          <button className="btn btn-primary w-full" style={{ justifyContent: 'center' }} onClick={() => goSignIn('/login')}>
            {signedInAsSomeoneElse ? `Sign out and sign in as ${info.email}` : 'Sign in'}
          </button>
        </div>
      </div>
    )
  }

  if (info?.status === 'revoked') return (
    <div style={wrap}>
      <div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
        <div style={titleStyle}>This invitation was withdrawn</div>
        <div style={bodyStyle}>{inviter} withdrew this invitation. If you still need access, ask them to send a new one.</div>
      </div>
    </div>
  )

  if (info?.expired || info?.status === 'expired') return (
    <div style={wrap}>
      <div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⏳</div>
        <div style={titleStyle}>This invitation link has expired</div>
        <div style={bodyStyle}>Ask {inviter} to send you a new one.</div>
      </div>
    </div>
  )

  const isBookkeeper = info?.role === 'bookkeeper'

  // An existing account said yes from its own session.
  if (joinedTeam) return (
    <div style={wrap}>
      <div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
        <div style={titleStyle}>You're on {inviter}'s team</div>
        <div style={{ ...bodyStyle, marginBottom: 20 }}>You accepted with the account you're signed in to.</div>
        {/* A full load, so the menu is read fresh for the new team. */}
        <button className="btn btn-primary w-full" style={{ justifyContent: 'center' }} onClick={() => window.location.assign('/')}>
          Go to my pages
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
          <div style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-0)', marginBottom: 6 }}>
            {info?.userExists ? 'Join the team' : 'Create your account'}
          </div>
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 20, lineHeight: 1.6 }}>
            <strong style={{ color: 'var(--text-1)' }}>{info?.inviterName}</strong> invited you to {isBookkeeper ? 'keep their books' : 'join their team'} on GAM.
            {' '}Signing in as <strong style={{ color: 'var(--text-1)' }}>{info?.email}</strong>.
          </div>
          {isBookkeeper && (
            <div style={{ fontSize: '.8rem', color: 'var(--text-1)', marginBottom: 20, lineHeight: 1.6, background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.2)', borderRadius: 8, padding: '10px 12px' }}>
              <strong style={{ color: 'var(--text-0)' }}>Bookkeeper.</strong> {bookkeeperAccessSummary(info?.bookkeeperAccess ?? { propertyCount: 0, companyWide: false }, 'invitee')}
            </div>
          )}

          {info?.userExists ? (
            // 10/13: an existing account accepts from its own session (S654).
            // Not signed in, or signed in as someone else: sign in as this
            // address first, and the sign-in page brings them back here.
            <div style={{ fontSize: '.8rem', color: 'var(--text-1)', marginBottom: 20, lineHeight: 1.6 }}>
              {signedInAsInvitee
                ? 'You already have a GAM account with this email. Accept to join this team.'
                : signedInAsSomeoneElse
                  ? <>This device is signed in as {user!.email}. Sign in as {info.email} to accept — you'll come right back here.</>
                  : 'You already have a GAM account with this email. Sign in to accept — you\'ll come right back here.'}
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
                <div>
                  <label style={labelStyle} htmlFor="invite-first">First name</label>
                  <input id="invite-first" style={inputStyle} value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} />
                </div>
                <div>
                  <label style={labelStyle} htmlFor="invite-last">Last name</label>
                  <input id="invite-last" style={inputStyle} value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} />
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle} htmlFor="invite-phone">Phone <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span></label>
                <input id="invite-phone" type="tel" style={inputStyle} value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="(555) 000-0000" />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle} htmlFor="invite-password">Password</label>
                <input id="invite-password" type="password" autoComplete="new-password" style={inputStyle} placeholder="Min 8 characters" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
              </div>
              <div style={{ marginBottom: 18 }}>
                <label style={labelStyle} htmlFor="invite-confirm">Confirm password</label>
                <input id="invite-confirm" type="password" autoComplete="new-password" style={inputStyle} placeholder="Repeat password" value={form.confirm} onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))} />
              </div>
            </>
          )}

          {error && (
            <div style={{ color: '#ff4757', fontSize: '.75rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 14 }}>
              {error}
            </div>
          )}

          {info?.userExists && !signedInAsInvitee ? (
            <button className="btn btn-primary w-full" style={{ justifyContent: 'center', padding: 13 }} onClick={() => goSignIn(signInHref)}>
              {signedInAsSomeoneElse ? `Sign out and sign in as ${info.email}` : 'Sign in to accept'}
            </button>
          ) : (
            <button className="btn btn-primary w-full" style={{ justifyContent: 'center', padding: 13 }} onClick={submit} disabled={submitting}>
              {submitting ? '…' : info?.userExists ? 'Accept invitation' : 'Create account'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
