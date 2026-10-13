/**
 * Disbursement Account — where a landlord (or a manager with direct deposit)
 * gets paid: Stripe's "Verify your business & get paid" setup and its status.
 *
 * 10/12 (Nic): "Remove the old form." This page also carried the S66 manual
 * "Add Bank Account" form, its list and archive buttons — GAM's own bank
 * catalog from before Stripe Connect. Payouts run only through Connect
 * (jobs/autoPayouts.ts pays the Connect account and never reads that catalog),
 * so a bank typed in there set up nothing and never reached Stripe. Country
 * Acres' owner did exactly that on 10/5 and waited for microdeposits that
 * could never come. The form, list and archive buttons are gone; the API
 * refuses new entries (routes/bankAccounts.ts) and keeps the existing rows.
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { useSearchParams } from 'react-router-dom'
import { Landmark } from 'lucide-react'
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

export function BankingPage() {
  const { user } = useAuth()

  // S168: managers landing on /banking after the landlord enabled their
  // direct deposit toggle onboard their OWN Connect account for manager fees.
  const isManager = user?.role === 'property_manager'

  return (
    <div style={{ padding: '24px 32px', maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <Landmark size={22} color="var(--gold)" />
        <h1 style={{ fontSize: '1.4rem', fontWeight: 600, margin: 0 }}>Disbursement Account</h1>
      </div>
      {isManager && (
        <div style={{ fontSize: '.82rem', color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.5 }}>
          Your landlord has enabled direct deposit on your account. Link your
          bank account below so your manager fees can be paid out. Once set up,
          every rent payment you're cut from will deposit to your bank
          automatically.
        </div>
      )}
      <StripeConnectSection />
    </div>
  )
}

// S160: Stripe Connect Express embedded onboarding for landlords. Mirrors
// the PM portal BankingPage pattern. Uses the existing shared endpoints at
// /api/stripe/connect/onboarding-session (entity='user') and
// /api/stripe/connect/status?entity=user.
function StripeConnectSection() {
  const PUB_KEY = (import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [connectInstance, setConnectInstance] = useState<StripeConnectInstance | null>(null)
  const [initErr, setInitErr] = useState<string | null>(null)
  const qc = useQueryClient()
  const { user } = useAuth()

  // S554 Connect re-anchor: an OWNER landlord onboards the landlord ENTITY's
  // own account (entity='landlord', entityId = their landlords.id = profileId).
  // Scoped WORKERS (managers with a direct-deposit opt-in) still onboard their
  // OWN user account (entity='user') — switching them would 403 on the live
  // membership check and break manager direct deposit.
  const isOwner = user?.role === 'landlord'
  // S629 (Nic): this was pinned to profileId, so a landlord with two LLCs saw
  // and onboarded exactly one of them — the other could never link a bank at
  // all. Banking is per entity, so the entity is a choice on this page.
  //
  // 10/12 (Nic): it still STARTED on user.profileId, which /auth/me fills with
  // the account's OLDEST company. Blu co-owns Oak Park (8/14, paid) and owns
  // TruBlu Management LLC (8/28, Country Acres, no Stripe account), so this
  // page opened on Oak Park and told the Country Acres owner "Ready — you're
  // all set", with no button to set TruBlu up. It starts on no company (S654:
  // none is the default) and lands on one only for a reason: the company a
  // to-do or banner linked to (?entity=), or the ONE company with a property
  // that can't be paid yet. A single-company account is chosen by EntityPicker.
  const [searchParams] = useSearchParams()
  const linkedEntity = searchParams.get('entity') ?? ''
  const [entityId, setEntityId] = useState<string>('')
  const { data: entityList = [] } = useEntities()
  const entities = entityList as PayoutCompany[]
  const unpaid = companiesMissingPayouts(entities)
  // Once, when the list arrives — after that the picker is the owner's.
  const landed = useRef(false)
  useEffect(() => {
    if (landed.current || !isOwner || entityId || entities.length < 2) return
    landed.current = true
    if (linkedEntity && entities.some(e => e.id === linkedEntity)) setEntityId(linkedEntity)
    else if (unpaid.length === 1) setEntityId(unpaid[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner, entityId, entities, linkedEntity])
  // Another company with a property still can't be paid — say so even while
  // a paid one is on screen, so "all set" never reads as the whole account.
  const otherUnpaid = unpaid.filter(e => e.id !== entityId)
  const connectEntity = isOwner ? 'landlord' : 'user'
  const connectEntityQS = isOwner ? `entity=landlord&entityId=${entityId}` : 'entity=user'
  const connectOnboardBody = isOwner
    ? { entity: 'landlord', entityId }
    : { entity: 'user' }

  const statusQ = useQuery<{
    connectAccountId: string | null
    exists: boolean
    chargesEnabled?: boolean
    payoutsEnabled?: boolean
    detailsSubmitted?: boolean
    requirementsCurrentlyDue?: string[]
    payoutBank?: { bankName: string | null; last4: string | null } | null
  }>(
    ['stripe-connect-status', connectEntity, entityId],
    () => apiGet(`/stripe/connect/status?${connectEntityQS}`),
    {
      // ── S637: DO NOT ASK ABOUT AN ENTITY WE HAVE NOT CHOSEN YET ────────
      //
      // Nic, watching a co-owner: "he clicks the connect to bank button and it
      // says you own more than one company, choose what record this belongs
      // to. It doesn't let him try to add a bank. The adding a bank button
      // does nothing right now."
      //
      // entityId starts as user.profileId, and since S633 a landlord's
      // profileId is NULL — an account is not an entity. So the very first
      // render asked for `entity=landlord&entityId=` with nothing after the
      // equals, and the API answered, correctly, that it could not tell which
      // company was meant. That error rendered before EntityPicker below had
      // resolved and chosen one.
      //
      // Nic's own Oak Park bank linked fine because he had exactly ONE company
      // on 14 August; Mountain View was created on the 28th. A single entity
      // needs no disambiguation, so the empty id never mattered until a second
      // company existed.
      enabled: !isOwner || !!entityId,
      refetchInterval: (data) =>
        showOnboarding && !(data?.payoutsEnabled && data?.detailsSubmitted)
          ? 3000 : false,
    },
  )

  const ready = !!statusQ.data?.payoutsEnabled && !!statusQ.data?.detailsSubmitted

  useEffect(() => {
    if (!showOnboarding) qc.invalidateQueries('stripe-connect-status')
  }, [showOnboarding, qc])

  const startOnboarding = async () => {
    setInitErr(null)
    try {
      // Say which company is missing rather than posting an empty id and
      // letting the server answer with a question the button cannot ask.
      if (isOwner && !entityId) {
        throw new Error('Choose which company this bank account belongs to first.')
      }
      if (!PUB_KEY) throw new Error('VITE_STRIPE_PUBLISHABLE_KEY is not configured.')
      const instance = await loadConnectAndInitialize({
        publishableKey: PUB_KEY,
        fetchClientSecret: async () => {
          const r = await apiPost<{ connectAccountId: string; clientSecret: string }>(
            '/stripe/connect/onboarding-session',
            connectOnboardBody,
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

  const noCompanyChosen = isOwner && !entityId
  const statusLabel = useMemo(() => {
    if (ready)                            return { tone: 'green', text: 'Ready' }
    if (statusQ.data?.exists)             return { tone: 'gold',  text: statusQ.data?.detailsSubmitted ? 'Verifying…' : 'Onboarding incomplete' }
    return { tone: 'gold', text: 'Not started' }
  }, [ready, statusQ.data])

  return (
    <div className="card" style={{ padding: 16, marginBottom: 18 }}>
      {/* S629: which LLC is being verified and paid. Every figure and every
          status below belongs to the entity selected here — and with one
          entity it renders nothing, so the common case is unchanged. */}
      {isOwner && <EntityPicker value={entityId} onChange={setEntityId} label="Paying out for" />}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          {/* S605 (Nic): this said "Bank Account" / "Link your bank account",
              so landlords expected a routing-number form and were blindsided by
              Stripe asking for an EIN, a date of birth and an SSN. Naming it
              honestly up front is the whole fix — "if I don't know how to do
              what I need to do, that's where the friction lives." */}
          <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>Verify your business &amp; get paid</div>
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 4 }}>
            {noCompanyChosen
              ? 'Choose the company above to see its payout status and set it up.'
              : ready
              ? (statusQ.data?.payoutBank?.last4
                  ? `You're all set. Rent deposits to ${statusQ.data.payoutBank.bankName ?? 'your bank'} ••${statusQ.data.payoutBank.last4}.`
                  : "You're all set. Rent deposits to the account you gave Stripe.")
              : 'Required before tenants can pay rent. Stripe (our payments partner) verifies who you are, then you add the account rent gets deposited into.'}
          </div>
        </div>
        {!noCompanyChosen && (
        <span style={{
          padding: '4px 12px', borderRadius: 14, fontSize: '.74rem', fontWeight: 600,
          background: statusLabel.tone === 'green' ? 'rgba(38,167,90,.16)' : 'rgba(220,165,40,.16)',
          color: statusLabel.tone === 'green' ? 'var(--green, #2ea35a)' : 'var(--gold)',
          textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap',
        }}>{statusLabel.text}</span>
        )}
      </div>

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

      {!ready && !showOnboarding && (
        <div style={{ marginTop: 14 }}>
          {/* Gathering an EIN mid-form is where people abandon. Say what to have
              to hand BEFORE the form opens. */}
          <div style={{ padding: 12, background: 'var(--bg-2)', borderRadius: 8, marginBottom: 12 }}>
            <div style={{ fontSize: '.76rem', fontWeight: 600, color: 'var(--text-1)', marginBottom: 6 }}>
              Have these ready — it takes about 10 minutes:
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: '.76rem', color: 'var(--text-2)', lineHeight: 1.7 }}>
              <li>Your business legal name and <strong>EIN</strong> (or your SSN if you operate as an individual)</li>
              <li>Business address and phone</li>
              <li>Your date of birth, home address, and the last 4 of your SSN — Stripe verifies a real person is behind the account</li>
              <li>The <strong>routing and account number</strong> rent should be deposited into</li>
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
          <button className="btn btn-primary" onClick={startOnboarding}
            disabled={isOwner && !entityId}>
            {/* S637 (Nic): "I'd relabel the one to connect feed, and then the
                other one would be connect account. That way, they see what's
                going on."
                Two people in a row linked the read-only transaction FEED when
                they meant to set up payouts, because both screens said
                "connect a bank" and only one moves money. The feed button now
                says Connect feed; this one names the account rent lands in. */}
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
    </div>
  )
}

