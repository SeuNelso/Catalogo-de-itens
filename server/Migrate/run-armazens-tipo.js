/**
 * Adiciona coluna tipo (central/viatura) em armazens e tipo_localizacao em armazens_localizacoes.
 * Use quando o tipo não está sendo salvo (armazém sempre aparece como Viatura).
 * Usa o .env do server (DATABASE_URL = banco local ou Railway).
 * Uso: npm run db:armazens-tipo
 */
const { loadEnv, sqlInMigrate } = require('./_paths');
loadEnv();
const { Pool } = require('pg');
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
    const sql = fs.readFileSync(sqlInMigrate('migrate-armazens-tipo-central-viatura.sql'), 'utf8');
    await client.query(sql);
    console.log('Coluna tipo (central/viatura) e tipo_localizacao aplicadas. Armazéns passam a salvar o tipo corretamente.');
  } catch (e) {
    console.error('Erro:', e.message);
    process.exit(1);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

run();
