const { Client } = require('pg');
const https = require('https');

const DB = 'postgresql://postgres:gam_dev_password@localhost:5432/gam_properties';
const BASE = 'https://gis.gilacountyaz.gov/arcgis/rest/services/ParcelService/ParcelOwnershipService/MapServer/0/query';
const PAGE = 1000;

function fetch(offset) {
  return new Promise((resolve, reject) => {
    const url = `${BASE}?where=1%3D1&outFields=APN,ADDRESS,Owner1,Owner2,MAILADDRESS1,MAILCITY,MAILSTATE,MAILZIPCODE&returnGeometry=false&resultOffset=${offset}&resultRecordCount=${PAGE}&f=json`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function t(v, n=128) {
  v = (v || '').toString().trim();
  return v ? v.substring(0, n) : null;
}

async function main() {
  const client = new Client({ connectionString: DB });
  await client.connect();

  let offset = 0, total = 0;
  while (true) {
    const data = await fetch(offset);
    const features = data.features || [];
    if (!features.length) break;

    for (const f of features) {
      const a = f.attributes;
      const apn = t(a.APN || a.LAPN);
      if (!apn) continue;
      let owner = t(a.Owner1);
      if (a.Owner2 && t(a.Owner2)) owner = (owner ? owner + ' ' : '') + t(a.Owner2);
      await client.query(
        `UPDATE parcels SET
          situs_address = $1,
          owner_name_raw = COALESCE(owner_name_raw, $2),
          owner_name_parsed = COALESCE(owner_name_parsed, $2),
          owner_mailing_address = COALESCE(owner_mailing_address, $3),
          owner_mailing_city = COALESCE(owner_mailing_city, $4),
          owner_mailing_state = COALESCE(owner_mailing_state, $5),
          owner_mailing_zip = COALESCE(owner_mailing_zip, $6)
        WHERE apn = $7 AND county = 'gila'`,
        [t(a.ADDRESS), owner, t(a.MAILADDRESS1), t(a.MAILCITY), t(a.MAILSTATE), t(a.MAILZIPCODE), apn]
      );
      total++;
    }
    if (total % 5000 === 0) console.log('Updated', total.toLocaleString());
    offset += PAGE;
    if (features.length < PAGE) break;
  }

  const res = await client.query("SELECT COUNT(*) FROM parcels WHERE county='gila' AND situs_address IS NOT NULL");
  console.log('Done. Gila parcels with address:', res.rows[0].count);
  await client.end();
}

main().catch(console.error);
