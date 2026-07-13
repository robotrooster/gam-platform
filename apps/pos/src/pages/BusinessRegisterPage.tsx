// S536 (Nic): the POS portal is THE front-counter product for every
// operator type. This is the business-mode register — a port of
// apps/business/src/pages/POSPage.tsx wired to the same business-pos
// backend (S497). Property-mode landlords keep POSPage.tsx; business
// logins (business_owner / business_staff) land here. Keep the two
// copies in sync when register behavior changes.
import { useEffect, useMemo, useRef, useState } from 'react'
import { humanize } from '@gam/shared'
import { apiGet, apiPatch, apiPost } from '../lib/api'
import { Modal } from '../components/Modal'
import { useAuth } from '../context/AuthContext'
import {
  Search, Plus, Minus, X, ShoppingCart, Receipt, ArrowLeft,
  AlertTriangle, RotateCcw, Mail,
} from 'lucide-react'



// S536 (Nic): browser-neutral — no window.prompt/alert (Safari
// suppresses them; webviews drop them entirely). Email receipts run
// through a real in-app modal.
function EmailReceiptModal({ txnId, prefill, onClose }: { txnId: string; prefill: string | null; onClose: () => void }) {
  const [to, setTo] = useState(prefill ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const send = async () => {
    setBusy(true); setMsg(null)
    try {
      await apiPost(`/business-pos/transactions/${txnId}/email-receipt`, { email: to.trim() })
      setMsg({ ok: true, text: `Receipt sent to ${to.trim()}` })
    } catch (e: any) {
      setMsg({ ok: false, text: e?.response?.data?.error?.message || e?.response?.data?.error || 'Could not send the receipt' })
    } finally { setBusy(false) }
  }

  return (
    <Modal title="Email receipt" onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>{msg?.ok ? 'Done' : 'Cancel'}</button>
          <button onClick={send} disabled={busy || !/.+@.+\..+/.test(to.trim())} style={primaryBtnStyle}>
            {busy ? 'Sending…' : msg?.ok ? 'Send again' : 'Send receipt'}
          </button>
        </>
      }>
      <label style={labelStyle}>Send to</label>
      <input value={to} onChange={e => setTo(e.target.value)} placeholder="customer@example.com" style={inputStyle} autoFocus />
      {msg && (
        <div style={{ marginTop: 10, fontSize: 13, color: msg.ok ? 'var(--green, #22c55e)' : 'var(--red, #ef4444)' }}>
          {msg.text}
        </div>
      )}
    </Modal>
  )
}

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

