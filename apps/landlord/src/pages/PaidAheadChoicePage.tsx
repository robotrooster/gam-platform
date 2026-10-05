/**
 * 10/4 (decisions #46.1, Nic, FINAL) — MONEY PAID AHEAD ON AN ENDED LEASE.
 *
 * /leases/:leaseId/paid-ahead-choice — opened from the owner's to-do list and
 * from GAM's notice after a move-out. One page, one decision, made by someone
 * with "Issue refunds":
 *
 *   1. Who and where: the tenant(s) by name, the space, the money paid ahead
 *      still on the lease, and how each part of it was paid.
 *   2. "No refund", "Refund the unused days" or "Refund a different amount" — each
 *      says what it does ("$207.09 back to the card they paid with…"), and the
 *      landlord's exact cost of a card refund is said before confirming. Money
 *      that cannot be refunded from here is said once (refundNotes).
 *   3. For anything not refunded: "Keep it" or "Leave it as their credit"
 *      (still the tenant's money paid ahead: GAM-held money is paid to the
 *      landlord only when it pays one of their bills).
 *   4. Done: the reply to the press, said once — every line that is money to
 *      give back at the desk now (cash, a check, a money order, a bank
 *      deposit; the server flags each one, handBack) in the gold box, wherever
 *      it falls, as an order only in that reply (a later visit says it was
 *      handed back, in the past tense, so it is never handed back twice); Try again on a card
 *      or bank refund that did not go out (failed, or still "sending" after 10
 *      minutes) — said once, on that part's own line — and, for one that
 *      failed (a closed card, a refund Stripe sent back), "Give it back in
 *      cash instead", so the tenant's money is never stuck. A refund that can
 *      never be sent (its register sale was already refunded at the
 *      register, or the payment it came from was disputed) has no Try again:
 *      its line says what to do instead (the server decides: PartLine.retry).
 *      Cash instead is pressed BEFORE any money leaves the drawer: the
 *      confirm says "Give back $X in cash", the server asks Stripe first, and
 *      only its reply says "Hand back $X in cash now." (gold) — or that the
 *      refund had reached the card after all. One still being stopped has
 *      "Check again" (in place). One that already reached the card or bank
 *      and only needs recording says so, and its Try again reads "Recording…"
 *      while it works (nothing is sent again).
 *      After a Try again or cash press the header names the decision as a
 *      record ("Decided by … on …") — that press's own words come first.
 *
 * A press whose answer is not known — no answer, a 5xx with no words of its
 * own (a proxy's 502/524 page), the server saying it cannot tell
 * (outcome_unknown), or a cash press that met "another request is working on
 * this refund" (refund_busy) — is never said as "nothing was saved". A cash
 * press is kept until it is settled, through every later look and reply, and
 * through a reload or a later visit (kept per lease in this browser session's
 * storage): when cash shows up handed back in that part's place, the server's
 * words for it are shown once (PartLine.cashReply: when it was recorded and by
 * whom — in gold only for the person who recorded it, and then "if you have
 * not handed it over yet"; someone else's: ask them first; never an
 * unconditional order), without the record's past-tense line for the same
 * money; while the button is still there, press "Give it back in cash
 * instead" again — it will not be done twice. A busy press has "Check again"
 * beside its words, wherever they show. A later press on that same refund
 * that gets an answer (Try again or cash, done or refused in words) settles
 * it: the part's own state answers it, so it is never said again as "could
 * not tell" (choice46e). Before any press, a choice or preview line for money
 * given back at the desk says what will happen after Confirm — the server
 * never words it as an order there. A decision press whose answer was lost, on a page that
 * now shows it decided, has "Show what was done", which sends the SAME press
 * again (the server answers with what the first did, its order included);
 * until then the record's own lines are not shown (they would read "handed
 * back" for cash the worker never heard as an order).
 *
 * The server decides every figure and choice (GET …/paid-ahead-choice); this
 * page never works money out itself. Fresh at the moment of action: if the
 * money changed, or someone else decided it a moment ago, the server's 409
 * carries the latest and it is shown here in place, with the reason said once
 * (any other 409 refetches in place). After a press, the part lines come from
 * the newest the page has — a view loaded after the reply wins, and a press
 * that fails drops the earlier reply and any cash confirm opened from it — so
 * the worker is never told to hand back money for a refund that changed. A
 * wait with nowhere to go has "Check again"; a refetch that fails is said
 * once with Try again (never "reload"). A preview answer for an amount no
 * longer typed is dropped. Days and times are the property's (the server
 * names them). "Back to leases" writes nothing.
 *
 * The page test renders the REAL responses (services/paidAheadChoice.test.ts
 * captures them into __fixtures__/paidAheadChoice.real.json), so these
 * interfaces cannot drift from the server unnoticed.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from 'react-query'
import { ArrowLeft, Wallet } from 'lucide-react'
import type { PaidAheadRefundChoice as RefundChoice, PaidAheadRestChoice as RestChoice } from '@gam/shared'
import { apiGet, apiPost } from '../lib/api'

interface RefundPart { kind: string; label: string; amount: number; words: string }
interface RefundOption {
  choice: RefundChoice
  label: string
  result: string
  /** What the refund sends back, its cost, and what is left after it with the choices for that rest (from the server). */
  refund?: { amount: number; parts: RefundPart[]; cost: string | null; rest: number; restOptions: RestOption[] }
}
interface RestOption { choice: RestChoice; label: string; result: string }
interface PartLine {
  id: string; kind: string; label: string; amount: number; status: string; words: string; failure: string | null; stale: boolean
  /** A card or bank refund that did not go out and still needs someone: shown on its own line with what to do (the server decides). */
  attention: boolean
  /** Try again can send it (the server decides); false = never offered, the line (failure) says what to do instead. */
  retry: boolean
  /** A card or bank refund that did not go out: "Give it back in cash instead" is offered too. */
  cashInstead: boolean
  /** Being stopped (its payment was disputed since): "Check again" looks again in place (the server decides). */
  checkAgain?: boolean
  /** The refund already reached the card or bank; Try again only records it (nothing is sent again) — busy says "Recording…". */
  recordOnly?: boolean
  /** The part this one took the place of (cash handed back instead, a refund sent back): how a lost answer is read. */
  replacesPartId?: string | null
  /**
   * Cash handed back instead of a card or bank refund, said for a press whose
   * answer this page never got: when it was recorded and by whom — never an
   * unconditional order (the server words it for the person looking).
   */
  cashReply?: string[] | null
  /** Which cashReply lines are an order to the person looking (the gold box): only cash they recorded themselves. */
  cashReplyHandBack?: boolean[] | null
}
interface ChoiceSummary {
  id: string
  refundChoiceLabel: string
  restChoiceLabel: string | null
  leftAmount: number
  refundTotal: number
  restAmount: number
  decidedBy: string | null
  decidedAt: string
  /** When it was decided, on the property's own clock (the server names it). */
  decidedOn: string
  parts: PartLine[]
  /** The decision as a record (past tense): shown on a later visit. */
  words: string[]
}
interface PaidAheadView {
  leaseId: string
  unit: { id: string; number: string }
  property: { id: string; name: string }
  tenants: Array<{ id: string; name: string }>
  endedOn: string | null
  left: number
  credits: Array<{ id: string; amount: number; howPaid: string; receivedOn: string; gamHeld: boolean; refundAnswered: boolean }>
  maxRefund: number
  refundAnswered: number
  refundNotes: string[]
  owedOnLease: number
  waits: { words: string; href: string | null; linkLabel: string | null } | null
  refundOptions: RefundOption[]
  restOptions: RestOption[]
  latest: ChoiceSummary | null
  quoteToken: string
}
interface Preview { amount: number; parts: RefundPart[]; cost: string | null; rest: number; restOptions: RestOption[] }
/**
 * The reply to a press: `words` say what THIS press did (cash to hand back as
 * an order only here); `handBack` flags each line that is money to give back
 * at the desk now — every one is drawn in the gold box, wherever it falls.
 */
