/**
 * 10/12 (Nic, ledger P8): the Books statements once a company's books are
 * live — every figure read from the ledger (routes/booksLedgerReports).
 *
 *   "NO Money received / Money billed toggle anywhere — show Charged,
 *   Received and Owed side by side." (L2) "Received leads."
 *
 * The P&L: income by category in Received, Charged and Owed with the strip
 * under it that ties Owed (owed at the start + billed − received − … = owed
 * at the end), expenses by account — paid in the period beside Received,
 * incurred beside Charged — and the net on each, Received first. Money out:
 * incurred, paid and still unpaid by category, and unpaid by vendor. The cash
 * flow: the company's cash at the start, each source of money in and out by
 * operating / investing / financing, and the cash at the end.
 *
 * GAM Books' own file, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). ProfitLossPage and CashFlowPage hand their
 * figures here when the server says they came from the ledger.
 */
import { useState } from 'react'
import { useQuery } from 'react-query'
import {
  formatCurrency, MONEY_COLUMN_LABEL, MONEY_COLUMN_NOTE_LEDGER, INCOME_REPORT_VIEWS, INCOME_REPORT_VIEW_LABEL, type IncomeReportView,
} from '@gam/shared'
import { booksGet as get } from './adapter'
import { MoneyThreeTable, MoneyTieLines, type MoneyThreeRow } from './common'
import { loadErrorText } from './booksMoney'

const money = (n: number | string | null | undefined) => formatCurrency(Number(n ?? 0))
const signed = (n: number) => (n < 0 ? `(${formatCurrency(-n)})` : formatCurrency(n))

/** The report's period pickers (the same two boxes every Books report has). */
export function PeriodPickers({ startDate, endDate, setStartDate, setEndDate }: {
  startDate: string; endDate: string; setStartDate: (v: string) => void; setEndDate: (v: string) => void
}) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} aria-label="From" style={{ width: 'auto', padding: '5px 8px', fontSize: '.75rem' }} />
      <span style={{ color: 'var(--t3)' }}>to</span>
      <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} aria-label="To" style={{ width: 'auto', padding: '5px 8px', fontSize: '.75rem' }} />
    </div>
  )
}

