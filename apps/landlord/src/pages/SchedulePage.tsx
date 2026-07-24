import { useState, useRef, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Search, FileSignature, CheckCircle2, AlertTriangle, MessageSquare, Check, X, QrCode, Copy, Mail, Ban } from 'lucide-react'
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api'
import { usePerms } from '../lib/permissions'
import { UNIT_TYPES, UNIT_TYPE_LABEL, humanize, computeStayPrice, RV_SITE_LAYOUTS, RV_SITE_LAYOUT_LABEL, isSiteLayoutMismatch, RV_AMP_SERVICES, RV_AMP_SERVICE_LABEL, isAmpServiceMismatch, BOOKING_CHANGE_REQUEST_TYPE_LABEL, type BookingChangeRequestType } from '@gam/shared'
import { toast, appConfirm, appPrompt } from '../components/dialogs'

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

// S547: the public site is the per-property storefront — path-slug in dev,
// {slug}.gam.biz subdomain in prod (mirrors the API's STOREFRONT_URL_TEMPLATE).
const STOREFRONT_TEMPLATE = (import.meta as any).env?.VITE_STOREFRONT_URL_TEMPLATE || 'http://localhost:3015/{slug}'
const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'

// S535 pattern (see UnitDetailPage): authed photo files can't ride an <img>
// tag — fetch with the Bearer token, render via a blob object-URL.
function AuthThumb({ url, h = 90 }: { url: string; h?: number }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    const token = localStorage.getItem('gam_token') || ''
    fetch(`${API_URL}/api${url}`, { headers: { Authorization: 'Bearer ' + token } })
      .then(r => r.ok ? r.blob() : null)
      .then(b => {
        if (!b || cancelled) return
        objectUrl = URL.createObjectURL(b)
        setSrc(objectUrl)
      })
      .catch(() => {})
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [url])
  if (!src) return <div style={{ width: '100%', height: h, background: 'var(--bg-2)', borderRadius: 8 }} />
  return <img src={src} alt="" style={{ width: '100%', height: h, objectFit: 'cover', borderRadius: 8, display: 'block' }} />
}

const UNIT_TYPE_LABELS: Record<string,string> = {
  residential:'🏠 Residential', rv_spot:'🚐 RV Spot', storage:'📦 Storage',
  parking:'🅿️ Parking', short_term_cabin:'🏕️ Short-Term Cabin'
}
const LEASE_TYPE_LABELS: Record<string,string> = {
  nightly:'Nightly', weekly:'Weekly', month_to_month:'Month-to-Month', long_term:'Long Term'
}
const TYPE_COLORS: Record<string,string> = {
  residential:'var(--blue)', rv_spot:'var(--green)', storage:'var(--amber)',
  parking:'var(--text-3)', short_term_cabin:'var(--gold)'
}
const STATUS_COLORS: Record<string,string> = {
  confirmed:'badge-green', pending:'badge-amber', cancelled:'badge-red', checked_in:'badge-blue'
}

function getDaysInRange(from: string, to: string) {
  const days = []
  const cur = new Date(from + 'T12:00:00')
  const end = new Date(to + 'T12:00:00')
  while (cur <= end) {
    days.push(cur.toISOString().split('T')[0])
    cur.setDate(cur.getDate() + 1)
  }
  return days
}

// Date-only "YYYY-MM-DD". Bookings/leases come back as full ISO timestamps
// (check_in = "2026-06-20T00:00:00.000Z"); slicing keeps the date math (which
// appends T12:00:00) from producing an Invalid Date.
const dayOnly = (s: any) => String(s ?? '').slice(0, 10)

// W-22: which unit types rent by the stay (rates/min-stay/bookability apply).
// Storage + commercial rent by lease only.
const STAY_CAPABLE_TYPES = ['rv_spot', 'apartment', 'single_family', 'mobile_home', 'residential']
// W-24: amenity chip presets per unit type; anything custom via "Add your own".
const AMENITY_PRESETS: Record<string, string[]> = {
  rv_spot: ['Water hookup', 'Sewer hookup', 'Electric 30A', 'Electric 50A', 'WiFi', 'Cable TV', 'Picnic table', 'Fire pit', 'Shade', 'Concrete pad'],
  apartment: ['WiFi', 'Washer/Dryer', 'Dishwasher', 'A/C', 'Heating', 'Parking', 'Balcony', 'Furnished', 'Pets allowed'],
  single_family: ['WiFi', 'Washer/Dryer', 'Dishwasher', 'A/C', 'Heating', 'Garage', 'Yard', 'Furnished', 'Pets allowed'],
  mobile_home: ['WiFi', 'Washer/Dryer', 'A/C', 'Heating', 'Parking', 'Furnished', 'Pets allowed', 'Deck'],
  storage: ['Climate controlled', 'Drive-up access', '24/7 access', 'Lighting', 'Power outlet'],
  commercial: ['Restroom', 'HVAC', 'Signage', 'Parking', 'Loading dock', 'ADA accessible'],
  default: ['WiFi', 'Parking', 'A/C', 'Heating'],
}

