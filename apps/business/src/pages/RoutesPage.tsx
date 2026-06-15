import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { Play, CheckCircle2, ChevronRight, ArrowLeft, Plus, MapPin, Smartphone } from 'lucide-react'

// ─────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────

interface VehicleRow {
  id: string
  name: string
  status: string
}

interface RouteListRow {
  id: string
  vehicleId: string
  vehicleName: string
  depotId: string
  depotName: string
  generatedForDate: string
  startAtPlanned: string
  status: 'generated' | 'in_progress' | 'completed'
  startedAt: string | null
  completedAt: string | null
  totalMiles: string | null
  totalMinutes: number | null
  stopCount: number
  dumpCount: number
  skippedUngeocodedCount: number
  createdAt: string
}

interface RouteStop {
  id: string
  sequenceOrder: number
  stopKind: 'customer' | 'dump' | 'depot_return'
  appointmentId: string | null
  dumpLocationId: string | null
  estimatedArrival: string | null
  estimatedDeparture: string | null
  actualArrival: string | null
  actualDeparture: string | null
  status: 'planned' | 'completed' | 'skipped'
  driverNotes: string | null
  firstName: string | null
  lastName: string | null
  companyName: string | null
  street1: string | null
  city: string | null
  state: string | null
  zip: string | null
  serviceType: string | null
  appointmentNotes: string | null
  dumpName: string | null
  dumpStreet1: string | null
  dumpCity: string | null
  dumpState: string | null
  dumpZip: string | null
}

interface RouteDetail {
  route: RouteListRow & { id: string }
  stops: RouteStop[]
}

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────

function todayLocalISODate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function fmtMiles(m: string | null): string {
  if (m === null) return '—'
  return `${Number(m).toFixed(1)} mi`
}

function fmtMinutes(min: number | null): string {
  if (min === null) return '—'
  const h = Math.floor(min / 60)
  const r = min % 60
  return h > 0 ? `${h}h ${r}m` : `${r}m`
}

// ─────────────────────────────────────────────────────────────
//  Component
// ─────────────────────────────────────────────────────────────

