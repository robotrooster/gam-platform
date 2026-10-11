/**
 * 10/11 (Nic): "maintenance... the maintenance costs. They don't need to see
 * all the maintenance reports." What repairs cost — the amount, the day the
 * work was finished, its kind, and where — and nothing of the request itself.
 *
 * One of the shared financial pages: the same bytes in the landlord portal and
 * GAM Books (financials-parity.test.ts). The P&L's own maintenance figure for
 * the same days (GET /financials/maintenance-costs).
 */
import { useState } from 'react'
import { useQuery } from 'react-query'
import { finGet } from './adapter'
import {
  useFinancialsScope, usePeriod, periodQuery, money, dayName, errorWords,
  PropertyPicker, PeriodPicker, PageHead, Notice,
} from './common'

interface CostLine {
  id: string; day: string; categoryLabel: string; amount: number
  unitNumber: string | null; propertyName: string | null
}
interface CostData {
  lines: CostLine[]
  byCategory: Array<{ category: string; label: string; amount: number; count: number }>
  total: number
}

export function MaintenanceCostsPage() {
  const { data: scope } = useFinancialsScope()
  const [propertyId, setPropertyId] = useState('')
  const [period, setPeriod] = usePeriod('this_year')
  const { data, isLoading, error } = useQuery<CostData>(
    ['financials-maintenance', period.from, period.to, propertyId],
    () => finGet<CostData>(`/financials/maintenance-costs?${periodQuery(period, propertyId)}`),
    { keepPreviousData: true },
  )
  const lines = data?.lines ?? []
  const severalProperties = (scope?.properties.length ?? 0) > 1

  return (
    <div className="fin">
      <PageHead title="Maintenance costs"
        subtitle="What repairs cost, by the day the work was finished. The work orders themselves stay with the owner." />
      <div className="fin-controls">
        <PropertyPicker value={propertyId} onChange={setPropertyId} properties={scope?.properties ?? []} />
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>
      {error ? <Notice>{errorWords(error, 'Could not load maintenance costs. Try again in a moment.')}</Notice> : null}

      <div className="fin-kpis">
        <div className="fin-kpi">
          <div className="fin-kpi-label">Spent on repairs</div>
          <div className="fin-kpi-value fin-out">{isLoading && !data ? '…' : money(data?.total ?? 0)}</div>
          <div className="fin-kpi-sub">{lines.length} repair{lines.length === 1 ? '' : 's'} finished · {dayName(period.from)} – {dayName(period.to)}</div>
        </div>
      </div>

      {(data?.byCategory ?? []).length > 0 && (
        <div className="card fin-card">
          <div className="fin-card-head"><span className="fin-card-title">By kind of work</span></div>
          <table className="data-table">
            <thead><tr><th>Kind</th><th className="fin-num">Repairs</th><th className="fin-num">Cost</th></tr></thead>
            <tbody>
              {(data?.byCategory ?? []).map(c => (
                <tr key={c.category}><td>{c.label}</td><td className="fin-num">{c.count}</td><td className="fin-num">{money(c.amount)}</td></tr>
              ))}
              <tr className="fin-total"><td>Total</td><td className="fin-num">{lines.length}</td><td className="fin-num">{money(data?.total ?? 0)}</td></tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="card fin-card">
        <div className="fin-card-head"><span className="fin-card-title">Each repair</span></div>
        {lines.length === 0 ? (
          <div className="fin-empty">{isLoading ? 'Loading…' : 'No repairs with a cost were finished in these days.'}</div>
        ) : (
          <table className="data-table">
            <thead><tr>
              <th>Finished</th><th>Kind</th>{severalProperties && <th>Property</th>}<th>Unit</th><th className="fin-num">Cost</th>
            </tr></thead>
            <tbody>
              {lines.map(l => (
                <tr key={l.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{dayName(l.day)}</td>
                  <td>{l.categoryLabel}</td>
                  {severalProperties && <td className="fin-muted">{l.propertyName || '—'}</td>}
                  <td className="fin-muted">{l.unitNumber ? `#${l.unitNumber}` : '—'}</td>
                  <td className="fin-num">{money(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
