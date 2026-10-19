/**
 * BANK SETUP — ONE FLOW, TWO STEPS, ONE BANK ACCOUNT.
 *
 * 10/19 (Nic, DIRECTIVE): "The bank page only is for linking a bank for bank
 * feed reconciliation. The disbursement account is where money pays out from
 * Stripe to his bank account, right? I don't know why there's two different
 * fucking signups. It should all be in one flow." And: "Merge it all so it's
 * one flow for any other landlords that onboard."
 *
 * WHAT WAS WRONG. There were two sign-ups for the same bank account, on two
 * addresses three letters apart: /bank ("Bank") linked the operating bank
 * READ-ONLY so GAM could match real transactions, and /banking ("Disbursement
 * Account") verified the business with Stripe Connect so rent could be paid
 * out. Two nav entries, two headings, two "connect a bank" buttons, and no
 * sequence anywhere telling a landlord what was still undone.
 *
 * Blu Haws (TruBlu Management LLC, Country Acres - Mattoon) started onboarding
 * 8/28 at 5:27pm and never finished. He came back on 10/5, went to the
 * Disbursement Account page, found the old pre-Stripe "Add Bank Account" form
 * still sitting there, typed in his First Mid routing and account number, and
 * waited for microdeposits that could never come — his company had no Stripe
 * account at all. That form is gone and the endpoint refuses new entries
 * (api routes/bankAccounts.ts), but he was still left with two similarly named
 * pages and nothing saying which one he had not done.
 *
 * WHY IT IS STILL TWO STEPS. It cannot be one Stripe screen. Connect ("prove
 * who you are so we can pay you") and Financial Connections ("let GAM read
 * your transactions") are different Stripe products with different consents,
 * and the read-only consent needs the landlord to sign in to their bank. So
 * the merge is a GAM-side FLOW merge: ONE destination, TWO steps, in order,
 * finishable in one sitting — and the same two components render inside
 * onboarding, so there is one implementation of each step and they can never
 * drift apart again.
 *
 * NOT A GATE. Step 2 is offered even when step 1 is unfinished. S637 hid the
 * feed until payouts existed so nobody would link the read-only feed believing
 * they had set up payouts — that confusion is now handled by the ORDER and the
 * labels being on one screen, not by hiding a button and stranding somebody who
 * came back weeks later. The destination says plainly that setup is not
 * finished until both steps are done.
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueries, useQueryClient } from 'react-query'
import { useLocation, Navigate, useSearchParams } from 'react-router-dom'
import { Landmark, Check } from 'lucide-react'
import { loadStripe } from '@stripe/stripe-js'
import { apiGet, apiPost } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { connectRequirementLabels } from '@gam/shared'
import { loadConnectAndInitialize } from '@stripe/connect-js'
import type { StripeConnectInstance } from '@stripe/connect-js'
import {
  ConnectAccountOnboarding, ConnectComponentsProvider,
} from '@stripe/react-connect-js'
import { EntityPicker, useEntities } from '../components/EntityPicker'
import { companiesMissingPayouts, companyName, type PayoutCompany } from '../lib/payoutReadiness'
import { toast } from '../components/dialogs'

/** The one address bank setup lives at. Every link and refusal names this. */
export const BANK_SETUP_PATH = '/bank?tab=setup'

/** 10/19: the words for each step — identical on the destination and in onboarding. */
export const STEP_1_TITLE = 'Get paid'
export const STEP_1_SUB   = 'Verify your business so rent can reach your bank.'
export const STEP_2_TITLE = 'Connect your bank'
export const STEP_2_SUB   = 'Link that same account read-only so your deposits and expenses match.'
/**
 * 10/19 (review): a staff member on direct deposit is paid manager fees, not
 * rent — "Verify your business so rent can reach your bank" was the landlord's
 * sentence on somebody else's page.
 */
export const OWN_STEP_SUB = 'Verify your details so your fees can reach your bank.'

