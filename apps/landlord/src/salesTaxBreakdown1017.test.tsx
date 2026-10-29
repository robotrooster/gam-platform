// @vitest-environment jsdom
/**
 * 10/17 (Nic): "we need more breakdown so we can see exactly how much of each
 * item was sold and how much of each tax separated by category was collected.
 * That way it can be forwarded on to the right agencies."
 *
 * The Sales & tax page: every item with its quantity and its dollars under its
 * register category, the strip that ties the item lines to what the books
 * posted, one line per named tax with the account its money is in, and one
 * spreadsheet with both breakdowns in it. A tax a sale never named is shown by
 * name, so it is never silently filed. The same file ships in GAM Books
 * (financials parity).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from 'react-query'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({ replies: {} as Record<string, any>, asked: [] as string[] }))

vi.mock('./financials/adapter', () => ({
  finGet: async (url: string) => {
    server.asked.push(url)
    const key = Object.keys(server.replies).find(k => url.startsWith(k))
    if (!key) throw new Error(`unexpected GET ${url}`)
    return server.replies[key]
  },
  finPost: async () => { throw new Error('no post expected') },
  finPatch: async () => { throw new Error('no patch expected') },
  finUpload: async () => { throw new Error('no upload expected') },
  openProtectedFile: async () => {},
  pinnedCompanyId: () => null,
  toast: Object.assign(() => {}, { error: () => {} }),
  toastError: () => {},
  appConfirm: async () => false,
  useIsBookkeeper: () => false,
  useViewer: () => ({ role: 'landlord', isBookkeeper: false, can: () => true, openOwnerPage: null }),
}))

import { SalesTaxPage } from './financials/SalesTaxPage'

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const text = () => host!.textContent || ''

async function render() {
  host = document.createElement('div')
  document.body.appendChild(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root = createRoot(host!)
    root.render(<QueryClientProvider client={qc}><SalesTaxPage /></QueryClientProvider>)
  })
  await flush()
}
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null; host = null
  server.replies = {}; server.asked = []
})

/** How many fields a spreadsheet row has (a comma inside quotes is not one). */
function fieldCount(line: string): number {
  let n = 1
  let quoted = false
  for (const ch of line) {
    if (ch === '"') quoted = !quoted
    else if (ch === ',' && !quoted) n++
  }
  return n
}

/** The text of a saved spreadsheet (jsdom's Blob has no text() of its own). */
const readBlob = (b: Blob): Promise<string> => new Promise((resolve, reject) => {
  const r = new FileReader()
  r.onerror = () => reject(r.error)
  r.onload = () => resolve(String(r.result))
  r.readAsText(b)
})

const SCOPE = { viewer: 'owner', canRemoveExpenses: true, companyWide: true, companies: [], properties: [] }

