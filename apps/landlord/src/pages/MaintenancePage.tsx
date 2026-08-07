import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { humanize, MAINTENANCE_PRIORITIES, MAINTENANCE_PRIORITY_LABEL, MAINTENANCE_CATEGORY_LABEL } from '@gam/shared'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { AuthedImg, AuthedVideo } from '../components/AuthedMedia'
import { CameraCapture } from '../components/CameraCapture'
import { usePerms } from '../lib/permissions'
import { EntryRequestsPage } from './EntryRequestsPage'
import { ServiceInterruptionsPanel } from '../components/ServiceInterruptionsPanel'
import {
  Wrench, Plus, X, Check, AlertTriangle, MessageSquare,
  DollarSign, Send, Lock
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
  // S475: pending worker-assignment selection.
  const [editAssignee, setEditAssignee] = useState<string>('')

  const { data, isLoading } = useQuery(
    ['maint-detail', r.id],
    () => apiGet<any>(`/maintenance/${r.id}`)
  )

  // S475: maintenance team roster — landlord owner sees full list;
  // worker roles get filtered to roleType==='maintenance' anyway.
  const { data: teamData } = useQuery(
    ['team-maintenance'],
    () => apiGet<any>('/scopes/team'),
  )
  const maintenanceWorkers = (teamData?.members ?? []).filter(
    (m: any) => m.role === 'maintenance',
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

  const { can } = usePerms()

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
              <span className={`badge ${PRI_COLORS[req.priority]}`}>{humanize(req.priority)}</span>
              <span className={`badge ${ST_COLORS[req.status]}`}>{humanize(req.status)}</span>
              {parseInt(req.commentCount) > 0 && (
                <span style={{ fontSize: '.65rem', color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 3 }}>
                  <MessageSquare size={10} /> {req.commentCount}
                </span>
              )}
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 800, color: 'var(--text-0)' }}>{req.title}</div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
              {req.category ? `${(MAINTENANCE_CATEGORY_LABEL as any)[req.category] || req.category} · ` : ''}Unit {req.unitNumber} · {req.propertyName} · {req.tenantFirst} {req.tenantLast}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6, flexShrink: 0 }}><X size={15} /></button>
        </div>

        {/* Progress stepper */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 16 }}>
          {STATUS_FLOW.map((s, i) => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', flex: i < STATUS_FLOW.length-1 ? 1 : 'none' }}>
              <div
                onClick={() => can('maintenance.update') && req.status !== 'completed' && updateMut.mutate({ status: s })}
                style={{
                  width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: can('maintenance.update') && req.status !== 'completed' ? 'pointer' : 'default',
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
              <div style={{ fontSize: '.6rem', color: i <= currentStep ? 'var(--gold)' : 'var(--text-3)', marginLeft: 4, marginRight: 4, whiteSpace: 'nowrap', textTransform: 'capitalize' }}>{humanize(s)}</div>
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
            {req.tenantNotes && (
              <div style={{ fontSize: '.78rem', color: 'var(--text-2)', background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 8, padding: '8px 12px', marginBottom: 8 }}>
                <span style={{ fontSize: '.65rem', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Tenant notes:</span>
                {req.tenantNotes}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {req.photos?.map((p: string, i: number) => (
                <a key={i} href={p} target="_blank" rel="noreferrer" style={{ fontSize: '.68rem', color: 'var(--gold)', background: 'rgba(201,162,39,.08)', border: '1px solid rgba(201,162,39,.2)', borderRadius: 6, padding: '3px 8px' }}>
                  Photo {i+1}
                </a>
              ))}
            </div>
            <ReceiptsSection requestId={req.id} canUpload={can('maintenance.update')} />
            <MaintenanceMediaSection requestId={req.id} canUpload={can('maintenance.update')} status={req.status} completedAt={req.completedAt} />
          </div>

          {/* Management */}
          <div>
            <div style={{ fontSize: '.68rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8 }}>Management</div>

            {/* S571: priority — agent-recommended, landlord-overridable */}
            {can('maintenance.update') && (
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: '.68rem', color: 'var(--text-3)', display: 'block', marginBottom: 3 }}>Priority</label>
              <select className="input" value={req.priority} onChange={e => updateMut.mutate({ priority: e.target.value })} style={{ width: '100%', fontSize: '.78rem' }}>
                {MAINTENANCE_PRIORITIES.map(p => (
                  <option key={p} value={p}>{MAINTENANCE_PRIORITY_LABEL[p]}</option>
                ))}
              </select>
              {req.recommendedPriority && (
                <div style={{ fontSize: '.66rem', color: 'var(--text-3)', marginTop: 3 }}>
                  AI recommended: <span style={{ color: 'var(--text-2)', fontWeight: 600 }}>{(MAINTENANCE_PRIORITY_LABEL as any)[req.recommendedPriority] || req.recommendedPriority}</span>
                  {req.prioritySource === 'heuristic' ? ' (fallback)' : ''}
                </div>
              )}
            </div>
            )}

            {/* Schedule */}
            {can('maintenance.update') && (
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: '.68rem', color: 'var(--text-3)', display: 'block', marginBottom: 3 }}>Scheduled Date</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="input" type="datetime-local" value={editSchedule || req.scheduledAt?.slice(0,16) || ''} onChange={e => setEditSchedule(e.target.value)} style={{ flex: 1, fontSize: '.78rem' }} />
                <button className="btn btn-ghost btn-sm" onClick={() => updateMut.mutate({ scheduledAt: editSchedule || undefined })}>
                  <Check size={12} />
                </button>
              </div>
            </div>
            )}

            {/* Cost */}
            {can('maintenance.update') && (
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: '.68rem', color: 'var(--text-3)', display: 'block', marginBottom: 3 }}>
                Actual Cost
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <DollarSign size={12} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                  <input className="input" type="number" placeholder="0.00" value={editCost || req.actualCost || ''} onChange={e => setEditCost(e.target.value)} style={{ width: '100%', paddingLeft: 24, fontSize: '.78rem' }} />
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => updateMut.mutate({ actualCost: parseFloat(editCost), status: 'completed' })}>
                  <Check size={12} />
                </button>
              </div>
            </div>
            )}

            {/* Assign — S475: editable dropdown over the team roster */}
            {can('maintenance.assign') && (
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: '.68rem', color: 'var(--text-3)', display: 'block', marginBottom: 3 }}>Assigned To</label>
              {req.assignedFirst && (
                <div style={{ fontSize: '.72rem', color: 'var(--text-2)', padding: '3px 0' }}>
                  Currently: {req.assignedFirst} {req.assignedLast}
                  {req.assignedAt && (
                    <span style={{ fontSize: '.65rem', color: 'var(--text-3)', marginLeft: 6 }}>
                      {new Date(req.assignedAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
              )}
              {maintenanceWorkers.length === 0 ? (
                <div style={{ fontSize: '.72rem', color: 'var(--text-3)', padding: '6px 0' }}>
                  No maintenance team members yet — invite one on the Team page.
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 6 }}>
                  <select
                    className="input"
                    value={editAssignee || req.assignedTo || ''}
                    onChange={e => setEditAssignee(e.target.value)}
                    style={{ flex: 1, fontSize: '.78rem' }}
                  >
                    <option value="">— Unassigned —</option>
                    {maintenanceWorkers.map((w: any) => (
                      <option key={w.userId} value={w.userId}>
                        {w.firstName} {w.lastName}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => updateMut.mutate({
                      assignedTo: editAssignee || null,
                    })}
                    disabled={editAssignee === (req.assignedTo || '')}
                    title="Save assignment"
                  ><Check size={12} /></button>
                </div>
              )}
            </div>
            )}

            {/* Quick status buttons */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {can('maintenance.approve') && req.status === 'awaiting_approval' && (
                <>
                  <button className="btn btn-sm btn-primary" onClick={() => approveMut.mutate()}>
                    <Check size={12} /> Approve
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => updateMut.mutate({ status: 'cancelled' })} style={{ color: 'var(--red)' }}>
                    <X size={12} /> Reject
                  </button>
                </>
              )}
              {can('maintenance.update') && req.status !== 'completed' && req.status !== 'cancelled' && req.status !== 'awaiting_approval' && (
                <button className="btn btn-sm btn-primary" onClick={() => updateMut.mutate({ status: 'completed', actualCost: editCost ? parseFloat(editCost) : undefined })}>
                  <Check size={12} /> Mark Complete
                </button>
              )}
              {can('maintenance.update') && req.status === 'open' && (
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
              <div key={c.id} style={{ display: 'flex', gap: 10, padding: '8px 10px', borderRadius: 8, background: c.isInternal ? 'rgba(201,162,39,.04)' : 'var(--bg-2)', border: `1px solid ${c.isInternal ? 'rgba(201,162,39,.15)' : 'var(--border-0)'}` }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: c.role === 'tenant' ? 'rgba(74,158,255,.15)' : c.role === 'maintenance' ? 'rgba(30,219,122,.15)' : 'rgba(201,162,39,.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '.65rem', fontWeight: 800, color: c.role === 'tenant' ? 'var(--blue)' : c.role === 'maintenance' ? 'var(--green)' : 'var(--gold)' }}>
                  {c.firstName?.[0]}{c.lastName?.[0]}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-0)' }}>{c.firstName} {c.lastName}</span>
                    <span style={{ fontSize: '.62rem', color: 'var(--text-3)', textTransform: 'capitalize' }}>{humanize(c.role)}</span>
                    {c.isInternal && <span style={{ fontSize: '.58rem', color: 'var(--amber)', background: 'rgba(201,162,39,.1)', padding: '1px 5px', borderRadius: 4 }}>Internal</span>}
                    <span style={{ fontSize: '.62rem', color: 'var(--text-3)', marginLeft: 'auto' }}>{new Date(c.createdAt).toLocaleString()}</span>
                  </div>
                  <div style={{ fontSize: '.78rem', color: 'var(--text-1)', lineHeight: 1.5 }}>{c.message}</div>
                </div>
              </div>
            ))}
            {comments.length === 0 && !isLoading && <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>No comments yet.</div>}
          </div>

          {/* Add comment */}
          {can('maintenance.comment') && (
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
          )}
        </div>
      </div>
    </div>
  )
}


function CostBreakdownModal({ requests, onClose }: { requests: any[]; onClose: () => void }) {
  const fmt2 = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
  const completed = requests.filter((r: any) => r.status === 'completed' && r.actualCost)
  const now = new Date()
  const sDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const sWeek  = new Date(sDay); sWeek.setDate(sDay.getDate() - sDay.getDay())
  const sMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const sYear  = new Date(now.getFullYear(), 0, 1)
  const sum = (arr: any[]) => arr.reduce((s: number, r: any) => s + (+r.actualCost || 0), 0)
  const hrs = (arr: any[]) => arr.reduce((s: number, r: any) => s + (+r.manHours || 0), 0)
  const fil = (d: Date) => completed.filter((r: any) => new Date(r.completedAt || r.updatedAt) >= d)
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
  // W-44 (S531): maintenance closures on amenities are created HERE (split
  // from the Amenities hold modal — issue-holds belong to Maintenance).
  const [showCloseAmenity, setShowCloseAmenity] = useState(false)
  const [filterStatus, setFilterStatus] = useState('all')
  const [filterPriority, setFilterPriority] = useState('all')
  const [showCostBreakdown, setShowCostBreakdown] = useState(false)
  const [view, setView] = useState<'work' | 'entry' | 'outage'>('work')
  const { can } = usePerms()

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

  // S507: Entry Requests folded into the Maintenance module as a sub-tab
  // (no standalone nav item). Work Orders is the default view.
  // Work Orders is the baseline (always visible — nav-gated on maintenance.view);
  // the Entry Requests + Outages sub-tabs carry their own permission keys.
  const TAB_DEFS: { id: 'work' | 'entry' | 'outage'; label: string; perm: string | null }[] = [
    { id: 'work',   label: 'Work Orders',    perm: null },
    { id: 'entry',  label: 'Entry Requests', perm: 'entry_requests.view' },
    { id: 'outage', label: 'Outages',        perm: 'maintenance.tab.outages' },
  ]
  const visibleTabs = TAB_DEFS.filter(t => t.perm === null || can(t.perm))
  // If the active view isn't one this user can see, snap to the first visible tab.
  const visibleTabIds = visibleTabs.map(t => t.id).join(',')
  useEffect(() => {
    if (visibleTabs.length && !visibleTabs.some(t => t.id === view)) setView(visibleTabs[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTabIds])

  const tabs = (
    <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-0)', marginBottom: 20 }}>
      {visibleTabs.map(t => (
        <button key={t.id} onClick={() => setView(t.id)}
          style={{ padding: '8px 16px', border: 'none', background: 'none', cursor: 'pointer', fontSize: '.82rem', fontWeight: 600, color: view === t.id ? 'var(--gold)' : 'var(--text-3)', borderBottom: view === t.id ? '2px solid var(--gold)' : '2px solid transparent', marginBottom: -1 }}>
          {t.label}
        </button>
      ))}
    </div>
  )

  if (view === 'entry') return <div>{tabs}<EntryRequestsPage /></div>
  if (view === 'outage') return <div>{tabs}<ServiceInterruptionsPanel /></div>

  return (
    <div>
      {tabs}
      <div className="page-header">
        <div>
          <h1 className="page-title">Maintenance</h1>
          <p className="page-subtitle">
            {(stats as any)?.openCount || 0} open · {(stats as any)?.inProgressCount || 0} in progress
            {emergencies.length > 0 && <span style={{ color: 'var(--red)', marginLeft: 8 }}>· {emergencies.length} emergency</span>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
        {can('amenities.hold') && (
          <button className="btn btn-primary" onClick={() => setShowCloseAmenity(true)}>
            <Lock size={14} /> Close Amenity
          </button>
        )}
        {can('maintenance.create') && (
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Plus size={15} /> Log Request
          </button>
        )}
        </div>
      </div>

      {/* Emergency alert */}
      {emergencies.length > 0 && (
        <div style={{ background: 'rgba(255,71,87,.06)', border: '1px solid rgba(255,71,87,.25)', borderRadius: 10, padding: '10px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
          <AlertTriangle size={15} style={{ color: 'var(--red)', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--red)' }}>{emergencies.length} Emergency Request{emergencies.length > 1 ? 's' : ''} — Immediate Attention Required</span>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
              {emergencies.map((e: any) => `Unit ${e.unitNumber}: ${e.title}`).join(' · ')}
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 12, marginBottom: 20 }}>
          {[
            { label: 'Open',        val: (stats as any).openCount,        color: 'var(--amber)',  filter: 'open' },
            { label: 'Assigned',    val: (stats as any).assignedCount,    color: 'var(--blue)',   filter: 'assigned' },
            { label: 'In Progress', val: (stats as any).inProgressCount, color: 'var(--blue)',   filter: 'in_progress' },
            { label: 'Completed',   val: (stats as any).completedCount,   color: 'var(--green)',  filter: 'completed' },
            { label: 'Total Cost',  val: fmt((stats as any).totalCost),   color: 'var(--text-0)', filter: 'cost' },
          ].filter(s => s.filter !== 'cost' || can('maintenance.view_costs')).map(s => (
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
            {humanize(s)}
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
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state" style={{ padding: 40 }}>
            <Wrench size={40} />
            <h3>No requests</h3>
            <p>{filterStatus === 'all' ? 'No maintenance requests yet.' : `No ${humanize(filterStatus).toLowerCase()} requests.`}</p>
          </div>
        ) : (
          <table className="data-table" style={{ minWidth: 980 }}>
            <thead>
              <tr>
                <th>Date</th><th>Unit</th><th>Issue</th><th>Priority</th>
                <th>Status</th><th>Assigned</th><th>Scheduled</th><th>Cost</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r: any) => (
                <tr key={r.id} onClick={() => setSelectedRequest(r)} style={{ cursor: 'pointer' }}>
                  <td className="mono" style={{ fontSize: '.72rem' }}>{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td>
                    <div className="mono">{r.unitNumber}</div>
                    <div style={{ fontSize: '.65rem', color: 'var(--text-3)' }}>{r.propertyName}</div>
                  </td>
                  <td>
                    <div style={{ color: 'var(--text-0)', fontWeight: 500, fontSize: '.82rem' }}>{r.title}</div>
                    <div style={{ fontSize: '.65rem', color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
                      {r.tenantFirst} {r.tenantLast}
                      {parseInt(r.commentCount) > 0 && <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}><MessageSquare size={9} />{r.commentCount}</span>}
                    </div>
                  </td>
                  <td><span className={`badge ${PRI_COLORS[r.priority]}`}>{humanize(r.priority)}</span></td>
                  <td><span className={`badge ${ST_COLORS[r.status]}`}>{humanize(r.status)}</span></td>
                  <td style={{ fontSize: '.75rem' }}>{r.assignedFirst ? `${r.assignedFirst} ${r.assignedLast}` : <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                  <td className="mono" style={{ fontSize: '.72rem' }}>{r.scheduledAt ? new Date(r.scheduledAt).toLocaleDateString() : <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                  <td className="mono">{r.actualCost ? fmt(r.actualCost) : <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
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
      {showCloseAmenity && <CloseAmenityModal onClose={() => setShowCloseAmenity(false)} />}
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
                {(units as any[]).map((u: any) => <option key={u.id} value={u.id}>Unit {u.unitNumber} — {u.propertyName}</option>)}
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

// W-8 (S529): receipts on a request — uploaded here, stored as documents
// rows auto-linked to the request's unit (they appear on the Documents tab
// too). No manual linking where the source is known.
// S571: tenant + worker evidence media (photos/video). Tenant uploads are
// landlord-IMMUTABLE — there is no delete path. Landlord/worker may add their
// own fix photos through the same endpoint.
function MaintenanceMediaSection({ requestId, canUpload, status, completedAt }: { requestId: string; canUpload: boolean; status?: string; completedAt?: string | null }) {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [cameraMode, setCameraMode] = useState<null | 'photo' | 'video'>(null)
  const { data: media = [] } = useQuery<any[]>(['maint-media', requestId], () => apiGet(`/maintenance/${requestId}/media`))
  const upload = async (file: File) => {
    setError(null); setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('capturedLive', 'true')
    const API_BASE = (import.meta as any).env.VITE_API_URL || 'http://localhost:4000'
    const res = await fetch(`${API_BASE}/api/maintenance/${requestId}/media`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('gam_token') || '') },
      body: fd,
    })
    if (!res.ok) { const j = await res.json().catch(() => ({})); setError(j?.error || 'Upload failed') }
    else { qc.invalidateQueries(['maint-media', requestId]) }
    setUploading(false)
  }
  const label = (m: any) => m.uploaderRole === 'tenant' ? 'Tenant' : m.uploaderRole === 'maintenance' ? 'Maintenance' : 'You'
  const isAfterClose = (m: any) => status === 'completed' && completedAt && new Date(m.createdAt).getTime() > new Date(completedAt).getTime()
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 }}>Photos &amp; video</div>
      {media.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(88px,1fr))', gap: 6, marginBottom: 6 }}>
          {media.map((m: any) => (
            <div key={m.id} style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', border: `1px solid ${isAfterClose(m) ? 'rgba(245,158,11,.5)' : 'var(--border-0)'}`, background: 'var(--bg-1)' }}>
              {isAfterClose(m) && <div style={{ position: 'absolute', top: 3, left: 3, zIndex: 2, fontSize: '.5rem', fontWeight: 800, color: '#1a1206', background: 'var(--amber)', borderRadius: 4, padding: '1px 4px' }}>AFTER CLOSE</div>}
              {m.mediaType === 'video'
                ? <AuthedVideo path={m.fileUrl} style={{ width: '100%', height: 88, objectFit: 'cover', background: '#000' }} />
                : <AuthedImg path={m.fileUrl} alt={m.caption || 'photo'} style={{ width: '100%', height: 88, objectFit: 'cover' }} />}
              <div style={{ padding: '2px 5px', fontSize: '.56rem', fontWeight: 700, color: m.uploaderRole === 'tenant' ? 'var(--blue, #4a9eff)' : 'var(--gold)', background: 'var(--bg-2)' }}>
                {label(m)} · {new Date(m.createdAt).toLocaleDateString()}{m.capturedLive ? ' · live' : ''}
                {m.caption && <div style={{ color: 'var(--text-3)', fontWeight: 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.caption}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {canUpload && (
          <>
            <button type="button" onClick={() => setCameraMode('photo')} disabled={uploading}
              style={{ fontSize: '.68rem', color: 'var(--text-2)', border: '1px dashed var(--border-2)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', background: 'none' }}>
              {uploading ? 'Uploading…' : '📷 Take fix photo'}
            </button>
            <button type="button" onClick={() => setCameraMode('video')} disabled={uploading}
              style={{ fontSize: '.68rem', color: 'var(--text-2)', border: '1px dashed var(--border-2)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', background: 'none' }}>
              🎥 Record
            </button>
          </>
        )}
        {!media.length && !canUpload && <span style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>None</span>}
      </div>
      {error && <div style={{ fontSize: '.68rem', color: 'var(--red)', marginTop: 3 }}>{error}</div>}
      {cameraMode && <CameraCapture mode={cameraMode} onCapture={(f) => { upload(f); setCameraMode(null) }} onClose={() => setCameraMode(null)} />}
    </div>
  )
}

function ReceiptsSection({ requestId, canUpload }: { requestId: string; canUpload: boolean }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const { data: receipts = [] } = useQuery<any[]>(['maint-receipts', requestId], () => apiGet(`/maintenance/${requestId}/receipts`))
  const upload = async (file: File) => {
    setError(null)
    const fd = new FormData()
    fd.append('file', file)
    const API_BASE = (import.meta as any).env.VITE_API_URL || 'http://localhost:4000'
    const res = await fetch(`${API_BASE}/api/maintenance/${requestId}/receipts`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('gam_token') || '') },
      body: fd,
    })
    if (!res.ok) { const j = await res.json().catch(() => ({})); setError(j?.error || 'Upload failed'); return }
    qc.invalidateQueries(['maint-receipts', requestId])
    qc.invalidateQueries('documents')
  }
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700 }}>Receipts</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {receipts.map((r: any) => (
          <button key={r.id} type="button"
            onClick={() => navigate(`/view?src=${encodeURIComponent(`/documents/${r.id}/file`)}&title=${encodeURIComponent(r.name || 'Receipt')}`)}
            style={{ fontSize: '.68rem', color: 'var(--gold)', background: 'rgba(201,162,39,.08)', border: '1px solid rgba(201,162,39,.2)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>
            {r.name || 'Receipt'}
          </button>
        ))}
        {canUpload && (
          <label style={{ fontSize: '.68rem', color: 'var(--text-2)', border: '1px dashed var(--border-2)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>
            + Add receipt
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }} />
          </label>
        )}
        {!receipts.length && !canUpload && <span style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>None</span>}
      </div>
      {error && <div style={{ fontSize: '.68rem', color: 'var(--red)', marginTop: 3 }}>{error}</div>}
    </div>
  )
}

// W-44 (S531): create a maintenance_closure hold on a common area — the
// Maintenance-tab home for "close the pool for chemical treatment".
function CloseAmenityModal({ onClose }: { onClose: () => void }) {
  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  const [propertyId, setPropertyId] = useState('')
  const { data: areas = [] } = useQuery<any[]>(
    ['common-areas', propertyId],
    () => apiGet(`/common-areas?propertyId=${propertyId}`),
    { enabled: !!propertyId }
  )
  const [f, setF] = useState({ areaId: '', title: '', startsAt: '', endsAt: '', notifyResidents: true })
  const m = useMutation(
    () => apiPost(`/common-areas/${f.areaId}/reservations`, {
      kind: 'maintenance_closure', title: f.title || undefined,
      startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString(),
      notifyResidents: f.notifyResidents,
    }),
    { onSuccess: onClose })
  const lbl2: React.CSSProperties = { fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 4, display: 'block' }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">Close Amenity for Maintenance</div>
        <div style={{ display: 'grid', gap: 10 }}>
          <div><span style={lbl2}>Property</span>
            <select className="form-select" value={propertyId} onChange={e => { setPropertyId(e.target.value); setF(x => ({ ...x, areaId: '' })) }} style={{ width: '100%' }}>
              <option value="" disabled>Select a property…</option>
              {(properties as any[]).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div><span style={lbl2}>Amenity</span>
            <select className="form-select" value={f.areaId} onChange={e => setF(x => ({ ...x, areaId: e.target.value }))} style={{ width: '100%' }} disabled={!propertyId}>
              <option value="" disabled>Select an amenity…</option>
              {(areas as any[]).filter((a: any) => a.active).map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div><span style={lbl2}>Reason</span><input className="form-input" placeholder="Chemical treatment" value={f.title} onChange={e => setF(x => ({ ...x, title: e.target.value }))} style={{ width: '100%' }} /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div><span style={lbl2}>Starts</span><input className="form-input" type="datetime-local" value={f.startsAt} onChange={e => setF(x => ({ ...x, startsAt: e.target.value }))} style={{ width: '100%' }} /></div>
            <div><span style={lbl2}>Ends</span><input className="form-input" type="datetime-local" value={f.endsAt} onChange={e => setF(x => ({ ...x, endsAt: e.target.value }))} style={{ width: '100%' }} /></div>
          </div>
          <label style={{ fontSize: '.8rem' }}>
            <input type="checkbox" checked={f.notifyResidents} onChange={e => setF(x => ({ ...x, notifyResidents: e.target.checked }))} /> Notify residents
          </label>
        </div>
        {m.isError && <div style={{ color: 'var(--red)', fontSize: '.78rem', marginTop: 8 }}>Could not create the closure (time conflict?).</div>}
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!f.areaId || !f.startsAt || !f.endsAt || m.isLoading} onClick={() => m.mutate()}>
            {m.isLoading ? 'Closing…' : 'Close Amenity'}
          </button>
        </div>
      </div>
    </div>
  )
}
