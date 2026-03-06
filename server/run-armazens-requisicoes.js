/**
 * Cria as tabelas armazens, armazens_localizacoes, requisicoes e requisicoes_itens.
 * Usa o .env do server (DATABASE_URL = banco local ou Railway).
 * Uso: npm run db:armazens
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
    const sql = fs.readFileSync(path.join(__dirname, 'create-armazens-requisicoes-v2.sql'), 'utf8');
    await client.query(sql);
    console.log('Tabelas armazens, armazens_localizacoes, requisicoes e requisicoes_itens criadas.');

    const migTipo = path.join(__dirname, 'migrate-armazens-tipo-central-viatura.sql');
    if (fs.existsSync(migTipo)) {
      const sqlTipo = fs.readFileSync(migTipo, 'utf8');
      await client.query(sqlTipo);
      console.log('Coluna tipo (central/viatura) e tipo_localizacao aplicadas.');
    }
  } catch (e) {
    console.error('Erro:', e.message);
    process.exit(1);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

run();
