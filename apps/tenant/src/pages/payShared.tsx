/**
 * Shared payment-method UI for the tenant portal — extracted in S171.
 *
 * S169 wired the rent Pay Now flow on /payments. S170 added the card
 * path. S171 extracts the shared pieces here so /utilities (utility
 * bills) and any future tenant-facing pay surfaces can reuse the same
 * picker + add-method modals without duplication.
 *
 * Surface:
 *   - useTenantPaymentMethods() — react-query hook over GET /stripe/tenant/payment-methods
 *   - <PayNowModal target={...} methods={...} ... /> — generic Pay flow
 *     parameterized by amount + endpoint + subheader + kind
 *   - <AddPaymentMethodModal method='ach'|'card' ... /> — Stripe
 *     Financial Connections (ACH) or card SetupIntent flow
 *   - <SavedMethodsCard methods={...} /> — read-only summary surface
 *   - Types: SavedPaymentMethod / SavedAch / SavedCard / PayTarget
 *
 * Backend pricing math lives in services/stripeConnect.computePlatformCut.
 * Frontend never computes a fee and never types one: any price shown here comes
 * from achFeeLabel() / cardFeeLabel(), which derive from PROCESSING_FEES.
 * (This header used to quote "flat $6 ACH; 3.25% + $0.26/txn card" — already two
 * repricings out of date by S607, which is precisely why S604 made the labels
 * derived rather than written.)
 */
import { useState, useEffect, useMemo } from 'react'
import { isValidRoutingNumber, microdepositInstruction, achFeeLabel, cardFeeLabel, type MicrodepositType } from '@gam/shared'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { loadStripe, Stripe as StripeJs } from '@stripe/stripe-js'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'
import { formatCurrency } from '@gam/shared'
import { apiGet, apiPost, apiPatch } from '../lib/api'

const STRIPE_PK = (import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY || ''
const stripePromise: Promise<StripeJs | null> | null = STRIPE_PK ? loadStripe(STRIPE_PK) : null

// ── TYPES ────────────────────────────────────────────────────────────────
export interface SavedAch {
  id:       string
  type:     'ach'
  bankName: string | null
  last4:    string | null
  verified?: boolean   // S570: false = microdeposits still pending, not chargeable
  isDefault?: boolean  // S571: the tenant's chosen default (ACH by default)
}
export interface SavedCard {
  id:       string
  type:     'card'
  brand:    string | null
  last4:    string | null
  expMonth: number | null
  expYear:  number | null
  country:  string | null
  verified?: boolean
  isDefault?: boolean
}
export type SavedPaymentMethod = SavedAch | SavedCard

export interface PayTarget {
  amount:    number
  endpoint:  string  // e.g. '/payments/<id>/pay' or '/utility/bills/<id>/pay'
  subheader: string  // displayed under the amount in the modal
  kind:      'rent' | 'utility'
  // S537: pay-balance sends the tenant-chosen amount in the body (FIFO
  // application server-side). Per-row endpoints ignore it.
  sendAmountInBody?: boolean
  /** S616: a payer with no lease settling their utility bill — every utility on
   *  the agreement, in one charge. */
  serviceAgreementId?: string
  // S581: pay-balance scopes the charge to one lease (each lease is its own
  // ACH/card charge + receipt). Sent when paying a specific lease's balance.
  leaseId?: string
  // S581 "Pay all": settle several leases with the ONE chosen method — each
  // entry becomes its own pay-balance charge (separate PI + receipt + capped
  // fee). When set, `amount` is the aggregate shown in the header; the per-lease
  // amounts come from here. Overrides leaseId/sendAmountInBody.
  batch?: { leaseId: string; amount: number }[]
  // S609 pay-ahead (Nic): roughly what the balance plus the rest of the lease
  // term comes to — a SUGGESTION shown beside the box, never a limit. Present =
  // the amount box is offered. Absent = the old fixed-amount behaviour, which is
  // what every non-rent target (a utility bill, a single charge) still wants.
  suggestedPayAhead?: number
  /** S622: the pay-in-full floor — the lease's own charges, excluding any
   *  carried-forward balance, which may be paid down in part. */
  requiredNow?: number
}

interface PayResponse {
  paymentIntentId: string
  status:          string
}

// ── HOOK ─────────────────────────────────────────────────────────────────
export function useTenantPaymentMethods() {
  return useQuery<SavedPaymentMethod[]>(
    'tenant-payment-methods',
    () => apiGet<SavedPaymentMethod[]>('/stripe/tenant/payment-methods'),
  )
}

// ── SAVED METHODS CARD ───────────────────────────────────────────────────
export function SavedMethodsCard({
  methods,
  loading,
  emptyCopy,
}: {
  methods:    SavedPaymentMethod[]
  loading:    boolean
  emptyCopy?: React.ReactNode
}) {
  const qc = useQueryClient()
  const setDefault = useMutation(
    (paymentMethodId: string) => apiPatch('/stripe/tenant/default-payment-method', { paymentMethodId }),
    { onSuccess: () => qc.invalidateQueries('tenant-payment-methods') },
  )
  if (loading) return null
  if (!methods.length) {
    // S570 (Nic): no redundant "add a method" banner — the header already has
    // + Add bank / + Add card, and signup prompts for a method. Show nothing
    // unless a caller passes explicit emptyCopy.
    if (!emptyCopy) return null
    return (
      <div className="card" style={{ padding: 14, fontSize: '.82rem', color: 'var(--t2)' }}>
        {emptyCopy}
      </div>
    )
  }
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: '.78rem', color: 'var(--t3)', marginBottom: 8 }}>Saved methods — one bank &amp; one card</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {methods.map((m) => {
          const pending = m.type === 'ach' && m.verified === false
          return (
            <div
              key={m.id}
              style={{
                display:        'flex',
                justifyContent: 'space-between',
                alignItems:     'center',
                gap:            10,
                fontSize:       '.85rem',
                color:          'var(--t1)',
              }}
            >
              <span>
                {m.type === 'ach'
                  ? `🏦 ${m.bankName ?? 'Bank'} ····${m.last4 ?? ''}`
                  : `💳 ${(m.brand ?? 'Card').toUpperCase()} ····${m.last4 ?? ''}`}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {pending && (
                  <span className="badge b-warn" style={{ fontSize: '.7rem' }} title="Confirm the two small deposits (Stripe emailed you) to finish verifying.">
                    Pending verification
                  </span>
                )}
                {m.isDefault ? (
                  <span className="badge b-green" style={{ fontSize: '.7rem' }}>✓ Default</span>
                ) : !pending ? (
                  <button
                    onClick={() => setDefault.mutate(m.id)}
                    disabled={setDefault.isLoading}
                    style={{ fontSize: '.7rem', color: 'var(--gold)', background: 'none', border: '1px solid rgba(201,162,39,.3)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}
                    title="Use this method by default"
                  >
                    Make default
                  </button>
                ) : null}
                <span className="badge b-muted" style={{ fontSize: '.7rem' }}>
                  {m.type === 'ach' ? 'ACH' : 'Card'}
                </span>
              </span>
            </div>
          )
        })}
      </div>
      <div style={{ fontSize: '.68rem', color: 'var(--t3)', marginTop: 8 }}>
        Adding a bank or card replaces the old one of that type. ACH is used by default — switch to card only if you want to (card fees apply).
      </div>
    </div>
  )
}

