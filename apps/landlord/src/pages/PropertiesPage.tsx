import { SUBLEASING_SHELVED } from '../components/layout/Layout'
import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Link, useNavigate } from 'react-router-dom'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { Building2, Plus, MapPin, DoorOpen, Users, DollarSign, X, Check, Edit2, Landmark, Globe } from 'lucide-react'
import { AddUnitModal } from './AddUnitModal'
import { usePerms } from '../lib/permissions'
import { LawWarningBanner, type LawFlag } from '../components/LawWarningBanner'
import { UNIT_TYPES, UNIT_TYPE_LABEL, UNIT_TYPE_PREFIX, UNIT_TYPE_ICON, FEE_PAYER_VALUES, cardFeeLabel, achFeeLabel, MANUAL_PAYMENT_FEE_SCOPE, type FeePayer } from '@gam/shared'
// Narrow KPI tiles use the compact format ($18,400 / $248.6K / $1.24M) so a
// six-/seven-figure property (or portfolio sum) never overflows or resizes a card.
import { fmtCompact as fmt } from '../lib/format'

// S574: the public per-property website — path-slug in dev, {slug}.gam.biz in
// prod (mirrors the API's STOREFRONT_URL_TEMPLATE + SchedulePage). Every
// onboarded property auto-publishes one, so we surface a "View website" link
// on the card whenever it's live.
// Explicit env override wins; otherwise localhost gets the dev path form and any
// real host gets the prod subdomain ({slug}.gam.biz) — so the link is correct in
// production without a build-time env var.
const STOREFRONT_TEMPLATE = (import.meta as any).env?.VITE_STOREFRONT_URL_TEMPLATE
  || (typeof location !== 'undefined' && /^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname)
        ? 'http://localhost:3015/{slug}'
        : 'https://{slug}.gam.biz')