export function BusinessRegisterPage() {
  const [tab, setTab] = useState<'register' | 'history' | 'customers'>('register')

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
          <button onClick={() => setTab('customers')}
            style={tab === 'customers' ? tabBtnActive : tabBtn}>
            Customers
          </button>
        </div>
      </div>

      {tab === 'register' ? <RegisterTab /> : tab === 'history' ? <HistoryTab /> : <CustomersTab />}
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

  // S536 (Nic): typed quantity — 40 gallons shouldn't take 40 clicks.
  // Clamped to stock on hand like every other path.
  const setQtyAbs = (id: string, target: number) =>
    setCart(prev => prev
      .map(c => c.itemId === id ? { ...c, qty: Math.max(0, Math.min(c.stockOnHand, Math.floor(target))) } : c)
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
            {search ? 'No items match.' : 'No inventory items yet. Add items in your Business portal under Inventory.'}
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
        {/* S536 (Nic): typeable box for repeat customers, not a dropdown —
            type a few letters, pick from matches, or quick-add someone new. */}
        <CustomerPicker
          customers={customers}
          customerId={customerId}
          onPick={setCustomerId}
          onCreated={(c: Customer) => { setCustomers(prev => [c, ...prev]); setCustomerId(c.id) }}
        />

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
                  <input type="number" min={0} value={c.qty}
                    onFocus={e => e.currentTarget.select()}
                    onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) setQtyAbs(c.itemId, v) }}
                    style={{ fontFamily: 'var(--font-mono)' as const, width: 48, textAlign: 'center' as const, fontSize: 14, fontWeight: 600, background: 'var(--bg-3)', border: '1px solid var(--border-1)', borderRadius: 4, color: 'var(--text-0)', padding: '2px 0' }} />
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
  // S536: /business-pos/register-config is readable by every register
  // user (staff included) — tips toggle, card-fee payer, discounts gate.
  const [regCfg, setRegCfg] = useState<{ tipsEnabled: boolean; cardFeesPaidBy: string; discountsEnabled: boolean } | null>(null)
  useEffect(() => {
    apiGet<any>('/business-pos/register-config').then(setRegCfg).catch(() => setRegCfg(null))
  }, [])
  const discountsEnabled = regCfg?.discountsEnabled ?? false
  const tipsAllowed = regCfg ? regCfg.tipsEnabled !== false : true
  const customerPaysCardFee = regCfg?.cardFeesPaidBy === 'customer'

  const [method, setMethod] = useState<'cash' | 'card_recorded' | 'card_reader'>('cash')
  // S536 (Nic): card payments run on a paired Stripe Terminal reader —
  // tap/swipe completes the sale, no double workflow. Readers are set
  // up in Settings; when at least one exists, "Card — reader" replaces
  // the recorded-only option.
  const [readers, setReaders] = useState<any[]>([])
  const [readerId, setReaderId] = useState<string>('')
  const [charging, setCharging] = useState<string | null>(null)
  const chargeAbortRef = useRef(false)
  useEffect(() => {
    apiGet<any[]>('/business-pos/terminal/readers')
      .then(rs => { setReaders(rs || []); if ((rs || [])[0]) setReaderId(rs[0].stripeReaderId) })
      .catch(() => setReaders([]))
  }, [])
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
  // Customer-paid card fee (2.9% + 10¢) — added on top at the reader;
  // the server computes the authoritative amount, this mirrors it.
  const cardFee = customerPaysCardFee ? Math.round(grandTotal * 2.9) / 100 + 0.10 : 0
  const tenderedNum = tenderedTouched ? Number(tendered) : grandTotal
  const change = method === 'cash' ? Math.max(0, tenderedNum - grandTotal) : 0

  const submit = async () => {
    setErr(null)
    if (method === 'cash' && tenderedNum < grandTotal) {
      setErr(`Tendered must be at least ${fmtMoney(grandTotal)}`)
      return
    }
    const payloadBase: any = {
      notes: notes.trim() || null,
      lines: cart.map(c => ({ itemId: c.itemId, quantity: c.qty })),
    }
    if (customerId) payloadBase.customerId = customerId
    if (tip > 0) payloadBase.tipAmount = tip
    if (applied) payloadBase.discountCode = applied.code

    // Reader path: create+push the PaymentIntent, wait for the tap /
    // swipe (polling; the GET auto-captures on success), then record
    // the sale with the proven PI.
    if (method === 'card_reader') {
      if (!readerId) { setErr('No reader selected'); return }
      setSubmitting(true)
      chargeAbortRef.current = false
      let piId: string | null = null
      try {
        const chargeRes = await apiPost<any>('/business-pos/terminal/charge', {
          amountCents: Math.round(grandTotal * 100), stripeReaderId: readerId })
        piId = chargeRes.data.paymentIntentId
        setCharging('Waiting for tap / swipe on the reader…')
        const deadline = Date.now() + 120_000
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 1600))
          if (chargeAbortRef.current) {
            await apiPost(`/business-pos/terminal/payment-intents/${piId}/cancel`, {}).catch(() => {})
            setCharging(null); setSubmitting(false); return
          }
          const st = await apiGet<any>(`/business-pos/terminal/payment-intents/${piId}`)
          if (st.status === 'succeeded') {
            const r = await apiPost<TransactionDetail>('/business-pos/transactions', {
              ...payloadBase, paymentMethod: 'stripe_terminal', stripePaymentIntentId: piId })
            setCharging(null)
            onSold(r.data)
            return
          }
          if (st.status === 'canceled') {
            setErr('Payment was canceled at the reader'); setCharging(null); setSubmitting(false); return
          }
        }
        await apiPost(`/business-pos/terminal/payment-intents/${piId}/cancel`, {}).catch(() => {})
        setErr('Reader timed out — no card was presented'); setCharging(null); setSubmitting(false)
      } catch (e: any) {
        if (piId) await apiPost(`/business-pos/terminal/payment-intents/${piId}/cancel`, {}).catch(() => {})
        setErr(e?.response?.data?.error || 'Card charge failed'); setCharging(null); setSubmitting(false)
      }
      return
    }

    setSubmitting(true)
    try {
      const payload: any = { ...payloadBase, paymentMethod: method }
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
          {charging
            ? <button onClick={() => { chargeAbortRef.current = true }} style={ghostBtn}>Cancel card payment</button>
            : <button onClick={onClose} style={ghostBtn}>Cancel</button>}
          <button onClick={submit} disabled={submitting} style={primaryBtnStyle}>
            {charging ? 'Waiting for card…' : submitting ? 'Recording…' : `Complete sale — ${fmtMoney(method === 'card_reader' ? grandTotal + cardFee : grandTotal)}`}
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

      {tipsAllowed && (<>
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
      </>)}

      <label style={labelStyle}>Payment method</label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {((readers.length ? ['cash', 'card_reader'] : ['cash', 'card_recorded']) as any[]).map(m => (
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
            {m === 'cash' ? 'Cash' : m === 'card_reader' ? 'Card — reader' : 'Card (recorded)'}
          </button>
        ))}
      </div>

      {method === 'card_reader' && (
        <>
          {readers.length > 1 && (
            <>
              <label style={labelStyle}>Reader</label>
              <select value={readerId} onChange={e => setReaderId(e.target.value)}
                style={{ ...inputStyle, cursor: 'pointer' }}>
                {readers.map(r => <option key={r.id} value={r.stripeReaderId}>{r.nickname}</option>)}
              </select>
            </>
          )}
          {customerPaysCardFee && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 13, color: 'var(--text-1)' }}>
              <span>Card fee (paid by customer)</span>
              <strong style={{ fontFamily: 'var(--font-mono)' as const }}>{fmtMoney(cardFee)}</strong>
            </div>
          )}
          <div style={{
            padding: 12, marginTop: 12,
            background: charging ? 'rgba(212,175,55,.10)' : 'var(--bg-2)',
            border: `1px solid ${charging ? 'var(--gold)' : 'var(--border-1)'}`,
            borderRadius: 8, fontSize: 12, color: 'var(--text-1)',
          }}>
            {charging ?? 'Completing the sale sends the amount to the reader — the customer taps or swipes and the transaction finishes on its own.'}
          </div>
        </>
      )}

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
  const [emailOpen, setEmailOpen] = useState(false)
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
          {Number((txn as any).cardSurcharge) > 0 && <Row label="Card fee" value={fmtMoney((txn as any).cardSurcharge)} />}
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
        <button onClick={() => setEmailOpen(true)}
          style={{
            ...ghostBtn,
            flex: 1, padding: '14px', fontSize: 15,
            justifyContent: 'center' as const,
          }}>
          <Mail size={14} /> Email receipt
        </button>
        {emailOpen && <EmailReceiptModal txnId={txn.id} prefill={txn.customerEmail} onClose={() => setEmailOpen(false)} />}
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


