/**
 * 10/11 (Nic): "incoming income type pools, monthly, daily, electric bill
 * back, etc." Money that arrived, added up by what it was for — by month and by
 * day, with totals. Nothing here names a tenant, a unit or a lease, so the
 * owner can hand it to whoever keeps the books.
 *
 * One of the shared financial pages: the same bytes in the landlord portal and
 * GAM Books (financials-parity.test.ts). The total is the P&L's income total
 * for the same days and properties (GET /financials/income, Money received).
 */
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from 'react-query'
import { finGet } from './adapter'
import {
  useFinancialsScope, usePeriod, periodQuery, money, monthName, dayName, errorWords,
  PropertyPicker, PeriodPicker, PageHead, Notice,
} from './common'

interface PoolRow { key: string; label: string; amount: number }
// A period's pools come as a list (the API camelizes object keys, and a pool key is data).
interface PoolPeriod { total: number; depositsHeld: number; pools: Array<{ key: string; amount: number }> }
const amountOf = (p: PoolPeriod, key: string): number => p.pools.find(x => x.key === key)?.amount ?? 0
interface IncomeData {
  period: { start: string; end: string }
  basis: { label: string; note: string }
  pools: PoolRow[]
  total: number
  depositsHeld: number
  months: Array<{ month: string } & PoolPeriod>
  days: Array<{ day: string } & PoolPeriod>
}

export function IncomePage() {
  const { data: scope, error: scopeError } = useFinancialsScope()
  const [propertyId, setPropertyId] = useState('')
  const [period, setPeriod] = usePeriod('this_month')
  const { data, isLoading, error } = useQuery<IncomeData>(
    ['financials-income', period.from, period.to, propertyId],
    () => finGet<IncomeData>(`/financials/income?${periodQuery(period, propertyId)}`),
    { keepPreviousData: true },
  )
  const pools = data?.pools ?? []
  const [dayMonth, setDayMonth] = useState('')
  const monthKeys = useMemo(() => (data?.months ?? []).map(m => m.month), [data])
  useEffect(() => {
    if (!monthKeys.includes(dayMonth)) setDayMonth(monthKeys[monthKeys.length - 1] ?? '')
  }, [monthKeys, dayMonth])
  const days = (data?.days ?? []).filter(d => d.day.startsWith(dayMonth))
  const biggest = Math.max(1, ...pools.map(p => Math.abs(p.amount)))

  return (
    <div className="fin">
      <PageHead title="Money in"
        subtitle="Money that arrived, added up by what it was for — by month and by day. No tenant names." />
      {scopeError ? <Notice>{errorWords(scopeError, 'Could not load your books.')}</Notice> : null}
      <div className="fin-controls">
        <PropertyPicker value={propertyId} onChange={setPropertyId} properties={scope?.properties ?? []} />
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>

      {error ? <Notice>{errorWords(error, 'Could not load money in. Try again in a moment.')}</Notice> : null}

      <div className="fin-kpis">
        <div className="fin-kpi">
          <div className="fin-kpi-label">Money received</div>
          <div className="fin-kpi-value fin-in">{isLoading && !data ? '…' : money(data?.total ?? 0)}</div>
          <div className="fin-kpi-sub">{dayName(period.from)} – {dayName(period.to)}</div>
        </div>
        <div className="fin-kpi">
          <div className="fin-kpi-label">Deposits received</div>
          <div className="fin-kpi-value">{money(data?.depositsHeld ?? 0)}</div>
          <div className="fin-kpi-sub">Held for tenants — never income, not in the total</div>
        </div>
      </div>
      {data?.basis?.note && <p className="fin-muted" style={{ margin: '-6px 0 16px' }}>{data.basis.note}</p>}

      <div className="card fin-card">
        <div className="fin-card-head"><span className="fin-card-title">By type</span></div>
        {pools.length === 0 ? (
          <div className="fin-empty">{isLoading ? 'Loading…' : 'No money arrived in these days.'}</div>
        ) : (
          <table className="data-table">
            <thead><tr><th>Type</th><th className="fin-num">Amount</th><th className="fin-num">Share</th><th></th></tr></thead>
            <tbody>
              {pools.map(p => (
                <tr key={p.key}>
                  <td>{p.label}</td>
                  <td className="fin-num">{money(p.amount)}</td>
                  <td className="fin-num fin-muted">{data && data.total ? `${Math.round((p.amount / data.total) * 100)}%` : '—'}</td>
                  <td className="fin-bar-cell"><div className="fin-bar" style={{ width: `${Math.max(1, Math.round((Math.abs(p.amount) / biggest) * 100))}%` }} /></td>
                </tr>
              ))}
              <tr className="fin-total"><td>Total</td><td className="fin-num">{money(data?.total ?? 0)}</td><td></td><td></td></tr>
            </tbody>
          </table>
        )}
      </div>

      <div className="card fin-card">
        <div className="fin-card-head"><span className="fin-card-title">By month</span></div>
        {(data?.months ?? []).length === 0 ? <div className="fin-empty">Nothing yet.</div> : (
          <table className="data-table">
            <thead><tr>
              <th>Month</th>
              {pools.map(p => <th key={p.key} className="fin-num">{p.label}</th>)}
              <th className="fin-num">Total</th>
            </tr></thead>
            <tbody>
              {(data?.months ?? []).map(m => (
                <tr key={m.month}>
                  <td style={{ whiteSpace: 'nowrap' }}>{monthName(m.month)}</td>
                  {pools.map(p => <td key={p.key} className="fin-num">{amountOf(m, p.key) ? money(amountOf(m, p.key)) : '—'}</td>)}
                  <td className="fin-num" style={{ fontWeight: 700 }}>{money(m.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card fin-card">
        <div className="fin-card-head">
          <span className="fin-card-title">By day</span>
          {monthKeys.length > 1 && (
            <select className="form-input fin-select" value={dayMonth} onChange={e => setDayMonth(e.target.value)}>
              {monthKeys.map(k => <option key={k} value={k}>{monthName(k)}</option>)}
            </select>
          )}
        </div>
        {days.length === 0 ? <div className="fin-empty">Nothing yet.</div> : (
          <table className="data-table">
            <thead><tr>
              <th>Day</th>
              {pools.map(p => <th key={p.key} className="fin-num">{p.label}</th>)}
              <th className="fin-num">Total</th>
            </tr></thead>
            <tbody>
              {days.map(d => (
                <tr key={d.day}>
                  <td style={{ whiteSpace: 'nowrap' }}>{dayName(d.day)}</td>
                  {pools.map(p => <td key={p.key} className="fin-num">{amountOf(d, p.key) ? money(amountOf(d, p.key)) : '—'}</td>)}
                  <td className="fin-num" style={{ fontWeight: 700 }}>{money(d.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
