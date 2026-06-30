import { useEffect, useState } from 'react'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { Modal } from '../components/Modal'
import { humanizeServiceType as humanizeService } from '@gam/shared'
import {
  Plus, Calendar, ChevronRight, ArrowLeft, Check, X, Clock,
  List, CalendarDays, ChevronLeft, Copy, RefreshCw,
} from 'lucide-react'

interface CustomerLite {
  id: string
  firstName: string
  lastName: string
  companyName: string | null
  phone: string | null
}

type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show'

interface AppointmentRow {
  id: string
  businessId: string
  customerId: string
  serviceType: string
  scheduledFor: string
  durationMinutes: number
  status: AppointmentStatus
  notes: string | null
  completedAt: string | null
  cancelledAt: string | null
  cancelledReason: string | null
  recurringScheduleId: string | null
  createdAt: string
  // Joined fields (from the GET list query)
  customerFirstName?: string
  customerLastName?: string
  customerCompanyName?: string | null
}

const STATUS_TONE: Record<AppointmentStatus, { bg: string; color: string; label: string }> = {
  scheduled: { bg: 'rgba(245,158,11,.1)', color: 'var(--amber)',              label: 'Scheduled' },
  completed: { bg: 'rgba(34,197,94,.1)',  color: 'var(--green, #22c55e)',     label: 'Completed' },
  cancelled: { bg: 'var(--bg-2)',          color: 'var(--text-3)',             label: 'Cancelled' },
  no_show:   { bg: 'rgba(239,68,68,.08)',  color: 'var(--red, #ef4444)',       label: 'No-show' },
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  const datePart = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  const timePart = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${datePart} · ${timePart}`
}

function fmtDuration(mins: number): string {
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function fmtCustomer(a: AppointmentRow | CustomerLite): string {
  if ('companyName' in a) {
    return a.companyName
      ? a.companyName
      : `${a.firstName} ${a.lastName}`
  }
  // AppointmentRow with joined customer fields
  return a.customerCompanyName
    ? a.customerCompanyName
    : `${a.customerFirstName ?? ''} ${a.customerLastName ?? ''}`.trim()
}

export function AppointmentsPage() {
  const [rows, setRows] = useState<AppointmentRow[]>([])
  const [customers, setCustomers] = useState<CustomerLite[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<AppointmentStatus | ''>('')
  const [showCreate, setShowCreate] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<'list' | 'calendar'>('list')
  const [showSync, setShowSync] = useState(false)

  const reload = async () => {
    setErr(null)
    try {
      const [list, cs] = await Promise.all([
        apiGet<AppointmentRow[]>(`/appointments${statusFilter ? `?status=${statusFilter}` : ''}`),
        apiGet<CustomerLite[]>('/business-customers'),
      ])
      setRows(list)
      setCustomers(cs)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load appointments')
    } finally { setLoading(false) }
  }

  useEffect(() => { reload() }, [statusFilter])

  if (selectedId) {
    return (
      <AppointmentDetailView id={selectedId}
        customers={customers}
        onBack={() => setSelectedId(null)}
        onChange={() => reload()} />
    )
  }

  // Split list into upcoming vs past (status filter overrides this grouping
  // when set).
  const now = Date.now()
  const upcoming = statusFilter
    ? rows
    : rows.filter(r => new Date(r.scheduledFor).getTime() >= now && r.status === 'scheduled')
  const past = statusFilter
    ? []
    : rows.filter(r => !upcoming.includes(r))

  return (
    <div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'baseline', marginBottom: 24,
      }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, margin: 0 }}>
            Appointments
          </h1>
          <div style={{ color: 'var(--text-2)', fontSize: 14, marginTop: 4 }}>
            Timed visits with your customers. Mark complete after each one — or
            cancel if it doesn't happen.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', border: '1px solid var(--border-1)', borderRadius: 6, overflow: 'hidden' }}>
            {(['list', 'calendar'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', fontSize: 12, cursor: 'pointer',
                  border: 'none',
                  background: view === v ? 'var(--gold-bg)' : 'var(--bg-2)',
                  color: view === v ? 'var(--gold)' : 'var(--text-1)',
                  textTransform: 'capitalize' as const,
                }}>
                {v === 'list' ? <List size={13} /> : <CalendarDays size={13} />}{v}
              </button>
            ))}
          </div>
          <button onClick={() => setShowSync(true)} style={ghostBtn}>
            <CalendarDays size={14} /> Sync to calendar
          </button>
          <button onClick={() => setShowCreate(true)}
            disabled={customers.length === 0}
            style={primaryBtnStyle}>
            <Plus size={14} /> New appointment
          </button>
        </div>
      </div>

      {err && <div style={errStyle}>{err}</div>}

      {customers.length === 0 && (
        <div style={emptyStyle}>
          Add a <strong style={{ color: 'var(--gold)' }}>customer</strong> first
          — appointments attach to a customer.
        </div>
      )}

      {view === 'list' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--text-2)' }}>Filter</span>
          {(['', 'scheduled', 'completed', 'cancelled', 'no_show'] as const).map(s => (
            <button key={s || 'all'} onClick={() => setStatusFilter(s)}
              style={{
                padding: '6px 12px',
                background: statusFilter === s ? 'var(--gold-bg)' : 'var(--bg-2)',
                color: statusFilter === s ? 'var(--gold)' : 'var(--text-1)',
                border: `1px solid ${statusFilter === s ? 'var(--gold)' : 'var(--border-1)'}`,
                borderRadius: 6,
                fontSize: 12,
                cursor: 'pointer',
                textTransform: 'capitalize' as const,
              }}>
              {s ? s.replace('_', ' ') : 'all'}
            </button>
          ))}
        </div>
      )}

      {view === 'calendar' ? (
        <CalendarMonth onSelect={setSelectedId} />
      ) : loading ? (
        <div style={{ color: 'var(--text-2)' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={emptyStyle}>
          {statusFilter ? `No ${statusFilter.replace('_', ' ')} appointments.` : 'No appointments yet.'}
        </div>
      ) : (
        <>
          {!statusFilter && upcoming.length > 0 && (
            <Section title="Upcoming" rows={upcoming} onSelect={setSelectedId} />
          )}
          {!statusFilter && past.length > 0 && (
            <Section title="Past" rows={past} onSelect={setSelectedId} />
          )}
          {statusFilter && (
            <Section title="" rows={rows} onSelect={setSelectedId} />
          )}
        </>
      )}

      {showCreate && (
        <CreateAppointmentModal
          customers={customers}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); reload() }} />
      )}
      {showSync && <CalendarSyncModal onClose={() => setShowSync(false)} />}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Section
// ─────────────────────────────────────────────────────────────────

function Section({ title, rows, onSelect }: {
  title: string
  rows: AppointmentRow[]
  onSelect: (id: string) => void
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      {title && (
        <h2 style={{
          fontFamily: 'var(--font-body)', fontSize: 13,
          textTransform: 'uppercase' as const, letterSpacing: 1,
          color: 'var(--text-3)', margin: '0 0 8px 0',
        }}>{title}</h2>
      )}
      <table style={tableStyle}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
            <th style={thStyle}>When</th>
            <th style={thStyle}>Customer</th>
            <th style={thStyle}>Service</th>
            <th style={thStyle}>Duration</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} onClick={() => onSelect(r.id)}
              style={{ borderBottom: '1px solid var(--border-0)', cursor: 'pointer' }}>
              <td style={tdStyle}>
                {fmtDateTime(r.scheduledFor)}
                {r.recurringScheduleId && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                    Recurring
                  </div>
                )}
              </td>
              <td style={tdStyle}>{fmtCustomer(r)}</td>
              <td style={tdStyle}>{humanizeService(r.serviceType)}</td>
              <td style={tdStyle}>{fmtDuration(r.durationMinutes)}</td>
              <td style={tdStyle}>
                <span style={{
                  display: 'inline-block' as const, padding: '3px 10px', borderRadius: 6,
                  fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
                  background: STATUS_TONE[r.status].bg,
                  color: STATUS_TONE[r.status].color,
                }}>{STATUS_TONE[r.status].label}</span>
              </td>
              <td style={tdStyle}><ChevronRight size={14} color="var(--text-3)" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Calendar month view (S511)
// ─────────────────────────────────────────────────────────────────

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function CalendarMonth({ onSelect }: { onSelect: (id: string) => void }) {
  // Anchored to the first of the displayed month.
  const [anchor, setAnchor] = useState(() => {
    const n = new Date()
    return new Date(n.getFullYear(), n.getMonth(), 1)
  })
  const [rows, setRows] = useState<AppointmentRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const from = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 0, 0, 0)
    const to = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0, 23, 59, 59)
    apiGet<AppointmentRow[]>(
      `/appointments?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&limit=500`)
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false))
  }, [anchor])

  // Bucket appointments by local day.
  const byDay = new Map<string, AppointmentRow[]>()
  for (const r of rows) {
    const k = localDateKey(new Date(r.scheduledFor))
    const arr = byDay.get(k) ?? []
    arr.push(r)
    byDay.set(k, arr)
  }

  const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate()
  const leading = new Date(anchor.getFullYear(), anchor.getMonth(), 1).getDay()
  const cells: (Date | null)[] = []
  for (let i = 0; i < leading; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(anchor.getFullYear(), anchor.getMonth(), d))
  while (cells.length % 7 !== 0) cells.push(null)

  const todayKey = localDateKey(new Date())
  const monthLabel = anchor.toLocaleDateString([], { month: 'long', year: 'numeric' })
  const shift = (n: number) => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + n, 1))
  const goToday = () => { const n = new Date(); setAnchor(new Date(n.getFullYear(), n.getMonth(), 1)) }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <button onClick={() => shift(-1)} style={navBtn} aria-label="Previous month"><ChevronLeft size={16} /></button>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, minWidth: 160 }}>{monthLabel}</div>
        <button onClick={() => shift(1)} style={navBtn} aria-label="Next month"><ChevronRight size={16} /></button>
        <button onClick={goToday} style={{ ...ghostBtn, padding: '4px 10px', fontSize: 12 }}>Today</button>
        {loading && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Loading…</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, background: 'var(--border-0)', border: '1px solid var(--border-0)', borderRadius: 8, overflow: 'hidden' }}>
        {WEEKDAYS.map(w => (
          <div key={w} style={{ background: 'var(--bg-2)', padding: '6px 8px', fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: 'var(--text-3)', textTransform: 'uppercase' as const }}>{w}</div>
        ))}
        {cells.map((cell, i) => {
          if (!cell) return <div key={`b${i}`} style={{ background: 'var(--bg-1)', minHeight: 96 }} />
          const k = localDateKey(cell)
          const dayRows = (byDay.get(k) ?? []).sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))
          const isToday = k === todayKey
          return (
            <div key={k} style={{ background: 'var(--bg-1)', minHeight: 96, padding: 6, display: 'flex', flexDirection: 'column' as const, gap: 3 }}>
              <div style={{
                fontSize: 12, fontWeight: isToday ? 700 : 500, marginBottom: 2,
                color: isToday ? 'var(--gold)' : 'var(--text-2)',
              }}>{cell.getDate()}</div>
              {dayRows.slice(0, 3).map(r => (
                <button key={r.id} onClick={() => onSelect(r.id)} title={`${fmtCustomer(r)} · ${humanizeService(r.serviceType)}`}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left' as const,
                    border: 'none', borderRadius: 4, cursor: 'pointer',
                    padding: '2px 6px', fontSize: 11, lineHeight: 1.3,
                    background: STATUS_TONE[r.status].bg, color: STATUS_TONE[r.status].color,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
                  }}>
                  {new Date(r.scheduledFor).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} {humanizeService(r.serviceType)}
                </button>
              ))}
              {dayRows.length > 3 && (
                <div style={{ fontSize: 10, color: 'var(--text-3)', paddingLeft: 4 }}>+{dayRows.length - 3} more</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Calendar sync modal — ICS subscribe feed (S511)
// ─────────────────────────────────────────────────────────────────

interface FeedInfo { token: string; url: string; webcalUrl: string }

function CalendarSyncModal({ onClose }: { onClose: () => void }) {
  const [feed, setFeed] = useState<FeedInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [rotating, setRotating] = useState(false)

  useEffect(() => {
    apiGet<FeedInfo>('/appointments/calendar-feed')
      .then(setFeed)
      .catch((e: any) => setErr(e?.response?.data?.error || 'Could not load the feed link'))
  }, [])

  const copy = async () => {
    if (!feed) return
    try {
      await navigator.clipboard.writeText(feed.url)
      setCopied(true); setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked — the field is selectable */ }
  }

  const rotate = async () => {
    setRotating(true)
    try {
      const r = await apiPost<FeedInfo>('/appointments/calendar-feed/rotate', {})
      setFeed(r.data)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Could not reset the link')
    } finally { setRotating(false) }
  }

  return (
    <Modal title="Sync to your calendar" onClose={onClose}
      footer={<button onClick={onClose} style={primaryBtnStyle}>Done</button>}>
      {err && <div style={errStyle}>{err}</div>}
      <p style={{ fontSize: 13, color: 'var(--text-1)', marginTop: 0 }}>
        Subscribe once and your appointments stay up to date in Google, Apple, or
        Outlook calendars. This is a private, read-only link — anyone with it can
        see your schedule, so keep it to yourself.
      </p>

      {!feed ? (
        <div style={{ color: 'var(--text-2)', fontSize: 13 }}>Loading link…</div>
      ) : (
        <>
          <label style={labelStyle}>Your calendar feed link</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input readOnly value={feed.url} onFocus={e => e.currentTarget.select()}
              style={{ ...inputStyle, marginTop: 0, fontFamily: 'var(--font-mono)' as const, fontSize: 12 }} />
            <button onClick={copy} style={{ ...ghostBtn, whiteSpace: 'nowrap' as const }}>
              <Copy size={13} /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <a href={feed.webcalUrl} style={{ ...primaryBtnStyle, textDecoration: 'none' }}>
              <CalendarDays size={14} /> Add to calendar
            </a>
            <button onClick={rotate} disabled={rotating} style={ghostBtn}>
              <RefreshCw size={13} /> {rotating ? 'Resetting…' : 'Reset link'}
            </button>
          </div>

          <div style={{ marginTop: 16, padding: 12, background: 'var(--bg-2)', borderRadius: 8, fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.6 }}>
            <strong style={{ color: 'var(--text-1)' }}>How to subscribe</strong>
            <ul style={{ margin: '6px 0 0 0', paddingLeft: 18 }}>
              <li><strong>Apple Calendar:</strong> “Add to calendar” above, or File → New Calendar Subscription, paste the link.</li>
              <li><strong>Google Calendar:</strong> Other calendars → + → From URL, paste the link.</li>
              <li><strong>Outlook:</strong> Add calendar → Subscribe from web, paste the link.</li>
            </ul>
            <div style={{ marginTop: 8, color: 'var(--text-3)' }}>
              “Reset link” immediately disables any calendar already subscribed to the old link.
            </div>
          </div>
        </>
      )}
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Detail view
// ─────────────────────────────────────────────────────────────────

function AppointmentDetailView({
  id, customers, onBack, onChange,
}: {
  id: string
  customers: CustomerLite[]
  onBack: () => void
  onChange: () => void
}) {
  const [appt, setAppt] = useState<AppointmentRow | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [actioning, setActioning] = useState(false)
  const [showCancel, setShowCancel] = useState(false)
  const [showEdit, setShowEdit] = useState(false)

  const reload = async () => {
    try {
      const d = await apiGet<AppointmentRow>(`/appointments/${id}`)
      setAppt(d)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load appointment')
    }
  }
  useEffect(() => { reload() }, [id])

  const onComplete = async () => {
    setActioning(true); setErr(null)
    try {
      await apiPost(`/appointments/${id}/complete`)
      await reload()
      onChange()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Complete failed')
    } finally { setActioning(false) }
  }

  if (!appt) {
    return (
      <div>
        <button onClick={onBack} style={ghostBtn}>
          <ArrowLeft size={14} /> Back
        </button>
        {err && <div style={errStyle}>{err}</div>}
        <div style={{ color: 'var(--text-2)', marginTop: 16 }}>Loading…</div>
      </div>
    )
  }

  const customer = customers.find(c => c.id === appt.customerId)
  const tone = STATUS_TONE[appt.status]

  return (
    <div>
      <button onClick={onBack} style={ghostBtn}>
        <ArrowLeft size={14} /> Back to appointments
      </button>

      {err && <div style={{ ...errStyle, marginTop: 16 }}>{err}</div>}

      <div style={{
        marginTop: 16, padding: 24,
        background: 'var(--bg-1)', border: '1px solid var(--border-0)',
        borderRadius: 12,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: 0 }}>
              {humanizeService(appt.serviceType)}
            </h1>
            <div style={{ display: 'flex', gap: 12, marginTop: 6, color: 'var(--text-2)', fontSize: 14 }}>
              <span style={{ display: 'inline-flex' as const, alignItems: 'center', gap: 4 }}>
                <Calendar size={14} /> {fmtDateTime(appt.scheduledFor)}
              </span>
              <span style={{ display: 'inline-flex' as const, alignItems: 'center', gap: 4 }}>
                <Clock size={14} /> {fmtDuration(appt.durationMinutes)}
              </span>
            </div>
          </div>
          <span style={{
            padding: '6px 14px', borderRadius: 6,
            fontSize: 12, fontWeight: 700, letterSpacing: 0.5,
            background: tone.bg, color: tone.color,
          }}>{tone.label}</span>
        </div>

        <div style={{
          padding: 14, marginBottom: 16,
          background: 'var(--bg-2)', borderRadius: 8,
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
            Customer
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-0)' }}>
            {customer ? fmtCustomer(customer) : fmtCustomer(appt)}
          </div>
          {customer?.phone && (
            <a href={`tel:${customer.phone}`}
              style={{ fontSize: 13, color: 'var(--gold)', textDecoration: 'none' }}>
              {customer.phone}
            </a>
          )}
        </div>

        {appt.notes && (
          <div style={{
            padding: 12, marginBottom: 16,
            background: 'var(--bg-2)', borderRadius: 8,
            fontSize: 13, color: 'var(--text-1)',
          }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
              Notes
            </div>
            {appt.notes}
          </div>
        )}

        {appt.status === 'cancelled' && appt.cancelledReason && (
          <div style={{
            padding: 12, marginBottom: 16,
            background: 'var(--bg-2)', borderRadius: 8,
            fontSize: 13, color: 'var(--text-2)',
          }}>
            <strong>Cancelled</strong> {fmtDateTime(appt.cancelledAt!)}
            <div style={{ marginTop: 4 }}>{appt.cancelledReason}</div>
          </div>
        )}
        {appt.status === 'completed' && appt.completedAt && (
          <div style={{
            padding: 12, marginBottom: 16,
            background: 'rgba(34,197,94,.06)',
            border: '1px solid rgba(34,197,94,.3)',
            borderRadius: 8,
            fontSize: 13, color: 'var(--text-1)',
          }}>
            <Check size={14} style={{ color: 'var(--green, #22c55e)', marginRight: 6, verticalAlign: 'middle' }} />
            Completed {fmtDateTime(appt.completedAt)}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
          {appt.status === 'scheduled' && (
            <>
              <button onClick={() => setShowEdit(true)} style={ghostBtn}>
                Edit
              </button>
              <button onClick={onComplete} disabled={actioning} style={successBtnStyle}>
                <Check size={14} /> Mark complete
              </button>
              <button onClick={() => setShowCancel(true)} style={dangerBtnStyle}>
                <X size={14} /> Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {showCancel && (
        <CancelModal appointmentId={id}
          onClose={() => setShowCancel(false)}
          onSuccess={() => { setShowCancel(false); reload(); onChange() }} />
      )}
      {showEdit && (
        <EditAppointmentModal appointment={appt}
          customers={customers}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); reload(); onChange() }} />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Create + Edit modals
// ─────────────────────────────────────────────────────────────────

function CreateAppointmentModal({
  customers, onClose, onCreated,
}: {
  customers: CustomerLite[]
  onClose: () => void
  onCreated: () => void
}) {
  const inOneHour = new Date(Date.now() + 60 * 60 * 1000)
  // Default to next half hour rounded up.
  inOneHour.setMinutes(Math.ceil(inOneHour.getMinutes() / 30) * 30, 0, 0)
  const defaultIso = inOneHour.toISOString().slice(0, 16)  // YYYY-MM-DDTHH:MM

  const [form, setForm] = useState({
    customerId:      customers[0]?.id ?? '',
    serviceType:     '',
    scheduledFor:    defaultIso,
    durationMinutes: '30',
    notes:           '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setErr(null)
    if (!form.customerId || !form.serviceType.trim() || !form.scheduledFor) {
      setErr('Customer, service, and date/time are required'); return
    }
    setSaving(true)
    try {
      await apiPost('/appointments', {
        customerId:      form.customerId,
        serviceType:     form.serviceType.trim(),
        scheduledFor:    new Date(form.scheduledFor).toISOString(),
        durationMinutes: Number(form.durationMinutes) || 30,
        notes:           form.notes.trim() || undefined,
      })
      onCreated()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Create failed')
    } finally { setSaving(false) }
  }

  return (
    <Modal title="New appointment" onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={saving} style={primaryBtnStyle}>
            {saving ? 'Creating…' : 'Create'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}
      <label style={labelStyle}>Customer</label>
      <select value={form.customerId}
        onChange={e => setForm({ ...form, customerId: e.target.value })}
        style={inputStyle}>
        {customers.map(c => (
          <option key={c.id} value={c.id}>{fmtCustomer(c)}</option>
        ))}
      </select>

      <label style={labelStyle}>Service</label>
      <input value={form.serviceType}
        onChange={e => setForm({ ...form, serviceType: e.target.value })}
        placeholder="Oil change / Haircut / Inspection / etc."
        style={inputStyle} />

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Date & time</label>
          <input type="datetime-local" value={form.scheduledFor}
            onChange={e => setForm({ ...form, scheduledFor: e.target.value })}
            style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Duration (min)</label>
          <input type="number" min="5" max="1440" step="5"
            value={form.durationMinutes}
            onChange={e => setForm({ ...form, durationMinutes: e.target.value })}
            style={inputStyle} />
        </div>
      </div>

      <label style={labelStyle}>Notes (optional)</label>
      <textarea value={form.notes}
        onChange={e => setForm({ ...form, notes: e.target.value })}
        rows={3}
        placeholder="Anything specific for this visit"
        style={{ ...inputStyle, fontFamily: 'var(--font-body)', resize: 'vertical' as const }} />
    </Modal>
  )
}

function EditAppointmentModal({
  appointment, customers, onClose, onSaved,
}: {
  appointment: AppointmentRow
  customers: CustomerLite[]
  onClose: () => void
  onSaved: () => void
}) {
  const initialIso = new Date(appointment.scheduledFor).toISOString().slice(0, 16)
  const [form, setForm] = useState({
    serviceType:     appointment.serviceType,
    scheduledFor:    initialIso,
    durationMinutes: String(appointment.durationMinutes),
    notes:           appointment.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setErr(null); setSaving(true)
    try {
      await apiPatch(`/appointments/${appointment.id}`, {
        serviceType:     form.serviceType.trim(),
        scheduledFor:    new Date(form.scheduledFor).toISOString(),
        durationMinutes: Number(form.durationMinutes) || 30,
        notes:           form.notes.trim() || null,
      })
      onSaved()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Save failed')
    } finally { setSaving(false) }
  }

  const customer = customers.find(c => c.id === appointment.customerId)

  return (
    <Modal title="Edit appointment" onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={saving} style={primaryBtnStyle}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}
      {customer && (
        <div style={{
          padding: 10, marginBottom: 8,
          background: 'var(--bg-2)', borderRadius: 6,
          fontSize: 13, color: 'var(--text-2)',
        }}>
          Customer: <strong style={{ color: 'var(--text-0)' }}>{fmtCustomer(customer)}</strong>
        </div>
      )}
      <label style={labelStyle}>Service</label>
      <input value={form.serviceType}
        onChange={e => setForm({ ...form, serviceType: e.target.value })}
        style={inputStyle} />

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Date & time</label>
          <input type="datetime-local" value={form.scheduledFor}
            onChange={e => setForm({ ...form, scheduledFor: e.target.value })}
            style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Duration (min)</label>
          <input type="number" min="5" max="1440" step="5"
            value={form.durationMinutes}
            onChange={e => setForm({ ...form, durationMinutes: e.target.value })}
            style={inputStyle} />
        </div>
      </div>

      <label style={labelStyle}>Notes (optional)</label>
      <textarea value={form.notes}
        onChange={e => setForm({ ...form, notes: e.target.value })}
        rows={3}
        style={{ ...inputStyle, fontFamily: 'var(--font-body)', resize: 'vertical' as const }} />
    </Modal>
  )
}

function CancelModal({
  appointmentId, onClose, onSuccess,
}: {
  appointmentId: string
  onClose: () => void
  onSuccess: () => void
}) {
  const [reason, setReason] = useState('')
  const [markNoShow, setMarkNoShow] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    if (!reason.trim()) { setErr('Reason required'); return }
    setSaving(true); setErr(null)
    try {
      await apiPost(`/appointments/${appointmentId}/cancel`, {
        reason: reason.trim(),
        markNoShow,
      })
      onSuccess()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Cancel failed')
    } finally { setSaving(false) }
  }

  return (
    <Modal title="Cancel appointment" onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Keep it</button>
          <button onClick={submit} disabled={saving} style={dangerBtnStyle}>
            {saving ? 'Cancelling…' : 'Cancel appointment'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}
      <label style={labelStyle}>Reason</label>
      <input value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder="Customer rescheduled / no longer needed / etc."
        style={inputStyle} />

      <label style={{
        display: 'flex' as const, alignItems: 'center', gap: 8,
        marginTop: 14, cursor: 'pointer',
      }}>
        <input type="checkbox" checked={markNoShow}
          onChange={e => setMarkNoShow(e.target.checked)} />
        <span style={{ fontSize: 13, color: 'var(--text-1)' }}>
          Mark as no-show (customer didn't show up)
        </span>
      </label>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Styles
// ─────────────────────────────────────────────────────────────────

const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse' as const,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, overflow: 'hidden' as const,
}
const thStyle: React.CSSProperties = {
  textAlign: 'left' as const, padding: '12px 16px',
  fontSize: 12, color: 'var(--text-2)',
  textTransform: 'uppercase' as const,
  letterSpacing: 1, background: 'var(--bg-2)',
  fontWeight: 600,
}
const tdStyle: React.CSSProperties = {
  padding: '14px 16px', fontSize: 14, color: 'var(--text-1)',
}
const labelStyle: React.CSSProperties = {
  display: 'block' as const, fontSize: 12, color: 'var(--text-2)',
  marginBottom: 6, marginTop: 12,
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 14, boxSizing: 'border-box' as const,
}
const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 8,
  fontSize: 13, fontWeight: 600,
  cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const successBtnStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'rgba(34,197,94,.12)', color: 'var(--green, #22c55e)',
  border: '1px solid var(--green, #22c55e)', borderRadius: 8,
  fontSize: 13, fontWeight: 600,
  cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const dangerBtnStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'rgba(239,68,68,.08)', color: 'var(--red, #ef4444)',
  border: '1px solid var(--red, #ef4444)', borderRadius: 8,
  fontSize: 13, fontWeight: 600,
  cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const ghostBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'transparent', color: 'var(--text-1)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 13, fontWeight: 500, cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const navBtn: React.CSSProperties = {
  padding: 6, background: 'var(--bg-2)', color: 'var(--text-1)',
  border: '1px solid var(--border-1)', borderRadius: 6, cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center',
}
const errStyle: React.CSSProperties = {
  marginBottom: 12, padding: '10px 12px',
  background: 'var(--red-bg)', color: 'var(--red, #ef4444)',
  border: '1px solid var(--red-dim, #ef4444)', borderRadius: 8, fontSize: 13,
}
const emptyStyle: React.CSSProperties = {
  padding: 32, textAlign: 'center' as const,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, color: 'var(--text-2)', fontSize: 14,
  marginBottom: 16,
}
