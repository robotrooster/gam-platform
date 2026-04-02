import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

const STATUS_MAP: Record<string,string> = { new:'badge-blue', reviewing:'badge-amber', approved:'badge-green', denied:'badge-red', withdrawn:'badge-muted' }

export function ApplicantPoolPage() {
  const { data: applicants = [], isLoading } = useQuery<any[]>('applicants', () => apiGet('/applicants'))

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Applicant Pool</h1><p className="page-subtitle">Prospective tenants awaiting placement</p></div>
      </div>
      <div className="card" style={{padding:0}}>
        {isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
          <table className="data-table">
            <thead><tr><th>Name</th><th>Applied</th><th>Desired Unit</th><th>Income</th><th>Risk Score</th><th>BG Check</th><th>Status</th></tr></thead>
            <tbody>
              {applicants.length ? applicants.map((a: any) => (
                <tr key={a.id}>
                  <td style={{fontWeight:500}}>{a.first_name} {a.last_name}</td>
                  <td className="mono">{a.applied_at ? new Date(a.applied_at).toLocaleDateString() : '—'}</td>
                  <td className="mono">{a.desired_unit || <span style={{color:'var(--text-3)'}}>any</span>}</td>
                  <td className="mono">{fmt(a.monthly_income)}/mo</td>
                  <td><span className={`badge ${a.risk_score >= 70 ? 'badge-red' : a.risk_score >= 40 ? 'badge-amber' : 'badge-green'}`}>{a.risk_score ?? '—'}</span></td>
                  <td><span className={`badge ${a.bg_check_status === 'approved' ? 'badge-green' : a.bg_check_status === 'pending' ? 'badge-amber' : 'badge-muted'}`}>{a.bg_check_status || 'not started'}</span></td>
                  <td><span className={`badge ${STATUS_MAP[a.status]||'badge-muted'}`}>{a.status || '—'}</span></td>
                </tr>
              )) : (
                <tr><td colSpan={7} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No applicants in pool.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
