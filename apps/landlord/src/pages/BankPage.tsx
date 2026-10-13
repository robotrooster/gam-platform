// S605 (Nic): ONE "Bank" tab.
//
// There used to be two: "Bank Feed" and "Bank Reconciliation". Nic asked what
// the difference was, and the honest answer was that they overlap by accident of
// build order — reconciliation shipped first (S568) as the MANUAL stand-in, its
// own header reading "manual for now (no bank feed until Plaid)". The feed
// landed two sessions later (S570) and nobody went back to merge them, so a
// workaround sat in the nav next to the automated version of itself. Both
// compare your bank against what GAM sent you; both end up writing expenses.
//
// Two navigation items for one question ("is my bank money right?") is exactly
// the kind of distinction the simplicity rule says not to make the user carry.
//
// The backends are untouched — this composes the two existing page bodies in
// `embedded` mode, so all the working logic stays where it was.
import { useUrlTab } from '../lib/useUrlTab'
import { BankFeedPage } from './BankFeedPage'
import { useMemo, useState } from 'react'
import { QueryClient, QueryClientProvider } from 'react-query'
import { DepositMatchPanel, CashPositionPanel } from './DepositMatchPanel'
import { EntityPicker, useEntities } from '../components/EntityPicker'
import { BankReconcilePage } from '../bookkeeping/BankReconcilePage'
import { setBooksCompany } from '../bookkeeping/adapter'
import '../bookkeepingHost.css'

/**
 * 10/12 (Nic, ledger P9): the month check is the bank reconciliation on the
 * books now — GAM Books' own page (src/bookkeeping, the same bytes as GAM
 * Books and the Bookkeeping menu), on the company chosen above. It replaces
 * the S568 statement-total check (a statement figure against what GAM paid
 * out, with bank charges logged beside it): a bank account is reconciled line
 * by line against its statement, and a bank charge is an expense paid from
 * that bank. Its own cache and Books' look (.bk-host), like the Bookkeeping
 * host (bookkeepingHost.tsx).
 */
function LedgerReconciliation({ entityId }: { entityId: string }) {
  const { data: entities = [] } = useEntities()
  // S654 (Nic, DIRECTIVE): no default company — a two-company account chooses first.
  const ready = !!entityId || entities.length === 1
  setBooksCompany(entityId || null)
  const qc = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000 } } }), [entityId])
  if (!ready) {
    return (
      <div className="card" style={{ padding: 14, fontSize: '.82rem', color: 'var(--text-3)', marginBottom: 20 }}>
        {entities.length >= 2 ? 'Choose a company above to reconcile its bank.' : 'Loading…'}
      </div>
    )
  }
  return (
    <div className="bk-host">
      <QueryClientProvider client={qc}><BankReconcilePage embedded /></QueryClientProvider>
    </div>
  )
}

// S652 (Nic): "the bank feed and reconciliation need to be on a separate page
// because this layout is retarded." Two tabs. The feed is the bank: linked
// account, balance, transactions to categorize. Reconciliation is the month
// check, and underneath it the deposits that may be a tenant's rent — a
// matching job, not something to wade through on the way to the balance.
export function BankPage() {
  const [tab, setTab] = useUrlTab('tab', 'feed', ['feed','reconcile'] as const)
  const [entityId, setEntityId] = useState('')
  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Bank</h1>
          <p className="page-subtitle">
            {tab === 'feed'
              ? 'Your linked bank, its balance, and the transactions to turn into expenses.'
              : 'Reconcile each bank account against its statement, and match branch deposits to rent.'}
          </p>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
        <button className={`btn btn-sm ${tab === 'feed' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('feed')}>Bank feed</button>
        <button className={`btn btn-sm ${tab === 'reconcile' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('reconcile')}>Reconciliation</button>
      </div>

      {tab === 'feed' && <BankFeedPage embedded />}

      {tab === 'reconcile' && (
        <div>
          {/* S654 (Nic, DIRECTIVE): no default company. One choice at the top
              of the tab drives the month check AND the deposit matching below. */}
          <EntityPicker value={entityId} onChange={setEntityId} label="Company"
            note="Each company has its own bank, so its month is checked and its deposits matched on their own." />
          {/* S654 (review): keyed by company, so typed figures never carry over to another company's books. */}
          <LedgerReconciliation key={entityId || 'none'} entityId={entityId} />
          <div style={{ marginTop: 28 }}>
            <div className="card-title" style={{ marginBottom: 8 }}>Deposits that may be rent</div>
            <div style={{ fontSize: '.76rem', color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>
              Money paid in at a branch that matches what a tenant owes to the dollar, or that a
              tenant told us about. Recording it here dates the payment to the deposit, so any
              late fee charged while it was in transit comes back off.
            </div>
            <DepositMatchPanel entityId={entityId} />
            <div style={{ marginTop: 16 }}>
              <CashPositionPanel entityId={entityId} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
