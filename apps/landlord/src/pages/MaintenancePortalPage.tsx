import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { humanize } from '@gam/shared'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { Clock, Package, ShoppingCart, Calendar, Wrench, Plus, AlertTriangle, ClipboardList, Circle } from 'lucide-react'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

type Tab = 'shift'|'workorders'|'propertytasks'|'parts'|'purchases'|'scheduled'

export function MaintenancePortalPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('shift')
  const [showAddPart, setShowAddPart] = useState(false)
  const [showPurchaseRequest, setShowPurchaseRequest] = useState(false)
  const [newPart, setNewPart] = useState({ name:'', sku:'', quantity:0, minQuantity:0, unit:'each', location:'', cost:'' })
  const [purchaseItems, setPurchaseItems] = useState<{name:string,qty:number,est:string}[]>([{name:'',qty:1,est:''}])
  const [purchaseNotes, setPurchaseNotes] = useState('')

  const { data: shiftData } = useQuery('shift-active', () => apiGet('/maint-portal/shifts/active'), { refetchInterval: 30000 })
  const { data: workOrders = [] } = useQuery<any[]>('maint-work-orders', () => apiGet('/maint-portal/work-orders'))
  const { data: parts = [] } = useQuery<any[]>('maint-parts', () => apiGet('/maint-portal/parts'))
  const { data: purchases = [] } = useQuery<any[]>('maint-purchases', () => apiGet('/maint-portal/purchases'))
  const { data: scheduled = [] } = useQuery<any[]>('maint-scheduled', () => apiGet('/maint-portal/scheduled'))
  // 10/20 (Blu, via Nic): the park checklists for the properties this worker is
  // assigned to — open lines only, because a checklist screen shows what is
  // left. The server decides which parks those are (maintenance_worker_scopes),
  // so this asks for "mine" and gets exactly that.
  const { data: propertyTasks = [] } = useQuery<any[]>('my-property-tasks', () => apiGet('/property-task-list'))

  const clockInMut = useMutation(() => apiPost('/maint-portal/shifts/clock-in', {}), { onSuccess: () => qc.invalidateQueries('shift-active') })
  const clockOutMut = useMutation(() => apiPost('/maint-portal/shifts/clock-out', {}), { onSuccess: () => qc.invalidateQueries('shift-active') })
  const addPartMut = useMutation(() => apiPost('/maint-portal/parts', { ...newPart, quantity: parseInt(newPart.quantity as any)||0, minQuantity: parseInt(newPart.minQuantity as any)||0, cost: parseFloat(newPart.cost)||null }), { onSuccess: () => { qc.invalidateQueries('maint-parts'); setShowAddPart(false); setNewPart({ name:'', sku:'', quantity:0, minQuantity:0, unit:'each', location:'', cost:'' }) } })
  const purchaseReqMut = useMutation(() => apiPost('/maint-portal/purchases', { items: purchaseItems, notes: purchaseNotes, totalEstimate: purchaseItems.reduce((a,i)=>a+parseFloat(i.est||'0')*i.qty,0) }), { onSuccess: () => { qc.invalidateQueries('maint-purchases'); setShowPurchaseRequest(false) } })
  const approvePurchaseMut = useMutation(({ id, budgetLimit }: any) => apiPatch('/maint-portal/purchases/'+id+'/approve', { budgetLimit }), { onSuccess: () => qc.invalidateQueries('maint-purchases') })
  const completedScheduledMut = useMutation((id: string) => apiPatch('/maint-portal/scheduled/'+id+'/complete', {}), { onSuccess: () => qc.invalidateQueries('maint-scheduled') })
  // Ticking a park's checklist line. The property id goes in the path: a line
  // belonging to a park this worker is not on is not reachable (routes/propertyTaskList).
  const tickPropertyTaskMut = useMutation(
    ({ propertyId, id }: { propertyId: string; id: string }) =>
      apiPost(`/property-task-list/${propertyId}/items/${id}/done`, {}),
    { onSuccess: () => qc.invalidateQueries('my-property-tasks') })

  // 10/21 (Nic) — THE SHOPPING LIST, FROM THE PERSON WHO KNOWS WHAT RAN OUT.
  //
  //   "we also need a way for maybe maintenance people or work trade people to
  //    put in sort of a collected shopping cart pool of, hey, we need to buy
  //    some new paint brushes and new trash bags... that way he doesn't have
  //    text messages from like 5 or 6 different people."
  //
  // The maintenance person is the whole point of the supply list and was the
  // one person with nowhere to add to it: the owner has it on the property
  // page and a work-trade resident has it in their portal, and this screen —
  // the one somebody standing in a park with an empty box is actually looking
  // at — only showed jobs.
  //
  // The write rule here is the opposite of the jobs list above, and the server
  // is what enforces it (routes/propertyTaskList assertMayAdd / assertMayTick):
  // anybody working the park ADDS a line, and only the owner ticks it bought.
  // So there is an add box and no tick button, which is the right way round.
  const { data: supplyLines = [] } = useQuery<any[]>('my-property-supplies',
    () => apiGet('/property-task-list?kind=supply'))
  // The parks this person may write a line for — asked for by name, not
  // guessed from the lines already on the lists. A quiet park with nothing on
  // either list still has to be somewhere you can write the first thing down.
  const { data: myParks = [] } = useQuery<any[]>('my-property-list-parks',
    () => apiGet('/property-task-list/my-parks'))
  const [supplyFor, setSupplyFor] = useState<string | null>(null)
  const [supplyText, setSupplyText] = useState('')
  const addSupplyMut = useMutation(
    ({ propertyId, body }: { propertyId: string; body: string }) =>
      apiPost(`/property-task-list/${propertyId}`, { body, kind: 'supply' }),
    { onSuccess: () => { setSupplyText(''); qc.invalidateQueries('my-property-supplies') } })

  const myShift = (shiftData as any)?.myShift
  const activeStaff = (shiftData as any)?.active || []
  const lowStock = (parts as any[]).filter(p => p.quantity <= p.minQuantity)
  const pendingPurchases = (purchases as any[]).filter(p => p.status === 'pending')
  const overdueScheduled = (scheduled as any[]).filter(s => s.nextDue && new Date(s.nextDue) <= new Date())

  // `quiet` is the count that is NOT an alarm. Every other badge here means
  // somebody is behind — parts below reorder level, purchases waiting, a
  // scheduled job overdue — and red is right for those. The park task list is
  // the one count that is just a number of jobs: Nic's rule for it is that
  // "nothing here is late, because nothing here is tracked", and a red chip
  // over it says the opposite of that in the one glance this strip gets.
  const TABS: {id:Tab, label:string, icon:any, badge?:number, quiet?:boolean}[] = [
    { id:'shift',      label:'Shift',       icon:Clock,        badge: activeStaff.length },
    { id:'workorders', label:'Work Orders',  icon:Wrench,       badge: (workOrders as any[]).length },
    // 10/20 (Nic): just "Tasks" now. It was called "Property Tasks" to tell it
    // apart from a landlord-wide Tasks tab that used to sit right here, with
    // due dates and repeats, half-used. Nic's answer to two task lists was the
    // same as his answer to the other duplicated surface that evening — "that
    // doesn't need to be its own tab, that's kind of ridiculous" — so the old
    // one is gone, its open lines are on the parks they belong to, and the
    // qualifier can go with it.
    { id:'propertytasks', label:'Tasks', icon:ClipboardList,
      badge: ((propertyTasks as any[]).length + (supplyLines as any[]).length) || undefined, quiet: true },
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
            {t.badge ? <span style={{ background:t.quiet?'var(--bg-4)':'var(--red)', color:t.quiet?'var(--text-2)':'white', fontSize:'.65rem', fontWeight:700, padding:'1px 5px', borderRadius:10, minWidth:16, textAlign:'center' }}>{t.badge}</span> : null}
          </button>
        ))}
      </div>

      {/* SHIFT TAB */}
      {tab==='shift' && (
        <div>
          {myShift && (
            <div className="card" style={{ marginBottom:16, padding:16, background:'rgba(34,197,94,.06)', border:'1px solid rgba(34,197,94,.2)' }}>
              <div style={{ fontWeight:700, color:'var(--green)', marginBottom:4 }}>✓ You are clocked in</div>
              <div style={{ fontSize:'.78rem', color:'var(--text-3)' }}>Since {new Date(myShift.clockedInAt).toLocaleTimeString()}</div>
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
                      <td><div style={{ fontWeight:600, color:'var(--text-0)' }}>{s.firstName} {s.lastName}</div></td>
                      <td style={{ fontSize:'.78rem', color:'var(--text-3)' }}>{new Date(s.clockedInAt).toLocaleTimeString()}</td>
                      <td className="mono" style={{ fontSize:'.78rem' }}>{parseFloat(s.hoursOnShift).toFixed(1)}h</td>
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
                    <td><div style={{ fontWeight:600 }}>{o.propertyName}</div><div style={{ fontSize:'.72rem', color:'var(--text-3)' }}>Unit {o.unitNumber}</div></td>
                    <td style={{ maxWidth:200 }}><div style={{ fontWeight:600, fontSize:'.82rem' }}>{o.title}</div><div style={{ fontSize:'.72rem', color:'var(--text-3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{o.description}</div></td>
                    <td style={{ fontSize:'.78rem' }}><div>{o.tenantName||'—'}</div>{o.tenantPhone&&<div style={{ color:'var(--text-3)' }}>{o.tenantPhone}</div>}</td>
                    <td><span className={`badge ${PRIORITY_COLORS[o.priority]||'badge-muted'}`}>{humanize(o.priority)}</span></td>
                    <td><span className="badge badge-amber">{humanize(o.status)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* PROPERTY TASKS TAB — 10/20 (Nic, relaying Blu)
          "A list that the maintenance person can consult and check off when
           it's done, kind of running in parallel to maintenance, sitting
           outside of it though."
          The park's checklist, grouped by park because this person works
          several. Read and tick, nothing else: the landlord writes these lines
          (routes/propertyTaskList.ts), and there is no status, priority, due
          date or timer on any of them — Nic: "it's not counting how long it
          takes to get closed after it's been open". */}
      {tab==='propertytasks' && (
        <div>
          <div className="card" style={{ padding:0 }}>
            {(propertyTasks as any[]).length === 0 ? (
              <div className="empty-state" style={{ padding:48 }}>
                <ClipboardList size={40}/>
                <h3>Nothing on the list</h3>
                <p style={{ fontSize:'.8rem', color:'var(--text-3)' }}>
                  Jobs your landlord adds for a property show up here.
                </p>
              </div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
                {Object.entries(
                  (propertyTasks as any[]).reduce((acc: Record<string, any[]>, t: any) => {
                    (acc[t.propertyName] ||= []).push(t); return acc
                  }, {})
                ).map(([parkName, lines]) => (
                  <div key={parkName}>
                    <div style={{ padding:'10px 16px', fontSize:'.72rem', fontWeight:600,
                                  color:'var(--text-3)', borderBottom:'1px solid var(--border-0)' }}>
                      {parkName}
                    </div>
                    {(lines as any[]).map((t:any) => (
                      <div key={t.id} style={{ display:'flex', alignItems:'flex-start', gap:12,
                                               padding:'12px 16px', borderBottom:'1px solid var(--border-0)' }}>
                        <button
                          onClick={()=>tickPropertyTaskMut.mutate({ propertyId: t.propertyId, id: t.id })}
                          disabled={tickPropertyTaskMut.isLoading}
                          title="Mark it done" aria-label="Mark it done"
                          style={{ background:'none', border:'none', padding:0, marginTop:2,
                                   cursor:'pointer', color:'var(--text-3)', lineHeight:0 }}>
                          <Circle size={18}/>
                        </button>
                        <div style={{ flex:1, minWidth:0, fontSize:'.85rem', color:'var(--text-0)',
                                      wordBreak:'break-word' }}>
                          {t.body}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 10/21 (Nic): the shopping list, beside the jobs and not inside
              them — "a collected shopping cart pool... so he doesn't have text
              messages from like 5 or 6 different people." Add what ran out;
              the owner ticks it off when it is bought. */}
          <div className="card" style={{ padding:0, marginTop:16 }}>
            <div style={{ padding:'12px 16px', borderBottom:'1px solid var(--border-0)' }}>
              <div style={{ fontWeight:700, fontSize:'.9rem' }}>Supplies to buy</div>
              <div style={{ fontSize:'.76rem', color:'var(--text-3)', marginTop:2 }}>
                Anything the park needs. It all lands on one list so the owner buys it in one go.
              </div>
            </div>
            {myParks.length === 0 ? (
              <div style={{ padding:'16px', fontSize:'.8rem', color:'var(--text-3)' }}>
                You are not on a park yet, so there is no list to add to.
              </div>
            ) : myParks.map(park => (
              <div key={park.propertyId}>
                <div style={{ padding:'10px 16px', fontSize:'.72rem', fontWeight:600,
                              color:'var(--text-3)', borderBottom:'1px solid var(--border-0)' }}>
                  {park.propertyName}
                </div>
                {(supplyLines as any[]).filter(l => l.propertyId === park.propertyId).map((l:any) => (
                  <div key={l.id} style={{ display:'flex', gap:12, padding:'10px 16px',
                                           borderBottom:'1px solid var(--border-0)', fontSize:'.85rem' }}>
                    <ShoppingCart size={16} style={{ color:'var(--text-3)', flexShrink:0, marginTop:2 }}/>
                    <div style={{ flex:1, minWidth:0, wordBreak:'break-word' }}>{l.body}</div>
                    {l.mine && <span style={{ fontSize:'.7rem', color:'var(--text-3)' }}>yours</span>}
                  </div>
                ))}
                <div style={{ display:'flex', gap:8, padding:'10px 16px', borderBottom:'1px solid var(--border-0)' }}>
                  <input
                    className="form-input"
                    placeholder="Paint brushes, trash bags…"
                    value={supplyFor === park.propertyId ? supplyText : ''}
                    onFocus={()=>setSupplyFor(park.propertyId)}
                    onChange={e=>{ setSupplyFor(park.propertyId); setSupplyText(e.target.value) }}
                    onKeyDown={e=>{
                      if (e.key === 'Enter' && supplyText.trim() && !addSupplyMut.isLoading) {
                        addSupplyMut.mutate({ propertyId: park.propertyId, body: supplyText.trim() })
                      }
                    }}
                    style={{ flex:1, minWidth:0, fontSize:'.85rem' }} />
                  <button className="btn btn-primary btn-sm"
                    disabled={supplyFor !== park.propertyId || !supplyText.trim() || addSupplyMut.isLoading}
                    onClick={()=>addSupplyMut.mutate({ propertyId: park.propertyId, body: supplyText.trim() })}>
                    Add
                  </button>
                </div>
              </div>
            ))}
          </div>
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
                    <tr key={p.id} style={{ background: p.quantity<=p.minQuantity ? 'rgba(239,68,68,.04)' : '' }}>
                      <td><div style={{ fontWeight:600 }}>{p.name}</div>{p.description&&<div style={{ fontSize:'.7rem', color:'var(--text-3)' }}>{p.description}</div>}</td>
                      <td className="mono" style={{ fontSize:'.75rem' }}>{p.sku||'—'}</td>
                      <td style={{ fontSize:'.78rem' }}>{p.location||'—'}</td>
                      <td><span style={{ fontWeight:700, color:p.quantity<=p.minQuantity?'var(--red)':'var(--green)' }}>{p.quantity} {p.unit}</span></td>
                      <td style={{ fontSize:'.78rem', color:'var(--text-3)' }}>{p.minQuantity}</td>
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
                        <td><div style={{ fontWeight:600 }}>{p.requestedByName}</div><div style={{ fontSize:'.7rem', color:'var(--text-3)' }}>{new Date(p.createdAt).toLocaleDateString()}</div></td>
                        <td style={{ fontSize:'.78rem' }}>{items.map((i:any)=>i.name).join(', ')}</td>
                        <td className="mono" style={{ fontSize:'.78rem' }}>{p.totalEstimate ? fmt(p.totalEstimate) : '—'}</td>
                        <td><span className={`badge ${p.status==='approved'?'badge-green':p.status==='denied'?'badge-red':p.status==='purchased'?'badge-blue':'badge-amber'}`}>{humanize(p.status)}</span></td>
                        <td>
                          {p.status==='pending' && (
                            <div style={{ display:'flex', gap:6 }}>
                              <button className="btn btn-primary btn-sm" onClick={()=>approvePurchaseMut.mutate({ id:p.id, budgetLimit:p.totalEstimate })}>Approve</button>
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
                  const overdue = s.nextDue && new Date(s.nextDue) <= new Date()
                  return (
                    <tr key={s.id} style={{ background:overdue?'rgba(239,68,68,.04)':'' }}>
                      <td><div style={{ fontWeight:600 }}>{s.title}</div>{s.description&&<div style={{ fontSize:'.7rem', color:'var(--text-3)' }}>{s.description}</div>}</td>
                      <td style={{ fontSize:'.78rem' }}><div>{s.propertyName||'All properties'}</div>{s.unitNumber&&<div style={{ color:'var(--text-3)' }}>Unit {s.unitNumber}</div>}</td>
                      {/* 10/20: was printing the raw value — "biannual" is a
                          column name, not a word anybody says. */}
                      <td><span className="badge badge-blue">{humanize(s.recurrence)}</span></td>
                      <td style={{ fontSize:'.78rem', color:overdue?'var(--red)':'var(--text-2)', fontWeight:overdue?700:400 }}>{s.nextDue ? new Date(s.nextDue).toLocaleDateString() : '—'}{overdue&&' ⚠️'}</td>
                      <td style={{ fontSize:'.78rem' }}>{s.assignedName||'Unassigned'}</td>
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
