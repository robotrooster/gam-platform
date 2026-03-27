import { useState, useRef } from 'react'
import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
import { formatCurrency } from '@gam/shared'
import { FileText, Download, Printer, TrendingUp, Building2, Users, DollarSign, AlertTriangle } from 'lucide-react'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const currentYear  = new Date().getFullYear()
const currentMonth = new Date().getMonth() + 1 // 1-indexed to match API

type ReportType = 'monthly'|'tax'|'property-pl'|'pm-client'|'work-trade-1099'

export function ReportsPage() {
  const [reportType, setReportType] = useState<ReportType>('monthly')
  const [year,  setYear]  = useState(currentYear)
  const [month, setMonth] = useState(currentMonth)
  const printRef = useRef<HTMLDivElement>(null)

  const params = new URLSearchParams({ year: String(year), month: String(month) })

  const { data: monthlyData, isLoading: mlLoading } = useQuery(
    ['report-monthly', year, month],
    () => apiGet<any>(`/reports/monthly-statement?${params}`),
    { enabled: reportType === 'monthly' }
  )
  const { data: taxData, isLoading: taxLoading } = useQuery(
    ['report-tax', year],
    () => apiGet<any>(`/reports/tax-summary?year=${year}`),
    { enabled: reportType === 'tax' }
  )
  const { data: plData, isLoading: plLoading } = useQuery(
    ['report-pl', year, month],
    () => apiGet<any>(`/reports/property-pl?year=${year}&month=${month}`),
    { enabled: reportType === 'property-pl' }
  )
  const { data: pmData, isLoading: pmLoading } = useQuery(
    ['report-pm', year, month],
    () => apiGet<any>(`/reports/pm-client?${params}`),
    { enabled: reportType === 'pm-client', retry: false }
  )
  const { data: wt1099Data, isLoading: wtLoading } = useQuery(
    ['report-1099', year],
    () => apiGet<any>(`/reports/work-trade-1099?year=${year}`),
    { enabled: reportType === 'work-trade-1099' }
  )

  const isLoading = mlLoading || taxLoading || plLoading || pmLoading || wtLoading

  const handlePrint = () => window.print()

  const REPORT_TYPES = [
    { id:'monthly',          label:'Monthly Statement',   icon:'📋', desc:'Income, expenses, net' },
    { id:'tax',              label:'Annual Tax Summary',  icon:'🏛️', desc:'1099-ready breakdown' },
    { id:'property-pl',      label:'Property P&L',        icon:'📊', desc:'Per-property profit & loss' },
    { id:'pm-client',        label:'PM Client Report',    icon:'🏢', desc:'PM fee breakdown' },
    { id:'work-trade-1099',  label:'Work Trade 1099',     icon:'⚡', desc:'Labor value summary' },
  ]

  return (
    <div>
      {/* Controls - hidden on print */}
      <div className="no-print">
        <div className="page-header">
          <div>
            <h1 className="page-title">Reports</h1>
            <p className="page-subtitle">Generate and print financial statements</p>
          </div>
          <button className="btn btn-primary" onClick={handlePrint}>
            <Printer size={15} /> Print / Save PDF
          </button>
        </div>

        {/* Report type selector */}
        <div style={{ display:'flex', gap:8, marginBottom:20, flexWrap:'wrap' }}>
          {REPORT_TYPES.map(r => (
            <button key={r.id} onClick={() => setReportType(r.id as ReportType)}
              className={`btn btn-sm ${reportType===r.id?'btn-primary':'btn-ghost'}`}
              style={{ display:'flex', alignItems:'center', gap:6 }}>
              <span>{r.icon}</span> {r.label}
            </button>
          ))}
        </div>

        {/* Period selector */}
        <div style={{ display:'flex', gap:12, alignItems:'center', marginBottom:24, padding:'12px 16px', background:'var(--bg-2)', border:'1px solid var(--border-0)', borderRadius:10 }}>
          <select className="input" value={year} onChange={e => setYear(parseInt(e.target.value))} style={{ width:100 }}>
            {[currentYear, currentYear-1, currentYear-2].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          {(reportType === 'monthly' || reportType === 'property-pl' || reportType === 'pm-client') && (
            <select className="input" value={month} onChange={e => setMonth(parseInt(e.target.value))} style={{ width:140 }}>
              {MONTHS.map((m,i) => <option key={i+1} value={i+1}>{m}</option>)}
            </select>
          )}
          <div style={{ fontSize:'.78rem', color:'var(--text-3)' }}>
            {reportType === 'monthly' || reportType === 'pm-client' ? `${MONTHS[month-1]} ${year} Statement` :
             reportType === 'tax' || reportType === 'work-trade-1099' ? `${year} Annual Summary` :
             `${MONTHS[month-1]} ${year} P&L`}
          </div>
        </div>
      </div>

      {/* Print area */}
      <div ref={printRef} className="print-area">
        {isLoading && <div style={{ padding:48, textAlign:'center', color:'var(--text-3)' }}>Loading report…</div>}

        {/* ── MONTHLY STATEMENT ── */}
        {reportType === 'monthly' && monthlyData && (
          <MonthlyStatement data={monthlyData} year={year} month={month} />
        )}

        {/* ── TAX SUMMARY ── */}
        {reportType === 'tax' && taxData && (
          <TaxSummary data={taxData} year={year} />
        )}

        {/* ── PROPERTY P&L ── */}
        {reportType === 'property-pl' && plData && (
          <PropertyPL data={plData} year={year} month={month} />
        )}

        {/* ── PM CLIENT REPORT ── */}
        {reportType === 'pm-client' && (
          pmData ? <PMClientReport data={pmData} year={year} month={month} /> :
          <div style={{ padding:32, textAlign:'center' }}>
            <div style={{ fontSize:'.9rem', color:'var(--text-3)' }}>Not connected to a PM company. Connect in Settings → Management.</div>
          </div>
        )}

        {/* ── WORK TRADE 1099 ── */}
        {reportType === 'work-trade-1099' && wt1099Data && (
          <WorkTrade1099 data={wt1099Data} year={year} />
        )}
      </div>

      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; color: black !important; }
          .print-area { padding: 0 !important; }
        }
      `}</style>
    </div>
  )
}

// ── MONTHLY STATEMENT ─────────────────────────────────────────
function MonthlyStatement({ data, year, month }: { data: any; year: number; month: number }) {
  const { landlord, summary, payments, maintenance, properties, pmInfo, pmPlan } = data
  const monthName = MONTHS[month-1]

  return (
    <div style={{ fontFamily:'Georgia, serif', maxWidth:800, margin:'0 auto', color:'#1a1a1a' }}>

      {/* Header */}
      <div style={{ borderBottom:'3px solid #c9a227', paddingBottom:20, marginBottom:24 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
          <div>
            <div style={{ fontSize:22, fontWeight:800, color:'#c9a227', fontFamily:'system-ui', letterSpacing:'.04em' }}>⚡ GOLD ASSET MANAGEMENT</div>
            <div style={{ fontSize:11, color:'#666', marginTop:4, letterSpacing:'.06em', textTransform:'uppercase' }}>Owner Financial Statement</div>
          </div>
          <div style={{ textAlign:'right' }}>
            <div style={{ fontSize:16, fontWeight:700 }}>{monthName} {year}</div>
            <div style={{ fontSize:11, color:'#666', marginTop:2 }}>Generated {new Date().toLocaleDateString()}</div>
          </div>
        </div>
        <div style={{ marginTop:16, display:'grid', gridTemplateColumns:'1fr 1fr', gap:24 }}>
          <div>
            <div style={{ fontSize:10, color:'#666', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:4 }}>Prepared For</div>
            <div style={{ fontWeight:700, fontSize:14 }}>{landlord.first_name} {landlord.last_name}</div>
            <div style={{ fontSize:12, color:'#444' }}>{landlord.email}</div>
            {landlord.business_name && <div style={{ fontSize:12, color:'#444' }}>{landlord.business_name}</div>}
          </div>
          {pmInfo && (
            <div>
              <div style={{ fontSize:10, color:'#666', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:4 }}>Managed By</div>
              <div style={{ fontWeight:700, fontSize:14 }}>{pmInfo.name}</div>
              <div style={{ fontSize:12, color:'#444' }}>
                {pmPlan?.name} · {pmPlan?.fee_type==='percent'?`${pmPlan.percent_rate}% of rent`:pmPlan?.fee_type==='flat'?`$${pmPlan.flat_amount}/unit`:`${pmPlan?.percent_rate}% + $${pmPlan?.flat_amount}/unit`}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Summary boxes */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:28 }}>
        {[
          { label:'Rent Collected',   val: formatCurrency(summary.totalCollected),    border:'#22c55e' },
          { label:'Platform Fees',    val: formatCurrency(summary.totalPlatformFees), border:'#ef4444' },
          { label:'Maintenance',      val: formatCurrency(summary.totalMaintCost),    border:'#f59e0b' },
          { label:'Net to Owner',     val: formatCurrency(summary.netToOwner),        border:'#c9a227' },
        ].map(s => (
          <div key={s.label} style={{ border:`2px solid ${s.border}`, borderRadius:8, padding:'12px 14px', textAlign:'center' }}>
            <div style={{ fontSize:10, color:'#666', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6 }}>{s.label}</div>
            <div style={{ fontSize:18, fontWeight:800, fontFamily:'system-ui' }}>{s.val}</div>
          </div>
        ))}
      </div>

      {/* Portfolio summary */}
      <div style={{ marginBottom:28 }}>
        <div style={{ fontSize:13, fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', borderBottom:'1px solid #ddd', paddingBottom:6, marginBottom:12, color:'#333' }}>Portfolio Summary</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:16 }}>
          <div style={{ background:'#f9f9f9', borderRadius:6, padding:'10px 12px' }}>
            <div style={{ fontSize:10, color:'#888', marginBottom:3 }}>OCCUPIED UNITS</div>
            <div style={{ fontSize:16, fontWeight:700 }}>{summary.occupiedUnits}</div>
          </div>
          <div style={{ background:'#f9f9f9', borderRadius:6, padding:'10px 12px' }}>
            <div style={{ fontSize:10, color:'#888', marginBottom:3 }}>VACANT UNITS</div>
            <div style={{ fontSize:16, fontWeight:700 }}>{summary.vacantUnits}</div>
          </div>
          <div style={{ background:'#f9f9f9', borderRadius:6, padding:'10px 12px' }}>
            <div style={{ fontSize:10, color:'#888', marginBottom:3 }}>PAYMENTS SETTLED</div>
            <div style={{ fontSize:16, fontWeight:700 }}>{summary.settledPayments}</div>
          </div>
        </div>
      </div>

      {/* Income detail */}
      <div style={{ marginBottom:28 }}>
        <div style={{ fontSize:13, fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', borderBottom:'1px solid #ddd', paddingBottom:6, marginBottom:12, color:'#333' }}>Income Detail</div>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
          <thead>
            <tr style={{ background:'#f5f5f5' }}>
              <th style={{ textAlign:'left', padding:'8px 10px', fontWeight:600 }}>Date</th>
              <th style={{ textAlign:'left', padding:'8px 10px', fontWeight:600 }}>Tenant</th>
              <th style={{ textAlign:'left', padding:'8px 10px', fontWeight:600 }}>Unit</th>
              <th style={{ textAlign:'left', padding:'8px 10px', fontWeight:600 }}>Property</th>
              <th style={{ textAlign:'right', padding:'8px 10px', fontWeight:600 }}>Amount</th>
              <th style={{ textAlign:'center', padding:'8px 10px', fontWeight:600 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p: any, i: number) => (
              <tr key={p.id} style={{ borderBottom:'1px solid #eee', background: i%2===0?'white':'#fafafa' }}>
                <td style={{ padding:'7px 10px' }}>{new Date(p.due_date).toLocaleDateString()}</td>
                <td style={{ padding:'7px 10px' }}>{p.tenant_first} {p.tenant_last}</td>
                <td style={{ padding:'7px 10px', fontFamily:'monospace' }}>{p.unit_number}</td>
                <td style={{ padding:'7px 10px' }}>{p.property_name}</td>
                <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'monospace' }}>{formatCurrency(p.amount)}</td>
                <td style={{ padding:'7px 10px', textAlign:'center' }}>
                  <span style={{ padding:'2px 8px', borderRadius:10, fontSize:10, fontWeight:700, background: p.status==='settled'?'#dcfce7':p.status==='late'?'#fef3c7':'#fee2e2', color: p.status==='settled'?'#166534':p.status==='late'?'#92400e':'#991b1b' }}>
                    {p.status.toUpperCase()}
                  </span>
                </td>
              </tr>
            ))}
            {payments.length === 0 && <tr><td colSpan={6} style={{ padding:16, textAlign:'center', color:'#999' }}>No payments this period</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Expenses */}
      <div style={{ marginBottom:28 }}>
        <div style={{ fontSize:13, fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', borderBottom:'1px solid #ddd', paddingBottom:6, marginBottom:12, color:'#333' }}>Expense Detail</div>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
          <thead>
            <tr style={{ background:'#f5f5f5' }}>
              <th style={{ textAlign:'left', padding:'8px 10px', fontWeight:600 }}>Type</th>
              <th style={{ textAlign:'left', padding:'8px 10px', fontWeight:600 }}>Description</th>
              <th style={{ textAlign:'right', padding:'8px 10px', fontWeight:600 }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom:'1px solid #eee' }}>
              <td style={{ padding:'7px 10px' }}>Platform Fee</td>
              <td style={{ padding:'7px 10px' }}>{summary.occupiedUnits} units × $15.00/mo (On-Time Pay SLA)</td>
              <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'monospace' }}>{formatCurrency(summary.totalPlatformFees)}</td>
            </tr>
            {maintenance.map((m: any) => (
              <tr key={m.id} style={{ borderBottom:'1px solid #eee', background:'#fafafa' }}>
                <td style={{ padding:'7px 10px' }}>Maintenance</td>
                <td style={{ padding:'7px 10px' }}>{m.title} — Unit {m.unit_number}, {m.property_name}</td>
                <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'monospace' }}>{formatCurrency(m.actual_cost)}</td>
              </tr>
            ))}
            {summary.pmFee > 0 && (
              <tr style={{ borderBottom:'1px solid #eee' }}>
                <td style={{ padding:'7px 10px' }}>PM Fee</td>
                <td style={{ padding:'7px 10px' }}>{pmInfo?.name} — {pmPlan?.name}</td>
                <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'monospace' }}>{formatCurrency(summary.pmFee)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Net summary */}
      <div style={{ background:'#f9f7ee', border:'2px solid #c9a227', borderRadius:10, padding:20, marginBottom:28 }}>
        <div style={{ fontSize:13, fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:14, color:'#333' }}>Net Summary</div>
        {[
          { label:'Total Rent Collected',   val: formatCurrency(summary.totalCollected),    color:'#166534' },
          { label:'Platform Fees',          val: `(${formatCurrency(summary.totalPlatformFees)})`, color:'#991b1b' },
          { label:'Maintenance Costs',      val: `(${formatCurrency(summary.totalMaintCost)})`,    color:'#991b1b' },
          ...(summary.pmFee > 0 ? [{ label:'PM Management Fee', val:`(${formatCurrency(summary.pmFee)})`, color:'#991b1b' }] : []),
        ].map(row => (
          <div key={row.label} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:13 }}>
            <span style={{ color:'#444' }}>{row.label}</span>
            <span style={{ fontFamily:'monospace', fontWeight:600, color:row.color }}>{row.val}</span>
          </div>
        ))}
        <div style={{ borderTop:'2px solid #c9a227', marginTop:10, paddingTop:10, display:'flex', justifyContent:'space-between' }}>
          <span style={{ fontWeight:800, fontSize:15 }}>NET TO OWNER</span>
          <span style={{ fontFamily:'monospace', fontWeight:800, fontSize:18, color: summary.netToOwner >= 0 ? '#166534' : '#991b1b' }}>{formatCurrency(summary.netToOwner)}</span>
        </div>
      </div>

      <div style={{ fontSize:10, color:'#999', textAlign:'center', borderTop:'1px solid #eee', paddingTop:12 }}>
        Gold Asset Management LLC · On-Time Pay SLA Statement · {monthName} {year} · Confidential
      </div>
    </div>
  )
}

// ── TAX SUMMARY ───────────────────────────────────────────────
function TaxSummary({ data, year }: { data: any; year: number }) {
  const { landlord, income, deductions, deposits, monthlyBreakdown, w2099Threshold } = data
  return (
    <div style={{ fontFamily:'Georgia, serif', maxWidth:800, margin:'0 auto', color:'#1a1a1a' }}>
      <div style={{ borderBottom:'3px solid #c9a227', paddingBottom:20, marginBottom:24 }}>
        <div style={{ display:'flex', justifyContent:'space-between' }}>
          <div>
            <div style={{ fontSize:22, fontWeight:800, color:'#c9a227', fontFamily:'system-ui' }}>⚡ GOLD ASSET MANAGEMENT</div>
            <div style={{ fontSize:11, color:'#666', marginTop:4, letterSpacing:'.06em', textTransform:'uppercase' }}>Annual Tax Summary — {year}</div>
          </div>
          <div style={{ textAlign:'right' }}>
            <div style={{ fontSize:14, fontWeight:700 }}>{landlord.first_name} {landlord.last_name}</div>
            {landlord.ein && <div style={{ fontSize:12, color:'#666' }}>EIN: {landlord.ein}</div>}
            <div style={{ fontSize:11, color:'#999', marginTop:2 }}>Generated {new Date().toLocaleDateString()}</div>
          </div>
        </div>
      </div>

      <div style={{ background:'#fff3cd', border:'1px solid #ffc107', borderRadius:8, padding:14, marginBottom:24, fontSize:12, color:'#664d03' }}>
        ⚠️ This summary is provided for informational purposes only and does not constitute tax advice. Consult a qualified tax professional for preparation of your tax returns.
      </div>

      {/* Income */}
      <div style={{ marginBottom:24 }}>
        <div style={{ fontSize:13, fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', borderBottom:'2px solid #22c55e', paddingBottom:6, marginBottom:12 }}>INCOME</div>
        <div style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:'1px solid #eee', fontSize:13 }}>
          <span>Gross Rental Income</span>
          <span style={{ fontFamily:'monospace', fontWeight:700, color:'#166534' }}>{formatCurrency(income.totalRent)}</span>
        </div>
        <div style={{ fontSize:11, color:'#999', marginTop:4 }}>Based on {income.paymentCount} settled payments</div>
      </div>

      {/* Deductions */}
      <div style={{ marginBottom:24 }}>
        <div style={{ fontSize:13, fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', borderBottom:'2px solid #ef4444', paddingBottom:6, marginBottom:12 }}>DEDUCTIBLE EXPENSES</div>
        {[
          { label:'Platform Fees (GAM On-Time Pay)', val: deductions.platformFees, note:'Schedule E — Management fees' },
          { label:'Maintenance & Repairs',           val: deductions.maintExpenses, note:'Schedule E — Repairs' },
          { label:'Maintenance Platform Fees',       val: deductions.maintFees,    note:'Schedule E — Management fees' },
          ...(data.pmInfo ? [{ label:`PM Fees — ${data.pmInfo.name}`, val:0, note:'Schedule E — Management fees' }] : []),
        ].map(row => (
          <div key={row.label} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0', borderBottom:'1px solid #eee' }}>
            <div>
              <div style={{ fontSize:13 }}>{row.label}</div>
              <div style={{ fontSize:10, color:'#999' }}>{row.note}</div>
            </div>
            <span style={{ fontFamily:'monospace', fontWeight:600, color:'#991b1b' }}>{formatCurrency(row.val)}</span>
          </div>
        ))}
        <div style={{ display:'flex', justifyContent:'space-between', padding:'10px 0', fontWeight:700, fontSize:14, borderTop:'2px solid #ddd', marginTop:4 }}>
          <span>Total Deductions</span>
          <span style={{ fontFamily:'monospace', color:'#991b1b' }}>{formatCurrency(deductions.platformFees + deductions.maintExpenses + deductions.maintFees)}</span>
        </div>
      </div>

      {/* Net */}
      <div style={{ background:'#f9f7ee', border:'2px solid #c9a227', borderRadius:10, padding:20, marginBottom:24 }}>
        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
          <span style={{ fontSize:13 }}>Gross Rental Income</span>
          <span style={{ fontFamily:'monospace' }}>{formatCurrency(income.totalRent)}</span>
        </div>
        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
          <span style={{ fontSize:13 }}>Total Deductible Expenses</span>
          <span style={{ fontFamily:'monospace', color:'#991b1b' }}>({formatCurrency(deductions.platformFees + deductions.maintExpenses + deductions.maintFees)})</span>
        </div>
        <div style={{ borderTop:'2px solid #c9a227', paddingTop:10, display:'flex', justifyContent:'space-between' }}>
          <span style={{ fontWeight:800, fontSize:15 }}>NET RENTAL INCOME</span>
          <span style={{ fontFamily:'monospace', fontWeight:800, fontSize:18, color: data.netIncome >= 0 ? '#166534' : '#991b1b' }}>{formatCurrency(data.netIncome)}</span>
        </div>
      </div>

      {/* Security deposits */}
      <div style={{ marginBottom:24 }}>
        <div style={{ fontSize:13, fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', borderBottom:'1px solid #ddd', paddingBottom:6, marginBottom:12 }}>SECURITY DEPOSITS HELD</div>
        <div style={{ fontSize:13, color:'#444' }}>
          Total held: <strong>{formatCurrency(deposits.totalHeld)}</strong>
          <div style={{ fontSize:11, color:'#999', marginTop:4 }}>Security deposits held in trust are generally not taxable income until applied or forfeited. Consult your tax advisor.</div>
        </div>
      </div>

      {/* 1099 threshold */}
      {w2099Threshold?.length > 0 && (
        <div style={{ marginBottom:24 }}>
          <div style={{ fontSize:13, fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', borderBottom:'2px solid #f59e0b', paddingBottom:6, marginBottom:12 }}>1099-NEC REQUIRED — WORK TRADE</div>
          <div style={{ background:'#fef3c7', border:'1px solid #ffc107', borderRadius:6, padding:12, marginBottom:12, fontSize:11, color:'#664d03' }}>
            The following tenants received work trade compensation valued at $600 or more. A 1099-NEC must be issued by January 31st.
          </div>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
            <thead>
              <tr style={{ background:'#f5f5f5' }}>
                <th style={{ textAlign:'left', padding:'8px 10px', fontWeight:600 }}>Tenant</th>
                <th style={{ textAlign:'left', padding:'8px 10px', fontWeight:600 }}>Unit</th>
                <th style={{ textAlign:'right', padding:'8px 10px', fontWeight:600 }}>YTD Value</th>
              </tr>
            </thead>
            <tbody>
              {w2099Threshold.map((w: any) => (
                <tr key={w.id} style={{ borderBottom:'1px solid #eee' }}>
                  <td style={{ padding:'7px 10px' }}>{w.tenant_first} {w.tenant_last}</td>
                  <td style={{ padding:'7px 10px', fontFamily:'monospace' }}>{w.unit_number} — {w.property_name}</td>
                  <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'monospace', fontWeight:700 }}>{formatCurrency(w.ytd_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Monthly breakdown */}
      <div style={{ marginBottom:24 }}>
        <div style={{ fontSize:13, fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', borderBottom:'1px solid #ddd', paddingBottom:6, marginBottom:12 }}>MONTHLY BREAKDOWN</div>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
          <thead>
            <tr style={{ background:'#f5f5f5' }}>
              <th style={{ textAlign:'left', padding:'8px 10px', fontWeight:600 }}>Month</th>
              <th style={{ textAlign:'right', padding:'8px 10px', fontWeight:600 }}>Collected</th>
              <th style={{ textAlign:'right', padding:'8px 10px', fontWeight:600 }}>Paid</th>
              <th style={{ textAlign:'right', padding:'8px 10px', fontWeight:600 }}>Failed</th>
            </tr>
          </thead>
          <tbody>
            {monthlyBreakdown.map((m: any) => (
              <tr key={m.month} style={{ borderBottom:'1px solid #eee' }}>
                <td style={{ padding:'7px 10px' }}>{MONTHS[m.month-1]}</td>
                <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'monospace' }}>{formatCurrency(m.collected)}</td>
                <td style={{ padding:'7px 10px', textAlign:'right' }}>{m.paid}</td>
                <td style={{ padding:'7px 10px', textAlign:'right', color: m.failed > 0 ? '#991b1b' : 'inherit' }}>{m.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize:10, color:'#999', textAlign:'center', borderTop:'1px solid #eee', paddingTop:12 }}>
        Gold Asset Management LLC · Tax Summary {year} · For informational purposes only · Not tax advice
      </div>
    </div>
  )
}

// ── PROPERTY P&L ──────────────────────────────────────────────
function PropertyPL({ data, year, month }: { data: any; year: number; month: number }) {
  const { properties } = data
  const periodLabel = month ? `${MONTHS[month-1]} ${year}` : `${year} Annual`
  const totals = {
    rent:     properties.reduce((s: number, p: any) => s + parseFloat(p.rent_collected||0), 0),
    maint:    properties.reduce((s: number, p: any) => s + parseFloat(p.maint_cost||0), 0),
    platform: properties.reduce((s: number, p: any) => s + parseFloat(p.platform_fees||0), 0),
    net:      properties.reduce((s: number, p: any) => s + parseFloat(p.net_income||0), 0),
  }

  return (
    <div style={{ fontFamily:'Georgia, serif', maxWidth:900, margin:'0 auto', color:'#1a1a1a' }}>
      <div style={{ borderBottom:'3px solid #c9a227', paddingBottom:20, marginBottom:24 }}>
        <div style={{ display:'flex', justifyContent:'space-between' }}>
          <div>
            <div style={{ fontSize:22, fontWeight:800, color:'#c9a227', fontFamily:'system-ui' }}>⚡ GOLD ASSET MANAGEMENT</div>
            <div style={{ fontSize:11, color:'#666', marginTop:4, letterSpacing:'.06em', textTransform:'uppercase' }}>Per-Property Profit & Loss — {periodLabel}</div>
          </div>
          <div style={{ fontSize:11, color:'#999' }}>Generated {new Date().toLocaleDateString()}</div>
        </div>
      </div>

      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
        <thead>
          <tr style={{ background:'#f5f5f5', borderBottom:'2px solid #ddd' }}>
            <th style={{ textAlign:'left', padding:'10px 12px', fontWeight:700 }}>Property</th>
            <th style={{ textAlign:'right', padding:'10px 12px', fontWeight:700 }}>Units</th>
            <th style={{ textAlign:'right', padding:'10px 12px', fontWeight:700 }}>Occ%</th>
            <th style={{ textAlign:'right', padding:'10px 12px', fontWeight:700 }}>Rent Collected</th>
            <th style={{ textAlign:'right', padding:'10px 12px', fontWeight:700 }}>Platform Fees</th>
            <th style={{ textAlign:'right', padding:'10px 12px', fontWeight:700 }}>Maintenance</th>
            <th style={{ textAlign:'right', padding:'10px 12px', fontWeight:700 }}>Net Income</th>
          </tr>
        </thead>
        <tbody>
          {properties.map((p: any, i: number) => (
            <tr key={p.id} style={{ borderBottom:'1px solid #eee', background: i%2===0?'white':'#fafafa' }}>
              <td style={{ padding:'10px 12px' }}>
                <div style={{ fontWeight:600 }}>{p.name}</div>
                <div style={{ fontSize:10, color:'#999' }}>{p.street1}, {p.city}</div>
              </td>
              <td style={{ padding:'10px 12px', textAlign:'right' }}>{p.occupied_units}/{p.total_units}</td>
              <td style={{ padding:'10px 12px', textAlign:'right', color: p.occupancy_rate >= 80 ? '#166534' : '#92400e' }}>{p.occupancy_rate}%</td>
              <td style={{ padding:'10px 12px', textAlign:'right', fontFamily:'monospace', color:'#166534' }}>{formatCurrency(p.rent_collected)}</td>
              <td style={{ padding:'10px 12px', textAlign:'right', fontFamily:'monospace', color:'#991b1b' }}>({formatCurrency(p.platform_fees)})</td>
              <td style={{ padding:'10px 12px', textAlign:'right', fontFamily:'monospace', color:'#991b1b' }}>({formatCurrency(p.maint_cost)})</td>
              <td style={{ padding:'10px 12px', textAlign:'right', fontFamily:'monospace', fontWeight:700, color: parseFloat(p.net_income)>=0?'#166534':'#991b1b' }}>{formatCurrency(p.net_income)}</td>
            </tr>
          ))}
          <tr style={{ borderTop:'2px solid #c9a227', background:'#f9f7ee', fontWeight:700 }}>
            <td style={{ padding:'10px 12px' }}>TOTAL</td>
            <td style={{ padding:'10px 12px' }}></td>
            <td style={{ padding:'10px 12px' }}></td>
            <td style={{ padding:'10px 12px', textAlign:'right', fontFamily:'monospace', color:'#166534' }}>{formatCurrency(totals.rent)}</td>
            <td style={{ padding:'10px 12px', textAlign:'right', fontFamily:'monospace', color:'#991b1b' }}>({formatCurrency(totals.platform)})</td>
            <td style={{ padding:'10px 12px', textAlign:'right', fontFamily:'monospace', color:'#991b1b' }}>({formatCurrency(totals.maint)})</td>
            <td style={{ padding:'10px 12px', textAlign:'right', fontFamily:'monospace', fontSize:15, color: totals.net>=0?'#166534':'#991b1b' }}>{formatCurrency(totals.net)}</td>
          </tr>
        </tbody>
      </table>

      <div style={{ fontSize:10, color:'#999', textAlign:'center', borderTop:'1px solid #eee', paddingTop:12, marginTop:24 }}>
        Gold Asset Management LLC · Property P&L {periodLabel} · Confidential
      </div>
    </div>
  )
}

// ── PM CLIENT REPORT ──────────────────────────────────────────
function PMClientReport({ data, year, month }: { data: any; year: number; month: number }) {
  const { landlord, properties, summary } = data
  const monthName = MONTHS[month-1]
  return (
    <div style={{ fontFamily:'Georgia, serif', maxWidth:800, margin:'0 auto', color:'#1a1a1a' }}>
      <div style={{ borderBottom:'3px solid #c9a227', paddingBottom:20, marginBottom:24 }}>
        <div style={{ fontSize:22, fontWeight:800, color:'#c9a227', fontFamily:'system-ui' }}>⚡ GOLD ASSET MANAGEMENT</div>
        <div style={{ fontSize:11, color:'#666', marginTop:4, letterSpacing:'.06em', textTransform:'uppercase' }}>PM Client Report — {monthName} {year}</div>
        <div style={{ marginTop:12, display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }}>
          <div>
            <div style={{ fontSize:10, color:'#999', textTransform:'uppercase', marginBottom:3 }}>Property Owner</div>
            <div style={{ fontWeight:700 }}>{landlord.first_name} {landlord.last_name}</div>
          </div>
          <div>
            <div style={{ fontSize:10, color:'#999', textTransform:'uppercase', marginBottom:3 }}>Managed By</div>
            <div style={{ fontWeight:700 }}>{landlord.pm_name}</div>
            <div style={{ fontSize:11, color:'#666' }}>{landlord.plan_name} · {landlord.fee_type==='percent'?`${landlord.percent_rate}% of rent`:`$${landlord.flat_amount}/unit`}</div>
          </div>
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:24 }}>
        {[
          { label:'Units',           val: summary.totalUnits },
          { label:'Occupied',        val: `${summary.totalOccupied} (${summary.occupancyRate}%)` },
          { label:'Rent Collected',  val: formatCurrency(summary.totalCollected) },
          { label:'PM Fee',          val: formatCurrency(summary.pmFee) },
        ].map(s => (
          <div key={s.label} style={{ border:'1px solid #ddd', borderRadius:6, padding:'10px 12px', textAlign:'center' }}>
            <div style={{ fontSize:10, color:'#888', textTransform:'uppercase', marginBottom:4 }}>{s.label}</div>
            <div style={{ fontSize:16, fontWeight:700 }}>{s.val}</div>
          </div>
        ))}
      </div>

      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12, marginBottom:24 }}>
        <thead>
          <tr style={{ background:'#f5f5f5' }}>
            <th style={{ textAlign:'left', padding:'8px 10px', fontWeight:600 }}>Property</th>
            <th style={{ textAlign:'right', padding:'8px 10px', fontWeight:600 }}>Units</th>
            <th style={{ textAlign:'right', padding:'8px 10px', fontWeight:600 }}>Occupancy</th>
            <th style={{ textAlign:'right', padding:'8px 10px', fontWeight:600 }}>Rent Collected</th>
          </tr>
        </thead>
        <tbody>
          {properties.map((p: any, i: number) => (
            <tr key={p.id} style={{ borderBottom:'1px solid #eee', background:i%2===0?'white':'#fafafa' }}>
              <td style={{ padding:'7px 10px' }}><div style={{ fontWeight:600 }}>{p.name}</div><div style={{ fontSize:10, color:'#999' }}>{p.street1}, {p.city}</div></td>
              <td style={{ padding:'7px 10px', textAlign:'right' }}>{p.occupied}/{p.total_units}</td>
              <td style={{ padding:'7px 10px', textAlign:'right' }}>{parseInt(p.total_units)>0?Math.round((parseInt(p.occupied)/parseInt(p.total_units))*100):0}%</td>
              <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'monospace' }}>{formatCurrency(p.rent_collected)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ background:'#f9f7ee', border:'2px solid #c9a227', borderRadius:8, padding:16 }}>
        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6, fontSize:13 }}>
          <span>Total Rent Collected</span><span style={{ fontFamily:'monospace' }}>{formatCurrency(summary.totalCollected)}</span>
        </div>
        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6, fontSize:13 }}>
          <span>PM Management Fee</span><span style={{ fontFamily:'monospace', color:'#991b1b' }}>({formatCurrency(summary.pmFee)})</span>
        </div>
        <div style={{ borderTop:'2px solid #c9a227', paddingTop:8, display:'flex', justifyContent:'space-between', fontWeight:800, fontSize:15 }}>
          <span>Net to Owner</span><span style={{ fontFamily:'monospace', color:'#166534' }}>{formatCurrency(summary.netToOwner)}</span>
        </div>
      </div>
    </div>
  )
}

// ── WORK TRADE 1099 ───────────────────────────────────────────
function WorkTrade1099({ data, year }: { data: any; year: number }) {
  const { landlord, agreements, eligible, summary } = data
  return (
    <div style={{ fontFamily:'Georgia, serif', maxWidth:800, margin:'0 auto', color:'#1a1a1a' }}>
      <div style={{ borderBottom:'3px solid #c9a227', paddingBottom:20, marginBottom:24 }}>
        <div style={{ display:'flex', justifyContent:'space-between' }}>
          <div>
            <div style={{ fontSize:22, fontWeight:800, color:'#c9a227', fontFamily:'system-ui' }}>⚡ GOLD ASSET MANAGEMENT</div>
            <div style={{ fontSize:11, color:'#666', marginTop:4, letterSpacing:'.06em', textTransform:'uppercase' }}>Work Trade 1099-NEC Summary — Tax Year {year}</div>
          </div>
          <div style={{ textAlign:'right' }}>
            <div style={{ fontWeight:700 }}>{landlord.first_name} {landlord.last_name}</div>
            {landlord.ein && <div style={{ fontSize:12, color:'#666' }}>EIN: {landlord.ein}</div>}
          </div>
        </div>
      </div>

      {eligible.length > 0 ? (
        <div style={{ background:'#fef3c7', border:'2px solid #f59e0b', borderRadius:8, padding:14, marginBottom:20, fontSize:12 }}>
          <strong>⚠️ Action Required:</strong> {eligible.length} tenant(s) have received work trade compensation exceeding $600 and require a 1099-NEC form. Forms must be issued by January 31st of {year+1}.
        </div>
      ) : (
        <div style={{ background:'#dcfce7', border:'1px solid #22c55e', borderRadius:8, padding:12, marginBottom:20, fontSize:12, color:'#166534' }}>
          ✓ No tenants have reached the $600 1099-NEC threshold for {year}.
        </div>
      )}

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12, marginBottom:24 }}>
        {[
          { label:'Total Agreements',  val: summary.totalAgreements },
          { label:'1099-NEC Required', val: summary.eligible1099Count, color: summary.eligible1099Count > 0 ? '#991b1b' : '#166534' },
          { label:'Total Labor Value', val: formatCurrency(summary.totalValue) },
        ].map(s => (
          <div key={s.label} style={{ border:'1px solid #ddd', borderRadius:6, padding:'12px 14px', textAlign:'center' }}>
            <div style={{ fontSize:10, color:'#888', textTransform:'uppercase', marginBottom:4 }}>{s.label}</div>
            <div style={{ fontSize:18, fontWeight:700, color:(s as any).color||'inherit' }}>{s.val}</div>
          </div>
        ))}
      </div>

      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
        <thead>
          <tr style={{ background:'#f5f5f5' }}>
            <th style={{ textAlign:'left', padding:'8px 10px', fontWeight:600 }}>Tenant</th>
            <th style={{ textAlign:'left', padding:'8px 10px', fontWeight:600 }}>Unit</th>
            <th style={{ textAlign:'left', padding:'8px 10px', fontWeight:600 }}>Rate</th>
            <th style={{ textAlign:'right', padding:'8px 10px', fontWeight:600 }}>YTD Value</th>
            <th style={{ textAlign:'center', padding:'8px 10px', fontWeight:600 }}>1099 Required</th>
          </tr>
        </thead>
        <tbody>
          {agreements.map((a: any, i: number) => {
            const needs1099 = parseFloat(a.ytd_value||0) >= 600
            return (
              <tr key={a.id} style={{ borderBottom:'1px solid #eee', background: needs1099 ? '#fffbeb' : i%2===0?'white':'#fafafa' }}>
                <td style={{ padding:'8px 10px' }}>{a.tenant_first} {a.tenant_last}<div style={{ fontSize:10, color:'#999' }}>{a.tenant_email}</div></td>
                <td style={{ padding:'8px 10px', fontFamily:'monospace' }}>{a.unit_number} — {a.property_name}</td>
                <td style={{ padding:'8px 10px' }}>{formatCurrency(a.hourly_rate)}/hr · {a.weekly_hours}hrs/wk</td>
                <td style={{ padding:'8px 10px', textAlign:'right', fontFamily:'monospace', fontWeight: needs1099 ? 700 : 400 }}>{formatCurrency(a.ytd_value)}</td>
                <td style={{ padding:'8px 10px', textAlign:'center' }}>
                  {needs1099
                    ? <span style={{ background:'#fef3c7', color:'#92400e', padding:'2px 8px', borderRadius:10, fontSize:10, fontWeight:700 }}>YES</span>
                    : <span style={{ color:'#999', fontSize:10 }}>No</span>
                  }
                </td>
              </tr>
            )
          })}
          {agreements.length === 0 && <tr><td colSpan={5} style={{ padding:24, textAlign:'center', color:'#999' }}>No work trade agreements for {year}</td></tr>}
        </tbody>
      </table>

      <div style={{ fontSize:10, color:'#999', textAlign:'center', borderTop:'1px solid #eee', paddingTop:12, marginTop:24 }}>
        Gold Asset Management LLC · Work Trade 1099 Summary {year} · Not tax advice — consult a qualified tax professional
      </div>
    </div>
  )
}
