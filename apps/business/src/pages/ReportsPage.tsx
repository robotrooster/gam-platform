import { useEffect, useMemo, useState } from 'react'
import { apiGet } from '../lib/api'
import {
  TrendingUp, TrendingDown, Users, ShoppingCart, Package,
  Wrench, FileText,
} from 'lucide-react'

type RangeKey = '30d' | '90d' | '365d'

interface DailyRow {
  day: string
  posRevenue: string
  invoiced: string
  collected: string
}

interface Revenue {
  range: RangeKey
  days: number
  dailySeries: DailyRow[]
  periodTotals:      { pos: string; invoiced: string; collected: string }
  priorPeriodTotals: { pos: string; invoiced: string; collected: string }
}

interface TopCustomer {
  id: string
  firstName: string | null; lastName: string | null
  companyName: string | null
  email: string | null
  totalRevenue: string
  posCount: number
  invoiceCount: number
  lastActivity: string | null
}

interface TopPosItem {
  itemId: string
  nameSnapshot: string
  skuSnapshot: string | null
  unitsSold: number
  revenue: string
  saleCount: number
}

interface PosSection {
  topItems: TopPosItem[]
  totalSales: string
  saleCount: number
  refundCount: number
  refundAmount: string
}

interface LowStockItem {
  id: string; name: string; sku: string | null;
  stockQty: number; stockMin: number;
  sellPrice: string; costPrice: string;
}

interface InventorySection {
  lowStock: LowStockItem[]
  activeItems: number
  totalUnits: number
  stockValueAtCost: string
  shrinkageUnits: number
  shrinkageValue: string
}

interface WorkOrdersSection {
  totalCount: number
  completedCount: number
  cancelledCount: number
  avgCompletionHours: string | null
  totalBilled: string
  totalLaborBilled: string
  totalPartsBilled: string
  topComplaints: Array<{ complaintKey: string; occurrences: number }>
}

interface QuotesSection {
  totalCount: number
  sentCount: number
  acceptedCount: number
  declinedCount: number
  expiredCount: number
  avgValue: string | null
  acceptedValue: string
  acceptanceRate: number | null
}

interface Overview {
  range: RangeKey
  days: number
  enabledFeatures: string[]
  revenue: Revenue
  topCustomers: TopCustomer[]
  pos: PosSection | null
  inventory: InventorySection | null
  workOrders: WorkOrdersSection | null
  quotes: QuotesSection | null
}

