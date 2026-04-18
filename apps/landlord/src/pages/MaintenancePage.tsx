import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useSearchParams } from 'react-router-dom'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import {
  Wrench, Plus, X, Check, Clock, AlertTriangle, MessageSquare,
  User, Calendar, DollarSign, ChevronDown, ChevronUp, Send, Lock
} from 'lucide-react'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

const PRI_COLORS: Record<string,string> = { emergency:'badge-red', high:'badge-amber', normal:'badge-blue', low:'badge-muted' }
const ST_COLORS: Record<string,string>  = { open:'badge-amber', awaiting_approval:'badge-amber', assigned:'badge-blue', in_progress:'badge-blue', completed:'badge-green', cancelled:'badge-muted' }
const STATUS_FLOW = ['open','assigned','in_progress','completed']

function RequestDetailModal({ request: r, onClose }: { request: any; onClose: () => void }) {
  const qc = useQueryClient()
  const [comment, setComment] = useState('')
  const [isInternal, setIsInternal] = useState(false)
  const [editCost, setEditCost] = useState('')
  const [editSchedule, setEditSchedule] = useState('')

  const { data, isLoading } = useQuery(
    ['maint-detail', r.id],
    () => apiGet<any>(`/maintenance/${r.id}`)
  )

  const updateMut = useMutation(
    (body: any) => apiPatch(`/maintenance/${r.id}`, body),
    { onSuccess: () => { qc.invalidateQueries('maintenance'); qc.invalidateQueries(['maint-detail', r.id]) } }
  )

  const approveMut = useMutation(
    () => apiPost(`/maintenance/${r.id}/approve`, {}),
    { onSuccess: () => { qc.invalidateQueries('maintenance'); qc.invalidateQueries(['maint-detail', r.id]) } }
  )

  const commentMut = useMutation(
    (body: any) => apiPost(`/maintenance/${r.id}/comments`, body),
    { onSuccess: () => { qc.invalidateQueries(['maint-detail', r.id]); setComment('') } }
  )

  const req = data || r
  const comments = (data as any)?.comments || []
  const currentStep = STATUS_FLOW.indexOf(req.status)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 640, width: '95vw', maxHeight: '92vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span className={`badge ${PRI_COLORS[req.priority]}`}>{req.priority}</span>
              <span className={`badge ${ST_COLORS[req.status]}`}>{req.status?.replace('_',' ')}</span>
              {parseInt(req.comment_count) > 0 && (
                <span style={{ fontSize: '.65rem', color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 3 }}>
                  <MessageSquare size={10} /> {req.comment_count}
                </span>
              )}
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 800, color: 'var(--text-0)' }}>{req.title}</div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
              Unit {req.unit_number} · {req.property_name} · {req.tenant_first} {req.tenant_last}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6, flexShrink: 0 }}><X size={15} /></button>
        </div>

        {/* Progress stepper */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 16 }}>
          {STATUS_FLOW.map((s, i) => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', flex: i < STATUS_FLOW.length-1 ? 1 : 'none' }}>
              <div
                onClick={() => req.status !== 'completed' && updateMut.mutate({ status: s })}
                style={{
                  width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: req.status !== 'completed' ? 'pointer' : 'default',
                  background: i <= currentStep ? 'var(--gold)' : 'var(--bg-3)',
                  border: `2px solid ${i <= currentStep ? 'var(--gold)' : 'var(--border-0)'}`,
                  transition: 'all .15s', flexShrink: 0,
                }}
                title={`Set to ${s}`}
              >
                {i < currentStep ? <Check size={13} style={{ color: 'var(--bg-0)' }} /> :
                 i === currentStep ? <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--bg-0)' }} /> :
                 <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-3)' }} />}
              </div>
              <div style={{ fontSize: '.6rem', color: i <= currentStep ? 'var(--gold)' : 'var(--text-3)', marginLeft: 4, marginRight: 4, whiteSpace: 'nowrap', textTransform: 'capitalize' }}>{s.replace('_',' ')}</div>
              {i < STATUS_FLOW.length-1 && <div style={{ flex: 1, height: 2, background: i < currentStep ? 'var(--gold)' : 'var(--border-0)', margin: '0 4px' }} />}
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          {/* Details */}
          <div>
            <div style={{ fontSize: '.68rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8 }}>Details</div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-1)', lineHeight: 1.6, marginBottom: 12, background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 8, padding: '10px 12px' }}>
              {req.description}
            </div>
            {req.tenant_notes && (
              <div style={{ fontSize: '.78rem', color: 'var(--text-2)', background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 8, padding: '8px 12px', marginBottom: 8 }}>
                <span style={{ fontSize: '.65rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Tenant notes:</span>
                {req.tenant_notes}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {req.photos?.map((p: string, i: number) => (
                <a key={i} href={p} target="_blank" rel="noreferrer" style={{ fontSize: '.68rem', color: 'var(--gold)', background: 'rgba(201,162,39,.08)', border: '1px solid rgba(201,162,39,.2)', borderRadius: 6, padding: '3px 8px' }}>
                  Photo {i+1}
                </a>
              ))}
            </div>
          </div>

          {/* Management */}
          <div>
            <div style={{ fontSize: '.68rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8 }}>Management</div>

            {/* Schedule */}
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: '.68rem', color: 'var(--text-3)', display: 'block', marginBottom: 3 }}>Scheduled Date</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="input" type="datetime-local" value={editSchedule || req.scheduled_at?.slice(0,16) || ''} onChange={e => setEditSchedule(e.target.value)} style={{ flex: 1, fontSize: '.78rem' }} />
                <button className="btn btn-ghost btn-sm" onClick={() => updateMut.mutate({ scheduledAt: editSchedule || undefined })}>
                  <Check size={12} />
                </button>
              </div>
            </div>

            {/* Cost */}
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: '.68rem', color: 'var(--text-3)', display: 'block', marginBottom: 3 }}>
                Actual Cost {req.actual_cost && <span style={{ color: 'var(--gold)' }}>→ Platform fee: {fmt(req.actual_cost * 0.08)}</span>}
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <DollarSign size={12} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                  <input className="input" type="number" placeholder="0.00" value={editCost || req.actual_cost || ''} onChange={e => setEditCost(e.target.value)} style={{ width: '100%', paddingLeft: 24, fontSize: '.78rem' }} />
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => updateMut.mutate({ actualCost: parseFloat(editCost), status: 'completed' })}>
                  <Check size={12} />
                </button>
              </div>
            </div>

            {/* Man Hours */}
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: '.68rem', color: 'var(--text-3)', display: 'block', marginBottom: 3 }}>Man Hours</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="input" type="number" step="0.5" min="0" placeholder="0.0"
                  defaultValue={req.man_hours || ''}
                  onChange={e => setEditCost(e.target.value)}
                  id={`man-hours-${r.id}`}
                  style={{ width: '100%', fontSize: '.78rem' }} />
                <button className="btn btn-ghost btn-sm" onClick={() => {
                  const val = (document.getElementById(`man-hours-${r.id}`) as HTMLInputElement)?.value
                  if (val) updateMut.mutate({ manHours: parseFloat(val) })
                }}><Check size={12} /></button>
              </div>
              {req.man_hours && req.actual_cost && (
                <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 3 }}>
                  Cost/hr: {fmt(req.actual_cost / req.man_hours)}
                </div>
              )}
            </div>

            {/* Assign */}
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: '.68rem', color: 'var(--text-3)', display: 'block', marginBottom: 3 }}>Assigned To</label>
              <div style={{ fontSize: '.78rem', color: req.assigned_first ? 'var(--text-0)' : 'var(--text-3)', padding: '6px 0' }}>
                {req.assigned_first ? `${req.assigned_first} ${req.assigned_last}` : 'Unassigned'}
                {req.assigned_at && <span style={{ fontSize: '.65rem', color: 'var(--text-3)', marginLeft: 6 }}>{new Date(req.assigned_at).toLocaleDateString()}</span>}
              </div>
            </div>

            {/* Quick status buttons */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {req.status === 'awaiting_approval' && (
                <>
                  <button className="btn btn-sm btn-primary" onClick={() => approveMut.mutate()}>
                    <Check size={12} /> Approve
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => updateMut.mutate({ status: 'cancelled' })} style={{ color: 'var(--red)' }}>
                    <X size={12} /> Reject
                  </button>
                </>
              )}
              {req.status !== 'completed' && req.status !== 'cancelled' && req.status !== 'awaiting_approval' && (
                <button className="btn btn-sm btn-primary" onClick={() => updateMut.mutate({ status: 'completed', actualCost: editCost ? parseFloat(editCost) : undefined })}>
                  <Check size={12} /> Mark Complete
                </button>
              )}
              {req.status === 'open' && (
                <button className="btn btn-sm btn-ghost" onClick={() => updateMut.mutate({ status: 'cancelled' })}>
                  <X size={12} /> Cancel
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Timeline / Comments */}
        <div>
          <div style={{ fontSize: '.68rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 10 }}>Timeline</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12, maxHeight: 240, overflowY: 'auto' }}>
            {isLoading && <div style={{ color: 'var(--text-3)', fontSize: '.78rem' }}>Loading…</div>}
            {comments.map((c: any) => (
              <div key={c.id} style={{ display: 'flex', gap: 10, padding: '8px 10px', borderRadius: 8, background: c.is_internal ? 'rgba(201,162,39,.04)' : 'var(--bg-2)', border: `1px solid ${c.is_internal ? 'rgba(201,162,39,.15)' : 'var(--border-0)'}` }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: c.role === 'tenant' ? 'rgba(74,158,255,.15)' : c.role === 'maintenance' ? 'rgba(30,219,122,.15)' : 'rgba(201,162,39,.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '.65rem', fontWeight: 800, color: c.role === 'tenant' ? 'var(--blue)' : c.role === 'maintenance' ? 'var(--green)' : 'var(--gold)' }}>
                  {c.first_name?.[0]}{c.last_name?.[0]}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-0)' }}>{c.first_name} {c.last_name}</span>
                    <span style={{ fontSize: '.62rem', color: 'var(--text-3)', textTransform: 'capitalize' }}>{c.role}</span>
                    {c.is_internal && <span style={{ fontSize: '.58rem', color: 'var(--amber)', background: 'rgba(201,162,39,.1)', padding: '1px 5px', borderRadius: 4 }}>Internal</span>}
                    <span style={{ fontSize: '.62rem', color: 'var(--text-3)', marginLeft: 'auto' }}>{new Date(c.created_at).toLocaleString()}</span>
                  </div>
                  <div style={{ fontSize: '.78rem', color: 'var(--text-1)', lineHeight: 1.5 }}>{c.message}</div>
                </div>
              </div>
            ))}
            {comments.length === 0 && !isLoading && <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>No comments yet.</div>}
          </div>

          {/* Add comment */}
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <input className="input" placeholder="Add a note or update…" value={comment} onChange={e => setComment(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && comment.trim() && commentMut.mutate({ message: comment, isInternal })} style={{ width: '100%' }} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '.68rem', color: 'var(--text-3)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={isInternal} onChange={e => setIsInternal(e.target.checked)} />
              <Lock size={11} /> Internal
            </label>
            <button className="btn btn-primary btn-sm" disabled={!comment.trim() || commentMut.isLoading} onClick={() => commentMut.mutate({ message: comment, isInternal })}>
              <Send size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}


function CostBreakdownModal({ requests, onClose }: { requests: any[]; onClose: () => void }) {
  const fmt2 = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
  const completed = requests.filter((r: any) => r.status === 'completed' && r.actual_cost)
  const now = new Date()
  const sDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const sWeek  = new Date(sDay); sWeek.setDate(sDay.getDate() - sDay.getDay())
  const sMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const sYear  = new Date(now.getFullYear(), 0, 1)
  const sum = (arr: any[]) => arr.reduce((s: number, r: any) => s + (+r.actual_cost || 0), 0)
  const hrs = (arr: any[]) => arr.reduce((s: number, r: any) => s + (+r.man_hours || 0), 0)
  const fil = (d: Date) => completed.filter((r: any) => new Date(r.completed_at || r.updated_at) >= d)
  const rows: [string, any[]][] = [['Today', fil(sDay)], ['This Week', fil(sWeek)], ['This Month', fil(sMonth)], ['YTD', fil(sYear)], ['All Time', completed]]
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div className="modal-title">Maintenance Cost Breakdown</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={14} /></button>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--bg-2)' }}>
              {['Period','Jobs','Total Cost','Avg/Job','Man Hrs'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: h==='Period'?'left':'right', fontSize: '.65rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, items]) => (
              <tr key={label} style={{ borderBottom: '1px solid var(--border-0)' }}>
                <td style={{ padding: '10px 12px', color: 'var(--text-2)', fontSize: '.82rem' }}>{label}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-0)' }}>{items.length}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--gold)' }}>{fmt2(sum(items))}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>{items.length > 0 ? fmt2(sum(items) / items.length) : '—'}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>{hrs(items) > 0 ? hrs(items).toFixed(1) + ' hrs' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {completed.length === 0 && <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>No completed requests with costs yet.</div>}
      </div>
    </div>
  )
}

export function MaintenancePage() {
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [selectedRequest, setSelectedRequest] = useState<any>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const [filterStatus, setFilterStatus] = useState('all')
  const [filterPriority, setFilterPriority] = useState('all')
  const [showCostBreakdown, setShowCostBreakdown] = useState(false)

  const { data: requests = [], isLoading } = useQuery<any[]>('maintenance', () => apiGet('/maintenance'))

  // Deep-link: ?open=<requestId> opens the detail modal directly once requests load
  useEffect(() => {
    const openId = searchParams.get('open')
    if (openId && !selectedRequest && requests?.length) {
      const found = (requests as any[]).find((r: any) => r.id === openId)
      if (found) setSelectedRequest(found)
    }
  }, [searchParams, requests])
  const { data: stats } = useQuery('maint-stats', () => apiGet<any>('/maintenance/stats/summary'))
  const { data: units = [] } = useQuery<any[]>('units', () => apiGet('/units'))

  const addMut = useMutation(
    (d: any) => apiPost('/maintenance', d),
    { onSuccess: () => { qc.invalidateQueries('maintenance'); setShowAdd(false) } }
  )

  const [form, setForm] = useState({ unitId:'', title:'', description:'', priority:'normal' })
  const setF = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const filtered = (requests as any[]).filter(r => {
    if (filterStatus !== 'all' && r.status !== filterStatus) return false
    if (filterPriority !== 'all' && r.priority !== filterPriority) return false
    return true
  })

  const emergencies = (requests as any[]).filter(r => r.priority === 'emergency' && r.status !== 'completed')

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Maintenance</h1>
          <p className="page-subtitle">
            {(stats as any)?.open_count || 0} open · {(stats as any)?.in_progress_count || 0} in progress
            {emergencies.length > 0 && <span style={{ color: 'var(--red)', marginLeft: 8 }}>· {emergencies.length} emergency</span>}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
          <Plus size={15} /> Log Request
        </button>
      </div>

      {/* Emergency alert */}
      {emergencies.length > 0 && (
        <div style={{ background: 'rgba(255,71,87,.06)', border: '1px solid rgba(255,71,87,.25)', borderRadius: 10, padding: '10px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
          <AlertTriangle size={15} style={{ color: 'var(--red)', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--red)' }}>{emergencies.length} Emergency Request{emergencies.length > 1 ? 's' : ''} — Immediate Attention Required</span>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
              {emergencies.map((e: any) => `Unit ${e.unit_number}: ${e.title}`).join(' · ')}
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 12, marginBottom: 20 }}>
          {[
            { label: 'Open',        val: (stats as any).open_count,        color: 'var(--amber)',  filter: 'open' },
            { label: 'Assigned',    val: (stats as any).assigned_count,    color: 'var(--blue)',   filter: 'assigned' },
            { label: 'In Progress', val: (stats as any).in_progress_count, color: 'var(--blue)',   filter: 'in_progress' },
            { label: 'Completed',   val: (stats as any).completed_count,   color: 'var(--green)',  filter: 'completed' },
            { label: 'Total Cost',  val: fmt((stats as any).total_cost),   color: 'var(--text-0)', filter: 'cost' },
          ].map(s => (
            <div key={s.label} className="card" style={{ padding: '12px 14px', cursor: 'pointer', border: filterStatus===s.filter?'1px solid var(--gold)':'1px solid var(--border-1)' }}
              onClick={() => s.filter==='cost' ? setShowCostBreakdown(true) : setFilterStatus(filterStatus===s.filter?'all':s.filter)}>
              <div style={{ fontSize: '.62rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 5 }}>{s.label}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.95rem', fontWeight: 700, color: s.color }}>{s.val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {['all','open','assigned','in_progress','completed','cancelled'].map(s => (
          <button key={s} onClick={() => setFilterStatus(s)} className={`btn btn-sm ${filterStatus===s?'btn-primary':'btn-ghost'}`} style={{ textTransform: 'capitalize', fontSize: '.72rem' }}>
            {s.replace('_',' ')}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {['all','emergency','high','normal','low'].map(p => (
            <button key={p} onClick={() => setFilterPriority(p)} style={{ padding: '4px 10px', borderRadius: 20, fontSize: '.68rem', fontWeight: 600, cursor: 'pointer', border: `1px solid ${filterPriority===p?'var(--gold)':'var(--border-0)'}`, background: filterPriority===p?'rgba(201,162,39,.1)':'var(--bg-2)', color: filterPriority===p?'var(--gold)':'var(--text-3)', textTransform: 'capitalize' }}>
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* Requests */}
      <div className="card" style={{ padding: 0 }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state" style={{ padding: 40 }}>
            <Wrench size={40} />
            <h3>No requests</h3>
            <p>{filterStatus === 'all' ? 'No maintenance requests yet.' : `No ${filterStatus.replace('_',' ')} requests.`}</p>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th><th>Unit</th><th>Issue</th><th>Priority</th>
                <th>Status</th><th>Assigned</th><th>Scheduled</th><th>Cost</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r: any) => (
                <tr key={r.id} onClick={() => setSelectedRequest(r)} style={{ cursor: 'pointer' }}>
                  <td className="mono" style={{ fontSize: '.72rem' }}>{new Date(r.created_at).toLocaleDateString()}</td>
                  <td>
                    <div className="mono">{r.unit_number}</div>
                    <div style={{ fontSize: '.65rem', color: 'var(--text-3)' }}>{r.property_name}</div>
                  </td>
                  <td>
                    <div style={{ color: 'var(--text-0)', fontWeight: 500, fontSize: '.82rem' }}>{r.title}</div>
                    <div style={{ fontSize: '.65rem', color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
                      {r.tenant_first} {r.tenant_last}
                      {parseInt(r.comment_count) > 0 && <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}><MessageSquare size={9} />{r.comment_count}</span>}
                    </div>
                  </td>
                  <td><span className={`badge ${PRI_COLORS[r.priority]}`}>{r.priority}</span></td>
                  <td><span className={`badge ${ST_COLORS[r.status]}`}>{r.status?.replace('_',' ')}</span></td>
                  <td style={{ fontSize: '.75rem' }}>{r.assigned_first ? `${r.assigned_first} ${r.assigned_last}` : <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                  <td className="mono" style={{ fontSize: '.72rem' }}>{r.scheduled_at ? new Date(r.scheduled_at).toLocaleDateString() : <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                  <td className="mono">{r.actual_cost ? fmt(r.actual_cost) : <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                  <td onClick={e => e.stopPropagation()}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setSelectedRequest(r)}>View</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add request modal */}
      {showAdd && (
        <div className="modal-overlay" onClick={() => setShowAdd(false)}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div className="modal-title" style={{ marginBottom: 0 }}>Log Maintenance Request</div>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowAdd(false)} style={{ padding: 6 }}><X size={15} /></button>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Unit *</label>
              <select className="input" style={{ width: '100%' }} value={form.unitId} onChange={e => setF('unitId', e.target.value)}>
                <option value="">Select unit…</option>
                {(units as any[]).map((u: any) => <option key={u.id} value={u.id}>Unit {u.unit_number} — {u.property_name}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Issue Title *</label>
              <input className="input" placeholder="e.g. HVAC not cooling" value={form.title} onChange={e => setF('title', e.target.value)} style={{ width: '100%' }} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Description *</label>
              <textarea className="input" placeholder="Describe the issue in detail…" value={form.description} onChange={e => setF('description', e.target.value)} rows={3} style={{ width: '100%', resize: 'vertical' }} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 8 }}>Priority</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
                {['emergency','high','normal','low'].map(p => (
                  <div key={p} onClick={() => setF('priority', p)} style={{ padding: '8px', borderRadius: 8, cursor: 'pointer', textAlign: 'center', border: `1px solid ${form.priority===p?'var(--gold)':'var(--border-0)'}`, background: form.priority===p?'rgba(201,162,39,.08)':'var(--bg-2)', fontSize: '.72rem', fontWeight: 600, color: form.priority===p?'var(--gold)':'var(--text-3)', textTransform: 'capitalize', transition: 'all .12s' }}>
                    {p}
                  </div>
                ))}
              </div>
            </div>
            {addMut.isError && <div style={{ color: 'var(--red)', fontSize: '.75rem', marginBottom: 10 }}>Failed to create request.</div>}
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={!form.unitId || !form.title || !form.description || addMut.isLoading} onClick={() => addMut.mutate(form)}>
                {addMut.isLoading ? <span className="spinner" /> : <><Wrench size={14} /> Create Request</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedRequest && <RequestDetailModal request={selectedRequest} onClose={() => {
        setSelectedRequest(null)
        if (searchParams.get('open')) {
          searchParams.delete('open')
          setSearchParams(searchParams, { replace: true })
        }
      }} />}
      {showCostBreakdown && <CostBreakdownModal requests={(requests as any[])} onClose={() => setShowCostBreakdown(false)} />}
    </div>
  )
}
