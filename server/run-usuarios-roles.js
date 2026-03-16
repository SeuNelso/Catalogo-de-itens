/**
 * Atualiza o constraint da coluna role em usuarios para aceitar os novos perfis.
 * Usa o .env do server (DATABASE_URL). Uso: npm run db:usuarios-roles
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const connectionString = process.env.DATABASE_URL || `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;
const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function run() {
  let client;
  try {
    client = await pool.connect();
    const sql = fs.readFileSync(path.join(__dirname, 'migrate-usuarios-roles-novos.sql'), 'utf8');
    await client.query(sql);
    console.log('Roles atualizados. O admin pode agora atribuir BACKOFFICE OPERATIONS, BACKOFFICE ARMAZEM e OPERADOR.');
  } catch (e) {
    console.error('Erro:', e.message);
    process.exit(1);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

run();
