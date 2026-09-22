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
import { BankReconciliationPage } from './BankReconciliationPage'
import { BankFeedPage } from './BankFeedPage'
import { useState } from 'react'
import { DepositMatchPanel, CashPositionPanel } from './DepositMatchPanel'
import { EntityPicker } from '../components/EntityPicker'

// S652 (Nic): "the bank feed and reconciliation need to be on a separate page
// because this layout is retarded." Two tabs. The feed is the bank: linked
// account, balance, transactions to categorize. Reconciliation is the month
// check, and underneath it the deposits that may be a tenant's rent — a
// matching job, not something to wade through on the way to the balance.
export function BankPage() {
  const [tab, setTab] = useState<'feed' | 'reconcile'>('feed')
  const [entityId, setEntityId] = useState('')
  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Bank</h1>
          <p className="page-subtitle">
            {tab === 'feed'
              ? 'Your linked bank, its balance, and the transactions to turn into expenses.'
              : 'Check that GAM\'s payouts landed, and match branch deposits to rent.'}
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
          <BankReconciliationPage embedded />
          <div style={{ marginTop: 28 }}>
            <div className="card-title" style={{ marginBottom: 8 }}>Deposits that may be rent</div>
            <div style={{ fontSize: '.76rem', color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>
              Money paid in at a branch that matches what a tenant owes to the dollar, or that a
              tenant told us about. Recording it here dates the payment to the deposit, so any
              late fee charged while it was in transit comes back off.
            </div>
            <EntityPicker value={entityId} onChange={setEntityId} label="Company"
              note="Each company has its own bank, so its deposits are matched on their own." />
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
