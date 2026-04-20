import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

const STATUS_MAP: Record<string,string> = { approved:'badge-green', denied:'badge-red', pending:'badge-amber', reviewing:'badge-blue', expired:'badge-muted' }

export function BackgroundChecksPage() {
  const { data: checks = [], isLoading } = useQuery<any[]>('background-checks', () => apiGet('/background-checks'))

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Background Checks</h1><p className="page-subtitle">Applicant screening results</p></div>
      </div>
      <div className="card" style={{padding:0}}>
        {isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
          <table className="data-table">
            <thead><tr><th>Applicant</th><th>Unit</th><th>Submitted</th><th>Risk Score</th><th>Status</th><th>Decision</th></tr></thead>
            <tbody>
              {checks.length ? checks.map((c: any) => (
                <tr key={c.id}>
                  <td>{c.applicantName || '—'}</td>
                  <td className="mono">{c.unitNumber || '—'}</td>
                  <td className="mono">{c.submittedAt ? new Date(c.submittedAt).toLocaleDateString() : '—'}</td>
                  <td><span className={`badge ${c.riskScore >= 70 ? 'badge-red' : c.riskScore >= 40 ? 'badge-amber' : 'badge-green'}`}>{c.riskScore ?? '—'}</span></td>
                  <td><span className={`badge ${STATUS_MAP[c.status]||'badge-muted'}`}>{c.status || '—'}</span></td>
                  <td style={{fontSize:'.82rem',color:'var(--text-3)'}}>{c.decisionNote || '—'}</td>
                </tr>
              )) : (
                <tr><td colSpan={6} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No background checks yet.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
