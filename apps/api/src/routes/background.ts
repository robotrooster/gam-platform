import { Router } from 'express'
import { emailNewBackgroundCheck, emailBackgroundDecision, emailPoolMatchInterest, emailPoolTenantInterested } from '../services/email'
import { calculateRiskScore } from '../services/riskScore'
import { query, queryOne } from '../db'
import { requireAuth, requireLandlord } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import crypto from 'crypto'
import multer from 'multer'
import path from 'path'
import fs from 'fs'

export const backgroundRouter = Router()

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64)
const IV_LENGTH = 16

function encrypt(text: string): string {
  const key = Buffer.from(ENCRYPTION_KEY.slice(0,64), 'hex')
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  let enc = cipher.update(text)
  enc = Buffer.concat([enc, cipher.final()])
  return iv.toString('hex') + ':' + enc.toString('hex')
}

backgroundRouter.post('/submit', requireAuth, async (req, res, next) => {
  try {
    const { firstName, lastName, dateOfBirth, ssn, street1, street2, city, state, zip, yearsAtAddress,
      employmentStatus, employerName, employerPhone, monthlyIncome,
      prevLandlordName, prevLandlordPhone, prevLandlordEmail,
      idDocumentUrl, incomeDocUrls, consentCredit, consentCriminal, consentPool } = req.body
    let { landlordId, unitId } = req.body
    if (!firstName || !lastName || !dateOfBirth || !ssn) throw new AppError(400, 'Required fields missing')
    if (!consentCredit || !consentCriminal) throw new AppError(400, 'Both consents required')
    const ssnClean = ssn.replace(/\D/g,'')
    if (ssnClean.length < 9) throw new AppError(400, 'Full SSN required')
    const ssnLast4 = ssnClean.slice(-4)
    const ssnEncrypted = encrypt(ssnClean)
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
    const tenant = await queryOne<any>('SELECT * FROM tenants WHERE user_id=$1', [req.user!.userId])

    // Look up landlord from active lease if not provided
    if (!landlordId && tenant) {
      const leaseInfo = await queryOne<any>(`
        SELECT l.id as landlord_id, un.id as unit_id FROM lease_tenants lt
        JOIN leases le ON le.id=lt.lease_id
        JOIN units un ON un.id=le.unit_id
        JOIN properties p ON p.id=un.property_id
        JOIN landlords l ON l.id=p.landlord_id
        WHERE lt.tenant_id=$1 AND lt.status='active' AND le.status='active' LIMIT 1`, [tenant.id])
      if (leaseInfo) {
        landlordId = leaseInfo.landlord_id
        unitId = unitId || leaseInfo.unit_id
      }
    }
    const check = await queryOne<any>(`
      INSERT INTO background_checks (tenant_id,user_id,landlord_id,unit_id,status,first_name,last_name,date_of_birth,ssn_encrypted,ssn_last4,street1,street2,city,state,zip,years_at_address,employment_status,employer_name,employer_phone,monthly_income,prev_landlord_name,prev_landlord_phone,prev_landlord_email,id_document_url,income_document_urls,consent_credit,consent_criminal,consent_pool,consent_signed_at,consent_ip)
      VALUES ($1,$2,$3,$4,'submitted',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,NOW(),$28) RETURNING id`,
      [tenant?.id||null,req.user!.userId,landlordId||null,unitId||null,firstName,lastName,dateOfBirth,ssnEncrypted,ssnLast4,street1,street2||null,city,state,zip,yearsAtAddress||null,employmentStatus||null,employerName||null,employerPhone||null,monthlyIncome||null,prevLandlordName||null,prevLandlordPhone||null,prevLandlordEmail||null,idDocumentUrl||null,JSON.stringify(incomeDocUrls||[]),consentCredit,consentCriminal,consentPool||false,ip])
    if (tenant) await query("UPDATE tenants SET background_check_status='submitted',background_check_id=$1 WHERE id=$2",[check!.id,tenant.id])

    // Server-side ID verification fallback
    let idVerification = req.body.idVerification || null
    if (!idVerification && idDocumentUrl) {
      try {
        const idFilename = idDocumentUrl.split('/').pop()
        const idFilePath = path.join(process.cwd(), 'uploads', 'id-documents', idFilename)
        if (fs.existsSync(idFilePath)) {
          const fileBuffer = fs.readFileSync(idFilePath)
          const base64 = fileBuffer.toString('base64')
          const ext = path.extname(idFilePath).toLowerCase()
          const mediaType = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg'
          const visionRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 200, messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              { type: 'text', text: 'Extract from this government ID. Return ONLY JSON: firstName, lastName, dateOfBirth (YYYY-MM-DD), expirationDate (YYYY-MM-DD), address, idType. Null if unreadable.' }
            ]}]})
          })
          const visionData = await visionRes.json() as { content?: { text?: string }[] }
          const visionText = visionData.content?.[0]?.text || '{}'
          let extracted: any = {}
          try { extracted = JSON.parse(visionText.replace(/[^{]*({.*})[^}]*/s, '$1')) } catch(e) {}
          const norm = (n: string) => (n||'').toLowerCase().trim().replace(/[^a-z]/g, '')
          const lev = (a: string, b: string) => {
            const m = a.length, n = b.length
            const dp = Array.from({length:m+1}, (_,i) => Array.from({length:n+1}, (_,j) => i===0?j:j===0?i:0))
            for (let i=1;i<=m;i++) for (let j=1;j<=n;j++) dp[i][j] = a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1])
            return dp[m][n]
          }
          const fullMatch = norm(extracted.firstName)===norm(firstName) && norm(extracted.lastName)===norm(lastName)
          const closeMatch = lev(norm(extracted.firstName),norm(firstName))<=2 && lev(norm(extracted.lastName),norm(lastName))<=2
          let dobMismatch = false
          if (extracted.dateOfBirth && dateOfBirth) { try { dobMismatch = new Date(extracted.dateOfBirth).toISOString().split('T')[0] !== new Date(dateOfBirth).toISOString().split('T')[0] } catch(e) {} }
          let expired = false
          if (extracted.expirationDate) { try { expired = new Date(extracted.expirationDate) < new Date() } catch(e) {} }
          idVerification = { fullMatch, closeMatch, dobMatch: !dobMismatch, dobMismatch, expired, addressMatch: extracted.address ? extracted.address.includes(zip) : null }
          console.log('[ID VERIFY SERVER]', JSON.stringify(idVerification))
        }
      } catch(e) { console.error('[ID VERIFY SERVER ERROR]', e) }
    }
    // Calculate risk score
    const ipAddr = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString()
    const ua = req.headers['user-agent'] || ''
    try {
      // Get unit rent for income ratio check
    let unitRent = null
    if (unitId) {
      const unit = await queryOne<any>('SELECT rent_amount FROM units WHERE id=$1', [unitId]).catch(()=>null)
      unitRent = unit?.rent_amount || null
    }
    const risk = await calculateRiskScore({ firstName, lastName, email: (req as any).user.email, phone: null, ssn: ssnClean, dob: dateOfBirth, state, zip, employmentStatus: employmentStatus||'unknown', monthlyIncome: monthlyIncome||null, timeToComplete: req.body.timeToComplete||null, ipAddress: ipAddr, userAgent: ua, landlordId: landlordId||'', unitRent, idVerification: idVerification||null })
      await query('UPDATE background_checks SET risk_score=$1,risk_level=$2,risk_flags=$3,ip_address=$4,user_agent=$5 WHERE id=$6',[risk.score, risk.level, JSON.stringify(risk.flags), ipAddr, ua, check.id])
      // Email landlord about new application
      if (landlordId) {
        try {
          const landlordUser = await queryOne<any>('SELECT u.email, u.first_name, u.last_name FROM landlords l JOIN users u ON u.id=l.user_id WHERE l.id=$1', [landlordId])
          const unit = unitId ? await queryOne<any>('SELECT u.unit_number, p.name FROM units u JOIN properties p ON p.id=u.property_id WHERE u.id=$1', [unitId]) : null
          if (landlordUser) await emailNewBackgroundCheck(landlordUser.email, landlordUser.first_name + ' ' + landlordUser.last_name, firstName + ' ' + lastName, unit?.name || 'Your Property', unit?.unit_number || '—', risk.level)
        } catch(e) { console.error('[EMAIL]', e) }
      }
    } catch(e) { console.error('[RISK]', e) }
    res.status(201).json({ success:true, data:{ id:check!.id, status:'submitted' } })
  } catch(e){ next(e) }
})

