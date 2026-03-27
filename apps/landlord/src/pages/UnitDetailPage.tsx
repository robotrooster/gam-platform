import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { formatCurrency, getReservePhase } from '@gam/shared'
import { ArrowLeft, Shield, CheckCircle, AlertTriangle } from 'lucide-react'

export function UnitDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [evictModal, setEvictModal] = useState(false)
  const [evictConfirm, setEvictConfirm] = useState(false)

  const { data: unit, isLoading } = useQuery(['unit', id], () => apiGet<any>('/units/' + id))
  const { data: econ } = useQuery(['unit-econ', id], () => apiGet<any>('/units/' + id + '/economics'))
  const { data: payments = [] } = useQuery(['unit-payments', id], () => apiGet<any[]>('/payments?unitId=' + id))
  const { data: maintenance = [] } = useQuery(['unit-maint', id], () => apiGet<any[]>('/maintenance?unitId=' + id))

  const evictMut = useMutation(
    ({ enable }: { enable: boolean }) => apiPost('/units/' + id + '/eviction-mode', { enable, confirm: true }),
    { onSuccess: () => { qc.invalidateQueries(['unit', id]); qc.invalidateQueries('units'); setEvictModal(false); setEvictConfirm(false) } }
  )

  if (isLoading) return <div style={{ color: 'var(--text-3)', padding: 32 }}>Loading...</div>
  if (!unit) return <div className="empty-state"><h3>Unit not found</h3></div>

  const { phase } = getReservePhase(econ?.occupiedPortfolio || 0)

  return (
    <div>
      <div className="page-header">
        <div className="flex items-center gap-12">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/units')}><ArrowLeft size={15} /></button>
          <div>
            <h1 className="page-title">Unit {unit.unit_number}</h1>
            <p className="page-subtitle">{unit.property_name} - {unit.street1}, {unit.city}</p>
          </div>
        </div>
        <div className="flex gap-8">
          {unit.payment_block && <span className="badge badge-red"><Shield size={10} /> Eviction Mode</span>}
          {unit.on_time_pay_active && <span className="badge badge-green"><CheckCircle size={10} /> On-Time Pay Active</span>}
          <button
            className={'btn btn-sm ' + (unit.payment_block ? 'btn-secondary' : 'btn-danger')}
            onClick={() => { setEvictModal(true); setEvictConfirm(false) }}
          >
            <Shield size={13} /> {unit.payment_block ? 'Deactivate Eviction Mode' : 'Activate Eviction Mode'}
          </button>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-title" style={{ marginBottom: 16 }}>Unit Details</div>
          <div className="data-row"><span className="data-key">Status</span><span className={'badge badge-' + (unit.status === 'active' ? 'green' : unit.status === 'vacant' ? 'muted' : 'amber')}>{unit.status}</span></div>
          <div className="data-row"><span className="data-key">Rent</span><span className="data-val mono">{formatCurrency(unit.rent_amount)}/mo</span></div>
          <div className="data-row"><span className="data-key">Deposit</span><span className="data-val mono">{formatCurrency(unit.security_deposit)}</span></div>
          <div className="data-row"><span className="data-key">Bedrooms</span><span className="data-val">{unit.bedrooms}</span></div>
          <div className="data-row"><span className="data-key">Bathrooms</span><span className="data-val">{unit.bathrooms}</span></div>
        </div>

        <div className="card">
          <div className="card-title" style={{ marginBottom: 16 }}>Tenant</div>
          {unit.tenant_first ? (
            <>
              <div className="data-row"><span className="data-key">Name</span><span className="data-val">{unit.tenant_first} {unit.tenant_last}</span></div>
              <div className="data-row"><span className="data-key">Email</span><span className="data-val">{unit.tenant_email}</span></div>
              <div className="data-row"><span className="data-key">ACH</span><span className={'badge ' + (unit.ach_verified ? 'badge-green' : 'badge-amber')}>{unit.ach_verified ? 'Verified' : 'Pending'}</span></div>
              <div className="data-row"><span className="data-key">SSI/SSDI</span><span className="data-val">{unit.ssi_ssdi ? 'Yes' : 'No'}</span></div>
              <div className="data-row"><span className="data-key">On-Time Pay</span><span className={'badge ' + (unit.on_time_pay_enrolled ? 'badge-green' : 'badge-muted')}>{unit.on_time_pay_enrolled ? 'Enrolled' : 'Not enrolled'}</span></div>
            </>
          ) : (
            <div style={{ color: 'var(--text-3)', fontSize: '.875rem', padding: '16px 0' }}>No tenant assigned.</div>
          )}
        </div>

        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <div className="card-title" style={{ marginBottom: 16 }}>Unit Economics</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom:20 }}>
            <div style={{ background:"var(--bg-2)", border:"1px solid var(--border-0)", borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:".65rem", fontWeight:700, color:"var(--text-3)", textTransform:"uppercase", marginBottom:6 }}>Net Monthly</div>
              <div style={{ fontFamily:"var(--font-mono)", fontSize:".95rem", fontWeight:700, color:"var(--green)" }}>{formatCurrency(unit.rent_amount-(unit.status==="vacant"?0:unit.status==="direct_pay"?5:15))}</div>
            </div>
            <div style={{ background:"var(--bg-2)", border:"1px solid var(--border-0)", borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:".65rem", fontWeight:700, color:"var(--text-3)", textTransform:"uppercase", marginBottom:6 }}>Projected Yearly</div>
              <div style={{ fontFamily:"var(--font-mono)", fontSize:".95rem", fontWeight:700, color:"var(--gold)" }}>{formatCurrency((unit.rent_amount-(unit.status==="vacant"?0:unit.status==="direct_pay"?5:15))*12)}</div>
            </div>
            <div style={{ background:"var(--bg-2)", border:"1px solid var(--border-0)", borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:".65rem", fontWeight:700, color:"var(--text-3)", textTransform:"uppercase", marginBottom:6 }}>Lifetime Net</div>
              <div style={{ fontFamily:"var(--font-mono)", fontSize:".95rem", fontWeight:700, color:"var(--gold)" }}>{econ ? formatCurrency(econ.lifetimeNet) : "—"}</div>
            </div>
            <div style={{ background:"var(--bg-2)", border:"1px solid var(--border-0)", borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:".65rem", fontWeight:700, color:"var(--text-3)", textTransform:"uppercase", marginBottom:6 }}>Tenant Months</div>
              <div style={{ fontFamily:"var(--font-mono)", fontSize:".95rem", fontWeight:700, color:"var(--text-0)" }}>{econ ? econ.tenantMonths+" mo" : "—"}</div>
            </div>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
            <div>
              <div style={{ fontSize:".68rem", fontWeight:700, color:"var(--text-3)", textTransform:"uppercase", letterSpacing:".08em", marginBottom:8 }}>Monthly Breakdown</div>
              <div className="data-row"><span className="data-key">Rent</span><span className="data-val mono">{formatCurrency(unit.rent_amount)}/mo</span></div>
              <div className="data-row"><span className="data-key">Platform fee</span><span className="data-val mono" style={{ color:unit.status==="vacant"?"var(--text-3)":"var(--red)" }}>{unit.status==="vacant"?"Free (vacant)":unit.status==="direct_pay"?"-5.00/mo (direct pay)":"-15.00/mo (on-time pay)"}</span></div>
              <div className="data-row" style={{ borderTop:"1px solid var(--border-1)", paddingTop:8, marginTop:4 }}><span className="data-key" style={{ fontWeight:700 }}>Net monthly</span><span className="data-val mono" style={{ color:"var(--green)", fontWeight:700 }}>{formatCurrency(unit.rent_amount-(unit.status==="vacant"?0:unit.status==="direct_pay"?5:15))}/mo</span></div>
              <div className="data-row"><span className="data-key">Projected yearly</span><span className="data-val mono" style={{ color:"var(--gold)" }}>{formatCurrency((unit.rent_amount-(unit.status==="vacant"?0:unit.status==="direct_pay"?5:15))*12)}</span></div>
            </div>
            <div>
              <div style={{ fontSize:".68rem", fontWeight:700, color:"var(--text-3)", textTransform:"uppercase", letterSpacing:".08em", marginBottom:8 }}>Maintenance Costs</div>
              {(maintenance as any[]).filter((m:any)=>m.actual_cost).length===0
                ? <div style={{ fontSize:".78rem", color:"var(--text-3)" }}>No costs recorded.</div>
                : (maintenance as any[]).filter((m:any)=>m.actual_cost).slice(0,5).map((m:any)=>(
                    <div key={m.id} className="data-row"><span className="data-key" style={{ fontSize:".73rem" }}>{m.title}</span><span className="data-val mono" style={{ color:"var(--red)", fontSize:".73rem" }}>−{formatCurrency(m.actual_cost)}</span></div>
                  ))
              }
              {econ && econ.lifetimeMaintCost > 0 && (<div className="data-row" style={{ borderTop:"1px solid var(--border-1)", paddingTop:8, marginTop:4 }}><span className="data-key" style={{ fontWeight:700 }}>Lifetime total</span><span className="data-val mono" style={{ color:"var(--red)", fontWeight:700 }}>−{formatCurrency(econ.lifetimeMaintCost)}</span></div>)}
            </div>
          </div>
          {econ && econ.tenantMonths > 0 && (
            <div style={{ marginTop:16, padding:"12px 14px", background:"var(--bg-2)", border:"1px solid var(--border-0)", borderRadius:10 }}>
              <div style={{ fontSize:".68rem", fontWeight:700, color:"var(--text-3)", textTransform:"uppercase", letterSpacing:".08em", marginBottom:10 }}>Tenant Lifetime ({econ.tenantMonths} months)</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10 }}>
                <div style={{ textAlign:"center" }}><div style={{ fontSize:".62rem", color:"var(--text-3)", marginBottom:3 }}>Collected</div><div style={{ fontFamily:"var(--font-mono)", fontSize:".82rem", fontWeight:700, color:"var(--text-0)" }}>{formatCurrency(econ.lifetimeCollected)}</div></div>
                <div style={{ textAlign:"center" }}><div style={{ fontSize:".62rem", color:"var(--text-3)", marginBottom:3 }}>Platform Fees</div><div style={{ fontFamily:"var(--font-mono)", fontSize:".82rem", fontWeight:700, color:"var(--red)" }}>{formatCurrency(econ.lifetimePlatformFees)}</div></div>
                <div style={{ textAlign:"center" }}><div style={{ fontSize:".62rem", color:"var(--text-3)", marginBottom:3 }}>Maint. Costs</div><div style={{ fontFamily:"var(--font-mono)", fontSize:".82rem", fontWeight:700, color:"var(--red)" }}>{formatCurrency(econ.lifetimeMaintCost)}</div></div>
                <div style={{ textAlign:"center" }}><div style={{ fontSize:".62rem", color:"var(--text-3)", marginBottom:3 }}>Net to You</div><div style={{ fontFamily:"var(--font-mono)", fontSize:".82rem", fontWeight:700, color:"var(--gold)" }}>{formatCurrency(econ.lifetimeNet)}</div></div>
              </div>
            </div>
          )}
        </div>
      </div>

      {evictModal && (
        <div className="modal-overlay" onClick={() => setEvictModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">{unit.payment_block ? 'Deactivate Eviction Mode' : 'Activate Eviction Mode'} - Unit {unit.unit_number}</div>
            {!unit.payment_block ? (
              <>
                <div className="alert alert-danger">
                  <AlertTriangle size={16} />
                  <div><strong>A.R.S. 33-1371(A)</strong>: Accepting ANY rent waives your right to evict. This hard-blocks all tenant ACH immediately.</div>
                </div>
                <p style={{ fontSize: '.875rem', color: 'var(--text-2)', marginBottom: 20 }}>No rent collected and no disbursement made until deactivated.</p>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 20, cursor: 'pointer' }}>
                  <input type="checkbox" checked={evictConfirm} onChange={e => setEvictConfirm(e.target.checked)} style={{ marginTop: 3 }} />
                  <span style={{ fontSize: '.82rem', color: 'var(--text-1)' }}>I understand. Activate Eviction Mode for Unit {unit.unit_number}.</span>
                </label>
                <div className="modal-footer">
                  <button className="btn btn-ghost" onClick={() => setEvictModal(false)}>Cancel</button>
                  <button className="btn btn-danger" disabled={!evictConfirm || evictMut.isLoading} onClick={() => evictMut.mutate({ enable: true })}>
                    {evictMut.isLoading ? <span className="spinner" /> : 'Activate'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p style={{ fontSize: '.875rem', color: 'var(--text-2)', marginBottom: 20 }}>This will resume ACH rent collection. Only deactivate if eviction is resolved.</p>
                <div className="modal-footer">
                  <button className="btn btn-ghost" onClick={() => setEvictModal(false)}>Cancel</button>
                  <button className="btn btn-secondary" disabled={evictMut.isLoading} onClick={() => evictMut.mutate({ enable: false })}>
                    {evictMut.isLoading ? <span className="spinner" /> : 'Deactivate'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