const STRIPE_PK = (import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined

export interface ConnectStatus {
  connectAccountId: string | null
  exists: boolean
  chargesEnabled?: boolean
  payoutsEnabled?: boolean
  detailsSubmitted?: boolean
  requirementsCurrentlyDue?: string[]
  payoutBank?: { bankName: string | null; last4: string | null } | null
}

/** Step 1 is done when Stripe will actually pay out — nothing less counts (S637). */
export function payoutsLive(s?: ConnectStatus): boolean {
  return !!s?.payoutsEnabled && !!s?.detailsSubmitted
}

/**
 * The company's live Stripe Connect state. ONE query key for the whole app, so
 * the destination, onboarding and the feed all read the same answer and one
 * invalidation refreshes every screen showing it.
 *
 * S554: an OWNER verifies the landlord ENTITY (entity=landlord). A scoped
 * worker with a direct-deposit opt-in verifies their OWN user account
 * (entity=user) — switching them would 403 on the live membership check and
 * break manager direct deposit.
 */
export function useConnectStatus(
  entityId: string, isOwner: boolean,
  opts?: {
    refetchInterval?: number | false | ((d?: ConnectStatus) => number | false)
    /**
     * 10/19 (review): `isOwner` is false for a staff member setting up their OWN
     * payout account — and ALSO for a GAM admin looking at a landlord's page.
     * Without this, opening the merged Bank page as an admin fetched the ADMIN's
     * personal Connect status on load. Callers that are not an own-account
     * surface pass `enabled: isOwner` and nothing is asked about anybody.
     */
    enabled?: boolean
  },
) {
  const qs = isOwner ? `entity=landlord&entityId=${entityId}` : 'entity=user'
  return useQuery<ConnectStatus>(
    ['stripe-connect-status', isOwner ? 'landlord' : 'user', entityId],
    () => apiGet(`/stripe/connect/status?${qs}`),
    {
      // S637: never ask about a company nobody has named yet — the API answers,
      // correctly, that it cannot tell which company is meant, and that error
      // rendered before the picker below had resolved.
      enabled: (opts?.enabled ?? true) && (!isOwner || !!entityId),
      refetchInterval: opts?.refetchInterval ?? false,
    },
  )
}

/**
 * HOW FAR BANK SETUP GOT, FOR EVERY COMPANY ON THE ACCOUNT.
 *
 * 10/19 (review): the Bank page claimed nothing at all for an account that owns
 * two or more companies once step 1 was live for all of them. The only rule
 * that picked a company looked at PAYOUTS (lib/payoutReadiness) — it never
 * looked at the read-only feed — so with payouts live everywhere no company was
 * chosen, so nothing was "known", so no banner rendered on any tab and the page
 * opened on the feed. That is Blu one step from now: Oak Park paid and linked,
 * TruBlu paid and NOT linked, and no screen saying so.
 *
 * Step 1 comes free with the company list (`connectPayoutsEnabled`). Step 2 is
 * one small read per company, under the SAME query key the chosen company's own
 * read uses, so the chosen company is never fetched twice and one invalidation
 * after a link refreshes every company.
 */
export function useBankSetupByCompany(isOwner: boolean, companies: PayoutCompany[]) {
  const results = useQueries(
    companies.map(c => ({
      queryKey: ['bank-connections', c.id],
      queryFn: () => apiGet<any[]>(`/bank-feed/connections?entityId=${encodeURIComponent(c.id)}`),
      enabled: isOwner,
    })),
  ) as Array<{ data?: any[]; isSuccess: boolean; isLoading: boolean }>

  // Every company's feed answer is in (success or refusal). Until then the page
  // says nothing rather than guessing — the whole point of this rewrite.
  const known = isOwner && companies.length > 0 && results.every(r => !r?.isLoading)
  const unfinished = companies.filter((c, i) => {
    const r = results[i]
    if (!c.connectPayoutsEnabled) return true
    // A refused or still-running read is not evidence that a feed is missing.
    if (!r?.isSuccess) return false
    return !(r.data ?? []).some((x: any) => x?.status === 'active')
  })
  return { known, unfinished }
}

/**
 * Which company bank setup is for, on the standalone destination.
 *
 * 10/12 (Nic): this was pinned to user.profileId, which /auth/me fills with the
 * account's OLDEST company. Blu owns Oak Park (paid) and TruBlu Management LLC
 * (Country Acres, no Stripe account), so the page opened on Oak Park and told
 * the Country Acres owner "you're all set" with no button to set TruBlu up.
 * It starts on NO company (S654: none is the default) and lands on one only
 * for a reason, in this order: the company a to-do or banner linked to
 * (?entity=), the one company whose rent has nowhere to go, or — 10/19
 * (review) — the one company with EITHER bank step still outstanding. That
 * last rule is the one that was missing: with payouts live on every company the
 * old list was empty, so no company was chosen and the page said nothing at all
 * about a missing read-only feed. One company is chosen by EntityPicker itself.
 */
export function usePayoutEntity() {
  const { user } = useAuth()
  const isOwner = user?.role === 'landlord'
  const [searchParams] = useSearchParams()
  const linkedEntity = searchParams.get('entity') ?? ''
  const [entityId, setEntityId] = useState('')
  const { data: entityList = [] } = useEntities()
  const entities = entityList as PayoutCompany[]
  const unpaid = companiesMissingPayouts(entities)
  const byCompany = useBankSetupByCompany(isOwner, entities)
  const landed = useRef(false)
  useEffect(() => {
    if (landed.current || !isOwner || entityId || entities.length === 0) return
    // One company is not a choice (EntityPicker renders nothing for it), so it
    // is chosen here rather than inside the picker — the Bank page needs the
    // answer for its "setup isn't finished" banner even on the other tabs,
    // where no picker is mounted.
    if (entities.length === 1) { landed.current = true; setEntityId(entities[0].id); return }
    if (linkedEntity && entities.some(e => e.id === linkedEntity)) {
      landed.current = true; setEntityId(linkedEntity); return
    }
    // A company whose rent has nowhere to go is the most urgent thing on the
    // account, and the company list already answers it — no waiting.
    if (unpaid.length === 1) { landed.current = true; setEntityId(unpaid[0].id); return }
    // 10/19 (review): otherwise wait for the per-company feed answer before
    // deciding there is nothing to land on. The old rule stopped here, so a
    // landlord whose payouts were live everywhere but whose feed was missing on
    // one company landed on no company and was told nothing.
    if (!byCompany.known) return
    landed.current = true
    if (byCompany.unfinished.length === 1) setEntityId(byCompany.unfinished[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner, entityId, entities, linkedEntity, byCompany.known])
  return {
    entityId, setEntityId, isOwner, entities,
    /** Another company with a property still cannot be paid — named even while a paid one is on screen. */
    otherUnpaid: unpaid.filter(e => e.id !== entityId),
    /** Every company's bank-setup state is in, so "nothing left to do" can be said honestly. */
    setupKnown: byCompany.known,
    /** Companies with either step outstanding — named on the banner when none is chosen. */
    unfinishedCompanies: byCompany.unfinished,
  }
}

/**
 * Linking the operating bank read-only (Stripe Financial Connections).
 *
 * 10/19: there were THREE copies of this call — the Bank Feed page, the
 * onboarding step, and nothing on the Disbursement Account page at all. One
 * copy now, so a fix to the error handling or the consent reaches every screen.
 */
export function useLinkBankFeed(entityId: string, onLinked?: () => void) {
  const qc = useQueryClient()
  const [linking, setLinking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const link = async () => {
    setError(null)
    if (!STRIPE_PK) { setError('Bank linking is not configured (missing Stripe key).'); return }
    setLinking(true)
    try {
      const stripe = await loadStripe(STRIPE_PK)
      if (!stripe) throw new Error('Stripe failed to load')
      // S637: send the company the picker is on. Without it the endpoint fell
      // back to "which of your companies?" and refused, after the landlord had
      // already answered that question on screen.
      const { data: session } = await apiPost<any>('/bank-feed/link-session', { entityId })
      const { clientSecret, sessionId } = session
      const result = await (stripe as any).collectFinancialConnectionsAccounts({ clientSecret })
      if (result.error) throw new Error(result.error.message)
      const accounts = result.financialConnectionsSession?.accounts ?? []
      if (!accounts.length) { setLinking(false); return }   // they closed the bank window
      await apiPost('/bank-feed/finalize', { sessionId, entityId })
      qc.invalidateQueries('bank-connections')
      qc.invalidateQueries(['bank-txns'])
      onLinked?.()
      toast('Bank linked. Syncing transactions…')
    } catch (e: any) {
      // S605: the API's error shape is { success:false, error } — reading
      // data.message was always undefined, so every failure degraded to axios's
      // raw "Request failed with status code 400" and hid what Stripe said.
      setError(e?.response?.data?.error || e?.response?.data?.message || e?.message || 'Could not link the bank.')
    } finally {
      setLinking(false)
    }
  }
  return { link, linking, error }
}

// ── step chrome ─────────────────────────────────────────────────────────────

/**
 * 10/19 (review): the badge was Done / Not done and nothing else, which told a
 * landlord whose details Stripe already HAS and is checking that their step was
 * not done — and handed them the gather-your-EIN checklist a second time. The
 * deleted Disbursement Account page had three states and this one lost them, so
 * `status` is back: the step that knows more than a yes/no says so.
 *
 * `eyebrow`/`mark` exist for the one surface that is NOT a two-step flow: a
 * staff member with direct deposit has exactly one step, and printing "step 1
 * of 2" at them sent them looking for a step 2 that is not theirs to do.
 */
function StepShell({ n, title, sub, done, status, eyebrow, mark, children }: {
  n: 1 | 2; title: string; sub: string; done: boolean
  status?: { text: string; tone: 'green' | 'gold' }
  eyebrow?: string
  mark?: React.ReactNode
  children: React.ReactNode
}) {
  const badge = status ?? { text: done ? 'Done' : 'Not done', tone: done ? 'green' as const : 'gold' as const }
  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
        <div style={{
          width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: done ? 'rgba(38,167,90,.16)' : 'rgba(220,165,40,.14)',
          border: `1px solid ${done ? 'var(--green, #2ea35a)' : 'var(--gold)'}`,
          color: done ? 'var(--green, #2ea35a)' : 'var(--gold)',
          fontWeight: 700, fontSize: '.8rem',
        }}>
          {done ? <Check size={15} /> : (mark ?? n)}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '.66rem', fontWeight: 700, letterSpacing: '.08em',
                        textTransform: 'uppercase', color: 'var(--text-3)' }}>
            {eyebrow ?? `Bank setup · step ${n} of 2`}
          </div>
          <div style={{ fontWeight: 700, color: 'var(--text-0)', fontSize: '1rem', marginTop: 2 }}>{title}</div>
          <div style={{ fontSize: '.8rem', color: 'var(--text-2)', marginTop: 2 }}>{sub}</div>
        </div>
        <span style={{
          padding: '4px 12px', borderRadius: 14, fontSize: '.72rem', fontWeight: 600,
          background: badge.tone === 'green' ? 'rgba(38,167,90,.16)' : 'rgba(220,165,40,.16)',
          color: badge.tone === 'green' ? 'var(--green, #2ea35a)' : 'var(--gold)',
          textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap',
        }}>{badge.text}</span>
      </div>
      {children}
    </div>
  )
}

// ── STEP 1 — Get paid (Stripe Connect) ──────────────────────────────────────

/**
 * Stripe Connect verification: the account rent is deposited into, and the
 * account GAM debits its fees from (gam-bank-link-is-two-way).
 *
 * Rendered by the Bank setup destination AND by onboarding's "Get Paid" step,
 * so the copy below — which is the reason people stopped abandoning the form —
 * exists once.
 */
export function PayoutVerifyStep({ entityId, isOwner, otherUnpaid = [], ownAccount = false }: {
  entityId: string
  isOwner: boolean
  /** Companies with a property that still cannot be paid, other than this one. */
  otherUnpaid?: PayoutCompany[]
  /**
   * 10/19 (review): a staff member with direct deposit verifies their OWN
   * account and has no step 2 — no two-step framing, and the copy is about
   * their fees, not about rent they do not collect.
   */
  ownAccount?: boolean
}) {
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [connectInstance, setConnectInstance] = useState<StripeConnectInstance | null>(null)
  const [initErr, setInitErr] = useState<string | null>(null)
  const qc = useQueryClient()

  const statusQ = useConnectStatus(entityId, isOwner, {
    // 10/19 (review): the deleted page stopped polling the moment payouts went
    // live; this kept asking Stripe every 3 seconds for as long as the form was
    // left open on screen. Stop when there is nothing left to learn.
    refetchInterval: (d?: ConnectStatus) => (showOnboarding && !payoutsLive(d) ? 3000 : false),
  })
  const ready = payoutsLive(statusQ.data)
  const noCompanyChosen = isOwner && !entityId

  // Stripe's three real states between "not started" and "paying out":
  //  - it has the details and is checking them (nothing for the landlord to do)
  //  - it has them and wants something more (say what, and let them back in)
  //  - it has nothing yet (the gather-your-documents checklist earns its place)
  const needsMore = (statusQ.data?.requirementsCurrentlyDue ?? []).length > 0
  const verifying = !ready && !!statusQ.data?.detailsSubmitted && !needsMore
  const actionNeeded = !ready && !!statusQ.data?.detailsSubmitted && needsMore
  const badge = ready
    ? { text: 'Done', tone: 'green' as const }
    : verifying ? { text: 'Verifying…', tone: 'gold' as const }
      : actionNeeded ? { text: 'Action needed', tone: 'gold' as const }
        : { text: 'Not done', tone: 'gold' as const }

  useEffect(() => {
    if (!showOnboarding) qc.invalidateQueries('stripe-connect-status')
  }, [showOnboarding, qc])

  const startOnboarding = async () => {
    setInitErr(null)
    try {
      // Say which company is missing rather than posting an empty id and letting
      // the server answer with a question the button cannot ask.
      if (isOwner && !entityId) {
        throw new Error('Choose which company this bank account belongs to first.')
      }
      if (!STRIPE_PK) throw new Error('VITE_STRIPE_PUBLISHABLE_KEY is not configured.')
      const instance = await loadConnectAndInitialize({
        publishableKey: STRIPE_PK,
        fetchClientSecret: async () => {
          const r = await apiPost<{ connectAccountId: string; clientSecret: string }>(
            '/stripe/connect/onboarding-session',
            isOwner ? { entity: 'landlord', entityId } : { entity: 'user' },
          )
          return r.data!.clientSecret
        },
      })
      setConnectInstance(instance)
      setShowOnboarding(true)
    } catch (e: any) {
      setInitErr(e?.response?.data?.error?.message || e?.message || 'Failed to start onboarding')
    }
  }

  const bank = statusQ.data?.payoutBank
  const money = ownAccount ? 'your fees' : 'rent'
  const what = useMemo(() => {
    if (noCompanyChosen) return 'Choose the company above to see its payout status and set it up.'
    if (ready) {
      return bank?.last4
        ? `You're all set. ${ownAccount ? 'Your fees deposit' : 'Rent deposits'} to ${bank.bankName ?? 'your bank'} ••${bank.last4}.`
        : `You're all set. ${ownAccount ? 'Your fees deposit' : 'Rent deposits'} to the account you gave Stripe.`
    }
    // 10/19 (review): this used to read "Required before tenants can pay rent"
    // to somebody Stripe was already checking, under a badge saying Not done.
    if (verifying) {
      return 'Stripe has your details and is checking them. Nothing more to do on your side — '
        + `${ownAccount ? 'payouts' : 'rent'} starts reaching your bank as soon as Stripe finishes, usually within minutes.`
    }
    if (actionNeeded) return 'Stripe has your details but needs one more thing before it can pay you. It is listed below.'
    return ownAccount
      ? 'Required before your fees can be paid out. Stripe (our payments partner) verifies who you are, then you add the account your fees get deposited into.'
      : 'Required before tenants can pay rent. Stripe (our payments partner) verifies who you are, then you add the account rent gets deposited into.'
  }, [noCompanyChosen, ready, bank, verifying, actionNeeded, ownAccount])

  return (
    <StepShell n={1} done={ready} status={badge}
      title={STEP_1_TITLE}
      sub={ownAccount ? OWN_STEP_SUB : STEP_1_SUB}
      eyebrow={ownAccount ? 'Your payout account' : undefined}
      mark={ownAccount ? <Landmark size={15} /> : undefined}>
      {/* S605 (Nic): this said "Bank Account" / "Link your bank account", so
          landlords expected a routing-number form and were blindsided by Stripe
          asking for an EIN, a date of birth and an SSN. Naming it honestly up
          front is the whole fix — "if I don't know how to do what I need to do,
          that's where the friction lives." */}
      <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>
        Verify your {ownAccount ? 'details' : 'business'} &amp; get paid
      </div>
      <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 4 }}>{what}</div>

      {isOwner && otherUnpaid.length > 0 && (
        <div style={{ marginTop: 12, padding: 10, background: 'rgba(220,165,40,.08)', border: '1px solid rgba(220,165,40,.3)', borderRadius: 6, fontSize: '.76rem', color: 'var(--text-2)' }}>
          <strong style={{ color: 'var(--gold)' }}>
            {otherUnpaid.map(companyName).join(', ')} can&apos;t be paid yet.
          </strong>{' '}
          Rent for {otherUnpaid.length === 1 ? 'its' : 'their'} properties has nowhere to go until payouts are set up —
          choose {otherUnpaid.length === 1 ? 'it' : 'one'} above.
        </div>
      )}

      {(statusQ.data?.requirementsCurrentlyDue ?? []).length > 0 && (
        <div style={{ marginTop: 12, padding: 10, background: 'var(--bg-2)', borderRadius: 6, fontSize: '.74rem', color: 'var(--text-2)' }}>
          {/* S605: these were printed as raw Stripe dot-paths
              ("individual.id_number, business_profile.mcc"), which told a
              landlord nothing about what to actually go and do. */}
          <strong style={{ color: 'var(--gold)' }}>Stripe still needs:</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {connectRequirementLabels(statusQ.data?.requirementsCurrentlyDue ?? [])
              .map((r: string) => <li key={r} style={{ marginBottom: 2 }}>{r}</li>)}
          </ul>
        </div>
      )}

      {/* 10/19 (review): three branches, not one. Verifying shows nothing to
          press — there is nothing to do. Action needed shows the button but not
          the documents checklist, because Stripe already has all of that and the
          list above says what is actually outstanding. */}
      {!ready && !verifying && !showOnboarding && !noCompanyChosen && (
        <div style={{ marginTop: 14 }}>
          {/* Gathering an EIN mid-form is where people abandon. Say what to have
              to hand BEFORE the form opens. */}
          {!actionNeeded && (
          <div style={{ padding: 12, background: 'var(--bg-2)', borderRadius: 8, marginBottom: 12 }}>
            <div style={{ fontSize: '.76rem', fontWeight: 600, color: 'var(--text-1)', marginBottom: 6 }}>
              Have these ready — it takes about 10 minutes:
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: '.76rem', color: 'var(--text-2)', lineHeight: 1.7 }}>
              <li>Your business legal name and <strong>EIN</strong> (or your SSN if you operate as an individual)</li>
              <li>Business address and phone</li>
              <li>Your date of birth, home address, and the last 4 of your SSN — Stripe verifies a real person is behind the account</li>
              <li>The <strong>routing and account number</strong> {money} should be deposited into</li>
            </ul>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 8 }}>
              Handled by Stripe, not stored by GAM. Usually verified within minutes; occasionally Stripe asks for a photo ID.
            </div>
            {/* S605 (Nic): the one moment you leave this page is a small Stripe
                sign-in window (email + phone + a texted code). It is Stripe's
                anti-account-takeover step and cannot be turned off for our
                account type. Saying so up front stops it reading as "the app
                just threw me somewhere else". */}
            <div style={{ fontSize: '.72rem', color: 'var(--text-2)', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-0)' }}>
              <strong style={{ color: 'var(--text-1)' }}>One quick step first:</strong> Stripe opens a small window asking for
              your email and phone, then texts you a code. That's just to confirm it's you —
              after that, the rest of the form happens right here without leaving GAM.
            </div>
          </div>
          )}
          <button className="btn btn-primary" onClick={startOnboarding}>
            {/* S637 (Nic): "I'd relabel the one to connect feed, and then the
                other one would be connect account. That way, they see what's
                going on." Two people in a row linked the read-only transaction
                FEED when they meant to set up payouts, because both screens said
                "connect a bank" and only one moves money. */}
            {statusQ.data?.exists ? 'Continue connecting account' : 'Connect account for payouts'}
          </button>
          {initErr && (
            <div style={{ marginTop: 8, fontSize: '.74rem', color: 'var(--red, #dc4c4c)' }}>{initErr}</div>
          )}
        </div>
      )}

      {showOnboarding && connectInstance && (
        <div style={{ marginTop: 16 }}>
          <ConnectComponentsProvider connectInstance={connectInstance}>
            <ConnectAccountOnboarding onExit={() => setShowOnboarding(false)} />
          </ConnectComponentsProvider>
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 10 }}
                  onClick={() => setShowOnboarding(false)}>
            Close
          </button>
        </div>
      )}
    </StepShell>
  )
}

