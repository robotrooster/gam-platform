import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import {
  ArrowLeft, Check, X, MapPin, Phone, Navigation,
  CheckCircle2, Play, Clock,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────
//  Types (mirror the camelCase shape from /api/routes/:id)
// ─────────────────────────────────────────────────────────────

interface RouteHeader {
  id: string
  vehicleName: string
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
  email: string | null
  phone: string | null
  street1: string | null
  city: string | null
  state: string | null
  zip: string | null
  customerLat: string | null
  customerLon: string | null
  serviceType: string | null
  appointmentNotes: string | null
  dumpName: string | null
  dumpStreet1: string | null
  dumpCity: string | null
  dumpState: string | null
  dumpZip: string | null
  dumpLat: string | null
  dumpLon: string | null
}

interface RouteDetail {
  route: RouteHeader
  stops: RouteStop[]
}

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Cross-platform deep link to driving directions. iOS Maps and
 *  Google Maps both accept the apple.com / google.com URL forms;
 *  Google's `/dir/?api=1&destination=` is the most reliable
 *  cross-platform anchor (iOS users get a "Open in" picker; Android
 *  users get Google Maps directly). */
function mapsUrl(lat: string | null, lon: string | null, label?: string): string | null {
  if (lat === null || lon === null) return null
  const dest = `${lat},${lon}`
  const q = label ? `&destination_place_id=${encodeURIComponent(label)}` : ''
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}${q}`
}

// ─────────────────────────────────────────────────────────────
//  Component
// ─────────────────────────────────────────────────────────────

export function DriverPage() {
  const { routeId } = useParams<{ routeId: string }>()
  const navigate = useNavigate()
  const [detail, setDetail] = useState<RouteDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [actioning, setActioning] = useState(false)
  const [showSkipPrompt, setShowSkipPrompt] = useState(false)
  const [skipReason, setSkipReason] = useState('')

  const reload = async () => {
    if (!routeId) return
    setErr(null)
    try {
      const d = await apiGet<RouteDetail>(`/routes/${routeId}`)
      setDetail(d)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load route')
    } finally { setLoading(false) }
  }

  useEffect(() => { reload() }, [routeId])

  const currentIdx = (() => {
    if (!detail) return -1
    // The active stop is the first one still planned.
    return detail.stops.findIndex(s => s.status === 'planned')
  })()
  const current = currentIdx >= 0 && detail ? detail.stops[currentIdx] : null
  const remainingPlanned = detail?.stops.filter(s => s.status === 'planned').length ?? 0
  const completedCount = detail?.stops.filter(s => s.status === 'completed').length ?? 0
  const skippedCount = detail?.stops.filter(s => s.status === 'skipped').length ?? 0
  const allFinalized = detail !== null && remainingPlanned === 0 && detail.stops.length > 0

  const onStart = async () => {
    if (!routeId) return
    setActioning(true); setErr(null)
    try {
      await apiPost(`/routes/${routeId}/start`)
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Start failed')
    } finally { setActioning(false) }
  }

  const onComplete = async (stopId: string) => {
    if (!routeId) return
    setActioning(true); setErr(null)
    try {
      await apiPost(`/routes/${routeId}/stops/${stopId}/complete`)
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Mark-complete failed')
    } finally { setActioning(false) }
  }

  const onSkipConfirm = async () => {
    if (!routeId || !current) return
    if (!skipReason.trim()) {
      setErr('Skip reason required')
      return
    }
    setActioning(true); setErr(null)
    try {
      await apiPost(`/routes/${routeId}/stops/${current.id}/skip`, { driverNotes: skipReason.trim() })
      setShowSkipPrompt(false)
      setSkipReason('')
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Skip failed')
    } finally { setActioning(false) }
  }

  const onCompleteRoute = async () => {
    if (!routeId) return
    setActioning(true); setErr(null)
    try {
      await apiPost(`/routes/${routeId}/complete`)
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Complete route failed')
    } finally { setActioning(false) }
  }

  if (loading) {
    return <Shell><div style={loadingStyle}>Loading route…</div></Shell>
  }
  if (!detail) {
    return (
      <Shell>
        <div style={loadingStyle}>{err || 'Route not found'}</div>
        <button onClick={() => navigate('/routes')} style={ghostBtn}>
          <ArrowLeft size={16} /> Back to routes
        </button>
      </Shell>
    )
  }

  const { route, stops } = detail

  // ─── Top bar — common to every state ────────────────────────
  const TopBar = (
    <div style={topBarStyle}>
      <button onClick={() => navigate(`/routes`)} style={topBackBtn}
        aria-label="Back to routes list">
        <ArrowLeft size={20} />
      </button>
      <div style={{ flex: 1, textAlign: 'center' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-0)' }}>{route.vehicleName}</div>
        <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
          {route.generatedForDate}
        </div>
      </div>
      <div style={{ width: 40 }} />
    </div>
  )

  // ─── State 1: route not started — give driver a Start CTA ────
  if (route.status === 'generated') {
    return (
      <Shell>
        {TopBar}
        <div style={centeredPanel}>
          <div style={{ fontSize: 14, color: 'var(--text-2)', marginBottom: 6 }}>
            Planned start
          </div>
          <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--text-0)', marginBottom: 24 }}>
            {fmtTime(route.startAtPlanned)}
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 24, marginBottom: 32, color: 'var(--text-2)', fontSize: 13 }}>
            <span><strong style={{ color: 'var(--gold)' }}>{route.stopCount}</strong> stops</span>
            <span><strong style={{ color: 'var(--gold)' }}>{route.dumpCount}</strong> dumps</span>
          </div>
          {err && <div style={errStyle}>{err}</div>}
          <button onClick={onStart} disabled={actioning} style={bigPrimaryBtn}>
            <Play size={20} />
            {actioning ? 'Starting…' : 'Start route'}
          </button>
        </div>
      </Shell>
    )
  }

  // ─── State 2: route completed — recap ────────────────────────
  if (route.status === 'completed') {
    return (
      <Shell>
        {TopBar}
        <div style={centeredPanel}>
          <CheckCircle2 size={64} color="var(--gold)" style={{ marginBottom: 16 }} />
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-0)', marginBottom: 8 }}>
            Route complete
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-2)', marginBottom: 32 }}>
            Finished {fmtTime(route.completedAt)}
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 24, marginBottom: 32 }}>
            <Tile label="Completed"  value={completedCount} color="var(--gold)" />
            <Tile label="Skipped"    value={skippedCount}   color={skippedCount > 0 ? 'var(--amber)' : 'var(--text-2)'} />
          </div>
          <button onClick={() => navigate('/routes')} style={ghostBtn}>
            <ArrowLeft size={16} /> Back to routes
          </button>
        </div>
      </Shell>
    )
  }

  // ─── State 3: all stops finalized but route not yet completed — wrap-up ──
  if (allFinalized) {
    return (
      <Shell>
        {TopBar}
        <div style={centeredPanel}>
          <CheckCircle2 size={56} color="var(--gold)" style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-0)', marginBottom: 8 }}>
            All stops finalized
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 24 }}>
            {completedCount} completed{skippedCount > 0 && ` · ${skippedCount} skipped`}
          </div>
          {err && <div style={errStyle}>{err}</div>}
          <button onClick={onCompleteRoute} disabled={actioning} style={bigPrimaryBtn}>
            <CheckCircle2 size={20} />
            {actioning ? 'Finishing…' : 'Complete route'}
          </button>
        </div>
      </Shell>
    )
  }

  // ─── State 4: in_progress with current stop — the main driving view ──
  if (!current) {
    // Defensive: in_progress but no planned stop and not all-finalized
    // is a logic gap. Fall back to a safe message.
    return (
      <Shell>
        {TopBar}
        <div style={loadingStyle}>No active stop. Reload?</div>
      </Shell>
    )
  }

  const isCustomer = current.stopKind === 'customer'
  const isDump = current.stopKind === 'dump'
  const isReturn = current.stopKind === 'depot_return'

  const title = isCustomer
    ? (current.companyName
        ? current.companyName
        : `${current.firstName ?? ''} ${current.lastName ?? ''}`.trim())
    : isDump
    ? current.dumpName
    : 'Return to depot'

  const address = isCustomer && current.street1
    ? `${current.street1}, ${current.city}, ${current.state} ${current.zip}`
    : isDump && current.dumpStreet1
    ? `${current.dumpStreet1}, ${current.dumpCity}, ${current.dumpState} ${current.dumpZip}`
    : null

  const lat = isCustomer ? current.customerLat : isDump ? current.dumpLat : null
  const lon = isCustomer ? current.customerLon : isDump ? current.dumpLon : null
  const directions = mapsUrl(lat, lon, title ?? undefined)

  const stopNumDisplay = currentIdx + 1
  const totalStops = stops.length

  return (
    <Shell>
      {TopBar}

      {/* Progress strip */}
      <div style={progressStripStyle}>
        <span style={{ fontWeight: 700, color: 'var(--gold)' }}>Stop {stopNumDisplay}</span>
        <span style={{ color: 'var(--text-3)' }}> of {totalStops}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-2)' }}>
          {completedCount} done · {remainingPlanned} left
        </span>
      </div>

      {err && <div style={errStyle}>{err}</div>}

      {/* Stop card */}
      <div style={stopCardStyle}>
        <div style={kindBadgeStyle(current.stopKind)}>
          {isCustomer ? 'CUSTOMER' : isDump ? 'DUMP' : 'RETURN TO DEPOT'}
        </div>
        <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-0)', marginBottom: 8 }}>
          {title || '—'}
        </div>
        {current.serviceType && (
          <div style={{ fontSize: 14, color: 'var(--gold)', marginBottom: 12, fontWeight: 600 }}>
            {current.serviceType}
          </div>
        )}
        {address && (
          <div style={{ display: 'flex', alignItems: 'start', gap: 8, marginBottom: 14, color: 'var(--text-1)' }}>
            <MapPin size={16} style={{ marginTop: 2, flexShrink: 0 }} />
            <div style={{ fontSize: 15 }}>{address}</div>
          </div>
        )}
        {isCustomer && current.phone && (
          <a href={`tel:${current.phone}`} style={contactLink}>
            <Phone size={16} /> {current.phone}
          </a>
        )}
        {current.appointmentNotes && (
          <div style={notesBoxStyle}>
            <div style={{ fontSize: 10, color: 'var(--text-3)', letterSpacing: 1, marginBottom: 4 }}>NOTES</div>
            <div style={{ fontSize: 14, color: 'var(--text-1)', fontStyle: 'italic' }}>
              "{current.appointmentNotes}"
            </div>
          </div>
        )}
        <div style={etaRowStyle}>
          <Clock size={14} />
          ETA {fmtTime(current.estimatedArrival)}
        </div>
        {directions && (
          <a href={directions} target="_blank" rel="noreferrer" style={directionsBtnStyle}>
            <Navigation size={18} /> Open in Maps
          </a>
        )}
      </div>

      {/* Action bar */}
      {!isReturn ? (
        <div style={actionBarStyle}>
          <button onClick={() => setShowSkipPrompt(true)}
            disabled={actioning} style={skipBtnStyle}>
            <X size={18} /> Skip
          </button>
          <button onClick={() => onComplete(current.id)}
            disabled={actioning} style={completeBtnStyle}>
            <Check size={18} /> {actioning ? 'Saving…' : 'Complete'}
          </button>
        </div>
      ) : (
        // Depot return is the last stop; completing the route ends it.
        // The driver doesn't "mark" the depot return — they hit Complete
        // route from the all-finalized state. Show a soft pointer.
        <div style={{ ...actionBarStyle, justifyContent: 'center' }}>
          <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
            Last stop — head back to {route.depotName}, then tap Complete route.
          </div>
        </div>
      )}

      {showSkipPrompt && (
        <div style={skipOverlayStyle} onClick={() => setShowSkipPrompt(false)}>
          <div onClick={e => e.stopPropagation()} style={skipPanelStyle}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
              Reason for skipping
            </div>
            <textarea
              value={skipReason}
              onChange={e => setSkipReason(e.target.value)}
              autoFocus
              rows={3}
              placeholder="Customer not home / blocked driveway / can't access bin…"
              style={textareaStyle}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={() => { setShowSkipPrompt(false); setSkipReason('') }}
                style={ghostBtn}>Cancel</button>
              <button onClick={onSkipConfirm}
                disabled={actioning || !skipReason.trim()}
                style={{ ...skipBtnStyle, flex: 1, opacity: (actioning || !skipReason.trim()) ? 0.6 : 1 }}>
                Confirm skip
              </button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  )
}

// ─────────────────────────────────────────────────────────────
//  Sub-components
// ─────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg-0)', color: 'var(--text-0)',
      display: 'flex', flexDirection: 'column',
      fontFamily: 'var(--font-body)',
    }}>
      {children}
    </div>
  )
}

function Tile({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color }}>{value}</div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
//  Styles
// ─────────────────────────────────────────────────────────────

const topBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '12px 14px', borderBottom: '1px solid var(--border-0)',
  background: 'var(--bg-1)', position: 'sticky', top: 0, zIndex: 5,
}
const topBackBtn: React.CSSProperties = {
  background: 'transparent', border: 'none',
  color: 'var(--text-1)', cursor: 'pointer',
  padding: 8, borderRadius: 8, display: 'flex',
}
const progressStripStyle: React.CSSProperties = {
  padding: '10px 16px',
  display: 'flex', alignItems: 'center', gap: 6,
  fontSize: 14, background: 'var(--bg-1)',
  borderBottom: '1px solid var(--border-0)',
}
const stopCardStyle: React.CSSProperties = {
  margin: 16, padding: 20,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 14,
}
const kindBadgeStyle = (kind: 'customer' | 'dump' | 'depot_return'): React.CSSProperties => ({
  display: 'inline-block', padding: '4px 10px', borderRadius: 6,
  fontSize: 10, fontWeight: 700, letterSpacing: 1.5,
  color: kind === 'customer' ? 'var(--gold)' : kind === 'dump' ? 'var(--text-1)' : 'var(--text-2)',
  background: 'var(--bg-2)', border: '1px solid var(--border-1)',
  marginBottom: 12,
})
const contactLink: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 12px', background: 'var(--bg-2)',
  color: 'var(--gold)', borderRadius: 8, textDecoration: 'none',
  fontSize: 14, fontWeight: 600, marginBottom: 14,
}
const notesBoxStyle: React.CSSProperties = {
  padding: 12, background: 'var(--bg-2)',
  borderRadius: 8, marginBottom: 14,
}
const etaRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  fontSize: 12, color: 'var(--text-3)', marginBottom: 16,
}
const directionsBtnStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8,
  padding: '14px', background: 'var(--bg-2)',
  color: 'var(--gold)', borderRadius: 10, textDecoration: 'none',
  fontSize: 15, fontWeight: 600, border: '1px solid var(--border-1)',
}
const actionBarStyle: React.CSSProperties = {
  display: 'flex', gap: 12, padding: 16,
  position: 'sticky', bottom: 0, background: 'var(--bg-0)',
  borderTop: '1px solid var(--border-0)', marginTop: 'auto',
}
const skipBtnStyle: React.CSSProperties = {
  flex: 1, padding: '16px',
  background: 'var(--bg-2)', color: 'var(--amber)',
  border: '1px solid var(--amber)', borderRadius: 10,
  fontSize: 16, fontWeight: 700,
  cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
}
const completeBtnStyle: React.CSSProperties = {
  flex: 2, padding: '16px',
  background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 10,
  fontSize: 16, fontWeight: 700,
  cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
}
const bigPrimaryBtn: React.CSSProperties = {
  padding: '18px 24px', background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 12, fontSize: 17, fontWeight: 700,
  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 10,
}
const ghostBtn: React.CSSProperties = {
  padding: '12px 16px', background: 'transparent', color: 'var(--text-1)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 14, fontWeight: 600, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 6,
}
const centeredPanel: React.CSSProperties = {
  flex: 1, display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center',
  padding: 24, textAlign: 'center',
}
const loadingStyle: React.CSSProperties = {
  padding: 32, color: 'var(--text-2)', textAlign: 'center',
}
const errStyle: React.CSSProperties = {
  margin: '0 16px 12px', padding: '10px 12px',
  background: 'var(--red-bg)', color: 'var(--red)',
  border: '1px solid var(--red-dim)', borderRadius: 8, fontSize: 13,
}
const skipOverlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
  display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
  zIndex: 100, padding: 16,
}
const skipPanelStyle: React.CSSProperties = {
  width: '100%', maxWidth: 480,
  background: 'var(--bg-1)', border: '1px solid var(--border-1)',
  borderRadius: 14, padding: 20,
  color: 'var(--text-0)',
}
const textareaStyle: React.CSSProperties = {
  width: '100%', padding: 12,
  background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 14, fontFamily: 'var(--font-body)',
  boxSizing: 'border-box', resize: 'vertical',
}
