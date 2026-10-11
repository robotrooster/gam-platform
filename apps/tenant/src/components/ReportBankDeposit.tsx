// S624 — "I paid at the bank."
//
// A tenant who pays their own rent at a branch tells us; the bank feed proves
// it; the landlord never touches it. This is the screen that makes the whole
// zero-touch path fire — without it the matcher only ever produces a shortlist
// for a landlord to work through by hand.
//
// TWO THINGS THIS SCREEN MUST GET RIGHT, and they pull in opposite directions.
//
// 1. IT MUST NOT READ AS A PAYMENT. Nothing here credits anything. A tenant who
//    walks away thinking they have just paid will stop worrying about a bill
//    that is still due and still accruing. So the balance-unchanged line is not
//    fine print — it is the loudest thing after the button.
//
// 2. IT MUST BE WORTH USING. Nic (S624) asked for the warning: click this AFTER
//    you have actually paid, and give the bank time to post it. A tenant who
//    taps it on the way TO the bank files a claim that cannot match yet and ends
//    up looking dishonest. The reward for doing it properly is real and worth
//    saying: a corroborated report earns them the date THEY paid rather than the
//    date the bank got round to posting, which over a weekend is several days of
//    late fees.
//
// S655 review — AND IT MUST ONLY PROMISE WHAT GAM CAN DO. All of the above is
// true only while GAM is reading the landlord's bank. Without that (no bank
// linked, or a link in error) nothing matches the report and nothing expires
// it: the landlord checks their own bank and marks the bill paid by hand. The
// window asks before the tenant reports, and every line here — the form, the
// confirmation and the list of reports — says which of the two it is
// (./reportBankDepositCopy.ts).

import { useState } from 'react'
import { useQuery } from 'react-query'
import {
  DEPOSITABLE_PAYMENT_METHODS, MANUAL_PAYMENT_METHOD_LABELS, formatCurrency,
  DEPOSIT_REFERENCE_LABEL, bankReceiptPhotoProblem, bankDateUsedText, BANK_DEPOSIT_REPORT_NOT_TAKEN,
  DEPOSIT_HOURS, DEPOSIT_AFTER_HOURS, DEPOSIT_AFTER_HOURS_LABEL, DEPOSIT_HOUR_QUESTION, DEPOSIT_HOUR_HINT,
  depositHourLabel, reportedTimeText,
  type ManualPaymentMethod, type DepositablePaymentMethod,
} from '@gam/shared'
import { apiGet, apiPost, apiDelete, apiUpload } from '../lib/api'
import { AuthedImg } from './AuthedMedia'
import {
  ONLY_AFTER_YOU_PAID, alreadyReportedMessage, bankWatch, pendingReportStatus, reportDepositCopy,
  reportStandsNow, PHOTO_NOT_SENT,
} from './reportBankDepositCopy'

interface Props {
  leaseId: string
  /** What they currently owe, as the starting amount. */
  outstanding: number
  onReported: () => void
}

