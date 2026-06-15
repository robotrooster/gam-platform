import { useQuery } from 'react-query'
import { useAuth } from '../context/AuthContext'
import { apiGet } from '../lib/api'
import { Link } from 'react-router-dom'

interface Invitation { id: string; status: string; direction: string; propertyName: string; createdAt: string }
interface Payout { id: string; amount: string; status: string; arrivalDate: string | null }

export function DashboardPage() {
  const { activePmCompany } = useAuth()
  const cid = activePmCompany?.id

  const invitesQ = useQuery<Invitation[]>(
    ['pm-invitations', cid],
    () => apiGet<Invitation[]>(`/pm/companies/${cid}/property-invitations`),
    { enabled: !!cid },
  )
  const payoutsQ = useQuery<Payout[]>(
    ['pm-payouts', cid],
    () => apiGet<Payout[]>(`/pm/companies/${cid}/payouts?limit=5`),
    { enabled: !!cid },
  )

  const pendingIncoming = (invitesQ.data ?? []).filter(i => i.direction === 'owner_to_pm' && i.status === 'pending')
  const pendingOutgoing = (invitesQ.data ?? []).filter(i => i.direction === 'pm_to_owner' && i.status === 'pending')

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem', color: 'var(--text-0)' }}>{activePmCompany?.name ?? 'Dashboard'}</h1>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginTop: 4 }}>
          Multi-owner portfolio overview
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 24 }}>
        <KpiCard label="Pending invitations from owners" value={pendingIncoming.length}
                 to="/invitations" tone={pendingIncoming.length > 0 ? 'gold' : 'neutral'} />
        <KpiCard label="Outgoing invites awaiting reply" value={pendingOutgoing.length}
                 to="/invitations" tone="neutral" />
        <KpiCard label="Recent payouts" value={(payoutsQ.data ?? []).length}
                 to="/banking" tone="neutral" />
      </div>

      {pendingIncoming.length > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ fontWeight: 600, color: 'var(--text-0)', marginBottom: 8 }}>
            Action required
          </div>
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)', marginBottom: 12 }}>
            {pendingIncoming.length} owner{pendingIncoming.length === 1 ? '' : 's'} {pendingIncoming.length === 1 ? 'has' : 'have'} invited
            you to manage {pendingIncoming.length === 1 ? 'a property' : 'properties'}.
          </div>
          <Link to="/invitations" className="btn btn-primary btn-sm">Review invitations</Link>
        </div>
      )}

      {/* S484: agent-activity preview. Auto-hides on zero traffic. */}
      <AgentActivityCard pmCompanyId={cid} />

      <div className="card" style={{ padding: 16 }}>
        <div style={{ fontWeight: 600, color: 'var(--text-0)', marginBottom: 12 }}>Getting started</div>
        <ol style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.7, paddingLeft: 18 }}>
          <li>Set up <Link to="/banking" style={{ color: 'var(--gold)' }}>banking</Link> via Stripe Connect (required before you can accept management invitations).</li>
          <li>Create your <Link to="/fee-plans" style={{ color: 'var(--gold)' }}>fee plans</Link> — the rate sheets you offer landlords.</li>
          <li>Invite <Link to="/staff" style={{ color: 'var(--gold)' }}>staff</Link> with role-appropriate access.</li>
          <li>Send property invitations to landlords, or accept incoming ones, from <Link to="/invitations" style={{ color: 'var(--gold)' }}>Property Invites</Link>.</li>
        </ol>
      </div>
    </div>
  )
}

// S484: agent-activity preview on the PM-company dashboard. Mirrors
// the S482 landlord dashboard card; uses the PM-scoped endpoint.
// Auto-hides when the PM company has no agent traffic yet across its
// managed landlord portfolio.
function AgentActivityCard({ pmCompanyId }: { pmCompanyId?: string }) {
  const { data, isLoading } = useQuery<{
    totals: {
      total: number
      tenant_count: number
      landlord_count: number
      escalated_count: number
    }
    by_agent: Array<{ agent_name: string; count: number }>
  }>(
    ['pm-dash-agent-activity', pmCompanyId],
    () => apiGet(`/pm/${pmCompanyId}/agent-activity?days=30`),
    { enabled: !!pmCompanyId, retry: false },
  )

  if (isLoading || !data) return null
  if (data.totals.total === 0) return null

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>
            Agent activity
          </div>
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>
            Across managed properties · last 30 days
          </div>
        </div>
        <Link to="/agent-activity" className="btn btn-ghost btn-sm">
          View all →
        </Link>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 12,
      }}>
        <div>
          <div style={{ fontSize: '.7rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
            Conversations
          </div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--gold)' }}>
            {data.totals.total}
          </div>
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
            {data.totals.tenant_count} tenant · {data.totals.landlord_count} owner
          </div>
        </div>
        <div>
          <div style={{ fontSize: '.7rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
            Escalated
          </div>
          <div style={{
            fontSize: '1.5rem', fontWeight: 700,
            color: data.totals.escalated_count > 0 ? 'var(--amber)' : 'var(--text-1)',
          }}>
            {data.totals.escalated_count}
          </div>
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
            {data.totals.total > 0
              ? `${Math.round((data.totals.escalated_count / data.totals.total) * 100)}% of total`
              : '—'}
          </div>
        </div>
        <div>
          <div style={{ fontSize: '.7rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
            Top agent
          </div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-0)' }}>
            {data.by_agent[0]?.agent_name ?? '—'}
          </div>
          <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
            {data.by_agent[0]
              ? `${data.by_agent[0].count} conversation${data.by_agent[0].count === 1 ? '' : 's'}`
              : 'no agent traffic'}
          </div>
        </div>
      </div>
    </div>
  )
}

function KpiCard({ label, value, to, tone }: { label: string; value: number; to: string; tone: 'gold' | 'neutral' }) {
  return (
    <Link to={to} style={{ textDecoration: 'none' }}>
      <div className="card" style={{
        padding: 16,
        borderColor: tone === 'gold' && value > 0 ? 'var(--gold)' : undefined,
      }}>
        <div style={{ fontSize: '.7rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
        <div style={{ fontSize: '1.8rem', fontWeight: 700, color: tone === 'gold' && value > 0 ? 'var(--gold)' : 'var(--text-0)', marginTop: 6 }}>
          {value}
        </div>
      </div>
    </Link>
  )
}
