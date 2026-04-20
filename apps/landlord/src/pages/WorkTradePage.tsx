import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

const STATUS_MAP: Record<string,string> = { active:'badge-green', completed:'badge-muted', suspended:'badge-red', pending:'badge-amber' }

export function WorkTradePage() {
  const { data: agreements = [], isLoading } = useQuery<any[]>('work-trade', () => apiGet('/work-trade'))

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Work Trade</h1><p className="page-subtitle">Rent-for-labor agreements</p></div>
      </div>
      <div className="card" style={{padding:0}}>
        {isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
          <table className="data-table">
            <thead><tr><th>Tenant</th><th>Unit</th><th>Role</th><th>Hours / Mo</th><th>Credit / Mo</th><th>Start</th><th>Status</th></tr></thead>
            <tbody>
              {agreements.length ? agreements.map((a: any) => (
                <tr key={a.id}>
                  <td style={{fontWeight:500}}>{a.tenantName || '—'}</td>
                  <td className="mono">{a.unitNumber || '—'}</td>
                  <td style={{fontSize:'.88rem'}}>{a.roleDescription || '—'}</td>
                  <td className="mono">{a.hoursPerMonth ?? '—'}</td>
                  <td className="mono" style={{color:'var(--green)'}}>{fmt(a.monthlyCredit)}</td>
                  <td className="mono">{a.startDate ? new Date(a.startDate).toLocaleDateString() : '—'}</td>
                  <td><span className={`badge ${STATUS_MAP[a.status]||'badge-muted'}`}>{a.status || '—'}</span></td>
                </tr>
              )) : (
                <tr><td colSpan={7} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No work trade agreements yet.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
