import { useQuery } from 'react-query'
import { declaredDateFlagText, type OpenMonthRow, type RentRollPayment } from '@gam/shared'
import { apiGet } from '../../lib/api'
import {
  money, toCents, dayWord, returnDetail, chargeMonthsRange, readChargesById, CHARGE_PAGE_SIZE,
  ZERO_TOLERANCE_TEXT, CREDIT_TAKEN_BACK_TEXT, type LedgerPayment, type ReturnFacts,
} from '../../lib/creditDesk'
import { BankReceiptPhoto } from '../BankReceiptPhoto'
import { paidWords } from './openMonth'

// ── A ROW OPENED ON THE PAYMENTS PAGE ───────────────────────────────────────
//
// 10/13 (Nic), answered: "clicking the ROW opens underneath: each payment
// (date, amount, method) and every charge on the bill with what it's for
// (rent, water, late fee…)". The server sends both on the row
// (OpenMonthRow.payments / .charges).
//
// What the Payments ledger showed on a payment is kept here, read from the same
// ledger (GET /balances/payments-by-month — the row's payments carry its ids):
// 10/5 (Nic) the photo of the bank's deposit receipt (seen, or added when it was
// not sent with the payment) and the flag when the tenant dated a deposit
// earlier than the bank ("Said they deposited Oct 1 — the bank shows Oct 6.");
// S655 why a payment came back (the bank's reason with its code, and the
// zero-tolerance mark), read from the charges (GET /payments) only when a
// payment on the row came back.

interface LedgerLine { paymentId: string; dueDate: string; returned: number; creditReturned: number }
type LedgerRow = LedgerPayment & { lines: LedgerLine[] }

const PAYMENT_BADGE: Record<RentRollPayment['status'], string> = {
  settled: 'badge-green',
  clearing: 'badge-blue',
  returned: 'badge-red',
}

