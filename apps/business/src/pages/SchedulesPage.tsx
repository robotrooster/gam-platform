import { useEffect, useState } from 'react'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { Pause, Play, Pencil } from 'lucide-react'
import { Modal } from '../components/Modal'
import { iconBtnStyle, cancelBtnStyle, saveBtnStyle } from './CustomersPage'

interface ScheduleRow {
  id: string
  customer_id: string
  service_type: string
  rrule: string
  time_of_day: string
  start_date: string
  end_date: string | null
  status: string
  first_name: string; last_name: string; company_name: string | null
}

interface CustomerLite {
  id: string
  firstName: string; lastName: string
  companyName: string | null
}

const DOW = [
  { key: 'MO', label: 'Mon' },
  { key: 'TU', label: 'Tue' },
  { key: 'WE', label: 'Wed' },
  { key: 'TH', label: 'Thu' },
  { key: 'FR', label: 'Fri' },
  { key: 'SA', label: 'Sat' },
  { key: 'SU', label: 'Sun' },
] as const

/** Compose an RRULE string from the simple UI inputs. */
function buildRrule(freq: 'WEEKLY' | 'MONTHLY', days: string[], monthDay: string): string {
  if (freq === 'WEEKLY') {
    return `FREQ=WEEKLY;BYDAY=${days.join(',')}`
  }
  return `FREQ=MONTHLY;BYMONTHDAY=${monthDay}`
}

/** Inverse of buildRrule — pull editable pieces out of a saved RRULE. */
function parseRrule(rrule: string): { freq: 'WEEKLY' | 'MONTHLY'; days: string[]; monthDay: string } {
  if (rrule.startsWith('FREQ=WEEKLY')) {
    const days = rrule.match(/BYDAY=([A-Z,]+)/)?.[1]?.split(',') ?? []
    return { freq: 'WEEKLY', days, monthDay: '15' }
  }
  if (rrule.startsWith('FREQ=MONTHLY')) {
    const day = rrule.match(/BYMONTHDAY=(\d+)/)?.[1] ?? '15'
    return { freq: 'MONTHLY', days: ['TU'], monthDay: day }
  }
  return { freq: 'WEEKLY', days: ['TU'], monthDay: '15' }
}

/** Human-friendly summary of a RRULE for display. */
function describeRrule(rrule: string): string {
  if (rrule.startsWith('FREQ=WEEKLY')) {
    const days = rrule.match(/BYDAY=([A-Z,]+)/)?.[1]?.split(',') ?? []
    const labels = days.map(d => DOW.find(x => x.key === d)?.label ?? d).join(', ')
    return `Weekly · ${labels}`
  }
  if (rrule.startsWith('FREQ=MONTHLY')) {
    const day = rrule.match(/BYMONTHDAY=(\d+)/)?.[1] ?? '?'
    return `Monthly · ${day}${day === '1' ? 'st' : day === '2' ? 'nd' : day === '3' ? 'rd' : 'th'}`
  }
  return rrule
}

