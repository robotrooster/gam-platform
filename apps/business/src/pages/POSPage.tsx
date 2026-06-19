import { useEffect, useMemo, useState } from 'react'
import { apiGet, apiPost, openPdfInNewTab } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { Modal } from '../components/Modal'
import {
  Search, Plus, Minus, X, ShoppingCart, Receipt, ArrowLeft,
  AlertTriangle, RotateCcw, Printer,
} from 'lucide-react'

interface InventoryItem {
  id: string
  name: string
  sku: string | null
  sellPrice: string
  taxRate: string
  stockQty: number
  categoryName: string | null
}

interface Customer {
  id: string
  firstName: string | null
  lastName: string | null
  businessName: string | null
}

interface CartLine {
  itemId: string
  name: string
  sku: string | null
  unitPrice: number
  taxRate: number
  stockOnHand: number
  qty: number
}

interface TransactionSummary {
  id: string
  receiptNumber: string
  status: 'completed' | 'partially_refunded' | 'refunded' | 'void'
  subtotal: string
  taxAmount: string
  tipAmount: string
  totalAmount: string
  paymentMethod: 'cash' | 'card_recorded' | 'stripe_terminal' | 'stripe_checkout'
  refundedAt: string | null
  customerFirstName: string | null
  customerLastName: string | null
  customerBusinessName: string | null
  createdAt: string
}

interface TransactionLine {
  id: string
  itemId: string
  nameSnapshot: string
  skuSnapshot: string | null
  quantity: number
  refundedQty: number
  unitPrice: string
  taxRate: string
  lineSubtotal: string
  lineTax: string
  lineTotal: string
}

interface TransactionDetail extends TransactionSummary {
  amountTendered: string | null
  changeDue: string | null
  discountAmount: string
  refundedAmount: string
  notes: string | null
  refundReason: string | null
  customerEmail: string | null
  lines: TransactionLine[]
}

function fmtMoney(n: string | number | null | undefined): string {
  if (n == null) return '$0.00'
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  return new Date(s).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function customerLabel(t: { customerFirstName: string | null; customerLastName: string | null; customerBusinessName: string | null }): string | null {
  if (t.customerBusinessName) return t.customerBusinessName
  const n = `${t.customerFirstName ?? ''} ${t.customerLastName ?? ''}`.trim()
  return n || null
}

export function POSPage() {
  const [tab, setTab] = useState<'register' | 'history'>('register')

  return (
    <div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'baseline', marginBottom: 16,
      }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, margin: 0 }}>
            Point of sale
          </h1>
          <div style={{ color: 'var(--text-2)', fontSize: 14, marginTop: 4 }}>
            Ring up sales at the register. Stock decrements automatically.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--bg-2)', borderRadius: 10 }}>
          <button onClick={() => setTab('register')}
            style={tab === 'register' ? tabBtnActive : tabBtn}>
            Register
          </button>
          <button onClick={() => setTab('history')}
            style={tab === 'history' ? tabBtnActive : tabBtn}>
            History
          </button>
        </div>
      </div>

      {tab === 'register' ? <RegisterTab /> : <HistoryTab />}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Register tab — left grid + right cart
// ─────────────────────────────────────────────────────────────────

