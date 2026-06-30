import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { CalendarClock, Plus, Building2, Check, X, Ban } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'

// NOTE: the landlord axios client camelizes responses (applyCamelizeInterceptor),
// so server snake_case arrives camelCase here.
type Property = { id: string; name: string }
type Area = {
  id: string; propertyId: string; name: string; description: string | null
  reservable: boolean; requiresApproval: boolean; capacity: number | null
  reservationFee: string; weekendFee: string | null; openTime: string | null; closeTime: string | null
  maxReservationHours: number | null; advanceBookingDays: number | null; active: boolean
}
type Reservation = {
  id: string; commonAreaId: string; kind: string; title: string | null
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  startsAt: string; endsAt: string; guestCount: number | null; notes: string | null
  notifyResidents: boolean; tenantFirstName: string | null; tenantLastName: string | null
}

const KIND_LABEL: Record<string, string> = {
  tenant_reservation: 'Resident', private_rental: 'Private rental',
  maintenance_closure: 'Closure', event: 'Community event',
}
const STATUS_BADGE: Record<string, string> = {
  pending: 'badge-amber', approved: 'badge-green', rejected: 'badge-muted', cancelled: 'badge-muted',
}
const fmt = (s: string) => new Date(s).toLocaleString(undefined,
  { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function AmenitiesPage() {
  const qc = useQueryClient()
  const { data: properties = [] } = useQuery<Property[]>('properties-min', () => apiGet<Property[]>('/properties'))
  const [propertyId, setPropertyId] = useState('')
  const pid = propertyId || properties[0]?.id || ''

  const { data: areas = [] } = useQuery<Area[]>(
    ['common-areas', pid], () => apiGet<Area[]>(`/common-areas?propertyId=${pid}`), { enabled: !!pid })

  const [showArea, setShowArea] = useState(false)
  const [holdFor, setHoldFor] = useState<Area | null>(null)
  const [reservationsFor, setReservationsFor] = useState<Area | null>(null)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CalendarClock size={22} /> Amenities & Common Areas
          </h1>
          <div className="page-sub">
            Reservable shared spaces (clubhouse, pool, pavilion). Residents request a slot;
            you approve. Private rentals, closures, and events go live immediately and notify
            every resident the amenity is unavailable.
          </div>
        </div>
        <button className="btn btn-primary" disabled={!pid} onClick={() => setShowArea(true)}>
          <Plus size={15} /> New Area
        </button>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>
          <Building2 size={12} style={{ verticalAlign: -2 }} /> Property
        </label>
        <select className="input" style={{ minWidth: 240 }} value={pid} onChange={e => setPropertyId(e.target.value)}>
          {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {!areas.length && (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>
          No common areas yet. Add a clubhouse, pool, or pavilion to start taking reservations.
        </div>
      )}

      <div style={{ display: 'grid', gap: 12 }}>
        {areas.map(a => (
          <div key={a.id} className="card" style={{ padding: 16, opacity: a.active ? 1 : 0.55 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>
                  {a.name}{' '}
                  {!a.reservable && <span className="badge badge-muted">announce-only</span>}
                  {a.reservable && a.requiresApproval && <span className="badge badge-blue">approval required</span>}
                  {a.reservable && !a.requiresApproval && <span className="badge badge-green">auto-approve</span>}
                  {!a.active && <span className="badge badge-muted">inactive</span>}
                </div>
                {a.description && <div className="page-sub" style={{ marginTop: 4 }}>{a.description}</div>}
                <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginTop: 6, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  {a.capacity != null && <span>Capacity {a.capacity}</span>}
                  {Number(a.reservationFee) > 0 && <span>Fee ${Number(a.reservationFee).toFixed(2)}{a.weekendFee ? ` · wknd $${Number(a.weekendFee).toFixed(2)}` : ''}</span>}
                  {a.openTime && a.closeTime && <span>Hours {a.openTime.slice(0, 5)}–{a.closeTime.slice(0, 5)}</span>}
                  {a.maxReservationHours && <span>Max {a.maxReservationHours}h</span>}
                  {a.advanceBookingDays && <span>Book ≤{a.advanceBookingDays}d ahead</span>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button className="btn btn-sm" onClick={() => setReservationsFor(a)}>Reservations</button>
                <button className="btn btn-sm" onClick={() => setHoldFor(a)}>+ Hold</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {showArea && pid && (
        <AreaModal propertyId={pid} onClose={() => setShowArea(false)}
          onSaved={() => { setShowArea(false); qc.invalidateQueries(['common-areas', pid]) }} />
      )}
      {holdFor && (
        <HoldModal area={holdFor} onClose={() => setHoldFor(null)}
          onSaved={() => { setHoldFor(null); qc.invalidateQueries(['common-areas', pid]) }} />
      )}
      {reservationsFor && (
        <ReservationsModal area={reservationsFor} onClose={() => setReservationsFor(null)} />
      )}
    </div>
  )
}

// ── New area ──────────────────────────────────────────────────────────
function AreaModal({ propertyId, onClose, onSaved }: { propertyId: string; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: '', description: '', reservable: true, requiresApproval: true,
    capacity: '', reservationFee: '', weekendFee: '', openTime: '', closeTime: '', maxReservationHours: '', advanceBookingDays: '',
  })
  const m = useMutation(
    () => apiPost('/common-areas', {
      propertyId, name: f.name, description: f.description || undefined,
      reservable: f.reservable, requiresApproval: f.requiresApproval,
      capacity: f.capacity ? Number(f.capacity) : null,
      reservationFee: f.reservationFee ? Number(f.reservationFee) : undefined,
      weekendFee: f.weekendFee ? Number(f.weekendFee) : null,
      openTime: f.openTime || null, closeTime: f.closeTime || null,
      maxReservationHours: f.maxReservationHours ? Number(f.maxReservationHours) : null,
      advanceBookingDays: f.advanceBookingDays ? Number(f.advanceBookingDays) : null,
    }),
    { onSuccess: onSaved })
  return (
    <Modal title="New common area" onClose={onClose}>
      <Field label="Name"><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="Clubhouse" /></Field>
      <Field label="Description"><input className="input" value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></Field>
      <div style={{ display: 'flex', gap: 16, margin: '8px 0' }}>
        <label style={{ fontSize: '.8rem' }}><input type="checkbox" checked={f.reservable} onChange={e => setF({ ...f, reservable: e.target.checked })} /> Reservable</label>
        <label style={{ fontSize: '.8rem' }}><input type="checkbox" checked={f.requiresApproval} onChange={e => setF({ ...f, requiresApproval: e.target.checked })} /> Require approval</label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Capacity"><input className="input" type="number" value={f.capacity} onChange={e => setF({ ...f, capacity: e.target.value })} /></Field>
        <Field label="Reservation fee ($)"><input className="input" type="number" value={f.reservationFee} onChange={e => setF({ ...f, reservationFee: e.target.value })} /></Field>
        <Field label="Weekend fee ($, optional)"><input className="input" type="number" placeholder="demand pricing" value={f.weekendFee} onChange={e => setF({ ...f, weekendFee: e.target.value })} /></Field>
        <Field label="Opens"><input className="input" type="time" value={f.openTime} onChange={e => setF({ ...f, openTime: e.target.value })} /></Field>
        <Field label="Closes"><input className="input" type="time" value={f.closeTime} onChange={e => setF({ ...f, closeTime: e.target.value })} /></Field>
        <Field label="Max hours / booking"><input className="input" type="number" value={f.maxReservationHours} onChange={e => setF({ ...f, maxReservationHours: e.target.value })} /></Field>
        <Field label="Book ahead (days)"><input className="input" type="number" value={f.advanceBookingDays} onChange={e => setF({ ...f, advanceBookingDays: e.target.value })} /></Field>
      </div>
      {m.isError && <div style={{ color: 'var(--danger,#e25)', fontSize: '.8rem' }}>Could not save.</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!f.name || m.isLoading} onClick={() => m.mutate()}>Create</button>
      </div>
    </Modal>
  )
}

// ── Landlord hold (private rental / closure / event) ──────────────────
function HoldModal({ area, onClose, onSaved }: { area: Area; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ kind: 'maintenance_closure', title: '', startsAt: '', endsAt: '', notifyResidents: true })
  const m = useMutation(
    () => apiPost(`/common-areas/${area.id}/reservations`, {
      kind: f.kind, title: f.title || undefined,
      startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString(),
      notifyResidents: f.notifyResidents,
    }),
    { onSuccess: onSaved })
  return (
    <Modal title={`Hold — ${area.name}`} onClose={onClose}>
      <Field label="Type">
        <select className="input" value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })}>
          <option value="maintenance_closure">Closure (maintenance / treatment)</option>
          <option value="private_rental">Private rental</option>
          <option value="event">Community event</option>
        </select>
      </Field>
      <Field label="Reason / title"><input className="input" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} placeholder="Chemical treatment" /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Starts"><input className="input" type="datetime-local" value={f.startsAt} onChange={e => setF({ ...f, startsAt: e.target.value })} /></Field>
        <Field label="Ends"><input className="input" type="datetime-local" value={f.endsAt} onChange={e => setF({ ...f, endsAt: e.target.value })} /></Field>
      </div>
      <label style={{ fontSize: '.8rem', display: 'block', margin: '8px 0' }}>
        <input type="checkbox" checked={f.notifyResidents} onChange={e => setF({ ...f, notifyResidents: e.target.checked })} /> Notify residents
      </label>
      {m.isError && <div style={{ color: 'var(--danger,#e25)', fontSize: '.8rem' }}>Could not save (time conflict?).</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!f.startsAt || !f.endsAt || m.isLoading} onClick={() => m.mutate()}>Create hold</button>
      </div>
    </Modal>
  )
}

// ── Reservations list + decide ────────────────────────────────────────
function ReservationsModal({ area, onClose }: { area: Area; onClose: () => void }) {
  const qc = useQueryClient()
  const key = ['area-reservations', area.id]
  const { data: rows = [] } = useQuery<Reservation[]>(key, () => apiGet<Reservation[]>(`/common-areas/${area.id}/reservations`))
  const decide = useMutation(
    (v: { id: string; approve: boolean }) => apiPost(`/common-areas/reservations/${v.id}/decide`, { approve: v.approve }),
    { onSuccess: () => qc.invalidateQueries(key) })
  const cancel = useMutation(
    (id: string) => apiPost(`/common-areas/reservations/${id}/cancel`, {}),
    { onSuccess: () => qc.invalidateQueries(key) })
  const sorted = useMemo(() => [...rows].sort((a, b) =>
    (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0)), [rows])

  return (
    <Modal title={`Reservations — ${area.name}`} onClose={onClose} wide>
      {!rows.length && <div style={{ color: 'var(--text-3)', padding: 12 }}>No reservations yet.</div>}
      <div style={{ display: 'grid', gap: 8 }}>
        {sorted.map(r => (
          <div key={r.id} className="card" style={{ padding: 12, display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 600 }}>
                {r.title || KIND_LABEL[r.kind]} <span className={`badge ${STATUS_BADGE[r.status]}`}>{r.status}</span>
                <span className="badge badge-muted" style={{ marginLeft: 4 }}>{KIND_LABEL[r.kind]}</span>
              </div>
              <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 2 }}>
                {fmt(r.startsAt)} → {fmt(r.endsAt)}
                {(r.tenantFirstName || r.tenantLastName) && ` · ${r.tenantFirstName ?? ''} ${r.tenantLastName ?? ''}`}
                {r.guestCount ? ` · ${r.guestCount} guests` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {r.status === 'pending' && <>
                <button className="btn btn-sm btn-primary" onClick={() => decide.mutate({ id: r.id, approve: true })}><Check size={13} /> Approve</button>
                <button className="btn btn-sm" onClick={() => decide.mutate({ id: r.id, approve: false })}><X size={13} /> Decline</button>
              </>}
              {r.status === 'approved' && <button className="btn btn-sm" onClick={() => cancel.mutate(r.id)}><Ban size={13} /> Cancel</button>}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}

// ── Shared modal primitives ───────────────────────────────────────────
function Modal({ title, children, onClose, wide }: { title: string; children: any; onClose: () => void; wide?: boolean }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'grid', placeItems: 'center', zIndex: 50 }} onClick={onClose}>
      <div className="card" style={{ width: wide ? 640 : 460, maxWidth: '92vw', maxHeight: '88vh', overflow: 'auto', padding: 20 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ fontSize: '1.1rem' }}>{title}</h2>
          <button className="btn btn-sm" onClick={onClose}><X size={15} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}
function Field({ label, children }: { label: string; children: any }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 3 }}>{label}</label>
      {children}
    </div>
  )
}