// ── PAY NOW MODAL ────────────────────────────────────────────────────────
export function PayNowModal({
  target,
  methods,
  onClose,
  onAddMethod,
  onPaid,
}: {
  target:      PayTarget
  methods:     SavedPaymentMethod[]
  onClose:     () => void
  onAddMethod: (m: 'ach' | 'card') => void
  onPaid:      () => void
}) {
  const achMethods  = methods.filter((m): m is SavedAch  => m.type === 'ach')
  const cardMethods = methods.filter((m): m is SavedCard => m.type === 'card')
  // S570: a bank with microdeposits still pending can't be charged — don't
  // pre-select it, badge it, and block Pay if it's the chosen method.
  const isPending = (m: SavedPaymentMethod) => m.type === 'ach' && m.verified === false
  const payable    = methods.filter((m) => !isPending(m))
  // S571: pre-select the tenant's default method (ACH by default).
  const initialId  = payable.find((m) => m.isDefault)?.id ?? payable[0]?.id ?? ''
  const [selectedId, setSelectedId] = useState<string>(initialId)
  // S609: what the tenant is actually paying. Starts at their balance — the
  // common case is still "pay what I owe" and that must stay one click. Typing
  // a bigger number pays future months ahead.
  const canPayAhead = target.suggestedPayAhead != null
  const [amount, setAmount] = useState<number>(target.amount)
  const [amountText, setAmountText] = useState<string>(target.amount.toFixed(2))
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const selectedMethod = methods.find((m) => m.id === selectedId)
  const selectedType   = selectedMethod?.type ?? null
  const selectedPending = selectedMethod ? isPending(selectedMethod) : false
  const hasPendingBank = achMethods.some(isPending)

  // S601 (Nic): pre-charge fee disclosure. Fetch the EXACT total for the selected
  // method so the tenant sees "$rent + $fee = $total" before paying — never blindside
  // them with a card surcharge. Single payment only; "Pay all" batches keep the header
  // total. Re-fetches when the method flips (card vs bank change the fee).
  const [quote, setQuote] = useState<
    { base: number; fee: number; total: number; method: 'ach' | 'card'; tenantPaysFee: boolean; intlCardSurcharge: boolean } | null
  >(null)
  useEffect(() => {
    if ((target.batch && target.batch.length > 0) || !selectedType || !(amount > 0)) { setQuote(null); return }
    let cancelled = false
    apiPost<any>('/payments/quote', { amount, method: selectedType, leaseId: target.leaseId })
      .then((res: any) => { if (!cancelled) setQuote(res?.data ?? null) })
      .catch(() => { if (!cancelled) setQuote(null) })
    return () => { cancelled = true }
  }, [selectedType, amount, target.leaseId])

  const submit = async () => {
    if (!selectedMethod) {
      setError('Pick a payment method first')
      return
    }
    if (isPending(selectedMethod)) {
      setError('This bank is still verifying. Confirm the two small deposits Stripe emailed you, or pay with a card.')
      return
    }
    setSubmitting(true)
    setError(null)
    setSuccess(null)
    const errMsg = (e: any) =>
      e?.response?.data?.error?.message ||
      e?.response?.data?.error ||
      e?.message ||
      'Payment failed. Try again or contact support.'
    try {
      // S581 "Pay all": one method, a separate pay-balance charge per lease.
      // Fired sequentially so a mid-batch failure leaves the already-charged
      // leases paid (the whole point — partial success beats all-or-nothing).
      if (target.batch && target.batch.length > 0) {
        let paid = 0
        let firstErr: string | null = null
        for (const b of target.batch) {
          try {
            await apiPost<PayResponse>(target.endpoint, {
              paymentMethodId:   selectedMethod.id,
              paymentMethodType: selectedMethod.type,
              amount:            b.amount,
              leaseId:           b.leaseId,
            })
            paid++
          } catch (e: any) {
            if (!firstErr) firstErr = errMsg(e)
          }
        }
        const n = target.batch.length
        if (paid === n) {
          setSuccess(
            selectedMethod.type === 'card'
              ? `All ${n} leases charged. Receipts emailed.`
              : `All ${n} payments submitted. ACH typically settles in 3–5 business days.`,
          )
          setTimeout(onPaid, 1500)
        } else if (paid > 0) {
          // Partial success — refresh so the paid leases drop off and the
          // tenant can retry only what's left.
          setError(`${paid} of ${n} paid. ${firstErr ?? 'The rest could not be charged.'} Reopen to retry the remaining lease${n - paid === 1 ? '' : 's'}.`)
          setTimeout(onPaid, 2600)
        } else {
          setError(firstErr ?? 'Payment failed. Try again or contact support.')
        }
        return
      }

      const res = await apiPost<PayResponse>(target.endpoint, {
        paymentMethodId:   selectedMethod.id,
        paymentMethodType: selectedMethod.type,
        ...(target.sendAmountInBody ? { amount } : {}),
        ...(target.leaseId ? { leaseId: target.leaseId } : {}),
        ...(target.serviceAgreementId ? { serviceAgreementId: target.serviceAgreementId } : {}),
      })
      const status = (res as any)?.data?.status
      // S534 (Nic): no propane-priority disclosure here — warning the
      // tenant mid-payment invites backing out and stranding failed ACH
      // pulls. The settle-time notification (webhooks.ts,
      // propane_priority_applied) informs them after the money moves.
      setSuccess(
        selectedMethod.type === 'card'
          ? status === 'succeeded' || !status
            ? 'Card charged. Receipt emailed.'
            : `Card status: ${status}.`
          : status === 'processing' || status === 'requires_action'
            ? 'Payment submitted. ACH typically settles in 3–5 business days.'
            : `Payment ${status ?? 'submitted'}.`,
      )
      setTimeout(onPaid, 1500)
    } catch (e: any) {
      setError(errMsg(e))
    } finally {
      setSubmitting(false)
    }
  }

  // Batch ("pay all") keeps its fixed per-lease amounts — the box is not offered
  // there, so nothing to validate.
  // S622: the floor is what the LEASE billed, not the whole ledger. A carried
  // balance from the landlord's previous system may be paid down in any amount,
  // so demanding it in full would stop a tenant $1,000 behind from paying their
  // rent at all. Mirrors rentCharge's `requiredInFull` — the screen must never
  // be stricter than the server, or a payment the API would accept is one the
  // tenant cannot even attempt.
  const payFloor = target.requiredNow ?? target.amount
  const carried = Math.round(((target.amount ?? 0) - payFloor) * 100) / 100
  const amountInvalid = !target.batch?.length && (
    !(amount > 0) ||
    amount < payFloor - 0.005
  )

  const noMethods = methods.length === 0

  return (
    <ModalShell onClose={onClose} title={`Pay ${formatCurrency(target.batch?.length ? target.amount : amount)}`}>
      <div style={{ fontSize: '.82rem', color: 'var(--t2)', marginBottom: 12 }}>
        {target.subheader}
      </div>

      {noMethods ? (
        <div>
          <div className="alert a-warn" style={{ marginBottom: 12, fontSize: '.82rem' }}>
            You don&apos;t have a payment method on file yet. ACH is the cheapest; cards are good
            for urgent payments.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-p"
              style={{ flex: 1 }}
              onClick={() => onAddMethod('ach')}
            >
              Add bank →
            </button>
            <button
              className="btn btn-p"
              style={{ flex: 1 }}
              onClick={() => onAddMethod('card')}
            >
              Add card →
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* S609 pay-ahead (Nic): "if somebody prepays a full year ahead of
              time, that money sits on GAM's books, and we disburse to the
              landlord each month as invoice comes due."

              The box starts at the balance, so paying what you owe is still one
              click and nobody has to think about this. Typing MORE pays future
              months ahead. Typing LESS is refused — rent is paid in full, and a
              partial payment can restart an eviction clock. */}
          {canPayAhead && !success && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: '.78rem', color: 'var(--t3)', marginBottom: 6 }}>Amount</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--t3)', fontFamily: 'var(--font-mono)' }}>$</span>
                  <input
                    className="inp"
                    inputMode="decimal"
                    value={amountText}
                    onChange={(e) => {
                      const raw = e.target.value.replace(/[^0-9.]/g, '')
                      setAmountText(raw)
                      const n = Number(raw)
                      setAmount(Number.isFinite(n) ? Math.round(n * 100) / 100 : 0)
                    }}
                    onBlur={() => setAmountText(amount > 0 ? amount.toFixed(2) : '')}
                    style={{ width: '100%', paddingLeft: 24, fontFamily: 'var(--font-mono)', fontWeight: 700 }}
                  />
                </div>
                {Math.abs(amount - target.amount) > 0.005 && (
                  <button
                    className="btn btn-g btn-sm"
                    onClick={() => { setAmount(target.amount); setAmountText(target.amount.toFixed(2)) }}
                  >
                    Just what I owe
                  </button>
                )}
              </div>
              {/* S609 (Nic): NO CEILING. The suggestion below is guidance, not a
                  limit — utilities aren't known until a meter is read, so any cap
                  lands wrong at the end of a lease and forces a refund. */}
              {amount < payFloor - 0.005 ? (
                <div style={{ fontSize: '.74rem', color: 'var(--warn)', marginTop: 6, lineHeight: 1.5 }}>
                  Rent is paid in full — the least you can pay is {formatCurrency(payFloor)}.
                </div>
              ) : carried > 0.005 && amount < target.amount - 0.005 ? (
                <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 6, lineHeight: 1.5 }}>
                  This clears everything your lease has billed. The remaining{' '}
                  <strong>{formatCurrency(Math.round((target.amount - amount) * 100) / 100)}</strong>{' '}
                  of your earlier balance stays on your account — you can pay it down
                  a little at a time, and it never has to be paid all at once.
                </div>
              ) : amount > target.amount + 0.005 ? (
                <div style={{ fontSize: '.74rem', color: 'var(--green)', marginTop: 6, lineHeight: 1.5 }}>
                  {formatCurrency(target.amount)} clears your balance and the extra{' '}
                  <strong>{formatCurrency(Math.round((amount - target.amount) * 100) / 100)}</strong> is held
                  as credit on your account. It comes off each bill automatically as it arrives — rent,
                  utilities, everything — and anything left over comes back to you when you move out.
                </div>
              ) : (
                <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 6, lineHeight: 1.5 }}>
                  You can pay more than you owe to cover future months — there&apos;s no limit.
                  {(target.suggestedPayAhead ?? 0) > target.amount + 0.005 && (
                    <> About {formatCurrency(target.suggestedPayAhead ?? 0)} covers the rest of your lease.</>
                  )}
                </div>
              )}
            </div>
          )}

          <div style={{ fontSize: '.78rem', color: 'var(--t3)', marginBottom: 6 }}>Pay from</div>

          {achMethods.length > 0 && (
            <MethodPickerSection
              label="Bank accounts"
              addLabel="+ Use a different bank"
              onAdd={() => onAddMethod('ach')}
            >
              {achMethods.map((m) => (
                <PickerRow
                  key={m.id}
                  selected={selectedId === m.id}
                  onSelect={() => { if (!isPending(m)) setSelectedId(m.id) }}
                >
                  <span style={{ opacity: isPending(m) ? 0.55 : 1 }}>
                    🏦 {m.bankName ?? 'Bank'} ····{m.last4 ?? ''}
                  </span>
                  {isPending(m) && (
                    <span className="badge b-warn" style={{ marginLeft: 8, fontSize: '.68rem' }}>
                      Pending verification
                    </span>
                  )}
                </PickerRow>
              ))}
            </MethodPickerSection>
          )}

          {cardMethods.length > 0 && (
            <MethodPickerSection
              label="Cards"
              addLabel="+ Use a different card"
              onAdd={() => onAddMethod('card')}
            >
              {cardMethods.map((m) => (
                <PickerRow
                  key={m.id}
                  selected={selectedId === m.id}
                  onSelect={() => setSelectedId(m.id)}
                >
                  💳 {(m.brand ?? 'Card').toUpperCase()} ····{m.last4 ?? ''}
                  <span style={{ marginLeft: 8, fontSize: '.72rem', color: 'var(--t3)' }}>
                    {m.expMonth && m.expYear
                      ? `exp ${String(m.expMonth).padStart(2, '0')}/${String(m.expYear).slice(-2)}`
                      : ''}
                  </span>
                </PickerRow>
              ))}
            </MethodPickerSection>
          )}

          {achMethods.length === 0 && (
            <button
              className="btn-link"
              style={{ fontSize: '.78rem', color: 'var(--gold)', marginBottom: 12 }}
              onClick={() => onAddMethod('ach')}
            >
              + Add a bank account
            </button>
          )}
          {cardMethods.length === 0 && (
            <button
              className="btn-link"
              style={{ fontSize: '.78rem', color: 'var(--gold)', marginBottom: 12 }}
              onClick={() => onAddMethod('card')}
            >
              + Add a card
            </button>
          )}

          {/* S601 (Nic): flat-$6 bank fee note + card-costs-more, their choice. */}
          <div style={{ fontSize: '.75rem', color: 'var(--t3)', lineHeight: 1.5, margin: '2px 0 12px' }}>
            Paying by <strong style={{ color: 'var(--t2)' }}>bank transfer is a flat $6 fee</strong>. You're welcome to pay by card instead, but card fees are usually higher — completely your call.
          </div>

          {error && (
            <div className="alert a-warn" style={{ marginBottom: 12, fontSize: '.78rem' }}>
              {error}
            </div>
          )}
          {success && (
            <div
              className="alert"
              style={{
                marginBottom: 12,
                fontSize:     '.82rem',
                background:   'rgba(34,197,94,.08)',
                border:       '1px solid rgba(34,197,94,.25)',
                color:        'var(--green)',
                padding:      '10px 14px',
                borderRadius: 8,
              }}
            >
              {success}
            </div>
          )}

          {hasPendingBank && (
            <div style={{ fontSize: '.72rem', color: 'var(--t3)', marginBottom: 10, lineHeight: 1.5 }}>
              A bank still shows <strong>Pending verification</strong> — confirm the two small deposits Stripe
              emailed you (1–3 business days) to use it. You can pay by card in the meantime.
            </div>
          )}

          {quote && !success && (
            <div style={{ border: '1px solid var(--b1)', borderRadius: 8, padding: '10px 12px', marginBottom: 10, fontSize: '.82rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--t2)' }}>
                <span>{target.kind === 'utility' ? 'Utility bill' : 'Rent'}</span>
                <span>{formatCurrency(quote.base)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--t2)', marginTop: 4 }}>
                <span>{quote.method === 'card' ? 'Card processing fee' : 'Bank (ACH) fee'}{quote.fee === 0 ? ' — covered by your landlord' : ''}</span>
                <span>{formatCurrency(quote.fee)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: 'var(--t0)', marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--b1)' }}>
                <span>You&apos;ll be charged</span>
                <span>{formatCurrency(quote.total)}</span>
              </div>
              {quote.method === 'card' && quote.fee > 0 && (
                <div style={{ fontSize: '.72rem', color: 'var(--t3)', marginTop: 6, lineHeight: 1.4 }}>
                  This covers card processing — GAM doesn&apos;t profit from it. Pay by bank to lower the fee.{quote.intlCardSurcharge ? ' Cards issued outside the US add 1.5%.' : ''}
                </div>
              )}
            </div>
          )}

          <button
            className="btn btn-p"
            style={{ width: '100%' }}
            disabled={!selectedId || submitting || !!success || selectedPending || amountInvalid}
            onClick={submit}
          >
            {submitting
              ? 'Submitting…'
              : success
                ? '✓ Submitted'
                : `Pay ${formatCurrency(quote?.total ?? (target.batch?.length ? target.amount : amount))}`}
          </button>
          <div style={{ fontSize: '.7rem', color: 'var(--t3)', marginTop: 10, lineHeight: 1.5 }}>
            {authorizationCopy(selectedType, target.kind)}
          </div>
        </>
      )}
    </ModalShell>
  )
}