backgroundRouter.get('/status', requireAuth, async (req, res, next) => {
  try {
    const tenant = await queryOne<any>('SELECT * FROM tenants WHERE user_id=$1', [req.user!.userId])
    if (!tenant) { res.json({ success:true, data:{ status:'not_started' } }); return }
    const check = tenant.background_check_id
      ? await queryOne<any>('SELECT id,status,created_at,decided_at,decision_notes,first_name,last_name,ssn_last4 FROM background_checks WHERE id=$1',[tenant.background_check_id])
      : null
    res.json({ success:true, data:{ status:tenant.background_check_status||'not_started', check } })
  } catch(e){ next(e) }
})

backgroundRouter.get('/', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const checks = await query<any>(`SELECT bc.id,bc.status,bc.first_name,bc.last_name,bc.ssn_last4,bc.date_of_birth,bc.street1,bc.city,bc.state,bc.zip,bc.employment_status,bc.employer_name,bc.employer_phone,bc.monthly_income,bc.prev_landlord_name,bc.prev_landlord_phone,bc.prev_landlord_email,bc.id_document_url,bc.income_document_urls,bc.consent_credit,bc.consent_criminal,bc.decision_notes,bc.decided_at,bc.created_at,bc.risk_score,bc.risk_level,bc.risk_flags,u.email,un.unit_number,p.name as property_name FROM background_checks bc JOIN users u ON u.id=bc.user_id LEFT JOIN units un ON un.id=bc.unit_id LEFT JOIN properties p ON p.id=un.property_id WHERE bc.landlord_id=$1 ORDER BY bc.created_at DESC`,[req.user!.profileId])
    res.json({ success:true, data:checks })
  } catch(e){ next(e) }
})

