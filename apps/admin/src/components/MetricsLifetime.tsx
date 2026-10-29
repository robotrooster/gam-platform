/**
 * 10/13 (Nic): the Metrics page's money billed and collected, tenants ever on
 * GAM, the landlords' default rate through GAM, and ages.
 *
 * Nic (10/13 evening): "Money metrics, all time, BILLED AND COLLECTED:
 * utilities billed back BY UTILITY + total; rent; total platform fees."
 * "Total tenants ever on GAM: every person on a lease, counted once (even if
 * they come back)." "Landlords' DEFAULT RATE through GAM: months left unpaid
 * by tenants who moved out owing ÷ all calendar months of rent billed — AS A
 * FRACTION of a month ($300 of $460 = 0.65), plus a DOLLAR % too, plus where
 * defaults happen by RENT RANGE. Paying later does NOT take it off." "Ages:
 * every person on a lease; average age toggled by property, oldest/youngest,
 * age at default."
 *
 * 10/14 (Nic): "Platform fees on Metrics: show each separately (space fee,
 * processing margin, screening margin) plus a total." "Months fully covered by
 * work trade: count them in months billed (as paid)." "Rent ranges: even $100
 * steps." "Unpaid-at-move-out dollar %: rent + utilities + late fees."
 * "Deposit covering unpaid rent at move-out: still a default."
 *
 * Every number comes from GET /admin/metrics/lifetime (services/platformMetrics
 * platformLifetimeMetrics), which says what each one counts. Its own request,
 * so the rest of the page never waits on it; a failed refresh keeps the numbers
 * already on screen.
 */
import React from 'react'
import type { AxiosInstance } from 'axios'
import { useQuery } from 'react-query'
import { formatCurrency } from '@gam/shared'

interface BilledCollected { billed: number; collected: number; owed: number }
interface AgeSummary { people: number; withBirthday: number; average: number | null; youngest: number | null; oldest: number | null }
interface RentRange {
  label: string; leases: number; monthsBilled: number; monthsWorkTrade: number; billed: number; householdsOwing: number
  monthsUnpaid: number; dollarsUnpaid: number; rate: number | null; dollarRate: number | null
}
export interface LifetimeMetrics {
  asOf: string
  through: string
  money: {
    rent: BilledCollected & { label: string }
    utilities: BilledCollected & { byUtility: Array<BilledCollected & { utility: string; label: string }> }
    platformFees: BilledCollected & { spaceFee: BilledCollected; processing: BilledCollected; screening: BilledCollected }
  }
  tenants: { ever: number; tenants: number; occupants: number; onALeaseNow: number; movedOn: number }
  defaults: Omit<RentRange, 'label'> & { byRentRange: RentRange[] }
  ages: AgeSummary & { byProperty: Array<AgeSummary & { propertyId: string; name: string }>; atDefault: AgeSummary }
}

const count = (n: number | null | undefined) => Number(n || 0).toLocaleString('en-US')
const plural = (n: number, one: string, many = one + 's') => `${count(n)} ${n === 1 ? one : many}`
/** A share as a percent, one decimal; "—" when there is nothing to divide by. */
const pct = (r: number | null | undefined) => (r == null ? '—' : `${(r * 100).toFixed(1)}%`)
/** Months as a fraction of a month, two decimals ("0.65"). */
const months = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const years = (n: number | null) => (n == null ? '—' : `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })}`)
/** 'YYYY-MM-DD' as a calendar day, no time-zone shift. */
const dayName = (d: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '')
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : d
}

function Tile({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'gold' | 'g' | 'a' }) {
  return (
    <div className="kpi">
      <div className="kl">{label}</div>
      <div className={`kv mx-v${tone ? ' ' + tone : ''}`}>{value}</div>
      {sub && <div className="ks">{sub}</div>}
    </div>)
}

/** One row of the billed-and-collected table. */
function MoneyRow({ label, v, strong, indent }: { label: string; v: BilledCollected; strong?: boolean; indent?: boolean }) {
  const share = v.billed > 0 ? v.collected / v.billed : null
  const cell: React.CSSProperties = { textAlign: 'right', whiteSpace: 'nowrap', fontWeight: strong ? 700 : undefined, color: strong ? 'var(--t0)' : undefined }
  return (
    <tr>
      <td style={{ paddingLeft: indent ? 26 : undefined, fontWeight: strong ? 700 : undefined, color: strong ? 'var(--t0)' : undefined }}>{label}</td>
      <td className="mono" style={cell}>{formatCurrency(v.billed)}</td>
      <td className="mono" style={cell}>{formatCurrency(v.collected)}</td>
      <td className="mono" style={{ ...cell, color: 'var(--t3)' }}>{pct(share)}</td>
    </tr>)
}