function authorizationCopy(
  selectedType: 'ach' | 'card' | null,
  kind: PayTarget['kind'],
): string {
  const subject = kind === 'utility' ? 'utility bill' : 'payment'
  if (selectedType === 'card') {
    return `By clicking Pay you authorize a one-time charge to the selected card for the total shown above (${subject} + card processing fee).`
  }
  return `By clicking Pay you authorize a one-time ACH debit from the selected account for the ${subject} above. ACH typically settles in 3–5 business days.`
}

// ── PICKER PRIMITIVES (internal) ─────────────────────────────────────────
function MethodPickerSection({
  label,
  addLabel,
  onAdd,
  children,
}: {
  label:    string
  addLabel: string
  onAdd:    () => void
  children: React.ReactNode
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          display:        'flex',
          justifyContent: 'space-between',
          alignItems:     'center',
          fontSize:       '.72rem',
          color:          'var(--t3)',
          marginBottom:   6,
          textTransform:  'uppercase',
          letterSpacing:  '.06em',
        }}
      >
        <span>{label}</span>
        <button
          className="btn-link"
          style={{
            fontSize:    '.72rem',
            color:       'var(--gold)',
            background:  'transparent',
            border:      'none',
            cursor:      'pointer',
          }}
          onClick={onAdd}
        >
          {addLabel}
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  )
}

