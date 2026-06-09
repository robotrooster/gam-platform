/**
 * Banking & Payouts.
 *
 * S159: Stripe Connect Express embedded onboarding wired up. The page
 * has three layers:
 *
 *   1. Cached state from pm_companies.connect_*_enabled (read via
 *      GET /pm/companies/:id) — what the webhook has confirmed.
 *   2. Live state from GET /pm/companies/:id/connect/account-status —
 *      a synchronous Stripe round-trip used during onboarding to
 *      surface progress before the webhook lands.
 *   3. Embedded onboarding component — Stripe-hosted KYC inside GAM's
 *      URL via Account Session clientSecret.
 *
 * Acceptance gate: pm_companies.connectPayoutsEnabled +
 * connectDetailsSubmitted must both be true before
 * acceptPropertyInvitation will allow an owner_to_pm management
 * invitation to flip to accepted.
 */

import { useState, useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { useAuth } from '../context/AuthContext'
import { apiGet, apiPost } from '../lib/api'
import { loadConnectAndInitialize } from '@stripe/connect-js'
import type { StripeConnectInstance } from '@stripe/connect-js'
import {
  ConnectAccountOnboarding, ConnectComponentsProvider,
} from '@stripe/react-connect-js'

interface PmCompany {
  id: string
  name: string
  bankAccountId: string | null
  status: string
  stripeConnectAccountId: string | null
  connectChargesEnabled: boolean
  connectPayoutsEnabled: boolean
  connectDetailsSubmitted: boolean
}

interface AccountStatus {
  hasAccount: boolean
  chargesEnabled: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  requirementsCurrentlyDue: string[]
}

interface Payout {
  id: string
  stripePayoutId: string | null
  amount: string
  currency: string
  status: string
  destinationBankLast4: string | null
  arrivalDate: string | null
  failureCode: string | null
  failureMessage: string | null
  createdAt: string
}

const PUB_KEY = (import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined

export function BankingPage() {
  const { activePmCompany } = useAuth()
  const cid = activePmCompany?.id
  const qc = useQueryClient()
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [connectInstance, setConnectInstance] = useState<StripeConnectInstance | null>(null)
  const [initErr, setInitErr] = useState<string | null>(null)

  const companyQ = useQuery<PmCompany>(
    ['pm-company', cid],
    () => apiGet<PmCompany>(`/pm/companies/${cid}`),
    { enabled: !!cid },
  )
  const liveStatusQ = useQuery<AccountStatus>(
    ['pm-connect-status', cid],
    () => apiGet<AccountStatus>(`/pm/companies/${cid}/connect/account-status`),
    {
      enabled: !!cid && !!companyQ.data?.stripeConnectAccountId,
      // Poll every 3s while onboarding is open so the UI catches
      // capability flips before the webhook lands. Falls back to no
      // polling once the account is ready or onboarding is closed.
      refetchInterval: (data) => (showOnboarding && !(data?.payoutsEnabled && data?.detailsSubmitted)) ? 3000 : false,
    },
  )
  const payoutsQ = useQuery<Payout[]>(
    ['pm-payouts', cid],
    () => apiGet<Payout[]>(`/pm/companies/${cid}/payouts?limit=50`),
    { enabled: !!cid },
  )

  // Cached row state — what the webhook last confirmed. The accept-time
  // guard reads these (NOT the live Stripe values).
  const cached = companyQ.data
  const cachedReady = !!cached?.connectPayoutsEnabled && !!cached?.connectDetailsSubmitted

  // Live Stripe state — used for onboarding-progress UI.
  const liveReady = !!liveStatusQ.data?.payoutsEnabled && !!liveStatusQ.data?.detailsSubmitted

  const startOnboarding = async () => {
    if (!cid) return
    setInitErr(null)
    try {
      if (!PUB_KEY) {
        throw new Error('VITE_STRIPE_PUBLISHABLE_KEY is not configured.')
      }
      const res = await apiPost<{ connectAccountId: string; clientSecret: string }>(
        `/pm/companies/${cid}/connect/onboarding-link`,
      )
      const clientSecret = res.data!.clientSecret

      const instance = await loadConnectAndInitialize({
        publishableKey: PUB_KEY,
        // The SDK calls fetchClientSecret each time it needs a fresh
        // session. We re-mint via the same endpoint.
        fetchClientSecret: async () => {
          if (!cid) throw new Error('No active PM company')
          const r = await apiPost<{ clientSecret: string }>(`/pm/companies/${cid}/connect/onboarding-link`)
          return r.data!.clientSecret
        },
      })

      // First mount uses the freshly minted secret already; setting state
      // triggers the embedded component below.
      void clientSecret
      setConnectInstance(instance)
      setShowOnboarding(true)
    } catch (e: any) {
      setInitErr(e?.response?.data?.error?.message || e?.message || 'Failed to start onboarding')
    }
  }

  // Refetch row state when onboarding closes so the cached badges
  // refresh from the webhook.
  useEffect(() => {
    if (!showOnboarding) {
      qc.invalidateQueries(['pm-company', cid])
      qc.invalidateQueries(['pm-connect-status', cid])
    }
  }, [showOnboarding, qc, cid])

  const statusLabel = useMemo(() => {
    if (cachedReady) return { tone: 'green', text: 'Ready' }
    if (liveReady)   return { tone: 'gold',  text: 'Verifying…' }
    if (cached?.stripeConnectAccountId) return { tone: 'gold', text: 'Onboarding incomplete' }
    return { tone: 'gold', text: 'Not started' }
  }, [cachedReady, liveReady, cached])

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem', color: 'var(--text-0)' }}>Banking & Payouts</h1>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
          Connect account, payout schedule, and history.
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>Stripe Connect Account</div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginTop: 4 }}>
              {cachedReady
                ? 'Banking ready. You can accept management invitations.'
                : 'KYC must complete via Stripe before you can accept management (owner_to_pm) invitations.'}
            </div>
          </div>
          <span style={{
            padding: '4px 12px', borderRadius: 14, fontSize: '.74rem', fontWeight: 600,
            background: statusLabel.tone === 'green' ? 'rgba(38,167,90,.16)' : 'rgba(220,165,40,.16)',
            color: statusLabel.tone === 'green' ? 'var(--green, #2ea35a)' : 'var(--gold)',
            textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap',
          }}>
            {statusLabel.text}
          </span>
        </div>

        {liveStatusQ.data?.requirementsCurrentlyDue && liveStatusQ.data.requirementsCurrentlyDue.length > 0 && (
          <div style={{ marginTop: 12, padding: 10, background: 'var(--bg-2)', borderRadius: 6, fontSize: '.74rem', color: 'var(--text-2)' }}>
            <strong style={{ color: 'var(--gold)' }}>Outstanding requirements:</strong>{' '}
            {liveStatusQ.data.requirementsCurrentlyDue.join(', ')}
          </div>
        )}

        {!cachedReady && !showOnboarding && (
          <div style={{ marginTop: 14 }}>
            <button className="btn btn-primary" onClick={startOnboarding}>
              {cached?.stripeConnectAccountId ? 'Continue Onboarding' : 'Start Stripe Onboarding'}
            </button>
            {initErr && (
              <div style={{ marginTop: 8, fontSize: '.74rem', color: 'var(--red, #dc4c4c)' }}>{initErr}</div>
            )}
          </div>
        )}

        {showOnboarding && connectInstance && (
          <div style={{ marginTop: 16 }}>
            <ConnectComponentsProvider connectInstance={connectInstance}>
              <ConnectAccountOnboarding
                onExit={() => setShowOnboarding(false)}
              />
            </ConnectComponentsProvider>
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 10 }}
                    onClick={() => setShowOnboarding(false)}>
              Close
            </button>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-0)', fontWeight: 600, color: 'var(--text-0)' }}>
          Payouts
        </div>
        {payoutsQ.isLoading ? (
          <div style={{ padding: 16, color: 'var(--text-3)' }}>Loading…</div>
        ) : (payoutsQ.data ?? []).length === 0 ? (
          <div style={{ padding: 16, color: 'var(--text-3)', fontSize: '.84rem' }}>No payouts yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-2)' }}>
                <Th>Date</Th><Th>Amount</Th><Th>Status</Th><Th>Bank</Th><Th>Arrival</Th>
              </tr>
            </thead>
            <tbody>
              {(payoutsQ.data ?? []).map(p => (
                <tr key={p.id} style={{ borderTop: '1px solid var(--border-0)' }}>
                  <Td>{new Date(p.createdAt).toLocaleDateString()}</Td>
                  <Td>${Number(p.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {p.currency.toUpperCase()}</Td>
                  <Td>{p.status}</Td>
                  <Td>{p.destinationBankLast4 ? `•••• ${p.destinationBankLast4}` : '—'}</Td>
                  <Td>{p.arrivalDate ? new Date(p.arrivalDate).toLocaleDateString() : '—'}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)', fontWeight: 600 }}>{children}</th>
)
const Td = ({ children }: { children: React.ReactNode }) => (
  <td style={{ padding: '12px 14px', fontSize: '.84rem', color: 'var(--text-1)' }}>{children}</td>
)