export function MetricsLifetime({ api }: { api: AxiosInstance }) {
  const { data: m, isError } = useQuery<LifetimeMetrics>('admin-metrics-lifetime',
    () => api.get('/admin/metrics/lifetime').then(r => r.data.data),
    { staleTime: 60000, refetchInterval: 60000 })
  const [place, setPlace] = React.useState<string>('all')

  if (!m) {
    return (
      <div style={{ marginBottom: 16 }}>
        <div className="ct mx-section">Billed and collected</div>
        {isError
          ? <div className="alert ae">These numbers could not be loaded just now. They try again every minute.</div>
          : <div style={{ color: 'var(--t3)', fontSize: '.8rem' }}>Loading…</div>}
      </div>)
  }

  const { money, tenants, defaults: d, ages } = m
  const chosen = place === 'all' ? null : ages.byProperty.find(p => p.propertyId === place) ?? null
  const shown: AgeSummary = chosen ?? ages
  const atDefault = ages.atDefault

  return (
    <div style={{ marginBottom: 16 }}>
      {isError && <div className="ks" style={{ marginBottom: 8, color: 'var(--amber)' }}>The last refresh failed — these are the numbers from {new Date(m.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}. It tries again every minute.</div>}

      {/* ── Money, billed and collected ── */}
      <div className="ct mx-section">Billed and collected, all time</div>
      <div className="card" style={{ marginBottom: 16, overflowX: 'auto' }}>
        <table className="tbl" style={{ minWidth: 420 }}>
          <thead><tr><th>What</th><th style={{ textAlign: 'right' }}>Billed</th><th style={{ textAlign: 'right' }}>Collected</th><th style={{ textAlign: 'right' }}>Collected share</th></tr></thead>
          <tbody>
            <MoneyRow label={money.rent.label} v={money.rent} strong/>
            <MoneyRow label="Utilities billed back" v={money.utilities} strong/>
            {money.utilities.byUtility.map(u => <MoneyRow key={u.utility} label={u.label} v={u} indent/>)}
            <MoneyRow label="GAM platform fees" v={money.platformFees} strong/>
            <MoneyRow label="Monthly space fee" v={money.platformFees.spaceFee} indent/>
            <MoneyRow label="Card and ACH processing margin" v={money.platformFees.processing} indent/>
            <MoneyRow label="Screening margin" v={money.platformFees.screening} indent/>
          </tbody>
        </table>
        <div className="ks" style={{ marginTop: 10, lineHeight: 1.5 }}>
          Bills due through {dayName(m.through)}, less credits given and what work trade covered. Collected is what was paid, covered by money paid ahead
          or deposit interest, or kept from a deposit — the same figures every landlord's own reports show. Platform fees are
          what GAM earned, from the same book as the money page: its monthly fee per space (collected unless the landlord's
          charge is still open), its margin on card and bank (ACH) processing, and its margin on background checks — a margin
          is earned when the money it rode in on is paid, so it is billed and collected at once.
        </div>
      </div>

      {/* ── Tenants ── */}
      <div className="ct mx-section">Tenants</div>
      <div className="mx-grid" style={{ marginBottom: 16 }}>
        <Tile label="Tenants ever on GAM" value={count(tenants.ever)} tone="gold"
          sub={`everyone ever on a lease, counted once, even if they left and came back${tenants.occupants > 0
            ? ` · ${plural(tenants.tenants, 'tenant')} and ${plural(tenants.occupants, 'occupant')} listed with them` : ''}`}/>
        <Tile label="On a lease now" value={count(tenants.onALeaseNow)} sub={`${count(tenants.movedOn)} moved on`}/>
      </div>

      {/* ── The default rate ── */}
      <div className="ct mx-section">Landlords' default rate through GAM</div>
      <div className="mx-grid" style={{ marginBottom: 12 }}>
        <Tile label="Default rate" value={pct(d.rate)} tone="gold"
          sub={`${months(d.monthsUnpaid)} months of rent left unpaid by households that moved out owing, of ${plural(d.monthsBilled, 'calendar month')} of rent billed${d.monthsWorkTrade > 0 ? ` (${count(d.monthsWorkTrade)} paid by work trade)` : ''}`}/>
        <Tile label="By dollars" value={pct(d.dollarRate)}
          sub={`${formatCurrency(d.dollarsUnpaid)} of rent, utilities and late fees unpaid at move-out, of ${formatCurrency(d.billed)} of the same three billed`}/>
        <Tile label="Moved out owing" value={count(d.householdsOwing)}
          sub={`${d.householdsOwing === 1 ? 'household' : 'households'} that left rent, utilities or late fees unpaid`}/>
      </div>
      <div className="card" style={{ marginBottom: 16, overflowX: 'auto' }}>
        <div className="ct">By monthly rent</div>
        {d.byRentRange.length === 0
          ? <div style={{ color: 'var(--t3)', fontSize: '.8rem' }}>No rent has been billed yet.</div>
          : <table className="tbl" style={{ minWidth: 640 }}>
              <thead><tr>
                <th>Monthly rent</th><th style={{ textAlign: 'right' }}>Leases</th>
                <th style={{ textAlign: 'right' }}>Months billed</th><th style={{ textAlign: 'right' }}>Months unpaid</th>
                <th style={{ textAlign: 'right' }}>Default rate</th><th style={{ textAlign: 'right' }}>Billed</th>
                <th style={{ textAlign: 'right' }}>Unpaid at move-out</th><th style={{ textAlign: 'right' }}>By dollars</th>
              </tr></thead>
              <tbody>{d.byRentRange.map(b => (
                <tr key={b.label}>
                  <td>{b.label}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{count(b.leases)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{count(b.monthsBilled)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{months(b.monthsUnpaid)}</td>
                  <td className="mono" style={{ textAlign: 'right', color: b.householdsOwing > 0 ? 'var(--amber)' : undefined }}>{pct(b.rate)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{formatCurrency(b.billed)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{formatCurrency(b.dollarsUnpaid)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{pct(b.dollarRate)}</td>
                </tr>))}
              </tbody>
            </table>}
        <div className="ks" style={{ marginTop: 10, lineHeight: 1.5 }}>
          A household moved out when its lease ended and nobody on it went on renting from that landlord. Months unpaid is the
          rent still open the day the lease ended, as a share of its monthly rent ($300 left of a $460 month is 0.65) — paying it
          later does not take it off. What the deposit covered at move-out still counts as left unpaid. A calendar month billed is
          each lease's month with a rent bill (a prorated month is a month); a month work trade paid counts, as paid. By dollars
          and Unpaid at move-out count rent, utilities and late fees, against the rent, utilities and late fees billed (Billed),
          work trade counted as paid.
        </div>
      </div>

      {/* ── Ages ── */}
      <div className="ct mx-section" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span>Ages</span>
        <select aria-label="Ages at which property" value={place} onChange={e => setPlace(e.target.value)}
          style={{ background: 'var(--bg3)', color: 'var(--t0)', border: '1px solid var(--b1)', borderRadius: 6, padding: '4px 8px',
                   fontSize: '.75rem', textTransform: 'none', letterSpacing: 0, maxWidth: '100%' }}>
          <option value="all">All properties</option>
          {ages.byProperty.map(p => <option key={p.propertyId} value={p.propertyId}>{p.name}</option>)}
        </select>
      </div>
      <div className="mx-grid" style={{ marginBottom: 8 }}>
        <Tile label="Average age" value={years(shown.average)} tone="gold"
          sub={`${count(shown.withBirthday)} of ${plural(shown.people, 'person', 'people')} on a lease have a birthday on file`}/>
        <Tile label="Youngest" value={years(shown.youngest)}/>
        <Tile label="Oldest" value={years(shown.oldest)}/>
        <Tile label="Age at default" value={years(atDefault.average)}
          sub={atDefault.withBirthday > 0
            ? `average age on the day their household moved out owing · youngest ${years(atDefault.youngest)}, oldest ${years(atDefault.oldest)} · ${count(atDefault.withBirthday)} of ${plural(atDefault.people, 'person', 'people')} with a birthday on file`
            : atDefault.people > 0 ? `no birthday on file for the ${plural(atDefault.people, 'person', 'people')} who moved out owing` : 'nobody has moved out owing'}/>
      </div>
      <div className="ks" style={{ lineHeight: 1.5 }}>
        Everyone ever on a lease — tenants and the occupants listed with them — with a birthday on file, age today.
        Birthdays come from the signed leases. Age at default is for all properties.
      </div>
    </div>)
}
