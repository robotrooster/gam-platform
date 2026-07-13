import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { AlertTriangle, Clock, Trash2, Ban } from 'lucide-react'
import { apiDelete, apiGet, apiPatch, apiPut } from '../lib/api'
import { UNIT_TYPE_LABEL, humanize } from '@gam/shared'

const UNIT_TYPE_LABELS: Record<string, string> = UNIT_TYPE_LABEL

// S535 (Nic): late fees are locked to (property, UNIT TYPE) — there is
// deliberately NO property-wide default, because a default silently
// applied to a unit class it wasn't vetted for is how an illegal charge
// happens. Document creation stamps the row (locked) into every lease
// drafted for that class, so every tenant of a class has identical terms
// (fair-housing). Existing signed leases keep the terms they signed
// (lease-is-law).
//
// S537 (Nic): a row is an explicit DECISION — fee terms, or "no late fee
// for this class". A unit type with NO row is UNDECIDED, and undecided
// classes are gated platform-wide: units can't be added and tenants can't
// be onboarded until the landlord decides here. Removing a decision is
// only possible while no units of the class exist; otherwise change it.
// Billing enforces the decision as a ceiling: no lease — imported or not —
// ever bills more late fee than the current class policy allows.
//
// The grace popup states the exact day the fee starts under the billing
// engine's rule: fee fires once the property-local date reaches
// due_date + grace_days (due the 1st + 3-day grace → fee starts the 4th).

const ord = (n: number) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th')
const lbl = { fontSize: '.72rem', color: 'var(--text-3)', marginBottom: 4, display: 'block' } as const

