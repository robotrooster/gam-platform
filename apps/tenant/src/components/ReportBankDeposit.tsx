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

import { useState } from 'react'
import {
  MANUAL_PAYMENT_METHODS, MANUAL_PAYMENT_METHOD_LABELS, formatCurrency,
  type ManualPaymentMethod,
} from '@gam/shared'
import { apiPost, apiDelete } from '../lib/api'

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
  const [method, setMethod] = useState<ManualPaymentMethod>('cash')
  const [reference, setReference] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const amount = Number(amountText)
  const canSubmit = confirmed && amount > 0 && !!declaredDate && !submitting

  async function submit() {
    setError(null); setSubmitting(true)
    try {
      const res: any = await apiPost('/declared-deposits', {
        leaseId, amount, declaredDate, method,
        reference: reference.trim() || undefined,
      })
      setDone(res?.data?.message ?? 'Reported.')
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

        {done ? (
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
              If you deposited rent straight into your landlord's account, tell us and
              we'll watch for it. When it appears we'll apply it automatically — and
              date it to the day <em>you</em> paid, not the day the bank posted it.
            </div>

            {/* Nic's warning, given its own weight rather than buried in help text. */}
            <div style={{
              marginTop: 12, padding: '10px 12px', borderRadius: 8,
              background: 'var(--warn-bg, rgba(200,150,40,.10))',
              border: '1px solid var(--warn-bd, rgba(200,150,40,.35))',
              fontSize: '.78rem', lineHeight: 1.55, color: 'var(--t1)',
            }}>
              <strong>Only after you've actually paid.</strong> Give the bank a few hours
              to show the deposit — if you report it before you've been, there'll be
              nothing for us to match and the report will expire.
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

            <label style={{ display: 'block', marginTop: 12, fontSize: '.75rem', color: 'var(--t3)' }}>
              How did you pay?
            </label>
            {/* S624 (Nic): the instrument separates two tenants who deposited the
                same amount on the same day — a bank memo describes what was
                deposited even when it names nobody. */}
            <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              {MANUAL_PAYMENT_METHODS.map((m) => (
                <button key={m} type="button" onClick={() => setMethod(m)}
                  className={method === m ? 'btn-primary' : 'btn-ghost'}
                  style={{ fontSize: '.78rem', padding: '6px 12px' }}>
                  {MANUAL_PAYMENT_METHOD_LABELS[m]}
                </button>
              ))}
            </div>

            <label style={{ display: 'block', marginTop: 12, fontSize: '.75rem', color: 'var(--t3)' }}>
              Check or money-order number <span style={{ color: 'var(--t3)' }}>(optional)</span>
            </label>
            <input value={reference} maxLength={120}
              onChange={(e) => setReference(e.target.value)} style={inputStyle}
              placeholder="Helps us find it faster" />

            {/* The load-bearing sentence. A tenant who thinks this paid their rent
                stops worrying about a bill that is still due. */}
            <label style={{
              display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 16,
              fontSize: '.78rem', lineHeight: 1.5, cursor: 'pointer', color: 'var(--t1)',
            }}>
              <input type="checkbox" checked={confirmed} style={{ marginTop: 3 }}
                onChange={(e) => setConfirmed(e.target.checked)} />
              <span>
                I've already made this deposit, and I understand my balance stays the
                same until it shows up in the bank.
              </span>
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
export function ReportedDeposits({ reports, onWithdrawn }: {
  reports: any[]
  onWithdrawn: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const open = reports.filter(r => r.status === 'pending' || r.status === 'unconfirmed')
  if (open.length === 0) return null

  async function withdraw(id: string) {
    setBusy(id)
    try { await apiDelete(`/declared-deposits/${id}`); onWithdrawn() }
    finally { setBusy(null) }
  }

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--bd)' }}>
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
            <span style={{ color: 'var(--t3)' }}> · {r.method.replace('_', ' ')}</span>
            <div style={{ color: 'var(--t3)', fontSize: '.72rem', marginTop: 2 }}>
              {r.status === 'pending'
                ? 'Waiting for it to appear in the bank. Your balance is unchanged until it does.'
                : (r.resolutionNote || 'We could not find a matching deposit.')}
            </div>
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
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', marginTop: 4, padding: '9px 11px', borderRadius: 8,
  border: '1px solid var(--b1)', background: 'var(--bg3)', color: 'var(--t0)',
  fontSize: '.86rem',
}
