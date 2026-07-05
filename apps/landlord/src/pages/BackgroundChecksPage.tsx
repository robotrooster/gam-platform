import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'

// S527 W-6: this page queried GET /background-checks — a route that never
// existed — so the Applications KPI landed on a permanently blank page. The
// real list is GET /background. Columns map to fields the API actually
// returns (applicant name from the check's identity fields, risk score/level,
// created date, status). Checkr wiring (W-49/W-50) will extend this page.
const STATUS_MAP: Record<string, string> = {
  approved: 'badge-green', denied: 'badge-red', pending: 'badge-amber',
  awaiting_applicant: 'badge-amber', submitted: 'badge-blue',
  processing: 'badge-blue', complete: 'badge-green',
  failed: 'badge-red', cancelled: 'badge-muted', expired: 'badge-muted',
}

export function BackgroundChecksPage() {
  const { data: checks = [], isLoading } = useQuery<any[]>('background-checks', () => apiGet('/background'))

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Background Checks</h1><p className="page-subtitle">Applicant screening results</p></div>
      </div>
      <div className="card" style={{padding:0,overflowX:'auto'}}>
        {isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
          <table className="data-table" style={{minWidth:780}}>
            <thead><tr><th>Applicant</th><th>Started</th><th>Risk</th><th>Status</th></tr></thead>
            <tbody>
              {checks.length ? checks.map((c: any) => (
                <tr key={c.id}>
                  <td style={{fontWeight:500}}>{[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}</td>
                  <td className="mono">{c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '—'}</td>
                  <td>
                    {c.riskLevel
                      ? <span className={`badge ${c.riskLevel === 'low' ? 'badge-green' : c.riskLevel === 'medium' ? 'badge-amber' : 'badge-red'}`}>{c.riskLevel}{c.riskScore != null ? ` · ${c.riskScore}` : ''}</span>
                      : <span style={{color:'var(--text-3)'}}>—</span>}
                  </td>
                  <td><span className={`badge ${STATUS_MAP[c.status] || 'badge-muted'}`}>{(c.status || '—').replace('_', ' ')}</span></td>
                </tr>
              )) : (
                <tr><td colSpan={4} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No background checks yet.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
