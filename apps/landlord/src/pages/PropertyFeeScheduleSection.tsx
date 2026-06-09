import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { Plus, Trash2 } from 'lucide-react'
import { apiGet, apiPost, apiDelete } from '../lib/api'

type FeeRow = {
  id: string
  feeType: string
  slotIndex: number
  description: string | null
  amount: string | number
  isRefundable: boolean
  dueTiming: 'move_in' | 'monthly_ongoing' | 'move_out' | 'other'
  createdAt: string
  updatedAt: string
}

const SINGLE_INSTANCE_FEE_TYPES = [
  { type: 'cleaning_fee',          label: 'Cleaning fee',          defaultRefundable: false, defaultTiming: 'move_out'    },
  { type: 'pet_fee',               label: 'Pet fee',               defaultRefundable: false, defaultTiming: 'move_in'     },
  { type: 'pet_deposit',           label: 'Pet deposit',           defaultRefundable: true,  defaultTiming: 'move_in'     },
  { type: 'key_deposit',           label: 'Key deposit',           defaultRefundable: true,  defaultTiming: 'move_in'     },
  { type: 'cleaning_deposit',      label: 'Cleaning deposit',      defaultRefundable: true,  defaultTiming: 'move_in'     },
  { type: 'move_in_fee',           label: 'Move-in fee',           defaultRefundable: false, defaultTiming: 'move_in'     },
  { type: 'application_fee',       label: 'Application fee',       defaultRefundable: false, defaultTiming: 'move_in'     },
  { type: 'amenity_fee',           label: 'Amenity fee (one-time)',defaultRefundable: false, defaultTiming: 'move_in'     },
  { type: 'hoa_transfer_fee',      label: 'HOA transfer fee',      defaultRefundable: false, defaultTiming: 'move_in'     },
  { type: 'lease_prep_fee',        label: 'Lease prep fee',        defaultRefundable: false, defaultTiming: 'move_in'     },
  { type: 'last_month_rent',       label: "Last month's rent",     defaultRefundable: true,  defaultTiming: 'move_in'     },
  { type: 'pet_rent',              label: 'Pet rent (monthly)',    defaultRefundable: false, defaultTiming: 'monthly_ongoing' },
  { type: 'parking_rent',          label: 'Parking rent',          defaultRefundable: false, defaultTiming: 'monthly_ongoing' },
  { type: 'storage_rent',          label: 'Storage rent',          defaultRefundable: false, defaultTiming: 'monthly_ongoing' },
  { type: 'amenity_fee_monthly',   label: 'Amenity fee (monthly)', defaultRefundable: false, defaultTiming: 'monthly_ongoing' },
  { type: 'trash_fee',             label: 'Trash fee',             defaultRefundable: false, defaultTiming: 'monthly_ongoing' },
  { type: 'pest_control_fee',      label: 'Pest control fee',      defaultRefundable: false, defaultTiming: 'monthly_ongoing' },
  { type: 'technology_fee',        label: 'Technology fee',        defaultRefundable: false, defaultTiming: 'monthly_ongoing' },
  { type: 'early_termination_fee', label: 'Early-termination fee', defaultRefundable: false, defaultTiming: 'other'       },
] as const

const TIMING_LABEL: Record<string, string> = {
  move_in: 'At move-in',
  monthly_ongoing: 'Monthly',
  move_out: 'At move-out',
  other: 'Other / event-based',
}