// ── STEP 2 — Connect your bank (Stripe Financial Connections) ───────────────

/**
 * The read-only link on the SAME bank account step 1 verified.
 *
 * S605 (Nic): he finished Stripe payout setup and reasonably expected this to
 * fill itself in. It can't. Connect tells GAM where to SEND money; this asks
 * the bank for read-only permission to SEE what is spent — a different
 * permission the bank itself must grant, even for the same account. Saying that
 * here, next to the bank's name, is the whole job of this step.
 *
 * S605 (Nic, DIRECTIVE): not optional. "No landlord is gonna be able to get
 * their PNLs accurate if they can't reconcile the bank transactions."
 */
export function BankFeedLinkStep({ entityId, linked, linkedName, payoutBank, onLinked, step1Done, needsCompany = false }: {
  entityId: string
  /** The parent owns "is a bank linked" — the destination and onboarding each already ask. */
  linked: boolean
  /** The linked bank as the feed lists it, when there is one. */
  linkedName?: string | null
  /** The bank Stripe pays out to, from step 1 — named here instead of asking again. */
  payoutBank?: { bankName: string | null; last4: string | null } | null
  onLinked?: () => void
  step1Done: boolean
  /**
   * S654: an account that owns several companies has not said which one yet.
   * No button then — a bank belongs to one company, and pressing it would send
   * an empty company and get back the question the screen already asked.
   */
  needsCompany?: boolean
}) {
  const { link, linking, error } = useLinkBankFeed(entityId, onLinked)
  const named = payoutBank?.last4
    ? `${payoutBank.bankName ?? 'your bank'} ••${payoutBank.last4}`
    : null

  return (
    <StepShell n={2} title={STEP_2_TITLE} sub={STEP_2_SUB} done={linked}>
      {needsCompany ? (
        <div style={{ fontSize: '.82rem', color: 'var(--text-2)' }}>
          Choose the company above to link its bank read-only.
        </div>
      ) : linked ? (
        <div style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text-0)' }}>
            {linkedName || 'Your bank'} is linked, read-only.
          </strong>{' '}
          Your spending lands in your P&amp;L, and the rent GAM already sent you is matched
          automatically so nothing is counted twice.
        </div>
      ) : (
        <>
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.6 }}>
            {named
              ? <>This is the <strong>same bank account</strong> you verified in step 1 — {named}.
                  Nothing to retype: sign in to that bank once and GAM can read its transactions.</>
              : step1Done
                ? <>This is the <strong>same bank account</strong> you verified in step 1. Nothing to
                    retype: sign in to that bank once and GAM can read its transactions.</>
                : <>This is the <strong>same bank account</strong> you'll verify in step 1. You can do
                    this now or after — most people find step 1 easier first, because by then Stripe
                    already has the account.</>}
          </div>
          <div style={{ padding: 12, background: 'var(--bg-2)', borderRadius: 8, margin: '12px 0' }}>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: '.76rem', color: 'var(--text-2)', lineHeight: 1.8 }}>
              <li><strong>Read-only.</strong> Nothing can move money from this connection.</li>
              <li>Why it's needed: your repairs, supplies and utilities become expenses by
                  themselves, so your P&amp;L isn't income-only and the month actually reconciles.</li>
              <li>You sign in to your bank through Stripe — GAM never sees your bank login.</li>
              <li>Rent payouts GAM already sent you are hidden automatically, so nothing double-counts.</li>
            </ul>
          </div>
          <button className="btn btn-primary" onClick={link} disabled={linking}>
            <Landmark size={16} /> {linking ? 'Linking…' : 'Connect feed'}
          </button>
          {error && (
            <div style={{ marginTop: 8, fontSize: '.74rem', color: 'var(--red, #dc4c4c)' }}>{error}</div>
          )}
        </>
      )}
    </StepShell>
  )
}