function addDays(dateStr: string, days: number) {
  const d = new Date(dayOnly(dateStr) + 'T12:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

// ── Ported from BookingsPage (reservations table + change requests) ──
type ResvBooking = {
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

const RESV_STATUS_BADGE: Record<string, string> = {
  confirmed: 'badge-blue',
  checked_in: 'badge-green',
  checked_out: 'badge-muted',
  cancelled: 'badge-muted',
  no_show: 'badge-red',
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
// booking; revoke kills every outstanding link for it. (Ported from BookingsPage.)
type IssuedAccess = { url: string; qrDataUrl: string; expiresAt: string; emailed: boolean }

function GuestAccessModal({ booking, onClose }: { booking: ResvBooking; onClose: () => void }) {
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

export function SchedulePage() {
  const qc = useQueryClient()
  const { can } = usePerms()
  const today = new Date().toISOString().split('T')[0]
  const [view, setView] = useState<'timeline'|'list'|'units'|'history'|'reservations'|'requests'|'booking_page'>('timeline')
  // Wide fixed window — ~1 month back, ~5 months forward — so the timeline
  // scrolls both directions naturally (no date-range "search" controls). Day
  // columns size to fit roughly a month in the viewport (colW); the load
  // scrolls to today so the coming month is what you see first.
  const [fromDate] = useState(addDays(today, -31))
  const [toDate] = useState(addDays(today, 151))
  // Fixed, compact day-column width: a normal window shows ~a month across,
  // a wide display shows more. (A measured fit-to-viewport mis-read the full
  // display width on large monitors and over-widened columns.)
  const colW = 30
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState('all')
  const [bookingModal, setBookingModal] = useState<{show:boolean; unit:any; prefillDate?:string}>({show:false, unit:null})
  const [typeModal, setTypeModal] = useState<{show:boolean; unit:any}>({show:false, unit:null})
  const [newBooking, setNewBooking] = useState({ guestName:'', guestEmail:'', guestPhone:'', leaseType:'nightly', checkIn:'', checkOut:'', totalAmount:'', notes:'' })
  // Per-unit "+ Book" modal guest name (S526: split first/last like the
  // New Reservation flow; the two modals never open at the same time).
  const [bookFirst, setBookFirst] = useState('')
  const [bookLast, setBookLast]   = useState('')
  const [typeForm, setTypeForm] = useState<any>({})
  const [customAmenity, setCustomAmenity] = useState('')
  const [newResvOpen, setNewResvOpen] = useState(false)
  const [detailBooking, setDetailBooking] = useState<any>(null)
  // Edit mode for an existing reservation (the detail panel). null = view-only.
  const [editForm, setEditForm] = useState<{guestName:string; guestEmail:string; guestPhone:string; checkIn:string; checkOut:string; unitId:string; notes:string; requiredSiteLayout:string; requiredAmpService:string} | null>(null)
  const [editError, setEditError] = useState('')
  const [resvError, setResvError] = useState('')
  const [resvFirst, setResvFirst] = useState('')
  const [resvLast, setResvLast] = useState('')
  // Optional RV requirements for a new reservation: site layout (back-in vs
  // pull-through) + electrical service (30/50 amp). When set, mismatched units
  // are flagged (warn, not blocked).
  const [resvLayout, setResvLayout] = useState<string>('none')
  const [resvAmp, setResvAmp] = useState<string>('none')
  const [selectedCell, setSelectedCell] = useState<{unitId:string; date:string}|null>(null)
  // Booking-guest access: the link a no-account guest uses to reach their
  // stay assistant. Generated on demand per booking.
  const [guestAccess, setGuestAccess] = useState<{
    show:boolean; booking:any; loading:boolean; error:string|null;
    data:{url:string; expiresAt:string; emailed?:boolean}|null; emailing:boolean
  }>({show:false, booking:null, loading:false, error:null, data:null, emailing:false})
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const theadRef = useRef<HTMLTableSectionElement>(null)
  const legendRef = useRef<HTMLDivElement>(null)

  // ── Reservations tab (ported from BookingsPage) ──
  // Separate filter state from the timeline's `search` (which jumps the
  // calendar) — this drives the server-side /bookings query.
  const [linkBooking, setLinkBooking] = useState<ResvBooking | null>(null)
  const [resvSearch, setResvSearch] = useState('')
  const [resvStatus, setResvStatus] = useState('')
  const [resvSource, setResvSource] = useState('')
  const [resvFrom, setResvFrom] = useState('')
  const [resvTo, setResvTo] = useState('')

  // ── Booking Page tab (ported from BookingSitesPage) ──
  // Public per-property booking page config: slug, welcome text, stay rates,
  // short-term tax %, deposit %, publish toggle. Prefixed bp* to avoid clashing
  // with SchedulePage's existing reservation state.
  const [bpPropId, setBpPropId] = useState('')
  const [bpCfg, setBpCfg] = useState<any>(null)
  const [bpMsg, setBpMsg] = useState('')
  const [bpErr, setBpErr] = useState('')
  const [bpSaving, setBpSaving] = useState(false)


  useEffect(() => {
    if (!selectedCell || !scrollContainerRef.current) return
    const container = scrollContainerRef.current
    const cell = container.querySelector(
      `[data-unit="${selectedCell.unitId}"][data-date="${selectedCell.date}"]`
    ) as HTMLElement
    if (!cell) return
    const row = cell.closest('tr') as HTMLElement
    if (!row) return

    const headerHeight = container.querySelector('thead')?.offsetHeight || 36
    const rowTop = row.offsetTop
    const rowBottom = rowTop + row.offsetHeight
    const visibleTop = container.scrollTop + headerHeight
    const visibleBottom = container.scrollTop + container.clientHeight

    // Snap vertically — full row always visible
    if (rowTop < visibleTop) {
      container.scrollTop = rowTop - headerHeight
    } else if (rowBottom > visibleBottom) {
      container.scrollTop = rowBottom - container.clientHeight
    }

    // Pan horizontally — account for sticky unit column
    const stickyWidth = 184
    const cellLeft = cell.offsetLeft
    const cellRight = cellLeft + cell.offsetWidth
    const visLeft = container.scrollLeft + stickyWidth
    const visRight = container.scrollLeft + container.clientWidth

    if (cellLeft < visLeft) {
      container.scrollLeft = cellLeft - stickyWidth - 4
    } else if (cellRight > visRight) {
      container.scrollLeft = cellRight - container.clientWidth + 4
    }
  }, [selectedCell])

  // Drag state
  // Native HTML5 drag (move + edge-resize). `dragInfo` holds the active drag's
  // booking + mode + grab offset; `dragTargetRef` mirrors the live preview range
  // so drop commits without reading state. Grab offset keeps the grabbed day
  // under the cursor (fixes the first-day jump / off-by-one).
  const dragInfo = useRef<null | { booking:any; mode:'move'|'resize-start'|'resize-end'; grabOffset:number }>(null)
  const dragTargetRef = useRef<{unitId:string; checkIn:string; checkOut:string} | null>(null)
  const [preview, setPreview] = useState<{unitId:string; checkIn:string; checkOut:string; mismatch:boolean}|null>(null)
  const [dragging, setDragging] = useState<string|null>(null)

  const { data: schedule, isLoading } = useQuery(
    ['schedule', fromDate, toDate, filterType],
    () => apiGet(`/units/schedule/master?from=${fromDate}&to=${toDate}${filterType!=='all'?'&unitType='+filterType:''}`),
    { staleTime: 30000 }
  )

  const { data: history = [] } = useQuery(
    'schedule-history',
    () => apiGet('/units/schedule/history?limit=150'),
    { enabled: view === 'history', staleTime: 15000 }
  )

  // W-19 (S529): filter-first unit list for the edit-reservation panel — only
  // units the server would actually accept: free for the edited dates (the
  // booking itself excluded) AND matching the stay's RV requirements. Same
  // shared predicate the 409 guards enforce (/units/available).
  const editAvailQuery = editForm && detailBooking && !detailBooking.isLease
    && editForm.checkIn && editForm.checkOut && editForm.checkOut > editForm.checkIn
    ? `/units/available?${new URLSearchParams({
        checkIn: editForm.checkIn, checkOut: editForm.checkOut,
        excludeBookingId: detailBooking.id,
        requiredSiteLayout: editForm.requiredSiteLayout || 'none',
        requiredAmpService: editForm.requiredAmpService || 'none',
      })}`
    : null
  const { data: editAvailableUnits } = useQuery(
    ['units-available', editAvailQuery],
    () => apiGet<any[]>(editAvailQuery!),
    { enabled: !!editAvailQuery, keepPreviousData: true, staleTime: 15000 }
  )

  // ── Reservations tab data + mutations (ported from BookingsPage) ──
  const resvQueryString = useMemo(() => {
    const p: string[] = []
    if (resvStatus) p.push(`status=${encodeURIComponent(resvStatus)}`)
    if (resvSource) p.push(`source=${encodeURIComponent(resvSource)}`)
    if (resvFrom) p.push(`from=${encodeURIComponent(resvFrom)}`)
    if (resvTo) p.push(`to=${encodeURIComponent(resvTo)}`)
    if (resvSearch) p.push(`q=${encodeURIComponent(resvSearch)}`)
    return p.length ? `?${p.join('&')}` : ''
  }, [resvStatus, resvSource, resvFrom, resvTo, resvSearch])

  const { data: resvList = [], isLoading: resvLoading } = useQuery<ResvBooking[]>(
    ['bookings', resvQueryString],
    () => apiGet<ResvBooking[]>(`/bookings${resvQueryString}`),
    { enabled: view === 'reservations', staleTime: 30000 },
  )

  // S191: acknowledge a booking (mark guest signed property rules).
  const ackMut = useMutation(
    (booking: ResvBooking) =>
      apiPatch(`/units/${booking.unitId}/bookings/${booking.id}/acknowledge`),
    { onSuccess: () => qc.invalidateQueries(['bookings']) },
  )

  // Guest-agent change requests (S501 track): open stay-change asks recorded
  // by the guest agent. The host approves/declines here; approving is an
  // acknowledgment, not an automatic booking edit.
  const { data: changeRequests = [] } = useQuery<ChangeRequest[]>(
    ['booking-change-requests'],
    () => apiGet<ChangeRequest[]>('/bookings/change-requests'),
    // Endpoint is perm-gated (S526): don't fire it for a user who only holds
    // bookings.view — they'd 403 while on the Reservations tab.
    { enabled: (view === 'reservations' || view === 'requests') && can('bookings.change_requests'), staleTime: 30000 },
  )
  const resolveMut = useMutation(
    ({ id, status }: { id: string; status: 'approved' | 'declined' }) =>
      apiPatch(`/bookings/change-requests/${id}`, { status }),
    { onSuccess: () => qc.invalidateQueries(['booking-change-requests']) },
  )

  // ── Booking Page tab data (ported from BookingSitesPage) ──
  const { data: bpProperties = [] } = useQuery<any[]>(
    'properties',
    () => apiGet('/properties'),
    { enabled: view === 'booking_page', staleTime: 30000 },
  )
  // Default to the first property once loaded.
  useEffect(() => { if (!bpPropId && bpProperties.length) setBpPropId(bpProperties[0].id) }, [bpProperties])
  // Load the selected property's booking-site config.
  useEffect(() => {
    if (!bpPropId) return
    setBpMsg(''); setBpErr('')
    apiGet(`/properties/${bpPropId}/booking-config`)
      // S550: prefill a blank slug with the server's suggestion —
      // name + city ("oak-park-yarnell"), street number on collision.
      .then((cfg: any) => setBpCfg(cfg?.slug || !cfg?.suggestedSlug ? cfg : { ...cfg, slug: cfg.suggestedSlug }))
      .catch(() => setBpCfg(null))
  }, [bpPropId])
  const saveBookingConfig = async () => {
    setBpSaving(true); setBpMsg(''); setBpErr('')
    try {
      const num = (v: any) => (v === '' || v == null ? null : Number(v))
      const updated = await apiPatch(`/properties/${bpPropId}/booking-config`, {
        slug: bpCfg.slug || null,
        enabled: bpCfg.enabled,
        intro: bpCfg.intro || null,
        depositPct: Number(bpCfg.depositPct),
        monthlyDeposit: num(bpCfg.monthlyDeposit),
        utilitiesBilled: bpCfg.utilitiesBilled !== false,
        officePhone: bpCfg.officePhone?.trim() || null,
        officeEmail: bpCfg.officeEmail?.trim() || null,
        officeHours: bpCfg.officeHours?.trim() || null,
        nightlyRate: num(bpCfg.nightlyRate),
        weeklyRate: num(bpCfg.weeklyRate),
        monthlyRate: num(bpCfg.monthlyRate),
        shortTermTaxRate: Number(bpCfg.shortTermTaxRate) || 0,
      })
      setBpCfg(updated)
      setBpMsg('Saved.')
    } catch (e: any) {
      setBpErr(e?.response?.data?.error || e.message || 'Could not save')
    }
    setBpSaving(false)
  }
  const bpPublicUrl = bpCfg?.slug ? STOREFRONT_TEMPLATE.replace('{slug}', bpCfg.slug) : null

  // ── S547: property-website content (photos + FAQs) ──
  const { data: bpPhotos = [] } = useQuery<any[]>(
    ['site-photos', bpPropId],
    () => apiGet(`/properties/${bpPropId}/site-photos`),
    { enabled: view === 'booking_page' && !!bpPropId },
  )
  const { data: bpFaqs = [] } = useQuery<any[]>(
    ['property-faqs', bpPropId],
    () => apiGet(`/properties/${bpPropId}/faqs`),
    { enabled: view === 'booking_page' && !!bpPropId },
  )
  const [bpFaqDraft, setBpFaqDraft] = useState({ question: '', answer: '' })
  const [bpUploading, setBpUploading] = useState(false)
  const uploadSitePhotos = async (files: FileList | null) => {
    if (!files?.length || !bpPropId) return
    setBpUploading(true); setBpErr('')
    try {
      const fd = new FormData()
      Array.from(files).forEach(f => fd.append('photos', f))
      await apiPost(`/properties/${bpPropId}/site-photos`, fd)
      qc.invalidateQueries(['site-photos', bpPropId])
    } catch (e: any) {
      setBpErr(e?.response?.data?.error || 'Upload failed')
    }
    setBpUploading(false)
  }
  const deleteSitePhoto = async (photoId: string) => {
    if (!await appConfirm('Remove this photo from the website?')) return
    await apiDelete(`/properties/${bpPropId}/site-photos/${photoId}`)
    qc.invalidateQueries(['site-photos', bpPropId])
  }
  const captionSitePhoto = async (photoId: string, current: string | null) => {
    const caption = await appPrompt('Photo caption (blank to clear):', { defaultValue: current || '' })
    if (caption === null) return
    await apiPatch(`/properties/${bpPropId}/site-photos/${photoId}`, { caption: caption || null })
    qc.invalidateQueries(['site-photos', bpPropId])
  }
  const addFaq = async () => {
    if (!bpFaqDraft.question.trim() || !bpFaqDraft.answer.trim()) return
    await apiPost(`/properties/${bpPropId}/faqs`, { question: bpFaqDraft.question.trim(), answer: bpFaqDraft.answer.trim() })
    setBpFaqDraft({ question: '', answer: '' })
    qc.invalidateQueries(['property-faqs', bpPropId])
  }
  const editFaq = async (f: any) => {
    const question = await appPrompt('Question:', { defaultValue: f.question })
    if (question === null) return
    const answer = await appPrompt('Answer:', { defaultValue: f.answer })
    if (answer === null) return
    if (!question.trim() || !answer.trim()) return
    await apiPatch(`/properties/${bpPropId}/faqs/${f.id}`, { question: question.trim(), answer: answer.trim() })
    qc.invalidateQueries(['property-faqs', bpPropId])
  }
  const deleteFaq = async (faqId: string) => {
    if (!await appConfirm('Delete this FAQ?')) return
    await apiDelete(`/properties/${bpPropId}/faqs/${faqId}`)
    qc.invalidateQueries(['property-faqs', bpPropId])
  }

  const resvTotalAmount = resvList.reduce((s, b) => s + (parseFloat(String(b.totalAmount || 0)) || 0), 0)

  // S191: which bookings still need a property-rules acknowledgment (toggle on,
  // not yet signed, and not a closed/cancelled state — no point chasing acks there).
  const needsAckResv = (b: ResvBooking) =>
    b.requiresBookingAcknowledgment
    && !b.acknowledgmentSignedAt
    && b.status !== 'cancelled'
    && b.status !== 'checked_out'
    && b.status !== 'no_show'
  const pendingAckCount = resvList.filter(needsAckResv).length

  const units: any[] = schedule?.units || []


  const bookings: any[] = schedule?.bookings || []
  const leases: any[] = schedule?.leases || []
  const days = getDaysInRange(fromDate, toDate)

  // S526 (Nic): the create form is contact + dates ONLY. No total input (the
  // backend prices authoritatively from unit/property rates — nobody pays on
  // this screen), no fee, no lease-type dropdown: the billing type is implied
  // by stay length (≥30 monthly, ≥7 weekly, else nightly), clamped to the
  // unit's allowed list.
  const closeBookModal = () => {
    setBookingModal({show:false,unit:null})
    setBookFirst(''); setBookLast('')
    setNewBooking({ guestName:'', guestEmail:'', guestPhone:'', leaseType:'nightly', checkIn:'', checkOut:'', totalAmount:'', notes:'' })
  }
  const createBookingMut = useMutation(
    () => {
      const nights = Math.round((new Date(newBooking.checkOut+'T12:00:00').getTime() - new Date(newBooking.checkIn+'T12:00:00').getTime())/86400000)
      let leaseType = nights >= 30 ? 'month_to_month' : nights >= 7 ? 'weekly' : 'nightly'
      const allowed = bookingModal.unit?.leaseTypesAllowed
      if (allowed?.length && !allowed.includes(leaseType)) leaseType = allowed[0]
      return apiPost(`/units/${bookingModal.unit?.id}/bookings`, {
        guestName: `${bookFirst.trim()} ${bookLast.trim()}`.trim(),
        guestEmail: newBooking.guestEmail.trim(),
        guestPhone: newBooking.guestPhone.trim(),
        leaseType, checkIn: newBooking.checkIn, checkOut: newBooking.checkOut,
        source: 'direct',
      })
    },
    { onSuccess: () => { qc.invalidateQueries('schedule'); qc.invalidateQueries('schedule-history'); closeBookModal() } }
  )

  // "New Reservation" flow: dates → contact → pick an available unit (the pick
  // completes it). The per-unit "+ Book" buttons keep their own unit context
  // via bookingModal.
  const resvNights = (() => {
    const { checkIn, checkOut } = newBooking
    if (!checkIn || !checkOut || checkOut <= checkIn) return 0
    return Math.round((new Date(checkOut+'T12:00:00').getTime() - new Date(checkIn+'T12:00:00').getTime())/86400000)
  })()
  // Rate is implied by the length of stay (≥30 → monthly, ≥7 → weekly, else
  // nightly), prorated, with short-term tax. Pulled from the UNIT's rate, with
  // the PROPERTY rate as the default fallback (Nic: a landlord can price a
  // specific unit — e.g. pull-through vs back-in RV — separately). Mirrors the
  // authoritative backend computation in POST /units/:id/bookings.
  const resvType = resvNights >= 30 ? 'month_to_month' : resvNights >= 7 ? 'weekly' : 'nightly'
  const stayPriceForUnit = (u: any) => computeStayPrice(
    { nightly: u.nightlyRate ?? u.propertyNightlyRate,
      weekly:  u.weeklyRate  ?? u.propertyWeeklyRate,
      monthly: u.monthlyRate ?? u.propertyMonthlyRate },
    Number(u.propertyTaxRate || 0),
    resvNights,
  )
  const resvGuestName = `${resvFirst.trim()} ${resvLast.trim()}`.trim()
  const closeNewResv = () => {
    setNewResvOpen(false); setResvError(''); setResvFirst(''); setResvLast(''); setResvLayout('none'); setResvAmp('none')
    setNewBooking({ guestName:'', guestEmail:'', guestPhone:'', leaseType:'nightly', checkIn:'', checkOut:'', totalAmount:'', notes:'' })
  }
  // Combined RV-requirement mismatch reasons for a unit (layout + amp). Empty =
  // compatible. Used by the new-reservation cards, drag-move, and edit panel so
  // one guardrail covers both constraints with a single warning/confirm.
  const rvMismatchReasons = (reqLayout: any, reqAmp: any, u: any): string[] => {
    const r: string[] = []
    if (isSiteLayoutMismatch(reqLayout, u?.rvSiteLayout))
      r.push(`needs ${RV_SITE_LAYOUT_LABEL[reqLayout as keyof typeof RV_SITE_LAYOUT_LABEL]}, unit is ${RV_SITE_LAYOUT_LABEL[(u?.rvSiteLayout||'none') as keyof typeof RV_SITE_LAYOUT_LABEL]}`)
    if (isAmpServiceMismatch(reqAmp, u?.rvAmpService))
      r.push(`needs ${RV_AMP_SERVICE_LABEL[reqAmp as keyof typeof RV_AMP_SERVICE_LABEL]}, unit is ${RV_AMP_SERVICE_LABEL[(u?.rvAmpService||'none') as keyof typeof RV_AMP_SERVICE_LABEL]}`)
    return r
  }
  // Picking a unit submits the reservation with the stay total computed for it.
  const createResvMut = useMutation(
    (u: any) => apiPost(`/units/${u.id}/bookings`, {
      guestName:resvGuestName,
      guestEmail:newBooking.guestEmail.trim() || null,
      guestPhone:newBooking.guestPhone.trim() || null,
      leaseType:resvType, checkIn:newBooking.checkIn, checkOut:newBooking.checkOut,
      nightlyRate:(u.nightlyRate ?? u.propertyNightlyRate)!=null?Number(u.nightlyRate ?? u.propertyNightlyRate):null,
      weeklyRate:(u.weeklyRate ?? u.propertyWeeklyRate)!=null?Number(u.weeklyRate ?? u.propertyWeeklyRate):null,
      totalAmount:stayPriceForUnit(u).total, source:'direct',
      requiredSiteLayout: resvLayout,
      requiredAmpService: resvAmp,
    }),
    {
      onSuccess: () => { qc.invalidateQueries('schedule'); qc.invalidateQueries('schedule-history'); closeNewResv() },
      onError: (e: any) => setResvError(e?.response?.data?.error || e?.message || 'Could not create the reservation'),
    }
  )
  // All units full for the dates → add the guest to a property-wide waitlist
  // (one per distinct property among the units). Promoted on the next opening.
  const waitlistMut = useMutation(
    async () => {
      const propIds = Array.from(new Set(units.map((u: any) => u.propertyId).filter(Boolean)))
      for (const pid of propIds) {
        await apiPost(`/properties/${pid}/waitlist`, {
          guestName: resvGuestName,
          guestEmail: newBooking.guestEmail.trim(),
          guestPhone: newBooking.guestPhone.trim() || null,
          checkIn: newBooking.checkIn, checkOut: newBooking.checkOut,
        })
      }
    },
    { onSuccess: () => { setResvError(''); closeNewResv() }, onError: (e: any) => setResvError(e?.message || 'Could not add to the waitlist') }
  )

  const updateTypeMut = useMutation(
    () => apiPatch(`/units/${typeModal.unit?.id}/type`, typeForm),
    { onSuccess: () => { qc.invalidateQueries('schedule'); setTypeModal({show:false,unit:null}) } }
  )

  const moveBookingMut = useMutation(
    (payload: {bookingId:string; unitId:string; checkIn:string; checkOut:string}) =>
      apiPatch(`/units/${payload.unitId}/bookings/${payload.bookingId}`, {
        unitId: payload.unitId, checkIn: payload.checkIn, checkOut: payload.checkOut
      }),
    {
      onSuccess: () => { qc.invalidateQueries('schedule') },
      onError: () => { toast.error('Cannot move reservation — date conflict on that unit.') }
    }
  )

  const cancelBookingMut = useMutation(
    (b: any) => apiPatch(`/units/${b.unitId}/bookings/${b.id}`, { status: 'cancelled' }),
    {
      onSuccess: () => { qc.invalidateQueries('schedule'); qc.invalidateQueries('schedule-history'); setDetailBooking(null) },
      onError: () => toast.error('Could not cancel the reservation.'),
    }
  )

  // S547: snowbird lock toggle — pins the stay to its site, exempt from the
  // compressor / relocation / extend-fallback movers.
  const lockBookingMut = useMutation(
    (b: any) => apiPatch(`/units/${b.unitId}/bookings/${b.id}`, { lockedToUnit: !b.lockedToUnit }),
    {
      onSuccess: (updated: any, b: any) => {
        qc.invalidateQueries('schedule')
        setDetailBooking((prev: any) => prev ? { ...prev, lockedToUnit: updated?.lockedToUnit ?? !b.lockedToUnit } : prev)
        toast(updated?.lockedToUnit ?? !b.lockedToUnit ? 'Locked to its site — automatic scheduling will not move this stay.' : 'Unlocked — automatic scheduling may re-site this stay again.')
      },
      onError: () => toast.error('Could not update the site lock.'),
    }
  )

  // Edit an existing reservation (guest contact, dates, unit, notes). The
  // backend reprices on a date/unit change and COALESCEs unchanged fields.
  const editBookingMut = useMutation(
    (vars: {orig:any; form:NonNullable<typeof editForm>}) =>
      apiPatch(`/units/${vars.orig.unitId}/bookings/${vars.orig.id}`, {
        guestName: vars.form.guestName.trim() || null,
        guestEmail: vars.form.guestEmail.trim() || null,
        guestPhone: vars.form.guestPhone.trim() || null,
        checkIn: vars.form.checkIn,
        checkOut: vars.form.checkOut,
        unitId: vars.form.unitId,
        notes: vars.form.notes.trim() || null,
        requiredSiteLayout: vars.form.requiredSiteLayout,
        requiredAmpService: vars.form.requiredAmpService,
      }),
    {
      onSuccess: (resp:any) => {
        qc.invalidateQueries('schedule'); qc.invalidateQueries('schedule-history')
        const b = resp?.data
        setDetailBooking((prev:any)=> prev ? {
          ...prev,
          guestName: b?.guest_name ?? prev.guestName,
          guestEmail: b?.guest_email ?? prev.guestEmail,
          guestPhone: b?.guest_phone ?? prev.guestPhone,
          checkIn: b?.check_in ? String(b.check_in).split('T')[0] : prev.checkIn,
          checkOut: b?.check_out ? String(b.check_out).split('T')[0] : prev.checkOut,
          nights: b?.nights ?? prev.nights,
          totalAmount: b?.total_amount ?? prev.totalAmount,
          unitId: b?.unit_id ?? prev.unitId,
          unitNumber: units.find((u:any)=>u.id===(b?.unit_id))?.unitNumber ?? prev.unitNumber,
          notes: b?.notes ?? prev.notes,
        } : prev)
        setEditForm(null); setEditError('')
      },
      onError: (e:any) => setEditError(e?.response?.data?.error || e?.message || 'Could not save changes.'),
    }
  )
  const startEdit = (d:any) => {
    setEditError('')
    setEditForm({
      guestName: d.guestName || '', guestEmail: d.guestEmail || '', guestPhone: d.guestPhone || '',
      // dayOnly: d.checkIn/checkOut arrive as full ISO timestamps (S526 rule) —
      // raw they leave the type="date" inputs blank and fail the
      // /units/available date validation.
      checkIn: dayOnly(d.checkIn), checkOut: dayOnly(d.checkOut), unitId: d.unitId, notes: d.notes || '',
      requiredSiteLayout: d.requiredSiteLayout || 'none',
      requiredAmpService: d.requiredAmpService || 'none',
    })
  }

  // The stay link is auto-emailed when a reservation is created; this is for
  // grabbing it to text/share manually. (No QR — a remote guest just taps a link.)
  const copyStayLink = async (b: any) => {
    let url = ''
    try {
      const resp = await apiPost<{ url: string }>(`/units/${b.unitId}/bookings/${b.id}/guest-access`, { delivery: 'qr' })
      url = resp.data.url
    } catch { toast.error('Could not generate the stay link.'); return }
    // Clipboard API is blocked outside https/localhost (and some Safari modes);
    // fall back to a prompt the user can copy from.
    try {
      await navigator.clipboard.writeText(url)
      toast('Stay link copied: ' + url)
    } catch {
      await appPrompt('Copy the stay link to text or email the guest:', { title: 'Stay link', defaultValue: url })
    }
  }

  const openGuestAccess = async (b: any) => {
    setGuestAccess({show:true, booking:b, loading:true, error:null, data:null, emailing:false})
    try {
      const resp = await apiPost<{url:string; expiresAt:string; emailed?:boolean}>(
        `/units/${b.unitId}/bookings/${b.id}/guest-access`, { delivery:'qr' })
      setGuestAccess(s => ({...s, loading:false, data: resp.data}))
    } catch (e:any) {
      setGuestAccess(s => ({...s, loading:false, error: e?.message || 'Could not generate the guest link.'}))
    }
  }
  const emailGuestAccess = async () => {
    const b = guestAccess.booking
    if (!b) return
    setGuestAccess(s => ({...s, emailing:true, error:null}))
    try {
      const resp = await apiPost<{url:string; expiresAt:string; emailed?:boolean}>(
        `/units/${b.unitId}/bookings/${b.id}/guest-access`, { delivery:'email', sendEmail:true })
      setGuestAccess(s => ({...s, emailing:false, data: resp.data}))
    } catch (e:any) {
      setGuestAccess(s => ({...s, emailing:false, error: e?.message || 'Could not email the guest link.'}))
    }
  }

  // NOTE: check_in/check_out/start_date/end_date come back as full ISO
  // timestamps ("2026-07-21T07:00:00.000Z"), so every date comparison must run
  // on the day-only slice — a raw `"2026-07-21" >= "2026-07-21T07:.."` is false
  // (prefix) and shifts every bar one day. dayOnly() normalizes both sides.
  const getBookingForDate = (unitId: string, date: string) => {
    return bookings.find(b => b.unitId === unitId && date >= dayOnly(b.checkIn) && date < dayOnly(b.checkOut)) ||
           leases.find(l => l.unitId === unitId && date >= dayOnly(l.startDate) && (!l.endDate || date <= dayOnly(l.endDate)))
  }

  const filteredUnits = filterType === 'all' ? units : units.filter(u => u.unitType === filterType)

  // Units a staff reservation can take for the entered dates: only units set up
  // for short-term stays (is_bookable) that are free of an overlapping booking
  // or lease. Units not configured for bookings (e.g. long-term apartments)
  // don't appear — enable a unit via its ⚙ Configure.
  const ci = newBooking.checkIn, co = newBooking.checkOut
  const datesValid = !!ci && !!co && co > ci
  const availableUnits = !datesValid ? [] : units.filter((u: any) => {
    if (!u.isBookable) return false
    const bookingConflict = bookings.some((b: any) => b.unitId === u.id && b.status !== 'cancelled' && dayOnly(b.checkIn) < co && dayOnly(b.checkOut) > ci)
    const leaseConflict = leases.some((l: any) => l.unitId === u.id && dayOnly(l.startDate) < co && (!l.endDate || dayOnly(l.endDate) > ci))
    return !bookingConflict && !leaseConflict
  })

  // Reservation search — match guest/tenant name, unit number, guest email or
  // phone, or a date (check-in/out, lease term) across bookings + active leases;
  // each result jumps the timeline to that stay.
  const unitNumberOf = (id: string) => units.find((u: any) => u.id === id)?.unitNumber || ''
  const searchQuery = search.trim().toLowerCase()
  const searchResults = searchQuery.length < 2 ? [] : ([
    ...bookings.map((b: any) => ({
      id: b.id, kind: 'booking', label: b.guestName || 'Guest',
      sub: `Unit ${unitNumberOf(b.unitId)} · ${b.checkIn} → ${b.checkOut}`,
      hay: `${b.guestName || ''} ${unitNumberOf(b.unitId)} ${b.guestEmail || ''} ${b.guestPhone || ''} ${b.checkIn || ''} ${b.checkOut || ''}`.toLowerCase(),
      unitId: b.unitId, date: b.checkIn,
    })),
    ...leases.map((l: any) => ({
      id: l.id, kind: 'lease', label: `${l.firstName || ''} ${l.lastName || ''}`.trim() || 'Tenant',
      sub: `Unit ${unitNumberOf(l.unitId)} · lease`,
      hay: `${l.firstName || ''} ${l.lastName || ''} ${unitNumberOf(l.unitId)} ${l.startDate || ''} ${l.endDate || ''}`.toLowerCase(),
      unitId: l.unitId, date: l.startDate,
    })),
  ].filter(r => r.hay.includes(searchQuery)).slice(0, 10))

  const jumpToReservation = (r: any) => {
    setSearch('')
    setView('timeline')
    if (filterType !== 'all') setFilterType('all')   // don't hide the matched unit
    setSelectedCell({ unitId: r.unitId, date: r.date })
    setTimeout(() => {
      const c = scrollContainerRef.current
      if (!c) return
      const idx = days.indexOf(r.date)
      if (idx >= 0) c.scrollLeft = Math.max(0, idx * colW - colW * 2)
    }, 60)
  }

  const openTypeModal = (unit: any) => {
    setTypeForm({
      unitType: unit.unitType || 'residential',
      nightlyRate: unit.nightlyRate || '',
      weeklyRate: unit.weeklyRate || '',
      monthlyRate: unit.monthlyRate || '',
      minStayNights: unit.minStayNights || 1,
      checkInTime: unit.checkInTime?.slice(0,5) || '15:00',
      checkOutTime: unit.checkOutTime?.slice(0,5) || '11:00',
      amenities: unit.amenities || [],   // W-24: text[] end to end (the old comma-string broke the text[] save)
      unitDescription: unit.unitDescription || '',
      isBookable: unit.isBookable || false,
      rvSiteLayout: unit.rvSiteLayout || 'none',
      rvAmpService: unit.rvAmpService || 'none',
      dwellingOwnership: unit.dwellingOwnership || (unit.unitType === 'rv_spot' ? 'tenant' : 'landlord'),
    })
    setCustomAmenity('')
    setTypeModal({show:true, unit})
  }

  const openBookingModal = (unit: any, prefillDate?: string) => {
    setBookFirst(''); setBookLast('')
    setNewBooking({
      guestName:'', guestEmail:'', guestPhone:'', totalAmount:'', notes:'',
      leaseType: unit.leaseTypesAllowed?.[0] || 'nightly',
      checkIn: prefillDate || '',
      checkOut: prefillDate ? addDays(prefillDate, 1) : '',
    })
    setBookingModal({show:true, unit, prefillDate})
  }

  // ── DRAG (native HTML5 drag-and-drop) ──
  const daysBetween = (a:string,b:string) =>
    Math.round((new Date(dayOnly(b)+'T12:00:00').getTime() - new Date(dayOnly(a)+'T12:00:00').getTime()) / 86400000)

  // Validate + commit a finished drag (move or resize). Same gates as before:
  // same-unit date change skips bookable/lease-type checks; cross-unit move
  // warns (not blocks) on RV layout/amp mismatch. Backend reprices.
  const commitDrag = (b:any, tUnitId:string, newCheckIn:string, newCheckOut:string) => {
    if (newCheckOut <= newCheckIn) return
    if (dayOnly(b.checkIn) === newCheckIn && dayOnly(b.checkOut) === newCheckOut && b.unitId === tUnitId) return
    const targetUnit = units.find(u => u.id === tUnitId)
    if (!targetUnit) return
    const sameUnit = b.unitId === tUnitId
    if (!sameUnit && !targetUnit.isBookable) { toast.error('That unit isn’t set up for bookings.'); return }
    if (!sameUnit && targetUnit.leaseTypesAllowed?.length && !targetUnit.leaseTypesAllowed.includes(b.leaseType)) {
      toast.error(`That unit does not allow ${(LEASE_TYPE_LABELS[b.leaseType] || humanize(b.leaseType)).toLowerCase()} bookings.`); return
    }
    const rangeDays = getDaysInRange(newCheckIn, addDays(newCheckOut, -1))
    const hasBookingConflict = bookings.some(existing =>
      existing.id !== b.id && existing.unitId === tUnitId &&
      rangeDays.some(d => d >= dayOnly(existing.checkIn) && d < dayOnly(existing.checkOut)))
    const hasLeaseConflict = leases.some(l =>
      l.unitId === tUnitId && rangeDays.some(d => d >= dayOnly(l.startDate) && (!l.endDate || d <= dayOnly(l.endDate))))
    if (hasBookingConflict || hasLeaseConflict) { toast.error('That unit is already occupied for those dates.'); return }
    const doMove = () => moveBookingMut.mutate({ bookingId: b.id, unitId: tUnitId, checkIn: newCheckIn, checkOut: newCheckOut })
    const mismatchReasons = sameUnit ? [] : rvMismatchReasons(b.requiredSiteLayout, b.requiredAmpService, targetUnit)
    if (mismatchReasons.length) {
      appConfirm(`Unit ${targetUnit.unitNumber} doesn't match this reservation:\n· ${mismatchReasons.join('\n· ')}\n\nMove it anyway?`, { confirmLabel: 'Move it' }).then(ok => { if (ok) doMove() })
    } else {
      doMove()
    }
  }

  // Begin a drag. `grabbedDate` = the day-cell the drag started on, so a MOVE
  // keeps that day under the cursor (subtract grabOffset on drop) instead of
  // snapping check-in to the drop cell — fixes the "first day jumps" / off-by-one.
  const onDragStart = (e: React.DragEvent, bk: any, grabbedDate: string, mode: 'move'|'resize-start'|'resize-end') => {
    if (bk.isLease) { e.preventDefault(); return }   // leases are read-only
    if (mode !== 'move') e.stopPropagation()         // edge grip → resize, not move
    dragInfo.current = { booking: bk, mode, grabOffset: mode === 'move' ? daysBetween(bk.checkIn, grabbedDate) : 0 }
    dragTargetRef.current = null
    setDragging(bk.id)
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', bk.id) } catch {}
  }
  // Hovering a cell resolves the target range (move = grab-relative; resize =
  // the grabbed edge follows the cursor) and drives the preview highlight.
  const onDragOver = (e: React.DragEvent, hoverUnitId: string, hoverDate: string) => {
    const di = dragInfo.current; if (!di) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const b = di.booking
    const bCheckIn = dayOnly(b.checkIn), bCheckOut = dayOnly(b.checkOut)
    const nights = b.nights || Math.max(1, daysBetween(bCheckIn, bCheckOut))
    let unitId = hoverUnitId, ci = bCheckIn, co = bCheckOut
    if (di.mode === 'move') {
      unitId = hoverUnitId
      ci = addDays(hoverDate, -di.grabOffset)
      co = addDays(ci, nights)
    } else if (di.mode === 'resize-end') {
      unitId = b.unitId; co = addDays(hoverDate, 1); if (co <= ci) co = addDays(ci, 1)
    } else {
      unitId = b.unitId; ci = hoverDate; if (ci >= co) ci = addDays(co, -1)
    }
    const t = dragTargetRef.current
    if (t && t.unitId === unitId && t.checkIn === ci && t.checkOut === co) return
    const u = units.find(x => x.id === unitId)
    const mismatch = di.mode === 'move' && !!u && u.id !== b.unitId &&
      rvMismatchReasons(b.requiredSiteLayout, b.requiredAmpService, u).length > 0
    dragTargetRef.current = { unitId, checkIn: ci, checkOut: co }
    setPreview({ unitId, checkIn: ci, checkOut: co, mismatch })
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const di = dragInfo.current, t = dragTargetRef.current
    dragInfo.current = null; dragTargetRef.current = null
    setPreview(null); setDragging(null)
    if (di && t) commitDrag(di.booking, t.unitId, t.checkIn, t.checkOut)
  }
  const onDragEnd = () => {
    dragInfo.current = null; dragTargetRef.current = null
    setPreview(null); setDragging(null)
  }

  // Scroll the timeline so today's column sits just after the sticky unit
  // column — i.e. the coming month is what you see, with past to the left.
  const scrollToToday = () => {
    const c = scrollContainerRef.current
    if (!c) return
    const idx = days.indexOf(today)
    c.scrollLeft = idx > 0 ? idx * colW : 0
  }

  // On first paint of the timeline, jump to today.
  useEffect(() => {
    if (isLoading || view !== 'timeline') return
    const t = setTimeout(scrollToToday, 60)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, view, colW])

  // Per-user tab gating: staff see only the sub-tabs they hold; owners see all.
  const SCHEDULE_TABS = ([
    { key: 'timeline',     perm: 'schedule.tab.timeline', label: 'Timeline' },
    { key: 'list',         perm: 'schedule.tab.list', label: 'List' },
    { key: 'units',        perm: 'schedule.tab.units', label: 'Units' },
    { key: 'history',      perm: 'schedule.tab.history', label: 'History' },
    { key: 'reservations', perm: 'bookings.view', label: 'Reservations' },
    { key: 'requests',     perm: 'bookings.change_requests', label: 'Requests' },
    { key: 'booking_page', perm: 'booking_sites.view', label: 'Booking Page' },
  ] as { key: string; perm: string; label?: string }[]).filter(t => can(t.perm))
  // If the active view isn't visible to this user, snap to their first tab.
  const visibleTabKeys = SCHEDULE_TABS.map(t => t.key).join(',')
  useEffect(() => {
    if (SCHEDULE_TABS.length && !SCHEDULE_TABS.some(t => t.key === view)) setView(SCHEDULE_TABS[0].key as any)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTabKeys])

  return (
    <div style={{minWidth:0,overflow:'hidden'}}>
      {/* ── COMPACT TOOLBAR ── */}
      <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:12,flexWrap:'wrap'}}>
        {/* View toggle */}
        {SCHEDULE_TABS.map(({ key: v, label }) => (
          <button key={v} className={`tab-btn ${view===v?'active':''}`} onClick={()=>setView(v as any)} style={{fontSize:'.78rem'}}>{label ?? v}</button>
        ))}

        {/* Reservation search */}
        <div style={{position:'relative'}}>
          <input
            value={search}
            onChange={e=>setSearch(e.target.value)}
            placeholder="🔍 Find guest or unit…"
            style={{fontSize:'.76rem',padding:'5px 9px',width:190,background:'var(--bg-3)',border:'1px solid var(--border-1)',borderRadius:6,color:'var(--text-1)'}}
          />
          {search.trim().length>=2 && (
            <div style={{position:'absolute',top:'calc(100% + 4px)',left:0,zIndex:30,minWidth:240,maxHeight:300,overflowY:'auto',background:'var(--bg-2)',border:'1px solid var(--border-1)',borderRadius:8,boxShadow:'0 10px 30px rgba(0,0,0,.45)'}}>
              {searchResults.length===0 ? (
                <div style={{padding:'10px 12px',fontSize:'.74rem',color:'var(--text-3)'}}>No matches</div>
              ) : searchResults.map(r => (
                <div key={r.kind+r.id} onClick={()=>jumpToReservation(r)}
                  style={{padding:'7px 11px',cursor:'pointer',borderBottom:'1px solid var(--border-1)'}}
                  onMouseDown={e=>e.preventDefault()}>
                  <div style={{fontSize:'.8rem',fontWeight:600,display:'flex',justifyContent:'space-between',gap:8}}>
                    <span>{r.label}</span>
                    <span style={{fontSize:'.6rem',color:r.kind==='lease'?'var(--blue)':'var(--green)',fontWeight:700}}>{r.kind==='lease'?'LEASE':'STAY'}</span>
                  </div>
                  <div style={{fontSize:'.68rem',color:'var(--text-3)'}}>{r.sub}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {view==='timeline' && <>
          <div style={{width:1,height:20,background:'var(--border-1)',margin:'0 4px'}} />
          {/* Scroll-based nav — drag/scroll the timeline both ways; Today re-centers. */}
          <button className="btn btn-ghost btn-sm" onClick={scrollToToday} style={{fontWeight:600,color:'var(--gold)'}}>Today</button>
          <span style={{fontSize:'.72rem',color:'var(--text-3)'}}>← scroll for past · future →</span>
        </>}

        {/* Unit-type filter chips removed (S: crowded the toolbar). filterType
            stays 'all' so all units show; landlords still set unit type at
            creation. */}

        {/* Stats + New Reservation */}
        <div style={{marginLeft:'auto',display:'flex',gap:8,alignItems:'center'}}>
          <span style={{fontSize:'.72rem',color:'var(--text-3)'}}>{filteredUnits.length} units · {bookings.length} reservations</span>
          {can('schedule.create_reservation') && <button className="btn btn-primary btn-sm" onClick={()=>setNewResvOpen(true)}>+ New Reservation</button>}
        </div>
      </div>

      {isLoading && <div style={{padding:48,textAlign:'center',color:'var(--text-3)'}}>Loading schedule...</div>}

      {/* ── TIMELINE VIEW ── */}
      {!isLoading && view==='timeline' && (
        <div style={{display:'flex',flexDirection:'column',minWidth:0}}>
        <div
          ref={scrollContainerRef}
          className="card"
          style={{padding:0,overflowX:'auto',overflowY:'scroll',height:'calc(100vh - 200px)',marginBottom:0,borderRadius:'12px 12px 0 0'}}
          onScroll={e => {
            const container = e.currentTarget
            clearTimeout((container as any)._snapTimer)
            ;(container as any)._snapTimer = setTimeout(() => {
              const firstRow = container.querySelector('tbody tr') as HTMLElement
              const ROW_H = firstRow ? firstRow.offsetHeight : 72
              const snapped = Math.round(container.scrollTop / ROW_H) * ROW_H
              if (Math.abs(container.scrollTop - snapped) > 1) {
                container.scrollTop = snapped
              }
            }, 80)
          }}
        >
          <table
            style={{borderCollapse:'collapse',tableLayout:'fixed',width:180+days.length*colW}}
            tabIndex={0}
            onKeyDown={e => {
              if (!selectedCell) return
              const unitIdx = filteredUnits.findIndex(u => u.id === selectedCell.unitId)
              const dayIdx = days.findIndex(d => d === selectedCell.date)
              if (e.key === 'ArrowRight') { e.preventDefault(); if (dayIdx < days.length-1) setSelectedCell({unitId: selectedCell.unitId, date: days[dayIdx+1]}) }
              if (e.key === 'ArrowLeft')  { e.preventDefault(); if (dayIdx > 0) setSelectedCell({unitId: selectedCell.unitId, date: days[dayIdx-1]}) }
              if (e.key === 'ArrowDown')  { e.preventDefault(); if (unitIdx < filteredUnits.length-1) setSelectedCell({unitId: filteredUnits[unitIdx+1].id, date: selectedCell.date}) }
              if (e.key === 'ArrowUp')    { e.preventDefault(); if (unitIdx > 0) setSelectedCell({unitId: filteredUnits[unitIdx-1].id, date: selectedCell.date}) }
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                const unit = filteredUnits.find(u => u.id === selectedCell.unitId)
                const booked = getBookingForDate(selectedCell.unitId, selectedCell.date)
                if (unit && unit.isBookable && !booked) openBookingModal(unit, selectedCell.date)
              }
              if (e.key === 'Escape') setSelectedCell(null)
            }}
          >
            <thead ref={theadRef} style={{position:'sticky',top:0,zIndex:3}}>
              <tr>
                <th style={{background:'var(--bg-3)',padding:'8px 12px',textAlign:'left',fontSize:'.72rem',color:'var(--text-3)',fontWeight:600,position:'sticky',left:0,zIndex:4,width:180,minWidth:180,borderBottom:'1px solid var(--border-1)'}}>Unit</th>
                {days.map(d => (
                  <th key={d} style={{background:'var(--bg-3)',padding:'6px 2px',fontSize:'.6rem',color:d===today?'var(--gold)':'var(--text-3)',fontWeight:d===today?700:400,textAlign:'center',width:colW,minWidth:colW,maxWidth:colW,borderBottom:'1px solid var(--border-1)',borderLeft:'1px solid var(--border-1)'}}>
                    <div>{new Date(d+'T12:00:00').toLocaleDateString('en-US',{month:'numeric',day:'numeric'})}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredUnits.map(unit => (
                <tr key={unit.id} style={{height:72,maxHeight:72}}>
                  {/* zIndex 3: must beat the day-cell bars (zIndex 1–2). When the grid
                      is scrolled, past day-cells slide UNDER this sticky column — at
                      zIndex 1 the bars painted over the unit info (S526 glitch). */}
                  <td style={{padding:'6px 12px',borderBottom:'1px solid var(--border-1)',position:'sticky',left:0,background:'var(--bg-2)',zIndex:3,height:72,boxSizing:'border-box',overflow:'hidden'}}>
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
                      <div>
                        <div style={{fontWeight:600,fontSize:'.82rem'}}>{unit.unitNumber}</div>
                        <div style={{fontSize:'.68rem',color:TYPE_COLORS[unit.unitType]||'var(--text-3)'}}>{UNIT_TYPE_LABELS[unit.unitType]||humanize(unit.unitType)}</div>
                        <div style={{fontSize:'.65rem',color:'var(--text-3)'}}>{unit.propertyName}</div>
                      </div>
                      <div style={{display:'flex',gap:4}}>
                        {unit.isBookable && can('schedule.create_reservation') && <button className="btn btn-ghost btn-sm" style={{fontSize:'.65rem',padding:'2px 6px'}} onClick={()=>openBookingModal(unit)}>+ Book</button>}
                        {can('schedule.configure_unit') && <button className="btn btn-ghost btn-sm" style={{fontSize:'.65rem',padding:'2px 6px'}} onClick={()=>openTypeModal(unit)}>⚙</button>}
                      </div>
                    </div>
                  </td>
                  {days.map(d => {
                    const booking = getBookingForDate(unit.id, d)
                    const isBooked = !!booking
                    const isLease = !!(booking && booking.startDate)
                    const isStart = booking && (dayOnly(booking.checkIn) === d || dayOnly(booking.startDate) === d)
                    // Last cell of this reservation within the grid, so the bar
                    // rounds only at its true ends. S527 W-21: conventions differ —
                    // check-out is EXCLUSIVE (last painted night = checkOut-1) but
                    // lease end_date is INCLUSIVE (bar paints through endDate), so
                    // leases round ON endDate, not one day early.
                    const isEnd = booking && (
                      (booking.checkOut && addDays(d,1) === dayOnly(booking.checkOut)) ||
                      (booking.endDate && d === dayOnly(booking.endDate)) ||
                      d === days[days.length-1]
                    )
                    const isDragTarget = !!(preview && preview.unitId === unit.id && d >= preview.checkIn && d < preview.checkOut)
                    const isPreviewStart = isDragTarget && d === preview!.checkIn
                    const isGhostCell = !!(dragging && booking?.id === dragging)
                    // The standalone gold preview block renders only on cells that DON'T
                    // hold the dragged bar; the dragged bar's own cells stay mounted (so
                    // the native drag isn't cancelled) and get tinted gold instead — that
                    // shows the overlap with the original position without unmounting it.
                    const showPreviewBlock = isDragTarget && !isGhostCell

                    return (
                      <td
                        key={d}
                        data-unit={unit.id}
                        data-date={d}
                        style={{borderBottom:'1px solid var(--border-1)',borderLeft:'1px solid var(--border-1)',padding:'6px 0',textAlign:'center',width:colW,minWidth:colW,maxWidth:colW,
                          background: isDragTarget ? (preview?.mismatch ? 'rgba(224,168,0,.16)' : 'rgba(201,162,39,.18)') : d===today ? 'rgba(201,162,39,.04)' : '',
                          outline: selectedCell?.unitId===unit.id && selectedCell?.date===d ? '2px solid var(--gold)' : isDragTarget ? `2px solid ${preview?.mismatch?'var(--amber)':'var(--gold)'}` : 'none',
                          outlineOffset: '-2px',
                          cursor: isBooked && !isLease ? 'grab' : unit.isBookable && !isBooked ? 'pointer' : 'default'
                        }}
                        onDragOver={e => onDragOver(e, unit.id, d)}
                        onDrop={onDrop}
                        onClick={e => {
                          setSelectedCell({unitId: unit.id, date: d})
                          ;(e.currentTarget.closest('table') as HTMLElement)?.focus()
                        }}
                        onDoubleClick={() => {
                          if (!isBooked && unit.isBookable) openBookingModal(unit, d)
                        }}
                      >
                        {showPreviewBlock ? (
                          <div style={{background: preview?.mismatch ? 'var(--amber)' : 'var(--gold)',borderRadius:3,height:24,opacity:.7,display:'flex',alignItems:'center',justifyContent:'center',fontSize:'.6rem',color:'#000',fontWeight:700}}>
                            {isPreviewStart ? (dragInfo.current?.booking?.guestName || '↔').slice(0,8) : ''}
                          </div>
                        ) : isBooked ? (
                          (() => {
                            // S200: ack-needed badge — booking on a property with
                            // requires_booking_acknowledgment ON and no
                            // acknowledgment_signed_at timestamp yet, on an active
                            // (not cancelled / checked_out / no_show) booking.
                            //
                            // S312: response-interceptor camelizes the keys, so the
                            // frontend reads camelCase here. The master-schedule
                            // endpoint (GET /units/schedule/master) joins properties
                            // and surfaces requires_booking_acknowledgment, so the
                            // badge renders correctly on this page.
                            const needsAck =
                              !isLease
                              && booking.requiresBookingAcknowledgment === true
                              && !booking.acknowledgmentSignedAt
                              && booking.status !== 'cancelled'
                              && booking.status !== 'checked_out'
                              && booking.status !== 'no_show'
                            const bk = { ...booking, unitId: unit.id, unitNumber: unit.unitNumber, propertyName: unit.propertyName, isLease }
                            return (
                              <div
                                draggable={!isLease}
                                onDragStart={e => {
                                  // Mode from grab position: the outer ~10px of a start/end
                                  // cell resizes that edge; anywhere else moves the stay.
                                  // (One draggable element — nested draggable grips were
                                  // unreliable, the browser kept choosing the parent.)
                                  const w = (e.currentTarget as HTMLElement).offsetWidth || colW
                                  const x = e.nativeEvent.offsetX
                                  const mode: 'move'|'resize-start'|'resize-end' =
                                    (isStart && x <= 10) ? 'resize-start'
                                    : (isEnd && x >= w - 10) ? 'resize-end'
                                    : 'move'
                                  onDragStart(e, bk, d, mode)
                                }}
                                onDragEnd={onDragEnd}
                                onClick={e => { e.stopPropagation(); setDetailBooking(bk) }}
                                style={{
                                  // The dragged bar's cells that fall in the new target
                                  // range tint gold (preview of the overlap with the
                                  // original); cells outside the new range dim (ghost).
                                  background: isLease ? 'var(--blue)'
                                    : (isGhostCell && isDragTarget) ? (preview?.mismatch ? 'var(--amber)' : 'var(--gold)')
                                    : 'var(--green)',
                                  // Round only at the reservation's true ends so adjacent
                                  // day-cells merge into one continuous bar (no beading).
                                  borderRadius:`${isStart?6:0}px ${isEnd?6:0}px ${isEnd?6:0}px ${isStart?6:0}px`,
                                  height:26,
                                  display:'flex', alignItems:'center', justifyContent:'flex-start',
                                  // S527 W-17: names readable at a glance.
                                  fontSize:'.72rem', fontWeight:700, color: (isGhostCell && isDragTarget) ? '#000' : '#fff', overflow:'visible',
                                  whiteSpace:'nowrap', paddingLeft: isStart?7:0,
                                  opacity: (isGhostCell && !isDragTarget) ? 0.2 : 0.92,
                                  cursor: isLease ? 'default' : 'grab',
                                  position:'relative', zIndex: isStart?2:1,
                                  border: needsAck ? '1px solid var(--amber)' : 'none',
                                  userSelect: 'none',
                                }}
                                title={
                                  (booking.guestName || booking.firstName || 'Tenant')
                                  + (needsAck ? ' — Property-rules acknowledgment pending' : '')
                                }
                              >
                                {/* S527 W-17: label on the bar's first VISIBLE cell — bars that
                                    began before the grid (long leases) were nameless because the
                                    label only painted on the true start cell, off-screen left. */}
                                {(isStart || d === days[0]) && (!isGhostCell || isDragTarget) ? `${isLease?'🔒 ':''}${(booking.guestName || [booking.firstName, booking.lastName].filter(Boolean).join(' ') || '●').slice(0,16)}` : ''}
                                {needsAck && isStart && (
                                  <span
                                    style={{
                                      position:'absolute',
                                      top:-3, right:-3,
                                      width:8, height:8,
                                      borderRadius:'50%',
                                      background:'var(--amber)',
                                      border:'1px solid var(--bg-1)',
                                    }}
                                  />
                                )}
                                {/* Edge grips — drag to extend/shorten the stay by its edge
                                    (left = check-in, right = check-out). Reservations only. */}
                                {/* Visual resize-handle cues only — the bar's own onDragStart
                                    reads the grab position to choose resize vs move, so these
                                    must not intercept the pointer. */}
                                {!isLease && isStart && (
                                  <span aria-hidden
                                    title="Drag this edge to change check-in"
                                    style={{position:'absolute', left:0, top:0, bottom:0, width:10, cursor:'ew-resize', borderRadius:'6px 0 0 6px', background:'rgba(0,0,0,.3)', pointerEvents:'none'}}
                                  />
                                )}
                                {!isLease && isEnd && (
                                  <span aria-hidden
                                    title="Drag this edge to change check-out"
                                    style={{position:'absolute', right:0, top:0, bottom:0, width:10, cursor:'ew-resize', borderRadius:'0 6px 6px 0', background:'rgba(0,0,0,.3)', pointerEvents:'none'}}
                                  />
                                )}
                              </div>
                            )
                          })()
                        ) : (
                          <div
                            style={{height:24, background: unit.isBookable ? 'transparent' : 'var(--bg-3)', borderRadius:3, opacity:.3}}
                          />
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
              {filteredUnits.length===0 && (
                <tr><td colSpan={days.length+1} style={{textAlign:'center',padding:48,color:'var(--text-3)'}}>No units found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div ref={legendRef} style={{padding:'8px 12px',fontSize:'.72rem',color:'var(--text-3)',display:'flex',gap:16,borderTop:'1px solid var(--border-1)',background:'var(--bg-2)',borderRadius:'0 0 12px 12px',flexShrink:0}}>
          <span><span style={{display:'inline-block',width:12,height:12,background:'var(--green)',borderRadius:2,marginRight:4}}/>Reservation (draggable)</span>
          <span><span style={{display:'inline-block',width:12,height:12,background:'var(--blue)',borderRadius:2,marginRight:4}}/>🔒 Lease (managed on Leases page)</span>
          <span><span style={{display:'inline-block',width:12,height:12,background:'var(--gold)',borderRadius:2,opacity:.3,marginRight:4}}/>Today</span>
          <span><span style={{display:'inline-block',width:8,height:8,borderRadius:'50%',background:'var(--amber)',marginRight:4,verticalAlign:'middle'}}/>Ack pending</span>
          <span>· Double-click empty cell to book · Drag block to move · Drag an edge to extend/shorten</span>
        </div>
        </div>
      )}

      {/* ── LIST VIEW ── */}
      {!isLoading && view==='list' && (() => {
        // S527 W-23: next incoming at the top; longer-term / already-arrived
        // below a divider. (Dates dayOnly-sliced per the ISO-timestamp rule —
        // the old rows built Invalid Dates.)
        const todayStr = today
        const live = bookings.filter(b => !['cancelled','no_show'].includes(b.status))
        const arriving = live
          .filter(b => dayOnly(b.checkIn) > todayStr && b.status !== 'checked_out')
          .sort((a, b) => dayOnly(a.checkIn).localeCompare(dayOnly(b.checkIn)))
        const inHouse = live
          .filter(b => dayOnly(b.checkIn) <= todayStr && dayOnly(b.checkOut) > todayStr && b.status !== 'checked_out')
          .sort((a, b) => dayOnly(a.checkOut).localeCompare(dayOnly(b.checkOut)))
        const past = bookings.filter(b => !arriving.includes(b) && !inHouse.includes(b))
        const divider = (label: string) => (
          <div style={{display:'flex',alignItems:'center',gap:10,margin:'6px 0 -2px'}}>
            <span style={{fontSize:'.7rem',fontWeight:700,color:'var(--text-3)',textTransform:'uppercase',letterSpacing:'.08em'}}>{label}</span>
            <div style={{flex:1,height:1,background:'var(--border-0)'}} />
          </div>
        )
        const bookingCard = (b: any) => (
          <div key={b.id} className="card" style={{display:'flex',alignItems:'center',gap:16}}>
            <div style={{width:4,background:'var(--green)',borderRadius:2,alignSelf:'stretch'}} />
            <div style={{flex:1}}>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                <span style={{fontWeight:600,fontSize:'.88rem'}}>{b.unitNumber}</span>
                <span style={{fontSize:'.72rem',color:'var(--text-3)'}}>{b.propertyName}</span>
                <span className="badge badge-green" style={{fontSize:'.65rem'}}>{LEASE_TYPE_LABELS[b.leaseType] || humanize(b.leaseType)}</span>
                <span className={`badge ${STATUS_COLORS[b.status]||'badge-muted'}`} style={{fontSize:'.65rem'}}>{humanize(b.status)}</span>
              </div>
              <div style={{fontSize:'.82rem',color:'var(--text-2)'}}>
                {b.guestName||'Guest'} · {new Date(dayOnly(b.checkIn)+'T12:00:00').toLocaleDateString()} — {new Date(dayOnly(b.checkOut)+'T12:00:00').toLocaleDateString()} ({b.nights} nights)
              </div>
              {b.guestEmail && <div style={{fontSize:'.75rem',color:'var(--text-3)'}}>{b.guestEmail} · {b.guestPhone||''}</div>}
            </div>
            <div style={{textAlign:'right',display:'flex',flexDirection:'column',alignItems:'flex-end',gap:6}}>
              <div style={{fontWeight:700,color:'var(--gold)'}}>{fmt(b.totalAmount)}</div>
              {can('guest_access') && !['cancelled','checked_out','no_show'].includes(b.status) && (
                <button className="btn btn-ghost btn-sm" style={{fontSize:'.68rem',padding:'3px 8px',whiteSpace:'nowrap'}}
                  onClick={()=>openGuestAccess(b)}>Guest link</button>
              )}
            </div>
          </div>
        )
        return (
        <div style={{display:'grid',gap:12}}>
          {bookings.length===0 && leases.length===0 && <div className="card" style={{textAlign:'center',padding:48,color:'var(--text-3)'}}>No bookings or leases in this date range.</div>}
          {arriving.length > 0 && divider(`Arriving soon (${arriving.length})`)}
          {arriving.map(bookingCard)}
          {(inHouse.length > 0 || leases.length > 0) && divider(`Currently here (${inHouse.length + leases.length})`)}
          {inHouse.map(bookingCard)}
          {leases.map(l => (
            <div key={l.id} className="card" style={{display:'flex',alignItems:'center',gap:16}}>
              <div style={{width:4,background:'var(--blue)',borderRadius:2,alignSelf:'stretch'}} />
              <div style={{flex:1}}>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                  <span style={{fontWeight:600,fontSize:'.88rem'}}>{l.unitNumber}</span>
                  <span style={{fontSize:'.72rem',color:'var(--text-3)'}}>{l.propertyName}</span>
                  <span className="badge badge-blue" style={{fontSize:'.65rem'}}>lease</span>
                </div>
                <div style={{fontSize:'.82rem',color:'var(--text-2)'}}>
                  {l.firstName} {l.lastName} · {new Date(dayOnly(l.startDate)+'T12:00:00').toLocaleDateString()} — {l.endDate ? new Date(dayOnly(l.endDate)+'T12:00:00').toLocaleDateString() : 'ongoing'}
                </div>
              </div>
              <div style={{textAlign:'right'}}>
                <div style={{fontWeight:700,color:'var(--gold)'}}>{fmt(l.rentAmount)}/mo</div>
              </div>
            </div>
          ))}
          {past.length > 0 && divider(`Past / cancelled (${past.length})`)}
          {past.map(bookingCard)}
        </div>
        )
      })()}

      {/* ── UNITS VIEW ── */}
      {!isLoading && view==='units' && (
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:12}}>
          {filteredUnits.map(unit => (
            <div key={unit.id} className="card">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:10}}>
                <div>
                  <div style={{fontWeight:700,fontSize:'.95rem'}}>{unit.unitNumber}</div>
                  <div style={{fontSize:'.72rem',color:TYPE_COLORS[unit.unitType]||'var(--text-3)',marginTop:2}}>{UNIT_TYPE_LABELS[unit.unitType]||humanize(unit.unitType)}</div>
                  <div style={{fontSize:'.7rem',color:'var(--text-3)'}}>{unit.propertyName}</div>
                </div>
                <div style={{display:'flex',gap:4,flexDirection:'column',alignItems:'flex-end'}}>
                  <span className={`badge ${unit.status==='active'?'badge-green':unit.status==='vacant'?'badge-muted':'badge-amber'}`}>{humanize(unit.status)}</span>
                  {unit.isBookable && <span className="badge badge-green" style={{fontSize:'.6rem'}}>Bookable</span>}
                </div>
              </div>
              <div style={{fontSize:'.78rem',display:'grid',gap:3,marginBottom:10}}>
                {unit.nightlyRate && <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Nightly</span><span style={{color:'var(--gold)',fontWeight:600}}>{fmt(unit.nightlyRate)}</span></div>}
                {unit.weeklyRate && <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Weekly</span><span style={{color:'var(--gold)',fontWeight:600}}>{fmt(unit.weeklyRate)}</span></div>}
                {unit.rentAmount && <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Monthly</span><span style={{fontWeight:600}}>{fmt(unit.rentAmount)}</span></div>}
                {unit.tenantFirst && <div style={{display:'flex',justifyContent:'space-between'}}><span style={{color:'var(--text-3)'}}>Tenant</span><span>{unit.tenantFirst} {unit.tenantLast}</span></div>}
              </div>
              {unit.leaseTypesAllowed?.length > 0 && (
                <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:10}}>
                  {unit.leaseTypesAllowed.map((lt:string) => (
                    <span key={lt} style={{fontSize:'.62rem',background:'var(--bg-3)',border:'1px solid var(--border-1)',borderRadius:3,padding:'1px 5px',color:'var(--text-3)'}}>{LEASE_TYPE_LABELS[lt]||humanize(lt)}</span>
                  ))}
                </div>
              )}
              {unit.unitDescription && <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:10,lineHeight:1.5}}>{unit.unitDescription}</div>}
              <div style={{display:'flex',gap:6}}>
                {can('schedule.configure_unit') && <button className="btn btn-ghost btn-sm" style={{flex:1}} onClick={()=>openTypeModal(unit)}>⚙ Configure</button>}
                {unit.isBookable && can('schedule.create_reservation') && <button className="btn btn-primary btn-sm" style={{flex:1}} onClick={()=>openBookingModal(unit)}>+ Book</button>}
              </div>
            </div>
          ))}
          {filteredUnits.length===0 && <div style={{gridColumn:'1/-1',textAlign:'center',padding:48,color:'var(--text-3)'}}>No units found.</div>}
        </div>
      )}

      {/* ── HISTORY VIEW ── reservation change log */}
      {view==='history' && (
        <div className="card" style={{padding:0,maxHeight:'calc(100vh - 200px)',overflowY:'auto'}}>
          <div style={{padding:'10px 16px',borderBottom:'1px solid var(--border-1)',fontWeight:600,fontSize:'.82rem'}}>Reservation change history</div>
          {history.length===0 ? (
            <div style={{padding:48,textAlign:'center',color:'var(--text-3)'}}>No reservation changes yet.</div>
          ) : history.map((e:any) => {
            const COLORS:Record<string,string> = { created:'var(--green)', moved:'var(--blue)', dates_changed:'var(--gold)', status_changed:'var(--amber)', cancelled:'var(--red)' }
            const LABELS:Record<string,string> = { created:'Created', moved:'Moved', dates_changed:'Dates', status_changed:'Status', cancelled:'Cancelled' }
            return (
              <div key={e.id} style={{display:'flex',gap:12,alignItems:'center',padding:'9px 16px',borderBottom:'1px solid var(--border-1)'}}>
                <span style={{fontSize:'.6rem',fontWeight:700,color:'#fff',background:COLORS[e.eventType]||'var(--text-3)',borderRadius:4,padding:'2px 7px',minWidth:64,textAlign:'center'}}>{LABELS[e.eventType]||e.eventType}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:'.82rem'}}>{e.summary}</div>
                  <div style={{fontSize:'.68rem',color:'var(--text-3)'}}>
                    Unit {e.unitNumber} · {e.propertyName}
                    {e.actorFirst ? ` · by ${e.actorFirst} ${e.actorLast||''}` : ''}
                  </div>
                </div>
                <span style={{fontSize:'.68rem',color:'var(--text-3)',whiteSpace:'nowrap'}}>{new Date(e.createdAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* ── RESERVATIONS VIEW ── filterable flat table (ported from Bookings) */}
      {view==='reservations' && (
        <div>
          {/* Filters */}
          <div className="card" style={{ padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Search guest</label>
                <div style={{ position: 'relative' }}>
                  <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                  <input value={resvSearch} onChange={e => setResvSearch(e.target.value)} placeholder="name or email" className="input" style={{ paddingLeft: 32 }} />
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Status</label>
                <select value={resvStatus} onChange={e => setResvStatus(e.target.value)} className="input">
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
                <select value={resvSource} onChange={e => setResvSource(e.target.value)} className="input">
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
                <input type="date" value={resvFrom} onChange={e => setResvFrom(e.target.value)} className="input" />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>To</label>
                <input type="date" value={resvTo} onChange={e => setResvTo(e.target.value)} className="input" />
              </div>
            </div>
          </div>

          {pendingAckCount > 0 && (
            <div
              className="card"
              style={{
                padding: '10px 14px', marginBottom: 12,
                background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.3)',
                display: 'flex', alignItems: 'center', gap: 10,
              }}
            >
              <AlertTriangle size={16} style={{ color: 'var(--amber)' }} />
              <span style={{ fontSize: '.85rem', color: 'var(--text-1)' }}>
                <strong>{pendingAckCount}</strong> reservation{pendingAckCount === 1 ? '' : 's'} need{pendingAckCount === 1 ? 's' : ''} property-rules acknowledgment.
                Click <FileSignature size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> on each row after collecting the guest's signature.
              </span>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, padding: '0 4px' }}>
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>{resvList.length} reservations</div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>
              Total revenue: <strong style={{ color: 'var(--text-0)' }}>{fmt(resvTotalAmount)}</strong>
            </div>
          </div>

          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            {resvLoading ? (
              <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
            ) : resvList.length === 0 ? (
              <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>
                No reservations match the filters.
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
                    <th>Stay Link</th>
                  </tr>
                </thead>
                <tbody>
                  {resvList.map(b => (
                    <tr key={b.id}>
                      <td><span className={`badge ${RESV_STATUS_BADGE[b.status] || 'badge-muted'}`}>{humanize(b.status)}</span></td>
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
                        <span style={{ fontSize: '.72rem', color: 'var(--text-2)' }}>
                          {humanize(b.source)}
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
                        ) : needsAckResv(b) && can('bookings.acknowledge') ? (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => ackMut.mutate(b)}
                            disabled={ackMut.isLoading}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--amber)' }}
                            title="Mark this reservation as having a signed property-rules acknowledgment"
                          >
                            <FileSignature size={12} />
                            Acknowledge
                          </button>
                        ) : (
                          <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>n/a</span>
                        )}
                      </td>
                      <td>
                        {can('guest_access') && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => setLinkBooking(b)}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                            title="Show the guest stay-assistant link and QR, or revoke access"
                          >
                            <QrCode size={12} /> Stay link
                          </button>
                        )}
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
      )}

      {/* ── REQUESTS VIEW ── guest change-requests (ported from Bookings) */}
      {view==='requests' && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <MessageSquare size={16} style={{ color: 'var(--gold)' }} />
            <strong style={{ fontSize: '.9rem' }}>Guest requests</strong>
            {changeRequests.length > 0 && <span className="badge badge-blue" style={{ marginLeft: 2 }}>{changeRequests.length}</span>}
          </div>
          {changeRequests.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: '.84rem' }}>No open guest requests.</div>
          ) : (
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
                  {can('bookings.resolve_change_request') && (
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
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── BOOKING PAGE VIEW ── public per-property booking-site config (ported from BookingSitesPage) */}
      {view==='booking_page' && (
        <div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: '.9rem', fontWeight: 700 }}>Booking Page</div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>Public per-property booking pages — guests book short stays and pay a deposit</div>
          </div>

          <div className="card" style={{ padding: 16, maxWidth: 560 }}>
            <label className="form-label">Property</label>
            <select className="input" value={bpPropId} onChange={e => setBpPropId(e.target.value)} style={{ marginBottom: 16 }}>
              {bpProperties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>

            {!bpCfg ? <div style={{ color: 'var(--text-3)' }}>Loading…</div> : (
              <>
                <label className="form-label">Booking address (slug)</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <input className="input" value={bpCfg.slug || ''} placeholder="oak-park-yarnell"
                    onChange={e => setBpCfg((c: any) => ({ ...c, slug: e.target.value.toLowerCase() }))} style={{ flex: 1 }} />
                </div>
                <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 14 }}>
                  Lowercase letters, numbers, hyphens. Your site: {bpPublicUrl
                    ? <a href={bpPublicUrl} target="_blank" rel="noreferrer">{bpPublicUrl}</a>
                    : '— set a slug first'}
                </div>

                <label className="form-label">Welcome text (optional)</label>
                <textarea className="input" rows={3} value={bpCfg.intro || ''}
                  onChange={e => setBpCfg((c: any) => ({ ...c, intro: e.target.value }))} style={{ marginBottom: 14, resize: 'vertical' }} />

                <div style={{ borderTop: '1px solid var(--border-1)', margin: '6px 0 14px' }} />
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Stay rates</div>
                <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 10 }}>
                  Used for every reservation at this property (Master Schedule + booking site). The rate tier
                  follows the length of stay — under 7 nights nightly, 7–29 weekly, 30+ monthly — prorated for
                  odd lengths.
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
                  <div>
                    <label className="form-label">Nightly ($)</label>
                    <input className="input" type="number" min={0} value={bpCfg.nightlyRate ?? ''} placeholder="—"
                      onChange={e => setBpCfg((c: any) => ({ ...c, nightlyRate: e.target.value }))} />
                  </div>
                  <div>
                    <label className="form-label">Weekly ($)</label>
                    <input className="input" type="number" min={0} value={bpCfg.weeklyRate ?? ''} placeholder="—"
                      onChange={e => setBpCfg((c: any) => ({ ...c, weeklyRate: e.target.value }))} />
                  </div>
                  <div>
                    <label className="form-label">Monthly ($)</label>
                    <input className="input" type="number" min={0} value={bpCfg.monthlyRate ?? ''} placeholder="—"
                      onChange={e => setBpCfg((c: any) => ({ ...c, monthlyRate: e.target.value }))} />
                  </div>
                </div>

                <label className="form-label">Short-term lodging tax (% — applied to stays under 30 nights; 30+ is tax-exempt)</label>
                <input className="input" type="number" min={0} max={100} value={bpCfg.shortTermTaxRate ?? 0}
                  onChange={e => setBpCfg((c: any) => ({ ...c, shortTermTaxRate: e.target.value }))} style={{ marginBottom: 16, maxWidth: 140 }} />

                <div style={{ borderTop: '1px solid var(--border-1)', margin: '6px 0 14px' }} />
                <label className="form-label">Deposit for short stays (% of stay total — stays under 30 nights)</label>
                <input className="input" type="number" min={0} max={100} value={bpCfg.depositPct}
                  onChange={e => setBpCfg((c: any) => ({ ...c, depositPct: e.target.value }))} style={{ marginBottom: 14, maxWidth: 140 }} />

                <label className="form-label">Deposit for monthly stays ($ flat — 30+ nights)</label>
                <input className="input" type="number" min={0} value={bpCfg.monthlyDeposit ?? ''} placeholder="150"
                  onChange={e => setBpCfg((c: any) => ({ ...c, monthlyDeposit: e.target.value }))} style={{ marginBottom: 4, maxWidth: 140 }} />
                <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 16 }}>
                  Blank = $150 default. Always capped at one month's rent — long-term guests never owe more than a month up front.
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, cursor: 'pointer' }}>
                  <input type="checkbox" checked={bpCfg.utilitiesBilled !== false} onChange={e => setBpCfg((c: any) => ({ ...c, utilitiesBilled: e.target.checked }))} />
                  <span>Utilities billed back on monthly stays (quote shows "plus utilities")</span>
                </label>

                <div style={{ borderTop: '1px solid var(--border-1)', margin: '6px 0 14px' }} />
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Contact page</div>
                <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 10 }}>
                  Shown on the website's Contact page with the property address and the message form.
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                  <div>
                    <label className="form-label">Office phone</label>
                    <input className="input" value={bpCfg.officePhone ?? ''} placeholder="(555) 555-0100"
                      onChange={e => setBpCfg((c: any) => ({ ...c, officePhone: e.target.value }))} />
                  </div>
                  <div>
                    <label className="form-label">Office email</label>
                    <input className="input" type="email" value={bpCfg.officeEmail ?? ''} placeholder="office@yourpark.com"
                      onChange={e => setBpCfg((c: any) => ({ ...c, officeEmail: e.target.value }))} />
                  </div>
                </div>
                <label className="form-label">Office hours</label>
                <textarea className="input" rows={3} value={bpCfg.officeHours ?? ''}
                  placeholder={'Mon–Fri 9am–5pm\nSat 10am–2pm\nClosed Sunday'}
                  onChange={e => setBpCfg((c: any) => ({ ...c, officeHours: e.target.value }))} style={{ marginBottom: 16, resize: 'vertical' }} />

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!bpCfg.enabled} onChange={e => setBpCfg((c: any) => ({ ...c, enabled: e.target.checked }))} />
                  <span><b>Publish</b> this booking site (live to the public)</span>
                </label>

                {can('booking_sites.edit') && <button className="btn" disabled={bpSaving} onClick={saveBookingConfig}>{bpSaving ? 'Saving…' : 'Save'}</button>}
                {bpMsg && <span style={{ color: 'var(--green)', marginLeft: 12 }}>{bpMsg}</span>}
                {bpErr && <span style={{ color: 'var(--red,#ff6b81)', marginLeft: 12 }}>{bpErr}</span>}
              </>
            )}
          </div>

          {/* ── S547: website photos ── */}
          {bpCfg && (
            <div className="card" style={{ padding: 16, maxWidth: 560, marginTop: 14 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Website photos</div>
              <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 12 }}>
                Shown in the Gallery and on the home page of this property’s website. JPEG/PNG/WebP, up to 10 MB each.
              </div>
              {can('booking_sites.edit') && (
                <label className="btn" style={{ display: 'inline-block', marginBottom: 12, cursor: 'pointer' }}>
                  {bpUploading ? 'Uploading…' : 'Add photos'}
                  <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden
                    disabled={bpUploading}
                    onChange={e => { uploadSitePhotos(e.target.files); e.target.value = '' }} />
                </label>
              )}
              {bpPhotos.length === 0 ? (
                <div style={{ color: 'var(--text-3)', fontSize: '.85rem' }}>No photos yet.</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                  {bpPhotos.map((ph: any) => (
                    <div key={ph.id}>
                      <AuthThumb url={`/properties/${bpPropId}/site-photos/${ph.id}/file`} />
                      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', margin: '4px 0', minHeight: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ph.caption || '—'}</div>
                      {can('booking_sites.edit') && (
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: '.72rem' }} onClick={() => captionSitePhoto(ph.id, ph.caption)}>Caption</button>
                          <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: '.72rem' }} onClick={() => deleteSitePhoto(ph.id)}>Remove</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── S547: website FAQs ── */}
          {bpCfg && (
            <div className="card" style={{ padding: 16, maxWidth: 560, marginTop: 14 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Website FAQ</div>
              <div style={{ color: 'var(--text-3)', fontSize: '.8rem', marginBottom: 12 }}>
                Questions guests ask before booking — office hours, pets, rig limits, cancellation policy.
              </div>
              {bpFaqs.map((f: any) => (
                <div key={f.id} style={{ borderTop: '1px solid var(--border-1)', padding: '10px 0' }}>
                  <div style={{ fontWeight: 600, fontSize: '.88rem' }}>{f.question}</div>
                  <div style={{ color: 'var(--text-3)', fontSize: '.84rem', whiteSpace: 'pre-wrap', margin: '4px 0 6px' }}>{f.answer}</div>
                  {can('booking_sites.edit') && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: '.72rem' }} onClick={() => editFaq(f)}>Edit</button>
                      <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: '.72rem' }} onClick={() => deleteFaq(f.id)}>Delete</button>
                    </div>
                  )}
                </div>
              ))}
              {bpFaqs.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: '.85rem', marginBottom: 10 }}>No FAQs yet.</div>}
              {can('booking_sites.edit') && (
                <div style={{ borderTop: '1px solid var(--border-1)', paddingTop: 12, marginTop: 6 }}>
                  <label className="form-label">Question</label>
                  <input className="input" value={bpFaqDraft.question}
                    onChange={e => setBpFaqDraft(d => ({ ...d, question: e.target.value }))} style={{ marginBottom: 8 }} />
                  <label className="form-label">Answer</label>
                  <textarea className="input" rows={3} value={bpFaqDraft.answer}
                    onChange={e => setBpFaqDraft(d => ({ ...d, answer: e.target.value }))} style={{ marginBottom: 10, resize: 'vertical' }} />
                  <button className="btn" disabled={!bpFaqDraft.question.trim() || !bpFaqDraft.answer.trim()} onClick={addFaq}>Add FAQ</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── RESERVATION DETAIL ── click a bar to view */}
      {detailBooking && (() => {
        const d = detailBooking
        const isLease = !!d.isLease
        // S527 W-18: dates arrive as full ISO timestamps — dayOnly-slice BEFORE
        // any display or math (the old `new Date(iso + 'T12:00:00')` built an
        // Invalid Date and rendered "NaN nights").
        const start = dayOnly(isLease ? d.startDate : d.checkIn)
        const end = (isLease ? d.endDate : d.checkOut) ? dayOnly(isLease ? d.endDate : d.checkOut) : null
        const nights = (start && end) ? Math.max(0, Math.round((new Date(end+'T12:00:00').getTime()-new Date(start+'T12:00:00').getTime())/86400000)) : (d.nights||0)
        const fmtDay = (s: string | null) => s ? new Date(s+'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null
        const name = isLease ? `${d.firstName||''} ${d.lastName||''}`.trim() : (d.guestName || 'Guest')
        // W-18: payment state — paid in full, deposit-only (show balance), or unpaid.
        const total = d.totalAmount != null ? Number(d.totalAmount) : null
        const depositPaid = !isLease && !!d.depositPaidAt && d.depositAmount != null ? Number(d.depositAmount) : null
        const closeDetail = () => { setDetailBooking(null); setEditForm(null); setEditError('') }
        const isEditing = !isLease && !!editForm
        // Live re-price preview while editing (unit rate → property default).
        const eu = isEditing ? units.find((u:any)=>u.id===editForm!.unitId) : null
        const eNights = isEditing && editForm!.checkIn && editForm!.checkOut && editForm!.checkOut>editForm!.checkIn
          ? Math.round((new Date(editForm!.checkOut+'T12:00:00').getTime()-new Date(editForm!.checkIn+'T12:00:00').getTime())/86400000) : 0
        const ePrice = eu ? computeStayPrice(
          { nightly: eu.nightlyRate ?? eu.propertyNightlyRate, weekly: eu.weeklyRate ?? eu.propertyWeeklyRate, monthly: eu.monthlyRate ?? eu.propertyMonthlyRate },
          Number(eu.propertyTaxRate || 0), eNights) : null
        const editValid = isEditing && eNights > 0 && !!editForm!.guestName.trim()
        // W-19: filter-first — options are the server's available+compatible
        // list; the current unit always stays so the selection can't vanish
        // (the mismatch warning below covers it if it no longer qualifies).
        const availIds = editAvailableUnits ? new Set((editAvailableUnits as any[]).filter((u:any)=>u.isBookable).map((u:any)=>u.id)) : null
        const unitOptions = units.filter((u:any)=> (availIds ? availIds.has(u.id) : u.isBookable) || u.id===editForm?.unitId)
        const editReasons = isEditing ? rvMismatchReasons(editForm!.requiredSiteLayout, editForm!.requiredAmpService, eu) : []
        return (
        <div className="modal-overlay" onClick={closeDetail}>
          <div className="modal" style={{maxWidth:440}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{isEditing ? 'Edit reservation' : (isLease ? 'Lease' : 'Reservation')} · {name||'—'}</span>
              <button className="btn btn-ghost btn-sm" onClick={closeDetail}>✕</button>
            </div>
            <div style={{padding:'4px 24px 24px'}}>
              {isEditing ? (
                <div style={{display:'grid',gap:12}}>
                  <div>
                    <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Unit</div>
                    <select className="form-input" style={{width:'100%'}} value={editForm!.unitId} onChange={e=>setEditForm(s=>s&&({...s,unitId:e.target.value}))}>
                      {unitOptions.map((u:any)=><option key={u.id} value={u.id}>{u.unitNumber} · {u.propertyName}{u.rvSiteLayout && u.rvSiteLayout!=='none' ? ` (${RV_SITE_LAYOUT_LABEL[u.rvSiteLayout as keyof typeof RV_SITE_LAYOUT_LABEL]})` : ''}</option>)}
                    </select>
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                    <div>
                      <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Required site layout</div>
                      <select className="form-input" style={{width:'100%'}} value={editForm!.requiredSiteLayout} onChange={e=>setEditForm(s=>s&&({...s,requiredSiteLayout:e.target.value}))}>
                        {RV_SITE_LAYOUTS.map(l=><option key={l} value={l}>{l==='none'?'No preference':RV_SITE_LAYOUT_LABEL[l]}</option>)}
                      </select>
                    </div>
                    <div>
                      <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Required amp service</div>
                      <select className="form-input" style={{width:'100%'}} value={editForm!.requiredAmpService} onChange={e=>setEditForm(s=>s&&({...s,requiredAmpService:e.target.value}))}>
                        {RV_AMP_SERVICES.filter(a=>a!=='both').map(a=><option key={a} value={a}>{a==='none'?'No preference':RV_AMP_SERVICE_LABEL[a]}</option>)}
                      </select>
                    </div>
                  </div>
                  {editReasons.length>0 && <div style={{fontSize:'.7rem',color:'var(--amber)'}}>⚠ Unit {eu?.unitNumber}: {editReasons.join('; ')}. You can still save.</div>}
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                    <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Check-in</div><input className="form-input" type="date" style={{width:'100%'}} value={editForm!.checkIn} onChange={e=>setEditForm(s=>s&&({...s,checkIn:e.target.value}))} /></div>
                    <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Check-out</div><input className="form-input" type="date" style={{width:'100%'}} value={editForm!.checkOut} onChange={e=>setEditForm(s=>s&&({...s,checkOut:e.target.value}))} /></div>
                  </div>
                  <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Guest name</div><input className="form-input" style={{width:'100%'}} value={editForm!.guestName} onChange={e=>setEditForm(s=>s&&({...s,guestName:e.target.value}))} /></div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                    <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Email</div><input className="form-input" style={{width:'100%'}} value={editForm!.guestEmail} onChange={e=>setEditForm(s=>s&&({...s,guestEmail:e.target.value}))} /></div>
                    <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Phone</div><input className="form-input" style={{width:'100%'}} value={editForm!.guestPhone} onChange={e=>setEditForm(s=>s&&({...s,guestPhone:e.target.value}))} /></div>
                  </div>
                  <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Notes</div><textarea className="form-input" style={{width:'100%',minHeight:54}} value={editForm!.notes} onChange={e=>setEditForm(s=>s&&({...s,notes:e.target.value}))} /></div>
                  {ePrice && <div style={{fontSize:'.78rem',color:'var(--text-3)'}}>{eNights} night{eNights===1?'':'s'} · new total <span style={{color:'var(--gold)',fontWeight:600}}>{fmt(ePrice.total)}</span></div>}
                  {editError && <div style={{fontSize:'.76rem',color:'var(--red,#ff6b81)'}}>{editError}</div>}
                  <div style={{display:'flex',gap:8,marginTop:4}}>
                    <button className="btn btn-ghost btn-sm" onClick={()=>{setEditForm(null);setEditError('')}}>Cancel</button>
                    <button className="btn btn-primary btn-sm" style={{marginLeft:'auto'}} disabled={!editValid || editBookingMut.isLoading}
                      onClick={()=>editBookingMut.mutate({orig:d, form:editForm!})}>
                      {editBookingMut.isLoading?'Saving…':'Save changes'}
                    </button>
                  </div>
                </div>
              ) : (<>
              {/* S527 W-18/W-55: ONE window shape for every bar type — same
                  fields for leases and stays; clean day-only dates. */}
              <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:'8px 14px',fontSize:'.84rem'}}>
                <div style={{color:'var(--text-3)'}}>Unit</div><div>{d.unitNumber} · {d.propertyName}</div>
                <div style={{color:'var(--text-3)'}}>{isLease?'Term':'Stay'}</div><div>{fmtDay(start)} → {end ? fmtDay(end) : 'ongoing'} {end ? <span style={{color:'var(--text-3)'}}>({nights} night{nights===1?'':'s'})</span> : null}</div>
                {(d.guestEmail || d.email) && <><div style={{color:'var(--text-3)'}}>Email</div><div>{d.guestEmail || d.email}</div></>}
                {(d.guestPhone || d.phone) && <><div style={{color:'var(--text-3)'}}>Phone</div><div>{d.guestPhone || d.phone}</div></>}
                {isLease && d.rentAmount != null && <><div style={{color:'var(--text-3)'}}>Rent</div><div style={{color:'var(--gold)',fontWeight:600}}>{fmt(d.rentAmount)}/mo</div></>}
                {!isLease && total != null && (
                  <><div style={{color:'var(--text-3)'}}>Payment</div>
                  <div>
                    {depositPaid != null ? (
                      <>Deposit <strong>{fmt(depositPaid)}</strong> paid · <span style={{color:'var(--amber)',fontWeight:600}}>balance due {fmt(Math.max(0, total - depositPaid))}</span></>
                    ) : (
                      <>Total <span style={{color:'var(--gold)',fontWeight:600}}>{fmt(total)}</span> <span style={{color:'var(--text-3)'}}>· no payment recorded</span></>
                    )}
                  </div></>
                )}
                <div style={{color:'var(--text-3)'}}>Status</div><div>{humanize(d.status)}</div>
                {d.notes && <><div style={{color:'var(--text-3)'}}>Notes</div><div>{d.notes}</div></>}
              </div>
              {isLease ? (
                <div style={{marginTop:16,fontSize:'.78rem',color:'var(--text-3)'}}>Leases are managed on the Leases page.</div>
              ) : (
                <div style={{display:'flex',gap:8,marginTop:18}}>
                  {can('guest_access') && <button className="btn btn-ghost btn-sm" onClick={()=>copyStayLink(d)}>Copy stay link</button>}
                  {can('schedule.edit_reservation') && d.status!=='cancelled' && <button className="btn btn-ghost btn-sm" onClick={()=>startEdit(d)}>Edit</button>}
                  {/* S547: snowbird lock — pin the stay to this exact site, exempt from auto re-siting */}
                  {can('schedule.edit_reservation') && d.status!=='cancelled' && (
                    <button className="btn btn-ghost btn-sm"
                      style={d.lockedToUnit ? { color: 'var(--gold)', borderColor: 'var(--gold)' } : undefined}
                      disabled={lockBookingMut.isLoading}
                      title={d.lockedToUnit
                        ? 'Locked to this site — automatic scheduling will never move it. Click to unlock.'
                        : 'Lock this reservation to its site (e.g. a returning snowbird) — exempt from automatic re-siting.'}
                      onClick={()=>lockBookingMut.mutate(d)}>
                      {lockBookingMut.isLoading ? '…' : d.lockedToUnit ? '🔒 Locked to site' : 'Lock to site'}
                    </button>
                  )}
                  {can('schedule.edit_reservation') && (
                    <button className="btn btn-sm" style={{marginLeft:'auto',color:'var(--red,#ff6b81)',borderColor:'var(--red,#ff6b81)'}}
                      disabled={cancelBookingMut.isLoading || d.status==='cancelled'}
                      onClick={()=>{ appConfirm('Cancel this reservation?', { danger: true, confirmLabel: 'Cancel reservation' }).then(ok => { if (ok) cancelBookingMut.mutate(d) }) }}>
                      {cancelBookingMut.isLoading?'Cancelling…':'Cancel reservation'}
                    </button>
                  )}
                </div>
              )}
              </>)}
            </div>
          </div>
        </div>
        )
      })()}

      {/* ── NEW RESERVATION MODAL — dates → contact → pick available unit ── */}
      {newResvOpen && (() => {
        const validEmail = /.+@.+\..+/.test(newBooking.guestEmail.trim())
        const hasContact = !!resvFirst.trim() && !!resvLast.trim() && validEmail && !!newBooking.guestPhone.trim()
        return (
        <div className="modal-overlay" onClick={closeNewResv}>
          <div className="modal" style={{maxWidth:540}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">New Reservation</span>
              <button className="btn btn-ghost btn-sm" onClick={closeNewResv}>✕</button>
            </div>
            <div style={{padding:'4px 24px 24px',display:'grid',gap:18}}>

              {/* 1 · Dates */}
              <div>
                <div style={{fontSize:'.72rem',fontWeight:700,color:'var(--gold)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:8}}>1 · Dates</div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                  <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Check-in</div><input className="form-input" type="date" style={{width:'100%'}} value={newBooking.checkIn} onChange={e=>setNewBooking(s=>({...s,checkIn:e.target.value}))} /></div>
                  <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Check-out</div><input className="form-input" type="date" style={{width:'100%'}} value={newBooking.checkOut} onChange={e=>setNewBooking(s=>({...s,checkOut:e.target.value}))} /></div>
                </div>
                {datesValid && <div style={{fontSize:'.72rem',color:'var(--text-3)',marginTop:6}}>{resvNights} night{resvNights===1?'':'s'} · billed {resvType==='month_to_month'?'monthly':resvType}</div>}
              </div>

              {/* 2 · Contact */}
              <div style={{opacity:datesValid?1:.5,pointerEvents:datesValid?'auto':'none'}}>
                <div style={{fontSize:'.72rem',fontWeight:700,color:'var(--gold)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:8}}>2 · Guest contact</div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                  <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>First name</div><input className="form-input" style={{width:'100%'}} value={resvFirst} onChange={e=>setResvFirst(e.target.value)} /></div>
                  <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Last name</div><input className="form-input" style={{width:'100%'}} value={resvLast} onChange={e=>setResvLast(e.target.value)} /></div>
                  <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Email</div><input className="form-input" type="email" style={{width:'100%'}} value={newBooking.guestEmail} onChange={e=>setNewBooking(s=>({...s,guestEmail:e.target.value}))} /></div>
                  <div><div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Phone</div><input className="form-input" style={{width:'100%'}} value={newBooking.guestPhone} onChange={e=>setNewBooking(s=>({...s,guestPhone:e.target.value}))} /></div>
                </div>
              </div>

              {/* Optional RV requirements: site layout + electrical service. */}
              <div style={{opacity:datesValid?1:.5,pointerEvents:datesValid?'auto':'none',display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                <div>
                  <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Required site layout (optional)</div>
                  <select className="form-select" style={{width:'100%'}} value={resvLayout} onChange={e=>setResvLayout(e.target.value)}>
                    {RV_SITE_LAYOUTS.map(l=><option key={l} value={l}>{l==='none'?'No preference':RV_SITE_LAYOUT_LABEL[l]}</option>)}
                  </select>
                </div>
                <div>
                  <div style={{fontSize:'.72rem',color:'var(--text-3)',marginBottom:4}}>Required amp service (optional)</div>
                  <select className="form-select" style={{width:'100%'}} value={resvAmp} onChange={e=>setResvAmp(e.target.value)}>
                    {RV_AMP_SERVICES.filter(a=>a!=='both').map(a=><option key={a} value={a}>{a==='none'?'No preference':RV_AMP_SERVICE_LABEL[a]}</option>)}
                  </select>
                </div>
              </div>

              {/* 3 · Pick an available unit → completes the reservation */}
              <div style={{opacity:(datesValid&&hasContact)?1:.5,pointerEvents:(datesValid&&hasContact)?'auto':'none'}}>
                <div style={{fontSize:'.72rem',fontWeight:700,color:'var(--gold)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:8}}>
                  3 · Pick a unit {datesValid&&hasContact && `· ${availableUnits.length} available`}
                </div>
                {!datesValid ? (
                  <div style={{fontSize:'.8rem',color:'var(--text-3)',padding:'12px',background:'var(--bg-3)',borderRadius:8}}>Choose dates first.</div>
                ) : !hasContact ? (
                  <div style={{fontSize:'.8rem',color:'var(--text-3)',padding:'12px',background:'var(--bg-3)',borderRadius:8}}>Fill in the guest's first &amp; last name, a valid email, and phone to see available units.</div>
                ) : availableUnits.length === 0 ? (
                  <div style={{padding:'12px',background:'var(--bg-3)',borderRadius:8}}>
                    <div style={{fontSize:'.82rem',color:'var(--amber)',fontWeight:600,marginBottom:8}}>All units are booked for those dates.</div>
                    <div style={{fontSize:'.76rem',color:'var(--text-3)',marginBottom:10}}>Add {resvGuestName||'this guest'} to the waitlist — they'll get a 1-hour claim link the moment a unit frees up.</div>
                    {!/.+@.+\..+/.test(newBooking.guestEmail.trim())
                      ? <div style={{fontSize:'.74rem',color:'var(--amber)'}}>Enter the guest's email above to add them to the waitlist (it's where the claim link is sent).</div>
                      : <button className="btn btn-primary btn-sm" onClick={()=>{ setResvError(''); waitlistMut.mutate() }} disabled={waitlistMut.isLoading}>
                          {waitlistMut.isLoading?'Adding…':'Add to waitlist'}
                        </button>}
                  </div>
                ) : (
                  <div style={{display:'grid',gap:8,maxHeight:260,overflowY:'auto'}}>
                    {availableUnits.map((u:any)=>{
                      const reasons = rvMismatchReasons(resvLayout, resvAmp, u)
                      const mismatch = reasons.length > 0
                      const pickUnit = async () => {
                        if (createResvMut.isLoading) return
                        if (mismatch && !(await appConfirm(`Unit ${u.unitNumber} doesn't match:\n· ${reasons.join('\n· ')}\n\nReserve it anyway?`, { confirmLabel: 'Reserve it' }))) return
                        setResvError(''); createResvMut.mutate(u)
                      }
                      const rvTags = u.unitType==='rv_spot'
                        ? [u.rvSiteLayout, u.rvAmpService].filter((x:string)=>x && x!=='none')
                            .map((x:string)=>(RV_SITE_LAYOUT_LABEL as any)[x] || (RV_AMP_SERVICE_LABEL as any)[x]).join(' · ')
                        : ''
                      return (
                        <div key={u.id}
                          onClick={pickUnit}
                          style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,padding:'11px 14px',background:'var(--bg-2)',border:`1px solid ${mismatch?'var(--amber)':'var(--border-1)'}`,borderRadius:10,cursor:'pointer'}}
                          onMouseEnter={e=>(e.currentTarget.style.borderColor='var(--gold)')}
                          onMouseLeave={e=>(e.currentTarget.style.borderColor=mismatch?'var(--amber)':'var(--border-1)')}>
                          <div>
                            <div style={{fontWeight:700,fontSize:'.9rem'}}>Unit {u.unitNumber}</div>
                            <div style={{fontSize:'.72rem',color:TYPE_COLORS[u.unitType]||'var(--text-3)'}}>{UNIT_TYPE_LABELS[u.unitType]||humanize(u.unitType)} · {u.propertyName}{rvTags ? ` · ${rvTags}` : ''}</div>
                            {mismatch && <div style={{fontSize:'.68rem',color:'var(--amber)',marginTop:2}}>⚠ {reasons.join('; ')}</div>}
                          </div>
                          {/* S526 (Nic): no pricing here — nobody pays on this
                              screen; the backend prices from the unit's rates. */}
                          <span className="btn btn-primary btn-sm" style={{pointerEvents:'none'}}>Reserve →</span>
                        </div>
                      )
                    })}
                  </div>
                )}
                {createResvMut.isLoading && <div style={{fontSize:'.78rem',color:'var(--text-3)',marginTop:8}}>Creating reservation…</div>}
                {resvError && <div style={{fontSize:'.78rem',color:'var(--red,#ff6b81)',marginTop:8}}>{resvError}</div>}
              </div>
            </div>
          </div>
        </div>
        )
      })()}

      {/* ── CONFIGURE UNIT TYPE MODAL ── */}
      {typeModal.show && (
        <div className="modal-overlay" onClick={()=>setTypeModal({show:false,unit:null})}>
          <div className="modal" style={{maxWidth:540}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Configure Unit — {typeModal.unit?.unitNumber}</span>
              <button className="btn btn-ghost btn-sm" onClick={()=>setTypeModal({show:false,unit:null})}>✕</button>
            </div>
            <div style={{padding:'0 24px 24px',display:'grid',gap:12}}>
              <div>
                <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Unit Type</div>
                <select className="form-select" style={{width:'100%'}} value={typeForm.unitType} onChange={e=>setTypeForm((s:any)=>({...s,unitType:e.target.value}))}>
                  {UNIT_TYPES.map(t=><option key={t} value={t}>{UNIT_TYPE_LABELS[t] || UNIT_TYPE_LABEL[t]}</option>)}
                </select>
              </div>
              {/* W-22: type-appropriate configuration — every field below is
                  gated by what the unit IS. Storage/commercial never rent by
                  the night: no rates, no stay knobs, no bookability. */}
              {typeForm.unitType==='rv_spot' && (
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                  <div>
                    <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>RV Site Layout</div>
                    <select className="form-select" style={{width:'100%'}} value={typeForm.rvSiteLayout||'none'} onChange={e=>setTypeForm((s:any)=>({...s,rvSiteLayout:e.target.value}))}>
                      {RV_SITE_LAYOUTS.map(l=><option key={l} value={l}>{RV_SITE_LAYOUT_LABEL[l]}</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Electrical Service</div>
                    <select className="form-select" style={{width:'100%'}} value={typeForm.rvAmpService||'none'} onChange={e=>setTypeForm((s:any)=>({...s,rvAmpService:e.target.value}))}>
                      {RV_AMP_SERVICES.map(a=><option key={a} value={a}>{RV_AMP_SERVICE_LABEL[a]}</option>)}
                    </select>
                  </div>
                </div>
              )}
              {(typeForm.unitType==='rv_spot' || typeForm.unitType==='mobile_home') && (
                <div>
                  {/* S550: drives the inspection checklist — site-only vs dwelling too */}
                  <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>{typeForm.unitType==='rv_spot' ? 'Who owns the RV?' : 'Who owns the home?'}</div>
                  <select className="form-select" style={{width:'100%'}} value={typeForm.dwellingOwnership||'landlord'} onChange={e=>setTypeForm((s:any)=>({...s,dwellingOwnership:e.target.value}))}>
                    <option value="tenant">Tenant-owned (space rent only — inspect the site, not their dwelling)</option>
                    <option value="landlord">Park-owned rental (inspect the site and the dwelling)</option>
                  </select>
                </div>
              )}
              {STAY_CAPABLE_TYPES.includes(typeForm.unitType) ? (
                <>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10}}>
                    <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Nightly Rate</div><input className="form-input" type="number" style={{width:'100%'}} placeholder="0.00" value={typeForm.nightlyRate} onChange={e=>setTypeForm((s:any)=>({...s,nightlyRate:e.target.value}))} /></div>
                    <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Weekly Rate</div><input className="form-input" type="number" style={{width:'100%'}} placeholder="0.00" value={typeForm.weeklyRate} onChange={e=>setTypeForm((s:any)=>({...s,weeklyRate:e.target.value}))} /></div>
                    <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Monthly Rate</div><input className="form-input" type="number" style={{width:'100%'}} placeholder="0.00" value={typeForm.monthlyRate} onChange={e=>setTypeForm((s:any)=>({...s,monthlyRate:e.target.value}))} /></div>
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10}}>
                    <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Min Stay (nights)</div><input className="form-input" type="number" style={{width:'100%'}} value={typeForm.minStayNights} onChange={e=>setTypeForm((s:any)=>({...s,minStayNights:Number(e.target.value)}))} /></div>
                    <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Check-in Time</div><input className="form-input" type="time" style={{width:'100%'}} value={typeForm.checkInTime} onChange={e=>setTypeForm((s:any)=>({...s,checkInTime:e.target.value}))} /></div>
                    <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Check-out Time</div><input className="form-input" type="time" style={{width:'100%'}} value={typeForm.checkOutTime} onChange={e=>setTypeForm((s:any)=>({...s,checkOutTime:e.target.value}))} /></div>
                  </div>
                </>
              ) : (
                <div style={{fontSize:'.76rem',color:'var(--text-3)',background:'var(--bg-2)',border:'1px solid var(--border-1)',borderRadius:8,padding:'10px 12px'}}>
                  {UNIT_TYPE_LABELS[typeForm.unitType] || humanize(typeForm.unitType) || 'This unit type'} rents by lease only — no nightly or weekly configuration applies. Rent and deposit are set on the unit itself.
                </div>
              )}
              {/* W-24: amenities are toggle chips (per unit type), with a
                  small add-your-own affordance for anything custom. */}
              <div>
                <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:6}}>Amenities</div>
                <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                  {Array.from(new Set([...(AMENITY_PRESETS[typeForm.unitType] || AMENITY_PRESETS.default), ...(typeForm.amenities||[])])).map((a:string)=>{
                    const on = (typeForm.amenities||[]).includes(a)
                    return (
                      <button key={a} type="button"
                        onClick={()=>setTypeForm((s:any)=>({...s,amenities: on ? s.amenities.filter((x:string)=>x!==a) : [...(s.amenities||[]), a]}))}
                        style={{fontSize:'.72rem',padding:'4px 10px',borderRadius:14,cursor:'pointer',
                          border:`1px solid ${on?'var(--gold)':'var(--border-1)'}`,
                          background:on?'var(--gold-bg)':'var(--bg-2)',
                          color:on?'var(--gold)':'var(--text-2)'}}>
                        {on?'✓ ':''}{a}
                      </button>
                    )
                  })}
                </div>
                <div style={{display:'flex',gap:6,marginTop:8}}>
                  <input className="form-input" style={{flex:1,fontSize:'.78rem'}} placeholder="Add your own…" value={customAmenity}
                    onChange={e=>setCustomAmenity(e.target.value)}
                    onKeyDown={e=>{ if(e.key==='Enter' && customAmenity.trim()){ setTypeForm((s:any)=>({...s,amenities:[...new Set([...(s.amenities||[]), customAmenity.trim()])]})); setCustomAmenity('') } }} />
                  <button type="button" className="btn btn-ghost btn-sm" disabled={!customAmenity.trim()}
                    onClick={()=>{ setTypeForm((s:any)=>({...s,amenities:[...new Set([...(s.amenities||[]), customAmenity.trim()])]})); setCustomAmenity('') }}>Add</button>
                </div>
              </div>
              <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Description</div><textarea className="form-input" style={{width:'100%',minHeight:70,resize:'vertical'}} placeholder="Pull-through site, full hookups..." value={typeForm.unitDescription} onChange={e=>setTypeForm((s:any)=>({...s,unitDescription:e.target.value}))} /></div>
              {STAY_CAPABLE_TYPES.includes(typeForm.unitType) && (
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <input type="checkbox" id="ib" checked={typeForm.isBookable} onChange={e=>setTypeForm((s:any)=>({...s,isBookable:e.target.checked}))} />
                  <label htmlFor="ib" style={{fontSize:'.82rem'}}>Allow short-term reservations on this unit</label>
                </div>
              )}
              <button className="btn btn-primary" onClick={()=>updateTypeMut.mutate()} disabled={updateTypeMut.isLoading}>
                {updateTypeMut.isLoading?'Saving...':'Save Configuration'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── NEW BOOKING MODAL (per-unit + Book) ──
          S526 (Nic): contact + dates only. No total (they don't pay here — the
          backend prices from the unit/property rates), no fee, no lease-type
          dropdown (implied by stay length). */}
      {bookingModal.show && (() => {
        const bkNights = (newBooking.checkIn && newBooking.checkOut && newBooking.checkOut > newBooking.checkIn)
          ? Math.round((new Date(newBooking.checkOut+'T12:00:00').getTime() - new Date(newBooking.checkIn+'T12:00:00').getTime())/86400000)
          : 0
        const bkEmailValid = /.+@.+\..+/.test(newBooking.guestEmail.trim())
        const bkReady = bkNights > 0 && !!bookFirst.trim() && !!bookLast.trim() && bkEmailValid && !!newBooking.guestPhone.trim()
        return (
        <div className="modal-overlay" onClick={closeBookModal}>
          <div className="modal" style={{maxWidth:480}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">New Reservation — {bookingModal.unit?.unitNumber}</span>
              <button className="btn btn-ghost btn-sm" onClick={closeBookModal}>✕</button>
            </div>
            <div style={{padding:'0 24px 24px',display:'grid',gap:12}}>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>First name</div><input className="form-input" style={{width:'100%'}} value={bookFirst} onChange={e=>setBookFirst(e.target.value)} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Last name</div><input className="form-input" style={{width:'100%'}} value={bookLast} onChange={e=>setBookLast(e.target.value)} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Email</div><input className="form-input" type="email" style={{width:'100%'}} value={newBooking.guestEmail} onChange={e=>setNewBooking(s=>({...s,guestEmail:e.target.value}))} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Phone</div><input className="form-input" type="tel" style={{width:'100%'}} value={newBooking.guestPhone} onChange={e=>setNewBooking(s=>({...s,guestPhone:e.target.value}))} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Check-in</div><input className="form-input" type="date" style={{width:'100%'}} value={newBooking.checkIn} onChange={e=>setNewBooking(s=>({...s,checkIn:e.target.value}))} /></div>
                <div><div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:4}}>Check-out</div><input className="form-input" type="date" style={{width:'100%'}} value={newBooking.checkOut} onChange={e=>setNewBooking(s=>({...s,checkOut:e.target.value}))} /></div>
              </div>
              {bkNights > 0 && (
                <div style={{fontSize:'.72rem',color:'var(--text-3)'}}>
                  {bkNights} night{bkNights===1?'':'s'} · billed {bkNights>=30?'monthly':bkNights>=7?'weekly':'nightly'}
                </div>
              )}
              <button className="btn btn-primary" onClick={()=>createBookingMut.mutate()} disabled={!bkReady||createBookingMut.isLoading}>
                {createBookingMut.isLoading?'Creating...':'Create Reservation'}
              </button>
            </div>
          </div>
        </div>
        )
      })()}

      {/* Guest access — link the guest opens to reach their stay assistant */}
      {guestAccess.show && (
        <div className="modal-overlay" onClick={()=>setGuestAccess(s=>({...s,show:false}))}>
          <div className="modal" style={{maxWidth:420}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Guest stay assistant</span>
              <button className="btn btn-ghost btn-sm" onClick={()=>setGuestAccess(s=>({...s,show:false}))}>✕</button>
            </div>
            <div style={{padding:16}}>
              <div style={{fontSize:'.8rem',color:'var(--text-3)',marginBottom:12}}>
                {guestAccess.booking?.guestName||'Your guest'} can open this link to ask about their stay and request things like a late checkout. No account needed — it works through checkout.
              </div>
              {guestAccess.loading && <div style={{textAlign:'center',padding:24,color:'var(--text-3)'}}>Generating…</div>}
              {guestAccess.error && <div style={{color:'var(--red)',fontSize:'.82rem',padding:'8px 0'}}>{guestAccess.error}</div>}
              {guestAccess.data && (
                <>
                  <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:10}}>
                    <input readOnly value={guestAccess.data.url}
                      style={{flex:1,fontSize:'.72rem',padding:'6px 8px',background:'var(--bg-1)',border:'1px solid var(--border-1)',borderRadius:6,color:'var(--text-2)'}}
                      onFocus={e=>e.currentTarget.select()} />
                    <button className="btn btn-ghost btn-sm" onClick={()=>navigator.clipboard?.writeText(guestAccess.data!.url)}>Copy</button>
                  </div>
                  <div style={{fontSize:'.7rem',color:'var(--text-3)',marginBottom:12}}>
                    Link expires {new Date(guestAccess.data.expiresAt).toLocaleDateString()}. Keep it private — anyone with it can see this reservation.
                  </div>
                  {guestAccess.booking?.guestEmail && (
                    guestAccess.data.emailed
                      ? <div style={{fontSize:'.78rem',color:'var(--green)'}}>✓ Emailed to {guestAccess.booking.guestEmail}</div>
                      : <button className="btn btn-secondary btn-sm" style={{width:'100%'}} disabled={guestAccess.emailing}
                          onClick={emailGuestAccess}>{guestAccess.emailing?'Sending…':`Email link to ${guestAccess.booking.guestEmail}`}</button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
