import { useState, CSSProperties } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api'
import { Package, Wrench, Plus, Pencil, Trash2, Check } from 'lucide-react'
import { appConfirm } from '../components/dialogs'

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
const lbl: CSSProperties = { fontSize:'.68rem', fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'.06em', display:'block', marginBottom:4 }
const RECURRENCES = ['weekly','monthly','quarterly','biannual','annual'] as const

const emptyItem = { name:'', sku:'', quantity:'0', minQuantity:'0', unit:'each', location:'', cost:'', description:'' }
const emptySched = { title:'', description:'', recurrence:'quarterly', nextDue:'', propertyId:'' }

// W-46 rebuild (S531): two sections on one surface —
//  • Supplies & Parts: full CRUD on parts_inventory (via /maint-portal/parts,
//    shared with the maintenance staff portal) + opt-in min-quantity targets.
//  • Equipment Service Schedules: scheduled_maintenance rows reused as the
//    serviceable-asset model (a truck's oil change IS a recurring schedule) —
//    no new table. Mark Done advances next_due by the recurrence.
// Daily 9am cron alerts (low_stock + service_due) land back on this page.
// S605 (Nic, DIRECTIVE): "Inventory needs to be scoped to property. It's not a
// shared thing... Property inventory is equipment. It's small tractors, weed
// whackers, tools, other supplies to operate that property."
//
// A landlord with four parks previously saw one undifferentiated list and could
// not answer "which mower is at Oak Park?" — the question the page exists for.
// `embeddedPropertyId` renders it as a tab inside a property, filtered to that
// property's equipment and filing anything new against it automatically.
export function InventoryPage({ embeddedPropertyId }: { embeddedPropertyId?: string } = {}) {
  const qc = useQueryClient()
  const { data: items = [], isLoading } = useQuery<any[]>(
    ['inventory', embeddedPropertyId ?? 'all'],
    () => apiGet(`/maint-portal/parts${embeddedPropertyId ? `?propertyId=${embeddedPropertyId}` : ''}`))
  const { data: scheduled = [] } = useQuery<any[]>('inventory-scheduled', () => apiGet('/maint-portal/scheduled'))
  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))

  const [showItemModal, setShowItemModal] = useState(false)
  const [editingId, setEditingId] = useState<string|null>(null)
  const [form, setForm] = useState<any>(emptyItem)
  const [showSchedModal, setShowSchedModal] = useState(false)
  const [sched, setSched] = useState<any>(emptySched)

  const itemBody = () => ({ name:form.name.trim(), sku:form.sku.trim()||null, description:form.description.trim()||null, unit:form.unit.trim()||'each', location:form.location.trim()||null, quantity:parseInt(form.quantity)||0, minQuantity:parseInt(form.minQuantity)||0, cost:form.cost!=='' ? parseFloat(form.cost) : null,
    // Filed against the property it lives at when added from inside one.
    ...(embeddedPropertyId ? { propertyId: embeddedPropertyId } : {}) })
  const closeItemModal = () => { setShowItemModal(false); setEditingId(null); setForm(emptyItem) }

  const saveItemMut = useMutation(
    () => editingId ? apiPatch(`/maint-portal/parts/${editingId}`, itemBody()) : apiPost('/maint-portal/parts', itemBody()).then(r=>r.data),
    { onSuccess: () => { qc.invalidateQueries('inventory'); closeItemModal() } }
  )
  const deleteItemMut = useMutation((id: string) => apiDelete(`/maint-portal/parts/${id}`), { onSuccess: () => qc.invalidateQueries('inventory') })
  const addSchedMut = useMutation(
    () => apiPost('/maint-portal/scheduled', { title:sched.title.trim(), description:sched.description.trim()||null, recurrence:sched.recurrence, nextDue:sched.nextDue||null, propertyId:sched.propertyId||null }),
    { onSuccess: () => { qc.invalidateQueries('inventory-scheduled'); setShowSchedModal(false); setSched(emptySched) } }
  )
  const completeSchedMut = useMutation((id: string) => apiPatch(`/maint-portal/scheduled/${id}/complete`, {}), { onSuccess: () => qc.invalidateQueries('inventory-scheduled') })

  const openEdit = (p: any) => { setEditingId(p.id); setForm({ name:p.name||'', sku:p.sku||'', quantity:String(p.quantity ?? 0), minQuantity:String(p.minQuantity ?? 0), unit:p.unit||'each', location:p.location||'', cost:p.cost != null ? String(p.cost) : '', description:p.description||'' }); setShowItemModal(true) }

  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
  const lowItems = items.filter((p:any) => Number(p.minQuantity) > 0 && Number(p.quantity) <= Number(p.minQuantity))
  const overdue = scheduled.filter((s:any) => s.nextDue && String(s.nextDue).slice(0,10) <= todayStr)

  return (
    <div>
      <div className="page-header">
        <div>{!embeddedPropertyId && <>
          <h1 className="page-title">Inventory</h1>
          <p className="page-subtitle">Equipment, tools and supplies used to operate your properties — not POS resale stock</p>
        </>}</div>
      </div>

      {/* ── SUPPLIES & PARTS ─────────────────────────────────── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <h2 style={{ fontSize:'.95rem', margin:0, display:'flex', alignItems:'center', gap:8 }}><Package size={16}/> Supplies &amp; Parts</h2>
          {lowItems.length > 0 && <span className="badge badge-amber">{lowItems.length} low</span>}
        </div>
        <button className="btn btn-primary btn-sm" onClick={()=>{ setEditingId(null); setForm(emptyItem); setShowItemModal(true) }}><Plus size={13}/> Add Item</button>
      </div>
      <div className="card" style={{ padding:0, overflowX:'auto', marginBottom:28 }}>
        {isLoading ? <div style={{ padding:32, color:'var(--text-3)', textAlign:'center' }}>Loading…</div> : items.length === 0 ? (
          <div className="empty-state" style={{ padding:48 }}><Package size={40}/><h3>No inventory items yet</h3><p>Add supplies to track stock levels and get low-stock alerts.</p></div>
        ) : (
          <table className="data-table" style={{ minWidth:760 }}>
            <thead><tr><th>Item</th><th>SKU</th><th>Location</th><th>Qty</th><th>Min</th><th>Cost Each</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {items.map((p: any) => {
                const hasMin = Number(p.minQuantity) > 0
                const out = Number(p.quantity) <= 0
                const low = hasMin && Number(p.quantity) <= Number(p.minQuantity)
                return (
                  <tr key={p.id} style={{ background: low || out ? 'rgba(239,68,68,.04)' : '' }}>
                    <td><div style={{ fontWeight:600 }}>{p.name}</div>{p.description && <div style={{ fontSize:'.7rem', color:'var(--text-3)' }}>{p.description}</div>}</td>
                    <td className="mono" style={{ fontSize:'.75rem' }}>{p.sku || '—'}</td>
                    <td style={{ fontSize:'.78rem' }}>{p.location || '—'}</td>
                    <td className="mono"><span style={{ fontWeight:700, color: out ? 'var(--red)' : low ? 'var(--amber)' : 'var(--text-0)' }}>{p.quantity} {p.unit}</span></td>
                    <td className="mono" style={{ fontSize:'.78rem', color:'var(--text-3)' }}>{hasMin ? p.minQuantity : '—'}</td>
                    <td className="mono" style={{ fontSize:'.78rem' }}>{p.cost != null ? fmt(p.cost) : '—'}</td>
                    <td><span className={`badge ${out ? 'badge-red' : low ? 'badge-amber' : 'badge-green'}`}>{out ? 'out of stock' : low ? 'low stock' : 'in stock'}</span></td>
                    <td>
                      <div style={{ display:'flex', gap:4, justifyContent:'flex-end' }}>
                        <button className="btn btn-ghost btn-sm" title="Edit" onClick={()=>openEdit(p)}><Pencil size={12}/></button>
                        <button className="btn btn-ghost btn-sm" title="Delete" style={{ color:'var(--red)' }} onClick={()=>{ appConfirm(`Delete "${p.name}" from inventory? This cannot be undone.`, { danger: true, confirmLabel: 'Delete' }).then(ok => { if (ok) deleteItemMut.mutate(p.id) }) }}><Trash2 size={12}/></button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── EQUIPMENT SERVICE SCHEDULES ──────────────────────── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <h2 style={{ fontSize:'.95rem', margin:0, display:'flex', alignItems:'center', gap:8 }}><Wrench size={16}/> Equipment Service Schedules</h2>
          {overdue.length > 0 && <span className="badge badge-red">{overdue.length} due</span>}
        </div>
        <button className="btn btn-primary btn-sm" onClick={()=>setShowSchedModal(true)}><Plus size={13}/> Add Schedule</button>
      </div>
      <div className="card" style={{ padding:0, overflowX:'auto' }}>
        {scheduled.length === 0 ? (
          <div className="empty-state" style={{ padding:48 }}><Wrench size={40}/><h3>No service schedules</h3><p>Put work trucks, tools, and equipment on a recurring service schedule — oil changes, tune-ups, inspections.</p></div>
        ) : (
          <table className="data-table" style={{ minWidth:720 }}>
            <thead><tr><th>Task</th><th>Property</th><th>Recurrence</th><th>Last Done</th><th>Next Due</th><th></th></tr></thead>
            <tbody>
              {scheduled.map((s: any) => {
                const due = s.nextDue && String(s.nextDue).slice(0,10) <= todayStr
                return (
                  <tr key={s.id} style={{ background: due ? 'rgba(239,68,68,.04)' : '' }}>
                    <td><div style={{ fontWeight:600 }}>{s.title}</div>{s.description && <div style={{ fontSize:'.7rem', color:'var(--text-3)' }}>{s.description}</div>}</td>
                    <td style={{ fontSize:'.78rem' }}>{s.propertyName || '—'}</td>
                    <td style={{ fontSize:'.78rem', textTransform:'capitalize' }}>{s.recurrence}</td>
                    <td style={{ fontSize:'.78rem', color:'var(--text-3)' }}>{s.lastCompleted ? new Date(s.lastCompleted).toLocaleDateString() : 'Never'}</td>
                    <td>{s.nextDue ? <span className={`badge ${due ? 'badge-red' : 'badge-green'}`}>{due ? 'due ' : ''}{new Date(s.nextDue).toLocaleDateString()}</span> : <span style={{ color:'var(--text-3)' }}>—</span>}</td>
                    <td style={{ textAlign:'right' }}>
                      <button className="btn btn-primary btn-sm" disabled={completeSchedMut.isLoading} onClick={()=>completeSchedMut.mutate(s.id)}><Check size={12}/> Mark Done</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── ADD / EDIT ITEM MODAL ────────────────────────────── */}
      {showItemModal && (
        <div className="modal-overlay" onClick={closeItemModal}>
          <div className="modal" style={{ maxWidth:460 }} onClick={e=>e.stopPropagation()}>
            <div className="modal-title">{editingId ? 'Edit Inventory Item' : 'Add Inventory Item'}</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              <div style={{ gridColumn:'1/-1' }}><label style={lbl}>Item Name *</label><input className="input" value={form.name} onChange={e=>setForm((f:any)=>({...f,name:e.target.value}))}/></div>
              <div style={{ gridColumn:'1/-1' }}><label style={lbl}>Description</label><input className="input" value={form.description} onChange={e=>setForm((f:any)=>({...f,description:e.target.value}))}/></div>
              <div><label style={lbl}>SKU</label><input className="input" value={form.sku} onChange={e=>setForm((f:any)=>({...f,sku:e.target.value}))}/></div>
              <div><label style={lbl}>Unit</label><input className="input" value={form.unit} onChange={e=>setForm((f:any)=>({...f,unit:e.target.value}))}/></div>
              <div><label style={lbl}>Quantity</label><input className="input" type="number" min={0} value={form.quantity} onChange={e=>setForm((f:any)=>({...f,quantity:e.target.value}))}/></div>
              <div><label style={lbl}>Min Quantity (alert at)</label><input className="input" type="number" min={0} value={form.minQuantity} onChange={e=>setForm((f:any)=>({...f,minQuantity:e.target.value}))}/></div>
              <div><label style={lbl}>Location</label><input className="input" value={form.location} onChange={e=>setForm((f:any)=>({...f,location:e.target.value}))}/></div>
              <div><label style={lbl}>Cost Each</label><input className="input" type="number" min={0} step="0.01" value={form.cost} onChange={e=>setForm((f:any)=>({...f,cost:e.target.value}))}/></div>
            </div>
            <div style={{ fontSize:'.72rem', color:'var(--text-3)', marginTop:10 }}>Set a min quantity to get a low-stock alert when supply drops to or below it. Leave at 0 for no alerts.</div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={closeItemModal}>Cancel</button>
              <button className="btn btn-primary" disabled={!form.name.trim() || saveItemMut.isLoading} onClick={()=>saveItemMut.mutate()}>{editingId ? 'Save Changes' : 'Add Item'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── ADD SCHEDULE MODAL ───────────────────────────────── */}
      {showSchedModal && (
        <div className="modal-overlay" onClick={()=>setShowSchedModal(false)}>
          <div className="modal" style={{ maxWidth:460 }} onClick={e=>e.stopPropagation()}>
            <div className="modal-title">Add Service Schedule</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              <div style={{ gridColumn:'1/-1' }}><label style={lbl}>Task *</label><input className="input" placeholder="e.g. Work truck — oil change" value={sched.title} onChange={e=>setSched((f:any)=>({...f,title:e.target.value}))}/></div>
              <div style={{ gridColumn:'1/-1' }}><label style={lbl}>Notes</label><input className="input" value={sched.description} onChange={e=>setSched((f:any)=>({...f,description:e.target.value}))}/></div>
              <div><label style={lbl}>Repeats</label>
                <select className="input" value={sched.recurrence} onChange={e=>setSched((f:any)=>({...f,recurrence:e.target.value}))}>
                  {RECURRENCES.map(r => <option key={r} value={r}>{r === 'biannual' ? 'Every 6 months' : r.charAt(0).toUpperCase()+r.slice(1)}</option>)}
                </select>
              </div>
              <div><label style={lbl}>First Due</label><input className="input" type="date" value={sched.nextDue} onChange={e=>setSched((f:any)=>({...f,nextDue:e.target.value}))}/></div>
              <div style={{ gridColumn:'1/-1' }}><label style={lbl}>Property (optional)</label>
                <select className="input" value={sched.propertyId} onChange={e=>setSched((f:any)=>({...f,propertyId:e.target.value}))}>
                  <option value="">— None (business-wide) —</option>
                  {properties.map((p:any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
            <div style={{ fontSize:'.72rem', color:'var(--text-3)', marginTop:10 }}>Marking a task done advances the next due date by its recurrence. You'll get a reminder when service comes due.</div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={()=>setShowSchedModal(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={!sched.title.trim() || !sched.nextDue || addSchedMut.isLoading} onClick={()=>addSchedMut.mutate()}>Add Schedule</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