function fmtMoney(n: string | number | null | undefined): string {
  if (n == null) return '$0.00'
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtMoneyShort(n: string | number | null | undefined): string {
  if (n == null) return '$0'
  const num = Number(n)
  if (Math.abs(num) >= 100_000) return `$${(num / 1000).toFixed(1)}k`
  if (Math.abs(num) >= 10_000)  return `$${(num / 1000).toFixed(1)}k`
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  return new Date(s).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function customerLabel(c: Pick<TopCustomer, 'companyName' | 'firstName' | 'lastName'>): string {
  if (c.companyName) return c.companyName
  return `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'Unnamed'
}

function pctDelta(cur: number, prior: number): { pct: number | null; up: boolean } {
  if (prior === 0 && cur === 0) return { pct: 0, up: true }
  if (prior === 0) return { pct: null, up: cur > 0 }   // can't divide
  const pct = (cur - prior) / prior
  return { pct, up: pct >= 0 }
}

// ─────────────────────────────────────────────────────────────────
//  Page
// ─────────────────────────────────────────────────────────────────

type TabKey = 'revenue' | 'customers' | 'pos' | 'inventory' | 'work_orders' | 'quotes'

export function ReportsPage() {
  const [range, setRange] = useState<RangeKey>('30d')
  const [data, setData] = useState<Overview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>('revenue')

  const reload = async () => {
    setErr(null); setData(null)
    try {
      const d = await apiGet<Overview>(`/business-reports/overview?range=${range}`)
      setData(d)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load reports')
    }
  }
  useEffect(() => { reload() }, [range])

  // Auto-redirect away from a tab whose feature is off when range changes.
  useEffect(() => {
    if (!data) return
    if (tab === 'pos'        && !data.pos) setTab('revenue')
    if (tab === 'inventory'  && !data.inventory) setTab('revenue')
    if (tab === 'work_orders'&& !data.workOrders) setTab('revenue')
    if (tab === 'quotes'     && !data.quotes) setTab('revenue')
  }, [data, tab])

  const tabs: Array<{ key: TabKey; label: string; icon: any; gated?: boolean }> = useMemo(() => [
    { key: 'revenue',     label: 'Revenue',     icon: TrendingUp },
    { key: 'customers',   label: 'Customers',   icon: Users },
    { key: 'pos',         label: 'POS',         icon: ShoppingCart,  gated: data ? !data.pos        : false },
    { key: 'inventory',   label: 'Inventory',   icon: Package,       gated: data ? !data.inventory  : false },
    { key: 'work_orders', label: 'Work orders', icon: Wrench,        gated: data ? !data.workOrders : false },
    { key: 'quotes',      label: 'Quotes',      icon: FileText,      gated: data ? !data.quotes     : false },
  ], [data])

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, margin: 0 }}>
            Reports
          </h1>
          <div style={{ color: 'var(--text-2)', fontSize: 14, marginTop: 4 }}>
            Trends + totals across your business. Range affects every section.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--bg-2)', borderRadius: 10 }}>
          {(['30d', '90d', '365d'] as const).map(r => (
            <button key={r}
              onClick={() => setRange(r)}
              style={range === r ? pillActive : pill}>
              {r === '30d' ? '30 days' : r === '90d' ? '90 days' : '12 months'}
            </button>
          ))}
        </div>
      </div>

      {err && <div style={errStyle}>{err}</div>}

      {/* Tab nav */}
      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border-0)', marginBottom: 24 }}>
        {tabs.map(t => {
          const Icon = t.icon
          if (t.gated) return null
          return (
            <button key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: '12px 18px',
                background: 'transparent',
                color: tab === t.key ? 'var(--gold)' : 'var(--text-2)',
                border: 'none',
                borderBottom: `2px solid ${tab === t.key ? 'var(--gold)' : 'transparent'}`,
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
                display: 'inline-flex' as const, alignItems: 'center', gap: 8,
                marginBottom: -1,
              }}>
              <Icon size={13} />
              {t.label}
            </button>
          )
        })}
      </div>

      {!data ? (
        <div style={{ color: 'var(--text-2)' }}>Loading…</div>
      ) : (
        <>
          {tab === 'revenue'     && <RevenueTab     d={data.revenue} />}
          {tab === 'customers'   && <CustomersTab   rows={data.topCustomers} />}
          {tab === 'pos'         && data.pos        && <PosTab       d={data.pos} />}
          {tab === 'inventory'   && data.inventory  && <InventoryTab d={data.inventory} />}
          {tab === 'work_orders' && data.workOrders && <WorkOrdersTab d={data.workOrders} />}
          {tab === 'quotes'      && data.quotes     && <QuotesTab    d={data.quotes} />}
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Revenue tab
// ─────────────────────────────────────────────────────────────────

function RevenueTab({ d }: { d: Revenue }) {
  const curTotal = Number(d.periodTotals.pos) + Number(d.periodTotals.invoiced)
  const prvTotal = Number(d.priorPeriodTotals.pos) + Number(d.priorPeriodTotals.invoiced)
  const delta = pctDelta(curTotal, prvTotal)
  const posDelta       = pctDelta(Number(d.periodTotals.pos),       Number(d.priorPeriodTotals.pos))
  const invoicedDelta  = pctDelta(Number(d.periodTotals.invoiced),  Number(d.priorPeriodTotals.invoiced))
  const collectedDelta = pctDelta(Number(d.periodTotals.collected), Number(d.priorPeriodTotals.collected))

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
        <BigStat label="Gross revenue"   value={fmtMoney(curTotal)}            delta={delta} accent />
        <BigStat label="POS"             value={fmtMoney(d.periodTotals.pos)}      delta={posDelta} />
        <BigStat label="Invoiced"        value={fmtMoney(d.periodTotals.invoiced)} delta={invoicedDelta} />
        <BigStat label="Collected"       value={fmtMoney(d.periodTotals.collected)} delta={collectedDelta} />
      </div>

      {/* Daily series chart */}
      <div style={cardStyle}>
        <div style={{
          display: 'flex' as const, justifyContent: 'space-between', alignItems: 'baseline',
          marginBottom: 12,
        }}>
          <h2 style={h2Style}>Daily revenue</h2>
          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-3)' }}>
            <LegendDot color="var(--gold)"  label="POS + Invoiced" />
            <LegendDot color="var(--green, #22c55e)" label="Collected" />
          </div>
        </div>
        <RevenueChart series={d.dailySeries} />
      </div>
    </div>
  )
}

function RevenueChart({ series }: { series: DailyRow[] }) {
  const [hovered, setHovered] = useState<number | null>(null)

  const width = 720, height = 240, pad = 30
  if (series.length === 0) return <div style={emptyStyle}>No data in this range.</div>

  const max = Math.max(
    1,
    ...series.map(s => Number(s.posRevenue) + Number(s.invoiced)),
    ...series.map(s => Number(s.collected)))
  const xStep = (width - pad * 2) / Math.max(1, series.length - 1)

  const pathGross = series.map((s, i) => {
    const x = pad + i * xStep
    const y = height - pad - ((Number(s.posRevenue) + Number(s.invoiced)) / max) * (height - pad * 2)
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')
  const pathCollected = series.map((s, i) => {
    const x = pad + i * xStep
    const y = height - pad - (Number(s.collected) / max) * (height - pad * 2)
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 240 }}>
        {/* Gridlines */}
        {[0.25, 0.5, 0.75].map(p => (
          <line key={p}
            x1={pad} x2={width - pad}
            y1={pad + (height - pad * 2) * p}
            y2={pad + (height - pad * 2) * p}
            stroke="var(--border-0)" strokeWidth="1" strokeDasharray="2 4" />
        ))}
        {/* Axis labels */}
        <text x={pad - 4} y={pad + 4} textAnchor="end"
          style={{ fontSize: 10, fill: 'var(--text-3)' }}>
          {fmtMoneyShort(max)}
        </text>
        <text x={pad - 4} y={height - pad + 4} textAnchor="end"
          style={{ fontSize: 10, fill: 'var(--text-3)' }}>
          $0
        </text>
        {/* X labels: first / mid / last */}
        {[0, Math.floor(series.length / 2), series.length - 1].map(i => (
          <text key={i}
            x={pad + i * xStep} y={height - 8} textAnchor="middle"
            style={{ fontSize: 10, fill: 'var(--text-3)' }}>
            {fmtDate(series[i]!.day)}
          </text>
        ))}
        {/* Lines */}
        <path d={pathGross}     fill="none" stroke="var(--gold)" strokeWidth="2" />
        <path d={pathCollected} fill="none" stroke="var(--green, #22c55e)" strokeWidth="2" strokeDasharray="3 3" />
        {/* Hover hit area */}
        {series.map((_, i) => (
          <rect key={i}
            x={pad + i * xStep - xStep / 2}
            y={pad}
            width={xStep}
            height={height - pad * 2}
            fill="transparent"
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)} />
        ))}
        {hovered !== null && (
          <>
            <line
              x1={pad + hovered * xStep} x2={pad + hovered * xStep}
              y1={pad} y2={height - pad}
              stroke="var(--gold)" strokeWidth="1" strokeDasharray="2 2" opacity="0.5" />
            <circle
              cx={pad + hovered * xStep}
              cy={height - pad - ((Number(series[hovered]!.posRevenue) + Number(series[hovered]!.invoiced)) / max) * (height - pad * 2)}
              r="4" fill="var(--gold)" />
            <circle
              cx={pad + hovered * xStep}
              cy={height - pad - (Number(series[hovered]!.collected) / max) * (height - pad * 2)}
              r="4" fill="var(--green, #22c55e)" />
          </>
        )}
      </svg>
      {hovered !== null && (
        <div style={{
          position: 'absolute' as const,
          left:   `${((pad + hovered * xStep) / width) * 100}%`,
          top:    -8,
          transform: 'translateX(-50%) translateY(-100%)',
          background: 'var(--bg-1)',
          border: '1px solid var(--border-1)',
          borderRadius: 8,
          padding: '8px 12px',
          fontSize: 12,
          color: 'var(--text-1)',
          pointerEvents: 'none' as const,
          whiteSpace: 'nowrap' as const,
        }}>
          <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>
            {fmtDate(series[hovered]!.day)}
          </div>
          <div>POS: {fmtMoney(series[hovered]!.posRevenue)}</div>
          <div>Invoiced: {fmtMoney(series[hovered]!.invoiced)}</div>
          <div style={{ color: 'var(--green, #22c55e)' }}>Collected: {fmtMoney(series[hovered]!.collected)}</div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Customers tab
// ─────────────────────────────────────────────────────────────────

function CustomersTab({ rows }: { rows: TopCustomer[] }) {
  if (rows.length === 0) return <div style={emptyStyle}>No customer revenue in this range.</div>
  return (
    <div style={cardStyle}>
      <h2 style={h2Style}>Top customers</h2>
      <table style={tableStyle}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
            <th style={thStyle}>Customer</th>
            <th style={thStyle}>Email</th>
            <th style={thStyle}>POS</th>
            <th style={thStyle}>Invoices</th>
            <th style={thStyle}>Last activity</th>
            <th style={thStyle}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(c => (
            <tr key={c.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
              <td style={tdStyle}><strong style={{ color: 'var(--text-0)' }}>{customerLabel(c)}</strong></td>
              <td style={{ ...tdStyle, fontSize: 12, color: 'var(--text-3)' }}>{c.email || '—'}</td>
              <td style={tdStyle}>{c.posCount}</td>
              <td style={tdStyle}>{c.invoiceCount}</td>
              <td style={{ ...tdStyle, fontSize: 12 }}>{fmtDate(c.lastActivity)}</td>
              <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, fontWeight: 600, color: 'var(--gold)' }}>
                {fmtMoney(c.totalRevenue)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  POS tab
// ─────────────────────────────────────────────────────────────────

function PosTab({ d }: { d: PosSection }) {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
        <BigStat label="Total sales"   value={fmtMoney(d.totalSales)}   accent />
        <BigStat label="Sale count"    value={String(d.saleCount)} />
        <BigStat label="Refunds"       value={fmtMoney(d.refundAmount)} subtle={d.refundAmount === '0'} />
        <BigStat label="Refund count"  value={String(d.refundCount)} subtle={d.refundCount === 0} />
      </div>

      <div style={cardStyle}>
        <h2 style={h2Style}>Top-selling items</h2>
        {d.topItems.length === 0 ? (
          <div style={emptyStyle}>No item sales in this range.</div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
                <th style={thStyle}>Item</th>
                <th style={thStyle}>SKU</th>
                <th style={thStyle}>Units</th>
                <th style={thStyle}>Sales</th>
                <th style={thStyle}>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {d.topItems.map(it => (
                <tr key={it.itemId} style={{ borderBottom: '1px solid var(--border-0)' }}>
                  <td style={tdStyle}><strong style={{ color: 'var(--text-0)' }}>{it.nameSnapshot}</strong></td>
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, fontSize: 12, color: 'var(--text-3)' }}>
                    {it.skuSnapshot || '—'}
                  </td>
                  <td style={tdStyle}>{it.unitsSold}</td>
                  <td style={tdStyle}>{it.saleCount}</td>
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, fontWeight: 600 }}>
                    {fmtMoney(it.revenue)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Inventory tab
// ─────────────────────────────────────────────────────────────────

function InventoryTab({ d }: { d: InventorySection }) {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
        <BigStat label="Active items"       value={String(d.activeItems)} />
        <BigStat label="Units on hand"      value={d.totalUnits.toLocaleString()} />
        <BigStat label="Stock value (cost)" value={fmtMoney(d.stockValueAtCost)} accent />
        <BigStat label="Shrinkage value"
          value={fmtMoney(d.shrinkageValue)}
          subtle={Number(d.shrinkageValue) === 0}
          warn={Number(d.shrinkageValue) > 0} />
      </div>

      <div style={cardStyle}>
        <h2 style={h2Style}>Low stock ({d.lowStock.length})</h2>
        {d.lowStock.length === 0 ? (
          <div style={emptyStyle}>All items above reorder point.</div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
                <th style={thStyle}>Item</th>
                <th style={thStyle}>SKU</th>
                <th style={thStyle}>On hand</th>
                <th style={thStyle}>Min</th>
                <th style={thStyle}>Cost</th>
                <th style={thStyle}>Sell</th>
              </tr>
            </thead>
            <tbody>
              {d.lowStock.map(it => (
                <tr key={it.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                  <td style={tdStyle}><strong style={{ color: 'var(--text-0)' }}>{it.name}</strong></td>
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, fontSize: 12, color: 'var(--text-3)' }}>
                    {it.sku || '—'}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, color: 'var(--amber)', fontWeight: 600 }}>
                    {it.stockQty}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, color: 'var(--text-3)' }}>{it.stockMin}</td>
                  <td style={tdStyle}>{fmtMoney(it.costPrice)}</td>
                  <td style={tdStyle}>{fmtMoney(it.sellPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Work orders tab
// ─────────────────────────────────────────────────────────────────

function WorkOrdersTab({ d }: { d: WorkOrdersSection }) {
  const avgHours = d.avgCompletionHours ? Number(d.avgCompletionHours).toFixed(1) : null
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
        <BigStat label="Work orders"    value={String(d.totalCount)} />
        <BigStat label="Completed"      value={String(d.completedCount)} />
        <BigStat label="Total billed"   value={fmtMoney(d.totalBilled)} accent />
        <BigStat label="Avg completion" value={avgHours ? `${avgHours} hrs` : '—'} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={cardStyle}>
          <h2 style={h2Style}>Billed breakdown</h2>
          <Row label="Labor billed"  value={fmtMoney(d.totalLaborBilled)} />
          <Row label="Parts billed"  value={fmtMoney(d.totalPartsBilled)} />
          <Row label="Total billed"  value={fmtMoney(d.totalBilled)} big />
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-3)' }}>
            Cancelled: {d.cancelledCount} WO{d.cancelledCount === 1 ? '' : 's'}
          </div>
        </div>
        <div style={cardStyle}>
          <h2 style={h2Style}>Top complaints</h2>
          {d.topComplaints.length === 0 ? (
            <div style={emptyStyle}>No complaints recorded.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
              {d.topComplaints.map(c => (
                <div key={c.complaintKey} style={{
                  display: 'flex' as const, justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 10px', background: 'var(--bg-2)', borderRadius: 6,
                  fontSize: 13, color: 'var(--text-1)',
                }}>
                  <span>{c.complaintKey || '(blank)'}</span>
                  <span style={{ color: 'var(--gold)', fontWeight: 600, fontFamily: 'var(--font-mono)' as const }}>
                    {c.occurrences}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Quotes tab
// ─────────────────────────────────────────────────────────────────

function QuotesTab({ d }: { d: QuotesSection }) {
  const ratePct = d.acceptanceRate !== null
    ? `${(d.acceptanceRate * 100).toFixed(0)}%`
    : '—'
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
        <BigStat label="Quotes sent"      value={String(d.sentCount + d.acceptedCount + d.declinedCount + d.expiredCount)} />
        <BigStat label="Acceptance rate"  value={ratePct} accent />
        <BigStat label="Avg quote value"  value={fmtMoney(d.avgValue)} />
        <BigStat label="Accepted value"   value={fmtMoney(d.acceptedValue)} />
      </div>

      <div style={cardStyle}>
        <h2 style={h2Style}>Status breakdown</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <StatusPill label="Sent (pending)" count={d.sentCount}     color="var(--gold)" />
          <StatusPill label="Accepted"       count={d.acceptedCount} color="var(--green, #22c55e)" />
          <StatusPill label="Declined"       count={d.declinedCount} color="var(--red, #ef4444)" />
          <StatusPill label="Expired"        count={d.expiredCount}  color="var(--text-3)" />
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-3)' }}>
          Acceptance rate = accepted ÷ (accepted + declined). Pending and expired quotes are excluded.
        </div>
      </div>
    </div>
  )
}

function StatusPill({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div style={{
      padding: 14, background: 'var(--bg-2)', borderRadius: 8,
      borderLeft: `3px solid ${color}`,
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: 1, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-display)' as const, fontSize: 22, fontWeight: 700, color }}>{count}</div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Building blocks
// ─────────────────────────────────────────────────────────────────

function BigStat({
  label, value, delta, accent, subtle, warn,
}: {
  label: string
  value: string
  delta?: { pct: number | null; up: boolean }
  accent?: boolean
  subtle?: boolean
  warn?: boolean
}) {
  const color = warn ? 'var(--amber)'
              : accent ? 'var(--gold)'
              : subtle ? 'var(--text-3)'
              : 'var(--text-0)'
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: 1, marginBottom: 8 }}>
        {label}
      </div>
      <div style={{
        fontFamily: 'var(--font-display)' as const,
        fontSize: 24, fontWeight: 700, color,
      }}>
        {value}
      </div>
      {delta && delta.pct !== null && (
        <div style={{
          marginTop: 6, fontSize: 11,
          color: delta.up ? 'var(--green, #22c55e)' : 'var(--red, #ef4444)',
          display: 'flex' as const, alignItems: 'center', gap: 4,
        }}>
          {delta.up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
          {(delta.pct >= 0 ? '+' : '') + (delta.pct * 100).toFixed(0)}%
          <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>vs prior</span>
        </div>
      )}
      {delta && delta.pct === null && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-3)' }}>
          No prior data
        </div>
      )}
    </div>
  )
}

function Row({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div style={{
      display: 'flex' as const, justifyContent: 'space-between',
      padding: '4px 0',
      fontSize: big ? 18 : 13,
      fontWeight: big ? 700 : 500,
      color: big ? 'var(--gold)' : 'var(--text-1)',
    }}>
      <span>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)' as const }}>{value}</span>
    </div>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'inline-flex' as const, alignItems: 'center', gap: 5 }}>
      <span style={{ width: 8, height: 8, background: color, borderRadius: '50%' }} />
      {label}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Styles
// ─────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  padding: 20,
  background: 'var(--bg-1)',
  border: '1px solid var(--border-0)',
  borderRadius: 12,
}
const h2Style: React.CSSProperties = {
  fontSize: 14, color: 'var(--text-2)',
  textTransform: 'uppercase' as const, letterSpacing: 1,
  margin: '0 0 12px 0', fontWeight: 600,
}
const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse' as const,
}
const thStyle: React.CSSProperties = {
  textAlign: 'left' as const, padding: '10px 8px',
  fontSize: 11, color: 'var(--text-3)',
  textTransform: 'uppercase' as const, letterSpacing: 1, fontWeight: 600,
}
const tdStyle: React.CSSProperties = {
  padding: '12px 8px', fontSize: 14, color: 'var(--text-1)',
}
const pill: React.CSSProperties = {
  padding: '6px 12px',
  background: 'transparent', color: 'var(--text-2)',
  border: 'none', borderRadius: 6,
  fontSize: 12, fontWeight: 600, cursor: 'pointer',
}
const pillActive: React.CSSProperties = {
  ...pill, background: 'var(--bg-1)', color: 'var(--gold)',
}
const errStyle: React.CSSProperties = {
  marginBottom: 16, padding: '10px 12px',
  background: 'var(--red-bg)', color: 'var(--red, #ef4444)',
  border: '1px solid var(--red-dim, #ef4444)', borderRadius: 8,
  fontSize: 13,
}
const emptyStyle: React.CSSProperties = {
  padding: 24, textAlign: 'center' as const,
  fontSize: 13, color: 'var(--text-3)',
  background: 'var(--bg-2)', borderRadius: 8,
}
