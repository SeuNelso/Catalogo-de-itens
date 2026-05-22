/**
 * Cria as tabelas iniciais e o usuário admin (usa o .env do server).
 * Execute uma vez após criar o banco "catalogo".
 * Uso: npm run db:init
 */
const path = require('path');
const fs = require('fs');
const { loadEnv, sqlInServer } = require('./_paths');
loadEnv();
const { pool } = require('../db/pool');

async function run() {
  let client;
  try {
    client = await pool.connect();
    const sql = fs.readFileSync(sqlInServer('init-db.sql'), 'utf8');
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
