/**
 * Fee plans — rate sheets the PM company offers to landlords. Each row
 * is a distinct contract template. CRUD-lite: create + deprecate. Edit
 * is intentionally limited (audit invariant: changes to active plans
 * must spawn a new plan via deprecation, not mutate in place).
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useAuth } from '../context/AuthContext'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { Plus, X } from 'lucide-react'

interface FeePlan {
  id: string
  name: string
  feeType: string
  percent: string | null
  flatAmount: string | null
  floorAmount: string | null
  ceilingAmount: string | null
  leasingFeeAmount: string | null
  maintenanceMarkupPct: string | null
  status: 'active' | 'inactive' | 'deprecated'
}

const FEE_TYPES = [
  'percent_of_rent', 'flat_monthly', 'percent_with_floor',
  'percent_with_ceiling', 'per_unit', 'leasing_fee', 'maintenance_markup_pct',
] as const

function PlanModal({ pmCompanyId, onClose }: { pmCompanyId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [feeType, setFeeType] = useState<typeof FEE_TYPES[number]>('percent_of_rent')
  const [percent, setPercent] = useState('')
  const [flatAmount, setFlatAmount] = useState('')
  const [floorAmount, setFloorAmount] = useState('')
  const [ceilingAmount, setCeilingAmount] = useState('')
  const [leasingFeeAmount, setLeasingFeeAmount] = useState('')
  const [maintenanceMarkupPct, setMaintenanceMarkupPct] = useState('')

  const saveMut = useMutation(
    () => apiPost(`/pm/companies/${pmCompanyId}/fee-plans`, {
      name,
      feeType: feeType,
      percent: percent ? parseFloat(percent) : null,
      flatAmount: flatAmount ? parseFloat(flatAmount) : null,
      floorAmount: floorAmount ? parseFloat(floorAmount) : null,
      ceilingAmount: ceilingAmount ? parseFloat(ceilingAmount) : null,
      leasingFeeAmount: leasingFeeAmount ? parseFloat(leasingFeeAmount) : null,
      maintenanceMarkupPct: maintenanceMarkupPct ? parseFloat(maintenanceMarkupPct) : null,
    }),
    { onSuccess: () => { qc.invalidateQueries(['fee-plans', pmCompanyId]); onClose() } },
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 540 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div className="modal-title" style={{ marginBottom: 0 }}>Create Fee Plan</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={15} /></button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Plan name *</label>
          <input className="input" value={name} onChange={e => setName(e.target.value)}
                 placeholder="e.g. Standard 8%" style={{ width: '100%' }} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Fee type *</label>
          <select className="input" value={feeType} onChange={e => setFeeType(e.target.value as any)} style={{ width: '100%' }}>
            {FEE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        {(feeType === 'percent_of_rent' || feeType === 'percent_with_floor' || feeType === 'percent_with_ceiling') && (
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Percent (0–100)</label>
            <input className="input" type="number" min="0" max="100" step="0.01" value={percent}
                   onChange={e => setPercent(e.target.value)} style={{ width: '100%' }} />
          </div>
        )}
        {feeType === 'flat_monthly' && (
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Flat monthly amount ($)</label>
            <input className="input" type="number" min="0" step="0.01" value={flatAmount}
                   onChange={e => setFlatAmount(e.target.value)} style={{ width: '100%' }} />
          </div>
        )}
        {feeType === 'per_unit' && (
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Amount per unit ($)</label>
            <input className="input" type="number" min="0" step="0.01" value={flatAmount}
                   onChange={e => setFlatAmount(e.target.value)} style={{ width: '100%' }} />
          </div>
        )}
        {feeType === 'percent_with_floor' && (
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Floor amount ($)</label>
            <input className="input" type="number" min="0" step="0.01" value={floorAmount}
                   onChange={e => setFloorAmount(e.target.value)} style={{ width: '100%' }} />
          </div>
        )}
        {feeType === 'percent_with_ceiling' && (
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Ceiling amount ($)</label>
            <input className="input" type="number" min="0" step="0.01" value={ceilingAmount}
                   onChange={e => setCeilingAmount(e.target.value)} style={{ width: '100%' }} />
          </div>
        )}
        {feeType === 'leasing_fee' && (
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Leasing fee per signed lease ($)</label>
            <input className="input" type="number" min="0" step="0.01" value={leasingFeeAmount}
                   onChange={e => setLeasingFeeAmount(e.target.value)} style={{ width: '100%' }} />
          </div>
        )}
        {feeType === 'maintenance_markup_pct' && (
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Maintenance markup (%, 0–100)</label>
            <input className="input" type="number" min="0" max="100" step="0.1" value={maintenanceMarkupPct}
                   onChange={e => setMaintenanceMarkupPct(e.target.value)} style={{ width: '100%' }} />
          </div>
        )}

        {saveMut.isError && (
          <div style={{ padding: 8, background: 'rgba(220,76,76,.1)', borderRadius: 6, fontSize: '.74rem', color: 'var(--red, #dc4c4c)', marginBottom: 12 }}>
            {(saveMut.error as any)?.response?.data?.error?.message || 'Save failed.'}
          </div>
        )}

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!name || saveMut.isLoading} onClick={() => saveMut.mutate()}>
            {saveMut.isLoading ? 'Saving…' : 'Create Plan'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function FeePlansPage() {
  const { activePmCompany } = useAuth()
  const cid = activePmCompany?.id
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)

  const plansQ = useQuery<FeePlan[]>(
    ['fee-plans', cid],
    () => apiGet<FeePlan[]>(`/pm/companies/${cid}/fee-plans`),
    { enabled: !!cid },
  )

  const deprecateMut = useMutation(
    (planId: string) => apiPatch(`/pm/companies/${cid}/fee-plans/${planId}`, { status: 'deprecated' }),
    { onSuccess: () => qc.invalidateQueries(['fee-plans', cid]) },
  )

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.4rem', color: 'var(--text-0)' }}>Fee Plans</h1>
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
            Rate sheets you offer to landlords.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
          <Plus size={14} style={{ marginRight: 6 }} /> New Plan
        </button>
      </div>

      {plansQ.isLoading && <div style={{ color: 'var(--text-3)' }}>Loading…</div>}

      {(plansQ.data ?? []).length === 0 && !plansQ.isLoading && (
        <div className="card" style={{ padding: 16, color: 'var(--text-3)', fontSize: '.88rem' }}>
          No fee plans yet. Add one to start offering management contracts.
        </div>
      )}

      {(plansQ.data ?? []).length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-2)' }}>
                <Th>Name</Th><Th>Type</Th><Th>%</Th><Th>Flat</Th><Th>Floor</Th><Th>Ceiling</Th><Th>Status</Th><Th>{' '}</Th>
              </tr>
            </thead>
            <tbody>
              {(plansQ.data ?? []).map(p => (
                <tr key={p.id} style={{ borderTop: '1px solid var(--border-0)' }}>
                  <Td><strong>{p.name}</strong></Td>
                  <Td style={{ color: 'var(--text-3)' }}>{p.feeType}</Td>
                  <Td>{p.percent ?? '—'}</Td>
                  <Td>{p.flatAmount ?? '—'}</Td>
                  <Td>{p.floorAmount ?? '—'}</Td>
                  <Td>{p.ceilingAmount ?? '—'}</Td>
                  <Td><span style={{ padding: '2px 8px', borderRadius: 12, fontSize: '.68rem', background: p.status === 'active' ? 'rgba(38,167,90,.16)' : 'rgba(160,160,160,.16)', color: p.status === 'active' ? 'var(--green, #2ea35a)' : 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{p.status}</span></Td>
                  <Td>
                    {p.status === 'active' && (
                      <button className="btn btn-ghost btn-sm"
                              disabled={deprecateMut.isLoading}
                              onClick={() => {
                                if (window.confirm(`Deprecate "${p.name}"? It can no longer be selected on new invitations, but existing linkages remain.`)) {
                                  deprecateMut.mutate(p.id)
                                }
                              }}>
                        Deprecate
                      </button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && cid && <PlanModal pmCompanyId={cid} onClose={() => setShowAdd(false)} />}
    </div>
  )
}

const lbl: React.CSSProperties = {
  fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)',
  textTransform: 'uppercase', letterSpacing: '.06em',
  display: 'block', marginBottom: 5,
}
const Th = ({ children }: { children: React.ReactNode }) => (
  <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)', fontWeight: 600 }}>{children}</th>
)
const Td = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <td style={{ padding: '12px 14px', fontSize: '.84rem', color: 'var(--text-1)', ...style }}>{children}</td>
)
