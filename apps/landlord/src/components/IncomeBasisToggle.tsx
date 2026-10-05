/**
 * S655 money plan, Step 15: the one "Money received" / "Money billed" switch.
 *
 * Two choices, the current one in gold, and under it the plain note that says
 * how the figures on the page are counted (the same note every report returns
 * as meta.basis). The choice is remembered per browser (lib/incomeBasis).
 */
import { INCOME_BASES, INCOME_BASIS_LABEL, type IncomeBasis } from '@gam/shared'
import { basisNote } from '../lib/incomeBasis'
import '../styles/reports-basis.css'

export function IncomeBasisToggle({ basis, onChange, note, showNote = true, label = 'Show' }: {
  basis: IncomeBasis
  onChange: (b: IncomeBasis) => void
  /** The API's meta.basis.note when the page has one; the shared note otherwise. */
  note?: string | null
  showNote?: boolean
  label?: string
}) {
  return (
    <div className="basis-switch no-print">
      <div className="basis-switch-row">
        <span className="basis-switch-label" id="basis-switch-label">{label}</span>
        <div className="basis-toggle" role="radiogroup" aria-labelledby="basis-switch-label">
          {INCOME_BASES.map(b => (
            <button
              key={b}
              type="button"
              role="radio"
              aria-checked={basis === b}
              className={`basis-toggle-btn${basis === b ? ' on' : ''}`}
              onClick={() => { if (b !== basis) onChange(b) }}
            >
              {INCOME_BASIS_LABEL[b]}
            </button>
          ))}
        </div>
      </div>
      {showNote && <p className="basis-note">{note || basisNote(basis)}</p>}
    </div>
  )
}

/** The basis note for a printed page (the switch itself is hidden on paper). */
export function BasisPrintNote({ basis, note }: { basis: IncomeBasis; note?: string | null }) {
  return (
    <p className="basis-print-note">
      <strong>{INCOME_BASIS_LABEL[basis]}.</strong> {note || basisNote(basis)}
    </p>
  )
}
