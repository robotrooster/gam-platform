import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { AlertTriangle, Clock, Trash2 } from 'lucide-react'
import { apiDelete, apiGet, apiPatch, apiPut } from '../lib/api'

const UNIT_TYPE_LABELS: Record<string, string> = {
  apartment: 'Apartment', single_family: 'Single family', rv_spot: 'RV spot',
  mobile_home: 'Mobile home', storage: 'Storage', commercial: 'Commercial',
}

// S535 (Nic): late fees are locked to (property, UNIT TYPE) — there is
// deliberately NO property-wide default, because a default silently
// applied to a unit class it wasn't vetted for is how an illegal charge
// happens. Each unit type the landlord charges late fees on gets its
// own row; classes with no row have NO late fee. Document creation
// stamps the row (locked) into every lease drafted for that class, so
// every tenant of a class has identical terms (fair-housing). Existing
// signed leases keep the terms they signed (lease-is-law).
//
// The grace popup states the exact day the fee starts under the billing
// engine's rule: fee fires once the property-local date reaches
// due_date + grace_days (due the 1st + 3-day grace → fee starts the 4th).

const ord = (n: number) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th')
const lbl = { fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 4, display: 'block' } as const

export function PropertyLateFeeSection({ property, onSaved }: { property: any; onSaved: () => void }) {
  const qc = useQueryClient()
  const [enabled, setEnabled] = useState(!!property?.lateFeeEnabled)
  useEffect(() => { setEnabled(!!property?.lateFeeEnabled) }, [property?.id])

  const toggleMut = useMutation(
    (on: boolean) => apiPatch(`/properties/${property.id}`, { lateFeeEnabled: on }),
    { onSuccess: () => { qc.invalidateQueries('properties'); onSaved() },
      onError: (e: any) => { setEnabled(!!property?.lateFeeEnabled); alert(e?.response?.data?.error || 'Could not save') } }
  )

  return (
    <div className="card" style={{ padding: 14, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Clock size={15} style={{ color: 'var(--gold)' }} />
        <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>Late Fee Policy</h2>
      </div>
      <div style={{ fontSize: '.75rem', color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 12 }}>
        Late fees are set per <strong>unit type</strong> — never per lease, and there is no
        property-wide default (a blanket fee can be unlawful for a unit class it wasn&apos;t written
        for). A unit type without a row here has <strong>no late fee</strong>. Every lease drafted
        for a class carries its row exactly, so all tenants of that class have identical terms;
        signed leases keep the terms they signed.
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.82rem', cursor: 'pointer', marginBottom: enabled ? 12 : 0 }}>
        <input type="checkbox" checked={enabled} disabled={toggleMut.isLoading}
          onChange={e => { setEnabled(e.target.checked); toggleMut.mutate(e.target.checked) }} />
        Charge late fees at this property
      </label>

      {enabled && <UnitTypeRows propertyId={property.id} />}
    </div>
  )
}

// Per-unit-type rows: list + upsert + remove. The ONLY late-fee config.
function UnitTypeRows({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient()
  const { data: rows = [] } = useQuery<any[]>(
    ['late-fee-overrides', propertyId],
    () => apiGet(`/properties/${propertyId}/late-fee-overrides`),
    { enabled: !!propertyId })
  const [unitType, setUnitType] = useState('')
  const [amount, setAmount] = useState('')
  const [kind, setKind] = useState('flat')
  const [grace, setGrace] = useState('5')
  const [showGraceInfo, setShowGraceInfo] = useState(false)

  const upsertMut = useMutation(
    () => apiPut(`/properties/${propertyId}/late-fee-overrides`, {
      unitType, graceDays: Math.trunc(Number(grace) || 0), initialAmount: Number(amount), initialType: kind,
    }),
    { onSuccess: () => { qc.invalidateQueries(['late-fee-overrides', propertyId]); setUnitType(''); setAmount(''); setShowGraceInfo(false) },
      onError: (e: any) => alert(e?.response?.data?.error || 'Could not save the late fee') }
  )
  const removeMut = useMutation(
    (ut: string) => apiDelete(`/properties/${propertyId}/late-fee-overrides/${ut}`),
    { onSuccess: () => qc.invalidateQueries(['late-fee-overrides', propertyId]),
      onError: (e: any) => alert(e?.response?.data?.error || 'Could not remove the late fee') }
  )

  const g = Math.max(0, Math.trunc(Number(grace) || 0))

  return (
    <div>
      {(rows as any[]).length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {(rows as any[]).map((o: any) => (
            <div key={o.unitType} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: 'var(--bg-2)', borderRadius: 8, fontSize: '.8rem' }}>
              <span style={{ fontWeight: 600, flex: '0 0 110px' }}>{UNIT_TYPE_LABELS[o.unitType] || o.unitType}</span>
              <span className="mono">
                {o.lateFeeInitialType === 'percent_of_rent'
                  ? `${Number(o.lateFeeInitialAmount)}% of rent`
                  : `$${Number(o.lateFeeInitialAmount).toFixed(2)}`}
              </span>
              <span style={{ color: 'var(--text-3)', fontSize: '.74rem' }}>
                {o.lateFeeGraceDays}-day grace · fee starts day {1 + Number(o.lateFeeGraceDays)} when rent is due the 1st
              </span>
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', padding: '2px 8px' }}
                title="Remove — this unit type will have NO late fee"
                onClick={() => removeMut.mutate(o.unitType)}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: '.76rem', color: 'var(--amber, #d97706)', marginBottom: 12 }}>
          No unit types configured — no lease drafted at this property will carry a late fee until you add one.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <span style={lbl}>Unit type</span>
          <select className="form-select" value={unitType} onChange={e => setUnitType(e.target.value)} style={{ width: 140 }}>
            <option value="" disabled>Select…</option>
            {Object.entries(UNIT_TYPE_LABELS)
              .filter(([t]) => !(rows as any[]).some((o: any) => o.unitType === t))
              .map(([t, label]) => <option key={t} value={t}>{label}</option>)}
          </select>
        </div>
        <div>
          <span style={lbl}>Fee</span>
          <input className="form-input mono" type="text" inputMode="decimal" value={amount}
            onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setAmount(v) }}
            placeholder="25" style={{ width: 80 }} />
        </div>
        <div>
          <span style={lbl}>Type</span>
          <select className="form-select" value={kind} onChange={e => setKind(e.target.value)} style={{ width: 120 }}>
            <option value="flat">Flat $</option>
            <option value="percent_of_rent">% of rent</option>
          </select>
        </div>
        <div>
          <span style={lbl}>Grace (days)</span>
          <input className="form-input mono" type="text" inputMode="numeric" value={grace}
            onFocus={() => setShowGraceInfo(true)}
            onChange={e => { const v = e.target.value; if (v === '' || /^\d+$/.test(v)) setGrace(v) }}
            style={{ width: 70 }} />
        </div>
        <button className="btn btn-primary btn-sm" disabled={!unitType || amount === '' || upsertMut.isLoading}
          onClick={() => upsertMut.mutate()}>
          {upsertMut.isLoading ? 'Saving…' : 'Add Late Fee'}
        </button>
      </div>

      {/* S535 (Nic): the grace popup — the landlord sees exactly which day
          the fee starts under what they picked. Engine rule: fee fires
          when the local date reaches due date + grace days. */}
      {showGraceInfo && (
        <div style={{ marginTop: 12, background: 'rgba(245,158,11,.08)', border: '1px solid var(--amber, #d97706)', borderRadius: 8, padding: '10px 12px', fontSize: '.78rem', color: 'var(--text-1)', lineHeight: 1.55, display: 'flex', gap: 8 }}>
          <AlertTriangle size={14} style={{ color: 'var(--amber, #d97706)', flexShrink: 0, marginTop: 2 }} />
          <div>
            With a <strong>{g}-day</strong> grace period, a tenant whose rent is due on the <strong>1st</strong> can
            pay through the <strong>{ord(Math.max(1, g))}</strong> without a fee — the late fee starts on
            the <strong>{ord(1 + g)}</strong> of each month. (In general: the fee starts on the due day
            + {g}; a lease due on the 5th starts accruing on the {ord(5 + g)}.)
          </div>
        </div>
      )}
    </div>
  )
}
