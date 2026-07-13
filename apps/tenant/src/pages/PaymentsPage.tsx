/**
 * Tenant /payments page — S537 FIFO Pay Now (supersedes the S169-171
 * per-row flow).
 *
 * The outstanding ledger is READ-ONLY: the tenant never picks which
 * charge a payment lands on. ONE Pay Now covers the balance oldest-first
 * (POST /api/payments/pay-balance): any amount — partial, full, or
 * ahead — unless the property rejects partials (eviction-clock
 * protection), in which case the amount locks to the full balance.
 * Pay-ahead remainder becomes a prepaid credit consumed by the next
 * invoice automatically.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { formatCurrency, humanize } from '@gam/shared'
import { apiGet } from '../lib/api'
import {
  AddPaymentMethodModal,
  PayNowModal,
  SavedMethodsCard,
  useTenantPaymentMethods,
  type PayTarget,
} from './payShared'

interface Payment {
  id:               string
  dueDate:          string
  type:             string
  amount:           number
  status:           string
  entryDescription: string
}

const STATUS_BADGE: Record<string, string> = {
  settled:    'b-green',
  pending:    'b-amber',
  failed:     'b-red',
  processing: 'b-gold',
}

export function PaymentsPage({ Banner }: { Banner?: React.ComponentType }) {
  const qc = useQueryClient()

  const { data: payments = [], isLoading: paymentsLoading } = useQuery<Payment[]>(
    'payments',
    () => apiGet<Payment[]>('/tenants/payments'),
  )
  const { data: balanceCtx } = useQuery<{
    totalOutstanding: number
    acceptPartialPayments: boolean
    paymentBlocked: boolean
    rows: { id: string; amount: number; due_date: string; type: string; entry_description: string }[]
  }>('balance-context', () => apiGet('/payments/balance-context'))
  const { data: methods = [], isLoading: methodsLoading } = useTenantPaymentMethods()

  const [payTarget, setPayTarget] = useState<{ target: PayTarget } | null>(null)
  const [addMethodOpen, setAddMethodOpen] = useState<'ach' | 'card' | null>(null)
  const [payAmount, setPayAmount] = useState<string>('')

  const refetchAll = () => {
    qc.invalidateQueries('payments')
    qc.invalidateQueries('balance-context')
    qc.invalidateQueries('tenant-payment-methods')
  }

  const total = balanceCtx?.totalOutstanding ?? 0
  const mustPayFull = balanceCtx ? !balanceCtx.acceptPartialPayments : false
  const effectiveAmount = mustPayFull ? total : (payAmount === '' ? total : Number(payAmount))

  const openPayBalance = () => {
    if (!(effectiveAmount > 0)) return
    setPayTarget({
      target: {
        amount:    Math.round(effectiveAmount * 100) / 100,
        endpoint:  '/payments/pay-balance',
        subheader: effectiveAmount > total + 0.005
          ? `$${total.toFixed(2)} balance + $${(effectiveAmount - total).toFixed(2)} paid ahead`
          : `applied to your oldest balance first`,
        kind:      'rent',
        sendAmountInBody: true,
      },
    })
  }

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">Payments</h1>
          <p className="ps">Pay rent and view history</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-p btn-sm" onClick={() => setAddMethodOpen('ach')}>
            + Add bank
          </button>
          <button className="btn btn-p btn-sm" onClick={() => setAddMethodOpen('card')}>
            + Add card
          </button>
        </div>
      </div>

      {Banner ? <Banner /> : null}

      <SavedMethodsCard methods={methods} loading={methodsLoading} />

      {/* S537: THE payment surface — one button, FIFO application. */}
      {balanceCtx && total > 0 && !balanceCtx.paymentBlocked && (
        <div className="card" style={{ padding: 16, marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 4 }}>
                Outstanding balance
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.4rem', color: 'var(--t0)' }}>
                {formatCurrency(total)}
              </div>
              <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 4 }}>
                Payments apply to your oldest balance first.
                {mustPayFull
                  ? ' This property requires the full balance.'
                  : ' Pay any amount — paying extra credits your next bill.'}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
              {!mustPayFull && (
                <div>
                  <span style={{ fontSize: '.68rem', color: 'var(--t3)', display: 'block', marginBottom: 4 }}>Amount</span>
                  <input className="inp mono" inputMode="decimal" value={payAmount} placeholder={total.toFixed(2)}
                    onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setPayAmount(v) }}
                    style={{ width: 110 }} />
                </div>
              )}
              <button className="btn btn-p" onClick={openPayBalance} disabled={!(effectiveAmount > 0)}>
                Pay now
              </button>
            </div>
          </div>
        </div>
      )}
      {balanceCtx?.paymentBlocked && (
        <div className="card" style={{ padding: 14, marginTop: 16, fontSize: '.8rem', color: 'var(--t1)' }}>
          Payments to your landlord are currently paused for this unit. Contact your landlord.
        </div>
      )}

      <SecurityDepositCard />

      <div className="card" style={{ padding: 0, overflowX: 'auto', marginTop: 16 }}>
        {paymentsLoading ? (
          <div style={{ padding: 32, color: 'var(--t3)', textAlign: 'center' }}>Loading…</div>
        ) : (
          <table className="tbl" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>Due</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Method</th>
              </tr>
            </thead>
            <tbody>
              {payments.length ? (
                payments.map((p) => {
                  return (
                    <tr key={p.id}>
                      <td className="mono" style={{ fontSize: '.75rem' }}>
                        {new Date(p.dueDate).toLocaleDateString()}
                      </td>
                      <td>
                        <span className="badge b-muted">{humanize(p.type)}</span>
                      </td>
                      <td className="mono" style={{ color: 'var(--t0)', fontWeight: 600 }}>
                        {formatCurrency(p.amount)}
                      </td>
                      <td>
                        <span className={`badge ${STATUS_BADGE[p.status] || 'b-muted'}`}>
                          {p.status}
                        </span>
                      </td>
                      <td style={{ fontSize: '.75rem', color: 'var(--t3)' }}>
                        {p.entryDescription}
                      </td>

                    </tr>
                  )
                })
              ) : (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', color: 'var(--t3)', padding: 32 }}>
                    No payment history yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {payTarget && (
        <PayNowModal
          target={payTarget.target}
          methods={methods}
          onClose={() => setPayTarget(null)}
          onAddMethod={(m) => {
            setPayTarget(null)
            setAddMethodOpen(m)
          }}
          onPaid={() => {
            setPayTarget(null)
            refetchAll()
          }}
        />
      )}

      {addMethodOpen && (
        <AddPaymentMethodModal
          method={addMethodOpen}
          onClose={() => setAddMethodOpen(null)}
          onAdded={() => {
            setAddMethodOpen(null)
            refetchAll()
          }}
        />
      )}
    </div>
  )
}

// S189: tenant-facing security deposit + statutory interest card.
// Shown below the saved-methods card on the Payments page. Hidden
// when the tenant has no security deposit row.
//
// Three states:
//   1. No deposit row → render nothing
//   2. Deposit + state has hardcoded rate → show principal +
//      collected + interest_accrued + accrual history
//   3. Deposit + state has NO hardcoded rate → show principal +
//      collected, no interest line (the state has no statutory
//      requirement under GAM's framing)
type DepositInterestData = {
  deposit: {
    id:                string
    leaseId:          string
    totalAmount:      string
    collectedAmount:  string
    interestAccrued:  string
    status:            string
    heldBy:           string
    state:             string | null
    propertyName:     string | null
    createdAt:        string
  } | null
  rate: {
    source:           'statutory' | 'landlord_override'
    stateCode:       string
    effectiveYear:   number
    annualRatePct:  string
    statuteCitation: string | null  // null for landlord_override
    notes:            string | null
  } | null
  accruals: Array<{
    accrualMonth:    string
    stateCode:       string
    annualRatePct:  string
    principalAmount: string
    daysHeld:        number
    interestAmount:  string
    createdAt:       string
  }>
}

function SecurityDepositCard() {
  const { data, isLoading } = useQuery<DepositInterestData>(
    'tenant-deposit-interest',
    () => apiGet<DepositInterestData>('/tenants/me/deposit-interest'),
  )

  if (isLoading || !data || !data.deposit) return null

  const principal = Number(data.deposit.totalAmount)
  const collected = Number(data.deposit.collectedAmount)
  const interest = Number(data.deposit.interestAccrued)
  const tenantPool = collected + interest

  const monthLabel = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  }

  return (
    <div className="card" style={{ padding: 16, marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 16 }}>
        <div>
          <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 4 }}>
            Security deposit
          </div>
          <div style={{ fontSize: '.78rem', color: 'var(--t3)' }}>
            Held in escrow at {data.deposit.propertyName ?? 'your property'}.
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.1rem', color: 'var(--t0)' }}>
            ${tenantPool.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div style={{ fontSize: '.7rem', color: 'var(--t3)' }}>
            Total owed at move-out
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 12 }}>
        <DepositTile label="Required" value={`$${principal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
        <DepositTile label="Collected" value={`$${collected.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} tone={collected >= principal ? 'green' : 'amber'} />
        {data.rate && (
          <DepositTile
            label="Interest accrued"
            value={`$${interest.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            tone="green"
          />
        )}
      </div>

      {data.rate ? (
        <div style={{ fontSize: '.74rem', color: 'var(--t3)', lineHeight: 1.5, padding: 10, background: 'var(--bg-2)', borderRadius: 6 }}>
          {data.rate.source === 'statutory' ? (
            <>
              {data.rate.stateCode} requires {Number(data.rate.annualRatePct).toFixed(2)}% annual interest on held deposits per <em>{data.rate.statuteCitation}</em>. Interest accrues monthly and is paid out with your refund at move-out.
            </>
          ) : (
            <>
              Your landlord has set a {Number(data.rate.annualRatePct).toFixed(2)}% annual interest rate for {data.rate.stateCode} deposits ({data.rate.effectiveYear}). Interest accrues monthly and is paid out with your refund at move-out.
            </>
          )}
        </div>
      ) : (
        <div style={{ fontSize: '.74rem', color: 'var(--t3)', lineHeight: 1.5, padding: 10, background: 'var(--bg-2)', borderRadius: 6 }}>
          {data.deposit.state ?? 'Your state'} has no statutory deposit-interest requirement. Your deposit is held in full and returned at move-out minus any deductions.
        </div>
      )}

      {data.accruals.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: '.68rem', fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
            Monthly accrual history
          </div>
          <table className="tbl" style={{ width: '100%', fontSize: '.78rem' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Month</th>
                <th style={{ textAlign: 'right' }}>Principal</th>
                <th style={{ textAlign: 'center' }}>Days</th>
                <th style={{ textAlign: 'right' }}>Interest</th>
              </tr>
            </thead>
            <tbody>
              {data.accruals.map((a) => (
                <tr key={a.accrualMonth}>
                  <td>{monthLabel(a.accrualMonth)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    ${Number(a.principalAmount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td style={{ textAlign: 'center' }}>{a.daysHeld}</td>
                  <td className="mono" style={{ textAlign: 'right', color: 'var(--green)' }}>
                    +${Number(a.interestAmount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function DepositTile({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'green' | 'amber' }) {
  const color = tone === 'green' ? 'var(--green)' : tone === 'amber' ? 'var(--amber)' : 'var(--t0)'
  return (
    <div style={{ padding: 10, border: '1px solid var(--border-0)', borderRadius: 6 }}>
      <div style={{ fontSize: '.65rem', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '.95rem', color }}>
        {value}
      </div>
    </div>
  )
}
