import { query, queryOne } from '../db'

const DISPOSABLE = ['mailinator.com','guerrillamail.com','tempmail.com','throwam.com','sharklasers.com','trashmail.com','yopmail.com','getairmail.com','fakeinbox.com','maildrop.cc','dispostable.com','spamgourmet.com']

function looksLikeName(n: string): boolean {
  const clean = n.trim().toLowerCase().replace(/[^a-z]/g,'')
  if (clean.length < 2) return false
  if (!/[aeiou]/.test(clean)) return false
  const vowelRatio = (clean.match(/[aeiou]/g)||[]).length / clean.length
  if (vowelRatio < 0.2) return false
  if (vowelRatio > 0.8) return false
  if (/[^aeiou]{4,}/.test(clean)) return false
  if (/(.)\1{2,}/.test(clean)) return false
  if (/(.{2,3})\1{2,}/.test(clean)) return false
  const walks = ['qwerty','asdfgh','zxcvbn','qazwsx','abcdefg','zyxwvut']
  for (const w of walks) if (clean.includes(w)||clean.includes(w.split('').reverse().join(''))) return false
  if (/^[^aeiou]+$/.test(clean)) return false
  return true
}

export interface RiskResult {
  score: number
  level: 'low'|'medium'|'high'|'very_high'
  flags: string[]
  categories: { identity: string[]; financial: string[]; behavioral: string[]; duplicate: string[] }
}

export async function calculateRiskScore(data: {
  firstName: string; lastName: string; email: string; phone?: string|null
  ssn: string; dob: string; state: string; zip: string
  employmentStatus: string; monthlyIncome?: number|null
  timeToComplete?: number|null; ipAddress?: string; userAgent?: string
  landlordId: string; unitRent?: number|null
  idVerification?: {
    fullMatch?: boolean; closeMatch?: boolean
    dobMatch?: boolean|null; dobMismatch?: boolean
    expired?: boolean; addressMatch?: boolean|null
  } | null
}): Promise<RiskResult> {
  let score = 0
  const identity: string[] = []
  const financial: string[] = []
  const behavioral: string[] = []
  const duplicate: string[] = []

  // ── IDENTITY ──────────────────────────────────────────────
  if (!looksLikeName(data.firstName)) { score += 20; identity.push('first_name_not_realistic') }
  if (!looksLikeName(data.lastName))  { score += 20; identity.push('last_name_not_realistic') }

  // SSN quality
  const ssnD = data.ssn.replace(/\D/g,'')
  if (ssnD.length === 9) {
    const counts: Record<string,number> = {}
    for (const ch of ssnD) counts[ch] = (counts[ch]||0)+1
    for (const [digit, count] of Object.entries(counts)) {
      if (count >= 5) { score += 25; identity.push('ssn_five_repeated_digit_'+digit) }
      else if (count >= 4) { score += 10; identity.push('ssn_four_repeated_digit_'+digit) }
    }
    for (let i=0;i<=6;i++) {
      const a=parseInt(ssnD[i]),b=parseInt(ssnD[i+1]),c=parseInt(ssnD[i+2])
      if (b===a+1&&c===b+1) { score+=15; identity.push('ssn_sequential_ascending'); break }
      if (b===a-1&&c===b-1) { score+=15; identity.push('ssn_sequential_descending'); break }
    }
    if (/^(\d{2,3})\1+/.test(ssnD)) { score+=30; identity.push('ssn_repeating_pattern') }
  }

  // Email
  const domain = data.email.split('@')[1]?.toLowerCase()
  if (domain && DISPOSABLE.includes(domain)) { score+=40; identity.push('disposable_email') }
  if (domain && (domain.includes('temp')||domain.includes('trash')||domain.includes('spam'))) { score+=20; identity.push('suspicious_email_domain') }

  // Age
  const age = Math.floor((Date.now()-new Date(data.dob).getTime())/(365.25*24*60*60*1000))
  if (age<18) { score+=50; identity.push('under_18') }
  if (age>100) { score+=30; identity.push('age_over_100') }

  // ── ID DOCUMENT VERIFICATION ──────────────────────────────
  if (data.idVerification) {
    const idv = data.idVerification
    if (idv.fullMatch === false && idv.closeMatch === false) { score += 40; identity.push('id_name_mismatch') }
    else if (idv.fullMatch === false && idv.closeMatch === true) { score += 15; identity.push('id_name_close_mismatch') }
    if (idv.dobMismatch === true) { score += 35; identity.push('id_dob_mismatch') }
    if (idv.expired === true) { score += 50; identity.push('id_expired') }
    if (idv.addressMatch === false) { score += 10; identity.push('id_address_mismatch') }
  }

  // ── FINANCIAL ─────────────────────────────────────────────
  const income = data.monthlyIncome||0
  const rent = data.unitRent||0
  if (rent>0 && income>0) {
    const ratio = income/rent
    if (ratio>=3) { score=Math.max(0,score-5) }
    else if (ratio>=2) { score+=10; financial.push('income_below_3x_rent') }
    else { score+=35; financial.push('income_below_2x_rent') }
  } else if (income>0 && income<500) { score+=20; financial.push('very_low_income') }

  if (data.employmentStatus==='unemployed'&&income>5000) { score+=20; financial.push('unemployed_high_income') }
  if (data.employmentStatus==='student'&&income>8000)    { score+=10; financial.push('student_high_income') }
  if (['employed','self_employed'].includes(data.employmentStatus)&&income>0&&income<500) { score+=20; financial.push('employed_very_low_income') }
  if (age<22&&data.employmentStatus==='self_employed'&&income>10000) { score+=15; financial.push('age_income_inconsistency') }

  // ── BEHAVIORAL ────────────────────────────────────────────
  if (data.timeToComplete&&data.timeToComplete<60)  { score+=30; behavioral.push('completed_under_60s') }
  else if (data.timeToComplete&&data.timeToComplete<120) { score+=10; behavioral.push('completed_under_2min') }

  if (data.ipAddress) {
    const ipApps = await queryOne<any>("SELECT COUNT(*)::int as count FROM background_checks WHERE ip_address=$1 AND created_at > NOW() - INTERVAL '24 hours'",[data.ipAddress]).catch(()=>null)
    if ((ipApps?.count||0)>=3) { score+=25; behavioral.push('multiple_apps_same_ip') }
  }

  // ── DUPLICATE ─────────────────────────────────────────────
  const ssnLast4 = ssnD.slice(-4)
  const dup = await queryOne<any>('SELECT id FROM background_checks WHERE ssn_last4=$1 AND date_of_birth=$2 AND (first_name!=$3 OR last_name!=$4) LIMIT 1',[ssnLast4,data.dob,data.firstName,data.lastName]).catch(()=>null)
  if (dup) { score+=35; duplicate.push('ssn_dob_name_mismatch') }

  const denials = await queryOne<any>("SELECT COUNT(*)::int as count FROM background_checks bc JOIN users u ON u.id=bc.user_id WHERE u.email=$1 AND bc.status='denied'",[data.email]).catch(()=>null)
  if ((denials?.count||0)>0) { score+=Math.min(60,20*denials.count); duplicate.push('previous_denials_'+denials.count) }

  score = Math.min(100,score)
  const level = score>=70?'very_high':score>=45?'high':score>=20?'medium':'low'
  const flags = [...identity,...financial,...behavioral,...duplicate]
  return { score, level, flags, categories:{ identity, financial, behavioral, duplicate } }
}