// ── the destination ─────────────────────────────────────────────────────────

/** Both steps' state for one company, for the banner and the heading. */
export function useBankSetupState(entityId: string, isOwner: boolean) {
  // 10/19 (review): `enabled: isOwner`. This surface is the ACCOUNT OWNER's
  // bank setup; for anyone else (a GAM admin opening the page for oversight)
  // `isOwner` is false and the un-gated hook fell through to entity=user — so
  // visiting the page fetched that admin's own personal Connect status.
  const statusQ = useConnectStatus(entityId, isOwner, { enabled: isOwner })
  // Only the account's owner has a bank feed to link — a staff member with
  // direct deposit sets up their own payout account and nothing else, so never
  // ask the feed endpoint on their behalf (it would refuse them anyway).
  const { data: connections = [] } = useQuery<any[]>(
    ['bank-connections', entityId],
    () => apiGet(`/bank-feed/connections${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`),
    { enabled: isOwner && !!entityId },
  )
  const active = (connections as any[]).filter(c => c.status === 'active')
  const step1Done = payoutsLive(statusQ.data)
  const step2Done = active.length > 0
  return {
    step1Done, step2Done,
    bothDone: step1Done && step2Done,
    payoutBank: statusQ.data?.payoutBank ?? null,
    linkedName: active[0]?.displayName || active[0]?.institutionName || null,
    /** Nothing claimed until the status for a named company is in. */
    known: isOwner && !!entityId && !statusQ.isLoading,
  }
}

