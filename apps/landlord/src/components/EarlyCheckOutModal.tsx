/**
 * 10/4 (decisions #37.B, #38) — CHECK OUT, AND SETTLE THE MONEY.
 *
 * Opened from the schedule's reservation window ("Check out", or "Decide the
 * money" on a stay whose money question is still waiting). One window, one
 * question, one gold button that names what it does:
 *
 *   1. When did they leave? — Today, or another day between the arrival and today.
 *   2. Three plain lines: what was booked, what was stayed, what was paid.
 *   3. When they leave early, ONE question with 2–3 large choices, each showing
 *      what it leaves ("They will owe $280.00", "$90.00 back to the card…").
 *      "Refund a different amount" opens an amount box with the split shown
 *      as it is typed. The landlord's cost of a card refund is said before
 *      confirming (#38 Q4).
 *   4. Done: one line per part — cash to hand back first — and Try again on a
 *      card refund that failed, or "Give it back in cash instead" (recorded,
 *      so it is never sent to the card as well).
 *   5. Opened later on a decided stay whose card or bank refund did not go out
 *      (the schedule's Try again, the owner's to-do or notification): what was
 *      decided, and a gold Try again on each part still to send.
 *
 * The server decides every figure and choice (GET …/check-out); this window
 * never works money out itself. Fresh at the moment of action: a quote that
 * changed underneath is put in front of the desk with the error said once.
 * Close or Cancel before the button writes nothing.
 */
import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from 'react-query'
import { X, LogOut } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import {
  summaryLines, canConfirm, confirmLabel, refundAmountFor, waitLine, doneLines, failedPart, retryParts, windowTitle, newKey, money,
  type CheckoutQuote, type CheckoutChoice,
} from '../lib/earlyCheckOut'

const errText = (e: any) => e?.response?.data?.error || e?.message || 'Something went wrong — try again.'

