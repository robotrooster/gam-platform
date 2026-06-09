// S29c-2-F: editable entity arrays for ConfirmIntentModal.
//
// Background: mergeParserOutput in apps/api/src/jobs/leaseParser/resolveIntent.ts
// does `{ ...baseSafe, ...overrides }` for entity fields. That means vehicles,
// rvs, pets, additionalOccupants, liabilityInsurance, mobileHome are all
// WHOLESALE-replaced when present in landlordOverrides. There is no per-row
// merge, so partial overrides like `vehicles: [{ year: ... }]` would clobber
// the parser's full extraction and crash the resolveIntent writer (which
// reads required fields like vehicleType.value off undefined).
//
// Therefore: when the landlord touches any row in a section, the modal sends
// the ENTIRE materialized array. Untouched sections are omitted from the
// override payload and the parser output flows through intact.
//
// Tenant-nested arrays (identifications, emergencyContacts) ride on the
// existing mergeTenants path which DOES do a per-tenant shallow merge.
// Sending `tenants[0] = { identifications: [...] }` replaces those arrays
// wholesale while preserving any scalar tenant overrides already there.

import {
  VEHICLE_TYPES,
  PET_SPECIES,
  RV_HOOKUP_CLASSES,
  ID_TYPES,
} from '@gam/shared'

// ---------------------------------------------------------------------
// Tier helpers - duplicated from ConfirmIntentModal.tsx for module locality.
// Kept identical to the original; if confidence thresholds change, both
// must be updated together.
// ---------------------------------------------------------------------

const COLOR_DANGER  = '#dc2626'
const COLOR_WARNING = '#f59e0b'
const COLOR_SUCCESS = '#16a34a'
const COLOR_MUTED   = '#9ca3af'

function tierOf(field: any): 'high' | 'mid' | 'low' | 'missing' {
  if (!field) return 'missing'
  const c = field.confidence ?? 0
  if (c >= 0.95) return 'high'
  if (c >= 0.70) return 'mid'
  return 'low'
}

function tierColor(t: 'high' | 'mid' | 'low' | 'missing'): string {
  if (t === 'high') return COLOR_SUCCESS
  if (t === 'mid')  return COLOR_WARNING
  if (t === 'low')  return COLOR_DANGER
  return COLOR_MUTED
}

// ---------------------------------------------------------------------
// Section identity and field configs.
// ---------------------------------------------------------------------

export type EntityArraySectionId =
  | 'vehicles'
  | 'rvs'
  | 'pets'
  | 'occupants'
  | 'identifications'
  | 'emergencyContacts'

export type EntityObjectSectionId =
  | 'liabilityInsurance'
  | 'mobileHome'

export type EntitySectionId = EntityArraySectionId | EntityObjectSectionId

export type EntityFieldConfig = {
  key: string
  label: string
  type?: 'text' | 'number' | 'date' | 'email' | 'tel' | 'select' | 'checkbox'
  options?: { value: string; label: string }[]
  required?: boolean
}

const enumOptions = (vals: readonly string[]) =>
  vals.map(v => ({ value: v, label: v.replace(/_/g, ' ') }))

const VEHICLE_FIELDS: EntityFieldConfig[] = [
  { key: 'vehicleType',  label: 'Type',          type: 'select', options: enumOptions(VEHICLE_TYPES), required: true },
  { key: 'year',         label: 'Year',          type: 'number' },
  { key: 'make',         label: 'Make' },
  { key: 'model',        label: 'Model' },
  { key: 'color',        label: 'Color' },
  { key: 'licensePlate', label: 'License plate' },
  { key: 'plateState',   label: 'Plate state' },
]

const RV_FIELDS: EntityFieldConfig[] = [
  { key: 'year',         label: 'Year',          type: 'number' },
  { key: 'make',         label: 'Make' },
  { key: 'model',        label: 'Model' },
  { key: 'vin',          label: 'VIN' },
  { key: 'lengthFt',     label: 'Length (ft)',   type: 'number' },
  { key: 'numSlides',    label: 'Slide-outs',    type: 'number' },
  { key: 'hookupClass',  label: 'Hookup class',  type: 'select', options: enumOptions(RV_HOOKUP_CLASSES) },
  { key: 'licensePlate', label: 'License plate' },
  { key: 'plateState',   label: 'Plate state' },
]

const PET_FIELDS: EntityFieldConfig[] = [
  { key: 'species',            label: 'Species',           type: 'select', options: enumOptions(PET_SPECIES), required: true },
  { key: 'name',               label: 'Name' },
  { key: 'breed',              label: 'Breed' },
  { key: 'color',              label: 'Color' },
  { key: 'ageYears',           label: 'Age (years)',       type: 'number' },
  { key: 'weightLbs',          label: 'Weight (lbs)',      type: 'number' },
  { key: 'isServiceAnimal',    label: 'Service animal',    type: 'checkbox' },
  { key: 'isEmotionalSupport', label: 'Emotional support', type: 'checkbox' },
]

