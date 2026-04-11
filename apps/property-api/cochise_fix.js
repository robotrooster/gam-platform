const { Client } = require('pg');
const DB = 'postgresql://postgres:gam_dev_password@localhost:5432/gam_properties';

async function main() {
  const client = new Client({ connectionString: DB });
  await client.connect();

  const res = await client.query(`
    UPDATE parcels
    SET situs_city = NULL, situs_state = NULL, situs_zip = NULL
    WHERE county = 'cochise' AND situs_address IS NULL
  `);
  console.log('Cochise rows fixed:', res.rowCount);
  await client.end();
}
main().catch(console.error);
