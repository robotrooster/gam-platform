/**
 * Tenant /payments page — S537 FIFO Pay Now (supersedes the S169-171
 * per-row flow).
 *
 * The outstanding ledger is READ-ONLY: the tenant never picks which
 * charge a payment lands on. ONE Pay Now covers the balance oldest-first
 * (POST /api/payments/pay-balance). Rent is paid in full (Nic, standing
 * directive); more than the balance pays ahead, and that remainder is kept
 * as credit on the account.
 *
 * S655 (Nic, 10/2): the full balance is shown, with "You have $X credit
 * available — you can use it when you pay" beside it. Credit is the tenant's
 * to use or save at Pay ("Use all" / "Save it for later", lib/payCredit); it
 * pays a bill by itself only when it covers the whole bill.
 */
import { useState } from 'react'
import { useQueries, useQuery, useQueryClient } from 'react-query'
import { paidByLabel, formatCurrency, humanize, humanizeEntryDescription, chargeLabel, PAYMENT_STATUS_LABEL, type PaymentStatus } from '@gam/shared'
import { ReportBankDepositModal, ReportedDeposits, type WithdrawRefusal } from '../components/ReportBankDeposit'
import { apiGet, apiPost } from '../lib/api'
import { owedOf, requiredOf, creditOffer, planCharges, roundCents, type LeaseBill } from '../lib/payCredit'
import { utilityLine } from '../lib/utilityLine'
import { AutopaySection } from './AutopayCard'
import {
  AddPaymentMethodModal,
  PayNowModal,
  SavedMethodsCard,
  VerifyMicrodepositsCard,
  useTenantPaymentMethods,
  readBalanceContext,
  AwaitingCardPayments,
  CARD_HISTORY_STATE_LABEL,
  type CardHistoryState,
  type PayTarget,
} from './payShared'
import type { AwaitingCardConfirmation } from '../lib/payCredit'

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
  // decisions #17: the utility a utility line is for, once the server sends it
  // (the bill's own name first; lib/utilityLine reads the note until then).
  label?:           string | null
  utilityType?:     string | null
  // S654: how it was paid — cash/check/money order, bank, card online, card in person.
  paidBy?:          string | null
  paymentChannel?:  'online' | 'in_person' | null
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
  // decisions #17: what a utility line is for, once GET /payments/remittances
  // sends it (lib/utilityLine reads the note until then).
  notes?:           string | null
  label?:           string | null
  utilityType?:     string | null
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
  /** S655: account credit this payment used (set aside while it clears, then used). */
  creditUsed?:     number
  /**
   * decisions.md #48.4: a card payment released before anything was charged,
   * as recorded on its receipt when it was released: canceled (its bank's
   * confirmation closed, failed or ran out, or canceled to pay another way)…
   */
  canceledBeforeCharge?: boolean
  /** …or declined by the card's bank after the cardholder confirmed it. */
  declinedBeforeCharge?: boolean
  lines:           RemitLine[]
}

/** A card payment's state named in plain words where the status alone would mislead (decisions.md #48.4). */
function cardHistoryState(r: Remittance, waitingOnBank: ReadonlySet<string>): CardHistoryState | null {
  if (r.paymentMethod !== 'card') return null
  if (r.status === 'processing' && waitingOnBank.has(r.id)) return 'waiting_on_bank'
  if (r.status === 'failed' && r.canceledBeforeCharge === true) return 'canceled_nothing_charged'
  if (r.status === 'failed' && r.declinedBeforeCharge === true) return 'declined_nothing_charged'
  return null
}

/** A status in plain words — never the raw value. */
const statusLabel = (s: string): string => PAYMENT_STATUS_LABEL[s as PaymentStatus] ?? humanize(s)

/** One kind of account credit, named (S642): paid ahead, deposit interest, landlord credit. */
function CreditKindRow({ label, amount, note }: { label: string; amount: number; note?: string }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '.8rem' }}>
        <span style={{ color: 'var(--t1)' }}>{label}</span>
        <span className="mono" style={{ color: 'var(--t0)', fontWeight: 600 }}>{formatCurrency(amount)}</span>
      </div>
      {note && <div style={{ fontSize: '.72rem', color: 'var(--t3)', lineHeight: 1.5, marginTop: 2 }}>{note}</div>}
    </div>
  )
}

/** What one way of paying costs, as the server prices it. */
interface MethodCost { method: string; label: string; fee: number; total: number }

/** One charge a Pay button names: a lease's bill as the server quoted it, and the money sent. */
interface PricedCharge { lease: LeaseBill & { methodCosts?: MethodCost[] }; amount: number }

