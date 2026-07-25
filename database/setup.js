/**
 * One-time database setup:
 *   node database/setup.js           -> create database + tables (idempotent)
 *   node database/setup.js --reset   -> DROP and recreate everything
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('../src/config/env');

async function main() {
  const reset = process.argv.includes('--reset');

  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    multipleStatements: true,
  });

  if (reset) {
    console.log(`Dropping database ${env.db.database} ...`);
    await conn.query(`DROP DATABASE IF EXISTS \`${env.db.database}\``);
  }

  console.log(`Creating database ${env.db.database} (if not exists) ...`);
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${env.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`
  );
  await conn.query(`USE \`${env.db.database}\``);

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('Applying schema ...');
  await conn.query(schema);

  await conn.end();
  console.log('✔ Database setup complete.');
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