export function OpenMonthDetail({ row, month, canAddPhoto }: {
  row: OpenMonthRow
  /** 'YYYY-MM': the open month (the ledger month its payments are filed under). */
  month: string
  /** May add a missing bank-receipt photo (Take payments). */
  canAddPhoto: boolean
}) {
  const year = month.slice(0, 4)
  // The ledger month, read once while any row with a payment is open; the desk
  // window's own refresh ('payments-ledger') reads it again after a payment.
  const { data: ledger, refetch: refetchLedger } = useQuery<{ payments: LedgerRow[] }>(
    ['payments-ledger', 'month', month],
    () => apiGet(`/balances/payments-by-month?month=${month}`),
    { enabled: row.payments.length > 0, staleTime: 30_000, retry: false })
  const ledgerById = new Map((ledger?.payments ?? []).map(p => [p.id, p]))
  const facts = (p: RentRollPayment) => ledgerById.get(p.paymentId)

  // Why a payment came back: only when one on this row did.
  const cameBack = row.payments.some(p => {
    const f = facts(p)
    return p.status === 'returned' || toCents(f?.returned) > 0
  })
  const range = chargeMonthsRange(row.charges.map(c => c.dueDate))
  const wanted = [...new Set(row.charges.map(c => c.chargeId))].sort()
  const { data: returnRead } = useQuery<{ rows: Array<ReturnFacts & { id: string }>; complete: boolean }>(
    ['payments-returns', range?.from ?? '', range?.to ?? '', wanted.join(',')],
    () => readChargesById<ReturnFacts & { id: string }>(
      page => apiGet(`/payments?from=${range!.from}&to=${range!.to}&limit=${CHARGE_PAGE_SIZE}&page=${page}`),
      new Set(wanted)),
    { enabled: cameBack && !!range && wanted.length > 0, staleTime: 60_000, retry: false })
  const returnsById = new Map<string, NonNullable<ReturnType<typeof returnDetail>>>()
  for (const r of returnRead?.rows ?? []) {
    const d = returnDetail(r)
    if (d && r.id) returnsById.set(r.id, d)
  }
  /** The reasons on the charges this payment paid (all the row's, when the ledger has no lines for it). */
  const reasonsFor = (p: RentRollPayment) => {
    const ids = facts(p)?.lines.map(l => l.paymentId) ?? row.charges.map(c => c.chargeId)
    const seen = new Map<string, NonNullable<ReturnType<typeof returnDetail>>>()
    for (const id of ids) {
      const d = returnsById.get(id)
      if (d && !seen.has(d.text)) seen.set(d.text, d)
    }
    return [...seen.values()]
  }

  return (
    <div className="pay-detail-body">
      <div className="pay-detail-block">
        <div className="cd-section-label">Payments</div>
        {row.payments.length === 0 ? (
          <div className="pay-none">No payment on this month’s bills yet.</div>
        ) : (
          <table className="pay-lines">
            <thead><tr><th>Date</th><th className="num">Amount</th><th>Method</th><th></th></tr></thead>
            <tbody>
              {row.payments.map(p => {
                const f = facts(p)
                const returned = p.status === 'returned' || toCents(f?.returned) > 0
                const why = returned ? reasonsFor(p) : []
                return (
                  <tr key={p.paymentId} data-line="payment">
                    <td className="day">{dayWord(p.paidOn, year)}</td>
                    <td className="num">
                      {money(p.amount)}
                      {toCents(p.credit) > 0 && toCents(p.credit) < toCents(p.amount) && (
                        <span className="pay-sub">{money(p.credit)} from credit</span>
                      )}
                      {toCents(f?.returned) > 0 && <span className="pay-sub cd-timing-late">{money(f!.returned)} taken back</span>}
                      {toCents(f?.creditReturned) > 0 && <span className="pay-sub cd-timing-late">{money(f!.creditReturned)} credit taken back</span>}
                    </td>
                    <td>
                      {p.methodLabel}
                      {p.reference && <span className="pay-sub">#{p.reference}</span>}
                      {f?.method === 'bank_deposit' && (
                        <BankReceiptPhoto receiptId={f.receiptId} url={f.depositPhotoUrl}
                          canAdd={canAddPhoto} onAdded={() => { void refetchLedger() }} />
                      )}
                      {f?.tenantReceiptPhotoUrl && (
                        <BankReceiptPhoto receiptId={f.receiptId} url={f.tenantReceiptPhotoUrl}
                          canAdd={false} onAdded={() => {}} label="Tenant's photo of the bank receipt" />
                      )}
                      {f?.depositDateFlag && (
                        <div className="cd-ledger-sub cd-timing-late" role="note">
                          {declaredDateFlagText(f.depositDateFlag.said, f.depositDateFlag.bank)}
                        </div>
                      )}
                    </td>
                    <td>
                      {p.status !== 'settled' && <span className={`badge ${PAYMENT_BADGE[p.status] ?? 'badge-muted'}`}>{p.statusLabel}</span>}
                      {why.map(d => <div key={d.text} className="cd-ledger-sub cd-return">{d.text}</div>)}
                      {why.some(d => d.zeroTolerance) && <div className="cd-ledger-sub cd-return cd-strong-sub">{ZERO_TOLERANCE_TEXT}</div>}
                      {/* The bill's own charges were not disputed: the payment that put the
                          credit on their account was (fix pass 2). */}
                      {toCents(f?.creditReturned) > 0 && <div className="cd-ledger-sub cd-return">{CREDIT_TAKEN_BACK_TEXT}</div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {returnRead?.complete === false && (
          <div className="cd-note">
            A returned payment here may show no reason — the month has too many charges to read them all here. GAM
            support can tell you why it came back.
          </div>
        )}
      </div>

      <div className="pay-detail-block">
        <div className="cd-section-label">What it’s for</div>
        {row.charges.length === 0 ? (
          <div className="pay-none">Nothing billed this month yet.</div>
        ) : (
          <table className="pay-lines">
            <thead>
              <tr><th>For</th><th>Due</th><th className="num">Invoiced</th><th className="num">Paid</th><th className="num">Owed</th></tr>
            </thead>
            <tbody>
              {row.charges.map(c => {
                const paid = paidWords(c)
                const why = returnsById.get(c.chargeId)
                return (
                  <tr key={c.chargeId} data-line="charge">
                    <td>
                      {c.label}{c.detail ? <span className="pay-muted"> · {c.detail}</span> : null}
                      {/* 10/6 (Nic): a payment logged by hand after the late fee posted
                          counts late from the day it was logged. */}
                      {c.loggedAfterLateFee && (
                        <span className="pay-sub">Logged after the late fee posted — late from the day it was logged</span>
                      )}
                      {why && <span className="pay-sub cd-return">{why.text}</span>}
                    </td>
                    <td className="day">{dayWord(c.dueDate, year)}</td>
                    <td className="num">{money(c.invoiced)}</td>
                    <td className="num">
                      {paid.amount ?? <span className="pay-muted">—</span>}
                      {paid.workTrade && <span className="pay-sub">{paid.workTrade}</span>}
                    </td>
                    <td className="num">{toCents(c.owed) > 0 ? <span className="pay-owed">{money(c.owed)}</span> : <span className="pay-muted">—</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
