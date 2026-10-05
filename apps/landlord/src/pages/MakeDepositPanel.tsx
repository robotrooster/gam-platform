// S655 money plan Step 12 (K-B, Nic 10/2): "Make a bank deposit".
//
// What staff put in the bag: they tick the cash, checks and money orders they
// took (each one already recorded), add anything GAM never recorded with a note,
// and GAM matches the slip to the bank row when it posts. The form asks "Is any
// of this rent? Record it first." before other money is accepted.
//
// A FRONT DESK SCREEN, so it follows the batch's staff rules (decisions.md):
// fresh data at the moment of action (the server re-checks every receipt and the
// total, and a 409 refetches the lists in place), each error once in plain
// words with the next step, one button to back out with nothing sent, and every
// payment in the bag shown by name with an × to take it out.
//
// Mounted on the Bank page's reconciliation tab (DepositMatchPanel, with bank
// matching) and on the Front Desk page for staff who take payments
// (decisions.md #48.2, canMatchBank false: the bank's own deposits stay the
// owner's). It takes
// no company-wide figures from anywhere: every amount shown is one payment or
// the bag being built.

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { appConfirm, toast } from '../components/dialogs'
import { usePerms } from '../lib/permissions'
import { FRESH_LIST, loadFailedSentence, actionFailedSentence } from './deskErrors'
import {
  formatCurrency, MANUAL_PAYMENT_METHOD_LABELS, DEPOSIT_SLIP_STATUS_LABEL, DEPOSIT_SLIP_SOURCE_LABEL,
  type ManualPaymentMethod, type DepositSlipStatus, type DepositSlipSource,
} from '@gam/shared'
import '../styles/bank-reconciliation.css'

/** What sits in the bag (services/depositSlips CASH_ITEM_KINDS). */
const CASH_ITEM_KIND_LABEL: Record<'receipt' | 'register_sale', string> = {
  receipt: 'Payment',
  register_sale: 'Register sale',
}

interface CashItem {
  kind: string
  id: string
  amount: number
  collectedOn: string
  method: string
  payerName: string | null
  unitNumber: string | null
  propertyName: string | null
  slipId: string | null
  slipDepositDate: string | null
}

interface SlipItem {
  id: string; kind: string; amount: number; payerName: string | null; unitNumber: string | null; method: string | null; collectedOn: string | null
  /** The receipt or register sale on the slip (services/depositSlips SlipView). */
  sourceId?: string | null
}
interface Slip {
  id: string; status: string; source: string; depositDate: string; total: number
  otherAmount: number; otherNote: string | null; createdByName: string | null
  bankPostedDate: string | null; lastBankDay: string | null; overdue: boolean; flag: string | null
  items: SlipItem[]
}
interface Waiting {
  transactionId: string; amount: number; postedDate: string; description: string | null
  /** Open slips of exactly this amount whose window the deposit fell in. */
  fittingSlipIds: string[]
  /** GAM's closest combination of the cash on no slip (null: none). */
  proposal: { kind: string; note: string; total: number; items: CashItem[] } | null
}

/**
 * Where to record a rent payment before ticking it. Neither the Bank page nor
 * the Front Desk has a Record payment button, so the next step names the
 * screens that do (RecordPaymentWindow is on the Outstanding Balances page and
 * on each resident's page) — only the ones this person can open. Somebody who
 * can open neither (a staffer who only takes payments) is told who can.
 */
function recordRentFirst(can: (k: string) => boolean): string {
  const pages = [
    can('balances.view') ? 'the Outstanding Balances page' : null,
    can('tenants.view') ? 'the resident\u2019s page' : null,
  ].filter(Boolean)
  return pages.length > 0
    ? `Record each rent payment first (Record payment, on ${pages.join(' or ')}), then tick it in the list above.`
    : 'Ask the owner or a manager to record each rent payment first, then tick it in the list above.'
}

/** The switch that opens this screen (shared PERMISSION_CATALOG take_payment). */
const SWITCH = 'Record a cash / check payment'

const cents = (n: number) => Math.round(Number(n || 0) * 100)
const methodWord = (m: string) => MANUAL_PAYMENT_METHOD_LABELS[m as ManualPaymentMethod] ?? 'Cash'
const who = (i: { payerName: string | null; unitNumber: string | null; kind: string }) =>
  [i.payerName || CASH_ITEM_KIND_LABEL[i.kind as keyof typeof CASH_ITEM_KIND_LABEL] || 'Payment', i.unitNumber].filter(Boolean).join(' · ')
