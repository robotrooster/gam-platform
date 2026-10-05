import type { CSSProperties } from 'react'
import { PERMISSION_CATALOG, PERMISSION_PRESETS, type PermissionItem } from '@gam/shared'

// 10/3 (Nic): "each permission that you're going to toggle on or off should
// have a little description of what it does next to it." One row, used by BOTH
// permission editors (this invite form and the member's own permissions page),
// so the description can never show on one and not the other. The label sits
// on its own line with the description in small gray text beneath it, and the
// grid drops to one column on a phone (min(100%, …) keeps a narrow modal from
// scrolling sideways).
export const PERMISSION_ROW_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))',
  gap: '4px 20px',
}

export function PermissionToggleRow({
  item, checked, onToggle, disabled = false,
}: {
  item: PermissionItem
  checked: boolean
  onToggle: () => void
  disabled?: boolean
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0', minWidth: 0, cursor: disabled ? 'default' : 'pointer' }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={disabled}
        style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }}
      />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontSize: '.84rem', fontWeight: 500, color: 'var(--text-1)', lineHeight: 1.35 }}>
          {item.label}
          {item.sensitive && (
            <span style={{ fontSize: '.6rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--gold)', background: 'rgba(201,162,39,.12)', border: '1px solid rgba(201,162,39,.3)', borderRadius: 4, padding: '1px 5px' }}>sensitive</span>
          )}
        </span>
        <span style={{ fontSize: '.76rem', color: 'var(--text-3)', lineHeight: 1.45 }}>{item.hint}</span>
      </span>
    </label>
  )
}

// S576 (Nic, B-10): controlled permission editor — presets + the full grouped
// catalog — driven by a local permissions map. Used in the Team invite
// form so an owner sets exact grants BEFORE sending (they apply the moment the
// invitee accepts, still editable later on the member's permissions page).
//
// Presentational + fully controlled (value/onChange). This deliberately mirrors
// StaffPermissionsPage's grid (and shares its row, PermissionToggleRow, above)
// but does NOT share its toggle logic: that page
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
          adjustable below. Matches the permissions-page behavior. */}
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
                  <div style={PERMISSION_ROW_GRID}>
                    {section.items.map(item => (
                      <PermissionToggleRow
                        key={item.key}
                        item={item}
                        checked={!!value[item.key]}
                        onToggle={() => toggle(item.key)}
                        disabled={disabled}
                      />
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
