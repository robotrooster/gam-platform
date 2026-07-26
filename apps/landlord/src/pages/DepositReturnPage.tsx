import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Plus, Trash2, AlertTriangle, CheckCircle2, DollarSign } from 'lucide-react'
import { humanize } from '@gam/shared'
import { apiGet, apiPost, apiPatch } from '../lib/api'
import { toast } from '../components/dialogs'

// W-31 (Nic decision): free-form deductions are DOCUMENTED DAMAGES only —
// description + at least one photo/receipt per line. Utilities/rent arrive
// via the automatic unpaid-balance sweep; fees via the lease's own fee rows.
type DeductionLine = { description: string; amount: number; evidenceDocumentIds: string[] }

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
  // S548: approval-threshold context from the GET route
  approvalThreshold?: number
  viewerIsOwner?: boolean
  moveOutInspectionRequired?: boolean
  moveOutInspection?: { id: string; status: string; scheduledFor?: string | null; finalizedAt?: string | null; photoCount: number } | null
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
    setDraftLines((data.damageLines || []).map((l: any) => ({ description: l.description || '', amount: l.amount || 0, evidenceDocumentIds: l.evidenceDocumentIds || [] })))
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
      onSuccess: (r: any) => {
        setShowFinalizeConfirm(false)
        qc.invalidateQueries(['deposit-return', leaseId])
        // S548: staff finalize above the landlord's threshold parks the
        // return for approval instead of paying out.
        if (r?.data?.status === 'awaiting_approval') {
          toast(`Refund of ${fmt(Number(r.data.refundAmount))} is above the ${fmt(Number(r.data.threshold))} approval threshold — sent to the landlord for approval.`)
        }
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
  // S548: approval-threshold context (owner-level viewers bypass the gate).
  const viewerIsOwner = data.viewerIsOwner !== false
  const approvalThreshold = Number(data.approvalThreshold ?? 500)
  const isAwaitingApproval = data.status === 'awaiting_approval'
  // S548: dwellings + storage need the finalized in-person walkthrough
  // before Begin Move-Out; the evidence links here for the approval review.
  const walkthrough = data.moveOutInspection ?? null
  const walkthroughDone = walkthrough?.status === 'finalized'
  const walkthroughBlocksBegin = !!data.moveOutInspectionRequired && !walkthroughDone
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

      {/* S548: move-out walkthrough state — the gate before Begin, the
          evidence link during review/approval. */}
      {data.moveOutInspectionRequired && (
        <div className="card" style={{ padding: 16, marginBottom: 16,
          background: walkthroughDone ? 'rgba(34,197,94,.05)' : 'rgba(245,158,11,.06)',
          borderColor: walkthroughDone ? 'rgba(34,197,94,.2)' : 'rgba(245,158,11,.25)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <strong style={{ color: walkthroughDone ? 'var(--green)' : 'var(--amber)' }}>
                {walkthroughDone ? 'Move-out walkthrough complete' : 'Move-out walkthrough required'}
              </strong>
              <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 4 }}>
                {walkthroughDone
                  ? `Finalized in-person inspection on file (${walkthrough!.photoCount} photo${walkthrough!.photoCount === 1 ? '' : 's'}) — review it before approving this return.`
                  : walkthrough
                  ? `In-person walkthrough scheduled — due by ${walkthrough.scheduledFor ? new Date(walkthrough.scheduledFor).toLocaleDateString() : 'the deadline'}. The deposit return can't begin until it's finalized with photos.`
                  : 'This unit type requires a finalized in-person walkthrough (with photos) before the deposit return can begin.'}
              </div>
            </div>
            {walkthrough && (
              <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/inspections/${walkthrough.id}`)}>
                {walkthroughDone ? `View walkthrough (${walkthrough.photoCount} photos)` : 'Open walkthrough'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* S548: staff-prepared return above the landlord's threshold */}
      {data.status === 'awaiting_approval' && !isFinalized && (
        <div className="card" style={{ padding: 16, marginBottom: 16, background: 'rgba(245,158,11,.06)', borderColor: 'rgba(245,158,11,.25)' }}>
          <strong style={{ color: 'var(--amber)' }}>Awaiting landlord approval</strong>
          <div style={{ fontSize: '.85rem', color: 'var(--text-2)', marginTop: 6 }}>
            This refund is above the approval threshold, so a team member can't send it alone.
            The landlord has been notified — their Finalize releases it.
          </div>
        </div>
      )}

      {isFinalized && (
        <div className="card" style={{ padding: 16, marginBottom: 16, background: 'rgba(34,197,94,.06)', borderColor: 'rgba(34,197,94,.25)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <CheckCircle2 size={18} style={{ color: 'var(--green)' }} />
            <strong style={{ color: 'var(--green)' }}>Finalized — status: {humanize(data.status)}</strong>
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

      {/* W-31: documented-damage deductions ONLY. Lease fees + the unpaid
          sweep arrive automatically; anything typed here needs proof. */}
      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        <div style={{ padding: 12, borderBottom: '1px solid var(--border-0)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <strong>Damage Deductions</strong>
            <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 2 }}>
              Damage beyond normal wear only — each line needs a description and at least one photo or receipt.
            </div>
          </div>
          {!isFinalized && !isPreview && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setDraftLines([...draftLines, { description: '', amount: 0, evidenceDocumentIds: [] }])}
            >
              <Plus size={13} /> Add Damage
            </button>
          )}
        </div>

        {isPreview ? (
          <div style={{ padding: 16, fontSize: '.85rem', color: 'var(--text-2)' }}>
            Click <strong>Begin Move-Out</strong> below to start a draft. Then you can add documented damage deductions before finalizing — unpaid rent/utilities and lease fees sweep in automatically.
          </div>
        ) : draftLines.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>
            No damage deductions. Unpaid balances and lease fees are handled automatically above.
          </div>
        ) : (
          <div>
            {draftLines.map((line, i) => (
              <div key={i} style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-0)' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px 36px', gap: 8, alignItems: 'center' }}>
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
                <DamageEvidenceRow
                  leaseId={leaseId!}
                  line={line}
                  disabled={!!isFinalized}
                  onChange={ids => {
                    const next = [...draftLines]
                    next[i] = { ...line, evidenceDocumentIds: ids }
                    setDraftLines(next)
                  }}
                />
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
          <button className="btn btn-primary" onClick={() => beginMut.mutate()}
            disabled={beginMut.isLoading || walkthroughBlocksBegin}
            title={walkthroughBlocksBegin ? 'Finalize the in-person move-out walkthrough first' : undefined}>
            {walkthroughBlocksBegin ? 'Walkthrough required first' : beginMut.isLoading ? 'Starting…' : 'Begin Move-Out'}
          </button>
        )}
        {!isPreview && !isFinalized && (
          <>
            <button
              className="btn btn-ghost"
              onClick={() => { const bad = draftLines.find(l => !l.description.trim() || !(l.amount > 0) || !l.evidenceDocumentIds.length); if (bad) { setError('Every damage line needs a description, a positive amount, and at least one photo/receipt.'); } else { setError(null); patchMut.mutate({ damageLines: draftLines, notes }) } }}
              disabled={patchMut.isLoading}
            >
              {patchMut.isLoading ? 'Saving…' : 'Save draft'}
            </button>
            {/* S548: staff can't release a parked return — the landlord's
                finalize is the approval. Staff over the threshold see the
                button as the send-for-approval action instead. */}
            {isAwaitingApproval && !viewerIsOwner ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <button className="btn btn-primary" disabled title="A refund this size needs the landlord's approval">
                  Landlord reviewing…
                </button>
              </span>
            ) : (
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
                {isAwaitingApproval && viewerIsOwner ? 'Approve & Finalize'
                  : !viewerIsOwner && refund > approvalThreshold ? 'Send to Landlord for Approval'
                  : 'Review & Finalize'}
              </button>
            )}
          </>
        )}
      </div>

      {/* Finalize confirmation modal */}
      {showFinalizeConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setShowFinalizeConfirm(false)}>
          <div className="card" style={{ width: 460, maxWidth: '92vw' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginBottom: 12 }}>Finalize Deposit Return</h3>
            <div style={{ fontSize: '.88rem', color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.5 }}>
              {gap > 0 ? (
                <>
                  This will charge the tenant <strong>{fmt(gap)}</strong> via their on-file payment method. The deposit ({fmt(totalDeposit)}) is fully consumed; the tenant owes the gap.
                  <br /><br />
                  <span style={{ color: 'var(--amber)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <AlertTriangle size={13} /> If the auto-charge fails (no payment method, declined card), an admin alert will fire and you can pursue manually.
                  </span>
                </>
              ) : refund > 0 && !viewerIsOwner && refund > approvalThreshold ? (
                <>
                  This refund of <strong>{fmt(refund)}</strong> is above the landlord's <strong>{fmt(approvalThreshold)}</strong> approval threshold.
                  Nothing pays out yet — the landlord will be notified to review and approve it.
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

// W-31: per-line evidence — photos/receipts uploaded as documents rows
// tagged to the lease, ids stored on the damage line. The server rejects a
// save when any line has no evidence.
function DamageEvidenceRow({ leaseId, line, disabled, onChange }: {
  leaseId: string; line: DeductionLine; disabled: boolean; onChange: (ids: string[]) => void
}) {
  const navigate = useNavigate()
  const [err, setErr] = useState<string | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})
  const upload = async (file: File) => {
    setErr(null)
    const API_BASE = (import.meta as any).env.VITE_API_URL || 'http://localhost:4000'
    const fd = new FormData()
    fd.append('file', file)
    fd.append('type', 'receipt')
    fd.append('name', `Damage evidence — ${line.description.trim() || file.name}`.slice(0, 200))
    fd.append('leaseId', leaseId)
    const res = await fetch(`${API_BASE}/api/documents`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('gam_token') || '') },
      body: fd,
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) { setErr(j?.error || 'Upload failed'); return }
    setNames(n => ({ ...n, [j.data.id]: j.data.name }))
    onChange([...line.evidenceDocumentIds, j.data.id])
  }
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
      {line.evidenceDocumentIds.map((id, n) => (
        <button key={id} type="button"
          onClick={() => navigate(`/view?src=${encodeURIComponent(`/documents/${id}/file`)}&title=${encodeURIComponent(names[id] || 'Evidence')}`)}
          style={{ fontSize: '.68rem', color: 'var(--gold)', background: 'rgba(201,162,39,.08)', border: '1px solid rgba(201,162,39,.2)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>
          {names[id] || `Evidence ${n + 1}`}
        </button>
      ))}
      {!disabled && (
        <label style={{ fontSize: '.68rem', color: 'var(--text-2)', border: '1px dashed var(--border-2)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>
          + Photo / receipt
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }} />
        </label>
      )}
      {!line.evidenceDocumentIds.length && !disabled && (
        <span style={{ fontSize: '.66rem', color: 'var(--amber)' }}>Documentation required before saving</span>
      )}
      {err && <span style={{ fontSize: '.66rem', color: 'var(--red)' }}>{err}</span>}
    </div>
  )
}
