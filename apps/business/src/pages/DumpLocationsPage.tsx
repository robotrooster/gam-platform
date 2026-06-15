import { useEffect, useState } from 'react'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { Pencil, Archive } from 'lucide-react'
import { Modal } from '../components/Modal'
import { iconBtnStyle, cancelBtnStyle, saveBtnStyle } from './CustomersPage'

interface DumpRow {
  id: string
  name: string
  street1: string; city: string; state: string; zip: string
  lat: string; lon: string
  typical_dump_minutes: number
  operating_hours: string | null
  status: string
}

export function DumpLocationsPage() {
  const [rows, setRows] = useState<DumpRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({
    name: '', street1: '', city: '', state: '', zip: '',
    lat: '', lon: '',
    typicalDumpMinutes: '15',
    operatingHours: '',
  })
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<DumpRow | null>(null)
  const [editForm, setEditForm] = useState({
    name: '', street1: '', city: '', state: '', zip: '',
    lat: '', lon: '', typicalDumpMinutes: '15', operatingHours: '',
  })
  const [editSaving, setEditSaving] = useState(false)
  const [archiving, setArchiving] = useState<string | null>(null)

  const reload = async () => {
    try {
      const data = await apiGet<DumpRow[]>('/dump-locations')
      setRows(data)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load dump locations')
    } finally { setLoading(false) }
  }

  useEffect(() => { reload() }, [])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setSaving(true)
    try {
      await apiPost('/dump-locations', {
        name: form.name,
        street1: form.street1, city: form.city, state: form.state, zip: form.zip,
        lat: Number(form.lat), lon: Number(form.lon),
        typicalDumpMinutes: Number(form.typicalDumpMinutes),
        operatingHours: form.operatingHours || undefined,
      })
      setForm({
        name: '', street1: '', city: '', state: '', zip: '',
        lat: '', lon: '',
        typicalDumpMinutes: '15', operatingHours: '',
      })
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Create failed')
    } finally { setSaving(false) }
  }

  const startEdit = (r: DumpRow) => {
    setEditing(r)
    setEditForm({
      name: r.name, street1: r.street1, city: r.city, state: r.state, zip: r.zip,
      lat: String(r.lat), lon: String(r.lon),
      typicalDumpMinutes: String(r.typical_dump_minutes),
      operatingHours: r.operating_hours ?? '',
    })
  }

  const onEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editing) return
    setErr(null); setEditSaving(true)
    try {
      await apiPatch(`/dump-locations/${editing.id}`, {
        name: editForm.name,
        street1: editForm.street1,
        city: editForm.city, state: editForm.state, zip: editForm.zip,
        lat: Number(editForm.lat), lon: Number(editForm.lon),
        typicalDumpMinutes: Number(editForm.typicalDumpMinutes),
        operatingHours: editForm.operatingHours || null,
      })
      setEditing(null)
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Save failed')
    } finally { setEditSaving(false) }
  }

  const onArchive = async (r: DumpRow) => {
    if (!window.confirm(`Archive ${r.name}? It won't be used by the route engine after this.`)) return
    setArchiving(r.id); setErr(null)
    try {
      await apiPost(`/dump-locations/${r.id}/archive`)
      await reload()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Archive failed')
    } finally { setArchiving(null) }
  }

  return (
    <div>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, marginTop: 0 }}>
        Dump Locations
      </h1>
      <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 24 }}>
        Transfer stations + landfills where your trucks unload. The route
        engine routes through the nearest one when your truck hits its
        per-route stop limit.
      </div>

      {err && <div style={errStyle}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
        <div>
          {loading ? (
            <div style={{ color: 'var(--text-2)' }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={emptyStyle}>No dump locations yet.</div>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Address</th>
                  <th style={thStyle}>Dump time</th>
                  <th style={thStyle}>Hours</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                    <td style={tdStyle}>{r.name}</td>
                    <td style={tdStyle}>{r.street1}, {r.city}</td>
                    <td style={tdStyle}>{r.typical_dump_minutes} min</td>
                    <td style={tdStyle}>{r.operating_hours ?? '24/7'}</td>
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
          <h2 style={h2Style}>Add a dump location</h2>
          <form onSubmit={onSubmit} style={formStyle}>
            <label style={labelStyle}>Name</label>
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
              required style={inputStyle} placeholder="North Transfer Station" />

            <label style={labelStyle}>Street</label>
            <input value={form.street1} onChange={e => setForm({ ...form, street1: e.target.value })}
              required style={inputStyle} />

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
              <div>
                <label style={labelStyle}>City</label>
                <input value={form.city} onChange={e => setForm({ ...form, city: e.target.value })}
                  required style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>State</label>
                <input value={form.state} onChange={e => setForm({ ...form, state: e.target.value })}
                  required style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>ZIP</label>
                <input value={form.zip} onChange={e => setForm({ ...form, zip: e.target.value })}
                  required style={inputStyle} />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <label style={labelStyle}>Latitude</label>
                <input value={form.lat} onChange={e => setForm({ ...form, lat: e.target.value })}
                  required type="number" step="any" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Longitude</label>
                <input value={form.lon} onChange={e => setForm({ ...form, lon: e.target.value })}
                  required type="number" step="any" style={inputStyle} />
              </div>
            </div>

            <label style={labelStyle}>Typical dump time (minutes)</label>
            <input value={form.typicalDumpMinutes}
              onChange={e => setForm({ ...form, typicalDumpMinutes: e.target.value })}
              type="number" min="1" required style={inputStyle} />

            <label style={labelStyle}>Operating hours (optional)</label>
            <input value={form.operatingHours}
              onChange={e => setForm({ ...form, operatingHours: e.target.value })}
              style={inputStyle} placeholder="06:00-18:00 weekdays" />

            <button type="submit" disabled={saving}
              style={{ ...btnStyle, opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Saving…' : 'Add dump location'}
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
              <button type="submit" form="dump-edit" disabled={editSaving}
                style={{ ...saveBtnStyle, opacity: editSaving ? 0.6 : 1 }}>
                {editSaving ? 'Saving…' : 'Save changes'}
              </button>
            </>
          }>
          <form id="dump-edit" onSubmit={onEditSubmit}>
            <label style={labelStyle}>Name</label>
            <input value={editForm.name}
              onChange={e => setEditForm({ ...editForm, name: e.target.value })}
              required style={inputStyle} />
            <label style={labelStyle}>Street</label>
            <input value={editForm.street1}
              onChange={e => setEditForm({ ...editForm, street1: e.target.value })}
              required style={inputStyle} />
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
              <div>
                <label style={labelStyle}>City</label>
                <input value={editForm.city}
                  onChange={e => setEditForm({ ...editForm, city: e.target.value })}
                  required style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>State</label>
                <input value={editForm.state}
                  onChange={e => setEditForm({ ...editForm, state: e.target.value })}
                  required style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>ZIP</label>
                <input value={editForm.zip}
                  onChange={e => setEditForm({ ...editForm, zip: e.target.value })}
                  required style={inputStyle} />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <label style={labelStyle}>Latitude</label>
                <input value={editForm.lat}
                  onChange={e => setEditForm({ ...editForm, lat: e.target.value })}
                  required type="number" step="any" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Longitude</label>
                <input value={editForm.lon}
                  onChange={e => setEditForm({ ...editForm, lon: e.target.value })}
                  required type="number" step="any" style={inputStyle} />
              </div>
            </div>
            <label style={labelStyle}>Typical dump time (minutes)</label>
            <input value={editForm.typicalDumpMinutes}
              onChange={e => setEditForm({ ...editForm, typicalDumpMinutes: e.target.value })}
              type="number" min="1" required style={inputStyle} />
            <label style={labelStyle}>Operating hours (optional)</label>
            <input value={editForm.operatingHours}
              onChange={e => setEditForm({ ...editForm, operatingHours: e.target.value })}
              style={inputStyle} placeholder="06:00-18:00 weekdays" />
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
