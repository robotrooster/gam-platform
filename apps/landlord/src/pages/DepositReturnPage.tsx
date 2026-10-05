import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Plus, Trash2, AlertTriangle, CheckCircle2, DollarSign } from 'lucide-react'
import { UTILITY_TYPE_LABEL, PAID_AHEAD_REFUND_CHOICE_LABEL, PAID_AHEAD_REST_CHOICE_LABEL, type UtilityType } from '@gam/shared'
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

type FinalUtilityLine = { billId: string; utilityType: string; amount: number; cycle: string }

type ClosedLine = { paymentId: string; kind: 'deposit' | 'prepaid'; label: string; amount: number }

// What a closed line was (closed_at_move_out_lines.kind), in plain words.
const CLOSED_LINE_KIND_LABEL: Record<ClosedLine['kind'], string> = {
  deposit: 'Deposit — never paid',
  prepaid: 'Last month\'s rent due up front — never paid',
}

// Step 9 (final fix): every money figure on this page is the SERVER's — the
// one move-out calculation finalize itself uses (routes/leases.ts
// depositReturnFigures). The page never adds up a refund of its own: which
// money the deductions draw on (deposit or paid-ahead) and what is left of the
// paid-ahead money are the server's rule, so "deposit + interest − deductions"
// here confirmed one figure while finalize paid another.
type DepositReturnState = {
  id?: string
  preview?: boolean
  totalDeposit: number
  interestAccrued: number          // deposit interest still owed (not yet credited)
  depositInterestCredited: number  // interest already credited, never spent — refunded with the deposit
  prepaidCreditUsed: number        // the part of the tenant's paid-ahead money that paid what the deposit didn't cover (#46.2)
  prepaidCreditLeft: number        // paid-ahead money left over — stays on the lease for the landlord's choice (#46.1)
  // How each part of the refund comes back (decisions #46.3, #47c): the part
  // paid online goes back the way it was paid; the part paid at the office or
  // into the landlord's bank is handed back at the office. null on a return
  // finalized before this was recorded.
  refundFromGam: number | null
  refundFromLandlord: number | null
  // Unpaid deposits and up-front rent paid ahead finalize closes as no longer
  // owed (decision #46.4) — never deducted.
  closedAtMoveOutLines: ClosedLine[]
  closedAtMoveOutTotal: number
  cleaningFeeAmount: number
  unpaidBalanceAmount: number
  unpaidBalanceLines: UnpaidBalanceLine[]
  finalUtilityLines: FinalUtilityLine[]
  finalUtilityTotal: number
  damageLinesTotal: number
  otherDeductionsTotal: number
  damageLines: DeductionLine[]
  totalDeductions: number
  refundAmount: number
  gapAmount: number
  status?: string
  finalizedAt?: string | null
  gapChargeFailed?: boolean
  gapChargeFailureReason?: string | null
  notes?: string | null
  // S548: approval-threshold context from the GET route
  approvalThreshold?: number
  viewerIsOwner?: boolean
  // Fix pass 3: the landlord themselves ("your payout", "you hand it back");
  // GAM staff and team members read "the landlord's". Approval stays viewerIsOwner.
  viewerIsLandlord?: boolean
  moveOutInspectionRequired?: boolean
  moveOutInspection?: { id: string; status: string; scheduledFor?: string | null; finalizedAt?: string | null; photoCount: number } | null
  // Who this is, by name — the household and the space.
  household?: { tenantNames: string[]; unitNumber: string | null; propertyName: string | null } | null
  // Whether this viewer may make the paid-ahead choice ("Issue refunds").
  viewerCanDecidePaidAhead?: boolean
  // Whether this viewer may run this move-out at all — Begin, save, finalize
  // ("Deposit return" and the property in their scope). Missing = yes.
  viewerCanRunMoveOut?: boolean
  // The landlord's paid-ahead choice once it is made (decisions #46.1 / #46.1a).
  paidAheadChoice?: PaidAheadChoiceMade | null
  // decisions #48.6: a payment on the tenancy still clearing (what, and the day
  // it should clear) — finalize waits for it. null when nothing is clearing.
  paymentsClearing?: string | null
  // Each damage line's photo or receipt by name.
  damageEvidence?: Array<{ id: string; name: string }>
  // decisions #47a: a finalized refund going back — each part GAM sends and
  // the landlord's own part (null before finalize, or with no refund).
  refundProgress?: RefundProgressView | null
}

/** One part of the refund GAM sends back (services/depositRefundSend.partView). */
type RefundPartView = {
  id: string; kind: string; label: string; amount: number; status: string; words: string
  canTryAgain: boolean; canGiveInCash: boolean; done: boolean
}
type RefundProgressView = {
  parts: RefundPartView[]
  openAmount: number
  landlordPart: null | { amount: number; handedBackOn: string | null; handedBackByName: string | null }
  reachWords: string
}

type PaidAheadChoiceMade = {
  refundChoice: string; refundTotal: number; restChoice: 'keep' | 'credit' | null; restAmount: number
  decidedAt: string; decidedByName: string | null
}

const UNPAID_TYPE_LABEL: Record<string, string> = {
  rent:     'Rent',
  utility:  'Utility',
  late_fee: 'Late fee',
  fee:      'Fee',
}

// What a finished return did, in plain words (deposit_returns.status).
const FINALIZED_STATUS_LABEL: Record<string, string> = {
  sent_refund:          'Refund recorded',
  sent_gap:             'The tenant owes the rest',
  sent_zero:            'Nothing owed either way',
  sent_carried_forward: 'Deposit carried to the tenant\'s next lease',
  disputed:             'Under dispute',
}

const fmt = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const errText = (e: any, fallback: string) => e?.response?.data?.error || fallback

/**
 * Why the page could not load, in plain words with the next step (deposit-page
 * review, fix pass 3). A 403 or 404 never goes away by trying again, so those
 * offer only the way back; anything else offers Try again.
 */
export function loadFailure(e: any): { message: string; canRetry: boolean } {
  const status = e?.response?.status
  const said: string = e?.response?.data?.error || ''
  if (status === 403) {
    // The server's own plain words for a property this team member isn't assigned to.
    if (said.startsWith('You are not assigned')) return { message: said, canRetry: false }
    // A bare 403 here means this lease is not on the viewer's account at all
    // (the page itself needs no permission to read) — asking for access would
    // not help.
    return { message: 'This move-out isn\'t on your account. Go back to Leases and open it from there.', canRetry: false }
  }
  if (status === 404) return { message: 'This lease is no longer on the account.', canRetry: false }
  return { message: errText(e, 'The deposit return could not be loaded.'), canRetry: true }
}

