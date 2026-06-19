import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiGet } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { OnboardingWizard } from '../components/OnboardingWizard'
import {
  DollarSign, AlertTriangle, Calendar, Wrench, Package,
  CreditCard, ArrowRight, Car, ChevronRight,
} from 'lucide-react'

interface AgingBucket { count: number; amount: string }
interface ArAging {
  current: AgingBucket
  d1_30:   AgingBucket
  d31_60:  AgingBucket
  d61_90:  AgingBucket
  over90:  AgingBucket
}

interface AppointmentRow {
  id: string
  serviceType: string
  scheduledFor: string
  durationMinutes: number
  customerFirstName: string | null
  customerLastName: string | null
  customerCompanyName: string | null
}

interface WorkOrderRow {
  id: string
  woNumber: string
  status: 'open' | 'in_progress' | 'awaiting_parts'
  complaint: string | null
  totalAmount: string
  createdAt: string
  customerFirstName: string | null
  customerLastName: string | null
  customerCompanyName: string | null
  vehicleYear: number | null
  vehicleMake: string | null
  vehicleModel: string | null
}

interface InventoryRow {
  id: string
  name: string
  sku: string | null
  stockQty: number
  stockMin: number
  sellPrice: string
}

interface Overview {
  revenue: {
    todayPos: string
    todayPosCount: number
    monthInvoiced: string
    monthCollected: string
  }
  arAging: ArAging | null
  todayAppointments: AppointmentRow[] | null
  openWorkOrders: WorkOrderRow[] | null
  openWorkOrderStats: { open: number; inProgress: number; awaitingParts: number } | null
  lowStock: InventoryRow[] | null
  lowStockCount: number
  banking: {
    hasConnectAccount: boolean
    payoutsEnabled: boolean
    detailsSubmitted: boolean
  }
  enabledFeatures: string[]
}