backgroundRouter.patch('/:id/decision', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { decision, notes } = req.body
    if (!['approved','denied'].includes(decision)) throw new AppError(400,'Invalid decision')
    const check = await queryOne<any>('SELECT * FROM background_checks WHERE id=$1 AND landlord_id=$2',[req.params.id,req.user!.profileId])
    if (!check) throw new AppError(404,'Not found')
    await query('UPDATE background_checks SET status=$1,decision_notes=$2,decided_at=NOW(),decided_by=$3 WHERE id=$4',[decision,notes||null,req.user!.userId,check.id])
    if (check.tenant_id) await query('UPDATE tenants SET background_check_status=$1 WHERE id=$2',[decision,check.tenant_id])

    // Auto-add to pool if approved and tenant consented
    if (decision === 'approved' && check.consent_pool) {
      try {
        let lat = null, lon = null
        if (check.street1 && check.city) {
          const addr = encodeURIComponent(check.street1+' '+check.city+' '+check.state+' '+check.zip+' USA')
          const geo = await fetch('https://nominatim.openstreetmap.org/search?q='+addr+'&format=json&limit=1',{headers:{'User-Agent':'GAM-Platform/1.0'}})
          const geoData = await geo.json()
          if (geoData?.[0]){lat=geoData[0].lat;lon=geoData[0].lon}
        }
        const entry = await queryOne<any>('INSERT INTO application_pool (background_check_id,user_id,consent_pool,employment_status,monthly_income,zip,city,state,lat,lon,risk_level,risk_score) VALUES ($1,$2,TRUE,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
          [check.id,check.user_id,check.employment_status,check.monthly_income,check.zip,check.city,check.state,lat,lon,check.risk_level,check.risk_score])
        await query('UPDATE background_checks SET pool_entry_id=$1 WHERE id=$2',[entry!.id,check.id])
      } catch(e){console.error('[POOL]',e)}
    }

    const tu = await queryOne<any>('SELECT email,first_name FROM users WHERE id=$1',[check.user_id])
    if (tu?.email) {
      const unit = check.unit_id ? await queryOne<any>('SELECT u.unit_number, p.name FROM units u JOIN properties p ON p.id=u.property_id WHERE u.id=$1', [check.unit_id]) : null
      await emailBackgroundDecision(tu.email, tu.first_name || 'there', decision as 'approved'|'denied', unit?.name || 'the property', unit?.unit_number || '—', notes||undefined)
    }
    res.json({ success:true, data:{ decision } })
  } catch(e){ next(e) }
})

