import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Zap, Plus, X, CheckCircle, Ban } from 'lucide-react'
import { SERVICE_INTERRUPTION_TYPES, SERVICE_INTERRUPTION_TYPE_LABELS } from '@gam/shared'
import { apiGet, apiPost } from '../lib/api'

// Responses camelCased by the landlord axios client.
type Property = { id: string; name: string }
type Unit = { id: string; unitNumber: string; propertyId: string }
type Notice = {
  id: string; utilityType: string; title: string | null; message: string | null
  isEmergency: boolean; startsAt: string; expectedRestoreAt: string | null
  status: 'scheduled' | 'active' | 'resolved' | 'cancelled'; unitIds: string[]
}

const STATUS_BADGE: Record<string, string> = {
  active: 'badge-red', scheduled: 'badge-amber', resolved: 'badge-green', cancelled: 'badge-muted',
}
const lbl = (t: string) => (SERVICE_INTERRUPTION_TYPE_LABELS as Record<string, string>)[t] ?? t
const fmt = (s: string | null) => s ? new Date(s).toLocaleString(undefined,
  { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null

export function ServiceInterruptionsPanel() {
  const qc = useQueryClient()
  const { data: properties = [] } = useQuery<Property[]>('properties-min', () => apiGet<Property[]>('/properties'))
  const [propertyId, setPropertyId] = useState('')
  const pid = propertyId || properties[0]?.id || ''
  const { data: notices = [] } = useQuery<Notice[]>(
    ['service-interruptions', pid], () => apiGet<Notice[]>(`/service-interruptions?propertyId=${pid}`), { enabled: !!pid })
  const [showPost, setShowPost] = useState(false)

  const resolve = useMutation(
    (v: { id: string; allClear: boolean }) => apiPost(`/service-interruptions/${v.id}/resolve`, { sendAllClear: v.allClear }),
    { onSuccess: () => qc.invalidateQueries(['service-interruptions', pid]) })
  const cancel = useMutation(
    (id: string) => apiPost(`/service-interruptions/${id}/cancel`, {}),
    { onSuccess: () => qc.invalidateQueries(['service-interruptions', pid]) })

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Zap size={20} /> Outage Notices
          </h1>
          <div className="page-sub">
            Tell residents a utility is down — water, power, gas, elevator — with an expected-back
            time. Posts immediately notify every affected resident (SMS too, for emergencies).
          </div>
        </div>
        <button className="btn btn-primary" disabled={!pid} onClick={() => setShowPost(true)}>
          <Plus size={15} /> Post Outage Notice
        </button>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Property</label>
        <select className="input" style={{ minWidth: 240 }} value={pid} onChange={e => setPropertyId(e.target.value)}>
          {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {!notices.length && (
        <div className="card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-3)' }}>
          No outage notices for this property.
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {notices.map(n => (
          <div key={n.id} className="card" style={{ padding: 14, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontWeight: 700 }}>
                {n.isEmergency && '🚨 '}{lbl(n.utilityType)}{n.title ? ` — ${n.title}` : ''}{' '}
                <span className={`badge ${STATUS_BADGE[n.status]}`}>{n.status}</span>
                {n.unitIds.length > 0 && <span className="badge badge-muted" style={{ marginLeft: 4 }}>{n.unitIds.length} unit{n.unitIds.length > 1 ? 's' : ''}</span>}
              </div>
              {n.message && <div className="page-sub" style={{ marginTop: 3 }}>{n.message}</div>}
              <div style={{ fontSize: '.76rem', color: 'var(--text-3)', marginTop: 5 }}>
                {fmt(n.startsAt)}{n.expectedRestoreAt ? ` → expected back ${fmt(n.expectedRestoreAt)}` : ' → until further notice'}
              </div>
            </div>
            {(n.status === 'active' || n.status === 'scheduled') && (
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button className="btn btn-sm btn-primary" disabled={resolve.isLoading} onClick={() => resolve.mutate({ id: n.id, allClear: true })}>
                  <CheckCircle size={13} /> Resolve + all-clear
                </button>
                <button className="btn btn-sm" disabled={resolve.isLoading} onClick={() => resolve.mutate({ id: n.id, allClear: false })}>Resolve</button>
                <button className="btn btn-sm" disabled={cancel.isLoading} onClick={() => cancel.mutate(n.id)}><Ban size={13} /></button>
              </div>
            )}
          </div>
        ))}
      </div>

      {showPost && pid && (
        <PostModal propertyId={pid} onClose={() => setShowPost(false)}
          onPosted={() => { setShowPost(false); qc.invalidateQueries(['service-interruptions', pid]) }} />
      )}
    </div>
  )
}

function PostModal({ propertyId, onClose, onPosted }: { propertyId: string; onClose: () => void; onPosted: () => void }) {
  const { data: units = [] } = useQuery<Unit[]>('units', () => apiGet<Unit[]>('/units'))
  const propUnits = useMemo(() => units.filter(u => u.propertyId === propertyId), [units, propertyId])
  const [f, setF] = useState({
    utilityType: 'water', isEmergency: true, title: '', message: '',
    scheduled: false, startsAt: '', expectedRestoreAt: '',
    wholeProperty: true, unitIds: [] as string[],
  })
  const m = useMutation(
    () => apiPost('/service-interruptions', {
      propertyId, utilityType: f.utilityType, isEmergency: f.isEmergency,
      title: f.title || undefined, message: f.message || undefined,
      unitIds: f.wholeProperty ? [] : f.unitIds,
      startsAt: f.scheduled && f.startsAt ? new Date(f.startsAt).toISOString() : undefined,
      expectedRestoreAt: f.expectedRestoreAt ? new Date(f.expectedRestoreAt).toISOString() : null,
    }),
    { onSuccess: onPosted })
  const toggleUnit = (id: string) => setF(s => ({
    ...s, unitIds: s.unitIds.includes(id) ? s.unitIds.filter(x => x !== id) : [...s.unitIds, id],
  }))

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'grid', placeItems: 'center', zIndex: 50 }} onClick={onClose}>
      <div className="card" style={{ width: 480, maxWidth: '92vw', maxHeight: '88vh', overflow: 'auto', padding: 20 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ fontSize: '1.1rem' }}>Post outage notice</h2>
          <button className="btn btn-sm" onClick={onClose}><X size={15} /></button>
        </div>

        <Row label="Utility">
          <select className="input" value={f.utilityType} onChange={e => setF({ ...f, utilityType: e.target.value })}>
            {SERVICE_INTERRUPTION_TYPES.map(t => <option key={t} value={t}>{lbl(t)}</option>)}
          </select>
        </Row>
        <label style={{ fontSize: '.82rem', display: 'block', margin: '8px 0' }}>
          <input type="checkbox" checked={f.isEmergency} onChange={e => setF({ ...f, isEmergency: e.target.checked })} /> Emergency / unplanned (urgent copy + SMS)
        </label>
        <Row label="Headline"><input className="input" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} placeholder="Water main repair" /></Row>
        <Row label="Message (optional)"><input className="input" value={f.message} onChange={e => setF({ ...f, message: e.target.value })} placeholder="Please store water for the morning." /></Row>

        <label style={{ fontSize: '.82rem', display: 'block', margin: '8px 0' }}>
          <input type="checkbox" checked={f.scheduled} onChange={e => setF({ ...f, scheduled: e.target.checked })} /> Scheduled for later (otherwise starts now)
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {f.scheduled && <Row label="Starts"><input className="input" type="datetime-local" value={f.startsAt} onChange={e => setF({ ...f, startsAt: e.target.value })} /></Row>}
          <Row label="Expected back (optional)"><input className="input" type="datetime-local" value={f.expectedRestoreAt} onChange={e => setF({ ...f, expectedRestoreAt: e.target.value })} /></Row>
        </div>

        <label style={{ fontSize: '.82rem', display: 'block', margin: '8px 0' }}>
          <input type="checkbox" checked={f.wholeProperty} onChange={e => setF({ ...f, wholeProperty: e.target.checked })} /> Whole property
        </label>
        {!f.wholeProperty && (
          <div style={{ maxHeight: 140, overflow: 'auto', border: '1px solid var(--border-0)', borderRadius: 8, padding: 8 }}>
            {propUnits.map(u => (
              <label key={u.id} style={{ display: 'block', fontSize: '.8rem', padding: '2px 0' }}>
                <input type="checkbox" checked={f.unitIds.includes(u.id)} onChange={() => toggleUnit(u.id)} /> Unit {u.unitNumber}
              </label>
            ))}
          </div>
        )}

        {m.isError && <div style={{ color: 'var(--danger,#e25)', fontSize: '.8rem', marginTop: 8 }}>Could not post.</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary"
            disabled={m.isLoading || (f.scheduled && !f.startsAt) || (!f.wholeProperty && f.unitIds.length === 0)}
            onClick={() => m.mutate()}>Post + notify</button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: any }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 3 }}>{label}</label>
      {children}
    </div>
  )
}
