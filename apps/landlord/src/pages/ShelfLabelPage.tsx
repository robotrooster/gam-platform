import { useParams } from 'react-router-dom'
import { useQuery } from 'react-query'
import { apiGet } from '../lib/api'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

export function ShelfLabelPage() {
  const { id } = useParams()
  const { data: item, isLoading } = useQuery(
    ['shelf-label', id],
    () => apiGet<any>(`/pos/items/${id}/shelf-label`),
    { refetchInterval: 30000 } // auto-refresh every 30 seconds
  )

  if (isLoading) return (
    <div style={{ minHeight: '100vh', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: '#c9a227', fontFamily: 'system-ui' }}>Loading…</div>
    </div>
  )

  if (!item) return (
    <div style={{ minHeight: '100vh', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: '#ff4757', fontFamily: 'system-ui' }}>Item not found</div>
    </div>
  )

  const priceWithTax = item.sellPrice * (1 + item.taxRate)

  return (
    <div style={{ minHeight: '100vh', background: '#060809', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 400, textAlign: 'center' }}>

        {/* Icon */}
        <div style={{ fontSize: '5rem', marginBottom: 16, lineHeight: 1 }}>{item.icon}</div>

        {/* Name */}
        <div style={{ fontFamily: 'system-ui', fontSize: '2rem', fontWeight: 900, color: '#eef1f8', marginBottom: 8, lineHeight: 1.2 }}>
          {item.name}
        </div>

        {/* Category */}
        <div style={{ fontSize: '.85rem', color: '#7a8aaa', textTransform: 'capitalize', marginBottom: 32, letterSpacing: '.06em' }}>
          {item.category}
        </div>

        {/* Price */}
        <div style={{ background: 'linear-gradient(135deg, #1a1600, #2a2200)', border: '2px solid rgba(201,162,39,.4)', borderRadius: 20, padding: '28px 32px', marginBottom: 20 }}>
          <div style={{ fontSize: '.75rem', color: '#c9a227', textTransform: 'uppercase', letterSpacing: '.12em', marginBottom: 8, fontWeight: 700 }}>
            Price
          </div>
          <div style={{ fontFamily: 'system-ui', fontSize: '4rem', fontWeight: 900, color: '#c9a227', lineHeight: 1 }}>
            {fmt(item.sellPrice)}
          </div>
          {item.taxRate > 0 && (
            <div style={{ fontSize: '.75rem', color: '#7a8aaa', marginTop: 8 }}>
              +{(item.taxRate * 100).toFixed(0)}% tax · {fmt(priceWithTax)} after tax
            </div>
          )}
        </div>

        {/* Card price */}
        <div style={{ background: '#0a0d10', border: '1px solid #1e2530', borderRadius: 12, padding: '14px 20px', marginBottom: 16 }}>
          <div style={{ fontSize: '.72rem', color: '#4a9eff', marginBottom: 4 }}>💳 Card price (3% processing fee)</div>
          <div style={{ fontFamily: 'system-ui', fontSize: '1.5rem', fontWeight: 800, color: '#4a9eff' }}>
            {fmt(item.sellPrice * 1.03)}
          </div>
        </div>

        {/* Stock indicator */}
        {item.stockQty < 999 && (
          <div style={{ fontSize: '.72rem', color: item.stockQty <= 5 ? '#ff4757' : item.stockQty <= 10 ? '#ffb820' : '#1edb7a', padding: '6px 14px', borderRadius: 20, background: item.stockQty <= 5 ? 'rgba(255,71,87,.08)' : item.stockQty <= 10 ? 'rgba(255,184,32,.08)' : 'rgba(30,219,122,.08)', display: 'inline-block', marginBottom: 16 }}>
            {item.stockQty <= 5 ? `⚠️ Only ${item.stockQty} left!` : item.stockQty <= 10 ? `${item.stockQty} in stock` : '✓ In stock'}
          </div>
        )}

        {/* Branding */}
        <div style={{ fontSize: '.65rem', color: '#3a4455', marginTop: 24, letterSpacing: '.08em' }}>
          GOLD ASSET MANAGEMENT · POWERED BY GAM POS
        </div>
        <div style={{ fontSize: '.55rem', color: '#2a3040', marginTop: 4 }}>
          Auto-updates · {new Date().toLocaleTimeString()}
        </div>
      </div>
    </div>
  )
}