/**
 * "Ways to pay" for exactly the charges a Pay button names, every figure the
 * server's own (S601/S607: what is shown is what gets taken). Each charge is
 * its own payment with its own fee (S581).
 *
 * The bill's own figures (balance-context methodCosts) are priced at the bill
 * alone — the "Save it for later" figure. A charge that also pays an earlier
 * balance is a different amount, so it is asked of POST /payments/quote, which
 * prices any amount on that lease the way /pay-balance charges it: the
 * property's fee payer (a landlord who covers bank fees makes the bank fee $0)
 * and any tenant-payer platform fee on top. Never the shared list price — it
 * knows neither.
 *
 * Returns null while a figure is still being asked, 'failed' when one could
 * not be had (nothing is shown rather than a guess), else the summed rows.
 */
function useServerCosts(charges: PricedCharge[] | null): MethodCost[] | null | 'failed' {
  const live = (charges ?? []).filter((c) => c.amount > 0)
  const asked = live.filter((c) => !servedAsIs(c))
  const results = useQueries(asked.flatMap((c) => (['ach', 'card'] as const).map((method) => ({
    queryKey: ['charge-quote', c.lease.leaseId, roundCents(c.amount), method],
    queryFn: () => apiPost<any>('/payments/quote', { leaseId: c.lease.leaseId, amount: roundCents(c.amount), method })
      .then((r: any) => r?.data ?? null),
    retry: 1,
  }))))
  if (!charges) return null
  if (live.length === 0) return []
  if (results.some((r) => r.isError || (r.isSuccess && !r.data))) return 'failed'
  if (results.some((r) => !r.isSuccess)) return null
  const quoted = (leaseId: string, amount: number, method: 'ach' | 'card') => {
    const i = asked.findIndex((c) => c.lease.leaseId === leaseId && roundCents(c.amount) === roundCents(amount))
    return results[i * 2 + (method === 'ach' ? 0 : 1)]?.data as { fee: number; total: number } | undefined
  }
  const order = (live[0].lease.methodCosts ?? []).map((c) => c.method)
  const sums = new Map<string, MethodCost>()
  for (const c of live) {
    for (const row of c.lease.methodCosts ?? []) {
      let fee: number, total: number
      if (servedAsIs(c)) { fee = Number(row.fee); total = Number(row.total) }
      else if (row.method === 'ach' || row.method === 'card') {
        const q = quoted(c.lease.leaseId, c.amount, row.method)
        if (!q) return 'failed'
        fee = Number(q.fee); total = Number(q.total)
      } else {
        // Cash, check and money order are free (S654): the money, no fee.
        fee = 0; total = roundCents(c.amount)
      }
      const had = sums.get(row.method)
      sums.set(row.method, had
        ? { ...had, fee: roundCents(had.fee + fee), total: roundCents(had.total + total) }
        : { method: row.method, label: row.label, fee: roundCents(fee), total: roundCents(total) })
    }
  }
  return order.map((m) => sums.get(m)).filter((x): x is MethodCost => !!x)
}

/** The server's own figures already price this charge: it is the bill alone. */
function servedAsIs(c: PricedCharge): boolean {
  return (c.lease.methodCosts ?? []).length > 0 && Math.abs(c.amount - requiredOf(c.lease)) < 0.005
}

