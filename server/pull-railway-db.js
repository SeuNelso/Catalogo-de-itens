/**
 * Copia dados do PostgreSQL do Railway para o banco local.
 * Requer DATABASE_URL_RAILWAY no .env (copie do painel do Railway).
 * Uso: npm run db:pull-railway
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');

const railwayUrl = process.env.DATABASE_URL_RAILWAY;
const localUrl = process.env.DATABASE_URL || `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;

if (!railwayUrl) {
  console.error('Erro: defina DATABASE_URL_RAILWAY no server/.env (copie do Railway → PostgreSQL → Connect → Variable).');
  process.exit(1);
}

// Ordem: tabelas pai primeiro (respeitando FKs)
const COPY_ORDER = [
  'usuarios',
  'itens',
  'itens_setores',
  'imagens_itens',
  'itens_compostos',
  'itens_nao_cadastrados',
  'armazens',
  'armazens_localizacoes',
  'requisicoes',
  'requisicoes_itens',
  'requisicoes_itens_preparacao',
  'requisicoes_itens_preparacao_confirmada',
  'requisicoes_separacao_confirmada',
  'fotos_reconhecimento'
];

// Mapeamento: coluna no LOCAL <- coluna no Railway (quando os nomes diferem)
const COLUMN_MAP_RAILWAY_TO_LOCAL = {
  itens: { descricao: 'nome' },
  imagens_itens: { url: 'caminho' },
  itens_compostos: { quantidade: 'quantidade_componente', item_pai_id: 'item_principal_id' }
};

const railwayPool = new Pool({
  connectionString: railwayUrl,
  ssl: { rejectUnauthorized: false }
});

const localPool = new Pool({
  connectionString: localUrl,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

function escapeIdentifier(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

const NUMERIC_TYPES = ['integer', 'smallint', 'bigint', 'numeric', 'decimal', 'real', 'double precision'];
const INTEGER_TYPES = ['integer', 'smallint', 'bigint'];

async function getTableColumns(pool, tableName) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns 
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [tableName]
  );
  return r.rows.map(row => row.column_name);
}

async function getTableColumnsWithTypes(pool, tableName) {
  const r = await pool.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns 
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [tableName]
  );
  return r.rows;
}

async function tableExists(pool, tableName) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return r.rows.length > 0;
}

async function getSerialSequence(pool, tableName) {
  try {
    const r = await pool.query(
      `SELECT pg_get_serial_sequence($1::text, $2::text) as seq`,
      ['public.' + tableName, 'id']
    );
    return r.rows[0] && r.rows[0].seq;
  } catch (_) {
    return null;
  }
}

async function copyTable(railwayClient, localClient, tableName) {
  const existsRailway = await tableExists(railwayPool, tableName);
  const existsLocal = await tableExists(localPool, tableName);
  if (!existsRailway || !existsLocal) {
    if (!existsRailway) console.log(`  [pular] ${tableName} não existe no Railway`);
    else console.log(`  [pular] ${tableName} não existe localmente`);
    return 0;
  }

  const localColsWithTypes = await getTableColumnsWithTypes(localPool, tableName);
  if (localColsWithTypes.length === 0) return 0;
  const localCols = localColsWithTypes.map(r => r.column_name);

  const colsList = localCols.map(escapeIdentifier).join(', ');
  const placeholders = localCols.map((_, i) => `$${i + 1}`).join(', ');
  const insertSql = `INSERT INTO ${escapeIdentifier(tableName)} (${colsList}) VALUES (${placeholders})`;

  const result = await railwayClient.query(`SELECT * FROM ${escapeIdentifier(tableName)}`);
  const rows = result.rows;
  if (rows.length === 0) {
    console.log(`  ${tableName}: 0 linhas`);
    return 0;
  }

  const map = COLUMN_MAP_RAILWAY_TO_LOCAL[tableName] || {};
  const ROLES_VALIDOS = ['admin', 'controller', 'usuario'];
  for (const row of rows) {
    const values = localColsWithTypes.map(({ column_name: localCol, data_type, is_nullable }) => {
      const srcCol = map[localCol] ?? localCol;
      let val = row[srcCol] !== undefined ? row[srcCol] : null;
      if (val === '' || (typeof val === 'string' && val.trim() === '')) {
        if (NUMERIC_TYPES.includes(data_type)) val = null;
        else if (data_type === 'boolean') val = null;
      }
      if (is_nullable === 'NO' && val == null) {
        if (NUMERIC_TYPES.includes(data_type)) val = localCol === 'quantidade' ? 1 : 0;
        else if (data_type === 'boolean') val = false;
        else if (data_type.includes('char') || data_type === 'text') val = '';
      }
      if (tableName === 'usuarios' && localCol === 'role') {
        if (val == null || val === '' || !ROLES_VALIDOS.includes(String(val).toLowerCase())) val = 'usuario';
        else val = String(val).toLowerCase();
      }
      if (tableName === 'itens' && localCol === 'descricao' && (val == null || val === '')) val = '';
      if (val != null && INTEGER_TYPES.includes(data_type) && (typeof val === 'string' || (typeof val === 'number' && !Number.isInteger(val)))) {
        const n = Number(val);
        val = Number.isNaN(n) ? null : Math.floor(n);
      }
      return val;
    });
    await localClient.query(insertSql, values);
  }

  try {
    const seq = await getSerialSequence(localPool, tableName);
    if (seq) {
      const maxResult = await localClient.query(`SELECT COALESCE(MAX(id), 1) as m FROM ${escapeIdentifier(tableName)}`);
      const maxId = maxResult.rows[0].m;
      await localClient.query(`SELECT setval($1, $2)`, [seq, maxId]);
    }
  } catch (_) {
    // Ignora se a tabela não tiver sequence ou a função não existir
  }

  console.log(`  ${tableName}: ${rows.length} linhas`);
  return rows.length;
}

async function run() {
  let railwayClient, localClient;
  try {
    railwayClient = await railwayPool.connect();
    localClient = await localPool.connect();

    const railwayTables = await railwayClient.query(
      `SELECT table_name FROM information_schema.tables 
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' 
       ORDER BY table_name`
    );
    const allTables = [...COPY_ORDER];
    for (const { table_name } of railwayTables.rows) {
      if (!COPY_ORDER.includes(table_name)) allTables.push(table_name);
    }

    // Limpar tabelas locais na ordem inversa (filhas primeiro) para não quebrar FKs
    const reverseOrder = [...allTables].reverse();
    console.log('Limpando tabelas locais...');
    for (const table of reverseOrder) {
      if (await tableExists(localPool, table)) {
        await localClient.query(`TRUNCATE TABLE ${escapeIdentifier(table)} CASCADE`);
      }
    }
    console.log('Copiando dados do Railway para o banco local...\n');
    let total = 0;
    for (const table of allTables) {
      total += await copyTable(railwayClient, localClient, table);
    }
    console.log(`\nConcluído. Total de linhas copiadas: ${total}`);
  } catch (e) {
    console.error('Erro:', e.message);
    process.exit(1);
  } finally {
    if (railwayClient) railwayClient.release();
    if (localClient) localClient.release();
    await railwayPool.end();
    await localPool.end();
  }
}

run();
