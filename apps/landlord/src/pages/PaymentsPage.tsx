import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
import { formatCurrency } from '@gam/shared'

const STATUS_MAP: Record<string,string> = { settled:'badge-green', pending:'badge-amber', failed:'badge-red', returned:'badge-red', processing:'badge-blue' }

export function PaymentsPage() {
  const { data: payments = [], isLoading } = useQuery<any[]>('payments', () => apiGet('/payments'))

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Payments</h1><p className="page-subtitle">Tenant ACH collections</p></div>
      </div>
      <div className="card" style={{padding:0}}>
        {isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
          <table className="data-table">
            <thead><tr><th>Due</th><th>Unit</th><th>Type</th><th>Amount</th><th>Status</th><th>Entry Desc</th><th>Return</th></tr></thead>
            <tbody>
              {payments.length ? payments.map((p: any) => (
                <tr key={p.id}>
                  <td className="mono">{new Date(p.due_date).toLocaleDateString()}</td>
                  <td className="mono">{p.unit_number || '—'}</td>
                  <td><span className="badge badge-muted">{p.type}</span></td>
                  <td className="mono" style={{color:'var(--text-0)'}}>{formatCurrency(p.amount)}</td>
                  <td><span className={`badge ${STATUS_MAP[p.status]||'badge-muted'}`}>{p.status}</span></td>
                  <td className="mono" style={{fontSize:'.72rem',color:'var(--text-3)'}}>{p.entry_description}</td>
                  <td>{p.return_code ? <span className={`badge ${p.zero_tolerance_flag?'badge-red':'badge-amber'}`}>{p.return_code}</span> : <span style={{color:'var(--text-3)'}}>—</span>}</td>
                </tr>
              )) : (
                <tr><td colSpan={7} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No payments yet.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
