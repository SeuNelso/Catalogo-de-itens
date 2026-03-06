/**
 * Cria as tabelas iniciais e o usuário admin (usa o .env do server).
 * Execute uma vez após criar o banco "catalogo".
 * Uso: npm run db:init
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function run() {
  let client;
  try {
    client = await pool.connect();
    const sql = fs.readFileSync(path.join(__dirname, 'init-db.sql'), 'utf8');
    await client.query(sql);
    console.log('Banco inicializado. Tabela usuarios criada. Usuário admin (senha: admin123) inserido.');
  } catch (e) {
    console.error('Erro:', e.message);
    process.exit(1);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

run();
