import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from 'react-query'
import {
  humanize, UNIT_TYPE_LABEL, UNIT_STATUS_LABEL, MAINTENANCE_STATUS_LABEL, PAYMENT_STATUS_LABEL,
  type IncomeBasis, type PaymentStatus,
} from '@gam/shared'
import { apiGet } from '../lib/api'
import { usePerms } from '../lib/permissions'
import { X, Printer, Download } from 'lucide-react'
// S633: tax + statement documents belong to ONE company; the picker renders
// nothing for an account that owns a single one.
import { EntityPicker, useEntities } from '../components/EntityPicker'
// S655 (money plan, Step 15): ONE "Money received" / "Money billed" switch
// above the tabs; every query on this page carries it.
import { IncomeBasisToggle, BasisPrintNote } from '../components/IncomeBasisToggle'
import {
  useIncomeBasis, withBasis, basisLabel, perMonthTitle, incomeCardView,
  activeCategories, categoryColumns, categoryLabel, expenseLines, expenseCategoryLabel,
  groupCharges, partsText, noChargeRemainder, sumAmounts, INCOME_LINES_ORDER, incomeLineLabel,
  billedOutcome, besideNotInTotal, usDay, chargeDay, chargeKey, reportErrorText, latestOnly,
  showsBillOutcome, resultIsStale, paidAheadOnHand, PAID_AHEAD_COUNTED_NOTE, arrivalDay, lastTwelveMonths,
  taxYearBeside,
  type CategoryRow, type ChargeRow, type BesideItem,
} from '../lib/incomeBasis'
import '../styles/reports-basis.css'

const fmt = (n: any) => n != null && isFinite(Number(n))
  ? `${Number(n) < 0 ? '−' : ''}$${Math.abs(Number(n)).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
const fmt0 = (n: any) => n != null && isFinite(Number(n))
  ? `${Number(n) < 0 ? '−' : ''}$${Math.abs(Number(n)).toLocaleString('en-US', {maximumFractionDigits:0})}` : '—'

/** S655: payments.status as words — the shared label map (PAYMENT_STATUS_LABEL). */
const statusWords = (s: string) =>
  PAYMENT_STATUS_LABEL[s as PaymentStatus]
  ?? UNIT_STATUS_LABEL[s as keyof typeof UNIT_STATUS_LABEL]
  ?? MAINTENANCE_STATUS_LABEL[s as keyof typeof MAINTENANCE_STATUS_LABEL]
  ?? humanize(s)

// "2026-06" → "June 2026"
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  if (!y || !m) return ym
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// ── Export helpers ────────────────────────────────────────────
function downloadCsv(filename: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const esc = (v: any) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [header, ...rows].map(r => r.map(esc).join(',')).join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// Hide the app chrome + interactive controls when the browser prints / saves
// to PDF, so a landlord gets a clean statement for their accountant.
function PrintStyles() {
  return (
    <style>{`
      @media print {
        .sidebar, .topbar { display: none !important; }
        .main-content { margin-left: 0 !important; }
        .page-content { max-width: none !important; padding: 0 !important; }
        .no-print { display: none !important; }
        .card { break-inside: avoid; box-shadow: none !important; }
        .data-table { font-size: .72rem; }
        body { background: #fff !important; }
        /* S603: the T-12 is a document that leaves the building — its branding
           and watermark must survive printing, so force color rendering and
           keep the letterhead with the figures. */
        .t12-brand { break-inside: avoid; }
        .t12-watermark {
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
          color: rgba(160, 132, 60, 0.13) !important;
        }
      }
      .t12-watermark {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
        z-index: 0;
        font-size: 2.6rem;
        font-weight: 800;
        letter-spacing: .12em;
        text-transform: uppercase;
        white-space: nowrap;
        transform: rotate(-18deg);
        color: rgba(160, 132, 60, 0.10);
        user-select: none;
      }
    `}</style>
  )
}

const ToolbarBtn = ({ onClick, icon, label, disabled }: { onClick: () => void; icon: JSX.Element; label: string; disabled?: boolean }) => (
  <button className="btn btn-primary btn-sm no-print" onClick={onClick} disabled={disabled} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
    {icon}{label}
  </button>
)

// ── Period picker ─────────────────────────────────────────────
function PeriodPicker({ year, setYear, month, setMonth, allowAll }: {
  year: number; setYear: (n: number) => void
  month: number | null; setMonth?: (n: number | null) => void
  allowAll?: boolean
}) {
  const now = new Date()
  const thisYear = now.getFullYear()
  const curMonth = now.getMonth() + 1 // 1..12
  const years = [thisYear, thisYear - 1, thisYear - 2, thisYear - 3]
  // Months that haven't happened yet (current year only) can't be picked.
  const isFutureMonth = (m: number) => year === thisYear && m > curMonth

  return (
    <div className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <select className="input" value={year} onChange={e => {
        const y = parseInt(e.target.value)
        setYear(y)
        // If the selected month is now in the future for the new year, pull it back.
        if (setMonth && month && y === thisYear && month > curMonth) setMonth(curMonth)
      }} style={{ minWidth: 96 }}>
        {years.map(y => <option key={y} value={y}>{y}</option>)}
      </select>
      {setMonth && (
        <select className="input" value={month ?? 0} onChange={e => setMonth(parseInt(e.target.value) || null)} style={{ minWidth: 130 }}>
          {allowAll && <option value={0}>Full year</option>}
          {MONTHS.map((m, i) => (
            <option key={m} value={i + 1} disabled={isFutureMonth(i + 1)}>{m}</option>
          ))}
        </select>
      )}
    </div>
  )
}

// ── OVERVIEW CHARTS (MTD bar + YTD cumulative area) ───────────
// Hand-rolled SVG so there's no charting dependency and it inherits the
// gold/dark theme. Both render inline — no download or print needed.
function CollectionsCharts({ ytdMonthly, mtd, ytd, basis }: {
  ytdMonthly: { month: string; collected: number }[]
  mtd: number; ytd: number; basis: IncomeBasis
}) {
  const now = new Date()
  const year = now.getFullYear()
  const upto = now.getMonth() + 1 // 1..12, current month
  const byMonth = new Map(ytdMonthly.map(m => [m.month, m.collected]))
  const series: { m: number; label: string; collected: number; cumulative: number }[] = []
  let cum = 0
  for (let m = 1; m <= upto; m++) {
    const v = byMonth.get(`${year}-${String(m).padStart(2, '0')}`) ?? 0
    cum += v
    series.push({ m, label: MONTHS_SHORT[m - 1], collected: v, cumulative: cum })
  }
  const hasData = series.some(s => s.collected !== 0)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: 16 }}>
      <div className="card">
        <div className="card-header">
          <span className="card-title">{perMonthTitle(basis)} — {year}</span>
          <span style={{ fontSize: '.7rem', color: 'var(--gold)' }}>This month {fmt(mtd)}</span>
        </div>
        <div style={{ padding: '12px 12px 6px' }}>
          {hasData ? <BarChart series={series} current={upto} /> : <EmptyChart basis={basis} />}
        </div>
      </div>
      <div className="card">
        <div className="card-header">
          <span className="card-title">Year to date, added up — {year}</span>
          <span style={{ fontSize: '.7rem', color: 'var(--gold)' }}>This year {fmt(ytd)}</span>
        </div>
        <div style={{ padding: '12px 12px 6px' }}>
          {hasData ? <AreaChart series={series} /> : <EmptyChart basis={basis} />}
        </div>
      </div>
    </div>
  )
}

const EmptyChart = ({ basis }: { basis: IncomeBasis }) => (
  <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontSize: '.8rem' }}>
    {basis === 'billed' ? 'Nothing billed yet this year.' : 'No money received yet this year.'}
  </div>
)

// Vertical bars; current (MTD) month highlighted gold.
function BarChart({ series, current }: { series: { label: string; collected: number; m: number }[]; current: number }) {
  const W = 520, H = 200, padL = 8, padR = 8, padT = 14, padB = 22
  const chartW = W - padL - padR, chartH = H - padT - padB
  const max = Math.max(...series.map(s => s.collected), 1)
  const slot = chartW / series.length
  const bw = Math.min(slot * 0.6, 46)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Collected by month">
      <line x1={padL} y1={padT + chartH} x2={W - padR} y2={padT + chartH} stroke="var(--border-1)" strokeWidth={1} />
      {series.map((s, i) => {
        const h = (s.collected / max) * chartH
        const x = padL + i * slot + (slot - bw) / 2
        const y = padT + chartH - h
        const isCurrent = s.m === current
        return (
          <g key={s.m}>
            <title>{`${s.label}: ${fmt(s.collected)}`}</title>
            <rect x={x} y={y} width={bw} height={Math.max(h, 1)} rx={2}
              fill={isCurrent ? 'var(--gold)' : 'var(--gold-dim)'} opacity={isCurrent ? 1 : 0.65} />
            <text x={x + bw / 2} y={H - 7} textAnchor="middle" fontSize={9} fill="var(--text-3)">{s.label}</text>
          </g>
        )
      })}
    </svg>
  )
}

// Cumulative line + filled area, ending dot at the YTD total.
function AreaChart({ series }: { series: { label: string; cumulative: number; m: number }[] }) {
  const W = 520, H = 200, padL = 8, padR = 8, padT = 14, padB = 22
  const chartW = W - padL - padR, chartH = H - padT - padB
  const max = Math.max(...series.map(s => s.cumulative), 1)
  const xAt = (i: number) => series.length <= 1 ? padL + chartW / 2 : padL + (i / (series.length - 1)) * chartW
  const yAt = (v: number) => padT + chartH - (v / max) * chartH
  const pts = series.map((s, i) => `${xAt(i)},${yAt(s.cumulative)}`).join(' ')
  const area = `${padL},${padT + chartH} ${pts} ${xAt(series.length - 1)},${padT + chartH}`
  const last = series[series.length - 1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Cumulative collections year to date">
      <line x1={padL} y1={padT + chartH} x2={W - padR} y2={padT + chartH} stroke="var(--border-1)" strokeWidth={1} />
      <polygon points={area} fill="var(--gold)" opacity={0.12} />
      <polyline points={pts} fill="none" stroke="var(--gold)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {series.map((s, i) => (
        <g key={s.m}><title>{`${s.label}: ${fmt(s.cumulative)}`}</title>
          <circle cx={xAt(i)} cy={yAt(s.cumulative)} r={i === series.length - 1 ? 3.5 : 2}
            fill={i === series.length - 1 ? 'var(--gold)' : 'var(--gold-dim)'} />
        </g>
      ))}
      {series.map((s, i) => (
        <text key={'l' + s.m} x={xAt(i)} y={H - 7} textAnchor="middle" fontSize={9} fill="var(--text-3)">{s.label}</text>
      ))}
      {last && <text x={xAt(series.length - 1)} y={Math.max(yAt(last.cumulative) - 7, 10)} textAnchor="end" fontSize={9} fill="var(--gold)">{fmt(last.cumulative)}</text>}
    </svg>
  )
}

// ══════════════════════════════════════════════════════════════
// REPORTS PAGE — tabbed
// ══════════════════════════════════════════════════════════════
type Tab = 'overview' | 'property' | 'annual' | 'statement' | 'custom'
const TABS: { key: Tab; label: string; perm: string }[] = [
  { key: 'overview',  label: 'Overview',        perm: 'reports.tab.overview' },
  { key: 'property',  label: 'By Property',     perm: 'reports.tab.property' },
  { key: 'annual',    label: 'Annual & Tax',    perm: 'reports.tab.annual' },
  { key: 'statement', label: 'Owner Statement', perm: 'reports.tab.statement' },
  { key: 'custom',    label: 'Custom & T-12',   perm: 'reports.tab.custom' },
]

export function ReportsPage() {
  const [tab, setTab] = useState<Tab>('overview')
  const { can } = usePerms()
  // S655: "Money received" (the default) or "Money billed" — one switch above
  // the tabs, remembered in this browser, carried by every query below.
  const [basis, setBasis] = useIncomeBasis()

  // Staff see only report tabs they're granted; owners see all. Snap the
  // active tab to the first visible one if the current tab is hidden.
  const visibleTabs = TABS.filter(t => can(t.perm))
  const visibleTabKeys = visibleTabs.map(t => t.key).join(',')
  useEffect(() => {
    if (visibleTabs.length && !visibleTabs.some(t => t.key === tab)) setTab(visibleTabs[0].key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTabKeys])

  return (
    <div>
      <PrintStyles />
      <div className="page-header">
        <div><h1 className="page-title">Reports</h1><p className="page-subtitle">Financial, tax, and occupancy summaries</p></div>
      </div>
      <IncomeBasisToggle basis={basis} onChange={setBasis} />
      <BasisPrintNote basis={basis} />
      <div className="no-print" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-0)', marginBottom: 18, overflowX: 'auto' }}>
        {visibleTabs.map(t => (
          <button key={t.key} className={`tab-btn ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === 'overview'  && can('reports.tab.overview')  && <OverviewTab basis={basis} />}
      {tab === 'property'  && can('reports.tab.property')  && <ByPropertyTab basis={basis} />}
      {tab === 'annual'    && can('reports.tab.annual')    && <AnnualTaxTab basis={basis} />}
      {tab === 'statement' && can('reports.tab.statement') && <OwnerStatementTab basis={basis} />}
      {tab === 'custom'    && can('reports.tab.custom')    && <CustomReportTab basis={basis} />}
    </div>
  )
}

