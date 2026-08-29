import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { X, Building2, DoorOpen, DollarSign, ChevronRight, ChevronLeft, Check } from 'lucide-react'
import {
  UNIT_TYPES, UnitType, UNIT_TYPE_LABEL, UNIT_TYPE_ICON, UNIT_TYPE_HAS_BEDROOMS,
  FLOOR_LEVELS, FLOOR_LEVEL_LABEL, type FloorLevel,
  PropertyUnitSubtype, unitSubtypeFactsLabel,
  METER_READING_DEFAULT_DIGITS,
} from '@gam/shared'
import { toast } from '../components/dialogs'
import { canonicalUnitNumber, UNIT_TYPE_PREFIX } from '@gam/shared'
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
    // S604 (Nic): real parks have signage the software must match. Oak Park runs
    // RV 1-3, apartments 4-5, motel 6-12, apartments 13-19, then RV 20-36 — the
    // second RV block can't be made by "continue after the highest".
    unitType:         'apartment' as UnitType,
    subtypeId:        '',
    bedrooms:         '1',
    bathrooms:        '1',
    sqft:             '',
    rvSiteLayout:     'back_in',
    rvAmpService:     '30',
    dwellingOwnership: '',
    isMultiLevel:     false,
    isAdaAccessible:  false,
    floorLevel:       '',
    storageSize:      '',
    lotRentAmount:    '',
    rentAmount:       '',
    securityDeposit:  '',
    nightlyRate:      '',
    weeklyRate:       '',
    status:           'vacant',
    ownerHouseholdSize: '1',
  })
  // S533 (Nic): meters are configured HERE, in the unit add area — there
  // is no meters list elsewhere. Each checked utility creates a 1:1
  // submeter per created unit (batches included).
  // Sewer is NOT a meter — it bills off the water reading at a second
  // rate (one line item on the invoice). Water row carries it.
  // S605 (Nic): `mode` — this step used to assume SUBMETER for anything checked,
  // which silently misconfigures any property that bills a utility as RUBS. Oak
  // Park hit it immediately: RV sites submeter ELECTRIC but bill WATER as RUBS,
  // and the only route through was to skip water here and rebuild it afterwards
  // on the Utilities page. The engine has supported RUBS all along; the step
  // just never asked.
  //
  // `baseline` — the opening read. This modal is where a property's submeters
  // are actually born, so it's the first place the omission bites: a meter
  // created here with no starting value bills nothing on its first cycle and
  // says nothing about why.
  // S605 (Nic, DIRECTIVE): unit onboarding is just ON or OFF per utility.
  // "Let's fix it so it's a simple toggle. Electric or water on or off. That's
  // it... we should have the link to the submeter and that kind of thing and
  // initial read on NOT the onboarding of the unit page."
  //
  // Rates are property policy now, RUBS membership is a property-level decision,
  // and opening reads are taken by walking the park — none of it belongs in the
  // middle of typing a unit in. Toggling a utility on creates a BARE submeter;
  // it is configured, linked or replaced on the Utilities page, where the whole
  // property is visible at once.
  const [meters, setMeters] = useState<Record<string, boolean>>({
    electric: false,
    water:    false,
  })
  const [errors, setErrors] = useState<Record<string, string>>({})

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
          for (const [utility, on] of Object.entries(meters)) {
            if (!on) continue
            try {
              // Bare meter: no rate (property policy sets it), no opening read
              // (taken on the Utilities page), no sewer rate, no RUBS branch.
              // Just "this unit has its own electric meter".
              await apiPost('/utility/meters', {
                propertyId: form.propertyId,
                utilityType: utility,
                label: `${u.unitNumber} ${utility}`,
                billingMethod: 'submeter',
                baseFee: 0,
                digits: METER_READING_DEFAULT_DIGITS,
                assignUnitId: u.id,
              })
            } catch (e: any) {
              toast.error(e?.response?.data?.error || `Could not create the ${utility} meter for ${u.unitNumber}`)
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
  // S550: dwelling ownership only matters for RV spots and mobile homes —
  // it decides whether inspections cover the site only (tenant-owned) or the
  // dwelling too (park-owned). BOTH default tenant-owned (Nic: most parks
  // deliberately don't own the homes); park-owned rentals are the exception.
  const ownershipRelevant = isRv || form.unitType === 'mobile_home'
  const dwellingOwnership = form.dwellingOwnership || 'tenant'
  const subtypesForType = (subtypes as PropertyUnitSubtype[]).filter(s => s.unitType === form.unitType)
  const selectedSubtype = subtypesForType.find(s => s.id === form.subtypeId) || null
  const qty = Math.max(1, parseInt(form.quantity) || 1)

  const set = (key: string, val: any) => {
    setForm(f => ({ ...f, [key]: val }))
    setErrors(e => ({ ...e, [key]: '' }))
  }

  const validateStep = () => {
    const errs: Record<string, string> = {}
    if (step === 0 && !form.propertyId) errs.propertyId = 'Select a property'
    if (step === 1) {
      if (!form.unitNumber.trim()) errs.unitNumber = 'Required'
      const q = parseInt(form.quantity)
      if (form.quantity && (isNaN(q) || q < 1 || q > 200)) errs.quantity = '1–200'
    }
    if (step === 2 && !selectedSubtype) {
      // S613: with a subtype picked the rent comes from it — validating a field
      // the landlord can no longer see would be a dead end.
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
      ...(s ? {} : {
        rentAmount:      Number(form.rentAmount),
        securityDeposit: Number(form.securityDeposit) || 0,
      }),
      ...(isRv && !s ? {
        rvSiteLayout: form.rvSiteLayout,
        rvAmpService: form.rvAmpService,
      } : {}),
      ...(isRv ? {
        nightlyRate:  form.nightlyRate ? Number(form.nightlyRate) : null,
        weeklyRate:   form.weeklyRate ? Number(form.weeklyRate) : null,
      } : {}),
      ...(form.unitType === 'storage' && !s && form.storageSize.trim() ? { storageSize: form.storageSize.trim() } : {}),
      ...(ownershipRelevant && !s ? { dwellingOwnership } : {}),
      ...(hasBeds ? { isMultiLevel: form.isMultiLevel, isAdaAccessible: form.isAdaAccessible, ...(form.floorLevel ? { floorLevel: form.floorLevel } : {}) } : {}),
      // S568: lot rent the operator pays the external park (homes-only properties).
      ...(form.lotRentAmount !== '' ? { lotRentAmount: Number(form.lotRentAmount) } : {}),
      status:          form.status,
      // Only meaningful for an owner-occupied unit; the server ignores it
      // otherwise. It is what a headcount utility split weighs the unit by,
      // since there is no lease to count people from.
      ...(form.status === 'owner_use'
        ? { ownerHouseholdSize: Math.max(1, Number(form.ownerHouseholdSize) || 1) }
        : {}),
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
                <label style={labelStyle}>{qty > 1 ? 'Starting number *' : 'Unit number *'} <span style={{ fontWeight: 400, textTransform: 'none', color: 'var(--gold)' }}>— prefixed “{UNIT_TYPE_PREFIX[form.unitType as UnitType]}” automatically</span></label>
                <input
                  className="input"
                  placeholder={qty > 1 ? 'e.g. 1 → 01, 02, 03…' : 'e.g. 7, 14A, or A'}
                  value={form.unitNumber}
                  onChange={e => set('unitNumber', e.target.value)}
                  style={{ width: '100%' }}
                />
                {errors.unitNumber && <div style={{ color: 'var(--red)', fontSize: '.72rem', marginTop: 4 }}>{errors.unitNumber}</div>}
                {/* S604 (Nic): the prefix behaviour was only ever shown in the
                    PLACEHOLDER, which disappears the moment you type — so a
                    landlord bulk-adding 20 spots had no idea whether the field
                    wanted a prefix or a comma-separated list. Show the actual
                    names that will be created, live. */}
                {qty > 1 && form.unitNumber.trim() && (() => {
                  // S605 (Nic): ONE field decides the numbering — the unit
                  // number IS the starting point. A separate "start numbering
                  // at" box asked the same question twice, and a padding
                  // selector let one property render "RV 8" while another
                  // rendered "RV 08". Padding is fixed platform-wide.
                  const pfx = UNIT_TYPE_PREFIX[form.unitType as keyof typeof UNIT_TYPE_PREFIX] ?? ''
                  const s0 = parseInt(form.unitNumber.trim(), 10)
                  const gold = { color: 'var(--gold)', fontFamily: 'var(--font-mono)' } as const
                  if (!Number.isFinite(s0)) return null
                  const nm = (n: number) => `${pfx} ${String(n).padStart(2, '0')}`
                  return (
                    <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 5, lineHeight: 1.5 }}>
                      Creates <span style={gold}>{nm(s0)}</span>
                      {qty > 2 ? <>, <span style={gold}>{nm(s0 + 1)}</span> … </> : ' and '}
                      <span style={gold}>{nm(s0 + qty - 1)}</span>
                    </div>
                  )
                })()}
                {qty === 1 && form.unitNumber.trim() && (() => {
                  // S605: show the CANONICAL name — the platform supplies the
                  // unit type's prefix and zero-pads single digits, so "7" is
                  // stored as "RV 07". A preview of the raw input would promise
                  // something different from what gets created.
                  const gold = { color: 'var(--gold)', fontFamily: 'var(--font-mono)' } as const
                  const canon = canonicalUnitNumber(form.unitType as any, form.unitNumber)
                  return (
                    <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 5, lineHeight: 1.5 }}>
                      Creates <span style={gold}>{canon}</span>
                    </div>
                  )
                })()}
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

                {ownershipRelevant && (
                  <div style={{ marginBottom: 14 }}>
                    <label style={labelStyle}>{isRv ? 'Who owns the RV?' : 'Who owns the home?'}</label>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                      {[{ v: 'tenant', l: 'Tenant-owned' }, { v: 'landlord', l: 'Park-owned' }].map(o => (
                        <div key={o.v} onClick={() => set('dwellingOwnership', o.v)}
                          style={{ padding: '8px 6px', borderRadius: 8, cursor: 'pointer', textAlign: 'center', fontSize: '.75rem', fontWeight: 600,
                            border: `1px solid ${dwellingOwnership === o.v ? 'var(--gold)' : 'var(--border-0)'}`,
                            background: dwellingOwnership === o.v ? 'rgba(201,162,39,.08)' : 'var(--bg-2)',
                            color: dwellingOwnership === o.v ? 'var(--gold)' : 'var(--text-1)' }}>
                          {o.l}
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 4 }}>
                      {/* S629 (Nic): "I can't find that workflow anywhere in the
                          user interface." The financed-sale panel only appears
                          on a PARK-OWNED mobile home, and this control is
                          pre-set to Tenant-owned — so it reads as already
                          answered, and nothing said that the other option is
                          what makes selling the home possible. A landlord who
                          buys and sells park homes had no way to learn the
                          question mattered. */}
                      {dwellingOwnership === 'tenant'
                        ? 'Space rent only — inspections cover the site/lot, never their dwelling.'
                        : isRv
                          ? 'Park-owned rental — inspections cover the site plus the RV itself.'
                          : 'Park-owned rental home — inspections cover the full home interior. Only a park-owned home can be sold to the tenant on a financed contract.'}
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
                {hasBeds && (
                  <div style={{ marginBottom: 14, display: 'grid', gap: 12 }}>
                    <div>
                      <label
                        onClick={() => set('isMultiLevel', !form.isMultiLevel)}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '.8rem', color: 'var(--text-1)' }}>
                        <span style={{
                          width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                          border: `1px solid ${form.isMultiLevel ? 'var(--gold)' : 'var(--border-0)'}`,
                          background: form.isMultiLevel ? 'var(--gold)' : 'var(--bg-2)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: '#000', fontSize: '.7rem', fontWeight: 700,
                        }}>{form.isMultiLevel ? '✓' : ''}</span>
                        Multi-level (has interior stairs)
                      </label>
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 4, marginLeft: 26 }}>
                        Adds a stairs &amp; handrails area to this unit's inspections.
                      </div>
                    </div>
                    <div>
                      <label
                        onClick={() => set('isAdaAccessible', !form.isAdaAccessible)}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '.8rem', color: 'var(--text-1)' }}>
                        <span style={{
                          width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                          border: `1px solid ${form.isAdaAccessible ? 'var(--gold)' : 'var(--border-0)'}`,
                          background: form.isAdaAccessible ? 'var(--gold)' : 'var(--bg-2)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: '#000', fontSize: '.7rem', fontWeight: 700,
                        }}>{form.isAdaAccessible ? '✓' : ''}</span>
                        Accessible (ADA) unit
                      </label>
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 4, marginLeft: 26 }}>
                        Adds an accessibility area (grab bars, ramps, clearances) to inspections.
                      </div>
                    </div>
                    <div>
                      <label style={labelStyle}>Floor placement</label>
                      <select className="input" value={form.floorLevel} onChange={e => set('floorLevel', e.target.value)} style={{ width: '100%' }}>
                        <option value="">Unspecified</option>
                        {(FLOOR_LEVELS as readonly string[]).map(fl => <option key={fl} value={fl}>{FLOOR_LEVEL_LABEL[fl as FloorLevel]}</option>)}
                      </select>
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 4 }}>
                        Lets renters filter by ground floor / upstairs / basement.
                      </div>
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
                  // S604 (Nic): 'vacant' rendered in muted grey read as DISABLED —
                  // and it is the correct choice in almost every case, because
                  // esign + the lease-start scheduler flip a unit to 'active'
                  // automatically. Gold matches the selected state of every other
                  // picker in this modal. Marking units active by hand does not
                  // change the platform fee (that counts active LEASES) but it
                  // DOES inflate occupancy and rep commission, and nothing walks
                  // it back — so the copy says so.
                  { value: 'vacant', label: 'Vacant', desc: 'No tenant yet — recommended; a lease flips this to Active', color: 'var(--gold)' },
                  { value: 'active', label: 'Active', desc: 'Already occupied — only if a lease is being added', color: 'var(--green)' },
                  // S609 (Nic): owner-occupied was only reachable by creating the
                  // unit and then editing it, so it was being marked Vacant at
                  // setup — "there's no way to mark them owner occupied". That is
                  // not cosmetic: a vacant-marked owner unit takes no share of a
                  // utility split, so the owner's own usage lands on the paying
                  // tenants.
                  { value: 'owner_use', label: 'Owner-occupied', desc: 'You or your staff live here — no lease, no rent, and its utility share is never billed to tenants', color: 'var(--blue, #5b8def)' },
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
              {/* S609 (Nic): an owner-occupied unit has NO LEASE, so a headcount
                  utility split has nobody to count. This number is what it
                  weighs the unit by — and weighing it at all is what stops the
                  owner's own water landing on the tenants' bills. */}
              {form.status === 'owner_use' && (
                <div style={{ marginTop: 10 }}>
                  <label style={labelStyle}>People living here</label>
                  <input
                    type="number" min={1} max={30}
                    value={form.ownerHouseholdSize}
                    onChange={e => set('ownerHouseholdSize', e.target.value)}
                    style={{ width: 90, padding: '7px 10px', borderRadius: 8,
                             border: '1px solid var(--border-0)', background: 'var(--bg-2)',
                             color: 'var(--text-0)', fontSize: '.85rem' }}
                  />
                  <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginTop: 4, lineHeight: 1.5 }}>
                    Used only if a shared meter splits by occupancy — this unit takes its share
                    of the bill and you absorb it, so your tenants aren&apos;t billed for your
                    household&apos;s usage. It&apos;s recorded each cycle so you can show it
                    wasn&apos;t passed through.
                  </div>
                </div>
              )}
            </div>

            <div style={{ marginTop: 4 }}>
              <label style={labelStyle}>Metered utilities</label>
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 8 }}>
                Does this unit have its own meter? Rates, shared/RUBS meters and opening
                reads are all set on the <strong>Utilities</strong> page, where you can see
                the whole property at once.
              </div>
              <div style={{ display: 'grid', gap: 6 }}>
                {(['electric', 'water'] as const).map(t => (
                  <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                    borderRadius: 8, background: 'var(--bg-2)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={meters[t]}
                      onChange={e => setMeters(prev => ({ ...prev, [t]: e.target.checked }))} />
                    <span style={{ fontSize: '.85rem', fontWeight: 600 }}>
                      {t === 'electric' ? '⚡ Electric' : '💧 Water'}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Pricing (prefilled from the picked subtype) */}
        {step === 2 && (
          <div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 8 }}>
              {selectedSubtype ? <>What {qty > 1 ? 'these units' : `unit ${form.unitNumber}`} will rent for</>
                : <>Set the rent and deposit for {qty > 1 ? <strong style={{ color: 'var(--text-0)' }}>{qty} units numbered "{form.unitNumber} 01", "{form.unitNumber} 02", …</strong> : <strong style={{ color: 'var(--text-0)' }}>unit {form.unitNumber}</strong>}</>}
            </div>
            {/* S613 (Nic, DIRECTIVE): price belongs to the SUBTYPE. With one
                picked there is nothing to type — showing an editable field here
                is what made the same number live in two places. Without one, what
                you type here BECOMES a subtype, so the number still has one home. */}
            {selectedSubtype ? (
              <div style={{ fontSize: '.76rem', color: 'var(--text-2)', background: 'rgba(201,162,39,.08)', border: '1px solid rgba(201,162,39,.25)', borderRadius: 6, padding: '10px 12px', marginBottom: 14, lineHeight: 1.6 }}>
                <strong style={{ color: 'var(--gold)' }}>{selectedSubtype.name}</strong> —
                {selectedSubtype.rentAmount != null ? ` ${fmt(Number(selectedSubtype.rentAmount))}/mo` : ' no rent set'}
                {selectedSubtype.securityDeposit != null ? `, ${fmt(Number(selectedSubtype.securityDeposit))} deposit` : ''}
                {selectedSubtype.nightlyRate != null ? `, ${fmt(Number(selectedSubtype.nightlyRate))}/night` : ''}
                {selectedSubtype.weeklyRate != null ? `, ${fmt(Number(selectedSubtype.weeklyRate))}/week` : ''}.
                <span style={{ display: 'block', color: 'var(--text-3)', fontSize: '.72rem', marginTop: 4 }}>
                  Set on the subtype, so every unit in it shares this price and changing it there
                  moves them all. To price {qty > 1 ? 'these units' : 'this unit'} differently, go
                  back and pick a different subtype — or none, and set the price here.
                </span>
              </div>
            ) : (
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.55 }}>
                No subtype, so {qty > 1 ? 'these units carry' : 'this unit carries'} its own price.
              </div>
            )}

            <div style={{ marginBottom: 14, display: selectedSubtype ? 'none' : undefined }}>
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

            {/* S568: homes-only external park — capture the lot rent the operator
                pays the park, so their net (tenant rent − lot rent) is clean. */}
            {selectedProperty && selectedProperty.operatorOwnsLand === false && (
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Lot rent you pay the park</label>
              <div style={{ position: 'relative' }}>
                <DollarSign size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
                <input className="input" type="number" placeholder="0.00" value={form.lotRentAmount}
                  onChange={e => set('lotRentAmount', e.target.value)} style={{ width: '100%', paddingLeft: 30 }} />
              </div>
              {form.rentAmount && form.lotRentAmount && (
                <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 4 }}>
                  Your net: {fmt(Number(form.rentAmount) - Number(form.lotRentAmount))}/mo (tenant rent − lot rent)
                </div>
              )}
            </div>
            )}

            <div style={{ marginBottom: isRv ? 14 : 20, display: selectedSubtype ? 'none' : undefined }}>
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

            {isRv && !selectedSubtype && (
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
                { label: 'Monthly rent', val: `${fmt(Number(selectedSubtype?.rentAmount ?? form.rentAmount))}${qty > 1 ? ' each' : ''}` },
                { label: 'Security deposit', val: fmt(Number(selectedSubtype?.securityDeposit ?? form.securityDeposit ?? 0)) },
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
