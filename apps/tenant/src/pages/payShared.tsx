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
 * (S113: 1.0% capped $6 ACH, 3.25% flat card, +1.5% non-US-issued cards).
 * Frontend never computes the fee — it's shown in the authorization line
 * as customer-facing copy only.
 */
import { useState } from 'react'
import { useQuery } from 'react-query'
import { loadStripe, Stripe as StripeJs } from '@stripe/stripe-js'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'
import { formatCurrency } from '@gam/shared'
import { apiGet, apiPost } from '../lib/api'

const STRIPE_PK = (import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY || ''
const stripePromise: Promise<StripeJs | null> | null = STRIPE_PK ? loadStripe(STRIPE_PK) : null

// ── TYPES ────────────────────────────────────────────────────────────────
export interface SavedAch {
  id:       string
  type:     'ach'
  bankName: string | null
  last4:    string | null
}
export interface SavedCard {
  id:       string
  type:     'card'
  brand:    string | null
  last4:    string | null
  expMonth: number | null
  expYear:  number | null
  country:  string | null
}
export type SavedPaymentMethod = SavedAch | SavedCard

export interface PayTarget {
  amount:    number
  endpoint:  string  // e.g. '/payments/<id>/pay' or '/utility/bills/<id>/pay'
  subheader: string  // displayed under the amount in the modal
  kind:      'rent' | 'utility'
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
  if (loading) return null
  if (!methods.length) {
    return (
      <div className="card" style={{ padding: 14, fontSize: '.82rem', color: 'var(--t2)' }}>
        {emptyCopy ?? (
          <>
            No payment method on file. Click <strong>+ Add bank</strong> or{' '}
            <strong>+ Add card</strong> to connect one and start paying through GAM. ACH is the
            cheapest path; cards are available for urgent or out-of-cycle payments.
          </>
        )}
      </div>
    )
  }
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: '.78rem', color: 'var(--t3)', marginBottom: 8 }}>Saved methods</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {methods.map((m) => (
          <div
            key={m.id}
            style={{
              display:        'flex',
              justifyContent: 'space-between',
              alignItems:     'center',
              fontSize:       '.85rem',
              color:          'var(--t1)',
            }}
          >
            <span>
              {m.type === 'ach'
                ? `🏦 ${m.bankName ?? 'Bank'} ····${m.last4 ?? ''}`
                : `💳 ${(m.brand ?? 'Card').toUpperCase()} ····${m.last4 ?? ''}`}
            </span>
            <span className="badge b-muted" style={{ fontSize: '.7rem' }}>
              {m.type === 'ach' ? 'ACH' : 'Card'}
            </span>
          </div>
        ))}
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
  const initialId   = achMethods[0]?.id ?? cardMethods[0]?.id ?? ''
  const [selectedId, setSelectedId] = useState<string>(initialId)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const selectedMethod = methods.find((m) => m.id === selectedId)
  const selectedType   = selectedMethod?.type ?? null

  const submit = async () => {
    if (!selectedMethod) {
      setError('Pick a payment method first')
      return
    }
    setSubmitting(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await apiPost<PayResponse>(target.endpoint, {
        paymentMethodId:   selectedMethod.id,
        paymentMethodType: selectedMethod.type,
      })
      const status = (res as any)?.data?.status
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
      setError(
        e?.response?.data?.error?.message ||
          e?.response?.data?.error ||
          e?.message ||
          'Payment failed. Try again or contact support.',
      )
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
                  onSelect={() => setSelectedId(m.id)}
                >
                  🏦 {m.bankName ?? 'Bank'} ····{m.last4 ?? ''}
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

          <button
            className="btn btn-p"
            style={{ width: '100%' }}
            disabled={!selectedId || submitting || !!success}
            onClick={submit}
          >
            {submitting
              ? 'Submitting…'
              : success
                ? '✓ Submitted'
                : `Pay ${formatCurrency(target.amount)}`}
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
    return `By clicking Pay you authorize a one-time charge to the selected card for the ${subject} above. Card payments include a 3.25% processing fee (plus 1.5% for non-US-issued cards) which may be passed through depending on your landlord's settings.`
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
  const [phase, setPhase] = useState<'idle' | 'loading' | 'collect' | 'done' | 'error'>('idle')
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const titleVerb  = method === 'ach' ? 'bank account' : 'card'
  const idleCopy   =
    method === 'ach'
      ? 'We\'ll open Stripe\'s secure bank-link flow. Sign in with your bank and instantly verify — no micro-deposits, no waiting.'
      : 'We\'ll collect your card securely through Stripe. Card details never touch GAM\'s servers; we only see the last 4 digits, brand, and expiration once Stripe attaches the card to your account.'
  const loadingCopy = method === 'ach' ? 'Preparing secure bank link…' : 'Preparing secure card form…'
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
            onDone={() => {
              setPhase('done')
              setTimeout(onAdded, 800)
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
  onDone:  () => void
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
      // Card auto-attaches on confirmSetup. No server-side capture step.
      onDone()
      return
    }
    // ACH: server captures bank metadata, flips ach_verified, logs first-sender.
    try {
      await apiPost('/stripe/tenant/confirm-setup', {
        setupIntentId:   setupIntent.id,
        paymentMethodId:
          typeof setupIntent.payment_method === 'string'
            ? setupIntent.payment_method
            : setupIntent.payment_method.id,
      })
      onDone()
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
            ? 'Verifying…'
            : 'Saving…'
          : method === 'ach'
            ? 'Verify bank →'
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
