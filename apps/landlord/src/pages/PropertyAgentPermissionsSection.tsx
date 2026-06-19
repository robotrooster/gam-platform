import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPatch } from '../lib/api'

// Per-property opt-in for revenue-affecting agent actions. Default OFF.
// This is the property-settings surface for the same gate the in-chat
// `set_agent_permission` tool writes (S498 foundation → S501 settings UI).
//
// Only the capabilities the agent can actually act on are surfaced.
// `take_payment` is intentionally omitted — it is reframed to ACH-setup
// guidance today and has no agent action behind it, so exposing a toggle
// for it would mislead. It stays in the shared enum for the future.
const LIVE_CAPABILITIES = [
  {
    key: 'lease_renewal',
    label: 'Process a renewal',
    description:
      'Let the agent record a tenant’s intent to renew and notify you. The agent never changes lease terms — you finalize every renewal.',
  },
  {
    key: 'bill_fee',
    label: 'Bill a fee',
    description:
      'Let the agent bill a one-off fee against a tenant’s lease (e.g. a violation or early-termination fee) when you ask it to.',
  },
] as const

type PermMap = Record<string, boolean>

export function PropertyAgentPermissionsSection({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const { data, isLoading } = useQuery<PermMap>(
    ['property-agent-permissions', propertyId],
    () => apiGet<PermMap>(`/properties/${propertyId}/agent-permissions`),
  )

  const mutation = useMutation(
    (vars: { capability: string; enabled: boolean }) =>
      apiPatch(`/properties/${propertyId}/agent-permissions`, vars),
    {
      onMutate: () => setError(null),
      onError: (e: any) => setError(e?.message ?? 'Failed to update'),
      onSuccess: () => qc.invalidateQueries(['property-agent-permissions', propertyId]),
    },
  )

  return (
    <div className="card" style={{ padding: 0, marginTop: 24 }}>
      <div style={{ padding: 16, borderBottom: '1px solid var(--border-0)' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.05rem', color: 'var(--text-0)' }}>
          AI Agent Permissions
        </h2>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
          Control what the AI assistant is allowed to do on this property. Everything is off by default — turn on only what you want the agent to handle.
        </div>
      </div>

      {error && (
        <div style={{ padding: 12, background: 'rgba(239,68,68,.06)', borderBottom: '1px solid rgba(239,68,68,.2)', color: 'var(--red)', fontSize: '.85rem' }}>{error}</div>
      )}

      {isLoading ? (
        <div style={{ padding: 24, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
      ) : (
        LIVE_CAPABILITIES.map((cap, i) => {
          const enabled = data?.[cap.key] === true
          return (
            <div
              key={cap.key}
              style={{
                padding: 16,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 16,
                justifyContent: 'space-between',
                borderBottom: i < LIVE_CAPABILITIES.length - 1 ? '1px solid var(--border-0)' : 'none',
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '.9rem', fontWeight: 600, color: 'var(--text-0)' }}>{cap.label}</div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4, maxWidth: 520 }}>{cap.description}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={cap.label}
                disabled={mutation.isLoading}
                onClick={() => mutation.mutate({ capability: cap.key, enabled: !enabled })}
                style={{
                  flexShrink: 0,
                  width: 44,
                  height: 24,
                  borderRadius: 999,
                  border: 'none',
                  cursor: mutation.isLoading ? 'default' : 'pointer',
                  background: enabled ? 'var(--gold)' : 'var(--border-1)',
                  position: 'relative',
                  transition: 'background .15s',
                  opacity: mutation.isLoading ? 0.6 : 1,
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: enabled ? 22 : 2,
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    background: '#fff',
                    transition: 'left .15s',
                  }}
                />
              </button>
            </div>
          )
        })
      )}
    </div>
  )
}
