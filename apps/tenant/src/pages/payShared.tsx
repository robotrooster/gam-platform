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
 * Backend pricing math lives in services/stripeConnect.computeApplicationFee
 * (S113/S552: flat $6 ACH; 3.25% + $0.26/txn card, +1.5% non-US-issued).
 * Frontend never computes the fee — it's shown in the authorization line
 * as customer-facing copy only.
 */
import { useState, useEffect } from 'react'
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
  // S581: pay-balance scopes the charge to one lease (each lease is its own
  // ACH/card charge + receipt). Sent when paying a specific lease's balance.
  leaseId?: string
  // S581 "Pay all": settle several leases with the ONE chosen method — each
  // entry becomes its own pay-balance charge (separate PI + receipt + capped
  // fee). When set, `amount` is the aggregate shown in the header; the per-lease
  // amounts come from here. Overrides leaseId/sendAmountInBody.
  batch?: { leaseId: string; amount: number }[]
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
    if ((target.batch && target.batch.length > 0) || !selectedType) { setQuote(null); return }
    let cancelled = false
    apiPost<any>('/payments/quote', { amount: target.amount, method: selectedType, leaseId: target.leaseId })
      .then((res: any) => { if (!cancelled) setQuote(res?.data ?? null) })
      .catch(() => { if (!cancelled) setQuote(null) })
    return () => { cancelled = true }
  }, [selectedType, target.amount, target.leaseId])

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
        ...(target.sendAmountInBody ? { amount: target.amount } : {}),
        ...(target.leaseId ? { leaseId: target.leaseId } : {}),
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

  const noMethods = methods.length === 0

  return (
    <ModalShell onClose={onClose} title={`Pay ${formatCurrency(target.amount)}`}>
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
            disabled={!selectedId || submitting || !!success || selectedPending}
            onClick={submit}
          >
            {submitting
              ? 'Submitting…'
              : success
                ? '✓ Submitted'
                : `Pay ${formatCurrency(quote?.total ?? target.amount)}`}
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

  const titleVerb  = method === 'ach' ? 'bank account' : 'card'
  const idleCopy   =
    method === 'ach'
      ? 'Enter your bank\'s routing and account numbers. Stripe sends two small deposits to your account — confirm them in 1–3 business days (Stripe emails you a link) to finish. No fees. Prefer to pay right away? Use a card instead.'
      : 'We\'ll collect your card securely through Stripe. Card details never touch GAM\'s servers; we only see the last 4 digits, brand, and expiration once Stripe attaches the card to your account.'
  const loadingCopy = method === 'ach' ? 'Preparing secure bank form…' : 'Preparing secure card form…'
  const doneCopy    = method === 'ach' ? '✓ Bank account verified' : '✓ Card saved'

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
        <Elements stripe={stripePromise} options={{ clientSecret }}>
          <PaymentMethodSetupForm
            method={method}
            onDone={(result) => {
              if (result?.pending) {
                setPendingMsg(result.message ?? null)
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
            <div style={{ fontWeight: 600, color: 'var(--t1)', marginBottom: 6 }}>Two small deposits are on the way</div>
            {pendingMsg ?? 'We sent two small deposits to your bank. They arrive in 1–3 business days — check the email from Stripe and confirm the amounts to finish setting up your bank. You can pay by card in the meantime.'}
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

function PaymentMethodSetupForm({
  method,
  onDone,
  onError,
}: {
  method:  'ach' | 'card'
  onDone:  (result?: { pending?: boolean; message?: string }) => void
  onError: (msg: string) => void
}) {
  const stripe = useStripe()
  const elements = useElements()
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const handleConfirm = async () => {
    if (!stripe || !elements) return
    setSubmitting(true)
    setLocalError(null)
    const result = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect:      'if_required',
    })
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
      onDone(resp?.verified === false ? { pending: true, message: resp?.message } : undefined)
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
        <PaymentElement />
      </div>
      {localError && (
        <div className="alert a-warn" style={{ marginBottom: 12, fontSize: '.78rem' }}>
          {localError}
        </div>
      )}
      <button
        className="btn btn-p"
        style={{ width: '100%' }}
        disabled={!stripe || !elements || submitting}
        onClick={handleConfirm}
      >
        {submitting
          ? method === 'ach'
            ? 'Linking…'
            : 'Saving…'
          : method === 'ach'
            ? 'Link bank →'
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
