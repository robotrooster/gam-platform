/**
 * S655 money plan, Step 14 — THE DESK WINDOW: record a payment taken at the
 * counter, and post one that arrived before its bill.
 *
 * Decisions #29 (Nic, 10/3): Record payment lives on Outstanding Balances — a
 * button on each household (this window, already filled with that household
 * and what it owes) and one at the top for anyone not on the list (paying
 * ahead: PostPaymentForm). The window shows the FULL balance the way the desk
 * takes it — the current bill, the old balance (paid last, optional), GAM's
 * own charges as a "Pay online" line so the total equals the tenant's portal —
 * with "credit available $X" BESIDE it, never taken off it. The desk answers
 * Use or Save before anything is recorded (Nic, 10/2), and the server checks
 * the answer against what it reads under the household lock: a figure that
 * moved is a 409, and the window refetches and asks again IN PLACE. The window
 * keeps the figures the desk answered against (and sends back the credit figure
 * it showed), so a fresh read that moves them — on window focus, or after a
 * refusal (a 422 is read again too) — asks every question again rather than
 * carrying an old answer onto new figures.
 *
 * Staff screens are foolproof (Nic 10/2): fresh figures every time it opens and
 * after any refusal, never "reload"; one message at a time, in plain words,
 * with the next step; Cancel backs out with nothing written; nothing defaults
 * where a wrong default costs someone money (the cash surplus, the credit).
 *
 * The arithmetic and the questions live in lib/creditDesk (tested there).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import {
  humanize, MANUAL_PAYMENT_METHODS, MANUAL_PAYMENT_METHOD_LABELS, MANUAL_PAYMENT_METHOD_WORD,
  DELETE_ONBOARDING_LATE_FEE_LABEL, DELETE_ONBOARDING_LATE_FEE_HINT, UNREPORTED_DEPOSIT_LATE_LANDLORD_TEXT,
  type ManualPaymentMethod,
} from '@gam/shared'
import { api, apiGet, apiPost } from '../lib/api'
import { TAP_WINDOW_SECONDS } from '../lib/terminal'
import {
  money, toCents, toDollars, parseAmount, dayWord, localToday,
  creditChoiceNeeded, oldBalanceOwedCents, postAnchor, planTender, recordedMessage, lateFeeDeleteRefusalText,
  serverMessage, serverStatus, readerChoiceParams, readerQuoteQuery, readerReady, readerLeases,
  postConfirmQuestion, numberRequired, deskFigures, sameFigures, figuresMovedMessage, CREDIT_USE_RULE,
  chargeMonthsRange, readChargesById, CHARGE_PAGE_SIZE, withReaderTaken, readerFinishedMessage,
  deskOnItsWay, nextAwaitingRereadAt, awaitingOpensAtWord,
  AMOUNT_FIELD_LABEL, NUMBER_FIELD_LABEL, numberMissingMessage, depositPhotoProblem, billName, stillOwedText, lateFeesOffText, lateFeesBackOnShortBills,
  onboardingLateFeeBoxApplies,
  type CreditChoice, type DeskFigures, type DeskQuote, type DeskQuoteRow, type ReaderQuote, type ReaderSpace,
} from '../lib/creditDesk'
import '../styles/credit-desk.css'

type Msg = { kind: 'error' | 'warn' | 'info' | 'success'; text: string } | null
const MSG_CLASS: Record<NonNullable<Msg>['kind'], string> = {
  error: 'alert alert-danger', warn: 'alert alert-warn', info: 'alert alert-info', success: 'alert alert-success',
}

function Message({ msg }: { msg: Msg }) {
  if (!msg) return null
  return <div className={`${MSG_CLASS[msg.kind]} cd-msg`} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</div>
}

/**
 * 10/5 (Nic): "maybe ... add a picture of the receipt" — the photo of the
 * bank's deposit receipt, sent once the payment is recorded (it goes on that
 * payment's receipt). Resolves to null when it went up, else the words to add
 * to the result: the payment itself was recorded either way.
 */
export async function sendDepositPhoto(receiptId: string | null | undefined, photo: File | null): Promise<string | null> {
  if (!photo) return null
  if (!receiptId) return 'The photo of the bank\'s receipt was not added — add it from Payments.'
  try {
    const fd = new FormData()
    fd.append('photo', photo)
    await api.post(`/payments/remittances/${receiptId}/deposit-photo`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
    return null
  } catch {
    return 'The photo of the bank\'s receipt did not upload — add it from Payments.'
  }
}

/** 10/5 (Nic): the optional photo of the bank's deposit receipt, picked before Record. */
export function DepositPhotoField({ photo, onPick, disabled = false }: {
  photo: File | null; onPick: (f: File | null, problem: string | null) => void; disabled?: boolean
}) {
  return (
    <label className="cd-field">
      <span className="cd-field-label">Photo of the bank&apos;s deposit receipt (optional)</span>
      <input className="form-input" type="file" accept="image/*" disabled={disabled}
        onChange={e => {
          const f = e.target.files?.[0] ?? null
          const problem = depositPhotoProblem(f)
          onPick(problem ? null : f, problem)
          if (problem) e.target.value = ''
        }} />
      {photo && <span className="cd-line-meta">{photo.name}</span>}
    </label>
  )
}

/** How long Close waits for the bill read after the last card before it says the take alone (fix pass 5). */
export const CLOSE_READ_WAIT_MS = 2000

/**
 * 10/4 (decisions #48.4): how long after a card hold's confirm-by time the
 * window reads the bill again by itself — the server releases a hold that ran
 * out before it answers, so the bill it held shows as open, a little after the
 * time to allow for the two clocks differing.
 */
export const AWAITING_CARD_REREAD_GRACE_MS = 3000

/** "2:45 PM" — the desk's own clock is the park's (the staff are standing in it). */

/**
 * The bill as read after the last card was taken, for the closing notice: the
 * read already on its way is joined (never a second one beside it), a read
 * that fails or came from before the take counts as no read, and a slow one
 * is given up on after CLOSE_READ_WAIT_MS.
 */
async function readBillAfterTake(
  refetch: () => Promise<{ data?: DeskQuote; isError: boolean; dataUpdatedAt: number }>, takenAt: number,
): Promise<DeskQuote | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const slow = new Promise<null>(res => { timer = setTimeout(() => res(null), CLOSE_READ_WAIT_MS) })
  const read = refetch()
    .then(r => (!r.isError && r.data && r.dataUpdatedAt >= takenAt ? r.data : null))
    .catch(() => null)
  try {
    return await Promise.race([read, slow])
  } finally {
    clearTimeout(timer)
  }
}

/** What a charge is, in the words the bill uses ("Water", "Late fee") — the server's label when it sent one. */
function lineName(r: DeskQuoteRow, labels: Map<string, { label: string; detail: string | null }>): string {
  const l = labels.get(r.id)
  if (l?.label) return l.detail ? `${l.label} · ${l.detail}` : l.label
  const note = String(r.notes ?? '').trim()
  if (note) return note.split(' — ')[0]
  return humanize(r.type)
}