// S536 (Nic): typeable customer picker + inline quick-add. The old
// dropdown didn't scale past a handful of repeat customers and offered
// no way to add one at the register.
function customerDisplay(c: any): string {
  return c.businessName || c.companyName || `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'Unnamed'
}

function CustomerPicker({ customers, customerId, onPick, onCreated }: {
  customers: any[]
  customerId: string
  onPick: (id: string) => void
  onCreated: (c: any) => void
}) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const selected = customers.find(c => c.id === customerId)

  const q = text.trim().toLowerCase()
  const matches = q
    ? customers.filter(c =>
        customerDisplay(c).toLowerCase().includes(q) ||
        (c.phone ?? '').includes(q) || (c.email ?? '').toLowerCase().includes(q)
      ).slice(0, 8)
    : customers.slice(0, 8)

  return (
    <div style={{ position: 'relative' }}>
      {selected ? (
        <div style={{ ...inputStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{customerDisplay(selected)}</span>
          <button onClick={() => { onPick(''); setText('') }}
            style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 13 }}>×</button>
        </div>
      ) : (
        <input
          value={text}
          placeholder="Walk-in — type to find a customer…"
          onChange={e => { setText(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 180)}
          style={inputStyle} />
      )}
      {open && !selected && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30,
          background: 'var(--bg-1)', border: '1px solid var(--border-0)',
          borderRadius: 8, marginTop: 4, overflow: 'hidden', maxHeight: 280, overflowY: 'auto',
        }}>
          {matches.map(c => (
            <div key={c.id}
              onMouseDown={() => { onPick(c.id); setOpen(false) }}
              style={{ padding: '9px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--text-0)', borderBottom: '1px solid var(--border-1)' }}>
              {customerDisplay(c)}
              {(c.phone || c.email) && <span style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 8 }}>{c.phone || c.email}</span>}
            </div>
          ))}
          <div onMouseDown={() => { setShowAdd(true); setOpen(false) }}
            style={{ padding: '9px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: 'var(--gold)' }}>
            ＋ New customer{text.trim() ? ` — "${text.trim()}"` : ''}
          </div>
        </div>
      )}
      {showAdd && (
        <QuickAddCustomer
          seedName={text.trim()}
          onClose={() => setShowAdd(false)}
          onCreated={(c: any) => { setShowAdd(false); setText(''); onCreated(c) }} />
      )}
    </div>
  )
}

function QuickAddCustomer({ seedName, onClose, onCreated }: {
  seedName: string
  onClose: () => void
  onCreated: (c: any) => void
}) {
  const parts = seedName.split(/\s+/)
  const [firstName, setFirstName] = useState(parts[0] ?? '')
  const [lastName, setLastName] = useState(parts.slice(1).join(' '))
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    setErr(null); setBusy(true)
    try {
      const body: any = { customerType: 'individual', firstName: firstName.trim(), lastName: lastName.trim() }
      if (phone.trim()) body.phone = phone.trim()
      if (email.trim()) body.email = email.trim()
      const r = await apiPost<any>('/business-customers', body)
      onCreated(r.data)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Could not add customer')
    } finally { setBusy(false) }
  }

  return (
    <Modal title="New customer" onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={save} disabled={busy || !firstName.trim() || !lastName.trim()} style={primaryBtnStyle}>
            {busy ? 'Saving…' : 'Add customer'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}
      <label style={labelStyle}>First name</label>
      <input value={firstName} onChange={e => setFirstName(e.target.value)} style={inputStyle} autoFocus />
      <label style={labelStyle}>Last name</label>
      <input value={lastName} onChange={e => setLastName(e.target.value)} style={inputStyle} />
      <label style={labelStyle}>Phone (optional)</label>
      <input value={phone} onChange={e => setPhone(e.target.value)} style={inputStyle} />
      <label style={labelStyle}>Email (optional — for receipts)</label>
      <input value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} />
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
        Address and more details can be added later in Customers.
      </div>
    </Modal>
  )
}


// S536 (Nic): end-of-day cash reconciliation — the standard control for
// what software can't see. Expected drawer vs counted, over/short.
function CashReportCard() {
  const today = new Date().toLocaleDateString('en-CA')
  const [date, setDate] = useState(today)
  const [report, setReport] = useState<any>(null)
  const [counted, setCounted] = useState('')

  useEffect(() => {
    apiGet<any>(`/business-pos/cash-report?date=${date}`).then(setReport).catch(() => setReport(null))
  }, [date])

  const countedNum = Number(counted)
  const overShort = report && counted !== '' && !isNaN(countedNum)
    ? Math.round((countedNum - report.expectedDrawer) * 100) / 100
    : null

  return (
    <div style={{
      marginBottom: 16, padding: 16,
      background: 'var(--bg-1)', border: '1px solid var(--border-0)', borderRadius: 12,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <strong style={{ fontSize: 14, color: 'var(--text-0)' }}>Daily cash report</strong>
        <input type="date" value={date} max={today} onChange={e => setDate(e.target.value)}
          style={{ background: 'var(--bg-2)', border: '1px solid var(--border-1)', borderRadius: 6, color: 'var(--text-0)', padding: '4px 8px', fontSize: 12 }} />
      </div>
      {report ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, fontSize: 13 }}>
            <div><div style={{ color: 'var(--text-3)', fontSize: 11 }}>CASH SALES ({report.cashSales})</div><strong style={{ fontFamily: 'var(--font-mono)' as const }}>{fmtMoney(report.cashCollected)}</strong></div>
            <div><div style={{ color: 'var(--text-3)', fontSize: 11 }}>CASH REFUNDS</div><strong style={{ fontFamily: 'var(--font-mono)' as const }}>-{fmtMoney(report.cashRefunded)}</strong></div>
            <div><div style={{ color: 'var(--text-3)', fontSize: 11 }}>EXPECTED DRAWER</div><strong style={{ fontFamily: 'var(--font-mono)' as const, color: 'var(--gold)' }}>{fmtMoney(report.expectedDrawer)}</strong></div>
            <div><div style={{ color: 'var(--text-3)', fontSize: 11 }}>CARD — READER ({report.cardSales})</div><strong style={{ fontFamily: 'var(--font-mono)' as const }}>{fmtMoney(report.cardCollected)}</strong></div>
            {report.recordedCardSales > 0 && (
              <div><div style={{ color: 'var(--text-3)', fontSize: 11 }}>CARD — RECORDED ({report.recordedCardSales})</div><strong style={{ fontFamily: 'var(--font-mono)' as const }}>{fmtMoney(report.recordedCardCollected)}</strong></div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>Counted drawer:</span>
            <input type="number" step="0.01" min={0} value={counted} onChange={e => setCounted(e.target.value)} placeholder="0.00"
              style={{ width: 110, background: 'var(--bg-2)', border: '1px solid var(--border-1)', borderRadius: 6, color: 'var(--text-0)', padding: '5px 8px', fontSize: 13, fontFamily: 'var(--font-mono)' as const }} />
            {overShort !== null && (
              <strong style={{ fontSize: 13, fontFamily: 'var(--font-mono)' as const, color: overShort === 0 ? 'var(--green, #22c55e)' : 'var(--red, #ef4444)' }}>
                {overShort === 0 ? 'Balanced ✓' : overShort > 0 ? `Over ${fmtMoney(overShort)}` : `Short ${fmtMoney(Math.abs(overShort))}`}
              </strong>
            )}
          </div>
        </>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Loading…</div>
      )}
    </div>
  )
}


// S536 (Nic): standalone Customers view — browse/search repeat customers
// outside a sale. Archive hides a customer from the business's lists;
// GAM retains every record permanently (there is no hard delete
// anywhere — the master copy can't be touched from any business surface).
function CustomersTab() {
  const { user } = useAuth()
  const isOwner = user?.role === 'business_owner'
  const [rows, setRows] = useState<any[]>([])
  const [q, setQ] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = async () => {
    setErr(null)
    try {
      const query = new URLSearchParams({ status: 'active' })
      if (q.trim()) query.set('q', q.trim())
      setRows(await apiGet<any[]>(`/business-customers?${query.toString()}`))
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load customers')
    }
  }
  useEffect(() => { load() }, [q])

  // S536 (Nic): "Delete" from the business's view — under the hood the
  // row is never destroyed; GAM keeps the master record permanently and
  // past sales stay linked. Owner-only, behind an explicit in-app
  // confirmation (browser confirm() is too easy to miss or suppress).
  const [confirmTarget, setConfirmTarget] = useState<any>(null)
  const [removing, setRemoving] = useState(false)
  const remove = async () => {
    if (!confirmTarget) return
    setRemoving(true)
    try {
      await apiPost(`/business-customers/${confirmTarget.id}/archive`, {})
      setConfirmTarget(null)
      await load()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Delete failed')
      setConfirmTarget(null)
    } finally { setRemoving(false) }
  }

  return (
    <div>
      {err && <div style={errStyle}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, phone, email…"
          style={{ ...inputStyle, flex: 1, maxWidth: 380 }} />
        <button onClick={() => setShowAdd(true)} style={primaryBtnStyle}>＋ New customer</button>
      </div>
      {rows.length === 0 ? (
        <div style={emptyStyle}>No customers yet — add one, or they appear automatically when picked at checkout.</div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-1)' }}>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Phone</th>
              <th style={thStyle}>Email</th>
              <th style={thStyle}>Added</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(c => (
              <tr key={c.id} onClick={() => setEditing(c)}
                style={{ borderBottom: '1px solid var(--border-1)', cursor: 'pointer' }}>
                <td style={tdStyle}><strong style={{ color: 'var(--text-0)' }}>{customerDisplay(c)}</strong></td>
                <td style={tdStyle}>{c.phone || '—'}</td>
                <td style={tdStyle}>{c.email || '—'}</td>
                <td style={tdStyle}>{c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '—'}</td>
                <td style={{ ...tdStyle, textAlign: 'right' as const }}>
                  {isOwner && (
                    <button onClick={e => { e.stopPropagation(); setConfirmTarget(c) }}
                      style={{ background: 'none', border: 'none', color: 'var(--red, #ef4444)', cursor: 'pointer', fontSize: 12 }}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {showAdd && (
        <QuickAddCustomer seedName="" onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); load() }} />
      )}
      {editing && (
        <EditCustomerModal customer={editing} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }} />
      )}
      {confirmTarget && (
        <Modal title="Delete customer?" onClose={() => setConfirmTarget(null)}
          footer={
            <>
              <button onClick={() => setConfirmTarget(null)} style={ghostBtn}>Cancel</button>
              <button onClick={remove} disabled={removing}
                style={{ ...primaryBtnStyle, background: 'var(--red, #ef4444)', borderColor: 'var(--red, #ef4444)' }}>
                {removing ? 'Deleting…' : 'Delete customer'}
              </button>
            </>
          }>
          <div style={{ fontSize: 14, color: 'var(--text-0)', marginBottom: 8 }}>
            <strong>{customerDisplay(confirmTarget)}</strong> will be removed from your customer lists.
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            Past sales keep their records. This can be undone by GAM support if needed.
          </div>
        </Modal>
      )}
    </div>
  )
}


// S536 (Nic): row click → view/edit. Saves via PATCH (owner-only per
// the existing staff-permission posture — staff see a clean error).
function EditCustomerModal({ customer, onClose, onSaved }: {
  customer: any
  onClose: () => void
  onSaved: () => void
}) {
  const [f, setF] = useState<any>({
    firstName: customer.firstName ?? '', lastName: customer.lastName ?? '',
    companyName: customer.companyName ?? '',
    phone: customer.phone ?? '', email: customer.email ?? '',
    street1: customer.street1 ?? '', street2: customer.street2 ?? '',
    city: customer.city ?? '', state: customer.state ?? '', zip: customer.zip ?? '',
    notes: customer.notes ?? '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (k: string) => (e: any) => setF((p: any) => ({ ...p, [k]: e.target.value }))

  const save = async () => {
    setErr(null); setBusy(true)
    try {
      const body: any = {
        firstName: f.firstName.trim(), lastName: f.lastName.trim(),
        phone: f.phone.trim() || null, email: f.email.trim() || null,
        notes: f.notes.trim() || null,
      }
      if (f.companyName.trim()) body.companyName = f.companyName.trim()
      if (f.street1.trim()) {
        body.street1 = f.street1.trim(); body.street2 = f.street2.trim() || null
        body.city = f.city.trim(); body.state = f.state.trim(); body.zip = f.zip.trim()
      }
      await apiPatch(`/business-customers/${customer.id}`, body)
      onSaved()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Save failed')
    } finally { setBusy(false) }
  }

  return (
    <Modal title={customerDisplay(customer)} onClose={onClose}
      footer={
        <>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={save} disabled={busy || !f.firstName.trim() || !f.lastName.trim()} style={primaryBtnStyle}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }>
      {err && <div style={errStyle}>{err}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div><label style={labelStyle}>First name</label><input value={f.firstName} onChange={set('firstName')} style={inputStyle} /></div>
        <div><label style={labelStyle}>Last name</label><input value={f.lastName} onChange={set('lastName')} style={inputStyle} /></div>
        <div><label style={labelStyle}>Phone</label><input value={f.phone} onChange={set('phone')} style={inputStyle} /></div>
        <div><label style={labelStyle}>Email</label><input value={f.email} onChange={set('email')} style={inputStyle} /></div>
      </div>
      <label style={labelStyle}>Company (optional)</label>
      <input value={f.companyName} onChange={set('companyName')} style={inputStyle} />
      <label style={labelStyle}>Street</label>
      <input value={f.street1} onChange={set('street1')} style={inputStyle} placeholder="Street address (optional)" />
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
        <div><label style={labelStyle}>City</label><input value={f.city} onChange={set('city')} style={inputStyle} /></div>
        <div><label style={labelStyle}>State</label><input value={f.state} onChange={set('state')} style={inputStyle} /></div>
        <div><label style={labelStyle}>ZIP</label><input value={f.zip} onChange={set('zip')} style={inputStyle} /></div>
      </div>
      <label style={labelStyle}>Notes</label>
      <input value={f.notes} onChange={set('notes')} style={inputStyle} />
    </Modal>
  )
}

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

      <CashReportCard />

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
                  : humanize(t.paymentMethod)}
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
  const [emailOpen, setEmailOpen] = useState(false)
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
            <button onClick={() => setEmailOpen(true)}
              style={ghostBtn}>
              <Mail size={12} /> Email
            </button>
            {emailOpen && <EmailReceiptModal txnId={txn.id} prefill={txn.customerEmail} onClose={() => setEmailOpen(false)} />}
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
          {Number((txn as any).cardSurcharge) > 0 && <Row label="Card fee" value={fmtMoney((txn as any).cardSurcharge)} />}
          {Number(txn.tipAmount) > 0 && <Row label="Tip" value={fmtMoney(txn.tipAmount)} />}
          <Row label="Total"    value={fmtMoney(Number(txn.totalAmount) + Number(txn.tipAmount ?? 0))} big />
          {txn.paymentMethod === 'cash' && txn.amountTendered !== null && (
            <>
              <Row label="Tendered" value={fmtMoney(txn.amountTendered)} />
              <Row label="Change"   value={fmtMoney(txn.changeDue)} />
            </>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
            Payment: {txn.paymentMethod === 'cash' ? 'Cash' : txn.paymentMethod === 'card_recorded' ? 'Card (recorded outside GAM)' : humanize(txn.paymentMethod)}
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
    }}>{humanize(status)}</span>
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
