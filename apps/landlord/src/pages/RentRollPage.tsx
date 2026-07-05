import { useQuery } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { apiGet } from '../lib/api'
import { ScrollText } from 'lucide-react'

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
const fmtDate = (d: any) => d ? new Date(d).toLocaleDateString() : '—'

const STATUS_COLORS: Record<string, string> = {
  active: 'badge-green', delinquent: 'badge-amber', suspended: 'badge-red'
}

// W-2 (S531): the Expected Monthly Rent KPI's click-through. One row per
// occupied unit (active + delinquent + suspended — rent-obligation
// principle: rent owed is per lease, so non-paying and evicting units stay
// on the roll). The endpoint total uses the same formula as the KPI, so the
// two always agree.
export function RentRollPage() {
  const navigate = useNavigate()
  const { data, isLoading } = useQuery<any>('rent-roll', () => apiGet('/landlords/me/rent-roll'))
  const rows: any[] = data?.rows || []
  const total: number = data?.total || 0

  const byProperty = rows.reduce((acc: Record<string, any[]>, r) => {
    (acc[r.propertyName] = acc[r.propertyName] || []).push(r)
    return acc
  }, {})

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Rent Roll</h1>
          <p className="page-subtitle">Contracted monthly rent across every occupied unit — including non-paying and evicting units, which still owe under their lease</p>
        </div>
      </div>

      <div className="kpi-grid" style={{ marginBottom: 20 }}>
        <div className="kpi-card">
          <div className="kpi-label">Expected Monthly Rent</div>
          <div className="kpi-value gold">{fmt(total)}</div>
          <div className="kpi-sub">contracted across {rows.length} occupied unit{rows.length === 1 ? '' : 's'}</div>
        </div>
      </div>

      {isLoading ? (
        <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div className="card">
          <div className="empty-state" style={{ padding: 48 }}><ScrollText size={40}/><h3>No occupied units</h3><p>Units with an active tenancy appear here with their contracted rent.</p></div>
        </div>
      ) : (
        Object.entries(byProperty).map(([propertyName, propRows]) => {
          const subtotal = (propRows as any[]).reduce((s, r) => s + Number(r.rentAmount || 0), 0)
          return (
            <div key={propertyName} style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
                <h2 style={{ fontSize: '.95rem', margin: 0 }}>{propertyName}</h2>
                <span className="mono" style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>{(propRows as any[]).length} unit{(propRows as any[]).length === 1 ? '' : 's'} · <span style={{ color: 'var(--gold)', fontWeight: 600 }}>{fmt(subtotal)}/mo</span></span>
              </div>
              <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
                <table className="data-table" style={{ minWidth: 720 }}>
                  <thead><tr><th>Unit</th><th>Tenant</th><th>Lease Start</th><th>Lease End</th><th>Status</th><th style={{ textAlign: 'right' }}>Monthly Rent</th></tr></thead>
                  <tbody>
                    {(propRows as any[]).map((r) => (
                      <tr key={r.unitId} style={{ cursor: 'pointer' }} onClick={() => navigate(`/units?search=${encodeURIComponent(r.unitNumber)}`)}>
                        <td className="mono" style={{ fontWeight: 600 }}>{r.unitNumber}</td>
                        <td>
                          {r.tenantFirst ? `${r.tenantFirst} ${r.tenantLast}` : <span style={{ color: 'var(--text-3)' }}>—</span>}
                          {Number(r.tenantCount) > 1 && <span style={{ color: 'var(--text-3)', fontSize: '.72rem' }}> +{Number(r.tenantCount) - 1}</span>}
                        </td>
                        <td style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>{fmtDate(r.startDate)}</td>
                        <td style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>{r.leaseId ? (r.endDate ? fmtDate(r.endDate) : 'Month-to-month') : '—'}</td>
                        <td><span className={`badge ${STATUS_COLORS[r.status] || 'badge-muted'}`}>{r.status}</span></td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(r.rentAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}
