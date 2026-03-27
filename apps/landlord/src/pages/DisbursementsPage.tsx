import { useState } from 'react'
import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
import { formatCurrency } from '@gam/shared'
import { ArrowDownToLine, X, CheckCircle, Clock, Shield } from 'lucide-react'

export function DisbursementsPage() {
  const { data: disbs = [], isLoading } = useQuery<any[]>('disbursements', () => apiGet('/disbursements'))
  const [selected, setSelected] = useState<any | null>(null)

  const totalSettled = (disbs as any[]).filter((d: any) => d.status === 'settled').reduce((sum: number, d: any) => sum + Number(d.amount), 0)
  const totalPending = (disbs as any[]).filter((d: any) => d.status === 'pending').reduce((sum: number, d: any) => sum + Number(d.amount), 0)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Disbursements</h1>
          <p className="page-subtitle">On-Time Pay - rent initiated on or before the 1st business day of each month</p>
        </div>
      </div>

      <div className="alert alert-gold" style={{ marginBottom: 24 }}>
        <ArrowDownToLine size={16} />
        <span><strong>On-Time Pay SLA:</strong> Rent is initiated to your account on or before the 1st business day of each month regardless of when your tenants pay.</span>
      </div>

      <div className="kpi-grid" style={{ marginBottom: 24 }}>
        <div className="kpi-card">
          <div className="kpi-label">Total Disbursed</div>
          <div className="kpi-value green">{formatCurrency(totalSettled)}</div>
          <div className="kpi-sub">{(disbs as any[]).filter((d: any) => d.status === 'settled').length} settled payments</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Pending</div>
          <div className="kpi-value amber">{formatCurrency(totalPending)}</div>
          <div className="kpi-sub">{(disbs as any[]).filter((d: any) => d.status === 'pending').length} pending</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Reserve Funded</div>
          <div className="kpi-value gold">{(disbs as any[]).filter((d: any) => d.from_reserve).length}</div>
          <div className="kpi-sub">disbursements fronted by reserve</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading...</div>
        ) : (
          <>
            <table className="data-table">
              <thead><tr>
                <th>Target Date</th><th>Amount</th><th>Units</th><th>Status</th><th>Funded From</th><th>Settled</th>
              </tr></thead>
              <tbody>
                {(disbs as any[]).length ? (disbs as any[]).map((d: any) => (
                  <tr key={d.id} onClick={() => setSelected(d)} style={{ cursor: 'pointer' }}>
                    <td className="mono">{new Date(d.target_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                    <td className="mono" style={{ color: 'var(--green)', fontWeight: 700 }}>{formatCurrency(d.amount)}</td>
                    <td className="mono">{d.unit_count}</td>
                    <td>
                      <span className={'badge ' + (d.status === 'settled' ? 'badge-green' : d.status === 'pending' ? 'badge-amber' : 'badge-red')}>
                        {d.status === 'settled' ? 'Settled' : d.status === 'pending' ? 'Pending' : d.status}
                      </span>
                    </td>
                    <td>
                      {d.from_reserve
                        ? <span className="badge badge-gold"><Shield size={10} /> Reserve</span>
                        : <span className="badge badge-muted">Collected</span>}
                    </td>
                    <td className="mono" style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>
                      {d.settled_at ? new Date(d.settled_at).toLocaleDateString() : '-'}
                    </td>
                  </tr>
                )) : (
                  <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 40 }}>
                    No disbursements yet. First disbursement initiates on the last business day of this month.
                  </td></tr>
                )}
              </tbody>
            </table>
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-0)', fontSize: '.75rem', color: 'var(--text-3)' }}>
              Click any row for full disbursement detail
            </div>
          </>
        )}
      </div>

      {selected && (
        <div className="modal-overlay" onClick={() => setSelected(null)}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div className="modal-title" style={{ marginBottom: 0 }}>Disbursement Detail</div>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelected(null)} style={{ padding: 6 }}><X size={15} /></button>
            </div>
            <div style={{ background: 'var(--bg-3)', borderRadius: 10, padding: 16, marginBottom: 16, textAlign: 'center' }}>
              <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.06em' }}>Amount Disbursed</div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', fontWeight: 800, color: 'var(--green)' }}>{formatCurrency(selected.amount)}</div>
              <div style={{ fontSize: '.8rem', color: 'var(--text-3)', marginTop: 4 }}>
                {new Date(selected.target_date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </div>
            </div>
            <div className="data-row"><span className="data-key">Status</span>
              <span className={'badge ' + (selected.status === 'settled' ? 'badge-green' : 'badge-amber')}>{selected.status}</span>
            </div>
            <div className="data-row"><span className="data-key">Units covered</span><span className="data-val mono">{selected.unit_count}</span></div>
            <div className="data-row"><span className="data-key">Funded from</span>
              <span className={'badge ' + (selected.from_reserve ? 'badge-gold' : 'badge-muted')}>
                {selected.from_reserve ? 'Operational Reserve' : 'Collected Rent'}
              </span>
            </div>
            {selected.from_reserve && (
              <div className="data-row"><span className="data-key">Reserve amount</span><span className="data-val mono" style={{ color: 'var(--gold)' }}>{formatCurrency(selected.reserve_amount)}</span></div>
            )}
            <div className="data-row"><span className="data-key">Initiated</span><span className="data-val mono" style={{ fontSize: '.8rem' }}>{selected.initiated_at ? new Date(selected.initiated_at).toLocaleString() : '-'}</span></div>
            <div className="data-row"><span className="data-key">Settled</span><span className="data-val mono" style={{ fontSize: '.8rem' }}>{selected.settled_at ? new Date(selected.settled_at).toLocaleString() : 'Pending'}</span></div>
            {selected.from_reserve && (
              <div className="alert alert-gold" style={{ marginTop: 16 }}>
                <Shield size={14} />
                <div style={{ fontSize: '.78rem' }}>This disbursement was fronted by the operational reserve before tenant ACH settled.</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
