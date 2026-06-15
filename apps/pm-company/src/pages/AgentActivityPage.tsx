import { useState } from 'react'
import { useQuery } from 'react-query'
import { Bot, MessageCircle, AlertTriangle, Zap, Wrench as WrenchIcon } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { apiGet } from '../lib/api'

interface OutcomeRow { outcome: string; count: number }
interface AgentRow   { agent_name: string; count: number }
interface ToolRow    { tool: string; count: number }

interface SummaryData {
  days: number
  totals: {
    total: number
    tenant_count: number
    landlord_count: number
    escalated_count: number
    grounded_count: number
    avg_latency_ms: number | null
  }
  by_outcome: OutcomeRow[]
  by_agent:   AgentRow[]
  by_tool:    ToolRow[]
}

interface RecentRow {
  id: string
  conversationId: string
  turnIndex: number
  agentName: string
  audience: 'tenant' | 'landlord' | 'prospect'
  handledByTier: 'entry' | 'escalation' | 'human'
  outcome: string
  landlordId: string
  actorRole: string
  escalationCount: number
  escalatedToHuman: boolean
  toolNames: string[]
  toolInvocationCount: number
  latencyMs: number | null
  grounded: boolean | null
  createdAt: string
}

const OUTCOME_LABEL: Record<string, string> = {
  answered_entry:       'Answered (entry)',
  answered_escalation:  'Answered (senior)',
  action_taken:         'Action taken',
  escalated_to_human:   'Escalated to human',
  fast_path_faq:        'FAQ fast-path',
  error:                'Error',
  shed:                 'Shed (high volume)',
}

