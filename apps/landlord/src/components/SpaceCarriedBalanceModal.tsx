/**
 * 10/19 (Nic): WHAT THIS SPACE CARRIES — and the payment arrangement on it.
 *
 *   "there's nothing that automatically bills for it right now. The regular
 *    monthly bill comes out every month and the carry forward balance is kept
 *    track of, but it's at the tenant's discretion to actually make any sort of
 *    payment against that. So, to help landlords not forget about it and stuff,
 *    we need to do, you know, payment arrangements on carry forward balances.
 *    So what, even if it's $50 or $100 or whatever."
 *
 * An arrangement ASKS for an amount each cycle. It never writes a second
 * charge — the whole balance is already the one carried charge, so billing $100
 * against it would bill the same debt twice. What a cycle produces is a record:
 * what was asked for, what came in against the balance, and whether it was met.
 *
 * TWO PROMISES THIS SCREEN HAS TO MAKE PLAINLY, because a landlord setting an
 * arrangement will be asked about both by the person paying it:
 *   · a missed cycle costs nothing. There is no invoice to fine, and nothing in
 *     the engine writes a late_fee row against it.
 *   · it is not part of the new resident's payment history. Nic: "Don't count
 *     it on his, you know, payment health history, his late fees ... that's
 *     carried forward as Rashawn's."
 *
 * AND THE DOOR OUT. A landlord who decides to eat it can take the balance off.
 * Nothing is erased: the charge rows are voided with their reason, what was
 * really paid stays recorded, and the balance keeps saying whose debt it was.
 * It only stops being a bill. Two presses, in the window — never a native
 * confirm.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from 'react-query'
import { apiGet, apiPost, apiPut } from '../lib/api'
import { X, Scale, Check, AlertTriangle } from 'lucide-react'
import {
  SPACE_CARRYFORWARD_STATUS_LABEL, SPACE_CARRYFORWARD_INSTALLMENT_STATUS_LABEL,
  SPACE_CARRYFORWARD_NO_LATE_FEE_NOTE,
  type SpaceCarryforwardStatus, type SpaceCarryforwardInstallmentStatus,
} from '@gam/shared'

const fmt = (n: any) => `$${Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const sayDay = (s: string | null | undefined) => {
  if (!s) return '—'
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
const errText = (e: any) => e?.response?.data?.error || e?.message || 'Something went wrong'
const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd']
  return `${n}${s[(n % 100 - 20) % 10] || s[n % 100] || s[0]}`
}

export interface SpaceCarriedBalance {
  id: string
  unitId: string
  spaceName: string
  propertyName: string
  amount: number
  settledAmount: number
  stillOwed: number
  lateFeesWaived: number
  status: SpaceCarryforwardStatus
  openedOn: string
  oldestDueDate: string
  settledOn: string | null
  takenOffOn: string | null
  owedByName: string | null
  assumedByName: string | null
  assumedLeaseId: string | null
  /** When a landlord was shown this and put it on a named person. Null: nobody was. */
  assumptionRecordedAt?: string | null
  /** The balance moved onto a lease and nobody was ever asked to take it on. */
  movedWithoutBeingAsked?: boolean
  chargeLabel: string
  arrangement: { amount: number; dayOfMonth: number; startedOn: string } | null
  installments: Array<{
    dueDate: string; amount: number; status: SpaceCarryforwardInstallmentStatus
    appliedAmount: number; metOn: string | null
  }>
  role?: 'assumed' | 'origin'
}

