/**
 * S645 — the owner's whole book, and the managers side by side.
 *
 * Nic (S645, DIRECTIVE): "I don't want to have to log in to see half my
 * properties and log into a different thing to see the other half, because a
 * different property manager might be handling it. I want to be able to do
 * side-by-side comparison on who's filling vacancies faster, who's handling
 * evictions promptly, who's collecting on time — just different metrics to
 * compare between property management companies."
 *
 * One column per manager, with the owner's self-managed half first as the
 * baseline they are really judging against. A blank figure is left blank and
 * explained; a manager with no rent roll yet is not scored zero for it, and
 * eviction promptness is named as something GAM does not measure rather than
 * filled with a number that would read as fact.
 */

import { useState } from 'react'
import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'

interface Scorecard {
  pmCompanyId: string | null
  pmCompanyName: string
  propertyCount: number
  unitCount: number
  occupiedUnits: number
  vacantUnits: number
  occupancyPct: number | null
  onTimeRatePct: number | null
  rentDueCount: number
  avgDaysLate: number | null
  avgDaysToFill: number | null
  turnovers: number
  evictionsResolved: null
  properties: Array<{ propertyId: string; propertyName: string; unitCount: number }>
}
interface Portfolio {
  windowStart: string
  windowEnd: string
  managers: Scorecard[]
  totals: { propertyCount: number; unitCount: number; occupiedUnits: number }
  notMeasured: string[]
}

const pct = (n: number | null) => n == null ? '—' : `${n}%`
const days = (n: number | null) => n == null ? '—' : `${n} ${n === 1 ? 'day' : 'days'}`

export function MyManagersPage() {
  const [months, setMonths] = useState(12)
  const q = useQuery<Portfolio>(
    ['owner-portfolio', months],
    () => apiGet<Portfolio>(`/pm/my-portfolio?months=${months}`),
  )

  const p = q.data
  const managers = p?.managers ?? []

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.4rem', color: 'var(--text-0)' }}>My Managers</h1>
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
            Every property you own, whoever runs it — side by side.
          </div>
        </div>
        <select
          value={months}
          onChange={e => setMonths(Number(e.target.value))}
          style={{ background: 'var(--bg-2)', color: 'var(--text-1)', border: '1px solid var(--border-0)', borderRadius: 6, padding: '5px 9px', fontSize: '.78rem' }}
        >
          <option value={3}>Last 3 months</option>
          <option value={6}>Last 6 months</option>
          <option value={12}>Last 12 months</option>
          <option value={24}>Last 2 years</option>
        </select>
      </div>

      {q.isLoading && <div style={{ color: 'var(--text-3)' }}>Loading…</div>}

      {p && managers.length === 0 && (
        <div className="card" style={{ padding: 16, color: 'var(--text-2)', fontSize: '.88rem' }}>
          No properties on this account yet.
        </div>
      )}

      {managers.length > 0 && (
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))' }}>
          {managers.map(m => (
            <div key={m.pmCompanyId ?? 'self'} className="card" style={{ padding: 16 }}>
              <div style={{ fontSize: '.95rem', fontWeight: 800, color: 'var(--text-0)' }}>
                {m.pmCompanyName}
              </div>
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2, marginBottom: 12 }}>
                {m.propertyCount} {m.propertyCount === 1 ? 'property' : 'properties'} · {m.unitCount} units
              </div>

              <Row label="Occupied"
                   value={`${m.occupiedUnits} of ${m.unitCount}`}
                   sub={m.occupancyPct == null ? undefined : pct(m.occupancyPct)} />
              <Row label="Rent collected on time"
                   value={pct(m.onTimeRatePct)}
                   sub={m.rentDueCount > 0
                     ? `${m.rentDueCount} charges due`
                     : 'nothing has come due yet'} />
              <Row label="When late, by"
                   value={days(m.avgDaysLate)}
                   sub={m.avgDaysLate == null ? 'nothing paid late' : 'on average'} />
              <Row label="Days to fill a space"
                   value={days(m.avgDaysToFill)}
                   sub={m.turnovers > 0
                     ? `${m.turnovers} ${m.turnovers === 1 ? 'turnover' : 'turnovers'}`
                     : 'no turnovers in this window'} />
              <Row label="Vacant now" value={String(m.vacantUnits)} />

              {m.properties.length > 0 && (
                <div style={{ marginTop: 12, borderTop: '1px solid var(--border-0)', paddingTop: 10 }}>
                  {m.properties.map(pr => (
                    <div key={pr.propertyId} style={{ fontSize: '.74rem', color: 'var(--text-2)', display: 'flex', justifyContent: 'space-between' }}>
                      <span>{pr.propertyName}</span>
                      <span style={{ color: 'var(--text-3)' }}>{pr.unitCount}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Say what is NOT on the card, so a blank is never read as a zero. */}
      {p && p.notMeasured.length > 0 && (
        <div style={{ fontSize: '.73rem', color: 'var(--text-3)', marginTop: 16, maxWidth: 680, lineHeight: 1.55 }}>
          {p.notMeasured.map((n, i) => <div key={i} style={{ marginTop: 4 }}>{n}</div>)}
        </div>
      )}
    </div>
  )
}

const Row = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '5px 0' }}>
    <div style={{ fontSize: '.76rem', color: 'var(--text-2)' }}>{label}</div>
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontSize: '.88rem', fontWeight: 700, color: 'var(--text-0)' }}>{value}</div>
      {sub && <div style={{ fontSize: '.66rem', color: 'var(--text-3)' }}>{sub}</div>}
    </div>
  </div>
)