/**
 * Everything the Bank page needs about bank setup: which company, and how far
 * each step got. Read once at the top of the page so the banner, the tab it
 * opens on, and the steps themselves can never disagree with each other.
 */
export function useBankSetupSurface() {
  const { entityId, setEntityId, isOwner, otherUnpaid, setupKnown, unfinishedCompanies } = usePayoutEntity()
  const state = useBankSetupState(entityId, isOwner)
  // The chosen company has a LIVE Stripe answer; the company list's
  // `connectPayoutsEnabled` is a webhook behind it. Never tell somebody who
  // just finished Stripe that they have not.
  const unfinished = state.known && state.bothDone
    ? unfinishedCompanies.filter(c => c.id !== entityId)
    : unfinishedCompanies
  return {
    entityId, setEntityId, isOwner, otherUnpaid,
    setupKnown, unfinishedCompanies: unfinished, ...state,
  }
}
export type BankSetupSurface = ReturnType<typeof useBankSetupSurface>

/**
 * The Bank setup surface: one company choice, then the two steps in order.
 * Used by the Bank page's "Bank setup" tab.
 */
export function BankSetupFlow({ surface }: { surface: BankSetupSurface }) {
  const { entityId, setEntityId, isOwner, otherUnpaid } = surface
  const s = surface

  return (
    <div>
      {/* S629/S654: which company. Each company keeps its own Stripe account and
          its own bank, so the choice drives BOTH steps. One company renders
          nothing here and is chosen for them. */}
      {isOwner && (
        <EntityPicker value={entityId} onChange={setEntityId} label="Bank setup for"
          note="Each company has its own bank account — both steps are done once per company." />
      )}

      <div style={{ marginBottom: 14, fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.6 }}>
        {/* 10/19 (Nic): "I don't know why there's two different fucking signups.
            It should all be in one flow." It is one flow — and it says out loud
            that it isn't finished until both steps are done, which is what Blu
            had no way to know. */}
        {!s.known
          ? (s.setupKnown && !entityId && s.unfinishedCompanies.length > 0
              ? <><strong style={{ color: 'var(--gold)' }}>
                    {s.unfinishedCompanies.map(companyName).join(', ')}{' '}
                    {s.unfinishedCompanies.length === 1 ? 'still needs' : 'still need'} bank setup.
                  </strong>{' '}
                  Choose {s.unfinishedCompanies.length === 1 ? 'it' : 'one'} above and both steps are below, in order.</>
              : 'Two steps, one bank account: Stripe verifies your business so rent can reach it, then you link that same account read-only so the money matches.')
          : s.bothDone
            ? 'Bank setup is complete. Rent reaches your bank and your transactions are reconciling.'
            : <><strong style={{ color: 'var(--gold)' }}>Your bank setup isn&apos;t finished.</strong>{' '}
                Two steps, one bank account, and {s.step1Done || s.step2Done ? 'one is' : 'neither is'} done
                yet. Both are below, in order.</>}
      </div>

      <PayoutVerifyStep entityId={entityId} isOwner={isOwner} otherUnpaid={otherUnpaid} />
      <BankFeedLinkStep entityId={entityId} linked={s.step2Done} linkedName={s.linkedName}
        payoutBank={s.payoutBank} step1Done={s.step1Done} needsCompany={isOwner && !entityId} />
    </div>
  )
}

