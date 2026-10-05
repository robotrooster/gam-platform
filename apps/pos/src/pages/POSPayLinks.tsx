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
import { POSCustomerPicker, toastOnce, errorMessage, type PickedPerson } from '../components/POSCustomerPicker'

const fmt = (n: number) => '$' + (Number(n) || 0).toFixed(2)

export interface PayLinkCartLine { id: string | null; name: string; qty: number; price: number; tax?: number; cat?: string
  /** 10/3 (review): a stay's figure as the register shows it — the server refuses the link if its nights cost something else now. */
  stayTotal?: number }

/**
 * 10/3 (decisions #9): the site, arrival and guest of a stay in the cart — the link holds the site for them.
 * 10/5 (Nic): with what the stay needs, as the server quoted it at the register — the guest's email, the
 * counter's lease answer, the stay a month is added to, the background check's fee (and its line's name),
 * and the held-through words for a 30+ night stay with no lease.
 */
export interface PayLinkStay { unitId: string; checkIn: string; guestName: string; guestPhone?: string | null
  guestEmail?: string | null; stayTerms?: 'lease' | 'stay' | null; extendBookingId?: string | null
  screeningFee?: number | null; screeningLineName?: string | null; heldWords?: string | null }

/** "Email a pay link" — the current cart, sent to one person to pay by card. */
export function SendPayLinkModal({ propertyId, cart, stay = null, discountAmount, total, customerPaysFee = true, person: initialPerson = null, onClose, onSent }: {
  propertyId: string
  cart: PayLinkCartLine[]
  /** A stay in the cart goes with its site and dates — priced as Charge and the schedule price those nights. */
  stay?: PayLinkStay | null
  discountAmount: number
  /** The cart total before any card fee, as the register shows it. */
  total: number
  /** S648: false when this property absorbs the card fee. */
  customerPaysFee?: boolean
  /** 10/2: whoever the register already picked — the link carries them. */
  person?: PickedPerson | null
  onClose: () => void
  onSent: () => void
}) {
  // 10/2: a link names the PERSON it is for, so when it is paid the sale (and
  // the card it was paid with) lands on their record. Found the same typed way
  // as at the register; their name, email and phone fill the fields below.
  // The register's person stays the register's: taking them off here never lets
  // go of a record the register made for them (POSCustomerPicker madeByPick).
  const [person, setPerson] = useState<PickedPerson | null>(initialPerson ? { ...initialPerson, madeByPick: false } : null)
  const [name, setName] = useState(initialPerson?.name ?? '')
  const [email, setEmail] = useState(initialPerson?.email ?? '')
  const [phone, setPhone] = useState(initialPerson?.phone ?? '')
  const [err, setErr] = useState<string | null>(null)
  const qc = useQueryClient()
  const fee = customerPaysFee ? processingFeeFor({ amount: total, paymentMethod: 'card' }) : 0
  const send = useMutation(
    () => apiPost('/pos/pay-links', {
      propertyId, items: cart, discountAmount,
      ...(stay ? { stay: stay.extendBookingId
        ? { extendBookingId: stay.extendBookingId, guestEmail: stay.guestEmail || null, stayTerms: stay.stayTerms || null, screeningFee: stay.screeningFee || null }
        : { unitId: stay.unitId, checkIn: stay.checkIn, guestName: stay.guestName, guestPhone: stay.guestPhone || null,
            guestEmail: stay.guestEmail || null, stayTerms: stay.stayTerms || null, screeningFee: stay.screeningFee || null } } : {}),
      customer: { name: name.trim() || undefined, email: email.trim(), phone: phone.trim() || undefined },
      // 10/2 (review): someone from outside this company goes as their sealed
      // pick — their record here is made with the link, never at the pick.
      ...(person?.pick ? { match: { pick: person.pick } }
        : person?.kind === 'resident' && person.tenantId ? { tenantId: person.tenantId }
        : person?.kind === 'customer' && person.customerId ? { posCustomerId: person.customerId } : {}),
    }),
    {
      onSuccess: () => { toastOnce(`Pay link sent to ${email.trim()}`); onSent() },
      onError: (e: any) => {
        // 10/3 (review): refused because something changed (the site was taken,
        // its figure moved) — the site picker reads what is free again.
        if (e?.response?.status === 409) qc.invalidateQueries('stay-availability')
        setErr(errorMessage(e, 'The link could not be sent — check the connection and press Send link again.'))
      },
    })
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const pickPerson = (p: PickedPerson | null) => {
    setPerson(p)
    if (p) { setName(p.name || ''); setEmail(p.email || ''); setPhone(p.phone || '') }
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Email a pay link</div>
        <div style={{ fontSize: '.8rem', color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.5 }}>
          They get a link to pay this cart by card. The sale is recorded when they pay.
        </div>
        <div style={{ display: 'grid', gap: 4, fontSize: '.85rem', marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--text-3)' }}>Cart</span><span className="mono">{fmt(total)}</span></div>
          {/* 10/5 (Nic, R8): the background check goes on the link as its own line and cannot be taken off. */}
          {stay?.screeningFee ? <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.78rem' }}><span style={{ color: 'var(--text-3)' }}>Includes {stay.screeningLineName || 'a background check'}</span><span className="mono">{fmt(stay.screeningFee)}</span></div> : null}
          {fee > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--text-3)' }}>Card processing fee</span><span className="mono">{fmt(fee)}</span></div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>They pay</span><span className="mono" style={{ color: 'var(--gold)' }}>{fmt(total + fee)}</span></div>
        </div>
        {/* 10/5 (Nic, R13): a 30+ night stay with no lease is held only through what is paid — said before it goes out. */}
        {stay?.heldWords && <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.5 }}>{stay.heldWords}</div>}
        {/* S649 (Nic): find the person instead of retyping them — by any part
            of a name, email or phone. 10/2: someone from outside this company
            shows as a name and a masked hint; their email is typed here. */}
        <div style={{ marginBottom: 8 }}>
          <POSCustomerPicker propertyId={propertyId} value={person} onChange={pickPerson} sealedPicks placeholder="Find someone — name, email or phone" />
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

function printQr(label: string, price: number, linkId: string, feeOnTop: boolean) {
  api.get(`/pos/pay-links/${linkId}/qr.png`, { responseType: 'blob' }).then(r => {
    const reader = new FileReader()
    reader.onload = () => {
      const w = window.open('', '_blank')
      if (!w) { toastOnce('The sign could not open — allow pop-ups for this site, then press Print sign again.', { error: true }); return }
      w.document.write(`<!doctype html><title>${esc(label)}</title>
        <body style="font-family:system-ui,sans-serif;text-align:center;padding:40px">
        <h1 style="font-size:40px;margin:0 0 6px">${esc(label)}</h1>
        <div style="font-size:28px;margin-bottom:18px">$${price.toFixed(2)}${feeOnTop ? ' + card fee' : ''}</div>
        <img src="${reader.result}" style="width:360px;height:360px">
        <p style="font-size:22px">Scan to pay by card</p>
        <script>window.onload=()=>window.print()</script></body>`)
      w.document.close()
    }
    reader.readAsDataURL(r.data as Blob)
  }).catch(() => toastOnce('Could not load the QR code — check the connection and press Print sign again.', { error: true }))
}

const HELD_REASON_LABEL: Record<string, string> = {
  paid_twice: 'Paid twice',
  wrong_amount: 'Paid an old amount of the link',
  over_owed: 'More than the reservation still owed',
  deposit_part: "Part of a long stay's deposit",
}

/**
 * 10/3 (Nic, decisions #13): "do NOT automatically refund. Landlord needs
 * notification before refunding." A card payment that came in on a pay link
 * but did not fit is held by GAM — not a sale, not in the payouts — until the
 * account owner presses Refund this payment here (the notice links straight to
 * it). Shown to the owner only; nothing here refunds on its own.
 *
 * 10/3: the button asks first, in this row (never a browser pop-up), and says
 * plainly what goes back: this one payment, the whole of it (the card fee
 * included), to the card it came from. 10/3 (Nic, decisions #22): and what it
 * costs — Stripe keeps its processing fee on a refunded payment, and that fee
 * comes out of the landlord's next payout (never GAM's, never the drawer's). 10/3 (review): never "everything they
 * paid on this link" — a link's first payment may be a sale already (at the
 * counter, or online) and only the second one held; and "their card" when no
 * name is known (never "pat@t.dev's card").
 */
function HeldPayments() {
  const qc = useQueryClient()
  const key = ['pos-held-payments']
  const { data } = useQuery<any[]>(key, () => apiGet('/pos/held-payments'), { staleTime: 0, refetchOnMount: 'always' })
  const focus = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('held') : null
  const [asking, setAsking] = useState<string | null>(null)
  const refund = useMutation((id: string) => apiPost(`/pos/held-payments/${id}/refund`), {
    onSuccess: (r: any) => {
      setAsking(null)
      const kept = r?.data?.stripeFeeKept
      toastOnce(`Refunded ${fmt(r?.data?.amount)} to their card.${kept != null && Number(kept) > 0 ? ` Stripe kept its ${fmt(Number(kept))} fee — it comes out of your next payout.` : ''}`)
      qc.invalidateQueries(key)
    },
    onError: (e: any) => { qc.invalidateQueries(key); toastOnce(errorMessage(e, 'The refund could not be started — check the connection, then press Refund this payment again.'), { error: true }) },
  })
  const rows = Array.isArray(data) ? data : []
  if (!rows.length) return null
  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-0)', fontWeight: 700 }}>Payments held for you to refund</div>
      <div style={{ padding: '10px 16px 0', fontSize: '.8rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
        Each of these came in on a pay link but did not fit what was owed. GAM is holding it: it is not a sale and it is not in your payouts.
        Refund this payment sends it back to the card it came from — never from the drawer.
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead><tr><th>Who</th><th>Why</th><th>Amount</th><th>When</th><th></th></tr></thead>
          <tbody>
            {rows.map((h: any) => (
              <tr key={h.id} style={h.id === focus ? { outline: '2px solid var(--gold)' } : undefined}>
                <td>{h.payerName || h.customerEmail || 'A customer'}<div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{h.linkLabel}{h.propertyName ? ` · ${h.propertyName}` : ''}</div></td>
                <td>{HELD_REASON_LABEL[h.reason] ?? 'Did not fit the link'}</td>
                <td className="mono">{fmt(Number(h.amount))}</td>
                <td className="mono">{new Date(h.createdAt).toLocaleDateString()}</td>
                <td>{h.status !== 'held'
                  ? <span className="badge badge-muted">Refunded</span>
                  : asking === h.id
                    ? <div style={{ display: 'grid', gap: 6, minWidth: 220 }}>
                        <div style={{ fontSize: '.78rem', lineHeight: 1.45 }}>
                          Refund this {fmt(Number(h.amount))} payment — the whole of it, card fee included — to {h.payerName ? `${h.payerName}’s card` : 'their card'}, the one it came from?
                          {h.stripeFeeKept != null
                            ? ` Stripe keeps its ${fmt(Number(h.stripeFeeKept))} processing fee — that comes out of your next payout.`
                            : ' Stripe keeps its processing fee on this payment — that comes out of your next payout.'}
                          {' '}Nothing comes out of the drawer.
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-primary btn-sm" disabled={refund.isLoading} onClick={() => refund.mutate(h.id)}>
                            {refund.isLoading && refund.variables === h.id ? 'Refunding…' : `Refund ${fmt(Number(h.amount))}`}
                          </button>
                          <button className="btn btn-ghost btn-sm" disabled={refund.isLoading} onClick={() => setAsking(null)}>Keep it held</button>
                        </div>
                      </div>
                    : <button className="btn btn-primary btn-sm" disabled={refund.isLoading} onClick={() => setAsking(h.id)}>Refund this payment</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** The "Pay Links" tab: what is waiting to be paid, and the standing QR codes. */
export function PayLinksTab({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient()
  const key = ['pos-pay-links', propertyId]
  // 10/2: read fresh every time the tab is shown.
  const { data: links = [], isLoading } = useQuery<any[]>(key,
    () => apiGet(`/pos/pay-links?propertyId=${propertyId}`), { enabled: !!propertyId, staleTime: 0, refetchOnMount: 'always' })
  const refresh = () => qc.invalidateQueries(key)
  // 10/3 (review): Close on a link that holds a stay cancels the guest's
  // reservation and frees the site — so the row asks first (never a browser
  // pop-up): gray Keep it backs out with nothing changed.
  const [closeAsk, setCloseAsk] = useState<string | null>(null)
  const cancel = useMutation((id: string) => apiPost(`/pos/pay-links/${id}/cancel`),
    { onSuccess: (r: any) => {
        toastOnce(r?.data?.stayCancelled ? 'Link closed — its reservation was canceled and the site is free' : 'Link closed')
        setCloseAsk(null); refresh() },
      onError: (e: any) => { setCloseAsk(null); refresh(); toastOnce(errorMessage(e, 'Could not close it — check the connection and press Close again.'), { error: true }) } })
  const resend = useMutation((id: string) => apiPost(`/pos/pay-links/${id}/resend`),
    { onSuccess: () => { toastOnce('Link sent again'); refresh() },
      onError: (e: any) => { refresh(); toastOnce(errorMessage(e, 'Could not send it — check the connection and press Send again.'), { error: true }) } })
  const [qrLabel, setQrLabel] = useState('')
  const [qrPrice, setQrPrice] = useState('')
  const makeQr = useMutation(
    () => apiPost('/pos/pay-links', {
      propertyId, kind: 'standing', label: qrLabel.trim(),
      items: [{ id: null, name: qrLabel.trim(), qty: 1, price: Number(qrPrice), tax: 0, cat: 'misc' }],
    }),
    { onSuccess: () => { setQrLabel(''); setQrPrice(''); refresh() },
      onError: (e: any) => toastOnce(errorMessage(e, 'Could not create the QR code — check the connection and press Create QR code again.'), { error: true }) })

  const standing = (links as any[]).filter(l => l.kind === 'standing' && l.status === 'open')
  const emailed = (links as any[]).filter(l => l.kind === 'one_time')
  const copy = (url: string) => navigator.clipboard?.writeText(url).then(() => toastOnce('Link copied'))
    .catch(() => toastOnce('Could not copy — select the link and copy it by hand.', { error: true }))

  if (!propertyId) return (
    <div style={{ display: 'grid', gap: 16 }}>
      <HeldPayments />
      <div className="card" style={{ padding: 24, color: 'var(--text-3)' }}>Select a property first.</div>
    </div>
  )
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <HeldPayments />
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
                    <td>{l.label}
                      {/* 10/3 (decisions #23): a link whose reservation can no longer be paid says why, and what to press. */}
                      {l.status === 'open' && l.note && <div style={{ fontSize: '.72rem', color: 'var(--amber)', marginTop: 2, maxWidth: 320, lineHeight: 1.4 }}>{l.note}</div>}
                    </td>
                    <td className="mono">{fmt(l.charged)}</td>
                    <td className="mono">{new Date(l.createdAt).toLocaleDateString()}</td>
                    <td><span className={'badge ' + (l.status === 'paid' ? 'badge-green' : l.status === 'open' ? 'badge-gold' : 'badge-muted')}>
                      {l.status === 'open' ? 'Waiting' : l.status === 'paid' ? 'Paid' : l.status === 'cancelled' ? 'Closed' : 'Expired'}
                    </span></td>
                    <td>{l.status === 'open' && (closeAsk === l.id && l.holdsStay
                      ? <div style={{ display: 'grid', gap: 6, minWidth: 240 }}>
                          <div style={{ fontSize: '.78rem', lineHeight: 1.45 }}>
                            Close this link? It holds {l.holdsStay.guest ? `${l.holdsStay.guest}’s` : 'the guest’s'} reservation
                            {l.holdsStay.site ? ` for site ${l.holdsStay.site}` : ''} ({l.holdsStay.dates}); closing it cancels that reservation and frees the site.
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button className="btn btn-ghost btn-sm" disabled={cancel.isLoading} onClick={() => setCloseAsk(null)}>Keep it</button>
                            <button className="btn btn-primary btn-sm" disabled={cancel.isLoading} onClick={() => cancel.mutate(l.id)}>
                              {cancel.isLoading && cancel.variables === l.id ? 'Closing…' : 'Close and cancel the stay'}
                            </button>
                          </div>
                        </div>
                      : <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-primary btn-sm" onClick={() => copy(l.url)}>Copy link</button>
                          <button className="btn btn-primary btn-sm" disabled={resend.isLoading} onClick={() => resend.mutate(l.id)}>Send again</button>
                          <button className="btn btn-ghost btn-sm" disabled={cancel.isLoading}
                            onClick={() => (l.holdsStay ? setCloseAsk(l.id) : cancel.mutate(l.id))}>Close</button>
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
          Each payment is recorded as its own sale. The card fee is added on top unless this property absorbs it
          (the property&apos;s Card fees setting when the code is made).
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
              <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>{fmt(Number(l.total))}{l.customerFee > 0 ? <> + {fmt(l.customerFee)} card fee</> : null} · paid {l.timesPaid}×</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-primary btn-sm" onClick={() => printQr(l.label, Number(l.total), l.id, l.customerFee > 0)}>Print sign</button>
                <button className="btn btn-ghost btn-sm" disabled={cancel.isLoading} onClick={() => cancel.mutate(l.id)}>Retire</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
