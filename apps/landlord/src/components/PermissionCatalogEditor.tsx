import { PERMISSION_CATALOG, PERMISSION_PRESETS } from '@gam/shared'

// S576 (Nic, B-10): controlled permission editor — presets + the full grouped
// 105-key catalog — driven by a local permissions map. Used in the Team invite
// form so an owner sets exact grants BEFORE sending (they apply the moment the
// invitee accepts, still editable later on the member's permissions page).
//
// Presentational + fully controlled (value/onChange). This deliberately mirrors
// StaffPermissionsPage's grid but does NOT share its toggle logic: that page
// full-replaces the server jsonb on every flip, whereas here nothing exists yet
// — edits batch in local state until the invite is sent. All buttons are
// type="button" so the editor is safe inside the invite <form>.

export function PermissionCatalogEditor({
  value, onChange, disabled = false,
}: {
  value: Record<string, boolean>
  onChange: (next: Record<string, boolean>) => void
  disabled?: boolean
}) {
  const setGroup = (keys: string[], on: boolean) => {
    const next = { ...value }
    for (const k of keys) next[k] = on
    onChange(next)
  }
  const toggle = (key: string) => onChange({ ...value, [key]: !value[key] })
  const selectedCount = Object.values(value).filter(Boolean).length

  return (
    <div>
      {/* Presets — additive quick-fills (turn a bundle ON); every toggle stays
          adjustable below. Matches the permissions-page behaviour. */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {PERMISSION_PRESETS.map(preset => (
            <button
              key={preset.id}
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={disabled}
              title={preset.description}
              onClick={() => setGroup(preset.keys, true)}
              style={{ border: '1px solid var(--border-1)', borderRadius: 8, padding: '5px 10px' }}
            >
              + {preset.label}
            </button>
          ))}
          {selectedCount > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={disabled}
              onClick={() => onChange({})}
              style={{ color: 'var(--text-3)' }}
            >
              Clear all
            </button>
          )}
          <span style={{ marginLeft: 'auto', fontSize: '.72rem', color: 'var(--text-3)' }}>
            {selectedCount} selected
          </span>
        </div>
      </div>

      {PERMISSION_CATALOG.map(group => {
        const groupKeys = group.sections.flatMap(s => s.items.map(i => i.key))
        const allOn = groupKeys.every(k => value[k])
        return (
          <div key={group.category} style={{ border: '1px solid var(--border-1)', borderRadius: 10, marginBottom: 12, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border-1)', background: 'var(--bg-3)' }}>
              <div style={{ fontWeight: 700, fontSize: '.88rem' }}>{group.label}</div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ fontSize: '.72rem' }}
                onClick={() => setGroup(groupKeys, !allOn)}
                disabled={disabled}
              >
                {allOn ? 'Turn all off' : 'Turn all on'}
              </button>
            </div>
            <div style={{ padding: 14 }}>
              {group.sections.map(section => (
                <div key={section.label} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: '.68rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
                    {section.label}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 6 }}>
                    {section.items.map(item => (
                      <label key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.82rem', color: 'var(--text-1)', cursor: 'pointer', padding: '3px 0' }}>
                        <input
                          type="checkbox"
                          checked={!!value[item.key]}
                          onChange={() => toggle(item.key)}
                          disabled={disabled}
                        />
                        <span>{item.label}</span>
                        {item.sensitive && (
                          <span style={{ fontSize: '.6rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--gold)', background: 'rgba(201,162,39,.12)', border: '1px solid rgba(201,162,39,.3)', borderRadius: 4, padding: '1px 5px' }}>sensitive</span>
                        )}
                        {item.hint && <span style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>— {item.hint}</span>}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