export function RoutesPage() {
  const [vehicles, setVehicles] = useState<VehicleRow[]>([])
  const [rows, setRows] = useState<RouteListRow[]>([])
  const [filterDate, setFilterDate] = useState(todayLocalISODate())
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const [showGen, setShowGen] = useState(false)
  const [genForm, setGenForm] = useState({
    vehicleId: '', date: todayLocalISODate(), time: '07:00',
  })
  const [generating, setGenerating] = useState(false)
  const [genResult, setGenResult] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RouteDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [stopActioning, setStopActioning] = useState<string | null>(null)

  const reload = async () => {
    setErr(null)
    try {
      const [vs, rs] = await Promise.all([
        apiGet<VehicleRow[]>('/vehicles'),
        apiGet<RouteListRow[]>(`/routes${filterDate ? `?date=${filterDate}` : ''}`),
      ])
      setVehicles(vs)
      setRows(rs)
      if (!genForm.vehicleId && vs.length > 0) {
        setGenForm(f => ({ ...f, vehicleId: vs[0].id }))
      }
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load routes')
    } finally { setLoading(false) }
  }

  useEffect(() => { reload() }, [filterDate])

  const loadDetail = async (id: string) => {
    setSelectedId(id); setDetail(null); setDetailLoading(true); setErr(null)
    try {
      const d = await apiGet<RouteDetail>(`/routes/${id}`)
      setDetail(d)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load route detail')
    } finally { setDetailLoading(false) }
  }

  const onGenerate = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setGenResult(null); setGenerating(true)
    try {
      // Combine date + time into local-ISO datetime so the backend
      // accepts it as a full ISO datetime string.
      const startAt = new Date(`${genForm.date}T${genForm.time}:00`).toISOString()
      const env = await apiPost<{ id: string; stopCount: number; dumpCount: number; skippedUngeocodedCount: number }>(
        '/routes/generate',
        {
          vehicleId: genForm.vehicleId,
          date:      genForm.date,
          startAt,
        },
      )
      const res = env.data
      setGenResult(`Generated · ${res.stopCount} stops, ${res.dumpCount} dumps`
        + (res.skippedUngeocodedCount > 0
            ? ` · ${res.skippedUngeocodedCount} customer(s) skipped (no coordinates)`
            : ''))
      setShowGen(false)
      // Filter to the date we just generated so the new route is visible.
      if (filterDate !== genForm.date) setFilterDate(genForm.date)
      else await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Generate failed')
    } finally { setGenerating(false) }
  }

  const onStart = async (id: string) => {
    setErr(null)
    try {
      await apiPost(`/routes/${id}/start`)
      await loadDetail(id)
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Start failed')
    }
  }

  const onComplete = async (id: string) => {
    setErr(null)
    try {
      await apiPost(`/routes/${id}/complete`)
      await loadDetail(id)
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Complete failed')
    }
  }

  const onStopComplete = async (stopId: string) => {
    if (!selectedId) return
    setStopActioning(stopId); setErr(null)
    try {
      await apiPost(`/routes/${selectedId}/stops/${stopId}/complete`)
      await loadDetail(selectedId)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Stop update failed')
    } finally { setStopActioning(null) }
  }

  const onStopSkip = async (stopId: string) => {
    if (!selectedId) return
    const reason = window.prompt('Reason for skipping this stop?')
    if (!reason) return
    setStopActioning(stopId); setErr(null)
    try {
      await apiPost(`/routes/${selectedId}/stops/${stopId}/skip`, { driverNotes: reason })
      await loadDetail(selectedId)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Skip failed')
    } finally { setStopActioning(null) }
  }

  // ─── Gated empty state ──────────────────────────────────────
  if (!loading && vehicles.length === 0) {
    return (
      <div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, marginTop: 0 }}>Routes</h1>
        <div style={emptyStyle}>
          Add a <strong style={{ color: 'var(--gold)' }}>vehicle</strong> first
          — routes are generated per vehicle per day.
        </div>
      </div>
    )
  }

  // ─── Detail view ────────────────────────────────────────────
  if (selectedId) {
    return (
      <RouteDetailView
        loading={detailLoading}
        detail={detail}
        err={err}
        stopActioning={stopActioning}
        onBack={() => { setSelectedId(null); setDetail(null) }}
        onStart={() => onStart(selectedId)}
        onComplete={() => onComplete(selectedId)}
        onStopComplete={onStopComplete}
        onStopSkip={onStopSkip}
      />
    )
  }

  // ─── List view ──────────────────────────────────────────────
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, margin: 0 }}>Routes</h1>
        <button onClick={() => setShowGen(v => !v)} style={genBtnStyle}>
          <Plus size={14} />
          {showGen ? 'Cancel' : 'Generate route'}
        </button>
      </div>

      <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 16 }}>
        Daily route plans per vehicle. Generate creates the optimized
        stop sequence from today's appointments; the driver works the
        list from the truck.
      </div>

      {err && <div style={errStyle}>{err}</div>}
      {genResult && <div style={okStyle}>{genResult}</div>}

      {showGen && (
        <form onSubmit={onGenerate} style={genFormStyle}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 12, alignItems: 'end' }}>
            <div>
              <label style={labelStyle}>Vehicle</label>
              <select value={genForm.vehicleId}
                onChange={e => setGenForm({ ...genForm, vehicleId: e.target.value })}
                required style={inputStyle}>
                {vehicles.map(v => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Date</label>
              <input type="date" value={genForm.date}
                onChange={e => setGenForm({ ...genForm, date: e.target.value })}
                required style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Start time</label>
              <input type="time" value={genForm.time}
                onChange={e => setGenForm({ ...genForm, time: e.target.value })}
                required style={inputStyle} />
            </div>
            <button type="submit" disabled={generating}
              style={{ ...btnStyle, marginTop: 0, opacity: generating ? 0.6 : 1, width: 'auto', padding: '10px 16px' }}>
              {generating ? 'Generating…' : 'Generate'}
            </button>
          </div>
        </form>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0' }}>
        <label style={{ ...labelStyle, marginTop: 0, marginBottom: 0 }}>Date</label>
        <input type="date" value={filterDate}
          onChange={e => setFilterDate(e.target.value)}
          style={{ ...inputStyle, width: 'auto' }} />
        <button onClick={() => setFilterDate(todayLocalISODate())}
          style={todayBtnStyle}>Today</button>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-2)' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={emptyStyle}>
          No routes for this date. Click "Generate route" above to create one.
        </div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
              <th style={thStyle}>Vehicle</th>
              <th style={thStyle}>Start</th>
              <th style={thStyle}>Stops</th>
              <th style={thStyle}>Distance</th>
              <th style={thStyle}>Time</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}
                onClick={() => loadDetail(r.id)}
                style={{ borderBottom: '1px solid var(--border-0)', cursor: 'pointer' }}>
                <td style={tdStyle}>
                  <strong>{r.vehicleName}</strong>
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                    {r.depotName}
                  </div>
                </td>
                <td style={tdStyle}>{fmtTime(r.startAtPlanned)}</td>
                <td style={tdStyle}>
                  {r.stopCount} <span style={{ color: 'var(--text-3)' }}>· {r.dumpCount} dumps</span>
                  {r.skippedUngeocodedCount > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--amber)' }}>
                      {r.skippedUngeocodedCount} skipped (no coords)
                    </div>
                  )}
                </td>
                <td style={tdStyle}>{fmtMiles(r.totalMiles)}</td>
                <td style={tdStyle}>{fmtMinutes(r.totalMinutes)}</td>
                <td style={tdStyle}><StatusBadge status={r.status} /></td>
                <td style={tdStyle}><ChevronRight size={16} color="var(--text-3)" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
