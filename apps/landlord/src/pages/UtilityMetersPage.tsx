import { useState, useEffect, CSSProperties } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api'
import { Gauge, Plus, Pencil, Trash2, ClipboardList, Zap, Receipt } from 'lucide-react'

const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'
const lbl: CSSProperties = { fontSize:'.75rem', color:'var(--text-3)', marginBottom:4, display:'block' }

const UTILITY_ICONS: Record<string, string> = { water:'💧', gas:'🔥', electric:'⚡', sewer:'🚰', trash:'🗑️' }
const METHOD_LABEL: Record<string, string> = { submeter:'Sub-metered', rubs:'RUBS', master_bill_to_landlord:'Master (landlord pays)' }
const RUBS_LABEL: Record<string, string> = { occupant_count:'By occupants', sqft:'By sqft', bedrooms:'By bedrooms', equal_split:'Equal split' }
const BILL_STATUS: Record<string, string> = { unbilled:'badge-muted', billed:'badge-amber', paid:'badge-green', waived:'badge-muted' }

const emptyMeter = { utilityType:'electric', label:'', billingMethod:'submeter', ratePerUnit:'', baseFee:'0', rubsAllocationMethod:'' }

// W-36 (S531): the sub-meter workflow's landlord surface — the backend
// (meters, readings, per-unit assignment, bill generation, finalize) was
// complete since S122/S123 but no UI ever reached it. RV spots are always
// sub-metered for electric (Nic: "the platform is useless without it").
export function UtilityMetersPage() {
  const qc = useQueryClient()
  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  const [propertyId, setPropertyId] = useState('')
  useEffect(() => {
    if (!propertyId && (properties as any[]).length === 1) setPropertyId((properties as any[])[0].id)
  }, [properties, propertyId])

  const { data: meters = [], isLoading } = useQuery<any[]>(
    ['utility-meters', propertyId],
    () => apiGet(`/utility/meters?propertyId=${propertyId}`),
    { enabled: !!propertyId }
  )
  const { data: units = [] } = useQuery<any[]>(
    ['units-for-property', propertyId],
    () => apiGet(`/units?propertyId=${propertyId}`),
    { enabled: !!propertyId }
  )
  const { data: bills = [] } = useQuery<any[]>('utility-bills', () => apiGet('/utility/bills'))

  const [meterModal, setMeterModal] = useState<{ editing: any | null } | null>(null)
  const [form, setForm] = useState<any>(emptyMeter)
  const [assignMeter, setAssignMeter] = useState<any | null>(null)
  const [readingMeter, setReadingMeter] = useState<any | null>(null)
  const [historyMeter, setHistoryMeter] = useState<any | null>(null)
  const [cycleMonth, setCycleMonth] = useState(() => {
    const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
  })
  const [genResult, setGenResult] = useState<string | null>(null)

  const invalidate = () => { qc.invalidateQueries(['utility-meters', propertyId]); qc.invalidateQueries('utility-bills') }

  const meterBody = () => ({
    propertyId,
    utilityType: form.utilityType,
    label: form.label.trim(),
    billingMethod: form.billingMethod,
    ratePerUnit: form.ratePerUnit === '' ? null : Number(form.ratePerUnit),
    baseFee: Number(form.baseFee) || 0,
    rubsAllocationMethod: form.billingMethod === 'rubs' ? (form.rubsAllocationMethod || null) : null,
  })
  const saveMeterMut = useMutation(
    () => meterModal?.editing
      ? apiPatch(`/utility/meters/${meterModal.editing.id}`, meterBody())
      : apiPost('/utility/meters', meterBody()),
    { onSuccess: () => { invalidate(); setMeterModal(null); setForm(emptyMeter) },
      onError: (e: any) => alert(e?.response?.data?.error || 'Could not save meter') }
  )
  const deleteMeterMut = useMutation((id: string) => apiDelete(`/utility/meters/${id}`), {
    onSuccess: invalidate,
    onError: (e: any) => alert(e?.response?.data?.error || 'Could not delete meter'),
  })
  const generateMut = useMutation(
    () => apiPost('/utility/generate-bills', { cycleMonth: `${cycleMonth}-01`, propertyId }),
    { onSuccess: (r: any) => { invalidate(); const d = r?.data || []; const made = d.reduce((s2: number, x: any) => s2 + (x.billsCreated ?? x.bills_created ?? 0), 0); setGenResult(`Generated ${made} bill${made === 1 ? '' : 's'} for ${cycleMonth}.`) },
      onError: (e: any) => setGenResult(e?.response?.data?.error || 'Bill generation failed') }
  )
  const finalizeMut = useMutation((id: string) => apiPost(`/utility/bills/${id}/finalize`, {}), {
    onSuccess: () => qc.invalidateQueries('utility-bills'),
    onError: (e: any) => alert(e?.response?.data?.error || 'Could not finalize'),
  })

  const openEdit = (m: any) => {
    setForm({ utilityType: m.utilityType, label: m.label, billingMethod: m.billingMethod,
      ratePerUnit: m.ratePerUnit != null ? String(m.ratePerUnit) : '', baseFee: String(m.baseFee ?? 0),
      rubsAllocationMethod: m.rubsAllocationMethod || '' })
    setMeterModal({ editing: m })
  }

  const propertyBills = (bills as any[]).filter(b => !propertyId || (units as any[]).some(u => u.id === b.unitId))

  return (
    <div>
      <div className="page-header">
        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          <div>
            <h1 className="page-title">Utilities</h1>
            <p className="page-subtitle">Sub-meters, readings, and per-unit utility billing</p>
          </div>
          {(properties as any[]).length > 1 && (
            <select className="form-select" value={propertyId} onChange={e=>setPropertyId(e.target.value)} style={{ width:'auto', minWidth:200 }}>
              <option value="" disabled>Select a property…</option>
              {(properties as any[]).map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </div>
        {propertyId && (
          <button className="btn btn-primary" onClick={()=>{ setForm(emptyMeter); setMeterModal({ editing: null }) }}><Plus size={14}/> Add Meter</button>
        )}
      </div>

      {!propertyId ? (
        <div style={{ padding:'48px 24px', textAlign:'center', color:'var(--text-3)', border:'1px dashed var(--border-1)', borderRadius:12 }}>
          Select a property to manage its meters and utility billing.
        </div>
      ) : (
        <>
          {/* ── METERS ─────────────────────────────────────── */}
          <div className="card" style={{ padding:0, overflowX:'auto', marginBottom:24 }}>
            {isLoading ? <div style={{ padding:32, color:'var(--text-3)', textAlign:'center' }}>Loading…</div> : (meters as any[]).length === 0 ? (
              <div className="empty-state" style={{ padding:48 }}><Gauge size={40}/><h3>No meters yet</h3><p>Add a meter per metered utility — e.g. one electric sub-meter per RV pedestal group, or a RUBS water meter for the property.</p></div>
            ) : (
              <table className="data-table" style={{ minWidth:760 }}>
                <thead><tr><th>Meter</th><th>Billing</th><th>Rate</th><th>Units</th><th>Last Reading Cycle</th><th></th></tr></thead>
                <tbody>
                  {(meters as any[]).map((m:any) => (
                    <tr key={m.id}>
                      <td><div style={{ fontWeight:600 }}>{UTILITY_ICONS[m.utilityType]} {m.label}</div><div style={{ fontSize:'.7rem', color:'var(--text-3)', textTransform:'capitalize' }}>{m.utilityType}</div></td>
                      <td style={{ fontSize:'.78rem' }}>{METHOD_LABEL[m.billingMethod] || m.billingMethod}{m.billingMethod==='rubs' && m.rubsAllocationMethod && <div style={{ fontSize:'.68rem', color:'var(--text-3)' }}>{RUBS_LABEL[m.rubsAllocationMethod]}</div>}</td>
                      <td className="mono" style={{ fontSize:'.78rem' }}>{m.ratePerUnit != null ? `${fmt(m.ratePerUnit)}/unit` : '—'}{Number(m.baseFee) > 0 && <div style={{ fontSize:'.68rem', color:'var(--text-3)' }}>+{fmt(m.baseFee)} base</div>}</td>
                      <td>
                        <button className="btn btn-ghost btn-sm" onClick={()=>setAssignMeter(m)}>{m.unitCount || 0} assigned</button>
                      </td>
                      <td style={{ fontSize:'.78rem', color:'var(--text-3)' }}>{m.lastReadingCycle ? String(m.lastReadingCycle).slice(0,7) : 'Never read'}</td>
                      <td>
                        <div style={{ display:'flex', gap:4, justifyContent:'flex-end' }}>
                          <button className="btn btn-primary btn-sm" onClick={()=>setReadingMeter(m)}><ClipboardList size={12}/> Record Reading</button>
                          <button className="btn btn-ghost btn-sm" title="Reading history" onClick={()=>setHistoryMeter(m)}><Zap size={12}/></button>
                          <button className="btn btn-ghost btn-sm" title="Edit" onClick={()=>openEdit(m)}><Pencil size={12}/></button>
                          <button className="btn btn-ghost btn-sm" title="Delete" style={{ color:'var(--red)' }} onClick={()=>{ if (window.confirm(`Delete meter "${m.label}"? Its readings go with it.`)) deleteMeterMut.mutate(m.id) }}><Trash2 size={12}/></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* ── BILLING ────────────────────────────────────── */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
            <h2 style={{ fontSize:'.95rem', margin:0, display:'flex', alignItems:'center', gap:8 }}><Receipt size={16}/> Utility Bills</h2>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <input className="form-input" type="month" value={cycleMonth} onChange={e=>setCycleMonth(e.target.value)} style={{ width:'auto' }}/>
              <button className="btn btn-primary btn-sm" disabled={generateMut.isLoading || !(meters as any[]).length} onClick={()=>generateMut.mutate()}>
                {generateMut.isLoading ? 'Generating…' : 'Generate Bills'}
              </button>
            </div>
          </div>
          {genResult && <div style={{ fontSize:'.78rem', color:'var(--text-2)', marginBottom:10 }}>{genResult}</div>}
          <div className="card" style={{ padding:0, overflowX:'auto' }}>
            {propertyBills.length === 0 ? (
              <div className="empty-state" style={{ padding:40 }}><Receipt size={36}/><h3>No utility bills</h3><p>Record readings for a cycle, then Generate Bills — each assigned unit gets its share. Finalize sends a bill to the tenant for payment.</p></div>
            ) : (
              <table className="data-table" style={{ minWidth:720 }}>
                <thead><tr><th>Cycle</th><th>Unit</th><th>Meter</th><th>Amount</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {propertyBills.map((b:any) => (
                    <tr key={b.id}>
                      <td className="mono" style={{ fontSize:'.75rem' }}>{String(b.billingCycleMonth).slice(0,7)}</td>
                      <td className="mono">{b.unitNumber}</td>
                      <td style={{ fontSize:'.78rem' }}>{UTILITY_ICONS[b.utilityType]} {b.meterLabel}</td>
                      <td className="mono" style={{ fontWeight:600 }}>{fmt(b.chargeAmount)}</td>
                      <td><span className={`badge ${BILL_STATUS[b.status] || 'badge-muted'}`}>{b.status}</span></td>
                      <td style={{ textAlign:'right' }}>
                        {b.status === 'unbilled' && (
                          <button className="btn btn-primary btn-sm" disabled={finalizeMut.isLoading} onClick={()=>finalizeMut.mutate(b.id)}>Send to Tenant</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* ── ADD/EDIT METER MODAL ─────────────────────────── */}
      {meterModal && (
        <div className="modal-overlay" onClick={()=>setMeterModal(null)}>
          <div className="modal" style={{ maxWidth:460 }} onClick={e=>e.stopPropagation()}>
            <div className="modal-title">{meterModal.editing ? 'Edit Meter' : 'Add Meter'}</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              <div><span style={lbl}>Utility</span>
                <select className="form-select" value={form.utilityType} onChange={e=>setForm((f:any)=>({...f,utilityType:e.target.value}))} style={{ width:'100%' }}>
                  {Object.keys(UTILITY_ICONS).map(t => <option key={t} value={t}>{UTILITY_ICONS[t]} {t[0].toUpperCase()+t.slice(1)}</option>)}
                </select>
              </div>
              <div><span style={lbl}>Label *</span><input className="form-input" placeholder="e.g. Pedestal row A" value={form.label} onChange={e=>setForm((f:any)=>({...f,label:e.target.value}))} style={{ width:'100%' }}/></div>
              <div style={{ gridColumn:'1/-1' }}><span style={lbl}>Billing Method</span>
                <select className="form-select" value={form.billingMethod} onChange={e=>setForm((f:any)=>({...f,billingMethod:e.target.value}))} style={{ width:'100%' }}>
                  <option value="submeter">Sub-metered — bill each unit its own usage</option>
                  <option value="rubs">RUBS — split a master meter across units</option>
                  <option value="master_bill_to_landlord">Master — landlord pays, no tenant billing</option>
                </select>
              </div>
              {form.billingMethod === 'rubs' && (
                <div style={{ gridColumn:'1/-1' }}><span style={lbl}>RUBS Allocation *</span>
                  <select className="form-select" value={form.rubsAllocationMethod} onChange={e=>setForm((f:any)=>({...f,rubsAllocationMethod:e.target.value}))} style={{ width:'100%' }}>
                    <option value="" disabled>Choose allocation…</option>
                    {Object.entries(RUBS_LABEL).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
              )}
              <div><span style={lbl}>Rate per unit used ($)</span><input className="form-input" type="number" min={0} step="0.0001" placeholder="e.g. 0.14 per kWh" value={form.ratePerUnit} onChange={e=>setForm((f:any)=>({...f,ratePerUnit:e.target.value}))} style={{ width:'100%' }}/></div>
              <div><span style={lbl}>Base fee per cycle ($)</span><input className="form-input" type="number" min={0} step="0.01" value={form.baseFee} onChange={e=>setForm((f:any)=>({...f,baseFee:e.target.value}))} style={{ width:'100%' }}/></div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={()=>setMeterModal(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={!form.label.trim() || (form.billingMethod==='rubs' && !form.rubsAllocationMethod) || saveMeterMut.isLoading} onClick={()=>saveMeterMut.mutate()}>
                {meterModal.editing ? 'Save Changes' : 'Add Meter'}
              </button>
            </div>
          </div>
        </div>
      )}

      {assignMeter && (
        <AssignUnitsModal meter={assignMeter} units={units as any[]} onClose={()=>{ setAssignMeter(null); invalidate() }} />
      )}
      {readingMeter && (
        <RecordReadingModal meter={readingMeter} onClose={()=>{ setReadingMeter(null); invalidate() }} />
      )}
      {historyMeter && (
        <ReadingHistoryModal meter={historyMeter} onClose={()=>setHistoryMeter(null)} />
      )}
    </div>
  )
}

function AssignUnitsModal({ meter, units, onClose }: { meter: any; units: any[]; onClose: () => void }) {
  const [assigned, setAssigned] = useState<Set<string>>(new Set(meter.assignedUnitIds || []))
  const [busy, setBusy] = useState(false)
  const toggle = async (unitId: string) => {
    setBusy(true)
    try {
      if (assigned.has(unitId)) {
        await apiDelete(`/utility/meters/${meter.id}/units/${unitId}`)
        setAssigned(prev => { const n = new Set(prev); n.delete(unitId); return n })
      } else {
        await apiPost(`/utility/meters/${meter.id}/units`, { unitId })
        setAssigned(prev => new Set(prev).add(unitId))
      }
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Could not update assignment')
    } finally { setBusy(false) }
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth:440 }} onClick={e=>e.stopPropagation()}>
        <div className="modal-title">Units on {meter.label}</div>
        <div style={{ fontSize:'.75rem', color:'var(--text-3)', marginBottom:12 }}>Assigned units share this meter's bills per its billing method.</div>
        <div style={{ maxHeight:320, overflowY:'auto', display:'grid', gap:6 }}>
          {units.map((u:any) => (
            <label key={u.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', borderRadius:8, background:'var(--bg-2)', cursor:'pointer', opacity: busy ? .6 : 1 }}>
              <input type="checkbox" checked={assigned.has(u.id)} disabled={busy} onChange={()=>toggle(u.id)} />
              <span style={{ fontSize:'.85rem', fontWeight:600 }}>Unit {u.unitNumber}</span>
              <span style={{ fontSize:'.72rem', color:'var(--text-3)', marginLeft:'auto', textTransform:'capitalize' }}>{u.status}</span>
            </label>
          ))}
        </div>
        <div className="modal-footer"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  )
}

function RecordReadingModal({ meter, onClose }: { meter: any; onClose: () => void }) {
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` })()
  const [readingDate, setReadingDate] = useState(today)
  const [readingValue, setReadingValue] = useState('')
  const [cycle, setCycle] = useState(today.slice(0,7))
  const mut = useMutation(
    () => apiPost(`/utility/meters/${meter.id}/readings`, { readingDate, readingValue: Number(readingValue), billingCycleMonth: `${cycle}-01` }),
    { onSuccess: onClose, onError: (e: any) => alert(e?.response?.data?.error || 'Could not record reading') }
  )
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth:400 }} onClick={e=>e.stopPropagation()}>
        <div className="modal-title">Record Reading — {meter.label}</div>
        <div style={{ display:'grid', gap:10 }}>
          <div><span style={lbl}>Reading date</span><input className="form-input" type="date" value={readingDate} onChange={e=>setReadingDate(e.target.value)} style={{ width:'100%' }}/></div>
          <div><span style={lbl}>Meter value</span><input className="form-input" type="number" step="0.01" placeholder="e.g. 48213.5" value={readingValue} onChange={e=>setReadingValue(e.target.value)} style={{ width:'100%' }}/></div>
          <div><span style={lbl}>Billing cycle</span><input className="form-input" type="month" value={cycle} onChange={e=>setCycle(e.target.value)} style={{ width:'100%' }}/></div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={readingValue === '' || mut.isLoading} onClick={()=>mut.mutate()}>Record</button>
        </div>
      </div>
    </div>
  )
}

function ReadingHistoryModal({ meter, onClose }: { meter: any; onClose: () => void }) {
  const { data: readings = [], isLoading } = useQuery<any[]>(
    ['meter-readings', meter.id], () => apiGet(`/utility/meters/${meter.id}/readings`))
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth:460 }} onClick={e=>e.stopPropagation()}>
        <div className="modal-title">Readings — {meter.label}</div>
        {isLoading ? <div style={{ color:'var(--text-3)', padding:16 }}>Loading…</div> : (readings as any[]).length === 0 ? (
          <div style={{ color:'var(--text-3)', padding:16, fontSize:'.82rem' }}>No readings recorded yet.</div>
        ) : (
          <div style={{ maxHeight:360, overflowY:'auto' }}>
            <table className="data-table">
              <thead><tr><th>Cycle</th><th>Date</th><th>Value</th></tr></thead>
              <tbody>
                {(readings as any[]).map((r:any) => (
                  <tr key={r.id}>
                    <td className="mono" style={{ fontSize:'.75rem' }}>{String(r.billingCycleMonth).slice(0,7)}</td>
                    <td className="mono" style={{ fontSize:'.75rem' }}>{String(r.readingDate).slice(0,10)}</td>
                    <td className="mono" style={{ fontWeight:600 }}>{Number(r.readingValue).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="modal-footer"><button className="btn btn-ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  )
}