export function EarlyCheckOutModal({ unitId, bookingId, onClose }: {
  unitId: string
  bookingId: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const base = `/units/${unitId}/bookings/${bookingId}/check-out`
  const [quote, setQuote] = useState<CheckoutQuote | null>(null)
  const [leftOn, setLeftOn] = useState<string | null>(null)
  const [otherDay, setOtherDay] = useState(false)
  const [choice, setChoice] = useState<CheckoutChoice | null>(null)
  const [typed, setTyped] = useState('')
  const [preview, setPreview] = useState<CheckoutQuote['choices'][number]['refund'] | null>(null)
  const [key, setKey] = useState(newKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ words: string[]; failed: { id: string; words: string } | null } | null>(null)

  // The quote — fresh whenever the day changes (an error about the old day goes with it).
  useEffect(() => {
    let live = true
    setError(null)
    const q = leftOn ? `?leftOn=${leftOn}` : ''
    apiGet<CheckoutQuote>(`${base}${q}`)
      .then((x) => {
        if (!live) return
        setQuote(x)
        if (!leftOn) setLeftOn(x.leftOn)
        setChoice((c) => (c && x.choices.some((k) => k.choice === c) ? c : null))
      })
      .catch((e) => { if (live) setError(errText(e)) })
    return () => { live = false }
  }, [base, leftOn])

  // "Refund a different amount": where it goes back, as it is typed.
  useEffect(() => {
    setPreview(null)
    if (choice !== 'refund_other' || !quote) return
    const amt = refundAmountFor(quote, choice, typed)
    if (amt == null || !(amt > 0) || amt > quote.maxRefund + 0.005) return
    const t = setTimeout(() => {
      apiGet<CheckoutQuote['choices'][number]['refund']>(`${base}/refund-preview?amount=${amt}`)
        .then(setPreview).catch(() => setPreview(null))
    }, 300)
    return () => clearTimeout(t)
  }, [choice, typed, quote, base])

  const lines = useMemo(() => (quote ? summaryLines(quote) : null), [quote])
  const refresh = () => { qc.invalidateQueries('schedule'); qc.invalidateQueries('landlord-todos') }

  const confirm = async () => {
    if (!quote) return
    setBusy(true); setError(null)
    try {
      const r: any = await apiPost(base, {
        leftOn: quote.checkedOut ? null : leftOn, choice, quoteToken: quote.quoteToken, idempotencyKey: key,
        refundAmount: choice === 'refund_other' ? refundAmountFor(quote, choice, typed) : null,
      })
      const out = r?.data
      refresh()
      if (out?.next === 'decide' && out?.quote) {
        // A long stay: checked out, its lease ended — now what to do with the
        // rent they paid past that day. A new press, a new key.
        setQuote(out.quote); setChoice(null); setTyped(''); setKey(newKey())
        setDone(null); setError(null)
        return
      }
      setDone({ words: out?.words ?? [], failed: failedPart({ decision: out?.decision ?? null }) })
    } catch (e: any) {
      const data = e?.response?.data
      if (data?.code === 'checkout_changed' && data?.data) {
        setQuote(data.data)
        setChoice((c) => (c && data.data.choices.some((k: any) => k.choice === c) ? c : null))
      }
      setError(errText(e))
    } finally { setBusy(false) }
  }

  const tryAgain = async (partId: string) => {
    setBusy(true); setError(null)
    try {
      const r: any = await apiPost(`${base}/parts/${partId}/retry`, {})
      const out = r?.data
      refresh()
      setDone({ words: out?.words ?? [], failed: failedPart({ decision: out?.decision ?? null }) })
    } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }

  // "Give it back in cash instead": the money is handed back at the desk and
  // recorded — the done screen then says how much to hand back.
  const cashInstead = async (partId: string) => {
    setBusy(true); setError(null)
    try {
      const r: any = await apiPost(`${base}/parts/${partId}/cash-instead`, {})
      const out = r?.data
      refresh()
      setDone({ words: out?.words ?? [], failed: failedPart({ decision: out?.decision ?? null }) })
    } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }

  const close = () => { if (!busy) onClose() }
  const decided = quote?.decision?.status === 'decided'
  const chosen = quote?.choices.find((c) => c.choice === choice) ?? null
  const shownRefund = choice === 'refund_other' ? preview : chosen?.refund ?? null
  const wait = quote ? waitLine(quote) : null
  const toRetry = retryParts(quote)
  const stuck = decided && !quote?.canRefund && quote?.decision?.parts.some((p) => p.status === 'failed')

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal" style={{ maxWidth: 500 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <LogOut size={16} /> {windowTitle(quote)}{quote ? ` · ${quote.guest}` : ''}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={close} aria-label="Close"><X size={14} /></button>
        </div>

        {!quote && !error && <div style={{ padding: 24, color: 'var(--text-3)', fontSize: '.84rem' }}>Loading…</div>}

        {done ? (
          <div style={{ display: 'grid', gap: 10 }}>
            {(() => {
              const d = doneLines(done.words)
              return (<>
                {d.first && (
                  <div style={{ padding: '14px 16px', borderRadius: 10, background: 'var(--bg-2)', border: '2px solid var(--gold)',
                                fontSize: '1.05rem', fontWeight: 800, color: 'var(--gold)' }}>{d.first}</div>
                )}
                {d.rest.map((w, i) => <div key={i} style={{ fontSize: '.86rem', color: 'var(--text-1)' }}>{w}</div>)}
              </>)
            })()}
            {error && <ErrorLine text={error} />}
            <div className="modal-footer" style={{ display: 'flex', gap: 8 }}>
              {done.failed ? (<>
                <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => cashInstead(done.failed!.id)}>
                  Give it back in cash instead
                </button>
                <button className="btn btn-primary" disabled={busy} onClick={() => tryAgain(done.failed!.id)}>
                  {busy ? 'Sending…' : 'Try again'}
                </button>
              </>) : (
                <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={onClose}>Done</button>
              )}
            </div>
          </div>
        ) : quote && lines ? (
          <div style={{ display: 'grid', gap: 12 }}>
            {!quote.checkedOut && (
              <div>
                <div style={{ fontSize: '.8rem', fontWeight: 700, color: 'var(--text-1)', marginBottom: 6 }}>When did they leave?</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button type="button" className={`btn btn-sm ${!otherDay ? 'btn-primary' : 'btn-ghost'}`} disabled={busy}
                    onClick={() => { setOtherDay(false); setLeftOn(quote.today) }}>Today</button>
                  <button type="button" className={`btn btn-sm ${otherDay ? 'btn-primary' : 'btn-ghost'}`} disabled={busy}
                    onClick={() => setOtherDay(true)}>Another day</button>
                  {otherDay && (
                    <input type="date" className="input" style={{ maxWidth: 170 }} value={leftOn ?? ''}
                      min={quote.checkIn} max={quote.today}
                      onChange={(e) => { if (e.target.value) setLeftOn(e.target.value) }} />
                  )}
                </div>
              </div>
            )}

            <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--bg-2)', border: '1px solid var(--border-1)',
                          display: 'grid', gap: 4, fontSize: '.82rem', color: 'var(--text-1)' }}>
              <div>{lines.booked}</div>
              <div>{lines.stayed}</div>
              {!quote.lease && <div>{lines.paid}</div>}
            </div>

            {quote.lease && <div style={{ fontSize: '.8rem', color: 'var(--text-2)', lineHeight: 1.5 }}>{quote.lease.words}</div>}

            {decided && quote.decision && (
              <div style={{ fontSize: '.82rem', color: 'var(--text-2)' }}>
                Already decided{quote.decision.decidedBy ? ` by ${quote.decision.decidedBy}` : ''}: <strong>{quote.decision.choiceLabel}</strong>.
                {quote.decision.parts.map((p) => {
                  const retry = toRetry.find((r) => r.id === p.id)
                  return (
                    <div key={p.id} style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ flex: '1 1 220px', color: retry ? 'var(--text-0)' : undefined }}>{retry ? retry.words : p.words}</span>
                      {retry && (<>
                        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => cashInstead(p.id)}>
                          Give it back in cash instead
                        </button>
                        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => tryAgain(p.id)}>
                          {busy ? 'Sending…' : 'Try again'}
                        </button>
                      </>)}
                    </div>
                  )
                })}
                {stuck && <div style={{ marginTop: 6, color: 'var(--text-3)' }}>Only someone with "Issue refunds" can send it again.</div>}
              </div>
            )}

            {!decided && quote.choices.length > 0 && (
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ fontSize: '.8rem', fontWeight: 700, color: 'var(--text-1)' }}>
                  {quote.question === 'owes' ? 'They still owe for the stay. What should they pay?'
                    : quote.lease ? `They paid ${money(quote.unused)} past the day they left. What should happen to it?`
                    : `They paid ${money(quote.unused)} more than the nights they stayed are worth. What should happen to it?`}
                </div>
                {quote.choices.map((c) => (
                  <button key={c.choice} type="button" disabled={busy} onClick={() => setChoice(c.choice)}
                    style={{ textAlign: 'left', padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
                             background: choice === c.choice ? 'var(--bg-3)' : 'var(--bg-2)',
                             border: `2px solid ${choice === c.choice ? 'var(--gold)' : 'var(--border-1)'}` }}>
                    <div style={{ fontSize: '.88rem', fontWeight: 700, color: 'var(--text-0)' }}>{c.label}</div>
                    <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginTop: 3 }}>{c.result}</div>
                  </button>
                ))}
                {choice === 'refund_other' && (
                  <label style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>
                    How much? (up to {money(quote.maxRefund)})
                    <input className="input" inputMode="decimal" autoFocus value={typed} placeholder="0.00"
                      onChange={(e) => setTyped(e.target.value)} style={{ display: 'block', marginTop: 4, maxWidth: 160 }} />
                  </label>
                )}
                {shownRefund && (
                  <div style={{ fontSize: '.78rem', color: 'var(--text-2)', display: 'grid', gap: 3 }}>
                    {shownRefund.parts.map((p, i) => <div key={i}>{p.words}</div>)}
                    {shownRefund.cost && <div style={{ color: 'var(--amber)' }}>{shownRefund.cost}</div>}
                  </div>
                )}
              </div>
            )}

            {wait && <div style={{ fontSize: '.8rem', color: 'var(--text-2)', lineHeight: 1.5 }}>{wait}</div>}
            {quote.checkedOut && quote.question === 'overpaid' && !quote.canRefund && (
              <div style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>Only someone with "Issue refunds" can decide this.</div>
            )}

            {error && <ErrorLine text={error} />}

            <div className="modal-footer" style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={close} disabled={busy}>{decided ? 'Close' : 'Cancel'}</button>
              {canConfirm(quote, choice, typed) && (
                <button className="btn btn-primary" style={{ marginLeft: 'auto' }} disabled={busy} onClick={confirm}>
                  {busy ? 'Saving…' : confirmLabel(quote, choice, typed)}
                </button>
              )}
            </div>
          </div>
        ) : error ? (
          <div style={{ display: 'grid', gap: 10 }}>
            <ErrorLine text={error} />
            <div className="modal-footer"><button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button></div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)',
                  color: 'var(--red)', fontSize: '.78rem' }}>{text}</div>
  )
}
