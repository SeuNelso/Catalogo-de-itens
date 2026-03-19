/**
 * Cria usuario_requisicoes_armazens, copia dados da coluna legada (se existir) e remove a coluna.
 * Uso: node server/run-usuario-requisicoes-armazens-multi.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function run() {
  const client = await pool.connect();
  try {
    const ddl = fs.readFileSync(path.join(__dirname, 'migrate-usuario-requisicoes-armazens-junction.sql'), 'utf8');
    const ddlStmts = ddl
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const st of ddlStmts) {
      await client.query(st + ';');
    }

    const col = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'usuarios' AND column_name = 'requisicoes_armazem_origem_id'
       LIMIT 1`
    );
    if (col.rows.length > 0) {
      await client.query(`
        INSERT INTO usuario_requisicoes_armazens (usuario_id, armazem_id)
        SELECT u.id, u.requisicoes_armazem_origem_id
        FROM usuarios u
        WHERE u.requisicoes_armazem_origem_id IS NOT NULL
        ON CONFLICT DO NOTHING
      `);
      console.log('OK: dados copiados de usuarios.requisicoes_armazem_origem_id');
      await client.query('ALTER TABLE usuarios DROP COLUMN IF EXISTS requisicoes_armazem_origem_id');
      await client.query('DROP INDEX IF EXISTS idx_usuarios_requisicoes_armazem_origem');
      console.log('OK: coluna legada removida (se existia)');
    } else {
      console.log('INFO: coluna requisicoes_armazem_origem_id não existe — apenas DDL aplicada.');
    }

    console.log('Migração multi-armazém concluída.');
  } catch (e) {
    console.error('Erro:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
