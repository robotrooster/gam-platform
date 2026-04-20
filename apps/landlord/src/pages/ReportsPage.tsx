import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

export function ReportsPage() {
  const { data: report, isLoading } = useQuery<any>('reports', () => apiGet('/reports/summary'))

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Reports</h1><p className="page-subtitle">Financial and occupancy summaries</p></div>
      </div>
      {isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
        <div style={{display:'grid',gap:16}}>
          <div className="kpi-grid" style={{gridTemplateColumns:'repeat(3, 1fr)'}}>
            <div className="kpi-card"><div className="kpi-label">Total Collected MTD</div><div className="kpi-value green">{fmt(report?.collectedMtd)}</div></div>
            <div className="kpi-card"><div className="kpi-label">Outstanding Balance</div><div className="kpi-value" style={{color:'var(--amber)'}}>{fmt(report?.outstanding)}</div></div>
            <div className="kpi-card"><div className="kpi-label">Occupancy Rate</div><div className="kpi-value">{report?.occupancyRate != null ? `${report.occupancyRate}%` : '—'}</div></div>
          </div>
          <div className="card">
            <div className="card-header"><span className="card-title">Monthly Breakdown</span></div>
            <div style={{padding:'16px 0'}}>
              <table className="data-table">
                <thead><tr><th>Month</th><th>Collected</th><th>Disbursed</th><th>Fees</th><th>Net</th></tr></thead>
                <tbody>
                  {report?.monthly?.length ? report.monthly.map((m: any) => (
                    <tr key={m.month}>
                      <td className="mono">{m.month}</td>
                      <td className="mono" style={{color:'var(--green)'}}>{fmt(m.collected)}</td>
                      <td className="mono">{fmt(m.disbursed)}</td>
                      <td className="mono" style={{color:'var(--text-3)'}}>{fmt(m.fees)}</td>
                      <td className="mono" style={{color:'var(--text-0)',fontWeight:600}}>{fmt(m.net)}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={5} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No report data yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