/**
 * A company document (tax summary, owner statement) asks which company when
 * the account owns several. One company is picked for you; a team login,
 * whose company the server derives, is never held waiting for a choice it
 * cannot make (the old `enabled: !!companyId` left it on an empty page).
 */
function useCompanyReady(companyId: string): { ready: boolean; mustChoose: boolean } {
  const { data: entities, isFetched, isError } = useEntities()
  const settled = isFetched || isError
  const count = entities?.length ?? 0
  return { ready: !!companyId || (settled && count < 2), mustChoose: settled && count >= 2 && !companyId }
}

const ChooseCompany = ({ what }: { what: string }) => (
  <div className="card" style={{ padding: 18, color: 'var(--text-2)', fontSize: '.84rem' }}>
    Choose a company above to see its {what}.
  </div>
)

/**
 * A report that could not load says why, once, in the server's own words —
 * with "try again" only when trying again can help (lib reportErrorText).
 */
function ReportError({ error, what }: { error: unknown; what: string }) {
  return <div className="alert alert-warn" style={{ margin: 12, fontSize: '.82rem' }}>{reportErrorText(error, what)}</div>
}

// ── OVERVIEW (S69 + S512 #20 drill-in) ────────────────────────
function OverviewTab({ basis }: { basis: IncomeBasis }) {
  const { data: report, isLoading, error } = useQuery<any>(['reports', basis], () => apiGet(withBasis('/reports/summary', basis)))
  const [openMonth, setOpenMonth] = useState<string | null>(null)
  const navigate = useNavigate()
  // S655 (§2): the income card, the same one the dashboard shows. Money
  // received: what arrived this month, money paid ahead inside it, money still
  // clearing beside it. Money billed: this month's bills and what became of them.
  const card = incomeCardView(report?.incomeCard, basis, 'this month', fmt)
  const word = basisLabel(basis)

  return (
    <>
      {error ? <ReportError error={error} what="the summary" /> : isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
        <div className="rb-stack" style={{gap:16}}>
          <div className="rb-kpis">
            <div className="kpi-card">
              <div className="kpi-label">{card.label}</div>
              <div className="kpi-value green">{fmt0(card.amount)}</div>
              <div className="kpi-sub rb-kpi-notes">{card.notes.map(n => <span key={n}>{n}</span>)}</div>
            </div>
            <div className="kpi-card"><div className="kpi-label">{word} this year</div><div className="kpi-value" style={{color:'var(--gold)'}}>{fmt0(report?.ytdCollected)}</div></div>
            {/* S527 W-38: click through to the who-owes-what list (same target as the dashboard KPI). */}
            {/* Decision #25: a grand total of what everyone owes is for owners and
                property managers only; when the server leaves it out, so does the card. */}
            {report?.outstanding != null && (
              <div className="kpi-card" style={{cursor:'pointer'}} onClick={()=>navigate('/balances')}><div className="kpi-label">Outstanding Balance</div><div className="kpi-value" style={{color:'var(--amber)'}}>{fmt0(report.outstanding)}</div></div>
            )}
            <div className="kpi-card"><div className="kpi-label">Occupancy Rate</div><div className="kpi-value">{report?.occupancyRate != null ? `${report.occupancyRate}%` : '—'}</div></div>
          </div>
          <CollectionsCharts basis={basis} ytdMonthly={report?.ytdMonthly ?? []} mtd={Number(card.amount || 0)} ytd={Number(report?.ytdCollected || 0)} />
          <div className="card">
            <div className="card-header"><span className="card-title">Monthly Breakdown</span></div>
            <div style={{padding:'4px 0 16px'}}>
              <div style={{fontSize:'.72rem',color:'var(--text-3)',padding:'0 0 10px'}}>Click a month to open its profit &amp; loss and the money behind it.</div>
              <div className="data-table-wrap">
                <table className="data-table">
                  {/* "Net" IS the net of the P&L the row opens (the month's income less
                      GAM's platform fee, maintenance, lot rent and entered expenses).
                      "Payout fees" are the payout run's own fees, shown for reference. */}
                  <thead><tr><th>Month</th><th>{word}</th><th>Disbursed</th><th>Payout fees</th><th>Net</th><th></th></tr></thead>
                  <tbody>
                    {report?.monthly?.length ? report.monthly.map((m: any) => (
                      <tr key={m.month}
                          onClick={() => setOpenMonth(m.month)}
                          style={{cursor:'pointer'}}
                          title={`Open ${monthLabel(m.month)} P&L`}>
                        <td className="mono" style={{color:'var(--gold)',fontWeight:600}}>{monthLabel(m.month)}</td>
                        <td className="mono" style={{color:'var(--green)'}}>{fmt(m.collected)}</td>
                        <td className="mono">{fmt(m.disbursed)}</td>
                        <td className="mono" style={{color:'var(--text-3)'}}>{fmt(m.fees)}</td>
                        <td className="mono" style={{color: m.net != null && m.net < 0 ? 'var(--red, #e06666)' : 'var(--text-0)',fontWeight:600}}>{fmt(m.net)}</td>
                        <td style={{color:'var(--text-3)',textAlign:'right'}}>›</td>
                      </tr>
                    )) : (
                      <tr><td colSpan={6} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No report data yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
      {openMonth && <MonthlyPLModal month={openMonth} basis={basis} onClose={() => setOpenMonth(null)} />}
    </>
  )
}

// ── BY PROPERTY (per-property P&L) ────────────────────────────
function ByPropertyTab({ basis }: { basis: IncomeBasis }) {
  const now = new Date()
  const [year, setYear]   = useState(now.getFullYear())
  // ── S637: DEFAULT TO THIS MONTH, LIKE EVERY OTHER REPORT ────────────
  //
  // Nic: "we're showing platform fees that don't match the occupied total.
  // We're showing a twenty dollar flat platform fee for three occupied units
  // for Oak Park... it would be six dollars, but our minimum property amount
  // is ten dollars, so it should be showing ten dollars."
  //
  // The arithmetic was right. This tab alone opened on the FULL YEAR, so the
  // platform fee was a running total — Oak Park's \$20 is August's \$10 floor
  // plus September's \$10, and Mountain View's \$26 is \$10 + \$16. Read as a
  // current charge, both look inflated, and "Platform Fee" reads as a charge.
  //
  // The card header did say "Full year", but the owner statement and every
  // other tab open on the current month, so this one was the surprise. Full
  // year is still one click away in the picker.
  const [month, setMonth] = useState<number | null>(now.getMonth() + 1)
  const [openProp, setOpenProp] = useState<{ id: string; name: string } | null>(null)
  const { can } = usePerms()
  const qs = `year=${year}${month ? `&month=${month}` : ''}`
  const { data, isLoading, error } = useQuery<any>(['property-pl', year, month, basis],
    () => apiGet(withBasis(`/reports/property-pl?${qs}`, basis)))
  const props: any[] = data?.properties ?? []
  const word = basisLabel(basis)

  // S655: each row is income − platform fee − maintenance − lot rent − your
  // expenses = net (the drill-in's net, line for line). Lot rent and entered
  // expenses had no column, so a row with either did not add up on screen.
  const otherCosts = (p: any) => Number(p.lotRent || 0) + Number(p.enteredExpenses || 0)
  const income = (p: any) => Number(p.incomeTotal ?? p.rentCollected ?? 0)
  const totals = props.reduce((t, p) => ({
    income: t.income + income(p),
    maint: t.maint + Number(p.maintCost || 0),
    plat: t.plat + Number(p.platformFees || 0),
    other: t.other + otherCosts(p),
    net: t.net + Number(p.netIncome || 0),
  }), { income: 0, maint: 0, plat: 0, other: 0, net: 0 })

  const periodLabel = month ? `${MONTHS[month - 1]} ${year}` : `Full year ${year}`

  const exportCsv = () => downloadCsv(
    `property-pl-${basis}-${year}${month ? `-${String(month).padStart(2,'0')}` : ''}.csv`,
    ['Property', 'Occupied', 'Total units', 'Occupancy %', word, 'Maintenance', 'Platform fee', 'Lot rent and your expenses', 'Net income'],
    props.map(p => [p.name, p.occupiedUnits, p.totalUnits, p.occupancyRate,
      income(p).toFixed(2), Number(p.maintCost||0).toFixed(2),
      Number(p.platformFees||0).toFixed(2), otherCosts(p).toFixed(2), Number(p.netIncome||0).toFixed(2)]),
  )
  const minus = (n: number) => n > 0 ? `−${fmt(n)}` : fmt(n)

  return (
    <div className="rb-stack">
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <PeriodPicker year={year} setYear={setYear} month={month} setMonth={setMonth} allowAll />
        {can('reports.export') && (
          <div style={{ display: 'flex', gap: 6 }}>
            <ToolbarBtn onClick={exportCsv} icon={<Download size={14} />} label="CSV" />
            <ToolbarBtn onClick={() => window.print()} icon={<Printer size={14} />} label="Print" />
          </div>
        )}
      </div>
      <div className="card">
        <div className="card-header">
          <span className="card-title">Per-Property P&amp;L — {periodLabel}</span>
          <span className="no-print" style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>Click a property for income by category, expenses and net.</span>
        </div>
        <div style={{ padding: '4px 0 12px' }}>
          {error ? <ReportError error={error} what="the property report" /> : isLoading ? <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div> : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr>
                  <th>Property</th><th style={{textAlign:'center'}}>Occ / Total</th><th style={{textAlign:'center'}}>Occ %</th>
                  <th className="rb-num">{word}</th><th className="rb-num">Maint.</th><th className="rb-num">Platform Fee</th>
                  <th className="rb-num">Lot rent &amp; your expenses</th><th className="rb-num">Net</th><th></th>
                </tr></thead>
                <tbody>
                  {props.length ? props.map((p: any) => (
                    <tr key={p.id} onClick={() => setOpenProp({ id: p.id, name: p.name })}
                        style={{ cursor: 'pointer' }} title={`Open ${p.name} detail`}>
                      <td style={{ color: 'var(--text-0)', fontWeight: 600 }}>{p.name}</td>
                      <td className="mono" style={{ textAlign: 'center' }}>{p.occupiedUnits}/{p.totalUnits}</td>
                      <td className="mono" style={{ textAlign: 'center' }}>{p.occupancyRate}%</td>
                      <td className="rb-num" style={{ color: 'var(--green)' }}>{fmt(income(p))}</td>
                      <td className="rb-num" style={{ color: Number(p.maintCost) > 0 ? 'var(--red)' : 'var(--text-3)' }}>{minus(Number(p.maintCost || 0))}</td>
                      <td className="rb-num" style={{ color: Number(p.platformFees) > 0 ? 'var(--red)' : 'var(--text-3)' }}>{minus(Number(p.platformFees || 0))}</td>
                      <td className="rb-num" style={{ color: otherCosts(p) > 0 ? 'var(--red)' : 'var(--text-3)' }}>{minus(otherCosts(p))}</td>
                      <td className="rb-num" style={{ color: Number(p.netIncome) >= 0 ? 'var(--gold)' : 'var(--red)', fontWeight: 600 }}>{fmt(p.netIncome)}</td>
                      <td style={{ color: 'var(--text-3)', textAlign: 'right' }}>›</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>No properties yet.</td></tr>
                  )}
                </tbody>
                {props.length > 0 && (
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--border-1)' }}>
                      <td style={{ fontWeight: 700, color: 'var(--text-0)' }}>Total</td>
                      <td></td><td></td>
                      <td className="rb-num" style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(totals.income)}</td>
                      <td className="rb-num" style={{ color: totals.maint > 0 ? 'var(--red)' : 'var(--text-3)', fontWeight: 700 }}>{minus(totals.maint)}</td>
                      <td className="rb-num" style={{ color: totals.plat > 0 ? 'var(--red)' : 'var(--text-3)', fontWeight: 700 }}>{minus(totals.plat)}</td>
                      <td className="rb-num" style={{ color: totals.other > 0 ? 'var(--red)' : 'var(--text-3)', fontWeight: 700 }}>{minus(totals.other)}</td>
                      <td className="rb-num" style={{ color: totals.net >= 0 ? 'var(--gold)' : 'var(--red)', fontWeight: 700 }}>{fmt(totals.net)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </div>
      </div>
      <SiteDowntimeCard year={year} month={month} periodLabel={periodLabel} />
      {openProp && <PropertyDetailModal propertyId={openProp.id} name={openProp.name} year={year} month={month} basis={basis} onClose={() => setOpenProp(null)} />}
    </div>
  )
}

// S652 (Nic): "our average RV sites, when they go down, they're down for a day
// or 10 days or whatever. Just another fancy little metric to have in a
// reporting category somewhere." Finished outages in the period, by property
// and kind of space. Hidden until a site has ever been marked out of order.
function SiteDowntimeCard({ year, month, periodLabel }: { year: number; month: number | null; periodLabel: string }) {
  const qs = `year=${year}${month ? `&month=${month}` : ''}`
  const { data } = useQuery<any>(['site-downtime', year, month], () => apiGet(`/reports/site-downtime?${qs}`))
  const rows: any[] = data?.rows ?? []
  if (!rows.length) return null
  const days = (n: any) => n == null ? '—' : Number(n) < 1 ? 'under a day' : `${n} day${Number(n) === 1 ? '' : 's'}`
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Site downtime — {periodLabel}</span>
        <span className="no-print" style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>Outages that ended in this period. Out now is as of today.</span>
      </div>
      <div style={{ padding: '4px 0 12px' }} className="data-table-wrap">
        <table className="data-table">
          <thead><tr>
            <th>Property</th><th>Kind of space</th>
            <th style={{ textAlign: 'center' }}>Outages finished</th>
            <th style={{ textAlign: 'center' }}>Average time down</th>
            <th style={{ textAlign: 'center' }}>Longest</th>
            <th style={{ textAlign: 'center' }}>Out right now</th>
            <th style={{ textAlign: 'center' }}>Longest still out</th>
          </tr></thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={`${r.propertyId}-${r.unitType}`}>
                <td style={{ color: 'var(--text-0)', fontWeight: 600 }}>{r.propertyName}</td>
                <td>{(UNIT_TYPE_LABEL as Record<string, string>)[r.unitType] ?? humanize(r.unitType)}</td>
                <td className="mono" style={{ textAlign: 'center' }}>{r.finished}</td>
                <td className="mono" style={{ textAlign: 'center' }}>{r.finished ? days(r.avgDays) : '—'}</td>
                <td className="mono" style={{ textAlign: 'center' }}>{r.finished ? days(r.longestDays) : '—'}</td>
                <td className="mono" style={{ textAlign: 'center', color: r.outNow > 0 ? 'var(--red)' : 'var(--text-3)' }}>{r.outNow}</td>
                <td className="mono" style={{ textAlign: 'center' }}>{r.outNow > 0 ? days(r.longestOpenDays) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── PROPERTY DETAIL DRILL-IN MODAL ────────────────────────────
// S655, decision #4 (Nic): "here's the total collected... I want to see how
// much electric was billed back, property-wide... the distinction between lot
// rent collected, late fees, trailer payments, etc." The drill-in LEADS with
// the breakdown: income by category (billed vs collected, under the switch),
// then expenses as line items, then net. The rent roll, payments and
// maintenance lists come after, collapsed ("way too long").
function PropertyDetailModal({ propertyId, name, year, month, basis, onClose }: {
  propertyId: string; name: string; year: number; month: number | null; basis: IncomeBasis; onClose: () => void
}) {
  const qs = `propertyId=${propertyId}&year=${year}${month ? `&month=${month}` : ''}`
  const { data, isLoading, error } = useQuery<any>(['property-detail', propertyId, year, month, basis],
    () => apiGet(withBasis(`/reports/property-detail?${qs}`, basis)))
  const periodLabel = month ? `${MONTHS[month - 1]} ${year}` : `Full year ${year}`
  const word = basisLabel(basis)

  // Zero-filled 12-month trend for the mini bar chart; highlight selected month.
  const byMonth = new Map<string, number>((data?.monthlyTrend ?? []).map((t: any) => [t.month, t.collected]))
  const trend = Array.from({ length: 12 }, (_, i) => ({
    m: i + 1, label: MONTHS_SHORT[i],
    collected: byMonth.get(`${year}-${String(i + 1).padStart(2, '0')}`) ?? 0,
  }))
  const hasTrend = trend.some(t => t.collected !== 0)
  const units: any[] = data?.units ?? []
  const payments: any[] = data?.payments ?? []
  const maintenance: any[] = data?.maintenance ?? []
  const expenses = data?.expenses
  const breakdown = data?.breakdown

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal rb-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="modal-title" style={{ marginBottom: 2 }}>{name}</div>
            <div style={{ fontSize: '.74rem', color: 'var(--text-3)' }}>
              {periodLabel}
              {data?.property ? ` · ${data.property.city}, ${data.property.state} · ${data.property.occupiedUnits}/${data.property.totalUnits} occupied (${data.property.occupancyRate}%)` : ''}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }} aria-label="Close"><X size={15} /></button>
        </div>

        <div className="rb-modal-body">
          {error ? <ReportError error={error} what="this property" /> : isLoading || !data ? (
            <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
          ) : (
            <>
              {/* 1. Income by category, billed vs collected, under the switch. */}
              <CategoryBreakdownCard
                basis={basis}
                title={`Income by category — ${periodLabel}`}
                categories={breakdown?.categories ?? []}
                lines={breakdown?.lines ?? []}
                total={Number(breakdown?.total ?? 0)}
              />

              {/* 2. Expenses as line items. */}
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-header"><span className="card-title">Expenses — {periodLabel}</span></div>
                {expenseLines(expenses).map(l => <PnLLine key={l.key} label={l.label} value={l.amount} kind="expense" />)}
                <PnLLine label="Total expenses" value={Number(expenses?.total || 0)} kind="total-out" />
              </div>

              {/* 3. Net. */}
              <div className="card" style={{ marginBottom: 14 }}>
                <PnLLine label={`${word} (income)`} value={Number(breakdown?.total || 0)} kind="total-in" />
                <PnLLine label="Expenses" value={Number(expenses?.total || 0)} kind="total-out" />
                <PnLLine label="Net" value={Number(data.net || 0)} kind="net" />
                {Number(data.summary?.depositsHeld) > 0 && (
                  <div className="rb-small-note">
                    Deposits received in this period (held for tenants, never income): {fmt(data.summary.depositsHeld)}
                  </div>
                )}
              </div>

              {hasTrend && (
                <div className="card" style={{ marginBottom: 14 }}>
                  <div className="card-header"><span className="card-title">{perMonthTitle(basis)} — {year}</span></div>
                  <div style={{ padding: '10px 12px 4px' }}><BarChart series={trend} current={month ?? -1} /></div>
                </div>
              )}

              {/* The lists, after the breakdown and collapsed. */}
              <details className="rb-collapse">
                <summary>Rent roll ({units.length} {units.length === 1 ? 'unit' : 'units'})</summary>
                <div className="rb-collapse-body data-table-wrap">
                  <table className="data-table">
                    <thead><tr><th>Unit</th><th>Bed/Bath</th><th>Status</th><th className="rb-num">Rent</th><th>Tenant</th></tr></thead>
                    <tbody>
                      {units.length ? units.map(u => (
                        <tr key={u.id}>
                          <td style={{ color: 'var(--text-0)', fontWeight: 600 }}>#{u.unitNumber}</td>
                          <td className="mono" style={{ color: 'var(--text-3)' }}>{u.bedrooms}/{u.bathrooms}</td>
                          <td><StatusPill status={u.status} /></td>
                          <td className="rb-num">{fmt(u.rent)}</td>
                          <td style={{ color: u.isOccupied ? 'var(--text-2)' : 'var(--text-3)' }}>{u.tenantName || (u.isOccupied ? 'Occupied' : 'Vacant')}</td>
                        </tr>
                      )) : <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 20 }}>No units.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </details>

              <details className="rb-collapse">
                <summary>{basis === 'billed' ? 'Bills' : 'Payments'} behind the total ({payments.length})</summary>
                <div className="rb-collapse-body data-table-wrap">
                  <ChargesTable rows={payments} basis={basis} emptyText={`Nothing in ${periodLabel}.`} />
                </div>
              </details>

              <details className="rb-collapse">
                <summary>Maintenance ({maintenance.length})</summary>
                <div className="rb-collapse-body data-table-wrap">
                  <table className="data-table">
                    <thead><tr><th>Unit</th><th>Description</th><th className="rb-num">Cost</th></tr></thead>
                    <tbody>
                      {maintenance.length ? maintenance.map(m => (
                        <tr key={m.id}>
                          <td className="mono">{m.unitNumber ? `#${m.unitNumber}` : '—'}</td>
                          <td style={{ color: 'var(--text-2)' }}>{m.title || '—'}</td>
                          <td className="rb-num">{fmt(m.actualCost)}</td>
                        </tr>
                      )) : <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 20 }}>No maintenance in {periodLabel}.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          )}
        </div>

        <div className="modal-footer" style={{ marginTop: 12, flexShrink: 0 }}>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

/**
 * Decision #4: income by category, billed vs collected. Money received: what
 * was billed in the period and what arrived in it; the total is what arrived,
 * plus money with no category (money paid ahead, deposit deductions, ...).
 * Money billed: each bill and what became of it; the total is what was billed.
 */
function CategoryBreakdownCard({ basis, title, categories, lines, total }: {
  basis: IncomeBasis; title: string
  categories: CategoryRow[]; lines: Array<{ line: string; label: string; amount: number }>; total: number
}) {
  const rows = activeCategories(categories)
  const cols = categoryColumns(basis)
  // The column that adds up to the total under the switch.
  const totalKey = basis === 'billed' ? 'billed' : 'collected'
  const colSum = (k: string) => sumAmounts(rows.map(r => ({ amount: Number((r as any)[k] || 0) })))
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-header"><span className="card-title">{title}</span></div>
      {rows.length === 0 && lines.length === 0 ? (
        <div style={{ padding: 16, color: 'var(--text-3)', fontSize: '.82rem', textAlign: 'center' }}>
          {basis === 'billed' ? 'Nothing was billed in this period.' : 'No money arrived in this period.'}
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table rb-cat-table">
            <thead><tr>
              <th>Category</th>
              {cols.map(c => <th key={c.key} className="rb-num">{c.label}</th>)}
            </tr></thead>
            <tbody>
              {/* data-label: on a phone each row stacks, every figure named. */}
              {rows.map(r => (
                <tr key={r.category}>
                  <td className="rb-cat-name">{categoryLabel(r)}</td>
                  {cols.map(c => (
                    <td key={c.key} data-label={c.label} className="rb-num" style={c.key === totalKey ? { color: 'var(--text-0)', fontWeight: 600 } : undefined}>
                      {fmt((r as any)[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
              {lines.map(l => (
                <tr key={l.line} className="rb-cat-lines">
                  <td>{l.label}</td>
                  {cols.map(c => (
                    <td key={c.key} data-label={c.label} className={`rb-num${c.key === totalKey ? '' : ' rb-cat-blank'}`}>{c.key === totalKey ? fmt(l.amount) : '—'}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                {cols.map(c => (
                  <td key={c.key} data-label={c.label} className="rb-num">
                    {c.key === totalKey ? fmt(total) : fmt(colSum(c.key))}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}

/**
 * The charges behind a total. Money received: each charge's own new money on
 * the day it arrived. Money billed: each bill due in the period, with what
 * became of it.
 */
function ChargesTable({ rows, basis, emptyText }: { rows: any[]; basis: IncomeBasis; emptyText: string }) {
  return (
    <table className="data-table">
      <thead><tr>
        <th>{basis === 'billed' ? 'Due' : 'Day'}</th><th>Unit</th><th>Tenant</th><th>For</th><th>Status</th>
        <th className="rb-num">{basis === 'billed' ? 'Billed' : 'Received'}</th>
      </tr></thead>
      <tbody>
        {rows.length ? rows.map(p => (
          <tr key={chargeKey(p)}>
            {/* The day the entry counted (the property's calendar): a dispute of
                an earlier payment sits on the day the money was taken back. */}
            <td className="mono rb-nowrap" style={{ color: 'var(--text-3)' }}>
              {usDay(chargeDay(p, basis))}
              {basis === 'received' && Number(p.amount) < 0 && (
                <div className="rb-taken-back">money taken back</div>
              )}
            </td>
            <td className="mono">{p.unitNumber ? `#${p.unitNumber}` : '—'}</td>
            <td style={{ color: 'var(--text-2)' }}>{p.tenantName || '—'}</td>
            <td style={{ color: 'var(--text-3)' }}>{p.categoryLabel || humanize(p.type)}</td>
            <td>
              <StatusPill status={p.status} />
              {basis === 'billed' && partsText(p.parts, fmt) && (
                <div style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>{partsText(p.parts, fmt)}</div>
              )}
            </td>
            <td className="rb-num" style={{ color: 'var(--text-0)' }}>
              {fmt(p.amount)}
              {Number(p.creditGiven) > 0 && (
                <div style={{ fontSize: '.66rem', color: 'var(--text-3)' }}>credit you gave {fmt(p.creditGiven)}</div>
              )}
            </td>
          </tr>
        )) : <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 20 }}>{emptyText}</td></tr>}
      </tbody>
    </table>
  )
}

// ── ANNUAL & TAX (tax-summary + work-trade 1099) ──────────────
// S655: the total IS the year's P&L under the switch, the deductions are the
// P&L's expenses line for line, and the net is its net. The money paid ahead
// and not used is shown next to the total, named by the server: "Paid ahead
// for next year's bills" once the year is over, "Paid ahead, not used yet"
// while the year is still running. Under Money received it counted on the day
// it arrived ($0 again when it pays them), so it is never called "not in" the
// total; under Money billed it is outside the total.
function AnnualTaxTab({ basis }: { basis: IncomeBasis }) {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const { can } = usePerms()
  // S633: a TAX document belongs to one company. Analytical rollups elsewhere on
  // this page span the whole account; these two cannot, because summing two LLCs
  // into one return is wrong on its face. Single-company accounts see no picker.
  const [companyId, setCompanyId] = useState<string>('')
  const q = companyId ? `&landlordId=${companyId}` : ''
  const { ready, mustChoose } = useCompanyReady(companyId)
  const { data: tax, isLoading, error } = useQuery<any>(['tax-summary', year, companyId, basis],
    () => apiGet(withBasis(`/reports/tax-summary?year=${year}${q}`, basis)), { enabled: ready })
  const { data: wt } = useQuery<any>(['wt-1099', year, companyId],
    () => apiGet(`/reports/work-trade-1099?year=${year}${q}`), { enabled: ready })

  const monthly: any[] = tax?.monthlyBreakdown ?? []
  const eligible: any[] = wt?.eligible ?? []
  const word = basisLabel(basis)
  const incomeLines: Array<{ line: string; label: string; amount: number }> = tax?.income?.lines ?? []
  const d = tax?.deductions
  const deductions = expenseLines(d ? {
    platformFee: Number(d.platformFees || 0), maintenance: Number(d.maintExpenses || 0),
    lotRent: Number(d.lotRent || 0), enteredExpenses: Number(d.enteredExpenses || 0),
  } : null)
  const paidAheadNext = Number(tax?.paidAheadNextYear?.amount || 0)
  // Money received: the paid-ahead money on hand at year end counted on the
  // day it arrived, so it sits on its own line — never in the "not in them"
  // box (§0.0, Todd). Money billed: it and work trade are both outside.
  const yearBeside = taxYearBeside(tax?.paidAheadNextYear, d?.workTradeValue, basis)

  return (
    <div className="rb-stack">
      <div className="no-print">
        <EntityPicker value={companyId} onChange={setCompanyId}
          note="A tax statement belongs to one company — each LLC files its own return." />
      </div>
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <PeriodPicker year={year} setYear={setYear} month={null} />
        {can('reports.export') && (
          <ToolbarBtn onClick={() => window.print()} icon={<Printer size={14} />} label="Print" />
        )}
      </div>

      {mustChoose ? <ChooseCompany what="tax summary" /> : error ? <ReportError error={error} what="the tax summary" /> : (isLoading || !tax) ? <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div> : (
        <>
          <div className="rb-kpis">
            <div className="kpi-card">
              <div className="kpi-label">{word} {year}</div>
              <div className="kpi-value green">{fmt0(tax?.income?.totalRent)}</div>
              {paidAheadNext > 0 && (
                <div className="kpi-sub">
                  {tax?.paidAheadNextYear?.label || 'Paid ahead, not used yet'} {fmt0(paidAheadNext)}
                  {basis === 'billed' ? ' — not in this total' : ' — counted when it arrived'}
                </div>
              )}
            </div>
            <div className="kpi-card"><div className="kpi-label">Net Income</div><div className="kpi-value" style={{ color: 'var(--gold)' }}>{fmt0(tax?.netIncome)}</div></div>
            <div className="kpi-card"><div className="kpi-label">Deposits Held</div><div className="kpi-value">{fmt0(tax?.deposits?.totalHeld)}</div><div className="kpi-sub">tenants' money, never income</div></div>
            <div className="kpi-card"><div className="kpi-label">{basis === 'billed' ? 'Bills counted' : 'Payments counted'}</div><div className="kpi-value">{tax?.income?.paymentCount ?? 0}</div></div>
          </div>

          <div className="card">
            <div className="card-header"><span className="card-title">Income, deductions and net — {year}</span></div>
            <div style={{ padding: '2px 6px 12px' }}>
              <div className="rb-heading">Income ({word})</div>
              {incomeLines.map(l => <PnLLine key={l.line} label={l.label} value={l.amount} kind="income" />)}
              <PnLLine label="Total income" value={Number(tax?.income?.totalRent || 0)} kind="total-in" />
              <PaidAheadOnHand item={yearBeside.onHand} />
              <div className="rb-heading">Deductions (estimated)</div>
              {deductions.map(l => <PnLLine key={l.key} label={l.label} value={l.amount} kind="expense" />)}
              <PnLLine label="Total deductions" value={sumAmounts(deductions)} kind="total-out" />
              <PnLLine label="Net income" value={Number(tax?.netIncome || 0)} kind="net" />
              {yearBeside.notIn.length > 0 && (
                <div className="rb-beside">
                  <div className="rb-beside-title">Beside the totals, not in them</div>
                  {yearBeside.notIn.map(i => (
                    <div key={i.key} className="rb-beside-row"><span>{i.label}</span><span className="rb-line-amount">{fmt(i.amount)}</span></div>
                  ))}
                </div>
              )}
              <div className="rb-small-note">
                Estimates for planning only — not tax advice. GAM does not file on your behalf. Confirm with your tax professional.
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header"><span className="card-title">{perMonthTitle(basis)} — {year}</span></div>
            <div style={{ padding: '4px 0 12px' }} className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>Month</th><th className="rb-num">{word}</th><th style={{textAlign:'center'}}>{basis === 'billed' ? 'Bills' : 'Payments'}</th><th style={{textAlign:'center'}}>Failed</th></tr></thead>
                <tbody>
                  {monthly.length ? monthly.map((m: any) => (
                    <tr key={m.month}>
                      <td style={{ color: 'var(--text-1)' }}>{MONTHS[(Number(m.month) || 1) - 1]}</td>
                      <td className="rb-num" style={{ color: 'var(--green)' }}>{fmt(m.collected)}</td>
                      <td className="mono" style={{ textAlign: 'center' }}>{m.paid}</td>
                      <td className="mono" style={{ textAlign: 'center', color: Number(m.failed) > 0 ? 'var(--red)' : 'var(--text-3)' }}>{m.failed}</td>
                    </tr>
                  )) : <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>Nothing in {year}.</td></tr>}
                </tbody>
                {monthly.length > 0 && (
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--border-1)' }}>
                      <td style={{ fontWeight: 700, color: 'var(--text-0)' }}>Year</td>
                      <td className="rb-num" style={{ fontWeight: 700, color: 'var(--green)' }}>{fmt(sumAmounts(monthly.map((m: any) => ({ amount: Number(m.collected || 0) }))))}</td>
                      <td></td><td></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Work-Trade 1099 — {year}</span>
              <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{wt?.summary?.eligible1099Count ?? 0} at / over $600</span>
            </div>
            <div style={{ padding: '4px 0 12px' }}>
              <div style={{ fontSize: '.68rem', color: 'var(--text-3)', padding: '0 4px 8px' }}>
                Tenants whose bartered work-trade value reaches the $600 1099-NEC reporting threshold. Informational — GAM does not issue 1099s.
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead><tr><th>Tenant</th><th>Property / Unit</th><th>Email</th><th className="rb-num">Value</th></tr></thead>
                  <tbody>
                    {eligible.length ? eligible.map((a: any) => (
                      <tr key={a.id}>
                        <td style={{ color: 'var(--text-0)' }}>{[a.tenantFirst, a.tenantLast].filter(Boolean).join(' ') || '—'}</td>
                        <td style={{ color: 'var(--text-2)' }}>{a.propertyName}{a.unitNumber ? ` · #${a.unitNumber}` : ''}</td>
                        <td style={{ color: 'var(--text-3)' }}>{a.tenantEmail || '—'}</td>
                        <td className="rb-num" style={{ color: 'var(--gold)', fontWeight: 600 }}>{fmt(a.creditValue)}</td>
                      </tr>
                    )) : <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>No 1099-eligible work trade in {year}.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── OWNER STATEMENT (monthly-statement) ───────────────────────
function OwnerStatementTab({ basis }: { basis: IncomeBasis }) {
  const now = new Date()
  const [year, setYear]   = useState(now.getFullYear())
  const [month, setMonth] = useState<number | null>(now.getMonth() + 1)
  const { can } = usePerms()
  // S633: an owner statement is one company's statement — it prints that
  // company's name at the top.
  const [companyId, setCompanyId] = useState<string>('')
  const { ready, mustChoose } = useCompanyReady(companyId)
  const { data, isLoading, error } = useQuery<any>(['monthly-statement', year, month, companyId, basis],
    () => apiGet(withBasis(`/reports/monthly-statement?year=${year}&month=${month}` + (companyId ? `&landlordId=${companyId}` : ''), basis)),
    { enabled: ready })

  const s = data?.summary
  const payments: any[] = data?.payments ?? []
  const maintenance: any[] = data?.maintenance ?? []
  const landlord = data?.landlord
  const ym = `${year}-${String(month).padStart(2, '0')}`
  const remainder = noChargeRemainder(Number(s?.totalIncome || 0), Number(data?.rowsTotal || 0))

  const exportPaymentsCsv = () => downloadCsv(
    `owner-statement-${basis}-${ym}.csv`,
    ['Counted on', 'Date due', 'Money arrived', 'Property', 'Unit', 'Tenant', 'For', 'Status',
     basis === 'billed' ? 'Billed' : 'Received', ...(basis === 'billed' ? ['What became of it'] : [])],
    payments.map(p => [
      chargeDay(p, basis), (p.dueDate || '').slice(0, 10), arrivalDay(p, basis), p.propertyName, p.unitNumber,
      [p.tenantFirst, p.tenantLast].filter(Boolean).join(' '),
      p.categoryLabel || humanize(p.type), statusWords(p.status), Number(p.amount || 0).toFixed(2),
      ...(basis === 'billed' ? [partsText(p.parts, fmt)] : []),
    ]),
  )

  return (
    <div className="rb-stack">
      <div className="no-print">
        <EntityPicker value={companyId} onChange={setCompanyId}
          note="An owner statement is one company's statement — it prints that company's name." />
      </div>
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <PeriodPicker year={year} setYear={setYear} month={month} setMonth={m => setMonth(m ?? 1)} />
        {can('reports.export') && (
          <div style={{ display: 'flex', gap: 6 }}>
            <ToolbarBtn onClick={exportPaymentsCsv} icon={<Download size={14} />} label="CSV" />
            <ToolbarBtn onClick={() => window.print()} icon={<Printer size={14} />} label="Print" />
          </div>
        )}
      </div>

      {mustChoose ? <ChooseCompany what="owner statement" /> : error ? <ReportError error={error} what="the owner statement" /> : (isLoading || !data) ? <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div> : (
        <>
          <div className="card">
            <div style={{ padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', color: 'var(--text-0)', fontWeight: 700 }}>Owner Statement</div>
                <div style={{ fontSize: '.8rem', color: 'var(--text-2)', marginTop: 2 }}>
                  {landlord ? `${landlord.firstName ?? ''} ${landlord.lastName ?? ''}`.trim() : ''}{landlord?.email ? ` · ${landlord.email}` : ''}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '.72rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Period</div>
                <div style={{ fontSize: '.9rem', color: 'var(--gold)', fontWeight: 600 }}>{monthLabel(ym)}</div>
                <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{basisLabel(basis)}</div>
              </div>
            </div>
          </div>

          <PnLStatement s={s} lines={data?.lines ?? []} beside={data?.beside ?? []} periodLabel={monthLabel(ym)} basis={basis} />

          <div className="card">
            <div className="card-header">
              <span className="card-title">{basis === 'billed' ? 'Bills behind the total' : 'Payments behind the total'}</span>
              <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>
                {s?.settledPayments ?? 0} paid · {s?.latePayments ?? 0} late · {s?.failedPayments ?? 0} failed
              </span>
            </div>
            <div style={{ padding: '4px 0 12px' }} className="data-table-wrap">
              <ChargesTable rows={payments} basis={basis} emptyText={`Nothing in ${monthLabel(ym)}.`} />
              {payments.length > 0 && (
                <div className="rb-small-note">
                  These add up to {fmt(data?.rowsTotal)}.
                  {Math.abs(remainder) >= 0.01 && ` The other ${fmt(remainder)} of the total has no single charge behind it (money paid ahead, register sales and stays, other income, move-out lines).`}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-header"><span className="card-title">Maintenance</span></div>
            <div style={{ padding: '4px 0 12px' }} className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>Property / Unit</th><th>Description</th><th className="rb-num">Cost</th></tr></thead>
                <tbody>
                  {maintenance.length ? maintenance.map((m: any) => (
                    <tr key={m.id}>
                      <td style={{ color: 'var(--text-1)' }}>{m.propertyName}{m.unitNumber ? ` · #${m.unitNumber}` : ''}</td>
                      <td style={{ color: 'var(--text-2)' }}>{m.title || m.description || '—'}</td>
                      <td className="rb-num">{fmt(m.actualCost)}</td>
                    </tr>
                  )) : <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>No maintenance in {monthLabel(ym)}.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    settled: 'var(--green)', late: 'var(--amber)', failed: 'var(--red)', returned: 'var(--red)',
    pending: 'var(--text-3)', partial: 'var(--amber)', processing: 'var(--amber)', paid_via_deposit: 'var(--green)',
  }
  const c = map[status] || 'var(--text-3)'
  return <span style={{ fontSize: '.7rem', color: c, fontWeight: 600 }}>{statusWords(status)}</span>
}

// ══════════════════════════════════════════════════════════════
// MONTHLY P&L DRILL-IN MODAL (S512 #20; S655 under the switch)
// ══════════════════════════════════════════════════════════════
interface PaymentRow extends ChargeRow {
  type: string
  method: string
  status: string
  categoryLabel: string | null
  creditGiven?: number
  tenantName: string | null
  unitNumber: string | null
  propertyName: string | null
}
interface MonthlyPL {
  period: { year: number; month: number; start: string; end: string }
  gross: { rent: number; other: number; total: number }
  /** Every income line, labeled; they add up to gross.total. */
  lines: Array<{ line: string; label: string; amount: number }>
  /** Shown beside the total, never in it. */
  beside: Array<{ key: string; label: string; amount: number }>
  /** Money billed: what became of the bills (adds up to the total). */
  parts: Array<{ part: string; label: string; amount: number }>
  depositsHeld?: number
  expenses: { platformFee: number; maintenance: number; lotRent?: number; enteredExpenses?: number; total: number }
  net: number
  paymentCount: number
  payments: PaymentRow[]
  rowsTotal: number
}

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

function MonthlyPLModal({ month, basis, onClose }: { month: string; basis: IncomeBasis; onClose: () => void }) {
  const [year, mo] = month.split('-').map(Number)
  // ── S637: A P&L BELONGS TO ONE COMPANY ──────────────────────────────
  //
  // Nic: "I can click on the line item down below that shows September's
  // profit and loss. It just says loading. It doesn't show me which people
  // made payments."
  //
  // /reports/monthly-pl refuses to answer for an account owning more than one
  // company — a P&L is a per-entity artifact, so it will not silently blend
  // two of them (reportEntity, S633). This modal never sent one, so for any
  // multi-company account it 400'd on open. Every other report tab already
  // carries the picker; this one was missed.
  const [companyId, setCompanyId] = useState<string>('')
  const { data, isLoading, error } = useQuery<MonthlyPL>(
    ['monthly-pl', month, companyId, basis],
    () => apiGet(withBasis(`/reports/monthly-pl?year=${year}&month=${mo}`
      + (companyId ? `&landlordId=${companyId}` : ''), basis)),
  )

  // Money received: grouped by the day the money arrived. Money billed: by the
  // day each bill was due.
  const groups = data?.payments ? groupCharges(data.payments, basis) : []
  const remainder = data ? noChargeRemainder(data.gross.total, data.rowsTotal) : 0
  // Money billed with its parts listed (paid / clearing / covered by money paid
  // ahead / still owed — inside the total): "collected so far" is made of those
  // parts, so it is not listed again as "beside the total, not in it".
  const outcomeShown = !!data && showsBillOutcome(basis, data.parts.length)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal rb-modal" style={{ width: 720 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="modal-title" style={{ marginBottom: 2 }}>{monthLabel(month)} — Profit &amp; Loss</div>
            <div style={{ fontSize: '.74rem', color: 'var(--text-3)' }}>{basisLabel(basis)}</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }} aria-label="Close"><X size={15} /></button>
        </div>

        <div className="rb-modal-body">
          <EntityPicker value={companyId} onChange={setCompanyId}
            note="A profit and loss statement belongs to one company." />
          {/* S637: a failure used to render as "Loading…" forever, because this
              branch tested `!data` and an errored query has no data. That hid
              the actual reason — here, a 400 naming exactly what was wrong. */}
          {error ? (
            <div className="alert alert-warn" style={{ margin: 12, fontSize: '.82rem' }}>
              {reportErrorText(error, 'this statement')}
            </div>
          ) : isLoading || !data ? (
            <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
          ) : (
            <>
              {/* P&L summary */}
              <div className="rb-stats">
                <PLStat label={`${basisLabel(basis)}`} value={data.gross.total} color="var(--green)" />
                <PLStat label="Expenses" value={data.expenses.total} color="var(--text-2)" negative />
                <PLStat label="Net" value={data.net} color={data.net >= 0 ? 'var(--gold)' : 'var(--red, #e06666)'} bold />
              </div>

              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-header"><span className="card-title">Breakdown</span></div>
                <div style={{ padding: '0 0 6px' }}>
                  <PnLHeading>Income</PnLHeading>
                  {data.lines.map(l => <PnLLine key={l.line} label={l.label} value={l.amount} kind="income" />)}
                  <PnLLine label="Total income" value={data.gross.total} kind="total-in" />
                  <PaidAheadOnHand item={paidAheadOnHand(data.beside, basis)} />
                  {outcomeShown && (
                    <div className="rb-beside">
                      <div className="rb-beside-title">What became of the bills</div>
                      {data.parts.map(p => (
                        <div key={p.part} className="rb-beside-row"><span>{p.label}</span><span className="rb-line-amount">{fmt(p.amount)}</span></div>
                      ))}
                    </div>
                  )}
                  <PnLHeading>Expenses</PnLHeading>
                  {expenseLines(data.expenses).map(l => <PnLLine key={l.key} label={l.label} value={l.amount} kind="expense" />)}
                  <PnLLine label="Total expenses" value={data.expenses.total} kind="total-out" />
                  <PnLLine label="Net to owner" value={data.net} kind="net" />
                  {/* Money billed: still clearing and still owed are inside the total
                      (listed above under what became of the bills), never beside it —
                      and nor is collected so far once those parts are listed. Money
                      received: paid-ahead money on hand already counted (above). */}
                  <BesideFigures items={besideNotInTotal(data.beside, basis, { outcomeShown })} />
                </div>
              </div>

              {/* The charges behind the total. */}
              <div className="card">
                <div className="card-header">
                  <span className="card-title">
                    {basis === 'billed' ? `Bills by due date (${data.paymentCount})` : `Payments by the day the money arrived (${data.paymentCount})`}
                  </span>
                </div>
                <div style={{ padding: '6px 0' }}>
                  {groups.length === 0 ? (
                    <div style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24, fontSize: '.8rem' }}>
                      {basis === 'billed' ? `No bills due in ${monthLabel(month)}.` : `No payments arrived in ${monthLabel(month)}.`}
                    </div>
                  ) : groups.map(group => (
                    <div key={group.date || 'none'} style={{ marginBottom: 8 }}>
                      <div className="rb-group-head">
                        <span style={{ fontSize: '.74rem', fontWeight: 700, color: 'var(--text-1)' }}>
                          {group.date ? dayLabel(group.date + 'T12:00:00') : 'No date'}
                        </span>
                        <span className="mono" style={{ fontSize: '.74rem', color: 'var(--green)' }}>{fmt(group.total)}</span>
                      </div>
                      {group.rows.map(r => (
                        <div key={chargeKey(r)} className="rb-group-row">
                          <span className="rb-group-who">
                            {r.tenantName || 'Tenant'}
                            <span className="rb-group-detail">
                              {r.unitNumber ? ` · ${r.propertyName ? r.propertyName + ' ' : ''}#${r.unitNumber}` : ''}
                              {` · ${r.categoryLabel || humanize(r.type)}`}
                              {basis === 'received'
                                ? (Number(r.amount) < 0
                                    ? ' · money taken back (a dispute or bank return)'
                                    : `${r.method && r.method !== '—' ? ` · ${r.method}` : ''}${r.settledAt ? ` · ${timeLabel(r.settledAt)}` : ''}`)
                                : (partsText(r.parts, fmt) ? ` · ${partsText(r.parts, fmt)}` : '')}
                              {Number(r.creditGiven) > 0 ? ` · credit you gave ${fmt(r.creditGiven)}` : ''}
                            </span>
                          </span>
                          <span className="mono" style={{ color: 'var(--text-0)', whiteSpace: 'nowrap' }}>{fmt(r.amount)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                  {groups.length > 0 && Math.abs(remainder) >= 0.01 && (
                    <div className="rb-small-note">
                      These add up to {fmt(data.rowsTotal)}. The other {fmt(remainder)} of the total has no single charge
                      behind it (money paid ahead, register sales and stays, other income, move-out lines) — see the breakdown above.
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="modal-footer" style={{ marginTop: 12, flexShrink: 0 }}>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function PLStat({ label, value, color, negative, bold }: { label: string; value: number; color: string; negative?: boolean; bold?: boolean }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className={`rb-stat-value${bold ? ' bold' : ''}`} style={{ color }}>
        {negative && value > 0 ? '−' : ''}{fmt(value)}
      </div>
    </div>
  )
}

/**
 * Money received: the paid-ahead money not used yet. It counted on the day it
 * arrived ("Paid ahead for later bills"), so it is shown apart from the "not
 * in it" box, with words that say so (§0.0, Todd).
 */
function PaidAheadOnHand({ item }: { item: BesideItem | null }) {
  if (!item) return null
  return (
    <div className="rb-counted">
      <div className="rb-beside-row"><span>{item.label}</span><span className="rb-line-amount">{fmt(item.amount)}</span></div>
      <div className="rb-counted-note">{PAID_AHEAD_COUNTED_NOTE}</div>
    </div>
  )
}

/** Figures shown BESIDE a total, never inside it (still clearing, credits you gave, ...). */
function BesideFigures({ items }: { items: Array<{ key: string; label: string; amount: number }> | null | undefined }) {
  if (!items?.length) return null
  return (
    <div className="rb-beside">
      <div className="rb-beside-title">Beside the total, not in it</div>
      {items.map(i => (
        <div key={i.key} className="rb-beside-row"><span>{i.label}</span><span className="rb-line-amount">{fmt(i.amount)}</span></div>
      ))}
    </div>
  )
}

// ── P&L statement block (income green, expenses RED, net gold) ─
function PnLHeading({ children }: { children: string }) {
  return <div className="rb-heading">{children}</div>
}

type PnLKind = 'income' | 'expense' | 'total-in' | 'total-out' | 'net'
function PnLLine({ label, value, kind }: { label: string; value: number; kind: PnLKind }) {
  const isExpense = kind === 'expense' || kind === 'total-out'
  const cls = kind === 'net' ? 'net' : (kind === 'total-in' || kind === 'total-out') ? 'total' : ''
  // An income line that takes money off (credits given, returned) shows as a
  // red negative; an expense shows as a red deduction.
  const tone = kind === 'net' ? (value >= 0 ? 'rb-amt-net' : 'rb-amt-neg')
    : isExpense ? 'rb-amt-out'
    : value < 0 ? 'rb-amt-neg' : 'rb-amt-in'
  return (
    <div className={`rb-line ${cls}`}>
      <span className="rb-line-label">{label}</span>
      <span className={`rb-line-amount ${tone}`}>
        {isExpense ? (value ? `−${fmt(Math.abs(value))}` : fmt(0)) : fmt(value)}
      </span>
    </div>
  )
}

/**
 * The owner statement's P&L. Every income line (rent, fees, utilities, paid
 * ahead, register sales, credits given, returned, ...) is listed, so the lines
 * add up to the total income; every expense (platform fee, maintenance, lot
 * rent, your expenses) is listed, so they add up to the total expenses.
 */
function PnLStatement({ s, lines, beside, periodLabel, basis }: {
  s: any; lines: Array<{ line: string; label: string; amount: number }>
  beside: BesideItem[]; periodLabel: string; basis: IncomeBasis
}) {
  const outcome = billedOutcome(beside, basis)
  const expenses = expenseLines(s ? {
    platformFee: Number(s.totalPlatformFees || 0), maintenance: Number(s.totalMaintCost || 0),
    lotRent: Number(s.lotRent || 0), enteredExpenses: Number(s.enteredExpenses || 0),
  } : null)
  if (s && Number(s.pmFee)) expenses.push({ key: 'pmFee', label: 'Management fee', amount: Number(s.pmFee) })
  return (
    <div className="card">
      <div className="card-header"><span className="card-title">Profit &amp; Loss — {periodLabel}</span></div>
      <div style={{ padding: '2px 8px 14px' }}>
        <PnLHeading>{`Income (${basisLabel(basis)})`}</PnLHeading>
        {lines.map(l => <PnLLine key={l.line} label={l.label} value={l.amount} kind="income" />)}
        <PnLLine label="Total income" value={Number(s?.totalIncome || 0)} kind="total-in" />
        <PaidAheadOnHand item={paidAheadOnHand(beside, basis)} />
        {/* Money billed: what became of the bills — collected so far, still
            clearing, still owed — adds up to the total income above. */}
        {outcome.length > 0 && (
          <div className="rb-beside">
            <div className="rb-beside-title">What became of the bills</div>
            {outcome.map(i => (
              <div key={i.key} className="rb-beside-row"><span>{i.label}</span><span className="rb-line-amount">{fmt(i.amount)}</span></div>
            ))}
          </div>
        )}

        <PnLHeading>Expenses</PnLHeading>
        {expenses.map(l => <PnLLine key={l.key} label={l.label} value={l.amount} kind="expense" />)}
        <PnLLine label="Total expenses" value={Number(s?.totalExpenses || 0)} kind="total-out" />

        <PnLLine label="Net to Owner" value={Number(s?.netToOwner || 0)} kind="net" />
        <BesideFigures items={besideNotInTotal(beside, basis, { outcomeShown: outcome.length > 0 })} />
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// CUSTOM REPORT BUILDER + T-12 (S603, Nic)
//
// Every other tab on this page is a fixed report. This one drives the shared
// engine (GET /reports/query) so any combination of range × level × time bucket
// is one screen instead of one endpoint each. T-12 is the same engine with the
// knobs preset — which is why it can never disagree with the numbers here.
// ══════════════════════════════════════════════════════════════
type RLevel  = 'portfolio' | 'property' | 'unit'
type RBucket = 'total' | 'monthly' | 'daily'

interface EngineRow {
  period: string | null
  propertyName: string | null
  unitNumber: string | null
  /** S655: `lines` has every income line on its own (they add up to total). */
  income:   { rent: number; fees: number; utilities: number; homeSale: number; other: number; total: number; lines?: Record<string, number> }
  /** S655: lotRent — what an investor-operator owes the park, by billing month (the P&L's own). */
  expenses: { maintenance: number; entered: number; platformFee: number; lotRent?: number; total: number; byCategory: Record<string, number> }
  net: number
  occupiedUnits: number
  derived: { netPerUnit: number | null; costPerUnit: number | null; incomePerUnit: number | null; costPerDay: number; netPerDay: number }
}
interface EngineResult {
  rows: EngineRow[]
  totals: EngineRow
  meta: {
    start: string; end: string; level: RLevel; bucket: RBucket; platformFeeIncluded: boolean; lotRentIncluded?: boolean; report?: string; note?: string
    /** S655: the switch the figures were counted under. */
    basis?: { basis: IncomeBasis; label: string; note: string }
  }
}

const money = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/** Default range: the last 12 complete months, matching the T-12 convention
 *  (a half-finished current month makes income look worse than it is). */
function defaultRange(): { start: string; end: string } {
  // The viewer's calendar, not UTC's: on the last evening of a month in
  // Arizona, UTC is already next month and would call this one complete.
  return lastTwelveMonths()
}

function CustomReportTab({ basis }: { basis: IncomeBasis }) {
  const dflt = defaultRange()
  const [start, setStart]   = useState(dflt.start)
  const [end, setEnd]       = useState(dflt.end)
  const [level, setLevel]   = useState<RLevel>('property')
  const [bucket, setBucket] = useState<RBucket>('monthly')
  const [running, setRunning] = useState(false)
  const [error, setError]   = useState<string | null>(null)
  const [result, setResult] = useState<EngineResult | null>(null)
  const [title, setTitle]   = useState('Custom report')
  // S655: the last report run, so flipping the switch re-runs it in place
  // under the new basis instead of leaving figures counted the other way —
  // after a failed run too (the flip is a fresh try). Each run is numbered and
  // only the newest may land: an older run under the other basis answering
  // last would otherwise sit under a switch that says the opposite.
  const lastRun = useRef<{ path: string; label: string } | null>(null)
  const [runs] = useState(latestOnly)

  const run = async (path: string, label: string, b: IncomeBasis = basis) => {
    lastRun.current = { path, label }
    const me = runs.start()
    setRunning(true); setError(null)
    try {
      const answer = await apiGet<EngineResult>(withBasis(path, b))
      if (!runs.isLatest(me)) return
      setResult(answer)
      setTitle(label)
    } catch (e: any) {
      if (!runs.isLatest(me)) return
      setError(reportErrorText(e, 'that report'))
      setResult(null)
    } finally {
      if (runs.isLatest(me)) setRunning(false)
    }
  }
  useEffect(() => {
    if (lastRun.current) run(lastRun.current.path, lastRun.current.label, basis)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basis])

  const runCustom = () => {
    if (start > end) { setError('Start date must be on or before the end date.'); return }
    run(`/reports/query?start=${start}&end=${end}&level=${level}&bucket=${bucket}`, 'Custom report')
  }
  const runT12 = () => run('/reports/t12', 'Trailing 12 months (T-12)')
  // S655: a result on screen that was counted under the other basis (the
  // switch flipped and its re-run is still out), or any run in flight, is
  // dimmed with a plain line saying what is coming — never left at full
  // strength under a switch that says the opposite.
  const stale = !!result && resultIsStale(result.meta.basis?.basis, basis, running)
  // S655: lot rent is a P&L expense; its column shows whenever there is any.
  const hasLotRent = !!result && (Number(result.totals.expenses.lotRent ?? 0) !== 0
    || result.rows.some(r => Number(r.expenses.lotRent ?? 0) !== 0))

  const exportCsv = () => {
    if (!result) return
    const header = [
      'Period', 'Property', 'Unit',
      'Rent', 'Fees', 'Utilities', 'Home sale', 'Other income', 'Total income',
      'Maintenance', 'Expenses', 'Platform fee', 'Lot rent', 'Total expenses',
      'Net', 'Occupied units', 'Net / unit', 'Cost / unit',
    ]
    const body = result.rows.map(r => [
      r.period ?? 'Total', r.propertyName ?? '', r.unitNumber ?? '',
      r.income.rent, r.income.fees, r.income.utilities, r.income.homeSale, r.income.other, r.income.total,
      r.expenses.maintenance, r.expenses.entered, r.expenses.platformFee, r.expenses.lotRent ?? 0, r.expenses.total,
      r.net, r.occupiedUnits, r.derived.netPerUnit ?? '', r.derived.costPerUnit ?? '',
    ])
    const t = result.totals
    body.push([
      'TOTAL', '', '',
      t.income.rent, t.income.fees, t.income.utilities, t.income.homeSale, t.income.other, t.income.total,
      t.expenses.maintenance, t.expenses.entered, t.expenses.platformFee, t.expenses.lotRent ?? 0, t.expenses.total,
      t.net, t.occupiedUnits, t.derived.netPerUnit ?? '', t.derived.costPerUnit ?? '',
    ])
    const name = (result.meta.report === 'T-12' ? 't12' : 'report')
      + `_${result.meta.basis?.basis ?? basis}_${result.meta.start}_to_${result.meta.end}.csv`
    downloadCsv(name, header, body)
  }

  return (
    <div>
      <div className="card no-print" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '.75rem', color: 'var(--text-2)' }}>
            From
            <input type="date" className="input" value={start} onChange={e => setStart(e.target.value)} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '.75rem', color: 'var(--text-2)' }}>
            To
            <input type="date" className="input" value={end} onChange={e => setEnd(e.target.value)} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '.75rem', color: 'var(--text-2)' }}>
            Break down by
            <select className="input" value={level} onChange={e => setLevel(e.target.value as RLevel)}>
              <option value="portfolio">Whole portfolio</option>
              <option value="property">Each property</option>
              <option value="unit">Each unit</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '.75rem', color: 'var(--text-2)' }}>
            Time
            <select className="input" value={bucket} onChange={e => setBucket(e.target.value as RBucket)}>
              <option value="total">One total</option>
              <option value="monthly">Month by month</option>
              <option value="daily">Day by day</option>
            </select>
          </label>
          <button className="btn btn-primary" onClick={runCustom} disabled={running}>
            {running ? 'Running…' : 'Run report'}
          </button>
          <button className="btn btn-primary" onClick={runT12} disabled={running}>
            Trailing 12 months
          </button>
          {/* S603: the operating view — what a unit actually costs to run, month
              by month. Same engine, knobs preset, because this is the number an
              owner looks at regularly rather than only at sale time. */}
          <button className="btn btn-primary" disabled={running} onClick={() => {
            setLevel('unit'); setBucket('monthly')
            run(`/reports/query?start=${start}&end=${end}&level=unit&bucket=monthly`,
                'Operating cost per unit')
          }}>
            Cost per unit
          </button>
          {result && (
            <button className="btn btn-primary" onClick={exportCsv} disabled={stale}>Export CSV</button>
          )}
        </div>
        <div style={{ marginTop: 10, fontSize: '.75rem', color: 'var(--text-2)' }}>
          Security deposits are excluded — they are your tenants' money held, not income.
          Repair costs count only once an actual cost is recorded, never estimates.
        </div>
      </div>

      {error && <div className="alert alert-warn" style={{ marginBottom: 14 }}>{error}</div>}

      {stale && (
        <div className="no-print" role="status" style={{ fontSize: '.78rem', color: 'var(--text-2)', marginBottom: 10 }}>
          {result?.meta.basis && result.meta.basis.basis !== basis
            ? `Recounting under ${basisLabel(basis)}… The figures below are still ${result.meta.basis.label} until it finishes.`
            : 'Running the report… The figures below are the last run until it finishes.'}
        </div>
      )}

      <div style={{ opacity: stale ? 0.45 : 1, transition: 'opacity .15s' }} aria-busy={stale || undefined}>
      {result && result.meta.report === 'T-12' && (
        <T12Statement result={result} propertyName={null} stale={stale} />
      )}

      {result && result.meta.report !== 'T-12' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
            <h3 style={{ margin: 0 }}>{title}</h3>
            <div style={{ fontSize: '.75rem', color: 'var(--text-2)' }}>
              {result.meta.start} → {result.meta.end}
            </div>
          </div>
          {(result.meta.note || result.meta.basis) && (
            <div style={{ fontSize: '.75rem', color: 'var(--text-2)', marginTop: 6 }}>
              {result.meta.note || `${result.meta.basis!.label}: ${result.meta.basis!.note}`}
            </div>
          )}
          {!result.meta.platformFeeIncluded && (
            <div className="alert alert-warn" style={{ marginTop: 10, fontSize: '.75rem' }}>
              The GAM platform fee and lot rent are billed by the month, so they can't be split across
              individual days. They are not included in this day-by-day view — switch to month-by-month to see them.
            </div>
          )}

          {result.rows.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-2)' }}>
              No activity in this date range.
            </div>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: 12 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    {result.meta.bucket !== 'total' && <th>Period</th>}
                    {result.meta.level !== 'portfolio' && <th>Property</th>}
                    {result.meta.level === 'unit' && <th>Unit</th>}
                    <th style={{ textAlign: 'right' }}>{result.meta.basis?.label ?? basisLabel(basis)}</th>
                    <th style={{ textAlign: 'right' }}>Repairs</th>
                    <th style={{ textAlign: 'right' }}>Expenses</th>
                    <th style={{ textAlign: 'right' }}>Platform fee</th>
                    {hasLotRent && <th style={{ textAlign: 'right' }}>Lot rent</th>}
                    <th style={{ textAlign: 'right' }}>Net</th>
                    <th style={{ textAlign: 'right' }}>Net / unit</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r, i) => (
                    <tr key={i}>
                      {result.meta.bucket !== 'total' && <td>{r.period}</td>}
                      {result.meta.level !== 'portfolio' && <td>{r.propertyName ?? '—'}</td>}
                      {result.meta.level === 'unit' && <td>{r.unitNumber ?? '—'}</td>}
                      <td style={{ textAlign: 'right' }}>{money(r.income.total)}</td>
                      <td style={{ textAlign: 'right' }}>{money(r.expenses.maintenance)}</td>
                      <td style={{ textAlign: 'right' }}>{money(r.expenses.entered)}</td>
                      <td style={{ textAlign: 'right' }}>{money(r.expenses.platformFee)}</td>
                      {hasLotRent && <td style={{ textAlign: 'right' }}>{money(r.expenses.lotRent ?? 0)}</td>}
                      <td style={{ textAlign: 'right', color: r.net < 0 ? 'var(--red)' : undefined }}>{money(r.net)}</td>
                      <td style={{ textAlign: 'right' }}>{money(r.derived.netPerUnit)}</td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 600, borderTop: '2px solid var(--border-0)' }}>
                    <td colSpan={
                      (result.meta.bucket !== 'total' ? 1 : 0)
                      + (result.meta.level !== 'portfolio' ? 1 : 0)
                      + (result.meta.level === 'unit' ? 1 : 0) || 1
                    }>Total</td>
                    <td style={{ textAlign: 'right' }}>{money(result.totals.income.total)}</td>
                    <td style={{ textAlign: 'right' }}>{money(result.totals.expenses.maintenance)}</td>
                    <td style={{ textAlign: 'right' }}>{money(result.totals.expenses.entered)}</td>
                    <td style={{ textAlign: 'right' }}>{money(result.totals.expenses.platformFee)}</td>
                    {hasLotRent && <td style={{ textAlign: 'right' }}>{money(result.totals.expenses.lotRent ?? 0)}</td>}
                    <td style={{ textAlign: 'right' }}>{money(result.totals.net)}</td>
                    <td style={{ textAlign: 'right' }}>{money(result.totals.derived.netPerUnit)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  )
}

// ── T-12 STATEMENT (S603) ─────────────────────────────────────
// A real trailing-twelve is read line-items-DOWN, months-ACROSS — that is the
// shape an agent, buyer, appraiser, or lender expects. The engine returns one
// row per (month × property), so this transposes it and lets the existing print
// styling (PrintStyles strips the app chrome) produce a clean PDF via print.
function T12Statement({ result, propertyName, stale }: { result: EngineResult; propertyName: string | null; stale?: boolean }) {
  const months = [...new Set(result.rows.map(r => r.period).filter(Boolean))].sort() as string[]

  // Sum a measure for one month across whatever properties are in scope.
  const at = (m: string, pick: (r: EngineRow) => number) =>
    result.rows.filter(r => r.period === m).reduce((s, r) => s + pick(r), 0)

  // Expense categories actually present — never print an empty line item.
  const categories = [...new Set(
    result.rows.flatMap(r => Object.keys(r.expenses.byCategory)),
  )].sort()

  // S655: every income line on its own (home payments, balances collected,
  // money paid ahead, register sales and stays, other income, and what comes
  // off: returned, credits given, ...), so the lines add up to the total.
  const FIRST = new Set(['rent', 'fees', 'lateFees', 'utilities'])
  const otherLines = INCOME_LINES_ORDER.filter(k => !FIRST.has(k)
    && result.rows.some(r => Number(r.income.lines?.[k] ?? 0) !== 0))
  const hasLines = result.rows.some(r => r.income.lines)
  const lines: { label: string; get: (m: string) => number; strong?: boolean; indent?: boolean }[] = [
    { label: 'Rent',                 get: m => at(m, r => r.income.rent), indent: true },
    { label: 'Fees and late fees',   get: m => at(m, r => r.income.fees), indent: true },
    { label: 'Utilities reimbursed', get: m => at(m, r => r.income.utilities), indent: true },
    ...(hasLines
      ? otherLines.map(k => ({
          label: incomeLineLabel(k),
          get: (m: string) => at(m, r => Number(r.income.lines?.[k] ?? 0)),
          indent: true,
        }))
      : [{ label: 'Other income', get: (m: string) => at(m, r => r.income.homeSale + r.income.other), indent: true }]),
    { label: 'Total income',         get: m => at(m, r => r.income.total), strong: true },
    { label: 'Repairs & maintenance', get: m => at(m, r => r.expenses.maintenance), indent: true },
    ...categories.map(c => ({
      // The API camelizes this breakdown's keys ('property_tax' arrives as
      // 'propertyTax'); the label lookup takes either, never a raw key.
      label: expenseCategoryLabel(c),
      get: (m: string) => at(m, r => r.expenses.byCategory[c] ?? 0),
      indent: true,
    })),
    { label: 'Platform fee',   get: m => at(m, r => r.expenses.platformFee), indent: true },
    // S655: lot rent, as the P&L subtracts it — printed only when there is any.
    ...(result.rows.some(r => Number(r.expenses.lotRent ?? 0) !== 0)
      ? [{ label: 'Lot rent', get: (m: string) => at(m, r => Number(r.expenses.lotRent ?? 0)), indent: true }]
      : []),
    { label: 'Total expenses', get: m => at(m, r => r.expenses.total), strong: true },
    { label: 'Net operating income', get: m => at(m, r => r.net), strong: true },
  ]

  const rowTotal = (get: (m: string) => number) => months.reduce((s, m) => s + get(m), 0)

  return (
    <div className="card" style={{ marginTop: 16 }}>
      {/* S603 (Nic): the T-12 leaves this property as a document handed to an
          agent, buyer, or lender — so it carries GAM branding on the PRINTED
          page, where the app's own sidebar logo is stripped away.
          The logo SLOT resolves /brand/logo.png at runtime and silently falls
          back to the wordmark, so dropping that file into apps/landlord/public
          brands every statement with no code change. */}
      <div className="t12-brand" style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        flexWrap: 'wrap', gap: 10, paddingBottom: 12, marginBottom: 4,
        borderBottom: '2px solid var(--gold)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 132, height: 56, display: 'flex', alignItems: 'center',
            justifyContent: 'flex-start', flexShrink: 0,
          }}>
            <img
              src="/brand/logo.png"
              alt="Gold Asset Management"
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
              onError={e => {
                // No logo file yet — show the wordmark instead of a broken image.
                const el = e.currentTarget
                el.style.display = 'none'
                const fb = el.nextElementSibling as HTMLElement | null
                if (fb) fb.style.display = 'block'
              }}
            />
            <div style={{
              display: 'none', fontWeight: 800, fontSize: '1.25rem',
              letterSpacing: '.06em', color: 'var(--gold)',
            }}>GAM</div>
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '.95rem' }}>Gold Asset Management</div>
            <h3 style={{ margin: '2px 0 0' }}>Trailing 12 Months (T-12)</h3>
            <div style={{ fontSize: '.8rem', color: 'var(--text-2)', marginTop: 2 }}>
              {propertyName || 'All properties'} · {result.meta.start} to {result.meta.end}
            </div>
          </div>
        </div>
        {/* Not while a re-run under the other basis is out: the PDF would carry the old figures. */}
        <ToolbarBtn onClick={() => window.print()} icon={<Printer size={14} />} label="Print / Save PDF" disabled={stale} />
      </div>

      <div style={{ overflowX: 'auto', marginTop: 14, position: 'relative' }}>
        {/* Watermark — sits BEHIND the figures, never obscures them, and is
            marked print-visible so it survives to paper (browsers drop
            backgrounds by default; print-color-adjust forces it). */}
        <div className="t12-watermark" aria-hidden="true">Gold Asset Management</div>
        <table className="data-table" style={{ minWidth: 900, position: 'relative', zIndex: 1 }}>
          <thead>
            <tr>
              <th style={{ position: 'sticky', left: 0, background: 'var(--bg-1)' }}>Line item</th>
              {months.map(m => <th key={m} style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{monthLabel(m)}</th>)}
              <th style={{ textAlign: 'right', fontWeight: 700 }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((ln, i) => (
              <tr key={i} style={ln.strong ? { fontWeight: 700, borderTop: '1px solid var(--border-0)' } : undefined}>
                <td style={{
                  position: 'sticky', left: 0, background: 'var(--bg-1)',
                  paddingLeft: ln.indent ? 18 : undefined,
                }}>{ln.label}</td>
                {months.map(m => (
                  <td key={m} style={{ textAlign: 'right' }}>{money(ln.get(m))}</td>
                ))}
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(rowTotal(ln.get))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Basis of preparation — a T-12 handed to a buyer or lender has to say
          what is in it and what is not, or the reader assumes the worst. */}
      <div style={{ marginTop: 14, fontSize: '.72rem', color: 'var(--text-2)', lineHeight: 1.6 }}>
        <strong>Basis of preparation.</strong>{' '}
        {result.meta.note
          || `Twelve complete months; the current partial month is excluded.${result.meta.basis ? ` ${result.meta.basis.label}: ${result.meta.basis.note}` : ''}`}
        {' '}Security deposits are excluded —
        they are tenant funds held, not income. Repairs are included only where an actual cost was
        recorded; estimates are excluded. Costs not tied to a specific unit are shown at the
        property. Prepared from the operator's own records and unaudited.
      </div>
    </div>
  )
}
