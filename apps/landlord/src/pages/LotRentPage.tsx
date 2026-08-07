// S568 (Nic): investor-operator net + lot-rent obligations. Only meaningful for
// operators who run homes on parks they don't own (homes-only properties). Shows
// their spread (tenant rent − lot rent) and lets them mark lot rent paid to the
// external park (GAM moves no money — the park isn't on the platform).
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { toast } from '../components/dialogs'

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'
const monthLabel = (d: string) => new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' })

export function LotRentPage() {
  const qc = useQueryClient()
  const { data: portfolio, isLoading } = useQuery<any>('lot-rent-portfolio', () => apiGet('/lot-rent/portfolio'))
  const { data: charges = [] } = useQuery<any[]>('lot-rent-charges-pending', () => apiGet('/lot-rent/charges?status=pending'))

  const payMut = useMutation(
    (id: string) => apiPost(`/lot-rent/charges/${id}/record-paid`, {}),
    { onSuccess: () => { qc.invalidateQueries('lot-rent-charges-pending'); qc.invalidateQueries('lot-rent-portfolio'); toast('Marked paid.') } })

  const homes: any[] = portfolio?.homes || []
  const totals = portfolio?.totals || { homes: 0, rent: 0, lotRent: 0, net: 0 }
  const outstanding = portfolio?.outstandingLotRent || { count: 0, amount: 0 }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Lot Rent & Net</h1>
          <p className="page-subtitle">Your homes on parks you don't own — tenant rent minus the lot rent you pay each park.</p>
        </div>
      </div>

      {isLoading ? (
        <div style={{ padding: 32, color: 'var(--text-3)' }}>Loading…</div>
      ) : homes.length === 0 ? (
        <div className="empty-state" style={{ padding: 48 }}>
          <h3>No homes-only parks yet</h3>
          <p>When you add a property and check “I don't own the land here,” your homes there show up with their lot rent and net.</p>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 20 }}>
            {[['Homes', String(totals.homes)],
              ['Tenant rent', fmt(totals.rent)],
              ['Lot rent', fmt(totals.lotRent)],
              ['Net / mo', fmt(totals.net)]].map(([k, v], i) => (
              <div key={k} className="card" style={{ padding: '14px 16px' }}>
                <div style={{ fontSize: '.65rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>{k}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.05rem', fontWeight: 700, color: i === 3 ? 'var(--green)' : 'var(--text-0)' }}>{v}</div>
              </div>
            ))}
          </div>

          {outstanding.count > 0 && (
            <div className="card" style={{ padding: '12px 16px', marginBottom: 20, borderLeft: '3px solid var(--amber)' }}>
              <span style={{ color: 'var(--amber)', fontWeight: 700 }}>{fmt(outstanding.amount)}</span>
              <span style={{ color: 'var(--text-3)' }}> in lot rent owed to your parks across {outstanding.count} charge{outstanding.count > 1 ? 's' : ''}. Pay the park directly, then mark it paid below.</span>
            </div>
          )}

          <div className="card" style={{ padding: 0, marginBottom: 20 }}>
            <div className="card-title" style={{ padding: '14px 16px 0' }}>Your homes</div>
            <table className="data-table">
              <thead><tr><th>Home</th><th>Park</th><th>Tenant rent</th><th>Lot rent</th><th>Net</th></tr></thead>
              <tbody>
                {homes.map(h => (
                  <tr key={h.unitId}>
                    <td style={{ fontWeight: 600 }}>Unit {h.unitNumber}</td>
                    <td style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>{h.propertyName}</td>
                    <td>{fmt(h.rentAmount)}</td>
                    <td>{fmt(h.lotRentAmount)}</td>
                    <td style={{ color: 'var(--green)', fontWeight: 600 }}>{fmt(h.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {charges.length > 0 && (
            <div className="card" style={{ padding: 0 }}>
              <div className="card-title" style={{ padding: '14px 16px 0' }}>Lot rent owed</div>
              <table className="data-table">
                <thead><tr><th>Month</th><th>Home</th><th>Park</th><th>Amount</th><th></th></tr></thead>
                <tbody>
                  {charges.map(c => (
                    <tr key={c.id}>
                      <td>{monthLabel(c.billingMonth)}</td>
                      <td>Unit {c.unitNumber}</td>
                      <td style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>{c.propertyName}</td>
                      <td>{fmt(c.amount)}</td>
                      <td><button className="btn btn-primary btn-sm" disabled={payMut.isLoading} onClick={() => payMut.mutate(c.id)}>Mark paid</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
