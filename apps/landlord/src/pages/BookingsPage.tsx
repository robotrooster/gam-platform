import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { CalendarRange, Search, ArrowRight, FileSignature, CheckCircle2, AlertTriangle, MessageSquare, Check, X, QrCode, Copy, Mail, Ban } from 'lucide-react'
import { apiGet, apiPatch, apiPost, apiDelete } from '../lib/api'
import { BOOKING_CHANGE_REQUEST_TYPE_LABEL, type BookingChangeRequestType } from '@gam/shared'

type Booking = {
  id: string
  unitId: string
  unitNumber: string
  unitType: string
  propertyName: string
  requiresBookingAcknowledgment: boolean
  guestName: string | null
  guestEmail: string | null
  guestPhone: string | null
  leaseType: string
  checkIn: string
  checkOut: string
  nights: number
  totalAmount: string | number | null
  platformFee: string | number | null
  status: string
  source: string
  notes: string | null
  acknowledgmentSignedAt: string | null
  createdAt: string
}

type ChangeRequest = {
  id: string
  bookingId: string
  requestType: BookingChangeRequestType
  details: string | null
  status: string
  guestName: string | null
  checkIn: string
  checkOut: string
  unitNumber: string | null
  propertyName: string | null
  createdAt: string
}

const STATUS_BADGE: Record<string, string> = {
  confirmed: 'badge-blue',
  checked_in: 'badge-green',
  checked_out: 'badge-muted',
  cancelled: 'badge-muted',
  no_show: 'badge-red',
}

