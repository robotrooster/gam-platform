/**
 * S249: Tenant Payouts — Stripe Connect Express onboarding surface.
 *
 * The route exists so tenants who accrue outbound balances (sublessor
 * markup credits today; future products that pay tenants directly)
 * can complete Stripe Connect onboarding and receive transfers to
 * their bank.
 *
 * Conditional in tenant top nav: only appears once the user has a
 * stripe_connect_account_id (i.e., they've initiated onboarding at
 * least once). New sublessors land here from the SublessorCreditCard
 * "Set up payouts" button.
 *
 * Mirrors the landlord BankingPage Connect-onboarding section — same
 * `/api/stripe/connect/onboarding-session` + `/connect/status` calls,
 * the backend route doesn't role-gate so the same plumbing serves all
 * Connect-eligible roles.
 */

import { useState, useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { Landmark } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { loadConnectAndInitialize } from '@stripe/connect-js'
import type { StripeConnectInstance } from '@stripe/connect-js'
import {
  ConnectAccountOnboarding, ConnectComponentsProvider,
} from '@stripe/react-connect-js'

export function PayoutsPage() {
  const PUB_KEY = (import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [connectInstance, setConnectInstance] = useState<StripeConnectInstance | null>(null)
  const [initErr, setInitErr] = useState<string | null>(null)
  const qc = useQueryClient()

  // S321: response shape camelized by interceptor; reading camelCase now.
  const statusQ = useQuery<{
    connectAccountId: string | null
    exists: boolean
    chargesEnabled?: boolean
    payoutsEnabled?: boolean
    detailsSubmitted?: boolean
    requirementsCurrentlyDue?: string[]
  }>(
    'tenant-stripe-connect-status',
    () => apiGet('/stripe/connect/status?entity=user'),
    {
      refetchInterval: (data) =>
        showOnboarding && !(data?.payoutsEnabled && data?.detailsSubmitted)
          ? 3000 : false,
    },
  )

  const ready = !!statusQ.data?.payoutsEnabled && !!statusQ.data?.detailsSubmitted

  useEffect(() => {
    if (!showOnboarding) qc.invalidateQueries('tenant-stripe-connect-status')
  }, [showOnboarding, qc])

  const startOnboarding = async () => {
    setInitErr(null)
    try {
      if (!PUB_KEY) throw new Error('VITE_STRIPE_PUBLISHABLE_KEY is not configured.')
      const instance = await loadConnectAndInitialize({
        publishableKey: PUB_KEY,
        fetchClientSecret: async () => {
          const r = await apiPost<{ connectAccountId: string; clientSecret: string }>(
            '/stripe/connect/onboarding-session',
            { entity: 'user' },
          )
          return (r as any).data!.clientSecret
        },
      })
      setConnectInstance(instance)
      setShowOnboarding(true)
    } catch (e: any) {
      setInitErr(e?.response?.data?.error?.message || e?.message || 'Failed to start onboarding')
    }
  }

  const statusLabel = useMemo(() => {
    if (ready)                            return { tone: 'green', text: 'Ready' }
    if (statusQ.data?.exists)             return { tone: 'gold',  text: statusQ.data?.detailsSubmitted ? 'Verifying…' : 'Onboarding incomplete' }
    return { tone: 'gold', text: 'Not started' }
  }, [ready, statusQ.data])

  return (
    <div style={{ padding: '24px 32px', maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <Landmark size={22} color="var(--gold)" />
        <h1 style={{ fontSize: '1.4rem', fontWeight: 600, margin: 0 }}>Payouts</h1>
      </div>

      <div style={{ fontSize: '.82rem', color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.5 }}>
        Set up a payout account to withdraw money GAM owes you — currently used for sublease earnings
        when you sublease your unit at a markup over the master rent. Stripe handles the bank
        verification; GAM never sees your full account number.
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>Stripe Connect Account</div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 4 }}>
              {ready
                ? 'Payout account ready. Withdrawals from your sublease earnings will deposit to your linked bank.'
                : 'Complete Stripe onboarding to receive payouts.'}
            </div>
          </div>
          <span style={{
            padding: '4px 12px', borderRadius: 14, fontSize: '.74rem', fontWeight: 600,
            background: statusLabel.tone === 'green' ? 'rgba(38,167,90,.16)' : 'rgba(220,165,40,.16)',
            color: statusLabel.tone === 'green' ? 'var(--green, #2ea35a)' : 'var(--gold)',
            textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap',
          }}>{statusLabel.text}</span>
        </div>

        {(statusQ.data?.requirementsCurrentlyDue ?? []).length > 0 && (
          <div style={{ marginTop: 12, padding: 10, background: 'var(--bg-2)', borderRadius: 6, fontSize: '.74rem', color: 'var(--text-2)' }}>
            <strong style={{ color: 'var(--gold)' }}>Outstanding requirements:</strong>{' '}
            {(statusQ.data?.requirementsCurrentlyDue ?? []).join(', ')}
          </div>
        )}

        {!ready && !showOnboarding && (
          <div style={{ marginTop: 14 }}>
            <button className="btn btn-p" onClick={startOnboarding}>
              {statusQ.data?.exists ? 'Continue Onboarding' : 'Start Stripe Onboarding'}
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
            <button className="btn btn-g btn-sm" style={{ marginTop: 10 }}
                    onClick={() => setShowOnboarding(false)}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
