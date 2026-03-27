import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
import { FileText, Download } from 'lucide-react'

const TYPE_MAP: Record<string,string> = { lease:'badge-blue', addendum:'badge-gold', move_in_checklist:'badge-green', move_out_checklist:'badge-amber', notice:'badge-red', other:'badge-muted' }

export function DocumentsPage() {
  const { data: docs = [], isLoading } = useQuery<any[]>('documents', () => apiGet('/documents'))

  return (
    <div>
      <div className="page-header"><div><h1 className="page-title">Documents</h1><p className="page-subtitle">Leases, addenda, notices</p></div></div>
      <div className="card" style={{padding:0}}>
        {isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
          <table className="data-table">
            <thead><tr><th>Document</th><th>Type</th><th>Unit</th><th>Signed</th><th>Date</th><th></th></tr></thead>
            <tbody>
              {docs.length ? docs.map((d: any) => (
                <tr key={d.id}>
                  <td style={{color:'var(--text-0)'}}><div className="flex items-center gap-8"><FileText size={15} style={{color:'var(--text-3)'}}/>{d.name}</div></td>
                  <td><span className={`badge ${TYPE_MAP[d.type]||'badge-muted'}`}>{d.type.replace('_',' ')}</span></td>
                  <td className="mono">{d.unit_number || '—'}</td>
                  <td><span className={`badge ${d.signed_at?'badge-green':'badge-amber'}`}>{d.signed_at?'Signed':'Pending'}</span></td>
                  <td className="mono" style={{fontSize:'.75rem',color:'var(--text-3)'}}>{new Date(d.created_at).toLocaleDateString()}</td>
                  <td><a href={d.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm"><Download size={13}/></a></td>
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