function RegisterTab() {
  const [items, setItems] = useState<InventoryItem[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [search, setSearch] = useState('')
  const [cart, setCart] = useState<CartLine[]>([])
  const [customerId, setCustomerId] = useState<string>('')
  const [err, setErr] = useState<string | null>(null)
  const [showCheckout, setShowCheckout] = useState(false)
  const [lastReceipt, setLastReceipt] = useState<TransactionDetail | null>(null)

  const reload = async () => {
    setErr(null)
    try {
      const [list, cust] = await Promise.all([
        apiGet<InventoryItem[]>(`/business-inventory/items${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''}`),
        apiGet<Customer[]>('/business-customers'),
      ])
      setItems(list)
      setCustomers(cust)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load')
    }
  }
  useEffect(() => { reload() }, [search])

  const addToCart = (it: InventoryItem) => {
    if (it.stockQty <= 0) return
    setCart(prev => {
      const ex = prev.find(c => c.itemId === it.id)
      if (ex) {
        if (ex.qty >= ex.stockOnHand) return prev
        return prev.map(c => c.itemId === it.id ? { ...c, qty: c.qty + 1 } : c)
      }
      return [...prev, {
        itemId: it.id, name: it.name, sku: it.sku,
        unitPrice: Number(it.sellPrice),
        taxRate:   Number(it.taxRate),
        stockOnHand: it.stockQty,
        qty: 1,
      }]
    })
  }

  const updateQty = (id: string, delta: number) =>
    setCart(prev => prev
      .map(c => c.itemId === id ? { ...c, qty: Math.max(0, Math.min(c.stockOnHand, c.qty + delta)) } : c)
      .filter(c => c.qty > 0))

  const removeLine = (id: string) =>
    setCart(prev => prev.filter(c => c.itemId !== id))

  const totals = useMemo(() => {
    let subtotal = 0, tax = 0
    for (const c of cart) {
      const ls = c.unitPrice * c.qty
      subtotal += ls
      tax += ls * c.taxRate
    }
    return {
      subtotal: Math.round(subtotal * 100) / 100,
      tax:      Math.round(tax * 100) / 100,
      total:    Math.round((subtotal + tax) * 100) / 100,
    }
  }, [cart])

  if (lastReceipt) {
    return (
      <ReceiptView
        txn={lastReceipt}
        onDone={() => { setLastReceipt(null); setCart([]); setCustomerId(''); reload() }} />
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 16 }}>
      {/* Left: item grid */}
      <div>
        {err && <div style={errStyle}>{err}</div>}

        <div style={{ position: 'relative', marginBottom: 12 }}>
          <Search size={14} style={{
            position: 'absolute', left: 10, top: '50%',
            transform: 'translateY(-50%)', color: 'var(--text-3)',
          }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search name or SKU…"
            style={{ ...inputStyle, paddingLeft: 32, marginTop: 0 }}
            autoFocus />
        </div>

        {items.length === 0 ? (
          <div style={emptyStyle}>
            {search ? 'No items match.' : 'No inventory items yet. Add some on the Inventory page first.'}
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
            gap: 10,
          }}>
            {items.map(it => {
              const out = it.stockQty <= 0
              return (
                <button key={it.id}
                  onClick={() => addToCart(it)}
                  disabled={out}
                  style={{
                    padding: 12,
                    background: 'var(--bg-1)',
                    border: '1px solid var(--border-0)',
                    borderRadius: 10,
                    textAlign: 'left' as const,
                    cursor: out ? 'not-allowed' : 'pointer',
                    opacity: out ? 0.5 : 1,
                    display: 'flex', flexDirection: 'column' as const, gap: 4,
                    minHeight: 90,
                  }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-0)', lineHeight: 1.3 }}>
                    {it.name}
                  </div>
                  {it.sku && (
                    <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' as const }}>
                      {it.sku}
                    </div>
                  )}
                  <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--gold)' }}>
                      {fmtMoney(it.sellPrice)}
                    </span>
                    <span style={{ fontSize: 10, color: out ? 'var(--red, #ef4444)' : 'var(--text-3)' }}>
                      {out ? 'Out of stock' : `${it.stockQty} on hand`}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Right: cart */}
      <div style={{
        background: 'var(--bg-1)', border: '1px solid var(--border-0)',
        borderRadius: 12, padding: 16,
        display: 'flex', flexDirection: 'column' as const,
        position: 'sticky' as const, top: 16,
        maxHeight: 'calc(100vh - 100px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <ShoppingCart size={16} color="var(--gold)" />
          <h2 style={{ margin: 0, fontSize: 16, color: 'var(--text-0)' }}>Cart</h2>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-3)' }}>
            {cart.reduce((n, c) => n + c.qty, 0)} item{cart.reduce((n, c) => n + c.qty, 0) === 1 ? '' : 's'}
          </span>
        </div>

        <label style={labelStyle}>Customer (optional)</label>
        <select value={customerId}
          onChange={e => setCustomerId(e.target.value)}
          style={inputStyle}>
          <option value="">Walk-in</option>
          {customers.map(c => (
            <option key={c.id} value={c.id}>
              {c.businessName || `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'Unnamed'}
            </option>
          ))}
        </select>

        <div style={{
          flex: 1, overflowY: 'auto' as const, marginTop: 12,
          marginRight: -8, paddingRight: 8,
        }}>
          {cart.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-3)', textAlign: 'center' as const, padding: 24 }}>
              Tap an item to add it to the cart.
            </div>
          ) : cart.map(c => (
            <div key={c.itemId} style={{
              padding: '10px 0', borderBottom: '1px solid var(--border-0)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 8 }}>
                <div style={{ flex: 1, fontSize: 13, color: 'var(--text-0)', lineHeight: 1.3 }}>
                  {c.name}
                </div>
                <button onClick={() => removeLine(c.itemId)}
                  style={{
                    background: 'transparent', border: 'none',
                    color: 'var(--text-3)', cursor: 'pointer',
                    padding: 2,
                  }}>
                  <X size={14} />
                </button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                {fmtMoney(c.unitPrice)} ea · {(c.taxRate * 100).toFixed(2)}% tax
              </div>
              <div style={{
                display: 'flex' as const, justifyContent: 'space-between',
                alignItems: 'center', marginTop: 6,
              }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button onClick={() => updateQty(c.itemId, -1)} style={qtyBtn}>
                    <Minus size={12} />
                  </button>
                  <span style={{ fontFamily: 'var(--font-mono)' as const, minWidth: 24, textAlign: 'center' as const, fontSize: 14, fontWeight: 600 }}>
                    {c.qty}
                  </span>
                  <button onClick={() => updateQty(c.itemId, +1)}
                    disabled={c.qty >= c.stockOnHand}
                    style={qtyBtn}>
                    <Plus size={12} />
                  </button>
                </div>
                <strong style={{ fontFamily: 'var(--font-mono)' as const, fontSize: 14, color: 'var(--text-0)' }}>
                  {fmtMoney(c.unitPrice * c.qty * (1 + c.taxRate))}
                </strong>
              </div>
            </div>
          ))}
        </div>

        <div style={{
          marginTop: 12, paddingTop: 12,
          borderTop: '2px solid var(--border-1)',
        }}>
          <Row label="Subtotal" value={fmtMoney(totals.subtotal)} />
          <Row label="Tax"      value={fmtMoney(totals.tax)} />
          <Row label="Total"    value={fmtMoney(totals.total)} big />
          <button
            onClick={() => setShowCheckout(true)}
            disabled={cart.length === 0}
            style={{
              ...primaryBtnStyle,
              width: '100%', padding: '12px', fontSize: 15, marginTop: 12,
              justifyContent: 'center' as const,
              opacity: cart.length === 0 ? 0.5 : 1,
              cursor: cart.length === 0 ? 'not-allowed' : 'pointer',
            }}>
            Checkout
          </button>
        </div>
      </div>

      {showCheckout && (
        <CheckoutModal
          total={totals.total}
          subtotal={totals.subtotal}
          tax={totals.tax}
          cart={cart}
          customerId={customerId}
          onClose={() => setShowCheckout(false)}
          onSold={(txn) => { setShowCheckout(false); setLastReceipt(txn) }} />
      )}
    </div>
  )
}

function Row({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div style={{
      display: 'flex' as const, justifyContent: 'space-between',
      padding: '4px 0',
      fontSize: big ? 18 : 13,
      fontWeight: big ? 700 : 500,
      color: big ? 'var(--gold)' : 'var(--text-1)',
    }}>
      <span>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)' as const }}>{value}</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Checkout modal
// ─────────────────────────────────────────────────────────────────

function CheckoutModal({
  total, subtotal, tax, cart, customerId, onClose, onSold,
}: {
  total: number
  subtotal: number
  tax: number
  cart: CartLine[]
  customerId: string
  onClose: () => void
  onSold: (txn: TransactionDetail) => void
}) {
  const { business } = useAuth()
  const discountsEnabled = (business?.enabledFeatures ?? []).includes('discounts')

  const [method, setMethod] = useState<'cash' | 'card_recorded'>('cash')
  // S512: tip is added on top of the sale. Presets compute off the
  // pre-tax subtotal (US convention); custom is a flat dollar amount.
  const [tipPreset, setTipPreset] = useState<number | 'custom' | null>(null)
  const [customTip, setCustomTip] = useState('')
  const round2 = (n: number) => Math.round(n * 100) / 100

  // S513: optional discount code, previewed against the subtotal. The
  // discount is pre-tax, so the line tax scales down with it.
  const [discountInput, setDiscountInput] = useState('')
  const [applied, setApplied] = useState<{ code: string; discountAmount: number } | null>(null)
  const [discountErr, setDiscountErr] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const applyCode = async () => {
    setDiscountErr(null)
    if (!discountInput.trim()) return
    setApplying(true)
    try {
      const r = await apiPost<{ code: string; discountAmount: number }>(
        '/business-discounts/preview', { code: discountInput.trim(), subtotal })
      setApplied(r.data)
    } catch (e: any) {
      setApplied(null)
      setDiscountErr(e?.response?.data?.error || 'Invalid code')
    } finally { setApplying(false) }
  }
  const clearCode = () => { setApplied(null); setDiscountInput(''); setDiscountErr(null) }

  const discount = applied?.discountAmount ?? 0
  const discountedSubtotal = round2(subtotal - discount)
  const scaledTax = subtotal > 0 ? round2(tax * (discountedSubtotal / subtotal)) : tax
  const saleTotal = round2(discountedSubtotal + scaledTax)

  const tip = tipPreset === 'custom'
    ? Math.max(0, round2(Number(customTip) || 0))
    : tipPreset != null ? round2(subtotal * tipPreset) : 0
  const grandTotal = round2(saleTotal + tip)

  const [tendered, setTendered] = useState(String(total.toFixed(2)))
  const [tenderedTouched, setTenderedTouched] = useState(false)
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Keep tendered tracking the grand total until the cashier edits it.
  const tenderedNum = tenderedTouched ? Number(tendered) : grandTotal
  const change = method === 'cash' ? Math.max(0, tenderedNum - grandTotal) : 0

  const submit = async () => {
    setErr(null)
    if (method === 'cash' && tenderedNum < grandTotal) {
      setErr(`Tendered must be at least ${fmtMoney(grandTotal)}`)
      return
    }
    setSubmitting(true)
    try {
      const payload: any = {
        paymentMethod: method,
        notes: notes.trim() || null,
        lines: cart.map(c => ({ itemId: c.itemId, quantity: c.qty })),
      }
      if (customerId) payload.customerId = customerId
      if (tip > 0) payload.tipAmount = tip
      if (applied) payload.discountCode = applied.code
      if (method === 'cash') payload.amountTendered = tenderedNum
      const r = await apiPost<TransactionDetail>('/business-pos/transactions', payload)
      onSold(r.data)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Sale failed')
    } finally { setSubmitting(false) }
  }

  return (
    <Modal title="Checkout" onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={submitting} style={primaryBtnStyle}>
            {submitting ? 'Recording…' : `Complete sale — ${fmtMoney(grandTotal)}`}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}

      <div style={{ padding: 14, background: 'var(--bg-2)', borderRadius: 8, marginBottom: 16 }}>
        <Row label="Subtotal" value={fmtMoney(subtotal)} />
        {discount > 0 && <Row label={`Discount${applied ? ` (${applied.code})` : ''}`} value={`-${fmtMoney(discount)}`} />}
        <Row label="Tax"      value={fmtMoney(scaledTax)} />
        {tip > 0 && <Row label="Tip" value={fmtMoney(tip)} />}
        <Row label="Total"    value={fmtMoney(grandTotal)} big />
      </div>

      {discountsEnabled && (
        <>
          <label style={labelStyle}>Discount code (optional)</label>
          {applied ? (
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 12px', background: 'rgba(34,197,94,.08)',
              border: '1px solid var(--green, #22c55e)', borderRadius: 8,
            }}>
              <span style={{ fontSize: 13, color: 'var(--text-1)' }}>
                <strong style={{ fontFamily: 'var(--font-mono)' as const }}>{applied.code}</strong> — {fmtMoney(applied.discountAmount)} off
              </span>
              <button onClick={clearCode} style={{ ...ghostBtn, padding: '4px 10px' }}>Remove</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={discountInput}
                onChange={e => setDiscountInput(e.target.value.toUpperCase())}
                onKeyDown={e => { if (e.key === 'Enter') applyCode() }}
                placeholder="SUMMER20"
                style={{ ...inputStyle, marginTop: 0, fontFamily: 'var(--font-mono)' as const }} />
              <button onClick={applyCode} disabled={applying || !discountInput.trim()} style={ghostBtn}>
                {applying ? '…' : 'Apply'}
              </button>
            </div>
          )}
          {discountErr && <div style={{ fontSize: 12, color: 'var(--red, #ef4444)', marginTop: 6 }}>{discountErr}</div>}
        </>
      )}

      <label style={labelStyle}>Tip (optional)</label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
        {([['None', null], ['15%', 0.15], ['18%', 0.18], ['20%', 0.20], ['Custom', 'custom']] as const).map(([lbl, val]) => {
          const active = tipPreset === val
          return (
            <button key={lbl}
              onClick={() => { setTipPreset(val); if (val !== 'custom') setCustomTip('') }}
              style={{
                flex: '1 1 0', minWidth: 56, padding: '8px 4px',
                background: active ? 'rgba(212,175,55,.12)' : 'var(--bg-2)',
                border: `1px solid ${active ? 'var(--gold)' : 'var(--border-1)'}`,
                borderRadius: 8,
                color: active ? 'var(--gold)' : 'var(--text-1)',
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}>
              {lbl}
            </button>
          )
        })}
      </div>
      {tipPreset === 'custom' && (
        <input
          type="number" step="0.01" min={0}
          value={customTip}
          onChange={e => setCustomTip(e.target.value)}
          placeholder="Tip amount"
          style={{ ...inputStyle, marginTop: 8, fontFamily: 'var(--font-mono)' as const }}
          autoFocus />
      )}

      <label style={labelStyle}>Payment method</label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {(['cash', 'card_recorded'] as const).map(m => (
          <button key={m}
            onClick={() => setMethod(m)}
            style={{
              padding: 12,
              background: method === m ? 'rgba(212,175,55,.12)' : 'var(--bg-2)',
              border: `1px solid ${method === m ? 'var(--gold)' : 'var(--border-1)'}`,
              borderRadius: 8,
              color: method === m ? 'var(--gold)' : 'var(--text-1)',
              fontSize: 13, fontWeight: 600,
              cursor: 'pointer',
              textAlign: 'center' as const,
            }}>
            {m === 'cash' ? 'Cash' : 'Card (recorded)'}
          </button>
        ))}
      </div>

      {method === 'cash' && (
        <>
          <label style={labelStyle}>Amount tendered</label>
          <input
            type="number" step="0.01" min={grandTotal}
            value={tenderedTouched ? tendered : grandTotal.toFixed(2)}
            onChange={e => { setTenderedTouched(true); setTendered(e.target.value) }}
            style={{ ...inputStyle, fontSize: 20, fontFamily: 'var(--font-mono)' as const }} />
          <div style={{
            marginTop: 12, padding: 12,
            background: 'var(--bg-2)', borderRadius: 8,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: 13, color: 'var(--text-2)' }}>Change due</span>
            <strong style={{ fontSize: 18, color: 'var(--gold)', fontFamily: 'var(--font-mono)' as const }}>
              {fmtMoney(change)}
            </strong>
          </div>
        </>
      )}

      {method === 'card_recorded' && (
        <div style={{
          padding: 12, marginTop: 12,
          background: 'rgba(245,158,11,.08)',
          border: '1px solid rgba(245,158,11,.4)',
          borderRadius: 8,
          fontSize: 12, color: 'var(--text-1)',
          display: 'flex', gap: 8, alignItems: 'start',
        }}>
          <AlertTriangle size={14} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 2 }} />
          <span>Run the card on your terminal first. GAM just records the sale + decrements stock — it does not charge the card.</span>
        </div>
      )}

      <label style={labelStyle}>Notes (optional)</label>
      <input value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder="Comp / split tender / etc."
        style={inputStyle} />
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Receipt view (post-sale)
// ─────────────────────────────────────────────────────────────────

function ReceiptView({ txn, onDone }: { txn: TransactionDetail; onDone: () => void }) {
  return (
    <div style={{ maxWidth: 480, margin: '0 auto' }}>
      <div style={{
        padding: 32, background: 'var(--bg-1)',
        border: '1px solid var(--border-0)', borderRadius: 12,
        textAlign: 'center' as const, marginBottom: 16,
      }}>
        <Receipt size={48} color="var(--gold)" style={{ marginBottom: 12 }} />
        <h2 style={{ margin: 0, fontSize: 22, color: 'var(--text-0)' }}>Sale complete</h2>
        <div style={{ color: 'var(--text-2)', fontSize: 14, marginTop: 6 }}>
          {txn.receiptNumber}
        </div>
      </div>

      <div style={{
        background: 'var(--bg-1)', border: '1px solid var(--border-0)',
        borderRadius: 12, padding: 20, marginBottom: 16,
      }}>
        {txn.lines.map(ln => (
          <div key={ln.id} style={{
            display: 'flex' as const, justifyContent: 'space-between',
            padding: '6px 0', fontSize: 13, color: 'var(--text-1)',
          }}>
            <span>{ln.quantity} × {ln.nameSnapshot}</span>
            <span style={{ fontFamily: 'var(--font-mono)' as const }}>{fmtMoney(ln.lineTotal)}</span>
          </div>
        ))}
        <div style={{ borderTop: '1px solid var(--border-1)', marginTop: 12, paddingTop: 12 }}>
          <Row label="Subtotal" value={fmtMoney(txn.subtotal)} />
          {Number(txn.discountAmount) > 0 && <Row label="Discount" value={`-${fmtMoney(txn.discountAmount)}`} />}
          <Row label="Tax"      value={fmtMoney(txn.taxAmount)} />
          {Number(txn.tipAmount) > 0 && <Row label="Tip" value={fmtMoney(txn.tipAmount)} />}
          <Row label="Total"    value={fmtMoney(Number(txn.totalAmount) + Number(txn.tipAmount ?? 0))} big />
        </div>
        {txn.paymentMethod === 'cash' && txn.changeDue !== null && (
          <div style={{
            marginTop: 12, padding: 12,
            background: 'var(--bg-2)', borderRadius: 8,
          }}>
            <Row label="Tendered" value={fmtMoney(txn.amountTendered)} />
            <Row label="Change"   value={fmtMoney(txn.changeDue)} big />
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => openPdfInNewTab(`/business-pos/transactions/${txn.id}/pdf`)}
          style={{
            ...ghostBtn,
            flex: 1, padding: '14px', fontSize: 15,
            justifyContent: 'center' as const,
          }}>
          <Printer size={14} /> Print receipt
        </button>
        <button onClick={onDone} style={{
          ...primaryBtnStyle, flex: 1, padding: '14px', fontSize: 15,
          justifyContent: 'center' as const,
        }}>
          New sale
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
//  History tab
// ─────────────────────────────────────────────────────────────────

function HistoryTab() {
  const [list, setList] = useState<TransactionSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const reload = async () => {
    setErr(null)
    try {
      const rows = await apiGet<TransactionSummary[]>('/business-pos/transactions')
      setList(rows)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load')
    }
  }
  useEffect(() => { reload() }, [])

  if (selectedId) {
    return <HistoryDetail id={selectedId} onBack={() => { setSelectedId(null); reload() }} />
  }

  return (
    <div>
      {err && <div style={errStyle}>{err}</div>}

      {list.length === 0 ? (
        <div style={emptyStyle}>No sales yet. Ring one up on the Register tab.</div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
              <th style={thStyle}>Receipt</th>
              <th style={thStyle}>Date</th>
              <th style={thStyle}>Customer</th>
              <th style={thStyle}>Payment</th>
              <th style={thStyle}>Total</th>
              <th style={thStyle}>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.map(t => (
              <tr key={t.id}
                onClick={() => setSelectedId(t.id)}
                style={{ borderBottom: '1px solid var(--border-0)', cursor: 'pointer' }}>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, color: 'var(--text-0)' }}>
                  {t.receiptNumber}
                </td>
                <td style={tdStyle}>{fmtDate(t.createdAt)}</td>
                <td style={tdStyle}>{customerLabel(t) ?? <span style={{ color: 'var(--text-3)' }}>Walk-in</span>}</td>
                <td style={tdStyle}>
                  {t.paymentMethod === 'cash' ? 'Cash'
                  : t.paymentMethod === 'card_recorded' ? 'Card'
                  : t.paymentMethod}
                </td>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, fontWeight: 600 }}>
                  {fmtMoney(Number(t.totalAmount) + Number(t.tipAmount ?? 0))}
                </td>
                <td style={tdStyle}>
                  <StatusBadge status={t.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function HistoryDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [txn, setTxn] = useState<TransactionDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [showRefund, setShowRefund] = useState(false)

  const reload = async () => {
    setErr(null)
    try {
      const d = await apiGet<TransactionDetail>(`/business-pos/transactions/${id}`)
      setTxn(d)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load')
    }
  }
  useEffect(() => { reload() }, [id])

  if (!txn) return (
    <div>
      <button onClick={onBack} style={ghostBtn}><ArrowLeft size={14} /> Back</button>
      {err && <div style={errStyle}>{err}</div>}
      <div style={{ marginTop: 16, color: 'var(--text-2)' }}>Loading…</div>
    </div>
  )

  return (
    <div>
      <button onClick={onBack} style={ghostBtn}>
        <ArrowLeft size={14} /> Back to history
      </button>
      {err && <div style={{ ...errStyle, marginTop: 16 }}>{err}</div>}

      <div style={{
        marginTop: 16, padding: 24,
        background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 12,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 16 }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: 0 }}>
              {txn.receiptNumber}
            </h1>
            <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 4 }}>
              {fmtDate(txn.createdAt)} · {customerLabel(txn) ?? 'Walk-in'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <StatusBadge status={txn.status} />
            <button onClick={() => openPdfInNewTab(`/business-pos/transactions/${txn.id}/pdf`)}
              style={ghostBtn}>
              <Printer size={12} /> Print
            </button>
            {(txn.status === 'completed' || txn.status === 'partially_refunded') && (
              <button onClick={() => setShowRefund(true)} style={ghostBtn}>
                <RotateCcw size={12} /> Refund
              </button>
            )}
          </div>
        </div>

        {(txn.status === 'refunded' || txn.status === 'partially_refunded') && txn.refundReason && (
          <div style={{
            padding: 12, marginBottom: 16,
            background: 'rgba(245,158,11,.06)',
            border: '1px solid rgba(245,158,11,.4)',
            borderRadius: 8, fontSize: 13, color: 'var(--text-1)',
          }}>
            <strong>{txn.status === 'partially_refunded' ? 'Partial refund' : 'Refunded'} — {fmtMoney(txn.refundedAmount)}:</strong> {txn.refundReason}
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
              {fmtDate(txn.refundedAt)}
            </div>
          </div>
        )}

        <table style={{ ...tableStyle, marginBottom: 16 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
              <th style={thStyle}>Item</th>
              <th style={thStyle}>Qty</th>
              <th style={thStyle}>Unit</th>
              <th style={thStyle}>Tax</th>
              <th style={thStyle}>Total</th>
            </tr>
          </thead>
          <tbody>
            {txn.lines.map(ln => (
              <tr key={ln.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                <td style={tdStyle}>
                  <strong>{ln.nameSnapshot}</strong>
                  {ln.skuSnapshot && (
                    <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' as const }}>
                      {ln.skuSnapshot}
                    </div>
                  )}
                </td>
                <td style={tdStyle}>{ln.quantity}</td>
                <td style={tdStyle}>{fmtMoney(ln.unitPrice)}</td>
                <td style={tdStyle}>{fmtMoney(ln.lineTax)}</td>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' as const, fontWeight: 600 }}>
                  {fmtMoney(ln.lineTotal)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ padding: 14, background: 'var(--bg-2)', borderRadius: 8 }}>
          <Row label="Subtotal" value={fmtMoney(txn.subtotal)} />
          {Number(txn.discountAmount) > 0 && <Row label="Discount" value={`-${fmtMoney(txn.discountAmount)}`} />}
          <Row label="Tax"      value={fmtMoney(txn.taxAmount)} />
          {Number(txn.tipAmount) > 0 && <Row label="Tip" value={fmtMoney(txn.tipAmount)} />}
          <Row label="Total"    value={fmtMoney(Number(txn.totalAmount) + Number(txn.tipAmount ?? 0))} big />
          {txn.paymentMethod === 'cash' && txn.amountTendered !== null && (
            <>
              <Row label="Tendered" value={fmtMoney(txn.amountTendered)} />
              <Row label="Change"   value={fmtMoney(txn.changeDue)} />
            </>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
            Payment: {txn.paymentMethod === 'cash' ? 'Cash' : txn.paymentMethod === 'card_recorded' ? 'Card (recorded outside GAM)' : txn.paymentMethod}
          </div>
        </div>

        {txn.notes && (
          <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-2)' }}>
            <strong style={{ color: 'var(--text-1)' }}>Notes:</strong> {txn.notes}
          </div>
        )}
      </div>

      {showRefund && (
        <RefundModal txn={txn}
          onClose={() => setShowRefund(false)}
          onDone={() => { setShowRefund(false); reload() }} />
      )}
    </div>
  )
}

function RefundModal({
  txn, onClose, onDone,
}: {
  txn: TransactionDetail
  onClose: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState('')
  const [mode, setMode] = useState<'full' | 'lines'>('full')
  // Per-line refund quantities, keyed by line id. Default 0.
  const [qtys, setQtys] = useState<Record<string, number>>({})
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const remainingOf = (l: TransactionLine) => l.quantity - l.refundedQty
  const refundableLines = txn.lines.filter(l => remainingOf(l) > 0)
  const setQty = (id: string, max: number, v: string) => {
    const n = Math.max(0, Math.min(max, Math.floor(Number(v) || 0)))
    setQtys(prev => ({ ...prev, [id]: n }))
  }

  const submit = async () => {
    setErr(null)
    if (!reason.trim()) { setErr('Reason required'); return }
    const payload: any = { reason: reason.trim() }
    if (mode === 'lines') {
      const lines = refundableLines
        .map(l => ({ lineId: l.id, quantity: qtys[l.id] ?? 0 }))
        .filter(l => l.quantity > 0)
      if (lines.length === 0) { setErr('Pick at least one item to refund'); return }
      payload.lines = lines
    }
    setSubmitting(true)
    try {
      await apiPost(`/business-pos/transactions/${txn.id}/refund`, payload)
      onDone()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Refund failed')
    } finally { setSubmitting(false) }
  }

  return (
    <Modal title={`Refund ${txn.receiptNumber}`} onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={submitting} style={primaryBtnStyle}>
            {submitting ? 'Refunding…' : 'Record refund'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}
      <div style={{
        padding: 12, marginBottom: 12,
        background: 'rgba(245,158,11,.08)',
        border: '1px solid rgba(245,158,11,.4)',
        borderRadius: 8, fontSize: 12, color: 'var(--text-1)',
        display: 'flex', gap: 8, alignItems: 'start',
      }}>
        <AlertTriangle size={14} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 2 }} />
        <span>
          Refunded items go back into inventory. Run the actual refund on your card terminal
          separately — GAM only records the bookkeeping.
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(['full', 'lines'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)} style={{
            flex: 1, padding: 10,
            background: mode === m ? 'rgba(212,175,55,.12)' : 'var(--bg-2)',
            border: `1px solid ${mode === m ? 'var(--gold)' : 'var(--border-1)'}`,
            borderRadius: 8, color: mode === m ? 'var(--gold)' : 'var(--text-1)',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>{m === 'full' ? 'Everything remaining' : 'Pick items'}</button>
        ))}
      </div>

      {mode === 'lines' && (
        <div style={{ marginBottom: 12 }}>
          {refundableLines.map(l => {
            const max = remainingOf(l)
            return (
              <div key={l.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '8px 0', borderBottom: '1px solid var(--border-0)',
              }}>
                <div style={{ fontSize: 13, color: 'var(--text-1)' }}>
                  {l.nameSnapshot}
                  <span style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 6 }}>
                    {max} of {l.quantity} refundable
                  </span>
                </div>
                <input type="number" min={0} max={max} value={qtys[l.id] ?? 0}
                  onChange={e => setQty(l.id, max, e.target.value)}
                  style={{ ...inputStyle, width: 70, marginTop: 0, textAlign: 'center' as const }} />
              </div>
            )
          })}
        </div>
      )}

      <label style={labelStyle}>Reason</label>
      <input value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder="Customer returned item / wrong charge / etc."
        style={inputStyle} />
    </Modal>
  )
}

function StatusBadge({ status }: { status: 'completed' | 'partially_refunded' | 'refunded' | 'void' }) {
  const color = status === 'completed' ? 'var(--green, #22c55e)'
              : status === 'refunded' || status === 'partially_refunded' ? 'var(--amber)'
              : 'var(--text-3)'
  return (
    <span style={{
      padding: '3px 8px', fontSize: 11, fontWeight: 700,
      textTransform: 'uppercase' as const, letterSpacing: 0.5,
      border: `1px solid ${color}`, color, borderRadius: 4,
    }}>{status.replace('_', ' ')}</span>
  )
}

// ─────────────────────────────────────────────────────────────────
//  Styles
// ─────────────────────────────────────────────────────────────────

const tabBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: 'transparent', color: 'var(--text-2)',
  border: 'none', borderRadius: 6,
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
}
const tabBtnActive: React.CSSProperties = {
  ...tabBtn, background: 'var(--bg-1)', color: 'var(--gold)',
}
const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse' as const,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, overflow: 'hidden' as const,
}
const thStyle: React.CSSProperties = {
  textAlign: 'left' as const, padding: '12px 16px',
  fontSize: 12, color: 'var(--text-2)',
  textTransform: 'uppercase' as const, letterSpacing: 1,
  background: 'var(--bg-2)', fontWeight: 600,
}
const tdStyle: React.CSSProperties = {
  padding: '12px 16px', fontSize: 14, color: 'var(--text-1)',
}
const labelStyle: React.CSSProperties = {
  display: 'block' as const, fontSize: 12, color: 'var(--text-2)',
  marginBottom: 6, marginTop: 12,
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 14, boxSizing: 'border-box' as const,
}
const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 14px', background: 'var(--gold)', color: 'var(--bg-0)',
  border: 'none', borderRadius: 8,
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const ghostBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'transparent', color: 'var(--text-1)',
  border: '1px solid var(--border-1)', borderRadius: 8,
  fontSize: 13, fontWeight: 500, cursor: 'pointer',
  display: 'inline-flex' as const, alignItems: 'center', gap: 6,
}
const qtyBtn: React.CSSProperties = {
  padding: 4, background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 6,
  cursor: 'pointer', display: 'inline-flex' as const, alignItems: 'center',
}
const errStyle: React.CSSProperties = {
  marginBottom: 12, padding: '10px 12px',
  background: 'var(--red-bg)', color: 'var(--red, #ef4444)',
  border: '1px solid var(--red-dim, #ef4444)', borderRadius: 8, fontSize: 13,
}
const emptyStyle: React.CSSProperties = {
  padding: 32, textAlign: 'center' as const,
  background: 'var(--bg-1)', border: '1px solid var(--border-0)',
  borderRadius: 12, color: 'var(--text-2)', fontSize: 14,
  marginBottom: 16,
}
