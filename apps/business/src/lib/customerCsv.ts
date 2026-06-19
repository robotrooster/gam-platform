// Customer CSV parsing — shared by the onboarding wizard's import step and
// the CustomersPage bulk-import control so the column aliasing + quote
// handling never drift between the two surfaces. The backend
// (POST /business-customers/import, S515) validates each row; this is a
// permissive client-side parse that maps header names to the API field set.

export interface ParsedCustomerRow extends Record<string, string> {}

export interface CustomerImportResult {
  created: number
  skipped: number
  total: number
  errors: Array<{ row: number; reason: string }>
}

// Header row maps columns by name (case-insensitive, spaces/underscores
// ignored). Handles quoted fields with commas.
export function parseCustomerCsv(text: string): ParsedCustomerRow[] {
  const rows = splitCsvRows(text.trim())
  if (rows.length < 2) return []
  const headers = rows[0].map(h => h.trim().toLowerCase().replace(/[\s_]+/g, ''))
  const alias: Record<string, string> = {
    firstname: 'firstName', first: 'firstName',
    lastname: 'lastName', last: 'lastName',
    email: 'email', phone: 'phone',
    street1: 'street1', street: 'street1', address: 'street1', address1: 'street1',
    street2: 'street2', address2: 'street2',
    city: 'city', state: 'state', zip: 'zip', zipcode: 'zip', postalcode: 'zip',
    companyname: 'companyName', company: 'companyName', business: 'companyName',
    notes: 'notes',
  }
  const out: ParsedCustomerRow[] = []
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]
    if (cells.every(c => !c.trim())) continue
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => {
      const key = alias[h]
      if (key) obj[key] = (cells[i] ?? '').trim()
    })
    out.push(obj)
  }
  return out
}

// Split CSV text into rows of cells, honoring double-quoted fields.
function splitCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ }
        else inQuotes = false
      } else cell += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(cell); cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); cell = ''
      rows.push(row); row = []
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row) }
  return rows
}