const key = (i: { kind: string; id: string }) => `${i.kind}:${i.id}`

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function todayLocal(): string { return localDay(new Date()) }
/**
 * The latest day the slip can say: tomorrow — the bag made up tonight goes to
 * the bank in the morning. The same rule the server holds (services/depositSlips
 * createSlip: "The deposit day cannot be later than tomorrow.").
 */
function tomorrowLocal(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return localDay(d)
}

/**
 * A slip on the list read again that this request made (its answer was lost on
 * the way back): not on the list before, not void, and exactly what was sent —
 * the deposit day, the total, the other money and its note, and the same
 * receipts and register sales. Null when there is none.
 */
function landedSlip(slips: Slip[], known: Set<string>, body: Record<string, unknown>): Slip | null {
  const want = [
    ...((body.receiptIds as string[] | undefined) ?? []).map(id => `receipt:${id}`),
    ...((body.registerSaleIds as string[] | undefined) ?? []).map(id => `register_sale:${id}`),
  ].sort().join(',')
  const note = (body.otherNote as string | null | undefined) ?? null
  return slips.find(sl => !known.has(sl.id) && sl.status !== 'void'
    && sl.depositDate === body.depositDate
    && cents(Number(sl.total)) === cents(Number(body.expectedTotal ?? 0))
    && cents(Number(sl.otherAmount ?? 0)) === cents(Number(body.otherAmount ?? 0))
    && (sl.otherNote ?? null) === note
    && (sl.items ?? []).map(i => `${i.kind}:${i.sourceId ?? ''}`).sort().join(',') === want) ?? null
}

