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
//
// ── 10/19 (Nic): THE SAME MERGE, AGAIN — THE TWO BANK SIGN-UPS ──────────────
//
// "The bank page only is for linking a bank for bank feed reconciliation. The
// disbursement account is where money pays out from Stripe to his bank account,
// right? I don't know why there's two different fucking signups. It should all
// be in one flow." Then: "Merge it all so it's one flow for any other landlords
// that onboard."
//
// So the Disbursement Account page (/banking, Stripe Connect) is now the "Bank
// setup" tab here: ONE nav entry, ONE heading, and the two steps in order with
// honest state for each. /banking redirects in, exactly the way /bank-feed and
// /bank-reconciliation already did (BankSetupRedirect), so a bookmark still
// works — Blu has one. A landlord whose setup is unfinished opens on that tab
// and is told so on every tab until it is done.
import { useEffect, useRef } from 'react'
import { useUrlTab } from '../lib/useUrlTab'
import { BankFeedPage } from './BankFeedPage'
import { useMemo, useState } from 'react'
import { QueryClient, QueryClientProvider } from 'react-query'
import { DepositMatchPanel, CashPositionPanel } from './DepositMatchPanel'
import { EntityPicker, useEntities } from '../components/EntityPicker'
import { BankReconcilePage } from '../bookkeeping/BankReconcilePage'
import { setBooksCompany } from '../bookkeeping/adapter'
import { useAuth } from '../context/AuthContext'
import { BankSetupFlow, OwnPayoutAccount, useBankSetupSurface } from './BankSetup'
import { companyName } from '../lib/payoutReadiness'
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

type TabId = 'setup' | 'feed' | 'reconcile'

const SUBTITLE = {
  setup: 'Two steps, one bank account: verify your business so rent can reach it, then link it read-only.',
  feed: 'Your linked bank, its balance, and the transactions to turn into expenses.',
  reconcile: 'Reconcile each bank account against its statement, and match branch deposits to rent.',
} as const

