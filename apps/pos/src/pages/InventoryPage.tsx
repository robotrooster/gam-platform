import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

export function InventoryPage() {
  const { data: items = [], isLoading } = useQuery<any[]>('inventory', () => apiGet('/inventory'))

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Inventory</h1><p className="page-subtitle">Supplies and resale items</p></div>
      </div>
      <div className="card" style={{padding:0}}>
        {isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
          <table className="data-table">
            <thead><tr><th>Item</th><th>SKU</th><th>Category</th><th>Qty</th><th>Unit Price</th><th>Total Value</th><th>Status</th></tr></thead>
            <tbody>
              {items.length ? items.map((item: any) => (
                <tr key={item.id}>
                  <td style={{fontWeight:500}}>{item.name || '—'}</td>
                  <td className="mono" style={{fontSize:'.78rem',color:'var(--text-3)'}}>{item.sku || '—'}</td>
                  <td><span className="badge badge-muted">{item.category || '—'}</span></td>
                  <td className="mono"><span style={{color: item.quantity <= (item.reorder_point || 0) ? 'var(--amber)' : 'var(--text-0)'}}>{item.quantity ?? '—'}</span></td>
                  <td className="mono">{fmt(item.unit_price)}</td>
                  <td className="mono" style={{color:'var(--green)'}}>{fmt((item.quantity || 0) * (item.unit_price || 0))}</td>
                  <td><span className={`badge ${item.quantity <= 0 ? 'badge-red' : item.quantity <= (item.reorder_point || 0) ? 'badge-amber' : 'badge-green'}`}>{item.quantity <= 0 ? 'out of stock' : item.quantity <= (item.reorder_point || 0) ? 'low stock' : 'in stock'}</span></td>
                </tr>
              )) : (
                <tr><td colSpan={7} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No inventory items yet.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