function BillLines({ title, rows, labels, sub }: {
  title: string; rows: DeskQuoteRow[]; labels: Map<string, { label: string; detail: string | null }>; sub?: string
}) {
  if (!rows.length) return null
  return (
    <div className="cd-bill-group">
      <div className="cd-section-label">{title}{sub && <span className="cd-section-sub"> — {sub}</span>}</div>
      {rows.map(r => (
        <div key={r.id} className="cd-line">
          <span className="cd-line-label">
            {lineName(r, labels)}
            <span className="cd-line-meta"> · due {dayWord(r.dueDate)}{r.unitNumber ? ` · ${r.unitNumber}` : ''}</span>
          </span>
          <span className="mono">
            {money(r.amount)}
            {toCents(r.creditAlreadyApplied) > 0 && (
              <span className="cd-line-meta"> ({money(r.creditAlreadyApplied)} credit already on it)</span>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * 10/6 (Nic): "the late fee is only deleted during onboarding at landlord's
 * discretion." Off by default; shown only when a bank deposit dated back takes
 * a late fee off the onboarding month's bill and this person may tick it.
 */
export function OnboardingLateFeeBox({ checked, onChange, disabled = false }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean
}) {
  return (
    <label className="cd-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span>
        {DELETE_ONBOARDING_LATE_FEE_LABEL}
        <span className="cd-check-sub">{DELETE_ONBOARDING_LATE_FEE_HINT}</span>
      </span>
    </label>
  )
}

// ─── The window ───────────────────────────────────────────────────────────────

export function RecordPaymentWindow({ anchorPaymentId, tenantId, name, onClose, onRecorded }: {
  /** Any open charge of the household (Outstanding Balances sends the oldest the desk may take). */
  anchorPaymentId: string
  tenantId: string | null
  name: string
  onClose: () => void
  /** After a payment was recorded (the window stays up until Close if change is due). */
  onRecorded: (message: string) => void
}) {
  const qc = useQueryClient()
  // Leases whose reader block is mid-payment (sending, waiting for the tap or
  // the card, recording it). The window cannot be closed then: closing would
  // cancel a charge the customer is about to tap, or drop one being recorded.
  const [readerBusy, setReaderBusy] = useState<Record<string, boolean>>({})
  const anyReaderBusy = Object.values(readerBusy).some(Boolean)
  const [mode, setMode] = useState<ManualPaymentMethod | 'reader' | null>(null)
  // 10/5: the day the resident put the money in the bank — logged after the
  // fact, the payment counts from that day (its on-time or late mark), and
  // paid in full, late fees charged after it come off — so the bill is read
  // as of that day (?depositedOn=).
  const deskToday = localToday()
  const [depositedOn, setDepositedOn] = useState(deskToday)
  const backdatedTo = mode === 'bank_deposit' && /^\d{4}-\d{2}-\d{2}$/.test(depositedOn) && depositedOn < deskToday
    ? depositedOn : null
  const quoteKey = ['desk-quote', anchorPaymentId, backdatedTo]
  // The window's result, said ONCE (fix pass 3): the screen that stays up with
  // the change to hand back, and the one notice the page keeps.
  const [done, setDone] = useState<{ text: string; change: number } | null>(null)
  const finished = useRef(false)
  const finish = (text: string, change: number) => {
    if (finished.current) return
    finished.current = true
    onRecorded(text)
    setDone({ text, change })
  }
  // Fix pass 2: while a card is on the reader the bill is not read again on a
  // window focus — a read that dropped the space being charged would take its
  // block (and the charge's result) off the screen. It is read again the
  // moment that space is taken. Fix pass 3: once the window is finished it is
  // not read at all — the done screen (and the change on it) never moves.
  const { data: quote, isLoading, error: quoteError, refetch, isFetching, dataUpdatedAt, errorUpdatedAt } = useQuery<DeskQuote>(
    quoteKey, () => apiGet<DeskQuote>(`/payments/${anchorPaymentId}/record-manual/quote${backdatedTo ? `?depositedOn=${backdatedTo}` : ''}`),
    { staleTime: 0, cacheTime: 0, retry: false, enabled: !done, keepPreviousData: true,
      refetchOnWindowFocus: !anyReaderBusy && !done, refetchOnReconnect: !anyReaderBusy && !done })
  // The words each line goes by — the same lines the Outstanding breakdown reads.
  const { data: invoices = [] } = useQuery<any[]>(
    ['balance-invoices', tenantId], () => apiGet<any[]>(`/balances/${tenantId}/invoices`),
    { enabled: !!tenantId, retry: false })
  const labels = useMemo(() => {
    const m = new Map<string, { label: string; detail: string | null }>()
    for (const inv of invoices) for (const l of inv?.lines ?? []) if (l?.id && l?.label) m.set(l.id, { label: l.label, detail: l.detail ?? null })
    return m
  }, [invoices])

  const [choice, setChoice] = useState<CreditChoice>(null)
  // The credit figure on screen (cents) when the desk said Use or Save — the
  // figure sent back, so a credit that moved afterwards is the server's 409,
  // never a different amount spent without asking.
  const [shownCredit, setShownCredit] = useState<number | null>(null)
  const [tendered, setTendered] = useState('')
  const [reference, setReference] = useState('')
  // 10/5 (Nic): a bank deposit's optional photo of the bank's receipt.
  const [photo, setPhoto] = useState<File | null>(null)
  // 10/6 (Nic): the onboarding box — off unless the desk ticks it.
  const [deleteOnboardingFee, setDeleteOnboardingFee] = useState(false)
  const onboardingBox = mode === 'bank_deposit' && !!backdatedTo && onboardingLateFeeBoxApplies(quote)
  const [towardOld, setTowardOld] = useState('')
  const [surplusHandling, setSurplusHandling] = useState<'change' | 'credit' | null>(null)
  const [writtenConfirmed, setWrittenConfirmed] = useState(false)
  // The figures in place when the desk first answered a question (Use / Save,
  // give change or keep it, "yes, it is $X"). A fresh read (window focus, the
  // onboarding mark, a refusal) that changes them voids every answer: they are
  // asked again, with one message saying what changed.
  const [answeredOn, setAnsweredOn] = useState<DeskFigures | null>(null)
  // A refusal's own words, waiting for the fresh read it asked for — said in
  // place of the general "what they owe changed" if that read moved the figures.
  const refusal = useRef<string | null>(null)
  const [msg, setMsg] = useState<Msg>(null)
  const [saving, setSaving] = useState(false)
  // Per lease, what the reader took and the space as it was when taken (a
  // household with two spaces taps twice; the space stays listed as taken
  // after the bill is read again without it).
  const [tapped, setTapped] = useState<Record<string, { total: number; space: ReaderSpace }>>({})
  // When the last space was taken (ms), and how many times the bill was read
  // again for a take — the other spaces read their own figures again then too.
  const [takenAt, setTakenAt] = useState(0)
  const [readAgain, setReadAgain] = useState(0)
  const takenOnReader = Object.values(tapped).reduce((a, t) => a + toCents(t.total), 0) / 100
  // The space whose payment the desk started last: its breakdown is the one on
  // the reader (fix pass 2 — one space at a time).
  const [activeLease, setActiveLease] = useState<string | null>(null)
  const [readerId, setReaderId] = useState('')
  // Fix pass 5: Close pressed after the last space was taken, while the bill is
  // still being read again — the window waits (briefly) for that read.
  const [closing, setClosing] = useState(false)
  /** Fix round 2: nothing but the window's own buttons closes it, and not while money is moving. */
  const canClose = !saving && !anyReaderBusy && !closing
  /**
   * Close (or Cancel). A household with two spaces taps once per space: when
   * one was taken on the reader and the desk closes before the other, what was
   * taken is still said once the window is gone — never only the "Taken." line
   * that leaves with it. Fix pass 4: the same when every space was taken but
   * the window closed before the bill was read again (that read is what
   * finishes it) — the take is said, once. Fix pass 5: Close waits for that
   * read (up to CLOSE_READ_WAIT_MS), so an old balance the desk did not put on
   * the card is said in the same notice; a read that fails or is slow says the
   * take alone.
   */
  const close = async () => {
    if (!canClose) return
    const taken = takenOnReader
    if (taken > 0 && !finished.current) {
      if (allTapped) {
        setClosing(true)
        const after = await readBillAfterTake(refetch, takenAt)
        // The read may have finished the window meanwhile (it said everything, once).
        if (!finished.current) {
          finished.current = true
          onRecorded(readerFinishedMessage(name, taken, after))
        }
      } else {
        finished.current = true
        const restOpen = !!quote && (quote.rows.length > 0 || quote.oldBalance.length > 0)
        onRecorded(`Took ${money(taken)} by card on the reader from ${name}.${restOpen ? ' The rest of what they owe is still open.' : ''}`)
      }
    }
    onClose()
  }

  const figures = quote ? deskFigures(quote) : null
  // 10/4 (decisions #48.4): a card waiting on its bank has charged nothing —
  // its own line, out of "Already on its way" — and the window reads the bill
  // again by itself once the earliest such hold runs out (once per hold time,
  // and not while a card is on the reader or the window is finished).
  const onItsWay = quote ? deskOnItsWay(quote) : null
  const rereadAt = quote ? nextAwaitingRereadAt(quote) : null
  const rereadDoneFor = useRef<number | null>(null)
  useEffect(() => {
    if (rereadAt == null || done || anyReaderBusy || rereadDoneFor.current === rereadAt) return
    const t = setTimeout(() => { rereadDoneFor.current = rereadAt; refetch() },
      Math.max(0, rereadAt + AWAITING_CARD_REREAD_GRACE_MS - Date.now()))
    return () => clearTimeout(t)
  }, [rereadAt, done, anyReaderBusy])   // eslint-disable-line react-hooks/exhaustive-deps
  const stale = !!figures && !!answeredOn && !sameFigures(answeredOn, figures)
  // Answers given against other figures count for nothing — not even for the
  // one render before the effect below clears them.
  const liveChoice: CreditChoice = stale ? null : choice
  const liveSurplus = stale ? null : surplusHandling
  const liveWritten = stale ? false : writtenConfirmed

  /** The desk answered something: keep the figures it answered against (the first answer's). */
  const answered = () => { if (figures) setAnsweredOn(prev => prev ?? figures) }
  const clearAnswers = () => {
    setChoice(null); setShownCredit(null); setSurplusHandling(null); setWrittenConfirmed(false); setAnsweredOn(null)
  }
  /** The desk did something: the last message has been read. One message at a time. */
  const clearMsg = () => { setMsg(null); refusal.current = null }
  useEffect(() => {
    if (!stale || !answeredOn || !figures) return
    const text = refusal.current ?? figuresMovedMessage(answeredOn, figures)
    refusal.current = null
    clearAnswers()
    setMsg({ kind: 'warn', text })
  }, [stale])   // eslint-disable-line react-hooks/exhaustive-deps

  // The credit pays the whole bill: nothing is taken, and no method is asked.
  const creditOnly = !!quote && liveChoice === 'use' && creditChoiceNeeded(quote) && toCents(quote.owedIfUsed) === 0
  const method: ManualPaymentMethod | null = mode && mode !== 'reader' ? mode : (creditOnly && mode === null ? 'cash' : null)
  const tenderedCents = parseAmount(tendered)
  const towardOldCents = parseAmount(towardOld)
  // "Rent", "Water" — what each line of the bill is called (for "stays owed on October rent").
  const labelOf = (id: string, type: string) => labels.get(id)?.label ?? humanize(type)
  const plan = quote && method ? planTender(quote, {
    method, tenderedCents, choice: liveChoice, towardOldCents, surplusHandling: liveSurplus, writtenConfirmed: liveWritten,
    answeredCreditCents: liveChoice !== null ? shownCredit : null,
    nameOf: r => labelOf(r.id, r.type),
  }) : null
  // 10/5 (Nic): a bank deposit dated back that pays a bill only in part — the
  // late fees left off that bill go back on it (the server judges each bill).
  const feesBackCents = quote && plan && method === 'bank_deposit' && backdatedTo
    ? lateFeesBackOnShortBills(quote, plan.shortInvoiceIds) : 0
  const needNumber = !!method && numberRequired(method)
  const oldOwed = quote ? oldBalanceOwedCents(quote) : 0
  const anchor = quote ? postAnchor(quote) : null
  // The plan's own refusal, said only while no other message is up (one at a time).
  const planMsg = !msg && plan?.message && plan.stop && plan.stop !== 'written_confirm' && plan.stop !== 'choose_credit'
    && plan.stop !== 'surplus_choice' ? plan.message : null

  /** Something moved under the window (409): the figures are read again here and the questions asked again. */
  const askAgain = async (text: string) => {
    clearAnswers()
    refusal.current = null
    setMsg({ kind: 'warn', text })
    await refetch()
  }

  const record = async () => {
    if (!quote || !plan?.body || !anchor || !method) return
    if (needNumber && !reference.trim()) {
      setMsg({ kind: 'error', text: numberMissingMessage(method) })
      return
    }
    setSaving(true); clearMsg()
    try {
      const r: any = await apiPost(`/payments/${anchor}/record-manual`, {
        ...plan.body,
        reference: reference.trim() || undefined,
        // Today is the default: sent only when the deposit was made earlier.
        ...(method === 'bank_deposit' && depositedOn && depositedOn !== deskToday ? { depositedOn } : {}),
        // 10/6 (Nic): sent only when the box is shown and ticked.
        ...(onboardingBox && deleteOnboardingFee ? { deleteOnboardingLateFees: true } : {}),
      })
      const d = r?.data ?? {}
      // 10/5: a part payment says what stays owed, and on which bills.
      const stillOwedNames = (Array.isArray(d.stillOwedRows) ? d.stillOwedRows : [])
        .map((x: any) => billName(String(x.dueDate ?? ''), labelOf(String(x.restOf ?? x.id), String(x.type ?? ''))))
      // 10/5 (Nic): the photo of the bank's receipt goes on the payment just recorded.
      const photoNote = method === 'bank_deposit' ? await sendDepositPhoto(d.receiptId, photo) : null
      // A space taken on the reader earlier in this visit is said too (fix pass
      // 2): the closing notice is the only word on it once the window is gone.
      const text = withReaderTaken(recordedMessage(name, {
        ...d, stillOwedNames, depositedOn: method === 'bank_deposit' ? depositedOn : null,
      }), takenOnReader)
        + (photoNote ? ` ${photoNote}` : '')
      qc.invalidateQueries('outstanding-balances')
      qc.invalidateQueries(['balance-invoices', tenantId])
      qc.invalidateQueries('payments-ledger')
      // Cash, a check or a money order taken by hand goes in the next bank
      // deposit: "Make a bank deposit" lists it the next time it is looked at.
      qc.invalidateQueries('undeposited-cash')
      qc.invalidateQueries('deposit-slips')
      finish(text, Number(d.changeGiven ?? 0))
    } catch (e) {
      const status = serverStatus(e)
      const text = serverMessage(e, 'That payment could not be recorded. Nothing was recorded — try again.')
      if (status === 409) {
        await askAgain(text)
      } else if (status === 422) {
        // A refusal can come from figures that moved since the last read — credit
        // that appeared, a late fee that posted, another desk paying this bill.
        // Read the bill again here: if it changed under the desk's answers they
        // are asked again (with these words); if it did not, the words stay up.
        setMsg({ kind: 'error', text })
        refusal.current = text
        await refetch()
      } else {
        setMsg({ kind: 'error', text })
      }
    } finally {
      setSaving(false)
    }
  }

  // Reader: one block per lease, each taking its own tap. A space already taken
  // stays listed (as taken) once the bill is read again without it.
  const blocks = quote ? readerLeases(quote, Object.values(tapped).map(t => t.space)) : []
  // The property's readers, read on a space still open (fix pass 3: a space
  // already taken lists first, and its charge is no longer open — reading on it
  // is refused). Read once: the list stays put (and the reader chosen with it)
  // through a window focus or a take.
  const readersAnchor = blocks.find(b => tapped[b.leaseId] == null)?.anchorId ?? null
  const { data: readers = [], isLoading: readersLoading, error: readersError } = useQuery<any[]>(
    ['reader-readers', readersAnchor], () => apiGet<any[]>(`/payments/${readersAnchor}/reader/readers`),
    { enabled: mode === 'reader' && !!readersAnchor && !done, retry: false, keepPreviousData: true,
      staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false })
  useEffect(() => {
    if (mode === 'reader' && !readerId && readers.length === 1) setReaderId(readers[0].stripeReaderId)
  }, [mode, readers, readerId])
  const allTapped = blocks.length > 0 && blocks.every(b => tapped[b.leaseId] != null)
  const takenNames = blocks.filter(b => tapped[b.leaseId] != null && b.label).map(b => b.label as string)
  // Whose breakdown is on the reader: the space the desk started last, while it
  // is still to be taken; otherwise the first space not taken yet.
  const liveLease = activeLease && tapped[activeLease] == null && blocks.some(b => b.leaseId === activeLease)
    ? activeLease
    : blocks.find(x => tapped[x.leaseId] == null)?.leaseId ?? null
  // Every space taken: the window finishes once the bill has been read again
  // after the last card (or that read failed), so anything still open — an old
  // balance left behind — is said. Never once the window is already finished
  // (fix pass 3: a re-read behind the done screen must not overwrite it).
  const readAfterTake = takenAt > 0 && (dataUpdatedAt >= takenAt || errorUpdatedAt >= takenAt)
  useEffect(() => {
    if (!allTapped || !readAfterTake || finished.current) return
    const after = quote && dataUpdatedAt >= takenAt && !(errorUpdatedAt > dataUpdatedAt) ? quote : null
    qc.invalidateQueries('outstanding-balances')
    qc.invalidateQueries('payments-ledger')
    finish(readerFinishedMessage(name, takenOnReader, after), 0)
  }, [allTapped, readAfterTake])   // eslint-disable-line react-hooks/exhaustive-deps

  const pickMode = (m: ManualPaymentMethod | 'reader') => {
    setMode(m); setTendered(''); setReference(''); setPhoto(null); setDepositedOn(deskToday); setTowardOld('')
    setSurplusHandling(null); setWrittenConfirmed(false); clearMsg()
  }

  if (done) {
    // Decisions #16's rule for the register, here too: the change to hand back
    // stays on screen until the desk closes the window — with Done, never a
    // stray click outside it.
    return (
      <div className="modal-overlay">
        <div className="modal cd-window">
          <div className="modal-title">{name}</div>
          {done.change > 0 && (
            <div className="cd-change">
              <div className="cd-change-label">Give change</div>
              <div className="cd-change-amount mono">{money(done.change)}</div>
            </div>
          )}
          <div className="alert alert-success cd-msg">{done.text}</div>
          <div className="cd-actions">
            <button className="btn btn-primary cd-grow" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    )
  }

  const nothingHere = !!quote && quote.rows.length === 0 && quote.oldBalance.length === 0
  // Nothing left to take here: ONE message. When a refusal or a moved figure
  // brought the window here (another desk paid it, the space went into eviction
  // mode), it says that what they owe changed and where it stands now — never
  // the server's refusal beside "Nothing is owed" (fix round 2).
  const nothingText = !quote ? '' : quote.paymentsPaused
    ? 'This space is in eviction mode — recording a payment is paused. Contact the landlord.'
    : toCents(quote.payOnlineTotal) > 0
      ? `Everything open here (${money(quote.payOnlineTotal)}) is paid online, not at the desk.`
      : 'Nothing is owed here right now.'
  const nothingMsg: Msg = !nothingHere ? null
    : msg?.kind === 'success' ? msg
      : msg?.kind === 'warn' || msg?.kind === 'error'
        ? { kind: 'warn', text: `What they owe changed while this window was open. ${nothingText}` }
        : { kind: 'info', text: nothingText }
  const usable = quote ? toCents(quote.creditAvailable) : 0
  const creditUsedCents = liveChoice === 'use' ? usable : 0
  const answerCredit = (c: 'use' | 'save') => {
    setChoice(c); setShownCredit(usable); answered(); clearMsg()
  }

  return (
    <div className="modal-overlay">
      <div className="modal cd-window">
        <div className="cd-head">
          <div className="modal-title cd-title">{name}</div>
          <div className="cd-sub">Record a payment taken at the desk</div>
        </div>

        <div className="cd-window-body">
          {isLoading ? (
            <div className="cd-muted">Reading what they owe…</div>
          ) : quoteError ? (
            <div className="cd-stack">
              <Message msg={{ kind: 'error', text: serverMessage(quoteError, 'What they owe could not be read.') }} />
              <div><button className="btn btn-primary btn-sm" disabled={isFetching} onClick={() => refetch()}>{isFetching ? 'Reading…' : 'Read it again'}</button></div>
            </div>
          ) : quote ? (<>
            {/* ── The whole balance, the way the desk takes it ── */}
            <div className="cd-bill">
              <BillLines title="This bill" rows={quote.rows} labels={labels} />
              {quote.rows.length > 0 && (
                <div className="cd-line cd-line-total"><span>This bill</span><span className="mono">{money(quote.currentTotal)}</span></div>
              )}
              <BillLines title="Old balance" sub="paid last, from whatever is over this bill" rows={quote.oldBalance} labels={labels} />
              {toCents(quote.payOnlineTotal) > 0 && (
                <div className="cd-line cd-line-muted">
                  <span>Pay online (GAM charges and other companies' — not taken at the desk)</span>
                  <span className="mono">{money(quote.payOnlineTotal)}</span>
                </div>
              )}
              {toCents(quote.pausedTotal) > 0 && (
                <div className="cd-line cd-line-muted">
                  <span>On hold for an eviction — no payment can be taken for it</span>
                  <span className="mono">{money(quote.pausedTotal)}</span>
                </div>
              )}
              {onItsWay && onItsWay.awaiting.map((a, i) => (
                <div key={`awaiting-${i}`} className="cd-line cd-line-muted">
                  <span>
                    Waiting on {a.payerName ? `${a.payerName}’s` : 'a'} card bank to confirm — nothing charged yet.
                    {' '}If it is not confirmed, this opens here at {awaitingOpensAtWord(a)}.
                  </span>
                  <span className="mono">{money(a.heldAmount)}</span>
                </div>
              ))}
              {onItsWay && toCents(onItsWay.clearing) > 0 && (
                <div className="cd-line cd-line-muted">
                  <span>Already on its way (a card or bank payment clearing) — not owed</span>
                  <span className="mono">{money(onItsWay.clearing)}</span>
                </div>
              )}
              <div className="cd-line cd-line-total"><span>Full balance</span><span className="mono">{money(quote.fullBalance)}</span></div>
            </div>

            {/* Fix pass 2: a space taken on the reader is off the bill above (it was
                read again the moment the card went through); what was taken is
                said beside it, so the desk never asks for it twice. */}
            {takenOnReader > 0 && (
              <div className="cd-note">
                Taken on the reader: {money(takenOnReader)} by card (card fee included)
                {takenNames.length > 0 ? ` for ${takenNames.join(' and ')}` : ''}. The bill above is what is left.
              </div>
            )}

            {quote.scheduledRetries.length > 0 && (
              <div className="cd-note">
                A bank payment is set to try again{quote.scheduledRetries[0].nextRetryAt ? ` on ${dayWord(String(quote.scheduledRetries[0].nextRetryAt).slice(0, 10))}` : ''}.
                Recording a payment now replaces it.
              </div>
            )}

            {nothingHere ? (
              <Message msg={nothingMsg} />
            ) : (<>
              {/* ── Credit: beside the bill, used only when the desk says so.
                  The card reader asks its own Use / Save per space (fix round 2:
                  never the same question twice, one answer of which does nothing). ── */}
              {creditChoiceNeeded(quote) && mode !== 'reader' && (
                <div className="cd-credit">
                  <div className="cd-credit-head">
                    Credit available <span className="mono">{money(quote.creditAvailable)}</span>
                    {toCents(quote.creditOnFile) > usable && (
                      <span className="cd-line-meta"> ({money(quote.creditOnFile)} on file)</span>
                    )}
                  </div>
                  {liveChoice === null ? (<>
                    <div className="cd-credit-ask">Ask them: use their credit on this bill, or save it for later?</div>
                    <div className="cd-choice">
                      <button className="btn btn-primary" onClick={() => answerCredit('use')}>
                        Use {money(quote.creditAvailable)} — they owe {money(quote.owedIfUsed)}
                      </button>
                      <button className="btn btn-primary" onClick={() => answerCredit('save')}>
                        Save it — they owe {money(quote.owedIfSaved)}
                      </button>
                    </div>
                  </>) : (
                    <div className="cd-chosen">
                      <span>
                        {liveChoice === 'use'
                          ? <>Using {money(toDollars(shownCredit ?? usable))} of credit — they owe <strong className="mono">{money(quote.owedIfUsed)}</strong></>
                          : <>Saving the credit — they owe <strong className="mono">{money(quote.owedIfSaved)}</strong></>}
                      </span>
                      <button className="btn btn-ghost btn-sm" onClick={() => { clearAnswers(); clearMsg() }}>Change</button>
                    </div>
                  )}
                </div>
              )}
              {toCents(quote.creditSetAsideElsewhere) > 0 && (
                <div className="cd-note">
                  {money(quote.creditSetAsideElsewhere)} of their credit is set aside by a bank payment that is retrying on another bill.
                  It can be used here once that payment clears or fails.
                </div>
              )}

              {/* ── How they are paying ── */}
              <div className="cd-methods" role="group" aria-label="How they are paying">
                {/* While the reader is taking a card, the method stays put: switching
                    away would cancel a charge the customer is about to tap. */}
                {MANUAL_PAYMENT_METHODS.map(m => (
                  <button key={m} type="button" className={`cd-option${mode === m ? ' on' : ''}`} disabled={anyReaderBusy || closing}
                    title={anyReaderBusy ? 'Finish or cancel the payment on the reader first' : undefined}
                    onClick={() => pickMode(m)}>
                    <span className="cd-option-title">{MANUAL_PAYMENT_METHOD_LABELS[m]}</span>
                  </button>
                ))}
                {blocks.length > 0 && (
                  <button type="button" className={`cd-option${mode === 'reader' ? ' on' : ''}`} disabled={anyReaderBusy || closing}
                    onClick={() => pickMode('reader')}>
                    <span className="cd-option-title">Card on the reader</span>
                  </button>
                )}
              </div>

              {method && mode !== null && (<>
                <label className="cd-field">
                  <span className="cd-field-label">{AMOUNT_FIELD_LABEL[method]}</span>
                  <input className="form-input mono" inputMode="decimal" autoFocus
                    placeholder={plan ? toDollars(plan.owedCents).toFixed(2) : ''}
                    value={tendered}
                    onChange={e => { setTendered(e.target.value); setWrittenConfirmed(false); setSurplusHandling(null); clearMsg() }} />
                </label>
                {needNumber && (
                  <label className="cd-field">
                    <span className="cd-field-label">{NUMBER_FIELD_LABEL[method]}</span>
                    <input className="form-input" value={reference} maxLength={120} placeholder="e.g. 1042"
                      onChange={e => { setReference(e.target.value); clearMsg() }} />
                  </label>
                )}
                {method === 'bank_deposit' && (
                  <label className="cd-field">
                    <span className="cd-field-label">Date deposited</span>
                    <input className="form-input" type="date" value={depositedOn} max={deskToday}
                      onChange={e => { setDepositedOn(e.target.value); clearMsg() }} />
                  </label>
                )}
                {/* 10/5 (Nic): late fees go by the day the money went into the bank. */}
                {method === 'bank_deposit' && backdatedTo && toCents(quote?.lateFeesOffIfPaidInFull) > 0 && (
                  <div className="cd-note" role="status">
                    Deposited before {money(quote!.lateFeesOffIfPaidInFull!)} in late fees were charged: they are left
                    off this bill, and come off each bill this deposit pays in full. A bill it pays only in part keeps its late fees.
                  </div>
                )}
                {onboardingBox && (
                  <OnboardingLateFeeBox checked={deleteOnboardingFee} disabled={saving}
                    onChange={v => { setDeleteOnboardingFee(v); clearMsg() }} />
                )}
                {/* 10/5 (Nic): "maybe ... add a picture of the receipt" — a bank deposit only. */}
                {method === 'bank_deposit' && (
                  <DepositPhotoField photo={photo} disabled={saving}
                    onPick={(f, problem) => { setPhoto(f); if (problem) setMsg({ kind: 'error', text: problem }); else clearMsg() }} />
                )}

                {/* 10/5 (Nic): the property takes part payments — what stays owed after this one. */}
                {plan && plan.stop === null && plan.stillOwedText && (
                  <div className="alert alert-warn cd-msg" role="status">
                    Part payment. {feesBackCents > 0
                      ? `${stillOwedText(plan.stillOwedCents + feesBackCents, plan.stillOwedNames)} That includes ${money(toDollars(feesBackCents))} in late fees, which stay on a bill paid only in part.`
                      : plan.stillOwedText}
                    {plan.toOldCents > 0 ? ` ${money(toDollars(plan.toOldCents))} goes to the old balance.` : ''}
                    {plan.keptAsCreditCents > 0 ? ` ${money(toDollars(plan.keptAsCreditCents))} is kept on their account as credit.` : ''}
                  </div>
                )}

                {/* Cash over the bill with change given: some of it may go to the old balance. */}
                {method === 'cash' && oldOwed > 0 && liveSurplus !== 'credit' && plan && plan.overCents > 0 && (
                  <label className="cd-field">
                    <span className="cd-field-label">Also toward the old balance (optional, up to {money(toDollars(Math.min(plan.overCents, oldOwed)))})</span>
                    <input className="form-input mono" inputMode="decimal" placeholder="0.00" value={towardOld}
                      onChange={e => { setTowardOld(e.target.value); clearMsg() }} />
                  </label>
                )}

                {planMsg && plan?.stop === 'short' && <Message msg={{ kind: 'error', text: planMsg }} />}

                {/* A check or money order over the bill: is it really that much? */}
                {plan?.stop === 'written_confirm' && (
                  <div className="cd-confirm">
                    <div>{plan.message}</div>
                    <div className="cd-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => { setWrittenConfirmed(true); answered(); clearMsg() }}>
                        Yes, it is {money(toDollars(tenderedCents ?? 0))}
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => { setTendered(''); clearMsg() }}>Change the amount</button>
                    </div>
                  </div>
                )}

                {/* Cash over the bill: hand it back, or keep it. Nothing is chosen for them. */}
                {method === 'cash' && plan && plan.overCents > 0 && plan.stop !== 'short' && plan.stop !== 'too_much_to_old'
                  && (plan.ifChange.changeCents > 0 || plan.ifKept.creditCents > 0) && (
                  <div className="cd-stack">
                    <div className="cd-over">{money(toDollars(plan.overCents))} over the bill</div>
                    <div className="cd-surplus">
                      <button type="button" className={`cd-option${liveSurplus === 'change' ? ' on' : ''}`}
                        onClick={() => { setSurplusHandling('change'); answered(); clearMsg() }}>
                        <span className="cd-option-title">Give {money(toDollars(plan.ifChange.changeCents))} change</span>
                        {plan.ifChange.toOldCents > 0 && (
                          <span className="cd-option-sub">{money(toDollars(plan.ifChange.toOldCents))} goes to the old balance</span>
                        )}
                      </button>
                      {/* Kept cash pays the old balance first; only a part left over as
                          credit is barred while credit is being used (the server's rule). */}
                      <button type="button" className={`cd-option${liveSurplus === 'credit' ? ' on' : ''}`}
                        disabled={creditUsedCents > 0 && plan.ifKept.creditCents > 0}
                        onClick={() => { setSurplusHandling('credit'); answered(); clearMsg() }}>
                        <span className="cd-option-title">Keep it — no change on hand</span>
                        <span className="cd-option-sub">
                          {creditUsedCents > 0 && plan.ifKept.creditCents > 0
                            ? 'Not while credit is being used on this bill'
                            : [
                                plan.ifKept.toOldCents > 0 ? `${money(toDollars(plan.ifKept.toOldCents))} pays the old balance` : null,
                                plan.ifKept.creditCents > 0 ? `${money(toDollars(plan.ifKept.creditCents))} kept as credit` : null,
                              ].filter(Boolean).join(', ')}
                        </span>
                      </button>
                    </div>
                  </div>
                )}

                {planMsg && plan?.stop !== 'short' && <Message msg={{ kind: 'error', text: planMsg }} />}
                {method !== 'cash' && plan && plan.stop === null && plan.surplusCents > 0 && !plan.stillOwedText && (
                  <div className="cd-note">
                    No change is given on a {MANUAL_PAYMENT_METHOD_WORD[method]}.
                    {plan.toOldCents > 0 ? ` ${money(toDollars(plan.toOldCents))} pays the old balance;` : ''}
                    {' '}{money(toDollars(plan.surplusCents))} stays on their account as credit. {CREDIT_USE_RULE}
                  </div>
                )}
              </>)}

              {mode === 'reader' && (
                <div className="cd-stack">
                  <span className="cd-field-label">Reader</span>
                  {readersLoading ? (
                    <div className="cd-muted">Looking for readers at this property…</div>
                  ) : readersError ? (
                    <Message msg={{ kind: 'error', text: serverMessage(readersError, 'The readers for this property could not be read.') }} />
                  ) : readers.length === 0 ? (
                    <Message msg={{ kind: 'error', text: 'No reader is paired at this property. Pair one under Point of Sale → Readers.' }} />
                  ) : readers.length === 1 ? (
                    <div className="cd-strong">{readers[0].nickname}</div>
                  ) : (
                    <select className="form-select" value={readerId} onChange={e => setReaderId(e.target.value)}>
                      <option value="">Choose a reader…</option>
                      {readers.map((r: any) => <option key={r.stripeReaderId} value={r.stripeReaderId}>{r.nickname}</option>)}
                    </select>
                  )}
                  {blocks.map(b => (
                    <ReaderLeaseBlock key={b.leaseId} anchorId={b.anchorId} label={b.label} readerId={readerId}
                      done={tapped[b.leaseId] != null}
                      live={b.leaseId === liveLease}
                      othersBusy={Object.entries(readerBusy).some(([lease, on]) => on && lease !== b.leaseId)}
                      billReadAgain={readAgain}
                      onDone={total => {
                        setTapped(prev => ({ ...prev, [b.leaseId]: { total, space: { leaseId: b.leaseId, anchorId: b.anchorId, unitNumber: b.unitNumber } } }))
                        // Fix pass 2: the bill is read again now, so a space taken on
                        // the card is never asked for again in cash, by check or from
                        // credit. Answers given against the whole bill go with it
                        // (the desk took this space itself: nothing to warn about).
                        // Fix pass 3: the other spaces read their own figures again
                        // too (a household credit used on this space moved them).
                        clearAnswers()
                        setTakenAt(Date.now())
                        setReadAgain(n => n + 1)
                        qc.invalidateQueries('outstanding-balances')
                        qc.invalidateQueries(['balance-invoices', tenantId])
                        qc.invalidateQueries('payments-ledger')
                        refetch({ cancelRefetch: true })
                      }}
                      onBusy={on => {
                        setReaderBusy(prev => (prev[b.leaseId] === on ? prev : { ...prev, [b.leaseId]: on }))
                        if (on) setActiveLease(b.leaseId)
                      }}
                      onMoved={() => { qc.invalidateQueries(quoteKey) }} />
                  ))}
                  <div className="cd-note">
                    Settles the bill in full. The money lands with GAM and reaches you in the next payout, like any
                    card payment; the card fee is the customer&apos;s.
                  </div>
                </div>
              )}

              {tenantId && <PriorArrangement tenantId={tenantId} rows={quote.rows}
                // Not while money is moving or the bill is being read again
                // after a card was taken: the row on screen may be the one the
                // card just paid (the server would only refuse it).
                disabled={saving || anyReaderBusy || closing || (takenAt > 0 && isFetching)}
                onDone={async (text) => { setMsg({ kind: 'success', text }); qc.invalidateQueries('outstanding-balances'); await refetch() }}
                onError={async (text) => {
                  // A refusal can mean the charge moved (paid meanwhile): read the bill again too.
                  setMsg({ kind: 'error', text }); refusal.current = text; await refetch()
                }} />}
            </>)}

            {!nothingHere && <Message msg={msg} />}
          </>) : null}
        </div>

        <div className="cd-actions cd-footer">
          {method && quote && !nothingHere && (
            <button className="btn btn-primary cd-grow"
              disabled={saving || closing || isFetching || !plan || plan.stop !== null || !anchor || (needNumber && !reference.trim())
                || (method === 'bank_deposit' && (!depositedOn || depositedOn > deskToday))}
              onClick={record}>
              {saving ? 'Recording…'
                : creditOnly && (tenderedCents ?? 0) === 0
                  ? 'Pay with credit — nothing taken'
                  : `Record ${tenderedCents != null ? money(toDollars(tenderedCents)) : 'payment'}`}
            </button>
          )}
          <button className="btn btn-ghost" disabled={!canClose}
            title={anyReaderBusy ? 'Finish or cancel the payment on the reader first' : undefined}
            onClick={close}>
            {closing ? 'Checking what is still open…' : mode === 'reader' ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * S568: during a landlord's move onto GAM, the FIRST rent bill of a lease may
 * already have been collected by the old system. It comes off the books here
 * with no money moving (the server gates it to the reconciliation window).
 */
function PriorArrangement({ tenantId, rows, disabled = false, onDone, onError }: {
  tenantId: string; rows: DeskQuoteRow[]; disabled?: boolean
  onDone: (text: string) => void; onError: (text: string) => void
}) {
  // Only this bill's rent charges can be the lease's first one. They are read
  // by id from the months they are due in, page by page (fix round 3): one
  // 1,000-charge page of every open rent charge left a large portfolio's
  // household out, with no button and no sign of it.
  const rent = rows.filter(r => r.type === 'rent')
  const ids = rent.map(r => r.id).sort()
  const range = chargeMonthsRange(rent.map(r => r.dueDate))
  const { data: eligible = [] } = useQuery<any[]>(
    ['desk-prior-arrangement', tenantId, ids.join(',')],
    async () => {
      const { rows: found } = await readChargesById<any>(
        page => apiGet<any[]>(`/payments?type=rent&from=${range!.from}&to=${range!.to}&limit=${CHARGE_PAGE_SIZE}&page=${page}`),
        new Set(ids))
      return found.filter((p: any) => p.tenantId === tenantId && p.priorArrangementEligible)
    },
    { enabled: ids.length > 0 && !!range, staleTime: 0, retry: false })
  const [busy, setBusy] = useState<string | null>(null)
  const mine = eligible.filter((p: any) => ids.includes(p.id))
  if (!mine.length) return null
  return (
    <div className="cd-prior">
      <div className="cd-section-label">Onboarding</div>
      <div className="cd-note">
        Was this first rent already collected through your old system (their old autopay had not switched over yet)?
        Mark it paid so they are not charged twice — no money moves.
      </div>
      {mine.map((p: any) => (
        <button key={p.id} className="btn btn-primary btn-sm" disabled={busy !== null || disabled}
          onClick={async () => {
            if (busy !== null || disabled) return
            setBusy(p.id)
            try {
              await apiPost(`/payments/${p.id}/record-prior-arrangement`, {})
              onDone(`Rent due ${dayWord(String(p.dueDate).slice(0, 10))} marked as already collected through the old system.`)
            } catch (e) {
              onError(serverMessage(e, 'That could not be marked. Nothing was changed.'))
            } finally { setBusy(null) }
          }}>
          {busy === p.id ? 'Marking…' : `Already collected through my old system — ${money(p.amount)} due ${dayWord(String(p.dueDate).slice(0, 10))}`}
        </button>
      ))}
    </div>
  )
}

/**
 * One lease's card on the counter reader (S654), with the credit question and
 * the optional old-balance amount asked BEFORE the amount goes to the reader
 * (Nic, 10/2). The figure is always the server's quote for exactly what was
 * chosen. If the balance or the credit moved by the time the card is approved,
 * the server releases the hold and books nothing; the block reads the bill
 * again in place and asks again.
 */
function ReaderLeaseBlock({ anchorId, label, readerId, done, live, othersBusy = false, billReadAgain = 0, onDone, onMoved, onBusy }: {
  anchorId: string; label: string | null; readerId: string; done: boolean
  /**
   * Fix pass 3: goes up each time another space of the household is taken on
   * the reader. This space then reads its own figures again (a household
   * credit used there moved them) — a moved credit is asked again here.
   */
  billReadAgain?: number
  /** Its breakdown is the one on the reader (the space the desk started last, else the first not taken). */
  live: boolean
  /**
   * Fix pass 2: another space of the household is on the reader (sending,
   * waiting for the tap or the card, recording it). One reader takes one
   * charge: sending this one would pull that charge off the reader, so Send
   * waits until it is taken or canceled.
   */
  othersBusy?: boolean
  onDone: (total: number) => void; onMoved: () => void
  /** True from the moment the amount goes to the reader until it is taken, canceled or waits to be sent again. */
  onBusy?: (busy: boolean) => void
}) {
  const qc = useQueryClient()
  const [choice, setChoice] = useState<CreditChoice>(null)
  // The credit figure the desk read out when it answered — sent back with the answer.
  const [shownCredit, setShownCredit] = useState(0)
  const [oldTyped, setOldTyped] = useState('')
  const [oldCommitted, setOldCommitted] = useState<number | null>(null)
  const [stage, setStage] = useState<'idle' | 'tap' | 'sending' | 'waiting' | 'capturing' | 'done'>(done ? 'done' : 'idle')
  const [canResend, setCanResend] = useState(false)
  // From the moment the amount goes to the reader until it is finished (or a
  // charge waits to be sent again), the figures are not read again: a fresh
  // read mid-tap could only interrupt a payment the reader is already taking.
  // The server checks the balance again when the card is approved.
  const busy = stage === 'sending' || stage === 'waiting' || stage === 'capturing'
  // Fix pass 3: from the click on Send — before the breakdown is put up — this
  // space holds the reader, so no other space can be sent in that moment.
  const [starting, setStarting] = useState(false)
  const startingRef = useRef(false)
  const othersBusyRef = useRef(othersBusy); othersBusyRef.current = othersBusy
  const locked = busy || starting || stage === 'tap' || stage === 'done' || canResend
  const quoteKey = ['reader-quote', anchorId, choice, shownCredit, oldCommitted]
  const { data: quote, isLoading: quoting, error: quoteError, isFetching: quoteFetching, isPreviousData } = useQuery<ReaderQuote>(
    quoteKey, () => apiGet<ReaderQuote>(`/payments/${anchorId}/reader/quote${readerQuoteQuery(shownCredit, choice, oldCommitted)}`),
    // Fix pass 4: a space already taken is never read again — its charge is no
    // longer open, so the read is refused (a stray "no longer open" beside
    // "Taken." when the block comes back after Cash → Card, or "Read it again").
    { staleTime: 0, cacheTime: 0, retry: false, keepPreviousData: true, refetchOnWindowFocus: !locked, enabled: !done })
  const choiceBody = () => readerChoiceParams(shownCredit, choice, oldCommitted)
  // Fix round 2: the figures on screen belong to the CURRENT answers only. While
  // the quote for a new Use / Save answer or a new old-balance amount is on its
  // way (the previous one is kept on screen meanwhile), or an old-balance amount
  // is typed but not yet applied, no total is shown and nothing can be sent —
  // the desk never reads out a figure for answers it no longer has.
  const oldPending = parseAmount(oldTyped) !== oldCommitted
  const quoteCurrent = !!quote && !isPreviousData && !quoteFetching && !oldPending
  const ready = quoteCurrent ? readerReady(quote, choice) : { ready: false, reason: null }
  useEffect(() => {
    onBusy?.(busy || starting || stage === 'tap')
  }, [busy, stage, starting])   // eslint-disable-line react-hooks/exhaustive-deps
  // Another space was taken: read this one's figures again, unless it is in
  // the middle of its own payment (the capture checks the balance itself).
  useEffect(() => {
    if (!billReadAgain || done || locked) return
    qc.invalidateQueries(['reader-quote', anchorId])
  }, [billReadAgain])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onBusy?.(false), [])   // eslint-disable-line react-hooks/exhaustive-deps

  const [tapEndsAt, setTapEndsAt] = useState<number | null>(null)
  const [tapNow, setTapNow] = useState(Date.now())
  const tapWaiter = useRef<((o: 'tapped' | 'cancel') => void) | null>(null)
  useEffect(() => {
    if (!tapEndsAt) return
    const t = setInterval(() => setTapNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [tapEndsAt])
  const waitForTap = () => new Promise<'tapped' | 'time' | 'cancel'>(resolve => {
    const ms = TAP_WINDOW_SECONDS * 1000
    const finish = (o: 'tapped' | 'time' | 'cancel') => { clearTimeout(timer); tapWaiter.current = null; setTapEndsAt(null); resolve(o) }
    const timer = setTimeout(() => finish('time'), ms)
    tapWaiter.current = finish
    setTapNow(Date.now()); setTapEndsAt(Date.now() + ms)
  })
  const [msg, setMsg] = useState<Msg>(null)
  const attempt = useRef(0)
  const livePi = useRef<string | null>(null)
  const readerRef = useRef(readerId); readerRef.current = readerId
  const [onReader, setOnReader] = useState<{ shown: boolean; busy?: string } | null>(null)
  const breakdownOn = useRef<string | null>(null)
  // Another space took the reader's screen: this one's breakdown is no longer
  // up, so it is shown again (never assumed) when this space is sent.
  useEffect(() => { if (!live) setOnReader(null) }, [live])

  /**
   * The balance or the credit moved: nothing may be charged on the old figures.
   * Any charge still on the reader is canceled (never left as a hold a later tap
   * could approve), any wait for it stops, and the bill is read again and asked
   * again, here.
   */
  const moved = (text: string) => {
    attempt.current++
    tapWaiter.current?.('cancel')
    const pi = livePi.current; livePi.current = null
    if (pi) apiPost(`/payments/reader/intents/${pi}/cancel`, { stripeReaderId: readerRef.current }).catch(() => {})
    setChoice(null); setShownCredit(0); setOldTyped(''); setOldCommitted(null)
    setCanResend(false); setStage('idle')
    setMsg({ kind: 'warn', text })
    qc.invalidateQueries(['reader-quote', anchorId])
    onMoved()
  }

  // The breakdown goes on the reader as soon as the total is known (S654), for
  // the choice the desk made — never before the credit question is answered.
  useEffect(() => {
    if (breakdownOn.current && breakdownOn.current !== readerId && stage === 'idle') {
      const old = breakdownOn.current; breakdownOn.current = null; setOnReader(null)
      apiPost(`/payments/${anchorId}/reader/show`, { stripeReaderId: old, clear: true }).catch(() => {})
    }
    if (!live || !quote || !readerId || stage !== 'idle' || !ready.ready) return
    let cancelled = false
    apiPost(`/payments/${anchorId}/reader/show`, { stripeReaderId: readerId, ...choiceBody() })
      .then((r: any) => { if (r.data?.shown) breakdownOn.current = readerId; if (!cancelled) setOnReader(r.data ?? { shown: false }) })
      .catch(() => { if (!cancelled) setOnReader({ shown: false }) })
    return () => { cancelled = true }
  }, [live, quote?.total, readerId, stage, ready.ready])   // eslint-disable-line react-hooks/exhaustive-deps
  // Closing the window mid-flow clears the reader and releases any hold.
  useEffect(() => () => {
    attempt.current++
    tapWaiter.current?.('cancel')
    const pi = livePi.current; livePi.current = null
    if (pi) apiPost(`/payments/reader/intents/${pi}/cancel`, { stripeReaderId: readerRef.current }).catch(() => {})
    else if (breakdownOn.current) apiPost(`/payments/${anchorId}/reader/show`, { stripeReaderId: breakdownOn.current, clear: true }).catch(() => {})
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // A credit that moved since the desk answered: the quote for that answer is
  // refused (409); ask again with the new figure, here — but never in the
  // middle of a payment on the reader (the capture checks the balance itself).
  useEffect(() => {
    if (!locked && quoteError && serverStatus(quoteError) === 409 && choice !== null) {
      moved(serverMessage(quoteError, 'Their credit changed. Ask them again: use it or save it.'))
    }
  }, [quoteError, locked])   // eslint-disable-line react-hooks/exhaustive-deps

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  /** The hold taken at the click is handed to the stage (or dropped on the way out). */
  const release = () => { if (startingRef.current) { startingRef.current = false; setStarting(false) } }
  const send = async () => {
    // One space on the reader at a time — checked at the click itself, and the
    // reader held from this moment (fix pass 3).
    if (othersBusyRef.current || startingRef.current) return
    startingRef.current = true; setStarting(true); onBusy?.(true)
    try { await sendNow() } finally { release() }
  }
  const sendNow = async () => {
    const mine = ++attempt.current
    const isLive = () => attempt.current === mine
    let cartOnReader = live && !!onReader?.shown && breakdownOn.current === readerId
    setMsg(null); setOnReader(null)
    let piId: string | null = null
    try {
      if (!cartOnReader) {
        const r: any = await apiPost(`/payments/${anchorId}/reader/show`, { stripeReaderId: readerId, ...choiceBody() }).catch(() => null)
        cartOnReader = !!r?.data?.shown
        if (cartOnReader) breakdownOn.current = readerId
      }
      if (!isLive()) return
      if (cartOnReader) {
        release(); setStage('tap')
        const outcome = await waitForTap()
        if (!isLive()) return
        if (outcome === 'cancel') { setStage('idle'); return }
      }
      release(); setStage('sending')
      let resent = false
      if (canResend && livePi.current) {
        try {
          const again: any = await apiPost(`/payments/reader/intents/${livePi.current}/resend`, { stripeReaderId: readerId, cartOnReader })
          piId = again.data.paymentIntentId; resent = true
        } catch (e) {
          const text = serverMessage(e, '')
          if (/already approved/i.test(text)) { piId = livePi.current; resent = true }
          else {
            apiPost(`/payments/reader/intents/${livePi.current}/cancel`, { stripeReaderId: readerId }).catch(() => {})
            livePi.current = null
            if (serverStatus(e) === 409) { moved(`${text || 'The balance changed since this charge was created.'} Nothing was charged — the bill was read again.`); return }
          }
        }
      }
      if (!resent) {
        const r: any = await apiPost(`/payments/${anchorId}/reader/charge`, { stripeReaderId: readerId, cartOnReader, ...choiceBody() })
        piId = r.data.paymentIntentId
      }
      setCanResend(false)
      if (!isLive()) { apiPost(`/payments/reader/intents/${piId}/cancel`, { stripeReaderId: readerId }).catch(() => {}); return }
      livePi.current = piId
      setStage('waiting')
      const deadline = Date.now() + 180_000
      let st: any = null
      while (Date.now() < deadline) {
        st = await apiGet<any>(`/payments/reader/intents/${piId}`)
        if (!isLive()) return
        if (st.lastPaymentError) throw new Error(st.lastPaymentError)
        if (st.status === 'requires_capture' || st.status === 'succeeded') break
        if (st.status === 'canceled') throw new Error('Canceled on the reader')
        await sleep(2000)
        if (!isLive()) return
      }
      if (!st || (st.status !== 'requires_capture' && st.status !== 'succeeded')) {
        throw new Error('The reader timed out waiting for the card')
      }
      setStage('capturing')
      let result: any
      try {
        result = await apiPost(`/payments/reader/intents/${piId}/capture`, {})
      } catch (e) {
        // The server released the hold and booked nothing: the bill moved.
        if (serverStatus(e) === 409 && !/not approved/i.test(serverMessage(e, ''))) {
          if (isLive()) moved(serverMessage(e, 'The balance changed. The hold on the card was released and nothing was charged.'))
          return
        }
        throw e
      }
      livePi.current = null
      if (!isLive()) return
      setStage('done')
      onDone(Number(result.data.total ?? quote?.total ?? 0))
    } catch (e: any) {
      if (!isLive()) return
      const text = serverMessage(e, e?.message || 'The reader did not complete the payment')
      if (!piId && serverStatus(e) === 409) { moved(text); return }
      if (piId) {
        await apiPost(`/payments/reader/intents/${piId}/clear-reader`, { stripeReaderId: readerId }).catch(() => {})
        if (!isLive()) return
        setStage('idle')
        livePi.current = piId; setCanResend(true)
        setMsg({ kind: 'error', text: /timed out/i.test(text)
          ? 'No card was presented. Send it to the reader again when they are ready.'
          : `${text} — send again to try another card.` })
      } else {
        setStage('idle')
        setMsg({ kind: 'error', text })
      }
    }
  }
  const cancel = async () => {
    attempt.current++
    const pi = livePi.current
    if (pi) await apiPost(`/payments/reader/intents/${pi}/clear-reader`, { stripeReaderId: readerId }).catch(() => {})
    setCanResend(!!pi)
    setStage('idle'); setMsg({ kind: 'info', text: pi ? 'Cleared from the reader. Send again when they are ready.' : 'Canceled.' })
  }
  const tapSecondsLeft = tapEndsAt ? Math.max(0, Math.ceil((tapEndsAt - tapNow) / 1000)) : 0
  const firstQuoteCredit = quote ? quote.usableCredit : 0

  // Fix pass 4: a space taken is only its name and "Taken." — the same whether
  // it was taken in this block or the block came back afterwards (its figures
  // are not read again, and there is nothing left to ask or send).
  if (done) {
    return (
      <div className="cd-reader-block">
        {label && <div className="cd-section-label">{label}</div>}
        <div className="cd-done-line">Taken.</div>
      </div>
    )
  }

  return (
    <div className="cd-reader-block">
      {label && <div className="cd-section-label">{label}</div>}
      {quoting && !quote ? (
        <div className="cd-muted">Working out the total…</div>
      ) : quoteError && !quote ? (
        <Message msg={{ kind: 'error', text: serverMessage(quoteError, 'The total could not be worked out.') }} />
      ) : quote ? (<>
        <div className="cd-line"><span>Owed on this space</span><span className="mono">{money(quote.outstanding)}</span></div>
        {toCents(firstQuoteCredit) > 0 && (
          choice === null ? (
            <div className="cd-credit">
              <div className="cd-credit-head">Credit available <span className="mono">{money(firstQuoteCredit)}</span></div>
              <div className="cd-credit-ask">Ask them before sending the amount: use their credit, or save it?</div>
              <div className="cd-choice">
                <button className="btn btn-primary" disabled={locked}
                  onClick={() => { setShownCredit(firstQuoteCredit); setChoice('use'); setMsg(null) }}>
                  Use {money(firstQuoteCredit)}{quote.ifUsed ? ` — card ${money(quote.ifUsed.total)}` : ''}
                </button>
                <button className="btn btn-primary" disabled={locked}
                  onClick={() => { setShownCredit(firstQuoteCredit); setChoice('save'); setMsg(null) }}>
                  Save it{quote.ifSaved ? ` — card ${money(quote.ifSaved.total)}` : ''}
                </button>
              </div>
            </div>
          ) : (
            <div className="cd-chosen">
              <span>{choice === 'use' ? `Using ${money(shownCredit)} of credit` : 'Saving the credit'}</span>
              {!locked && <button className="btn btn-ghost btn-sm" onClick={() => { setChoice(null); setShownCredit(0) }}>Change</button>}
            </div>
          )
        )}
        {toCents(quote.oldBalance) > 0 && (
          <div className="cd-field">
            <span className="cd-field-label">Also toward the {money(quote.oldBalance)} old balance (optional — paid last)</span>
            <div className="cd-inline">
              <input className="form-input mono" inputMode="decimal" placeholder="0.00" value={oldTyped} disabled={locked}
                onChange={e => { setOldTyped(e.target.value); setMsg(null) }}
                onBlur={() => setOldCommitted(parseAmount(oldTyped))}
                onKeyDown={e => { if (e.key === 'Enter') setOldCommitted(parseAmount(oldTyped)) }} />
            </div>
            {toCents(quote.paidAhead) > 0 && (
              <span className="cd-line-meta">{money(quote.paidAhead)} beyond the old balance is kept on their account as paid ahead.</span>
            )}
          </div>
        )}
        {(choice !== null || toCents(firstQuoteCredit) <= 0) && (quoteCurrent ? (<>
          {quote.lineItems.map((l, i) => (
            <div key={i} className="cd-line cd-line-muted"><span>{l.description}</span><span className="mono">{money(l.amountCents / 100)}</span></div>
          ))}
          <div className="cd-reader-total mono">{money(quote.total)} on the card</div>
          <div className="cd-line-meta">
            {money(quote.balance)} {toCents(quote.creditUsed) > 0 ? `after ${money(quote.creditUsed)} credit ` : ''}+ {money(quote.cardFee)} card fee — the same rate as paying online.
          </div>
        </>) : (
          <div className="cd-muted">{oldPending && !quoteFetching ? 'Press Enter (or click outside the box) to apply the old-balance amount.' : 'Working out the total…'}</div>
        ))}
        {!msg && !ready.ready && ready.reason && (choice !== null || toCents(firstQuoteCredit) <= 0) && <Message msg={{ kind: 'info', text: ready.reason }} />}
      </>) : null}

      {(busy || starting) && (
        <div className="cd-strong">
          {stage === 'sending' || (starting && !busy) ? 'Sending to the reader…' : stage === 'waiting' ? 'Waiting for the card on the reader…' : 'Card approved — recording…'}
        </div>
      )}
      {stage === 'idle' && live && onReader && (onReader.shown
        ? <div className="cd-gold">The breakdown is on the reader. They can tap any time; Send gives them {TAP_WINDOW_SECONDS} seconds.</div>
        : onReader.busy
          ? <div className="cd-note">{onReader.busy === 'collect_inputs' ? 'The reader is still asking the last customer a question.' : 'The reader is busy with another payment.'}</div>
          : null)}
      {stage === 'tap' && (
        <div className="cd-stack">
          <div className="cd-gold">The breakdown is on the reader. Waiting for their tap · {tapSecondsLeft}s</div>
          <div className="cd-note">The charge goes through when the time is up, with the card they tapped. If nobody taps, the reader then asks for the card.</div>
          <div className="cd-actions">
            <button className="btn btn-primary btn-sm cd-grow" onClick={() => tapWaiter.current?.('tapped')}>They tapped — finish now</button>
            <button className="btn btn-ghost btn-sm" onClick={() => tapWaiter.current?.('cancel')}>Cancel</button>
          </div>
        </div>
      )}
      {stage === 'done' && <div className="cd-done-line">Taken.</div>}
      <Message msg={msg} />
      <div className="cd-actions">
        {busy || starting ? (
          <button className="btn btn-ghost cd-grow" disabled={stage === 'capturing'} onClick={cancel}>Cancel on the reader</button>
        ) : stage !== 'done' && stage !== 'tap' && (
          <button className="btn btn-primary cd-grow" disabled={!quote || !readerId || !ready.ready || othersBusy}
            title={othersBusy ? 'Finish or cancel the other space on the reader first' : undefined}
            onClick={send}>
            {canResend ? 'Send again to the reader' : `Send ${quote && ready.ready ? `${money(quote.total)} ` : ''}to the reader`}
          </button>
        )}
      </div>
      {othersBusy && stage !== 'done' && (
        <div className="cd-line-meta">The reader is taking the other space now. Send this one once that is taken or canceled.</div>
      )}
    </div>
  )
}

// ─── Posting a payment that arrived before its bill ──────────────────────────

/**
 * S652 (Nic): "I've got somebody that already wrote a check and paid ahead of
 * time for October." Cash, a check or a money order: it settles what is open
 * first (oldest first, in full), and the rest is kept on their account as money
 * paid ahead. It never spends credit. Decisions #29: this is the Record payment
 * for anyone not on the Outstanding list.
 */
export function PostPaymentForm({ tenantId, name, onClose, onPosted, onChangePerson }: {
  tenantId: string
  name: string
  onClose: () => void
  onPosted: (message: string) => void
  /** Shown as × beside the name: pick someone else. */
  onChangePerson?: () => void
}) {
  const qc = useQueryClient()
  const today = localToday()
  const [method, setMethod] = useState<ManualPaymentMethod | null>(null)
  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')
  // 10/5 (Nic): a bank deposit's optional photo of the bank's receipt.
  const [photo, setPhoto] = useState<File | null>(null)
  const [receivedAt, setReceivedAt] = useState(today)
  // 10/6 (Nic): a bank deposit dated back — the server says whether it takes a
  // late fee off the onboarding month's bill, where the box applies.
  const backdated = method === 'bank_deposit' && /^\d{4}-\d{2}-\d{2}$/.test(receivedAt) && receivedAt < today ? receivedAt : null
  const { data: postQuote } = useQuery<{ lateFeesOffIfPaidInFull: number; onboardingLateFeesOff: number; canDeleteLateFees: boolean }>(
    ['post-payment-quote', tenantId, backdated],
    () => apiGet(`/payments/post-payment/quote?tenantId=${tenantId}&depositedOn=${backdated}`),
    { enabled: !!backdated, retry: false, staleTime: 0, cacheTime: 0 })
  const onboardingBox = !!backdated && onboardingLateFeeBoxApplies(postQuote)
  const [deleteOnboardingFee, setDeleteOnboardingFee] = useState(false)
  const [notes, setNotes] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [msg, setMsg] = useState<Msg>(null)
  const [saving, setSaving] = useState(false)
  const cents = parseAmount(amount)
  const needNumber = !!method && numberRequired(method)
  const ready = !!method && cents !== null && cents > 0 && (!needNumber || reference.trim().length > 0)
    && !!receivedAt && receivedAt <= today

  const post = async () => {
    if (!method || cents === null) return
    setSaving(true); setMsg(null)
    try {
      const r: any = await apiPost('/payments/post-payment', {
        tenantId, method, amount: toDollars(cents), reference: reference.trim() || null,
        notes: notes.trim() || null, receivedAt,
        // 10/6 (Nic): sent only when the box is shown and ticked.
        ...(onboardingBox && deleteOnboardingFee ? { deleteOnboardingLateFees: true } : {}),
      })
      const d = r?.data ?? {}
      const parts = [`Posted ${money(toDollars(cents))} from ${name}`]
      if (toCents(d.applied) > 0) parts.push(`${money(d.applied)} paid what was open`)
      if (toCents(d.paidAhead) > 0) parts.push(`${money(d.paidAhead)} kept as paid ahead`)
      // 10/5: the property takes part payments — what stays owed after this one.
      if (toCents(d.stillOwed) > 0) {
        const names = (Array.isArray(d.stillOwedRows) ? d.stillOwedRows : [])
          .map((x: any) => billName(String(x.dueDate ?? ''), humanize(String(x.type ?? ''))))
        parts.push(stillOwedText(toCents(d.stillOwed), names).replace(/\.$/, ''))
      }
      // 10/5 (Nic): a bank deposit dated back — late fees charged after it came off.
      const feesOff = method === 'bank_deposit' && receivedAt
        ? lateFeesOffText(receivedAt, Number(d.lateFeesUnbilled ?? 0), Number(d.lateFeesRefunded ?? 0)) : null
      // 10/6 (Nic): a deposit the tenant never reported still counts late — said in one line.
      if (feesOff) parts.push((d.unreportedDepositCountsLate ? UNREPORTED_DEPOSIT_LATE_LANDLORD_TEXT : feesOff).replace(/\.$/, ''))
      // 10/6 (Nic): the box was ticked but a late fee could not be deleted — said plainly (it stays at $0.00).
      const refused = lateFeeDeleteRefusalText(d.lateFeeDeleteRefusals)
      // 10/5 (Nic): the photo of the bank's receipt goes on the payment just posted.
      const photoNote = method === 'bank_deposit' ? await sendDepositPhoto(d.remittanceId, photo) : null
      qc.invalidateQueries('outstanding-balances')
      qc.invalidateQueries(['tenant-profile', tenantId])
      qc.invalidateQueries('payments-ledger')
      // A payment posted by hand is cash for the bank deposit too.
      qc.invalidateQueries('undeposited-cash')
      qc.invalidateQueries('deposit-slips')
      onPosted(parts.join(' — ') + '.' + (refused ? ` ${refused}` : '') + (photoNote ? ` ${photoNote}` : ''))
    } catch (e) {
      setConfirming(false)
      setMsg({ kind: 'error', text: serverMessage(e, 'That payment could not be posted. Nothing was recorded — try again.') })
    } finally { setSaving(false) }
  }
  const question = method && cents ? postConfirmQuestion(method, cents) : null

  // Like the desk window: only its own buttons close it, and not mid-post.
  return (
    <div className="modal-overlay">
      <div className="modal cd-window">
        <div className="cd-head">
          <div className="modal-title cd-title">Post a payment</div>
          <div className="cd-person">
            <span className="cd-strong">{name}</span>
            {onChangePerson && (
              <button type="button" className="cd-x" aria-label={`Remove ${name} and pick someone else`} disabled={saving}
                onClick={() => { if (!saving) onChangePerson() }}>×</button>
            )}
          </div>
          <div className="cd-sub">
            Money that arrived before its bill. It pays what is open first, oldest bill first; anything over what
            is owed is kept on their account as paid ahead. {CREDIT_USE_RULE}
          </div>
        </div>
        <div className="cd-window-body">
          <div className="cd-methods" role="group" aria-label="How they paid">
            {MANUAL_PAYMENT_METHODS.map(m => (
              <button key={m} type="button" className={`cd-option${method === m ? ' on' : ''}`}
                onClick={() => { setMethod(m); setReference(''); setPhoto(null); setConfirming(false); setMsg(null) }}>
                <span className="cd-option-title">{MANUAL_PAYMENT_METHOD_LABELS[m]}</span>
              </button>
            ))}
          </div>
          <label className="cd-field">
            <span className="cd-field-label">{method === 'bank_deposit' ? AMOUNT_FIELD_LABEL[method] : 'Amount received'}</span>
            <input className="form-input mono" inputMode="decimal" placeholder="0.00" value={amount}
              onChange={e => { setAmount(e.target.value); setConfirming(false) }} />
          </label>
          {needNumber && method && (
            <label className="cd-field">
              <span className="cd-field-label">{NUMBER_FIELD_LABEL[method]}</span>
              <input className="form-input" value={reference} maxLength={120} onChange={e => setReference(e.target.value)} />
            </label>
          )}
          {method === 'bank_deposit' && (
            <DepositPhotoField photo={photo} disabled={saving}
              onPick={(f, problem) => { setPhoto(f); setMsg(problem ? { kind: 'error', text: problem } : null) }} />
          )}
          <label className="cd-field">
            <span className="cd-field-label">{method === 'bank_deposit' ? 'Date deposited' : 'Date received'}</span>
            <input className="form-input" type="date" value={receivedAt} max={today} onChange={e => setReceivedAt(e.target.value)} />
          </label>
          {onboardingBox && (
            <OnboardingLateFeeBox checked={deleteOnboardingFee} disabled={saving} onChange={setDeleteOnboardingFee} />
          )}
          <label className="cd-field">
            <span className="cd-field-label">Note (yours; the tenant does not see it)</span>
            <textarea className="form-input" rows={2} value={notes} maxLength={500} onChange={e => setNotes(e.target.value)} />
          </label>
          {confirming && question && (
            <div className="cd-confirm">
              <div>{question}</div>
              <div className="cd-actions">
                <button className="btn btn-primary btn-sm" disabled={saving} onClick={post}>
                  {saving ? 'Posting…' : `Yes, post ${money(toDollars(cents ?? 0))}`}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)}>Change the amount</button>
              </div>
            </div>
          )}
          <Message msg={msg} />
        </div>
        <div className="cd-actions cd-footer">
          {!confirming && (
            <button className="btn btn-primary cd-grow" disabled={!ready || saving}
              onClick={() => { setMsg(null); if (question) setConfirming(true); else post() }}>
              {saving ? 'Posting…' : `Post ${cents ? money(toDollars(cents)) : 'payment'}`}
            </button>
          )}
          <button className="btn btn-ghost" disabled={saving} onClick={() => { if (!saving) onClose() }}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
