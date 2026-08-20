import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Plus, Trash2, Link2 } from 'lucide-react'
import { apiGet, apiPost, apiPut, apiDelete } from '../lib/api'
import {
  UNIT_TYPES, UnitType, UNIT_TYPE_LABEL, UNIT_TYPE_ICON, UNIT_TYPE_HAS_BEDROOMS,
  PropertyUnitSubtype, unitSubtypeFactsLabel, suggestUnitSubtypeName,
} from '@gam/shared'
import { appConfirm, toast } from '../components/dialogs'

// S527 (Nic): OWNER-DEFINED subtypes — replaces the S526 pre-baked
// bed-count / RV-combo pricing grid. A subtype is the owner's own named
// class of unit ("Studio", "Riverfront pull-through", "10x10"): name +
// the facts that matter for its type + pricing. BLANK until the owner
// adds them — a studio-only landlord never sees bedroom menus. Add Unit
// picks a subtype and prefills everything. Fees are NOT set here — each
// tenant is charged per their own signed lease.

const fmt = (n: any) => {
  if (n == null || n === '') return '—'
  const v = typeof n === 'string' ? parseFloat(n) : n
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function UnitSubtypesSection({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<PropertyUnitSubtype | 'new' | null>(null)
  const [assigning, setAssigning] = useState<PropertyUnitSubtype | null>(null)

  const { data = [], isLoading } = useQuery<PropertyUnitSubtype[]>(
    ['property-unit-subtypes', propertyId],
    () => apiGet(`/properties/${propertyId}/unit-subtypes`),
  )
  const rows = data as PropertyUnitSubtype[]

  // S604 (Nic): "adding unit subtypes should be prepopulated with stuff if stuff
  // was selected at unit onboarding... all this stuff is double inputting."
  // A landlord who just bulk-added 20 back-in / 30-amp / tenant-owned RV spots
  // opened this form and found it defaulted to APARTMENT with everything blank.
  // Derive the defaults from the units that already exist on the property —
  // the most common unit_type, and the dominant layout/amp/ownership within it.
  const { data: allUnits = [] } = useQuery<any[]>('units', () => apiGet('/units'))
  const seedFromUnits = (() => {
    const mine = (allUnits as any[]).filter(u => u.propertyId === propertyId)
    if (mine.length === 0) return null
    const mode = <T,>(vals: T[]): T | null => {
      const counts = new Map<T, number>()
      for (const v of vals) if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1)
      let best: T | null = null, n = 0
      for (const [v, c] of counts) if (c > n) { best = v; n = c }
      return best
    }
    const unitType = mode(mine.map(u => u.unitType))
    if (!unitType) return null
    const ofType = mine.filter(u => u.unitType === unitType)
    // Rates: use the most common non-null value across units of this type.
    // Nic: "subtypes don't fill in rates that were already set" — the physical
    // attributes were seeded but the money fields were left blank, which is the
    // half the landlord actually had to retype.
    const numMode = (vals: any[]): string => {
      const nums = vals.map(v => v == null || v === '' ? null : Number(v))
                       .filter(v => v != null && !Number.isNaN(v) && v > 0)
      const m = mode(nums as number[])
      return m == null ? '' : String(m)
    }
    return {
      unitType,
      rvSiteLayout:      mode(ofType.map(u => u.rvSiteLayout)) ?? 'none',
      rvAmpService:      mode(ofType.map(u => u.rvAmpService)) ?? 'none',
      dwellingOwnership: mode(ofType.map(u => u.dwellingOwnership)) ?? 'tenant',
      bedrooms:          numMode(ofType.map(u => u.bedrooms)),
      bathrooms:         numMode(ofType.map(u => u.bathrooms)),
      storageSize:       mode(ofType.map(u => u.storageSize)) ?? '',
      rentAmount:        numMode(ofType.map(u => u.rentAmount)),
      securityDeposit:   numMode(ofType.map(u => u.securityDeposit)),
      nightlyRate:       numMode(ofType.map(u => u.nightlyRate)),
      weeklyRate:        numMode(ofType.map(u => u.weeklyRate)),
      monthlyRate:       numMode(ofType.map(u => u.monthlyRate)),
    }
  })()

  const done = () => {
    setEditing(null)
    setError(null)
    qc.invalidateQueries(['property-unit-subtypes', propertyId])
  }

  const deleteMut = useMutation(
    (id: string) => apiDelete(`/properties/${propertyId}/unit-subtypes/${id}`),
    { onSuccess: done, onError: (e: any) => setError(e?.response?.data?.error || 'Delete failed') },
  )

  return (
    <div className="card" style={{ padding: 0, marginTop: 24 }}>
      <div style={{ padding: 16, borderBottom: '1px solid var(--border-0)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.05rem', color: 'var(--text-0)' }}>Unit Subtypes</h2>
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
            Your own named unit classes — "Studio", "Pull-through 50 amp", "10x10". Adding a unit
            picks a subtype and prefills its details and pricing. Fees are not set here: each tenant
            is charged per their signed lease.
          </div>
        </div>
        {editing === null && (
          <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
            <Plus size={13} /> Add subtype
          </button>
        )}
      </div>

      {error && (
        <div style={{ padding: 12, background: 'rgba(239,68,68,.06)', borderBottom: '1px solid rgba(239,68,68,.2)', color: 'var(--red)', fontSize: '.85rem' }}>{error}</div>
      )}

      {isLoading ? (
        <div style={{ padding: 24, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
      ) : rows.length === 0 && editing === null ? (
        <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-3)', fontSize: '.8rem' }}>
          No subtypes yet. Add the kinds of units this property actually has — only what you create
          will show up when adding units.
        </div>
      ) : (
        rows.map(s => (
          editing !== null && editing !== 'new' && editing.id === s.id ? (
            <SubtypeEditor key={s.id} propertyId={propertyId} initial={s} existing={rows} onDone={done} onCancel={() => setEditing(null)} onError={setError} />
          ) : (
            <div key={s.id} style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--border-0)' }}>
              <span>{UNIT_TYPE_ICON[s.unitType]}</span>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: '.84rem', fontWeight: 600, color: 'var(--text-0)' }}>{s.name}</span>
                <span style={{ fontSize: '.72rem', color: 'var(--text-3)', marginLeft: 10 }}>
                  {[
                    UNIT_TYPE_LABEL[s.unitType],
                    unitSubtypeFactsLabel(s) || null,
                    s.rentAmount != null ? `Rent ${fmt(s.rentAmount)}` : null,
                    s.securityDeposit != null ? `Deposit ${fmt(s.securityDeposit)}` : null,
                    s.nightlyRate != null ? `Nightly ${fmt(s.nightlyRate)}` : null,
                    s.weeklyRate != null ? `Weekly ${fmt(s.weeklyRate)}` : null,
                    s.monthlyRate != null ? `Monthly ${fmt(s.monthlyRate)}` : null,
                  ].filter(Boolean).join(' · ')}
                </span>
              </div>
              {/* S613 (Nic): "I wanna figure out how to link subtypes to
                  different units because there's nowhere that I can see that
                  links those." The count IS the link — it says whether this
                  subtype describes anything, and opens the list of which. */}
              <span style={{ fontSize: '.72rem', color: s.unitCount ? 'var(--text-2)' : 'var(--text-3)' }}>
                {s.unitCount === 1 ? '1 unit' : `${s.unitCount ?? 0} units`}
              </span>
              {editing === null && (
                <>
                  <button className="btn btn-secondary btn-sm" onClick={() => setAssigning(s)}>
                    <Link2 size={12} /> Units
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={() => setEditing(s)}>Edit</button>
                  <button
                    className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} title="Remove"
                    onClick={() => { appConfirm(`Remove the "${s.name}" subtype? Existing units keep their details.`, { danger: true, confirmLabel: 'Remove' }).then(ok => { if (ok) deleteMut.mutate(s.id!) }) }}
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )}
            </div>
          )
        ))
      )}

      {assigning && (
        <SubtypeUnitsModal propertyId={propertyId} subtype={assigning}
          onClose={() => setAssigning(null)}
          onSaved={() => { setAssigning(null); qc.invalidateQueries(['property-unit-subtypes', propertyId]); qc.invalidateQueries('units') }} />
      )}

      {editing === 'new' && (
        <SubtypeEditor propertyId={propertyId} initial={null} seed={seedFromUnits} existing={rows}
          onDone={done} onCancel={() => setEditing(null)} onError={setError} />
      )}
    </div>
  )
}

