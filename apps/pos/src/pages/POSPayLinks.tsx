// S648 (Nic) — register pay links: charges for people who are not on a lease.
//
//   "We need a way to generate an item, a charge and send it to a link so they
//    can pay by email... having the QR code for the dump station so people can
//    scan it, pay their bill."
//
// Shipped in BOTH register apps (apps/landlord and apps/pos) — byte-identical,
// enforced by apps/api/src/pos-parity.test.ts, same as POSPage.tsx.
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { processingFeeFor } from '@gam/shared'
import { api, apiGet, apiPost } from '../lib/api'
import { toast } from '../components/dialogs'

const fmt = (n: number) => '$' + (Number(n) || 0).toFixed(2)

export interface PayLinkCartLine { id: string | null; name: string; qty: number; price: number; tax?: number; cat?: string }

/** "Email a pay link" — the current cart, sent to one person to pay by card. */
export function SendPayLinkModal({ propertyId, cart, discountAmount, total, onClose, onSent }: {
  propertyId: string
  cart: PayLinkCartLine[]
  discountAmount: number
  /** The cart total before any card fee, as the register shows it. */
  total: number
  onClose: () => void
  onSent: () => void
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const fee = processingFeeFor({ amount: total, paymentMethod: 'card' })
  const send = useMutation(
    () => apiPost('/pos/pay-links', {
      propertyId, items: cart, discountAmount,
      customer: { name: name.trim() || undefined, email: email.trim(), phone: phone.trim() || undefined },
    }),
    {
      onSuccess: () => { toast(`Pay link sent to ${email.trim()}`); onSent() },
      onError: (e: any) => setErr(e?.response?.data?.error || 'Could not send the link'),
    })
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Email a pay link</div>
        <div style={{ fontSize: '.8rem', color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.5 }}>
          They get a link to pay this cart by card. The sale is recorded when they pay.
        </div>
        <div style={{ display: 'grid', gap: 4, fontSize: '.85rem', marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--text-3)' }}>Cart</span><span className="mono">{fmt(total)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--text-3)' }}>Card processing fee</span><span className="mono">{fmt(fee)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>They pay</span><span className="mono" style={{ color: 'var(--gold)' }}>{fmt(total + fee)}</span></div>
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          <input id="paylink-name" className="form-input" placeholder="Name" value={name} onChange={e => setName(e.target.value)} />
          <input id="paylink-email" className="form-input" type="email" placeholder="Email (required)" value={email} onChange={e => setEmail(e.target.value)} />
          <input id="paylink-phone" className="form-input" type="tel" placeholder="Phone" value={phone} onChange={e => setPhone(e.target.value)} />
        </div>
        {err && <div style={{ color: 'var(--red)', fontSize: '.8rem', marginTop: 8 }}>{err}</div>}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ok || send.isLoading || cart.length === 0} onClick={() => send.mutate()}>
            {send.isLoading ? 'Sending…' : 'Send link'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** A printable QR image for a standing link (fetched with the session's auth). */
function QrImage({ linkId }: { linkId: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let url: string | null = null
    api.get(`/pos/pay-links/${linkId}/qr.png`, { responseType: 'blob' })
      .then(r => { url = URL.createObjectURL(r.data as Blob); setSrc(url) })
      .catch(() => setSrc(null))
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [linkId])
  return src
    ? <img src={src} alt="QR code" style={{ width: 160, height: 160, background: '#fff', borderRadius: 8, padding: 6 }} />
    : <div style={{ width: 160, height: 160, borderRadius: 8, background: 'var(--bg-3)' }} />
}

const esc = (t: string) => String(t).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

function printQr(label: string, price: number, linkId: string) {
  api.get(`/pos/pay-links/${linkId}/qr.png`, { responseType: 'blob' }).then(r => {
    const reader = new FileReader()
    reader.onload = () => {
      const w = window.open('', '_blank')
      if (!w) { toast.error('Allow pop-ups to print the sign'); return }
      w.document.write(`<!doctype html><title>${esc(label)}</title>
        <body style="font-family:system-ui,sans-serif;text-align:center;padding:40px">
        <h1 style="font-size:40px;margin:0 0 6px">${esc(label)}</h1>
        <div style="font-size:28px;margin-bottom:18px">$${price.toFixed(2)} + card fee</div>
        <img src="${reader.result}" style="width:360px;height:360px">
        <p style="font-size:22px">Scan to pay by card</p>
        <script>window.onload=()=>window.print()</script></body>`)
      w.document.close()
    }
    reader.readAsDataURL(r.data as Blob)
  }).catch(() => toast.error('Could not load the QR code'))
}

/** The "Pay Links" tab: what is waiting to be paid, and the standing QR codes. */
export function PayLinksTab({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient()
  const key = ['pos-pay-links', propertyId]
  const { data: links = [], isLoading } = useQuery<any[]>(key,
    () => apiGet(`/pos/pay-links?propertyId=${propertyId}`), { enabled: !!propertyId })
  const refresh = () => qc.invalidateQueries(key)
  const cancel = useMutation((id: string) => apiPost(`/pos/pay-links/${id}/cancel`),
    { onSuccess: () => { toast('Link closed'); refresh() }, onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not close it') })
  const resend = useMutation((id: string) => apiPost(`/pos/pay-links/${id}/resend`),
    { onSuccess: () => toast('Link sent again'), onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not send it') })
  const [qrLabel, setQrLabel] = useState('')
  const [qrPrice, setQrPrice] = useState('')
  const makeQr = useMutation(
    () => apiPost('/pos/pay-links', {
      propertyId, kind: 'standing', label: qrLabel.trim(),
      items: [{ id: null, name: qrLabel.trim(), qty: 1, price: Number(qrPrice), tax: 0, cat: 'misc' }],
    }),
    { onSuccess: () => { setQrLabel(''); setQrPrice(''); refresh() },
      onError: (e: any) => toast.error(e?.response?.data?.error || 'Could not create the QR code') })

  const standing = (links as any[]).filter(l => l.kind === 'standing' && l.status === 'open')
  const emailed = (links as any[]).filter(l => l.kind === 'one_time')
  const copy = (url: string) => navigator.clipboard?.writeText(url).then(() => toast('Link copied')).catch(() => {})

  if (!propertyId) return <div className="card" style={{ padding: 24, color: 'var(--text-3)' }}>Select a property first.</div>
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-0)', fontWeight: 700 }}>Emailed pay links</div>
        {isLoading ? <div style={{ padding: 24, color: 'var(--text-3)' }}>Loading…</div> : emailed.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--text-3)', fontSize: '.85rem' }}>
            None yet. Ring up a cart on the Register and choose “Email a pay link”.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>For</th><th>What</th><th>They pay</th><th>Sent</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {emailed.map((l: any) => (
                  <tr key={l.id}>
                    <td>{l.customerName || l.customerEmail}<div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{l.customerEmail}</div></td>
                    <td>{l.label}</td>
                    <td className="mono">{fmt(l.charged)}</td>
                    <td className="mono">{new Date(l.createdAt).toLocaleDateString()}</td>
                    <td><span className={'badge ' + (l.status === 'paid' ? 'badge-green' : l.status === 'open' ? 'badge-gold' : 'badge-muted')}>
                      {l.status === 'open' ? 'Waiting' : l.status === 'paid' ? 'Paid' : l.status === 'cancelled' ? 'Closed' : 'Expired'}
                    </span></td>
                    <td>{l.status === 'open' && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => copy(l.url)}>Copy link</button>
                        <button className="btn btn-ghost btn-sm" disabled={resend.isLoading} onClick={() => resend.mutate(l.id)}>Send again</button>
                        <button className="btn btn-ghost btn-sm" disabled={cancel.isLoading} onClick={() => cancel.mutate(l.id)}>Close</button>
                      </div>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: 4 }}>QR codes</div>
        <div style={{ fontSize: '.8rem', color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.5 }}>
          A code anyone can scan to pay a set price by card — the dump station after hours, for example.
          Each payment is recorded as its own sale. The card fee is added on top.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <input id="qr-label" className="form-input" placeholder="What it's for (e.g. Dump station)" value={qrLabel}
            onChange={e => setQrLabel(e.target.value)} style={{ flex: '1 1 220px' }} />
          <input id="qr-price" className="form-input" inputMode="decimal" placeholder="Price" value={qrPrice}
            onChange={e => setQrPrice(e.target.value.replace(/[^\d.]/g, ''))} style={{ width: 110 }} />
          <button className="btn btn-primary" disabled={!qrLabel.trim() || !(Number(qrPrice) > 0) || makeQr.isLoading}
            onClick={() => makeQr.mutate()}>Create QR code</button>
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {standing.map((l: any) => (
            <div key={l.id} style={{ border: '1px solid var(--border-0)', borderRadius: 12, padding: 12, display: 'grid', gap: 8, justifyItems: 'center' }}>
              <QrImage linkId={l.id} />
              <div style={{ fontWeight: 600 }}>{l.label}</div>
              <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>{fmt(Number(l.total))} + {fmt(l.fee)} card fee · paid {l.timesPaid}×</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-primary btn-sm" onClick={() => printQr(l.label, Number(l.total), l.id)}>Print sign</button>
                <button className="btn btn-ghost btn-sm" disabled={cancel.isLoading} onClick={() => cancel.mutate(l.id)}>Retire</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
