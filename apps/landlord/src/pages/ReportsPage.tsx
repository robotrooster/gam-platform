import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from 'react-query'
import { humanize, EXPENSE_CATEGORY_LABEL } from '@gam/shared'
import { apiGet } from '../lib/api'
import { usePerms } from '../lib/permissions'
import { X, Printer, Download } from 'lucide-react'
// S633: tax + statement documents belong to ONE company; the picker renders
// nothing for an account that owns a single one.
import { EntityPicker } from '../components/EntityPicker'

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
const fmt0 = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {maximumFractionDigits:0})}` : '—'

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
           and watermark must survive printing, so force colour rendering and
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

const ToolbarBtn = ({ onClick, icon, label }: { onClick: () => void; icon: JSX.Element; label: string }) => (
  <button className="btn btn-ghost btn-sm no-print" onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
function CollectionsCharts({ ytdMonthly, mtd, ytd }: {
  ytdMonthly: { month: string; collected: number }[]
  mtd: number; ytd: number
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
  const hasData = series.some(s => s.collected > 0)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
      <div className="card">
        <div className="card-header">
          <span className="card-title">Collected by Month — {year}</span>
          <span style={{ fontSize: '.7rem', color: 'var(--gold)' }}>MTD {fmt(mtd)}</span>
        </div>
        <div style={{ padding: '12px 12px 6px' }}>
          {hasData ? <BarChart series={series} current={upto} /> : <EmptyChart />}
        </div>
      </div>
      <div className="card">
        <div className="card-header">
          <span className="card-title">Cumulative YTD — {year}</span>
          <span style={{ fontSize: '.7rem', color: 'var(--gold)' }}>YTD {fmt(ytd)}</span>
        </div>
        <div style={{ padding: '12px 12px 6px' }}>
          {hasData ? <AreaChart series={series} /> : <EmptyChart />}
        </div>
      </div>
    </div>
  )
}

const EmptyChart = () => (
  <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontSize: '.8rem' }}>
    No collections recorded yet this year.
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
      <div className="no-print" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-0)', marginBottom: 18 }}>
        {visibleTabs.map(t => (
          <button key={t.key} className={`tab-btn ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === 'overview'  && can('reports.tab.overview')  && <OverviewTab />}
      {tab === 'property'  && can('reports.tab.property')  && <ByPropertyTab />}
      {tab === 'annual'    && can('reports.tab.annual')    && <AnnualTaxTab />}
      {tab === 'statement' && can('reports.tab.statement') && <OwnerStatementTab />}
      {tab === 'custom'    && can('reports.tab.custom')    && <CustomReportTab />}
    </div>
  )
}