/** The damage lines as the server saved them, for "unsaved changes". */
const sameLines = (a: DeductionLine[], b: DeductionLine[]) =>
  JSON.stringify(a.map(l => [l.description, Number(l.amount) || 0, l.evidenceDocumentIds]))
    === JSON.stringify(b.map(l => [l.description, Number(l.amount) || 0, l.evidenceDocumentIds]))

export function DepositReturnPage() {
  const { id: leaseId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [draftLines, setDraftLines] = useState<DeductionLine[]>([])
  const [notes, setNotes] = useState('')
  const [showFinalizeConfirm, setShowFinalizeConfirm] = useState(false)
  const [preparing, setPreparing] = useState(false)
  // Fix pass 1 (final fix): an error is shown where the person will see it —
  // the banner is at the top of the page, the buttons at the bottom.
  const errorRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!error || !errorRef.current) return
    errorRef.current.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
    errorRef.current.focus?.({ preventScroll: true })
  }, [error])

  // Fix pass 2 (review): a press while a payment is still clearing reads
  // the figures again and stops — said visibly at the note (the time it was
  // checked), focused and scrolled to, so a second press is never a press
  // where nothing seems to happen.
  const [clearingCheckedAt, setClearingCheckedAt] = useState<string | null>(null)
  const clearingRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!clearingCheckedAt || !clearingRef.current) return
    clearingRef.current.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
    clearingRef.current.focus?.({ preventScroll: true })
  }, [clearingCheckedAt])

  const queryKey = ['deposit-return', leaseId]
  const { data, isLoading, isError, error: loadError, refetch } = useQuery<DepositReturnState>(
    queryKey,
    async () => normalize(await apiGet<any>(`/leases/${leaseId}/deposit-return`)),
    { retry: false },
  )

  // Sync local edits from server payload when first loaded.
  useEffect(() => {
    if (!data) return
    setDraftLines((data.damageLines || []).map((l: any) => ({ description: l.description || '', amount: l.amount || 0, evidenceDocumentIds: l.evidenceDocumentIds || [] })))
    setNotes(data.notes || '')
  }, [data?.id, data?.preview])

  // Fresh figures at the moment of action: the answer replaces what the page
  // showed, and the page renders from it.
  const loadFresh = async (): Promise<DepositReturnState> => {
    const fresh = normalize(await apiGet<any>(`/leases/${leaseId}/deposit-return`))
    qc.setQueryData(queryKey, fresh)
    return fresh
  }

  const beginMut = useMutation(
    () => apiPost<any>(`/leases/${leaseId}/deposit-return`),
    {
      onSuccess: () => { setError(null); qc.invalidateQueries(queryKey) },
      onError: (e: any) => { setError(errText(e, 'The move-out could not be started. Try again.')); qc.invalidateQueries(queryKey) },
    },
  )

  const patchMut = useMutation(
    (body: { damageLines: DeductionLine[]; notes: string }) =>
      apiPatch<any>(`/leases/${leaseId}/deposit-return`, body),
  )

  // The confirm's figures go with the finalize; if the server's figures moved
  // since, it refuses with a 409 and the page reads them again in place.
  const finalizeMut = useMutation(
    (expected: {
      expectedRefund: number; expectedGap: number; expectedPaidAheadUsed: number
      expectedRefundFromGam?: number; expectedRefundFromLandlord?: number
    }) =>
      apiPost<any>(`/leases/${leaseId}/deposit-return/finalize`, expected),
    {
      onSuccess: (r: any) => {
        setShowFinalizeConfirm(false)
        setError(null)
        qc.invalidateQueries(queryKey)
        // S548: staff finalize above the landlord's threshold parks the
        // return for approval instead of paying out.
        if (r?.data?.status === 'awaiting_approval') {
          toast(`The refund of ${fmt(Number(r.data.refundAmount))} is above the ${fmt(Number(r.data.threshold))} approval limit, so it was sent to the landlord to approve.`)
        }
      },
      onError: (e: any) => {
        // Said once, with the page refreshed in place (a 409 means the return
        // changed under us — finalized by someone else, a payment still
        // clearing, money still held).
        setShowFinalizeConfirm(false)
        setError(errText(e, 'The deposit return could not be finalized. Nothing was paid out. Try again.'))
        qc.invalidateQueries(queryKey)
      },
    },
  )

  // Fix pass 1 (final fix): the owner's way back out of a return a team
  // member sent for approval — back to a draft they can change.
  const sendBackMut = useMutation(
    () => apiPost<any>(`/leases/${leaseId}/deposit-return/send-back`),
    {
      onSuccess: async () => {
        setError(null)
        toast('Sent back to draft — you can change it now.')
        try { await loadFresh() } catch { qc.invalidateQueries(queryKey) }
      },
      onError: (e: any) => {
        setError(errText(e, 'It could not be sent back to draft. Nothing changed. Try again.'))
        qc.invalidateQueries(queryKey)
      },
    },
  )

  if (isLoading) return <div style={{ padding: 32, color: 'var(--text-3)' }}>Loading…</div>
  if (isError || !data) {
    const failure = loadFailure(loadError)
    return (
      <div style={{ padding: 32 }}>
        <div role="alert" style={{ color: 'var(--red)', marginBottom: 12 }}>
          {failure.message}
        </div>
        {failure.canRetry
          ? <button className="btn btn-primary" onClick={() => refetch()}>Try again</button>
          : <button className="btn btn-ghost" onClick={() => navigate('/leases')}>Back to Leases</button>}
      </div>
    )
  }

  const totalDeposit = Number(data.totalDeposit)
  const interestOwed = Number(data.interestAccrued || 0)
  const interestCredited = Number(data.depositInterestCredited || 0)
  const paidAheadUsed = Number(data.prepaidCreditUsed || 0)
  const paidAheadLeft = Number(data.prepaidCreditLeft || 0)
  const cleaningFee = Number(data.cleaningFeeAmount || 0)
  const unpaidBalance = Number(data.unpaidBalanceAmount || 0)
  const unpaidLines = data.unpaidBalanceLines || []
  const finalUtilityLines = data.finalUtilityLines || []
  const totalDeductions = Number(data.totalDeductions || 0)
  const refund = Number(data.refundAmount || 0)
  const gap = Number(data.gapAmount || 0)
  const refundFromGam = data.refundFromGam
  const refundFromLandlord = data.refundFromLandlord
  const closedLines = data.closedAtMoveOutLines || []
  const paidAheadChoicePath = `/leases/${leaseId}/paid-ahead-choice`

  const isFinalized = !!data.finalizedAt
  // S548: approval-threshold context (owner-level viewers bypass the gate).
  const viewerIsOwner = data.viewerIsOwner !== false
  // Whose payout / who hands the landlord's part back, in words (fix pass 3).
  const viewerIsLandlord = data.viewerIsLandlord ?? viewerIsOwner
  // The paid-ahead choice page lets through only "Issue refunds"; anyone else
  // is told the landlord chooses (never a button that ends in an error).
  const canDecidePaidAhead = data.viewerCanDecidePaidAhead ?? viewerIsOwner
  const who = whoWords(data.household)
  const approvalThreshold = Number(data.approvalThreshold ?? 500)
  const isAwaitingApproval = data.status === 'awaiting_approval'
  // The approval limit is judged on the refund finalize will pay (the server's).
  const needsApproval = !viewerIsOwner && refund > approvalThreshold
  // S548: dwellings + storage need the finalized in-person walkthrough
  // before Begin Move-Out; the evidence links here for the approval review.
  const walkthrough = data.moveOutInspection ?? null
  const walkthroughDone = walkthrough?.status === 'finalized'
  const walkthroughBlocksBegin = !!data.moveOutInspectionRequired && !walkthroughDone
  const isPreview = !!data.preview
  // Who may run this move-out at all (Begin, save, finalize). Someone who may
  // only read it is told who can, and is offered no button that would refuse.
  const canRun = data.viewerCanRunMoveOut !== false
  // Only a draft is edited; one waiting for approval is locked as staff sent it.
  const editable = canRun && !isPreview && !isFinalized && !isAwaitingApproval
  const choiceMade = data.paidAheadChoice ?? null
  const evidenceNames = Object.fromEntries((data.damageEvidence ?? []).map((d) => [d.id, d.name]))
  const unsaved = editable && (!sameLines(draftLines, data.damageLines || []) || notes !== (data.notes || ''))

  const badLine = () => draftLines.find(l => !l.description.trim() || !(l.amount > 0) || !l.evidenceDocumentIds.length)
  const BAD_LINE = 'Every damage line needs a description, an amount above $0 and at least one photo or receipt.'

  const saveDraft = async () => {
    setError(null)
    if (badLine()) { setError(BAD_LINE); return }
    try {
      await patchMut.mutateAsync({ damageLines: draftLines, notes })
      await loadFresh()
    } catch (e: any) {
      setError(errText(e, 'The draft could not be saved. Try again.'))
      qc.invalidateQueries(queryKey)
    }
  }

  // Save (a draft), then read the figures fresh, then ask — the confirm shows
  // exactly what finalize will pay.
  const reviewAndFinalize = async () => {
    setError(null)
    if (editable && badLine()) { setError(BAD_LINE); return }
    setPreparing(true)
    try {
      if (editable) await patchMut.mutateAsync({ damageLines: draftLines, notes })
      const fresh = await loadFresh()
      if (fresh.finalizedAt) { setError('This deposit return was already finalized. The page now shows what it paid.'); return }
      // decisions #48.6: a payment still clearing — the fresh read now shows
      // it (once, in the note above the buttons); no confirm opens for a
      // finalize that would be refused.
      if (fresh.paymentsClearing) {
        setClearingCheckedAt(new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))
        return
      }
      setClearingCheckedAt(null)
      setShowFinalizeConfirm(true)
    } catch (e: any) {
      setError(errText(e, 'The draft could not be saved, so nothing was finalized. Try again.'))
      qc.invalidateQueries(queryKey)
    } finally {
      setPreparing(false)
    }
  }

  const finalizeLabel = isAwaitingApproval && viewerIsOwner ? 'Approve & Finalize'
    : needsApproval ? 'Send to Landlord for Approval'
    : 'Review & Finalize'

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
          <div className="page-sub" data-testid="who">
            Move-out for {who}
          </div>
        </div>
      </div>

      {/* Each error once: a finalize refused because a payment is still
          clearing is said by the note above the buttons (the fresh read). */}
      {error && error !== data.paymentsClearing && (
        <div ref={errorRef} tabIndex={-1} role="alert" className="card" style={{ padding: 12, marginBottom: 16, background: 'rgba(239,68,68,.08)', borderColor: 'rgba(239,68,68,.3)', color: 'var(--red)' }}>
          {error}
        </div>
      )}

      {!canRun && !isFinalized && (
        <div data-testid="cannot-run" className="card" style={{ padding: 12, marginBottom: 16, fontSize: '.85rem', color: 'var(--text-2)' }}>
          You can look at this move-out, but only someone with Deposit return access to this property can begin, change or finalize it. Ask the landlord if you need that access.
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
      {isAwaitingApproval && !isFinalized && (
        <div className="card" style={{ padding: 16, marginBottom: 16, background: 'rgba(245,158,11,.06)', borderColor: 'rgba(245,158,11,.25)' }}>
          <strong style={{ color: 'var(--amber)' }}>{viewerIsOwner ? 'Waiting for your approval' : 'Awaiting landlord approval'}</strong>
          <div data-testid="awaiting-approval" style={{ fontSize: '.85rem', color: 'var(--text-2)', marginTop: 6 }}>
            {viewerIsOwner
              ? 'A team member prepared this refund. It is above your approval limit — review it and press Approve & Finalize, or Send back to draft to change it.'
              : <>This refund is above the approval limit, so a team member can't send it alone.
                {' '}The landlord has been notified — their Finalize releases it.</>}
          </div>
        </div>
      )}

      {isFinalized && (
        <div className="card" style={{ padding: 16, marginBottom: 16, background: 'rgba(34,197,94,.06)', borderColor: 'rgba(34,197,94,.25)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <CheckCircle2 size={18} style={{ color: 'var(--green)' }} />
            <strong style={{ color: 'var(--green)' }}>Finalized — {FINALIZED_STATUS_LABEL[data.status ?? ''] ?? 'done'}</strong>
          </div>
          <div style={{ fontSize: '.85rem', color: 'var(--text-2)' }}>
            {data.status === 'sent_refund' && (data.refundProgress?.reachWords
              ? <>A refund of {fmt(refund)} to the tenant: {data.refundProgress.reachWords}</>
              : <>A refund of {fmt(refund)} to the tenant was recorded. {refundWho(refundFromGam, refundFromLandlord, viewerIsLandlord)}</>)}
            {data.status === 'sent_gap' && (
              <>
                The tenant owes {fmt(gap)}. {data.gapChargeFailed
                  ? <span style={{ color: 'var(--amber)' }}>The charge to their saved payment method didn't go through: {data.gapChargeFailureReason}. Collect it another way.</span>
                  : <span style={{ color: 'var(--green)' }}>It was charged to their saved payment method.</span>}
              </>
            )}
            {data.status === 'sent_zero' && <>The deductions used the whole deposit{paidAheadUsed > 0 ? ' and the money paid ahead they needed' : ''}. Nothing is refunded and the tenant owes nothing more.</>}
          </div>
          {closedLines.length > 0 && (
            <div data-testid="finalized-closed-lines" style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 10, lineHeight: 1.5 }}>
              Closed at $0 as no longer owed — the tenant never paid {closedLines.length === 1 ? 'it' : 'them'}:
              {closedLines.map((l) => (
                <div key={l.paymentId} style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: 14 }}>
                  <span>{l.label} · {CLOSED_LINE_KIND_LABEL[l.kind] ?? 'Not owed'}</span>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{fmt(Number(l.amount))}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* decisions #47a: the refund going back — each part, and the landlord's own part. */}
      {isFinalized && data.status === 'sent_refund' && data.refundProgress
        && (data.refundProgress.parts.length > 0 || !!data.refundProgress.landlordPart) && (
        <RefundProgress
          leaseId={leaseId!}
          progress={data.refundProgress}
          canRun={canRun}
          viewerIsOwner={viewerIsLandlord}
          onChanged={async () => { try { await loadFresh() } catch { qc.invalidateQueries(queryKey) } }}
        />
      )}

      {/* Summary — the server's figures */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <Tile label="Deposits held" value={fmt(totalDeposit)} />
          <Tile label="Total deductions" value={fmt(totalDeductions)} />
          {paidAheadUsed > 0 && (
            <Tile label="Paid ahead, used for what the deposit didn't cover" value={fmt(paidAheadUsed)} />
          )}
          <Tile
            label={gap > 0 ? 'Tenant owes' : 'Refund to tenant'}
            value={fmt(gap > 0 ? gap : refund)}
            tone={gap > 0 ? 'red' : refund > 0 ? 'green' : 'muted'}
          />
        </div>
        <MoneyBreakdown
          finalized={isFinalized}
          totalDeposit={totalDeposit}
          interestOwed={interestOwed}
          interestCredited={interestCredited}
          cleaningFee={cleaningFee}
          unpaidBalance={unpaidBalance}
          finalUtilities={Number(data.finalUtilityTotal || 0)}
          damage={Number(data.damageLinesTotal || 0)}
          other={Number(data.otherDeductionsTotal || 0)}
          totalDeductions={totalDeductions}
          paidAheadUsed={paidAheadUsed}
          refund={refund}
          gap={gap}
        />
        {!isFinalized && refund > 0 && gap === 0 && (refundFromGam ?? 0) + (refundFromLandlord ?? 0) > 0 && (
          <div data-testid="refund-who" style={{ fontSize: '.8rem', color: 'var(--text-2)', marginTop: 10, lineHeight: 1.5 }}>
            {refundWho(refundFromGam, refundFromLandlord, viewerIsLandlord)}
          </div>
        )}
        {paidAheadLeft > 0 && (
          <div data-testid="paid-ahead-left" style={{ fontSize: '.8rem', color: 'var(--text-2)', marginTop: 10, lineHeight: 1.5 }}>
            {isFinalized
              ? <>{fmt(paidAheadLeft)} the tenant paid ahead is still on this lease. It was not refunded with the deposit — it waits for {canDecidePaidAhead ? 'your' : 'the landlord\'s'} choice: refund it, keep it, or leave it as their credit.</>
              : <>{fmt(paidAheadLeft)} the tenant paid ahead is left over — money paid ahead is used only for what the deposit didn't cover{paidAheadUsed > 0 ? '' : ', and the deposit covered it all'}. It is not part of the deposit refund: it stays on this lease. After this is finalized, {canDecidePaidAhead ? 'you choose' : 'the landlord chooses'} what happens to it — refund it, keep it, or leave it as their credit.</>}
            {isFinalized && canDecidePaidAhead && (
              <>
                {' '}
                <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: 6 }}
                  onClick={() => navigate(paidAheadChoicePath)}>
                  Choose what happens to it
                </button>
              </>
            )}
          </div>
        )}
        {choiceMade && (
          <div data-testid="paid-ahead-decided" style={{ fontSize: '.8rem', color: 'var(--text-2)', marginTop: 10, lineHeight: 1.5 }}>
            {paidAheadDecidedWords(choiceMade)}
          </div>
        )}
        {(interestOwed > 0 || interestCredited > 0) && (
          <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: 10, lineHeight: 1.5 }}>
            Deposit interest the property's state requires. It goes back to the tenant with the deposit.
          </div>
        )}
        {unsaved && (
          <div data-testid="unsaved-note" style={{ fontSize: '.8rem', color: 'var(--amber)', marginTop: 10 }}>
            You changed the damage lines or notes. These figures are from the last save — Save draft to see the new refund.
          </div>
        )}
      </div>

      {/* Decision #46.4: never-paid deposits and up-front rent paid ahead are
          closed as no longer owed at finalize — listed, never deducted. */}
      {!isFinalized && closedLines.length > 0 && (
        <div data-testid="closed-lines" className="card" style={{ padding: 0, marginBottom: 16 }}>
          <div style={{ padding: 12, borderBottom: '1px solid var(--border-0)' }}>
            <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
              No longer owed
            </div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 2, lineHeight: 1.5 }}>
              The tenant never paid these, so finalizing closes them at $0 — they are not taken from the deposit. A deposit is only ever refunded. A last month's rent due up front is not owed either: the months it was for are billed as ordinary rent.
            </div>
          </div>
          {closedLines.map((l) => (
            <div key={l.paymentId} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border-0)', fontSize: '.85rem' }}>
              <span style={{ color: 'var(--text-1)' }}>{l.label} · {CLOSED_LINE_KIND_LABEL[l.kind] ?? 'Not owed'}</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>{fmt(Number(l.amount))}</span>
            </div>
          ))}
        </div>
      )}

      {/* Move-out fees from the lease (read-only) */}
      {!isFinalized && cleaningFee > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>
            Move-out fees from the lease
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ color: 'var(--text-2)', fontSize: '.9rem' }}>
              Fees the lease charges at move-out (cleaning, ending early and other move-out fees)
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-0)' }}>
              {fmt(cleaningFee)}
            </div>
          </div>
        </div>
      )}

      {/* Final utility bills (read-only) — never on a bill yet; settled from the deposit */}
      {!isFinalized && finalUtilityLines.length > 0 && (
        <div className="card" style={{ padding: 0, marginBottom: 16 }}>
          <div style={{ padding: 12, borderBottom: '1px solid var(--border-0)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                Final utility bills
              </div>
              <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 2 }}>
                The last meter readings, not on a bill yet — paid from the deposit
              </div>
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-0)' }}>
              {fmt(Number(data.finalUtilityTotal || 0))}
            </div>
          </div>
          {finalUtilityLines.map((u) => (
            <div key={u.billId} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border-0)', fontSize: '.85rem' }}>
              <span style={{ color: 'var(--text-1)' }}>
                {UTILITY_TYPE_LABEL[u.utilityType as UtilityType] ?? 'Utility'} · {monthLabel(u.cycle)}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-0)' }}>{fmt(Number(u.amount))}</span>
            </div>
          ))}
        </div>
      )}

      {/* Unpaid balance (auto-swept, read-only) — S182 / A1 frontend */}
      {unpaidLines.length > 0 && (
        <div className="card" style={{ padding: 0, marginBottom: 16 }}>
          <div style={{ padding: 12, borderBottom: '1px solid var(--border-0)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                Unpaid balance
              </div>
              <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 2 }}>
                Charges still unpaid, taken out of the deposit
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
                {UNPAID_TYPE_LABEL[line.type] ?? 'Charge'}
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
                {line.status === 'failed' ? 'Failed' : 'Not paid'}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-0)', textAlign: 'right' }}>
                {fmt(line.amount)}
              </span>
            </div>
          ))}
          <div style={{ padding: '10px 14px', fontSize: '.78rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
            These were unpaid at move-out and are paid from the deposit when you finalize. If one was paid another way, record it on the Payments page first and it drops off this list.
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
          {editable && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setDraftLines([...draftLines, { description: '', amount: 0, evidenceDocumentIds: [] }])}
            >
              <Plus size={13} /> Add Damage
            </button>
          )}
        </div>

        {isPreview ? (
          <div style={{ padding: 16, fontSize: '.85rem', color: 'var(--text-2)' }}>
            {canRun ? <>Click <strong>Begin Move-Out</strong> below to start a draft.</> : <>The move-out has not been started yet.</>} Then you can add documented damage deductions before finalizing — unpaid rent/utilities and lease fees are included automatically.
          </div>
        ) : draftLines.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>
            No damage deductions. Unpaid charges and lease fees are included automatically above.
          </div>
        ) : (
          <div>
            {draftLines.map((line, i) => (
              <div key={i} style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-0)' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px 36px', gap: 8, alignItems: 'center' }}>
                  <input
                    type="text"
                    value={line.description}
                    disabled={!editable}
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
                    disabled={!editable}
                    onChange={e => {
                      const next = [...draftLines]
                      next[i] = { ...line, amount: parseFloat(e.target.value) || 0 }
                      setDraftLines(next)
                    }}
                    className="input"
                    style={{ textAlign: 'right' }}
                  />
                  {editable && (
                    <button
                      className="btn btn-ghost btn-sm"
                      aria-label={`Remove damage line ${line.description || i + 1}`}
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
                  knownNames={evidenceNames}
                  disabled={!editable}
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
      {editable && (
        <div className="card" style={{ padding: 12, marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: '.72rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
            Internal notes (optional)
          </label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            className="input"
            rows={2}
            placeholder="Anything the landlord should know — kept with this deposit return"
          />
        </div>
      )}

      {/* decisions #48.6: finalize waits while any payment on the tenancy is
          still clearing — said plainly, with the day it should clear. */}
      {!isFinalized && !isPreview && data.paymentsClearing && (
        <div ref={clearingRef} tabIndex={-1} data-testid="payments-clearing" role="note" style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.3)', color: 'var(--amber)', fontSize: '.82rem', lineHeight: 1.5 }}>
          {data.paymentsClearing}
          {clearingCheckedAt && (
            <div data-testid="payments-clearing-checked" style={{ marginTop: 4, color: 'var(--text-2)' }}>
              Checked again at {clearingCheckedAt} — still waiting, so nothing was finalized.
            </div>
          )}
        </div>
      )}
      {/* Action row */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {canRun && isPreview && !isFinalized && (
          <button className="btn btn-primary" onClick={() => { setError(null); beginMut.mutate() }}
            disabled={beginMut.isLoading || walkthroughBlocksBegin}
            title={walkthroughBlocksBegin ? 'Finalize the in-person move-out walkthrough first' : undefined}>
            {walkthroughBlocksBegin ? 'Walkthrough required first' : beginMut.isLoading ? 'Starting…' : 'Begin Move-Out'}
          </button>
        )}
        {canRun && !isPreview && !isFinalized && (
          <>
            {/* Save draft stays a gray secondary action beside the one gold
                primary (Review & Finalize) — two gold buttons side by side
                would not say which one finishes the job. */}
            {editable && (
              <button className="btn btn-ghost" onClick={saveDraft} disabled={patchMut.isLoading || preparing}>
                {patchMut.isLoading && !preparing ? 'Saving…' : 'Save draft'}
              </button>
            )}
            {/* S548: staff can't release a parked return — the landlord's
                finalize is the approval. Staff over the threshold see the
                button as the send-for-approval action instead. */}
            {isAwaitingApproval && viewerIsOwner && (
              <button className="btn btn-ghost" onClick={() => { setError(null); sendBackMut.mutate() }}
                disabled={sendBackMut.isLoading || preparing || finalizeMut.isLoading}>
                {sendBackMut.isLoading ? 'Sending back…' : 'Send back to draft'}
              </button>
            )}
            {isAwaitingApproval && !viewerIsOwner ? (
              <button className="btn btn-primary" disabled title="A refund this size needs the landlord's approval">
                Landlord reviewing…
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={reviewAndFinalize}
                disabled={preparing || patchMut.isLoading || finalizeMut.isLoading}
                title={data.paymentsClearing ? 'A payment is still clearing — pressing checks again with the latest figures' : undefined}
              >
                {preparing ? 'Getting the latest figures…' : finalizeLabel}
              </button>
            )}
          </>
        )}
      </div>

      {/* Finalize confirmation — the figures just read from the server */}
      {showFinalizeConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setShowFinalizeConfirm(false)}>
          <div role="dialog" aria-label="Finalize deposit return" className="card" style={{ width: 460, maxWidth: '92vw' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginBottom: 12 }}>Finalize Deposit Return</h3>
            <div data-testid="confirm-who" style={{ fontSize: '.85rem', color: 'var(--text-1)', marginBottom: 10 }}>
              For {who}
            </div>
            <div style={{ fontSize: '.88rem', color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.5 }}>
              {gap > 0 ? (
                <>
                  This will charge the tenant <strong>{fmt(gap)}</strong> with their saved payment method — what the deductions come to beyond the deposit{paidAheadUsed > 0 ? ' and the money they paid ahead' : ''}.
                  <br /><br />
                  <span style={{ color: 'var(--amber)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <AlertTriangle size={13} /> If the charge doesn't go through (no saved payment method, or a declined card), this page will say so and you can collect it another way.
                  </span>
                </>
              ) : refund > 0 && needsApproval ? (
                <>
                  This refund of <strong>{fmt(refund)}</strong> is above the landlord's <strong>{fmt(approvalThreshold)}</strong> approval limit.
                  Nothing pays out yet — the landlord will be notified to review and approve it.
                </>
              ) : refund > 0 ? (
                <>
                  This will refund <strong>{fmt(refund)}</strong> to the tenant. {refundWho(refundFromGam, refundFromLandlord, viewerIsLandlord)}
                </>
              ) : (
                <>The deductions use the whole deposit{paidAheadUsed > 0 ? ' and the money paid ahead they need' : ''}. Nothing is refunded and the tenant owes nothing more.</>
              )}
              {paidAheadUsed > 0 && (
                <><br /><br />{fmt(paidAheadUsed)} the tenant paid ahead pays what the deposit didn't cover.</>
              )}
              {paidAheadLeft > 0 && (
                <><br /><br />{fmt(paidAheadLeft)} the tenant paid ahead is left over. It is not part of this refund — it stays on this lease, and once this is finalized {canDecidePaidAhead ? 'you choose' : 'the landlord chooses'} what happens to it (refund it, keep it, or leave it as their credit).</>
              )}
              {closedLines.length > 0 && (
                <><br /><br />{fmt(Number(data.closedAtMoveOutTotal || 0))} the tenant never paid ({closedLines.map(l => l.label).join(', ')}) is closed as no longer owed.</>
              )}
              <br /><br />
              Once finalized, this record can only be changed through a dispute.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setShowFinalizeConfirm(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => finalizeMut.mutate({
                expectedRefund: refund, expectedGap: gap, expectedPaidAheadUsed: paidAheadUsed,
                ...(refundFromGam != null ? { expectedRefundFromGam: refundFromGam } : {}),
                ...(refundFromLandlord != null ? { expectedRefundFromLandlord: refundFromLandlord } : {}),
              })} disabled={finalizeMut.isLoading}>
                {finalizeMut.isLoading ? 'Finalizing…' : needsApproval && gap === 0 ? 'Send for approval' : 'Finalize'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** How the server worked the refund out — its figures, listed, never added up here. */
function MoneyBreakdown(p: {
  finalized: boolean
  totalDeposit: number; interestOwed: number; interestCredited: number
  cleaningFee: number; unpaidBalance: number; finalUtilities: number; damage: number; other: number
  totalDeductions: number; paidAheadUsed: number; refund: number; gap: number
}) {
  const rows: Array<[string, number, boolean?]> = [
    ['Deposits held', p.totalDeposit],
    ...(p.interestOwed > 0 ? [[p.finalized ? 'Deposit interest paid with it' : 'Deposit interest still owed', p.interestOwed] as [string, number]] : []),
    ...(p.interestCredited > 0 ? [['Deposit interest credited earlier, not yet used', p.interestCredited] as [string, number]] : []),
    ...(!p.finalized ? ([
      ['Move-out fees from the lease', p.cleaningFee, true],
      ['Unpaid balance', p.unpaidBalance, true],
      ['Final utility bills', p.finalUtilities, true],
      ['Damage', p.damage, true],
      ['Other deductions', p.other, true],
    ] as Array<[string, number, boolean]>).filter(r => r[1] > 0) : []),
    ['Total deductions', p.totalDeductions],
    ...(p.paidAheadUsed > 0 ? [['Paid ahead by the tenant, used for what the deposit didn\'t cover', p.paidAheadUsed] as [string, number]] : []),
    [p.gap > 0 ? 'Tenant owes' : 'Refund to tenant', p.gap > 0 ? p.gap : p.refund],
  ]
  return (
    <div data-testid="money-breakdown" style={{ marginTop: 12, borderTop: '1px solid var(--border-0)', paddingTop: 8 }}>
      {rows.map(([label, amount, sub]) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: sub ? '.78rem' : '.85rem', color: sub ? 'var(--text-3)' : 'var(--text-1)', padding: '3px 0', paddingLeft: sub ? 14 : 0 }}>
          <span>{label}</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{fmt(amount)}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * How each part of a refund comes back to the tenant (decisions #46.3, #47c).
 * Never who HOLDS the deposit (Nic, #47c: no "held by GAM" / "held by the
 * landlord" label — GAM is only the custodian); only how the tenant's money
 * comes back: the part paid online goes back the way it was paid, the part
 * paid at the office or into the landlord's bank is handed back at the
 * office — and the landlord is told that part is theirs to hand back. The
 * split is the server's (refund_from_gam / refund_from_landlord); a return
 * finalized before it was recorded says nothing extra.
 *
 * Said as what is RECORDED: finalize records the refund; nothing here says
 * the money was already sent.
 */
function refundWho(fromGam: number | null, fromLandlord: number | null, viewerIsOwner: boolean): string {
  if (fromGam == null || fromLandlord == null) return ''
  const g = Number(fromGam), l = Number(fromLandlord)
  if (g + l <= 0) return ''
  const handsPart = viewerIsOwner ? 'you hand that part back' : 'the landlord hands that part back'
  if (g > 0 && l > 0) {
    return `${fmt(g)} goes back to the tenant the way they paid it online; ${fmt(l)} is handed back to them at the office — ${handsPart}.`
  }
  if (g > 0) return 'It goes back to the tenant the way they paid it online.'
  return `It is handed back to the tenant at the office — ${viewerIsOwner ? 'you hand it back' : 'the landlord hands it back'}.`
}

/** Today as YYYY-MM-DD on this device's calendar (the server checks it against the property's). */
function todayYmd(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * decisions #47a: how a finalized refund is going back. Each part GAM sends
 * back the way the deposit was paid is listed in the server's own words; one
 * that could not go out offers its way out — Try again (when trying again can
 * work) and "Give it back in cash instead" (the office hands it over once the
 * answer says to; that amount is added to the landlord's next payout). The landlord's own part
 * gets "Mark handed back" with the day. Never who holds what (#47c). Each
 * press reads the move-out again in place; an error is said once, here.
 */
export function RefundProgress({ leaseId, progress, canRun, viewerIsOwner, onChanged }: {
  leaseId: string; progress: RefundProgressView; canRun: boolean; viewerIsOwner: boolean; onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [said, setSaid] = useState<string[]>([])
  const [handBack, setHandBack] = useState<string | null>(null)
  const [cashAsk, setCashAsk] = useState<RefundPartView | null>(null)
  const [marking, setMarking] = useState(false)
  const [day, setDay] = useState(todayYmd())

  /** Runs one press; true when the server took it (the page reads the move-out again either way). */
  const press = async (key: string, run: () => Promise<any>): Promise<boolean> => {
    setBusy(key); setErr(null); setSaid([]); setHandBack(null)
    let ok = false
    try {
      // lib/api's apiPost answers the whole envelope ({ success, data }) —
      // the server's words are inside data (fix pass 2: reading them from the
      // envelope itself dropped every answer, so a press looked like nothing).
      const r = await run()
      const d = r?.data ?? {}
      const words: string[] = Array.isArray(d.words) ? d.words : []
      if (d.handBack && words.length) { setHandBack(words[0]); setSaid(words.slice(1)) } else setSaid(words)
      ok = true
    } catch (e: any) {
      // Fix pass 3: never "Nothing changed" when the answer was lost (a
      // network failure on Try again may still have sent the refund).
      setErr(errText(e, 'That did not go through — the page now shows the latest. Check the refund below before pressing again.'))
    } finally {
      setBusy(null)
      await onChanged()
    }
    return ok
  }

  const lp = progress.landlordPart
  // Fix pass 4: someone who may only read the move-out still sees each part in
  // the server's words, which name the button to press — so they are told
  // once, here, who can press them (they have none).
  const waitingOnSomeone = progress.parts.some((p) => !p.done && (p.canTryAgain || p.canGiveInCash))
    || (!!lp && !lp.handedBackOn)
  return (
    <div data-testid="refund-progress" className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>
        How the refund goes back
      </div>
      {!canRun && waitingOnSomeone && (
        <div data-testid="refund-read-only" style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 8 }}>
          Only someone with Deposit return access to this property can send, give back or mark these. Ask the landlord if one needs doing.
        </div>
      )}
      {handBack && (
        <div data-testid="hand-back-now" role="status" style={{ padding: 12, marginBottom: 10, borderRadius: 8, border: '1px solid var(--gold)', color: 'var(--gold)', fontWeight: 700 }}>
          {handBack}
        </div>
      )}
      {said.map((w) => <div key={w} style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 6 }}>{w}</div>)}
      {err && <div role="alert" style={{ fontSize: '.82rem', color: 'var(--red)', marginBottom: 8 }}>{err}</div>}

      {progress.parts.map((p) => (
        <div key={p.id} data-testid="refund-part" style={{ padding: '8px 0', borderTop: '1px solid var(--border-0)', fontSize: '.85rem' }}>
          <div style={{ color: p.done ? 'var(--text-2)' : 'var(--text-1)' }}>
            {p.done ? <CheckCircle2 size={13} style={{ color: 'var(--green)', marginRight: 6, verticalAlign: '-2px' }} />
              : p.status === 'failed' ? <AlertTriangle size={13} style={{ color: 'var(--amber)', marginRight: 6, verticalAlign: '-2px' }} /> : null}
            {p.words}
          </div>
          {canRun && !p.done && (p.canTryAgain || p.canGiveInCash) && (
            <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              {p.canTryAgain && (
                <button type="button" className="btn btn-primary btn-sm" disabled={!!busy}
                  onClick={() => press(`try:${p.id}`, () => apiPost<any>(`/leases/${leaseId}/deposit-return/refund-parts/${p.id}/try-again`))}>
                  {busy === `try:${p.id}` ? 'Trying…' : 'Try again'}
                </button>
              )}
              {p.canGiveInCash && (
                <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => setCashAsk(p)}>
                  Give it back in cash instead
                </button>
              )}
            </div>
          )}
          {cashAsk?.id === p.id && (
            <div data-testid="cash-confirm" style={{ marginTop: 8, padding: 10, border: '1px solid var(--border-1)', borderRadius: 8 }}>
              <div style={{ fontSize: '.82rem', color: 'var(--text-1)', marginBottom: 8 }}>
                Give {fmt(p.amount)} back to the tenant in cash at the office? It is recorded as given back, {p.kind === 'bank' || p.kind === 'card' ? `nothing goes to their ${p.kind === 'bank' ? 'bank' : 'card'}, ` : ''}and {fmt(p.amount)} is added to {viewerIsOwner ? 'your' : 'the landlord\'s'} next payout. Hand the cash over once this says to.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-primary btn-sm" disabled={!!busy}
                  onClick={() => { setCashAsk(null); void press(`cash:${p.id}`, () => apiPost<any>(`/leases/${leaseId}/deposit-return/refund-parts/${p.id}/cash`, { expectedAmount: p.amount })) }}>
                  {busy === `cash:${p.id}` ? 'Recording…' : 'Give it back in cash'}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCashAsk(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ))}

      {lp && (
        <div data-testid="landlord-part" style={{ padding: '8px 0', borderTop: '1px solid var(--border-0)', fontSize: '.85rem' }}>
          {lp.handedBackOn ? (
            <div style={{ color: 'var(--text-2)' }}>
              <CheckCircle2 size={13} style={{ color: 'var(--green)', marginRight: 6, verticalAlign: '-2px' }} />
              {fmt(lp.amount)} handed back at the office on {dayWords(lp.handedBackOn)}{lp.handedBackByName ? ` — marked by ${lp.handedBackByName}` : ''}.
              {canRun && (
                <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} disabled={!!busy}
                  onClick={() => press('undo', () => apiPost<any>(`/leases/${leaseId}/deposit-return/landlord-part/undo`))}>
                  Undo
                </button>
              )}
            </div>
          ) : (
            <>
              <div style={{ color: 'var(--text-1)' }}>
                {fmt(lp.amount)} is handed back to the tenant at the office — {viewerIsOwner ? 'you hand it back' : 'the landlord hands it back'}.{canRun ? ' Mark it once it is.' : ' Not marked as handed back yet.'}
              </div>
              {canRun && !marking && (
                <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 6 }} disabled={!!busy}
                  onClick={() => { setDay(todayYmd()); setMarking(true) }}>
                  Mark handed back
                </button>
              )}
              {canRun && marking && (
                <div data-testid="mark-handed-back" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                  <label style={{ fontSize: '.8rem', color: 'var(--text-2)' }}>
                    Handed back on{' '}
                    <input type="date" className="input" value={day} max={todayYmd()} onChange={(e) => setDay(e.target.value)} />
                  </label>
                  <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || !day}
                    onClick={() => {
                      // Fix pass 3: the form closes only when the server took the day; a
                      // refused day (before the move-out, or not come yet) keeps the form
                      // open with the day picked, so it can be changed in place.
                      void press('mark', () => apiPost<any>(`/leases/${leaseId}/deposit-return/landlord-part/handed-back`, { handedBackOn: day, expectedAmount: lp.amount }))
                        .then((ok) => { if (ok) setMarking(false) })
                    }}>
                    {busy === 'mark' ? 'Saving…' : `Mark ${fmt(lp.amount)} handed back`}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMarking(false)}>Cancel</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** "Oct 4, 2026" from a calendar day (YYYY-MM-DD) — a day, so no time zone can move it. */
function dayWords(ymd: string): string {
  const d = new Date(`${String(ymd).slice(0, 10)}T12:00:00Z`)
  return Number.isNaN(d.getTime()) ? String(ymd)
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/**
 * What the landlord already chose for the paid-ahead money (decisions #46.1,
 * #46.1a), by whom and when — said instead of asking again.
 */
function paidAheadDecidedWords(c: PaidAheadChoiceMade): string {
  const by = `on ${dayWords(c.decidedAt)}${c.decidedByName ? ` by ${c.decidedByName}` : ''}`
  // The choices by their own names (@gam/shared, the labels the choice page offers).
  const refundLabel = (PAID_AHEAD_REFUND_CHOICE_LABEL as Record<string, string>)[c.refundChoice] ?? null
  const refunded = Number(c.refundTotal) > 0
    ? `${refundLabel ? `${refundLabel}: ` : ''}${fmt(Number(c.refundTotal))} of the money paid ahead was refunded ${by}. `
    : ''
  const rest = Number(c.restAmount)
  if (c.restChoice === 'credit') {
    return `${refunded}Left as their credit ${by}: ${fmt(rest)} the tenant paid ahead stays theirs and goes toward their next lease with this landlord.`
  }
  if (c.restChoice === 'keep') {
    return `${refunded}${PAID_AHEAD_REST_CHOICE_LABEL.keep} — kept by the landlord ${by}: ${fmt(rest)} the tenant paid ahead.`
  }
  return refunded.trim() || `${refundLabel ?? PAID_AHEAD_REFUND_CHOICE_LABEL['no_refund']} — chosen ${by}.`
}

/** "Jane Doe and Sam Doe — RV 22, Oak Park" (never an id). */
function whoWords(h: DepositReturnState['household']): string {
  const names = (h?.tenantNames ?? []).filter(Boolean)
  const people = names.length === 0 ? 'this lease'
    : names.length === 1 ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  const space = [h?.unitNumber, h?.propertyName].filter(Boolean).join(', ')
  return space ? `${people} — ${space}` : people
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

/** '2026-09-01' → 'September 2026' (a billing month, never shifted by time zone). */
function monthLabel(cycle: string): string {
  const [y, m] = (cycle || '').split('-').map(Number)
  if (!y || !m) return cycle
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

const num = (v: unknown) => Number(v ?? 0) || 0

function normalize(raw: any): DepositReturnState {
  // The server answers with the same money figures for a preview, a draft and
  // a finalized return (routes/leases.ts). Only shape is normalized here.
  return {
    ...raw,
    preview: raw?.id ? undefined : true,
    totalDeposit: num(raw?.totalDeposit),
    interestAccrued: num(raw?.interestAccrued),
    depositInterestCredited: num(raw?.depositInterestCredited),
    prepaidCreditUsed: num(raw?.prepaidCreditUsed),
    prepaidCreditLeft: num(raw?.prepaidCreditLeft),
    cleaningFeeAmount: num(raw?.cleaningFeeAmount),
    unpaidBalanceAmount: num(raw?.unpaidBalanceAmount ?? raw?.unpaidBalanceTotal),
    unpaidBalanceLines: raw?.unpaidBalanceLines || [],
    finalUtilityLines: raw?.finalUtilityLines || [],
    finalUtilityTotal: num(raw?.finalUtilityTotal),
    damageLinesTotal: num(raw?.damageLinesTotal),
    otherDeductionsTotal: num(raw?.otherDeductionsTotal),
    totalDeductions: num(raw?.totalDeductions),
    refundAmount: num(raw?.refundAmount),
    gapAmount: num(raw?.gapAmount),
    refundFromGam: raw?.refundFromGam == null ? null : num(raw.refundFromGam),
    refundFromLandlord: raw?.refundFromLandlord == null ? null : num(raw.refundFromLandlord),
    closedAtMoveOutLines: raw?.closedAtMoveOutLines || [],
    closedAtMoveOutTotal: num(raw?.closedAtMoveOutTotal),
    damageLines: raw?.id ? (raw.damageLines || []) : [],
  }
}

// W-31: per-line evidence — photos/receipts uploaded as documents rows
// tagged to the lease, ids stored on the damage line. The server rejects a
// save when any line has no evidence.
function DamageEvidenceRow({ leaseId, line, knownNames, disabled, onChange }: {
  leaseId: string; line: DeductionLine; knownNames: Record<string, string>; disabled: boolean; onChange: (ids: string[]) => void
}) {
  const navigate = useNavigate()
  const [err, setErr] = useState<string | null>(null)
  const [uploaded, setNames] = useState<Record<string, string>>({})
  const names = { ...knownNames, ...uploaded }
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
        <span key={id} style={{ display: 'inline-flex', alignItems: 'center', fontSize: '.68rem', background: 'rgba(201,162,39,.08)', border: '1px solid rgba(201,162,39,.2)', borderRadius: 6 }}>
          <button type="button"
            onClick={() => navigate(`/view?src=${encodeURIComponent(`/documents/${id}/file`)}&title=${encodeURIComponent(names[id] || 'Evidence')}`)}
            style={{ fontSize: '.68rem', color: 'var(--gold)', background: 'transparent', border: 'none', padding: '3px 6px 3px 8px', cursor: 'pointer' }}>
            {names[id] || `Evidence ${n + 1}`}
          </button>
          {!disabled && (
            <button type="button" aria-label={`Remove ${names[id] || `evidence ${n + 1}`}`}
              title="Remove this photo or receipt from the line"
              onClick={() => onChange(line.evidenceDocumentIds.filter((x) => x !== id))}
              style={{ fontSize: '.72rem', color: 'var(--text-3)', background: 'transparent', border: 'none', padding: '3px 8px 3px 2px', cursor: 'pointer' }}>
              ×
            </button>
          )}
        </span>
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
