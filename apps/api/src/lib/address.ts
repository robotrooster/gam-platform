// Normalize a US street address for duplicate detection.
// Lowercases, trims, collapses common street-type & direction abbreviations.
// Not a geocoder — just a deterministic string key.

const STREET_TYPES: Record<string,string> = {
  street:'st', str:'st', st:'st',
  avenue:'ave', av:'ave', ave:'ave',
  road:'rd', rd:'rd',
  drive:'dr', dr:'dr',
  boulevard:'blvd', blvd:'blvd',
  lane:'ln', ln:'ln',
  court:'ct', ct:'ct',
  place:'pl', pl:'pl',
  terrace:'ter', ter:'ter',
  parkway:'pkwy', pkwy:'pkwy',
  highway:'hwy', hwy:'hwy',
  circle:'cir', cir:'cir',
  way:'way',
  trail:'trl', trl:'trl',
  square:'sq', sq:'sq',
}

const DIRECTIONS: Record<string,string> = {
  north:'n', n:'n',
  south:'s', s:'s',
  east:'e', e:'e',
  west:'w', w:'w',
  northeast:'ne', ne:'ne',
  northwest:'nw', nw:'nw',
  southeast:'se', se:'se',
  southwest:'sw', sw:'sw',
}

function collapseToken(tok: string): string {
  const t = tok.replace(/\./g,'').toLowerCase()
  if (DIRECTIONS[t]) return DIRECTIONS[t]
  if (STREET_TYPES[t]) return STREET_TYPES[t]
  return t
}

export function normalizeStreet(s: string): string {
  if (!s) return ''
  return s
    .toLowerCase()
    .replace(/[.,#]/g,' ')
    .replace(/\s+/g,' ')
    .trim()
    .split(' ')
    .map(collapseToken)
    .join(' ')
}

export function normalizeAddress(a: { street1: string; city: string; state: string; zip: string }): string {
  const street = normalizeStreet(a.street1 || '')
  const city   = (a.city || '').toLowerCase().trim().replace(/\s+/g,' ')
  const state  = (a.state || '').toLowerCase().trim()
  const zip    = (a.zip || '').trim().slice(0,5)
  return `${street}|${city}|${state}|${zip}`
}
