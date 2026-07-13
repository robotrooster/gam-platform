import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { X, Building2, DoorOpen, DollarSign, ChevronRight, ChevronLeft, Check } from 'lucide-react'
import {
  UNIT_TYPES, UnitType, UNIT_TYPE_LABEL, UNIT_TYPE_ICON, UNIT_TYPE_HAS_BEDROOMS,
  PropertyUnitSubtype, unitSubtypeFactsLabel,
  METER_READING_DIGIT_OPTIONS, METER_READING_DEFAULT_DIGITS,
} from '@gam/shared'
import { toast } from '../components/dialogs'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

interface Props { onClose: () => void; preselectedPropertyId?: string }

// S527 (Nic): add-unit is TYPE-FIRST, then SUBTYPE-FIRST — pick a unit type,
// then one of the OWNER's named subtypes for that type ("Studio",
// "Riverfront pull-through"). The subtype carries the facts + pricing, so
// the landlord never sees menus for things they don't have. No subtypes
// defined (or "Custom") → plain manual fields. Quantity creates a numbered
// batch (replaces the removed Add Property bulk step — one door for units).
const STEPS = ['Property', 'Unit Details', 'Pricing', 'Review']

const labelStyle = { fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.06em', display: 'block', marginBottom: 5 }

export function AddUnitModal({ onClose, preselectedPropertyId }: Props) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [step, setStep] = useState(preselectedPropertyId ? 1 : 0)
  const [form, setForm] = useState({
    propertyId:       preselectedPropertyId || '',
    unitNumber:       '',
    quantity:         '1',
    unitType:         'apartment' as UnitType,
    subtypeId:        '',
    bedrooms:         '1',
    bathrooms:        '1',
    sqft:             '',
    rvSiteLayout:     'back_in',
    rvAmpService:     '30',
    storageSize:      '',
    rentAmount:       '',
    securityDeposit:  '',
    nightlyRate:      '',
    weeklyRate:       '',
    status:           'vacant',
  })
  // S533 (Nic): meters are configured HERE, in the unit add area — there
  // is no meters list elsewhere. Each checked utility creates a 1:1
  // submeter per created unit (batches included).
  // Sewer is NOT a meter — it bills off the water reading at a second
  // rate (one line item on the invoice). Water row carries it.
  const [meters, setMeters] = useState<Record<string, { on: boolean; rate: string; digits: string; sewerRate: string }>>({
    electric: { on: false, rate: '', digits: String(METER_READING_DEFAULT_DIGITS), sewerRate: '' },
    water:    { on: false, rate: '', digits: String(METER_READING_DEFAULT_DIGITS), sewerRate: '' },
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [prefilledFrom, setPrefilledFrom] = useState<string | null>(null)

  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  // The property's owner-defined subtypes — feeds the subtype picker + prefill.
  const { data: subtypes = [] } = useQuery<PropertyUnitSubtype[]>(
    ['property-unit-subtypes', form.propertyId],
    () => apiGet(`/properties/${form.propertyId}/unit-subtypes`),
    { enabled: !!form.propertyId },
  )

  const createMut = useMutation(
    (data: any) => apiPost('/units', data),
    {
      onSuccess: async (res: any) => {
        // Create the configured submeters for every created unit
        // (batch adds included) — 1:1 assignment, label "<unit> <utility>".
        const createdUnits: any[] = res.data?.id ? [res.data] : (res.data?.units || [])
        for (const u of createdUnits) {
          for (const [utility, m] of Object.entries(meters)) {
            if (!m.on) continue
            try {
              const meterRes: any = await apiPost('/utility/meters', {
                propertyId: form.propertyId,
                utilityType: utility,
                label: `${u.unitNumber ?? u.unit_number} ${utility}`,
                billingMethod: 'submeter',
                ratePerUnit: m.rate === '' ? null : Number(m.rate),
                baseFee: 0,
                digits: Number(m.digits) || METER_READING_DEFAULT_DIGITS,
                ...(utility === 'water' && m.sewerRate !== '' ? { sewerRatePerUnit: Number(m.sewerRate) } : {}),
              })
              await apiPost(`/utility/meters/${meterRes.data.id}/units`, { unitId: u.id })
            } catch (e: any) {
              toast.error(e?.response?.data?.error || `Could not create the ${utility} meter for ${u.unitNumber ?? u.unit_number}`)
            }
          }
        }
        qc.invalidateQueries('units')
        qc.invalidateQueries('schedule')
        qc.invalidateQueries(['property', form.propertyId])
        qc.invalidateQueries('utility-meters')
        onClose()
        // Single unit → its page; a batch → the property the units landed on.
        if (res.data?.id) navigate(`/units/${res.data.id}`)
        else navigate(`/properties/${form.propertyId}`)
      }
    }
  )

  const selectedProperty = (properties as any[]).find(p => p.id === form.propertyId)
  const isRv = form.unitType === 'rv_spot'
  const hasBeds = UNIT_TYPE_HAS_BEDROOMS[form.unitType]
  const subtypesForType = (subtypes as PropertyUnitSubtype[]).filter(s => s.unitType === form.unitType)
  const selectedSubtype = subtypesForType.find(s => s.id === form.subtypeId) || null
  const qty = Math.max(1, parseInt(form.quantity) || 1)

  const set = (key: string, val: any) => {
    setForm(f => ({ ...f, [key]: val }))
    setErrors(e => ({ ...e, [key]: '' }))
  }

  // Entering the pricing step: prefill from the picked subtype. Only fills
  // what's still empty — never clobbers something the landlord already typed.
  const applyPricingDefaults = () => {
    if (!selectedSubtype) { setPrefilledFrom(null); return }
    const s = selectedSubtype
    setForm(f => ({
      ...f,
      rentAmount:      f.rentAmount      || (s.rentAmount      != null ? String(s.rentAmount)      : f.rentAmount),
      securityDeposit: f.securityDeposit || (s.securityDeposit != null ? String(s.securityDeposit) : f.securityDeposit),
      nightlyRate:     f.nightlyRate     || (s.nightlyRate     != null ? String(s.nightlyRate)     : f.nightlyRate),
      weeklyRate:      f.weeklyRate      || (s.weeklyRate      != null ? String(s.weeklyRate)      : f.weeklyRate),
    }))
    setPrefilledFrom(s.name)
  }

  const validateStep = () => {
    const errs: Record<string, string> = {}
    if (step === 0 && !form.propertyId) errs.propertyId = 'Select a property'
    if (step === 1) {
      if (!form.unitNumber.trim()) errs.unitNumber = 'Required'
      const q = parseInt(form.quantity)
      if (form.quantity && (isNaN(q) || q < 1 || q > 200)) errs.quantity = '1–200'
    }
    if (step === 2) {
      if (!form.rentAmount || isNaN(Number(form.rentAmount)) || Number(form.rentAmount) <= 0)
        errs.rentAmount = 'Valid rent amount required'
      if (form.securityDeposit && isNaN(Number(form.securityDeposit)))
        errs.securityDeposit = 'Invalid amount'
    }
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const next = () => {
    if (!validateStep()) return
    if (step === 1) applyPricingDefaults()
    setStep(s => s + 1)
  }
  const back = () => setStep(s => s - 1)

  const submit = () => {
    const s = selectedSubtype
    createMut.mutate({
      propertyId:      form.propertyId,
      unitNumber:      form.unitNumber.trim(),
      quantity:        qty,
      ...(s ? { subtypeId: s.id } : {}),
      unitType:        form.unitType,
      bedrooms:        s ? undefined : (hasBeds ? Number(form.bedrooms) || 0 : 0),
      bathrooms:       s ? undefined : (hasBeds ? Number(form.bathrooms) || 0 : 0),
      sqft:            form.sqft ? Number(form.sqft) : null,
      rentAmount:      Number(form.rentAmount),
      securityDeposit: Number(form.securityDeposit) || 0,
      ...(isRv && !s ? {
        rvSiteLayout: form.rvSiteLayout,
        rvAmpService: form.rvAmpService,
      } : {}),
      ...(isRv ? {
        nightlyRate:  form.nightlyRate ? Number(form.nightlyRate) : null,
        weeklyRate:   form.weeklyRate ? Number(form.weeklyRate) : null,
      } : {}),
      ...(form.unitType === 'storage' && !s && form.storageSize.trim() ? { storageSize: form.storageSize.trim() } : {}),
      status:          form.status,
    })
  }

  const subtypeSummary = selectedSubtype
    ? `${selectedSubtype.name}${unitSubtypeFactsLabel(selectedSubtype) ? ` (${unitSubtypeFactsLabel(selectedSubtype)})` : ''}`
    : unitSubtypeFactsLabel({
        unitType: form.unitType, name: '',
        bedrooms: hasBeds ? Number(form.bedrooms) || 0 : null,
        bathrooms: hasBeds ? form.bathrooms : null,
        rvSiteLayout: isRv ? form.rvSiteLayout : null,
        rvAmpService: isRv ? form.rvAmpService : null,
        storageSize: form.unitType === 'storage' ? form.storageSize : null,
        rentAmount: null, securityDeposit: null, nightlyRate: null, weeklyRate: null, monthlyRate: null,
      }) || null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520, width: '95vw' }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <div className="modal-title" style={{ marginBottom: 4 }}>Add Unit{qty > 1 ? 's' : ''}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {STEPS.map((s, i) => (
                <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div style={{
                    width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '.65rem', fontWeight: 700,
                    background: i < step ? 'var(--green)' : i === step ? 'var(--gold)' : 'var(--bg-3)',
                    color: i <= step ? 'var(--bg-0)' : 'var(--text-3)',
                    border: `1px solid ${i < step ? 'var(--green)' : i === step ? 'var(--gold)' : 'var(--border-0)'}`,
                    transition: 'all .2s'
                  }}>
                    {i < step ? <Check size={11} /> : i + 1}
                  </div>
                  <span style={{ fontSize: '.65rem', color: i === step ? 'var(--text-1)' : 'var(--text-3)', fontWeight: i === step ? 600 : 400 }}>{s}</span>
                  {i < STEPS.length - 1 && <div style={{ width: 16, height: 1, background: 'var(--border-0)', margin: '0 2px' }} />}
                </div>
              ))}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>

        {/* Step 0: Property */}
        {step === 0 && (
          <div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 16 }}>
              Which property is this unit in?
            </div>
            {(properties as any[]).length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-3)' }}>
                <Building2 size={32} style={{ margin: '0 auto 8px', display: 'block', opacity: .4 }} />
                <div style={{ fontSize: '.82rem' }}>No properties yet.</div>
                <div style={{ fontSize: '.75rem', marginTop: 4 }}>Add a property first before adding units.</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(properties as any[]).map((p: any) => (
                  <div
                    key={p.id}
                    onClick={() => set('propertyId', p.id)}
                    style={{
                      padding: '12px 14px', borderRadius: 10, cursor: 'pointer', transition: 'all .12s',
                      border: `1px solid ${form.propertyId === p.id ? 'var(--gold)' : 'var(--border-0)'}`,
                      background: form.propertyId === p.id ? 'rgba(201,162,39,.06)' : 'var(--bg-2)',
                      display: 'flex', alignItems: 'center', gap: 12,
                    }}
                  >
                    <div style={{
                      width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                      background: form.propertyId === p.id ? 'rgba(201,162,39,.15)' : 'var(--bg-3)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Building2 size={16} style={{ color: form.propertyId === p.id ? 'var(--gold)' : 'var(--text-3)' }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--text-0)' }}>{p.name}</div>
                      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 1 }}>{p.street1}, {p.city}, {p.state}</div>
                    </div>
                    {form.propertyId === p.id && <Check size={16} style={{ color: 'var(--gold)', flexShrink: 0 }} />}
                  </div>
                ))}
              </div>
            )}
            {errors.propertyId && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 8 }}>{errors.propertyId}</div>}
          </div>
        )}

        {/* Step 1: Unit type + owner subtype + details */}
        {step === 1 && (
          <div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 16 }}>
              Tell us about the unit at <strong style={{ color: 'var(--text-0)' }}>{selectedProperty?.name}</strong>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Unit Type *</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                {UNIT_TYPES.map(t => (
                  <div
                    key={t}
                    onClick={() => { set('unitType', t); set('subtypeId', '') }}
                    style={{
                      padding: '10px 8px', borderRadius: 8, cursor: 'pointer', textAlign: 'center', transition: 'all .12s',
                      border: `1px solid ${form.unitType === t ? 'var(--gold)' : 'var(--border-0)'}`,
                      background: form.unitType === t ? 'rgba(201,162,39,.08)' : 'var(--bg-2)',
                    }}
                  >
                    <div style={{ fontSize: '1.1rem' }}>{UNIT_TYPE_ICON[t]}</div>
                    <div style={{ fontSize: '.7rem', fontWeight: 600, color: form.unitType === t ? 'var(--gold)' : 'var(--text-1)', marginTop: 2 }}>{UNIT_TYPE_LABEL[t]}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Owner-defined subtypes for this type (S527). None defined → the
                manual fields below stand alone. */}
            {subtypesForType.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Subtype</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {subtypesForType.map(s => (
                    <div key={s.id} onClick={() => set('subtypeId', s.id)}
                      style={{ padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontSize: '.75rem', fontWeight: 600,
                        border: `1px solid ${form.subtypeId === s.id ? 'var(--gold)' : 'var(--border-0)'}`,
                        background: form.subtypeId === s.id ? 'rgba(201,162,39,.08)' : 'var(--bg-2)',
                        color: form.subtypeId === s.id ? 'var(--gold)' : 'var(--text-1)' }}>
                      {s.name}
                      {unitSubtypeFactsLabel(s) && (
                        <span style={{ fontWeight: 400, color: 'var(--text-3)', marginLeft: 6 }}>{unitSubtypeFactsLabel(s)}</span>
                      )}
                    </div>
                  ))}
                  <div onClick={() => set('subtypeId', '')}
                    style={{ padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontSize: '.75rem', fontWeight: 600,
                      border: `1px solid ${!form.subtypeId ? 'var(--gold)' : 'var(--border-0)'}`,
                      background: !form.subtypeId ? 'rgba(201,162,39,.08)' : 'var(--bg-2)',
                      color: !form.subtypeId ? 'var(--gold)' : 'var(--text-1)' }}>
                    Custom
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <label style={labelStyle}>{qty > 1 ? 'Number Prefix *' : 'Unit Number / Identifier *'}</label>
                <input
                  className="input"
                  placeholder={qty > 1 ? (isRv ? 'e.g. RV → RV 01, RV 02…' : 'e.g. Apt → Apt 01, Apt 02…') : (isRv ? 'e.g. Site 42, Lot 7' : 'e.g. 101, A1')}
                  value={form.unitNumber}
                  onChange={e => set('unitNumber', e.target.value)}
                  style={{ width: '100%' }}
                />
                {errors.unitNumber && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.unitNumber}</div>}
              </div>
              <div>
                <label style={labelStyle}>How many?</label>
                <input
                  className="input" type="number" min={1} max={200}
                  value={form.quantity}
                  onChange={e => set('quantity', e.target.value)}
                  style={{ width: '100%' }}
                />
                {errors.quantity && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.quantity}</div>}
              </div>
            </div>

            {/* Manual fact fields — only without a subtype (the subtype IS the facts). */}
            {selectedSubtype ? (
              <div style={{ fontSize: '.74rem', color: 'var(--text-3)', background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 8, padding: '8px 12px', marginBottom: 14 }}>
                {selectedSubtype.name}
                {unitSubtypeFactsLabel(selectedSubtype) && <> — {unitSubtypeFactsLabel(selectedSubtype)}</>}
                {' '}· details and pricing come from your subtype; you can adjust pricing next.
              </div>
            ) : (
              <>
                {isRv && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                    <div>
                      <label style={labelStyle}>Site Layout</label>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                        {[{ v: 'back_in', l: 'Back-in' }, { v: 'pull_through', l: 'Pull-through' }].map(o => (
                          <div key={o.v} onClick={() => set('rvSiteLayout', o.v)}
                            style={{ padding: '8px 6px', borderRadius: 8, cursor: 'pointer', textAlign: 'center', fontSize: '.75rem', fontWeight: 600,
                              border: `1px solid ${form.rvSiteLayout === o.v ? 'var(--gold)' : 'var(--border-0)'}`,
                              background: form.rvSiteLayout === o.v ? 'rgba(201,162,39,.08)' : 'var(--bg-2)',
                              color: form.rvSiteLayout === o.v ? 'var(--gold)' : 'var(--text-1)' }}>
                            {o.l}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label style={labelStyle}>Electrical Service</label>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                        {[{ v: '30', l: '30 amp' }, { v: '50', l: '50 amp' }].map(o => (
                          <div key={o.v} onClick={() => set('rvAmpService', o.v)}
                            style={{ padding: '8px 6px', borderRadius: 8, cursor: 'pointer', textAlign: 'center', fontSize: '.75rem', fontWeight: 600,
                              border: `1px solid ${form.rvAmpService === o.v ? 'var(--gold)' : 'var(--border-0)'}`,
                              background: form.rvAmpService === o.v ? 'rgba(201,162,39,.08)' : 'var(--bg-2)',
                              color: form.rvAmpService === o.v ? 'var(--gold)' : 'var(--text-1)' }}>
                            {o.l}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {hasBeds && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
                    <div>
                      <label style={labelStyle}>Bedrooms (0 = studio)</label>
                      <input className="input" type="number" min={0} max={30} value={form.bedrooms} onChange={e => set('bedrooms', e.target.value)} style={{ width: '100%' }} />
                    </div>
                    <div>
                      <label style={labelStyle}>Bathrooms</label>
                      <input className="input" type="number" min={0} step={0.5} value={form.bathrooms} onChange={e => set('bathrooms', e.target.value)} style={{ width: '100%' }} />
                    </div>
                    <div>
                      <label style={labelStyle}>Sq Ft</label>
                      <input className="input" type="number" placeholder="850" value={form.sqft} onChange={e => set('sqft', e.target.value)} style={{ width: '100%' }} />
                    </div>
                  </div>
                )}
                {!hasBeds && !isRv && (
                  <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                    {form.unitType === 'storage' && (
                      <div style={{ maxWidth: 180 }}>
                        <label style={labelStyle}>Size</label>
                        <input className="input" placeholder="e.g. 10x10" value={form.storageSize} onChange={e => set('storageSize', e.target.value)} style={{ width: '100%' }} />
                      </div>
                    )}
                    <div style={{ maxWidth: 160 }}>
                      <label style={labelStyle}>Sq Ft</label>
                      <input className="input" type="number" placeholder="200" value={form.sqft} onChange={e => set('sqft', e.target.value)} style={{ width: '100%' }} />
                    </div>
                  </div>
                )}
              </>
            )}

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Initial Status</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  { value: 'vacant', label: 'Vacant', desc: 'No tenant, $0 charge', color: 'var(--text-3)' },
                  { value: 'active', label: 'Active', desc: 'Occupied, rent collected', color: 'var(--green)' },
                ].map(s => (
                  <div
                    key={s.value}
                    onClick={() => set('status', s.value)}
                    style={{
                      padding: '10px 12px', borderRadius: 8, cursor: 'pointer', transition: 'all .12s',
                      border: `1px solid ${form.status === s.value ? s.color : 'var(--border-0)'}`,
                      background: form.status === s.value ? `${s.color}12` : 'var(--bg-2)',
                    }}
                  >
                    <div style={{ fontSize: '.78rem', fontWeight: 600, color: form.status === s.value ? s.color : 'var(--text-1)' }}>{s.label}</div>
                    <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginTop: 2 }}>{s.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 4 }}>
              <label style={labelStyle}>Sub-metered utilities</label>
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 8 }}>
                Check what this unit has its own meter for — readings bill the tenant through the monthly reading run. Sewer bills off the water reading (one line item); propane is a tank fill on the Utilities page.
              </div>
              <div style={{ display: 'grid', gap: 6 }}>
                {(['electric', 'water'] as const).map(t => (
                  <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--bg-2)', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.8rem', fontWeight: 600, cursor: 'pointer', minWidth: 110 }}>
                      <input type="checkbox" checked={meters[t].on}
                        onChange={e => setMeters(prev => ({ ...prev, [t]: { ...prev[t], on: e.target.checked } }))} />
                      {t === 'electric' ? '⚡ Electric' : '💧 Water'}
                    </label>
                    {meters[t].on && (
                      <>
                        <input className="input" type="text" inputMode="decimal" placeholder={t === 'electric' ? '$/kWh e.g. 0.14' : 'water $/gal'}
                          value={meters[t].rate}
                          onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setMeters(prev => ({ ...prev, [t]: { ...prev[t], rate: v } })) }}
                          style={{ width: 130 }} />
                        <select className="input" value={meters[t].digits}
                          onChange={e => setMeters(prev => ({ ...prev, [t]: { ...prev[t], digits: e.target.value } }))}
                          style={{ width: 120 }}>
                          {METER_READING_DIGIT_OPTIONS.map(d => <option key={d} value={String(d)}>{d}-digit</option>)}
                        </select>
                        {t === 'water' && (
                          <input className="input" type="text" inputMode="decimal" placeholder="sewer $/gal (optional)"
                            value={meters[t].sewerRate}
                            onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setMeters(prev => ({ ...prev, [t]: { ...prev[t], sewerRate: v } })) }}
                            style={{ width: 170 }} />
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Pricing (prefilled from the picked subtype) */}
        {step === 2 && (
          <div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 8 }}>
              Set the rent and deposit for {qty > 1 ? <strong style={{ color: 'var(--text-0)' }}>{qty} units numbered "{form.unitNumber} 01", "{form.unitNumber} 02", …</strong> : <strong style={{ color: 'var(--text-0)' }}>unit {form.unitNumber}</strong>}
            </div>
            {prefilledFrom && (
              <div style={{ fontSize: '.72rem', color: 'var(--gold)', background: 'rgba(201,162,39,.08)', border: '1px solid rgba(201,162,39,.25)', borderRadius: 6, padding: '6px 10px', marginBottom: 14 }}>
                Prefilled from your "{prefilledFrom}" subtype — adjust for {qty > 1 ? 'these units' : 'this unit'} if needed.
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Monthly Rent *</label>
              <div style={{ position: 'relative' }}>
                <DollarSign size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                <input
                  className="input"
                  type="number"
                  placeholder="0.00"
                  value={form.rentAmount}
                  onChange={e => set('rentAmount', e.target.value)}
                  autoFocus
                  style={{ width: '100%', paddingLeft: 30 }}
                />
              </div>
              {errors.rentAmount && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.rentAmount}</div>}
            </div>

            <div style={{ marginBottom: isRv ? 14 : 20 }}>
              <label style={labelStyle}>Security Deposit</label>
              <div style={{ position: 'relative' }}>
                <DollarSign size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                <input
                  className="input"
                  type="number"
                  placeholder="0.00"
                  value={form.securityDeposit}
                  onChange={e => set('securityDeposit', e.target.value)}
                  style={{ width: '100%', paddingLeft: 30 }}
                />
              </div>
              {errors.securityDeposit && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.securityDeposit}</div>}
            </div>

            {isRv && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
                <div>
                  <label style={labelStyle}>Nightly Rate (short-term)</label>
                  <input className="input" type="number" placeholder="0.00" value={form.nightlyRate} onChange={e => set('nightlyRate', e.target.value)} style={{ width: '100%' }} />
                </div>
                <div>
                  <label style={labelStyle}>Weekly Rate (short-term)</label>
                  <input className="input" type="number" placeholder="0.00" value={form.weeklyRate} onChange={e => set('weeklyRate', e.target.value)} style={{ width: '100%' }} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 3: Review */}
        {step === 3 && (
          <div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 16 }}>
              Review before saving.
            </div>

            <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
              {/* Header */}
              <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-0)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 8, background: 'rgba(201,162,39,.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <DoorOpen size={16} style={{ color: 'var(--gold)' }} />
                </div>
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.9rem', fontWeight: 700, color: 'var(--text-0)' }}>
                    {qty > 1 ? `${qty} units — "${form.unitNumber}" numbered` : `Unit ${form.unitNumber}`}
                  </div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{selectedProperty?.name}</div>
                </div>
                <span className={`badge ${form.status === 'active' ? 'badge-green' : 'badge-muted'}`} style={{ marginLeft: 'auto' }}>
                  {form.status}
                </span>
              </div>

              {/* Details */}
              {[
                { label: 'Property', val: `${selectedProperty?.name} — ${selectedProperty?.street1}` },
                { label: 'Type', val: `${UNIT_TYPE_ICON[form.unitType]} ${UNIT_TYPE_LABEL[form.unitType]}${subtypeSummary ? ` · ${subtypeSummary}` : ''}` },
                qty > 1 ? { label: 'Quantity', val: `${qty} units` } : null,
                form.sqft ? { label: 'Square feet', val: `${Number(form.sqft).toLocaleString()} sq ft` } : null,
                { label: 'Monthly rent', val: `${fmt(Number(form.rentAmount))}${qty > 1 ? ' each' : ''}` },
                { label: 'Security deposit', val: form.securityDeposit ? fmt(Number(form.securityDeposit)) : '$0.00' },
                isRv && form.nightlyRate ? { label: 'Nightly rate', val: fmt(Number(form.nightlyRate)) } : null,
                isRv && form.weeklyRate ? { label: 'Weekly rate', val: fmt(Number(form.weeklyRate)) } : null,
              ].filter(Boolean).map((row: any) => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid var(--border-0)', fontSize: '.78rem' }}>
                  <span style={{ color: 'var(--text-3)' }}>{row.label}</span>
                  <span style={{ color: 'var(--text-0)', fontWeight: 500 }}>{row.val}</span>
                </div>
              ))}
            </div>

            {createMut.isError && (
              <div className="alert alert-danger" style={{ marginBottom: 12 }}>
                {/* W-16: surface the server's message — e.g. the duplicate
                    unit-number 409 — instead of a generic retry line. */}
                {(createMut.error as any)?.response?.data?.error
                  || `Failed to create unit${qty > 1 ? 's' : ''}. Please try again.`}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="modal-footer" style={{ marginTop: 24 }}>
          {step > 0 ? (
            <button className="btn btn-ghost" onClick={back}>
              <ChevronLeft size={14} /> Back
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          )}

          {step < STEPS.length - 1 ? (
            <button className="btn btn-primary" onClick={next} disabled={step === 0 && !form.propertyId}>
              Next <ChevronRight size={14} />
            </button>
          ) : (
            <button className="btn btn-primary" onClick={submit} disabled={createMut.isLoading}>
              {createMut.isLoading ? <span className="spinner" /> : <><Check size={14} /> Create Unit{qty > 1 ? 's' : ''}</>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
