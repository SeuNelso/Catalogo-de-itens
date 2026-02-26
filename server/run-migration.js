/**
 * Executa uma migração SQL (usa o .env do server = mesma BD da aplicação).
 * Uso:
 *   node server/run-migration.js                    → migração de preparação (requisicoes_itens)
 *   node server/run-migration.js separacao-confirmada → migração de confirmação de separação
 *   npm run db:migrate                              → preparação
 *   npm run db:migrate:separacao                    → confirmação de separação
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const arg = process.argv[2];
const migrationFile = path.join(
  __dirname,
  arg === 'separacao-confirmada'
    ? 'migrate-requisicoes-separacao-confirmada.sql'
    : arg === 'status-fases'
      ? 'migrate-requisicoes-status-fases.sql'
      : arg === 'preparacao-confirmada'
        ? 'migrate-requisicoes-itens-preparacao-confirmada.sql'
        : arg === 'armazens-tipo'
          ? 'migrate-armazens-tipo-central-viatura.sql'
          : 'migrate-requisicoes-itens-preparacao.sql'
);

async function run() {
  let client;
  try {
    client = await pool.connect();
    const sql = fs.readFileSync(migrationFile, 'utf8');
    // Remove comentários de linha (-- ...) e divide por ; para executar cada comando
    const statements = sql
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);

    for (const statement of statements) {
      if (statement) {
        await client.query(statement + ';');
        console.log('OK:', statement.substring(0, 60) + '...');
      }
    }
    console.log('Migração concluída com sucesso.');
  } catch (e) {
    console.error('Erro na migração:', e.message);
    process.exit(1);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

run();