const todayISO = () => {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

export function ReportBankDepositModal({ leaseId, outstanding, onReported, onClose }:
  Props & { onClose: () => void }) {
  const [amountText, setAmountText] = useState(outstanding > 0 ? outstanding.toFixed(2) : '')
  const [declaredDate, setDeclaredDate] = useState(todayISO())
  const [method, setMethod] = useState<DepositablePaymentMethod>('cash')
  const [reference, setReference] = useState('')
  // 10/6 (Nic): about what time they were at the bank — required. '' until picked.
  const [hour, setHour] = useState('')
  // 10/5 (Nic): an optional photo of the bank's receipt, sent once the report is made.
  const [photo, setPhoto] = useState<File | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Asked fresh every time the window opens: whether GAM is reading this
  // landlord's bank decides what the window may promise.
  const feed = useQuery(
    ['declared-deposit-feed', leaseId],
    () => apiGet<{ leaseId: string; bankFeedLinked: boolean; expiresInDays?: number; depositsTaken?: boolean; notTakenMessage?: string }>(
      `/declared-deposits/feed/${leaseId}`),
    { staleTime: 0, retry: 1 },
  )
  const watch = bankWatch({
    bankFeedLinked: feed.data?.bankFeedLinked, loading: feed.isLoading, failed: feed.isError,
  })
  const copy = reportDepositCopy(watch, feed.data?.expiresInDays)

  const amount = Number(amountText)
  // 10/5 (Nic): the reference number from the bank's receipt is required.
  // 10/6 (Nic): and about what time they were at the bank.
  const canSubmit = confirmed && amount > 0 && !!declaredDate && !!reference.trim() && !!hour && !submitting && copy.canReport

  async function submit() {
    setError(null); setSubmitting(true)
    try {
      const res: any = await apiPost('/declared-deposits', {
        leaseId, amount, declaredDate, method,
        reference: reference.trim(),
        depositHour: hour === DEPOSIT_AFTER_HOURS ? DEPOSIT_AFTER_HOURS : Number(hour),
      })
      // The photo goes on the report just made (or the one already made).
      let photoNote = ''
      if (photo && res?.data?.id) {
        try {
          const fd = new FormData()
          fd.append('photo', photo)
          await apiUpload(`/declared-deposits/${res.data.id}/receipt-photo`, fd)
        } catch {
          photoNote = ` ${PHOTO_NOT_SENT}`
        }
      }
      // The server's own sentence is the authority: it checks the bank link
      // at the moment of reporting.
      setDone((res?.data?.message
        ?? (res?.data?.alreadyReported ? alreadyReportedMessage(watch) : 'Reported.')) + photoNote)
      onReported()
    } catch (e: any) {
      setError(e?.message || 'We could not record that. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--bg2)', border: '1px solid var(--b1)', borderRadius: 12,
        padding: 22, width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto',
      }}>
        <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 4 }}>
          Report a deposit you made at the bank
        </div>

        {feed.data?.depositsTaken === false ? (
          // 10/6 (Nic): the landlord does not take rent deposited at their bank here.
          <>
            <div style={{ marginTop: 14, fontSize: '.82rem', lineHeight: 1.55, color: 'var(--t1)' }}>
              {feed.data.notTakenMessage ?? BANK_DEPOSIT_REPORT_NOT_TAKEN}
            </div>
            <button className="btn-primary" style={{ width: '100%', marginTop: 16 }}
              onClick={onClose}>Done</button>
          </>
        ) : done ? (
          <>
            <div style={{
              marginTop: 14, padding: 12, borderRadius: 8,
              background: 'var(--bg3)', border: '1px solid var(--b1)',
              fontSize: '.82rem', lineHeight: 1.55, color: 'var(--t1)',
            }}>
              {done}
            </div>
            <button className="btn-primary" style={{ width: '100%', marginTop: 16 }}
              onClick={onClose}>Done</button>
          </>
        ) : (
          <>
            <div style={{ fontSize: '.8rem', color: 'var(--t2)', lineHeight: 1.55, marginTop: 6 }}>
              {copy.intro}
            </div>

            {/* Nic's warning, given its own weight rather than buried in help text. */}
            <div style={{
              marginTop: 12, padding: '10px 12px', borderRadius: 8,
              background: 'var(--warn-bg, rgba(200,150,40,.10))',
              border: '1px solid var(--warn-bd, rgba(200,150,40,.35))',
              fontSize: '.78rem', lineHeight: 1.55, color: 'var(--t1)',
            }}>
              <strong>{ONLY_AFTER_YOU_PAID}</strong> {copy.warning}
            </div>

            <label style={{ display: 'block', marginTop: 14, fontSize: '.75rem', color: 'var(--t3)' }}>
              How much did you deposit?
            </label>
            <input inputMode="decimal" value={amountText}
              onChange={(e) => setAmountText(e.target.value.replace(/[^\d.]/g, ''))}
              style={inputStyle} placeholder="0.00" />

            <label style={{ display: 'block', marginTop: 12, fontSize: '.75rem', color: 'var(--t3)' }}>
              What day did you go to the bank?
            </label>
            <input type="date" value={declaredDate} max={todayISO()}
              onChange={(e) => setDeclaredDate(e.target.value)} style={inputStyle} />

            {/* 10/6 (Nic): required — "for people that pay the exact same
                amount, the probability that they're going to be in the bank
                at exactly the same time also kind of shrinks." */}
            <label htmlFor="report-deposit-hour"
              style={{ display: 'block', marginTop: 12, fontSize: '.75rem', color: 'var(--t3)' }}>
              {DEPOSIT_HOUR_QUESTION}
            </label>
            <select id="report-deposit-hour" value={hour} required
              onChange={(e) => setHour(e.target.value)} style={inputStyle}>
              <option value="" disabled>Pick a time</option>
              {DEPOSIT_HOURS.map((h) => (
                <option key={h} value={String(h)}>{depositHourLabel(h)}</option>
              ))}
              <option value={DEPOSIT_AFTER_HOURS}>{DEPOSIT_AFTER_HOURS_LABEL}</option>
            </select>
            <div style={{ fontSize: '.72rem', color: 'var(--t3)', lineHeight: 1.5, marginTop: 4 }}>
              {DEPOSIT_HOUR_HINT}
            </div>

            <label style={{ display: 'block', marginTop: 12, fontSize: '.75rem', color: 'var(--t3)' }}>
              How did you pay?
            </label>
            {/* S624 (Nic): the instrument separates two tenants who deposited the
                same amount on the same day — a bank memo describes what was
                deposited even when it names nobody. */}
            <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              {DEPOSITABLE_PAYMENT_METHODS.map((m) => (
                <button key={m} type="button" onClick={() => setMethod(m)}
                  className={method === m ? 'btn-primary' : 'btn-ghost'}
                  style={{ fontSize: '.78rem', padding: '6px 12px' }}>
                  {MANUAL_PAYMENT_METHOD_LABELS[m]}
                </button>
              ))}
            </div>

            {/* 10/5 (Nic): required — it tells this deposit apart from anyone
                else's for the same amount. */}
            <label htmlFor="report-deposit-reference"
              style={{ display: 'block', marginTop: 12, fontSize: '.75rem', color: 'var(--t3)' }}>
              {DEPOSIT_REFERENCE_LABEL}
            </label>
            <input id="report-deposit-reference" value={reference} maxLength={120} required
              onChange={(e) => setReference(e.target.value)} style={inputStyle}
              placeholder="e.g. 004417" />

            <label htmlFor="report-deposit-photo"
              style={{ display: 'block', marginTop: 12, fontSize: '.75rem', color: 'var(--t3)' }}>
              Photo of the bank’s receipt <span style={{ color: 'var(--t3)' }}>(optional)</span>
            </label>
            <input id="report-deposit-photo" type="file" accept="image/*" style={{ ...inputStyle, padding: '7px 9px' }}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null
                const problem = bankReceiptPhotoProblem(f)
                if (problem) { setError(problem); setPhoto(null); e.target.value = ''; return }
                setError(null); setPhoto(f)
              }} />

            {/* The load-bearing sentence. A tenant who thinks this paid their rent
                stops worrying about a bill that is still due. */}
            <label style={{
              display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 16,
              fontSize: '.78rem', lineHeight: 1.5, cursor: 'pointer', color: 'var(--t1)',
            }}>
              <input type="checkbox" checked={confirmed} style={{ marginTop: 3 }}
                onChange={(e) => setConfirmed(e.target.checked)} />
              <span>{copy.confirm}</span>
            </label>

            {error && (
              <div style={{ marginTop: 12, fontSize: '.78rem', color: 'var(--danger, #d66)' }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              <button className="btn-ghost" style={{ flex: 1 }} onClick={onClose}>
                Cancel
              </button>
              <button className="btn-primary" style={{ flex: 2 }}
                disabled={!canSubmit} onClick={submit}>
                {submitting ? 'Reporting…' : 'Report this deposit'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Reports the tenant has open, and what became of them.
 *
 * Shown even when empty-handed is wrong — an unconfirmed report is something the
 * tenant needs to see and act on, and a confirmed one is the reassurance that
 * the thing they did worked.
 */
/** The server's answer to an "I hadn't paid" it would not do. */
export interface WithdrawRefusal { id: string; message: string }

export function ReportedDeposits({ reports, onWithdrawn, refusal, onRefusal, standalone }: {
  reports: any[]
  onWithdrawn: () => void
  /**
   * S655 review: a page can hold the refusal itself (pass both). The refused
   * report was usually just applied to the bill, often paying it off, and the
   * reload that follows takes away the balance card this list sits in — held
   * in here, the answer went with the card. Without these, the list holds it.
   */
  refusal?: WithdrawRefusal | null
  onRefusal?: (r: WithdrawRefusal | null) => void
  /** Its own block on the page rather than a section of a card. */
  standalone?: boolean
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [ownRefusal, setOwnRefusal] = useState<WithdrawRefusal | null>(null)
  const withdrawError = onRefusal ? (refusal ?? null) : ownRefusal
  const setWithdrawError = onRefusal ?? setOwnRefusal
  // 10/5 (Nic): a report the bank showed on a later day stays here, saying
  // the bank's date was used and why.
  const open = reports.filter(r => r.status === 'pending' || r.status === 'unconfirmed'
    || (r.status === 'confirmed' && r.bankDateUsed && r.bankPostedDate))
  // A refused "I hadn't paid" is usually a report matched or closed in the
  // meantime, which has just left the open list: when it was the only one,
  // the list stays up to say what happened rather than vanishing.
  if (open.length === 0 && !withdrawError) return null
  const standing = withdrawError ? reportStandsNow(reports.find(r => r.id === withdrawError.id)) : null

  async function withdraw(id: string) {
    setBusy(id); setWithdrawError(null)
    try { await apiDelete(`/declared-deposits/${id}`) }
    catch (e: any) {
      // Said once, in the server's words. The list reloads below, and the line
      // under it says where the report stands now.
      setWithdrawError({ id, message: e?.message || 'We could not take that report back. Try again.' })
    }
    finally { setBusy(null); onWithdrawn() }
  }

  return (
    <div style={standalone ? undefined : { marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--bd)' }}>
      <div style={{
        fontSize: '.7rem', fontWeight: 700, color: 'var(--t3)',
        textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6,
      }}>
        Deposits you've reported
      </div>
      {open.map((r) => (
        <div key={r.id} style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          gap: 12, padding: '6px 0', fontSize: '.78rem',
        }}>
          <span style={{ color: 'var(--t2)', lineHeight: 1.5 }}>
            {formatCurrency(Number(r.amount))} on {r.declaredDate}
            {/* 10/6 (Nic): about what time they said they were at the bank. */}
            {reportedTimeText({ hour: r.depositHour, afterHours: r.afterHours }) && (
              <span style={{ color: 'var(--t3)' }}>
                {', '}{reportedTimeText({ hour: r.depositHour, afterHours: r.afterHours })}
              </span>
            )}
            <span style={{ color: 'var(--t3)' }}>
              {' · '}{MANUAL_PAYMENT_METHOD_LABELS[r.method as ManualPaymentMethod] ?? 'Other'}
            </span>
            {r.reference && (
              <span style={{ color: 'var(--t3)' }}>{' · Ref '}{r.reference}</span>
            )}
            <div style={{ color: 'var(--t3)', fontSize: '.72rem', marginTop: 2 }}>
              {r.status === 'pending'
                ? pendingReportStatus(r.bankFeedLinked)
                : r.status === 'confirmed'
                  ? bankDateUsedText(r.declaredDate, r.bankPostedDate)
                  : (r.resolutionNote || 'We could not find a matching deposit.')}
            </div>
            {r.receiptPhotoUrl && <ReceiptPhotoButton url={r.receiptPhotoUrl} />}
          </span>
          {r.status === 'pending' && (
            <button className="btn-ghost" disabled={busy === r.id}
              style={{ fontSize: '.72rem', padding: '4px 10px', whiteSpace: 'nowrap' }}
              onClick={() => withdraw(r.id)}>
              {busy === r.id ? '…' : 'I hadn’t paid'}
            </button>
          )}
        </div>
      ))}
      {withdrawError && (
        <div role="status" style={{ marginTop: 6, fontSize: '.74rem', lineHeight: 1.5 }}>
          <div style={{ color: 'var(--danger, #d66)' }}>{withdrawError.message}</div>
          {standing && <div style={{ color: 'var(--t2)', marginTop: 2 }}>{standing}</div>}
          <button className="btn-ghost" style={{ fontSize: '.72rem', padding: '4px 10px', marginTop: 6 }}
            onClick={() => setWithdrawError(null)}>
            OK
          </button>
        </div>
      )}
    </div>
  )
}

/** 10/5 (Nic): the tenant's own photo of the bank's receipt, shown in the app (the file sits behind the sign-in). */
function ReceiptPhotoButton({ url }: { url: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginTop: 4 }}>
      <button type="button" className="btn-primary" style={{ fontSize: '.7rem', padding: '3px 10px' }}
        onClick={() => setOpen(true)}>
        Photo of the bank’s receipt
      </button>
      {open && (
        <div onClick={() => setOpen(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 110, padding: 16,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: 'var(--bg2)', border: '1px solid var(--b1)', borderRadius: 12, padding: 16,
            width: '100%', maxWidth: 520,
          }}>
            <AuthedImg path={url} alt="Photo of the bank's receipt"
              style={{ display: 'block', width: '100%', maxHeight: '70vh', objectFit: 'contain', borderRadius: 8 }} />
            <button type="button" className="btn-ghost" style={{ width: '100%', marginTop: 12 }}
              onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', marginTop: 4, padding: '9px 11px', borderRadius: 8,
  border: '1px solid var(--b1)', background: 'var(--bg3)', color: 'var(--t0)',
  fontSize: '.86rem',
}
