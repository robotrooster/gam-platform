import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

export function DocumentsPage() {
  const { data: docs = [], isLoading } = useQuery<any[]>('documents', () => apiGet('/documents'))

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Documents</h1><p className="page-subtitle">Leases, addenda, and uploaded files</p></div>
      </div>
      <div className="card" style={{padding:0}}>
        {isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
          <table className="data-table">
            <thead><tr><th>Name</th><th>Type</th><th>Unit</th><th>Tenant</th><th>Uploaded</th><th>Action</th></tr></thead>
            <tbody>
              {docs.length ? docs.map((d: any) => (
                <tr key={d.id}>
                  <td>{d.name || '—'}</td>
                  <td><span className="badge badge-muted">{d.doc_type || 'file'}</span></td>
                  <td className="mono">{d.unit_number || '—'}</td>
                  <td>{d.tenant_name || '—'}</td>
                  <td className="mono">{d.created_at ? new Date(d.created_at).toLocaleDateString() : '—'}</td>
                  <td>{d.url ? <a href={d.url} target="_blank" rel="noreferrer" style={{color:'var(--gold)',fontSize:'.82rem'}}>View</a> : <span style={{color:'var(--text-3)'}}>—</span>}</td>
                </tr>
              )) : (
                <tr><td colSpan={6} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No documents yet.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