// S652 (Nic): "the bank feed and reconciliation need to be on a separate page
// because this layout is retarded." Two tabs. The feed is the bank: linked
// account, balance, transactions to categorize. Reconciliation is the month
// check, and underneath it the deposits that may be a tenant's rent — a
// matching job, not something to wade through on the way to the balance.
// 10/19 (Nic): and Bank setup first — the two sign-ups, merged (see the header).
export function BankPage() {
  const { user } = useAuth()
  // S168: a manager (or staff member) their landlord switched direct deposit on
  // for reaches this page for their OWN payout account. They get that one step
  // and nothing else: the company's feed and its reconciliation are not theirs
  // to read. This is the same surface /banking gave them before the merge.
  const ownAccountOnly = !['landlord', 'admin', 'super_admin'].includes(user?.role ?? 'landlord')
  // 10/19 (review): bank setup belongs to the ACCOUNT OWNER and to nobody else.
  // A GAM admin or super_admin opens this page for oversight — they are not
  // `ownAccountOnly` (the feed and the reconciliation are the point of their
  // visit), but the Bank setup tab was showing them "Verify your business & get
  // paid" with a gold button that would have created a real Stripe Connect
  // account against the GAM staff user and asked that admin for their own SSN.
  // No tab, so no button, and useBankSetupSurface asks Stripe nothing.
  const isOwner = user?.role === 'landlord'
  const TABS = (isOwner
    ? [['setup', 'Bank setup'], ['feed', 'Bank feed'], ['reconcile', 'Reconciliation']]
    : [['feed', 'Bank feed'], ['reconcile', 'Reconciliation']]) as ReadonlyArray<readonly [TabId, string]>

  const [tab, setTab] = useUrlTab<TabId>('tab', 'feed', TABS.map(t => t[0]),
    // 10/19 (review): the chosen tab always rides the address here, because this
    // page lands people somewhere other than where they left off. Without it,
    // picking Bank feed deleted the ?tab= that said so and a refresh bounced
    // them back to Bank setup (lib/useUrlTab).
    { always: true })
  const [entityId, setEntityId] = useState('')
  const surface = useBankSetupSurface()

  // 10/19 (Nic): "a landlord with neither done must see step 1 first." Nobody
  // lands on the transaction log of a bank they have not finished connecting —
  // but a tab they asked for by address is theirs, so an explicit ?tab= wins.
  //
  // 10/19 (review): this waited on `surface.known`, which is the state of ONE
  // chosen company — and an account that owns several with payouts live
  // everywhere chose none, so it never fired. It waits on the account-wide
  // answer now (every company's two steps), which also covers the chosen one.
  const landed = useRef(false)
  const needsSetup = surface.unfinishedCompanies.length > 0
  useEffect(() => {
    if (landed.current || ownAccountOnly || !isOwner || !surface.setupKnown) return
    // Don't decide while the chosen company's live Stripe answer is still out —
    // the company list's flag trails a webhook and would land somebody who just
    // finished Stripe back on the setup they finished.
    if (surface.entityId && !surface.known) return
    landed.current = true
    if (!needsSetup) return
    if (new URLSearchParams(window.location.search).has('tab')) return
    setTab('setup')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownAccountOnly, isOwner, surface.setupKnown, surface.known, surface.entityId, needsSetup])

  if (ownAccountOnly) {
    return (
      <div>
        <div className="page-header">
          <div>
            <h1 className="page-title">Bank</h1>
            <p className="page-subtitle">The account your direct deposit is paid into.</p>
          </div>
        </div>
        <OwnPayoutAccount />
      </div>
    )
  }

  // Said when we positively know something is outstanding: for the company on
  // screen, or — when an account that owns several has named none — for the
  // companies the account-wide read found. Never while an answer is still out.
  const unfinished = isOwner && surface.setupKnown && (
    surface.known ? !surface.bothDone : !surface.entityId && needsSetup
  )
  const unfinishedNames = surface.unfinishedCompanies.map(companyName).join(', ')

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Bank</h1>
          <p className="page-subtitle">{SUBTITLE[tab]}</p>
        </div>
      </div>

      {/* 10/19: said on every tab, because Blu's whole problem was not knowing
          there was anything left to do. It never disables a tab — a landlord
          whose onboarding window closed weeks ago still reaches all of it. */}
      {unfinished && tab !== 'setup' && (
        <div className="card" style={{ padding: '12px 14px', marginBottom: 16, display: 'flex',
          alignItems: 'center', gap: 12, flexWrap: 'wrap',
          background: 'rgba(220,165,40,.08)', borderColor: 'rgba(220,165,40,.3)' }}>
          <div style={{ flex: 1, minWidth: 240, fontSize: '.8rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--gold)' }}>Your bank setup isn&apos;t finished.</strong>{' '}
            {/* 10/19 (review): with several companies and none chosen there is no
                "which step" to report — so it names the companies instead of
                saying nothing at all, which is what it used to do. */}
            {!surface.known
              ? `${unfinishedNames} still ${surface.unfinishedCompanies.length === 1 ? 'needs' : 'need'} it. Open Bank setup and choose ${surface.unfinishedCompanies.length === 1 ? 'it' : 'one'} to finish.`
              : surface.step1Done
                ? 'Rent can reach your bank, but it isn’t linked read-only yet, so your spending never becomes expenses.'
                : surface.step2Done
                  ? 'Your bank is linked read-only, but your business isn’t verified yet, so rent has nowhere to go.'
                  : 'Neither step is done yet: rent has nowhere to go, and nothing is reconciling.'}
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setTab('setup')}>Finish bank setup</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
        {TABS.map(([id, label]) => (
          <button key={id} className={`btn btn-sm ${tab === id ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'setup' && isOwner && <BankSetupFlow surface={surface} />}

      {tab === 'feed' && <BankFeedPage embedded onGoToSetup={() => setTab('setup')} />}

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
