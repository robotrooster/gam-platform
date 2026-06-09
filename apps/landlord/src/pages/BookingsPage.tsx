import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { CalendarRange, Search, ArrowRight, FileSignature, CheckCircle2, AlertTriangle } from 'lucide-react'
import { apiGet, apiPatch } from '../lib/api'

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

export function BookingsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