const fmt = (v: string | number | null | undefined) => {
  if (v == null) return '—'
  const n = typeof v === 'string' ? parseFloat(v) : v
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Date-only strings render at noon to dodge TZ off-by-one.
const fmtDate = (d: string | null | undefined) => {
  if (!d) return '—'
  try { return new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
  catch { return d }
}

// Guest stay-assistant access (S501 track). Shows the per-booking stay link +
// QR the host displays/prints on-site, can re-email it to the guest, and can
// revoke all access. Issuing mints a fresh reusable token bound to this one
// booking; revoke kills every outstanding link for it.
type IssuedAccess = { url: string; qrDataUrl: string; expiresAt: string; emailed: boolean }

function GuestAccessModal({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const base = `/units/${booking.unitId}/bookings/${booking.id}/guest-access`
  const [issued, setIssued] = useState<IssuedAccess | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoked, setRevoked] = useState<number | null>(null)

  // Issue (or re-issue) the link + QR. sendEmail re-issues and emails the guest.
  const issueMut = useMutation(
    (sendEmail: boolean) => apiPost<IssuedAccess>(base, { sendEmail }),
    {
      onSuccess: (res) => {
        setIssued(res.data)
        setRevoked(null)
        setCopied(false)
      },
    },
  )

  const revokeMut = useMutation(
    () => apiDelete<{ revoked: number }>(base),
    {
      onSuccess: (res) => {
        setRevoked(res.data.revoked)
        setIssued(null)
      },
    },
  )

  const copyLink = () => {
    if (!issued) return
    navigator.clipboard?.writeText(issued.url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    }).catch(() => {})
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 440, width: '95vw' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <QrCode size={18} style={{ color: 'var(--gold)' }} /> Stay link
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div style={{ fontSize: '.8rem', color: 'var(--text-3)', marginBottom: 16 }}>
          {booking.guestName || 'Guest'} · {booking.propertyName} Unit {booking.unitNumber} · {fmtDate(booking.checkIn)}–{fmtDate(booking.checkOut)}
        </div>

        {!issued && revoked == null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ fontSize: '.84rem', color: 'var(--text-1)' }}>
              Generate the guest's stay-assistant link and a QR code to show or print on-site.
              The guest chats with no account; the link works for the whole stay.
            </p>
            <button className="btn" disabled={issueMut.isLoading} onClick={() => issueMut.mutate(false)}>
              {issueMut.isLoading ? 'Generating…' : 'Generate stay link'}
            </button>
          </div>
        )}

        {issued && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <img src={issued.qrDataUrl} alt="Stay link QR code" width={200} height={200} style={{ borderRadius: 10, background: '#fff', padding: 8 }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Link</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" readOnly value={issued.url} onFocus={e => e.currentTarget.select()} style={{ fontSize: '.78rem' }} />
                <button className="btn btn-ghost btn-sm" onClick={copyLink} title="Copy link" style={{ flexShrink: 0 }}>
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
            <div style={{ fontSize: '.74rem', color: 'var(--text-3)' }}>
              Expires {new Date(issued.expiresAt).toLocaleDateString()}{issued.emailed ? ' · emailed to guest' : ''}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {booking.guestEmail && (
                <button className="btn btn-ghost btn-sm" disabled={issueMut.isLoading} onClick={() => issueMut.mutate(true)}>
                  <Mail size={13} /> Email to guest
                </button>
              )}
              <button
                className="btn btn-ghost btn-sm"
                disabled={revokeMut.isLoading}
                onClick={() => revokeMut.mutate()}
                style={{ color: 'var(--red)', marginLeft: 'auto' }}
              >
                <Ban size={13} /> Revoke access
              </button>
            </div>
          </div>
        )}

        {revoked != null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ fontSize: '.84rem', color: 'var(--text-1)' }}>
              {revoked > 0
                ? `Access revoked. ${revoked} link${revoked === 1 ? '' : 's'} no longer work.`
                : 'No active links to revoke.'}
            </p>
            <button className="btn btn-ghost btn-sm" disabled={issueMut.isLoading} onClick={() => issueMut.mutate(false)} style={{ alignSelf: 'flex-start' }}>
              Generate a new link
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function BookingsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [linkBooking, setLinkBooking] = useState<Booking | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [source, setSource] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  // S191: acknowledge a booking (mark guest signed property rules).
  const ackMut = useMutation(
    (booking: Booking) =>
      apiPatch(`/units/${booking.unitId}/bookings/${booking.id}/acknowledge`),
    {
      onSuccess: () => qc.invalidateQueries(['bookings']),
    },
  )

  // Guest-agent change requests (S501 track): open stay-change asks recorded
  // by the guest agent. The host approves/declines here; approving is an
  // acknowledgment, not an automatic booking edit.
  const { data: changeRequests = [] } = useQuery<ChangeRequest[]>(
    ['booking-change-requests'],
    () => apiGet<ChangeRequest[]>('/bookings/change-requests'),
    { staleTime: 30000 },
  )
  const resolveMut = useMutation(
    ({ id, status }: { id: string; status: 'approved' | 'declined' }) =>
      apiPatch(`/bookings/change-requests/${id}`, { status }),
    { onSuccess: () => qc.invalidateQueries(['booking-change-requests']) },
  )

  const queryString = useMemo(() => {
    const p: string[] = []
    if (status) p.push(`status=${encodeURIComponent(status)}`)
    if (source) p.push(`source=${encodeURIComponent(source)}`)
    if (from) p.push(`from=${encodeURIComponent(from)}`)
    if (to) p.push(`to=${encodeURIComponent(to)}`)
    if (search) p.push(`q=${encodeURIComponent(search)}`)
    return p.length ? `?${p.join('&')}` : ''
  }, [status, source, from, to, search])

  const { data = [], isLoading } = useQuery<Booking[]>(
    ['bookings', queryString],
    () => apiGet<Booking[]>(`/bookings${queryString}`),
    { staleTime: 30000 },
  )

  const list = data as Booking[]
  const totalAmount = list.reduce((s, b) => s + (parseFloat(String(b.totalAmount || 0)) || 0), 0)

  // S191: count bookings needing acknowledgment across the filtered set.
  // Only counts bookings on properties where the toggle is on AND the
  // booking hasn't been acknowledged yet AND the booking isn't a past
  // checked-out / cancelled state (no point chasing acks on closed rows).
  const needsAck = (b: Booking) =>
    b.requiresBookingAcknowledgment
    && !b.acknowledgmentSignedAt
    && b.status !== 'cancelled'
    && b.status !== 'checked_out'
    && b.status !== 'no_show'
  const pendingAckCount = list.filter(needsAck).length

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CalendarRange size={22} /> Bookings
          </h1>
          <div className="page-sub">
            Flat list of all short-term bookings across your portfolio.
            Use the calendar grid (
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/schedule')} style={{ padding: '0 6px', fontSize: '.78rem' }}>
              Schedule <ArrowRight size={11} />
            </button>
            ) for visual scheduling.
          </div>
        </div>
      </div>

      {changeRequests.length > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <MessageSquare size={16} style={{ color: 'var(--gold)' }} />
            <strong style={{ fontSize: '.9rem' }}>Guest requests</strong>
            <span className="badge badge-blue" style={{ marginLeft: 2 }}>{changeRequests.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {changeRequests.map(cr => (
              <div
                key={cr.id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 12, flexWrap: 'wrap',
                  padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 8,
                  background: 'var(--bg-1)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className="badge badge-blue">{BOOKING_CHANGE_REQUEST_TYPE_LABEL[cr.requestType]}</span>
                    <strong style={{ fontSize: '.88rem' }}>{cr.guestName || 'Guest'}</strong>
                    <span style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
                      {cr.propertyName || '—'}{cr.unitNumber ? ` · Unit ${cr.unitNumber}` : ''}
                      {' · '}{fmtDate(cr.checkIn)}–{fmtDate(cr.checkOut)}
                    </span>
                  </div>
                  {cr.details && (
                    <div style={{ fontSize: '.82rem', color: 'var(--text-1)', marginTop: 4 }}>{cr.details}</div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button
                    className="btn btn-sm"
                    disabled={resolveMut.isLoading}
                    onClick={() => resolveMut.mutate({ id: cr.id, status: 'approved' })}
                  >
                    <Check size={13} /> Approve
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={resolveMut.isLoading}
                    onClick={() => resolveMut.mutate({ id: cr.id, status: 'declined' })}
                  >
                    <X size={13} /> Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <div>
            <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Search guest</label>
            <div style={{ position: 'relative' }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="name or email" className="input" style={{ paddingLeft: 32 }} />
            </div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Status</label>
            <select value={status} onChange={e => setStatus(e.target.value)} className="input">
              <option value="">All</option>
              <option value="confirmed">Confirmed</option>
              <option value="checked_in">Checked-in</option>
              <option value="checked_out">Checked-out</option>
              <option value="cancelled">Cancelled</option>
              <option value="no_show">No-show</option>
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Source</label>
            <select value={source} onChange={e => setSource(e.target.value)} className="input">
              <option value="">All</option>
              <option value="direct">Direct</option>
              <option value="airbnb">Airbnb</option>
              <option value="vrbo">VRBO</option>
              <option value="booking_com">Booking.com</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>From</label>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="input" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>To</label>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} className="input" />
          </div>
        </div>
      </div>

      {pendingAckCount > 0 && (
        <div
          className="card"
          style={{
            padding: '10px 14px',
            marginBottom: 12,
            background: 'rgba(245,158,11,.08)',
            border: '1px solid rgba(245,158,11,.3)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <AlertTriangle size={16} style={{ color: 'var(--amber)' }} />
          <span style={{ fontSize: '.85rem', color: 'var(--text-1)' }}>
            <strong>{pendingAckCount}</strong> booking{pendingAckCount === 1 ? '' : 's'} need{pendingAckCount === 1 ? 's' : ''} property-rules acknowledgment.
            Click <FileSignature size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> on each row after collecting the guest's signature.
          </span>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, padding: '0 4px' }}>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>{list.length} bookings</div>
        <div style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>
          Total revenue: <strong style={{ color: 'var(--text-0)' }}>{fmt(totalAmount)}</strong>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
        ) : list.length === 0 ? (
          <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>
            No bookings match the filters.
          </div>
        ) : (
          <table className="data-table" style={{ minWidth: 1000 }}>
            <thead>
              <tr>
                <th>Status</th>
                <th>Guest</th>
                <th>Unit</th>
                <th>Check-in</th>
                <th>Nights</th>
                <th>Total</th>
                <th>Source</th>
                <th>Ack</th>
                <th>Stay link</th>
              </tr>
            </thead>
            <tbody>
              {list.map(b => (
                <tr key={b.id}>
                  <td><span className={`badge ${STATUS_BADGE[b.status] || 'badge-muted'}`}>{b.status.replace('_', ' ')}</span></td>
                  <td>
                    <div style={{ color: 'var(--text-0)', fontWeight: 600 }}>{b.guestName || '—'}</div>
                    <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{b.guestEmail || ''}</div>
                  </td>
                  <td>
                    <div style={{ color: 'var(--text-0)' }}>{b.unitNumber}</div>
                    <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{b.propertyName}</div>
                  </td>
                  <td className="mono" style={{ fontSize: '.78rem' }}>
                    {new Date(b.checkIn).toLocaleDateString()}
                    <div style={{ fontSize: '.65rem', color: 'var(--text-3)' }}>→ {new Date(b.checkOut).toLocaleDateString()}</div>
                  </td>
                  <td className="mono">{b.nights}</td>
                  <td className="mono" style={{ color: 'var(--text-0)' }}>{fmt(b.totalAmount)}</td>
                  <td>
                    <span style={{ fontSize: '.72rem', color: 'var(--text-2)', textTransform: 'capitalize' }}>
                      {b.source.replace('_', '.')}
                    </span>
                  </td>
                  <td>
                    {!b.requiresBookingAcknowledgment ? (
                      <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>—</span>
                    ) : b.acknowledgmentSignedAt ? (
                      <span
                        title={`Acknowledged ${new Date(b.acknowledgmentSignedAt).toLocaleString()}`}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--green)', fontSize: '.72rem' }}
                      >
                        <CheckCircle2 size={13} /> Acknowledged
                      </span>
                    ) : needsAck(b) ? (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => ackMut.mutate(b)}
                        disabled={ackMut.isLoading}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--amber)' }}
                        title="Mark this booking as having a signed property-rules acknowledgment"
                      >
                        <FileSignature size={12} />
                        Acknowledge
                      </button>
                    ) : (
                      <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>n/a</span>
                    )}
                  </td>
                  <td>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setLinkBooking(b)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      title="Show the guest stay-assistant link and QR, or revoke access"
                    >
                      <QrCode size={12} /> Stay link
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {linkBooking && (
        <GuestAccessModal booking={linkBooking} onClose={() => setLinkBooking(null)} />
      )}
    </div>
  )
}
