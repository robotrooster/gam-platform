import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Plus, Trash2 } from 'lucide-react'
import { apiGet, apiPost, apiDelete } from '../lib/api'
import {
  UNIT_TYPES, UnitType, UNIT_TYPE_LABEL, UNIT_TYPE_ICON, UNIT_TYPE_HAS_BEDROOMS,
  PropertyUnitSubtype, unitSubtypeFactsLabel,
} from '@gam/shared'
import { appConfirm } from '../components/dialogs'

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

  const { data = [], isLoading } = useQuery<PropertyUnitSubtype[]>(
    ['property-unit-subtypes', propertyId],
    () => apiGet(`/properties/${propertyId}/unit-subtypes`),
  )
  const rows = data as PropertyUnitSubtype[]

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
            <SubtypeEditor key={s.id} propertyId={propertyId} initial={s} onDone={done} onCancel={() => setEditing(null)} onError={setError} />
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
              {editing === null && (
                <>
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

      {editing === 'new' && (
        <SubtypeEditor propertyId={propertyId} initial={null} onDone={done} onCancel={() => setEditing(null)} onError={setError} />
      )}
    </div>
  )
}

function SubtypeEditor({ propertyId, initial, onDone, onCancel, onError }: {
  propertyId: string
  initial: PropertyUnitSubtype | null
  onDone: () => void
  onCancel: () => void
  onError: (m: string | null) => void
}) {
  const [f, setF] = useState({
    unitType:     (initial?.unitType ?? 'apartment') as UnitType,
    name:         initial?.name ?? '',
    bedrooms:     initial?.bedrooms != null ? String(initial.bedrooms) : '',
    bathrooms:    initial?.bathrooms != null ? String(initial.bathrooms) : '',
    rvSiteLayout: initial?.rvSiteLayout ?? 'none',
    rvAmpService: initial?.rvAmpService ?? 'none',
    dwellingOwnership: initial?.dwellingOwnership ?? 'tenant',
    storageSize:  initial?.storageSize ?? '',
    rentAmount:      initial?.rentAmount?.toString() ?? '',
    securityDeposit: initial?.securityDeposit?.toString() ?? '',
    nightlyRate:     initial?.nightlyRate?.toString() ?? '',
    weeklyRate:      initial?.weeklyRate?.toString() ?? '',
    monthlyRate:     initial?.monthlyRate?.toString() ?? '',
  })
  const set = (k: string, v: any) => setF(x => ({ ...x, [k]: v }))
  const isRv = f.unitType === 'rv_spot'
  const hasBeds = UNIT_TYPE_HAS_BEDROOMS[f.unitType]
  // S550: ownership is a subtype fact for RV/MH — "MH Lot" (tenant-owned)
  // vs "Park Model Rental" (park-owned). Tenant-owned is the norm/default.
  const ownershipRelevant = isRv || f.unitType === 'mobile_home'
  const num = (s: string) => s.trim() === '' ? null : parseFloat(s)

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
          <input className="input" placeholder={isRv ? 'e.g. Riverfront pull-through' : hasBeds ? 'e.g. Studio, 2BR Deluxe' : f.unitType === 'storage' ? 'e.g. 10x10' : 'e.g. Corner suite'} value={f.name} onChange={e => set('name', e.target.value)} style={{ width: '100%' }} />
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
          <button className="btn btn-primary btn-sm" onClick={() => saveMut.mutate()} disabled={saveMut.isLoading || !f.name.trim()}>
            {saveMut.isLoading ? 'Saving…' : 'Save'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
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
