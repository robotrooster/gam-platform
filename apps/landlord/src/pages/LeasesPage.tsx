import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useForm } from 'react-hook-form'
import { apiGet, apiPost } from '../lib/api'
import { formatCurrency } from '@gam/shared'
import { Plus, FileText } from 'lucide-react'

export function LeasesPage() {
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const { data: leases = [], isLoading } = useQuery<any[]>('leases', () => apiGet('/leases'))
  const { data: units = [] } = useQuery<any[]>('units', () => apiGet('/units'))
  const { register, handleSubmit, reset } = useForm<any>()

  const addMut = useMutation(
    (d: any) => apiPost('/leases', d),
    { onSuccess: () => { qc.invalidateQueries('leases'); setShowAdd(false); reset() } }
  )

  const STATUS_COLORS: Record<string, string> = {
    active: 'badge-green', expired: 'badge-red',
    pending: 'badge-amber', terminated: 'badge-muted',
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Leases</h1>
          <p className="page-subtitle">{leases.filter((l: any) => l.status === 'active').length} active leases</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
          <Plus size={15} /> New lease
        </button>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
        ) : (
          <table className="data-table">
            <thead><tr>
              <th>Tenant</th><th>Unit</th><th>Property</th>
              <th>Start</th><th>End</th><th>Rent</th><th>Deposit</th><th>Status</th><th>Signed</th>
            </tr></thead>
            <tbody>
              {leases.length ? leases.map((l: any) => (
                <tr key={l.id}>
                  <td style={{ fontWeight: 600, color: 'var(--text-0)' }}>
                    {l.tenant_first} {l.tenant_last}
                  </td>
                  <td className="mono">{l.unit_number}</td>
                  <td style={{ fontSize: '.82rem' }}>{l.property_name}</td>
                  <td className="mono" style={{ fontSize: '.78rem' }}>
                    {new Date(l.start_date).toLocaleDateString()}
                  </td>
                  <td className="mono" style={{ fontSize: '.78rem' }}>
                    {new Date(l.end_date).toLocaleDateString()}
                  </td>
                  <td className="mono">{formatCurrency(l.rent_amount)}/mo</td>
                  <td className="mono">{formatCurrency(l.security_deposit)}</td>
                  <td>
                    <span className={`badge ${STATUS_COLORS[l.status] || 'badge-muted'}`}>
                      {l.status}
                    </span>
                  </td>
                  <td>
                    {l.signed_at ? (
                      <span className="badge badge-green">
                        <FileText size={10} /> Signed
                      </span>
                    ) : (
                      <span className="badge badge-amber">Pending</span>
                    )}
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 40 }}>
                    No leases yet. Create a lease to activate rent collection for a unit.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {showAdd && (
        <div className="modal-overlay" onClick={() => setShowAdd(false)}>
          <div className="modal" style={{ maxWidth: 580 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">Create Lease</div>
            <form onSubmit={handleSubmit(d => addMut.mutate(d))}>
              <div className="form-group">
                <label className="form-label">Unit</label>
                <select className="form-select" {...register('unitId', { required: true })}>
                  <option value="">Select unit…</option>
                  {units.filter((u: any) => u.status === 'vacant' || u.status === 'active').map((u: any) => (
                    <option key={u.id} value={u.id}>
                      {u.unit_number} — {u.property_name} (${u.rent_amount}/mo)
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Tenant ID</label>
                <input className="form-input" {...register('tenantId', { required: true })}
                  placeholder="Tenant UUID (from tenant management)" />
                <p className="form-hint">Copy from Tenants page → tenant detail</p>
              </div>
              <div className="form-grid-2">
                <div className="form-group">
                  <label className="form-label">Lease start</label>
                  <input className="form-input" type="date" {...register('startDate', { required: true })} />
                </div>
                <div className="form-group">
                  <label className="form-label">Lease end</label>
                  <input className="form-input" type="date" {...register('endDate', { required: true })} />
                </div>
              </div>
              <div className="form-grid-2">
                <div className="form-group">
                  <label className="form-label">Monthly rent ($)</label>
                  <input className="form-input" type="number" step="0.01"
                    {...register('rentAmount', { required: true, valueAsNumber: true })} />
                </div>
                <div className="form-group">
                  <label className="form-label">Security deposit ($)</label>
                  <input className="form-input" type="number" step="0.01"
                    {...register('securityDeposit', { required: true, valueAsNumber: true })} />
                </div>
              </div>
              {addMut.isError && (
                <div className="alert alert-danger">
                  {(addMut.error as any)?.response?.data?.error || 'Failed to create lease'}
                </div>
              )}
              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={addMut.isLoading}>
                  {addMut.isLoading ? <span className="spinner" /> : 'Create lease'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