const idDir = path.join(process.cwd(),'uploads','id-documents')
if (!fs.existsSync(idDir)) fs.mkdirSync(idDir,{ recursive:true })
const idStorage = multer.diskStorage({ destination:idDir, filename:(req:any,file:any,cb:any)=>cb(null,Date.now()+'-'+crypto.randomBytes(8).toString('hex')+path.extname(file.originalname)) })
const idUpload = multer({ storage:idStorage, limits:{ fileSize:10*1024*1024 }, fileFilter:(req:any,file:any,cb:any)=>{ if(['image/jpeg','image/png','application/pdf'].includes(file.mimetype)) cb(null,true); else cb(new Error('JPEG PNG PDF only')) } })

backgroundRouter.post('/upload-id', requireAuth, idUpload.single('file'), async (req:any,res:any,next:any)=>{ try{ if(!req.file) throw new AppError(400,'No file'); res.json({ success:true, data:{ url:'/api/background/id-files/'+req.file.filename, filename:req.file.originalname } }) }catch(e){ next(e) } })
backgroundRouter.get('/id-files/:filename', requireAuth, async (req:any,res:any,next:any)=>{ try{ const fp=path.join(idDir,req.params.filename); if(!fs.existsSync(fp)) throw new AppError(404,'Not found'); res.removeHeader('Content-Security-Policy'); res.removeHeader('Cross-Origin-Resource-Policy'); res.sendFile(fp) }catch(e){ next(e) } })

backgroundRouter.post('/payment-intent', requireAuth, async (req, res, next) => {
  try {
    const { landlordId } = req.body
    const landlord = await queryOne<any>('SELECT bg_check_fee FROM landlords WHERE id=$1', [landlordId])
    const fee = parseFloat(landlord?.bg_check_fee || 45)
    const mockId = 'pi_test_' + require('crypto').randomBytes(12).toString('hex')
    res.json({ success:true, data:{ clientSecret: mockId+'_secret', intentId: mockId, amount: fee, platformFee: 25, landlordFee: Math.max(0, fee-25), testMode: true }})
  } catch(e) { next(e) }
})

backgroundRouter.get('/fee/:landlordId', async (req, res, next) => {
  try {
    const l = await queryOne<any>('SELECT bg_check_fee FROM landlords WHERE id=$1', [req.params.landlordId])
    res.json({ success:true, data:{ fee: parseFloat(l?.bg_check_fee || 45) }})
  } catch(e) { next(e) }
})

backgroundRouter.patch('/fee', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const fee = parseFloat(req.body.fee)
    if (isNaN(fee) || fee < 25) throw new AppError(400, 'Minimum fee is $25.00')
    await query('UPDATE landlords SET bg_check_fee=$1 WHERE id=$2', [fee, req.user!.profileId])
    res.json({ success:true, data:{ fee }})
  } catch(e) { next(e) }
})

