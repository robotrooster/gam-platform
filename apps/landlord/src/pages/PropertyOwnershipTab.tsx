// S605 (Nic): sell a property — and the consent gate in front of it.
//
// "Anybody that has a GAM platform account as an owner or a landlord on a
// partnership needs to all have a signing or confirmation... so that one person
// can't just accidentally sell or transfer account ownership out from underneath
// other people."
//
// This is the most consequential screen in the landlord portal, so it is
// deliberately unhurried: it states what moves, what stays, who must agree, and
// where each of them stands — before offering the button. The confirmation code
// arrives by email rather than being clickable in one, because a link in a
// forwarded email is a signature anyone can apply.
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Link } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { toast, appConfirm } from '../components/dialogs'
import { ArrowRightLeft, Check, X, AlertTriangle } from 'lucide-react'

export function PropertyOwnershipTab({ propertyId, propertyName }:
  { propertyId: string; propertyName: string }) {
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')

  const { data: request } = useQuery<any>(
    ['transfer-request', propertyId],
    () => apiGet(`/properties/${propertyId}/transfer-request`).then((r: any) => r?.data ?? r))

  // S631 (Nic): "When I click on Oak Park and I click on Mountain View RV, no
  // little window pops up to see who owns it, who does what." This tab went
  // straight to SELLING the property without ever stating who currently holds
  // it. Same query key the detail page uses, so this costs no extra request.
  const { data: property } = useQuery<any>(['property', propertyId], () => apiGet(`/properties/${propertyId}`))
  const ownership = property?.ownership

  const invalidate = () => qc.invalidateQueries(['transfer-request', propertyId])

  const start = useMutation(
    () => apiPost(`/properties/${propertyId}/transfer`, { toEmail: email.trim(), note: note.trim() || undefined }),
    { onSuccess: (r: any) => {
        invalidate(); setEmail(''); setNote('')
        toast(`Sale proposed. ${r?.data?.approversNotified ?? 0} owner(s) emailed a confirmation code.`)
      },
      onError: (e: any) => setErr(e?.response?.data?.error || 'Could not start the transfer') })

  const approve = useMutation(
    () => apiPost(`/properties/transfer-request/${request.id}/approve`, { code: code.trim() }),
    { onSuccess: (r: any) => {
        invalidate(); setCode('')
        toast(r?.data?.executed
          ? 'Approved — the property has been transferred.'
          : `Approved. ${r?.data?.approved}/${r?.data?.required} owners have confirmed.`)
      },
      onError: (e: any) => setErr(e?.response?.data?.error || 'Could not confirm') })

  const decline = useMutation(
    () => apiPost(`/properties/transfer-request/${request.id}/decline`, {}),
    { onSuccess: () => { invalidate(); toast('Transfer declined and cancelled.') } })

  // ── A sale is proposed and waiting on owners ──
  if (request) {
    return (
      <div style={{ maxWidth: 640 }}>
      {/* S631: who holds this property, before anything about moving it. */}
      {ownership && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>Ownership</div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 12 }}>
            {propertyName} belongs to <strong style={{ color: 'var(--text-1)' }}>{ownership.entityName}</strong>.
            Everyone below can act on it. Co-owners are held by the entity, not the property, so
            adding one here gives them every property {ownership.entityName} owns —{' '}
            <Link to="/settings" style={{ color: 'var(--gold)', textDecoration: 'underline' }}>
              manage owners in Settings
            </Link>.
          </div>
          {(ownership.owners || []).map((o: any) => (
            <div key={o.userId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '7px 0', borderBottom: '1px solid var(--border-1, rgba(255,255,255,.06))' }}>
              <div>
                <div style={{ fontSize: '.82rem', color: 'var(--text-0)', fontWeight: 600 }}>
                  {o.name || o.email}
                  {o.isFounding && <span style={{ marginLeft: 8, fontSize: '.62rem', color: 'var(--gold)', fontWeight: 700 }}>FOUNDING</span>}
                </div>
                <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{o.email}</div>
              </div>
              <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>
                {o.isFounding ? 'Cannot be removed' : 'Co-owner'}
              </div>
            </div>
          ))}
          {(ownership.owners || []).length > 1 && (
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 10, lineHeight: 1.5 }}>
              A sale needs every one of them to confirm — no single owner can move this property alone.
            </div>
          )}
        </div>
      )}
        <div className="card" style={{ padding: 18, borderLeft: '3px solid var(--gold)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <ArrowRightLeft size={17} style={{ color: 'var(--gold)' }} />
            <h3 style={{ margin: 0, fontSize: '1rem' }}>Sale proposed — awaiting owner approval</h3>
          </div>
          <p style={{ fontSize: '.85rem', color: 'var(--text-2)', lineHeight: 1.6 }}>
            <strong style={{ color: 'var(--text-0)' }}>{propertyName}</strong> would transfer to{' '}
            <strong style={{ color: 'var(--text-0)' }}>{request.buyerName || 'the buyer'}</strong>.
            It will not go ahead until <strong style={{ color: 'var(--text-0)' }}>every owner</strong> confirms.
            Expires {String(request.expiresAt).slice(0, 10)}.
          </p>
          {request.note && (
            <div style={{ fontSize: '.8rem', color: 'var(--text-3)', fontStyle: 'italic', marginBottom: 10 }}>
              “{request.note}”
            </div>
          )}

          <div style={{ margin: '14px 0' }}>
            {(request.approvals ?? []).map((a: any) => (
              <div key={a.userId} style={{ display: 'flex', alignItems: 'center', gap: 10,
                padding: '7px 0', borderBottom: '1px solid var(--border-0)', fontSize: '.84rem' }}>
                {a.approvedAt
                  ? <Check size={15} style={{ color: 'var(--green)' }} />
                  : a.declinedAt
                    ? <X size={15} style={{ color: 'var(--red)' }} />
                    : <span style={{ width: 15, textAlign: 'center', color: 'var(--text-3)' }}>·</span>}
                <span style={{ flex: 1 }}>{a.name || a.email}</span>
                <span style={{ fontSize: '.74rem', color: 'var(--text-3)' }}>
                  {a.approvedAt ? 'confirmed'
                    : a.declinedAt ? 'declined' : 'waiting'}
                </span>
              </div>
            ))}
          </div>

          {request.youAreApprover && !request.youApproved && (
            <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: '.82rem', marginBottom: 8 }}>
                Enter the 6-digit code from your email to confirm.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input className="input" value={code} onChange={e => { setCode(e.target.value); setErr('') }}
                  placeholder="000000" maxLength={6} style={{ width: 140, fontFamily: 'var(--font-mono)', letterSpacing: '.2em' }} />
                <button className="btn btn-primary" disabled={code.trim().length < 4 || approve.isLoading}
                  onClick={() => approve.mutate()}>
                  {approve.isLoading ? 'Confirming…' : 'Confirm sale'}
                </button>
                <button className="btn btn-ghost" style={{ color: 'var(--red)' }}
                  onClick={async () => {
                    if (await appConfirm('Decline this sale? It cancels the request for everyone.',
                      { danger: true, confirmLabel: 'Decline' })) decline.mutate()
                  }}>Decline</button>
              </div>
              {err && <div style={{ color: 'var(--red)', fontSize: '.78rem', marginTop: 8 }}>{err}</div>}
            </div>
          )}
          {request.youApproved && (
            <div style={{ fontSize: '.82rem', color: 'var(--green)' }}>
              ✓ You've confirmed. Waiting on the other owners.
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── No sale in flight ──
  return (
    <div style={{ maxWidth: 640 }}>
      <h3 style={{ fontSize: '1rem', margin: '0 0 6px' }}>Sell or transfer this property</h3>
      <p style={{ fontSize: '.85rem', color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 14 }}>
        Hands {propertyName} to another GAM account. <strong style={{ color: 'var(--text-0)' }}>Every owner
        of this account must confirm</strong> before anything moves.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div style={{ background: 'var(--bg-2)', borderRadius: 10, padding: 12 }}>
          <div style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--gold)', marginBottom: 6 }}>Moves to the buyer</div>
          <div style={{ fontSize: '.8rem', color: 'var(--text-2)', lineHeight: 1.7 }}>
            The property and its units · leases, unchanged · deposit obligations ·
            equipment · open maintenance · rent from here on
          </div>
        </div>
        <div style={{ background: 'var(--bg-2)', borderRadius: 10, padding: 12 }}>
          <div style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)', marginBottom: 6 }}>Stays with you</div>
          <div style={{ fontSize: '.8rem', color: 'var(--text-2)', lineHeight: 1.7 }}>
            Every payment already received · invoices · payouts · expenses ·
            your reports for the period you owned it
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'rgba(201,162,39,.06)',
        border: '1px solid rgba(201,162,39,.2)', borderRadius: 10, padding: '10px 14px', marginBottom: 16 }}>
        <AlertTriangle size={15} style={{ color: 'var(--gold)', marginTop: 2, flexShrink: 0 }} />
        <div style={{ fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.55 }}>
          No money moves. Rent already collected stays where it went — proration between you and the
          buyer is handled by your closing statement, not by GAM. This cannot be undone in the portal.
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Buyer's GAM email *</label>
        <input className="input" value={email} onChange={e => { setEmail(e.target.value); setErr('') }}
          placeholder="buyer@example.com" style={{ width: '100%' }} />
        <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 4 }}>
          They need a landlord account on GAM first.
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Note for your co-owners</label>
        <input className="input" value={note} onChange={e => setNote(e.target.value)}
          placeholder="Closing 30 Sept — per the purchase agreement" style={{ width: '100%' }} />
      </div>

      {err && (
        <div style={{ color: 'var(--red)', fontSize: '.8rem', background: 'rgba(255,71,87,.08)',
          border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>{err}</div>
      )}

      <button className="btn btn-primary" disabled={!email.trim() || start.isLoading}
        onClick={async () => {
          if (await appConfirm(
            `Propose transferring ${propertyName} to ${email.trim()}? Every owner will be emailed a confirmation code.`,
            { confirmLabel: 'Propose sale' })) { setErr(''); start.mutate() }
        }}>
        <ArrowRightLeft size={15} /> Propose sale
      </button>
    </div>
  )
}
