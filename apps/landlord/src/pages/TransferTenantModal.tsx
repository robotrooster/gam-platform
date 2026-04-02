import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { X, ArrowRight, DoorOpen, DollarSign, Calendar, Check, AlertTriangle } from 'lucide-react'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

interface Props {
  tenantId: string
  tenantName: string
  currentUnit: { id: string; unit_number: string; rent_amount: number; property_name: string }
  onClose: () => void
}

export function TransferTenantModal({ tenantId, tenantName, currentUnit, onClose }: Props) {
  const qc = useQueryClient()
  const [selectedUnit, setSelectedUnit] = useState<any>(null)
  const [newRent, setNewRent] = useState(currentUnit.rent_amount.toString())
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().split('T')[0])
  const [notes, setNotes] = useState('')
  const [result, setResult] = useState<any>(null)

  const { data: availableUnits = [] } = useQuery<any[]>(
    ['available-units', tenantId],
    () => apiGet(`/tenants/${tenantId}/available-units`)
  )

  const transferMut = useMutation(
    (data: any) => apiPost(`/tenants/${tenantId}/transfer`, data),
    {
      onSuccess: (res: any) => {
        qc.invalidateQueries('units')
        qc.invalidateQueries('tenants')
        qc.invalidateQueries(['tenant-profile', tenantId])
        setResult(res.data)
      }
    }
  )

  const oldRent = parseFloat(currentUnit.rent_amount.toString())
  const newRentNum = parseFloat(newRent) || 0
  const rentChanged = Math.abs(oldRent - newRentNum) > 0.01
  const transferDate = new Date(effectiveDate)
  const isImmediate = transferDate <= new Date()
  const daysInMonth = new Date(transferDate.getFullYear(), transferDate.getMonth() + 1, 0).getDate()
  const daysRemaining = daysInMonth - transferDate.getDate() + 1
  const proratedAmount = rentChanged ? (newRentNum / daysInMonth) * daysRemaining : null

  const canTransfer = selectedUnit && newRent && effectiveDate

  // Success screen
  if (result) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
          <div style={{ textAlign: 'center', padding: '8px 0 20px' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(30,219,122,.12)', border: '2px solid var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
              <Check size={24} style={{ color: 'var(--green)' }} />
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-0)', marginBottom: 6 }}>
              {result.transferred ? 'Transfer Complete' : 'Transfer Scheduled'}
            </div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>
              {tenantName} {result.transferred ? 'has been moved' : 'will be moved on ' + new Date(result.effectiveDate).toLocaleDateString()}
            </div>
          </div>

          <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10, padding: 14, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginBottom: 3 }}>From</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-1)' }}>Unit {result.fromUnit}</div>
                <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{fmt(result.oldRent)}/mo</div>
              </div>
              <ArrowRight size={20} style={{ color: 'var(--gold)' }} />
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginBottom: 3 }}>To</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--gold)' }}>Unit {result.toUnit}</div>
                <div style={{ fontSize: '.72rem', color: 'var(--gold)' }}>{fmt(result.newRent)}/mo</div>
              </div>
            </div>
            {result.proratedAmount && (
              <div style={{ marginTop: 10, padding: '8px 10px', background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.2)', borderRadius: 8, fontSize: '.72rem', color: 'var(--gold)', textAlign: 'center' }}>
                Prorated rent for remainder of month: {fmt(result.proratedAmount)}
              </div>
            )}
          </div>

          <button className="btn btn-primary" style={{ width: '100%' }} onClick={onClose}>Done</button>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520, width: '95vw', maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>Transfer Tenant</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: 6 }}><X size={15} /></button>
        </div>

        {/* Current unit */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 10, marginBottom: 16 }}>
          <DoorOpen size={14} style={{ color: 'var(--text-3)' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '.78rem', fontWeight: 600, color: 'var(--text-0)' }}>{tenantName}</div>
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>Currently in Unit {currentUnit.unit_number} · {currentUnit.property_name} · {fmt(currentUnit.rent_amount)}/mo</div>
          </div>
          <ArrowRight size={16} style={{ color: 'var(--gold)' }} />
        </div>

        {/* Select new unit */}
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 8 }}>Move To *</label>
          {(availableUnits as any[]).length === 0 ? (
            <div style={{ padding: '12px 14px', background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 8, fontSize: '.78rem', color: 'var(--text-3)' }}>
              No vacant units available. Add a vacant unit first.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
              {(availableUnits as any[]).map((u: any) => (
                <div key={u.id} onClick={() => { setSelectedUnit(u); setNewRent(u.rent_amount.toString()) }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8, cursor: 'pointer', transition: 'all .12s', border: `1px solid ${selectedUnit?.id === u.id ? 'var(--gold)' : 'var(--border-0)'}`, background: selectedUnit?.id === u.id ? 'rgba(201,162,39,.06)' : 'var(--bg-2)' }}>
                  <DoorOpen size={14} style={{ color: selectedUnit?.id === u.id ? 'var(--gold)' : 'var(--text-3)' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '.82rem', fontWeight: 600, color: 'var(--text-0)' }}>Unit {u.unit_number}</div>
                    <div style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>{u.property_name} · {u.bedrooms}bd/{u.bathrooms}ba{u.sqft ? ` · ${u.sqft} sqft` : ''}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.82rem', color: 'var(--gold)', fontWeight: 600 }}>{fmt(u.rent_amount)}/mo</div>
                  </div>
                  {selectedUnit?.id === u.id && <Check size={14} style={{ color: 'var(--gold)', flexShrink: 0 }} />}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* New rent amount */}
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>
            New Rent Amount *
          </label>
          <div style={{ position: 'relative' }}>
            <DollarSign size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
            <input className="input" type="number" placeholder="0.00" value={newRent} onChange={e => setNewRent(e.target.value)} style={{ width: '100%', paddingLeft: 28 }} />
          </div>
          {rentChanged && (
            <div style={{ fontSize: '.7rem', color: 'var(--amber)', marginTop: 4 }}>
              Rent changing from {fmt(oldRent)} → {fmt(newRentNum)}
              {proratedAmount && ` · Prorated remainder: ${fmt(proratedAmount)}`}
            </div>
          )}
        </div>

        {/* Effective date */}
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>
            Effective Date *
          </label>
          <input className="input" type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} style={{ width: '100%' }} />
          <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 4 }}>
            {isImmediate ? '⚡ Immediate transfer — will execute now' : `📅 Scheduled — transfer will execute on ${new Date(effectiveDate).toLocaleDateString()}`}
          </div>
        </div>

        {/* Notes */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', display: 'block', marginBottom: 5 }}>
            Notes <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span>
          </label>
          <input className="input" placeholder="Reason for transfer, special instructions…" value={notes} onChange={e => setNotes(e.target.value)} style={{ width: '100%' }} />
        </div>

        {/* Warning */}
        <div style={{ padding: '10px 12px', background: 'rgba(255,184,32,.06)', border: '1px solid rgba(255,184,32,.2)', borderRadius: 8, fontSize: '.72rem', color: 'var(--amber)', display: 'flex', gap: 8, marginBottom: 16, lineHeight: 1.5 }}>
          <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>Maintenance requests stay with their original unit. A read-only copy will appear on {tenantName}'s tenant history. ACH will update to reflect the new unit and rent amount.</div>
        </div>

        {transferMut.isError && (
          <div style={{ color: 'var(--red)', fontSize: '.75rem', background: 'rgba(255,71,87,.08)', border: '1px solid rgba(255,71,87,.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
            Transfer failed. The new unit may no longer be available.
          </div>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!canTransfer || transferMut.isLoading} onClick={() => transferMut.mutate({ newUnitId: selectedUnit?.id, newRentAmount: newRentNum, effectiveDate, notes })}>
            {transferMut.isLoading ? <span className="spinner" /> : isImmediate ? <><ArrowRight size={14} /> Transfer Now</> : <><Calendar size={14} /> Schedule Transfer</>}
          </button>
        </div>
      </div>
    </div>
  )
}
