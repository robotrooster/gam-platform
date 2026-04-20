import { AddUnitModal } from './AddUnitModal'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useNavigate, Link } from 'react-router-dom'
import { apiGet, apiPatch } from '../lib/api'
import { Plus, Search, AlertTriangle, Shield, DoorOpen } from 'lucide-react'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

const STATUS_COLORS: Record<string, string> = {
  active: 'badge-green', direct_pay: 'badge-blue',
  vacant: 'badge-muted', delinquent: 'badge-amber', suspended: 'badge-red'
}

export function UnitsPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [showAddUnit, setShowAddUnit] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const { data: units = [], isLoading } = useQuery<any[]>('units', () => apiGet('/units'))

  const setStatusMut = useMutation(
    ({ id, status }: { id: string; status: string }) => apiPatch(`/units/${id}/status`, { status }),
    { onSuccess: () => qc.invalidateQueries('units') }
  )

  const filtered = units.filter((u: any) => {
    const matchSearch = search === '' ||
      u.unitNumber.toLowerCase().includes(search.toLowerCase()) ||
      u.propertyName?.toLowerCase().includes(search.toLowerCase()) ||
      `${u.tenantFirst} ${u.tenantLast}`.toLowerCase().includes(search.toLowerCase())
    const matchFilter = filter === 'all' || u.status === filter
    return matchSearch && matchFilter
  })

  const evictionUnits = units.filter((u: any) => u.paymentBlock)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Units</h1>
          <p className="page-subtitle" style={{ display:"flex", alignItems:"center", gap:6 }}>{units.length} total units · <Link to="/properties" style={{ fontSize:'.72rem', color:'var(--gold)', fontWeight:600 }}>+ Add Units Here</Link> · {units.filter((u: any) => u.status === 'active').length} active</p>
        </div>
      </div>

      {evictionUnits.length > 0 && (
        <div className="alert alert-danger">
          <AlertTriangle size={16} />
          <div><strong>{evictionUnits.length} unit(s) in Eviction Mode.</strong> All tenant ACH hard-blocked. Warning: in many jurisdictions, accepting rent while pursuing eviction may waive your right to proceed. Check your local laws before accepting any payment.</div>
        </div>
      )}

      <div className="filter-bar">
        <div className="search-wrap">
          <Search className="search-icon" />
          <input className="search-input" placeholder="Search units, properties, tenants..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {['all', 'active', 'direct_pay', 'vacant', 'delinquent', 'suspended'].map(s => (
          <button key={s} className={`btn btn-sm ${filter === s ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter(s)}>
            {s === 'all' ? 'All' : s.replace('_', ' ')}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="card"><div style={{ color: 'var(--text-3)', textAlign: 'center', padding: 32 }}>Loading units...</div></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state"><DoorOpen size={48} /><h3>No units found</h3><p>Add your first unit to get started.</p></div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr>
                <th>Unit</th><th>Property</th><th>Tenant</th><th>Rent</th><th>Status</th><th>On-Time Pay</th><th>Eviction</th>
              </tr></thead>
              <tbody>
                {filtered.map((u: any) => (
                  <tr key={u.id} onClick={() => navigate('/units/' + u.id)} style={{ cursor: 'pointer' }}>
                    <td><span className="mono" style={{ color: 'var(--text-0)', fontWeight: 600 }}>{u.unitNumber}</span></td>
                    <td style={{ fontSize: '.82rem' }}>{u.propertyName}<br /><span style={{ color: 'var(--text-3)', fontSize: '.72rem' }}>{u.city}, {u.state}</span></td>
                    <td style={{ fontSize: '.82rem' }}>
                      {u.tenantFirst
                        ? <><span style={{ color: 'var(--text-0)' }}>{u.tenantFirst} {u.tenantLast}</span><br /><span style={{ color: 'var(--text-3)', fontSize: '.72rem' }}>{u.tenantEmail}</span></>
                        : <span style={{ color: 'var(--text-3)' }}>Vacant</span>}
                    </td>
                    <td className="mono">{fmt(u.rentAmount)}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <select value={u.status} onChange={e => setStatusMut.mutate({ id: u.id, status: e.target.value })}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.75rem', color: 'inherit', padding: 0 }}>
                        {['occupied','vacant','maintenance','eviction'].map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                      </select>
                      <span className={'badge ' + (STATUS_COLORS[u.status] || 'badge-muted')} style={{ marginLeft: 4 }}>{u.status.replace('_', ' ')}</span>
                    </td>
                    <td>
                      {u.onTimePayActive
                        ? <span style={{ color: 'var(--green)', fontSize: '.75rem' }}>Active</span>
                        : <span style={{ color: 'var(--text-3)', fontSize: '.75rem' }}>-</span>}
                    </td>
                    <td>
                      {u.paymentBlock
                        ? <span className="badge badge-red"><Shield size={10} /> BLOCKED</span>
                        : <span style={{ color: 'var(--text-3)', fontSize: '.75rem' }}>-</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-0)', fontSize: '.75rem', color: 'var(--text-3)' }}>
            Click any row to open unit details and manage eviction mode
          </div>
        </div>
      )}
      {showAddUnit && <AddUnitModal onClose={() => setShowAddUnit(false)} />}
    </div>
  )
}