function fmtOutcome(o: string): string {
  return OUTCOME_LABEL[o] ?? o.replace(/_/g, ' ')
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const now = Date.now()
  const diffMin = Math.floor((now - d.getTime()) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  const diffD = Math.floor(diffH / 24)
  if (diffD < 7) return `${diffD}d ago`
  return d.toLocaleDateString()
}

export function AgentActivityPage() {
  const { activePmCompany } = useAuth()
  const cid = activePmCompany?.id
  const [days, setDays] = useState(30)
  const [outcomeFilter, setOutcomeFilter] = useState<string>('')

  const { data: summary, isLoading } = useQuery<SummaryData>(
    ['pm-agent-activity-summary', cid, days],
    () => apiGet<SummaryData>(`/pm/${cid}/agent-activity?days=${days}`),
    { enabled: !!cid },
  )

  const { data: recent = [] } = useQuery<RecentRow[]>(
    ['pm-agent-activity-recent', cid, outcomeFilter],
    () => apiGet<RecentRow[]>(
      `/pm/${cid}/agent-activity/recent?limit=50${outcomeFilter ? `&outcome=${outcomeFilter}` : ''}`),
    { enabled: !!cid },
  )

  if (!cid) {
    return (
      <div style={{ padding: 24 }}>
        <div className="card" style={{ padding: 16, color: 'var(--text-3)' }}>
          Select an active PM company to view agent activity.
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10, fontSize: '1.4rem', color: 'var(--text-0)' }}>
            <Bot size={22} /> Agent Activity
          </h1>
          <p style={{ fontSize: '.82rem', color: 'var(--text-3)', maxWidth: 720, marginTop: 4 }}>
            Conversations between tenants / owners and the GAM
            customer-service agents across the properties this PM
            company manages. Metadata only — verbatim conversation
            text is admin-only.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={`btn btn-sm ${days === d ? 'btn-primary' : 'btn-ghost'}`}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* KPI tiles */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 12, marginBottom: 20,
      }}>
        <KpiTile
          icon={<MessageCircle size={16} />}
          label="Conversations"
          value={summary?.totals.total ?? 0}
        />
        <KpiTile
          icon={<MessageCircle size={16} />}
          label="From tenants"
          value={summary?.totals.tenant_count ?? 0}
        />
        <KpiTile
          icon={<AlertTriangle size={16} />}
          label="Escalated to human"
          value={summary?.totals.escalated_count ?? 0}
          accent={(summary?.totals.escalated_count ?? 0) > 0 ? 'amber' : 'gold'}
        />
        <KpiTile
          icon={<Zap size={16} />}
          label="Avg latency"
          value={
            summary?.totals.avg_latency_ms != null
              ? `${(summary.totals.avg_latency_ms / 1000).toFixed(1)}s`
              : '—'
          }
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 24 }}>
        <BreakdownCard
          title="By outcome"
          rows={summary?.by_outcome ?? []}
          labelKey="outcome"
          labelFormatter={fmtOutcome}
          onRowClick={(label) => setOutcomeFilter(label === outcomeFilter ? '' : label)}
          activeRow={outcomeFilter}
        />
        <BreakdownCard
          title="By agent"
          rows={summary?.by_agent ?? []}
          labelKey="agent_name"
        />
        <BreakdownCard
          title="Top tools"
          rows={summary?.by_tool ?? []}
          labelKey="tool"
          icon={<WrenchIcon size={11} />}
        />
      </div>

      {/* Recent conversations */}
      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: '.95rem' }}>Recent activity</h3>
          {outcomeFilter && (
            <button onClick={() => setOutcomeFilter('')}
              className="btn btn-sm btn-ghost">
              Clear filter: {fmtOutcome(outcomeFilter)}
            </button>
          )}
        </div>
        {isLoading ? (
          <div style={{ color: 'var(--text-3)', fontSize: '.85rem' }}>Loading…</div>
        ) : recent.length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: '.85rem', padding: 12 }}>
            No agent conversations yet{outcomeFilter ? ` matching "${fmtOutcome(outcomeFilter)}"` : ''}.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-0)' }}>
                <th style={th}>Agent</th>
                <th style={th}>Audience</th>
                <th style={th}>Outcome</th>
                <th style={th}>Tools</th>
                <th style={th}>Latency</th>
                <th style={th}>When</th>
              </tr>
            </thead>
            <tbody>
              {recent.map(r => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                  <td style={td}>
                    <strong>{r.agentName}</strong>
                    {r.handledByTier === 'escalation' && (
                      <span style={{ fontSize: 10, marginLeft: 6, color: 'var(--amber)' }}>SR</span>
                    )}
                  </td>
                  <td style={td}>{r.audience}</td>
                  <td style={td}>
                    {fmtOutcome(r.outcome)}
                    {r.escalatedToHuman && (
                      <AlertTriangle size={11} style={{ marginLeft: 4, color: 'var(--amber)' }} />
                    )}
                  </td>
                  <td style={td}>
                    {r.toolInvocationCount > 0 ? (
                      <span style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>
                        {r.toolNames.slice(0, 2).join(', ')}
                        {r.toolNames.length > 2 && ` +${r.toolNames.length - 2}`}
                      </span>
                    ) : <span style={{ color: 'var(--text-3)' }}>—</span>}
                  </td>
                  <td style={td}>
                    {r.latencyMs != null ? `${(r.latencyMs / 1000).toFixed(1)}s` : '—'}
                  </td>
                  <td style={{ ...td, color: 'var(--text-2)' }}>{fmtTime(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function KpiTile({
  icon, label, value, accent = 'gold',
}: { icon: React.ReactNode; label: string; value: number | string; accent?: 'gold' | 'amber' }) {
  const color = accent === 'amber' ? 'var(--amber)' : 'var(--gold)'
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: '.7rem', color: 'var(--text-3)',
        textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4,
      }}>
        {icon}
        {label}
      </div>
      <div style={{ fontSize: '1.75rem', fontWeight: 700, color }}>
        {value}
      </div>
    </div>
  )
}

function BreakdownCard<T extends Record<string, any>>({
  title, rows, labelKey, labelFormatter, onRowClick, activeRow, icon,
}: {
  title: string
  rows: T[]
  labelKey: keyof T
  labelFormatter?: (s: string) => string
  onRowClick?: (label: string) => void
  activeRow?: string
  icon?: React.ReactNode
}) {
  const total = rows.reduce((acc, r) => acc + (r.count as number), 0)
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{
        fontSize: '.7rem', color: 'var(--text-3)',
        textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10,
      }}>{title}</div>
      {rows.length === 0 ? (
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>—</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r, i) => {
            const raw = String(r[labelKey])
            const label = labelFormatter ? labelFormatter(raw) : raw
            const pct = total > 0 ? Math.round((r.count / total) * 100) : 0
            const active = activeRow === raw
            return (
              <div key={i}
                onClick={onRowClick ? () => onRowClick(raw) : undefined}
                style={{
                  display: 'flex', alignItems: 'center',
                  fontSize: '.78rem',
                  cursor: onRowClick ? 'pointer' : 'default',
                  background: active ? 'rgba(201,162,39,.08)' : undefined,
                  padding: '4px 6px', borderRadius: 4,
                }}>
                <div style={{ flex: 1, color: active ? 'var(--gold)' : 'var(--text-1)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  {icon}
                  {label}
                </div>
                <div style={{ width: 50, textAlign: 'right', color: 'var(--text-2)' }}>
                  {r.count}
                </div>
                <div style={{ width: 40, textAlign: 'right', color: 'var(--text-3)', fontSize: '.7rem' }}>
                  {pct}%
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  fontSize: '.7rem',
  color: 'var(--text-3)',
  textTransform: 'uppercase',
  letterSpacing: '.05em',
  fontWeight: 600,
}
const td: React.CSSProperties = {
  padding: '10px',
  color: 'var(--text-1)',
}