function PickerRow({
  selected,
  onSelect,
  children,
}: {
  selected: boolean
  onSelect: () => void
  children: React.ReactNode
}) {
  return (
    <label
      style={{
        display:      'flex',
        alignItems:   'center',
        gap:          10,
        padding:      12,
        border:       selected ? '1px solid var(--gold)' : '1px solid var(--b1)',
        borderRadius: 8,
        background:   selected ? 'rgba(201,162,39,.07)' : 'var(--bg2)',
        cursor:       'pointer',
        fontSize:     '.85rem',
      }}
    >
      <input type="radio" name="pm" checked={selected} onChange={onSelect} />
      <span style={{ display: 'flex', alignItems: 'center' }}>{children}</span>
    </label>
  )
}

// ── ADD PAYMENT METHOD MODAL ─────────────────────────────────────────────
//
// Two-phase: first POST /stripe/tenant/setup with the requested method
// to obtain a SetupIntent client_secret, then mount Stripe Elements
// with that clientSecret and confirm setup.
//
// ACH path: SetupIntent has Financial Connections enabled. After the
//   client-side confirm succeeds we POST /stripe/tenant/confirm-setup
//   so the server can write ach_verified + bank_last4 + log first-sender.
//
// Card path: SetupIntent has payment_method_types:['card']. On
//   confirmSetup success Stripe automatically attaches the payment_method
//   to the customer; the next /payment-methods GET picks it up. No
//   server-side capture step required.
export function AddPaymentMethodModal({
  method,
  onClose,
  onAdded,
}: {
  method:  'ach' | 'card'
  onClose: () => void
  onAdded: () => void
}) {
  const [phase, setPhase] = useState<'idle' | 'loading' | 'collect' | 'done' | 'pending' | 'error'>('idle')
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingMsg, setPendingMsg] = useState<string | null>(null)
  // S605: shown on the pending screen so the tenant sees WHICH bank the routing
  // number resolved to — the confirmation an institution picker would have given
  // them, except derived rather than typed, so it can't disagree with the number.
  const [pendingBank, setPendingBank] = useState<{ name: string | null; last4: string | null } | null>(null)
  // S605 (Nic): which verification Stripe actually sent — 'amounts' or the
  // six-digit 'descriptor_code'. Never assume; the screen must match the deposit.
  const [pendingType, setPendingType] = useState<MicrodepositType | null>(null)

  const titleVerb  = method === 'ach' ? 'bank account' : 'card'
  const idleCopy   =
    method === 'ach'
      ? 'Enter your bank\'s routing and account numbers. Stripe then sends a small verification deposit — depending on your bank you\'ll confirm either the deposit amounts or a short code from your statement, usually within 1–3 business days. No fees. Need to pay right now? Use a card instead.'
      : 'We\'ll collect your card securely through Stripe. Card details never touch GAM\'s servers; we only see the last 4 digits, brand, and expiration once Stripe attaches the card to your account.'
  const loadingCopy = method === 'ach' ? 'Preparing secure bank form…' : 'Preparing secure card form…'
  const doneCopy    = method === 'ach' ? '✓ Bank account verified' : '✓ Card saved'

  const elementsOptions = useMemo(
    () => (clientSecret ? { clientSecret } : undefined), [clientSecret])

  const start = async () => {
    setPhase('loading')
    setError(null)
    try {
      const res = await apiPost<{ clientSecret: string; customerId: string }>(
        '/stripe/tenant/setup',
        { method },
      )
      const cs = (res as any)?.data?.clientSecret ?? (res as any)?.clientSecret
      if (!cs) throw new Error('No client secret returned')
      setClientSecret(cs)
      setPhase('collect')
    } catch (e: any) {
      setError(
        e?.response?.data?.error?.message ||
          e?.response?.data?.error ||
          e?.message ||
          `Could not start ${method === 'ach' ? 'bank' : 'card'} setup`,
      )
      setPhase('error')
    }
  }

  return (
    <ModalShell onClose={onClose} title={`Add a ${titleVerb}`}>
      {phase === 'idle' && (
        <div>
          <div style={{ fontSize: '.85rem', color: 'var(--t2)', marginBottom: 14, lineHeight: 1.5 }}>
            {idleCopy}
          </div>
          {!stripePromise && (
            <div className="alert a-warn" style={{ marginBottom: 12, fontSize: '.78rem' }}>
              Stripe is not configured in this environment. Set
              <code> VITE_STRIPE_PUBLISHABLE_KEY</code> to enable verification.
            </div>
          )}
          <button
            className="btn btn-p"
            style={{ width: '100%' }}
            disabled={!stripePromise}
            onClick={start}
          >
            Continue →
          </button>
        </div>
      )}
      {phase === 'loading' && (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--t3)' }}>{loadingCopy}</div>
      )}
      {phase === 'collect' && clientSecret && stripePromise && (
        // Memoized: a fresh {clientSecret} object on every parent render makes
        // react-stripe-js treat the options as changed, which can tear down and
        // remount the element mid-flow — the other way to end up calling
        // confirmSetup with nothing mounted.
        <Elements stripe={stripePromise} options={elementsOptions!}>
          <PaymentMethodSetupForm
            method={method}
            clientSecret={clientSecret}
            onDone={(result) => {
              if (result?.pending) {
                setPendingMsg(result.message ?? null)
                setPendingBank({ name: result.bankName ?? null, last4: result.bankLast4 ?? null })
                setPendingType(result.microdepositType ?? null)
                setPhase('pending')
              } else {
                setPhase('done')
                setTimeout(onAdded, 800)
              }
            }}
            onError={(msg) => {
              setError(msg)
              setPhase('error')
            }}
          />
        </Elements>
      )}
      {phase === 'done' && (
        <div
          style={{
            padding:    20,
            textAlign:  'center',
            color:      'var(--green)',
            fontSize:   '.9rem',
          }}
        >
          {doneCopy}
        </div>
      )}
      {phase === 'pending' && (
        <div>
          <div style={{ padding: '4px 0 14px', color: 'var(--t2)', fontSize: '.85rem', lineHeight: 1.55 }}>
            <div style={{ fontWeight: 600, color: 'var(--t1)', marginBottom: 6 }}>
              {pendingType === 'descriptor_code' ? 'A $0.01 deposit is on the way' : 'Verification is on the way'}
            </div>
            {pendingBank?.name && (
              <div style={{ marginBottom: 8, padding: '8px 12px', borderRadius: 8, background: 'var(--bg1)', border: '1px solid var(--b1)', fontSize: '.82rem', color: 'var(--t1)' }}>
                <strong>{pendingBank.name}</strong>{pendingBank.last4 ? ` ••${pendingBank.last4}` : ''}
                <div style={{ fontSize: '.72rem', color: 'var(--t3)', marginTop: 2 }}>
                  Not your bank? Add the account again with the correct routing number.
                </div>
              </div>
            )}
            {pendingMsg ?? microdepositInstruction(pendingType)}
            {' '}It usually arrives in 1–3 business days. You can pay by card in the meantime.
          </div>
          <button className="btn btn-p" style={{ width: '100%' }} onClick={onAdded}>Got it</button>
        </div>
      )}
      {phase === 'error' && (
        <div>
          <div className="alert a-warn" style={{ marginBottom: 12, fontSize: '.82rem' }}>
            {error ?? 'Something went wrong.'}
          </div>
          <button className="btn btn-p" style={{ width: '100%' }} onClick={start}>
            Try again
          </button>
        </div>
      )}
    </ModalShell>
  )
}

