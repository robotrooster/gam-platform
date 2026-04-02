import { useState } from 'react'
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

function AddEditModal({ property, onClose }: { property?: any; onClose: () => void }) {
  const qc = useQueryClient()
  const isEdit = !!property
  const [form, setForm] = useState({
    name:        property?.name || '',
    street1:     property?.street1 || '',
    street2:     property?.street2 || '',
    city:        property?.city || '',
    state:       property?.state || 'AZ',
    zip:         property?.zip || '',
    type:        property?.type || 'residential',
    description: property?.description || '',
    amenities:   property?.amenities || [] as string[],
  })
  const [errors, setErrors] = useState<Record<string, string>>({})

  const mut = useMutation(
    (data: any) => isEdit ? apiPatch(`/properties/${property.id}`, data) : apiPost('/properties', data),
    { onSuccess: () => { qc.invalidateQueries('properties'); onClose() } }
  )

  const set = (k: string, v: any) => { setForm(f => ({ ...f, [k]: v })); setErrors(e => ({ ...e, [k]: '' })) }

  const toggleAmenity = (a: string) => set('amenities', form.amenities.includes(a) ? form.amenities.filter((x: string) => x !== a) : [...form.amenities, a])

  const submit = () => {
    const errs: Record<string, string> = {}
    if (!form.name.trim())   errs.name    = 'Required'
    if (!form.street1.trim()) errs.street1 = 'Required'
    if (!form.city.trim())   errs.city    = 'Required'
    if (!form.zip.trim())    errs.zip     = 'Required'
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    mut.mutate(form)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560, width: '95vw', maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>{isEdit ? 'Edit Property' : 'Add Property'}</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>

        {/* Property type */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 8 }}>Property Type *</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8 }}>
            {PROPERTY_TYPES.map(t => (
              <div key={t.value} onClick={() => set('type', t.value)} style={{ padding: '10px 12px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${form.type === t.value ? TYPE_COLORS[t.value] : 'var(--border-0)'}`, background: form.type === t.value ? `${TYPE_COLORS[t.value]}12` : 'var(--bg-2)', transition: 'all .12s' }}>
                <div style={{ fontSize: '.8rem', fontWeight: 600, color: form.type === t.value ? TYPE_COLORS[t.value] : 'var(--text-1)' }}>{t.label}</div>
                <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 2 }}>{t.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Name */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Property Name *</label>
          <input className="input" placeholder="Oak Street Apartments" value={form.name} onChange={e => set('name', e.target.value)} style={{ width: '100%' }} autoFocus />
          {errors.name && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.name}</div>}
        </div>

        {/* Address */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Street Address *</label>
          <input className="input" placeholder="4821 W Oak St" value={form.street1} onChange={e => set('street1', e.target.value)} style={{ width: '100%' }} />
          {errors.street1 && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.street1}</div>}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Suite / Unit / Lot <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span></label>
          <input className="input" placeholder="Suite 100" value={form.street2} onChange={e => set('street2', e.target.value)} style={{ width: '100%' }} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 64px 96px', gap: 10, marginBottom: 16 }}>
          <div>
            <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>City *</label>
            <input className="input" placeholder="Phoenix" value={form.city} onChange={e => set('city', e.target.value)} style={{ width: '100%' }} />
            {errors.city && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.city}</div>}
          </div>
          <div>
            <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>State</label>
            <input className="input" placeholder="AZ" value={form.state} onChange={e => set('state', e.target.value)} style={{ width: '100%' }} />
          </div>
          <div>
            <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>ZIP *</label>
            <input className="input" placeholder="85031" value={form.zip} onChange={e => set('zip', e.target.value)} style={{ width: '100%' }} />
            {errors.zip && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.zip}</div>}
          </div>
        </div>

        {/* Description */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>Description <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span></label>
          <textarea className="input" placeholder="Brief description of the property…" value={form.description} onChange={e => set('description', e.target.value)} rows={2} style={{ width: '100%', resize: 'vertical' }} />
        </div>

        {/* Amenities */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 8 }}>Amenities <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span></label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {AMENITIES.map(a => {
              const on = form.amenities.includes(a)
              return (
                <button key={a} type="button" onClick={() => toggleAmenity(a)} style={{ padding: '4px 10px', borderRadius: 20, fontSize: '.72rem', fontWeight: 600, cursor: 'pointer', transition: 'all .12s', border: `1px solid ${on ? 'rgba(201,162,39,.4)' : 'var(--border-0)'}`, background: on ? 'rgba(201,162,39,.1)' : 'var(--bg-2)', color: on ? 'var(--gold)' : 'var(--text-3)' }}>
                  {on && '✓ '}{a}
                </button>
              )
            })}
          </div>
        </div>

        {mut.isError && (
          <div style={{ color: 'var(--red)', fontSize: '.75rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
            Failed to save property. Please try again.
          </div>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={mut.isLoading}>
            {mut.isLoading ? <span className="spinner" /> : <><Check size={14} /> {isEdit ? 'Save Changes' : 'Add Property'}</>}
          </button>
        </div>
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
    const propUnits = (units as any[]).filter(u => u.property_id === p.id || u.property_name === p.name)
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
