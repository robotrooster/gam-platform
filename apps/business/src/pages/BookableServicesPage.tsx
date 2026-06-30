import { useEffect, useState } from 'react'
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api'
import { Modal } from '../components/Modal'
import { Plus, Pencil, Trash2, Eye, EyeOff } from 'lucide-react'
import {
  type BookableServiceRecurrence,
  BOOKABLE_SERVICE_RECURRENCES,
  BOOKABLE_SERVICE_RECURRENCE_LABEL,
  WEEKDAY_LABEL,
} from '@gam/shared'

interface Service {
  id: string
  name: string
  description: string | null
  durationMinutes: number
  price: string | null
  isActive: boolean
  sortOrder: number
  recurrence: BookableServiceRecurrence
  recurrenceDayOfWeek: number | null
}

function fmtPrice(p: string | null): string {
  if (p == null) return '—'
  return `$${Number(p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDuration(m: number): string {
  if (m < 60) return `${m}min`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem === 0 ? `${h}hr` : `${h}hr ${rem}min`
}

export function BookableServicesPage() {
  const [list, setList] = useState<Service[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [editing, setEditing] = useState<Service | null>(null)

  const reload = async () => {
    setErr(null)
    try {
      const r = await apiGet<Service[]>('/business-bookable-services')
      setList(r)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load')
    }
  }
  useEffect(() => { reload() }, [])

  const toggleActive = async (s: Service) => {
    try {
      await apiPatch(`/business-bookable-services/${s.id}`, { isActive: !s.isActive })
      reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Toggle failed')
    }
  }

  const remove = async (s: Service) => {
    if (!window.confirm(`Delete "${s.name}"? This won't affect appointments already booked for it.`)) return
    try {
      await apiDelete(`/business-bookable-services/${s.id}`)
      reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Delete failed')
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, margin: 0 }}>
            Bookable services
          </h1>
          <div style={{ color: 'var(--text-2)', fontSize: 14, marginTop: 4 }}>
            What customers can pick from on your public booking page. Each service has a duration and an optional price.
          </div>
        </div>
        <button onClick={() => setShowCreate(true)} style={primaryBtnStyle}>
          <Plus size={14} /> New service
        </button>
      </div>

      {err && <div style={errStyle}>{err}</div>}

      {list.length === 0 ? (
        <div style={emptyStyle}>
          No services yet. Add at least one before turning on public booking.
        </div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Duration</th>
              <th style={thStyle}>Price</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {list.map(s => (
              <tr key={s.id} style={{ borderBottom: '1px solid var(--border-0)', opacity: s.isActive ? 1 : 0.55 }}>
                <td style={tdStyle}>
                  <strong style={{ color: 'var(--text-0)' }}>{s.name}</strong>
                  {s.description && (
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                      {s.description.length > 80 ? s.description.slice(0, 80) + '…' : s.description}
                    </div>
                  )}
                </td>
                <td style={tdStyle}>{fmtDuration(s.durationMinutes)}</td>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, fontWeight: 600 }}>
                  {fmtPrice(s.price)}
                </td>
                <td style={tdStyle}>
                  <span style={{
                    padding: '2px 8px', borderRadius: 4,
                    border: `1px solid ${s.isActive ? 'var(--green, #22c55e)' : 'var(--text-3)'}`,
                    color: s.isActive ? 'var(--green, #22c55e)' : 'var(--text-3)',
                    fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: 0.5,
                  }}>
                    {s.isActive ? 'Live' : 'Hidden'}
                  </span>
                </td>
                <td style={{ ...tdStyle, textAlign: 'right' as const }}>
                  <button onClick={() => toggleActive(s)} style={ghostIconBtn}
                    title={s.isActive ? 'Hide from booking page' : 'Show on booking page'}>
                    {s.isActive ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                  <button onClick={() => setEditing(s)} style={ghostIconBtn} title="Edit">
                    <Pencil size={12} />
                  </button>
                  <button onClick={() => remove(s)} style={ghostIconBtn} title="Delete">
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(showCreate || editing) && (
        <ServiceFormModal
          service={editing}
          onClose={() => { setShowCreate(false); setEditing(null) }}
          onSaved={() => { setShowCreate(false); setEditing(null); reload() }} />
      )}
    </div>
  )
}

function ServiceFormModal({
  service, onClose, onSaved,
}: {
  service: Service | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(service?.name ?? '')
  const [description, setDescription] = useState(service?.description ?? '')
  const [durationMinutes, setDurationMinutes] = useState(String(service?.durationMinutes ?? 60))
  const [price, setPrice] = useState(service?.price ?? '')
  const [sortOrder, setSortOrder] = useState(String(service?.sortOrder ?? 0))
  const [recurrence, setRecurrence] = useState<BookableServiceRecurrence>(service?.recurrence ?? 'one_time')
  const [recurrenceDayOfWeek, setRecurrenceDayOfWeek] = useState(String(service?.recurrenceDayOfWeek ?? 1))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setErr(null)
    if (!name.trim()) { setErr('Name is required'); return }
    const dur = parseInt(durationMinutes, 10)
    if (!dur || dur < 1) { setErr('Duration must be a positive number'); return }
    setBusy(true)
    try {
      const body: any = {
        name: name.trim(),
        description: description.trim() || null,
        durationMinutes: dur,
        price: price.trim() ? Number(price) : null,
        sortOrder: parseInt(sortOrder, 10) || 0,
        recurrence,
        recurrenceDayOfWeek: recurrence === 'one_time' ? null : parseInt(recurrenceDayOfWeek, 10),
      }
      if (service) {
        await apiPatch(`/business-bookable-services/${service.id}`, body)
      } else {
        await apiPost('/business-bookable-services', body)
      }
      onSaved()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Save failed')
    } finally { setBusy(false) }
  }

  return (
    <Modal title={service ? `Edit "${service.name}"` : 'New bookable service'}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={busy} style={primaryBtnStyle}>
            {busy ? 'Saving…' : service ? 'Save' : 'Create'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}

      <label style={labelStyle}>Name</label>
      <input value={name} onChange={e => setName(e.target.value)}
        placeholder="Oil change / Haircut / Diagnostic"
        style={inputStyle} />

      <label style={labelStyle}>Description (shown on the booking page — optional)</label>
      <textarea value={description}
        onChange={e => setDescription(e.target.value)}
        rows={2}
        placeholder="What's included, how long, what to bring"
        style={{ ...inputStyle, fontFamily: 'var(--font-body)' as const, resize: 'vertical' as const }} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Duration (minutes)</label>
          <input type="number" min="1" max="1440" value={durationMinutes}
            onChange={e => setDurationMinutes(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Price ($, optional)</label>
          <input type="number" min="0" step="0.01" value={price}
            onChange={e => setPrice(e.target.value)}
            placeholder="Leave blank to hide"
            style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Sort order</label>
          <input type="number" min="0" value={sortOrder}
            onChange={e => setSortOrder(e.target.value)} style={inputStyle} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <div>
          <label style={labelStyle}>Cadence</label>
          <select value={recurrence}
            onChange={e => setRecurrence(e.target.value as BookableServiceRecurrence)}
            style={inputStyle}>
            {BOOKABLE_SERVICE_RECURRENCES.map(r => (
              <option key={r} value={r}>{BOOKABLE_SERVICE_RECURRENCE_LABEL[r]}</option>
            ))}
          </select>
        </div>
        {recurrence !== 'one_time' && (
          <div>
            <label style={labelStyle}>Repeats on</label>
            <select value={recurrenceDayOfWeek}
              onChange={e => setRecurrenceDayOfWeek(e.target.value)}
              style={inputStyle}>
              {WEEKDAY_LABEL.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </div>
        )}
      </div>
      {recurrence !== 'one_time' && (
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>
          Customers who book this enroll in a {BOOKABLE_SERVICE_RECURRENCE_LABEL[recurrence].toLowerCase()} schedule on {WEEKDAY_LABEL[parseInt(recurrenceDayOfWeek, 10)]}s — the route sets the time.
        </div>
      )}
    </Modal>
  )
}

const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse' as const,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, overflow: 'hidden' as const,
}
const thStyle: React.CSSProperties = {
  textAlign: 'left' as const, padding: '12px 16px',
  fontSize: 12, color: 'var(--text-2)',
  textTransform: 'uppercase' as const, letterSpacing: 1,
  background: 'var(--bg-2)', fontWeight: 600,
}
const tdStyle: React.CSSProperties = { padding: '12px 16px', fontSize: 14, color: 'var(--text-1)' }
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
  padding: '8px 14px', background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const ghostBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'transparent', color: 'var(--text-1)',
  border: '1px solid var(--border-1)', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const ghostIconBtn: React.CSSProperties = {
  padding: 6, marginLeft: 4,
  background: 'transparent', color: 'var(--text-2)',
  border: '1px solid var(--border-1)', borderRadius: 6,
  cursor: 'pointer',
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
}
