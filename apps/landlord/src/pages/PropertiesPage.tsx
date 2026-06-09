import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Link, useNavigate } from 'react-router-dom'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { Building2, Plus, MapPin, DoorOpen, Users, DollarSign, X, Check, Edit2, Landmark } from 'lucide-react'
import { AddUnitModal } from './AddUnitModal'
import { UNIT_TYPES, UNIT_TYPE_LABEL, UNIT_TYPE_PREFIX, UNIT_TYPE_ICON, UNIT_TYPE_HAS_BEDROOMS, UnitType, FEE_PAYER_VALUES, type FeePayer } from '@gam/shared'
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

// Unit type options derived from @gam/shared single source of truth.
// Removed: 'house' (DB CHECK uses 'single_family'), 'other' (not in CHECK).
const UNIT_TYPE_OPTIONS = UNIT_TYPES.map(value => ({
  value,
  label:  UNIT_TYPE_LABEL[value],
  prefix: UNIT_TYPE_PREFIX[value],
  icon:   UNIT_TYPE_ICON[value],
}))

// S173: compact display of the three fee_payer toggles on the property
// card. Reads the same camelCase shape produced by GET /properties' jsonb
// allocationRule join, with a legacy bankingFeePayer fallback for rows
// created pre-S116. Renders nothing when no allocation rule is present
// (defensive; every active property has one).
function FeeConfigChips({ allocationRule }: { allocationRule: any }) {
  if (!allocationRule) return null
  const ach      = (allocationRule.achFeePayer      || allocationRule.bankingFeePayer || 'tenant') as FeePayer
  const card     = (allocationRule.cardFeePayer     || allocationRule.bankingFeePayer || 'tenant') as FeePayer
  const platform = (allocationRule.platformFeePayer || 'landlord')                                  as FeePayer
  const chip = (label: string, payer: FeePayer) => (
    <span
      key={label}
      title={`${label} fee: ${payer === 'tenant' ? 'tenant pays (added on top)' : 'landlord absorbs (deducted from gross)'}`}
      style={{
        fontSize:     '.62rem',
        padding:      '2px 7px',
        borderRadius: 10,
        background:   'var(--bg-3)',
        color:        'var(--text-2)',
        border:       '1px solid var(--border-0)',
        display:      'inline-flex',
        alignItems:   'center',
        gap:          4,
        lineHeight:   1.5,
      }}
    >
      <span style={{ color: 'var(--text-3)' }}>{label}</span>
      <span style={{ color: payer === 'tenant' ? 'var(--gold)' : 'var(--text-1)', fontWeight: 600 }}>
        {payer === 'tenant' ? 'tenant' : 'landlord'}
      </span>
    </span>
  )
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
      {chip('ACH', ach)}
      {chip('Card', card)}
      {chip('SaaS', platform)}
    </div>
  )
}

