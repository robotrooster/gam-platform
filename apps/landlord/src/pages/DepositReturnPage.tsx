import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Plus, Trash2, AlertTriangle, CheckCircle2, DollarSign } from 'lucide-react'
import { apiGet, apiPost, apiPatch } from '../lib/api'

type DeductionCategory = 'cleaning_extra' | 'damage' | 'utility' | 'unpaid_rent' | 'other'
type DeductionLine = { description: string; amount: number; category: DeductionCategory }

type UnpaidBalanceLine = {
  paymentId:        string
  type:              string  // 'rent' | 'utility' | 'late_fee' | 'fee'
  amount:            number
  dueDate:          string
  entryDescription: string
  status:            'pending' | 'failed'
}

type DepositReturnState = {
  id?: string
  preview?: boolean
  totalDeposit: number
  interestAccrued: number  // S188: statutory interest tenant is owed
  cleaningFeeAmount: number
  unpaidBalanceAmount: number
  unpaidBalanceLines: UnpaidBalanceLine[]
  damageLines: DeductionLine[]
  otherDeductions: DeductionLine[]
  totalDeductions: number
  refundAmount: number
  gapAmount: number
  status?: string
  finalizedAt?: string | null
  refundPaymentId?: string | null
  gapPaymentId?: string | null
  gapChargeFailed?: boolean
  gapChargeFailureReason?: string | null
  notes?: string | null
}

const CATEGORY_LABEL: Record<DeductionCategory, string> = {
  cleaning_extra: 'Cleaning (extra)',
  damage:         'Damage',
  utility:        'Utility',
  unpaid_rent:    'Unpaid rent',
  other:          'Other',
}

const UNPAID_TYPE_LABEL: Record<string, string> = {
  rent:     'Rent',
  utility:  'Utility',
  late_fee: 'Late fee',
  fee:      'Fee',
}

