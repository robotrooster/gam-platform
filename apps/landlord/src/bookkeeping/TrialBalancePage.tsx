/**
 * 10/12 (Nic, ledger P8): the trial balance — every account of the books for a
 * period: its balance at the start, the period's debits and credits, and its
 * balance at the end. The whole company, one property (every posting balances
 * within each property, so each property's trial balance balances on its own),
 * or the company's own lines that sit on no property.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). An account's row opens its general ledger.
 */
import { useState } from 'react'
import { useQuery } from 'react-query'
import { Link } from 'react-router-dom'
import { formatCurrency } from '@gam/shared'
import { booksGet as get, booksPath } from './adapter'
import { localToday, loadErrorText } from './booksMoney'
import { PeriodPickers, LedgerNotLive } from './LedgerStatements'

const signedBalance = (n: number) => (n < 0 ? `${formatCurrency(-n)} Cr` : n > 0 ? `${formatCurrency(n)} Dr` : formatCurrency(0))

export function TrialBalancePage() {
  const now = new Date()
  const [startDate, setStartDate] = useState(`${now.getFullYear()}-01-01`)
  const [endDate, setEndDate] = useState(localToday(now))
  const [property, setProperty] = useState('all')
  const { data: properties = [] } = useQuery('books-properties', () => get<any[]>('/books/properties'))
  const { data, isLoading, error } = useQuery(['trial-balance', startDate, endDate, property],
    () => get<any>(`/books/reports/trial-balance?startDate=${startDate}&endDate=${endDate}&property=${encodeURIComponent(property)}`))
  const rows: any[] = data?.rows ?? []
  const t = data?.totals

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">🧾 Trial Balance</h1>
          <p className="ps">Every account: its balance at the start, the period's debits and credits, its balance at the end</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={property} onChange={e => setProperty(e.target.value)} aria-label="Which money" style={{ width: 'auto', padding: '5px 8px', fontSize: '.75rem' }}>
            <option value="all">The whole company</option>
            {properties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="company">The company's own (no property)</option>
          </select>
          <PeriodPickers startDate={startDate} endDate={endDate} setStartDate={setStartDate} setEndDate={setEndDate} />
        </div>
      </div>
      {!!error ? <div className="alert aw">{loadErrorText(error, 'Could not load the trial balance.')}</div>
        : isLoading ? <div style={{ padding: 32, color: 'var(--t3)', textAlign: 'center' }}><span className="spinner" style={{ display: 'inline-block' }} /></div>
        : data?.live === false ? <LedgerNotLive reason={data.reason} />
        : (
          <div className="card">
            <div className="ct" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <span>Accounts</span>
              {data && <span className={`badge ${data.balances ? 'bg2' : 'br'}`}>{data.balances ? '✓ Balanced' : '⚠ Out of balance'}</span>}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="tbl" style={{ minWidth: 560 }}>
                <thead><tr>
                  <th>Account</th><th style={{ textAlign: 'right' }}>At the start</th><th style={{ textAlign: 'right' }}>Debits</th>
                  <th style={{ textAlign: 'right' }}>Credits</th><th style={{ textAlign: 'right' }}>At the end</th>
                </tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.accountId}>
                      <td style={{ fontSize: '.78rem' }}>
                        <Link to={`${booksPath('generalLedger')}?accountId=${r.accountId}&startDate=${startDate}&endDate=${endDate}`}>{r.code} · {r.name}</Link>
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>{signedBalance(r.opening)}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{formatCurrency(r.debits)}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{formatCurrency(r.credits)}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{signedBalance(r.closing)}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={5} style={{ color: 'var(--t3)', fontSize: '.78rem' }}>Nothing posted to these books yet.</td></tr>}
                  {t && rows.length > 0 && (
                    <tr style={{ borderTop: '2px solid var(--b1)' }}>
                      <td style={{ fontWeight: 700, color: 'var(--t0)' }}>Totals</td>
                      <td />
                      <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{formatCurrency(t.debits)}</td>
                      <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{formatCurrency(t.credits)}</td>
                      <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{formatCurrency(t.closingDebits)} Dr · {formatCurrency(t.closingCredits)} Cr</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="bnote">Dr is a debit balance (what you own or spent), Cr a credit balance (what you owe, what you earned, and your equity). Open an account to see every line behind it.</div>
          </div>
        )}
    </div>
  )
}
