import { useEffect, useState } from 'react'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { Modal } from '../components/Modal'
import {
  Plus, Calendar, ChevronRight, ArrowLeft, Check, X, Clock,
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
        <button onClick={() => setShowCreate(true)}
          disabled={customers.length === 0}
          style={primaryBtnStyle}>
          <Plus size={14} /> New appointment
        </button>
      </div>

      {err && <div style={errStyle}>{err}</div>}

      {customers.length === 0 && (
        <div style={emptyStyle}>
          Add a <strong style={{ color: 'var(--gold)' }}>customer</strong> first
          — appointments attach to a customer.
        </div>
      )}

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

      {loading ? (
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
              <td style={tdStyle}>{r.serviceType}</td>
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
              {appt.serviceType}
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