function fmtMoney(n: string | number | null | undefined): string {
  if (n == null) return '$0.00'
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtTime(s: string): string {
  return new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function customerLabel(r: {
  customerFirstName: string | null;
  customerLastName: string | null;
  customerCompanyName: string | null;
}): string {
  if (r.customerCompanyName) return r.customerCompanyName
  return `${r.customerFirstName ?? ''} ${r.customerLastName ?? ''}`.trim() || 'Unnamed'
}

export function DashboardPage() {
  const { user, business } = useAuth()
  const [data, setData] = useState<Overview | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (user?.role !== 'business_owner') return
    apiGet<Overview>('/business-dashboard/overview')
      .then(setData)
      .catch(e => setErr(e?.response?.data?.error || 'Failed to load dashboard'))
  }, [user])

  if (user?.role === 'business_staff') {
    return (
      <div>
        <h1 style={hdr}>{business?.name ?? 'Dashboard'}</h1>
        <div style={{ color: 'var(--text-2)', fontSize: 14 }}>
          Welcome back, {user?.firstName}.
        </div>
        <div style={{ ...cardStyle, marginTop: 24 }}>
          Staff dashboard tiles are coming. Use the side nav to access the features you have permission for.
        </div>
      </div>
    )
  }

  return (
    <div>
      <h1 style={hdr}>{business?.name ?? 'Dashboard'}</h1>
      <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 24 }}>
        Welcome back, {user?.firstName}.
      </div>

      {/* S515: post-signup activation checklist (self-hides when done) */}
      <OnboardingWizard />

      {err && <div style={errStyle}>{err}</div>}

      {!data ? (
        <div style={{ color: 'var(--text-2)' }}>Loading…</div>
      ) : (
        <>
          {/* Banking warning at top if not ready */}
          {!data.banking.payoutsEnabled && (
            <Link to="/settings" style={{
              display: 'flex' as const, gap: 12, alignItems: 'center',
              padding: 14, marginBottom: 16,
              background: 'rgba(245,158,11,.08)',
              border: '1px solid rgba(245,158,11,.4)',
              borderRadius: 10,
              fontSize: 13, color: 'var(--text-1)',
              textDecoration: 'none' as const,
            }}>
              <CreditCard size={18} color="var(--amber)" />
              <div style={{ flex: 1 }}>
                <strong>Finish banking setup</strong>
                <div style={{ color: 'var(--text-2)', marginTop: 2, fontSize: 12 }}>
                  {data.banking.hasConnectAccount
                    ? 'Your Stripe account is started but payouts aren\'t enabled yet — invoice pay links won\'t work until this is done.'
                    : 'Connect a Stripe account so customers can pay invoices online.'}
                </div>
              </div>
              <ArrowRight size={14} color="var(--amber)" />
            </Link>
          )}

          {/* Revenue row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
            <RevenueTile
              icon={<DollarSign size={16} />}
              label="POS today"
              value={fmtMoney(data.revenue.todayPos)}
              hint={`${data.revenue.todayPosCount} sale${data.revenue.todayPosCount === 1 ? '' : 's'}`}
              hidden={!data.enabledFeatures.includes('pos')} />
            <RevenueTile
              icon={<DollarSign size={16} />}
              label="Invoiced this month"
              value={fmtMoney(data.revenue.monthInvoiced)}
              hidden={!data.enabledFeatures.includes('invoicing')} />
            <RevenueTile
              icon={<DollarSign size={16} />}
              label="Collected this month"
              value={fmtMoney(data.revenue.monthCollected)}
              accent
              hidden={!data.enabledFeatures.includes('invoicing')} />
          </div>

          {/* Two-column tile grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {data.todayAppointments !== null && (
              <TodayAppointmentsTile rows={data.todayAppointments} />
            )}
            {data.openWorkOrders !== null && data.openWorkOrderStats && (
              <OpenWorkOrdersTile rows={data.openWorkOrders} stats={data.openWorkOrderStats} />
            )}
            {data.arAging && (
              <ArAgingTile aging={data.arAging} />
            )}
            {data.lowStock !== null && (
              <LowStockTile rows={data.lowStock} totalCount={data.lowStockCount} />
            )}
          </div>
        </>
      )}
    </div>
  )
}

function RevenueTile({
  icon, label, value, hint, accent, hidden,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
  accent?: boolean
  hidden?: boolean
}) {
  if (hidden) {
    return (
      <div style={{ ...cardStyle, opacity: 0.4, fontSize: 12, color: 'var(--text-3)' }}>
        {label} — feature off
      </div>
    )
  }
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: 1, marginBottom: 8 }}>
        {icon} {label}
      </div>
      <div style={{
        fontFamily: 'var(--font-display)', fontSize: 28,
        color: accent ? 'var(--gold)' : 'var(--text-0)',
        fontWeight: 700,
      }}>
        {value}
      </div>
      {hint && <div style={{ color: 'var(--text-3)', fontSize: 11, marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

function TodayAppointmentsTile({ rows }: { rows: AppointmentRow[] }) {
  return (
    <div style={cardStyle}>
      <TileHeader icon={<Calendar size={14} />} label="Today's appointments" link="/appointments" />
      {rows.length === 0 ? (
        <div style={emptyTile}>No appointments scheduled for today.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
          {rows.map(a => (
            <Link key={a.id} to="/appointments" style={rowLink}>
              <div style={{ fontFamily: 'var(--font-mono)' as const, fontSize: 12, color: 'var(--gold)', minWidth: 50 }}>
                {fmtTime(a.scheduledFor)}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: 'var(--text-0)' }}>
                  {customerLabel(a)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                  {a.serviceType} · {a.durationMinutes}min
                </div>
              </div>
              <ChevronRight size={12} color="var(--text-3)" />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function OpenWorkOrdersTile({
  rows, stats,
}: { rows: WorkOrderRow[]; stats: { open: number; inProgress: number; awaitingParts: number } }) {
  return (
    <div style={cardStyle}>
      <TileHeader icon={<Wrench size={14} />} label="Open work orders" link="/work-orders" />
      {/* Status breakdown */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, fontSize: 11 }}>
        <Stat n={stats.open}           label="Open" />
        <Stat n={stats.inProgress}     label="In progress" />
        <Stat n={stats.awaitingParts}  label="Awaiting parts" accent={stats.awaitingParts > 0 ? 'amber' : undefined} />
      </div>
      {rows.length === 0 ? (
        <div style={emptyTile}>No active work orders.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
          {rows.map(w => {
            const ymm = [w.vehicleYear, w.vehicleMake, w.vehicleModel].filter(Boolean).join(' ')
            return (
              <Link key={w.id} to="/work-orders" style={rowLink}>
                <div style={{ fontFamily: 'var(--font-mono)' as const, fontSize: 11, color: 'var(--gold)', minWidth: 80 }}>
                  {w.woNumber}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-0)' }}>
                    {customerLabel(w)}
                  </div>
                  {ymm && (
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                      <Car size={9} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                      {ymm}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)' as const, color: 'var(--text-2)' }}>
                  {fmtMoney(w.totalAmount)}
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ArAgingTile({ aging }: { aging: ArAging }) {
  const buckets: Array<[string, AgingBucket, string]> = [
    ['Current',  aging.current, 'var(--text-1)'],
    ['1–30d',    aging.d1_30,   'var(--text-1)'],
    ['31–60d',   aging.d31_60,  'var(--amber)'],
    ['61–90d',   aging.d61_90,  'var(--amber)'],
    ['90d+',     aging.over90,  'var(--red, #ef4444)'],
  ]
  const total = buckets.reduce((s, [, b]) => s + Number(b.amount), 0)
  return (
    <div style={cardStyle}>
      <TileHeader icon={<DollarSign size={14} />} label="Open invoices" link="/invoices" />
      <div style={{
        fontFamily: 'var(--font-display)', fontSize: 22,
        color: 'var(--gold)', fontWeight: 700, marginBottom: 12,
      }}>
        {fmtMoney(total)} outstanding
      </div>
      {total === 0 ? (
        <div style={emptyTile}>No outstanding invoices.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
          {buckets.filter(([, b]) => b.count > 0).map(([label, b, color]) => (
            <div key={label} style={{
              display: 'flex' as const, justifyContent: 'space-between',
              padding: '6px 0', fontSize: 12,
              borderBottom: '1px solid var(--border-0)',
            }}>
              <span style={{ color, fontWeight: 600 }}>
                {label}
                <span style={{ marginLeft: 8, color: 'var(--text-3)', fontWeight: 400, fontSize: 11 }}>
                  {b.count} invoice{b.count === 1 ? '' : 's'}
                </span>
              </span>
              <span style={{ fontFamily: 'var(--font-mono)' as const, color: 'var(--text-1)' }}>
                {fmtMoney(b.amount)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function LowStockTile({ rows, totalCount }: { rows: InventoryRow[]; totalCount: number }) {
  return (
    <div style={cardStyle}>
      <TileHeader icon={<Package size={14} />} label="Low stock" link="/inventory" />
      {totalCount === 0 ? (
        <div style={emptyTile}>All inventory items above reorder point.</div>
      ) : (
        <>
          <div style={{
            display: 'flex' as const, gap: 6, alignItems: 'center',
            color: 'var(--amber)', fontSize: 13, marginBottom: 12,
          }}>
            <AlertTriangle size={12} />
            {totalCount} item{totalCount === 1 ? '' : 's'} at or below reorder point
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
            {rows.map(it => (
              <Link key={it.id} to="/inventory" style={rowLink}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-0)' }}>{it.name}</div>
                  {it.sku && (
                    <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' as const, marginTop: 2 }}>
                      {it.sku}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)' as const, fontWeight: 600, color: 'var(--amber)', minWidth: 60, textAlign: 'right' as const }}>
                  {it.stockQty} / {it.stockMin}
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function TileHeader({
  icon, label, link,
}: { icon: React.ReactNode; label: string; link: string }) {
  return (
    <div style={{
      display: 'flex' as const, justifyContent: 'space-between', alignItems: 'center',
      marginBottom: 12,
    }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--text-2)', fontSize: 12, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: 1 }}>
        {icon} {label}
      </div>
      <Link to={link} style={{
        fontSize: 11, color: 'var(--gold)', textDecoration: 'none' as const,
        display: 'inline-flex' as const, alignItems: 'center', gap: 4,
      }}>
        Open <ArrowRight size={10} />
      </Link>
    </div>
  )
}

function Stat({ n, label, accent }: { n: number; label: string; accent?: 'amber' | 'red' }) {
  const color = accent === 'amber' ? 'var(--amber)'
              : accent === 'red'   ? 'var(--red, #ef4444)'
              : 'var(--text-1)'
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 700, color, fontFamily: 'var(--font-mono)' as const }}>{n}</div>
      <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>{label}</div>
    </div>
  )
}

const hdr: React.CSSProperties = {
  fontFamily: 'var(--font-display)', fontSize: 28, color: 'var(--text-0)',
  marginTop: 0, marginBottom: 4,
}

const cardStyle: React.CSSProperties = {
  padding: 20,
  background: 'var(--bg-1)',
  border: '1px solid var(--border-0)',
  borderRadius: 12,
}

const emptyTile: React.CSSProperties = {
  fontSize: 13, color: 'var(--text-3)', padding: '12px 0',
}

const rowLink: React.CSSProperties = {
  display: 'flex' as const, gap: 12, alignItems: 'center',
  padding: '8px 10px', borderRadius: 6,
  background: 'var(--bg-2)', textDecoration: 'none' as const,
}

const errStyle: React.CSSProperties = {
  marginBottom: 16, padding: '10px 12px',
  background: 'var(--red-bg)', color: 'var(--red, #ef4444)',
  border: '1px solid var(--red-dim, #ef4444)', borderRadius: 8,
  fontSize: 13,
}
