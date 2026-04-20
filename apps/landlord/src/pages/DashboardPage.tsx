import React, { useState } from 'react'
import { useQuery } from 'react-query'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { apiGet } from '../lib/api'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { AlertTriangle, CheckCircle, TrendingUp, ArrowDownToLine, Clock, FileText, CreditCard, Wrench, ChevronRight } from 'lucide-react'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
const PLATFORM_FEES = { ACTIVE_UNIT: 15 }

interface DashStats {
  activeUnits: number
  directPayUnits: number
  vacantUnits: number
  delinquentUnits: number
  suspendedUnits: number
  evictionModeUnits: number
  monthlyRentVolume: number
  propertyCount: number
  upcomingDisbursement: { count: number; amount: number }
  otpUnits?: number
  projectedOtpDisbursement?: number
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
  const navigate = useNavigate()
  const [showFeeModal, setShowFeeModal] = useState(false)

  const { data: stats, isLoading } = useQuery<DashStats>(
    'dashboard',
    () => apiGet('/landlords/me/dashboard'),
    { staleTime: Infinity }
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

  const totalUnits = (stats?.activeUnits || 0) + (stats?.directPayUnits || 0) + (stats?.vacantUnits || 0)

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


      {/* KPI Grid */}
      <div className="kpi-grid" style={{gridTemplateColumns:"repeat(3, 1fr)"}}>
        <div className="kpi-card" style={{cursor:'pointer'}} onClick={()=>navigate('/units')}>
          <div className="kpi-label">Active Units</div>
          <div className="kpi-value green">{stats?.activeUnits || 0}</div>
          <div className="kpi-sub">{stats?.directPayUnits || 0} direct pay · {stats?.vacantUnits || 0} vacant</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Monthly Rent Volume</div>
          <div className="kpi-value gold">{fmt(stats?.monthlyRentVolume || 0)}</div>
          <div className="kpi-sub">across {stats?.activeUnits || 0} occupied units</div>
        </div>
        <div className="kpi-card" style={{cursor:'pointer'}} onClick={()=>navigate('/maintenance')}>
          <div className="kpi-label">Maintenance</div>
          <div className="kpi-value" style={{fontSize:'1.4rem'}}>{(stats as any)?.maintenance?.openRequests||0} open</div>
          <div className="kpi-sub">{(stats as any)?.maintenance?.inProgress||0} in progress · {(stats as any)?.maintenance?.completed30d||0} done this month</div>
        </div>
        <div className="kpi-card" style={{cursor:'pointer'}} onClick={()=>navigate('/background')}>
          <div className="kpi-label">Applications</div>
          <div className="kpi-value" style={{fontSize:'1.4rem',color:(stats as any)?.bgPending>0?'var(--amber)':'var(--green)'}}>{(stats as any)?.bgPending||0}</div>
          <div className="kpi-sub">{(stats as any)?.bgPending>0?'pending review':'no pending applications'}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Next Disbursement</div>
          <div className="kpi-value" style={{fontSize:'1.4rem'}}>{fmt(stats?.upcomingDisbursement?.amount || 0)}</div>
          <div className="kpi-sub flex items-center gap-8">
            <span className="status-dot dot-green" />
            On-Time Pay SLA — 1st of month
          </div>
        </div>
        <div className="kpi-card" style={{cursor:'pointer'}} onClick={()=>setShowFeeModal(true)}>
          <div className="kpi-label">Platform Fee / Mo</div>
          <div className="kpi-value">{fmt(((stats?.otpUnits||0) * 15) + (Math.max(0,(stats?.activeUnits||0)-(stats?.otpUnits||0)) * 5))}</div>
          <div className="kpi-sub">{stats?.otpUnits||0} OTP × $15 · {Math.max(0,(stats?.activeUnits||0)-(stats?.otpUnits||0))} direct × $5</div>
        </div>
      </div>

      {/* OTP Pipeline */}
      <div className="card" style={{marginBottom:20,background:'rgba(201,162,39,.04)',border:'1px solid rgba(201,162,39,.2)'}}>
        <div className="card-header">
          <span className="card-title">⚡ On-Time Pay Pipeline</span>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:20}}>
          <div>
            <div className="kpi-label">Qualified Units</div>
            <div className="kpi-value" style={{color:'var(--gold)',fontSize:'1.8rem'}}>{stats?.otpUnits || 0}</div>
            <div className="kpi-sub">of {stats?.activeUnits || 0} active units</div>
          </div>
          <div>
            <div className="kpi-label">Unit Qualification Rate</div>
            <div className="kpi-value" style={{color:'var(--gold)',fontSize:'1.8rem'}}>
              {stats?.activeUnits ? Math.round(((stats?.otpUnits || 0) / stats.activeUnits) * 100) : 0}%
            </div>
            <div className="kpi-sub">of occupied portfolio</div>
          </div>
          <div>
            <div className="kpi-label">Projected Disbursement</div>
            <div className="kpi-value" style={{color:'var(--green)',fontSize:'1.8rem'}}>{fmt(stats?.projectedOtpDisbursement || 0)}</div>
            <div className="kpi-sub">guaranteed to landlord</div>
          </div>
          <div>
            <div className="kpi-label">% of Rent Volume</div>
            <div className="kpi-value" style={{color:'var(--green)',fontSize:'1.8rem'}}>
              {stats?.monthlyRentVolume ? Math.round(((stats?.projectedOtpDisbursement || 0) / stats.monthlyRentVolume) * 100) : 0}%
            </div>
            <div className="kpi-sub">of total monthly income</div>
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
                <th>Date</th><th>Amount</th><th>Units</th><th>Status</th><th>SLA</th>
              </tr></thead>
              <tbody>
                {disbursements.map((d: any) => (
                  <tr key={d.id}>
                    <td className="mono">{new Date(d.targetDate).toLocaleDateString()}</td>
                    <td className="mono" style={{color:'var(--green)'}}>{fmt(d.amount)}</td>
                    <td className="mono">{d.unitCount}</td>
                    <td><span className={`badge ${d.status === 'settled' ? 'badge-green' : d.status === 'pending' ? 'badge-amber' : 'badge-red'}`}>{d.status}</span></td>
                    <td><span className={`badge ${d.fromReserve ? 'badge-gold' : 'badge-muted'}`}>{d.fromReserve ? 'Reserve' : 'Collected'}</span></td>
                  </tr>
                ))}
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
                  <tr><th>Tier</th><th>Units</th><th>Rate</th><th>Subtotal</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td>OTP Enrolled</td>
                    <td className="mono">{stats?.otpUnits || 0}</td>
                    <td className="mono">$15/unit</td>
                    <td className="mono" style={{color:'var(--green)'}}>{fmt((stats?.otpUnits || 0) * 15)}</td>
                  </tr>
                  <tr>
                    <td>Direct Pay</td>
                    <td className="mono">{Math.max(0,(stats?.activeUnits||0)-(stats?.otpUnits||0))}</td>
                    <td className="mono">$5/unit</td>
                    <td className="mono" style={{color:'var(--green)'}}>{fmt(Math.max(0,(stats?.activeUnits||0)-(stats?.otpUnits||0)) * 5)}</td>
                  </tr>
                  <tr>
                    <td>Vacant</td>
                    <td className="mono">{stats?.vacantUnits || 0}</td>
                    <td className="mono">$0/unit</td>
                    <td className="mono" style={{color:'var(--text-3)'}}>—</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr style={{borderTop:'1px solid var(--border-2)'}}>
                    <td colSpan={3} style={{fontWeight:600}}>Total Monthly Fee</td>
                    <td className="mono" style={{fontWeight:600,color:'var(--gold)'}}>{fmt(((stats?.otpUnits||0) * 15) + (Math.max(0,(stats?.activeUnits||0)-(stats?.otpUnits||0)) * 5))}</td>
                  </tr>
                </tfoot>
              </table>
              <div style={{marginTop:16,fontSize:'.78rem',color:'var(--text-3)'}}>
                Billed on the 1st · OTP tier unlocks guaranteed 28th disbursement
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bulletin Board */}
      <BulletinBoard />
    </div>
  )
}