/**
 * S168: a manager (or other staff member) whose landlord switched direct deposit
 * on sets up their OWN payout account — their manager fees, never the
 * landlord's rent, and no bank feed: the company's transactions are not theirs.
 * One step, so it is shown without the two-step framing.
 *
 * 10/19 (review): the comment above said that and the code did the opposite —
 * the step printed "Bank setup · step 1 of 2" and "so rent can reach your
 * bank", so a manager went looking for a step 2 that does not exist on their
 * page and for rent they do not collect. `ownAccount` is what makes it true.
 */
export function OwnPayoutAccount() {
  return (
    <div>
      <div style={{ fontSize: '.82rem', color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.5 }}>
        Your landlord has enabled direct deposit on your account. Verify your details below so your
        manager fees can be paid out. Once set up, every rent payment you&apos;re cut from will
        deposit to your bank automatically.
      </div>
      <PayoutVerifyStep entityId="" isOwner={false} ownAccount />
    </div>
  )
}

/**
 * /banking — the old Disbursement Account address. Kept working forever: a
 * landlord may have it bookmarked, and Blu does. Follows the S605 precedent
 * (/bank-feed and /bank-reconciliation redirect into /bank), and carries the
 * query string through so a to-do's ?entity=<company> still opens that company.
 */
export function BankSetupRedirect() {
  const { search } = useLocation()
  const params = new URLSearchParams(search)
  params.set('tab', 'setup')
  return <Navigate to={`/bank?${params.toString()}`} replace />
}
