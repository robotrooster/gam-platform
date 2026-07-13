import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from 'react-query'
import { humanize } from '@gam/shared'
import { apiGet } from '../lib/api'
import { ArrowLeft } from 'lucide-react'
import { TransferTenantModal } from './TransferTenantModal'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

// S252: legacy per-tenant FlexChargePanel removed. The new schema
// scopes FlexCharge accounts per (customer, property); a tenant can
// hold separate tabs at different properties, so a tenant-detail
// view isn't the right surface anymore. Dedicated landlord
// FlexCharge dashboard lands in S254.

export function TenantDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [showTransfer, setShowTransfer] = useState(false)
  const [showPaymentDetail, setShowPaymentDetail] = useState(false)
  // S252: per-tenant FlexCharge query removed alongside the legacy
  // panel. New flex_charge_accounts schema is (customer, property)
  // keyed; consult the FlexCharge dashboard (S254) for per-property
  // account management.
  const { data, isLoading } = useQuery(['tenant-profile', id], () => apiGet<any>(`/tenants/${id}/profile`))
  if (isLoading) return <div style={{ color: 'var(--text-3)', padding: 32 }}>Loading...</div>
  if (!data) return <div className="empty-state"><h3>Tenant not found</h3></div>
  const { tenant, units, payments, maintenance, stats } = data
  const currentUnit = units?.find((u: any) => u.isCurrent)
  const onTimeColor = stats.onTimeRate >= 90 ? 'var(--green)' : stats.onTimeRate >= 75 ? 'var(--amber)' : 'var(--red)'
  const onTimeLabel = stats.onTimeRate >= 90 ? 'Excellent' : stats.onTimeRate >= 75 ? 'Good' : 'Needs Attention'
  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/tenants')}><ArrowLeft size={15} /></button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'linear-gradient(135deg, var(--gold-dark), var(--gold))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 800, color: 'var(--bg-0)', flexShrink: 0 }}>
              {tenant.firstName?.[0]}{tenant.lastName?.[0]}
            </div>
            <div>
              <h1 className="page-title" style={{ marginBottom: 2 }}>{tenant.firstName} {tenant.lastName}</h1>
              <p className="page-subtitle">
                {currentUnit ? `Unit ${currentUnit.unitNumber} - ${currentUnit.propertyName}` : 'No current unit'}
                {tenant.ssiSsdi && <span className="badge badge-gold" style={{ marginLeft: 8 }}>SSI/SSDI</span>}
              </p>
            </div>
          </div>
        </div>
        {currentUnit && <button className="btn btn-primary" onClick={() => setShowTransfer(true)}>Transfer Unit</button>}
      </div>

      {(
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 12, marginBottom: 24 }}>
            {[
              { label: 'Tenant Since', val: stats.firstPayment ? new Date(stats.firstPayment).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '--', color: 'var(--text-0)' },
              { label: 'Months as Tenant', val: stats.tenantMonths + ' mo', color: 'var(--text-0)' },
              { label: 'Total Paid', val: fmt(stats.totalPaid), color: 'var(--gold)' },
              { label: 'On-Time Rate', val: stats.onTimeRate + '%', color: onTimeColor, sub: onTimeLabel },
              { label: 'Units Occupied', val: stats.unitsOccupied, color: 'var(--text-0)' },
            ].map(s => (
              <div key={s.label} className="card" style={{ padding: '14px 16px' }}>
                <div style={{ fontSize: '.65rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>{s.label}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1rem', fontWeight: 700, color: s.color }}>{s.val}</div>
                {(s as any).sub && <div style={{ fontSize: '.65rem', color: s.color, marginTop: 2 }}>{(s as any).sub}</div>}
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div className="card">
              <div className="card-title" style={{ marginBottom: 14 }}>Contact</div>
              {[
                { label: 'Email', val: tenant.email },
                { label: 'Phone', val: tenant.phone || '--' },
                { label: 'ACH Verified', val: tenant.achVerified ? 'Verified' : 'Pending', color: tenant.achVerified ? 'var(--green)' : 'var(--amber)' },
                { label: 'Member Since', val: new Date(tenant.accountCreated).toLocaleDateString() },
              ].map(row => (
                <div key={row.label} className="data-row">
                  <span className="data-key">{row.label}</span>
                  <span className="data-val" style={{ color: (row as any).color }}>{row.val}</span>
                </div>
              ))}
            </div>
            {/* W-25 (S531): the health card drills into per-payment lateness —
                aggregate health hides whether "late" meant 2 days or 3 weeks. */}
            <div className="card" style={{ cursor: 'pointer' }} onClick={() => setShowPaymentDetail(true)} title="See how late each payment actually was">
              <div className="card-title" style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span>Payment Health</span>
                <span style={{ fontSize: '.68rem', color: 'var(--gold)', fontWeight: 600 }}>View detail →</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
                <div style={{ width: 56, height: 56, borderRadius: '50%', background: onTimeColor + '18', border: '3px solid ' + onTimeColor, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '.9rem', fontWeight: 800, color: onTimeColor }}>{stats.onTimeRate}%</span>
                </div>
                <div>
                  <div style={{ fontSize: '.85rem', fontWeight: 700, color: onTimeColor }}>{onTimeLabel}</div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>On-time payment rate</div>
                </div>
              </div>
              {[
                { label: 'Settled', val: stats.settledCount },
                { label: 'Late', val: stats.lateCount },
                { label: 'Failed', val: stats.failedCount },
                { label: 'Avg Payment', val: fmt(stats.avgPayment) },
              ].map(row => (
                <div key={row.label} className="data-row">
                  <span className="data-key">{row.label}</span>
                  <span className="data-val mono">{row.val}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title" style={{ marginBottom: 14 }}>Unit History</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {units?.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>No unit history.</div>}
              {units?.map((u: any) => (
                <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, background: 'var(--bg-2)', border: '1px solid ' + (u.isCurrent ? 'rgba(201,162,39,.3)' : 'var(--border-0)') }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--text-0)' }}>Unit {u.unitNumber}</span>
                      {u.isCurrent && <span className="badge badge-green">Current</span>}
                    </div>
                    <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 1 }}>{u.propertyName} - {u.street1}, {u.city}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.82rem', color: 'var(--gold)', fontWeight: 600 }}>{fmt(u.rentAmount)}/mo</div>
                    {u.startDate && <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginTop: 1 }}>{new Date(u.startDate).toLocaleDateString()} - {u.endDate ? new Date(u.endDate).toLocaleDateString() : 'Present'}</div>}
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={() => navigate('/units/' + u.id)}>View</button>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title" style={{ marginBottom: 14 }}>Payment History</div>
            {payments?.length === 0 ? (
              <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>No payments yet.</div>
            ) : (
              <table className="data-table">
                <thead><tr><th>Date</th><th>Property</th><th>Unit</th><th>Amount</th><th>Status</th></tr></thead>
                <tbody>
                  {payments?.map((p: any) => (
                    <tr key={p.id}>
                      <td className="mono" style={{ fontSize: '.72rem' }}>{new Date(p.dueDate).toLocaleDateString()}</td>
                      <td style={{ fontSize: '.78rem' }}>{p.propertyName}</td>
                      <td className="mono">{p.unitNumber}</td>
                      <td className="mono">{fmt(p.amount)}</td>
                      <td><span className={`badge ${p.status === 'settled' ? 'badge-green' : p.status === 'failed' ? 'badge-red' : 'badge-amber'}`}>{humanize(p.status)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 14 }}>Maintenance History</div>
            {maintenance?.length === 0 ? (
              <div style={{ color: 'var(--text-3)', fontSize: '.82rem' }}>No maintenance requests.</div>
            ) : (
              <table className="data-table">
                <thead><tr><th>Date</th><th>Unit</th><th>Issue</th><th>Priority</th><th>Status</th><th>Cost</th></tr></thead>
                <tbody>
                  {maintenance?.map((m: any) => (
                    <tr key={m.id}>
                      <td className="mono" style={{ fontSize: '.72rem' }}>{new Date(m.createdAt).toLocaleDateString()}</td>
                      <td className="mono">{m.unitNumber}</td>
                      <td style={{ fontSize: '.78rem' }}>{m.title}</td>
                      <td><span className={`badge ${m.priority === 'emergency' ? 'badge-red' : m.priority === 'high' ? 'badge-amber' : 'badge-blue'}`}>{humanize(m.priority)}</span></td>
                      <td><span className={`badge ${m.status === 'completed' ? 'badge-green' : 'badge-amber'}`}>{humanize(m.status)}</span></td>
                      <td className="mono">{m.actualCost ? fmt(m.actualCost) : '--'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {showPaymentDetail && (
        <PaymentTimelinessModal payments={payments || []} tenantName={`${tenant.firstName} ${tenant.lastName}`} onClose={() => setShowPaymentDetail(false)} />
      )}
      {showTransfer && currentUnit && (
        <TransferTenantModal
          tenantId={id!}
          tenantName={tenant.firstName + ' ' + tenant.lastName}
          currentUnit={currentUnit}
          onClose={() => setShowTransfer(false)}
        />
      )}
    </div>
  )
}

// W-25 (S531): per-payment timeliness drill-in. Days late = settled_at vs
// due_date (day-sliced per the date-serialization rule); unpaid past-due rows
// show days overdue against today.
function PaymentTimelinessModal({ payments, tenantName, onClose }: { payments: any[]; tenantName: string; onClose: () => void }) {
  const day = (d: any) => (d ? String(d).slice(0, 10) : null)
  const daysBetween = (a: string, b: string) =>
    Math.round((new Date(b + 'T12:00:00').getTime() - new Date(a + 'T12:00:00').getTime()) / 86400000)
  const today = (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}` })()

  const rows = payments.map((p: any) => {
    const due = day(p.dueDate)
    const settled = day(p.settledAt)
    let late = 0; let label = ''; let cls = 'badge-muted'
    if (p.status === 'settled' && due && settled) {
      late = Math.max(0, daysBetween(due, settled))
      if (late === 0) { label = 'On time'; cls = 'badge-green' }
      else { label = `${late} day${late === 1 ? '' : 's'} late`; cls = late <= 7 ? 'badge-amber' : 'badge-red' }
    } else if (p.status === 'failed') {
      label = 'Failed'; cls = 'badge-red'
    } else if (due && due < today) {
      late = daysBetween(due, today)
      label = `${late} day${late === 1 ? '' : 's'} overdue`; cls = 'badge-red'
    } else {
      label = p.status; cls = 'badge-amber'
    }
    return { ...p, due, settled, late, label, cls }
  })
  const settledRows = rows.filter(r => r.status === 'settled' && r.due && r.settled)
  const onTime = settledRows.filter(r => r.late === 0).length
  const worst = settledRows.reduce((m, r) => Math.max(m, r.late), 0)
  const avgLate = (() => {
    const lateOnes = settledRows.filter(r => r.late > 0)
    if (!lateOnes.length) return 0
    return Math.round(lateOnes.reduce((s2, r) => s2 + r.late, 0) / lateOnes.length)
  })()

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Payment Timeliness — {tenantName}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 14 }}>
          {[
            { label: 'Paid on time', val: `${onTime} of ${settledRows.length}`, color: 'var(--green)' },
            { label: 'Avg days late (when late)', val: avgLate ? `${avgLate}d` : '—', color: avgLate > 7 ? 'var(--red)' : 'var(--amber)' },
            { label: 'Worst', val: worst ? `${worst}d late` : '—', color: worst > 7 ? 'var(--red)' : worst ? 'var(--amber)' : 'var(--text-3)' },
          ].map(k => (
            <div key={k.label} style={{ background: 'var(--bg-3)', borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ fontSize: '.62rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{k.label}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.95rem', fontWeight: 700, color: k.color }}>{k.val}</div>
            </div>
          ))}
        </div>
        <div style={{ maxHeight: 380, overflowY: 'auto' }}>
          <table className="data-table">
            <thead><tr><th>Due</th><th>Paid</th><th>Amount</th><th>Type</th><th>Timeliness</th></tr></thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: '.72rem' }}>{r.due ? new Date(r.due + 'T12:00:00').toLocaleDateString() : '—'}</td>
                  <td className="mono" style={{ fontSize: '.72rem' }}>{r.settled ? new Date(r.settled + 'T12:00:00').toLocaleDateString() : '—'}</td>
                  <td className="mono">{r.amount != null ? `$${Number(r.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}</td>
                  <td style={{ fontSize: '.72rem', textTransform: 'uppercase', color: 'var(--text-3)' }}>{humanize(r.type)}</td>
                  <td><span className={`badge ${r.cls}`}>{r.label}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