const dayWords = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString()
/** 'YYYY-MM' → "September 2026". */
const monthWords = (ym: string) => new Date(`${ym}-15T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

/** What each column counts on the books, under the table. */
function ColumnNotes() {
  return (
    <div style={{ fontSize: '.7rem', color: 'var(--t3)', lineHeight: 1.5, marginTop: 8 }}>
      {(['received', 'charged', 'owed'] as const).map(k => (
        <p key={k} style={{ margin: '2px 0' }}><strong style={{ color: 'var(--t2)' }}>{MONEY_COLUMN_LABEL[k]}</strong> — {MONEY_COLUMN_NOTE_LEDGER[k]}</p>
      ))}
    </div>
  )
}

/** The ledger P&L (data: GET /books/reports/pl with source 'ledger'). */
export function LedgerProfitLossView({ data, startDate, endDate, setStartDate, setEndDate }: {
  data: any; startDate: string; endDate: string; setStartDate: (v: string) => void; setEndDate: (v: string) => void
}) {
  const view = data?.view ?? {}
  // 10/14 (Nic I1): Summary is today's groups; Detailed itemizes them — rent
  // and stays by space (mobile home lot rent, park-owned trailer rent, RV
  // long-term rent, RV short-term stays, …), home sales, and each space
  // subtype (Single wide, Double wide) under its line.
  const [mode, setMode] = useState<IncomeReportView>('summary')
  const details: any[] = view.details ?? []
  const rows: MoneyThreeRow[] = mode === 'detailed' && details.length > 0
    ? details.flatMap((d: any) => [
        { key: `d:${d.key}`, label: d.label, received: d.received, charged: d.charged, owed: d.owed },
        ...(d.subtypes ?? []).map((t: any) => ({ key: `d:${d.key}|${t.name}`, label: `\u00a0\u00a0\u00a0\u00a0${t.name}`, received: t.received, charged: t.charged, owed: t.owed })),
      ])
    : [
        ...(view.categories ?? []).map((c: any) => ({ key: `c:${c.category}`, label: c.label, received: c.received, charged: c.charged, owed: c.owed })),
        ...(view.uncategorized ?? []).map((l: any) => ({ key: `l:${l.line}`, label: l.label, received: l.received, charged: l.charged, owed: l.owed })),
      ]
  const ex = data?.expenses ?? { rows: [], paid: 0, incurred: 0 }
  const nets = data?.nets ?? { received: 0, charged: 0 }
  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">📈 Profit & Loss</h1>
          <p className="ps">From your books · {dayWords(startDate)} – {dayWords(endDate)}</p>
        </div>
        <PeriodPickers startDate={startDate} endDate={endDate} setStartDate={setStartDate} setEndDate={setEndDate} />
      </div>

      <div className="grid4" style={{ marginBottom: 16 }}>
        <div className="kpi"><div className="kl">Income · {MONEY_COLUMN_LABEL.received}</div><div className="kv g">{money(view.received)}</div><div className="ks">{MONEY_COLUMN_LABEL.charged} {money(view.charged)}</div></div>
        <div className="kpi"><div className="kl">Expenses paid</div><div className="kv r">{money(ex.paid)}</div><div className="ks">Incurred {money(ex.incurred)}</div></div>
        <div className="kpi"><div className="kl">Net · {MONEY_COLUMN_LABEL.received.toLowerCase()}</div><div className={`kv ${nets.received >= 0 ? 'g' : 'r'}`}>{signed(nets.received)}</div><div className="ks">Received less expenses paid</div></div>
        <div className="kpi"><div className="kl">Net · {MONEY_COLUMN_LABEL.charged.toLowerCase()}</div><div className={`kv ${nets.charged >= 0 ? 'g' : 'r'}`}>{signed(nets.charged)}</div><div className="ks">Charged less expenses incurred</div></div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <div className="ct">Income</div>
          {details.length > 0 && (
            <div role="group" aria-label="Income view" style={{ display: 'inline-flex', gap: 4 }}>
              {INCOME_REPORT_VIEWS.map(v => (
                <button key={v} type="button" aria-pressed={mode === v} onClick={() => setMode(v)}
                  className={mode === v ? 'btn bp bsm' : 'btn bg-btn bsm'}>{INCOME_REPORT_VIEW_LABEL[v]}</button>
              ))}
            </div>
          )}
        </div>
        <MoneyThreeTable rows={rows} totalLabel="Total income" total={{ received: view.received, charged: view.charged, owed: view.owed }} />
        <MoneyTieLines lines={view.tieText} />
        {(view.beside ?? []).length > 0 && (
          <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px dashed var(--b1)' }}>
            {view.beside.map((b: any) => (
              <div key={b.key} className="dr"><span className="dk">{b.label} (beside the total)</span><span className="dv mono">{money(b.amount)}</span></div>
            ))}
          </div>
        )}
        {(data?.chargedBeside ?? []).length > 0 && (
          <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px dashed var(--b1)' }}>
            {data.chargedBeside.map((b: any) => (
              <div key={b.key} className="dr"><span className="dk">{b.label} (beside {MONEY_COLUMN_LABEL.charged})</span><span className="dv mono">{money(b.amount)}</span></div>
            ))}
          </div>
        )}
        <ColumnNotes />
      </div>

      {view.owed != null && <ReceivablesCard asOf={endDate} />}

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="ct">Expenses</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl" style={{ minWidth: 360 }}>
            <thead><tr><th>Account</th><th style={{ textAlign: 'right' }}>Paid</th><th style={{ textAlign: 'right' }}>Incurred</th></tr></thead>
            <tbody>
              {ex.rows.map((a: any) => (
                <tr key={a.accountId}>
                  <td style={{ fontSize: '.78rem' }}>{a.code} · {a.name}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(a.paid)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(a.incurred)}</td>
                </tr>
              ))}
              {ex.rows.length === 0 && <tr><td colSpan={3} style={{ color: 'var(--t3)', fontSize: '.78rem' }}>No expenses in this period.</td></tr>}
              <tr style={{ borderTop: '2px solid var(--b1)' }}>
                <td style={{ fontWeight: 700, color: 'var(--t0)' }}>Total expenses</td>
                <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: 'var(--red)' }}>{money(ex.paid)}</td>
                <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: 'var(--red)' }}>{money(ex.incurred)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: '.7rem', color: 'var(--t3)', lineHeight: 1.5, marginTop: 8 }}>
          Paid counts a bill on the day you paid it, a fee on the day it came out of your money, and payroll on the pay date. Incurred counts each expense on its own date, paid or not.
        </div>
      </div>

      {(data?.corrections ?? []).length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="ct">Corrections to closed months, posted in this period</div>
          {data.corrections.map((c: any) => (
            <div key={c.month} className="dr">
              <span className="dk">Corrections to {monthWords(c.month)}</span>
              <span className="dv mono">{MONEY_COLUMN_LABEL.received} {money(c.received)} · {MONEY_COLUMN_LABEL.charged} {money(c.charged)} · expenses {money(c.expensesIncurred)}</span>
            </div>
          ))}
          <div className="bnote">A closed month never changes: what belongs to it but came in later is counted here, in the figures above.</div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="ct">Net</div>
        <div className="dr"><span className="dk" style={{ fontWeight: 700 }}>{MONEY_COLUMN_LABEL.received} less expenses paid</span><span className="dv mono" style={{ fontWeight: 700, color: nets.received >= 0 ? 'var(--green)' : 'var(--red)' }}>{signed(nets.received)}</span></div>
        <div className="dr"><span className="dk">{MONEY_COLUMN_LABEL.charged} less expenses incurred</span><span className="dv mono" style={{ color: nets.charged >= 0 ? 'var(--green)' : 'var(--red)' }}>{signed(nets.charged)}</span></div>
      </div>

      <MoneyOutCard startDate={startDate} endDate={endDate} />

      {(data?.incomeAccounts ?? []).length > 0 && (
        <details className="card" style={{ marginBottom: 12 }}>
          <summary className="ct" style={{ cursor: 'pointer', marginBottom: 0 }}>Income by account ({MONEY_COLUMN_LABEL.charged.toLowerCase()})</summary>
          <div style={{ marginTop: 10 }}>
            {data.incomeAccounts.map((a: any) => (
              <div key={a.accountId} className="dr"><span className="dk">{a.code} · {a.name}</span><span className="dv mono">{money(a.charged)}</span></div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

const AGING_ORDER = ['current', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const

/** What tenants owed on a day, by household and property, aged (GET /books/reports/receivables). */
export function ReceivablesCard({ asOf }: { asOf: string }) {
  const { data, error } = useQuery(['receivables', asOf], () => get<any>(`/books/reports/receivables?asOf=${asOf}`))
  if (error) return <div className="alert aw">{loadErrorText(error, 'Could not load what tenants owe.')}</div>
  if (!data || data.live === false || !(data.rows ?? []).length) return null
  const labels = data.bucketLabels ?? {}
  const used = AGING_ORDER.filter(b => Number(data.totals?.buckets?.[b]))
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="ct">{MONEY_COLUMN_LABEL.owed} on {dayWords(asOf)}, by tenant and age</div>
      <div style={{ overflowX: 'auto' }}>
        <table className="tbl" style={{ minWidth: 420 }}>
          <thead><tr>
            <th>Tenant</th><th>Property</th>
            {used.map(b => <th key={b} style={{ textAlign: 'right' }}>{labels[b] ?? ''}</th>)}
            <th style={{ textAlign: 'right' }}>{MONEY_COLUMN_LABEL.owed}</th>
          </tr></thead>
          <tbody>
            {data.rows.map((r: any) => (
              <tr key={`${r.tenantId ?? 'none'}|${r.propertyId ?? 'none'}`}>
                <td style={{ fontSize: '.78rem' }}>{r.tenantName ?? 'No tenant named'}</td>
                <td style={{ fontSize: '.75rem' }}>{r.propertyName ?? ''}</td>
                {used.map(b => <td key={b} className="mono" style={{ textAlign: 'right' }}>{Number(r.buckets?.[b]) ? money(r.buckets[b]) : ''}</td>)}
                <td className="mono" style={{ textAlign: 'right', color: 'var(--amber)' }}>{money(r.total)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: '2px solid var(--b1)' }}>
              <td colSpan={2} style={{ fontWeight: 700, color: 'var(--t0)' }}>Total</td>
              {used.map(b => <td key={b} className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{money(data.totals.buckets[b])}</td>)}
              <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{money(data.totals.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Money out (GET /books/reports/money-out): incurred, paid and unpaid by category; unpaid by vendor. */
export function MoneyOutCard({ startDate, endDate }: { startDate: string; endDate: string }) {
  const { data, error } = useQuery(['money-out', startDate, endDate],
    () => get<any>(`/books/reports/money-out?startDate=${startDate}&endDate=${endDate}`))
  if (error) return <div className="alert aw">{loadErrorText(error, 'Could not load money out.')}</div>
  if (!data || data.live === false) return null
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="ct">Money out</div>
      <div style={{ overflowX: 'auto' }}>
        <table className="tbl" style={{ minWidth: 420 }}>
          <thead><tr><th>Category</th><th style={{ textAlign: 'right' }}>Incurred</th><th style={{ textAlign: 'right' }}>Paid</th><th style={{ textAlign: 'right' }}>Unpaid</th></tr></thead>
          <tbody>
            {(data.rows ?? []).map((r: any) => (
              <tr key={r.key}>
                <td style={{ fontSize: '.78rem' }}>{r.label}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{money(r.incurred)}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{money(r.paid)}</td>
                <td className="mono" style={{ textAlign: 'right', color: Number(r.unpaid) ? 'var(--amber)' : 'var(--t1)' }}>{money(r.unpaid)}</td>
              </tr>
            ))}
            {(data.rows ?? []).length === 0 && <tr><td colSpan={4} style={{ color: 'var(--t3)', fontSize: '.78rem' }}>No money out in this period.</td></tr>}
            <tr style={{ borderTop: '2px solid var(--b1)' }}>
              <td style={{ fontWeight: 700, color: 'var(--t0)' }}>Total</td>
              <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{money(data.totals?.incurred)}</td>
              <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{money(data.totals?.paid)}</td>
              <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{money(data.totals?.unpaid)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {(data.notExpenses ?? []).length > 0 && (
        <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px dashed var(--b1)' }}>
          {data.notExpenses.map((k: any) => (
            <div key={k.kind} className="dr"><span className="dk">{k.label} (not a cost)</span><span className="dv mono">{money(k.paid)}</span></div>
          ))}
        </div>
      )}
      {(data.unpaidByVendor ?? []).length > 0 && (
        <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px dashed var(--b1)' }}>
          <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--t2)', marginBottom: 4 }}>Still unpaid, by vendor, on {dayWords(endDate)}</div>
          {data.unpaidByVendor.map((v: any) => (
            <div key={v.vendorId ?? 'none'} className="dr"><span className="dk">{v.name}</span><span className="dv mono" style={{ color: 'var(--amber)' }}>{money(v.unpaid)}</span></div>
          ))}
        </div>
      )}
    </div>
  )
}

const SECTION_LABEL: Record<string, string> = {
  operating: 'Operating activities',
  investing: 'Investing activities',
  financing: 'Financing activities',
  opening: 'Opening balances',
}

/** The ledger cash flow (data: GET /books/reports/cash-flow with source 'ledger'). */
export function LedgerCashFlowView({ data, startDate, endDate, setStartDate, setEndDate }: {
  data: any; startDate: string; endDate: string; setStartDate: (v: string) => void; setEndDate: (v: string) => void
}) {
  const rows: any[] = data?.rows ?? []
  const sections = (['operating', 'investing', 'financing', 'opening'] as const).filter(s => rows.some(r => r.section === s))
  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">💧 Cash Flow Statement</h1>
          <p className="ps">Your bank accounts, the drawer and money on its way to the bank · {dayWords(startDate)} – {dayWords(endDate)}</p>
        </div>
        <PeriodPickers startDate={startDate} endDate={endDate} setStartDate={setStartDate} setEndDate={setEndDate} />
      </div>
      <div className="grid4" style={{ marginBottom: 16 }}>
        <div className="kpi"><div className="kl">Cash at the start</div><div className="kv">{money(data?.openingCash)}</div><div className="ks">{dayWords(startDate)}</div></div>
        <div className="kpi"><div className="kl">Operating</div><div className={`kv ${Number(data?.totals?.operating) >= 0 ? 'g' : 'r'}`}>{signed(Number(data?.totals?.operating ?? 0))}</div><div className="ks">Tenants, sales, expenses, payroll</div></div>
        <div className="kpi"><div className="kl">Net change</div><div className={`kv ${Number(data?.netChange) >= 0 ? 'g' : 'r'}`}>{signed(Number(data?.netChange ?? 0))}</div><div className="ks">Every row below added up</div></div>
        <div className="kpi"><div className="kl">Cash at the end</div><div className="kv">{money(data?.closingCash)}</div><div className="ks">{dayWords(endDate)}</div></div>
      </div>
      <div className="grid2">
        <div>
          {sections.map(sec => (
            <div key={sec} className="card" style={{ marginBottom: 12 }}>
              <div className="ct">{SECTION_LABEL[sec]}</div>
              {rows.filter(r => r.section === sec).map(r => (
                <div key={`${r.section}|${r.key}`} className="dr"><span className="dk">{r.label}</span><span className="dv mono" style={{ color: r.amount < 0 ? 'var(--red)' : 'var(--green)' }}>{signed(r.amount)}</span></div>
              ))}
              <div className="dr" style={{ borderTop: '2px solid var(--b1)', paddingTop: 8, marginTop: 8 }}>
                <span style={{ fontWeight: 700, color: 'var(--t0)' }}>Net {SECTION_LABEL[sec].toLowerCase()}</span>
                <span className="dv mono" style={{ fontWeight: 700 }}>{signed(Number(data?.totals?.[sec] ?? 0))}</span>
              </div>
            </div>
          ))}
          {sections.length === 0 && <div className="card" style={{ color: 'var(--t3)', fontSize: '.8rem' }}>No money moved in or out of your cash in this period.</div>}
        </div>
        <div className="card" style={{ alignSelf: 'start' }}>
          <div className="ct">How it adds up</div>
          <div className="dr"><span className="dk">Cash at the start</span><span className="dv mono">{money(data?.openingCash)}</span></div>
          {sections.map(sec => (
            <div key={sec} className="dr"><span className="dk">{SECTION_LABEL[sec]}</span><span className="dv mono">{signed(Number(data?.totals?.[sec] ?? 0))}</span></div>
          ))}
          <div className="dr" style={{ borderTop: '2px solid var(--b1)', paddingTop: 8, marginTop: 8 }}>
            <span style={{ fontWeight: 800, color: 'var(--t0)' }}>Cash at the end</span>
            <span className="dv mono" style={{ fontWeight: 800 }}>{money(data?.closingCash)}</span>
          </div>
          <div className="bnote">Money GAM collected for you counts when it is on its way to your bank. A move between two of your own accounts is not in any row.</div>
        </div>
      </div>
    </div>
  )
}

/** The plain-words reason a ledger-only report has nothing to show yet. */
export function LedgerNotLive({ reason }: { reason: string | null | undefined }) {
  return <div className="alert aw">{reason || 'Your books are not ready yet.'}</div>
}