export function SpaceCarriedBalanceModal({ leaseId, onClose, canArrange, canTakeOff }: {
  leaseId: string
  onClose: () => void
  /** 'Bill a fee' — the same permission the arrangement route takes. */
  canArrange: boolean
  /** 'End a lease' — writing money off takes the permission that created it. */
  canTakeOff: boolean
}) {
  const qc = useQueryClient()
  const [amount, setAmount] = useState('')
  const [day, setDay] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [takingOff, setTakingOff] = useState(false)
  const [takeOffReason, setTakeOffReason] = useState('')
  const [saved, setSaved] = useState<string | null>(null)

  const q = useQuery<SpaceCarriedBalance | null>(
    ['space-carryforward', leaseId],
    () => apiGet<SpaceCarriedBalance | null>(`/leases/${leaseId}/space-carryforward`),
    { retry: false },
  )
  const cf = q.data

  const refresh = () => {
    q.refetch()
    qc.invalidateQueries('leases')
    qc.invalidateQueries('space-carryforwards')
  }

  const setArrangement = useMutation(
    (body: { amount: number | null; dayOfMonth: number | null }) =>
      apiPut(`/leases/${leaseId}/space-carryforward/arrangement`, body),
    {
      onSuccess: (_d, v) => {
        setError(null)
        setSaved(v.amount == null
          ? 'Stopped asking. The balance is still owed; nothing is asked for on a cycle.'
          : `Asking ${fmt(v.amount)} on the ${ordinal(v.dayOfMonth!)} of each month.`)
        setAmount(''); setDay('')
        refresh()
      },
      onError: (e: any) => { setSaved(null); setError(errText(e)) },
    },
  )

  const takeOff = useMutation(
    () => apiPost(`/leases/${leaseId}/space-carryforward/take-off`, { reason: takeOffReason.trim() || undefined }),
    {
      onSuccess: (r: any) => {
        const d = r?.data ?? r
        setError(null); setTakingOff(false); setTakeOffReason('')
        setSaved(`Taken off. ${fmt(d.takenOff)} is owed by nobody now; ${fmt(d.keptPaid)} already paid against it stays recorded.`)
        refresh()
      },
      onError: (e: any) => { setSaved(null); setError(errText(e)) },
    },
  )

  const submitArrangement = () => {
    const a = Number(amount)
    const d = Number(day)
    if (!(a > 0)) { setError('Enter a monthly amount.'); return }
    if (!(d >= 1 && d <= 28)) { setError('Pick a day from 1 to 28 — every month has one.'); return }
    setArrangement.mutate({ amount: a, dayOfMonth: d })
  }

  const busy = setArrangement.isLoading || takeOff.isLoading

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Scale size={16} /> What this space carries
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={14} /></button>
        </div>

        {q.isLoading && <div style={{ fontSize: '.82rem', color: 'var(--text-3)' }}>Reading the balance…</div>}
        {q.isError && (
          <div style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', color: 'var(--red)', fontSize: '.8rem' }}>
            {errText(q.error)}
          </div>
        )}
        {!q.isLoading && !q.isError && !cf && (
          <>
            <div style={{ fontSize: '.84rem', color: 'var(--text-2)', lineHeight: 1.6 }}>
              This space carries no unpaid space rent. Nothing to settle, nothing to arrange.
            </div>
            <div className="modal-footer" style={{ marginTop: 16 }}>
              <button className="btn btn-ghost" onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {cf && (
          <>
            {/* The balance itself */}
            <div style={{ padding: '14px', borderRadius: 10, background: 'var(--bg-2)', border: '1px solid var(--border-0)', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                <div>
                  <div style={{ fontSize: '.85rem', fontWeight: 700, color: 'var(--text-0)' }}>
                    {cf.spaceName} <span style={{ fontWeight: 400, color: 'var(--text-3)' }}>· {cf.propertyName}</span>
                  </div>
                  <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: 2 }}>{cf.chargeLabel}</div>
                </div>
                <span className={'badge ' + (cf.status === 'open' ? 'badge-amber' : cf.status === 'settled' ? 'badge-green' : 'badge-muted')}>
                  {SPACE_CARRYFORWARD_STATUS_LABEL[cf.status]}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 12 }}>
                <div>
                  <div style={{ fontSize: '.68rem', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)' }}>Carried</div>
                  <div className="mono" style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-0)' }}>{fmt(cf.amount)}</div>
                </div>
                <div>
                  <div style={{ fontSize: '.68rem', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)' }}>Paid so far</div>
                  <div className="mono" style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--green)' }}>{fmt(cf.settledAmount)}</div>
                </div>
                <div>
                  <div style={{ fontSize: '.68rem', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)' }}>Still owed</div>
                  <div className="mono" style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--gold)' }}>{fmt(cf.stillOwed)}</div>
                </div>
              </div>
              <div style={{ fontSize: '.76rem', color: 'var(--text-2)', lineHeight: 1.6, marginTop: 10, borderTop: '1px solid var(--border-0)', paddingTop: 8 }}>
                Left by <strong>{cf.owedByName || 'the previous resident'}</strong>
                {cf.status === 'open' ? <>, who stays liable until it is paid</> : null} — rent owed
                from {sayDay(cf.oldestDueDate)}.
                {cf.assumedByName
                  ? <> Taken on with the space by <strong>{cf.assumedByName}</strong>.</>
                  : cf.status === 'open' ? <> Nobody has taken the space on yet.</> : null}
                {cf.lateFeesWaived > 0 && <> {fmt(cf.lateFeesWaived)} of late fees was dropped at close-out.</>}
                {cf.status === 'settled' && <> Paid off {sayDay(cf.settledOn)}.</>}
                {cf.status === 'voided' && <> Taken off {sayDay(cf.takenOffOn)}.</>}
              </div>
            </div>

            {/* ── 10/19 (Nic): IT MOVED, AND NOBODY WAS ASKED ────────────────
                Taking the balance on is a condition of moving in — "If Jacob
                declines, he's not moving into the park" — but the balance
                follows the space onto whatever lease is drafted next, and only
                the invite screen asks. A lease papered through tenant
                onboarding, issuance or stay terms inherits it in silence. So
                where the server says the question was never put, this says so
                plainly, with both ways out: ask them, or take it off. */}
            {cf.movedWithoutBeingAsked && (
              <div style={{ display: 'flex', gap: 8, padding: '10px 12px', borderRadius: 8, marginBottom: 12,
                background: 'rgba(217,119,6,.08)', border: '1px solid rgba(217,119,6,.3)' }}>
                <AlertTriangle size={15} style={{ color: 'var(--amber, #d97706)', flexShrink: 0, marginTop: 2 }} />
                <div style={{ fontSize: '.77rem', color: 'var(--text-1)', lineHeight: 1.6 }}>
                  Nobody was asked to take this balance on. It moved onto
                  {cf.assumedByName ? <strong> {cf.assumedByName}</strong> : <> the new resident</>}&apos;s
                  lease with the space, and their first bill carries it. Taking it on is a condition of moving
                  in — so put it to them, or take the balance off if you have decided to eat it.
                </div>
              </div>
            )}

            {/* The two promises, in one line each. */}
            <div style={{ fontSize: '.76rem', color: 'var(--text-3)', background: 'rgba(201,162,39,.06)', border: '1px solid rgba(201,162,39,.15)', borderRadius: 8, padding: '10px 12px', marginBottom: 12, lineHeight: 1.6 }}>
              {SPACE_CARRYFORWARD_NO_LATE_FEE_NOTE} It is its own line on their bill, never folded into rent.
            </div>

            {saved && (
              <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'rgba(30,219,122,.08)', border: '1px solid rgba(30,219,122,.3)', color: 'var(--text-1)', fontSize: '.78rem', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <Check size={14} style={{ color: 'var(--green)', flexShrink: 0, marginTop: 2 }} /> <span>{saved}</span>
              </div>
            )}
            {error && (
              <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', color: 'var(--red)', fontSize: '.78rem' }}>
                {error}
              </div>
            )}

            {/* The arrangement */}
            {cf.status === 'open' && canArrange && (
              <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border-0)', marginBottom: 12 }}>
                <div style={{ fontSize: '.8rem', fontWeight: 700, color: 'var(--text-0)', marginBottom: 2 }}>Payment arrangement</div>
                <div style={{ fontSize: '.74rem', color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 10 }}>
                  {cf.arrangement
                    ? <>Asking <strong style={{ color: 'var(--text-1)' }}>{fmt(cf.arrangement.amount)}</strong> on the {ordinal(cf.arrangement.dayOfMonth)} of each month since {sayDay(cf.arrangement.startedOn)}.</>
                    : <>Nothing is asked for on a cycle today — paying it is at their discretion. Set an amount and a day so it is not forgotten.</>}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <label style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
                    Amount each month
                    <input className="input mono" inputMode="decimal" value={amount} placeholder={cf.arrangement ? String(cf.arrangement.amount) : '100.00'}
                      onChange={e => { setAmount(e.target.value); setError(null) }}
                      style={{ display: 'block', marginTop: 4, width: '100%' }} />
                  </label>
                  <label style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
                    Day of the month (1–28)
                    <input className="input mono" inputMode="numeric" value={day} placeholder={cf.arrangement ? String(cf.arrangement.dayOfMonth) : '1'}
                      onChange={e => { setDay(e.target.value); setError(null) }}
                      style={{ display: 'block', marginTop: 4, width: '100%' }} />
                  </label>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={submitArrangement}>
                    {setArrangement.isLoading ? 'Saving…' : cf.arrangement ? 'Change the arrangement' : 'Set the arrangement'}
                  </button>
                  {cf.arrangement && (
                    <button className="btn btn-ghost btn-sm" disabled={busy}
                      title="Stop asking on a cycle. The balance stays owed."
                      onClick={() => setArrangement.mutate({ amount: null, dayOfMonth: null })}>
                      Stop asking
                    </button>
                  )}
                  <span style={{ fontSize: '.7rem', color: 'var(--text-3)', marginLeft: 'auto' }}>
                    Never more than what is still owed.
                  </span>
                </div>
              </div>
            )}

            {/* The cycles it has asked for */}
            {cf.installments.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)', marginBottom: 6 }}>
                  Cycles asked for
                </div>
                <div style={{ border: '1px solid var(--border-0)', borderRadius: 8, overflow: 'hidden' }}>
                  {cf.installments.map(i => (
                    <div key={i.dueDate} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--border-0)', fontSize: '.76rem' }}>
                      <span className="mono" style={{ color: 'var(--text-2)', minWidth: 110 }}>{sayDay(i.dueDate)}</span>
                      <span className="mono" style={{ color: 'var(--text-0)', fontWeight: 700 }}>{fmt(i.amount)}</span>
                      <span style={{ marginLeft: 'auto', color: i.status === 'met' ? 'var(--green)' : i.status === 'missed' ? 'var(--text-3)' : 'var(--text-2)' }}>
                        {SPACE_CARRYFORWARD_INSTALLMENT_STATUS_LABEL[i.status]}
                        {i.status === 'met' && i.metOn ? ` · ${sayDay(i.metOn)}` : ''}
                        {i.status === 'missed' && i.appliedAmount > 0 ? ` · ${fmt(i.appliedAmount)} came in` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* The door out */}
            {cf.status === 'open' && canTakeOff && (
              takingOff ? (
                <div style={{ padding: '12px 14px', borderRadius: 10, background: 'rgba(217,119,6,.08)', border: '1px solid rgba(217,119,6,.3)', marginBottom: 12 }}>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <AlertTriangle size={15} style={{ color: 'var(--amber, #d97706)', flexShrink: 0, marginTop: 2 }} />
                    <div style={{ fontSize: '.78rem', color: 'var(--text-1)', lineHeight: 1.6 }}>
                      Take {fmt(cf.stillOwed)} off and nobody is asked for it again — not
                      {cf.owedByName ? ` ${cf.owedByName}` : ' the previous resident'}, not whoever takes the space on.
                      The {fmt(cf.settledAmount)} already paid stays recorded, and the balance keeps saying whose debt it was.
                    </div>
                  </div>
                  <input className="input" value={takeOffReason} maxLength={500} placeholder="Why (optional) — e.g. home abandoned, park took it back"
                    onChange={e => setTakeOffReason(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setTakingOff(false)}>Keep it owed</button>
                    <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => takeOff.mutate()}>
                      {takeOff.isLoading ? 'Taking it off…' : `Take ${fmt(cf.stillOwed)} off`}
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn btn-ghost btn-sm" style={{ marginBottom: 12 }} onClick={() => setTakingOff(true)}
                  title="Write the balance off — nothing is erased, it stops being a bill">
                  Take this balance off
                </button>
              )
            )}

            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
