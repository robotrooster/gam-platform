import { useEffect, useState } from 'react'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { Modal } from '../components/Modal'
import { Plus, ChevronRight, ArrowLeft, Search, Pencil, Archive, Car } from 'lucide-react'

interface Customer {
  id: string
  firstName: string | null
  lastName: string | null
  companyName: string | null
}

interface Vehicle {
  id: string
  customerId: string
  vin: string | null
  licensePlate: string | null
  licensePlateState: string | null
  year: number | null
  make: string | null
  model: string | null
  color: string | null
  currentMileage: number | null
  notes: string | null
  isActive: boolean
  customerFirstName: string | null
  customerLastName: string | null
  customerCompanyName: string | null
}

interface WorkOrderRow {
  id: string
  woNumber: string
  status: string
  complaint: string | null
  totalAmount: string
  createdAt: string
}

interface VehicleDetail extends Vehicle {
  customerPhone: string | null
  customerEmail: string | null
  workOrders: WorkOrderRow[]
}

function customerLabel(v: Pick<Vehicle, 'customerCompanyName' | 'customerFirstName' | 'customerLastName'>): string {
  if (v.customerCompanyName) return v.customerCompanyName
  return `${v.customerFirstName ?? ''} ${v.customerLastName ?? ''}`.trim() || 'Unnamed'
}

