import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'

// Front-desk "who owes" view. Read-only list of tenants with an unpaid balance
// + contact info, so a front-counter person knows who to call. Data from
// GET /balances (unpaid invoice balances, per the platform's outstanding def).
interface Owed {
  tenant_id: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  email: string | null
  unit_number: string | null
  property_name: string | null
  balance: string
  open_invoices: number
  oldest_due_date: string | null
}

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

function daysOverdue(due: string | null): number | null {
  if (!due) return null
  const d = new Date(due.slice(0, 10) + 'T00:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.floor((today.getTime() - d.getTime()) / 86400000)
}

export function BalancesPage() {
  const { data: rows = [], isLoading } = useQuery<Owed[]>('outstanding-balances', () => apiGet('/balances'))

  const total = (rows as Owed[]).reduce((s, r) => s + Number(r.balance), 0)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Outstanding Balances</h1>
          <p className="page-subtitle">Who owes and how to reach them</p>
        </div>
        {rows.length > 0 && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Total owed</div>
            <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--gold)' }}>{fmt(total)}</div>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>
          🎉 No outstanding balances — everyone's current.
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Unit / Property</th>
                <th style={{ textAlign: 'right' }}>Owed</th>
                <th>Oldest due</th>
                <th>Contact</th>
              </tr>
            </thead>
            <tbody>
              {(rows as Owed[]).map(r => {
                const od = daysOverdue(r.oldest_due_date)
                const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Tenant'
                return (
                  <tr key={r.tenant_id + (r.unit_number || '')}>
                    <td style={{ fontWeight: 500 }}>{name}</td>
                    <td style={{ fontSize: '.85rem', color: 'var(--text-2)' }}>
                      {r.unit_number ? `Unit ${r.unit_number}` : '—'}
                      {r.property_name && <span style={{ color: 'var(--text-3)' }}> · {r.property_name}</span>}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--gold)' }}>
                      {fmt(Number(r.balance))}
                      <div style={{ fontSize: '.68rem', color: 'var(--text-3)', fontWeight: 400 }}>
                        {r.open_invoices} invoice{r.open_invoices === 1 ? '' : 's'}
                      </div>
                    </td>
                    <td style={{ fontSize: '.82rem' }}>
                      {r.oldest_due_date ? new Date(r.oldest_due_date.slice(0, 10) + 'T00:00:00').toLocaleDateString() : '—'}
                      {od != null && od > 0 && (
                        <span style={{ marginLeft: 6, fontSize: '.68rem', fontWeight: 600, color: od > 30 ? 'var(--red, #ef4444)' : 'var(--amber, #d0a02a)' }}>
                          {od}d overdue
                        </span>
                      )}
                    </td>
                    <td style={{ fontSize: '.82rem' }}>
                      {r.phone && <div><a href={`tel:${r.phone}`} style={{ color: 'var(--gold)' }}>{r.phone}</a></div>}
                      {r.email && <div><a href={`mailto:${r.email}`} style={{ color: 'var(--text-2)' }}>{r.email}</a></div>}
                      {!r.phone && !r.email && <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
