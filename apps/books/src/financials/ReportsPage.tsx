// 10/11 (Nic): one of the shared financial pages — the same bytes in the
// landlord portal and GAM Books (financials-parity.test.ts). The owner sees
// every tab; a bookkeeper sees the P&L tabs (Overview, By Property), and the
// API refuses them the rest. 10/11 (Nic): tenant names show to a bookkeeper
// too (who paid is half of keeping the books); the API sends them no tenant
// email, phone or address, and no maintenance request's words.
//
// 10/12 (Nic): "NO Money received / Money billed toggle anywhere — show
// Charged, Received and Owed side by side as columns, with a short line
// showing how they tie." The switch above the tabs is gone; every report shows
// the three columns, the tie line under them, and the net on each money
// column. The monthly P&L's "money by the day it arrived" is ONE line per day
// with that day's total and the expenses logged that day under it; a day opens
// to who paid on screen, and the printout keeps the daily totals only.
// 10/12 (Nic, L2): "Received leads" — every table reads Received, Charged,
// Owed (the shared MONEY_COLUMNS order, ThreeCells) and every net leads with
// Received less expenses. And the Monthly report tab: the monthly property report (all four groups) as a
// printable page and a PDF, with the owner's list of who it is emailed to.
import { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import {
  humanize, UNIT_TYPE_LABEL, UNIT_STATUS_LABEL, MAINTENANCE_STATUS_LABEL, PAYMENT_STATUS_LABEL,
  PAYMENT_STAMP_LETTER, MONEY_COLUMN_LABEL, INCOME_REPORT_VIEWS, INCOME_REPORT_VIEW_LABEL,
  type PaymentStatus, type PaymentStamp, type MoneyColumn, type IncomeReportView,
} from '@gam/shared'
import { finGet as apiGet, finPost, openProtectedFile, useViewer, toast, toastError } from './adapter'
// S633: tax + statement documents belong to ONE company; the picker renders
// nothing for an account that owns a single one.
import { EntityPicker, useEntities } from './EntityPicker'
import {
  moneyColumns, moneyCardView, sumThree, netsOf,
  activeCategories, categoryLabel, categoryThree, expenseLines, expenseCategoryLabel,
  noChargeRemainder, sumAmounts, INCOME_LINES_ORDER, incomeLineLabel, type ExpenseLine,
  usDay, chargeDay, chargeKey, reportErrorText, latestOnly, PAID_AHEAD_COUNTED_NOTE, PAID_AHEAD_ON_HAND_KEY,
  lastTwelveMonths, lastMonthKey, dayRows, expensesLoggedText,
  type CategoryRow, type ChargeRow, type BesideItem, type MoneyView, type MoneyThree, type DayLine,
} from './incomeBasis'
import './reports-basis.css'

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
const COLS = moneyColumns()

// ── Export helpers ────────────────────────────────────────────
function downloadCsv(filename: string, header: string[], rows: (string | number | null | undefined)[][]) {
  // 10/12: a field that starts like a formula is opened as one by a
  // spreadsheet (a resident named "=HYPERLINK(…)"), so it reads as text.
  const esc = (v: any) => {
    const raw = v == null ? '' : String(v)
    const s = typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${raw}` : raw
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
// to PDF, so a landlord gets a clean statement for their accountant. 10/12:
// the three-column tables, the daily lines and the monthly report's stamps
// live here too (the shared stylesheet stays as it was).
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
        /* 10/12: a modal printed on its own (the monthly P&L), without the page under it. */
        .rb-print-hide { display: none !important; }
        .modal-overlay.rb-printable { position: static !important; background: none !important; display: block !important; padding: 0 !important; }
        .modal-overlay.rb-printable .modal { width: auto !important; max-width: none !important; max-height: none !important; overflow: visible !important; box-shadow: none !important; border: none !important; }
        .modal-overlay.rb-printable .rb-modal-body { overflow: visible !important; }
        .rb-stamp-chip { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        .rb-mr-property { break-before: page; }
        .rb-mr-property:first-of-type { break-before: auto; }
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
      /* 10/12 (Nic): the three columns. */
      .rb-legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: -6px 0 16px; font-size: .74rem; color: var(--text-3); line-height: 1.45; }
      .rb-legend strong { color: var(--text-1); font-weight: 700; }
      .rb-three th.rb-num, .rb-three td.rb-num { min-width: 92px; }
      .rb-three tfoot td, .rb-three tr.rb-total td { border-top: 2px solid var(--border-1); font-weight: 700; color: var(--text-0); }
      .rb-three tr.rb-net td { font-weight: 700; color: var(--gold); border-top: 1px solid var(--border-0); }
      .rb-three tr.rb-sub td:first-child { padding-left: 22px; color: var(--text-2); }
      .rb-three td.rb-blank { color: var(--text-3); }
      .rb-tie { margin: 8px 6px 2px; font-size: .74rem; color: var(--text-2); line-height: 1.55; }
      .rb-tie p { margin: 0 0 3px; }
      .rb-pos { color: var(--green); }
      .rb-neg { color: var(--red); }
      .rb-owed { color: var(--amber); }
      /* One line per day (the monthly P&L). */
      .rb-day { border-bottom: 1px solid var(--border-0); }
      .rb-day:last-child { border-bottom: none; }
      .rb-day-line { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 6px; background: none; border: none; color: var(--text-1); font: inherit; cursor: pointer; text-align: left; }
      .rb-day-line:hover { background: var(--bg-3); }
      .rb-day-line[aria-expanded="true"] .rb-day-caret { transform: rotate(90deg); }
      .rb-day-caret { color: var(--text-3); font-size: .7rem; width: 12px; transition: transform .12s; }
      .rb-day-date { font-size: .8rem; font-weight: 700; color: var(--text-0); flex: 1 1 auto; min-width: 0; }
      .rb-day-count { font-size: .7rem; color: var(--text-3); white-space: nowrap; }
      .rb-day-total { font-family: var(--font-mono); font-size: .8rem; color: var(--green); white-space: nowrap; }
      .rb-day-expense { padding: 0 6px 8px 28px; font-size: .74rem; color: var(--red); }
      .rb-day-detail { padding: 0 6px 8px 28px; }
      /* The monthly report. */
      .rb-mr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; padding: 4px 4px 10px; }
      .rb-mr-fig { background: var(--bg-2); border: 1px solid var(--border-0); border-radius: 8px; padding: 10px 12px; min-width: 0; }
      .rb-mr-fig-label { font-size: .66rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-3); font-weight: 600; }
      .rb-mr-fig-value { font-family: var(--font-mono); font-size: 1rem; font-weight: 700; color: var(--text-0); margin-top: 2px; }
      .rb-mr-fig-sub { font-size: .68rem; color: var(--text-3); margin-top: 2px; }
      .rb-mr-section-title { font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; color: var(--gold); font-weight: 700; margin: 14px 4px 8px; }
      .rb-stamps { display: flex; flex-wrap: wrap; gap: 8px 14px; padding: 2px 4px 10px; }
      .rb-stamp-count { display: inline-flex; align-items: center; gap: 6px; font-size: .8rem; color: var(--text-1); font-weight: 600; }
      .rb-stamp-chip { display: inline-flex; align-items: center; justify-content: center; min-width: 26px; height: 22px; padding: 0 5px; border-radius: 6px; font-family: var(--font-mono); font-size: .7rem; font-weight: 700; color: #fff; }
      .rb-stamp-chip.paid_on_time { background: var(--green); } /* wire-ok: a stamp's enum value as a class name */
      .rb-stamp-chip.partial { background: var(--rb-yellow, #eab308); color: #1a1a1a; }
      .rb-stamp-chip.paid_late { background: var(--rb-orange, #f97316); } /* wire-ok: a stamp's enum value as a class name */
      .rb-stamp-chip.outstanding { background: var(--red); }
      .rb-stamp-chip.due { background: var(--text-3); }
      .rb-recip { display: flex; flex-direction: column; gap: 6px; padding: 4px 4px 8px; }
      .rb-recip-row { display: flex; align-items: center; gap: 10px; font-size: .82rem; color: var(--text-1); flex-wrap: wrap; }
      .rb-recip-row input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--gold); }
      .rb-recip-meta { font-size: .72rem; color: var(--text-3); }
      .rb-recip-add { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .rb-recip-add .input { flex: 1 1 220px; min-width: 0; }
      .rb-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--border-1); font-size: .76rem; color: var(--text-1); }
      .rb-chip button { background: none; border: none; color: var(--text-3); cursor: pointer; font-size: .9rem; line-height: 1; padding: 0; }
    `}</style>
  )
}

// 10/11: no icon set here — this page renders in GAM Books too, which has
// none. The words carry the action.
const ToolbarBtn = ({ onClick, label, disabled }: { onClick: () => void; label: string; disabled?: boolean }) => (
  <button className="btn btn-primary btn-sm no-print" onClick={onClick} disabled={disabled} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
    {label}
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
    <div className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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

/**
 * 10/12 (Nic): what each column counts, once, under the page title (prints
 * too). 10/12 (ledger P8): once the reports read the company's books, Owed is
 * what tenants still owed at the end of the period, and the line under each
 * table shows how it got there.
 */
function MoneyLegend() {
  const { data } = useQuery<any>(['reports-ledger-status'], () => apiGet('/reports/ledger-status'))
  const cols = data?.live ? moneyColumns(true) : COLS
  return (
    <div className="rb-legend">
      {cols.map(c => <span key={c.key}><strong>{c.label}</strong> — {c.note}</span>)}
    </div>
  )
}

/** How the columns tie, in the server's own words. */
function TieLines({ lines }: { lines: string[] | null | undefined }) {
  if (!lines?.length) return null
  return <div className="rb-tie">{lines.map(l => <p key={l}>{l}</p>)}</div>
}

// ── OVERVIEW CHARTS (charged vs received by month + YTD) ──────
// Hand-rolled SVG so there's no charting dependency and it inherits the
// gold/dark theme. Both render inline — no download or print needed.
interface MonthPoint { m: number; label: string; charged: number; received: number; cumCharged: number; cumReceived: number }

function seriesFor(year: number, upto: number, rows: Array<{ month: string; collected: number; charged?: number }>): MonthPoint[] {
  const byMonth = new Map(rows.map(m => [m.month, m]))
  const out: MonthPoint[] = []
  let cc = 0, cr = 0
  for (let m = 1; m <= upto; m++) {
    const r = byMonth.get(`${year}-${String(m).padStart(2, '0')}`)
    const charged = Number(r?.charged ?? 0), received = Number(r?.collected ?? 0)
    cc += charged; cr += received
    out.push({ m, label: MONTHS_SHORT[m - 1], charged, received, cumCharged: cc, cumReceived: cr })
  }
  return out
}

function CollectionsCharts({ ytdMonthly, ytd }: {
  ytdMonthly: Array<{ month: string; collected: number; charged?: number }>
  ytd: MoneyThree
}) {
  const now = new Date()
  const year = now.getFullYear()
  const upto = now.getMonth() + 1 // 1..12, current month
  const series = seriesFor(year, upto, ytdMonthly)
  const hasData = series.some(s => s.charged !== 0 || s.received !== 0)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: 16 }}>
      <div className="card">
        <div className="card-header">
          <span className="card-title">{MONEY_COLUMN_LABEL.received} and {MONEY_COLUMN_LABEL.charged.toLowerCase()} by month — {year}</span>
          <ChartKey />
        </div>
        <div style={{ padding: '12px 12px 6px' }}>
          {hasData ? <BarChart series={series} current={upto} /> : <EmptyChart />}
        </div>
      </div>
      <div className="card">
        <div className="card-header">
          <span className="card-title">Year to date, added up — {year}</span>
          <span style={{ fontSize: '.7rem', color: 'var(--gold)' }}>{MONEY_COLUMN_LABEL.received} {fmt0(ytd.received)} · {MONEY_COLUMN_LABEL.charged} {fmt0(ytd.charged)}</span>
        </div>
        <div style={{ padding: '12px 12px 6px' }}>
          {hasData ? <AreaChart series={series} /> : <EmptyChart />}
        </div>
      </div>
    </div>
  )
}

