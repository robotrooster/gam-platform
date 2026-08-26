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
import { formatCurrency, humanize, humanizeEntryDescription, chargeLabel, MANUAL_PAYMENT_FEE_SCOPE } from '@gam/shared'
import { ReportBankDepositModal, ReportedDeposits } from '../components/ReportBankDeposit'
import { apiGet } from '../lib/api'
import { AutopaySection } from './AutopayCard'
import {
  AddPaymentMethodModal,
  PayNowModal,
  SavedMethodsCard,
  VerifyMicrodepositsCard,
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
  // S607: the landlord's own wording for a charge they billed (e.g. "Parking
  // violation"). chargeLabel prefers it over the NACHA code.
  notes?:           string | null
}

// S539: per-line FIFO application breakdown ("where every dollar went")
// from remittance_applications — stored since S537, surfaced here.
// Keys are camelCase: the API's global response transformer converts
// the route's snake_case columns.
interface RemitLine {
  paymentId:        string
  amountApplied:    number
  type:             string
  dueDate:          string
  entryDescription: string | null
  paymentStatus:    string
}

interface Remittance {
  id:              string
  amount:          number
  appliedAmount:   number
  unappliedAmount: number
  status:          'processing' | 'settled' | 'failed'
  paymentMethod:   'ach' | 'card' | null
  createdAt:       string
  settledAt:       string | null
  lines:           RemitLine[]
}

const STATUS_BADGE: Record<string, string> = {
  settled:    'b-green',
  pending:    'b-amber',
  failed:     'b-red',
  processing: 'b-gold',
}

// S607 (Nic): "maybe on the invoice, it can show a breakdown of what each bill
// would be by payment method... that way they see all the avenues and the price
// at the point the invoice comes out."
//
// Every way to pay this balance, priced, before the tenant picks one. The
// figures come from the server, computed with the same formula that actually
// charges — so what is shown here is what gets taken.
//
// When the landlord is covering the cash fee, the row deliberately shows the
// full price struck through with the saving named, rather than quietly showing a
// smaller number. Nic: the tenant "needs to know that the landlord is actively
// covering that and that they may choose to stop covering that at any time" — so
// if a $10 ever does appear later, they recognise it as the landlord stopping
// rather than a new charge nobody warned them about.
function WaysToPay({ lease, reports = [], onReportDeposit, onWithdrawn }: {
  lease: any
  reports?: any[]
  onReportDeposit?: () => void
  onWithdrawn?: () => void
}) {
  const costs: any[] = lease?.methodCosts ?? []
  if (!costs.length) return null
  const covered = !!lease.manualFeeCoveredByLandlord
  const firstFree = !!lease.manualFeeFirstFree
  const absorbed = Number(lease.manualFeeAbsorbed || 0)

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--bd)' }}>
      <div style={{ fontSize: '.7rem', fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
        Ways to pay
      </div>
      {costs.map((c) => {
        const isCash = c.method === 'manual'
        return (
          <div key={c.method} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '3px 0', fontSize: '.78rem' }}>
            <span style={{ color: 'var(--t2)' }}>
              {isCash ? 'Cash, check or money order' : c.label}
              {c.fee > 0 && (
                <span style={{ color: 'var(--t3)', fontSize: '.72rem' }}> · +{formatCurrency(c.fee)} fee</span>
              )}
              {isCash && covered && (
                <span style={{ color: 'var(--t3)', fontSize: '.72rem' }}> · {formatCurrency(absorbed)} fee covered by your landlord</span>
              )}
              {isCash && !covered && firstFree && (
                <span style={{ color: 'var(--t3)', fontSize: '.72rem' }}> · no fee this time</span>
              )}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--t0)', whiteSpace: 'nowrap' }}>
              {formatCurrency(c.total)}
            </span>
          </div>
        )
      })}
      {covered && (
        <div style={{ fontSize: '.7rem', color: 'var(--t3)', marginTop: 6, lineHeight: 1.5 }}>
          Your landlord is currently covering the {formatCurrency(absorbed)} handling fee on
          {' '}{MANUAL_PAYMENT_FEE_SCOPE}. They can stop covering it at any time, and it would then
          appear on your bill.
        </div>
      )}
      {!covered && firstFree && (
        <div style={{ fontSize: '.7rem', color: 'var(--t3)', marginTop: 6, lineHeight: 1.5 }}>
          The handling fee is waived on your <strong>first payment only</strong>. If you pay a
          different way this time, later payments handed to the office will include it.
          It applies to {MANUAL_PAYMENT_FEE_SCOPE}.
        </div>
      )}
      {!covered && !firstFree && (
        <div style={{ fontSize: '.7rem', color: 'var(--t3)', marginTop: 6, lineHeight: 1.5 }}>
          A {formatCurrency(costs.find(c => c.method === 'manual')?.fee || 0)} handling fee applies
          to {MANUAL_PAYMENT_FEE_SCOPE}. It is waived on a first payment only.
        </div>
      )}

      {/* S624: the entry point sits HERE, under the cash row, because this is
          where a tenant is already deciding to pay that way — not buried on a
          separate screen they would have to know to look for. */}
      {onReportDeposit && (
        <button className="btn-ghost" onClick={onReportDeposit}
          style={{ width: '100%', marginTop: 10, fontSize: '.78rem', padding: '8px 12px' }}>
          I paid at the bank — report a deposit
        </button>
      )}
      <ReportedDeposits reports={reports} onWithdrawn={onWithdrawn ?? (() => {})} />
    </div>
  )
}

