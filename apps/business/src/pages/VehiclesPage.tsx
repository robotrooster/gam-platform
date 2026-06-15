import { useEffect, useState } from 'react'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { Pencil, Archive } from 'lucide-react'
import { Modal } from '../components/Modal'
import { iconBtnStyle, cancelBtnStyle, saveBtnStyle } from './CustomersPage'

interface VehicleRow {
  id: string
  name: string
  plate_or_id: string | null
  home_depot_id: string
  home_depot_name: string
  stops_per_dump: number
  avg_speed_mph: number
  avg_service_minutes: number
  status: string
}

interface DepotRow {
  id: string
  name: string
}

export function VehiclesPage() {
  const [rows, setRows] = useState<VehicleRow[]>([])
  const [depots, setDepots] = useState<DepotRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({
    name: '', plateOrId: '', homeDepotId: '',
    stopsPerDump: '50', avgSpeedMph: '25', avgServiceMinutes: '3',
  })
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<VehicleRow | null>(null)
  const [editForm, setEditForm] = useState({
    name: '', plateOrId: '', homeDepotId: '',
    stopsPerDump: '50', avgSpeedMph: '25', avgServiceMinutes: '3',
  })
  const [editSaving, setEditSaving] = useState(false)
  const [archiving, setArchiving] = useState<string | null>(null)

  const reload = async () => {
    try {
      const [vs, ds] = await Promise.all([
        apiGet<VehicleRow[]>('/vehicles'),
        apiGet<DepotRow[]>('/depots'),
      ])
      setRows(vs)
      setDepots(ds)
      if (!form.homeDepotId && ds.length > 0) {
        setForm(f => ({ ...f, homeDepotId: ds[0].id }))
      }
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load vehicles')
    } finally { setLoading(false) }
  }

  useEffect(() => { reload() }, [])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setSaving(true)
    try {
      await apiPost('/vehicles', {
        name: form.name,
        plateOrId: form.plateOrId || undefined,
        homeDepotId: form.homeDepotId,
        stopsPerDump: Number(form.stopsPerDump),
        avgSpeedMph: Number(form.avgSpeedMph),
        avgServiceMinutes: Number(form.avgServiceMinutes),
      })
      setForm({
        ...form,
        name: '', plateOrId: '',
        stopsPerDump: '50', avgSpeedMph: '25', avgServiceMinutes: '3',
      })
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Create failed')
    } finally { setSaving(false) }
  }

  const startEdit = (r: VehicleRow) => {
    setEditing(r)
    setEditForm({
      name: r.name, plateOrId: r.plate_or_id ?? '',
      homeDepotId: r.home_depot_id,
      stopsPerDump: String(r.stops_per_dump),
      avgSpeedMph: String(r.avg_speed_mph),
      avgServiceMinutes: String(r.avg_service_minutes),
    })
  }

  const onEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editing) return
    setErr(null); setEditSaving(true)
    try {
      await apiPatch(`/vehicles/${editing.id}`, {
        name: editForm.name,
        plateOrId: editForm.plateOrId || null,
        homeDepotId: editForm.homeDepotId,
        stopsPerDump: Number(editForm.stopsPerDump),
        avgSpeedMph: Number(editForm.avgSpeedMph),
        avgServiceMinutes: Number(editForm.avgServiceMinutes),
      })
      setEditing(null)
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Save failed')
    } finally { setEditSaving(false) }
  }

  const onArchive = async (r: VehicleRow) => {
    if (!window.confirm(`Archive ${r.name}? It won't be eligible for route generation after this.`)) return
    setArchiving(r.id); setErr(null)
    try {
      await apiPost(`/vehicles/${r.id}/archive`)
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Archive failed')
    } finally { setArchiving(null) }
  }

  if (!loading && depots.length === 0) {
    return (
      <div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, marginTop: 0 }}>Vehicles</h1>
        <div style={emptyStyle}>
          Add a <strong style={{ color: 'var(--gold)' }}>depot</strong> first
          — every vehicle needs a home depot to start its routes from.
        </div>
      </div>
    )
  }

  return (
    <div>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, marginTop: 0 }}>
        Vehicles
      </h1>
      <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 24 }}>
        Your trucks. Each one needs a home depot + capacity hints
        (stops per dump, speed, service time) used by the route engine.
      </div>

      {err && <div style={errStyle}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
        <div>
          {loading ? (
            <div style={{ color: 'var(--text-2)' }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={emptyStyle}>No vehicles yet. Add one to get started.</div>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Plate / ID</th>
                  <th style={thStyle}>Home depot</th>
                  <th style={thStyle}>Stops / dump</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                    <td style={tdStyle}>{r.name}</td>
                    <td style={tdStyle}>{r.plate_or_id ?? '—'}</td>
                    <td style={tdStyle}>{r.home_depot_name}</td>
                    <td style={tdStyle}>{r.stops_per_dump}</td>
                    <td style={tdStyle}>{r.status}</td>
                    <td style={tdStyle}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => startEdit(r)} style={iconBtnStyle('default', false)}>
                          <Pencil size={12} /> Edit
                        </button>
                        <button onClick={() => onArchive(r)}
                          disabled={archiving === r.id}
                          style={iconBtnStyle('amber', archiving === r.id)}>
                          <Archive size={12} />
                          {archiving === r.id ? 'Archiving…' : 'Archive'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div>
          <h2 style={h2Style}>Add a vehicle</h2>
          <form onSubmit={onSubmit} style={formStyle}>
            <label style={labelStyle}>Name</label>
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
              required style={inputStyle} placeholder="Truck 1" />

            <label style={labelStyle}>Plate or fleet ID (optional)</label>
            <input value={form.plateOrId} onChange={e => setForm({ ...form, plateOrId: e.target.value })}
              style={inputStyle} placeholder="ABC-1234" />

            <label style={labelStyle}>Home depot</label>
            <select value={form.homeDepotId}
              onChange={e => setForm({ ...form, homeDepotId: e.target.value })}
              required style={inputStyle}>
              {depots.map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <div>
                <label style={labelStyle}>Stops / dump</label>
                <input value={form.stopsPerDump}
                  onChange={e => setForm({ ...form, stopsPerDump: e.target.value })}
                  type="number" min="1" required style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Speed (mph)</label>
                <input value={form.avgSpeedMph}
                  onChange={e => setForm({ ...form, avgSpeedMph: e.target.value })}
                  type="number" min="1" required style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Service (min)</label>
                <input value={form.avgServiceMinutes}
                  onChange={e => setForm({ ...form, avgServiceMinutes: e.target.value })}
                  type="number" min="1" required style={inputStyle} />
              </div>
            </div>

            <button type="submit" disabled={saving}
              style={{ ...btnStyle, opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Saving…' : 'Add vehicle'}
            </button>
          </form>
        </div>
      </div>

      {editing && (
        <Modal title={`Edit ${editing.name}`}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" onClick={() => setEditing(null)} style={cancelBtnStyle}>Cancel</button>
              <button type="submit" form="vehicle-edit" disabled={editSaving}
                style={{ ...saveBtnStyle, opacity: editSaving ? 0.6 : 1 }}>
                {editSaving ? 'Saving…' : 'Save changes'}
              </button>
            </>
          }>
          <form id="vehicle-edit" onSubmit={onEditSubmit}>
            <label style={labelStyle}>Name</label>
            <input value={editForm.name}
              onChange={e => setEditForm({ ...editForm, name: e.target.value })}
              required style={inputStyle} />
            <label style={labelStyle}>Plate or fleet ID (optional)</label>
            <input value={editForm.plateOrId}
              onChange={e => setEditForm({ ...editForm, plateOrId: e.target.value })}
              style={inputStyle} />
            <label style={labelStyle}>Home depot</label>
            <select value={editForm.homeDepotId}
              onChange={e => setEditForm({ ...editForm, homeDepotId: e.target.value })}
              required style={inputStyle}>
              {depots.map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <div>
                <label style={labelStyle}>Stops / dump</label>
                <input value={editForm.stopsPerDump}
                  onChange={e => setEditForm({ ...editForm, stopsPerDump: e.target.value })}
                  type="number" min="1" required style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Speed (mph)</label>
                <input value={editForm.avgSpeedMph}
                  onChange={e => setEditForm({ ...editForm, avgSpeedMph: e.target.value })}
                  type="number" min="1" required style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Service (min)</label>
                <input value={editForm.avgServiceMinutes}
                  onChange={e => setEditForm({ ...editForm, avgServiceMinutes: e.target.value })}
                  type="number" min="1" required style={inputStyle} />
              </div>
            </div>
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
