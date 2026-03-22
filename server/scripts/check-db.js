/**
 * Integridade do schema esperado pela API (Postgres).
 * Uso: npm run db:check
 *
 * Falha (exit 1) se houver problemas críticos em `usuarios` ou triggers sem coluna `updated_at`.
 * Avisos se faltar schema opcional (requisições / armazéns).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { pool, getConnectionTargetInfo } = require('../db/pool');

/** Colunas mínimas em `usuarios` (init-db + migrações usadas pela API). */
const USUARIOS_COLUMNS_REQUIRED = [
  'id',
  'username',
  'nome',
  'sobrenome',
  'telemovel',
  'email',
  'password',
  'numero_colaborador',
  'role',
  'created_at',
  'updated_at',
  'data_criacao',
];

const COLUMN_HINT_USUARIOS = {
  sobrenome: 'npm run db:migrate:usuarios-dados-pessoais',
  telemovel: 'npm run db:migrate:usuarios-dados-pessoais',
  created_at: 'npm run db:migrate:usuarios-timestamps',
  updated_at: 'npm run db:migrate:usuarios-timestamps',
};

async function tableExists(client, name) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [name]
  );
  return r.rows.length > 0;
}

async function getColumns(client, tableName) {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return new Set(r.rows.map((row) => row.column_name));
}

/** Triggers públicos cujo nome sugere updated_at — deve haver coluna updated_at na mesma tabela. */
async function triggersUpdatedAtMismatch(client) {
  const r = await client.query(`
    SELECT c.relname AS table_name, t.tgname
    FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND NOT t.tgisinternal
      AND t.tgname LIKE '%updated_at%'
    ORDER BY c.relname, t.tgname
  `);
  const bad = [];
  for (const { table_name: tableName, tgname } of r.rows) {
    const cols = await getColumns(client, tableName);
    if (!cols.has('updated_at')) {
      bad.push({ tableName, tgname });
    }
  }
  return bad;
}

async function main() {
  const target = getConnectionTargetInfo();
  console.log(`[db:check] Destino: host=${target.host} database=${target.database} port=${target.port}`);
  console.log('');

  const client = await pool.connect();
  const errors = [];
  const warnings = [];

  try {
    if (!(await tableExists(client, 'usuarios'))) {
      errors.push('Tabela `usuarios` não existe. Execute: npm run db:init (ou restaure o schema).');
    } else {
      const cols = await getColumns(client, 'usuarios');
      for (const c of USUARIOS_COLUMNS_REQUIRED) {
        if (!cols.has(c)) {
          const hint = COLUMN_HINT_USUARIOS[c] ? ` → ${COLUMN_HINT_USUARIOS[c]}` : '';
          errors.push(`Coluna em falta em usuarios: ${c}${hint}`);
        }
      }
    }

    const triggerMismatch = await triggersUpdatedAtMismatch(client);
    const catalogTables = new Set(['itens', 'itens_nao_cadastrados', 'itens_compostos']);
    for (const { tableName, tgname } of triggerMismatch) {
      let fix =
        tableName === 'usuarios'
          ? 'Corra: npm run db:migrate:usuarios-timestamps'
          : catalogTables.has(tableName)
            ? 'Corra: npm run db:migrate:catalog-timestamps (ou adicione `updated_at` a esta tabela).'
            : `Adicione \`updated_at\` a \`${tableName}\` ou remova o trigger \`${tgname}\`.`;
      errors.push(`Trigger \`${tgname}\` em \`${tableName}\` sem coluna \`updated_at\`. ${fix}`);
    }

    const hasReqTable = await tableExists(client, 'requisicoes');
    const hasArmazens = await tableExists(client, 'armazens');
    const hasJunc = await tableExists(client, 'usuario_requisicoes_armazens');
    const uCols = await getColumns(client, 'usuarios');
    const hasOrigemCol = uCols.has('requisicoes_armazem_origem_id');

    if (hasReqTable && hasArmazens && !hasJunc && !hasOrigemCol) {
      warnings.push(
        'Requisições/armazéns: falta `usuario_requisicoes_armazens` e coluna `requisicoes_armazem_origem_id` em usuarios. ' +
          'Corra: npm run db:migrate:usuarios-req-armazem ou npm run db:migrate:usuarios-req-armazem-multi'
      );
    }
  } finally {
    client.release();
    await pool.end();
  }

  if (warnings.length) {
    console.log('Avisos:');
    warnings.forEach((w) => console.log(`  - ${w}`));
    console.log('');
  }

  if (errors.length) {
    console.error('Erros (schema incompleto ou incoerente):');
    errors.forEach((e) => console.error(`  - ${e}`));
    console.error('');
    console.error('Confirme DATABASE_URL no server/.env (mesma base que npm run dev).');
    process.exit(1);
  }

  if (!warnings.length) {
    console.log('Schema verificado: sem erros nem avisos relevantes.');
  } else {
    console.log('Schema verificado: sem erros críticos (revê os avisos acima).');
  }
}

main().catch((e) => {
  console.error('Falha:', e.code || '', e.message);
  process.exit(1);
});