backgroundRouter.get('/verify-address', async (req, res, next) => {
  try {
    const { street, city, state, zip } = req.query as Record<string,string>
    const q = encodeURIComponent(`${street}, ${city}, ${state} ${zip}, USA`)
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&addressdetails=1&limit=1&countrycodes=us`
    const response = await fetch(url, {
      headers: { 'User-Agent': 'GAM-Platform/1.0 (contact@gamplatform.com)' },
      signal: AbortSignal.timeout(5000)
    })
    const data = await response.json()
    const valid = Array.isArray(data) && data.length > 0
    const match = valid ? data[0] : null
    res.json({ success: true, data: {
      valid,
      displayName: match?.display_name || null,
      lat: match?.lat || null,
      lon: match?.lon || null,
      addressComponents: match?.address || null
    }})
  } catch(e) {
    res.json({ success: true, data: { valid: null, error: 'verification_unavailable' } })
  }
})

backgroundRouter.get('/suggest-address', async (req, res, next) => {
  try {
    const { q, lat, lon } = req.query as Record<string,string>
    if (!q || q.length < 4) { res.json({ success:true, data:[] }); return }
    const encoded = encodeURIComponent(q + ' USA')
    // Add viewbox bias if coordinates provided (±0.5 degree ~35 mile box)
    let viewbox = ''
    let bounded = ''
    if (lat && lon) {
      const la = parseFloat(lat), lo = parseFloat(lon)
      viewbox = `&viewbox=${lo-0.15},${la-0.15},${lo+0.15},${la+0.15}`
      bounded = '' // viewbox biases results without hard limiting
    }
    const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&addressdetails=1&limit=10&countrycodes=us${viewbox}${bounded}`
    const response = await fetch(url, { headers: { 'User-Agent': 'GAM-Platform/1.0' }, signal: AbortSignal.timeout(5000) })
    const data = await response.json()
    res.json({ success:true, data: Array.isArray(data) ? data : [] })
  } catch(e) {
    res.json({ success:true, data:[] })
  }
})

// DEV ONLY — reset background check status for testing
backgroundRouter.post('/dev-reset', requireAuth, async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production') throw new AppError(403, 'Not available in production')
    const tenant = await queryOne<any>('SELECT * FROM tenants WHERE user_id=$1', [req.user!.userId])
    if (tenant) {
      await query('UPDATE tenants SET background_check_status=$1, background_check_id=NULL WHERE id=$2', ['not_started', tenant.id])
    }
    res.json({ success: true })
  } catch(e) { next(e) }
})

// ── POOL SYSTEM ───────────────────────────────────────────────

