/**
 * 10/12 (Nic): the balance sheet.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 */
import { useState } from 'react'
import { useQuery } from 'react-query'
import { formatCurrency } from '@gam/shared'
import { booksGet as get } from './adapter'
import { localToday } from './booksMoney'

// ── BALANCE SHEET ─────────────────────────────────────────────────────
export function BalanceSheetPage(){
  // 10/12 (Nic, ledger P8): once the company's books are live, the balance
  // sheet is read from them, as of any day (earlier years' earnings are
  // worked out, never posted). Before that it is today's.
  const[asOfPick,setAsOfPick]=useState(localToday())
  const{data,isLoading}=useQuery(['balance-sheet',asOfPick],()=>get<any>(`/books/reports/balance-sheet?asOf=${asOfPick}`))
  const fromBooks=(data as any)?.source==='ledger'
  const assets=(data as any)?.assets||[]
  const liabilities=(data as any)?.liabilities||[]
  const equity=(data as any)?.equity||[]
  const totalAssets=(data as any)?.totalAssets||0
  const totalLiabilities=(data as any)?.totalLiabilities||0
  const totalEquity=(data as any)?.totalEquity||0
  const balanced=(data as any)?.balances
  // 10/11: earnings not yet closed into an equity account (income less
  // expenses) are part of equity — this year's and earlier years'. Balances
  // arrive in each account's normal sign, so liabilities and equity read positive.
  const earnings=(data as any)?.earnings
  const asOf=(data as any)?.asOf

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">⚖ Balance Sheet</h1><p className="ps">As of {asOf?new Date(asOf+'T12:00:00').toLocaleDateString():new Date().toLocaleDateString()}{fromBooks?' · from your books':''}</p></div>
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
          {fromBooks&&<input type="date" value={asOfPick} onChange={e=>setAsOfPick(e.target.value)} aria-label="As of" style={{width:'auto',padding:'5px 8px',fontSize:'.75rem'}}/>}
          {balanced!==undefined&&<span className={`badge ${balanced?'bg2':'br'}`}>{balanced?'✓ Balanced':'⚠ Out of Balance'}</span>}
        </div>
      </div>

      {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
        <div className="grid2">
          <div>
            <div className="card" style={{marginBottom:12}}>
              <div className="ct">Assets</div>
              {assets.map((a:any)=><div key={a.accountId??a.code} className="dr"><span className="dk">{a.code} · {a.name}</span><span className="dv mono">{formatCurrency(a.balance)}</span></div>)}
              {assets.length===0&&<div style={{color:'var(--t3)',fontSize:'.78rem'}}>No asset accounts with balances.</div>}
              <div className="dr" style={{borderTop:'2px solid var(--b1)',marginTop:8,paddingTop:8}}>
                <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Total Assets</span>
                <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:'var(--blue)',fontSize:'1rem'}}>{formatCurrency(totalAssets)}</span>
              </div>
            </div>
          </div>
          <div>
            <div className="card" style={{marginBottom:12}}>
              <div className="ct">Liabilities</div>
              {liabilities.map((a:any)=><div key={a.accountId??a.code} className="dr"><span className="dk">{a.code} · {a.name}</span><span className="dv mono">{formatCurrency(a.balance)}</span></div>)}
              {liabilities.length===0&&<div style={{color:'var(--t3)',fontSize:'.78rem'}}>No liability accounts with balances.</div>}
              <div className="dr" style={{borderTop:'2px solid var(--b1)',marginTop:8,paddingTop:8}}>
                <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Total Liabilities</span>
                <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:'var(--red)',fontSize:'1rem'}}>{formatCurrency(totalLiabilities)}</span>
              </div>
            </div>
            <div className="card">
              <div className="ct">Equity</div>
              {equity.map((a:any)=><div key={a.accountId??a.code} className="dr"><span className="dk">{a.code} · {a.name}</span><span className="dv mono">{formatCurrency(a.balance)}</span></div>)}
              {equity.length===0&&<div style={{color:'var(--t3)',fontSize:'.78rem'}}>No equity accounts with balances.</div>}
              {earnings&&<>
                <div className="dr"><span className="dk">Net income this year</span><span className="dv mono">{formatCurrency(earnings.thisYear)}</span></div>
                {!!Number(earnings.earlierYears)&&<div className="dr"><span className="dk">{fromBooks?'Retained earnings (earlier years)':'Earnings from earlier years'}</span><span className="dv mono">{formatCurrency(earnings.earlierYears)}</span></div>}
              </>}
              <div className="dr" style={{borderTop:'2px solid var(--b1)',marginTop:8,paddingTop:8}}>
                <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Total Equity</span>
                <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:'var(--gold)',fontSize:'1rem'}}>{formatCurrency(totalEquity)}</span>
              </div>
              <div className="dr" style={{borderTop:'2px solid var(--b1)',marginTop:8,paddingTop:8}}>
                <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Total Liabilities + Equity</span>
                <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:balanced?'var(--green)':'var(--red)',fontSize:'1rem'}}>{formatCurrency(totalLiabilities+totalEquity)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
