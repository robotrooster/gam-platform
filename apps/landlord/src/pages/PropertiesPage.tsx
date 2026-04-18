import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { Building2, Plus, MapPin, Home, ChevronRight, DoorOpen, Users, DollarSign, X, Check, Edit2 } from 'lucide-react'
import { AddUnitModal } from './AddUnitModal'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

const PROPERTY_TYPES = [
  { value: 'residential',  label: '🏠 Residential',     desc: 'Apartments, houses, condos' },
  { value: 'rv_longterm',  label: '🚐 RV Long-term',    desc: '3+ month stays' },
  { value: 'rv_weekly',    label: '🏕️ RV Weekly',       desc: 'Weekly billing' },
  { value: 'rv_nightly',   label: '⭐ RV Nightly',      desc: 'Nightly / short-term' },
]

const AMENITIES = [
  'Pool', 'Laundry', 'Parking', 'Pet Friendly', 'WiFi', 'Gym',
  'Playground', 'Storage', 'Gated', 'Clubhouse', 'BBQ Area',
  'Dog Park', 'EV Charging', 'Boat Storage', 'RV Hookups', 'Propane'
]

const TYPE_COLORS: Record<string, string> = {
  residential: 'var(--blue)',
  rv_longterm: 'var(--green)',
  rv_weekly:   'var(--amber)',
  rv_nightly:  'var(--gold)',
}

const UNIT_TYPES = [
  { value: 'apartment',   label: 'Apartment',   prefix: 'APT', icon: '🏢' },
  { value: 'house',       label: 'House',        prefix: 'HSE', icon: '🏠' },
  { value: 'mobile_home', label: 'Mobile Home',  prefix: 'MH',  icon: '🏡' },
  { value: 'rv_spot',     label: 'RV Spot',      prefix: 'RV',  icon: '🚐' },
  { value: 'storage',     label: 'Storage',      prefix: 'STG', icon: '📦' },
  { value: 'commercial',  label: 'Commercial',   prefix: 'COM', icon: '🏪' },
  { value: 'other',       label: 'Other',        prefix: 'UNIT',icon: '🔑' },
]