// How long to wait on Stripe's bank window before telling the tenant something
// is wrong. Long enough for a slow bank login, short enough that nobody sits on
// a frozen button wondering.
const CONFIRM_TIMEOUT_MS = 180_000

function PaymentMethodSetupForm({
  method,
  clientSecret,
  onDone,
  onError,
}: {
  method:       'ach' | 'card'
  // Needed by the ACH path, which confirms directly instead of going through
  // the Elements group.
  clientSecret: string
  onDone:  (result?: { pending?: boolean; message?: string; bankName?: string | null; bankLast4?: string | null; microdepositType?: MicrodepositType | null }) => void
  onError: (msg: string) => void
}) {
  const stripe = useStripe()
  const elements = useElements()
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  // S605 (Nic hit this): "invalid value for stripe.confirmSetup() — elements
  // should have a mounted Payment Element".
  //
  // `useElements()` returns the Elements GROUP, which exists the moment
  // <Elements> renders — it says nothing about whether the PaymentElement
  // inside it has mounted. The button was gated on `elements` alone, so it went
  // live before the payment form was actually there, and clicking it called
  // confirmSetup against an empty group. Gate on the element's own ready event
  // instead, which is the only signal that means what we need it to mean.
  const [elementReady, setElementReady] = useState(false)

  // S605: ACH is collected here rather than by Stripe's element — see the form
  // below for why. Card still uses the element, so `elementReady` only gates it.
  const [ach, setAch] = useState({
    name: '', routing: '', account: '', confirmAccount: '',
    accountType: 'checking' as 'checking' | 'savings',
    // S605 (Nic): "somebody on hard times may be getting their rent paid by
    // somebody else... the person living there may not be the person actually
    // paying for it." That payer can be a business — an employer, a housing
    // agency, a church or nonprofit — and Stripe needs the holder type to match
    // the real account. This was hardcoded to 'individual', which would have
    // failed every organization-funded tenancy.
    holderType: 'individual' as 'individual' | 'company',
  })
  const routingValid = isValidRoutingNumber(ach.routing)
  // S605 (Nic): the routing number has a checksum to catch a fat finger; the
  // account number has NOTHING — any digit string is structurally plausible, so
  // a typo sails through to Stripe and surfaces days later as a failed deposit
  // with no clue which digit was wrong. Double entry is the only check available.
  const accountsMatch = ach.account.length > 0 && ach.account === ach.confirmAccount
  const accountMismatch = ach.confirmAccount.length > 0 && ach.account !== ach.confirmAccount
  // Only complain once they've typed all 9 — flagging a half-entered number as
  // invalid would be wrong and would train them to ignore the message.
  const routingBad = ach.routing.length === 9 && !routingValid
  const achComplete = ach.name.trim().length > 1 && routingValid && ach.account.length >= 4 && accountsMatch

  const handleConfirm = async () => {
    if (!stripe) return
    if (method === 'card' && !elements) return
    setSubmitting(true)
    setLocalError(null)

    // S605 (Nic hit this): the button stuck on "Linking…" forever with no
    // message. `stripe.confirmSetup` was awaited bare — anything it THREW
    // (rather than returned as {error}) escaped this handler unhandled, so
    // setSubmitting(false) never ran and the tenant was left staring at a dead
    // button with no way to tell whether it was working or broken. Stripe's
    // bank flow opens a Financial Connections popup, which is exactly the kind
    // of thing that can reject or never settle (popup blocked, window closed).
    //
    // Two guards: catch anything thrown, and refuse to hang forever. A tenant
    // trying to pay rent must always end up somewhere they can act on.
    let result: any
    try {
      // ACH never touches confirmSetup/elements — that path is what pulls in
      // Stripe's instant-verification UI. confirmUsBankAccountSetup takes the
      // numbers directly and returns a SetupIntent awaiting microdeposits.
      const confirming = method === 'ach'
        ? (stripe as any).confirmUsBankAccountSetup(clientSecret, {
            payment_method: {
              us_bank_account: {
                routing_number:      ach.routing,
                account_number:      ach.account,
                account_holder_type: ach.holderType,
                account_type:        ach.accountType,
              },
              billing_details: { name: ach.name.trim() },
            },
          })
        // Non-null: the card branch is unreachable without `elements` — the
        // guard at the top of handleConfirm returns early for card without it.
        : stripe.confirmSetup({
            elements:      elements!,
            confirmParams: { return_url: window.location.href },
            redirect:      'if_required',
          })
      result = await Promise.race([
        confirming,
        new Promise((_, rej) => setTimeout(
          () => rej(new Error('TIMEOUT')), CONFIRM_TIMEOUT_MS)),
      ])
    } catch (err: any) {
      setSubmitting(false)
      setLocalError(err?.message === 'TIMEOUT'
        ? 'Your bank\'s window didn\'t finish. If a popup was blocked, allow popups for this site and try again — or use "Enter bank details manually" instead.'
        : err?.message || 'The bank window closed before finishing. Please try again.')
      return
    }

    if (result.error) {
      setSubmitting(false)
      setLocalError(
        result.error.message ||
          (method === 'ach' ? 'Bank verification failed' : 'Card setup failed'),
      )
      return
    }
    const setupIntent = result.setupIntent
    if (!setupIntent || !setupIntent.payment_method) {
      setSubmitting(false)
      setLocalError(`Setup status: ${setupIntent?.status ?? 'unknown'}`)
      return
    }
    if (method === 'card') {
      // Card auto-attaches on confirmSetup. S571: tell the server so it enforces
      // one card on file (a new card replaces the old) + sets default if none.
      try {
        await apiPost('/stripe/tenant/confirm-card', {
          paymentMethodId:
            typeof setupIntent.payment_method === 'string'
              ? setupIntent.payment_method
              : setupIntent.payment_method.id,
        })
      } catch { /* non-fatal — the card is attached; swap/default is best-effort */ }
      onDone()
      return
    }
    // ACH: server stamps the bank. With microdeposit verification the account
    // is NOT yet verified — the server returns verified:false + a pending
    // message until the tenant confirms the two deposits (setup_intent.succeeded
    // webhook flips ach_verified then).
    try {
      const resp: any = await apiPost('/stripe/tenant/confirm-setup', {
        setupIntentId:   setupIntent.id,
        paymentMethodId:
          typeof setupIntent.payment_method === 'string'
            ? setupIntent.payment_method
            : setupIntent.payment_method.id,
      })
      onDone(resp?.verified === false
        ? { pending: true, message: resp?.message, bankName: resp?.bankName, bankLast4: resp?.bankLast4, microdepositType: resp?.microdepositType }
        : undefined)
    } catch (e: any) {
      setSubmitting(false)
      onError(
        e?.response?.data?.error?.message ||
          e?.response?.data?.error ||
          'Server could not record the verified bank',
      )
    }
  }

  return (
    <div>
      <div
        style={{
          background:   'var(--bg1)',
          border:       '1px solid var(--b1)',
          borderRadius: 8,
          padding:      14,
          marginBottom: 12,
        }}
      >
        {method === 'ach' ? (
          // S605 (Nic, DIRECTIVE): "Instant verification will not be on this
          // platform at this time." Stripe's PaymentElement cannot do
          // microdeposit-only — given a us_bank_account SetupIntent it always
          // leads with "sign in to your bank" (Financial Connections, ~$1.50).
          // There is no option to hide it. So ACH collects the numbers here and
          // confirms directly, which never renders or references instant at all.
          <div style={{ display: 'grid', gap: 10 }}>
            <div>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--t3)', display: 'block', marginBottom: 4 }}>Name on the account *</label>
              <input className="inp" style={{ width: '100%' }} value={ach.name} autoFocus
                onChange={e => setAch(a => ({ ...a, name: e.target.value }))} placeholder="Jane Q. Renter" />
            </div>
            <div>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--t3)', display: 'block', marginBottom: 4 }}>Routing number *</label>
              <input className="inp" style={{ width: '100%' }} inputMode="numeric" maxLength={9} value={ach.routing}
                onChange={e => setAch(a => ({ ...a, routing: e.target.value.replace(/\D/g, '').slice(0, 9) }))} placeholder="9 digits" />
              {routingBad && (
                <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 4 }}>
                  That routing number isn't valid — check the 9 digits on your check or in your banking app.
                </div>
              )}
              {routingValid && (
                <div style={{ color: 'var(--green)', fontSize: '.7rem', marginTop: 4 }}>
                  ✓ Valid routing number — we'll confirm your bank's name on the next screen.
                </div>
              )}
            </div>
            <div>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--t3)', display: 'block', marginBottom: 4 }}>Account number *</label>
              <input className="inp" style={{ width: '100%' }} inputMode="numeric" maxLength={17} value={ach.account}
                onChange={e => setAch(a => ({ ...a, account: e.target.value.replace(/\D/g, '').slice(0, 17) }))} placeholder="Your account number" />
            </div>
            <div>
              <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--t3)', display: 'block', marginBottom: 4 }}>Confirm account number *</label>
              <input className="inp" style={{ width: '100%' }} inputMode="numeric" maxLength={17} value={ach.confirmAccount}
                onChange={e => setAch(a => ({ ...a, confirmAccount: e.target.value.replace(/\D/g, '').slice(0, 17) }))}
                // Pasting here would copy the first field's typo verbatim and
                // report a match, which is the one outcome this field exists to
                // prevent. It has to be typed.
                onPaste={e => e.preventDefault()}
                onDrop={e => e.preventDefault()}
                autoComplete="off"
                placeholder="Type it again" />
              {accountMismatch && (
                <div style={{ color: 'var(--red)', fontSize: '.7rem', marginTop: 4 }}>
                  The account numbers don't match.
                </div>
              )}
              {accountsMatch && (
                <div style={{ color: 'var(--green)', fontSize: '.7rem', marginTop: 4 }}>✓ Account numbers match</div>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--t3)', display: 'block', marginBottom: 4 }}>Account type *</label>
                <select className="inp" style={{ width: '100%' }} value={ach.accountType}
                  onChange={e => setAch(a => ({ ...a, accountType: e.target.value as 'checking' | 'savings' }))}>
                  <option value="checking">Checking</option>
                  <option value="savings">Savings</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--t3)', display: 'block', marginBottom: 4 }}>Owned by *</label>
                <select className="inp" style={{ width: '100%' }} value={ach.holderType}
                  onChange={e => setAch(a => ({ ...a, holderType: e.target.value as 'individual' | 'company' }))}>
                  <option value="individual">A person</option>
                  <option value="company">A business or organization</option>
                </select>
              </div>
            </div>
            <div style={{ fontSize: '.68rem', color: 'var(--t3)', lineHeight: 1.5 }}>
              These go straight to Stripe — GAM stores only the last 4 digits. The account
              doesn't have to be in your name; if someone else pays your rent, use their
              details with their permission. By continuing you confirm you're authorized to
              debit this account for amounts you approve.
            </div>
          </div>
        ) : (
          <PaymentElement
            onReady={() => setElementReady(true)}
            onLoadError={(e: any) => setLocalError(
              e?.error?.message || 'The payment form could not load. Please refresh and try again.')}
          />
        )}
      </div>
      {localError && (
        <div className="alert a-warn" style={{ marginBottom: 12, fontSize: '.78rem' }}>
          {localError}
        </div>
      )}
      <button
        className="btn btn-p"
        style={{ width: '100%' }}
        disabled={!stripe || submitting || (method === 'ach' ? !achComplete : (!elements || !elementReady))}
        onClick={handleConfirm}
      >
        {submitting
          ? method === 'ach'
            ? 'Linking…'
            : 'Saving…'
          : method === 'ach'
            ? 'Link bank →'
            : !elementReady
              ? 'Loading…'
              : 'Save card →'}
      </button>
    </div>
  )
}