const publicSiteUrl = (p: any): string | null =>
  (p?.publicBookingEnabled && p?.bookingSlug) ? STOREFRONT_TEMPLATE.replace('{slug}', p.bookingSlug) : null

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
  const manual   = (allocationRule.manualFeePayer   || 'tenant')                                    as FeePayer
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
      {chip('Cash', manual)}
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
  const navigate = useNavigate()
  const isEdit = !!property
  // S527: the bulk "Create Units" step 2 is GONE (Nic: one door for units).
  // Creating a property lands on its detail page — subtypes + Add Unit
  // (with quantity) live there.
  // S620 (Nic): "property under new entity but same parent company — same land
  // owner, different LLCs." A property has to be able to land on an entity
  // other than the one you registered under, and this is the only moment the
  // choice matters, so it belongs on this form rather than in a mode you switch.
  const { data: entities = [] } = useQuery<any[]>(
    'landlord-entities', () => apiGet('/landlords/me/entities'))
  // S620 (Nic): "if I've got a big portfolio, eight entities that own twelve
  // different properties" — sending someone to Settings to create the LLC and
  // then back here to use it is a round trip they would make constantly. The
  // entity gets created without leaving this form.
  const [newEntityName, setNewEntityName] = useState('')
  const [entityErr, setEntityErr] = useState<string | null>(null)
  // S629: with no blank default, a one-entity portfolio would open on the
  // placeholder and force a pointless choice. Preselect when there is nothing
  // to choose between — and only then.
  useEffect(() => {
    if (isEdit) return
    if (form.landlordId) return
    if (entities.length === 1) setForm(f => ({ ...f, landlordId: entities[0].id }))
  }, [entities, isEdit])

  const [form, setForm] = useState({
    landlordId:  '',
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
    // S526: weekly-lease jurisdictions — auto-drafts a lease at 7+ day stays
    // instead of 30+ (see services/bookingLeaseDraft.ts).
    weeklyLeaseMode: property?.weeklyLeaseMode ?? false,
    // S247: per-property subleasing toggle. Drives the master switch
    // on whether tenants at this property can request subleases at
    // all. AND'd with leases.subleasingAllowed in the request route.
    subleasingAllowed: property?.subleasingAllowed ?? false,
    // S568 (Nic): does the operator own the land here? FALSE = homes-only
    // external park — an investor operates their homes here without owning the
    // park (park owner not on GAM). Drives lot-rent capture on units.
    operatorOwnsLand: property?.operatorOwnsLand ?? true,
    // S251: optional landlord-uploaded sublease agreement template URL.
    // When set, overrides the GAM-default generated PDF at sublease
    // approval time. Stored as URL string — file upload handling is
    // a separate landlord-side feature; for now the landlord points
    // GAM at a hosted PDF (e.g., their own S3 / Dropbox link).
    subleaseAgreementTemplateUrl: property?.subleaseAgreementTemplateUrl ?? '',
    // S526 (Nic): the FlexCharge toggle (S309) and the property-level
    // late-fee policy surface (S223/S226) are REMOVED from this form.
    // FlexCharge is not a launch feature; late fees are charged strictly
    // per each tenant's signed lease — no landlord-settable knob may exist
    // anywhere that could conflict with the lease. The backend columns and
    // lease-side late-fee engine stay intact.
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
      // S513 lock (#2): card is always the tenant's — never landlord. Pinned
      // to 'tenant' regardless of any legacy 'landlord' row (the diff on save
      // then heals such rows; the backend also clamps card to tenant).
      cardFeePayer: 'tenant' as FeePayer,
      platformFeePayer:
        (property?.allocationRule?.platformFeePayer || 'landlord') as FeePayer,
      // S607 (Nic): who reimburses the cash/check/money-order fee.
      manualFeePayer:
        (property?.allocationRule?.manualFeePayer || 'tenant') as FeePayer,
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

  // S66: active bank accounts for the current user, used by the routing
  // dropdown below. Only active accounts shown — archived rows still exist
  // in the catalog but can't be assigned as a fresh routing target.
  const { data: bankAccounts = [] } = useQuery<any[]>(
    'bank-accounts', () => apiGet('/bank-accounts')
  )
  const activeBankAccounts = bankAccounts.filter(b => b.status === 'active')

  // S631 (Nic): "I'm pretty sure I already added the Oak Park bank account with
  // Stripe, with the know-your-customer information. So why is it still asking
  // me for a bank account here? The default deposit account for platform payouts
  // should be the same account that's verified for KYC through Stripe."
  //
  // He is right, and the old copy was worse than redundant — it was FALSE. This
  // selector lists GAM-side bank rows, a leftover from the pre-Phase-4 model
  // where GAM swept its own ledger. Payouts have gone through Stripe Connect
  // since S561: jobs/autoPayouts.ts reads the live Connect balance and fires
  // stripe.payouts.create against the bank attached during KYC. This field only
  // TAGS a ledger row; it moves no money and blocks none. So a landlord with
  // Connect fully enabled was told "rent will accumulate, not pay out" about
  // money that was already paying out on schedule.
  //
  // Keyed to THIS property's entity. The status endpoint answers per entity —
  // a bare call returns the signed-in user's own account, which on a portfolio
  // of LLCs is the wrong one, and would have reported "not set up" about an
  // entity whose payouts are live.
  const payoutEntityId = (property as any)?.landlordId || form.landlordId || null
  const { data: connectStatus } = useQuery<any>(
    ['stripe-connect-status', 'landlord', payoutEntityId],
    () => apiGet(`/stripe/connect/status?entity=landlord&entityId=${payoutEntityId}`),
    { enabled: !!payoutEntityId, staleTime: 60_000 })
  const connectBank = connectStatus?.payoutsEnabled ? connectStatus?.payoutBank : null

  // S481: state-law warnings from property PATCH response. Empty on
  // close-immediately path; populated when the backend surfaced a
  // hedged factual mismatch (modal stays open with banner).
  const [stateLawWarnings, setStateLawWarnings] = useState<LawFlag[]>([])

  const propMut = useMutation(
    async (data: any) => {
      if (isEdit) {
        // Property core fields PATCH
        const propRes = await apiPatch<any>(`/properties/${property.id}`, data)
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
        const oldManual    = arOld.manualFeePayer    || 'tenant'
        if (arNew.manualFeePayer   && arNew.manualFeePayer   !== oldManual)   allocPatch.manualFeePayer   = arNew.manualFeePayer
        if (arNew.achFeePayer      && arNew.achFeePayer      !== oldAch)      allocPatch.achFeePayer      = arNew.achFeePayer
        if (arNew.cardFeePayer     && arNew.cardFeePayer     !== oldCard)     allocPatch.cardFeePayer     = arNew.cardFeePayer
        if (arNew.platformFeePayer && arNew.platformFeePayer !== oldPlatform) allocPatch.platformFeePayer = arNew.platformFeePayer
        if (Object.keys(allocPatch).length > 0) {
          await apiPatch(`/properties/${property.id}/allocation-rule`, allocPatch)
        }
        return propRes
      }
      // Blank means "my own entity" — the server default, so every existing
      // caller behaves exactly as before.
      const { landlordId, ...rest } = data
      // S629: a property with no owning entity is exactly the silent
      // mis-filing this form used to allow. There is no default to fall back
      // on any more, so an unanswered picker is an error, not a shrug.
      if (!landlordId) throw new Error('Choose the entity that owns this property.')
      // S629 (Nic): "separate my Mountain View property into the entity that I
      // typed when onboarding the property." He typed one, and it was thrown
      // away. This line used to map '__new__' to null, so somebody who chose
      // "+ Add a new entity…", typed the LLC name and pressed Save — without
      // noticing the separate Create button — had the name silently discarded
      // and the property filed under their DEFAULT entity instead.
      //
      // Silent is the whole problem: the property saved, so nothing looked
      // wrong, and the mistake only surfaced later as a property sitting in
      // the wrong LLC — which for him meant a co-owner of the other entity
      // could see it.
      //
      // Typing a name and pressing Save is not ambiguous. Create the entity
      // and use it.
      let realEntity = landlordId && landlordId !== '__new__' ? landlordId : null
      if (landlordId === '__new__') {
        const typed = newEntityName.trim()
        if (!typed) {
          throw new Error('Name the new entity, or pick one from the list.')
        }
        const made: any = await apiPost<any>('/landlords/me/entities', { businessName: typed })
        realEntity = made?.data?.landlordId ?? made?.landlordId ?? null
        if (!realEntity) throw new Error('Could not create that entity. Try creating it in Settings first.')
        qc.invalidateQueries('landlord-entities')
      }
      return apiPost('/properties', realEntity ? { ...rest, landlordId: realEntity } : rest)
    },
    {
      onSuccess: (res: any) => {
        qc.invalidateQueries('properties')
        if (isEdit) {
          // S481: hold modal open when the backend surfaced state-law
          // warnings; save was committed regardless. apiPatch unwraps
          // to r.data.data; responses are camelized, so warnings sit at res.stateLawWarnings.
          const warnings: LawFlag[] = res?.stateLawWarnings ?? []
          if (warnings.length > 0) {
            setStateLawWarnings(warnings)
          } else {
            setStateLawWarnings([])
            onClose()
          }
          return
        }
        const pid = res?.data?.id || res?.id
        onClose()
        // Land on the new property — define subtypes and add units there.
        if (pid) navigate(`/properties/${pid}`)
      }
    }
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
      allocationRule: {
        achFeePayer:       ar.achFeePayer,
        manualFeePayer:    ar.manualFeePayer,
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

  const lbl = { fontSize: '.72rem' as const, fontWeight: 600 as const, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '.06em', display: 'block' as const, marginBottom: 5 }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 680, width: '95vw' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>
            {isEdit ? 'Edit Property' : 'Add Property'}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>

        <>
          {/* S629 (Nic): "there's no default blank spot that is just randomly
              losing or adding properties or linking them the wrong way."
              
              THERE IS NO DEFAULT. The old version opened on "My own entity" —
              a blank value that quietly meant the caller's own entity — so a
              landlord who chose "+ Add a new entity…", typed his LLC name and
              pressed Save got the name discarded and the property filed under
              the wrong company. It saved, so nothing looked wrong. He found
              out when a co-owner of the OTHER entity could see the property.

              Now: pick one, or type a new one. Typing it creates it. The only
              case that is pre-filled is a portfolio with exactly one entity,
              where there is nothing to choose between. */}
          {!isEdit && (
            <div style={{ marginBottom: 12 }}>
              <label className="form-label">Entity</label>
              <select className="input" value={form.landlordId}
                onChange={e => { setForm(f => ({ ...f, landlordId: e.target.value })); setEntityErr(null) }}>
                {/* Placeholder, not a value. Disabled so it cannot be chosen
                    back into, and never submitted — a property without an
                    owning entity is the bug this whole block exists to stop. */}
                <option value="" disabled>Select the entity that owns it…</option>
                {entities.map((en: any) => (
                  <option key={en.id} value={en.id}>
                    {en.businessName || 'Unnamed entity'}
                    {en.propertyCount ? ` — ${en.propertyCount} propert${en.propertyCount === 1 ? 'y' : 'ies'}` : ''}
                  </option>
                ))}
                <option value="__new__">+ Add a new entity…</option>
              </select>
              {form.landlordId === '__new__' ? (
                <>
                  <input className="input" style={{ marginTop: 8 }} autoFocus
                    placeholder="New entity name (e.g. Mountain View RV Park Ranch LLC)"
                    value={newEntityName}
                    onChange={e => { setNewEntityName(e.target.value); setEntityErr(null) }} />
                  <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 4 }}>
                    Saving the property creates this entity and files it there.
                  </div>
                </>
              ) : (
                <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 4 }}>
                  Which LLC owns this property. Each entity keeps its own bank account.
                </div>
              )}
              {entityErr && (
                <div style={{ fontSize: '.7rem', color: 'var(--red)', marginTop: 4 }}>{entityErr}</div>
              )}
            </div>
          )}

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

          {/* S526 layout fix: stacked full-width rows (the old two-column grid
              crammed the amenity chips beside the address fields). */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ marginBottom: 10 }}>
              <label style={lbl}>Property Name *</label>
              <input className="input" placeholder="Oak Street Apartments" value={form.name} onChange={e => set('name', e.target.value)} style={{ width: '100%' }} autoFocus />
              {errors.name && <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 3 }}>{errors.name}</div>}
            </div>

            {/* S631 (Nic, DIRECTIVE): "We should maybe lock the street address once
                it's set. That way it's not altering our future heat map." An
                address decides which state's laws apply, which timezone rent is
                due in, and whether two landlords are claiming the same park — so
                it is stated once and then read-only. The server refuses a change
                too; this is the half that explains why. */}
            {isEdit ? (
              <div style={{ marginBottom: 10 }}>
                <label style={lbl}>Address</label>
                <div style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)',
                  background: 'var(--bg-2)', fontSize: '.85rem', color: 'var(--text-1)' }}>
                  {[form.street1, form.street2].filter(Boolean).join(' ')}<br />
                  {form.city}{form.city && form.state ? ', ' : ''}{form.state} {form.zip}
                </div>
                <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 6 }}>
                  Fixed once set — it decides which state&apos;s rules apply and which timezone rent is
                  due in. If it&apos;s wrong, contact support and we&apos;ll correct it.
                </div>
              </div>
            ) : (<>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10, marginBottom: 10 }}>
              <div style={{ position: 'relative' }}>
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

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 80px 110px', gap: 10, marginBottom: 10 }}>
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
            </>)}

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

          {/* S179 / B3: per-property booking acknowledgment toggle.
              When on, every booking on this property requires staff to mark
              acknowledged after collecting signature on the property-rules
              document. Default off; flip on for RV-park / short-stay
              properties where rules need explicit guest sign-off. */}
          <div style={{ marginBottom: 14, paddingTop: 10, borderTop: '1px solid var(--border-0)' }}>
            <div style={{ fontSize: '.78rem', fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
              Reservation policy
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
                <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>Require reservation acknowledgment</div>
                <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5 }}>
                  Every reservation on this property will track whether the guest signed the property
                  rules. Staff mark each reservation acknowledged after the signature is on file. Useful
                  for RV parks and short-stay properties where house rules need explicit sign-off.
                </div>
              </div>
            </label>

            {/* S526: weekly-lease mode. Long stays auto-draft a lease for
                review — 30+ days by default; this drops the threshold to 7+
                for jurisdictions where weekly leases are the norm. */}
            <label style={{
              display:        'flex',
              alignItems:     'flex-start',
              gap:            10,
              padding:        12,
              marginTop:      8,
              borderRadius:   8,
              border:         `1px solid ${form.weeklyLeaseMode ? 'var(--gold)' : 'var(--border-0)'}`,
              background:     form.weeklyLeaseMode ? 'rgba(201,162,39,.06)' : 'var(--bg-2)',
              cursor:         'pointer',
              fontSize:       '.78rem',
            }}>
              <input
                type="checkbox"
                checked={form.weeklyLeaseMode}
                onChange={e => setForm(f => ({ ...f, weeklyLeaseMode: e.target.checked }))}
                style={{ marginTop: 3 }}
              />
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>Weekly leases</div>
                <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5 }}>
                  Stays of 30+ days automatically draft a lease for your review. Turn this on where you
                  run weekly leases — the draft threshold drops to 7+ days instead.
                </div>
              </div>
            </label>
          </div>

          {/* S247: per-property subleasing toggle. Master switch driven
              by the property's lease document. Default OFF (opt-in).
              When on, individual leases can still further restrict via
              leases.subleasingAllowed. */}
          {/* S568 (Nic): investor-operator model — do you own the land here? */}
          {/* S605: land-ownership capture drives lot rent, which is shelved
              with subleasing — see SUBLEASING_SHELVED in Layout. */}
          {!SUBLEASING_SHELVED && (<>
          <div style={{ marginBottom: 14, paddingTop: 10, borderTop: '1px solid var(--border-0)' }}>
            <div style={{ fontSize: '.78rem', fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
              Land ownership
            </div>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: 12,
              borderRadius: 8, border: `1px solid ${!form.operatorOwnsLand ? 'var(--gold)' : 'var(--border-0)'}`,
              background: !form.operatorOwnsLand ? 'rgba(201,162,39,.06)' : 'var(--bg-2)', cursor: 'pointer', fontSize: '.78rem' }}>
              <input type="checkbox" checked={!form.operatorOwnsLand}
                onChange={e => setForm(f => ({ ...f, operatorOwnsLand: !e.target.checked }))} style={{ marginTop: 3 }} />
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>I don't own the land here (homes-only)</div>
                <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5 }}>
                  Check this if you own homes at a park you don't own — you operate here as an investor.
                  You'll set the lot rent you pay the park on each home; your net is tenant rent minus lot rent.
                  The park owner doesn't need a GAM account.
                </div>
              </div>
            </label>
          </div>
          </>)}

          {/* S605: subleasing shelved — see SUBLEASING_SHELVED in Layout. */}
          {!SUBLEASING_SHELVED && (<>
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
          </>)}

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
              hint={`${achFeeLabel()} per bank debit`}
              value={form.allocationRule.achFeePayer}
              onChange={(v) => setForm(f => ({ ...f, allocationRule: { ...f.allocationRule, achFeePayer: v } }))}
            />
            {/* S513 lock (#2): card is always the tenant's — not selectable. */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: '.74rem', fontWeight: 600, color: 'var(--text-1)', marginBottom: 2 }}>Card processing</div>
              <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginBottom: 6 }}>{cardFeeLabel({ intl: true })} per card charge</div>
              <div style={{ padding: '6px 10px', borderRadius: 8, fontSize: '.74rem', border: '1px solid var(--border-0)', background: 'var(--bg-2)', color: 'var(--text-2)' }}>
                Tenant pays — always (landlords never cover card)
              </div>
            </div>
            {/* S607 (Nic): "we need a toggle for them to cover old-fashioned
                payment costs if they want to... that way the landlord isn't
                surprised." GAM recovers the $10 from the landlord's collections
                either way; this decides only whether the TENANT is invoiced to
                reimburse them. Every tenant's FIRST payment is free regardless. */}
            <FeePayerToggle
              label="Cash, check or money order"
              hint={`No charge, to anyone: ${MANUAL_PAYMENT_FEE_SCOPE}. This setting has no effect while cash is free — it exists so the choice is already recorded if a handling fee ever returns.`}
              value={form.allocationRule.manualFeePayer}
              onChange={(v) => setForm(f => ({ ...f, allocationRule: { ...f.allocationRule, manualFeePayer: v } }))}
            />
            {/* S607 lock (Nic): "the landlord cannot toggle the platform fee
                because when we change for volume discounts or things like that,
                that needs to not affect what the tenants are paying." GAM's
                commercial terms with a landlord must never reach a tenant's
                bill. Shown but not selectable — same treatment as the card lock,
                for the mirror-image reason. */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: '.74rem', fontWeight: 600, color: 'var(--text-1)', marginBottom: 2 }}>Platform SaaS fee</div>
              <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginBottom: 6 }}>$2 per occupied unit per month (min $10/property/mo)</div>
              <div style={{ padding: '6px 10px', borderRadius: 8, fontSize: '.74rem', border: '1px solid var(--border-0)', background: 'var(--bg-2)', color: 'var(--text-2)' }}>
                You pay — always (never passed to tenants)
              </div>
            </div>

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
            {connectBank ? (
              <>
                <div style={{ fontSize: '.82rem', color: 'var(--text-0)', padding: '8px 12px',
                  borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)' }}>
                  {connectBank.bankName || 'Your verified bank'}
                  {connectBank.last4 ? ` •••• ${connectBank.last4}` : ''}
                </div>
                <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 6 }}>
                  The account you verified with Stripe. Rent for this property pays out there on the
                  weekly run — nothing to set up here.{' '}
                  <Link to="/banking" style={{ color: 'var(--gold)', textDecoration: 'underline' }}>
                    Change it
                  </Link>
                </div>
                {activeBankAccounts.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 4 }}>
                      Or send this property&apos;s rent somewhere else
                    </div>
                    <select
                      value={form.allocationRule.ownerBankAccountId ?? ''}
                      onChange={e => setForm(f => ({ ...f, allocationRule: { ...f.allocationRule, ownerBankAccountId: e.target.value || null } }))}
                      style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)', fontSize: '.85rem', boxSizing: 'border-box', color: 'var(--text-0)' }}>
                      <option value="">Use the verified account above</option>
                      {activeBankAccounts.map(b => (
                        <option key={b.id} value={b.id}>
                          {b.nickname} • {b.accountType} •••• {b.accountNumberLast4}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            ) : (
              <>
                <div style={{ fontSize: '.82rem', color: 'var(--text-0)', padding: '8px 12px',
                  borderRadius: 8, border: '1px solid var(--border-0)', background: 'var(--bg-2)' }}>
                  Not set up yet — rent will accumulate until it is
                </div>
                <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 6 }}>
                  Payouts run on the bank you verify with Stripe.{' '}
                  <Link to="/banking" style={{ color: 'var(--gold)', textDecoration: 'underline' }}>
                    Set up payouts
                  </Link>
                </div>
              </>
            )}
          </div>

          {propMut.isError && (
            <div style={{ color: 'var(--red)', fontSize: '.75rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
              Failed to save property. Please try again.
            </div>
          )}

          {/* S481: state-law warning banner after successful save when
              the backend flagged a hedged factual mismatch. The save
              already committed; the modal stays open so the landlord
              can read the notice before closing. */}
          {stateLawWarnings.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <LawWarningBanner warnings={stateLawWarnings} />
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: -4, marginBottom: 8 }}>
                Your changes were saved. The note above is informational —
                no action required.
              </div>
            </div>
          )}

          <div className="modal-footer">
            {stateLawWarnings.length > 0 ? (
              <button className="btn btn-primary" onClick={onClose}>
                <Check size={14} /> Got It
              </button>
            ) : (
              <>
                <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" onClick={submitStep1} disabled={propMut.isLoading}>
                  {propMut.isLoading ? <span className="spinner" /> : <><Check size={14} /> {isEdit ? 'Save Changes' : 'Add Property'}</>}
                </button>
              </>
            )}
          </div>
        </>
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
  const { can } = usePerms()

  // Compute stats per property
  const propStats = (props as any[]).map(p => {
    const propUnits = (units as any[]).filter(u => u.propertyId === p.id)
    const occupied  = propUnits.filter(u => u.tenantId).length
    const vacant    = propUnits.filter(u => !u.tenantId).length
    const monthlyRevenue = propUnits.filter(u => u.tenantId).reduce((s, u) => s + parseFloat(u.rentAmount || 0), 0)
    return { ...p, totalUnits: propUnits.length, occupied, vacant, monthlyRevenue }
  })

  // S553: multi-owner entities — badge each card with its owning entity,
  // but ONLY when the portfolio actually spans more than one (single-
  // entity landlords never see the distinction).
  const multiEntity = new Set(propStats.map(p => p.landlordId)).size > 1

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
          {can('properties.bulk_import') && (
            <button className="btn btn-ghost" onClick={() => navigate('/property-onboarding')}>
              Bulk import CSV
            </button>
          )}
          {can('properties.create') && (
            <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
              <Plus size={15} /> Add Property
            </button>
          )}
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
          <p>Add your first property to start managing units and collecting rent.</p>
          {can('properties.create') && (
            <button className="btn btn-primary" onClick={() => setShowAdd(true)}><Plus size={14} /> Add First Property</button>
          )}
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 10, background: `${typeColor}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Building2 size={18} style={{ color: typeColor }} />
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        {/* Fixed 2-line name area + single-line address → every card's header is
                            the same height, so the icon / metrics / occupancy line up across cards
                            no matter how long the name is (e.g. "Sunset Palms RV Resort"). */}
                        <div style={{ fontSize: '.9rem', fontWeight: 700, color: 'var(--text-0)', lineHeight: 1.25, height: '2.25rem', overflow: 'hidden' }} title={p.name}>{p.name}</div>
                        <div style={{ fontSize: '.7rem', color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 3, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden' }}>
                          <MapPin size={9} style={{ flexShrink: 0 }} /> <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{p.street1}, {p.city}</span>
                        </div>
                        {multiEntity && p.entityName && (
                          <div style={{ fontSize: '.62rem', color: 'var(--gold)', marginTop: 3, fontWeight: 600, letterSpacing: '.02em' }}>
                            {p.entityName}
                          </div>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      {publicSiteUrl(p) && (
                        <a href={publicSiteUrl(p)!} target="_blank" rel="noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="btn btn-ghost btn-sm" style={{ padding: '4px 8px', color: 'var(--gold)' }}
                          title={`Your public website — ${publicSiteUrl(p)}`}>
                          <Globe size={12} />
                        </a>
                      )}
                      {can('properties.edit') && (
                        <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); setEditProp(p) }} style={{ padding: '4px 8px' }}>
                          <Edit2 size={12} />
                        </button>
                      )}
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
                    {can('properties.add_unit') && (
                      <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={e => { e.stopPropagation(); setAddUnitForProp(p) }}>
                        <Plus size={13} /> Add Unit
                      </button>
                    )}
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
  const { user } = useAuth()
  // S321: snake_case reads were silently undefined post-S312 (response
  // interceptor camelizes), so this banner never auto-hid after the
  // landlord finished Stripe Connect onboarding. Reading camelCase
  // now picks up the bridged values correctly.
  //
  // S605 (Nic): it STILL didn't hide. It asked for the USER-level Connect
  // account, but S554 re-anchored owner accounts to the LANDLORD entity — so
  // for an owner this looked up an account that is legitimately NULL and nagged
  // "Bank account setup incomplete" at a landlord whose Stripe verification was
  // complete, charges and payouts enabled. Resolve the same entity BankingPage
  // does.
  const isOwner = user?.role === 'landlord'
  const qs = isOwner ? `entity=landlord&entityId=${user!.profileId}` : 'entity=user'
  const { data } = useQuery<{ payoutsEnabled?: boolean; detailsSubmitted?: boolean; exists?: boolean }>(
    ['stripe-connect-status-banner', isOwner ? 'landlord' : 'user', user?.profileId],
    () => apiGet(`/stripe/connect/status?${qs}`),
    { enabled: !!user },
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
            Bank account setup incomplete
          </div>
          <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginTop: 4 }}>
            Properties can still be added now, but tenants won&apos;t be able to pay rent through GAM until you finish linking your bank account.
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); navigate('/banking') }}>
          Open Banking →
        </button>
      </div>
    </div>
  )
}
