import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api'
import { ArrowLeft, DoorOpen, Building2, CreditCard, Wrench, TrendingUp, Clock, CheckCircle, XCircle } from 'lucide-react'
import { TransferTenantModal } from './TransferTenantModal'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

function FlexChargePanel({ tenantId, tenantName, chargeAccount, refetch, creditLimit, setCreditLimit, limitSaved, setLimitSaved, qc }: any) {
  const enableMut = useMutation(
    () => apiPost('/landlords/flexcharge', { tenantId, creditLimit: creditLimit ? parseFloat(creditLimit) : null }),
    { onSuccess: () => { refetch(); qc.invalidateQueries(['flexcharge', tenantId]) } }
  )
  const disableMut = useMutation(
    () => apiDelete('/landlords/flexcharge/' + tenantId),
    { onSuccess: () => { refetch(); qc.invalidateQueries(['flexcharge', tenantId]) } }
  )
  const updateLimitMut = useMutation(
    () => apiPatch('/landlords/flexcharge/' + tenantId, { creditLimit: creditLimit ? parseFloat(creditLimit) : null }),
    { onSuccess: () => { refetch(); setLimitSaved(true); setTimeout(() => setLimitSaved(false), 2000) } }
  )
  const isActive = chargeAccount?.status === 'active'
  const isDisqualified = chargeAccount?.status === 'disqualified'
  const txns = chargeAccount?.transactions || []
  return (
    <div>
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 700, color: 'var(--text-0)', marginBottom: 4 }}>FlexCharge Account</div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
              {!chargeAccount ? 'Not enabled for this tenant'
                : isDisqualified ? 'Disqualified — tenant disputed a charge'
                : isActive ? 'Active — tenant appears in POS charge list'
                : 'Suspended'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {!chargeAccount || !isActive ? (
              <button className="btn btn-primary" disabled={enableMut.isLoading} onClick={() => enableMut.mutate()}>
                {enableMut.isLoading ? <span className="spinner" /> : '+ Enable FlexCharge'}
              </button>
            ) : (
              <button className="btn btn-danger" disabled={disableMut.isLoading}
                onClick={() => { if (confirm('Suspend FlexCharge for ' + tenantName + '?')) disableMut.mutate() }}>
                {disableMut.isLoading ? <span className="spinner" /> : 'Suspend'}
              </button>
            )}
          </div>
        </div>
        {chargeAccount && (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="form-label">Credit Limit (blank = no limit)</label>
              <input className="form-input" type="number" min={0} step={10}
                value={creditLimit} onChange={e => setCreditLimit(e.target.value)}
                placeholder="e.g. 500" style={{ maxWidth: 160 }} />
            </div>
            <button className="btn btn-secondary" disabled={updateLimitMut.isLoading} onClick={() => updateLimitMut.mutate()}>
              {limitSaved ? 'Saved' : 'Update Limit'}
            </button>
          </div>
        )}
      </div>
      {chargeAccount && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-0)' }}>
            <div style={{ fontWeight: 700, color: 'var(--text-0)' }}>Transaction History</div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.2rem', fontWeight: 800, color: 'var(--gold)' }}>
                ${parseFloat(chargeAccount.current_balance || 0).toFixed(2)}
              </div>
              <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>Current balance</div>
            </div>
          </div>
          {txns.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)', fontSize: '.82rem' }}>No charges yet.</div>
          ) : (
            <table className="data-table">
              <thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {txns.map((tx: any) => (
                  <tr key={tx.id}>
                    <td className="mono" style={{ fontSize: '.75rem' }}>{new Date(tx.created_at).toLocaleDateString()}</td>
                    <td style={{ color: 'var(--text-0)' }}>{tx.description}</td>
                    <td className="mono" style={{ fontWeight: 600 }}>${parseFloat(tx.amount).toFixed(2)}</td>
                    <td><span className={`badge ${tx.status === 'pulled' ? 'badge-green' : tx.status === 'disputed' ? 'badge-red' : 'badge-amber'}`}>{tx.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

export function TenantDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [showTransfer, setShowTransfer] = useState(false)
  const [tab, setTab] = useState('overview')
  const [creditLimit, setCreditLimit] = useState('')
  const [limitSaved, setLimitSaved] = useState(false)
  const qc = useQueryClient()
  const { data: chargeAccount, refetch: refetchCharge } = useQuery(
    ['flexcharge', id],
    () => apiGet<any[]>('/landlords/flexcharge').then((accounts: any[]) =>
      accounts.find((a: any) => a.tenant_id === id) || null
    ),
    { enabled: tab === 'flexcharge' }
  )
  const { data, isLoading } = useQuery(['tenant-profile', id], () => apiGet<any>(`/tenants/${id}/profile`))
  if (isLoading) return <div style={{ color: 'var(--text-3)', padding: 32 }}>Loading...</div>
  if (!data) return <div className="empty-state"><h3>Tenant not found</h3></div>
  const { tenant, units, payments, maintenance, workTrade, stats } = data
  const currentUnit = units?.find((u: any) => u.is_current)
  const onTimeColor = stats.onTimeRate >= 90 ? 'var(--green)' : stats.onTimeRate >= 75 ? 'var(--amber)' : 'var(--red)'
  const onTimeLabel = stats.onTimeRate >= 90 ? 'Excellent' : stats.onTimeRate >= 75 ? 'Good' : 'Needs Attention'
  return (
    <div>
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
                {currentUnit ? `Unit ${currentUnit.unit_number} - ${currentUnit.property_name}` : 'No current unit'}
                {tenant.ssi_ssdi && <span className="badge badge-gold" style={{ marginLeft: 8 }}>SSI/SSDI</span>}
                {tenant.on_time_pay_enrolled && <span className="badge badge-green" style={{ marginLeft: 6 }}>On-Time Pay</span>}
              </p>
            </div>
          </div>
        </div>
        {currentUnit && <button className="btn btn-primary" onClick={() => setShowTransfer(true)}>Transfer Unit</button>}
      </div>

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-0)', marginBottom: 24 }}>
        {[{ id: 'overview', label: 'Overview' }, { id: 'flexcharge', label: 'FlexCharge' }].map((t: any) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding: '8px 16px', border: 'none', background: 'none', cursor: 'pointer', fontSize: '.82rem', fontWeight: 600, color: tab === t.id ? 'var(--gold)' : 'var(--text-3)', borderBottom: tab === t.id ? '2px solid var(--gold)' : '2px solid transparent', marginBottom: -1 }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'flexcharge' && (
        <FlexChargePanel tenantId={id!} tenantName={tenant.first_name + ' ' + tenant.last_name}
          chargeAccount={chargeAccount} refetch={refetchCharge}
          creditLimit={creditLimit} setCreditLimit={setCreditLimit}
          limitSaved={limitSaved} setLimitSaved={setLimitSaved} qc={qc} />
      )}

      {tab === 'overview' && (
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
                { label: 'ACH Verified', val: tenant.ach_verified ? 'Verified' : 'Pending', color: tenant.ach_verified ? 'var(--green)' : 'var(--amber)' },
                { label: 'Credit Reporting', val: tenant.credit_reporting_enrolled ? 'Active' : '--' },
                { label: 'Member Since', val: new Date(tenant.account_created).toLocaleDateString() },
              ].map(row => (
                <div key={row.label} className="data-row">
                  <span className="data-key">{row.label}</span>
                  <span className="data-val" style={{ color: (row as any).color }}>{row.val}</span>
                </div>
              ))}
            </div>
            <div className="card">
              <div className="card-title" style={{ marginBottom: 14 }}>Payment Health</div>
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
                <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, background: 'var(--bg-2)', border: '1px solid ' + (u.is_current ? 'rgba(201,162,39,.3)' : 'var(--border-0)') }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--text-0)' }}>Unit {u.unit_number}</span>
                      {u.is_current && <span className="badge badge-green">Current</span>}
                    </div>
                    <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 1 }}>{u.property_name} - {u.street1}, {u.city}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.82rem', color: 'var(--gold)', fontWeight: 600 }}>{fmt(u.rent_amount)}/mo</div>
                    {u.start_date && <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginTop: 1 }}>{new Date(u.start_date).toLocaleDateString()} - {u.end_date ? new Date(u.end_date).toLocaleDateString() : 'Present'}</div>}
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
                      <td className="mono" style={{ fontSize: '.72rem' }}>{new Date(p.due_date).toLocaleDateString()}</td>
                      <td style={{ fontSize: '.78rem' }}>{p.property_name}</td>
                      <td className="mono">{p.unit_number}</td>
                      <td className="mono">{fmt(p.amount)}</td>
                      <td><span className={`badge ${p.status === 'settled' ? 'badge-green' : p.status === 'failed' ? 'badge-red' : 'badge-amber'}`}>{p.status}</span></td>
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
                      <td className="mono" style={{ fontSize: '.72rem' }}>{new Date(m.created_at).toLocaleDateString()}</td>
                      <td className="mono">{m.unit_number}</td>
                      <td style={{ fontSize: '.78rem' }}>{m.title}</td>
                      <td><span className={`badge ${m.priority === 'emergency' ? 'badge-red' : m.priority === 'high' ? 'badge-amber' : 'badge-blue'}`}>{m.priority}</span></td>
                      <td><span className={`badge ${m.status === 'completed' ? 'badge-green' : 'badge-amber'}`}>{m.status?.replace('_', ' ')}</span></td>
                      <td className="mono">{m.actual_cost ? fmt(m.actual_cost) : '--'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {showTransfer && currentUnit && (
        <TransferTenantModal
          tenantId={id!}
          tenantName={tenant.first_name + ' ' + tenant.last_name}
          currentUnit={currentUnit}
          onClose={() => setShowTransfer(false)}
        />
      )}
    </div>
  )
}