export function SchedulesPage() {
  const [rows, setRows] = useState<ScheduleRow[]>([])
  const [customers, setCustomers] = useState<CustomerLite[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [actioning, setActioning] = useState<string | null>(null)

  // Form state
  const [form, setForm] = useState({
    customerId: '',
    serviceType: 'Weekly trash pickup',
    freq: 'WEEKLY' as 'WEEKLY' | 'MONTHLY',
    days: ['TU'] as string[],
    monthDay: '15',
    timeOfDay: '09:00',
    startDate: new Date().toISOString().slice(0, 10),
    endDate: '',
  })
  const [saving, setSaving] = useState(false)

  const [editing, setEditing] = useState<ScheduleRow | null>(null)
  const [editForm, setEditForm] = useState({
    serviceType: '',
    freq: 'WEEKLY' as 'WEEKLY' | 'MONTHLY',
    days: ['TU'] as string[],
    monthDay: '15',
    timeOfDay: '09:00',
    endDate: '',
  })
  const [editSaving, setEditSaving] = useState(false)

  const reload = async () => {
    try {
      const [ss, cs] = await Promise.all([
        apiGet<ScheduleRow[]>('/recurring-schedules'),
        apiGet<CustomerLite[]>('/business-customers'),
      ])
      setRows(ss)
      setCustomers(cs)
      if (!form.customerId && cs.length > 0) {
        setForm(f => ({ ...f, customerId: cs[0].id }))
      }
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load schedules')
    } finally { setLoading(false) }
  }

  useEffect(() => { reload() }, [])

  const toggleDay = (key: string) => {
    setForm(f => ({
      ...f,
      days: f.days.includes(key) ? f.days.filter(d => d !== key) : [...f.days, key],
    }))
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null)
    if (form.freq === 'WEEKLY' && form.days.length === 0) {
      setErr('Pick at least one day of the week.')
      return
    }
    setSaving(true)
    try {
      await apiPost('/recurring-schedules', {
        customerId: form.customerId,
        serviceType: form.serviceType,
        rrule: buildRrule(form.freq, form.days, form.monthDay),
        timeOfDay: form.timeOfDay,
        startDate: form.startDate,
        endDate: form.endDate || null,
      })
      // Reset form to sensible defaults after a successful save.
      setForm(f => ({
        ...f,
        serviceType: 'Weekly trash pickup',
        days: ['TU'],
        monthDay: '15',
      }))
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Create failed')
    } finally { setSaving(false) }
  }

  const startEdit = (r: ScheduleRow) => {
    setEditing(r)
    const parsed = parseRrule(r.rrule)
    setEditForm({
      serviceType: r.service_type,
      freq: parsed.freq, days: parsed.days, monthDay: parsed.monthDay,
      timeOfDay: r.time_of_day,
      endDate: r.end_date ?? '',
    })
  }

  const toggleEditDay = (key: string) => {
    setEditForm(f => ({
      ...f,
      days: f.days.includes(key) ? f.days.filter(d => d !== key) : [...f.days, key],
    }))
  }

  const onEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editing) return
    setErr(null)
    if (editForm.freq === 'WEEKLY' && editForm.days.length === 0) {
      setErr('Pick at least one day of the week.')
      return
    }
    setEditSaving(true)
    try {
      await apiPatch(`/recurring-schedules/${editing.id}`, {
        serviceType: editForm.serviceType,
        rrule: buildRrule(editForm.freq, editForm.days, editForm.monthDay),
        timeOfDay: editForm.timeOfDay,
        endDate: editForm.endDate || null,
      })
      setEditing(null)
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Save failed')
    } finally { setEditSaving(false) }
  }

  const onPauseOrResume = async (s: ScheduleRow) => {
    setActioning(s.id)
    try {
      const action = s.status === 'active' ? 'pause' : 'resume'
      await apiPost(`/recurring-schedules/${s.id}/${action}`)
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Action failed')
    } finally { setActioning(null) }
  }

  if (!loading && customers.length === 0) {
    return (
      <div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, marginTop: 0 }}>Schedules</h1>
        <div style={emptyStyle}>
          Add a <strong style={{ color: 'var(--gold)' }}>customer</strong> first
          — schedules connect a recurring service to a specific customer.
        </div>
      </div>
    )
  }

  return (
    <div>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, marginTop: 0 }}>
        Schedules
      </h1>
      <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 24 }}>
        Recurring service patterns ("Mrs. Smith, every Tuesday at 9 AM").
        The system generates actual appointment rows automatically — they
        show up on routes for the day they fall on.
      </div>

      {err && <div style={errStyle}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
        <div>
          {loading ? (
            <div style={{ color: 'var(--text-2)' }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={emptyStyle}>No schedules yet.</div>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
                  <th style={thStyle}>Customer</th>
                  <th style={thStyle}>Service</th>
                  <th style={thStyle}>When</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                    <td style={tdStyle}>
                      {r.first_name} {r.last_name}
                      {r.company_name && (
                        <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{r.company_name}</div>
                      )}
                    </td>
                    <td style={tdStyle}>{r.service_type}</td>
                    <td style={tdStyle}>
                      <div>{describeRrule(r.rrule)}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                        at {r.time_of_day}
                      </div>
                    </td>
                    <td style={tdStyle}>{r.status}</td>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {r.status !== 'ended' && (
                          <>
                            <button onClick={() => startEdit(r)} style={iconBtnStyle('default', false)}>
                              <Pencil size={12} /> Edit
                            </button>
                            <button
                              onClick={() => onPauseOrResume(r)}
                              disabled={actioning === r.id}
                              style={iconBtnStyle('gold', actioning === r.id)}
                            >
                              {r.status === 'active'
                                ? (<><Pause size={12} /> Pause</>)
                                : (<><Play size={12} /> Resume</>)}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div>
          <h2 style={h2Style}>Add a schedule</h2>
          <form onSubmit={onSubmit} style={formStyle}>
            <label style={labelStyle}>Customer</label>
            <select value={form.customerId}
              onChange={e => setForm({ ...form, customerId: e.target.value })}
              required style={inputStyle}>
              {customers.map(c => (
                <option key={c.id} value={c.id}>
                  {c.firstName} {c.lastName}
                  {c.companyName && ` — ${c.companyName}`}
                </option>
              ))}
            </select>

            <label style={labelStyle}>Service type</label>
            <input value={form.serviceType}
              onChange={e => setForm({ ...form, serviceType: e.target.value })}
              required style={inputStyle} />

            <label style={labelStyle}>Frequency</label>
            <select value={form.freq}
              onChange={e => setForm({ ...form, freq: e.target.value as any })}
              style={inputStyle}>
              <option value="WEEKLY">Weekly</option>
              <option value="MONTHLY">Monthly</option>
            </select>

            {form.freq === 'WEEKLY' ? (
              <>
                <label style={labelStyle}>Days of the week</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {DOW.map(d => (
                    <button
                      key={d.key}
                      type="button"
                      onClick={() => toggleDay(d.key)}
                      style={{
                        padding: '8px 12px',
                        background: form.days.includes(d.key) ? 'var(--gold-bg)' : 'var(--bg-2)',
                        color: form.days.includes(d.key) ? 'var(--gold)' : 'var(--text-1)',
                        border: `1px solid ${form.days.includes(d.key) ? 'var(--gold)' : 'var(--border-1)'}`,
                        borderRadius: 6,
                        fontSize: 12, cursor: 'pointer',
                        fontFamily: 'var(--font-body)',
                      }}
                    >{d.label}</button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <label style={labelStyle}>Day of the month (1–28)</label>
                <input value={form.monthDay}
                  onChange={e => setForm({ ...form, monthDay: e.target.value })}
                  type="number" min="1" max="28" required style={inputStyle} />
              </>
            )}

            <label style={labelStyle}>Time of day</label>
            <input value={form.timeOfDay}
              onChange={e => setForm({ ...form, timeOfDay: e.target.value })}
              type="time" required style={inputStyle} />

            <label style={labelStyle}>Start date</label>
            <input value={form.startDate}
              onChange={e => setForm({ ...form, startDate: e.target.value })}
              type="date" required style={inputStyle} />

            <label style={labelStyle}>End date (optional)</label>
            <input value={form.endDate}
              onChange={e => setForm({ ...form, endDate: e.target.value })}
              type="date" style={inputStyle} />

            <button type="submit" disabled={saving}
              style={{ ...btnStyle, opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Saving…' : 'Add schedule'}
            </button>
          </form>
        </div>
      </div>

      {editing && (
        <Modal title="Edit schedule"
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" onClick={() => setEditing(null)} style={cancelBtnStyle}>Cancel</button>
              <button type="submit" form="schedule-edit" disabled={editSaving}
                style={{ ...saveBtnStyle, opacity: editSaving ? 0.6 : 1 }}>
                {editSaving ? 'Saving…' : 'Save changes'}
              </button>
            </>
          }>
          <form id="schedule-edit" onSubmit={onEditSubmit}>
            <div style={{ padding: 12, background: 'var(--bg-2)', borderRadius: 8, marginBottom: 8, fontSize: 13, color: 'var(--text-2)' }}>
              Editing schedule for{' '}
              <strong style={{ color: 'var(--text-0)' }}>
                {editing.first_name} {editing.last_name}
                {editing.company_name ? ` — ${editing.company_name}` : ''}
              </strong>
              . Customer + start date can't change; create a new schedule
              if either needs to differ.
            </div>

            <label style={labelStyle}>Service type</label>
            <input value={editForm.serviceType}
              onChange={e => setEditForm({ ...editForm, serviceType: e.target.value })}
              required style={inputStyle} />

            <label style={labelStyle}>Frequency</label>
            <select value={editForm.freq}
              onChange={e => setEditForm({ ...editForm, freq: e.target.value as any })}
              style={inputStyle}>
              <option value="WEEKLY">Weekly</option>
              <option value="MONTHLY">Monthly</option>
            </select>

            {editForm.freq === 'WEEKLY' ? (
              <>
                <label style={labelStyle}>Days of the week</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {DOW.map(d => (
                    <button
                      key={d.key}
                      type="button"
                      onClick={() => toggleEditDay(d.key)}
                      style={{
                        padding: '8px 12px',
                        background: editForm.days.includes(d.key) ? 'var(--gold-bg)' : 'var(--bg-2)',
                        color: editForm.days.includes(d.key) ? 'var(--gold)' : 'var(--text-1)',
                        border: `1px solid ${editForm.days.includes(d.key) ? 'var(--gold)' : 'var(--border-1)'}`,
                        borderRadius: 6,
                        fontSize: 12, cursor: 'pointer',
                        fontFamily: 'var(--font-body)',
                      }}
                    >{d.label}</button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <label style={labelStyle}>Day of the month (1–28)</label>
                <input value={editForm.monthDay}
                  onChange={e => setEditForm({ ...editForm, monthDay: e.target.value })}
                  type="number" min="1" max="28" required style={inputStyle} />
              </>
            )}

            <label style={labelStyle}>Time of day</label>
            <input value={editForm.timeOfDay}
              onChange={e => setEditForm({ ...editForm, timeOfDay: e.target.value })}
              type="time" required style={inputStyle} />

            <label style={labelStyle}>End date (optional)</label>
            <input value={editForm.endDate}
              onChange={e => setEditForm({ ...editForm, endDate: e.target.value })}
              type="date" style={inputStyle} />
          </form>
        </Modal>
      )}
    </div>
  )
}

const h2Style: React.CSSProperties = {
  fontFamily: 'var(--font-body)', fontSize: 18, marginTop: 0, marginBottom: 12,
}
const formStyle: React.CSSProperties = {
  padding: 20, background: 'var(--bg-1)',
  border: '1px solid var(--border-0)', borderRadius: 12,
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
  marginBottom: 6, marginTop: 12,
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
const errStyle: React.CSSProperties = {
  marginBottom: 16, padding: '10px 12px',
  background: 'var(--red-bg)', color: 'var(--red)',
  border: '1px solid var(--red-dim)', borderRadius: 8, fontSize: 13,
}
const emptyStyle: React.CSSProperties = {
  padding: 32, textAlign: 'center',
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, color: 'var(--text-2)', fontSize: 14,
}
