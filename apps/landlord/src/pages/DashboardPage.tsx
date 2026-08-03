import React, { useState } from 'react'
import { useQuery } from 'react-query'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { humanize } from '@gam/shared'
import { apiGet } from '../lib/api'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, CheckCircle, TrendingUp, ArrowDownToLine, Clock, FileText, CreditCard, Wrench, ChevronRight, HeartHandshake } from 'lucide-react'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

interface DashStats {
  activeUnits: number
  vacantUnits: number
  delinquentUnits: number
  suspendedUnits: number
  evictionModeUnits: number
  monthlyRentVolume: number
  collectedMtd: number
  outstanding: number
  totalUnits: number
  occupancyRate: number
  leasesExpiring30d: number
  leasesExpiring60d: number
  propertyCount: number
  upcomingDisbursement: { count: number; amount: number }
  otpUnits?: number
  projectedOtpDisbursement?: number
  platformFee?: number
  platformFeeByProperty?: { propertyId: string; name: string; fee: number }[]
}

export function DashboardPage() {
  const navigate = useNavigate()
  const [showFeeModal, setShowFeeModal] = useState(false)

  const { data: stats, isLoading } = useQuery<DashStats>(
    'dashboard',
    () => apiGet('/landlords/me/dashboard'),
    { staleTime: Infinity }
  )

  const { data: disbursements } = useQuery(
    'disbursements-recent',
    () => apiGet<any[]>('/disbursements'),
    { select: (d: any) => d?.slice(0, 5) }
  )

  // S574 (Nic): referral earnings for the platform-fee / referral / net trio.
  // The platform-fee card is a gross COST; this is the income that offsets it.
  const { data: referral } = useQuery<any>('referral-earnings', () => apiGet('/landlords/referral-earnings'))

  // Pad trend to always show 6 months
  const trendData = (() => {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const now = new Date()
    const slots = Array.from({length:6}, (_,i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1)
      return months[d.getMonth()]
    })
    const apiTrend: any[] = (stats as any)?.trend || []
    return slots.map(m => ({ month: m, revenue: apiTrend.find((r:any) => r.month === m)?.revenue || 0 }))
  })()

  // Platform fee: authoritative per-property number from the API — $2/billable
  // unit floored at the $10 property minimum (full stop), summed across every
  // property. Same calc the billing cron + Reports use, so this matches the bill.
  // Full rent roll = every occupied unit (active + delinquent + suspended).
  // Backs the "Expected Monthly Rent" subtext so the count matches the units
  // actually summed into that figure. (direct_pay retired W-15/S531.)
  const rentRollUnits = (stats?.activeUnits || 0) + (stats?.delinquentUnits || 0) + (stats?.suspendedUnits || 0)
  const platformFee = stats?.platformFee ?? 0
  // S574: referral earnings offset the platform fee. Net > 0 = you still owe GAM
  // that much this month; Net <= 0 = your referrals earn back more than you pay.
  const referralThisMonth = Number(referral?.thisMonth ?? 0)
  const netToGam = platformFee - referralThisMonth
  const platformFeeByProperty: { propertyId: string; name: string; fee: number }[] =
    (stats as any)?.platformFeeByProperty ?? []

  // Auto-payout cadence is weekly (Fridays). Show the next Friday as the
  // concrete next-payout date rather than a fixed "1st of month" SLA label.
  const nextPayoutDate = (() => {
    const d = new Date()
    const add = ((5 - d.getDay()) + 7) % 7 || 7
    d.setDate(d.getDate() + add)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  })()

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
      {/* Alerts */}
      {(stats?.evictionModeUnits || 0) > 0 && (
        <div className="alert alert-danger" style={{cursor:'pointer'}} onClick={()=>navigate('/units?status=eviction')}>
          <AlertTriangle size={16} />
          <div>
            <strong>{stats!.evictionModeUnits} unit(s) in Eviction Mode</strong> — All tenant ACH hard blocked. No rent will be collected. Disbursement held. Check your local laws before accepting any payment.
          </div>
          <span style={{marginLeft:'auto',fontSize:'.78rem',fontWeight:600}}>View →</span>
        </div>
      )}
      {(stats?.delinquentUnits || 0) > 0 && (
        <div className="alert alert-warn" style={{cursor:'pointer'}} onClick={()=>navigate('/units?status=delinquent')}>
          <Clock size={16} />
          <strong>{stats!.delinquentUnits} delinquent unit(s)</strong> — In cure window. Late fees accruing.
          <span style={{marginLeft:'auto',fontSize:'.78rem',fontWeight:600}}>View →</span>
        </div>
      )}
      {((stats as any)?.leasesNeedReview || 0) > 0 && (
        <div className="alert alert-warn" style={{cursor:'pointer'}} onClick={()=>navigate('/leases?review=1')}>
          <AlertTriangle size={16} />
          <strong>{(stats as any).leasesNeedReview} lease(s) need review</strong> — Imported with default values. Open to confirm the real terms.
          <span style={{marginLeft:'auto',fontSize:'.78rem',fontWeight:600}}>View →</span>
        </div>
      )}


      {/* KPI Grid — 12-col so we can run 3 / 4 / 3 cards per row (spans 4 / 3 / 4). */}
      <div className="kpi-grid" style={{gridTemplateColumns:"repeat(12, 1fr)"}}>
        {/* Row 1 (span 4): rent money trio */}
        {/* W-2 (S531): clicks through to the rent-roll page, whose total is
            the same formula as monthlyRentVolume. */}
        <div className="kpi-card" style={{gridColumn:'span 4',cursor:'pointer'}} onClick={()=>navigate('/rent-roll')}>
          <div className="kpi-label">Expected Monthly Rent</div>
          <div className="kpi-value gold">{fmt(stats?.monthlyRentVolume || 0)}</div>
          <div className="kpi-sub">contracted across {rentRollUnits} occupied units</div>
        </div>
        <div className="kpi-card" style={{gridColumn:'span 4',cursor:'pointer'}} onClick={()=>navigate('/reports')}>
          <div className="kpi-label">Collected This Month</div>
          <div className="kpi-value green">{fmt(stats?.collectedMtd || 0)}</div>
          <div className="kpi-sub">settled rent payments MTD</div>
        </div>
        {/* S527 W-3: outstanding → the who-owes-what list, not Reports. */}
        <div className="kpi-card" style={{gridColumn:'span 4',cursor:'pointer'}} onClick={()=>navigate('/balances')}>
          <div className="kpi-label">Outstanding</div>
          <div className="kpi-value" style={{color:(stats?.outstanding||0)>0?'var(--amber)':'var(--text-0)'}}>{fmt(stats?.outstanding || 0)}</div>
          <div className="kpi-sub">unpaid invoice balances</div>
        </div>
        {/* Row 2 (span 3): portfolio + operations */}
        <div className="kpi-card" style={{gridColumn:'span 3',cursor:'pointer'}} onClick={()=>navigate('/units')}>
          <div className="kpi-label">Occupancy Rate</div>
          <div className="kpi-value">{stats?.occupancyRate ?? 0}%</div>
          <div className="kpi-sub">{stats?.activeUnits || 0} of {stats?.totalUnits || 0} units active</div>
        </div>
        {/* S527 W-4: land pre-filtered to active units. */}
        <div className="kpi-card" style={{gridColumn:'span 3',cursor:'pointer'}} onClick={()=>navigate('/units?status=active')}>
          <div className="kpi-label">Active Units</div>
          <div className="kpi-value green">{stats?.activeUnits || 0}</div>
          <div className="kpi-sub">{stats?.vacantUnits || 0} vacant</div>
        </div>
        {/* S527 W-5: land pre-filtered to the expiring window. */}
        <div className="kpi-card" style={{gridColumn:'span 3',cursor:'pointer'}} onClick={()=>navigate('/leases?expiring=60')}>
          <div className="kpi-label">Leases Expiring</div>
          <div className="kpi-value" style={{fontSize:'1.4rem',color:(stats?.leasesExpiring30d||0)>0?'var(--amber)':'var(--text-0)'}}>{stats?.leasesExpiring30d || 0} in 30d</div>
          <div className="kpi-sub">{stats?.leasesExpiring60d || 0} within 60 days</div>
        </div>
        <div className="kpi-card" style={{gridColumn:'span 3',cursor:'pointer'}} onClick={()=>navigate('/maintenance')}>
          <div className="kpi-label">Maintenance</div>
          <div className="kpi-value" style={{fontSize:'1.4rem'}}>{(stats as any)?.maintenance?.openRequests||0} open</div>
          <div className="kpi-sub">{(stats as any)?.maintenance?.inProgress||0} in progress · {(stats as any)?.maintenance?.completed30d||0} done this month</div>
        </div>
        {/* Row 3 (span 6): applications + next payout */}
        <div className="kpi-card" style={{gridColumn:'span 6',cursor:'pointer'}} onClick={()=>navigate('/background')}>
          <div className="kpi-label">Applications</div>
          <div className="kpi-value" style={{fontSize:'1.4rem',color:(stats as any)?.bgPending>0?'var(--amber)':'var(--green)'}}>{(stats as any)?.bgPending||0}</div>
          <div className="kpi-sub">{(stats as any)?.bgPending>0?'pending review':'no pending applications'}</div>
        </div>
        <div className="kpi-card" style={{gridColumn:'span 6'}}>
          <div className="kpi-label">Next Disbursement</div>
          <div className="kpi-value" style={{fontSize:'1.4rem'}}>{fmt(stats?.upcomingDisbursement?.amount || 0)}</div>
          <div className="kpi-sub flex items-center gap-8">
            <span className="status-dot dot-green" />
            Next payout {nextPayoutDate}
          </div>
        </div>
        {/* Row 4 (span 4): your money with GAM — fee you pay, referral you earn, net.
            S574 (Nic): kept as three separate cards (a cost, an income, the net)
            rather than netting into one, so each reads clearly at a glance. */}
        <div className="kpi-card" style={{gridColumn:'span 4',cursor:'pointer'}} onClick={()=>setShowFeeModal(true)}>
          <div className="kpi-label">Platform Fee / Mo</div>
          <div className="kpi-value">{fmt(platformFee)}</div>
          <div className="kpi-sub">{rentRollUnits} occupied × $2/unit · $10/property min</div>
        </div>
        <div className="kpi-card" style={{gridColumn:'span 4',cursor:'pointer'}} onClick={()=>navigate('/refer')}>
          <div className="kpi-label">Referral Earnings</div>
          <div className="kpi-value green">{fmt(referralThisMonth)}</div>
          <div className="kpi-sub">this month{referral?.referredCount ? ` · ${referral.referredCount} referred landlord${referral.referredCount === 1 ? '' : 's'}` : ''}</div>
        </div>
        <div className="kpi-card" style={{gridColumn:'span 4'}}>
          <div className="kpi-label">Net Platform Cost</div>
          <div className="kpi-value" style={{color: netToGam <= 0 ? 'var(--green)' : 'var(--text-0)'}}>
            {netToGam < 0 ? `+${fmt(-netToGam)}` : fmt(netToGam)}
          </div>
          <div className="kpi-sub">{netToGam <= 0 ? 'referrals cover your fee' : 'fee − referral earnings'}</div>
        </div>
      </div>

      {/* S159: PM cut MTD vs net to owner — only renders when there's
            an active PM linkage with measurable cut this month. */}
      <PmCutThisMonthCard />

      <div className="grid-2" style={{gap:20}}>
        {/* Revenue trend */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Rent Collected — last 6 months</span>
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
                formatter={(v: any) => [fmt(v), 'Rent Volume']}
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
                <th>Date</th><th>Amount</th><th>Trigger</th><th>Status</th>
              </tr></thead>
              <tbody>
                {disbursements.map((d: any) => {
                  const dateStr = d.createdAt ?? d.targetDate
                  return (
                    <tr key={d.id}>
                      <td className="mono">{dateStr ? new Date(dateStr).toLocaleDateString() : '—'}</td>
                      <td className="mono" style={{color:'var(--green)'}}>{fmt(d.amount)}</td>
                      <td style={{fontSize:'.78rem'}}>
                        {d.triggerType === 'auto_friday' ? 'Auto-Friday' : d.triggerType === 'manual_on_demand' ? 'Manual' : (d.triggerType ?? '—')}
                      </td>
                      <td><span className={`badge ${d.status === 'settled' ? 'badge-green' : d.status === 'pending' || d.status === 'processing' ? 'badge-amber' : 'badge-red'}`}>{humanize(d.status)}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <div style={{color:'var(--text-3)',fontSize:'.82rem',padding:'16px 0'}}>No disbursements yet.</div>
          )}
        </div>
      </div>

      {/* To-Do List */}
      <TodoCard />

      {showFeeModal && (
        <div className="modal-overlay" onClick={()=>setShowFeeModal(false)}>
          <div className="modal" style={{maxWidth:480}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Platform Fee Breakdown</span>
              <button className="btn btn-ghost btn-sm" onClick={()=>setShowFeeModal(false)}>✕</button>
            </div>
            <div style={{padding:'0 24px 24px'}}>
              <table className="data-table" style={{marginTop:8}}>
                <thead>
                  <tr><th>Property</th><th style={{textAlign:'right'}}>Monthly Fee</th></tr>
                </thead>
                <tbody>
                  {platformFeeByProperty.length ? platformFeeByProperty.map(p => (
                    <tr key={p.propertyId}>
                      <td style={{color:'var(--text-0)'}}>{p.name}</td>
                      <td className="mono" style={{textAlign:'right',color:'var(--gold)'}}>{fmt(p.fee)}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={2} style={{textAlign:'center',color:'var(--text-3)',padding:16}}>No properties yet.</td></tr>
                  )}
                </tbody>
                <tfoot>
                  <tr style={{borderTop:'1px solid var(--border-2)'}}>
                    <td style={{fontWeight:600}}>Total Monthly Fee</td>
                    <td className="mono" style={{textAlign:'right',fontWeight:600,color:'var(--gold)'}}>{fmt(platformFee)}</td>
                  </tr>
                </tfoot>
              </table>
              <div style={{marginTop:16,fontSize:'.78rem',color:'var(--text-3)'}}>
                $2 per occupied unit · $10 per-property monthly minimum (charged on every property)
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TodoCard() {
  const navigate = useNavigate()
  const [expanded, setExpanded] = React.useState<{ leases: boolean; ach: boolean; maintenance: boolean; workTrade: boolean }>({ leases: false, ach: false, maintenance: false, workTrade: false })

  const { data: todos, isLoading } = useQuery<any>(
    'landlord-todos',
    () => apiGet('/landlords/me/todos'),
    { staleTime: 30000 } // 30s
  )

  if (isLoading) {
    return (
      <div className="card mt-16" style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>
        Loading to-dos…
      </div>
    )
  }

  const counts = todos?.counts || { leases: 0, ach: 0, maintenance: 0, workTrade: 0, total: 0 }

  // All-clear state
  if (counts.total === 0) {
    return (
      <div className="card mt-16">
        <div className="card-header">
          <span className="card-title">To-Do</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '32px 0', gap: 10 }}>
          <CheckCircle size={32} style={{ color: 'var(--green)', opacity: 0.8 }} />
          <div style={{ fontSize: '.88rem', color: 'var(--text-1)', fontWeight: 600 }}>All clear</div>
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>Nothing needs your attention right now.</div>
        </div>
      </div>
    )
  }

  const sections = [
    { key: 'leases', label: 'Lease Issues', icon: FileText, color: 'var(--gold)', items: todos?.leases || [] },
    { key: 'ach', label: 'ACH Issues', icon: CreditCard, color: 'var(--amber)', items: todos?.ach || [] },
    { key: 'maintenance', label: 'High-$ Maintenance', icon: Wrench, color: 'var(--blue)', items: todos?.maintenance || [] },
    { key: 'workTrade', label: 'Work Trade', icon: HeartHandshake, color: 'var(--gold)', items: todos?.workTrade || [] },
  ]

  return (
    <div className="card mt-16">
      <div className="card-header">
        <span className="card-title">To-Do</span>
        <span style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
          {counts.total} item{counts.total === 1 ? '' : 's'} need{counts.total === 1 ? 's' : ''} attention
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 8 }}>
        {sections.map(section => {
          if (section.items.length === 0) return null
          const isExpanded = expanded[section.key as keyof typeof expanded]
          const visible = isExpanded ? section.items : section.items.slice(0, 3)
          const Icon = section.icon

          return (
            <div key={section.key}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Icon size={14} style={{ color: section.color }} />
                <span style={{ fontSize: '.78rem', fontWeight: 700, color: 'var(--text-1)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                  {section.label}
                </span>
                <span style={{ fontSize: '.68rem', color: 'var(--text-3)', fontWeight: 600 }}>
                  ({section.items.length})
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {visible.map((item: any) => (
                  <div
                    key={item.id}
                    onClick={() => navigate(item.href)}
                    style={{
                      padding: '10px 12px',
                      background: 'var(--bg-2)',
                      border: '1px solid var(--border-0)',
                      borderRadius: 8,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      transition: 'border-color .12s, background .12s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = section.color; e.currentTarget.style.background = 'var(--bg-3)' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-0)'; e.currentTarget.style.background = 'var(--bg-2)' }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '.82rem', fontWeight: 600, color: 'var(--text-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.title}
                      </div>
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.subtitle}
                      </div>
                    </div>
                    <ChevronRight size={14} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
                  </div>
                ))}
              </div>

              {section.items.length > 3 && (
                <button
                  onClick={() => setExpanded(e => ({ ...e, [section.key]: !isExpanded }))}
                  style={{
                    marginTop: 6,
                    padding: '4px 8px',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-3)',
                    fontSize: '.72rem',
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  {isExpanded ? 'Show less' : `Show all ${section.items.length}`}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PmCutThisMonthCard() {
  const navigate = useNavigate()
  const monthStart = (() => { const d = new Date(); d.setDate(1); return d.toISOString().slice(0,10) })()
  const today = new Date().toISOString().slice(0,10)

  const { data } = useQuery<{ rows: Array<{
    propertyId: string; propertyName: string; pmCompanyId: string | null;
    pmCompanyName: string | null; pmCompanyCut: string; ownerNet: string;
  }>; from: string | null; to: string | null }>(
    ['pm-impact-mtd', monthStart, today],
    () => apiGet(`/landlords/me/pm-impact?from=${monthStart}&to=${today}`),
    { staleTime: 5 * 60 * 1000 },
  )

  if (!data || data.rows.length === 0) return null

  const totals = data.rows.reduce((acc, r) => {
    acc.cut    += Number(r.pmCompanyCut) || 0
    acc.net    += Number(r.ownerNet) || 0
    if (r.pmCompanyId) acc.linkedProps += 1
    return acc
  }, { cut: 0, net: 0, linkedProps: 0 })

  if (totals.cut === 0 && totals.linkedProps === 0) return null

  return (
    <div className="card" style={{ marginBottom: 20, cursor: 'pointer', background: 'rgba(201,162,39,.04)', border: '1px solid rgba(201,162,39,.2)' }}
         onClick={() => navigate('/disbursements')}>
      <div className="card-header">
        <span className="card-title">PM Cut This Month</span>
        <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
          across {totals.linkedProps} {totals.linkedProps === 1 ? 'property' : 'properties'}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div>
          <div className="kpi-label">PM Cut</div>
          <div className="kpi-value gold">{fmt(totals.cut)}</div>
          <div className="kpi-sub">routed to your PM company</div>
        </div>
        <div>
          <div className="kpi-label">Net to You</div>
          <div className="kpi-value green">{fmt(totals.net)}</div>
          <div className="kpi-sub">owner share after PM + GAM fees</div>
        </div>
      </div>
    </div>
  )
}