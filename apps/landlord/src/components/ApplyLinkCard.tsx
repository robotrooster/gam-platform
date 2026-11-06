import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation } from 'react-query'
import { Link2, QrCode, Send, Copy } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { toast } from './dialogs'

// 10/30 (Nic): "screening isnt pos flow. emailed link/qr code for application.
// text by front desk if needed. pos has nothing to do with screening. if you
// are on the wrong property the screen gets linked wrong. property specific
// links need to be used from kpi cards."
//
// The link and the QR already existed — GET /properties/:id/apply-link and its
// /send sibling, both built 10/21 — but the only places to reach them were the
// Properties page and the register's Checks tab, which is the surface he is
// saying screening does not belong on. This puts them on the screening page
// itself, which is where the Applications card on the dashboard lands.
//
// THE PROPERTY IS NEVER IMPLIED. There is no "all properties" option and no
// default pick: the link's whole job is to bind the application to one
// property, so a wrong one quietly mislabels a real applicant. That is the
// failure he named, and the only way to not have it is to make the desk say
// which park out loud. When the dashboard card carries a property through,
// that one is pre-selected; when it carries nothing, this asks.

type PropertyLite = { id: string; name: string; companyId?: string | null; landlordId?: string | null }

export function ApplyLinkCard(
  { companyId, initialPropertyId }:
  { companyId?: string; initialPropertyId?: string },
) {
  const [propertyId, setPropertyId] = useState(initialPropertyId || '')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [showQr, setShowQr] = useState(false)

  const { data: properties = [] } = useQuery<PropertyLite[]>(
    'properties', () => apiGet<PropertyLite[]>('/properties'))

  const mine = useMemo(() => properties.filter(
    p => !companyId || !p.companyId || p.companyId === companyId), [properties, companyId])

  // A property carried in from the dashboard that this company does not own is
  // not silently kept — it would send the desk somebody else's link.
  useEffect(() => {
    if (propertyId && mine.length && !mine.some(p => p.id === propertyId)) setPropertyId('')
  }, [mine, propertyId])

  const { data: link, isLoading: linkLoading } = useQuery<any>(
    ['apply-link', propertyId],
    () => apiGet<any>(`/properties/${propertyId}/apply-link`),
    { enabled: !!propertyId },
  )

  const send = useMutation(
    () => apiPost(`/properties/${propertyId}/apply-link/send`,
      { email: email.trim(), name: name.trim() }),
    {
      onSuccess: (r: any) => {
        toast(`Application link sent to ${r?.data?.sentTo || email.trim()}. They pay for the check on the page.`)
        setEmail(''); setName('')
      },
      onError: (e: any) => toast.error(
        e?.response?.data?.error || 'That did not send — try again in a moment.'),
    },
  )

  const chosen = mine.find(p => p.id === propertyId)
  const noSlug = !!link && link.url === null
  const url: string | null = link?.url ?? null
  const emailReady = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && !!name.trim() && !!url

  const copy = async () => {
    if (!url) return
    try { await navigator.clipboard.writeText(url); toast('Link copied — paste it into a text message.') }
    catch { toast.error('Could not copy automatically. Select the link above and copy it.') }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header"><span className="card-title">Invite someone to apply</span></div>

      <p style={{ fontSize: '.78rem', color: 'var(--text-3)', margin: '10px 0 12px', maxWidth: 620, lineHeight: 1.55 }}>
        One link per property. The applicant pays for their own background check on the page, so
        nothing is collected at the desk. Email it, or copy it and text it.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <select className="input" style={{ maxWidth: 300 }} value={propertyId}
          onChange={e => { setPropertyId(e.target.value); setShowQr(false) }}>
          <option value="">Which property…</option>
          {mine.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {!!url && (
          <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
              <Copy size={13} /> Copy link
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowQr(v => !v)}>
              <QrCode size={13} /> {showQr ? 'Hide' : 'Show'} QR code
            </button>
          </>
        )}
      </div>

      {!propertyId ? (
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
          Pick the property first — the link is what ties the application to it.
        </div>
      ) : linkLoading ? (
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>Loading the link…</div>
      ) : noSlug ? (
        // The server's own reason, in its own words, then the next step.
        <div style={{ fontSize: '.78rem', color: 'var(--amber)', maxWidth: 620, lineHeight: 1.55 }}>
          {chosen?.name || 'This property'} has no booking address yet, so there is no application
          link for it. Set one under the property's booking settings, then come back.
        </div>
      ) : (
        <>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', marginBottom: 12,
            background: 'var(--bg-3)', borderRadius: 'var(--r-md)', fontSize: '.76rem',
            color: 'var(--text-1)', wordBreak: 'break-all',
          }}>
            <Link2 size={13} style={{ flex: '0 0 auto' }} />
            <span>{url}</span>
          </div>

          {showQr && link?.qrDataUrl && (
            <div style={{ marginBottom: 14 }}>
              <img src={link.qrDataUrl} alt={`Application QR code for ${chosen?.name || 'this property'}`}
                style={{ width: 180, height: 180, background: '#fff', padding: 8, borderRadius: 8 }} />
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 6, maxWidth: 260 }}>
                Print it for the desk. Whoever scans it lands in the application for
                {' '}{chosen?.name || 'this property'}.
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="input" style={{ maxWidth: 190 }} placeholder="Their name"
              value={name} onChange={e => setName(e.target.value)} autoComplete="off" />
            <input className="input" style={{ maxWidth: 230 }} type="email" placeholder="Their email"
              value={email} onChange={e => setEmail(e.target.value)} autoComplete="off" />
            <button className="btn btn-primary btn-sm" disabled={!emailReady || send.isLoading}
              onClick={() => send.mutate()}>
              <Send size={13} /> {send.isLoading ? 'Sending…' : 'Email the link'}
            </button>
          </div>
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 8, maxWidth: 620 }}>
            Their email is the address the link goes to and the one they will sign in with, so a
            typo means they can neither open it nor sort it out.
          </div>
        </>
      )}
    </div>
  )
}
