/**
 * 10/12 (Nic): owner statements, per property.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 */
import { useState } from 'react'
import { useQuery } from 'react-query'
import { formatCurrency, MONEY_COLUMNS, MONEY_COLUMN_LABEL } from '@gam/shared'
import { booksGet as get } from './adapter'
import { MoneyThreeTable } from './common'
import { localToday, loadErrorText } from './booksMoney'

// ── OWNER STATEMENTS ─────────────────────────────────────────────────
export function OwnerStatementsPage(){
  const now=new Date()
  const[startDate,setStartDate]=useState(`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`)
  const[endDate,setEndDate]=useState(localToday(now))
  const[selectedId,setSelectedId]=useState<string|null>(null)
  // 10/12 (Nic): no Money received / Money billed switch — Received, Charged
  // and Owed side by side (Received leads); "Received" is the money that
  // arrived in the dates, the figure Expected and Variance compare.
  const{data:statements=[],isLoading,error}=useQuery(['owner-statements',startDate,endDate],()=>get<any[]>(`/books/reports/owner-statements?startDate=${startDate}&endDate=${endDate}`))
  // S655: the selected owner is read from the CURRENT data, so changing the
  // dates updates the statement in place instead of showing a stale copy.
  const selected=(statements as any[]).find((s:any)=>s.landlord.id===selectedId)??null
  const word=MONEY_COLUMN_LABEL.received
  const totalsOf=(s:any)=>({received:s.totalReceived??s.totalCollected,charged:s.totalCharged,owed:s.totalOwed})

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">🏠 Owner Statements</h1><p className="ps">Per-property income statements · {MONEY_COLUMNS.map(k=>MONEY_COLUMN_LABEL[k]).join(', ')}</p></div>
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
          <input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} style={{width:'auto',padding:'5px 8px',fontSize:'.75rem'}}/>
          <span style={{color:'var(--t3)'}}>to</span>
          <input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)} style={{width:'auto',padding:'5px 8px',fontSize:'.75rem'}}/>
        </div>
      </div>
      {!!error&&<div className="alert aw">{loadErrorText(error,'Could not load owner statements.')}</div>}

      {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
        <div className="grid2" style={{gap:16}}>
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            {(statements as any[]).length?(statements as any[]).map((s:any)=>(
              <div key={s.landlord.id} className="card" style={{cursor:'pointer',borderColor:selected?.landlord?.id===s.landlord.id?'rgba(201,162,39,.4)':'var(--b1)'}} onClick={()=>setSelectedId(s.landlord.id)}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                  <div>
                    <div style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>{s.landlord.businessName||s.landlord.firstName+' '+s.landlord.lastName}</div>
                    <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{s.landlord.email}</div>
                  </div>
                  <span className={s.variance>=0?'badge bg2':'badge br'}>{s.variance>=0?'✓ At or over expected':'⚠ Under expected'}</span>
                </div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12,marginTop:12}}>
                  <div><div style={{fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.06em'}}>Expected</div><div style={{fontFamily:'var(--font-m)',color:'var(--t0)',fontWeight:600}}>{formatCurrency(s.totalExpected)}</div></div>
                  <div><div style={{fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.06em'}}>{word}</div><div style={{fontFamily:'var(--font-m)',color:'var(--green)',fontWeight:600}}>{formatCurrency(s.totalCollected)}</div></div>
                  <div><div style={{fontSize:'.65rem',color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.06em'}}>Disbursed</div><div style={{fontFamily:'var(--font-m)',color:'var(--gold)',fontWeight:600}}>{formatCurrency(s.totalDisbursed)}</div></div>
                </div>
              </div>
            )):<div className="card" style={{textAlign:'center',padding:'48px 20px',color:'var(--t3)'}}>No owner data for this period.</div>}
          </div>

          <div>
            {!selected&&<div className="card" style={{textAlign:'center',padding:'48px 20px',color:'var(--t3)'}}>Select an owner to view statement</div>}
            {selected&&(
              <div className="card">
                <div style={{marginBottom:16,paddingBottom:14,borderBottom:'1px solid var(--b0)'}}>
                  <div style={{fontFamily:'var(--font-d)',fontWeight:800,fontSize:'1.1rem',color:'var(--t0)'}}>{selected.landlord.businessName||selected.landlord.firstName+' '+selected.landlord.lastName}</div>
                  <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{new Date(startDate+'T12:00:00').toLocaleDateString()} – {new Date(endDate+'T12:00:00').toLocaleDateString()}</div>
                </div>

                {selected.properties.map((p:any)=>(
                  <div key={p.id} style={{marginBottom:16,paddingBottom:14,borderBottom:'1px solid var(--b0)'}}>
                    <div style={{fontWeight:600,color:'var(--t0)',marginBottom:8}}>{p.name}</div>
                    <div className="dr"><span className="dk">Units</span><span className="dv mono">{p.occupied}/{p.unitCount} occupied</span></div>
                    <div className="dr"><span className="dk">Expected Rent</span><span className="dv mono">{formatCurrency(p.expectedRent)}</span></div>
                    {/* S655: the lines that make up this property's figure. */}
                    {(p.lines??[]).map((l:any)=>(
                      <div key={l.line} className="dr dr-sub"><span className="dk">{l.label}</span><span className="dv mono" style={{color:Number(l.amount)<0?'var(--red)':'var(--t1)'}}>{formatCurrency(l.amount)}</span></div>
                    ))}
                    <MoneyThreeTable rows={[{key:p.id,label:p.name,received:p.received??p.collected,charged:p.charged,owed:p.owed}]}/>
                    <div className="dr"><span className="dk">Variance ({word.toLowerCase()} less expected)</span><span className="dv mono" style={{color:(+p.collected-+p.expectedRent)>=0?'var(--green)':'var(--red)'}}>{formatCurrency(+p.collected-+p.expectedRent)}</span></div>
                    {!!Number(p.depositsHeld)&&<div className="dr"><span className="dk">Deposits received (held, not income)</span><span className="dv mono">{formatCurrency(p.depositsHeld)}</span></div>}
                  </div>
                ))}

                <div className="dr"><span className="dk" style={{fontWeight:700}}>Total Expected</span><span className="dv mono">{formatCurrency(selected.totalExpected)}</span></div>
                <MoneyThreeTable rows={[]} total={totalsOf(selected)} totalLabel="All properties"/>
                {!!Number(selected.totalDepositsHeld)&&<div className="dr"><span className="dk">Deposits received (held, not income)</span><span className="dv mono">{formatCurrency(selected.totalDepositsHeld)}</span></div>}
                <div className="dr"><span className="dk" style={{fontWeight:700}}>Total Disbursed</span><span className="dv mono" style={{color:'var(--gold)',fontWeight:700}}>{formatCurrency(selected.totalDisbursed)}</span></div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
