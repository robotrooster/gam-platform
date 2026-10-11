// S655 (security): the BUYER's side of a property transfer.
//
// A property used to land on the receiving account the moment the seller's
// owners confirmed — the buyer was never told or asked, and a mistyped email
// handed every tenant's record to an unrelated landlord. Now nothing moves
// until the receiving account accepts here: it sees what is coming (the
// property, the seller, how many units, live leases and deposits, the note),
// chooses which of its companies takes it, and enters the code from its email.
//
// Renders nothing when no transfer is waiting on this login.
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { ArrowRightLeft } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { toast, appConfirm } from './dialogs'
import { EntityPicker, useCompanyMissing } from './EntityPicker'

const money = (n: any) =>
  `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function IncomingTransfersCard() {
  const { data: incoming = [] } = useQuery<any[]>(
    'incoming-transfers', () => apiGet('/properties/transfer-requests/incoming'))
  if (!incoming.length) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
      {incoming.map((t: any) => <IncomingTransfer key={t.id} transfer={t} />)}
    </div>
  )
}

function IncomingTransfer({ transfer: t }: { transfer: any }) {
  const qc = useQueryClient()
  const [company, setCompany] = useState('')
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const companyMissing = useCompanyMissing(company)

  const refresh = () => {
    qc.invalidateQueries('incoming-transfers')
    qc.invalidateQueries('properties')
    qc.invalidateQueries('landlord-todos')
  }

  const accept = useMutation(
    () => apiPost(`/properties/transfer-request/${t.id}/approve`, {
      code: code.trim(), receivingLandlordId: company || undefined,
    }),
    {
      onSuccess: (r: any) => {
        const d = r?.data ?? r
        setCode('')
        toast(d?.executed
          ? `${t.propertyName} is now yours.`
          : `Accepted. ${t.propertyName} moves to you once every owner of ${t.sellerName} has confirmed.`)
        refresh()
      },
      onError: (e: any) => setErr(e?.response?.data?.error || 'Could not accept the transfer'),
    })

  const decline = useMutation(
    () => apiPost(`/properties/transfer-request/${t.id}/decline`, {}),
    {
      onSuccess: () => { toast('Transfer declined. Nothing moved.'); refresh() },
      onError: (e: any) => setErr(e?.response?.data?.error || 'Could not decline the transfer'),
    })

  const accepted = !!t.buyerAcceptedAt
  const where = [t.city, t.state].filter(Boolean).join(', ')

  return (
    <div className="card" style={{ padding: 18, borderLeft: '3px solid var(--gold)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <ArrowRightLeft size={17} style={{ color: 'var(--gold)' }} />
        <h3 style={{ margin: 0, fontSize: '1rem' }}>
          {t.sellerName} wants to transfer {t.propertyName} to you
        </h3>
      </div>
      <p style={{ fontSize: '.84rem', color: 'var(--text-2)', lineHeight: 1.6, margin: '0 0 12px' }}>
        {where && <>{t.propertyName} is in {where}. </>}
        If you accept, the property, its units, its leases and tenants, its security deposits and its
        equipment move to your company, rent from then on comes to you, and GAM's monthly platform fee
        for those units is billed to you. Nothing moves unless you accept.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 12 }}>
        {[
          { label: 'Units', val: t.unitCount },
          { label: 'Active leases', val: t.activeLeaseCount },
          { label: 'Deposits held', val: `${t.depositCount} · ${money(t.depositTotal)}` },
          { label: 'Owners confirmed', val: `${t.sellerApproved} of ${t.sellerRequired}` },
        ].map(k => (
          <div key={k.label} style={{ background: 'var(--bg-2)', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: '.62rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{k.label}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.92rem', fontWeight: 700, color: 'var(--text-0)' }}>{k.val}</div>
          </div>
        ))}
      </div>

      {t.note && (
        <div style={{ fontSize: '.8rem', color: 'var(--text-3)', fontStyle: 'italic', marginBottom: 10 }}>
          “{t.note}”
        </div>
      )}
      <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginBottom: 12 }}>
        Expires {String(t.expiresAt).slice(0, 10)}.
      </div>

      {accepted ? (
        <div style={{ fontSize: '.82rem', color: 'var(--green)' }}>
          ✓ You've accepted. It moves to you once every owner of {t.sellerName} has confirmed.
        </div>
      ) : (
        <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10, padding: 14 }}>
          <EntityPicker value={company} onChange={id => { setCompany(id); setErr('') }}
            label="Takes the property" note="The company that will own it, collect its rent and pay its fees." />
          <div style={{ fontSize: '.82rem', marginBottom: 8 }}>
            Enter the 6-digit code from your email to accept.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input className="input" value={code} onChange={e => { setCode(e.target.value); setErr('') }}
              placeholder="000000" maxLength={6} inputMode="numeric"
              style={{ width: 140, fontFamily: 'var(--font-mono)', letterSpacing: '.2em' }} />
            <button className="btn btn-primary"
              disabled={code.trim().length < 4 || companyMissing || accept.isLoading}
              onClick={() => accept.mutate()}>
              {accept.isLoading ? 'Accepting…' : 'Accept transfer'}
            </button>
            <button className="btn btn-ghost" disabled={decline.isLoading}
              onClick={async () => {
                if (await appConfirm(`Decline ${t.propertyName}? The transfer is cancelled and nothing moves.`,
                  { danger: true, confirmLabel: 'Decline' })) decline.mutate()
              }}>Decline</button>
          </div>
          {companyMissing && (
            <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: 8 }}>
              Choose which of your companies takes it.
            </div>
          )}
          {err && <div style={{ color: 'var(--red)', fontSize: '.78rem', marginTop: 8 }}>{err}</div>}
        </div>
      )}
    </div>
  )
}