export function MakeDepositPanel({ entityId = '', canMatchBank = false }: { entityId?: string; canMatchBank?: boolean }) {
  const qc = useQueryClient()
  const { can } = usePerms()
  const qs = entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''
  // Fresh every time the screen is looked at — never a stale list to act on.
  // refetchOnMount 'always' overrides the portal's QueryClient (5-minute cache,
  // no refetch on mount): a payment recorded on another page meanwhile shows.
  const fresh = FRESH_LIST
  const cash = useQuery<{ notOnSlip: CashItem[]; onSlip: CashItem[] }>(
    ['undeposited-cash', entityId], () => apiGet(`/bank-feed/deposits/undeposited${qs}`), fresh)
  const slipsQ = useQuery<{ slips: Slip[]; waiting: Waiting[] }>(
    ['deposit-slips', entityId], () => apiGet(`/bank-feed/deposit-slips${qs}`), fresh)

  const [picked, setPicked] = useState<Record<string, true>>({})
  const [depositDate, setDepositDate] = useState(todayLocal())
  const [otherText, setOtherText] = useState('')
  const [otherNote, setOtherNote] = useState('')
  // "Is any of this rent?" — null until answered.
  const [otherIsRent, setOtherIsRent] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const notOnSlip = cash.data?.notOnSlip ?? []
  const inBag = useMemo(() => notOnSlip.filter(i => picked[key(i)]), [notOnSlip, picked])
  const otherCents = cents(Number(otherText.replace(/[$,\s]/g, '')) || 0)
  const totalCents = inBag.reduce((s, i) => s + cents(i.amount), 0) + otherCents
  const otherBlocked = otherCents > 0 && (otherIsRent !== false || !otherNote.trim())

  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries(['undeposited-cash', entityId]),
      qc.invalidateQueries(['deposit-slips', entityId]),
      qc.invalidateQueries('cash-position'),
      qc.invalidateQueries('bank-txns'),
    ])
  }

  const startOver = () => {
    setPicked({}); setOtherText(''); setOtherNote(''); setOtherIsRent(null); setError(null)
    setDepositDate(todayLocal())
  }

  const send = async (body: Record<string, unknown>, done: (slip: any) => string) => {
    setError(null)
    setBusy(true)
    // The slips already on the list, so a slip this very request made can be
    // told apart from one made before.
    const known = new Set((slipsQ.data?.slips ?? []).map(sl => sl.id))
    let failure: unknown = null
    try {
      const r: any = await apiPost(`/bank-feed/deposit-slips${qs}`, { ...body, entityId: entityId || undefined })
      startOver()
      toast(done(r?.data))
    } catch (e: any) {
      failure = e
    } finally {
      setBusy(false)
      await refreshAll()
    }
    if (!failure) return
    // The answer can be lost on the way back (a timeout, a dropped connection)
    // after the server already made the slip. The list read again shows it:
    // the form is cleared and the staffer told it was made, so pressing again
    // never puts the same "Other money" on a second slip.
    const landed = landedSlip(
      qc.getQueryData<{ slips: Slip[] }>(['deposit-slips', entityId])?.slips ?? [], known, body)
    if (landed) {
      startOver()
      toast(`${done(landed)} (The answer was lost on the way back, but the slip was made.)`)
      return
    }
    // The server's own sentence says what changed and what to do next. The
    // lists were fetched again in place so the next try is on fresh data.
    // Ticks on payments that are still waiting stay ticked; the list fetched
    // again leaves out any that were banked or slipped meanwhile.
    setError(actionFailedSentence(failure, 'The slip could not be made. Look at the list again and try once more.',
      'Making a bank deposit', SWITCH))
  }

  const makeSlip = () => {
    if (totalCents <= 0) { setError('Tick what went into the bag, or add the other money in it.'); return }
    if (otherCents > 0 && otherIsRent === null) { setError('Answer "Is any of this rent?" first.'); return }
    if (otherCents > 0 && otherIsRent) { setError(`${recordRentFirst(can)} Take the rent out of "Other money".`); return }
    if (otherCents > 0 && !otherNote.trim()) { setError('Say what the other money is (for example "laundry quarters").'); return }
    void send({
      depositDate,
      receiptIds: inBag.filter(i => i.kind === 'receipt').map(i => i.id),
      registerSaleIds: inBag.filter(i => i.kind === 'register_sale').map(i => i.id),
      otherAmount: otherCents / 100,
      otherNote: otherCents > 0 ? otherNote.trim() : null,
      otherIsNotRent: otherCents > 0 ? true : undefined,
      expectedTotal: totalCents / 100,
    }, slip => slip?.status === 'matched'
      ? `Deposit slip made — ${formatCurrency(totalCents / 100)} — and matched to the bank deposit of ${slip.bankPostedDate}.`
      : `Deposit slip made — ${formatCurrency(totalCents / 100)}. GAM matches it when the bank shows it.`)
  }

  const matchSlip = async (w: Waiting, s: Slip) => {
    const ok = await appConfirm(
      `Match the ${formatCurrency(w.amount)} bank deposit of ${w.postedDate} to the ${s.depositDate} deposit slip?`,
      { title: 'Match this deposit', confirmLabel: 'Match it' })
    if (!ok) return
    setError(null)
    setBusy(true)
    try {
      await apiPost(`/bank-feed/deposit-slips/${s.id}/match${qs}`, { bankTransactionId: w.transactionId })
      toast(`Matched — the ${s.depositDate} slip is the ${formatCurrency(w.amount)} deposit of ${w.postedDate}.`)
    } catch (e: any) {
      setError(actionFailedSentence(e, 'That slip could not be matched. Look at it again.', 'Matching a bank deposit', SWITCH))
    } finally {
      setBusy(false)
      await refreshAll()
    }
  }

  const acceptProposal = async (w: Waiting) => {
    if (!w.proposal) return
    const ok = await appConfirm(
      `Match the ${formatCurrency(w.amount)} bank deposit of ${w.postedDate} to these ${w.proposal.items.length} payments?`,
      { title: 'Match this deposit', confirmLabel: 'Match it' })
    if (!ok) return
    void send({
      depositDate: w.postedDate,
      receiptIds: w.proposal.items.filter(i => i.kind === 'receipt').map(i => i.id),
      registerSaleIds: w.proposal.items.filter(i => i.kind === 'register_sale').map(i => i.id),
      expectedTotal: w.amount,
      bankTransactionId: w.transactionId,
    }, () => `Matched — the ${formatCurrency(w.amount)} deposit is the office's cash.`)
  }

  const voidSlip = async (s: Slip) => {
    const ok = await appConfirm(
      `Take back the ${formatCurrency(s.total)} deposit slip of ${s.depositDate}? Its payments go back to "not on any slip".`,
      { title: 'Void this slip', confirmLabel: 'Void it', danger: true })
    if (!ok) return
    setError(null)
    // Locked like every other action while money is moving: no void can start
    // while a slip is being made or matched, and no second void on top of it.
    setBusy(true)
    try {
      await apiPost(`/bank-feed/deposit-slips/${s.id}/void${qs}`, {})
      toast('Slip voided.')
    } catch (e: any) {
      setError(actionFailedSentence(e, 'That slip could not be voided. Look at it again.', 'Voiding a deposit slip', SWITCH))
    } finally {
      setBusy(false)
      await refreshAll()
    }
  }

  if (cash.isLoading || slipsQ.isLoading) return <div className="card bankrec-card">Loading the cash not yet banked…</div>
  if (cash.isError) {
    // The server's own sentence, then the next step; a refusal (403) names the
    // switch and that signing in again picks up one just turned on.
    return <div className="card bankrec-card bankrec-error" role="alert">
      {loadFailedSentence(cash.error, 'The cash not yet banked', SWITCH)}
    </div>
  }

  const openSlips = (slipsQ.data?.slips ?? []).filter(s => s.status === 'open')
  const doneSlips = (slipsQ.data?.slips ?? []).filter(s => s.status !== 'open').slice(0, 8)
  const waiting = canMatchBank ? (slipsQ.data?.waiting ?? []) : []

  return (
    <div className="card bankrec-card">
      <div className="bankrec-title">Make a bank deposit</div>
      <div className="bankrec-sub">
        Tick what is going into the bag. GAM matches the slip when the bank shows the deposit — within 5 business days.
      </div>

      {error && <div className="bankrec-error" role="alert">{error}</div>}

      <div className="bankrec-section">Not on any slip yet</div>
      {notOnSlip.length === 0
        ? <div className="bankrec-muted">Every payment taken by hand is on a slip or in the bank.</div>
        : <div className="bankrec-list">
            {notOnSlip.map(i => (
              <label key={key(i)} className={`bankrec-row${picked[key(i)] ? ' bankrec-row-on' : ''}`}>
                <input type="checkbox" checked={!!picked[key(i)]}
                  onChange={e => setPicked(p => {
                    const next = { ...p }
                    if (e.target.checked) next[key(i)] = true; else delete next[key(i)]
                    return next
                  })} />
                <span className="bankrec-who">{who(i)}</span>
                <span className="bankrec-meta">{methodWord(i.method)} · taken {i.collectedOn}</span>
                <span className="bankrec-amt">{formatCurrency(i.amount)}</span>
              </label>
            ))}
          </div>}

      <div className="bankrec-section">Other money in the bag</div>
      <div className="bankrec-other">
        <input className="form-input bankrec-money" inputMode="decimal" placeholder="$0.00" value={otherText}
          onChange={e => { setOtherText(e.target.value); setError(null) }} />
        {otherCents > 0 && (
          <div className="bankrec-question">
            <div className="bankrec-strong">Is any of this rent?</div>
            <div className="bankrec-choices">
              <button type="button" className={`btn btn-sm ${otherIsRent === true ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setOtherIsRent(true)}>Yes, some is rent</button>
              <button type="button" className={`btn btn-sm ${otherIsRent === false ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setOtherIsRent(false)}>No, none of it is rent</button>
            </div>
            {otherIsRent === true && (
              <div className="bankrec-note">
                {recordRentFirst(can)} Only money that is not rent goes here.
              </div>
            )}
            {otherIsRent === false && (
              <input className="form-input" maxLength={300} placeholder='What is it? (for example "laundry quarters")'
                value={otherNote} onChange={e => setOtherNote(e.target.value)} />
            )}
          </div>
        )}
      </div>

      <div className="bankrec-section">In the bag</div>
      {inBag.length === 0 && otherCents === 0
        ? <div className="bankrec-muted">Nothing yet.</div>
        : <div className="bankrec-list">
            {inBag.map(i => (
              <div key={key(i)} className="bankrec-bag-row">
                <span className="bankrec-who">{who(i)}</span>
                <span className="bankrec-amt">{formatCurrency(i.amount)}</span>
                <button type="button" className="bankrec-x" aria-label={`Take ${who(i)} out of the bag`}
                  onClick={() => setPicked(p => { const n = { ...p }; delete n[key(i)]; return n })}>×</button>
              </div>
            ))}
            {otherCents > 0 && (
              <div className="bankrec-bag-row">
                <span className="bankrec-who">Other money{otherNote.trim() ? ` — ${otherNote.trim()}` : ''}</span>
                <span className="bankrec-amt">{formatCurrency(otherCents / 100)}</span>
                <button type="button" className="bankrec-x" aria-label="Take the other money out of the bag"
                  onClick={() => { setOtherText(''); setOtherNote(''); setOtherIsRent(null) }}>×</button>
              </div>
            )}
          </div>}

      <div className="bankrec-actions">
        <label className="bankrec-date">
          Going to the bank on
          <input className="form-input" type="date" value={depositDate} max={tomorrowLocal()}
            onChange={e => setDepositDate(e.target.value)} />
        </label>
        <div className="bankrec-total">{formatCurrency(totalCents / 100)}</div>
        <button type="button" className="btn btn-primary" disabled={busy || totalCents <= 0 || otherBlocked}
          onClick={makeSlip}>{busy ? 'Making the slip…' : 'Make the deposit slip'}</button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={startOver}>Start over</button>
      </div>

      {slipsQ.isError && (
        <div className="bankrec-error" role="alert">
          {loadFailedSentence(slipsQ.error, 'The slips already made', SWITCH, { lead: true })}
        </div>
      )}

      {openSlips.length > 0 && <>
        <div className="bankrec-section">Waiting for the bank</div>
        {openSlips.map(s => (
          <div key={s.id} className={`bankrec-slip${s.overdue ? ' bankrec-slip-late' : ''}`}>
            <div className="bankrec-slip-head">
              <span className="bankrec-strong">{formatCurrency(s.total)} · {s.depositDate}</span>
              <span className="bankrec-meta">
                {DEPOSIT_SLIP_STATUS_LABEL[s.status as DepositSlipStatus] ?? 'Waiting for the bank'}
                {s.createdByName ? ` · made by ${s.createdByName}` : ''}
                {s.lastBankDay && !s.overdue ? ` · the bank should show it by ${s.lastBankDay}` : ''}
              </span>
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => voidSlip(s)}>Void this slip</button>
            </div>
            {s.flag && <div className="bankrec-flag">{s.flag}</div>}
            <div className="bankrec-slip-items">
              {s.items.map(i => (
                <span key={i.id}>{who(i)} {formatCurrency(i.amount)}</span>
              ))}
              {s.otherAmount > 0 && <span>Other — {s.otherNote} {formatCurrency(s.otherAmount)}</span>}
            </div>
          </div>
        ))}
      </>}

      {waiting.length > 0 && <>
        <div className="bankrec-section">Bank deposits that may be the office's cash</div>
        {waiting.map(w => (
          <div key={w.transactionId} className="bankrec-slip">
            <div className="bankrec-slip-head">
              <span className="bankrec-strong">{formatCurrency(w.amount)} · posted {w.postedDate}</span>
              {w.description && <span className="bankrec-meta">{w.description}</span>}
            </div>
            {w.fittingSlipIds.map(id => {
              const s = (slipsQ.data?.slips ?? []).find(x => x.id === id)
              if (!s) return null
              return (
                <div key={id} className="bankrec-choices">
                  <span className="bankrec-note">The {s.depositDate} slip ({formatCurrency(s.total)}) fits this deposit.</span>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => matchSlip(w, s)}>
                    Match it to this slip
                  </button>
                </div>
              )
            })}
            {w.proposal && <>
              <div className="bankrec-note">{w.proposal.note}</div>
              <div className="bankrec-slip-items">
                {w.proposal.items.map(i => <span key={key(i)}>{who(i)} {formatCurrency(i.amount)}</span>)}
              </div>
              {cents(w.proposal.total) === cents(w.amount) && (
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => acceptProposal(w)}>
                  These are it — match them
                </button>
              )}
            </>}
          </div>
        ))}
      </>}

      {doneSlips.length > 0 && <>
        <div className="bankrec-section">Recent slips</div>
        {doneSlips.map(s => (
          <div key={s.id} className="bankrec-done">
            {formatCurrency(s.total)} · {s.depositDate} · {DEPOSIT_SLIP_STATUS_LABEL[s.status as DepositSlipStatus] ?? ''}
            {s.bankPostedDate ? ` (bank ${s.bankPostedDate})` : ''}
            {s.source === 'inferred' ? ` · ${DEPOSIT_SLIP_SOURCE_LABEL[s.source as DepositSlipSource]}` : ''}
          </div>
        ))}
      </>}
    </div>
  )
}