export function PropertyLateFeeSection({ property, onSaved }: { property: any; onSaved: () => void }) {
  const qc = useQueryClient()
  const [enabled, setEnabled] = useState(!!property?.lateFeeEnabled)
  const [toggleError, setToggleError] = useState<string | null>(null)
  useEffect(() => { setEnabled(!!property?.lateFeeEnabled) }, [property?.id])

  const toggleMut = useMutation(
    (on: boolean) => apiPatch(`/properties/${property.id}`, { lateFeeEnabled: on }),
    { onSuccess: () => { setToggleError(null); qc.invalidateQueries('properties'); onSaved() },
      onError: (e: any) => { setEnabled(!!property?.lateFeeEnabled); setToggleError(e?.response?.data?.error || 'Could not save') } }
  )

  return (
    <div className="card" style={{ padding: 14, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Clock size={15} style={{ color: 'var(--gold)' }} />
        <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>Late Fee Policy</h2>
      </div>
      <div style={{ fontSize: '.75rem', color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 12 }}>
        Late fees are decided per <strong>unit type</strong> — never per lease, and there is no
        property-wide default (a blanket fee can be unlawful for a unit class it wasn&apos;t written
        for). Every unit type needs an explicit decision: fee terms, or <strong>no late fee</strong>.
        Until a type is decided, units of that type can&apos;t be added and tenants can&apos;t be
        onboarded to them. Every lease drafted for a class carries its decision exactly, so all
        tenants of that class have identical terms; signed leases keep the terms they signed, but
        are never billed more than the current decision allows.
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.82rem', cursor: 'pointer', marginBottom: enabled ? 12 : 0 }}>
        <input type="checkbox" checked={enabled} disabled={toggleMut.isLoading}
          onChange={e => { setEnabled(e.target.checked); toggleMut.mutate(e.target.checked) }} />
        Charge late fees at this property
      </label>
      {toggleError && (
        <div style={{ fontSize: '.76rem', color: 'var(--red, #dc2626)', marginBottom: 8 }}>{toggleError}</div>
      )}

      <UnitTypeRows propertyId={property.id} masterEnabled={enabled} />
    </div>
  )
}

// Per-unit-type DECISION rows: list + upsert + remove. The ONLY late-fee config.
function UnitTypeRows({ propertyId, masterEnabled }: { propertyId: string; masterEnabled: boolean }) {
  const qc = useQueryClient()
  const { data: rows = [] } = useQuery<any[]>(
    ['late-fee-overrides', propertyId],
    () => apiGet(`/properties/${propertyId}/late-fee-overrides`),
    { enabled: !!propertyId })
  const { data: units = [] } = useQuery<any[]>(
    ['units-for-late-fee', propertyId],
    () => apiGet(`/units?propertyId=${propertyId}`),
    { enabled: !!propertyId })
  const [unitType, setUnitType] = useState('')
  const [decision, setDecision] = useState<'fee' | 'none'>('fee')
  const [amount, setAmount] = useState('')
  const [kind, setKind] = useState('flat')
  const [grace, setGrace] = useState('5')
  // S537: accrual ("$5/day after") + optional cap are part of the decision.
  const [accrualAmount, setAccrualAmount] = useState('')
  const [accrualPeriod, setAccrualPeriod] = useState('daily')
  const [capAmount, setCapAmount] = useState('')
  const [showGraceInfo, setShowGraceInfo] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)

  const upsertMut = useMutation(
    () => apiPut(`/properties/${propertyId}/late-fee-overrides`, decision === 'none'
      ? { unitType, noLateFee: true }
      : { unitType, graceDays: Math.trunc(Number(grace) || 0), initialAmount: Number(amount), initialType: kind,
          ...(accrualAmount !== '' ? { accrualAmount: Number(accrualAmount), accrualType: 'flat', accrualPeriod } : {}),
          ...(capAmount !== '' ? { capAmount: Number(capAmount), capType: 'flat' } : {}) }),
    { onSuccess: () => { setRowError(null); qc.invalidateQueries(['late-fee-overrides', propertyId]); setUnitType(''); setAmount(''); setAccrualAmount(''); setCapAmount(''); setDecision('fee'); setShowGraceInfo(false) },
      onError: (e: any) => setRowError(e?.response?.data?.error || 'Could not save the late-fee decision') }
  )
  const removeMut = useMutation(
    (ut: string) => apiDelete(`/properties/${propertyId}/late-fee-overrides/${ut}`),
    { onSuccess: () => { setRowError(null); qc.invalidateQueries(['late-fee-overrides', propertyId]) },
      onError: (e: any) => setRowError(e?.response?.data?.error || 'Could not remove the decision') }
  )

  const g = Math.max(0, Math.trunc(Number(grace) || 0))

  // S537: surface UNDECIDED classes — unit types present at the property
  // with no decision row. These block unit-adds and onboarding.
  const decidedTypes = new Set((rows as any[]).map((o: any) => o.unitType))
  const undecidedInUse = Array.from(new Set((units as any[]).map((u: any) => u.unitType).filter(Boolean)))
    .filter(t => !decidedTypes.has(t as string)) as string[]

  return (
    <div>
      {undecidedInUse.length > 0 && (
        <div style={{ display: 'flex', gap: 8, background: 'rgba(245,158,11,.08)', border: '1px solid var(--amber, #d97706)', borderRadius: 8, padding: '8px 12px', fontSize: '.78rem', marginBottom: 12 }}>
          <AlertTriangle size={14} style={{ color: 'var(--amber, #d97706)', flexShrink: 0, marginTop: 2 }} />
          <div>
            <strong>Undecided unit {undecidedInUse.length === 1 ? 'type' : 'types'}:</strong>{' '}
            {undecidedInUse.map(t => UNIT_TYPE_LABELS[t] || humanize(t)).join(', ')} — existing units of
            {undecidedInUse.length === 1 ? ' this type' : ' these types'} keep operating, but new units
            and tenant onboarding are blocked until you decide below (set terms or choose No late fee).
          </div>
        </div>
      )}

      {(rows as any[]).length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {(rows as any[]).map((o: any) => (
            <div key={o.unitType} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: 'var(--bg-2)', borderRadius: 8, fontSize: '.8rem' }}>
              <span style={{ fontWeight: 600, flex: '0 0 110px' }}>{UNIT_TYPE_LABELS[o.unitType] || humanize(o.unitType)}</span>
              {o.noLateFee ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-3)' }}>
                  <Ban size={12} /> No late fee (explicit decision)
                </span>
              ) : (
                <>
                  <span className="mono">
                    {o.lateFeeInitialType === 'percent_of_rent'
                      ? `${Number(o.lateFeeInitialAmount)}% of rent`
                      : `$${Number(o.lateFeeInitialAmount).toFixed(2)}`}
                  </span>
                  <span style={{ color: 'var(--text-3)', fontSize: '.74rem' }}>
                    {o.lateFeeGraceDays}-day grace · fee starts day {1 + Number(o.lateFeeGraceDays)} when rent is due the 1st
                    {o.lateFeeAccrualAmount != null && ` · +${o.lateFeeAccrualType === 'percent_of_rent' ? `${Number(o.lateFeeAccrualAmount)}% of rent` : `$${Number(o.lateFeeAccrualAmount).toFixed(2)}`}/${String(o.lateFeeAccrualPeriod || '').replace('daily', 'day').replace('weekly', 'week').replace('monthly', 'month')} after`}
                    {o.lateFeeCapAmount != null && ` · capped at ${o.lateFeeCapType === 'percent_of_rent' ? `${Number(o.lateFeeCapAmount)}% of rent` : `$${Number(o.lateFeeCapAmount).toFixed(2)}`}`}
                    {o.lateFeeCapAmount == null && ` · no cap`}
                  </span>
                </>
              )}
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', padding: '2px 8px' }}
                title="Remove the decision — only possible while no units of this type exist"
                onClick={() => removeMut.mutate(o.unitType)}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: '.76rem', color: 'var(--amber, #d97706)', marginBottom: 12 }}>
          No unit types decided — units can&apos;t be added and tenants can&apos;t be onboarded at this
          property until each unit type has a decision here.
        </div>
      )}

      {rowError && (
        <div style={{ fontSize: '.76rem', color: 'var(--red, #dc2626)', marginBottom: 10 }}>{rowError}</div>
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
          <span style={lbl}>Decision</span>
          <select className="form-select" value={decision} onChange={e => setDecision(e.target.value as 'fee' | 'none')} style={{ width: 130 }}>
            <option value="fee">Charge a fee</option>
            <option value="none">No late fee</option>
          </select>
        </div>
        {decision === 'fee' && (
          <>
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
            <div>
              <span style={lbl}>Then accrues $ (optional)</span>
              <input className="form-input mono" type="text" inputMode="decimal" value={accrualAmount}
                onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setAccrualAmount(v) }}
                placeholder="5" style={{ width: 70 }} />
            </div>
            {accrualAmount !== '' && (
              <div>
                <span style={lbl}>Per</span>
                <select className="form-select" value={accrualPeriod} onChange={e => setAccrualPeriod(e.target.value)} style={{ width: 90 }}>
                  <option value="daily">Day</option>
                  <option value="weekly">Week</option>
                  <option value="monthly">Month</option>
                </select>
              </div>
            )}
            <div>
              <span style={lbl}>Cap $ (optional)</span>
              <input className="form-input mono" type="text" inputMode="decimal" value={capAmount}
                onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setCapAmount(v) }}
                placeholder="none" style={{ width: 80 }} />
            </div>
          </>
        )}
        <button className="btn btn-primary btn-sm"
          disabled={!unitType || (decision === 'fee' && amount === '') || upsertMut.isLoading}
          onClick={() => upsertMut.mutate()}>
          {upsertMut.isLoading ? 'Saving…' : decision === 'none' ? 'Save Decision' : 'Add Late Fee'}
        </button>
      </div>

      {!masterEnabled && (rows as any[]).length > 0 && (
        <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: 8 }}>
          The property master toggle is off — decisions stay on record and still satisfy the
          onboarding gate, but no late fees are charged or drafted while it&apos;s off.
        </div>
      )}

      {/* S535 (Nic): the grace popup — the landlord sees exactly which day
          the fee starts under what they picked. Engine rule: fee fires
          when the local date reaches due date + grace days. */}
      {showGraceInfo && decision === 'fee' && (
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


// S537 (Nic): partial payments reset the eviction clock — the landlord
// can refuse anything under the full outstanding balance, per property.
// The tenant portal's single Pay Now enforces this server-side.
export function PaymentAcceptanceCard({ property, onSaved }: { property: any; onSaved: () => void }) {
  const qc = useQueryClient()
  const [accept, setAccept] = useState(property?.acceptPartialPayments !== false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { setAccept(property?.acceptPartialPayments !== false) }, [property?.id, property?.acceptPartialPayments])
  const mut = useMutation(
    (on: boolean) => apiPatch(`/properties/${property.id}`, { acceptPartialPayments: on }),
    { onSuccess: () => { setErr(null); qc.invalidateQueries('properties'); onSaved() },
      onError: (e: any) => { setAccept(property?.acceptPartialPayments !== false); setErr(e?.response?.data?.error || 'Could not save') } }
  )
  return (
    <div className="card" style={{ padding: 14, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Clock size={15} style={{ color: 'var(--gold)' }} />
        <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>Payment Acceptance</h2>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.82rem', cursor: 'pointer' }}>
        <input type="checkbox" checked={accept} disabled={mut.isLoading}
          onChange={e => { setAccept(e.target.checked); mut.mutate(e.target.checked) }} />
        Accept partial payments at this property
      </label>
      <div style={{ fontSize: '.75rem', color: 'var(--text-3)', lineHeight: 1.5, marginTop: 6 }}>
        Tenants pay any amount toward their balance (applied oldest-first), including paying ahead.
        Turn this OFF if you are preparing an eviction — accepting a partial payment can reset the
        eviction clock. When off, the tenant&apos;s Pay Now requires the full outstanding balance.
        Check your local laws.
      </div>
      {err && <div style={{ fontSize: '.76rem', color: 'var(--red, #dc2626)', marginTop: 6 }}>{err}</div>}
    </div>
  )
}
