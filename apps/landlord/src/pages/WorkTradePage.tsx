import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPatch } from '../lib/api'

const STATUS_MAP: Record<string, string> = { active: 'badge-green', paused: 'badge-amber', ended: 'badge-muted' }

// W-56 (Nic): targets are PER PERSON (edited inline on each agreement row
// below) — different rents and different work don't translate equally.
// This property value is only the DEFAULT applied to NEW agreements.
// One editable default per property:
function PropertyTargetRow({ propertyId, name }: { propertyId: string; name: string }) {
  const qc = useQueryClient()
  const { data } = useQuery<any>(['wt-prop-target', propertyId], () => apiGet(`/work-trade/property/${propertyId}/target`))
  const target = Number(data?.target ?? 80)
  const [value, setValue] = useState<string | null>(null)
  const shown = value ?? String(target)
  const save = useMutation(
    (t: number) => apiPatch(`/work-trade/property/${propertyId}/target`, { target: t }),
    { onSuccess: () => { qc.invalidateQueries(['wt-prop-target', propertyId]); setValue(null) } }
  )
  const dirty = value != null && Number(value) !== target && Number(value) > 0
  return (
    <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0' }}>
      <div><b>{name}</b></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="number" min={1} value={shown} onChange={e => setValue(e.target.value)}
          style={{ width: 80, padding: '5px 8px', textAlign: 'right' }} className="input" />
        <span style={{ color: 'var(--text-3)', fontSize: '.8rem' }}>hrs / mo</span>
        <button className="btn btn-sm" disabled={!dirty || save.isLoading}
          onClick={() => save.mutate(Number(shown))}>
          {save.isLoading ? '…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

export function WorkTradePage() {
  const { data: agreements = [], isLoading } = useQuery<any[]>('work-trade', () => apiGet('/work-trade'))

  const navigate = useNavigate()
  // Distinct properties for the new-agreement DEFAULT editor. a.target is
  // now the per-agreement value, so fetch nothing extra — the default
  // editor reads its own value lazily per property row.
  const properties = Array.from(
    new Map(agreements.map((a: any) => [a.propertyId, { id: a.propertyId, name: a.propertyName }])).values()
  )

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Work Trade</h1><p className="page-subtitle">Rent-for-labor — hours buy a percent of the monthly bill</p></div>
      </div>

      {properties.length > 0 && (
        <div className="card" style={{ marginBottom: 16, padding: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Default hours target for new agreements</div>
          <div style={{ color: 'var(--text-3)', fontSize: '.82rem', marginBottom: 8 }}>
            Each person's target is set on their row below — a full target month of approved hours covers 100% of THEIR invoice (rent + utilities + fees). This is just the starting value for new agreements.
          </div>
          {properties.map((p: any) => (
            <PropertyTargetRow key={p.id} propertyId={p.id} name={p.name} />
          ))}
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        {isLoading ? <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div> : (
          <table className="data-table">
            <thead><tr><th>Tenant</th><th>Unit</th><th>Property</th><th>This Month</th><th>Target</th><th>Pending</th><th>Start</th><th>Status</th></tr></thead>
            <tbody>
              {agreements.length ? agreements.map((a: any) => (
                // W-56: the row pulls up the tenant's LEASE; the target cell
                // edits inline without triggering the row click.
                <tr key={a.id} style={{ cursor: a.leaseId ? 'pointer' : undefined }}
                  onClick={() => a.leaseId && navigate(`/leases?open=${a.leaseId}`)}
                  title={a.leaseId ? 'Open lease' : undefined}>
                  <td style={{ fontWeight: 500, color: a.leaseId ? 'var(--gold)' : undefined }}>{[a.tenantFirst, a.tenantLast].filter(Boolean).join(' ') || '—'}</td>
                  <td className="mono">{a.unitNumber || '—'}</td>
                  <td>{a.propertyName || '—'}</td>
                  <td className="mono">{Number(a.hoursThisMonth || 0).toFixed(1)} / {a.target} hrs</td>
                  <td onClick={e => e.stopPropagation()}><AgreementTargetCell agreementId={a.id} target={Number(a.target)} /></td>
                  <td className="mono">{Number(a.pendingCount) > 0
                    ? <span className="badge badge-amber">{a.pendingCount}</span>
                    : <span style={{ color: 'var(--text-3)' }}>0</span>}</td>
                  <td className="mono">{a.startDate ? new Date(a.startDate).toLocaleDateString() : '—'}</td>
                  <td><span className={`badge ${STATUS_MAP[a.status] || 'badge-muted'}`}>{a.status || '—'}</span></td>
                </tr>
              )) : (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>No work trade agreements yet.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// W-56: per-person monthly hours target, edited inline on the roster row.
function AgreementTargetCell({ agreementId, target }: { agreementId: string; target: number }) {
  const qc = useQueryClient()
  const [value, setValue] = useState<string | null>(null)
  const shown = value ?? String(target)
  const save = useMutation(
    (t: number) => apiPatch(`/work-trade/${agreementId}`, { monthlyHoursTarget: t }),
    { onSuccess: () => { qc.invalidateQueries('work-trade'); setValue(null) } }
  )
  const dirty = value != null && Number(value) !== target && Number(value) > 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input type="number" min={1} value={shown} onChange={e => setValue(e.target.value)}
        style={{ width: 64, padding: '4px 6px', textAlign: 'right' }} className="input" />
      <span style={{ color: 'var(--text-3)', fontSize: '.72rem' }}>hrs</span>
      {dirty && (
        <button className="btn btn-primary btn-sm" disabled={save.isLoading}
          onClick={() => save.mutate(Number(shown))}>
          {save.isLoading ? '…' : 'Save'}
        </button>
      )}
    </div>
  )
}
