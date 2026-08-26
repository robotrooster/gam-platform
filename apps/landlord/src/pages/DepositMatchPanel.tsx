// S624 — matching a bank deposit to the rent it paid.
//
// Before this, a landlord running a property remotely had to reconstruct every
// cash payment by hand: find the deposit in their statement, work out which
// tenant it was, waive the late fee it accrued while in transit, credit that
// back, mark the charges paid — and unwind all of it if a check bounced.
//
// WHY THIS SCREEN SUGGESTS AND DOES NOT DECIDE. In a park where every lot pays
// the same rent, an amount identifies nobody, and a confident wrong answer books
// one tenant's money onto another's ledger and then onto their credit file. So
// every row here is a SHORTLIST with its reasoning shown, and the landlord picks
// — except where a tenant reported the deposit themselves and the bank confirms
// it, which settles before this screen ever sees it.
//
// The "Not a rent payment" button matters more than it looks: without it, a
// landlord staring at a list of tenants who did NOT pay this deposit has no
// honest way out except to pick one.

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import {
  formatCurrency, MANUAL_PAYMENT_METHODS, MANUAL_PAYMENT_METHOD_LABELS,
  type ManualPaymentMethod,
} from '@gam/shared'

/** Plain sentence per confidence — never the raw enum. */
const CONFIDENCE_LABEL: Record<string, string> = {
  declared:         'Tenant reported this deposit',
  named_exact:      'Named on the deposit',
  named_partial:    'Named, but the amount differs',
  amount_unique:    'Only match for this amount',
  amount_ambiguous: 'Several tenants could match',
  carried_paydown:  'Could be a carried-balance payment',
}

