import React, { useState, useRef } from 'react'
import { useQuery } from 'react-query'
import { humanize } from '@gam/shared'
import { apiGet } from '../lib/api'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, CheckCircle, Activity, ArrowDownToLine, Clock, FileText, CreditCard, Wrench, ChevronRight, HeartHandshake, UserPlus } from 'lucide-react'
import { fmtWhole } from '../lib/format'
// KPI cards show full dollars without cents (fmtWhole). Tables below keep this
// exact, with-cents `fmt` — precise figures belong in the tables.
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
      {/* ── S637: THE CONNECT BANNER IS GONE ────────────────────────────
          S605 put a banner here reading "Tenants can't pay rent yet". It was
          wrong on the facts and wrong to show.

          Wrong on the facts: routes/payments.ts:389 does not block a tenant
          whose landlord has no payout-ready Connect account. It falls back to
          a standard charge, the money lands on GAM's platform balance as
          platform_held, and services/landlordPassthrough.ts releases it the
          moment Connect completes. Its own comment says why — "Otherwise
          tenants hit a wall and spend the rent before we can collect." Rent
          collects the whole time. Only the PAYOUT waits.

          Wrong to show: Nic (DIRECTIVE) — "we don't want other landlords to see
          that banner. I've gotta think about it from that perspective." A
          landlord's dashboard is a screen they open in front of staff and
          co-owners; a red bar announcing their bank is not set up is not
          information they asked to broadcast.

          The prompt to finish Connect is NOT lost — GET /landlords/me/todos
          still carries the bank/KYC task, scoped across every entity the
          account owns, and Settings still shows bank_account_ready. Those are
          places the landlord goes to look, rather than a claim shouted at them
          on arrival. Do not restore this banner. */}
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
          <div className="kpi-value gold">{fmtWhole(stats?.monthlyRentVolume || 0)}</div>
          <div className="kpi-sub">contracted across {rentRollUnits} occupied units</div>
        </div>
        <div className="kpi-card" style={{gridColumn:'span 4',cursor:'pointer'}} onClick={()=>navigate('/reports')}>
          <div className="kpi-label">Collected This Month</div>
          <div className="kpi-value green">{fmtWhole(stats?.collectedMtd || 0)}</div>
          <div className="kpi-sub">settled rent payments MTD</div>
        </div>
        {/* S527 W-3: outstanding → the who-owes-what list, not Reports. */}
        <div className="kpi-card" style={{gridColumn:'span 4',cursor:'pointer'}} onClick={()=>navigate('/balances')}>
          <div className="kpi-label">Outstanding</div>
          <div className="kpi-value" style={{color:(stats?.outstanding||0)>0?'var(--amber)':'var(--text-0)'}}>{fmtWhole(stats?.outstanding || 0)}</div>
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
        {/* S605 (Nic): "disbursements kpi card on overview is not clickable. i
            see no way to see the history." Every other KPI here navigates; this
            one didn't, so the payout history was only reachable by knowing to
            look under Financials. */}
        <div className="kpi-card" style={{gridColumn:'span 6',cursor:'pointer'}} onClick={()=>navigate('/disbursements')}>
          <div className="kpi-label">Next Disbursement</div>
          <div className="kpi-value" style={{fontSize:'1.4rem'}}>{fmtWhole(stats?.upcomingDisbursement?.amount || 0)}</div>
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
          <div className="kpi-value">{fmtWhole(platformFee)}</div>
          <div className="kpi-sub">{rentRollUnits} occupied × $2/unit · $10/property min</div>
        </div>
        <div className="kpi-card" style={{gridColumn:'span 4',cursor:'pointer'}} onClick={()=>navigate('/refer')}>
          <div className="kpi-label">Referral Earnings</div>
          <div className="kpi-value green">{fmtWhole(referralThisMonth)}</div>
          <div className="kpi-sub">this month{referral?.referredCount ? ` · ${referral.referredCount} referred landlord${referral.referredCount === 1 ? '' : 's'}` : ''}</div>
        </div>
        <div className="kpi-card" style={{gridColumn:'span 4'}}>
          <div className="kpi-label">Net Platform Cost</div>
          <div className="kpi-value" style={{color: netToGam <= 0 ? 'var(--green)' : 'var(--text-0)'}}>
            {netToGam < 0 ? `+${fmtWhole(-netToGam)}` : fmtWhole(netToGam)}
          </div>
          <div className="kpi-sub">{netToGam <= 0 ? 'referrals cover your fee' : 'fee − referral earnings'}</div>
        </div>
      </div>

      {/* S159: PM cut MTD vs net to owner — only renders when there's
            an active PM linkage with measurable cut this month. */}
      <PmCutThisMonthCard />

      <div className="grid-2" style={{gap:20}}>
        {/* Property health — an animated ECG whose 6 beats are the last 6
            months of rent collected (taller beat = stronger month). */}
        <PropertyHealthMonitor months={trendData} expected={stats?.monthlyRentVolume} collected={stats?.collectedMtd} />

        {/* Recent disbursements */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Recent Disbursements</span>
            {/* S605: an icon is not a way out. Give the panel a real link to the
                full history, the way the other dashboard panels do. */}
            <span style={{display:'flex',alignItems:'center',gap:8}}>
              <span onClick={()=>navigate('/disbursements')}
                    style={{fontSize:'.74rem',fontWeight:600,color:'var(--gold)',cursor:'pointer'}}>
                View all →
              </span>
              <ArrowDownToLine size={16} style={{color:'var(--text-3)'}} />
            </span>
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
  const [expanded, setExpanded] = React.useState<{ onboarding: boolean; leases: boolean; ach: boolean; maintenance: boolean; workTrade: boolean }>({ onboarding: false, leases: false, ach: false, maintenance: false, workTrade: false })

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

  const counts = todos?.counts || { onboarding: 0, leases: 0, ach: 0, maintenance: 0, workTrade: 0, total: 0 }

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
    { key: 'onboarding', label: 'Onboarding', icon: UserPlus, color: 'var(--green)', items: todos?.onboarding || [] },
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
          <div className="kpi-value gold">{fmtWhole(totals.cut)}</div>
          <div className="kpi-sub">routed to your PM company</div>
        </div>
        <div>
          <div className="kpi-label">Net to You</div>
          <div className="kpi-value green">{fmtWhole(totals.net)}</div>
          <div className="kpi-sub">owner share after PM + GAM fees</div>
        </div>
      </div>
    </div>
  )
}
// Property Health — an animated ECG/"heartbeat monitor". Each of the last 6
// months of rent collected is one PQRST beat; the R-spike height scales with
// that month's collection relative to the strongest month (0 → flatline). A
// sweeping scan bar + glow give the live-monitor feel. Falls back to a static
// trace when the viewer prefers reduced motion.
function PropertyHealthMonitor({ months, expected, collected }: { months: { month: string; revenue: number }[]; expected?: number; collected?: number }) {
  const W = 640, H = 190
  const data = months.length ? months : Array.from({ length: 6 }, () => ({ month: '', revenue: 0 }))
  const vals = data.map(m => Math.max(0, Number(m.revenue) || 0))
  const max = Math.max(1, ...vals)
  const baseY = H * 0.62
  const spk = H * 0.40           // max R-spike height
  const bw = W / data.length     // beat width

  // Build the ECG polyline: per month, a flat baseline with a PQRST complex
  // whose amplitude `a` is that month's collection ÷ the strongest month.
  const pts: [number, number][] = [[0, baseY]]
  data.forEach((_, i) => {
    const x0 = i * bw
    const a = vals[i] / max
    const at = (f: number) => x0 + f * bw
    const y = (up: number) => baseY - up * spk * a   // up>0 = above baseline
    pts.push(
      [at(0.30), baseY],
      [at(0.36), y(0.08)], [at(0.42), baseY],        // P wave
      [at(0.48), y(-0.10)],                          // Q
      [at(0.53), y(1.0)],                            // R spike
      [at(0.58), y(-0.22)],                          // S
      [at(0.63), baseY],
      [at(0.76), y(0.20)], [at(0.86), baseY],        // T wave
      [at(1.0), baseY],
    )
  })
  const dPath = 'M ' + pts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ')

  // Health = how much of this month's EXPECTED lease rent has come in. A high
  // outstanding balance (far from expected) reads red; as collections approach
  // the expected monthly rent it goes green; at 100% it's gold. Lease rent only
  // — short-term / walk-in reservation income isn't counted here.
  const expectedN = Math.max(0, Number(expected) || 0)
  const collectedN = Math.max(0, Number(collected) || 0)
  const rate = expectedN > 0 ? collectedN / expectedN : null   // fraction of expected rent collected
  const pct = rate == null ? null : Math.round(rate * 100)
  // Clean red → green → gold (no amber — it'd read as the gold at a glance).
  const status = rate == null
    ? { label: 'Awaiting data',     color: 'var(--text-3)' }
    : rate >= 1    ? { label: 'Fully collected', color: 'var(--gold)' }
    : rate >= 0.85 ? { label: 'Healthy',         color: 'var(--green)' }
    :                { label: 'Needs attention', color: 'var(--red)' }

  // Hover: map the cursor to a month and surface that beat's details.
  const peaks = data.map((_, i) => ({ x: (i + 0.53) * bw, y: baseY - spk * (vals[i] / max) }))
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const onMove = (e: React.MouseEvent) => {
    const el = screenRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const f = (e.clientX - r.left) / r.width
    setHoverIdx(Math.max(0, Math.min(data.length - 1, Math.floor(f * data.length))))
  }

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Property Health — last 6 months</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '.72rem', fontWeight: 700, color: status.color }}>
          <Activity size={15} /> {status.label}
        </span>
      </div>
      <div className="phm-screen" ref={screenRef} onMouseMove={onMove} onMouseLeave={() => setHoverIdx(null)}>
        {hoverIdx == null ? (
          <div className="phm-readout">
            <span className="phm-readout-label">rent collected · this month</span>
            <span className="phm-readout-value" style={{ color: status.color }}>{pct == null ? '—' : `${pct}%`}</span>
          </div>
        ) : (
          <div className="phm-tip" style={{ left: `clamp(62px, ${((hoverIdx + 0.53) / data.length) * 100}%, calc(100% - 62px))` }}>
            <div className="phm-tip-month">{data[hoverIdx].month || '—'}</div>
            <div className="phm-tip-val" style={{ color: status.color }}>{fmt(vals[hoverIdx])}</div>
            <div className="phm-tip-sub">collected · {Math.round((vals[hoverIdx] / max) * 100)}% of peak</div>
          </div>
        )}
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={190} preserveAspectRatio="none"
             role="img" aria-label={`Rent collection health, last 6 months: ${status.label}`}>
          <defs>
            <linearGradient id="phm-sweep-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%"   stopColor={status.color} stopOpacity="0" />
              <stop offset="72%"  stopColor={status.color} stopOpacity="0.08" />
              <stop offset="100%" stopColor={status.color} stopOpacity="0.30" />
            </linearGradient>
          </defs>
          <g className="phm-grid">
            {Array.from({ length: data.length + 1 }, (_, i) => <line key={'v' + i} x1={i * bw} y1={0} x2={i * bw} y2={H} />)}
            {Array.from({ length: 5 }, (_, i) => <line key={'h' + i} x1={0} y1={i * H / 4} x2={W} y2={i * H / 4} />)}
          </g>
          <line x1={0} y1={baseY} x2={W} y2={baseY} className="phm-base" />
          <path d={dPath} className="phm-trace" style={{ stroke: status.color }} fill="none" />
          <g className="phm-sweepwrap">
            <rect x={0} y={0} width={100} height={H} fill="url(#phm-sweep-grad)" />
          </g>
          {hoverIdx != null && (
            <g style={{ color: status.color }}>
              <line className="phm-hoverline" x1={(hoverIdx + 0.53) * bw} y1={0} x2={(hoverIdx + 0.53) * bw} y2={H} />
              <circle className="phm-hoverdot" cx={peaks[hoverIdx].x} cy={peaks[hoverIdx].y} r={4.5} />
            </g>
          )}
        </svg>
        <div className="phm-months">
          {data.map((m, i) => <span key={i}>{m.month}</span>)}
        </div>
      </div>
      <style>{`
        .phm-screen { position: relative; background: radial-gradient(120% 90% at 50% 30%, rgba(20,26,22,.55), var(--bg-2)); border: 1px solid var(--border-0); border-radius: 10px; padding: 8px; overflow: hidden; cursor: crosshair; }
        .phm-hoverline { stroke: currentColor; stroke-width: 1; opacity: .55; stroke-dasharray: 3 3; }
        .phm-hoverdot { fill: currentColor; filter: drop-shadow(0 0 5px currentColor); }
        .phm-tip { position: absolute; top: 8px; z-index: 2; transform: translateX(-50%); background: var(--bg-3); border: 1px solid var(--border-1, var(--border-0)); border-radius: 8px; padding: 5px 10px; text-align: center; white-space: nowrap; pointer-events: none; box-shadow: 0 6px 18px rgba(0,0,0,.4); }
        .phm-tip-month { font-size: .58rem; text-transform: uppercase; letter-spacing: .07em; color: var(--text-3); }
        .phm-tip-val { font-family: var(--font-mono); font-size: .98rem; font-weight: 700; }
        .phm-tip-sub { font-size: .58rem; color: var(--text-3); margin-top: 1px; }
        .phm-grid line { stroke: var(--border-0); stroke-width: 1; opacity: .3; }
        .phm-base { stroke: var(--border-1, var(--border-0)); stroke-width: 1; opacity: .45; }
        .phm-trace { stroke-width: 2.25; stroke-linejoin: round; stroke-linecap: round; filter: drop-shadow(0 0 4px currentColor); }
        .phm-sweepwrap { opacity: 0; }
        .phm-readout { position: absolute; top: 8px; right: 12px; z-index: 1; display: flex; flex-direction: column; align-items: flex-end; line-height: 1.1; pointer-events: none; }
        .phm-readout-label { font-size: .58rem; text-transform: uppercase; letter-spacing: .08em; color: var(--text-3); }
        .phm-readout-value { font-family: var(--font-mono); font-size: 1.05rem; font-weight: 700; }
        .phm-months { display: flex; justify-content: space-around; margin-top: 4px; font-size: .66rem; color: var(--text-3); font-family: var(--font-mono); }
        @media (prefers-reduced-motion: no-preference) {
          .phm-sweepwrap { opacity: 1; animation: phm-sweep 3.4s linear infinite; }
          .phm-trace { animation: phm-glow 2.2s ease-in-out infinite; }
          @keyframes phm-sweep { from { transform: translateX(-100px); } to { transform: translateX(${W}px); } }
          @keyframes phm-glow { 0%, 100% { opacity: .82; } 50% { opacity: 1; } }
        }
      `}</style>
    </div>
  )
}
