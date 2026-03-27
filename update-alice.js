const { Client } = require('pg');
const client = new Client({ host:'localhost', port:5432, database:'gam', user:'postgres', password:'gam_dev_password' });
async function run() {
  await client.connect();
  const res = await client.query("UPDATE users SET email='realestaterhoades@gmail.com' WHERE email='alice@tenant.dev' RETURNING email");
  console.log('Updated:', res.rows);
  await client.end();
}
run().catch(console.error);