function SubtypeEditor({ propertyId, initial, seed, existing = [], onDone, onCancel, onError }: {
  seed?: any
  propertyId: string
  initial: PropertyUnitSubtype | null
  /** The property's other subtypes — used to catch a name collision before it
   *  reaches the server, so the landlord is told in the form he is looking at. */
  existing?: PropertyUnitSubtype[]
  onDone: () => void
  onCancel: () => void
  onError: (m: string | null) => void
}) {
  const [f, setF] = useState({
    unitType:     (initial?.unitType ?? seed?.unitType ?? 'apartment') as UnitType,
    name:         initial?.name ?? '',
    bedrooms:     initial?.bedrooms != null ? String(initial.bedrooms) : (seed?.bedrooms ?? ''),
    bathrooms:    initial?.bathrooms != null ? String(initial.bathrooms) : (seed?.bathrooms ?? ''),
    rvSiteLayout: initial?.rvSiteLayout ?? seed?.rvSiteLayout ?? 'none',
    rvAmpService: initial?.rvAmpService ?? seed?.rvAmpService ?? 'none',
    dwellingOwnership: initial?.dwellingOwnership ?? seed?.dwellingOwnership ?? 'tenant',
    storageSize:  initial?.storageSize ?? seed?.storageSize ?? '',
    rentAmount:      initial?.rentAmount?.toString() ?? seed?.rentAmount ?? '',
    securityDeposit: initial?.securityDeposit?.toString() ?? seed?.securityDeposit ?? '',
    nightlyRate:     initial?.nightlyRate?.toString() ?? seed?.nightlyRate ?? '',
    weeklyRate:      initial?.weeklyRate?.toString() ?? seed?.weeklyRate ?? '',
    monthlyRate:     initial?.monthlyRate?.toString() ?? seed?.monthlyRate ?? '',
  })
  // S613 (Nic, data loss): he named two RV subtypes "Back In" and let the amp
  // dropdown carry the difference — the second overwrote the first. The name is
  // what a person picks from when adding a unit, so two subtypes need two
  // names. Rather than only refusing the collision, the form now WRITES the
  // name from the facts as they are picked ("Back-in 50 amp"), until the
  // landlord types over it — after which it never fights him for the field.
  const [nameTouched, setNameTouched] = useState(!!initial?.name)
  const set = (k: string, v: any) => setF(x => {
    const next = { ...x, [k]: v }
    if (!nameTouched && k !== 'name') {
      const suggestion = suggestUnitSubtypeName({
        unitType: next.unitType, name: '',
        bedrooms: next.bedrooms === '' ? null : Number(next.bedrooms),
        bathrooms: next.bathrooms === '' ? null : next.bathrooms,
        rvSiteLayout: next.unitType === 'rv_spot' ? next.rvSiteLayout : null,
        rvAmpService: next.unitType === 'rv_spot' ? next.rvAmpService : null,
        storageSize: next.unitType === 'storage' ? next.storageSize : null,
        rentAmount: null, securityDeposit: null, nightlyRate: null, weeklyRate: null, monthlyRate: null,
      })
      if (suggestion) next.name = suggestion
    }
    return next
  })
  const isRv = f.unitType === 'rv_spot'
  const hasBeds = UNIT_TYPE_HAS_BEDROOMS[f.unitType]
  // S550: ownership is a subtype fact for RV/MH — "MH Lot" (tenant-owned)
  // vs "Park Model Rental" (park-owned). Tenant-owned is the norm/default.
  const ownershipRelevant = isRv || f.unitType === 'mobile_home'
  const num = (s: string) => s.trim() === '' ? null : parseFloat(s)

  // Same rule the server enforces: one name per unit type on a property.
  const dupe = existing.find(x =>
    x.id !== initial?.id &&
    x.unitType === f.unitType &&
    x.name.trim().toLowerCase() === f.name.trim().toLowerCase())

  const saveMut = useMutation(
    () => apiPost(`/properties/${propertyId}/unit-subtypes`, {
      ...(initial?.id ? { id: initial.id } : {}),
      unitType: f.unitType,
      name: f.name.trim(),
      bedrooms: hasBeds && f.bedrooms !== '' ? parseInt(f.bedrooms) : null,
      bathrooms: hasBeds ? num(f.bathrooms) : null,
      rvSiteLayout: isRv ? f.rvSiteLayout : null,
      rvAmpService: isRv ? f.rvAmpService : null,
      dwellingOwnership: ownershipRelevant ? f.dwellingOwnership : null,
      storageSize: f.unitType === 'storage' ? (f.storageSize.trim() || null) : null,
      rentAmount: num(f.rentAmount), securityDeposit: num(f.securityDeposit),
      nightlyRate: isRv ? num(f.nightlyRate) : null,
      weeklyRate: isRv ? num(f.weeklyRate) : null,
      monthlyRate: isRv ? num(f.monthlyRate) : null,
    }),
    { onSuccess: () => { onError(null); onDone() }, onError: (e: any) => onError(e?.response?.data?.error || 'Save failed') },
  )

  const lbl = { fontSize: '.68rem', color: 'var(--text-3)', marginBottom: 3 } as const

  return (
    <div style={{ padding: 12, background: 'var(--bg-1)', borderBottom: '1px solid var(--border-0)' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
        <div>
          <div style={lbl}>Unit type</div>
          <select className="input" value={f.unitType} onChange={e => set('unitType', e.target.value)} style={{ minWidth: 150 }}>
            {UNIT_TYPES.map(t => <option key={t} value={t}>{UNIT_TYPE_LABEL[t]}</option>)}
          </select>
        </div>
        <div style={{ flex: '1 1 180px' }}>
          <div style={lbl}>Subtype name</div>
          <input className="input" placeholder={isRv ? 'e.g. Riverfront pull-through' : hasBeds ? 'e.g. Studio, 2BR Deluxe' : f.unitType === 'storage' ? 'e.g. 10x10' : 'e.g. Corner suite'}
            value={f.name}
            onChange={e => { setNameTouched(true); setF(x => ({ ...x, name: e.target.value })) }}
            style={{ width: '100%', ...(dupe ? { borderColor: 'var(--red)' } : {}) }} />
        </div>
        {hasBeds && (
          <>
            <div>
              <div style={lbl}>Bedrooms (0 = studio)</div>
              <input className="input" type="number" min={0} max={30} value={f.bedrooms} placeholder="—" onChange={e => set('bedrooms', e.target.value)} style={{ width: 90 }} />
            </div>
            <div>
              <div style={lbl}>Bathrooms</div>
              <input className="input" type="number" min={0} step={0.5} value={f.bathrooms} placeholder="—" onChange={e => set('bathrooms', e.target.value)} style={{ width: 90 }} />
            </div>
          </>
        )}
        {isRv && (
          <>
            <div>
              <div style={lbl}>Site layout</div>
              <select className="input" value={f.rvSiteLayout || 'none'} onChange={e => set('rvSiteLayout', e.target.value)}>
                <option value="none">Not specified</option>
                <option value="back_in">Back-in</option>
                <option value="pull_through">Pull-through</option>
              </select>
            </div>
            <div>
              <div style={lbl}>Electrical</div>
              <select className="input" value={f.rvAmpService || 'none'} onChange={e => set('rvAmpService', e.target.value)}>
                <option value="none">Not specified</option>
                <option value="30">30 amp</option>
                <option value="50">50 amp</option>
                <option value="both">30/50 amp</option>
              </select>
            </div>
          </>
        )}
        {ownershipRelevant && (
          <div>
            <div style={lbl}>{isRv ? 'Who owns the RV?' : 'Who owns the home?'}</div>
            <select className="input" value={f.dwellingOwnership} onChange={e => set('dwellingOwnership', e.target.value)}>
              <option value="tenant">Tenant-owned (space rent)</option>
              <option value="landlord">Park-owned rental</option>
            </select>
          </div>
        )}
        {f.unitType === 'storage' && (
          <div>
            <div style={lbl}>Size</div>
            <input className="input" placeholder="e.g. 10x10" value={f.storageSize} onChange={e => set('storageSize', e.target.value)} style={{ width: 110 }} />
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <PriceInput label="Monthly rent" value={f.rentAmount} onChange={v => set('rentAmount', v)} />
        <PriceInput label="Deposit" value={f.securityDeposit} onChange={v => set('securityDeposit', v)} />
        {isRv && <PriceInput label="Nightly" value={f.nightlyRate} onChange={v => set('nightlyRate', v)} />}
        {isRv && <PriceInput label="Weekly" value={f.weeklyRate} onChange={v => set('weeklyRate', v)} />}
        {isRv && <PriceInput label="Monthly (stay)" value={f.monthlyRate} onChange={v => set('monthlyRate', v)} />}
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="btn btn-primary btn-sm" onClick={() => saveMut.mutate()} disabled={saveMut.isLoading || !f.name.trim() || !!dupe}>
            {saveMut.isLoading ? 'Saving…' : 'Save'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        </div>
      </div>

      {dupe && (
        <div style={{ marginTop: 8, fontSize: '.74rem', color: 'var(--red)', lineHeight: 1.5 }}>
          You already have a <strong>{UNIT_TYPE_LABEL[f.unitType]}</strong> subtype called
          &nbsp;<strong>{dupe.name}</strong>{unitSubtypeFactsLabel(dupe) ? ` (${unitSubtypeFactsLabel(dupe)})` : ''}.
          Give this one its own name — a 50 amp back-in and a 30 amp back-in are two subtypes,
          not one — or close this and edit that subtype instead.
        </div>
      )}
    </div>
  )
}

// S613 (Nic): "there's nowhere that I can see that links those."
//
// A subtype has been able to describe units since S527, but only at the moment
// a unit was created — define "Back-in 50 amp" afterwards and no existing space
// could ever be told it was one. This is that screen: tick the spaces, save.
//
// Two deliberate rules, both visible on the panel rather than buried:
//   · only units of this subtype's OWN type are listed — an apartment subtype
//     has nothing to say about an RV site;
//   · applying the details is a separate tick, OFF by default. Linking is
//     classification and changes nothing; applying rewrites the units. Rent and
//     deposit still never move on a leased unit — that is the signed lease.
function SubtypeUnitsModal({ propertyId, subtype, onClose, onSaved }: {
  propertyId: string
  subtype: PropertyUnitSubtype
  onClose: () => void
  onSaved: () => void
}) {
  const { data: units = [], isLoading } = useQuery<any[]>(
    ['subtype-units', subtype.id],
    () => apiGet(`/properties/${propertyId}/unit-subtypes/${subtype.id}/units`),
  )
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [applyDetails, setApplyDetails] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const current = picked ?? new Set((units as any[]).filter(u => u.subtypeId === subtype.id).map(u => u.id))
  const toggle = (id: string) => {
    const next = new Set(current)
    next.has(id) ? next.delete(id) : next.add(id)
    setPicked(next)
  }

  const saveMut = useMutation(
    () => apiPut(`/properties/${propertyId}/unit-subtypes/${subtype.id}/units`,
      { unitIds: Array.from(current), applyDetails }),
    {
      onSuccess: (res: any) => {
        const held: string[] = res?.pricingHeldBack ?? []
        if (held.length) {
          toast(
            `Saved. Rent and deposit were left alone on ${held.length === 1 ? 'unit' : 'units'} ` +
            `${held.join(', ')} — ${held.length === 1 ? 'it has' : 'they have'} an active lease.`)
        }
        onSaved()
      },
      onError: (e: any) => setErr(e?.response?.data?.error || 'Could not save that'),
    },
  )

  const facts = unitSubtypeFactsLabel(subtype)
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
      <div className="modal-title">Units on “{subtype.name}”</div>
      <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.5 }}>
        Tick every {UNIT_TYPE_LABEL[subtype.unitType].toLowerCase()} that is a{' '}
        <strong style={{ color: 'var(--text-1)' }}>{subtype.name}</strong>
        {facts ? ` (${facts})` : ''}. Unticking one leaves the unit exactly as it is — it just
        stops being counted as this subtype.
      </div>

      {err && (
        <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 7, fontSize: '.76rem',
                      color: 'var(--red)', background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.25)' }}>{err}</div>
      )}

      {isLoading ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-3)', fontSize: '.8rem' }}>Loading…</div>
      ) : (units as any[]).length === 0 ? (
        <div style={{ padding: '20px 4px', color: 'var(--text-3)', fontSize: '.8rem', lineHeight: 1.5 }}>
          This property has no {UNIT_TYPE_LABEL[subtype.unitType].toLowerCase()} units yet, so there is
          nothing to link. Add units first — the Add Unit form will offer this subtype and fill
          everything in.
        </div>
      ) : (
        <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border-0)', borderRadius: 8 }}>
          {(units as any[]).map(u => {
            const on = current.has(u.id)
            // A unit already on a DIFFERENT subtype is worth saying — ticking it
            // moves it, and moving it silently is how the last one got lost.
            const elsewhere = u.subtypeId && u.subtypeId !== subtype.id ? u.currentSubtypeName : null
            return (
              <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                                          borderBottom: '1px solid var(--border-0)', cursor: 'pointer', fontSize: '.82rem' }}>
                <input type="checkbox" checked={on} onChange={() => toggle(u.id)} />
                <span style={{ fontWeight: 600, minWidth: 70 }}>{u.unitNumber}</span>
                {u.leased && <span className="badge badge-green" style={{ fontSize: '.62rem' }}>Leased</span>}
                {elsewhere && (
                  <span style={{ fontSize: '.7rem', color: 'var(--text-3)', marginLeft: 'auto' }}>
                    currently “{elsewhere}”
                  </span>
                )}
              </label>
            )
          })}
        </div>
      )}

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, cursor: 'pointer' }}>
        <input type="checkbox" checked={applyDetails} onChange={e => setApplyDetails(e.target.checked)} style={{ marginTop: 3 }} />
        <span style={{ fontSize: '.76rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
          Also copy this subtype's details onto those units{facts ? ` (${facts})` : ''}
          {subtype.rentAmount != null ? ` and its rent` : ''}.
          <span style={{ display: 'block', color: 'var(--text-3)', fontSize: '.72rem' }}>
            Leave this off to only label the units. Rent and deposit are never changed on a unit with
            an active lease — that is committed to the signed lease.
          </span>
        </span>
      </label>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-sm" disabled={saveMut.isLoading || isLoading}
          onClick={() => { setErr(null); saveMut.mutate() }}>
          {saveMut.isLoading ? 'Saving…' : 'Save'}
        </button>
      </div>
      </div>
    </div>
  )
}

function PriceInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginBottom: 3 }}>{label}</div>
      <input
        type="number"
        min="0"
        step="0.01"
        className="input"
        value={value}
        placeholder="—"
        onChange={e => onChange(e.target.value)}
        style={{ width: 110, textAlign: 'right' }}
      />
    </div>
  )
}