const fmt = (n: any) => {
  if (n == null) return '$—'
  const v = typeof n === 'string' ? parseFloat(n) : n
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function PropertyFeeScheduleSection({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null) // fee_type:slot_index key

  const { data = [], isLoading } = useQuery<FeeRow[]>(
    ['property-fee-schedule', propertyId],
    () => apiGet<FeeRow[]>(`/properties/${propertyId}/fee-schedule`),
  )

  const list = data as FeeRow[]
  const byKey = new Map<string, FeeRow>()
  for (const r of list) byKey.set(`${r.feeType}:${r.slotIndex}`, r)

  const otherFees = list.filter(r => r.feeType === 'other_fee').sort((a, b) => a.slotIndex - b.slotIndex)
  const nextOtherSlot = otherFees.length === 0 ? 0 : Math.max(...otherFees.map(f => f.slotIndex)) + 1

  return (
    <div className="card" style={{ padding: 0, marginTop: 24 }}>
      <div style={{ padding: 16, borderBottom: '1px solid var(--border-0)', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.05rem', color: 'var(--text-0)' }}>Standard Fee Schedule</h2>
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
            New leases on this property pre-populate from these fees. Per-lease overrides are flagged for audit.
          </div>
        </div>
      </div>

      {error && (
        <div style={{ padding: 12, background: 'rgba(239,68,68,.06)', borderBottom: '1px solid rgba(239,68,68,.2)', color: 'var(--red)', fontSize: '.85rem' }}>{error}</div>
      )}

      {isLoading ? (
        <div style={{ padding: 24, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
      ) : (
        <>
          {/* Single-instance fee types */}
          <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-0)', fontSize: '.7rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', background: 'var(--bg-1)' }}>
            Standard fees (one per type)
          </div>
          {SINGLE_INSTANCE_FEE_TYPES.map(f => (
            <FeeRowEditor
              key={f.type}
              propertyId={propertyId}
              feeType={f.type}
              slotIndex={0}
              label={f.label}
              defaultRefundable={f.defaultRefundable}
              defaultTiming={f.defaultTiming}
              row={byKey.get(`${f.type}:0`)}
              isEditing={editing === `${f.type}:0`}
              onEdit={() => setEditing(`${f.type}:0`)}
              onCancel={() => setEditing(null)}
              onSaved={() => { setEditing(null); qc.invalidateQueries(['property-fee-schedule', propertyId]) }}
              onError={setError}
              showDescription={false}
            />
          ))}

          {/* Other fees (multi-slot) */}
          <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-0)', borderBottom: '1px solid var(--border-0)', fontSize: '.7rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', background: 'var(--bg-1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Other fees (custom)</span>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setEditing(`other_fee:${nextOtherSlot}`)}
            >
              <Plus size={12} /> Add
            </button>
          </div>
          {otherFees.length === 0 && editing !== `other_fee:${nextOtherSlot}` ? (
            <div style={{ padding: 16, color: 'var(--text-3)', textAlign: 'center', fontSize: '.85rem' }}>
              No other-fee variants on this property yet.
            </div>
          ) : (
            <>
              {otherFees.map(f => (
                <FeeRowEditor
                  key={`${f.feeType}:${f.slotIndex}`}
                  propertyId={propertyId}
                  feeType="other_fee"
                  slotIndex={f.slotIndex}
                  label={f.description || `Other fee #${f.slotIndex + 1}`}
                  defaultRefundable={false}
                  defaultTiming="other"
                  row={f}
                  isEditing={editing === `other_fee:${f.slotIndex}`}
                  onEdit={() => setEditing(`other_fee:${f.slotIndex}`)}
                  onCancel={() => setEditing(null)}
                  onSaved={() => { setEditing(null); qc.invalidateQueries(['property-fee-schedule', propertyId]) }}
                  onError={setError}
                  showDescription={true}
                />
              ))}
              {editing === `other_fee:${nextOtherSlot}` && (
                <FeeRowEditor
                  propertyId={propertyId}
                  feeType="other_fee"
                  slotIndex={nextOtherSlot}
                  label={`New other fee`}
                  defaultRefundable={false}
                  defaultTiming="other"
                  row={undefined}
                  isEditing={true}
                  onEdit={() => {}}
                  onCancel={() => setEditing(null)}
                  onSaved={() => { setEditing(null); qc.invalidateQueries(['property-fee-schedule', propertyId]) }}
                  onError={setError}
                  showDescription={true}
                />
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

function FeeRowEditor({
  propertyId,
  feeType,
  slotIndex,
  label,
  defaultRefundable,
  defaultTiming,
  row,
  isEditing,
  onEdit,
  onCancel,
  onSaved,
  onError,
  showDescription,
}: {
  propertyId: string
  feeType: string
  slotIndex: number
  label: string
  defaultRefundable: boolean
  defaultTiming: 'move_in' | 'monthly_ongoing' | 'move_out' | 'other'
  row: FeeRow | undefined
  isEditing: boolean
  onEdit: () => void
  onCancel: () => void
  onSaved: () => void
  onError: (msg: string | null) => void
  showDescription: boolean
}) {
  const qc = useQueryClient()
  const [description, setDescription] = useState<string>(row?.description ?? '')
  const [amount, setAmount] = useState<string>(row?.amount?.toString() ?? '')
  const [isRefundable, setIsRefundable] = useState<boolean>(row?.isRefundable ?? defaultRefundable)
  const [dueTiming, setDueTiming] = useState<typeof defaultTiming>(row?.dueTiming ?? defaultTiming)

  const saveMut = useMutation(
    () => apiPost(`/properties/${propertyId}/fee-schedule`, {
      feeType,
      slotIndex,
      description: description || null,
      amount: parseFloat(amount) || 0,
      isRefundable,
      dueTiming,
    }),
    {
      onSuccess: () => { onError(null); onSaved() },
      onError: (e: any) => onError(e?.response?.data?.error || 'Save failed'),
    },
  )

  const deleteMut = useMutation(
    () => apiDelete(`/properties/${propertyId}/fee-schedule/${row!.id}`),
    {
      onSuccess: () => { onError(null); qc.invalidateQueries(['property-fee-schedule', propertyId]) },
      onError: (e: any) => onError(e?.response?.data?.error || 'Delete failed'),
    },
  )

  if (!isEditing) {
    if (!row) {
      return (
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-0)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ color: 'var(--text-2)', fontSize: '.88rem' }}>{label}</div>
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>Not configured</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onEdit}>Set</button>
        </div>
      )
    }
    return (
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-0)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: 'var(--text-0)', fontSize: '.88rem', fontWeight: 600 }}>{label}</div>
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
            {fmt(row.amount)} · {TIMING_LABEL[row.dueTiming]} · {row.isRefundable ? 'Refundable' : 'Non-refundable'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-ghost btn-sm" onClick={onEdit}>Edit</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: 12, background: 'var(--bg-1)', borderBottom: '1px solid var(--border-0)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: showDescription ? '1fr 120px 160px 100px auto' : '160px 1fr 160px 100px auto', gap: 8, alignItems: 'center' }}>
        {showDescription ? (
          <input
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Fee name (e.g. Pool key)"
            className="input"
          />
        ) : (
          <div style={{ fontSize: '.85rem', color: 'var(--text-1)', fontWeight: 600 }}>{label}</div>
        )}
        <input
          type="number"
          value={amount}
          step="0.01"
          onChange={e => setAmount(e.target.value)}
          placeholder="0.00"
          className="input"
          style={{ textAlign: 'right' }}
        />
        <select value={dueTiming} onChange={e => setDueTiming(e.target.value as typeof defaultTiming)} className="input">
          <option value="move_in">At move-in</option>
          <option value="monthly_ongoing">Monthly</option>
          <option value="move_out">At move-out</option>
          <option value="other">Other / event-based</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '.75rem', color: 'var(--text-2)' }}>
          <input type="checkbox" checked={isRefundable} onChange={e => setIsRefundable(e.target.checked)} />
          Refundable
        </label>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isLoading || !amount}
          >
            {saveMut.isLoading ? 'Saving…' : 'Save'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
          {row && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                if (window.confirm(`Remove "${label}" from this property's fee schedule?`)) deleteMut.mutate()
              }}
              style={{ color: 'var(--red)' }}
              title="Remove"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
