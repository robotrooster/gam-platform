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
// honest way out except to pick one. It takes the deposit off this list for
// good (and out of GAM's steps that settle rent by themselves); the deposit
// then waits on the Bank feed tab under Needs review, where the owner files or
// ignores it. The screen says where it went, links straight to that list, and
// offers Undo (gray: it is the back-out) and a × to put the note away. The
// notes come from the server (each set-aside deposit still waiting there), so
// Undo is still offered after a reload, a company switch, leaving the page, or
// a deposit the landlord assistant set aside; the × hides a note for this
// browser session only.
//
// NOTHING IS PICKED FOR THEM unless the server says it may be (candidate
// .preselect — an exact set it is sure of). An amount-only match on a
// TRANSFER memo is never picked (decisions #48.1, #52): that is most often
// the owner's own money moving between accounts, so "Record as paid" stays
// off until they choose a tenant themselves.

import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPost } from '../lib/api'
import { FRESH_LIST, actionFailedSentence, loadFailedSentence } from './deskErrors'
import { useCompanyMissing, useEntities } from '../components/EntityPicker'
import { MakeDepositPanel } from './MakeDepositPanel'
import '../styles/bank-reconciliation.css'
import { BankReceiptPhoto } from '../components/BankReceiptPhoto'
import {
  formatCurrency, DEPOSITABLE_PAYMENT_METHODS, MANUAL_PAYMENT_METHOD_LABELS, declaredDateFlagText,
  type ManualPaymentMethod, type DepositablePaymentMethod,
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

/** A failure that may pass if tried again: no answer, a server fault, a timeout or "too many requests". */
const mayPass = (e: any): boolean => {
  const st: number | undefined = e?.response?.status
  return st === undefined || st >= 500 || st === 408 || st === 429
}

/**
 * Set-aside notes put away with the × this session (sessionStorage; a private
 * window or blocked storage just shows them again — never an error).
 */
const HIDDEN_ASIDE_KEY = 'gam.depositMatch.hiddenSetAside'
function readHiddenAside(): string[] {
  try {
    const v = JSON.parse(window.sessionStorage.getItem(HIDDEN_ASIDE_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === 'string') : []
  } catch { return [] }
}
function writeHiddenAside(ids: string[]): void {
  try { window.sessionStorage.setItem(HIDDEN_ASIDE_KEY, JSON.stringify(ids)) } catch { /* not kept: shown again next time */ }
}

/** What a deposit is called when its card is no longer on the list. */
const depositName = (d: { amount: number; postedDate: string }) =>
  `The ${formatCurrency(Number(d.amount))} deposit posted ${d.postedDate}`

/**
 * The Bank page's feed tab, filtered to Needs review (BankPage reads ?tab=,
 * BankFeedPage reads ?view=, both through useUrlTab when the page loads — so
 * this is a page load, not an in-app hop that the open page would not see).
 * It carries the company picked here (?entityId=), so an owner of several
 * companies lands on THIS company's feed once the Bank feed reads it on load.
 */
export const NEEDS_REVIEW_HREF = (entityId = '') =>
  `${window.location.pathname}?tab=feed&view=needs_review${entityId ? `&entityId=${encodeURIComponent(entityId)}` : ''}`

export function DepositMatchPanel({ entityId = '' }: { entityId?: string }) {
  const entityQS = entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''
  const qc = useQueryClient()
  // S654: an owner of several companies starts with none picked. Nothing is
  // asked until one is, and the panel says so (never "nothing waiting").
  // The company list is read first, so the panel never asks with no company
  // and flashes the server's "choose a company" refusal.
  const companiesLoading = useEntities().isLoading
  const companyMissing = useCompanyMissing(entityId)
  const { data, isLoading, isError, error: loadError } = useQuery<any>(['unmatched-deposits', entityId],
    () => apiGet('/bank-feed/deposits/unmatched' + entityQS),
    { ...FRESH_LIST, enabled: !companyMissing && !companiesLoading })
  const [chosen, setChosen] = useState<Record<string, string>>({})
  // 10/5: what went into the bank — cash, a check or a money order.
  const [method, setMethod] = useState<Record<string, DepositablePaymentMethod>>({})
  // Why an action on one deposit failed, keyed by that deposit: said on its
  // card, or — when the list read again no longer holds it (matched or filed
  // meanwhile) — once above the list, naming the deposit.
  const [errors, setErrors] = useState<Record<string, { sentence: string; name: string }>>({})
  // Set-aside notes put away with the × (this browser session only).
  const [hiddenAside, setHiddenAside] = useState<string[]>(readHiddenAside)
  const hideAside = (id: string) => setHiddenAside(xs => {
    const next = [...xs.filter(x => x !== id), id]
    writeHiddenAside(next)
    return next
  })
  const clearError = (id: string) => setErrors(m => { const n = { ...m }; delete n[id]; return n })
  // Another company chosen: what was said about this one's deposits goes with it.
  useEffect(() => { setErrors({}); setChosen({}) }, [entityId])

  // A refusal for good (4xx: another person matched it, a charge was paid
  // another way) means the list on screen is stale: it is read again in place
  // and the reason said once. A failure that may pass says to try again.
  const failed = (fallback: string) => (e: any, v: { id: string; name: string }) => {
    const st: number | undefined = e?.response?.status
    // The rate limit answers with no sentence of its own, and no answer at
    // all carries only the browser's words: plain ones instead.
    const said = st === 429 ? 'GAM was too busy to do that just now.'
      : st === undefined ? 'GAM did not answer, so it may not have been done.'
      : actionFailedSentence(e, fallback, 'The bank page', 'Bank')
    setErrors(m => ({ ...m, [v.id]: {
      name: v.name,
      sentence: mayPass(e)
        ? `${said} Try again; if it keeps happening, tell GAM support.`
        : `${said} The list has been read again.`,
    } }))
    qc.invalidateQueries('unmatched-deposits')
  }

  const confirm = useMutation(
    (v: { id: string; name: string; chargeIds: string[]; method: DepositablePaymentMethod; declarationId?: string }) =>
      apiPost(`/bank-feed/deposits/${v.id}/confirm`, {
        chargeIds: v.chargeIds, method: v.method, declarationId: v.declarationId ?? null,
      }),
    {
      onMutate: (v) => clearError(v.id),
      onSuccess: () => {
        qc.invalidateQueries('unmatched-deposits')
        qc.invalidateQueries('bank-txns')
        qc.invalidateQueries('cash-position')
        qc.invalidateQueries('deposit-slips')
      },
      onError: failed('That deposit could not be recorded.'),
    })

  const notRent = useMutation(
    (v: { id: string; name: string }) => apiPost(`/bank-feed/deposits/${v.id}/not-rent`, {}),
    {
      onMutate: (v) => clearError(v.id),
      onSuccess: (_d, v) => {
        // Its note comes back with the list read again (a × earlier this
        // session does not hide a deposit set aside again).
        setHiddenAside(xs => { const next = xs.filter(x => x !== v.id); writeHiddenAside(next); return next })
        qc.invalidateQueries('unmatched-deposits')
        qc.invalidateQueries('bank-txns')
      },
      onError: failed('That deposit could not be set aside.'),
    })

  const undoNotRent = useMutation(
    (v: { id: string; name: string }) => apiPost(`/bank-feed/deposits/${v.id}/not-rent/undo`, {}),
    {
      onMutate: (v) => clearError(v.id),
      onSuccess: () => {
        qc.invalidateQueries('unmatched-deposits')
        qc.invalidateQueries('bank-txns')
      },
      // Matched, filed or ignored on the Bank feed meanwhile: the list read
      // again no longer holds its note, so the reason is said once above the
      // list by name. A failure that may pass keeps the note and its Undo, and
      // the reason is said on the note. (Another tab's Undo first is not an
      // error: the server answers 200 alreadyBack.)
      onError: failed('That deposit could not be put back on this list.'),
    })

  if (companyMissing) {
    return (
      <div className="card" style={{ padding: 14, fontSize: '.82rem', color: 'var(--text-2)' }}>
        Choose a company above to see its deposits.
      </div>
    )
  }
  if (companiesLoading || isLoading) return <div className="card" style={{ padding: 14 }}>Loading deposits…</div>
  if (isError) {
    return (
      <div className="card bankrec-error" role="alert" style={{ padding: 14, fontSize: '.82rem' }}>
        {loadFailedSentence(loadError, 'The deposits waiting to be matched', 'Bank', { lead: true })}
      </div>
    )
  }
  const deposits: any[] = data?.deposits ?? []
  const withCandidates = deposits.filter(d => d.candidates?.length > 0)
  // Set aside as "Not a rent payment" and still waiting on the Bank feed, as
  // the server says — less any the × put away this session.
  const setAside = ((data?.setAside ?? []) as any[])
    .filter(x => !hiddenAside.includes(x.transactionId))
    .map(x => ({ id: String(x.transactionId), name: depositName(x) }))
  const onList = new Set([...withCandidates.map(d => d.transactionId), ...setAside.map(x => x.id)])
  // Errors whose deposit has left the list: said once here, by name.
  const orphanErrors = Object.entries(errors).filter(([id]) => !onList.has(id))

  const top = (
    <>
      {setAside.map(x => {
        const undoingThis = undoNotRent.isLoading && undoNotRent.variables?.id === x.id
        return (
          <div key={`aside-${x.id}`} className="card" style={{ padding: 12, fontSize: '.8rem', lineHeight: 1.5 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <span>
                {x.name} is set aside as not a rent payment: it is no longer offered against tenants, and GAM will not
                record it as a tenant's payment. It waits on the{' '}
                <a href={NEEDS_REVIEW_HREF(entityId)} style={{ color: 'var(--gold)' }}>Bank feed tab under Needs review</a>,
                where you file it or ignore it.
              </span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button type="button" className="btn btn-ghost btn-sm"
                  disabled={undoingThis}
                  onClick={() => undoNotRent.mutate(x)}>
                  {undoingThis ? 'Putting it back…' : 'Undo'}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" aria-label={`Put away the note about ${x.name}`}
                  disabled={undoingThis}
                  onClick={() => hideAside(x.id)}>
                  ×
                </button>
              </span>
            </div>
            {errors[x.id] && (
              <div role="alert" style={{ marginTop: 8, color: 'var(--red)' }}>
                {errors[x.id].sentence}
              </div>
            )}
          </div>
        )
      })}
      {data?.setAsideRemaining > 0 && (
        <div style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>
          {data.setAsideRemaining} more set aside earlier {data.setAsideRemaining === 1 ? 'waits' : 'wait'} on the{' '}
          <a href={NEEDS_REVIEW_HREF(entityId)} style={{ color: 'var(--gold)' }}>Bank feed tab under Needs review</a>.
        </div>
      )}
      {orphanErrors.map(([id, e]) => (
        <div key={`err-${id}`} className="card" role="alert"
          style={{ padding: 10, fontSize: '.8rem', color: 'var(--red)',
            display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{e.name}: {e.sentence}</span>
          <button type="button" className="btn btn-ghost btn-sm" aria-label={`Put away the message about ${e.name}`}
            onClick={() => clearError(id)}>
            ×
          </button>
        </div>
      ))}
    </>
  )

  if (withCandidates.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {top}
        <div className="card" style={{ padding: 14, fontSize: '.82rem', color: 'var(--text-2)' }}>
          No deposits are waiting to be matched to rent.
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {top}
      {data?.remaining > 0 && (
        // Never let a cap read as "that's everything".
        <div style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>
          Showing the most recent {deposits.length}. {data.remaining} older deposits are not listed.
        </div>
      )}

      {withCandidates.map((d) => {
        // Only the server's sure pick opens selected; anything else waits for the owner.
        const pick: string | undefined = chosen[d.transactionId]
          ?? d.candidates.find((c: any) => c.preselect === true)?.leaseId
        const cand = pick ? d.candidates.find((c: any) => c.leaseId === pick) : undefined
        const m = method[d.transactionId] ?? 'cash'
        const name = depositName(d)
        const recordingThis = confirm.isLoading && confirm.variables?.id === d.transactionId
        const settingAsideThis = notRent.isLoading && notRent.variables?.id === d.transactionId
        const err = errors[d.transactionId]
        return (
          <div key={d.transactionId} className="card" style={{ padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1rem' }}>
                  {formatCurrency(Number(d.amount))}
                </div>
                <div style={{ fontSize: '.74rem', color: 'var(--text-3)' }}>
                  Posted {d.postedDate}{d.description ? ` · ${d.description}` : ''}
                </div>
              </div>
              <button type="button" className="btn btn-primary btn-sm"
                disabled={settingAsideThis || recordingThis}
                onClick={() => notRent.mutate({ id: d.transactionId, name })}>
                {settingAsideThis ? 'Setting aside…' : 'Not a rent payment'}
              </button>
            </div>

            {d.transferMemo && (
              <div style={{ marginTop: 10, fontSize: '.76rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
                The bank says this was a transfer between accounts — most often your own money.
                Pick a tenant only if you know they sent it; otherwise press "Not a rent payment".
              </div>
            )}
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {d.candidates.map((c: any) => (
                <div key={c.leaseId}>
                <label style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer',
                  padding: '7px 9px', borderRadius: 8,
                  border: `1px solid ${c.leaseId === pick ? 'var(--gold)' : 'var(--border-1)'}`,
                  background: c.leaseId === pick ? 'var(--bg-3)' : 'transparent',
                }}>
                  <input type="radio" name={`cand-${d.transactionId}`}
                    checked={c.leaseId === pick} style={{ marginTop: 3 }}
                    onChange={() => setChosen({ ...chosen, [d.transactionId]: c.leaseId })} />
                  <span style={{ fontSize: '.8rem', lineHeight: 1.5 }}>
                    <strong>{c.tenantName}</strong>
                    <span style={{ color: 'var(--text-3)' }}> · {c.unitNumber} · {formatCurrency(Number(c.total))}</span>
                    <div style={{ color: 'var(--text-3)', fontSize: '.72rem', marginTop: 2 }}>
                      {CONFIDENCE_LABEL[c.confidence] ?? 'Possible match'} — {c.reason}
                    </div>
                  </span>
                </label>
                  {/* 10/5 (Nic): the tenant's report — its reference, their photo of
                      the bank's receipt, and a plain flag when the bank shows a later day. */}
                  {c.declaration && (
                    <div style={{ fontSize: '.72rem', marginTop: 4, paddingLeft: 32 }}>
                      {c.declaration.reference && (
                        <span style={{ color: 'var(--text-2)' }}>Deposit reference {c.declaration.reference}</span>
                      )}
                      {!c.declaration.dateHolds && (
                        <div role="note" style={{ marginTop: 2, color: 'var(--amber)', fontWeight: 600 }}>
                          {declaredDateFlagText(c.declaration.declaredDate, d.postedDate)}{' '}
                          The bank's date counts, so late fees up to it stay.
                        </div>
                      )}
                      {c.declaration.receiptPhotoUrl && (
                        <BankReceiptPhoto receiptId={null} url={c.declaration.receiptPhotoUrl}
                          canAdd={false} onAdded={() => {}} label="Tenant's photo of the bank receipt" />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '.74rem', color: 'var(--text-3)' }}>Paid by</span>
              {DEPOSITABLE_PAYMENT_METHODS.map((opt) => (
                <button key={opt} type="button"
                  className={m === opt ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}
                  aria-pressed={m === opt}
                  onClick={() => setMethod({ ...method, [d.transactionId]: opt })}>
                  {MANUAL_PAYMENT_METHOD_LABELS[opt]}
                </button>
              ))}
            </div>

            <button type="button" className="btn btn-primary" style={{ width: '100%', marginTop: 12, justifyContent: 'center' }}
              // One record at a time: another card's button waits while one is being recorded.
              disabled={!cand || cand.chargeIds.length === 0 || confirm.isLoading || settingAsideThis}
              onClick={() => cand && confirm.mutate({
                id: d.transactionId, name, chargeIds: cand.chargeIds, method: m,
                // 10/5 (Nic): the tenant's report this match was made from — the
                // landlord confirming it is what ties the report to this deposit.
                declarationId: cand.declaration?.id,
              })}>
              {recordingThis ? 'Recording…'
                : cand ? `Record as paid by ${cand.tenantName}` : 'Pick who paid this deposit'}
            </button>
            {cand && cand.chargeIds.length === 0 && (
              <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 6 }}>
                This tenant has nothing open that adds up to {formatCurrency(Number(d.amount))} —
                record it against their charges from the payments screen instead.
              </div>
            )}
            {err && (
              <div role="alert" style={{ marginTop: 8, fontSize: '.8rem', color: 'var(--red)' }}>
                {err.sentence}
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
 *
 * S655 (Step 12): in two groups — on a deposit slip (in the bag, waiting for
 * the bank) and on no slip at all — with "Make a bank deposit" beneath it.
 */
export function CashPositionPanel({ entityId = '' }: { entityId?: string }) {
  const entityQS = entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''
  // S654: nothing is asked until an owner of several companies picks one.
  const companiesLoading = useEntities().isLoading
  const companyMissing = useCompanyMissing(entityId)
  const { data, isLoading, isError, error } = useQuery<any>(['cash-position', entityId],
    () => apiGet('/bank-feed/cash-position' + entityQS),
    { ...FRESH_LIST, enabled: !companyMissing && !companiesLoading })
  // A list that did not load is said as such — never "every payment has been
  // accounted for", which would be false reassurance.
  if (companyMissing || isError) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className={`card bankrec-card${isError && !companyMissing ? ' bankrec-error' : ''}`}
          role={isError && !companyMissing ? 'alert' : undefined}>
          <div className="bankrec-title">Collected in person, not yet in the bank</div>
          <div className="bankrec-sub">
            {companyMissing
              ? 'Choose a company above to see the cash it has not banked yet and to make a bank deposit.'
              : loadFailedSentence(error, 'The cash not yet banked', 'Bank', { lead: true })}
          </div>
        </div>
        {/* The deposit panel asks for the company too: with none chosen it would only repeat this. */}
        {!companyMissing && <MakeDepositPanel entityId={entityId} canMatchBank />}
      </div>
    )
  }
  if (companiesLoading || isLoading) return null
  const onSlip: any[] = data?.onSlip?.items ?? []
  const notOnSlip: any[] = data?.notOnSlip?.items ?? []
  const line = (u: any) => (
    <div key={`${u.kind}:${u.id}`} className="bankrec-cash-line">
      <span className="bankrec-cash-who">
        {u.payerName || (u.kind === 'register_sale' ? 'Register sale' : 'Payment')}{u.unitNumber ? ` · ${u.unitNumber}` : ''} · {MANUAL_PAYMENT_METHOD_LABELS[u.method as ManualPaymentMethod] ?? 'Cash'}
      </span>
      <span className="bankrec-cash-amt">
        <span className="bankrec-amt">{formatCurrency(u.amount)}</span>
        <span className="bankrec-meta">{u.daysOutstanding}d</span>
      </span>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="card bankrec-card">
        <div className="bankrec-title">Collected in person, not yet in the bank</div>
        {onSlip.length === 0 && notOnSlip.length === 0
          ? <div className="bankrec-sub">Every payment collected in person has been accounted for by a bank deposit.</div>
          : <div className="bankrec-sub">
              {formatCurrency(data.unbankedTotal)} across {onSlip.length + notOnSlip.length}{' '}
              {onSlip.length + notOnSlip.length === 1 ? 'payment' : 'payments'}, the oldest {data.oldestDays} days ago.
              {/* Deliberately not an accusation. Cash sits in a drawer over a weekend. */}
              {' '}This is a prompt to check, not a discrepancy on its own.
            </div>}
        {onSlip.length > 0 && (
          <div className="bankrec-cash-group">
            <div className="bankrec-section">On a deposit slip, waiting for the bank · {formatCurrency(data.onSlip.total)}</div>
            {onSlip.map(line)}
          </div>
        )}
        {notOnSlip.length > 0 && (
          <div className="bankrec-cash-group">
            <div className="bankrec-section">Not on any slip · {formatCurrency(data.notOnSlip.total)}</div>
            {notOnSlip.map(line)}
          </div>
        )}
        {data?.slipsOverdue > 0 && (
          <div className="bankrec-flag">
            {data.slipsOverdue === 1 ? 'One deposit slip has' : `${data.slipsOverdue} deposit slips have`} not shown up at the bank
            within 5 business days. Check the bank's deposit receipt.
          </div>
        )}
        {data?.unattributedDeposits > 0 && (
          <div className="bankrec-note">
            There {data.unattributedDeposits === 1 ? 'is' : 'are'} also {data.unattributedDeposits}{' '}
            {data.unattributedDeposits === 1 ? 'deposit' : 'deposits'} totaling{' '}
            {formatCurrency(data.unattributedTotal)} that nothing has been matched to yet.
          </div>
        )}
      </div>
      <MakeDepositPanel entityId={entityId} canMatchBank />
    </div>
  )
}