/** Production's September at Mountain View, as the API sends it. */
const ANSWER = {
  live: true,
  period: { start: '2026-09-01', end: '2026-09-30', label: 'Sep 1, 2026 to Sep 30, 2026' },
  sales: {
    salesCount: 5,
    categories: [
      {
        category: 'Utilities', label: 'Utilities', sales: 34.98,
        items: [{ name: 'Propane', unit: null, qty: 10.6, sales: 34.98, salesCount: 2 }],
      },
      {
        category: 'Stays', label: 'Stays', sales: 269,
        items: [{ name: 'RV site — weekly', unit: 'week', qty: 1, sales: 269, salesCount: 1 }],
      },
    ],
    tie: {
      itemLines: 303.98, discounts: 0, towardStays: 0, backgroundChecks: 0,
      cashSurcharge: 0, corrections: 0, posted: 303.98, difference: 0, returns: 0,
    },
  },
  // This company filed nothing as other income, so that section is not on the
  // page at all (OTHER_INCOME below is the answer that has it).
  otherIncome: { rows: [], total: 0, noTaxSplit: 0 },
  taxes: {
    rows: [
      {
        label: 'Transaction privilege tax', taxName: 'Transaction privilege tax',
        accountCode: '2040-1', accountName: 'Sales tax payable: Transaction privilege tax',
        accountRole: 'sales_tax_payable',
        rates: [
          { rate: 0.0635, taxableSales: 42.9, estimated: false, collected: 2.72 },
          { rate: 0.066, taxableSales: 13.2, estimated: false, collected: 0.87 },
        ],
        taxableSales: 56.1, estimated: false, collected: 3.59, paid: 0, unpaid: 20.66, unnamed: false,
      },
      {
        label: 'Lodging tax', taxName: 'Lodging tax',
        accountCode: '2042', accountName: 'Lodging tax payable', accountRole: 'lodging_tax_payable',
        rates: [{ rate: 0.0635, taxableSales: 269, estimated: false, collected: 17.08 }],
        taxableSales: 269, estimated: false, collected: 17.08, paid: 0, unpaid: 17.08, unnamed: false,
      },
      {
        label: 'Not itemized — the sale did not record which tax', taxName: null,
        accountCode: '2040', accountName: 'Sales tax payable', accountRole: 'sales_tax_payable',
        rates: [], taxableSales: 0, estimated: false, collected: 0.87, paid: 0, unpaid: 0.87, unnamed: true,
      },
    ],
    totals: { taxableSales: 325.1, collected: 21.54, paid: 0, unpaid: 38.61 },
  },
}

/**
 * 10/17 (Nic): "There is things listed as OTHER INCOME or just sales... We're
 * also showing some other miscellaneous income." Production's Mountain View
 * rows: the Square card sales from before the GAM card reader, five lumps on
 * 4900 Other income with no item lines and no tax split.
 */
const WITH_OTHER_INCOME = {
  ...ANSWER,
  otherIncome: {
    rows: [
      {
        accountCode: '4900', accountName: 'Other income',
        category: 'Square (pre-reader)', label: 'Square (pre-reader)',
        description: 'Square card sales before the GAM card reader (propane, overnight stays)',
        payer: 'Square', amount: 409.04, records: 4, lumpSum: true,
      },
      {
        accountCode: '4050', accountName: 'Laundry and vending',
        category: 'Laundry', label: 'Laundry', description: 'Washers and dryers',
        payer: null, amount: 75, records: 3, lumpSum: true,
      },
    ],
    total: 484.04, noTaxSplit: 484.04,
  },
}

const BREAKDOWN = '/books/tax/sales-breakdown'