function TodoCard() {
  const navigate = useNavigate()
  const [expanded, setExpanded] = React.useState<{ leases: boolean; ach: boolean; maintenance: boolean }>({ leases: false, ach: false, maintenance: false })

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

  const counts = todos?.counts || { leases: 0, ach: 0, maintenance: 0, total: 0 }

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

function BulletinBoard() {
  const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
  const tok = () => localStorage.getItem('gam_token')
  const [date, setDate] = React.useState(new Date().toISOString().split('T')[0])
  const [search, setSearch] = React.useState('')
  const [posts, setPosts] = React.useState<any[]>([])
  const [loading, setLoading] = React.useState(false)

  const fetchPosts = async (d = date, s = search) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ date: d })
      if (s) params.append('search', s)
      const res = await fetch(`${API}/api/bulletin/landlord?${params}`, {
        headers: { Authorization: `Bearer ${tok()}` }
      })
      const data = await res.json()
      setPosts(data.data || [])
    } catch { setPosts([]) }
    finally { setLoading(false) }
  }

  React.useEffect(() => { fetchPosts() }, [date])

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div className="card-title" style={{ marginBottom: 2 }}>Community Bulletin Board</div>
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>Read-only · Posts from your tenants</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            style={{ background: 'var(--bg-2)', border: '1px solid var(--border-1)', borderRadius: 7, color: 'var(--text-0)', padding: '6px 10px', fontSize: '.78rem', outline: 'none' }} />
          <button onClick={() => setDate(new Date().toISOString().split('T')[0])}
            style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border-1)', background: 'var(--bg-2)', color: 'var(--text-2)', fontSize: '.75rem', cursor: 'pointer' }}>
            Today
          </button>
          <input type="text" placeholder="Search posts…" value={search} onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && fetchPosts(date, search)}
            style={{ background: 'var(--bg-2)', border: '1px solid var(--border-1)', borderRadius: 7, color: 'var(--text-0)', padding: '6px 10px', fontSize: '.78rem', outline: 'none', width: 180 }} />
          <button onClick={() => fetchPosts(date, search)}
            style={{ padding: '6px 12px', borderRadius: 7, border: 'none', background: 'var(--gold)', color: '#060809', fontSize: '.75rem', fontWeight: 600, cursor: 'pointer' }}>
            Search
          </button>
        </div>
      </div>
      {loading && <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>}
      {!loading && posts.length === 0 && (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)', fontSize: '.85rem' }}>
          No posts for {new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
        </div>
      )}
      {!loading && posts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {posts.map((post: any) => (
            <div key={post.id} style={{ padding: '12px 14px', background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '.72rem', color: 'var(--gold)', fontWeight: 600 }}>{post.alias}</span>
                {post.pinned && <span style={{ fontSize: '.65rem', color: 'var(--amber)' }}>📌 Pinned</span>}
                <span style={{ fontSize: '.65rem', color: 'var(--text-3)', marginLeft: 'auto' }}>
                  {new Date(post.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </span>
              </div>
              <div style={{ fontSize: '.85rem', color: 'var(--text-1)', lineHeight: 1.6, marginBottom: 6 }}>{post.content}</div>
              <div style={{ display: 'flex', gap: 12, fontSize: '.7rem', color: 'var(--text-3)' }}>
                <span>👍 {post.upvoteCount || 0}</span>
                <span style={{ textTransform: 'capitalize' }}>📍 {post.scope}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}