export function PaymentsPage({ Banner }: { Banner?: React.ComponentType }) {
  const qc = useQueryClient()

  const { data: payments = [], isLoading: paymentsLoading } = useQuery<Payment[]>(
    'payments',
    () => apiGet<Payment[]>('/tenants/payments'),
  )
  const { data: balanceCtx } = useQuery<{
    totalOutstanding: number
    paymentBlocked: boolean
    // S581: one entry per lease — each is paid as its own charge.
    leases: {
      leaseId: string; propertyName: string; unitNumber: string
      paymentBlocked: boolean; outstanding: number
      // S609: balance + roughly the rest of the lease term. A SUGGESTION for
      // the amount box, not a ceiling — there is no cap on paying ahead.
      suggestedPayAhead?: number
      requiredNow?: number
    }[]
    rows: { id: string; amount: number; dueDate: string; type: string; entryDescription: string }[]
    // S616: what the payer owes on each utility service agreement — the same
    // shape as `leases` above. However many utilities are on it, it is one
    // invoice and one payment. Nic: "their trash and electric needs to be on
    // one bill if they have more than one utility through this subsystem."
    serviceAgreements?: {
      serviceAgreementId: string; outstanding: number
      unitNumber: string; propertyName: string; dueDate: string
      rows: { id: string; amount: number; dueDate: string; type: string; notes: string | null }[]
      methodCosts?: any
    }[]
  }>('balance-context', () => apiGet('/payments/balance-context'))
  const { data: methods = [], isLoading: methodsLoading } = useTenantPaymentMethods()
  const { data: remitData } = useQuery<{ remittances: Remittance[]; prepaidRemaining: number }>(
    'remittances',
    () => apiGet('/payments/remittances'),
  )
  // S624: bank deposits this tenant has reported, and what became of them.
  const { data: declaredDeposits = [] } = useQuery<any[]>(
    'declared-deposits',
    () => apiGet('/declared-deposits'),
  )

  const [payTarget, setPayTarget] = useState<{ target: PayTarget } | null>(null)
  const [addMethodOpen, setAddMethodOpen] = useState<'ach' | 'card' | null>(null)
  // S624: "I paid at the bank". Reporting a branch deposit is what lets it be
  // matched and dated automatically — otherwise it sits unattributed until a
  // landlord works out whose it was.
  const [reportDepositFor, setReportDepositFor] =
    useState<{ leaseId: string; outstanding: number } | null>(null)

  const refetchAll = () => {
    qc.invalidateQueries('payments')
    qc.invalidateQueries('balance-context')
    qc.invalidateQueries('declared-deposits')
    qc.invalidateQueries('tenant-payment-methods')
    qc.invalidateQueries('remittances')
  }

  const leaseGroups = balanceCtx?.leases ?? []

  // Rent is PAY-IN-FULL ONLY (Nic) — no partial payments anywhere in the system.
  // A partial payment can reset a landlord's eviction clock, so the tenant always
  // pays the entire outstanding balance; there is no editable amount.
  // S581: each LEASE is paid as its own charge (separate ACH/card + receipt), so
  // a tenant with two leases (overlap move, or two landlords) pays each on its
  // own — a shortfall or an eviction hold on one never blocks the other.
  const openPayLease = (leaseId: string, outstanding: number, suggestedPayAhead?: number, requiredNow?: number) => {
    if (!(outstanding > 0)) return
    setPayTarget({
      target: {
        amount:    Math.round(outstanding * 100) / 100,
        endpoint:  '/payments/pay-balance',
        subheader: 'applied to your oldest balance first',
        kind:      'rent',
        sendAmountInBody: true,
        leaseId,
        // S609: lets the modal offer an amount box for paying months ahead.
        suggestedPayAhead,
        requiredNow,
      },
    })
  }

  // S615: a utility-service charge is paid on its own, through the existing
  // per-charge route. There is no lease behind it and therefore no eviction
  // clock, so the pay-in-full rule that governs rent has nothing to protect
  // here — each bill is simply its own payable document.
  const serviceAgreements = balanceCtx?.serviceAgreements ?? []
  // Someone with utility bills and no lease groups at all is a service-only
  // payer. A tenant who somehow had both would keep the rent-shaped page.
  const serviceOnlyPayer = serviceAgreements.length > 0 && (balanceCtx?.leases ?? []).length === 0
  // S616: everything outstanding on the agreement in ONE charge — one Stripe
  // transaction, one processing fee. Paying each utility separately would
  // charge the fee twice for one month at one address.
  const openPayServiceAgreement = (b: any) => {
    setPayTarget({
      target: {
        amount:    Math.round(Number(b.outstanding) * 100) / 100,
        endpoint:  '/payments/pay-balance',
        subheader: 'your utility bill, paid in full',
        kind:      'utility',
        sendAmountInBody: true,
        serviceAgreementId: b.serviceAgreementId,
      },
    })
  }

  // S581: leases the tenant can actually pay right now (unblocked, non-zero).
  const payable = leaseGroups.filter((l) => !l.paymentBlocked && l.outstanding > 0)
  const payableTotal = Math.round(payable.reduce((s, l) => s + l.outstanding, 0) * 100) / 100

  // "Pay all" — ONLY when there are 2+ payable leases (any mix: two units, a
  // unit + a parking spot, two parking spots…). One method, a separate charge
  // per lease. A single lease never shows it (that lease's own Pay button is it).
  const openPayAll = () => {
    if (payable.length < 2) return
    setPayTarget({
      target: {
        amount:    payableTotal,
        endpoint:  '/payments/pay-balance',
        subheader: `across your ${payable.length} leases — each paid separately, oldest charges first`,
        kind:      'rent',
        batch:     payable.map((l) => ({ leaseId: l.leaseId, amount: Math.round(l.outstanding * 100) / 100 })),
      },
    })
  }

  // S582: first-rent readiness. If the tenant OWES rent but their only payment
  // method is a bank still verifying (microdeposits ~1–3 biz days), reassure them
  // so the "log in and pay" moment never feels broken — card is instant if they
  // want to pay today, and we surface when rent is actually due so they know they
  // have time.
  const hasPendingBank = methods.some((m: any) => m.type === 'ach' && m.verified === false)
  const hasInstantMethod = methods.some((m: any) => m.type === 'card' || (m.type === 'ach' && m.verified !== false))
  const showVerifyingNotice = payable.length > 0 && hasPendingBank && !hasInstantMethod
  const fmtDue = (ymd?: string): string | null => {
    const m = ymd && /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd)
    if (!m) return null
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
    return `${MONTHS[+m[2] - 1]} ${+m[3]}`
  }
  // S583: wire format is camelCase (API global camelize middleware) — reading
  // r.due_date left earliestDue null, silently dropping the "rent is due X, you
  // have time" reassurance line in the S582 verifying-bank notice below.
  const earliestDue = fmtDue([...(balanceCtx?.rows ?? [])].map(r => r.dueDate).filter(Boolean).sort()[0])

  return (
    <div>
      {/* S603: a tenant whose bank is awaiting microdeposit confirmation
          finishes it HERE rather than on a Stripe-hosted page. Renders itself
          away when nothing is pending. */}
      <VerifyMicrodepositsCard onVerified={() => qc.invalidateQueries('tenant-payment-methods')} />
      <div className="ph">
        <div>
          {/* S615: a utility-service payer pays no rent, so the subtitle would
              be describing somebody else's account. */}
          <h1 className="pt">{serviceOnlyPayer ? 'Billing' : 'Payments'}</h1>
          <p className="ps">
            {serviceOnlyPayer ? 'Pay your utility bill and view history' : 'Pay rent and view history'}
          </p>
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

      {showVerifyingNotice && (
        <div className="card" style={{ borderLeft: '3px solid var(--gold)', padding: '12px 16px', marginBottom: 12 }}>
          <div style={{ fontWeight: 700, color: 'var(--t0)', marginBottom: 2 }}>Your bank is still verifying</div>
          <div style={{ fontSize: '.82rem', color: 'var(--t2)', lineHeight: 1.5 }}>
            This usually takes <strong>1–3 business days</strong> — we’ll email you the moment it’s ready, then you can pay by bank.
            {earliestDue ? <> Your rent is due <strong>{earliestDue}</strong>, so you have time.</> : null}
            {' '}Want to pay today? <button className="btn-link" style={{ padding: 0, font: 'inherit', color: 'var(--gold)', cursor: 'pointer', background: 'none', border: 'none' }} onClick={() => setAddMethodOpen('card')}>Add a card</button> — card payments are instant.
          </div>
        </div>
      )}

      {/* S609 (Nic): "I want the tenant portal to still show how much
          outstanding credit they have. If it's ten thousand dollars in
          prepayments, it should show that they have ten thousand dollars in
          credit." Top of the page, not tucked into a history card. */}
      {(remitData?.prepaidRemaining ?? 0) > 0 && (
        <div className="card" style={{ padding: 16, marginTop: 16, borderColor: 'var(--green)' }}>
          <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 4 }}>
            Account credit
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.4rem', color: 'var(--green)' }}>
            {formatCurrency(remitData!.prepaidRemaining)}
          </div>
          <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 }}>
            Money you&apos;ve paid ahead. It comes off each bill automatically as it arrives — you don&apos;t
            need to do anything. Anything still unused comes back to you when you move out.
          </div>
        </div>
      )}

      <SavedMethodsCard methods={methods} loading={methodsLoading} />

      {/* S609: the tenant's autopay control. There is deliberately no landlord
          equivalent — the pull day is the tenant's alone (Nic). */}
      <AutopaySection />

      {/* S570 (Nic): removed the cash/check/MO fee banner — a tenant can't
          initiate a cash payment through the portal (they hand cash to the
          landlord, who records it), so the tenant-facing banner was nonsensical. */}

      {/* S581: "Pay all" — only with 2+ payable leases. One method, a separate
          charge per lease. */}
      {payable.length >= 2 && (
        <div className="card" style={{ padding: 16, marginTop: 16, borderColor: 'var(--gold)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 4 }}>
                All leases · {payable.length}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.4rem', color: 'var(--t0)' }}>
                {formatCurrency(payableTotal)}
              </div>
              <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 4 }}>
                Pays every lease at once — each is charged separately, so one clearing
                doesn&apos;t depend on the others.
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
              <button className="btn btn-p" onClick={openPayAll}>
                Pay all {formatCurrency(payableTotal)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* S537 → S581: the payment surface — one Pay card PER LEASE (each lease
          is charged separately, in full). A single-lease tenant sees one card. */}
      {leaseGroups.map((lg) => (
        lg.paymentBlocked ? (
          <div key={lg.leaseId} className="card" style={{ padding: 14, marginTop: 16, fontSize: '.8rem', color: 'var(--t1)' }}>
            Payments for {lg.propertyName} · Unit {lg.unitNumber} are currently paused. Contact your landlord.
          </div>
        ) : lg.outstanding > 0 ? (
          <div key={lg.leaseId} className="card" style={{ padding: 16, marginTop: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 4 }}>
                  Outstanding balance{leaseGroups.length > 1 ? ` — ${lg.propertyName} · Unit ${lg.unitNumber}` : ''}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.4rem', color: 'var(--t0)' }}>
                  {formatCurrency(lg.outstanding)}
                </div>
                <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 4 }}>
                  Rent is paid in full — this covers your entire balance on this lease,
                  oldest charges first.
                </div>
                <WaysToPay
                  lease={lg}
                  reports={declaredDeposits.filter((d: any) => d.leaseId === lg.leaseId)}
                  onReportDeposit={() => setReportDepositFor({
                    leaseId: lg.leaseId, outstanding: lg.outstanding })}
                  onWithdrawn={refetchAll}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                <button className="btn btn-p" onClick={() => openPayLease(lg.leaseId, lg.outstanding, lg.suggestedPayAhead, lg.requiredNow)}>
                  Pay {formatCurrency(lg.outstanding)}
                </button>
              </div>
            </div>
          </div>
        ) : null
      ))}

      {/* S616: one card per AGREEMENT — every utility on it, one Pay. */}
      {serviceAgreements.map((b: any) => (
        <div key={b.serviceAgreementId} className="card" style={{ padding: 16, marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 4 }}>
                Utility bill — {b.propertyName}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.4rem', color: 'var(--t0)' }}>
                {formatCurrency(b.outstanding)}
              </div>
              <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 2 }}>Due {b.dueDate}</div>
              {/* Every utility itemised, so the total is never a number they
                  have to phone up about. */}
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {b.rows.map((l: any) => (
                  <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '.78rem' }}>
                    <span style={{ color: 'var(--t2)' }}>
                      {l.type === 'late_fee' ? 'Late fee' : (l.notes || 'Utilities')}
                    </span>
                    <span className="mono" style={{ color: 'var(--t1)' }}>{formatCurrency(l.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
              <button className="btn btn-p" onClick={() => openPayServiceAgreement(b)}>
                Pay {formatCurrency(b.outstanding)}
              </button>
            </div>
          </div>
        </div>
      ))}

      <SecurityDepositCard />

      {remitData && (remitData.remittances.length > 0 || remitData.prepaidRemaining > 0) && (
        <RemittancesCard remittances={remitData.remittances} prepaidRemaining={remitData.prepaidRemaining} />
      )}

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
                        {chargeLabel(p.entryDescription, p.notes)}
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

      {reportDepositFor && (
        <ReportBankDepositModal
          leaseId={reportDepositFor.leaseId}
          outstanding={reportDepositFor.outstanding}
          onReported={refetchAll}
          onClose={() => setReportDepositFor(null)}
        />
      )}

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

// S539: "Payments you've made" — each Pay Now remittance expands into
// its per-line FIFO application ("where every dollar went"). Read-only,
// same posture as the outstanding ledger: the tenant never picks
// targets, but they can always see exactly what each dollar covered.
function RemittancesCard({ remittances, prepaidRemaining }: {
  remittances: Remittance[]
  prepaidRemaining: number
}) {
  const [openId, setOpenId] = useState<string | null>(null)

  const METHOD_LABEL: Record<string, string> = { ach: 'ACH', card: 'Card' }
  // Entry descriptions like 'RENT'/'LATEFEE' just restate the type —
  // showing both reads as a stutter next to the type badge.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')

  return (
    <div className="card" style={{ padding: 16, marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: remittances.length ? 10 : 0 }}>
        <div>
          <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 4 }}>
            Payments you&rsquo;ve made
          </div>
          <div style={{ fontSize: '.74rem', color: 'var(--t3)' }}>
            Select a payment to see exactly where every dollar went.
          </div>
        </div>
        {prepaidRemaining > 0 && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1rem', color: 'var(--green)' }}>
              {formatCurrency(prepaidRemaining)}
            </div>
            <div style={{ fontSize: '.7rem', color: 'var(--t3)' }}>
              Prepaid credit — applies to your next bill automatically
            </div>
          </div>
        )}
      </div>

      {remittances.map((r) => {
        const open = openId === r.id
        return (
          <div key={r.id} style={{ border: '1px solid var(--border-0)', borderRadius: 6, marginTop: 8 }}>
            <button
              onClick={() => setOpenId(open ? null : r.id)}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                width: '100%', padding: '10px 12px', background: 'none', border: 'none',
                cursor: 'pointer', textAlign: 'left', color: 'inherit',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className="mono" style={{ fontSize: '.75rem', color: 'var(--t3)' }}>
                  {new Date(r.createdAt).toLocaleDateString()}
                </span>
                <span className="mono" style={{ fontWeight: 700, color: 'var(--t0)' }}>
                  {formatCurrency(r.amount)}
                </span>
                {r.paymentMethod && (
                  <span className="badge b-muted">{METHOD_LABEL[r.paymentMethod] ?? humanize(r.paymentMethod)}</span>
                )}
                <span className={`badge ${STATUS_BADGE[r.status] || 'b-muted'}`}>{humanize(r.status)}</span>
              </div>
              <span style={{ fontSize: '.7rem', color: 'var(--t3)' }}>{open ? '▲' : '▼'}</span>
            </button>

            {open && (
              <div style={{ padding: '0 12px 12px' }}>
                {r.status === 'failed' ? (
                  <div style={{ fontSize: '.76rem', color: 'var(--t1)', padding: 10, background: 'var(--bg-2)', borderRadius: 6 }}>
                    This payment didn&rsquo;t go through — nothing was applied. The charges below returned to your outstanding balance.
                  </div>
                ) : null}
                <table className="tbl" style={{ width: '100%', fontSize: '.78rem', marginTop: r.status === 'failed' ? 8 : 0 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left' }}>Applied to</th>
                      <th style={{ textAlign: 'left' }}>Due</th>
                      <th style={{ textAlign: 'right' }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.lines.map((ln) => (
                      <tr key={ln.paymentId}>
                        <td>
                          <span className="badge b-muted" style={{ marginRight: 6 }}>{humanize(ln.type)}</span>
                          {ln.entryDescription && norm(ln.entryDescription) !== norm(ln.type) && (
                            <span style={{ fontSize: '.72rem', color: 'var(--t3)' }}>{humanizeEntryDescription(ln.entryDescription)}</span>
                          )}
                        </td>
                        <td className="mono" style={{ fontSize: '.72rem' }}>
                          {new Date(ln.dueDate.slice(0, 10) + 'T00:00:00').toLocaleDateString()}
                        </td>
                        <td className="mono" style={{ textAlign: 'right', color: 'var(--t0)', fontWeight: 600 }}>
                          {formatCurrency(ln.amountApplied)}
                        </td>
                      </tr>
                    ))}
                    {r.unappliedAmount > 0 && (
                      <tr>
                        <td colSpan={2} style={{ fontSize: '.74rem', color: 'var(--green)' }}>
                          Paid ahead — {r.status === 'settled'
                            ? 'banked as prepaid credit toward your next bill'
                            : 'becomes prepaid credit when this payment settles'}
                        </td>
                        <td className="mono" style={{ textAlign: 'right', color: 'var(--green)', fontWeight: 600 }}>
                          {formatCurrency(r.unappliedAmount)}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}
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
              Your landlord pays {Number(data.rate.annualRatePct).toFixed(2)}% annual interest on your deposit ({data.rate.effectiveYear}). Interest accrues monthly and is paid out with your refund at move-out.
            </>
          )}
        </div>
      ) : (
        <div style={{ fontSize: '.74rem', color: 'var(--t3)', lineHeight: 1.5, padding: 10, background: 'var(--bg-2)', borderRadius: 6 }}>
          Your deposit is held in full and returned at move-out, minus any deductions. Where deposit interest is required, it's applied to your refund automatically.
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