const OCCUPANT_FIELDS: EntityFieldConfig[] = [
  { key: 'fullName',                     label: 'Full name', required: true },
  { key: 'relationshipToPrimaryTenant',  label: 'Relationship' },
  { key: 'dateOfBirth',                  label: 'Date of birth', type: 'date' },
  { key: 'isMinor',                      label: 'Minor',         type: 'checkbox' },
]

const ID_FIELDS: EntityFieldConfig[] = [
  { key: 'idType',         label: 'Type',           type: 'select', options: enumOptions(ID_TYPES), required: true },
  { key: 'idNumber',       label: 'Number',         required: true },
  { key: 'issuingState',   label: 'Issuing state' },
  { key: 'issuingCountry', label: 'Issuing country' },
  { key: 'expiryDate',     label: 'Expiry',         type: 'date' },
]

const EMERGENCY_FIELDS: EntityFieldConfig[] = [
  { key: 'name',         label: 'Name',         required: true },
  { key: 'phone',        label: 'Phone',        type: 'tel' },
  { key: 'email',        label: 'Email',        type: 'email' },
  { key: 'relationship', label: 'Relationship' },
]

const INSURANCE_FIELDS: EntityFieldConfig[] = [
  { key: 'carrierName',  label: 'Carrier' },
  { key: 'policyNumber', label: 'Policy number' },
  { key: 'expiryDate',   label: 'Expiry', type: 'date' },
]

const MOBILE_HOME_FIELDS: EntityFieldConfig[] = [
  { key: 'year',             label: 'Year',             type: 'number' },
  { key: 'make',             label: 'Make' },
  { key: 'model',            label: 'Model' },
  { key: 'serialNumber',     label: 'Serial number' },
  { key: 'hudLabelNumber',   label: 'HUD label number' },
  { key: 'lengthFt',         label: 'Length (ft)',      type: 'number' },
  { key: 'widthFt',          label: 'Width (ft)',       type: 'number' },
  { key: 'manufacturedDate', label: 'Manufactured',     type: 'date' },
]

export const SECTION_META: Record<EntitySectionId, { title: string; rowLabel: string; fields: EntityFieldConfig[] }> = {
  vehicles:           { title: 'Vehicles',             rowLabel: 'vehicle',  fields: VEHICLE_FIELDS },
  rvs:                { title: 'RVs',                  rowLabel: 'RV',       fields: RV_FIELDS },
  pets:               { title: 'Pets',                 rowLabel: 'pet',      fields: PET_FIELDS },
  occupants:          { title: 'Additional occupants', rowLabel: 'occupant', fields: OCCUPANT_FIELDS },
  identifications:    { title: 'Tenant IDs',           rowLabel: 'ID',       fields: ID_FIELDS },
  emergencyContacts:  { title: 'Emergency contacts',   rowLabel: 'contact',  fields: EMERGENCY_FIELDS },
  liabilityInsurance: { title: 'Liability insurance',  rowLabel: '',         fields: INSURANCE_FIELDS },
  mobileHome:         { title: 'Mobile home',          rowLabel: '',         fields: MOBILE_HOME_FIELDS },
}

// ---------------------------------------------------------------------
// Override-shape helpers.
// ---------------------------------------------------------------------

// Wrap a raw value into a ParserExtractedField shape so the JSONB written
// to pending_tenant_intents.parser_output stays type-consistent. Confidence
// 1.0 + the rawText sentinel let downstream code identify landlord overrides.
export function asOverrideField(value: any) {
  return { value, confidence: 1.0, rawText: '(landlord override)' }
}

// Build a fresh row for an array section. Required fields with select options
// default to the first option so resolveIntent's writer (which reads
// row.field.value on required fields) doesn't crash. Required text fields
// remain undefined — missingRequired surfaces them in the UI.
export function freshRow(sectionId: EntityArraySectionId): any {
  const row: any = {}
  const fields = SECTION_META[sectionId].fields
  for (const fc of fields) {
    if (fc.required && fc.type === 'select' && fc.options && fc.options[0]) {
      row[fc.key] = asOverrideField(fc.options[0].value)
    }
  }
  return row
}

// ---------------------------------------------------------------------
// EntityFieldRow - reduced FieldRow for entity row leaves. Reads the field
// shape directly (no dot-path indirection); detects landlord-override mode
// by the rawText sentinel; no revert button (user removes the row instead).
// ---------------------------------------------------------------------