interface DecideResult { leaseId: string; choice: ChoiceSummary; words: string[]; handBack: boolean[]; next: 'done' | 'try_again' }
/**
 * A reply, stamped with the page's load count when it came back (so a view
 * loaded after it is known to be fresher), and which press it answers: the
 * decision itself, or a later Try again / cash press on one of its refunds.
 */
type Done = DecideResult & { seq: number; from: 'decide' | 'part' }

const money = (n: number) => `$${(Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
/** A calendar day (YYYY-MM-DD) as words — no time zone shift. */
const day = (ymd: string | null) => ymd
  ? new Date(`${ymd.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  : ''
/** A card or bank refund that did not go out and still needs someone (the server's PartLine.attention). */
const needsAttention = (p: PartLine) => !!p.attention
const AMOUNT_WORDS = 'Type how much to refund (more than $0.00).'
const CENTS_WORDS = 'Use dollars and cents, like 12.34.'
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`)
/**
 * The server's own words; never raw network text ("Network Error", "status
 * code 502"). With no answer at all (a dropped connection, a timeout) a press
 * may have been saved: it is said as that, and pressing again is safe (the
 * same press key, so it is never done twice).
 */
const LOST_WORDS = 'We could not tell if that saved. Press it again — it will not be done twice.'
/** A cash press whose answer was lost, and the refund still offers cash: nothing was handed back by it yet (the button named, never "it"). */
const CASH_STILL_THERE = 'We could not tell if that saved, and nothing is to be handed back yet. Press "Give it back in cash instead" again — it will not be done twice.'
/** A "being worked on" press, looked at again, and the refund still offers cash: whatever held it let go without handing anything back. */
const CASH_BUSY_STILL_THERE = 'Nothing was handed back yet. Press "Give it back in cash instead" again — GAM checks first, so it is never done twice.'

/**
 * A press whose answer this page never got, kept per lease for this browser
 * session (choice46d fix pass 3), so a reload, the browser's back button or a
 * later visit still offers "Show what was done" or reads a cash press from
 * the next look. Storage that is not there (a private window) only loses that.
 */
interface Pending { decide: Record<string, unknown> | null; cash: Record<string, { busy: boolean }> }
const pendingKey = (leaseId: string | undefined) => `gam:paid-ahead-pending:${leaseId ?? ''}`
const readPending = (leaseId: string | undefined): Pending => {
  try {
    const raw = window.sessionStorage.getItem(pendingKey(leaseId))
    const p = raw ? JSON.parse(raw) : null
    return { decide: p?.decide && typeof p.decide === 'object' ? p.decide : null, cash: p?.cash && typeof p.cash === 'object' ? p.cash : {} }
  } catch { return { decide: null, cash: {} } }
}
const writePending = (leaseId: string | undefined, p: Pending) => {
  try {
    if (!p.decide && !Object.keys(p.cash).length) window.sessionStorage.removeItem(pendingKey(leaseId))
    else window.sessionStorage.setItem(pendingKey(leaseId), JSON.stringify(p))
  } catch { /* storage unavailable: kept on this screen only */ }
}
/**
 * A press whose outcome is not known: no answer at all (a dropped connection,
 * a timeout), a 5xx with no words of its own (a proxy's 502/524 page, an
 * empty body), or the server saying it cannot tell (outcome_unknown — it may
 * have failed after the work was saved). Never said as "nothing was saved":
 * what became of it is read from the next look.
 */
const isLost = (e: any) => !e?.response
  || (e.response.status >= 500 && (!e.response.data?.error || e.response.data?.code === 'outcome_unknown'))
const errText = (e: any, what: 'press' | 'load' = 'press') => (what === 'press' && isLost(e) ? null : e?.response?.data?.error)
  || (what === 'load'
    ? 'This page could not be loaded just now. Check the connection, then press Try again.'
    : isLost(e)
      ? LOST_WORDS
      : 'Something went wrong and nothing was saved — try again in a moment.')
/** A typed amount as dollars, or null when it is not one. */
const typedAmount = (t: string): number | null => {
  const s = t.replace(/[$,\s]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  return Number(s)
}
/** A number with more than two places after the point ("12.345"): said as such, not as "more than $0.00". */
const tooManyCents = (t: string) => /^\d*\.\d{3,}$/.test(t.replace(/[$,\s]/g, ''))

export function PaidAheadChoicePage() {
  const { leaseId } = useParams<{ leaseId: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const base = `/leases/${leaseId}/paid-ahead-choice`
  const [view, setView] = useState<PaidAheadView | null>(null)
  // Why the page could not load, and whether pressing again could help (never for a permission refusal or a lease that is gone).
  const [loadError, setLoadError] = useState<{ text: string; retry: boolean } | null>(null)
  const [refund, setRefund] = useState<RefundChoice | null>(null)
  const [rest, setRest] = useState<RestChoice | null>(null)
  const [typed, setTyped] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [key, setKey] = useState(newKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<Done | null>(null)
  // Which load the view on screen came from: an answer to an older load is
  // dropped, and a view loaded after a press's reply is the fresher of the two.
  const loads = useRef(0)
  const [viewSeq, setViewSeq] = useState(0)
  const [checking, setChecking] = useState(false)

  /** Show the server's latest; a choice it no longer offers is cleared. */
  const show = (v: PaidAheadView) => {
    setView(v)
    setViewSeq(++loads.current)
    setRefund((c) => (c && v.refundOptions.some((o) => o.choice === c) ? c : null))
    setRest((c) => (c && v.restOptions.some((o) => o.choice === c) ? c : null))
  }
  const load = () => {
    const n = ++loads.current
    return apiGet<PaidAheadView>(base)
      .then((v) => { if (n === loads.current) { setLoadError(null); show(v) } })
      .catch((e: any) => { if (n === loads.current) setLoadError({ text: errText(e, 'load'), retry: ![403, 404].includes(e?.response?.status) }) })
  }
  useEffect(() => { load() }, [base])  // eslint-disable-line react-hooks/exhaustive-deps
  /** "Check again" on a wait with nowhere to go: the latest, in place. */
  const checkAgain = () => { setChecking(true); load().finally(() => setChecking(false)) }

  // "Refund a different amount": where it goes back, its cost and the rest's choices, as it is typed.
  const amt = refund === 'refund_other' ? typedAmount(typed) : null
  useEffect(() => {
    setPreview(null); setPreviewError(null)
    if (refund !== 'refund_other' || amt == null || !(amt > 0) || !view || amt > view.maxRefund + 0.005) return
    // An answer for an amount no longer typed (it came back after the next
    // keystroke) is dropped: the cost and the rest shown are always for the
    // amount in the box.
    let live = true
    const t = setTimeout(() => {
      // Kept and said once under the amount box: never a disabled button with no reason.
      apiGet<Preview>(`${base}/refund-preview?amount=${amt}`)
        .then((p) => { if (live && Math.abs(Number(p?.amount) - amt) < 0.005) setPreview(p) })
        .catch((e) => { if (live) { setPreview(null); setPreviewError(errText(e, 'load')) } })
    }, 250)
    return () => { live = false; clearTimeout(t) }
  }, [refund, amt, base, view])
  /** What is wrong with the typed amount, said once under the box (null = nothing, or nothing typed yet). */
  const amountWords = refund !== 'refund_other' || !view || typed.trim() === '' ? null
    : amt == null && tooManyCents(typed) ? CENTS_WORDS
    : amt == null || !(amt > 0) ? AMOUNT_WORDS
    : amt > view.maxRefund + 0.005 ? `That is more than can be refunded — ${money(view.maxRefund)} at most.`
    : previewError

  const chosen = view?.refundOptions.find((o) => o.choice === refund) ?? null
  /**
   * What is left after the refund chosen, and the choices for it — always the
   * server's, for exactly that rest: No refund's on the view, a refund's on its
   * own option ("Refund all that can go back" names its own rest), a typed
   * amount's in its preview. Null = not known yet (nothing can be confirmed).
   */
  const after = useMemo(() => {
    if (!view || !refund) return null
    if (refund === 'no_refund') return { rest: view.left, options: view.restOptions }
    if (refund === 'refund_all') return chosen?.refund ? { rest: chosen.refund.rest, options: chosen.refund.restOptions } : null
    return preview ? { rest: preview.rest, options: preview.restOptions } : null
  }, [view, refund, chosen, preview])
  const restOptions = after?.options ?? []
  const restLeft = after?.rest ?? 0
  const shownRefund = refund === 'refund_other' ? preview : chosen?.refund ?? null

  const needsRest = restLeft > 0.005
  const amountOk = refund !== 'refund_other'
    || (amt != null && amt > 0 && !!view && amt <= view.maxRefund + 0.005 && !!preview && Math.abs(preview.amount - amt) < 0.005)
  const canConfirm = !!view && !!refund && !!after && amountOk && (!needsRest || !!rest) && !busy
  const confirmLabel = !refund ? 'Confirm'
    : refund === 'no_refund' ? (rest === 'keep' ? `Keep ${money(restLeft)}` : rest === 'credit' ? `Leave ${money(restLeft)} as their credit` : 'Confirm')
    : `Refund ${money(refund === 'refund_all' ? chosen?.refund?.amount ?? 0 : amt ?? 0)}`
      + (needsRest && rest ? (rest === 'keep' ? ` and keep ${money(restLeft)}` : ` and leave ${money(restLeft)} as their credit`) : '')

  // A decision press whose answer was lost: the same press (same key) can be
  // sent again from here even when the refetched page shows it decided (the
  // server answers a repeat with what the first press did — its hand-back
  // order included), so the order is never lost with the answer.
  const [lostDecide, setLostDecide] = useState<Record<string, unknown> | null>(() => readPending(leaseId).decide)
  const sendDecide = async (body: Record<string, unknown>) => {
    setBusy(true); setError(null)
    try {
      const r: any = await apiPost(base, body)
      setLostDecide(null)
      setDone(r?.data ? { ...r.data, seq: loads.current, from: 'decide' } : null)
      if (r?.data?.choice) settleLost(r.data.choice)
      qc.invalidateQueries('landlord-todos')
      load()
    } catch (e: any) {
      // The server's latest comes with a 409: shown in place, the reason said
      // once. A 409 without it still means the page is behind: refetched in place.
      const conflict = e?.response?.status === 409
      const fresh = conflict ? e?.response?.data?.data : null
      if (fresh) { show(fresh); setKey(newKey()) } else if (conflict) { setKey(newKey()); load() }
      if (isLost(e)) { setLostDecide(body); load() } else setLostDecide(null)
      setError(errText(e))
    } finally { setBusy(false) }
  }
  const confirm = async () => {
    if (!view || !refund) return
    await sendDecide({
      refundChoice: refund,
      refundAmount: refund === 'refund_other' ? amt : null,
      restChoice: needsRest ? rest : null,
      quoteToken: view.quoteToken,
      idempotencyKey: key,
    })
  }

  // The part whose "Give it back in cash instead" is being confirmed (one inline step, never a native dialog).
  const [cashFor, setCashFor] = useState<string | null>(null)
  // The part a press is working on, and which press: only its own button says so.
  const [busyPart, setBusyPart] = useState<{ id: string; action: 'retry' | 'cash' } | null>(null)
  // A Try again whose answer never came back (a dropped connection, a
  // timeout): read again from the view loaded after it.
  const [lost, setLost] = useState<{ partId: string; seq: number } | null>(null)
  // Choice46d (review): every cash press whose answer is not known — no
  // answer, a 5xx with no words of its own, the server unable to tell, or
  // "another request is working on this refund" (the first press may still be
  // running) — kept per part until it is settled: through later looks, later
  // presses and their replies. When cash shows up handed back in that part's
  // place, the order the reply would have given is shown once, in gold.
  // `looked`: a busy press whose refund has been looked at once since (the
  // look right after the 409) — the next look (Check again) that still shows
  // it waiting says to press again.
  const [lostCash, setLostCash] = useState<Record<string, { seq: number; busy: boolean; looked?: boolean }>>(() => {
    const kept = readPending(leaseId).cash
    return Object.fromEntries(Object.entries(kept).map(([id, e]) => [id, { seq: -1, busy: !!e?.busy, looked: true }]))
  })
  const lostCashRef = useRef(lostCash)
  lostCashRef.current = lostCash
  // Kept for this browser session until settled (a reload or a later visit reads it again).
  useEffect(() => {
    writePending(leaseId, { decide: lostDecide, cash: Object.fromEntries(Object.entries(lostCash).map(([id, e]) => [id, { busy: e.busy }])) })
  }, [leaseId, lostDecide, lostCash])
  /**
   * Cash handed back in a lost press's place, in `choice`: the server's words
   * for it shown once (when and by whom — never an unconditional order), and
   * the press settled. `said`: a reply that already spoke for that cash (one
   * carrying an order, or the reply to a cash press of that same refund).
   */
  const settleLost = (choice: ChoiceSummary, seq = loads.current, said: (partId: string) => boolean = () => false): boolean => {
    const entries = Object.keys(lostCashRef.current)
    let recovered: PartLine | null = null
    const settled: string[] = []
    for (const id of entries) {
      const cash = choice.parts.find((p) => p.replacesPartId === id && p.kind === 'cash' && p.status === 'handed_back')
      if (cash) { settled.push(id); if (!said(id) && !recovered) recovered = cash }
    }
    if (!settled.length) return false
    setLostCash((m) => { const n = { ...m }; for (const id of settled) delete n[id]; return n })
    if (recovered) {
      // The server's words for cash this page never heard about: when and by
      // whom — gold only for the person who recorded it ("if you have not
      // handed it over yet"); never an unconditional order.
      const said = recovered.cashReply?.length ? recovered.cashReply
        : [`${money(recovered.amount)} was recorded as given back in cash. Ask your team whether it was already handed over before giving anything.`]
      const gold = recovered.cashReply?.length ? (recovered.cashReplyHandBack ?? []) : []
      // The record's own past-tense line for that same money is left out (the reply leaves it out too).
      const record = choice.words.filter((w) => !w.startsWith(recovered!.words))
      const words = [...said, ...record]
      setDone({ leaseId: leaseId ?? '', choice, words, handBack: words.map((_, i) => i < said.length && !!gold[i]), next: 'done', seq, from: 'part' })
      setError(null)
    }
    return true
  }
  /** Try again, or "Give it back in cash instead" (after its inline confirm): the server's answer shown in place. */
  const partAction = async (partId: string, action: 'retry' | 'cash') => {
    setBusy(true); setBusyPart({ id: partId, action }); setError(null)
    try {
      const r: any = await apiPost(`${base}/parts/${partId}/${action}`, {})
      const reply: DecideResult | null = r?.data ?? null
      setDone(reply ? { ...reply, seq: loads.current, from: 'part' } : null)
      setCashFor(null)
      // A reply that carries the order already said it; one that shows the
      // cash a lost press recorded (and no order) gets that order shown once.
      if (reply?.choice) {
        const ordered = (reply.handBack ?? []).some(Boolean)
        settleLost(reply.choice, loads.current, (id) => ordered || (action === 'cash' && id === partId))
      }
      // Choice46e (review): this press on the refund was answered (a Try again
      // or a cash press), so an earlier cash press on it that was lost or busy
      // is settled by what the part says now — never read again from the next
      // look (a second message, a clear answer said as "could not tell").
      if (reply && lostCashRef.current[partId]) setLostCash((m) => { const n = { ...m }; delete n[partId]; return n })
      qc.invalidateQueries('landlord-todos')
      load()
    } catch (e: any) {
      // Fresh at the moment of action: the earlier reply (and any cash
      // confirm opened from it) is dropped — the refetched view's own record
      // and part lines are shown, with the reason said once.
      setDone(null)
      setCashFor(null)
      const busyNow = e?.response?.status === 409 && e?.response?.data?.code === 'refund_busy'
      if (action === 'cash' && (isLost(e) || busyNow)) {
        // Not known yet: read from the looks that follow — never "press it
        // again" for a button that is gone, and never a past-tense "handed
        // back" the worker never heard as an order.
        const seq = loads.current
        setLostCash((m) => ({ ...m, [partId]: { seq, busy: busyNow || !!m[partId]?.busy, looked: false } }))
        setError(busyNow ? errText(e) : null)
      } else if (isLost(e)) {
        setLost({ partId, seq: loads.current })
        setError(null)
      } else {
        setError(errText(e))
        // Choice46e (review): a worded refusal on this refund answers an earlier lost or busy cash press on it too.
        setLostCash((m) => { if (!m[partId]) return m; const n = { ...m }; delete n[partId]; return n })
      }
      load()
    } finally { setBusy(false); setBusyPart(null) }
  }

  // A press whose answer was lost, read from each view loaded after it:
  //   cash handed back in its place → the server's words for it, once: when
  //     and by whom (gold only for the person who recorded it, "if you have
  //     not handed it over yet"; someone else's: ask them) — never a bare order;
  //   the same button still there → press "Give it back in cash instead"
  //     again (it will not be done twice); a busy press keeps its own words
  //     and Check again for the look right after it;
  //   anything else → what that refund says now.
  useEffect(() => {
    if (!view?.latest) return
    const fresh = Object.entries(lostCash).filter(([, e]) => viewSeq > e.seq)
    if (fresh.length) {
      if (settleLost(view.latest, viewSeq)) return
      for (const [id, e] of fresh) {
        const pressed = view.latest.parts.find((p) => p.id === id)
        if (pressed?.cashInstead) {
          // Still there: nothing to hand back yet.
          if (!e.busy) setError(CASH_STILL_THERE)
          else if (!e.looked) {
            // The look right after "another request is working on it": its own words stay, with Check again beside them.
            setLostCash((m) => (m[id] ? { ...m, [id]: { ...m[id], seq: viewSeq, looked: true } } : m))
          } else {
            // Looked at again and still waiting: whatever held it let go without handing anything back.
            setError(CASH_BUSY_STILL_THERE)
            setLostCash((m) => (m[id] ? { ...m, [id]: { ...m[id], seq: viewSeq, busy: false } } : m))
          }
        } else {
          // A busy press handed nothing back itself (the server said so); a lost one cannot be told.
          const lead = e.busy ? 'Nothing was handed back.' : 'We could not tell if that went through.'
          setError(`${lead} ${pressed ? `This refund now reads: ${pressed.failure || `${pressed.words}.`}` : 'The lines above show what stands now.'}`)
          setLostCash((m) => { const n = { ...m }; delete n[id]; return n })
        }
      }
    }
    if (!lost || viewSeq <= lost.seq) return
    const pressed = view.latest.parts.find((p) => p.id === lost.partId)
    if (pressed?.retry) {
      setError('We could not tell if that went through. Press Try again — it will not be sent twice.')
    } else {
      setError(`We could not tell if that went through. ${pressed ? `This refund now reads: ${pressed.failure || `${pressed.words}.`}` : 'The lines above show what stands now.'}`)
    }
    setLost(null)
  }, [lostCash, lost, view, viewSeq])  // eslint-disable-line react-hooks/exhaustive-deps

  const back = () => navigate('/leases')
  const people = view?.tenants.map((t) => t.name).join(' & ') || 'The tenant'
  // The part lines come from the newest the page has: a view loaded after the
  // press's reply wins (it has what any later press or error changed); the
  // reply's own words stay the reply text.
  const viewFresh = !!done && !!view?.latest && viewSeq > done.seq && view.latest.id === done.choice.id
  const latest = done ? (viewFresh ? view!.latest : done.choice) : view?.latest ?? null
  // The reply to the press says what that press did (once, in its order); a
  // visit with no press shows the decision's own record.
  // A decision press whose answer was lost: the record's own lines are not
  // shown until "Show what was done" (they would read "handed back" for cash
  // the worker never heard as an order) — the first line below says why.
  const decideRecover = !!lostDecide && !!view && !done && (view.refundOptions.length === 0 || !!view.waits)
  const shownWords = done ? done.words : decideRecover ? [] : latest?.words ?? []
  const attention = (latest?.parts ?? []).filter(needsAttention)
  const decidedAll = !!view && view.left <= 0.005 && !!latest
  // Each error once: a wait the server just reported is already on the page as
  // the wait itself, and a reason a refund line in view already says (a press
  // that raced — say the sale was refunded at the register meanwhile — gets
  // the same sentence the refetched line now carries) is not said again.
  const firstSentence = (s: string) => s.split(/(?<=[.!?])\s/)[0].trim()
  const saidOnLine = !!error && attention.some((p) => firstSentence(p.failure || p.words) === firstSentence(error))
  const shownError = error && error !== view?.waits?.words && error !== loadError?.text && !saidOnLine ? error : null
  // A refetch that failed while a view is on screen: said once, with Try again (never "reload").
  const reloadError = view && loadError ? loadError : null
  // A cash press that met "another request is working on this refund": Check again looks in place.
  const busyCash = Object.values(lostCash).some((e) => e.busy)

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '16px 16px 48px' }}>
      <button className="btn btn-ghost btn-sm" onClick={back} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <ArrowLeft size={14} /> Back to leases
      </button>
      <h1 style={{ fontSize: '1.3rem', margin: '12px 0 4px', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-0)' }}>
        <Wallet size={18} style={{ color: 'var(--gold)' }} /> Money paid ahead
      </h1>

      {!view && !loadError && <div style={{ color: 'var(--text-3)', fontSize: '.86rem', padding: '16px 0' }}>Loading…</div>}
      {!view && loadError && (
        <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
          <ErrorLine text={loadError.text} />
          {loadError.retry && <button className="btn btn-primary btn-sm" onClick={() => load()}>Try again</button>}
        </div>
      )}

      {view && (
        <div style={{ display: 'grid', gap: 14 }}>
          {reloadError && (
            <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
              <ErrorLine text={reloadError.text} />
              {reloadError.retry && <button className="btn btn-primary btn-sm" disabled={checking} onClick={checkAgain}>{checking ? 'Loading…' : 'Try again'}</button>}
            </div>
          )}
          <div className="card" style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: '.95rem', fontWeight: 700, color: 'var(--text-0)' }}>
              {people} · {view.unit.number} · {view.property.name}
            </div>
            {view.endedOn && <div style={{ fontSize: '.8rem', color: 'var(--text-2)' }}>Lease ended {day(view.endedOn)}</div>}
            <div style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--gold)', marginTop: 4 }}>
              {view.left > 0.005 ? `${money(view.left)} paid ahead is still on this lease` : 'Nothing paid ahead is left on this lease'}
            </div>
            {view.credits.length > 0 && (
              <div style={{ display: 'grid', gap: 3, fontSize: '.8rem', color: 'var(--text-2)' }}>
                <div style={{ fontWeight: 700, color: 'var(--text-1)' }}>How it was paid</div>
                {view.credits.map((c) => (
                  <div key={c.id}>
                    {money(c.amount)} — {c.howPaid}{c.gamHeld ? ' (GAM holds it)' : ' (you have it)'}
                  </div>
                ))}
              </div>
            )}
            {view.owedOnLease > 0.005 && (
              <div style={{ fontSize: '.8rem', color: 'var(--amber)' }}>They still owe {money(view.owedOnLease)} on this lease.</div>
            )}
          </div>

          {view.waits && (
            <div className="card" style={{ fontSize: '.84rem', color: 'var(--text-1)', lineHeight: 1.5 }}>
              {view.waits.words}
              {view.waits.href ? (
                <div style={{ marginTop: 10 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => navigate(view.waits!.href!)}>{view.waits.linkLabel}</button>
                </div>
              ) : (
                // Nowhere to go but wait: look again in place (never a reload).
                <div style={{ marginTop: 10 }}>
                  <button className="btn btn-primary btn-sm" disabled={checking} onClick={checkAgain}>{checking ? 'Checking…' : 'Check again'}</button>
                </div>
              )}
            </div>
          )}

          {latest && (done || decidedAll || attention.length > 0) && (
            <div className="card" style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontSize: '.8rem', color: 'var(--text-2)' }}>
                {/* "Done" only for the press that decided it; a later Try again or cash press names the decision as a record (its own words say what it did). */}
                {done?.from === 'decide' ? 'Done' : 'Decided'}{latest.decidedBy ? ` by ${latest.decidedBy}` : ''} on {latest.decidedOn}:{' '}
                <strong>{latest.refundChoiceLabel}{latest.restChoiceLabel ? `, then ${latest.restChoiceLabel}` : ''}</strong>
              </div>
              {shownWords.map((w, i) => (
                <div key={i} style={done?.handBack?.[i]
                  ? { padding: '12px 14px', borderRadius: 10, background: 'var(--bg-2)', border: '2px solid var(--gold)', fontWeight: 800, color: 'var(--gold)' }
                  : { fontSize: '.86rem', color: 'var(--text-1)' }}>{w}</div>
              ))}
              {attention.map((p) => (
                <div key={p.id} style={{ display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ flex: '1 1 240px', fontSize: '.82rem', color: 'var(--text-0)' }}>{p.failure || p.words}</span>
                    {/* Only a refund that can be sent again offers Try again (never a button that ends in a dead end). */}
                    {p.retry && (
                      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => partAction(p.id, 'retry')}>
                        {busyPart?.id === p.id && busyPart.action === 'retry' ? (p.recordOnly ? 'Recording…' : 'Sending…') : 'Try again'}
                      </button>
                    )}
                    {p.cashInstead && cashFor !== p.id && (
                      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => setCashFor(p.id)}>Give it back in cash instead</button>
                    )}
                    {/* Being stopped right now: look again in place (the next look stops it, then offers cash). */}
                    {p.checkAgain && (
                      <button className="btn btn-primary btn-sm" disabled={busy || checking} onClick={checkAgain}>{checking ? 'Checking…' : 'Check again'}</button>
                    )}
                  </div>
                  {/* The press comes before the hand-back: GAM first checks the refund never reached the card,
                      and only its reply says "Hand back $X in cash now." (in gold). */}
                  {p.cashInstead && cashFor === p.id && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '10px 12px', borderRadius: 10,
                                  background: 'var(--bg-2)', border: '1px solid var(--border-1)' }}>
                      <span style={{ flex: '1 1 240px', fontSize: '.82rem', color: 'var(--text-0)' }}>
                        Give {money(p.amount)} back in cash instead of to the {p.kind === 'bank' ? 'bank' : 'card'}? GAM first checks that it did not reach
                        the {p.kind === 'bank' ? 'bank' : 'card'} after all, then tells you to hand it over. It is never sent to the {p.kind === 'bank' ? 'bank' : 'card'} as well.
                      </span>
                      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setCashFor(null)}>Cancel</button>
                      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => partAction(p.id, 'cash')}>
                        {busyPart?.id === p.id && busyPart.action === 'cash' ? 'Checking…' : `Give back ${money(p.amount)} in cash`}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {!view.waits && view.refundOptions.length > 0 && !done && (
            <div className="card" style={{ display: 'grid', gap: 10 }}>
              <div style={{ fontSize: '.86rem', fontWeight: 700, color: 'var(--text-1)' }}>
                {view.maxRefund > 0.005 ? 'Refund any of it?' : 'None of it can be refunded from here.'}
              </div>
              {view.refundNotes.map((n, i) => (
                <div key={i} style={{ fontSize: '.8rem', color: 'var(--text-2)', lineHeight: 1.5 }}>{n}</div>
              ))}
              {view.refundOptions.map((o) => (
                <button key={o.choice} type="button" disabled={busy} onClick={() => { setRefund(o.choice); setRest(null) }}
                  style={{ textAlign: 'left', padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
                           background: refund === o.choice ? 'var(--bg-3)' : 'var(--bg-2)',
                           border: `2px solid ${refund === o.choice ? 'var(--gold)' : 'var(--border-1)'}` }}>
                  <div style={{ fontSize: '.9rem', fontWeight: 700, color: 'var(--text-0)' }}>{o.label}</div>
                  <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginTop: 3 }}>{o.result}</div>
                </button>
              ))}
              {refund === 'refund_other' && (
                <label style={{ fontSize: '.8rem', color: 'var(--text-2)' }}>
                  How much? (up to {money(view.maxRefund)})
                  <input className="input" inputMode="decimal" autoFocus value={typed} placeholder="0.00"
                    onChange={(e) => setTyped(e.target.value)} style={{ display: 'block', marginTop: 4, maxWidth: 160 }} />
                </label>
              )}
              {amountWords && (
                <div style={{ fontSize: '.78rem', color: 'var(--red)' }}>{amountWords}</div>
              )}
              {shownRefund && (
                <div style={{ fontSize: '.8rem', color: 'var(--text-2)', display: 'grid', gap: 3 }}>
                  {shownRefund.parts.map((p, i) => <div key={i}>{p.words}</div>)}
                  {shownRefund.cost && <div style={{ color: 'var(--amber)' }}>{shownRefund.cost}</div>}
                </div>
              )}

              {refund && needsRest && restOptions.length > 0 && (
                <div style={{ display: 'grid', gap: 8, marginTop: 4 }}>
                  <div style={{ fontSize: '.86rem', fontWeight: 700, color: 'var(--text-1)' }}>
                    What happens to the {money(restLeft)} that is not refunded?
                  </div>
                  {restOptions.map((o) => (
                    <button key={o.choice} type="button" disabled={busy} onClick={() => setRest(o.choice)}
                      style={{ textAlign: 'left', padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
                               background: rest === o.choice ? 'var(--bg-3)' : 'var(--bg-2)',
                               border: `2px solid ${rest === o.choice ? 'var(--gold)' : 'var(--border-1)'}` }}>
                      <div style={{ fontSize: '.9rem', fontWeight: 700, color: 'var(--text-0)' }}>{o.label}</div>
                      <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginTop: 3 }}>{o.result}</div>
                    </button>
                  ))}
                </div>
              )}

              {shownError && (
                <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
                  <ErrorLine text={shownError} />
                  {/* Choice46e (review): a busy cash press's words name Check again — it sits beside them here too. */}
                  {busyCash && <button className="btn btn-primary btn-sm" disabled={busy || checking} onClick={checkAgain}>{checking ? 'Checking…' : 'Check again'}</button>}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button className="btn btn-ghost" onClick={back} disabled={busy}>Back to leases</button>
                <button className="btn btn-primary" style={{ marginLeft: 'auto' }} disabled={!canConfirm} onClick={confirm}>
                  {busy ? 'Saving…' : confirmLabel}
                </button>
              </div>
            </div>
          )}

          {(view.waits || view.refundOptions.length === 0 || done) && shownError && !decideRecover && (
            <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
              <ErrorLine text={shownError} />
              {/* "Wait a moment, then press Check again": the look, in place (never a reload). */}
              {busyCash && <button className="btn btn-primary btn-sm" disabled={busy || checking} onClick={checkAgain}>{checking ? 'Checking…' : 'Check again'}</button>}
            </div>
          )}
          {/* A decision press whose answer was lost, and the page now shows it decided: the same press again shows what it did (its order included). */}
          {decideRecover && (
            <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
              <ErrorLine text={'We could not tell if that saved. Press "Show what was done" — it sends the same press again, so nothing is done twice.'} />
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => sendDecide(lostDecide!)}>{busy ? 'Checking…' : 'Show what was done'}</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)',
                  color: 'var(--red)', fontSize: '.8rem' }}>{text}</div>
  )
}
