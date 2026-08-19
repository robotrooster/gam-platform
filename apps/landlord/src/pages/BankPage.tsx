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

export function BankPage() {
  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Bank</h1>
          <p className="page-subtitle">
            Check that GAM's payouts landed, and turn your own spending into expenses.
          </p>
        </div>
      </div>

      {/* Month check first: it answers the headline question in one glance.
          The day-to-day work (categorizing transactions) sits underneath. */}
      <BankReconciliationPage embedded />
      <BankFeedPage embedded />
    </div>
  )
}