const ChartKey = () => (
  <span style={{ display: 'flex', gap: 10, fontSize: '.68rem', color: 'var(--text-3)' }}>
    <span><span style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--gold)', marginRight: 4 }} />{MONEY_COLUMN_LABEL.received}</span>
    <span><span style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--text-3)', opacity: .5, marginRight: 4 }} />{MONEY_COLUMN_LABEL.charged}</span>
  </span>
)

const EmptyChart = () => (
  <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontSize: '.8rem' }}>
    Nothing received or charged yet this year.
  </div>
)

// Paired bars: received (gold) first, then charged (muted) — 10/12 (Nic, L2):
// Received leads; the current month brightest.
function BarChart({ series, current }: { series: Array<{ label: string; charged: number; received: number; m: number }>; current: number }) {
  const W = 520, H = 200, padL = 8, padR = 8, padT = 14, padB = 22
  const chartW = W - padL - padR, chartH = H - padT - padB
  const max = Math.max(...series.map(s => Math.max(s.charged, s.received)), 1)
  const slot = chartW / Math.max(series.length, 1)
  const bw = Math.min(slot * 0.32, 22)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Received and charged by month">
      <line x1={padL} y1={padT + chartH} x2={W - padR} y2={padT + chartH} stroke="var(--border-1)" strokeWidth={1} />
      {series.map((s, i) => {
        const x0 = padL + i * slot + (slot - bw * 2 - 3) / 2
        const hc = (Math.max(s.charged, 0) / max) * chartH
        const hr = (Math.max(s.received, 0) / max) * chartH
        const isCurrent = s.m === current
        return (
          <g key={s.m}>
            <title>{`${s.label}: received ${fmt(s.received)}, charged ${fmt(s.charged)}`}</title>
            <rect x={x0} y={padT + chartH - hr} width={bw} height={Math.max(hr, 1)} rx={2}
              fill={isCurrent ? 'var(--gold)' : 'var(--gold-dim)'} opacity={isCurrent ? 1 : 0.75} />
            <rect x={x0 + bw + 3} y={padT + chartH - hc} width={bw} height={Math.max(hc, 1)} rx={2} fill="var(--text-3)" opacity={0.45} />
            <text x={x0 + bw + 1.5} y={H - 7} textAnchor="middle" fontSize={9} fill="var(--text-3)">{s.label}</text>
          </g>
        )
      })}
    </svg>
  )
}

// Cumulative received (gold, filled) and charged (muted line), ending dot at the YTD received total.
function AreaChart({ series }: { series: MonthPoint[] }) {
  const W = 520, H = 200, padL = 8, padR = 8, padT = 14, padB = 22
  const chartW = W - padL - padR, chartH = H - padT - padB
  const max = Math.max(...series.map(s => Math.max(s.cumReceived, s.cumCharged)), 1)
  const xAt = (i: number) => series.length <= 1 ? padL + chartW / 2 : padL + (i / (series.length - 1)) * chartW
  const yAt = (v: number) => padT + chartH - (v / max) * chartH
  const ptsR = series.map((s, i) => `${xAt(i)},${yAt(s.cumReceived)}`).join(' ')
  const ptsC = series.map((s, i) => `${xAt(i)},${yAt(s.cumCharged)}`).join(' ')
  const area = `${padL},${padT + chartH} ${ptsR} ${xAt(series.length - 1)},${padT + chartH}`
  const last = series[series.length - 1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Received and charged, added up, year to date">
      <line x1={padL} y1={padT + chartH} x2={W - padR} y2={padT + chartH} stroke="var(--border-1)" strokeWidth={1} />
      <polygon points={area} fill="var(--gold)" opacity={0.12} />
      <polyline points={ptsC} fill="none" stroke="var(--text-3)" strokeWidth={1.5} strokeDasharray="4 3" />
      <polyline points={ptsR} fill="none" stroke="var(--gold)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {series.map((s, i) => (
        <g key={s.m}><title>{`${s.label}: received ${fmt(s.cumReceived)}, charged ${fmt(s.cumCharged)}`}</title>
          <circle cx={xAt(i)} cy={yAt(s.cumReceived)} r={i === series.length - 1 ? 3.5 : 2}
            fill={i === series.length - 1 ? 'var(--gold)' : 'var(--gold-dim)'} />
        </g>
      ))}
      {series.map((s, i) => (
        <text key={'l' + s.m} x={xAt(i)} y={H - 7} textAnchor="middle" fontSize={9} fill="var(--text-3)">{s.label}</text>
      ))}
      {last && <text x={xAt(series.length - 1)} y={Math.max(yAt(last.cumReceived) - 7, 10)} textAnchor="end" fontSize={9} fill="var(--gold)">{fmt(last.cumReceived)}</text>}
    </svg>
  )
}

// ══════════════════════════════════════════════════════════════
// REPORTS PAGE — tabbed
// ══════════════════════════════════════════════════════════════
type Tab = 'overview' | 'property' | 'monthly' | 'annual' | 'statement' | 'custom'
const TABS: { key: Tab; label: string; perm: string }[] = [
  { key: 'overview',  label: 'Overview',        perm: 'reports.tab.overview' },
  { key: 'property',  label: 'By Property',     perm: 'reports.tab.property' },
  { key: 'monthly',   label: 'Monthly report',  perm: 'reports.tab.monthly' },
  { key: 'annual',    label: 'Annual & Tax',    perm: 'reports.tab.annual' },
  { key: 'statement', label: 'Owner Statement', perm: 'reports.tab.statement' },
  { key: 'custom',    label: 'Custom & T-12',   perm: 'reports.tab.custom' },
]

/** ?tab= and ?month= from the address (the monthly report email links straight to its tab). */
function linkParams(): { tab: Tab | null; month: string | null } {
  try {
    const q = new URLSearchParams(window.location.search)
    const t = q.get('tab')
    const m = q.get('month')
    return {
      tab: TABS.some(x => x.key === t) ? t as Tab : null,
      month: m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m : null,
    }
  } catch {
    return { tab: null, month: null }
  }
}

