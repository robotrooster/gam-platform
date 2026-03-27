import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { formatCurrency } from '@gam/shared'
import {
  Clock, Check, X, Plus, AlertTriangle, ChevronDown, ChevronUp,
  DollarSign, Calendar, Wrench, Users, ArrowRight, Flag
} from 'lucide-react'

const TRADE_TYPE_LABELS: Record<string, { label: string; color: string; desc: string }> = {
  full:    { label: 'Full Trade',    color: 'var(--green)',  desc: 'Zero cash rent — all labor' },
  partial: { label: 'Partial Trade', color: 'var(--gold)',   desc: 'Reduced cash + labor credit' },
  credit:  { label: 'Credit Model',  color: 'var(--blue)',   desc: 'Earns credits toward future rent' },
}

export function WorkTradePage() {
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showLogs, setShowLogs] = useState<string | null>(null)

  const { data: agreements = [], isLoading } = useQuery<any[]>(
    'work-trade', () => apiGet('/work-trade')
  )
  const { data: units = [] } = useQuery<any[]>('units', () => apiGet('/units'))
  const vacantOrActiveUnits = (units as any[]).filter(u => u.tenant_id)

  const approveMut = useMutation(
    ({ logId, action, rejectionReason }: any) =>
      apiPatch(`/work-trade/logs/${logId}`, { action, rejectionReason }),
    { onSuccess: () => { qc.invalidateQueries('work-trade'); qc.invalidateQueries(`wt-detail-${showLogs}`) } }
  )

  const reconcileMut = useMutation(
    ({ id, month, year }: any) => apiPost(`/work-trade/${id}/reconcile`, { month, year }),
    { onSuccess: () => qc.invalidateQueries('work-trade') }
  )

  const updateMut = useMutation(
    ({ id, ...data }: any) => apiPatch(`/work-trade/${id}`, data),
    { onSuccess: () => qc.invalidateQueries('work-trade') }
  )

  // Pending approvals across all agreements
  const totalPending = (agreements as any[]).reduce((s, a) => s + parseInt(a.pending_count || 0), 0)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Work Trade</h1>
          <p className="page-subtitle">
            {(agreements as any[]).length} agreement{(agreements as any[]).length !== 1 ? 's' : ''}
            {totalPending > 0 && <span style={{ color: 'var(--amber)', marginLeft: 8 }}>· {totalPending} pending approval{totalPending !== 1 ? 's' : ''}</span>}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={15} /> New Agreement
        </button>
      </div>

      {/* 1099 flag banner */}
      {(agreements as any[]).some(a => a.flag_1099) && (
        <div style={{ background: 'rgba(255,184,32,.06)', border: '1px solid rgba(255,184,32,.2)', borderRadius: 10, padding: '10px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Flag size={15} style={{ color: 'var(--amber)', flexShrink: 0 }} />
          <div style={{ fontSize: '.78rem', color: 'var(--amber)' }}>
            <strong>1099-NEC Required:</strong> One or more work trade agreements have exceeded $600 in value this year. Consult your tax advisor and file 1099-NEC forms for affected tenants.
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>
      ) : (agreements as any[]).length === 0 ? (
        <div className="empty-state">
          <Wrench size={48} />
          <h3>No work trade agreements</h3>
          <p>Document labor-for-rent arrangements for campground hosts, caretakers, and other work trade tenants.</p>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}><Plus size={14} /> New Agreement</button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {(agreements as any[]).map((a: any) => {
            const typeInfo = TRADE_TYPE_LABELS[a.trade_type]
            const isExpanded = expanded === a.id
            const now = new Date()
            const monthlyHours = parseFloat(a.weekly_hours) * (52 / 12)

            return (
              <div key={a.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>

                {/* Header row */}
                <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }} onClick={() => setExpanded(isExpanded ? null : a.id)}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: `${typeInfo?.color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Wrench size={16} style={{ color: typeInfo?.color }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '.88rem', fontWeight: 700, color: 'var(--text-0)' }}>{a.tenant_first} {a.tenant_last}</span>
                      <span style={{ fontSize: '.65rem', padding: '2px 8px', borderRadius: 10, background: `${typeInfo?.color}18`, border: `1px solid ${typeInfo?.color}40`, color: typeInfo?.color, fontWeight: 700 }}>{typeInfo?.label}</span>
                      {a.flag_1099 && <span style={{ fontSize: '.62rem', padding: '2px 6px', borderRadius: 10, background: 'rgba(255,184,32,.1)', border: '1px solid rgba(255,184,32,.3)', color: 'var(--amber)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 3 }}><Flag size={9} /> 1099</span>}
                      {parseInt(a.pending_count) > 0 && <span style={{ fontSize: '.62rem', padding: '2px 6px', borderRadius: 10, background: 'rgba(255,71,87,.1)', border: '1px solid rgba(255,71,87,.3)', color: 'var(--red)', fontWeight: 700 }}>{a.pending_count} pending</span>}
                    </div>
                    <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
                      Unit {a.unit_number} · {a.property_name} · {a.weekly_hours}hrs/wk @ {formatCurrency(a.hourly_rate)}/hr
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.85rem', color: a.cash_rent > 0 ? 'var(--gold)' : 'var(--green)', fontWeight: 700 }}>
                      {a.cash_rent > 0 ? formatCurrency(a.cash_rent) : '$0.00'}
                    </div>
                    <div style={{ fontSize: '.65rem', color: 'var(--text-3)' }}>/month cash</div>
                  </div>
                  {isExpanded ? <ChevronUp size={16} style={{ color: 'var(--text-3)' }} /> : <ChevronDown size={16} style={{ color: 'var(--text-3)' }} />}
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div style={{ borderTop: '1px solid var(--border-0)', padding: 16 }}>

                    {/* Stats row */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 16 }}>
                      {[
                        { label: 'Market Rent', val: formatCurrency(a.market_rent), color: 'var(--text-0)' },
                        { label: 'Monthly Hours', val: `${monthlyHours.toFixed(1)} hrs`, color: 'var(--text-0)' },
                        { label: 'Max Credit/Mo', val: formatCurrency(parseFloat(a.hourly_rate) * monthlyHours), color: 'var(--green)' },
                        { label: 'YTD Value', val: formatCurrency(a.ytd_value || 0), color: a.flag_1099 ? 'var(--amber)' : 'var(--text-0)' },
                      ].map(s => (
                        <div key={s.label} style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 8, padding: '10px 12px' }}>
                          <div style={{ fontSize: '.65rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 4 }}>{s.label}</div>
                          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.88rem', fontWeight: 700, color: s.color }}>{s.val}</div>
                        </div>
                      ))}
                    </div>

                    {/* Duties */}
                    {a.duties && (
                      <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
                        <div style={{ fontSize: '.65rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 5 }}>Duties</div>
                        <div style={{ fontSize: '.78rem', color: 'var(--text-1)', lineHeight: 1.6 }}>{a.duties}</div>
                      </div>
                    )}

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setShowLogs(a.id)}>
                        <Clock size={13} /> View Logs & Approve
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => reconcileMut.mutate({ id: a.id, month: now.getMonth() + 1, year: now.getFullYear() })}>
                        <Calendar size={13} /> Reconcile This Month
                      </button>
                      {a.status === 'active'
                        ? <button className="btn btn-ghost btn-sm" style={{ color: 'var(--amber)' }} onClick={() => updateMut.mutate({ id: a.id, status: 'paused' })}>Pause</button>
                        : <button className="btn btn-ghost btn-sm" style={{ color: 'var(--green)' }} onClick={() => updateMut.mutate({ id: a.id, status: 'active' })}>Resume</button>
                      }
                      <button className="btn btn-danger btn-sm" onClick={() => { if (confirm('End this work trade agreement?')) updateMut.mutate({ id: a.id, status: 'ended' }) }}>
                        End Agreement
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Logs / Approval modal */}
      {showLogs && <LogsModal agreementId={showLogs} onClose={() => setShowLogs(null)} onApprove={(logId, action, reason) => approveMut.mutate({ logId, action, rejectionReason: reason })} />}

      {/* Create agreement modal */}
      {showCreate && <CreateAgreementModal units={vacantOrActiveUnits} onClose={() => setShowCreate(false)} onCreate={() => { qc.invalidateQueries('work-trade'); setShowCreate(false) }} />}
    </div>
  )
}

// ── LOGS MODAL ────────────────────────────────────────────────

function LogsModal({ agreementId, onClose, onApprove }: { agreementId: string; onClose: () => void; onApprove: (id: string, action: string, reason?: string) => void }) {
  const { data, isLoading } = useQuery(
    `wt-detail-${agreementId}`,
    () => apiGet(`/work-trade/${agreementId}`)
  )
  const [rejectId, setRejectId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const detail = data as any
  const logs = detail?.logs || []
  const pending = logs.filter((l: any) => l.status === 'pending')
  const reviewed = logs.filter((l: any) => l.status !== 'pending')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 580, width: '95vw' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>Hours Log & Approvals</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>

        {isLoading ? <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-3)' }}>Loading…</div> : (
          <>
            {/* Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 16 }}>
              {[
                { label: 'This Month', val: `${detail?.stats?.hoursThisPeriod?.toFixed(1) || '0.0'} hrs` },
                { label: 'Committed', val: `${detail?.stats?.hoursCommitted?.toFixed(1) || '0.0'} hrs` },
                { label: 'Pending Review', val: `${detail?.stats?.pendingCount || 0}` },
              ].map(s => (
                <div key={s.label} style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                  <div style={{ fontSize: '.65rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 4 }}>{s.label}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.9rem', fontWeight: 700, color: 'var(--text-0)' }}>{s.val}</div>
                </div>
              ))}
            </div>

            {/* Pending logs */}
            {pending.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--amber)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 8 }}>Pending Approval ({pending.length})</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {pending.map((log: any) => (
                    <div key={log.id} style={{ background: 'var(--bg-2)', border: '1px solid rgba(255,184,32,.2)', borderRadius: 10, padding: 12 }}>
                      {rejectId === log.id ? (
                        <div>
                          <div style={{ fontSize: '.78rem', color: 'var(--text-1)', marginBottom: 8 }}>Reason for rejection:</div>
                          <input className="input" style={{ width: '100%', marginBottom: 8 }} placeholder="Explain why…" value={rejectReason} onChange={e => setRejectReason(e.target.value)} autoFocus />
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button className="btn btn-ghost btn-sm" onClick={() => { setRejectId(null); setRejectReason('') }}>Cancel</button>
                            <button className="btn btn-danger btn-sm" onClick={() => { onApprove(log.id, 'reject', rejectReason); setRejectId(null); setRejectReason('') }}>Confirm Reject</button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '.82rem', fontWeight: 700, color: 'var(--gold)' }}>{log.hours}h</span>
                              <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{new Date(log.work_date).toLocaleDateString()}</span>
                            </div>
                            <div style={{ fontSize: '.78rem', color: 'var(--text-1)' }}>{log.description}</div>
                            <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 2 }}>Submitted by {log.first_name} {log.last_name}</div>
                          </div>
                          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                            <button className="btn btn-sm" style={{ background: 'rgba(30,219,122,.1)', border: '1px solid rgba(30,219,122,.3)', color: 'var(--green)' }} onClick={() => onApprove(log.id, 'approve')}>
                              <Check size={13} /> Approve
                            </button>
                            <button className="btn btn-sm" style={{ background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', color: 'var(--red)' }} onClick={() => setRejectId(log.id)}>
                              <X size={13} /> Reject
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Reviewed logs */}
            {reviewed.length > 0 && (
              <div>
                <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 8 }}>History</div>
                <div className="card" style={{ padding: 0 }}>
                  <table className="data-table">
                    <thead><tr><th>Date</th><th>Hours</th><th>Description</th><th>Value</th><th>Status</th></tr></thead>
                    <tbody>
                      {reviewed.map((log: any) => (
                        <tr key={log.id}>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: '.72rem' }}>{new Date(log.work_date).toLocaleDateString()}</td>
                          <td className="mono">{log.hours}h</td>
                          <td style={{ fontSize: '.78rem', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.description}</td>
                          <td className="mono">{log.credit_value ? formatCurrency(log.credit_value) : '—'}</td>
                          <td>
                            <span className={`badge ${log.status === 'approved' ? 'badge-green' : 'badge-danger'}`}>
                              {log.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {logs.length === 0 && (
              <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-3)', fontSize: '.82rem' }}>
                No hours logged yet. Tenant submits hours from their portal.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── CREATE AGREEMENT MODAL ────────────────────────────────────

function CreateAgreementModal({ units, onClose, onCreate }: { units: any[]; onClose: () => void; onCreate: () => void }) {
  const qc = useQueryClient()
  const [form, setForm] = useState({
    unitId: '', tenantId: '', tradeType: 'partial', hourlyRate: '', weeklyHours: '',
    marketRent: '', cashRent: '', duties: '', startDate: new Date().toISOString().split('T')[0], endDate: '', renewalTerms: '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})

  const selectedUnit = units.find(u => u.id === form.unitId)
  const monthlyHours = form.weeklyHours ? parseFloat(form.weeklyHours) * (52 / 12) : 0
  const maxCredit = monthlyHours && form.hourlyRate ? monthlyHours * parseFloat(form.hourlyRate) : 0
  const cashBalance = form.marketRent && form.cashRent ? parseFloat(form.marketRent) - parseFloat(form.cashRent) : 0

  const createMut = useMutation(
    (data: any) => apiPost('/work-trade', data),
    { onSuccess: () => { onCreate() } }
  )

  const set = (k: string, v: string) => { setForm(f => ({ ...f, [k]: v })); setErrors(e => ({ ...e, [k]: '' })) }

  const submit = () => {
    const errs: Record<string, string> = {}
    if (!form.unitId) errs.unitId = 'Select a unit'
    if (!form.hourlyRate) errs.hourlyRate = 'Required'
    if (!form.weeklyHours) errs.weeklyHours = 'Required'
    if (!form.marketRent) errs.marketRent = 'Required'
    if (!form.startDate) errs.startDate = 'Required'
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    createMut.mutate({
      unitId:       form.unitId,
      tenantId:     selectedUnit?.tenant_id,
      tradeType:    form.tradeType,
      hourlyRate:   parseFloat(form.hourlyRate),
      weeklyHours:  parseFloat(form.weeklyHours),
      marketRent:   parseFloat(form.marketRent),
      cashRent:     form.tradeType === 'full' ? 0 : parseFloat(form.cashRent) || 0,
      duties:       form.duties,
      startDate:    form.startDate,
      endDate:      form.endDate || undefined,
      renewalTerms: form.renewalTerms || undefined,
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560, width: '95vw', maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>New Work Trade Agreement</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>

        {/* Trade type */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Agreement Type</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
            {Object.entries(TRADE_TYPE_LABELS).map(([val, info]) => (
              <div key={val} onClick={() => set('tradeType', val)} style={{ padding: '10px 12px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${form.tradeType === val ? info.color : 'var(--border-0)'}`, background: form.tradeType === val ? `${info.color}10` : 'var(--bg-2)', transition: 'all .12s' }}>
                <div style={{ fontSize: '.78rem', fontWeight: 700, color: form.tradeType === val ? info.color : 'var(--text-1)' }}>{info.label}</div>
                <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginTop: 2 }}>{info.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Unit selection */}
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Unit *</label>
          <select className="input" style={{ width: '100%' }} value={form.unitId} onChange={e => set('unitId', e.target.value)}>
            <option value="">Select a unit…</option>
            {units.map(u => <option key={u.id} value={u.id}>Unit {u.unit_number} — {u.property_name} ({u.tenant_first} {u.tenant_last})</option>)}
          </select>
          {errors.unitId && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.unitId}</div>}
        </div>

        {/* Labor terms */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Hourly Rate *</label>
            <div style={{ position: 'relative' }}>
              <DollarSign size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
              <input className="input" type="number" placeholder="15.00" value={form.hourlyRate} onChange={e => set('hourlyRate', e.target.value)} style={{ width: '100%', paddingLeft: 28 }} />
            </div>
            {errors.hourlyRate && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.hourlyRate}</div>}
          </div>
          <div>
            <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Hours/Week *</label>
            <input className="input" type="number" placeholder="20" value={form.weeklyHours} onChange={e => set('weeklyHours', e.target.value)} style={{ width: '100%' }} />
            {errors.weeklyHours && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.weeklyHours}</div>}
          </div>
        </div>

        {/* Rent terms */}
        <div style={{ display: 'grid', gridTemplateColumns: form.tradeType === 'full' ? '1fr' : '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Market Rent *</label>
            <div style={{ position: 'relative' }}>
              <DollarSign size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
              <input className="input" type="number" placeholder="600.00" value={form.marketRent} onChange={e => set('marketRent', e.target.value)} style={{ width: '100%', paddingLeft: 28 }} />
            </div>
            {errors.marketRent && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.marketRent}</div>}
          </div>
          {form.tradeType !== 'full' && (
            <div>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Cash Rent Due</label>
              <div style={{ position: 'relative' }}>
                <DollarSign size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                <input className="input" type="number" placeholder="300.00" value={form.cashRent} onChange={e => set('cashRent', e.target.value)} style={{ width: '100%', paddingLeft: 28 }} />
              </div>
            </div>
          )}
        </div>

        {/* Economics preview */}
        {form.marketRent && form.weeklyHours && form.hourlyRate && (
          <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10, padding: 12, marginBottom: 14 }}>
            <div style={{ fontSize: '.65rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 8 }}>Monthly Economics</div>
            {[
              { label: 'Market rent', val: formatCurrency(parseFloat(form.marketRent)), color: 'var(--text-0)' },
              { label: `Labor credit (${monthlyHours.toFixed(1)}hrs × ${formatCurrency(parseFloat(form.hourlyRate))})`, val: `-${formatCurrency(maxCredit)}`, color: 'var(--green)' },
              { label: 'Cash balance due', val: formatCurrency(form.tradeType === 'full' ? 0 : parseFloat(form.cashRent) || 0), color: 'var(--gold)' },
            ].map(r => (
              <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.75rem', padding: '3px 0', borderBottom: '1px solid var(--border-0)' }}>
                <span style={{ color: 'var(--text-3)' }}>{r.label}</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: r.color, fontWeight: 500 }}>{r.val}</span>
              </div>
            ))}
          </div>
        )}

        {/* Duties */}
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Duties Description</label>
          <textarea className="input" placeholder="Describe the work duties — e.g. campground host duties including greeting guests, maintaining common areas, basic maintenance…" value={form.duties} onChange={e => set('duties', e.target.value)} rows={3} style={{ width: '100%', resize: 'vertical' }} />
        </div>

        {/* Dates */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Start Date *</label>
            <input className="input" type="date" value={form.startDate} onChange={e => set('startDate', e.target.value)} style={{ width: '100%' }} />
          </div>
          <div>
            <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>End Date <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span></label>
            <input className="input" type="date" value={form.endDate} onChange={e => set('endDate', e.target.value)} style={{ width: '100%' }} />
          </div>
        </div>

        {createMut.isError && (
          <div style={{ color: 'var(--red)', fontSize: '.75rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
            Failed to create agreement. Make sure the unit has an assigned tenant.
          </div>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={createMut.isLoading}>
            {createMut.isLoading ? <span className="spinner" /> : <><Check size={14} /> Create Agreement</>}
          </button>
        </div>
      </div>
    </div>
  )
}
