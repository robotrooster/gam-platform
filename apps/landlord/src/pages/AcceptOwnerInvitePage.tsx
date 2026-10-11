// S605 (Nic): accept a co-owner invitation to a landlord entity.
//
// The old flow demanded the invitee already hold a GAM account before a partner
// could add them — "it seems like kind of a backwards flow. I should be able to
// invite him through a link." This is that link.
//
// Two things this page has to get right:
//
//   1. It must be READABLE SIGNED OUT. The person arriving here may have no
//      account at all; the whole point is that they see who invited them and to
//      what BEFORE being asked to create anything.
//
//   2. It must state the separation. A partner's first question is whether
//      accepting folds their own business into someone else's books. Nic, on a
//      three-member partnership: "I don't necessarily need to be part of his
//      other operation." Saying so here is cheaper than every conversation that
//      follows from not saying it.
import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { Building2, Check, AlertTriangle } from 'lucide-react'

// Survives the sign-in / registration round trip, so the invite is still
// applied after the auth detour instead of being silently dropped.
const PENDING_KEY = 'gam_pending_owner_invite'

export function AcceptOwnerInvitePage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [invite, setInvite] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    apiGet<any>(`/landlords/member-invite/${token}`)
      .then(r => setInvite(r?.data ?? r))
      .catch(e => setError(
        e?.response?.data?.error || 'That invitation has expired or already been used.'))
  }, [token])

  const accept = async () => {
    setBusy(true); setError(null)
    try {
      // S655: answers yes again for the person who already accepted (registering
      // with the invited address and entering the emailed code accepts it, then
      // the registration lands here).
      await apiPost(`/landlords/member-invite/${token}/accept`, {})
      sessionStorage.removeItem(PENDING_KEY)
      setDone(true)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not accept the invitation.')
    } finally { setBusy(false) }
  }

  // S655: a dead invitation must not keep pulling the person back here. The
  // stashed token made every sign-in redirect (RoleRedirect in main.tsx) land on
  // this same error card, with no way past it.
  useEffect(() => {
    if (error && (!invite || invite.accepted)) { try { sessionStorage.removeItem(PENDING_KEY) } catch { /* private mode */ } }
  }, [error, invite])

  // Membership is read fresh on every request (S629), so a full page load is all
  // it takes for the company to appear — no second sign-in.
  const goToDashboard = () => {
    try { sessionStorage.removeItem(PENDING_KEY) } catch { /* private mode */ }
    window.location.assign('/')
  }

  // Signed in as the invited person → accept straight away. Signed in as
  // someone else is handled by the server, which rejects on email mismatch.
  useEffect(() => {
    if (user && invite && !done && !busy) accept()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, invite])

  const goAuth = (to: '/login' | '/register') => {
    sessionStorage.setItem(PENDING_KEY, token)
    navigate(`${to}?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(invite?.email ?? '')}`)
  }

  // S631: .auth-center rather than a centered flex — a card taller than a
  // landscape phone was clipping its own top into unreachable space.
  const shell = (children: React.ReactNode) => (
    <div className="auth-center">
      <div className="card" style={{ maxWidth: 460, width: '100%', padding: 28 }}>{children}</div>
    </div>
  )

  if (error && !invite) return shell(
    <>
      <AlertTriangle size={26} style={{ color: 'var(--red)' }} />
      <h2 style={{ fontSize: '1.1rem', margin: '12px 0 8px' }}>This invitation isn't valid</h2>
      <p style={{ fontSize: '.86rem', color: 'var(--text-2)', lineHeight: 1.6 }}>{error}</p>
      <Link className="btn btn-ghost" to="/login" style={{ marginTop: 16 }}>Go to sign in</Link>
    </>
  )

  if (!invite) return shell(
    <div style={{ color: 'var(--text-3)', fontSize: '.86rem' }}>Checking your invitation…</div>
  )

  if (done) return shell(
    <>
      <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(30,219,122,.12)',
        border: '2px solid var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Check size={24} style={{ color: 'var(--green)' }} />
      </div>
      <h2 style={{ fontSize: '1.1rem', margin: '14px 0 8px' }}>You're an owner of {invite.entityName}</h2>
      <p style={{ fontSize: '.86rem', color: 'var(--text-2)', lineHeight: 1.6 }}>
        {invite.entityName} is in your account now, next to anything else you own.
      </p>
      <button className="btn btn-primary" style={{ marginTop: 16, width: '100%' }}
        onClick={goToDashboard}>Go to your dashboard</button>
    </>
  )

  // S655: already accepted, and nobody signed in yet — e.g. reopening the email
  // after registering. Not an error: they own it; they just need to sign in.
  // (Signed in as the person who accepted, the accept call above answers yes
  // and the done screen shows; signed in as anyone else, it refuses.)
  if (invite.accepted && (!user || error)) return shell(
    <>
      <Check size={26} style={{ color: 'var(--green)' }} />
      <h2 style={{ fontSize: '1.1rem', margin: '12px 0 8px' }}>This invitation has been accepted</h2>
      <p style={{ fontSize: '.86rem', color: 'var(--text-2)', lineHeight: 1.6 }}>
        {invite.email} is an owner of {invite.entityName}. Sign in with that address to see it.
      </p>
      <button className="btn btn-primary" style={{ marginTop: 16, width: '100%' }}
        onClick={() => { try { sessionStorage.removeItem(PENDING_KEY) } catch { /* private mode */ } navigate('/login') }}>
        Sign in
      </button>
    </>
  )

  return shell(
    <>
      <Building2 size={26} style={{ color: 'var(--gold)' }} />
      <h2 style={{ fontSize: '1.15rem', margin: '12px 0 6px' }}>
        Join {invite.entityName} as an owner
      </h2>
      <p style={{ fontSize: '.86rem', color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 14 }}>
        {invite.invitedBy || 'A GAM landlord'} invited <strong style={{ color: 'var(--text-0)' }}>{invite.email}</strong> to
        co-own {invite.entityName}. You'll see its rent roll, tenants, payments and reporting —
        the same as any other owner.
      </p>

      <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 8,
        padding: '10px 14px', fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.55, marginBottom: 18 }}>
        Accepting also creates <strong style={{ color: 'var(--text-0)' }}>your own account</strong>.
        Anything you add later that isn't part of {invite.entityName} stays private to you —
        your other properties, your own numbers. The two never mix.
      </div>

      {error && (
        <div style={{ color: 'var(--red)', fontSize: '.8rem', background: 'rgba(255,71,87,.08)',
          border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          {error}
        </div>
      )}

      {user ? (
        <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy} onClick={accept}>
          {busy ? 'Accepting…' : 'Accept invitation'}
        </button>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          <button className="btn btn-primary" onClick={() => goAuth('/register')}>
            Create my account
          </button>
          <button className="btn btn-ghost" onClick={() => goAuth('/login')}>
            I already have a GAM account
          </button>
        </div>
      )}
    </>
  )
}