const fmt = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function DepositReturnPage() {
  const { id: leaseId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [draftLines, setDraftLines] = useState<DeductionLine[]>([])
  const [notes, setNotes] = useState('')
  const [showFinalizeConfirm, setShowFinalizeConfirm] = useState(false)

  const { data, isLoading } = useQuery<DepositReturnState>(
    ['deposit-return', leaseId],
    async () => {
      const raw = await apiGet<any>(`/leases/${leaseId}/deposit-return`)
      // Server returns either an existing row, or { preview: true, ...calc }
      return normalize(raw)
    },
  )

  // Sync local edits from server payload when first loaded.
  useEffect(() => {
    if (!data) return
    setDraftLines(data.damageLines || [])
    setNotes(data.notes || '')
  }, [data?.id, data?.preview])

  const beginMut = useMutation(
    () => apiPost<any>(`/leases/${leaseId}/deposit-return`),
    {
      onSuccess: () => qc.invalidateQueries(['deposit-return', leaseId]),
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed to start'),
    },
  )

  const patchMut = useMutation(
    (body: { damageLines: DeductionLine[]; notes: string }) =>
      apiPatch<any>(`/leases/${leaseId}/deposit-return`, body),
    {
      onSuccess: () => qc.invalidateQueries(['deposit-return', leaseId]),
      onError: (e: any) => setError(e?.response?.data?.error || 'Failed to save'),
    },
  )

  const finalizeMut = useMutation(
    () => apiPost<any>(`/leases/${leaseId}/deposit-return/finalize`),
    {
      onSuccess: () => {
        setShowFinalizeConfirm(false)
        qc.invalidateQueries(['deposit-return', leaseId])
      },
      onError: (e: any) => setError(e?.response?.data?.error || 'Finalize failed'),
    },
  )

  if (isLoading || !data) return <div style={{ padding: 32, color: 'var(--text-3)' }}>Loading…</div>

  const totalDeposit = Number(data.totalDeposit)
  const interestAccrued = Number(data.interestAccrued || 0)
  const cleaningFee = Number(data.cleaningFeeAmount)
  const unpaidBalance = Number(data.unpaidBalanceAmount || 0)
  const unpaidLines = data.unpaidBalanceLines || []
  const lineSum = draftLines.reduce((s, l) => s + (Number(l.amount) || 0), 0)
  const totalDeductions = round2(cleaningFee + unpaidBalance + lineSum)
  // S188: tenant pool = principal + statutory interest
  const tenantPool = round2(totalDeposit + interestAccrued)
  const refund = round2(Math.max(0, tenantPool - totalDeductions))
  const gap = round2(Math.max(0, totalDeductions - tenantPool))

  const isFinalized = !!data.finalizedAt
  const isPreview = !!data.preview

  return (
    <div style={{ maxWidth: 820 }}>
      <div className="page-header">
        <div>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/leases')} style={{ marginBottom: 8 }}>
            <ArrowLeft size={14} /> Leases
          </button>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <DollarSign size={22} /> Deposit Return
          </h1>
          <div className="page-sub">
            Move-out reconciliation for lease <span style={{ fontFamily: 'var(--font-mono)' }}>{leaseId?.slice(0, 8)}…</span>
          </div>
        </div>
      </div>

      {error && (
        <div className="card" style={{ padding: 12, marginBottom: 16, background: 'rgba(239,68,68,.08)', borderColor: 'rgba(239,68,68,.3)', color: 'var(--red)' }}>
          {error}
        </div>
      )}

      {isFinalized && (
        <div className="card" style={{ padding: 16, marginBottom: 16, background: 'rgba(34,197,94,.06)', borderColor: 'rgba(34,197,94,.25)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <CheckCircle2 size={18} style={{ color: 'var(--green)' }} />
            <strong style={{ color: 'var(--green)' }}>Finalized — status: {data.status?.replace('_', ' ')}</strong>
          </div>
          <div style={{ fontSize: '.85rem', color: 'var(--text-2)' }}>
            {data.status === 'sent_refund' && `Refund of ${fmt(refund)} created. Will pay out via the next disbursement.`}
            {data.status === 'sent_gap' && (
              <>
                Tenant owes {fmt(gap)}. {data.gapChargeFailed
                  ? <span style={{ color: 'var(--amber)' }}>Auto-charge FAILED: {data.gapChargeFailureReason}. Pursue manually.</span>
                  : <span style={{ color: 'var(--green)' }}>Auto-charge submitted via on-file payment method.</span>}
              </>
            )}
            {data.status === 'sent_zero' && 'Deductions exactly equaled the deposit. No money moved.'}
          </div>
        </div>
      )}

      {/* Summary */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <Tile label="Security deposit" value={fmt(totalDeposit)} />
          {interestAccrued > 0 && (
            <Tile label="Interest accrued" value={fmt(interestAccrued)} tone="green" />
          )}
          <Tile label="Total deductions" value={fmt(totalDeductions)} />
          <Tile
            label={gap > 0 ? 'Tenant owes' : 'Refund to tenant'}
            value={fmt(gap > 0 ? gap : refund)}
            tone={gap > 0 ? 'red' : refund > 0 ? 'green' : 'muted'}
          />
        </div>
        {interestAccrued > 0 && (
          <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: 10, lineHeight: 1.5 }}>
            Statutory interest required by the property's state. Added to the refund pool — tenant gets {fmt(totalDeposit)} principal + {fmt(interestAccrued)} interest, minus deductions.
          </div>
        )}
      </div>

      {/* Cleaning fee (auto-pulled, read-only) */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>
          Cleaning fee (auto)
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ color: 'var(--text-2)', fontSize: '.9rem' }}>
            Pulled from lease_fees with due_timing=move_out
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-0)' }}>
            {fmt(cleaningFee)}
          </div>
        </div>
      </div>

      {/* Unpaid balance (auto-swept, read-only) — S182 / A1 frontend */}
      {unpaidLines.length > 0 && (
        <div className="card" style={{ padding: 0, marginBottom: 16 }}>
          <div style={{ padding: 12, borderBottom: '1px solid var(--border-0)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                Unpaid balance (auto)
              </div>
              <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 2 }}>
                Outstanding payments swept into this deposit deduction
              </div>
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-0)' }}>
              {fmt(unpaidBalance)}
            </div>
          </div>
          {unpaidLines.map((line) => (
            <div
              key={line.paymentId}
              style={{ display: 'grid', gridTemplateColumns: '110px 1fr 110px 110px', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--border-0)', alignItems: 'center', fontSize: '.85rem' }}
            >
              <span style={{
                display: 'inline-block',
                padding: '2px 8px',
                borderRadius: 999,
                fontSize: '.72rem',
                fontWeight: 600,
                background: 'rgba(212,175,55,.10)',
                color: 'var(--gold)',
                border: '1px solid rgba(212,175,55,.25)',
                textAlign: 'center',
                width: 'fit-content',
              }}>
                {UNPAID_TYPE_LABEL[line.type] ?? line.type}
              </span>
              <span style={{ color: 'var(--text-1)' }}>
                {line.entryDescription}
              </span>
              <span style={{
                display: 'inline-block',
                padding: '2px 8px',
                borderRadius: 999,
                fontSize: '.72rem',
                fontWeight: 600,
                textAlign: 'center',
                width: 'fit-content',
                background: line.status === 'failed' ? 'rgba(239,68,68,.10)' : 'rgba(245,158,11,.10)',
                color: line.status === 'failed' ? 'var(--red)' : 'var(--amber)',
                border: line.status === 'failed' ? '1px solid rgba(239,68,68,.25)' : '1px solid rgba(245,158,11,.25)',
              }}>
                {line.status === 'failed' ? 'Failed' : 'Pending'}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-0)', textAlign: 'right' }}>
                {fmt(line.amount)}
              </span>
            </div>
          ))}
          <div style={{ padding: '10px 14px', fontSize: '.78rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
            These were unpaid as of move-out and will be settled from the deposit at finalize. Mark a row as paid out-of-band on the Payments page to remove it before finalize.
          </div>
        </div>
      )}

      {/* Editable deductions list */}
      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        <div style={{ padding: 12, borderBottom: '1px solid var(--border-0)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Other deductions</strong>
          {!isFinalized && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setDraftLines([...draftLines, { description: '', amount: 0, category: 'damage' }])}
              disabled={isPreview}
            >
              <Plus size={13} /> Add line
            </button>
          )}
        </div>

        {isPreview ? (
          <div style={{ padding: 16, fontSize: '.85rem', color: 'var(--text-2)' }}>
            Click <strong>Begin Move-Out</strong> below to start a draft. You can add damage / utility / unpaid-rent / other deductions before finalizing.
          </div>
        ) : draftLines.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>
            No deductions yet beyond cleaning. Add a line if there's damage, unpaid utilities, or rent leftover.
          </div>
        ) : (
          <div>
            {draftLines.map((line, i) => (
              <div
                key={i}
                style={{ display: 'grid', gridTemplateColumns: '160px 1fr 140px 36px', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--border-0)', alignItems: 'center' }}
              >
                <select
                  value={line.category}
                  disabled={isFinalized}
                  onChange={e => {
                    const next = [...draftLines]
                    next[i] = { ...line, category: e.target.value as DeductionCategory }
                    setDraftLines(next)
                  }}
                  className="input"
                >
                  {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={line.description}
                  disabled={isFinalized}
                  placeholder="Description (e.g. Stained carpet bedroom 2)"
                  onChange={e => {
                    const next = [...draftLines]
                    next[i] = { ...line, description: e.target.value }
                    setDraftLines(next)
                  }}
                  className="input"
                />
                <input
                  type="number"
                  value={line.amount}
                  step="0.01"
                  disabled={isFinalized}
                  onChange={e => {
                    const next = [...draftLines]
                    next[i] = { ...line, amount: parseFloat(e.target.value) || 0 }
                    setDraftLines(next)
                  }}
                  className="input"
                  style={{ textAlign: 'right' }}
                />
                {!isFinalized && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setDraftLines(draftLines.filter((_, j) => j !== i))}
                    style={{ padding: 4, color: 'var(--red)' }}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Notes */}
      {!isFinalized && !isPreview && (
        <div className="card" style={{ padding: 12, marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: '.72rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
            Internal notes (optional)
          </label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            className="input"
            rows={2}
            placeholder="Context for finalize — visible in the deposit-return record"
          />
        </div>
      )}

      {/* Action row */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {isPreview && !isFinalized && (
          <button className="btn btn-primary" onClick={() => beginMut.mutate()} disabled={beginMut.isLoading}>
            {beginMut.isLoading ? 'Starting…' : 'Begin Move-Out'}
          </button>
        )}
        {!isPreview && !isFinalized && (
          <>
            <button
              className="btn btn-ghost"
              onClick={() => patchMut.mutate({ damageLines: draftLines, notes })}
              disabled={patchMut.isLoading}
            >
              {patchMut.isLoading ? 'Saving…' : 'Save draft'}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                // Save first, then finalize
                patchMut.mutate(
                  { damageLines: draftLines, notes },
                  { onSuccess: () => setShowFinalizeConfirm(true) },
                )
              }}
              disabled={patchMut.isLoading || finalizeMut.isLoading}
            >
              Review & Finalize
            </button>
          </>
        )}
      </div>

      {/* Finalize confirmation modal */}
      {showFinalizeConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setShowFinalizeConfirm(false)}>
          <div className="card" style={{ width: 460, maxWidth: '92vw' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginBottom: 12 }}>Finalize deposit return</h3>
            <div style={{ fontSize: '.88rem', color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.5 }}>
              {gap > 0 ? (
                <>
                  This will charge the tenant <strong>{fmt(gap)}</strong> via their on-file payment method. The deposit ({fmt(totalDeposit)}) is fully consumed; the tenant owes the gap.
                  <br /><br />
                  <span style={{ color: 'var(--amber)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <AlertTriangle size={13} /> If the auto-charge fails (no payment method, declined card), an admin alert will fire and you can pursue manually.
                  </span>
                </>
              ) : refund > 0 ? (
                <>
                  This will create a refund of <strong>{fmt(refund)}</strong> for the tenant. It pays out via your next disbursement.
                </>
              ) : (
                <>Deductions exactly equal the deposit. No money moves; the deposit is consumed.</>
              )}
              <br /><br />
              Once finalized, this record can only be changed via the credit-dispute flow.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setShowFinalizeConfirm(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => finalizeMut.mutate()} disabled={finalizeMut.isLoading}>
                {finalizeMut.isLoading ? 'Finalizing…' : 'Finalize'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Tile({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'red' | 'green' | 'muted' }) {
  const color = tone === 'red' ? 'var(--red)' : tone === 'green' ? 'var(--green)' : tone === 'muted' ? 'var(--text-3)' : 'var(--text-0)'
  return (
    <div style={{ padding: 12, border: '1px solid var(--border-0)', borderRadius: 8 }}>
      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.4rem', color, lineHeight: 1.1 }}>{value}</div>
    </div>
  )
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

function normalize(raw: any): DepositReturnState {
  // Server returns either a row (with `id` / `damage_lines` arrays) or
  // a preview calc (with snake_case totals + lease meta). Normalize.
  // unpaid_balance_lines is live-pulled by the GET route in both
  // branches; unpaid_balance_amount is a snapshot on the row, derived
  // from the live total in the preview branch.
  if (raw?.id) {
    return {
      ...raw,
      totalDeposit: Number(raw.totalDeposit),
      interestAccrued: Number(raw.interestAccrued ?? 0),
      cleaningFeeAmount: Number(raw.cleaningFeeAmount),
      unpaidBalanceAmount: Number(raw.unpaidBalanceAmount ?? 0),
      unpaidBalanceLines: raw.unpaidBalanceLines || [],
      totalDeductions: Number(raw.totalDeductions),
      refundAmount: Number(raw.refundAmount),
      gapAmount: Number(raw.gapAmount),
      damageLines: raw.damageLines || [],
      otherDeductions: raw.otherDeductions || [],
    }
  }
  return {
    preview: true,
    totalDeposit: Number(raw.totalDeposit ?? 0),
    interestAccrued: Number(raw.interestAccrued ?? 0),
    cleaningFeeAmount: Number(raw.cleaningFeeAmount ?? 0),
    unpaidBalanceAmount: Number(raw.unpaidBalanceTotal ?? 0),
    unpaidBalanceLines: raw.unpaidBalanceLines || [],
    totalDeductions: Number(raw.totalDeductions ?? 0),
    refundAmount: Number(raw.refundAmount ?? 0),
    gapAmount: Number(raw.gapAmount ?? 0),
    damageLines: [],
    otherDeductions: [],
  }
}
