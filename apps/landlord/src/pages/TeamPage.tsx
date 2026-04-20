import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

const ROLE_MAP: Record<string,string> = { owner:'badge-green', manager:'badge-blue', maintenance:'badge-amber', staff:'badge-muted' }

export function TeamPage() {
  const { data: members = [], isLoading } = useQuery<any[]>('team', () => apiGet('/team'))

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Team</h1><p className="page-subtitle">Staff and access management</p></div>
      </div>
      <div className="card" style={{padding:0}}>
        {isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
          <table className="data-table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Properties</th><th>Last Active</th><th>Status</th></tr></thead>
            <tbody>
              {members.length ? members.map((m: any) => (
                <tr key={m.id}>
                  <td style={{fontWeight:500}}>{m.firstName} {m.lastName}</td>
                  <td style={{fontSize:'.82rem',color:'var(--text-3)'}}>{m.email || '—'}</td>
                  <td><span className={`badge ${ROLE_MAP[m.role]||'badge-muted'}`}>{m.role || '—'}</span></td>
                  <td style={{fontSize:'.82rem'}}>{m.propertyCount ?? '—'}</td>
                  <td className="mono" style={{fontSize:'.82rem',color:'var(--text-3)'}}>{m.lastActive ? new Date(m.lastActive).toLocaleDateString() : '—'}</td>
                  <td><span className={`badge ${m.active ? 'badge-green' : 'badge-red'}`}>{m.active ? 'active' : 'inactive'}</span></td>
                </tr>
              )) : (
                <tr><td colSpan={6} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No team members yet.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
