import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPatch } from '../lib/api'

const STATUS_MAP: Record<string, string> = { active: 'badge-green', paused: 'badge-amber', ended: 'badge-muted' }

// One editable monthly hours target per property (the credit denominator:
// each approved hour = 1/target of that month's invoice).
function PropertyTargetRow({ propertyId, name, target }: { propertyId: string; name: string; target: number }) {
  const qc = useQueryClient()
  const [value, setValue] = useState(String(target))
  const save = useMutation(
    (t: number) => apiPatch(`/work-trade/property/${propertyId}/target`, { target: t }),
    { onSuccess: () => qc.invalidateQueries('work-trade') }
  )
  const dirty = Number(value) !== target && Number(value) > 0
  return (
    <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0' }}>
      <div><b>{name}</b></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="number" min={1} value={value} onChange={e => setValue(e.target.value)}
          style={{ width: 80, padding: '5px 8px', textAlign: 'right' }} className="input" />
        <span style={{ color: 'var(--text-3)', fontSize: '.8rem' }}>hrs / mo</span>
        <button className="btn btn-sm" disabled={!dirty || save.isLoading}
          onClick={() => save.mutate(Number(value))}>
          {save.isLoading ? '…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

export function WorkTradePage() {
  const { data: agreements = [], isLoading } = useQuery<any[]>('work-trade', () => apiGet('/work-trade'))

  // Distinct properties (with their current target) drawn from the agreements.
  const properties = Array.from(
    new Map(agreements.map((a: any) => [a.propertyId, { id: a.propertyId, name: a.propertyName, target: Number(a.target) }])).values()
  )

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Work Trade</h1><p className="page-subtitle">Rent-for-labor — hours buy a percent of the monthly bill</p></div>
      </div>

      {properties.length > 0 && (
        <div className="card" style={{ marginBottom: 16, padding: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Monthly hours target</div>
          <div style={{ color: 'var(--text-3)', fontSize: '.82rem', marginBottom: 8 }}>
            A full target month of approved hours covers 100% of that month's invoice (rent + utilities + fees).
          </div>
          {properties.map((p: any) => (
            <PropertyTargetRow key={p.id} propertyId={p.id} name={p.name} target={p.target} />
          ))}
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        {isLoading ? <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div> : (
          <table className="data-table">
            <thead><tr><th>Tenant</th><th>Unit</th><th>Property</th><th>This month</th><th>Pending</th><th>Start</th><th>Status</th></tr></thead>
            <tbody>
              {agreements.length ? agreements.map((a: any) => (
                <tr key={a.id}>
                  <td style={{ fontWeight: 500 }}>{[a.tenantFirst, a.tenantLast].filter(Boolean).join(' ') || '—'}</td>
                  <td className="mono">{a.unitNumber || '—'}</td>
                  <td>{a.propertyName || '—'}</td>
                  <td className="mono">{Number(a.hoursThisMonth || 0).toFixed(1)} / {a.target} hrs</td>
                  <td className="mono">{Number(a.pendingCount) > 0
                    ? <span className="badge badge-amber">{a.pendingCount}</span>
                    : <span style={{ color: 'var(--text-3)' }}>0</span>}</td>
                  <td className="mono">{a.startDate ? new Date(a.startDate).toLocaleDateString() : '—'}</td>
                  <td><span className={`badge ${STATUS_MAP[a.status] || 'badge-muted'}`}>{a.status || '—'}</span></td>
                </tr>
              )) : (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>No work trade agreements yet.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