function AddEditModal({ property, onClose }: { property?: any; onClose: () => void }) {
  const qc = useQueryClient()
  const isEdit = !!property
  const [step, setStep] = useState<1|2>(1)
  const [createdPropId, setCreatedPropId] = useState<string|null>(null)
  const [form, setForm] = useState({
    name:        property?.name || '',
    street1:     property?.street1 || '',
    street2:     property?.street2 || '',
    city:        property?.city || '',
    state:       property?.state || 'AZ',
    zip:         property?.zip || '',
    description: property?.description || '',
    amenities:   property?.amenities || [] as string[],
    unit_types:  property?.unit_types || [] as string[],
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [addrSuggestions, setAddrSuggestions] = useState<any[]>([])
  const [showAddrSugg, setShowAddrSugg] = useState(false)
  const [addrVerified, setAddrVerified] = useState(false)
  const MAPBOX_TOKEN = (import.meta as any).env?.VITE_MAPBOX_TOKEN || ''
  const addrTimer = useRef<any>(null)
  // Step 2: unit groups — one per selected type
  const [batches, setBatches] = useState<Array<{ id: string; type: string; count: string; prefix: string; rentAmount: string; securityDeposit: string; bedrooms: string }>>([])  

  const propMut = useMutation(
    (data: any) => isEdit ? apiPatch(`/properties/${property.id}`, data) : apiPost('/properties', data),
    {
      onSuccess: (res: any) => {
        qc.invalidateQueries('properties')
        if (isEdit) { onClose(); return }
        const pid = res?.data?.id || res?.id
        if (pid && form.unit_types.length > 0) {
          setCreatedPropId(pid)
          // Init unit groups
          const groups: Record<string, any> = {}
          form.unit_types.forEach((t: string) => {
            const ut = UNIT_TYPES.find(u => u.value === t)
            groups[t] = { count: '', prefix: ut?.prefix || 'UNIT', rentAmount: '', securityDeposit: '' }
          })
          // Init one batch per selected type
          const initBatches = form.unit_types.map((t: string) => {
            const ut = UNIT_TYPES.find((u: any) => u.value === t)
            return { id: Math.random().toString(36).slice(2), type: t, count: '', prefix: ut?.prefix || 'UNIT', rentAmount: '', securityDeposit: '', bedrooms: '' }
          })
          setBatches(initBatches)
          setStep(2)
        } else {
          onClose()
        }
      }
    }
  )

  const bulkMut = useMutation(
    (data: any) => apiPost(`/properties/${createdPropId}/units/bulk`, data),
    { onSuccess: () => { qc.invalidateQueries('properties'); qc.invalidateQueries('units'); onClose() } }
  )

  const set = (k: string, v: any) => { setForm(f => ({ ...f, [k]: v })); setErrors(e => ({ ...e, [k]: '' })) }
  const toggleAmenity = (a: string) => set('amenities', form.amenities.includes(a) ? form.amenities.filter((x: string) => x !== a) : [...form.amenities, a])
  const toggleUnitType = (t: string) => set('unit_types', form.unit_types.includes(t) ? form.unit_types.filter((x: string) => x !== t) : [...form.unit_types, t])

  const searchAddr = async (val: string) => {
    if (val.length < 3) { setAddrSuggestions([]); setShowAddrSugg(false); return }
    try {
      const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(val)}.json?access_token=${MAPBOX_TOKEN}&country=us&types=address&limit=5`)
      const data = await res.json()
      setAddrSuggestions(data.features || [])
      setShowAddrSugg((data.features || []).length > 0)
    } catch { setAddrSuggestions([]); setShowAddrSugg(false) }
  }

  const pickAddr = (s: any) => {
    const ctx = s.context || []
    const getCtx = (id: string) => ctx.find((c: any) => c.id.startsWith(id))?.text || ''
    const street = s.place_name ? s.place_name.split(',')[0] : s.text || ''
    const city = getCtx('place')
    const stateShort = ctx.find((c: any) => c.id.startsWith('region'))?.short_code?.replace('US-', '') || form.state
    const zip = getCtx('postcode')
    setForm(f => ({ ...f, street1: street || f.street1, city: city || f.city, state: stateShort || f.state, zip: zip || f.zip }))
    setAddrSuggestions([]); setShowAddrSugg(false); setAddrVerified(true)
    setErrors(e => ({ ...e, street1: '', city: '', zip: '' }))
  }

  const submitStep1 = () => {
    const errs: Record<string, string> = {}
    if (!form.name.trim())    errs.name    = 'Required'
    if (!form.street1.trim()) errs.street1 = 'Required'
    if (!form.city.trim())    errs.city    = 'Required'
    if (!form.zip.trim())     errs.zip     = 'Required'
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    propMut.mutate(form)
  }

  const submitStep2 = () => {
    const groups = batches
      .filter(b => b.count && parseInt(b.count) > 0)
      .map(b => ({
        type: b.type,
        count: parseInt(b.count),
        prefix: b.prefix,
        rentAmount: b.rentAmount ? parseFloat(b.rentAmount) : null,
        securityDeposit: b.securityDeposit ? parseFloat(b.securityDeposit) : null,
        bedrooms: b.bedrooms ? parseInt(b.bedrooms) : null,
      }))
    if (!groups.length) { onClose(); return }
    bulkMut.mutate({ unitGroups: groups })
  }

  const addBatch = (type: string) => {
    const ut = UNIT_TYPES.find(u => u.value === type)
    setBatches(b => [...b, { id: Math.random().toString(36).slice(2), type, count: '', prefix: ut?.prefix || 'UNIT', rentAmount: '', securityDeposit: '', bedrooms: '' }])
  }

  const removeBatch = (id: string) => setBatches(b => b.filter(x => x.id !== id))

  const setBatch = (id: string, k: string, v: string) => setBatches(b => b.map(x => x.id === id ? { ...x, [k]: v } : x))

  const lbl = { fontSize: '.72rem' as const, fontWeight: 600 as const, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.06em', display: 'block' as const, marginBottom: 5 }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 680, width: '95vw' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>
            {isEdit ? 'Edit Property' : step === 1 ? 'Add Property' : 'Create Units'}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>

        {!isEdit && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
            {['Property Details', 'Create Units'].map((s, i) => (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '.65rem', fontWeight: 700, background: step > i+1 ? 'var(--green)' : step === i+1 ? 'var(--gold)' : 'var(--bg-3)', color: step >= i+1 ? '#000' : 'var(--text-3)' }}>{i+1}</div>
                <span style={{ fontSize: '.72rem', color: step === i+1 ? 'var(--text-0)' : 'var(--text-3)', fontWeight: step === i+1 ? 600 : 400 }}>{s}</span>
                {i < 1 && <div style={{ width: 20, height: 1, background: 'var(--border-0)', margin: '0 2px' }} />}
              </div>
            ))}
          </div>
        )}

        {step === 1 && <>
          {/* Unit Types — full width up top */}
          {!isEdit && (
            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Unit Types <span style={{ fontWeight: 400, textTransform: 'none' }}>(select all that apply)</span></label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
                {UNIT_TYPES.map(t => {
                  const on = form.unit_types.includes(t.value)
                  return (
                    <div key={t.value} onClick={() => toggleUnitType(t.value)} style={{ padding: '6px 8px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${on ? 'var(--gold)' : 'var(--border-0)'}`, background: on ? 'rgba(201,162,39,.08)' : 'var(--bg-2)', textAlign: 'center', transition: 'all .12s' }}>
                      <div style={{ fontSize: '1rem', marginBottom: 1 }}>{t.icon}</div>
                      <div style={{ fontSize: '.65rem', fontWeight: 600, color: on ? 'var(--gold)' : 'var(--text-2)' }}>{t.label}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Two-column grid: address on left, meta on right */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 12 }}>

            {/* LEFT: Name, Street, Suite */}
            <div>
              <div style={{ marginBottom: 10 }}>
                <label style={lbl}>Property Name *</label>
                <input className="input" placeholder="Oak Street Apartments" value={form.name} onChange={e => set('name', e.target.value)} style={{ width: '100%' }} autoFocus />
                {errors.name && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.name}</div>}
              </div>

              <div style={{ marginBottom: 10, position: 'relative' }}>
                <label style={lbl}>Street Address * {addrVerified && <span style={{ color: 'var(--green)', fontWeight: 400, textTransform: 'none' }}>✓ Verified</span>}</label>
                <input className="input" placeholder="4821 W Oak St" value={form.street1}
                  onChange={e => { const v = e.target.value; set('street1', v); setAddrVerified(false); clearTimeout(addrTimer.current); addrTimer.current = setTimeout(() => searchAddr(v), 300) }}
                  onBlur={() => setTimeout(() => setShowAddrSugg(false), 200)}
                  style={{ width: '100%', borderColor: addrVerified ? 'var(--green)' : undefined }} />
                {showAddrSugg && addrSuggestions.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'var(--bg-1)', border: '1px solid var(--border-1)', borderRadius: 8, zIndex: 100, overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,.4)' }}>
                    {addrSuggestions.map((s, i) => (
                      <div key={i} onMouseDown={() => pickAddr(s)} style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: i < addrSuggestions.length-1 ? '1px solid var(--border-0)' : 'none' }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--bg-3)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                        <div style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--text-0)' }}>{s.place_name?.split(',')[0] || s.text}</div>
                        <div style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>{s.place_name?.split(',').slice(1, 3).join(',').trim()}</div>
                      </div>
                    ))}
                  </div>
                )}
                {errors.street1 && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.street1}</div>}
              </div>

              <div>
                <label style={lbl}>Suite / Unit / Lot</label>
                <input className="input" placeholder="Suite 100" value={form.street2} onChange={e => set('street2', e.target.value)} style={{ width: '100%' }} />
              </div>
            </div>

            {/* RIGHT: City/State/Zip + Amenities */}
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 56px 80px', gap: 8, marginBottom: 10 }}>
                <div>
                  <label style={lbl}>City *</label>
                  <input className="input" placeholder="Phoenix" value={form.city} onChange={e => set('city', e.target.value)} style={{ width: '100%' }} />
                  {errors.city && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.city}</div>}
                </div>
                <div>
                  <label style={lbl}>State</label>
                  <input className="input" placeholder="AZ" value={form.state} onChange={e => set('state', e.target.value)} style={{ width: '100%' }} />
                </div>
                <div>
                  <label style={lbl}>ZIP *</label>
                  <input className="input" placeholder="85031" value={form.zip} onChange={e => set('zip', e.target.value)} style={{ width: '100%' }} />
                  {errors.zip && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.zip}</div>}
                </div>
              </div>

              <div>
                <label style={lbl}>Amenities</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {AMENITIES.map(a => {
                    const on = form.amenities.includes(a)
                    return (
                      <button key={a} type="button" onClick={() => toggleAmenity(a)} style={{ padding: '3px 9px', borderRadius: 20, fontSize: '.7rem', fontWeight: 600, cursor: 'pointer', transition: 'all .12s', border: `1px solid ${on ? 'rgba(201,162,39,.4)' : 'var(--border-0)'}`, background: on ? 'rgba(201,162,39,.1)' : 'var(--bg-2)', color: on ? 'var(--gold)' : 'var(--text-3)' }}>
                        {on && '✓ '}{a}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>

          </div>

          {propMut.isError && (
            <div style={{ color: 'var(--red)', fontSize: '.75rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
              Failed to save property. Please try again.
            </div>
          )}

          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={submitStep1} disabled={propMut.isLoading}>
              {propMut.isLoading ? <span className="spinner" /> : <><Check size={14} /> {isEdit ? 'Save Changes' : form.unit_types.length > 0 ? 'Next: Create Units →' : 'Add Property'}</>}
            </button>
          </div>
        </>}

        {step === 2 && <>
          <div style={{ fontSize: '.82rem', color: 'var(--text-3)', marginBottom: 16 }}>
            Add batches for each unit type. Each batch can have a different price — e.g. 20 storage units at $100/mo and 30 at $150/mo. Unit numbers auto-assigned; fill in details per unit later.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {form.unit_types.map((type: string) => {
              const ut = UNIT_TYPES.find((u: any) => u.value === type)!
              const typeBatches = batches.filter(b => b.type === type)
              const showBeds = ['apartment','house','mobile_home'].includes(type)
              return (
                <div key={type} style={{ padding: 14, background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '1.1rem' }}>{ut.icon}</span>
                      <span style={{ fontWeight: 700, color: 'var(--text-0)', fontSize: '.88rem' }}>{ut.label}</span>
                    </div>
                    <button className="btn btn-ghost btn-sm" type="button" onClick={() => addBatch(type)} style={{ fontSize: '.72rem' }}>+ Add Batch</button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {typeBatches.map((b, bi) => (
                      <div key={b.id} style={{ padding: '10px 12px', background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <span style={{ fontSize: '.7rem', color: 'var(--text-3)', fontWeight: 600 }}>Batch {bi + 1}</span>
                          {typeBatches.length > 1 && <button type="button" onClick={() => removeBatch(b.id)} style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: '.75rem' }}>✕ Remove</button>}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: showBeds ? '70px 70px 70px 1fr 1fr' : '70px 70px 1fr 1fr', gap: 8 }}>
                          <div>
                            <label style={lbl}>Count *</label>
                            <input className="input" type="number" min="1" placeholder="0" value={b.count} onChange={e => setBatch(b.id, 'count', e.target.value)} style={{ width: '100%' }} />
                          </div>
                          <div>
                            <label style={lbl}>Prefix</label>
                            <input className="input" placeholder={ut.prefix} value={b.prefix} onChange={e => setBatch(b.id, 'prefix', e.target.value)} style={{ width: '100%' }} />
                          </div>
                          {showBeds && (
                            <div>
                              <label style={lbl}>Beds</label>
                              <select className="input" value={b.bedrooms} onChange={e => setBatch(b.id, 'bedrooms', e.target.value)} style={{ width: '100%' }}>
                                <option value="">—</option>
                                {[0,1,2,3,4,5].map(n => <option key={n} value={n}>{n === 0 ? 'Studio' : n}</option>)}
                              </select>
                            </div>
                          )}
                          <div>
                            <label style={lbl}>Rent/mo</label>
                            <input className="input" type="number" placeholder="0.00" value={b.rentAmount} onChange={e => setBatch(b.id, 'rentAmount', e.target.value)} style={{ width: '100%' }} />
                          </div>
                          <div>
                            <label style={lbl}>Deposit</label>
                            <input className="input" type="number" placeholder="0.00" value={b.securityDeposit} onChange={e => setBatch(b.id, 'securityDeposit', e.target.value)} style={{ width: '100%' }} />
                          </div>
                        </div>
                        {b.count && parseInt(b.count) > 0 && (
                          <div style={{ marginTop: 6, fontSize: '.68rem', color: 'var(--text-3)' }}>
                            Creates: {Array.from({ length: Math.min(parseInt(b.count), 3) }, (_, i) => `${b.prefix}-${String(i+1).padStart(2,'0')}`).join(', ')}{parseInt(b.count) > 3 ? ` … ${b.prefix}-${String(parseInt(b.count)).padStart(2,'0')}` : ''} ({b.count} units)
                          </div>
                        )}
                      </div>
                    ))}
                    {typeBatches.length === 0 && (
                      <div style={{ padding: '10px', textAlign: 'center', color: 'var(--text-3)', fontSize: '.78rem', border: '1px dashed var(--border-0)', borderRadius: 8 }}>
                        Click "Add Batch" to add units of this type
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {bulkMut.isError && (
            <div style={{ color: 'var(--red)', fontSize: '.75rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginTop: 12 }}>
              Failed to create units. Please try again.
            </div>
          )}

          <div className="modal-footer" style={{ marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={onClose}>Skip — Add Units Later</button>
            <button className="btn btn-primary" onClick={submitStep2} disabled={bulkMut.isLoading}>
              {bulkMut.isLoading ? <span className="spinner" /> : <><Check size={14} /> Create Units</>}
            </button>
          </div>
        </>}
      </div>
    </div>
  )
}

export function PropertiesPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [showAdd, setShowAdd] = useState(false)
  const [editProp, setEditProp] = useState<any>(null)
  const [addUnitForProp, setAddUnitForProp] = useState<any>(null)

  const { data: props = [], isLoading } = useQuery<any[]>('properties', () => apiGet('/properties'))
  const { data: units = [] } = useQuery<any[]>('units', () => apiGet('/units'))

  // Compute stats per property
  const propStats = (props as any[]).map(p => {
    const propUnits = (units as any[]).filter(u => u.property_id === p.id)
    const occupied  = propUnits.filter(u => u.tenant_id).length
    const vacant    = propUnits.filter(u => !u.tenant_id).length
    const monthlyRevenue = propUnits.filter(u => u.tenant_id).reduce((s, u) => s + parseFloat(u.rent_amount || 0), 0)
    return { ...p, totalUnits: propUnits.length, occupied, vacant, monthlyRevenue }
  })

  const totalUnits    = propStats.reduce((s, p) => s + p.totalUnits, 0)
  const totalOccupied = propStats.reduce((s, p) => s + p.occupied, 0)
  const totalRevenue  = propStats.reduce((s, p) => s + p.monthlyRevenue, 0)
  const superMaxRevenue = (units as any[]).reduce((s, u) => s + parseFloat(u.rent_amount||0), 0)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Properties</h1>
          <p className="page-subtitle">{(props as any[]).length} properties · {totalUnits} units · {totalOccupied} occupied</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
          <Plus size={15} /> Add Property
        </button>
      </div>

      {/* Summary stats */}
      {(props as any[]).length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 12, marginBottom: 24 }}>
          {[
            { label: 'Properties',       val: (props as any[]).length,                       color: 'var(--gold)' },
            { label: 'Total Units',      val: totalUnits,                                     color: 'var(--text-0)' },
            { label: 'Occupied',         val: `${totalOccupied} / ${totalUnits}`,             color: 'var(--green)' },
            { label: 'Monthly Revenue',  val: fmt(totalRevenue),                   color: 'var(--gold)' },
            { label: 'Max Potential',      val: fmt(superMaxRevenue),              color: 'var(--text-3)' },
          ].map(s => (
            <div key={s.label} className="card" style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: '.65rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>{s.label}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.1rem', fontWeight: 700, color: s.color }}>{s.val}</div>
            </div>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>Loading…</div>
      ) : propStats.length === 0 ? (
        <div className="empty-state">
          <Building2 size={48} />
          <h3>No properties yet</h3>
          <p>Add your first property to start managing units and enrolling tenants in On-Time Pay.</p>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}><Plus size={14} /> Add First Property</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {propStats.map((p: any) => {
            const typeColor = TYPE_COLORS[p.type] || 'var(--gold)'
            const typeLabel = PROPERTY_TYPES.find(t => t.value === p.type)?.label || p.type
            const occupancyPct = p.totalUnits > 0 ? (p.occupied / p.totalUnits) * 100 : 0

            return (
              <div key={p.id} className="card" style={{ padding: 0, overflow: 'hidden', cursor: 'pointer', transition: 'all .15s' }} onClick={() => navigate(`/properties/${p.id}`)}
                onMouseEnter={e => (e.currentTarget as any).style.transform = 'translateY(-2px)'}
                onMouseLeave={e => (e.currentTarget as any).style.transform = ''}
              >
                {/* Color bar */}
                <div style={{ height: 3, background: `linear-gradient(90deg, ${typeColor}80, ${typeColor})` }} />

                <div style={{ padding: 16 }}>
                  {/* Header */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 10, background: `${typeColor}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Building2 size={18} style={{ color: typeColor }} />
                      </div>
                      <div>
                        <div style={{ fontSize: '.9rem', fontWeight: 700, color: 'var(--text-0)' }}>{p.name}</div>
                        <div style={{ fontSize: '.7rem', color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 3, marginTop: 1 }}>
                          <MapPin size={9} /> {p.street1}, {p.city}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); setEditProp(p) }} style={{ padding: '4px 8px' }}>
                        <Edit2 size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Type badge */}
                  <div style={{ marginBottom: 12 }}>
                    <span style={{ fontSize: '.65rem', padding: '2px 8px', borderRadius: 10, background: `${typeColor}15`, border: `1px solid ${typeColor}40`, color: typeColor, fontWeight: 700 }}>
                      {typeLabel}
                    </span>
                  </div>

                  {/* Stats */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 12 }}>
                    {[
                      { icon: <DoorOpen size={13} />, val: p.totalUnits,  label: 'Units' },
                      { icon: <Users size={13} />,    val: p.occupied,    label: 'Occupied' },
                      { icon: <DollarSign size={13} />, val: fmt(p.monthlyRevenue), label: 'Revenue' },
                    ].map(s => (
                      <div key={s.label} style={{ background: 'var(--bg-2)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, color: 'var(--text-3)', marginBottom: 3 }}>{s.icon}</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.82rem', fontWeight: 700, color: 'var(--text-0)' }}>{s.val}</div>
                        <div style={{ fontSize: '.6rem', color: 'var(--text-3)' }}>{s.label}</div>
                      </div>
                    ))}
                  </div>

                  {/* Occupancy bar */}
                  {p.totalUnits > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.65rem', color: 'var(--text-3)', marginBottom: 4 }}>
                        <span>Occupancy</span>
                        <span style={{ color: occupancyPct >= 80 ? 'var(--green)' : 'var(--amber)' }}>{Math.round(occupancyPct)}%</span>
                      </div>
                      <div style={{ height: 4, background: 'var(--bg-3)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${occupancyPct}%`, background: occupancyPct >= 80 ? 'var(--green)' : 'var(--amber)', borderRadius: 2, transition: 'width .3s' }} />
                      </div>
                    </div>
                  )}

                  {/* Amenities */}
                  {p.amenities?.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
                      {p.amenities.slice(0,5).map((a: string) => (
                        <span key={a} style={{ fontSize: '.62rem', padding: '2px 6px', borderRadius: 10, background: 'var(--bg-3)', color: 'var(--text-3)', border: '1px solid var(--border-0)' }}>{a}</span>
                      ))}
                      {p.amenities.length > 5 && <span style={{ fontSize: '.62rem', color: 'var(--text-3)' }}>+{p.amenities.length - 5} more</span>}
                    </div>
                  )}

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-ghost btn-sm" style={{ flex: 1 }} onClick={e => { e.stopPropagation(); navigate(`/properties/${p.id}`) }}>
                      <DoorOpen size={13} /> View Units
                    </button>
                    <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={e => { e.stopPropagation(); setAddUnitForProp(p) }}>
                      <Plus size={13} /> Add Unit
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showAdd && <AddEditModal onClose={() => setShowAdd(false)} />}
      {editProp && <AddEditModal property={editProp} onClose={() => setEditProp(null)} />}
      {addUnitForProp && <AddUnitModal preselectedPropertyId={addUnitForProp.id} onClose={() => setAddUnitForProp(null)} />}
    </div>
  )
}