// ── MODAL SHELL ──────────────────────────────────────────────────────────
function ModalShell({
  onClose,
  title,
  children,
}: {
  onClose:  () => void
  title:    string
  children: React.ReactNode
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position:        'fixed',
        inset:           0,
        background:      'rgba(0,0,0,.6)',
        display:         'flex',
        alignItems:      'center',
        justifyContent:  'center',
        zIndex:          100,
        padding:         16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background:   'var(--bg2)',
          border:       '1px solid var(--b1)',
          borderRadius: 12,
          padding:      22,
          width:        '100%',
          maxWidth:     460,
          maxHeight:    '90vh',
          overflowY:    'auto',
        }}
      >
        <div
          style={{
            display:        'flex',
            justifyContent: 'space-between',
            alignItems:     'center',
            marginBottom:   14,
          }}
        >
          <h3 style={{ margin: 0, fontSize: '1.05rem' }}>{title}</h3>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border:     'none',
              color:      'var(--t3)',
              fontSize:   '1.2rem',
              cursor:     'pointer',
            }}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── VERIFY MICRODEPOSITS, IN HOUSE (S603, Nic) ────────────────────────────
// Previously the tenant left GAM: Stripe emailed them a link and they confirmed
// on a Stripe-hosted page. They still have to look in their own bank to READ the
// amounts — nothing can change that — but confirming them happens here now.
//
// Stripe uses one of two styles depending on the bank: two sub-$1 deposits, or a
// single 1¢ deposit whose statement descriptor carries a 6-digit code. The
// server reports which; this asks for the right thing rather than guessing.
export function VerifyMicrodepositsCard({ onVerified }: { onVerified?: () => void }) {
  const [state, setState] = useState<{
    pending: boolean; microdepositType?: string; arrivalDate?: number | null
  } | null>(null)
  const [a1, setA1] = useState('')
  const [a2, setA2] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    apiGet<any>('/stripe/tenant/microdeposits')
      .then(r => setState((r as any)?.data ?? r))
      .catch(() => setState({ pending: false }))
  }, [])

  // S607 (Nic): "I thought inputting the code was completing the verification."
  // It does — but the card used to just VANISH on success, which reads as the
  // submission having gone nowhere, and the "Pending verification" badge beside
  // it stayed up for a moment longer (see the refetch schedule in submit()).
  // Confirm plainly instead of disappearing.
  if (done) {
    return (
      <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--green, #16a34a)' }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>✓ Code accepted — your bank is verified</div>
        <div style={{ fontSize: '.82rem', color: 'var(--t2)', lineHeight: 1.55 }}>
          {/* S607 (Nic): the promotion is disclosed, never silent. Which account
              rent comes out of is a money setting, and the tenant should learn
              it from us rather than from a statement. The switch back is one tap
              on the payment-method list below. */}
          We've made this bank your <strong>default</strong> — paying by bank is {achFeeLabel()},
          instead of {cardFeeLabel()} on a card. You can switch back to a card any time below.
          If it still shows as pending, give it a few seconds — we're confirming with your bank
          and the page updates on its own.
        </div>
      </div>
    )
  }
  if (!state?.pending) return null
  // S605 (Nic): THREE states, not two. Stripe picks per bank, and when it
  // hasn't told us we must not guess — an unknown type shows BOTH inputs and
  // lets the tenant enter whichever their bank actually sent. Guessing strands
  // whoever got the other kind with no field to type it into.
  const byCode  = state.microdepositType === 'descriptor_code'
  const byAmts  = state.microdepositType === 'amounts'
  const unknown = !byCode && !byAmts

  const submit = async () => {
    setBusy(true); setError(null)
    try {
      // With an unknown type, send whichever the tenant actually filled in.
      const hasCode = code.trim().length > 0
      const hasAmts = !!Number(a1) && !!Number(a2)
      let body: any
      if (byCode || (unknown && hasCode)) {
        if (!hasCode) { setError('Enter the code from your statement.'); setBusy(false); return }
        body = { descriptorCode: code.trim() }
      } else {
        if (!hasAmts) {
          setError(unknown
            ? 'Enter either the two deposit amounts, or the code from your statement.'
            : 'Enter both deposit amounts in cents.')
          setBusy(false); return
        }
        body = { amounts: [Math.round(Number(a1)), Math.round(Number(a2))] }
      }
      await apiPost('/stripe/tenant/microdeposits/verify', body)
      setDone(true)
      // S607 (Nic): the code is accepted here, but the tenant is not marked
      // verified until Stripe's setup_intent.succeeded webhook lands — which is
      // fast, but NOT instant (0.16s in the live WAFD test, and slower under
      // load). A single refetch fired now races that webhook and usually loses,
      // which is why the "Pending verification" badge survived a successful
      // verification with nothing scheduled to look again. Re-check on a short
      // schedule so the badge clears itself instead of needing a reload.
      onVerified?.()
      for (const ms of [1500, 4000, 9000]) setTimeout(() => onVerified?.(), ms)
    } catch (e: any) {
      // Stripe's own wording distinguishes "wrong, try again" from "locked, start
      // over" — surfacing it verbatim beats a generic message that strands them.
      setError(e?.response?.data?.error?.message || e?.response?.data?.error
        || e?.message || 'Those amounts did not match.')
    } finally { setBusy(false) }
  }

  return (
    <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--gold)' }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Finish setting up your bank account</div>
      <div style={{ fontSize: '.82rem', color: 'var(--t2)', lineHeight: 1.55, marginBottom: 12 }}>
        {byCode
          ? 'We sent a $0.01 deposit to your bank. Find it on your statement — the description contains a code starting with SM. Enter that code below. Your bank may print its own reference number next to it; the one we need is the SM code.'
          : byAmts
            ? 'We sent two small deposits to your bank. Check your account, then enter both amounts below in cents (for example, 32 and 45).'
            : 'We sent a verification deposit to your bank. Banks handle this one of two ways — check your statement and use whichever you see: two small deposits (enter both amounts), or a single $0.01 deposit with a code starting with SM in its description (enter the code).'}
      </div>

      {error && <div className="alert a-warn" style={{ marginBottom: 10, fontSize: '.8rem' }}>{error}</div>}

      {(byCode || unknown) && (
        <div style={{ marginBottom: 10 }}>
          {unknown && (
            <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--t3)', marginBottom: 4 }}>
              If you see one $0.01 deposit with an SM code
            </div>
          )}
          <input
            className="input" value={code}
            // S607 (Nic): force upper case as they type, so what the tenant sees
            // is exactly what we send. The API upper-cases too, but a field that
            // silently transforms on submit is its own small betrayal — and a
            // wrong guess here is not free, Stripe locks the verification after
            // a few.
            onChange={e => setCode(e.target.value.toUpperCase())}
            autoCapitalize="characters" autoCorrect="off" spellCheck={false}
            placeholder="SM1234" maxLength={12}
            style={{ width: '100%', textTransform: 'uppercase' }}
          />
        </div>
      )}

      {unknown && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 10px' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--b1)' }} />
          <span style={{ fontSize: '.7rem', color: 'var(--t3)' }}>or</span>
          <div style={{ flex: 1, height: 1, background: 'var(--b1)' }} />
        </div>
      )}

      {(byAmts || unknown) && (
        <div style={{ marginBottom: 10 }}>
          {unknown && (
            <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--t3)', marginBottom: 4 }}>
              If you see two small deposits
            </div>
          )}
          <div style={{ display: 'flex', gap: 10 }}>
            <input className="input" inputMode="numeric" value={a1}
              onChange={e => setA1(e.target.value.replace(/\D/g, '').slice(0, 2))}
              placeholder="First (¢)" style={{ flex: 1 }} />
            <input className="input" inputMode="numeric" value={a2}
              onChange={e => setA2(e.target.value.replace(/\D/g, '').slice(0, 2))}
              placeholder="Second (¢)" style={{ flex: 1 }} />
          </div>
        </div>
      )}

      <button className="btn btn-p" style={{ width: '100%' }} disabled={busy} onClick={submit}>
        {busy ? 'Checking…' : 'Verify my bank account'}
      </button>
    </div>
  )
}
