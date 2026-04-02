import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { Clock, CheckCircle, Package, ShoppingCart, Calendar, Wrench, Plus, User, AlertTriangle } from 'lucide-react'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

type Tab = 'shift'|'workorders'|'tasks'|'parts'|'purchases'|'scheduled'

export function MaintenancePortalPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('shift')
  const [showAddPart, setShowAddPart] = useState(false)
  const [showAddTask, setShowAddTask] = useState(false)
  const [showPurchaseRequest, setShowPurchaseRequest] = useState(false)
  const [newPart, setNewPart] = useState({ name:'', sku:'', quantity:0, minQuantity:0, unit:'each', location:'', cost:'' })
  const [newTask, setNewTask] = useState({ title:'', description:'', dueDate:'', recurrence:'none' })
  const [purchaseItems, setPurchaseItems] = useState<{name:string,qty:number,est:string}[]>([{name:'',qty:1,est:''}])
  const [purchaseNotes, setPurchaseNotes] = useState('')

  const { data: shiftData } = useQuery('shift-active', () => apiGet('/maint-portal/shifts/active'), { refetchInterval: 30000 })
  const { data: workOrders = [] } = useQuery<any[]>('maint-work-orders', () => apiGet('/maint-portal/work-orders'))
  const { data: tasks = [] } = useQuery<any[]>('maint-tasks', () => apiGet('/maint-portal/tasks'))
  const { data: parts = [] } = useQuery<any[]>('maint-parts', () => apiGet('/maint-portal/parts'))
  const { data: purchases = [] } = useQuery<any[]>('maint-purchases', () => apiGet('/maint-portal/purchases'))
  const { data: scheduled = [] } = useQuery<any[]>('maint-scheduled', () => apiGet('/maint-portal/scheduled'))

  const clockInMut = useMutation(() => apiPost('/maint-portal/shifts/clock-in', {}), { onSuccess: () => qc.invalidateQueries('shift-active') })
  const clockOutMut = useMutation(() => apiPost('/maint-portal/shifts/clock-out', {}), { onSuccess: () => qc.invalidateQueries('shift-active') })
  const completeTaskMut = useMutation((id: string) => apiPatch('/maint-portal/tasks/'+id+'/complete', {}), { onSuccess: () => qc.invalidateQueries('maint-tasks') })
  const addPartMut = useMutation(() => apiPost('/maint-portal/parts', { ...newPart, quantity: parseInt(newPart.quantity as any)||0, minQuantity: parseInt(newPart.minQuantity as any)||0, cost: parseFloat(newPart.cost)||null }), { onSuccess: () => { qc.invalidateQueries('maint-parts'); setShowAddPart(false); setNewPart({ name:'', sku:'', quantity:0, minQuantity:0, unit:'each', location:'', cost:'' }) } })
  const addTaskMut = useMutation(() => apiPost('/maint-portal/tasks', newTask), { onSuccess: () => { qc.invalidateQueries('maint-tasks'); setShowAddTask(false) } })
  const purchaseReqMut = useMutation(() => apiPost('/maint-portal/purchases', { items: purchaseItems, notes: purchaseNotes, totalEstimate: purchaseItems.reduce((a,i)=>a+parseFloat(i.est||'0')*i.qty,0) }), { onSuccess: () => { qc.invalidateQueries('maint-purchases'); setShowPurchaseRequest(false) } })
  const approvePurchaseMut = useMutation(({ id, budgetLimit }: any) => apiPatch('/maint-portal/purchases/'+id+'/approve', { budgetLimit }), { onSuccess: () => qc.invalidateQueries('maint-purchases') })
  const completedScheduledMut = useMutation((id: string) => apiPatch('/maint-portal/scheduled/'+id+'/complete', {}), { onSuccess: () => qc.invalidateQueries('maint-scheduled') })

  const myShift = (shiftData as any)?.myShift
  const activeStaff = (shiftData as any)?.active || []
  const lowStock = (parts as any[]).filter(p => p.quantity <= p.min_quantity)
  const pendingPurchases = (purchases as any[]).filter(p => p.status === 'pending')
  const todayTasks = (tasks as any[]).filter(t => !t.completed)
  const overdueScheduled = (scheduled as any[]).filter(s => s.next_due && new Date(s.next_due) <= new Date())

  const TABS: {id:Tab, label:string, icon:any, badge?:number}[] = [
    { id:'shift',      label:'Shift',       icon:Clock,        badge: activeStaff.length },
    { id:'workorders', label:'Work Orders',  icon:Wrench,       badge: (workOrders as any[]).length },
    { id:'tasks',      label:'Tasks',        icon:CheckCircle,  badge: todayTasks.length },
    { id:'parts',      label:'Parts',        icon:Package,      badge: lowStock.length || undefined },
    { id:'purchases',  label:'Purchases',    icon:ShoppingCart, badge: pendingPurchases.length || undefined },
    { id:'scheduled',  label:'Scheduled',    icon:Calendar,     badge: overdueScheduled.length || undefined },
  ]

  const PRIORITY_COLORS: Record<string,string> = { emergency:'badge-red', high:'badge-amber', normal:'badge-blue', low:'badge-muted' }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Maintenance Portal</h1>
          <p className="page-subtitle">{myShift ? '🟢 On shift' : '⚫ Off shift'} · {activeStaff.length} staff active</p>
        </div>
        <button className={`btn ${myShift ? 'btn-ghost' : 'btn-primary'}`}
          onClick={() => myShift ? clockOutMut.mutate() : clockInMut.mutate()}
          disabled={clockInMut.isLoading || clockOutMut.isLoading}>
          <Clock size={14}/> {myShift ? 'Clock Out' : 'Clock In'}
        </button>
      </div>

      {/* Alerts */}
      {lowStock.length > 0 && (
        <div className="alert alert-warn" style={{ marginBottom:12 }}>
          <AlertTriangle size={14}/> <strong>{lowStock.length} part(s) low on stock:</strong> {lowStock.map((p:any)=>p.name).join(', ')}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display:'flex', gap:4, marginBottom:20, borderBottom:'1px solid var(--border-0)', paddingBottom:0 }}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 14px', border:'none', background:'none', cursor:'pointer', fontSize:'.82rem', fontWeight:600,
              color:tab===t.id?'var(--gold)':'var(--text-3)',
              borderBottom:tab===t.id?'2px solid var(--gold)':'2px solid transparent',
              marginBottom:-1, position:'relative' }}>
            <t.icon size={14}/>{t.label}
            {t.badge ? <span style={{ background:'var(--red)', color:'white', fontSize:'.65rem', fontWeight:700, padding:'1px 5px', borderRadius:10, minWidth:16, textAlign:'center' }}>{t.badge}</span> : null}
          </button>
        ))}
      </div>

      {/* SHIFT TAB */}
      {tab==='shift' && (
        <div>
          {myShift && (
            <div className="card" style={{ marginBottom:16, padding:16, background:'rgba(34,197,94,.06)', border:'1px solid rgba(34,197,94,.2)' }}>
              <div style={{ fontWeight:700, color:'var(--green)', marginBottom:4 }}>✓ You are clocked in</div>
              <div style={{ fontSize:'.78rem', color:'var(--text-3)' }}>Since {new Date(myShift.clocked_in_at).toLocaleTimeString()}</div>
            </div>
          )}
          <div className="card" style={{ padding:0 }}>
            <div style={{ padding:'12px 16px', borderBottom:'1px solid var(--border-0)', fontWeight:700, color:'var(--text-0)', fontSize:'.85rem' }}>Active Staff</div>
            {activeStaff.length === 0 ? (
              <div style={{ padding:24, textAlign:'center', color:'var(--text-3)', fontSize:'.82rem' }}>No staff currently on shift</div>
            ) : (
              <table className="data-table">
                <thead><tr><th>Name</th><th>Clocked In</th><th>Hours</th></tr></thead>
                <tbody>
                  {activeStaff.map((s:any) => (
                    <tr key={s.id}>
                      <td><div style={{ fontWeight:600, color:'var(--text-0)' }}>{s.first_name} {s.last_name}</div></td>
                      <td style={{ fontSize:'.78rem', color:'var(--text-3)' }}>{new Date(s.clocked_in_at).toLocaleTimeString()}</td>
                      <td className="mono" style={{ fontSize:'.78rem' }}>{parseFloat(s.hours_on_shift).toFixed(1)}h</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* WORK ORDERS TAB */}
      {tab==='workorders' && (
        <div className="card" style={{ padding:0 }}>
          {(workOrders as any[]).length === 0 ? (
            <div className="empty-state" style={{ padding:48 }}><Wrench size={40}/><h3>No open work orders</h3></div>
          ) : (
            <table className="data-table">
              <thead><tr><th>Unit</th><th>Issue</th><th>Tenant</th><th>Priority</th><th>Status</th></tr></thead>
              <tbody>
                {(workOrders as any[]).map((o:any) => (
                  <tr key={o.id}>
                    <td><div style={{ fontWeight:600 }}>{o.property_name}</div><div style={{ fontSize:'.72rem', color:'var(--text-3)' }}>Unit {o.unit_number}</div></td>
                    <td style={{ maxWidth:200 }}><div style={{ fontWeight:600, fontSize:'.82rem' }}>{o.title}</div><div style={{ fontSize:'.72rem', color:'var(--text-3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{o.description}</div></td>
                    <td style={{ fontSize:'.78rem' }}><div>{o.tenant_name||'—'}</div>{o.tenant_phone&&<div style={{ color:'var(--text-3)' }}>{o.tenant_phone}</div>}</td>
                    <td><span className={`badge ${PRIORITY_COLORS[o.priority]||'badge-muted'}`}>{o.priority}</span></td>
                    <td><span className="badge badge-amber">{o.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* TASKS TAB */}
      {tab==='tasks' && (
        <div>
          <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}>
            <button className="btn btn-primary btn-sm" onClick={()=>setShowAddTask(true)}><Plus size={13}/> Add Task</button>
          </div>
          <div className="card" style={{ padding:0 }}>
            {(tasks as any[]).length === 0 ? (
              <div className="empty-state" style={{ padding:48 }}><CheckCircle size={40}/><h3>No tasks today</h3></div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
                {(tasks as any[]).map((t:any) => (
                  <div key={t.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px', borderBottom:'1px solid var(--border-0)', opacity:t.completed?0.5:1 }}>
                    <input type="checkbox" checked={t.completed} onChange={()=>!t.completed&&completeTaskMut.mutate(t.id)} style={{ width:18, height:18, cursor:'pointer' }}/>
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:600, color:'var(--text-0)', textDecoration:t.completed?'line-through':'none' }}>{t.title}</div>
                      {t.description && <div style={{ fontSize:'.72rem', color:'var(--text-3)' }}>{t.description}</div>}
                    </div>
                    {t.assigned_name && <div style={{ fontSize:'.72rem', color:'var(--text-3)', display:'flex', alignItems:'center', gap:4 }}><User size={11}/>{t.assigned_name}</div>}
                    {t.recurrence !== 'none' && <span className="badge badge-blue">{t.recurrence}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
          {showAddTask && (
            <div className="modal-overlay" onClick={()=>setShowAddTask(false)}>
              <div className="modal" style={{ maxWidth:400 }} onClick={e=>e.stopPropagation()}>
                <div className="modal-title">Add Task</div>
                <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                  <input className="input" placeholder="Task title *" value={newTask.title} onChange={e=>setNewTask(t=>({...t,title:e.target.value}))}/>
                  <input className="input" placeholder="Description" value={newTask.description} onChange={e=>setNewTask(t=>({...t,description:e.target.value}))}/>
                  <input className="input" type="date" value={newTask.dueDate} onChange={e=>setNewTask(t=>({...t,dueDate:e.target.value}))}/>
                  <select className="input" value={newTask.recurrence} onChange={e=>setNewTask(t=>({...t,recurrence:e.target.value}))}>
                    <option value="none">One-time</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
                <div className="modal-footer">
                  <button className="btn btn-ghost" onClick={()=>setShowAddTask(false)}>Cancel</button>
                  <button className="btn btn-primary" disabled={!newTask.title||addTaskMut.isLoading} onClick={()=>addTaskMut.mutate()}>Add Task</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* PARTS TAB */}
      {tab==='parts' && (
        <div>
          <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}>
            <button className="btn btn-primary btn-sm" onClick={()=>setShowAddPart(true)}><Plus size={13}/> Add Part</button>
          </div>
          <div className="card" style={{ padding:0 }}>
            {(parts as any[]).length === 0 ? (
              <div className="empty-state" style={{ padding:48 }}><Package size={40}/><h3>No parts in inventory</h3><p>Add parts to track stock levels.</p></div>
            ) : (
              <table className="data-table">
                <thead><tr><th>Part</th><th>SKU</th><th>Location</th><th>Stock</th><th>Min</th><th>Cost</th></tr></thead>
                <tbody>
                  {(parts as any[]).map((p:any) => (
                    <tr key={p.id} style={{ background: p.quantity<=p.min_quantity ? 'rgba(239,68,68,.04)' : '' }}>
                      <td><div style={{ fontWeight:600 }}>{p.name}</div>{p.description&&<div style={{ fontSize:'.7rem', color:'var(--text-3)' }}>{p.description}</div>}</td>
                      <td className="mono" style={{ fontSize:'.75rem' }}>{p.sku||'—'}</td>
                      <td style={{ fontSize:'.78rem' }}>{p.location||'—'}</td>
                      <td><span style={{ fontWeight:700, color:p.quantity<=p.min_quantity?'var(--red)':'var(--green)' }}>{p.quantity} {p.unit}</span></td>
                      <td style={{ fontSize:'.78rem', color:'var(--text-3)' }}>{p.min_quantity}</td>
                      <td className="mono" style={{ fontSize:'.78rem' }}>{p.cost ? fmt(p.cost) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {showAddPart && (
            <div className="modal-overlay" onClick={()=>setShowAddPart(false)}>
              <div className="modal" style={{ maxWidth:440 }} onClick={e=>e.stopPropagation()}>
                <div className="modal-title">Add Part to Inventory</div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  <div style={{ gridColumn:'1/-1' }}><label style={{ fontSize:'.68rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', display:'block', marginBottom:4 }}>Part Name *</label><input className="input" value={newPart.name} onChange={e=>setNewPart(p=>({...p,name:e.target.value}))}/></div>
                  <div><label style={{ fontSize:'.68rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', display:'block', marginBottom:4 }}>SKU</label><input className="input" value={newPart.sku} onChange={e=>setNewPart(p=>({...p,sku:e.target.value}))}/></div>
                  <div><label style={{ fontSize:'.68rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', display:'block', marginBottom:4 }}>Unit</label><input className="input" value={newPart.unit} onChange={e=>setNewPart(p=>({...p,unit:e.target.value}))}/></div>
                  <div><label style={{ fontSize:'.68rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', display:'block', marginBottom:4 }}>Quantity</label><input className="input" type="number" value={newPart.quantity} onChange={e=>setNewPart(p=>({...p,quantity:e.target.value as any}))}/></div>
                  <div><label style={{ fontSize:'.68rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', display:'block', marginBottom:4 }}>Min Stock</label><input className="input" type="number" value={newPart.minQuantity} onChange={e=>setNewPart(p=>({...p,minQuantity:e.target.value as any}))}/></div>
                  <div><label style={{ fontSize:'.68rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', display:'block', marginBottom:4 }}>Location</label><input className="input" value={newPart.location} onChange={e=>setNewPart(p=>({...p,location:e.target.value}))}/></div>
                  <div><label style={{ fontSize:'.68rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', display:'block', marginBottom:4 }}>Cost Each</label><input className="input" type="number" value={newPart.cost} onChange={e=>setNewPart(p=>({...p,cost:e.target.value}))}/></div>
                </div>
                <div className="modal-footer">
                  <button className="btn btn-ghost" onClick={()=>setShowAddPart(false)}>Cancel</button>
                  <button className="btn btn-primary" disabled={!newPart.name||addPartMut.isLoading} onClick={()=>addPartMut.mutate()}>Add Part</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* PURCHASES TAB */}
      {tab==='purchases' && (
        <div>
          <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}>
            <button className="btn btn-primary btn-sm" onClick={()=>setShowPurchaseRequest(true)}><Plus size={13}/> Request Purchase</button>
          </div>
          <div className="card" style={{ padding:0 }}>
            {(purchases as any[]).length === 0 ? (
              <div className="empty-state" style={{ padding:48 }}><ShoppingCart size={40}/><h3>No purchase requests</h3></div>
            ) : (
              <table className="data-table">
                <thead><tr><th>Requested By</th><th>Items</th><th>Estimate</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {(purchases as any[]).map((p:any) => {
                    const items = typeof p.items==='string' ? JSON.parse(p.items) : p.items||[]
                    return (
                      <tr key={p.id}>
                        <td><div style={{ fontWeight:600 }}>{p.requested_by_name}</div><div style={{ fontSize:'.7rem', color:'var(--text-3)' }}>{new Date(p.created_at).toLocaleDateString()}</div></td>
                        <td style={{ fontSize:'.78rem' }}>{items.map((i:any)=>i.name).join(', ')}</td>
                        <td className="mono" style={{ fontSize:'.78rem' }}>{p.total_estimate ? fmt(p.total_estimate) : '—'}</td>
                        <td><span className={`badge ${p.status==='approved'?'badge-green':p.status==='denied'?'badge-red':p.status==='purchased'?'badge-blue':'badge-amber'}`}>{p.status}</span></td>
                        <td>
                          {p.status==='pending' && (
                            <div style={{ display:'flex', gap:6 }}>
                              <button className="btn btn-primary btn-sm" onClick={()=>approvePurchaseMut.mutate({ id:p.id, budgetLimit:p.total_estimate })}>Approve</button>
                              <button className="btn btn-ghost btn-sm" onClick={()=>{}}>Deny</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
          {showPurchaseRequest && (
            <div className="modal-overlay" onClick={()=>setShowPurchaseRequest(false)}>
              <div className="modal" style={{ maxWidth:480 }} onClick={e=>e.stopPropagation()}>
                <div className="modal-title">Purchase Request</div>
                <div style={{ marginBottom:12 }}>
                  {purchaseItems.map((item, i) => (
                    <div key={i} style={{ display:'grid', gridTemplateColumns:'1fr auto auto', gap:8, marginBottom:8 }}>
                      <input className="input" placeholder="Item name" value={item.name} onChange={e=>{const arr=[...purchaseItems];arr[i].name=e.target.value;setPurchaseItems(arr)}}/>
                      <input className="input" type="number" placeholder="Qty" style={{ width:70 }} value={item.qty} onChange={e=>{const arr=[...purchaseItems];arr[i].qty=parseInt(e.target.value)||1;setPurchaseItems(arr)}}/>
                      <input className="input" type="number" placeholder="$ea" style={{ width:80 }} value={item.est} onChange={e=>{const arr=[...purchaseItems];arr[i].est=e.target.value;setPurchaseItems(arr)}}/>
                    </div>
                  ))}
                  <button className="btn btn-ghost btn-sm" onClick={()=>setPurchaseItems([...purchaseItems,{name:'',qty:1,est:''}])}><Plus size={12}/> Add Item</button>
                </div>
                <div style={{ marginBottom:12 }}>
                  <label style={{ fontSize:'.68rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', display:'block', marginBottom:4 }}>Notes</label>
                  <textarea className="input" rows={2} style={{ resize:'none', width:'100%' }} value={purchaseNotes} onChange={e=>setPurchaseNotes(e.target.value)}/>
                </div>
                <div style={{ padding:'10px 14px', background:'var(--bg-3)', borderRadius:8, marginBottom:12, fontSize:'.82rem' }}>
                  Total estimate: <strong>{fmt(purchaseItems.reduce((a,i)=>a+parseFloat(i.est||'0')*i.qty,0))}</strong>
                </div>
                <div className="modal-footer">
                  <button className="btn btn-ghost" onClick={()=>setShowPurchaseRequest(false)}>Cancel</button>
                  <button className="btn btn-primary" disabled={purchaseReqMut.isLoading} onClick={()=>purchaseReqMut.mutate()}>Submit Request</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* SCHEDULED TAB */}
      {tab==='scheduled' && (
        <div className="card" style={{ padding:0 }}>
          {(scheduled as any[]).length === 0 ? (
            <div className="empty-state" style={{ padding:48 }}><Calendar size={40}/><h3>No scheduled maintenance</h3></div>
          ) : (
            <table className="data-table">
              <thead><tr><th>Task</th><th>Property</th><th>Recurrence</th><th>Next Due</th><th>Assigned</th><th></th></tr></thead>
              <tbody>
                {(scheduled as any[]).map((s:any) => {
                  const overdue = s.next_due && new Date(s.next_due) <= new Date()
                  return (
                    <tr key={s.id} style={{ background:overdue?'rgba(239,68,68,.04)':'' }}>
                      <td><div style={{ fontWeight:600 }}>{s.title}</div>{s.description&&<div style={{ fontSize:'.7rem', color:'var(--text-3)' }}>{s.description}</div>}</td>
                      <td style={{ fontSize:'.78rem' }}><div>{s.property_name||'All properties'}</div>{s.unit_number&&<div style={{ color:'var(--text-3)' }}>Unit {s.unit_number}</div>}</td>
                      <td><span className="badge badge-blue">{s.recurrence}</span></td>
                      <td style={{ fontSize:'.78rem', color:overdue?'var(--red)':'var(--text-2)', fontWeight:overdue?700:400 }}>{s.next_due ? new Date(s.next_due).toLocaleDateString() : '—'}{overdue&&' ⚠️'}</td>
                      <td style={{ fontSize:'.78rem' }}>{s.assigned_name||'Unassigned'}</td>
                      <td><button className="btn btn-primary btn-sm" onClick={()=>completedScheduledMut.mutate(s.id)}>Complete</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