describe('the Sales & tax page (10/17, Nic)', () => {
  it('itemizes what was sold under its register category, with the quantity and the dollars', async () => {
    server.replies = { '/financials/scope': SCOPE, [BREAKDOWN]: ANSWER }
    await render()
    const rows = [...host!.querySelectorAll('table')][0].querySelectorAll('tbody tr')
    const cells = [...rows].map(r => [...r.querySelectorAll('td')].map(td => (td.textContent || '').trim()))
    expect(cells).toEqual([
      ['Utilities', '', '$34.98', ''],
      ['Propane', '10.6', '$34.98', '2'],
      ['Stays', '', '$269.00', ''],
      ['RV site — weekly', '1 week', '$269.00', '1'],
    ])
  })

  it('shows how the item lines become the figure in the books, with the signs the arithmetic has', async () => {
    server.replies = {
      '/financials/scope': SCOPE,
      [BREAKDOWN]: {
        ...ANSWER,
        sales: {
          ...ANSWER.sales,
          tie: {
            itemLines: 170, discounts: 5, towardStays: 60, backgroundChecks: 30,
            cashSurcharge: 2, corrections: 0, posted: 77, difference: 0, returns: 0,
          },
        },
      },
    }
    await render()
    const tie = [...host!.querySelectorAll('table')][1]
    const rows = [...tie.querySelectorAll('tbody tr')].map(r => {
      const td = [...r.querySelectorAll('td')]
      return [(td[0].querySelector('div') ? td[0].childNodes[0].textContent : td[0].textContent)!.trim(), td[1].textContent!.trim()]
    })
    expect(rows).toEqual([
      ['Everything sold, at its price', '$170.00'],
      ['Less discounts given', '− $5.00'],
      ['Less what paid toward a stay', '− $60.00'],
      ['Less background-check fees', '− $30.00'],
      ['Plus a card fee kept in the drawer', '$2.00'],
      ['Register sales in the books', '$77.00'],
    ])
    // A term that is zero is left off; a difference would be its own row and
    // there is none, because the page and the books read the same postings.
    expect(text()).not.toContain('Unexplained difference')
    expect(text()).not.toContain('Plus corrections')
  })

  it('says so, in the red column, when the item lines and the books do not agree', async () => {
    server.replies = {
      '/financials/scope': SCOPE,
      [BREAKDOWN]: { ...ANSWER, sales: { ...ANSWER.sales, tie: { ...ANSWER.sales.tie, difference: 1.5 } } },
    }
    await render()
    expect(text()).toContain('Unexplained difference')
    expect(host!.querySelector('td.fin-num.fin-out')!.textContent).toBe('$1.50')
  })

  it('one line per named tax, with the account the money is in, each rate, and what is still to send', async () => {
    server.replies = { '/financials/scope': SCOPE, [BREAKDOWN]: ANSWER }
    await render()
    const tax = [...host!.querySelectorAll('table')][2]
    // The first cell of a row may carry a note under it in its own <div>; the
    // row is read without the note so the figures can be compared exactly.
    const withoutNote = (td: Element) => {
      const note = td.querySelector('div')
      const all = td.textContent || ''
      return (note ? all.replace(note.textContent || '', '') : all).trim()
    }
    const rows = [...tax.querySelectorAll('tbody tr')].map(r => [...r.querySelectorAll('td')].map(withoutNote))
    expect(rows).toEqual([
      ['Transaction privilege tax', '2040-1 Sales tax payable: Transaction privilege tax', 'Several', '$56.10', '$3.59', '$0.00', '$20.66'],
      ['At 6.35%', '', '6.35%', '$42.90', '$2.72', '', ''],
      ['At 6.6%', '', '6.6%', '$13.20', '$0.87', '', ''],
      ['Lodging tax', '2042 Lodging tax payable', '6.35%', '$269.00', '$17.08', '$0.00', '$17.08'],
      // A tax a sale never named is shown by name, last, with no rate and no base.
      ['Not itemized — the sale did not record which tax', '2040 Sales tax payable', '—', '—', '$0.87', '$0.00', '$0.87'],
      ['Total', '', '', '$325.10', '$21.54', '$0.00', '$38.61'],
    ])
    expect(text()).toContain('Settle it with GAM before you file')
    expect(text()).toContain('GAM shows these figures; it does not file for you.')
  })

  it('says what the "other income" account actually was: the category, the words on the record and who paid', async () => {
    server.replies = { '/financials/scope': SCOPE, [BREAKDOWN]: WITH_OTHER_INCOME }
    await render()
    expect(text()).toContain('Other money in')
    const other = [...host!.querySelectorAll('table')][2]
    const rows = [...other.querySelectorAll('tbody tr')].map(r => [...r.querySelectorAll('td')].map(td => (td.textContent || '').trim()))
    expect(rows).toEqual([
      ['Square (pre-reader)', 'Square card sales before the GAM card reader (propane, overnight stays)', 'Square',
       '4900 Other income', '$409.04', '4'],
      ['Laundry', 'Washers and dryers', '—', '4050 Laundry and vending', '$75.00', '3'],
      ['Total', '', '', '', '$484.04', ''],
    ])
    // And the sentence she needs before she files: a lump recorded no tax
    // inside it, so any lodging or privilege tax in it is not in the tax table.
    expect(text()).toContain('$484.04 of this:')
    expect(text()).toContain('no tax was recorded inside it')
    expect(text()).toContain('not in the tax table below')
  })

  it('no other income filed, no section — never a row of zeros', async () => {
    server.replies = { '/financials/scope': SCOPE, [BREAKDOWN]: ANSWER }
    await render()
    expect(text()).not.toContain('Other money in')
  })

  it('exports both breakdowns as one spreadsheet, every row the same width', async () => {
    server.replies = { '/financials/scope': SCOPE, [BREAKDOWN]: ANSWER }
    await render()
    // jsdom has no object URLs of its own; the save is captured instead.
    const blobs: Blob[] = []
    const url = URL as unknown as Record<string, unknown>
    const had = { make: url.createObjectURL, revoke: url.revokeObjectURL }
    url.createObjectURL = (b: Blob) => { blobs.push(b); return 'blob:x' }
    url.revokeObjectURL = () => {}
    // jsdom would try to navigate to the object URL; the save itself is what is
    // being checked, so the click is counted and goes nowhere.
    const clicks: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.download) })
    const button = [...host!.querySelectorAll('button')].find(b => b.textContent === 'Export spreadsheet')!
    expect(button.className).toContain('btn-primary')
    await act(async () => { button.click() })
    expect(blobs).toHaveLength(1)
    const csv = await readBlob(blobs[0])
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('"What was sold and what tax was collected — Sep 1, 2026 to Sep 30, 2026",,,,,,')
    expect(lines[1]).toBe('WHAT WAS SOLD,Item,Sold by,Quantity,Sales,Sales it was on,')
    expect(new Set(lines.map(fieldCount))).toEqual(new Set([7]))
    expect(csv).toContain('Utilities,Propane,,10.6,34.98,2')
    expect(csv).toContain('Stays,RV site — weekly,weeks,1,269,1')
    expect(csv).toContain('Register sales in the books,,,,303.98')
    expect(csv).toContain('Transaction privilege tax,2040-1 Sales tax payable: Transaction privilege tax,Several,56.1,3.59,0,20.66')
    expect(csv).toContain('Lodging tax,2042 Lodging tax payable,6.35%,269,17.08,0,17.08')
    expect(csv).toContain('Total,,,325.1,21.54,0,38.61')
    expect(clicks).toEqual(['sales-and-tax-2026-09-01-to-2026-09-30.csv'])
    click.mockRestore()
    url.createObjectURL = had.make; url.revokeObjectURL = had.revoke
  })

  it('the spreadsheet carries the other-income lines too, at the same width', async () => {
    server.replies = { '/financials/scope': SCOPE, [BREAKDOWN]: WITH_OTHER_INCOME }
    await render()
    const blobs: Blob[] = []
    const url = URL as unknown as Record<string, unknown>
    const had = { make: url.createObjectURL, revoke: url.revokeObjectURL }
    url.createObjectURL = (b: Blob) => { blobs.push(b); return 'blob:x' }
    url.revokeObjectURL = () => {}
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await act(async () => {
      ;[...host!.querySelectorAll('button')].find(b => b.textContent === 'Export spreadsheet')!.click()
    })
    const csv = await readBlob(blobs[0])
    expect(new Set(csv.split('\r\n').map(fieldCount))).toEqual(new Set([7]))
    expect(csv).toContain('OTHER MONEY IN,Account it is in,What the record said,From,Amount,Records,')
    expect(csv).toContain('Square (pre-reader),4900 Other income,"Square card sales before the GAM card reader (propane, overnight stays)",Square,409.04,4,')
    expect(csv).toContain('Laundry,4050 Laundry and vending,Washers and dryers,,75,3,')
    expect(csv).toContain('Logged as a lump with no tax recorded inside it,,,,484.04')
    click.mockRestore()
    url.createObjectURL = had.make; url.revokeObjectURL = had.revoke
  })

  it('a company whose books are not live is told why, with no page of zeros', async () => {
    server.replies = {
      '/financials/scope': SCOPE,
      [BREAKDOWN]: { live: false, reason: 'The books have no start date yet.' },
    }
    await render()
    expect(text()).toContain('The books have no start date yet.')
    expect(text()).not.toContain('What was sold')
    expect([...host!.querySelectorAll('button')].find(b => b.textContent === 'Export spreadsheet')!.disabled).toBe(true)
  })
})
