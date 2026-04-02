import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

const STATUS_MAP: Record<string,string> = { active:'badge-green', expired:'badge-red', pending:'badge-amber', month_to_month:'badge-blue' }

export function LeasesPage() {
  const { data: leases = [], isLoading } = useQuery<any[]>('leases', () => apiGet('/leases'))

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Leases</h1><p className="page-subtitle">Active and historical lease agreements</p></div>
      </div>
      <div className="card" style={{padding:0}}>
        {isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
          <table className="data-table">
            <thead><tr><th>Unit</th><th>Tenant</th><th>Start</th><th>End</th><th>Rent</th><th>Status</th></tr></thead>
            <tbody>
              {leases.length ? leases.map((l: any) => (
                <tr key={l.id}>
                  <td className="mono">{l.unit_number || '—'}</td>
                  <td>{l.tenant_name || '—'}</td>
                  <td className="mono">{l.start_date ? new Date(l.start_date).toLocaleDateString() : '—'}</td>
                  <td className="mono">{l.end_date ? new Date(l.end_date).toLocaleDateString() : <span style={{color:'var(--text-3)'}}>MTM</span>}</td>
                  <td className="mono" style={{color:'var(--text-0)'}}>{fmt(l.monthly_rent)}</td>
                  <td><span className={`badge ${STATUS_MAP[l.status]||'badge-muted'}`}>{l.status?.replace('_',' ') || '—'}</span></td>
                </tr>
              )) : (
                <tr><td colSpan={6} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No leases found.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