// S172: per-property fee toggles. Each fee (ACH / card / platform) has an
// independent "tenant pays" vs "landlord absorbs" setting. Reused in
// AddEditModal for create + edit flows.
function FeePayerToggle({
  label,
  hint,
  value,
  onChange,
}: {
  label:    string
  hint:     string
  value:    FeePayer
  onChange: (v: FeePayer) => void
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: '.74rem', fontWeight: 600, color: 'var(--text-1)', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginBottom: 6 }}>{hint}</div>
      <div style={{ display: 'flex', gap: 6 }}>
        {FEE_PAYER_VALUES.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            style={{
              flex:         1,
              padding:      '6px 10px',
              borderRadius: 8,
              cursor:       'pointer',
              fontSize:     '.74rem',
              border:       `1px solid ${value === v ? 'var(--gold)' : 'var(--border-0)'}`,
              background:   value === v ? 'rgba(201,162,39,.08)' : 'var(--bg-2)',
              color:        value === v ? 'var(--text-0)' : 'var(--text-2)',
              textTransform: 'capitalize' as const,
            }}
          >
            {v === 'tenant' ? 'Tenant pays' : 'Landlord absorbs'}
          </button>
        ))}
      </div>
    </div>
  )
}

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
    state:       property?.state || '',
    zip:         property?.zip || '',
    description: property?.description || '',
    amenities:   property?.amenities || [] as string[],
    unitTypes:   property?.unitTypes || [] as string[],
    // S179 / B3: per-property booking acknowledgment toggle.
    // S312: API responses now pass through the
    // applyCamelizeInterceptor in lib/api.ts, so camelCase reads
    // against the property record work correctly. Form-state keys
    // remain snake_case because the PATCH body expects them that way.
    requiresBookingAcknowledgment: property?.requiresBookingAcknowledgment ?? false,
    // S247: per-property subleasing toggle. Drives the master switch
    // on whether tenants at this property can request subleases at
    // all. AND'd with leases.subleasingAllowed in the request route.
    subleasingAllowed: property?.subleasingAllowed ?? false,
    // S251: optional landlord-uploaded sublease agreement template URL.
    // When set, overrides the GAM-default generated PDF at sublease
    // approval time. Stored as URL string — file upload handling is
    // a separate landlord-side feature; for now the landlord points
    // GAM at a hosted PDF (e.g., their own S3 / Dropbox link).
    subleaseAgreementTemplateUrl: property?.subleaseAgreementTemplateUrl ?? '',
    // S309: per-property FlexCharge enablement gate. Default OFF
    // (opt-in). When ON, the property appears in the FlexCharge create-
    // account property dropdown and createFlexChargeAccount accepts
    // requests against it. Existing accounts at the property continue
    // to function regardless of this flag.
    flexchargeEnabled: property?.flexchargeEnabled ?? false,
    // S223: property-level late-fee policy. Defines defaults for new
    // leases at this property; existing leases keep their current
    // late-fee config. Edit-only — create flow uses schema defaults
    // (enabled=true, grace=5, amount=15.00, type='flat') so landlord
    // doesn't have to make a policy decision at property creation.
    lateFeeEnabled:        property?.lateFeeEnabled        ?? true,
    lateFeeGraceDays:     property?.lateFeeGraceDays != null ? String(property.lateFeeGraceDays) : '5',
    lateFeeInitialAmount: property?.lateFeeInitialAmount != null ? String(property.lateFeeInitialAmount) : '15.00',
    lateFeeInitialType:   (property?.lateFeeInitialType ?? 'flat') as 'flat' | 'percent_of_rent',
    // S226: recurring accrual + cap. UI toggles derive their initial
    // value from whether the property has the columns set. Toggling
    // off sends null for the whole group on PATCH.
    lateFeeAccrualEnabled: property?.lateFeeAccrualAmount != null && property?.lateFeeAccrualType != null && property?.lateFeeAccrualPeriod != null,
    lateFeeAccrualAmount:  property?.lateFeeAccrualAmount != null ? String(property.lateFeeAccrualAmount) : '5.00',
    lateFeeAccrualType:    (property?.lateFeeAccrualType ?? 'flat') as 'flat' | 'percent_of_rent',
    lateFeeAccrualPeriod:  (property?.lateFeeAccrualPeriod ?? 'daily') as 'daily' | 'weekly' | 'monthly',
    lateFeeCapEnabled:     property?.lateFeeCapAmount != null && property?.lateFeeCapType != null,
    lateFeeCapAmount:      property?.lateFeeCapAmount != null ? String(property.lateFeeCapAmount) : '50.00',
    lateFeeCapType:        (property?.lateFeeCapType ?? 'flat') as 'flat' | 'percent_of_rent',
    // 16a: allocation rule — required at property creation.
    // S172: three independent fee_payer toggles + payout bank account are
    // editable in both create and edit modes; manager-fee math
    // (rentPercent etc.) and placement / maintenance fields stay
    // create-only because they affect retroactive ledger interpretation.
    // S312: API responses now pass through applyCamelizeInterceptor
    // (lib/api.ts), so the allocationRule jsonb (returned via
    // to_jsonb(r.*) at apps/api/src/routes/properties.ts) lands in
    // the frontend as `allocationRule.{achFeePayer,cardFeePayer,...}`.
    // S311 had reverted these reads to snake_case as a stopgap; the
    // transformer makes the camelCase reads the canonical posture
    // again. Form-state keys remain snake_case because the
    // allocation-rule PATCH body expects them that way. Legacy
    // bankingFeePayer fallback covers properties created before S116.
    allocationRule: {
      achFeePayer:
        (property?.allocationRule?.achFeePayer
          || property?.allocationRule?.bankingFeePayer
          || 'tenant') as FeePayer,
      cardFeePayer:
        (property?.allocationRule?.cardFeePayer
          || property?.allocationRule?.bankingFeePayer
          || 'tenant') as FeePayer,
      platformFeePayer:
        (property?.allocationRule?.platformFeePayer || 'landlord') as FeePayer,
      rentPercent: property?.allocationRule?.rentPercent != null ? String(property.allocationRule.rentPercent) : '',
      rentPercentFloor: property?.allocationRule?.rentPercentFloor != null ? String(property.allocationRule.rentPercentFloor) : '',
      rentPercentCeiling: property?.allocationRule?.rentPercentCeiling != null ? String(property.allocationRule.rentPercentCeiling) : '',
      flatMonthlyFee: property?.allocationRule?.flatMonthlyFee != null ? String(property.allocationRule.flatMonthlyFee) : '',
      perUnitFee: property?.allocationRule?.perUnitFee != null ? String(property.allocationRule.perUnitFee) : '',
      placementFeeType: (property?.allocationRule?.placementFeeType || '') as '' | 'flat' | 'percent_of_first_month',
      placementFeeValue: property?.allocationRule?.placementFeeValue != null ? String(property.allocationRule.placementFeeValue) : '',
      maintenanceMarkupPercent: property?.allocationRule?.maintenanceMarkupPercent != null ? String(property.allocationRule.maintenanceMarkupPercent) : '',
      // S66: bank account routing target (UUID or null)
      ownerBankAccountId: (property?.allocationRule?.ownerBankAccountId ?? null) as string | null,
    },
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [addrSuggestions, setAddrSuggestions] = useState<any[]>([])
  const [showAddrSugg, setShowAddrSugg] = useState(false)
  const [addrVerified, setAddrVerified] = useState(false)
  const MAPBOX_TOKEN = (import.meta as any).env?.VITE_MAPBOX_TOKEN || ''
  const addrTimer = useRef<any>(null)
  // Step 2: unit groups — one per selected type
  const [batches, setBatches] = useState<Array<{ id: string; type: string; count: string; prefix: string; rentAmount: string; securityDeposit: string; bedrooms: string }>>([])  

  // S66: active bank accounts for the current user, used by the routing
  // dropdown below. Only active accounts shown — archived rows still exist
  // in the catalog but can't be assigned as a fresh routing target.
  const { data: bankAccounts = [] } = useQuery<any[]>(
    'bank-accounts', () => apiGet('/bank-accounts')
  )
  const activeBankAccounts = bankAccounts.filter(b => b.status === 'active')

  const propMut = useMutation(
    async (data: any) => {
      if (isEdit) {
        // Property core fields PATCH
        const propRes = await apiPatch(`/properties/${property.id}`, data)
        // S66 + S172: allocation-rule PATCH carries the editable fee_payer
        // toggles + payout bank account. Build a delta of just what
        // changed since unchanged values would no-op anyway.
        const arNew = data.allocationRule ?? {}
        // S312: read the saved allocationRule via camelCase keys
        // after the response-interceptor transform.
        const arOld = property?.allocationRule ?? {}
        const allocPatch: Record<string, unknown> = {}
        if (arNew.ownerBankAccountId !== (arOld.ownerBankAccountId ?? null)) {
          allocPatch.ownerBankAccountId = arNew.ownerBankAccountId
        }
        const oldAch       = arOld.achFeePayer       || arOld.bankingFeePayer || 'tenant'
        const oldCard      = arOld.cardFeePayer      || arOld.bankingFeePayer || 'tenant'
        const oldPlatform  = arOld.platformFeePayer  || 'landlord'
        if (arNew.achFeePayer      && arNew.achFeePayer      !== oldAch)      allocPatch.achFeePayer      = arNew.achFeePayer
        if (arNew.cardFeePayer     && arNew.cardFeePayer     !== oldCard)     allocPatch.cardFeePayer     = arNew.cardFeePayer
        if (arNew.platformFeePayer && arNew.platformFeePayer !== oldPlatform) allocPatch.platformFeePayer = arNew.platformFeePayer
        if (Object.keys(allocPatch).length > 0) {
          await apiPatch(`/properties/${property.id}/allocation-rule`, allocPatch)
        }
        return propRes
      }
      return apiPost('/properties', data)
    },
    {
      onSuccess: (res: any) => {
        qc.invalidateQueries('properties')
        if (isEdit) { onClose(); return }
        const pid = res?.data?.id || res?.id
        if (pid && form.unitTypes.length > 0) {
          setCreatedPropId(pid)
          // Init unit groups
          const groups: Record<string, any> = {}
          form.unitTypes.forEach((t: string) => {
            const ut = UNIT_TYPE_OPTIONS.find(u => u.value === t)
            groups[t] = { count: '', prefix: ut?.prefix || 'UNIT', rentAmount: '', securityDeposit: '' }
          })
          // Init one batch per selected type
          const initBatches = form.unitTypes.map((t: string) => {
            const ut = UNIT_TYPE_OPTIONS.find((u: any) => u.value === t)
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
  const toggleUnitType = (t: string) => set('unitTypes', form.unitTypes.includes(t) ? form.unitTypes.filter((x: string) => x !== t) : [...form.unitTypes, t])

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
    const street = s.placeName ? s.placeName.split(',')[0] : s.text || ''
    const city = getCtx('place')
    const stateShort = ctx.find((c: any) => c.id.startsWith('region'))?.shortCode?.replace('US-', '') || form.state
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
    // 16a: convert string inputs to numbers/null for allocation rule
    const ar = form.allocationRule
    const num = (s: string) => s === '' ? null : parseFloat(s)
    const payload = {
      ...form,
      // S223: late-fee fields are strings in form state (input values);
      // PATCH expects numbers. Skip when not in edit mode — create flow
      // uses schema defaults.
      lateFeeGraceDays:     isEdit ? (form.lateFeeGraceDays     === '' ? null : parseInt(form.lateFeeGraceDays, 10))   : undefined,
      lateFeeInitialAmount: isEdit ? (form.lateFeeInitialAmount === '' ? null : parseFloat(form.lateFeeInitialAmount)) : undefined,
      lateFeeEnabled:        isEdit ? form.lateFeeEnabled        : undefined,
      lateFeeInitialType:   isEdit ? form.lateFeeInitialType   : undefined,
      // S226: accrual/cap. Toggle off → send null for the whole group
      // (clears the columns); toggle on → send parsed values. Create
      // mode skips entirely (schema defaults: all null = no accrual,
      // no cap).
      lateFeeAccrualAmount: isEdit ? (form.lateFeeAccrualEnabled ? (form.lateFeeAccrualAmount === '' ? null : parseFloat(form.lateFeeAccrualAmount)) : null) : undefined,
      lateFeeAccrualType:   isEdit ? (form.lateFeeAccrualEnabled ? form.lateFeeAccrualType   : null) : undefined,
      lateFeeAccrualPeriod: isEdit ? (form.lateFeeAccrualEnabled ? form.lateFeeAccrualPeriod : null) : undefined,
      lateFeeCapAmount:     isEdit ? (form.lateFeeCapEnabled ? (form.lateFeeCapAmount === '' ? null : parseFloat(form.lateFeeCapAmount)) : null) : undefined,
      lateFeeCapType:       isEdit ? (form.lateFeeCapEnabled ? form.lateFeeCapType : null) : undefined,
      allocationRule: {
        achFeePayer:       ar.achFeePayer,
        cardFeePayer:      ar.cardFeePayer,
        platformFeePayer:  ar.platformFeePayer,
        rentPercent: num(ar.rentPercent),
        rentPercentFloor: num(ar.rentPercentFloor),
        rentPercentCeiling: num(ar.rentPercentCeiling),
        flatMonthlyFee: num(ar.flatMonthlyFee),
        perUnitFee: num(ar.perUnitFee),
        placementFeeType: ar.placementFeeType === '' ? null : ar.placementFeeType,
        placementFeeValue: num(ar.placementFeeValue),
        maintenanceMarkupPercent: num(ar.maintenanceMarkupPercent),
        ownerBankAccountId: ar.ownerBankAccountId,
      },
    }
    propMut.mutate(payload)
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
    const ut = UNIT_TYPE_OPTIONS.find(u => u.value === type)
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
                {UNIT_TYPE_OPTIONS.map(t => {
                  const on = form.unitTypes.includes(t.value)
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
                        <div style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--text-0)' }}>{s.placeName?.split(',')[0] || s.text}</div>
                        <div style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>{s.placeName?.split(',').slice(1, 3).join(',').trim()}</div>
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
                  <input className="input" placeholder="State" value={form.state} onChange={e => set('state', e.target.value)} style={{ width: '100%' }} />
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

          {/* S179 / B3: per-property booking acknowledgment toggle.
              When on, every booking on this property requires staff to mark
              acknowledged after collecting signature on the property-rules
              document. Default off; flip on for RV-park / short-stay
              properties where rules need explicit guest sign-off. */}
          <div style={{ marginBottom: 14, paddingTop: 10, borderTop: '1px solid var(--border-0)' }}>
            <div style={{ fontSize: '.78rem', fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
              Booking policy
            </div>
            <label style={{
              display:        'flex',
              alignItems:     'flex-start',
              gap:            10,
              padding:        12,
              borderRadius:   8,
              border:         `1px solid ${form.requiresBookingAcknowledgment ? 'var(--gold)' : 'var(--border-0)'}`,
              background:     form.requiresBookingAcknowledgment ? 'rgba(201,162,39,.06)' : 'var(--bg-2)',
              cursor:         'pointer',
              fontSize:       '.78rem',
            }}>
              <input
                type="checkbox"
                checked={form.requiresBookingAcknowledgment}
                onChange={e => setForm(f => ({ ...f, requiresBookingAcknowledgment: e.target.checked }))}
                style={{ marginTop: 3 }}
              />
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>Require booking acknowledgment</div>
                <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5 }}>
                  Every booking on this property will track whether the guest signed the property
                  rules. Staff mark each booking acknowledged after the signature is on file. Useful
                  for RV parks and short-stay properties where house rules need explicit sign-off.
                </div>
              </div>
            </label>
          </div>

          {/* S247: per-property subleasing toggle. Master switch driven
              by the property's lease document. Default OFF (opt-in).
              When on, individual leases can still further restrict via
              leases.subleasingAllowed. */}
          <div style={{ marginBottom: 14, paddingTop: 10, borderTop: '1px solid var(--border-0)' }}>
            <div style={{ fontSize: '.78rem', fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
              Subleasing policy
            </div>
            <label style={{
              display:        'flex',
              alignItems:     'flex-start',
              gap:            10,
              padding:        12,
              borderRadius:   8,
              border:         `1px solid ${form.subleasingAllowed ? 'var(--gold)' : 'var(--border-0)'}`,
              background:     form.subleasingAllowed ? 'rgba(201,162,39,.06)' : 'var(--bg-2)',
              cursor:         'pointer',
              fontSize:       '.78rem',
            }}>
              <input
                type="checkbox"
                checked={form.subleasingAllowed}
                onChange={e => setForm(f => ({ ...f, subleasingAllowed: e.target.checked }))}
                style={{ marginTop: 3 }}
              />
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>Allow subleasing at this property</div>
                <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5 }}>
                  Tenants on leases at this property may request subleases (subject to each lease's
                  own subleasing clause). Disable if your lease agreement prohibits subleasing.
                  Check your local laws — some jurisdictions limit a landlord's ability to refuse
                  subleases unreasonably.
                </div>
              </div>
            </label>

            {/* S251: optional template URL override. When set, the
                landlord-provided PDF replaces the GAM-default
                template at sublease document generation time. */}
            {form.subleasingAllowed && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-0)' }}>
                <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-2)', marginBottom: 5 }}>
                  Custom sublease agreement template (optional)
                </div>
                <input
                  className="form-input"
                  type="url"
                  placeholder="https://example.com/sublease-template.pdf"
                  value={form.subleaseAgreementTemplateUrl}
                  onChange={e => setForm(f => ({ ...f, subleaseAgreementTemplateUrl: e.target.value }))}
                  style={{ width: '100%' }}
                />
                <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 6, lineHeight: 1.5 }}>
                  Leave blank to use GAM's default sublease agreement template. To override, host
                  your own PDF and paste the URL. Both parties (sublessor + sublessee) sign whatever
                  template is set.
                </div>
              </div>
            )}
          </div>

          {/* S309: per-property FlexCharge enablement gate. Default
              OFF (opt-in). When OFF, this property does not appear in
              the FlexCharge create-account property dropdown and the
              backend rejects new account creation here with a 403.
              Existing accounts (if any) continue to function. */}
          <div style={{ marginBottom: 14, paddingTop: 10, borderTop: '1px solid var(--border-0)' }}>
            <div style={{ fontSize: '.78rem', fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
              FlexCharge
            </div>
            <label style={{
              display:        'flex',
              alignItems:     'flex-start',
              gap:            10,
              padding:        12,
              borderRadius:   8,
              border:         `1px solid ${form.flexchargeEnabled ? 'var(--gold)' : 'var(--border-0)'}`,
              background:     form.flexchargeEnabled ? 'rgba(201,162,39,.06)' : 'var(--bg-2)',
              cursor:         'pointer',
              fontSize:       '.78rem',
            }}>
              <input
                type="checkbox"
                checked={form.flexchargeEnabled}
                onChange={e => setForm(f => ({ ...f, flexchargeEnabled: e.target.checked }))}
                style={{ marginTop: 3 }}
              />
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>Offer FlexCharge at this property</div>
                <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5 }}>
                  Enable a rolling charge account for tenants and POS customers at this property — typical at RV parks,
                  extended-stay properties, and on-site stores where the account holder runs a tab for property-store
                  purchases, utilities, services, etc. <strong>You are the creditor on FlexCharge</strong> — you set
                  the credit limit, any finance charges, and the payment cadence; GAM provides the accounting software
                  only. You are responsible for TILA, ECOA, FCRA, FDCPA, and state lending/usury-law compliance.
                  Review the FlexCharge Business Account Agreement before enabling, and consult counsel in your state
                  if you have not previously offered consumer credit.
                </div>
              </div>
            </label>
          </div>

          {/* S223: property-level late-fee policy. Edit-only —
              new properties pick up schema defaults
              (enabled=true / grace=5 / amount=$15 / type='flat'). The
              inline notice spells out Option B semantics: existing
              leases keep their current late-fee config; this is a
              forward-looking template, not a propagating change. */}
          {isEdit && (
            <div style={{ marginBottom: 14, paddingTop: 10, borderTop: '1px solid var(--border-0)' }}>
              <div style={{ fontSize: '.78rem', fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
                Late-fee policy
              </div>
              <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>
                These settings define this property's default late-fee policy for new leases.
                Existing leases keep their current late-fee configuration — changes here do not
                propagate retroactively.
              </div>
              <label style={{
                display:        'flex',
                alignItems:     'flex-start',
                gap:            10,
                padding:        12,
                borderRadius:   8,
                border:         `1px solid ${form.lateFeeEnabled ? 'var(--gold)' : 'var(--border-0)'}`,
                background:     form.lateFeeEnabled ? 'rgba(201,162,39,.06)' : 'var(--bg-2)',
                cursor:         'pointer',
                fontSize:       '.78rem',
                marginBottom:   10,
              }}>
                <input
                  type="checkbox"
                  checked={form.lateFeeEnabled}
                  onChange={e => setForm(f => ({ ...f, lateFeeEnabled: e.target.checked }))}
                  style={{ marginTop: 3 }}
                />
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>Late fees enabled</div>
                  <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 3 }}>
                    Off = no late fees ever assessed at this property regardless of lease config.
                  </div>
                </div>
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, opacity: form.lateFeeEnabled ? 1 : 0.5 }}>
                <div>
                  <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Grace period (days)</div>
                  <input
                    type="number"
                    min="0"
                    value={form.lateFeeGraceDays}
                    disabled={!form.lateFeeEnabled}
                    onChange={e => setForm(f => ({ ...f, lateFeeGraceDays: e.target.value }))}
                    style={{ width: '100%', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box' }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Initial fee</div>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.lateFeeInitialAmount}
                    disabled={!form.lateFeeEnabled}
                    onChange={e => setForm(f => ({ ...f, lateFeeInitialAmount: e.target.value }))}
                    style={{ width: '100%', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box' }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Fee type</div>
                  <select
                    value={form.lateFeeInitialType}
                    disabled={!form.lateFeeEnabled}
                    onChange={e => setForm(f => ({ ...f, lateFeeInitialType: e.target.value as 'flat' | 'percent_of_rent' }))}
                    style={{ width: '100%', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box', color: 'var(--text-0)' }}
                  >
                    <option value="flat">Flat $</option>
                    <option value="percent_of_rent">% of rent</option>
                  </select>
                </div>
              </div>

              {/* S226: recurring accrual toggle + 3 inputs. Disabled when
                  the parent late-fee toggle is off — accrual without a
                  parent fee makes no sense. */}
              <div style={{ marginTop: 14, opacity: form.lateFeeEnabled ? 1 : 0.4 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: form.lateFeeEnabled ? 'pointer' : 'not-allowed', marginBottom: 8 }}>
                  <input
                    type="checkbox"
                    checked={form.lateFeeAccrualEnabled}
                    disabled={!form.lateFeeEnabled}
                    onChange={e => setForm(f => ({ ...f, lateFeeAccrualEnabled: e.target.checked }))}
                  />
                  <span style={{ fontSize: '.78rem', color: 'var(--text-1)', fontWeight: 600 }}>Recurring accrual</span>
                  <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>(continues to add up after the initial fee)</span>
                </label>
                {form.lateFeeAccrualEnabled && form.lateFeeEnabled && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                    <div>
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Amount per period</div>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={form.lateFeeAccrualAmount}
                        onChange={e => setForm(f => ({ ...f, lateFeeAccrualAmount: e.target.value }))}
                        style={{ width: '100%', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box' }}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Type</div>
                      <select
                        value={form.lateFeeAccrualType}
                        onChange={e => setForm(f => ({ ...f, lateFeeAccrualType: e.target.value as 'flat' | 'percent_of_rent' }))}
                        style={{ width: '100%', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box', color: 'var(--text-0)' }}
                      >
                        <option value="flat">Flat $</option>
                        <option value="percent_of_rent">% of rent</option>
                      </select>
                    </div>
                    <div>
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Period</div>
                      <select
                        value={form.lateFeeAccrualPeriod}
                        onChange={e => setForm(f => ({ ...f, lateFeeAccrualPeriod: e.target.value as 'daily' | 'weekly' | 'monthly' }))}
                        style={{ width: '100%', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box', color: 'var(--text-0)' }}
                      >
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>

              {/* S226: maximum cap toggle + 2 inputs. Cap-edge writes a
                  partial row of exactly the remaining amount, then stops
                  (locked decision per S26b). Independent of accrual. */}
              <div style={{ marginTop: 14, opacity: form.lateFeeEnabled ? 1 : 0.4 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: form.lateFeeEnabled ? 'pointer' : 'not-allowed', marginBottom: 8 }}>
                  <input
                    type="checkbox"
                    checked={form.lateFeeCapEnabled}
                    disabled={!form.lateFeeEnabled}
                    onChange={e => setForm(f => ({ ...f, lateFeeCapEnabled: e.target.checked }))}
                  />
                  <span style={{ fontSize: '.78rem', color: 'var(--text-1)', fontWeight: 600 }}>Maximum cap</span>
                  <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>(total late fees per invoice cannot exceed this)</span>
                </label>
                {form.lateFeeCapEnabled && form.lateFeeEnabled && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div>
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Cap amount</div>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={form.lateFeeCapAmount}
                        onChange={e => setForm(f => ({ ...f, lateFeeCapAmount: e.target.value }))}
                        style={{ width: '100%', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box' }}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 4 }}>Cap type</div>
                      <select
                        value={form.lateFeeCapType}
                        onChange={e => setForm(f => ({ ...f, lateFeeCapType: e.target.value as 'flat' | 'percent_of_rent' }))}
                        style={{ width: '100%', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box', color: 'var(--text-0)' }}
                      >
                        <option value="flat">Flat $</option>
                        <option value="percent_of_rent">% of rent</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 16a allocation rule.
              S172: ACH / card / platform fee_payer toggles + payout bank
              account are editable in both create and edit modes. Manager
              fee (rentPercent) and other allocation math fields stay
              create-only because they affect retroactive ledger
              interpretation. */}
          <div style={{ marginBottom: 14, paddingTop: 10, borderTop: '1px solid var(--border-0)' }}>
            <div style={{ fontSize: '.78rem', fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
              Who pays each fee?
            </div>
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>
              Each can be passed through to the tenant (added on top of rent) or absorbed by the
              landlord (deducted from gross). Toggles can be changed any time — they only affect
              charges going forward.
            </div>

            <FeePayerToggle
              label="ACH processing"
              hint="1.0% capped at $6.00 per ACH debit"
              value={form.allocationRule.achFeePayer}
              onChange={(v) => setForm(f => ({ ...f, allocationRule: { ...f.allocationRule, achFeePayer: v } }))}
            />
            <FeePayerToggle
              label="Card processing"
              hint="3.25% per card charge (+1.5% on non-US-issued cards)"
              value={form.allocationRule.cardFeePayer}
              onChange={(v) => setForm(f => ({ ...f, allocationRule: { ...f.allocationRule, cardFeePayer: v } }))}
            />
            <FeePayerToggle
              label="Platform SaaS fee"
              hint="$2 per occupied unit per month (min $10/property/mo)"
              value={form.allocationRule.platformFeePayer}
              onChange={(v) => setForm(f => ({ ...f, allocationRule: { ...f.allocationRule, platformFeePayer: v } }))}
            />

            {!isEdit && <>
              <div style={{ fontSize: '.78rem', fontWeight: 600, marginBottom: 6, marginTop: 10, color: 'var(--text-2)' }}>
                Manager Fee (% of rent — optional, blank = owner-self-managed)
              </div>
              <input type="number" step="0.01" placeholder="e.g. 8 for 8%"
                value={form.allocationRule.rentPercent}
                onChange={e => setForm(f => ({ ...f, allocationRule: { ...f.allocationRule, rentPercent: e.target.value } }))}
                style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box', marginBottom: 14 }} />
            </>}

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <Landmark size={12} color="var(--gold)" />
              <span style={{ fontSize: '.78rem', fontWeight: 600, color: 'var(--text-2)' }}>
                Payout Bank Account
              </span>
            </div>
            <select
              value={form.allocationRule.ownerBankAccountId ?? ''}
              onChange={e => setForm(f => ({ ...f, allocationRule: { ...f.allocationRule, ownerBankAccountId: e.target.value || null } }))}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box', color: 'var(--text-0)' }}>
              <option value="">— None (rent will accumulate, not pay out) —</option>
              {activeBankAccounts.map(b => (
                <option key={b.id} value={b.id}>
                  {b.nickname} • {b.accountType} •••• {b.accountNumberLast4}
                </option>
              ))}
            </select>
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 6 }}>
              Multiple properties can share one account — they collapse into a single Friday disbursement.{' '}
              <Link to="/banking" style={{ color: 'var(--gold)', textDecoration: 'underline' }}>
                + Add bank account
              </Link>
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
              {propMut.isLoading ? <span className="spinner" /> : <><Check size={14} /> {isEdit ? 'Save Changes' : form.unitTypes.length > 0 ? 'Next: Create Units →' : 'Add Property'}</>}
            </button>
          </div>
        </>}

        {step === 2 && <>
          <div style={{ fontSize: '.82rem', color: 'var(--text-3)', marginBottom: 16 }}>
            Add batches for each unit type. Each batch can have a different price — e.g. 20 storage units at $100/mo and 30 at $150/mo. Unit numbers auto-assigned; fill in details per unit later.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {form.unitTypes.map((type: string) => {
              const ut = UNIT_TYPE_OPTIONS.find((u: any) => u.value === type)!
              const typeBatches = batches.filter(b => b.type === type)
              const showBeds = UNIT_TYPE_HAS_BEDROOMS[type as UnitType] ?? false
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
  const navigate = useNavigate()
  const [showAdd, setShowAdd] = useState(false)
  const [editProp, setEditProp] = useState<any>(null)
  const [addUnitForProp, setAddUnitForProp] = useState<any>(null)

  const { data: props = [], isLoading } = useQuery<any[]>('properties', () => apiGet('/properties'))
  const { data: units = [] } = useQuery<any[]>('units', () => apiGet('/units'))

  // Compute stats per property
  const propStats = (props as any[]).map(p => {
    const propUnits = (units as any[]).filter(u => u.propertyId === p.id)
    const occupied  = propUnits.filter(u => u.tenantId).length
    const vacant    = propUnits.filter(u => !u.tenantId).length
    const monthlyRevenue = propUnits.filter(u => u.tenantId).reduce((s, u) => s + parseFloat(u.rentAmount || 0), 0)
    return { ...p, totalUnits: propUnits.length, occupied, vacant, monthlyRevenue }
  })

  const totalUnits    = propStats.reduce((s, p) => s + p.totalUnits, 0)
  const totalOccupied = propStats.reduce((s, p) => s + p.occupied, 0)
  const totalRevenue  = propStats.reduce((s, p) => s + p.monthlyRevenue, 0)
  const superMaxRevenue = (units as any[]).reduce((s, u) => s + parseFloat(u.rentAmount||0), 0)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Properties</h1>
          <p className="page-subtitle">{(props as any[]).length} properties · {totalUnits} units · {totalOccupied} occupied</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => navigate('/property-onboarding')}>
            Bulk import CSV
          </button>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Plus size={15} /> Add Property
          </button>
        </div>
      </div>

      <ConnectReadinessBanner />

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

                  {/* S173: fee config chips */}
                  <FeeConfigChips allocationRule={p.allocationRule} />

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

// S161: surfaces a soft warning when the landlord hasn't completed
// Stripe Connect onboarding. Doesn't block property creation — Nic's
// rule that staffing/operations data should land before the rent rail
// is up. Routes to /banking on click. Self-hides when onboarding is
// done (cached `payoutsEnabled` = true).
function ConnectReadinessBanner() {
  const navigate = useNavigate()
  // S321: snake_case reads were silently undefined post-S312 (response
  // interceptor camelizes), so this banner never auto-hid after the
  // landlord finished Stripe Connect onboarding. Reading camelCase
  // now picks up the bridged values correctly.
  const { data } = useQuery<{ payoutsEnabled?: boolean; detailsSubmitted?: boolean; exists?: boolean }>(
    'stripe-connect-status-user',
    () => apiGet('/stripe/connect/status?entity=user'),
  )
  if (!data) return null
  if (data.payoutsEnabled && data.detailsSubmitted) return null

  return (
    <div className="card"
         onClick={() => navigate('/banking')}
         style={{
           padding: 14, marginBottom: 16, cursor: 'pointer',
           background: 'rgba(220,165,40,.08)',
           border: '1px solid rgba(220,165,40,.3)',
         }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 600, color: 'var(--gold)' }}>
            Stripe Connect onboarding incomplete
          </div>
          <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginTop: 4 }}>
            Properties can still be added now, but tenants won&apos;t be able to pay rent through GAM until you finish KYC.
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); navigate('/banking') }}>
          Open Banking →
        </button>
      </div>
    </div>
  )
}
