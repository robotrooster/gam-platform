/**
 * 10/11 (Nic): "money coming in, money going out." The company's bank
 * account as the bank feed has it — read only. Linking a bank, filing a
 * transaction and matching deposits stay on the owner's Bank page.
 *
 * One of the shared financial pages: the same bytes in the landlord portal and
 * GAM Books (financials-parity.test.ts). The owner and the bookkeeper read the
 * same line: the bank's own description (who paid or was paid — how a bank
 * line is reconciled) and, in its own column, what it was filed as. A
 * bookkeeper's description has any email or phone number on it taken out by
 * the server (GET /financials/bank-activity). Money in and money out count
 * every line in the days picked; the list shows the newest of them.
 */
import { useQuery } from 'react-query'
import { finGet } from './adapter'
import { usePeriod, periodQuery, money, dayName, errorWords, PeriodPicker, PageHead, Notice, useFinancialsScope } from './common'

interface Txn {
  id: string; day: string; amount: number; direction: 'in' | 'out'
  description: string; filedAs: string | null; statusLabel: string
  accountName: string | null; companyName: string | null
}
interface BankData { transactions: Txn[]; transactionCount: number; moneyIn: number; moneyOut: number }

export function BankActivityPage() {
  const { data: scope } = useFinancialsScope()
  const [period, setPeriod] = usePeriod('this_month')
  const { data, isLoading, error } = useQuery<BankData>(
    ['financials-bank', period.from, period.to],
    () => finGet<BankData>(`/financials/bank-activity?${periodQuery(period)}`),
    { keepPreviousData: true, retry: false },
  )
  const txns = data?.transactions ?? []
  const severalCompanies = (scope?.companies.length ?? 0) > 1
  // The totals count every line in the days picked; the list stops at the newest.
  const allLines = Number(data?.transactionCount ?? txns.length)
  const listCut = allLines > txns.length

  return (
    <div className="fin">
      <PageHead title="Bank activity"
        subtitle="Every deposit and withdrawal on the company's linked bank account. It covers the whole company." />
      <div className="fin-controls"><PeriodPicker value={period} onChange={setPeriod} /></div>
      {error ? <Notice>{errorWords(error, 'Could not load bank activity. Try again in a moment.')}</Notice> : (
        <>
          <div className="fin-kpis">
            <div className="fin-kpi">
              <div className="fin-kpi-label">Money in</div>
              <div className="fin-kpi-value fin-in">{isLoading && !data ? '…' : money(data?.moneyIn ?? 0)}</div>
            </div>
            <div className="fin-kpi">
              <div className="fin-kpi-label">Money out</div>
              <div className="fin-kpi-value fin-out">{isLoading && !data ? '…' : money(data?.moneyOut ?? 0)}</div>
            </div>
          </div>
          <div className="card fin-card">
            {listCut && (
              <div className="fin-card-head">
                <span className="fin-muted">
                  {`Showing the newest ${txns.length.toLocaleString('en-US')} of ${allLines.toLocaleString('en-US')} lines. Money in and money out count all of them. Pick fewer days to see the rest.`}
                </span>
              </div>
            )}
            {txns.length === 0 ? (
              <div className="fin-empty">{isLoading ? 'Loading…' : 'No bank activity in these days, or no bank is linked yet.'}</div>
            ) : (
              <table className="data-table">
                <thead><tr>
                  <th>Day</th><th>Description</th><th>Filed as</th><th>Status</th>
                  {severalCompanies && <th>Company</th>}<th>Account</th><th className="fin-num">Amount</th>
                </tr></thead>
                <tbody>
                  {txns.map(t => (
                    <tr key={t.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{dayName(t.day)}</td>
                      <td>{t.description}</td>
                      <td className="fin-muted">{t.filedAs || '—'}</td>
                      <td className="fin-muted">{t.statusLabel}</td>
                      {severalCompanies && <td className="fin-muted">{t.companyName || '—'}</td>}
                      <td className="fin-muted">{t.accountName || '—'}</td>
                      <td className={`fin-num ${t.direction === 'in' ? 'fin-in' : 'fin-out'}`}>{money(t.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}