/** S655 (Nic, 10/2): the credit sentence beside a balance. The choice is made at Pay. */
function CreditBeside({ usable }: { usable: number }) {
  if (!(usable > 0)) return null
  return (
    <div style={{ fontSize: '.78rem', color: 'var(--green)', marginTop: 6, lineHeight: 1.5 }}>
      You have {formatCurrency(usable)} credit available — you can use it when you pay.
    </div>
  )
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
// charges — so what is shown here is what gets taken. S654: cash, check and
// money order are free; the server's label for that row says so.
function WaysToPay({ lease, costs: pricedCosts, reports = [], onReportDeposit, onWithdrawn, refusal, onRefusal }: {
  lease: any
  /**
   * The figures for exactly what the Pay button names (useServerCosts), when
   * they differ from the bill's own: null while the server is asked, 'failed'
   * when it could not say. Left out, the bill's own figures are used.
   */
  costs?: MethodCost[] | null | 'failed'
  reports?: any[]
  onReportDeposit?: () => void
  onWithdrawn?: () => void
  refusal?: WithdrawRefusal | null
  onRefusal?: (r: WithdrawRefusal | null) => void
}) {
  // Shown only where the server prices this bill at all (the reports list
  // below lives here, so a figure still on its way never hides it).
  if (!((lease?.methodCosts ?? []).length > 0)) return null
  const costs: MethodCost[] = pricedCosts === undefined ? lease.methodCosts
    : Array.isArray(pricedCosts) ? pricedCosts : []

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--bd)' }}>
      <div style={{ fontSize: '.7rem', fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
        Ways to pay
      </div>
      {pricedCosts === null && (
        <div style={{ fontSize: '.76rem', color: 'var(--t3)', padding: '3px 0' }}>Working out the fee for each way to pay…</div>
      )}
      {pricedCosts === 'failed' && (
        <div style={{ fontSize: '.76rem', color: 'var(--t3)', padding: '3px 0', lineHeight: 1.5 }}>
          We couldn&apos;t work out the fees just now. Press Pay — the exact fee for the way you choose is shown before anything is charged.
        </div>
      )}
      {costs.map((c) => (
        <div key={c.method} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '3px 0', fontSize: '.78rem' }}>
          <span style={{ color: 'var(--t2)' }}>
            {c.label}
            {c.fee > 0 && (
              <span style={{ color: 'var(--t3)', fontSize: '.72rem' }}> · +{formatCurrency(c.fee)} fee</span>
            )}
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--t0)', whiteSpace: 'nowrap' }}>
            {formatCurrency(c.total)}
          </span>
        </div>
      ))}

      {/* S624: the entry point sits HERE, under the cash row, because this is
          where a tenant is already deciding to pay that way — not buried on a
          separate screen they would have to know to look for. */}
      {onReportDeposit && (
        <button className="btn-ghost" onClick={onReportDeposit}
          style={{ width: '100%', marginTop: 10, fontSize: '.78rem', padding: '8px 12px' }}>
          I paid at the bank — report a deposit
        </button>
      )}
      <ReportedDeposits reports={reports} onWithdrawn={onWithdrawn ?? (() => {})}
        refusal={refusal} onRefusal={onRefusal} />
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
    // S655: each lease's bill as /pay-balance quotes it — the full balance,
    // and beside it the credit that could pay part of it (LeaseBill).
    leases: (LeaseBill & {
      propertyName: string; unitNumber: string
      paymentBlocked: boolean
      // S654: what each way of paying costs on THIS lease — summed into the
      // one card when there are two or more leases.
      methodCosts?: { method: string; label: string; fee: number; total: number }[]
    })[]
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
    // decisions.md #48.4: every card payment on the household's bills still
    // waiting on its card's bank (3-D Secure), in one list for this page.
    awaitingCardConfirmations?: AwaitingCardConfirmation[]
  }>('balance-context', () => readBalanceContext())
  const { data: methods = [], isLoading: methodsLoading } = useTenantPaymentMethods()
  const { data: remitData } = useQuery<{
    remittances: Remittance[]
    prepaidRemaining: number
    prepaidMonthlyDraw?: number | null
    /** S642: statutory deposit interest credited to the account. */
    depositInterestCredit?: number
    otherCreditTotal?: number
  }>(
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
  // S655 review: the server's answer to an "I hadn't paid" it would not do,
  // held by the page — see depositRefusalInCard below.
  const [depositRefusal, setDepositRefusal] = useState<WithdrawRefusal | null>(null)

  const refetchAll = () => {
    qc.invalidateQueries('payments')
    qc.invalidateQueries('balance-context')
    qc.invalidateQueries('charge-quote')
    qc.invalidateQueries('declared-deposits')
    qc.invalidateQueries('tenant-payment-methods')
    qc.invalidateQueries('remittances')
  }

  const leaseGroups = balanceCtx?.leases ?? []
  // Which bill a held card payment is on — named only when the page shows more than one.
  const awaitingWhere = (a: AwaitingCardConfirmation): string | null => {
    const bills = (balanceCtx?.leases?.length ?? 0) + (balanceCtx?.serviceAgreements?.length ?? 0)
    if (bills < 2) return null
    const l = a.leaseId ? balanceCtx?.leases?.find((x) => x.leaseId === a.leaseId) : null
    if (l) return `${l.propertyName} · Unit ${l.unitNumber}`
    const sa = a.serviceAgreementId ? balanceCtx?.serviceAgreements?.find((x) => x.serviceAgreementId === a.serviceAgreementId) : null
    return sa ? `${sa.propertyName} · Unit ${sa.unitNumber}` : null
  }

  // Rent is PAY-IN-FULL ONLY (Nic) — no partial payments anywhere in the system.
  // A partial payment can reset a landlord's eviction clock, so the tenant always
  // pays the entire outstanding balance; there is no editable amount.
  // S581: each LEASE is paid as its own charge (separate ACH/card + receipt), so
  // a tenant with two leases (overlap move, or two landlords) pays each on its
  // own — a shortfall or an eviction hold on one never blocks the other.
  // S655: the modal reads the live bill itself (the same cache) and asks the
  // credit question there; these figures only fill it while that loads.
  const openPayLease = (lg: LeaseBill) => {
    const owed = owedOf(lg)
    if (!(owed > 0)) return
    const { leaseId, suggestedPayAhead, requiredNow } = lg
    setPayTarget({
      target: {
        amount:    owed,
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
  // S655: what is owed is the bill plus the old balance, before any credit —
  // the full balance; the credit that could pay part of it is said beside it.
  const payable = leaseGroups.filter((l) => !l.paymentBlocked && owedOf(l) > 0)
  const payableTotal = roundCents(payable.reduce((s, l) => s + owedOf(l), 0))
  const payableCredit = creditOffer(payable).usable
  // "Pay all" with no credit question: exactly the charges the pay screen will
  // send (lib/payCredit planCharges). S622 claims every space's current bill
  // before any earlier balance, so with two of one landlord's leases both
  // carrying an earlier balance, all but one of those balances wait — the
  // button names what is charged, and the card says which balance waits. With
  // credit there is no one figure until the tenant answers Use / Save.
  const payAllLines = payable.length >= 2 && !(payableCredit > 0) ? planCharges(payable, null) : null
  const payAllCharge = payAllLines ? roundCents(payAllLines.reduce((s, x) => s + x.amount, 0)) : null
  const payAllHeldBack = (payAllLines ?? []).filter((x) => (x.carriedLeft ?? 0) > 0.005)

  // S655 review: where a refused "I hadn't paid" is answered. Inside the
  // balance card that lists the report, while that card is on screen;
  // otherwise as its own block. The refused report has usually just been
  // applied to the bill — often paying it off — and the card goes away with
  // the balance, so a list holding its own answer lost it on the reload.
  // (The cards list reports under "Ways to pay", which shows only with a priced
  // way to pay; one card for two or more leases, else one for the single one.)
  const priced = (l: { methodCosts?: unknown[] }) => (l.methodCosts ?? []).length > 0
  // Every figure a Pay button names is the server's (useServerCosts). Pay all
  // with no credit question: the charges the pay screen will send. One lease
  // with no credit question: the whole balance, the earlier balance included.
  // With credit the cards show the server's bill figures (the "Save it for
  // later" answer) as they come.
  const payAllCosts = useServerCosts(payAllLines && payable.every(priced)
    ? payAllLines.map((x) => ({ lease: payable.find((l) => l.leaseId === x.leaseId)!, amount: x.amount }))
    : null)
  const singleLease = payable.length === 1 && priced(payable[0]) && !((payable[0].usableCredit ?? 0) > 0) ? payable[0] : null
  const singleCosts = useServerCosts(singleLease ? [{ lease: singleLease, amount: owedOf(singleLease) }] : null)
  const reportsInCard: any[] =
    payable.length >= 2 ? (payable.every(priced) ? declaredDeposits : [])
    : payable.length === 1 && priced(payable[0])
      ? declaredDeposits.filter((d: any) => d.leaseId === payable[0].leaseId)
      : []
  const depositRefusalInCard =
    !!depositRefusal && reportsInCard.some((d: any) => d.id === depositRefusal.id)
  // 10/5 (Nic): a report the bank showed on a later day than the tenant gave
  // says so on their own report. Once the deposit paid the bill there may be
  // no balance card to hold it, so it stands on its own.
  // A report a refused "I hadn't paid" is showing on its own (below) is left
  // out here, so it never shows twice.
  const flaggedOutsideCard = declaredDeposits.filter((d: any) =>
    d.status === 'confirmed' && d.bankDateUsed && d.bankPostedDate && !reportsInCard.some((x: any) => x.id === d.id)
    && !(depositRefusal && !depositRefusalInCard && d.id === depositRefusal.id))
  const cardRefusal = depositRefusalInCard ? depositRefusal : null

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
        batch:     payable.map((l) => ({ leaseId: l.leaseId, amount: owedOf(l) })),
      },
    })
  }

  // S582: first-rent readiness. If the tenant OWES rent but their only payment
  // method is a bank still verifying (microdeposits ~1–3 biz days), reassure them
  // so the "log in and pay" moment never feels broken — card is instant if they
  // want to pay today, and we surface when rent is actually due so they know they
  // have time.
  // S655: a bank still verifying is at one of two steps — waiting on the
  // tenant to confirm the small deposit, or being checked (nothing to do). The
  // notice says which; telling a tenant whose bank is being checked to go
  // confirm a deposit contradicts the bank's own "Being checked" badge.
  const hasPendingBank = methods.some((m: any) => m.type === 'ach' && m.verified === false && m.verificationStep !== 'checking')
  const hasBankBeingChecked = methods.some((m: any) => m.type === 'ach' && m.verified === false && m.verificationStep === 'checking')
  // S655: a bank with bank payments paused cannot pay either (chargeable).
  const hasInstantMethod = methods.some((m: any) => m.type === 'card' || (m.type === 'ach' && (m.chargeable ?? m.verified !== false)))
  const showVerifyingNotice = payable.length > 0 && hasPendingBank && !hasInstantMethod
  const showCheckingNotice = payable.length > 0 && hasBankBeingChecked && !hasPendingBank && !hasInstantMethod
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

      {/* decisions.md #48.4: a card payment waiting on its card's bank holds
          the bill it pays, so that bill can show nothing owed and no Pay
          button. Shown here on its own, whatever else is owed: the payer gets
          "Confirm with your bank" and "Cancel it and pay another way"; the
          rest of the household is told whose card's bank it waits on. */}
      <AwaitingCardPayments
        items={balanceCtx?.awaitingCardConfirmations ?? []}
        where={awaitingWhere}
      />

      {showVerifyingNotice && (
        <div className="card" style={{ borderLeft: '3px solid var(--gold)', padding: '12px 16px', marginBottom: 12 }}>
          <div style={{ fontWeight: 700, color: 'var(--t0)', marginBottom: 2 }}>Your bank needs one more step from you</div>
          <div style={{ fontSize: '.82rem', color: 'var(--t2)', lineHeight: 1.5 }}>
            {/* S641 (Nic): this used to read "we'll email you the moment it's
                ready", which says we are the ones working on it. We are not —
                the bank is waiting on the tenant to confirm what we sent. One
                resident sat for eight days past the deposit landing, waiting for
                an email that was never coming while Stripe waited on him. */}
            We sent a small deposit to your bank. Once it lands — usually <strong>1–3 business days</strong> —
            confirm it in the box at the top of this page and you can pay by bank.
            {earliestDue ? <> Your rent is due <strong>{earliestDue}</strong>, so you have time.</> : null}
            {' '}Want to pay today? <button className="btn-link" style={{ padding: 0, font: 'inherit', color: 'var(--gold)', cursor: 'pointer', background: 'none', border: 'none' }} onClick={() => setAddMethodOpen('card')}>Add a card</button> — card payments are instant.
          </div>
        </div>
      )}

      {showCheckingNotice && (
        <div className="card" style={{ borderLeft: '3px solid var(--gold)', padding: '12px 16px', marginBottom: 12 }}>
          <div style={{ fontWeight: 700, color: 'var(--t0)', marginBottom: 2 }}>Your bank is being checked</div>
          <div style={{ fontSize: '.82rem', color: 'var(--t2)', lineHeight: 1.5 }}>
            We received what you entered and are checking it — there is nothing more to do. You can pay by bank
            as soon as the check finishes.
            {earliestDue ? <> Your rent is due <strong>{earliestDue}</strong>.</> : null}
            {' '}Want to pay today? <button className="btn-link" style={{ padding: 0, font: 'inherit', color: 'var(--gold)', cursor: 'pointer', background: 'none', border: 'none' }} onClick={() => setAddMethodOpen('card')}>Add a card</button> — card payments are instant.
          </div>
        </div>
      )}

      {/* S609 (Nic): "I want the tenant portal to still show how much
          outstanding credit they have. If it's ten thousand dollars in
          prepayments, it should show that they have ten thousand dollars in
          credit." Top of the page, not tucked into a history card. */}
      {(() => {
        const prepaid  = remitData?.prepaidRemaining ?? 0
        const interest = remitData?.depositInterestCredit ?? 0
        const other    = remitData?.otherCreditTotal ?? 0
        const total    = Math.round((prepaid + interest + other) * 100) / 100
        if (total <= 0) return null
        return (
        <div className="card" style={{ padding: 16, marginTop: 16, borderColor: 'var(--green)' }}>
          <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 4 }}>
            Account credit
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.4rem', color: 'var(--green)' }}>
            {formatCurrency(total)}
          </div>
          {/* S642: this card counted PAY-AHEAD money only, while the balance
              above it already netted off every credit. So statutory deposit
              interest would have quietly reduced what they owe with nothing
              here saying why — money appearing from nowhere, which reads as a
              mistake to the person least able to check it. Each kind is named,
              because "you paid ahead" and "your state owes you interest on your
              deposit" are different sentences. */}
          {prepaid > 0 && (
            <CreditKindRow label="Paid ahead" amount={prepaid}
              note="Anything still unused comes back to you when you move out." />
          )}
          {interest > 0 && (
            <CreditKindRow label="Statutory interest on your deposit" amount={interest}
              note="It’s yours — we credit it to your account each year rather than making you ask." />
          )}
          {other > 0 && (
            <CreditKindRow label="Credit from your landlord" amount={other} />
          )}
          {/* S655 (Nic, 10/2): credit is the tenant's to use or save. It pays a
              bill by itself only when it covers the whole bill; otherwise Pay
              asks "Use all" or "Save it for later". */}
          <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 8, lineHeight: 1.5 }}>
            Use it when you pay. It is applied by itself only when it covers a whole bill.
          </div>
        </div>)
      })()}

      <SavedMethodsCard methods={methods} loading={methodsLoading} />

      {/* S609: the tenant's autopay control. There is deliberately no landlord
          equivalent — the pull day is the tenant's alone (Nic). */}
      <AutopaySection />

      {/* S654 (Nic): ONE BUTTON. "They can't choose what they pay. They pay
          everything that's owed." With two or more payable leases the page used
          to offer a bare "Pay all" card above a Pay button per lease — three
          buttons, and a resident reading the second card as "a previous
          outstanding balance". Now there is one card in the same shape as a
          single lease's: the whole balance, what each space contributes, the
          fee for each way of paying it, and one Pay. Each lease is still charged
          separately underneath (one clearing never depends on another), which
          is why the fees are the sum of each lease's. */}
      {payable.length >= 2 && (() => {
        const r2 = (n: number) => Math.round(n * 100) / 100
        const combined = !payable.every(priced) ? { methodCosts: [] } : payAllLines ? {
          // Present so the card shows; the figures are payAllCosts.
          methodCosts: payable[0].methodCosts,
        } : {
          // With credit: the server's own figures for the bills (its
          // payIfSaved), the "Save it for later" answer.
          methodCosts: ['ach', 'card', 'manual'].map((m) => {
            const parts = payable.map((l) => (l.methodCosts ?? []).find((c: any) => c.method === m)).filter(Boolean) as any[]
            return parts.length
              ? { method: m, label: parts[0].label, fee: r2(parts.reduce((s, c) => s + Number(c.fee), 0)), total: r2(parts.reduce((s, c) => s + Number(c.total), 0)) }
              : null
          }).filter(Boolean),
        }
        const properties = [...new Set(payable.map((l) => l.propertyName))].join(' · ')
        return (
          <div className="card" style={{ padding: 16, marginTop: 16, borderColor: 'var(--gold)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 320px' }}>
                <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 4 }}>
                  Outstanding balance — {properties}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.4rem', color: 'var(--t0)' }}>
                  {formatCurrency(payableTotal)}
                </div>
                <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 4 }}>
                  {payAllHeldBack.length > 0
                    ? <>Every space&apos;s current bill, in one payment — oldest charges first.</>
                    : <>Everything you owe, in one payment — oldest charges first.</>}{' '}
                  Each space is charged separately, so one clearing doesn&apos;t depend on the others.
                </div>
                {payAllHeldBack.length > 0 && (
                  <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 }}>
                    The earlier balance on{' '}
                    {payAllHeldBack.map((x) => {
                      const l = payable.find((p) => p.leaseId === x.leaseId)
                      return `Unit ${l?.unitNumber ?? ''} (${formatCurrency(x.carriedLeft ?? 0)})`
                    }).join(', ')}{' '}
                    isn&apos;t in this payment — you can pay it down once this one goes through.
                  </div>
                )}
                <CreditBeside usable={payableCredit} />
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--bd)' }}>
                  <div style={{ fontSize: '.7rem', fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
                    What this covers
                  </div>
                  {payable.map((l) => (
                    <div key={l.leaseId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '3px 0', fontSize: '.78rem' }}>
                      <span style={{ color: 'var(--t2)' }}>Unit {l.unitNumber}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--t0)', whiteSpace: 'nowrap' }}>
                        {formatCurrency(payAllLines?.find((x) => x.leaseId === l.leaseId)?.amount ?? owedOf(l))}
                      </span>
                    </div>
                  ))}
                </div>
                <WaysToPay lease={combined} costs={payAllLines ? payAllCosts : undefined}
                  reports={declaredDeposits} onWithdrawn={refetchAll}
                  refusal={cardRefusal} onRefusal={setDepositRefusal} />
                {/* 10/6 (Nic): only where the landlord takes rent deposited at their bank. */}
                {payable.filter((l) => l.bankDepositsTaken === true).map((l) => (
                  <button key={l.leaseId} className="btn-ghost"
                    onClick={() => setReportDepositFor({ leaseId: l.leaseId, outstanding: owedOf(l) })}
                    style={{ width: '100%', marginTop: 8, fontSize: '.78rem', padding: '8px 12px' }}>
                    I paid at the bank for Unit {l.unitNumber} — report a deposit
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                <button className="btn btn-p" onClick={openPayAll}>
                  {payAllCharge != null ? `Pay ${formatCurrency(payAllCharge)}` : 'Pay your bill'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* S537 → S581: the payment surface — one Pay card PER LEASE (each lease
          is charged separately, in full). A single-lease tenant sees one card.
          S654: with two or more payable leases the one card above replaces
          these — no per-lease Pay button, nothing to choose between. */}
      {leaseGroups.map((lg) => (
        lg.paymentBlocked ? (
          <div key={lg.leaseId} className="card" style={{ padding: 14, marginTop: 16, fontSize: '.8rem', color: 'var(--t1)' }}>
            Payments for {lg.propertyName} · Unit {lg.unitNumber} are currently paused. Contact your landlord.
          </div>
        ) : payable.length >= 2 ? null : owedOf(lg) > 0 ? (
          <div key={lg.leaseId} className="card" style={{ padding: 16, marginTop: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 4 }}>
                  Outstanding balance{leaseGroups.length > 1 ? ` — ${lg.propertyName} · Unit ${lg.unitNumber}` : ''}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.4rem', color: 'var(--t0)' }}>
                  {formatCurrency(owedOf(lg))}
                </div>
                <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 4 }}>
                  Rent is paid in full — this covers your entire balance on this lease,
                  oldest charges first.
                </div>
                <CreditBeside usable={lg.usableCredit ?? 0} />
                {/* Priced at what the Pay button names. With no credit question
                    the button names the whole balance; the bill's own figures
                    leave out an earlier balance the button includes, so the
                    server is asked for that amount (useServerCosts). With
                    credit the button names no figure (the answer decides it),
                    and the ways to pay are the server's own — the bill, the
                    "Save it for later" answer — as on the Pay all card. */}
                <WaysToPay
                  lease={lg}
                  costs={singleLease?.leaseId === lg.leaseId ? singleCosts : undefined}
                  reports={declaredDeposits.filter((d: any) => d.leaseId === lg.leaseId)}
                  onReportDeposit={lg.bankDepositsTaken === true ? () => setReportDepositFor({
                    leaseId: lg.leaseId, outstanding: owedOf(lg) }) : undefined}
                  onWithdrawn={refetchAll}
                  refusal={cardRefusal}
                  onRefusal={setDepositRefusal}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                {/* With credit there is no one figure until the tenant answers
                    Use / Save on the pay screen (the same as Pay all): "Use all"
                    and "Save it for later" name the bill, never the earlier
                    balance this card's total includes. */}
                <button className="btn btn-p" onClick={() => openPayLease(lg)}>
                  {(lg.usableCredit ?? 0) > 0 ? 'Pay your bill' : `Pay ${formatCurrency(owedOf(lg))}`}
                </button>
              </div>
            </div>
          </div>
        ) : null
      ))}

      {flaggedOutsideCard.length > 0 && (
        <div className="card" style={{ padding: 16, marginTop: 16 }}>
          <ReportedDeposits standalone reports={flaggedOutsideCard} onWithdrawn={refetchAll} />
        </div>
      )}

      {/* S655 review: a refused "I hadn't paid" whose balance card has gone —
          the report was applied and paid the bill off. It stays on screen,
          saying where the report stands, until the tenant presses OK. */}
      {depositRefusal && !depositRefusalInCard && (
        <div className="card" style={{ padding: 16, marginTop: 16 }}>
          <ReportedDeposits
            standalone
            reports={declaredDeposits.filter((d: any) => d.id === depositRefusal.id)}
            onWithdrawn={refetchAll}
            refusal={depositRefusal}
            onRefusal={setDepositRefusal}
          />
        </div>
      )}

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
              {/* Every utility itemized, so the total is never a number they
                  have to phone up about. */}
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {b.rows.map((l: any) => (
                  <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '.78rem' }}>
                    <span style={{ color: 'var(--t2)' }}>
                      {/* decisions #17: the line names the utility — never "Utilities". */}
                      {utilityLine(l).label}
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
        <RemittancesCard remittances={remitData.remittances} prepaidRemaining={remitData.prepaidRemaining} prepaidMonthlyDraw={remitData.prepaidMonthlyDraw ?? null}
          waitingOnBank={new Set((balanceCtx?.awaitingCardConfirmations ?? []).map((a) => a.remittanceId).filter((x): x is string => !!x))} />
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
                <th>Charge</th>
                <th>Paid by</th>
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
                          {statusLabel(p.status)}
                        </span>
                      </td>
                      <td style={{ fontSize: '.75rem', color: 'var(--t3)' }}>
                        {/* decisions #17: a utility line names its utility. */}
                        {p.type === 'utility' ? utilityLine(p).label : chargeLabel(p.entryDescription, p.notes)}
                      </td>
                      <td style={{ fontSize: '.75rem', color: 'var(--t2)', whiteSpace: 'nowrap' }}>
                        {(p.status === 'settled' || p.status === 'processing') ? (paidByLabel(p.paidBy, p.paymentChannel) ?? '—') : '—'}
                      </td>

                    </tr>
                  )
                })
              ) : (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--t3)', padding: 32 }}>
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
function RemittancesCard({ remittances, prepaidRemaining, prepaidMonthlyDraw, waitingOnBank }: {
  remittances: Remittance[]
  prepaidRemaining: number
  prepaidMonthlyDraw?: number | null
  /** Receipts of card payments still waiting on their card's bank (balance-context). */
  waitingOnBank: ReadonlySet<string>
}) {
  const [openId, setOpenId] = useState<string | null>(null)

  // ACH and card in the list's own short words; a payment recorded by the
  // office (cash, check, money order, 10/5 bank deposit) in the shared ones.
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
              {/* S655 (Nic, 10/2): credit is used when the tenant chooses to,
                  or by itself only when it covers a whole bill. */}
              {prepaidMonthlyDraw
                ? `Paid-ahead credit — up to ${formatCurrency(prepaidMonthlyDraw)} of it can go on each month's bill`
                : 'Paid-ahead credit — use it when you pay; it is applied by itself only when it covers a whole bill'}
            </div>
          </div>
        )}
      </div>

      {remittances.map((r) => {
        const open = openId === r.id
        const cardState = cardHistoryState(r, waitingOnBank)
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
                  <span className="badge b-muted">{METHOD_LABEL[r.paymentMethod] ?? paidByLabel(r.paymentMethod, null) ?? humanize(r.paymentMethod)}</span>
                )}
                {cardState
                  ? <span className="badge b-muted">{CARD_HISTORY_STATE_LABEL[cardState]}</span>
                  : <span className={`badge ${STATUS_BADGE[r.status] || 'b-muted'}`}>{statusLabel(r.status)}</span>}
                {(r.creditUsed ?? 0) > 0 && (
                  <span style={{ fontSize: '.72rem', color: 'var(--t3)' }}>
                    + {formatCurrency(r.creditUsed ?? 0)} account credit
                  </span>
                )}
              </div>
              <span style={{ fontSize: '.7rem', color: 'var(--t3)' }}>{open ? '▲' : '▼'}</span>
            </button>

            {open && (
              <div style={{ padding: '0 12px 12px' }}>
                {cardState === 'canceled_nothing_charged' ? (
                  <div style={{ fontSize: '.76rem', color: 'var(--t1)', padding: 10, background: 'var(--bg-2)', borderRadius: 6 }}>
                    This card payment was canceled before anything was charged, and the charges below went back on your bill.
                  </div>
                ) : cardState === 'declined_nothing_charged' ? (
                  <div style={{ fontSize: '.76rem', color: 'var(--t1)', padding: 10, background: 'var(--bg-2)', borderRadius: 6 }}>
                    Your card&rsquo;s bank declined this payment before anything was charged, and the charges below went back on your bill.
                  </div>
                ) : cardState === 'waiting_on_bank' ? (
                  <div style={{ fontSize: '.76rem', color: 'var(--t1)', padding: 10, background: 'var(--bg-2)', borderRadius: 6 }}>
                    Your card&rsquo;s bank hasn&rsquo;t confirmed this payment yet — nothing has been charged. Confirm it or cancel it at the top of this page.
                  </div>
                ) : r.status === 'failed' ? (
                  <div style={{ fontSize: '.76rem', color: 'var(--t1)', padding: 10, background: 'var(--bg-2)', borderRadius: 6 }}>
                    This payment didn&rsquo;t go through — nothing was applied. The charges below returned to your outstanding balance.
                  </div>
                ) : null}
                <table className="tbl" style={{ width: '100%', fontSize: '.78rem', marginTop: (r.status === 'failed' || cardState) ? 8 : 0 }}>
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
                          {/* decisions #17: a utility line names its utility — Water, Trash… */}
                          <span className="badge b-muted" style={{ marginRight: 6 }}>
                            {ln.type === 'utility' ? utilityLine(ln).label : humanize(ln.type)}
                          </span>
                          {ln.type !== 'utility' && ln.entryDescription && norm(ln.entryDescription) !== norm(ln.type) && (
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
                    {/* The server counts credit a payment holds or has used;
                        a failed payment's credit is given back and not counted
                        here, so a failed one has no credit line. */}
                    {(r.creditUsed ?? 0) > 0 && r.status !== 'failed' && (
                      <tr>
                        <td colSpan={2} style={{ fontSize: '.74rem', color: 'var(--t2)' }}>
                          Account credit {r.status === 'settled' ? 'used' : 'set aside while this payment clears'}
                        </td>
                        <td className="mono" style={{ textAlign: 'right', color: 'var(--t1)', fontWeight: 600 }}>
                          {formatCurrency(r.creditUsed ?? 0)}
                        </td>
                      </tr>
                    )}
                    {/* Paid-ahead money is credit only on a payment that went
                        through (or is still clearing). A failed payment's
                        surplus never became credit — the row would promise
                        money the tenant does not have. */}
                    {r.unappliedAmount > 0 && (r.status === 'settled' || r.status === 'processing') && (
                      <tr>
                        <td colSpan={2} style={{ fontSize: '.74rem', color: 'var(--green)' }}>
                          Paid ahead — {r.status === 'settled'
                            ? 'kept as credit on your account'
                            : 'kept as credit on your account once this payment settles'}
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