export function ReportsPage() {
  const [tab, setTab] = useState<Tab>(() => linkParams().tab ?? 'overview')
  const { can } = useViewer()

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
      <MoneyLegend />
      <div className="no-print" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-0)', marginBottom: 18, overflowX: 'auto' }}>
        {visibleTabs.map(t => (
          <button key={t.key} className={`tab-btn ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === 'overview'  && can('reports.tab.overview')  && <OverviewTab />}
      {tab === 'property'  && can('reports.tab.property')  && <ByPropertyTab />}
      {tab === 'monthly'   && can('reports.tab.monthly')   && <MonthlyReportTab />}
      {tab === 'annual'    && can('reports.tab.annual')    && <AnnualTaxTab />}
      {tab === 'statement' && can('reports.tab.statement') && <OwnerStatementTab />}
      {tab === 'custom'    && can('reports.tab.custom')    && <CustomReportTab />}
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
  // 10/11: a bookkeeper's company is fixed by the server; never wait on a list
  // that is not fetched for them.
  const { isBookkeeper } = useViewer()
  const settled = isFetched || isError || isBookkeeper
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

/** A money cell: green when money in, red when it takes money off. */
function Cell({ v, kind }: { v: number | null | undefined; kind?: 'owed' | 'net' | 'plain' }) {
  const n = Number(v ?? 0)
  const cls = kind === 'owed' ? (n ? 'rb-owed' : '') : kind === 'net' ? (n < 0 ? 'rb-neg' : '') : n < 0 ? 'rb-neg' : ''
  return <td className={`rb-num ${cls}`}>{v == null ? '—' : fmt(n)}</td>
}

/**
 * 10/12 (Nic, L2): a row's three money cells in the columns' own order
 * (COLS, the shared MONEY_COLUMNS: Received leads, then Charged, then Owed),
 * so a row can never sit under the wrong header. An absent figure prints "—".
 */
function ThreeCells({ v }: { v: Partial<Record<MoneyColumn, number | null | undefined>> }) {
  return <>{COLS.map(c => <Cell key={c.key} v={v[c.key]} kind={c.key === 'owed' ? 'owed' : undefined} />)}</>
}

// ── OVERVIEW (S69 + S512 #20 drill-in) ────────────────────────
function OverviewTab() {
  const { data: report, isLoading, error } = useQuery<any>(['reports-summary'], () => apiGet('/reports/summary'))
  const [openMonth, setOpenMonth] = useState<string | null>(null)
  // 10/11: the card opens the owner's Balances page where there is one to open.
  const { openOwnerPage } = useViewer()
  // 10/12 (Nic): this month's Charged, Received and Owed side by side — the
  // same card the dashboard shows — and how they tie.
  const card = moneyCardView(report?.incomeCard, fmt)
  const ytd: MoneyThree = report?.ytd ?? { charged: 0, received: Number(report?.ytdCollected || 0), owed: 0 }

  return (
    <>
      <div className={openMonth ? 'rb-print-hide' : undefined}>
      {error ? <ReportError error={error} what="the summary" /> : isLoading ? <div style={{padding:32,color:'var(--text-3)',textAlign:'center'}}>Loading…</div> : (
        <div className="rb-stack" style={{gap:16}}>
          <div className="rb-kpis">
            <div className="kpi-card"><div className="kpi-label">{MONEY_COLUMN_LABEL.received} this month</div><div className="kpi-value green">{fmt0(card.received)}</div></div>
            <div className="kpi-card"><div className="kpi-label">{MONEY_COLUMN_LABEL.charged} this month</div><div className="kpi-value">{fmt0(card.charged)}</div></div>
            {/* Decision #25: Owed is a grand total of what everyone owes; the server
                leaves it out for a viewer who sees no grand totals, and so does the card. */}
            {report?.thisMonth?.owed != null && (
              <div className="kpi-card"><div className="kpi-label">{MONEY_COLUMN_LABEL.owed} of this month's bills</div><div className="kpi-value" style={{color:'var(--amber)'}}>{fmt0(card.owed)}</div></div>
            )}
            <div className="kpi-card"><div className="kpi-label">This year</div><div className="kpi-value" style={{color:'var(--gold)'}}>{fmt0(ytd.received)}</div><div className="kpi-sub">received · {fmt0(ytd.charged)} charged</div></div>
            {/* S527 W-38: click through to the who-owes-what list (same target as the dashboard KPI). */}
            {/* Decision #25: a grand total of what everyone owes is for owners and
                property managers only; when the server leaves it out, so does the card. */}
            {report?.outstanding != null && (
              <div className="kpi-card" style={{cursor: openOwnerPage ? 'pointer' : 'default'}} onClick={()=>openOwnerPage?.('/balances')}><div className="kpi-label">Outstanding Balance</div><div className="kpi-value" style={{color:'var(--amber)'}}>{fmt0(report.outstanding)}</div><div className="kpi-sub">every month still owed</div></div>
            )}
            <div className="kpi-card"><div className="kpi-label">Occupancy Rate</div><div className="kpi-value">{report?.occupancyRate != null ? `${report.occupancyRate}%` : '—'}</div></div>
          </div>
          <TieLines lines={report?.thisMonth?.tieText ?? card.notes} />
          <CollectionsCharts ytdMonthly={report?.ytdMonthly ?? []} ytd={ytd} />
          <div className="card">
            <div className="card-header"><span className="card-title">Monthly Breakdown</span></div>
            <div style={{padding:'4px 0 16px'}}>
              <div style={{fontSize:'.72rem',color:'var(--text-3)',padding:'0 0 10px'}}>Click a month to open its profit &amp; loss and the money behind it.</div>
              <div className="data-table-wrap">
                <table className="data-table rb-three">
                  {/* "Net" IS the net of the P&L the row opens: each money column less
                      GAM's platform fee, maintenance, lot rent, your expenses and the
                      payment processing fees you cover. */}
                  <thead><tr>
                    <th>Month</th>
                    {COLS.map(c => <th key={c.key} className="rb-num">{c.label}</th>)}
                    <th className="rb-num">Expenses</th>
                    <th className="rb-num">Net on received</th>
                    <th className="rb-num">Net on charged</th>
                    <th className="rb-num" title="Paid out to your bank; the payout run's own fees on hover">Paid out</th>
                    <th></th>
                  </tr></thead>
                  <tbody>
                    {report?.monthly?.length ? report.monthly.map((m: any) => (
                      <tr key={m.month}
                          onClick={() => setOpenMonth(m.month)}
                          style={{cursor:'pointer'}}
                          title={`Open ${monthLabel(m.month)} P&L`}>
                        <td className="mono" style={{color:'var(--gold)',fontWeight:600}}>{monthLabel(m.month)}</td>
                        <ThreeCells v={{ received: m.received ?? m.collected, charged: m.charged, owed: m.owed }} />
                        <Cell v={m.expenses} />
                        <Cell v={m.netReceived ?? m.net} kind="net" />
                        <Cell v={m.netCharged} kind="net" />
                        <td className="rb-num" title={`Payout fees ${fmt(m.fees)}`}>{fmt(m.disbursed)}</td>
                        <td style={{color:'var(--text-3)',textAlign:'right'}}>›</td>
                      </tr>
                    )) : (
                      <tr><td colSpan={9} style={{textAlign:'center',color:'var(--text-3)',padding:32}}>No report data yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
      </div>
      {openMonth && <MonthlyPLModal month={openMonth} onClose={() => setOpenMonth(null)} />}
    </>
  )
}

// ── BY PROPERTY (per-property P&L) ────────────────────────────
function ByPropertyTab() {
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
  const { can } = useViewer()
  const qs = `year=${year}${month ? `&month=${month}` : ''}`
  const { data, isLoading, error } = useQuery<any>(['property-pl', year, month],
    () => apiGet(`/reports/property-pl?${qs}`))
  const props: any[] = data?.properties ?? []

  // S655: each row's net is its money column less platform fee − maintenance −
  // processing fees − lot rent − your expenses (the drill-in's nets, line for
  // line). 10/12 (Nic): the payment processing fees the landlord covers have
  // their own column, like every other place expenses are listed.
  const otherCosts = (p: any) => Number(p.lotRent || 0) + Number(p.enteredExpenses || 0)
  // 10/12 (Nic, G10): card fees guests got back with refunds sit with the
  // processing fees (both are card and bank fees the landlord pays).
  const procCosts = (p: any) => Number(p.processingFees || 0) + Number(p.cardFeesRefunded || 0)
  const three = (p: any): MoneyThree => ({
    charged: Number(p.charged ?? 0), received: Number(p.received ?? p.incomeTotal ?? p.rentCollected ?? 0), owed: Number(p.owed ?? 0),
  })
  // Decision #25: the server leaves Owed out for a viewer who sees no grand totals ("—").
  const hasOwed = props.some(p => p.owed != null)
  const totals = props.reduce((t, p) => ({
    ...sumThree([t, three(p)]),
    maint: t.maint + Number(p.maintCost || 0),
    plat: t.plat + Number(p.platformFees || 0),
    proc: t.proc + procCosts(p),
    other: t.other + otherCosts(p),
    netCharged: t.netCharged + Number(p.netCharged || 0),
    netReceived: t.netReceived + Number(p.netReceived ?? p.netIncome ?? 0),
  }), { charged: 0, received: 0, owed: 0, maint: 0, plat: 0, proc: 0, other: 0, netCharged: 0, netReceived: 0 })

  const periodLabel = month ? `${MONTHS[month - 1]} ${year}` : `Full year ${year}`

  const exportCsv = () => downloadCsv(
    `property-pl-${year}${month ? `-${String(month).padStart(2,'0')}` : ''}.csv`,
    ['Property', 'Occupied', 'Total units', 'Occupancy %', ...COLS.map(c => c.label), 'Maintenance', 'Platform fee',
     'Payment processing fees', 'Card fees refunded', 'Lot rent and your expenses', 'Net on received', 'Net on charged'],
    props.map(p => [p.leftOn ? `${p.name} (left ${usDay(p.leftOn)}, history only)` : p.name,
      p.leftOn ? '' : p.occupiedUnits, p.leftOn ? '' : p.totalUnits, p.leftOn ? '' : p.occupancyRate,
      ...COLS.map(c => c.key === 'owed' && !hasOwed ? '' : three(p)[c.key].toFixed(2)), Number(p.maintCost||0).toFixed(2),
      Number(p.platformFees||0).toFixed(2), Number(p.processingFees||0).toFixed(2), Number(p.cardFeesRefunded||0).toFixed(2), otherCosts(p).toFixed(2),
      Number(p.netReceived ?? p.netIncome ?? 0).toFixed(2), Number(p.netCharged||0).toFixed(2)]),
  )
  const minus = (n: number) => n > 0 ? `−${fmt(n)}` : fmt(n)
  const costCell = (n: number) => <td className="rb-num" style={{ color: n > 0 ? 'var(--red)' : 'var(--text-3)' }}>{minus(n)}</td>

  return (
    <div className="rb-stack">
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <PeriodPicker year={year} setYear={setYear} month={month} setMonth={setMonth} allowAll />
        {can('reports.export') && (
          <div style={{ display: 'flex', gap: 6 }}>
            <ToolbarBtn onClick={exportCsv} label="CSV" />
            <ToolbarBtn onClick={() => window.print()} label="Print" />
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
              <table className="data-table rb-three">
                <thead><tr>
                  <th>Property</th><th style={{textAlign:'center'}}>Occupancy</th>
                  {COLS.map(c => <th key={c.key} className="rb-num">{c.label}</th>)}
                  <th className="rb-num">Maint.</th><th className="rb-num">Platform fee</th>
                  <th className="rb-num" title="Payment processing fees you cover for tenants, and card fees given back with refunds">Processing fees</th>
                  <th className="rb-num" title="Lot rent and your expenses">Lot rent &amp; expenses</th>
                  <th className="rb-num">Net on received</th><th className="rb-num">Net on charged</th><th></th>
                </tr></thead>
                <tbody>
                  {props.length ? props.map((p: any) => (
                    <tr key={p.id} onClick={() => setOpenProp({ id: p.id, name: p.name })}
                        style={{ cursor: 'pointer' }} title={`Open ${p.name} detail`}>
                      {/* 10/12: a bookkeeper's former property (sold or moved out while
                          they kept it) is its history: no units or occupancy today
                          (the new owner's), and the last day it was the company's. */}
                      <td style={{ color: 'var(--text-0)', fontWeight: 600 }}>
                        {p.name}
                        {p.leftOn && <div style={{ fontSize: '.7rem', fontWeight: 400, color: 'var(--text-3)' }}>Left {usDay(p.leftOn)} · history only</div>}
                      </td>
                      <td className="mono" style={{ textAlign: 'center' }}>{p.leftOn ? '—' : `${p.occupiedUnits}/${p.totalUnits} (${p.occupancyRate}%)`}</td>
                      <ThreeCells v={{ ...three(p), owed: hasOwed ? three(p).owed : null }} />
                      {costCell(Number(p.maintCost || 0))}
                      {costCell(Number(p.platformFees || 0))}
                      {costCell(procCosts(p))}
                      {costCell(otherCosts(p))}
                      <Cell v={p.netReceived ?? p.netIncome} kind="net" />
                      <Cell v={p.netCharged} kind="net" />
                      <td style={{ color: 'var(--text-3)', textAlign: 'right' }}>›</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={12} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>No properties yet.</td></tr>
                  )}
                </tbody>
                {props.length > 0 && (
                  <tfoot>
                    <tr>
                      <td>Total</td>
                      <td></td>
                      <ThreeCells v={{ received: totals.received, charged: totals.charged, owed: hasOwed ? totals.owed : null }} />
                      {costCell(totals.maint)}
                      {costCell(totals.plat)}
                      {costCell(totals.proc)}
                      {costCell(totals.other)}
                      <Cell v={totals.netReceived} kind="net" />
                      <Cell v={totals.netCharged} kind="net" />
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
      {openProp && <PropertyDetailModal propertyId={openProp.id} name={openProp.name} year={year} month={month} onClose={() => setOpenProp(null)} />}
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
// the breakdown: income by category (10/12: Charged, Received and Owed side by
// side), then expenses as line items, then the nets. The rent roll, payments
// and maintenance lists come after, collapsed ("way too long").
function PropertyDetailModal({ propertyId, name, year, month, onClose }: {
  propertyId: string; name: string; year: number; month: number | null; onClose: () => void
}) {
  const qs = `propertyId=${propertyId}&year=${year}${month ? `&month=${month}` : ''}`
  const { data, isLoading, error } = useQuery<any>(['property-detail', propertyId, year, month],
    () => apiGet(`/reports/property-detail?${qs}`))
  const periodLabel = month ? `${MONTHS[month - 1]} ${year}` : `Full year ${year}`
  // 10/11 (Nic): a bookkeeper reads the rent roll with names, but a repair as
  // its cost and kind — never the request's own words (the API sends none).
  const { isBookkeeper } = useViewer()

  // Zero-filled 12-month trend for the mini bar chart; highlight selected month.
  const byMonth = new Map<string, any>((data?.monthlyTrend ?? []).map((t: any) => [t.month, t]))
  const trend = Array.from({ length: 12 }, (_, i) => {
    const t = byMonth.get(`${year}-${String(i + 1).padStart(2, '0')}`)
    return { m: i + 1, label: MONTHS_SHORT[i], charged: Number(t?.charged ?? 0), received: Number(t?.collected ?? 0) }
  })
  const hasTrend = trend.some(t => t.charged !== 0 || t.received !== 0)
  const units: any[] = data?.units ?? []
  const payments: any[] = data?.payments ?? []
  const maintenance: any[] = data?.maintenance ?? []
  const expenses = data?.expenses
  const view: MoneyView | undefined = data?.view
  const nets = data?.nets ?? netsOf(view, Number(expenses?.total || 0))

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal rb-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="modal-title" style={{ marginBottom: 2 }}>{name}</div>
            <div style={{ fontSize: '.74rem', color: 'var(--text-3)' }}>
              {periodLabel}
              {data?.property && !data.property.leftOn ? ` · ${data.property.city}, ${data.property.state} · ${data.property.occupiedUnits}/${data.property.totalUnits} occupied (${data.property.occupancyRate}%)` : ''}
              {data?.property?.leftOn ? ` · Left the company ${usDay(data.property.leftOn)}: its history up to that day, nothing after` : ''}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }} aria-label="Close">×</button>
        </div>

        <div className="rb-modal-body">
          {error ? <ReportError error={error} what="this property" /> : isLoading || !data ? (
            <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
          ) : (
            <>
              {/* 1. Income by category: Charged, Received and Owed side by side. */}
              <CategoryBreakdownCard
                title={`Income by category — ${periodLabel}`}
                categories={data?.breakdown?.categories ?? []}
                view={view}
              />

              {/* 2. Expenses as line items. */}
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-header"><span className="card-title">Expenses — {periodLabel}</span></div>
                {expenseLines(expenses).map(l => <PnLLine key={l.key} label={l.label} value={l.amount} kind="expense" />)}
                <PnLLine label="Total expenses" value={Number(expenses?.total || 0)} kind="total-out" />
                {/* 10/12 (Nic, ledger P8): on the books, what of them was paid in the period (the Received net takes it). */}
                {expenses?.paid != null && <PnLLine label="Of which paid in this period" value={Number(expenses.paid)} kind="expense" />}
              </div>

              {/* 3. The nets. */}
              <div className="card" style={{ marginBottom: 14 }}>
                <PnLLine label={`Net on ${MONEY_COLUMN_LABEL.received.toLowerCase()}`} value={Number(nets.received ?? data.net ?? 0)} kind="net" />
                <PnLLine label={`Net on ${MONEY_COLUMN_LABEL.charged.toLowerCase()}`} value={Number(nets.charged || 0)} kind="net" />
                <BesideFigures items={view?.beside} />
              </div>

              {hasTrend && (
                <div className="card" style={{ marginBottom: 14 }}>
                  <div className="card-header"><span className="card-title">{MONEY_COLUMN_LABEL.received} and {MONEY_COLUMN_LABEL.charged.toLowerCase()} by month — {year}</span><ChartKey /></div>
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
                <summary>Payments behind {MONEY_COLUMN_LABEL.received} ({payments.length})</summary>
                <div className="rb-collapse-body data-table-wrap">
                  <ChargesTable rows={payments} emptyText={`No money arrived in ${periodLabel}.`} />
                </div>
              </details>

              <details className="rb-collapse">
                <summary>Maintenance ({maintenance.length})</summary>
                <div className="rb-collapse-body data-table-wrap">
                  <table className="data-table">
                    {/* 10/11 (Nic): a bookkeeper sees the cost and its kind, never
                        the request's own words (the API sends no title to them). */}
                    <thead><tr><th>Unit</th><th>{isBookkeeper ? 'Kind' : 'Description'}</th><th className="rb-num">Cost</th></tr></thead>
                    <tbody>
                      {maintenance.length ? maintenance.map(m => (
                        <tr key={m.id}>
                          <td className="mono">{m.unitNumber ? `#${m.unitNumber}` : '—'}</td>
                          <td style={{ color: 'var(--text-2)' }}>{(isBookkeeper ? m.categoryLabel : m.title) || '—'}</td>
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
 * Decision #4, 10/12 (Nic): income by category with Charged, Received and
 * Owed side by side, the money with no category under its line, the totals,
 * and how the columns tie. Exported for its test (10/14, the Detailed switch).
 */
export function CategoryBreakdownCard({ title, view, categories }: {
  title: string; view: MoneyView | undefined
  /** An older reply's breakdown (billed / collected / still owed), read when there is no view. */
  categories?: CategoryRow[]
}) {
  // 10/14 (Nic I1): Summary is today's groups; Detailed itemizes them —
  // rent and stays by space (mobile home lot rent, park-owned trailer rent,
  // RV long-term rent, RV short-term stays, …), home sales, each space
  // subtype under its line. Offered when the books itemized the period.
  const [mode, setMode] = useState<IncomeReportView>('summary')
  const details = view?.details ?? []
  const detailed = mode === 'detailed' && details.length > 0
  const rows = detailed
    ? details.flatMap(d => [
        { key: `d:${d.key}`, label: d.label, charged: d.charged, received: d.received, owed: d.owed, sub: false },
        ...d.subtypes.map(t => ({ key: `d:${d.key}|${t.name}`, label: t.name, charged: t.charged, received: t.received, owed: t.owed, sub: true })),
      ])
    : view
    ? view.categories.map(c => ({ key: c.category, label: c.label || categoryLabel(c), charged: c.charged, received: c.received, owed: c.owed, sub: false }))
    : activeCategories(categories).map(r => ({ key: r.category, label: categoryLabel(r), ...categoryThree(r), sub: false }))
  const lines = detailed ? [] : (view?.uncategorized ?? []).map(l => ({ key: l.line, label: l.label, charged: l.charged, received: l.received, owed: l.owed, sub: false }))
  const all = [...rows, ...lines]
  const total = view ? { charged: view.charged, received: view.received, owed: view.owed } : sumThree(all)
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <span className="card-title">{title}</span>
        {details.length > 0 && (
          <div className="basis-toggle" role="group" aria-label="Income view">
            {INCOME_REPORT_VIEWS.map(v => (
              <button key={v} type="button" className={`basis-toggle-btn${mode === v ? ' on' : ''}`} aria-pressed={mode === v} onClick={() => setMode(v)}>
                {INCOME_REPORT_VIEW_LABEL[v]}
              </button>
            ))}
          </div>
        )}
      </div>
      {all.length === 0 ? (
        <div style={{ padding: 16, color: 'var(--text-3)', fontSize: '.82rem', textAlign: 'center' }}>
          Nothing was received or charged in this period.
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table rb-cat-table rb-three">
            <thead><tr>
              <th>Category</th>
              {COLS.map(c => <th key={c.key} className="rb-num">{c.label}</th>)}
            </tr></thead>
            <tbody>
              {/* data-label: on a phone each row stacks, every figure named. */}
              {all.map(r => (
                <tr key={r.key} className={r.sub ? 'rb-subtype-row' : undefined}>
                  <td className={r.sub ? 'rb-cat-name rb-subtype-name' : 'rb-cat-name'}>{r.label}</td>
                  {COLS.map(c => (
                    <td key={c.key} data-label={c.label} className={`rb-num${c.key === 'owed' && r.owed ? ' rb-owed' : ''}`}>{fmt(r[c.key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                {COLS.map(c => <td key={c.key} data-label={c.label} className="rb-num">{fmt(total[c.key])}</td>)}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <TieLines lines={view?.tieText} />
    </div>
  )
}

/** The payments behind Received: each charge's own new money on the day it arrived. */
function ChargesTable({ rows, emptyText }: { rows: any[]; emptyText: string }) {
  // 10/11 (Nic): who paid shows to everyone who reads this, a bookkeeper included.
  return (
    <table className="data-table">
      <thead><tr>
        <th>Day</th><th>Unit</th><th>Tenant</th><th>For</th><th>Status</th>
        <th className="rb-num">{MONEY_COLUMN_LABEL.received}</th>
      </tr></thead>
      <tbody>
        {rows.length ? rows.map(p => (
          <tr key={chargeKey(p)}>
            {/* The day the entry counted (the property's calendar): a dispute of
                an earlier payment sits on the day the money was taken back. */}
            <td className="mono rb-nowrap" style={{ color: 'var(--text-3)' }}>
              {usDay(chargeDay(p))}
              {Number(p.amount) < 0 && <div className="rb-taken-back">money taken back</div>}
            </td>
            <td className="mono">{p.unitNumber ? `#${p.unitNumber}` : '—'}</td>
            <td style={{ color: 'var(--text-2)' }}>{p.tenantName || '—'}</td>
            <td style={{ color: 'var(--text-3)' }}>
              {p.categoryLabel || humanize(p.type)}
              {p.dueDate && <div style={{ fontSize: '.66rem' }}>bill due {usDay(p.dueDate)}</div>}
            </td>
            <td><StatusPill status={p.status} /></td>
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
// S655 → 10/12 (Nic): the year's Charged and Received side by side, line for
// line, the deductions are the P&L's expenses line for line (the payment
// processing fees included), and the net is shown on each money column. Money
// paid ahead and not used yet at Dec 31 counted in Received the day it arrived.
function AnnualTaxTab() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const { can } = useViewer()
  // S633: a TAX document belongs to one company. Analytical rollups elsewhere on
  // this page span the whole account; these two cannot, because summing two LLCs
  // into one return is wrong on its face. Single-company accounts see no picker.
  const [companyId, setCompanyId] = useState<string>('')
  const q = companyId ? `&landlordId=${companyId}` : ''
  const { ready, mustChoose } = useCompanyReady(companyId)
  const { data: tax, isLoading, error } = useQuery<any>(['tax-summary', year, companyId],
    () => apiGet(`/reports/tax-summary?year=${year}${q}`), { enabled: ready })
  const { data: wt } = useQuery<any>(['wt-1099', year, companyId],
    () => apiGet(`/reports/work-trade-1099?year=${year}${q}`), { enabled: ready })

  const monthly: any[] = tax?.monthlyBreakdown ?? []
  const eligible: any[] = wt?.eligible ?? []
  const d = tax?.deductions
  const deductions = expenseLines(d ? {
    platformFee: Number(d.platformFees || 0), maintenance: Number(d.maintExpenses || 0),
    lotRent: Number(d.lotRent || 0), enteredExpenses: Number(d.enteredExpenses || 0),
    processingFees: Number(d.processingFees || 0), cardFeesRefunded: Number(d.cardFeesRefunded || 0),
  } : null)
  const view: MoneyView | undefined = tax?.view
  const nets = tax?.nets ?? netsOf(view, sumAmounts(deductions))
  // 10/12 (Nic, review): on the books a month's Owed is a balance at its end
  // (a bill unpaid since January is in every month's), so the Year row's Owed
  // is the year's own (the balance at its end), never the months added up.
  const monthSum = sumThree(monthly.map((m: any) => ({ charged: m.charged, received: m.received ?? m.collected, owed: m.owed })))
  const yearRow = view?.source === 'ledger' && typeof view.owed === 'number' ? { ...monthSum, owed: view.owed } : monthSum
  const paidAheadNext = Number(tax?.paidAheadNextYear?.amount || 0)
  const extraBeside: BesideItem[] = Number(d?.workTradeValue || 0) > 0
    ? [{ key: 'workTrade1099', label: 'Covered by work trade (bartered, never money)', amount: Number(d.workTradeValue) }] : []

  return (
    <div className="rb-stack">
      <div className="no-print">
        <EntityPicker value={companyId} onChange={setCompanyId}
          note="A tax statement belongs to one company — each LLC files its own return." />
      </div>
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <PeriodPicker year={year} setYear={setYear} month={null} />
        {can('reports.export') && (
          <ToolbarBtn onClick={() => window.print()} label="Print" />
        )}
      </div>

      {mustChoose ? <ChooseCompany what="tax summary" /> : error ? <ReportError error={error} what="the tax summary" /> : (isLoading || !tax) ? <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div> : (
        <>
          <div className="rb-kpis">
            <div className="kpi-card">
              <div className="kpi-label">{MONEY_COLUMN_LABEL.received} {year}</div>
              <div className="kpi-value green">{fmt0(view?.received ?? tax?.income?.totalRent)}</div>
              {paidAheadNext > 0 && (
                <div className="kpi-sub">{tax?.paidAheadNextYear?.label || 'Paid ahead, not used yet'} {fmt0(paidAheadNext)} — counted when it arrived</div>
              )}
            </div>
            <div className="kpi-card"><div className="kpi-label">{MONEY_COLUMN_LABEL.charged} {year}</div><div className="kpi-value">{fmt0(view?.charged)}</div>{view?.owed != null && <div className="kpi-sub">{MONEY_COLUMN_LABEL.owed} {fmt0(view.owed)}</div>}</div>
            <div className="kpi-card"><div className="kpi-label">Net on received</div><div className="kpi-value" style={{ color: 'var(--gold)' }}>{fmt0(nets.received)}</div><div className="kpi-sub">Net on charged {fmt0(nets.charged)}</div></div>
            <div className="kpi-card"><div className="kpi-label">Deposits Held</div><div className="kpi-value">{fmt0(tax?.deposits?.totalHeld)}</div><div className="kpi-sub">tenants' money, never income</div></div>
            <div className="kpi-card"><div className="kpi-label">Payments counted</div><div className="kpi-value">{tax?.income?.paymentCount ?? 0}</div></div>
          </div>

          <ThreeColumnPnL
            title={`Income, deductions and net — ${year}`}
            view={view}
            expenses={deductions}
            expensesHeading="Deductions (estimated)"
            nets={nets}
            extraBeside={extraBeside}
            note="Estimates for planning only — not tax advice. GAM does not file on your behalf. Confirm with your tax professional."
          />

          <div className="card">
            <div className="card-header"><span className="card-title">By month — {year}</span></div>
            <div style={{ padding: '4px 0 12px' }} className="data-table-wrap">
              <table className="data-table rb-three">
                <thead><tr>
                  <th>Month</th>
                  {COLS.map(c => <th key={c.key} className="rb-num">{c.label}</th>)}
                  <th style={{textAlign:'center'}}>Payments</th><th style={{textAlign:'center'}}>Failed</th>
                </tr></thead>
                <tbody>
                  {monthly.length ? monthly.map((m: any) => (
                    <tr key={m.month}>
                      <td style={{ color: 'var(--text-1)' }}>{MONTHS[(Number(m.month) || 1) - 1]}</td>
                      <ThreeCells v={{ received: m.received ?? m.collected, charged: m.charged, owed: m.owed }} />
                      <td className="mono" style={{ textAlign: 'center' }}>{m.paid}</td>
                      <td className="mono" style={{ textAlign: 'center', color: Number(m.failed) > 0 ? 'var(--red)' : 'var(--text-3)' }}>{m.failed}</td>
                    </tr>
                  )) : <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>Nothing in {year}.</td></tr>}
                </tbody>
                {monthly.length > 0 && (
                  <tfoot>
                    <tr>
                      <td>Year</td>
                      {COLS.map(c => <td key={c.key} className="rb-num">{fmt(yearRow[c.key])}</td>)}
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
function OwnerStatementTab() {
  const now = new Date()
  const [year, setYear]   = useState(now.getFullYear())
  const [month, setMonth] = useState<number | null>(now.getMonth() + 1)
  const { can } = useViewer()
  // S633: an owner statement is one company's statement — it prints that
  // company's name at the top.
  const [companyId, setCompanyId] = useState<string>('')
  const { ready, mustChoose } = useCompanyReady(companyId)
  const { data, isLoading, error } = useQuery<any>(['monthly-statement', year, month, companyId],
    () => apiGet(`/reports/monthly-statement?year=${year}&month=${month}` + (companyId ? `&landlordId=${companyId}` : '')),
    { enabled: ready })

  const s = data?.summary
  const payments: any[] = data?.payments ?? []
  const maintenance: any[] = data?.maintenance ?? []
  const landlord = data?.landlord
  const ym = `${year}-${String(month).padStart(2, '0')}`
  const view: MoneyView | undefined = data?.view
  const remainder = noChargeRemainder(Number(view?.received ?? s?.totalIncome ?? 0), Number(data?.rowsTotal || 0))
  const hh = s?.households
  const expenses = expenseLines(s ? {
    platformFee: Number(s.totalPlatformFees || 0), maintenance: Number(s.totalMaintCost || 0),
    lotRent: Number(s.lotRent || 0), enteredExpenses: Number(s.enteredExpenses || 0),
    processingFees: Number(s.processingFees || 0), cardFeesRefunded: Number(s.cardFeesRefunded || 0),
  } : null)
  if (s && Number(s.pmFee)) expenses.push({ key: 'pmFee', label: 'Management fee', amount: Number(s.pmFee) })

  const exportPaymentsCsv = () => downloadCsv(
    `owner-statement-${ym}.csv`,
    ['Day it arrived', 'Date due', 'Property', 'Unit', 'Tenant', 'For', 'Status', MONEY_COLUMN_LABEL.received],
    payments.map(p => [
      chargeDay(p), (p.dueDate || '').slice(0, 10), p.propertyName, p.unitNumber,
      [p.tenantFirst, p.tenantLast].filter(Boolean).join(' '),
      p.categoryLabel || humanize(p.type), statusWords(p.status), Number(p.amount || 0).toFixed(2),
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
            <ToolbarBtn onClick={exportPaymentsCsv} label="CSV" />
            <ToolbarBtn onClick={() => window.print()} label="Print" />
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
              </div>
            </div>
          </div>

          <ThreeColumnPnL
            title={`Profit & Loss — ${monthLabel(ym)}`}
            view={view}
            expenses={expenses}
            nets={data?.nets ?? netsOf(view, Number(s?.totalExpenses || 0))}
          />

          <div className="card">
            <div className="card-header">
              <span className="card-title">Payments behind {MONEY_COLUMN_LABEL.received}</span>
              {/* 10/12 (Nic): households past grace, not lines (a $5 daily late fee is not five late bills). */}
              <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>
                Households, bills due in {monthLabel(ym)}: {hh?.paidOnTime ?? 0} on time · {s?.latePayments ?? 0} past grace · {s?.failedPayments ?? 0} with a failed payment
              </span>
            </div>
            <div style={{ padding: '4px 0 12px' }} className="data-table-wrap">
              <ChargesTable rows={payments} emptyText={`No money arrived in ${monthLabel(ym)}.`} />
              {payments.length > 0 && (
                <div className="rb-small-note">
                  These add up to {fmt(data?.rowsTotal)}.
                  {Math.abs(remainder) >= 0.01 && ` The other ${fmt(remainder)} of ${MONEY_COLUMN_LABEL.received} has no single charge behind it (money paid ahead, register sales and stays, other income, move-out lines).`}
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
// MONTHLY P&L DRILL-IN MODAL (S512 #20; 10/12 three columns, one line per day)
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
  expenses: { platformFee: number; maintenance: number; lotRent?: number; enteredExpenses?: number; processingFees?: number; cardFeesRefunded?: number; total: number }
  net: number
  paymentCount: number
  payments: PaymentRow[]
  rowsTotal: number
  view: MoneyView
  nets: { charged: number; received: number }
  days: DayLine[]
}

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

function MonthlyPLModal({ month, onClose }: { month: string; onClose: () => void }) {
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
    ['monthly-pl', month, companyId],
    () => apiGet(`/reports/monthly-pl?year=${year}&month=${mo}` + (companyId ? `&landlordId=${companyId}` : '')),
  )
  // 10/12 (Nic): a day opens to who paid on screen; the printout keeps the daily totals only.
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (day: string) => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(day)) next.delete(day); else next.add(day)
    return next
  })
  const view = data?.view
  const days = data?.days ?? []

  return (
    <div className="modal-overlay rb-printable" onClick={onClose}>
      <div className="modal rb-modal" style={{ width: 760 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div>
            <div className="modal-title" style={{ marginBottom: 2 }}>{monthLabel(month)} — Profit &amp; Loss</div>
            <div style={{ fontSize: '.74rem', color: 'var(--text-3)' }}>{COLS.map(c => c.label).join(', ')} side by side</div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {data && <ToolbarBtn onClick={() => window.print()} label="Print" />}
            <button className="btn btn-ghost btn-sm no-print" onClick={onClose} style={{ padding: 6 }} aria-label="Close">×</button>
          </div>
        </div>

        <div className="rb-modal-body">
          <div className="no-print">
            <EntityPicker value={companyId} onChange={setCompanyId}
              note="A profit and loss statement belongs to one company." />
          </div>
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
              <div className="rb-stats">
                <PLStat label={MONEY_COLUMN_LABEL.received} value={view?.received ?? data.gross.total} color="var(--green)" />
                <PLStat label={MONEY_COLUMN_LABEL.charged} value={view?.charged ?? 0} color="var(--text-0)" />
                {(!view || view.owed != null) && <PLStat label={MONEY_COLUMN_LABEL.owed} value={view?.owed ?? 0} color="var(--amber)" />}
                <PLStat label="Expenses" value={data.expenses.total} color="var(--text-2)" negative />
                <PLStat label="Net on received" value={data.nets?.received ?? data.net} color={(data.nets?.received ?? data.net) >= 0 ? 'var(--gold)' : 'var(--red, #e06666)'} bold />
              </div>

              <ThreeColumnPnL
                title="Breakdown"
                view={view}
                expenses={expenseLines(data.expenses)}
                nets={data.nets ?? netsOf(view, data.expenses.total)}
              />

              {/* 10/12 (Nic): one line per day with the day's total, and the
                  expenses logged that day under it. A day opens to who paid. */}
              <div className="card" style={{ marginTop: 16 }}>
                <div className="card-header">
                  <span className="card-title">Money by the day it arrived</span>
                  <span className="no-print" style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>Click a day to see who paid.</span>
                </div>
                <div style={{ padding: '2px 0 6px' }}>
                  {days.length === 0 ? (
                    <div style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24, fontSize: '.8rem' }}>
                      No money arrived and no expenses were logged in {monthLabel(month)}.
                    </div>
                  ) : days.map(d => {
                    const isOpen = open.has(d.day)
                    const rows = dayRows(d, data.payments)
                    const canOpen = rows.length > 0 || Math.abs(d.noCharge) >= 0.01
                    return (
                      <div key={d.day} className="rb-day">
                        <button type="button" className="rb-day-line" aria-expanded={isOpen}
                          onClick={() => canOpen && toggle(d.day)} disabled={!canOpen} style={{ cursor: canOpen ? 'pointer' : 'default' }}>
                          <span className="rb-day-caret no-print">{canOpen ? '▸' : ''}</span>
                          <span className="rb-day-date">{dayLabel(d.day + 'T12:00:00')}</span>
                          {d.paymentCount > 0 && <span className="rb-day-count">{d.paymentCount} {d.paymentCount === 1 ? 'payment' : 'payments'}</span>}
                          <span className="rb-day-total">{fmt(d.received)}</span>
                        </button>
                        {d.expensesLogged !== 0 && (
                          <div className="rb-day-expense">{expensesLoggedText(d.expensesLogged, d.expenseCount, fmt)}</div>
                        )}
                        {isOpen && (
                          <div className="rb-day-detail no-print">
                            {rows.map(r => (
                              <div key={chargeKey(r)} className="rb-group-row">
                                <span className="rb-group-who">
                                  {r.tenantName || 'Tenant'}
                                  <span className="rb-group-detail">
                                    {r.unitNumber ? ` · ${r.propertyName ? r.propertyName + ' ' : ''}#${r.unitNumber}` : ''}
                                    {` · ${r.categoryLabel || humanize(r.type)}`}
                                    {Number(r.amount) < 0
                                      ? ' · money taken back (a dispute or bank return)'
                                      : `${r.method && r.method !== '—' ? ` · ${r.method}` : ''}${r.settledAt ? ` · ${timeLabel(r.settledAt)}` : ''}`}
                                    {r.dueDate ? ` · bill due ${usDay(r.dueDate)}` : ''}
                                    {Number(r.creditGiven) > 0 ? ` · credit you gave ${fmt(r.creditGiven)}` : ''}
                                  </span>
                                </span>
                                <span className="mono" style={{ color: 'var(--text-0)', whiteSpace: 'nowrap' }}>{fmt(r.amount)}</span>
                              </div>
                            ))}
                            {Math.abs(d.noCharge) >= 0.01 && (
                              <div className="rb-group-row">
                                <span className="rb-group-who"><span className="rb-group-detail">Money with no single charge behind it (paid ahead, register sales, stays, other income)</span></span>
                                <span className="mono" style={{ color: 'var(--text-0)', whiteSpace: 'nowrap' }}>{fmt(d.noCharge)}</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="modal-footer no-print" style={{ marginTop: 12, flexShrink: 0 }}>
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
 * Figures in no column (work trade, deposits held, owner money in, chargeback
 * costs) — and the paid-ahead money not used yet, which already counted in
 * Received the day it arrived (§0.0, Todd).
 */
function BesideFigures({ items }: { items: BesideItem[] | null | undefined }) {
  const list = items ?? []
  const onHand = list.find(i => i.key === PAID_AHEAD_ON_HAND_KEY && Number(i.amount))
  const rest = list.filter(i => i.key !== PAID_AHEAD_ON_HAND_KEY)
  if (!onHand && !rest.length) return null
  return (
    <>
      {onHand && (
        <div className="rb-counted">
          <div className="rb-beside-row"><span>{onHand.label}</span><span className="rb-line-amount">{fmt(onHand.amount)}</span></div>
          <div className="rb-counted-note">{PAID_AHEAD_COUNTED_NOTE}</div>
        </div>
      )}
      {rest.length > 0 && (
        <div className="rb-beside">
          <div className="rb-beside-title">In no column</div>
          {rest.map(i => (
            <div key={i.key} className="rb-beside-row"><span>{i.label}</span><span className="rb-line-amount">{fmt(i.amount)}</span></div>
          ))}
        </div>
      )}
    </>
  )
}

// ── P&L statement block (income green, expenses RED, net gold) ─
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
 * 10/12 (Nic): a P&L with Received, Charged and Owed side by side. Every
 * income line is listed in each column (they add up to the column's total),
 * the tie line says how the columns relate, every expense is listed once
 * (the payment processing fees always), and the net is shown on each money
 * column. Figures in no column follow.
 */
function ThreeColumnPnL({ title, view, expenses, expensesHeading = 'Expenses', nets, extraBeside, note }: {
  title: string
  view: MoneyView | undefined
  /** 10/12 (ledger P8): a line's `paid` (on the books) is the Received column's; else the same amount. */
  expenses: ExpenseLine[]
  expensesHeading?: string
  nets: { charged: number; received: number }
  extraBeside?: BesideItem[]
  note?: string
}) {
  const lines = view?.lines ?? []
  const expTotal = sumAmounts(expenses)
  const paidTotal = sumAmounts(expenses.map(e => ({ amount: e.paid ?? e.amount })))
  return (
    <div className="card">
      <div className="card-header"><span className="card-title">{title}</span></div>
      <div className="data-table-wrap">
        <table className="data-table rb-three">
          <thead><tr>
            <th>Income</th>
            {COLS.map(c => <th key={c.key} className="rb-num">{c.label}</th>)}
          </tr></thead>
          <tbody>
            {lines.length ? lines.map(l => (
              <tr key={l.line} className="rb-sub">
                <td>{l.label || incomeLineLabel(l.line)}</td>
                <ThreeCells v={l} />
              </tr>
            )) : (
              <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 16 }}>Nothing received or charged.</td></tr>
            )}
            <tr className="rb-total">
              <td>Total income</td>
              <ThreeCells v={{ received: view?.received ?? 0, charged: view?.charged ?? 0, owed: view ? view.owed : 0 }} />
            </tr>
            <tr><td colSpan={4} style={{ paddingTop: 14, fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)', fontWeight: 700 }}>{expensesHeading}</td></tr>
            {expenses.map(e => {
              const rec = e.paid ?? e.amount
              return (
                <tr key={e.key} className="rb-sub">
                  <td>{e.label}</td>
                  <td className="rb-num rb-neg">{rec ? `−${fmt(Math.abs(rec))}` : fmt(0)}</td>
                  <td className="rb-num rb-neg">{e.amount ? `−${fmt(Math.abs(e.amount))}` : fmt(0)}</td>
                  <td className="rb-blank"></td>
                </tr>
              )
            })}
            <tr className="rb-total">
              <td>Total {expensesHeading.toLowerCase().replace(/ \(.*\)$/, '')}</td>
              <td className="rb-num rb-neg">−{fmt(paidTotal)}</td>
              <td className="rb-num rb-neg">−{fmt(expTotal)}</td>
              <td className="rb-blank"></td>
            </tr>
            <tr className="rb-net">
              <td>Net</td>
              <Cell v={nets.received} kind="net" />
              <Cell v={nets.charged} kind="net" />
              <td className="rb-blank"></td>
            </tr>
          </tbody>
        </table>
      </div>
      <TieLines lines={view?.tieText} />
      <div style={{ padding: '0 6px 12px' }}>
        <BesideFigures items={[...(view?.beside ?? []), ...(extraBeside ?? [])]} />
        {note && <div className="rb-small-note">{note}</div>}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// 10/12 (Nic) — THE MONTHLY PROPERTY REPORT
//
// All four groups — tenants & leases, payments (the colored stamps, who is
// late and by how many days past grace), money (Charged / Received / Owed by
// category, expenses by category, net, work trade, deposits), operations
// (utility billed back vs the utility's own bill, maintenance, stays) — for
// each property, printable, and as the PDF the email attaches. The owner picks
// who it is emailed to on the 2nd (the card at the bottom).
// ══════════════════════════════════════════════════════════════
interface ReportProperty {
  property: { id: string; name: string; city: string | null; state: string | null }
  tenants: {
    leasesStarted: number; leasesRenewed: number; existingOnboarded: number; leasesEnded: number
    moveIns: number; moveOuts: number; spaces: number; occupied: number; vacant: number
    occupancyPercent: number | null; occupancyAsOf: string; occupancyFrom: 'monthEndSnapshot' | 'today' | string
  }
  payments: {
    counts: Array<{ stamp: PaymentStamp; label: string; households: number }>
    households: number
    late: Array<{ householdId: string; name: string; units: string[]; stamp: PaymentStamp; stampLabel: string; daysPastGrace: number; owed: number }>
  }
  money: {
    view: MoneyView
    expenses: { lines: Array<{ key: string; label: string; amount: number }>; total: number }
    net: { received: number; charged: number }
    workTradeCovered: number; depositsReceived: number; depositsReturned: number
  }
  operations: {
    utilityCycle: string
    utilities: Array<{ utility: string; label: string; billedBack: number; utilityBill: number | null }>
    utilityExpensesLogged: number
    maintenance: { opened: number; closed: number; cost: number }
    stays: { stays: number; nights: number; bookedThisMonth: number }
  }
}
interface MonthlyReport {
  company: { id: string; name: string }
  month: string
  monthLabel: string
  properties: ReportProperty[]
  /** 10/12 review: the whole company's money no property here holds (beside the totals); null when none. */
  notInTotals?: { received: number; charged: number; expenses: number } | null
  totals: {
    tenants: ReportProperty['tenants']
    payments: { counts: ReportProperty['payments']['counts']; households: number; late: number }
    money: ReportProperty['money']
  }
}

const Fig = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
  <div className="rb-mr-fig">
    <div className="rb-mr-fig-label">{label}</div>
    <div className="rb-mr-fig-value">{value}</div>
    {sub && <div className="rb-mr-fig-sub">{sub}</div>}
  </div>
)

function StampCounts({ counts }: { counts: ReportProperty['payments']['counts'] }) {
  return (
    <div className="rb-stamps">
      {counts.map(c => (
        <span key={c.stamp} className="rb-stamp-count" title={`${c.label}: ${c.households} ${c.households === 1 ? 'household' : 'households'}`}>
          <span className={`rb-stamp-chip ${c.stamp}`}>{PAYMENT_STAMP_LETTER[c.stamp]}</span>
          {c.label}: {c.households}
        </span>
      ))}
    </div>
  )
}

function MonthlyReportTab() {
  const { role, isBookkeeper } = useViewer()
  const [companyId, setCompanyId] = useState<string>('')
  const { ready, mustChoose } = useCompanyReady(companyId)
  const [month, setMonth] = useState<string>(() => linkParams().month ?? lastMonthKey())
  const [propertyId, setPropertyId] = useState('')
  const [y, m] = month.split('-').map(Number)
  const q = `month=${month}${companyId ? `&landlordId=${companyId}` : ''}`
  const { data, isLoading, error } = useQuery<MonthlyReport>(['monthly-report', month, companyId],
    () => apiGet(`/reports/monthly-report?${q}`), { enabled: ready })
  const [pdfBusy, setPdfBusy] = useState(false)
  const shown = (data?.properties ?? []).filter(p => !propertyId || p.property.id === propertyId)
  // 10/12 review: year and month live in one string, so each picker change
  // updates it from its CURRENT value. Two setters reading this render's year
  // and month lost the year when the picker moved both at once (a later month
  // clamped to this month when switching to this year).
  const setYear = (yy: number) => setMonth(cur => `${yy}-${cur.slice(5, 7)}`)
  const setMonthOnly = (mm: number | null) => setMonth(cur => `${cur.slice(0, 4)}-${String(mm ?? 1).padStart(2, '0')}`)

  const openPdf = async () => {
    setPdfBusy(true)
    try {
      await openProtectedFile(`/api/reports/monthly-report/pdf?${q}${propertyId ? `&propertyId=${propertyId}` : ''}`)
    } catch {
      toastError('Could not open the PDF. Try again in a moment.')
    } finally {
      setPdfBusy(false)
    }
  }

  return (
    <div className="rb-stack rb-report">
      <div className="no-print">
        <EntityPicker value={companyId} onChange={setCompanyId}
          note="The monthly report is one company's report — it prints that company's name." />
      </div>
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <PeriodPicker year={y} setYear={setYear} month={m} setMonth={setMonthOnly} />
          {(data?.properties?.length ?? 0) > 1 && (
            <select className="input" value={propertyId} onChange={e => setPropertyId(e.target.value)} style={{ minWidth: 180 }}>
              <option value="">All properties</option>
              {data!.properties.map(p => <option key={p.property.id} value={p.property.id}>{p.property.name}</option>)}
            </select>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <ToolbarBtn onClick={() => window.print()} label="Print" disabled={!data} />
          <ToolbarBtn onClick={openPdf} label={pdfBusy ? 'Opening…' : 'PDF'} disabled={!data || pdfBusy} />
        </div>
      </div>

      {mustChoose ? <ChooseCompany what="monthly report" /> : error ? <ReportError error={error} what="the monthly report" /> : (isLoading || !data) ? <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div> : (
        <>
          <div className="card">
            <div style={{ padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', color: 'var(--text-0)', fontWeight: 700 }}>Monthly property report</div>
                <div style={{ fontSize: '.8rem', color: 'var(--text-2)', marginTop: 2 }}>{data.company.name}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '.72rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Month</div>
                <div style={{ fontSize: '.9rem', color: 'var(--gold)', fontWeight: 600 }}>{data.monthLabel}</div>
              </div>
            </div>
          </div>

          {!propertyId && data.properties.length > 1 && <AllPropertiesCard report={data} />}
          {data.properties.length === 0 && (
            <div className="card" style={{ padding: 18, color: 'var(--text-2)', fontSize: '.84rem' }}>No properties to report on for this month.</div>
          )}
          {shown.map(p => <PropertyMonthCard key={p.property.id} p={p} monthLabel={data.monthLabel} />)}
        </>
      )}

      {/* 10/12 (Nic): who gets it — owner/admin only to edit. */}
      {role === 'landlord' && !isBookkeeper && ready && !mustChoose && <RecipientsCard companyId={companyId} />}
    </div>
  )
}

function AllPropertiesCard({ report }: { report: MonthlyReport }) {
  const T = report.totals
  return (
    <div className="card">
      <div className="card-header"><span className="card-title">All properties — {report.monthLabel}</span></div>
      <div className="data-table-wrap">
        <table className="data-table rb-three">
          <thead><tr>
            <th>Property</th><th className="rb-num">Occupancy</th>
            {COLS.map(c => <th key={c.key} className="rb-num">{c.label}</th>)}
            <th className="rb-num">Expenses</th><th className="rb-num">Net on received</th><th className="rb-num">Net on charged</th>
            <th className="rb-num">Past grace</th>
          </tr></thead>
          <tbody>
            {report.properties.map(p => (
              <tr key={p.property.id}>
                <td style={{ color: 'var(--text-0)', fontWeight: 600 }}>{p.property.name}</td>
                <td className="rb-num">{p.tenants.occupancyPercent == null ? '—' : `${p.tenants.occupancyPercent}%`}</td>
                <ThreeCells v={p.money.view} />
                <Cell v={p.money.expenses.total} />
                <Cell v={p.money.net.received} kind="net" /><Cell v={p.money.net.charged} kind="net" />
                <td className="rb-num">{p.payments.late.length}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td className="rb-num">{T.tenants.occupancyPercent == null ? '—' : `${T.tenants.occupancyPercent}%`}</td>
              <ThreeCells v={T.money.view} />
              <Cell v={T.money.expenses.total} />
              <Cell v={T.money.net.received} kind="net" /><Cell v={T.money.net.charged} kind="net" />
              <td className="rb-num">{T.payments.late}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <TieLines lines={T.money.view.tieText} />
      {/* 10/12 review: the whole company's money no property here holds — beside the totals, so they add up to the P&L. */}
      {report.notInTotals && (
        <div className="rb-tie"><p>
          Booked to the company, not to a property in this report, so in none of its property figures: {MONEY_COLUMN_LABEL.received.toLowerCase()} {fmt(report.notInTotals.received)}, {MONEY_COLUMN_LABEL.charged.toLowerCase()} {fmt(report.notInTotals.charged)}, expenses {fmt(report.notInTotals.expenses)}. With these, the figures add up to the month&apos;s profit and loss.
        </p></div>
      )}
      <div className="rb-mr-section-title">Payments — every property</div>
      <StampCounts counts={T.payments.counts} />
    </div>
  )
}

function PropertyMonthCard({ p, monthLabel: ml }: { p: ReportProperty; monthLabel: string }) {
  const t = p.tenants
  const money = p.money
  const ops = p.operations
  return (
    <div className="card rb-mr-property">
      <div className="card-header">
        <span className="card-title">{p.property.name}</span>
        <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{[p.property.city, p.property.state].filter(Boolean).join(', ')}</span>
      </div>

      <div className="rb-mr-section-title">Tenants and leases</div>
      <div className="rb-mr-grid">
        <Fig label="Leases started" value={t.leasesStarted} sub={`${t.leasesRenewed} renewed · ${t.existingOnboarded} existing moved onto GAM`} />
        <Fig label="Leases ended" value={t.leasesEnded} />
        <Fig label="Move-ins" value={t.moveIns} />
        <Fig label="Move-outs" value={t.moveOuts} />
        {/* 10/12 (Nic) review: say what each number is — occupied is the
            spaces GAM billed for the month (held at any point in it), the
            spaces are counted on the day named. */}
        <Fig label="Occupied spaces" value={`${t.occupied} of ${t.spaces}`}
          sub={`${t.occupancyPercent == null ? '—' : `${t.occupancyPercent}%`} · occupied = spaces GAM billed for ${ml} · spaces counted ${t.occupancyFrom === 'today' ? `today, ${usDay(t.occupancyAsOf)}` : usDay(t.occupancyAsOf)}`} />
        <Fig label="Vacant spaces" value={t.vacant} />
      </div>

      <div className="rb-mr-section-title">Payments — bills due in {ml}, one stamp per household</div>
      <StampCounts counts={p.payments.counts} />
      {p.payments.late.length > 0 ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Who is late</th><th>Space</th><th>Status</th><th className="rb-num">Days past grace</th><th className="rb-num">Still owed</th></tr></thead>
            <tbody>
              {p.payments.late.map(h => (
                <tr key={h.householdId}>
                  <td style={{ color: 'var(--text-0)', fontWeight: 600 }}>{h.name}</td>
                  <td className="mono">{h.units.join(', ') || '—'}</td>
                  <td><span className={`rb-stamp-chip ${h.stamp}`} style={{ marginRight: 6 }}>{PAYMENT_STAMP_LETTER[h.stamp]}</span>{h.stampLabel}</td>
                  <td className="rb-num">{h.daysPastGrace}</td>
                  <Cell v={h.owed} kind="owed" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rb-small-note" style={{ padding: '0 6px 8px' }}>Nobody is past the grace period for this month.</div>
      )}

      <div className="rb-mr-section-title">Money — {COLS.map(c => c.label.toLowerCase()).join(', ')}</div>
      <CategoryBreakdownCard title={`Income by category — ${ml}`} view={money.view} />
      <div className="data-table-wrap">
        <table className="data-table rb-three">
          <thead><tr><th>Expenses</th><th className="rb-num">Amount</th></tr></thead>
          <tbody>
            {money.expenses.lines.map(l => (
              <tr key={l.key} className="rb-sub"><td>{l.label}</td><td className="rb-num rb-neg">{l.amount ? `−${fmt(Math.abs(l.amount))}` : fmt(0)}</td></tr>
            ))}
            <tr className="rb-total"><td>Total expenses</td><td className="rb-num rb-neg">−{fmt(money.expenses.total)}</td></tr>
            <tr className="rb-net"><td>Net on received</td><Cell v={money.net.received} kind="net" /></tr>
            <tr className="rb-net"><td>Net on charged</td><Cell v={money.net.charged} kind="net" /></tr>
          </tbody>
        </table>
      </div>
      <div className="rb-mr-grid" style={{ marginTop: 10 }}>
        <Fig label="Covered by work trade" value={fmt(money.workTradeCovered)} sub="hours, never money" />
        <Fig label="Deposits received" value={fmt(money.depositsReceived)} sub="held for tenants, never income" />
        <Fig label="Deposits returned" value={fmt(money.depositsReturned)} />
      </div>

      <div className="rb-mr-section-title">Operations</div>
      {ops.utilities.length > 0 ? (
        <div className="data-table-wrap">
          <table className="data-table rb-three">
            <thead><tr><th>Utility ({ops.utilityCycle} cycle)</th><th className="rb-num">Billed back to tenants</th><th className="rb-num">The utility's own bill</th><th className="rb-num">Difference</th></tr></thead>
            <tbody>
              {ops.utilities.map(u => (
                <tr key={u.utility}>
                  <td>{u.label}</td>
                  <Cell v={u.billedBack} />
                  <td className="rb-num">{u.utilityBill == null ? 'Not entered' : fmt(u.utilityBill)}</td>
                  {u.utilityBill == null ? <td className="rb-num rb-blank">—</td> : <Cell v={u.billedBack - u.utilityBill} kind="net" />}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rb-small-note" style={{ padding: '0 6px 8px' }}>No utilities were billed back this cycle.</div>
      )}
      <div className="rb-mr-grid" style={{ marginTop: 10 }}>
        <Fig label="Utility bills you logged" value={fmt(ops.utilityExpensesLogged)} sub="as expenses" />
        <Fig label="Maintenance opened" value={ops.maintenance.opened} />
        <Fig label="Maintenance closed" value={ops.maintenance.closed} sub={`cost ${fmt(ops.maintenance.cost)}`} />
        <Fig label="Stays" value={ops.stays.stays} sub={`${ops.stays.nights} nights · ${ops.stays.bookedThisMonth} booked this month`} />
      </div>
    </div>
  )
}

interface RecipientsData {
  canEdit: boolean
  isDefault: boolean
  recipients: Array<{ kind: string; userId: string | null; email: string; name: string | null; roleLabel: string | null }>
  leftTeam: Array<{ userId: string; name: string }>
  team: Array<{ userId: string; name: string; email: string; roleLabel: string; allProperties: boolean; propertyCount: number | null }>
  lastSends: Array<{ month: string; email: string; status: string; statusLabel: string; sentAt: string | null }>
  maxExtraEmails: number
}

/**
 * 10/12 (Nic): "EMAILED at month close WITH THE PDF ATTACHED to the
 * recipients the OWNER picks — themselves, property managers, bookkeepers,
 * other team members, plus extra email addresses — owner/admin only to edit;
 * default = the owner only." Each person gets the properties their own
 * access covers; another address gets every property.
 */
function RecipientsCard({ companyId }: { companyId: string }) {
  const qc = useQueryClient()
  const q = companyId ? `?landlordId=${companyId}` : ''
  const { data, error, isLoading } = useQuery<RecipientsData>(['monthly-report-recipients', companyId],
    () => apiGet(`/reports/monthly-report/recipients${q}`), { retry: false })
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [emails, setEmails] = useState<string[] | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const seeded = useRef<string>('')
  useEffect(() => {
    if (!data) return
    const key = `${companyId}:${JSON.stringify(data.recipients)}`
    if (seeded.current === key) return
    seeded.current = key
    setPicked(new Set(data.recipients.filter(r => r.kind === 'team_member' && r.userId).map(r => r.userId!)))
    setEmails(data.recipients.filter(r => r.kind === 'email').map(r => r.email))
  }, [data, companyId])

  // Only the owner edits the list: anyone else is refused, and the card is not shown.
  if (error || isLoading || !data || !picked || !emails) return null
  const sendOf = (email: string) => data.lastSends.find(s => s.email === email)
  const addEmail = () => {
    const e = draft.trim().toLowerCase()
    if (!e) return
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { toastError('That is not an email address.'); return }
    if (emails.includes(e)) { setDraft(''); return }
    if (emails.length >= data.maxExtraEmails) { toastError(`Add at most ${data.maxExtraEmails} other addresses.`); return }
    setEmails([...emails, e]); setDraft('')
  }
  const save = async () => {
    setSaving(true)
    try {
      await finPost('/reports/monthly-report/recipients', {
        ...(companyId ? { landlordId: companyId } : {}), teamMemberIds: [...picked], emails,
      })
      seeded.current = ''
      await qc.invalidateQueries(['monthly-report-recipients', companyId])
      toast('Saved. The next monthly report goes to this list.')
    } catch (e: any) {
      toastError(reportErrorText(e, 'the list').replace(/^Could not load/, 'Could not save'))
    } finally {
      setSaving(false)
    }
  }
  const status = (email: string) => {
    const s = sendOf(email)
    return s ? `${monthLabel(s.month)}: ${s.statusLabel}${s.sentAt ? ` ${usDay(s.sentAt.slice(0, 10))}` : ''}` : null
  }

  return (
    <div className="card no-print">
      <div className="card-header">
        <span className="card-title">Who gets this report by email</span>
        <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>Sent on the 2nd of each month for the month before, with the PDF attached.</span>
      </div>
      {data.isDefault && <div className="rb-small-note" style={{ padding: '0 6px 8px' }}>Right now only you get it. Pick anyone else below.</div>}
      <div className="rb-recip">
        {data.team.map(m => (
          <label key={m.userId} className="rb-recip-row">
            <input type="checkbox" checked={picked.has(m.userId)} onChange={e => {
              const next = new Set(picked)
              if (e.target.checked) next.add(m.userId); else next.delete(m.userId)
              setPicked(next)
            }} />
            <span style={{ fontWeight: 600 }}>{m.name}</span>
            <span className="rb-recip-meta">{m.roleLabel} · {m.allProperties ? 'every property' : `${m.propertyCount ?? 0} ${(m.propertyCount ?? 0) === 1 ? 'property' : 'properties'}`}{status(m.email) ? ` · ${status(m.email)}` : ''}</span>
          </label>
        ))}
        {data.leftTeam.length > 0 && (
          <div className="rb-recip-meta">No longer on your team (they get nothing): {data.leftTeam.map(l => l.name).join(', ')}</div>
        )}
      </div>
      <div style={{ padding: '4px 4px 6px', fontSize: '.78rem', color: 'var(--text-2)', fontWeight: 600 }}>Other email addresses (they get every property)</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 4px 8px' }}>
        {emails.map(e => (
          <span key={e} className="rb-chip">{e}{status(e) ? <span className="rb-recip-meta">{status(e)}</span> : null}
            <button type="button" aria-label={`Remove ${e}`} onClick={() => setEmails(emails.filter(x => x !== e))}>×</button>
          </span>
        ))}
      </div>
      <div className="rb-recip-add" style={{ padding: '0 4px 12px' }}>
        <input className="input" type="email" placeholder="name@example.com" value={draft}
          onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEmail() } }} />
        <button type="button" className="btn btn-primary btn-sm" onClick={addEmail}>Add address</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save list'}</button>
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
// 10/12 (Nic): Charged, Received and Owed side by side on every row.
// ══════════════════════════════════════════════════════════════
type RLevel  = 'portfolio' | 'property' | 'unit'
type RBucket = 'total' | 'monthly' | 'daily'

interface EngineRow {
  period: string | null
  propertyName: string | null
  unitNumber: string | null
  /** S655: `lines` has every income line on its own (they add up to total). Income is money received. */
  income:   { rent: number; fees: number; utilities: number; homeSale: number; other: number; total: number; lines?: Record<string, number> }
  /** S655: lotRent — what an investor-operator owes the park, by billing month (the P&L's own). */
  expenses: { maintenance: number; entered: number; platformFee: number; lotRent?: number; processingFees?: number; cardFeesRefunded?: number; total: number; byCategory: Record<string, number> }
  net: number
  /** 10/12: the three columns, and the net on Charged. */
  money?: MoneyThree
  netCharged?: number
  occupiedUnits: number
  derived: { netPerUnit: number | null; costPerUnit: number | null; incomePerUnit: number | null; costPerDay: number; netPerDay: number }
}
interface EngineResult {
  rows: EngineRow[]
  totals: EngineRow
  meta: {
    start: string; end: string; level: RLevel; bucket: RBucket; platformFeeIncluded: boolean; lotRentIncluded?: boolean; report?: string; note?: string
    /** 10/12 (ledger P8): 'ledger' when the report read the company's books. */
    source?: 'ledger'
  }
}

const money = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const threeOf = (r: EngineRow): MoneyThree => r.money ?? { charged: 0, received: r.income.total, owed: 0 }

/** Default range: the last 12 complete months, matching the T-12 convention
 *  (a half-finished current month makes income look worse than it is). */
function defaultRange(): { start: string; end: string } {
  // The viewer's calendar, not UTC's: on the last evening of a month in
  // Arizona, UTC is already next month and would call this one complete.
  return lastTwelveMonths()
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
  // Each run is numbered and only the newest may land: an older, slower run
  // answering last would otherwise sit under the newer settings.
  const [runs] = useState(latestOnly)

  const run = async (path: string, label: string) => {
    const me = runs.start()
    setRunning(true); setError(null)
    try {
      const answer = await apiGet<EngineResult>(path)
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

  const runCustom = () => {
    if (start > end) { setError('Start date must be on or before the end date.'); return }
    run(`/reports/query?start=${start}&end=${end}&level=${level}&bucket=${bucket}`, 'Custom report')
  }
  const runT12 = () => run('/reports/t12', 'Trailing 12 months (T-12)')
  const stale = running && !!result
  // S655: lot rent is a P&L expense; its column shows whenever there is any.
  const hasLotRent = !!result && (Number(result.totals.expenses.lotRent ?? 0) !== 0
    || result.rows.some(r => Number(r.expenses.lotRent ?? 0) !== 0))

  const exportCsv = () => {
    if (!result) return
    const header = [
      'Period', 'Property', 'Unit', ...COLS.map(c => c.label),
      'Rent', 'Fees', 'Utilities', 'Home sale', 'Other income',
      'Maintenance', 'Expenses', 'Platform fee', 'Lot rent', 'Payment processing fees', 'Card fees refunded', 'Total expenses',
      'Net on received', 'Net on charged', 'Occupied units', 'Net / unit', 'Cost / unit',
    ]
    const line = (r: EngineRow, period: string) => [
      period, r.propertyName ?? '', r.unitNumber ?? '', ...COLS.map(c => threeOf(r)[c.key]),
      r.income.rent, r.income.fees, r.income.utilities, r.income.homeSale, r.income.other,
      r.expenses.maintenance, r.expenses.entered, r.expenses.platformFee, r.expenses.lotRent ?? 0, r.expenses.processingFees ?? 0, r.expenses.cardFeesRefunded ?? 0, r.expenses.total,
      r.net, r.netCharged ?? '', r.occupiedUnits, r.derived.netPerUnit ?? '', r.derived.costPerUnit ?? '',
    ]
    const body = result.rows.map(r => line(r, r.period ?? 'Total'))
    body.push(line(result.totals, 'TOTAL').map((v, i) => i === 1 || i === 2 ? '' : v))
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
          Running the report… The figures below are the last run until it finishes.
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
          {result.meta.note && (
            <div style={{ fontSize: '.75rem', color: 'var(--text-2)', marginTop: 6 }}>{result.meta.note}</div>
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
              <table className="data-table rb-three">
                <thead>
                  <tr>
                    {result.meta.bucket !== 'total' && <th>Period</th>}
                    {result.meta.level !== 'portfolio' && <th>Property</th>}
                    {result.meta.level === 'unit' && <th>Unit</th>}
                    {COLS.map(c => <th key={c.key} className="rb-num">{c.label}</th>)}
                    <th style={{ textAlign: 'right' }}>Repairs</th>
                    <th style={{ textAlign: 'right' }}>Expenses</th>
                    <th style={{ textAlign: 'right' }}>Platform fee</th>
                    {hasLotRent && <th style={{ textAlign: 'right' }}>Lot rent</th>}
                    <th style={{ textAlign: 'right' }}>Processing fees</th>
                    <th style={{ textAlign: 'right' }}>Net on received</th>
                    <th style={{ textAlign: 'right' }}>Net on charged</th>
                    <th style={{ textAlign: 'right' }}>Net / unit</th>
                  </tr>
                </thead>
                <tbody>
                  {[...result.rows, null].map((r, i) => {
                    const row = r ?? result.totals
                    const t = threeOf(row)
                    return (
                      <tr key={i} style={r ? undefined : { fontWeight: 600, borderTop: '2px solid var(--border-0)' }}>
                        {r ? (
                          <>
                            {result.meta.bucket !== 'total' && <td>{r.period}</td>}
                            {result.meta.level !== 'portfolio' && <td>{r.propertyName ?? '—'}</td>}
                            {result.meta.level === 'unit' && <td>{r.unitNumber ?? '—'}</td>}
                          </>
                        ) : (
                          <td colSpan={
                            (result.meta.bucket !== 'total' ? 1 : 0)
                            + (result.meta.level !== 'portfolio' ? 1 : 0)
                            + (result.meta.level === 'unit' ? 1 : 0) || 1
                          }>Total</td>
                        )}
                        {COLS.map(c => <td key={c.key} style={{ textAlign: 'right' }}>{money(t[c.key])}</td>)}
                        <td style={{ textAlign: 'right' }}>{money(row.expenses.maintenance)}</td>
                        <td style={{ textAlign: 'right' }}>{money(row.expenses.entered)}</td>
                        <td style={{ textAlign: 'right' }}>{money(row.expenses.platformFee)}</td>
                        {hasLotRent && <td style={{ textAlign: 'right' }}>{money(row.expenses.lotRent ?? 0)}</td>}
                        <td style={{ textAlign: 'right' }} title="Payment processing fees you cover for tenants, and card fees given back with refunds">{money(Number(row.expenses.processingFees ?? 0) + Number(row.expenses.cardFeesRefunded ?? 0))}</td>
                        <td style={{ textAlign: 'right', color: row.net < 0 ? 'var(--red)' : undefined }}>{money(row.net)}</td>
                        <td style={{ textAlign: 'right', color: (row.netCharged ?? 0) < 0 ? 'var(--red)' : undefined }}>{money(row.netCharged ?? null)}</td>
                        <td style={{ textAlign: 'right' }}>{money(row.derived.netPerUnit)}</td>
                      </tr>
                    )
                  })}
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
// 10/12 (Nic): the income lines are money received; Charged and Owed sit under
// them for each month, with the net on each.
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
    { label: `Total income (${MONEY_COLUMN_LABEL.received.toLowerCase()})`, get: m => at(m, r => r.income.total), strong: true },
    { label: `${MONEY_COLUMN_LABEL.charged} (bills due that month)`, get: m => at(m, r => threeOf(r).charged), indent: true },
    // Decision #25: left out when the server leaves Owed out (a viewer who sees no grand totals).
    ...(result.rows.every(r => r.money == null || r.money.owed != null)
      // 10/12 (ledger P8): on the books, Owed is what tenants still owed at each month's end.
      ? [{ label: result.meta?.source === 'ledger' ? `${MONEY_COLUMN_LABEL.owed} at the month's end` : `${MONEY_COLUMN_LABEL.owed} of those bills today`,
           get: (m: string) => at(m, r => threeOf(r).owed), indent: true }]
      : []),
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
    // 10/11 → 10/12 (Nic): the payment processing fees the landlord covers, listed wherever expenses are.
    { label: 'Payment processing fees', get: (m: string) => at(m, r => Number(r.expenses.processingFees ?? 0)), indent: true },
    // 10/12 (Nic, G10): card fees guests got back with refunds — printed only when there are any.
    ...(result.rows.some(r => Number(r.expenses.cardFeesRefunded ?? 0) !== 0)
      ? [{ label: 'Card fees refunded', get: (m: string) => at(m, r => Number(r.expenses.cardFeesRefunded ?? 0)), indent: true }]
      : []),
    { label: 'Total expenses', get: m => at(m, r => r.expenses.total), strong: true },
    { label: 'Net operating income (on received)', get: m => at(m, r => r.net), strong: true },
    { label: 'Net operating income (on charged)', get: m => at(m, r => Number(r.netCharged ?? 0)), strong: true },
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
        {/* Not while a newer run is out: the PDF would carry the old figures. */}
        <ToolbarBtn onClick={() => window.print()} label="Print / Save PDF" disabled={stale} />
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
        {result.meta.note || 'Twelve complete months; the current partial month is excluded.'}
        {' '}Security deposits are excluded —
        they are tenant funds held, not income. Repairs are included only where an actual cost was
        recorded; estimates are excluded. Costs not tied to a specific unit are shown at the
        property. Prepared from the operator's own records and unaudited.
      </div>
    </div>
  )
}
