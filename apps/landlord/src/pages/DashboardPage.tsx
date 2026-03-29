import { useQuery } from 'react-query'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { apiGet } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { formatCurrency, PLATFORM_FEES, getReservePhase } from '@gam/shared'
import { AlertTriangle, CheckCircle, TrendingUp, ArrowDownToLine, Clock } from 'lucide-react'

interface DashStats {
  active_units: number
  direct_pay_units: number
  vacant_units: number
  delinquent_units: number
  suspended_units: number
  eviction_mode_units: number
  monthly_rent_volume: number
  property_count: number
  upcoming_disbursement: { count: number; amount: number }
  otp_units?: number
  projected_otp_disbursement?: number
}

const unitStatusBadge = (s: string) => {
  const map: Record<string, string> = {
    active: 'badge-green', direct_pay: 'badge-blue',
    vacant: 'badge-muted', delinquent: 'badge-amber', suspended: 'badge-red'
  }
  return map[s] || 'badge-muted'
}

export function DashboardPage() {
  const { user } = useAuth()

  const { data: stats, isLoading } = useQuery<DashStats>(
    'dashboard',
    () => apiGet('/landlords/me/dashboard'),
    { refetchInterval: 60000 }
  )

  const { data: units } = useQuery(
    'units-recent',
    () => apiGet<any[]>('/units'),
    { select: (d: any) => d?.slice(0, 8) }
  )

  const { data: disbursements } = useQuery(
    'disbursements-recent',
    () => apiGet<any[]>('/disbursements'),
    { select: (d: any) => d?.slice(0, 5) }
  )

  const totalUnits = (stats?.active_units || 0) + (stats?.direct_pay_units || 0) + (stats?.vacant_units || 0)
  const { phase, rate } = getReservePhase(stats?.active_units || 0)

  // Real monthly trend data from API
  const trendData = (stats as any)?.trend?.length > 0
    ? (stats as any).trend
    : [{ month: 'Now', revenue: stats?.monthly_rent_volume || 0 }]

  if (isLoading) return (
    <div>
      <div className="page-header">
        <div><div className="skeleton" style={{width:200,height:28,marginBottom:8}} /><div className="skeleton" style={{width:160,height:16}} /></div>
      </div>
      <div className="kpi-grid">{[1,2,3,4].map(i => <div key={i} className="kpi-card skeleton" style={{height:100}} />)}</div>
    </div>
  )

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Welcome back, {user?.firstName}. {totalUnits} units across {stats?.property_count} properties.</p>
        </div>
        <div className="flex gap-8">
          <span className={`badge badge-${phase === 1 ? 'amber' : phase === 2 ? 'blue' : 'green'}`}>
            Reserve Phase {phase} — {(rate * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      {/* Alerts */}
      {(stats?.eviction_mode_units || 0) > 0 && (
        <div className="alert alert-danger">
          <AlertTriangle size={16} />
          <div>
            <strong>{stats!.eviction_mode_units} unit(s) in Eviction Mode</strong> — All tenant ACH hard blocked per A.R.S. § 33-1371. No rent will be collected. Disbursement held.
          </div>
        </div>
      )}
      {(stats?.delinquent_units || 0) > 0 && (
        <div className="alert alert-warn">
          <Clock size={16} />
          <strong>{stats!.delinquent_units} delinquent unit(s)</strong> — In cure window. Late fees accruing.
        </div>
      )}
      {(stats?.eviction_mode_units || 0) === 0 && (stats?.delinquent_units || 0) === 0 && (
        <div className="alert alert-success">
          <CheckCircle size={16} />
          <strong>All clear.</strong> No delinquencies. On-Time Pay SLA active.
        </div>
      )}

      {/* KPI Grid */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Active Units</div>
          <div className="kpi-value green">{stats?.active_units || 0}</div>
          <div className="kpi-sub">{stats?.direct_pay_units || 0} direct pay · {stats?.vacant_units || 0} vacant</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Monthly Rent Volume</div>
          <div className="kpi-value gold">{formatCurrency(stats?.monthly_rent_volume || 0)}</div>
          <div className="kpi-sub">across {stats?.active_units || 0} occupied units</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Maintenance</div>
          <div className="kpi-value" style={{fontSize:'1.4rem'}}>{(stats as any)?.maintenance?.open_requests||0} open</div>
          <div className="kpi-sub">{(stats as any)?.maintenance?.in_progress||0} in progress · {(stats as any)?.maintenance?.completed_30d||0} done this month</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Applications</div>
          <div className="kpi-value" style={{fontSize:'1.4rem',color:(stats as any)?.bg_pending>0?'var(--amber)':'var(--green)'}}>{(stats as any)?.bg_pending||0}</div>
          <div className="kpi-sub">{(stats as any)?.bg_pending>0?'pending review':'no pending applications'}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Next Disbursement</div>
          <div className="kpi-value" style={{fontSize:'1.4rem'}}>{formatCurrency(stats?.upcoming_disbursement?.amount || 0)}</div>
          <div className="kpi-sub flex items-center gap-8">
            <span className="status-dot dot-green" />
            On-Time Pay SLA — 1st of month
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Platform Fee / Mo</div>
          <div className="kpi-value">{formatCurrency((stats?.active_units || 0) * PLATFORM_FEES.ACTIVE_UNIT)}</div>
          <div className="kpi-sub">${PLATFORM_FEES.ACTIVE_UNIT}/unit · {(stats?.direct_pay_units || 0)} × $5 direct pay</div>
        </div>
      </div>

      {/* OTP Pipeline */}
      <div className="card" style={{marginBottom:20,background:'rgba(201,162,39,.04)',border:'1px solid rgba(201,162,39,.2)'}}>
        <div className="card-header">
          <span className="card-title">⚡ On-Time Pay Pipeline</span>
          <span style={{fontSize:'.72rem',color:'var(--text-3)'}}>28th disbursement cycle</span>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:20}}>
          <div>
            <div className="kpi-label">OTP-Qualified Units</div>
            <div className="kpi-value" style={{color:'var(--gold)',fontSize:'1.8rem'}}>{stats?.otp_units || 0}</div>
            <div className="kpi-sub">of {stats?.active_units || 0} active units</div>
          </div>
          <div>
            <div className="kpi-label">Projected Disbursement</div>
            <div className="kpi-value" style={{color:'var(--green)',fontSize:'1.8rem'}}>{formatCurrency(stats?.projected_otp_disbursement || 0)}</div>
            <div className="kpi-sub">rent volume eligible for OTP</div>
          </div>
          <div>
            <div className="kpi-label">Next OTP Run</div>
            <div className="kpi-value" style={{fontSize:'1.2rem',marginTop:4}}>
              {(() => { const d = new Date(); d.setMonth(d.getMonth() + (d.getDate() >= 28 ? 1 : 0)); d.setDate(28); return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}); })()}
            </div>
            <div className="kpi-sub">28th of month · ACH batch</div>
          </div>
        </div>
      </div>
            <div className="grid-2" style={{gap:20}}>
        {/* Revenue trend */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Monthly Rent Volume</span>
            <TrendingUp size={16} style={{color:'var(--text-3)'}} />
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={trendData} margin={{top:0,right:0,left:-20,bottom:0}}>
              <defs>
                <linearGradient id="gold-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#c9a227" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#c9a227" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="month" tick={{fill:'var(--text-3)',fontSize:11}} axisLine={false} tickLine={false} />
              <YAxis tick={{fill:'var(--text-3)',fontSize:11}} axisLine={false} tickLine={false}
                tickFormatter={v => `$${(v/1000).toFixed(0)}k`} />
              <Tooltip
                contentStyle={{background:'var(--bg-3)',border:'1px solid var(--border-2)',borderRadius:8,color:'var(--text-0)'}}
                formatter={(v: any) => [formatCurrency(v), 'Rent Volume']}
              />
              <Area type="monotone" dataKey="revenue" stroke="#c9a227" strokeWidth={2}
                fill="url(#gold-grad)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Recent disbursements */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Recent Disbursements</span>
            <ArrowDownToLine size={16} style={{color:'var(--text-3)'}} />
          </div>
          {disbursements?.length ? (
            <table className="data-table">
              <thead><tr>
                <th>Date</th><th>Amount</th><th>Units</th><th>Status</th><th>SLA</th>
              </tr></thead>
              <tbody>
                {disbursements.map((d: any) => (
                  <tr key={d.id}>
                    <td className="mono">{new Date(d.target_date).toLocaleDateString()}</td>
                    <td className="mono" style={{color:'var(--green)'}}>{formatCurrency(d.amount)}</td>
                    <td className="mono">{d.unit_count}</td>
                    <td><span className={`badge ${d.status === 'settled' ? 'badge-green' : d.status === 'pending' ? 'badge-amber' : 'badge-red'}`}>{d.status}</span></td>
                    <td><span className={`badge ${d.from_reserve ? 'badge-gold' : 'badge-muted'}`}>{d.from_reserve ? 'Reserve' : 'Collected'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{color:'var(--text-3)',fontSize:'.82rem',padding:'16px 0'}}>No disbursements yet.</div>
          )}
        </div>
      </div>

      {/* Units table */}
      <div className="card mt-16">
        <div className="card-header">
          <span className="card-title">Unit Overview</span>
          <a href="/units" className="btn btn-ghost btn-sm">View all →</a>
        </div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr>
              <th>Unit</th><th>Property</th><th>Tenant</th><th>Rent</th><th>Status</th><th>On-Time Pay</th>
            </tr></thead>
            <tbody>
              {units?.length ? units.map((u: any) => (
                <tr key={u.id} style={{cursor:'pointer'}} onClick={() => window.location.href=`/units/${u.id}`}>
                  <td className="mono" style={{color:'var(--text-0)',fontWeight:600}}>{u.unit_number}</td>
                  <td>{u.property_name}</td>
                  <td style={{color: u.tenant_first ? 'var(--text-1)' : 'var(--text-3)'}}>
                    {u.tenant_first ? `${u.tenant_first} ${u.tenant_last}` : '—'}
                  </td>
                  <td className="mono">{formatCurrency(u.rent_amount)}</td>
                  <td><span className={`badge ${unitStatusBadge(u.status)}`}>{u.status.replace('_',' ')}</span></td>
                  <td>
                    {u.on_time_pay_active
                      ? <span className="flex items-center gap-8"><span className="status-dot dot-green" /><span style={{fontSize:'.75rem',color:'var(--green)'}}>Active</span></span>
                      : <span style={{color:'var(--text-3)',fontSize:'.75rem'}}>—</span>}
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={6} style={{textAlign:'center',color:'var(--text-3)',padding:'32px'}}>No units added yet. <a href="/properties">Add a property →</a></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