// Add approved tenant to pool (called after approval if consent given)
backgroundRouter.post('/:id/add-to-pool', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const check = await queryOne<any>('SELECT * FROM background_checks WHERE id=$1', [req.params.id])
    if (!check) throw new AppError(404, 'Not found')
    if (!check.consent_pool) throw new AppError(400, 'Tenant did not consent to pool')

    // Get coordinates from address
    let lat = null, lon = null
    try {
      const addr = encodeURIComponent(`${check.street1} ${check.city} ${check.state} ${check.zip} USA`)
      const geo = await fetch(`https://nominatim.openstreetmap.org/search?q=${addr}&format=json&limit=1`, { headers: { 'User-Agent': 'GAM-Platform/1.0' } })
      const geoData = await geo.json()
      if (geoData?.[0]) { lat = geoData[0].lat; lon = geoData[0].lon }
    } catch(e) {}

    const entry = await queryOne<any>(`
      INSERT INTO application_pool (background_check_id, user_id, consent_pool, employment_status, monthly_income, zip, city, state, lat, lon, risk_level, risk_score)
      VALUES ($1,$2,TRUE,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [check.id, check.user_id, check.employment_status, check.monthly_income, check.zip, check.city, check.state, lat, lon, check.risk_level, check.risk_score])

    await query('UPDATE background_checks SET pool_entry_id=$1 WHERE id=$2', [entry!.id, check.id])
    res.json({ success: true, data: entry })
  } catch(e) { next(e) }
})

// Landlord searches pool
backgroundRouter.get('/pool/search', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { minIncome, maxIncome, state, riskLevel, radiusMiles, lat, lon } = req.query as Record<string,string>
    let whereClause = "WHERE ap.status='available'"
    const params: any[] = []
    let idx = 1

    if (minIncome) { whereClause += ` AND ap.monthly_income >= $${idx++}`; params.push(parseFloat(minIncome)) }
    if (maxIncome) { whereClause += ` AND ap.monthly_income <= $${idx++}`; params.push(parseFloat(maxIncome)) }
    if (state) { whereClause += ` AND ap.state = $${idx++}`; params.push(state) }
    if (riskLevel) { whereClause += ` AND ap.risk_level = $${idx++}`; params.push(riskLevel) }

    const pool = await query<any>(`
      SELECT ap.id, ap.employment_status, ap.monthly_income, ap.city, ap.state, ap.zip,
        ap.risk_level, ap.risk_score, ap.created_at,
        CASE WHEN mr.id IS NOT NULL THEN TRUE ELSE FALSE END as already_contacted
      FROM application_pool ap
      LEFT JOIN pool_match_requests mr ON mr.pool_entry_id=ap.id AND mr.landlord_id=$${idx}
      ${whereClause}
      ORDER BY ap.risk_score ASC, ap.created_at DESC
      LIMIT 50`, [...params, req.user!.profileId])

    res.json({ success: true, data: pool })
  } catch(e) { next(e) }
})

// Landlord sends interest to tenant (free)
backgroundRouter.post('/pool/:poolId/reach-out', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const { unitId, message } = req.body
    const entry = await queryOne<any>('SELECT * FROM application_pool WHERE id=$1 AND status=$2', [req.params.poolId, 'available'])
    if (!entry) throw new AppError(404, 'Pool entry not found')

    // Check not already contacted
    const existing = await queryOne<any>('SELECT id FROM pool_match_requests WHERE pool_entry_id=$1 AND landlord_id=$2', [entry.id, req.user!.profileId])
    if (existing) throw new AppError(400, 'Already contacted this applicant')

    const match = await queryOne<any>(`
      INSERT INTO pool_match_requests (pool_entry_id, landlord_id, unit_id, status, landlord_message)
      VALUES ($1,$2,$3,'pending',$4) RETURNING id`, [entry.id, req.user!.profileId, unitId||null, message||null])

    // Get unit info for notification
    const unit = unitId ? await queryOne<any>('SELECT u.*, p.name as property_name FROM units u JOIN properties p ON p.id=u.property_id WHERE u.id=$1', [unitId]) : null
    const landlordUser = await queryOne<any>('SELECT u.first_name, u.last_name FROM landlords l JOIN users u ON u.id=l.user_id WHERE l.id=$1', [req.user!.profileId])

    // Create tenant notification
    await query(`INSERT INTO tenant_notifications (user_id, type, title, body, data)
      VALUES ($1,'match_interest','A landlord is interested in you',$2,$3)`,
      [entry.user_id,
       `${landlordUser?.first_name} ${landlordUser?.last_name} has a vacancy that matches your profile${unit ? ` at ${unit.property_name} Unit ${unit.unit_number}` : ''}. Are you interested?`,
       JSON.stringify({ matchRequestId: match!.id, unitId: unitId||null, landlordMessage: message||null })
      ])

    // Email tenant about landlord interest
    try {
      const tenantUser = await queryOne<any>('SELECT email, first_name FROM users WHERE id=$1', [entry.user_id])
      const unitInfo = unit
      if (tenantUser) await emailPoolMatchInterest(tenantUser.email, tenantUser.first_name || 'there', (landlordUser?.first_name || '') + ' ' + (landlordUser?.last_name || ''), unitInfo?.property_name || 'a property', unitInfo?.unit_number || '—', message||null)
    } catch(e) { console.error('[EMAIL]', e) }
    res.json({ success: true, data: { matchRequestId: match!.id } })
  } catch(e) { next(e) }
})

// Tenant responds to match interest
backgroundRouter.patch('/pool/match/:matchId/respond', requireAuth, async (req, res, next) => {
  try {
    const { interested, message } = req.body
    const match = await queryOne<any>(`
      SELECT mr.*, ap.user_id FROM pool_match_requests mr
      JOIN application_pool ap ON ap.id=mr.pool_entry_id
      WHERE mr.id=$1`, [req.params.matchId])
    if (!match) throw new AppError(404, 'Match request not found')
    if (match.user_id !== req.user!.userId) throw new AppError(403, 'Not your match request')
    if (match.status !== 'pending') throw new AppError(400, 'Already responded')

    const status = interested ? 'interested' : 'not_interested'
    await query('UPDATE pool_match_requests SET status=$1, tenant_response=$2, responded_at=NOW() WHERE id=$3',
      [status, message||null, match.id])

    if (interested) {
      // Notify landlord — they can now pay $5 for report
      const landlord = await queryOne<any>('SELECT u.email FROM landlords l JOIN users u ON u.id=l.user_id WHERE l.id=$1', [match.landlord_id])
      if (landlord?.email) {
        const landlordUser2 = await queryOne<any>('SELECT u.first_name FROM landlords l JOIN users u ON u.id=l.user_id WHERE l.id=$1', [match.landlord_id])
        await emailPoolTenantInterested(landlord.email, landlordUser2?.first_name || 'there')
      }
    }

    res.json({ success: true, data: { status } })
  } catch(e) { next(e) }
})

// Landlord pays $5 to unlock report after tenant confirms interest
backgroundRouter.post('/pool/match/:matchId/purchase-report', requireAuth, requireLandlord, async (req, res, next) => {
  try {
    const match = await queryOne<any>(`
      SELECT mr.*, ap.background_check_id, ap.user_id FROM pool_match_requests mr
      JOIN application_pool ap ON ap.id=mr.pool_entry_id
      WHERE mr.id=$1 AND mr.landlord_id=$2`, [req.params.matchId, req.user!.profileId])
    if (!match) throw new AppError(404, 'Match not found')
    if (match.status !== 'interested') throw new AppError(400, 'Tenant has not confirmed interest yet')
    if (match.report_fee_paid) throw new AppError(400, 'Report already purchased')

    // Test mode payment — replace with Stripe
    const mockPaymentId = `pi_pool_${require('crypto').randomBytes(8).toString('hex')}`
    await query('UPDATE pool_match_requests SET status=$1, report_fee_paid=TRUE, payment_intent_id=$2, purchased_at=NOW() WHERE id=$3',
      ['report_purchased', mockPaymentId, match.id])

    // Fetch full background check for landlord
    const check = await queryOne<any>(`
      SELECT bc.*, u.email FROM background_checks bc JOIN users u ON u.id=bc.user_id WHERE bc.id=$1`,
      [match.background_check_id])
    const { ssn_encrypted, ...safeCheck } = check as any

    res.json({ success: true, data: { report: safeCheck, fee: 5.00, paymentId: mockPaymentId } })
  } catch(e) { next(e) }
})

// Get tenant notifications (lightweight — no full portal required)
backgroundRouter.get('/notifications', requireAuth, async (req, res, next) => {
  try {
    const notifs = await query<any>('SELECT * FROM tenant_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [req.user!.userId])
    res.json({ success: true, data: notifs })
  } catch(e) { next(e) }
})

backgroundRouter.patch('/notifications/:id/read', requireAuth, async (req, res, next) => {
  try {
    await query('UPDATE tenant_notifications SET read=TRUE WHERE id=$1 AND user_id=$2', [req.params.id, req.user!.userId])
    res.json({ success: true })
  } catch(e) { next(e) }
})

// ── ID NAME VERIFICATION VIA CLAUDE VISION ────────────────────
backgroundRouter.post('/verify-id-name', requireAuth, async (req, res, next) => {
  try {
    const { idDocumentUrl, firstName, lastName, dateOfBirth, zip } = req.body
    if (!idDocumentUrl) throw new AppError(400, 'No ID document provided')

    // Read the uploaded ID file
    const filePath = path.join(process.cwd(), 'uploads', 'id-documents', idDocumentUrl.split('/').pop())
    if (!fs.existsSync(filePath)) throw new AppError(404, 'ID file not found')

    const fileBuffer = fs.readFileSync(filePath)
    const base64 = fileBuffer.toString('base64')
    const ext = path.extname(filePath).toLowerCase()
    const mediaType = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg'

    // Call Claude vision API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: 'Extract information from this government ID document. Return ONLY a JSON object with these keys: "firstName", "lastName", "dateOfBirth" (YYYY-MM-DD format), "expirationDate" (YYYY-MM-DD format), "address" (full address string or null), "idType" (drivers_license|passport|state_id). If a field cannot be read clearly, set it to null. No other text, no markdown.' }
          ]
        }]
      })
    })

    const data = await response.json() as { content?: { text?: string }[] }
    const text = data.content?.[0]?.text || '{}'
    let extracted: any = {}
    try { extracted = JSON.parse(text.replace(/```json|```/g, '').trim()) } catch(e) {}

    // Compare names
    const normalize = (n: string) => n?.toLowerCase().trim().replace(/[^a-z]/g, '') || ''
    const firstMatch = normalize(extracted.firstName) === normalize(firstName)
    const lastMatch  = normalize(extracted.lastName)  === normalize(lastName)
    const fullMatch  = firstMatch && lastMatch

    // Check for close match (typo tolerance)
    const levenshtein = (a: string, b: string): number => {
      const m = a.length, n = b.length
      const dp = Array.from({length:m+1}, (_,i) => Array.from({length:n+1}, (_,j) => i===0?j:j===0?i:0))
      for (let i=1;i<=m;i++) for (let j=1;j<=n;j++) dp[i][j] = a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1])
      return dp[m][n]
    }
    const firstDist = levenshtein(normalize(extracted.firstName||''), normalize(firstName))
    const lastDist  = levenshtein(normalize(extracted.lastName||''),  normalize(lastName))
    const closeMatch = firstDist <= 2 && lastDist <= 2

    // DOB comparison
    let dobMatch: boolean|null = null
    let dobMismatch = false
    if (extracted.dateOfBirth && dateOfBirth) {
      const normDob = (d: string) => new Date(d).toISOString().split('T')[0]
      try { dobMatch = normDob(extracted.dateOfBirth) === normDob(dateOfBirth); dobMismatch = !dobMatch } catch(e) {}
    }

    // Expiration check
    let expired = false
    let expirationDate: string|null = extracted.expirationDate || null
    if (expirationDate) {
      try { expired = new Date(expirationDate) < new Date() } catch(e) {}
    }

    // Address comparison (loose — just check zip/city overlap)
    let addressMatch: boolean|null = null
    if (extracted.address && zip) {
      addressMatch = extracted.address.includes(zip)
    }

    res.json({ success: true, data: {
      extracted,
      firstMatch, lastMatch, fullMatch, closeMatch,
      firstDist, lastDist,
      dobMatch, dobMismatch,
      expired, expirationDate,
      addressMatch,
      idType: extracted.idType || null,
      suggestedFirstName: extracted.firstName || null,
      suggestedLastName:  extracted.lastName  || null,
    }})
  } catch(e) { next(e) }
})

// ── PHONE VALIDATION ──────────────────────────────────────────
backgroundRouter.get('/check-phone', requireAuth, async (req, res, next) => {
  try {
    const { phone } = req.query as Record<string,string>
    if (!phone) throw new AppError(400, 'Phone required')
    const clean = phone.replace(/\D/g,'').slice(-10)

    // Check if used by another tenant (not landlords)
    const tenantMatch = await queryOne<any>(`
      SELECT u.id FROM users u
      JOIN tenants t ON t.user_id = u.id
      WHERE REGEXP_REPLACE(u.phone, '[^0-9]', '', 'g') LIKE $1
        AND u.id != $2`,
      ['%'+clean, req.user!.userId]).catch(()=>null)
    if (tenantMatch) return res.json({ success:true, data:{ taken:true, reason:'Phone number already registered to another tenant' }})

    // Check if it matches the applicant's own account phone
    const selfMatch = await queryOne<any>(`
      SELECT id FROM users WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') LIKE $1 AND id=$2`,
      ['%'+clean, req.user!.userId]).catch(()=>null)
    if (selfMatch) return res.json({ success:true, data:{ taken:true, reason:'Cannot use your own phone number for previous landlord' }})

    res.json({ success:true, data:{ taken:false } })
  } catch(e) { next(e) }
})