export function DepositMatchPanel() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<any>('unmatched-deposits',
    () => apiGet('/bank-feed/deposits/unmatched'))
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [method, setMethod] = useState<Record<string, ManualPaymentMethod>>({})
  const [error, setError] = useState<string | null>(null)

  const confirm = useMutation(
    (v: { id: string; chargeIds: string[]; method: ManualPaymentMethod; declarationId?: string }) =>
      apiPost(`/bank-feed/deposits/${v.id}/confirm`, {
        chargeIds: v.chargeIds, method: v.method, declarationId: v.declarationId ?? null,
      }),
    {
      onSuccess: () => {
        setError(null)
        qc.invalidateQueries('unmatched-deposits')
        qc.invalidateQueries('bank-txns')
        qc.invalidateQueries('cash-position')
      },
      onError: (e: any) => setError(e?.message || 'That could not be recorded.'),
    })

  const notRent = useMutation((id: string) => apiPost(`/bank-feed/deposits/${id}/not-rent`, {}), {
    onSuccess: () => qc.invalidateQueries('unmatched-deposits'),
  })

  if (isLoading) return <div className="card" style={{ padding: 14 }}>Loading deposits…</div>
  const deposits: any[] = data?.deposits ?? []
  const withCandidates = deposits.filter(d => d.candidates?.length > 0)

  if (withCandidates.length === 0) {
    return (
      <div className="card" style={{ padding: 14, fontSize: '.82rem', color: 'var(--t2)' }}>
        No deposits are waiting to be matched to rent.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && (
        <div className="card" style={{ padding: 10, fontSize: '.8rem', color: 'var(--danger, #d66)' }}>
          {error}
        </div>
      )}
      {data?.remaining > 0 && (
        // Never let a cap read as "that's everything".
        <div style={{ fontSize: '.75rem', color: 'var(--t3)' }}>
          Showing the most recent {deposits.length}. {data.remaining} older deposits are not listed.
        </div>
      )}

      {withCandidates.map((d) => {
        const pick = chosen[d.transactionId] ?? d.candidates[0]?.leaseId
        const cand = d.candidates.find((c: any) => c.leaseId === pick) ?? d.candidates[0]
        const m = method[d.transactionId] ?? 'cash'
        return (
          <div key={d.transactionId} className="card" style={{ padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1rem' }}>
                  {formatCurrency(Number(d.amount))}
                </div>
                <div style={{ fontSize: '.74rem', color: 'var(--t3)' }}>
                  Posted {d.postedDate}{d.description ? ` · ${d.description}` : ''}
                </div>
              </div>
              <button className="btn-ghost" style={{ fontSize: '.74rem', padding: '5px 10px' }}
                onClick={() => notRent.mutate(d.transactionId)}>
                Not a rent payment
              </button>
            </div>

            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {d.candidates.map((c: any) => (
                <label key={c.leaseId} style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer',
                  padding: '7px 9px', borderRadius: 8,
                  border: `1px solid ${c.leaseId === pick ? 'var(--gold, #c9a227)' : 'var(--b1)'}`,
                  background: c.leaseId === pick ? 'var(--bg3)' : 'transparent',
                }}>
                  <input type="radio" name={`cand-${d.transactionId}`}
                    checked={c.leaseId === pick} style={{ marginTop: 3 }}
                    onChange={() => setChosen({ ...chosen, [d.transactionId]: c.leaseId })} />
                  <span style={{ fontSize: '.8rem', lineHeight: 1.5 }}>
                    <strong>{c.tenantName}</strong>
                    <span style={{ color: 'var(--t3)' }}> · {c.unitNumber} · {formatCurrency(Number(c.total))}</span>
                    <div style={{ color: 'var(--t3)', fontSize: '.72rem', marginTop: 2 }}>
                      {CONFIDENCE_LABEL[c.confidence] ?? c.confidence} — {c.reason}
                    </div>
                  </span>
                </label>
              ))}
            </div>

            <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '.74rem', color: 'var(--t3)' }}>Paid by</span>
              {MANUAL_PAYMENT_METHODS.map((opt) => (
                <button key={opt} type="button"
                  className={m === opt ? 'btn-primary' : 'btn-ghost'}
                  style={{ fontSize: '.74rem', padding: '5px 10px' }}
                  onClick={() => setMethod({ ...method, [d.transactionId]: opt })}>
                  {MANUAL_PAYMENT_METHOD_LABELS[opt]}
                </button>
              ))}
            </div>

            <button className="btn-primary" style={{ width: '100%', marginTop: 12 }}
              disabled={!cand || cand.chargeIds.length === 0 || confirm.isLoading}
              onClick={() => confirm.mutate({
                id: d.transactionId, chargeIds: cand.chargeIds, method: m,
              })}>
              {confirm.isLoading ? 'Recording…' : `Record as paid by ${cand?.tenantName ?? 'tenant'}`}
            </button>
            {cand && cand.chargeIds.length === 0 && (
              <div style={{ fontSize: '.72rem', color: 'var(--t3)', marginTop: 6 }}>
                This tenant has nothing open that adds up to {formatCurrency(Number(d.amount))} —
                record it against their charges from the payments screen instead.
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * S624 — did the office bank what it collected?
 *
 * Nic's on-site "double verification". This is not a reconciliation convenience;
 * it is a control. Staff take cash and mark each tenant paid, the deposit posts
 * days later, and until now nothing checked the two against each other.
 */
export function CashPositionPanel() {
  const { data, isLoading } = useQuery<any>('cash-position',
    () => apiGet('/bank-feed/cash-position'))
  if (isLoading) return null
  const unbanked: any[] = data?.unbanked ?? []

  if (unbanked.length === 0) {
    return (
      <div className="card" style={{ padding: 14, fontSize: '.82rem', color: 'var(--t2)' }}>
        Every payment collected in person has been accounted for by a bank deposit.
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontWeight: 700, fontSize: '.88rem' }}>
        Collected in person, not yet in the bank
      </div>
      <div style={{ fontSize: '.76rem', color: 'var(--t2)', marginTop: 4, lineHeight: 1.5 }}>
        {formatCurrency(data.unbankedTotal)} across {unbanked.length}{' '}
        {unbanked.length === 1 ? 'payment' : 'payments'}, the oldest {data.oldestDays} days ago.
        {/* Deliberately not an accusation. Cash sits in a drawer over a weekend. */}
        {' '}This is a prompt to check, not a discrepancy on its own.
      </div>
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {unbanked.map((u) => (
          <div key={u.paymentId} style={{
            display: 'flex', justifyContent: 'space-between', gap: 12,
            fontSize: '.78rem', padding: '3px 0',
          }}>
            <span style={{ color: 'var(--t2)' }}>
              {u.tenantName} <span style={{ color: 'var(--t3)' }}>· {u.unitNumber} · {u.method.replace('_', ' ')}</span>
            </span>
            <span style={{ whiteSpace: 'nowrap' }}>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{formatCurrency(u.amount)}</span>
              <span style={{ color: 'var(--t3)', fontSize: '.72rem' }}> · {u.daysOutstanding}d</span>
            </span>
          </div>
        ))}
      </div>
      {data.unattributedDeposits > 0 && (
        <div style={{ fontSize: '.74rem', color: 'var(--t3)', marginTop: 10, lineHeight: 1.5 }}>
          There {data.unattributedDeposits === 1 ? 'is' : 'are'} also {data.unattributedDeposits}{' '}
          {data.unattributedDeposits === 1 ? 'deposit' : 'deposits'} totalling{' '}
          {formatCurrency(data.unattributedTotal)} that nothing has been matched to yet.
        </div>
      )}
    </div>
  )
}