// ── OVERVIEW (S69 + S512 #20 drill-in) ────────────────────────
function OverviewTab() {
  const { data: report, isLoading } = useQuery<any>('reports', () => apiGet('/reports/summary'))
  const [openMonth, setOpenMonth] = useState<string | null>(null)
  const navigate = useNavigate()

  return (
    <>
      {isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
        <div style={{display:'grid',gap:16}}>
          <div className="kpi-grid" style={{gridTemplateColumns:'repeat(4, 1fr)'}}>
            <div className="kpi-card"><div className="kpi-label">Collected MTD</div><div className="kpi-value green">{fmt0(report?.collectedMtd)}</div></div>
            <div className="kpi-card"><div className="kpi-label">Collected YTD</div><div className="kpi-value" style={{color:'var(--gold)'}}>{fmt0(report?.ytdCollected)}</div></div>
            {/* S527 W-38: click through to the who-owes-what list (same target as the dashboard KPI). */}
            <div className="kpi-card" style={{cursor:'pointer'}} onClick={()=>navigate('/balances')}><div className="kpi-label">Outstanding Balance</div><div className="kpi-value" style={{color:'var(--amber)'}}>{fmt0(report?.outstanding)}</div></div>
            <div className="kpi-card"><div className="kpi-label">Occupancy Rate</div><div className="kpi-value">{report?.occupancyRate != null ? `${report.occupancyRate}%` : '—'}</div></div>
          </div>
          <CollectionsCharts ytdMonthly={report?.ytdMonthly ?? []} mtd={Number(report?.collectedMtd || 0)} ytd={Number(report?.ytdCollected || 0)} />
          <div className="card">
            <div className="card-header"><span className="card-title">Monthly Breakdown</span></div>
            <div style={{padding:'4px 0 16px'}}>
              <div style={{fontSize:'.72rem',color:'var(--text-3)',padding:'0 0 10px'}}>Click a month to open its profit &amp; loss and payment-date breakdown.</div>
              <table className="data-table">
                <thead><tr><th>Month</th><th>Collected</th><th>Disbursed</th><th>Fees</th><th>Net</th><th></th></tr></thead>
                <tbody>
                  {report?.monthly?.length ? report.monthly.map((m: any) => (
                    <tr key={m.month}
                        onClick={() => setOpenMonth(m.month)}
                        style={{cursor:'pointer'}}
                        title={`Open ${monthLabel(m.month)} P&L`}>
                      <td className="mono" style={{color:'var(--gold)',fontWeight:600}}>{m.month}</td>
                      <td className="mono" style={{color:'var(--green)'}}>{fmt(m.collected)}</td>
                      <td className="mono">{fmt(m.disbursed)}</td>
                      <td className="mono" style={{color:'var(--text-3)'}}>{fmt(m.fees)}</td>
                      <td className="mono" style={{color:'var(--text-0)',fontWeight:600}}>{fmt(m.net)}</td>
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
      )}
      {openMonth && <MonthlyPLModal month={openMonth} onClose={() => setOpenMonth(null)} />}
    </>
  )
}

// ── BY PROPERTY (per-property P&L) ────────────────────────────
function ByPropertyTab() {
  const now = new Date()
  const [year, setYear]   = useState(now.getFullYear())
  const [month, setMonth] = useState<number | null>(null) // null = full year
  const [openProp, setOpenProp] = useState<{ id: string; name: string } | null>(null)
  const { can } = usePerms()
  const qs = `year=${year}${month ? `&month=${month}` : ''}`
  const { data, isLoading } = useQuery<any>(['property-pl', year, month], () => apiGet(`/reports/property-pl?${qs}`))
  const props: any[] = data?.properties ?? []

  const totals = props.reduce((t, p) => ({
    rent: t.rent + Number(p.rentCollected || 0),
    maint: t.maint + Number(p.maintCost || 0),
    plat: t.plat + Number(p.platformFees || 0),
    net: t.net + Number(p.netIncome || 0),
  }), { rent: 0, maint: 0, plat: 0, net: 0 })

  const periodLabel = month ? `${MONTHS[month - 1]} ${year}` : `Full year ${year}`

  const exportCsv = () => downloadCsv(
    `property-pl-${year}${month ? `-${String(month).padStart(2,'0')}` : ''}.csv`,
    ['Property', 'Occupied', 'Total units', 'Occupancy %', 'Rent collected', 'Maintenance', 'Platform fee', 'Net income'],
    props.map(p => [p.name, p.occupiedUnits, p.totalUnits, p.occupancyRate,
      Number(p.rentCollected||0).toFixed(2), Number(p.maintCost||0).toFixed(2),
      Number(p.platformFees||0).toFixed(2), Number(p.netIncome||0).toFixed(2)]),
  )

  return (
    <div style={{ display: 'grid', gap: 14 }}>
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
          <span className="no-print" style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>Click a property for unit, payment &amp; maintenance detail.</span>
        </div>
        <div style={{ padding: '4px 0 12px' }}>
          {isLoading ? <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div> : (
            <table className="data-table">
              <thead><tr>
                <th>Property</th><th style={{textAlign:'center'}}>Occ / Total</th><th style={{textAlign:'center'}}>Occ %</th>
                <th>Collected</th><th>Maint.</th><th>Platform Fee</th><th>Net</th><th></th>
              </tr></thead>
              <tbody>
                {props.length ? props.map((p: any) => (
                  <tr key={p.id} onClick={() => setOpenProp({ id: p.id, name: p.name })}
                      style={{ cursor: 'pointer' }} title={`Open ${p.name} detail`}>
                    <td style={{ color: 'var(--text-0)', fontWeight: 600 }}>{p.name}</td>
                    <td className="mono" style={{ textAlign: 'center' }}>{p.occupiedUnits}/{p.totalUnits}</td>
                    <td className="mono" style={{ textAlign: 'center' }}>{p.occupancyRate}%</td>
                    <td className="mono" style={{ color: 'var(--green)' }}>{fmt(p.rentCollected)}</td>
                    <td className="mono" style={{ color: Number(p.maintCost) > 0 ? 'var(--red)' : 'var(--text-3)' }}>{Number(p.maintCost) > 0 ? '−' : ''}{fmt(p.maintCost)}</td>
                    <td className="mono" style={{ color: Number(p.platformFees) > 0 ? 'var(--red)' : 'var(--text-3)' }}>{Number(p.platformFees) > 0 ? '−' : ''}{fmt(p.platformFees)}</td>
                    <td className="mono" style={{ color: Number(p.netIncome) >= 0 ? 'var(--gold)' : 'var(--red)', fontWeight: 600 }}>{fmt(p.netIncome)}</td>
                    <td style={{ color: 'var(--text-3)', textAlign: 'right' }}>›</td>
                  </tr>
                )) : (
                  <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>No properties yet.</td></tr>
                )}
              </tbody>
              {props.length > 0 && (
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--border-1)' }}>
                    <td style={{ fontWeight: 700, color: 'var(--text-0)' }}>Total</td>
                    <td></td><td></td>
                    <td className="mono" style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(totals.rent)}</td>
                    <td className="mono" style={{ color: totals.maint > 0 ? 'var(--red)' : 'var(--text-3)', fontWeight: 700 }}>{totals.maint > 0 ? '−' : ''}{fmt(totals.maint)}</td>
                    <td className="mono" style={{ color: totals.plat > 0 ? 'var(--red)' : 'var(--text-3)', fontWeight: 700 }}>{totals.plat > 0 ? '−' : ''}{fmt(totals.plat)}</td>
                    <td className="mono" style={{ color: totals.net >= 0 ? 'var(--gold)' : 'var(--red)', fontWeight: 700 }}>{fmt(totals.net)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      </div>
      {openProp && <PropertyDetailModal propertyId={openProp.id} name={openProp.name} year={year} month={month} onClose={() => setOpenProp(null)} />}
    </div>
  )
}

// ── PROPERTY DETAIL DRILL-IN MODAL ────────────────────────────
function PropertyDetailModal({ propertyId, name, year, month, onClose }: {
  propertyId: string; name: string; year: number; month: number | null; onClose: () => void
}) {
  const qs = `propertyId=${propertyId}&year=${year}${month ? `&month=${month}` : ''}`
  const { data, isLoading } = useQuery<any>(['property-detail', propertyId, year, month], () => apiGet(`/reports/property-detail?${qs}`))
  const periodLabel = month ? `${MONTHS[month - 1]} ${year}` : `Full year ${year}`

  // Zero-filled 12-month trend for the mini bar chart; highlight selected month.
  const byMonth = new Map<string, number>((data?.monthlyTrend ?? []).map((t: any) => [t.month, t.collected]))
  const trend = Array.from({ length: 12 }, (_, i) => ({
    m: i + 1, label: MONTHS_SHORT[i],
    collected: byMonth.get(`${year}-${String(i + 1).padStart(2, '0')}`) ?? 0,
  }))
  const hasTrend = trend.some(t => t.collected > 0)
  const s = data?.summary
  const units: any[] = data?.units ?? []
  const payments: any[] = data?.payments ?? []
  const maintenance: any[] = data?.maintenance ?? []

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: 760, maxWidth: '94vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="modal-title">{name}</div>
            <div style={{ fontSize: '.74rem', color: 'var(--text-3)' }}>
              {data?.property ? `${data.property.city}, ${data.property.state} · ${data.property.occupiedUnits}/${data.property.totalUnits} occupied (${data.property.occupancyRate}%)` : periodLabel}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>

        <div style={{ overflowY: 'auto', padding: '4px 2px 8px' }}>
          {isLoading || !data ? (
            <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
                <PLStat label={`Collected (${periodLabel})`} value={s.collected} color="var(--green)" />
                <PLStat label="Platform fee" value={s.platformFee} color="var(--red)" negative />
                <PLStat label="Maintenance" value={s.maintCost} color="var(--red)" negative />
                <PLStat label="Net" value={s.net} color={s.net >= 0 ? 'var(--gold)' : 'var(--red, #e06666)'} bold />
              </div>

              {hasTrend && (
                <div className="card" style={{ marginBottom: 14 }}>
                  <div className="card-header"><span className="card-title">Collected by Month — {year}</span></div>
                  <div style={{ padding: '10px 12px 4px' }}><BarChart series={trend} current={month ?? -1} /></div>
                </div>
              )}

              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-header"><span className="card-title">Units ({units.length})</span></div>
                <div style={{ padding: '4px 0 8px' }}>
                  <table className="data-table">
                    <thead><tr><th>Unit</th><th>Bed/Bath</th><th>Status</th><th>Rent</th><th>Tenant</th></tr></thead>
                    <tbody>
                      {units.length ? units.map(u => (
                        <tr key={u.id}>
                          <td style={{ color: 'var(--text-0)', fontWeight: 600 }}>#{u.unitNumber}</td>
                          <td className="mono" style={{ color: 'var(--text-3)' }}>{u.bedrooms}/{u.bathrooms}</td>
                          <td><StatusPill status={u.status} /></td>
                          <td className="mono">{fmt(u.rent)}</td>
                          <td style={{ color: u.isOccupied ? 'var(--text-2)' : 'var(--text-3)' }}>{u.tenantName || (u.isOccupied ? 'Occupied' : 'Vacant')}</td>
                        </tr>
                      )) : <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 20 }}>No units.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-header"><span className="card-title">Payments ({payments.length})</span></div>
                <div style={{ padding: '4px 0 8px' }}>
                  <table className="data-table">
                    <thead><tr><th>Due</th><th>Unit</th><th>Tenant</th><th>Type</th><th>Status</th><th>Amount</th></tr></thead>
                    <tbody>
                      {payments.length ? payments.map(p => (
                        <tr key={p.id}>
                          <td className="mono" style={{ color: 'var(--text-3)' }}>{(p.dueDate || '').slice(0, 10)}</td>
                          <td className="mono">{p.unitNumber ? `#${p.unitNumber}` : '—'}</td>
                          <td style={{ color: 'var(--text-2)' }}>{p.tenantName || '—'}</td>
                          <td style={{ color: 'var(--text-3)' }}>{humanize(p.type)}</td>
                          <td><StatusPill status={p.status} /></td>
                          <td className="mono" style={{ color: 'var(--text-0)' }}>{fmt(p.amount)}</td>
                        </tr>
                      )) : <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 20 }}>No payments in {periodLabel}.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="card">
                <div className="card-header"><span className="card-title">Maintenance ({maintenance.length})</span></div>
                <div style={{ padding: '4px 0 8px' }}>
                  <table className="data-table">
                    <thead><tr><th>Unit</th><th>Description</th><th>Cost</th></tr></thead>
                    <tbody>
                      {maintenance.length ? maintenance.map(m => (
                        <tr key={m.id}>
                          <td className="mono">{m.unitNumber ? `#${m.unitNumber}` : '—'}</td>
                          <td style={{ color: 'var(--text-2)' }}>{m.title || '—'}</td>
                          <td className="mono">{fmt(m.actualCost)}</td>
                        </tr>
                      )) : <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 20 }}>No maintenance in {periodLabel}.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="modal-footer" style={{ marginTop: 12, flexShrink: 0 }}>
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ── ANNUAL & TAX (tax-summary + work-trade 1099) ──────────────
function AnnualTaxTab() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const { can } = usePerms()
  // S633: a TAX document belongs to one company. Analytical rollups elsewhere on
  // this page span the whole account; these two cannot, because summing two LLCs
  // into one return is wrong on its face. Single-company accounts see no picker.
  const [companyId, setCompanyId] = useState<string>('')
  const q = companyId ? `&landlordId=${companyId}` : ''
  const { data: tax, isLoading } = useQuery<any>(['tax-summary', year, companyId],
    () => apiGet(`/reports/tax-summary?year=${year}${q}`), { enabled: !!companyId })
  const { data: wt } = useQuery<any>(['wt-1099', year, companyId],
    () => apiGet(`/reports/work-trade-1099?year=${year}${q}`), { enabled: !!companyId })

  const monthly: any[] = tax?.monthlyBreakdown ?? []
  const eligible: any[] = wt?.eligible ?? []

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="no-print">
        <EntityPicker value={companyId} onChange={setCompanyId}
          note="A tax statement belongs to one company — each LLC files its own return." />
      </div>
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <PeriodPicker year={year} setYear={setYear} month={null} />
        {can('reports.export') && (
          <ToolbarBtn onClick={() => window.print()} icon={<Printer size={14} />} label="Print" />
        )}
      </div>

      {isLoading ? <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div> : (
        <>
          <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div className="kpi-card"><div className="kpi-label">Gross Rent {year}</div><div className="kpi-value green">{fmt0(tax?.income?.totalRent)}</div></div>
            <div className="kpi-card"><div className="kpi-label">Net Income</div><div className="kpi-value" style={{ color: 'var(--gold)' }}>{fmt0(tax?.netIncome)}</div></div>
            <div className="kpi-card"><div className="kpi-label">Deposits Held</div><div className="kpi-value">{fmt0(tax?.deposits?.totalHeld)}</div></div>
            <div className="kpi-card"><div className="kpi-label">Settled Payments</div><div className="kpi-value">{tax?.income?.paymentCount ?? 0}</div></div>
          </div>

          <div className="card">
            <div className="card-header"><span className="card-title">Deductions (estimated)</span></div>
            <div style={{ padding: '6px 6px 12px' }}>
              <PnLLine label="GAM platform fees" value={Number(tax?.deductions?.platformFees || 0)} kind="expense" />
              <PnLLine label="Maintenance expenses" value={Number(tax?.deductions?.maintExpenses || 0)} kind="expense" />
              {Number(tax?.deductions?.workTradeValue || 0) > 0 &&
                <PnLLine label="Work-trade value (bartered)" value={Number(tax?.deductions?.workTradeValue || 0)} kind="expense" />}
              <div style={{ fontSize: '.68rem', color: 'var(--text-3)', padding: '8px 4px 0' }}>
                Estimates for planning only — not tax advice. GAM does not file on your behalf. Confirm with your tax professional.
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header"><span className="card-title">Monthly Collected — {year}</span></div>
            <div style={{ padding: '4px 0 12px' }}>
              <table className="data-table">
                <thead><tr><th>Month</th><th>Collected</th><th style={{textAlign:'center'}}>Paid</th><th style={{textAlign:'center'}}>Failed</th></tr></thead>
                <tbody>
                  {monthly.length ? monthly.map((m: any) => (
                    <tr key={m.month}>
                      <td style={{ color: 'var(--text-1)' }}>{MONTHS[(Number(m.month) || 1) - 1]}</td>
                      <td className="mono" style={{ color: 'var(--green)' }}>{fmt(m.collected)}</td>
                      <td className="mono" style={{ textAlign: 'center' }}>{m.paid}</td>
                      <td className="mono" style={{ textAlign: 'center', color: Number(m.failed) > 0 ? 'var(--red)' : 'var(--text-3)' }}>{m.failed}</td>
                    </tr>
                  )) : <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>No payments in {year}.</td></tr>}
                </tbody>
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
              <table className="data-table">
                <thead><tr><th>Tenant</th><th>Property / Unit</th><th>Email</th><th>Value</th></tr></thead>
                <tbody>
                  {eligible.length ? eligible.map((a: any) => (
                    <tr key={a.id}>
                      <td style={{ color: 'var(--text-0)' }}>{[a.tenantFirst, a.tenantLast].filter(Boolean).join(' ') || '—'}</td>
                      <td style={{ color: 'var(--text-2)' }}>{a.propertyName}{a.unitNumber ? ` · #${a.unitNumber}` : ''}</td>
                      <td style={{ color: 'var(--text-3)' }}>{a.tenantEmail || '—'}</td>
                      <td className="mono" style={{ color: 'var(--gold)', fontWeight: 600 }}>{fmt(a.creditValue)}</td>
                    </tr>
                  )) : <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>No 1099-eligible work trade in {year}.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── OWNER STATEMENT (monthly-statement) ───────────────────────
function OwnerStatementTab() {
  const now = new Date()
  const [year, setYear]   = useState(now.getFullYear())
  const [month, setMonth] = useState<number | null>(now.getMonth() + 1)
  const { can } = usePerms()
  // S633: an owner statement is one company's statement — it prints that
  // company's name at the top.
  const [companyId, setCompanyId] = useState<string>('')
  const { data, isLoading } = useQuery<any>(['monthly-statement', year, month, companyId],
    () => apiGet(`/reports/monthly-statement?year=${year}&month=${month}` + (companyId ? `&landlordId=${companyId}` : '')),
    { enabled: !!companyId })

  const s = data?.summary
  const payments: any[] = data?.payments ?? []
  const maintenance: any[] = data?.maintenance ?? []
  const landlord = data?.landlord
  const ym = `${year}-${String(month).padStart(2, '0')}`

  const exportPaymentsCsv = () => downloadCsv(
    `owner-statement-payments-${ym}.csv`,
    ['Date due', 'Property', 'Unit', 'Tenant', 'Type', 'Status', 'Amount'],
    payments.map(p => [
      (p.dueDate || '').slice(0, 10), p.propertyName, p.unitNumber,
      [p.tenantFirst, p.tenantLast].filter(Boolean).join(' '),
      p.type, p.status, Number(p.amount || 0).toFixed(2),
    ]),
  )

  return (
    <div style={{ display: 'grid', gap: 14 }}>
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

      {isLoading ? <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div> : (
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
              </div>
            </div>
          </div>

          <PnLStatement s={s} periodLabel={monthLabel(ym)} />

          <div className="card">
            <div className="card-header">
              <span className="card-title">Payments</span>
              <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>
                {s?.settledPayments ?? 0} settled · {s?.latePayments ?? 0} late · {s?.failedPayments ?? 0} failed
              </span>
            </div>
            <div style={{ padding: '4px 0 12px' }}>
              <table className="data-table">
                <thead><tr><th>Due</th><th>Property / Unit</th><th>Tenant</th><th>Type</th><th>Status</th><th>Amount</th></tr></thead>
                <tbody>
                  {payments.length ? payments.map((p: any) => (
                    <tr key={p.id}>
                      <td className="mono" style={{ color: 'var(--text-3)' }}>{(p.dueDate || '').slice(0, 10)}</td>
                      <td style={{ color: 'var(--text-1)' }}>{p.propertyName}{p.unitNumber ? ` · #${p.unitNumber}` : ''}</td>
                      <td style={{ color: 'var(--text-2)' }}>{[p.tenantFirst, p.tenantLast].filter(Boolean).join(' ') || '—'}</td>
                      <td style={{ color: 'var(--text-3)' }}>{humanize(p.type)}</td>
                      <td><StatusPill status={p.status} /></td>
                      <td className="mono" style={{ color: 'var(--text-0)' }}>{fmt(p.amount)}</td>
                    </tr>
                  )) : <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>No payments in {monthLabel(ym)}.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-header"><span className="card-title">Maintenance</span></div>
            <div style={{ padding: '4px 0 12px' }}>
              <table className="data-table">
                <thead><tr><th>Property / Unit</th><th>Description</th><th>Cost</th></tr></thead>
                <tbody>
                  {maintenance.length ? maintenance.map((m: any) => (
                    <tr key={m.id}>
                      <td style={{ color: 'var(--text-1)' }}>{m.propertyName}{m.unitNumber ? ` · #${m.unitNumber}` : ''}</td>
                      <td style={{ color: 'var(--text-2)' }}>{m.title || m.description || '—'}</td>
                      <td className="mono">{fmt(m.actualCost)}</td>
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
    settled: 'var(--green)', late: 'var(--amber)', failed: 'var(--red)',
    pending: 'var(--text-3)', partial: 'var(--amber)',
  }
  const c = map[status] || 'var(--text-3)'
  return <span style={{ fontSize: '.7rem', color: c, fontWeight: 600, textTransform: 'capitalize' }}>{humanize(status)}</span>
}

// ══════════════════════════════════════════════════════════════
// MONTHLY P&L DRILL-IN MODAL (unchanged from S512 #20)
// ══════════════════════════════════════════════════════════════
interface PaymentRow {
  id: string
  settledAt: string
  amount: number
  type: string
  method: string
  tenantName: string | null
  unitNumber: string | null
  propertyName: string | null
}
interface MonthlyPL {
  period: { year: number; month: number; start: string; end: string }
  gross: { rent: number; fees?: number; utilities?: number; homeSale?: number; other: number; total: number }
  depositsHeld?: number
  expenses: { platformFee: number; maintenance: number; lotRent?: number; enteredExpenses?: number; total: number }
  net: number
  paymentCount: number
  payments: PaymentRow[]
}

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

function MonthlyPLModal({ month, onClose }: { month: string; onClose: () => void }) {
  const [year, mo] = month.split('-').map(Number)
  const { data, isLoading } = useQuery<MonthlyPL>(
    ['monthly-pl', month],
    () => apiGet(`/reports/monthly-pl?year=${year}&month=${mo}`),
  )

  // Group settled payments by their actual payment date.
  const byDate: Array<{ date: string; rows: PaymentRow[]; total: number }> = []
  if (data?.payments) {
    const map = new Map<string, PaymentRow[]>()
    for (const p of data.payments) {
      const key = (p.settledAt || '').slice(0, 10)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(p)
    }
    for (const [date, rows] of Array.from(map.entries()).sort(([a], [b]) => b.localeCompare(a))) {
      byDate.push({ date, rows, total: rows.reduce((s, r) => s + r.amount, 0) })
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: 720, maxWidth: '94vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="modal-title">{monthLabel(month)} — Profit &amp; Loss</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>

        <div style={{ overflowY: 'auto', padding: '4px 2px 8px' }}>
          {isLoading || !data ? (
            <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
          ) : (
            <>
              {/* P&L summary */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
                <PLStat label="Gross income" value={data.gross.total} color="var(--green)" />
                <PLStat label="Expenses" value={data.expenses.total} color="var(--text-2)" negative />
                <PLStat label="Net" value={data.net} color={data.net >= 0 ? 'var(--gold)' : 'var(--red, #e06666)'} bold />
              </div>

              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-header"><span className="card-title">Breakdown</span></div>
                <div style={{ padding: '6px 0' }}>
                  <PnLLine label="Rent collected" value={data.gross.rent} kind="income" />
                  {!!data.gross.fees && data.gross.fees > 0 && <PnLLine label="Fees" value={data.gross.fees} kind="income" />}
                  {!!data.gross.utilities && data.gross.utilities > 0 && <PnLLine label="Utilities" value={data.gross.utilities} kind="income" />}
                  {!!data.gross.homeSale && data.gross.homeSale > 0 && <PnLLine label="Home-sale payments" value={data.gross.homeSale} kind="income" />}
                  <PnLLine label="GAM platform fee" value={data.expenses.platformFee} kind="expense" />
                  {data.expenses.maintenance > 0 && <PnLLine label="Maintenance" value={data.expenses.maintenance} kind="expense" />}
                  {!!data.expenses.lotRent && data.expenses.lotRent > 0 && <PnLLine label="Lot rent" value={data.expenses.lotRent} kind="expense" />}
                  {!!data.expenses.enteredExpenses && data.expenses.enteredExpenses > 0 && <PnLLine label="Your expenses" value={data.expenses.enteredExpenses} kind="expense" />}
                  <PnLLine label="Net to owner" value={data.net} kind="net" />
                  {!!data.depositsHeld && data.depositsHeld > 0 && (
                    <div style={{ fontSize: '.7rem', color: 'var(--text-3)', padding: '4px 14px' }}>
                      + {fmt(data.depositsHeld)} deposits collected (held, not income)
                    </div>
                  )}
                </div>
              </div>

              {/* Actual-payment-date breakdown */}
              <div className="card">
                <div className="card-header"><span className="card-title">Payments by date ({data.paymentCount})</span></div>
                <div style={{ padding: '6px 0' }}>
                  {byDate.length === 0 ? (
                    <div style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24, fontSize: '.8rem' }}>
                      No settled payments recorded in {monthLabel(month)}.
                    </div>
                  ) : byDate.map(group => (
                    <div key={group.date} style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '6px 4px', borderBottom: '1px solid var(--border-0)' }}>
                        <span style={{ fontSize: '.74rem', fontWeight: 700, color: 'var(--text-1)' }}>{dayLabel(group.date + 'T12:00:00')}</span>
                        <span className="mono" style={{ fontSize: '.74rem', color: 'var(--green)' }}>{fmt(group.total)}</span>
                      </div>
                      {group.rows.map(r => (
                        <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, padding: '5px 4px', fontSize: '.74rem' }}>
                          <span style={{ color: 'var(--text-2)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {r.tenantName || 'Tenant'}
                            <span style={{ color: 'var(--text-3)' }}>
                              {r.unitNumber ? ` · ${r.propertyName ? r.propertyName + ' ' : ''}#${r.unitNumber}` : ''}
                              {` · ${humanize(r.type)}`}
                              {` · ${humanize(r.method)}`}
                              {` · ${timeLabel(r.settledAt)}`}
                            </span>
                          </span>
                          <span className="mono" style={{ color: 'var(--text-0)', whiteSpace: 'nowrap' }}>{fmt(r.amount)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="modal-footer" style={{ marginTop: 12, flexShrink: 0 }}>
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function PLStat({ label, value, color, negative, bold }: { label: string; value: number; color: string; negative?: boolean; bold?: boolean }) {
  return (
    <div className="kpi-card" style={{ padding: 12 }}>
      <div className="kpi-label">{label}</div>
      <div className="mono" style={{ fontSize: '1.05rem', fontWeight: bold ? 700 : 600, color }}>
        {negative && value > 0 ? '−' : ''}{fmt(value)}
      </div>
    </div>
  )
}

// ── P&L statement block (income green, expenses RED, net gold) ─
function PnLHeading({ children }: { children: string }) {
  return <div style={{ fontSize: '.66rem', textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text-3)', fontWeight: 600, padding: '12px 4px 2px' }}>{children}</div>
}

type PnLKind = 'income' | 'expense' | 'total-in' | 'total-out' | 'net'
function PnLLine({ label, value, kind }: { label: string; value: number; kind: PnLKind }) {
  const isExpense = kind === 'expense' || kind === 'total-out'
  const isTotal   = kind === 'total-in' || kind === 'total-out' || kind === 'net'
  const color = kind === 'net' ? (value >= 0 ? 'var(--gold)' : 'var(--red)')
    : (kind === 'income' || kind === 'total-in') ? 'var(--green)'
    : 'var(--red)'
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      padding: kind === 'net' ? '8px 6px 2px' : '5px 6px',
      fontSize: kind === 'net' ? '.96rem' : '.82rem',
      borderTop: kind === 'net' ? '2px solid var(--border-1)' : isTotal ? '1px solid var(--border-0)' : undefined,
      marginTop: kind === 'net' ? 6 : 0,
    }}>
      <span style={{ color: isTotal ? 'var(--text-0)' : 'var(--text-2)', fontWeight: isTotal ? 700 : 400 }}>{label}</span>
      <span className="mono" style={{ color, fontWeight: isTotal ? 700 : 600 }}>
        {isExpense ? '−' : ''}{fmt(Math.abs(value))}
      </span>
    </div>
  )
}

function PnLStatement({ s, periodLabel }: { s: any; periodLabel: string }) {
  return (
    <div className="card">
      <div className="card-header"><span className="card-title">Profit &amp; Loss — {periodLabel}</span></div>
      <div style={{ padding: '2px 8px 14px' }}>
        <PnLHeading>Income</PnLHeading>
        <PnLLine label="Rent collected" value={Number(s?.rentCollected || 0)} kind="income" />
        {Number(s?.otherIncome) > 0 && <PnLLine label="Other income (fees, utilities, late fees)" value={Number(s.otherIncome)} kind="income" />}
        <PnLLine label="Total income" value={Number(s?.totalIncome || 0)} kind="total-in" />

        <PnLHeading>Expenses</PnLHeading>
        <PnLLine label="GAM platform fee" value={Number(s?.totalPlatformFees || 0)} kind="expense" />
        <PnLLine label="Maintenance" value={Number(s?.totalMaintCost || 0)} kind="expense" />
        <PnLLine label="Total expenses" value={Number(s?.totalExpenses || 0)} kind="total-out" />

        <PnLLine label="Net to Owner" value={Number(s?.netToOwner || 0)} kind="net" />
        {Number(s?.depositsCollected) > 0 && (
          <div style={{ fontSize: '.68rem', color: 'var(--text-3)', padding: '8px 6px 0' }}>
            Deposits collected (held in custody, not income): {fmt(s.depositsCollected)}
          </div>
        )}
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
  income:   { rent: number; fees: number; utilities: number; homeSale: number; other: number; total: number }
  expenses: { maintenance: number; entered: number; platformFee: number; total: number; byCategory: Record<string, number> }
  net: number
  occupiedUnits: number
  derived: { netPerUnit: number | null; costPerUnit: number | null; incomePerUnit: number | null; costPerDay: number; netPerDay: number }
}
interface EngineResult {
  rows: EngineRow[]
  totals: EngineRow
  meta: { start: string; end: string; level: RLevel; bucket: RBucket; platformFeeIncluded: boolean; report?: string; note?: string }
}

const money = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/** Default range: the last 12 complete months, matching the T-12 convention
 *  (a half-finished current month makes income look worse than it is). */
function defaultRange(): { start: string; end: string } {
  const now = new Date()
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1))
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return { start: iso(start), end: iso(end) }
}

function CustomReportTab() {
  const dflt = defaultRange()
  const [start, setStart]   = useState(dflt.start)
  const [end, setEnd]       = useState(dflt.end)
  const [level, setLevel]   = useState<RLevel>('property')
  const [bucket, setBucket] = useState<RBucket>('monthly')
  const [running, setRunning] = useState(false)
  const [error, setError]   = useState<string | null>(null)
  const [result, setResult] = useState<EngineResult | null>(null)
  const [title, setTitle]   = useState('Custom report')

  const run = async (path: string, label: string) => {
    setRunning(true); setError(null)
    try {
      const res = await apiGet<EngineResult>(path)
      const data = (res as any)?.data ?? res
      setResult(data)
      setTitle(label)
    } catch (e: any) {
      setError(e?.response?.data?.error?.message || e?.response?.data?.error || e?.message || 'Could not run that report')
      setResult(null)
    } finally { setRunning(false) }
  }

  const runCustom = () => {
    if (start > end) { setError('Start date must be on or before the end date.'); return }
    run(`/reports/query?start=${start}&end=${end}&level=${level}&bucket=${bucket}`, 'Custom report')
  }
  const runT12 = () => run('/reports/t12', 'Trailing 12 months (T-12)')

  const exportCsv = () => {
    if (!result) return
    const header = [
      'Period', 'Property', 'Unit',
      'Rent', 'Fees', 'Utilities', 'Home sale', 'Other income', 'Total income',
      'Maintenance', 'Expenses', 'Platform fee', 'Total expenses',
      'Net', 'Occupied units', 'Net / unit', 'Cost / unit',
    ]
    const body = result.rows.map(r => [
      r.period ?? 'Total', r.propertyName ?? '', r.unitNumber ?? '',
      r.income.rent, r.income.fees, r.income.utilities, r.income.homeSale, r.income.other, r.income.total,
      r.expenses.maintenance, r.expenses.entered, r.expenses.platformFee, r.expenses.total,
      r.net, r.occupiedUnits, r.derived.netPerUnit ?? '', r.derived.costPerUnit ?? '',
    ])
    const t = result.totals
    body.push([
      'TOTAL', '', '',
      t.income.rent, t.income.fees, t.income.utilities, t.income.homeSale, t.income.other, t.income.total,
      t.expenses.maintenance, t.expenses.entered, t.expenses.platformFee, t.expenses.total,
      t.net, t.occupiedUnits, t.derived.netPerUnit ?? '', t.derived.costPerUnit ?? '',
    ])
    const name = (result.meta.report === 'T-12' ? 't12' : 'report')
      + `_${result.meta.start}_to_${result.meta.end}.csv`
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
            <button className="btn btn-primary" onClick={exportCsv}>Export CSV</button>
          )}
        </div>
        <div style={{ marginTop: 10, fontSize: '.75rem', color: 'var(--text-2)' }}>
          Security deposits are excluded — they are your tenants' money held, not income.
          Repair costs count only once an actual cost is recorded, never estimates.
        </div>
      </div>

      {error && <div className="alert a-warn" style={{ marginBottom: 14 }}>{error}</div>}

      {result && result.meta.report === 'T-12' && (
        <T12Statement result={result} propertyName={null} />
      )}

      {result && result.meta.report !== 'T-12' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
            <h3 style={{ margin: 0 }}>{title}</h3>
            <div style={{ fontSize: '.75rem', color: 'var(--text-2)' }}>
              {result.meta.start} → {result.meta.end}
            </div>
          </div>
          {result.meta.note && (
            <div style={{ fontSize: '.75rem', color: 'var(--text-2)', marginTop: 6 }}>{result.meta.note}</div>
          )}
          {!result.meta.platformFeeIncluded && (
            <div className="alert a-warn" style={{ marginTop: 10, fontSize: '.75rem' }}>
              The GAM platform fee is billed monthly, so it can't be split across individual days.
              It is not included in this day-by-day view — switch to month-by-month to see it.
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
                    <th style={{ textAlign: 'right' }}>Income</th>
                    <th style={{ textAlign: 'right' }}>Repairs</th>
                    <th style={{ textAlign: 'right' }}>Expenses</th>
                    <th style={{ textAlign: 'right' }}>Platform fee</th>
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
                      <td style={{ textAlign: 'right', color: r.net < 0 ? 'var(--danger)' : undefined }}>{money(r.net)}</td>
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
  )
}

// ── T-12 STATEMENT (S603) ─────────────────────────────────────
// A real trailing-twelve is read line-items-DOWN, months-ACROSS — that is the
// shape an agent, buyer, appraiser, or lender expects. The engine returns one
// row per (month × property), so this transposes it and lets the existing print
// styling (PrintStyles strips the app chrome) produce a clean PDF via print.
function T12Statement({ result, propertyName }: { result: EngineResult; propertyName: string | null }) {
  const months = [...new Set(result.rows.map(r => r.period).filter(Boolean))].sort() as string[]

  // Sum a measure for one month across whatever properties are in scope.
  const at = (m: string, pick: (r: EngineRow) => number) =>
    result.rows.filter(r => r.period === m).reduce((s, r) => s + pick(r), 0)

  // Expense categories actually present — never print an empty line item.
  const categories = [...new Set(
    result.rows.flatMap(r => Object.keys(r.expenses.byCategory)),
  )].sort()

  const lines: { label: string; get: (m: string) => number; strong?: boolean; indent?: boolean }[] = [
    { label: 'Rent',                 get: m => at(m, r => r.income.rent), indent: true },
    { label: 'Fees',                 get: m => at(m, r => r.income.fees), indent: true },
    { label: 'Utilities reimbursed', get: m => at(m, r => r.income.utilities), indent: true },
    { label: 'Other income',         get: m => at(m, r => r.income.homeSale + r.income.other), indent: true },
    { label: 'Total income',         get: m => at(m, r => r.income.total), strong: true },
    { label: 'Repairs & maintenance', get: m => at(m, r => r.expenses.maintenance), indent: true },
    ...categories.map(c => ({
      label: EXPENSE_CATEGORY_LABEL[c as keyof typeof EXPENSE_CATEGORY_LABEL] ?? c,
      get: (m: string) => at(m, r => r.expenses.byCategory[c] ?? 0),
      indent: true,
    })),
    { label: 'Platform fee',   get: m => at(m, r => r.expenses.platformFee), indent: true },
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
        <ToolbarBtn onClick={() => window.print()} icon={<Printer size={14} />} label="Print / Save PDF" />
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
        <strong>Basis of preparation.</strong> Twelve complete months; the current partial month is
        excluded. Income is counted on the date payment settled. Security deposits are excluded —
        they are tenant funds held, not income. Repairs are included only where an actual cost was
        recorded; estimates are excluded. Costs not tied to a specific unit are shown at the
        property. Prepared from the operator's own records and unaudited.
      </div>
    </div>
  )
}
