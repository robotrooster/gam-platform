import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { apiGet, apiPatch } from '../lib/api'
import { PERMISSION_CATALOG, PERMISSION_PRESETS, LandlordAssignableRole } from '@gam/shared'

// Dedicated per-user permissions page. The landlord composes exactly what a
// staff member can see + do by toggling catalog keys — no role bundles. Renders
// PERMISSION_CATALOG (single source of truth) as grouped toggles; each flip
// full-replaces the user's permissions jsonb via the scopes endpoint. Property
// scope lives on the Team row's scope picker for now (folds in here later).
interface Member {
  userId: string
  role: LandlordAssignableRole
  email: string
  firstName: string
  lastName: string
  permissions: Record<string, any>
}

export function StaffPermissionsPage() {
  const { userId } = useParams<{ userId: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const { data, isLoading } = useQuery<{ members: Member[] }>('team', () => apiGet('/scopes/team'))
  const member = data?.members.find(m => m.userId === userId)

  const [perms, setPerms] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (member) setPerms(Object.fromEntries(Object.entries(member.permissions || {}).map(([k, v]) => [k, v === true])))
  }, [member?.userId])

  const save = useMutation(
    (next: Record<string, boolean>) =>
      apiPatch(`/scopes/${member!.role}/${member!.userId}/permissions`, { permissions: next }),
    { onSuccess: () => qc.invalidateQueries('team') }
  )

  const toggle = (key: string) => {
    const next = { ...perms, [key]: !perms[key] }
    setPerms(next)
    save.mutate(next)
  }

  const setGroup = (keys: string[], on: boolean) => {
    const next = { ...perms }
    keys.forEach(k => { next[k] = on })
    setPerms(next)
    save.mutate(next)
  }

  if (isLoading) return <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
  if (!member) return (
    <div className="card" style={{ padding: 32, textAlign: 'center' }}>
      <div style={{ color: 'var(--text-2)', marginBottom: 12 }}>Staff member not found, or their invite hasn't been accepted yet.</div>
      <button className="btn btn-ghost" onClick={() => navigate('/team')}>← Back to Team</button>
    </div>
  )

  const enabledCount = Object.values(perms).filter(Boolean).length

  return (
    <div>
      <div className="page-header">
        <div>
          <button onClick={() => navigate('/team')} className="btn btn-ghost btn-sm" style={{ marginBottom: 8 }}>← Team</button>
          <h1 className="page-title">{member.firstName} {member.lastName}</h1>
          <p className="page-subtitle">{member.email} · {enabledCount} permission{enabledCount === 1 ? '' : 's'} granted</p>
        </div>
      </div>

      <div style={{ fontSize: '.8rem', color: 'var(--text-3)', marginBottom: 16, lineHeight: 1.5, maxWidth: 720 }}>
        Turn on exactly what this person can see and do. Everything is off by default —
        they only get what you grant. Changes save instantly.
      </div>

      {/* Presets — one-click bundles that flip a set of toggles ON. Not roles;
          the owner can fine-tune every toggle afterward. */}
      <div className="card" style={{ padding: 14, marginBottom: 16 }}>
        <div style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 10 }}>
          Quick presets
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {PERMISSION_PRESETS.map(preset => (
            <button
              key={preset.id}
              className="btn btn-ghost btn-sm"
              disabled={save.isLoading}
              title={preset.description}
              onClick={() => setGroup(preset.keys, true)}
              style={{ textAlign: 'left', border: '1px solid var(--border-1)', borderRadius: 8, padding: '8px 12px', maxWidth: 320 }}
            >
              <div style={{ fontWeight: 600, fontSize: '.85rem', color: 'var(--gold)' }}>+ {preset.label}</div>
              <div style={{ fontSize: '.7rem', color: 'var(--text-3)', lineHeight: 1.4, whiteSpace: 'normal' }}>{preset.description}</div>
            </button>
          ))}
        </div>
      </div>

      {PERMISSION_CATALOG.map(group => {
        const groupKeys = group.sections.flatMap(s => s.items.map(i => i.key))
        const allOn = groupKeys.every(k => perms[k])
        return (
          <div key={group.category} className="card" style={{ padding: 0, marginBottom: 16, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--border-1)' }}>
              <div style={{ fontWeight: 700, fontSize: '.95rem' }}>{group.label}</div>
              <button
                className="btn btn-ghost btn-sm"
                style={{ fontSize: '.74rem' }}
                onClick={() => setGroup(groupKeys, !allOn)}
                disabled={save.isLoading}
              >
                {allOn ? 'Turn all off' : 'Turn all on'}
              </button>
            </div>
            <div style={{ padding: 16 }}>
              {group.sections.map(section => (
                <div key={section.label} style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: '.7rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>
                    {section.label}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 6 }}>
                    {section.items.map(item => (
                      <label key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.83rem', color: 'var(--text-1)', cursor: 'pointer', padding: '4px 0' }}>
                        <input
                          type="checkbox"
                          checked={!!perms[item.key]}
                          onChange={() => toggle(item.key)}
                          disabled={save.isLoading}
                        />
                        <span>{item.label}</span>
                        {item.sensitive && (
                          <span style={{ fontSize: '.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--gold)', background: 'rgba(201,162,39,.12)', border: '1px solid rgba(201,162,39,.3)', borderRadius: 4, padding: '1px 5px' }}>sensitive</span>
                        )}
                        {item.hint && <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>— {item.hint}</span>}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {save.isError && <div style={{ fontSize: '.8rem', color: 'var(--red, #ef4444)' }}>Failed to save — try again.</div>}
    </div>
  )
}
