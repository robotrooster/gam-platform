import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
import { formatCurrency } from '@gam/shared'
import { ArrowLeft, DoorOpen, Building2, CreditCard, Wrench, Star, TrendingUp, Clock, CheckCircle, AlertTriangle, XCircle } from 'lucide-react'
import { TransferTenantModal } from './TransferTenantModal'

export function TenantDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [showTransfer, setShowTransfer] = useState(false)
  const { data, isLoading } = useQuery(['tenant-profile', id], () => apiGet<any>(`/tenants/${id}/profile`))

  if (isLoading) return <div style={{ color: 'var(--text-3)', padding: 32 }}>Loading…</div>
  if (!data) return <div className="empty-state"><h3>Tenant not found</h3></div>

  const { tenant, units, payments, maintenance, workTrade, stats } = data

  const currentUnit = units?.find((u: any) => u.is_current)
  const pastUnits   = units?.filter((u: any) => !u.is_current)

  const onTimeColor = stats.onTimeRate >= 90 ? 'var(--green)' : stats.onTimeRate >= 75 ? 'var(--amber)' : 'var(--red)'
  const onTimeLabel = stats.onTimeRate >= 90 ? 'Excellent' : stats.onTimeRate >= 75 ? 'Good' : 'Needs Attention'

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/tenants')}><ArrowLeft size={15} /></button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'linear-gradient(135deg, var(--gold-dark), var(--gold))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 800, color: 'var(--bg-0)', flexShrink: 0 }}>
              {tenant.first_name?.[0]}{tenant.last_name?.[0]}
            </div>
            <div>
              <h1 className="page-title" style={{ marginBottom: 2 }}>{tenant.first_name} {tenant.last_name}</h1>
              <p className="page-subtitle">
                {currentUnit ? `Unit ${currentUnit.unit_number} · ${currentUnit.property_name}` : 'No current unit'}
                {tenant.ssi_ssdi && <span className="badge badge-gold" style={{ marginLeft: 8 }}>SSI/SSDI</span>}
                {tenant.on_time_pay_enrolled && <span className="badge badge-green" style={{ marginLeft: 6 }}>On-Time Pay</span>}
              </p>
            </div>
          </div>
        </div>
        {currentUnit && <button className="btn btn-primary" onClick={() => setShowTransfer(true)}>Transfer Unit</button>}
      </div>

      {/* Lifetime stats strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 12, marginBottom: 24 }}>
        {[
          { label: 'Tenant Since',    val: stats.firstPayment ? new Date(stats.firstPayment).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—', color: 'var(--text-0)' },
          { label: 'Months as Tenant', val: stats.tenantMonths + ' mo', color: 'var(--text-0)' },
          { label: 'Total Paid',      val: formatCurrency(stats.totalPaid), color: 'var(--gold)' },
          { label: 'On-Time Rate',    val: stats.onTimeRate + '%', color: onTimeColor, sub: onTimeLabel },
          { label: 'Units Occupied',  val: stats.unitsOccupied, color: 'var(--text-0)' },
        ].map(s => (
          <div key={s.label} className="card" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: '.65rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>{s.label}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1rem', fontWeight: 700, color: s.color }}>{s.val}</div>
            {(s as any).sub && <div style={{ fontSize: '.65rem', color: s.color, marginTop: 2 }}>{(s as any).sub}</div>}
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>

        {/* Contact info */}
        <div className="card">
          <div className="card-title" style={{ marginBottom: 14 }}>Contact</div>
          {[
            { label: 'Email',       val: tenant.email },
            { label: 'Phone',       val: tenant.phone || '—' },
            { label: 'ACH Verified', val: tenant.ach_verified ? '✓ Verified' : 'Pending', color: tenant.ach_verified ? 'var(--green)' : 'var(--amber)' },
            { label: 'Credit Reporting', val: tenant.credit_reporting_enrolled ? 'Active — $5/mo' : '—' },
            { label: 'Member Since', val: new Date(tenant.account_created).toLocaleDateString() },
          ].map(row => (
            <div key={row.label} className="data-row">
              <span className="data-key">{row.label}</span>
              <span className="data-val" style={{ color: (row as any).color }}>{row.val}</span>
            </div>
          ))}
        </div>

        {/* Payment health */}
        <div className="card">
          <div className="card-title" style={{ marginBottom: 14 }}>Payment Health</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: `${onTimeColor}18`, border: `3px solid ${onTimeColor}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '.9rem', fontWeight: 800, color: onTimeColor }}>{stats.onTimeRate}%</span>
            </div>
            <div>
              <div style={{ fontSize: '.85rem', fontWeight: 700, color: onTimeColor }}>{onTimeLabel}</div>
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>On-time payment rate</div>
            </div>
          </div>
          {[
            { icon: <CheckCircle size={13} style={{ color: 'var(--green)' }} />, label: 'Settled',  val: stats.settledCount },
            { icon: <Clock size={13} style={{ color: 'var(--amber)' }} />,       label: 'Late',     val: stats.lateCount },
            { icon: <XCircle size={13} style={{ color: 'var(--red)' }} />,       label: 'Failed',   val: stats.failedCount },
            { icon: <TrendingUp size={13} style={{ color: 'var(--text-3)' }} />, label: 'Avg Payment', val: formatCurrency(stats.avgPayment) },
          ].map(row => (
            <div key={row.label} className="data-row">
              <span className="data-key" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{row.icon}{row.label}</span>
              <span className="data-val mono">{row.val}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Unit history */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title" style={{ marginBottom: 14 }}>Unit History</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {units?.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>No unit history.</div>}
          {units?.map((u: any) => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, background: 'var(--bg-2)', border: `1px solid ${u.is_current ? 'rgba(201,162,39,.3)' : 'var(--border-0)'}` }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: u.is_current ? 'rgba(201,162,39,.12)' : 'var(--bg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <DoorOpen size={16} style={{ color: u.is_current ? 'var(--gold)' : 'var(--text-3)' }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--text-0)' }}>Unit {u.unit_number}</span>
                  {u.is_current && <span className="badge badge-green">Current</span>}
                </div>
                <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 1 }}>
                  <Building2 size={9} style={{ display: 'inline', marginRight: 3 }} />
                  {u.property_name} · {u.street1}, {u.city}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.82rem', color: 'var(--gold)', fontWeight: 600 }}>{formatCurrency(u.rent_amount)}/mo</div>
                {u.start_date && <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginTop: 1 }}>{new Date(u.start_date).toLocaleDateString()} – {u.end_date ? new Date(u.end_date).toLocaleDateString() : 'Present'}</div>}
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/units/${u.id}`)}>
                View Unit
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Work trade */}
      {workTrade?.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title" style={{ marginBottom: 14 }}>Work Trade Agreements</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {workTrade.map((wt: any) => (
              <div key={wt.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, background: 'var(--bg-2)', border: '1px solid var(--border-0)' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: '.82rem', fontWeight: 600, color: 'var(--text-0)' }}>{wt.trade_type === 'full' ? 'Full Trade' : wt.trade_type === 'partial' ? 'Partial Trade' : 'Credit Model'}</span>
                    <span className={`badge ${wt.status === 'active' ? 'badge-green' : 'badge-muted'}`}>{wt.status}</span>
                    {wt.flag_1099 && <span className="badge badge-amber">1099 Required</span>}
                  </div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 1 }}>
                    Unit {wt.unit_number} · {wt.property_name} · {wt.weekly_hours}hrs/wk @ {formatCurrency(wt.hourly_rate)}/hr
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.78rem', color: 'var(--gold)' }}>YTD: {formatCurrency(wt.ytd_value)}</div>
                  <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginTop: 1 }}>{new Date(wt.start_date).toLocaleDateString()}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Payment history */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title" style={{ marginBottom: 14 }}><CreditCard size={14} style={{ display: 'inline', marginRight: 6 }} />Payment History (last 36)</div>
        {payments?.length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>No payments yet.</div>
        ) : (
          <table className="data-table">
            <thead><tr><th>Date</th><th>Property</th><th>Unit</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              {payments?.map((p: any) => (
                <tr key={p.id}>
                  <td className="mono" style={{ fontSize: '.72rem' }}>{new Date(p.due_date).toLocaleDateString()}</td>
                  <td style={{ fontSize: '.78rem' }}>{p.property_name}</td>
                  <td className="mono">{p.unit_number}</td>
                  <td className="mono">{formatCurrency(p.amount)}</td>
                  <td>
                    <span className={`badge ${p.status === 'settled' ? 'badge-green' : p.status === 'pending' ? 'badge-amber' : p.status === 'late' ? 'badge-amber' : 'badge-red'}`}>
                      {p.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Maintenance */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 14 }}><Wrench size={14} style={{ display: 'inline', marginRight: 6 }} />Maintenance History</div>
        {maintenance?.length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>No maintenance requests.</div>
        ) : (
          <table className="data-table">
            <thead><tr><th>Date</th><th>Unit</th><th>Issue</th><th>Priority</th><th>Status</th><th>Cost</th></tr></thead>
            <tbody>
              {maintenance?.map((m: any) => (
                <tr key={m.id}>
                  <td className="mono" style={{ fontSize: '.72rem' }}>{new Date(m.created_at).toLocaleDateString()}</td>
                  <td className="mono">{m.unit_number}</td>
                  <td style={{ fontSize: '.78rem', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</td>
                  <td><span className={`badge ${m.priority === 'emergency' ? 'badge-red' : m.priority === 'high' ? 'badge-amber' : 'badge-blue'}`}>{m.priority}</span></td>
                  <td><span className={`badge ${m.status === 'completed' ? 'badge-green' : m.status === 'open' ? 'badge-amber' : 'badge-blue'}`}>{m.status?.replace('_', ' ')}</span></td>
                  <td className="mono">{m.actual_cost ? formatCurrency(m.actual_cost) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {showTransfer && currentUnit && (
        <TransferTenantModal
          tenantId={id!}
          tenantName={`${tenant.first_name} ${tenant.last_name}`}
          currentUnit={currentUnit}
          onClose={() => setShowTransfer(false)}
        />
      )}
    </div>
  )
}