function ymmLabel(v: Pick<Vehicle, 'year' | 'make' | 'model'>): string {
  return [v.year, v.make, v.model].filter(Boolean).join(' ') || '(no make/model)'
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  return new Date(s).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtMoney(n: string | number | null | undefined): string {
  if (n == null) return '$0.00'
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function CustomerVehiclesPage() {
  const [list, setList] = useState<Vehicle[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [search, setSearch] = useState('')
  const [customerFilter, setCustomerFilter] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const reload = async () => {
    setErr(null)
    try {
      const params: string[] = []
      if (search.trim())    params.push(`q=${encodeURIComponent(search.trim())}`)
      if (customerFilter)   params.push(`customerId=${customerFilter}`)
      const qs = params.length ? `?${params.join('&')}` : ''
      const [v, c] = await Promise.all([
        apiGet<Vehicle[]>(`/business-vehicles${qs}`),
        apiGet<Customer[]>('/business-customers'),
      ])
      setList(v); setCustomers(c)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load')
    }
  }
  useEffect(() => { reload() }, [search, customerFilter])

  if (selectedId) return <VehicleDetailView id={selectedId} customers={customers}
    onBack={() => { setSelectedId(null); reload() }} />

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, margin: 0 }}>Customer vehicles</h1>
          <div style={{ color: 'var(--text-2)', fontSize: 14, marginTop: 4 }}>
            Track each customer's vehicles + service history. VINs are recorded for cross-shop history (future).
          </div>
        </div>
        <button onClick={() => setShowCreate(true)} style={primaryBtnStyle}>
          <Plus size={14} /> New vehicle
        </button>
      </div>

      {err && <div style={errStyle}>{err}</div>}

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 360 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search VIN / plate / make / model…"
            style={{ ...inputStyle, paddingLeft: 32, marginTop: 0 }} />
        </div>
        <select value={customerFilter} onChange={e => setCustomerFilter(e.target.value)}
          style={{ ...inputStyle, marginTop: 0, maxWidth: 240 }}>
          <option value="">All customers</option>
          {customers.map(c => (
            <option key={c.id} value={c.id}>
              {c.companyName || `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'Unnamed'}
            </option>
          ))}
        </select>
      </div>

      {list.length === 0 ? (
        <div style={emptyStyle}>
          {search || customerFilter
            ? 'No vehicles match these filters.'
            : 'No vehicles yet. Create one to track a customer\'s car.'}
        </div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
              <th style={thStyle}>Vehicle</th>
              <th style={thStyle}>Customer</th>
              <th style={thStyle}>VIN</th>
              <th style={thStyle}>Plate</th>
              <th style={thStyle}>Mileage</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {list.map(v => (
              <tr key={v.id} onClick={() => setSelectedId(v.id)}
                style={{ borderBottom: '1px solid var(--border-0)', cursor: 'pointer' }}>
                <td style={tdStyle}>
                  <strong style={{ color: 'var(--text-0)' }}>{ymmLabel(v)}</strong>
                  {v.color && (
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{v.color}</div>
                  )}
                </td>
                <td style={tdStyle}>{customerLabel(v)}</td>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, fontSize: 12 }}>
                  {v.vin || <span style={{ color: 'var(--text-3)' }}>—</span>}
                </td>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, fontSize: 12 }}>
                  {v.licensePlate
                    ? `${v.licensePlate}${v.licensePlateState ? ` (${v.licensePlateState})` : ''}`
                    : <span style={{ color: 'var(--text-3)' }}>—</span>}
                </td>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const }}>
                  {v.currentMileage !== null ? v.currentMileage.toLocaleString() : <span style={{ color: 'var(--text-3)' }}>—</span>}
                </td>
                <td style={tdStyle}><ChevronRight size={14} color="var(--text-3)" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showCreate && (
        <VehicleFormModal mode="create" customers={customers}
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); reload() }} />
      )}
    </div>
  )
}

function VehicleDetailView({
  id, customers, onBack,
}: { id: string; customers: Customer[]; onBack: () => void }) {
  const [v, setV] = useState<VehicleDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [showEdit, setShowEdit] = useState(false)

  const reload = async () => {
    setErr(null)
    try {
      const d = await apiGet<VehicleDetail>(`/business-vehicles/${id}`)
      setV(d)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load')
    }
  }
  useEffect(() => { reload() }, [id])

  const onArchive = async () => {
    if (!window.confirm('Archive this vehicle? It stays on record but won\'t show in lists.')) return
    try {
      await apiPost(`/business-vehicles/${id}/archive`)
      onBack()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Archive failed')
    }
  }

  if (!v) return (
    <div>
      <button onClick={onBack} style={ghostBtn}><ArrowLeft size={14} /> Back</button>
      {err && <div style={errStyle}>{err}</div>}
      <div style={{ marginTop: 16, color: 'var(--text-2)' }}>Loading…</div>
    </div>
  )

  return (
    <div>
      <button onClick={onBack} style={ghostBtn}><ArrowLeft size={14} /> Back to vehicles</button>
      {err && <div style={{ ...errStyle, marginTop: 16 }}>{err}</div>}

      <div style={{
        marginTop: 16, padding: 24,
        background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 12,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 16 }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: 0 }}>
              <Car size={18} style={{ verticalAlign: 'middle', marginRight: 8, color: 'var(--gold)' }} />
              {ymmLabel(v)}
            </h1>
            <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 6 }}>
              {customerLabel(v)}
              {v.customerPhone && <> · <span style={{ fontFamily: 'var(--font-mono)' as const }}>{v.customerPhone}</span></>}
              {v.customerEmail && <> · {v.customerEmail}</>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setShowEdit(true)} style={ghostBtn}><Pencil size={12} /> Edit</button>
            <button onClick={onArchive} style={ghostBtn}><Archive size={12} /> Archive</button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
          <Field label="VIN"     value={v.vin} mono />
          <Field label="Plate"   value={v.licensePlate ? `${v.licensePlate}${v.licensePlateState ? ` (${v.licensePlateState})` : ''}` : null} mono />
          <Field label="Color"   value={v.color} />
          <Field label="Current mileage" value={v.currentMileage !== null ? v.currentMileage.toLocaleString() : null} mono />
        </div>

        {v.notes && (
          <div style={{ padding: 14, background: 'var(--bg-2)', borderRadius: 8, marginBottom: 24 }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: 1, marginBottom: 4 }}>Notes</div>
            <div style={{ fontSize: 14, color: 'var(--text-1)', whiteSpace: 'pre-wrap' as const }}>{v.notes}</div>
          </div>
        )}

        <h2 style={{ fontSize: 14, color: 'var(--text-2)', textTransform: 'uppercase' as const, letterSpacing: 1, margin: '0 0 8px 0' }}>
          Service history
        </h2>
        {v.workOrders.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-3)' }}>No work orders yet.</div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
                <th style={thStyle}>WO #</th>
                <th style={thStyle}>Date</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Complaint</th>
                <th style={thStyle}>Total</th>
              </tr>
            </thead>
            <tbody>
              {v.workOrders.map(w => (
                <tr key={w.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const }}>{w.woNumber}</td>
                  <td style={tdStyle}>{fmtDate(w.createdAt)}</td>
                  <td style={{ ...tdStyle, fontSize: 12, textTransform: 'capitalize' as const }}>{w.status.replace('_', ' ')}</td>
                  <td style={{ ...tdStyle, fontSize: 12, color: 'var(--text-2)' }}>
                    {w.complaint ? (w.complaint.length > 50 ? w.complaint.slice(0, 50) + '…' : w.complaint) : <span style={{ color: 'var(--text-3)' }}>—</span>}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, fontWeight: 600 }}>{fmtMoney(w.totalAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showEdit && (
        <VehicleFormModal mode="edit" customers={customers} vehicle={v}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); reload() }} />
      )}
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: 1, marginBottom: 4 }}>{label}</div>
      <div style={{
        fontSize: 14, color: 'var(--text-0)',
        fontFamily: mono ? 'var(--font-mono)' as const : undefined,
      }}>
        {value || <span style={{ color: 'var(--text-3)' }}>—</span>}
      </div>
    </div>
  )
}

function VehicleFormModal({
  mode, customers, vehicle, onClose, onSaved,
}: {
  mode: 'create' | 'edit'
  customers: Customer[]
  vehicle?: Vehicle
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    customerId:        vehicle?.customerId        ?? '',
    vin:               vehicle?.vin               ?? '',
    licensePlate:      vehicle?.licensePlate      ?? '',
    licensePlateState: vehicle?.licensePlateState ?? '',
    year:              vehicle ? String(vehicle.year ?? '') : '',
    make:              vehicle?.make              ?? '',
    model:             vehicle?.model             ?? '',
    color:             vehicle?.color             ?? '',
    currentMileage:    vehicle ? String(vehicle.currentMileage ?? '') : '',
    notes:             vehicle?.notes             ?? '',
  })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setErr(null)
    if (mode === 'create' && !form.customerId) { setErr('Pick a customer'); return }
    setBusy(true)
    try {
      const payload: any = {
        vin:               form.vin.trim() || null,
        licensePlate:      form.licensePlate.trim() || null,
        licensePlateState: form.licensePlateState.trim().toUpperCase() || null,
        year:              form.year.trim() ? parseInt(form.year, 10) : null,
        make:              form.make.trim() || null,
        model:             form.model.trim() || null,
        color:             form.color.trim() || null,
        currentMileage:    form.currentMileage.trim() ? parseInt(form.currentMileage, 10) : null,
        notes:             form.notes.trim() || null,
      }
      if (mode === 'create') {
        payload.customerId = form.customerId
        await apiPost('/business-vehicles', payload)
      } else {
        await apiPatch(`/business-vehicles/${vehicle!.id}`, payload)
      }
      onSaved()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Save failed')
    } finally { setBusy(false) }
  }

  return (
    <Modal title={mode === 'create' ? 'New vehicle' : 'Edit vehicle'} onClose={onClose} width={560}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={busy} style={primaryBtnStyle}>
            {busy ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}

      {mode === 'create' && (
        <>
          <label style={labelStyle}>Customer</label>
          <select value={form.customerId} onChange={e => setForm({ ...form, customerId: e.target.value })}
            style={inputStyle}>
            <option value="">Pick a customer…</option>
            {customers.map(c => (
              <option key={c.id} value={c.id}>
                {c.companyName || `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'Unnamed'}
              </option>
            ))}
          </select>
        </>
      )}

      <label style={labelStyle}>VIN (17 chars, optional)</label>
      <input value={form.vin}
        onChange={e => setForm({ ...form, vin: e.target.value.toUpperCase() })}
        maxLength={17}
        style={{ ...inputStyle, fontFamily: 'var(--font-mono)' as const, textTransform: 'uppercase' as const }} />

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>License plate</label>
          <input value={form.licensePlate}
            onChange={e => setForm({ ...form, licensePlate: e.target.value })}
            style={{ ...inputStyle, fontFamily: 'var(--font-mono)' as const }} />
        </div>
        <div>
          <label style={labelStyle}>State</label>
          <input value={form.licensePlateState}
            onChange={e => setForm({ ...form, licensePlateState: e.target.value.toUpperCase().slice(0, 2) })}
            maxLength={2} placeholder="AZ"
            style={inputStyle} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 2fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Year</label>
          <input type="number" min="1900" max="2200" value={form.year}
            onChange={e => setForm({ ...form, year: e.target.value })}
            style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Make</label>
          <input value={form.make} onChange={e => setForm({ ...form, make: e.target.value })}
            placeholder="Ford / Honda / etc." style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Model</label>
          <input value={form.model} onChange={e => setForm({ ...form, model: e.target.value })}
            placeholder="F-150 / Civic" style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Color</label>
          <input value={form.color} onChange={e => setForm({ ...form, color: e.target.value })}
            style={inputStyle} />
        </div>
      </div>

      <label style={labelStyle}>Current mileage (optional)</label>
      <input type="number" min="0" value={form.currentMileage}
        onChange={e => setForm({ ...form, currentMileage: e.target.value })}
        style={inputStyle} />

      <label style={labelStyle}>Notes (optional)</label>
      <textarea value={form.notes}
        onChange={e => setForm({ ...form, notes: e.target.value })}
        rows={2} placeholder="Key in dash compartment / uses synthetic oil / etc."
        style={{ ...inputStyle, fontFamily: 'var(--font-body)' as const, resize: 'vertical' as const }} />
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
const labelStyle: React.CSSProperties = { display: 'block' as const, fontSize: 12, color: 'var(--text-2)', marginBottom: 6, marginTop: 12 }
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
const errStyle: React.CSSProperties = {
  marginBottom: 12, padding: '10px 12px',
  background: 'var(--red-bg)', color: 'var(--red, #ef4444)',
  border: '1px solid var(--red-dim, #ef4444)', borderRadius: 8, fontSize: 13,
}
const emptyStyle: React.CSSProperties = {
  padding: 32, textAlign: 'center' as const,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, color: 'var(--text-2)', fontSize: 14, marginBottom: 16,
}
