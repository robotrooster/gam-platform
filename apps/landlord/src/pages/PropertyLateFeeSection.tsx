import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { Clock, Trash2, Pencil } from 'lucide-react'
import { apiDelete, apiGet, apiPatch, apiPut } from '../lib/api'
import { lateFeeStartDate, nextAccrualDate, computeLateFeeAmount } from '@gam/shared'
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
      <div style={{ fontSize: '.75rem', color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 12, background: 'var(--bg-2)', borderRadius: 8, padding: '10px 12px' }}>
        <strong style={{ color: 'var(--text-1)' }}>How a fee is charged.</strong> The grace period always
        applies first — no fee while the tenant is inside it. You can set a one-time fee, an ongoing
        amount (per day/week/month), or both, plus an optional cap. The <strong>Counts&nbsp;from</strong> setting
        decides where an ongoing amount starts once grace passes:
        {' '}<strong>Due date (incl.)</strong> charges every day back to the due date;
        {' '}<strong>Day after due date</strong> starts the day after;
        {' '}<strong>End of grace period</strong> starts only after grace (no upfront fee is charged with the
        two retroactive options). Charging back to the due date isn&apos;t permitted everywhere —
        confirm it&apos;s allowed under your local laws.
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
  const [unitType, setUnitType] = useState('')
  const [amount, setAmount] = useState('')
  const [kind, setKind] = useState('flat')
  const [grace, setGrace] = useState('5')
  // S537: accrual ("$5/day after") + optional cap are part of the decision.
  const [accrualAmount, setAccrualAmount] = useState('')
  const [accrualPeriod, setAccrualPeriod] = useState('daily')
  // S577: where the accrual counts from once grace is crossed. Default
  // due_date_inclusive; landlord-configurable, neutral legal copy.
  const [accrualFrom, setAccrualFrom] = useState<'grace_end' | 'due_date' | 'due_date_inclusive'>('due_date_inclusive')
  const [capAmount, setCapAmount] = useState('')
  const [rowError, setRowError] = useState<string | null>(null)
  // S604 (Nic): there was NO edit — only a trash button. Changing a late fee
  // meant deleting it and retyping every field, even with zero leases attached.
  // The save endpoint is already an UPSERT keyed on (property, unitType), so
  // editing is just "load the row back into the form".
  const [editing, setEditing] = useState<string | null>(null)

  const resetForm = () => {
    setEditing(null); setUnitType(''); setAmount(''); setKind('flat')
    setAccrualAmount(''); setAccrualPeriod('daily'); setAccrualFrom('due_date_inclusive')
    setCapAmount(''); setGrace('5'); setRowError(null)
  }

  const loadForEdit = (o: any) => {
    setEditing(o.unitType)
    setUnitType(o.unitType)
    setGrace(String(o.lateFeeGraceDays ?? 5))
    setKind(o.lateFeeInitialType || 'flat')
    setAmount(o.lateFeeInitialAmount != null && Number(o.lateFeeInitialAmount) > 0
      ? String(Number(o.lateFeeInitialAmount)) : '')
    setAccrualAmount(o.lateFeeAccrualAmount != null ? String(Number(o.lateFeeAccrualAmount)) : '')
    setAccrualPeriod(o.lateFeeAccrualPeriod || 'daily')
    setAccrualFrom(o.lateFeeAccrualFrom || 'due_date_inclusive')
    setCapAmount(o.lateFeeCapAmount != null ? String(Number(o.lateFeeCapAmount)) : '')
    setRowError(null)
  }

  // Retroactive (counts back to the due date) + an accrual set = daily-only,
  // no upfront fee (Nic). The server enforces this too.
  const retroWithAccrual = accrualFrom !== 'grace_end' && accrualAmount !== ''

  const upsertMut = useMutation(
    () => apiPut(`/properties/${propertyId}/late-fee-overrides`,
      { unitType, graceDays: Math.trunc(Number(grace) || 0),
        initialAmount: retroWithAccrual ? 0 : Number(amount), initialType: kind,
        ...(accrualAmount !== '' ? { accrualAmount: Number(accrualAmount), accrualType: 'flat', accrualPeriod, accrualFrom } : {}),
        ...(capAmount !== '' ? { capAmount: Number(capAmount), capType: 'flat' } : {}) }),
    { onSuccess: () => { qc.invalidateQueries(['late-fee-overrides', propertyId]); resetForm() },
      onError: (e: any) => setRowError(e?.response?.data?.error || 'Could not save the late fee') }
  )
  // ── S604 (Nic): LIVE SCHEDULE PREVIEW ────────────────────────────────────
  // "functionally it works, but it is super hard to configure that to be
  // correct... there's no way to verify that's actually coming out the way you
  // said. I just have to trust you."
  //
  // Calls the SAME shared helpers the billing job runs (nextAccrualDate /
  // computeLateFeeAmount / lateFeeStartDate) so the preview can never drift
  // from what actually bills. Modelled on rent due the 1st of a 30-day month.
  const previewRows = (() => {
    const g = Math.trunc(Number(grace) || 0)
    const hasAcc = accrualAmount !== '' && Number(accrualAmount) > 0
    const initAmt = retroWithAccrual ? 0 : Number(amount) || 0
    if (!hasAcc && initAmt <= 0) return null
    const DUE = '2026-09-01'
    const RENT = 1000  // only used to render % -of-rent policies concretely
    const gateDate = lateFeeStartDate(DUE, g)
    const cap = capAmount !== '' ? Number(capAmount) : null

    const totalOn = (dayIso: string): number => {
      if (dayIso < gateDate) return 0          // grace gates ALL fees
      let total = 0
      if (!retroWithAccrual && initAmt > 0) {
        total += computeLateFeeAmount(kind as any, initAmt, RENT)
      }
      if (hasAcc) {
        for (let occ = 1; occ <= 400; occ++) {
          const tick = nextAccrualDate(DUE, g, accrualPeriod as any, occ, accrualFrom)
          if (tick > dayIso) break
          total += computeLateFeeAmount('flat', Number(accrualAmount), RENT)
        }
      }
      if (cap != null && total > cap) total = cap
      return Math.round(total * 100) / 100
    }

    const days = [5, g + 1, 10, 15, 30]
      .filter((d, i, a) => d >= 1 && d <= 30 && a.indexOf(d) === i)
      .sort((x, y) => x - y)
    return days.map(d => {
      const iso = `2026-09-${String(d).padStart(2, '0')}`
      return { day: d, iso, amount: totalOn(iso), inGrace: iso < gateDate }
    })
  })()

  const removeMut = useMutation(
    (ut: string) => apiDelete(`/properties/${propertyId}/late-fee-overrides/${ut}`),
    { onSuccess: () => { setRowError(null); qc.invalidateQueries(['late-fee-overrides', propertyId]) },
      onError: (e: any) => setRowError(e?.response?.data?.error || 'Could not remove the decision') }
  )

  return (
    <div>
      {(rows as any[]).filter((o: any) => !o.noLateFee).length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {(rows as any[]).filter((o: any) => !o.noLateFee).map((o: any) => (
            <div key={o.unitType} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: 'var(--bg-2)', borderRadius: 8, fontSize: '.8rem' }}>
              <span style={{ fontWeight: 600, flex: '0 0 110px' }}>{UNIT_TYPE_LABELS[o.unitType] || humanize(o.unitType)}</span>
              {(() => {
                const retro = o.lateFeeAccrualFrom && o.lateFeeAccrualFrom !== 'grace_end'
                const hasAcc = o.lateFeeAccrualAmount != null
                const per = String(o.lateFeeAccrualPeriod || '').replace('daily', 'day').replace('weekly', 'week').replace('monthly', 'month')
                const accStr = hasAcc ? (o.lateFeeAccrualType === 'percent_of_rent' ? `${Number(o.lateFeeAccrualAmount)}% of rent` : `$${Number(o.lateFeeAccrualAmount).toFixed(2)}`) : ''
                return (
                <>
                  <span className="mono">
                    {retro && hasAcc
                      ? `${accStr}/${per}`
                      : o.lateFeeInitialType === 'percent_of_rent'
                        ? `${Number(o.lateFeeInitialAmount)}% of rent`
                        : `$${Number(o.lateFeeInitialAmount).toFixed(2)}`}
                  </span>
                  <span style={{ color: 'var(--text-3)', fontSize: '.74rem' }}>
                    {o.lateFeeGraceDays}-day grace ·{' '}
                    {retro && hasAcc
                      ? `retroactive to the ${o.lateFeeAccrualFrom === 'due_date_inclusive' ? 'due date' : 'day after the due date'} once grace passes`
                      : `fee starts day ${1 + Number(o.lateFeeGraceDays)} when rent is due the 1st`}
                    {!retro && hasAcc && ` · +${accStr}/${per} after`}
                    {o.lateFeeCapAmount != null && ` · capped at ${o.lateFeeCapType === 'percent_of_rent' ? `${Number(o.lateFeeCapAmount)}% of rent` : `$${Number(o.lateFeeCapAmount).toFixed(2)}`}`}
                    {o.lateFeeCapAmount == null && ` · no cap`}
                  </span>
                </>
                )
              })()}
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', padding: '2px 8px' }}
                title="Edit this late fee"
                onClick={() => loadForEdit(o)}>
                <Pencil size={12} />
              </button>
              <button className="btn btn-ghost btn-sm" style={{ padding: '2px 8px' }}
                title="Remove this late fee (reverts the type to no late fee)"
                onClick={() => removeMut.mutate(o.unitType)}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: '.76rem', color: 'var(--text-3)', marginBottom: 12 }}>
          No late fees set. By default no late fee is charged — add one below only for the unit
          types you want to charge.
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
          <span style={lbl}>{retroWithAccrual ? 'Fee (n/a)' : 'Fee'}</span>
              <input className="form-input mono" type="text" inputMode="decimal"
                value={retroWithAccrual ? '' : amount} disabled={retroWithAccrual}
                onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setAmount(v) }}
                placeholder={retroWithAccrual ? '$0' : '25'} style={{ width: 80, opacity: retroWithAccrual ? 0.5 : 1 }} />
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
                onChange={e => { const v = e.target.value; if (v === '' || /^\d+$/.test(v)) setGrace(v) }}
                style={{ width: 70 }} />
            </div>
            <div>
              <span style={lbl}>Ongoing $ (optional)</span>
              <input className="form-input mono" type="text" inputMode="decimal" value={accrualAmount}
                onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setAccrualAmount(v) }}
                placeholder="5" style={{ width: 90 }} />
            </div>
            <div>
              <span style={lbl}>Per</span>
              <select className="form-select" value={accrualPeriod} onChange={e => setAccrualPeriod(e.target.value)} style={{ width: 90 }}>
                <option value="daily">Day</option>
                <option value="weekly">Week</option>
                <option value="monthly">Month</option>
              </select>
            </div>
            <div>
              <span style={lbl}>Counts from</span>
              <select className="form-select" value={accrualFrom} onChange={e => setAccrualFrom(e.target.value as any)} style={{ width: 190 }}>
                <option value="due_date_inclusive">Due date (incl. due date)</option>
                <option value="due_date">Day after due date</option>
                <option value="grace_end">End of grace period</option>
              </select>
            </div>
            <div>
              <span style={lbl}>Cap $ (optional)</span>
              <input className="form-input mono" type="text" inputMode="decimal" value={capAmount}
                onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setCapAmount(v) }}
                placeholder="none" style={{ width: 80 }} />
            </div>
        <button className="btn btn-primary btn-sm"
          disabled={!unitType || (amount === '' && !retroWithAccrual) || upsertMut.isLoading}
          onClick={() => upsertMut.mutate()}>
          {upsertMut.isLoading ? 'Saving…' : (editing ? 'Save Changes' : 'Add Late Fee')}
        </button>
        {editing && (
          <button className="btn btn-ghost btn-sm" onClick={resetForm}>Cancel</button>
        )}
      </div>

      {/* S604: schedule preview — see previewRows. Renders BEFORE saving so the
          landlord can verify the policy instead of trusting it. */}
      {previewRows && (
        <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--bg-2)',
                      borderRadius: 8, border: '1px solid var(--border-0)' }}>
          <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--gold)',
                        textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>
            What this charges
          </div>
          <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginBottom: 8 }}>
            Example: rent due the 1st{kind === 'percent_of_rent' || false ? ' on $1,000 rent' : ''}.
            {retroWithAccrual
              ? ' No flat fee — the ongoing charge is counted back to the due date once grace passes.'
              : ''}
          </div>
          <table style={{ width: '100%', fontSize: '.75rem', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--text-3)', textAlign: 'left' }}>
                <th style={{ fontWeight: 600, padding: '3px 0' }}>If unpaid on</th>
                <th style={{ fontWeight: 600, padding: '3px 0', textAlign: 'right' }}>Late fees owed</th>
              </tr>
            </thead>
            <tbody>
              {previewRows.map(r => (
                <tr key={r.day} style={{ borderTop: '1px solid var(--border-0)' }}>
                  <td style={{ padding: '4px 0' }}>
                    the {r.day}{r.day === 1 ? 'st' : r.day === 2 ? 'nd' : r.day === 3 ? 'rd' : 'th'}
                    {r.inGrace && <span style={{ color: 'var(--text-3)' }}> · in grace</span>}
                  </td>
                  <td style={{ padding: '4px 0', textAlign: 'right', fontFamily: 'var(--font-mono)',
                               color: r.amount > 0 ? 'var(--text-0)' : 'var(--text-3)' }}>
                    ${r.amount.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!masterEnabled && (rows as any[]).filter((o: any) => !o.noLateFee).length > 0 && (
        <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: 8 }}>
          The property master toggle is off — saved late fees stay on record but aren&apos;t
          charged or drafted while it&apos;s off.
        </div>
      )}
    </div>
  )
}


// PaymentAcceptanceCard (S537 accept-partial-payments toggle) REMOVED — Nic:
// rent is pay-in-full only across the whole system, so there is no per-property
// partial-payment setting. The tenant portal always requires the full balance
// and /pay-balance enforces it server-side.