type EntityFieldRowProps = {
  config: EntityFieldConfig
  field: any  // ParserExtractedField<T> | undefined
  onEdit: (value: any) => void
}

export function EntityFieldRow({ config, field, onEdit }: EntityFieldRowProps) {
  const tier = tierOf(field)
  const dot = tierColor(tier)
  const value = field?.value
  const rawText = field?.rawText
  const conf = field?.confidence
  const isOverride = field?.confidence === 1.0 && field?.rawText === '(landlord override)'
  const isMissing = config.required && (value === undefined || value === null || value === '')
  const inputBorder = isMissing
    ? COLOR_DANGER
    : (isOverride ? 'var(--text-2)' : 'var(--border-0)')

  const inputType = config.type ?? 'text'
  const currentValue: any = value ?? (inputType === 'checkbox' ? false : '')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span title={tier} style={{
          width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0,
        }} />
        <label style={{ fontSize: '.74rem', color: 'var(--text-2)', fontWeight: 500 }}>
          {config.label}{config.required ? ' *' : ''}
        </label>
        {conf !== undefined && (
          <span style={{ fontSize: '.66rem', color: 'var(--text-3)' }}>
            {Math.round(conf * 100)}%
          </span>
        )}
        {isOverride && (
          <span style={{
            fontSize: '.64rem', color: 'var(--text-2)',
            padding: '1px 6px', borderRadius: 3, background: 'var(--bg-2)', fontStyle: 'italic',
          }}>
            edited
          </span>
        )}
      </div>

      {inputType === 'select' && config.options ? (
        <select
          value={String(currentValue ?? '')}
          onChange={e => onEdit(e.target.value || undefined)}
          style={{
            padding: '5px 8px', fontSize: '.82rem',
            border: `1px solid ${inputBorder}`, borderRadius: 4,
            background: 'var(--bg-1)', color: 'var(--text-0)',
          }}
        >
          {!config.required && <option value="">—</option>}
          {config.options.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : inputType === 'checkbox' ? (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.82rem', color: 'var(--text-1)' }}>
          <input
            type="checkbox"
            checked={Boolean(currentValue)}
            onChange={e => onEdit(e.target.checked)}
          />
          {currentValue ? 'Yes' : 'No'}
        </label>
      ) : (
        <input
          type={inputType}
          value={currentValue == null ? '' : String(currentValue)}
          onChange={e => {
            const v = e.target.value
            if (inputType === 'number') {
              if (v === '') onEdit(undefined)
              else {
                const n = Number(v)
                onEdit(Number.isFinite(n) ? n : undefined)
              }
            } else {
              onEdit(v === '' ? undefined : v)
            }
          }}
          style={{
            padding: '5px 8px', fontSize: '.82rem',
            border: `1px solid ${inputBorder}`, borderRadius: 4,
            background: 'var(--bg-1)', color: 'var(--text-0)',
          }}
        />
      )}

      {rawText && (
        <div style={{
          fontSize: '.66rem', color: 'var(--text-3)', fontFamily: 'monospace',
          wordBreak: 'break-word',
        }}>
          {rawText.startsWith('(') ? rawText : `PDF: ${rawText}`}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// EntityArraySection - one collapsible card per array (vehicles, rvs, pets,
// occupants, identifications, emergencyContacts). Header shows count + edited
// badge. Body lists rows with per-row Remove + an Add button at the bottom.
// ---------------------------------------------------------------------

type EntityArraySectionProps = {
  sectionId: EntityArraySectionId
  rows: any[]
  collapsed: boolean
  touched: boolean
  onToggleCollapsed: () => void
  onUpdateRow: (idx: number, key: string, value: any) => void
  onAddRow: () => void
  onRemoveRow: (idx: number) => void
}

export function EntityArraySection({
  sectionId, rows, collapsed, touched,
  onToggleCollapsed, onUpdateRow, onAddRow, onRemoveRow,
}: EntityArraySectionProps) {
  const meta = SECTION_META[sectionId]
  const fields = meta.fields
  return (
    <div style={{ marginBottom: 12, border: '1px solid var(--border-0)', borderRadius: 6, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={onToggleCollapsed}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 12px', background: 'var(--bg-2)',
          border: 'none', borderBottom: collapsed ? 'none' : '1px solid var(--border-0)',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: '.76rem', color: 'var(--text-2)', width: 12 }}>
          {collapsed ? '▸' : '▾'}
        </span>
        <span style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--text-0)' }}>
          {meta.title}
        </span>
        <span style={{ fontSize: '.74rem', color: 'var(--text-2)' }}>
          {rows.length} {meta.rowLabel}{rows.length === 1 ? '' : 's'}
        </span>
        {touched && (
          <span style={{
            fontSize: '.66rem', color: 'var(--text-2)',
            padding: '1px 6px', borderRadius: 3, background: 'var(--bg-1)', fontStyle: 'italic',
          }}>
            edited
          </span>
        )}
      </button>
      {!collapsed && (
        <div style={{ padding: 12 }}>
          {rows.length === 0 && (
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)', marginBottom: 12 }}>
              No {meta.rowLabel}s parsed. Click Add below to enter one manually.
            </div>
          )}
          {rows.map((row, idx) => (
            <div key={idx} style={{
              padding: 12, marginBottom: 10,
              background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 4,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: '.8rem', fontWeight: 600, color: 'var(--text-1)' }}>
                  {meta.rowLabel.charAt(0).toUpperCase() + meta.rowLabel.slice(1)} #{idx + 1}
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveRow(idx)}
                  className="btn btn-ghost btn-sm"
                  style={{ marginLeft: 'auto', color: COLOR_DANGER, fontSize: '.74rem' }}
                >
                  Remove
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
                {fields.map(fc => (
                  <EntityFieldRow
                    key={fc.key}
                    config={fc}
                    field={row[fc.key]}
                    onEdit={v => onUpdateRow(idx, fc.key, v)}
                  />
                ))}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={onAddRow}
            className="btn btn-ghost btn-sm"
            style={{ fontSize: '.78rem' }}
          >
            + Add {meta.rowLabel}
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// EntityObjectSection - single-object variant for liabilityInsurance and
// mobileHome. No Add/Remove; just a flat field grid.
// ---------------------------------------------------------------------

type EntityObjectSectionProps = {
  sectionId: EntityObjectSectionId
  obj: any | null
  collapsed: boolean
  touched: boolean
  onToggleCollapsed: () => void
  onUpdateField: (key: string, value: any) => void
}

export function EntityObjectSection({
  sectionId, obj, collapsed, touched,
  onToggleCollapsed, onUpdateField,
}: EntityObjectSectionProps) {
  const meta = SECTION_META[sectionId]
  const fields = meta.fields
  const hasData = obj != null && Object.keys(obj).some(k => {
    const v = obj[k]?.value
    return v !== undefined && v !== null && v !== ''
  })
  return (
    <div style={{ marginBottom: 12, border: '1px solid var(--border-0)', borderRadius: 6, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={onToggleCollapsed}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 12px', background: 'var(--bg-2)',
          border: 'none', borderBottom: collapsed ? 'none' : '1px solid var(--border-0)',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: '.76rem', color: 'var(--text-2)', width: 12 }}>
          {collapsed ? '▸' : '▾'}
        </span>
        <span style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--text-0)' }}>
          {meta.title}
        </span>
        <span style={{ fontSize: '.74rem', color: 'var(--text-2)' }}>
          {hasData ? 'present' : 'none'}
        </span>
        {touched && (
          <span style={{
            fontSize: '.66rem', color: 'var(--text-2)',
            padding: '1px 6px', borderRadius: 3, background: 'var(--bg-1)', fontStyle: 'italic',
          }}>
            edited
          </span>
        )}
      </button>
      {!collapsed && (
        <div style={{ padding: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
            {fields.map(fc => (
              <EntityFieldRow
                key={fc.key}
                config={fc}
                field={obj?.[fc.key]}
                onEdit={v => onUpdateField(fc.key, v)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// UndoToast - 5-second undo window after row removal.
// ---------------------------------------------------------------------

type UndoToastProps = {
  message: string
  onUndo: () => void
  onDismiss: () => void
}

export function UndoToast({ message, onUndo, onDismiss }: UndoToastProps) {
  return (
    <div style={{
      position: 'absolute', bottom: 80, left: '50%', transform: 'translateX(-50%)',
      padding: '10px 16px',
      background: 'var(--text-0)', color: 'var(--bg-0)',
      borderRadius: 6, display: 'flex', alignItems: 'center', gap: 12,
      fontSize: '.82rem', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', zIndex: 100,
    }}>
      <span>{message}</span>
      <button
        type="button"
        onClick={onUndo}
        style={{
          background: 'transparent', border: '1px solid var(--bg-0)',
          color: 'var(--bg-0)', padding: '3px 10px', borderRadius: 4,
          fontSize: '.78rem', cursor: 'pointer',
        }}
      >
        Undo
      </button>
      <button
        type="button"
        onClick={onDismiss}
        style={{
          background: 'transparent', border: 'none',
          color: 'var(--bg-0)', cursor: 'pointer',
          padding: 0, fontSize: '1rem', lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  )
}