//  Detail view
// ─────────────────────────────────────────────────────────────

function RouteDetailView({
  loading, detail, err, stopActioning,
  onBack, onStart, onComplete, onStopComplete, onStopSkip,
}: {
  loading: boolean
  detail: RouteDetail | null
  err: string | null
  stopActioning: string | null
  onBack: () => void
  onStart: () => void
  onComplete: () => void
  onStopComplete: (stopId: string) => void
  onStopSkip: (stopId: string) => void
}) {
  if (loading || !detail) {
    return (
      <div>
        <button onClick={onBack} style={backBtnStyle}><ArrowLeft size={14} /> Back</button>
        {err && <div style={errStyle}>{err}</div>}
        <div style={{ color: 'var(--text-2)' }}>Loading…</div>
      </div>
    )
  }

  const { route, stops } = detail
  const finalized = stops.filter(s => s.status !== 'planned').length
  const allDone = stops.length > 0 && finalized === stops.length

  return (
    <div>
      <button onClick={onBack} style={backBtnStyle}><ArrowLeft size={14} /> Back to routes</button>

      {err && <div style={errStyle}>{err}</div>}

      <div style={headerCardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, margin: 0 }}>
              {route.vehicleName}
            </h1>
            <div style={{ color: 'var(--text-2)', fontSize: 13, marginTop: 4 }}>
              {route.depotName} · {route.generatedForDate} · planned start {fmtTime(route.startAtPlanned)}
            </div>
          </div>
          <StatusBadge status={route.status} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginTop: 20 }}>
          <Metric label="Stops"    value={String(route.stopCount)} />
          <Metric label="Dumps"    value={String(route.dumpCount)} />
          <Metric label="Distance" value={fmtMiles(route.totalMiles)} />
          <Metric label="Drive + service" value={fmtMinutes(route.totalMinutes)} />
        </div>

        {route.skippedUngeocodedCount > 0 && (
          <div style={{ ...warnStyle, marginTop: 16 }}>
            {route.skippedUngeocodedCount} appointment(s) skipped because
            the customer address has no coordinates. Backfill on the
            Customers page; affected appointments will appear on the
            next generation.
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
          {route.status === 'generated' && (
            <button onClick={onStart} style={primaryBtnStyle}>
              <Play size={14} /> Start route
            </button>
          )}
          {route.status === 'in_progress' && (
            <button
              onClick={onComplete}
              disabled={!allDone}
              title={allDone ? '' : 'Finish or skip every stop first'}
              style={{ ...primaryBtnStyle, opacity: allDone ? 1 : 0.5, cursor: allDone ? 'pointer' : 'not-allowed' }}>
              <CheckCircle2 size={14} /> Complete route
            </button>
          )}
          {route.status === 'completed' && (
            <div style={{ color: 'var(--text-2)', fontSize: 13 }}>
              Completed {fmtTime(route.completedAt)}
            </div>
          )}
          <Link to={`/drive/${route.id}`}
            style={{ ...primaryBtnStyle,
              background: 'var(--bg-2)', color: 'var(--gold)',
              border: '1px solid var(--gold)', textDecoration: 'none' }}>
            <Smartphone size={14} /> Driver view
          </Link>
        </div>
      </div>

      <h2 style={{ ...h2Style, marginTop: 32 }}>Stops</h2>
      {stops.length === 0 ? (
        <div style={emptyStyle}>No stops on this route.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {stops.map(s => (
            <StopCard
              key={s.id}
              stop={s}
              routeStatus={route.status}
              actioning={stopActioning === s.id}
              onComplete={() => onStopComplete(s.id)}
              onSkip={() => onStopSkip(s.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function StopCard({ stop, routeStatus, actioning, onComplete, onSkip }: {
  stop: RouteStop
  routeStatus: 'generated' | 'in_progress' | 'completed'
  actioning: boolean
  onComplete: () => void
  onSkip: () => void
}) {
  const kindBadge = stop.stopKind === 'customer'
    ? { label: 'CUSTOMER', color: 'var(--gold)' }
    : stop.stopKind === 'dump'
    ? { label: 'DUMP',     color: 'var(--text-2)' }
    : { label: 'RETURN',   color: 'var(--text-3)' }

  const title = stop.stopKind === 'customer'
    ? (stop.companyName
        ? stop.companyName
        : `${stop.firstName ?? ''} ${stop.lastName ?? ''}`.trim())
    : stop.stopKind === 'dump'
    ? stop.dumpName
    : 'Return to depot'

  const address = stop.stopKind === 'customer'
    ? (stop.street1 ? `${stop.street1}, ${stop.city}, ${stop.state} ${stop.zip}` : null)
    : stop.stopKind === 'dump' && stop.dumpStreet1
    ? `${stop.dumpStreet1}, ${stop.dumpCity}, ${stop.dumpState} ${stop.dumpZip}`
    : null

  return (
    <div style={{
      ...stopCardStyle,
      opacity: stop.status === 'skipped' ? 0.55 : 1,
      borderLeft: `3px solid ${
        stop.status === 'completed' ? 'var(--green, #4ade80)'
        : stop.status === 'skipped' ? 'var(--amber)'
        : 'var(--border-1)'
      }`,
    }}>
      <div style={{ display: 'flex', alignItems: 'start', gap: 12 }}>
        <div style={{
          minWidth: 32, height: 32, borderRadius: 8,
          background: 'var(--bg-2)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--gold)', fontWeight: 700, fontSize: 13,
        }}>{stop.sequenceOrder}</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: 1.2,
              color: kindBadge.color,
            }}>{kindBadge.label}</span>
            {stop.status === 'completed' && (
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--green, #4ade80)' }}>· DONE</span>
            )}
            {stop.status === 'skipped' && (
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--amber)' }}>· SKIPPED</span>
            )}
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>
            {title || '—'}
          </div>
          {address && (
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
              <MapPin size={11} /> {address}
            </div>
          )}
          {stop.serviceType && (
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
              {stop.serviceType}
            </div>
          )}
          {stop.appointmentNotes && (
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4, fontStyle: 'italic' }}>
              "{stop.appointmentNotes}"
            </div>
          )}
          {stop.driverNotes && (
            <div style={{ fontSize: 12, color: 'var(--amber)', marginTop: 4 }}>
              Driver note: {stop.driverNotes}
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
            ETA {fmtTime(stop.estimatedArrival)}
            {stop.estimatedDeparture && ` → ${fmtTime(stop.estimatedDeparture)}`}
            {stop.actualArrival && (
              <span style={{ marginLeft: 12, color: 'var(--green, #4ade80)' }}>
                actual {fmtTime(stop.actualArrival)}
              </span>
            )}
          </div>
        </div>

        {routeStatus === 'in_progress' && stop.status === 'planned' && stop.stopKind !== 'depot_return' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button onClick={onComplete} disabled={actioning} style={stopActionPrimary}>
              {actioning ? '…' : 'Complete'}
            </button>
            <button onClick={onSkip} disabled={actioning} style={stopActionSecondary}>
              Skip
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-0)' }}>{value}</div>
    </div>
  )
}

function StatusBadge({ status }: { status: 'generated' | 'in_progress' | 'completed' }) {
  const cfg = {
    generated:   { label: 'Ready',       color: 'var(--text-2)' },
    in_progress: { label: 'In progress', color: 'var(--gold)' },
    completed:   { label: 'Completed',   color: 'var(--green, #4ade80)' },
  }[status]
  return (
    <span style={{
      display: 'inline-block', padding: '4px 10px', borderRadius: 6,
      fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
      color: cfg.color, background: 'var(--bg-2)', border: '1px solid var(--border-1)',
    }}>{cfg.label}</span>
  )
}

// ─────────────────────────────────────────────────────────────
//  Styles
// ─────────────────────────────────────────────────────────────

const h2Style: React.CSSProperties = {
  fontFamily: 'var(--font-body)', fontSize: 18, marginTop: 0, marginBottom: 12,
}
const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse',
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, overflow: 'hidden',
}
const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '12px 16px', fontSize: 12,
  color: 'var(--text-2)', textTransform: 'uppercase',
  letterSpacing: 1, background: 'var(--bg-2)',
}
const tdStyle: React.CSSProperties = {
  padding: '14px 16px', fontSize: 14, color: 'var(--text-1)',
}
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, color: 'var(--text-2)',
  marginBottom: 6, marginTop: 0,
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 14, boxSizing: 'border-box',
}
const btnStyle: React.CSSProperties = {
  width: '100%', padding: '12px',
  background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 8,
  fontSize: 14, fontWeight: 600, marginTop: 20, cursor: 'pointer',
}
const genBtnStyle: React.CSSProperties = {
  padding: '8px 12px', background: 'var(--gold-bg)', color: 'var(--gold)',
  border: '1px solid var(--gold)', borderRadius: 8, fontSize: 13, fontWeight: 600,
  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
}
const todayBtnStyle: React.CSSProperties = {
  padding: '8px 12px', background: 'var(--bg-2)', color: 'var(--text-1)',
  border: '1px solid var(--border-1)', borderRadius: 8, fontSize: 13,
  cursor: 'pointer',
}
const errStyle: React.CSSProperties = {
  marginBottom: 16, padding: '10px 12px',
  background: 'var(--red-bg)', color: 'var(--red)',
  border: '1px solid var(--red-dim)', borderRadius: 8, fontSize: 13,
}
const okStyle: React.CSSProperties = {
  marginBottom: 16, padding: '10px 12px',
  background: 'var(--gold-bg)', color: 'var(--gold)',
  border: '1px solid var(--gold)', borderRadius: 8, fontSize: 13,
}
const warnStyle: React.CSSProperties = {
  padding: '10px 12px',
  background: 'var(--amber-bg)', color: 'var(--amber)',
  border: '1px solid var(--amber)', borderRadius: 8, fontSize: 13,
}
const emptyStyle: React.CSSProperties = {
  padding: 32, textAlign: 'center',
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, color: 'var(--text-2)', fontSize: 14,
}
const genFormStyle: React.CSSProperties = {
  padding: 16, background: 'var(--bg-1)',
  border: '1px solid var(--border-0)', borderRadius: 12, marginBottom: 16,
}
const headerCardStyle: React.CSSProperties = {
  padding: 20, background: 'var(--bg-1)',
  border: '1px solid var(--border-0)', borderRadius: 12, marginTop: 16,
}
const stopCardStyle: React.CSSProperties = {
  padding: 14, background: 'var(--bg-1)',
  border: '1px solid var(--border-0)', borderRadius: 10,
}
const backBtnStyle: React.CSSProperties = {
  padding: '6px 10px', background: 'transparent', color: 'var(--text-2)',
  border: '1px solid var(--border-1)', borderRadius: 6,
  fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
  marginBottom: 16,
}
const primaryBtnStyle: React.CSSProperties = {
  padding: '10px 16px', background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600,
  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
}
const stopActionPrimary: React.CSSProperties = {
  padding: '6px 12px', background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600,
  cursor: 'pointer',
}
const stopActionSecondary: React.CSSProperties = {
  padding: '6px 12px', background: 'var(--bg-2)', color: 'var(--text-2)',
  border: '1px solid var(--border-1)', borderRadius: 6, fontSize: 12,
  cursor: 'pointer',
}
