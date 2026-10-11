/**
 * 10/11 (Nic): "money coming in, money going out." The company's bank
 * account as the bank feed has it — read only. Linking a bank, filing a
 * transaction and matching deposits stay on the owner's Bank page.
 *
 * One of the shared financial pages: the same bytes in the landlord portal and
 * GAM Books (financials-parity.test.ts). A bookkeeper sees what money in WAS
 * (a GAM payout, a bank deposit, laundry income) and what money out was filed
 * as (its vendor and kind), never the bank's memo, which can name the person
 * who paid or was paid (GET /financials/bank-activity).
 */
import { useQuery } from 'react-query'
import { finGet } from './adapter'
import { usePeriod, periodQuery, money, dayName, errorWords, PeriodPicker, PageHead, Notice, useFinancialsScope } from './common'

interface Txn {
  id: string; day: string; amount: number; direction: 'in' | 'out'
  description: string; filedAs: string | null; statusLabel: string
  accountName: string | null; companyName: string | null
}
interface BankData { transactions: Txn[]; moneyIn: number; moneyOut: number }

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
