// S556: per-(property, unit_type) security-deposit multiplier config. The
// lease deposit is derived — deposit = rent × multiplier — so the landlord
// sets the ratio once per unit class instead of retyping a dollar amount on
// every lease. Unset = 1.0 (one month's rent). Mirrors PropertyLateFeeSection.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { Trash2, PiggyBank } from 'lucide-react'
import { apiDelete, apiGet, apiPut } from '../lib/api'
import { UNIT_TYPE_LABEL, humanize } from '@gam/shared'
import { toast } from '../components/dialogs'

const UNIT_TYPE_LABELS: Record<string, string> = UNIT_TYPE_LABEL

export function PropertyDepositSection({ property }: { property: any }) {
  const qc = useQueryClient()
  const propertyId = property.id
  const [unitType, setUnitType] = useState('')
  const [mult, setMult] = useState('1.5')

  const { data: rows = [] } = useQuery(['deposit-multipliers', propertyId],
    () => apiGet(`/properties/${propertyId}/deposit-multipliers`))
  const { data: units = [] } = useQuery(['units', propertyId],
    () => apiGet(`/units?propertyId=${propertyId}`))

  const invalidate = () => qc.invalidateQueries(['deposit-multipliers', propertyId])
  const upsertMut = useMutation(
    () => apiPut(`/properties/${propertyId}/deposit-multipliers`, { unitType, multiplier: Number(mult) }),
    { onSuccess: () => { invalidate(); setUnitType(''); setMult('1.5'); toast('Deposit ratio saved') },
      onError: (e: any) => toast.error(e?.message || 'Save failed') })
  const removeMut = useMutation(
    (ut: string) => apiDelete(`/properties/${propertyId}/deposit-multipliers/${ut}`),
    { onSuccess: () => { invalidate(); toast('Reverted to one month') } })

  // unit types present at this property that don't yet have a row
  const inUse = Array.from(new Set((units as any[]).map((u: any) => u.unitType).filter(Boolean)))
  const available = inUse.filter(t => !(rows as any[]).some((r: any) => r.unitType === t))

  const fmt = (m: number) => `${m}× rent${m === 1 ? '' : ` (${m} month${m === 1 ? '' : 's'})`}`

  return (
    <div className="card" style={{ padding: 18, marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <PiggyBank size={16} color="var(--gold)" />
        <h3 style={{ margin: 0, fontSize: '.95rem', fontWeight: 800 }}>Security Deposit</h3>
      </div>
      <p style={{ fontSize: '.75rem', color: 'var(--text-3)', margin: '0 0 12px' }}>
        The deposit on each lease is calculated from the unit's rent × this ratio. Unit classes with no ratio
        set default to <b>1× rent</b> (one month). The landlord can still adjust the amount on any individual lease.
      </p>

      {(rows as any[]).length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {(rows as any[]).map((r: any) => (
            <div key={r.unitType} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: 'var(--bg-2)', borderRadius: 8, fontSize: '.8rem' }}>
              <span style={{ fontWeight: 600, flex: '0 0 130px' }}>{UNIT_TYPE_LABELS[r.unitType] || humanize(r.unitType)}</span>
              <span style={{ color: 'var(--text-2)' }}>{fmt(Number(r.depositMultiplier))}</span>
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} title="Revert to one month"
                onClick={() => removeMut.mutate(r.unitType)} disabled={removeMut.isLoading}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {available.length > 0 ? (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <div>
            <label style={{ fontSize: '.68rem', color: 'var(--text-3)', display: 'block', marginBottom: 3 }}>Unit type</label>
            <select className="form-select" value={unitType} onChange={e => setUnitType(e.target.value)} style={{ width: 150 }}>
              <option value="">Select…</option>
              {available.map(t => <option key={t} value={t}>{UNIT_TYPE_LABELS[t] || humanize(t)}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: '.68rem', color: 'var(--text-3)', display: 'block', marginBottom: 3 }}>× rent</label>
            <input className="input" type="number" min={0} max={12} step={0.25} value={mult}
              onChange={e => setMult(e.target.value)} style={{ width: 90 }} />
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => upsertMut.mutate()}
            disabled={!unitType || mult === '' || upsertMut.isLoading}>Save</button>
        </div>
      ) : (
        <p style={{ fontSize: '.72rem', color: 'var(--text-4)', margin: 0 }}>
          {inUse.length === 0 ? 'Add units to this property to set deposit ratios by type.' : 'All unit types at this property have a deposit ratio set.'}
        </p>
      )}
    </div>
  )
}
